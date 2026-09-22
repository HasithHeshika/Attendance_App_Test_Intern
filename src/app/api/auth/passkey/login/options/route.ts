import { NextRequest, NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { checkRateLimit, clientIp } from '@/lib/rateLimit';
import { putChallenge, rpIdFromRequest, sweepExpiredChallenges } from '@/lib/webauthn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cheap for the server, so the limit is generous enough that a shared office IP never trips
// it, and tight enough that nobody can farm challenges to keep the collection growing.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 60;

/**
 * POST /api/auth/passkey/login/options — issue a sign-in challenge. No identifier required.
 *
 * `allowCredentials` is deliberately EMPTY. The passkeys are discoverable (residentKey
 * 'required' at enrolment), so the device already knows which accounts it holds for this RP
 * and shows the person their own list. Filling in allowCredentials would mean asking who you
 * are before you have proved it — which turns this endpoint into an account-existence oracle
 * for anyone who wants to enumerate staff email addresses.
 *
 * Unauthenticated by nature: this runs before anyone is signed in. It reveals nothing — the
 * challenge is random bytes and is useless without a private key the server never sees.
 */
export async function POST(req: NextRequest) {
  try {
    const rpId = rpIdFromRequest(req);
    if (!rpId) return NextResponse.json({ error: 'Unknown host' }, { status: 400 });

    const db = adminDbFor(req);
    const retryAfterMs = await checkRateLimit(
      db, 'passkey_login_options', clientIp(req), RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX,
    );
    if (retryAfterMs > 0) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } },
      );
    }

    void sweepExpiredChallenges(db);

    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: 'preferred',
    });
    const handle = await putChallenge(db, 'authentication', options.challenge, rpId, null);
    return NextResponse.json({ options, handle }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[passkey/login/options]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
