import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthDayMatches, anniversaryYears, specialDaysOn, isActiveOn, isEmployeeRole,
  isHumanSenderName, isHumanSender, fromPhrase, firstCallingName,
  occasionsFor, resolveSpecialDayDate, modeOf, canonName, titleCaseHoliday,
  signerSentence, joinNames, PUSH_SIGNER_CHARS, selectSenders, greetingCopy,
  firstNameOf, fullNameOf, occasionKey, isValidSpecialDate, DEFAULT_GREETING_SETTINGS,
  type GreetingSettings, type PersonLite, type RoleLite, type SpecialDay, resolveSigners
} from '../greetings';

const ROLES: RoleLite[] = [
  { id: 'ceo', name: 'CEO', category: 'top_management', parent_id: null, is_employee: true },
  { id: 'system_admin', name: 'System Admin', category: 'top_management', parent_id: null, is_employee: false },
  { id: 'coo', name: 'COO', category: 'top_management', parent_id: 'ceo', is_employee: true },
  { id: 'hoe', name: 'Head Operation Engineer', category: 'top_management', parent_id: 'coo', is_employee: true },
  { id: 'exec', name: 'Executive', category: 'executive', parent_id: 'hoe', is_employee: true },
  { id: 'tech', name: 'Technician', category: 'technician', parent_id: 'exec', is_employee: true },
  { id: 'legacy_root', name: 'Legacy Root', parent_id: null, is_employee: true },   // no category → root → top management
];

const person = (o: Partial<PersonLite>): PersonLite => ({
  epf_number: 'E1', display_name: 'Deshan Jayasanka', first_name: 'Deshan', role: 'Technician',
  company_id: 'c1', supervisor_epf: null, is_active: true, date_of_resign: null,
  date_of_birth: null, date_of_join: null, avatar_url: null, ...o,
});

const settings = (o: Partial<GreetingSettings> = {}): GreetingSettings => ({ ...DEFAULT_GREETING_SETTINGS, enabled: true, ...o });

test('monthDayMatches: same month-day, Feb-29 falls back to Feb-28 only in non-leap years', () => {
  assert.equal(monthDayMatches('1996-09-05', '2026-09-05'), true);
  assert.equal(monthDayMatches('1996-09-06', '2026-09-05'), false);
  assert.equal(monthDayMatches('2000-02-29', '2026-02-28'), true);    // 2026 not leap
  assert.equal(monthDayMatches('2000-02-29', '2028-02-28'), false);   // 2028 leap: wait for the 29th
  assert.equal(monthDayMatches('2000-02-29', '2028-02-29'), true);
  assert.equal(monthDayMatches(null, '2026-09-05'), false);
  assert.equal(monthDayMatches('bad', '2026-09-05'), false);
});

test('anniversaryYears: whole years since joining, only on the month-day, never for the join year or the future', () => {
  assert.equal(anniversaryYears('2023-09-05', '2026-09-05'), 3);
  assert.equal(anniversaryYears('2025-09-05', '2026-09-05'), 1);
  assert.equal(anniversaryYears('2026-09-05', '2026-09-05'), null);   // joined today
  assert.equal(anniversaryYears('2026-01-05', '2026-09-05'), null);   // under a year, wrong day anyway
  assert.equal(anniversaryYears('2027-09-05', '2026-09-05'), null);   // future join date exists in prod
  assert.equal(anniversaryYears('2023-09-06', '2026-09-05'), null);
  assert.equal(anniversaryYears(null, '2026-09-05'), null);
});

