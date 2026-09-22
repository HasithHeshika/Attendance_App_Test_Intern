import { NextRequest, NextResponse } from 'next/server';
import { adminAuth, adminDbFor } from '@/lib/firebaseAdmin';
import { credentialsForUid, rpIdFromRequest, toSummary } from '@/lib/webauthn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/passkey/list — the caller's own passkeys, for the profile page.
 *
 * POST rather than GET for two reasons: the ID token belongs in a body rather than a URL the
 * proxy logs, and serwist's defaultCache caches same-origin GETs under /api/ for 24h. This
 * path is already NetworkOnly by virtue of living under /api/auth/, but a device list that
 * could go stale is exactly the thing that makes someone believe a passkey they just deleted
 * is still there.
 *
 * Self-only: no targetUid. Public keys and counters never leave the server — see toSummary.
 */
export async function POST(req: NextRequest) {
  try {
    const rpId = rpIdFromRequest(req);
    if (!rpId) return NextResponse.json({ error: 'Unknown host' }, { status: 400 });

    const { idToken } = await req.json().catch(() => ({}));
    if (!idToken || typeof idToken !== 'string') {
      return NextResponse.json({ error: 'Missing idToken' }, { status: 400 });
    }

    let uid: string;
    try {
      uid = (await adminAuth().verifyIdToken(idToken, true)).uid;
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const creds = await credentialsForUid(adminDbFor(req), uid, rpId);
    creds.sort((a, b) => {
      const at = a.created_at?.toMillis?.() ?? 0;
      const bt = b.created_at?.toMillis?.() ?? 0;
      return bt - at;
    });
    return NextResponse.json(
      { credentials: creds.map(toSummary) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    console.error('[passkey/list]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
