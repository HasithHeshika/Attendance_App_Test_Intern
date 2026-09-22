import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tabOf, filterByTab, recencyOf, groupByRecency, tabCounts, visibleTabs,
  APPROVAL_NOTIF_TYPES, type NotifLike,
} from '../notificationCenter';

const n = (o: Partial<NotifLike> = {}): NotifLike => ({
  type: 'announcement', read: false, time: '2026-09-05T09:00:00', ...o,
});

// Local time throughout: the buckets are calendar days as the reader's device sees them, so the
// fixtures carry no Z and no offset.
const NOW = '2026-09-05T14:00:00';

test('tabOf: greetings, approvals, and everything that is neither', () => {
  assert.equal(tabOf('greeting'), 'greetings');
  assert.equal(tabOf('leave_request'), 'approvals');
  assert.equal(tabOf('ot_approved'), 'approvals');
  assert.equal(tabOf('suspense_request'), 'approvals');
  assert.equal(tabOf('attendance_edit'), 'approvals');
  assert.equal(tabOf('announcement'), null);
  assert.equal(tabOf('security_alert'), null);
  assert.equal(tabOf('reminder'), null);
  assert.equal(tabOf(''), null);
  assert.equal(tabOf(undefined), null);
});

test('tabOf: every declared approval type really lands in the approvals tab', () => {
  for (const t of APPROVAL_NOTIF_TYPES) assert.equal(tabOf(t), 'approvals', t);
  // The set is spelled out, not prefix-matched — a leave-shaped name that is not an approval
  // must NOT be swept into an approver's to-do list.
  assert.equal(tabOf('leave_balance_low'), null);
});

test('filterByTab: all is everything, unread is unread, content tabs are their own', () => {
  const items = [
    n({ type: 'greeting', read: true }),
    n({ type: 'leave_request', read: false }),
    n({ type: 'announcement', read: false }),
  ];
  assert.equal(filterByTab(items, 'all').length, 3);
  assert.deepEqual(filterByTab(items, 'unread').map(i => i.type), ['leave_request', 'announcement']);
  assert.deepEqual(filterByTab(items, 'greetings').map(i => i.type), ['greeting']);
  assert.deepEqual(filterByTab(items, 'approvals').map(i => i.type), ['leave_request']);
  // A content tab shows read items too — it is a category, not a to-do state.
  assert.equal(filterByTab(items, 'greetings')[0].read, true);
});

test('recencyOf: calendar-day boundaries, not elapsed hours', () => {
  assert.equal(recencyOf('2026-09-05T00:10:00', NOW), 'today');
  assert.equal(recencyOf('2026-09-05T23:59:00', NOW), 'today');
  // Ten minutes before midnight yesterday is Yesterday, even a few minutes later in real time.
  assert.equal(recencyOf('2026-09-04T23:50:00', '2026-09-05T00:10:00'), 'yesterday');
  assert.equal(recencyOf('2026-09-04T08:00:00', NOW), 'yesterday');
  assert.equal(recencyOf('2026-09-03T08:00:00', NOW), 'week');
  // Exactly seven days back is still the week; the eighth is Earlier.
  assert.equal(recencyOf('2026-08-29T08:00:00', NOW), 'week');
  assert.equal(recencyOf('2026-08-28T08:00:00', NOW), 'earlier');
  assert.equal(recencyOf('2026-01-01T08:00:00', NOW), 'earlier');
});

test('recencyOf: a future stamp is today, and an unreadable one still gets a bucket', () => {
  // Device clocks run ahead of the server's. "Today" is where a person looks for what just came.
  assert.equal(recencyOf('2026-09-06T02:00:00', NOW), 'today');
  // Never undefined: an item with no bucket would disappear from the panel silently.
  assert.equal(recencyOf('not a date', NOW), 'earlier');
  assert.equal(recencyOf('2026-09-05T09:00:00', 'not a date'), 'earlier');
});

test('groupByRecency: fixed order, empty groups omitted, input order kept inside a group', () => {
  const items = [
    n({ type: 'a', time: '2026-09-05T12:00:00' }),
    n({ type: 'b', time: '2026-09-05T08:00:00' }),
    n({ type: 'c', time: '2026-08-01T08:00:00' }),
    n({ type: 'd', time: '2026-09-03T08:00:00' }),
  ];
  const out = groupByRecency(items, NOW);
  // No 'yesterday' group at all rather than an empty one.
  assert.deepEqual(out.map(g => g.group), ['today', 'week', 'earlier']);
  assert.deepEqual(out[0].items.map(i => i.type), ['a', 'b']);
  assert.deepEqual(out[1].items.map(i => i.type), ['d']);
  assert.deepEqual(out[2].items.map(i => i.type), ['c']);
});

test('groupByRecency: nothing is lost and nothing is shown twice', () => {
  const items = Array.from({ length: 12 }, (_, i) => n({
    type: `t${i}`,
    time: `2026-0${i < 5 ? 9 : 8}-${String((i % 9) + 1).padStart(2, '0')}T08:00:00`,
  }));
  const out = groupByRecency(items, NOW);
  const flat = out.flatMap(g => g.items);
  assert.equal(flat.length, items.length);
  assert.equal(new Set(flat.map(i => i.type)).size, items.length);
});

test('groupByRecency: an empty list is an empty list, not one empty group', () => {
  assert.deepEqual(groupByRecency([], NOW), []);
});

test('tabCounts: all and unread by state, content tabs by category', () => {
  const items = [
    n({ type: 'greeting', read: true }),
    n({ type: 'greeting', read: false }),
    n({ type: 'leave_request', read: false }),
    n({ type: 'announcement', read: true }),
  ];
  assert.deepEqual(tabCounts(items), { all: 4, unread: 2, approvals: 1, greetings: 2 });
  assert.deepEqual(tabCounts([]), { all: 0, unread: 0, approvals: 0, greetings: 0 });
});

test('visibleTabs: a content chip appears only when it has something behind it', () => {
  assert.deepEqual(visibleTabs({ all: 0, unread: 0, approvals: 0, greetings: 0 }), ['all', 'unread']);
  assert.deepEqual(visibleTabs({ all: 3, unread: 1, approvals: 2, greetings: 0 }), ['all', 'unread', 'approvals']);
  assert.deepEqual(visibleTabs({ all: 3, unread: 1, approvals: 0, greetings: 3 }), ['all', 'unread', 'greetings']);
  assert.deepEqual(
    visibleTabs({ all: 5, unread: 2, approvals: 2, greetings: 3 }),
    ['all', 'unread', 'approvals', 'greetings'],
  );
});