test('specialDaysOn: annual MM-DD and one-off YYYY-MM-DD, disabled entries ignored', () => {
  const days: SpecialDay[] = [
    { id: 'a', title: 'Vesak', message: '', date: '05-12', enabled: true },
    { id: 'b', title: 'Company day', message: 'Ten years!', date: '2026-09-05', enabled: true },
    { id: 'c', title: 'Old one-off', message: '', date: '2025-09-05', enabled: true },
    { id: 'd', title: 'Off', message: '', date: '09-05', enabled: false },
  ];
  assert.deepEqual(specialDaysOn(days, '2026-09-05').map(d => d.id), ['b']);
  assert.deepEqual(specialDaysOn(days, '2026-05-12').map(d => d.id), ['a']);
  assert.deepEqual(specialDaysOn(days, '2027-09-05').map(d => d.id), []);
});

test('isValidSpecialDate accepts MM-DD and YYYY-MM-DD only', () => {
  assert.equal(isValidSpecialDate('05-12'), true);
  assert.equal(isValidSpecialDate('2026-09-05'), true);
  assert.equal(isValidSpecialDate('13-01'), false);
  assert.equal(isValidSpecialDate('2026-9-5'), false);
  assert.equal(isValidSpecialDate(''), false);
});

test('isActiveOn: inactive or resigned people are out', () => {
  assert.equal(isActiveOn(person({}), '2026-09-05'), true);
  assert.equal(isActiveOn(person({ is_active: false }), '2026-09-05'), false);
  assert.equal(isActiveOn(person({ date_of_resign: '2026-09-05' }), '2026-09-05'), false);
  assert.equal(isActiveOn(person({ date_of_resign: '2026-12-31' }), '2026-09-05'), true);
});

test('isEmployeeRole: role doc decides; an unknown role counts as an employee', () => {
  assert.equal(isEmployeeRole('Technician', ROLES), true);
  assert.equal(isEmployeeRole('System Admin', ROLES), false);
  assert.equal(isEmployeeRole('Unknown', ROLES), true);
});

test('occasionsFor: honours every switch and the master switch', () => {
  const p = person({ date_of_birth: '1996-09-05', date_of_join: '2023-09-05' });
  const days: SpecialDay[] = [{ id: 'x', title: 'Company day', message: 'Hi', date: '09-05', enabled: true }];
  const all = occasionsFor(p, settings({ special_days: days }), '2026-09-05');
  assert.deepEqual(all, [
    { kind: 'birthday' },
    { kind: 'anniversary', years: 3 },
    { kind: 'special', dayId: 'x', title: 'Company day', message: 'Hi' },
  ]);
  assert.deepEqual(occasionsFor(p, settings({ birthday: false, special_days: days }), '2026-09-05').map(o => o.kind), ['anniversary', 'special']);
  assert.deepEqual(occasionsFor(p, settings({ anniversary: false, special: false, special_days: days }), '2026-09-05').map(o => o.kind), ['birthday']);
  assert.deepEqual(occasionsFor(p, settings({ enabled: false, special_days: days }), '2026-09-05'), []);
  assert.deepEqual(occasionsFor(person({ is_active: false, date_of_birth: '1996-09-05' }), settings(), '2026-09-05'), []);
});

test('selectSenders: company top management (employee roles only) by depth, then the supervisor; recipient excluded', () => {
  const people: PersonLite[] = [
    person({ epf_number: 'CEO1', display_name: 'Ann Chief', role: 'CEO' }),
    person({ epf_number: 'ADM', display_name: 'System Admin', role: 'System Admin' }),
    person({ epf_number: 'COO1', display_name: 'Bob Ops', role: 'COO' }),
    person({ epf_number: 'HOE1', display_name: 'Cara Head', role: 'Head Operation Engineer' }),
    person({ epf_number: 'HOE2', display_name: 'Dan Head', role: 'Head Operation Engineer', company_id: 'c2' }),
    person({ epf_number: 'SUP1', display_name: 'Eve Super', role: 'Executive' }),
    person({ epf_number: 'GONE', display_name: 'Gone Person', role: 'COO', is_active: false }),
    person({ epf_number: 'E1', supervisor_epf: 'SUP1' }),
  ];
  const s = selectSenders(people[7], people, ROLES);
  assert.deepEqual(s.map(x => x.epf), ['CEO1', 'COO1', 'HOE1', 'SUP1']);
  assert.equal(s[3].supervisor, true);
  assert.equal(s[0].role, 'CEO');
});

