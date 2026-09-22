# Attendance Web App — working notes

## How to work here

This applies to every request, including the one-line ones. A small prompt is not permission to
take a small approach — most of what has broken in this app broke because a change looked too
obvious to check.

1. **Query the graph before reading files.** `graphify-out/graph.json` holds the whole repo
   (~4.7k nodes, 203 communities). Run `graphify query "<question>"` first; fall back to grep
   only when the graph has nothing. A `post-commit` hook keeps it current — if it looks stale,
   `graphify --update`. Note its own health warning: ~3% of AST edges are unresolved cross-file
   symbol references, so it locates code reliably but is not proof.
2. **Check for a skill before starting.** Process skills first (brainstorming; systematic-
   debugging for a bug), implementation skills after.
3. **Plan before editing.** Anything past a one-line fix gets a plan, and any choice that would
   send the work in materially different directions gets asked rather than assumed.
4. **Finish the whole thing.** i18n in all three languages, a `firestore.rules` block for a new
   collection, the `TenantFeatures` flag plus its `MODULE_ROUTES` entry and sidebar gate,
   loading and empty and error states. A feature missing any of these is not done — it is a bug
   with a UI.
5. **Verify with commands, not confidence.** All three of `npx tsc --noEmit`, `npm test` and
   `npx next build --webpack` must pass, and their real output goes in the report. Beware
   piping the build through `tail`: the pipeline's exit status is the pager's, so a failed
   build reports 0. Read for `Failed to type check` and `build worker exited with code: 1`.
6. **Design deliberately.** `--success`, `--primary` and `--brand` are the same azure here, so
   state must be carried by shape, weight or words. Match the surrounding component idiom
   rather than inventing one; every icon-only control needs a label, and there is no `loading`
   prop on `Button` — call sites hand-roll the spinner.

**Somebody else may be editing at the same time.** More than one session runs against this
working tree. Before a wide edit, `ls -lT` the files — one touched minutes ago is being worked
on. Never "fix" a type error in a file you do not own: two sessions adding the same
`TRANSLATIONS` key produces a duplicate object-literal property and breaks the build for both.
Report it instead. And a long edit to `src/store/appStore.ts` can be clobbered by the other
session writing from a stale buffer, so re-check your keys survived.

## Planned work — read before touching these areas

- **[Working Patterns & Holiday Work](docs/superpowers/specs/2026-09-01-working-patterns-and-holiday-work-design.md)**
  — designed, NOT built. Read it before changing anything about which days count as working
  days, or how many hours a day is expected to be.

  The attendance calendar currently **hardcodes** `Mon-Fri = 8h, Sat = 4h, Sun = rest` inside
  `src/app/(pages)/attendance/page.tsx`. That is wrong for anyone who rests on a day other than
  Sunday, works six days, or works shifts — their gauge, their "Short day" flag and the whole
  month summary are wrong. The spec replaces it with a `work_patterns` model resolved
  role -> location -> company -> default, plus handling for working on a rest day, holiday or
  leave. Start at "Build order"; steps 1-3 are the shippable foundation.

Other specs live in `docs/superpowers/specs/`, their implementation plans in
`docs/superpowers/plans/`.

## Verifying a change

```bash
npx tsc --noEmit          # must be clean
npm test                  # node:test over src/lib/__tests__/*.test.ts
npx next build --webpack  # plain `next build` FAILS in this repo — the flag is required
```

Only one `next build` can run at a time here; retry if it reports a lock.

## Passkeys (WebAuthn sign-in)

A second way in to the same account. Off by default: `TenantFeatures.passkeys`, switched on per
tenant at `/platform`. Passwords and OAuth are untouched wherever it is on.

- **Every WebAuthn route lives under `/api/auth/passkey/*`, and that is not tidiness.**
  serwist's `defaultCache` serves same-origin **GET** requests under `/api/` from a 24-hour
  NetworkFirst cache, and treats `/api/auth/*` as NetworkOnly. A cached challenge is a replay
  window. Everything is POST as well, for the same reason. Do not move these routes.
- **`next.config.mjs` `rewrites()` has a fallback that proxies `/api/:path*`** to
  `NEXT_PUBLIC_API_URL || http://localhost:8000/api`. A misnamed or not-yet-created API route
  does not 404 — it silently proxies to the legacy server. Verify a new route against a real
  build, not against a dev 200.
