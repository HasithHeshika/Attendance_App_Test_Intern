/**
 * backfill-split-debits.mjs — one-off migration for the suspense split model change.
 *
 * WHY
 *   Approval used to debit a bill's OWN SHARE (amount − splits) on the theory that split
 *   portions were recovered from colleagues' salaries and never touched the float. The cash
 *   left the payer's hand all the same, so their balance overstated what they actually held —
 *   one payer was LKR 12,792 down while the app showed him holding a positive float, and two
 *   fully-split bills debited exactly nothing.
 *
 *   approveSubmission now debits the WHOLE bill and recoverSplit credits each portion back as
 *   payroll deducts it. This script applies that rule to bills approved BEFORE the change:
 *   for each one it posts a single adjustment debiting the part that was never taken.
 *
 *   It does NOT touch the splits themselves. They carry no `recovered_at`, so they already show
 *   up in the Recoveries tab and will credit back through the normal path.
 *
 * SAFETY
 *   - DRY RUN unless --yes is given. The dry run writes nothing and prints the exact postings.
 *   - Idempotent: a bill already carrying a backfill entry (ref_id = bill id, note tagged
 *     BACKFILL_TAG) is skipped, so re-running can never double-debit.
 *   - Each bill is one transaction: balance and ledger entry move together or not at all.
 *   - Skips cancelled and non-approved bills, and refuses to touch a closed account.
 *
 * USAGE
 *   node scripts/backfill-split-debits.mjs                 # dry run, default database
 *   node scripts/backfill-split-debits.mjs --db test       # dry run against a named database
 *   node scripts/backfill-split-debits.mjs --yes           # APPLY
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKFILL_TAG = '[split-debit-backfill]';

function loadEnv(p) {
  if (!existsSync(p)) return {};
  const out = {};
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}
const env = { ...loadEnv(resolve(ROOT, '.env')), ...loadEnv(resolve(ROOT, '.env.local')) };

function normalizePrivateKey(k) {
  if (!k) return '';
  let s = k.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  if (!s.includes('BEGIN PRIVATE KEY')) {
    try { const d = Buffer.from(s, 'base64').toString('utf8'); if (d.includes('BEGIN PRIVATE KEY')) s = d; } catch {}
  }
  return s.replace(/\\n/g, '\n');
}

const argv    = process.argv.slice(2);
const APPLY   = argv.includes('--yes');
const dbArg   = argv.includes('--db') ? argv[argv.indexOf('--db') + 1] : null;
const ACTOR   = { epf: 'system', name: 'Split debit backfill' };

const app = initializeApp({
  credential: cert({
    projectId:   env.FIREBASE_ADMIN_PROJECT_ID,
    clientEmail: env.FIREBASE_ADMIN_CLIENT_EMAIL,
    privateKey:  normalizePrivateKey(env.FIREBASE_ADMIN_PRIVATE_KEY),
  }),
});
const dbId = (dbArg ?? env.FIRESTORE_DB_ID ?? '').trim();
const db = dbId && dbId !== '(default)' ? getFirestore(app, dbId) : getFirestore(app);

const money = n => Math.round((Number(n) || 0) * 100) / 100;
const splitsTotal = s => money((s ?? []).reduce((t, x) => t + money(x?.amount), 0));
// Mirrors accountId() in suspenseService, which uses epfDocId() from userService: a "/" in an
// EPF becomes "%2F" so the id stays ONE path segment. Real ids look like "EMPAV%2F00062__1" —
// getting this wrong makes every slashed EPF miss its account and silently skip.
const epfDocId  = epf => String(epf).replace(/\//g, '%2F');
const accountId = (epf, companyId) => `${epfDocId(epf)}__${companyId}`;

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} · project ${env.FIREBASE_ADMIN_PROJECT_ID} · db ${dbId || '(default)'}\n`);

const subs = (await db.collection('suspense_submissions').get()).docs.map(d => ({ id: d.id, ...d.data() }));
const ledger = (await db.collection('suspense_ledger').get()).docs.map(d => d.data());
const alreadyDone = new Set(
  ledger.filter(e => typeof e.note === 'string' && e.note.includes(BACKFILL_TAG) && e.ref_id).map(e => e.ref_id),
);

const targets = subs.filter(s =>
  s.status === 'approved' && !s.deleted && Array.isArray(s.splits) && s.splits.length > 0
  && splitsTotal(s.splits) > 0 && !alreadyDone.has(s.id));

if (!targets.length) {
  console.log('Nothing to backfill — every approved split bill already carries its full debit.');
  process.exit(0);
}

const plan = targets.map(s => ({
  bill: s.bill_no ?? s.id, payer: s.employee_name, epf: s.epf_number,
  company: s.company_name, billAmount: money(s.amount),
  alreadyDebited: money(money(s.amount) - splitsTotal(s.splits)), toDebitNow: splitsTotal(s.splits),
}));
console.table(plan);
const totals = new Map();
for (const s of targets) {
  const k = `${s.epf_number}__${s.company_id}`;
  totals.set(k, money((totals.get(k) ?? 0) + splitsTotal(s.splits)));
}
console.log('\nPer account, the extra debit this will post:');
console.table([...totals].map(([k, v]) => ({ account: k, extraDebit: v })));
console.log(`\n${targets.length} bill(s), LKR ${money([...totals.values()].reduce((t, v) => t + v, 0))} total.`);
console.log('Those amounts then appear in the Recoveries tab and credit back as payroll deducts them.');

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --yes to apply.');
  process.exit(0);
}

let done = 0, failed = 0;
for (const s of targets) {
  const extra = splitsTotal(s.splits);
  const subRef = db.collection('suspense_submissions').doc(s.id);
  const accRef = db.collection('suspense_accounts').doc(accountId(s.epf_number, s.company_id));
  try {
    await db.runTransaction(async tx => {
      const accSnap = await tx.get(accRef);
      if (!accSnap.exists) throw new Error('no account doc');
      const acc = accSnap.data();
      if (acc.is_closed) throw new Error('account is closed');
      // Re-check inside the transaction: a concurrent run must not post this twice.
      const dupe = await tx.get(
        db.collection('suspense_ledger').where('ref_id', '==', s.id).where('kind', '==', 'adjustment'),
      );
      if (dupe.docs.some(d => (d.data().note ?? '').includes(BACKFILL_TAG))) throw new Error('already backfilled');

      const now = Timestamp.now();
      const balAfter = money(acc.balance - extra);
      const ledRef = db.collection('suspense_ledger').doc();
      tx.update(accRef, { balance: balAfter, updated_at: now });
      tx.set(ledRef, {
        id: ledRef.id, epf_number: s.epf_number, company_id: s.company_id, kind: 'adjustment',
        amount: -extra, balance_after: balAfter, ref_type: 'submission', ref_id: s.id,
        note: `${BACKFILL_TAG} Split portion of bill ${s.bill_no ?? s.id} that was never debited — owed back to you as payroll deducts it`,
        actor_epf: ACTOR.epf, actor_name: ACTOR.name, created_at: now,
      });
      tx.update(subRef, { updated_at: now });
    });
    done++;
    console.log(`  ok   bill ${s.bill_no ?? s.id} · ${s.employee_name} · −${extra}`);
  } catch (e) {
    failed++;
    console.log(`  SKIP bill ${s.bill_no ?? s.id} · ${s.employee_name} · ${e.message}`);
  }
}
console.log(`\napplied ${done}, skipped ${failed}`);
process.exit(failed ? 1 : 0);
