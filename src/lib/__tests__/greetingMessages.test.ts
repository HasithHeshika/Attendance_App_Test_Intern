import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  subordinateEpfsOf, canAuthor, allowedAudiencesFor, targetablePeopleOf, messagesFor,
  renderMessage, mergeSenders, reachOf, isGreetingAudience,
  slotsFor, normalizeMessages, wordingsFor,
  type GreetingMessage,
} from '../greetingMessages';
import type { Occasion, PersonLite, RoleLite, Sender } from '../greetings';

const ROLES: RoleLite[] = [
  { id: 'ceo', name: 'CEO', category: 'top_management', parent_id: null, is_employee: true },
  { id: 'coo', name: 'COO', category: 'top_management', parent_id: 'ceo', is_employee: true },
  { id: 'exec', name: 'Executive', category: 'executive', parent_id: 'coo', is_employee: true },
  { id: 'tech', name: 'Technician', category: 'technician', parent_id: 'exec', is_employee: true },
  // Not an employee role, and a tree root — the pair that would wrongly read as top management.
  { id: 'sysadmin', name: 'System Admin', category: 'top_management', parent_id: null, is_employee: false },
];

const person = (o: Partial<PersonLite> & { epf_number: string }): PersonLite => ({
  display_name: null, first_name: null, last_name: null, role: 'Technician', company_id: 'c1',
  supervisor_epf: null, is_active: true, date_of_resign: null, date_of_birth: null,
  date_of_join: null, avatar_url: null, ...o,
});

const CEO   = person({ epf_number: 'E1', display_name: 'Ann Chief', role: 'CEO' });
const COO   = person({ epf_number: 'E2', display_name: 'Bob Ops', role: 'COO', supervisor_epf: 'E1' });
const EXEC  = person({ epf_number: 'E3', display_name: 'Eve Super', role: 'Executive', supervisor_epf: 'E2' });
const TECH  = person({ epf_number: 'E4', display_name: 'Deshan Jayasanka', first_name: 'Deshan', supervisor_epf: 'E3' });
const TECH2 = person({ epf_number: 'E5', display_name: 'Nimal Silva', supervisor_epf: 'E3' });
const ADMIN = person({ epf_number: 'E9', display_name: 'Sys Admin', role: 'System Admin' });
const PEOPLE = [CEO, COO, EXEC, TECH, TECH2, ADMIN];

const msg = (o: Partial<GreetingMessage> & { id: string; author_epf: string }): GreetingMessage => ({
  author_name: o.author_epf, author_role: '', author_avatar_url: null,
  audience: 'everyone', target_epf: null, occasions: ['birthday'], special_day_ids: [],
  message: 'Words', enabled: true, ...o,
});

const BIRTHDAY: Occasion = { kind: 'birthday' };
const ANNIVERSARY: Occasion = { kind: 'anniversary', years: 5 };
const XMAS: Occasion = { kind: 'special', dayId: 'xmas', title: 'Christmas', message: '' };
const NEWYEAR: Occasion = { kind: 'special', dayId: 'newyear', title: 'New Year', message: '' };

// ─── subordinateEpfsOf ────────────────────────────────────────────────────────

test('subordinateEpfsOf: direct reports, two levels down, and nobody', () => {
  assert.deepEqual([...subordinateEpfsOf('E3', PEOPLE)].sort(), ['E4', 'E5']);
  assert.deepEqual([...subordinateEpfsOf('E2', PEOPLE)].sort(), ['E3', 'E4', 'E5']);
  assert.deepEqual([...subordinateEpfsOf('E1', PEOPLE)].sort(), ['E2', 'E3', 'E4', 'E5']);
  assert.equal(subordinateEpfsOf('E4', PEOPLE).size, 0);
  assert.equal(subordinateEpfsOf('', PEOPLE).size, 0);
});

