// Domain → Firestore database routing — the PURE half.
//
// ONE deployment serves every registered domain, so the database CANNOT be chosen by a
// build-time env var; it is resolved per request from the hostname. Same Firebase project
// throughout — same auth pool, same storage bucket, same functions. Only the Firestore
// database differs.
//
// The tenant LIST itself does not live here. It lives in the `tenants` Firestore database and
// is loaded by src/lib/tenantRegistry.ts (server-only), because adding a domain or turning a
// module off must not require a deploy. Everything in this file is therefore a pure function
// over a list somebody else supplies — which is also what makes it unit-testable.
//
// Imported by BOTH the browser (src/lib/firebase.ts) and the server
// (src/lib/firebaseAdmin.ts), so this file must stay free of any firebase import.

/**
 * Per-tenant feature switches — a feature is available only where its flag is true.
 *
 * Three kinds of flag live here:
 *
 *   • Cross-cutting features (`suspense`, `payroll`, `whatsNew`, `solarApp`) — each gates a
 *     whole subsystem: several pages, plus nav rows, report tabs, profile cards and stores.
 *   • Policy flags (`saturdayHalfDay`, `autoApproveInRangeCheckIn`) — these hide nothing. They
 *     change how a SHARED rule behaves for one organisation, so MODULE_ROUTES never mentions
 *     them and no page appears or disappears when one is flipped; what moves is a figure or a
 *     step somebody would otherwise have had to take.
 *   • Module flags — ONE PER PAGE, so a single page can be hidden from a domain without
 *     touching the subsystem it belongs to. MODULE_ROUTES (below) maps each route to the
 *     flags it needs and the app shell blocks the route itself, so hiding a sidebar row is
 *     never the only thing standing between a user and the page.
 *
 * A page inside a subsystem needs BOTH: /payroll-runs needs `payroll` AND `payrollRuns`.
 * That's what lets a tenant keep payroll while dropping, say, Loans — and it means the
 * per-page flags can all stay true on a tenant whose umbrella is off (they're simply inert,
 * and turning the umbrella on later gives that tenant the whole module rather than a
 * half-configured one).
 *
 * Every flag is listed explicitly on every tenant ON PURPOSE — the type demands it, so a
 * newly added module can never be silently on (or off) for a tenant nobody remembered.
 */
export interface TenantFeatures {
  // ── Cross-cutting subsystems ────────────────────────────────────────────────
  /** Suspense (staff expense float) module: nav, pages, reports, profile deductions, settings. */
  suspense: boolean;
  /** "What's New" changelog button in the sidebar footer. */
  whatsNew: boolean;
  /** Cross-link to the (Alta Vision-only) Solar App. Tenants without it get a "Get App"
   *  install link in its place — see GetAppButton. */
  solarApp: boolean;
  /** LogPup project tasks: the section on /tasks showing the signed-in person's own LogPup
   *  tasks, the cross-link in the sidebar, and the inbound webhook that rings the bell when
   *  one is assigned. See LOGPUP_TASKS_INTEGRATION.md.
   *
   *  A subsystem rather than a page flag — it adds no route, it adds a foreign source of work
   *  items inside a page that already exists. Alta Vision-only in practice, for the same
   *  reason as solarApp: LogPup is an Alta Vision system and its accounts are altavision.lk
   *  addresses, so the flag being off elsewhere is what keeps another organisation's people
   *  out of it rather than an accident of configuration. */
  logpupTasks: boolean;
  /** Payroll module (attendance→payroll summary, salary generation, payslips). The umbrella
   *  over every payroll page flag below, and over /ot-requests, /my-payslips and
   *  /attendance-view. */
  payroll: boolean;
  /** Passkey (WebAuthn) sign-in: the button on /login, and the enrolment + device cards on
   *  /profile. A subsystem rather than a page flag — it adds no route, it adds a second way
   *  in. Off by default; a tenant turns it on once its people are ready to enrol, because a
   *  sign-in method that appears unannounced is a support call, not a feature. Passwords and
   *  OAuth are untouched wherever it is on. */
  passkeys: boolean;
  /**
   * Pay a PREMIUM for working a public holiday, a Poya day, a company holiday, a rest day or an
   * approved leave day (src/lib/holidayWorkPolicy.ts).
   *
   * OFF for Alta Vision / PearlCluster, and it must stay off: they pay no overtime, and a
   * visible multiplier control states a payroll entitlement that does not exist. The control is
   * ABSENT there, not disabled — same reasoning that replaced the word "Overtime" with "Extra
   * hours" on the calendar. The resolver enforces this too, so an off tenant returns 1x whatever
   * rows happen to sit in its database.
   *
   * ON is for organisations that genuinely pay it, extending the PH/Poya multipliers the
   * payroll module already owns rather than duplicating them.
   */
  holidayPayMultipliers: boolean;

