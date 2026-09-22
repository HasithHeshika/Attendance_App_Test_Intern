'use client';
import { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { FireworksBackground } from '@/components/animate-ui/components/backgrounds/fireworks';
import GreetingBackdrop, { OccasionMark } from '@/components/greetings/GreetingBackdrop';
import { useAppStore, useT } from '@/store/appStore';
import { useBrandName } from '@/lib/brand';
import { variantByName } from '@/lib/greetingVariants';
import { isHumanSenderName, type Sender, firstCallingName } from '@/lib/greetings';

// The greeting itself, full screen. Everything about WHEN a card opens lives in GreetingCard;
// this file only knows how to show one.
//
// It is a Radix Dialog stretched to the viewport rather than a hand-rolled overlay, and that is
// deliberate. Leaving Dialog would mean reimplementing the focus trap, focus restore, Escape,
// aria-modal, the title/description wiring and — the one people forget — the scroll lock that
// covers the app shell's own scrolling DIV, because the page scroller here is not the body.
// Overriding a few classes is the cheap half of that trade.

export interface ShownGreeting {
  docId: string | null;                 // null for the two client-only cards
  occasion: 'birthday' | 'anniversary' | 'special';
  years?: string;
  specialTitle?: string;
  specialMessage?: string;
  specialTitleSi?: string;
  specialMessageSi?: string;
  specialTitleTa?: string;
  specialMessageTa?: string;
  /** The FULL name the greeting was addressed to (meta.name). */
  name?: string;
  senders: Sender[];
  fallbackTitle?: string;               // pre-existing bday-* docs carry no meta.occasion
  fallbackBody?: string;
  /** Which pool line the server chose (meta.pool / meta.variant), and the signer phrase that
   *  line was built with (meta.from). Present only when the hand-written pool wrote the body —
   *  never for an AI line, a colleague's note or an admin's own text, which exist in one
   *  language only. Given these three, this screen renders the SAME line from the reader's own
   *  pool, so one send reaches three languages. */
  poolName?: string;
  variantIndex?: string;
  fromPhrase?: string;
}

// Module constants, not literals in the JSX. FireworksBackground lists every one of these in
// its effect's dependency array, so a fresh array or a fresh {min,max} on each render tears the
// canvas down and rebuilds it — listeners, rAF and all. A full-screen card re-renders far more
// often than the old panel did, which is exactly when that starts to show.
const FIREWORK_COLORS = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#fb7185'];
const FIREWORK_SPEED = { min: 5, max: 9 };
const FIREWORK_SIZE = { min: 2, max: 5 };
const PARTICLE_SPEED = { min: 2, max: 7 };
const PARTICLE_SIZE = { min: 1, max: 4 };

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?';
}

/** Avatar + name + who they are. The same signature block wherever a person is named. */
function SignerFace({ sender, label, size }: { sender: Sender; label: string; size: 'sm' | 'md' }) {
  const md = size === 'md';
  return (
    <>
      <Avatar className={`shrink-0 rounded-full ${md ? 'h-10 w-10' : 'h-8 w-8'} ${sender.supervisor ? 'ring-2 ring-primary/40' : ''}`}>
        {sender.avatar_url ? <AvatarImage src={sender.avatar_url} alt={sender.name} /> : null}
        <AvatarFallback className={`rounded-full ${md ? 'text-xs' : 'text-[10px]'} font-semibold`}>
          {initials(sender.name)}
        </AvatarFallback>
      </Avatar>
      {/* No truncate: a signature with half a name on it is worse than one on two lines. */}
      <span className="min-w-0 text-left">
        <span className={`block font-medium leading-tight text-foreground ${md ? 'text-sm' : 'text-xs'}`}>
          {sender.name}
        </span>
        <span className={`block leading-tight text-muted-foreground ${md ? 'text-xs' : 'text-[10px]'}`}>
          {label}
        </span>
      </span>
    </>
  );
}

