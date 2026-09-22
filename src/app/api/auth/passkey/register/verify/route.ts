import { NextRequest, NextResponse } from 'next/server';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminAuth, adminDbFor } from '@/lib/firebaseAdmin';
import {
  CREDENTIALS_COLLECTION, MAX_CREDENTIALS_PER_USER, credentialsForUid,
  deviceLabelFromUserAgent, expectedOriginFromRequest, rpIdFromRequest, sanitiseLabel,
  sanitiseVisitorId, takeChallenge, toSummary, type StoredCredential,
} from '@/lib/webauthn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/passkey/register/verify — finish enrolling a passkey for the CALLER.
 *
 * The uid is taken from the ID token AND cross-checked against the uid the challenge was
 * issued to (takeChallenge's last argument). Both must agree, so a token swapped between the
 * two calls cannot land somebody else's key on this account, or this account's key on theirs.
 */
export async function POST(req: NextRequest) {
  try {
    const rpId = rpIdFromRequest(req);
    const origin = expectedOriginFromRequest(req);
    if (!rpId || !origin) return NextResponse.json({ error: 'Unknown host' }, { status: 400 });

    const body = await req.json().catch(() => ({}));
    const { idToken, handle, response } = body ?? {};
    if (!idToken || typeof idToken !== 'string' || !response) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    let uid: string;
    try {
      uid = (await adminAuth().verifyIdToken(idToken, true)).uid;
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = adminDbFor(req);
    const expectedChallenge = await takeChallenge(db, handle, 'registration', rpId, uid);
    if (!expectedChallenge) {
      return NextResponse.json({ error: 'ChallengeExpired' }, { status: 400 });
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        // Not required: on a laptop with no biometric the platform may only prove presence,
        // and refusing that would lock out the very people this is meant to make sign-in
        // easier for. The password path is unchanged and no capability rests on the passkey
        // alone — the account's own claims still decide everything after sign-in.
        requireUserVerification: false,
      });
    } catch (e) {
      console.warn('[passkey/register/verify] rejected', e);
      return NextResponse.json({ error: 'VerificationFailed' }, { status: 400 });
    }
    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json({ error: 'VerificationFailed' }, { status: 400 });
    }

    // Re-check the cap AFTER verification: the options route checked it too, but two tabs
    // could both pass that check and only one of them is racing to write here.
    const existing = await credentialsForUid(db, uid, rpId);
    if (existing.length >= MAX_CREDENTIALS_PER_USER) {
      return NextResponse.json({ error: 'TooManyCredentials' }, { status: 409 });
    }

    const info = verification.registrationInfo;
    const credentialId = info.credential.id;

    // A credential id is globally unique, so an existing document under this id belongs to
    // whoever enrolled it first. Overwriting it would re-point a key at a different account.
    const ref = db.collection(CREDENTIALS_COLLECTION).doc(credentialId);
    if ((await ref.get()).exists) {
      return NextResponse.json({ error: 'AlreadyRegistered' }, { status: 409 });
    }

    const userSnap = await db.collection('users').where('uid', '==', uid).limit(1).get();
    const epf = userSnap.empty ? '' : String(userSnap.docs[0].data().epf_number ?? '');

    const record: Omit<StoredCredential, 'created_at' | 'last_used_at'> = {
      credential_id: credentialId,
      public_key: Buffer.from(info.credential.publicKey).toString('base64url'),
      counter: info.credential.counter,
      transports: Array.isArray(info.credential.transports) ? info.credential.transports : [],
      uid,
      epf_number: epf,
      rp_id: rpId,
      label: sanitiseLabel(body.label) ?? deviceLabelFromUserAgent(req.headers.get('user-agent')),
      visitor_id: sanitiseVisitorId(body.visitorId),
      backed_up: info.credentialBackedUp === true,
      aaguid: String(info.aaguid ?? ''),
    };
    await ref.set({ ...record, created_at: FieldValue.serverTimestamp(), last_used_at: null });

    return NextResponse.json(
      { credential: toSummary({ ...record, created_at: Timestamp.now(), last_used_at: null }) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    console.error('[passkey/register/verify]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
