import { NextRequest, NextResponse } from 'next/server';
import { adminAuth, adminDbFor } from '@/lib/firebaseAdmin';
import type { UserRecord } from 'firebase-admin/auth';
import { generateInitialPassword } from '@/lib/initialPassword';

// A fresh random password per reset, generated per REQUEST (not per module load, which
// would hand every account reset by the same warm serverless instance the same password).
// Returned in the response so the admin can pass it on — it is never stored anywhere.

function epfDocId(epf: string): string {
  return epf.includes('/') ? epf.replace(/\//g, '%2F') : epf;
}

export async function POST(req: NextRequest) {
  try {
    const DEFAULT_PASSWORD = generateInitialPassword();
    const { idToken, targetEpf } = await req.json();

    if (!idToken || !targetEpf) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const auth = adminAuth();
    const db   = adminDbFor(req);

    // 1. Verify the caller can manage users
    let callerUid: string;
    try {
      const decoded = await auth.verifyIdToken(idToken);
      callerUid = decoded.uid;
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const callerSnap = await db.collection('users').where('uid', '==', callerUid).limit(1).get();
    const callerRole = callerSnap.empty ? null : callerSnap.docs[0].data().role;
    const roleSnap = callerRole
      ? await db.collection('roles').where('name', '==', callerRole).limit(1).get()
      : null;
    const roleData = roleSnap && !roleSnap.empty ? roleSnap.docs[0].data() : null;
    const canManageUsers = !!(roleData?.is_system_admin || roleData?.can_manage_users);
    if (!canManageUsers) {
      return NextResponse.json({ error: 'User management access required' }, { status: 403 });
    }

    // 2. Load the target user's Firestore doc
    const docRef  = db.collection('users').doc(epfDocId(targetEpf));
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const storedUid = (docSnap.data()?.uid as string | undefined) || '';
    const email     = (docSnap.data()?.email as string | undefined) || '';

    // 3. Resolve the Auth account (uid → email), then set its password to the
    //    default. Migrated users may have no account yet — create one so the
    //    default password becomes usable immediately.
    let target: UserRecord | null = null;
    if (storedUid) {
      try { target = await auth.getUser(storedUid); } catch { target = null; }
    }
    if (!target && email) {
      try { target = await auth.getUserByEmail(email); } catch { target = null; }
    }

    let resolvedUid: string;
    let created = false;
    try {
      if (target) {
        await auth.updateUser(target.uid, { password: DEFAULT_PASSWORD });
        resolvedUid = target.uid;
      } else {
        if (!email) {
          return NextResponse.json({ error: 'User has no email to create a login account' }, { status: 400 });
        }
        const createdUser = await auth.createUser({
          email,
          password: DEFAULT_PASSWORD,
          emailVerified: true,
        });
        resolvedUid = createdUser.uid;
        created = true;
      }
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code ?? '';
      if (code === 'auth/email-already-exists') {
        return NextResponse.json({ error: 'That email is already in use by another account' }, { status: 409 });
      }
      console.error('[reset-password] auth step failed:', e);
      return NextResponse.json({ error: 'Failed to reset the password' }, { status: 500 });
    }

    // 4. Heal the Firestore link if the uid was missing/created.
    if (resolvedUid !== storedUid) {
      await docRef.update({ uid: resolvedUid, updated_at: new Date() });
    }

    return NextResponse.json({ success: true, created, defaultPassword: DEFAULT_PASSWORD, email });
  } catch (e) {
    console.error('[reset-password]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
