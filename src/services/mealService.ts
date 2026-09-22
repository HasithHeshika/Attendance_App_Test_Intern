import {
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, updateDoc, query, where, Timestamp,
} from 'firebase/firestore';
import { db, auth } from '@/lib/firebase';
import { epfDocId } from '@/services/userService';
import { mealOf, type MealType } from '@/lib/meals';
import type { AutoServeTarget } from '@/lib/mealAutoServe';
import type { LunchRequest, ChamaryMealOffday } from '@/lib/types';

// Meal bookings ("need breakfast/lunch/dinner") for one employee, one calendar day, one chamary.
// This is the CRUD + query layer behind the employee's own booking button, the chamary
// responsible person's daily list, and the monthly food report.
//
// The collection is still called `lunch_requests` and the TYPE is still `LunchRequest`: the
// feature began as lunch-only and there is live production data under those names. Renaming
// them would mean migrating every existing document for no behavioural gain, so the meal
// dimension was added as a field instead. Read `meal` through mealOf() — a record written
// before meal types existed has no `meal` and IS a lunch booking.
const COL     = 'lunch_requests';
const OFF_COL = 'chamary_meal_offdays';

export interface Actor { epf: string; name: string; }

// Doc id = epf + date (+ meal). LUNCH DELIBERATELY KEEPS THE LEGACY UNSUFFIXED ID so every
// existing lunch record stays addressable at the id it was written under; breakfast and dinner,
// which never existed before, get the suffix. One record per person per meal per day — booking
// again just overwrites, never duplicates.
function mealDocId(epf: string, date: string, meal: MealType): string {
  const base = `${epfDocId(epf)}__${date}`;
  return meal === 'lunch' ? base : `${base}__${meal}`;
}

function offdayDocId(chamaryId: string, date: string, meal: MealType): string {
  return `${chamaryId}__${date}__${meal}`;
}

export interface MealRequestInput {
  epf_number:         string;
  employee_name:      string;
  company_id:         string;
  company_name:       string;
  date:               string;   // YYYY-MM-DD
  meal:               MealType;
  chamary_id:         string;
  chamary_name:       string;
  working_place_id:   string;
  working_place_name: string;
}

// ─── Off-days (chamary not cooking) ───────────────────────────────────────────

/** Is this chamary NOT cooking `meal` on `date`? */
export async function getMealOffday(
  chamaryId: string, date: string, meal: MealType,
): Promise<ChamaryMealOffday | null> {
  if (!chamaryId || !date) return null;
  const snap = await getDoc(doc(db, OFF_COL, offdayDocId(chamaryId, date, meal)));
  return snap.exists() ? (snap.data() as ChamaryMealOffday) : null;
}

/** Every off-day marked for one chamary on one date — the responsible person's daily view. */
export async function getChamaryOffdaysForDay(chamaryId: string, date: string): Promise<ChamaryMealOffday[]> {
  if (!chamaryId || !date) return [];
  // Both filters server-side. Two equality filters need no composite index (Firestore merges
  // single-field indexes), and this used to pull every off-day the chamary had ever recorded
  // just to keep the ones for one date.
  const snap = await getDocs(query(
    collection(db, OFF_COL), where('chamary_id', '==', chamaryId), where('date', '==', date),
  ));
  return snap.docs.map(d => d.data() as ChamaryMealOffday);
}

/** A chamary's off-days for a whole month — the food report needs them to explain gaps. */
export async function getChamaryOffdaysMonthly(
  chamaryId: string, year: number, month: number,
): Promise<ChamaryMealOffday[]> {
  if (!chamaryId) return [];
  return monthDocs<ChamaryMealOffday>(OFF_COL, 'chamary_id', chamaryId, year, month);
}

/**
 * Mark a chamary as not cooking one meal on one day, and return the bookings that were cancelled
 * as a result so the caller can notify those people (this layer stays free of notification
 * concerns — see MyChamaryLunchCard for the notify step).
 *
 * Writing the marker BEFORE cancelling is deliberate: from that moment requestMeal() refuses
 * new bookings, so nobody can book into the gap between the two steps and end up silently
 * uncancelled.
 */
