// Is a bill date believable for a suspense expense?
//
// A suspense bill is a recent purchase reimbursed from a float someone is carrying, so its date
// sits within weeks of being handed in. Nothing enforced that, and it showed: 102 of 358 live
// bills (28%) carry a wrong YEAR with a correct day and month —
//
//     stored 2024-09-11 · submitted 2026-09-14        stored 2020-09-16 · submitted 2026-09-19
//     stored 2023-09-02 · submitted 2026-09-08        stored 2016-09-25 · submitted 2026-09-20
//
// — every one the final digit of the year misread by OCR (4, 0, 3, 8 for 6). Both extractors
// accepted them because each only checked that the string was a real calendar date:
//
//   * src/lib/ocr.ts (the tesseract fallback) also rejected FUTURE dates, and its comment
//     claimed Gemini followed "the same fail-closed rule";
//   * src/lib/geminiBillReader.ts (the PRIMARY path) had no future bound and no floor at all,
//     so the comment was wrong and the stronger check sat on the path used least.
//
// A wrong year is not cosmetic. billDayOf() keys a bill to its bill_date, so the bill vanishes
// from the approver's month (getSuspenseMonthData queries the bill_date range), lands in the
// wrong month's spend, and — since the duplicate guard checks shop → bill date → amount — stops
// matching its own re-submission, which is exactly where a double payment gets through.
//
// Pure and dependency-free so the rule is unit-tested rather than eyeballed, and so every entry
// point can share one definition.

/**
 * How far before submission an EXTRACTED date may fall before it is discarded.
 *
 * Chosen from the live data, which separates cleanly: the largest genuine gap observed between a
 * bill and its submission is ~40 days, while the smallest OCR year error is a full 365 (2025 read
 * for 2026). 180 days sits in the middle of that gap with room on both sides — generous to a late
 * receipt, and still catching every one of the 102 known-bad rows.
 */
export const BILL_DATE_MAX_AGE_DAYS = 180;

/** Clock skew and timezone slack — a receipt bought this evening must not read as tomorrow. */
export const BILL_DATE_FUTURE_GRACE_DAYS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight of a YYYY-MM-DD string, or null if it is not a real calendar date. Local, not
 *  UTC: bill dates are written as local midnight everywhere else in this app (see
 *  dateStrToTimestamp on the suspense page), and mixing the two shifts a bill a day. */
export function billDateMs(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() + 1 !== mo || dt.getDate() !== d) return null;
  return dt.getTime();
}

export type BillDateVerdict = 'ok' | 'future' | 'too-old' | 'malformed';

/** Why a bill date is or is not believable, judged against when it is being submitted. */
export function checkBillDate(iso: string, nowMs: number): BillDateVerdict {
  const at = billDateMs(iso);
  if (at === null) return 'malformed';
  if (at > nowMs + BILL_DATE_FUTURE_GRACE_DAYS * DAY_MS) return 'future';
  if (at < nowMs - BILL_DATE_MAX_AGE_DAYS * DAY_MS) return 'too-old';
  return 'ok';
}

/**
 * The gate for an EXTRACTED date — OCR or the AI reader. Fail closed: a date outside the window
 * is thrown away rather than stored, because the form then falls back to today and shows the
 * submitter an editable field holding the receipt they are looking at. A machine guessing 2020
 * silently is far worse than a machine declining to guess.
 */
export function isPlausibleExtractedBillDate(iso: string, nowMs: number): boolean {
  return checkBillDate(iso, nowMs) === 'ok';
}

/**
 * Read a three-number date off a bill — "26/8/8", "12/9/26", "2026-08-08" — choosing the
 * interpretation that could actually BE this bill.
 *
 * This is the real bug behind the wrong years. A receipt printed `26/8/8` means 8 August 2026
 * (YY/M/D), but read day-first it is 26 August 2008, and that is exactly what was being stored.
 * The three numbers are genuinely ambiguous; what resolves them is not a convention but the
 * calendar: a suspense bill is a recent purchase, so 2008 is impossible and 2026 is the only
 * reading that survives.
 *
 * Every ordering is tried, two-digit years are expanded into this century, and only readings
 * inside the plausible window are kept. If several survive, day-first wins — the local
 * convention. If none do, null: better to ask than to guess a year.
 */
export function readAmbiguousBillDate(a: number, b: number, c: number, nowMs: number): string | null {
  const y2 = (n: number) => (n < 100 ? 2000 + n : n);
  const iso = (y: number, mo: number, d: number): string | null => {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const s = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return billDateMs(s) === null ? null : s;
  };
  // Ordered by preference, so a tie breaks toward the local day-first convention.
  const readings = [
    iso(y2(c), b, a),   // D/M/Y  — "12/9/26" -> 2026-09-12
    iso(y2(a), b, c),   // Y/M/D  — "26/8/8"  -> 2026-08-08
    iso(y2(c), a, b),   // M/D/Y  — "9/12/26" -> 2026-09-12
  ];
  const plausible = readings.filter((s): s is string => s !== null && isPlausibleExtractedBillDate(s, nowMs));
  return plausible[0] ?? null;
}

/**
 * The message for a date a PERSON typed, or null when there is nothing to say.
 *
 * Deliberately a warning and not a refusal, except for the future. Someone occasionally hands in
 * a genuinely old receipt, and a hard floor would block honest work to chase a typo — but a date
 * in the future cannot be a receipt anyone holds, and one of those is already in production.
 */
export function billDateWarning(iso: string, nowMs: number): { level: 'block' | 'warn'; message: string } | null {
  const verdict = checkBillDate(iso, nowMs);
  if (verdict === 'ok') return null;
  if (verdict === 'malformed') return { level: 'block', message: 'Enter the bill date.' };
  if (verdict === 'future') {
    return { level: 'block', message: 'That bill date is in the future — check the year on the receipt.' };
  }
  const days = Math.round((nowMs - (billDateMs(iso) as number)) / DAY_MS);
  return {
    level: 'warn',
    message: `That bill date is ${days} days ago — check the year on the receipt before submitting.`,
  };
}
