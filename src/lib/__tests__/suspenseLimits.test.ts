import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSuspenseLimit, limitHeadroom, checkAgainstLimit, normalizeLimitConfig, countLimitRules, EMPTY_LIMITS,
} from '../suspenseLimits';

const config = {
  company_default: { c1: 50_000, c2: 20_000 },
  by_department:   { 'Operations': 80_000 },
  by_position:     { 'Site Engineer': 100_000 },
  by_role:         { 'Executive': 150_000 },
  by_person:       { 'EMPAV/00001': 250_000 },
};

test('the most specific rule wins: person, then role, position, department, company', () => {
  const base = { epf: 'X', role: 'Executive', designation: 'Site Engineer', department: 'Operations', company_id: 'c1' };
  assert.deepEqual(resolveSuspenseLimit(config, { ...base, epf: 'EMPAV/00001' }), { limit: 250_000, source: 'person', key: 'EMPAV/00001' });
  assert.deepEqual(resolveSuspenseLimit(config, base), { limit: 150_000, source: 'role', key: 'Executive' });
  assert.deepEqual(resolveSuspenseLimit(config, { ...base, role: 'Technician' }), { limit: 100_000, source: 'position', key: 'Site Engineer' });
  assert.deepEqual(resolveSuspenseLimit(config, { ...base, role: 'Technician', designation: 'Driver' }), { limit: 80_000, source: 'department', key: 'Operations' });
  assert.deepEqual(resolveSuspenseLimit(config, { ...base, role: 'Technician', designation: 'Driver', department: 'Finance' }), { limit: 50_000, source: 'company', key: 'c1' });
  assert.deepEqual(resolveSuspenseLimit(config, { epf: 'Y', company_id: 'c9' }), { limit: null, source: null, key: null });
});

test('hand-typed names match trimmed and case-insensitively; EPFs are trimmed', () => {
  assert.equal(resolveSuspenseLimit(config, { epf: ' EMPAV/00001 ' }).limit, 250_000);
  assert.equal(resolveSuspenseLimit(config, { epf: 'Z', role: '  executive ' }).limit, 150_000);
  assert.equal(resolveSuspenseLimit(config, { epf: 'Z', department: 'OPERATIONS' }).limit, 80_000);
});

test('a limit of zero is a real limit; missing and negative values are ignored', () => {
  const c = normalizeLimitConfig({ by_person: { A: 0, B: -5, C: 'oops', D: '1500' }, by_role: null, junk: 1 });
  assert.deepEqual(c.by_person, { A: 0, D: 1500 });
  assert.deepEqual(c.by_role, {});
  assert.equal(resolveSuspenseLimit(c, { epf: 'A' }).limit, 0);
  assert.equal(resolveSuspenseLimit(c, { epf: 'B' }).limit, null);
  assert.equal(countLimitRules(c), 2);
  assert.equal(countLimitRules(EMPTY_LIMITS), 0);
});

test('headroom and the breach check', () => {
  assert.equal(limitHeadroom(null, 1000), null);
  assert.equal(limitHeadroom(50_000, 42_000.5), 7999.5);
  assert.equal(limitHeadroom(50_000, 60_000), -10_000);
  assert.deepEqual(checkAgainstLimit(null, 1e9), { over: false, excess: 0, limit: null });
  assert.deepEqual(checkAgainstLimit(50_000, 50_000), { over: false, excess: 0, limit: 50_000 });
  assert.deepEqual(checkAgainstLimit(50_000, 50_000.004), { over: false, excess: 0, limit: 50_000 });
  assert.deepEqual(checkAgainstLimit(50_000, 50_250), { over: true, excess: 250, limit: 50_000 });
  assert.deepEqual(checkAgainstLimit(0, 1), { over: true, excess: 1, limit: 0 });
});
