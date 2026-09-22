/**
 * onedrive-upload.mjs — upload a file to OneDrive via Microsoft Graph (app-only).
 *
 * Reads the same config the app uses (Firestore app_config/cloud_storage, written by
 * the API-playground / cloud-storage settings panel) and uploads through the Azure AD
 * client-credentials flow — no user sign-in, no OneDrive desktop sync client involved.
 *
 * Uses a RESUMABLE UPLOAD SESSION rather than the simple PUT :/content used by
 * src/lib/msgraph.ts. That helper is for a few-hundred-KB bill image; a Firestore
 * backup is already ~8 MB and grows daily, so it gets chunked + retried here.
 *
 *   node scripts/onedrive-upload.mjs --file backups/foo.json
 *   node scripts/onedrive-upload.mjs --file foo.json --name firestore-latest.json
 *   node scripts/onedrive-upload.mjs --file foo.json --config-db "(default)"
 *
 * Config lookup order: --config-db, else FIRESTORE_DB_ID from .env.local, then the
 * other database as a fallback (the config currently lives in "test", not prod).
 */

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dir, '..');

// Graph requires every chunk except the last to be a multiple of 320 KiB.
const CHUNK = 5 * 1024 * 1024;          // 5 MiB = 16 × 320 KiB
const MAX_ATTEMPTS = 4;

// ─── .env loader (same shape as the other scripts) ──────────────────────────────
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

function normalizePrivateKey(raw) {
  if (!raw) return undefined;
  let k = raw.trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) k = k.slice(1, -1).trim();
  if (!k.includes('BEGIN PRIVATE KEY')) {
    try {
      const d = Buffer.from(k, 'base64').toString('utf8');
      if (d.includes('BEGIN PRIVATE KEY')) k = d.trim();
    } catch { /* not base64 */ }
  }
  return k.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
}

// ─── CLI ────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Config ─────────────────────────────────────────────────────────────────────
function initAdmin() {
  const projectId   = env.FIREBASE_ADMIN_PROJECT_ID   || process.env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = env.FIREBASE_ADMIN_CLIENT_EMAIL || process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey  = normalizePrivateKey(env.FIREBASE_ADMIN_PRIVATE_KEY || process.env.FIREBASE_ADMIN_PRIVATE_KEY);
  if (!projectId || !clientEmail || !privateKey) throw new Error('Firebase Admin credentials missing (FIREBASE_ADMIN_* in .env.local).');
  return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
}

async function readCloudConfig(app, dbIdOverride) {
  const preferred = (dbIdOverride ?? (env.FIRESTORE_DB_ID || process.env.FIRESTORE_DB_ID) ?? '').trim();
  const norm = (id) => (id === '(default)' ? '' : id);

  // Try the preferred database first, then the other one — the cloud-storage config
  // currently lives in "test" while backups are taken from the default database.
  const candidates = [norm(preferred)];
  const other = norm(preferred) === '' ? 'test' : '';
  if (!candidates.includes(other)) candidates.push(other);

  for (const dbId of candidates) {
    const db   = dbId ? getFirestore(app, dbId) : getFirestore(app);
    const snap = await db.collection('app_config').doc('cloud_storage').get();
    if (!snap.exists) continue;
    const cfg = snap.data();
    if (cfg?.provider !== 'onedrive' || !cfg.onedrive) continue;
    return { cfg: cfg.onedrive, dbLabel: dbId || 'default' };
  }
  throw new Error('No OneDrive config found in app_config/cloud_storage (checked: ' +
    candidates.map(c => c || 'default').join(', ') + ').');
}

// ─── Graph ──────────────────────────────────────────────────────────────────────
async function getGraphToken(cfg) {
  if (!cfg.tenant_id || !cfg.client_id || !cfg.client_secret) {
    throw new Error('OneDrive config incomplete (tenant id, client id, client secret).');
  }
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant_id)}/oauth2/v2.0/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     cfg.client_id,
      client_secret: cfg.client_secret,
      scope:         'https://graph.microsoft.com/.default',
      grant_type:    'client_credentials',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Token request failed (${res.status})`);
  }
  return data.access_token;
}

// Mirrors uploadUrl() in src/lib/msgraph.ts so both write to the same place.
function itemPath(folderPath, name) {
  const clean = folderPath.replace(/\/+$/, '');
  const safe  = name.split('/').map(s => s.replace(/[^a-zA-Z0-9._-]/g, '_')).filter(Boolean).join('/');
  return `https://graph.microsoft.com/v1.0/users/${clean}/${safe}`;
}