test('selectSenders: a top manager greeting themselves is dropped; supervisor already in the pool is not doubled', () => {
  const people: PersonLite[] = [
    person({ epf_number: 'CEO1', display_name: 'Ann Chief', role: 'CEO' }),
    person({ epf_number: 'COO1', display_name: 'Bob Ops', role: 'COO', supervisor_epf: 'CEO1' }),
  ];
  const s = selectSenders(people[1], people, ROLES);
  assert.deepEqual(s.map(x => x.epf), ['CEO1']);
  assert.equal(s[0].supervisor, true);
});

test('selectSenders: cap keeps the supervisor; no company → supervisor only; nobody → empty', () => {
  const tops = Array.from({ length: 10 }, (_, i) => person({ epf_number: `T${i}`, display_name: `Top ${i}`, role: 'COO' }));
  const me = person({ epf_number: 'E1', supervisor_epf: 'SUPX' });
  const sup = person({ epf_number: 'SUPX', display_name: 'Sue Per', role: 'Executive' });
  const s = selectSenders(me, [...tops, sup, me], ROLES, 4);
  assert.equal(s.length, 4);
  assert.equal(s[3].epf, 'SUPX');
  const noCompany = person({ epf_number: 'E2', company_id: '', supervisor_epf: 'SUPX' });
  assert.deepEqual(selectSenders(noCompany, [...tops, sup, noCompany], ROLES).map(x => x.epf), ['SUPX']);
  assert.deepEqual(selectSenders(person({ epf_number: 'E3', company_id: '' }), [], ROLES), []);
});

test('greetingCopy and helpers', () => {
  assert.equal(firstNameOf(person({ first_name: '', display_name: 'Deshan Jayasanka' })), 'Deshan');
  assert.equal(firstNameOf(person({ first_name: null, display_name: '' })), 'there');
  assert.equal(occasionKey({ kind: 'birthday' }), 'birthday');
  assert.equal(occasionKey({ kind: 'special', dayId: 'x', title: '', message: '' }), 'special-x');
  const b = greetingCopy({ kind: 'birthday' }, 'Deshan Jayasanka', 'PearlCluster');
  assert.equal(b.title, '🎂 Happy birthday, Deshan Jayasanka!');
  assert.match(b.body, /PearlCluster/);
  const a = greetingCopy({ kind: 'anniversary', years: 3 }, 'Deshan Jayasanka', 'PearlCluster');
  assert.match(a.title, /3 years with us, Deshan Jayasanka!/);
  const one = greetingCopy({ kind: 'anniversary', years: 1 }, 'Deshan Jayasanka', 'PearlCluster');
  assert.match(one.title, /1 year\b/);
  const sp = greetingCopy({ kind: 'special', dayId: 'x', title: 'Vesak', message: 'May peace be with you.' }, 'Deshan Jayasanka', 'PearlCluster');
  assert.equal(sp.title, 'Vesak');
  assert.equal(sp.body, 'May peace be with you.');
  const spDefault = greetingCopy({ kind: 'special', dayId: 'x', title: 'Vesak', message: '' }, 'Deshan Jayasanka', 'PearlCluster');
  assert.match(spDefault.body, /PearlCluster/);
});

