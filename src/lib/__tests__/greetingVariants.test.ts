import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BIRTHDAY_LINES, ANNIVERSARY_LINES, FIRST_YEAR_LINES, MILESTONE_LINES, SPECIAL_LINES, greetingBodyVariant, poolFor, variantIndex, type VariantCtx, poolNameFor, variantByName,
} from '../greetingVariants';
import type { Occasion } from '../greetings';
import { greetingCopy, PUSH_BODY_CHARS, type Sender } from '../greetings';

const ctx: VariantCtx = {
  first: 'Deshan', from: 'your supervisor Eve and Ann at PearlCluster',
  brand: 'PearlCluster', years: 4, title: 'Vesak',
};

// The one property the whole feature rests on: the same person, occasion and year must produce
// the same sentence every time. The notification doc, the push and the card are three separate
// writes of the same words, and a random pick would let them disagree.
test('a greeting body is the same every time for the same person and year', () => {
  const a = greetingBodyVariant({ kind: 'birthday' }, ctx, '151', 2026);
  const b = greetingBodyVariant({ kind: 'birthday' }, ctx, '151', 2026);
  assert.equal(a, b);
});

// The repeat a person would actually notice is the one from last year, so the year steps the
// pool by one rather than being hashed into it.
test('consecutive years always step to a different line', () => {
  for (const key of ['151', '2', 'A/17', '']) {
    for (let y = 2024; y < 2032; y++) {
      const now  = greetingBodyVariant({ kind: 'birthday' }, ctx, key, y);
      const next = greetingBodyVariant({ kind: 'birthday' }, ctx, key, y + 1);
      assert.notEqual(now, next, `${key} ${y}`);
    }
  }
});

test('different people on the same day do not all get the same line', () => {
  const lines = new Set(['1', '2', '3', '4', '5', '6', '7', '8']
    .map(epf => greetingBodyVariant({ kind: 'birthday' }, ctx, epf, 2026)));
  assert.ok(lines.size > 1, 'every EPF drew the same line');
});

test('variantIndex stays inside the pool for any input', () => {
  assert.equal(variantIndex('x', 2026, 0), 0);
  for (const y of [0, -5, 2026, 1e6]) {
    const i = variantIndex('epf-151', y, 12);
    assert.ok(i >= 0 && i < 12, String(i));
  }
});

// An anniversary is not one thing: the first year, a five- or ten-year milestone and an ordinary
// year each get their own pool, so none of them reads like a number dropped into a template.
test('anniversaries draw from the pool their length deserves', () => {
  assert.equal(poolFor({ kind: 'anniversary', years: 1 }), FIRST_YEAR_LINES);
  assert.equal(poolFor({ kind: 'anniversary', years: 3 }), ANNIVERSARY_LINES);
  assert.equal(poolFor({ kind: 'anniversary', years: 5 }), MILESTONE_LINES);
  assert.equal(poolFor({ kind: 'anniversary', years: 12 }), MILESTONE_LINES);
  assert.equal(poolFor({ kind: 'birthday' }), BIRTHDAY_LINES);
  assert.equal(poolFor({ kind: 'special', dayId: 'v', title: 'Vesak', message: '' }), SPECIAL_LINES);
});

// Every line names the reader and says who it is from — those two are what stopped it reading
// like a mail merge, so they are asserted rather than trusted.
test('every line names the reader and the senders', () => {
  const pools = [BIRTHDAY_LINES, FIRST_YEAR_LINES, MILESTONE_LINES, ANNIVERSARY_LINES, SPECIAL_LINES];
  for (const pool of pools) {
    for (const line of pool) {
      const out = line(ctx);
      assert.match(out, /Deshan/, out);
      assert.match(out, /PearlCluster/, out);
      assert.ok(out.length <= PUSH_BODY_CHARS, `${out.length}: ${out}`);
    }
  }
});

// ─── How greetingCopy uses them ───────────────────────────────────────────────

const senders: Sender[] = [
  { epf: 'A', name: 'Ann Chief', role: 'CEO', avatar_url: null },
  { epf: 'S', name: 'Eve Super', role: 'Executive', avatar_url: null, supervisor: true },
];

test('the company is named in the body, whoever signed it', () => {
  for (const s of [senders, []]) {
    const b = greetingCopy({ kind: 'birthday' }, 'Deshan Jayasanka', 'PearlCluster', s, { key: '151', year: 2026 });
    assert.match(b.body, /PearlCluster/);
  }
});

test('the seed rotates the body but never the title', () => {
  const a = greetingCopy({ kind: 'birthday' }, 'Deshan Jayasanka', 'PearlCluster', senders, { key: '151', year: 2026 });
  const b = greetingCopy({ kind: 'birthday' }, 'Deshan Jayasanka', 'PearlCluster', senders, { key: '151', year: 2027 });
  assert.equal(a.title, b.title);
  assert.notEqual(a.body, b.body);
});