  /**
   * This organisation works Saturday as a HALF day, so the monthly report weighs a normal
   * Saturday 0.5 rather than 1 — in WORKING DAYS, in the leave columns and in ABSENT DAYS
   * alike. Shift work is exempt: a Saturday the roster covers is a whole day, because a
   * shift is a shift whatever the day of the week.
   *
   * Off by default and it must stay that way — a tenant on a full six-day week would find
   * every Saturday silently halved. Only the monthly report reads this. Leave ENTITLEMENT is
   * untouched: the balance engine already drops Saturday from a request altogether, so a
   * Saturday still costs 0 days of quota while the report shows the 0.5 day that was worked.
   */
  saturdayHalfDay: boolean;

  /**
   * Auto-approve a self-service check-in whose GPS lands inside a configured working place's
   * OWN radius (`working_places.radius_m`, default 200 m). The location is already proven, so
   * there is nothing left for a person to confirm and the check-in is written 'approved'.
   *
   * A check-in that matches no radius — off-site, or arriving with no usable GPS fix at all —
   * still goes to an approver. An unanswerable location is exactly the case an approver is
   * for; treating it as in-range would let a denied location permission approve itself.
   *
   * The CHECK-OUT is untouched and always needs approval, here and on every tenant: it is the
   * half that settles the working place, the hours, the outstation flag and the allowances.
   *
   * Off by default. An organisation whose places carry no coordinates, or whose radius was
   * drawn wide for a map pin rather than tight for a gate, would otherwise stop reviewing
   * check-ins it never chose to stop reviewing. The rule only ever RELAXES: a role that
   * self-approves today is unaffected, and turning this on can never make an approval newly
   * required — see src/lib/checkInApprovalPolicy.ts, which is where the rule actually lives.
   */
  autoApproveInRangeCheckIn: boolean;

  /**
   * Hard-blocks opening a Monthly Run (`/payroll-runs`) when any active employee has an
   * attendance check-in on a date with no roster coverage — neither a `schedule_assignments`
   * row nor a declared `day_offs` row (see findRosterCoverageGaps in payrollRunService.ts).
   * The payroll owner has to assign the missing shift before the run can be created at all.
   *
   * Off by default, and only meaningful for a tenant that actually rosters shifts per date
   * (`schedule`/shift-assignment feature) — a tenant with no roster data would find every
   * attendance record "unassigned" and could never open a run.
   */
  strictRosterPayroll: boolean;

  // ── Employee-facing pages ───────────────────────────────────────────────────
  /** /dashboard */
  dashboard: boolean;
  /** /attendance — the personal month calendar. */
  attendance: boolean;
  /** /my-schedule — self-service view of one's own shifts. Needs the shift-assignment
   *  system, i.e. only makes sense where `schedule` is on. */
  mySchedule: boolean;
  /** /tasks */
  tasks: boolean;
  /** /leaves */
  leaves: boolean;
  /** /approvals — also holds the merged My Team tab. */
  approvals: boolean;
  /** /chamary — daily canteen food requests. Rides on the suspense deduction system, so it
   *  also needs `suspense`. */
  chamary: boolean;
  /** /ot-requests — needs `payroll`. */
  otRequests: boolean;
  /** /my-payslips — needs `payroll`. */
  myPayslips: boolean;
  /** /reports */
  reports: boolean;
  /** /profile — the sidebar footer and header avatar link here. Turning this off leaves a
   *  user no way to reach their own record; there is no good reason to. */
  profile: boolean;
  /** /settings — per-user app settings. Same caveat as `profile`. */
  settings: boolean;

