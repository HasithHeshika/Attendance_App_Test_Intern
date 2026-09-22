import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { FieldValue } from 'firebase-admin/firestore';
import { adminAuth, adminDbFor, tenantForRequest } from '@/lib/firebaseAdmin';
import { checkRateLimit, clientIp } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_TENANT_ID = 'altavision';
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 30;
/** Redeemed handoff tokens, keyed by jti. Swept by the maintenance-lifecycle cron. */
const REDEMPTIONS = 'logpup_sso_redemptions';

/**
 * POST /api/auth/logpup-sso — redeem a LogPup-signed handoff token for a Firebase session.
 *
 * The second place in this app that calls `createCustomToken`; the passkey login verify route
 * (src/app/api/auth/passkey/login/verify/route.ts) is the other, and its header describes the
 * same mechanism: Firebase Auth has no provider for this, so an external proof is verified here
 * and exchanged for a custom token the browser hands to `signInWithCustomToken`.
 *
 * THE CUSTOM TOKEN CARRIES NO CLAIMS, exactly as in that route and for the same reason: claims
 * come from Firestore via /api/auth/claims, and a route that could stamp them here would be a
 * second, weaker source of truth for every permission in firestore.rules. LogPup does not send a
 * role, and if it ever did it would be ignored.
 *
 * A HANDOFF IS A CONVENIENCE, NEVER A WAY IN. Nothing is provisioned: the email must already
 * match an active employee. An address LogPup knows and this app does not is refused.
 */
export async function POST(req: NextRequest) {
  try {
    if (tenantForRequest(req).id !== ALLOWED_TENANT_ID) {
      return NextResponse.json({ error: 'Not available on this domain' }, { status: 403 });
    }

    const secret = process.env.LOGPUP_SSO_SECRET;
    if (!secret) return NextResponse.json({ error: 'SSO is not configured' }, { status: 500 });

    const db = adminDbFor(req);
    const retryAfterMs = await checkRateLimit(
      db, 'logpup_sso', clientIp(req), RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX,
    );
    if (retryAfterMs > 0) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } },
      );
    }

    const { token } = await req.json().catch(() => ({}));
    if (typeof token !== 'string' || !token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 });
    }

    let email: string;
    let jti: string;
    try {
      // ALGORITHM PINNED. A verifier that accepts whatever the token's own header claims will
      // accept `alg: none`, which is a signature check that verifies nothing.
      const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
        algorithms: ['HS256'],
      });
      email = String(payload.email ?? payload.sub ?? '').trim().toLowerCase();
      jti = String(payload.jti ?? '');
    } catch {
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 401 });
    }
    if (!email || !jti) {
      return NextResponse.json({ error: 'Invalid link' }, { status: 401 });
    }

    // REPLAY GUARD. create() fails if the document already exists, so the write IS the check —
    // two tabs opening the same link race in the database and only one can win. A read-then-
    // write would let both through.
    try {
      await db.collection(REDEMPTIONS).doc(jti).create({
        email,
        redeemed_at: FieldValue.serverTimestamp(),
        // Well past the token's own 3-minute life; the sweep only needs a bound, not precision.
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
      });
    } catch {
      return NextResponse.json({ error: 'This link has already been used' }, { status: 401 });
    }

    const snap = await db.collection('users').where('email', '==', email).limit(1).get();
    const u = snap.empty ? null : snap.docs[0].data();
    // No provisioning. An address LogPup knows and this app does not is simply not an employee
    // here, and a sign-in route is not the place to decide otherwise.
    if (!u) return NextResponse.json({ error: 'NotRegistered' }, { status: 403 });
    if (u.is_active === false || u.date_of_resign) {
      return NextResponse.json({ error: 'AccountInactive' }, { status: 403 });
    }
    if (!u.uid) return NextResponse.json({ error: 'NotRegistered' }, { status: 403 });

    const customToken = await adminAuth().createCustomToken(String(u.uid));
    return NextResponse.json({ token: customToken }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[auth/logpup-sso]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
