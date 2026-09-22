# LogPup tasks in the Attendance Web App

**Status: the Attendance half is BUILT.** All three parts are implemented in this repo and the
build, type-check and test suite pass. Nothing works end to end yet, because **the LogPup half
does not exist** — every endpoint here degrades to empty or refuses until it does. The LogPup
change list is at `LogPup/docs/attendance-task-bridge.md`.

The sections below describe the design and the reasoning; "Built in this repo" at the end lists
the files as they now stand, and "What LogPup must implement" is the exact contract the other
side has to meet.

---

## What we are adding

An Alta Vision employee is assigned project work in LogPup — a task on a sprint board, inside an
app. They spend their working day in this app instead. Today that work is invisible here, so the
same person describes it twice: once on a LogPup board, once in the daily task log.

This adds, for Alta Vision users only:

1. **A read** of the signed-in person's own LogPup tasks, live, no copy stored.
2. **A write-back of status only** — Pending, On Progress, Completed — which lands on the real
   LogPup task and shows up in the LogPup activity feed under that person's name.
3. **Sign-in handoff in both directions**, so the same person moves between the two apps without
   a password at the boundary. That is Part two.
4. **Notifications.** A LogPup assignment rings the bell here and pushes to the phone; a status
   change made here notifies the relevant people in LogPup. That is Part three.

All three parts share the tenant gate and the email join, and each ships independently. Part three
depends on LogPup wiring an in-app assignment notification it does not currently have — that work
is on the LogPup side and is described there.

It is deliberately a **third source of work items**, shown beside the two we already have, not
merged into either:

| Source | Collection | What it is |
|---|---|---|
| `DailyTask` | `tasks` | A personal daily work-hours log, tied to attendance sessions. |
| `AssignedTask` | `assigned_tasks` | A shared, multi-person task raised by a supervisor here. |
| **LogPup task** | none — read live | Project work assigned on a LogPup sprint board. |

Merging them would mean one list where a row's edit rules, status vocabulary and owner differ
per row with nothing on screen saying so. They get their own section.

---

## The gate: Alta Vision only

This is enforced **twice, independently**, and neither layer is the only thing standing there.

1. **Here, by tenant.** A new feature flag `logpupTasks`, on for the `altavision` tenant only.
   This is the layer that matters: one deployment serves `altavision.lk` and `carecode.org` off
   different Firestore databases, and the tenant is resolved per request from the hostname.
2. **In LogPup, by email domain.** `LOGPUP_BRIDGE_DOMAINS=altavision.lk`. An address outside it
   resolves to nobody, even with a valid API key.

`tenant.features.solarApp` is the precedent to copy in every respect — it is the existing Alta
Vision-only cross-app integration, and `useSolarNotifications` already shows the correct way to
make a hook **inert** on other tenants rather than merely hiding its output.

---

## Identity: how an Attendance user becomes a LogPup user

**The join key is the work email, lowercased. Nothing else.**

`AppUser.email` here, `users.email` there. LogPup has no EPF number and we have no LogPup uuid,
so email is the only field both systems already hold for the same human.

Consequences worth saying out loud:

- A person whose `AppUser.email` does not match a LogPup account sees an empty section. That is
  correct, not a bug to paper over with name matching.
- **Do not send `epf` or `phone`** the way the Solar identity match does. Solar accepts three
  identifiers; LogPup accepts one, and offering more would invite a fallback that matches the
  wrong person.
- The email must come from the **verified ID token and the Firestore profile**, never from the
  request body. See the auth rule below.

---

## Server-side plumbing

### 1. `src/lib/logpupApi.ts` (new)

Server-only client, modelled directly on `src/lib/solarApi.ts`. Open that file first; this one is
the same shape with a different base URL and key.

```ts
const BASE = (process.env.LOGPUP_APP_URL || 'https://logpup.altavision.lk').replace(/\/$/, '')

function authHeaders(): Record<string, string> {
  const key = process.env.LOGPUP_API_KEY
  if (!key) throw new Error('LOGPUP_API_KEY is not configured')
  return { 'x-api-key': key, Accept: 'application/json' }
}

export interface LogPupTask { /* see the contract section */ }
export function getLogPupTasks(who: { email: string; status?: 'open' | 'all'; limit?: number }): Promise<LogPupTasksResponse>
export function setLogPupTaskStatus(args: { taskId: string; email: string; status: LogPupStatus; note?: string }): Promise<LogPupTaskResponse>
```

**Never import this from a client component.** The file comment in `solarApi.ts` says it and
means it: the key is read at module scope, and a client import bundles it into JavaScript served
to the browser. It is used only inside route handlers under `src/app/api/logpup/`.

### 2. `src/app/api/logpup/tasks/route.ts` (new) — the read proxy

Copy the structure of `src/app/api/solar/notifications/route.ts` exactly, including the parts that
look like defensive noise:

