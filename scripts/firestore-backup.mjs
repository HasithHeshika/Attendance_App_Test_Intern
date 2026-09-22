/**
 * firestore-backup.mjs — Firestore backup (download) & restore (upload)
 *
 * Uses the Firebase Admin SDK (service account from .env.local), so it reads and
 * writes ALL data regardless of Firestore security rules — a complete, faithful
 * copy. This is NOT the seed importer (upload-to-firebase.mjs); it snapshots and
 * restores your real, existing data.
 *
 * Credentials (from .env.local, same vars the app uses):
 *   FIREBASE_ADMIN_PROJECT_ID
 *   FIREBASE_ADMIN_CLIENT_EMAIL
 *   FIREBASE_ADMIN_PRIVATE_KEY   (raw PEM, escaped \n, base64, or quoted — all OK)
 *   FIRESTORE_DB_ID              (named DB, e.g. "test"; empty = default/prod)
 *
 * ── Backup (download) ────────────────────────────────────────────────────────
 *   node scripts/firestore-backup.mjs backup
 *   node scripts/firestore-backup.mjs backup --db "(default)"        # back up prod
 *   node scripts/firestore-backup.mjs backup --collections attendances,users
 *   node scripts/firestore-backup.mjs backup --out backups/my-snapshot.json
 *   → writes backups/firestore-<project>-<db>-<timestamp>.json
 *
 * ── Restore (upload) ─────────────────────────────────────────────────────────
 *   node scripts/firestore-backup.mjs restore                        # dry-run, latest backup
 *   node scripts/firestore-backup.mjs restore --file backups/foo.json --yes
 *   node scripts/firestore-backup.mjs restore --db test --yes        # restore INTO test
 *   node scripts/firestore-backup.mjs restore --file foo.json --yes --clear
 *   node scripts/firestore-backup.mjs restore --file foo.json --yes --merge
 *
 *   Safety: restore does a DRY RUN unless --yes is given. Restoring into the
 *   default/prod database additionally requires --allow-prod. --clear (wipe target
 *   collections first) requires --yes.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { initializeApp, cert } from 'firebase-admin/app';
import {
  getFirestore, Timestamp, GeoPoint, DocumentReference, FieldPath,
} from 'firebase-admin/firestore';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dir, '..');
const BACKUP_DIR = resolve(ROOT, 'backups');

// ─── .env.local loader (matches the other scripts — no dotenv dependency) ───────
function loadEnv(path) {
  if (!existsSync(path)) return {};
  const env = {};
  // Split on \r?\n so CRLF files (Windows) don't leave a trailing \r that breaks
  // the value match — JS `.` doesn't match \r and `$` won't anchor before it.
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}
const env = { ...loadEnv(resolve(ROOT, '.env')), ...loadEnv(resolve(ROOT, '.env.local')) };

// ─── Private-key normaliser (copied from src/lib/firebaseAdmin.ts) ──────────────
function normalizePrivateKey(raw) {
  if (!raw) return undefined;
  let k = raw.trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }
  if (!k.includes('BEGIN PRIVATE KEY')) {
    try {
      const decoded = Buffer.from(k, 'base64').toString('utf8');
      if (decoded.includes('BEGIN PRIVATE KEY')) k = decoded.trim();
    } catch { /* not base64 */ }
  }
  return k.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
}

// ─── CLI args ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const command = argv[0];
function flag(name)       { return argv.includes(`--${name}`); }
function opt(name, def)   {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}

