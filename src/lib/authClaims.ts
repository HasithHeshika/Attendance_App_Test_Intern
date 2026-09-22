import type { Firestore } from 'firebase-admin/firestore';
import { adminAuth } from '@/lib/firebaseAdmin';
import { resolveUserCapabilities, type Role, type RoleCapabilities } from '@/lib/permissions';
// Break-glass. The same list src/services/userService.ts uses — imported, not duplicated:
// @/lib/bootstrapAdmins is pure, so it can load in a Node route where userService (client
// Firebase SDK) never can.
import { isBootstrapAdminEmail } from '@/lib/bootstrapAdmins';

/**
 * Firebase Auth custom claims — the thing that lets firestore.rules tell a System Admin
 * from a technician. SERVER ONLY.
 *
 * WHY THIS EXISTS: every capability helper in firestore.rules used to be a stub that
 * returned `isAuth()`, because the rules were written against custom claims that nothing
 * ever minted. That made `isSystemAdmin()`, `canManageUsers()` and `canViewPayroll()` true
 * for every signed-in employee, so the `roles` and `users` collections were writable by
 * anyone with a login — and since verifyAdminCaller / verifyPayrollCaller decide who is an
 * admin by READING those two collections, any employee could grant themselves
 * `is_system_admin` from the browser console and walk straight into /api/admin/*.
 *
 * This module closes that loop. Capabilities are resolved here, server-side, from the
 * authoritative `users` + `roles` documents using the SAME resolver the client uses
 * (resolveUserCapabilities — one definition, so the token and the UI can never disagree),
 * and written onto the token. The rules then trust the token, and the token is minted by
 * code the user cannot reach.
 *
 * DEPLOY ORDER MATTERS. Ship the app before the rules. An existing session carries a token
 * with no capability claims until it next passes through AuthProvider, and the tightened
 * rules deny that token. App first → users pick up claims on their next load → rules after.
 */

/**
 * The claims firestore.rules actually reads. Deliberately a SUBSET of RoleCapabilities:
 * a custom-claims payload is capped at 1000 bytes, and every flag the rules never consult
 * is dead weight in every request for the life of the token.
 *
 * Keep this list in lockstep with the `claims().*` references in firestore.rules.
 */
export const CLAIMED_CAPABILITIES = [
  'is_system_admin',
  'can_manage_users',
  'can_manage_leaves',
  'can_manage_shifts',
  'can_manage_working_schedules',
  'can_approve',
  'can_view_payroll',
  'can_manage_payroll_config',
  'can_manage_pay_profiles',
  'can_generate_payroll',
  'can_review_payroll',
  'can_finalize_payroll',
] as const satisfies readonly (keyof RoleCapabilities)[];

export type ClaimedCapability = (typeof CLAIMED_CAPABILITIES)[number];

export type CapabilityClaims = Partial<Record<ClaimedCapability, true>> & {
  role?: string;
  epf_number?: string;
};

/**
 * Claims this module owns and may therefore remove. Anything else on the token is left
 * alone — `platform_admin` in particular is granted by src/lib/platformAdmins.ts from a
 * different database entirely, and clobbering it here would silently drop the Platform
 * Config button for every platform admin on their next sign-in.
 */
const OWNED_CLAIM_KEYS: readonly string[] = [...CLAIMED_CAPABILITIES, 'role', 'epf_number'];

/**
 * Build the claim payload for one resolved user.
 *
 * Only TRUE capabilities are emitted. The rules test `== true`, so an absent key already
 * reads as false, and dropping the false half typically halves the payload.
 */
export function buildCapabilityClaims(
  caps: RoleCapabilities,
  opts: { role?: string | null; epfNumber?: string | null },
): CapabilityClaims {
  const claims: CapabilityClaims = {};
  for (const key of CLAIMED_CAPABILITIES) {
    if (caps[key]) claims[key] = true;
  }
  // `role` and `epf_number` are not capabilities — the rules use them for the owner
  // branches ("this row is mine"), which stay dead without epf_number.
  if (opts.role) claims.role = opts.role;
  if (opts.epfNumber) claims.epf_number = opts.epfNumber;
  return claims;
}

