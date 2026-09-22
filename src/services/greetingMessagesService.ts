import { auth } from '@/lib/firebase';
import type { GreetingAudience, GreetingMessage } from '@/lib/greetingMessages';
import type { OccasionKind } from '@/lib/greetings';

// Thin client for /api/greetings/messages. Reads and writes both go through the server because
// authorship cannot be enforced by Firestore rules (see the route's own comment) — so there is
// no client-SDK path here at all, deliberately.

async function idToken(): Promise<string> {
  const tok = await auth.currentUser?.getIdToken();
  if (!tok) throw new Error('Not signed in');
  return tok;
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  try {
    const j = await res.json();
    return typeof j?.error === 'string' ? j.error : fallback;
  } catch { return fallback; }
}

/** A stored message plus the two things only the server can work out. */
export interface GreetingMessageRow extends GreetingMessage {
  /** How many people this message would reach today. */
  reach: number;
  /** The target's full name for a 'person' message; their EPF if the profile is gone. */
  target_name: string | null;
}

export interface PersonOption { epf: string; name: string; role: string }

/** Everything the composer needs, in one round trip. */
export interface GreetingComposerData {
  me: { epf: string; name: string; role: string };
  /** The audiences this user may write for — empty means they may not write greetings at all. */
  allowed: GreetingAudience[];
  reach: { everyone: number; my_team: number };
  messages: GreetingMessageRow[];
  /** Only the people this user may address one by one. */
  people: PersonOption[];
  special_days: Array<{ id: string; title: string }>;
  /** The master switch in system settings. False means nothing will actually be delivered. */
  greetings_enabled: boolean;
}

const EMPTY: GreetingComposerData = {
  me: { epf: '', name: '', role: '' },
  allowed: [], reach: { everyone: 0, my_team: 0 },
  messages: [], people: [], special_days: [], greetings_enabled: false,
};

export async function getGreetingComposerData(target?: string): Promise<GreetingComposerData> {
  const qs = target ? `?target=${encodeURIComponent(target)}` : '';
  const res = await fetch(`/api/greetings/messages${qs}`, {
    cache: 'no-store',
    // Header, not the query string: a URL lands in the access log, the browser history and any
    // Referer the page sends, and an ID token is a live credential.
    headers: { authorization: `Bearer ${await idToken()}` },
  });
  if (!res.ok) throw new Error(await errorOf(res, 'Could not load greetings'));
  const d = await res.json();
  return { ...EMPTY, ...(d ?? {}) };
}

export interface SaveGreetingInput {
  /** Omitted for a new message. A 'person' message without one replaces that person's note. */
  id?: string;
  audience: GreetingAudience;
  target_epf?: string | null;
  occasions: OccasionKind[];
  special_day_ids?: string[];
  message: string;
  message_si?: string;
  message_ta?: string;
  enabled?: boolean;
}

export async function saveGreetingMessage(input: SaveGreetingInput): Promise<GreetingMessageRow | null> {
  const res = await fetch('/api/greetings/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: await idToken(), ...input }),
  });
  if (!res.ok) throw new Error(await errorOf(res, 'Could not save that greeting'));
  return (await res.json()).message ?? null;
}

/**
 * Ask Gemini for a first version of this note, or translate an existing note into Sinhala or Tamil.
 * Returns null when the AI is not available — no key, no budget left, a timeout, or an answer
 * that came back unusable.
 */
export async function draftGreetingMessage(input: {
  audience: GreetingAudience;
  target_epf?: string | null;
  occasions: OccasionKind[];
  special_title?: string;
  language?: 'en' | 'si' | 'ta';
  translate_from?: string;
}): Promise<string | null> {
  const res = await fetch('/api/greetings/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: await idToken(), ...input }),
  });
  if (!res.ok) throw new Error(await errorOf(res, 'Could not draft that greeting'));
  const d = await res.json();
  return typeof d?.draft === 'string' && d.draft.trim() ? d.draft.trim() : null;
}

/**
 * Ask Gemini to draft all three languages (EN + SI + TA) at once in one round trip.
 * Any language the AI could not produce comes back as null — the caller handles fallback.
 */
export async function draftGreetingMessageAll(input: {
  audience: GreetingAudience;
  target_epf?: string | null;
  occasions: OccasionKind[];
  special_title?: string;
}): Promise<{ en: string | null; si: string | null; ta: string | null }> {
  const res = await fetch('/api/greetings/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: await idToken(), ...input, draft_all: true }),
  });
  if (!res.ok) throw new Error(await errorOf(res, 'Could not draft that greeting'));
  const d = await res.json();
  const drafts = d?.drafts ?? {};
  return {
    en: typeof drafts.en === 'string' && drafts.en.trim() ? drafts.en.trim() : null,
    si: typeof drafts.si === 'string' && drafts.si.trim() ? drafts.si.trim() : null,
    ta: typeof drafts.ta === 'string' && drafts.ta.trim() ? drafts.ta.trim() : null,
  };
}

export async function draftSpecialDayGreeting(input: {
  special_title: string;
  language?: 'en' | 'si' | 'ta';
  draft_all?: boolean;
}): Promise<{ draft?: string | null; drafts?: { en: string | null; si: string | null; ta: string | null } }> {
  const res = await fetch('/api/greetings/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: await idToken(), for_special_day: true, ...input }),
  });
  if (!res.ok) throw new Error(await errorOf(res, 'Could not draft that greeting'));
  return await res.json();
}

export async function deleteGreetingMessage(id: string): Promise<void> {
  const res = await fetch(`/api/greetings/messages/${encodeURIComponent(id)}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: await idToken() }),
  });
  if (!res.ok) throw new Error(await errorOf(res, 'Could not delete that greeting'));
}

// Re-exported so a component never has to import the pure engine just for a type name.
export type { GreetingAudience };
