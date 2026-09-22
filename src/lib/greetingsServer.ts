// Admin-SDK half of the greetings feature, shared by the daily cron route and the admin test
// route. Server-only: imports firebase-admin, never the client SDK.
import type { DocumentData, DocumentReference, Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { sendServerPush } from '@/lib/serverPush';
import { draftGreetingBody } from '@/lib/greetingAi';
import {
  DEFAULT_GREETING_SETTINGS, greetingCopy, firstNameOf, fromPhrase, fullNameOf, isHumanSenderName, occasionKey,
  isActiveOn, isEmployeeRole, occasionsFor, resolveSigners, selectSenders,
  type GreetingSettings, type Occasion, type OccasionKind, type PersonLite, type RoleLite,
  type Sender, type SpecialDay, type SignerGroup, type SpecialDayMode,
} from '@/lib/greetings';
import {
  GREETING_MESSAGE_MAX, GREETING_VARIANTS_MAX, isGreetingAudience, mergeSenders, messagesFor, renderMessage,
  type GreetingMessage, type GreetingWordings, type OccasionSlot,
} from '@/lib/greetingMessages';

export type PersonDoc = { ref: DocumentReference; data: PersonLite & DocumentData };

// Users are keyed by EPF; '/' is not allowed in a doc id (same helper as the other jobs).
export function epfDocId(epf: string): string {
  return epf.includes('/') ? epf.replace(/\//g, '%2F') : epf;
}

// 'YYYY-MM-DD' in Asia/Colombo, whatever the server's own zone is.
export function colomboToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * Hour of the day, 0-23, in Asia/Colombo.
 *
 * Read on the SERVER on purpose. The catch-up path is triggered by a browser, and a device
 * clock is whatever its owner set it to — a phone an hour fast would otherwise send everyone's
 * greeting an hour early, and one set to yesterday would re-open a day that is already closed.
 */
export function colomboHour(): number {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Colombo', hour: '2-digit', hour12: false,
  }).format(new Date()));
}

/** The hour the daily job is scheduled for — 08:00, per netlify/functions/greetings-daily.mjs. */
export const GREETING_SEND_HOUR = 8;

export async function loadGreetingSettings(db: Firestore): Promise<GreetingSettings> {
  const snap = await db.collection('settings').doc('greetings').get();
  if (!snap.exists) return { ...DEFAULT_GREETING_SETTINGS };
  const d = snap.data() ?? {};
  const days = Array.isArray(d.special_days) ? d.special_days : [];
  return {
    enabled: d.enabled === true,
    birthday: d.birthday !== false,
    anniversary: d.anniversary !== false,
    special: d.special !== false,
    signers: Array.isArray(d.signers) ? d.signers.map((x: unknown) => String(x ?? '')).filter(Boolean) : [],
    // Scoped signer lists. Read back with the same shape the PUT stores, or a department's own
    // list would be written once and never seen again: the settings screen, the cron and the
    // test route all resolve signers from what THIS function returns.
    signer_groups: (Array.isArray(d.signer_groups) ? d.signer_groups : [])
      .map((x: Partial<SignerGroup>): SignerGroup => ({
        scope: x.scope === 'company' ? 'company' : 'department',
        key: String(x.key ?? ''),
        signers: (Array.isArray(x.signers) ? x.signers : []).map((s: unknown) => String(s ?? '')).filter(Boolean),
      }))
      .filter((g: SignerGroup) => g.key.trim() !== '' && g.signers.length > 0),
    special_days: days.map((x: Partial<SpecialDay>) => ({
      id: String(x.id ?? ''), title: String(x.title ?? ''), message: String(x.message ?? ''),
      date: String(x.date ?? ''), enabled: x.enabled !== false,
      ...(x.title_si ? { title_si: String(x.title_si) } : {}),
      ...(x.message_si ? { message_si: String(x.message_si) } : {}),
      ...(x.title_ta ? { title_ta: String(x.title_ta) } : {}),
      ...(x.message_ta ? { message_ta: String(x.message_ta) } : {}),
      // mode / calendar_name / dates_by_year survive the round trip too. The PUT answers with
      // this function's output and the settings screen adopts it, so dropping them here turned
      // a saved calendar-linked day back into a plain dated one the moment it was saved.
      ...(x.mode === 'annual' || x.mode === 'once' || x.mode === 'calendar' ? { mode: x.mode as SpecialDayMode } : {}),
      ...(x.calendar_name ? { calendar_name: String(x.calendar_name) } : {}),
      ...(x.dates_by_year && typeof x.dates_by_year === 'object'
        ? { dates_by_year: Object.fromEntries(
            Object.entries(x.dates_by_year as Record<string, unknown>).map(([y, v]) => [y, String(v ?? '')]),
          ) }
        : {}),
    })),
    updated_at: d.updated_at, updated_by: d.updated_by, updated_by_name: d.updated_by_name,
  };
}

