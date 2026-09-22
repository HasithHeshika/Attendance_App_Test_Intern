// Shift-based auto check-out — pure helpers shared by the fingerprint API
// (src/lib/fingerprintApi.ts), the mobile attendance flow (src/services/apiCompat.ts) and the
// auto-checkout cron (src/app/api/cron/auto-checkout/route.ts).
//
// NO firebase / SDK imports here — this file is compiled into the plain-node test build
// (tsconfig.test.json) and is imported from both admin-SDK and client-SDK code.
//
// Background: a Southern Lanka shift worker who stays on past their scheduled shift end without
// punching out leaves an open attendance session. The next punch (fingerprint or mobile) would
// otherwise be consumed as the check-out for that stale session — producing a ~24h session and
// no check-in for the new shift. These helpers decide when such a session is "abandoned past
// grace" and should be auto-closed, stamped at the scheduled shift end, so the current punch is
// free to open the new shift.

export const SCHEDULED_END_GRACE_MINUTES = 45;
export const DUP_PUNCH_DEBOUNCE_SECONDS = 45;

// A session that runs this long is implausible as a single continuous shift — a 24/36h
// emergency shift with a missing mid-punch, or a forgotten check-out. The hybrid model NEVER
// truncates it; it flags the session for supervisor review (see attendance_reviews) and, for
// an open session, the cron open-session monitor flags it too. Hospital-wide constant for now;
// a per-location override can layer on later.
export const MAX_PLAUSIBLE_SHIFT_HOURS = 20;

// How far back the CHECKOUT-MATCHING lookback searches for an open session to close —
// deliberately independent of MAX_PLAUSIBLE_SHIFT_HOURS above. That constant only decides when
// an open session gets FLAGGED for review (the cron in auto-checkout/route.ts, and Rule 2 in
// fingerprintApi.ts); it never closes anything — check_out stays null either way. A session
// flagged at hour 20 must still be closeable by the employee's real punch at hour 30: flagging
// and closing are different concerns, so they get different constants. Chosen to comfortably
// cover a genuine 24–30h emergency/double shift with margin, while still bounding how far a
// checkout scan will ever reach back — beyond this, an open session is presumed abandoned and
// is left for the cron/a supervisor to resolve, never silently matched by a later, unrelated
// punch.
export const CHECKOUT_LOOKBACK_HOURS = 36;

export type AttendanceReviewReason =
  | 'overlong'                          // actual span >= MAX_PLAUSIBLE_SHIFT_HOURS
  | 'missing_mid_punch'                 // very long span (>= 1.5x the max) — a continuous shift with no mid punch
  | 'overlong_vs_roster'               // roster known and actual materially exceeds scheduled
  | 'reopened_after_missing_checkout'  // Rule 2: an open session was closed at this punch and a fresh one opened
  | 'open_session_stale'               // cron monitor: still open past the max
  | 'retro_roster_split';              // retro-recalc split a raw session into scheduled + extra segments

export type AttendanceReviewStatus = 'flagged' | 'in_review' | 'resolved';

// Which channel raised the review row.
export type AttendanceReviewSource = 'fingerprint' | 'face' | 'cron' | 'retro_recalc';

export type SegmentBucket = 'scheduled' | 'ot_unverified';

// Session source markers, persisted on the attendance session and mirrored on the review row.
export type PunchSource = 'fingerprint_explicit' | 'inferred' | 'system_auto';

// Distinct from APPROVED_BY_SENTINEL ('FINGERPRINT', fingerprintApi.ts) and
// AUTO_APPROVED_SENTINEL ('AUTO_APPROVED', apiCompat.ts) so reports / payroll can tell a
// system-closed session apart from a real punch-out or a normal channel auto-approval.
export const SYSTEM_AUTO_SENTINEL = 'SYSTEM_AUTO';
export const SYSTEM_AUTO_METHOD = 'system_auto';

export const MAX_OT_GAP_HOURS = 24;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export type ToMs = (dateStr: string, hhmm: string) => number;

export interface ShiftWindow {
  date: string;       // 'YYYY-MM-DD' — the shift's start day
  start_time: string; // 'HH:MM', 24h
  end_time: string;   // 'HH:MM', 24h
}

function normalizeHHMM(hhmm: string): string {
  const [h, m] = String(hhmm ?? '').split(':');
  const hh = String(Number(h) || 0).padStart(2, '0');
  const mm = String(Number(m) || 0).padStart(2, '0');
  return `${hh}:${mm}`;
}

// The epoch-ms of a wall-clock 'HH:MM' on `dateStr` in Asia/Colombo. Sri Lanka has observed a
// fixed UTC+05:30 with no DST since 2006, so a literal offset is exact. Admin-side callers
// (servers run in UTC) use this; client callers that already work in the device's local clock
// pass their own builder to the functions below instead.
export function colomboWallClockMs(dateStr: string, hhmm: string): number {
  return new Date(`${dateStr}T${normalizeHHMM(hhmm)}:00+05:30`).getTime();
}