test('subordinateEpfsOf: a supervisor cycle terminates and never contains the root', () => {
  const cyclic = [
    person({ epf_number: 'A', supervisor_epf: 'B' }),
    person({ epf_number: 'B', supervisor_epf: 'A' }),
    person({ epf_number: 'C', supervisor_epf: 'B' }),
  ];
  const fromA = subordinateEpfsOf('A', cyclic);
  assert.deepEqual([...fromA].sort(), ['B', 'C']);
  assert.equal(fromA.has('A'), false);
  // Someone who reports to themselves is not their own subordinate either.
  assert.equal(subordinateEpfsOf('S', [person({ epf_number: 'S', supervisor_epf: 'S' })]).size, 0);
});

// ─── canAuthor / allowedAudiencesFor ──────────────────────────────────────────

test('canAuthor everyone: top management employees only, plus a system admin by capability', () => {
  assert.equal(canAuthor(CEO, 'everyone', null, PEOPLE, ROLES), true);
  assert.equal(canAuthor(COO, 'everyone', null, PEOPLE, ROLES), true);
  assert.equal(canAuthor(EXEC, 'everyone', null, PEOPLE, ROLES), false);
  assert.equal(canAuthor(TECH, 'everyone', null, PEOPLE, ROLES), false);
  // A System Admin role is top_management but NOT an employee role, so the role alone is not
  // enough; the capability is what lets them through.
  assert.equal(canAuthor(ADMIN, 'everyone', null, PEOPLE, ROLES), false);
  assert.equal(canAuthor(ADMIN, 'everyone', null, PEOPLE, ROLES, { systemAdmin: true }), true);
  assert.equal(canAuthor(null, 'everyone', null, PEOPLE, ROLES, { systemAdmin: true }), false);
});

test('canAuthor my_team: needs at least one person underneath, whatever the rank', () => {
  assert.equal(canAuthor(EXEC, 'my_team', null, PEOPLE, ROLES), true);
  assert.equal(canAuthor(TECH, 'my_team', null, PEOPLE, ROLES), false);
  // A system admin with nobody reporting to them has no team to write to.
  assert.equal(canAuthor(ADMIN, 'my_team', null, PEOPLE, ROLES, { systemAdmin: true }), false);
});

test('canAuthor person: the closure, or anyone at all for an everyone-capable author', () => {
  assert.equal(canAuthor(EXEC, 'person', 'E4', PEOPLE, ROLES), true);
  assert.equal(canAuthor(COO, 'person', 'E4', PEOPLE, ROLES), true);   // two levels up
  assert.equal(canAuthor(EXEC, 'person', 'E1', PEOPLE, ROLES), false); // upward is not allowed
  assert.equal(canAuthor(TECH, 'person', 'E5', PEOPLE, ROLES), false); // a peer is not a report
  assert.equal(canAuthor(CEO, 'person', 'E4', PEOPLE, ROLES), true);
  assert.equal(canAuthor(EXEC, 'person', '', PEOPLE, ROLES), false);
  // Nobody writes their own card, including the people who can write for everyone.
  assert.equal(canAuthor(EXEC, 'person', 'E3', PEOPLE, ROLES), false);
  assert.equal(canAuthor(CEO, 'person', 'E1', PEOPLE, ROLES), false);
});

test('allowedAudiencesFor: ordered, and empty for someone with no reports and no rank', () => {
  assert.deepEqual(allowedAudiencesFor(CEO, PEOPLE, ROLES), ['everyone', 'my_team', 'person']);
  assert.deepEqual(allowedAudiencesFor(EXEC, PEOPLE, ROLES), ['my_team', 'person']);
  assert.deepEqual(allowedAudiencesFor(TECH, PEOPLE, ROLES), []);
  assert.deepEqual(allowedAudiencesFor(ADMIN, PEOPLE, ROLES, { systemAdmin: true }), ['everyone', 'person']);
});

