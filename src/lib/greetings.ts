// Pure greeting engine — who gets which greeting today, and who signs it. No firebase, no
// React: the daily cron route, the admin test route and the client card all import this.
// Dates are the app's YYYY-MM-DD strings throughout; never Date.parse them.
import {
  greetingBodyVariant, poolFor, poolNameFor, variantIndex,
  type PoolName, type GreetingLang,
} from './greetingVariants';


export type OccasionKind = 'birthday' | 'anniversary' | 'special';

export type Occasion =
  | { kind: 'birthday' }
  | { kind: 'anniversary'; years: number }
  | {
      kind: 'special';
      dayId: string;
      title: string;
      message: string;
      title_si?: string;
      message_si?: string;
      title_ta?: string;
      message_ta?: string;
    };

// How a special day's date is decided. 'calendar' exists because most festivals here move:
// Vesak Poya is a full moon, Poson and Deepavali and Eid all shift, so a fixed date is simply
// wrong for them. A 'calendar' day carries the holiday's NAME and takes its date from the
// org's own holiday calendar for the year being greeted.
export type SpecialDayMode = 'annual' | 'once' | 'calendar';

export interface SpecialDay {
  id: string;
  title: string;      // card heading
  message: string;    // optional admin body; '' → generic copy
  title_si?: string;
  message_si?: string;
  title_ta?: string;
  message_ta?: string;
  enabled: boolean;
  /** Absent on rows saved before this existed — derived from `date`'s length by modeOf(). */
  mode?: SpecialDayMode;
  date?: string;      // 'MM-DD' when annual, 'YYYY-MM-DD' when once
  /** 'calendar' mode: matched against the holiday calendar's names, loosely (see canonName). */
  calendar_name?: string;
  /** Per-year manual date, keyed by year ('2026'). Always wins — it is the admin's override
   *  and the escape hatch for a year the calendar has nothing for. */
  dates_by_year?: Record<string, string>;
}

/** The names-to-dates view of one year's holiday calendar, built by the caller. */
export interface HolidayCalendar {
  year: string;                      // 'YYYY'
  byName: Record<string, string>;    // canonName(holiday name) → 'YYYY-MM-DD'
}

/** Loose name matching: case and surrounding/internal whitespace must not decide a match. */
export function canonName(v: string | null | undefined): string {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Words that stay lowercase inside a title unless they lead it. Enough for Sri Lankan holiday
// names as the calendar spells them ("Sinhala and Tamil New Year's Day", "Id-Ul-Fitr").
const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'de', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);

/**
 * A holiday name as a card heading. Calendars store names in whatever case they please
 * ("sinhala and tamil new year's day"), and a heading in that case looks like a mistake.
 * Hyphenated parts are capitalised on both sides; an apostrophe does not start a new word,
 * so "new year's" stays "New Year's" and never becomes "New Year'S".
 */
export function titleCaseHoliday(name: string | null | undefined): string {
  const words = canonName(name).split(' ').filter(Boolean);
  return words
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w))
      ? w
      : w.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('-'))
    .join(' ');
}

/** A row saved before `mode` existed is annual when its date is 'MM-DD', else one-off. */
export function modeOf(day: SpecialDay): SpecialDayMode {
  if (day.mode) return day.mode;
  return (day.date ?? '').length === 5 ? 'annual' : 'once';
}

/**
 * The 'YYYY-MM-DD' this day falls on in `year`, or null when it has none. Resolution order:
 *   1. an explicit per-year override,
 *   2. the org's holiday calendar, by name,
 *   3. nothing — a 'calendar' day whose name the calendar does not know does not fire, and the
 *      settings screen is expected to say so rather than let it fail silently.
 * An annual day is that year's 'MM-DD'; a one-off is itself, and only in its own year.
 */
export function resolveSpecialDayDate(
  day: SpecialDay, year: string, calendar?: HolidayCalendar | null,
): string | null {
  const override = day.dates_by_year?.[year];
  if (override && YMD.test(override)) return override;

  switch (modeOf(day)) {
    case 'annual':
      return day.date && MD.test(day.date) ? `${year}-${day.date}` : null;
    case 'once':
      return day.date && YMD.test(day.date) && day.date.slice(0, 4) === year ? day.date : null;
    case 'calendar': {
      if (!calendar || calendar.year !== year) return null;
      const hit = calendar.byName[canonName(day.calendar_name)];
      return hit && YMD.test(hit) ? hit : null;
    }
  }
}