export async function loadPeopleAndRoles(db: Firestore): Promise<{ people: PersonDoc[]; roles: RoleLite[] }> {
  const [usersSnap, rolesSnap] = await Promise.all([db.collection('users').get(), db.collection('roles').get()]);
  const people = usersSnap.docs
    .map(d => ({ ref: d.ref, data: d.data() as PersonLite & DocumentData }))
    .filter(p => typeof p.data.epf_number === 'string' && p.data.epf_number);
  const roles = rolesSnap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<RoleLite, 'id'>) }));
  return { people, roles };
}

export function greetingDocId(epf: string, occasion: Occasion, year: string, test = false): string {
  const base = `greet-${occasionKey(occasion)}-${epfDocId(epf)}-${year}`;
  return test ? `${base}-test-${Date.now()}` : base;
}

// Marker id per occasion. Birthdays keep the legacy collection + id so the old Cloud Function
// (if it is still deployed) and this job can never both send.
function markerRef(db: Firestore, epf: string, occasion: Occasion, year: string): DocumentReference {
  const safe = epfDocId(epf);
  if (occasion.kind === 'birthday') return db.collection('birthday_sent').doc(`${safe}-${year}`);
  return db.collection('greetings_sent').doc(`${occasionKey(occasion)}-${safe}-${year}`);
}

export interface DeliverCtx { brand: string; originUrl?: string }
export interface DeliverOpts { claimMarker: boolean; test?: boolean; today: string }

