import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import type { Firestore } from 'firebase-admin/firestore';
import { secretEquals } from '@/lib/timingSafe';

// Server-to-server feed of "who is working right now" for the planning app.
//
//   GET /api/working-status              → JSON snapshot (poll this)
//   GET /api/working-status?stream=1     → Server-Sent Events, pushes a new
//                                          snapshot whenever attendance changes
//   GET /api/working-status?only=epf     → just the list of all EPF numbers
//
// Per user it returns: epf_number, name, email, phone, whether they are working
// right now, the current open session, and the sessions (start/end times) for
// today + the last 3 working days.
//
// Auth: requires the shared secret in WORKFORCE_API_KEY, supplied as either
//   Authorization: Bearer <key>   |   x-api-key: <key>   |   ?key=<key>
// (the query form exists because EventSource cannot send custom headers).
//
// firebase-admin needs the Node runtime, and the data must never be cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ─── Tunables ───────────────────────────────────────────────────────────────
const TIME_ZONE      = 'Asia/Colombo'; // attendance dates are stored as SL calendar days
const DEFAULT_DAYS   = 3;              // prior working days to include alongside today
const MAX_DAYS       = 14;
const WINDOW_DAYS    = 21;             // how far back to scan to find that many worked days
const SSE_HEARTBEAT_MS = 25_000;
const SSE_USERS_REFRESH_MS = 60_000;
const SSE_DEBOUNCE_MS = 1_500;

// ─── Date helpers (calendar maths on YYYY-MM-DD strings) ──────────────────────
function colomboToday(): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
}

function shiftDateStr(date: string, deltaDays: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// ─── Value coercion ───────────────────────────────────────────────────────────
function tsToIso(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'object' && v !== null && typeof (v as { toDate?: unknown }).toDate === 'function') {
    return (v as { toDate(): Date }).toDate().toISOString();
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && v !== null && typeof (v as { seconds?: unknown }).seconds === 'number') {
    return new Date((v as { seconds: number }).seconds * 1000).toISOString();
  }
  if (typeof v === 'string') return v;
  return null;
}

// ─── Snapshot shapes ──────────────────────────────────────────────────────────
type RawRecord = Record<string, unknown>;

interface SessionOut {
  id:             string;
  check_in:       string | null;  // ISO 8601 (UTC); start time
  check_out:      string | null;  // ISO 8601 (UTC); end time, null while open
  working_place:  string | null;
  site_number:    string | null;
  is_outstation:  boolean;
  outstation_name: string | null;
  is_open:        boolean;        // checked in, not yet checked out
}

interface DayOut {
  date:     string;   // YYYY-MM-DD
  is_today: boolean;
  sessions: SessionOut[];
}

interface UserOut {
  epf_number:      string;
  name:            string;
  email:           string;
  phone:           string;        // best available number
  phone_personal:  string;
  phone_office:    string;
  is_active:       boolean;
  is_shift_worker: boolean;
  is_working:      boolean;       // has an open session right now
  current_session: { date: string; check_in: string | null; working_place: string | null; site_number: string | null } | null;
  days:            DayOut[];      // today first, then the last N working days
}

// A day's attendance is an array of sessions; legacy docs kept a single session in
// top-level fields. Normalize both into a raw session array.
function sessionsOf(rec: RawRecord): RawRecord[] {
  if (Array.isArray(rec.sessions)) return rec.sessions as RawRecord[];
  if (!rec.check_in && !rec.check_out) return [];
  return [{
    id:              's0',
    check_in:        rec.check_in ?? null,
    check_out:       rec.check_out ?? null,
    working_place:   rec.working_place ?? null,
    site_number:     rec.site_number ?? null,
    is_outstation:   rec.is_outstation ?? false,
    outstation_name: rec.outstation_name ?? null,
  }];
}

function mapSession(s: RawRecord): SessionOut {
  const check_in  = tsToIso(s.check_in);
  const check_out = tsToIso(s.check_out);
  return {
    id:              String(s.id ?? 's0'),
    check_in,
    check_out,
    working_place:   (s.working_place as string) ?? null,
    site_number:     (s.site_number as string) ?? null,
    is_outstation:   !!s.is_outstation,
    outstation_name: (s.outstation_name as string) ?? null,
    is_open:         !!check_in && !check_out,
  };
}

