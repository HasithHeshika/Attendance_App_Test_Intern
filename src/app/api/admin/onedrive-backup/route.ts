import { NextRequest, NextResponse } from 'next/server';
import { adminAuth, adminDbFor } from '@/lib/firebaseAdmin';
import { readCloudConfig } from '@/lib/cloudStorageServer';
import { downloadFromOneDrive } from '@/lib/msgraph';

// firebase-admin needs the Node runtime; the download is a few MB over the wire.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Written by scripts/onedrive-upload.mjs on the daily 4 AM schedule.
const DEFAULT_BACKUP_NAME = 'firestore-latest.json';

// Fetch the latest Firestore backup out of the configured OneDrive so an admin can restore
// it without hunting for a file. System-Admin only: the payload is the entire database.
export async function POST(req: NextRequest) {
  try {
    const body    = await req.json().catch(() => ({}));
    const idToken = body?.idToken as string | undefined;
    const name    = typeof body?.name === 'string' && body.name ? body.name : DEFAULT_BACKUP_NAME;
    if (!idToken) return NextResponse.json({ error: 'Missing idToken' }, { status: 400 });

    const auth = adminAuth();
    const db   = adminDbFor(req);

    let callerUid: string;
    try {
      callerUid = (await auth.verifyIdToken(idToken)).uid;
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Same gate as /api/admin/backup — this returns ALL employee data.
    const callerSnap = await db.collection('users').where('uid', '==', callerUid).limit(1).get();
    const callerRole = callerSnap.empty ? null : callerSnap.docs[0].data().role;
    const roleSnap   = callerRole
      ? await db.collection('roles').where('name', '==', callerRole).limit(1).get()
      : null;
    const roleData = roleSnap && !roleSnap.empty ? roleSnap.docs[0].data() : null;
    if (!roleData?.is_system_admin) {
      return NextResponse.json({ error: 'System Admin access required' }, { status: 403 });
    }

    const cfg = await readCloudConfig(db);
    if (cfg?.provider !== 'onedrive' || !cfg.onedrive) {
      return NextResponse.json({ error: 'OneDrive is not the active storage provider.' }, { status: 400 });
    }

    const file = await downloadFromOneDrive(cfg.onedrive, name);

    // Validate here so a truncated or unrelated file fails with a clear message rather
    // than reaching the restore preview and looking like an empty backup.
    let parsed: { __firestore_backup__?: boolean; collections?: unknown; created_at?: string };
    try {
      parsed = JSON.parse(file.text);
    } catch {
      return NextResponse.json({ error: `${file.name} in OneDrive is not valid JSON.` }, { status: 422 });
    }
    if (!parsed?.__firestore_backup__ || !parsed?.collections) {
      return NextResponse.json({ error: `${file.name} is not a Firestore backup file.` }, { status: 422 });
    }

    // Return the original text rather than re-serialising several MB of JSON. Metadata
    // rides along in headers so the client can show what it pulled.
    return new NextResponse(file.text, {
      status: 200,
      headers: {
        'Content-Type':        'application/json; charset=utf-8',
        'Cache-Control':       'no-store',
        'X-Backup-Name':       file.name,
        'X-Backup-Size':       String(file.size),
        'X-Backup-Modified':   file.lastModified,
        'X-Backup-Created-At': parsed.created_at || '',
      },
    });
  } catch (e) {
    console.error('[admin/onedrive-backup]', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not fetch the OneDrive backup' },
      { status: 500 },
    );
  }
}