  // ── Admin pages ─────────────────────────────────────────────────────────────
  /** /overview */
  overview: boolean;
  /** /attendance-view — admin monthly attendance log. Needs `payroll`. */
  attendanceView: boolean;
  /** /schedule — the employee/date shift grid. */
  schedule: boolean;
  /** /shifts — the standalone shift-assignment page. Hidden where /schedule owns shift
   *  setup instead (its "Manage Shifts" button); the route itself stays reachable there. */
  shifts: boolean;
  /** /users */
  users: boolean;
  /** /companies */
  companies: boolean;
  /** /departments */
  departments: boolean;
  /** /working-places — also holds the merged Outstation manager. */
  workingPlaces: boolean;
  /** /leave-types */
  leaveTypes: boolean;
  /** /roles */
  roles: boolean;
  /** /biometric-enrollment — who has registered a fingerprint/Face ID on the HF-X05 terminals
   *  (src/app/(pages)/biometric-enrollment) vs who hasn't. Off by default: a page listing
   *  enrollment status is meaningless — and unannounced — on a tenant with no terminals. */
  biometricEnrollment: boolean;

  // ── Payroll pages (each one ALSO needs the `payroll` umbrella above) ─────────
  /** /payroll-settings */
  payrollSettings: boolean;
  /** /payroll-employees */
  payrollEmployees: boolean;
  /** /payroll-runs */
  payrollRuns: boolean;
  /** /payroll-loans */
  payrollLoans: boolean;
  /** /salary-advances */
  salaryAdvances: boolean;
  /** /payroll-reports */
  payrollReports: boolean;

  // ── System pages ────────────────────────────────────────────────────────────
  /** /database */
  database: boolean;
  /** /api-playground */
  apiPlayground: boolean;
  /** /system-settings — tenant-wide admin settings. Each category on the page gates itself
   *  (the suspense ones on `suspense`), so the route needs only this flag. */
  systemSettings: boolean;
}

export interface Tenant {
  /** Stable id. Also accepted as `?tenant=` on cron / server-to-server routes. */
  id: string;
  label: string;
  /** Registered domains, primary first. Subdomains (www., app., …) match automatically. */
  domains: string[];
  /** Firestore database id. '' means the project's (default) database. */
  dbId: string;
  /** App name — browser tab, PWA install label, home-screen label. */
  appName: string;
  /** Browser chrome / PWA theme colour. */
  themeColor: string;
  /** Which optional modules this tenant gets. */
  features: TenantFeatures;
  /** A disabled tenant stays in the database but stops resolving — no domain of it serves. */
  status: 'active' | 'disabled';
  /**
   * Folder under public/brand/ holding this tenant's icons, or null to use the icons that
   * already sit at the web root. src/proxy.ts rewrites /icon.png, /app.png,
   * /favicon.ico and /manifest.json into this folder for the tenant's domains, so every
   * existing reference to those paths — UI images, push-notification payloads, and both
   * service workers — resolves to the right brand with no other code change.
   */
  brandDir: string | null;
}

/**
 * What a flag means when a tenant document doesn't carry it.
 *
 * Tenant documents store `features` SPARSELY, so shipping a new module doesn't require an
 * edit to every tenant in the database — the new flag simply falls back to its default here.
 *
 * The defaults follow the two-flag rule: a new PAGE defaults on, because its umbrella already
 * decides whether it can be reached; a new SUBSYSTEM defaults off, because turning a whole
 * module on for every organisation without anyone asking is not a default, it's an accident.
 * A POLICY flag defaults off for the same reason, and a sharper one: it moves numbers rather
 * than pages, so nobody would SEE it arrive.
 */
