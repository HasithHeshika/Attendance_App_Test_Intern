import { NextRequest, NextResponse } from 'next/server';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { verifySignedInCaller } from '@/lib/adminCaller';
import { loadPeopleAndRoles } from '@/lib/greetingsServer';
import { fullNameOf, type PersonLite } from '@/lib/greetings';
import { subordinateEpfsOf } from '@/lib/greetingMessages';
import { resolveCapabilities } from '@/lib/permissions';
import { sendServerPush } from '@/lib/serverPush';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The notification composer's server side — who a person may write to, and the write itself.
 *
 * The composer used to write straight to Firestore from the browser and then call /api/notify
 * for the push. That route can only ever gate the PUSH: by the time it runs, the bell entry has
 * already landed in the recipient's inbox, and rules cannot help either because every can*()
 * helper in firestore.rules reduces to isAuth(). So "message my team" had no enforcement at all
 * — any signed-in employee could write a notification to anyone in the company.
 *
 * Both halves now live here. GET answers what this caller may do; POST does it, re-deriving the
 * caller's reach from the verified token and refusing anything outside it. Two powers that one
 * `can_send_notifications` flag used to conflate are now separate:
 *
 *   · Everyone      — the whole company. Needs can_send_notifications (or system admin).
 *   · My team       — the caller's transitive supervisor closure. Needs at least one report.
 *   · Selected      — hand-picked, and every pick must be inside the reach above.
 */

/** Who a composed notification is addressed to. */
export type ComposeAudience = 'all' | 'my_team' | 'selected';

