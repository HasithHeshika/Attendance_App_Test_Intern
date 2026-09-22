/**
 * The hardcoded break-glass accounts — PURE, no firebase imports.
 *
 * Two different authorities live here. They happen to name the same people today, but they
 * are not the same power and must not be collapsed into one list:
 *
 *   PLATFORM_BOOTSTRAP_EMAILS — may configure the platform itself (which domains exist, which
 *     database each talks to, which modules each organisation gets) and may grant or revoke
 *     other platform administrators. See src/lib/platformAdmins.ts.
 *   BOOTSTRAP_ADMIN_EMAILS — may sign in to ANY tenant database as System Admin with no
 *     Firestore profile, creating or repairing one on the way in. See bootstrapAdminProfile
 *     in src/services/userService.ts.
 *
 * WHY HARDCODED: an empty or corrupted platform_admins collection, or an empty `users`
 * collection, must not mean nobody can get back in — there would be no way back short of
 * editing Firestore by hand. These addresses are always admitted and cannot be removed or
 * disabled through any UI. That is also why this list is the one thing in the app that a
 * write anywhere in Firestore cannot change.
 *
 * WHY PURE: src/lib/authClaims.ts and the Node API routes need these predicates, and
 * src/services/userService.ts pulls in the client Firebase SDK, which must never load in a
 * Node route. Before this module the constant was copy-pasted into both. Anything added here
 * must stay free of firebase imports.
 */

/** Configure the platform. Order matters — see bootstrapAdminEpf. */
export const PLATFORM_BOOTSTRAP_EMAILS: readonly string[] = [
  'devopsaltavision@gmail.com',
  'sysadminaltavision@gmail.com',
];

/** Break-glass System Admin in every tenant. Order matters — see bootstrapAdminEpf. */
export const BOOTSTRAP_ADMIN_EMAILS: readonly string[] = [
  'devopsaltavision@gmail.com',
  'sysadminaltavision@gmail.com',
];

const norm = (email: string | null | undefined): string =>
  (email || '').trim().toLowerCase();

export const isPlatformBootstrapEmail = (email: string | null | undefined): boolean =>
  PLATFORM_BOOTSTRAP_EMAILS.includes(norm(email));

export const isBootstrapAdminEmail = (email: string | null | undefined): boolean =>
  BOOTSTRAP_ADMIN_EMAILS.includes(norm(email));

/**
 * The EPF number a break-glass account's auto-created profile takes, or null for anyone
 * else.
 *
 * Every bootstrap account needs its OWN doc id. They share one Firebase Auth pool and one
 * `users` collection per tenant, so a single shared 'SYSADMIN' id would have the second
 * account's sign-in overwrite the first account's uid and email — and then the first
 * account's next sign-in would find no doc for its email and overwrite it straight back.
 * A doc that ping-pongs between two owners is worse than no break-glass at all.
 *
 * The FIRST entry keeps the bare 'SYSADMIN' it has always had, because that doc already
 * exists in production databases; renumbering it would strand the real one and mint a
 * duplicate. Later entries are 'SYSADMIN_02', 'SYSADMIN_03', … — the shape the second
 * account's profile already carries in production (and in its custom claims' epf_number),
 * so break-glass recreating a deleted doc lands on the SAME id rather than inventing a
 * second identity for one person. Never reorder the lists above — the order is what pins an
 * existing account to its existing doc.
 */
export function bootstrapAdminEpf(email: string | null | undefined): string | null {
  const i = BOOTSTRAP_ADMIN_EMAILS.indexOf(norm(email));
  if (i < 0) return null;
  return i === 0 ? 'SYSADMIN' : `SYSADMIN_${String(i + 1).padStart(2, '0')}`;
}
