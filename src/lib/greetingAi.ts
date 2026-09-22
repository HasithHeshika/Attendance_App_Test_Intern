// Server-only: Gemini writes the greeting when it can. NEVER import into client code — it uses
// the server-only GOOGLE_API_KEY.
//
// This is an ENHANCEMENT over src/lib/greetingVariants.ts, never a dependency. Every failure
// path here returns null and the hand-written pool ships instead: no key, no budget left, a
// timeout, a refusal, an answer that came back empty or shaped wrong. A greeting that arrives a
// little less unique is fine; a greeting that does not arrive at all on someone's birthday is
// not, and it cannot be sent again tomorrow.
//
// The model is asked for ONE short line because this same sentence is the lock-screen push.

import { getAiBudget, recordAiUsage } from './aiUsageBudget';
import { PUSH_BODY_CHARS } from './greetings';
import { GREETING_MESSAGE_MAX } from './greetingMessages';

/** Flash-lite: this is one short sentence, not a document. GEMINI_GREETING_MODEL overrides. */
const MODEL = process.env.GEMINI_GREETING_MODEL || 'gemini-flash-lite-latest';

/** The daily job has a whole morning, but a person is waiting on the composer's draft button,
 *  and a greeting nobody is reading yet must never hold the cron open. */
const TIMEOUT_MS = 9_000;

export interface GreetingAiInput {
  occasion: 'birthday' | 'anniversary' | 'special';
  /** The reader's full name, and the first name the sentence should use. */
  name: string;
  first: string;
  brand: string;
  /** Who it is from, brand included — the same phrase the pool lines use. */
  from: string;
  years?: number;
  /** Special days only: the festival's own name. */
  title?: string;
  /** Context that makes the line specific rather than generic. Optional by design: an empty
   *  profile must still get a greeting. */
  role?: string;
  department?: string;
  /** Set when a PERSON is drafting a note in the composer, not when the system is writing its
   *  own copy — the voice is different and so is the signature. */
  authorName?: string;
  /** A composer note written for a whole team goes out on many different days to many different
   *  people, so it is written with the placeholders the engine fills in ({first_name}, {name},
   *  {years}) rather than with one person's name baked into it. */
  placeholders?: boolean;
  /** The note also covers these occasions, so the wording has to suit all of them. */
  alsoOccasions?: string[];
  /** Language to generate: 'en' (default), 'si' (Sinhala), or 'ta' (Tamil). */
  language?: 'en' | 'si' | 'ta';
  /** Defaults to a push body. A composer note is read on the card too, so it may run longer. */
  maxChars?: number;
}

/** The only interpolation this feature has — the same three renderMessage() fills in. */
const TOKENS = ['{first_name}', '{name}', '{years}'];

function line(input: GreetingAiInput): string {
  const bits = [
    `Occasion: ${input.occasion}`,
    input.first ? `Recipient first name: ${input.first}` : '',
    input.name ? `Recipient full name: ${input.name}` : '',
    `Company: ${input.brand}`,
    input.role ? `Their role: ${input.role}` : '',
    input.department ? `Their department: ${input.department}` : '',
    input.occasion === 'anniversary' ? `Years of service completed today: ${input.years ?? 0}` : '',
    input.occasion === 'special' ? `The day being marked: ${input.title ?? ''}` : '',
    input.alsoOccasions?.length ? `The same note is also sent for: ${input.alsoOccasions.join(', ')}` : '',
    input.authorName ? `You are drafting for ${input.authorName}, who will sign it themselves.` : input.from ? `Signed by: ${input.from}` : `From: Everyone at ${input.brand}`,
  ];
  return bits.filter(Boolean).join('\n');
}

