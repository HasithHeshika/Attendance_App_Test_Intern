import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMaintenanceDoc,
  deriveMaintenancePhase,
  formatCountdown,
  isUrgentCountdown,
  msToDatetimeLocalValue,
  datetimeLocalValueToMs,
  presetTonight,
  presetNowToSixAM,
  presetNowPlusHours,
  defaultMaintenanceWindow,
  extendEndAtMs,
  autoMaintenanceMessage,
  type MaintenanceDoc,
} from '../maintenance';

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function baseDoc(overrides: Partial<MaintenanceDoc> = {}): MaintenanceDoc {
  return {
    enabled: true,
    startAtMs: 1000,
    endAtMs: 2000,
    message: 'msg',
    mode: 'block',
    kind: 'maintenance',
    createdBy: 'epf1',
    createdByName: 'Admin',
    ...overrides,
  };
}

// ─── parseMaintenanceDoc: malformed docs must never lock clients out ──────────────

test('parseMaintenanceDoc: valid doc parses through unchanged', () => {
  const parsed = parseMaintenanceDoc(baseDoc());
  assert.deepEqual(parsed, baseDoc());
});

test('parseMaintenanceDoc: null/undefined/non-object -> null', () => {
  assert.equal(parseMaintenanceDoc(null), null);
  assert.equal(parseMaintenanceDoc(undefined), null);
  assert.equal(parseMaintenanceDoc('nope'), null);
  assert.equal(parseMaintenanceDoc(42), null);
});

test('parseMaintenanceDoc: missing/non-boolean enabled -> null', () => {
  assert.equal(parseMaintenanceDoc({ ...baseDoc(), enabled: undefined }), null);
  assert.equal(parseMaintenanceDoc({ ...baseDoc(), enabled: 'true' }), null);
});

test('parseMaintenanceDoc: missing or non-numeric startAtMs/endAtMs -> null', () => {
  assert.equal(parseMaintenanceDoc({ ...baseDoc(), startAtMs: undefined }), null);
  assert.equal(parseMaintenanceDoc({ ...baseDoc(), endAtMs: undefined }), null);
  assert.equal(parseMaintenanceDoc({ ...baseDoc(), startAtMs: '1000' }), null);
  assert.equal(parseMaintenanceDoc({ ...baseDoc(), endAtMs: NaN }), null);
  assert.equal(parseMaintenanceDoc({ ...baseDoc(), endAtMs: Infinity }), null);
});

test('parseMaintenanceDoc: endAtMs <= startAtMs -> null', () => {
  assert.equal(parseMaintenanceDoc({ ...baseDoc(), startAtMs: 2000, endAtMs: 2000 }), null); // equal
  assert.equal(parseMaintenanceDoc({ ...baseDoc(), startAtMs: 2000, endAtMs: 1000 }), null); // reversed
});

test('parseMaintenanceDoc: bad mode/kind enum -> null', () => {
  assert.equal(parseMaintenanceDoc({ ...baseDoc(), mode: 'yolo' }), null);
  assert.equal(parseMaintenanceDoc({ ...baseDoc(), kind: 'yolo' }), null);
  assert.equal(parseMaintenanceDoc({ ...baseDoc(), mode: undefined }), null);
});

test('parseMaintenanceDoc: missing display-only fields default to empty string, doc still parses', () => {
  const raw = { enabled: true, startAtMs: 1000, endAtMs: 2000, mode: 'readonly', kind: 'upgrade' };
  const parsed = parseMaintenanceDoc(raw);
  assert.ok(parsed);
  assert.equal(parsed?.message, '');
  assert.equal(parsed?.createdBy, '');
  assert.equal(parsed?.createdByName, '');
});

// ─── deriveMaintenancePhase: start inclusive, end exclusive ───────────────────────

test('deriveMaintenancePhase: null doc -> off', () => {
  assert.equal(deriveMaintenancePhase(null, 1500), 'off');
});

test('deriveMaintenancePhase: enabled:false -> off regardless of window', () => {
  assert.equal(deriveMaintenancePhase(baseDoc({ enabled: false }), 1500), 'off');
});

test('deriveMaintenancePhase: before start -> scheduled', () => {
  assert.equal(deriveMaintenancePhase(baseDoc(), 999), 'scheduled');
});

test('deriveMaintenancePhase: exactly at start -> active (start inclusive)', () => {
  assert.equal(deriveMaintenancePhase(baseDoc(), 1000), 'active');
});

test('deriveMaintenancePhase: mid-window -> active', () => {
  assert.equal(deriveMaintenancePhase(baseDoc(), 1500), 'active');
});

test('deriveMaintenancePhase: exactly at end -> ended (end exclusive)', () => {
  assert.equal(deriveMaintenancePhase(baseDoc(), 2000), 'ended');
});

test('deriveMaintenancePhase: after end -> ended', () => {
  assert.equal(deriveMaintenancePhase(baseDoc(), 5000), 'ended');
});

// ─── formatCountdown ────────────────────────────────────────────────────────────

