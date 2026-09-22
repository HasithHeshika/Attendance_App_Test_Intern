import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findDuplicateBill, DUPLICATE_WINDOW_MS,
  type CandidateBill, type ExistingBill,
} from '../billDuplicates';

const NOW = new Date(2026, 8, 10, 12).getTime();   // 10 Sep 2026
const CUTOFF = NOW - DUPLICATE_WINDOW_MS;
const opts = (over: { excludeId?: string } = {}) => ({ cutoffMs: CUTOFF, ...over });

const candidate = (over: Partial<CandidateBill> = {}): CandidateBill => ({
  billHash: 'HASH-NEW', amount: 5000, shop: 'Shell Kollupitiya', vatNumber: '', day: '2026-09-10',
  ...over,
});

const existing = (over: Partial<ExistingBill> & { id: string }): ExistingBill => ({
  billHash: 'HASH-OLD', amount: 5000, shop: 'Shell Kollupitiya', vatNumber: null,
  day: '2026-09-10', status: 'pending', createdMs: NOW - 2 * 24 * 60 * 60 * 1000,
  ...over,
});

// ─── the bug this guard had ───────────────────────────────────────────────────

test('the same shop and amount on a DIFFERENT day is a different purchase', () => {
  // Diesel at the same filling station on Monday and again on Thursday. Two purchases, and
  // the guard used to refuse the second one outright.
  const monday = existing({ id: 'mon', day: '2026-09-07' });
  assert.equal(findDuplicateBill(candidate({ day: '2026-09-10' }), [monday], opts()), null);
});

test('a VAT supplier billed twice in a month is not a duplicate on the strength of the total', () => {
  const earlier = existing({ id: 'e1', shop: 'Abans', vatNumber: '104060517-7000', day: '2026-08-30' });
  const now = candidate({ shop: 'Abans PLC', vatNumber: '104060517-7000', day: '2026-09-10', billHash: '' });
  assert.equal(findDuplicateBill(now, [earlier], opts()), null);
});

test('the same shop, amount AND day is still refused — that is the double upload', () => {
  const hit = findDuplicateBill(candidate({ billHash: '' }), [existing({ id: 'same' })], opts());
  assert.equal(hit?.reason, 'shop');
  assert.equal(hit?.bill.id, 'same');
});

test('the shop name is matched case- and whitespace-insensitively', () => {
  const hit = findDuplicateBill(
    candidate({ billHash: '', shop: '  shell KOLLUPITIYA ' }),
    [existing({ id: 'x', shop: 'Shell Kollupitiya' })],
    opts(),
  );
  assert.equal(hit?.reason, 'shop');
});

test('same day and shop but a different amount is a different bill', () => {
  const other = existing({ id: 'o', amount: 4800 });
  assert.equal(findDuplicateBill(candidate({ billHash: '' }), [other], opts()), null);
});

// ─── the date gate runs ahead of every other signal ───────────────────────────

test('the bill date is checked FIRST — a different date is not a duplicate, not even the same file', () => {
  // The date decides on its own. This is the deliberate trade documented in billDuplicates.ts:
  // re-uploading one image under a changed bill date gets through, because a rule that let the
  // hash overrule the date would go back to refusing honest same-shop purchases.
  const same = existing({ id: 'f', billHash: 'HASH-NEW', day: '2026-08-14' });
  assert.equal(findDuplicateBill(candidate({ day: '2026-09-10' }), [same], opts()), null);
});

test('the same file, same shop, same date is refused whatever amount was typed', () => {
  // The amount is the LAST of the three checks, so a re-send of the same photograph with the
  // figure corrected is still recognised as the bill it is.
  const same = existing({ id: 'f', billHash: 'HASH-NEW', amount: 999 });
  const hit = findDuplicateBill(candidate(), [same], opts());
  assert.equal(hit?.reason, 'file');
  assert.equal(hit?.bill.id, 'f');
});

