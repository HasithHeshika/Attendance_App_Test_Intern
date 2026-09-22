/**
 * create-auth-users.mjs
 *
 * Bulk-creates Firebase Auth accounts for every migrated user and links the
 * resulting Auth UID back into their Firestore `users/{epf}` document.
 *
 * WHY this exists: importing firestore-seed.json (Database page) only writes the
 * Firestore documents — it does NOT create login accounts. Firebase Auth accounts
 * (email + password) can only be created with the Admin SDK, which is what this
 * script does. Every account gets its OWN random password, printed as it goes, so a
 * migrated user can log in immediately and change it — without every other account sharing
 * that same password.
 *
 * Login resolution in the app (src/services/userService.ts → getUserByUid):
 *   1. look up the user doc by its `uid` field (fast path), else
 *   2. fall back to matching by email and auto-patch the `uid`.
 * So even without the uid back-link a user can still log in by email; we link the
 * uid anyway so the fast path works from the first login.
 *
 * CREDENTIALS — use EITHER (the script auto-detects):
 *   A) A service-account JSON file (easiest). Firebase Console → Project Settings →
 *      Service accounts → "Generate new private key". Save it as serviceAccountKey.json
 *      in the project root (auto-detected), or pass --service-account=<path>.
 *   B) FIREBASE_ADMIN_PROJECT_ID / _CLIENT_EMAIL / _PRIVATE_KEY env vars (run with
 *      node --env-file=.env.local ...).
 *
 * USAGE (Node 20.6+ / 22):
 *   # with serviceAccountKey.json present in this folder:
 *   node scripts/create-auth-users.mjs firestore-seed.json
 *   # or with env vars in .env.local:
 *   node --env-file=.env.local scripts/create-auth-users.mjs firestore-seed.json
 *
 * Flags:
 *   --service-account=<path>  path to the Firebase service-account JSON file
 *   --dry-run                 show what would happen, change nothing
 *   --password=XXXX           force ONE shared password for every account
 *                             (default: a different random password per account, printed)
 *   --no-link                 create/repair Auth accounts but do NOT write uid back
 */

import fs from 'fs';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// ─── Args ───────────────────────────────────────────────────────────────────────
const argv     = process.argv.slice(2);
const flags    = new Set(argv.filter(a => a.startsWith('--') && !a.includes('=')));
const kv       = Object.fromEntries(
  argv.filter(a => a.startsWith('--') && a.includes('='))
      .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);
const seedFile   = argv.find(a => !a.startsWith('--')) || 'firestore-seed.json';
const DRY_RUN    = flags.has('--dry-run');
const NO_LINK    = flags.has('--no-link');
// Opt-in: also re-activate users the old system marked as resigned (is_active=false), so
// they can log in. Use ONLY if those people are actually still employed.
const REACTIVATE = flags.has('--reactivate-resigned');
// One RANDOM password per account by default (mirrors src/lib/initialPassword.ts). The old
// behaviour gave every migrated user the same '12345678', which for a 300-person migration
// means one guess opens every account that never changed it. --password still forces a
// shared one for a controlled re-run, but you have to ask for it.
const SHARED_PASSWORD = kv.password || null;
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const newPassword = () => {
  const b = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(b, (n) => PW_ALPHABET[n % PW_ALPHABET.length]).join('');
};
const passwordFor = () => SHARED_PASSWORD ?? newPassword();

// Lowercase + trim, and repair a bare common-provider domain missing ".com"
// (e.g. "x@gmail" → "x@gmail.com") so a typo in the old data doesn't block the login.
function fixEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  if (!e) return '';
  return e.replace(/@(gmail|googlemail|yahoo|hotmail|outlook|icloud)$/, '@$1.com');
}

// Never touch the break-glass super-admins. Copied from BOOTSTRAP_ADMIN_EMAILS in
// src/lib/bootstrapAdmins.ts — a .mjs script cannot import TypeScript. Keep in sync.
const BOOTSTRAP_ADMIN_EMAILS = ['devopsaltavision@gmail.com', 'sysadminaltavision@gmail.com'];

// ─── Admin private-key normaliser (copied from src/lib/firebaseAdmin.ts) ─────────
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

