'use client';
import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { useAuthStore } from '@/store/authStore';
import { useNotificationsStore, type CenterNotif } from '@/store/notificationsStore';
import { useLanyardStore } from '@/store/lanyardStore';
import { markNotificationReadRemote } from '@/services/notificationService';
import { monthDayMatches, specialDaysOn, type Sender } from '@/lib/greetings';
import { onOpenGreeting } from '@/components/greetings/openGreeting';
import { readGreetingSettingsForDevice } from '@/services/greetingsSettingsService';
import GreetingStage, { type ShownGreeting as Shown } from '@/components/greetings/GreetingStage';

// The celebration card. Replaces BirthdayWish. It opens five ways:
//   (0) from a bell tap, via the openGreeting event — no navigation, works on any page;
//   (1) from a cold open (a push tap), via ?greeting=<docId>;
//   (2) once by itself when a greeting addressed to this user arrived today;
//   (3) once by itself on a company-wide special day, resolved on THIS DEVICE from the
//       settings document — the server never sends those (see the effect for why);
//   (4) as a plain birthday card when the user's own birthday is today but no greeting doc
//       exists, which is exactly what BirthdayWish did, so a misconfigured scheduler
//       regresses nothing.
//
// This file owns WHEN a card opens and nothing about how it looks; GreetingStage is the screen.
// Every path funnels through reveal() and openById(), which is the seam that lets the whole
// presentation be replaced without going near the read-marking or the seen stamps.

function parseSenders(raw?: string): Sender[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v)
      ? (v as Sender[]).filter(s => s && typeof s.epf === 'string' && typeof s.name === 'string')
      : [];
  } catch { return []; }
}