// The greeting names people in full — anywhere a first name leaks through, the card reads
// like a mail merge.
test('fullNameOf: display name leads, first + last rebuilds it, a lone first name is the last resort', () => {
  assert.equal(fullNameOf(person({ display_name: 'Nimal Silva', first_name: 'Nimal', last_name: 'Silva' })), 'Nimal Silva');
  assert.equal(fullNameOf(person({ display_name: '', first_name: 'Nimal', last_name: 'Silva' })), 'Nimal Silva');
  assert.equal(fullNameOf(person({ display_name: null, first_name: 'Nimal', last_name: null })), 'Nimal');
  assert.equal(fullNameOf(person({ display_name: '  Nimal Silva  ', first_name: 'Nimal' })), 'Nimal Silva');
  // Nothing at all: the EPF is at least a real identifier, and only then a placeholder.
  assert.equal(fullNameOf(person({ epf_number: '151', display_name: '', first_name: '', last_name: '' })), '151');
  assert.equal(fullNameOf(person({ epf_number: '', display_name: '', first_name: '', last_name: '' })), 'there');
});

test('selectSenders signs with full names, not first names', () => {
  const people: PersonLite[] = [
    person({ epf_number: 'CEO1', display_name: '', first_name: 'Ann', last_name: 'Chief', role: 'CEO' }),
    person({ epf_number: 'E1' }),
  ];
  assert.deepEqual(selectSenders(people[1], people, ROLES).map(x => x.name), ['Ann Chief']);
});

// ── Calendar-synced special days ──────────────────────────────────────────────
// Most festivals here move: Vesak Poya is a full moon, Poson and Deepavali and Eid shift, so a
// fixed date is wrong for them. A 'calendar' day carries the holiday NAME and takes its date
// from the org's own calendar for the year being greeted.

const cal = (year: string, entries: Record<string, string>) => ({
  year,
  byName: Object.fromEntries(Object.entries(entries).map(([k, v]) => [canonName(k), v])),
});

test('modeOf: rows saved before `mode` existed keep working', () => {
  assert.equal(modeOf({ id: 'a', title: 'X', message: '', enabled: true, date: '12-25' }), 'annual');
  assert.equal(modeOf({ id: 'a', title: 'X', message: '', enabled: true, date: '2026-09-05' }), 'once');
  assert.equal(modeOf({ id: 'a', title: 'X', message: '', enabled: true, mode: 'calendar', calendar_name: 'Vesak' }), 'calendar');
});

test('canonName ignores case and whitespace, because an admin typing a holiday name should not have to match it exactly', () => {
  assert.equal(canonName('  Vesak   Full Moon Poya Day '), 'vesak full moon poya day');
  assert.equal(canonName('VESAK'), canonName('vesak'));
  assert.equal(canonName(null), '');
});

test('resolveSpecialDayDate: annual repeats every year, one-off only in its own', () => {
  const xmas = { id: 'x', title: 'Christmas', message: '', enabled: true, mode: 'annual' as const, date: '12-25' };
  assert.equal(resolveSpecialDayDate(xmas, '2026'), '2026-12-25');
  assert.equal(resolveSpecialDayDate(xmas, '2031'), '2031-12-25');
  const once = { id: 'o', title: 'Ten years', message: '', enabled: true, mode: 'once' as const, date: '2026-09-05' };
  assert.equal(resolveSpecialDayDate(once, '2026'), '2026-09-05');
  assert.equal(resolveSpecialDayDate(once, '2027'), null);
});

test('resolveSpecialDayDate: a calendar day follows the holiday calendar, and moves with it', () => {
  const vesak = { id: 'v', title: 'Vesak', message: '', enabled: true, mode: 'calendar' as const, calendar_name: 'Vesak Full Moon Poya Day' };
  assert.equal(resolveSpecialDayDate(vesak, '2026', cal('2026', { 'vesak full moon poya day': '2026-05-01' })), '2026-05-01');
  // Next year the full moon is elsewhere; the same row follows it.
  assert.equal(resolveSpecialDayDate(vesak, '2027', cal('2027', { 'Vesak Full Moon Poya Day': '2027-05-20' })), '2027-05-20');
  // Loose matching: the admin typed it with different casing and spacing.
  assert.equal(resolveSpecialDayDate(vesak, '2026', cal('2026', { '  VESAK   full moon poya day ': '2026-05-01' })), '2026-05-01');
});