export const DEFAULT_FEATURES: TenantFeatures = {
  // Subsystems — opt in.
  suspense: false,
  solarApp: false,
  logpupTasks: false,
  payroll: false,
  passkeys: false,
  holidayPayMultipliers: false,
  whatsNew: true,
  // Working-time policy — opt in, exactly as a subsystem is.
  saturdayHalfDay: false,
  // Attendance policy — opt in. It removes a human approval step, so nobody inherits it.
  autoApproveInRangeCheckIn: false,
  // Payroll policy — opt in. See the interface doc: meaningless without roster data.
  strictRosterPayroll: false,
  // Employee pages
  dashboard: true,
  attendance: true,
  mySchedule: true,
  tasks: true,
  leaves: true,
  approvals: true,
  chamary: true,
  otRequests: true,
  myPayslips: true,
  reports: true,
  profile: true,
  settings: true,
  // Admin pages
  overview: true,
  attendanceView: true,
  schedule: true,
  shifts: true,
  users: true,
  companies: true,
  departments: true,
  workingPlaces: true,
  leaveTypes: true,
  roles: true,
  biometricEnrollment: false,
  // Payroll pages
  payrollSettings: true,
  payrollEmployees: true,
  payrollRuns: true,
  payrollLoans: true,
  salaryAdvances: true,
  payrollReports: true,
  // System pages
  database: true,
  apiPlayground: true,
  systemSettings: true,
};

/** Every flag name, in declaration order — drives the config UI and the sparse merge below. */
export const FEATURE_KEYS = Object.keys(DEFAULT_FEATURES) as Array<keyof TenantFeatures>;

/** Fill a sparse/untyped `features` map out to a complete, correctly typed set. */
export function normalizeFeatures(raw: unknown): TenantFeatures {
  const src = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const out = {} as TenantFeatures;
  for (const k of FEATURE_KEYS) {
    out[k] = typeof src[k] === 'boolean' ? src[k] as boolean : DEFAULT_FEATURES[k];
  }
  return out;
}

/**
 * A Firestore tenant document → a Tenant. Every field is defended: this data is edited through
 * a UI and read on the request path of every domain, so one malformed document must degrade to
 * a usable tenant rather than throw somewhere deep in rendering.
 */
export function normalizeTenant(id: string, raw: Record<string, unknown>): Tenant {
  const domains = Array.isArray(raw.domains)
    ? raw.domains.filter((d): d is string => typeof d === 'string' && !!d.trim()).map(d => d.trim().toLowerCase())
    : [];
  const brandDir = typeof raw.brandDir === 'string' && raw.brandDir.trim() ? raw.brandDir.trim() : null;
  return {
    id,
    label:      typeof raw.label === 'string' && raw.label ? raw.label : id,
    domains,
    // normalizeDbId keeps "(default)" from being read as a named database that doesn't exist.
    dbId:       normalizeDbId(typeof raw.dbId === 'string' ? raw.dbId : ''),
    appName:    typeof raw.appName === 'string' && raw.appName ? raw.appName : (typeof raw.label === 'string' ? raw.label : id),
    themeColor: typeof raw.themeColor === 'string' && raw.themeColor ? raw.themeColor : '#0C8ECA',
    brandDir,
    features:   normalizeFeatures(raw.features),
    status:     raw.status === 'disabled' ? 'disabled' : 'active',
  };
}

/**
 * Route → every flag that must be true for that route to exist on a tenant.
 *
 * The single source of truth for "does this page exist here": the sidebar reads the same
 * flags (useSidebarNav.ts) and the app shell ((pages)/layout.tsx) refuses to render an
 * off-module route, so a typed URL or an old bookmark can't walk in behind a hidden nav row.
 *
 * A path not listed here is always allowed — that covers /login, /register, /install and the
 * merged-away redirects (/outstation → /working-places, /my-team → /approvals).
 */
