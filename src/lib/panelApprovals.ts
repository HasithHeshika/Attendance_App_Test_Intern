// Pure helpers behind the "approve from the person panel" feature (UserActivityPanel on
// /users). Kept free of firebase and React so the routing contract can be unit-tested.
//
// ROUTING SAFETY: a session is approvable in the panel ONLY if it appears in the VIEWER's own
// approval queue — the same two builders the Approvals page calls (getPastAttendanceApprovalList
// and getCheckinApprovalList in apiCompat.ts). Those calls mint the numeric ids and register
// them in window.__attIdMap; nothing here ever constructs an id. The panel then approves with
// the very same payload shapes the Approvals page sends, from the RECORDED times (no editing),
// with the auto-calculated food allowances that page would have seeded its cards with.

// Furthest the past/backlog window can be widened (months before today) — the Approvals page's
// own ceiling; a month older than this is approved there, not from the panel.
export const PAST_BACKLOG_MAX_MONTHS = 6;

// A row of getPastAttendanceApprovalList (past submissions + stranded backlog).
export interface PastQueueRow {
  attendance_id: number;
  epf_number: string | number;
  date?: string | null;
  check_in?: string | null;      // 'YYYY-MM-DD HH:MM:SS' (local) — may arrive ISO-shaped
  check_out?: string | null;
  working_place?: string | null;
  site_number?: string | null;
  is_outstation?: boolean | null;
  outstation_name?: string | null;
  outstation_address?: string | null;
  morning_allowance?: number | null;
  evening_allowance?: number | null;
  check_in_approved?: boolean;
  user_type?: string;
}

// A row of getCheckinApprovalList's tech_list / exe_list (today + yesterday's overnight checkouts).
export interface LiveQueueRow {
  attendance_id: number;
  epf_number: string | number;
  date?: string | null;
  type: 'check_in' | 'check_out' | 'both';
  time?: string | null;            // check-in time, or the checkout time for a 'check_out' row
  check_out_time?: string | null;  // checkout time on a 'both' row
  working_place?: string | null;
  site_no?: string | null;
  is_outstation?: boolean | null;
  outstation_name?: string | null;
  outstation_address?: string | null;
}

interface ApprovableBase {
  id: number;            // queue id — resolves through window.__attIdMap
  date: string;          // the record's day (YYYY-MM-DD)
  working_place: string;
  site_no: string;
  outstation_name: string;
  outstation_address: string;
  is_outstation: boolean;
}
export interface ApprovablePast extends ApprovableBase {
  kind: 'past';
  check_in_time: string;
  check_out_time: string;
  morning_allowance: number | null;   // stored value (already-approved half) or null → calc
  evening_allowance: number | null;
  check_in_approved: boolean;
}
export interface ApprovableLive extends ApprovableBase {
  kind: 'check_in' | 'check_out' | 'both';
  time: string;             // check-in time ('check_in' / 'both') or checkout time ('check_out')
  check_out_time: string;   // checkout time on a 'both' row
}
export type ApprovableSession = ApprovablePast | ApprovableLive;

// Normalise to "YYYY-MM-DD HH:MM:SS" — a builder may hand back ISO with a T or microseconds.
const norm = (s: string | null | undefined): string => (s ?? '').replace('T', ' ').slice(0, 19);
const toMinute = (s: string) => s.slice(0, 16);

// Whole months between the viewed month and today's month, floored at 1 — the `monthsBack`
// the past/backlog builder needs so its window (first day of the month N months before today)
// reaches back to cover the viewed month.
export function monthsBackFor(viewedYear: number, viewedMonth: number, todayStr: string): number {
  const ty = Number(todayStr.slice(0, 4));
  const tm = Number(todayStr.slice(5, 7));
  const diff = (ty - viewedYear) * 12 + (tm - viewedMonth);
  return Math.max(1, diff);
}

