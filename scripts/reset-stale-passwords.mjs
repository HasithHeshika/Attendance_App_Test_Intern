/**
 * reset-stale-passwords.mjs
 *
 * Resets the password to a fresh random one-time value for every user who has NOT
 * signed in since a cutoff date (default: 2026-07-01, Sri Lanka time). Users who
 * signed in on/after the cutoff are left completely untouched.
 *
 * WHY: some users report they cannot log in (forgotten/never-known passwords, or a
 * migrated Firestore user that never got a Firebase Auth account). Users active
 * after the cutoff clearly know their password — never reset those.
 *
 * "Last seen" = the newest of Firebase Auth's lastSignInTime / lastRefreshTime
 * (lastRefreshTime also covers people kept signed in by a long-lived session who
 * haven't typed their password recently — they are NOT reset).
 *
 * Firestore users with no Auth account at all (migrated, never provisioned — these
 * are guaranteed "cannot login") get an Auth account created with the default
 * password and the uid linked back to their users/{epf} doc, same as
 * create-auth-users.mjs.
 *
 * Resigned users (is_active=false) are skipped — don't hand the well-known default
 * password to accounts that shouldn't log in (use --include-inactive to override).
 *
 * CREDENTIALS — same as create-auth-users.mjs (auto-detected):
 *   A) serviceAccountKey.json in the project root (Firebase Console → Project
 *      Settings → Service accounts → "Generate new private key"), or
 *      --service-account=<path>
 *   B) FIREBASE_ADMIN_PROJECT_ID / _CLIENT_EMAIL / _PRIVATE_KEY env vars
 *      (node --env-file=.env.local ...)
 *
 * USAGE (Node 20.6+):
 *   node scripts/reset-stale-passwords.mjs --dry-run     # ALWAYS review this first
 *   node scripts/reset-stale-passwords.mjs               # apply
 *
 * Flags:
 *   --dry-run                 show what would happen, change nothing
 *   --cutoff=YYYY-MM-DD       keep users seen on/after this date (default 2026-07-01,
 *                             interpreted as 00:00 Asia/Colombo)
 *   --password=XXXX           force ONE shared password for every account
 *                             (default: a different random password per account, printed)
 *   --include-inactive        also reset users flagged is_active=false
 *   --service-account=<path>  path to the Firebase service-account JSON file
 */

import fs from 'fs';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// ─── Args ───────────────────────────────────────────────────────────────────────
const argv  = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--') && !a.includes('=')));
const kv    = Object.fromEntries(
  argv.filter(a => a.startsWith('--') && a.includes('='))
      .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);
const DRY_RUN          = flags.has('--dry-run');
const INCLUDE_INACTIVE = flags.has('--include-inactive');
// One RANDOM password per account by default (mirrors src/lib/initialPassword.ts). Resetting
// a few hundred accounts to one shared value is how '12345678' became a master key here in
// the first place. --password still forces a shared one for a controlled re-run.
const SHARED_PASSWORD  = kv.password || null;
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const newPassword = () => {
  const b = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(b, (n) => PW_ALPHABET[n % PW_ALPHABET.length]).join('');
};
const passwordFor = () => SHARED_PASSWORD ?? newPassword();
const CUTOFF_DATE      = kv.cutoff || '2026-07-01';
// Midnight Sri Lanka time on the cutoff date — anyone seen at/after this is kept.
const CUTOFF_MS = Date.parse(`${CUTOFF_DATE}T00:00:00+05:30`);
if (Number.isNaN(CUTOFF_MS)) {
  console.error(`\n✖ Bad --cutoff date: ${CUTOFF_DATE} (expected YYYY-MM-DD)\n`);
  process.exit(1);
}

// Never touch the break-glass super-admins. Copied from BOOTSTRAP_ADMIN_EMAILS in
// src/lib/bootstrapAdmins.ts — a .mjs script cannot import TypeScript. Keep in sync.
const BOOTSTRAP_ADMIN_EMAILS = ['devopsaltavision@gmail.com', 'sysadminaltavision@gmail.com'];