- **The RP ID comes from the live request host**, never from `primaryDomain(tenant)`. One
  Firebase project serves every domain — same auth pool, same uids — so the RP ID is the only
  thing stopping a passkey minted on one organisation's domain being presented on another's. It
  is stored on the credential and re-checked on every assertion. `tenantForDbId` also returns a
  synthetic tenant with `domains: []` on localhost and previews, where `primaryDomain` degrades
  to a database id rather than a hostname.
- **`/api/auth/passkey/login/verify` is the only caller of `createCustomToken`.** Firebase Auth
  has no WebAuthn provider, so the assertion is verified server-side and exchanged for a custom
  token the browser hands to `signInWithCustomToken`. The token carries **no claims** on
  purpose — claims come from Firestore via `/api/auth/claims`, and stamping them here would be
  a second, weaker source of truth for every rule in `firestore.rules`.
- **A valid key is not a valid account.** That route re-checks `is_active` and
  `date_of_resign`, because a resigned employee's phone still holds a working passkey and the
  password path refuses them in `finaliseLogin`. A second door that skipped the check would
  undo the first.
- `login/options` sends an **empty `allowCredentials`** deliberately. The credentials are
  discoverable, so the device offers the person their own accounts; filling it in would turn the
  endpoint into an account-existence oracle for staff email addresses.
- `webauthn_credentials` and `webauthn_challenges` are **Admin-SDK only**, denied to the browser
  in `firestore.rules`. A client that could read a challenge could answer it; one that could
  write a credential could register a key it holds against another uid.

**FingerprintJS is a label, never a check.** `@fingerprintjs/fingerprintjs` v5 (MIT) scores its
own confidence, and this workforce sits on its worst platforms — from its own
`getOpenConfidenceScore`: iOS/iPadOS **0.3** (every browser there is WebKit, so this cannot be
improved), macOS Safari 16.4+ **0.3**, Android **0.4**, macOS Chrome/Firefox 0.5, Windows 0.6.
0.3 means identical company iPhones on the same iOS version collide on one `visitorId`. Use it
to name a device or notice an unfamiliar one; never to grant, deny, or reject a check-in.
`src/lib/deviceFingerprint.ts` loads it lazily and returns null on every failure path.

## Things that have bitten before

- **Deploy the app BEFORE `firestore.rules`.** The rules resolve every capability from
  Firebase Auth custom claims, and `src/lib/authClaims.ts` (via `POST /api/auth/claims`,
  called once per session by `AuthProvider` just before it force-refreshes the token) is the
  only thing that mints them. A session that has not yet passed through the new AuthProvider
  carries a token with no capability claims, and the tightened rules deny it. Ship the app,
  let people load it, then push the rules. `CLAIMED_CAPABILITIES` in that file must stay in
  lockstep with the `claims().*` references in the rules — a claim the rules read but nobody
  mints reads as false, which is how these helpers ended up stubbed to `isAuth()` for months
  and made every signed-in employee a system admin.

- **A new Firestore collection needs a `firestore.rules` match block.** Rules are default-deny,
  so without one every read and write is silently denied. This has caused real bugs more than
  once.
- **`firebase.json` deploys `firestore.rules` to `(default)` and `test` only.** The
  `southernlanka` database is NOT a deploy target, so `firestore.southernlanka.rules` never
  ships from this repo. Do not assume a new collection is readable there.
- **i18n parity is enforced by the type system.** Every user-facing string needs `en` + `si` +
  `ta` entries in `TRANSLATIONS` (`src/store/appStore.ts`); the three blocks must hold the same
  keys in the same order or `TKey` breaks the build.
- **`--success`, `--primary` and `--brand` all resolve to the same azure** in
  `src/app/globals.css`. Hue alone cannot distinguish states — use shape, weight or text.
- **Firestore reads must wait for Firebase Auth.** `_hasHydrated` on the auth store only means
  zustand finished reading localStorage; it says nothing about `auth.currentUser`. Reading too
  early returns `permission-denied` on a perfectly valid session — `AuthProvider` gates on the
  first `onAuthStateChanged` callback for exactly this reason.
- **This app has no overtime pay.** Do not label extra hours "Overtime" in the attendance UI;
  it implies an entitlement that does not exist. The calendar says "Extra hours". The payroll
  module's PH/Poya multipliers are a separate, genuinely paid concept.
