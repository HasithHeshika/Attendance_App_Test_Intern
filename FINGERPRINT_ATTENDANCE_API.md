# Fingerprint Attendance API

Backend API for the HF-X05 fingerprint terminal (Android). Adapts
`FINGERPRINT_APP_FIREBASE_BE_FUNCTION_CONTRACT_V1.md` to this app's actual stack:
**Next.js API routes** (not Firebase Callable Functions), backed by the same Firestore
database as the web app, multi-tenant (`altavision.lk` / `carecode.org`).

- **Owner:** PearlCluster Attendance Web App
- **Base URL:** `https://<tenant-host>/api/fingerprint/...` (e.g. `https://carecode.org/api/fingerprint/sync-users`)
- **Version:** 1.0
- **Auth:** shared secret (`FINGERPRINT_API_KEY`) + a registered, active `deviceId`
- **Format:** JSON

---

## 1. Why this differs from the original proposal

| Contract concept | This app |
|---|---|
| Firebase Callable Functions, Android calls Firebase SDK directly | Plain HTTPS JSON endpoints under `/api/fingerprint/*`, called like any REST API |
| Opaque Firestore auto-id `userId` | No such thing exists here — **`userId` = `epf_number`**, the same id used everywhere (attendances, tasks, leaves). It is also the `users/{doc id}` |
| `employeeId` | Maps to `employee_number` when the employee has one, otherwise falls back to `epf_number` |
| Standalone `attendanceEvents` ledger, no session semantics | A scan writes directly into the **same** `attendances/{epf}_{date}.sessions[]` array the mobile check-in/out flow uses — first scan of the day opens a session, the next scan closes it. Shows up immediately in every existing report/export. A `fingerprint_attendance_events/{attendanceEventId}` ledger still exists, but only as the idempotency lock — not a reporting surface |
| Firebase Auth device identity | A shared secret (`FINGERPRINT_API_KEY`) + a per-device Firestore doc (`attendance_devices/{deviceId}`) that must be `active: true` |
| Template backup mode | **Not implemented.** Only enrollment/template *metadata* is stored — sending `templateDataBase64` is rejected outright. `getFingerprintEnrollment` is available but never returns template bytes |

Sessions written by a terminal scan are **auto-approved** (`check_in_status` /
`check_out_status = 'approved'`, `*_approved_by = 'FINGERPRINT'` or `'FACE'` depending on
`biometricType` — a recognizable sentinel, not a real epf) since a biometric match already
proves identity + physical presence. No supervisor approval step is inserted.

Morning/evening food-allowance flags are computed the same way the Approvals page does
(before 06:45 → cat 1, 06:45–07:00 → cat 2 on check-in; after 19:00 → cat 1 on check-out),
using Asia/Colombo local time regardless of what timezone the server itself runs in.

Overnight/shift workers: if a user has `is_shift_worker: true` and has no open session
today, a check-out scan also checks **yesterday's** attendance doc for an open session
before falling back to opening a new one — same convention the working-status feed uses.

---

## 2. Authentication

Every request below must include the shared secret, one of:

| Method | Example |
|---|---|
| `Authorization` header *(preferred)* | `Authorization: Bearer <FINGERPRINT_API_KEY>` |
| `x-api-key` header | `x-api-key: <FINGERPRINT_API_KEY>` |

**Additionally**, every request body must include a `deviceId` that names an existing,
`active: true` doc in `attendance_devices/{deviceId}`. A terminal is provisioned once via
the admin endpoint (§7) — there is no self-registration.

| Status | Meaning |
|---|---|
| `401` | Missing/wrong shared secret |
| `404` | `FPA-001 DEVICE_NOT_FOUND` — unknown `deviceId` |
| `403` | `FPA-002 DEVICE_DISABLED` — device exists but `active: false` |
| `503` | `FINGERPRINT_API_KEY` not configured on the server |

---

## 3. `POST /api/fingerprint/sync-users`

Full or incremental user sync.

**Request**
```json
{ "deviceId": "HF-X05-001", "updatedAfter": "2026-08-16T04:00:00.000Z" }
```
`updatedAfter` omitted/null → full sync. Deactivated users ARE included (so the terminal can
disable them locally) — nothing is ever filtered out by `active`.

