'use client';
import {
  LayoutDashboard, Clock, CalendarDays, CheckCircle2, FileBarChart2, CalendarRange, Users, Building2, Building, MapPinned, ShieldCheck, Database, ListTodo, TerminalSquare, Wallet, Settings, BadgeDollarSign, HandCoins, CalendarCheck, Receipt, Timer, UtensilsCrossed, Utensils, ChefHat, ScanFace,
} from 'lucide-react';
import { useUserCapabilities } from '@/store/rolesStore';
import { useSuspenseAccess } from '@/store/suspenseStore';
import { useAuthStore } from '@/store/authStore';
import { useMyChamaries } from '@/store/workingPlacesStore';
import { useNavBadges } from '@/store/navBadgesStore';
import { useT } from '@/store/appStore';
import { tenant } from '@/lib/firebase';

// Per-tenant module switches. EVERY row below carries its own flag (see TenantFeatures in
// src/lib/tenants.ts) on top of its capability gate, so a page can be dropped from one domain
// without touching anyone else's. The same flags gate the routes themselves in
// (pages)/layout.tsx — a hidden row is never the only thing keeping a user out of a page.
const F = tenant.features;
// The suspense (expense-float) module is a per-tenant feature — Alta Vision only. Pages that
// belong to it need their own flag AND this one.
const SUSPENSE_ON = F.suspense;
// The payroll module is a per-tenant feature — Southern Lanka only. Same two-flag rule.
const PAYROLL_ON = F.payroll;

export interface NavItem {
  href: string;
  icon: typeof LayoutDashboard;
  label: string;
  /** How many things are waiting for this user on that page. Absent or 0 = no badge — see
   *  navBadgesStore: only queues the user can actually act on are counted. */
  badge?: number;
}

// A collapsible admin section. `id` is what the sidebar persists its open/closed state
// under, so it must stay stable even when the label (or its translation) changes.
export interface NavGroup {
  id: 'operations' | 'people' | 'payroll' | 'system';
  label: string;
  items: NavItem[];
}

