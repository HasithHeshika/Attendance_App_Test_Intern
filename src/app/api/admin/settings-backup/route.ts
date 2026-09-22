import { NextRequest, NextResponse } from 'next/server';
import { FieldPath, Timestamp, GeoPoint, DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { adminAuth, adminDb, adminDbFor, tenantForRequest } from '@/lib/firebaseAdmin';
import { TENANTS_DB_ID, TENANTS_COLLECTION } from '@/lib/tenantRegistry';
import {
  SETTINGS_SOURCES, buildSettingsSnapshot, snapshotId, planRestore, canDeleteSnapshot,
  type SettingsSnapshot, type SettingsSnapshotCollection,
} from '@/lib/settingsBackup';

// firebase-admin needs the Node runtime (not Edge), and reading a dozen collections plus the
// write back into the tenants database takes a few seconds on a large tenant.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Settings backup — copies THIS tenant's configuration into the shared `tenants` database so a
 * tenant can be rebuilt if its own database is lost.
 *
 * What is copied is decided entirely by src/lib/settingsBackup.ts (SETTINGS_SOURCES and the
 * redaction rules around it), which is pure and unit-tested. This route reads, encodes and
 * stores; it never decides policy of its own, because a policy that lives in two places is a
 * policy that eventually leaks a secret from one of them.
 *
 * Layout in the tenants database:
 *   tenants/{tenantId}                                   ← pointer fields only, merged
 *   tenants/{tenantId}/settings_backups/{snapshotId}     ← the snapshot (or its manifest)
 *   tenants/{tenantId}/settings_backups/{snapshotId}/chunks/{n}
 */
const BACKUPS_SUBCOLLECTION = 'settings_backups';
const CHUNKS_SUBCOLLECTION  = 'chunks';

/**
 * A Firestore document is capped at 1 MiB including field names and overhead. 800 KB of
 * encoded JSON leaves a comfortable margin for that overhead, so this is the point at which
 * the snapshot stops being one document and becomes a manifest plus chunks.
 */
const CHUNK_LIMIT_BYTES = 800_000;

/** How many snapshots the history list returns. A list must stay small — it loads on a page. */
const LIST_LIMIT = 20;

// Tag-encode Firestore rich types so they survive JSON and round-trip on restore. Same shape
// as the encoder in /api/admin/backup and scripts/firestore-backup.mjs — keep the three in
// sync, and note that redactDocument() treats a `__fs__` object as a leaf for this reason.
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

/**
 * The inverse of encode(). A snapshot stores Firestore's rich types as tagged plain objects so
 * they survive JSON; writing them back untranslated would put `{__fs__:'timestamp',…}` maps
 * into live settings where a Timestamp belongs. Anything untagged passes through.
 */
function decode(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decode);
  const rec = v as Record<string, unknown>;
  switch (rec.__fs__) {
    case 'timestamp': return new Timestamp(Number(rec.seconds ?? 0), Number(rec.nanoseconds ?? 0));
    case 'geopoint':  return new GeoPoint(Number(rec.latitude ?? 0), Number(rec.longitude ?? 0));
    case 'bytes':     return Buffer.from(String(rec.base64 ?? ''), 'base64');
    // A reference is deliberately NOT rebuilt: its path belongs to the database the snapshot
    // was taken from, and silently re-pointing it at another one is worse than dropping it.
    case 'ref':       return null;
    default: {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(rec)) out[k] = decode(val);
      return out;
    }
  }
}

interface Caller { uid: string; epf: string; name: string }

/**
 * Verify the caller and require System Admin **of the tenant this request resolved to** — the
 * user lookup runs against adminDbFor(req), so an admin of one tenant is an anonymous stranger
 * on another's domain. Returns a status code instead of throwing so each failure keeps its own
 * meaning: 401 the token is not valid, 403 the person is not an admin here.
 */
async function verifyCaller(
  db: Firestore, idToken: unknown,
): Promise<{ caller: Caller } | { status: number; error: string }> {
  if (typeof idToken !== 'string' || !idToken) {
    return { status: 400, error: 'Missing idToken' };
  }

  let uid: string;
  try {
    uid = (await adminAuth().verifyIdToken(idToken)).uid;
  } catch {
    return { status: 401, error: 'Your session is not valid. Sign in again and retry.' };
  }

  const snap = await db.collection('users').where('uid', '==', uid).limit(1).get();
  const user = snap.empty ? null : snap.docs[0].data();
  const roleSnap = user?.role
    ? await db.collection('roles').where('name', '==', user.role).limit(1).get()
    : null;
  const role = roleSnap && !roleSnap.empty ? roleSnap.docs[0].data() : null;

  // A deactivated account keeps its Firebase Auth login, so the role check alone would still
  // let a former admin copy this tenant's configuration out. Only an explicit `false` denies:
  // older user documents predate the field and must not be locked out by its absence.
  if (!role?.is_system_admin || user?.is_active === false) {
    return { status: 403, error: 'System Admin access required.' };
  }

  return {
    caller: {
      uid,
      epf:  String(user?.epf_number ?? ''),
      name: String(user?.display_name ?? user?.epf_number ?? 'Unknown'),
    },
  };
}

