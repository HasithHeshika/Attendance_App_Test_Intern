import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { verifyAdminCaller } from '@/lib/adminCaller';
import { loadGreetingSettings } from '@/lib/greetingsServer';
import { isValidSpecialDate, type GreetingSettings, type SpecialDay, type SpecialDayMode, type SignerGroup } from '@/lib/greetings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// settings/greetings is client-readable but written only here (see firestore.rules).

export async function GET(req: NextRequest) {
  const db = adminDbFor(req);
  // Authorization header only. This used to accept `?idToken=`, which put a live session
  // credential into the access log, the browser history and every outgoing Referer. A GET has
  // no body to hide it in, so the header is the only acceptable place — the same reason
  // /api/admin/settings-backup refuses a query-string token.
  const header = req.headers.get('authorization') ?? '';
  const idToken = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const caller = await verifyAdminCaller(db, idToken);
  if (!caller) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  return NextResponse.json({ settings: await loadGreetingSettings(db) });
}

function validate(input: unknown): { settings: GreetingSettings } | { error: string } {
  const s = (input ?? {}) as Partial<GreetingSettings>;
  const days = Array.isArray(s.special_days) ? s.special_days : [];
  const seen = new Set<string>();
  const clean: SpecialDay[] = [];
  for (const raw of days as Partial<SpecialDay>[]) {
    const id = String(raw.id ?? '').trim();
    const title = String(raw.title ?? '').trim();
    const date = String(raw.date ?? '').trim();
    if (!id || seen.has(id)) return { error: 'Each special day needs a unique id' };
    if (!title) return { error: 'Each special day needs a title' };
    seen.add(id);

    const mode: SpecialDayMode = raw.mode === 'calendar' || raw.mode === 'once' || raw.mode === 'annual'
      ? raw.mode
      : (date.length === 5 ? 'annual' : 'once');   // rows saved before `mode` existed
    const calendarName = String(raw.calendar_name ?? '').trim();

    if (mode === 'calendar') {
      if (!calendarName) return { error: `"${title}" follows the holiday calendar, so it needs a holiday name` };
    } else if (!isValidSpecialDate(date)) {
      return { error: `Invalid date "${date}" for "${title}" — use MM-DD or YYYY-MM-DD` };
    }

    // Per-year overrides: only well-formed 'YYYY' → 'YYYY-MM-DD' pairs survive, and the year
    // must agree with the date, or a typo would silently move a holiday.
    const byYear: Record<string, string> = {};
    for (const [y, v] of Object.entries((raw.dates_by_year ?? {}) as Record<string, unknown>)) {
      const val = String(v ?? '').trim();
      if (/^\d{4}$/.test(y) && /^\d{4}-\d{2}-\d{2}$/.test(val) && val.slice(0, 4) === y) byYear[y] = val;
    }

    // The Sinhala and Tamil title/message the special-day dialog collects. These were being
    // dropped here: the dialog wrote them, this whole-document .set() rebuilt the row without
    // them, and every translation an admin typed was silently discarded on save. Only non-empty
    // values are carried, so an untranslated day stays absent rather than storing ''.
    const tr = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
    const titleSi = tr(raw.title_si, 80);
    const titleTa = tr(raw.title_ta, 80);
    const msgSi   = tr(raw.message_si, 500);
    const msgTa   = tr(raw.message_ta, 500);

    clean.push({
      id,
      title: title.slice(0, 80),
      message: String(raw.message ?? '').trim().slice(0, 500),
      ...(titleSi ? { title_si: titleSi } : {}),
      ...(titleTa ? { title_ta: titleTa } : {}),
      ...(msgSi   ? { message_si: msgSi } : {}),
      ...(msgTa   ? { message_ta: msgTa } : {}),
      enabled: raw.enabled !== false,
      mode,
      ...(mode === 'calendar' ? { calendar_name: calendarName.slice(0, 120) } : { date }),
      ...(Object.keys(byYear).length ? { dates_by_year: byYear } : {}),
    });
  }
  // Signers: EPF strings, de-duplicated, order preserved (it is the order they sign in).
  const signers: string[] = [];
  for (const raw of Array.isArray(s.signers) ? s.signers : []) {
    const epf = String(raw ?? '').trim();
    if (epf && !signers.includes(epf)) signers.push(epf);
  }
  if (signers.length > 20) return { error: 'Pick at most 20 signers' };

  // Scoped signer lists (see SignerGroup). A group with no people left is dropped rather than
  // stored: an empty group is indistinguishable from no rule when it is read back, and keeping
  // it would only be a row nobody can tell the meaning of.
  const groups: SignerGroup[] = [];
  for (const raw of Array.isArray(s.signer_groups) ? s.signer_groups : []) {
    const g = (raw ?? {}) as unknown as Record<string, unknown>;
    const scope = g.scope === 'company' || g.scope === 'department' ? g.scope : null;
    const key = String(g.key ?? '').trim();
    if (!scope || !key) continue;
    if (groups.some(x => x.scope === scope && x.key.trim().toLowerCase() === key.toLowerCase())) {
      return { error: `Two ${scope} rules name the same ${scope === 'company' ? 'company' : 'department'}` };
    }
    const list: string[] = [];
    for (const rawEpf of Array.isArray(g.signers) ? g.signers : []) {
      const epf = String(rawEpf ?? '').trim();
      if (epf && !list.includes(epf)) list.push(epf);
    }
    if (list.length > 20) return { error: 'Pick at most 20 signers' };
    if (list.length) groups.push({ scope, key, signers: list });
  }
  if (groups.length > 50) return { error: 'Too many signer rules' };

  return { settings: {
    enabled: s.enabled === true, birthday: s.birthday !== false, anniversary: s.anniversary !== false,
    special: s.special !== false, special_days: clean, signers, signer_groups: groups,
  } };
}

export async function PUT(req: NextRequest) {
  const db = adminDbFor(req);
  let body: { idToken?: unknown; settings?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }
  const caller = await verifyAdminCaller(db, body.idToken);
  if (!caller) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const v = validate(body.settings);
  if ('error' in v) return NextResponse.json({ error: v.error }, { status: 400 });
  const doc = { ...v.settings, updated_at: FieldValue.serverTimestamp(), updated_by: caller.epf, updated_by_name: caller.name };
  await db.collection('settings').doc('greetings').set(doc);
  return NextResponse.json({ ok: true, settings: await loadGreetingSettings(db) });
}
