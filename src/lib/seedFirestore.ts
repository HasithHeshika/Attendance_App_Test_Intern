/**
 * seedFirestore.ts
 *
 * Handles uploading a firestore-seed.json snapshot to Firestore and
 * resetting Firestore back to a previously uploaded baseline.
 *
 * Each import writes:
 *   - All collections from the JSON
 *   - A metadata record in _seed_meta/{id} so we can restore later
 *
 * "Reset to baseline" deletes the live data and re-imports the baseline snapshot.
 *
 * IMPORTANT: This runs entirely client-side via the Firestore SDK.
 * For large datasets (>500 docs per collection) it batches writes.
 */

import {
  collection, doc, setDoc, deleteDoc, getDocs,
  writeBatch, Timestamp, getDoc,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';

export interface SeedMeta {
  id:          string;
  imported_at: string;
  source_file: string;
  counts:      Record<string, number>;
  // Full snapshot kept so a baseline can be restored. Firestore caps a single document
  // at ~1 MiB, so a large snapshot is NOT inlined here — it is split across chunk docs in
  // the `_seed_meta/{id}/snapshot_chunks` subcollection and `snapshot_chunks` holds the count.
  snapshot?:        SeedSnapshot;   // present only for snapshots small enough to inline
  snapshot_chunks?: number;         // number of chunk docs when the snapshot was split
}

// Firestore hard-caps one document at 1,048,576 bytes. We keep headroom for field
// overhead, so anything bigger is chunked. Chunk size is in CHARACTERS but sized so
// that even all-3-byte (e.g. Sinhala/Tamil) text stays well under the per-doc limit.
const MAX_INLINE_SNAPSHOT_BYTES = 800_000;
const SNAPSHOT_CHUNK_CHARS      = 250_000;

export interface SeedSnapshot {
  _meta:                    Record<string, unknown>;
  companies:                Record<string, unknown>;
  users:                    Record<string, unknown>;
  leave_types:              Record<string, unknown>;
  attendances:              Record<string, unknown>;
  attendance_edit_requests: Record<string, unknown>;
  leaves:                   Record<string, unknown>;
  outstation_locations:     Record<string, unknown>;
}

// Collections that should be managed by seed/reset
const SEED_COLLECTIONS = [
  'companies',
  'users',
  'leave_types',
  'attendances',
  'attendance_edit_requests',
  'leaves',
  'outstation_locations',
] as const;

// Convert ISO timestamp strings → Firestore Timestamps recursively
function convertTimestamps(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // ISO datetime: "2026-05-14T10:11:08.000Z"
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(obj)) {
      const d = new Date(obj);
      if (!isNaN(d.getTime())) return Timestamp.fromDate(d);
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(convertTimestamps);
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      // Strip migration-only fields
      if (k === '_needs_auth' || k === '_original_password_hash' || k === '_legacy_id') continue;
      out[k] = convertTimestamps(v);
    }
    return out;
  }
  return obj;
}

// Write documents in batches of 400 (Firestore limit: 500 per batch)
async function batchWrite(
  collectionName: string,
  docs: Record<string, Record<string, unknown>>,
  onProgress?: (done: number, total: number) => void
) {
  const entries = Object.entries(docs);
  const total   = entries.length;
  let done      = 0;

  for (let i = 0; i < entries.length; i += 400) {
    const batch = writeBatch(db);
    const chunk = entries.slice(i, i + 400);
    for (const [id, data] of chunk) {
      const ref  = doc(db, collectionName, id);
      const converted = convertTimestamps(data) as Record<string, unknown>;
      batch.set(ref, converted);
    }
    await batch.commit();
    done += chunk.length;
    onProgress?.(done, total);
  }
}

// Delete all documents in a collection
async function clearCollection(
  collectionName: string,
  onProgress?: (done: number, total: number) => void
) {
  const snap  = await getDocs(collection(db, collectionName));
  const total = snap.docs.length;
  let done    = 0;

  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = writeBatch(db);
    const chunk = snap.docs.slice(i, i + 400);
    for (const d of chunk) batch.delete(d.ref);
    await batch.commit();
    done += chunk.length;
    onProgress?.(done, total);
  }
  return total;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export interface ProgressEvent {
  stage:   string;
  done:    number;
  total:   number;
  percent: number;
}