// The viewer's queue rows for ONE employee, grouped by the record's date. Both lists are
// filtered to that epf; nothing is fabricated — a day is approvable exactly when a queue row
// for it exists, and each entry carries the fields the approve payload needs.
export function buildApprovableMap(
  pastRows: readonly PastQueueRow[] | null | undefined,
  liveRows: readonly LiveQueueRow[] | null | undefined,
  epf: string,
): Map<string, ApprovableSession[]> {
  const out = new Map<string, ApprovableSession[]>();
  const seen = new Set<number>();
  const target = String(epf);
  const push = (entry: ApprovableSession) => {
    if (!entry.date || seen.has(entry.id)) return;
    seen.add(entry.id);
    const arr = out.get(entry.date) ?? [];
    arr.push(entry);
    out.set(entry.date, arr);
  };
  for (const r of pastRows ?? []) {
    if (String(r.epf_number) !== target) continue;
    const check_in_time = norm(r.check_in);
    push({
      kind: 'past',
      id: Number(r.attendance_id),
      date: r.date || check_in_time.slice(0, 10),
      check_in_time,
      check_out_time: norm(r.check_out),
      working_place: r.working_place ?? '',
      site_no: r.site_number ?? '',
      outstation_name: r.outstation_name ?? '',
      outstation_address: r.outstation_address ?? '',
      is_outstation: !!r.is_outstation,
      morning_allowance: r.morning_allowance ?? null,
      evening_allowance: r.evening_allowance ?? null,
      check_in_approved: !!r.check_in_approved,
    });
  }
  for (const r of liveRows ?? []) {
    if (String(r.epf_number) !== target) continue;
    const time = norm(r.time);
    push({
      kind: r.type,
      id: Number(r.attendance_id),
      date: r.date || time.slice(0, 10),
      time,
      check_out_time: norm(r.check_out_time),
      working_place: r.working_place ?? '',
      site_no: r.site_no ?? '',
      outstation_name: r.outstation_name ?? '',
      outstation_address: r.outstation_address ?? '',
      is_outstation: !!r.is_outstation,
    });
  }
  return out;
}

// The recorded times of one session on the panel's day card, as local 'YYYY-MM-DD HH:MM:SS'.
export interface SessionTimes { checkIn: string | null; checkOut: string | null }

// Which of a day's approvable entries is THIS session? A lone session with a lone entry is
// the same thing; otherwise match on the recorded time (minute precision — the queue rows
// carry capture seconds, the comparison must not hinge on them). A checkout-only live entry
// is anchored on the checkout, everything else on the check-in.
export function approvableForSession(
  entries: readonly ApprovableSession[] | null | undefined,
  times: SessionTimes,
  sessionCount: number,
): ApprovableSession | null {
  if (!entries || entries.length === 0) return null;
  if (entries.length === 1 && sessionCount === 1) return entries[0];
  const ci = times.checkIn ? toMinute(norm(times.checkIn)) : null;
  const co = times.checkOut ? toMinute(norm(times.checkOut)) : null;
  for (const e of entries) {
    if (e.kind === 'check_out') { if (co && toMinute(e.time) === co) return e; continue; }
    const anchor = e.kind === 'past' ? e.check_in_time : e.time;
    if (ci && toMinute(anchor) === ci) return e;
  }
  return null;
}

export type SkipReason = 'missing_check_in' | 'missing_check_out' | 'zero_length' | 'missing_place' | 'missing_site';

export interface AllowanceCalcs {
  morning: (timeStr: string) => number;
  evening: (timeStr: string) => number;
}
export interface PastApproveItem {
  id: number;
  check_in_time: string;
  check_out_time: string;
  working_place: string;
  site_no: string;
  outstation_name: string;
  outstation_address: string;
  is_outstation_approved: boolean;
  morning_allowance: number;
  evening_allowance: number;
}
export interface CheckInApproveItem { id: number; time: string; morning_allowance: number }
export interface CheckOutApproveItem {
  id: number;
  time: string;
  evening_allowance: number;
  working_place: string;
  site_no: string | null;
  is_outstation: boolean;
  is_outstation_approved: boolean;
}
export interface ApprovalPayloads {
  past: PastApproveItem[];       // → attendanceApi.approvePastAttendance({ epf_number, approved_list })
  checkIn: CheckInApproveItem[]; // → attendanceApi.approveCheckIn   (send BEFORE checkOut — a 'both' row needs the claim order)
  checkOut: CheckOutApproveItem[]; // → attendanceApi.approveCheckOut
  skipped: { id: number; reason: SkipReason }[];
}