- **`POST`, not `GET`**, because the Firebase ID token goes in the body. Same as the Solar route.
- **Verify the ID token, then read the email from Firestore, not from the token alone and never
  from the body.** `adminDbFor(req).collection('users').where('uid', '==', uid).limit(1)` is the
  authoritative profile. Taking the email from the request body would let any signed-in user
  request anyone else's tasks — the single worst failure this feature can have.
- **Keep the in-instance identity cache.** Solar's comment records the reason: at 300-plus users
  the per-poll Firestore lookup was the biggest read amplifier in the app. A `Map<uid, {email,
  at}>` with a 10-minute TTL. Email changes are rare, and a stale one for ten minutes shows a
  person the wrong empty list at worst.
- **Production with no Firebase Admin credentials returns an empty list, never the body-supplied
  identity.** The dev-only fallback in the Solar route is guarded by
  `process.env.NODE_ENV !== 'production'`; keep that guard exactly as it is.
- **Degrade quietly.** The outer `catch` returns `200` with
  `{ success: false, matched: false, count: 0, data: [] }`. LogPup being unreachable must not
  break the tasks page of an app whose actual job is attendance.
- `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'`.

### 3. `src/app/api/logpup/tasks/[id]/status/route.ts` (new) — the write proxy

Same auth preamble, then `setLogPupTaskStatus`. Three differences from the read route:

- **It must not swallow errors.** The read degrades to empty because an empty list is honest. A
  write that silently fails shows the user a status that did not save, and they close the laptop
  believing they marked something done. Surface the failure and let the UI say so.
- **Forward LogPup's refusal sentence verbatim.** LogPup answers `403` when the caller is not an
  assignee, and `503` during a maintenance freeze, each with a plain sentence. Rewriting those
  into "Something went wrong" throws away the only useful part.
- **No optimistic UI on the write.** Keep the row in a saving state until the response lands, then
  render what came back. The authoritative status is the one LogPup returned, not the one we sent.

### 4. `src/lib/tenants.ts` — the feature flag

Four edits, all in that one file. Every flag must appear in all four places; the type demands the
first three, and the config UI silently drops a flag missing from `FEATURE_GROUPS`.

1. `TenantFeatures` — add `logpupTasks: boolean` in the cross-cutting subsystems block, with a
   comment in the style of its neighbours saying what it gates and why it is Alta Vision only.
2. `DEFAULT_FEATURES` — `logpupTasks: false`. It is a subsystem, and the file's own rule is that
   a new subsystem defaults off: turning a whole module on for every organisation without anyone
   asking is not a default, it is an accident.
3. `FEATURE_GROUPS` — append to the `Subsystems` group's `keys`, next to `solarApp`.
4. `FEATURE_LABELS` — `logpupTasks: 'LogPup project tasks'`.

**Do not add a `MODULE_ROUTES` entry.** This adds no route. It adds a section inside `/tasks`,
which is already gated by the `tasks` flag. An entry there would also register a bogus umbrella
relationship in `FEATURE_UMBRELLA`, which is derived from `MODULE_ROUTES` rather than restated.

Then turn it on for the `altavision` tenant through the registry — `node scripts/tenant-registry.mjs`
— not by editing code. That is what the registry is for: adding a domain or turning a module off
must not require a deploy.

### 5. `.env.example`

```bash
# ── LogPup task bridge (see LOGPUP_TASKS_INTEGRATION.md) ──
# Base URL of the LogPup deployment.
LOGPUP_APP_URL=https://logpup.altavision.lk
# Shared secret, sent as x-api-key. Distinct from EXTERNAL_API_KEY, which is the Solar key —
# one compromised integration must not hand over the other.
LOGPUP_API_KEY=
```

---

## Client-side

### 6. `src/components/useLogPupTasks.ts` (new)

Read `src/components/useSolarNotifications.ts` first and follow it closely.

```ts
export function useLogPupTasks(enabled: boolean): {
  tasks: LogPupTask[]
  loading: boolean
  reachable: boolean          // false once a fetch has failed — drives the quiet notice
  refetch: () => Promise<void>
  setStatus: (taskId: string, next: AttendanceTaskStatus) => Promise<void>
}
```

Rules carried over from the Solar hook, each for a reason already paid for:

- **Inert when off.** `const on = enabled && tenant.features.logpupTasks`, and the effect returns
  immediately when `on` is false. Not "fetch then hide": on Southern Lanka this hook must issue
  no request at all.
- **60-second poll, plus a `window` focus listener.** Not 30. The Solar hook's comment records
  that the faster cadence doubled backend load at 300-plus users for no visible freshness win.
- **A `stopped` flag checked after every `await`,** and cleanup that clears the interval and
  removes the focus listener. A poll resolving after unmount otherwise sets state on a dead
  component.
- `setStatus` posts, then refetches, then resolves. The caller can `await` it to know the change
  actually landed.

