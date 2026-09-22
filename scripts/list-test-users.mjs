// READ-ONLY: lists all Firestore `users` and flags likely test/dummy accounts.
// It does NOT modify or delete anything — it only prints, so you can review and
// confirm which accounts to remove.
//
// Usage:
//   1) Ensure these are set (in .env.local or the shell):
//        FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL, FIREBASE_ADMIN_PRIVATE_KEY
//      (the same service-account creds used by src/lib/firebaseAdmin.ts).
//   2) node scripts/list-test-users.mjs
//
// Output: a table of every user, with a ⚠ marker on likely-test accounts, then a
// summary block listing just the flagged EPF numbers for easy confirmation.

import { readFileSync } from 'node:fs';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Load .env.local (simple parser; no dependency on dotenv).
try {
  const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* .env.local optional if vars already in the environment */ }

const projectId   = process.env.FIREBASE_ADMIN_PROJECT_ID;
const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
let   privateKey  = process.env.FIREBASE_ADMIN_PRIVATE_KEY;

if (!projectId || !clientEmail || !privateKey) {
  console.error('\n✗ Missing FIREBASE_ADMIN_* credentials.');
  console.error('  Set FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL, FIREBASE_ADMIN_PRIVATE_KEY');
  console.error('  (same service account as src/lib/firebaseAdmin.ts), then re-run.\n');
  process.exit(1);
}
// Normalize a private key that was stored with literal \n or wrapping quotes.
privateKey = privateKey.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');

if (!getApps().length) initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
const db = getFirestore();

// Heuristics for "looks like a test account". Tune as needed — this only FLAGS,
// it never decides; you confirm the final list.
const TEST_RE = /\b(test|testing|tester|demo|dummy|sample|example|placeholder|qa|temp|fake|asdf|xxx|zzz|lorem)\b/i;
const looksTest = (u) => {
  const hay = [
    u.display_name, u.first_name, u.last_name, u.email, u.epf_number,
    ...(Array.isArray(u.name_tokens) ? u.name_tokens : []),
  ].filter(Boolean).join(' ');
  if (TEST_RE.test(hay)) return true;
  if (typeof u.email === 'string' && /@(example|test)\.(com|org|net)$/i.test(u.email)) return true;
  return false;
};

const fmtDate = (v) => {
  try { return v?.toDate ? v.toDate().toISOString().slice(0, 10) : (v ? String(v).slice(0, 10) : ''); }
  catch { return ''; }
};

const snap = await db.collection('users').get();
const users = snap.docs.map(d => ({ _id: d.id, ...d.data() }));

// Likely-test first, then by company/name.
users.sort((a, b) => (Number(looksTest(b)) - Number(looksTest(a)))
  || String(a.company_name || '').localeCompare(String(b.company_name || ''))
  || String(a.display_name || '').localeCompare(String(b.display_name || '')));

const name = (u) => u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || '(no name)';
console.log(`\nTotal users: ${users.length}\n`);
console.log('flag  epf_number       name                          email                              company            role              active');
console.log('-'.repeat(140));
for (const u of users) {
  const flag = looksTest(u) ? '⚠  ' : '   ';
  console.log(
    flag +
    String(u.epf_number ?? u._id).padEnd(15) + '  ' +
    name(u).slice(0, 28).padEnd(28) + '  ' +
    String(u.email ?? '').slice(0, 33).padEnd(33) + '  ' +
    String(u.company_name ?? '').slice(0, 16).padEnd(16) + '  ' +
    String(u.role ?? '').slice(0, 16).padEnd(16) + '  ' +
    (u.is_active === false ? 'no' : 'yes') + '  ' + fmtDate(u.created_at),
  );
}

const flagged = users.filter(looksTest);
console.log('\n' + '='.repeat(60));
console.log(`Likely TEST accounts flagged: ${flagged.length}`);
for (const u of flagged) console.log(`  ⚠  ${String(u.epf_number ?? u._id).padEnd(15)}  ${name(u)}  <${u.email ?? ''}>`);
console.log('\nReview the ⚠ list. To remove them, confirm the EPF numbers and I will');
console.log('write a companion delete/deactivate script scoped to exactly those IDs.\n');
