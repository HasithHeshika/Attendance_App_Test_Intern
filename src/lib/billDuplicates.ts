// When is a suspense bill a re-submission of one already on file?
//
// Pure and free of Firestore so the rule can be unit-tested without a stub (see
// src/lib/__tests__/billDuplicates.test.ts). suspenseService does the reading and the throwing;
// everything about what counts as a duplicate is decided here.
//
// THREE THINGS, IN THIS ORDER: the SHOP, then the BILL DATE, then the AMOUNT. All three must
// agree before anything is called a duplicate, and each one on its own is enough to clear a
// bill. That order is also the order a person checks by eye — who was it from, when, how much —
// so the refusal message reads the same way the approver thinks.
//
//   1. SHOP — the supplier. Matched case- and whitespace-insensitively, or by the supplier's
//      VAT/TIN registration where the bill carries one: a registration number does not vary
//      with re-typing the way a hand-typed shop name does, so it catches "Abans" vs "Abans PLC".
//   2. BILL DATE — a bill dated a different day is a different purchase. Buying LKR 5,000 of
//      diesel at the same filling station on Monday and again on Thursday is two purchases, and
//      this guard once refused the second outright: the most ordinary thing this workforce does
//      was the thing it blocked hardest.
//   3. AMOUNT — to the cent.
//
// The FILE HASH is a separate, narrower signal and it sits INSIDE the same three-way gate: the
// same image sent twice for the same shop and date is a duplicate whatever amount was typed.
// It is not allowed to overrule the date — re-uploading one image under a genuinely different
// bill date gets through, which is the deliberate trade. A false refusal blocks honest work
// every day; this case needs someone to retype a date, and the approver still sees both bills
// side by side in the queue.
//
// Category and item are never checked — free-text descriptions carry no stable identity.
import type { SuspenseStatus } from './types';

/** The bill being submitted or edited. */
export interface CandidateBill {
  /** SHA-256 of the uploaded file. Empty when no new file is attached. */
  billHash:  string;
  amount:    number;
  shop:      string;
  /** The supplier's VAT/TIN registration. Empty unless this is a VAT bill. */
  vatNumber: string;
  /** The day ON THE BILL (YYYY-MM-DD) — not the day it was uploaded. */
  day:       string;
}

/** One bill already on file, flattened out of its Firestore document. */
export interface ExistingBill {
  id:        string;
  billHash?: string | null;
  amount:    number;
  shop?:     string | null;
  vatNumber?: string | null;
  /** The day on the bill, falling back to its submission day — i.e. billDayOf(). */
  day:       string;
  status:    SuspenseStatus;
  deleted?:  boolean;
  /** When it was submitted, in ms — what the 30-day window is measured against. */
  createdMs: number;
}

/** Which of the two signals fired. The caller words the refusal differently for each, because
 *  "you already uploaded this file" and "you already claimed this purchase" are different
 *  mistakes and the person needs to know which one they made. */
export type DuplicateReason = 'file' | 'shop' | 'vat';

export interface DuplicateMatch {
  bill:   ExistingBill;
  reason: DuplicateReason;
}

/** The window a re-submission is looked for in. Anything older is not a double-upload. */
export const DUPLICATE_WINDOW_DAYS = 30;
export const DUPLICATE_WINDOW_MS = DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * The first bill on file that `candidate` re-submits, or null when it is new.
 *
 * Skipped outright: the row being edited (`excludeId`), cancelled bills (withdrawn — their like
 * is free to submit again), rejected bills (a rejection is an invitation to re-file), and
 * anything submitted before `cutoffMs`.
 *
 * Then the date gate: only bills carrying the candidate's own bill date are considered at all.
 * Within that day the file signal is checked across every remaining row before the identity
 * signal, so a true re-upload is always reported as one even if another bill that day happens
 * to share its shop and amount.
 */
export function findDuplicateBill(
  candidate: CandidateBill,
  existing:  ExistingBill[],
  opts:      { cutoffMs: number; excludeId?: string },
): DuplicateMatch | null {
  const hash  = candidate.billHash;
  const amt   = money(candidate.amount);
  const shop  = norm(candidate.shop);
  const vat   = norm(candidate.vatNumber);

  const live = existing.filter(e =>
    e.id !== opts.excludeId && !e.deleted && e.status !== 'rejected' && e.createdMs >= opts.cutoffMs);

  // 1 — SHOP. Same supplier, by name or by VAT/TIN registration. A bill with neither a shop nor
  //     a registration identifies nothing and can never be matched on identity.
  const sameShop = live.filter(e =>
    (shop && norm(e.shop) === shop) || (vat && norm(e.vatNumber) === vat));

  // 2 — BILL DATE. A different date is a different purchase, full stop.
  const sameShopAndDay = sameShop.filter(e => e.day === candidate.day);

  // The same photograph, from the same shop, on the same date — a re-upload however the amount
  // was typed. Checked across the whole day-and-shop set before the amount, so a re-send with a
  // corrected amount is still recognised as the bill it is.
  const sameFile = hash ? sameShopAndDay.find(e => e.billHash === hash) : undefined;
  if (sameFile) return { bill: sameFile, reason: 'file' };

  // 3 — AMOUNT, to the cent. Now all three agree.
  for (const e of sameShopAndDay) {
    if (money(e.amount) !== amt) continue;
    return { bill: e, reason: (shop && norm(e.shop) === shop) ? 'shop' : 'vat' };
  }
  return null;
}
