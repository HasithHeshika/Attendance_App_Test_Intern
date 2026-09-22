# Working-Status API

Real-time feed of **who is working right now**, with each employee's session
start/end times for **today + the last 3 working days**. Designed for
server-to-server consumption by the **planning app**.

- **Owner:** PearlCluster Attendance Web App
- **Endpoint:** `GET /api/working-status`
- **Version:** 1.0
- **Auth:** shared secret (API key)
- **Format:** JSON (polling) or Server-Sent Events (push)

---

## 1. Base URL

```
https://<attendance-app-host>/api/working-status
```

Replace `<attendance-app-host>` with the deployed host (e.g. `https://attendance.example.com`).

---

## 2. Authentication

Every request must include the shared secret (env var `WORKFORCE_API_KEY` on the
attendance server). Send it **one** of these ways:

| Method | Example |
|---|---|
| `Authorization` header *(preferred)* | `Authorization: Bearer <KEY>` |
| `x-api-key` header | `x-api-key: <KEY>` |
| `key` query param *(required for SSE)* | `...?key=<KEY>` |

> The query-param form exists because the browser `EventSource` API cannot set
> custom headers. If you call the stream from a backend, prefer the header.

**Failure responses**

| Status | Meaning |
|---|---|
| `401 Unauthorized` | Missing or wrong key. |
| `503 Service Unavailable` | `WORKFORCE_API_KEY` is not configured on the server (fails closed — the feed contains staff PII). |

---

## 3. Modes

| Request | Description |
|---|---|
| `GET /api/working-status` | Returns **one JSON snapshot**. Poll this. |
| `GET /api/working-status?stream=1` | **Server-Sent Events.** Emits an `event: snapshot` frame on connect and again whenever attendance changes. |
| `GET /api/working-status?only=epf` | Lightweight — returns just the list of EPF numbers (no attendance scan). |

### Query parameters

| Param | Type | Default | Description |
|---|---|---|---|
| `epf` | csv string | — | Restrict to specific EPF numbers, e.g. `?epf=001,002,EMPAV/009`. |
| `active` | `true` | all | `?active=true` returns only currently-active employees. Omit to include everyone. |
| `days` | int (0–14) | `3` | Number of **prior working days** to include alongside today. |
| `stream` | `1` | — | Switch to SSE mode. |
| `only` | `epf` | — | Return only the EPF list. |
| `key` | string | — | API key (alternative to a header). |

---

## 4. Response schema (snapshot)

`Content-Type: application/json`

```jsonc
{
  "generated_at": "2026-06-28T03:10:00.000Z", // ISO-8601 UTC — when this snapshot was built
  "timezone": "Asia/Colombo",                 // tz the calendar "date" fields are in
  "today": "2026-06-28",                       // server's current SL date
  "count": 42,                                 // number of users in `users`
  "working_count": 11,                         // how many are working right now
  "epf_numbers": ["001", "002", "EMPAV/009"],  // every EPF in this response
  "users": [ /* UserStatus[] — see below */ ]
}
```

### `UserStatus`

| Field | Type | Description |
|---|---|---|
| `epf_number` | string | Unique employee id. May contain `/` (e.g. `EMPAV/009`). |
| `name` | string | Display name. |
| `email` | string | Login email. |
| `phone` | string | Best available number (personal → office → emergency). |
| `phone_personal` | string | Personal number (may be empty). |
| `phone_office` | string | Office number (may be empty). |
| `is_active` | boolean | Whether the employee is active. |
| `is_shift_worker` | boolean | Overnight-shift worker (sessions may span midnight). |
| `is_working` | boolean | **Working right now** — has an open session (checked in, not out). |
| `current_session` | object \| null | The open session, or `null` if not working. |
| `days` | `DayStatus[]` | Today first, then the last *N* working days. |

### `current_session`

```jsonc
{
  "date": "2026-06-28",                        // session's start day (could be yesterday for overnight)
  "check_in": "2026-06-28T02:40:00.000Z",      // ISO-8601 UTC
  "working_place": "Colombo",                  // may be null
  "site_number": null
}
```

### `DayStatus`

```jsonc
{
  "date": "2026-06-28",     // YYYY-MM-DD (Asia/Colombo calendar day)
  "is_today": true,
  "sessions": [ /* Session[] */ ]
}
```

### `Session`

| Field | Type | Description |
|---|---|---|
| `id` | string | Session id (unique within the day). |
| `check_in` | string \| null | **Start time**, ISO-8601 UTC. |
| `check_out` | string \| null | **End time**, ISO-8601 UTC. `null` while the session is still open. |
| `working_place` | string \| null | e.g. `"Colombo"`, `"Work From Home"`, `"Site"`. |
| `site_number` | string \| null | Set when the working place requires a site number. |
| `is_outstation` | boolean | Outstation work. |
| `outstation_name` | string \| null | Outstation location name. |
| `is_open` | boolean | `true` = checked in, not yet checked out. |

### Full example

