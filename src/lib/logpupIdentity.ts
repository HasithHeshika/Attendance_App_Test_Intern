import type { NextRequest } from 'next/server';
import type { DocumentData } from 'firebase-admin/firestore';
import { adminAuth, adminDbFor, tenantForRequest } from '@/lib/firebaseAdmin';

/**
 * "Who is calling, and what is their work email?" — for the LogPup proxy routes.
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE: the email is derived from a VERIFIED Firebase ID
 * token and the authoritative Firestore profile, never from the request body. LogPup matches
 * people by email alone, so a route that trusted a body-supplied address would let any signed-in
 * user read and modify anyone else's tasks. That is the single worst failure this feature can
 * have, and it is a one-line mistake, so the lookup lives here rather than in three handlers.
 *
 * Mirrors the identity half of src/app/api/solar/notifications/route.ts, including its cache —
 * see the comment on IDENTITY_TTL_MS.
 */

export interface LogPupCaller {
  uid: string;
  epf: string;
  email: string;
  name: string;
}

export type CallerResult =
  | { ok: true; caller: LogPupCaller }
  | { ok: false; status: number; error: string };

/**
 * uid → resolved identity, cached in-instance.
 *
 * Identity (email, name) changes ~never, but the tasks route runs for every 60-second poll of
 * every user. The Solar integration's comment records what happens without this: at 300+ users
 * the per-poll Firestore users query was the single biggest read amplifier in the app. A stale
 * entry for ten minutes shows somebody the wrong empty list at worst.
 */
const identityCache = new Map<string, { caller: LogPupCaller; at: number }>();
const IDENTITY_TTL_MS = 10 * 60_000;

/** Alta Vision is the only tenant with LogPup accounts. Checked here, not left to the UI. */
const ALLOWED_TENANT_ID = 'altavision';

export function logpupTenantAllowed(req: NextRequest): boolean {
  return tenantForRequest(req).id === ALLOWED_TENANT_ID;
}

/**
 * True when Firebase Admin credentials are present. Without them no token can be verified, and
 * the routes fail closed in production rather than trusting the client.
 */
export function adminConfigured(): boolean {
  return !!(
    process.env.FIREBASE_ADMIN_PROJECT_ID &&
    process.env.FIREBASE_ADMIN_CLIENT_EMAIL &&
    process.env.FIREBASE_ADMIN_PRIVATE_KEY
  );
}

function displayName(u: DocumentData): string {
  return String(u.display_name ?? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim());
}

/**
 * Verify the caller's ID token and resolve their work email.
 *
 * Returns a refusal rather than throwing, so handlers can answer with the right status and the
 * right shape (the read route degrades to an empty list; the write route surfaces the message).
 */
export async function resolveLogPupCaller(
  req: NextRequest,
  idToken: unknown,
): Promise<CallerResult> {
  if (!logpupTenantAllowed(req)) {
    return { ok: false, status: 403, error: 'LogPup is not available on this domain' };
  }
  if (!adminConfigured()) {
    // Production without credentials cannot verify anyone. There is deliberately no
    // client-supplied fallback here, not even in development: unlike Solar's notifications
    // (read-only, and harmless when wrong), these routes can MOVE somebody's task.
    return { ok: false, status: 503, error: 'Sign-in verification is not configured' };
  }
  if (typeof idToken !== 'string' || !idToken) {
    return { ok: false, status: 400, error: 'Missing idToken' };
  }

  let uid: string;
  let tokenEmail: string | undefined;
  try {
    const decoded = await adminAuth().verifyIdToken(idToken);
    uid = decoded.uid;
    tokenEmail = decoded.email ?? undefined;
  } catch {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  const cached = identityCache.get(uid);
  if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) {
    return { ok: true, caller: cached.caller };
  }

  const snap = await adminDbFor(req).collection('users').where('uid', '==', uid).limit(1).get();
  const u = snap.empty ? null : snap.docs[0].data();
  if (!u) return { ok: false, status: 403, error: 'No employee profile for this account' };
  // Same gate the SSO and passkey routes apply: a resignation is an inactive account.
  if (u.is_active === false || u.date_of_resign) {
    return { ok: false, status: 403, error: 'Account not active' };
  }

  const email = String(u.email ?? tokenEmail ?? '').trim().toLowerCase();
  if (!email) return { ok: false, status: 403, error: 'No work email on this profile' };

  const caller: LogPupCaller = {
    uid,
    epf: u.epf_number != null ? String(u.epf_number) : '',
    email,
    name: displayName(u),
  };
  identityCache.set(uid, { caller, at: Date.now() });
  return { ok: true, caller };
}
