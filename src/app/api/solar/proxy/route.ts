import { NextRequest, NextResponse } from 'next/server';
import { adminAuth, adminDbFor } from '@/lib/firebaseAdmin';
import { solarRaw } from '@/lib/solarApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Admin-only generic proxy for the Solar external API — powers the API Playground.
 * Verifies the caller is a System Admin, restricts the target to `/api/external/*`
 * (no SSRF), and forwards with the server-held EXTERNAL_API_KEY (never client-side).
 */
export async function POST(req: NextRequest) {
  try {
    const { idToken, path, method, query, body } = await req.json().catch(() => ({}));
    if (!idToken || !path) {
      return NextResponse.json({ error: 'Missing idToken or path' }, { status: 400 });
    }
    if (typeof path !== 'string' || !path.startsWith('/api/external/')) {
      return NextResponse.json({ error: 'Only /api/external/* paths are allowed' }, { status: 403 });
    }

    // Authenticate the caller as a System Admin via Firebase Admin.
    //
    // This used to fall through to "allow" when the FIREBASE_ADMIN_* service-account creds
    // were absent and NODE_ENV was not 'production' — the local dev machine being trusted.
    // That is one mis-set environment variable away from an unauthenticated admin proxy
    // holding the server's EXTERNAL_API_KEY, on a route whose whole job is to make
    // authenticated calls to another system. There is no configuration of this route that
    // now skips the check: unconfigured means refused, everywhere.
    const adminConfigured = !!(
      process.env.FIREBASE_ADMIN_PROJECT_ID &&
      process.env.FIREBASE_ADMIN_CLIENT_EMAIL &&
      process.env.FIREBASE_ADMIN_PRIVATE_KEY
    );
    if (!adminConfigured) {
      return NextResponse.json(
        { error: 'Server not configured: set FIREBASE_ADMIN_* to enable admin verification.' },
        { status: 500 },
      );
    }

    let uid: string;
    try {
      uid = (await adminAuth().verifyIdToken(idToken)).uid;
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = adminDbFor(req);
    const userSnap = await db.collection('users').where('uid', '==', uid).limit(1).get();
    const role = userSnap.empty ? null : userSnap.docs[0].data().role;
    const roleSnap = role ? await db.collection('roles').where('name', '==', role).limit(1).get() : null;
    const roleData = roleSnap && !roleSnap.empty ? roleSnap.docs[0].data() : null;
    if (!roleData?.is_system_admin) {
      return NextResponse.json({ error: 'Admins only' }, { status: 403 });
    }

    const result = await solarRaw(path, { method, query, body });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    // The upstream message can carry internal hostnames/paths from the Solar API — log it,
    // don't echo it.
    console.error('[solar/proxy]', e);
    return NextResponse.json({ error: 'Proxy error' }, { status: 502 });
  }
}