test('targetablePeopleOf: the closure, or everyone but yourself', () => {
  assert.deepEqual(targetablePeopleOf(EXEC, PEOPLE, ROLES).map(p => p.epf_number), ['E4', 'E5']);
  assert.deepEqual(targetablePeopleOf(CEO, PEOPLE, ROLES).map(p => p.epf_number), ['E2', 'E3', 'E4', 'E5', 'E9']);
  assert.deepEqual(targetablePeopleOf(TECH, PEOPLE, ROLES).map(p => p.epf_number), []);
  // An inactive person is never offered, even inside the closure.
  const withResigned = [...PEOPLE, person({ epf_number: 'E6', supervisor_epf: 'E3', is_active: false })];
  assert.deepEqual(targetablePeopleOf(EXEC, withResigned, ROLES).map(p => p.epf_number), ['E4', 'E5']);
});

// ─── messagesFor ──────────────────────────────────────────────────────────────

test('messagesFor: audience coverage, roots first', () => {
  const messages = [
    msg({ id: 'm1', author_epf: 'E1', audience: 'everyone' }),
    msg({ id: 'm2', author_epf: 'E3', audience: 'my_team' }),
    msg({ id: 'm3', author_epf: 'E2', audience: 'my_team' }),
  ];
  // E4 is under E3, which is under E2, so all three cover them — ordered by role depth.
  assert.deepEqual(messagesFor(TECH, BIRTHDAY, messages, PEOPLE, ROLES).map(m => m.id), ['m1', 'm3', 'm2']);
  // E2 is not under E3, so E3's team note does not reach them.
  assert.deepEqual(messagesFor(COO, BIRTHDAY, messages, PEOPLE, ROLES).map(m => m.id), ['m1']);
});

test('messagesFor: one per author and the most specific audience wins', () => {
  const messages = [
    msg({ id: 'team', author_epf: 'E3', audience: 'my_team', message: 'Team words' }),
    msg({ id: 'mine', author_epf: 'E3', audience: 'person', target_epf: 'E4', message: 'Your words' }),
  ];
  const out = messagesFor(TECH, BIRTHDAY, messages, PEOPLE, ROLES);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'mine');
  // …and the team note is still what the OTHER report gets.
  assert.deepEqual(messagesFor(TECH2, BIRTHDAY, messages, PEOPLE, ROLES).map(m => m.id), ['team']);
});

test('messagesFor: a person message only reaches its target', () => {
  const messages = [msg({ id: 'p', author_epf: 'E3', audience: 'person', target_epf: 'E4' })];
  assert.deepEqual(messagesFor(TECH, BIRTHDAY, messages, PEOPLE, ROLES).map(m => m.id), ['p']);
  assert.deepEqual(messagesFor(TECH2, BIRTHDAY, messages, PEOPLE, ROLES), []);
});

test('messagesFor: the occasion filter, the special-day filter, and disabled rows', () => {
  const messages = [
    msg({ id: 'bday', author_epf: 'E1', occasions: ['birthday'] }),
    msg({ id: 'anniv', author_epf: 'E2', occasions: ['anniversary'] }),
    msg({ id: 'anyday', author_epf: 'E3', audience: 'my_team', occasions: ['special'], special_day_ids: [] }),
    msg({ id: 'xmasonly', author_epf: 'E5', occasions: ['special'], special_day_ids: ['xmas'] }),
    msg({ id: 'off', author_epf: 'E9', occasions: ['birthday'], enabled: false }),
  ];
  assert.deepEqual(messagesFor(TECH, BIRTHDAY, messages, PEOPLE, ROLES).map(m => m.id), ['bday']);
  assert.deepEqual(messagesFor(TECH, ANNIVERSARY, messages, PEOPLE, ROLES).map(m => m.id), ['anniv']);
  // An empty special_day_ids means every special day; a named one only its own.
  assert.deepEqual(messagesFor(TECH, XMAS, messages, PEOPLE, ROLES).map(m => m.id).sort(), ['anyday', 'xmasonly']);
  assert.deepEqual(messagesFor(TECH, NEWYEAR, messages, PEOPLE, ROLES).map(m => m.id), ['anyday']);
});