/**
 * A signer list that applies to part of the organisation.
 *
 * `scope: 'company'` matches the recipient's company_id; `'department'` matches the department
 * on their profile, trimmed and case-insensitively, because department names are typed by hand.
 */
export interface SignerGroup {
  scope: 'company' | 'department';
  /** Company id, or department name. */
  key: string;
  /** EPFs, in the order they should appear on the card. */
  signers: string[];
}

export interface GreetingSettings {
  enabled: boolean;
  /** The DEFAULT signer list — used when no scoped group matches the recipient. Empty falls
   *  back to resolving the recipient's company top management automatically, which is what a
   *  tenant that never opens the setting keeps getting. */
  signers?: string[];
  /** Signers for one company or one department. The most specific match wins: department,
   *  then company, then the default list above. A department in one company and a department
   *  of the same name in another are the same rule — department names are not scoped by
   *  company anywhere else in this app either. */
  signer_groups?: SignerGroup[];
  birthday: boolean;
  anniversary: boolean;
  special: boolean;
  special_days: SpecialDay[];
  updated_at?: unknown;
  updated_by?: string;
  updated_by_name?: string;
}

export const DEFAULT_GREETING_SETTINGS: GreetingSettings = {
  enabled: false, birthday: true, anniversary: true, special: true, special_days: [],
  signers: [], signer_groups: [],
};

// The slice of a roles doc the engine needs. `category` is explicit on prod role docs; a role
// with no category and no parent is a tree root, which permissions.ts also treats as top
// management. Executive-vs-technician does not matter here.
export interface RoleLite {
  id?: string;
  name: string;
  category?: 'technician' | 'executive' | 'top_management' | null;
  parent_id?: string | null;
  is_employee?: boolean;
  is_system_admin?: boolean;
}

// The slice of a users doc the engine needs.
export interface PersonLite {
  epf_number: string;
  display_name?: string | null;
  name?: string | null;
  first_name?: string | null;
  /** Used to build a full name when display_name is missing — a greeting names people in
   *  full, so first_name alone is a last resort and never the intended answer. */
  last_name?: string | null;
  role?: string | null;
  company_id?: string | null;
  /** Matched against a department-scoped SignerGroup. Absent on a person with no department. */
  department?: string | null;
  supervisor_epf?: string | null;
  is_active?: boolean;
  is_system_admin?: boolean;
  date_of_resign?: string | null;
  date_of_birth?: string | null;
  date_of_join?: string | null;
  avatar_url?: string | null;
}

