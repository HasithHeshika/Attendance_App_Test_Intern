import { FieldValue } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '@/lib/firebaseAdmin';
import { TENANTS_DB_ID } from '@/lib/tenantRegistry';
import { PLATFORM_BOOTSTRAP_EMAILS, isPlatformBootstrapEmail } from '@/lib/bootstrapAdmins';

/**
 * Who may configure the platform — SERVER ONLY.
 *
 * This is the highest-privilege surface in the app: it decides which domains exist, which
 * database each one talks to, and which modules every organisation gets. It is deliberately
 * NOT the same thing as a tenant's `is_super_admin`. Running one hospital must not confer
 * power over every other hospital's configuration, and superAdminSync already mirrors those
 * accounts into every tenant database, which would have spread the privilege further still.
 *
 * The list lives in the `tenants` registry database, not in any tenant's own, so revoking
 * someone is one write rather than one per organisation.
 */

export const PLATFORM_ADMINS_COLLECTION = 'platform_admins';

/**
 * The accounts that can never be locked out — the one deliberate hardcode in the whole
 * tenant system, defined in @/lib/bootstrapAdmins so the Node routes and the client SDK can
 * share one copy. An empty or corrupted platform_admins collection must not mean nobody can
 * get in; these addresses are always admitted and cannot be removed or disabled through the
 * UI.
 */
export { PLATFORM_BOOTSTRAP_EMAILS };

export interface PlatformAdmin {
  email: string;
  name: string;
  addedBy: string;
  addedAt: string | null;
  disabled: boolean;
  /** True for a PLATFORM_BOOTSTRAP_EMAILS address — the UI must not offer to revoke it. */
  isBootstrap: boolean;
}

/** Who is asking, once their token has been verified. */
export interface PlatformCaller {
  uid: string;
  email: string;
  /** Bootstrap alone may manage the admin list and register or disable tenants. */
  isBootstrap: boolean;
}

const norm = (email: string | undefined | null): string => (email || '').trim().toLowerCase();

export const isBootstrapEmail = (email: string | undefined | null): boolean =>
  isPlatformBootstrapEmail(email);

const adminsCol = () => adminDb(TENANTS_DB_ID).collection(PLATFORM_ADMINS_COLLECTION);

/**
 * Is this email allowed in? Bootstrap always; everyone else needs a document that is not
 * disabled. Any read failure denies — an unreachable registry must not open the door.
 */
export async function isPlatformAdmin(email: string | undefined | null): Promise<boolean> {
  const e = norm(email);
  if (!e) return false;
  if (isBootstrapEmail(e)) return true;
  try {
    const doc = await adminsCol().doc(e).get();
    return doc.exists && doc.get('disabled') !== true;
  } catch (err) {
    console.error('[platformAdmins] lookup failed, denying:', err);
    return false;
  }
}

/**
 * Mirror the grant onto a Firebase Auth custom claim.
 *
 * The claim is what lets the app show a Platform Config button with no network call and no
 * Firestore read — 300+ users would otherwise each fire a request per session to be told no.
 * It is presentation only; every /platform request re-checks the list above.
 *
 * Best-effort on purpose: the person may have no Auth account yet (they are added by email,
 * before they ever sign in). Failing the whole grant because a claim could not be set would
 * be worse than a missing button.
 */
async function syncClaim(email: string, granted: boolean): Promise<void> {
  try {
    const user = await adminAuth().getUserByEmail(email);
    const claims = { ...(user.customClaims ?? {}) };
    if (granted) claims.platform_admin = true;
    else delete claims.platform_admin;
    await adminAuth().setCustomUserClaims(user.uid, claims);
    // Existing sessions keep their old token for up to an hour; revoking forces a refresh so
    // a removal takes effect on the next request instead of at the token's leisure.
    if (!granted) await adminAuth().revokeRefreshTokens(user.uid);
  } catch (err) {
    console.warn(`[platformAdmins] could not sync claim for ${email}:`, err);
  }
}

