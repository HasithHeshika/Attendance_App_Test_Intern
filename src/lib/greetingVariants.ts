// The words a greeting uses when nobody wrote it any. Pure: no clock, no randomness, no
// firebase — the daily job, the admin preview and the tests all read the same lines.
//
// WHY A POOL AND NOT ONE SENTENCE. Every person in the company used to get the exact same
// body ("Warm wishes from <names>. Have a wonderful day!"), which reads as a mail merge on the
// one day of the year the message is supposed to be about the reader. A pool of hand-written
// lines is still written by a person — just written once, in advance, by us.
//
// WHY DETERMINISTIC AND NOT RANDOM. The same greeting is written to the notification doc, sent
// as the push and re-read by the card. A retry, a re-render or a replayed cron run must produce
// the SAME sentence, or the card and the lock screen disagree about what was said. The line is
// therefore a pure function of who the person is and which year it is — and because the year is
// ADDED to the index rather than hashed into it, nobody gets the same line two years running.

import type { Occasion } from './greetings';

export interface VariantCtx {
  /** The reader's first name. The body is conversational; the title carries the full name. */
  first: string;
  /** Who it is from, brand included — e.g. "your supervisor Eve and Ann at PearlCluster". */
  from: string;
  /** The organisation's own name, as this domain brands itself. */
  brand: string;
  /** Anniversaries only. */
  years: number;
  /** Special days only — the festival's own title. */
  title: string;
}

export type Variant = (v: VariantCtx) => string;

/** First letter up, for a line that opens with the signer phrase ("your supervisor Eve …"). */
export function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** FNV-1a. Small, stable across runs and platforms — Math.random and Date are both banned here. */
export function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Which line this person gets this year. The year is added, not hashed, so consecutive years
 * always step to the next line in the pool — the one repeat a person would actually notice.
 */
export function variantIndex(key: string, year: number, len: number): number {
  if (len <= 0) return 0;
  const y = Number.isFinite(year) ? Math.trunc(year) : 0;
  return (((hashKey(key) + y) % len) + len) % len;
}

// ─── The lines ────────────────────────────────────────────────────────────────
// Rules every line here follows, because they are the ones that made the old copy read like a
// machine: name the person, name who it is from (which carries the company), and say something
// a colleague would actually say out loud. No exclamation stacking, no "we value you", no HR.
// Keep them SHORT — this same sentence is the lock-screen push, where iOS shows about two lines.

export const BIRTHDAY_LINES: Variant[] = [
  v => `${cap(v.from)} wish you a very happy birthday, ${v.first}.`,
  v => `It's your day, ${v.first} — ${v.from} hope it's a good one.`,
  v => `Happy birthday, ${v.first}. Have a slice for us — ${v.from}.`,
  v => `${cap(v.from)} are thinking of you today, ${v.first}. Happy birthday.`,
  v => `Many happy returns, ${v.first}, from ${v.from}.`,
  v => `Wishing you a birthday worth remembering, ${v.first} — ${v.from}.`,
  v => `Happy birthday, ${v.first}. ${cap(v.from)} hope the year ahead is kind.`,
  v => `Take today easy, ${v.first}. Happy birthday from ${v.from}.`,
  v => `A very happy birthday to you, ${v.first}, from ${v.from}.`,
  v => `${cap(v.from)} hope today brings you exactly what you'd want, ${v.first}.`,
  v => `Happy birthday, ${v.first} — ${v.from} are glad you're with us.`,
  v => `Cake, quiet and good company: that's our wish for you, ${v.first}. From ${v.from}.`,
];

// A first year, a long stay and everything between are three different things to say, so the
// milestone pools are separate rather than one pool with a number dropped into it.
export const FIRST_YEAR_LINES: Variant[] = [
  v => `One year today, ${v.first}. ${cap(v.from)} are glad you stayed.`,
  v => `A full year, ${v.first} — thank you for it, from ${v.from}.`,
  v => `Your first year is done, ${v.first}. Here's to the next — ${v.from}.`,
  v => `One year with ${v.brand} today, ${v.first}. Thank you, from ${v.from}.`,
];