/**
 * The snapshot's documents are stored as a JSON STRING, not as a nested map.
 *
 * They cannot be stored as a map: the encoder tags every rich Firestore value with a `__fs__`
 * key, and Firestore rejects any field name wrapped in double underscores as reserved
 * ("field name '__fs__' is reserved"). /api/admin/backup gets away with the same encoder
 * because it hands its JSON to the browser and never writes it back.
 *
 * A string also sidesteps every other shape rule a settings document could trip over — map
 * keys taken from document ids, the 20-level nesting limit, arrays inside arrays — and makes
 * splitting exact, because a string can always be cut where a map cannot.
 */

/**
 * Cut a JSON string into pieces that each fit in a document. Sliced by characters, sized so
 * that even an all-4-byte-per-character string stays under the limit — a byte-exact cut would
 * have to avoid splitting a surrogate pair, and being conservative costs one extra document.
 */
function splitJson(json: string): string[] {
  const perChunk = Math.floor(CHUNK_LIMIT_BYTES / 4);
  const parts: string[] = [];
  for (let i = 0; i < json.length; i += perChunk) parts.push(json.slice(i, i + perChunk));
  return parts;
}

/** Chunk ids sort lexicographically, so they are padded — "10" must not come before "2". */
const chunkDocId = (index: number): string => String(index).padStart(4, '0');

/** Everything about a snapshot except its documents — what the parent document always holds. */
type SnapshotMeta = Omit<SettingsSnapshot, 'collections'>;

async function runBackup(req: NextRequest, caller: Caller) {
  const tenant = tenantForRequest(req);
  const db     = adminDbFor(req);

  // Read every configuration collection this tenant has. A collection that does not exist
  // simply comes back empty — a tenant without payroll has no payroll_settings, and that is
  // not an error.
  const read = await Promise.all(SETTINGS_SOURCES.map(async source => {
    const snap = await db.collection(source.collection).get();
    return {
      collection: source.collection,
      docs: snap.docs.map(d => ({ id: d.id, data: encode(d.data()) })),
    };
  }));

  // The clock is read here, once, and handed to the pure builder — which is also what names
  // the document, so the id and the stored timestamp can never disagree.
  const takenAt = new Date().toISOString();
  const snapshot = buildSettingsSnapshot({
    tenant: { id: tenant.id, label: tenant.label, dbId: tenant.dbId },
    takenAt,
    actor: { epf: caller.epf, name: caller.name },
    read,
  });

  const id = snapshotId(takenAt);
  const { collections, ...meta } = snapshot;
  const doc = adminDb(TENANTS_DB_ID)
    .collection(TENANTS_COLLECTION).doc(tenant.id)
    .collection(BACKUPS_SUBCOLLECTION).doc(id);

  // The documents travel as one JSON string (see splitJson above for why).
  const json  = JSON.stringify(collections);
  const bytes = Buffer.byteLength(json, 'utf8');
  // A manifest of collection names, as real fields, so the history can say what a snapshot
  // holds without parsing it.
  const manifest = Object.keys(collections);
  let chunkCount = 0;

  if (bytes <= CHUNK_LIMIT_BYTES) {
    await doc.set({ ...meta, chunked: false, bytes, manifest, collections_json: json });
  } else {
    const parts = splitJson(json);
    // Chunks first, parent second: no reader may ever see a manifest pointing at documents
    // that are not there yet.
    await Promise.all(parts.map((part, i) =>
      doc.collection(CHUNKS_SUBCOLLECTION).doc(chunkDocId(i)).set({ index: i, part })
    ));
    chunkCount = parts.length;
    await doc.set({ ...meta, chunked: true, bytes, manifest, chunk_count: chunkCount });
  }

  // A pointer on the tenant document itself, so /platform can show "last backed up" without
  // reading the subcollection. Merged, and nothing else on that document is ever touched from
  // here — the tenant record is the registry, not this feature's scratch space.
  await adminDb(TENANTS_DB_ID).collection(TENANTS_COLLECTION).doc(tenant.id).set({
    last_settings_backup_at: takenAt,
    last_settings_backup_by: caller.name,
    last_settings_backup_totals: snapshot.totals,
  }, { merge: true });

  return {
    status: 200,
    body: {
      ok: true,
      id,
      taken_at: takenAt,
      taken_by_name: caller.name,
      totals: snapshot.totals,
      chunked: chunkCount > 0,
      chunks: chunkCount,
    },
  } as const;
}

