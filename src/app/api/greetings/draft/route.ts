import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor, tenantForRequest } from '@/lib/firebaseAdmin';
import { verifySignedInCaller } from '@/lib/adminCaller';
import { loadPeopleAndRoles } from '@/lib/greetingsServer';
import { fullNameOf, firstNameOf, type OccasionKind, type PersonLite } from '@/lib/greetings';
import { canAuthor, isGreetingAudience, GREETING_MESSAGE_MAX } from '@/lib/greetingMessages';
import { draftGreetingBody, translateGreetingText } from '@/lib/greetingAi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Draft with AI" in the greetings composer — Gemini writes a first version of the note the
 * author is about to write themselves.
 *
 * Gated by the SAME canAuthor() the save is gated by, for a reason that is easy to miss: a
 * draft for `audience: 'person'` is written FROM that person's real name and role, so an
 * ungated draft endpoint would hand any signed-in employee a lookup of anyone in the company.
 * The permission model is the one in greetingMessages.ts, asked here again from the token.
 *
 * The answer is a suggestion and nothing more: nothing is stored, and the author still has to
 * read it, change it and press save.
 */

const OCCASION_KINDS: readonly OccasionKind[] = ['birthday', 'anniversary', 'special'];

interface Body {
  idToken?: unknown;
  audience?: unknown;
  target_epf?: unknown;
  occasions?: unknown;
  /** The special day's title, when the note is for one specific day. */
  special_title?: unknown;
  for_special_day?: unknown;
  language?: unknown;
  draft_all?: unknown;
  translate_from?: unknown;
}

export async function POST(req: NextRequest) {
  const db = adminDbFor(req);
  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }

  const caller = await verifySignedInCaller(db, body.idToken);
  if (!caller) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  // Direct AI translation request
  if (typeof body.translate_from === 'string' && body.translate_from.trim()) {
    const targetLang = body.language === 'ta' ? 'ta' : 'si';
    const translated = await translateGreetingText(body.translate_from, targetLang);
    if (!translated) return NextResponse.json({ ok: false, draft: null });
    return NextResponse.json({ ok: true, draft: translated });
  }

  if (body.for_special_day) {
    const specialTitle = String(body.special_title ?? '').trim() || 'Holiday';
    const brand = tenantForRequest(req).appName;
    if (body.draft_all) {
      const [en, si, ta] = await Promise.all([
        draftGreetingBody({ occasion: 'special', name: '', first: '', brand, from: '', title: specialTitle, language: 'en', maxChars: 320 }),
        draftGreetingBody({ occasion: 'special', name: '', first: '', brand, from: '', title: specialTitle, language: 'si', maxChars: 320 }),
        draftGreetingBody({ occasion: 'special', name: '', first: '', brand, from: '', title: specialTitle, language: 'ta', maxChars: 320 }),
      ]);
      return NextResponse.json({ ok: true, drafts: { en, si, ta } });
    }
    const lang = body.language === 'si' ? 'si' : body.language === 'ta' ? 'ta' : 'en';
    const draft = await draftGreetingBody({
      occasion: 'special',
      name: '',
      first: '',
      brand,
      from: '',
      title: specialTitle,
      language: lang,
      maxChars: 320,
    });
    if (!draft) return NextResponse.json({ ok: false, draft: null });
    return NextResponse.json({ ok: true, draft });
  }

  const audience = isGreetingAudience(body.audience) ? body.audience : null;
  if (!audience) return NextResponse.json({ error: 'Pick who this greeting is for' }, { status: 400 });

  const { people, roles } = await loadPeopleAndRoles(db);
  const flat = people.map(p => p.data);
  const personOf = (epf: string): PersonLite | undefined =>
    flat.find(p => String(p.epf_number ?? '').trim() === epf);

  const me = personOf(caller.epf);
  if (!me) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const targetEpf = audience === 'person' ? String(body.target_epf ?? '').trim() : '';
  if (!canAuthor(me, audience, targetEpf || null, flat, roles, { systemAdmin: caller.systemAdmin })) {
    return NextResponse.json({ error: 'You cannot write a greeting for that audience' }, { status: 403 });
  }

  const occasions = (Array.isArray(body.occasions) ? body.occasions : [])
    .map(x => String(x ?? ''))
    .filter((x): x is OccasionKind => (OCCASION_KINDS as readonly string[]).includes(x));
  if (!occasions.length) return NextResponse.json({ error: 'Pick at least one occasion' }, { status: 400 });

  const target = targetEpf ? personOf(targetEpf) : undefined;
  if (audience === 'person' && !target) {
    return NextResponse.json({ error: 'That person is not in this system' }, { status: 400 });
  }

  const lang = body.language === 'si' ? 'si' : body.language === 'ta' ? 'ta' : 'en';

  // draft_all: generate EN + SI + TA in parallel in one call, same as the special-day path.
  if (body.draft_all) {
    const baseInput = {
      occasion:      occasions[0],
      alsoOccasions: occasions.slice(1),
      name:          target ? fullNameOf(target) : '',
      first:         target ? firstNameOf(target) : '',
      placeholders:  !target,
      brand:         tenantForRequest(req).appName,
      from:          '',
      role:          target?.role ?? undefined,
      department:    target?.department ?? undefined,
      title:         String(body.special_title ?? '') || undefined,
      authorName:    fullNameOf(me) || caller.name,
      maxChars:      Math.min(320, GREETING_MESSAGE_MAX),
    };
    const [en, si, ta] = await Promise.all([
      draftGreetingBody({ ...baseInput, language: 'en' }),
      draftGreetingBody({ ...baseInput, language: 'si' }),
      draftGreetingBody({ ...baseInput, language: 'ta' }),
    ]);
    return NextResponse.json({ ok: true, drafts: { en, si, ta } });
  }

  const draft = await draftGreetingBody({
    occasion:      occasions[0],
    alsoOccasions: occasions.slice(1),
    // A note for one person is written to them by name; a note for a team is written with the
    // placeholder, because it goes to everyone under this author on their own separate days.
    name:          target ? fullNameOf(target) : '',
    first:         target ? firstNameOf(target) : '',
    placeholders:  !target,
    brand:         tenantForRequest(req).appName,
    from:          '',
    role:          target?.role ?? undefined,
    department:    target?.department ?? undefined,
    title:         String(body.special_title ?? '') || undefined,
    authorName:    fullNameOf(me) || caller.name,
    language:      lang,
    // The composer allows a longer note than a push body — the card shows all of it.
    maxChars:      Math.min(320, GREETING_MESSAGE_MAX),
  });

  // A null draft is an ordinary outcome (no key, no budget, a timeout, an unusable answer), and
  // the composer says so plainly rather than pretending the button did nothing.
  if (!draft) return NextResponse.json({ ok: false, draft: null });
  return NextResponse.json({ ok: true, draft });
}