### 7. `src/lib/logpupStatus.ts` (new) — the mapping, in one place

```ts
export const TO_ATTENDANCE = { todo: 'Pending', in_progress: 'On Progress', done: 'Completed' } as const
export const TO_LOGPUP = { Pending: 'todo', 'On Progress': 'in_progress', Completed: 'done' } as const
```

Pure, and unit-tested in `src/lib/__tests__/` alongside its siblings.

The load-bearing part is what it **refuses**. `AssignedTask.status` here is a `string`, not the
closed `TaskStatus` union, precisely so a tenant can configure custom statuses beyond the three
(see `task_status_config` in `assignedTaskService.ts`). LogPup's `task_status` enum has exactly
three values and no others. So `TO_LOGPUP` must be a total function over the three and a hard
failure on anything else — never a silent fallback to `todo`, which would quietly reopen finished
work. The picker on a LogPup row therefore offers **only** those three, and never the custom
statuses the `assigned_tasks` picker offers.

### 8. `src/app/(pages)/tasks/page.tsx` — the surface

That file is already 2,105 lines with three views (`calendar`, `list`, `board`) and two modes
(`mine`, `team`). Do not add a fourth view and do not thread LogPup state through the existing
state machine.

Add instead a **self-contained section component**, `src/components/tasks/LogPupTaskList.tsx`,
which owns the hook and renders nothing at all when `!tenant.features.logpupTasks`. The page's
only change is to render it. One import, one line, one component that can be deleted in one
commit.

Placement: in the `mine` mode, beneath the existing personal task list. LogPup tasks are never
shown in `team` mode — the team roster is EPF-keyed and built from supervisor relationships in
this app, which say nothing about who is on a LogPup sprint board.

Each row shows title, app name, sprint, due date, and a status control. Things worth carrying
through from the payload rather than dropping:

- **`dueKind`.** A `committed` due date was promised to a named counterparty, and
  `dueCommitmentNote` says to whom. Rendering it identically to a `target` date discards the
  entire distinction LogPup maintains a separate column for. Mark commitments visibly.
- **`dueDate` is a `YYYY-MM-DD` string and stays one.** Do not `new Date()` it. That parses as
  midnight UTC, which is the previous day in Asia/Colombo — this repo has been bitten by exactly
  this before. Compare it as a string against `localDateString()`, the same way
  `taskService.getDueTasks` already does.
- **`isPrimaryAssignee: false`** means the person is on the task but not the accountable owner.
  Say so on the row.
- **A link out to LogPup** (`task.url`), so the board is one click away when someone needs the
  context this section deliberately does not carry.

### 9. Design system

Build it with `@/components/ui` primitives and the existing token classes. Do not reach for raw
`sky-`, `slate-`, `white` or glass utility classes, and do not invent a new card style to make
LogPup rows look foreign. They are that person's work; they should look like the rest of their
work.

---

## Part two: navigating between the two apps

Showing the task is half of it. The other half is reaching the board — and coming back — without
a password at the boundary. Two mechanisms, because the two apps mint sessions in completely
different ways: LogPup is next-auth with a JWT session, this app is Firebase Auth.

### The fallback is the feature

Say this before the machinery, because it is what actually carries most of the traffic: **both
apps are PWAs with persistent sessions**, so the overwhelmingly common case is that the person is
*already signed in at the other end*. A plain link works, and the single-sign-on round trip was
never needed.

So the button is a link that *upgrades* to SSO, and every failure path falls back to opening the
plain URL. `SolarAppButton.tsx` already does exactly this, down to the toast. A broken handoff
must cost a click, not a journey.

### Attendance to LogPup

#### 1. `src/app/api/logpup-sso/route.ts` (new)

Copy `src/app/api/solar-sso/route.ts`. The structure is identical and correct: verify the caller's
Firebase ID token, read the authoritative profile from Firestore, mint a short-lived HS256 JWT,
return the URL to open.

Four differences, each deliberate:

- **A different secret: `LOGPUP_SSO_SECRET`.** Not `ATTENDANCE_JWT_SECRET`, which is Solar's, and
  not `LOGPUP_API_KEY`, which is the task API's. Three integrations, three secrets: one
  compromised handoff must not hand over the others.
- **Fewer claims.** `{ sub: email, email, name, jti, iat, exp }` and nothing else. The Solar token
  carries `epf`, `phone` and `role` because Solar uses them. LogPup uses none of the three, and
  **`role` in particular must never cross** — LogPup has its own role model and capability
  matrix, and a role shipped from here would be a second, weaker source of truth for every
  permission in that app.
- **`jti` is required.** A fresh uuid per mint. LogPup records redeemed ids and refuses a repeat,
  because the token rides in a URL and URLs survive in history, referrer headers and logs.
