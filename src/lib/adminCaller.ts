import type { Firestore } from 'firebase-admin/firestore';
import { adminAuth } from '@/lib/firebaseAdmin';

// The reset-password route's caller check, shared. Verifies the Firebase ID token, finds the
// caller's user doc by uid, then their role doc by name, and requires is_system_admin or
// can_manage_users (or the per-user is_super_admin override). Firestore rules cannot make this
// distinction (no custom claims), so every admin-only write goes through a route that calls
// this first.
export interface AdminCaller { uid: string; epf: string; name: string; role: string }

export async function verifyAdminCaller(db: Firestore, idToken: unknown): Promise<AdminCaller | null> {
  if (typeof idToken !== 'string' || !idToken) return null;
  let uid: string;
  try { uid = (await adminAuth().verifyIdToken(idToken)).uid; } catch { return null; }
  const callerSnap = await db.collection('users').where('uid', '==', uid).limit(1).get();
  if (callerSnap.empty) return null;
  const caller = callerSnap.docs[0].data();
  const roleSnap = caller.role ? await db.collection('roles').where('name', '==', caller.role).limit(1).get() : null;
  const role = roleSnap && !roleSnap.empty ? roleSnap.docs[0].data() : null;
  const ok = !!(role?.is_system_admin || role?.can_manage_users || caller.is_super_admin === true);
  if (!ok) return null;
  return { uid, epf: String(caller.epf_number ?? ''), name: String(caller.display_name ?? caller.epf_number ?? ''), role: String(caller.role ?? '') };
}

// The same verification without the admin gate: who is this, from a token, and are they a
// system admin? Personal greetings are written by ordinary managers, so the route needs an
// identity rather than a permission — the permission is then decided by canAuthor() against
// the org's supervisor tree, which no capability flag can express.
export interface SignedInCaller {
  uid: string;
  epf: string;
  name: string;
  role: string;
  avatar_url: string | null;
  /** is_system_admin on their role, or the per-user is_super_admin override. */
  systemAdmin: boolean;
  /** `users.employee_type` — '' when unset. Pass it to resolveCapabilities: that function
   *  narrows a role to the trainee access set only when it is TOLD the type, so omitting it
   *  silently grants a trainee their parent role's flags, can_approve_suspense included. */
  employeeType: string;
}

export async function verifySignedInCaller(db: Firestore, idToken: unknown): Promise<SignedInCaller | null> {
  if (typeof idToken !== 'string' || !idToken) return null;
  let uid: string;
  try { uid = (await adminAuth().verifyIdToken(idToken)).uid; } catch { return null; }
  const callerSnap = await db.collection('users').where('uid', '==', uid).limit(1).get();
  if (callerSnap.empty) return null;
  const caller = callerSnap.docs[0].data();
  const epf = String(caller.epf_number ?? '');
  if (!epf) return null;   // a user doc with no EPF cannot author anything: EPF is the identity
  const roleSnap = caller.role ? await db.collection('roles').where('name', '==', caller.role).limit(1).get() : null;
  const role = roleSnap && !roleSnap.empty ? roleSnap.docs[0].data() : null;
  return {
    uid,
    epf,
    name: String(caller.display_name ?? caller.epf_number ?? ''),
    role: String(caller.role ?? ''),
    avatar_url: typeof caller.avatar_url === 'string' && caller.avatar_url ? caller.avatar_url : null,
    systemAdmin: !!(role?.is_system_admin || caller.is_super_admin === true),
    employeeType: String(caller.employee_type ?? ''),
  };
}