function bearer(req: NextRequest): string {
  const header = req.headers.get('authorization') ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

const isActive = (p: PersonLite) => p.is_active !== false;

interface Ctx {
  epf: string;
  name: string;
  me: PersonLite;
  people: Array<{ ref: FirebaseFirestore.DocumentReference; data: PersonLite & FirebaseFirestore.DocumentData }>;
  /** May address the whole company. */
  mayBroadcast: boolean;
  /** The EPFs this caller may write to, whatever audience they pick. */
  reach: Set<string>;
  team: Set<string>;
}

async function context(req: NextRequest, idToken: unknown): Promise<Ctx | null> {
  const db = adminDbFor(req);
  const caller = await verifySignedInCaller(db, idToken);
  if (!caller) return null;

  const { people, roles } = await loadPeopleAndRoles(db);
  const flat = people.map(p => p.data);
  const me = flat.find(p => String(p.epf_number ?? '').trim() === caller.epf);
  if (!me) return null;

  // The capability comes from the role document, resolved exactly as /api/notify resolves it —
  // trainee overrides included — so the two routes cannot disagree about who may broadcast.
  const roleDoc = roles.find(r => r.name === me.role);
  const caps = resolveCapabilities(roleDoc as never, (me as { employee_type?: string }).employee_type);
  const mayBroadcast = !!(caps.is_system_admin || caps.can_send_notifications || caller.systemAdmin);

  const team = new Set(
    [...subordinateEpfsOf(caller.epf, flat)]
      .filter(epf => flat.some(p => String(p.epf_number ?? '').trim() === epf && isActive(p))),
  );
  const reach = mayBroadcast
    ? new Set(flat.filter(p => isActive(p) && String(p.epf_number ?? '').trim())
      .map(p => String(p.epf_number).trim()))
    : team;

  return { epf: caller.epf, name: fullNameOf(me) || caller.name, me, people, mayBroadcast, reach, team };
}

function audiencesOf(ctx: Ctx): ComposeAudience[] {
  const out: ComposeAudience[] = [];
  if (ctx.mayBroadcast) out.push('all');
  if (ctx.team.size > 0) out.push('my_team');
  // Nothing to select from means no Selected option — an empty picker is not a choice.
  if (ctx.reach.size > 0) out.push('selected');
  return out;
}

export async function GET(req: NextRequest) {
  // Header, never `?idToken=`: a URL is written to the access log, the browser history and any
  // Referer the page sends, and an ID token is a live credential.
  const ctx = await context(req, bearer(req));
  if (!ctx) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const allowed = audiencesOf(ctx);
  return NextResponse.json({
    allowed,
    reach: {
      all: ctx.mayBroadcast
        ? ctx.people.filter(p => isActive(p.data) && String(p.data.epf_number ?? '') !== ctx.epf).length
        : 0,
      my_team: ctx.team.size,
    },
    // Only the people this caller may write to. A picker that offers someone the POST would
    // refuse is the same lie told twice.
    people: ctx.people
      .filter(p => ctx.reach.has(String(p.data.epf_number ?? '').trim())
        && String(p.data.epf_number ?? '').trim() !== ctx.epf)
      .map(p => ({ epf: String(p.data.epf_number), name: fullNameOf(p.data), role: p.data.role ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    // Type selection and the approver broadcast are company-wide concerns; a team lead sending
    // five people a note does not need them, and the composer hides them accordingly.
    may_broadcast: ctx.mayBroadcast,
  });
}

interface Body {
  idToken?: unknown;
  audience?: unknown;
  toEpfs?: unknown;
  title?: unknown;
  body?: unknown;
  link?: unknown;
  /** ISO timestamp. Present means queue it instead of sending now. */
  sendAt?: unknown;
}

export async function POST(req: NextRequest) {
  const db = adminDbFor(req);
  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }

  const ctx = await context(req, body.idToken);
  if (!ctx) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const audience = body.audience === 'all' || body.audience === 'my_team' || body.audience === 'selected'
    ? body.audience as ComposeAudience
    : null;
  if (!audience) return NextResponse.json({ error: 'Pick who this is for' }, { status: 400 });
  if (!audiencesOf(ctx).includes(audience)) {
    return NextResponse.json({ error: 'You cannot send to that audience' }, { status: 403 });
  }

  const title = String(body.title ?? '').trim().slice(0, 200);
  const text  = String(body.body ?? '').trim().slice(0, 500);
  if (!title || !text) return NextResponse.json({ error: 'Add a title and a message' }, { status: 400 });
  const rawLink = String(body.link ?? '').trim();
  const link = rawLink.startsWith('/') ? rawLink.slice(0, 300) : null;   // in-app paths only

  // Who it actually goes to. 'all' stays a single broadcast document (that is what the bell
  // subscribes to); the other two expand to one direct document each.
  let epfs: string[] = [];
  if (audience === 'my_team') {
    epfs = [...ctx.team];
  } else if (audience === 'selected') {
    const asked = [...new Set(
      (Array.isArray(body.toEpfs) ? body.toEpfs : []).map(x => String(x ?? '').trim()).filter(Boolean),
    )];
    if (!asked.length) return NextResponse.json({ error: 'Pick at least one person' }, { status: 400 });
    const outside = asked.filter(e => !ctx.reach.has(e));
    if (outside.length) {
      // Counted, not named: the caller may not write to these people and does not need to be
      // told who they are.
      return NextResponse.json(
        { error: `${outside.length} of those people are not yours to write to` },
        { status: 403 },
      );
    }
    epfs = asked;
  }
  // Nobody writes to themselves.
  epfs = epfs.filter(e => e !== ctx.epf);
  if (audience !== 'all' && !epfs.length) {
    return NextResponse.json({ error: 'No recipients' }, { status: 400 });
  }

  // ── Scheduled for later: one pending document the dispatch cron picks up ──
  const sendAtRaw = String(body.sendAt ?? '').trim();
  if (sendAtRaw) {
    const at = new Date(sendAtRaw);
    if (Number.isNaN(at.getTime())) return NextResponse.json({ error: 'Bad send time' }, { status: 400 });
    if (at.getTime() <= Date.now()) return NextResponse.json({ error: 'Pick a future date and time' }, { status: 400 });
    // The reach was checked above and the recipient list is FROZEN here, so the cron delivers
    // exactly the audience the sender was allowed to address at the moment they pressed send.
    await db.collection('scheduled_notifications').add({
      audience:        audience === 'all' ? 'all' : null,
      to_epfs:         audience === 'all' ? null : epfs,
      title, body: text, link,
      send_at:         Timestamp.fromDate(at),
      status:          'pending',
      actor_epf:       ctx.epf,
      actor_name:      ctx.name,
      recipient_count: audience === 'all' ? 0 : epfs.length,
      created_at:      FieldValue.serverTimestamp(),
      updated_at:      FieldValue.serverTimestamp(),
      sent_at:         null,
      error:           null,
    });
    return NextResponse.json({ ok: true, scheduled: true, recipients: audience === 'all' ? 0 : epfs.length });
  }

  // ── Send now ──
  const common = {
    type: 'announcement',
    actor_epf: ctx.epf,
    actor_name: ctx.name,
    title, body: text, link,
    read: false,
    created_at: FieldValue.serverTimestamp(),
  };

  const col = db.collection('notifications');
  let docId = '';
  if (audience === 'all') {
    const ref = await col.add({ ...common, to_epf: null, audience: 'all', meta: { broadcast: '1' } });
    docId = ref.id;
  } else {
    // Batched, so a partial fan-out cannot leave half a team notified and half not. Firestore
    // caps a batch at 500 writes, hence the chunking for a very large team.
    for (let i = 0; i < epfs.length; i += 450) {
      const batch = db.batch();
      for (const epf of epfs.slice(i, i + 450)) {
        const ref = col.doc();
        if (!docId) docId = ref.id;
        batch.set(ref, { ...common, to_epf: epf, audience: null, meta: {} });
      }
      await batch.commit();
    }
  }

  // Push, best-effort — the bell entries above are the reliable delivery and have already landed.
  const recipientDocs = ctx.people.filter(p => {
    const epf = String(p.data.epf_number ?? '').trim();
    if (epf === ctx.epf || !isActive(p.data)) return false;
    return audience === 'all' ? true : epfs.includes(epf);
  });
  const pushed = await sendServerPush(recipientDocs, {
    type: 'announcement', title, body: text, link: link ?? '/dashboard',
    tag: docId || `announce-${ctx.epf}`, originUrl: req.nextUrl.origin,
  }).catch(() => 0);

  return NextResponse.json({
    ok: true,
    recipients: audience === 'all' ? recipientDocs.length : epfs.length,
    pushed,
  });
}