**Response**
```json
{
  "users": [
    {
      "userId": "EMP001",
      "employeeId": "EMP001",
      "displayName": "John Silva",
      "active": true,
      "fingerprintEnrolled": true,
      "fingerprintEnrollmentId": "9ad5c6e2-2721-44ec-a303-c840e8632078",
      "updatedAt": "2026-08-16T04:05:12.000Z"
    }
  ],
  "serverTime": "2026-08-16T04:10:00.000Z",
  "nextUpdatedAfter": "2026-08-16T04:10:00.000Z"
}
```
Persist `nextUpdatedAfter` and pass it back as `updatedAfter` next time.

---

## 4. `POST /api/fingerprint/enrollments`

Save a completed 5-scan enrollment (metadata + template slot records only — no image/template
bytes are ever accepted).

**Request** — identical shape to the original contract §4, e.g.:
```json
{
  "enrollmentId": "9ad5c6e2-2721-44ec-a303-c840e8632078",
  "deviceId": "HF-X05-001",
  "userId": "EMP001",
  "employeeId": "EMP001",
  "fingerPosition": "RIGHT_INDEX",
  "matcherEngine": "sourceafis",
  "matcherImplementationVersion": "3.18.1",
  "templateFormat": "sourceafis-cbor",
  "templateFormatVersion": 1,
  "enrolledAtDevice": "2026-08-16T09:30:00+05:30",
  "templates": [
    { "templateRecordId": "uuid-1", "templateSlot": 1 },
    { "templateRecordId": "uuid-2", "templateSlot": 2 },
    { "templateRecordId": "uuid-3", "templateSlot": 3 },
    { "templateRecordId": "uuid-4", "templateSlot": 4 },
    { "templateRecordId": "uuid-5", "templateSlot": 5 }
  ]
}
```
Do **not** include `templateDataBase64` — it is rejected (`FPA-103`).

**Response**
```json
{
  "success": true, "enrollmentId": "9ad5c6e2-...", "userId": "EMP001",
  "status": "RECORDED", "templateCount": 5, "serverTimestamp": "2026-08-16T04:10:00.000Z"
}
```
Retrying the same `enrollmentId` with identical data returns `status: "ALREADY_RECORDED"`.
Retrying with different data (different user/device/finger) is rejected as `FPA-102`.

On success, `users/{userId}.fingerprint_enrolled`, `.fingerprint_enrollment_id`, and
`.fingerprint_updated_at` are set.

`GET /api/fingerprint/enrollments?deviceId=...&userId=...` (or `&enrollmentId=...`) returns
the same metadata (`{ "enrollment": {...} | null }`), still no template bytes.

### Face-template backup extension

The same endpoint also supports portable SFace backup. Existing fingerprint clients may omit
`biometricType`; omission continues to mean `FINGERPRINT` and preserves the metadata-only
five-slot contract above. `FACE` does **not** accept images, thumbnails, or Android-Keystore
ciphertext — its three `templateDataBase64` values are portable SFace feature bytes.

```json
{
  "enrollmentId": "a4feec95-1b3d-49ba-983e-5d3b30edb0f5",
  "deviceId": "HF-X05-DEV-001",
  "userId": "SLH/E338",
  "employeeId": "SLH/E338",
  "biometricType": "FACE",
  "engineId": "<Android engine id>",
  "modelId": "face_recognition_sface",
  "modelVersion": "2021dec",
  "templateFormat": "sface-f32le-v1",
  "enrolledAtDevice": "2026-09-04T09:30:00+05:30",
  "templates": [
    { "templateSlot": 1, "templateDataBase64": "<straight SFace feature Base64>" },
    { "templateSlot": 2, "templateDataBase64": "<left SFace feature Base64>" },
    { "templateSlot": 3, "templateDataBase64": "<right SFace feature Base64>" }
  ]
}
```

`engineId`, `modelId`, `modelVersion`, `templateFormat`, and exactly slots `1,2,3` are
required. `modelId`, `modelVersion`, and `templateFormat` must respectively be
`face_recognition_sface`, `2021dec`, and `sface-f32le-v1`. The record is deterministic per
employee/device, so a new face enrollment replaces its three slots. Retrying the same
`enrollmentId` returns `ALREADY_RECORDED`; it never appends another set of templates.

Use `GET /api/fingerprint/enrollments?deviceId=...&userId=...&biometricType=FACE` to restore
the face metadata and all three Base64 features. A successful face save sets only
`users/{userId}.face_enrolled`, `.face_enrollment_id`, and `.face_updated_at`; fingerprint
state is unchanged.

