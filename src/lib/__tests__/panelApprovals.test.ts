import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthsBackFor, buildApprovableMap, approvableForSession, toApprovalPayloads,
  PAST_BACKLOG_MAX_MONTHS,
} from '../panelApprovals';
import { calcMorningAllowance, calcEveningAllowance } from '../foodAllowance';

const CALCS = { morning: calcMorningAllowance, evening: calcEveningAllowance };

test('monthsBackFor: whole months between the viewed month and today, never below 1', () => {
  assert.equal(monthsBackFor(2026, 9, '2026-09-05'), 1);   // this month
  assert.equal(monthsBackFor(2026, 8, '2026-09-05'), 1);   // last month
  assert.equal(monthsBackFor(2026, 7, '2026-09-05'), 2);
  assert.equal(monthsBackFor(2025, 12, '2026-09-05'), 9);  // crosses a year
  assert.equal(monthsBackFor(2026, 10, '2026-09-05'), 1);  // a future month still needs the minimum window
  assert.equal(PAST_BACKLOG_MAX_MONTHS, 6);
});

test('foodAllowance: same thresholds the Approvals page uses', () => {
  assert.equal(calcMorningAllowance('2026-09-01 06:30:00'), 1);
  assert.equal(calcMorningAllowance('2026-09-01 06:45:00'), 2);
  assert.equal(calcMorningAllowance('2026-09-01 07:00:00'), 2);
  assert.equal(calcMorningAllowance('2026-09-01 07:01:00'), 0);
  assert.equal(calcMorningAllowance(''), 0);
  assert.equal(calcEveningAllowance('2026-09-01 18:59:00'), 0);
  assert.equal(calcEveningAllowance('2026-09-01 19:00:00'), 1);
  assert.equal(calcEveningAllowance(''), 0);
});

const PAST_ROW = {
  attendance_id: 1000001, epf_number: 'E1', date: '2026-08-12',
  check_in: '2026-08-12 06:30:00', check_out: '2026-08-12 19:30:00',
  working_place: 'Main Yard', site_number: null, is_outstation: false,
  outstation_name: null, outstation_address: null,
  morning_allowance: null, evening_allowance: null, check_in_approved: false, user_type: 'Technician',
};
const LIVE_BOTH = {
  attendance_id: 1000002, epf_number: 'E1', date: '2026-09-05', type: 'both' as const,
  time: '2026-09-05 06:50:00', check_out_time: '2026-09-05 19:10:00',
  working_place: 'Site', site_no: 'GM-1', is_outstation: false, outstation_name: null, outstation_address: null,
};
const LIVE_OUT = {
  attendance_id: 1000003, epf_number: 'E1', date: '2026-09-04', type: 'check_out' as const,
  time: '2026-09-04 18:00:00', check_out_time: '2026-09-04 18:00:00',
  working_place: 'Main Yard', site_no: null, is_outstation: true, outstation_name: 'Galle', outstation_address: 'Galle Rd',
};

test('buildApprovableMap: only the panel employee\'s rows, keyed by date, carrying the queue id', () => {
  const other = { ...PAST_ROW, attendance_id: 1000009, epf_number: 'E2' };
  const m = buildApprovableMap([PAST_ROW, other], [LIVE_BOTH, LIVE_OUT, { ...LIVE_OUT, attendance_id: 1000010, epf_number: 'E2' }], 'E1');
  assert.deepEqual([...m.keys()].sort(), ['2026-08-12', '2026-09-04', '2026-09-05']);
  const past = m.get('2026-08-12')!;
  assert.equal(past.length, 1);
  assert.equal(past[0].kind, 'past');
  assert.equal(past[0].id, 1000001);
  const live = m.get('2026-09-05')!;
  assert.equal(live[0].kind, 'both');
  assert.equal(live[0].id, 1000002);
  assert.equal(m.get('2026-09-04')![0].kind, 'check_out');
  // The same id surfacing twice never yields two entries.
  const dup = buildApprovableMap([PAST_ROW, PAST_ROW], [], 'E1');
  assert.equal(dup.get('2026-08-12')!.length, 1);
  // Numeric vs string epf still matches.
  assert.equal(buildApprovableMap([{ ...PAST_ROW, epf_number: 12 as unknown as string }], [], '12').size, 1);
  assert.equal(buildApprovableMap([PAST_ROW], [LIVE_BOTH], 'E9').size, 0);
});