test('messagesFor: nobody signs their own card', () => {
  const messages = [msg({ id: 'self', author_epf: 'E4', audience: 'everyone' })];
  assert.deepEqual(messagesFor(TECH, BIRTHDAY, messages, PEOPLE, ROLES), []);
  assert.deepEqual(messagesFor(TECH2, BIRTHDAY, messages, PEOPLE, ROLES).map(m => m.id), ['self']);
});

// ─── renderMessage ────────────────────────────────────────────────────────────

test('renderMessage: fills {name}, {first_name} and {years}', () => {
  const m = msg({ id: 'm', author_epf: 'E3', message: '  {first_name}, {years} years with us, {name}!  ' });
  assert.equal(renderMessage(m, TECH, ANNIVERSARY), 'Deshan, 5 years with us, Deshan Jayasanka!');
  // {years} has no value outside an anniversary, and is emptied rather than left as a token.
  // The author's own spacing around it is left exactly as they typed it — this module does not
  // reformat somebody's words, so a note that uses {years} on a birthday keeps its gap.
  assert.equal(renderMessage(m, TECH, BIRTHDAY), 'Deshan,  years with us, Deshan Jayasanka!');
  // Anything else the author typed is their own text and survives untouched.
  const braces = msg({ id: 'b', author_epf: 'E3', message: 'Enjoy {the day}' });
  assert.equal(renderMessage(braces, TECH, BIRTHDAY), 'Enjoy {the day}');
});

test('renderMessage: Sinhala and Tamil messages interpolate tokens, and fall back to English if blank', () => {
  const m = msg({
    id: 'm-lang',
    author_epf: 'E3',
    message: 'Happy Birthday, {first_name}!',
    message_si: 'සුබ උපන්දිනයක් වේවා, {first_name}! ({years} වසරක්)',
    message_ta: 'இனிய பிறந்தநாள் வாழ்த்துக்கள், {first_name}!',
  });

  // Sinhala
  assert.equal(
    renderMessage(m, TECH, ANNIVERSARY, '2026-06-01', 'si'),
    'සුබ උපන්දිනයක් වේවා, Deshan! (5 වසරක්)',
  );

  // Tamil
  assert.equal(
    renderMessage(m, TECH, BIRTHDAY, '2026-06-01', 'ta'),
    'இனிய பிறந்தநாள் வாழ்த்துக்கள், Deshan!',
  );

  // Fallback to English when Sinhala/Tamil is missing or empty
  const mEnOnly = msg({
    id: 'm-en',
    author_epf: 'E3',
    message: 'Warm wishes, {name}!',
    message_si: '   ',
  });
  assert.equal(renderMessage(mEnOnly, TECH, BIRTHDAY, '2026-06-01', 'si'), 'Warm wishes, Deshan Jayasanka!');
  assert.equal(renderMessage(mEnOnly, TECH, BIRTHDAY, '2026-06-01', 'ta'), 'Warm wishes, Deshan Jayasanka!');
});

// ─── mergeSenders ─────────────────────────────────────────────────────────────

const sender = (epf: string, o: Partial<Sender> = {}): Sender => ({
  epf, name: `Name ${epf}`, role: 'Role', avatar_url: null, ...o,
});

