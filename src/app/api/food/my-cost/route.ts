import { NextRequest, NextResponse } from 'next/server';
import type { Firestore } from 'firebase-admin/firestore';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { verifySignedInCaller } from '@/lib/adminCaller';
import {
  splitFoodCost, personCost, isMonthProvisional, colomboMonthWindow, type CostBooking,
} from '@/lib/foodCost';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What this person's meals cost them, for a month and the month before it.
 *
 * WHY THIS IS A ROUTE AND NOT A CLIENT CALCULATION. The divisor is every booking at that
 * chamary for the month (see foodCost.ts), so pricing ONE person's meals needs the whole
 * canteen's month — around 6,600 documents for a 300-person site. Having every employee's
 * browser read that to display one figure is exactly the fan-out this tenant cannot afford.
 * The split happens here, once per chamary per month, and the answer is a handful of numbers.
 *
 * The previous month travels with it because a month in progress is provisional: its bills are
 * still arriving, so its share price usually rises. A provisional figure with nothing to compare
 * against is not information, and last month is the only evidence of where this one lands.
 */

/**
 * One chamary's month, split once and reused.
 *
 * Three hundred people opening /food on the same morning would otherwise each trigger the same
 * six-thousand-document read. The split is a pure function of bookings and bills, so caching it
 * briefly is safe: the only cost of a stale entry is a figure up to a minute behind, on a number
 * that is explicitly labelled provisional anyway.
 */
const SPLIT_TTL_MS = 60_000;

interface ChamarySplit {
  split: ReturnType<typeof splitFoodCost>;
  billsCount: number;
}
const splitCache = new Map<string, { at: number; value: ChamarySplit }>();

const MONTH = /^\d{4}-\d{2}$/;

async function splitFor(db: Firestore, chamaryId: string, monthKey: string): Promise<ChamarySplit> {
  const prefix = monthKey;

  // Same shape as monthDocs() on the client: the range query while its index exists, the
  // single-field query when it does not, so a missing composite index degrades to a wider read
  // rather than a 500.
  const col = db.collection('lunch_requests');
  let docs;
  try {
    docs = (await col
      .where('chamary_id', '==', chamaryId)
      .where('date', '>=', `${prefix}-01`)
      .where('date', '<=', `${prefix}-31`)
      .get()).docs;
  } catch {
    docs = (await col.where('chamary_id', '==', chamaryId).get()).docs;
  }
  const bookings: CostBooking[] = docs
    .map(d => d.data())
    .filter(r => String(r?.date ?? '').startsWith(prefix))
    .map(r => ({ epf: String(r.epf_number ?? ''), multiplier: r.multiplier }));

  // Bills of ANY status but rejected, and never a deleted one: a bill counts from the moment it
  // is filed, because the kitchen has already spent that money. Same window and same field as
  // getChamaryExpenses, so the two never disagree about what a month's bills are.
  const { fromMs, toMs } = colomboMonthWindow(monthKey);
  const bills = (await db.collection('suspense_submissions')
    .where('chamary_id', '==', chamaryId).get()).docs
    .map(d => d.data())
    .filter(b => !b?.deleted && String(b?.status ?? '') !== 'rejected')
    .filter(b => {
      // created_at ONLY, never considered_at: a bill counts from the moment it is filed. Keying
      // on the approval date would move a bill out of a settled month the instant somebody
      // signed it off — see the same reasoning in getChamaryExpenses, which this must match
      // exactly or the two pages price one kitchen differently.
      const at = b?.created_at?.toMillis?.() ?? 0;
      return at >= fromMs && at <= toMs;
    });
  const billsTotal = bills.reduce((sum, b) => sum + (Number(b?.amount) || 0), 0);

  return { split: splitFoodCost({ bookings, billsTotal }), billsCount: bills.length };
}

async function cachedSplit(
  db: Firestore, dbKey: string, chamaryId: string, monthKey: string,
): Promise<ChamarySplit> {
  const key = `${dbKey}::${chamaryId}::${monthKey}`;
  const hit = splitCache.get(key);
  if (hit && Date.now() - hit.at < SPLIT_TTL_MS) return hit.value;
  const value = await splitFor(db, chamaryId, monthKey);
  splitCache.set(key, { at: Date.now(), value });
  return value;
}

