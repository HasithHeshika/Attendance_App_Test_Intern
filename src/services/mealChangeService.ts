import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { epfDocId } from '@/services/userService';
import { createAppNotification } from '@/services/notificationService';
import { mealOf, MEAL_LABEL, type MealType } from '@/lib/meals';
import { requestMeal, cancelMeal, setMealServed, type Actor } from '@/services/mealService';
import type { LunchRequest, MealChangeRequest, MealChangeKind } from '@/lib/types';

// Changing a meal booking AFTER its day has passed.
//
// A booking is not just a preference: it is one share of its chamary's monthly bill. The kitchen
// cooked and was billed on the strength of that list, and the deduction is the chamary's approved
// spend ÷ total meals × each person's own count — so quietly deleting yesterday's booking pushes
// its cost onto everyone else who ate. That is why the employee-facing path can only cancel
// TODAY's untouched booking (see frozenReason in MyLunchCount).
//
// This collection is the way round that wall: the employee states what is wrong and why, and the
// chamary's responsible person — or a food admin — decides. The booking itself is only touched
// when the request is approved, so the list the kitchen cooked from and the deduction it feeds
// can always be reconciled against a decision someone put their name to.
const COL = 'meal_change_requests';

/** Doc id — one request per (person, day, meal). Re-raising overwrites rather than piling up
 *  duplicates an approver would have to reconcile against each other. */
function changeId(epf: string, date: string, meal: MealType): string {
  return `${epfDocId(epf)}__${date}__${meal}`;
}

/** Where a booking lives — mirrors mealDocId in mealService: lunch keeps the legacy unsuffixed
 *  id, the other meals carry the suffix. */
function bookingDocId(epf: string, date: string, meal: MealType): string {
  const base = `${epfDocId(epf)}__${date}`;
  return meal === 'lunch' ? base : `${base}__${meal}`;
}

export interface MealChangeInput {
  booking: LunchRequest;
  kind:    MealChangeKind;
  reason:  string;
  /** Where it should have been booked instead — required for a 'move'. */
  to?: { chamary_id: string; chamary_name: string; meal: MealType };
}

/**
 * Raise a change request against one of your own past bookings.
 *
 * Notifies the chamary's responsible person: nobody watches a queue they were never told about.
 */
export async function createMealChangeRequest(
  input: MealChangeInput, actor: Actor, notifyEpf?: string | null,
): Promise<string> {
  const { booking, kind, reason, to } = input;
  const reasonText = reason.trim();
  if (!reasonText) throw new Error('Say why the change is needed.');
  if (kind === 'move' && !to?.chamary_id) throw new Error('Pick the chamary it should be moved to.');

  const meal = mealOf(booking.meal);
  const id   = changeId(booking.epf_number, booking.date, meal);

  const existing = await getDoc(doc(db, COL, id));
  if (existing.exists() && (existing.data() as MealChangeRequest).status === 'pending') {
    throw new Error('A change for this meal is already waiting for approval.');
  }

  const now = Timestamp.now();
  const record: MealChangeRequest = {
    id,
    epf_number:    booking.epf_number,
    employee_name: booking.employee_name,
    date:          booking.date,
    meal,
    chamary_id:    booking.chamary_id,
    chamary_name:  booking.chamary_name,
    kind,
    to_chamary_id:   to?.chamary_id ?? null,
    to_chamary_name: to?.chamary_name ?? null,
    to_meal:         to?.meal ?? null,
    reason: reasonText,
    status: 'pending',
    requested_by: actor.epf, requested_by_name: actor.name,
    requested_at: now,
    decided_by: null, decided_by_name: null, decided_at: null, decision_note: null,
  };
  await setDoc(doc(db, COL, id), record);

  if (notifyEpf) {
    await createAppNotification({
      toEpf: notifyEpf, type: 'general', actorEpf: actor.epf, actorName: actor.name,
      title: `${MEAL_LABEL[meal]} change needs approval`,
      body: `${booking.employee_name} asked to ${kind === 'remove' ? 'remove' : 'move'} their ${MEAL_LABEL[meal].toLowerCase()} on ${booking.date} at ${booking.chamary_name} — ${reasonText}`,
      link: '/chamary',
    });
  }
  return id;
}

