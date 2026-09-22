import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminAuth, adminDbFor } from '@/lib/firebaseAdmin';
import { checkRateLimit, clientIp } from '@/lib/rateLimit';
import {
  CREDENTIALS_COLLECTION, credentialById, expectedOriginFromRequest, rpIdFromRequest,
  takeChallenge,
} from '@/lib/webauthn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 30;

/**
 * POST /api/auth/passkey/login/verify — check an assertion and mint a Firebase session.
 *
 * One of the two places in the app that call `createCustomToken` (the other is
 * /api/auth/logpup-sso, which redeems a LogPup handoff token the same way), and it is the only
 * reason passkeys can produce a Firebase session at all: Firebase Auth has no WebAuthn provider,
 * so the assertion is verified here and exchanged for a custom token the browser then hands to
 * `signInWithCustomToken`. From that point everything is a perfectly ordinary session —
 * AuthProvider's onAuthStateChanged mints the capability claims exactly as it does after a
 * password or OAuth sign-in, so no capability is granted or bypassed by this route.
 *
 * The custom token carries no claims of its own. That is on purpose: claims come from
 * Firestore via /api/auth/claims, and a route that could stamp them here would be a second,
 * weaker source of truth for every permission in firestore.rules.
 */
export async function POST(req: NextRequest) {
  try {
    const rpId = rpIdFromRequest(req);
    const origin = expectedOriginFromRequest(req);
    if (!rpId || !origin) return NextResponse.json({ error: 'Unknown host' }, { status: 400 });

    const db = adminDbFor(req);
    const retryAfterMs = await checkRateLimit(
      db, 'passkey_login_verify', clientIp(req), RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX,
    );
    if (retryAfterMs > 0) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } },
      );
    }

    const body = await req.json().catch(() => ({}));
    const { handle, response } = body ?? {};
    if (!response || typeof response?.id !== 'string') {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const expectedChallenge = await takeChallenge(db, handle, 'authentication', rpId, null);
    if (!expectedChallenge) {
      return NextResponse.json({ error: 'ChallengeExpired' }, { status: 400 });
    }

    const stored = await credentialById(db, response.id);
    // Same generic answer for "no such credential" and "wrong domain": telling the two apart
    // would say whether a given credential id exists in this deployment.
    if (!stored || stored.rp_id !== rpId) {
      return NextResponse.json({ error: 'VerificationFailed' }, { status: 400 });
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: {
          id: stored.credential_id,
          publicKey: new Uint8Array(Buffer.from(stored.public_key, 'base64url')),
          counter: stored.counter ?? 0,
          transports: stored.transports,
        },
        requireUserVerification: false,
      });
    } catch (e) {
      console.warn('[passkey/login/verify] rejected', e);
      return NextResponse.json({ error: 'VerificationFailed' }, { status: 400 });
    }
    if (!verification.verified) {
      return NextResponse.json({ error: 'VerificationFailed' }, { status: 400 });
    }

    // The key is valid; the ACCOUNT still has to be. A resigned or deactivated employee whose
    // phone still holds a working passkey must not get a session — the password path refuses
    // them in finaliseLogin, and a second door that doesn't check would undo that.
    const userSnap = await db.collection('users').where('uid', '==', stored.uid).limit(1).get();
    if (userSnap.empty) return NextResponse.json({ error: 'NotRegistered' }, { status: 403 });
    const user = userSnap.docs[0].data();
    if (user.is_active === false || user.date_of_resign) {
      return NextResponse.json({ error: 'AccountInactive' }, { status: 403 });
    }

    await db.collection(CREDENTIALS_COLLECTION).doc(stored.credential_id).update({
      counter: verification.authenticationInfo.newCounter,
      last_used_at: FieldValue.serverTimestamp(),
      backed_up: verification.authenticationInfo.credentialBackedUp === true,
    });

    const token = await adminAuth().createCustomToken(stored.uid);
    return NextResponse.json({ token }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[passkey/login/verify]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
