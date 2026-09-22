# Attendance Web App

Workforce attendance, leave, scheduling and payroll for several organisations, served by **one
deployment** across several domains. Each organisation gets its own Firestore database, its own
branding and its own set of enabled modules; they share one codebase, one Firebase project and
one Auth pool.

Live today:

| Domain | Brand | Firestore database |
| --- | --- | --- |
| `attendance.altavision.lk` | PearlCluster | `(default)` |
| `carecode.org` | CareCode | `southernlanka` |

---

## Stack

- **Next.js 16** (App Router) + **React 19**, TypeScript throughout
- **Firebase** — Firestore (multi-database), Auth, Storage, Cloud Messaging; `firebase-admin`
  on the server
- **Tailwind** + Radix primitives, Framer Motion
- **Zustand** for client state (persisted where it saves a round trip)
- **Serwist** service worker — installable PWA, offline reads, push notifications
- **Netlify** hosting; Firebase Cloud Functions for scheduled work

Notable extras: Leaflet maps for check-in geofencing, ExcelJS/jsPDF exports, Tesseract +
Gemini for reading expense bills, `react-three-fiber` for the ID-card lanyard.

---

## Quick start

```bash
npm install
cp .env.example .env.local     # then fill in the Firebase values
npm run dev                    # http://localhost:3000
```

`.env.example` is the reference for every variable and documents what each one does — read it
rather than this list. The ones you cannot start without:

| Variable | Why |
| --- | --- |
| `NEXT_PUBLIC_FIREBASE_*` | Client SDK: API key, auth domain, project, bucket, sender, app id |
| `FIREBASE_ADMIN_PROJECT_ID` / `_CLIENT_EMAIL` / `_PRIVATE_KEY` | Server SDK — token verification, admin routes, backups |
| `NEXT_PUBLIC_FIRESTORE_DB_ID` / `FIRESTORE_DB_ID` | **Local dev only.** Which tenant database localhost talks to |

The `NEXT_PUBLIC_FIREBASE_*` keys are meant to be in the client bundle — they identify the
project, they do not grant access. Firestore rules do the enforcing. `netlify.toml` disables
Netlify's secret scanner for exactly this reason; every real secret is non-`NEXT_PUBLIC_`.

Server-only secrets, all documented in `.env.example`: `GOOGLE_API_KEY` (Gemini bill reading),
`WORKFORCE_API_KEY`, `FINGERPRINT_API_KEY`, `ATTENDANCE_JWT_SECRET` + `SOLAR_APP_URL`,
`EXTERNAL_API_KEY`, `CRON_SECRET`, `CALENDARIFIC_API_KEY`.

---

## Verifying a change

```bash
npx tsc --noEmit     # must be clean
npm test             # node:test over src/lib/__tests__/*.test.ts
npm run build        # next build --webpack
```

`npm run build` carries the `--webpack` flag on purpose. **Plain `next build` fails in this
repo.** Only one build can run at a time — retry if it reports a lock.

Tests compile through `tsconfig.test.json` into `.test-out/` and run on `node:test`, so they
cover pure logic in `src/lib` — no DOM, no Firestore. Anything worth testing belongs there.

---

## Multi-tenancy

Tenants live in their own Firestore database (`tenants`), edited through the `/platform` UI —
there is no tenant list in the codebase. One build serves every domain, so the database cannot
come from a build-time env var, and the browser cannot look it up either: it would need the map
in order to know which database to open. The **server** resolves it and injects the answer.

```
request → root layout (per-request) → awaitTenants() → resolve host → tenant
        → injected as window.__TENANT__ before any bundle runs
        → src/lib/firebase.ts reads it synchronously → opens the right database
server  → tenantForRequest(req) → adminDbFor(req)      (tenantsSync, never blocks)
```

| Module | Role |
| --- | --- |
| `src/lib/tenants.ts` | Pure logic — types, `MODULE_ROUTES`, host matching. Takes the list as an argument and **must never import firebase**; both browser and server use it |
| `src/lib/tenantRegistry.ts` | Server-only loader. `awaitTenants()` blocks on Firestore, `tenantsSync()` never does |
| `src/lib/tenantSnapshot.ts` | The list that shipped with the deploy — cold-start fallback, and the only list Edge middleware can read |
| `src/lib/tenantClient.ts` | Reads `window.__TENANT__` in the browser |

In API routes always use `adminDbFor(req)` — a bare `adminDb()` falls back to the env default
and will silently read the wrong organisation's data.

**The snapshot is a failsafe, not a source of truth.** `src/generated/tenants.snapshot.json` is
machine-written by `npm run tenants:snapshot` (which also runs before every build) and must
never be hand-edited. Without it, one bad write or one Firestore outage would leave every
domain unable to resolve its own database.

### Module flags

`TenantFeatures` carries the cross-cutting subsystems (`suspense`, `payroll`, `whatsNew`,
`solarApp`) **plus one flag per page**. A page inside a subsystem needs both: `/payroll-runs`
needs `payroll` **and** `payrollRuns`. That is what lets one tenant keep payroll while dropping
Loans.

`MODULE_ROUTES` maps each route to the flags it needs. Three places read them:

1. `useSidebarNav.ts` — whether the nav row renders
2. `src/app/(pages)/layout.tsx` — whether the **route** renders at all, so a bookmark or a typed
   URL cannot reach a module the tenant does not have
3. the page itself, where it already had a guard

**Adding a page therefore means a flag, a `MODULE_ROUTES` entry and a nav gate.** Hiding a
sidebar row on its own keeps nobody out.

### Adding a domain

Registering the domain is the **last** step, and the only one done in the UI. Everything a
config screen cannot do comes first:

