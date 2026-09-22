// What the notification bell shows: which tab an item belongs to, which day-bucket it falls in,
// and the counts on the chips.
//
// Pure — no React, no firebase, and no clock: `now` is always passed in. This exists because
// NotificationCenter.tsx had no testable seam at all, and filtering and grouping are exactly the
// logic that breaks quietly: an item that lands in no group simply vanishes from the panel and
// nothing tells anyone.
//
// The item type is structural on purpose. The real one is CenterNotif in the notifications
// store, which imports zustand — a pure module cannot reach it, and does not need to.

/** The chips across the top of the panel. */
export type NotifTab = 'all' | 'unread' | 'approvals' | 'greetings';

/** The two content tabs, as opposed to the two state tabs (all / unread). */
export type NotifCategory = 'approvals' | 'greetings';

export type RecencyGroup = 'today' | 'yesterday' | 'week' | 'earlier';

/** The slice of a notification this module needs. */
export interface NotifLike {
  type?: string;
  read?: boolean;
  /** ISO timestamp. */
  time: string;
}

/**
 * Everything that is somebody waiting on a decision, or the answer to one: leave, attendance
 * edits, overtime, suspense advances and the generic approval request.
 *
 * Spelled out rather than pattern-matched on the name. A `startsWith('leave_')` test would
 * silently swallow a future `leave_balance_low` — an FYI, not an approval — into the tab an
 * approver uses as a to-do list.
 */
export const APPROVAL_NOTIF_TYPES: readonly string[] = [
  'approval_request',
  'attendance_edit', 'edit_approved', 'edit_rejected',
  'leave_request', 'leave_update', 'leave_assigned', 'leave_approved', 'leave_rejected',
  'leave_delete_request', 'leave_delete_approved', 'leave_delete_rejected',
  'ot_request', 'ot_approved', 'ot_rejected',
  'suspense_request', 'suspense_approved', 'suspense_rejected',
];

const APPROVAL_SET = new Set(APPROVAL_NOTIF_TYPES);

/** The content tab this type belongs to, or null when it belongs to neither. */
export function tabOf(type: string | undefined | null): NotifCategory | null {
  const t = String(type ?? '');
  if (!t) return null;
  if (t === 'greeting') return 'greetings';
  return APPROVAL_SET.has(t) ? 'approvals' : null;
}

export function filterByTab<T extends NotifLike>(items: T[], tab: NotifTab): T[] {
  switch (tab) {
    case 'all':     return items;
    case 'unread':  return items.filter(i => !i.read);
    default:        return items.filter(i => tabOf(i.type) === tab);
  }
}

/** Local midnight of whatever day this instant falls on. */
function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Which bucket a timestamp falls in, by CALENDAR day rather than by elapsed hours — 23:50
 * yesterday is "Yesterday" at 00:10 today, not "Today", which is how a person reads a list.
 *
 * A future timestamp (a clock skew between the device and the server) counts as today: it is
 * the only bucket where a person would look for something that has just arrived. An
 * unparseable date falls to 'earlier' so it still appears somewhere; dropping it would make
 * the item invisible with nothing to explain why.
 */
export function recencyOf(iso: string, nowIso: string): RecencyGroup {
  const t = new Date(iso);
  const now = new Date(nowIso);
  if (Number.isNaN(t.getTime()) || Number.isNaN(now.getTime())) return 'earlier';
  const days = Math.round((dayStart(now) - dayStart(t)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days <= 7) return 'week';
  return 'earlier';
}

const GROUP_ORDER: readonly RecencyGroup[] = ['today', 'yesterday', 'week', 'earlier'];

/**
 * The list as the panel renders it: newest bucket first, empty buckets absent, and the order
 * WITHIN each bucket exactly the order it was given (the store already sorts).
 *
 * Buckets are collected in one pass rather than by filtering four times, so an item can only
 * ever land in one — the property that stops a change here from showing something twice.
 */
export function groupByRecency<T extends NotifLike>(
  items: T[], nowIso: string,
): Array<{ group: RecencyGroup; items: T[] }> {
  const buckets = new Map<RecencyGroup, T[]>();
  for (const item of items) {
    const g = recencyOf(item.time, nowIso);
    const list = buckets.get(g);
    if (list) list.push(item); else buckets.set(g, [item]);
  }
  return GROUP_ORDER
    .filter(g => (buckets.get(g)?.length ?? 0) > 0)
    .map(g => ({ group: g, items: buckets.get(g) as T[] }));
}

/**
 * The number on each chip. `all` is everything and `unread` is what is unread; the two content
 * tabs count everything in their category, read or not, because that is what the tab shows when
 * you press it — a chip reading "Greetings 0" that opens onto three greetings would be a lie.
 */
export function tabCounts(items: NotifLike[]): Record<NotifTab, number> {
  const counts: Record<NotifTab, number> = { all: items.length, unread: 0, approvals: 0, greetings: 0 };
  for (const i of items) {
    if (!i.read) counts.unread++;
    const tab = tabOf(i.type);
    if (tab) counts[tab]++;
  }
  return counts;
}

/** The tabs worth showing: the two state tabs always, a content tab only when it has items. */
export function visibleTabs(counts: Record<NotifTab, number>): NotifTab[] {
  const out: NotifTab[] = ['all', 'unread'];
  if (counts.approvals > 0) out.push('approvals');
  if (counts.greetings > 0) out.push('greetings');
  return out;
}