/**
 * Put a snapshot's settings back into the tenant's own database.
 *
 * Two safety rules, both deliberate:
 *   • A fresh backup is taken FIRST. Restoring overwrites live configuration, and the only
 *     honest way to offer that is to make it undoable — the pre-restore snapshot is then the
 *     newest, which is also the one delete refuses to remove.
 *   • Documents are MERGED, never replaced wholesale, and nothing is deleted. Redacted fields
 *     are absent from the plan (see planRestore), so merging leaves the live credential in
 *     place instead of writing '[redacted]' over it, and a role or working place added since
 *     the backup survives.
 */
async function runRestore(req: NextRequest, caller: Caller, id: unknown) {
  if (typeof id !== 'string' || !id) return { status: 400, error: 'Missing snapshot id' } as const;

  const got = await getSnapshot(req, id);
  // Rebuilt rather than returned as-is: getSnapshot's success shape declares `error?: undefined`,
  // so an `in` check does not narrow it away and its snapshot variant would leak into this
  // function's return type.
  if (got.error !== undefined) return { status: got.status, error: got.error } as const;

  // Undo point. If this fails the restore does not proceed — an irreversible overwrite is not
  // something to attempt on the hope that the safety net worked.
  const safety = await runBackup(req, caller);
  if ('error' in safety) {
    return { status: 500, error: 'Could not take a safety backup first, so nothing was changed.' } as const;
  }

  const plan = planRestore(got.snapshot);
  const db = adminDbFor(req);

  // 400 writes per batch keeps well inside Firestore's 500-operation limit.
  const CHUNK = 400;
  for (let i = 0; i < plan.writes.length; i += CHUNK) {
    const batch = db.batch();
    for (const w of plan.writes.slice(i, i + CHUNK)) {
      const data = decode(w.data) as Record<string, unknown>;
      batch.set(db.collection(w.collection).doc(w.docId), data, { merge: true });
    }
    await batch.commit();
  }

  return {
    status: 200,
    body: {
      ok: true,
      restored_from: id,
      documents: plan.writes.length,
      collections: plan.collections,
      redacted_fields_left_alone: plan.redactedFields,
      safety_snapshot_id: (safety.body as { id?: string }).id ?? null,
      restored_by: caller.name,
    },
  } as const;
}

/**
 * Remove one snapshot and its chunks. The newest is refused: it is what an admin reaches for
 * when a restore went wrong, and after a restore it is the pre-restore undo point.
 */
async function deleteSnapshot(req: NextRequest, id: unknown) {
  if (typeof id !== 'string' || !id) return { status: 400, error: 'Missing snapshot id' } as const;

  const tenant = tenantForRequest(req);
  const parent = adminDb(TENANTS_DB_ID)
    .collection(TENANTS_COLLECTION).doc(tenant.id)
    .collection(BACKUPS_SUBCOLLECTION);

  const all = await parent.select().get();          // ids only
  const ids = all.docs.map(d => d.id);
  if (!ids.includes(id)) return { status: 404, error: 'That snapshot no longer exists.' } as const;
  if (!canDeleteSnapshot(id, ids)) {
    return {
      status: 409,
      error: ids.length <= 1
        ? 'This is your only settings backup, so it cannot be deleted.'
        : 'The most recent backup cannot be deleted — it is what you would restore from. Take a newer one first.',
    } as const;
  }

  const doc = parent.doc(id);
  const chunks = await doc.collection(CHUNKS_SUBCOLLECTION).select().get();
  if (chunks.docs.length) {
    const batch = adminDb(TENANTS_DB_ID).batch();
    chunks.docs.forEach(c => batch.delete(c.ref));
    await batch.commit();
  }
  await doc.delete();

  return { status: 200, body: { ok: true, deleted: id, remaining: ids.length - 1 } } as const;
}