export const MILESTONE_LINES: Variant[] = [
  v => `${v.years} years, ${v.first}. That's a long stretch of good work — thank you, from ${v.from}.`,
  v => `${v.years} years with ${v.brand}, ${v.first}. Not many do that. Thank you — ${v.from}.`,
  v => `${v.years} years today, ${v.first}. ${cap(v.from)} are grateful for every one of them.`,
  v => `A decade and more, ${v.first} — ${v.years} years. Thank you, from ${v.from}.`,
];

export const ANNIVERSARY_LINES: Variant[] = [
  v => `${v.years} years with ${v.brand} today, ${v.first}. Thank you for all of it — ${v.from}.`,
  v => `${v.years} years in, ${v.first}, and still glad to have you. From ${v.from}.`,
  v => `Happy work anniversary, ${v.first} — ${v.years} years. Thank you, from ${v.from}.`,
  v => `${cap(v.from)} say thank you for ${v.years} years, ${v.first}.`,
  v => `${v.years} years today, ${v.first}. The place is better for it — ${v.from}.`,
  v => `Another year with us, ${v.first} — ${v.years} now. Thank you, from ${v.from}.`,
];

export const SPECIAL_LINES: Variant[] = [
  v => `${cap(v.from)} wish you and your family a peaceful ${v.title}, ${v.first}.`,
  v => `Happy ${v.title}, ${v.first} — from ${v.from}.`,
  v => `${cap(v.from)} send you and yours warm wishes this ${v.title}, ${v.first}.`,
  v => `Enjoy ${v.title} with the people you love, ${v.first}. From ${v.from}.`,
  v => `Wishing you a happy ${v.title}, ${v.first}, from ${v.from}.`,
];

// ─── The same lines, in Sinhala and Tamil ─────────────────────────────────────
// A greeting that arrives in a language the reader does not use every day is a card written to
// somebody else. The three pools per occasion are therefore the SAME LENGTH, and that is not a
// coincidence — the server picks one index and stores it, and each device renders that index
// from its own reader's pool. So everyone gets the same greeting and everyone gets it in their
// own language, with no extra sends. A test asserts the lengths, because the day they drift is
// the day a Tamil reader silently gets somebody else's line.
//
// These are written, not machine-translated: `from` carries people's names, so each line places
// it where a particle can attach ("… වෙතින්", "… சார்பாக") rather than gluing an English clause
// onto a Sinhala sentence. cap() is never used here — neither script has letter case.

export const BIRTHDAY_LINES_SI: Variant[] = [
  v => `${v.from} වෙතින් ඔබට සුබ උපන්දිනයක්, ${v.first}.`,
  v => `අද ඔබේ දිනයයි, ${v.first}. හොඳ දිනයක් වේවා — ${v.from}.`,
  v => `සුබ උපන්දිනයක්, ${v.first}. කේක් කෑල්ලක් අපිටත් තියන්න — ${v.from}.`,
  v => `${v.from} අද ඔබ ගැන සිතනවා, ${v.first}. සුබ උපන්දිනයක්.`,
  v => `නැවත නැවතත් සුබ උපන්දින, ${v.first} — ${v.from}.`,
  v => `අමතක නොවන උපන්දිනයක් ප්‍රාර්ථනා කරමු, ${v.first} — ${v.from}.`,
  v => `සුබ උපන්දිනයක්, ${v.first}. ඉදිරි වසර සුබ වේවා — ${v.from}.`,
  v => `අද සැහැල්ලුවෙන් ගත කරන්න, ${v.first}. ${v.from} වෙතින් සුබ පැතුම්.`,
  v => `ඔබට ඉතා සුබ උපන්දිනයක්, ${v.first} — ${v.from}.`,
  v => `අද ඔබ කැමති දේ ලැබේවා, ${v.first}. ${v.from}.`,
  v => `සුබ උපන්දිනයක්, ${v.first} — ඔබ අප සමඟ සිටීම සතුටක්, ${v.from}.`,
  v => `කේක්, සන්සුන්කම සහ හොඳ මිතුරන්: අද ඔබට අපේ පැතුම, ${v.first}. ${v.from}.`,
];

