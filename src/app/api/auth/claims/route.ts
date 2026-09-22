import { NextRequest, NextResponse } from 'next/server';
import { adminAuth, adminDbFor } from '@/lib/firebaseAdmin';
import { syncCapabilityClaims } from '@/lib/authClaims';

// firebase-admin needs the Node runtime (not edge) — same note as every other route here.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/claims — mint the caller's capability claims onto their own Auth token.
 *
 * This is what makes firestore.rules enforceable: the rules read `claims().is_system_admin`
 * and friends, and this is the only thing that writes them (see src/lib/authClaims.ts for
 * why they were missing and what that cost).
 *
 * Deliberately SELF-SERVICE and self-only. The caller proves who they are with their ID
 * token and gets claims computed from their OWN `users` + `roles` documents — there is no
 * `targetUid` parameter, so this cannot be pointed at anyone else, and nothing in the
 * request body influences the outcome. Being able to ask "what am I allowed to do?" is not
 * a privilege; the answer comes from Firestore either way.
 *
 * Called once per session start by AuthProvider, right before it force-refreshes the token.
 * `updated: false` is the normal answer and means no write happened.
 */
export async function POST(req: NextRequest) {
  try {
    const { idToken } = await req.json().catch(() => ({}));
    if (!idToken || typeof idToken !== 'string') {
      return NextResponse.json({ error: 'Missing idToken' }, { status: 400 });
    }

    let caller: { uid: string; email?: string | null; emailVerified?: boolean };
    try {
      // checkRevoked: a revoked/disabled session must not be able to re-mint claims for
      // itself — that is precisely the account this exists to strip.
      const decoded = await adminAuth().verifyIdToken(idToken, true);
      caller = { uid: decoded.uid, email: decoded.email, emailVerified: decoded.email_verified === true };
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { updated } = await syncCapabilityClaims(adminDbFor(req), caller);
    return NextResponse.json({ updated }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[auth/claims]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