export const MODULE_ROUTES: ReadonlyArray<{
  path: string;
  needs: ReadonlyArray<keyof TenantFeatures>;
}> = [
  // Employee-facing
  { path: '/dashboard', needs: ['dashboard'] },
  { path: '/attendance', needs: ['attendance'] },
  { path: '/my-schedule', needs: ['mySchedule'] },
  { path: '/tasks', needs: ['tasks'] },
  { path: '/leaves', needs: ['leaves'] },
  { path: '/approvals', needs: ['approvals'] },
  { path: '/suspense', needs: ['suspense'] },
  { path: '/chamary', needs: ['suspense', 'chamary'] },
  { path: '/ot-requests', needs: ['payroll', 'otRequests'] },
  { path: '/my-payslips', needs: ['payroll', 'myPayslips'] },
  { path: '/reports', needs: ['reports'] },
  { path: '/profile', needs: ['profile'] },
  { path: '/settings', needs: ['settings'] },
  // Admin
  { path: '/overview', needs: ['overview'] },
  { path: '/attendance-view', needs: ['payroll', 'attendanceView'] },
  { path: '/schedule', needs: ['schedule'] },
  { path: '/shifts', needs: ['shifts'] },
  { path: '/users', needs: ['users'] },
  { path: '/companies', needs: ['companies'] },
  { path: '/departments', needs: ['departments'] },
  { path: '/working-places', needs: ['workingPlaces'] },
  { path: '/leave-types', needs: ['leaveTypes'] },
  { path: '/roles', needs: ['roles'] },
  { path: '/biometric-enrollment', needs: ['biometricEnrollment'] },
  // Payroll
  { path: '/payroll-settings', needs: ['payroll', 'payrollSettings'] },
  { path: '/payroll-employees', needs: ['payroll', 'payrollEmployees'] },
  { path: '/payroll-runs', needs: ['payroll', 'payrollRuns'] },
  { path: '/payroll-loans', needs: ['payroll', 'payrollLoans'] },
  { path: '/salary-advances', needs: ['payroll', 'salaryAdvances'] },
  { path: '/payroll-reports', needs: ['payroll', 'payrollReports'] },
  // System
  { path: '/database', needs: ['database'] },
  { path: '/api-playground', needs: ['apiPlayground'] },
  { path: '/system-settings', needs: ['systemSettings'] },
];

/**
 * Flag → the umbrella flag it ALSO requires, derived from MODULE_ROUTES rather than restated.
 *
 * The config UI uses this to render a page toggle as inert while its subsystem is off, so the
 * two-flag rule is visible instead of being something an operator has to remember. Deriving it
 * means the editor cannot drift out of step with what actually gates the route.
 */
export const FEATURE_UMBRELLA: Partial<Record<keyof TenantFeatures, keyof TenantFeatures>> =
  Object.fromEntries(
    MODULE_ROUTES
      .filter(m => m.needs.length === 2)
      .map(m => [m.needs[1], m.needs[0]]),
  );

/** Display order and grouping for the config UI. Every flag appears exactly once. */
export const FEATURE_GROUPS: ReadonlyArray<{
  title: string;
  description: string;
  keys: ReadonlyArray<keyof TenantFeatures>;
}> = [
  {
    title: 'Subsystems',
    description: 'Whole modules. Turning one off hides every page beneath it.',
    keys: ['suspense', 'payroll', 'passkeys', 'holidayPayMultipliers', 'whatsNew', 'solarApp',
      'logpupTasks'],
  },
  {
    title: 'Working-time policy',
    description: 'How this organisation’s week is shaped. Moves report figures, not access.',
    keys: ['saturdayHalfDay'],
  },
  {
    title: 'Attendance policy',
    description: 'Who has to approve what. Removes a human step; never grants access.',
    keys: ['autoApproveInRangeCheckIn'],
  },
  {
    title: 'Payroll policy',
    description: 'Moves what payroll runs are allowed to do, not what pages are reachable.',
    keys: ['strictRosterPayroll'],
  },
  {
    title: 'Employee pages',
    description: 'What a signed-in employee can reach.',
    keys: ['dashboard', 'attendance', 'mySchedule', 'tasks', 'leaves', 'approvals',
      'chamary', 'otRequests', 'myPayslips', 'reports', 'profile', 'settings'],
  },
  {
    title: 'Admin pages',
    description: 'Back-office pages, still subject to each user’s own capabilities.',
    keys: ['overview', 'attendanceView', 'schedule', 'shifts', 'users', 'companies',
      'departments', 'workingPlaces', 'leaveTypes', 'roles', 'biometricEnrollment'],
  },
  {
    title: 'Payroll pages',
    description: 'Each also needs the Payroll subsystem above.',
    keys: ['payrollSettings', 'payrollEmployees', 'payrollRuns', 'payrollLoans',
      'salaryAdvances', 'payrollReports'],
  },
  {
    title: 'System pages',
    description: 'Administrative tooling.',
    keys: ['database', 'apiPlayground', 'systemSettings'],
  },
];