test('resolveSpecialDayDate: a calendar day the calendar does not know does not fire — it never guesses', () => {
  const v = { id: 'v', title: 'Vesak', message: '', enabled: true, mode: 'calendar' as const, calendar_name: 'Vesak' };
  assert.equal(resolveSpecialDayDate(v, '2026', cal('2026', { Poson: '2026-05-31' })), null);
  assert.equal(resolveSpecialDayDate(v, '2026', null), null);
  // A calendar for the wrong year is not used for this one.
  assert.equal(resolveSpecialDayDate(v, '2027', cal('2026', { Vesak: '2026-05-01' })), null);
});

test('resolveSpecialDayDate: an explicit per-year date always wins', () => {
  const v = {
    id: 'v', title: 'Vesak', message: '', enabled: true, mode: 'calendar' as const,
    calendar_name: 'Vesak', dates_by_year: { '2026': '2026-05-02' },
  };
  assert.equal(resolveSpecialDayDate(v, '2026', cal('2026', { Vesak: '2026-05-01' })), '2026-05-02');
  // …and rescues a year the calendar has nothing for.
  assert.equal(resolveSpecialDayDate(v, '2026', null), '2026-05-02');
  // An override on an annual row wins over its own MM-DD.
  const xmas = { id: 'x', title: 'Christmas', message: '', enabled: true, mode: 'annual' as const, date: '12-25', dates_by_year: { '2026': '2026-12-26' } };
  assert.equal(resolveSpecialDayDate(xmas, '2026'), '2026-12-26');
});

test('specialDaysOn honours the calendar and still ignores disabled rows', () => {
  const days = [
    { id: 'v', title: 'Vesak', message: '', enabled: true, mode: 'calendar' as const, calendar_name: 'Vesak' },
    { id: 'p', title: 'Poson', message: '', enabled: false, mode: 'calendar' as const, calendar_name: 'Poson' },
  ];
  const c = cal('2026', { Vesak: '2026-05-01', Poson: '2026-05-01' });
  assert.deepEqual(specialDaysOn(days, '2026-05-01', c).map(d => d.id), ['v']);
  assert.deepEqual(specialDaysOn(days, '2026-05-02', c).map(d => d.id), []);
  // No calendar supplied: a calendar-mode day simply does not fire.
  assert.deepEqual(specialDaysOn(days, '2026-05-01').map(d => d.id), []);
});

test('titleCaseHoliday turns a calendar name into a card heading', () => {
  assert.equal(titleCaseHoliday("sinhala and tamil new year's day"), "Sinhala and Tamil New Year's Day");
  assert.equal(titleCaseHoliday('VESAK FULL MOON POYA DAY'), 'Vesak Full Moon Poya Day');
  assert.equal(titleCaseHoliday('id-ul-fitr'), 'Id-Ul-Fitr');
  assert.equal(titleCaseHoliday('  day   of   the  dead '), 'Day of the Dead');
  assert.equal(titleCaseHoliday(''), '');
  assert.equal(titleCaseHoliday(null), '');
});

// ── Named signers ────────────────────────────────────────────────────────────
// "Warm wishes from your leadership team" is what a card says when it does not know who is
// wishing you. An admin picks the people; the card names them.

test('selectSenders: the admin picked list wins, in its own order, and skips anyone who left', () => {
  const people: PersonLite[] = [
    person({ epf_number: 'CEO1', display_name: 'Ann Chief', role: 'CEO' }),
    person({ epf_number: 'COO1', display_name: 'Bob Ops', role: 'COO' }),
    person({ epf_number: 'GONE', display_name: 'Gone Person', role: 'COO', is_active: false }),
    person({ epf_number: 'SUP1', display_name: 'Eve Super', role: 'Executive' }),
    person({ epf_number: 'E1', supervisor_epf: 'SUP1' }),
  ];
  const me = people[4];
  // Deliberately reversed against role depth: the admin's order is the card's order.
  const s = selectSenders(me, people, ROLES, 8, ['COO1', 'CEO1', 'GONE']);
  assert.deepEqual(s.map(x => x.epf), ['COO1', 'CEO1', 'SUP1']);
  assert.equal(s[2].supervisor, true);
});