export const BIRTHDAY_LINES_TA: Variant[] = [
  v => `${v.from} சார்பாக உங்களுக்கு இனிய பிறந்தநாள் வாழ்த்துகள், ${v.first}.`,
  v => `இன்று உங்கள் நாள், ${v.first} — நல்ல நாளாக அமையட்டும், ${v.from}.`,
  v => `இனிய பிறந்தநாள், ${v.first}. எங்களுக்கும் ஒரு கேக் துண்டு வையுங்கள் — ${v.from}.`,
  v => `${v.from} இன்று உங்களை நினைத்துக்கொள்கிறோம், ${v.first}. இனிய பிறந்தநாள்.`,
  v => `பல்லாண்டு வாழ்க, ${v.first} — ${v.from}.`,
  v => `நினைவில் நிற்கும் பிறந்தநாளாக அமையட்டும், ${v.first} — ${v.from}.`,
  v => `இனிய பிறந்தநாள், ${v.first}. வரும் ஆண்டு இனிதாக இருக்கட்டும் — ${v.from}.`,
  v => `இன்று நிதானமாக இருங்கள், ${v.first}. ${v.from} வாழ்த்துகள்.`,
  v => `உங்களுக்கு மிகவும் இனிய பிறந்தநாள், ${v.first} — ${v.from}.`,
  v => `இன்று நீங்கள் விரும்புவது கிடைக்கட்டும், ${v.first}. ${v.from}.`,
  v => `இனிய பிறந்தநாள், ${v.first} — நீங்கள் எங்களுடன் இருப்பது மகிழ்ச்சி, ${v.from}.`,
  v => `கேக், அமைதி, நல்ல நண்பர்கள்: இதுவே எங்கள் வாழ்த்து, ${v.first}. ${v.from}.`,
];

export const FIRST_YEAR_LINES_SI: Variant[] = [
  v => `අද වසරක් සම්පූර්ණයි, ${v.first}. ඔබ රැඳී සිටීම සතුටක් — ${v.from}.`,
  v => `පූර්ණ වසරක්, ${v.first} — ඒ සඳහා ස්තූතියි, ${v.from}.`,
  v => `ඔබේ පළමු වසර නිමයි, ${v.first}. ඊළඟ වසරටත් සුබ පැතුම් — ${v.from}.`,
  v => `${v.brand} සමඟ අද වසරක්, ${v.first}. ස්තූතියි — ${v.from}.`,
];

export const FIRST_YEAR_LINES_TA: Variant[] = [
  v => `இன்று ஒரு ஆண்டு நிறைவு, ${v.first}. நீங்கள் தொடர்வது மகிழ்ச்சி — ${v.from}.`,
  v => `ஒரு முழு ஆண்டு, ${v.first} — அதற்கு நன்றி, ${v.from}.`,
  v => `உங்கள் முதல் ஆண்டு நிறைவடைந்தது, ${v.first}. அடுத்ததற்கு வாழ்த்துகள் — ${v.from}.`,
  v => `${v.brand} உடன் இன்று ஒரு ஆண்டு, ${v.first}. நன்றி — ${v.from}.`,
];

export const MILESTONE_LINES_SI: Variant[] = [
  v => `වසර ${v.years}ක්, ${v.first}. දිගු කලක් හොඳ සේවයක් — ස්තූතියි, ${v.from}.`,
  v => `${v.brand} සමඟ වසර ${v.years}ක්, ${v.first}. එය කරන්නේ ටික දෙනෙක් — ස්තූතියි, ${v.from}.`,
  v => `අද වසර ${v.years}ක්, ${v.first}. ඒ හැම වසරකටම අපි කෘතඥ — ${v.from}.`,
  v => `දශකයකට වැඩි කලක් — වසර ${v.years}ක්, ${v.first}. ස්තූතියි, ${v.from}.`,
];

