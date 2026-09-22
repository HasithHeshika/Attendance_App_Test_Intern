import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor, tenantForRequest } from '@/lib/firebaseAdmin';
import { checkRateLimit, clientIp } from '@/lib/rateLimit';
import { isEmailLike } from '@/lib/phone';

// firebase-admin needs the Node runtime (not edge) — see the same note on
// src/app/api/register/route.ts.
export const runtime = 'nodejs';

// southernlanka ("carecode.org") users may sign in with either their email or their
// employee number. Firebase Auth only knows email+password, so an employee-number
// identifier has to be resolved to the matching account's email BEFORE calling
// signInWithEmailAndPassword — the client can't do that lookup itself because Firestore's
// `users` read rule requires an authenticated session (isAuth(), see firestore.rules),
// which doesn't exist yet at this point in the login flow. This route runs the lookup with
// firebase-admin instead.
const ALLOWED_TENANT_ID = 'southernlanka';

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 20;

export async function POST(req: NextRequest) {
  try {
    const tenant = tenantForRequest(req);
    if (tenant.id !== ALLOWED_TENANT_ID) {
      // Don't distinguish "wrong tenant" from "no match" — both just return no email.
      return NextResponse.json({ email: null });
    }

    const db = adminDbFor(req);
    const retryAfterMs = await checkRateLimit(
      db, 'resolve_login', clientIp(req), RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX,
    );
    if (retryAfterMs > 0) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } },
      );
    }

    const body = await req.json();
    const identifier = String(body.identifier ?? '').trim();
    if (!identifier || isEmailLike(identifier)) {
      // Already an email (or empty) — nothing to resolve, hand it straight back.
      return NextResponse.json({ email: identifier || null });
    }

    // Never reveal via status/shape whether an employee number is registered — always 200
    // with email: null on "no match", same as a genuinely wrong email would look client-side.
    const snap = await db.collection('users').where('employee_number', '==', identifier).limit(1).get();
    if (snap.empty) return NextResponse.json({ email: null });
    const email = String(snap.docs[0].data().email ?? '').trim();
    return NextResponse.json({ email: email || null });
  } catch (e) {
    console.error('[resolve-login]', e);
    return NextResponse.json({ email: null });
  }
}