/**
 * Verify a Firebase ID token and confirm the holder may configure the platform.
 * Returns null for every failure — the caller turns that into a 404, never a message that
 * would confirm this surface exists.
 *
 * The `platform_admin` custom claim is NOT consulted here. It exists so the app can decide
 * whether to render a button without a network call; it is a hint, and hints do not grant
 * access. The list in Firestore is the only authority.
 */
export async function verifyPlatformCaller(idToken: string | undefined | null): Promise<PlatformCaller | null> {
  if (!idToken) return null;
  try {
    const decoded = await adminAuth().verifyIdToken(idToken);
    const email = norm(decoded.email);
    // An unverified address proves nothing about who holds it; on the highest-privilege
    // surface in the app, require the provider to have verified it.
    if (!email || decoded.email_verified !== true) return null;
    if (!(await isPlatformAdmin(email))) return null;

    // Self-heal the presentation claim. Two people arrive here without one: the bootstrap
    // account, which is admitted by a constant and so was never "granted" anything, and
    // anyone added by email before they had an Auth account to hang a claim on. Neither
    // should have to be re-added by hand just to see the button.
    // Fire-and-forget: access has already been decided by the list above, and the claim
    // grants nothing.
    if (decoded.platform_admin !== true) void syncClaim(email, true);

    return { uid: decoded.uid, email, isBootstrap: isBootstrapEmail(email) };
  } catch {
    return null;
  }
}

function toAdmin(id: string, d: Record<string, unknown>): PlatformAdmin {
  const addedAt = d.added_at as { toDate?: () => Date } | undefined;
  return {
    email: typeof d.email === 'string' ? d.email : id,
    name: typeof d.name === 'string' ? d.name : '',
    addedBy: typeof d.added_by === 'string' ? d.added_by : '',
    addedAt: addedAt?.toDate ? addedAt.toDate().toISOString() : null,
    disabled: d.disabled === true,
    isBootstrap: isBootstrapEmail(id),
  };
}

/**
 * Every platform admin, bootstrap first. Bootstrap is synthesised when it has no document,
 * so the UI always shows who really holds the keys rather than an empty list.
 */
export async function listPlatformAdmins(): Promise<PlatformAdmin[]> {
  const snap = await adminsCol().get();
  const admins = snap.docs.map(d => toAdmin(d.id, d.data() as Record<string, unknown>));
  // One synthesised row per bootstrap address that has no document — each is admitted by a
  // constant rather than by the collection, so any of them can be absent from it.
  const present = new Set(admins.map(a => norm(a.email)));
  for (const email of PLATFORM_BOOTSTRAP_EMAILS) {
    if (present.has(email)) continue;
    admins.push({
      email,
      name: 'Superadmin',
      addedBy: 'code',
      addedAt: null,
      disabled: false,
      isBootstrap: true,
    });
  }
  return admins.sort((a, b) =>
    Number(b.isBootstrap) - Number(a.isBootstrap) || a.email.localeCompare(b.email));
}

/** Add (or re-enable) a platform admin. Bootstrap-only — the route enforces that. */
export async function addPlatformAdmin(
  email: string, name: string, actor: string,
): Promise<PlatformAdmin> {
  const e = norm(email);
  if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('A valid email is required.');
  await adminsCol().doc(e).set({
    email: e,
    name: name.trim(),
    added_by: actor,
    added_at: FieldValue.serverTimestamp(),
    disabled: false,
  }, { merge: true });
  await syncClaim(e, true);
  return {
    email: e, name: name.trim(), addedBy: actor, addedAt: null,
    disabled: false, isBootstrap: isBootstrapEmail(e),
  };
}

/**
 * Revoke a platform admin. The document is deleted rather than flagged: this is an access
 * list, and a list of people who no longer have access is a footgun waiting for someone to
 * flip a boolean back. The audit trail keeps the history.
 */
export async function removePlatformAdmin(email: string): Promise<void> {
  const e = norm(email);
  if (isBootstrapEmail(e)) throw new Error('The bootstrap administrator cannot be removed.');
  await adminsCol().doc(e).delete();
  await syncClaim(e, false);
}