test('formatCountdown: seconds only', () => {
  assert.equal(formatCountdown(45 * 1000), '45s');
});

test('formatCountdown: minutes + seconds', () => {
  assert.equal(formatCountdown(65 * 1000), '1m 5s');
});

test('formatCountdown: hours + minutes + seconds', () => {
  assert.equal(formatCountdown(HOUR + 61 * 1000), '1h 1m 1s');
});

test('formatCountdown: zero and negative both clamp to 0s', () => {
  assert.equal(formatCountdown(0), '0s');
  assert.equal(formatCountdown(-5000), '0s');
});

test('isUrgentCountdown: threshold at exactly 10 minutes is urgent, just above is not', () => {
  assert.equal(isUrgentCountdown(10 * MIN), true);
  assert.equal(isUrgentCountdown(10 * MIN + 1), false);
  assert.equal(isUrgentCountdown(0), true);
});

// ─── datetime-local round trip ──────────────────────────────────────────────────

test('datetime-local round trip: minute-aligned ms survives the round trip', () => {
  const original = new Date(2026, 5, 15, 20, 30, 0, 0).getTime(); // local time, seconds=0
  const value = msToDatetimeLocalValue(original);
  assert.equal(value, '2026-06-15T20:30');
  const back = datetimeLocalValueToMs(value);
  assert.equal(back, original);
});

test('datetime-local round trip: pads single-digit month/day/hour/minute', () => {
  const original = new Date(2026, 0, 5, 6, 5, 0, 0).getTime();
  assert.equal(msToDatetimeLocalValue(original), '2026-01-05T06:05');
});

test('datetimeLocalValueToMs: malformed string -> null', () => {
  assert.equal(datetimeLocalValueToMs('not-a-date'), null);
  assert.equal(datetimeLocalValueToMs(''), null);
});

// ─── presets ────────────────────────────────────────────────────────────────────

test('presetNowPlusHours: start is now, end is now+N hours', () => {
  const now = Date.now();
  const w = presetNowPlusHours(now, 2);
  assert.equal(w.startAtMs, now);
  assert.equal(w.endAtMs, now + 2 * HOUR);
});

test('defaultMaintenanceWindow: is Now +1h', () => {
  const now = Date.now();
  assert.deepEqual(defaultMaintenanceWindow(now), presetNowPlusHours(now, 1));
});

test('presetTonight: before 20:00 today -> starts 20:00 today, ends 06:00 next day', () => {
  const now = new Date(2026, 5, 15, 14, 0, 0, 0).getTime(); // 2pm
  const w = presetTonight(now);
  const start = new Date(w.startAtMs);
  const end = new Date(w.endAtMs);
  assert.equal(start.getHours(), 20);
  assert.equal(start.getDate(), 15);
  assert.equal(end.getHours(), 6);
  assert.equal(end.getDate(), 16);
  assert.ok(w.endAtMs > w.startAtMs);
});

test('presetTonight: after 20:00 today -> rolls to tomorrow night', () => {
  const now = new Date(2026, 5, 15, 21, 0, 0, 0).getTime(); // 9pm, past tonight's 20:00
  const w = presetTonight(now);
  const start = new Date(w.startAtMs);
  assert.equal(start.getDate(), 16); // rolled to next day
  assert.equal(start.getHours(), 20);
});

test('presetNowToSixAM: before 06:00 -> ends today at 06:00', () => {
  const now = new Date(2026, 5, 15, 2, 0, 0, 0).getTime(); // 2am
  const w = presetNowToSixAM(now);
  assert.equal(w.startAtMs, now);
  const end = new Date(w.endAtMs);
  assert.equal(end.getDate(), 15);
  assert.equal(end.getHours(), 6);
});

test('presetNowToSixAM: after 06:00 -> rolls to tomorrow 06:00', () => {
  const now = new Date(2026, 5, 15, 10, 0, 0, 0).getTime(); // 10am
  const w = presetNowToSixAM(now);
  const end = new Date(w.endAtMs);
  assert.equal(end.getDate(), 16);
  assert.equal(end.getHours(), 6);
});

test('extendEndAtMs: adds minutes to the current end', () => {
  assert.equal(extendEndAtMs(1000, 30), 1000 + 30 * MIN);
  assert.equal(extendEndAtMs(0, 12 * 60), 12 * HOUR);
});

// ─── auto-message per kind ──────────────────────────────────────────────────────

test('autoMaintenanceMessage: differs per kind and mentions the window', () => {
  const start = new Date(2026, 5, 15, 20, 0).getTime();
  const end = new Date(2026, 5, 16, 6, 0).getTime();
  const maintenance = autoMaintenanceMessage('maintenance', start, end);
  const upgrade = autoMaintenanceMessage('upgrade', start, end);
  const emergency = autoMaintenanceMessage('emergency', start, end);

  assert.notEqual(maintenance, upgrade);
  assert.notEqual(upgrade, emergency);
  assert.notEqual(maintenance, emergency);
  assert.match(maintenance, /maintenance/i);
  assert.match(upgrade, /upgrad/i);
  assert.match(emergency, /emergency/i);
});