- **The tenant check.** `tenantForRequest(req).id !== 'altavision'` returns 403. The
  `logpupTasks` flag governs the UI; this governs the endpoint, and an endpoint that trusts the UI
  to have hidden its button is not gated.

Keep the Solar route's two load-bearing habits: identity comes from the Firestore profile and
never from client-supplied claims, and an inactive account (`is_active === false`) is refused
before a token is minted. Add `date_of_resign` to that check — the passkey verify route already
treats a resignation as inactive, and this one should agree with it.

Expiry: 3 minutes, as Solar uses.

#### 2. `src/components/LogPupAppButton.tsx` (new)

Copy `SolarAppButton.tsx` wholesale and change the URL, icon and label. Three details in that file
were paid for in production and are invisible if you rewrite it from scratch:

- **A top-level navigation on touch devices, a new tab on desktop.** Only a top-level navigation
  triggers OS link-capturing, so an installed LogPup PWA opens in the installed app rather than a
  browser tab. A redirected `about:blank` popup is *not* captured.
- **The desktop placeholder tab opens synchronously, before the `await`,** or the browser blocks
  it as a popup. It opens *without* `noopener` — with it, `window.open` returns null, the handle
  is lost and an orphaned blank tab is left behind. The `opener` is severed afterwards instead.
- **Every failure path calls `go(LOGPUP_URL)`** and toasts "please sign in".

#### 3. `src/app/(pages)/layout.tsx` — where it goes

The sidebar footer already chooses between `SolarAppButton` and `GetAppButton` on
`tenant.features.solarApp`. Add the LogPup row next to that, on `tenant.features.logpupTasks`.

Note that the URL cannot be hardcoded the way Solar's is if LogPup ever gets a second host — read
`GetAppButton.tsx`'s comment for why one build serving every domain makes hardcoding a trap. One
LogPup deployment exists today, so a constant is honest for now; put it in `logpupApi.ts`'s
public-safe neighbour, not inline in the component.

### LogPup to Attendance

This direction needs a Firebase custom token, and this app already has the one route that mints
them.

#### 4. `src/app/api/auth/logpup-sso/route.ts` (new)

Read `src/app/api/auth/passkey/login/verify/route.ts` first. It is described in its own header as
the only place in the app that calls `createCustomToken`, and that comment stops being true the
moment this route lands — **update it in the same change**, or the next person reads a promise the
code no longer keeps.