// The day after a 'YYYY-MM-DD' string (UTC math — only the calendar parts are used).
export function nextDateStr(dateStr: string): string {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// The scheduled end instant of a shift. When end_time <= start_time the shift runs past
// midnight, so the end lands on the following calendar day.
export function scheduledShiftEndMs(w: ShiftWindow, toMs: ToMs): number {
  const startMs = toMs(w.date, w.start_time);
  const sameDayEndMs = toMs(w.date, w.end_time);
  if (sameDayEndMs > startMs) return sameDayEndMs;
  return toMs(nextDateStr(w.date), w.end_time);
}

// Choose the assignment that best explains an open session that started at `checkInMs`:
//   1. a window that actually contains checkInMs (start <= checkIn <= scheduledEnd),
//   2. else the latest window whose start is at/before checkInMs,
//   3. else the earliest window,
//   4. else null — no roster row to anchor a shift end, so the caller skips auto-close.
export function pickAssignmentForOpenSession(
  assignments: ShiftWindow[] | null | undefined, checkInMs: number, toMs: ToMs,
): ShiftWindow | null {
  const rows = (assignments ?? [])
    .filter(a => a && a.date && a.start_time && a.end_time)
    .map(a => ({ a, startMs: toMs(a.date, a.start_time), endMs: scheduledShiftEndMs(a, toMs) }))
    .filter(x => Number.isFinite(x.startMs) && Number.isFinite(x.endMs));
  if (!rows.length || !Number.isFinite(checkInMs)) return null;

  const containing = rows
    .filter(x => checkInMs >= x.startMs && checkInMs <= x.endMs)
    .sort((p, q) => q.startMs - p.startMs);
  if (containing.length) return containing[0].a;

  const before = rows
    .filter(x => x.startMs <= checkInMs)
    .sort((p, q) => q.startMs - p.startMs);
  if (before.length) return before[0].a;

  return [...rows].sort((p, q) => p.startMs - q.startMs)[0].a;
}

// Is an open session abandoned past its grace window? `scheduledEndMs` must be known. A session
// whose check-in is itself after the scheduled end can't belong to that shift — never close it.
export function isPastGrace(
  checkInMs: number | null,
  scheduledEndMs: number | null,
  nowMs: number,
  graceMs: number = SCHEDULED_END_GRACE_MINUTES * MINUTE_MS,
): boolean {
  if (scheduledEndMs == null || !Number.isFinite(scheduledEndMs)) return false;
  if (nowMs < scheduledEndMs + graceMs) return false;
  if (checkInMs != null && Number.isFinite(checkInMs) && checkInMs > scheduledEndMs) return false;
  return true;
}

// OT hours between the scheduled end and a reference instant (the punch that triggered the
// self-heal, or "now"). Clamped to [0, 24] and rounded to the nearest 0.5 so it drops straight
// into the OT form's 0.5-step hours input.
export function autoCloseGapHours(scheduledEndMs: number, refMs: number): number {
  const raw = (refMs - scheduledEndMs) / HOUR_MS;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(MAX_OT_GAP_HOURS, Math.round(raw * 2) / 2);
}

// Whether two punch instants are close enough that the second is a duplicate (a sensor
// double-read, a retried offline event). Direction-agnostic — used only by the fingerprint
// channel; mobile check-in/out are deliberate taps guarded structurally instead.
export function isDuplicatePunch(
  lastPunchMs: number | null | undefined,
  punchMs: number,
  windowSeconds: number = DUP_PUNCH_DEBOUNCE_SECONDS,
): boolean {
  if (lastPunchMs == null || !Number.isFinite(lastPunchMs)) return false;
  const deltaMs = punchMs - lastPunchMs;
  return deltaMs >= 0 && deltaMs < windowSeconds * 1000;
}

// ─── Checkout-matching across day-documents ────────────────────────────────────────────────
// "If a person checked in, they must be able to check out" — no is_shift_worker flag, no
// roster dependency. attendances/{epf}_{date} is one document per LOCAL calendar day, so an
// open session from a long/overnight shift can live in a different day's document than the
// checkout punch. `dayKey` is an opaque tag the caller (fingerprintApi.ts) uses to map a
// candidate back to the day-document it actually came from — this function knows nothing about
// Firestore, dates, or which key means "today".
export interface OpenSessionRef {
  dayKey: string;
  sessionIndex: number;
  checkInMs: number;
}

// Across every still-open session found in the scanned day-documents, pick the one with the
// MOST RECENT check-in that is still within `lookbackHours` of `nowMs` — or null if none
// qualifies. "Most recent" already prefers today's session over an older day's without any
// special-casing: a later calendar day's check-in is always a larger ms value.
export function pickOpenSessionToClose(
  candidates: readonly OpenSessionRef[], nowMs: number, lookbackHours: number = CHECKOUT_LOOKBACK_HOURS,
): OpenSessionRef | null {
  const windowMs = lookbackHours * HOUR_MS;
  const withinWindow = candidates.filter(c => Number.isFinite(c.checkInMs) && nowMs - c.checkInMs <= windowMs);
  if (!withinWindow.length) return null;
  return withinWindow.reduce((best, c) => (c.checkInMs > best.checkInMs ? c : best));
}

// The session fields that turn an open session into a system-auto-closed one. Both the
// admin-SDK and client-SDK sides spread this onto the session, then attach their own timestamp
// types for `check_out` / `auto_closed_at` (Admin Timestamp vs client Firestore Timestamp) and,
// on the fingerprint channel, an `evening_allowance` computed at the scheduled end.
export function systemAutoCheckoutFields(): {
  check_out_status: 'approved';
  check_out_approved_by: string;
  check_out_method: string;
} {
  return {
    check_out_status: 'approved',
    check_out_approved_by: SYSTEM_AUTO_SENTINEL,
    check_out_method: SYSTEM_AUTO_METHOD,
  };
}

// ─── Hybrid model: overlong detection + review classification + retro segments ─────────────

const HOURS = (ms: number) => ms / HOUR_MS;

// Is the span from checkInMs to endMs (a real check-out, or "now" for an open session) long
// enough to be implausible as one continuous shift?
export function isOverlong(checkInMs: number, endMs: number): boolean {
  if (!Number.isFinite(checkInMs) || !Number.isFinite(endMs)) return false;
  return HOURS(endMs - checkInMs) >= MAX_PLAUSIBLE_SHIFT_HOURS;
}

// Classify why a session needs review, from its actual span and (if a roster row exists) its
// scheduled length. Only called once a session is already known to warrant a flag.
export function deriveReviewReason(input: {
  actualHrs: number;
  scheduledHrs: number | null;
}): AttendanceReviewReason {
  const { actualHrs, scheduledHrs } = input;
  if (actualHrs >= MAX_PLAUSIBLE_SHIFT_HOURS * 1.5) return 'missing_mid_punch';
  if (scheduledHrs != null && scheduledHrs > 0 && actualHrs > scheduledHrs + 1) return 'overlong_vs_roster';
  return 'overlong';
}

// How far over expectation a flagged session ran — informational, drives the review row's
// `severity_hours`. Against the roster when known, else against the plausible-shift ceiling.
export function reviewSeverityHours(actualHrs: number, scheduledHrs: number | null): number {
  const base = scheduledHrs != null && scheduledHrs > 0 ? scheduledHrs : MAX_PLAUSIBLE_SHIFT_HOURS;
  return Math.max(0, Math.round((actualHrs - base) * 100) / 100);
}

export interface ShiftSegment {
  index: number;
  bucket: SegmentBucket;
  start_ms: number;
  end_ms: number;
  hours: number;
  roster_assignment_id: string | null;
}

// Retro-recalculation allocator. Splits the RAW session span [startMs, endMs] across the
// employee's rostered windows for that span, WITHOUT touching the raw timestamps:
//   · time inside a rostered window → a 'scheduled' segment (carrying that assignment's id)
//   · time covered by no window     → an 'ot_unverified' segment for supervisor sign-off
// Overlapping/adjacent windows are absorbed left-to-right so nothing is double-counted.
// Invariant: Σ segment.hours === (endMs - startMs) / 3_600_000, and no segment escapes the span.
export function computeShiftSegments(input: {
  startMs: number;
  endMs: number;
  windows: Array<ShiftWindow & { id?: string | null }>;
  toMs: ToMs;
}): ShiftSegment[] {
  const { startMs, endMs, windows, toMs } = input;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];

  const intervals = (windows ?? [])
    .filter(w => w && w.date && w.start_time && w.end_time)
    .map(w => ({
      id: w.id ?? null,
      s: toMs(w.date, w.start_time),
      e: scheduledShiftEndMs(w, toMs),
    }))
    .filter(x => Number.isFinite(x.s) && Number.isFinite(x.e) && x.e > x.s)
    // clip to the session span
    .map(x => ({ id: x.id, s: Math.max(x.s, startMs), e: Math.min(x.e, endMs) }))
    .filter(x => x.e > x.s)
    .sort((a, b) => a.s - b.s);

  const out: ShiftSegment[] = [];
  let cursor = startMs;
  const push = (bucket: SegmentBucket, s: number, e: number, id: string | null) => {
    if (e - s < 1000) return; // ignore sub-second slivers
    out.push({ index: out.length, bucket, start_ms: s, end_ms: e, hours: Math.round(HOURS(e - s) * 100) / 100, roster_assignment_id: id });
  };

  for (const iv of intervals) {
    if (iv.e <= cursor) continue;          // fully absorbed by an earlier window
    const winStart = Math.max(iv.s, cursor);
    if (winStart > cursor) push('ot_unverified', cursor, winStart, null); // gap before this window
    push('scheduled', winStart, iv.e, iv.id);
    cursor = iv.e;
  }
  if (cursor < endMs) push('ot_unverified', cursor, endMs, null);
  return out;
}
