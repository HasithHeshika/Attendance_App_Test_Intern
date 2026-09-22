import { Timestamp } from 'firebase/firestore';

// Meal types live in their own dependency-free module so the slot rules stay unit-testable.
// Re-exported here because Chamary and LunchRequest both carry one.
export type { MealType, MealSlots } from './meals';
import type { MealType, MealSlots } from './meals';

// Hybrid attendance-review enums live in the dependency-free shiftAutoClose module (compiled
// into the plain-node test build). Re-exported here so consumers import them from one place.
export type {
  AttendanceReviewReason, AttendanceReviewStatus, AttendanceReviewSource, PunchSource,
} from './shiftAutoClose';
import type { AttendanceReviewReason, AttendanceReviewStatus, AttendanceReviewSource } from './shiftAutoClose';

// ─── Roles ────────────────────────────────────────────────────────────────────
// Roles are now data-driven (stored in the `roles` Firestore collection) and gate
// behaviour through capability flags rather than hard-coded names. `UserRole` is the
// role's display name stored on each user. See `@/lib/permissions` for the model.
export type UserRole = string;

// Re-export the capability model so existing imports from '@/lib/types' keep working.
export type { Role, RoleCapabilities, RoleCategory } from './permissions';
export {
  CAPABILITY_KEYS, CAPABILITY_LABELS, DEFAULT_ROLES,
  resolveCapabilities, resolveCapabilitiesByName, roleCan,
} from './permissions';
import type { RoleCategory } from './permissions';

// ─── Attendance marking method ─────────────────────────────────────────────────
// A single method an employee can mark attendance by. Kept as its own reusable type
// (rather than inlined on AppUser) so it can also be used later on an individual
// attendance record — e.g. `attendance.check_in_method` — to show which device an
// employee actually used for a given check-in/check-out, not just which ones they're
// allowed to use.
//
// 'face' only ever appears on a session's check_in_method/check_out_method (which sensor a
// terminal scan actually used, see fingerprintApi.ts's biometricType handling) — it is not a
// selectable AppUser.attendance_methods value; that array stays a channel gate (mobile app vs.
// the terminal), independent of which biometric sensor the terminal happens to use per scan.
export type AttendanceMethod = 'mobile' | 'fingerprint' | 'face';

// ─── User ─────────────────────────────────────────────────────────────────────
export interface AppUser {
  uid:               string;         // Firebase Auth UID
  epf_number:        string;         // unique employee identifier
  employee_number?:  string;         // separate company employee no. (distinct from EPF)
  email:             string;
  first_name:        string;
  last_name:         string;
  display_name:      string;         // first_name + last_name combined
  name_tokens:       string[];       // lowercase tokens for search
  role:              UserRole;
  designation:       string;
  department:        string;
  company_id:        string;
  company_name:      string;
  employee_type:     'Permanent' | 'Contract' | 'Trainee' | 'Intern';
  supervisor_epf:    string | null;  // EPF of assigned supervisor
  phone_personal:    string;
  phone_office:      string;
  phone_emergency:   string;
  address:           string;
  nic:               string;
  date_of_birth:     string | null;  // YYYY-MM-DD
  date_of_join:      string | null;
  date_of_resign:    string | null;
  insurance:         boolean;
  blood_type:        string;
  b_card_status:     boolean;
  avatar_url:        string | null;
  fcm_token:         string | null;
  is_active:         boolean;
  is_shift_worker?:  boolean;           // overnight shift: allows check-out on a later calendar day
  // ── Head of Department (HOD) — Southern Lanka (carecode.org) tenant only ──────────────
  // HOD is a standalone Role (see RoleCapabilities.is_department_head in @/lib/permissions),
  // not a per-department flag any more. A user whose role carries that capability picks one
  // or more departments here (Users page multi-select) that they manage leave approvals and
  // shift rosters for — independent of their own single `department` field above, which just
  // says where THEY sit. See southernlankaApprovers/getLeaveRequests in apiCompat.ts and the
  // Schedule/Shifts pages for how this is consumed.
  hod_department_ids?:   string[];
  // Denormalized at write time (same convention as company_name/department_name elsewhere),
  // same order/length as hod_department_ids. Matched against AppUser.department (a name
  // string) — see apiCompat.ts — so read THIS, not hod_department_ids, for that comparison.
  hod_department_names?: string[];
  /** @deprecated superseded by hod_department_ids/hod_department_names — a HOD could only
   * ever cover their own single department. Kept only so pre-migration docs still type-check
   * when read (see scripts/migrate-hod-departments.mjs); the app never writes this any more —
   * the Users page dropped the checkbox that used to set it. */
  is_head_of_department?: boolean;
  // ── Per-user Super Admin override — Southern Lanka (carecode.org) tenant only ─────────
  // Set from a toggle on the Users Add/Edit form (management-only), independent of the
  // person's assigned Role. When true, permission evaluation (resolveUserCapabilities in
  // @/lib/permissions) treats this user as a full System Admin everywhere — approvals,
  // page access, the works — without having to change their job-title Role. Absent/false on
  // every other tenant and on every account until explicitly granted.
  is_super_admin?: boolean;
  // ─── Cross-database superadmin mirror (see src/lib/superAdminSync.ts) ───
  // Active superadmins are mirrored into EVERY tenant database so they can sign in and
  // administer any tenant. `is_mirror` marks a doc the sync itself created in a database that
  // is NOT the person's home one. It is the delete guard: the sync only ever removes docs
  // carrying this flag, so a real employee who happens to share an EPF can never be clobbered
  // or deleted by it. The home-database doc never carries these fields.
  is_mirror?:        boolean;
  mirror_home_db?:   string;   // dbId the person actually belongs to ('' = default database)
  mirror_synced_at?: Timestamp;
  // Executive home location — PRIVATE to the owner (never shown to admins/supervisors).
  // Used only in the user's own browser to flag outstation-from-home at check-out.
  home_lat?:         number | null;
  home_lng?:         number | null;
  home_label?:       string | null;    // optional human label the user gives their home
  special_leaves?:   SpecialLeave[];   // recurring/period special leaves assigned by HR/Admin
  // Denormalized flag: true once a suspense account exists for this user (set on account
  // creation). Lets the Users list flag account holders without an extra read per row.
  has_suspense_account?: boolean;
  // ── Self-registration (see /register, src/app/api/register/route.ts) ──────────
  // Only ever populated by the public carecode.org sign-up form (that route is gated to
  // the "southernlanka" tenant) — admin-created accounts and every altavision.lk account
  // leave these unset. epf_number/first_name/last_name stay the fields used everywhere
  // else in the app; full_name/name_with_initials are the employee's own formal-name
  // inputs, kept as-is alongside the derived first/last split.
  full_name?:         string;            // e.g. "Mr. Ishan Shyamantha Kasthuri Arachchi"
  name_with_initials?: string;           // e.g. "I.S.K. Arachchi"
  gender?:            string;
  guardian_contact?:  string;
  // True while epf_number is a placeholder ("PENDING-<uid>") assigned at self-registration
  // instead of a real Employee No — admin sets the real EPF at approval, which re-keys the
  // Firestore doc (see userService.reassignEpf). Cleared to false/omitted once assigned.
  awaiting_epf?:       boolean;
  // ── Fingerprint attendance (HF-X05 terminals) — see [[fingerprint-attendance-api]] ──
  // Written only by src/app/api/fingerprint/enrollments (Admin SDK); never set client-side.
  fingerprint_enrolled?:       boolean;
  fingerprint_enrollment_id?:  string | null;
  fingerprint_updated_at?:     Timestamp | null;
  // Face-template backup state. Kept separate from fingerprint so either modality can be
  // enrolled, restored, or eventually deleted without changing the other one's state.
  face_enrolled?:              boolean;
  face_enrollment_id?:         string | null;
  face_updated_at?:            Timestamp | null;
  // Admin-set policy for how this employee is allowed to mark attendance — the set of
  // methods permitted, e.g. ['fingerprint'] or ['mobile', 'fingerprint']. An array (rather
  // than a 'fingerprint' | 'both' enum) so "both" is just its own two entries instead of a
  // separate value to special-case, and so this stays reusable as-is once attendance
  // records start tracking which single AttendanceMethod was actually used for a given
  // check-in/check-out. Being permitted 'mobile' is meant for special-case users only —
  // most employees should stay on ['fingerprint']. Southernlanka-only (see isSouthernlanka
  // in users/page.tsx) and required there going forward; unset means an older record that
  // predates the field, shown as "Not set" rather than silently assumed to be either value.
  attendance_methods?: AttendanceMethod[];
  created_at:        Timestamp;
  updated_at:        Timestamp;
}

// ─── Special Leave (stored as a rule inside the user doc) ──────────────────────
export interface SpecialLeave {
  id:                string;          // unique id
  leave_type:        string;          // leave type name
  from_date:         string;          // YYYY-MM-DD
  to_date:           string;          // YYYY-MM-DD
  recurring_weekday: number | null;   // 0=Sun … 6=Sat; null = whole continuous range
  reason:            string;
  is_paid:           boolean;
  must_cover:        boolean;          // employee must cover the day with extra hours (recorded only)
  assigned_by:       string;          // epf of HR/Admin
  created_at:        string;          // ISO string
}

// ─── Company ──────────────────────────────────────────────────────────────────
export interface Company {
  id:             string;
  name:           string;
  address?:       string;
  // Public image URL (PNG/SVG) for the company logo — pasted in the admin, not
  // uploaded. Transparent logos render directly on the gradient cover.
  logo_url?:      string;
  // Brand accent colour (any CSS colour, e.g. "#3B82F6") used to tint the company's logo tile.
  accent_color?:  string;
  supervisor_epfs: string[];
  created_at:     Timestamp;
}