export default function GreetingStage({
  shown, viewerName, celebrate, onClose,
}: {
  shown: ShownGreeting;
  /** Stands in for meta.name on the two cards that have no notification doc. */
  viewerName: string;
  /** The reduced-motion decision taken when the card opened. See GreetingCard.reveal(). */
  celebrate: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const brand = useBrandName();
  const reduce = useReducedMotion();

  const occasion = shown.occasion;
  const yearsNum = Number(shown.years);
  const years = Number.isFinite(yearsNum) && shown.years ? yearsNum : null;

  // The whole name, never the first one. meta.name is already the full name for a server-sent
  // greeting; the client-only cards (a festival, the birthday fallback) have no doc, so the
  // signed-in user's own display name stands in — also full.
  const fullName = (shown.name ?? '').trim() || viewerName;

  const lang = useAppStore(s => s.lang);
  let resolvedSpecialTitle = shown.specialTitle;
  let resolvedSpecialMessage = shown.specialMessage;
  if (lang === 'si') {
    if (shown.specialTitleSi) resolvedSpecialTitle = shown.specialTitleSi;
    if (shown.specialMessageSi) resolvedSpecialMessage = shown.specialMessageSi;
  } else if (lang === 'ta') {
    if (shown.specialTitleTa) resolvedSpecialTitle = shown.specialTitleTa;
    if (shown.specialMessageTa) resolvedSpecialMessage = shown.specialMessageTa;
  }

  // What is being celebrated. The stored (English) title only leads for pre-meta docs, which
  // carry no occasion to translate.
  const occasionLine = shown.fallbackTitle
    ?? (occasion === 'birthday' ? t.greetingBirthdayTitle
      : occasion === 'anniversary' ? t.greetingAnniversaryTitle.replace('{years}', shown.years ?? '')
      : (resolvedSpecialTitle || t.greetingBirthdayTitle));

  // Only real human senders — exclude system accounts and admin service accounts.
  const validSenders = useMemo(() => (shown.senders ?? []).filter(s => (
    isHumanSenderName(s.name, s.role)
  )), [shown.senders]);

  // Helper to extract the message in the recipient's preferred language, falling back to English.
  const senderMessage = (s: Sender): string => {
    if (lang === 'si' && s.message_si?.trim()) return s.message_si.trim();
    if (lang === 'ta' && s.message_ta?.trim()) return s.message_ta.trim();
    return (s.message ?? '').trim();
  };

  // Someone wrote this person something. Their words ARE the message and the generic line is
  // not shown at all — a template underneath a personal note reads like a form letter with a
  // sticky note attached. mergeSenders() puts the authors first, so the first one with words is
  // the one whose note leads (most specific audience, then role depth).
  const personal = validSenders.find(s => senderMessage(s));

  // The pool line the server picked, rendered here from THIS reader's pool. Every language holds
  // the same lines in the same order, so index 7 is the same greeting in all three — which is
  // what lets one notification and one push serve a Sinhala reader, a Tamil reader and an
  // English one without the server writing three of everything.
  //
  // Null whenever the stored copy did not come from the pool, or came from a pool a newer
  // version of the app knows and this one does not. The stored English body then leads, which is
  // never wrong — only less local.
  const poolLine = useMemo(() => {
    if (!shown.poolName || shown.variantIndex === undefined) return null;
    return variantByName(shown.poolName, Number(shown.variantIndex), {
      first: firstCallingName(shown.name ?? ''),
      from:  shown.fromPhrase ?? '',
      brand,
      years: Number(shown.years ?? 0),
      title: resolvedSpecialTitle ?? '',
    }, lang === 'si' || lang === 'ta' ? lang : 'en');
  }, [shown.poolName, shown.variantIndex, shown.name, shown.fromPhrase, shown.years, brand, resolvedSpecialTitle, lang]);

  const message = (personal ? senderMessage(personal) : '')
    || poolLine
    || shown.fallbackBody
    || (occasion === 'birthday' ? t.greetingBirthdayBody
      : occasion === 'anniversary' ? t.greetingAnniversaryBody
      : (resolvedSpecialMessage || t.greetingSpecialBody));

  // Everyone else who wrote gets their own words, in their own block, under their own face —
  // that is the part of this screen worth building. The lead author is not repeated: their note
  // is already the message, signed directly beneath it.
  const notes = validSenders.filter(s => senderMessage(s) && s.epf !== personal?.epf);
  const roster = validSenders.filter(s => !senderMessage(s));
  const roleOf = (s: Sender) => (s.supervisor ? t.greetingYourSupervisor : s.role);

  // Fireworks are the birthday's alone; the other two have their own field behind them. The
  // one-shot matchMedia sample from reveal() decides whether the celebration was allowed at
  // all, and useReducedMotion() keeps watching — a card that stays up for a minute should stop
  // throwing a canvas at someone who changes the setting while reading it.
  const showFireworks = celebrate && !reduce && occasion === 'birthday';

  // Staged reveal: the field, then the occasion, then the name, then the message, then the
  // signatures, then the action. Reduced motion collapses every delay to zero so the whole
  // screen is simply THERE — a person who asked for less motion should not have to wait for
  // their own name.
  const stage = (step: number, extra = 0) => ({
    initial: reduce ? false : { opacity: 0, y: 14 },
    animate: { opacity: 1, y: 0 },
    transition: reduce
      ? { duration: 0 }
      : { duration: 0.5, delay: 0.18 + step * 0.24 + extra, ease: [0.22, 1, 0.36, 1] as const },
  });

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent
        hideClose
        // Full bleed. The primitive centres itself with left/top-1/2 and a pair of negative
        // translates, and none of that is undone by adding inset classes — every one of them
        // has to be named explicitly or the "full screen" panel sits half a viewport off in
        // both directions. Same story for the width, the radius, the border and the padding.
        className="left-0 top-0 flex h-[100dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-background/95 p-0 backdrop-blur-none"
      >
        {/* The occasion's own field, behind everything. */}
        <GreetingBackdrop occasion={occasion} className="absolute inset-0 z-0" />

        {/* Above the field, below the words. The old card portalled this to the body at z-115
            to slip between the overlay and a 448px panel; a full-screen panel would simply
            cover it, so it lives inside the card now and needs no portal at all. */}
        {showFireworks && (
          <div aria-hidden className="pointer-events-none absolute inset-0 z-[1]">
            <FireworksBackground
              className="size-full"
              population={4}
              color={FIREWORK_COLORS}
              fireworkSpeed={FIREWORK_SPEED}
              fireworkSize={FIREWORK_SIZE}
              particleSpeed={PARTICLE_SPEED}
              particleSize={PARTICLE_SIZE}
            />
          </div>
        )}

        {/* iOS puts a notch where this button wants to be. Note that nothing here is staged:
            the seen-stamp is already written by the time the screen paints, so this card can
            never be shown again — if the sequence below somehow never ran, this is the way out
            that is on screen from the first frame. */}
        <span className="safe-top-spacer relative z-10" />
        <div className="relative z-10 flex shrink-0 justify-end px-3 pt-3">
          <button
            type="button"
            onClick={onClose}
            aria-label={t.greetingClose}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card/70 text-muted-foreground backdrop-blur transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* The only scroller on the screen. m-auto rather than justify-center: auto margins go
            to zero the moment the content is taller than the box, so a card signed by eight
            people scrolls from its real top instead of having it cut off. */}
        <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain scrollbar-thin">
          <div className="m-auto w-full max-w-xl px-5 py-6 text-center sm:max-w-2xl sm:px-8">
            <motion.div {...stage(0)} className="flex justify-center">
              <OccasionMark
                occasion={occasion}
                years={years}
                yearsLabel={years === 1 ? t.greetingYearsOne : t.greetingYearsMany}
              />
            </motion.div>

            {/* The className goes on DialogTitle, not on the motion element: asChild makes Radix
                concatenate the two class lists verbatim, so only the primitive's own cn()
                (tailwind-merge) can drop its default type scale in favour of this one. */}
            <DialogTitle
              asChild
              className={occasion === 'special'
                // A festival's own title is long ("Sinhala and Tamil New Year's Day") and often
                // in Sinhala or Tamil. Tracked-out capitals would make it work to read, so it
                // gets sentence case at a readable size instead — which also stops the three
                // occasions opening with the same line of type.
                ? 'mt-6 block text-balance text-base font-semibold leading-snug tracking-normal text-warning sm:text-lg'
                : `mt-6 block text-balance text-xs font-semibold uppercase leading-normal tracking-[0.16em] sm:text-sm ${occasion === 'birthday' ? 'text-primary' : 'text-brand'}`}
            >
              <motion.p {...stage(1)}>{occasionLine}</motion.p>
            </DialogTitle>

            {/* The reader's own name, and the reason the screen exists. No truncate, no clamp:
                a long name wraps and the type steps down with the viewport. */}
            <motion.p
              initial={reduce ? false : { opacity: 0, y: 18, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              // Step 2 on the same grid as stage(), but with its own longer, slightly scaled
              // entrance — the name is the one beat on this screen that should land.
              transition={reduce ? { duration: 0 } : { duration: 0.65, delay: 0.66, ease: [0.22, 1, 0.36, 1] }}
              className="mt-3 text-balance text-[clamp(2rem,9.5vw,3.75rem)] font-bold leading-[1.06] tracking-tight text-foreground"
            >
              {fullName}
            </motion.p>

            {/* whitespace-pre-line: an admin's special-day message is typed in a textarea and
                its paragraph breaks are part of what they wrote. The message is never cut. */}
            {personal ? (
              <figure className="mt-7">
                <DialogDescription
                  asChild
                  className="whitespace-pre-line text-pretty text-lg leading-relaxed text-foreground sm:text-xl"
                >
                  <motion.blockquote {...stage(3)}>{message}</motion.blockquote>
                </DialogDescription>
                <motion.figcaption {...stage(3, 0.16)} className="mt-5 flex items-center justify-center gap-2.5">
                  <SignerFace sender={personal} label={roleOf(personal)} size="md" />
                </motion.figcaption>
              </figure>
            ) : (
              <DialogDescription
                asChild
                className="mt-6 block whitespace-pre-line text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg"
              >
                <motion.p {...stage(3)}>{message}</motion.p>
              </DialogDescription>
            )}

            {(notes.length > 0 || roster.length > 0) && (
              <motion.div {...stage(4)} className="mt-9">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {t.greetingFrom}
                </p>

                {notes.length > 0 && (
                  <div className="mt-4 space-y-3">
                    {notes.map((s, i) => (
                      <motion.figure
                        key={s.epf}
                        {...stage(4, 0.12 + i * 0.1)}
                        className="rounded-2xl border border-border bg-card/70 p-4 text-left backdrop-blur"
                      >
                        {/* Somebody's actual words. Never truncated, never clamped. */}
                        <blockquote className="whitespace-pre-line text-sm leading-relaxed text-foreground">
                          {senderMessage(s)}
                        </blockquote>
                        <figcaption className="mt-3 flex items-center gap-2.5 border-t border-border/60 pt-3">
                          <SignerFace sender={s} label={roleOf(s)} size="sm" />
                        </figcaption>
                      </motion.figure>
                    ))}
                  </div>
                )}

                {roster.length > 0 && (
                  <ul className="mt-4 flex flex-wrap items-center justify-center gap-2">
                    {roster.map((s, i) => (
                      <motion.li
                        key={s.epf}
                        {...stage(4, 0.12 + notes.length * 0.1 + i * 0.07)}
                        className="flex items-center gap-2 rounded-full border border-border bg-card/70 py-1 pl-1 pr-3 backdrop-blur"
                      >
                        <SignerFace sender={s} label={roleOf(s)} size="sm" />
                      </motion.li>
                    ))}
                  </ul>
                )}
              </motion.div>
            )}

            <motion.p {...stage(5)} className="mt-8 text-xs text-muted-foreground">
              {t.greetingBrandLine.replace('{app}', brand)}
            </motion.p>
          </div>
        </div>

        {/* Its own row, outside the scroller and above the home indicator: the one thing that
            must never be pushed off a phone screen is the way out. */}
        <motion.div
          {...stage(5, 0.08)}
          className="pb-safe-banner relative z-10 shrink-0 border-t border-border/60 bg-background/80 px-5 pt-3 backdrop-blur"
        >
          <button
            type="button"
            onClick={onClose}
            className="mx-auto block w-full max-w-sm rounded-xl bg-primary py-3 text-base font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
          >
            {t.birthdayThanks}
          </button>
        </motion.div>
      </DialogContent>
    </Dialog>
  );
}
