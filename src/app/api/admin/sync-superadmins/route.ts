import { NextRequest, NextResponse } from 'next/server';
import { adminAuth, adminDbFor } from '@/lib/firebaseAdmin';
import { syncSuperAdmins } from '@/lib/superAdminSync';

// firebase-admin needs the Node runtime (not Edge); a sync walks every tenant's users collection.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Manual superadmin mirroring — see src/lib/superAdminSync.ts for the model. Called from the
 * System Settings page: Preview sends `dryRun: true`, Sync now sends `dryRun: false`.
 */
export async function POST(req: NextRequest) {
  try {
    const { idToken, dryRun } = await req.json();
    if (!idToken) {
      return NextResponse.json({ error: 'Missing idToken' }, { status: 400 });
    }

    const auth = adminAuth();
    const db   = adminDbFor(req);

    // Verify the caller, then require System Admin. Deliberately NOT can_manage_users: this
    // writes admin accounts into every tenant database, so it takes the strictest gate the
    // app has — the same one guarding the full backup export.
    let callerUid: string;
    try {
      const decoded = await auth.verifyIdToken(idToken);
      callerUid = decoded.uid;
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const callerSnap = await db.collection('users').where('uid', '==', callerUid).limit(1).get();
    const callerData = callerSnap.empty ? null : callerSnap.docs[0].data();
    const callerRole = callerData?.role;
    const roleSnap = callerRole
      ? await db.collection('roles').where('name', '==', callerRole).limit(1).get()
      : null;
    const roleData = roleSnap && !roleSnap.empty ? roleSnap.docs[0].data() : null;
    // A deactivated account keeps its Firebase Auth login, so the role check alone would still
    // let a former system admin run this.
    if (!roleData?.is_system_admin || callerData?.is_active !== true) {
      return NextResponse.json({ error: 'System Admin access required' }, { status: 403 });
    }

    const result = await syncSuperAdmins({ dryRun: dryRun !== false });
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    console.error('[sync-superadmins]', e);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}