// ─── Department ─────────────────────────────────────────────────────────────
// Southern Lanka (carecode.org) tenant only — see the isSouthernlanka gate on
// src/app/(pages)/departments/page.tsx. Each department belongs to exactly one company.
export interface Department {
  id:           string;
  name:         string;
  company_id:   string;
  // Denormalized at write time (same convention as AppUser.company_name) so the
  // departments table can render without joining against the companies collection.
  company_name: string;
  is_active:    boolean;
  // Self-reference for sub-departments — another Department's id, or null/undefined for a
  // top-level department. A sub-department always shares its parent's company_id (enforced
  // in the page, not here — see the parent picker on src/app/(pages)/departments/page.tsx).
  // The tree isn't depth-limited: a sub-department may itself have sub-departments.
  parent_id?:   string | null;
  // Denormalized at write time, same convention as company_name.
  parent_name?: string | null;
  // Soft-delete flag — "Delete" in the UI never removes the Firestore doc (see
  // deleteDepartment in departmentService.ts); it sets this instead, and getDepartments()
  // filters these out. Kept recoverable straight from the database if deleted by mistake.
  is_deleted?:  boolean;
  deleted_at?:  Timestamp | null;
  created_at:   Timestamp;
}

// ─── Shift (multi-department shift definition) ─────────────────────────────────
// Southern Lanka (carecode.org) tenant only — see the tenant branch on
// src/app/(pages)/shifts/page.tsx (renders SouthernlankaShifts instead of the
// roster-assignment page every other tenant gets on the same /shifts route). A reusable
// shift definition — name + time window, offered under any number of departments at once
// (e.g. one "Morning Shift" usable by both Nursing and Reception) — nothing else. No roster,
// no weekday grid, no chaining, no employee assignment: assigning a shift to an employee on a
// date is Schedule's job (see ScheduleAssignment below), not this. A full admin can attach any
// active department; a Head of Department is restricted to their own hod_department_ids (see
// shifts/SouthernlankaShifts.tsx) — same multi-department convention as Role used to use before
// it was decoupled, and as AppUser.hod_department_ids uses today.
export interface Shift {
  id:                string;
  name:              string;         // unique shift name, e.g. "Morning Shift"
  department_ids:    string[];
  // Denormalized at write time (same convention as Department.company_name) so the table can
  // render without joining against the departments collection. Same order/length as
  // department_ids.
  department_names:  string[];
  /** @deprecated superseded by department_ids — a shift could only belong to one department.
   * Kept only so pre-migration docs still type-check when read; new writes explicitly null
   * this out (see SouthernlankaShifts.tsx's handleSave) so a doc never carries both shapes. */
  department_id?:    string | null;
  /** @deprecated superseded by department_names. */
  department_name?:  string | null;
  start_time:        string;         // "HH:MM", 24h
  end_time:          string;         // "HH:MM", 24h
  is_active:         boolean;
  // ── Restricted eligibility (optional) ───────────────────────────────────────
  // WHO may be scheduled onto this shift, applied ON TOP OF the department
  // scoping above — not a replacement for it.
  //   both absent / empty  → OPEN: anyone in one of `department_ids` can be
  //                          given this shift. The default, and the shape every
  //                          shift created before this feature already has.
  //   either populated      → RESTRICTED: a user qualifies only if their EPF is
  //                          in `eligible_user_epfs`, OR `eligible_roles`
  //                          contains 'is_department_head' and they are an
  //                          effective Head of Department (AppUser
  //                          .hod_department_ids non-empty, or the legacy
  //                          is_head_of_department flag), OR their role name is
  //                          listed verbatim in `eligible_roles`.
  // canUserAccessShift() in src/lib/shiftAccess.ts is the ONLY place that
  // interprets these two fields — never hand-roll the check at a call site.
  eligible_roles?:      string[];    // capability/role tokens, e.g. ['is_department_head']
  eligible_user_epfs?:  string[];    // explicit extra EPF numbers (e.g. the 3 execs)
  // Soft-delete flag — same convention as Department: "Delete" in the UI never removes the
  // Firestore doc (see deleteShiftDefinition in shiftDefinitionService.ts, which also refuses
  // to delete a shift still referenced by a live schedule assignment); it sets this instead,
  // and getShiftDefinitions() filters these out.
  is_deleted?:       boolean;
  deleted_at?:       Timestamp | null;
  created_at:        Timestamp;
}

// The department(s) a shift belongs to — reads the current array field, falling back to the
// deprecated singular field for docs written before a shift could span multiple departments.
export function shiftDepartmentIds(shift: Pick<Shift, 'department_ids' | 'department_id'>): string[] {
  if (shift.department_ids?.length) return shift.department_ids;
  return shift.department_id ? [shift.department_id] : [];
}

// Same fallback, for the denormalized display names.
export function shiftDepartmentNames(shift: Pick<Shift, 'department_names' | 'department_name'>): string[] {
  if (shift.department_names?.length) return shift.department_names;
  return shift.department_name ? [shift.department_name] : [];
}

// ─── Schedule Assignment (one shift assigned to one employee on one date) ──────
// Southern Lanka (carecode.org) tenant only — the Google-Calendar-style grid on
// src/app/(pages)/schedule/page.tsx: pick a department, see its employees as rows and dates
// as columns, click a cell to assign one of that department's shifts to that employee on that
// date. One doc per (employee, date, shift) — an employee can hold more than one shift on the
// same date (e.g. covering two shifts back to back), so this is a flat list, not a singleton
// per employee/date; see scheduleAssignmentService.ts.
export interface ScheduleAssignment {
  id:               string;
  department_id:    string;
  department_name:  string;
  epf_number:       string;
  employee_name:    string;
  date:             string;   // 'yyyy-MM-dd'
  shift_id:         string;
  shift_name:       string;   // denormalized, same convention as elsewhere
  start_time:       string;
  end_time:         string;
  // The org-accepted Poya/Public/Mercantile classification of `date` at the moment this was
  // assigned (see holidayService.HolidayType — mirrored here, not imported, to keep this file
  // free of service-layer imports) — null on an ordinary working day. Captured once, at
  // assignment time, rather than re-derived live: whether a date WAS a holiday when someone
  // was scheduled on it shouldn't retroactively change if the accepted-holiday list is edited
  // later.
  holiday_type?:    'poya' | 'public' | 'mercantile' | null;
  assigned_by:      string;
  assigned_by_name: string;
  // Soft-delete flag — same convention as everywhere else: "Clear" in the UI never removes
  // the Firestore doc; it sets this instead, and getScheduleAssignments* filters these out.
  is_deleted?:      boolean;
  deleted_at?:      Timestamp | null;
  created_at:       Timestamp;
  updated_at?:      Timestamp;
  // Set when this row was written by the recurring-pattern engine rather than a manual
  // grid click / bulk import (see SchedulePattern below and schedulePatternService
  // .materializePattern). The engine only ever creates, updates or removes rows carrying
  // its own pattern_id — a hand-placed assignment on the same date is never touched.
  pattern_id?:      string | null;
}

// ─── Schedule Pattern — weekly recurring shift (Southern Lanka tenant only) ───
// One employee's "work shift X every <weekdays>, week after week". It is NOT a field on
// Shift: a Shift is shared across many people/departments, whereas the day pattern is how
// ONE person is rostered. The engine MATERIALISES a pattern into ordinary
// schedule_assignments docs on a rolling horizon (today + HORIZON_WEEKS) — every existing
// reader (grid, My Schedule, Excel report, payroll) keeps working unchanged because it
// still just reads schedule_assignments. See src/lib/schedulePattern.ts for the date math
// and schedulePatternService.ts for materialisation.
//
// `is_day_off` flips the target: instead of writing schedule_assignments the engine writes
// day_offs rows on the selected weekdays (same rolling horizon, same diff/tombstone logic).
// This is an explicit, opt-in "recurring declared day off" for HODs / designated execs — a
// direct extension of the manual "Mark as Day Off", NOT the "unticked weekday = rest day"
// model, which stays out of scope (that's the unbuilt work_patterns concern). For a day-off
// pattern shift_id/start_time/end_time are '' and shift_name is 'Day Off'.
export interface SchedulePattern {
  id:               string;
  epf_number:       string;
  employee_name:    string;      // denormalized at write time, same convention as elsewhere
  department_id:    string;
  department_name:  string;
  is_day_off?:      boolean;     // true → engine writes day_offs, not schedule_assignments
  shift_id:         string;      // '' when is_day_off
  shift_name:       string;      // snapshot of the shift at creation; 'Day Off' when is_day_off
  start_time:       string;      // snapshot — the pattern keeps working if the Shift's
  end_time:         string;      // window is later edited; re-materialise to pick up changes
  weekdays:         number[];    // 0=Sun … 6=Sat (getDay()), e.g. [1,2,3,4,5] for Mon–Fri
  effective_from:   string;      // 'yyyy-MM-dd', inclusive — first day the pattern applies
  effective_to:     string | null; // 'yyyy-MM-dd' inclusive, or null = open-ended
  is_active:        boolean;     // false → engine stops extending and clears future rows
  // How far ahead schedule_assignments have been written. The weekly extend job picks up
  // every active pattern whose materialised_through is behind the fresh horizon.
  materialized_through: string | null; // 'yyyy-MM-dd'
  created_by:       string;      // epf_number
  created_at:       Timestamp;
  updated_at?:      Timestamp;
  is_deleted?:      boolean;     // soft delete — same convention; engine clears its rows first
  deleted_at?:      Timestamp | null;
}

