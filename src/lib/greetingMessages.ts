// Personal greetings — who may write one, whose card it reaches, and how the words come out.
//
// Pure: no firebase, no React, no clock. The API routes, the daily cron job and the composer in
// the bell all import this, which is the point — authorship is the one rule in this feature that
// must not be decided twice. Firestore rules cannot decide it at all (every can*() helper in
// this codebase reduces to isAuth(), so a client-writable collection would let any signed-in
// user publish a greeting signed by the CEO), so the server re-evaluates canAuthor() on every
// write and this module is what it evaluates.
//
// "Under their supervision" here means the transitive supervisor_epf closure, not the direct
// reports: a manager two levels up is still your manager, and that is how the org reads it.

import {
  firstNameOf, fullNameOf, isEmployeeRole, isHumanSender, isHumanSenderName, isTopManagementRole, roleDepth, tenureYears,
  type Occasion, type OccasionKind, type PersonLite, type RoleLite, type Sender,
} from './greetings';
import { variantIndex } from './greetingVariants';

/** Who a message is written for. */
export type GreetingAudience = 'everyone' | 'my_team' | 'person';

export interface GreetingMessage {
  id: string;
  author_epf: string;
  /** Snapshotted at write time and refreshed on every edit, so a card signed last year still
   *  reads correctly after the author changes role. */
  author_name: string;
  author_role: string;
  author_avatar_url: string | null;
  audience: GreetingAudience;
  /** Set only when audience === 'person'. */
  target_epf: string | null;
  occasions: OccasionKind[];
  /** Only consulted when `occasions` includes 'special'. Empty means every special day. */
  special_day_ids: string[];
  /**
   * The author's own words, per occasion — the one thing the recipient actually reads. Never
   * translated.
   *
   * A SET of wordings per occasion, not one string, and that is the whole point. One string
   * meant all 112 people read the identical sentence on the one day of the year the note is
   * supposed to be about the reader; which wording a person gets is now a pure function of who
   * they are and which year it is (see renderMessage). Write one and you get the old
   * behaviour — the change costs nothing to ignore.
   */
  messages?: GreetingWordings;
  /**
   * LEGACY. Rows written before wordings became per-occasion carry a single string here.
   * Read through normalizeMessages(), never directly — new rows do not set it.
   */
  message?: string;
  /** Optional Sinhala translation of the message. */
  message_si?: string;
  /** Optional Tamil translation of the message. */
  message_ta?: string;
  enabled: boolean;
}

/**
 * Which occasion a set of wordings belongs to.
 *
 * `special` is the every-special-day slot and `special:<dayId>` one named festival. Both exist
 * deliberately: keying only by day id would mean a message written for "every special day"
 * silently stopped covering any festival an admin added afterwards.
 */
export type OccasionSlot = 'birthday' | 'anniversary' | 'special' | `special:${string}`;

/** Wordings by slot. Every entry is a non-empty, trimmed alternate. */
export type GreetingWordings = Partial<Record<OccasionSlot, string[]>>;

/**
 * How many alternate wordings one occasion may carry. Enough to stop a company-wide note
 * reading as one sentence, few enough that a person will actually write them all.
 */
export const GREETING_VARIANTS_MAX = 5;

/** The slots to try for an occasion, MOST SPECIFIC FIRST. */
export function slotsFor(occasion: Occasion): OccasionSlot[] {
  if (occasion.kind === 'special') return [`special:${occasion.dayId}`, 'special'];
  return [occasion.kind];
}

const cleanLines = (v: unknown): string[] => {
  const arr = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const x of arr) {
    const s = String(x ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= GREETING_VARIANTS_MAX) break;
  }
  return out;
};

/**
 * The wordings map for a message, whichever shape it was stored in.
 *
 * A legacy single string is expanded onto every occasion the row was ticked for, so an old row
 * keeps behaving exactly as it did. Reading through this rather than migrating the collection
 * in one pass is deliberate: `greeting_messages` is read by the daily job, and a half-migrated
 * collection must not be able to drop somebody's birthday.
 */
export function normalizeMessages(msg: GreetingMessage | null | undefined): GreetingWordings {
  const out: GreetingWordings = {};
  for (const [slot, lines] of Object.entries(msg?.messages ?? {})) {
    const clean = cleanLines(lines);
    if (clean.length) out[slot as OccasionSlot] = clean;
  }
  if (Object.keys(out).length) return out;

  const legacy = cleanLines(msg?.message);
  if (!legacy.length) return out;
  for (const kind of msg?.occasions ?? []) {
    if (kind !== 'special') { out[kind] = legacy; continue; }
    const dayIds = msg?.special_day_ids ?? [];
    // No day ids on a legacy special message meant "every special day" — same as it does now.
    if (!dayIds.length) out.special = legacy;
    else for (const id of dayIds) out[`special:${id}`] = legacy;
  }
  return out;
}