test('the SHOP is checked first — a different shop is never a duplicate, not even the same file', () => {
  const elsewhere = existing({ id: 'x', billHash: 'HASH-NEW', shop: 'Somewhere else' });
  assert.equal(findDuplicateBill(candidate(), [elsewhere], opts()), null);
});

test('an empty hash never matches a stored bill that has none', () => {
  const noHash = existing({ id: 'n', billHash: null, shop: 'Elsewhere' });
  assert.equal(findDuplicateBill(candidate({ billHash: '', shop: 'Another' }), [noHash], opts()), null);
});

test('within one shop and day, a file match is reported ahead of an amount match', () => {
  const byIdentity = existing({ id: 'ident', billHash: 'HASH-OTHER' });
  const byFile     = existing({ id: 'file', billHash: 'HASH-NEW', amount: 1 });
  const hit = findDuplicateBill(candidate(), [byIdentity, byFile], opts());
  assert.equal(hit?.reason, 'file');
  assert.equal(hit?.bill.id, 'file');
});

test('all three must agree — shop and date alone, with a different amount, is not a duplicate', () => {
  const other = existing({ id: 'o', billHash: 'HASH-OTHER', amount: 4800 });
  assert.equal(findDuplicateBill(candidate({ billHash: '' }), [other], opts()), null);
});

// ─── rows that are out of scope ───────────────────────────────────────────────

test('cancelled, rejected, excluded and stale rows are all out of scope', () => {
  const c = candidate({ billHash: 'HASH-NEW' });
  const cases: ExistingBill[] = [
    existing({ id: 'withdrawn', billHash: 'HASH-NEW', deleted: true }),
    existing({ id: 'rejected',  billHash: 'HASH-NEW', status: 'rejected' }),
    existing({ id: 'editing',   billHash: 'HASH-NEW' }),
    existing({ id: 'stale',     billHash: 'HASH-NEW', createdMs: CUTOFF - 1 }),
  ];
  for (const row of cases) {
    const found = findDuplicateBill(c, [row], opts({ excludeId: 'editing' }));
    assert.equal(found, null, `${row.id} should not count as a duplicate`);
  }
  // …and a live one still does, so the filter above is not just refusing everything.
  assert.equal(findDuplicateBill(c, [existing({ id: 'live', billHash: 'HASH-NEW' })], opts())?.bill.id, 'live');
});

test('a bill filed exactly on the cutoff is still inside the window', () => {
  const edge = existing({ id: 'edge', billHash: 'HASH-NEW', createdMs: CUTOFF });
  assert.equal(findDuplicateBill(candidate(), [edge], opts())?.bill.id, 'edge');
});

// ─── the identity signal needs something to identify ──────────────────────────

test('a blank shop and no VAT number identify nothing', () => {
  // Two bills with no shop typed and no VAT number are not evidence of anything, however
  // exactly their amounts and dates line up.
  const blank = existing({ id: 'b', shop: '   ', vatNumber: null });
  assert.equal(findDuplicateBill(candidate({ billHash: '', shop: '' }), [blank], opts()), null);
});

test('a non-VAT bill does not match on a VAT number it never sent', () => {
  const vatBill = existing({ id: 'v', shop: 'Different Shop', vatNumber: '104060517-7000' });
  // vatNumber is '' because the submitter did not tick VAT — it must not fall through to a match.
  assert.equal(findDuplicateBill(candidate({ billHash: '', shop: 'Another Shop' }), [vatBill], opts()), null);
});

test('a VAT match works when the shop name was typed differently', () => {
  const hit = findDuplicateBill(
    candidate({ billHash: '', shop: 'Abans PLC', vatNumber: '104060517-7000' }),
    [existing({ id: 'v', shop: 'ABANS (Pvt) Ltd', vatNumber: '104060517-7000' })],
    opts(),
  );
  assert.equal(hit?.reason, 'vat');
});

test('rounding: amounts are compared to the cent, not by identity', () => {
  const hit = findDuplicateBill(
    candidate({ billHash: '', amount: 5000.004 }),
    [existing({ id: 'r', amount: 5000 })],
    opts(),
  );
  assert.equal(hit?.reason, 'shop');
});
