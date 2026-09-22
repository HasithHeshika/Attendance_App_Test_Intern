import { NextRequest, NextResponse } from 'next/server';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { adminAuth, adminDbFor } from '@/lib/firebaseAdmin';
import {
  MAX_CREDENTIALS_PER_USER, credentialsForUid, putChallenge, rpIdFromRequest,
  sweepExpiredChallenges,
} from '@/lib/webauthn';

// firebase-admin needs the Node runtime (not edge) — same note as every other route here.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/passkey/register/options — start enrolling a passkey for the CALLER.
 *
 * Self-only, exactly like /api/auth/claims: the uid comes from the verified ID token and
 * there is no `targetUid`, so this cannot mint an enrolment challenge for anybody else.
 * Nothing is stored against the account here — only a challenge, which is worthless on its
 * own; the credential appears when the browser answers it at ../verify.
 *
 * Everything WebAuthn lives under /api/auth/ deliberately: serwist's defaultCache treats
 * /api/auth/* as NetworkOnly, while every other same-origin GET under /api/ is cached
 * NetworkFirst for 24h. A cached challenge is a replay window.
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
    let email: string;
    try {
      // checkRevoked: a disabled or revoked session must not be able to bolt a new sign-in
      // method onto the account it is being locked out of.
      const decoded = await adminAuth().verifyIdToken(idToken, true);
      uid = decoded.uid;
      email = String(decoded.email ?? '');
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = adminDbFor(req);
    void sweepExpiredChallenges(db);

    const userSnap = await db.collection('users').where('uid', '==', uid).limit(1).get();
    if (userSnap.empty) return NextResponse.json({ error: 'No profile' }, { status: 403 });
    const user = userSnap.docs[0].data();
    const epf = String(user.epf_number ?? '');
    const displayName = String(user.display_name ?? `${user.first_name ?? ''} ${user.last_name ?? ''}`).trim();

    const existing = await credentialsForUid(db, uid, rpId);
    if (existing.length >= MAX_CREDENTIALS_PER_USER) {
      return NextResponse.json({ error: 'TooManyCredentials' }, { status: 409 });
    }

    const options = await generateRegistrationOptions({
      rpName: 'Attendance',
      rpID: rpId,
      // The uid, not the EPF: this is what the authenticator stores as the account handle, and
      // it must be the thing sign-in resolves to. Firebase uids are already opaque and stable.
      userID: new TextEncoder().encode(uid),
      userName: email || epf || uid,
      userDisplayName: displayName || email || epf,
      attestationType: 'none',
      // Already-enrolled keys, so the authenticator says "you have one of these" instead of
      // silently minting a duplicate the person then has to work out how to delete.
      excludeCredentials: existing.map(c => ({ id: c.credential_id, transports: c.transports })),
      authenticatorSelection: {
        // Discoverable, because sign-in offers no identifier first — the person taps the
        // button and picks an account from their own device. A non-discoverable key would
        // need the username typed first, which is most of what passkeys are here to remove.
        residentKey: 'required',
        userVerification: 'preferred',
      },
    });

    const handle = await putChallenge(db, 'registration', options.challenge, rpId, uid);
    return NextResponse.json({ options, handle }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[passkey/register/options]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