// Claim the marker (unless a test), write the bell doc with a deterministic id, push
// best-effort. Never throws: the caller counts the outcome and moves on.
export async function deliverGreeting(
  db: Firestore, ctx: DeliverCtx, recipient: PersonDoc, occasion: Occasion, senders: Sender[], opts: DeliverOpts,
): Promise<'sent' | 'skipped' | 'failed'> {
  const epf = String(recipient.data.epf_number);
  const year = opts.today.slice(0, 4);
  const cleanSenders = (senders ?? []).filter(s => isHumanSenderName(s.name, s.role));
  try {
    if (opts.claimMarker) {
      try {
        await markerRef(db, epf, occasion, year).create({ epf, year, occasion: occasionKey(occasion), created_at: FieldValue.serverTimestamp() });
      } catch {
        return 'skipped';   // already delivered this year
      }
    }
    const docId = greetingDocId(epf, occasion, year, !!opts.test);
    // Full name, everywhere. A greeting addressed to "Nimal" from a company of 300 reads like
    // a mail merge; naming someone in full is the whole point of naming them at all. This same
    // title and body are what the lock-screen push shows, so the push is named too.
    const name = fullNameOf(recipient.data);
    // The line the pool would write, and the seed that keeps it stable: the same person and
    // year always draw the same sentence, so the doc, the push and the card agree.
    const written = greetingCopy(occasion, name, ctx.brand, cleanSenders, { key: epf, year: Number(year) });
    const title = written.title;

    // Whose words these are, in priority order:
    //   1. a colleague who wrote something for them   — never touched, by anyone
    //   2. the admin's own text for a special day      — likewise
    //   3. Gemini, when it is configured and in budget
    //   4. the hand-written pool
    // The AI only ever stands in for (4). It is best-effort by construction: draftGreetingBody
    // returns null on a missing key, a spent budget, a timeout or an answer that came back
    // unusable, and the pool line is already sitting in `written.body` waiting for it.
    const personal   = cleanSenders.some(s => (s.message ?? '').trim());
    const adminWrote = occasion.kind === 'special' && !!occasion.message?.trim();
    let body = written.body;
    let copySource: 'personal' | 'admin' | 'ai' | 'pool' = personal ? 'personal' : adminWrote ? 'admin' : 'pool';
    if (!personal && !adminWrote) {
      const ai = await draftGreetingBody({
        occasion:   occasion.kind,
        name,
        first:      firstNameOf(recipient.data),
        brand:      ctx.brand,
        from:       fromPhrase(cleanSenders, ctx.brand),
        years:      occasion.kind === 'anniversary' ? occasion.years : undefined,
        title:      occasion.kind === 'special' ? occasion.title : undefined,
        role:       recipient.data.role ?? undefined,
        department: recipient.data.department ?? undefined,
      });
      if (ai) { body = ai; copySource = 'ai'; }
    }
    const link = `/dashboard?greeting=${docId}`;
    const meta: Record<string, string> = {
      occasion: occasion.kind,
      // Which of the four writers produced `body`. Purely diagnostic: nothing renders it, and
      // it is the only way to tell an AI line from a pool line after the fact.
      copy_source: copySource,
      // The FULL name the greeting is addressed to. `title`/`body` above already carry it, but
      // they are English: the bell and the card re-render in the reader's language and need the
      // name as a value, not embedded in a sentence they cannot translate.
      name,
      brand: ctx.brand,
      senders: JSON.stringify(cleanSenders),
      // Which pool line this is, and the signer phrase it used — but ONLY when the pool is what
      // actually wrote the body. Every language's pool holds the same lines in the same order,
      // so a device renders this index from its own reader's pool and everybody gets the same
      // greeting in their own language, from one send (see variantByName).
      //
      // Deliberately absent for an AI line, a colleague's words or an admin's own text: those
      // exist in one language only, and localizing an index whose line never went out would put
      // different words on the card than on the lock screen.
      ...(copySource === 'pool' && written.variant ? {
        pool:    written.variant.pool,
        variant: String(written.variant.index),
        from:    written.variant.from,
      } : {}),
      ...(occasion.kind === 'special' ? {
        special_title: occasion.title,
        special_message: occasion.message ?? '',
        day_id: occasion.dayId,
        ...(occasion.title_si ? { special_title_si: occasion.title_si } : {}),
        ...(occasion.message_si ? { special_message_si: occasion.message_si } : {}),
        ...(occasion.title_ta ? { special_title_ta: occasion.title_ta } : {}),
        ...(occasion.message_ta ? { special_message_ta: occasion.message_ta } : {}),
      } : {}),
      ...(opts.test ? { test: '1' } : {}),
    };
    await db.collection('notifications').doc(docId).set({
      to_epf: epf, audience: null, type: 'greeting', actor_epf: null, actor_name: ctx.brand,
      meta, title, body, link, read: false, created_at: FieldValue.serverTimestamp(),
    });
    await sendServerPush([recipient], { type: 'greeting', title, body, link, tag: docId, originUrl: ctx.originUrl });
    return 'sent';
  } catch (e) {
    console.error('[greetings] delivery failed for', epf, occasionKey(occasion), e);
    return 'failed';
  }
}


