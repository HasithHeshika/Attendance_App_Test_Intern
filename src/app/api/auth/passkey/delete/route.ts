import { NextRequest, NextResponse } from 'next/server';
import { adminAuth, adminDbFor } from '@/lib/firebaseAdmin';
import { CREDENTIALS_COLLECTION, credentialById, rpIdFromRequest } from '@/lib/webauthn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/passkey/delete — remove one of the CALLER'S OWN passkeys.
 *
 * The ownership check is the whole route: a credential id is not a secret (it travels in
 * every assertion), so without `stored.uid === uid` anyone could unregister anyone else's
 * key and lock them out of the sign-in method they rely on.
 *
 * Removing the last passkey is allowed. Password and OAuth sign-in are untouched by any of
 * this, so there is no way to strand an account by deleting one — and a person who has lost
 * the device needs to be able to remove its key precisely when it is their only one.
 */
export async function POST(req: NextRequest) {
  try {
    const rpId = rpIdFromRequest(req);
    if (!rpId) return NextResponse.json({ error: 'Unknown host' }, { status: 400 });

    const { idToken, credentialId } = await req.json().catch(() => ({}));
    if (!idToken || typeof idToken !== 'string' || typeof credentialId !== 'string' || !credentialId) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    let uid: string;
    try {
      uid = (await adminAuth().verifyIdToken(idToken, true)).uid;
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = adminDbFor(req);
    const stored = await credentialById(db, credentialId);
    // 404 for "not yours" as well as "not there" — otherwise the status code confirms that a
    // credential id belongs to somebody.
    if (!stored || stored.uid !== uid || stored.rp_id !== rpId) {
      return NextResponse.json({ error: 'NotFound' }, { status: 404 });
    }

    await db.collection(CREDENTIALS_COLLECTION).doc(credentialId).delete();
    return NextResponse.json({ deleted: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[passkey/delete]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