The flow: verify the LogPup-signed JWT with `jose`, **pinning `algorithms: ['HS256']`** (a
verifier that accepts whatever the token's header claims will accept `alg: none`), reject a `jti`
already seen, look up `users` by `email`, refuse when `is_active === false || date_of_resign`,
then `adminAuth().createCustomToken(uid)`.

**The custom token carries no claims of its own.** The passkey route's header says why, and it
applies here word for word: claims come from Firestore via `/api/auth/claims`, and a route that
could stamp them would be a second, weaker source of truth for every permission in
`firestore.rules`. Do not attach a role because LogPup sent one — it must not send one.

Two further requirements:

- **Rate-limit it**, with `checkRateLimit(db, 'logpup_sso', clientIp(req), …)`, the way both the
  passkey verify and resolve-login routes do. This is an unauthenticated endpoint that performs a
  user lookup.
- **Replay guard.** LogPup owns a `sso_redemptions` table for the other direction; this direction
  needs its own, in Firestore. A doc keyed by `jti` written with `create()` (not `set()`) — the
  create fails on an existing id, so the write is the check and two tabs racing cannot both win.
  Give it a TTL policy or sweep it in the existing `cron/maintenance-lifecycle` job.

#### 5. `src/app/sso/logpup/page.tsx` (new) — the receiver

Reads `?token=` and `?next=`, POSTs to the route above, then
`signInWithCustomToken(auth, token)` followed by `finaliseLogin(cred.user.uid)` — the same two
lines `completePasskeySignIn` in `src/app/login/page.tsx` already uses. Reuse that path rather
than writing a parallel one: `finaliseLogin` applies the active/resigned gate and `AuthProvider`'s
`onAuthStateChanged` mints the capability claims. Nothing downstream can then tell how the person
got in, which is the point.

**Validate `next` as a same-origin relative path** — it must start with a single `/` and not
`//`. An unvalidated `next` on a sign-in route is an open redirect, the classic way to harvest a
session by bouncing someone to a lookalike host. Anything else falls back to `/dashboard`.

This page must render while signed out. Check `src/proxy.ts` and the `(pages)` layout, which
gates on an authenticated session; `/sso/logpup` needs to sit outside that gate the way `/login`
and `/register` do. **Verify it rather than assuming** — a receiver that bounces to the login page
before it can redeem the token is a handoff that never works, and it fails only in the signed-out
case nobody tests.

### Deep links

Navigation is rarely "open the other app", it is "open this task's board". Both sides carry a
`next`:

- To LogPup, from a task row: `next=/apps/<slug>`, which is what the payload's `url` field is for.
- To Attendance, from LogPup: `next=/tasks`, or `/dashboard` from the sidebar.

One shared validation helper per side, with a unit test. Not two copies.

### `.env.example` additions

```bash
# Shared HS256 secret for the sign-in handoff, both directions. Distinct from
# ATTENDANCE_JWT_SECRET (Solar's) and from LOGPUP_API_KEY (the task API's).
LOGPUP_SSO_SECRET=
```

---

## Part three: notifications

| Event | Origin | Reaches |
|---|---|---|
| A task is assigned to somebody | LogPup | That person's bell here, and their phone |
| A task's status is changed here | This app | The assigner and other assignees, in LogPup |

The second direction needs **nothing in this repo**. LogPup's status writer raises its own
notification when the status changes, whatever changed it, so the write-back from Part one already
triggers it. That is specified on the LogPup side; there is no code here.

What this repo builds is the **receiving end of the first direction**: an inbound webhook that
turns a LogPup assignment into a bell row and an FCM push.

### Why an inbound webhook rather than the poll we already have

The tasks section polls every 60 seconds, so a newly assigned task *appears* on its own. That is
not a notification. A notification has to reach somebody whose phone is in their pocket and whose
browser tab is closed, and only a server-side FCM push does that. So LogPup calls us.

### 6. `src/app/api/logpup/events/route.ts` (new)

`POST`, unauthenticated by session and authenticated by signature.

- **Verify HMAC-SHA256 over the raw body** against `LOGPUP_WEBHOOK_SECRET`, compared with
  `timingSafeEqual` (`src/lib/timingSafe.ts`). Require `x-logpup-timestamp` within five minutes,
  and include it in the signed string, or a captured body is replayable forever.
- **Read the raw body before parsing.** `await req.text()`, verify, *then* `JSON.parse`. Calling
  `req.json()` first consumes the stream and leaves nothing to compute the signature over, and
  re-serialising the parsed object does not reproduce the original bytes — key order and whitespace
  differ, so the signature fails for reasons that look like a wrong secret.
- **Tenant gate.** `tenantForRequest(req).id !== 'altavision'` returns 403, exactly as the register
  route gates itself to `southernlanka`.
- **Rate-limit** with `checkRateLimit(db, 'logpup_events', clientIp(req), …)`.
- `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`.

Then, per event: resolve `recipientEmail` to a user, write the bell doc, push.

### 7. The write: copy the register route, including the part that looks redundant

`src/app/api/register/route.ts` has the pattern, and its comment records a bug already paid for:
the doc id must be **per recipient**, not per event. A single event-level id reused across
recipients means the service worker's click handler cannot match the push to the live Firestore
doc, and renders a second, un-deduped entry — the reported "2 notifications for the same
registration" bug.

```ts
const docId = `logpup_${eventId}_${safeEpf}`;
await db.collection('notifications').doc(docId).set({
  to_epf: epf, audience: null,
  type: 'logpup_task_assigned',
  actor_epf: null,                 // LogPup actors have no EPF, and inventing one is worse than null
  actor_name: event.actorName,
  meta: { logpup: '1', task_id: event.taskId, app_slug: event.appSlug },
  title: event.title, body: event.body, link: '/tasks',
  read: false, created_at: FieldValue.serverTimestamp(),
});
await sendServerPush([{ ref, data }], {
  type: 'logpup_task_assigned', title: event.title, body: event.body,
  link: '/tasks', tag: docId, originUrl: req.nextUrl.origin,
});
```

**`doc(docId).set()` is the idempotency.** LogPup sends a stable `eventId`, so a retried webhook
overwrites the same document instead of ringing the bell twice. Do not use `add()`.

**`actor_epf: null` is deliberate.** The person who assigned the task may have no Attendance
account at all. `actor_name` carries the display name for the bell; nothing tries to resolve a
foreign actor to a local employee.

### 8. `src/services/notificationService.ts` and `src/lib/notificationTypes.ts`

Add `logpup_task_assigned` to `AppNotifType`, with a comment in the style of its neighbours saying
where it comes from.

**Then add it to `PUSHABLE_NOTIF_TYPES` in the same change** — that file's compile-time guard makes
it mandatory, and its header explains why the guard exists: the push allowlist had silently drifted
16 types behind, so assigned tasks and OT requests were written to the bell and never reached
anyone's phone, while the route still returned `{ success: true, sent: 0 }`. Nothing looked broken.

Use a distinct type rather than reusing `task_assigned`. The existing one means an `assigned_tasks`
document that lives in Firestore, and its meta carries an id that resolves there. A LogPup task has
no such document, so anything that opens a task detail from the bell would look up an id that does
not exist.

`renderNotif` in `NotificationCenter.tsx` re-derives title and body from `type` for leave, edit and
greeting types, and falls through to the stored values for everything else. A new type lands in
that default branch, so the stored title and body are what show — which is what we want, since
LogPup wrote the wording. Add a `typeIcon` case so it does not render as a generic bell.

### 9. Do not write these through `createAppNotification`

That function is client-side: it uses the Firebase client SDK and reads `auth.currentUser` to fire
its push. A webhook has no signed-in user. Use the Admin SDK write plus `sendServerPush` shown
above, which is exactly why `serverPush.ts` was extracted — its header says it exists for server
routes that have their own resolved recipient list and no caller ID token, naming self-registration
as the case. This is the same case.

### 10. `firestore.rules`

No change needed, and check rather than assume. The webhook writes with the Admin SDK, which
bypasses rules. The read path is the user reading their own `notifications` documents, which
already works. If a rule enumerates allowed `type` values, add the new one; if it does not, touch
nothing.

### What a dropped webhook costs

One missed interruption. The task itself still appears, because the section polls for it. LogPup's
side deliberately ships no outbox or retry queue in v1, for reasons argued there. The consequence
here is that this endpoint must be **fast and must not fail on partial input**: process each event
independently, and return `200` with a per-event result rather than a `500` that makes LogPup
consider the whole batch lost.

### Env additions

```bash
# HMAC-SHA256 secret LogPup signs task events with. A third distinct secret: not LOGPUP_API_KEY
# (task API), not LOGPUP_SSO_SECRET (sign-in handoff).
LOGPUP_WEBHOOK_SECRET=
```

---

## Explicitly not in scope

- **Creating a LogPup task from here.** A task belongs to an app and a sprint, and someone who
  cannot see the board cannot pick either.
- **Reassigning, rescheduling or deleting.** LogPup decisions, made with the board in view.
- **Storing anything in Firestore.** No `assigned_tasks` rows, no cache collection, no tombstones.
  The rejected mirror design and its four failure modes are argued out in the LogPup-side
  document; the short version is that two copies of one work item means two statuses and nothing
  saying which is right.
- **Notifications beyond assignment.** Part three carries exactly one event into this app: a task
  being assigned. A status change made *in LogPup* deliberately does not ring the bell here — every
  recipient is already a LogPup user who just got a LogPup notification, and telling the same
  person the same thing twice on two devices is how people turn both off. The webhook channel
  would carry it if that judgement ever changes.
- **Showing LogPup tasks in reports, payroll or the monthly summary.** Those figures are built
  from attendance sessions and hours. LogPup carries no hours, and a task count silently entering
  a payroll-adjacent report is the kind of number nobody can later explain.

---

## Contract summary (must match the LogPup doc word for word)

**Status mapping:**

| LogPup `task_status` | Attendance `TaskStatus` |
|---|---|
| `todo` | `Pending` |
| `in_progress` | `On Progress` |
| `done` | `Completed` |

**Endpoints we call, on the LogPup side:**

- `GET /api/external/tasks?email=&status=open|all&limit=` — the person's own tasks. An unknown or
  out-of-domain email returns `200` with `matched: false` and an empty list, never a 404.
- `PATCH /api/external/tasks/{id}/status` with `{ email, status, note? }`.

**Auth:** `x-api-key`, server-to-server only. The key identifies the application, not a user, so
every call carries the acting person's email and LogPup re-derives permission from it.

**Permission:** only an assignee may change a task's status, and only their own. LogPup's own
admin override deliberately does not extend across this API.

**Polling:** 60 seconds while the page is open, plus on focus.

---

## Built in this repo

| File | What it is |
|---|---|
| [src/lib/tenants.ts](src/lib/tenants.ts) | `logpupTasks` feature flag, in all four required places |
| [src/lib/logpupStatus.ts](src/lib/logpupStatus.ts) | Status vocabulary boundary, pure, tested |
| [src/lib/__tests__/logpupStatus.test.ts](src/lib/__tests__/logpupStatus.test.ts) | 7 tests, including the custom-status throw |
| [src/lib/logpupApi.ts](src/lib/logpupApi.ts) | Server-only LogPup client; never import from a client component |
| [src/lib/logpupIdentity.ts](src/lib/logpupIdentity.ts) | Verifies the ID token and derives the email. The one place that rule lives |
| [src/app/api/logpup/tasks/route.ts](src/app/api/logpup/tasks/route.ts) | Read proxy. Degrades to an empty list |
| [src/app/api/logpup/tasks/[id]/status/route.ts](src/app/api/logpup/tasks/%5Bid%5D/status/route.ts) | Write proxy. Surfaces failures, forwards LogPup's sentence |
| [src/components/useLogPupTasks.ts](src/components/useLogPupTasks.ts) | 60s poll, inert on other tenants |
| [src/components/tasks/LogPupTaskList.tsx](src/components/tasks/LogPupTaskList.tsx) | The section on /tasks |
| [src/app/(pages)/tasks/page.tsx](src/app/(pages)/tasks/page.tsx) | One import, one line, in `mine` mode only |
| [src/app/api/logpup-sso/route.ts](src/app/api/logpup-sso/route.ts) | Mints the outbound handoff token |
| [src/app/api/auth/logpup-sso/route.ts](src/app/api/auth/logpup-sso/route.ts) | Redeems an inbound one for a Firebase session |
| [src/app/sso/logpup/page.tsx](src/app/sso/logpup/page.tsx) | Receiver page, outside the gated route group |
| [src/components/LogPupAppButton.tsx](src/components/LogPupAppButton.tsx) | Sidebar cross-link |
| [src/app/api/logpup/events/route.ts](src/app/api/logpup/events/route.ts) | Signed inbound webhook → bell + FCM push |
| [src/services/notificationService.ts](src/services/notificationService.ts) | `logpup_task_assigned` type |
| [src/lib/notificationTypes.ts](src/lib/notificationTypes.ts) | Same type in the push allowlist |
| [src/store/appStore.ts](src/store/appStore.ts) | 23 strings × en/si/ta |
| [firestore.rules](firestore.rules) | Explicit deny on `logpup_sso_redemptions` |
| [.env.example](.env.example) | Four vars, three of them distinct secrets |

Two of these exist because `CLAUDE.md` requires them, and both are easy to skip:

- **i18n in all three languages.** Every user-facing string goes through `useT()`. The three
  `TRANSLATIONS` blocks must hold the same keys in the same order or `TKey` breaks the build,
  which is what makes a clean type-check evidence of parity rather than a claim about it. Status
  words on the row buttons stay untranslated, matching the existing task dialog next to them.
- **A rules block for the new collection.** `logpup_sso_redemptions` is Admin-SDK only, so
  default-deny already refuses the browser. The block is written out anyway, the way the two
  passkey collections are, so the posture reads as a decision rather than an omission somebody
  might later "fix". Note that `firebase.json` deploys these rules to `(default)` and `test`
  only — which is right here, since Alta Vision *is* `(default)` and no other tenant gets the
  feature.

One existing comment was corrected rather than left to go stale: the passkey verify route
described itself as the only caller of `createCustomToken`, which stopped being true when
`/api/auth/logpup-sso` landed.

### Deliberately deferred

- **No sweep for `logpup_sso_redemptions` yet.** Each document carries `expires_at`, so the
  data to prune it is there, but nothing prunes it. One collection growing by one small
  document per cross-app sign-in is not urgent; add the delete as a step in the existing
  `cron/maintenance-lifecycle` job rather than as a new cron.
- **No automated test of the webhook or the proxies.** This repo's test runner covers pure
  modules only (`node --test` over compiled `src/lib`), and every one of these needs Firebase
  Admin and a live LogPup. The HMAC scheme was verified separately against the nine cases listed
  under Verification; the rest is the by-hand list there.

## What LogPup must implement

The exact contract, so the other side is not guessing.

**Task API.** `GET /api/external/tasks?email=&status=open|all&limit=` and
`PATCH /api/external/tasks/{id}/status` with `{ email, status, note? }`, both authenticated by
`x-api-key`. Response shapes are in the Contract section above.

**Sign-in receiver.** A page at `/sso/attendance` reading `?token=` and `?next=`. The token is
HS256, three-minute expiry, claims `{ sub: email, email, name, jti }`, signed with
`LOGPUP_SSO_SECRET`. Verify with the algorithm pinned, refuse a repeated `jti`, and never
auto-provision. **BUILT on 2026-09-16**, along with the `sso_redemptions` migration it was
blocked on. Two things it does that this side should know about:

- It verifies the JWT by hand with `node:crypto` rather than with `jose` — a standing decision in
  that repo, not a limitation. The wire format is unchanged and this side's `SignJWT` call needs
  no edit; LogPup's tests mint with `jose` specifically to prove that.
- It refuses a `next` beginning `/\` as well as one beginning `//`. Browsers normalise `\` to `/`
  in URLs, so `/\evil.example` becomes protocol-relative *after* a `//` check has passed it.
  **`safeNext` in `src/app/api/logpup-sso/route.ts` does not have this rule yet** — worth adding
  when that file is next touched, since the minter is the end that builds the link.

**Sign-in minter.** A session-authenticated endpoint that signs the same claim shape for the
session's own user, so the button here has something to redeem. This app redeems at
`POST /api/auth/logpup-sso` and expects `{ token }`. **BUILT on 2026-09-16** as
`POST /api/sso/attendance-handoff`: it returns `{ success, url }` where `url` points at
`/sso/logpup` on this app, reads the email from LogPup's own session (never from the body), and
signs with `node:crypto` rather than `jose` — the wire format is unchanged and `jwtVerify` in
`src/app/api/auth/logpup-sso/route.ts` needs no edit. LogPup's tests verify its minted tokens
with the real `jose` for exactly that reason. LogPup reads `ATTENDANCE_APP_URL` (optional,
defaults to `https://attendance.altavision.lk`) to build the link.

**Webhook sender.** `POST` to `ATTENDANCE_WEBHOOK_URL` with:

```
x-logpup-timestamp: <epoch milliseconds>
x-logpup-signature: hex(HMAC-SHA256(LOGPUP_WEBHOOK_SECRET, "<timestamp>.<raw body>"))
```

Three things this receiver enforces that are easy to get wrong when writing the sender:

- **The timestamp is inside the signed string**, so it cannot be edited to extend the window of
  a captured request. It must also be within five minutes of now.
- **The signature covers the exact bytes sent.** Signing a re-serialised copy of the payload
  fails, because key order and whitespace differ. Sign the same string you put on the wire.
- **The signature is lowercase hex**, not base64.

Body: `{ "events": [ { eventId, kind: "task.assigned", recipientEmail, actorName, title, body,
taskId, appSlug } ] }`, at most 50 events. `eventId` must be stable per recipient per
notification, because it becomes the Firestore document id and is what makes a retry idempotent.

Each event is answered independently in `results[]`, so a batch containing one unknown recipient
still delivers the rest. A `200` with `delivered: false` is a real answer, not a failure to retry.

## Verification

Following `CLAUDE.md`'s ladder, and its rule that "it compiles" is not verification.

**Done, and passing:**

1. `npm test` — exit 0, 579 tests pass, including 7 new ones for `logpupStatus` (the
   custom-status throw and the unknown-status null are the two that matter).
2. `npx tsc --noEmit` — exit 0. This is also the i18n parity check: `TKey` breaks the build if
   the three translation blocks drift.
3. `npx next build --webpack` — exit 0, no `Failed to type check` and no
   `build worker exited with code: 1`. All five API routes and the receiver page register. The
   one warning is pre-existing, from `face-api.js` on the login page. Checked without piping to
   a pager, because a pipeline reports the pager's exit status and a failed build would read 0.
4. The webhook HMAC scheme, checked against nine cases: a valid signature is accepted; a wrong
   secret, an altered body, a stale timestamp, an edited timestamp, a missing signature, an
   unset secret and a garbage signature are all refused; and a re-serialised copy of the body
   does **not** verify, which is the property that forces the route to read raw bytes.
5. By inspection: no route reads an email from a request body. Every one derives it from a
   verified ID token through `resolveLogPupCaller`.

**Still to do, and it needs LogPup running — none of this can be faked:**
1. **Tenant isolation, checked by hand and not assumed.** Load the app on a `carecode.org` host
   with the flag off and confirm in the network tab that **no request to `/api/logpup/*` is made
   at all**. A hidden section that still polls has failed the actual requirement.
2. **The body-email attack, tried deliberately.** Call `/api/logpup/tasks` with a valid ID token
   for user A and user B's email in the body. It must return A's tasks. If it returns B's, stop
   and fix the route before anything else.
3. **LogPup unreachable.** Point `LOGPUP_APP_URL` at a dead host. The tasks page must render
   normally with an empty LogPup section and a quiet notice, with no error boundary and no
   console spew.
4. End to end: change a status here, then confirm the LogPup activity feed shows it under the
   right person's name. That is the proof identity resolution works, and it is the last step.

For Part two, four more, and the first two are the ones that must not be skipped:

5. **Replay a link.** Open the same SSO URL twice. The second must fail. If it succeeds, the
   `jti` guard is not working and a token captured from browser history is a session.
6. **Forge an identity.** Sign a valid token for an email that exists in LogPup but not here, and
   one for an address at another domain. Both must refuse, and neither may create a user.
7. **Signed out.** Open the receiver page in a private window with no session. It must redeem the
   token, not bounce to the login page — this fails only in the case nobody tests by hand.
8. **Both directions on a phone.** The touch path is a top-level navigation specifically so an
    installed PWA captures the link, and it is not exercised by any desktop test.

For Part three:

9. **Replay the webhook.** POST the identical signed body twice. The second must overwrite the
    same document, not create a second bell row. Then POST it with a timestamp six minutes old —
    that must be refused.
10. **Forge it.** POST with a wrong signature, and again with a correct signature but a body
    altered by one character. Both must be refused.
11. **Reach a real phone.** Assign a task in LogPup to someone with the app installed and closed.
    A bell row alone is not a pass. A row with `sent: 0` is the exact failure the
    `PUSHABLE_NOTIF_TYPES` guard exists to prevent, and it looks like success in every log.
12. **Round-trip the other direction.** Change a status here and confirm the assigner's LogPup
    bell shows it. Then change it twice more in a minute and confirm the three collapse into one
    unread row rather than three.