test('buildApprovableMap: a row without a date falls back to the day of its time', () => {
  const m = buildApprovableMap([{ ...PAST_ROW, date: undefined }], [{ ...LIVE_OUT, date: undefined }], 'E1');
  assert.ok(m.has('2026-08-12'));
  assert.ok(m.has('2026-09-04'));
});

test('approvableForSession: a lone session/entry pair matches outright, otherwise by time at minute precision', () => {
  const m = buildApprovableMap([PAST_ROW], [LIVE_BOTH, LIVE_OUT], 'E1');
  const past = m.get('2026-08-12')!;
  assert.equal(approvableForSession(past, { checkIn: '2026-08-12 06:30:45', checkOut: null }, 1)?.id, 1000001);
  // Two sessions that day → must match on time; the unrelated one gets nothing.
  assert.equal(approvableForSession(past, { checkIn: '2026-08-12 06:30:12', checkOut: null }, 2)?.id, 1000001);
  assert.equal(approvableForSession(past, { checkIn: '2026-08-12 13:00:00', checkOut: null }, 2), null);
  // A checkout-only live entry is anchored on the checkout time.
  const out = m.get('2026-09-04')!;
  assert.equal(approvableForSession(out, { checkIn: '2026-09-04 08:00:00', checkOut: '2026-09-04 18:00:30' }, 2)?.id, 1000003);
  assert.equal(approvableForSession([], { checkIn: '2026-09-04 08:00:00', checkOut: null }, 1), null);
});

test('toApprovalPayloads: past rows mirror makePastEditState + handleApprovePast', () => {
  const m = buildApprovableMap([PAST_ROW], [], 'E1');
  const { past, checkIn, checkOut, skipped } = toApprovalPayloads(m.get('2026-08-12')!, CALCS);
  assert.equal(checkIn.length, 0);
  assert.equal(checkOut.length, 0);
  assert.equal(skipped.length, 0);
  assert.deepEqual(past, [{
    id: 1000001,
    check_in_time: '2026-08-12 06:30:00',
    check_out_time: '2026-08-12 19:30:00',
    working_place: 'Main Yard',
    site_no: '',
    outstation_name: '',
    outstation_address: '',
    is_outstation_approved: false,
    morning_allowance: 1,    // 06:30 → cat 1
    evening_allowance: 1,    // 19:30 → cat 1
  }]);
});

test('toApprovalPayloads: a stored allowance on a past row wins over the auto-calc; ISO times are normalised', () => {
  const m = buildApprovableMap([{ ...PAST_ROW, check_in: '2026-08-12T06:30:00.000', morning_allowance: 0, check_in_approved: true }], [], 'E1');
  const { past } = toApprovalPayloads(m.get('2026-08-12')!, CALCS);
  assert.equal(past[0].check_in_time, '2026-08-12 06:30:00');
  assert.equal(past[0].morning_allowance, 0);
  assert.equal(past[0].evening_allowance, 1);
});

test('toApprovalPayloads: past rows are skipped for the same reasons the Approvals page skips them', () => {
  const rows = [
    { ...PAST_ROW, attendance_id: 1, check_out: null },
    { ...PAST_ROW, attendance_id: 2, check_out: '2026-08-12 06:30:59' },     // same minute as check-in
    { ...PAST_ROW, attendance_id: 3, working_place: null },
    { ...PAST_ROW, attendance_id: 4, working_place: 'Site', site_number: null },
    { ...PAST_ROW, attendance_id: 5, working_place: 'Site', site_number: 'GM-2' },
    { ...PAST_ROW, attendance_id: 6, check_in: null },
  ];
  const m = buildApprovableMap(rows, [], 'E1');
  const { past, skipped } = toApprovalPayloads(m.get('2026-08-12')!, CALCS, { requiresSite: p => p === 'Site' });
  assert.deepEqual(past.map(p => p.id), [5]);
  assert.deepEqual(skipped.map(s => [s.id, s.reason]), [
    [1, 'missing_check_out'], [2, 'zero_length'], [3, 'missing_place'], [4, 'missing_site'], [6, 'missing_check_in'],
  ]);
});

test('toApprovalPayloads: live rows mirror makeEditState + submitByType, "both" going to both calls', () => {
  const m = buildApprovableMap([], [LIVE_BOTH, LIVE_OUT], 'E1');
  const both = toApprovalPayloads(m.get('2026-09-05')!, CALCS);
  assert.deepEqual(both.checkIn, [{ id: 1000002, time: '2026-09-05 06:50:00', morning_allowance: 2 }]);
  assert.deepEqual(both.checkOut, [{
    id: 1000002, time: '2026-09-05 19:10:00', evening_allowance: 1,
    working_place: 'Site', site_no: 'GM-1', is_outstation: false, is_outstation_approved: false,
  }]);
  assert.equal(both.past.length, 0);
  const out = toApprovalPayloads(m.get('2026-09-04')!, CALCS);
  assert.equal(out.checkIn.length, 0);
  assert.deepEqual(out.checkOut, [{
    id: 1000003, time: '2026-09-04 18:00:00', evening_allowance: 0,
    working_place: 'Main Yard', site_no: null, is_outstation: true, is_outstation_approved: true,
  }]);
});