export const MILESTONE_LINES_TA: Variant[] = [
  v => `${v.years} ஆண்டுகள், ${v.first}. நீண்ட காலம் சிறந்த பணி — நன்றி, ${v.from}.`,
  v => `${v.brand} உடன் ${v.years} ஆண்டுகள், ${v.first}. பலரால் இயலாதது — நன்றி, ${v.from}.`,
  v => `இன்று ${v.years} ஆண்டுகள், ${v.first}. ஒவ்வொரு ஆண்டுக்கும் நன்றி — ${v.from}.`,
  v => `ஒரு பத்தாண்டுக்கும் மேல் — ${v.years} ஆண்டுகள், ${v.first}. நன்றி, ${v.from}.`,
];

export const ANNIVERSARY_LINES_SI: Variant[] = [
  v => `${v.brand} සමඟ අද වසර ${v.years}ක්, ${v.first}. හැම දෙයටම ස්තූතියි — ${v.from}.`,
  v => `වසර ${v.years}ක් ගතවුණා, ${v.first}. ඔබ අප සමඟ සිටීම සතුටක් — ${v.from}.`,
  v => `සුබ සේවා සංවත්සරයක්, ${v.first} — වසර ${v.years}ක්. ස්තූතියි, ${v.from}.`,
  v => `වසර ${v.years}ක් සඳහා ස්තූතියි, ${v.first} — ${v.from}.`,
  v => `අද වසර ${v.years}ක්, ${v.first}. මේ තැන ඒ නිසා හොඳයි — ${v.from}.`,
  v => `අප සමඟ තව වසරක්, ${v.first} — දැන් වසර ${v.years}ක්. ස්තූතියි, ${v.from}.`,
];

export const ANNIVERSARY_LINES_TA: Variant[] = [
  v => `${v.brand} உடன் இன்று ${v.years} ஆண்டுகள், ${v.first}. அனைத்திற்கும் நன்றி — ${v.from}.`,
  v => `${v.years} ஆண்டுகள் ஆகிவிட்டன, ${v.first}. நீங்கள் எங்களுடன் இருப்பது மகிழ்ச்சி — ${v.from}.`,
  v => `இனிய பணி ஆண்டுவிழா, ${v.first} — ${v.years} ஆண்டுகள். நன்றி, ${v.from}.`,
  v => `${v.years} ஆண்டுகளுக்கு நன்றி, ${v.first} — ${v.from}.`,
  v => `இன்று ${v.years} ஆண்டுகள், ${v.first}. இந்த இடம் அதனால் சிறந்தது — ${v.from}.`,
  v => `எங்களுடன் மேலும் ஒரு ஆண்டு, ${v.first} — இப்போது ${v.years}. நன்றி, ${v.from}.`,
];

export const SPECIAL_LINES_SI: Variant[] = [
  v => `${v.from} ඔබට සහ ඔබේ පවුලට සාමකාමී ${v.title} ප්‍රාර්ථනා කරයි, ${v.first}.`,
  v => `සුබ ${v.title}, ${v.first} — ${v.from}.`,
  v => `මේ ${v.title} දිනයේ ඔබට සහ ඔබේ පවුලට උණුසුම් සුබ පැතුම්, ${v.first} — ${v.from}.`,
  v => `ආදරණීයයන් සමඟ ${v.title} සතුටින් ගත කරන්න, ${v.first}. ${v.from}.`,
  v => `සුබ ${v.title} ප්‍රාර්ථනා කරමු, ${v.first} — ${v.from}.`,
];

