import { NextRequest, NextResponse } from 'next/server';
import { adminAuth, adminDbFor, tenantForRequest } from '@/lib/firebaseAdmin';
import { Timestamp, GeoPoint, DocumentReference } from 'firebase-admin/firestore';

// firebase-admin needs the Node runtime (not Edge); backups can also run a few seconds.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Tag-encode Firestore rich types so they survive JSON and round-trip on restore.
// Mirrors the encoder in scripts/firestore-backup.mjs — keep the two in sync.
function encode(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Timestamp)         return { __fs__: 'timestamp', seconds: v.seconds, nanoseconds: v.nanoseconds };
  if (v instanceof GeoPoint)          return { __fs__: 'geopoint', latitude: v.latitude, longitude: v.longitude };
  if (v instanceof DocumentReference) return { __fs__: 'ref', path: v.path };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { __fs__: 'bytes', base64: Buffer.from(v as Uint8Array).toString('base64') };
  if (Array.isArray(v)) return v.map(encode);
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = encode(val);
    return o;
  }
  return v; // string | number | boolean
}

export async function POST(req: NextRequest) {
  try {
    const { idToken } = await req.json();
    if (!idToken) {
      return NextResponse.json({ error: 'Missing idToken' }, { status: 400 });
    }

    const auth = adminAuth();
    const db   = adminDbFor(req);

    // Verify the caller, then require System Admin — this exports ALL employee data.
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
    if (!roleData?.is_system_admin) {
      return NextResponse.json({ error: 'System Admin access required' }, { status: 403 });
    }

    // Snapshot every root collection of the database THIS REQUEST resolved to — one
    // deployment serves several domains, so the backup follows the caller's tenant
    // (adminDbFor(req)), not a build-time env var.
    const roots = await db.listCollections();
    const collections: Record<string, Record<string, unknown>> = {};
    const counts: Record<string, number> = {};
    for (const col of roots) {
      const snap = await col.get();
      const docs: Record<string, unknown> = {};
      snap.forEach(d => { docs[d.id] = encode(d.data()); });
      collections[col.id] = docs;
      counts[col.id] = snap.size;
    }

    const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID || 'firestore';
    // Label the file with the tenant database actually dumped, so an altavision.lk backup
    // and a carecode.org one can never be mistaken for each other.
    const dbLabel   = tenantForRequest(req).dbId || 'default';
    const stamp     = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename  = `firestore-${projectId}-${dbLabel}-${stamp}.json`;

    const payload = {
      __firestore_backup__: true,
      version: 1,
      project_id: projectId,
      database_id: dbLabel,
      created_at: new Date().toISOString(),
      counts,
      collections,
    };

    // Stream back as a file download. Restore with scripts/firestore-backup.mjs.
    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    console.error('[backup]', e);
    return NextResponse.json({ error: 'Backup failed' }, { status: 500 });
  }
}
