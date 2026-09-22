import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { verifySignedInCaller } from '@/lib/adminCaller';
import { normalizeGreetingMessage } from '@/lib/greetingsServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Delete one personal greeting message. Its own author, or a system admin cleaning up after
 * someone who has left.
 *
 * A POST rather than a DELETE for one reason: the ID token travels in the body. A DELETE has no
 * body to put it in, and a token in the query string is written to the access log, the browser
 * history and every outgoing Referer.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const db = adminDbFor(req);
  const { id } = await params;
  let body: { idToken?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }

  const caller = await verifySignedInCaller(db, body.idToken);
  if (!caller) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const ref = db.collection('greeting_messages').doc(id);
  const snap = await ref.get();
  // Already gone is the outcome the caller asked for, so it is not an error.
  if (!snap.exists) return NextResponse.json({ ok: true, deleted: false });

  const existing = normalizeGreetingMessage(snap.id, snap.data() ?? {});
  // A document too broken to read back is still deletable by an admin — refusing would leave
  // it in the collection with nothing able to remove it.
  const authorEpf = existing?.author_epf ?? String(snap.data()?.author_epf ?? '');
  if (authorEpf !== caller.epf && !caller.systemAdmin) {
    return NextResponse.json({ error: 'That greeting belongs to someone else' }, { status: 403 });
  }

  await ref.delete();
  return NextResponse.json({ ok: true, deleted: true });
}
