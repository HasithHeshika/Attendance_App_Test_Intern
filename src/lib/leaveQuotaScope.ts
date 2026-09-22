/**
 * Which leave types are entitlements, and which are only tracked.
 *
 * A type flagged `excluded_from_quota` (see LeaveType) is recorded and reported like any other,
 * but it is not an allowance: it adds nothing to the quota, draws nothing down, and is never
 * refused as exhausted. Alta Vision sets it on Medical Leaves — a person's medical days should
 * not inflate the entitlement they appear to hold, and an illness is not something to run out
 * of. It is a per-type flag rather than a tenant check on purpose: the behaviour belongs to the
 * leave type, so a tenant that wants it ticks the box and every other tenant is untouched
 * because nobody ticked it.
 *
 * Pure and unit-tested, for the same reason approvalRouting.ts is: the alternative is reasoning
 * about a quota rule from inside a Firestore read, and this one decides every balance figure
 * every employee sees.
 */

/** The two fields of a leave-type doc this module reads. Deliberately `unknown`: these arrive
 *  straight off Firestore, where a field may be missing, null, or the wrong type entirely. */
export interface LeaveTypeScope {
  name?:                unknown;
  is_active?:           unknown;
  excluded_from_quota?: unknown;
}

/** Days round to the nearest half — the smallest unit a leave can be booked in. */
export const roundHalfDay = (n: unknown): number => Math.round((Number(n) || 0) * 2) / 2;

/**
 * The names of the ACTIVE types that carry no entitlement.
 *
 * Matched by name because that is what a leave document denormalises (`leave_type_name`); an id
 * would be the stabler key, but older leave docs do not reliably carry one.
 *
 * An inactive type is not listed. It has no rows to classify and no card to appear on, and
 * listing it would print "0 taken" for something the organisation has retired.
 */
export function excludedLeaveTypeNames(types: readonly LeaveTypeScope[]): Set<string> {
  const out = new Set<string>();
  for (const t of types) {
    if (t.is_active === false) continue;
    if (t.excluded_from_quota !== true) continue;
    const name = String(t.name ?? '').trim();
    if (name) out.add(name); // an unnamed type can never be matched against a leave record
  }
  return out;
}

/**
 * Whether a leave record's type is one of the excluded ones.
 *
 * Trimmed on both sides. A leave document carries the type name snapshotted when it was applied
 * for, and a stray space on either side would send those days into NEITHER tally: not the quota
 * (the type's row is filtered out by its flag, not by its name) and not the taken count (which
 * matches on the name). They would simply vanish.
 */
export function isExcludedTypeName(excluded: ReadonlySet<string>, leaveTypeName: unknown): boolean {
  return excluded.has(String(leaveTypeName ?? '').trim());
}

/** One tracked-but-not-entitled type, as the leave summary carries it. `type` is the same alias
 *  the quota rows use, so a caller can read either key without knowing which kind it holds. */
export interface ExcludedTakenRow {
  leave_type: string;
  type:       string;
  taken:      number;
}

/**
 * The days-taken rows for the excluded types.
 *
 * Every excluded type is listed, including at zero: "Medical Leaves · 0 taken" is an answer,
 * whereas a row that materialises only once somebody falls ill reads as a type that was just
 * invented. Sorted by name so the order is stable between reads rather than following
 * Firestore's document order.
 */
export function excludedTakenRows(
  excluded:    ReadonlySet<string>,
  takenByType: Readonly<Record<string, number>>,
): ExcludedTakenRow[] {
  return [...excluded]
    .map(name => ({ leave_type: name, type: name, taken: roundHalfDay(takenByType[name]) }))
    .sort((a, b) => a.leave_type.localeCompare(b.leave_type));
}