// ─── Day Off (Southern Lanka tenant only) ────────────────────────────────────
// A single declared non-working day for one employee — the roster equivalent of a personal
// holiday. Declared one-by-one or bulk-imported from Excel (see @/lib/dayOffImport), and
// rendered as a distinct overlay on the Schedule grid alongside Poya/Public/Mercantile
// holidays and approved leave. One doc per (employee, date); the service de-dupes on import.
export interface DayOff {
  id:             string;
  epf_number:     string;      // employee EPF
  employee_name:  string;      // denormalized at write time (same convention as elsewhere)
  date:           string;      // 'yyyy-MM-dd'
  reason:         string;      // optional free text ('' when none given)
  source:         'excel' | 'manual' | 'pattern';   // 'pattern' → written by a recurring SchedulePattern (is_day_off)
  created_by:     string;      // epf_number of whoever declared it
  created_at:     Timestamp;
  // Soft-delete — always been honoured by dayOffService reads; declared here now that the
  // recurring engine also tombstones its own rows (same convention as schedule_assignments).
  is_deleted?:    boolean;
  deleted_at?:    Timestamp | null;
  // Set on rows written by the recurring day-off engine; it only ever creates / tombstones
  // rows carrying its own pattern_id — a hand-declared day off on the same date is untouched.
  pattern_id?:    string | null;
}

// ─── Outstation Location (canonical list — replaces free text) ────────────────
export interface OutstationLocation {
  id:         string;
  name:       string;         // "Colombo Office", "Matara Branch", "Kandy Site"
  address:    string;
  is_active:  boolean;
  created_at: Timestamp;
}

export const WORKING_PLACES = [
  'Colombo',
  'Matara',
  'Work From Home',
  'Site',
  'Site-Visit',
  'After-Sales',
] as const;
// Working place is now data-driven (managed in the `working_places` collection); the
// stored value is the place's display name. WORKING_PLACES above is kept only as a
// legacy default. See `WorkingPlaceLocation` and `workingPlaceService`.
export type WorkingPlace = string;

// ─── Working Place (canonical, admin-managed; optional GPS) ───────────────────
// Tags are independent classifiers (a place may carry more than one):
//   'primary' → an employee's base/default place; used as the 60km outstation
//               reference at check-out when no schedule is set for that day.
//   'shift'   → checking in here lets a technician (with no shift assignment) work a
//               shift that day: Shift label + overnight check-out allowed.
//   'site'    → site-type location classifier.
export type WorkingPlaceTag = 'primary' | 'shift' | 'site';
export const WORKING_PLACE_TAGS: WorkingPlaceTag[] = ['primary', 'shift', 'site'];

// A chamary — a canteen/food supplier attached to a working place, run by a responsible
// employee. Drives the "need lunch" prompt at check-in and the food deduction: bills submitted
// against the chamary's own suspense SUBCATEGORY are recovered from the employees who took
// meals from it. `category_id`+`subcategory_id` — set HERE, on the chamary itself, in Working
// Places — point at a REAL SuspenseSubcategory (either an existing one, or a new one created
// on the fly named after the chamary); the subcategory is a completely ordinary one (appears in
// Settings, can have Split/Types like any other) — the ONLY chamary-specific behaviour is that
// a suspense submission resolving to that subcategory also gets `chamary_id` stamped on it (the
// FK the food-deduction calc sums against). A chamary with no subcategory linked isn't tied to
// any suspense expenses yet. Alta Vision-only.
export interface Chamary {
  id:               string;
  name:             string;   // e.g. "Site A Canteen"
  responsible_epf:  string;   // employee who runs the chamary
  responsible_name: string;
  is_active:        boolean;
  // Which meals this chamary actually serves — set per chamary in Working Places, because it's
  // location-dependent (one site cooks all three, another only lunch). Absent or empty means
  // LUNCH ONLY: every chamary that existed before meal types were added served exactly lunch, so
  // the absent case has to keep meaning that. Read it through chamaryMeals() in src/lib/meals.ts
  // rather than touching the raw field.
  meals?:           MealType[];
  // Until when each meal can be ordered here, as two minute-of-day boundaries (see MealSlots in
  // src/lib/meals.ts): breakfast runs to `lunch_from`, lunch from there to `dinner_from`, dinner
  // to end of day. Set per chamary in Working Places because kitchens genuinely differ — one
  // stops taking lunch names at 10am, another cooks dinner from 6pm. Absent means
  // DEFAULT_MEAL_SLOTS (lunch until noon); read it through mealSlots()/mealOpenAt() rather than
  // touching the raw field.
  slots?:           MealSlots;
  // Which employee categories may book this chamary (Technician / Executive / Top Management),
  // set per chamary in Working Places. Absent or empty means EVERYONE: every chamary that
  // existed before categories were added served whoever was already eligible to request a
  // meal, so the absent case has to keep meaning that. Read it through categoryAllowed() in
  // src/lib/permissions.ts rather than touching the raw field.
  categories?:      RoleCategory[];
  category_id?:     string;
  category_name?:   string;
  subcategory_id?:  string;
  subcategory_name?: string;
}

// One employee's lunch flag for one calendar day, at one chamary. Doc id is `${epf}__${date}` —
// ONE active chamary per person per day (a later request/assignment that day just overwrites the
// earlier one). Created either by the employee themselves ("Request need lunch") or by the
// chamary's responsible person managing that day's list; `requested_by` records which. Feeds the
// monthly food deduction: a chamary's approved Food-category spend for the month, divided by its
// total lunches that month, times each employee's own count.
export interface LunchRequest {
  id:                  string;
  epf_number:          string;
  employee_name:       string;
  company_id:          string;
  company_name:        string;
  date:                string;   // YYYY-MM-DD, local day
  chamary_id:          string;
  chamary_name:        string;
  working_place_id:    string;
  working_place_name:  string;
  requested_by:        string;   // epf of whoever created/last edited this record
  requested_by_name:   string;
  created_at:           Timestamp;
  updated_at:           Timestamp;
  // Which meal this booking is for. ABSENT MEANS LUNCH — every record written before meal types
  // existed is a lunch booking, and the legacy doc id (`epf__date`, no meal suffix) is still the
  // id lunch uses today. Read via mealOf() in src/lib/meals.ts.
  meal?:               MealType;
  // Whether the person collected the meal. No-shows are STILL CHARGED (the food was cooked for
  // them) — `served` exists to surface repeat no-shows in the food report, not to change the
  // deduction. See computeChamaryFoodReport in src/lib/foodReport.ts.
  //
  // A booking is SERVED BY DEFAULT once its meal is over: the kitchen cooks from the list, so
  // "everyone on the list ate" is the truth in the overwhelming majority of cases and asking an
  // operator to tick 60 names to say so produced a database where nobody was ever served. The
  // page fills this in (see src/lib/mealAutoServe.ts) and the operator only marks the
  // exceptions — see `no_show`.
  served?:             boolean;
  // Penalty or credit on this ONE meal: 0.5 | 1 | 1.5 | 2. Absent means 1, which is nearly
  // every row, so absence is the default rather than a written 1.
  //
  // It changes what this person is CHARGED — the chamary's bills are divided by the sum of
  // multipliers, so a 2× meal costs that person double and everyone else's share falls (see
  // splitFoodCost in src/lib/foodCost.ts). That is why it is not client-writable: firestore
  // rules refuse it on create and refuse to let an update change it, and the only path is
  // POST /api/food/meal-multiplier, which checks the caller runs this chamary or is an admin.
  multiplier?:         number;
  multiplier_by?:      string;    // EPF of whoever set it
  multiplier_by_name?: string;
  multiplier_at?:      Timestamp;
  /** Why. Optional, and shown to the person being charged — they are owed the reason. */
  multiplier_note?:    string;
  // Null when unticked: `setMealServed(false)` clears it rather than leaving a stale collection
  // time on a booking that is now a no-show.
  served_at?:          Timestamp | null;
  // A PERSON said this meal was not collected. `served: false` alone cannot mean that — it is
  // also the state of every booking nobody has looked at yet — and auto-serve has to be able to
  // tell the two apart or it would silently overwrite the operator's own no-show marks on the
  // next page load. Set by unticking; cleared by ticking or by re-booking.
  no_show?:            boolean;
  // Who last decided `served`: 'manual' = a person ticked or unticked it, 'auto' = the day was
  // over and nobody said otherwise. Never the authority for anything (`no_show` is), but it is
  // what tells you whether a served flag was a statement or a default.
  // 'manual'   — the chamary operator ticked or unticked this on /chamary
  // 'auto'      — recorded by the auto-serve pass because the meal window closed
  // 'employee'  — the person themselves said they did not take it, from /food
  // Authorship matters: an operator looking at their own list must be able to tell a statement
  // the employee made after the fact from a mark the operator made at the counter.
  served_source?:      'manual' | 'auto' | 'employee';
}

// A day a chamary is NOT cooking a given meal. Written by the chamary's responsible person
// ahead of time; blocks new requests for that (chamary, date, meal) and auto-cancels the ones
// already made, notifying each affected requester plus the system admins.
//
// Doc id is `${chamary_id}__${date}__${meal}` so marking the same day twice is idempotent.
export interface ChamaryMealOffday {
  id:           string;
  chamary_id:   string;
  chamary_name: string;
  date:         string;    // YYYY-MM-DD, local day
  meal:         MealType;
  reason:       string;    // optional free text shown to the people whose request was cancelled
  set_by:       string;    // epf of the responsible person who marked it
  set_by_name:  string;
  created_at:   Timestamp;
}

// What a change request asks for: drop the booking, or move it to another chamary/meal.
export type MealChangeKind = 'remove' | 'move';