- **An approval-routing rule that can return false for EVERY viewer leaves sessions
  `pending` forever.** Nothing else ever surfaces them. Shift-place routing did exactly that
  for months: a place tagged `shift` routed only to the employee's assigned supervisor and
  overrode the place's own `supervisor_epfs`, so a location supervisor of that place saw
  nothing to approve. The rules now live in `src/lib/approvalRouting.ts` (pure, unit-tested)
  — change routing there, add a test, and remember the backlog list is date-bounded (an
  approver widens it with "Load older" on `/approvals`). To check real data, replay the rules
  with the Admin SDK (`FIREBASE_ADMIN_*` in `.env.local`, see `scripts/firestore-backup.mjs`
  for the init pattern) rather than reasoning from the code alone.

## Tenancy

One deployment serves several domains. **There is no tenant list in the codebase** — tenants
live in their own Firestore database (`tenants`), edited at `/platform`. Features are switched
per tenant through `TenantFeatures`; never check `tenant.id` at a call site.

- `src/lib/tenants.ts` is PURE — types, `MODULE_ROUTES`, host matching. It takes the tenant
  list as an argument and must never import firebase.
- `src/lib/tenantRegistry.ts` (server-only) loads it. `tenantsSync()` never blocks and is what
  `adminDbFor` uses; `awaitTenants()` blocks and is what the root layout uses.
- The root layout is `force-dynamic`: it resolves the host and injects `window.__TENANT__`
  before any bundle runs. That ordering is load-bearing — it is why module-scope reads like
  `const F = tenant.features` still work.
- `src/generated/tenants.snapshot.json` is MACHINE-WRITTEN (`npm run tenants:snapshot`). Never
  hand-edit it. It is the cold-start failsafe and the only list Edge middleware can read.

`TenantFeatures` holds one flag per page on top of the cross-cutting ones (`suspense`,
`payroll`, …); a page inside a subsystem needs both (`/payroll-runs` needs `payroll` AND
`payrollRuns`). `MODULE_ROUTES` maps each route to the flags it needs, and the app shell
(`src/app/(pages)/layout.tsx`) refuses to render an off-module route — so **a new page needs a
flag, a MODULE_ROUTES entry and its sidebar gate**, and hiding a nav row is never on its own
enough to keep anyone out of a page.

### The three levels of admin

They are three different things, granted in three different places. Do not collapse them.

1. **System Admin** — `RoleCapabilities.is_system_admin`, a capability on a role in ONE tenant's
   `roles` collection. Full access to that system: every page, every write, the DB editor. It
   ends at that system's border. Most administrators are this and should stay this.

2. **Super Admin** — `RoleCapabilities.is_super_admin` (implies System Admin), or the per-user
   `AppUser.is_super_admin` flag set from the Users page. Either route resolves to the same
   capability set — `isSuperAdminUser()` in `src/lib/permissions.ts` is the single definition,
   unit-tested in `src/lib/__tests__/superAdmins.test.ts`, and it is what
   `src/lib/superAdminSync.ts` mirrors on. The mirror copies the account into every tenant
   database, which is what makes "every system" true: they sign in on any domain and are a full
   admin there. Scope is still "every system **this account exists in**" — the mirror, not a
   standing authority over the deployment.

3. **Platform Admin** — a document in `platform_admins` in the **tenants registry database**,
   granted by email, verified server-side by `verifyPlatformCaller`
   (`src/lib/platformAdmins.ts`). The only cross-tenant authority in the app: which domains
   exist, which database each talks to, which modules each organisation gets. The
   `platform_admin` custom claim is a presentation hint and never an authority.

**A role can never grant level 3.** Roles are edited inside a tenant, so if ticking a box in one
organisation could confer platform access, anyone who can edit roles in that organisation would
own every other organisation in the deployment. Super Admin therefore makes someone *eligible*
for platform configuration and nothing more — an existing platform admin still adds them by
email. A Super Admin who opens `/platform` without being on that list gets a page saying so;
the API still refuses. If you ever find yourself widening `verifyPlatformCaller` to consult a
role, a capability, a claim or a users doc, you are about to break this.

The sidebar's Platform entry is shown for the `platform_admin` claim (fast path, no request) OR
a Super Admin — presentation only, and the page is what answers.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
