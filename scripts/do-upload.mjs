/**
 * do-upload.mjs — self-contained Firestore uploader via REST API
 * Run: node scripts/do-upload.mjs
 */
import { readFileSync } from 'fs';

const PROJECT_ID = 'avmaster-9af18';
const FS_BASE    = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// ─── Sign in ─────────────────────────────────────────────────────────────────
console.log('\nSigning in as', EMAIL, '...');
const authRes = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
  { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email: SCRIPT_EMAIL, password: SCRIPT_PASSWORD, returnSecureToken:true }) }
);
const authData = await authRes.json();
if (!authData.idToken) {
  console.error('Sign-in failed:', authData.error?.message);
  process.exit(1);
}
const TOKEN = authData.idToken;
console.log('✓ Signed in\n');

// ─── Load seed ────────────────────────────────────────────────────────────────
const seed = JSON.parse(readFileSync('scripts/firestore-seed.json', 'utf8'));

// ─── Convert JS → Firestore REST value ───────────────────────────────────────

// Credentials come from the environment, never the source tree. Run with:
//   node --env-file=.env.local scripts/do-upload.mjs
// and set FIREBASE_SCRIPT_EMAIL / FIREBASE_SCRIPT_PASSWORD alongside the existing
// NEXT_PUBLIC_FIREBASE_* values. A committed admin password is a committed admin password
// even in a throwaway script — this repo had 'admin@gmail.com' / 'admin123' in six of them.
const API_KEY  = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const SCRIPT_EMAIL    = process.env.FIREBASE_SCRIPT_EMAIL;
const SCRIPT_PASSWORD = process.env.FIREBASE_SCRIPT_PASSWORD;
if (!API_KEY || !SCRIPT_EMAIL || !SCRIPT_PASSWORD) {
  console.error('Missing NEXT_PUBLIC_FIREBASE_API_KEY / FIREBASE_SCRIPT_EMAIL / FIREBASE_SCRIPT_PASSWORD.');
  process.exit(1);
}

function toFSValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean')          return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val))           return { integerValue: String(val) };
    return                               { doubleValue: val };
  }
  if (typeof val === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) return { timestampValue: val };
    return { stringValue: val };
  }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFSValue) } };
  if (typeof val === 'object') {
    const fields = {};
    const SKIP = ['_needs_auth','_original_password_hash','_legacy_id'];
    for (const [k, v] of Object.entries(val)) {
      if (!SKIP.includes(k)) fields[k] = toFSValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

// ─── Write one doc ────────────────────────────────────────────────────────────
async function writeDoc(col, id, data, retries = 3) {
  const url    = `${FS_BASE}/${col}/${encodeURIComponent(id)}`;
  const fields = {};
  const SKIP   = ['_needs_auth','_original_password_hash','_legacy_id'];
  for (const [k,v] of Object.entries(data)) {
    if (!SKIP.includes(k)) fields[k] = toFSValue(v);
  }
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${TOKEN}` },
      body: JSON.stringify({ fields }),
    });
    if (res.ok) return;
    const err = await res.json().catch(() => ({}));
    if (attempt === retries) throw new Error(`${col}/${id}: ${err.error?.message ?? res.status}`);
    await new Promise(r => setTimeout(r, 500 * attempt));
  }
}

// ─── Upload a collection ─────────────────────────────────────────────────────
async function uploadCol(col, docs) {
  const entries = Object.entries(docs ?? {});
  if (!entries.length) { console.log('    (empty)'); return 0; }
  let ok = 0, errors = 0;
  for (const [id, data] of entries) {
    try {
      await writeDoc(col, id, data);
      ok++;
    } catch(e) {
      errors++;
      if (errors <= 5) console.error(`\n  ERR: ${e.message}`);
    }
    if ((ok + errors) % 25 === 0 || (ok + errors) === entries.length) {
      process.stdout.write(`\r    ${ok + errors}/${entries.length} (${errors} err)  `);
    }
    // Throttle: Firestore REST allows ~1/s sustained, burst higher
    if ((ok + errors) % 20 === 0) await new Promise(r => setTimeout(r, 50));
  }
  console.log(`\r    ✓ ${ok}/${entries.length} written${errors ? `, ${errors} errors` : ''}          `);
  return ok;
}

// ─── Collections ─────────────────────────────────────────────────────────────
const COLS = [
  ['companies',                seed.companies],
  ['leave_types',              seed.leave_types],
  ['users',                    seed.users],
  ['attendances',              seed.attendances],
  ['attendance_edit_requests', seed.attendance_edit_requests],
  ['leaves',                   seed.leaves],
];

// ─── Print summary ────────────────────────────────────────────────────────────
console.log('── Collections to upload ─────────────────────────');
let totalDocs = 0;
for (const [name, data] of COLS) {
  const n = Object.keys(data ?? {}).length;
  totalDocs += n;
  console.log(`  ${name.padEnd(34)} ${String(n).padStart(4)} docs`);
}
console.log(`  ${'TOTAL'.padEnd(34)} ${String(totalDocs).padStart(4)} docs`);
console.log('──────────────────────────────────────────────────\n');

// ─── Upload ───────────────────────────────────────────────────────────────────
const t0 = Date.now();
let totalOk = 0;
for (const [name, data] of COLS) {
  process.stdout.write(`\n  ${name}\n`);
  totalOk += await uploadCol(name, data);
}

// Baseline meta
try {
  const metaId = `baseline_${Date.now()}`;
  await writeDoc('_seed_meta', metaId, {
    id: metaId,
    imported_at: new Date().toISOString(),
    source_file: 'av_master.sql',
    counts: Object.fromEntries(COLS.map(([n,d]) => [n, Object.keys(d??{}).length])),
  });
  console.log(`\n  ✓ Baseline saved (_seed_meta/${metaId.slice(-8)})`);
} catch(e) { console.warn('\n  Warning: baseline meta not saved:', e.message); }

const elapsed = ((Date.now()-t0)/1000).toFixed(1);
console.log('\n══ DONE ══════════════════════════════════════════');
console.log(`  Project   : ${PROJECT_ID}`);
console.log(`  Uploaded  : ${totalOk}/${totalDocs} documents`);
console.log(`  Time      : ${elapsed}s`);
console.log(`\nNext steps:`);
console.log(`  1. Open Admin → Outstation Locations in the web app`);
console.log(`     and add these locations from the old data:`);
const osts = seed._meta?.unique_outstations ?? [];
osts.forEach(o => console.log(`       - ${o}`));
console.log(`  2. Create Firebase Auth accounts for employees`);
console.log(`     Admin → Users  OR  Firebase Console → Authentication`);
console.log(`  3. The admin user (admin@gmail.com / EPF:123) already has`);
console.log(`     a Firestore doc — link it to Firebase Auth UID via Admin → Users`);
console.log('═══════════════════════════════════════════════════\n');
