import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aiCostUsd,
  spendPct,
  isUnderBudget,
  warnThresholds,
  pendingWarnThreshold,
  utcMonthKey,
  budgetOf,
  DEFAULT_MONTHLY_LIMIT_USD,
  DEFAULT_WARN_PCT,
  type AiPricing,
} from '../aiUsageBudget';

// A round $1 / $10 per million tokens, so every expected cost below is readable by eye rather
// than being a restatement of whatever the real default happens to be.
const P: AiPricing = { inputPerMTok: 1, outputPerMTok: 10 };

test('aiCostUsd: prices input and output per MILLION tokens, separately', () => {
  assert.equal(aiCostUsd(1_000_000, 0, P), 1);
  assert.equal(aiCostUsd(0, 1_000_000, P), 10);
  assert.equal(aiCostUsd(1_000_000, 1_000_000, P), 11);
  assert.equal(aiCostUsd(0, 0, P), 0);
});

test('aiCostUsd: a single bill read costs a fraction of a cent, and is not rounded away', () => {
  const cost = aiCostUsd(1500, 200, P);   // ~a resized bill photo plus a short JSON answer
  assert.equal(cost, 0.0015 + 0.002);
  assert.ok(cost > 0, 'a real call must never accumulate as zero spend');
});

test('aiCostUsd: junk token counts cost nothing rather than NaN', () => {
  assert.equal(aiCostUsd(-500, -500, P), 0);
  assert.equal(aiCostUsd(NaN, NaN, P), 0);
});

test('spendPct: percent of the limit used', () => {
  assert.equal(spendPct(0, 50), 0);
  assert.equal(spendPct(25, 50), 50);
  assert.equal(spendPct(40, 50), 80);
  assert.equal(spendPct(50, 50), 100);
  assert.equal(spendPct(75, 50), 150);
});

test('spendPct: a zero or missing limit is fully used, not a divide-by-zero', () => {
  assert.equal(spendPct(0, 0), 100);
  assert.equal(spendPct(0, -1), 100);
});

test('isUnderBudget: the boundary is exactly AT the limit', () => {
  assert.equal(isUnderBudget(49.99, 50), true);
  assert.equal(isUnderBudget(50, 50), false, 'spending exactly the limit must block the next call');
  assert.equal(isUnderBudget(50.01, 50), false);
});

test('isUnderBudget: a zero limit blocks everything', () => {
  assert.equal(isUnderBudget(0, 0), false);
});

test('warnThresholds: warns at the configured percent and again at the cap', () => {
  assert.deepEqual(warnThresholds(80), [80, 100]);
  // Configuring the warning at 100 must not warn twice at the same point.
  assert.deepEqual(warnThresholds(100), [100]);
});

test('pendingWarnThreshold: fires when crossing, then not again', () => {
  assert.equal(pendingWarnThreshold(79.9, 80, 0), null, 'below the threshold: silent');
  assert.equal(pendingWarnThreshold(80, 80, 0), 80, 'crossing it: warn');
  assert.equal(pendingWarnThreshold(85, 80, 80), null, 'already warned at 80: silent');
  assert.equal(pendingWarnThreshold(99.9, 80, 80), null);
});

test('pendingWarnThreshold: the cap is a second, separate warning', () => {
  assert.equal(pendingWarnThreshold(100, 80, 80), 100, 'reaching the cap warns again');
  assert.equal(pendingWarnThreshold(140, 80, 100), null, 'already warned at the cap: silent');
});

test('pendingWarnThreshold: a month that blows past both at once warns only at the cap', () => {
  assert.equal(pendingWarnThreshold(120, 80, 0), 100);
});

test('utcMonthKey: UTC month, zero-padded', () => {
  assert.equal(utcMonthKey(new Date('2026-08-31T12:00:00Z')), '2026-08');
  assert.equal(utcMonthKey(new Date('2026-12-01T00:00:00Z')), '2026-12');
  // The last instant of a UTC month still belongs to that month, whatever the server's zone.
  assert.equal(utcMonthKey(new Date('2026-08-31T23:59:59Z')), '2026-08');
  assert.equal(utcMonthKey(new Date('2026-09-01T00:00:00Z')), '2026-09');
});

test('budgetOf: reports remaining spend and blocks at the limit', () => {
  const under = budgetOf(40, 50, true);
  assert.equal(under.pct, 80);
  assert.equal(under.remainingUsd, 10);
  assert.equal(under.allowed, true);

  const at = budgetOf(50, 50, true);
  assert.equal(at.remainingUsd, 0);
  assert.equal(at.allowed, false);

  const over = budgetOf(60, 50, true);
  assert.equal(over.remainingUsd, 0, 'remaining never goes negative');
  assert.equal(over.allowed, false);
});

test('budgetOf: not tracking means fail-open, and says so', () => {
  const b = budgetOf(0, 50, false);
  assert.equal(b.tracking, false);
  assert.equal(b.allowed, true, 'an unconfigured Admin SDK must not block bill reading');
});

test('defaults match the $50/month limit set on the Google billing account', () => {
  assert.equal(DEFAULT_MONTHLY_LIMIT_USD, 50);
  assert.ok(DEFAULT_WARN_PCT > 0 && DEFAULT_WARN_PCT < 100, 'the warning must land before the cap');
});