test('toApprovalPayloads: a check-in-only live row, and a live row with no recorded time is skipped (never stamped with now)', () => {
  const m = buildApprovableMap([], [
    { ...LIVE_BOTH, attendance_id: 7, type: 'check_in', check_out_time: null },
    { ...LIVE_BOTH, attendance_id: 8, type: 'check_in', time: null },
    { ...LIVE_OUT,  attendance_id: 9, time: null },
  ], 'E1');
  const r = toApprovalPayloads([...m.get('2026-09-05')!, ...m.get('2026-09-04')!], CALCS);
  assert.deepEqual(r.checkIn, [{ id: 7, time: '2026-09-05 06:50:00', morning_allowance: 2 }]);
  assert.equal(r.checkOut.length, 0);
  assert.deepEqual(r.skipped.map(s => [s.id, s.reason]), [[8, 'missing_check_in'], [9, 'missing_check_out']]);
});

// ── Day trail / month map ───────────────────────────────────────────────────────

import { buildTrail, buildMonthMap, sessionSpan, toMillis } from '../panelApprovals';

const ts = (iso: string) => ({ seconds: Math.floor(Date.parse(iso) / 1000) });   // Firestore-Timestamp-shaped
const fmt = (v: unknown) => { const ms = toMillis(v); if (ms == null) return '—'; const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const LABELS = { checkIn: 'Check-in', checkOut: 'Check-out', update: 'Update', inShort: 'In', outShort: 'Out' };

test('toMillis: Timestamp-like, {seconds}, Date and ISO all resolve; junk is null', () => {
  const ms = Date.parse('2026-09-01T08:15:00');
  assert.equal(toMillis({ toDate: () => new Date(ms) }), ms);
  assert.equal(toMillis({ seconds: ms / 1000 }), ms);
  assert.equal(toMillis(new Date(ms)), ms);
  assert.equal(toMillis('2026-09-01T08:15:00'), ms);
  assert.equal(toMillis(null), null);
  assert.equal(toMillis('nope'), null);
  assert.equal(toMillis(42), null);
});

test('buildTrail: check-in → every located update (any source) in added_at order → check-out, with short labels on the anchors', () => {
  const s = {
    check_in: ts('2026-09-01T08:15:00'), check_out: ts('2026-09-01T17:40:00'),
    check_in_lat: 6.90, check_in_lng: 79.90, check_in_accuracy_m: 12,
    check_out_lat: 6.95, check_out_lng: 79.95, check_out_accuracy_m: 30,
    check_in_site_name: 'Main Yard', working_place: 'Main Yard',
    locations: [
      { name: 'Main Yard', lat: 6.90, lng: 79.90, source: 'check_in', added_at: ts('2026-09-01T08:15:00') },   // = check-in point → not repeated
      { name: 'Site B', lat: 6.93, lng: 79.93, source: 'check_out', added_at: ts('2026-09-01T13:00:00') },   // later, but a different point → an update
      { name: 'Site A', lat: 6.92, lng: 79.92, accuracy_m: 8, source: 'manual', added_at: ts('2026-09-01T10:30:00') },
      { name: 'No GPS', source: 'manual', added_at: ts('2026-09-01T11:00:00') },                              // no coords → dropped
      { name: 'Site C', lat: 6.95, lng: 79.95, source: 'check_out', added_at: ts('2026-09-01T17:40:00') },   // = check-out point → not repeated
    ],
  };
  const trail = buildTrail(s, fmt, LABELS);
  assert.deepEqual(trail.map(p => p.kind), ['checkin', 'update', 'update', 'checkout']);
  assert.deepEqual(trail.map(p => p.name), ['Main Yard', 'Site A', 'Site B', 'Site C']);
  assert.equal(trail[0].label, 'Check-in · 08:15');
  assert.equal(trail[0].short, 'In 08:15');
  assert.equal(trail[0].accuracy, 12);
  assert.equal(trail[1].label, 'Update · 10:30 · Site A');
  assert.equal(trail[1].short, undefined);
  assert.equal(trail[1].accuracy, 8);
  assert.equal(trail[2].label, 'Update · 13:00 · Site B');
  assert.equal(trail[3].label, 'Check-out · 17:40');
  assert.equal(trail[3].short, 'Out 17:40');
  assert.equal(trail[3].time, '17:40');
});

test('buildTrail: no GPS anywhere → empty; an open session has no check-out stop; an old doc with coords only on its location entries still anchors', () => {
  assert.deepEqual(buildTrail({ check_in: ts('2026-09-01T08:00:00'), locations: [{ name: 'X', source: 'manual' }] }, fmt, LABELS), []);
  const open = buildTrail({ check_in: ts('2026-09-01T08:00:00'), check_in_lat: 1, check_in_lng: 2, working_place: 'Yard' }, fmt, LABELS);
  assert.deepEqual(open.map(p => p.kind), ['checkin']);
  assert.equal(open[0].name, 'Yard');
  const legacy = buildTrail({
    check_in: ts('2026-09-01T08:00:00'), check_out: ts('2026-09-01T16:00:00'),
    locations: [
      { name: 'Yard', lat: 1, lng: 2, source: 'check_in', added_at: ts('2026-09-01T08:00:00') },
      { name: 'Yard', lat: 1.1, lng: 2.1, source: 'check_out', added_at: ts('2026-09-01T16:00:00') },
    ],
  }, fmt, LABELS);
  assert.deepEqual(legacy.map(p => [p.kind, p.lat]), [['checkin', 1], ['checkout', 1.1]]);
});

test('sessionSpan: duration, "+1 day" when the check-out is on a later calendar day, open when there is no check-out', () => {
  const a = sessionSpan(ts('2026-09-01T08:15:00'), ts('2026-09-01T17:40:00'));
  assert.deepEqual(a, { inMs: Date.parse('2026-09-01T08:15:00'), outMs: Date.parse('2026-09-01T17:40:00'), minutes: 565, nextDay: false, open: false });
  const b = sessionSpan(ts('2026-09-01T22:00:00'), ts('2026-09-02T06:00:00'));
  assert.equal(b.nextDay, true);
  assert.equal(b.minutes, 480);
  const c = sessionSpan(ts('2026-09-01T22:00:00'), null);
  assert.equal(c.open, true);
  assert.equal(c.outMs, null);
  assert.equal(c.minutes, null);
  assert.equal(sessionSpan(null, null).inMs, null);
});

test('buildMonthMap: one check-in stop and one check-out stop per located session, clickable back to its day; coverage counts; most frequent site wins', () => {
  const days = [
    { date: '2026-09-01', sessions: [{ check_in: ts('2026-09-01T08:00:00'), check_out: ts('2026-09-01T17:00:00'), check_in_lat: 1, check_in_lng: 1, check_out_lat: 1.01, check_out_lng: 1.01, check_in_site_id: 'A' }] },
    { date: '2026-09-02', sessions: [{ check_in: ts('2026-09-02T08:00:00'), check_out: ts('2026-09-02T17:00:00'), check_in_site_id: 'B' }] },   // no GPS
    { date: '2026-09-03', sessions: [
      { check_in: ts('2026-09-03T08:00:00'), check_in_lat: 2, check_in_lng: 2, check_in_site_id: 'A' },                                      // open, check-in only
      { check_in: ts('2026-09-03T13:00:00'), check_out: ts('2026-09-03T18:00:00'), check_out_lat: 2.1, check_out_lng: 2.1, check_in_site_id: 'B' },
    ] },
  ];
  const m = buildMonthMap(days, fmt, d => `${Number(d.slice(8, 10))} Sep`, { inShort: 'In', outShort: 'Out' });
  assert.deepEqual(m.stops.map(s => [s.date, s.kind, s.label]), [
    ['2026-09-01', 'checkin',  '1 Sep · In 08:00'],
    ['2026-09-01', 'checkout', '1 Sep · Out 17:00'],
    ['2026-09-03', 'checkin',  '3 Sep · In 08:00'],
    ['2026-09-03', 'checkout', '3 Sep · Out 18:00'],
  ]);
  assert.equal(m.withGps, 2);
  assert.equal(m.withoutGps, 1);
  assert.equal(m.topSiteId, 'A');
  const empty = buildMonthMap([days[1]], fmt, d => d, { inShort: 'In', outShort: 'Out' });
  assert.equal(empty.stops.length, 0);
  assert.equal(empty.withGps, 0);
  assert.equal(empty.withoutGps, 1);
  assert.equal(empty.topSiteId, 'B');
});