test('selectSenders: an empty picked list keeps the automatic company top management', () => {
  const people: PersonLite[] = [
    person({ epf_number: 'CEO1', display_name: 'Ann Chief', role: 'CEO' }),
    person({ epf_number: 'COO1', display_name: 'Bob Ops', role: 'COO' }),
    person({ epf_number: 'E1' }),
  ];
  assert.deepEqual(selectSenders(people[2], people, ROLES, 8, []).map(x => x.epf), ['CEO1', 'COO1']);
  assert.deepEqual(selectSenders(people[2], people, ROLES, 8, undefined).map(x => x.epf), ['CEO1', 'COO1']);
});

test('selectSenders: a picked signer never signs their own card', () => {
  const people: PersonLite[] = [
    person({ epf_number: 'CEO1', display_name: 'Ann Chief', role: 'CEO' }),
    person({ epf_number: 'COO1', display_name: 'Bob Ops', role: 'COO' }),
  ];
  assert.deepEqual(selectSenders(people[0], people, ROLES, 8, ['CEO1', 'COO1']).map(x => x.epf), ['COO1']);
});

test('joinNames writes a list the way a person would, in whatever language the caller is in', () => {
  assert.equal(joinNames([]), '');
  assert.equal(joinNames(['A']), 'A');
  assert.equal(joinNames(['A', 'B']), 'A and B');
  assert.equal(joinNames(['A', 'B', 'C', 'D']), 'A, B, C and D');
  assert.equal(joinNames(['A', '  ', 'B']), 'A and B');
  assert.equal(joinNames(['A', 'B'], 'සහ'), 'A සහ B');
});

// The user asked for this in as many words: "There is no plus two names or any other thing."
test('signerSentence names EVERY signer — never a "+N" and never "N others"', () => {
  const s = (n: number) => Array.from({ length: n }, (_, i) => ({ epf: `E${i}`, name: `Person ${i}`, role: 'COO', avatar_url: null }));
  assert.equal(signerSentence([], 'PearlCluster'), 'your team at PearlCluster');
  assert.equal(signerSentence(s(1), 'PearlCluster'), 'Person 0');
  assert.equal(signerSentence(s(2), 'PearlCluster'), 'Person 0 and Person 1');
  assert.equal(signerSentence(s(3), 'PearlCluster'), 'Person 0, Person 1 and Person 2');
  const five = signerSentence(s(5), 'PearlCluster');
  assert.equal(five, 'Person 0, Person 1, Person 2, Person 3 and Person 4');
  assert.doesNotMatch(five, /\+\d|others/);
});

test('signerSentence caps a push body by CHARACTERS, dropping whole names and saying nothing about them', () => {
  const s = (n: number) => Array.from({ length: n }, (_, i) => ({ epf: `E${i}`, name: `Person Number ${i}`, role: 'COO', avatar_url: null }));
  const capped = signerSentence(s(12), 'PearlCluster', 60);
  assert.ok(capped.length <= 60, capped);
  assert.doesNotMatch(capped, /\+\d|others|…|\.\.\./);
  // Whole names only — the last one named is complete.
  assert.ok(capped.split(' and ')[1].startsWith('Person Number '));
  // maxChars 0 (the bell and the card) never truncates.
  assert.ok(signerSentence(s(12), 'PearlCluster').length > 60);
  // One name longer than the budget still ships whole; a cut-off name is worse than a long one.
  const long = [{ epf: 'A', name: 'A'.repeat(80), role: 'CEO', avatar_url: null }];
  assert.equal(signerSentence(long, 'PearlCluster', 20).length, 80);
});