export interface Sender {
  epf: string;
  name: string;
  role: string;
  avatar_url: string | null;
  supervisor?: boolean;   // marked "your supervisor" on the card
  /** This sender's own words for this recipient, when they wrote a personal greeting (see
   *  greetingMessages.ts). Present only on the senders who actually wrote something; the card
   *  leads with the first one and quotes the rest under their names. */
  message?: string;
  message_si?: string;
  message_ta?: string;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MD  = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// Does the stored date's month-day fall on `today`? A Feb-29 date matches Feb-28 in a
// non-leap year so the person is never skipped, and only Feb-29 in a leap year.
export function monthDayMatches(dateStr: string | null | undefined, today: string): boolean {
  if (!dateStr || !YMD.test(dateStr) || !YMD.test(today)) return false;
  const md = dateStr.slice(5, 10);
  const todayMd = today.slice(5, 10);
  if (md === todayMd) return true;
  return md === '02-29' && todayMd === '02-28' && !isLeapYear(Number(today.slice(0, 4)));
}

/**
 * Whole years completed since joining, on ANY day of the year — not just the anniversary.
 *
 * anniversaryYears() answers "is today their anniversary, and which one"; this answers "how
 * long have they been here", which is what {years} means in a note written for a birthday or a
 * festival. Same string handling as everything else here: no Date.parse.
 */
export function tenureYears(dateOfJoin: string | null | undefined, today: string): number | null {
  if (!dateOfJoin || !YMD.test(dateOfJoin) || !YMD.test(today)) return null;
  const years = Number(today.slice(0, 4)) - Number(dateOfJoin.slice(0, 4))
    - (today.slice(5, 10) < dateOfJoin.slice(5, 10) ? 1 : 0);
  return years >= 0 ? years : null;
}

// Whole years since joining when today is the anniversary month-day, else null. The join
// year itself and any future join date yield null.
export function anniversaryYears(dateOfJoin: string | null | undefined, today: string): number | null {
  if (!dateOfJoin || !monthDayMatches(dateOfJoin, today)) return null;
  const years = Number(today.slice(0, 4)) - Number(dateOfJoin.slice(0, 4));
  return years >= 1 ? years : null;
}

export function isValidSpecialDate(s: string): boolean {
  return MD.test(s) || YMD.test(s);
}

export function specialDayMatches(
  day: SpecialDay, today: string, calendar?: HolidayCalendar | null,
): boolean {
  if (!day.enabled) return false;
  return resolveSpecialDayDate(day, today.slice(0, 4), calendar) === today;
}

export function specialDaysOn(
  days: SpecialDay[] | undefined, today: string, calendar?: HolidayCalendar | null,
): SpecialDay[] {
  return (days ?? []).filter(d => specialDayMatches(d, today, calendar));
}

export function isActiveOn(p: PersonLite, today: string): boolean {
  if (p.is_active === false) return false;
  const resign = p.date_of_resign;
  return !(resign && YMD.test(resign) && resign <= today);
}

function roleByName(name: string | null | undefined, roles: RoleLite[]): RoleLite | undefined {
  return name ? roles.find(r => r.name === name) : undefined;
}

// Unknown role → basic employee (mirrors FALLBACK_CAPS in permissions.ts).
export function isEmployeeRole(roleName: string | null | undefined, roles: RoleLite[]): boolean {
  const norm = canonName(roleName);
  if (
    norm === 'system admin' ||
    norm === 'system administrator' ||
    norm === 'sys admin' ||
    norm === 'sysadmin' ||
    norm === 'admin' ||
    norm === 'administrator' ||
    norm.includes('system admin') ||
    norm.includes('sys admin')
  ) return false;
  const r = roleByName(roleName, roles);
  if (r?.is_system_admin) return false;
  return r ? !!r.is_employee : true;
}

/** Excludes system accounts, admin service accounts and non-human roles from signing greetings. */
export function isHumanSenderName(name?: string | null, role?: string | null): boolean {
  const n = canonName(name);
  if (
    !n ||
    n === 'system admin' ||
    n === 'system administrator' ||
    n === 'sys admin' ||
    n === 'sysadmin' ||
    n === 'admin' ||
    n === 'administrator' ||
    n.includes('system admin') ||
    n.includes('sys admin')
  ) return false;
  const r = canonName(role);
  if (
    r === 'system admin' ||
    r === 'system administrator' ||
    r === 'sys admin' ||
    r === 'sysadmin' ||
    r === 'admin' ||
    r === 'administrator' ||
    r.includes('system admin') ||
    r.includes('sys admin')
  ) return false;
  return true;
}

/** True only for active human employees eligible to sign greetings. */
export function isHumanSender(p: PersonLite | null | undefined, roles: RoleLite[]): boolean {
  if (!p) return false;
  if (p.is_active === false) return false;
  if (p.is_system_admin === true) return false;
  const full = fullNameOf(p);
  if (!isHumanSenderName(full, p.role)) return false;
  if (p.display_name && !isHumanSenderName(p.display_name, p.role)) return false;
  if (p.name && !isHumanSenderName(p.name, p.role)) return false;
  return isEmployeeRole(p.role, roles);
}

export function isTopManagementRole(roleName: string | null | undefined, roles: RoleLite[]): boolean {
  const r = roleByName(roleName, roles);
  if (!r) return false;
  if (r.category) return r.category === 'top_management';
  return !r.parent_id;
}

// Distance from the tree root (root = 0); cycles and missing parents stop the walk.
export function roleDepth(roleName: string | null | undefined, roles: RoleLite[]): number {
  let cur = roleByName(roleName, roles);
  let depth = 0;
  const seen = new Set<string>();
  while (cur?.parent_id && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    const parent = roles.find(r => r.id === cur!.parent_id);
    if (!parent) break;
    cur = parent;
    depth++;
  }
  return depth;
}

export function occasionsFor(
  p: PersonLite, s: GreetingSettings, today: string, calendar?: HolidayCalendar | null,
): Occasion[] {
  if (!s.enabled || !isActiveOn(p, today)) return [];
  const out: Occasion[] = [];
  if (s.birthday && monthDayMatches(p.date_of_birth, today)) out.push({ kind: 'birthday' });
  const years = s.anniversary ? anniversaryYears(p.date_of_join, today) : null;
  if (years !== null) out.push({ kind: 'anniversary', years });
  if (s.special) {
    for (const d of specialDaysOn(s.special_days, today, calendar)) {
      out.push({
        kind: 'special',
        dayId: d.id,
        title: d.title,
        message: d.message ?? '',
        ...(d.title_si ? { title_si: d.title_si } : {}),
        ...(d.message_si ? { message_si: d.message_si } : {}),
        ...(d.title_ta ? { title_ta: d.title_ta } : {}),
        ...(d.message_ta ? { message_ta: d.message_ta } : {}),
      });
    }
  }
  return out;
}

export function displayNameOf(p: PersonLite): string {
  return (p.display_name || p.first_name || p.epf_number || '').trim();
}

const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'rev', 'prof']);