1. Create the Firestore database in the Firebase console
2. Add a matching entry to `firebase.json`, then deploy **rules and indexes** to it
3. Firebase Auth → Settings → Authorized domains → add the domain
4. Add the database id to `TENANT_DB_IDS` in `functions/.env`
5. Brand icons: drop them in `public/brand/<brandDir>/` (see `scripts/gen-brand-icons.mjs`) and
   deploy — `brandDir` names real files, so a new brand needs a deploy either way
6. `/platform` → **Register tenant** — associates the domain with that database

`dbId` is immutable once registered. Re-pointing a live domain at another organisation's
database is the worst thing this system could do, so there is no code path that writes one.

### Platform configuration (`/platform`)

Available on every domain, outside the app shell, with its own sign-in. Edits branding,
domains and module flags; registers and disables tenants; manages who else has access. Every
change is recorded with before/after and can be restored in one click.

Access is a separate tier from a tenant's own `is_super_admin` — running one organisation
confers nothing here. `PLATFORM_BOOTSTRAP_EMAIL` in `src/lib/platformAdmins.ts` is always
admitted and cannot be revoked, so an empty admin list can never lock everyone out. Signed-in
platform admins also get a **Platform Config** button in the sidebar, shown from a Firebase
Auth custom claim so it costs no request; the server re-checks the real list on every call.

```bash
npm run tenants:list       # what the registry currently holds
npm run tenants:seed       # snapshot → database (additive; --force to overwrite)
npm run tenants:snapshot   # database → snapshot (also runs before every build)
```

---

## Project layout

```
src/
  app/
    (pages)/          every authenticated page; layout.tsx is the app shell
    api/              route handlers — admin, cron, fingerprint, payroll, solar, …
    login/ register/ install/     public pages
  components/         UI, grouped by feature (payroll/, reports/, suspense/, lunch/, …)
  services/           Firestore access, one module per domain object
  store/              zustand stores + the i18n TRANSLATIONS table
  lib/                pure logic — geo, permissions, tenants, payroll maths, exports
    __tests__/        node:test suites
  proxy.ts            middleware: per-domain icons and manifest
functions/            Firebase Cloud Functions (scheduled jobs)
scripts/              one-off and operational Node scripts
docs/superpowers/     specs and implementation plans
```

`src/lib` is the only place with tests, so logic worth trusting belongs there rather than inside
a component.

---

## Firestore

- `firestore.rules` + `firestore.indexes.json` are the deployed pair.
- `firebase.json` deploys them to **`(default)` and `test` only.** The `southernlanka` database
  is not a deploy target, so `firestore.southernlanka.rules` never ships from this repo.
- Rules are **default-deny**: a new collection with no `match` block has every read and write
  silently denied. This has caused real bugs more than once.
- Reads must wait for Firebase Auth. `_hasHydrated` on the auth store only means zustand
  finished reading localStorage — it says nothing about `auth.currentUser`. `AuthProvider` gates
  on the first `onAuthStateChanged` callback for exactly this reason.

Backups: `npm run db:backup` / `npm run db:restore` (`scripts/firestore-backup.mjs`), plus
`/api/admin/backup` and the OneDrive uploader for scheduled copies.

---

## Integrations

| Surface | Auth | Docs |
| --- | --- | --- |
| `/api/fingerprint/*` — HF-X05 terminals | `FINGERPRINT_API_KEY` **and** a registered, active device | [FINGERPRINT_ATTENDANCE_API.md](FINGERPRINT_ATTENDANCE_API.md) |
| `/api/working-status` — planning app feed | `WORKFORCE_API_KEY` | [WORKING_STATUS_API.md](WORKING_STATUS_API.md) |
| `/api/solar-sso`, `/api/solar/*` — Solar app | `ATTENDANCE_JWT_SECRET`, `EXTERNAL_API_KEY` | Alta Vision only (`solarApp` flag) |
| `/api/cron/*` — scheduled jobs | `CRON_SECRET`; `?tenant=all` fans out across databases | — |

---

## Versioning and deployment

`src/data/version.json` is the single source of truth. Patch bumps happen automatically on every
merged PR (`.github/workflows/version-bump.yml`); minor and major are manual:

```bash
npm run version:minor
npm run version:major
```

Netlify builds with `npm run build` and publishes `.next`. `netlify.toml` also pins the static
asset cache headers and routes `next/image` through Netlify Images.

---

## Conventions worth knowing

- **i18n parity is enforced by the type system.** Every user-facing string needs `en` + `si` +
  `ta` entries in `TRANSLATIONS` (`src/store/appStore.ts`); the three blocks must hold the same
  keys in the same order or `TKey` breaks the build.
- **`--success`, `--primary` and `--brand` all resolve to the same azure** in `globals.css`. Hue
  alone cannot distinguish states — use shape, weight or text.
- **This app has no overtime pay.** Extra hours are never labelled "Overtime" in the attendance
  UI; the calendar says "Extra hours". Payroll's PH/Poya multipliers are a separate, genuinely
  paid concept.
- **Switch features per tenant through `TenantFeatures`,** not by checking `tenant.id` at a call
  site.

---

## Planned work

Designs live in `docs/superpowers/specs/`, their implementation plans in
`docs/superpowers/plans/`. Read the spec before touching the area it covers. Platform tenant
configuration is **built** — see
[its spec](docs/superpowers/specs/2026-09-02-platform-tenant-config-design.md) for why it is
shaped the way it is.

- **[Working patterns and holiday work](docs/superpowers/specs/2026-09-01-working-patterns-and-holiday-work-design.md)**
  — designed, **not built**. The attendance calendar currently hardcodes `Mon–Fri = 8h,
  Sat = 4h, Sun = rest`, which is wrong for anyone who rests on another day, works six days or
  works shifts. The spec replaces it with a `work_patterns` model resolved
  role → location → company → default.
