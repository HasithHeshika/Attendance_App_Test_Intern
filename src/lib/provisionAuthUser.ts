import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * Give a new employee a login account, reusing an ORPHANED Auth account when one already
 * holds their email.
 *
 * Why this exists: deleting an employee removes their Firestore profile but NOT their
 * Firebase Auth account — nothing in the app deletes it, which is exactly why
 * /api/admin/orphan-auth exists to sweep them up afterwards. Until that sweep is run by
 * hand, re-adding the same person fails forever: auth.createUser rejects with
 * auth/email-already-exists and the import reports "Email already in use", even though no
 * employee holds that email any more.
 *
 * An Auth account is safe to adopt only when it is genuinely orphaned — no user profile in
 * THIS tenant's database references its uid or its email. If one does, the email really is
 * taken by a live employee and the caller still gets an error, which is the case the
 * original check was written for.
 *
 * Adoption resets the password, so the returned account is always reachable with the
 * password supplied here. That is sound precisely because no profile points at it.
 */
export class EmailInUseError extends Error {
  constructor(email: string) {
    super(`Email already in use by an existing employee (${email})`);
    this.name = 'EmailInUseError';
  }
}

export async function provisionAuthUser(
  auth: Auth,
  db: Firestore,
  email: string,
  password: string,
): Promise<{ uid: string; adopted: boolean }> {
  try {
    const created = await auth.createUser({ email, password, emailVerified: false });
    return { uid: created.uid, adopted: false };
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== 'auth/email-already-exists') throw e;
  }

  // The address is taken in the Auth pool. Decide whether any profile actually claims it.
  const existing = await auth.getUserByEmail(email).catch(() => null);
  if (!existing) throw new EmailInUseError(email);

  const lower = email.trim().toLowerCase();
  const [byUid, byEmail, byEmailLower] = await Promise.all([
    db.collection('users').where('uid', '==', existing.uid).limit(1).get(),
    db.collection('users').where('email', '==', email).limit(1).get(),
    // Stored casing is not guaranteed and an equality query is case-sensitive, so check the
    // lowercased spelling too rather than trusting one form.
    lower === email
      ? Promise.resolve(null)
      : db.collection('users').where('email', '==', lower).limit(1).get(),
  ]);

  const claimed = !byUid.empty || !byEmail.empty || !!(byEmailLower && !byEmailLower.empty);
  if (claimed) throw new EmailInUseError(email);

  // Orphan: no profile references it, so it is a leftover from a deleted employee. Reuse it
  // instead of failing, and make sure the caller's password is the one that works.
  await auth.updateUser(existing.uid, { password, disabled: false });
  return { uid: existing.uid, adopted: true };
}