// Build the exact payloads the Approvals page would send for these sessions, unedited:
//  • past rows mirror makePastEditState + handleApprovePast's readiness checks (a stored
//    allowance on an already-approved half wins over the calc; a missing checkout, a
//    zero-length session, a missing place or a missing required site number is skipped);
//  • live rows mirror makeEditState + submitByType — a 'both' row lands in BOTH lists.
// A live row with no recorded time is skipped rather than stamped with "now", which is what
// the page's fallback would do for a card that never loaded.
export function toApprovalPayloads(
  sessions: readonly ApprovableSession[],
  calcs: AllowanceCalcs,
  opts?: { requiresSite?: (workingPlace: string) => boolean },
): ApprovalPayloads {
  const out: ApprovalPayloads = { past: [], checkIn: [], checkOut: [], skipped: [] };
  const requiresSite = opts?.requiresSite ?? (() => false);
  for (const s of sessions) {
    if (s.kind === 'past') {
      if (!s.check_in_time)  { out.skipped.push({ id: s.id, reason: 'missing_check_in' });  continue; }
      if (!s.check_out_time) { out.skipped.push({ id: s.id, reason: 'missing_check_out' }); continue; }
      if (toMinute(s.check_out_time) === toMinute(s.check_in_time)) { out.skipped.push({ id: s.id, reason: 'zero_length' }); continue; }
      if (!s.working_place)  { out.skipped.push({ id: s.id, reason: 'missing_place' });     continue; }
      if (requiresSite(s.working_place) && !s.site_no) { out.skipped.push({ id: s.id, reason: 'missing_site' }); continue; }
      out.past.push({
        id: s.id,
        check_in_time: s.check_in_time,
        check_out_time: s.check_out_time,
        working_place: s.working_place,
        site_no: s.site_no,
        outstation_name: s.outstation_name,
        outstation_address: s.outstation_address,
        is_outstation_approved: s.is_outstation,
        morning_allowance: s.morning_allowance ?? calcs.morning(s.check_in_time),
        evening_allowance: s.evening_allowance ?? calcs.evening(s.check_out_time),
      });
      continue;
    }
    const hasCheckIn  = s.kind === 'check_in'  || s.kind === 'both';
    const hasCheckOut = s.kind === 'check_out' || s.kind === 'both';
    // For a 'both' row the checkout lives in check_out_time; for a pure check-out it's `time`.
    const outTime = s.kind === 'both' ? (s.check_out_time || s.time) : s.time;
    if (hasCheckIn && !s.time)    { out.skipped.push({ id: s.id, reason: 'missing_check_in' });  continue; }
    if (hasCheckOut && !outTime)  { out.skipped.push({ id: s.id, reason: 'missing_check_out' }); continue; }
    if (hasCheckIn) out.checkIn.push({ id: s.id, time: s.time, morning_allowance: calcs.morning(s.time) });
    if (hasCheckOut) out.checkOut.push({
      id: s.id,
      time: outTime,
      evening_allowance: calcs.evening(outTime),
      working_place: s.working_place,
      site_no: s.site_no || null,
      is_outstation: s.is_outstation,
      is_outstation_approved: s.is_outstation,
    });
  }
  return out;
}

// ── Day trail / month map (pure; the panel supplies the formatting) ─────────────

// Firestore Timestamp | {seconds} | Date | ISO string → epoch ms (null when absent/invalid).
export function toMillis(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isNaN(t) ? null : t; }
  if (typeof v === 'object') {
    const o = v as { toDate?: () => Date; seconds?: number };
    if (typeof o.toDate === 'function') return toMillis(o.toDate());
    if (typeof o.seconds === 'number') return o.seconds * 1000;
    return null;
  }
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}

// The GPS-bearing subset of a session (see DaySess in UserActivityPanel).
export interface GpsSession {
  check_in?: unknown; check_out?: unknown;
  check_in_lat?: number | null;  check_in_lng?: number | null;  check_in_accuracy_m?: number | null;
  check_out_lat?: number | null; check_out_lng?: number | null; check_out_accuracy_m?: number | null;
  check_in_site_name?: string | null;
  check_in_site_id?: string | null;
  working_place?: string | null;
  locations?: readonly {
    name?: string | null; lat?: number | null; lng?: number | null; accuracy_m?: number | null;
    source?: string; added_at?: unknown;
  }[] | null;
}

// One stop on the day's trail — structurally a TrailPoint for AttendanceMiniMap, plus what the
// stops list under the map needs (time, place name, epoch ms).
export interface TrailStop {
  lat: number; lng: number; accuracy: number | null;
  kind: 'checkin' | 'update' | 'checkout';
  label: string;          // full tooltip, e.g. "Update · 10:30 · Site A"
  short?: string;         // permanent map label on the anchors, e.g. "In 08:15"
  time: string;
  name: string;
  atMs: number | null;
}
export interface TrailLabels { checkIn: string; checkOut: string; update: string; inShort: string; outShort: string }

const samePoint = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;