function prompt(input: GreetingAiInput): string {
  const limit = input.maxChars ?? PUSH_BODY_CHARS;
  const signature = input.authorName
    // A composer draft is one person's note. It must not sign itself — the card puts the
    // author's name under it, and a signature inside the text would then appear twice.
    ? 'Write it as that person speaking directly to the recipient, in the first person. Do NOT sign it or add a name at the end.'
    : input.from
      ? `Name who it is from using exactly this phrase somewhere in the sentence: "${input.from}".`
      : `Express warm festive wishes from everyone at ${input.brand}. Do NOT use placeholders.`;
  // A note for a team is written once and read by many people on many different days, so the
  // name has to be a token the engine fills in rather than one person's name.
  const naming = input.placeholders
    ? `- Write ${TOKENS[0]} exactly, where the recipient's first name goes — it is replaced per person. Do not use any other placeholder except ${TOKENS[1]} or ${TOKENS[2]}.`
    : input.first
      ? '- Use their first name.'
      : '- Address the reader warmly without needing an individual personal name.';

  const langRule = input.language === 'si'
    ? '- Write in natural, warm and grammatically correct Sinhala (සිංහල). Suitable for a company festival/holiday greeting card to employees. Write in Sinhala script only.'
    : input.language === 'ta'
      ? '- Write in natural, warm and grammatically correct Tamil (தமிழ்). Suitable for a company festival/holiday greeting card to employees. Write in Tamil script only.'
      : '- English only.';

  return `Write ONE short greeting for a colleague at a Sri Lankan company${input.title ? ` celebrating "${input.title}"` : ''}. It is delivered as a phone notification and celebration card, so it must read well in about two lines.

${line(input)}

Rules:
- Plain text only. One or two sentences, at most ${limit} characters in total.
- Warm and ordinary, the way a colleague actually speaks. Not corporate, not a press release, no "we value your contribution", no "team player".
${naming}
- Mention the company name naturally if appropriate.
- ${signature}
- No emoji, no hashtags, no quotation marks around the message, no markdown, no line breaks.
- Do not invent facts about them — no achievements, no projects, no personal details beyond what is written above.
${langRule}

Reply with the greeting itself and nothing else.`;
}

/** Gemini's own accounting of the call, or undefined when it did not report any. */
function readUsage(meta: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const m = meta as { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
  const i = Number(m.promptTokenCount);
  const o = Number(m.candidatesTokenCount);
  if (!Number.isFinite(i) && !Number.isFinite(o)) return undefined;
  return { inputTokens: Number.isFinite(i) ? i : 0, outputTokens: Number.isFinite(o) ? o : 0 };
}

/**
 * What a model returns is not what a person may read. This strips the shapes it reaches for
 * anyway (a wrapping quote, a markdown bullet, a second paragraph), holds the line to a push
 * body, and rejects anything that came back as a refusal or a template rather than a greeting.
 */
export function sanitizeGreeting(raw: string, input: GreetingAiInput): string | null {
  let out = String(raw ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^\s*[-*•]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“”'']+|["“”'']+$/g, '')
    .trim();

  if (!out) return null;
  if (/\[[a-z_ ]+\]/i.test(out)) return null;                       // "[Name]" is a template, not a greeting
  if (input.placeholders) {
    // Only the three tokens the engine actually fills in. Anything else in braces would reach
    // the reader verbatim, which is the exact failure this check exists to catch.
    const unknown = (out.match(/\{[^}]*\}/g) ?? []).filter(tok => !TOKENS.includes(tok));
    if (unknown.length) return null;
    if (!out.includes(TOKENS[0]) && !out.includes(TOKENS[1])) return null;
  } else if (/[{}]/.test(out)) {
    return null;                                                    // a leftover placeholder
  }
  // A refusal, an apology or a question is not a greeting — take the pool instead.
  if (/^(i'm sorry|i am sorry|i cannot|i can't|as an ai|sure[,!]|here (is|are))/i.test(out)) return null;
  if (out.endsWith('?')) return null;
  // The one thing that makes it theirs. Without it there is nothing the pool does worse.
  if (!input.placeholders && input.first && !out.toLowerCase().includes(input.first.toLowerCase())) return null;

  const limit = input.maxChars ?? PUSH_BODY_CHARS;
  if (out.length > limit) {
    // Cut at the last sentence that fits rather than mid-word; if the very first sentence is
    // already too long there is nothing worth keeping.
    const cut = out.slice(0, limit);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('؟'), cut.lastIndexOf('.'));
    if (stop < 25) return out.slice(0, limit).trim();
    out = cut.slice(0, stop + 1).trim();
  }
  return out;
}