// ─── Firestore Admin init ───────────────────────────────────────────────────────
function initDb(dbIdOverride) {
  const projectId   = env.FIREBASE_ADMIN_PROJECT_ID   || process.env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = env.FIREBASE_ADMIN_CLIENT_EMAIL || process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey  = normalizePrivateKey(env.FIREBASE_ADMIN_PRIVATE_KEY || process.env.FIREBASE_ADMIN_PRIVATE_KEY);

  if (!projectId || !clientEmail || !privateKey) {
    console.error('ERROR: Firebase Admin credentials missing (FIREBASE_ADMIN_* in .env.local).');
    process.exit(1);
  }
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    console.error('ERROR: FIREBASE_ADMIN_PRIVATE_KEY malformed (no PEM header after normalisation).');
    process.exit(1);
  }

  const app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  // Resolve the target database: --db flag > FIRESTORE_DB_ID env > default.
  const dbId = (dbIdOverride ?? (env.FIRESTORE_DB_ID || process.env.FIRESTORE_DB_ID) ?? '').trim();
  const normalised = dbId === '(default)' ? '' : dbId;   // "(default)" means the default DB
  const db = normalised ? getFirestore(app, normalised) : getFirestore(app);
  return { db, projectId, dbLabel: normalised || 'default' };
}

// ─── Type-faithful (de)serialization ────────────────────────────────────────────
// Firestore rich types don't survive plain JSON — tag them so restore rebuilds them.
function encode(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Timestamp)         return { __fs__: 'timestamp', seconds: v.seconds, nanoseconds: v.nanoseconds };
  if (v instanceof GeoPoint)          return { __fs__: 'geopoint', latitude: v.latitude, longitude: v.longitude };
  if (v instanceof DocumentReference) return { __fs__: 'ref', path: v.path };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { __fs__: 'bytes', base64: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(encode);
  if (typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = encode(val);
    return o;
  }
  return v; // string | number | boolean
}

function decode(v, db) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => decode(x, db));
  switch (v.__fs__) {
    case 'timestamp': return new Timestamp(v.seconds, v.nanoseconds);
    case 'geopoint':  return new GeoPoint(v.latitude, v.longitude);
    case 'ref':       return db.doc(v.path);
    case 'bytes':     return Buffer.from(v.base64, 'base64');
    default: {
      const o = {};
      for (const [k, val] of Object.entries(v)) o[k] = decode(val, db);
      return o;
    }
  }
}

// ─── BACKUP ─────────────────────────────────────────────────────────────────────
async function doBackup() {
  const { db, projectId, dbLabel } = initDb(opt('db'));
  const only = opt('collections');
  const wanted = only ? only.split(',').map(s => s.trim()).filter(Boolean) : null;

  console.log(`\n── Firestore backup ──────────────────────────────`);
  console.log(`  Project:  ${projectId}`);
  console.log(`  Database: ${dbLabel}`);

  // Auto-discover root collections (flat schema) unless a subset was requested.
  const roots = await db.listCollections();
  let names = roots.map(c => c.id);
  if (wanted) names = names.filter(n => wanted.includes(n));
  names.sort();

  if (!names.length) {
    console.error('  No collections found to back up.');
    process.exit(1);
  }
  console.log(`  Collections: ${names.join(', ')}\n`);

  const collections = {};
  const counts = {};
  for (const name of names) {
    const snap = await db.collection(name).get();
    const docs = {};
    snap.forEach(d => { docs[d.id] = encode(d.data()); });
    collections[name] = docs;
    counts[name] = snap.size;
    console.log(`  ${name.padEnd(28)} ${snap.size} docs`);
  }

  const backup = {
    __firestore_backup__: true,
    version: 1,
    project_id: projectId,
    database_id: dbLabel,
    created_at: new Date().toISOString(),
    counts,
    collections,
  };

  // Resolve output path.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const defaultName = `firestore-${projectId}-${dbLabel}-${stamp}.json`;
  const outPath = opt('out') ? resolve(ROOT, opt('out')) : join(BACKUP_DIR, defaultName);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(backup, null, 2), 'utf8');

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const sizeMB = (statSync(outPath).size / 1e6).toFixed(2);
  console.log(`\n✓ Backed up ${total} documents (${sizeMB} MB)`);
  console.log(`  → ${outPath}\n`);
}

