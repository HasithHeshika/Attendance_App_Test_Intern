import { NextRequest, NextResponse } from 'next/server';
import { adminAuth, adminDbFor } from '@/lib/firebaseAdmin';
import { Timestamp, GeoPoint } from 'firebase-admin/firestore';
import type { Firestore, DocumentData } from 'firebase-admin/firestore';

// firebase-admin needs the Node runtime (not Edge).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Rebuild the Firestore rich types the backup tag-encoded. Mirrors decode() in
// scripts/firestore-backup.mjs and encode() in the /api/admin/backup route.
function decode(v: unknown, db: Firestore): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => decode(x, db));
  const obj = v as Record<string, unknown>;
  switch (obj.__fs__) {
    case 'timestamp': return new Timestamp(obj.seconds as number, obj.nanoseconds as number);
    case 'geopoint':  return new GeoPoint(obj.latitude as number, obj.longitude as number);
    case 'ref':       return db.doc(obj.path as string);
    case 'bytes':     return Buffer.from(obj.base64 as string, 'base64');
    default: {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(obj)) o[k] = decode(val, db);
      return o;
    }
  }
}

interface Item { c: string; id: string; data: unknown }

export async function POST(req: NextRequest) {
  try {
    const { idToken, chunk } = (await req.json()) as { idToken?: string; chunk?: Item[] };
    if (!idToken) return NextResponse.json({ error: 'Missing idToken' }, { status: 400 });
    if (!Array.isArray(chunk) || chunk.length === 0) {
      return NextResponse.json({ error: 'Empty chunk' }, { status: 400 });
    }
    if (chunk.length > 450) {
      return NextResponse.json({ error: 'Chunk too large (max 450)' }, { status: 400 });
    }

    const auth = adminAuth();
    const db   = adminDbFor(req);

    // Verify the caller, then require System Admin — this rewrites live data.
    let callerUid: string;
    try {
      callerUid = (await auth.verifyIdToken(idToken)).uid;
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

    // Write the chunk in one batch (Firestore batch limit is 500; chunk is capped above).
    const batch = db.batch();
    for (const item of chunk) {
      if (!item.c || !item.id) continue;
      batch.set(db.collection(item.c).doc(item.id), decode(item.data, db) as DocumentData);
    }
    await batch.commit();

    return NextResponse.json({ written: chunk.length });
  } catch (e) {
    console.error('[restore]', e);
    return NextResponse.json({ error: 'Restore failed' }, { status: 500 });
  }
}