// ─── Personal greeting messages ───────────────────────────────────────────────
// `greeting_messages` is written only by /api/greetings/messages (see greetingMessages.ts for
// why it cannot be a client-writable collection). Everything that reads it — the daily job and
// the composer's own route — comes through here, so one broken document can never mean two
// different things in two places.

const OCCASION_KINDS: readonly OccasionKind[] = ['birthday', 'anniversary', 'special'];

/**
 * The stored `messages` map, defensively. A document is not a type: anything that is not a slot
 * pointing at usable strings is dropped rather than trusted, because this runs in the daily job
 * where one malformed row must not take the whole send down.
 */
function readWordings(raw: unknown): GreetingWordings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: GreetingWordings = {};
  for (const [slot, value] of Object.entries(raw as Record<string, unknown>)) {
    const lines: string[] = [];
    for (const x of (Array.isArray(value) ? value : [value])) {
      const line = String(x ?? '').trim();
      if (line && !lines.includes(line)) lines.push(line.slice(0, GREETING_MESSAGE_MAX));
      if (lines.length >= GREETING_VARIANTS_MAX) break;
    }
    if (lines.length) out[slot as OccasionSlot] = lines;
  }
  return out;
}

/** One stored document as the engine's type, or null when it is too broken to use. */
export function normalizeGreetingMessage(id: string, d: DocumentData): GreetingMessage | null {
  const authorEpf = String(d.author_epf ?? '').trim();

  // Two stored shapes. Current rows carry `messages` — a set of wordings per occasion, which is
  // what stops all 112 employees reading the identical sentence. Rows written before that carry
  // a single `message` string. Requiring `message` alone rejected every NEW row as broken and
  // silently dropped the greeting, so accept either and let normalizeMessages() reconcile them
  // downstream.
  const message = String(d.message ?? '').trim();
  const messages = readWordings(d.messages);
  const hasWords = !!message || Object.keys(messages).length > 0;
  if (!id || !authorEpf || !hasWords || !isGreetingAudience(d.audience)) return null;
  const occasions = (Array.isArray(d.occasions) ? d.occasions : [])
    .map((x: unknown) => String(x ?? ''))
    .filter((x: string): x is OccasionKind => (OCCASION_KINDS as readonly string[]).includes(x));
  if (!occasions.length) return null;
  const target = String(d.target_epf ?? '').trim();
  // A 'person' message with no target reaches nobody; treating it as a company-wide one would
  // be the worst possible guess, so it is dropped instead.
  if (d.audience === 'person' && !target) return null;
  return {
    id,
    author_epf: authorEpf,
    author_name: String(d.author_name ?? authorEpf),
    author_role: String(d.author_role ?? ''),
    author_avatar_url: typeof d.author_avatar_url === 'string' && d.author_avatar_url ? d.author_avatar_url : null,
    audience: d.audience,
    target_epf: d.audience === 'person' ? target : null,
    occasions,
    special_day_ids: (Array.isArray(d.special_day_ids) ? d.special_day_ids : [])
      .map((x: unknown) => String(x ?? '').trim()).filter(Boolean),
    ...(Object.keys(messages).length ? { messages } : {}),
    // Only carried forward when it is actually there — writing an empty string back would make
    // a wordings-only row look like a legacy row with a blank note.
    ...(message ? { message: message.slice(0, GREETING_MESSAGE_MAX) } : {}),
    ...(typeof d.message_si === 'string' && d.message_si.trim() ? { message_si: d.message_si.trim().slice(0, GREETING_MESSAGE_MAX) } : {}),
    ...(typeof d.message_ta === 'string' && d.message_ta.trim() ? { message_ta: d.message_ta.trim().slice(0, GREETING_MESSAGE_MAX) } : {}),
    enabled: d.enabled !== false,
  };
}

/**
 * Every personal greeting message in this tenant, or only one author's.
 *
 * Deliberately no `where('enabled', '==', true)` beside the author filter and no orderBy: a
 * second field in a query is what turns a working route into a FAILED_PRECONDITION asking for a
 * composite index the moment it ships. The collection is small (one row per author per
 * audience), so `enabled` is filtered here.
 */