/** The wordings this author offers for this occasion, or none if they wrote nothing for it. */
export function wordingsFor(msg: GreetingMessage, occasion: Occasion): string[] {
  const map = normalizeMessages(msg);
  for (const slot of slotsFor(occasion)) {
    const lines = map[slot];
    if (lines?.length) return lines;
  }
  // A legacy row whose slots do not cover this occasion still has words for it. Whether the
  // message applies at all was already decided by messagesFor() before we got here — this
  // function must not second-guess that and silently render an empty card. Only legacy rows
  // reach this: once `messages` exists, its slots are the whole answer.
  if (!msg?.messages) return cleanLines(msg?.message);
  return [];
}

/** The recipient reads every character of this, so it is capped where a card still reads well. */
export const GREETING_MESSAGE_MAX = 500;

export const GREETING_AUDIENCES: readonly GreetingAudience[] = ['everyone', 'my_team', 'person'];

export function isGreetingAudience(v: unknown): v is GreetingAudience {
  return v === 'everyone' || v === 'my_team' || v === 'person';
}

/**
 * Everyone below `epf` in the supervisor tree, transitively.
 *
 * Cycle-safe by construction: a person is added at most once and only walked when newly added,
 * so a supervisor loop (A reports to B reports to A — real data has them) terminates instead of
 * hanging the request. `epf` itself is never in the result even if the data says they report to
 * themselves or to one of their own reports.
 */