// Common filenames people save the Firebase service-account key under — auto-detected
// so you can usually just drop the file in this folder and run with no flags.
const SA_AUTODETECT = ['serviceAccountKey.json', 'service-account.json', 'firebase-admin.json'];

function initAdmin() {
  if (getApps().length) return;

  // ── Option A: a service-account JSON file (easiest) ──────────────────────────────
  // Firebase Console → Project Settings → Service accounts → "Generate new private key".
  let saPath = kv['service-account'] || process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
  if (!saPath) saPath = SA_AUTODETECT.find(f => fs.existsSync(f)) || '';
  if (saPath) {
    if (!fs.existsSync(saPath)) {
      console.error(`\n✖ Service account file not found: ${saPath}\n`);
      process.exit(1);
    }
    // cert() reads the Google-format (snake_case) JSON directly when given a path.
    initializeApp({ credential: cert(saPath) });
    console.log(`Auth: service-account file (${saPath})\n`);
    return;
  }

  // ── Option B: FIREBASE_ADMIN_* env vars (e.g. .env.local + --env-file) ────────────
  const projectId   = process.env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey  = normalizePrivateKey(process.env.FIREBASE_ADMIN_PRIVATE_KEY);
  if (projectId && clientEmail && privateKey && privateKey.includes('BEGIN PRIVATE KEY')) {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    console.log('Auth: FIREBASE_ADMIN_* env vars\n');
    return;
  }

  // ── Neither configured — explain both options clearly ────────────────────────────
  console.error(`
✖ Firebase Admin credentials not found. Your .env.local has the NEXT_PUBLIC_* client keys
  but no admin service account. Use ONE of these:

  A) Service-account JSON file (recommended — no key formatting headaches):
       1. Firebase Console → Project Settings → Service accounts → "Generate new private key"
       2. Save the downloaded file as  serviceAccountKey.json  in this project folder
          (${process.cwd()})
       3. Re-run (it auto-detects the file):
            node scripts/create-auth-users.mjs firestore-seed.json

  B) Environment variables — add to .env.local, then run with --env-file=.env.local :
       FIREBASE_ADMIN_PROJECT_ID=<project_id from that JSON>
       FIREBASE_ADMIN_CLIENT_EMAIL=<client_email from that JSON>
       FIREBASE_ADMIN_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n....\\n-----END PRIVATE KEY-----\\n"

  ⚠  serviceAccountKey.json is a secret — keep it out of git (add it to .gitignore).
`);
  process.exit(1);
}