// Single source of truth for the sidebar so the (emp) and (admin) layouts render the
// EXACT same items — nothing appears/disappears as the user moves between sections.
export function useSidebarNav(): { navItems: NavItem[]; adminNav: NavItem[]; adminGroups: NavGroup[] } {
  // caps already reflect the trainee access set (resolved with the user's employee_type),
  // so no separate trainee check is needed here.
  const caps = useUserCapabilities();
  const { hasAccount } = useSuspenseAccess();
  const t = useT();
  // Head of Department (see AppUser.hod_department_ids / hod_department_names, set on the
  // Users page). `isHOD` here means "has at least one department actually assigned" — an
  // is_department_head ROLE with an empty assignment list is NOT treated as an HOD anywhere
  // in the sidebar. Grants Schedule/Attendance View access, filtered to those department(s),
  // without the broader can_manage_users / can_view_attendance capability.
  const me = useAuthStore((s) => s.user);
  const hodDepts = me?.hod_department_names ?? me?.hod_department_ids ?? [];
  const hasHodDepartments = Array.isArray(hodDepts) && hodDepts.length > 0;
  const isHOD = hasHodDepartments;
  // Whoever runs a chamary (Chamary.responsible_epf in Working Places) — not a capability, so
  // it has to be looked up rather than read off `caps`. Gives them, and the people who own the
  // food module, the daily food-requests page for their own canteen(s).
  const myEpf = me?.epf_number ?? '';
  const runsAChamary = useMyChamaries(myEpf).length > 0;

  // Counts for the rows that have a queue behind them. Capability-gated and TTL-cached inside
  // the store, so a row a user can't act on costs no read at all.
  const myCompanyId = me?.company_id ?? '';
  const badges = useNavBadges({
    epf: myEpf,
    companyId: myCompanyId,
    canApproveAttendance: caps.can_approve || caps.can_lead_team || caps.can_approve_technicians,
    canApproveLeaves:     caps.can_approve_leaves,
    canApproveSuspense:   caps.can_approve_suspense,
    canApproveOt:         caps.can_approve_ot,
    // The feature flag alone, NOT `hasAccount || can_approve_suspense`: two of the suspense
    // queues belong to people with neither — someone's supervisor, and anyone named as a credit
    // approver on a category. Gating the whole group on account/capability left those users with
    // no badge and (below) no nav row at all, so a request could sit with them unseen. The
    // approver-only queues stay gated by canApproveSuspense inside the store.
    suspenseOn: SUSPENSE_ON,
    payrollOn:  PAYROLL_ON,
  });

  const navItems = ([
    { href: '/dashboard',  icon: LayoutDashboard, label: t.dashboard,  show: F.dashboard && caps.has_attendance },
    { href: '/attendance', icon: Clock,           label: t.attendance, show: F.attendance && caps.has_attendance },
    // Read-only self-service view of one's own shifts (src/lib/rosterSchedule.ts computes the
    // same weekday/holiday-type/override logic the admin schedule generator uses, scoped down
    // to one person) — Southern Lanka only, since that's the only tenant with this shift system.
    { href: '/my-schedule', icon: CalendarRange,  label: t.navMySchedule, show: F.mySchedule && caps.has_attendance },
    { href: '/tasks',      icon: ListTodo,        label: t.navTasks,   show: F.tasks && (caps.has_tasks || caps.can_view_team_tasks) },
    { href: '/leaves',     icon: CalendarDays,    label: t.leaves,     badge: badges.leaves,    show: F.leaves && (caps.has_attendance || caps.can_approve_leaves) },
    { href: '/approvals',  icon: CheckCircle2,    label: t.approvals,  badge: badges.approvals, show: F.approvals && (caps.can_approve || caps.can_lead_team || caps.can_approve_technicians) },
    // `badges.suspense > 0` is what puts the row in front of a supervisor or a category's credit
    // approver who holds neither an account nor the capability: for them the row appears exactly
    // when something is actually waiting, and goes away again once they've signed it.
    { href: '/suspense',   icon: Receipt,         label: t.navSuspense, badge: badges.suspense, show: SUSPENSE_ON && (hasAccount || caps.can_approve_suspense || badges.suspense > 0) },
    // Daily food requests at a chamary: the people who run one, plus the admins who own the
    // food module (they answer for the deduction it feeds). Employee-facing for the responsible
    // person, so it stays out of MANAGEMENT_PATHS.
    // Every employee's own food record — meals, cost, and corrections they need approved.
    // Not gated on running a chamary: the point is that anyone who eats can check the bill.
    // Two rows, two jobs, two icons. A person who RUNS a canteen sees both: /food is her
    // own meals (a place setting) and /chamary is the kitchen she answers for (a chef's
    // hat). They used to share UtensilsCrossed and read as the same page twice.
    { href: '/food',       icon: Utensils, label: t.navMyFood, show: SUSPENSE_ON && F.chamary && caps.is_employee },
    { href: '/chamary',    icon: ChefHat, label: t.navManageChamary, show: SUSPENSE_ON && F.chamary && (runsAChamary || caps.is_system_admin || caps.can_approve_suspense) },
    // /my-payslips deliberately has no row here — the route stays live (bookmarks, direct
    // links), it's just reached from the profile page's Payslips card instead, behind the
    // same PAYROLL_ON && can_view_own_payslip gate this row used.
    // Employee files their own OT requests here; an OT approver (can_approve_ot) picks up the
    // Approvals tab on the same page. Southern Lanka payroll only. Not in MANAGEMENT_PATHS —
    // it's employee-facing, like /leaves and /my-payslips.
    { href: '/ot-requests', icon: Timer,          label: t.navOvertime, badge: badges.ot,       show: PAYROLL_ON && F.otRequests && (caps.is_employee || caps.can_approve_ot) },
    { href: '/reports',    icon: FileBarChart2,   label: t.navReports, show: F.reports && caps.can_report },
  ] as Array<NavItem & { show: boolean }>).filter(n => n.show);

  // Grouping is presentation only. Every `show` gate below is byte-for-byte the one that
  // was on the old flat list, and the group boundaries were chosen to fall on runs that
  // list already had — so flattening adminGroups reproduces its exact former order (which
  // the layout's landing-page fallback and BottomNav still depend on). Roles therefore
  // stays after Leave Types rather than moving up beside Users.
  const adminGroups = ([
    {
      id: 'operations', label: t.navGroupOperations, items: [
        { href: '/overview',    icon: LayoutDashboard, label: t.navOverview, show: F.overview && (caps.is_system_admin || caps.can_report || caps.can_manage_users) },
        // Deliberately placed right after Overview (not grouped with the payroll entries,
        // even though it is payroll-gated) — it's the page HR/admins check daily, so it
        // shouldn't be buried below Departments/Roles. Admin-facing monthly attendance log
        // across every employee — separate from the personal /attendance page. Requires its
        // own capability (can_view_attendance), not has_attendance. A Head of Department gets
        // in too — but ONLY with department(s) explicitly assigned (hasHodDepartments); an
        // is_department_head role with an empty list does not. Scoped to those department(s)
        // on the page — same strict gate src/app/(pages)/attendance-view/page.tsx enforces.
        { href: '/attendance-view',   icon: CalendarCheck,   label: t.navAttendanceView, show: PAYROLL_ON && F.attendanceView && (caps.is_system_admin || caps.can_view_attendance || (caps.is_department_head && hasHodDepartments)) },
        // Sidebar lands on the Google-Calendar-style employee/date grid (schedule/page.tsx) —
        // southernlanka only, gated the same way that page gates itself (can_manage_users OR
        // isHOD — a Head of Department gets in too, locked to their own department once there).
        // Shifts (the one-time "define reusable shift definitions" setup) is reached from there
        // via its own "Manage Shifts" button, same convention the old roster/schedule → roster
        // table flow used — day-to-day scheduling is what admins land on, setup is one click
        // away. Shifts links back with its own "Schedule" button (see SouthernlankaShifts.tsx).
        { href: '/schedule',    icon: CalendarRange,   label: t.navSchedule, show: F.schedule && (caps.can_manage_schedules || caps.can_view_schedules || isHOD) },
        // Every other tenant's ShiftAssignment page — hidden for southernlanka, whose /shifts
        // content (SouthernlankaShifts.tsx) is reached via the Schedule page's button instead, not
        // a standalone sidebar entry. Excluded by tenant id, not just F.shifts — that flag is
        // true for southernlanka too (the route itself stays live; see MANAGEMENT_PATHS below).
        { href: '/shifts',      icon: CalendarRange,   label: t.navShifts,   show: tenant.id !== 'southernlanka' && F.shifts && (caps.can_manage_shifts || caps.can_manage_working_schedules) },
      ],
    },
    {
      id: 'people', label: t.navGroupPeople, items: [
        { href: '/users',       icon: Users,           label: t.navUsers,    show: F.users && (caps.can_manage_users || caps.can_view_users) },
        // Who has registered a fingerprint/Face ID on the HF-X05 terminals vs who hasn't.
        // Own capability, own tenant flag — inert wherever biometricEnrollment is off.
        { href: '/biometric-enrollment', icon: ScanFace, label: t.navBiometricEnrollment, show: F.biometricEnrollment && caps.can_view_biometric_enrollment },
        // Southern Lanka uses its own granular Manage/View company capability instead of the
        // blanket can_manage_users every other tenant still uses here (see the isSouthernlanka
        // gate on roles/page.tsx).
        { href: '/companies',   icon: Building2,       label: t.navCompanies, show: F.companies && (tenant.id === 'southernlanka' ? (caps.can_manage_company || caps.can_view_company) : caps.can_manage_users) },
        { href: '/departments', icon: Building,        label: t.navDepartments, show: F.departments && (caps.can_manage_departments || caps.can_view_departments) },
        { href: '/working-places', icon: MapPinned,    label: t.navWorkingPlaces, show: F.workingPlaces && caps.can_manage_users },
        { href: '/leave-types', icon: CalendarDays,    label: t.navLeaveTypes, show: F.leaveTypes && caps.can_manage_leaves },
        { href: '/roles',       icon: ShieldCheck,     label: t.navRoles,    show: F.roles && caps.is_system_admin },
      ],
    },
    {
      id: 'payroll', label: t.navGroupPayroll, items: [
        { href: '/payroll-settings',  icon: BadgeDollarSign, label: t.navPayrollSettings, show: PAYROLL_ON && F.payrollSettings && (caps.is_system_admin || caps.can_view_payroll || caps.can_manage_payroll_config) },
        { href: '/payroll-employees', icon: Users,           label: t.navPayrollEmployees, show: PAYROLL_ON && F.payrollEmployees && (caps.is_system_admin || caps.can_view_payroll || caps.can_manage_pay_profiles) },
        { href: '/payroll-runs',      icon: BadgeDollarSign, label: t.navMonthlyRun,   show: PAYROLL_ON && F.payrollRuns && (caps.is_system_admin || caps.can_view_payroll || caps.can_generate_payroll) },
        { href: '/payroll-loans',     icon: Wallet,          label: t.navLoans,        show: PAYROLL_ON && F.payrollLoans && (caps.is_system_admin || caps.can_view_payroll || caps.can_manage_pay_profiles) },
        // Deliberately its own sidebar entry, not a Loans sub-tab — short-term single-month
        // advances are a different workflow from multi-month Loans (see
        // payrollSalaryAdvanceService.ts).
        { href: '/salary-advances',   icon: HandCoins,       label: t.navSalaryAdvances, show: PAYROLL_ON && F.salaryAdvances && (caps.is_system_admin || caps.can_view_payroll || caps.can_manage_pay_profiles) },
        { href: '/payroll-reports',   icon: FileBarChart2,   label: t.navPayrollReports, show: PAYROLL_ON && F.payrollReports && (caps.is_system_admin || caps.can_view_payroll) },
      ],
    },
    {
      id: 'system', label: t.navGroupSystem, items: [
        { href: '/database',    icon: Database,        label: t.navDatabase, show: F.database && caps.is_system_admin },
        { href: '/api-playground', icon: TerminalSquare, label: t.navApiPlayground, show: F.apiPlayground && caps.is_system_admin },
        { href: '/system-settings', icon: Settings,     label: t.navSystemSettings, show: F.systemSettings && (caps.is_system_admin || caps.can_manage_users || (SUSPENSE_ON && caps.can_approve_suspense)) },
      ],
    },
  ] as Array<{ id: NavGroup['id']; label: string; items: Array<NavItem & { show: boolean }> }>)
    .map(g => ({ ...g, items: g.items.filter(i => i.show) }))
    // A section whose every item is gated away must not leave an empty header behind.
    .filter(g => g.items.length > 0);

  // Flat view of the same items, for consumers that can't collapse anything: BottomNav's
  // tab bar, and the layout's landing-page fallback / header label lookup.
  const adminNav = adminGroups.flatMap(g => g.items);

  return { navItems, adminNav, adminGroups };
}

// Management pages — used by the layout to redirect non-back-office users away.
export const MANAGEMENT_PATHS = [
  '/overview', '/schedule', '/shifts', '/users', '/biometric-enrollment', '/companies', '/departments', '/working-places', '/leave-types', '/roles', '/database', '/api-playground',
  '/payroll-settings', '/payroll-employees', '/payroll-runs', '/payroll-loans', '/salary-advances', '/payroll-reports', '/attendance-view',
];