// Lowercase + trim, and repair a bare common-provider domain missing ".com"
// (mirrors create-auth-users.mjs so both scripts resolve the same Auth account).
function fixEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  if (!e) return '';
  return e.replace(/@(gmail|googlemail|yahoo|hotmail|outlook|icloud)$/, '@$1.com');
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// EPF like "EMPAV/00009" → Firestore doc id (mirrors userService.epfDocId).
function epfDocId(epf) {
  return epf.includes('/') ? epf.replace(/\//g, '%2F') : epf;
}

// ─── Admin credentials (same auto-detection as create-auth-users.mjs) ────────────
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

const SA_AUTODETECT = ['serviceAccountKey.json', 'service-account.json', 'firebase-admin.json'];

function initAdmin() {
  if (getApps().length) return;
  let saPath = kv['service-account'] || process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
  if (!saPath) saPath = SA_AUTODETECT.find(f => fs.existsSync(f)) || '';
  if (saPath) {
    if (!fs.existsSync(saPath)) {
      console.error(`\n✖ Service account file not found: ${saPath}\n`);
      process.exit(1);
    }
    initializeApp({ credential: cert(saPath) });
    console.log(`Auth: service-account file (${saPath})\n`);
    return;
  }
  const projectId   = process.env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey  = normalizePrivateKey(process.env.FIREBASE_ADMIN_PRIVATE_KEY);
  if (projectId && clientEmail && privateKey && privateKey.includes('BEGIN PRIVATE KEY')) {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    console.log('Auth: FIREBASE_ADMIN_* env vars\n');
    return;
  }
  console.error(`
✖ Firebase Admin credentials not found. Use ONE of these:

  A) Service-account JSON file (recommended):
       1. Firebase Console → Project Settings → Service accounts → "Generate new private key"
       2. Save it as  serviceAccountKey.json  in this project folder (${process.cwd()})
       3. Re-run:  node scripts/reset-stale-passwords.mjs --dry-run

  B) Env vars in .env.local, then run with  node --env-file=.env.local ... :
       FIREBASE_ADMIN_PROJECT_ID / FIREBASE_ADMIN_CLIENT_EMAIL / FIREBASE_ADMIN_PRIVATE_KEY

  ⚠  serviceAccountKey.json is a secret — keep it out of git.
`);
  process.exit(1);
}

// Newest activity timestamp Firebase Auth has for the account (ms), or 0 if never.
function lastSeenMs(rec) {
  const t1 = rec.metadata?.lastSignInTime  ? Date.parse(rec.metadata.lastSignInTime)  : 0;
  const t2 = rec.metadata?.lastRefreshTime ? Date.parse(rec.metadata.lastRefreshTime) : 0;
  return Math.max(t1 || 0, t2 || 0);
}
const fmt = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : 'never');