function previousMonth(monthKey: string): string {
  const y = Number(monthKey.slice(0, 4));
  const m = Number(monthKey.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** This person's charge for one month, across every chamary they booked at. */
async function monthCost(db: Firestore, dbKey: string, epf: string, monthKey: string) {
  const prefix = monthKey;
  const col = db.collection('lunch_requests');
  let mine;
  try {
    mine = (await col
      .where('epf_number', '==', epf)
      .where('date', '>=', `${prefix}-01`)
      .where('date', '<=', `${prefix}-31`)
      .get()).docs;
  } catch {
    mine = (await col.where('epf_number', '==', epf).get()).docs;
  }
  const rows = mine.map(d => d.data()).filter(r => String(r?.date ?? '').startsWith(prefix));

  const names = new Map<string, string>();
  for (const r of rows) {
    const id = String(r?.chamary_id ?? '');
    if (id && !names.has(id)) names.set(id, String(r?.chamary_name ?? id));
  }

  const byChamary = [];
  let charge = 0;
  let anyBills = false;
  for (const [id, name] of names) {
    const { split, billsCount } = await cachedSplit(db, dbKey, id, monthKey);
    const mineHere = personCost(split, epf);
    if (billsCount > 0) anyBills = true;
    charge += mineHere.charge;
    byChamary.push({
      id,
      name,
      bookings: mineHere.bookings,
      shares: mineHere.shares,
      charge: mineHere.charge,
      // The chamary's own reconciliation, so /food can explain where the figure came from
      // rather than asking anyone to trust it.
      bills_total: split.billsTotal,
      share_price: Math.round(split.sharePrice * 100) / 100,
      bills_count: billsCount,
    });
  }

  return {
    month: monthKey,
    bookings: rows.length,
    charge: Math.round(charge * 100) / 100,
    // False means no bills have been filed anywhere this person ate, so the caller must say
    // "not priced yet" rather than print a confident LKR 0.00.
    priced: anyBills,
    byChamary,
  };
}

/**
 * POST, not GET, and that is not a stylistic choice.
 *
 * serwist's `defaultCache` (src/app/sw.ts) exempts only `/api/auth/*` as NetworkOnly and then
 * matches EVERY other same-origin **GET** `/api/*` with a 24-hour NetworkFirst cache. A GET here
 * would therefore have one person's food charge written into Cache Storage for a day, and served
 * back from it whenever the network is slow or absent — including to whoever opens the app next
 * on a shared phone. The cache rule is method-scoped, so a POST is never written to or read from
 * it. Same reason /api/auth/passkey/* and the payslip routes are POST.
 *
 * The token rides in the Authorization header, never the URL: a URL reaches the access log, the
 * browser history and any Referer.
 */
export async function POST(req: NextRequest) {
  const db = adminDbFor(req);
  let body: { month?: unknown; today?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }

  const header = req.headers.get('authorization') ?? '';
  const idToken = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const caller = await verifySignedInCaller(db, idToken);
  if (!caller) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const monthKey = String(body.month ?? '').trim();
  if (!MONTH.test(monthKey)) return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 });
  const today = String(body.today ?? '').trim();

  // Keyed by host so one deployment serving several domains cannot serve one tenant's split to
  // another. Two tenant records sharing a database simply get two warm entries, which is only a
  // duplicated read and never a wrong number.
  const dbKey = req.headers.get('host') ?? 'default';

  const [current, previous] = await Promise.all([
    monthCost(db, dbKey, caller.epf, monthKey),
    monthCost(db, dbKey, caller.epf, previousMonth(monthKey)).catch(() => null),
  ]);

  return NextResponse.json({
    ...current,
    // Provisional while the month is still running: bills arrive after the meals they paid for,
    // so the figure usually rises. `today` comes from the caller because the month rolls over in
    // Colombo, not in UTC.
    provisional: today ? isMonthProvisional(monthKey, today) : false,
    last_month: previous && previous.bookings > 0 ? previous : null,
  });
}
