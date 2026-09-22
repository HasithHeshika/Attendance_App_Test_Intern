import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_PREMIUM, hasPremium, holidayWorkMultiplier, resolvePolicy, type HolidayWorkPolicy,
} from '../holidayWorkPolicy';

// The single most important property here is the tenant gate: this app has no overtime pay,
// and a company that does not pay a premium must never be told it does. That is asserted from
// several angles because it is the one failure with a real-world cost.

const policy = (over: Partial<HolidayWorkPolicy> & Pick<HolidayWorkPolicy, 'id' | 'kind'>): HolidayWorkPolicy => ({
  company_id: 'c1',
  multiplier: 2,
  effective_from: '2020-01-01',
  is_active: true,
  ...over,
});

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);
const TODAY = d(2026, 9, 7);
const ON = { enabled: true, companyId: 'c1' };

test('with the feature off, every kind is 1 no matter what rows exist', () => {
  const p = [policy({ id: 'a', kind: 'rest_day', multiplier: 2 })];
  for (const kind of ['public', 'poya', 'company', 'rest_day', 'leave'] as const) {
    assert.equal(holidayWorkMultiplier(kind, TODAY, p, { enabled: false, companyId: 'c1' }), NO_PREMIUM);
  }
});

test('the gate is closed by DEFAULT, not merely when explicitly disabled', () => {
  // A caller that forgets to pass the tenant flag must get "no premium", never a live rate.
  const p = [policy({ id: 'a', kind: 'rest_day', multiplier: 2 })];
  assert.equal(holidayWorkMultiplier('rest_day', TODAY, p), NO_PREMIUM);
  assert.equal(holidayWorkMultiplier('rest_day', TODAY, p, { companyId: 'c1' }), NO_PREMIUM);
});

test('the gate also blocks the payroll fallback, not just policy rows', () => {
  const rates = { ph_day_multiplier: 2, poya_day_multiplier: 3 };
  assert.equal(holidayWorkMultiplier('public', TODAY, [], { enabled: false, payrollRates: rates }), NO_PREMIUM);
});

test('with the feature on, a policy row supplies the multiplier', () => {
  const p = [policy({ id: 'a', kind: 'rest_day', multiplier: 1.5 })];
  assert.equal(holidayWorkMultiplier('rest_day', TODAY, p, ON), 1.5);
});

test('with nothing configured at all, the answer is 1 rather than a guess', () => {
  assert.equal(holidayWorkMultiplier('leave', TODAY, [], ON), NO_PREMIUM);
});

test('public and poya fall back to the EXISTING payroll settings, not a duplicate model', () => {
  // The spec forbids a parallel model: PayrollSettings already owns these two.
  const rates = { ph_day_multiplier: 2, poya_day_multiplier: 3 };
  assert.equal(holidayWorkMultiplier('public', TODAY, [], { ...ON, payrollRates: rates }), 2);
  assert.equal(holidayWorkMultiplier('poya', TODAY, [], { ...ON, payrollRates: rates }), 3);
  // Kinds payroll has never heard of get no such fallback.
  assert.equal(holidayWorkMultiplier('rest_day', TODAY, [], { ...ON, payrollRates: rates }), NO_PREMIUM);
});

test('a policy row overrides the payroll fallback', () => {
  const p = [policy({ id: 'a', kind: 'public', multiplier: 1.5 })];
  const rates = { ph_day_multiplier: 2 };
  assert.equal(holidayWorkMultiplier('public', TODAY, p, { ...ON, payrollRates: rates }), 1.5);
});

test('an unconfigured payroll rate reads as null and falls through to 1', () => {
  // getOrCreatePayrollSettings seeds defaults ONLY for a brand-new doc, so a field added later
  // reads back null or undefined on an existing one. Neither may become a rate.
  assert.equal(holidayWorkMultiplier('public', TODAY, [], { ...ON, payrollRates: { ph_day_multiplier: null } }), NO_PREMIUM);
  assert.equal(holidayWorkMultiplier('public', TODAY, [], { ...ON, payrollRates: {} }), NO_PREMIUM);
});

test('a multiplier below 1 is refused — configuration must not be able to cut pay', () => {
  const p = [policy({ id: 'a', kind: 'rest_day', multiplier: 0.5 })];
  assert.equal(holidayWorkMultiplier('rest_day', TODAY, p, ON), NO_PREMIUM);
});

test('a non-finite multiplier is refused', () => {
  const p = [policy({ id: 'a', kind: 'rest_day', multiplier: Number.NaN })];
  assert.equal(holidayWorkMultiplier('rest_day', TODAY, p, ON), NO_PREMIUM);
});

test('a future-dated policy does not apply yet', () => {
  const p = [
    policy({ id: 'now', kind: 'rest_day', multiplier: 1.5, effective_from: '2020-01-01' }),
    policy({ id: 'later', kind: 'rest_day', multiplier: 2, effective_from: '2027-01-01' }),
  ];
  assert.equal(holidayWorkMultiplier('rest_day', TODAY, p, ON), 1.5);
});

test('history keeps its own rate when a newer policy exists', () => {
  const p = [
    policy({ id: 'old', kind: 'rest_day', multiplier: 1.5, effective_from: '2020-01-01' }),
    policy({ id: 'new', kind: 'rest_day', multiplier: 2, effective_from: '2026-06-01' }),
  ];
  assert.equal(holidayWorkMultiplier('rest_day', TODAY, p, ON), 2);
  assert.equal(holidayWorkMultiplier('rest_day', d(2026, 3, 1), p, ON), 1.5);
});

test('an inactive policy never applies', () => {
  const p = [policy({ id: 'a', kind: 'rest_day', multiplier: 2, is_active: false })];
  assert.equal(holidayWorkMultiplier('rest_day', TODAY, p, ON), NO_PREMIUM);
});

test('a policy for another company does not leak across', () => {
  const p = [policy({ id: 'a', kind: 'rest_day', multiplier: 2, company_id: 'c2' })];
  assert.equal(holidayWorkMultiplier('rest_day', TODAY, p, ON), NO_PREMIUM);
});

test('kinds do not bleed into one another', () => {
  const p = [policy({ id: 'a', kind: 'leave', multiplier: 2 })];
  assert.equal(holidayWorkMultiplier('rest_day', TODAY, p, ON), NO_PREMIUM);
  assert.equal(holidayWorkMultiplier('leave', TODAY, p, ON), 2);
});

test('two policies sharing an effective_from resolve the same way every time', () => {
  const p = [
    policy({ id: 'aaa', kind: 'rest_day', multiplier: 1.5, effective_from: '2026-01-01' }),
    policy({ id: 'zzz', kind: 'rest_day', multiplier: 2, effective_from: '2026-01-01' }),
  ];
  assert.equal(
    holidayWorkMultiplier('rest_day', TODAY, p, ON),
    holidayWorkMultiplier('rest_day', TODAY, [...p].reverse(), ON),
  );
});

test('resolvePolicy returns null when nothing matches', () => {
  assert.equal(resolvePolicy('rest_day', TODAY, [], 'c1'), null);
});

test('hasPremium is false at exactly 1 — the ordinary case needs no badge', () => {
  assert.equal(hasPremium(NO_PREMIUM), false);
  assert.equal(hasPremium(1.5), true);
  assert.equal(hasPremium(Number.NaN), false);
});