async function listSnapshots(req: NextRequest) {
  const tenant = tenantForRequest(req);
  // No orderBy, deliberately. A projection (`select`) combined with an ordering on __name__ is
  // a composite query, and Firestore refuses it with FAILED_PRECONDITION until an index is
  // built — which is exactly what this route returned a 500 for on its first ever call. An
  // admin should never have to provision an index to read their own backup history, and a new
  // tenant would hit the same wall again.
  //
  // So: project the metadata (which keeps each row a few hundred bytes instead of up to 800 KB
  // of snapshot body), then sort and cut in memory. snapshotId() is the ISO timestamp with its
  // punctuation swapped, so a plain descending string sort is chronological. The read is
  // unbounded in principle, but a snapshot only exists because a human pressed Back up, and
  // the projection makes even hundreds of rows a small response.
  const snap = await adminDb(TENANTS_DB_ID)
    .collection(TENANTS_COLLECTION).doc(tenant.id)
    .collection(BACKUPS_SUBCOLLECTION)
    .select('taken_at', 'taken_by_name', 'taken_by_epf', 'totals', 'chunked', 'bytes')
    .get();

  const newestFirst = [...snap.docs]
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, LIST_LIMIT);

  return newestFirst.map(d => {
    const data = d.data();
    return {
      id: d.id,
      taken_at:      String(data.taken_at ?? ''),
      taken_by_name: String(data.taken_by_name ?? ''),
      taken_by_epf:  String(data.taken_by_epf ?? ''),
      totals: (data.totals as SettingsSnapshot['totals'] | undefined)
        ?? { collections: 0, documents: 0, skipped: 0 },
      chunked: data.chunked === true,
      bytes:   typeof data.bytes === 'number' ? data.bytes : 0,
    };
  });
}

async function getSnapshot(req: NextRequest, id: unknown) {
  if (typeof id !== 'string' || !id) return { status: 400, error: 'Missing snapshot id' } as const;

  const tenant = tenantForRequest(req);
  const doc = adminDb(TENANTS_DB_ID)
    .collection(TENANTS_COLLECTION).doc(tenant.id)
    .collection(BACKUPS_SUBCOLLECTION).doc(id);

  const snap = await doc.get();
  if (!snap.exists) return { status: 404, error: 'That snapshot no longer exists.' } as const;

  const data = snap.data() as (SnapshotMeta & {
    chunked?: boolean;
    collections_json?: string;
    /** Written by an older build that stored the documents as a nested map. */
    collections?: Record<string, SettingsSnapshotCollection>;
  });

  let collections: Record<string, SettingsSnapshotCollection> = {};
  if (data.chunked) {
    const chunks = await doc.collection(CHUNKS_SUBCOLLECTION).orderBy(FieldPath.documentId()).get();
    const json = chunks.docs.map(c => String(c.data().part ?? '')).join('');
    collections = json ? JSON.parse(json) : {};
  } else if (typeof data.collections_json === 'string') {
    collections = JSON.parse(data.collections_json);
  } else if (data.collections) {
    collections = data.collections;   // older shape, kept readable
  }

  const { chunked: _chunked, collections_json: _json, collections: _inline, ...meta } = data;
  return { status: 200, snapshot: { ...meta, collections } as SettingsSnapshot } as const;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { idToken, action, id } = body as { idToken?: unknown; action?: unknown; id?: unknown };

    const db = adminDbFor(req);
    const check = await verifyCaller(db, idToken);
    if ('status' in check) return NextResponse.json({ error: check.error }, { status: check.status });

    switch (action) {
      case 'backup': {
        const result = await runBackup(req, check.caller);
        if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status });
        return NextResponse.json(result.body);
      }
      case 'list':
        return NextResponse.json({ ok: true, snapshots: await listSnapshots(req) });
      case 'get': {
        const result = await getSnapshot(req, id);
        if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status });
        return NextResponse.json({ ok: true, snapshot: result.snapshot });
      }
      case 'restore': {
        const result = await runRestore(req, check.caller, id);
        if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status });
        return NextResponse.json(result.body);
      }
      case 'delete': {
        const result = await deleteSnapshot(req, id);
        if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status });
        return NextResponse.json(result.body);
      }
      default:
        return NextResponse.json(
          { error: 'Unknown action. Expected "backup", "list", "get", "restore" or "delete".' },
          { status: 400 },
        );
    }
  } catch (e) {
    console.error('[settings-backup]', e);
    // The detail goes back to the caller on purpose: this route is System-Admin-only, and a
    // bare "please try again" sent someone hunting for a Firestore rejection that the server
    // already knew the exact reason for.
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: 'The settings backup failed.', detail },
      { status: 500 },
    );
  }
}

/**
 * GET is the history list, for a caller that would rather not POST to read. The token still
 * comes in the body-less way it can: as an `idToken` query parameter is not acceptable (it
 * would land in access logs), so GET takes the Authorization header instead.
 */
export async function GET(req: NextRequest) {
  try {
    const header = req.headers.get('authorization') ?? '';
    const idToken = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';

    const db = adminDbFor(req);
    const check = await verifyCaller(db, idToken);
    if ('status' in check) return NextResponse.json({ error: check.error }, { status: check.status });

    return NextResponse.json({ ok: true, snapshots: await listSnapshots(req) });
  } catch (e) {
    console.error('[settings-backup:list]', e);
    return NextResponse.json({ error: 'Could not load the backup history.' }, { status: 500 });
  }
}