export function subordinateEpfsOf(epf: string, people: PersonLite[]): Set<string> {
  const out = new Set<string>();
  const root = String(epf ?? '').trim();
  if (!root) return out;

  const bySupervisor = new Map<string, string[]>();
  for (const p of people) {
    const sup = String(p.supervisor_epf ?? '').trim();
    const own = String(p.epf_number ?? '').trim();
    if (!sup || !own) continue;
    const list = bySupervisor.get(sup);
    if (list) list.push(own); else bySupervisor.set(sup, [own]);
  }

  const queue: string[] = [root];
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const child of bySupervisor.get(cur) ?? []) {
      if (child === root || out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

/** Facts about the author that live outside the people/roles data. */
export interface AuthorCtx {
  /** A system admin may write for everyone regardless of their role's category — they sign as
   *  themselves, not as "the company". Resolved from role capabilities by the caller. */
  systemAdmin?: boolean;
}

/** May this author write for this audience? The server asks this on every write. */
export function canAuthor(
  author: PersonLite | null | undefined,
  audience: GreetingAudience,
  targetEpf: string | null,
  people: PersonLite[],
  roles: RoleLite[],
  ctx: AuthorCtx = {},
): boolean {
  const epf = String(author?.epf_number ?? '').trim();
  if (!epf || !author) return false;
  // Top management writes in the company's name; System Admin and Admin are not employee roles
  // and would otherwise qualify as tree roots, so the employee check is load-bearing. An admin
  // still gets here through ctx.systemAdmin.
  const forEveryone = !!ctx.systemAdmin
    || (isTopManagementRole(author.role, roles) && isEmployeeRole(author.role, roles));

  switch (audience) {
    case 'everyone':
      return forEveryone;
    case 'my_team':
      // Literally "the people under me" — with nobody under them there is no team to write to,
      // whatever the author's rank.
      return subordinateEpfsOf(epf, people).size > 0;
    case 'person': {
      const target = String(targetEpf ?? '').trim();
      // Nobody writes their own card, including an admin who could write for everyone.
      if (!target || target === epf) return false;
      return forEveryone || subordinateEpfsOf(epf, people).has(target);
    }
    default:
      return false;
  }
}

/** The audiences this author may choose from, in the order a composer should offer them. */
export function allowedAudiencesFor(
  author: PersonLite | null | undefined, people: PersonLite[], roles: RoleLite[], ctx: AuthorCtx = {},
): GreetingAudience[] {
  const epf = String(author?.epf_number ?? '').trim();
  if (!epf || !author) return [];
  const out: GreetingAudience[] = [];
  if (canAuthor(author, 'everyone', null, people, roles, ctx)) out.push('everyone');
  if (canAuthor(author, 'my_team', null, people, roles, ctx)) out.push('my_team');
  // 'person' needs a target to be decided, so it is asked structurally instead: anyone who can
  // reach everyone can pick anyone, and anyone with reports can pick one of them.
  if (out.includes('everyone') || subordinateEpfsOf(epf, people).size > 0) out.push('person');
  return out;
}

/**
 * The people this author may address one by one — exactly the list a picker may show.
 * A picker that offers someone the server will refuse is a lie told twice, so both read this.
 */
export function targetablePeopleOf(
  author: PersonLite | null | undefined, people: PersonLite[], roles: RoleLite[], ctx: AuthorCtx = {},
): PersonLite[] {
  const epf = String(author?.epf_number ?? '').trim();
  if (!epf || !author) return [];
  const active = (p: PersonLite) => p.is_active !== false;
  if (canAuthor(author, 'everyone', null, people, roles, ctx)) {
    return people.filter(p => {
      const e = String(p.epf_number ?? '').trim();
      return !!e && e !== epf && active(p);
    });
  }
  const team = subordinateEpfsOf(epf, people);
  return people.filter(p => team.has(String(p.epf_number ?? '').trim()) && active(p));
}

// A more specific audience is a more deliberate message: a note written for you personally
// outranks one written for your team, which outranks one written for the whole company.
const SPECIFICITY: Record<GreetingAudience, number> = { person: 3, my_team: 2, everyone: 1 };

/**
 * The personal messages that belong on ONE recipient's card for ONE occasion, in the order they
 * should appear: role depth first (roots lead), then by the author's name.
 *
 * One message per author — the most specific one they wrote — because an executive who has both
 * a team note and a personal note for someone meant the personal one.
 */
export function messagesFor(
  recipient: PersonLite, occasion: Occasion, messages: GreetingMessage[],
  people: PersonLite[], roles: RoleLite[],
): GreetingMessage[] {
  const rEpf = String(recipient?.epf_number ?? '').trim();
  if (!rEpf) return [];
  const kind = occasion.kind;
  const dayId = occasion.kind === 'special' ? occasion.dayId : '';

  const personByEpf = new Map<string, PersonLite>();
  for (const p of people ?? []) {
    const epf = String(p?.epf_number ?? '').trim();
    if (epf) personByEpf.set(epf, p);
  }
  const personOf = (epf: string): PersonLite | undefined => personByEpf.get(epf);

  // One closure per author per call: messagesFor runs once per recipient per occasion, and a
  // company-wide message would otherwise re-walk the whole tree for every employee.
  const cache = new Map<string, Set<string>>();
  const closureOf = (epf: string): Set<string> => {
    let c = cache.get(epf);
    if (!c) { c = subordinateEpfsOf(epf, people); cache.set(epf, c); }
    return c;
  };

  const applicable = (messages ?? []).filter(m => {
    if (!m || m.enabled === false) return false;
    if (!(m.occasions ?? []).includes(kind)) return false;
    if (kind === 'special' && (m.special_day_ids ?? []).length > 0
      && !m.special_day_ids.includes(dayId)) return false;
    const author = String(m.author_epf ?? '').trim();
    if (!author || author === rEpf) return false;   // nobody signs their own card
    const authorPerson = personOf(author);
    if (authorPerson && !isHumanSender(authorPerson, roles)) return false;
    if (!isHumanSenderName(m.author_name, m.author_role)) return false;
    switch (m.audience) {
      case 'person':   return String(m.target_epf ?? '').trim() === rEpf;
      case 'my_team':  return closureOf(author).has(rEpf);
      case 'everyone': return true;
      default:         return false;
    }
  });

  const best = new Map<string, GreetingMessage>();
  for (const m of applicable) {
    const cur = best.get(m.author_epf);
    if (!cur || SPECIFICITY[m.audience] > SPECIFICITY[cur.audience]) best.set(m.author_epf, m);
  }

  return [...best.values()].sort((a, b) => {
    // The live role wins over the snapshot: the snapshot is for display after someone leaves.
    const da = roleDepth(personOf(a.author_epf)?.role ?? a.author_role, roles);
    const db = roleDepth(personOf(b.author_epf)?.role ?? b.author_role, roles);
    return (da - db) || String(a.author_name ?? '').localeCompare(String(b.author_name ?? ''));
  });
}

/**
 * The author's words for this recipient, with their placeholders filled in. Three are supported
 * and they are the only interpolation this feature has: {name} (full name), {first_name},
 * {years}. Anything else in the message is the author's own text and is left exactly as typed.
 *
 * WHICH wording, when the author offered several: a pure function of the recipient's EPF and
 * the year, using the same picker the built-in line pool uses (variantIndex). Deterministic on
 * purpose — the notification doc, the push and the card are three separate writes of the same
 * words, and a random pick would let them disagree. Because the year is added rather than
 * hashed, nobody reads the same wording two years running.
 */
export function renderMessage(
  msg: GreetingMessage, recipient: PersonLite, occasion: Occasion, today?: string, lang?: 'en' | 'si' | 'ta',
): string {
  // {years} is never typed by hand. On an anniversary it is the number the occasion already
  // carries; on a birthday or a festival it is how long they have been here, counted from
  // date_of_join — which is the only place that number is allowed to come from. With no date
  // to count from it renders empty rather than as a zero nobody meant.
  const tenure = today ? tenureYears(recipient?.date_of_join, today) : null;
  const years = occasion.kind === 'anniversary' ? String(occasion.years)
    : tenure != null ? String(tenure) : '';

  // Localized wording if requested and present
  if (lang === 'si' && msg.message_si?.trim()) {
    return msg.message_si
      .replace(/\{first_name\}/g, firstNameOf(recipient))
      .replace(/\{name\}/g, fullNameOf(recipient))
      .replace(/\{years\}/g, years);
  }
  if (lang === 'ta' && msg.message_ta?.trim()) {
    return msg.message_ta
      .replace(/\{first_name\}/g, firstNameOf(recipient))
      .replace(/\{name\}/g, fullNameOf(recipient))
      .replace(/\{years\}/g, years);
  }

  const wordings = wordingsFor(msg, occasion);
  if (!wordings.length) return '';
  // Keyed on the reader, not the author: two people reading the same company-wide note on the
  // same day should not read the same sentence.
  const chosen = wordings[variantIndex(
    String(recipient?.epf_number ?? ''),
    Number(today?.slice(0, 4)) || 0,
    wordings.length,
  )];

  return chosen
    .replace(/\{first_name\}/g, firstNameOf(recipient))
    .replace(/\{name\}/g, fullNameOf(recipient))
    .replace(/\{years\}/g, years);
}

/**
 * The card's signature list: the configured signers, plus the authors of the personal messages
 * that apply, with the authors first.
 *
 * An author who wrote a note but is not among the admin's signers is ADDED, not dropped — an
 * executive who wrote for their own team member has to appear on that card, or their words
 * arrive unsigned. An author who IS a signer keeps their signer entry (its live role, avatar and
 * supervisor mark) and gains the message.
 */
export function mergeSenders(
  signers: Sender[], authored: Array<{ msg: GreetingMessage; text: string; text_si?: string; text_ta?: string }>,
): Sender[] {
  const out: Sender[] = [];
  const used = new Set<string>();
  for (const a of authored) {
    const epf = String(a?.msg?.author_epf ?? '').trim();
    const text = String(a?.text ?? '').trim();
    const text_si = a?.text_si ? String(a.text_si).trim() : (a?.msg?.message_si ? String(a.msg.message_si).trim() : undefined);
    const text_ta = a?.text_ta ? String(a.text_ta).trim() : (a?.msg?.message_ta ? String(a.msg.message_ta).trim() : undefined);
    if (!epf || (!text && !text_si && !text_ta) || used.has(epf)) continue;
    if (!isHumanSenderName(a?.msg?.author_name, a?.msg?.author_role)) continue;
    used.add(epf);
    const existing = (signers ?? []).find(s => s.epf === epf);
    out.push(existing
      ? { ...existing, message: text || text_si || text_ta, message_si: text_si, message_ta: text_ta }
      : {
        epf,
        name: a.msg.author_name || epf,
        role: a.msg.author_role || '',
        avatar_url: a.msg.author_avatar_url ?? null,
        message: text || text_si || text_ta,
        message_si: text_si,
        message_ta: text_ta,
      });
  }
  for (const s of signers ?? []) {
    const epf = String(s?.epf ?? '').trim();
    if (!epf || used.has(epf)) continue;
    if (!isHumanSenderName(s.name, s.role)) continue;
    used.add(epf);
    out.push(s);
  }
  return out;
}

/**
 * How many people a message would reach — the number a composer shows before anyone sends.
 *
 * Counts by `is_active` alone and never by a resign date, because this module has no clock;
 * the daily job re-checks who is actually active on the morning it sends.
 */
export function reachOf(
  audience: GreetingAudience, author: PersonLite, targetEpf: string | null, people: PersonLite[],
): number {
  const epf = String(author?.epf_number ?? '').trim();
  const active = (p: PersonLite) => p.is_active !== false;
  switch (audience) {
    case 'everyone':
      return people.filter(p => {
        const e = String(p.epf_number ?? '').trim();
        return !!e && e !== epf && active(p);
      }).length;
    case 'my_team': {
      const team = subordinateEpfsOf(epf, people);
      return people.filter(p => team.has(String(p.epf_number ?? '').trim()) && active(p)).length;
    }
    case 'person': {
      const target = String(targetEpf ?? '').trim();
      return target && target !== epf ? 1 : 0;
    }
    default:
      return 0;
  }
}