/** Human labels for the config UI. */
export const FEATURE_LABELS: Record<keyof TenantFeatures, string> = {
  suspense: 'Suspense (expense float)',
  whatsNew: 'What’s New changelog',
  solarApp: 'Solar app cross-link',
  logpupTasks: 'LogPup project tasks',
  payroll: 'Payroll',
  passkeys: 'Passkey sign-in',
  holidayPayMultipliers: 'Holiday / rest-day pay premiums',
  saturdayHalfDay: 'Saturday is a half day',
  autoApproveInRangeCheckIn: 'Auto-approve in-range check-ins',
  strictRosterPayroll: 'Block payroll runs on unrostered attendance',
  dashboard: 'Dashboard',
  attendance: 'Attendance',
  mySchedule: 'My Schedule',
  tasks: 'Tasks',
  leaves: 'Leaves',
  approvals: 'Approvals',
  chamary: 'Chamary (canteen)',
  otRequests: 'Overtime requests',
  myPayslips: 'My Payslips',
  reports: 'Reports',
  profile: 'Profile',
  settings: 'Settings',
  overview: 'Overview',
  attendanceView: 'Attendance View',
  schedule: 'Schedule',
  shifts: 'Shifts',
  users: 'Users',
  companies: 'Companies',
  departments: 'Departments',
  workingPlaces: 'Working Places',
  leaveTypes: 'Leave Types',
  roles: 'Roles',
  biometricEnrollment: 'Biometric Enrollment Status',
  payrollSettings: 'Payroll Settings',
  payrollEmployees: 'Payroll Employees',
  payrollRuns: 'Monthly Run',
  payrollLoans: 'Loans',
  salaryAdvances: 'Salary Advances',
  payrollReports: 'Payroll Reports',
  database: 'Database',
  apiPlayground: 'API Playground',
  systemSettings: 'System Settings',
};

/** Are ALL of these flags on for this tenant? */
export function hasFeatures(
  t: Tenant,
  needs: ReadonlyArray<keyof TenantFeatures>,
): boolean {
  return needs.every((f) => t.features[f]);
}

/**
 * The MODULE_ROUTES entry owning `pathname`, or undefined for an unlisted path.
 * Matches the route itself and anything beneath it (/users/bulk-add belongs to /users), and
 * never across a name boundary — /attendance-view is its own module, not part of /attendance.
 */
export function moduleForPath(pathname: string) {
  return MODULE_ROUTES.find(
    (m) => pathname === m.path || pathname.startsWith(`${m.path}/`),
  );
}

/** Is the module owning `pathname` enabled for this tenant? Unlisted paths are allowed. */
export function isPathEnabled(t: Tenant, pathname: string): boolean {
  const m = moduleForPath(pathname);
  return !m || hasFeatures(t, m.needs);
}

/**
 * Web-root path → the file inside public/brand/<brandDir>/ that replaces it.
 * Keys are the paths already hardcoded across the app and the service workers.
 */
export const BRANDED_ASSETS: Record<string, string> = {
  '/favicon.ico': 'favicon.ico',
  '/icon.png': 'icon-192.png',
  '/app.png': 'icon-512.png',
  '/manifest.json': 'manifest.json',
};

/** The tenant's canonical domain — shown in the boot log. */
export const primaryDomain = (t: Tenant): string =>
  t.domains[0] ?? (t.dbId || t.id || 'localhost');

/**
 * "(default)" is the default database's REAL name, so it's a natural thing to write in an
 * env var — but every "is this a named DB?" check keys off a non-empty string, so left as-is
 * it would read as a named database and route to a database that doesn't exist. Normalise it
 * (and a bare "default") back to '' so it always means the default database.
 */