// A push body that runs long is cut mid-sentence by the OS, so the signer list gives way first.
test('a card signed by a crowd still fits a push body', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    epf: `E${i}`, name: `Person Number ${i}`, role: 'COO', avatar_url: null,
  }));
  for (let y = 2026; y < 2038; y++) {
    const b = greetingCopy({ kind: 'birthday' }, 'Deshan Jayasanka', 'PearlCluster', many, { key: '151', year: y });
    assert.ok(b.body.length <= PUSH_BODY_CHARS, `${b.body.length}: ${b.body}`);
  }
});

// Someone who wrote words outranks every pool line there is.
test('a written message replaces the pool entirely', () => {
  const withNote: Sender[] = [{ ...senders[1], message: 'Enjoy the day, machan.' }, senders[0]];
  const b = greetingCopy({ kind: 'birthday' }, 'Deshan Jayasanka', 'PearlCluster', withNote, { key: '151', year: 2026 });
  assert.equal(b.body, 'Enjoy the day, machan. — Eve Super');
});

// ── The three-language contract ───────────────────────────────────────────────
// The server picks ONE index and stores it; every device renders that index from its own
// reader's pool. That only works while the pools stay the same length in every language, so the
// day someone adds a Sinhala line without an English one, this fails instead of quietly handing
// a Tamil reader somebody else's greeting.

const OCCASIONS: Occasion[] = [
  { kind: 'birthday' },
  { kind: 'anniversary', years: 1 },
  { kind: 'anniversary', years: 3 },
  { kind: 'anniversary', years: 10 },
  { kind: 'special', dayId: 'v', title: 'Vesak', message: '' },
];

test('every language holds the same number of lines for every occasion', () => {
  for (const o of OCCASIONS) {
    const en = poolFor(o, 'en').length;
    assert.ok(en > 0, `${poolNameFor(o)} has no English lines`);
    assert.equal(poolFor(o, 'si').length, en, `${poolNameFor(o)} si length`);
    assert.equal(poolFor(o, 'ta').length, en, `${poolNameFor(o)} ta length`);
  }
});

test('every line in every language is non-empty and leaves no placeholder behind', () => {
  const ctx: VariantCtx = {
    first: 'Nimal', from: 'Ann and Bob at Alta Vision', brand: 'Alta Vision',
    years: 7, title: 'Vesak',
  };
  for (const lang of ['en', 'si', 'ta'] as const) {
    for (const o of OCCASIONS) {
      for (const line of poolFor(o, lang)) {
        const out = line(ctx);
        assert.ok(out.trim().length > 0, `${lang}/${poolNameFor(o)} produced an empty line`);
        // A stray ${...} or {name} would reach the reader verbatim.
        assert.equal(/[{}]/.test(out), false, `${lang}/${poolNameFor(o)}: ${out}`);
        assert.ok(out.includes('Nimal'), `${lang}/${poolNameFor(o)} does not name the reader: ${out}`);
      }
    }
  }
});

test('variantByName reproduces the server-chosen line in each language', () => {
  const ctx: VariantCtx = {
    first: 'Nimal', from: 'Ann at Alta Vision', brand: 'Alta Vision', years: 0, title: '',
  };
  const o: Occasion = { kind: 'birthday' };
  const index = variantIndex('epf-151', 2026, poolFor(o).length);

  // Same index, three languages, three different sentences — all naming the same person.
  const en = variantByName('birthday', index, ctx, 'en');
  const si = variantByName('birthday', index, ctx, 'si');
  const ta = variantByName('birthday', index, ctx, 'ta');
  for (const out of [en, si, ta]) assert.ok(out && out.includes('Nimal'));
  assert.notEqual(en, si);
  assert.notEqual(en, ta);
  // English must match what greetingBodyVariant itself would have written for that seed.
  assert.equal(en, greetingBodyVariant(o, ctx, 'epf-151', 2026));
  // …and the Sinhala one must match the same call asked for Sinhala.
  assert.equal(si, greetingBodyVariant(o, ctx, 'epf-151', 2026, 'si'));
});

test('variantByName is total: an unknown pool or a wild index never throws', () => {
  const ctx: VariantCtx = {
    first: 'Nimal', from: 'Ann at Alta Vision', brand: 'Alta Vision', years: 0, title: '',
  };
  // A pool a newer version of the app knows and this one does not.
  assert.equal(variantByName('carols', 0, ctx, 'en'), null);
  assert.equal(variantByName('birthday', Number.NaN, ctx, 'en'), null);
  // Out of range in both directions wraps rather than reading past the end.
  assert.ok(variantByName('birthday', 9999, ctx, 'ta'));
  assert.ok(variantByName('birthday', -3, ctx, 'si'));
});