test('signerSentence puts the supervisor FIRST, so truncation can never eat the one personal signature', () => {
  const senders = [
    { epf: 'A', name: 'Ann Chief', role: 'CEO', avatar_url: null },
    { epf: 'B', name: 'Bob Ops', role: 'COO', avatar_url: null },
    { epf: 'S', name: 'Eve Super', role: 'Executive', avatar_url: null, supervisor: true },
  ];
  assert.equal(signerSentence(senders, 'PearlCluster'), 'your supervisor Eve Super, Ann Chief and Bob Ops');
  // selectSenders appends the supervisor LAST, so a tail-truncating cap would have dropped
  // exactly them. It survives.
  assert.match(signerSentence(senders, 'PearlCluster', 40), /your supervisor Eve Super/);
});

test('greetingCopy names the signers, and stays inside a push body when there are many', () => {
  const senders = [
    { epf: 'A', name: 'Ann Chief', role: 'CEO', avatar_url: null },
    { epf: 'S', name: 'Eve Super', role: 'Executive', avatar_url: null, supervisor: true },
  ];
  const b = greetingCopy({ kind: 'birthday' }, 'Deshan Jayasanka', 'PearlCluster', senders);
  assert.match(b.body, /your supervisor Eve Super and Ann Chief/i);   // may lead the sentence, hence capitalised
  assert.doesNotMatch(b.body, /leadership team/);
  // With nobody picked and nobody resolved, it still reads as a sentence — and an honest one.
  assert.match(greetingCopy({ kind: 'birthday' }, 'Deshan Jayasanka', 'PearlCluster').body, /your team at PearlCluster/i);
  const many = Array.from({ length: 20 }, (_, i) => ({ epf: `E${i}`, name: `Person Number ${i}`, role: 'COO', avatar_url: null }));
  const big = greetingCopy({ kind: 'birthday' }, 'Deshan Jayasanka', 'PearlCluster', many);
  assert.ok(big.body.length <= PUSH_SIGNER_CHARS + 60, String(big.body.length));
  assert.doesNotMatch(big.body, /\+\d|others/);
});

// ─── Scoped signers: department, then company, then the default list ──────────


const groups = [
  { scope: 'company' as const,    key: 'c1',         signers: ['CO1', 'CO2'] },
  { scope: 'department' as const, key: 'Operations', signers: ['OPS1'] },
  { scope: 'department' as const, key: 'Finance',    signers: [] },        // configured, then emptied
];
const scoped = { signers: ['DEF1', 'DEF2'], signer_groups: groups };

test('the recipient department wins over their company', () => {
  assert.deepEqual(
    resolveSigners(scoped, { company_id: 'c1', department: 'Operations' }),
    ['OPS1'],
  );
});

test('a company group applies when no department group matches', () => {
  assert.deepEqual(
    resolveSigners(scoped, { company_id: 'c1', department: 'Stores' }),
    ['CO1', 'CO2'],
  );
  assert.deepEqual(
    resolveSigners(scoped, { company_id: 'c1', department: null }),
    ['CO1', 'CO2'],
  );
});

test('the default list catches everyone the groups miss', () => {
  assert.deepEqual(
    resolveSigners(scoped, { company_id: 'c9', department: 'Stores' }),
    ['DEF1', 'DEF2'],
  );
});

test('nothing configured returns undefined, so the caller falls back to top management', () => {
  assert.equal(resolveSigners({ signers: [], signer_groups: [] }, { company_id: 'c1', department: 'Ops' }), undefined);
  assert.equal(resolveSigners(null, { company_id: 'c1', department: 'Ops' }), undefined);
  assert.equal(resolveSigners(undefined, { company_id: '', department: '' }), undefined);
});

