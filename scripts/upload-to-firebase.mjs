/**
 * upload-to-firebase.mjs
 *
 * Uploads firestore-seed.json directly to Firebase Firestore using
 * the Firebase client SDK (no Admin SDK / service account needed).
 *
 * Reads credentials from .env.local in the project root.
 * Run: node scripts/upload-to-firebase.mjs
 *
 * Flags:
 *   --clear   Clear all existing data before uploading
 *   --dry-run Show what would be uploaded without writing
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dir, '..');

// ─── Load .env.local ──────────────────────────────────────────────────────────
function loadEnv(path) {
  if (!existsSync(path)) return {};
  const env = {};
  readFileSync(path, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
  return env;
}

const env = { ...loadEnv(resolve(ROOT, '.env.local')), ...loadEnv(resolve(ROOT, '.env')) };

const FIREBASE_CONFIG = {
  apiKey:            env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain:        env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId:         env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket:     env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId:             env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

if (!FIREBASE_CONFIG.projectId) {
  console.error('ERROR: Firebase config not found in .env.local');
  console.error('Make sure NEXT_PUBLIC_FIREBASE_PROJECT_ID is set.');
  process.exit(1);
}

console.log(`Firebase project: ${FIREBASE_CONFIG.projectId}`);

// ─── Load seed data ───────────────────────────────────────────────────────────
const seedPath = resolve(__dir, 'firestore-seed.json');
if (!existsSync(seedPath)) {
  console.error('ERROR: firestore-seed.json not found. Run convert-sql.mjs first.');
  process.exit(1);
}

const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CLEAR   = args.includes('--clear');

// ─── Dynamic import Firebase ──────────────────────────────────────────────────
const { initializeApp, getApps } = await import('firebase/app');
const {
  getFirestore, collection, doc, setDoc, deleteDoc,
  getDocs, writeBatch, Timestamp,
} = await import('firebase/firestore');
const { getAuth, signInWithEmailAndPassword } = await import('firebase/auth');

// Check if we need to authenticate
const UPLOAD_EMAIL    = env.FIREBASE_UPLOAD_EMAIL    || env.NEXT_PUBLIC_FIREBASE_UPLOAD_EMAIL;
const UPLOAD_PASSWORD = env.FIREBASE_UPLOAD_PASSWORD || env.NEXT_PUBLIC_FIREBASE_UPLOAD_PASSWORD;

const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
const db  = getFirestore(app);
const fbAuth = getAuth(app);

// Sign in if credentials provided
if (UPLOAD_EMAIL && UPLOAD_PASSWORD) {
  console.log(`Signing in as ${UPLOAD_EMAIL}...`);
  try {
    await signInWithEmailAndPassword(fbAuth, UPLOAD_EMAIL, UPLOAD_PASSWORD);
    console.log('Signed in successfully.');
  } catch (e) {
    console.warn(`Auth warning: ${e.message} — proceeding without auth (requires open Firestore rules)`);
  }
} else {
  console.log('No FIREBASE_UPLOAD_EMAIL set — uploading without auth.');
  console.log('Make sure Firestore rules allow writes, or add these to .env.local:');
  console.log('  FIREBASE_UPLOAD_EMAIL=admin@yourdomain.com');
  console.log('  FIREBASE_UPLOAD_PASSWORD=yourpassword');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function convertTimestamps(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(obj)) {
      const d = new Date(obj);
      if (!isNaN(d.getTime())) return Timestamp.fromDate(d);
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(convertTimestamps);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      // Strip migration-only fields
      if (['_needs_auth', '_original_password_hash', '_legacy_id', '_meta'].includes(k)) continue;
      out[k] = convertTimestamps(v);
    }
    return out;
  }
  return obj;
}

async function clearCollection(colName) {
  console.log(`  Clearing ${colName}...`);
  const snap = await getDocs(collection(db, colName));
  if (snap.empty) { console.log(`    (empty)`); return 0; }
  let deleted = 0;
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = writeBatch(db);
    snap.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
    await batch.commit();
    deleted += Math.min(400, snap.docs.length - i);
  }
  console.log(`    Deleted ${deleted} documents`);
  return deleted;
}

async function batchWrite(colName, docs) {
  const entries = Object.entries(docs);
  if (entries.length === 0) { console.log(`    (empty — skipping)`); return; }

  let written = 0;
  for (let i = 0; i < entries.length; i += 400) {
    const batch = writeBatch(db);
    const chunk = entries.slice(i, i + 400);
    for (const [id, data] of chunk) {
      const converted = convertTimestamps(data);
      batch.set(doc(db, colName, id), converted);
    }
    await batch.commit();
    written += chunk.length;
    process.stdout.write(`\r    Written ${written}/${entries.length}...`);
  }
  console.log(`\r    ✓ ${entries.length} documents written`);
}

// ─── Collections to upload ────────────────────────────────────────────────────
const COLLECTIONS = [
  ['companies',                seed.companies],
  ['leave_types',              seed.leave_types],
  ['users',                    seed.users],
  ['attendances',              seed.attendances],
  ['attendance_edit_requests', seed.attendance_edit_requests],
  ['leaves',                   seed.leaves],
  ['outstation_locations',     seed.outstation_locations ?? {}],
];

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n── Data to upload ────────────────────────────────');
for (const [name, data] of COLLECTIONS) {
  const count = Object.keys(data ?? {}).length;
  console.log(`  ${name.padEnd(30)} ${count} docs`);
}

// Print unique outstation names from old data so admin knows what to create
const outstations = seed._meta?.unique_outstations ?? [];
if (outstations.length > 0) {
  console.log(`\n── Outstation names found in old data ────────────`);
  console.log(`  (Create these in Admin → Outstation Locations after upload)`);
  outstations.forEach(n => console.log(`  - ${n}`));
}
console.log('──────────────────────────────────────────────────\n');

if (DRY_RUN) {
  console.log('DRY RUN — no data written. Remove --dry-run to upload.');
  process.exit(0);
}

// ─── Clear existing data if requested ─────────────────────────────────────────
if (CLEAR) {
  console.log('Clearing existing Firestore data...');
  for (const [name] of COLLECTIONS) {
    await clearCollection(name);
  }
  console.log('');
}

// ─── Upload ───────────────────────────────────────────────────────────────────
console.log('Uploading to Firestore...');
for (const [name, data] of COLLECTIONS) {
  if (!data || Object.keys(data).length === 0) continue;
  console.log(`\n  ${name}`);
  await batchWrite(name, data);
}

// ─── Save baseline meta to Firestore ─────────────────────────────────────────
const metaId = `baseline_${Date.now()}`;
const metaDoc = {
  id:          metaId,
  imported_at: new Date().toISOString(),
  source_file: 'av_master.sql',
  counts: Object.fromEntries(COLLECTIONS.map(([name, data]) => [name, Object.keys(data ?? {}).length])),
};

try {
  await setDoc(doc(db, '_seed_meta', metaId), metaDoc);
  console.log(`\n✓ Baseline saved as: ${metaId}`);
} catch (e) {
  console.warn(`Warning: Could not save baseline meta: ${e.message}`);
}

// ─── Done ──────────────────────────────────────────────────────────────────────
console.log('\n══ Upload complete ══════════════════════════════');
console.log(`  Project:  ${FIREBASE_CONFIG.projectId}`);
console.log(`  Users:    ${Object.keys(seed.users ?? {}).length} (need Firebase Auth accounts)`);
console.log(`  Attend.:  ${Object.keys(seed.attendances ?? {}).length}`);
console.log(`  Leaves:   ${Object.keys(seed.leaves ?? {}).length}`);
console.log('');
console.log('Next steps:');
console.log('  1. Go to Firebase Console → Authentication → Add users for each employee');
console.log('     OR use Admin → Users in the web app to create accounts');
console.log('  2. Go to Admin → Outstation Locations and create the location list above');
console.log('  3. The "123" EPF (Admin user) needs a Firebase Auth account first');
console.log('═════════════════════════════════════════════════\n');

process.exit(0);