// EPF like "EMPAV/00009" → Firestore doc id (mirrors userService.epfDocId).
function epfDocId(epf) {
  return epf.includes('/') ? epf.replace(/\//g, '%2F') : epf;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Main ────────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(seedFile)) {
    console.error(`\n✖ Seed file not found: ${seedFile}\n  Run:  node scripts/convert-sql.mjs av_master.sql  first.\n`);
    process.exit(1);
  }

  const seed  = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));
  const users = seed.users || {};
  const list  = Object.values(users);

  if (!list.length) {
    console.error(`\n✖ No users in ${seedFile} (was it generated with --data-only?). Nothing to do.\n`);
    process.exit(1);
  }

  console.log(`\n── Firebase Auth account provisioning ─────────────────────────`);
  console.log(`Seed file : ${seedFile}`);
  console.log(`Users     : ${list.length}`);
  console.log(`Password  : ${SHARED_PASSWORD ? SHARED_PASSWORD + '  (shared — forced with --password)' : 'random per account (printed per row below)'}`);
  console.log(`Mode      : ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}${NO_LINK ? ' · no uid back-link' : ''}${REACTIVATE ? ' · reactivating resigned' : ''}`);
  console.log(`───────────────────────────────────────────────────────────────\n`);

  initAdmin();
  const auth = getAuth();
  const dbFs = getFirestore();

  const stats = { created: 0, reset: 0, linked: 0, emailFixed: 0, reactivated: 0, docMissing: 0, skippedNoEmail: 0, skippedBootstrap: 0, invalidEmail: 0, errors: 0 };
  const problems = [];

  let i = 0;
  for (const u of list) {
    i++;
    const epf   = String(u.epf_number || u.epf || '');
    const email = fixEmail(u.email);
    const name  = u.display_name || `${u.first_name || ''} ${u.last_name || ''}`.trim();

    if (!email) { stats.skippedNoEmail++; problems.push(`[no-email]  ${epf} (${name})`); continue; }
    if (BOOTSTRAP_ADMIN_EMAILS.includes(email)) { stats.skippedBootstrap++; continue; }
    if (!EMAIL_RE.test(email)) { stats.invalidEmail++; problems.push(`[bad-email] ${epf} <${email}>`); continue; }

    try {
      // Does an Auth account already exist for this email?
      let uid = null;
      let existed = false;
      try {
        const rec = await auth.getUserByEmail(email);
        uid = rec.uid;
        existed = true;
      } catch (e) {
        if (e.code !== 'auth/user-not-found') throw e;
      }

      if (DRY_RUN) {
        console.log(`${String(i).padStart(3)}. ${existed ? 'would RESET ' : 'would CREATE'} ${email}  (${epf})`);
        if (existed) stats.reset++; else stats.created++;
        continue;
      }

      // One password per account, drawn here so the row can print the one it actually used.
      const rowPassword = passwordFor();
      if (existed) {
        await auth.updateUser(uid, { password: rowPassword, disabled: false });
        stats.reset++;
        console.log(`${String(i).padStart(3)}. reset    ${email}  (${epf})  pw: ${rowPassword}`);
      } else {
        const rec = await auth.createUser({
          email,
          password: rowPassword,
          emailVerified: true,           // admin-provisioned → no verification gate
          displayName: name || undefined,
          disabled: false,
        });
        uid = rec.uid;
        stats.created++;
        console.log(`${String(i).padStart(3)}. created  ${email}  (${epf})  pw: ${rowPassword}`);
      }

      // Link the uid back into the Firestore user doc (fast-path login) and normalise the
      // stored email to lowercase so Google/Microsoft sign-in (which returns a lowercase
      // address) can find the user via getUserByEmail.
      if (!NO_LINK && uid && epf) {
        const ref  = dbFs.collection('users').doc(epfDocId(epf));
        const snap = await ref.get();
        if (snap.exists) {
          const patch = {};
          if (snap.get('uid') !== uid)     patch.uid = uid;
          if (snap.get('email') !== email) patch.email = email;   // normalised/repaired above
          // Opt-in: clear the resigned/inactive flags so these users can log in.
          if (REACTIVATE && (snap.get('is_active') === false || snap.get('date_of_resign'))) {
            patch.is_active = true;
            patch.date_of_resign = null;
          }
          if (Object.keys(patch).length) {
            await ref.update(patch);
            if (patch.uid)               stats.linked++;
            if (patch.email)             stats.emailFixed++;
            if (patch.is_active === true) stats.reactivated++;
          }
        } else {
          stats.docMissing++;
          problems.push(`[no-doc]    ${epf} <${email}> — import the seed first; login still works via email fallback`);
        }
      }
    } catch (e) {
      stats.errors++;
      problems.push(`[error]     ${epf} <${email}> — ${e.code || ''} ${e.message || e}`);
      console.error(`${String(i).padStart(3)}. ERROR    ${email}  (${epf}) — ${e.code || e.message}`);
    }
  }

  console.log(`\n── Summary ────────────────────────────────────────────────────`);
  console.log(`Created (new accounts) : ${stats.created}`);
  console.log(`Password reset (exist) : ${stats.reset}`);
  console.log(`UID linked to doc      : ${stats.linked}`);
  console.log(`Email lowercased/fixed : ${stats.emailFixed}`);
  console.log(`Reactivated (resigned) : ${stats.reactivated}`);
  console.log(`Firestore doc missing  : ${stats.docMissing}`);
  console.log(`Skipped (no email)     : ${stats.skippedNoEmail}`);
  console.log(`Skipped (bootstrap)    : ${stats.skippedBootstrap}`);
  console.log(`Invalid email format   : ${stats.invalidEmail}`);
  console.log(`Errors                 : ${stats.errors}`);
  console.log(`───────────────────────────────────────────────────────────────`);
  if (problems.length) {
    console.log(`\nNeeds attention (${problems.length}):`);
    problems.forEach(p => console.log('  ' + p));
  }
  console.log(DRY_RUN ? '\nDRY RUN complete — no changes were made.\n' : '\nDone.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
