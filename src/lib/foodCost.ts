// What a person's meals actually cost them: the chamary's bills, divided among the food it
// served, weighted by any penalty or credit on each booking.
//
// Pure — no firebase, no clock, no rounding of the divisor. Design: see
// docs/superpowers/specs/2026-09-06-food-cost-and-penalty-multipliers-design.md
//
// TWO RULES CARRY THE WHOLE THING, and both are easy to get subtly wrong:
//
//   1. EVERY BOOKING IS A SHARE, collected or not. This is the existing rule
//      (computeChamaryFoodReport counts every booking, and /food tells people a no-show is
//      "still charged"). Somebody who books and does not turn up has cost the kitchen the
//      food; dividing only by collected meals would move that cost onto their colleagues.
//
//   2. THE DIVISOR IS THE SUM OF MULTIPLIERS, not the booking count. Dividing by the count
//      would charge a 2× penalty double while everyone else paid exactly the same, so the
//      total charged would exceed the bills by the size of the penalty — money invented from
//      nothing. Weighted shares take the penalty out of everyone else's share instead, and
//      the books balance against the bills. `splitFoodCost` reports `unallocated` so that
//      balance is visible rather than assumed.
//
// Nothing here is ever stored. Cost is derived at read time from the bills and bookings that
// exist right now, which is why deleting a bill needs no recalculation step: the next read is
// simply correct.

/** The only values a handler may put on a meal. */
export const MEAL_MULTIPLIERS = [0.5, 1, 1.5, 2] as const;

export type MealMultiplier = typeof MEAL_MULTIPLIERS[number];

export function isMealMultiplier(v: unknown): v is MealMultiplier {
  return typeof v === 'number' && (MEAL_MULTIPLIERS as readonly number[]).includes(v);
}

/**
 * The multiplier on one booking. Absent, null, NaN, a string, or any number not in the list
 * all read as 1 — a stored value nobody can justify must never silently change what somebody
 * is charged, and 1 is the only safe reading of "we do not know".
 */
export function multiplierOf(row: { multiplier?: unknown } | null | undefined): MealMultiplier {
  const v = row?.multiplier;
  return isMealMultiplier(v) ? v : 1;
}

export interface CostBooking {
  epf: string;
  /** Absent means 1. Read through multiplierOf, never trusted raw. */
  multiplier?: unknown;
}

export interface CostInput {
  /** EVERY booking for one chamary in one month — collected or not (see rule 1). */
  bookings: CostBooking[];
  /** Bills filed against that chamary for the month; any status except rejected. */
  billsTotal: number;
}

export interface PersonCost {
  bookings: number;
  /** Sum of this person's multipliers — what they are charged in proportion to. */
  shares: number;
  /** LKR, rounded to 2 decimals. */
  charge: number;
}

export interface CostSplit {
  billsTotal: number;
  weightedShares: number;
  /** Unrounded on purpose: rounding the divisor would spread its error across everybody. */
  sharePrice: number;
  byPerson: Record<string, PersonCost>;
  /** Sum of the rounded per-person charges. */
  chargedTotal: number;
  /** billsTotal − chargedTotal. Signed, and shown to the chamary rather than hidden: 300
   *  people rounded independently will not sum to the bills to the cent, and nobody should be
   *  charged a rounding difference to make a total look tidy. */
  unallocated: number;
}

/** LKR to the cent. A number, not a string — the caller formats. */
function money(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Divide one chamary's month among the people who booked it.
 *
 * Total-safe by construction: with no bookings or no bills every charge is 0 and the whole
 * bill total lands in `unallocated`, so a caller can always tell "nobody has been charged for
 * this yet" from "this cost nothing".
 */
export function splitFoodCost(input: CostInput): CostSplit {
  const billsTotal = Number.isFinite(input?.billsTotal) ? Math.max(0, input.billsTotal) : 0;
  const bookings = input?.bookings ?? [];

  const byPerson: Record<string, PersonCost> = {};
  let weightedShares = 0;

  for (const b of bookings) {
    const epf = String(b?.epf ?? '').trim();
    if (!epf) continue;                      // a booking with no owner cannot be charged
    const m = multiplierOf(b);
    weightedShares += m;
    const row = byPerson[epf] ?? (byPerson[epf] = { bookings: 0, shares: 0, charge: 0 });
    row.bookings += 1;
    row.shares += m;
  }

  // No shares means no divisor. Zero prices everything at nothing rather than dividing by zero
  // and putting Infinity or NaN in front of somebody as a money figure.
  const sharePrice = weightedShares > 0 ? billsTotal / weightedShares : 0;

  let chargedTotal = 0;
  for (const row of Object.values(byPerson)) {
    row.charge = money(row.shares * sharePrice);
    chargedTotal += row.charge;
  }
  chargedTotal = money(chargedTotal);

  return {
    billsTotal,
    weightedShares,
    sharePrice,
    byPerson,
    chargedTotal,
    unallocated: money(billsTotal - chargedTotal),
  };
}

/** One person's charge from a split. 0 for somebody with no bookings that month. */
export function personCharge(split: CostSplit, epf: string): number {
  return split.byPerson[String(epf ?? '').trim()]?.charge ?? 0;
}

/** One person's booking and share counts, for a UI that explains the charge. */
export function personCost(split: CostSplit, epf: string): PersonCost {
  return split.byPerson[String(epf ?? '').trim()] ?? { bookings: 0, shares: 0, charge: 0 };
}

/**
 * Is this month still moving? A month in progress has bills yet to arrive, so its share price
 * usually rises — which is why every surface labels it provisional and shows last month's
 * settled figure beside it. `monthKey` is 'YYYY-MM' and `today` 'YYYY-MM-DD'; no clock is read
 * here, so a caller in Colombo and a test in UTC agree.
 */
export function isMonthProvisional(monthKey: string, today: string): boolean {
  return String(monthKey ?? '').slice(0, 7) >= String(today ?? '').slice(0, 7);
}

/**
 * The wall-clock Asia/Colombo bracket of a month, as epoch-ms — the window a month's BILLS are
 * counted in.
 *
 * It lives here, beside the split it feeds, because two surfaces print the same share price and
 * must bracket the month identically: /food asks the server (UTC on Netlify) and /chamary works
 * it out in the browser. `new Date(year, month - 1, 1)` reads whichever zone the caller happens
 * to sit in, so one bill filed at 02:00 on the 1st would fall in DIFFERENT months on the two
 * pages and the same kitchen would show two different prices. Every date in this app is a Sri
 * Lankan calendar day (see localDateString), and Sri Lanka has been a fixed UTC+05:30 with no
 * DST since 2006, so the literal offset is exact — the same reasoning as colomboWallClockMs in
 * shiftAutoClose.ts.
 *
 * A malformed key yields a window nothing can fall inside, so a bad month prices nothing rather
 * than pricing a year.
 */
export function colomboMonthWindow(monthKey: string): { fromMs: number; toMs: number } {
  const key = String(monthKey ?? '');
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    return { fromMs: 0, toMs: -1 };
  }
  const at = (yy: number, mm: number) =>
    new Date(`${yy}-${String(mm).padStart(2, '0')}-01T00:00:00+05:30`).getTime();
  return { fromMs: at(y, m), toMs: (m === 12 ? at(y + 1, 1) : at(y, m + 1)) - 1 };
}