interface UserLite {
  epf_number:      string;
  display_name:    string;
  email:           string;
  phone_personal:  string;
  phone_office:    string;
  phone_emergency: string;
  is_active:       boolean;
  is_shift_worker: boolean;
}

function toUserLite(u: RawRecord): UserLite {
  return {
    epf_number:      String(u.epf_number ?? ''),
    display_name:    (u.display_name as string) ?? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim(),
    email:           (u.email as string) ?? '',
    phone_personal:  (u.phone_personal as string) ?? '',
    phone_office:    (u.phone_office as string) ?? '',
    phone_emergency: (u.phone_emergency as string) ?? '',
    is_active:       u.is_active !== false,
    is_shift_worker: !!u.is_shift_worker,
  };
}

// Build the full snapshot payload from already-fetched users + recent attendance docs.
function buildSnapshot(
  users: UserLite[],
  records: RawRecord[],
  opts: { today: string; priorDays: number },
): {
  generated_at: string;
  timezone: string;
  today: string;
  count: number;
  working_count: number;
  epf_numbers: string[];
  users: UserOut[];
} {
  const { today, priorDays } = opts;
  const yesterday = shiftDateStr(today, -1);

  // Group attendance docs by EPF.
  const byEpf = new Map<string, RawRecord[]>();
  for (const r of records) {
    const epf = String(r.epf_number ?? '');
    if (!epf) continue;
    (byEpf.get(epf) ?? byEpf.set(epf, []).get(epf)!).push(r);
  }

  const out: UserOut[] = users.map((u) => {
    const recs = byEpf.get(u.epf_number) ?? [];
    const byDate = new Map<string, RawRecord>();
    for (const r of recs) byDate.set(String(r.date ?? ''), r);

    const todayRec = byDate.get(today);
    const todaySessions = todayRec ? sessionsOf(todayRec).map(mapSession) : [];

    // "Working right now" = an open session today; for shift (overnight) workers an
    // open session that started yesterday also counts.
    let openSession = todaySessions.find((s) => s.is_open) ?? null;
    let openDate = openSession ? today : null;
    if (!openSession && u.is_shift_worker) {
      const yRec = byDate.get(yesterday);
      const yOpen = yRec ? sessionsOf(yRec).map(mapSession).find((s) => s.is_open) : undefined;
      if (yOpen) { openSession = yOpen; openDate = yesterday; }
    }

    // Today first, then the most recent prior days that actually have records.
    const priorDates = recs
      .map((r) => String(r.date ?? ''))
      .filter((d) => d && d !== today)
      .sort((a, b) => (a < b ? 1 : -1))
      .slice(0, priorDays);

    const days: DayOut[] = [
      { date: today, is_today: true, sessions: todaySessions },
      ...priorDates.map((d) => ({
        date: d,
        is_today: false,
        sessions: sessionsOf(byDate.get(d)!).map(mapSession),
      })),
    ];

    return {
      epf_number:      u.epf_number,
      name:            u.display_name,
      email:           u.email,
      phone:           u.phone_personal || u.phone_office || u.phone_emergency || '',
      phone_personal:  u.phone_personal,
      phone_office:    u.phone_office,
      is_active:       u.is_active,
      is_shift_worker: u.is_shift_worker,
      is_working:      !!openSession,
      current_session: openSession
        ? { date: openDate!, check_in: openSession.check_in, working_place: openSession.working_place, site_number: openSession.site_number }
        : null,
      days,
    };
  });

  return {
    generated_at:  new Date().toISOString(),
    timezone:      TIME_ZONE,
    today,
    count:         out.length,
    working_count: out.filter((u) => u.is_working).length,
    epf_numbers:   users.map((u) => u.epf_number),
    users:         out,
  };
}

// ─── Data access ──────────────────────────────────────────────────────────────
async function fetchUsers(db: Firestore, epfFilter: string[] | null, activeOnly: boolean): Promise<UserLite[]> {
  const snap = await db.collection('users').get();
  let users = snap.docs.map((d) => toUserLite(d.data() as RawRecord)).filter((u) => u.epf_number);
  if (activeOnly) users = users.filter((u) => u.is_active);
  if (epfFilter) {
    const set = new Set(epfFilter);
    users = users.filter((u) => set.has(u.epf_number));
  }
  users.sort((a, b) => a.display_name.localeCompare(b.display_name));
  return users;
}