---

## 5. `POST /api/fingerprint/attendance`

One scan → one event.

**Request**
```json
{
  "attendanceEventId": "63f8446c-54be-42bc-a06d-cd851eb73f24",
  "deviceId": "HF-X05-001",
  "userId": "EMP001",
  "employeeId": "EMP001",
  "biometricType": "FACE",
  "deviceTimestamp": "2026-08-16T09:30:12+05:30",
  "clientSequence": 1842,
  "action": "CHECK_IN"
}
```

`biometricType` (**optional**): `"FINGERPRINT"` | `"FACE"` — which sensor made this scan, same
field name and values as the enrollment endpoint (§4). Omitted continues to mean `FINGERPRINT`,
so a fingerprint-only terminal build needs no change. Any other value is rejected
(`FPA-201 INVALID_ATTENDANCE_EVENT`). It decides `check_in_method` / `check_out_method`
(`"fingerprint"` | `"face"`) and the `check_in_approved_by` / `check_out_approved_by` sentinel
(`"FINGERPRINT"` | `"FACE"`) on the session this event writes to.

`action` (**optional**): `"CHECK_IN"` | `"CHECK_OUT"` — the employee's explicit choice at the
terminal. Send it when the terminal build has the two-button UI. When omitted, the backend
infers direction from session state (open session → check-out, none → check-in), exactly as
before. Any other string is rejected (`FPA-201 INVALID_ATTENDANCE_EVENT`).

**Server-side reconciliation** (`action` present):

| `action` | session state | outcome |
|---|---|---|
| `CHECK_IN` | no open session | opens a fresh session |
| `CHECK_IN` | an open session | **reconcile** — the open session is closed at *this punch's* timestamp (kept raw, never truncated to a scheduled time), both it and the new session get `review_status: "flagged"`, and an `attendance_reviews` row is raised. `attendanceAction` is `"CHECK_IN"`, `reviewStatus` is `"flagged"` |
| `CHECK_OUT` | an open session | closes it. If the session ran ≥ 20 h it is closed `pending` with `review_status: "flagged"` (not auto-approved) and `reviewStatus: "flagged"` is returned |
| `CHECK_OUT` | **no** open session | `REJECTED`, `message: "No open session found to check out."` — no phantom session is ever created. The event is logged but **not** locked in; retry the same `attendanceEventId` after a real check-in |

A second punch within 45 s of the previous one (any direction) is `DEBOUNCED`.

**Response**
```json
{
  "success": true,
  "attendanceEventId": "63f8446c-54be-42bc-a06d-cd851eb73f24",
  "status": "RECORDED",
  "attendanceRecordId": "EMP001_2026-08-16",
  "attendanceAction": "CHECK_IN",
  "reviewStatus": null,
  "serverTimestamp": "2026-08-16T04:10:00.000Z"
}
```
`status`: `RECORDED` | `ALREADY_RECORDED` | `REJECTED` | `DEBOUNCED`.
`reviewStatus`: `"flagged"` when the session this punch touched was parked for supervisor
review, else `null`.
A `REJECTED` event (bad/inactive user, mismatched employeeId, malformed timestamp, or a
`CHECK_OUT` with no open session) is **not** locked in — retry the same `attendanceEventId`
once the underlying problem is fixed and it can still succeed.

---

## 6. `POST /api/fingerprint/attendance/bulk`

Offline queue flush. Always responds `200` with one result per event — a bad event never
fails the batch. Events are processed in `deviceTimestamp` order (not array order or in
parallel) so one person's scans toggle check-in/check-out correctly. Each event may carry its
own optional `action` (same semantics as §5). An explicit `CHECK_OUT` replayed before its
`CHECK_IN` is `REJECTED` ("no open session"); a later replay of the `CHECK_IN` reconciles, and
the `REJECTED` id is not locked in.

**Request**
```json
{
  "deviceId": "HF-X05-001",
  "events": [
    { "attendanceEventId": "event-uuid-001", "userId": "EMP001", "employeeId": "EMP001", "source": "FINGERPRINT", "deviceTimestamp": "2026-08-16T08:02:13+05:30", "clientSequence": 1801, "action": "CHECK_IN" },
    { "attendanceEventId": "event-uuid-002", "userId": "EMP002", "employeeId": "EMP002", "source": "FINGERPRINT", "deviceTimestamp": "2026-08-16T08:04:51+05:30", "clientSequence": 1802, "action": "CHECK_IN" }
  ]
}
```

