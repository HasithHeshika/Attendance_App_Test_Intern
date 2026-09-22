/**
 * tenant-registry.mjs — the `tenants` Firestore database, from the command line.
 *
 * Tenants (domains, branding, module flags) live in a dedicated Firestore database called
 * `tenants`, edited through the /platform UI. This script is the plumbing around it.
 *
 *   node scripts/tenant-registry.mjs snapshot     DB → src/generated/tenants.snapshot.json
 *   node scripts/tenant-registry.mjs seed         snapshot → DB (only documents not there yet)
 *   node scripts/tenant-registry.mjs seed --force snapshot → DB, overwriting existing documents
 *   node scripts/tenant-registry.mjs list         print what the database currently holds
 *
 * ── snapshot ─────────────────────────────────────────────────────────────────
 * Runs before every build (see the `prebuild` script in package.json). The file it writes is
 * the failsafe every domain falls back to when the registry is unreachable on a cold start,
 * and the only tenant list Edge middleware can read — firebase-admin cannot run there.
 *
 * It NEVER fails the build. Missing credentials, an unreachable database or an empty
 * collection all leave the existing snapshot untouched and exit 0: shipping last week's
 * tenant list is recoverable, failing every deploy because Firestore hiccuped is not.
 *
 * ── seed ─────────────────────────────────────────────────────────────────────
 * One-time migration for a fresh `tenants` database, and the way to restore a tenant someone
 * deleted by accident. Additive by default — it will not overwrite a live tenant's config
 * with whatever the snapshot happened to hold, because the snapshot is by definition older.
 *
 * Credentials come from .env.local, same vars the app uses:
 *   FIREBASE_ADMIN_PROJECT_ID / _CLIENT_EMAIL / _PRIVATE_KEY
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');
const SNAPSHOT_PATH = resolve(ROOT, 'src/generated/tenants.snapshot.json');

/** The registry database and collection. Must match src/lib/tenantRegistry.ts. */
const TENANTS_DB_ID = 'tenants';
const TENANTS_COLLECTION = 'tenants';

// ─── .env.local loader (matches the other scripts — no dotenv dependency) ──────
function loadEnv(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}
const env = { ...loadEnv(resolve(ROOT, '.env')), ...loadEnv(resolve(ROOT, '.env.local')) };
const fromEnv = (k) => env[k] || process.env[k];

// ─── Private-key normaliser (copied from src/lib/firebaseAdmin.ts) ─────────────
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

const argv = process.argv.slice(2);
const command = argv[0];
const has = (f) => argv.includes(`--${f}`);

/** Returns null rather than exiting — `snapshot` must tolerate having no credentials. */
function initDb() {
  const projectId = fromEnv('FIREBASE_ADMIN_PROJECT_ID');
  const clientEmail = fromEnv('FIREBASE_ADMIN_CLIENT_EMAIL');
  const privateKey = normalizePrivateKey(fromEnv('FIREBASE_ADMIN_PRIVATE_KEY'));
  if (!projectId || !clientEmail || !privateKey?.includes('BEGIN PRIVATE KEY')) return null;
  const app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  return getFirestore(app, TENANTS_DB_ID);
}