/** True when the token already carries exactly these claims — nothing to write. */
export function claimsUnchanged(
  existing: Record<string, unknown> | undefined,
  next: CapabilityClaims,
): boolean {
  const current = existing ?? {};
  // undefined and false are the same answer to the rules; treat them as equal so a token
  // minted by an older build isn't rewritten on every single page load.
  const norm = (v: unknown) => (v === undefined || v === false ? undefined : v);
  for (const key of OWNED_CLAIM_KEYS) {
    if (norm(current[key]) !== norm((next as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/**
 * Last-resort lookup for a profile whose `uid` link was never written, returning the
 * adopted document's data (and repairing the link) or null.
 *
 * WHY THIS IS NEEDED: the client resolves the signed-in profile with getUserByUid
 * (src/services/userService.ts), which falls back to matching on EMAIL. This module had no
 * such fallback, so a `users` doc with an empty `uid` produced a full, correct-looking UI —
 * role, capabilities, Approvals page, the lot — on top of a token carrying NO claims at
 * all. Every write then failed permission-denied against rules that read those claims, and
 * the self-heal in getUserByUid could not fix it either: writing `uid` needs
 * canManageUsers(), which needs the claims that are missing. A permanent, silent lockout
 * that the interface actively hides. One Head Operation Engineer sat in exactly that state.
 *
 * WHY IT IS GUARDED THIS TIGHTLY: matching on email makes email control a privilege-granting
 * path, which it is not anywhere else in this file. Hence, in order:
 *
 *  1. VERIFIED email only — the same bar the bootstrap branch below holds, and for the same
 *     reason: /api/register can mint accounts at attacker-chosen addresses, and an
 *     unverified address proves nothing about who holds it. Note this deliberately does NOT
 *     cover unverified password accounts; those still need a manual uid repair. Narrowing
 *     the hole beats widening the blast radius.
 *  2. EXACTLY ONE match — an ambiguous email must never silently pick a document.
 *  3. ONLY an unlinked profile — a doc already pointing at some other uid is never
 *     re-pointed. Without this, anyone who got hold of a verified address matching a linked
 *     profile could steal it; with it, this can only ever fill a blank.
 *
 * The repaired link is written back, so this path fires at most once per profile and the
 * ordinary uid lookup takes over from the next session onwards.
 */
async function adoptUnlinkedProfileByEmail(
  db: Firestore,
  uid: string,
  email: string,
): Promise<FirebaseFirestore.DocumentData | null> {
  const normalised = email.toLowerCase().trim();
  if (!normalised) return null;

  // limit(2) is the ambiguity check: anything but a single hit is refused outright.
  const snap = await db.collection('users').where('email', '==', normalised).limit(2).get();
  if (snap.size !== 1) return null;

  const docSnap = snap.docs[0];
  const data = docSnap.data();
  if (data.uid) return null;   // already linked — never re-point

  await docSnap.ref.update({ uid, updated_at: new Date() });
  return data;
}

/**
 * Resolve one user's capabilities from Firestore and mint them onto their Auth token.
 *
 * Returns whether anything was written. A no-op is the common case (the claims are already
 * right), and it matters: this runs once per session start for 300+ users, so it must not
 * turn into a write per page load.
 *
 * A user with no profile document — or a deactivated one — gets their capability claims
 * STRIPPED rather than left as they were. A deactivated account keeps its Firebase login,
 * so it must not keep yesterday's admin rights just because nobody refreshed its token.
 */
export async function syncCapabilityClaims(
  db: Firestore,
  caller: { uid: string; email?: string | null; emailVerified?: boolean },
): Promise<{ updated: boolean }> {
  const auth = adminAuth();
  const { uid } = caller;

  const userSnap = await db.collection('users').where('uid', '==', uid).limit(1).get();
  let user = userSnap.empty ? null : userSnap.docs[0].data();

  // No uid match: the profile may simply never have had its uid written. Adopt it by
  // verified email and repair the link — see adoptUnlinkedProfileByEmail for why this is
  // needed at all and why it refuses everything except a single, unlinked, verified match.
  if (!user && caller.emailVerified === true && caller.email) {
    user = await adoptUnlinkedProfileByEmail(db, uid, caller.email);
  }

  // Break-glass. bootstrapAdminProfile() (src/services/userService.ts) lets the bootstrap
  // address create or repair its own System Admin profile from the browser, and that write
  // now needs a can_manage_users claim — which it cannot have while the profile it is trying
  // to create does not exist yet. Without this branch the recovery path deadlocks and an
  // empty `users` collection means nobody can ever get in.
  //
  // Verified email only, the same bar src/lib/platformAdmins.ts holds the platform surface
  // to: an unverified address proves nothing about who holds it, and /api/register can mint
  // accounts at attacker-chosen addresses.
  const isBootstrap =
    caller.emailVerified === true && isBootstrapAdminEmail(caller.email);

  let next: CapabilityClaims = {};
  if (!user && isBootstrap) {
    next = { is_system_admin: true, can_manage_users: true, role: 'System Admin' };
  } else if (user && user.is_active !== false) {
    const rolesSnap = await db.collection('roles').get();
    const roles = rolesSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as Role);
    const caps = resolveUserCapabilities(
      {
        role: user.role as string | undefined,
        employee_type: user.employee_type as string | undefined,
        is_super_admin: user.is_super_admin === true,
      },
      roles,
    );
    next = buildCapabilityClaims(caps, {
      role: (user.role as string | undefined) ?? null,
      epfNumber: (user.epf_number as string | undefined) ?? null,
    });
  }

  const record = await auth.getUser(uid);
  const existing = record.customClaims ?? {};
  if (claimsUnchanged(existing, next)) return { updated: false };

  // Preserve every claim this module does not own (platform_admin, above all).
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(existing)) {
    if (!OWNED_CLAIM_KEYS.includes(k)) merged[k] = v;
  }
  Object.assign(merged, next);

  await auth.setCustomUserClaims(uid, merged);
  return { updated: true };
}
