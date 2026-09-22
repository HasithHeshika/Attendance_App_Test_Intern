import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { verifySignedInCaller, type SignedInCaller } from '@/lib/adminCaller';
import {
  loadGreetingMessages, loadGreetingSettings, loadPeopleAndRoles, normalizeGreetingMessage,
} from '@/lib/greetingsServer';
import { fullNameOf, type OccasionKind, type PersonLite, type RoleLite } from '@/lib/greetings';
import {
  allowedAudiencesFor, canAuthor, reachOf, targetablePeopleOf,
  GREETING_MESSAGE_MAX, GREETING_VARIANTS_MAX, isGreetingAudience,
  type GreetingAudience, type GreetingMessage,
} from '@/lib/greetingMessages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Personal greeting messages — the words a manager writes for the people under them, attached
 * by the daily job to the greeting those people receive.
 *
 * Not a client-writable collection, and not for the reason most of this app's routes exist:
 * every `can*()` helper in firestore.rules reduces to isAuth() (no custom claims are minted),
 * so a writable `greeting_messages` would let any signed-in employee publish a greeting signed
 * "from the CEO" to all 300 of their colleagues. Authorship is therefore decided here, from a
 * verified token and the org's supervisor tree, on every single write — never from the body.
 *
 * GET  (Authorization: Bearer <idToken>) — everything the composer needs in one round trip.
 *      ?target=<epf> narrows `messages` to the caller's own note for that person.
 * POST — create or update one message. The author is the token holder, full stop.
 */

const OCCASION_KINDS: readonly OccasionKind[] = ['birthday', 'anniversary', 'special'];

/** One author's messages stay a handful; this only exists so a loop cannot fill a collection. */
const MAX_PER_AUTHOR = 50;