function fromNotif(
  id: string, type: string, meta: Record<string, string> | undefined, title: string, body: string,
): Shown | null {
  if (type !== 'greeting' && meta?.birthday !== '1') return null;
  const m = meta ?? {};
  const occasion = (m.occasion === 'anniversary' || m.occasion === 'special') ? m.occasion : 'birthday';
  return {
    docId: id, occasion, years: m.years,
    specialTitle: m.special_title, specialMessage: m.special_message,
    specialTitleSi: m.special_title_si, specialMessageSi: m.special_message_si,
    specialTitleTa: m.special_title_ta, specialMessageTa: m.special_message_ta,
    name: m.name, senders: parseSenders(m.senders),
    // The pool line the server chose, so this device can render it in its reader's language.
    poolName: m.pool, variantIndex: m.variant, fromPhrase: m.from,
    fallbackTitle: m.occasion ? undefined : title,
    fallbackBody:  m.occasion ? undefined : body,
  };
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function GreetingCard() {
  const user = useAuthStore(s => s.user);
  const items = useNotificationsStore(s => s.items);
  const markRead = useNotificationsStore(s => s.markRead);
  const lanyardOpen = useLanyardStore(s => s.open);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [shown, setShown] = useState<Shown | null>(null);
  const [fireworks, setFireworks] = useState(false);

  const epf = user?.epf_number ?? '';
  const paramId = params.get('greeting');

  const reveal = (s: Shown) => {
    const reduceMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setShown(s);
    setFireworks(!reduceMotion);
  };

  const stamp = (key: string) => { try { localStorage.setItem(key, new Date().toISOString()); } catch { /* non-critical */ } };
  const seen  = (key: string) => { try { return !!localStorage.getItem(key); } catch { return false; } };

  const markDocRead = (docId: string) => {
    markRead(`fs-${docId}`);
    void markNotificationReadRemote(docId).catch(() => { /* best-effort */ });
  };

  // Open one greeting by its notification doc id, whatever asked for it. The bell already
  // holds the doc (meta and all) in the notifications store, so a tap opens the card with no
  // round trip; a cold open from a push has an empty store and reads the doc instead. Either
  // way the greeting must be addressed to THIS user — the id is convenience, never authority,
  // and the store's own `direct` flag is set from a query already filtered by EPF.
  const openById = async (docId: string): Promise<void> => {
    const cached = useNotificationsStore.getState().items
      .find(n => n.id === `fs-${docId}` && n.direct);
    const s = cached
      ? fromNotif(docId, cached.type, cached.meta, cached.title, cached.body)
      : await (async () => {
        try {
          const snap = await getDoc(doc(db, 'notifications', docId));
          if (!snap.exists()) return null;
          const d = snap.data();
          if (String(d.to_epf ?? '') !== String(epf)) return null;
          return fromNotif(docId, String(d.type ?? ''), d.meta, String(d.title ?? ''), String(d.body ?? ''));
        } catch { return null; }   // unreadable — ignore
      })();
    if (!s) return;
    reveal(s);
    stamp(`pc-greeting-seen-${docId}`);
    markDocRead(docId);
  };

  // The device's half of the send. It does NOT send anything — it reports that somebody is
  // awake, and the server decides (src/app/api/greetings/catch-up/route.ts carries the whole
  // reasoning). A phone cannot wake itself at 08:00 on the web: no background execution, and
  // Periodic Background Sync does not exist on iOS at all. What a phone CAN do is notice, on
  // opening, that the morning looks uncovered — which is exactly the case the 08:00 job cannot
  // cover for itself, because a job that did not run cannot report that it did not run.
  //
  // Cheap by construction: once per device per day (the stamp below), and the server answers
  // `already_run` after one small document read whenever the job did fire. Duplicates are
  // impossible whatever happens here — deliverGreeting claims a per-person marker with
  // `.create()`, so a second sender writes nothing. Failures are silent on purpose: this is a
  // safety net, and a net that interrupts the reader to announce itself is a worse product
  // than a late birthday card.
  useEffect(() => {
    if (!epf) return;
    // localToday(), not toISOString(): Colombo is UTC+5:30, so a UTC date string rolls over at
    // 05:30 local and would put the small hours of one morning under the previous day's key.
    const key = `pc-greeting-catchup-${localToday()}`;
    if (seen(key)) return;
    // Stamped BEFORE the request, deliberately: one attempt per device per day whether it
    // succeeds, fails, or the tab closes mid-flight. A retry loop here would turn a server
    // having a bad morning into three hundred phones hammering it.
    stamp(key);
    void (async () => {
      try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) return;
        await fetch('/api/greetings/catch-up', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        });
      } catch { /* best-effort: the 08:00 job is the primary path; this is only the net */ }
    })();
  }, [epf]);

  // (0) A tap in the bell. No navigation at all: the card lives in the app shell, so it can
  // open over whatever page the reader is on. Routing to /dashboard?greeting=<id> was the old
  // way and it silently did nothing whenever the reader was already on /dashboard.
  useEffect(() => {
    if (!epf) return;
    return onOpenGreeting(docId => { if (!lanyardOpen) void openById(docId); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epf, lanyardOpen]);

  // (1) Cold open: ?greeting=<docId> on any page — this is what a push tap lands on.
  useEffect(() => {
    if (!paramId || !epf || lanyardOpen) return;
    let cancelled = false;
    (async () => {
      try {
        await openById(paramId);
      } catch { /* unreadable — ignore */ }
      finally {
        if (cancelled) return;
        // Strip the param so a reload does not reopen the card.
        const next = new URLSearchParams(params.toString());
        next.delete('greeting'); next.delete('_r');
        const qs = next.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramId, epf, lanyardOpen]);

  // (2) Auto-open once: a greeting addressed to me that arrived today and was not yet seen.
  const todaysGreeting = useMemo<CenterNotif | null>(() => {
    if (!epf) return null;
    const today = localToday();
    return items.find(n => n.direct && n.id.startsWith('fs-') && n.type === 'greeting'
      && n.time.slice(0, 10) === today) ?? null;
  }, [items, epf]);

  useEffect(() => {
    if (shown || paramId || lanyardOpen || !todaysGreeting) return;
    const docId = todaysGreeting.id.slice(3);
    const key = `pc-greeting-seen-${docId}`;
    if (seen(key)) return;
    const s = fromNotif(docId, todaysGreeting.type, todaysGreeting.meta, todaysGreeting.title, todaysGreeting.body);
    if (!s) return;
    stamp(key);
    reveal(s);
    markDocRead(docId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todaysGreeting, lanyardOpen, paramId, shown]);

  // (3) Company-wide special days, resolved and rendered ON THIS DEVICE. Every employee gets
  // the same words on the same date, so the server writing one notification and one push per
  // person would be hundreds of sends to say one identical sentence. The settings document is
  // client-readable, so each device works out its own festival card. The trade is that a
  // special day has no push when the app is closed: it greets you when you next open it.
  // Birthdays and anniversaries stay server-side, where the push matters and the volume is low.
  useEffect(() => {
    if (shown || paramId || lanyardOpen || !epf) return;
    let cancelled = false;
    (async () => {
      const settings = await readGreetingSettingsForDevice();
      if (cancelled || !settings.enabled || !settings.special) return;
      const today = localToday();
      // No calendar is passed: the settings screen freezes a calendar-linked day's date onto
      // the row when it is saved, so resolution here needs nothing but the row itself.
      const due = specialDaysOn(settings.special_days, today)[0];
      if (!due) return;
      const key = `pc-specialday-${due.id}-${today}`;
      if (seen(key)) return;
      stamp(key);
      reveal({
        docId: null, occasion: 'special', senders: [],
        specialTitle: due.title, specialMessage: due.message,
        specialTitleSi: due.title_si, specialMessageSi: due.message_si,
        specialTitleTa: due.title_ta, specialMessageTa: due.message_ta,
      });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epf, lanyardOpen, paramId, shown, todaysGreeting]);

  // (4) Fallback: my own birthday and no greeting doc for today — the old BirthdayWish path.
  // Waits a few seconds first so a real greeting (with signatures) always wins.
  useEffect(() => {
    if (shown || paramId || lanyardOpen || !epf || !user?.date_of_birth || todaysGreeting) return;
    const today = localToday();
    if (!monthDayMatches(user.date_of_birth, today)) return;
    const key = `pc-birthday-seen-${epf}-${today.slice(0, 4)}`;
    if (seen(key)) return;
    const timer = setTimeout(() => {
      const arrived = useNotificationsStore.getState().items
        .some(n => n.type === 'greeting' && n.time.slice(0, 10) === today);
      if (arrived) return;
      stamp(key);
      reveal({ docId: null, occasion: 'birthday', senders: [] });
    }, 4000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epf, user?.date_of_birth, todaysGreeting, lanyardOpen, paramId, shown]);

  const close = () => { setShown(null); setFireworks(false); };

  if (!shown) return null;

  return (
    <GreetingStage
      shown={shown}
      viewerName={(user?.name ?? '').trim()}
      celebrate={fireworks}
      onClose={close}
    />
  );
}