export type ProgressCallback = (evt: ProgressEvent) => void;

/**
 * Upload a seed JSON snapshot to Firestore.
 * Stores the full snapshot in _seed_meta/baseline so it can be restored later.
 */
export async function uploadSeed(
  snapshot: SeedSnapshot,
  sourceFileName: string,
  onProgress?: ProgressCallback,
): Promise<string> {
  const metaId   = `baseline_${Date.now()}`;
  const counts: Record<string, number> = {};

  for (const col of SEED_COLLECTIONS) {
    const docs = snapshot[col] as Record<string, Record<string, unknown>> | undefined;
    if (!docs || Object.keys(docs).length === 0) { counts[col] = 0; continue; }

    const total = Object.keys(docs).length;
    counts[col] = total;

    await batchWrite(col, docs, (done, t) => {
      onProgress?.({ stage: col, done, total: t, percent: Math.round((done / t) * 100) });
    });
  }

  // Store metadata + the full snapshot for restore capability. Inline the snapshot when
  // it fits under the per-document limit; otherwise split it across chunk docs so the
  // baseline still saves (and can still be restored) for large migrations.
  const metaBase = {
    id:          metaId,
    imported_at: new Date().toISOString(),
    source_file: sourceFileName,
    counts,
  };

  const json  = JSON.stringify(snapshot);
  const bytes = new TextEncoder().encode(json).length;

  if (bytes <= MAX_INLINE_SNAPSHOT_BYTES) {
    await setDoc(doc(db, '_seed_meta', metaId), { ...metaBase, snapshot });
  } else {
    onProgress?.({ stage: 'Saving baseline', done: 0, total: 1, percent: 99 });
    const chunks: string[] = [];
    for (let i = 0; i < json.length; i += SNAPSHOT_CHUNK_CHARS) {
      chunks.push(json.slice(i, i + SNAPSHOT_CHUNK_CHARS));
    }
    // Chunk count is small (a few MB / 250k chars), so one batch stays well within limits.
    const batch = writeBatch(db);
    chunks.forEach((data, i) => {
      batch.set(doc(db, '_seed_meta', metaId, 'snapshot_chunks', String(i)), { i, data });
    });
    await batch.commit();
    await setDoc(doc(db, '_seed_meta', metaId), { ...metaBase, snapshot_chunks: chunks.length });
  }

  return metaId;
}

// Reassemble the snapshot for a baseline — inline when present, else from chunk docs.
async function loadSnapshot(metaId: string, meta: SeedMeta): Promise<SeedSnapshot> {
  if (meta.snapshot) return meta.snapshot;
  if (meta.snapshot_chunks && meta.snapshot_chunks > 0) {
    const snap  = await getDocs(collection(db, '_seed_meta', metaId, 'snapshot_chunks'));
    const parts = snap.docs
      .map(d => d.data() as { i: number; data: string })
      .sort((a, b) => a.i - b.i)
      .map(p => p.data);
    return JSON.parse(parts.join('')) as SeedSnapshot;
  }
  throw new Error('This baseline has no stored snapshot to restore from. Re-import the JSON file instead.');
}

/**
 * Get all stored seed baselines (sorted newest first).
 */
export async function getSeedBaselines(): Promise<SeedMeta[]> {
  const snap = await getDocs(collection(db, '_seed_meta'));
  const list = snap.docs.map(d => d.data() as SeedMeta);
  return list.sort((a, b) => new Date(b.imported_at).getTime() - new Date(a.imported_at).getTime());
}

/**
 * Delete a seed baseline record (does NOT touch live data).
 */
