/**
 * upload-rest.mjs
 *
 * Uploads firestore-seed.json to Firebase Firestore using the REST API.
 * Signs in with Firebase Auth REST API first to get an ID token,
 * then writes each document using authenticated Firestore REST calls.
 *
 * Usage:
 *   node scripts/upload-rest.mjs <email> <password>
 *
 * Example:
 *   node scripts/upload-rest.mjs admin@gmail.com yourpassword
 *
 * The email/password must be a Firebase Auth user in your project.
 * The user needs Firestore write access (Admin role or open rules).
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname }         from 'path';
import { fileURLToPath }            from 'url';

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

const API_KEY    = env.NEXT_PUBLIC_FIREBASE_API_KEY;
const PROJECT_ID = env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

if (!API_KEY || !PROJECT_ID) {
  console.error('ERROR: Firebase config not found in .env.local');
  process.exit(1);
}

const [,, EMAIL, PASSWORD] = process.argv;
if (!EMAIL || !PASSWORD) {
  console.log('Usage: node scripts/upload-rest.mjs <email> <password>');
  console.log('');
  console.log('The email/password must be a Firebase Auth account in your project.');
  console.log('Create one at: https://console.firebase.google.com/project/' + PROJECT_ID + '/authentication/users');
  process.exit(1);
}

// ─── Load seed data ───────────────────────────────────────────────────────────
const seedPath = resolve(__dir, 'firestore-seed.json');
if (!existsSync(seedPath)) {
  console.error('ERROR: firestore-seed.json not found. Run convert-sql.mjs first.');
  process.exit(1);
}
const seed = JSON.parse(readFileSync(seedPath, 'utf8'));

// ─── Firebase Auth — get ID token ────────────────────────────────────────────
console.log(`\nSigning in as ${EMAIL}...`);
const authRes = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
  {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  }
);
const authData = await authRes.json();
if (!authData.idToken) {
  console.error('Sign-in failed:', authData.error?.message ?? JSON.stringify(authData));
  process.exit(1);
}
const ID_TOKEN = authData.idToken;
console.log('✓ Signed in successfully\n');

// ─── Firestore REST helpers ───────────────────────────────────────────────────
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Convert JS value → Firestore REST value
function toFSValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean')          return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val))           return { integerValue: String(val) };
    return                               { doubleValue: val };
  }
  if (typeof val === 'string') {
    // Detect ISO timestamps
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
      return { timestampValue: val };
    }
    return { stringValue: val };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFSValue) } };
  }
  if (typeof val === 'object') {
    // Skip migration-only fields
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      if (['_needs_auth','_original_password_hash','_legacy_id'].includes(k)) continue;
      fields[k] = toFSValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

// Write a single document via REST PATCH (create or overwrite)
async function writeDoc(collectionName, docId, data) {
  const url = `${FS_BASE}/${collectionName}/${encodeURIComponent(docId)}`;
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (['_needs_auth','_original_password_hash','_legacy_id'].includes(k)) continue;
    fields[k] = toFSValue(v);
  }
  const res = await fetch(url, {
    method:  'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${ID_TOKEN}`,
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Write failed for ${collectionName}/${docId}: ${err.error?.message ?? res.status}`);
  }
}

// Write all docs in a collection with throttling (Firestore REST: ~1 req/10ms safe)
async function uploadCollection(collectionName, docs) {
  const entries = Object.entries(docs ?? {});
  if (entries.length === 0) { console.log('    (empty — skipping)'); return; }

  let ok = 0, fail = 0;
  for (const [id, data] of entries) {
    try {
      await writeDoc(collectionName, id, data);
      ok++;
      if (ok % 50 === 0 || ok === entries.length) {
        process.stdout.write(`\r    ${ok}/${entries.length} written${fail > 0 ? ` (${fail} errors)` : ''}...`);
      }
    } catch (e) {
      fail++;
      if (fail <= 3) console.error(`\n    ERROR: ${e.message}`);
    }
    // Small delay to avoid rate limits
    if (ok % 10 === 0) await new Promise(r => setTimeout(r, 10));
  }
  console.log(`\r    ✓ ${ok} written${fail > 0 ? `, ${fail} failed` : ''}`);
}

// ─── Collections to upload (in dependency order) ─────────────────────────────
const COLLECTIONS = [
  ['companies',                seed.companies],
  ['leave_types',              seed.leave_types],
  ['users',                    seed.users],
  ['attendances',              seed.attendances],
  ['attendance_edit_requests', seed.attendance_edit_requests],
  ['leaves',                   seed.leaves],
];

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('── Data to upload ────────────────────────────────');
let total = 0;
for (const [name, data] of COLLECTIONS) {
  const count = Object.keys(data ?? {}).length;
  total += count;
  console.log(`  ${name.padEnd(32)} ${String(count).padStart(4)} docs`);
}
console.log(`  ${'TOTAL'.padEnd(32)} ${String(total).padStart(4)} docs`);
console.log('──────────────────────────────────────────────────');

const outstations = seed._meta?.unique_outstations ?? [];
if (outstations.length > 0) {
  console.log('\n── Outstation names in old data (create these after upload) ─');
  outstations.forEach(n => console.log(`  - ${n}`));
}
console.log('');

// ─── Upload ───────────────────────────────────────────────────────────────────
console.log('Uploading to Firestore...');
const startTime = Date.now();

for (const [name, data] of COLLECTIONS) {
  console.log(`\n  ${name}`);
  await uploadCollection(name, data);
}

// Save baseline meta
const metaId = `baseline_${Date.now()}`;
try {
  await writeDoc('_seed_meta', metaId, {
    id:          metaId,
    imported_at: new Date().toISOString(),
    source_file: 'av_master.sql',
    counts: Object.fromEntries(COLLECTIONS.map(([n, d]) => [n, Object.keys(d ?? {}).length])),
  });
  console.log(`\n✓ Baseline snapshot saved (ID: ${metaId.slice(-8)})`);
} catch (e) {
  console.warn(`\nWarning: Could not save baseline meta: ${e.message}`);
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log('\n══ Upload complete ══════════════════════════════');
console.log(`  Project:    ${PROJECT_ID}`);
console.log(`  Time:       ${elapsed}s`);
console.log(`  Users:      ${Object.keys(seed.users ?? {}).length}`);
console.log(`  Attendance: ${Object.keys(seed.attendances ?? {}).length}`);
console.log('');
console.log('Next steps:');
console.log('  1. Create Firebase Auth accounts for each employee');
console.log('     → Firebase Console → Authentication → Add User');
console.log('     → OR use Admin → Users in the web app');
console.log('  2. Add outstation locations listed above');
console.log('     → Admin → Outstation Locations in the web app');
console.log('  3. The admin user (EPF: 123, email: admin@gmail.com)');
console.log('     needs a Firebase Auth account to log in');
console.log('═════════════════════════════════════════════════\n');
process.exit(0);
