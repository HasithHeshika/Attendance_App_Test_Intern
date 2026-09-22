import { NextRequest, NextResponse } from 'next/server';
import { adminAuth, adminDbFor } from '@/lib/firebaseAdmin';
import type { UserRecord } from 'firebase-admin/auth';
import { generateInitialPassword } from '@/lib/initialPassword';

// A fresh random password, generated per REQUEST — see src/lib/initialPassword.ts. Only
// used when this route has to CREATE the Auth account, and returned so the admin can pass
// it on.

function epfDocId(epf: string): string {
  return epf.includes('/') ? epf.replace(/\//g, '%2F') : epf;
}

export async function POST(req: NextRequest) {
  const DEFAULT_PASSWORD = generateInitialPassword();
  try {
    const { idToken, targetEpf, newEmail } = await req.json();

    if (!idToken || !targetEpf || !newEmail) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Basic email shape check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
    }

    const auth = adminAuth();
    const db   = adminDbFor(req);

    // 1. Verify the caller and confirm they can manage users
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
    const storedUid    = (docSnap.data()?.uid as string | undefined) || '';
    const currentEmail = (docSnap.data()?.email as string | undefined) || '';

    const byEmail = async (email: string): Promise<UserRecord | null> => {
      if (!email) return null;
      try { return await auth.getUserByEmail(email); } catch { return null; }
    };

    // 3. Resolve which Firebase Auth account should carry the new email.
    //    Prefer, in order: the uid already linked in Firestore, then the account
    //    at the current (possibly typo'd) email, then an account that already
    //    owns the new email (self-provisioned by the login page). Migrated users
    //    often have none of these — we create the account below.
    let target: UserRecord | null = null;
    if (storedUid) {
      try { target = await auth.getUser(storedUid); } catch { target = null; }
    }
    if (!target) target = await byEmail(currentEmail);

    // Is the new email already taken by some account?
    const emailOwner = await byEmail(newEmail);

    let resolvedUid: string;
    let created = false;

    try {
      if (emailOwner) {
        // The new email already belongs to an account. That account must be the
        // canonical one (an email can't be moved onto a different uid). Adopt it —
        // and mark it verified so Google SSO links to it cleanly later.
        resolvedUid = emailOwner.uid;
        if (!emailOwner.emailVerified) {
          await auth.updateUser(resolvedUid, { emailVerified: true });
        }
      } else if (target) {
        // An account exists under the old identity — rename it to the new email.
        // emailVerified:true so the app's Google sign-in links to this same account
        // (and so the login page won't self-provision a duplicate).
        await auth.updateUser(target.uid, { email: newEmail, emailVerified: true });
        resolvedUid = target.uid;
      } else {
        // No auth account anywhere (typical for a migrated user). Create one with
        // the default password so they can sign in immediately, verified so Google
        // SSO works afterwards.
        const createdUser = await auth.createUser({
          email: newEmail,
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
      console.error('[update-email] auth step failed:', e);
      return NextResponse.json({ error: 'Failed to update the login account' }, { status: 500 });
    }

    // 4. Link uid + new email onto the Firestore doc so every login path
    //    (password now, Google later) resolves back to this profile.
    await docRef.update({ email: newEmail, uid: resolvedUid, updated_at: new Date() });

    return NextResponse.json({
      success: true,
      created,
      ...(created ? { defaultPassword: DEFAULT_PASSWORD } : {}),
    });
  } catch (e) {
    console.error('[update-email]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