/**
 * One greeting body written by Gemini, or null — and null is an ordinary outcome, not an error.
 * Never throws: every caller is on a path where the greeting still has to go out.
 */
export async function draftGreetingBody(input: GreetingAiInput): Promise<string | null> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;

  try {
    // The same monthly guard the bill reader answers to — one key, one budget, one counter.
    const budget = await getAiBudget();
    if (!budget.allowed) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt(input) }] }],
            // Warm, not wild: high enough that two people on the same day do not get the same
            // sentence, low enough that it stays a greeting. 250 tokens accommodates Sinhala & Tamil Unicode characters.
            generationConfig: { temperature: 0.9, topP: 0.95, maxOutputTokens: 250 },
          }),
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    if (!res.ok) {
      // Null stays an ordinary outcome for the CALLER — the hand-written pool writes the
      // greeting, and the composer says so plainly. But an HTTP failure is a configuration
      // fault somebody has to be able to find, and without this line "no key", "key blocked
      // for this API" and "model rejected the request" are one indistinguishable null in the
      // log. That is exactly why a restricted API key took a live probe to diagnose.
      const err = (data as { error?: { message?: string; status?: string } })?.error;
      console.warn(
        `[greetingAi] ${MODEL} refused the request (HTTP ${res.status}${err?.status ? ` ${err.status}` : ''}): `
        + (err?.message ?? 'no message from the API'),
      );
      return null;
    }

    const usage = readUsage((data as { usageMetadata?: unknown })?.usageMetadata);
    // Counted before the answer is judged: a call that came back unusable still cost money.
    if (usage) await recordAiUsage(usage).catch(() => { /* the guard is best-effort */ });

    const text = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })
      ?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') return null;

    return sanitizeGreeting(text, input);
  } catch {
    // Timeout, DNS, a malformed answer — all the same outcome: the pool writes it.
    return null;
  }
}

/**
 * Translates an existing greeting into natural Sinhala or Tamil, strictly preserving
 * placeholder tokens ({name}, {first_name}, {years}).
 */
export async function translateGreetingText(
  sourceText: string,
  targetLang: 'si' | 'ta',
): Promise<string | null> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey || !sourceText.trim()) return null;

  try {
    const budget = await getAiBudget();
    if (!budget.allowed) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const langName = targetLang === 'si' ? 'Sinhala (සිංහල)' : 'Tamil (தமிழ்)';
    const promptText = `Translate the following workplace greeting message into natural, warm, and grammatically correct ${langName}.
Suitable for a celebratory company greeting card to a colleague or employee.
Write in ${langName} script only.

IMPORTANT:
- Preserve all placeholder tokens such as {first_name}, {name}, or {years} EXACTLY as they are without translating or altering them.
- Warm and collegial tone, not overly stiff or bureaucratic.
- Plain text only. No quotes, no markdown, no emojis, no hashtags, no explanations.

Original Message:
${sourceText.trim()}

Reply with the translated message only:`;

    let res: Response;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: { temperature: 0.3, topP: 0.9, maxOutputTokens: 300 },
          }),
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    if (!res.ok) return null;

    const usage = readUsage((data as { usageMetadata?: unknown })?.usageMetadata);
    if (usage) await recordAiUsage(usage).catch(() => {});

    const text = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })
      ?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') return null;

    let clean = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^["“”'']+|["“”'']+$/g, '').trim();
    if (clean.length > GREETING_MESSAGE_MAX) clean = clean.slice(0, GREETING_MESSAGE_MAX);
    return clean || null;
  } catch {
    return null;
  }
}