// A request to change a booking whose day has already passed. The employee-facing path can only
// cancel TODAY's untouched booking, because a past booking is one share of its chamary's monthly
// bill — deleting it quietly pushes its cost onto everyone else who ate. This is the way round
// that wall: the employee says what is wrong and why, and the chamary's responsible person (or a
// food admin) decides. Approving APPLIES the change, so the list the kitchen cooked from and the
// deduction it feeds can always be reconciled against a decision someone put their name to.
//
// Doc id is `${epf}__${date}__${meal}` — one live request per person per day per meal; re-raising
// overwrites rather than piling up duplicates an approver would have to reconcile. See
// src/services/mealChangeService.ts.
export interface MealChangeRequest {
  id:              string;
  epf_number:      string;
  employee_name:   string;
  date:            string;    // YYYY-MM-DD, the day of the booking being changed
  meal:            MealType;
  chamary_id:      string;    // where the booking is now
  chamary_name:    string;
  kind:            MealChangeKind;
  // Destination — set for a 'move', null for a 'remove'. `to_meal` null means the same meal.
  to_chamary_id:   string | null;
  to_chamary_name: string | null;
  to_meal:         MealType | null;
  reason:          string;    // why the change is needed; required, shown to the approver
  status:          'pending' | 'approved' | 'rejected';
  requested_by:      string;  // epf of whoever raised it
  requested_by_name: string;
  requested_at:      Timestamp;
  decided_by:      string | null;
  decided_by_name: string | null;
  decided_at:      Timestamp | null;
  decision_note:   string | null;
}

export interface WorkingPlaceLocation {
  id:            string;
  name:          string;          // "Colombo - Office", "Work From Home", "Site"
  address:       string;
  latitude:      number | null;   // GPS of the place (optional)
  longitude:     number | null;
  radius_m:      number | null;   // geofence radius in metres (null → default)
  requires_site: boolean;         // selecting it requires a site number
  tags?:         WorkingPlaceTag[]; // primary / shift / site (independent classifiers)
  // EPF numbers of the location's assigned supervisors. Anyone whose check-in GPS matched
  // this place can be approved by these users (additive to normal routing); being listed
  // here grants that approval right even to a non-approver-role user.
  supervisor_epfs?: string[];
  chamaries?:    Chamary[];       // canteens at this place (see Chamary)
  sort_order:    number;
  is_active:     boolean;
  created_at:    Timestamp;
}

// ─── Attendance ───────────────────────────────────────────────────────────────
export type AttendanceStatus = 'pending' | 'approved' | 'rejected';

// One place a session's work happened at. A session accumulates these: the check-in
// GPS match, the place picked at check-out, and any places added later via the
// "Update location" flow or the past/edit forms. `working_place` on the session stays
// a single-value mirror of the latest/primary entry for legacy readers.
export interface SessionLocation {
  name:         string;          // saved place, Solar site ("Name (#site)"), or custom text
  site_number?: string | null;
  lat?:         number | null;   // device GPS when this entry was recorded (if available)
  lng?:         number | null;
  accuracy_m?:  number | null;
  source:       'check_in' | 'check_out' | 'manual';
  added_at?:    Timestamp | null;
  added_by?:    string | null;   // EPF of whoever recorded it (approver for edit applies)
}

// One work session (a single check-in → check-out). A day can hold multiple sessions
// for session-mode roles, and a session may span midnight for shift workers (its
// check_out can be on a later calendar day; the record stays under its start day).
export interface AttendanceSession {
  id:                      string;         // unique within the day's record
  check_in:                Timestamp | null;
  check_out:               Timestamp | null;
  working_place:           WorkingPlace | null;
  site_number:             string | null;
  // Every place this session worked at (check-in match, check-out pick, manual adds).
  // Absent on older docs — readers fall back to the single working_place.
  locations?:              SessionLocation[];
  is_outstation:           boolean;
  outstation_location_id:  string | null;
  outstation_name:         string | null;
  outstation_address:      string | null;
  is_outstation_approved:  boolean;
  morning_allowance:       0 | 1 | 2;     // 0=none,1=before-6:45,2=6:45-7:00
  evening_allowance:       0 | 1;         // 0=none,1=after-6:30pm
  check_in_approved_by:    string | null;
  check_out_approved_by:   string | null;
  check_in_status:         AttendanceStatus;
  check_out_status:        AttendanceStatus;
  // Which AttendanceMethod was actually used for this check-in/check-out — independent of
  // each other, since a session can be opened by one method and closed by the other (e.g.
  // mobile check-in, fingerprint check-out at day's end). Southernlanka-only, same as
  // AppUser.attendance_methods; absent on mobile-recorded sessions and every older record —
  // treat missing as 'mobile' there, never assume 'fingerprint'. Set to 'fingerprint' only by
  // src/lib/fingerprintApi.ts (Admin SDK); the mobile check-in/out flow in apiCompat.ts does
  // not currently set 'mobile' explicitly.
  check_in_method?:        AttendanceMethod | null;
  check_out_method?:       AttendanceMethod | null;
  is_past_submission?:     boolean;
  past_approved_by?:       string | null;
  reject_reason?:          string | null;
  // Employee device GPS captured at check-in / check-out (recorded, not enforced).
  check_in_lat?:           number | null;
  check_in_lng?:           number | null;
  check_out_lat?:          number | null;
  check_out_lng?:          number | null;
  // GPS reading accuracy (68%-confidence radius, metres) at capture time. null = unknown
  // (denied/older record). Shown on the attendance mini-map as a confidence halo.
  check_in_accuracy_m?:    number | null;
  check_out_accuracy_m?:   number | null;
  // Check-in GPS matched to the nearest configured working_place (within its radius).
  // null name = no known site matched (GPS off / not near any place with coordinates).
  check_in_site_id?:       string | null;
  check_in_site_name?:     string | null;
  check_in_site_distance_m?: number | null;
  // Was the check-in GPS inside a place's OWN radius (working_places.radius_m, default 200 m)?
  // Stricter than check_in_site_* above, which is a 1 km proximity label. null = unanswerable
  // (no GPS fix, or no place has coordinates) and absent on every record written before this
  // field existed. It is the evidence behind a system-approved check-in where
  // TenantFeatures.autoApproveInRangeCheckIn is on — never treat a missing value as "inside".
  check_in_within_radius?:   boolean | null;
  // Check-out GPS vs the SELECTED working place's radius (recorded, not enforced).
  check_out_site_distance_m?: number | null;
  check_out_within_radius?:   boolean | null;
  // Outstation is auto-derived at check-out for technicians: check-out > 60km from the day's
  // assigned (or primary) working place. is_outstation_auto marks a distance-flagged value the
  // approver may override; outstation_ref_distance_m is that measured distance (metres).
  is_outstation_auto?:        boolean | null;
  outstation_ref_distance_m?: number | null;
  // "Pick": a team-leader-or-above explicitly claims this checked-in person for the day.
  // Picking auto-approves the check-in (sets check_in_approved_by = picker) so that day's
  // check-out approval routes to the picker via the existing claim logic. First-wins:
  // an unpicked session can be picked by anyone in scope; only the picker can release it.
  picked_by?:              string | null;  // EPF of the picker
  picked_by_name?:         string | null;  // denormalized for display
  picked_at?:              Timestamp | null;
  // Set by closeSessionRaw (src/lib/attendanceAutoClose.ts) when the fingerprint/face handler's
  // Rule 2 auto-closes a stale open session at the next real punch (never a guessed time) — the
  // checkout is real but unconfirmed, so it's flagged for a supervisor to sign off on rather
  // than silently trusted. Absent on every normally-closed session.
  review_status?:          AttendanceReviewStatus;
}

export interface AttendanceRecord {
  id:                      string;        // Firestore doc ID (epf_date)
  epf_number:              string;
  company_id?:             string;         // set at check-in; used to scope company reports
  company_name?:           string;
  date:                    string;         // YYYY-MM-DD (session start day)
  sessions?:               AttendanceSession[]; // source of truth going forward
  // Legacy single-session fields (kept for back-compat reads of old docs):
  check_in:                Timestamp | null;
  check_out:               Timestamp | null;
  working_place:           WorkingPlace | null;
  site_number:             string | null;
  is_outstation:           boolean;
  outstation_location_id:  string | null;  // ref to outstation_locations/{id}
  outstation_name:         string | null;  // denormalized for display
  outstation_address:      string | null;
  is_outstation_approved:  boolean;
  morning_allowance:       0 | 1 | 2;     // 0=none,1=before-6:45,2=6:45-7:00
  evening_allowance:       0 | 1;         // 0=none,1=after-6:30pm
  check_in_approved_by:    string | null;  // epf_number
  check_out_approved_by:   string | null;
  check_in_status:         AttendanceStatus;
  check_out_status:        AttendanceStatus;
  request_from:            string[];       // supervisor epf_numbers requested by technician
  is_past_submission:      boolean;
  past_approved_by:        string | null;
  reject_reason:           string | null;
  // Soft delete — a system admin can remove a record without erasing it (kept for audit).
  is_deleted?:             boolean;
  deleted_by?:             string | null;   // epf_number of the admin who deleted it
  deleted_at?:             Timestamp | null;
  delete_reason?:          string | null;
  created_at:              Timestamp;
  updated_at:              Timestamp;
}

