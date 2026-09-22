import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor, tenantForRequest } from '@/lib/firebaseAdmin';
import { verifyAdminCaller } from '@/lib/adminCaller';
import { colomboToday, deliverGreeting, loadGreetingMessages, loadGreetingSettings, loadPeopleAndRoles, epfDocId, type PersonDoc } from '@/lib/greetingsServer';
import { anniversaryYears, isActiveOn, selectSenders, resolveSigners, type Occasion } from '@/lib/greetings';
import { mergeSenders, messagesFor, renderMessage } from '@/lib/greetingMessages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// "Send a test" on System Settings: deliver one real greeting to one EPF right now, flagged
// meta.test='1'. Claims no marker and ignores the enabled switches — the admin is asking to
// see the card, not to schedule it.
export async function POST(req: NextRequest) {
  const db = adminDbFor(req);
  let body: { idToken?: unknown; epf?: unknown; occasion?: unknown; dayId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }
  const caller = await verifyAdminCaller(db, body.idToken);
  if (!caller) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const epf = String(body.epf ?? '').trim();
  const kind = String(body.occasion ?? '');
  if (!epf || !['birthday', 'anniversary', 'special'].includes(kind)) {
    return NextResponse.json({ error: 'epf and occasion (birthday | anniversary | special) are required' }, { status: 400 });
  }
  const today = colomboToday();
  const { people, roles } = await loadPeopleAndRoles(db);
  let recipient: PersonDoc | undefined = people.find(p => String(p.data.epf_number) === epf);
  if (!recipient) {
    const snap = await db.collection('users').doc(epfDocId(epf)).get();
    if (snap.exists) recipient = { ref: snap.ref, data: snap.data() as PersonDoc['data'] };
  }
  if (!recipient || !isActiveOn(recipient.data, today)) return NextResponse.json({ error: 'No active user with that EPF' }, { status: 404 });

  let occasion: Occasion;
  if (kind === 'birthday') occasion = { kind: 'birthday' };
  else if (kind === 'anniversary') {
    const real = anniversaryYears(recipient.data.date_of_join, today);
    const joinYear = Number(String(recipient.data.date_of_join ?? '').slice(0, 4));
    const years = real ?? (joinYear ? Math.max(1, Number(today.slice(0, 4)) - joinYear) : 1);
    occasion = { kind: 'anniversary', years };
  } else {
    const settings = await loadGreetingSettings(db);
    const day = settings.special_days.find(d => d.id === String(body.dayId ?? '')) ?? settings.special_days[0];
    if (!day) return NextResponse.json({ error: 'Add a special day first' }, { status: 400 });
    occasion = {
      kind: 'special',
      dayId: day.id,
      title: day.title,
      message: day.message,
      title_si: day.title_si,
      message_si: day.message_si,
      title_ta: day.title_ta,
      message_ta: day.message_ta,
    };
  }

  const settingsForSigners = await loadGreetingSettings(db);
  // Same per-recipient resolution the cron uses, so a test card is signed by exactly the people
  // the real one would be.
  const flat = people.map(p => p.data);
  // Bound to a const because the closure below reads it: TypeScript drops the "not undefined"
  // narrowing of a `let` inside a callback, and `recipient` is one.
  const rec = recipient;
  const senders = selectSenders(
    rec.data, flat, roles, 8, resolveSigners(settingsForSigners, rec.data),
  );
  // Personal notes are part of what the real card would say, so the test shows them too — an
  // admin testing a card that omits the manager's own words has been shown the wrong card.
  const authored = messagesFor(rec.data, occasion, await loadGreetingMessages(db, { enabledOnly: true }), flat, roles)
    .map(msg => ({ msg, text: renderMessage(msg, rec.data, occasion, today) }))
    .filter(a => a.text);
  const signed = authored.length ? mergeSenders(senders, authored) : senders;
  const tenant = tenantForRequest(req);
  const result = await deliverGreeting(db, { brand: tenant.appName, originUrl: req.nextUrl.origin }, rec, occasion, signed, { claimMarker: false, test: true, today });
  if (result !== 'sent') return NextResponse.json({ error: 'Delivery failed — see server logs' }, { status: 500 });
  return NextResponse.json({ ok: true, name: String(rec.data.display_name ?? epf), senders: signed, occasion });
}