function bearer(req: NextRequest): string {
  const header = req.headers.get('authorization') ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

function personOf(epf: string, people: PersonLite[]): PersonLite | undefined {
  return people.find(p => String(p.epf_number ?? '').trim() === epf);
}

interface Ctx {
  caller: SignedInCaller;
  me: PersonLite;
  people: PersonLite[];
  roles: RoleLite[];
}

/** The caller as the pure engine sees them: their real user doc, not the token's claims. */
async function context(req: NextRequest, idToken: unknown): Promise<Ctx | null> {
  const db = adminDbFor(req);
  const caller = await verifySignedInCaller(db, idToken);
  if (!caller) return null;
  const { people, roles } = await loadPeopleAndRoles(db);
  const flat = people.map(p => p.data);
  const me = personOf(caller.epf, flat);
  if (!me) return null;
  return { caller, me, people: flat, roles };
}

/** A stored message plus the two things only the server can work out. */
function decorate(m: GreetingMessage, ctx: Ctx): GreetingMessage & { reach: number; target_name: string | null } {
  const target = m.target_epf ? personOf(m.target_epf, ctx.people) : undefined;
  return {
    ...m,
    reach: reachOf(m.audience, ctx.me, m.target_epf, ctx.people),
    target_name: target ? fullNameOf(target) : (m.target_epf || null),
  };
}

export async function GET(req: NextRequest) {
  const db = adminDbFor(req);
  // Header, never `?idToken=`: a URL is written to the access log, the browser history and any
  // Referer the page sends, and an ID token is a live credential for the whole session.
  const ctx = await context(req, bearer(req));
  if (!ctx) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const authorCtx = { systemAdmin: ctx.caller.systemAdmin };
  const allowed = allowedAudiencesFor(ctx.me, ctx.people, ctx.roles, authorCtx);
  const target = (req.nextUrl.searchParams.get('target') ?? '').trim();

  const [settings, mine] = await Promise.all([
    loadGreetingSettings(db),
    loadGreetingMessages(db, { authorEpf: ctx.caller.epf }),
  ]);

  const messages = (target ? mine.filter(m => m.audience === 'person' && m.target_epf === target) : mine)
    .map(m => decorate(m, ctx))
    // Ordering by creation would need an index this collection does not have, so it is ordered
    // by how specific each message is — which is also the order a recipient's card resolves.
    .sort((a, b) => a.audience.localeCompare(b.audience)
      || (a.target_name ?? '').localeCompare(b.target_name ?? ''));

  return NextResponse.json({
    me: { epf: ctx.caller.epf, name: ctx.caller.name, role: ctx.caller.role },
    allowed,
    reach: {
      everyone: allowed.includes('everyone') ? reachOf('everyone', ctx.me, null, ctx.people) : 0,
      my_team: allowed.includes('my_team') ? reachOf('my_team', ctx.me, null, ctx.people) : 0,
    },
    messages,
    // Only the people this caller may write to, so the picker cannot offer someone the POST
    // would then refuse.
    people: allowed.includes('person')
      ? targetablePeopleOf(ctx.me, ctx.people, ctx.roles, authorCtx)
        .map(p => ({ epf: String(p.epf_number), name: fullNameOf(p), role: p.role ?? '' }))
        .sort((a, b) => a.name.localeCompare(b.name))
      : [],
    special_days: (settings.special_days ?? [])
      .filter(d => d.enabled && d.id)
      .map(d => ({ id: d.id, title: d.title })),
    // The master switch lives in system settings. A manager who writes a note deserves to be
    // told plainly that nothing will be sent while it is off.
    greetings_enabled: settings.enabled === true,
  });
}

interface Body {
  idToken?: unknown;
  id?: unknown;
  audience?: unknown;
  target_epf?: unknown;
  occasions?: unknown;
  special_day_ids?: unknown;
  message?: unknown;
  message_si?: unknown;
  message_ta?: unknown;
  messages?: unknown;
  enabled?: unknown;
}

export async function POST(req: NextRequest) {
  const db = adminDbFor(req);
  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }

  const ctx = await context(req, body.idToken);
  if (!ctx) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const audience: GreetingAudience | null = isGreetingAudience(body.audience) ? body.audience : null;
  if (!audience) return NextResponse.json({ error: 'Pick who this greeting is for' }, { status: 400 });

  const targetEpf = audience === 'person' ? String(body.target_epf ?? '').trim() : '';
  if (audience === 'person' && !targetEpf) {
    return NextResponse.json({ error: 'Pick the person this greeting is for' }, { status: 400 });
  }
  if (targetEpf && !personOf(targetEpf, ctx.people)) {
    return NextResponse.json({ error: 'That person is not in this system' }, { status: 400 });
  }

  // The whole permission model, in one call, on the server, from the verified identity.
  if (!canAuthor(ctx.me, audience, targetEpf || null, ctx.people, ctx.roles, { systemAdmin: ctx.caller.systemAdmin })) {
    return NextResponse.json({ error: 'You cannot write a greeting for that audience' }, { status: 403 });
  }

  const occasions = (Array.isArray(body.occasions) ? body.occasions : [])
    .map(x => String(x ?? ''))
    .filter((x): x is OccasionKind => (OCCASION_KINDS as readonly string[]).includes(x));
  if (!occasions.length) return NextResponse.json({ error: 'Pick at least one occasion' }, { status: 400 });

  const specialDayIds = occasions.includes('special')
    ? [...new Set((Array.isArray(body.special_day_ids) ? body.special_day_ids : [])
      .map(x => String(x ?? '').trim()).filter(Boolean))].slice(0, 50)
    : [];

  // Wordings, per occasion. A client may still post a single `message` string (the shape before
  // wordings were per-occasion); it is expanded here onto exactly the occasions this row is
  // ticked for, so an old client and a new one write the same document.
  const rawMessages = (body.messages && typeof body.messages === 'object' && !Array.isArray(body.messages))
    ? body.messages as Record<string, unknown>
    : null;

  const messages: Record<string, string[]> = {};
  const allowedSlots = new Set<string>([
    ...occasions.filter(o => o !== 'special'),
    ...(occasions.includes('special')
      ? (specialDayIds.length ? specialDayIds.map(id => `special:${id}`) : ['special'])
      : []),
  ]);

  if (rawMessages) {
    for (const [slot, value] of Object.entries(rawMessages)) {
      // A wording for an occasion this row is not ticked for would never be read and would
      // quietly resurrect if the author re-ticked it later. Drop it at the door.
      if (!allowedSlots.has(slot)) continue;
      const lines: string[] = [];
      for (const raw of (Array.isArray(value) ? value : [value])) {
        const line = String(raw ?? '').trim();
        if (!line || lines.includes(line)) continue;
        if (line.length > GREETING_MESSAGE_MAX) {
          return NextResponse.json({ error: `Keep each wording under ${GREETING_MESSAGE_MAX} characters` }, { status: 400 });
        }
        lines.push(line);
        if (lines.length >= GREETING_VARIANTS_MAX) break;
      }
      if (lines.length) messages[slot] = lines;
    }
  } else {
    const single = String(body.message ?? '').trim();
    if (!single) return NextResponse.json({ error: 'Write your message' }, { status: 400 });
    if (single.length > GREETING_MESSAGE_MAX) {
      return NextResponse.json({ error: `Keep the message under ${GREETING_MESSAGE_MAX} characters` }, { status: 400 });
    }
    for (const slot of allowedSlots) messages[slot] = [single];
  }

  if (!Object.keys(messages).length) {
    return NextResponse.json({ error: 'Write your message' }, { status: 400 });
  }

  const col = db.collection('greeting_messages');
  const id = String(body.id ?? '').trim();

  // Which document is being written. An explicit id is an edit and must belong to the caller;
  // a person message with no id replaces that person's existing note rather than adding a
  // second one, because every surface presents it as "your note for them", singular.
  let ref = id ? col.doc(id) : null;
  let isNew = false;
  if (ref) {
    const snap = await ref.get();
    const existing = snap.exists ? normalizeGreetingMessage(snap.id, snap.data() ?? {}) : null;
    if (!existing) return NextResponse.json({ error: 'That greeting no longer exists' }, { status: 404 });
    if (existing.author_epf !== ctx.caller.epf && !ctx.caller.systemAdmin) {
      return NextResponse.json({ error: 'That greeting belongs to someone else' }, { status: 403 });
    }
  } else if (audience === 'person') {
    const mine = await loadGreetingMessages(db, { authorEpf: ctx.caller.epf });
    const dup = mine.find(m => m.audience === 'person' && m.target_epf === targetEpf);
    if (dup) ref = col.doc(dup.id);
  }

  if (!ref) {
    const mine = await loadGreetingMessages(db, { authorEpf: ctx.caller.epf });
    if (mine.length >= MAX_PER_AUTHOR) {
      return NextResponse.json({ error: 'You already have the maximum number of greetings' }, { status: 400 });
    }
    ref = col.doc();
    isNew = true;
  }

  const messageSi = typeof body.message_si === 'string' ? body.message_si.trim().slice(0, GREETING_MESSAGE_MAX) : '';
  const messageTa = typeof body.message_ta === 'string' ? body.message_ta.trim().slice(0, GREETING_MESSAGE_MAX) : '';

  // The author's name, role and avatar are snapshotted here and refreshed on every edit, so a
  // card signed last year still reads correctly after a promotion — and so the card never has
  // to read the users collection to render a signature.
  const doc = {
    author_epf: ctx.caller.epf,
    author_name: fullNameOf(ctx.me) || ctx.caller.name,
    author_role: ctx.me.role ?? ctx.caller.role,
    author_avatar_url: ctx.me.avatar_url ?? ctx.caller.avatar_url ?? null,
    audience,
    target_epf: audience === 'person' ? targetEpf : null,
    occasions,
    special_day_ids: specialDayIds,
    messages,
    // merge:true keeps fields this object does not name, so a row that still carries the old
    // single string must have it cleared explicitly — otherwise normalizeMessages would keep
    // reading a wording the author has already replaced.
    message: FieldValue.delete(),
    message_si: messageSi ? messageSi : FieldValue.delete(),
    message_ta: messageTa ? messageTa : FieldValue.delete(),
    enabled: body.enabled !== false,
    updated_at: FieldValue.serverTimestamp(),
    // Only on the way in. Re-sending it on an edit would quietly re-date the message to now,
    // and "written on" is the one fact about a greeting nobody can reconstruct afterwards.
    ...(isNew ? { created_at: FieldValue.serverTimestamp() } : {}),
  };
  // mergeFields, not merge:true. Both leave fields this object does not name alone, but
  // merge:true DEEP-merges the maps it does name, and `messages` is a map. Save a note for two
  // named festivals and then re-save it as "every special day" and the stored document kept
  // 'special:a' and 'special:b' beside the new 'special' slot — special_day_ids was now empty,
  // so the note applied to every festival, and slotsFor() reads the day-specific slot FIRST.
  // On those two days the recipient went on reading a wording the author had replaced months
  // ago, with nothing in any screen showing that the slot still existed. Naming the fields
  // replaces `messages` whole, which is what "dropped at the door" above always meant.
  await ref.set(doc, { mergeFields: Object.keys(doc) });

  const saved = normalizeGreetingMessage(ref.id, {
    ...doc,
    // `doc.message` is a FieldValue.delete() sentinel, and String()-ing one yields the literal
    // "[object Object]" — which came straight back as the note's text. The stored document has
    // no `message` at all, so echo it as absent.
    message: undefined,
    message_si: messageSi || undefined,
    message_ta: messageTa || undefined,
  });
  return NextResponse.json({ ok: true, message: saved ? decorate(saved, ctx) : null });
}