function readSnapshot() {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try { return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')); } catch { return null; }
}

/** Only the fields that belong in the snapshot, in a stable key order so diffs stay readable. */
function toSnapshotShape(id, d) {
  return {
    id,
    label: d.label ?? id,
    domains: Array.isArray(d.domains) ? d.domains : [],
    dbId: typeof d.dbId === 'string' ? d.dbId : '',
    appName: d.appName ?? d.label ?? id,
    themeColor: d.themeColor ?? '#0C8ECA',
    brandDir: d.brandDir ?? null,
    status: d.status === 'disabled' ? 'disabled' : 'active',
    // Sorted: Firestore hands maps back in arbitrary order, and an unsorted dump would
    // rewrite the whole block on every regeneration for no reason.
    features: Object.fromEntries(
      Object.entries(d.features && typeof d.features === 'object' ? d.features : {})
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

async function cmdSnapshot() {
  const db = initDb();
  if (!db) {
    console.warn('[tenant-snapshot] no admin credentials — keeping the existing snapshot.');
    return;
  }
  let docs;
  try {
    const snap = await db.collection(TENANTS_COLLECTION).get();
    docs = snap.docs;
  } catch (e) {
    console.warn(`[tenant-snapshot] read failed (${e.message}) — keeping the existing snapshot.`);
    return;
  }
  if (docs.length === 0) {
    console.warn('[tenant-snapshot] registry is EMPTY — keeping the existing snapshot.');
    return;
  }

  const tenants = docs
    .map((d) => toSnapshotShape(d.id, d.data()))
    .sort((a, b) => a.id.localeCompare(b.id));

  const out = {
    _comment: 'GENERATED FILE — do not edit by hand. Written by '
      + '`npm run tenants:snapshot` (and automatically before every build) from the `tenants` '
      + 'Firestore database. It is the failsafe every domain falls back to when that database '
      + 'is unreachable on a cold start, and the only tenant list Edge middleware can read. '
      + 'Edit tenants in the /platform UI, not here.',
    generatedAt: new Date().toISOString(),
    source: `firestore:${TENANTS_DB_ID}`,
    tenants,
  };

  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`[tenant-snapshot] wrote ${tenants.length} tenants: ${tenants.map(t => t.id).join(', ')}`);
}

async function cmdSeed() {
  const db = initDb();
  if (!db) {
    console.error('ERROR: Firebase Admin credentials missing (FIREBASE_ADMIN_* in .env.local).');
    process.exit(1);
  }
  const snap = readSnapshot();
  if (!snap?.tenants?.length) {
    console.error(`ERROR: no tenants in ${SNAPSHOT_PATH} to seed from.`);
    process.exit(1);
  }

  const force = has('force');
  let created = 0, skipped = 0, overwritten = 0;

  for (const t of snap.tenants) {
    const ref = db.collection(TENANTS_COLLECTION).doc(t.id);
    const existing = await ref.get();
    if (existing.exists && !force) {
      // The live document is newer than any snapshot by definition — never clobber it
      // without being told to.
      console.log(`  = ${t.id} already exists, left alone`);
      skipped++;
      continue;
    }
    const { id, ...data } = t;
    await ref.set({
      ...data,
      updated_at: FieldValue.serverTimestamp(),
      updated_by: 'scripts/tenant-registry.mjs',
      ...(existing.exists ? {} : {
        created_at: FieldValue.serverTimestamp(),
        created_by: 'scripts/tenant-registry.mjs',
      }),
    }, { merge: true });
    console.log(`  ${existing.exists ? '~' : '+'} ${id}`);
    if (existing.exists) overwritten++; else created++;
  }

  console.log(`[tenant-seed] created ${created}, overwritten ${overwritten}, skipped ${skipped}`);
  if (skipped && !force) console.log('[tenant-seed] pass --force to overwrite the skipped ones.');
}

async function cmdList() {
  const db = initDb();
  if (!db) {
    console.error('ERROR: Firebase Admin credentials missing (FIREBASE_ADMIN_* in .env.local).');
    process.exit(1);
  }
  const snap = await db.collection(TENANTS_COLLECTION).get();
  if (snap.empty) {
    console.log(`(${TENANTS_DB_ID}/${TENANTS_COLLECTION} is empty — run "seed" to populate it)`);
    return;
  }
  for (const d of snap.docs) {
    const t = d.data();
    const on = Object.entries(t.features ?? {}).filter(([, v]) => v === true).length;
    console.log(
      `${d.id.padEnd(16)} db=${(t.dbId || '(default)').padEnd(14)} ` +
      `${String(t.status ?? 'active').padEnd(9)} ${on} flags on   ${(t.domains ?? []).join(', ')}`,
    );
  }
}

const commands = { snapshot: cmdSnapshot, seed: cmdSeed, list: cmdList };

if (!commands[command]) {
  console.error('Usage: node scripts/tenant-registry.mjs <snapshot|seed|list> [--force]');
  process.exit(1);
}

commands[command]().catch((e) => {
  // `snapshot` handles its own failures above and must never break a build; anything that
  // reaches here is a genuine bug or an explicitly-requested write that failed.
  console.error(`[tenant-registry] ${command} failed:`, e);
  process.exit(command === 'snapshot' ? 0 : 1);
});