test('mergeSenders: authors lead, an author who is also a signer keeps their signer entry', () => {
  const signers = [sender('E1'), sender('E9', { supervisor: true })];
  const out = mergeSenders(signers, [
    { msg: msg({ id: 'a', author_epf: 'E3', author_name: 'Eve Super', author_role: 'Executive' }), text: 'From Eve' },
    { msg: msg({ id: 'b', author_epf: 'E1' }), text: 'From Ann' },
  ]);
  assert.deepEqual(out.map(s => s.epf), ['E3', 'E1', 'E9']);
  // The author who was not a signer is added from the snapshot on their message.
  assert.equal(out[0].name, 'Eve Super');
  assert.equal(out[0].role, 'Executive');
  assert.equal(out[0].message, 'From Eve');
  // The one who WAS a signer keeps the signer name and gains the words.
  assert.equal(out[1].name, 'Name E1');
  assert.equal(out[1].message, 'From Ann');
  // Everyone else is untouched, supervisor mark included, and nobody appears twice.
  assert.equal(out[2].supervisor, true);
  assert.equal(out[2].message, undefined);
  assert.equal(new Set(out.map(s => s.epf)).size, out.length);
});

test('mergeSenders: an empty note is not a note, and the signers alone survive', () => {
  const signers = [sender('E1')];
  assert.deepEqual(
    mergeSenders(signers, [{ msg: msg({ id: 'a', author_epf: 'E3' }), text: '   ' }]).map(s => s.epf),
    ['E1'],
  );
  assert.deepEqual(mergeSenders(signers, []).map(s => s.epf), ['E1']);
  assert.deepEqual(mergeSenders([], []), []);
});

test('mergeSenders: preserves message_si and message_ta on merged senders', () => {
  const signers = [sender('E1')];
  const out = mergeSenders(signers, [
    {
      msg: msg({
        id: 'a',
        author_epf: 'E3',
        message_si: 'සුබ පැතුම්',
        message_ta: 'வாழ்த்துக்கள்',
      }),
      text: 'Best wishes',
    },
  ]);
  assert.equal(out[0].message, 'Best wishes');
  assert.equal(out[0].message_si, 'සුබ පැතුම්');
  assert.equal(out[0].message_ta, 'வாழ்த்துக்கள்');
});

// ─── reachOf / isGreetingAudience ─────────────────────────────────────────────

test('reachOf: counts by audience and never counts the author', () => {
  assert.equal(reachOf('everyone', EXEC, null, PEOPLE), PEOPLE.length - 1);
  assert.equal(reachOf('my_team', EXEC, null, PEOPLE), 2);
  assert.equal(reachOf('my_team', TECH, null, PEOPLE), 0);
  assert.equal(reachOf('person', EXEC, 'E4', PEOPLE), 1);
  assert.equal(reachOf('person', EXEC, 'E3', PEOPLE), 0);
  assert.equal(reachOf('person', EXEC, null, PEOPLE), 0);
});

test('reachOf: an inactive person is not somebody a greeting reaches', () => {
  const withInactive = [...PEOPLE, person({ epf_number: 'E7', supervisor_epf: 'E3', is_active: false })];
  assert.equal(reachOf('my_team', EXEC, null, withInactive), 2);
  assert.equal(reachOf('everyone', EXEC, null, withInactive), PEOPLE.length - 1);
});

test('isGreetingAudience: only the three real audiences', () => {
  assert.equal(isGreetingAudience('everyone'), true);
  assert.equal(isGreetingAudience('my_team'), true);
  assert.equal(isGreetingAudience('person'), true);
  assert.equal(isGreetingAudience('all'), false);
  assert.equal(isGreetingAudience(undefined), false);
});

// ─── Per-occasion wordings + variant spread ───────────────────────────────────
// The feature this replaces: ONE message string, shown verbatim to all 112 people. On the one
// day of the year the note is supposed to be about the reader, everybody got the same sentence
// — which is what made it read like a mail merge. A message now carries a set of wordings PER
// OCCASION, and which one a person sees is a pure function of who they are and what year it is.

const VESAK: Occasion = { kind: 'special', dayId: 'vesak', title: 'Vesak', message: '' };
const DEEPAVALI: Occasion = { kind: 'special', dayId: 'deepavali', title: 'Deepavali', message: '' };