async function fetchRecentRecords(db: Firestore, today: string): Promise<RawRecord[]> {
  const start = shiftDateStr(today, -WINDOW_DAYS);
  // Single range query over `date` returns every user's recent docs at once.
  const snap = await db.collection('attendances').where('date', '>=', start).get();
  return snap.docs.map((d) => d.data() as RawRecord);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function checkAuth(req: NextRequest): { ok: true } | { ok: false; status: number; error: string } {
  const expected = process.env.WORKFORCE_API_KEY;
  if (!expected) {
    return { ok: false, status: 503, error: 'API not configured: set WORKFORCE_API_KEY on the server.' };
  }
  const url = new URL(req.url);
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const provided = bearer || req.headers.get('x-api-key') || url.searchParams.get('key') || '';
  if (!secretEquals(provided, expected)) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const db = adminDbFor(req);
  const url = new URL(req.url);
  const today = colomboToday();
  const activeOnly = url.searchParams.get('active') === 'true';
  const epfFilter = url.searchParams.get('epf')
    ? url.searchParams.get('epf')!.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const priorDays = Math.min(
    MAX_DAYS,
    Math.max(0, Number(url.searchParams.get('days') ?? DEFAULT_DAYS) || DEFAULT_DAYS),
  );

  try {
    // Lightweight mode: just the EPF list (no attendance scan).
    if (url.searchParams.get('only') === 'epf') {
      const users = await fetchUsers(db, epfFilter, activeOnly);
      return NextResponse.json(
        { generated_at: new Date().toISOString(), count: users.length, epf_numbers: users.map((u) => u.epf_number) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // Realtime mode: stream a fresh snapshot on every attendance change.
    if (url.searchParams.get('stream') === '1' || url.searchParams.get('stream') === 'true') {
      return streamSnapshots(req, { today, priorDays, epfFilter, activeOnly });
    }

    // Default: one JSON snapshot.
    const [users, records] = await Promise.all([fetchUsers(db, epfFilter, activeOnly), fetchRecentRecords(db, today)]);
    return NextResponse.json(buildSnapshot(users, records, { today, priorDays }), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    console.error('[working-status]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// ─── SSE streaming ────────────────────────────────────────────────────────────
// Holds the connection open and pushes `event: snapshot` frames whenever the
// attendance window changes. Needs a long-running Node host (not a short-lived
// serverless invocation); polling the JSON endpoint is the portable fallback.
function streamSnapshots(
  req: NextRequest,
  opts: { today: string; priorDays: number; epfFilter: string[] | null; activeOnly: boolean },
): Response {
  const encoder = new TextEncoder();
  const db = adminDbFor(req);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let users: UserLite[] = [];
      let debounce: ReturnType<typeof setTimeout> | null = null;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { /* connection gone */ }
      };

      const rebuildAndSend = async () => {
        // `today` can roll over during a long-lived connection — recompute it.
        const today = colomboToday();
        const records = await fetchRecentRecords(db, today);
        send('snapshot', buildSnapshot(users, records, { today, priorDays: opts.priorDays }));
      };

      try {
        users = await fetchUsers(db, opts.epfFilter, opts.activeOnly);
        await rebuildAndSend();
      } catch (e) {
        send('error', { error: 'init failed' });
        console.error('[working-status:sse:init]', e);
      }

      // Re-listen to today's + yesterday's docs (overnight check-outs land on the
      // session's start day). Debounce bursts of writes into one rebuild.
      const listenFrom = shiftDateStr(colomboToday(), -1);
      const unsub = db.collection('attendances').where('date', '>=', listenFrom).onSnapshot(
        () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => { rebuildAndSend().catch(() => {}); }, SSE_DEBOUNCE_MS);
        },
        (err) => { console.error('[working-status:sse:listen]', err); },
      );

      // Keep the user list fresh (new hires / deactivations / shift flags).
      const usersTimer = setInterval(() => {
        fetchUsers(db, opts.epfFilter, opts.activeOnly).then((u) => { users = u; }).catch(() => {});
      }, SSE_USERS_REFRESH_MS);

      // Heartbeat comment so proxies/clients keep the connection alive.
      const beat = setInterval(() => { if (!closed) { try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { /* noop */ } } }, SSE_HEARTBEAT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (debounce) clearTimeout(debounce);
        clearInterval(usersTimer);
        clearInterval(beat);
        try { unsub(); } catch { /* noop */ }
        try { controller.close(); } catch { /* noop */ }
      };

      req.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