// ─── Daily Task / Workload Log ─────────────────────────────────────────────────
// Replaces the manual "daily schedule" spreadsheet. One document per task. A task
// that is still 'On Progress' at the end of a day is rolled forward to the next
// working day (a fresh continuation doc linked via rolled_from/rolled_to).
export const TASK_TYPES = ['One Time', 'Recurring'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_STATUSES = ['Pending', 'On Progress', 'Completed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface DailyTask {
  id:            string;
  epf_number:    string;            // owner
  employee_name: string;            // denormalized for supervisor/team views
  company_id:    string;
  company_name:  string;
  department:    string;
  date:          string;            // YYYY-MM-DD the task is logged against (may be future — a 'Pending' upcoming task)
  session_id:    string | null;     // links to an AttendanceSession; null = day-level task
  working_place: string | null;     // denormalized from the session for display
  description:   string;            // "Amperac web app changes"
  task_type:     TaskType;
  status:        TaskStatus;
  hours:         number;            // Timing (hr)
  remarks:       string;
  rolled_from:   string | null;     // id of the task this one continues (carry-over source)
  rolled_to:     string | null;     // id of the continuation created on a later day
  // The day the task was ultimately finished (YYYY-MM-DD). Denormalized onto EVERY doc
  // in the rolled chain so each day the task appeared can show when it was completed,
  // even across month boundaries. null while still open / re-opened.
  completed_on?: string | null;
  // LEGACY — the Assign Task flow used to fan out one DailyTask per assignee, linked
  // by assignment_group_id. It now creates a single AssignedTask (see below) instead,
  // so these are only ever populated on pre-existing docs; kept for backward-compat reads.
  assigned_by?:      string | null;  // epf of the assigner
  assigned_by_name?: string | null;
  assignment_group_id?: string | null;
  created_at:    Timestamp;
  updated_at:    Timestamp;
}

// ─── Assigned Task (shared, multi-person, commentable) ─────────────────────────
// A genuinely shared work item — one document, a list of assignees each tracked
// independently — distinct from DailyTask (a personal daily work-hours log tied to
// attendance sessions). Comments live in a subcollection: assigned_tasks/{id}/comments.
// One shared status per task (see AssignedTask.status below) — a person here is just
// "who's on this task", not a separate progress tracker.
export interface AssignedTaskPerson {
  epf_number:    string;
  employee_name: string;
}

// A raised hand on an assigned task: the people on it cannot start, or it is going to be
// late. Set from the task's actions with a required reason; cleared automatically the moment
// the task is started or completed, or by hand. A 'delayed' flag may carry a new due date
// (`until`), in which case the task's `date` moves there and `original_date` keeps the first.
export type AssignedTaskFlagKind = 'cannot_start' | 'delayed';
export interface AssignedTaskFlag {
  kind:    AssignedTaskFlagKind;
  reason:  string;
  until:   string | null;   // YYYY-MM-DD — the new due date for a delay, null when unchanged
  by_epf:  string;
  by_name: string;
  at:      Timestamp;
}

// One entry in a task's trail (assigned_tasks/{id}/events) — every status change with its
// note, every start/finish with its time, every flag and every reschedule, by whom and when.
// Append-only; the task doc carries only the latest of what lists need (status_note,
// started_at, ended_at, flag) so a list never has to read the subcollection.
export type AssignedTaskEventKind =
  | 'assigned' | 'status' | 'started' | 'ended' | 'flagged' | 'flag_cleared' | 'rescheduled' | 'note';
export interface AssignedTaskEvent {
  id:           string;
  kind:         AssignedTaskEventKind;
  from_status?: string | null;
  to_status?:   string | null;
  note:         string;             // the person's own words; '' when they gave none
  reason?:      string | null;      // flags: why
  from_date?:   string | null;      // reschedules
  to_date?:     string | null;
  by_epf:       string;
  by_name:      string;
  at:           Timestamp;
}

export interface AssignedTask {
  id:            string;
  company_id:    string;
  company_name:  string;
  description:   string;
  task_type:     TaskType;
  date:          string;              // due date, YYYY-MM-DD
  assignees:     AssignedTaskPerson[];
  // Flat shadow of assignees[].epf_number — Firestore array-contains needs a plain
  // array of primitives, it can't match a field inside an array of objects.
  assignee_epfs: string[];
  // Task-level, shared by every assignee — not TaskStatus (a closed 3-value union):
  // free-form so a custom status (beyond Pending/On Progress/Completed) can be set,
  // see task_status_config / getCustomStatuses in assignedTaskService.ts.
  status:        string;
  completed_on:  string | null;       // set when status === 'Completed'
  assigned_by:      string;
  assigned_by_name: string;
  comment_count?: number;             // denormalized, best-effort (not transactional)
  // ── Lifecycle (see AssignedTaskEvent / assignedTaskService.ts) ──
  // When work actually began and finished, with the clock — not just the day. started_at is
  // set the first time the task leaves 'Pending' and never moves after; ended_at is set on
  // 'Completed' and cleared again if the task is reopened. All optional: tasks written
  // before this existed carry none of it.
  started_at?:      Timestamp | null;
  started_by?:      string | null;
  started_by_name?: string | null;
  ended_at?:        Timestamp | null;
  ended_by?:        string | null;
  ended_by_name?:   string | null;
  // The note given with the most recent status change (or note), for lists; the trail has
  // every one of them.
  status_note?:          string | null;
  status_changed_at?:    Timestamp | null;
  status_changed_by?:    string | null;
  status_changed_by_name?: string | null;
  flag?:            AssignedTaskFlag | null;
  // The first due date, kept when a delay moves `date` — so "originally due" stays visible.
  original_date?:   string | null;
  created_at:    Timestamp;
  updated_at:    Timestamp;
}

export interface AssignedTaskComment {
  id:          string;
  author_epf:  string;
  author_name: string;
  text:        string;
  // Epfs resolved from @mentions in `text` at post time — drives both the
  // mention notification and re-render highlighting (see src/lib/mentions.ts).
  mentioned_epfs?: string[];
  created_at:  Timestamp;
}

// ─── Shift Assignment (overnight-shift roster, period-based) ───────────────────
export interface ShiftAssignment {
  id:            string;
  epf_number:    string;
  employee_name: string;
  company_id:    string;
  company_name:  string;
  from_date:     string;   // YYYY-MM-DD (inclusive)
  to_date:       string;   // YYYY-MM-DD (inclusive)
  working_place?: string | null;  // optional working place for the shift period
  site_number?:   string | null;  // site no. when the working place requires one
  assigned_by:   string;   // EPF of the manager who allocated it
  assigned_by_name?: string;
  created_at?:   Timestamp;
  updated_at?:   Timestamp;
}

// ─── Attendance Edit Request ───────────────────────────────────────────────────
export interface AttendanceEditRequest {
  id:                          string;
  attendance_id:               string;
  epf_number:                  string;
  employee_name:               string;
  reason:                      string;
  requested_check_in:          string | null;   // ISO datetime
  requested_check_out:         string | null;
  requested_working_place:     WorkingPlace | null;
  requested_site_number:       string | null;
  requested_is_outstation:     boolean | null;
  requested_outstation_location_id: string | null;
  requested_outstation_name:   string | null;
  status:                      AttendanceStatus;
  considered_by:               string | null;   // epf_number
  considered_at:               Timestamp | null;
  reject_reason:               string | null;
  created_at:                  Timestamp;
}

// ─── Attendance review (hybrid model) ─────────────────────────────────────────
// Southern Lanka only. A flagged session — overlong, reopened after a missing check-out, still
// open past MAX_PLAUSIBLE_SHIFT_HOURS, or split by a retro roster — never reaches the approved-
// attendance reports until a supervisor resolves this row. The raw session timestamps are
// NEVER mutated; this row plus attendance_segments are the interpretation layer on top.
// Written by the fingerprint engine + the open-session-monitor cron (Admin SDK); transitioned
// (flagged → in_review → resolved) from the web app. Doc id is deterministic:
// `${epfDocId}_${attendance_date}_${session_id}` — so a re-flag is idempotent.
export type AttendanceReviewResolution = 'time_correction' | 'ot_approved' | 'accepted_as_is';

export interface AttendanceReview {
  id:                 string;
  epf_number:         string;
  employee_name:      string;
  attendance_date:    string;   // 'YYYY-MM-DD' — the session's start-day doc
  session_id:         string;
  review_reason:      AttendanceReviewReason;
  review_status:      AttendanceReviewStatus;
  severity_hours:     number;   // hours over the roster (or over MAX_PLAUSIBLE_SHIFT_HOURS)
  actual_hours:       number;
  scheduled_hours:    number | null;
  source_channel:     AttendanceReviewSource;
  created_at:         Timestamp;
  in_review_by:       string | null;
  in_review_at:       Timestamp | null;
  resolved_by:        string | null;
  resolved_at:        Timestamp | null;
  resolution:         AttendanceReviewResolution | null;
  resolution_note:    string | null;
  linked_ot_request_id:   string | null;
  linked_edit_request_id: string | null;
  is_deleted?:        boolean;
}

// A derived allocation of one raw session's span into rostered vs. extra-unverified time.
// delete + rewrite on every recalc; the raw session is untouched. Admin-SDK-write only.
// Doc id: `${epfDocId}_${attendance_date}_${session_id}_${segment_index}`.
export interface AttendanceSegment {
  id:                  string;
  epf_number:          string;
  attendance_date:     string;
  session_id:          string;
  segment_index:       number;
  bucket:              'scheduled' | 'ot_unverified';
  start_ms:            number;
  end_ms:              number;
  hours:               number;
  roster_assignment_id: string | null;
  status:              'derived' | 'signed_off';
  signed_off_by:       string | null;
  signed_off_at:       Timestamp | null;
  derived_at:          Timestamp;
}

// Enqueued when HR back-dates / edits / removes a roster row, so the recalc drain (follow-up)
// can re-run computeShiftSegments for the affected employee + date range. Created from the web
// app; drained by the Admin SDK.
export interface RecalcQueueItem {
  id:           string;
  epf_number:   string;
  from:         string;   // 'YYYY-MM-DD' inclusive
  to:           string;   // 'YYYY-MM-DD' inclusive
  reason:       'roster_saved' | 'roster_deleted' | 'shift_edited';
  status:       'pending' | 'processing' | 'done' | 'error';
  enqueued_at:  Timestamp;
  processed_at?: Timestamp | null;
  error?:       string | null;
}

// ─── Leave ────────────────────────────────────────────────────────────────────
export type LeaveStatus = 'pending' | 'approved' | 'rejected';
export type HalfDayPeriod = 'morning' | 'afternoon';

export interface LeaveRecord {
  id:               string;
  epf_number:       string;
  employee_name:    string;
  company_id:       string;
  from_date:        string;   // YYYY-MM-DD
  to_date:          string;
  leave_type_id:    string;
  leave_type_name:  string;
  is_half_day:      boolean;
  half_day_period:  HalfDayPeriod | null;
  reason:           string;
  supervisor_epf:   string;   // epf_number of approving supervisor
  status:           LeaveStatus;
  considered_by:    string | null;
  considered_at:    Timestamp | null;
  reject_reason:    string | null;
  is_paid:          boolean;
  category?:        'normal' | 'special';  // special = assigned by HR/Admin
  assigned_by?:     string | null;         // epf of HR/Admin who assigned a special leave
  // Soft delete — a system admin can remove a record without erasing it (kept for audit).
  is_deleted?:      boolean;
  deleted_by?:      string | null;   // epf_number of the admin who deleted it
  deleted_at?:      Timestamp | null;
  delete_reason?:   string | null;
  created_at:       Timestamp;
  updated_at:       Timestamp;
}

// ─── Leave Type ───────────────────────────────────────────────────────────────
export interface LeaveType {
  id:            string;
  name:          string;
  // Annual quota model (days/yr):
  //   quotas[roleName]  → per-role override (takes priority)
  //   annual_quota      → default applied to every role without an override
  //   quota_tech/nontech → legacy two-bucket fallback (kept so older leave types keep
  //                        working until re-saved; resolved only when the above are absent)
  annual_quota?: number;
  quotas?:       Record<string, number>; // role name → days/yr
  quota_tech?:    number;
  quota_nontech?: number;
  is_paid:       boolean;       // default paid status
  requires_reason?:     boolean; // reason is mandatory (e.g. Medical)
  allow_backdate_days?: number;  // how many days into the past it can be applied (Medical = 14)
  allow_unpaid_choice?: boolean; // applicant/assigner can choose paid or unpaid (Medical)
  // Southern Lanka: when false the type stays visible on the leave-balance cards but is
  // filtered out of the "Apply Leave" type picker (routed/assigned only). Defaults to true.
  allow_direct_apply?: boolean;
  // Southern Lanka: marks THIS type as the target of the Intern/Trainee first-year
  // 0.5-day/month accrual (replaces the old hardcoded "Casual Leaves" name match). At most one
  // active type should carry it. It is offered ONLY to employees with < 12 months' service —
  // once tenure reaches a year it is hidden from the balance and the Apply dropdown entirely.
  // Pair it with allow_direct_apply: true so the 12h-apply / 3h-deletion shift cut-offs apply.
  is_trainee_accruable?: boolean;
  /**
   * This type is TRACKED but is not an entitlement: it contributes neither quota nor usage to
   * the leave balance, and nothing caps it. Alta Vision sets it on Medical Leaves — medical
   * days are recorded and reported, but they must not inflate the quota an employee appears to
   * hold, and an illness is not something to run out of.
   *
   * A per-type flag rather than a tenant check on purpose (same reasoning as
   * `is_trainee_accruable`): the behaviour belongs to the leave type, so a tenant that wants it
   * ticks the box and every other tenant is untouched because nobody ticked it.
   *
   * Concretely, a type carrying this flag: is absent from every getLeaveSummary quota row, so
   * no total/used/remaining anywhere includes it; is never blocked as "exhausted" on apply; and
   * surfaces instead as a days-TAKEN count (`excluded_leave_types` on the summary).
   */
  excluded_from_quota?: boolean;
  is_active:     boolean;
}

// ─── Leave Balance ────────────────────────────────────────────────────────────
export interface LeaveBalance {
  epf_number:   string;
  year:         number;
  balances:     Record<string, number>;  // leave_type_id → days remaining
  updated_at:   Timestamp;
}

// ─── Holiday ──────────────────────────────────────────────────────────────────
export interface Holiday {
  date:         string;   // YYYY-MM-DD
  name:         string;
  is_confirmed: boolean;
  is_poya:      boolean;
}

// ─── Notification ─────────────────────────────────────────────────────────────
export interface InAppNotification {
  id:     string;
  title:  string;
  body:   string;
  type?:  'approval_request' | 'leave_update' | 'attendance_edit' | 'edit_approved' | 'edit_rejected' | 'general';
  read:   boolean;
  time:   Date;
}

// ─── Suspense (staff expense float) ────────────────────────────────────────────
// Accountancy loads selected staff a suspense account (a spendable balance). Holders
// pay company expenses and submit them (debit on approval; balance may go negative), and
// may request top-up credit (credit on approval). Every movement is written to a ledger.
export type SuspenseStatus = 'pending' | 'approved' | 'rejected';

// One account per user — Firestore doc id = epf_number.
export interface SuspenseAccount {
  epf_number:      string;
  employee_name:   string;
  company_id:      string;
  company_name:    string;
  balance:         number;        // running balance; MAY be negative
  currency:        string;        // e.g. 'LKR'
  is_active:       boolean;       // false while a close request is pending, or once closed
  is_closed?:      boolean;       // account settled & closed; cleared again by reopenSuspenseAccount
  closed_at?:      Timestamp | null;
  created_by:      string;        // epf of the user-manager who opened the account
  created_by_name: string;
  created_at:      Timestamp;
  updated_at:      Timestamp;
  // ─── Carry-forward (the monthly balance upload — src/lib/suspenseBalanceImport.ts) ───
  // The previous period's closing position, brought in as a MOVEMENT: the uploaded figure is
  // ADDED to `balance` (a negative figure reduces it) and recorded here, so the account shows
  // what was brought forward and as at when rather than only an anonymous adjustment in the
  // ledger. `balance` remains the single source of truth for what the account holds — these
  // three are the record of one movement, never a second balance to be added on top of it.
  carry_forward?:         number;      // the most recent carry-forward applied
  carry_forward_at?:      Timestamp;   // the date that figure is "as at" (e.g. 1 Sep 2026)
  // Every period ('YYYY-MM') already carried into this account. Appended to, never replaced: it
  // is what stops one month's sheet being uploaded twice and doubling every amount, which a
  // scalar "last period carried" could not catch for a re-upload of an EARLIER month. Written by
  // applyCarryForward; read by buildBalanceDraftRows to flag the repeat before anything is saved.
  carry_forward_periods?: string[];
}

// A request to CLOSE/clear a suspense account. If the balance is positive at request time,
// the requester must attach a fund-transfer proof for exactly that amount (returning the
// money to the company). Approved by a suspense approver → the account is settled & closed;
// rejected → the account is unfrozen. Created by the holder OR a suspense approver.
export interface SuspenseCloseRequest {
  id:                 string;
  epf_number:         string;
  employee_name:      string;
  company_id:         string;
  company_name:       string;
  balance_at_request: number;             // account balance snapshot when requested
  transfer_amount:    number;             // fund-transfer amount (== balance when balance > 0, else 0)
  transfer_url:       string | null;      // uploaded fund-transfer proof
  transfer_type:      'image' | 'pdf' | null;
  transfer_name:      string | null;
  transfer_provider:  'firebase' | 'onedrive' | null;
  note:               string;
  status:             SuspenseStatus;
  requested_by:       string;             // epf of the requester (holder or approver)
  requested_by_name:  string;
  considered_by:      string | null;
  considered_by_name: string | null;
  considered_at:      Timestamp | null;
  reject_reason:      string | null;
  created_at:         Timestamp;
  updated_at:         Timestamp;
}

export type SuspenseLedgerKind = 'opening' | 'credit' | 'debit' | 'adjustment' | 'settlement';

// Immutable audit-trail entry for every balance movement.
export interface SuspenseLedgerEntry {
  id:            string;
  epf_number:    string;
  company_id?:   string;          // which per-company account the movement belongs to
  kind:          SuspenseLedgerKind;
  amount:        number;          // signed: + credits, − debits
  balance_after: number;         // account balance immediately after this entry
  ref_type:      'account' | 'request' | 'submission' | null;
  ref_id:        string | null;  // id of the source request/submission (if any)
  note:          string;
  actor_epf:     string;         // who caused the movement
  actor_name:    string;
  created_at:    Timestamp;
}

// An expense the holder paid and submitted for approval (debits the balance when approved).
// A portion of a bill charged to another employee and recovered from THEIR salary.
//
// The FULL bill leaves the payer's float on approval — the cash left their hand, so it leaves
// the balance, and the float always equals the cash they actually hold. A split is therefore a
// RECEIVABLE, not a discount: it is owed back to the payer, and `recovered_at` is stamped when
// payroll has actually taken it, which posts a credit returning that money to the float.
// Until then the payer is carrying it. (Before this, approval netted splits off the debit —
// the cash left but the balance did not, and one payer was LKR 12,792 out of pocket while the
// app showed him holding a positive float.)
export interface SuspenseSplit {
  epf_number:    string;
  employee_name: string;
  amount:        number;
  /** When payroll deducted this from the colleague's salary and the payer's float was credited
   *  back. Null/absent = still owed to the payer. */
  recovered_at?:       Timestamp | null;
  recovered_by?:       string | null;
  recovered_by_name?:  string | null;
  /** The ledger entry that returned this money, so a recovery can be undone exactly once. */
  recovered_entry_id?: string | null;
}

// Expense taxonomy (managed in Suspense settings). One Firestore doc per category. TYPES are
// defined ON THE CATEGORY (one pool, e.g. Fuel → Diesel/Petrol); each subcategory is then
// ASSIGNED the type(s) it belongs to by id (e.g. Van ABC-1234 → Diesel). The submit form offers
// only the subcategory's assigned types (auto-picking when there's exactly one). Each level is
// optional. `allow_split` is per subcategory — the form only offers splitting when it's on.
export interface SuspenseType {
  id:   string;
  name: string;
}
// One person named on a category as someone who may sign its credit requests off. The name is
// snapshotted alongside the EPF so a request still reads correctly after that user is renamed
// or removed — the EPF is what the membership check uses.
export interface SuspenseApprover {
  epf:  string;
  name: string;
}
export interface SuspenseSubcategory {
  id:          string;
  name:        string;
  allow_split: boolean;
  // The ONE type (from the parent category's pool) this subcategory belongs to — a subcategory
  // has at most one type, never several (e.g. a vehicle subcategory is either Diesel or Petrol,
  // never both), so it's resolved automatically at submit time rather than user-picked.
  type_id?:    string | null;
}
export interface SuspenseCategory {
  id:            string;
  name:          string;
  order?:        number;
  vat_default?:  boolean;   // bills in this category are VAT bills by default (editable per submission)
  vat_rate?:     number;    // default VAT % (e.g. 18) used to suggest the VAT amount
  // Whether approved bills in this category pool with the shared rolling voucher. undefined/true
  // = normal (default) — joins whichever voucher is currently open, like every other category.
  // false = isolated — never joins an existing voucher; EVERY approved bill in this category
  // opens its own brand-new voucher (e.g. one-off Asset purchases that need their own QuickBooks
  // reference rather than being lumped in with routine Fuel/Travel bills). See
  // addApprovedBillToVoucher / previewVoucherForApproval in suspenseService.ts.
  group_in_vouchers?: boolean;
  types?:        SuspenseType[];   // the category's type pool (assigned to subcategories)
  // Subcategories — ordinary entries managed here in Settings. A chamary (Working Places) can
  // link to one of these (or create a new one named after itself); when a submission resolves
  // to a subcategory some chamary links to, it also gets stamped with that chamary's id — see
  // resolveCategory in src/app/(pages)/suspense/page.tsx. No other special-casing.
  subcategories: SuspenseSubcategory[];
  // Approval personas for CREDIT REQUESTS filed under this category (Suspense settings). ANY ONE
  // of them clears the category stage — the same pool semantics as a company's supervisor list,
  // not an all-must-sign chain. Absent or empty means this category adds no gate at all, which is
  // what every category created before this field existed means too. Expenses ignore it entirely:
  // it gates credit requests only (see createRequest/approveCategoryStage in suspenseService.ts).
  credit_approvers?: SuspenseApprover[];
  created_at?:   Timestamp;
  updated_at?:   Timestamp;
}

export interface SuspenseSubmission {
  id:               string;
  epf_number:       string;
  employee_name:    string;
  // Who actually filled in and uploaded this bill. Normally the same person as epf_number/
  // employee_name (the "belonger" whose account this bill debits on approval) — but the submit
  // form lets the acting user pick a DIFFERENT employee as the belonger (e.g. filing a bill on a
  // colleague's behalf), in which case epf_number/employee_name stay the belonger for every
  // existing debit/query/notification path (approveSubmission, getMySubmissions, notifyOwner, …)
  // while these two fields record who actually created the submission. Always set going forward,
  // even when equal to epf_number/employee_name; optional only for docs created before this
  // field existed — display code should fall back to epf_number/employee_name when reading it.
  submitted_by_epf?:   string;
  submitted_by_name?:  string;
  company_id:       string;
  company_name:     string;
  // Three-level taxonomy (managed in Suspense settings). expense_type is kept as a derived label
  // ("Category · Subcategory · Type") so existing display/search/report code keeps working.
  category?:        string;
  subcategory?:     string;
  type?:            string;
  // Set when subcategory was picked from a chamary (Chamary.category_id points at this
  // submission's category) — the FK the monthly food-deduction calc sums approved bills
  // against. Immune to chamary renames.
  chamary_id?:      string;
  expense_type:     string;
  // VAT: whether this is a VAT bill (defaults from the category, editable per submission), plus
  // the supplier's VAT registration number and the VAT amount on the bill.
  is_vat?:          boolean;
  vat_number?:      string;
  vat_amount?:      number;
  shop_name:        string;
  // Free text — supports multiple lines, one item per line ("name - qty - unit price").
  item:             string;
  amount:           number;
  // Human-readable sequential number. TWO FORMATS coexist and both must keep displaying,
  // searching, sorting and exporting exactly as they always have:
  //   • legacy — "2608EPF12340001" (year+month, the employee's epf, then a 4-digit sequence
  //     scoped to that employee and reset every calendar month). Never rewritten.
  //   • current — a plain dense counter, "1", "2", "3", … per COMPANY per FISCAL YEAR, reset
  //     each April. The live set of a run is kept gap-free: cancelling a bill frees its number
  //     for the run's highest un-approved bill to move into (see deleteSubmission).
  // So a current-scheme number is NOT stable for life and is only unique WITHIN its run
  // (bill_no_scope) — read it with that pair, never as a global key. It never moves once the
  // bill has been approved, and never changes on resubmit-after-rejection.
  // Optional only for docs created before this field existed. See nextBillNo in suspenseService.ts.
  bill_no?:         string;
  // The counter run a current-scheme number was issued from: `${company_id}__${fiscalYear}`.
  // Absent on every legacy-numbered bill, which is what keeps them out of the density queries —
  // Firestore never matches a missing field against a literal value.
  bill_no_scope?:   string;
  bill_seq?:        number;           // numeric value of bill_no within that run (1, 2, 3, …)
  // Set only when this bill was moved into a cancelled bill's slot — the number it held before.
  // The full history lives in suspense_bill_events (SuspenseBillEvent); these two are the copy
  // that survives on the bill itself even if an event write fails.
  previous_bill_no?: string | null;
  renumbered_at?:   Timestamp | null;
  // When the bill was actually issued — read off the bill itself (AI/OCR) if it has a legible
  // date, otherwise the submission time. Optional only for docs created before this field
  // existed; always set on new/updated submissions — fall back to created_at when reading.
  bill_date?:       Timestamp;
  // Portions of this bill charged to other employees. On approval the submitter's account is
  // debited only (amount − Σ splits); each split amount is deducted from that employee's salary.
  splits?:          SuspenseSplit[];
  split_epfs?:      string[];        // denormalized epf list for array-contains deduction queries
  bill_url:         string | null;         // uploaded receipt (active cloud provider)
  bill_type:        'image' | 'pdf' | null;
  bill_name:        string | null;
  bill_kind:        'handwritten' | 'printed' | null;  // how the amount was captured
  bill_provider?:   'firebase' | 'onedrive' | null;    // where the bill file was uploaded
  bill_hash?:       string;                // SHA-256 of the bill file — used to block duplicate submissions
  // Set once this (approved) submission has been folded into a SuspenseVoucher — null/undefined
  // while still pending or rejected (only approved bills ever join one). See
  // addApprovedBillToVoucher in suspenseService.ts.
  voucher_id?:      string | null;
  note:             string;
  status:           SuspenseStatus;
  considered_by:    string | null;         // epf of the approver
  considered_by_name: string | null;
  considered_at:    Timestamp | null;
  reject_reason:    string | null;
  // Soft-deleted (cancelled by the submitter — only ever from pending or rejected; an approved
  // submission can't be cancelled). Hidden from every normal read; the doc itself is kept for
  // audit purposes rather than hard-deleted. See deleteSubmission in suspenseService.ts.
  deleted?:         boolean;
  deleted_at?:      Timestamp | null;
  deleted_by?:      string | null;
  deleted_by_name?: string | null;
  created_at:       Timestamp;
  updated_at:       Timestamp;
}

// ─── Bill audit trail (suspense_bill_events) ──────────────────────────────────
// One doc per thing that happened to a bill: it was created, edited, resubmitted after a
// rejection, cancelled, or renumbered into a cancelled bill's slot. This is the record the
// numbers themselves can no longer give you — a current-scheme bill_no is reused as the set is
// kept dense, so "which bill was number 7 in March" is only answerable from here.
// Written BEST-EFFORT: a failed event write is warned about and swallowed, never allowed to fail
// the bill operation underneath it. It is evidence of what happened, never a gate on what may.
// The actor is stored flat (actor_epf/actor_name) exactly like SuspenseLedgerEntry rather than as
// the services' Actor object — types.ts is imported BY the services, never the other way round.
export type SuspenseBillEventKind =
  | 'created'         // submitted, and issued its number
  | 'edited'          // a pending bill's fields changed
  | 'resubmitted'     // a rejected bill was fixed and sent back for approval — number unchanged
  | 'deleted'         // soft-deleted (cancelled/withdrawn) — frees its number
  | 'renumbered'      // moved into a cancelled bill's slot, to keep the run gap-free
  | 'gap_left_open';  // a cancelled bill's slot could NOT be backfilled — see `note`

// One changed field on an 'edited'/'resubmitted' event. Both sides are kept as display strings so
// the trail stays readable — and Firestore-safe — whatever the source field's type was.
export interface SuspenseBillEventChange {
  field:  string;
  before: string;
  after:  string;
}

export interface SuspenseBillEvent {
  id:                string;
  submission_id:     string;
  event:             SuspenseBillEventKind;
  bill_no:           string | null;    // the bill's number AFTER the event
  previous_bill_no?: string | null;    // only where a number moved ('renumbered')
  // The cancelled bill whose slot this event is about, so the two halves of one cancellation
  // ('deleted' + 'renumbered'/'gap_left_open') can be read back together.
  related_submission_id?: string | null;
  changes?:          SuspenseBillEventChange[];
  note?:             string | null;    // why a gap was left open; free text otherwise
  actor_epf:         string;
  actor_name:        string;
  created_at:        Timestamp;
}

// A rolling accumulator of approved bills — ANY category/subcategory/company, not scoped to a
// batch. Every approved bill joins whichever voucher is currently open (settled === false); if
// none is open, a new one is created. Settlement (marking as reconciled in QuickBooks) closes it
// permanently — the next approved bill starts a fresh voucher. See addApprovedBillToVoucher in
// suspenseService.ts. Whether a voucher is scoped to one employee ("per_user") or shared across
// everyone ("overall") is a System Settings toggle (see VoucherMode) — either way, employee_epfs/
// employee_names track every contributor; epf_number/employee_name stay fixed to whoever's bill
// FIRST opened it (used for the per_user "find my open voucher" lookup — a plain equality query,
// no array-contains index needed) and are only meaningful alone in per_user mode.
export interface SuspenseVoucher {
  id:               string;
  voucher_no:       string;          // human-readable sequential number, e.g. "26010001" — see nextSequenceNo
  epf_number:       string;          // the employee whose bill opened this voucher
  employee_name:    string;
  employee_epfs:    string[];        // every employee with a bill in this voucher (always includes epf_number)
  employee_names:   string[];        // parallel to employee_epfs
  company_ids:      string[];        // constituent bills may span companies — supports company filtering in reports
  submission_ids:   string[];        // the approved bills folded into this voucher; grows until settled
  total_amount:     number;
  total_vat_amount: number;
  // True only for a voucher opened for a "Group in vouchers" category bill (see
  // categoryIsolatesVouchers in suspenseService.ts) — holds exactly ONE bill forever. Normal
  // approvals must never join one of these (findOpenVoucherId skips them); undefined/false on
  // every ordinary rolling voucher, including all pre-existing ones.
  is_isolated?:     boolean;
  created_at:       Timestamp;       // when this voucher was first opened
  settled:          boolean;         // false = still open and accumulating; true = closed permanently
  settled_at:       Timestamp | null;
  settled_by:       string | null;
  settled_by_name:  string | null;
}

// A top-up request (credits the balance when approved; approver may edit the amount).
export interface SuspenseRequest {
  id:               string;
  epf_number:       string;
  employee_name:    string;
  company_id:       string;
  company_name:     string;
  amount:           number;                // amount requested by the holder
  approved_amount:  number | null;         // final amount the approver granted
  reason:           string;
  // What the credit is for, picked from the SAME expense taxonomy the bills use
  // (suspense_categories). Required on new requests; absent on requests filed before categories
  // existed, which display as "—" and carry no category gate.
  category_id?:     string | null;
  category_name?:   string | null;
  // Two-stage approval for technician requesters (see createRequest/approveSupervisorStage in
  // suspenseService.ts): needs_supervisor_approval is stamped once at creation from the
  // requester's role category at that time. `status` stays 'pending' throughout stage 1 — only
  // a suspense approver's approveRequest can flip it to 'approved'; either stage can flip it
  // straight to 'rejected' via the existing rejectRequest, unchanged. Optional/undefined on
  // existing docs and non-technician requesters, meaning "no supervisor gate".
  needs_supervisor_approval?: boolean;
  supervisor_status?: 'pending' | 'approved' | null;
  supervisor_approved_by?: string | null;
  supervisor_approved_by_name?: string | null;
  supervisor_approved_at?: Timestamp | null;
  requester_supervisor_epf?: string | null;   // snapshot of AppUser.supervisor_epf at submit time
  // Extra people an admin has granted stage-1 sign-off on THIS request alone (see
  // addRequestSupervisor in suspenseService.ts). The normal route — the requester's own
  // supervisor, or their company's supervisor pool — routinely comes up empty in practice: the
  // supervisor is on leave, has left, or the company list is stale, and the request then sits
  // at stage 1 with nobody able to move it. This is the escape hatch, per request, with who
  // added whom recorded on the entry itself rather than only in an audit log nobody reads.
  extra_supervisors?: Array<{
    epf: string; name: string;
    added_by: string; added_by_name: string; added_at: Timestamp;
  }>;
  // Stage 2 of 3 — the CATEGORY gate. Sits between the supervisor stage and the suspense
  // approver: a request whose category names credit_approvers reaches the approvers' queue only
  // once one of those people has signed it (see approveCategoryStage in suspenseService.ts).
  // `category_approvers` is snapshotted at creation from the category doc, minus the requester
  // themselves, so editing the category's approver list later never retargets a request already
  // in flight. Undefined/false on older docs and uncategorised requests, meaning "no category
  // gate" — exactly as it read before this stage existed.
  needs_category_approval?: boolean;
  category_status?: 'pending' | 'approved' | null;
  category_approvers?: SuspenseApprover[];
  category_approved_by?: string | null;
  category_approved_by_name?: string | null;
  category_approved_at?: Timestamp | null;
  status:           SuspenseStatus;
  considered_by:    string | null;
  considered_by_name: string | null;
  considered_at:    Timestamp | null;
  reject_reason:    string | null;
  created_at:       Timestamp;
  updated_at:       Timestamp;
}

// ─── Cloud storage (service photo / bill file uploads) ─────────────────────────
export type CloudProvider = 'firebase' | 'onedrive';

// Microsoft 365 / OneDrive via an Azure AD app (client-credentials flow + MS Graph).
// The client_secret is SERVER-ONLY — never returned to the browser.
export interface OneDriveConfig {
  tenant_id:               string;
  client_id:               string;
  client_secret?:          string;   // server-only
  folder_path:             string;   // Graph path, e.g. "user@org.com/drive/root:/Solar/bills"
  secret_created_date?:    string;   // YYYY-MM-DD
  secret_duration_months?: number;   // max 24
}

export interface CloudStorageConfig {
  provider:    CloudProvider;
  onedrive?:   OneDriveConfig;
  updated_at?: string;
  updated_by?: string;
}

// ─── Fingerprint Attendance (HF-X05 terminals) ─────────────────────────────────
// Backend contract: FINGERPRINT_APP_FIREBASE_BE_FUNCTION_CONTRACT_V1.md.
// Owned entirely by src/app/api/fingerprint/* and src/app/api/admin/fingerprint-devices/*
// (Admin SDK only — see the deny rules for these collections in firestore.rules). The
// browser client never reads/writes them directly; these types exist for reference and
// for any future admin UI, not for use by userService/attendanceService.
//
// There is no separate opaque "userId" in this app — epf_number IS the users/{doc id},
// and is what the fingerprint terminal contract's `userId` maps to. `employeeId` maps to
// employee_number, falling back to epf_number for staff with no separate employee no.
export type FingerPosition =
  | 'RIGHT_THUMB' | 'RIGHT_INDEX' | 'RIGHT_MIDDLE' | 'RIGHT_RING' | 'RIGHT_LITTLE'
  | 'LEFT_THUMB'  | 'LEFT_INDEX'  | 'LEFT_MIDDLE'  | 'LEFT_RING'  | 'LEFT_LITTLE';

// One physical HF-X05 terminal. `working_place` is the fixed location recorded on every
// check-in/out this unit produces (terminals have no GPS, unlike the mobile check-in flow).
export interface AttendanceDevice {
  id:            string;          // deviceId, e.g. "HF-X05-001" — Firestore doc id
  name:          string;
  active:        boolean;
  working_place: string | null;
  company_id?:   string;
  company_name?: string;
  created_by:      string;        // epf of the admin who provisioned it
  created_by_name: string;
  created_at:    Timestamp;
  updated_at:    Timestamp;
}

export interface FingerprintEnrollment {
  id:              string;         // enrollmentId (Android UUID) — Firestore doc id
  epf_number:      string;
  employee_id:     string;
  device_id:       string;
  finger_position: FingerPosition;
  template_count:  5;
  matcher_engine:                 string;
  matcher_implementation_version: string;
  template_format:                string;
  template_format_version:        number;
  active:             boolean;
  enrolled_at_device:  string;    // ISO timestamp from the terminal
  created_at:          Timestamp; // authoritative server time
  updated_at:          Timestamp;
}

// Stored in the existing fingerprint_enrollments collection for a shared device-authenticated
// enrollment API. FACE records are identified by biometric_type and contain portable SFace
// features only, never a camera image or Android-Keystore ciphertext.
export interface FaceEnrollment {
  id:               string; // deterministic employee/device scope record id
  enrollment_id:    string; // Android-generated idempotency id from the latest save
  biometric_type:   'FACE';
  epf_number:       string;
  employee_id:      string;
  device_id:        string;
  template_count:   3;
  engine_id:        string;
  model_id:         'face_recognition_sface';
  model_version:    '2021dec';
  template_format:  'sface-f32le-v1';
  active:           boolean;
  enrolled_at_device: string | null;
  created_at:       Timestamp;
  updated_at:       Timestamp;
}

export interface FaceTemplateRecord {
  id:                    '1' | '2' | '3';
  enrollment_id:         string;
  biometric_type:        'FACE';
  template_slot:         1 | 2 | 3;
  template_data_base64:  string;
  created_at_device:     string | null;
  created_at:            Timestamp;
}

// Subcollection: fingerprint_enrollments/{enrollmentId}/templates/{templateRecordId}.
// No template bytes stored (V1 metadata-only decision — see the API doc); add
// template_data_base64?: string here if central template backup is turned on later.
export interface FingerprintTemplateRecord {
  id:               string;        // templateRecordId (Android UUID) — Firestore doc id
  enrollment_id:    string;
  epf_number:       string;
  device_id:        string;
  finger_position:  FingerPosition;
  template_slot:    1 | 2 | 3 | 4 | 5;
  created_at_device: string;
  created_at:        Timestamp;
}

// Idempotency ledger for recordFingerprintAttendance / bulkRecordFingerprintAttendance —
// one doc per Android-generated attendanceEventId. Only ever written on a RECORDED
// outcome (see fingerprintApi.ts) so a REJECTED event can still succeed on retry once
// the underlying issue — e.g. an inactive user — is fixed.
export interface FingerprintAttendanceEvent {
  id:                  string;      // attendanceEventId (Android UUID) — Firestore doc id
  epf_number:          string;
  device_id:           string;
  status:              'RECORDED';
  attendance_record_id: string;     // attendances/{id} this event landed on
  attendance_action:    'CHECK_IN' | 'CHECK_OUT';
  device_timestamp:     string;
  client_sequence?:     number | null;
  received_at:          Timestamp;
}