// Check-in → every location entry that carries coordinates (whatever its source), in added_at
// order → check-out. An entry sitting exactly on the check-in or check-out point is the same
// capture and is not drawn twice; its name still names that anchor. On an old doc whose GPS
// lives only on its 'check_in'/'check_out' location entries, those entries become the anchors.
export function buildTrail(s: GpsSession, fmtTime: (v: unknown) => string, labels: TrailLabels): TrailStop[] {
  const located = (s.locations ?? [])
    .filter(l => l.lat != null && l.lng != null)
    .map((l, i) => ({ lat: l.lat as number, lng: l.lng as number, accuracy: l.accuracy_m ?? null, name: l.name ?? '', source: l.source, atMs: toMillis(l.added_at), i }))
    .sort((a, b) => (a.atMs ?? -1) - (b.atMs ?? -1) || a.i - b.i);
  let ci = s.check_in_lat != null && s.check_in_lng != null
    ? { lat: s.check_in_lat, lng: s.check_in_lng, accuracy: s.check_in_accuracy_m ?? null } : null;
  let co = s.check_out_lat != null && s.check_out_lng != null
    ? { lat: s.check_out_lat, lng: s.check_out_lng, accuracy: s.check_out_accuracy_m ?? null } : null;
  if (!ci) { const l = located.find(x => x.source === 'check_in');  if (l) ci = { lat: l.lat, lng: l.lng, accuracy: l.accuracy }; }
  if (!co && s.check_out != null) { const l = located.find(x => x.source === 'check_out'); if (l) co = { lat: l.lat, lng: l.lng, accuracy: l.accuracy }; }
  if (!ci && !co) return [];
  const inName  = located.find(l => ci && samePoint(l, ci))?.name || s.check_in_site_name || s.working_place || '';
  const outName = located.find(l => co && samePoint(l, co))?.name || '';
  const out: TrailStop[] = [];
  if (ci) {
    const time = fmtTime(s.check_in);
    out.push({ ...ci, kind: 'checkin', label: `${labels.checkIn} · ${time}`, short: `${labels.inShort} ${time}`, time, name: inName, atMs: toMillis(s.check_in) });
  }
  for (const l of located) {
    if ((ci && samePoint(l, ci)) || (co && samePoint(l, co))) continue;
    const time = l.atMs != null ? fmtTime(new Date(l.atMs)) : '';
    out.push({
      lat: l.lat, lng: l.lng, accuracy: l.accuracy, kind: 'update',
      label: [labels.update, time, l.name].filter(Boolean).join(' · '),
      time, name: l.name, atMs: l.atMs,
    });
  }
  if (co) {
    const time = fmtTime(s.check_out);
    out.push({ ...co, kind: 'checkout', label: `${labels.checkOut} · ${time}`, short: `${labels.outShort} ${time}`, time, name: outName, atMs: toMillis(s.check_out) });
  }
  return out;
}

// In/out of one session for the strip above its map: duration, whether the check-out fell on
// a later calendar day, and whether the session is still open.
export function sessionSpan(checkIn: unknown, checkOut: unknown): {
  inMs: number | null; outMs: number | null; minutes: number | null; nextDay: boolean; open: boolean;
} {
  const inMs = toMillis(checkIn);
  const outMs = toMillis(checkOut);
  const minutes = inMs != null && outMs != null && outMs > inMs ? Math.round((outMs - inMs) / 60000) : null;
  const nextDay = inMs != null && outMs != null && new Date(inMs).toDateString() !== new Date(outMs).toDateString();
  return { inMs, outMs, minutes, nextDay, open: inMs != null && outMs == null };
}

export interface MonthStop extends TrailStop { date: string }

// Every check-in and check-out with GPS in the month, each stop remembering its day so a
// click on the map can open that day. No trail order is implied between days.
export function buildMonthMap(
  days: readonly { date: string; sessions: readonly GpsSession[] }[],
  fmtTime: (v: unknown) => string,
  fmtDay: (date: string) => string,
  labels: { inShort: string; outShort: string },
): { stops: MonthStop[]; withGps: number; withoutGps: number; topSiteId: string | null } {
  const stops: MonthStop[] = [];
  const siteCount = new Map<string, number>();
  let withGps = 0, withoutGps = 0;
  for (const day of days) {
    let dayHasGps = false;
    for (const s of day.sessions) {
      if (s.check_in_site_id) siteCount.set(String(s.check_in_site_id), (siteCount.get(String(s.check_in_site_id)) ?? 0) + 1);
      if (s.check_in_lat != null && s.check_in_lng != null) {
        const time = fmtTime(s.check_in);
        const label = `${fmtDay(day.date)} · ${labels.inShort} ${time}`;
        stops.push({ date: day.date, lat: s.check_in_lat, lng: s.check_in_lng, accuracy: s.check_in_accuracy_m ?? null, kind: 'checkin', label, time, name: s.check_in_site_name ?? s.working_place ?? '', atMs: toMillis(s.check_in) });
        dayHasGps = true;
      }
      if (s.check_out_lat != null && s.check_out_lng != null) {
        const time = fmtTime(s.check_out);
        const label = `${fmtDay(day.date)} · ${labels.outShort} ${time}`;
        stops.push({ date: day.date, lat: s.check_out_lat, lng: s.check_out_lng, accuracy: s.check_out_accuracy_m ?? null, kind: 'checkout', label, time, name: '', atMs: toMillis(s.check_out) });
        dayHasGps = true;
      }
    }
    if (dayHasGps) withGps += 1; else withoutGps += 1;
  }
  let topSiteId: string | null = null, top = 0;
  for (const [id, n] of siteCount) if (n > top) { top = n; topSiteId = id; }
  return { stops, withGps, withoutGps, topSiteId };
}