export async function deleteSeedBaseline(metaId: string): Promise<void> {
  // Remove any snapshot chunk docs first, then the meta doc.
  try {
    const chunks = await getDocs(collection(db, '_seed_meta', metaId, 'snapshot_chunks'));
    if (!chunks.empty) {
      const batch = writeBatch(db);
      chunks.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  } catch { /* no chunk subcollection — nothing to clean */ }
  await deleteDoc(doc(db, '_seed_meta', metaId));
}

/**
 * Reset Firestore to a previously uploaded baseline.
 * Clears all seed-managed collections, then re-imports the baseline snapshot.
 */
export async function resetToBaseline(
  metaId: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  // Fetch the baseline (snapshot may be inline or split across chunk docs)
  const metaDoc = await getDoc(doc(db, '_seed_meta', metaId));
  if (!metaDoc.exists()) throw new Error(`Baseline ${metaId} not found`);
  const meta = metaDoc.data() as SeedMeta;
  const baselineSnapshot = await loadSnapshot(metaId, meta);

  // 1. Clear live collections
  let clearStage = 0;
  const totalClear = SEED_COLLECTIONS.length;
  for (const col of SEED_COLLECTIONS) {
    clearStage++;
    const deleted = await clearCollection(col, (done, total) => {
      onProgress?.({
        stage: `Clearing ${col}`,
        done,
        total,
        percent: Math.round(((clearStage - 1 + done / Math.max(total, 1)) / totalClear) * 50),
      });
    });
    onProgress?.({
      stage: `Cleared ${col} (${deleted} docs)`,
      done:  clearStage,
      total: totalClear,
      percent: Math.round((clearStage / totalClear) * 50),
    });
  }

  // 2. Re-import baseline snapshot
  const snapshot = baselineSnapshot;
  let writeStage = 0;
  const totalWrite = SEED_COLLECTIONS.length;
  for (const col of SEED_COLLECTIONS) {
    writeStage++;
    const docs = snapshot[col] as Record<string, Record<string, unknown>> | undefined;
    if (!docs || Object.keys(docs).length === 0) continue;
    const total = Object.keys(docs).length;

    await batchWrite(col, docs, (done, t) => {
      onProgress?.({
        stage:   `Restoring ${col}`,
        done,
        total:   t,
        percent: 50 + Math.round(((writeStage - 1 + done / Math.max(t, 1)) / totalWrite) * 50),
      });
    });
    onProgress?.({
      stage:   `Restored ${col} (${total} docs)`,
      done:    writeStage,
      total:   totalWrite,
      percent: 50 + Math.round((writeStage / totalWrite) * 50),
    });
  }
}

/**
 * Clear ALL seed-managed collections (wipe live data — no restore).
 */
export async function clearAllData(onProgress?: ProgressCallback): Promise<void> {
  await clearCollections(SEED_COLLECTIONS, onProgress);
}

// Operational/transactional collections — wiped by "clear data, keep users". Excludes
// users and all config (companies, leave_types, outstation_locations, working_places, roles).
const LIVE_DATA_COLLECTIONS = [
  'attendances',
  'attendance_edit_requests',
  'leaves',
  'tasks',
  'shift_assignments',
] as const;

/**
 * Clear attendance, leaves, edit requests, tasks and shift periods — keeping users
 * and all settings/config intact.
 */
export async function clearLiveDataKeepUsers(onProgress?: ProgressCallback): Promise<void> {
  await clearCollections(LIVE_DATA_COLLECTIONS, onProgress);
}

// Clear a list of collections in sequence, reporting overall progress.
async function clearCollections(cols: readonly string[], onProgress?: ProgressCallback): Promise<void> {
  let stage = 0;
  const total = cols.length;
  for (const col of cols) {
    stage++;
    await clearCollection(col, (done, t) => {
      onProgress?.({
        stage:   `Clearing ${col}`,
        done,
        total:   t,
        percent: Math.round(((stage - 1 + done / Math.max(t, 1)) / total) * 100),
      });
    });
    onProgress?.({ stage: `Cleared ${col}`, done: stage, total, percent: Math.round((stage / total) * 100) });
  }
}