test('slotsFor: a special day tries its own slot before the every-special-day one', () => {
  assert.deepEqual(slotsFor(BIRTHDAY), ['birthday']);
  assert.deepEqual(slotsFor(ANNIVERSARY), ['anniversary']);
  assert.deepEqual(slotsFor(VESAK), ['special:vesak', 'special']);
});

test('normalizeMessages: a legacy single string becomes the wording for every occasion it was ticked for', () => {
  const legacy = msg({
    id: 'l', author_epf: 'E3', message: 'Warm wishes',
    occasions: ['birthday', 'special'], special_day_ids: ['vesak'],
  });
  assert.deepEqual(normalizeMessages(legacy), { birthday: ['Warm wishes'], 'special:vesak': ['Warm wishes'] });
});

test('normalizeMessages: a legacy special message with no day ids covers every special day', () => {
  const legacy = msg({
    id: 'l', author_epf: 'E3', message: 'Warm wishes',
    occasions: ['special'], special_day_ids: [],
  });
  assert.deepEqual(normalizeMessages(legacy), { special: ['Warm wishes'] });
});

test('normalizeMessages: blank wordings are dropped and the set is capped', () => {
  const m = msg({
    id: 'm', author_epf: 'E3',
    messages: { birthday: ['  one  ', '', '   ', 'two', 'three', 'four', 'five', 'six'] },
  });
  assert.deepEqual(normalizeMessages(m).birthday, ['one', 'two', 'three', 'four', 'five']);
});

test('wordingsFor: the day\'s own wordings beat the every-special-day ones', () => {
  const m = msg({
    id: 'm', author_epf: 'E3',
    messages: { special: ['Generic festival note'], 'special:vesak': ['Vesak note'] },
  });
  assert.deepEqual(wordingsFor(m, VESAK), ['Vesak note']);
  // A day with nothing of its own still gets the every-special-day wording.
  assert.deepEqual(wordingsFor(m, DEEPAVALI), ['Generic festival note']);
  // An occasion with neither reads as "this author wrote nothing", not as an empty string.
  assert.deepEqual(wordingsFor(m, BIRTHDAY), []);
});

test('renderMessage: the same person and year always read the same wording', () => {
  const m = msg({ id: 'm', author_epf: 'E3', messages: { birthday: ['A, {first_name}', 'B, {first_name}', 'C, {first_name}'] } });
  const a = renderMessage(m, TECH, BIRTHDAY, '2026-06-01');
  const b = renderMessage(m, TECH, BIRTHDAY, '2026-06-01');
  assert.equal(a, b);
  assert.ok(a.endsWith('Deshan'), a);
});

test('renderMessage: different people do not all read the same wording', () => {
  const m = msg({ id: 'm', author_epf: 'E3', messages: { birthday: ['A', 'B', 'C', 'D', 'E'] } });
  const people = Array.from({ length: 40 }, (_, i) => person({ epf_number: `X${i}` }));
  const seen = new Set(people.map(p => renderMessage(m, p, BIRTHDAY, '2026-06-01')));
  // The whole point of the change: one authored greeting must not read identically company-wide.
  assert.ok(seen.size > 1, `every person read the same wording: ${[...seen]}`);
});

test('renderMessage: the wording moves on the following year', () => {
  const m = msg({ id: 'm', author_epf: 'E3', messages: { birthday: ['A', 'B', 'C'] } });
  assert.notEqual(
    renderMessage(m, TECH, BIRTHDAY, '2026-06-01'),
    renderMessage(m, TECH, BIRTHDAY, '2027-06-01'),
  );
});

test('renderMessage: a legacy single-string message still renders (rows written before this change)', () => {
  const legacy = msg({ id: 'l', author_epf: 'E3', message: 'Happy birthday, {first_name}!', occasions: ['birthday'] });
  assert.equal(renderMessage(legacy, TECH, BIRTHDAY, '2026-06-01'), 'Happy birthday, Deshan!');
});