```jsonc
{
  "generated_at": "2026-06-28T03:10:00.000Z",
  "timezone": "Asia/Colombo",
  "today": "2026-06-28",
  "count": 42,
  "working_count": 11,
  "epf_numbers": ["001", "002"],
  "users": [
    {
      "epf_number": "001",
      "name": "John Doe",
      "email": "john@example.com",
      "phone": "+9477...",
      "phone_personal": "+9477...",
      "phone_office": "",
      "is_active": true,
      "is_shift_worker": false,
      "is_working": true,
      "current_session": {
        "date": "2026-06-28",
        "check_in": "2026-06-28T02:40:00.000Z",
        "working_place": "Colombo",
        "site_number": null
      },
      "days": [
        {
          "date": "2026-06-28",
          "is_today": true,
          "sessions": [
            {
              "id": "s_1719543600_ab12",
              "check_in": "2026-06-28T02:40:00.000Z",
              "check_out": null,
              "working_place": "Colombo",
              "site_number": null,
              "is_outstation": false,
              "outstation_name": null,
              "is_open": true
            }
          ]
        },
        {
          "date": "2026-06-27",
          "is_today": false,
          "sessions": [
            {
              "id": "s_1719457200_cd34",
              "check_in": "2026-06-27T02:35:00.000Z",
              "check_out": "2026-06-27T12:10:00.000Z",
              "working_place": "Colombo",
              "site_number": null,
              "is_outstation": false,
              "outstation_name": null,
              "is_open": false
            }
          ]
        }
        // … up to `days` (default 3) prior working days
      ]
    }
  ]
}
```

### `only=epf` response

```jsonc
{
  "generated_at": "2026-06-28T03:10:00.000Z",
  "count": 42,
  "epf_numbers": ["001", "002", "EMPAV/009"]
}
```

---

## 5. Semantics & conventions

- **Times** are always **ISO-8601 UTC**. Convert to `Asia/Colombo` (UTC+5:30) for display.
- **Calendar dates** (`date`, `today`) are **Asia/Colombo** days.
- **"Working right now"** (`is_working`) = there is a session today with a
  `check_in` and no `check_out`. For `is_shift_worker` employees, an open session
  that started **yesterday** also counts (overnight).
- **"Working days"** = days that actually have an attendance record. Weekends,
  holidays and leave days have no record and are therefore skipped — so the 3
  prior days returned are the 3 most recent days the person actually worked
  (looking back up to ~3 weeks).
- A day can contain **multiple sessions** (e.g. split shifts). They are returned
  in stored order.
- `current_session` is a convenience mirror of the open session in `days`.

---

## 6. Consuming the API

### A. Polling (recommended, works everywhere)

Poll every 15–30 seconds.

```bash
curl -s "https://attendance.example.com/api/working-status?active=true" \
  -H "Authorization: Bearer $WORKFORCE_API_KEY"
```

```js
// Node / backend
const res = await fetch(
  "https://attendance.example.com/api/working-status?active=true",
  { headers: { Authorization: `Bearer ${process.env.WORKFORCE_API_KEY}` } }
);
const snapshot = await res.json();
for (const u of snapshot.users) {
  if (u.is_working) console.log(`${u.name} is working since ${u.current_session.check_in}`);
}
```

### B. Real-time stream (Server-Sent Events)

```js
// Browser
const es = new EventSource(
  "https://attendance.example.com/api/working-status?stream=1&key=YOUR_KEY"
);
es.addEventListener("snapshot", (e) => {
  const data = JSON.parse(e.data);
  // data.users[].is_working, data.users[].days[].sessions[...]
});
es.addEventListener("error", (e) => {
  // EventSource auto-reconnects; log/observe here
});
```

```bash
# Quick test from the shell
curl -N "https://attendance.example.com/api/working-status?stream=1&key=$WORKFORCE_API_KEY"
```

**Stream frames**

```
event: snapshot
data: { ...full snapshot JSON... }

: ping        ← heartbeat comment every ~25s (ignore)
```

> **Hosting note:** SSE needs a long-running Node host (`next start` / a
> persistent container). On short-lived serverless invocations the connection is
> capped — **poll the JSON endpoint instead** there. The JSON snapshot and the
> SSE `snapshot` frame share the exact same shape, so you can switch freely.

---

## 7. Error handling

| Status | Body | Action |
|---|---|---|
| `200` | snapshot JSON | OK. |
| `401` | `{ "error": "Unauthorized" }` | Check the key/header. |
| `503` | `{ "error": "API not configured: ..." }` | Ask the attendance team to set `WORKFORCE_API_KEY`. |
| `500` | `{ "error": "Internal error" }` | Transient — retry with backoff. |

For SSE, a failure during init emits `event: error` with `{ "error": "init failed" }`;
the client should rely on `EventSource`'s automatic reconnect.

---

## 8. Operational notes

- The feed contains **personal data** (email, phone). Keep the API key secret,
  call over HTTPS, and restrict who can read the planning app's copy.
- Responses are **never cached** (`Cache-Control: no-store`).
- One snapshot is built from a single range query, so polling is cheap; still,
  don't poll faster than ~once every 10s — use SSE if you need sub-second freshness.
- EPF numbers can contain `/`. URL-encode them in the `epf` filter if needed
  (`EMPAV/009` → `EMPAV%2F009`), though the raw form also works.

---

## 9. Changelog

| Version | Date | Notes |
|---|---|---|
| 1.0 | 2026-06-28 | Initial release: JSON snapshot, SSE stream, `only=epf`, filters (`epf`, `active`, `days`). |
