# Working-status feed (`/api/working-status`)

Server-to-server feed for the **planning app**: who is working right now, plus each
person's session start/end times for today and the last 3 working days.

## Auth

Set `WORKFORCE_API_KEY` on the server (see `.env.example`). The caller must send the
key one of three ways:

- `Authorization: Bearer <key>` (preferred)
- `x-api-key: <key>`
- `?key=<key>` in the URL (needed for the SSE stream — `EventSource` can't set headers)

If the env var is unset the endpoint returns `503` (fail closed — it exposes staff PII).

## Modes

| Request | Returns |
| --- | --- |
| `GET /api/working-status` | One JSON snapshot. **Poll** this (e.g. every 15–30 s). |
| `GET /api/working-status?stream=1&key=...` | **Server-Sent Events**. Pushes a fresh snapshot (`event: snapshot`) whenever attendance changes. |
| `GET /api/working-status?only=epf` | Just `{ epf_numbers: [...] }` (cheap). |

### Query params

- `epf=001,002` — restrict to specific EPF numbers.
- `active=true` — only currently-active employees (default: everyone).
- `days=3` — number of prior working days to include (default 3, max 14).

## Snapshot shape

```jsonc
{
  "generated_at": "2026-06-28T03:10:00.000Z",
  "timezone": "Asia/Colombo",
  "today": "2026-06-28",
  "count": 42,
  "working_count": 11,
  "epf_numbers": ["001", "002", "..."],
  "users": [
    {
      "epf_number": "001",
      "name": "John Doe",
      "email": "john@example.com",
      "phone": "+9477...",            // best of personal/office/emergency
      "phone_personal": "+9477...",
      "phone_office": "...",
      "is_active": true,
      "is_shift_worker": false,
      "is_working": true,             // has an open session right now
      "current_session": {
        "date": "2026-06-28",
        "check_in": "2026-06-28T02:40:00.000Z",
        "working_place": "Colombo",
        "site_number": null
      },
      "days": [                       // today first, then last 3 working days
        {
          "date": "2026-06-28",
          "is_today": true,
          "sessions": [
            {
              "id": "s_...",
              "check_in": "2026-06-28T02:40:00.000Z",  // start (ISO UTC)
              "check_out": null,                        // end, null while open
              "working_place": "Colombo",
              "site_number": null,
              "is_outstation": false,
              "outstation_name": null,
              "is_open": true
            }
          ]
        }
      ]
    }
  ]
}
```

All times are ISO-8601 **UTC**; convert to `Asia/Colombo` on display. "Working days"
are days that actually have attendance records (so weekends/holidays/leave are skipped).
Overnight (`is_shift_worker`) sessions that started the previous day still count as
"working" until they're checked out.

## Consuming the stream

```js
const es = new EventSource('https://app.example.com/api/working-status?stream=1&key=SECRET');
es.addEventListener('snapshot', (e) => {
  const data = JSON.parse(e.data);
  // data.users[].is_working, data.users[].days[].sessions[...]
});
```

> SSE needs a long-running Node host (`next start` / a persistent container). On
> short-lived serverless invocations the connection is capped — **poll the JSON
> endpoint instead** there.