// ─── Main ────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n── Stale-user password reset ──────────────────────────────────`);
  console.log(`Cutoff    : seen on/after ${CUTOFF_DATE} 00:00 (+05:30) → KEEP`);
  console.log(`Password  : ${SHARED_PASSWORD ? SHARED_PASSWORD + '  (shared — forced with --password)' : 'random per account (printed per row below)'}`);
  console.log(`Inactive  : ${INCLUDE_INACTIVE ? 'INCLUDED' : 'skipped (is_active=false)'}`);
  console.log(`Mode      : ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log(`───────────────────────────────────────────────────────────────\n`);

  initAdmin();
  const auth = getAuth();
  const dbFs = getFirestore();

  // 1. Every Firebase Auth account, keyed by uid and by email.
  const byUid = new Map(), byEmail = new Map();
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const rec of page.users) {
      byUid.set(rec.uid, rec);
      if (rec.email) byEmail.set(rec.email.toLowerCase(), rec);
    }
    pageToken = page.pageToken;
  } while (pageToken);
  console.log(`Firebase Auth accounts : ${byUid.size}`);

  // 2. Every app user from Firestore.
  const snap = await dbFs.collection('users').get();
  console.log(`Firestore user docs    : ${snap.size}\n`);

  const stats = { kept: 0, reset: 0, created: 0, linked: 0, skippedInactive: 0, skippedNoEmail: 0, skippedBootstrap: 0, invalidEmail: 0, errors: 0 };
  const problems = [];
  const matchedUids = new Set();
  let i = 0;

  for (const doc of snap.docs) {
    const u     = doc.data();
    const epf   = String(u.epf_number || doc.id);
    const email = fixEmail(u.email);
    const name  = u.display_name || u.name || `${u.first_name || ''} ${u.last_name || ''}`.trim();

    if (!email)                          { stats.skippedNoEmail++; problems.push(`[no-email]  ${epf} (${name})`); continue; }
    if (BOOTSTRAP_ADMIN_EMAILS.includes(email)) { stats.skippedBootstrap++; continue; }
    if (!EMAIL_RE.test(email))           { stats.invalidEmail++; problems.push(`[bad-email] ${epf} <${email}>`); continue; }

    // Resolve the Auth account: linked uid first, then email.
    const rec = (u.uid && byUid.get(u.uid)) || byEmail.get(email) || null;
    if (rec) matchedUids.add(rec.uid);

    const inactive = u.is_active === false;
    if (inactive && !INCLUDE_INACTIVE) { stats.skippedInactive++; continue; }

    try {
      i++;
      // Drawn per account so each row can print the password it actually set.
      const rowPassword = passwordFor();
      if (!rec) {
        // No Auth account at all — this user has NEVER been able to log in.
        stats.created++;
        if (DRY_RUN) { console.log(`${String(i).padStart(3)}. would CREATE ${email}  (${epf}, no auth account)`); continue; }
        const created = await auth.createUser({
          email, password: rowPassword, emailVerified: true,
          displayName: name || undefined, disabled: false,
        });
        await doc.ref.update({ uid: created.uid, email });
        stats.linked++;
        console.log(`${String(i).padStart(3)}. created  ${email}  (${epf})  pw: ${rowPassword}`);
        continue;
      }

      const seen = lastSeenMs(rec);
      if (seen >= CUTOFF_MS) {
        // Active since the cutoff — do NOT touch.
        stats.kept++; i--;
        continue;
      }

      stats.reset++;
      if (DRY_RUN) { console.log(`${String(i).padStart(3)}. would RESET  ${email}  (${epf}, last seen ${fmt(seen)})`); continue; }
      await auth.updateUser(rec.uid, { password: rowPassword, disabled: false });
      // Heal a missing uid link / email mismatch while we're here (fast-path login).
      const patch = {};
      if (u.uid !== rec.uid)   patch.uid = rec.uid;
      if (u.email !== email)   patch.email = email;
      if (Object.keys(patch).length) { await doc.ref.update(patch); if (patch.uid) stats.linked++; }
      console.log(`${String(i).padStart(3)}. reset    ${email}  (${epf}, last seen ${fmt(seen)})  pw: ${rowPassword}`);
    } catch (e) {
      stats.errors++;
      problems.push(`[error]     ${epf} <${email}> — ${e.code || ''} ${e.message || e}`);
      console.error(`${String(i).padStart(3)}. ERROR    ${email}  (${epf}) — ${e.code || e.message}`);
    }
  }

  // Informational: Auth accounts with no Firestore user doc (not touched).
  const orphans = [...byUid.values()].filter(r => !matchedUids.has(r.uid) && !BOOTSTRAP_ADMIN_EMAILS.includes(r.email?.toLowerCase()));

  console.log(`\n── Summary ────────────────────────────────────────────────────`);
  console.log(`Kept (seen ≥ ${CUTOFF_DATE})  : ${stats.kept}`);
  console.log(`Password reset (stale)   : ${stats.reset}`);
  console.log(`Created (no auth account): ${stats.created}`);
  console.log(`UID linked to doc        : ${stats.linked}`);
  console.log(`Skipped (inactive)       : ${stats.skippedInactive}`);
  console.log(`Skipped (no email)       : ${stats.skippedNoEmail}`);
  console.log(`Skipped (bootstrap)      : ${stats.skippedBootstrap}`);
  console.log(`Invalid email format     : ${stats.invalidEmail}`);
  console.log(`Errors                   : ${stats.errors}`);
  console.log(`Auth-only (untouched)    : ${orphans.length}`);
  console.log(`───────────────────────────────────────────────────────────────`);
  if (orphans.length) {
    console.log(`\nAuth accounts with no Firestore user doc (not modified):`);
    orphans.forEach(r => console.log(`  ${r.email ?? r.uid}  (last seen ${fmt(lastSeenMs(r))})`));
  }
  if (problems.length) {
    console.log(`\nNeeds attention (${problems.length}):`);
    problems.forEach(p => console.log('  ' + p));
  }
  console.log(DRY_RUN ? '\nDRY RUN complete — no changes were made.\n' : '\nDone.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