async function createUploadSession(token, cfg, name) {
  const res = await fetch(`${itemPath(cfg.folder_path, name)}:/createUploadSession`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    // "replace" is what makes this an overwrite rather than firestore-latest 1.json
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.uploadUrl) {
    throw new Error(data?.error?.message || `createUploadSession failed (${res.status})`);
  }
  return data.uploadUrl;
}

async function uploadChunks(uploadUrl, filePath, total) {
  const fd = openSync(filePath, 'r');
  try {
    let offset = 0;
    let last = null;
    while (offset < total) {
      const size = Math.min(CHUNK, total - offset);
      const buf  = Buffer.alloc(size);
      readSync(fd, buf, 0, size, offset);
      const range = `bytes ${offset}-${offset + size - 1}/${total}`;

      let res, err;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          // No Authorization header: the session URL is already pre-authenticated.
          res = await fetch(uploadUrl, {
            method:  'PUT',
            headers: { 'Content-Length': String(size), 'Content-Range': range },
            body:    new Uint8Array(buf),
          });
          err = null;
          // 5xx / 429 are the documented retryable cases for an upload session.
          if (res.status === 429 || res.status >= 500) {
            if (attempt === MAX_ATTEMPTS) break;
            const wait = Number(res.headers.get('retry-after') || 0) * 1000 || 1000 * 2 ** attempt;
            process.stdout.write(`  chunk ${range} → ${res.status}, retrying in ${wait}ms\n`);
            await sleep(wait);
            continue;
          }
          break;
        } catch (e) {
          err = e;
          if (attempt === MAX_ATTEMPTS) break;
          await sleep(1000 * 2 ** attempt);
        }
      }
      if (err) throw err;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Chunk ${range} failed (${res.status}) ${body.slice(0, 300)}`);
      }

      offset += size;
      const pct = Math.round((offset / total) * 100);
      process.stdout.write(`\r  uploading ${pct}% (${(offset / 1e6).toFixed(2)}/${(total / 1e6).toFixed(2)} MB)   `);
      if (res.status === 200 || res.status === 201) last = await res.json().catch(() => ({}));
    }
    process.stdout.write('\n');
    return last;
  } finally {
    closeSync(fd);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const fileArg = opt('file');
    if (!fileArg) throw new Error('Missing --file <path>.');
    const filePath = resolve(ROOT, fileArg);
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    const total = statSync(filePath).size;
    if (total === 0) throw new Error('Refusing to upload a 0-byte file.');
    const name = opt('name', basename(filePath));

    const app = initAdmin();
    const { cfg, dbLabel } = await readCloudConfig(app, opt('config-db'));

    console.log('\n── OneDrive upload ───────────────────────────────');
    console.log(`  Config from: ${dbLabel} / app_config/cloud_storage`);
    console.log(`  Destination: ${cfg.folder_path}/${name}`);
    console.log(`  Size:        ${(total / 1e6).toFixed(2)} MB`);

    // Warn before the client secret silently expires and backups start failing.
    if (cfg.secret_created_date && cfg.secret_duration_months) {
      const exp = new Date(cfg.secret_created_date);
      exp.setMonth(exp.getMonth() + Number(cfg.secret_duration_months));
      const days = Math.round((exp - new Date()) / 86400000);
      if (days < 30) console.log(`  WARNING: client secret expires in ${days} day(s) (${exp.toISOString().slice(0, 10)}).`);
    }

    const token   = await getGraphToken(cfg);
    const session = await createUploadSession(token, cfg, name);
    const item    = await uploadChunks(session, filePath, total);

    // Read the item back so success means Graph actually has the bytes.
    const verify = await fetch(itemPath(cfg.folder_path, name), { headers: { Authorization: `Bearer ${token}` } });
    const meta   = await verify.json().catch(() => ({}));
    if (!verify.ok) throw new Error(meta?.error?.message || `Post-upload verify failed (${verify.status})`);
    if (Number(meta.size) !== total) {
      throw new Error(`Size mismatch after upload: local ${total} vs OneDrive ${meta.size}`);
    }

    console.log(`\n✓ Uploaded ${(total / 1e6).toFixed(2)} MB to OneDrive`);
    console.log(`  name:     ${meta.name || item?.name || name}`);
    console.log(`  size:     ${meta.size} bytes (verified)`);
    console.log(`  modified: ${meta.lastModifiedDateTime || '-'}`);
    if (meta.webUrl) console.log(`  webUrl:   ${meta.webUrl}`);
    console.log('');
    process.exit(0);
  } catch (e) {
    console.error(`\n✗ OneDrive upload failed: ${e?.message || e}\n`);
    process.exit(1);
  }
})();