/**
 * Extracts a person's calling first name from their full name or display name.
 * Skips titles ('Dr.', 'Mr.') and initials ('W', 'W.', 'A.W.K.') so that
 * 'W Supun Manuranga' resolves to 'Supun' rather than 'W'.
 */
export function firstCallingName(rawName: string | null | undefined): string {
  const words = String(rawName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'there';
  for (const w of words) {
    const clean = w.replace(/[.,]/g, '').toLowerCase();
    if (TITLES.has(clean)) continue;
    if (clean.length === 1 || /^[A-Za-z](\.[A-Za-z])*\.?$/.test(w)) continue;
    return w.replace(/[.,]/g, '');
  }
  return words[0] || 'there';
}

export function firstNameOf(p: PersonLite): string {
  const explicit = (p.first_name || '').trim();
  if (explicit && explicit.length > 1 && !TITLES.has(explicit.toLowerCase().replace(/[.,]/g, ''))) {
    return explicit;
  }
  const display = (p.display_name || '').trim();
  if (display) return firstCallingName(display);
  return explicit || 'there';
}

/**
 * The name a greeting addresses someone by, and the name that signs one: the WHOLE name.
 * "Happy birthday, Nimal!" from a company of 300 reads like a mail merge; "Happy birthday,
 * Nimal Silva!" reads like someone meant it. display_name is what every other screen shows,
 * so it leads; first + last rebuilds it for a profile that never had one; the first name
 * alone is the last resort, and only when it is genuinely all this person has.
 */
export function fullNameOf(p: PersonLite): string {
  const display = (p.display_name || '').trim();
  if (display) return display;
  const built = [(p.first_name || '').trim(), (p.last_name || '').trim()].filter(Boolean).join(' ');
  return built || (p.epf_number || '').trim() || 'there';
}

// Signers: active, employee-role, top-management people of the recipient's company, roots
// first then by name; then the recipient's supervisor (if active) when not already there.
// The recipient is never a signer of their own greeting. `cap` keeps the supervisor.
/**
 * The signer list that applies to one recipient, most specific first: their department, then
 * their company, then the default list. Returns undefined when nothing is configured, which is
 * how selectSenders is told to fall back to resolving top management from the role tree.
 *
 * Pure — no clock, no Firestore. The matching is deliberately forgiving on names: a department
 * is free text on a user profile and on this setting, so "Operations " and "operations" are the
 * same department. Company ids are ids and are compared exactly (trimmed).
 */
export function resolveSigners(
  settings: Pick<GreetingSettings, 'signers' | 'signer_groups'> | null | undefined,
  recipient: Pick<PersonLite, 'company_id' | 'department'>,
): string[] | undefined {
  const groups = settings?.signer_groups ?? [];
  const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
  const dept = norm(recipient.department);
  const company = (recipient.company_id ?? '').trim();

  const byDept = dept
    ? groups.find(g => g.scope === 'department' && norm(g.key) === dept && g.signers?.length)
    : undefined;
  if (byDept) return byDept.signers;

  const byCompany = company
    ? groups.find(g => g.scope === 'company' && (g.key ?? '').trim() === company && g.signers?.length)
    : undefined;
  if (byCompany) return byCompany.signers;

  return settings?.signers?.length ? settings.signers : undefined;
}

/**
 * Who signs a greeting, in the order they appear on the card.
 *
 * `signers` is the admin's own list of EPFs and wins when it is set: a greeting should be able
 * to come from named people rather than from whoever the role tree happens to call top
 * management. Someone on the list who has left is skipped rather than named. When the list is
 * empty the recipient's company top management is resolved automatically, which is what a
 * tenant that never touches the setting keeps getting.
 *
 * The recipient's own supervisor is appended either way, and marked, because "your supervisor"
 * is the one signature that differs per person. Nobody ever signs their own card.
 */
export function selectSenders(
  recipient: PersonLite, people: PersonLite[], roles: RoleLite[], cap = 8, signers?: string[],
): Sender[] {
  const company = (recipient.company_id ?? '').trim();
  const picked = (signers ?? [])
    .map(epf => people.find(p => p.epf_number === epf))
    .filter((p): p is PersonLite => !!p && p.epf_number !== recipient.epf_number && isHumanSender(p, roles));
  const tops = picked.length
    ? picked
    : company
      ? people
          .filter(p => p.epf_number !== recipient.epf_number && isHumanSender(p, roles)
            && (p.company_id ?? '').trim() === company
            && isTopManagementRole(p.role, roles))
          .sort((a, b) => (roleDepth(a.role, roles) - roleDepth(b.role, roles)) || displayNameOf(a).localeCompare(displayNameOf(b)))
      : [];
  const toSender = (p: PersonLite, supervisor = false): Sender => ({
    epf: p.epf_number, name: fullNameOf(p), role: p.role ?? '', avatar_url: p.avatar_url ?? null,
    ...(supervisor ? { supervisor: true } : {}),
  });
  const out: Sender[] = tops.map(p => toSender(p));
  const supEpf = (recipient.supervisor_epf ?? '').trim();
  const sup = supEpf && supEpf !== recipient.epf_number ? people.find(p => p.epf_number === supEpf && isHumanSender(p, roles)) : undefined;
  if (sup) {
    const i = out.findIndex(s => s.epf === sup.epf_number);
    if (i >= 0) out[i] = { ...out[i], supervisor: true };
    else out.push(toSender(sup, true));
  }
  const clean = out.filter(s => isHumanSenderName(s.name, s.role));
  if (clean.length <= cap) return clean;
  const supIdx = clean.findIndex(s => s.supervisor);
  const kept = clean.filter((_, i) => i !== supIdx).slice(0, supIdx >= 0 ? cap - 1 : cap);
  if (supIdx >= 0) kept.push(clean[supIdx]);
  return kept;
}

export function occasionKey(o: Occasion): string {
  return o.kind === 'special' ? `special-${o.dayId}` : o.kind;
}

// English copy for the push and the stored title/body. The client re-renders the card from
// meta + i18n; this text is the fallback for push and for older clients.
/**
 * Join names the way a person would write them: "A", "A and B", "A, B and C".
 * `and` is a parameter because the bell renders this line in three languages; the server,
 * which writes English copy for the push, takes the default.
 */
export function joinNames(parts: string[], and = 'and'): string {
  const list = parts.filter(p => p.trim());
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} ${and} ${list[list.length - 1]}`;
}

/**
 * Roughly how much room the signer list gets inside a push body before the platform cuts the
 * text off mid-word without telling anyone. Android collapses a notification body around 240
 * characters and iOS shows less again; the rest of the sentence ("Warm wishes from … Have a
 * wonderful day!") needs its share of that, so the names get this much.
 */
export const PUSH_SIGNER_CHARS = 120;

/**
 * Name the signers in a sentence. Every one of them, by name — no "+2", no "and 3 others".
 * A count tells the reader nothing they wanted to know; a greeting is worth the words.
 *
 * The supervisor leads, because they are the one signature that is personal to THIS
 * recipient and `maxChars` drops names from the END. When the list will not fit a push body
 * whole names come off the tail and nothing is said about them — the card the notification
 * opens lists everyone, which is where the full answer belongs. `maxChars <= 0` means no cap,
 * which is what the bell and the card use.
 */
export function signerSentence(senders: Sender[], brand: string, maxChars = 0, and = 'and'): string {
  const named = senders.filter(s => s.name.trim() && isHumanSenderName(s.name, s.role));
  // Honest, not vague: we could not resolve anyone, so we do not claim the whole company signed it.
  if (!named.length) return `your team at ${brand}`;
  const ordered = [...named.filter(s => s.supervisor), ...named.filter(s => !s.supervisor)];
  const labels = ordered.map(s => (s.supervisor ? `your supervisor ${s.name}` : s.name));
  if (maxChars > 0) {
    // A single name that is already too long still ships: a truncated name is worse than a
    // long one, and there is nothing shorter left to say.
    while (labels.length > 1 && joinNames(labels, and).length > maxChars) labels.pop();
  }
  return joinNames(labels, and);
}

/** The most a greeting body may be. This same sentence is the lock-screen push, and past
 *  roughly this many characters both iOS and Android cut it — a truncated sentence reads worse
 *  than a shorter list of signers, so the list is what gives way. */
export const PUSH_BODY_CHARS = PUSH_SIGNER_CHARS + 60;

/**
 * Who the greeting is from, with the organisation named — "your supervisor Eve and Ann at
 * PearlCluster". The brand belongs in the sentence: a greeting that never says which company
 * sent it is exactly as impersonal as the template it replaced. It is appended only when real
 * people are named, because the no-signer fallback already ends in the brand.
 */
export function fromPhrase(senders: Sender[], brand: string, and = 'and'): string {
  const named = (senders ?? []).filter(s => s.name.trim() && isHumanSenderName(s.name, s.role));
  if (!named.length) return `your team at ${brand}`;
  return `${signerSentence(named, brand, 0, and)} at ${brand}`;
}

/** Which line of the pool this greeting draws. See greetingVariants.ts for why it is a seed
 *  and not a random pick. `key` is the person (their EPF), `year` the year being greeted. */
export interface GreetingSeed { key: string; year: number }

/** The reader's calling first name from the full name the card is addressed to. */
function firstWordOf(name: string): string {
  return firstCallingName(name);
}

export function greetingCopy(
  o: Occasion, name: string, brand: string, senders: Sender[] = [], seed?: GreetingSeed,
  lang: GreetingLang = 'en',
): { title: string; body: string; variant?: { pool: PoolName; index: number; from: string } } {
  const title = o.kind === 'birthday'    ? `🎂 Happy birthday, ${name}!`
              : o.kind === 'anniversary' ? `🏅 ${o.years} ${o.years === 1 ? 'year' : 'years'} with us, ${name}!`
              : o.title;

  const validSenders = senders.filter(s => isHumanSenderName(s.name, s.role));

  // Someone wrote this person something. Their words are the body and the generic company line
  // drops — a manager who took the time to write is not appended to a template. Their name is
  // kept because this same text is the lock-screen push, where nothing else says who wrote it.
  const personal = validSenders.find(s => (s.message ?? '').trim());
  if (personal) return { title, body: `${(personal.message ?? '').trim()} — ${personal.name}` };

  // An admin's own words for a special day outrank ours, for the same reason.
  if (o.kind === 'special' && o.message?.trim()) return { title, body: o.message.trim() };

  // Supervisors lead, as they do everywhere else on the card, and the tail of the list is what
  // gets dropped when the sentence would overrun a push body.
  const named = validSenders.filter(s => s.name.trim());
  const ordered = [...named.filter(s => s.supervisor), ...named.filter(s => !s.supervisor)];
  const ctx = {
    first: firstWordOf(name),
    from: '',
    brand,
    years: o.kind === 'anniversary' ? o.years : 0,
    title: o.kind === 'special' ? o.title : '',
  };
  const key  = seed?.key ?? name;
  const year = seed?.year ?? 0;

  let body = '';
  let from = '';
  for (let n = Math.max(ordered.length, 1); n >= 1; n--) {
    from = fromPhrase(ordered.slice(0, n), brand);
    body = greetingBodyVariant(o, { ...ctx, from }, key, year, lang);
    if (body.length <= PUSH_BODY_CHARS || n === 1) break;
  }
  // Which line this was. Stored on the notification so every device can render the SAME line
  // from its own reader's pool (see variantByName) — one send, three languages. `from` travels
  // with it because it is the signer phrase this body actually used after the tail was trimmed
  // to fit a push; a device rebuilding it could disagree with what the lock screen said.
  return {
    title, body,
    variant: { pool: poolNameFor(o), index: variantIndex(key, year, poolFor(o).length), from },
  };
}