**Response**
```json
{
  "results": [
    { "attendanceEventId": "event-uuid-001", "status": "RECORDED", "attendanceRecordId": "EMP001_2026-08-16", "attendanceAction": "CHECK_IN", "reviewStatus": null },
    { "attendanceEventId": "event-uuid-002", "status": "RECORDED", "attendanceRecordId": "EMP002_2026-08-16", "attendanceAction": "CHECK_IN", "reviewStatus": null }
  ],
  "serverTimestamp": "2026-08-16T04:45:00.000Z"
}
```
Treat both `RECORDED` and `ALREADY_RECORDED` as successful sync outcomes, exactly as the
original contract specifies — drop those from the local retry queue.

---

## 7. Device provisioning (admin, web-app side — not called by the terminal)

There is no self-registration; a system admin / user-manager provisions each terminal from
the web app (or `curl`) before it can call anything above.

```
GET   /api/admin/fingerprint-devices             list terminals
POST  /api/admin/fingerprint-devices             { idToken, deviceId, name, workingPlace?, companyId?, companyName? }
PATCH /api/admin/fingerprint-devices/{deviceId}  { idToken, name?, active?, workingPlace?, companyId?, companyName? }
```
`idToken` is a Firebase Auth ID token for a user whose role has `is_system_admin` or
`can_manage_users`. `GET` takes the same token as `Authorization: Bearer <idToken>` instead
of a body. `workingPlace` is the fixed location recorded on every check-in/out this terminal
produces (terminals have no GPS, unlike the mobile app). There is no `DELETE` — disable a
compromised/decommissioned unit with `PATCH { active: false }`; its enrollment and attendance
history is kept.

---

## 8. Error codes

Same table as the original contract (§11), returned as `{ "code": "FPA-xxx", "message": "..." }`:

```
FPA-001  DEVICE_NOT_FOUND        FPA-101  INVALID_ENROLLMENT       FPA-301  INVALID_SYNC_REQUEST
FPA-002  DEVICE_DISABLED         FPA-102  ENROLLMENT_CONFLICT      FPA-401  UNAUTHENTICATED
FPA-003  USER_NOT_FOUND          FPA-103  INVALID_TEMPLATE_SET     FPA-999  INTERNAL_ERROR
FPA-004  USER_DISABLED           FPA-201  INVALID_ATTENDANCE_EVENT
FPA-005  EMPLOYEE_ID_MISMATCH    FPA-202  ATTENDANCE_REJECTED
```

---

## 9. Firestore collections (reference only — the terminal never touches these directly)

```
attendance_devices/{deviceId}
fingerprint_enrollments/{enrollmentId}
fingerprint_enrollments/{enrollmentId}/templates/{templateRecordId}
fingerprint_attendance_events/{attendanceEventId}     ← idempotency lock; also logs declared_action + REJECTED
    .epf_number / .employee_number                   ← resolved from the user record, not the caller's raw claim
fingerprint_last_punch/{epf_number}                  ← global duplicate-punch debounce (Admin-SDK only)
users/{epf_number}.fingerprint_enrolled / .fingerprint_enrollment_id / .fingerprint_updated_at
attendances/{epf_number}_{date}.sessions[]            ← where the actual attendance record lands
    .sessions[].check_in_source / .check_out_source  ← 'fingerprint_explicit' | 'inferred' | 'system_auto'
    .sessions[].review_status                        ← 'flagged' when parked for supervisor review
attendance_reviews/{epf}_{date}_{sessionId}          ← the review queue row (flagged → in_review → resolved)
attendance_segments/{epf}_{date}_{sessionId}_{n}     ← retro-recalc: derived scheduled vs. ot_unverified split
recalc_queue/{autoId}                                ← roster back-date → re-derive segments (drain: follow-up)
```
`attendance_devices` / `fingerprint_enrollments` / `fingerprint_attendance_events` /
`fingerprint_last_punch` are Admin-SDK-only, denied outright to browsers. `attendance_reviews`
and `recalc_queue` are readable + transitionable by the web app; `attendance_segments` is
read-only there.
