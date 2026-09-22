import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { SignJWT } from 'jose';
import { resolveLogPupCaller } from '@/lib/logpupIdentity';
import { LOGPUP_BASE_URL } from '@/lib/logpupApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * LogPup SSO — mints a short-lived, HS256-signed JWT the user carries to LogPup for automatic
 * sign-in. Same shape as /api/solar-sso, which is the pattern this follows.
 *
 * Security:
 *  • The caller is authenticated by their Firebase ID token (verified server-side); the identity
 *    in the JWT comes from the authoritative Firestore profile, never from client-supplied
 *    claims. resolveLogPupCaller is the one place that rule is enforced.
 *  • The signing secret (LOGPUP_SSO_SECRET) lives only on the server, and is DISTINCT from both
 *    LOGPUP_API_KEY (the task API) and ATTENDANCE_JWT_SECRET (Solar's). Three integrations,
 *    three secrets: one compromised handoff must not hand over the others.
 *  • `jti` is a fresh uuid per mint. LogPup records redeemed ids and refuses a repeat, because
 *    this token rides in a URL and URLs survive in history, referrer headers and logs.
 *  • Three minutes, matching Solar's replay window.
 *
 * CLAIMS ARE DELIBERATELY MINIMAL: subject, email, name, jti. No epf, no phone, and above all
 * NO ROLE. LogPup has its own role model and capability matrix; a role shipped from here would
 * be a second, weaker source of truth for every permission in that application.
 */
export async function POST(req: NextRequest) {
  try {
    const secret = process.env.LOGPUP_SSO_SECRET;
    if (!secret) {
      return NextResponse.json({ error: 'SSO is not configured' }, { status: 500 });
    }

    const body = await req.json().catch(() => ({}));
    // Also enforces the altavision-only tenant gate and the active/resigned check.
    const caller = await resolveLogPupCaller(req, body?.idToken);
    if (!caller.ok) {
      return NextResponse.json({ error: caller.error }, { status: caller.status });
    }

    const token = await new SignJWT({
      email: caller.caller.email,
      name: caller.caller.name,
      jti: randomUUID(),
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      // The email IS the subject: it is the only handle LogPup has for a person, and the one
      // field both systems hold for the same human.
      .setSubject(caller.caller.email)
      .setIssuedAt()
      .setExpirationTime('3m')
      .sign(new TextEncoder().encode(secret));

    const next = safeNext(body?.next);
    const url = `${LOGPUP_BASE_URL}/sso/attendance?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
    return NextResponse.json({ url }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

/**
 * Where to land inside LogPup.
 *
 * Must be a same-origin relative path: one leading slash, never two. `//evil.example` is a
 * protocol-relative URL that browsers treat as absolute, so an unvalidated value here would let
 * this endpoint mint a link that carries a valid session token to somebody else's host.
 */
function safeNext(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}
