// @ts-nocheck — intentional: this adapter bridges Firebase types to legacy API shapes
/**
 * apiCompat.ts
 *
 * Drop-in Firebase replacements for every function the original pages
 * called via api.ts.  Each function returns the EXACT same data shape
 * the original page code unpacks — checked against every res.data access.
 */

import { format } from 'date-fns';
import { epfDocId } from '@/services/userService';
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc,
  query, where, orderBy, runTransaction, onSnapshot,
  Timestamp as FSTimestamp,
} from 'firebase/firestore';
import { updatePassword, EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, auth, storage, tenant } from '@/lib/firebase';
import { saveUserFcmToken } from '@/services/userService';
import { getRoles } from '@/services/roleService';
import { isShiftActiveOn } from '@/services/shiftService';
import { getWorkingPlaces } from '@/services/workingPlaceService';
import { getScheduleForDate } from '@/services/workingScheduleService';
import { nearestWorkingPlace, matchWithinRadius, distanceToPlace, distanceMeters } from '@/lib/geo';
import { canonPlaceName } from '@/lib/placeName';
import {
  placeKeysOf, sessionAtPlace, shiftRouteVisibility, pastSubmissionNeedsApproval, backlogStartFor,
  type PlaceKeys,
} from '@/lib/approvalRouting';
import { checkInNeedsApproval } from '@/lib/checkInApprovalPolicy';
import { createAppNotification } from '@/services/notificationService';
import {
  shiftCutoffViolation, leaveTypeHasApplyCutoff,
  LEAVE_APPLY_CUTOFF_HOURS, LEAVE_DELETION_CUTOFF_HOURS,
  LEAVE_APPLY_SHIFT_CUTOFF_MSG, LEAVE_DELETION_SHIFT_CUTOFF_MSG,
} from '@/lib/shiftCutoff';
import {
  pickAssignmentForOpenSession, scheduledShiftEndMs, isPastGrace, autoCloseGapHours,
  systemAutoCheckoutFields, type ShiftWindow,
} from '@/lib/shiftAutoClose';

// Auto-outstation threshold: a technician's check-out more than this far from the day's
// assigned (or primary) working place is flagged outstation automatically.
const OUTSTATION_DISTANCE_M = 60_000; // 60 km
const WFH_NAME = 'Work From Home';    // executives-only working place
// Others see a WFH check-in as "[Name]'s home" — protects the executive's home privacy
// (the home location itself is never exposed; only the label).
const wfhLabel = (place: any, name: string): string | null =>
  place === WFH_NAME ? `${name}’s home` : (place ?? null);
import {
  roleCan, resolveUserCapabilities, descendantRoleNamesOf, roleParentName,
  roleCategory, canPickTechnicians, canApproveTechnicians, childRoleNamesOf,
  makeTechnicianPickPredicate, type Role, type RoleCapabilities,
} from '@/lib/permissions';
import { daysCovered, overlapsWindow } from '@/lib/onLeaveCalendar';
import { excludedLeaveTypeNames, excludedTakenRows, isExcludedTypeName } from '@/lib/leaveQuotaScope';

// Nearest configured working place (with coordinates) to a point — the no-schedule
// outstation reference: "are you near ANY known/saved working place?".
function nearestPlaceWithCoords(lat: number, lng: number, places: any[]): any | null {
  let best: any = null, bestD = Infinity;
  for (const p of places) {
    if (p.latitude == null || p.longitude == null) continue;
    const d = distanceMeters(lat, lng, p.latitude, p.longitude);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// The outstation reference base for a day, given a location: the place SCHEDULED for that
// exact day (with coords), else the nearest saved working place to the location. null when
// neither can be resolved (no coordinates anywhere).
async function outstationReferenceFor(
  epf: string, date: string, locLat: number, locLng: number, places: any[],
): Promise<any | null> {
  try {
    const sched = await getScheduleForDate(epf, date);
    if (sched?.working_place) {
      const p = places.find((x: any) => x.name === sched.working_place && x.latitude != null && x.longitude != null);
      if (p) return p;
    }
  } catch { /* fall through to saved places */ }
  return nearestPlaceWithCoords(locLat, locLng, places);
}

// Auto-derive the outstation flag for a (past / edited) record where there's no live GPS:
// the chosen working place's location vs that day's reference base (scheduled place, else the
// nearest saved working place). >60km → outstation. Returns null when it can't be measured
// (place or reference lacks coordinates). Used by past submissions and edit-request applies.
async function autoOutstationByPlace(
  epf: string, date: string, placeName: string | null | undefined, placesArg?: any[],
): Promise<boolean | null> {
  if (!placeName) return null;
  try {
    const places = placesArg ?? await getWorkingPlaces();
    const loc = places.find((p: any) => p.name === placeName && p.latitude != null && p.longitude != null);
    if (!loc) return null;
    const ref = await outstationReferenceFor(epf, date, loc.latitude, loc.longitude, places);
    if (!ref) return null;
    return distanceMeters(loc.latitude, loc.longitude, ref.latitude, ref.longitude) > OUTSTATION_DISTANCE_M;
  } catch { return null; }
}

// True when, on `date`, the person checked in at a working place carrying the 'shift' tag.
// Enables a technician with no roster assignment to work a shift that day (overnight + label).
// Matches the GPS-matched check-in site, the recorded working place and the session's
// location history — canonically, so a Solar-app "<name> (#site-no)" pick still counts.
async function checkedInAtShiftPlaceOn(epf: string, date: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, 'attendances', attDocId(epf, date)));
    if (!snap.exists()) return false;
    const ids = new Set<string>(), names = new Set<string>();
    sessionsOf(snap.data()).forEach((s: any) => {
      if (!s.check_in) return;
      if (s.check_in_site_id)   ids.add(String(s.check_in_site_id));
      if (s.check_in_site_name) names.add(canonPlaceName(s.check_in_site_name));
      if (s.working_place)      names.add(canonPlaceName(s.working_place));
      if (Array.isArray(s.locations)) s.locations.forEach((l: any) => {
        if (l?.name) names.add(canonPlaceName(l.name));
      });
    });
    if (!ids.size && !names.size) return false;
    const places = await getWorkingPlaces();
    return places.some((p: any) =>
      Array.isArray(p.tags) && p.tags.includes('shift') &&
      (ids.has(String(p.id)) || names.has(canonPlaceName(p.name))));
  } catch { return false; }
}

// True when the working place SCHEDULED (effective) for the person on `date` carries the
// 'shift' tag — i.e. they're allocated to a shift place, so they can work that day as a shift
// (overnight + label) even before checking in. The schedule stores the place NAME, matched
// against the admin working places (Solar sites can't be tagged, so they never qualify).
async function scheduledAtShiftPlaceOn(epf: string, date: string): Promise<boolean> {
  try {
    const sched = await getScheduleForDate(epf, date);
    if (!sched?.working_place) return false;
    const places = await getWorkingPlaces();
    return places.some((p: any) =>
      Array.isArray(p.tags) && p.tags.includes('shift') &&
      canonPlaceName(p.name) === canonPlaceName(sched.working_place));
  } catch { return false; }
}