// Department names are typed by hand in two places — the user profile and this setting.
test('department names match trimmed and case-insensitively', () => {
  assert.deepEqual(resolveSigners(scoped, { company_id: '', department: '  operations ' }), ['OPS1']);
  assert.deepEqual(
    resolveSigners({ signer_groups: [{ scope: 'department', key: ' Ops Team ', signers: ['X'] }] },
      { company_id: '', department: 'ops team' }),
    ['X'],
  );
});

test('a group emptied of people is not a match — it falls through', () => {
  assert.deepEqual(
    resolveSigners(scoped, { company_id: 'c1', department: 'Finance' }),
    ['CO1', 'CO2'],
  );
});

test('a company id is matched exactly, never case-folded — ids are ids', () => {
  assert.deepEqual(
    resolveSigners(scoped, { company_id: 'C1', department: 'Stores' }),
    ['DEF1', 'DEF2'],
  );
});

test('isHumanSenderName: excludes system admin and administrative accounts regardless of casing', () => {
  assert.equal(isHumanSenderName('System Admin', 'System Admin'), false);
  assert.equal(isHumanSenderName('Sys Admin', 'Executive'), false);
  assert.equal(isHumanSenderName('System Administrator', 'COO'), false);
  assert.equal(isHumanSenderName('Admin', 'Admin'), false);
  assert.equal(isHumanSenderName('Administrator', 'Executive'), false);
  assert.equal(isHumanSenderName('Nimal Silva', 'System Admin'), false);
  assert.equal(isHumanSenderName('Nimal Silva', 'Sys Admin'), false);
  assert.equal(isHumanSenderName('Nimal Silva', 'Software Engineer'), true);
});

test('selectSenders: excludes supervisor when supervisor is a System Admin', () => {
  const people: PersonLite[] = [
    person({ epf_number: 'CEO1', display_name: 'Ann Chief', role: 'CEO' }),
    person({ epf_number: 'ADM', display_name: 'System Admin', role: 'System Admin' }),
    person({ epf_number: 'E1', supervisor_epf: 'ADM' }),
  ];
  const s = selectSenders(people[2], people, ROLES);
  assert.deepEqual(s.map(x => x.epf), ['CEO1']);
  assert.equal(s.some(x => x.name.toLowerCase().includes('admin')), false);
  assert.equal(signerSentence(s, 'PearlCluster'), 'Ann Chief');
  assert.equal(fromPhrase(s, 'PearlCluster'), 'Ann Chief at PearlCluster');
});

test('selectSenders: excludes picked signers when configured with System Admin', () => {
  const people: PersonLite[] = [
    person({ epf_number: 'CEO1', display_name: 'Ann Chief', role: 'CEO' }),
    person({ epf_number: 'ADM', display_name: 'System Admin', role: 'System Admin' }),
    person({ epf_number: 'E1', supervisor_epf: null }),
  ];
  const s = selectSenders(people[2], people, ROLES, 8, ['ADM', 'CEO1']);
  assert.deepEqual(s.map(x => x.epf), ['CEO1']);
  assert.equal(s.some(x => x.name.toLowerCase().includes('admin')), false);
});

test('firstCallingName: skips initials and titles to find the calling first name', () => {
  assert.equal(firstCallingName('W Supun Manuranga'), 'Supun');
  assert.equal(firstCallingName('A.W.K. Pabasara'), 'Pabasara');
  assert.equal(firstCallingName('Dr. R.P. Muthukumarana'), 'Muthukumarana');
  assert.equal(firstCallingName('Mr. Nimal Silva'), 'Nimal');
  assert.equal(firstCallingName('Deshan Jayasanka'), 'Deshan');
  assert.equal(firstCallingName(''), 'there');

  assert.equal(firstNameOf(person({ first_name: 'W', display_name: 'W Supun Manuranga' })), 'Supun');
  assert.equal(firstNameOf(person({ first_name: 'Supun', display_name: 'W Supun Manuranga' })), 'Supun');
});