export async function setMealOffday(
  input: { chamary_id: string; chamary_name: string; date: string; meal: MealType; reason?: string },
  actor: Actor,
): Promise<LunchRequest[]> {
  const { chamary_id, chamary_name, date, meal } = input;
  if (!chamary_id || !date) throw new Error('Missing chamary or date.');

  const id = offdayDocId(chamary_id, date, meal);
  await setDoc(doc(db, OFF_COL, id), {
    id, chamary_id, chamary_name, date, meal,
    reason: input.reason ?? '',
    set_by: actor.epf, set_by_name: actor.name,
    created_at: Timestamp.now(),
  });

  const affected = (await getChamaryMealsForDay(chamary_id, date)).filter(r => mealOf(r.meal) === meal);
  for (const r of affected) {
    await deleteDoc(doc(db, COL, mealDocId(r.epf_number, date, meal))).catch(() => undefined);
  }
  return affected;
}

// Every calendar day from `from` to `to` inclusive ('YYYY-MM-DD'), capped so a typo cannot
// close a kitchen for a year: 92 days is a full quarter, longer than any shutdown this app
// has seen.
export const OFFDAY_RANGE_MAX_DAYS = 92;
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (!fy || !ty) return out;
  const cur = new Date(fy, fm - 1, fd);
  const end = new Date(ty, tm - 1, td);
  while (cur <= end && out.length < OFFDAY_RANGE_MAX_DAYS) {
    out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/**
 * Close a kitchen for a stretch of days — a shutdown, a site holiday, a cook on leave. One
 * off-day marker per (day, meal), written through setMealOffday so each day gets exactly the
 * same guarantee a single day gets: the marker lands first, then that day's bookings are
 * cancelled. Returns every booking cancelled across the range so the caller can notify the
 * people (this layer stays free of notification concerns, same as setMealOffday).
 *
 * Days that were already marked are simply re-marked (the doc id is idempotent), so re-running
 * the same closure is harmless.
 */
export async function setMealOffdayRange(
  input: { chamary_id: string; chamary_name: string; from: string; to: string; meals: MealType[]; reason?: string },
  actor: Actor,
): Promise<{ days: string[]; cancelled: LunchRequest[] }> {
  if (!input.chamary_id) throw new Error('Missing chamary.');
  if (!input.from || !input.to || input.to < input.from) throw new Error('Pick a start day and an end day, in that order.');
  const meals = input.meals.map(mealOf);
  if (!meals.length) throw new Error('Pick at least one meal.');
  const days = datesBetween(input.from, input.to);
  if (!days.length) throw new Error('Pick a start day and an end day.');
  const cancelled: LunchRequest[] = [];
  for (const date of days) {
    for (const meal of meals) {
      cancelled.push(...await setMealOffday({ ...input, date, meal, reason: input.reason }, actor));
    }
  }
  return { days, cancelled };
}

/** Reopen a kitchen across a stretch of days. Bookings cancelled while it was closed are NOT
 *  restored — people re-book, exactly as clearMealOffday behaves for one day. */
export async function clearMealOffdayRange(
  chamaryId: string, from: string, to: string, meals: MealType[],
): Promise<number> {
  const days = datesBetween(from, to);
  let n = 0;
  for (const date of days) {
    for (const meal of meals) { await clearMealOffday(chamaryId, date, mealOf(meal)); n += 1; }
  }
  return n;
}

/** Off-days for one chamary inside a date window — the "closed until" line on the chamary
 *  page. Single-field range on `date` after the equality on chamary_id: a composite index
 *  (chamary_id + date) is what getChamaryOffdaysMonthly already relies on, with the same
 *  whole-history fallback when it is not deployed yet. */
export async function getChamaryOffdaysRange(
  chamaryId: string, from: string, to: string,
): Promise<ChamaryMealOffday[]> {
  if (!chamaryId || !from || !to) return [];
  try {
    const snap = await getDocs(query(
      collection(db, OFF_COL), where('chamary_id', '==', chamaryId),
      where('date', '>=', from), where('date', '<=', to),
    ));
    return snap.docs.map(d => d.data() as ChamaryMealOffday).sort((a, b) => a.date.localeCompare(b.date));
  } catch (e) {
    if ((e as { code?: string })?.code !== 'failed-precondition') throw e;
    const snap = await getDocs(query(collection(db, OFF_COL), where('chamary_id', '==', chamaryId)));
    return snap.docs.map(d => d.data() as ChamaryMealOffday)
      .filter(o => o.date >= from && o.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}

/** Undo an off-day marker. Bookings cancelled by it are NOT restored — people re-book. */
export async function clearMealOffday(chamaryId: string, date: string, meal: MealType): Promise<void> {
  await deleteDoc(doc(db, OFF_COL, offdayDocId(chamaryId, date, meal))).catch(() => undefined);
}

// ─── Bookings ─────────────────────────────────────────────────────────────────

/**
 * Create/replace a meal booking. `actor` is whoever performed the write — the employee
 * themselves, or the chamary's responsible person adding someone to the day's list;
 * `requested_by` on the record distinguishes the two after the fact.
 *
 * Refuses if the chamary has marked that meal off for that day, so the "not cooking" state is
 * enforced at the write, not merely hidden in the UI.
 */
export async function requestMeal(input: MealRequestInput, actor: Actor): Promise<void> {
  if (!input.epf_number || !input.date || !input.chamary_id) {
    throw new Error('Missing employee, date, or chamary.');
  }
  const meal = mealOf(input.meal);

  const off = await getMealOffday(input.chamary_id, input.date, meal);
  if (off) {
    throw new Error(
      off.reason
        ? `${input.chamary_name} is not cooking ${meal} on ${input.date} — ${off.reason}`
        : `${input.chamary_name} is not cooking ${meal} on ${input.date}.`,
    );
  }

  const id  = mealDocId(input.epf_number, input.date, meal);
  const now = Timestamp.now();

  // THE PRICING SURVIVES A RE-BOOK. This setDoc replaces the whole document, and a booking may
  // carry a multiplier somebody set on it — what that person is charged for this meal. Two
  // reasons the fields are carried through verbatim rather than dropped:
  //
  //   1. Correctness. A move between chamaries, or an operator re-adding a name, must not
  //      quietly cancel a penalty the responsible person applied.
  //   2. It would simply fail. firestore.rules permits an update only when the multiplier is
  //      unchanged (it is a money field the client may never write), so a replace that omitted
  //      it would be refused with permission-denied on every priced booking.
  //
  // Absent keys stay absent, so a first-ever booking still satisfies the create rule's
  // `!('multiplier' in request.resource.data)`.
  const prior = (await getDoc(doc(db, COL, id))).data() as LunchRequest | undefined;
  const pricing: Partial<LunchRequest> = {};
  if (prior?.multiplier !== undefined) {
    pricing.multiplier = prior.multiplier;
    if (prior.multiplier_by !== undefined) pricing.multiplier_by = prior.multiplier_by;
    if (prior.multiplier_by_name !== undefined) pricing.multiplier_by_name = prior.multiplier_by_name;
    if (prior.multiplier_at !== undefined) pricing.multiplier_at = prior.multiplier_at;
    if (prior.multiplier_note !== undefined) pricing.multiplier_note = prior.multiplier_note;
  }

  await setDoc(doc(db, COL, id), {
    id, ...input, meal,
    // A fresh booking is undecided: not collected yet, and nobody has said it was missed. Both
    // written explicitly rather than left absent, because a re-booking overwrites the whole
    // document and has to CLEAR a no-show somebody marked against the booking it replaces.
    served: false, no_show: false, served_at: null, served_source: null,
    requested_by: actor.epf, requested_by_name: actor.name,
    created_at: now, updated_at: now,
    ...pricing,
  });
}

/**
 * Delete the booking for (epf, date, meal). When `expectedChamaryId` is given (the
 * responsible-person "Remove" path — they're deleting a record they can SEE belongs to their
 * chamary), read-before-delete and refuse if the record has since moved to a different chamary,
 * instead of blindly deleting whatever is currently there. Self-cancel (the employee removing
 * their OWN current booking, whatever it is) omits the guard — that delete is always correct.
 */
export async function cancelMeal(
  epf: string, date: string, meal: MealType, expectedChamaryId?: string,
): Promise<void> {
  const ref = doc(db, COL, mealDocId(epf, date, mealOf(meal)));
  if (expectedChamaryId) {
    const snap = await getDoc(ref);
    if (!snap.exists()) return;   // already gone — nothing to do
    if ((snap.data() as LunchRequest).chamary_id !== expectedChamaryId) {
      throw new Error('This person has since moved to a different chamary — refresh the list and try again.');
    }
  }
  await deleteDoc(ref);
}

/**
 * Tick/untick "actually collected the meal" — A PERSON's decision, either way.
 *
 * UNTICKING is the important half now that bookings serve themselves once the meal is over (see
 * markMealsAutoServed below): it is how the operator records the exception, so it writes
 * `no_show: true` and not merely `served: false`. Those two are not the same thing — `served:
 * false` on its own is also the state of every booking nobody has looked at yet, and without the
 * separate marker the next auto-serve pass would quietly tick the absentee straight back.
 *
 * Ticking clears the no-show, so a mistaken untick is undone by clicking again.
 */
/**
 * The employee's own statement that they did not take a meal they were booked for.
 *
 * WHY THIS EXISTS: auto-serve records today's lunch as collected once the meal window closes,
 * and the self-cancel button on /food is gated on `served !== true` — so from noon onwards a
 * person who never collected their lunch had no way to say so, and was pushed into the
 * approval-based meal_change_requests flow to correct a fact about their own day.
 *
 * Writes the same `no_show: true` an operator's untick writes, so it is equally durable: the
 * auto-serve pass skips `no_show === true` unconditionally and will not re-tick it tomorrow.
 * The operator keeps the last word — their tick on /chamary overwrites this, which is correct,
 * because they are the one who was standing at the counter.
 *
 * `served_source: 'employee'` is what keeps the two apart in the record.
 */
export async function markMealNotTaken(
  epf: string, date: string, meal: MealType,
): Promise<void> {
  await updateDoc(doc(db, COL, mealDocId(epf, date, mealOf(meal))), {
    served:        false,
    no_show:       true,
    served_source: 'employee',
    served_at:     null,
    updated_at:    Timestamp.now(),
  });
}

export async function setMealServed(
  epf: string, date: string, meal: MealType, served: boolean,
): Promise<void> {
  await updateDoc(doc(db, COL, mealDocId(epf, date, mealOf(meal))), {
    served,
    no_show:       !served,
    served_source: 'manual',
    served_at:     served ? Timestamp.now() : null,
    updated_at:    Timestamp.now(),
  });
}

/**
 * Record a batch of bookings as collected because their meal is over and nobody said otherwise.
 *
 * Deliberately dumb: it writes exactly the targets planAutoServe() handed it (src/lib/
 * mealAutoServe.ts holds every rule about WHICH bookings those are) and never touches `no_show`,
 * so an operator's own mark is never part of what this can overwrite. `served_source: 'auto'`
 * keeps a default distinguishable from a statement after the fact.
 *
 * A booking deleted between the read and the write is not an error — there is nothing left to
 * serve — so a missing document is swallowed and reported as a skip. Written one document at a
 * time in small waves rather than as a batch for exactly that reason: one removed name must not
 * take the other fifty-nine down with it.
 *
 * EVERY OTHER failure is a `failed` entry carrying the Firestore code, and the caller is expected
 * to say so on screen. This used to fold "gone" and "denied" into one anonymous counter that
 * nothing read, which made a run where every single write was refused look exactly like a run
 * with nothing to do — sixty-one meals sat unserved for five days behind that silence.
 */
export interface AutoServeOutcome {
  served:  AutoServeTarget[];
  /** Bookings that no longer exist. Normal, and deliberately not surfaced. */
  skipped: AutoServeTarget[];
  /** Bookings the write could not settle, with the Firestore error code that stopped it. */
  failed:  { target: AutoServeTarget; code: string }[];
}

export async function markMealsAutoServed(
  targets: readonly AutoServeTarget[],
): Promise<AutoServeOutcome> {
  const servedOk: AutoServeTarget[] = [];
  const skipped:  AutoServeTarget[] = [];
  const failed:   AutoServeOutcome['failed'] = [];
  const WAVE = 20;

  for (let i = 0; i < targets.length; i += WAVE) {
    const wave = targets.slice(i, i + WAVE);
    const now  = Timestamp.now();
    await Promise.all(wave.map(async (t) => {
      try {
        await updateDoc(doc(db, COL, mealDocId(t.epf_number, t.date, mealOf(t.meal))), {
          served: true,
          served_source: 'auto',
          served_at:  now,
          updated_at: now,
        });
        servedOk.push(t);
      } catch (e) {
        const code = (e as { code?: string })?.code ?? 'unknown';
        // `not-found` only means someone cancelled between the read and the write.
        if (code === 'not-found') skipped.push(t);
        else failed.push({ target: t, code });
      }
    }));
  }

  return { served: servedOk, skipped, failed };
}

export async function getMyMealForDate(
  epf: string, date: string, meal: MealType,
): Promise<LunchRequest | null> {
  if (!epf || !date) return null;
  const snap = await getDoc(doc(db, COL, mealDocId(epf, date, mealOf(meal))));
  return snap.exists() ? (snap.data() as LunchRequest) : null;
}

/** All of one person's bookings for one day, across every meal. */
export async function getMyMealsForDate(epf: string, date: string): Promise<LunchRequest[]> {
  if (!epf || !date) return [];
  // Filtered on the server: this runs on every dashboard load, and it was reading every meal
  // the person had ever booked to answer "what about today?".
  const snap = await getDocs(query(
    collection(db, COL), where('epf_number', '==', epf), where('date', '==', date),
  ));
  return snap.docs.map(d => d.data() as LunchRequest);
}

/**
 * A month's worth of docs, filtered on the SERVER when the composite index exists and in memory
 * when it does not.
 *
 * The range form (`field == x AND date >= … AND date <= …`) needs a composite index, and an
 * index deploy is a separate step from a code deploy — so on the first run after this ships,
 * before `firebase deploy --only firestore:indexes`, the range query fails with
 * `failed-precondition`. Rather than break the food report and everyone's month view in that
 * window, it falls back to the old whole-history read exactly once per call. Delete the fallback
 * when the indexes have been live for a while.
 */
async function monthDocs<T extends { date: string }>(
  col: string, field: 'epf_number' | 'chamary_id', value: string, year: number, month: number,
): Promise<T[]> {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const snap = await getDocs(query(
      collection(db, col),
      where(field, '==', value),
      where('date', '>=', `${prefix}-01`),
      where('date', '<=', `${prefix}-31`),
    ));
    return snap.docs.map(d => d.data() as T).filter(r => r.date.startsWith(prefix));
  } catch (e) {
    if ((e as { code?: string })?.code !== 'failed-precondition') throw e;
    const snap = await getDocs(query(collection(db, col), where(field, '==', value)));
    return snap.docs.map(d => d.data() as T).filter(r => r.date.startsWith(prefix));
  }
}

// This employee's bookings for a given month — the profile card and the food page's month view.
export async function getMyMealsThisMonth(epf: string, year: number, month: number): Promise<LunchRequest[]> {
  if (!epf) return [];
  const rows = await monthDocs<LunchRequest>(COL, 'epf_number', epf, year, month);
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

// Everyone booked at ONE chamary on a specific day, every meal — the responsible person's daily
// list (what they see and can add to, remove from, and tick as served).
export async function getChamaryMealsForDay(chamaryId: string, date: string): Promise<LunchRequest[]> {
  if (!chamaryId || !date) return [];
  // THE hot query: the meal button asks it once per chamary on every dashboard load, and the
  // food page once per chamary per day viewed. Without the date filter each call downloaded that
  // chamary's entire history — months of bookings across 300+ people — to keep one day of it.
  // Two equality filters, so no composite index is required.
  const snap = await getDocs(query(
    collection(db, COL), where('chamary_id', '==', chamaryId), where('date', '==', date),
  ));
  return snap.docs
    .map(d => d.data() as LunchRequest)
    .sort((a, b) => a.employee_name.localeCompare(b.employee_name));
}

// A chamary's full booking history for a month — the primitive the food report and the
// (proportional) food-deduction calc need: chamary's approved Food spend ÷ total meals this
// month × an employee's own meal count.
export async function getChamaryMealsMonthly(
  chamaryId: string, year: number, month: number,
): Promise<LunchRequest[]> {
  if (!chamaryId) return [];
  return monthDocs<LunchRequest>(COL, 'chamary_id', chamaryId, year, month);
}

// ─── Meal multiplier (penalty / credit) ───────────────────────────────────────
// Goes through the server because it changes what somebody is CHARGED: the chamary's bills are
// divided by the sum of multipliers, so a 2× meal costs that person double and lowers everyone
// else's share. firestore.rules refuses the field from a client for exactly that reason, so
// there is no client-SDK path here and there is not meant to be one.
export async function setMealMultiplier(input: {
  /** The booking, named the way every other mutation in this file names one. The document id is
   *  derived through mealDocId: the day lists read `d.data()` and carry no id of their own, so
   *  asking the caller for an id would mean a second id rule for the same collection. */
  epf: string;
  date: string;
  meal: MealType;
  multiplier: 0.5 | 1 | 1.5 | 2;
  note?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) return { ok: false, error: 'not-signed-in' };
    const res = await fetch('/api/food/meal-multiplier', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idToken,
        bookingId: mealDocId(input.epf, input.date, mealOf(input.meal)),
        multiplier: input.multiplier,
        note: input.note,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      // The server's own words: "You do not run that chamary", "Payroll for that month is
      // already finalised". Both tell the handler something a generic failure cannot.
      return { ok: false, error: typeof j?.error === 'string' ? j.error : `failed-${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? 'failed' };
  }
}

/** One chamary's contribution to a person's month, as the server worked it out. */
export interface MyFoodChamary {
  id: string; name: string;
  bookings: number; shares: number; charge: number;
  bills_total: number; share_price: number; bills_count: number;
}

export interface MyFoodCost {
  month: string;
  bookings: number;
  charge: number;
  /** False when no bills have been filed anywhere this person ate — say "not priced yet". */
  priced: boolean;
  /** True while the month is still running and its bills are still arriving. */
  provisional: boolean;
  byChamary: MyFoodChamary[];
  last_month: Omit<MyFoodCost, 'provisional' | 'last_month'> | null;
}

/**
 * What this month's meals cost me. Server-side, because the divisor is every booking at the
 * chamary that month — pricing one person from the browser would mean reading the whole
 * canteen's month (see /api/food/my-cost).
 */
export async function getMyFoodCost(monthKey: string, today: string): Promise<MyFoodCost | null> {
  try {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) return null;
    // POST, so serwist's 24-hour NetworkFirst cache over GET /api/* cannot keep one person's
    // food charge in Cache Storage and hand it back on a shared device — see the route.
    const res = await fetch('/api/food/my-cost', {
      method: 'POST',
      cache: 'no-store',
      // A header, not the query string: a URL reaches the access log and the browser history,
      // and an ID token is a live credential.
      headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ month: monthKey, today }),
    });
    if (!res.ok) return null;
    return await res.json() as MyFoodCost;
  } catch {
    // The page keeps its own "not priced yet" wording for this — a missing figure must never
    // become a confident LKR 0.00.
    return null;
  }
}