export async function loadGreetingMessages(
  db: Firestore, opts: { enabledOnly?: boolean; authorEpf?: string } = {},
): Promise<GreetingMessage[]> {
  const col = db.collection('greeting_messages');
  const snap = await (opts.authorEpf ? col.where('author_epf', '==', opts.authorEpf).get() : col.get());
  const out: GreetingMessage[] = [];
  for (const doc of snap.docs) {
    const m = normalizeGreetingMessage(doc.id, doc.data());
    if (m && (!opts.enabledOnly || m.enabled)) out.push(m);
  }
  return out;
}

export interface SweepResult { enabled: boolean; sent: number; skipped: number; failed: number }

/**
 * Today's greetings for ONE tenant database. The whole of the daily job, minus the tenant loop.
 *
 * It lives here rather than inside the cron route because there is now more than one thing that
 * can start a send: the 08:00 job, and a browser that opened after the job should have run and
 * found it had not (see /api/greetings/catch-up). Two senders is fine. Two IMPLEMENTATIONS of
 * who-gets-what would not be — they would drift, and the drift would only ever show up as one
 * person getting two cards or none, on the one day of the year anybody would notice.
 *
 * SENDING TWICE IS ALREADY IMPOSSIBLE, and not because callers are careful. deliverGreeting
 * claims a once-per-year marker per person per occasion with `.create()`, which fails if the
 * document exists — an atomic compare-and-set in Firestore. Whoever loses that race gets
 * 'skipped' and writes nothing. The notification doc id is deterministic for the same reason.
 * So a caller does not have to know whether anyone else is running; it only has to be willing
 * to be the one that finds everything already claimed.
 *
 * Special days are deliberately NOT sent from here. They are identical for everyone and are
 * rendered on each device from the settings document, so one notification and one push per
 * employee to repeat a single sentence is a fan-out this tenant cannot afford.
 */
export async function sweepGreetingsForDb(
  db: Firestore, ctx: DeliverCtx, today: string,
): Promise<SweepResult> {
  const settings = await loadGreetingSettings(db);
  if (!settings.enabled) return { enabled: false, sent: 0, skipped: 0, failed: 0 };

  const { people, roles } = await loadPeopleAndRoles(db);
  const flat = people.map(p => p.data);
  // One extra collection read per tenant per day, and it is a small collection: the notes
  // managers have written for their people. Read once and matched per recipient in memory
  // rather than queried per person.
  const personal = await loadGreetingMessages(db, { enabledOnly: true });

  let sent = 0, skipped = 0, failed = 0;
  for (const person of people) {
    if (!isActiveOn(person.data, today) || !isEmployeeRole(person.data.role, roles)) continue;
    const occasions = occasionsFor(person.data, settings, today).filter(o => o.kind !== 'special');
    if (!occasions.length) continue;
    // Signers are resolved per recipient: their department's list, else their company's, else
    // the default one. Undefined means nothing is configured for them and selectSenders falls
    // back to the company's top management, as it always did.
    const senders = selectSenders(person.data, flat, roles, 8, resolveSigners(settings, person.data));
    for (const occasion of occasions) {
      // A personal note leads the card and drops the generic company line, and its author is
      // added to the signature list even when the admin never picked them as a signer — an
      // executive who wrote for their own team member has to appear on that card.
      const authored = messagesFor(person.data, occasion, personal, flat, roles)
        .map(msg => ({ msg, text: renderMessage(msg, person.data, occasion, today) }))
        .filter(a => a.text);
      const signed = authored.length ? mergeSenders(senders, authored) : senders;
      const r = await deliverGreeting(db, ctx, person, occasion, signed, { claimMarker: true, today });
      if (r === 'sent') sent++; else if (r === 'skipped') skipped++; else failed++;
    }
  }
  return { enabled: true, sent, skipped, failed };
}