/** One person's change requests, newest day first — the status line on their own food page. */
export async function getMyMealChangeRequests(epf: string): Promise<MealChangeRequest[]> {
  if (!epf) return [];
  const snap = await getDocs(query(collection(db, COL), where('epf_number', '==', epf)));
  return snap.docs
    .map(d => d.data() as MealChangeRequest)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Everything still waiting on a decision for these chamaries (the approver's queue). Chunked
 *  because Firestore's `in` takes at most 30 values, and a food admin may hold far more. */
export async function getPendingMealChanges(chamaryIds: string[]): Promise<MealChangeRequest[]> {
  const ids = chamaryIds.filter(Boolean);
  if (!ids.length) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
  const snaps = await Promise.all(chunks.map(chunk => getDocs(query(
    collection(db, COL), where('chamary_id', 'in', chunk), where('status', '==', 'pending'),
  ))));
  return snaps
    .flatMap(s => s.docs.map(d => d.data() as MealChangeRequest))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Approve a change and APPLY it — the two are one step on purpose. An approval that left the
 * booking untouched would be a decision nobody could see the effect of, and the count feeding
 * the deduction would still say something the approver has just agreed is wrong.
 *
 * A 'move' is a cancel plus a booking at the destination, in that order: one record per person
 * per meal per day is the invariant everything else relies on (see mealService's doc ids), so
 * the old one has to go before the new one lands. The original is read first for the company and
 * working-place fields, which the new record has to carry.
 */
export async function approveMealChange(req: MealChangeRequest, actor: Actor, note?: string): Promise<void> {
  if (req.status !== 'pending') throw new Error('This request has already been decided.');
  const meal = mealOf(req.meal);

  if (req.kind === 'remove') {
    await cancelMeal(req.epf_number, req.date, meal, req.chamary_id);
  } else {
    if (!req.to_chamary_id) throw new Error('This request has no destination chamary.');
    const toMeal   = mealOf(req.to_meal ?? meal);
    const snapshot = await getDoc(doc(db, 'lunch_requests', bookingDocId(req.epf_number, req.date, meal)));
    const original = snapshot.exists() ? (snapshot.data() as LunchRequest) : null;

    await cancelMeal(req.epf_number, req.date, meal, req.chamary_id);
    await requestMeal({
      epf_number:    req.epf_number,
      employee_name: req.employee_name,
      company_id:    original?.company_id ?? '',
      company_name:  original?.company_name ?? '',
      date:          req.date,
      meal:          toMeal,
      chamary_id:    req.to_chamary_id,
      chamary_name:  req.to_chamary_name ?? '',
      working_place_id:   original?.working_place_id ?? '',
      working_place_name: original?.working_place_name ?? '',
    }, actor);

    // A move is the same meal recorded against a different kitchen, so whether it was collected
    // travels with it. requestMeal() writes an UNDECIDED booking (it has no way to know it is
    // replacing one), which silently turned every approved move of an already-collected meal
    // into a no-show at the destination.
    if (original?.served === true || original?.no_show === true) {
      await setMealServed(req.epf_number, req.date, toMeal, original.served === true);
    }
  }

  await decide(req, 'approved', actor, note);
}

/** Turn a change down. The booking is left exactly as it is. */
export async function rejectMealChange(req: MealChangeRequest, actor: Actor, note?: string): Promise<void> {
  if (req.status !== 'pending') throw new Error('This request has already been decided.');
  await decide(req, 'rejected', actor, note);
}

async function decide(
  req: MealChangeRequest, status: 'approved' | 'rejected', actor: Actor, note?: string,
): Promise<void> {
  await updateDoc(doc(db, COL, req.id), {
    status,
    decided_by: actor.epf, decided_by_name: actor.name,
    decided_at: Timestamp.now(),
    decision_note: note?.trim() || null,
  });

  const meal = MEAL_LABEL[mealOf(req.meal)].toLowerCase();
  await createAppNotification({
    toEpf: req.epf_number, type: 'general', actorEpf: actor.epf, actorName: actor.name,
    title: status === 'approved' ? 'Meal change approved' : 'Meal change turned down',
    body: status === 'approved'
      ? `${actor.name} approved your request to ${req.kind === 'remove' ? 'remove' : 'move'} the ${meal} on ${req.date}.`
      : `${actor.name} turned down your request for the ${meal} on ${req.date}.${note?.trim() ? ` — ${note.trim()}` : ''}`,
    link: '/food',
  });
}