// Whether `date` is a shift day for the person: a roster assignment covers it, OR (for a
// technician) they're scheduled to a 'shift'-tagged place that day, OR they checked in at a
// 'shift'-tagged working place that day.
// Deliberately excludes the persistent is_shift_worker capability flag — see getMyTodayAttendance.
async function isShiftDayOn(u: any, epf: string, date: string): Promise<boolean> {
  try { if (await isShiftActiveOn(epf, date)) return true; } catch { /* ignore */ }
  try {
    const roles = await getRoles();
    if (roleCategory(u?.role, roles) === 'technician') {
      if (await scheduledAtShiftPlaceOn(epf, date)) return true;
      if (await checkedInAtShiftPlaceOn(epf, date)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

// A user is on shift for a date if a roster assignment covers it, they checked in at a
// shift-tagged place, or the legacy per-user shift capability flag is set.
async function isShiftWorkerOn(u: any, epf: string, date: string): Promise<boolean> {
  if (u?.is_shift_worker) return true;
  return isShiftDayOn(u, epf, date);
}

// ─── Shift-place approval routing ──────────────────────────────────────────────
// Working-place keys (id + CANONICAL name) carrying the 'shift' tag. Attendance at a shift
// place routes to the employee's assigned supervisor, to management and to that place's own
// location supervisors (shiftRouteVisibility in @/lib/approvalRouting), so the approval /
// pick surfaces load these once and match each session's place against them.
async function loadShiftPlaceKeys(): Promise<PlaceKeys> {
  try {
    return placeKeysOf((await getWorkingPlaces()) as any[], p => Array.isArray(p.tags) && p.tags.includes('shift'));
  } catch { return { ids: new Set(), names: new Set() }; }   // no shift restriction if places can't load
}

// Keys of every 'shift'-tagged working place `viewerEpf` is a location supervisor of
// (supervisor_epfs) — matched by id AND canonical name because a past submission records only
// the place name. Deliberately shift places ONLY: the shift rule asks "does the viewer
// supervise the shift place this session is at", and a session names up to three places
// (check-in site, site name, current working place). Matching the viewer against ALL their
// places would let a supervisor of a non-shift place the employee later moved to approve a
// shift check-in that routed elsewhere.
function viewerShiftPlaceKeysOf(places: any[], viewerEpf: string): PlaceKeys {
  return placeKeysOf(places, p => Array.isArray(p?.tags) && p.tags.includes('shift')
    && Array.isArray(p?.supervisor_epfs)
    && p.supervisor_epfs.map((e: any) => String(e ?? '').trim()).includes(String(viewerEpf)));
}

function today() { return format(new Date(), 'yyyy-MM-dd'); }

// Every calendar date (YYYY-MM-DD) between from..to inclusive.
function leaveDatesInRange(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const cur = new Date(fy, fm - 1, fd), end = new Date(ty, tm - 1, td);
  while (cur <= end) {
    out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}
// Working days (Sun + Sat excluded) in a YYYY-MM-DD range, inclusive — mirrors
// getLeaveSummary.countDays so a request's size is measured the same way its quota usage is.
function businessDayCount(from: string, to: string): number {
  return leaveDatesInRange(from, to).filter(d => {
    const [y, m, dd] = d.split('-').map(Number);
    const wd = new Date(y, m - 1, dd).getDay();
    return wd !== 0 && wd !== 6;
  }).length;
}
// Southern Lanka — one employee's live (non-deleted) shift assignments as
// {date,start_time,end_time} for the shift cut-off rules (see @/lib/shiftCutoff, which reads
// only date+start_time) and the check-in self-healing guard (which also needs end_time). Runs
// client-side, same local clock as the leaves page's own inline check.
async function shiftAssignmentsFor(epf: string): Promise<ShiftWindow[]> {
  const snap = await getDocs(query(collection(db, 'schedule_assignments'), where('epf_number', '==', String(epf))));
  return snap.docs
    .map(d => d.data())
    .filter(a => !a.is_deleted)
    .map(a => ({
      date: String(a.date ?? ''),
      start_time: String(a.start_time ?? ''),
      end_time: String(a.end_time ?? ''),
    }));
}
// Group sorted YYYY-MM-DD dates into contiguous (consecutive-day) segments.
function contiguousSegments(dates: string[]): string[][] {
  const sorted = [...dates].sort();
  const dayNo = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
  const segs: string[][] = [];
  let cur: string[] = [];
  for (const d of sorted) {
    if (cur.length === 0 || dayNo(d) === dayNo(cur[cur.length - 1]) + 1) cur.push(d);
    else { segs.push(cur); cur = [d]; }
  }
  if (cur.length) segs.push(cur);
  return segs;
}

// Convert Firestore Timestamp → "YYYY-MM-DD HH:MM:SS" in LOCAL time (not UTC).
// The original pages display times directly, so they must be in the device's local timezone.
function tsToStr(ts: FSTimestamp | null | undefined): string | null {
  if (!ts) return null;
  const d = ts.toDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Parse a local datetime string "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM:SS"
// into a Firestore Timestamp using LOCAL time (not UTC).
function localStrToTimestamp(str: string): FSTimestamp {
  // Replace T separator and take first 19 chars
  const clean = str.replace('T', ' ').slice(0, 19);
  const [datePart, timePart] = clean.split(' ');
  const [y, mo, d]  = datePart.split('-').map(Number);
  const [h, mi, s]  = (timePart ?? '00:00:00').split(':').map(Number);
  return FSTimestamp.fromDate(new Date(y, mo - 1, d, h, mi, s));
}

// Minute-floor a timestamp for overnight/zero-length comparisons. The In/Out editors
// (both live and past cards) are minute-only inputs, but an UNEDITED side of the pair keeps
// its real capture seconds — comparing at full precision lets a same-minute Out slip past as
// "a few seconds different" and get rolled a full day forward instead of being treated as the
// same instant.
function minuteFloor(ts: FSTimestamp): number {
  return Math.floor(ts.toMillis() / 60000);
}

// Attendance doc IDs encode the EPF to handle "/" in values like EMPAV/00009
function attDocId(epf: string, date: string) { return `${epfDocId(epf)}_${date}`; }

// ─── Attendance sessions ────────────────────────────────────────────────────────
// A day's attendance is an array of sessions. Old docs stored a single session in
// top-level fields; sessionsOf() normalizes both shapes so every reader is uniform.
function sessionsOf(a: any): any[] {
  if (a && Array.isArray(a.sessions)) return a.sessions;
  if (!a || (!a.check_in && !a.check_out)) return [];
  return [{
    id:                     's0',
    check_in:               a.check_in ?? null,
    check_out:              a.check_out ?? null,
    working_place:          a.working_place ?? null,
    site_number:            a.site_number ?? null,
    is_outstation:          a.is_outstation ?? false,
    outstation_location_id: a.outstation_location_id ?? null,
    outstation_name:        a.outstation_name ?? null,
    outstation_address:     a.outstation_address ?? null,
    is_outstation_approved: a.is_outstation_approved ?? false,
    morning_allowance:      a.morning_allowance ?? 0,
    evening_allowance:      a.evening_allowance ?? 0,
    check_in_approved_by:   a.check_in_approved_by ?? null,
    check_out_approved_by:  a.check_out_approved_by ?? null,
    check_in_status:        a.check_in_status ?? 'pending',
    check_out_status:       a.check_out_status ?? 'pending',
    is_past_submission:     a.is_past_submission ?? false,
    past_approved_by:       a.past_approved_by ?? null,
  }];
}

function newSessionId(): string { return `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`; }

// The currently open session (checked in, not yet checked out), if any.
function openSessionOf(sessions: any[]): any | undefined {
  return sessions.find(s => s.check_in && !s.check_out);
}

// Previous calendar day for a "YYYY-MM-DD" string.
function prevDayStr(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// Morning food allowance from a check-in time — mirrors the Approvals page rule:
//   before 06:45 → Cat 1, 06:45–07:00 → Cat 2, after 07:00 → none.
function calcMorningAllowanceFromTs(ts: FSTimestamp | null | undefined): 0 | 1 | 2 {
  if (!ts) return 0;
  const d = ts.toDate();
  const mins = d.getHours() * 60 + d.getMinutes();
  if (mins < 6 * 60 + 45) return 1;
  if (mins <= 7 * 60) return 2;
  return 0;
}

// Southern Lanka has no manual approval step for the FINGERPRINT channel — every fingerprint
// session is auto-approved at submission time by fingerprintApi.ts, under its own sentinel
// ('FINGERPRINT') so the two channels stay distinguishable in the data. The MOBILE channel
// (checkIn/checkOut/submitPastAttendance below) still needs manual approval for Southern Lanka
// — see the mobile-approvals note on `needsApproval` in checkIn below, and note that the
// in-range auto-approval described there is off for that tenant.
// This sentinel now only remains as a fallback in considerAttendanceEditRequest's
// record-creation path (an edit-request approval with no approver epf recorded).
const AUTO_APPROVED_SENTINEL = 'AUTO_APPROVED';

// ─── Session locations ─────────────────────────────────────────────────────────
// A session accumulates every place it worked at in `locations[]` (check-in GPS match,
// check-out pick, manual adds via "Update location" / past / edit forms). The single
// `working_place` field stays a mirror of the latest/primary entry for legacy readers.
const locKey = (name: any, site?: any) =>
  `${String(name ?? '').trim().toLowerCase()}|${String(site ?? '').trim().toLowerCase()}`;

// Append one location entry, skipping an exact (name + site) duplicate.
function appendLocation(list: any[] | undefined, entry: {
  name: string; site_number?: string | null;
  lat?: number | null; lng?: number | null; accuracy_m?: number | null;
  source: 'check_in' | 'check_out' | 'manual'; added_by?: string | null;
}): any[] {
  const cur = Array.isArray(list) ? [...list] : [];
  if (!entry.name) return cur;
  if (cur.some(l => locKey(l?.name, l?.site_number) === locKey(entry.name, entry.site_number))) return cur;
  cur.push({
    name:        entry.name,
    site_number: entry.site_number ?? null,
    lat:         entry.lat ?? null,
    lng:         entry.lng ?? null,
    accuracy_m:  entry.accuracy_m ?? null,
    source:      entry.source,
    added_at:    FSTimestamp.now(),
    added_by:    entry.added_by ?? null,
  });
  return cur;
}

function emptySession(
  checkInTime: string,
  needsApproval: boolean,
  loc?: { lat: number | null; lng: number | null; accuracy?: number | null },
  site?: { id: string; name: string; distance: number } | null,
  // Was the check-in GPS inside a working place's OWN radius? null = the question could not
  // be answered (no GPS fix, or no place has coordinates) — which is not the same as "no".
  withinRadius?: boolean | null,
): any {
  return {
    id:                     newSessionId(),
    // Location history starts with the check-in GPS match (when one was made).
    locations:              site ? appendLocation([], {
                              name: site.name, lat: loc?.lat ?? null, lng: loc?.lng ?? null,
                              accuracy_m: loc?.accuracy ?? null, source: 'check_in',
                            }) : [],
    check_in:               localStrToTimestamp(checkInTime),
    check_out:              null,
    check_in_lat:           loc?.lat ?? null,   // employee device GPS at check-in (recorded, not enforced)
    check_in_lng:           loc?.lng ?? null,
    check_in_accuracy_m:    loc?.accuracy ?? null,
    check_out_lat:          null,
    check_out_lng:          null,
    check_out_accuracy_m:   null,
    // Check-in GPS matched to the nearest configured working_place (null = no match).
    check_in_site_id:       site?.id ?? null,
    check_in_site_name:     site?.name ?? null,
    check_in_site_distance_m: site ? Math.round(site.distance) : null,
    // Stricter than check_in_site_* above, which is a 1 km proximity LABEL: this is the
    // place's own radius, and it is the evidence behind an in-range auto-approval. Recorded
    // on every tenant; only acted on where TenantFeatures.autoApproveInRangeCheckIn is on.
    check_in_within_radius: withinRadius ?? null,
    // Pick state — set when a team-leader-or-above claims this session (see pickTechnician).
    picked_by:              null,
    picked_by_name:         null,
    picked_at:              null,
    working_place:          null,
    site_number:            null,
    is_outstation:          false,
    outstation_location_id: null,
    outstation_name:        null,
    outstation_address:     null,
    is_outstation_approved: false,
    morning_allowance:      0,
    evening_allowance:      0,
    check_in_approved_by:   null,
    check_out_approved_by:  null,
    check_in_status:        needsApproval ? 'pending' : 'approved',
    check_out_status:       'pending',
    is_past_submission:     false,
    past_approved_by:       null,
  };
}

// Wall-clock 'HH:MM' on a 'YYYY-MM-DD' as device-local epoch ms — the clock the rest of this
// file works in (localStrToTimestamp etc.). Passed to the shiftAutoClose helpers so their
// date math matches the mobile client's timezone.
function deviceLocalMs(dateStr: string, hhmm: string): number {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = String(hhmm ?? '').split(':').map(Number);
  return new Date(y, (mo || 1) - 1, d || 1, h || 0, mi || 0, 0, 0).getTime();
}

// Close sessions[idx] as system-auto, stamped at the scheduled shift end — the client-SDK
// mirror of src/lib/attendanceAutoClose.closeSessionSystemAuto. Southern Lanka has no food
// allowance, so evening_allowance is left untouched (same as checkOut here).
function closeSessionSystemAutoLocal(sessions: any[], idx: number, scheduledEndMs: number): any[] {
  const next = sessions.map(s => ({ ...s }));
  next[idx] = {
    ...next[idx],
    check_out: FSTimestamp.fromMillis(scheduledEndMs),
    ...systemAutoCheckoutFields(),
    auto_closed_at: FSTimestamp.now(),
  };
  return next;
}

/**
 * Determines the employee scope for a supervisor:
 *   - Top Management / HR / Admin → all users system-wide
 *   - User in company.supervisor_epfs → all users in their company
 *   - Otherwise → only direct subordinates (supervisor_epf == their EPF)
 *
 * Returns the EPFs of employees they can manage.
 */
// An employee is resigned if date_of_resign is set and on/before today
function isResigned(dateOfResign: string | null | undefined): boolean {
  if (!dateOfResign) return false;
  const today = new Date().toISOString().slice(0, 10);
  return dateOfResign <= today;
}

// ─── Employees-in-scope cache ─────────────────────────────────────────────────
// Resolving a supervisor's approval scope does a supervisor lookup + a (possibly
// whole-collection) users scan + role resolution. The approvals/absentees pages call
// it 3-4x per load (check-in list, past list, edit requests, absentees). Cache per
// supervisor with a short TTL + in-flight coalescing so one load resolves scope once.
// Invalidated explicitly when users or the role tree change (see invalidateScopeCache).
const SCOPE_TTL_MS = 60_000;
const _scopeCache = new Map<string, { value: any; at: number }>();
const _scopeInflight = new Map<string, Promise<any>>();

// Full `users` collection snapshot — the single heaviest read on approval-style pages,
// previously re-fetched independently by every function that needed an epf→user map
// (approvals context, past list, leave lists, picks…). Same TTL + in-flight coalescing
// as the scope cache, and invalidated together with it when users change.
const _usersCacheTtlMs = SCOPE_TTL_MS;
let _usersCache: { snap: any; at: number } | null = null;
let _usersInflight: Promise<any> | null = null;

async function getUsersSnapshotCached(): Promise<any> {
  if (_usersCache && Date.now() - _usersCache.at < _usersCacheTtlMs) return _usersCache.snap;
  if (_usersInflight) return _usersInflight;
  _usersInflight = (async () => {
    const snap = await getDocs(collection(db, 'users'));
    _usersCache = { snap, at: Date.now() };
    return snap;
  })();
  try { return await _usersInflight; } finally { _usersInflight = null; }
}

export function invalidateScopeCache(): void {
  _scopeCache.clear();
  _scopeInflight.clear();
  _usersCache = null;
  _usersInflight = null;
}

async function getEmployeesInScope(supervisorEpf: string): Promise<{
  employees: any[];
  scope: 'system' | 'company' | 'direct';
  companyName: string;
}> {
  const key = String(supervisorEpf);
  const hit = _scopeCache.get(key);
  if (hit && Date.now() - hit.at < SCOPE_TTL_MS) return hit.value;
  const inflight = _scopeInflight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const value = await _getEmployeesInScopeUncached(supervisorEpf);
    _scopeCache.set(key, { value, at: Date.now() });
    return value;
  })();
  _scopeInflight.set(key, p);
  try { return await p; } finally { _scopeInflight.delete(key); }
}

async function _getEmployeesInScopeUncached(supervisorEpf: string): Promise<{
  employees: any[];
  scope: 'system' | 'company' | 'direct';
  companyName: string;
}> {
  // Get supervisor's own profile — try string match first, then coerce to number
  let supData: any = {};
  const supSnapStr = await getDocs(query(collection(db, 'users'), where('epf_number', '==', supervisorEpf)));
  if (!supSnapStr.empty) {
    supData = supSnapStr.docs[0].data();
  } else {
    // epf_number may be stored as integer in Firestore
    const asNum = Number(supervisorEpf);
    if (!isNaN(asNum)) {
      const supSnapNum = await getDocs(query(collection(db, 'users'), where('epf_number', '==', asNum)));
      if (!supSnapNum.empty) supData = supSnapNum.docs[0].data();
    }
  }

  const supRole    = supData.role ?? 'Executive';
  const supCompany = supData.company_name ?? '';

  // System scope = sees every employee org-wide (System Admin, user managers, and
  // leave managers such as HR). Other approvers see EVERY tier below them in the role
  // tree (all descendant roles), within their own company — so a request reports up to
  // all higher tiers, not just the immediate parent.
  const roles    = await getRoles();
  const supCaps  = resolveUserCapabilities(supData, roles);
  // A top-of-tree approver (a root role like COO — an approver with no parent tier) oversees
  // the whole org, even without a user/leave-management capability. This keeps their scope
  // from silently breaking when the role hierarchy below them isn't fully wired.
  const isTopApprover = supCaps.can_approve && roleParentName(supRole, roles) === null;
  const isManagement = supCaps.is_system_admin || supCaps.can_manage_users || supCaps.can_manage_leaves || isTopApprover;

  let empSnap;
  let scope: 'system' | 'company' | 'direct';
  let belowNames: string[] = [];

  if (isManagement) {
    // Management / top-of-tree approver → all employees across all companies
    scope   = 'system';
    empSnap = await getUsersSnapshotCached();
  } else {
    // Approver → every role beneath theirs in the tree, in the same company
    scope      = 'direct';
    belowNames = descendantRoleNamesOf(supRole, roles);
    empSnap = supCompany
      ? await getDocs(query(collection(db, 'users'), where('company_name', '==', supCompany)))
      : { docs: [] as any[] };
  }

  const employees = empSnap.docs
    .map(d => {
      const data = d.data();
      // Normalize epf_number to string in case it was stored as integer
      return { ...data, epf_number: String(data.epf_number) };
    })
    .filter(u =>
      u.is_active !== false &&
      !isResigned(u.date_of_resign) &&            // exclude resigned employees
      u.epf_number !== String(supervisorEpf) &&
      (scope === 'system' || belowNames.includes(u.role)) && // tree: every tier below
      // Approvers without "Approve leads" (e.g. Team Leader) only see non-approver staff.
      (supCaps.can_approve_leads || !roleCan(u.role, 'can_approve', roles))
    );

  return { employees, scope, companyName: supCompany };
}

// Southern Lanka only — fixed escalation ladder for the Comprehensive Approval Engine
// (bottom → top): HR Assistant → HR Executive → General Manager. These are the three
// Protected Top-Tier Roles pinned in roles/page.tsx (is_protected: true, Name and Reports To
// locked in the edit form) specifically so this hardcoded list can never silently drift out of
// sync with the actual role names. Super Admin sits above all three but never needs to appear
// here — is_system_admin/can_manage_users/can_manage_leaves already bypass this whole engine
// (see the isManagement checks at every call site) and can act on anything regardless.
const ESCALATION_LADDER = ['HR Assistant', 'HR Executive', 'General Manager'] as const;
const ESCALATION_LADDER_INDEX: Record<string, number> =
  Object.fromEntries(ESCALATION_LADDER.map((name, i) => [name, i]));

// Resolves the fixed-ladder approver(s) for `applicant`, walking STRICTLY above the
// applicant's own rung (never a same-rung peer — see the Lower HR Self-Requests rule: an HR
// Assistant's own request must escalate to HR Executive, not sit with another HR Assistant).
// General Manager is the one reversed case: nobody sits above them but Super Admin, so their
// own request walks DOWN toward HR Executive, then HR Assistant, instead of up.
//
// `allTiers`:
//   false (default) — the ORIGINAL escalation: the first rung that resolves anyone wins and
//                     the walk stops. Used for attendance-edit routing (nearest tier only).
//   true            — UNION every rung above the applicant. Used for the leave workflow, where
//                     the whole chain above the applicant (HR Assistant + HR Executive +
//                     General Manager) must be aware of a pending request, not just the
//                     nearest tier. Any one of them can still approve it.
function ladderApprovers(
  applicant: { epf_number: string; role?: string; company_name?: string },
  allUsers: Array<Record<string, any>>,
  roles: Role[],
  capKey: keyof RoleCapabilities,
  opts: { allTiers?: boolean } = {},
): string[] {
  const applicantEpf = String(applicant.epf_number);
  const isActive = (u: Record<string, any>) => u.is_active !== false && !isResigned(u.date_of_resign);
  const applicantIdx = ESCALATION_LADDER_INDEX[applicant.role ?? ''];
  const order: readonly string[] =
    applicant.role === 'General Manager' ? ['HR Executive', 'HR Assistant']
    : applicantIdx === undefined         ? ESCALATION_LADDER
    : ESCALATION_LADDER.slice(applicantIdx + 1);

  const collected: string[] = [];
  for (const tierName of order) {
    const tierEpfs = allUsers.filter(u =>
      String(u.epf_number) !== applicantEpf
      && isActive(u)
      && u.role === tierName
      && (!applicant.company_name || String(u.company_name ?? '') === String(applicant.company_name))
      && resolveUserCapabilities(u, roles)[capKey],   // Toggle Permission Check — see below
    ).map(u => String(u.epf_number));
    if (tierEpfs.length) {
      if (!opts.allTiers) return tierEpfs;   // nearest-tier-wins (attendance edits)
      collected.push(...tierEpfs);           // union mode (leave) — keep walking up
    }
  }
  return collected;
}

// Southern Lanka only — leave requests, attendance edit requests, AND plain attendance
// check-in/check-out approvals (see requestAttendanceEdit, resolveApprovalsContext /
// buildCheckinResult / getPastAttendanceApprovalList, approveCheckIn / approveCheckOut /
// approvePastAttendance) all have no manual "Requested By"/approver pick (see the
// isSouthernlanka gate on leaves/page.tsx); routing is automatic instead. Resolves the set of
// active EPFs who currently act as `applicant`'s approver(s) for the given capability:
//   1. Department HOD — every Head of Department whose assigned departments
//      (hod_department_names, set on the Users page) include the applicant's own department.
//      HOD status ALONE is sufficient — being an assigned HOD of the applicant's department
//      grants approval rights over them independent of whether `capKey` is separately toggled
//      on the HOD's own role (no more "Toggle Permission Check" here). Self-exclusion is what
//      makes a department's own (sole) HOD escalate on their own request instead of approving
//      themselves.
//   2. Fixed escalation ladder (see ladderApprovers) — "users holding roles positioned above
//      the applicant". Unlike route 1, this DOES still require the matching `capKey` toggle on
//      the ladder role (HR Assistant / HR Executive / General Manager aren't automatically
//      approvers just by sitting on the ladder). Behaviour depends on the workflow:
//      • LEAVE (capKey === 'can_approve_leaves') — the ladder is ALWAYS unioned in, ALL rungs
//        above the applicant (HR Assistant + HR Executive + General Manager). When someone
//        applies, the HOD AND every top-level role above them are all notified and any one of
//        them can approve. This is deliberately a blanket union, not a nearest-tier hop.
//      • ATTENDANCE / ATTENDANCE EDIT (capKey === 'can_approve') — the ladder is only a
//        FALLBACK, consulted solely when route 1 resolves nobody, and only its nearest
//        resolving rung. Unchanged.
// Self-Approval is impossible either way (a candidate is always excluded from approving their
// own request). Auto-approved only when NEITHER route resolves anyone (e.g. General Manager
// applying with no HR Executive/HR Assistant active). Every read path (getLeaveRequests /
// getAttendanceEditRequests / buildCheckinResult / getPastAttendanceApprovalList) AND every
// write path (considerLeave / considerAttendanceEditRequest / approveCheckIn / approveCheckOut
// / approvePastAttendance) call this with the SAME capKey, so visibility and approval
// authority always match the notify set.
function southernlankaApprovers(
  applicant: { epf_number: string; role?: string; department?: string; company_name?: string },
  allUsers: Array<Record<string, any>>,
  roles: Role[],
  capKey: keyof RoleCapabilities,
): string[] {
  const applicantEpf = String(applicant.epf_number);
  const isActive = (u: Record<string, any>) => u.is_active !== false && !isResigned(u.date_of_resign);
  // Leave requests fan out to the whole chain above the applicant; attendance edits keep the
  // narrower "nearest tier, ladder only as an HOD fallback" routing.
  const fanOutLadder = capKey === 'can_approve_leaves';
  const epfs = new Set<string>();

  if (applicant.department) {
    allUsers.forEach(u => {
      if (String(u.epf_number) !== applicantEpf && isActive(u)
          && Array.isArray(u.hod_department_names) && u.hod_department_names.includes(applicant.department)) {
        epfs.add(String(u.epf_number));
      }
    });
  }

  if (fanOutLadder) {
    // Always include every ladder rung above the applicant, in addition to any HOD(s).
    ladderApprovers(applicant, allUsers, roles, capKey, { allTiers: true }).forEach(epf => epfs.add(epf));
  } else if (epfs.size === 0) {
    // Attendance-edit fallback: nearest resolving rung, only when no HOD covers the applicant.
    ladderApprovers(applicant, allUsers, roles, capKey).forEach(epf => epfs.add(epf));
  }

  return Array.from(epfs);
}

// Southern Lanka only — re-derive attendance approval authority at WRITE time, exactly the
// way considerAttendanceEditRequest / considerLeave already do for their own workflows: never
// trust whatever the read-time visibility (buildCheckinResult / getPastAttendanceApprovalList)
// handed the client, always recompute fresh against current roles/HOD assignments. A no-op for
// every other tenant. Self-approval is always blocked (even for management); management
// (is_system_admin / can_manage_users / can_manage_leaves) otherwise bypasses the HOD/ladder
// check, same as the leave and edit-request flows.
async function assertSouthernlankaAttendanceAuthority(approverEpf: string, applicantEpf: string): Promise<void> {
  if (tenant.id !== 'southernlanka') return;
  if (String(approverEpf) === String(applicantEpf)) {
    throw new Error('You cannot approve your own attendance.');
  }
  const [roles, usersSnap] = await Promise.all([getRoles(), getUsersSnapshotCached()]);
  const allUsersData = usersSnap.docs.map((d: any) => d.data());
  const approver = allUsersData.find((u: any) => String(u.epf_number) === String(approverEpf));
  const approverCaps = resolveUserCapabilities(approver, roles);
  if (approverCaps.is_system_admin || approverCaps.can_manage_users || approverCaps.can_manage_leaves) return;
  const applicant = allUsersData.find((u: any) => String(u.epf_number) === String(applicantEpf));
  if (!applicant) throw new Error('Employee not found.');
  const approverEpfs = southernlankaApprovers(
    { epf_number: applicantEpf, role: applicant.role, department: applicant.department, company_name: applicant.company_name },
    allUsersData, roles, 'can_approve',
  );
  if (!approverEpfs.includes(String(approverEpf))) {
    throw new Error("You are not authorized to approve this employee's attendance.");
  }
}

// Southern Lanka only — first-year leave accrual for Interns, Trainees and newly-joined
// Permanent employees (Contract is unaffected). Applies to ONE leave type per employee,
// which one depending on their employee type:
//   • Intern / Trainee        → the type configured with `is_trainee_accruable: true` on the
//                               Leave Types admin page (NO name is hardcoded — resolved from
//                               config at call time). If none is configured, no accrual.
//   • Permanent (first year)   → 'Annual Leaves'
// Every other type keeps its normal fixed annual_quota, even during year 1 — see
// getLeaveSummary.
const FIRST_YEAR_LEAVE_TYPE_PERMANENT = 'Annual Leaves';
const FIRST_YEAR_MONTHLY_ACCRUAL = 0.5;
const FIRST_YEAR_MAX_MONTHS = 12;

// Which leave type an employee's first-year 0.5/month accrual is booked under. `traineeType`
// is the resolved name of the `is_trainee_accruable` leave type (caller reads it from the
// leave_types config) — '' when none is configured, which disables the accrual for
// Interns/Trainees (firstYearAccrualWindow returns null on an empty name).
function firstYearLeaveTypeFor(employeeType: string | undefined, traineeType: string): string {
  return ['Intern', 'Trainee'].includes(String(employeeType))
    ? traineeType
    : FIRST_YEAR_LEAVE_TYPE_PERMANENT;
}

// Resolves whether `employeeType`/`dateOfJoin` are currently within the first-12-month
// accrual window (anchored to the ORIGINAL joining date — never the date employee_type
// changed, so a Trainee who becomes Permanent mid-window keeps the same clock instead of
// restarting it). Returns null when the normal (existing, untouched) quota calculation
// should apply instead — either because this employee type isn't covered, or the window has
// already ended.
//   • monthsAccrued: calendar months from the join month through today, inclusive (the join
//     month itself always counts as month 1, regardless of which day of the month they
//     joined — no proration within a month), capped at FIRST_YEAR_MAX_MONTHS.
//   • windowStartStr/windowEndStr: the exact date range to scope "used" against (join date →
//     12 calendar months later, exclusive) — mirrors how getLeaveSummary already scopes the
//     normal quota to [yearStart, yearEnd] for every other type.
function firstYearAccrualWindow(
  employeeType: string | undefined,
  dateOfJoin: string | null | undefined,
  todayStr: string, // 'YYYY-MM-DD'
  traineeType: string, // resolved name of the is_trainee_accruable type ('' when unconfigured)
): { monthsAccrued: number; windowStartStr: string; windowEndStr: string; leaveTypeName: string } | null {
  if (!dateOfJoin) return null;
  if (!['Intern', 'Trainee', 'Permanent'].includes(String(employeeType))) return null;
  // No target type resolved (Intern/Trainee with nothing flagged is_trainee_accruable) →
  // fall back to the normal quota rules for this employee.
  const leaveTypeName = firstYearLeaveTypeFor(employeeType, traineeType);
  if (!leaveTypeName) return null;
  const joinStr = String(dateOfJoin).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(joinStr);
  if (!m) return null;
  const jy = Number(m[1]), jm = Number(m[2]), jd = Number(m[3]);

  const pad = (n: number) => String(n).padStart(2, '0');
  // 12 calendar months after the join date (exclusive end), e.g. 2026-08-18 → 2027-08-18.
  const endY = jy + Math.floor((jm - 1 + FIRST_YEAR_MAX_MONTHS) / 12);
  const endM = ((jm - 1 + FIRST_YEAR_MAX_MONTHS) % 12) + 1;
  const windowEndStr = `${endY}-${pad(endM)}-${pad(jd)}`;
  if (todayStr >= windowEndStr) return null; // first year is over → normal rules apply

  const ty = Number(todayStr.slice(0, 4)), tm = Number(todayStr.slice(5, 7));
  const monthsElapsed = (ty - jy) * 12 + (tm - jm) + 1; // join month = month 1
  const monthsAccrued = Math.min(FIRST_YEAR_MAX_MONTHS, Math.max(0, monthsElapsed));
  return { monthsAccrued, windowStartStr: joinStr, windowEndStr, leaveTypeName };
}

// ─── authApi ──────────────────────────────────────────────────────────────────
export const authApi = {
  login:          async () => ({ data: {} }),
  logout:         async () => {},
  refresh:        async () => {},

  changePassword: async (data: any) => {
    const fbUser = auth.currentUser;
    if (!fbUser?.email) throw new Error('Not authenticated');
    const cred = EmailAuthProvider.credential(fbUser.email, data.old_password);
    await reauthenticateWithCredential(fbUser, cred);
    await updatePassword(fbUser, data.new_password);
    return { data: { status: 'Request was successful.' } };
  },

  saveFcmToken: async (data: any) => {
    await saveUserFcmToken(data.epf_number, data.fcm_token, data.old_fcm_token);
    return { data: { status: 'ok' } };
  },
};

// ─── profileApi ───────────────────────────────────────────────────────────────
export const profileApi = {
  // Original page unpacks: res.data?.data?.profile_data ?? res.data?.data ?? res.data
  // Returns { name, email, personal_phonenumber, ... }
  getProfile: async (epfNumber: string) => {
    const snap = await getDoc(doc(db, 'users', epfDocId(epfNumber)));
    if (!snap.exists()) throw new Error('User not found');
    const u = snap.data();
    const profile = {
      name:                  u.display_name ?? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim(),
      email:                 u.email ?? '',
      personal_phonenumber:  u.phone_personal ?? '',
      office_phonenumber:    u.phone_office ?? '',
      emergency_phonenumber: u.phone_emergency ?? '',
      epf_number:            u.epf_number,
      address:               u.address ?? '',
      nic:                   u.nic ?? '',
      date_of_birth:         u.date_of_birth ?? '',
    };
    // Wrap in profile_data so all three fallback paths work
    return { data: { data: { profile_data: profile, ...profile }, ...profile } };
  },

  // Original page calls saveProfile(formData), then:
  //   res.data?.data?.user ?? res.data?.data ?? res.data
  saveProfile: async (formData: FormData) => {
    const epf   = formData.get('epf_number') as string;
    const name  = formData.get('name') as string;
    const phone = formData.get('personal_phonenumber') as string;
    const addr  = formData.get('address') as string;
    const img   = formData.get('profile_image') as File | null;

    const updates: Record<string, unknown> = { updated_at: FSTimestamp.now() };

    if (name?.trim()) {
      const parts = name.trim().split(/\s+/);
      const last  = parts.pop() ?? '';
      const first = parts.join(' ') || last;
      updates.first_name   = first;
      updates.last_name    = last;
      updates.display_name = name.trim();
    }
    if (phone) updates.phone_personal = phone;
    if (addr)  updates.address        = addr;

    let avatarUrl: string | null = null;
    if (img && img.size > 0) {
      const sRef = storageRef(storage, `avatars/${epf}/${Date.now()}`);
      await uploadBytes(sRef, img);
      avatarUrl = await getDownloadURL(sRef);
      updates.avatar_url = avatarUrl;
    }

    await updateDoc(doc(db, 'users', epfDocId(epf)), updates);

    const snap = await getDoc(doc(db, 'users', epfDocId(epf)));
    const u = snap.data() ?? {};
    const user = { name: u.display_name, email: u.email, avatar: u.avatar_url };
    return { data: { data: { user }, status: 'Request was successful.' } };
  },

  // Returns blob — page does URL.createObjectURL(res.data)
  getProfilePicture: async (epfNumber: string) => {
    const snap = await getDoc(doc(db, 'users', epfDocId(epfNumber)));
    if (!snap.exists()) throw new Error('No user');
    const url: string | null = snap.data().avatar_url ?? null;
    if (!url) throw new Error('No avatar');
    const resp = await fetch(url);
    const blob = await resp.blob();
    return { data: blob };
  },

  // Pages unpack: inner?.supervisors ?? inner ?? []
  getSupervisors: async (company: string, search?: string) => {
    // Query by company_name; is_active may be undefined for migrated users so filter client-side
    const roles = await getRoles();
    const q = query(
      collection(db, 'users'),
      where('company_name', '==', company),
    );
    const snap = await getDocs(q);
    let list = snap.docs
      .map(d => d.data())
      // is_active === false means explicitly deactivated; undefined = migrated user, treat as active
      .filter(u => u.is_active !== false)
      .filter(u => roleCan(u.role, 'can_approve', roles));

    if (search?.trim().length) {
      const term = search.toLowerCase().trim();
      list = list.filter(u =>
        (u.name_tokens ?? []).some((t: string) => t.includes(term)) ||
        (u.display_name ?? '').toLowerCase().includes(term) ||
        (u.epf_number ?? '').includes(term)
      );
    }

    const supervisors = list.map(u => ({
      name:        u.display_name ?? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim(),
      epf_number:  u.epf_number,
      designation: u.designation ?? '',
    }));
    return { data: { data: { supervisors }, supervisors } };
  },

  // Pages unpack: edata?.supervisor?.epf_number
  getSupervisor: async (epfNumber: string) => {
    const snap = await getDoc(doc(db, 'users', epfDocId(epfNumber)));
    if (!snap.exists()) return { data: { data: { supervisor: null } } };
    const supEpf: string | null = snap.data().supervisor_epf ?? null;
    if (!supEpf) return { data: { data: { supervisor: null } } };
    const supSnap = await getDoc(doc(db, 'users', supEpf));
    if (!supSnap.exists()) return { data: { data: { supervisor: null } } };
    const s = supSnap.data();
    const supervisor = {
      name:        s.display_name ?? `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim(),
      epf_number:  s.epf_number,
      designation: s.designation ?? '',
    };
    return { data: { data: { supervisor } } };
  },

  // Leave applicants pick their approver from all UPPER-TIER (ancestor) roles in the tree,
  // within their own company.
  // Returns two lists:
  //   supervisors   — the default suggestions: the employee's direct supervisor + the company's
  //                   designated supervisor(s) + HR (leave managers), de-duplicated.
  //   all_approvers — everyone the leave can be routed to when searching: all executive +
  //                   top-management category users (active).
  getSupervisorsForLeave: async (epfNumber: string, company: string) => {
    const [roles, usersSnap] = await Promise.all([getRoles(), getUsersSnapshotCached()]);
    const all      = usersSnap.docs.map(d => d.data());
    const byEpf    = new Map(all.map(u => [String(u.epf_number), u]));
    const me       = byEpf.get(String(epfNumber));
    const comp     = company || me?.company_name || '';

    const usable  = (u: any) => !!u && u.is_active !== false && !isResigned(u.date_of_resign) && String(u.epf_number) !== String(epfNumber);
    const toEntry = (u: any) => ({
      name:        u.display_name ?? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim(),
      epf_number:  u.epf_number,
      designation: u.designation ?? '',
    });

    // ── Default: employee's direct supervisor + company supervisor(s) + HR (deduped by epf) ──
    const defaultEpfs = new Set<string>();
    if (me?.supervisor_epf) defaultEpfs.add(String(me.supervisor_epf));
    try {
      const compSnap = await getDocs(query(collection(db, 'companies'), where('name', '==', comp)));
      const supEpfs  = compSnap.docs[0]?.data()?.supervisor_epfs ?? [];
      (Array.isArray(supEpfs) ? supEpfs : []).forEach((e: any) => defaultEpfs.add(String(e)));
    } catch { /* non-critical */ }
    all.forEach(u => { if (usable(u) && resolveUserCapabilities(u, roles).can_manage_leaves) defaultEpfs.add(String(u.epf_number)); });

    const supervisors = Array.from(defaultEpfs)
      .map(e => byEpf.get(e))
      .filter(usable)
      .map(toEntry)
      .sort((a, b) => a.name.localeCompare(b.name));

    // ── Search pool: every executive / top-management user (active) ──
    const all_approvers = all
      .filter(u => usable(u) && (roleCategory(u.role, roles) === 'executive' || roleCategory(u.role, roles) === 'top_management'))
      .map(toEntry)
      .sort((a, b) => a.name.localeCompare(b.name));

    return { data: { data: { supervisors, all_approvers }, supervisors, all_approvers } };
  },
};

// ─── attendanceApi ────────────────────────────────────────────────────────────
// Map a stored session into the string-time shape the pages consume.
function mapSession(s: any, overnight = false): any {
  return {
    id:                     s.id,
    check_in:               tsToStr(s.check_in),
    check_out:              tsToStr(s.check_out),
    check_in_status:        s.check_in_status ?? 'pending',
    check_out_status:       s.check_out_status ?? 'pending',
    check_in_approved_by:   s.check_in_approved_by ?? null,
    check_out_approved_by:  s.check_out_approved_by ?? null,
    working_place:          s.working_place ?? null,
    site_number:            s.site_number ?? null,
    is_outstation:          s.is_outstation ?? false,
    outstation_name:        s.outstation_name ?? null,
    outstation_address:     s.outstation_address ?? null,
    morning_allowence:      s.morning_allowance ?? 0,
    evening_allowence:      s.evening_allowance ?? 0,
    is_overnight:           overnight,
    check_in_lat:           s.check_in_lat ?? null,
    check_in_lng:           s.check_in_lng ?? null,
    check_out_lat:          s.check_out_lat ?? null,
    check_out_lng:          s.check_out_lng ?? null,
    check_in_accuracy_m:    s.check_in_accuracy_m ?? null,
    check_out_accuracy_m:   s.check_out_accuracy_m ?? null,
    check_in_site_id:       s.check_in_site_id ?? null,
    check_in_site_name:     s.check_in_site_name ?? null,
    check_in_site_distance_m: s.check_in_site_distance_m ?? null,
    check_in_within_radius:    s.check_in_within_radius ?? null,
    check_out_site_distance_m: s.check_out_site_distance_m ?? null,
    check_out_within_radius:   s.check_out_within_radius ?? null,
    // Full location history; legacy sessions without one fall back to the single place.
    locations:              sessionLocationsOf(s),
  };
}

// Page-facing location list for a session: the stored `locations[]` history, else a
// single-entry fallback built from the legacy `working_place` (old docs).
function sessionLocationsOf(s: any): any[] {
  if (Array.isArray(s.locations) && s.locations.length) {
    return s.locations.map((l: any) => ({
      name:        l?.name ?? '',
      site_number: l?.site_number ?? null,
      lat:         l?.lat ?? null,
      lng:         l?.lng ?? null,
      source:      l?.source ?? 'manual',
      added_at:    tsToStr(l?.added_at),
    }));
  }
  return s.working_place
    ? [{ name: s.working_place, site_number: s.site_number ?? null, lat: null, lng: null, source: 'check_out', added_at: null }]
    : [];
}

// Build the page-facing attendance object: a sessions[] array plus legacy top-level
// fields mirroring the "current" session (the open one, else the latest).
function buildAttPayload(id: string, a: any, sessions: any[]): any {
  const mapped  = sessions.map(s => mapSession(s, !!s._overnight));
  const open    = mapped.find((m: any) => m.check_in && !m.check_out);
  const current = open ?? mapped[mapped.length - 1] ?? null;
  return {
    attendance_id: id,
    epf_number:    a.epf_number,
    date:          a.date,
    sessions:      mapped,
    is_checked_in: !!open,
    // Legacy top-level (mirrors the current session) so older readers keep working:
    check_in:               current?.check_in ?? null,
    check_out:              current?.check_out ?? null,
    check_in_status:        current?.check_in_status ?? 'pending',
    check_out_status:       current?.check_out_status ?? 'pending',
    check_in_approved_by:   current?.check_in_approved_by ?? null,
    check_out_approved_by:  current?.check_out_approved_by ?? null,
    morning_allowence:      current?.morning_allowence ?? 0,
    evening_allowence:      current?.evening_allowence ?? 0,
    working_place:          current?.working_place ?? null,
    site_number:            current?.site_number ?? null,
    is_outstation:          current?.is_outstation ?? false,
    outstation_name:        current?.outstation_name ?? null,
    outstation_address:     current?.outstation_address ?? null,
    // Captured GPS / geofence match for the current session (today's check-in / check-out).
    check_in_lat:           current?.check_in_lat ?? null,
    check_in_lng:           current?.check_in_lng ?? null,
    check_out_lat:          current?.check_out_lat ?? null,
    check_out_lng:          current?.check_out_lng ?? null,
    check_in_accuracy_m:    current?.check_in_accuracy_m ?? null,
    check_out_accuracy_m:   current?.check_out_accuracy_m ?? null,
    check_in_site_id:       current?.check_in_site_id ?? null,
    check_in_site_name:     current?.check_in_site_name ?? null,
    check_in_site_distance_m: current?.check_in_site_distance_m ?? null,
    check_out_within_radius:  current?.check_out_within_radius ?? null,
    check_out_site_distance_m: current?.check_out_site_distance_m ?? null,
    locations:              current?.locations ?? [],
  };
}

// ─── Approvals data layer (shared by one-shot getters + realtime subscription) ──────
// Stable numeric id for a session that survives realtime rebuilds AND list refetches, so
// per-record edit/selection state keyed by it stays valid across snapshot updates, and the
// __attIdMap entry for an id can never be remapped to a different session by a later fetch
// (a remap silently routed approvals to the wrong record). Used by both the live and the
// past/backlog approval lists. Full 32-bit hash space keeps collision odds negligible.
function stableId(docId: string, sessionId: string): number {
  const str = `${docId}__${sessionId}`;
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return 1_000_000 + h;
}

interface ApprovalsCtx {
  roles: any;
  userByEpf: Map<string, any>;
  supervisorEpf: string;
  viewerCompany: string;
  // Southern Lanka only — routes attendance approvals by Department HOD + escalation ladder
  // instead of the generic supervisor/company/location-supervisor rules below (see
  // southernlankaApprovers and its use in buildCheckinResult / getPastAttendanceApprovalList).
  isSouthernlanka: boolean;
  systemWide: boolean;
  canPickTech: boolean;
  canPickMember: (targetRole: string | undefined, targetEmployeeType?: string) => boolean; // may this viewer pick the given target?
  execSeeAll: boolean;
  execSubordinateRoles: Set<string>; // executive-category role names below this viewer (can_approve_leads)
  viewerLocationIds: Set<string>;   // working-place ids this viewer is a location supervisor of
  viewerShiftPlaceKeys: PlaceKeys;  // the SHIFT-tagged subset of those places, by id + canonical name
  supervisedPlaceIds: Set<string>;  // working-place ids that have ANY location supervisor assigned
  shiftPlaceKeys: { ids: Set<string>; names: Set<string> }; // places tagged 'shift' → supervisor-only routing
}

// Resolve the heavy approval context ONCE (roles + all users + company-supervisor flags).
// The realtime subscription reuses this so a snapshot update only reprocesses attendance
// docs — not the whole users collection — which is the main DB-call optimisation.
async function resolveApprovalsContext(supervisorEpf: string, company: string): Promise<ApprovalsCtx> {
  // The three big reads are independent — fetch them concurrently so the approvals
  // page waits one round trip, not three stacked ones.
  const [roles, usersSnap, placesSnap] = await Promise.all([
    getRoles(),
    getUsersSnapshotCached(),
    getDocs(collection(db, 'working_places')),
  ]);
  const userByEpf = new Map<string, any>();
  usersSnap.docs.forEach(d => { const u = d.data(); userByEpf.set(String(u.epf_number), u); });
  const viewer        = userByEpf.get(String(supervisorEpf));
  const viewerRole    = viewer?.role ?? '';
  const viewerCompany = viewer?.company_name ?? company ?? '';
  const viewerCaps    = resolveUserCapabilities(viewer, roles);
  const isManagement  = viewerCaps.is_system_admin || viewerCaps.can_manage_users || viewerCaps.can_manage_leaves;
  const isTopApprover = viewerCaps.can_approve && roleParentName(viewerRole, roles) === null;
  // Top-management-category approvers (e.g. COO) oversee everyone — any employee, any
  // company — even when their role isn't a tree root.
  const isTopMgmt     = viewerCaps.can_approve && roleCategory(viewerRole, roles) === 'top_management';
  const systemWide    = isManagement || isTopApprover || isTopMgmt;
  const canPickTech   = canPickTechnicians(viewerRole, roles);
  // Whether this viewer may pick a given target — resolved per-target with the target's employee_type,
  // so a trainee "Team Leader" (who can't lead) is pickable. Applied to every pick surface.
  const canPickMember = makeTechnicianPickPredicate(viewerRole, roles);
  let inCompanySupervisors = false;
  try {
    const compSnap = await getDocs(query(collection(db, 'companies'), where('name', '==', viewerCompany)));
    const supEpfs  = compSnap.docs[0]?.data()?.supervisor_epfs ?? [];
    inCompanySupervisors = Array.isArray(supEpfs) && supEpfs.map(String).includes(String(supervisorEpf));
  } catch { /* non-critical */ }
  // Company supervisors (listed in company.supervisor_epfs) see ALL executives in their company;
  // system admins / top-of-tree approvers see everyone.
  const execSeeAll = systemWide || inCompanySupervisors;
  // can_approve_leads → may approve subordinate APPROVER roles, so this viewer also sees the
  // executive-category roles beneath them in the role tree (same company), not just direct
  // reports. Empty set when the viewer can't approve leads.
  const execSubordinateRoles = new Set<string>();
  if (viewerCaps.can_approve_leads) {
    for (const rn of descendantRoleNamesOf(viewerRole, roles)) {
      if (roleCategory(rn, roles) !== 'technician') execSubordinateRoles.add(rn);
    }
  }
  // Locations this viewer supervises (working_places.supervisor_epfs) → can approve any
  // check-in whose GPS matched those places, additive to normal routing.
  const viewerLocationIds = new Set<string>();
  const supervisedPlaceIds = new Set<string>();   // places that route their technicians to a location supervisor
  const shiftPlaceIds = new Set<string>();         // places tagged 'shift'
  const shiftPlaceNames = new Set<string>();       // canonical names (see sessionAtPlace)
  placesSnap.docs.forEach(p => {
    const data = p.data() as any;
    if (Array.isArray(data?.tags) && data.tags.includes('shift')) {
      shiftPlaceIds.add(p.id);
      if (data.name) shiftPlaceNames.add(canonPlaceName(data.name));
    }
    const sup = data?.supervisor_epfs;
    const supEpfs = Array.isArray(sup) ? sup.map(String).filter((e: string) => e.trim() !== '') : [];
    if (supEpfs.length === 0) return;
    supervisedPlaceIds.add(p.id);
    if (supEpfs.includes(String(supervisorEpf))) viewerLocationIds.add(p.id);
  });
  const viewerShiftPlaceKeys = viewerShiftPlaceKeysOf(placesSnap.docs.map(p => ({ id: p.id, ...(p.data() as any) })), String(supervisorEpf));
  return {
    roles, userByEpf, supervisorEpf: String(supervisorEpf), viewerCompany,
    isSouthernlanka: tenant.id === 'southernlanka',
    systemWide, canPickTech, canPickMember, execSeeAll, execSubordinateRoles, viewerLocationIds, viewerShiftPlaceKeys, supervisedPlaceIds,
    shiftPlaceKeys: { ids: shiftPlaceIds, names: shiftPlaceNames },
  };
}

// Build the check-in / check-out approval lists from attendance docs + context (pure).
function buildCheckinResult(ctx: ApprovalsCtx, todayDocs: any[], yestDocs: any[]) {
  const { roles, userByEpf, supervisorEpf, viewerCompany, isSouthernlanka, systemWide, canPickTech, canPickMember, execSeeAll, execSubordinateRoles, viewerLocationIds, viewerShiftPlaceKeys, supervisedPlaceIds, shiftPlaceKeys } = ctx;
  const sameCompany = (c: any) => systemWide || (c ?? '') === viewerCompany;
  // Executive/top-management check-in visibility:
  //   • company-supervisors / management → all execs in their company,
  //   • a direct report (supervisor_epf), or
  //   • a subordinate executive role down the tree (can_approve_leads, same company).
  // Technicians are routed by location below.
  const canSeeExecCheckIn = (empRole: string, empCompany: any, empSupervisor: any) =>
    (execSeeAll && sameCompany(empCompany))
    || String(empSupervisor ?? '') === String(supervisorEpf)
    || (execSubordinateRoles.has(empRole) && sameCompany(empCompany));
  // A technician's pending check-in routes to the location supervisor of the place their
  // check-in GPS matched. If that place HAS a location supervisor, only that supervisor (or a
  // system admin) sees it; otherwise it falls back to the general executive/picker pool.
  // A picker sees a technician's check-in only for roles they may pick — pick-only team leaders
  // are limited to roles strictly below their own (pickableRoles); location supervisors still see
  // every technician routed to a place they supervise, regardless of role.
  const canSeeTechCheckIn = (siteId: string | null, empRole: string, empEmployeeType?: string) => {
    if (siteId && supervisedPlaceIds.has(siteId)) return systemWide || viewerLocationIds.has(siteId);
    return systemWide || canPickMember(empRole, empEmployeeType);
  };

  // Southern Lanka only — no supervisor/company/pick-based routing at all: a pending
  // check-in/checkout is visible ONLY to the applicant's department HOD(s) and, failing that,
  // whoever sits above them on the escalation ladder (see southernlankaApprovers). Cached per
  // applicant epf since the same person's sessions repeat across today/yesterday's docs.
  const allUsersData = isSouthernlanka ? Array.from(userByEpf.values()) : [];
  const hodLadderCache = new Map<string, boolean>();
  const hodLadderCanSee = (empEpf: string, empRole: string, empDept: string | undefined, empCompany: string): boolean => {
    if (!hodLadderCache.has(empEpf)) {
      const approvers = southernlankaApprovers(
        { epf_number: empEpf, role: empRole, department: empDept, company_name: empCompany },
        allUsersData, roles, 'can_approve',
      );
      hodLadderCache.set(empEpf, approvers.includes(supervisorEpf));
    }
    return hodLadderCache.get(empEpf)!;
  };

  const pending: any[] = [];
  const idMap: Record<number, { docId: string; sessionId: string }> = {};

  const processDoc = (d: any, checkoutOnly: boolean) => {
    const a    = d.data();
    if (a.is_deleted) return;   // soft-deleted attendance is hidden from approvals
    const aEpf = String(a.epf_number);
    const emp  = userByEpf.get(aEpf);
    if (emp && (emp.is_active === false || isResigned(emp.date_of_resign))) return;
    const role          = emp?.role ?? 'Technician';
    const empCompany    = emp?.company_name ?? '';
    const empSupervisor = emp?.supervisor_epf ?? null;
    const isTechRole = roleCategory(role, roles) === 'technician';
    const daySessions = sessionsOf(a);
    daySessions.forEach((s: any, sIdx: number) => {
      // Past-submission sessions are handled exclusively by getPastAttendanceApprovalList
      // (regardless of their date) — never here. Without this skip, a needs-approval past
      // submission dated yesterday would ALSO surface in this (checkout-only) pass, and with
      // ids now stable per (doc, session), it would collide with the past list's entry for
      // the very same session: one shared checkbox for two different-looking cards, and its
      // Approve action silently rerouted to the past-approve flow, discarding any edit made
      // on this card.
      if (s.is_past_submission) return;
      const siteId = s.check_in_site_id ? String(s.check_in_site_id) : null;
      // Is the viewer a location supervisor of the place this session's check-in GPS matched?
      const iSuperviseThisPlace = !!siteId && viewerLocationIds.has(siteId);
      // Shift-place attendance routes only to the employee's assigned supervisor, management and
      // the place's own location supervisors; otherwise technicians route by location and execs by scope. A restricted
      // session is hidden entirely from other viewers — including its check-out, which must not
      // leak via the "unclaimed check-in" path below.
      const shiftVis = shiftRouteVisibility(
        sessionAtPlace(s, shiftPlaceKeys), empSupervisor, supervisorEpf, systemWide, sessionAtPlace(s, viewerShiftPlaceKeys));
      if (shiftVis === false) return;
      const canSeeThisCheckIn = shiftVis !== null
        ? shiftVis
        : isSouthernlanka
          ? (systemWide || hodLadderCanSee(aEpf, role, emp?.department, empCompany))
          : isTechRole
            ? canSeeTechCheckIn(siteId, role, emp?.employee_type)
            : canSeeExecCheckIn(role, empCompany, empSupervisor);
      const checkInPending = !checkoutOnly && !!s.check_in && s.check_in_status === 'pending'
                           && canSeeThisCheckIn;
      // Who may see/close a pending CHECK-OUT: an admin, the approver who claimed the check-in
      // (its check-out is theirs to close), a supervisor of the check-in place, OR — when the
      // check-in was never claimed (approved_by null) — only someone already in the check-in's
      // NORMAL routing (canSeeThisCheckIn). Gating the unclaimed case this way stops a pending
      // check-out from leaking to every executive (even ACROSS companies) merely because its
      // check-in has no recorded approver.
      const claimedByMe    = systemWide
                           || String(s.check_in_approved_by) === String(supervisorEpf)
                           || iSuperviseThisPlace
                           || (!s.check_in_approved_by && canSeeThisCheckIn);
      const hasPendingCheckout = !!s.check_out && s.check_out_status === 'pending';
      const checkOutOnly = !checkInPending && hasPendingCheckout && claimedByMe;
      const both = checkInPending && hasPendingCheckout;
      if (!checkInPending && !checkOutOnly) return;
      const type = both ? 'both' : checkInPending ? 'check_in' : 'check_out';
      const showCheckout = type !== 'check_in';
      const aid = stableId(d.id, s.id);
      idMap[aid] = { docId: d.id, sessionId: s.id };
      pending.push({
        attendance_id:      aid,
        epf_number:         aEpf,
        name:               emp?.display_name ?? aEpf,
        phone:              emp?.phone_personal || emp?.phone_office || null,
        time:               type === 'check_out' ? tsToStr(s.check_out) : tsToStr(s.check_in),
        check_out_time:     showCheckout ? tsToStr(s.check_out) : null,
        working_place:      showCheckout ? wfhLabel(s.working_place, emp?.display_name ?? aEpf) : null,
        site_no:            showCheckout ? (s.site_number ?? null) : null,
        is_outstation:      showCheckout ? !!s.is_outstation : false,
        is_outstation_auto: showCheckout ? !!s.is_outstation_auto : false,
        outstation_ref_distance_m: showCheckout ? (s.outstation_ref_distance_m ?? null) : null,
        outstation_name:    showCheckout ? (s.outstation_name ?? null) : null,
        outstation_address: showCheckout ? (s.outstation_address ?? null) : null,
        check_in_site_name: s.check_in_site_name ?? null,
        // Every place the session worked at (multi-location history).
        locations:          sessionLocationsOf(s),
        // Captured GPS (for the approver's location maps).
        check_in_lat:       s.check_in_lat ?? null,
        check_in_lng:       s.check_in_lng ?? null,
        check_out_lat:      showCheckout ? (s.check_out_lat ?? null) : null,
        check_out_lng:      showCheckout ? (s.check_out_lng ?? null) : null,
        check_out_within_radius: showCheckout ? (s.check_out_within_radius ?? null) : null,
        picked_by_name:     s.picked_by_name ?? null,
        picked_by:          s.picked_by ?? null,
        picked_at:          s.picked_at ? tsToStr(s.picked_at) : null,
        role, type,
        session_no:         sIdx + 1,
        session_count:      daySessions.length,
        is_shift_worker:    !!emp?.is_shift_worker,
        date:               a.date,
      });
    });
  };
  todayDocs.forEach(d => processDoc(d, false));
  yestDocs.forEach(d => processDoc(d, true));   // overnight checkouts only

  const techList = pending.filter(r => roleCategory(r.role, roles) === 'technician');
  // Executives never approve their OWN attendance — drop the viewer's own record from the
  // exec list. It stays visible to their approver (a different supervisorEpf).
  const exeList  = pending.filter(r => roleCategory(r.role, roles) !== 'technician'
    && String(r.epf_number) !== String(supervisorEpf));
  // Southern Lanka: tab access itself is HOD/ladder-scoped, not can_approve/pick-scoped — a
  // department HOD (or someone on the escalation ladder above at least one active employee)
  // may open a tab even when it's currently empty, independent of the generic can_approve
  // toggle (see southernlankaApprovers). `systemWide` still covers management/top-of-tree.
  const viewerHodDepts = isSouthernlanka
    ? new Set<string>(userByEpf.get(supervisorEpf)?.hod_department_names ?? [])
    : new Set<string>();
  const viewerOnLadder = isSouthernlanka && ESCALATION_LADDER.includes(userByEpf.get(supervisorEpf)?.role ?? '');
  // Staff tab is visible to technician-pickers AND to any location supervisor (who approves the
  // technicians routed to their place, even without an executive/picker role) — and to a plain
  // assigned supervisor when a shift-place technician has actually routed to them (techList).
  const hasTechnicians = techList.length > 0
    || (isSouthernlanka
      ? (systemWide || viewerHodDepts.size > 0 || viewerOnLadder)
      : (canPickTech || systemWide || viewerLocationIds.size > 0)
        && Array.from(userByEpf.values()).some((u: any) =>
          u.is_active !== false && roleCategory(u.role, roles) === 'technician'));
  const canSeeExecs = isSouthernlanka
    ? (systemWide || viewerHodDepts.size > 0 || viewerOnLadder)
    : execSeeAll || Array.from(userByEpf.values()).some((u: any) =>
      u.is_active !== false && roleCategory(u.role, roles) !== 'technician'
      && (String(u.supervisor_epf ?? '') === String(supervisorEpf)
          || (execSubordinateRoles.has(u.role) && sameCompany(u.company_name))));
  const result = {
    tech_count:      techList.length,
    tech_list_type:  techList.length > 0 ? techList[0].type : 'check_in',
    tech_list:       techList,
    exe_list_type:   exeList.length  > 0 ? exeList[0].type  : 'check_in',
    exe_list:        exeList,
    has_technicians: hasTechnicians,
    has_executives:  canSeeExecs,
  };
  return { result, idMap };
}

// Build pickable-technician rows from today's attendance docs + context (pure).
function buildPickRows(ctx: ApprovalsCtx, todayDocs: any[]): any[] {
  // Pick / My Team is disabled for Southern Lanka (see pickTechnician) — an empty pool keeps
  // the Approvals page's Pick UI from rendering anything for that tenant.
  if (tenant.id === 'southernlanka') return [];
  const { roles, userByEpf, supervisorEpf, viewerCompany, systemWide, canPickTech, canPickMember, execSeeAll, execSubordinateRoles, viewerLocationIds, viewerShiftPlaceKeys, supervisedPlaceIds, shiftPlaceKeys } = ctx;
  const sameCompany = (c: any) => systemWide || (c ?? '') === viewerCompany;
  const rows: any[] = [];
  todayDocs.forEach(d => {
    const a    = d.data();
    const aEpf = String(a.epf_number);
    const emp  = userByEpf.get(aEpf);
    if (emp && (emp.is_active === false || isResigned(emp.date_of_resign))) return;
    const role = emp?.role ?? 'Technician';
    const cat  = roleCategory(role, roles);
    const empCompany    = emp?.company_name ?? '';
    const empSupervisor = emp?.supervisor_epf ?? null;
    // Technicians are the only pickable subjects. Executives are included too so they're
    // searchable, but flagged unpickable — visible per company/supervisor scope.
    // Pick-only team leaders are further limited to technicians that can't themselves lead a team
    // (resolved with the target's employee_type — a trainee Team Leader is pickable, a permanent
    // one is not); executives/admins can pick any technician.
    const pickable = cat === 'technician' && canPickMember(role, emp?.employee_type);
    const execVisible = (execSeeAll && sameCompany(empCompany))
      || String(empSupervisor ?? '') === String(supervisorEpf)
      || (execSubordinateRoles.has(role) && sameCompany(empCompany));
    sessionsOf(a).forEach((s: any) => {
      if (!s.check_in) return;
      // Past submissions are backfilled after the fact — never a live "pick to my team" target.
      if (s.is_past_submission) return;
      // Same routing as the approval list: a technician at a place that HAS a location supervisor
      // is claimable only by that supervisor (or an admin); elsewhere by any executive picker.
      // Shift-place check-ins are claimable only by the employee's assigned supervisor, management
      // and the place's location supervisors, so picking can't approve a shift attendance from outside.
      const shiftVis = shiftRouteVisibility(
        sessionAtPlace(s, shiftPlaceKeys), empSupervisor, supervisorEpf, systemWide, sessionAtPlace(s, viewerShiftPlaceKeys));
      let visible: boolean;
      if (shiftVis !== null) {
        visible = shiftVis;
      } else if (pickable) {
        const siteId = s.check_in_site_id ? String(s.check_in_site_id) : null;
        visible = siteId && supervisedPlaceIds.has(siteId)
          ? (systemWide || viewerLocationIds.has(siteId))
          : (canPickTech || systemWide);
      } else {
        visible = execVisible;
      }
      if (!visible) return;
      rows.push({
        docId:            d.id,
        sessionId:        s.id,
        epf_number:       aEpf,
        name:             emp?.display_name ?? aEpf,
        role,
        pickable,
        check_in:         tsToStr(s.check_in),
        check_in_lat:     s.check_in_lat ?? null,
        check_in_lng:     s.check_in_lng ?? null,
        site_name:        s.check_in_site_name ?? null,
        site_distance_m:  s.check_in_site_distance_m ?? null,
        check_in_status:  s.check_in_status ?? 'pending',
        check_out:        tsToStr(s.check_out),
        check_out_status: s.check_out ? (s.check_out_status ?? 'pending') : null,
        check_in_approved_by: s.check_in_approved_by ?? null,
        morning_allowance: s.picked_by ? (s.morning_allowance ?? 0) : calcMorningAllowanceFromTs(s.check_in),
        phone:            emp?.phone_personal || emp?.phone_office || null,
        picked_by:        s.picked_by ?? null,
        picked_by_name:   s.picked_by_name ?? null,
        picked_at:        tsToStr(s.picked_at),
        team_leader_epf:  s.team_leader_epf ?? null,
        team_leader_name: s.team_leader_name ?? null,
      });
    });
  });
  return rows;
}

// Cascade check-in approval to a team leader's team: approve every pending session that was
// picked_by one of `leaderEpfs`, stamping the approver so the checkout later routes to them.
// Runs as best-effort doc updates (not one atomic transaction) across the day's attendances.
async function cascadeApproveTeam(leaderEpfs: Set<string>, approverEpf: string, dateStr: string) {
  if (!leaderEpfs || leaderEpfs.size === 0 || !dateStr) return;
  const snap = await getDocs(query(collection(db, 'attendances'), where('date', '==', dateStr)));
  const writes: Promise<any>[] = [];
  snap.docs.forEach(d => {
    const sessions = sessionsOf(d.data());
    let changed = false;
    const updated = sessions.map((s: any) => {
      if (s.check_in && s.check_in_status !== 'approved'
          && s.picked_by && leaderEpfs.has(String(s.picked_by))) {
        changed = true;
        return { ...s, check_in_status: 'approved', check_in_approved_by: approverEpf };
      }
      return s;
    });
    if (changed) writes.push(updateDoc(doc(db, 'attendances', d.id), { sessions: updated, updated_at: FSTimestamp.now() }));
  });
  await Promise.all(writes);
}

// Claim a team leader's whole team for a new picker: every session picked_by one of `leaderEpfs`
// is REASSIGNED to `newPickerEpf` (its check-out then routes to them) and approved. Used when an
// approver picks a team leader — picking the leader picks their entire team onto the approver.
async function cascadePickTeam(leaderEpfs: Set<string>, newPickerEpf: string, newPickerName: string | null, dateStr: string) {
  if (!leaderEpfs || leaderEpfs.size === 0 || !dateStr) return;
  const snap = await getDocs(query(collection(db, 'attendances'), where('date', '==', dateStr)));
  const writes: Promise<any>[] = [];
  snap.docs.forEach(d => {
    const sessions = sessionsOf(d.data());
    let changed = false;
    const updated = sessions.map((s: any) => {
      if (s.check_in && s.picked_by && leaderEpfs.has(String(s.picked_by))
          && String(s.picked_by) !== newPickerEpf) {
        changed = true;
        return {
          ...s,
          picked_by:            newPickerEpf,
          picked_by_name:       newPickerName,
          // Remember the original team leader so "My team" can still show this member grouped
          // under them, even though the pick claim (and check-out routing) is now the approver's.
          team_leader_epf:      String(s.picked_by),
          team_leader_name:     s.picked_by_name ?? null,
          check_in_status:      'approved',
          check_in_approved_by: newPickerEpf,
        };
      }
      return s;
    });
    if (changed) writes.push(updateDoc(doc(db, 'attendances', d.id), { sessions: updated, updated_at: FSTimestamp.now() }));
  });
  await Promise.all(writes);
}

export const attendanceApi = {
  // Pages unpack: outer?.today_attendance ?? outer
  getMyTodayAttendance: async (epfNumber: string, knownUser?: any) => {
    const todayStr = today();
    const id   = attDocId(epfNumber, todayStr);

    // The today-attendance read is independent of the user/shift checks → start it NOW so it
    // runs in parallel with the user read + shift-day check (these were serial, which doubled
    // the hero's latency on a cold connection).
    const todayDocP = getDoc(doc(db, 'attendances', id));

    // uDoc (the persistent shift-worker flag + role) is needed to resolve the shift day and to
    // surface an overnight session that began on a shift day — a capability that outlives the
    // roster's last day. Reuse the caller's auth-store user when supplied to avoid a re-read.
    let uDoc: any = knownUser ?? null;
    if (!uDoc) {
      const uSnap = await getDoc(doc(db, 'users', epfDocId(epfNumber)));
      uDoc = uSnap.exists() ? uSnap.data() : {};
    }

    // "Shift day" reflects a rostered shift period covering today OR (for a technician with no
    // roster) checking in at a 'shift'-tagged place today. Deliberately NOT driven by the
    // persistent is_shift_worker flag — that flag is an overnight-checkout *capability*, and
    // using it here kept the badge on forever after a roster ended.
    // Resolve the today-doc read and the shift-day check together (they don't depend on each other).
    const [snap, isShiftDay] = await Promise.all([
      todayDocP,
      isShiftDayOn(uDoc, epfNumber, todayStr),
    ]);
    let a        = snap.exists() ? snap.data() : null;
    let sessions = a ? sessionsOf(a) : [];

    // Overnight: a shift session may have started yesterday — surface it so it can be
    // checked out today (only when yesterday was a shift day).
    if (!openSessionOf(sessions)) {
      const shiftPrev = await isShiftWorkerOn(uDoc, epfNumber, prevDayStr(todayStr));
      if (shiftPrev) {
        const ySnap = await getDoc(doc(db, 'attendances', attDocId(epfNumber, prevDayStr(todayStr))));
        if (ySnap.exists()) {
          const yOpen = openSessionOf(sessionsOf(ySnap.data()));
          if (yOpen) {
            a = a ?? { epf_number: epfNumber, date: todayStr };
            sessions = [...sessions, { ...yOpen, _overnight: true }];
          }
        }
      }
    }

    if (!a) {
      const empty = { today_attendance: null, is_shift_day: isShiftDay };
      return { data: { data: empty, ...empty } };
    }
    const att = buildAttPayload(id, a, sessions);
    att.is_shift_day = isShiftDay;
    return { data: { data: { today_attendance: att, is_shift_day: isShiftDay }, today_attendance: att, is_shift_day: isShiftDay, ...att } };
  },

  // Pages unpack: res.data?.data ?? res.data
  getAttendanceByDate: async (epfNumber: string, date: string) => {
    const id   = attDocId(epfNumber, date);
    const snap = await getDoc(doc(db, 'attendances', id));
    if (!snap.exists()) return { data: { data: null } };
    const a   = snap.data();
    const att = buildAttPayload(id, a, sessionsOf(a));
    return { data: { data: att, ...att } };
  },

  // Pages unpack: inner?.attendance_dates ?? []  (array of date strings)
  getMonthlyAttendanceDates: async (epfNumber: string, month?: number, year?: number) => {
    const now    = new Date();
    const y      = year  ?? now.getFullYear();
    const m      = month ?? now.getMonth() + 1;
    // Build all possible doc IDs for this month and fetch them in parallel
    // This avoids needing a composite index entirely — doc ID is epf_date
    const prefix = `${y}-${String(m).padStart(2, '0')}`;
    const daysInMonth = new Date(y, m, 0).getDate();
    // Doc id encodes the EPF (epfDocId escapes "/" → %2F); using the raw EPF here built an
    // invalid path for slash-EPFs, so the calendar showed no attendance for those users.
    const epfId = epfDocId(epfNumber);
    const docIds = Array.from({ length: daysInMonth }, (_, i) => {
      const d = String(i + 1).padStart(2, '0');
      return `${epfId}_${prefix}-${d}`;
    });

    // One parallel batch of known doc-ID reads → a single round trip (was 3–4).
    const results: string[] = [];
    const missing_checkout: string[] = [];
    const dates_hours: Record<string, number> = {};
    // allSettled, NOT all: these are 31 INDEPENDENT doc reads, so one transient failure (a flaky
    // connection, one poisoned persistent-cache entry) must cost that single DAY, not the whole
    // month. Promise.all rejected the entire batch, and the calendar then rendered exactly as if
    // nothing had been worked all month. A wholly failed month still surfaces: every read
    // rejects, `results` stays empty, and the caller's error branch shows its banner.
    const settled = await Promise.allSettled(docIds.map(id => getDoc(doc(db, 'attendances', id))));
    const failed = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    // Every read failing is an outage, not an empty month — rethrow so the caller can say so
    // rather than quietly drawing a blank calendar the user would read as "I worked nothing".
    if (failed.length === docIds.length && docIds.length > 0) throw failed[0].reason;
    if (failed.length) {
      console.warn(
        `[attendance] ${failed.length}/${docIds.length} day reads failed for ${prefix} — showing the rest.`,
        failed[0].reason,
      );
    }
    const snaps = settled.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
    snaps.forEach(snap => {
      if (snap.exists() && !snap.data().is_deleted && sessionsOf(snap.data()).some(s => s.check_in)) {
        const a = snap.data();
        const dateStr = a.date as string;
        results.push(dateStr);

        const sess = sessionsOf(a);
        // "Missing checkout": a session was checked in but never checked out.
        if (sess.some((s: any) => s.check_in && !s.check_out)) missing_checkout.push(dateStr);

        let durationMs = 0;
        sess.forEach((s: any) => {
          if (s.check_in && s.check_out) {
            const inDate = s.check_in.toDate ? s.check_in.toDate() : new Date(s.check_in);
            const outDate = s.check_out.toDate ? s.check_out.toDate() : new Date(s.check_out);
            durationMs += Math.max(0, outDate.getTime() - inDate.getTime());
          }
        });
        const hours = durationMs / (1000 * 60 * 60);
        dates_hours[dateStr] = Number(hours.toFixed(1));
      }
    });

    const attendance_dates = results.sort();
    const working_days     = attendance_dates.length;
    return { data: { data: { attendance_dates, working_days, count: working_days, dates_hours, missing_checkout_dates: missing_checkout.sort() } } };
  },

  getWorkingDays: async (epfNumber: string) =>
    attendanceApi.getMonthlyAttendanceDates(epfNumber),

  checkIn: async (data: any) => {
    const date    = data.check_in_time.slice(0, 10);
    const id      = attDocId(data.epf_number, date);
    const now     = FSTimestamp.now();
    const ref     = doc(db, 'attendances', id);

    // Independent reads in ONE parallel batch instead of four sequential round trips
    // (roles + working places are cached, so those two are usually instant). The attendance
    // doc itself is deliberately NOT read here — it's re-read INSIDE the transaction below,
    // right before the write, so two near-simultaneous check-in taps (a double-tap, a flaky
    // network retry, two devices) can't both pass the "not already checked in" check before
    // either commits: Firestore aborts and retries the loser against the just-committed
    // state, so the second one correctly throws "already checked in" instead of creating a
    // duplicate session row.
    const [userSnap, roles, places] = await Promise.all([
      getDoc(doc(db, 'users', epfDocId(data.epf_number))),
      getRoles(),
      getWorkingPlaces().catch(() => [] as any[]),
    ]);
    const u = userSnap.exists() ? userSnap.data() : {};

    // Top-management roles self-approve their own attendance; everyone else needs approval
    // iff they have an approver tier above them. Whoever approves a check-in "claims" the
    // session's checkout — and a check-in nobody approved by hand leaves check_in_approved_by
    // null on purpose, which is what keeps that claim open to the session's NORMAL routing
    // (see claimedByMe in getCheckinApprovalList). Stamping a sentinel there instead would
    // narrow a pending check-out to admins and the place's own supervisors, i.e. strand it.
    //
    // On top of the role rule, a tenant may auto-approve a check-in that landed inside a
    // working place's radius (TenantFeatures.autoApproveInRangeCheckIn, resolved just below).
    // Southern Lanka does not: there, this mobile channel needs approval exactly as before,
    // and only the FINGERPRINT channel (fingerprintApi.ts) auto-approves.
    const caps         = resolveUserCapabilities(u, roles);
    const isSouthernlanka = tenant.id === 'southernlanka';
    const roleNeedsApproval = roleCategory(u.role, roles) !== 'top_management'
                           && roleParentName(u.role, roles) !== null;

    // Match the check-in GPS to the nearest configured working place whose own radius
    // contains it. Best-effort: never blocks check-in (recorded for pickers/approvers).
    let site: { id: string; name: string; distance: number } | null = null;
    // And, separately, the STRICT question: is the GPS inside a place's own radius? `site`
    // above is a 1 km proximity label for approvers — far too loose to approve anything with,
    // since a kilometre covers a town centre. Left null when it cannot be answered at all (no
    // GPS fix, or not one place has coordinates); the policy sends those to a person.
    let withinRadius: boolean | null = null;
    if (data.check_in_lat != null && data.check_in_lng != null) {
      try {
        site = nearestWorkingPlace(data.check_in_lat, data.check_in_lng, places, 1000);
      } catch { /* non-critical — leave site unmatched */ }
      try {
        const geoPlaces = (places as any[]).filter(pl => pl?.latitude != null && pl?.longitude != null);
        if (geoPlaces.length > 0) {
          withinRadius = matchWithinRadius(data.check_in_lat, data.check_in_lng, geoPlaces) !== null;
        }
      } catch { /* non-critical — leave the question unanswered */ }
    }

    // A check-in that proved its own location needs no approver, where the tenant asked for
    // that (src/lib/checkInApprovalPolicy.ts). The CHECK-OUT is never auto-approved anywhere:
    // it is the half that settles the working place, the hours and the allowances.
    const needsApproval = checkInNeedsApproval({
      roleNeedsApproval,
      autoApproveInRange: tenant.features.autoApproveInRangeCheckIn,
      withinPlaceRadius: withinRadius,
    });

    const session = emptySession(
      data.check_in_time, needsApproval,
      { lat: data.check_in_lat ?? null, lng: data.check_in_lng ?? null, accuracy: data.check_in_accuracy_m ?? null },
      site,
      withinRadius,
    );
    // An approver's Approve action is what normally derives the morning food allowance from
    // the check-in time. A check-in the SYSTEM approved never passes one, and this session
    // never surfaces in an approval list again, so it would sit at 0 for good — derive it
    // here instead, from the same rule and the same timestamp an approver would have used.
    // Scoped to the geofence path on purpose: top-management self-approval has always left it
    // at 0, and changing that would hand executives on every tenant an allowance nobody granted.
    if (roleNeedsApproval && !needsApproval) {
      session.morning_allowance = calcMorningAllowanceFromTs(session.check_in);
    }
    // ── Inline self-healing guard (Southern Lanka shift workers) ──────────────────────────────
    // Mirrors src/lib/fingerprintApi.processAttendanceEvent: an open session whose scheduled
    // shift end is already more than the grace window in the past is a previous shift that was
    // never punched out — close it at its scheduled end and let THIS check-in proceed for the
    // new shift, instead of blocking with "already checked in". Still within grace → real
    // overlap, still blocked. No roster row for the open session's day → left alone.
    const prevDate = prevDayStr(date);
    const prevRef  = doc(db, 'attendances', attDocId(data.epf_number, prevDate));
    const selfHealEligible = isSouthernlanka
      && (!!u.is_shift_worker || await isShiftWorkerOn(u, data.epf_number, prevDate));
    const healRelevant = new Set([date, prevDate, prevDayStr(prevDate)]);
    const assignments: ShiftWindow[] = selfHealEligible
      ? (await shiftAssignmentsFor(data.epf_number)).filter(a => healRelevant.has(a.date))
      : [];

    type HealPlan = {
      targetRef: typeof ref; onToday: boolean; sessions: any[];
      date: string; sessionId: string; scheduledEndMs: number; gapHours: number;
    };

    const heal = await runTransaction(db, async (tx): Promise<HealPlan | null> => {
      const snap = await tx.get(ref);
      const existing = snap.exists() ? snap.data() : null;
      const sessions = existing ? sessionsOf(existing) : [];

      // Overnight sessions live under their START day — read yesterday's doc too when eligible.
      let prevSessions: any[] = [];
      if (selfHealEligible) {
        const prevSnap = await tx.get(prevRef);
        prevSessions = prevSnap.exists() ? sessionsOf(prevSnap.data()) : [];
      }

      const openTodayIdx = sessions.findIndex((s: any) => s.check_in && !s.check_out);
      const openPrevIdx  = prevSessions.findIndex((s: any) => s.check_in && !s.check_out);

      // Try to auto-close a stale open session; returns the plan when it fired.
      const planFor = (openSessions: any[], idx: number, target: typeof ref, targetDate: string, onToday: boolean): HealPlan | null => {
        if (idx === -1 || !assignments.length) return null;
        const s = openSessions[idx];
        const inMs = s.check_in?.toMillis?.() ?? null;
        if (inMs == null) return null;
        const chosen = pickAssignmentForOpenSession(assignments, inMs, deviceLocalMs);
        if (!chosen) return null;
        const scheduledEndMs = scheduledShiftEndMs(chosen, deviceLocalMs);
        if (!isPastGrace(inMs, scheduledEndMs, Date.now())) return null;
        return {
          targetRef: target, onToday,
          sessions: closeSessionSystemAutoLocal(openSessions, idx, scheduledEndMs),
          date: targetDate,
          sessionId: String(s.id ?? `s${idx}`),
          scheduledEndMs,
          gapHours: autoCloseGapHours(scheduledEndMs, Date.now()),
        };
      };

      const healPlan =
        planFor(sessions, openTodayIdx, ref, date, true) ??
        planFor(prevSessions, openPrevIdx, prevRef, prevDate, false);

      // Block only on an open session we could NOT auto-close (a real overlap).
      const stillOpenToday = openTodayIdx !== -1 && !(healPlan && healPlan.onToday);
      const stillOpenPrev  = openPrevIdx  !== -1 && !(healPlan && !healPlan.onToday);
      if (stillOpenToday || stillOpenPrev) {
        throw new Error('You are already checked in. Please check out first.');
      }
      if (!caps.multi_session && sessions.length >= 1) {
        throw new Error('Attendance is already recorded for today.');
      }

      // Deferred writes. When the self-heal was on TODAY's doc, fold the new session into the
      // healed array so it's a single write.
      if (healPlan && !healPlan.onToday) {
        tx.update(healPlan.targetRef, { sessions: healPlan.sessions, updated_at: now });
      }
      if (existing) {
        const base = healPlan?.onToday ? healPlan.sessions : sessions;
        tx.update(ref, { sessions: [...base, session], updated_at: now });
      } else {
        tx.set(ref, {
          id,
          epf_number:   data.epf_number,
          company_id:   u.company_id ?? '',
          company_name: u.company_name ?? '',
          date,
          sessions:     [session],
          request_from: [],
          is_past_submission: false,
          created_at:   now,
          updated_at:   now,
        });
      }
      return healPlan;
    });

    // Post-commit: prompt the employee to file an OT request for the auto-closed shift.
    if (heal && isSouthernlanka) {
      await createAppNotification({
        toEpf: data.epf_number,
        type:  'reminder',
        title: 'Shift auto-closed',
        body:  `Your ${heal.date} shift was closed automatically at its scheduled end. If you worked continuous extra hours, tap to submit an OT request.`,
        link:  `/ot-requests?prefillDate=${heal.date}${heal.gapHours > 0 ? `&prefillHours=${heal.gapHours}` : ''}`,
        meta:  { auto_checkout: '1', date: heal.date },
      }).catch(() => { /* notification is best-effort */ });
    }
    return { data: { status: 'Request was successful.' } };
  },

  checkOut: async (data: any) => {
    const date     = data.check_out_time.slice(0, 10);
    // Independent reads in ONE parallel batch (roles + working places are cached → instant).
    const [userSnap, roles, places] = await Promise.all([
      getDoc(doc(db, 'users', epfDocId(data.epf_number))),
      getRoles(),
      getWorkingPlaces().catch(() => [] as any[]),
    ]);
    const u      = userSnap.exists() ? userSnap.data() : {};
    const isTech = roleCategory(u.role, roles) === 'technician';
    const isSouthernlanka = tenant.id === 'southernlanka';

    // "Released everyone you picked?" guard. Only roles that CAN pick technicians could be
    // holding any, so run this whole-day attendance scan ONLY for them — technicians (the
    // common check-out) skip reading every employee's attendance for the day entirely. Pick is
    // disabled for Southern Lanka (see pickTechnician), so this is always a no-op there.
    if (!isSouthernlanka && canPickTechnicians(u.role, roles)) {
      const snapPicked = await getDocs(query(collection(db, 'attendances'), where('date', '==', date)));
      let pickedCount = 0;
      snapPicked.docs.forEach(docSnap => {
        sessionsOf(docSnap.data()).forEach(s => {
          if (s.picked_by && String(s.picked_by) === String(data.epf_number)) pickedCount++;
        });
      });
      if (pickedCount > 0) {
        throw new Error(`Cannot check out because you still have ${pickedCount} technician(s) picked on your team. Please release them first on the Approvals page.`);
      }
    }

    // Radius check: distance from the check-out GPS to the SELECTED working place, and
    // whether it's inside that place's radius. Recorded only (never blocks check-out).
    let coDist: number | null = null;
    let coWithin: boolean | null = null;
    if (data.check_out_lat != null && data.check_out_lng != null && data.working_place) {
      const place = places.find((p: any) => p.name === data.working_place) ?? null;
      const dp    = distanceToPlace(data.check_out_lat, data.check_out_lng, place);
      if (dp) { coDist = dp.distance; coWithin = dp.within; }
    }

    // Effective check-out location for the outstation check: the SELECTED working place's
    // coordinates drive it (so changing the working place recalculates), falling back to the
    // device GPS only when that place has no coordinates (e.g. an unmapped Solar site).
    let coLat: number | null = null;
    let coLng: number | null = null;
    if (data.working_place) {
      const picked = places.find((p: any) => p.name === data.working_place && p.latitude != null && p.longitude != null);
      if (picked) { coLat = picked.latitude; coLng = picked.longitude; }
    }
    if (coLat == null || coLng == null) {
      coLat = data.check_out_lat ?? null;
      coLng = data.check_out_lng ?? null;
    }

    // Reference working place for a given session-start day `d`: the place scheduled for that
    // exact day, else the nearest saved working place to the check-out location. The check-out
    // outstation flag is derived from the distance to this reference.
    const refPlaceForDay = async (d: string): Promise<any | null> => {
      if (coLat == null || coLng == null) return null;
      return outstationReferenceFor(data.epf_number, d, coLat, coLng, places);
    };

    // The open session is normally in today's doc; for shift days it may have started
    // the previous day (overnight) — the record stays under its start day.
    const [shiftToday, shiftPrev] = await Promise.all([
      isShiftWorkerOn(u, data.epf_number, date),
      isShiftWorkerOn(u, data.epf_number, prevDayStr(date)),
    ]);
    const onShift = shiftToday || shiftPrev;
    const candidates = onShift ? [date, prevDayStr(date)] : [date];
    for (const d of candidates) {
      const ref  = doc(db, 'attendances', attDocId(data.epf_number, d));
      const snap = await getDoc(ref);
      if (!snap.exists()) continue;
      const sessions = sessionsOf(snap.data());
      const idx = sessions.findIndex(s => s.check_in && !s.check_out);
      if (idx === -1) continue;

      // Outstation is no longer self-declared. For a technician it's auto-derived: the check-out
      // location (device GPS, or the picked working place when GPS is unavailable) more than 60km
      // from the day's assigned (or primary) working place → outstation. The approver can still
      // override the flag at approval. No outstation name/address collected.
      let isOutstation = isTech ? false : !!data.is_outstation;
      let refDist: number | null = null;
      let refPlaceName: string | null = null;
      if (isTech && coLat != null && coLng != null) {
        const refPlace = await refPlaceForDay(d);
        refPlaceName = refPlace?.name ?? null;
        if (refPlace) {
          refDist = Math.round(distanceMeters(coLat, coLng, refPlace.latitude, refPlace.longitude));
          isOutstation = refDist > OUTSTATION_DISTANCE_M;
        }
      } else if (!isTech) {
        // Executives: outstation when their PHYSICAL location (device GPS) is >60km from the
        // NEAREST of { their home, the primary working places }. Home is read from the exec's OWN
        // user doc in their OWN browser and is NEVER written to the record — only the resulting
        // flag is — so home coordinates stay private to the executive.
        const physLat = data.check_out_lat ?? coLat;
        const physLng = data.check_out_lng ?? coLng;
        if (physLat != null && physLng != null) {
          const refs: Array<{ lat: number; lng: number; name: string }> = [];
          if (u.home_lat != null && u.home_lng != null) refs.push({ lat: u.home_lat, lng: u.home_lng, name: 'home' });
          places.forEach((p: any) => {
            if ((p.tags ?? []).includes('primary') && p.latitude != null && p.longitude != null) {
              refs.push({ lat: p.latitude, lng: p.longitude, name: p.name });
            }
          });
          if (refs.length > 0) {
            let best = refs[0], bestD = distanceMeters(physLat, physLng, best.lat, best.lng);
            for (const r of refs.slice(1)) {
              const dd = distanceMeters(physLat, physLng, r.lat, r.lng);
              if (dd < bestD) { bestD = dd; best = r; }
            }
            refDist = Math.round(bestD);
            refPlaceName = best.name;
            isOutstation = bestD > OUTSTATION_DISTANCE_M;
          }
        }
      }
      // Human-readable reason (surfaced to the employee as a toast, and logged) so it's obvious
      // why outstation did or didn't fire — no DevTools needed. Non-technicians never have an
      // outstation auto-check, so there's nothing useful to tell them → null (no toast for execs).
      const outstationReason =
        refDist != null ? `${(refDist / 1000).toFixed(1)} km from ${refPlaceName} — ${isOutstation ? 'flagged as OUTSTATION (over 60 km)' : 'within 60 km, not outstation'}.`
        : !isTech ? null
        : coLat == null ? 'Outstation not calculated: no location — GPS was unavailable and the picked working place has no coordinates.'
        : "Outstation not calculated: no reference place with GPS coordinates. Set coordinates on today's scheduled place (or tag a working place 'Primary' and give it coordinates).";
      console.log('[outstation]', outstationReason, { isTech, coLat, coLng, refPlaceName, refDist, isOutstation });

      const updated = sessions.map((s, i) => i === idx ? {
        ...s,
        check_out:          localStrToTimestamp(data.check_out_time),
        check_out_lat:      data.check_out_lat ?? null,   // employee device GPS at check-out
        check_out_lng:      data.check_out_lng ?? null,
        check_out_accuracy_m: data.check_out_accuracy_m ?? null,
        check_out_site_distance_m: coDist,                // distance to the selected place
        check_out_within_radius:   coWithin,              // inside that place's radius?
        working_place:      data.working_place,
        site_number:        data.site_number ?? null,
        // The picked place joins the session's location history (dedup by name+site).
        locations:          appendLocation(s.locations, {
                              name: data.working_place, site_number: data.site_number ?? null,
                              lat: data.check_out_lat ?? null, lng: data.check_out_lng ?? null,
                              accuracy_m: data.check_out_accuracy_m ?? null, source: 'check_out',
                            }),
        is_outstation:      isOutstation,                 // auto (>60km): technicians vs place, execs vs home/primary
        is_outstation_auto: refDist != null,              // flagged by the distance rule
        outstation_ref_distance_m: refDist,               // distance to the day's place (m)
        outstation_name:    null,                         // name/address no longer collected
        outstation_address: null,
        // Mobile check-outs need manual approval for every tenant, Southern Lanka included —
        // the approver sets is_outstation_approved/allowance themselves (approveCheckOut).
        check_out_status:   'pending',
      } : s);
      await updateDoc(ref, { sessions: updated, updated_at: FSTimestamp.now() });
      return { data: { status: 'Request was successful.', outstation_reason: outstationReason, is_outstation: isOutstation } };
    }
    throw new Error('No open session to check out.');
  },

  // Add a location to ONE session (the day modal's "Update location" button). The place is
  // APPENDED to the session's `locations[]` history and becomes the primary `working_place`
  // mirror — times, the GPS audit points and approval state stay untouched. Derivations
  // mirror checkOut: distance / in-range vs the newly selected place is measured from the
  // session's stored check-out GPS (the fresh device fix captured by the form is only a
  // fallback), and the outstation flag follows the place for technicians (same rule as
  // edit-request approval).
  updateSessionLocation: async (data: {
    epf_number: string; date: string; session_id?: string | null;
    working_place: string; site_number?: string | null;
    gps_lat?: number | null; gps_lng?: number | null;
  }) => {
    let ref  = doc(db, 'attendances', attDocId(data.epf_number, data.date));
    let snap = await getDoc(ref);
    let sessions = snap.exists() ? sessionsOf(snap.data()) : [];
    let byId = data.session_id ? sessions.findIndex(s => s.id === data.session_id) : -1;
    // Overnight shift sessions live under their START day — when the target session isn't
    // in this date's doc, look in the previous day's (mirrors checkOut's candidates).
    if (data.session_id && byId === -1) {
      const prevRef  = doc(db, 'attendances', attDocId(data.epf_number, prevDayStr(data.date)));
      const prevSnap = await getDoc(prevRef);
      if (prevSnap.exists()) {
        const prevSessions = sessionsOf(prevSnap.data());
        const pIdx = prevSessions.findIndex(s => s.id === data.session_id);
        if (pIdx >= 0) { ref = prevRef; snap = prevSnap; sessions = prevSessions; byId = pIdx; }
      }
    }
    if (!snap.exists()) throw new Error('Attendance record not found.');
    if (!sessions.length) throw new Error('No session to update.');
    const idx = byId >= 0 ? byId : sessions.length - 1;    // fallback: latest session
    // Outstation/date-sensitive derivations use the record's own day (may be the prev day).
    const recDate = String(snap.data()?.date ?? data.date);

    let places: any[] = [];
    try { places = await getWorkingPlaces(); } catch { places = []; }

    const patch: any = {
      working_place: data.working_place,
      site_number:   data.site_number ?? null,
      locations:     appendLocation(sessions[idx].locations, {
        name: data.working_place, site_number: data.site_number ?? null,
        lat: data.gps_lat ?? null, lng: data.gps_lng ?? null,
        source: 'manual', added_by: data.epf_number,
      }),
    };

    const gLat  = sessions[idx].check_out_lat ?? data.gps_lat ?? null;
    const gLng  = sessions[idx].check_out_lng ?? data.gps_lng ?? null;
    const place = places.find((p: any) => p.name === data.working_place) ?? null;
    const dp    = distanceToPlace(gLat, gLng, place);
    patch.check_out_site_distance_m = dp?.distance ?? null;
    patch.check_out_within_radius   = dp?.within ?? null;

    let isTech = true;
    try {
      const roles = await getRoles();
      const uSnap = await getDoc(doc(db, 'users', epfDocId(data.epf_number)));
      isTech = roleCategory(uSnap.exists() ? uSnap.data().role : undefined, roles) === 'technician';
    } catch { /* assume technician */ }
    const autoRes = isTech ? await autoOutstationByPlace(data.epf_number, recDate, data.working_place, places) : null;
    if (autoRes != null) {
      patch.is_outstation      = autoRes;
      patch.is_outstation_auto = true;
      patch.outstation_name    = null;
      patch.outstation_address = null;
    }

    const updated = sessions.map((s, i) => i === idx ? { ...s, ...patch } : s);
    await updateDoc(ref, { sessions: updated, updated_at: FSTimestamp.now() });
    return { data: { status: 'Request was successful.' } };
  },

  submitPastAttendance: async (data: any) => {
    const id      = attDocId(data.epf_number, data.date);
    const now     = FSTimestamp.now();
    const userSnap = await getDoc(doc(db, 'users', epfDocId(data.epf_number)));
    const u        = userSnap.exists() ? userSnap.data() : {};
    const roles        = await getRoles();
    const caps         = resolveUserCapabilities(u, roles);
    // Past-submission (mobile channel) needs approval on every tenant, Southern Lanka included
    // — see the matching note on checkIn's `needsApproval` above. The in-range auto-approval
    // cannot reach here whatever the tenant flag says: a back-dated submission is typed in
    // after the fact and carries no check-in GPS, so there is no location to have proved.
    const needsApproval = roleParentName(u.role, roles) !== null;

    const ref      = doc(db, 'attendances', id);
    const snap     = await getDoc(ref);
    const existing = snap.exists() ? snap.data() : null;
    const sessions = existing ? sessionsOf(existing) : [];
    if (!caps.multi_session && sessions.length >= 1) {
      throw new Error('Attendance is already recorded for this day.');
    }

    // Outstation is auto-derived (technicians) from the working place vs that day's base —
    // no longer self-declared. The approver can still override it at approval.
    const isTech = roleCategory(u.role, roles) === 'technician';
    const autoRes = isTech ? await autoOutstationByPlace(data.epf_number, data.date, data.working_place) : null;
    const autoOutstation = isTech ? (autoRes ?? false) : !!data.is_outstation;

    // Past submissions may carry SEVERAL locations (the form's multi-add list); the
    // first stays the primary `working_place` mirror. Falls back to the single place.
    const extraLocs: Array<{ name: string; site_number?: string | null }> =
      Array.isArray(data.locations) && data.locations.length
        ? data.locations
        : [{ name: data.working_place, site_number: data.site_number ?? null }];
    let pastLocations: any[] = [];
    for (const l of extraLocs) {
      pastLocations = appendLocation(pastLocations, {
        name: l.name, site_number: l.site_number ?? null,
        source: 'manual', added_by: data.epf_number,
      });
    }

    const checkInTs  = localStrToTimestamp(data.check_in_time);
    const checkOutTs = localStrToTimestamp(data.check_out_time);
    const session = {
      id:                     newSessionId(),
      check_in:               checkInTs,
      check_out:              checkOutTs,
      // Overnight when the check-out date is later than the record's start day.
      _overnight:             (data.check_out_time?.slice(0, 10) ?? '') > data.date,
      working_place:          data.working_place,
      site_number:            data.site_number ?? null,
      locations:              pastLocations,
      is_outstation:          autoOutstation,
      is_outstation_auto:     isTech,
      outstation_location_id: null,
      outstation_name:        null,
      outstation_address:     null,
      is_outstation_approved: false,
      // Southern Lanka doesn't offer food allowance — left at 0 regardless of tenant.
      morning_allowance:      0,
      evening_allowance:      0,
      check_in_approved_by:   null,
      check_out_approved_by:  null,
      check_in_status:        needsApproval ? 'pending' : 'approved',
      check_out_status:       'pending',
      is_past_submission:     true,
      past_approved_by:       null,
    };

    if (existing) {
      await updateDoc(ref, { sessions: [...sessions, session], updated_at: now });
    } else {
      await setDoc(ref, {
        id,
        epf_number:   data.epf_number,
        company_id:   u.company_id ?? '',
        company_name: u.company_name ?? '',
        date:         data.date,
        sessions:     [session],
        request_from: [],
        is_past_submission: true,
        created_at:   now,
        updated_at:   now,
      });
    }
    return { data: { status: 'Request was successful.' } };
  },

  // Approvals page unpacks: d?.tech_count, d?.tech_list_type, d?.tech_list, d?.exe_list_type, d?.exe_list
  // ApprovalRecord.attendance_id is typed as number — we parse the string to int
  getCheckinApprovalList: async (supervisorEpf: string, company: string) => {
    // Roles, shift places ('shift' tag routes to the assigned/location supervisors) and the
    // epf→user map are independent — fetch concurrently.
    const [roles, shiftPlaceKeys, usersSnap, places] = await Promise.all([
      getRoles(),
      loadShiftPlaceKeys(),
      getUsersSnapshotCached(),
      getWorkingPlaces(false).catch(() => [] as any[]),
    ]);
    const userByEpf = new Map<string, any>();
    usersSnap.docs.forEach(d => { const u = d.data(); userByEpf.set(String(u.epf_number), u); });
    const viewerShiftPlaceKeys = viewerShiftPlaceKeysOf(places as any[], String(supervisorEpf));

    const viewer        = userByEpf.get(String(supervisorEpf));
    const viewerRole    = viewer?.role ?? '';
    const viewerCompany = viewer?.company_name ?? company ?? '';
    const viewerCaps    = resolveUserCapabilities(viewer, roles);
    const isManagement  = viewerCaps.is_system_admin || viewerCaps.can_manage_users || viewerCaps.can_manage_leaves;
    const isTopApprover = viewerCaps.can_approve && roleParentName(viewerRole, roles) === null;
    // Top-management-category approvers oversee everyone, any company (not just tree roots).
    const isTopMgmt     = viewerCaps.can_approve && roleCategory(viewerRole, roles) === 'top_management';
    const systemWide    = isManagement || isTopApprover || isTopMgmt;     // sees every company
    const canPickTech   = canPickTechnicians(viewerRole, roles);
    // Whether the viewer may pick a given target (per-target, employee_type-aware).
    const canPickMember = makeTechnicianPickPredicate(viewerRole, roles);

    // Executive company-supervisor? (listed in their company's supervisor_epfs) → sees all execs.
    let inCompanySupervisors = false;
    try {
      const compSnap = await getDocs(query(collection(db, 'companies'), where('name', '==', viewerCompany)));
      const supEpfs  = compSnap.docs[0]?.data()?.supervisor_epfs ?? [];
      inCompanySupervisors = Array.isArray(supEpfs) && supEpfs.map(String).includes(String(supervisorEpf));
    } catch { /* non-critical */ }
    const execSeeAll = systemWide || (roleCategory(viewerRole, roles) === 'executive' && inCompanySupervisors);

    const sameCompany = (empCompany: any) => systemWide || (empCompany ?? '') === viewerCompany;
    // Can the viewer see THIS person's pending check-in?
    //  • technician → only roles allowed to approve technicians, in the same company.
    //  • executive/top-mgmt → exec company-supervisors/management see all; otherwise only a
    //    direct supervisor of that person.
    const canSeeCheckIn = (empRole: string, empCompany: any, empSupervisor: any, empEmployeeType?: string) => {
      // Technicians can be approved by any executive approver; a pick-only team leader is limited to
      // technicians that can't themselves lead a team (employee_type-aware). System-wide viewers
      // (management / top management) see every technician unconditionally.
      if (roleCategory(empRole, roles) === 'technician') return systemWide || canPickMember(empRole, empEmployeeType);
      return (execSeeAll && sameCompany(empCompany)) || String(empSupervisor ?? '') === String(supervisorEpf);
    };

    const todayStr = today();
    const pending: Array<{
      attendance_id: number;
      epf_number: string;
      name: string;
      time: string | null;
      working_place: string | null;
      site_no: string | null;
      is_outstation: boolean;
      outstation_name: string | null;
      outstation_address: string | null;
      check_out_time: string | null;
      role: string;
      type: 'check_in' | 'check_out' | 'both';
    }> = [];

    // Ids are stable per (doc, session) — see stableId. A counter here let a late-resolving
    // call remap an id the Users panel was still holding onto to a different employee's session.
    const idMap: Record<number, { docId: string; sessionId: string }> = {};

    // Today's docs, plus yesterday's (to surface overnight checkouts that started
    // the previous day for shift workers).
    const [todaySnap, yestSnap] = await Promise.all([
      getDocs(query(collection(db, 'attendances'), where('date', '==', todayStr))),
      getDocs(query(collection(db, 'attendances'), where('date', '==', prevDayStr(todayStr)))),
    ]);

    const processDoc = (d: any, checkoutOnly: boolean) => {
      const a    = d.data();
      const aEpf = String(a.epf_number);
      const emp  = userByEpf.get(aEpf);
      if (emp && (emp.is_active === false || isResigned(emp.date_of_resign))) return;
      const role = emp?.role ?? 'Technician';
      const empCompany    = emp?.company_name ?? '';
      const empSupervisor = emp?.supervisor_epf ?? null;
      const daySessions = sessionsOf(a);

      daySessions.forEach((s, sIdx) => {
        // Past-submission sessions are handled exclusively by getPastAttendanceApprovalList.
        if (s.is_past_submission) return;
        // check-in pending → visible per the new rules (technician approvers / exec supervisors)
        // Shift-place attendance routes only to the employee's assigned supervisor, management
        // and the place's location supervisors; otherwise the usual technician/exec visibility applies. A restricted
        // session is hidden entirely — including its check-out via the "unclaimed" path below.
        const shiftVis = shiftRouteVisibility(
          sessionAtPlace(s, shiftPlaceKeys), empSupervisor, supervisorEpf, systemWide, sessionAtPlace(s, viewerShiftPlaceKeys));
        if (shiftVis === false) return;
        const canSee = shiftVis !== null
          ? shiftVis
          : canSeeCheckIn(role, empCompany, empSupervisor, emp?.employee_type);
        const checkInPending = !checkoutOnly && !!s.check_in && s.check_in_status === 'pending'
                             && canSee;
        // checkout → only after check-in approved; claimed by whoever approved the check-in
        const claimedByMe    = systemWide || !s.check_in_approved_by
                             || String(s.check_in_approved_by) === String(supervisorEpf);
        const hasPendingCheckout = !!s.check_out && s.check_out_status === 'pending';
        // checkout alone: check-in already approved (claimed by me), only the checkout is pending
        const checkOutOnly = !checkInPending && hasPendingCheckout && claimedByMe;
        // both pending on the same session → surface together so they approve in one action
        const both = checkInPending && hasPendingCheckout;
        if (!checkInPending && !checkOutOnly) return;

        const type = both ? 'both' : checkInPending ? 'check_in' : 'check_out';
        const showCheckout = type !== 'check_in';   // 'both' and 'check_out' expose checkout details
        const aid = stableId(d.id, s.id);
        idMap[aid] = { docId: d.id, sessionId: s.id };
        pending.push({
          attendance_id:      aid,
          epf_number:         aEpf,
          name:               emp?.display_name ?? aEpf,
          time:               type === 'check_out' ? tsToStr(s.check_out) : tsToStr(s.check_in),
          check_out_time:     showCheckout ? tsToStr(s.check_out) : null,
          working_place:      showCheckout ? wfhLabel(s.working_place, emp?.display_name ?? aEpf) : null,
          site_no:            showCheckout ? (s.site_number ?? null) : null,
          is_outstation:      showCheckout ? !!s.is_outstation : false,
          is_outstation_auto: showCheckout ? !!s.is_outstation_auto : false,
          outstation_ref_distance_m: showCheckout ? (s.outstation_ref_distance_m ?? null) : null,
          outstation_name:    showCheckout ? (s.outstation_name ?? null) : null,
          outstation_address: showCheckout ? (s.outstation_address ?? null) : null,
          check_in_site_name: s.check_in_site_name ?? null,   // matched check-in location
          // Captured GPS (for the approver's location maps).
          check_in_lat:       s.check_in_lat ?? null,
          check_in_lng:       s.check_in_lng ?? null,
          check_out_lat:      showCheckout ? (s.check_out_lat ?? null) : null,
          check_out_lng:      showCheckout ? (s.check_out_lng ?? null) : null,
          check_out_within_radius: showCheckout ? (s.check_out_within_radius ?? null) : null,
          picked_by_name:     s.picked_by_name ?? null,
          picked_by:          s.picked_by ?? null,
          picked_at:          s.picked_at ? tsToStr(s.picked_at) : null,
          role,
          type,
          session_no:         sIdx + 1,
          session_count:      daySessions.length,
          is_shift_worker:    !!emp?.is_shift_worker,
          date:               a.date,   // the record's day (start day for overnight shifts)
        });
      });
    };

    todaySnap.docs.forEach(d => processDoc(d, false));
    yestSnap.docs.forEach(d => processDoc(d, true)); // overnight checkouts only

    // Store {docId, sessionId} lookup globally so approve calls can target the session.
    // MERGE — replacing would wipe the past/backlog list's entries and turn those approvals
    // into silent no-ops.
    if (typeof window !== 'undefined') {
      const w = window as Window & { __attIdMap?: Record<number, { docId: string; sessionId: string }> };
      w.__attIdMap = { ...(w.__attIdMap ?? {}), ...idMap };
    }

    // "Staff" bucket = technician category (Technicians + Team Leaders); "Executives"
    // bucket = everyone else (executive + top management).
    const techList = pending.filter(r => roleCategory(r.role, roles) === 'technician');
    // Executives never approve their OWN attendance — drop the viewer's own record from the
    // exec list. It stays visible to their approver (a different supervisorEpf).
    const exeList  = pending.filter(r => roleCategory(r.role, roles) !== 'technician'
      && String(r.epf_number) !== String(supervisorEpf));
    const techType = techList.length > 0 ? techList[0].type : 'check_in';
    const exeType  = exeList.length  > 0 ? exeList[0].type  : 'check_in';
    // true if the viewer can approve technicians AND any technician exists in their scope — or a
    // shift-place technician has actually routed to them (so a plain assigned supervisor sees it).
    const hasTechnicians = techList.length > 0
      || (canPickTech && Array.from(userByEpf.values()).some(u =>
        u.is_active !== false && roleCategory(u.role, roles) === 'technician'));
    // true if the viewer may approve executives at all (company-supervisor/management, OR a
    // direct supervisor of any executive-type employee). Drives the Executive tab visibility.
    const canSeeExecs = execSeeAll || Array.from(userByEpf.values()).some(u =>
      u.is_active !== false && roleCategory(u.role, roles) !== 'technician'
      && String(u.supervisor_epf ?? '') === String(supervisorEpf));

    const result = {
      tech_count:      techList.length,
      tech_list_type:  techType,
      tech_list:       techList,
      exe_list_type:   exeType,
      exe_list:        exeList,
      has_technicians: hasTechnicians,
      has_executives:  canSeeExecs,
    };
    return { data: { data: result, ...result } };
  },

  // Realtime check-in/checkout approval lists + pickable rows via Firestore snapshots.
  // The heavy context (roles + users + company supervisors) is resolved ONCE; each snapshot
  // only reprocesses attendance docs. Firestore latency-compensation also fires the listener
  // immediately on the approver's own writes, so approve/pick/release update the UI with no
  // reload — and a technician's new check-in streams in live, no polling. Returns an
  // unsubscribe (the call resolves to it asynchronously once the context is ready).
  subscribeApprovals: (
    supervisorEpf: string, company: string,
    cb: (d: { checkin: any; pick: any[] }) => void,
  ): Promise<() => void> => {
    return resolveApprovalsContext(supervisorEpf, company).then((ctx) => {
      const todayStr = today();
      const yestStr  = prevDayStr(todayStr);
      let todayDocs: any[] = [];
      let yestDocs:  any[] = [];
      const emit = () => {
        const { result, idMap } = buildCheckinResult(ctx, todayDocs, yestDocs);
        if (typeof window !== 'undefined') {
          const w = window as Window & { __attIdMap?: Record<number, { docId: string; sessionId: string }> };
          w.__attIdMap = { ...(w.__attIdMap ?? {}), ...idMap };
        }
        cb({ checkin: result, pick: buildPickRows(ctx, todayDocs) });
      };
      const un1 = onSnapshot(query(collection(db, 'attendances'), where('date', '==', todayStr)), (s) => { todayDocs = s.docs; emit(); });
      const un2 = onSnapshot(query(collection(db, 'attendances'), where('date', '==', yestStr)),  (s) => { yestDocs  = s.docs; emit(); });
      return () => { un1(); un2(); };
    });
  },

  // Southern Lanka only — the Approvals page leads with today's check-in COUNT split by
  // channel (mobile app vs. fingerprint device vs. face device) ahead of the
  // Technician/Executive pending-approval cards. fingerprintApi.ts is the only writer of
  // check_in_method: 'fingerprint' | 'face' — everything else (including the common case
  // where check_in_method was never set at all) counts as 'mobile'.
  getTodayCheckInMethodCounts: async (supervisorEpf: string): Promise<{ mobile: number; fingerprint: number; face: number }> => {
    const { employees, scope } = await getEmployeesInScope(supervisorEpf);
    const epfSet = scope === 'system' ? null : new Set(employees.map(e => String(e.epf_number)));
    if (epfSet) epfSet.add(String(supervisorEpf)); // getEmployeesInScope excludes the viewer themself
    const snap = await getDocs(query(collection(db, 'attendances'), where('date', '==', today())));
    let mobile = 0, fingerprint = 0, face = 0;
    snap.docs.forEach(d => {
      const data = d.data();
      if (epfSet && !epfSet.has(String(data.epf_number))) return;
      sessionsOf(data).forEach(s => {
        if (!s.check_in) return;
        if (s.check_in_method === 'fingerprint') fingerprint++;
        else if (s.check_in_method === 'face') face++;
        else mobile++;
      });
    });
    return { mobile, fingerprint, face };
  },

  // ─── Pick (claim) flow ──────────────────────────────────────────────────────
  // Today's checked-in technicians a picker may claim: every executive/top-management role
  // allowed to pick sees the checked-in technicians in their company (management roles see
  // all companies). The page splits this into mine / available / taken.
  getCheckedInToday: async (supervisorEpf: string) => {
    // Build epf → user map so we can resolve each checked-in person's role/company.
    const [roles, usersSnap] = await Promise.all([getRoles(), getUsersSnapshotCached()]);
    const userByEpf = new Map<string, any>();
    usersSnap.docs.forEach(d => { const u = d.data(); userByEpf.set(String(u.epf_number), u); });

    const me = userByEpf.get(String(supervisorEpf));
    const myRole = me?.role ?? '';
    // Only roles permitted to pick technicians get a list.
    if (!myRole || !canPickTechnicians(myRole, roles)) return { data: { data: [] } };
    // Whether I may pick a given target (per-target, employee_type-aware).
    const canPickMember = makeTechnicianPickPredicate(myRole, roles);
    const myCaps    = resolveUserCapabilities(me, roles);
    // Management OR a top-of-tree approver (e.g. COO) sees every company; others are
    // scoped to their own company.
    const systemWide = myCaps.is_system_admin || myCaps.can_manage_users || myCaps.can_manage_leaves
                    || (myCaps.can_approve && roleParentName(myRole, roles) === null);
    const myCompany = me?.company_name ?? '';

    const snap = await getDocs(query(collection(db, 'attendances'), where('date', '==', today())));
    const rows: any[] = [];
    snap.docs.forEach(d => {
      const a    = d.data();
      const aEpf = String(a.epf_number);
      const emp  = userByEpf.get(aEpf);
      if (emp && (emp.is_active === false || isResigned(emp.date_of_resign))) return;
      const role = emp?.role ?? 'Technician';
      // Only technician-category people are pickable…
      if (roleCategory(role, roles) !== 'technician') return;
      // …and a pick-only team leader sees only technicians that can't lead a team (employee_type-aware).
      if (!canPickMember(role, emp?.employee_type)) return;
      // …in the picker's company (management roles see every company).
      if (!systemWide && (emp?.company_name ?? '') !== myCompany) return;
      sessionsOf(a).forEach(s => {
        if (!s.check_in) return;                  // only people who have checked in
        rows.push({
          docId:            d.id,
          sessionId:        s.id,
          epf_number:       aEpf,
          name:             emp?.display_name ?? aEpf,
          role,
          check_in:         tsToStr(s.check_in),
          check_in_lat:     s.check_in_lat ?? null,
          check_in_lng:     s.check_in_lng ?? null,
          site_name:        s.check_in_site_name ?? null,
          site_distance_m:  s.check_in_site_distance_m ?? null,
          check_in_status:  s.check_in_status ?? 'pending',
          check_out:        tsToStr(s.check_out),
          check_out_status: s.check_out ? (s.check_out_status ?? 'pending') : null,
          check_in_approved_by: s.check_in_approved_by ?? null,
          // Morning food allowance: locked value once picked, else the prospective value
          // computed from the check-in time (same rule the Approvals page shows).
          morning_allowance: s.picked_by ? (s.morning_allowance ?? 0) : calcMorningAllowanceFromTs(s.check_in),
          phone:            emp?.phone_personal || emp?.phone_office || null,
          picked_by:        s.picked_by ?? null,
          picked_by_name:   s.picked_by_name ?? null,
          picked_at:        tsToStr(s.picked_at),
        });
      });
    });
    return { data: { data: rows } };
  },

  // Pick a checked-in person for the day. Atomic (transaction) so the first picker wins.
  // Auto-approves the check-in and stamps picked_by, which routes the day's check-out
  // approval to the picker via the existing claim logic in getCheckinApprovalList.
  pickTechnician: async (data: {
    supervisorEpf: string; supervisorName?: string; docId: string; sessionId: string;
    // Optional approval edits, mirroring the Approvals page: an adjusted check-in time
    // ("YYYY-MM-DD HH:MM:SS") and/or a manually chosen morning food allowance.
    checkInTime?: string; morningAllowance?: 0 | 1 | 2;
  }) => {
    if (tenant.id === 'southernlanka') {
      throw new Error('Picking technicians is not available for this tenant.');
    }
    const me    = String(data.supervisorEpf);
    const roles = await getRoles();
    const ref   = doc(db, 'attendances', data.docId);
    const meSnap = await getDoc(doc(db, 'users', epfDocId(me)));
    const meData = meSnap.exists() ? meSnap.data() : {};
    const meRole = meData.role ?? '';
    if (!canPickTechnicians(meRole, roles)) {
      throw new Error('Your role cannot pick team members.');
    }
    // A full approver (can_approve_technicians) picks AND approves; a pick-only team leader
    // (can_lead_team) only tags the technician onto their team — the check-in stays PENDING
    // until an approver above them approves the team.
    const canApprove = canApproveTechnicians(meRole, roles);
    let pickedEpf = ''; let pickedDate = '';
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('Attendance record not found.');
      const aData = snap.data();
      pickedEpf = String(aData.epf_number); pickedDate = String(aData.date ?? '');
      // Only the technician category is pickable (executives/top management are not).
      const targetUser = await tx.get(doc(db, 'users', epfDocId(pickedEpf)));
      const targetData = targetUser.exists() ? targetUser.data() : {};
      const targetRole = (targetData.role as string) ?? 'Technician';
      const targetEmpType = targetData.employee_type as string | undefined;
      if (roleCategory(targetRole, roles) !== 'technician') {
        throw new Error('Only technician-category members can be picked.');
      }
      // Pick-only team leaders may claim only technicians that can't themselves lead a team — not
      // other team leaders. Resolved with the target's employee_type (a trainee "Team Leader" can't
      // lead, so is pickable). Full approvers/admins are unrestricted.
      if (!makeTechnicianPickPredicate(meRole, roles)(targetRole, targetEmpType)) {
        throw new Error('You can only pick roles below your own level.');
      }
      const sessions = sessionsOf(aData);
      const idx = sessions.findIndex(s => s.id === data.sessionId);
      if (idx === -1) throw new Error('Session not found.');
      const s = sessions[idx];
      if (!s.check_in) throw new Error('This person has not checked in yet.');
      // Already checked out → picking (which routes the FUTURE check-out to the picker) is
      // pointless; approve their check-out instead of picking them.
      if (s.check_out) throw new Error('This person has already checked out — approve their check-out instead of picking them.');
      if (s.picked_by && String(s.picked_by) !== me) {
        throw new Error(`Already picked by ${s.picked_by_name ?? s.picked_by}.`);
      }
      // An already-APPROVED but unpicked check-in is deliberately claimable by ANY picker,
      // whoever approved it. That is exactly what the "Available to pick" pool offers (see
      // availableToPick on the Approvals page) and what Release leaves behind — releasing
      // keeps the check-in approved by the releaser, so "release this technician so someone
      // else can pick them" only works if a different picker may then claim it. A guard here
      // rejecting `check_in_approved_by !== me` made every such row fail with "Check-in was
      // already approved by someone else", so the pool listed people nobody could pick.
      // Re-assigning check_in_approved_by below is what routes their check-out to the new
      // picker (claimedByMe reads that field), and matches cascadePickTeam. The previous
      // approver's decisions are preserved: their locked check-in time and morning food
      // allowance are carried over unchanged.
      // First pick (pending): apply the picker's edited time/allowance, or auto-calc.
      // Re-pick of an already-approved check-in: keep the locked time & allowance as-is.
      const alreadyApproved = s.check_in_status === 'approved';
      const newCheckIn = alreadyApproved
        ? s.check_in
        : data.checkInTime ? localStrToTimestamp(data.checkInTime) : s.check_in;
      const allowance  = data.morningAllowance != null ? data.morningAllowance
        : alreadyApproved ? (s.morning_allowance ?? 0)
        : calcMorningAllowanceFromTs(newCheckIn);
      const base = {
        ...s,
        picked_by:         me,
        picked_by_name:    data.supervisorName ?? null,
        picked_at:         FSTimestamp.now(),
        // Save the (optionally edited) check-in time + morning food allowance the picker chose.
        check_in:          newCheckIn,
        morning_allowance: allowance,
      };
      const updated = sessions.map((x, i) => i === idx
        ? (canApprove
            // Approver pick claims the checkout for the picker and approves the check-in now.
            ? { ...base, check_in_status: 'approved', check_in_approved_by: me }
            // Team-leader pick only forms the team; approval (and checkout routing) come later.
            : base)
        : x);
      tx.update(ref, { sessions: updated, updated_at: FSTimestamp.now() });
    });
    // When an approver picks a team leader, claim the leader's WHOLE team too: reassign every
    // member the leader picked onto this approver (and approve them). Picking the leader picks
    // the team. A plain technician has no team, so this is a no-op for them.
    if (canApprove) await cascadePickTeam(new Set([pickedEpf]), me, data.supervisorName ?? null, pickedDate);
    return { data: { status: 'Request was successful.', approved: canApprove } };
  },

  // Release a person you picked — drops the pick claim only. The check-in STAYS approved
  // (by you, the previous picker) along with its food allowance — picking already validated
  // it, so releasing never un-approves it. You can re-pick your own released people.
  releaseTechnician: async (data: { supervisorEpf: string; docId: string; sessionId: string }) => {
    if (tenant.id === 'southernlanka') {
      throw new Error('Picking technicians is not available for this tenant.');
    }
    const me  = String(data.supervisorEpf);
    const ref = doc(db, 'attendances', data.docId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('Attendance record not found.');
      const sessions = sessionsOf(snap.data());
      const idx = sessions.findIndex(s => s.id === data.sessionId);
      if (idx === -1) throw new Error('Session not found.');
      const s = sessions[idx];
      if (String(s.picked_by ?? '') !== me) throw new Error('You did not pick this person.');
      const updated = sessions.map((x, i) => i === idx ? {
        ...x,
        // Drop only the pick claim — check_in_status / check_in_approved_by / allowance stay.
        picked_by:        null,
        picked_by_name:   null,
        picked_at:        null,
        // Clear the team-grouping hint too, so a later direct re-pick isn't mis-grouped.
        team_leader_epf:  null,
        team_leader_name: null,
      } : x);
      tx.update(ref, { sessions: updated, updated_at: FSTimestamp.now() });
    });
    return { data: { status: 'Request was successful.' } };
  },

  // Release a WHOLE team I claimed via "Pick team" — the inverse of pickTechnician's team cascade.
  // Members I hold for this leader (picked_by me, team_leader_epf = leader) are handed BACK to the
  // original leader (picked_by → leader), and the leader's own claim is dropped (unpicked). This
  // restores the pre-claim state so the team is available for anyone to Pick team again.
  releaseTeam: async (data: { supervisorEpf: string; leaderEpf: string; date: string }) => {
    if (tenant.id === 'southernlanka') {
      throw new Error('Picking technicians is not available for this tenant.');
    }
    const me       = String(data.supervisorEpf);
    const leaderEpf = String(data.leaderEpf);
    if (!data.date) return { data: { status: 'Request was successful.' } };
    const snap = await getDocs(query(collection(db, 'attendances'), where('date', '==', data.date)));
    const writes: Promise<any>[] = [];
    snap.docs.forEach(d => {
      const a    = d.data();
      const aEpf = String(a.epf_number);
      const sessions = sessionsOf(a);
      let changed = false;
      const updated = sessions.map((s: any) => {
        // A member I hold for this leader → hand back to the original leader.
        if (String(s.picked_by ?? '') === me && String(s.team_leader_epf ?? '') === leaderEpf) {
          changed = true;
          return {
            ...s,
            picked_by:        leaderEpf,
            picked_by_name:   s.team_leader_name ?? null,
            team_leader_epf:  null,
            team_leader_name: null,
          };
        }
        // The leader's own record I claimed → drop the claim (unpick), keeping approval as-is.
        if (aEpf === leaderEpf && String(s.picked_by ?? '') === me) {
          changed = true;
          return { ...s, picked_by: null, picked_by_name: null, picked_at: null };
        }
        return s;
      });
      if (changed) writes.push(updateDoc(doc(db, 'attendances', d.id), { sessions: updated, updated_at: FSTimestamp.now() }));
    });
    await Promise.all(writes);
    return { data: { status: 'Request was successful.' } };
  },

  // A location supervisor ends a shift worker's shift early (e.g. they left early). Marks the
  // shift CLOSED — no check-out time is set, so the worker still checks out themselves; this
  // only records who ended the shift and when.
  endShift: async (data: { supervisorEpf: string; docId: string; sessionId: string }) => {
    const me  = String(data.supervisorEpf);
    const ref = doc(db, 'attendances', data.docId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('Attendance record not found.');
      const sessions = sessionsOf(snap.data());
      const idx = sessions.findIndex(s => s.id === data.sessionId);
      if (idx === -1) throw new Error('Session not found.');
      const updated = sessions.map((x, i) => i === idx ? {
        ...x,
        shift_ended:    true,
        shift_ended_by: me,
        shift_ended_at: FSTimestamp.now(),
      } : x);
      tx.update(ref, { sessions: updated, updated_at: FSTimestamp.now() });
    });
    return { data: { status: 'Request was successful.' } };
  },

  // Returns past_tech_list / past_exe_list via the page's custom mapping
  // opts.monthsBack widens the backlog window (default: previous month). opts.olderThanMonthsBack
  // makes the call INCREMENTAL: only regular sessions dated in [monthsBack, olderThanMonthsBack)
  // are read and the all-time past-submission pass is skipped, so widening never re-reads
  // months the page already holds.
  getPastAttendanceApprovalList: async (supervisorEpf: string, company: string, opts?: { monthsBack?: number; olderThanMonthsBack?: number }) => {
    // Same visibility as the live approval list (technician approvers / exec supervisors).
    // Roles, shift places, working places and users are independent — fetch concurrently.
    const [roles, shiftPlaceKeys, usersSnap, places] = await Promise.all([
      getRoles(),
      // Places tagged 'shift' → their attendance routes only to the assigned/location supervisors.
      loadShiftPlaceKeys(),
      getUsersSnapshotCached(),
      // For location-supervisor routing of backlog technician sessions (mirrors the live
      // list's resolveApprovalsContext, which reads ALL places, not just active ones — an
      // old session's check-in can still be site-matched to a place that's since been
      // deactivated, and that place's supervisor must keep routing rights over it).
      getWorkingPlaces(false).catch(() => [] as any[]),
    ]);
    const userByEpf = new Map<string, any>();
    usersSnap.docs.forEach(d => { const u = d.data(); userByEpf.set(String(u.epf_number), u); });

    const viewer        = userByEpf.get(String(supervisorEpf));
    const viewerRole    = viewer?.role ?? '';
    const viewerCompany = viewer?.company_name ?? company ?? '';
    const viewerCaps    = resolveUserCapabilities(viewer, roles);
    const systemWide    = viewerCaps.is_system_admin || viewerCaps.can_manage_users || viewerCaps.can_manage_leaves
                       || (viewerCaps.can_approve && roleParentName(viewerRole, roles) === null)
                       // Top-management-category approvers (e.g. COO) oversee everyone —
                       // any employee, any company — even when their role isn't a tree root.
                       || (viewerCaps.can_approve && roleCategory(viewerRole, roles) === 'top_management');
    const canPickTech   = canPickTechnicians(viewerRole, roles);
    // Per-target pick predicate + location-supervisor routing — same rules as the live list,
    // applied to backlog sessions (which, unlike past submissions, carry a check-in site id).
    const canPickMember = makeTechnicianPickPredicate(viewerRole, roles);
    const viewerLocationIds  = new Set<string>();  // places THIS viewer supervises
    const supervisedPlaceIds = new Set<string>();  // places that have ANY location supervisor
    for (const p of places as any[]) {
      const sup = Array.isArray(p?.supervisor_epfs)
        ? p.supervisor_epfs.map(String).filter((e: string) => e.trim() !== '') : [];
      if (!sup.length) continue;
      supervisedPlaceIds.add(String(p.id));
      if (sup.includes(String(supervisorEpf))) viewerLocationIds.add(String(p.id));
    }
    const viewerShiftPlaceKeys = viewerShiftPlaceKeysOf(places as any[], String(supervisorEpf));
    let inCompanySupervisors = false;
    try {
      const compSnap = await getDocs(query(collection(db, 'companies'), where('name', '==', viewerCompany)));
      const supEpfs  = compSnap.docs[0]?.data()?.supervisor_epfs ?? [];
      inCompanySupervisors = Array.isArray(supEpfs) && supEpfs.map(String).includes(String(supervisorEpf));
    } catch { /* non-critical */ }
    const execSeeAll = systemWide || (roleCategory(viewerRole, roles) === 'executive' && inCompanySupervisors);
    const sameCompany = (c: any) => systemWide || (c ?? '') === viewerCompany;
    const canSeeCheckIn = (empRole: string, empCompany: any, empSupervisor: any) =>
      roleCategory(empRole, roles) === 'technician'
        // Technicians can be approved by any executive approver, regardless of company —
        // and by system-wide viewers (management / top management) unconditionally.
        ? (systemWide || canPickTech)
        : ((execSeeAll && sameCompany(empCompany)) || String(empSupervisor ?? '') === String(supervisorEpf));

    // Southern Lanka only — same HOD/escalation-ladder-only routing as the live approval list
    // (buildCheckinResult) and no other visibility rule. See southernlankaApprovers.
    const isSouthernlanka = tenant.id === 'southernlanka';
    const allUsersData = isSouthernlanka ? Array.from(userByEpf.values()) : [];
    const hodLadderCache = new Map<string, boolean>();
    const hodLadderCanSee = (empEpf: string, empRole: string, empDept: string | undefined, empCompany: string): boolean => {
      if (!hodLadderCache.has(empEpf)) {
        const approvers = southernlankaApprovers(
          { epf_number: empEpf, role: empRole, department: empDept, company_name: empCompany },
          allUsersData, roles, 'can_approve',
        );
        hodLadderCache.set(empEpf, approvers.includes(String(supervisorEpf)));
      }
      return hodLadderCache.get(empEpf)!;
    };

    const records: unknown[] = [];
    // Ids are stable per (doc, session) — a refetch can never remap an id another list or an
    // earlier render handed out, so a click can't silently approve the wrong record.
    const idMap: Record<number, { docId: string; sessionId: string }> = {};
    const todayStr = today();
    const yestStr  = prevDayStr(todayStr);
    // Backlog window: current + previous month by default. A regular record left pending falls
    // out of the live approvals view (today/yesterday only) at midnight and would otherwise
    // stay 'pending' forever, invisible to every approver. Firestore can't filter on a nested
    // session status, so the window is a date bound — the approvals page widens it on demand
    // (opts.monthsBack) rather than every load paying for months of history.
    const backlogStart = backlogStartFor(todayStr, opts?.monthsBack ?? 1);
    const olderOnly    = !!opts?.olderThanMonthsBack;
    const backlogEnd   = olderOnly ? backlogStartFor(todayStr, opts!.olderThanMonthsBack!) : todayStr;
    // Fetch by past_submission flag — filter pending in JS (migrated data may lack status fields)
    const [snap, backlogSnap, pendingEditSnap] = await Promise.all([
      // Past submissions are an all-time set — an incremental widen already holds them.
      olderOnly
        ? Promise.resolve({ docs: [] as any[] })
        : getDocs(query(
            collection(db, 'attendances'),
            where('is_past_submission', '==', true),
          )),
      getDocs(query(
        collection(db, 'attendances'),
        where('date', '>=', backlogStart),
        where('date', '<', backlogEnd),
      )),
      // Sessions that already have a pending edit request in flight — never surface them
      // here too. Mainly matters for missing-checkout backlog: the employee already asked
      // for the correction via an edit request, so the approver shouldn't see a second,
      // separate "past attendance" card for the same session (and risk approving stale times).
      getDocs(query(
        collection(db, 'attendance_edit_requests'),
        where('status', '==', 'pending'),
      )),
    ]);
    const pendingEditKeys = new Set<string>();
    pendingEditSnap.docs.forEach(d => {
      const rd = d.data();
      pendingEditKeys.add(`${rd.attendance_id}::${rd.session_id ?? ''}`);
    });
    for (const d of snap.docs) {
        const a    = d.data();
        if (a.is_deleted) continue;   // soft-deleted attendance is hidden from approvals
        const aEpf = String(a.epf_number);
        const emp  = userByEpf.get(aEpf);
        if (emp && (emp.is_active === false || isResigned(emp.date_of_resign))) continue;
        // Never surface the viewer's own attendance for self-approval — their approver handles it.
        if (aEpf === String(supervisorEpf)) continue;
        const empSupervisor = emp?.supervisor_epf ?? null;
        const docVisible = isSouthernlanka
          ? (systemWide || hodLadderCanSee(aEpf, emp?.role ?? 'Technician', emp?.department, emp?.company_name ?? ''))
          : canSeeCheckIn(emp?.role ?? 'Technician', emp?.company_name ?? '', empSupervisor);
        for (const s of sessionsOf(a)) {
          if (!s.is_past_submission) continue;
          if (pendingEditKeys.has(`${d.id}::${s.id}`)) continue;
          // Either half may still be pending — a check-in approved through an edit request
          // with the check-out left 'pending' used to be skipped here AND by the backlog pass.
          if (!pastSubmissionNeedsApproval(s)) continue;
          // Shift-place past attendance routes only to the employee's assigned supervisor,
          // management and the place's location supervisors; other sessions use the doc-level visibility.
          const shiftVis = shiftRouteVisibility(
            sessionAtPlace(s, shiftPlaceKeys), empSupervisor, String(supervisorEpf), systemWide, sessionAtPlace(s, viewerShiftPlaceKeys));
          if (!(shiftVis !== null ? shiftVis : docVisible)) continue;
          const id = stableId(d.id, s.id);
          idMap[id] = { docId: d.id, sessionId: s.id };
          records.push({
            attendance_id:   id,
            epf_number:      a.epf_number,
            employee_name:   emp?.display_name ?? a.epf_number,
            user_type:       emp?.role ?? 'Technician',
            phone:           emp?.phone_personal || emp?.phone_office || null,
            check_in:        tsToStr(s.check_in),
            check_out:       tsToStr(s.check_out),
            // An already-approved check-in makes this a checkout-only record: the card locks
            // the check-in editor and approvePastAttendance leaves that half untouched.
            check_in_approved: s.check_in_status === 'approved',
            // Sessions are CREATED with allowance 0 as a placeholder (submitPastAttendance) —
            // only an approved check-in carries a real allowance decision. Otherwise force null
            // so the edit state calcs from the times instead of freezing on "0 = no allowance".
            morning_allowance: s.check_in_status === 'approved' ? (s.morning_allowance ?? 0) : null,
            evening_allowance: null,
            working_place:   s.working_place,
            site_number:     s.site_number,
            locations:       sessionLocationsOf(s),
            is_outstation:   s.is_outstation,
            outstation_name: s.outstation_name,
            outstation_address: s.outstation_address,
            date:            a.date,
          });
        }
    }

    // Stranded regular sessions — check-in/check-out still 'pending' after the live window
    // (today + yesterday) moved past them. Mirrors the live list's visibility rules:
    // soft-delete, shift-place routing, location-supervisor routing, per-target pick
    // predicate, and the checkout claim rule.
    for (const d of backlogSnap.docs) {
      const a    = d.data();
      if (a.is_deleted) continue;   // soft-deleted attendance is hidden from approvals
      const aEpf = String(a.epf_number);
      const emp  = userByEpf.get(aEpf);
      if (emp && (emp.is_active === false || isResigned(emp.date_of_resign))) continue;
      // Never surface the viewer's own attendance for self-approval.
      if (aEpf === String(supervisorEpf)) continue;
      const empRole       = emp?.role ?? 'Technician';
      const empSupervisor = emp?.supervisor_epf ?? null;
      const isTechRole    = roleCategory(empRole, roles) === 'technician';
      const hodVisible    = isSouthernlanka
                         && (systemWide || hodLadderCanSee(aEpf, empRole, emp?.department, emp?.company_name ?? ''));
      const execVisible   = isSouthernlanka
        ? hodVisible
        : (execSeeAll && sameCompany(emp?.company_name ?? ''))
          || String(empSupervisor ?? '') === String(supervisorEpf);
      for (const s of sessionsOf(a)) {
        if (s.is_past_submission) continue;   // already surfaced by the past-submission pass
        if (pendingEditKeys.has(`${d.id}::${s.id}`)) continue;
        const checkInPending  = !!s.check_in  && s.check_in_status  === 'pending';
        const checkOutPending = !!s.check_out && s.check_out_status === 'pending';
        if (!checkInPending && !checkOutPending) continue;
        // Yesterday's pending check-outs still surface in the live list (overnight-shift path);
        // only its check-in-only pendings are invisible there.
        if (a.date === yestStr && checkOutPending) continue;
        // Shift-place sessions route only to the assigned/location supervisors (management keeps oversight).
        const shiftVis = shiftRouteVisibility(
          sessionAtPlace(s, shiftPlaceKeys), empSupervisor, String(supervisorEpf), systemWide, sessionAtPlace(s, viewerShiftPlaceKeys));
        if (shiftVis === false) continue;
        // Live-list technician routing: a check-in GPS-matched to a place that HAS location
        // supervisors routes only to them; elsewhere the per-target pick predicate applies.
        const siteId = s.check_in_site_id ? String(s.check_in_site_id) : null;
        const canSee = shiftVis !== null ? shiftVis
          : isSouthernlanka
            ? hodVisible
            : isTechRole
              ? (siteId && supervisedPlaceIds.has(siteId)
                  ? (systemWide || viewerLocationIds.has(siteId))
                  : (systemWide || canPickMember(empRole, emp?.employee_type)))
              : execVisible;
        const visibleCheckIn = checkInPending && canSee;
        // A pending checkout stays with whoever claimed the check-in, a supervisor of its
        // place, or — when unclaimed — the check-in's normal routing (live rule).
        const claimedByMe = systemWide
          || String(s.check_in_approved_by ?? '') === String(supervisorEpf)
          || (!!siteId && viewerLocationIds.has(siteId))
          || (!s.check_in_approved_by && canSee);
        const visibleCheckOut = !visibleCheckIn && checkOutPending && claimedByMe;
        if (!visibleCheckIn && !visibleCheckOut) continue;
        const id = stableId(d.id, s.id);
        idMap[id] = { docId: d.id, sessionId: s.id };
        records.push({
          attendance_id:   id,
          epf_number:      a.epf_number,
          employee_name:   emp?.display_name ?? a.epf_number,
          user_type:       empRole,
          phone:           emp?.phone_personal || emp?.phone_office || null,
          check_in:        tsToStr(s.check_in),
          check_out:       tsToStr(s.check_out),
          // Checkout-only records keep their approved check-in untouched on approve; the
          // card locks the check-in editor when this is true.
          check_in_approved: s.check_in_status === 'approved',
          // Only pass through the stored morning allowance when it reflects a REAL approval
          // decision (checkout-only backlog record, hand-adjustable at check-in approval) —
          // sessions are otherwise created with allowance 0 as an unset placeholder. Entry
          // into this pass guarantees the checkout was never approved, so its allowance is
          // never legitimate — always null, so the calc runs from the checkout time.
          morning_allowance: s.check_in_status === 'approved' ? (s.morning_allowance ?? 0) : null,
          evening_allowance: null,
          working_place:   s.working_place,
          site_number:     s.site_number,
          locations:       sessionLocationsOf(s),
          is_outstation:   s.is_outstation,
          outstation_name: s.outstation_name,
          outstation_address: s.outstation_address,
          date:            a.date,
        });
      }
    }
    // Newest first — the backlog can span two months.
    (records as any[]).sort((x, y) => String(y.date ?? '').localeCompare(String(x.date ?? '')));

    if (typeof window !== 'undefined') {
      const w = window as Window & { __attIdMap?: Record<number, { docId: string; sessionId: string }> };
      w.__attIdMap = { ...(w.__attIdMap ?? {}), ...idMap };
    }
    return { data: { data: records } };
  },

  // Resolve numeric id → { docId, sessionId } via window.__attIdMap
  _resolveTarget: (id: number | string): { docId: string; sessionId: string } => {
    if (typeof id === 'string' && id.includes('_') && !id.startsWith('s_')) {
      return { docId: id, sessionId: 's0' }; // already a docId
    }
    const map = typeof window !== 'undefined'
      ? (window as Window & { __attIdMap?: Record<number, { docId: string; sessionId: string }> }).__attIdMap
      : undefined;
    const hit = map?.[Number(id)];
    // No mapping = the id is stale (or the list that minted it never loaded). Guessing a
    // target here used to fabricate a nonexistent doc id, which made the write vanish
    // silently while the UI reported success — fail loudly instead so the user retries.
    if (!hit) throw new Error(`Stale approval target (${id}) — refresh the approvals page and try again`);
    return hit;
  },

  // Group a bulk approved_list by target doc so multiple sessions in the same doc share one
  // read + one write, and different docs resolve in parallel (Promise.all) instead of one
  // sequential Firestore round-trip per selected record — the latter is what made large
  // bulk-approve batches slow.
  _groupByDoc: (approvedList: any[]) => {
    const byDoc = new Map<string, Array<{ sessionId: string; item: any }>>();
    for (const item of approvedList) {
      const { docId, sessionId } = attendanceApi._resolveTarget(item.id);
      if (!byDoc.has(docId)) byDoc.set(docId, []);
      byDoc.get(docId)!.push({ sessionId, item });
    }
    return byDoc;
  },

  approveCheckIn: async (data: any) => {
    const approverEpf = String(data.epf_number);
    const byDoc = attendanceApi._groupByDoc(data.approved_list);
    // Cascade: approving a team leader also approves everyone they picked onto their team.
    // Collect the approved people's EPFs (+ their date) from the same read used for the
    // write itself — no repeat fetch. Non-leaders simply have no picked team, so nothing
    // extra happens.
    const leaderEpfs = new Set<string>();
    const dates = new Set<string>();
    await Promise.all([...byDoc.entries()].map(async ([docId, entries]) => {
      const ref  = doc(db, 'attendances', docId);
      const snap = await getDoc(ref);
      if (!snap.exists()) throw new Error(`Attendance record not found (${docId}) — refresh and try again`);
      const a = snap.data();
      // Southern Lanka only — re-derive HOD/ladder approval authority fresh, never trust the
      // read-time visibility that put this record in front of the approver (see
      // assertSouthernlankaAttendanceAuthority). No-op for every other tenant.
      await assertSouthernlankaAttendanceAuthority(approverEpf, String(a.epf_number));
      const sessions = sessionsOf(a);
      const patchBySession = new Map<string, any>();
      for (const { sessionId, item } of entries) {
        if (!sessions.some(s => s.id === sessionId)) {
          throw new Error(`Attendance session not found (${docId}) — refresh and try again`);
        }
        patchBySession.set(sessionId, {
          check_in:             localStrToTimestamp(item.time),
          check_in_status:      'approved',
          check_in_approved_by: approverEpf,
          morning_allowance:    item.morning_allowance,
        });
      }
      const updated = sessions.map(s => patchBySession.has(s.id) ? { ...s, ...patchBySession.get(s.id) } : s);
      await updateDoc(ref, { sessions: updated, updated_at: FSTimestamp.now() });
      leaderEpfs.add(String(a.epf_number));
      if (a.date) dates.add(String(a.date));
    }));
    for (const dateStr of dates) await cascadeApproveTeam(leaderEpfs, approverEpf, dateStr);
    return { data: { status: 'Request was successful.' } };
  },

  approveCheckOut: async (data: any) => {
    const byDoc = attendanceApi._groupByDoc(data.approved_list);
    await Promise.all([...byDoc.entries()].map(async ([docId, entries]) => {
      const ref  = doc(db, 'attendances', docId);
      const snap = await getDoc(ref);
      if (!snap.exists()) throw new Error(`Attendance record not found (${docId}) — refresh and try again`);
      const a = snap.data();
      // Southern Lanka only — see approveCheckIn's matching note.
      await assertSouthernlankaAttendanceAuthority(String(data.epf_number), String(a.epf_number));
      const sessions = sessionsOf(a);
      const patchBySession = new Map<string, any>();
      for (const { sessionId, item } of entries) {
        const sess = sessions.find(s => s.id === sessionId);
        if (!sess) throw new Error(`Attendance session not found (${docId}) — refresh and try again`);
        // The card's time editor re-anchors onto the RECORD's own stored date client-side
        // (applyTimeToDate in the approvals page) — item.time already carries the correct
        // calendar day, including "the day after check-in" for an overnight session. Trust it
        // as-is; forcing it back onto the doc's own `date` field here would silently discard a
        // legitimately later day whenever the edited time-of-day is chronologically AFTER the
        // check-in's time-of-day (e.g. check-in 03:00, real checkout 10:00 the next morning).
        let checkOut = localStrToTimestamp(item.time);
        // Safety net only: a genuinely inverted value (stale UI state, bad input) rather than
        // the expected case — minute-floored so an unedited side's real capture seconds don't
        // make a same-minute Out look "a few seconds earlier" and get bumped a full day forward.
        if (sess.check_in && minuteFloor(checkOut) <= minuteFloor(sess.check_in)) {
          checkOut = FSTimestamp.fromMillis(checkOut.toMillis() + 24 * 60 * 60 * 1000);
        }
        const patch: any = {
          check_out:              checkOut,
          check_out_status:       'approved',
          check_out_approved_by:  data.epf_number,
          evening_allowance:      item.evening_allowance,
          working_place:          item.working_place,
          site_number:            item.site_no ?? null,
          is_outstation_approved: item.is_outstation_approved,
        };
        // The approver can override the auto-derived outstation flag at approval time.
        if (item.is_outstation !== undefined) patch.is_outstation = !!item.is_outstation;
        // Overnight sessions surface next day as a checkout-only card, so this may be the ONLY
        // approval pass the session ever gets — settle a still-pending check-in too, or the day
        // stays half-approved forever and the monthly report drops it. Also backfill the morning
        // allowance (every other first-approval path does — approveCheckIn / pickTechnician /
        // approvePastAttendance): left at 0 here it's stuck forever, since this session never
        // surfaces in an approval list again to fix it later. Skip only when a picker already
        // hand-set it (picked_by set — their edited value must survive).
        if (sess.check_in && sess.check_in_status === 'pending' && !sess.check_in_approved_by) {
          patch.check_in_status      = 'approved';
          patch.check_in_approved_by = data.epf_number;
          if (!sess.picked_by) patch.morning_allowance = calcMorningAllowanceFromTs(sess.check_in);
        }
        patchBySession.set(sessionId, patch);
      }
      const updated = sessions.map(s => patchBySession.has(s.id) ? { ...s, ...patchBySession.get(s.id) } : s);
      await updateDoc(ref, { sessions: updated, updated_at: FSTimestamp.now() });
    }));
    return { data: { status: 'Request was successful.' } };
  },

  approvePastAttendance: async (data: any) => {
    const byDoc = attendanceApi._groupByDoc(data.approved_list);
    await Promise.all([...byDoc.entries()].map(async ([docId, entries]) => {
      const ref  = doc(db, 'attendances', docId);
      const snap = await getDoc(ref);
      // A missing doc/session means the target is gone or the id went stale — abort loudly;
      // skipping silently here is an approval the user believes happened.
      if (!snap.exists()) throw new Error(`Attendance record not found (${docId}) — refresh and try again`);
      const a = snap.data();
      // Southern Lanka only — see approveCheckIn's matching note.
      await assertSouthernlankaAttendanceAuthority(String(data.epf_number), String(a.epf_number));
      const sessions = sessionsOf(a);
      const patchBySession = new Map<string, any>();
      for (const { sessionId, item } of entries) {
        const sess = sessions.find(s => s.id === sessionId);
        if (!sess) throw new Error(`Attendance session not found (${docId}) — refresh and try again`);
        const checkIn  = localStrToTimestamp(item.check_in_time);
        let   checkOut = localStrToTimestamp(item.check_out_time);
        // The card's Out editor is time-only, anchored to the check-in's day — an Out earlier
        // than In means the shift ran past midnight: roll the checkout to the next day instead
        // of writing a negative-duration session. Minute-floored: the page's own equal-minute
        // guard already rejects a same-minute Out, so this only ever fires for a genuinely
        // earlier clock time, not a few unedited seconds of jitter.
        const overnight = minuteFloor(checkOut) < minuteFloor(checkIn);
        if (overnight) checkOut = FSTimestamp.fromMillis(checkOut.toMillis() + 24 * 60 * 60 * 1000);
        const patch: any = {
          check_out:              checkOut,
          check_out_status:       'approved',
          check_out_approved_by:  data.epf_number,
          working_place:          item.working_place,
          site_number:            item.site_no ?? null,
          is_outstation_approved: item.is_outstation_approved,
          evening_allowance:      item.evening_allowance,
          past_approved_by:       data.epf_number,
          ...(overnight ? { _overnight: true } : {}),
        };
        // A checkout-only backlog record's check-in was already approved — never clobber its
        // time, approver stamp, or (possibly hand-adjusted) morning allowance.
        if (sess.check_in_status !== 'approved') {
          patch.check_in             = checkIn;
          patch.check_in_status      = 'approved';
          patch.check_in_approved_by = data.epf_number;
          patch.morning_allowance    = item.morning_allowance;
        }
        patchBySession.set(sessionId, patch);
      }
      const updated = sessions.map(s => patchBySession.has(s.id) ? { ...s, ...patchBySession.get(s.id) } : s);
      await updateDoc(ref, { sessions: updated, updated_at: FSTimestamp.now() });
    }));
    return { data: { status: 'Request was successful.' } };
  },

  requestAttendanceEdit: async (data: any) => {
    const now      = FSTimestamp.now();
    const userSnap = await getDoc(doc(db, 'users', epfDocId(data.epf_number)));
    const empName  = userSnap.exists() ? userSnap.data().display_name : data.epf_number;
    // A missed-punch request (Southern Lanka: the day has NO record yet) carries no
    // attendance_id — just epf + date. Build the target doc id from those; approval
    // (considerAttendanceEditRequest) then CREATES the record from the requested values.
    const noRecordTarget = (data.attendance_id == null || data.attendance_id === 0 || data.attendance_id === '')
      && typeof data.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.date);
    const target   = noRecordTarget
      ? { docId: attDocId(data.epf_number, data.date), sessionId: 's0' }
      : attendanceApi._resolveTarget(data.attendance_id);

    const routeTo: string[] = [];
    if (tenant.id === 'southernlanka') {
      // Southern Lanka: attendance there is auto-approved (see checkIn/checkOut above), so
      // there's no real "previous field approver" to route to — edit-request approval instead
      // routes EXACTLY like a leave request from the same applicant would: their department's
      // Head of Department, unioned with every role above the applicant's in the tree ("Reports
      // to", set when the role is created) that can approve attendance. A department's own HOD
      // is excluded from approving their OWN request by southernlankaApprovers itself (it
      // matches every OTHER active HOD of the same department, never the applicant) — so a
      // HOD's own edit request escalates straight to whichever role is above the HOD's.
      try {
        const applicant = userSnap.exists() ? userSnap.data() : {};
        // force=true — approval routing is safety-critical and roles change rarely enough
        // that a forced read here is cheap; never let the 5-minute in-memory roles cache
        // (see roleService.ts) silently keep routing against a just-changed capability toggle.
        const [roles, usersSnap] = await Promise.all([getRoles(true), getUsersSnapshotCached()]);
        southernlankaApprovers(
          { epf_number: data.epf_number, role: applicant.role, department: applicant.department, company_name: applicant.company_name },
          usersSnap.docs.map((d: any) => d.data()),
          roles,
          'can_approve',
        ).forEach(epf => routeTo.push(epf));
      } catch { /* non-critical — falls back to scope visibility in getAttendanceEditRequests */ }
    } else {
      // Route the request to whoever approved the field(s) being edited: editing the
      // check-in → check-in approver; editing check-out / place / outstation → check-out
      // approver. Empty → getAttendanceEditRequests falls back to scope visibility.
      // Route the edit to the RELEVANT approvers only (never a blanket broadcast to every approver):
      // the previous approver(s) of the edited field(s), the place's location supervisor(s), and the
      // employee's own allocated supervisor.
      try {
        const aSnap = await getDoc(doc(db, 'attendances', target.docId));
        if (aSnap.exists()) {
          const sessions = sessionsOf(aSnap.data());
          const sid  = data.session_id ?? target.sessionId ?? null;
          const sess = sid ? sessions.find(s => s.id === sid) : sessions.slice(-1)[0];
          if (sess) {
            if (data.requested_check_in && sess.check_in_approved_by) routeTo.push(String(sess.check_in_approved_by));
            const editsCheckout = data.requested_check_out || data.requested_working_place
              || data.requested_site_number || data.requested_is_outstation != null
              || data.requested_outstation_name || data.requested_outstation_address;
            if (editsCheckout && sess.check_out_approved_by) routeTo.push(String(sess.check_out_approved_by));
            // Location supervisor(s) of the place this session's check-in matched.
            if (sess.check_in_site_id) {
              const placeSnap = await getDoc(doc(db, 'working_places', String(sess.check_in_site_id)));
              const sup = placeSnap.exists() ? (placeSnap.data() as any).supervisor_epfs : null;
              if (Array.isArray(sup)) sup.forEach((e: any) => { if (e != null && String(e).trim()) routeTo.push(String(e)); });
            }
          }
        }
        // The employee's allocated supervisor is always a relevant approver.
        const empSup = userSnap.exists() ? userSnap.data().supervisor_epf : null;
        if (empSup != null && String(empSup).trim()) routeTo.push(String(empSup));
      } catch { /* non-critical — leave unrouted (edit still appears in the approvals scope) */ }
    }

    await addDoc(collection(db, 'attendance_edit_requests'), {
      attendance_id:                target.docId,
      session_id:                   data.session_id ?? target.sessionId ?? null,
      route_to:                     [...new Set(routeTo)],
      epf_number:                   data.epf_number,
      employee_name:                empName,
      reason:                       data.reason,
      requested_check_in:           data.requested_check_in ?? null,
      requested_check_out:          data.requested_check_out ?? null,
      requested_working_place:      data.requested_working_place ?? null,
      requested_site_number:        data.requested_site_number ?? null,
      requested_is_outstation:      data.requested_is_outstation ?? null,
      requested_outstation_name:    data.requested_outstation_name ?? null,
      requested_outstation_address: data.requested_outstation_address ?? null,
      status:      'pending',
      considered_by:  null,
      considered_at:  null,
      reject_reason:  null,
      created_at:     now,
    });

    // Notify whoever this request is routed to (fallback: every approver). The old
    // FCM pipeline lost its sender in the Firestore migration — this restores it.
    {
      const editDate  = String(target.docId).split('_').pop() ?? '';
      const requester = String(data.epf_number);
      const base = {
        type: 'attendance_edit' as const,
        actorEpf:  requester,
        actorName: String(empName ?? requester),
        meta: {
          ...(editDate ? { date: editDate } : {}),
          ...(data.reason ? { reason: String(data.reason) } : {}),
        },
        title: `${empName ?? requester} requested an attendance edit`,
        body:  [editDate, data.reason].filter(Boolean).join(' · '),
        link:  '/approvals',
      };
      // Direct notifications to the routed approvers ONLY — no blanket broadcast to every approver.
      const recipients = [...new Set(routeTo)].filter(e => e && e !== requester);
      recipients.forEach(epf => void createAppNotification({ ...base, toEpf: epf }));
    }
    return { data: { status: 'Request was successful.' } };
  },

  // Amend an existing edit request that is still pending (the requester changed their mind
  // before an approver acted). Keeps the same session/routing — only the requested values and
  // reason change. Approved/rejected requests can't be re-opened this way.
  updateAttendanceEditRequest: async (data: any) => {
    const reqRef  = doc(db, 'attendance_edit_requests', String(data.id));
    const reqSnap = await getDoc(reqRef);
    if (!reqSnap.exists()) throw new Error('Edit request not found');
    const r = reqSnap.data();
    if (String(r.epf_number) !== String(data.epf_number)) throw new Error('Not your request to edit.');
    if (r.status !== 'pending') throw new Error('This request has already been considered.');

    await updateDoc(reqRef, {
      reason:                       data.reason ?? r.reason ?? '',
      requested_check_in:           data.requested_check_in ?? null,
      requested_check_out:          data.requested_check_out ?? null,
      requested_working_place:      data.requested_working_place ?? null,
      requested_site_number:        data.requested_site_number ?? null,
      requested_is_outstation:      data.requested_is_outstation ?? null,
      requested_outstation_name:    data.requested_outstation_name ?? null,
      requested_outstation_address: data.requested_outstation_address ?? null,
      updated_at:                   FSTimestamp.now(),
    });
    return { data: { status: 'Request was successful.' } };
  },

  // Approvals page unpacks: erData?.requests ?? []
  // Each request needs: id, attendance_id, epf_number, name, reason, created_at, current{}, requested{}
  getAttendanceEditRequests: async (supervisorEpf: string, _company: string) => {
    const { employees, scope } = await getEmployeesInScope(supervisorEpf);
    const epfSet = new Set(employees.map(e => e.epf_number as string));

    const snap = await getDocs(query(
      collection(db, 'attendance_edit_requests'),
      where('status', '==', 'pending'),
    ));

    const requests: unknown[] = [];
    // Route the request to the approver(s) of the edited field (route_to). Older requests
    // without routing fall back to scope visibility (Admin/HR/tree). Then batch-fetch the
    // attendance docs in parallel (was a sequential getDoc per request — N+1).
    const inScope = snap.docs.filter(d => {
      const rt = d.data().route_to;
      if (scope === 'system') return true;                                   // management / COO → all
      if (Array.isArray(rt) && rt.length) return rt.map(String).includes(String(supervisorEpf)); // routed approver
      return epfSet.has(String(d.data().epf_number));                        // unrouted → tree scope
    });
    const attIds = [...new Set(inScope.map(d => String(d.data().attendance_id)))];
    const attMap = new Map<string, any>();
    await Promise.all(attIds.map(async (aid) => {
      const attSnap = await getDoc(doc(db, 'attendances', aid.replace(/\//g, '%2F')));
      attMap.set(aid, attSnap.exists() ? attSnap.data() : {});
    }));
    // The session a request targets (fallback: the day's latest session).
    const targetSessOf = (r: any) => {
      const ss = sessionsOf(attMap.get(String(r.attendance_id)) ?? {});
      const i  = r.session_id ? ss.findIndex(s => s.id === r.session_id) : -1;
      return i >= 0 ? ss[i] : (ss.slice(-1)[0] ?? {});
    };
    // Resolve the display names of whoever PREVIOUSLY approved the targeted sessions'
    // check-in / check-out (shown in the request's "Current" column). Batched by EPF.
    const approverEpfs = new Set<string>();
    for (const d of inScope) {
      const tgt = targetSessOf(d.data());
      if (tgt.check_in_approved_by)  approverEpfs.add(String(tgt.check_in_approved_by));
      if (tgt.check_out_approved_by) approverEpfs.add(String(tgt.check_out_approved_by));
    }
    const approverName = new Map<string, string>();
    await Promise.all([...approverEpfs].map(async (epf) => {
      try {
        const s = await getDoc(doc(db, 'users', epfDocId(epf)));
        approverName.set(epf, s.exists() ? (s.data().display_name ?? epf) : epf);
      } catch { approverName.set(epf, epf); }
    }));
    const nameOf = (epf: any) => epf ? (approverName.get(String(epf)) ?? String(epf)) : null;
    for (const d of inScope) {
      const r    = d.data();
      const rEpf = String(r.epf_number);
      const a = attMap.get(String(r.attendance_id)) ?? {};
      const empRecord = employees.find(e => e.epf_number === rEpf);
      // The "current" snapshot is the specific session the request targets (fallback latest).
      const allSessions = sessionsOf(a);
      const sessIdx     = r.session_id ? allSessions.findIndex(s => s.id === r.session_id) : -1;
      const targetSess  = sessIdx >= 0 ? allSessions[sessIdx] : (allSessions.slice(-1)[0] ?? {});
      requests.push({
        id:            d.id,
        attendance_id: r.attendance_id,
        session_id:    r.session_id ?? null,
        session_no:    sessIdx >= 0 ? sessIdx + 1 : (allSessions.length || 1),
        session_count: allSessions.length || 1,
        epf_number:    rEpf,
        name:          r.employee_name,
        reason:        r.reason,
        created_at:    r.created_at?.toDate?.()?.toISOString() ?? '',
        role:          empRecord?.role ?? 'Executive',
        user_type:     empRecord?.role ?? 'Executive',
        current: (() => {
          const cur = targetSess;
          return {
            check_in:           tsToStr(cur.check_in),
            check_out:          tsToStr(cur.check_out),
            check_in_lat:       cur.check_in_lat ?? cur.lat ?? null,
            check_in_lng:       cur.check_in_lng ?? cur.lng ?? null,
            check_out_lat:      cur.check_out_lat ?? null,
            check_out_lng:      cur.check_out_lng ?? null,
            working_place:      cur.working_place ?? null,
            site_number:        cur.site_number ?? null,
            is_outstation:      cur.is_outstation ?? false,
            outstation_name:    cur.outstation_name ?? null,
            outstation_address: cur.outstation_address ?? null,
            locations:          sessionLocationsOf(cur),
            // Who approved the existing check-in / check-out (display names).
            check_in_approved_by_name:  nameOf(cur.check_in_approved_by),
            check_out_approved_by_name: nameOf(cur.check_out_approved_by),
          };
        })(),
        requested: {
          check_in:           r.requested_check_in,
          check_out:          r.requested_check_out,
          check_in_lat:       r.requested_check_in_lat ?? r.check_in_lat ?? null,
          check_in_lng:       r.requested_check_in_lng ?? r.check_in_lng ?? null,
          working_place:      r.requested_working_place,
          site_number:        r.requested_site_number,
          is_outstation:      r.requested_is_outstation,
          outstation_name:    r.requested_outstation_name,
          outstation_address: r.requested_outstation_address,
        },
      });
    }
    return { data: { data: { requests } } };
  },

  // Real-time counterpart to getAttendanceEditRequests above — same pattern as
  // subscribeApprovals/leaveApi.subscribeLeaveRequests: listen on the same 'pending' query,
  // re-resolve the full scoped result via getAttendanceEditRequests itself on every change,
  // so a new Time Change / manual-adjustment request appears in the Approvals page instantly.
  subscribeAttendanceEditRequests: (
    supervisorEpf: string, company: string,
    cb: (requests: unknown[]) => void,
  ): (() => void) => {
    const emit = () => {
      attendanceApi.getAttendanceEditRequests(supervisorEpf, company).then((res: any) => {
        const d = res.data?.data ?? res.data;
        cb(Array.isArray(d?.requests) ? d.requests : []);
      }).catch(() => { /* keep showing the last-known list rather than clearing it */ });
    };
    emit();
    return onSnapshot(
      query(collection(db, 'attendance_edit_requests'), where('status', '==', 'pending')),
      emit,
      (err) => console.warn('subscribeAttendanceEditRequests failed:', err?.message ?? err),
    );
  },

  // Attendance page unpacks: erData?.requests ?? []
  getMyEditRequests: async (epfNumber: string) => {
    // NO limit() and NO orderBy here, deliberately. Firestore falls back to __name__ (doc id)
    // ordering when no orderBy is given, and addDoc mints random auto-ids — so the old
    // `limit(20)` returned the 20 lexicographically-smallest ids, an arbitrary subset that a
    // freshly-created request usually isn't in. Once a person had >20 requests (settled ones
    // included — this query isn't status-filtered) their new pending request vanished from the
    // calendar badge AND from pendingEditForSession, so the day modal offered "request an edit"
    // again and stacked a duplicate instead of amending. Ordering by created_at instead would
    // need an (epf_number, created_at) composite index that isn't in firestore.indexes.json —
    // undeployed, the query throws and the page's silent catch shows nothing at all. One
    // equality filter needs only the automatic single-field index, so scope it per-person and
    // sort in memory; the result set is bounded by that one employee's own request history.
    const q = query(
      collection(db, 'attendance_edit_requests'),
      where('epf_number', '==', epfNumber),
    );
    const snap = await getDocs(q);
    const requests = snap.docs.map(d => {
      const data = d.data();
      // attendance_id is "EPF_YYYY-MM-DD" — extract the date part for the calendar
      const attId  = data.attendance_id ?? '';
      const datePart = typeof attId === 'string' ? (attId.split('_').pop() ?? '') : '';
      return {
        id:            d.id,
        attendance_id: attId,
        session_id:    data.session_id ?? null,  // which session this request targets
        date:          datePart,  // always a plain "YYYY-MM-DD" string for the calendar
        reason:        data.reason,
        status:        data.status,
        reject_reason: data.reject_reason,
        created_at:    data.created_at?.toDate?.()?.toISOString() ?? '',
        requested: {
          check_in:      data.requested_check_in   ?? null,
          check_out:     data.requested_check_out  ?? null,
          working_place: data.requested_working_place ?? null,
          site_number:   data.requested_site_number ?? null,
        },
      };
    });
    // Newest first, so a same-session history (amended / re-requested after a rejection) surfaces
    // the current request rather than whichever one Firestore happened to return first.
    requests.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { data: { data: { requests } } };
  },

  // Real-time counterpart to getMyEditRequests above — an approver's decision on one of this
  // employee's own Time Change requests (or a brand-new one they just submitted) updates their
  // own calendar/badge instantly. Same pattern as the other subscribe* functions in this file.
  subscribeMyEditRequests: (
    epfNumber: string,
    cb: (requests: unknown[]) => void,
  ): (() => void) => {
    const emit = () => {
      attendanceApi.getMyEditRequests(epfNumber).then((res: any) => {
        const d = res.data?.data ?? res.data;
        cb(Array.isArray(d?.requests) ? d.requests : []);
      }).catch(() => { /* keep showing the last-known list rather than clearing it */ });
    };
    emit();
    return onSnapshot(
      query(collection(db, 'attendance_edit_requests'), where('epf_number', '==', epfNumber)),
      emit,
      (err) => console.warn('subscribeMyEditRequests failed:', err?.message ?? err),
    );
  },

  considerAttendanceEditRequest: async (data: any) => {
    const reqId   = String(data.id);
    const reqRef  = doc(db, 'attendance_edit_requests', reqId);
    const reqSnap = await getDoc(reqRef);
    if (!reqSnap.exists()) throw new Error('Edit request not found');
    const r   = reqSnap.data();
    const now = FSTimestamp.now();

    // Comprehensive Approval Engine — Southern Lanka only (Time Change / Manual Adjustment is
    // one of its four covered actions, alongside Leave, plain Attendance approval, and
    // Suspense: Self-Approval Strict Restriction always; the escalation-ladder route still
    // applies a Toggle Permission Check, the HOD route no longer does — see
    // southernlankaApprovers). Re-derived fresh here on the write path rather than trusted from
    // route_to (stamped at request-creation time, so could be stale by the time it's
    // considered) — mirrors considerLeave's re-validation. Every other tenant is intentionally
    // untouched (route_to / scope visibility only, as before).
    if (tenant.id === 'southernlanka') {
      const considerBy = String(data.epf_number ?? '');
      if (String(r.epf_number) === considerBy) {
        throw new Error('You cannot approve your own request.');
      }
      // force=true — see the matching note in requestAttendanceEdit above.
      const [roles, considererSnap] = await Promise.all([
        getRoles(true),
        getDoc(doc(db, 'users', epfDocId(considerBy))),
      ]);
      const considerer = considererSnap.exists() ? considererSnap.data() : null;
      const considererCaps = resolveUserCapabilities(considerer, roles);
      const isManagement = considererCaps.is_system_admin || considererCaps.can_manage_users || considererCaps.can_manage_leaves;
      if (!isManagement) {
        const [usersSnap, applicantSnap] = await Promise.all([
          getUsersSnapshotCached(),
          getDoc(doc(db, 'users', epfDocId(String(r.epf_number)))),
        ]);
        const applicant = applicantSnap.exists() ? applicantSnap.data() : {};
        const approverEpfs = southernlankaApprovers(
          { epf_number: String(r.epf_number), role: applicant.role, department: applicant.department, company_name: applicant.company_name },
          usersSnap.docs.map((d: any) => d.data()),
          roles,
          'can_approve',
        );
        if (!approverEpfs.includes(considerBy)) {
          throw new Error('You are not authorized to approve this attendance edit request.');
        }
      }
    }

    if (data.action === 'approve') {
      // Apply the requested edit to the latest session of the day's record.
      const patch: Record<string, unknown> = {};
      if (r.requested_check_in)        patch.check_in  = FSTimestamp.fromDate(new Date(r.requested_check_in));
      if (r.requested_check_out)       patch.check_out = FSTimestamp.fromDate(new Date(r.requested_check_out));
      if (r.requested_working_place)   patch.working_place   = r.requested_working_place;
      if (r.requested_site_number !== undefined) patch.site_number = r.requested_site_number;

      const attRef  = doc(db, 'attendances', r.attendance_id);
      const attSnap = await getDoc(attRef);
      if (attSnap.exists()) {
        const attData  = attSnap.data();
        const sessions = sessionsOf(attData);
        if (sessions.length) {
          const idx = r.session_id ? sessions.findIndex(s => s.id === r.session_id) : -1;
          const target = idx >= 0 ? idx : sessions.length - 1;  // fallback: latest session
          // Outstation is auto-derived (technicians) from the effective working place vs that
          // day's base — never from the requested tick. No outstation name/address.
          const epf  = String(attData.epf_number ?? r.epf_number ?? '');
          const date = String(attData.date ?? '');
          const effectivePlace = (patch.working_place as string) ?? sessions[target].working_place;
          let isTech = true;
          try {
            const roles = await getRoles();
            const uSnap = await getDoc(doc(db, 'users', epfDocId(epf)));
            isTech = roleCategory(uSnap.exists() ? uSnap.data().role : undefined, roles) === 'technician';
          } catch { /* assume technician */ }
          const autoRes = isTech ? await autoOutstationByPlace(epf, date, effectivePlace) : null;
          if (autoRes != null) {
            patch.is_outstation       = autoRes;
            patch.is_outstation_auto  = true;
            patch.outstation_name     = null;
            patch.outstation_address  = null;
          } else if (!isTech && r.requested_is_outstation !== null) {
            patch.is_outstation = r.requested_is_outstation;
          }
          // An approved place change joins the session's location history too.
          if (patch.working_place) {
            patch.locations = appendLocation(sessions[target].locations, {
              name:        patch.working_place as string,
              site_number: (patch.site_number as string | null) ?? sessions[target].site_number ?? null,
              source:      'manual',
              added_by:    data.epf_number ?? null,
            });
          }
          // Approving the edit also APPROVES the corrected session — otherwise it keeps
          // showing "pending" after the approver already accepted it (and would still appear
          // in the normal approvals queue, forcing a confusing second approval). Stamp the
          // approver on whichever half the session has; on a FIRST approval derive the morning
          // food allowance from the check-in time (matching the normal approval), but never
          // clobber an already-approved session's (possibly hand-adjusted) allowance.
          let finalCheckIn  = (patch.check_in  as FSTimestamp | undefined) ?? sessions[target].check_in;
          let finalCheckOut = (patch.check_out as FSTimestamp | undefined) ?? sessions[target].check_out;
          // Guard: check-out must be strictly after check-in. The edit-request form's overnight
          // toggle already stamps the requested check-out on the next calendar date, but older
          // requests (submitted before that toggle existed) may still land on or before check-in —
          // that almost always means the shift ran past midnight, not a genuine zero/negative-length
          // day. Roll it to the next calendar day instead of saving a broken session — mirrors the
          // same guard in approveCheckOut / approvePastAttendance.
          if (finalCheckIn && finalCheckOut && finalCheckOut.toMillis() <= finalCheckIn.toMillis()) {
            finalCheckOut = FSTimestamp.fromMillis(finalCheckOut.toMillis() + 24 * 60 * 60 * 1000);
            patch.check_out = finalCheckOut;
          }
          if (finalCheckIn) {
            const wasApproved = sessions[target].check_in_status === 'approved';
            patch.check_in_status      = 'approved';
            patch.check_in_approved_by = data.epf_number ?? null;
            if (!wasApproved) patch.morning_allowance = calcMorningAllowanceFromTs(finalCheckIn);
          }
          if (finalCheckOut) {
            patch.check_out_status      = 'approved';
            patch.check_out_approved_by = data.epf_number ?? null;
          }
          sessions[target] = { ...sessions[target], ...patch };
          await updateDoc(attRef, { sessions, updated_at: now });
        }
      } else if (tenant.id === 'southernlanka' && (r.requested_check_in || r.requested_check_out)) {
        // Missed-punch request (Southern Lanka): the target day has NO record. Approving it
        // CREATES the day's attendance from the requested values — the approver is deciding
        // now, so the new session is stamped approved (same shape as an auto-approved past
        // submission for this tenant, see submitPastAttendance).
        const epf  = String(r.epf_number ?? '');
        const date = String(r.attendance_id ?? '').split('_').pop() ?? '';
        if (epf && date) {
          const uSnap = await getDoc(doc(db, 'users', epfDocId(epf)));
          const u = uSnap.exists() ? uSnap.data() : {};
          let isTech = true;
          try {
            const roles = await getRoles();
            isTech = roleCategory(u.role, roles) === 'technician';
          } catch { /* assume technician */ }
          const place = (r.requested_working_place as string | null) ?? null;
          const autoRes = isTech && place ? await autoOutstationByPlace(epf, date, place) : null;
          const checkInTs  = r.requested_check_in  ? (patch.check_in  as FSTimestamp) : null;
          let   checkOutTs = r.requested_check_out ? (patch.check_out as FSTimestamp) : null;
          if (checkInTs && checkOutTs && checkOutTs.toMillis() <= checkInTs.toMillis()) {
            checkOutTs = FSTimestamp.fromMillis(checkOutTs.toMillis() + 24 * 60 * 60 * 1000);
          }
          const newSess = {
            id:                     newSessionId(),
            check_in:               checkInTs,
            check_out:              checkOutTs,
            _overnight:             (String(r.requested_check_out ?? '').slice(0, 10) || date) > date,
            working_place:          place,
            site_number:            r.requested_site_number ?? null,
            locations:              place
              ? appendLocation([], { name: place, site_number: r.requested_site_number ?? null, source: 'manual', added_by: data.epf_number ?? epf })
              : [],
            is_outstation:          autoRes ?? false,
            is_outstation_auto:     isTech,
            outstation_location_id: null,
            outstation_name:        null,
            outstation_address:     null,
            is_outstation_approved: autoRes ?? false,
            morning_allowance:      checkInTs ? calcMorningAllowanceFromTs(checkInTs) : 0,
            evening_allowance:      0,
            check_in_approved_by:   checkInTs  ? (data.epf_number ?? AUTO_APPROVED_SENTINEL) : null,
            check_out_approved_by:  checkOutTs ? (data.epf_number ?? AUTO_APPROVED_SENTINEL) : null,
            check_in_status:        checkInTs  ? 'approved' : 'pending',
            check_out_status:       checkOutTs ? 'approved' : 'pending',
            is_past_submission:     true,
            past_approved_by:       data.epf_number ?? null,
          };
          await setDoc(attRef, {
            id:           r.attendance_id,
            epf_number:   epf,
            company_id:   u.company_id ?? '',
            company_name: u.company_name ?? '',
            date,
            sessions:     [newSess],
            request_from: [],
            is_past_submission: true,
            created_at:   now,
            updated_at:   now,
          });
        }
      }
    }

    await updateDoc(reqRef, {
      status:        data.action === 'approve' ? 'approved' : 'rejected',
      considered_by: data.epf_number,
      considered_at: now,
      reject_reason: data.reject_reason ?? null,
    });

    // Tell the employee the outcome (skip self-considered requests).
    if (r.epf_number && String(r.epf_number) !== String(data.epf_number ?? '')) {
      const approved = data.action === 'approve';
      const attDate  = String(r.attendance_id ?? '').split('_').pop() ?? '';
      void createAppNotification({
        toEpf:    String(r.epf_number),
        type:     approved ? 'edit_approved' : 'edit_rejected',
        actorEpf: String(data.epf_number ?? ''),
        meta: {
          ...(attDate ? { date: attDate } : {}),
          ...(data.reject_reason ? { reason: String(data.reject_reason) } : {}),
        },
        title: approved ? 'Your attendance edit was approved' : 'Your attendance edit was rejected',
        body:  [attDate, data.reject_reason].filter(Boolean).join(' · '),
        link:  '/attendance',
      });
    }
    return { data: { status: 'Request was successful.' } };
  },
};

// ─── Leave-types cache ────────────────────────────────────────────────────────
// leave_types is small and changes rarely, but getLeaveTypes AND getLeaveSummary each
// read the whole collection — a double read on every leaves/dashboard load. Share one
// cached read (TTL + in-flight coalescing); invalidated on leave-type admin writes.
const LEAVE_TYPES_TTL_MS = 10 * 60 * 1000;
let _ltCache: any[] | null = null;
let _ltCachedAt = 0;
let _ltInflight: Promise<any[]> | null = null;

export function invalidateLeaveTypesCache(): void {
  _ltCache = null;
  _ltCachedAt = 0;
  _ltInflight = null;
}

async function getLeaveTypesRaw(): Promise<any[]> {
  if (_ltCache && Date.now() - _ltCachedAt < LEAVE_TYPES_TTL_MS) return _ltCache;
  if (_ltInflight) return _ltInflight;
  _ltInflight = (async () => {
    const snap = await getDocs(collection(db, 'leave_types'));
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _ltCache = rows;
    _ltCachedAt = Date.now();
    return rows;
  })();
  try { return await _ltInflight; } finally { _ltInflight = null; }
}

// Dynamic Entity Name Resolution — a leave doc stores leave_type_id alongside a denormalized
// leave_type_name snapshot taken when it was applied for. If the Leave Type was renamed
// since, resolve the CURRENT name from the (cached) leave_types collection instead of the
// stale snapshot; fall back to the snapshot when the id is missing (older docs) or no longer
// matches any type (deleted). Build the id→name map ONCE per batch, not per doc. Used by
// every leave-list builder below (getLeaveRequests, buildMyLeavesList, getLeaveDeleteRequests)
// so callers never see a stale name after a rename.
async function leaveTypeNameMap(): Promise<Map<string, string>> {
  const types = await getLeaveTypesRaw().catch(() => [] as any[]);
  return new Map(types.map(t => [String(t.id), String(t.name ?? '')]));
}
function resolveLeaveTypeName(byId: Map<string, string>, leaveTypeId: unknown, fallbackName: unknown): string {
  const id = leaveTypeId ? String(leaveTypeId) : '';
  const live = id ? byId.get(id) : undefined;
  return live || String(fallbackName ?? '');
}

// getMyLeaves is called twice per leaves-page load (Upcoming + Past) — same Firestore
// read + same supervisor-name lookups, differing only in a client-side filter. Coalesce
// concurrent calls for the same EPF into one fetch (pure request dedup, cleared on settle).
const _myLeavesInflight = new Map<string, Promise<any[]>>();
async function buildMyLeavesList(epfNumber: string): Promise<any[]> {
  const existing = _myLeavesInflight.get(epfNumber);
  if (existing) return existing;
  const p = (async () => {
    const snap = await getDocs(query(collection(db, 'leaves'), where('epf_number', '==', epfNumber)));
    // Exclude soft-deleted leaves. When a deletion request removes only SOME dates of a range,
    // the approver marks the original is_deleted and re-creates the kept segments as new docs
    // (see considerLeaveDeletion). Showing the soft-deleted original too duplicates the leave.
    const docs = snap.docs.filter(d => !d.data().is_deleted);
    // Collect unique referenced EPFs to resolve names in one batch.
    const epfSet = new Set<string>();
    docs.forEach(d => {
      if (d.data().supervisor_epf) epfSet.add(d.data().supervisor_epf);
      if (d.data().considered_by)  epfSet.add(d.data().considered_by);
    });
    const nameMap: Record<string, string> = {};
    await Promise.all([...epfSet].map(async epf => {
      try {
        const uSnap = await getDoc(doc(db, 'users', epfDocId(epf)));
        nameMap[epf] = uSnap.exists() ? (uSnap.data().display_name ?? epf) : epf;
      } catch { nameMap[epf] = epf; }
    }));
    // Dynamic Entity Name Resolution — see resolveLeaveTypeName above.
    const typeNameById = await leaveTypeNameMap();
    return docs.map(d => ({
      leave_id:        d.id,
      from_date:       d.data().from_date,
      to_date:         d.data().to_date,
      leave_type_id:   d.data().leave_type_id ?? null,
      leave_type_name: resolveLeaveTypeName(typeNameById, d.data().leave_type_id, d.data().leave_type_name),
      status:          d.data().status,
      reason:          d.data().reason,
      is_half_day:     d.data().is_half_day,
      half_day_period: d.data().half_day_period,
      reject_reason:   d.data().reject_reason,
      // A pending/rejected deletion request stamps the leave itself (see requestLeaveDeletion /
      // considerLeaveDeletion) so the applicant's card shows an in-context tag, not just a bell
      // notification. Cleared implicitly on approve (the leave is soft-deleted and filtered out).
      delete_request_status:       d.data().delete_request_status ?? null,
      delete_request_reason:       d.data().delete_request_reason ?? null,
      delete_request_considered_at: d.data().delete_request_considered_at?.toDate?.()?.toISOString() ?? null,
      requested_from:  d.data().supervisor_epf ? (nameMap[d.data().supervisor_epf] ?? d.data().supervisor_epf) : null,
      consider_by:     d.data().considered_by  ? (nameMap[d.data().considered_by]  ?? d.data().considered_by)  : null,
      requested_at:    d.data().created_at?.toDate?.()?.toISOString()    ?? null,
      considered_at:   d.data().considered_at?.toDate?.()?.toISOString() ?? null,
    }));
  })();
  _myLeavesInflight.set(epfNumber, p);
  try { return await p; } finally { _myLeavesInflight.delete(epfNumber); }
}

// ─── leaveApi ─────────────────────────────────────────────────────────────────
// ─── On-leave reads ───────────────────────────────────────────────────────────
// Three helpers behind getTodayLeaveList and getLeaveRangeList. They exist as ONE copy on
// purpose: the day list and the calendar must never disagree about who a viewer is allowed to
// see, and a scope rule that is written twice is a scope rule that will eventually differ.

/** One person on leave, as both the day list and the calendar consume it. */
export interface OnLeaveRow {
  epf_number:      string;
  name:            string;
  leave_type_name: string;
  is_half_day:     boolean;
  half_day_period: string | null;
  status:          string;
  consider_by:     string | null;
}

/**
 * What this viewer may see. Management and top-of-tree approvers (System Admin, HR, user/leave
 * managers, COO) see EVERY company; everyone else sees their own.
 *
 * Fails OPEN — an unresolvable viewer gets system-wide rather than an empty screen. That is
 * deliberate and load-bearing: the previous version filtered on an exact company_id match in
 * Firestore, which returned NOTHING for a System Admin (who has no company_id), and "admin can't
 * see on-leave" was the bug. Company matching is id OR name because a migrated or seeded leave
 * often carries only one of the two.
 */
async function onLeaveViewerScope(supervisorEpf: string): Promise<{
  systemWide: boolean;
  inMyCompany: (l: any) => boolean;
}> {
  let systemWide = true;
  let viewerCompanyId = '';
  let viewerCompanyName = '';
  try {
    const roles = await getRoles();
    let u: any = {};
    const s1 = await getDocs(query(collection(db, 'users'), where('epf_number', '==', String(supervisorEpf))));
    if (!s1.empty) u = s1.docs[0].data();
    else if (!Number.isNaN(Number(supervisorEpf))) {   // epf may be stored as an integer
      const s2 = await getDocs(query(collection(db, 'users'), where('epf_number', '==', Number(supervisorEpf))));
      if (!s2.empty) u = s2.docs[0].data();
    }
    viewerCompanyId   = String(u.company_id ?? '');
    viewerCompanyName = String(u.company_name ?? '');
    const caps = resolveUserCapabilities(u, roles);
    systemWide = caps.is_system_admin || caps.can_manage_users || caps.can_manage_leaves
              || (caps.can_approve && roleParentName(u.role ?? '', roles) === null);
  } catch { /* leave systemWide = true */ }

  const inMyCompany = (l: any) =>
    (!!viewerCompanyId   && String(l.company_id ?? '')   === viewerCompanyId) ||
    (!!viewerCompanyName && String(l.company_name ?? '') === viewerCompanyName);
  return { systemWide, inMyCompany };
}

/**
 * Approved, non-deleted leaves overlapping [from, to] — ONE read of the collection.
 *
 * Firestore cannot range-filter two different fields in one query, and overlap needs both ends
 * (from_date <= to AND to_date >= from), so the equality filter on status goes to the server and
 * the overlap is applied here. That is still one read for a whole month; the alternative that
 * shipped before was one read of the same set per DAY.
 */
async function approvedLeavesOverlapping(from: string, to: string): Promise<any[]> {
  const snap = await getDocs(query(
    collection(db, 'leaves'),
    where('status', 'in', ['approved', 'accepted', 'accept']),
  ));
  // Accept legacy status spellings ('accept'/'accepted') alongside the current 'approved'.
  const isApproved = (s: unknown) => s === 'approved' || s === 'accepted' || s === 'accept';
  return snap.docs
    .map(s => s.data())
    .filter(l => isApproved(l.status) && !l.is_deleted
      && overlapsWindow({ from_date: String(l.from_date), to_date: String(l.to_date) }, from, to));
}

/** Leave docs → display rows, resolving considered_by through the cached users snapshot so no
 *  row costs its own Firestore read. Order is preserved: the calendar indexes into this. */
async function toOnLeaveRows(rows: any[]): Promise<OnLeaveRow[]> {
  const usersSnap = await getUsersSnapshotCached();
  const nameByEpf = new Map<string, string>();
  usersSnap.docs.forEach((d: any) => nameByEpf.set(String(d.data().epf_number), d.data().display_name ?? String(d.data().epf_number)));
  return rows.map(l => ({
    epf_number:      l.epf_number,
    name:            l.employee_name,
    leave_type_name: l.leave_type_name,
    is_half_day:     l.is_half_day,
    half_day_period: l.half_day_period ?? null,
    status:          'approved',
    consider_by:     l.considered_by ? (nameByEpf.get(String(l.considered_by)) ?? l.considered_by) : null,
  }));
}

export const leaveApi = {
  // Attendance page unpacks: ldata?.can_mark_attendance, ldata?.is_half_day, ldata?.half_day_period
  checkIsTodayLeave: async (epfNumber: string) => {
    const todayStr = today();
    // Avoid 3-field composite index: query by epf+status only, filter dates client-side
    const q = query(
      collection(db, 'leaves'),
      where('epf_number', '==', epfNumber),
      where('status', '==', 'approved'),
    );
    const snap = await getDocs(q);
    // Filter dates client-side
    let todayLeave: any = snap.docs
      .map(d => d.data())
      .find(l => !l.is_deleted && String(l.from_date).slice(0, 10) <= todayStr && String(l.to_date).slice(0, 10) >= todayStr);

    // Also check special leaves stored inside the user doc
    if (!todayLeave) {
      const uSnap = await getDoc(doc(db, 'users', epfDocId(epfNumber)));
      const rules = (uSnap.exists() ? uSnap.data().special_leaves : []) ?? [];
      const wd = new Date(todayStr + 'T00:00:00').getDay();
      const sl = rules.find((r: any) =>
        todayStr >= String(r.from_date).slice(0, 10) && todayStr <= String(r.to_date).slice(0, 10) &&
        (r.recurring_weekday === null || r.recurring_weekday === undefined || r.recurring_weekday === wd)
      );
      if (sl) {
        todayLeave = { is_half_day: false, half_day_period: null, leave_type_name: sl.leave_type };
      }
    }

    if (!todayLeave) {
      return { data: { data: { can_mark_attendance: true, is_half_day: false, half_day_period: null } } };
    }
    const canMark = todayLeave.is_half_day && todayLeave.half_day_period === 'afternoon';
    return {
      data: {
        data: {
          can_mark_attendance: canMark,
          is_half_day:         todayLeave.is_half_day,
          half_day_period:     todayLeave.half_day_period,
          leave_type:          todayLeave.leave_type_name,
        },
      },
    };
  },

  applyLeave: async (data: any) => {
    const now      = FSTimestamp.now();
    const userSnap = await getDoc(doc(db, 'users', epfDocId(data.epf_number)));
    const u        = userSnap.exists() ? userSnap.data() : {};
    // Find leave type by name
    const ltQ   = query(collection(db, 'leave_types'), where('name', '==', data.leave_type));
    const ltSnap = await getDocs(ltQ);
    const lt    = ltSnap.empty ? { id: data.leave_type, is_paid: true, name: data.leave_type } : { id: ltSnap.docs[0].id, ...ltSnap.docs[0].data() };

    const halfPeriod = data.half_day_period === 'morning' || data.half_day_period === 'afternoon'
      ? data.half_day_period : null;

    // Southern Lanka only: no manual "Requested By" pick (see the isSouthernlanka gate on
    // leaves/page.tsx) — routing is automatic instead, via southernlankaApprovers above
    // (Head of Department + every role above the applicant's that can approve leaves).
    // Auto-approved only when that resolves nobody at all (e.g. a root role like COO with no
    // HOD covering their department) — the same "nobody above → auto-approved" behavior the
    // manual-pick model already had for every other tenant.
    const isSouthernlanka = tenant.id === 'southernlanka';
    let supervisorEpf = '';
    let approverEpfs: string[] = [];
    let slRoles: Role[] = [];
    let slUsersData: Array<Record<string, any>> = [];
    if (isSouthernlanka) {
      // force=true — see the matching note in requestAttendanceEdit above.
      const [roles, usersSnap] = await Promise.all([getRoles(true), getUsersSnapshotCached()]);
      slRoles = roles;
      slUsersData = usersSnap.docs.map((d: any) => d.data());
      approverEpfs = southernlankaApprovers(
        { epf_number: data.epf_number, role: u.role, department: u.department, company_name: u.company_name },
        slUsersData,
        roles,
        'can_approve_leaves',
      );

      // ── Conflict + quota validation (Southern Lanka) ─────────────────────────────
      // A new request must not overlap an existing pending/approved leave on ANY calendar
      // date, regardless of leave type or half/full day, and must fit the employee's
      // remaining balance for the chosen type. These are re-checked here on the write path
      // so a direct API call can't bypass the form's own guards.
      const reqFrom = String(data.from_date).slice(0, 10);
      const reqTo   = String(data.to_date).slice(0, 10);
      const reqDateSet = new Set(leaveDatesInRange(reqFrom, reqTo));
      const mineSnap = await getDocs(query(
        collection(db, 'leaves'), where('epf_number', '==', data.epf_number),
      ));
      const activeMine = mineSnap.docs
        .map(d => d.data())
        .filter(l => {
          if (l.is_deleted) return false;
          const st = String(l.status ?? '').toLowerCase();
          return st === 'pending' || st === 'approved';   // rejected/cancelled never block
        });

      const clash = activeMine.find(l =>
        leaveDatesInRange(String(l.from_date).slice(0, 10), String(l.to_date).slice(0, 10))
          .some(dd => reqDateSet.has(dd)),
      );
      if (clash) {
        const cf = String(clash.from_date).slice(0, 10);
        const ct = String(clash.to_date).slice(0, 10);
        throw new Error(
          `A ${String(clash.status).toLowerCase() === 'approved' ? 'approved' : 'pending'} `
          + `${clash.leave_type_name || 'leave'} request already covers `
          + `${cf === ct ? cf : `${cf} – ${ct}`}.`,
        );
      }

      // 12-hour shift cut-off — a directly-applicable leave type must be filed at least 12h
      // before the first shift the leave would cover. Gated on the type's `allow_direct_apply`
      // flag (`lt` is the resolved leave_types doc from above); restricted assign-only types
      // are exempt. Re-checked here so a direct API call can't bypass the form guard.
      if (leaveTypeHasApplyCutoff(lt as { allow_direct_apply?: boolean })) {
        const shifts = await shiftAssignmentsFor(data.epf_number);
        if (shiftCutoffViolation(shifts, reqFrom, reqTo, LEAVE_APPLY_CUTOFF_HOURS)) {
          throw new Error(LEAVE_APPLY_SHIFT_CUTOFF_MSG);
        }
      }

      // Quota: getLeaveSummary already resolves the accrual-aware quota + approved usage per
      // type; also net off same-type PENDING requests so stacked pendings can't collectively
      // exceed the allowance. Paid leaves only (unpaid never draws down the quota).
      if (data.is_paid !== false) {
        const summaryRes: any = await leaveApi.getLeaveSummary(data.epf_number);
        const summaryArr: any[] = summaryRes?.data?.data ?? summaryRes?.data ?? [];
        const entry = Array.isArray(summaryArr)
          ? summaryArr.find(s => s?.leave_type === data.leave_type || s?.type === data.leave_type)
          : null;
        if (entry) {
          const requested = data.is_half_day ? 0.5 : businessDayCount(reqFrom, reqTo);
          let pendingSameType = 0;
          activeMine.forEach(l => {
            if (l.is_paid === false) return;
            if (String(l.status ?? '').toLowerCase() !== 'pending') return;
            if ((l.leave_type_name ?? '') !== data.leave_type) return;
            pendingSameType += l.is_half_day
              ? 0.5
              : businessDayCount(String(l.from_date).slice(0, 10), String(l.to_date).slice(0, 10));
          });
          const available = (Number(entry.total) || 0) - (Number(entry.used) || 0) - pendingSameType;
          if (requested > available + 1e-9) {
            throw new Error(available <= 0
              ? `You have used your full ${data.leave_type} quota — no days remaining.`
              : `Only ${available} day(s) of ${data.leave_type} remain — this request needs ${requested}.`);
          }
        }
      }
    } else {
      supervisorEpf = data.request_from ?? '';
    }
    // Southern Lanka: a submission NEVER auto-approves — it always queues for an approver.
    // When the ladder resolves nobody, a System Admin still sees every pending leave (see
    // getLeaveRequests' isManagement branch) and can act on it.
    const status = isSouthernlanka
      ? 'pending'
      : (supervisorEpf ? 'pending' : 'approved');

    await addDoc(collection(db, 'leaves'), {
      epf_number:      data.epf_number,
      employee_name:   u.display_name ?? data.epf_number,
      company_id:      u.company_id ?? '',
      company_name:    u.company_name ?? '',
      from_date:       data.from_date,
      to_date:         data.to_date,
      leave_type_id:   lt.id,
      leave_type_name: data.leave_type,
      is_half_day:     data.is_half_day ?? false,
      half_day_period: halfPeriod,
      reason:          data.reason ?? '',
      // Leave routes to the explicitly picked upper-tier supervisor (every tenant except
      // Southern Lanka, which resolves approverEpfs above instead — see status/notify below).
      supervisor_epf:  supervisorEpf,
      status,
      considered_by:   null,
      considered_at:   null,
      reject_reason:   null,
      // Honour explicit paid/unpaid choice (medical); otherwise the type's default
      is_paid:         typeof data.is_paid === 'boolean' ? data.is_paid : ((lt as { is_paid?: boolean }).is_paid ?? true),
      category:        'normal',
      assigned_by:     null,
      created_at:      now,
      updated_at:      now,
    });

    // Notify whoever the request routes to. Localized at render time from type+meta;
    // title/body are the fallback.
    const applicant = u.display_name ?? String(data.epf_number);
    // The applicant's own EPF — normalised (trim) so a stray space can never let it slip
    // past the self-exclusion below. This value NEVER goes into the recipient list.
    const applicantEpf = String(data.epf_number ?? '').trim();

    let notifyEpfs: string[];
    if (isSouthernlanka) {
      // Southern Lanka — the recipient set is resolved explicitly from the users collection,
      // by ROLE-NAME STRING (there is no role_id), and is the UNION of:
      //   1. the applicant's department HOD(s)              — southernlankaApprovers, route 1
      //   2. every active HR Assistant / HR Executive / General Manager with leave-approval
      //   3. every active System Admin
      // …then the applicant's own EPF is force-removed. Any one of them can approve; all of
      // them are notified. getLeaveRequests / considerLeave already grant the same people
      // visibility + authority (System Admins via their isManagement bypass).
      const TOP_APPROVER_ROLES = new Set(['General Manager', 'HR Executive', 'HR Assistant']);
      const targetSet = new Set<string>(approverEpfs.map(e => String(e).trim()));   // HOD + ladder
      for (const mu of slUsersData) {
        if (mu.is_active === false || isResigned(mu.date_of_resign)) continue;
        const epf = String(mu.epf_number ?? '').trim();
        if (!epf || epf === applicantEpf) continue;
        const mc = resolveUserCapabilities(mu, slRoles);
        if (TOP_APPROVER_ROLES.has(String(mu.role)) || mc.is_system_admin) targetSet.add(epf);
      }
      notifyEpfs = [...targetSet];
    } else {
      notifyEpfs = supervisorEpf && String(supervisorEpf).trim() !== applicantEpf ? [String(supervisorEpf).trim()] : [];
    }

    // Dispatch-point guarantee: de-dupe, drop blanks, and NEVER include the applicant —
    // regardless of what any resolver above returned.
    [...new Set(notifyEpfs.map(s => String(s).trim()))]
      .filter(epf => epf && epf !== applicantEpf)
      .forEach(epf => {
        void createAppNotification({
          toEpf:     epf,
          type:      'leave_request',
          actorEpf:  applicantEpf,
          actorName: String(applicant),
          meta: {
            leave_type: String(data.leave_type ?? ''),
            from: String(data.from_date ?? ''),
            to:   String(data.to_date ?? ''),
            ...(data.reason ? { reason: String(data.reason) } : {}),
          },
          title: `${applicant} applied for leave`,
          body:  [data.leave_type, `${data.from_date} → ${data.to_date}`, data.reason].filter(Boolean).join(' · '),
          link:  '/leaves',
        });
      });
    return { data: { status: 'Request was successful.' } };
  },

  removeLeave: async (id: number | string) => {
    await deleteDoc(doc(db, 'leaves', String(id)));
    return { data: { status: 'Request was successful.' } };
  },

  // ── Leave-deletion requests ──────────────────────────────────────────────────
  // An employee requests to delete an APPROVED leave (whole leave, or specific dates of a
  // range). Routes to the leave's approver (supervisor_epf); management also sees them.
  requestLeaveDeletion: async (data: any) => {
    const now      = FSTimestamp.now();
    const leaveRef = doc(db, 'leaves', String(data.leave_id));
    const snap     = await getDoc(leaveRef);
    if (!snap.exists()) throw new Error('Leave not found');
    const l = snap.data();
    if (String(l.epf_number) !== String(data.epf_number)) throw new Error('You can only request to delete your own leave');
    if (!['approved', 'accepted', 'accept'].includes(String(l.status).toLowerCase())) {
      throw new Error('Only approved leaves need a deletion request');
    }
    const from = String(l.from_date).slice(0, 10);
    const to   = String(l.to_date).slice(0, 10);
    const allDates = leaveDatesInRange(from, to);
    const removeAll = !!data.remove_all;
    const requested = removeAll
      ? allDates
      : (Array.isArray(data.requested_dates) ? data.requested_dates.map(String).filter((d: string) => allDates.includes(d)) : []);
    if (requested.length === 0) throw new Error('Select at least one date to remove');

    // Southern Lanka — a deletion request for a directly-applicable leave type must be filed at
    // least 3h before the start of the shift on the affected day(s). Gated on the leave type's
    // `allow_direct_apply` flag (resolved by id, then name, from the cached leave_types);
    // restricted assign-only types are exempt. Re-checked here so a direct API call can't
    // bypass the form.
    if (tenant.id === 'southernlanka') {
      const ltRows = await getLeaveTypesRaw().catch(() => [] as any[]);
      const delType = ltRows.find(t => String(t.id) === String(l.leave_type_id ?? ''))
        ?? ltRows.find(t => String(t.name ?? '') === String(l.leave_type_name ?? ''));
      if (leaveTypeHasApplyCutoff(delType)) {
        const scoped = [...requested].sort();
        const shifts = await shiftAssignmentsFor(String(l.epf_number));
        if (shiftCutoffViolation(shifts, scoped[0], scoped[scoped.length - 1], LEAVE_DELETION_CUTOFF_HOURS)) {
          throw new Error(LEAVE_DELETION_SHIFT_CUTOFF_MSG);
        }
      }
    }

    // Southern Lanka only: the original leave never carried a supervisor_epf (see
    // applyLeave) — resolve the SAME two routes (HOD + role-tree above) from the owner's
    // CURRENT department/role, same as a fresh leave request.
    const isSouthernlanka = tenant.id === 'southernlanka';
    let supervisorEpf = '';
    let approverEpfs: string[] = [];
    if (isSouthernlanka) {
      const ownerSnap = await getDoc(doc(db, 'users', epfDocId(String(l.epf_number))));
      const owner = ownerSnap.exists() ? ownerSnap.data() : {};
      // force=true — see the matching note in requestAttendanceEdit above.
      const [roles, usersSnap] = await Promise.all([getRoles(true), getUsersSnapshotCached()]);
      approverEpfs = southernlankaApprovers(
        { epf_number: String(l.epf_number), role: owner.role, department: owner.department, company_name: owner.company_name },
        usersSnap.docs.map((d: any) => d.data()),
        roles,
        'can_approve_leaves',
      );
    } else {
      supervisorEpf = String(l.supervisor_epf ?? '');
    }

    const ref = await addDoc(collection(db, 'leave_delete_requests'), {
      leave_id:        String(data.leave_id),
      epf_number:      l.epf_number,
      employee_name:   l.employee_name ?? l.epf_number,
      company_id:      l.company_id ?? '',
      leave_type_id:   l.leave_type_id ?? null,
      leave_type_name: l.leave_type_name ?? '',
      from_date:       from,
      to_date:         to,
      remove_all:      removeAll || requested.length === allDates.length,
      requested_dates: requested,
      reason:          data.reason ?? '',
      supervisor_epf:  supervisorEpf,
      status:          'pending',
      considered_by:   null,
      considered_at:   null,
      reject_reason:   null,
      created_at:      now,
      updated_at:      now,
    });

    // Mark the leave itself so its card shows a "Deletion requested" tag while pending (and so
    // a stale "rejected" stamp from an earlier, re-submitted request is cleared). Best-effort.
    await updateDoc(leaveRef, {
      delete_request_status:        'pending',
      delete_request_reason:        null,
      delete_request_considered_at: null,
      updated_at:                   now,
    }).catch(() => {});

    const who = String(l.employee_name ?? data.epf_number);
    const requesterEpf = String(data.epf_number);
    const notifyEpfs = isSouthernlanka
      ? approverEpfs
      : (supervisorEpf && String(supervisorEpf) !== requesterEpf ? [supervisorEpf] : []);
    // Same dispatch-point guarantee as applyLeave: never notify the requester about their own
    // deletion request, and de-dupe recipients.
    [...new Set(notifyEpfs.map(String))]
      .filter(epf => epf && epf !== requesterEpf)
      .forEach(epf => {
        void createAppNotification({
          toEpf:     epf,
          // Distinct from 'leave_request' — see the AppNotifType comment in notificationService.ts —
          // so the bell never mislabels this as a new leave APPLICATION.
          type:      'leave_delete_request',
          actorEpf:  requesterEpf,
          actorName: who,
          meta:      { leave_type: String(l.leave_type_name ?? ''), from, to },
          title:     `${who} requested to delete a leave`,
          body:      [l.leave_type_name, `${from} → ${to}`, removeAll ? 'entire leave' : `${requested.length} date(s)`].filter(Boolean).join(' · '),
          link:      '/leaves?tab=delete',
        });
      });
    return { data: { status: 'Request was successful.', id: ref.id } };
  },

  // Pending leave-deletion requests routed to this approver (management sees all). Index-free:
  // a single equality filter, remaining conditions applied client-side.
  getLeaveDeleteRequests: async (supervisorEpf: string) => {
    // force=true — see the matching note in requestAttendanceEdit above. This is the read
    // path a viewer's Team Requests tab depends on, so it must never show a stale "you can't
    // see this" just because the in-memory roles cache hasn't refreshed yet.
    const [roles, usersSnap] = await Promise.all([getRoles(true), getUsersSnapshotCached()]);
    const nameByEpf = new Map<string, string>();
    const deptByEpf = new Map<string, string>();
    const roleByEpf = new Map<string, string>();
    const companyByEpf = new Map<string, string>();
    usersSnap.docs.forEach(d => {
      const u = d.data();
      const epf = String(u.epf_number);
      nameByEpf.set(epf, u.display_name ?? epf);
      if (u.department)   deptByEpf.set(epf, String(u.department));
      if (u.role)         roleByEpf.set(epf, String(u.role));
      if (u.company_name) companyByEpf.set(epf, String(u.company_name));
    });
    const meDoc = usersSnap.docs.find(d => String(d.data().epf_number) === String(supervisorEpf))?.data();
    const meRole = meDoc?.role ?? '';
    const caps   = resolveUserCapabilities(meDoc, roles);
    const isManagement = caps.is_system_admin || caps.can_manage_users || caps.can_manage_leaves;
    const isSouthernlanka = tenant.id === 'southernlanka';
    if (!isManagement && !isSouthernlanka && !caps.can_approve_leaves) return { data: { data: { requests: [] } } };

    const snap = (isManagement || isSouthernlanka)
      ? await getDocs(query(collection(db, 'leave_delete_requests'), where('status', '==', 'pending')))
      : await getDocs(query(collection(db, 'leave_delete_requests'), where('supervisor_epf', '==', String(supervisorEpf))));

    // Southern Lanka only — visibility must exactly mirror who southernlankaApprovers() would
    // actually resolve for each applicant (department HOD, else the fixed escalation ladder —
    // see the Comprehensive Approval Engine comment above southernlankaApprovers). Reusing that
    // SAME function (rather than a separate parallel approximation) guarantees a request is
    // never shown to someone who considerLeaveDeletion would then refuse to let them act on —
    // cached per applicant since several requests can share one.
    const allUsersData = usersSnap.docs.map(d => d.data());
    const approversCache = new Map<string, Set<string>>();
    const canSeeApplicant = (applicantEpf: string): boolean => {
      if (!approversCache.has(applicantEpf)) {
        const applicant = {
          epf_number: applicantEpf,
          role: roleByEpf.get(applicantEpf),
          department: deptByEpf.get(applicantEpf),
          company_name: companyByEpf.get(applicantEpf),
        };
        approversCache.set(applicantEpf, new Set(southernlankaApprovers(applicant, allUsersData, roles, 'can_approve_leaves')));
      }
      return approversCache.get(applicantEpf)!.has(String(supervisorEpf));
    };

    // Dynamic Entity Name Resolution — see resolveLeaveTypeName above. Older delete-request
    // docs predate leave_type_id (see requestLeaveDeletion) and simply fall back to their
    // stored snapshot, same as everywhere else this helper's used.
    const typeNameById = await leaveTypeNameMap();

    const requests = snap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(r => {
        if (r.status !== 'pending' || String(r.epf_number) === String(supervisorEpf)) return false;
        if (isManagement) return true;
        if (!isSouthernlanka) return true; // supervisor_epf query already scoped the rest
        return canSeeApplicant(String(r.epf_number));
      })
      .map(r => ({
        id:              r.id,
        leave_id:        r.leave_id,
        epf_number:      r.epf_number,
        employee_name:   r.employee_name,
        leave_type_id:   r.leave_type_id ?? null,
        leave_type_name: resolveLeaveTypeName(typeNameById, r.leave_type_id, r.leave_type_name),
        from_date:       r.from_date,
        to_date:         r.to_date,
        remove_all:      !!r.remove_all,
        requested_dates: Array.isArray(r.requested_dates) ? r.requested_dates : [],
        reason:          r.reason ?? '',
        supervisor_epf:  r.supervisor_epf ?? null,
        requested_from:  r.supervisor_epf ? (nameByEpf.get(String(r.supervisor_epf)) ?? r.supervisor_epf) : null,
        requested_at:    r.created_at?.toDate?.()?.toISOString() ?? null,
        status:          r.status,
      }))
      .sort((a, b) => String(b.requested_at ?? '').localeCompare(String(a.requested_at ?? '')));
    return { data: { data: { requests } } };
  },

  // Real-time counterpart to getLeaveDeleteRequests above — same pattern as
  // subscribeLeaveRequests: listen on the same 'pending' query, re-resolve the full scoped
  // result via getLeaveDeleteRequests itself on every change. See that function's block
  // comment above for the full rationale (drift-proof, cheap thanks to existing TTL caches).
  subscribeLeaveDeleteRequests: (
    supervisorEpf: string,
    cb: (requests: any[]) => void,
  ): (() => void) => {
    const emit = () => {
      leaveApi.getLeaveDeleteRequests(supervisorEpf).then((res: any) => {
        const d = res.data?.data ?? res.data;
        cb(Array.isArray(d?.requests) ? d.requests : []);
      }).catch(() => { /* keep showing the last-known list rather than clearing it */ });
    };
    emit();
    return onSnapshot(
      query(collection(db, 'leave_delete_requests'), where('status', '==', 'pending')),
      emit,
      (err) => console.warn('subscribeLeaveDeleteRequests failed:', err?.message ?? err),
    );
  },

  // Approve (soft-delete the leave; split off any kept dates into new approved leave docs) or
  // reject a leave-deletion request.
  considerLeaveDeletion: async (data: any) => {
    const now    = FSTimestamp.now();
    const reqRef = doc(db, 'leave_delete_requests', String(data.id));
    const reqSnap = await getDoc(reqRef);
    if (!reqSnap.exists()) throw new Error('Request not found');
    const r = reqSnap.data();

    // Comprehensive Approval Engine — Southern Lanka only. A leave-deletion request is part of
    // the same Leave Approvals action the engine covers, so it gets the identical treatment as
    // considerLeave: Self-Approval Strict Restriction (unconditional, even for management) +
    // re-derived department-HOD/escalation-ladder authorization on the write path.
    if (tenant.id === 'southernlanka') {
      const considerBy = String(data.consider_by ?? '');
      if (String(r.epf_number) === considerBy) {
        throw new Error('You cannot approve your own request.');
      }
      // force=true — see the matching note in requestAttendanceEdit above.
      const [roles, considererSnap] = await Promise.all([
        getRoles(true),
        getDoc(doc(db, 'users', epfDocId(considerBy))),
      ]);
      const considerer = considererSnap.exists() ? considererSnap.data() : null;
      const considererCaps = resolveUserCapabilities(considerer, roles);
      const isManagement = considererCaps.is_system_admin || considererCaps.can_manage_users || considererCaps.can_manage_leaves;
      if (!isManagement) {
        const [usersSnap, applicantSnap] = await Promise.all([
          getUsersSnapshotCached(),
          getDoc(doc(db, 'users', epfDocId(String(r.epf_number)))),
        ]);
        const applicant = applicantSnap.exists() ? applicantSnap.data() : {};
        const approverEpfs = southernlankaApprovers(
          { epf_number: String(r.epf_number), role: applicant.role, department: applicant.department, company_name: applicant.company_name },
          usersSnap.docs.map((d: any) => d.data()),
          roles,
          'can_approve_leaves',
        );
        if (!approverEpfs.includes(considerBy)) {
          throw new Error('You are not authorized to approve this request.');
        }
      }
    }

    if (data.action === 'approve') {
      const leaveRef  = doc(db, 'leaves', String(r.leave_id));
      const leaveSnap = await getDoc(leaveRef);
      if (leaveSnap.exists()) {
        const l = leaveSnap.data();
        const from = String(l.from_date).slice(0, 10);
        const to   = String(l.to_date).slice(0, 10);
        const removeSet = new Set((Array.isArray(r.requested_dates) ? r.requested_dates : []).map(String));
        const remaining = leaveDatesInRange(from, to).filter(d => !removeSet.has(d));
        // Soft-delete the original leave (kept for audit); deleted_by = the approver.
        await updateDoc(leaveRef, {
          is_deleted:    true,
          deleted_by:    data.consider_by ?? null,
          deleted_at:    now,
          delete_reason: `Deletion request approved${r.reason ? `: ${r.reason}` : ''}`,
          updated_at:    now,
        });
        // Re-create approved leave(s) for the kept, contiguous date segments (the "split").
        // Half-day leaves are single-day, so there is never a remainder to split.
        if (remaining.length > 0 && !l.is_half_day) {
          for (const seg of contiguousSegments(remaining)) {
            await addDoc(collection(db, 'leaves'), {
              epf_number:      l.epf_number,
              employee_name:   l.employee_name ?? l.epf_number,
              company_id:      l.company_id ?? '',
              company_name:    l.company_name ?? '',
              from_date:       seg[0],
              to_date:         seg[seg.length - 1],
              leave_type_id:   l.leave_type_id ?? '',
              leave_type_name: l.leave_type_name ?? '',
              is_half_day:     false,
              half_day_period: null,
              reason:          l.reason ?? '',
              supervisor_epf:  l.supervisor_epf ?? '',
              status:          'approved',
              considered_by:   l.considered_by ?? data.consider_by ?? null,
              considered_at:   l.considered_at ?? now,
              reject_reason:   null,
              is_paid:         l.is_paid ?? true,
              category:        l.category ?? 'normal',
              assigned_by:     l.assigned_by ?? null,
              split_from:      String(r.leave_id),
              created_at:      now,
              updated_at:      now,
            });
          }
        }
      }
    } else {
      // Reject: the leave is untouched, but stamp it so the applicant's card carries an
      // in-context "Deletion rejected" tag — not only a bell notification. Cleared if they
      // submit a fresh deletion request later (see requestLeaveDeletion). Best-effort.
      await updateDoc(doc(db, 'leaves', String(r.leave_id)), {
        delete_request_status:        'rejected',
        delete_request_reason:        data.reject_reason ?? null,
        delete_request_considered_at: now,
        updated_at:                   now,
      }).catch(() => {});
    }

    await updateDoc(reqRef, {
      status:        data.action === 'approve' ? 'approved' : 'rejected',
      considered_by: data.consider_by ?? null,
      considered_at: now,
      reject_reason: data.reject_reason ?? null,
      updated_at:    now,
    });

    if (r.epf_number && String(r.epf_number) !== String(data.consider_by ?? '')) {
      const approved = data.action === 'approve';
      void createAppNotification({
        toEpf:     String(r.epf_number),
        // Distinct from 'leave_approved'/'leave_rejected' — see the AppNotifType comment in
        // notificationService.ts — so the bell never mislabels this as a new leave
        // APPLICATION's outcome; the approver's name still surfaces via actorEpf, same
        // convention as leave_approved/edit_approved.
        type:      approved ? 'leave_delete_approved' : 'leave_delete_rejected',
        actorEpf:  String(data.consider_by ?? ''),
        meta:      { leave_type: String(r.leave_type_name ?? ''), from: String(r.from_date), to: String(r.to_date) },
        title:     `Leave deletion ${approved ? 'approved' : 'rejected'}`,
        body:      [r.leave_type_name, `${r.from_date} → ${r.to_date}`, data.reject_reason].filter(Boolean).join(' · '),
        link:      '/leaves',
      });
    }
    return { data: { status: 'Request was successful.' } };
  },

  updateLeave: async (data: any) => {
    await updateDoc(doc(db, 'leaves', String(data.leave_id)), {
      from_date:       data.from_date,
      to_date:         data.to_date,
      leave_type_name: data.leave_type,
      supervisor_epf:  data.request_from,
      reason:          data.reason ?? '',
      status:          'pending',
      updated_at:      FSTimestamp.now(),
    });
    return { data: { status: 'Request was successful.' } };
  },

  // Leaves page unpacks: d?.leave_types ?? d
  // Returns full leave-type objects (name + config flags) so the apply form
  // can enforce reason/backdate/paid-choice rules.
  getLeaveTypes: async () => {
    const rows = await getLeaveTypesRaw();
    const leave_types = rows
      .filter(t => t.is_active !== false)
      .map(t => {
        return {
          id:                  t.id,
          name:                t.name as string,
          is_paid:             t.is_paid ?? true,
          requires_reason:     t.requires_reason ?? false,
          allow_backdate_days: t.allow_backdate_days ?? 0,
          allow_unpaid_choice: t.allow_unpaid_choice ?? false,
          // Southern Lanka: false hides the type from the "Apply Leave" picker (still on cards).
          allow_direct_apply:  t.allow_direct_apply ?? true,
          // Southern Lanka: the Intern/Trainee first-year 0.5-day/month accrual target. The
          // leaves page offers it only while the balance is scoped to it (service < 1 year).
          is_trainee_accruable: t.is_trainee_accruable === true,
          // Tracked but not an entitlement (see LeaveType.excluded_from_quota): it draws no
          // quota, so the apply form must not annotate it with a balance or refuse it as
          // exhausted. Still offered in the picker — people do apply for it.
          excluded_from_quota: t.excluded_from_quota === true,
          annual_quota:        t.annual_quota ?? null,
          quotas:              t.quotas ?? {},
          quota_tech:          t.quota_tech ?? t.annual_quota ?? 0,
          quota_nontech:       t.quota_nontech ?? t.annual_quota ?? 0,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { data: { data: { leave_types } } };
  },

  // Dashboard + leaves page: setLeaveSummary(d) → array of {leave_type, total, used, remaining}
  getLeaveSummary: async (epfNumber: string) => {
    const year     = new Date().getFullYear();
    const yearStart = `${year}-01-01`;
    const yearEnd   = `${year}-12-31`;
    const todayStr  = today();

    // Employee's role drives the quota: a per-role override on the leave type wins,
    // otherwise the default (annual_quota), otherwise the legacy tech/non-tech bucket
    // (non-approver staff = tech, approver roles = non-tech).
    const roles    = await getRoles();
    const empSnap  = await getDoc(doc(db, 'users', epfDocId(epfNumber)));
    const empData  = empSnap.exists() ? empSnap.data() : {};
    const empRole  = empData.role ?? 'Technician';
    const isTech   = !roleCan(empRole, 'can_approve', roles);

    // Fetch leave types (shared cache) and approved leaves for this year in parallel
    const [ltRows, leavesSnap] = await Promise.all([
      getLeaveTypesRaw(),
      // Query approved leaves for this employee this year
      getDocs(query(
        collection(db, 'leaves'),
        where('epf_number', '==', epfNumber),
        where('status',     '==', 'approved'),
      )),
    ]);

    // Southern Lanka only — see firstYearAccrualWindow above. null for every other tenant,
    // for employee types it doesn't cover, and once the employee's first year is over. The
    // Intern/Trainee target type is resolved from config here (is_trainee_accruable) — no
    // leave-type name is hardcoded.
    const traineeAccrualType = ltRows.find(t => t.is_active !== false && t.is_trainee_accruable === true)?.name ?? '';
    // Whether THIS employee is themselves on the Intern/Trainee accrual track — is_trainee_accruable
    // describes how the flagged type accrues for that track, not who else may hold it.
    const isTraineeTrack = ['Intern', 'Trainee'].includes(String(empData.employee_type));
    const accrualWindow = tenant.id === 'southernlanka'
      ? firstYearAccrualWindow(empData.employee_type, empData.date_of_join, todayStr, String(traineeAccrualType))
      : null;

    // Types that are TRACKED but are not entitlements (see LeaveType.excluded_from_quota).
    // They are deliberately left OUT of `summary` altogether rather than emitted with a zero
    // quota. Two things fall out of that for free: every consumer that sums the rows stops
    // counting them without knowing they exist, and every guard that looks a type up BY NAME —
    // the apply form's quota check, the leave-type picker's "exhausted" disable, createLeave's
    // own re-check — finds nothing and lets the request through, which is what uncapped has to
    // mean. A zero-quota row would have read as "exhausted" to all three and blocked the type
    // entirely. Their days surface separately, as `excluded_leave_types`.
    const excludedNames = excludedLeaveTypeNames(ltRows);

    // Helper: count business days between two date strings inclusive
    function countDays(from: string, to: string, isHalfDay: boolean): number {
      if (isHalfDay) return 0.5;
      const f = new Date(from), t = new Date(to);
      let days = 0;
      for (let d = new Date(f); d <= t; d.setDate(d.getDate() + 1)) {
        const day = d.getDay();
        if (day !== 0 && day !== 6) days++; // exclude weekends
      }
      return days;
    }

    // Build used days per leave_type_name for this year.
    // Only PAID leaves consume the annual quota; unpaid (e.g. unpaid medical
    // or unpaid special leave) don't reduce the paid balance.
    // Southern Lanka only: the employee's first-year accrual type (accrualWindow.leaveTypeName —
    // Casual Leaves for Intern/Trainee, Annual Leaves for first-year Permanent) also gets a
    // separate tally scoped to the first-year window (join date → the anniversary) instead of the calendar
    // year — the window spans two calendar years for anyone who joined outside January, and
    // usage must draw against the SAME accrued pool across that boundary, not reset at Jan 1.
    const usedByType: Record<string, number> = {};
    // Days TAKEN on a non-entitlement type. Counted paid and unpaid alike: the paid/unpaid split
    // exists to decide what draws down a quota, and this type has none — what is being reported
    // is simply how many days the person was away. Same unit as the quota figures it sits beside
    // (working days, clamped to the calendar year) so one card never mixes two day-counts.
    const takenByExcluded: Record<string, number> = {};
    let firstYearUsed = 0;
    leavesSnap.docs.forEach(d => {
      const l = d.data();
      if (l.is_deleted) return;        // soft-deleted leaves no longer consume quota
      // from_date/to_date may be ISO datetimes → use the date part only so day-counting and
      // the year/window clamps are exact.
      const lf = String(l.from_date).slice(0, 10);
      const lt = String(l.to_date).slice(0, 10);
      const name = l.leave_type_name ?? '';

      // Before the paid/unpaid gate, not after it — an unpaid medical day is still a day taken,
      // and this tally is a count of absence rather than a draw on an allowance.
      if (isExcludedTypeName(excludedNames, name)) {
        const from = lf > yearStart ? lf : yearStart;
        const to   = lt < yearEnd   ? lt : yearEnd;
        if (from <= to) {
          takenByExcluded[name] = (takenByExcluded[name] ?? 0) + countDays(from, to, !!l.is_half_day);
        }
        return; // never reaches usedByType: this type draws on nothing
      }
      if (l.is_paid === false) return; // unpaid leaves don't deduct from quota

      if (accrualWindow && name === accrualWindow.leaveTypeName) {
        const from = lf > accrualWindow.windowStartStr ? lf : accrualWindow.windowStartStr;
        const to   = lt < accrualWindow.windowEndStr   ? lt : accrualWindow.windowEndStr;
        if (from <= to) firstYearUsed += countDays(from, to, !!l.is_half_day);
        return; // this type is entirely accrual-scoped for this employee — skip the year tally
      }

      const from = lf > yearStart ? lf : yearStart;
      const to   = lt < yearEnd   ? lt : yearEnd;
      if (from > to) return;
      const days = countDays(from, to, !!l.is_half_day);
      usedByType[name] = (usedByType[name] ?? 0) + days;
    });

    // Count pending leave days (half-day = 0.5, full day = actual days)
    const pendingSnap = await getDocs(query(
      collection(db, 'leaves'),
      where('epf_number', '==', epfNumber),
      where('status',     '==', 'pending'),
    ));
    let pendingDays = 0;
    let pendingFullDays = 0;
    let pendingHalfDays = 0;
    // Pending days that will actually draw on an entitlement once approved — two different
    // questions that used to share one number. `pendingDays` stays "everything awaiting a
    // decision", which is what the dashboard's Pending card counts and what an approver's
    // backlog means; a pending medical request belongs there. The quota METER needs the other
    // figure, because a pending day on a non-entitlement type would otherwise eat a free
    // segment it can never consume and shrink a balance that was never at risk.
    let pendingQuotaDays = 0;
    pendingSnap.docs.forEach(d => {
      const l = d.data();
      if (l.is_deleted) return;        // soft-deleted leaves don't count as pending
      const drawsQuota = !isExcludedTypeName(excludedNames, l.leave_type_name);
      if (l.is_half_day) {
        pendingDays += 0.5;
        pendingHalfDays++;
        if (drawsQuota) pendingQuotaDays += 0.5;
      } else {
        const days = countDays(String(l.from_date).slice(0, 10), String(l.to_date).slice(0, 10), false);
        pendingDays     += days;
        pendingFullDays += days;
        if (drawsQuota) pendingQuotaDays += days;
      }
    });
    const pendingLeaves      = Math.round(pendingDays * 2) / 2;
    const pendingQuotaLeaves = Math.round(pendingQuotaDays * 2) / 2;

    const summary = ltRows
      .filter(lt => lt.is_active !== false)
      // Non-entitlement types never become a quota row — see excludedNames above. This is the
      // one line that keeps them out of every total, every meter and every exhaustion check.
      .filter(lt => lt.excluded_from_quota !== true)
      // Southern Lanka first-year window: only the accrual type is shown at all — every
      // other leave type is hidden from this employee's balance until their first year is
      // over (see firstYearAccrualWindow above). Fails open if accrualWindow.leaveTypeName
      // doesn't match any configured type name, so a naming mismatch shows everything rather
      // than silently leaving the employee with nothing to apply for.
      .filter(lt => !accrualWindow
        || lt.name === accrualWindow.leaveTypeName
        || !ltRows.some(x => x.is_active !== false && x.name === accrualWindow.leaveTypeName))
      // NOTE: is_trainee_accruable itself never excludes a type here. It only changes HOW the
      // one type it's set on accrues for an Intern/Trainee currently inside their first-year
      // window (the special quota branch below) — the filter above already narrows a
      // first-year employee down to exactly that one type; outside that window (Permanent, or
      // a Trainee whose window has closed) every active type is shown with its normal quota,
      // is_trainee_accruable or not. A second filter keyed on the flag directly was tried here
      // and wrongly hid the flagged type from everyone who wasn't currently in that exact
      // window — don't reintroduce it.
      .map(lt => {
        const name = lt.name as string;
        // Southern Lanka first-year accrual (see firstYearAccrualWindow above) replaces the
        // normal quota for exactly this one type, for this one employee, while they're still
        // within their first 12 months — every other type/employee/tenant is untouched below.
        if (accrualWindow && name === accrualWindow.leaveTypeName) {
          const quota = accrualWindow.monthsAccrued * FIRST_YEAR_MONTHLY_ACCRUAL;
          const used  = Math.round(firstYearUsed * 2) / 2; // round to 0.5
          const remaining = Math.max(0, quota - used);
          return {
            leave_type: name, type: name, total: quota, used, remaining, available: remaining,
          };
        }
        // Per-role override → default (annual_quota) → legacy tech/non-tech bucket → 0.
        const quota = lt.quotas?.[empRole]
                   ?? lt.annual_quota
                   ?? (isTech ? lt.quota_tech : lt.quota_nontech)
                   ?? 0;
        const used  = Math.round((usedByType[name] ?? 0) * 2) / 2; // round to 0.5
        const remaining = Math.max(0, quota - used);
        return {
          leave_type: name,   // used by dashboard
          type:       name,   // alias
          total:      quota,
          used,
          remaining,
          available:  remaining, // used by leaves page lb.available
        };
      });

    // Total remaining across all leave types (used by dashboard leave_balance card).
    // `summary` no longer contains non-entitlement types, so this is already quota-only.
    const totalRemaining = summary.reduce((s, l) => s + l.remaining, 0);

    // The non-entitlement types: a name and the days taken this year. See leaveQuotaScope.ts for
    // why every one of them is listed, zero included.
    const excludedLeaveTypes = excludedTakenRows(excludedNames, takenByExcluded);

    // Return array AND dashboard fields at top level
    return {
      data: {
        data: Object.assign([...summary], {
          leave_balance:       totalRemaining,
          pending_leaves:      pendingLeaves,
          // Pending days that will draw on a quota — what the balance METERS use. Differs from
          // pending_leaves only when a non-entitlement type has something pending; see above.
          pending_leaves_quota: pendingQuotaLeaves,
          // Tracked-but-not-entitled types: [{ leave_type, type, taken }]. Shown as a days-taken
          // count beside the balance, never folded into it.
          excluded_leave_types: excludedLeaveTypes,
          accepted_leaves:     leavesSnap.docs.length,
          balance_full_days:   Math.floor(totalRemaining),
          balance_half_days:   (totalRemaining % 1 >= 0.5) ? 1 : 0,
          pending_full_leaves: pendingFullDays,
          pending_half_leaves: pendingHalfDays,
          // Southern Lanka only — lets the leaves page enforce "trainee sees ONLY the
          // accrual type" deterministically from employee_type/date_of_join (computed here,
          // server-side, where both are actually available) instead of inferring it from the
          // shape of `summary` (e.g. "array has exactly one entry"), which breaks the moment
          // a tenant happens to have only one active leave type configured for any other reason.
          is_trainee_first_year: isTraineeTrack && !!accrualWindow,
          trainee_accrual_type:  traineeAccrualType || null,
        }),
      },
    };
  },

  // Attendance calendar: inner?.leave_dates ?? []  (array of "YYYY-MM-DD" strings)
  getThisMonthLeaves: async (epfNumber: string, month?: number, year?: number) => {
    const now    = new Date();
    const y      = year  ?? now.getFullYear();
    const m      = month ?? now.getMonth() + 1;
    const start  = `${y}-${String(m).padStart(2, '0')}-01`;
    const end    = `${y}-${String(m).padStart(2, '0')}-31`;
    // Query by epf+status only — filter dates client-side to avoid composite index
    const q = query(
      collection(db, 'leaves'),
      where('epf_number', '==', epfNumber),
      where('status', '==', 'approved'),
    );
    const snap = await getDocs(q);
    // Build all dates covered by each leave that overlaps this month
    const leave_dates: string[] = [];
    for (const d of snap.docs) {
      const data = d.data();
      if (data.is_deleted) continue;   // soft-deleted leaves are no longer on the calendar
      const { from_date, to_date } = data;
      // Only include leaves that overlap with the requested month
      if (to_date < start || from_date > end) continue;
      const from = new Date(Math.max(new Date(from_date).getTime(), new Date(start).getTime()));
      const to   = new Date(Math.min(new Date(to_date).getTime(),   new Date(end).getTime()));
      for (let dt = new Date(from); dt <= to; dt.setDate(dt.getDate() + 1)) {
        leave_dates.push(format(dt, 'yyyy-MM-dd'));
      }
    }
    return { data: { data: { leave_dates } } };
  },

  // Leaves page unpacks: d?.leaves ?? d ?? []
  getMyLeaves: async (epfNumber: string, state?: 'Upcoming' | 'Past') => {
    const todayStr = today();
    // Shared, coalesced fetch (see buildMyLeavesList) so the page's parallel
    // Upcoming + Past calls hit Firestore once. filter() returns a new array, so the
    // sort below never mutates the shared list.
    const all = await buildMyLeavesList(epfNumber);
    let leaves;
    if (state === 'Upcoming') {
      // Upcoming = from_date >= today (includes pending future leaves)
      leaves = all.filter(l => l.from_date >= todayStr).sort((a,b) => a.from_date.localeCompare(b.from_date));
    } else {
      // Past = from_date < today (no state param means past only)
      leaves = all.filter(l => l.from_date < todayStr).sort((a,b) => b.from_date.localeCompare(a.from_date)).slice(0, 50);
    }
    return { data: { data: { leaves } } };
  },

  // Leaves page unpacks: d?.leave_requests ?? d ?? []
  getLeaveRequests: async (supervisorEpf: string) => {
    // Leaves route to the supervisor the applicant explicitly picked (an upper-tier
    // employee). Management additionally sees every pending leave for oversight. Southern
    // Lanka is different — no manual pick at all (see the isSouthernlanka gate on
    // leaves/page.tsx); everyone else's scoping there comes from the tree/department cascade
    // below instead, mirroring southernlankaApprovers/getEmployeesInScope.
    // Load all users once → resolve the viewer's role AND map epf → display name/department/
    // role/company (so each request can show who it was requested from, and southernlanka can
    // scope by department + role tree without a per-request Firestore read). force=true — see
    // the matching note in requestAttendanceEdit above.
    const [roles, usersSnap] = await Promise.all([getRoles(true), getUsersSnapshotCached()]);
    const nameByEpf = new Map<string, string>();
    const deptByEpf = new Map<string, string>();
    const roleByEpf = new Map<string, string>();
    const companyByEpf = new Map<string, string>();
    usersSnap.docs.forEach(d => {
      const u = d.data();
      const epf = String(u.epf_number);
      nameByEpf.set(epf, u.display_name ?? epf);
      if (u.department)    deptByEpf.set(epf, String(u.department));
      if (u.role)          roleByEpf.set(epf, String(u.role));
      if (u.company_name)  companyByEpf.set(epf, String(u.company_name));
    });
    const meDoc  = usersSnap.docs.find(d => String(d.data().epf_number) === String(supervisorEpf))?.data();
    const meRole = meDoc?.role ?? '';
    const caps   = resolveUserCapabilities(meDoc, roles);
    const isManagement = caps.is_system_admin || caps.can_manage_users || caps.can_manage_leaves;
    const isSouthernlanka = tenant.id === 'southernlanka';
    // Roles without leave-approval permission don't receive team leave requests. (Southern
    // Lanka's own scoping — HOD department match, else the fixed escalation ladder — is
    // resolved per-applicant below via southernlankaApprovers, so it isn't checked here.)
    if (!isManagement && !isSouthernlanka && !caps.can_approve_leaves) {
      return { data: { data: { leave_requests: [] } } };
    }

    // Southern Lanka never scopes by supervisor_epf (nothing sets it any more — see
    // applyLeave) — pull every pending leave, same as management, and filter per-applicant
    // below. Every other tenant keeps the supervisor_epf-scoped query.
    const snap = (isManagement || isSouthernlanka)
      ? await getDocs(query(collection(db, 'leaves'), where('status', '==', 'pending')))
      : await getDocs(query(
          collection(db, 'leaves'),
          where('supervisor_epf', '==', String(supervisorEpf)),
          where('status', '==', 'pending'),
        ));

    // Southern Lanka only — visibility must exactly mirror who southernlankaApprovers() would
    // actually resolve for each applicant (department HOD, else the fixed escalation ladder —
    // see the Comprehensive Approval Engine comment above southernlankaApprovers). Reusing that
    // SAME function (rather than a separate parallel approximation) guarantees a request is
    // never shown to someone considerLeave would then refuse to let act on it — cached per
    // applicant since several requests can share one.
    const allUsersData = usersSnap.docs.map(d => d.data());
    const approversCache = new Map<string, Set<string>>();
    const canSeeApplicant = (applicantEpf: string): boolean => {
      if (!approversCache.has(applicantEpf)) {
        const applicant = {
          epf_number: applicantEpf,
          role: roleByEpf.get(applicantEpf),
          department: deptByEpf.get(applicantEpf),
          company_name: companyByEpf.get(applicantEpf),
        };
        approversCache.set(applicantEpf, new Set(southernlankaApprovers(applicant, allUsersData, roles, 'can_approve_leaves')));
      }
      return approversCache.get(applicantEpf)!.has(String(supervisorEpf));
    };

    // Dynamic Entity Name Resolution — see resolveLeaveTypeName above.
    const typeNameById = await leaveTypeNameMap();

    const leave_requests = snap.docs
      .filter(d => {
        const data = d.data();
        const applicantEpf = String(data.epf_number);
        if (applicantEpf === String(supervisorEpf) || data.is_deleted) return false; // skip own + soft-deleted
        if (isManagement) return true;
        if (!isSouthernlanka) return true; // already scoped to me by the supervisor_epf query above
        return canSeeApplicant(applicantEpf);
      })
      .map(d => {
        const data   = d.data();
        const supEpf = data.supervisor_epf ? String(data.supervisor_epf) : null;
        return {
          leave_id:        d.id,
          epf_number:      data.epf_number,
          name:            data.employee_name,
          employee_name:   data.employee_name,
          from_date:       data.from_date,
          to_date:         data.to_date,
          leave_type_id:   data.leave_type_id ?? null,
          leave_type_name: resolveLeaveTypeName(typeNameById, data.leave_type_id, data.leave_type_name),
          reason:          data.reason,
          status:          data.status,
          is_half_day:     data.is_half_day,
          half_day_period: data.half_day_period,
          reject_reason:   data.reject_reason ?? null,
          // Who the leave was requested from (the picked supervisor) + when it was applied.
          supervisor_epf:  supEpf,
          requested_from:  supEpf ? (nameByEpf.get(supEpf) ?? supEpf) : null,
          requested_at:    data.created_at?.toDate?.()?.toISOString() ?? null,
        };
      });
    return { data: { data: { leave_requests } } };
  },

  // ─── Real-time counterparts (Southern Lanka's Comprehensive Approval Engine) ──────────────
  // Same pattern as attendanceApi.subscribeApprovals above: attach onSnapshot listeners on the
  // simple, tightly-scoped queries the one-shot functions above already read, and on every
  // change re-resolve the FULL result by calling that SAME one-shot function again — so
  // visibility/scoping can never drift between the live and one-shot paths (one is always
  // just the other, called more often). getRoles()/getUsersSnapshotCached() are already
  // TTL-cached, so re-resolving on each snapshot is cheap after the first call. Each listener
  // fires once immediately with current data (no separate initial fetch needed by the caller),
  // then again on every relevant write — a new request appears in an approver's Pending tab,
  // and an acted-on one updates/disappears, with no page refresh. Callers MUST invoke the
  // returned unsubscribe on unmount (see the useEffect cleanup on leaves/page.tsx).

  // Approver's Team Requests tab — mirrors getLeaveRequests above.
  subscribeLeaveRequests: (
    supervisorEpf: string,
    cb: (leave_requests: any[]) => void,
  ): (() => void) => {
    const emit = () => {
      leaveApi.getLeaveRequests(supervisorEpf).then((res: any) => {
        const d = res.data?.data ?? res.data;
        cb(Array.isArray(d?.leave_requests) ? d.leave_requests : []);
      }).catch(() => { /* keep showing the last-known list rather than clearing it */ });
    };
    emit();
    return onSnapshot(
      query(collection(db, 'leaves'), where('status', '==', 'pending')),
      emit,
      (err) => console.warn('subscribeLeaveRequests failed:', err?.message ?? err),
    );
  },

  // Employee's own Upcoming/Past leave lists + balance — mirrors getMyLeaves/getLeaveSummary.
  // Bundled into one listener (both read the same 'leaves' docs) so an approver's decision on
  // this person's request updates their own view instantly too.
  subscribeMyLeaves: (
    epfNumber: string,
    cb: (d: { upcoming: any[]; past: any[]; summary: any[] }) => void,
  ): (() => void) => {
    const emit = () => {
      Promise.all([
        leaveApi.getMyLeaves(epfNumber, 'Upcoming'),
        leaveApi.getMyLeaves(epfNumber),
        leaveApi.getLeaveSummary(epfNumber),
      ]).then(([upcomingR, pastR, summaryR]: any[]) => {
        const upcoming = (upcomingR.data?.data ?? upcomingR.data)?.leaves;
        const past     = (pastR.data?.data ?? pastR.data)?.leaves;
        const summary  = summaryR.data?.data ?? summaryR.data;
        cb({
          upcoming: Array.isArray(upcoming) ? upcoming : [],
          past:     Array.isArray(past) ? past : [],
          summary:  Array.isArray(summary) ? summary : [],
        });
      }).catch(() => { /* keep showing the last-known lists rather than clearing them */ });
    };
    emit();
    return onSnapshot(
      query(collection(db, 'leaves'), where('epf_number', '==', epfNumber)),
      emit,
      (err) => console.warn('subscribeMyLeaves failed:', err?.message ?? err),
    );
  },

  considerLeave: async (data: any) => {
    const status = (data.action === 'accept' || data.action === 'approve') ? 'approved' : 'rejected';
    const considerBy = String(data.consider_by ?? '');
    const leaveRef  = doc(db, 'leaves', String(data.leave_id));
    // Read the leave FIRST — both to build the notification and, now, to re-derive who is
    // actually allowed to act on it. getLeaveRequests already only shows a viewer requests it
    // resolves for them, but that's a read-time filter the caller could bypass by calling this
    // directly with someone else's leave_id — re-check the same scoping here on the write path.
    const leaveSnap = await getDoc(leaveRef).catch(() => null);
    if (!leaveSnap?.exists()) throw new Error('Leave request not found');
    const lv = leaveSnap.data();

    // force=true — see the matching note in requestAttendanceEdit above.
    const [roles, considererSnap] = await Promise.all([
      getRoles(true),
      getDoc(doc(db, 'users', epfDocId(considerBy))),
    ]);
    const considerer = considererSnap.exists() ? considererSnap.data() : null;
    const considererCaps = resolveUserCapabilities(considerer, roles);
    // Management can act on any pending leave, mirroring getLeaveRequests' isManagement bypass
    // — EXCEPT on Southern Lanka, where Self-Approval Strict Restriction applies to every user
    // without exception (HOD, HR, GM, or Super Admin): a request must always escalate to
    // someone else, never be self-approved. Every other tenant keeps management's existing
    // unconditional bypass, unchanged.
    const isManagement = considererCaps.is_system_admin || considererCaps.can_manage_users || considererCaps.can_manage_leaves;
    if (tenant.id === 'southernlanka') {
      if (String(lv.epf_number) === considerBy) {
        throw new Error('You cannot approve your own request.');
      }
      if (!isManagement) {
        // Same two routes as getLeaveRequests (HOD of the applicant's department(s), else the
        // fixed escalation ladder — see the Comprehensive Approval Engine comment above
        // southernlankaApprovers) — resolved fresh from the applicant's CURRENT role/department
        // rather than trusting the leave doc, which never stores either for this tenant.
        const [usersSnap, applicantSnap] = await Promise.all([
          getUsersSnapshotCached(),
          getDoc(doc(db, 'users', epfDocId(String(lv.epf_number)))),
        ]);
        const applicant = applicantSnap.exists() ? applicantSnap.data() : {};
        const approverEpfs = southernlankaApprovers(
          { epf_number: String(lv.epf_number), role: applicant.role, department: applicant.department, company_name: applicant.company_name },
          usersSnap.docs.map((d: any) => d.data()),
          roles,
          'can_approve_leaves',
        );
        if (!approverEpfs.includes(considerBy)) {
          throw new Error('You are not authorized to approve this leave request.');
        }
      }
    } else if (!isManagement && (!considererCaps.can_approve_leaves || String(lv.supervisor_epf ?? '') !== considerBy)) {
      throw new Error('You are not authorized to approve this leave request.');
    }

    // ── Quota re-validation on approval (Southern Lanka) ─────────────────────────────
    // applyLeave checks quota at SUBMISSION, but the picture can drift before an approver
    // acts (the balance was spent by another leave since, stacked pendings, etc.). Re-run the
    // SAME getLeaveSummary check here — an approver (HOD / HR / management included) can never
    // push a paid leave past the employee's remaining balance for the year without either
    // rejecting it or marking it unpaid. Only when actually APPROVING a still-pending PAID
    // leave; the derived balance model then deducts it automatically once status flips.
    if (tenant.id === 'southernlanka'
        && status === 'approved'
        && String(lv.status ?? '').toLowerCase() === 'pending') {
      const willBePaid = data.is_paid !== undefined ? !!data.is_paid : lv.is_paid !== false;
      if (willBePaid) {
        const summaryRes: any = await leaveApi.getLeaveSummary(String(lv.epf_number));
        const summaryArr: any[] = summaryRes?.data?.data ?? summaryRes?.data ?? [];
        const entry = Array.isArray(summaryArr)
          ? summaryArr.find(s => (s?.leave_type ?? s?.type) === lv.leave_type_name)
          : null;
        if (entry) {
          const f = String(lv.from_date ?? '').slice(0, 10);
          const t = String(lv.to_date ?? '').slice(0, 10);
          const requested = lv.is_half_day ? 0.5 : businessDayCount(f, t);
          // `lv` is still pending here, so it isn't in `used` yet — `available` is the true remainder.
          const available = (Number(entry.total) || 0) - (Number(entry.used) || 0);
          const who = lv.employee_name || 'this employee';
          if (requested > available + 1e-9) {
            throw new Error(available <= 0
              ? `${who} has used their full ${lv.leave_type_name} quota for the year — approving this ${requested}-day leave would put them over. Reject it, or approve it as unpaid.`
              : `Only ${available} day(s) of ${lv.leave_type_name} remain for ${who} this year — this leave needs ${requested}. Reject it, or approve it as unpaid.`);
          }
        }
      }
    }

    const now = FSTimestamp.now();
    const patch: any = {
      status,
      considered_by: data.consider_by,
      considered_at: now,
      updated_at:    now,
    };
    // The approver decides paid vs unpaid on acceptance.
    if (status === 'approved' && data.is_paid !== undefined) patch.is_paid = !!data.is_paid;
    await updateDoc(leaveRef, patch);

    if (lv?.epf_number && String(lv.epf_number) !== considerBy) {
      void createAppNotification({
        toEpf:    String(lv.epf_number),
        type:     status === 'approved' ? 'leave_approved' : 'leave_rejected',
        actorEpf: considerBy,
        meta: {
          leave_type: String(lv.leave_type_name ?? ''),
          from: String(lv.from_date ?? ''),
          to:   String(lv.to_date ?? ''),
          ...(data.reject_reason ? { reason: String(data.reject_reason) } : {}),
        },
        title: status === 'approved' ? 'Your leave was approved' : 'Your leave was rejected',
        body:  [lv.leave_type_name, `${lv.from_date} → ${lv.to_date}`, data.reject_reason].filter(Boolean).join(' · '),
        link:  '/leaves',
      });
    }
    return { data: { status: 'Request was successful.' } };
  },

  // Leaves page unpacks: d?.leave_list ?? []
  // On-leave list for ONE day. Scope, the read and the row shape all come from the three helpers
  // above getTodayLeaveList — see onLeaveViewerScope for why company matching is id OR name.
  getTodayLeaveList: async (supervisorEpf: string, date?: string) => {
    const d = date ?? today();
    const { systemWide, inMyCompany } = await onLeaveViewerScope(supervisorEpf);
    const rows = (await approvedLeavesOverlapping(d, d)).filter(l => systemWide || inMyCompany(l));
    return { data: { data: { leave_list: await toOnLeaveRows(rows) } } };
  },

  /**
   * Everyone on approved leave on any day between `fromDate` and `toDate`, bucketed by day.
   *
   * Exists because the calendar view would otherwise call getTodayLeaveList once per date, and
   * that function reads every approved leave in the collection each time — thirty full-collection
   * reads to draw one month, on a backend serving ~300 people. This reads the same set ONCE and
   * buckets it locally, so a whole month costs what a single day used to.
   *
   * Scope comes from the same helper getTodayLeaveList uses, so the two can never drift about who
   * is allowed to see whom — and the date arithmetic comes from daysCovered, which is unit-tested
   * (inclusive end dates, month boundaries, leap February) rather than re-derived here.
   */
  getLeaveRangeList: async (supervisorEpf: string, fromDate: string, toDate: string) => {
    const from = String(fromDate ?? '').slice(0, 10);
    const to   = String(toDate ?? '').slice(0, 10);
    if (!from || !to || to < from) return { data: { data: { days: {} as Record<string, OnLeaveRow[]>, leave_list: [] as OnLeaveRow[] } } };

    const { systemWide, inMyCompany } = await onLeaveViewerScope(supervisorEpf);
    const matches = (await approvedLeavesOverlapping(from, to)).filter(l => systemWide || inMyCompany(l));
    const leave_list = await toOnLeaveRows(matches);

    // A leave spanning a week lands under all seven of its days. The duplication is deliberate:
    // the calendar asks "who is away on the 9th", and answering that by re-scanning every leave
    // per cell is how a month grid gets slow.
    const days: Record<string, OnLeaveRow[]> = {};
    matches.forEach((l, i) => {
      const covered = daysCovered({ from_date: String(l.from_date), to_date: String(l.to_date) }, from, to);
      for (const day of covered) (days[day] ??= []).push(leave_list[i]);
    });
    return { data: { data: { days, leave_list } } };
  },

  // Search pool for "On Leave → Search Employee": every employee visible to the viewer
  // (management/system admin → org-wide; other approvers → their reporting tree), so they
  // can pick one to inspect via getEmployeeLeaveHistory below.
  getEmployeesForLeaveSearch: async (viewerEpf: string) => {
    const { employees } = await getEmployeesInScope(viewerEpf);
    const list = employees
      .map((e: any) => ({ epf_number: String(e.epf_number), name: e.display_name ?? String(e.epf_number) }))
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
    return { data: { data: { employees: list } } };
  },

  // Full leave history (every status, non-deleted) for one employee whose date range overlaps
  // [fromDate, toDate] — a leave that only partially falls inside the window still counts.
  // Backs the "On Leave → Search Employee" view (default window: 6 months back / 6 months
  // forward from today). Reuses buildMyLeavesList so the shape matches getMyLeaves exactly.
  getEmployeeLeaveHistory: async (epfNumber: string, fromDate: string, toDate: string) => {
    const all = await buildMyLeavesList(epfNumber);
    const leaves = all
      .filter(l => l.from_date <= toDate && l.to_date >= fromDate)
      .sort((a, b) => a.from_date.localeCompare(b.from_date));
    return { data: { data: { leaves } } };
  },

  // Attendance page unpacks: absData?.absent_list ?? []
  getTodayAbsentees: async (company: string, supervisorEpf: string) => {
    const todayStr = today();

    // Use shared scope resolver
    const { employees: allEmployees, scope, companyName } = await getEmployeesInScope(supervisorEpf);

    const roles = await getRoles();
    // "Missing attendance" is for the IMMEDIATE supervisor only. Direct reports = people
    // explicitly assigned to me (supervisor_epf) where set, otherwise the role tier directly
    // below mine (childRoleNamesOf). Higher tiers don't see it; non-supervisors don't either.
    const meSnap = await getDoc(doc(db, 'users', epfDocId(supervisorEpf)));
    const viewerRole = meSnap.exists() ? (meSnap.data().role as string) : '';
    const childRoles = new Set(childRoleNamesOf(viewerRole, roles));
    const employees = allEmployees.filter(u => {
      if (!roleCan(u.role, 'has_attendance', roles)) return false;   // skip non-attendance roles
      return u.supervisor_epf
        ? String(u.supervisor_epf) === String(supervisorEpf)
        : childRoles.has(u.role);
    });
    const is_immediate_supervisor = employees.length > 0;

    if (!employees.length) return { data: { data: { absent_list: [], is_immediate_supervisor: false } } };

    // Get approved leaves for today — scope-aware
    const leaveQuery = scope === 'system'
      ? query(collection(db, 'leaves'), where('status', '==', 'approved'))
      : query(collection(db, 'leaves'), where('company_name', '==', companyName), where('status', '==', 'approved'));
    const leaveSnap = await getDocs(leaveQuery);
    const onLeaveEpfs = new Set(
      leaveSnap.docs
        .map(d => d.data())
        .filter(l => String(l.from_date).slice(0, 10) <= todayStr && String(l.to_date).slice(0, 10) >= todayStr)
        .map(l => l.epf_number as string)
    );

    // Check attendance for each employee using doc ID (no query needed)
    const absent_list: unknown[] = [];
    await Promise.all(employees.map(async (emp) => {
      // Skip if on approved leave
      if (onLeaveEpfs.has(emp.epf_number)) return;

      // Check if they have a check-in today using direct doc ID lookup
      const attId   = attDocId(emp.epf_number, todayStr);
      const attSnap = await getDoc(doc(db, 'attendances', attId));
      const hasCheckedIn = attSnap.exists() && sessionsOf(attSnap.data()).some(s => s.check_in);

      if (!hasCheckedIn) {
        absent_list.push({
          epf_number:           emp.epf_number,
          name:                 emp.display_name ?? emp.epf_number,
          designation:          emp.designation ?? '',
          // Return both phone fields the UI expects
          phone:                emp.phone_personal ?? emp.phone_office ?? '',
          personal_phonenumber: emp.phone_personal ?? '',
          office_phonenumber:   emp.phone_office   ?? '',
        });
      }
    }));

    // Sort by name
    (absent_list as Array<{name: string}>).sort((a, b) => a.name.localeCompare(b.name));

    return { data: { data: { absent_list, is_immediate_supervisor } } };
  },

  // ── Restricted-leave assignment (Southern Lanka) ─────────────────────────────
  // Every active, non-resigned EMPLOYEE — the picker pool for "Assign Leave for Employee".
  // Org-wide on purpose: an HR/Admin holder of can_apply_restricted_leaves may act for
  // anyone, not just their own reporting tree (unlike getEmployeesForLeaveSearch).
  getAssignableEmployees: async () => {
    // Service-layer tenant guard — the feature is Southern Lanka-only (the UI is gated too).
    if (tenant.id !== 'southernlanka') throw new Error('Not available for this tenant.');
    const [usersSnap, roles] = await Promise.all([getUsersSnapshotCached(), getRoles()]);
    const employees = usersSnap.docs
      .map((d: any) => d.data())
      .filter((u: any) =>
        u.is_active !== false &&
        !isResigned(u.date_of_resign) &&
        roleCan(u.role, 'is_employee', roles))
      .map((u: any) => ({
        epf_number: String(u.epf_number),
        name:       u.display_name ?? String(u.epf_number),
        role:       u.role ?? '',
        department: u.department ?? '',
      }))
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
    return { data: { data: { employees } } };
  },

  // HR/Admin (can_apply_restricted_leaves, or System Admin) places a RESTRICTED leave type
  // (leave_types.allow_direct_apply === false — hidden from the normal "+ Apply Leave"
  // dropdown) directly onto `target_epf`. The leave is written already-APPROVED, so
  // getLeaveSummary counts its days as used the moment it lands — there is no separate
  // leave_balances ledger on this tenant's path; the balance is derived from approved paid
  // leaves. The target's own leaves-page subscription (subscribeMyLeaves) and their next
  // dashboard fetch both pick up the new doc immediately. The target is then notified.
  assignRestrictedLeave: async (data: any) => {
    // Service-layer tenant guard — the feature is Southern Lanka-only (the UI is gated too).
    if (tenant.id !== 'southernlanka') throw new Error('Not available for this tenant.');
    const now         = FSTimestamp.now();
    const targetEpf   = String(data.target_epf ?? '').trim();
    const assignerEpf = String(data.assigned_by_epf ?? '').trim();
    if (!targetEpf)        throw new Error('Select an employee.');
    if (!data.leave_type)  throw new Error('Select a leave type.');
    const fromDate = String(data.from_date ?? '').slice(0, 10);
    const toDate   = String(data.to_date ?? data.from_date ?? '').slice(0, 10);
    if (!fromDate || !toDate) throw new Error('Pick the leave date(s).');
    if (toDate < fromDate)    throw new Error('The end date is before the start date.');
    const isHalf     = !!data.is_half_day;
    const halfPeriod = isHalf ? (data.half_day_period === 'afternoon' ? 'afternoon' : 'morning') : null;
    if (isHalf && fromDate !== toDate) throw new Error('A half day must be a single date.');

    const [targetSnap, assignerSnap, ltSnap] = await Promise.all([
      getDoc(doc(db, 'users', epfDocId(targetEpf))),
      assignerEpf ? getDoc(doc(db, 'users', epfDocId(assignerEpf))) : Promise.resolve(null),
      getDocs(query(collection(db, 'leave_types'), where('name', '==', data.leave_type))),
    ]);
    if (!targetSnap.exists()) throw new Error('Employee not found.');
    const target   = targetSnap.data();
    const assigner = assignerSnap?.exists() ? assignerSnap.data() : {};
    if (ltSnap.empty) throw new Error(`Leave type "${data.leave_type}" not found.`);
    const lt = { id: ltSnap.docs[0].id, ...ltSnap.docs[0].data() } as any;
    // This path is ONLY for restricted types — a self-appliable type must go through applyLeave.
    if (lt.allow_direct_apply !== false) {
      throw new Error(`"${lt.name}" is not a restricted leave type — the employee can apply for it themselves.`);
    }
    if (lt.is_active === false) throw new Error(`"${lt.name}" is inactive.`);

    // Conflict: no overlap with the target's existing pending/approved leaves on any date.
    const reqDates  = new Set(leaveDatesInRange(fromDate, toDate));
    const mineSnap  = await getDocs(query(collection(db, 'leaves'), where('epf_number', '==', targetEpf)));
    const clash = mineSnap.docs.map(d => d.data()).find(l => {
      if (l.is_deleted) return false;
      const st = String(l.status ?? '').toLowerCase();
      if (st !== 'pending' && st !== 'approved') return false;
      return leaveDatesInRange(String(l.from_date).slice(0, 10), String(l.to_date).slice(0, 10))
        .some(dd => reqDates.has(dd));
    });
    if (clash) {
      const cf = String(clash.from_date).slice(0, 10);
      const ct = String(clash.to_date).slice(0, 10);
      throw new Error(
        `${target.display_name ?? 'This employee'} already has a `
        + `${String(clash.status).toLowerCase() === 'approved' ? 'approved' : 'pending'} `
        + `${clash.leave_type_name || 'leave'} covering ${cf === ct ? cf : `${cf} – ${ct}`}.`,
      );
    }

    // Quota guard — a paid assignment draws down the same annual pool getLeaveSummary derives.
    // (During an employee's first-year accrual window the restricted type won't appear in the
    // summary at all, so this simply no-ops there — fail open.)
    const isPaid = data.is_paid !== false;
    if (isPaid) {
      const summaryRes: any = await leaveApi.getLeaveSummary(targetEpf);
      const summaryArr: any[] = summaryRes?.data?.data ?? summaryRes?.data ?? [];
      const entry = Array.isArray(summaryArr)
        ? summaryArr.find(s => (s?.leave_type ?? s?.type) === data.leave_type)
        : null;
      if (entry) {
        const requested  = isHalf ? 0.5 : businessDayCount(fromDate, toDate);
        const available  = (Number(entry.total) || 0) - (Number(entry.used) || 0);
        if (requested > available + 1e-9) {
          throw new Error(available <= 0
            ? `${target.display_name ?? 'This employee'} has no ${data.leave_type} quota remaining.`
            : `Only ${available} day(s) of ${data.leave_type} remain for ${target.display_name ?? 'this employee'} — this assignment needs ${requested}.`);
        }
      }
    }

    await addDoc(collection(db, 'leaves'), {
      epf_number:      targetEpf,
      employee_name:   target.display_name ?? targetEpf,
      company_id:      target.company_id ?? '',
      company_name:    target.company_name ?? '',
      from_date:       fromDate,
      to_date:         toDate,
      leave_type_id:   lt.id,
      leave_type_name: lt.name,
      is_half_day:     isHalf,
      half_day_period: halfPeriod,
      reason:          data.reason ?? '',
      supervisor_epf:  '',
      status:          'approved',        // HR/Admin-assigned → immediately effective
      considered_by:   assignerEpf || null,
      considered_at:   now,
      reject_reason:   null,
      is_paid:         isPaid,
      category:        'special',         // assigned by HR/Admin (see LeaveRecord.category)
      assigned_by:     assignerEpf || null,
      created_at:      now,
      updated_at:      now,
    });

    // Tell the target a leave was placed on their behalf.
    const assignerName = assigner.display_name ?? assignerEpf ?? 'An administrator';
    const rangeLabel   = fromDate === toDate ? fromDate : `${fromDate} → ${toDate}`;
    void createAppNotification({
      toEpf:     targetEpf,
      type:      'leave_assigned',
      actorEpf:  assignerEpf || undefined,
      actorName: String(assignerName),
      meta: {
        leave_type: String(lt.name ?? ''),
        from: fromDate,
        to:   toDate,
        ...(data.reason ? { reason: String(data.reason) } : {}),
      },
      title: `${assignerName} assigned a leave for you`,
      body:  [lt.name, rangeLabel, isHalf ? `half day (${halfPeriod})` : null, data.reason].filter(Boolean).join(' · '),
      link:  '/leaves',
    });

    return { data: { status: 'Request was successful.' } };
  },
};

// ─── Typed re-exports — cast to any so calling pages don't see type conflicts ─
// The pages were written against a Laravel API; we bridge here at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = Record<string, (...a: any[]) => Promise<any>>;
export const _attendanceApi = attendanceApi as unknown as AnyApi;
export const _leaveApi      = leaveApi      as unknown as AnyApi;
export const _profileApi    = profileApi    as unknown as AnyApi;
export const _authApi       = authApi       as unknown as AnyApi;