// ─── RESTORE ────────────────────────────────────────────────────────────────────
function latestBackupFile() {
  if (!existsSync(BACKUP_DIR)) return null;
  const files = readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ f, m: statSync(join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? join(BACKUP_DIR, files[0].f) : null;
}

async function doRestore() {
  const filePath = opt('file') ? resolve(ROOT, opt('file')) : latestBackupFile();
  if (!filePath || !existsSync(filePath)) {
    console.error('ERROR: no backup file. Pass --file <path> or put one in backups/.');
    process.exit(1);
  }

  const backup = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!backup.__firestore_backup__) {
    console.error(`ERROR: ${filePath} is not a backup produced by this tool.`);
    process.exit(1);
  }

  const { db, projectId, dbLabel } = initDb(opt('db'));
  const YES       = flag('yes');
  const CLEAR     = flag('clear');
  const MERGE     = flag('merge');
  const ALLOWPROD = flag('allow-prod');
  const only      = opt('collections');
  const wanted    = only ? only.split(',').map(s => s.trim()).filter(Boolean) : null;

  let names = Object.keys(backup.collections);
  if (wanted) names = names.filter(n => wanted.includes(n));
  names.sort();

  console.log(`\n── Firestore restore ─────────────────────────────`);
  console.log(`  Source file:  ${filePath}`);
  console.log(`  From:         ${backup.project_id} / ${backup.database_id}  (${backup.created_at})`);
  console.log(`  Restore INTO: ${projectId} / ${dbLabel}`);
  console.log(`  Mode:         ${MERGE ? 'merge (patch fields)' : 'overwrite (full set)'}${CLEAR ? ' + CLEAR target first' : ''}`);
  console.log('');
  for (const name of names) {
    console.log(`  ${name.padEnd(28)} ${Object.keys(backup.collections[name]).length} docs`);
  }
  console.log('');

  // Guard: writing to the default/prod DB needs an explicit extra flag.
  if (dbLabel === 'default' && !ALLOWPROD) {
    console.error('REFUSING to write to the DEFAULT (production) database without --allow-prod.');
    console.error('Add --allow-prod if you really mean to restore into prod.');
    process.exit(1);
  }

  if (!YES) {
    console.log('DRY RUN — nothing written. Re-run with --yes to perform the restore.');
    process.exit(0);
  }

  // Optional wipe of target collections before restore.
  if (CLEAR) {
    for (const name of names) {
      const snap = await db.collection(name).get();
      let deleted = 0;
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = db.batch();
        snap.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
        await batch.commit();
        deleted += Math.min(400, snap.docs.length - i);
      }
      console.log(`  cleared ${name}: ${deleted} deleted`);
    }
    console.log('');
  }

  // Write each collection in batches (Admin SDK batch limit is 500 → use 400).
  let totalWritten = 0;
  for (const name of names) {
    const entries = Object.entries(backup.collections[name]);
    let written = 0;
    for (let i = 0; i < entries.length; i += 400) {
      const batch = db.batch();
      for (const [id, data] of entries.slice(i, i + 400)) {
        batch.set(db.collection(name).doc(id), decode(data, db), MERGE ? { merge: true } : {});
      }
      await batch.commit();
      written += Math.min(400, entries.length - i);
      process.stdout.write(`\r  ${name.padEnd(28)} ${written}/${entries.length}`);
    }
    console.log(`\r  ${name.padEnd(28)} ✓ ${entries.length} docs restored     `);
    totalWritten += entries.length;
  }

  console.log(`\n✓ Restored ${totalWritten} documents into ${projectId} / ${dbLabel}\n`);
}

// ─── Entry ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    if (command === 'backup')       await doBackup();
    else if (command === 'restore') await doRestore();
    else {
      console.log('Usage:');
      console.log('  node scripts/firestore-backup.mjs backup  [--db <id>] [--collections a,b] [--out path]');
      console.log('  node scripts/firestore-backup.mjs restore [--file path] [--db <id>] [--yes] [--clear] [--merge] [--allow-prod] [--collections a,b]');
      process.exit(command ? 1 : 0);
    }
    process.exit(0);
  } catch (err) {
    console.error('\n✗ Failed:', err?.message || err);
    process.exit(1);
  }
})();
