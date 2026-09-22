import { NextRequest, NextResponse } from 'next/server';
import { SignJWT } from 'jose';
import { adminAuth, adminDbFor } from '@/lib/firebaseAdmin';

// Firebase Admin requires the Node runtime (not edge).
export const runtime = 'nodejs';

const SOLAR_URL = (process.env.SOLAR_APP_URL || 'https://solar.altavision.lk').replace(/\/$/, '');

/**
 * Solar App SSO — mints a short-lived, HS256-signed JWT the user carries to the Solar
 * app for automatic login.
 *
 * Security:
 *  • The caller is authenticated by their Firebase ID token (verified server-side); the
 *    identity in the JWT is derived from the authoritative Firestore profile, never from
 *    client-supplied claims.
 *  • The signing secret (ATTENDANCE_JWT_SECRET) lives only on the server.
 *  • The token expires in 5 minutes.
 *
 * Contract (per the Solar app's SSO docs): sign an HS256 JWT with claims
 *   { epf, email, name?, phone?, role?, exp } using the shared ATTENDANCE_JWT_SECRET,
 *   then redirect to  https://<solar>/sso/attendance?token=<jwt>&next=/
 */
export async function POST(req: NextRequest) {
  try {
    const secret = process.env.ATTENDANCE_JWT_SECRET;
    if (!secret) {
      return NextResponse.json({ error: 'SSO is not configured' }, { status: 500 });
    }

    const { idToken } = await req.json().catch(() => ({}));
    if (!idToken) {
      return NextResponse.json({ error: 'Missing idToken' }, { status: 400 });
    }

    // 1. Authenticate the caller via their Firebase ID token.
    let uid: string;
    let tokenEmail: string | undefined;
    try {
      const decoded = await adminAuth().verifyIdToken(idToken);
      uid = decoded.uid;
      tokenEmail = decoded.email ?? undefined;
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Resolve the authoritative profile (identity comes from Firestore, not the client).
    const snap = await adminDbFor(req).collection('users').where('uid', '==', uid).limit(1).get();
    const u = snap.empty ? null : snap.docs[0].data();
    if (!u || u.is_active === false) {
      return NextResponse.json({ error: 'Account not active' }, { status: 403 });
    }

    const name = u.display_name ?? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim();

    // 3. Mint the short-lived SSO token (claim shape per the Solar SSO docs).
    const token = await new SignJWT({
      epf:   String(u.epf_number ?? ''),
      email: u.email ?? tokenEmail ?? '',
      name,
      phone: u.phone_personal ?? '',
      role:  u.role ?? '',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(String(u.epf_number ?? uid))   // Solar creates attendance_<sub> for new users
      .setIssuedAt()
      .setExpirationTime('3m')                    // short replay window per the SSO docs
      .sign(new TextEncoder().encode(secret));

    const url = `${SOLAR_URL}/sso/attendance?token=${encodeURIComponent(token)}&next=/`;
    return NextResponse.json({ token, url });
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