export const SPECIAL_LINES_TA: Variant[] = [
  v => `${v.from} உங்களுக்கும் உங்கள் குடும்பத்திற்கும் அமைதியான ${v.title} வாழ்த்துகிறது, ${v.first}.`,
  v => `இனிய ${v.title}, ${v.first} — ${v.from}.`,
  v => `இந்த ${v.title} நாளில் உங்களுக்கும் உங்கள் குடும்பத்திற்கும் அன்பான வாழ்த்துகள், ${v.first} — ${v.from}.`,
  v => `நீங்கள் விரும்பும் மனிதர்களுடன் ${v.title} கொண்டாடுங்கள், ${v.first}. ${v.from}.`,
  v => `இனிய ${v.title} வாழ்த்துகள், ${v.first} — ${v.from}.`,
];

/** The languages a greeting body exists in. */
export type GreetingLang = 'en' | 'si' | 'ta';

/** Which pool an occasion draws from — stored on the notification so a device can find it. */
export type PoolName = 'birthday' | 'first_year' | 'milestone' | 'anniversary' | 'special';

const POOLS: Record<GreetingLang, Record<PoolName, Variant[]>> = {
  en: {
    birthday: BIRTHDAY_LINES, first_year: FIRST_YEAR_LINES, milestone: MILESTONE_LINES,
    anniversary: ANNIVERSARY_LINES, special: SPECIAL_LINES,
  },
  si: {
    birthday: BIRTHDAY_LINES_SI, first_year: FIRST_YEAR_LINES_SI, milestone: MILESTONE_LINES_SI,
    anniversary: ANNIVERSARY_LINES_SI, special: SPECIAL_LINES_SI,
  },
  ta: {
    birthday: BIRTHDAY_LINES_TA, first_year: FIRST_YEAR_LINES_TA, milestone: MILESTONE_LINES_TA,
    anniversary: ANNIVERSARY_LINES_TA, special: SPECIAL_LINES_TA,
  },
};

/** A first year, a long stay and everything between are three different things to say. */
export function poolNameFor(o: Occasion): PoolName {
  switch (o.kind) {
    case 'birthday': return 'birthday';
    case 'special':  return 'special';
    case 'anniversary':
      if (o.years <= 1) return 'first_year';
      return o.years % 5 === 0 || o.years >= 10 ? 'milestone' : 'anniversary';
  }
}

export function isGreetingLang(v: unknown): v is GreetingLang {
  return v === 'en' || v === 'si' || v === 'ta';
}

/** The pool one occasion draws from. Exported so a test can assert every line is well formed. */
export function poolFor(o: Occasion, lang: GreetingLang = 'en'): Variant[] {
  const name = poolNameFor(o);
  return POOLS[lang]?.[name] ?? POOLS.en[name];
}

/**
 * One stored line, rendered in one language.
 *
 * This is the device half of the arrangement: the server chose an index once and wrote it to the
 * notification, and every reader's own app renders THAT index from THEIR pool. Returns null when
 * the pool name is not one we know — a notification written by a newer version of the app — and
 * the caller then falls back to the stored English body, which is never wrong, only less local.
 */
export function variantByName(
  pool: string, index: number, ctx: VariantCtx, lang: GreetingLang,
): string | null {
  const name = pool as PoolName;
  const lines = POOLS[lang]?.[name] ?? POOLS.en[name];
  if (!lines?.length || !Number.isFinite(index)) return null;
  const i = ((Math.trunc(index) % lines.length) + lines.length) % lines.length;
  return lines[i](ctx);
}

/**
 * One greeting body. `key` identifies the person + occasion (their EPF is the natural choice)
 * and `year` is the year being greeted; together they decide which line, forever.
 */
export function greetingBodyVariant(
  o: Occasion, ctx: VariantCtx, key: string, year: number, lang: GreetingLang = 'en',
): string {
  const pool = poolFor(o, lang);
  return pool[variantIndex(key, year, pool.length)](ctx);
}