export function normalizeDbId(raw: string | undefined | null): string {
  const v = (raw || '').trim();
  return /^(\(default\)|default)$/i.test(v) ? '' : v;
}

/** Strip the port and any trailing dot, lowercase. Accepts a Host header or a location.hostname. */
function normalizeHost(host: string | undefined | null): string {
  return (host || '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

/**
 * Exact domain match, or any subdomain of it (www.carecode.org → carecode.org).
 *
 * The list is a PARAMETER, not a module constant: tenants live in the `tenants` Firestore
 * database now, so this file stays pure — it can be unit-tested against any list, and it is
 * still safe to import from both the browser and the server (no firebase import, ever).
 *
 * A disabled tenant never resolves. That is what makes "disable" in the config UI mean
 * something: its domains stop serving rather than quietly continuing to work.
 */
export function tenantByHost(
  host: string | undefined | null,
  tenants: readonly Tenant[],
): Tenant | undefined {
  const h = normalizeHost(host);
  if (!h) return undefined;
  return tenants.find((t) =>
    t.status !== 'disabled' && t.domains.some((d) => h === d || h.endsWith(`.${d}`)),
  );
}

/** By tenant id — the `?tenant=` parameter on cron / server-to-server routes. */
export function tenantById(
  id: string | undefined | null,
  tenants: readonly Tenant[],
): Tenant | undefined {
  const v = (id || '').trim().toLowerCase();
  return v ? tenants.find((t) => t.id.toLowerCase() === v) : undefined;
}

/** Reverse lookup, so an env-var override (dev / preview) still names the right tenant. */
export function tenantByDbId(
  dbId: string | undefined | null,
  tenants: readonly Tenant[],
): Tenant | undefined {
  const v = normalizeDbId(dbId);
  return tenants.find((t) => t.dbId === v);
}

/**
 * The tenant owning `dbId`, or a synthetic stand-in when the id belongs to no registered
 * tenant — e.g. FIRESTORE_DB_ID=test in local dev.
 *
 * Never returns undefined ON PURPOSE. Resolving an unknown id to the first registered tenant
 * would point `…DB_ID=test` at the DEFAULT (production) database, so local dev would silently
 * read and write production. An env override must always select the database it names.
 */
export function tenantForDbId(
  dbId: string | undefined | null,
  tenants: readonly Tenant[],
): Tenant {
  const id = normalizeDbId(dbId);
  const known = tenantByDbId(id, tenants);
  if (known) return known;
  // Branding falls back to the first registered tenant's — an unregistered id is a dev or
  // preview database, not a brand. Only the DATABASE must follow the id given.
  const brandSource = tenants[0];
  return {
    id,
    label: id || 'default',
    domains: [],
    dbId: id,
    appName:    brandSource?.appName    ?? 'App',
    themeColor: brandSource?.themeColor ?? '#0C8ECA',
    brandDir:   brandSource?.brandDir   ?? null,
    features:   brandSource?.features   ?? { ...DEFAULT_FEATURES },
    status: 'active',
  };
}

/**
 * Split the name for the two-tone wordmark, where the tail is drawn in the accent colour:
 *   "PearlCluster" → ["Pearl", "Cluster"]   (camelCase boundary)
 *   "CareCode"     → ["Care", "Code"]
 *   "Southern Lanka" → ["Southern ", "Lanka"] (last space)
 * A single lowercase word has no split point and renders whole.
 *
 * Lives here, not in brand.ts, because brand.ts is a client module and the root layout is a
 * server component — it needs this at build time to bake the split into its pre-hydration
 * branding script.
 */
export function splitBrandName(name: string): [string, string] {
  const space = name.lastIndexOf(' ');
  if (space > 0) return [name.slice(0, space + 1), name.slice(space + 1)];
  const camel = name.search(/[a-z][A-Z]/);
  if (camel > 0) return [name.slice(0, camel + 1), name.slice(camel + 1)];
  return [name, ''];
}
