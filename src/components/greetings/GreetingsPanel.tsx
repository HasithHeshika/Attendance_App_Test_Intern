'use client';
// The greetings surface in the bell — what this user has been sent, and what they may write.
//
// One dialog for everybody, and what is inside it is decided by who opens it. A technician sees
// the cards they were sent and can re-open any of them; an executive also gets a composer
// scoped to the people under them; top management and system admins get the company-wide
// audience as well. The scoping is not decided here: the route answers with `allowed`, which is
// canAuthor() run server-side. What changed is that the three audiences are now always DRAWN —
// the one the server withheld is drawn disabled, with the reason in words. Silently omitting
// "My team" read as a missing feature; saying "nobody reports to you" is an answer. It is still
// `allowed` that decides what may be SENT, because a UI that offered an audience the server
// refuses would be lying twice.
//
// The dialog is one shell with three modes — the shelf you land on, the composer, and the
// person picker — rather than one ever-growing column. That is what keeps the promise this
// surface has to keep on a 360px phone: exactly one scroll region, and Save outside it.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  PartyPopper, Cake, Award, Sparkles, Loader2, Plus, Pencil, Trash2, Users, UserRound,
  UsersRound, Search, Check, AlertTriangle, ChevronRight, ChevronLeft, Wand2, Gift, PenLine,
  Lock, PauseCircle,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import ConfirmModal from '@/components/ConfirmModal';
import { BlockHeader, SwitchButton } from '@/components/system-settings/greetings/parts';
import { cn } from '@/lib/utils';
import { useT } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';
import { useNotificationsStore } from '@/store/notificationsStore';
import { openGreeting } from '@/components/greetings/openGreeting';
import type { OccasionKind } from '@/lib/greetings';
import {
  GREETING_AUDIENCES, GREETING_MESSAGE_MAX, type GreetingAudience, type OccasionSlot,
} from '@/lib/greetingMessages';
import {
  deleteGreetingMessage, draftGreetingMessage, draftGreetingMessageAll, getGreetingComposerData, saveGreetingMessage,
  type GreetingComposerData, type GreetingMessageRow,
} from '@/services/greetingMessagesService';

const OCCASIONS: readonly OccasionKind[] = ['birthday', 'anniversary', 'special'];

type Mode = 'shelf' | 'compose' | 'pick';
/** Only so the slide knows which way it is going; shelf -> compose -> pick reads left to right. */
const MODE_DEPTH: Record<Mode, number> = { shelf: 0, compose: 1, pick: 2 };

/** Uppercase micro-caps belong on field labels, not on section headings. */
const FIELD_LABEL = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground';

/** The house focus ring. These groups are bare <button>s and globals.css has no `:focus-visible`
 *  rule to fall back on, so a control without this line has no visible focus state at all. */
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring '
  + 'focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/** A day chip. min-h-9 because everything else in this dialog is 36px or 44px, and on a 360px
 *  phone the two smallest things must not be the ones you tap most. */
const CHIP = 'inline-flex min-h-9 items-center gap-1 rounded-full border px-3 py-1 '
  + `text-[11px] font-semibold transition-colors ${FOCUS_RING}`;
const CHIP_ON = 'border-primary bg-primary/10 text-foreground';
const CHIP_OFF = 'border-border text-muted-foreground hover:bg-accent';

const GROUP_KEYS = new Set(['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End']);

/**
 * The keyboard half of a radiogroup or a tablist.
 *
 * ARIA says each of those is ONE tab stop and the arrow keys move inside it. Declaring the role
 * without the keys is worse than not declaring it: the reader is told "2 of 50", presses Down,
 * and nothing happens — and Tab walks all fifty names on the way to the next control. This walks
 * whatever options the group actually rendered, so three audience rows and fifty colleagues use
 * the same code. Returns the option focus landed on, or null when the key was not ours.
 */
function moveWithinGroup(e: ReactKeyboardEvent<HTMLElement>): HTMLElement | null {
  if (!GROUP_KEYS.has(e.key)) return null;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-group-option]'));
  if (!items.length) return null;
  e.preventDefault();
  const from = items.indexOf(document.activeElement as HTMLElement);
  const last = items.length - 1;
  const to = e.key === 'Home' ? 0
    : e.key === 'End' ? last
      : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
        ? (from <= 0 ? last : from - 1)
        : (from < 0 || from >= last ? 0 : from + 1);
  const el = items[to];
  el.focus();
  return el;
}

function OccasionIcon({ kind, className = 'h-3.5 w-3.5' }: { kind: OccasionKind; className?: string }) {
  if (kind === 'birthday') return <Cake className={className} aria-hidden />;
  if (kind === 'anniversary') return <Award className={className} aria-hidden />;
  return <Sparkles className={className} aria-hidden />;
}

function AudienceIcon({ audience, className = 'h-3.5 w-3.5' }: { audience: GreetingAudience; className?: string }) {
  if (audience === 'everyone') return <Users className={className} aria-hidden />;
  if (audience === 'my_team') return <UsersRound className={className} aria-hidden />;
  return <UserRound className={className} aria-hidden />;
}

interface Draft {
  id?: string;
  audience: GreetingAudience;
  target_epf: string;
  occasions: OccasionKind[];
  special_day_ids: string[];
  message: string;
  message_si?: string;
  message_ta?: string;
  enabled: boolean;
}

/** The wording this row leads with, whichever shape it was stored in. New rows carry `messages`
 *  per occasion and no `message` at all, so reading `row.message` alone printed an empty line
 *  for every note saved since wordings went per-occasion.
 *
 *  Which slot leads is decided by the row's OWN first occasion, never by the order the keys
 *  happen to come out in. A note ticked for birthdays and work anniversaries stores a slot for
 *  each; 'anniversary' sorts ahead of 'birthday', so taking whatever came first showed the
 *  anniversary wording on a birthday note — and then re-saved it over the birthday one, because
 *  this is also what prefills the composer. */
function leadWordingOf(row: GreetingMessageRow): string {
  const map = row.messages ?? {};
  for (const kind of row.occasions) {
    const slots: OccasionSlot[] = kind === 'special'
      ? [...row.special_day_ids.map(id => `special:${id}` as OccasionSlot), 'special']
      : [kind];
    for (const slot of slots) {
      const line = map[slot]?.[0];
      if (line) return line;
    }
  }
  return row.message ?? Object.values(map)[0]?.[0] ?? '';
}

function draftOf(row: GreetingMessageRow): Draft {
  return {
    id: row.id,
    audience: row.audience,
    target_epf: row.target_epf ?? '',
    occasions: row.occasions,
    special_day_ids: row.special_day_ids,
    message: leadWordingOf(row),
    message_si: row.message_si ?? '',
    message_ta: row.message_ta ?? '',
    enabled: row.enabled,
  };
}

export default function GreetingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const user = useAuthStore(s => s.user);
  const items = useNotificationsStore(s => s.items);
  const reduce = useReducedMotion();

  const [data, setData] = useState<GreetingComposerData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [activeLang, setActiveLang] = useState<'en' | 'si' | 'ta'>('en');
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<GreetingMessageRow | null>(null);
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<Mode>('shelf');
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backBtnRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const runIdRef = useRef(0);
  const prevModeRef = useRef<Mode>('shelf');
  // Set when we come back to the shelf, cleared by the Write button when it mounts. See the mode
  // effect for why the focus cannot simply be taken there.
  const wantShelfFocusRef = useRef(false);
  // What the draft looked like when the composer opened, so "are there unsaved words in here?"
  // is answered by comparison rather than by "is anything typed" — an edit starts full.
  const draftBaselineRef = useRef('');

  // Greetings this person has actually been sent, newest first. They live in the notifications
  // store already, so re-opening one costs no round trip — which is the point of listing them
  // here rather than sending the reader back to hunt through the bell.
  const received = useMemo(
    () => items
      .filter(n => n.type === 'greeting' && n.id.startsWith('fs-'))
      .sort((a, b) => b.time.localeCompare(a.time))
      .slice(0, 12),
    [items],
  );

  // Pulled out of the effect so the error state can offer a real retry rather than asking the
  // reader to close the dialog and open it again.
  // A token per call, not one shared "cancelled" flag: the flag was cleared again by the NEXT
  // load, so a request abandoned when the dialog closed came back to life the moment it was
  // reopened, and two loads in flight (double-tap on Try again) landed in latency order rather
  // than in the order they were asked for.
  const load = useCallback(async () => {
    const run = ++runIdRef.current;
    setLoading(true);
    setError('');
    try {
      const d = await getGreetingComposerData();
      if (runIdRef.current === run) setData(d);
    } catch (e) {
      // Surfaced, never swallowed: "the composer is missing" and "the composer failed to load"
      // look identical to a reader, and only one of them is their problem.
      if (runIdRef.current === run) setError(e instanceof Error ? e.message : t.gmLoadFailed);
    } finally {
      if (runIdRef.current === run) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    void load();
    // Bumping the token abandons whatever is in flight — including a load the retry button
    // started, which the old per-effect closure could not reach at all.
    return () => { runIdRef.current++; };
  }, [open, load]);

  useEffect(() => {
    // `mode` resets with the rest of it, or the next person to open the bell lands in somebody
    // else's half-written note.
    if (!open) {
      setDraft(null); setQ(''); setConfirmDelete(null); setConfirmDiscard(false);
      setActiveLang('en'); setMode('shelf');
      wantShelfFocusRef.current = false;
    }
  }, [open]);

  const dir = MODE_DEPTH[mode] >= MODE_DEPTH[prevModeRef.current] ? 1 : -1;

  useEffect(() => {
    const changed = prevModeRef.current !== mode;
    prevModeRef.current = mode;
    if (!changed) return;
    // One scroll region for three screens means the scroller has to be sent back to the top by
    // hand — otherwise you arrive at the composer already halfway down it.
    scrollRef.current?.scrollTo({ top: 0 });
    // The picker focuses its own search box instead — you arrive there to type a name, and
    // two things reaching for the focus on the same frame is how one of them loses.
    //
    // The shelf cannot be focused from here. AnimatePresence mode="wait" holds the composer
    // mounted for the whole of its exit, so on this commit the Write button does not exist yet
    // and the control that HAD focus (Back, or Cancel) is already gone — which dropped the
    // keyboard on document.body every time a note was saved. The flag hands the job to the
    // button itself, which takes the focus in its own ref callback once it mounts.
    if (mode === 'shelf') wantShelfFocusRef.current = true;
    else if (mode === 'compose') backBtnRef.current?.focus();
  }, [mode]);

  const allowed = data?.allowed ?? [];
  const mayWrite = allowed.length > 0;
  const may = (a: GreetingAudience) => allowed.includes(a);

  const startNew = () => {
    const audience = allowed[0] ?? 'person';
    const fresh: Draft = {
      audience,
      target_epf: '',
      occasions: ['birthday'],
      special_day_ids: [],
      message: '',
      message_si: '',
      message_ta: '',
      enabled: true,
    };
    setDraft(fresh);
    draftBaselineRef.current = JSON.stringify(fresh);
    setActiveLang('en');
    setQ('');
  };

  const openCompose = () => { startNew(); setMode('compose'); };
  const editRow = (m: GreetingMessageRow) => {
    const d = draftOf(m);
    setDraft(d);
    draftBaselineRef.current = JSON.stringify(d);
    setActiveLang('en'); setQ(''); setMode('compose');
  };
  const backToShelf = () => { setDraft(null); setMode('shelf'); };

  // Every field of the draft, not just the words: an author who ticked a second occasion and
  // nothing else has still done work Escape must not throw away.
  const dirty = !!draft && JSON.stringify(draft) !== draftBaselineRef.current;
  const leaveCompose = () => { if (dirty) setConfirmDiscard(true); else backToShelf(); };

  const people = useMemo(() => {
    const list = data?.people ?? [];
    const s = q.trim().toLowerCase();
    const base = s ? list.filter(p => p.name.toLowerCase().includes(s) || p.epf.toLowerCase().includes(s)) : list;
    return base.slice(0, 50);
  }, [data?.people, q]);

  const toggleOccasion = (kind: OccasionKind) => setDraft(d => {
    if (!d) return d;
    const on = d.occasions.includes(kind);
    const occasions = on ? d.occasions.filter(o => o !== kind) : [...d.occasions, kind];
    // Dropping Special days drops the day filter with it, or a hidden list would keep
    // narrowing a message whose author can no longer see that it is narrowed.
    return { ...d, occasions, ...(kind === 'special' && on ? { special_day_ids: [] } : {}) };
  });

  const toggleSpecialDay = (id: string) => setDraft(d => {
    if (!d) return d;
    const on = d.special_day_ids.includes(id);
    return { ...d, special_day_ids: on ? d.special_day_ids.filter(x => x !== id) : [...d.special_day_ids, id] };
  });

  const valueForLang = (d: Draft, lang: 'en' | 'si' | 'ta'): string =>
    lang === 'si' ? (d.message_si ?? '') : lang === 'ta' ? (d.message_ta ?? '') : d.message;

  const setValueForLang = (text: string) => setDraft(d => {
    if (!d) return d;
    if (activeLang === 'si') return { ...d, message_si: text };
    if (activeLang === 'ta') return { ...d, message_ta: text };
    return { ...d, message: text };
  });

  // One click drafts all three languages (EN + SI + TA) in a single server round trip.
  // The author can still edit each tab manually, or use the per-tab translate button.
  const aiDraftAll = async () => {
    if (!draft || drafting || translating) return;
    if (draft.audience === 'person' && !draft.target_epf) { toast.error(t.gmPickPerson); return; }
    if (!draft.occasions.length) { toast.error(t.gmOccasions); return; }
    setDrafting(true);
    try {
      const result = await draftGreetingMessageAll({
        audience: draft.audience,
        target_epf: draft.target_epf || null,
        occasions: draft.occasions,
        special_title: data?.special_days.find(d => draft.special_day_ids.includes(d.id))?.title,
      });
      if (!result.en) { toast.error(t.gmAiFailed); return; }
      setDraft(d => {
        if (!d) return d;
        return {
          ...d,
          message:    (result.en ?? '').slice(0, GREETING_MESSAGE_MAX),
          message_si: result.si ? result.si.slice(0, GREETING_MESSAGE_MAX) : d.message_si,
          message_ta: result.ta ? result.ta.slice(0, GREETING_MESSAGE_MAX) : d.message_ta,
        };
      });
      // Switch to English tab so the author reviews the primary language first
      setActiveLang('en');
      // Which languages came back is already on the tabs as a check mark; what the author needs
      // told is that the words are theirs to change now.
      toast.success(t.gmAiDrafted);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t.gmAiFailed);
    } finally {
      setDrafting(false);
    }
  };

  // Translates the English message into natural Sinhala or Tamil via Gemini, preserving all placeholders.
  const translateWithAi = async () => {
    if (!draft || translating || drafting) return;
    if (activeLang === 'en') return;
    const source = draft.message.trim();
    // The button stays enabled with no English behind it, so the reason gets SAID rather than
    // leaving a greyed-out control the author has to guess at.
    if (!source) {
      toast.error(t.gmTranslateNeedsEnglish);
      return;
    }
    setTranslating(true);
    try {
      const text = await draftGreetingMessage({
        audience: draft.audience,
        target_epf: draft.target_epf || null,
        occasions: draft.occasions,
        language: activeLang,
        translate_from: source,
      });
      if (!text) { toast.error(t.gmAiFailed); return; }
      setDraft(d => {
        if (!d) return d;
        const clean = text.slice(0, GREETING_MESSAGE_MAX);
        if (activeLang === 'si') return { ...d, message_si: clean };
        if (activeLang === 'ta') return { ...d, message_ta: clean };
        return d;
      });
      // In the reader's language, not the target's — the person reading this toast is the author.
      toast.success(t.gmTranslated);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t.gmAiFailed);
    } finally {
      setTranslating(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    // Belt and braces, but never silent. A note written for "My team" back when someone had
    // reports still opens for editing after the last of them leaves, and a bare return turned
    // Save into a button that does nothing at all — the old panel at least surfaced the
    // server's 403. Say the same thing the closed row says, in the same words. canAuthor()
    // re-runs server-side and answers 403 either way.
    if (!allowed.includes(draft.audience)) {
      toast.error(draft.audience === 'my_team' ? t.gmAudienceTeamNone : t.gmAudienceEveryoneNo);
      return;
    }
    if (draft.audience === 'person' && !draft.target_epf) { toast.error(t.gmPickPerson); return; }
    if (!draft.occasions.length) { toast.error(t.gmOccasions); return; }
    if (!draft.message.trim()) {
      setActiveLang('en');
      toast.error(t.gmMessage);
      return;
    }
    setSaving(true);
    try {
      const row = await saveGreetingMessage({
        id: draft.id,
        audience: draft.audience,
        target_epf: draft.audience === 'person' ? draft.target_epf : null,
        occasions: draft.occasions,
        special_day_ids: draft.special_day_ids,
        message: draft.message.trim(),
        message_si: draft.message_si?.trim() || undefined,
        message_ta: draft.message_ta?.trim() || undefined,
        enabled: draft.enabled,
      });
      // Replace in place when it was an edit, prepend when it is new — the route answers with
      // the stored row, so the list shows what was actually saved rather than what was typed.
      if (row) {
        setData(d => d && ({
          ...d,
          messages: d.messages.some(m => m.id === row.id)
            ? d.messages.map(m => (m.id === row.id ? row : m))
            : [row, ...d.messages],
        }));
      }
      setDraft(null);
      setMode('shelf');
      toast.success(t.gmSaved);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t.gmSaveFailed);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: GreetingMessageRow) => {
    setSaving(true);
    try {
      await deleteGreetingMessage(row.id);
      setData(d => d && ({ ...d, messages: d.messages.filter(m => m.id !== row.id) }));
      if (draft?.id === row.id) { setDraft(null); setMode('shelf'); }
      toast.success(t.gmDeleted);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t.gmDeleteFailed);
    } finally {
      setSaving(false);
    }
  };

  const audienceLabel = (a: GreetingAudience): string =>
    a === 'everyone' ? t.gmAudienceEveryone : a === 'my_team' ? t.gmAudienceTeam : t.gmAudiencePerson;

  const occasionLabel = (o: OccasionKind): string =>
    o === 'birthday' ? t.gmOccasionBirthday : o === 'anniversary' ? t.gmOccasionAnniversary : t.gmOccasionSpecial;

  const langFullName = (lang: 'en' | 'si' | 'ta'): string =>
    lang === 'si' ? t.gmLangSinhala : lang === 'ta' ? t.gmLangTamil : t.gmLangEnglish;

  const langNativeName = (lang: 'en' | 'si' | 'ta'): string =>
    lang === 'si' ? t.gmLangSiNative : lang === 'ta' ? t.gmLangTaNative : t.gmLangEnNative;

  // What the recipient will actually read, with the placeholders resolved against the author
  // themselves. Their own name is the one name they can check at a glance.
  const preview = (text: string, lang: 'en' | 'si' | 'ta' = 'en'): string => {
    const rawFirst = (user?.name ?? '').trim().split(/\s+/)[0];
    const rawFull = (user?.name ?? '').trim();
    const fallbackFirst = lang === 'si' ? 'නිමල්' : lang === 'ta' ? 'நிமல்' : 'Nimal';
    const fallbackFull = lang === 'si' ? 'නිමල් සිල්වා' : lang === 'ta' ? 'நிமல் சில்வா' : 'Nimal Silva';
    return text
      .replace(/\{first_name\}/g, rawFirst || fallbackFirst)
      .replace(/\{name\}/g, rawFull || fallbackFull)
      .replace(/\{years\}/g, '5');
  };

  // Insert at the caret rather than describing the syntax underneath the box — the tokens are
  // the whole reason a note written once reads personally to 112 people.
  const insertToken = (token: string) => {
    if (!draft) return;
    const el = textareaRef.current;
    const cur = valueForLang(draft, activeLang);
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    const next = (cur.slice(0, start) + token + cur.slice(end)).slice(0, GREETING_MESSAGE_MAX);
    setValueForLang(next);
    requestAnimationFrame(() => {
      el?.focus();
      const caret = Math.min(start + token.length, next.length);
      el?.setSelectionRange(caret, caret);
    });
  };

  // The one sentence in this dialog that says nothing will actually be delivered, so it is the
  // last place to spend --warning on the text itself: amber on card measures 3.17:1 in light
  // mode. The icon and the border carry the colour, the words are read at full contrast.
  const disabledBanner = data && !data.greetings_enabled ? (
    <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-foreground">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
      <span>{t.gmDisabledWarning}</span>
    </p>
  ) : null;

  const editingRow = draft?.id ? (data?.messages.find(m => m.id === draft.id) ?? null) : null;
  // Two ways a save flattens a row's wordings, and the notice has to cover both: several
  // alternates inside one slot, and a different wording per slot (one for birthdays, another for
  // work anniversaries). This composer posts a single string, so either way saving replaces the
  // lot — counting distinct wordings across the whole row catches both in one line.
  const hasVariants = !!editingRow
    && new Set(Object.values(editingRow.messages ?? {}).flat().filter(Boolean)).size > 1;

  const headerDesc = mode === 'compose'
    ? t.gmSaveMeans
    : mode === 'pick'
      ? t.gmPickPerson
      : mayWrite ? t.greetingsPanelDesc : t.gmPanelDescReader;

  const headerTitle = mode === 'compose'
    ? (draft?.id ? t.gmEdit : t.gmNewGreeting)
    : mode === 'pick' ? t.gmAudiencePerson : t.greetingsPanelTitle;

  /* ── The shelf: what I was sent, and what I have written ── */
  const receivedBlock = (
    <>
      <BlockHeader
        icon={Gift}
        title={t.gmReceived}
        description={t.gmReceivedHint}
        badge={received.length > 0 && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
            {received.length}
          </span>
        )}
      />
      {received.length === 0 ? (
        <EmptyState
          className="py-8"
          icon={PartyPopper}
          title={t.gmReceivedEmptyTitle}
          description={t.gmReceivedEmpty}
          action={mayWrite ? (
            <Button size="sm" variant="ghost" onClick={openCompose}>{t.gmWrite}</Button>
          ) : undefined}
        />
      ) : (
        <ul className="mt-3 space-y-1.5">
          {received.map(n => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => { onClose(); openGreeting(n.id.slice(3)); }}
                className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                  <PartyPopper className="h-3.5 w-3.5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-foreground">{n.title}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {new Date(n.time).toLocaleDateString()}
                  </span>
                </span>
                {/* --brand on card is 3.93:1 in light mode, which is under AA for text this
                    small. The chevron and the row itself are the affordance; the words are
                    read at full contrast. */}
                <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-medium text-foreground">
                  {t.gmOpenCard}<ChevronRight className="h-3 w-3 text-brand" aria-hidden />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  const noteList = (
    <ul className="mt-3 space-y-2">
      {(data?.messages ?? []).map(m => {
        const wording = leadWordingOf(m);
        const langs: Array<{ key: 'en' | 'si' | 'ta'; on: boolean }> = [
          { key: 'en', on: true },
          { key: 'si', on: !!m.message_si },
          { key: 'ta', on: !!m.message_ta },
        ];
        return (
          <li
            key={m.id}
            className={cn(
              'rounded-lg border bg-card/40 px-3 py-2.5',
              m.enabled ? 'border-border' : 'border-dashed border-border',
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
                    <AudienceIcon audience={m.audience} className="h-3 w-3 text-brand" />
                    {audienceLabel(m.audience)}
                  </span>
                  {/* A person note names the person. "Reaches 1 people" was never worth a plural rule. */}
                  <span className="text-[10px] text-muted-foreground">
                    {m.audience === 'person'
                      ? (m.target_name ?? m.target_epf ?? '')
                      : t.gmReach.replace('{n}', String(m.reach))}
                  </span>
                </div>
                <p className={cn('mt-1 line-clamp-2 text-xs', m.enabled ? 'text-foreground' : 'text-muted-foreground')}>
                  {wording}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  {m.occasions.map(o => (
                    <span key={o} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                      <OccasionIcon kind={o} className="h-3 w-3" />{occasionLabel(o)}
                    </span>
                  ))}
                  {m.occasions.includes('special') && m.special_day_ids.length === 0 && (
                    <span className="text-[10px] text-muted-foreground">· {t.gmSpecialAll}</span>
                  )}
                </div>
                {/* Which languages exist, told by a mark and a dashed outline — --success and
                    --primary are the same azure here, so colour could not have carried it. */}
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {langs.map(l => (
                    <span
                      key={l.key}
                      className={cn(
                        'px-1.5 py-0.5 text-[9px]',
                        l.on
                          ? 'inline-flex items-center gap-1 rounded bg-foreground/10 font-semibold text-foreground'
                          : 'rounded border border-dashed border-border text-muted-foreground',
                      )}
                    >
                      {l.on && <Check className="h-2.5 w-2.5" aria-hidden />}
                      {langNativeName(l.key)}
                    </span>
                  ))}
                </div>
                {!m.enabled && (
                  <p className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                    <PauseCircle className="h-3 w-3" aria-hidden />{t.gmPausedHint}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button" aria-label={t.gmEdit} title={t.gmEdit}
                  onClick={() => editRow(m)}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button" aria-label={t.gmDelete} title={t.gmDelete}
                  onClick={() => setConfirmDelete(m)}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );

  const writtenBlock = (
    <>
      <BlockHeader
        icon={PenLine}
        title={t.gmMine}
        description={t.gmMineHint}
        action={mayWrite && (
          <Button
            // Takes the focus itself on the way back from the composer. The mode effect cannot:
            // this button is not mounted yet when it runs.
            ref={el => {
              if (el && wantShelfFocusRef.current) { wantShelfFocusRef.current = false; el.focus(); }
            }}
            type="button" size="sm" variant="outline" className="gap-1.5"
            onClick={openCompose}
          >
            <Plus className="h-3.5 w-3.5" /> {t.gmWrite}
          </Button>
        )}
      />
      {loading && !data ? (
        <div className="mt-3 space-y-2" role="status">
          <span className="sr-only">{t.loading}</span>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      ) : error ? (
        <EmptyState
          className="py-8"
          icon={AlertTriangle}
          title={t.gmLoadFailed}
          description={error}
          action={<Button variant="outline" size="sm" onClick={() => void load()}>{t.tryAgain}</Button>}
        />
      ) : !mayWrite ? (
        <EmptyState className="py-10" icon={Lock} title={t.gmNoPermissionTitle} description={t.gmNoPermission} />
      ) : (
        <>
          {/* Written, saved, and still not going anywhere: say so where the writing happens. */}
          {disabledBanner && <div className="mt-3">{disabledBanner}</div>}
          {(data?.messages ?? []).length === 0 ? (
            <EmptyState
              className="py-8"
              icon={PenLine}
              title={t.gmMineEmpty}
              description={t.gmMineEmptyHint}
              action={(
                <Button size="sm" onClick={openCompose}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" />{t.gmWrite}
                </Button>
              )}
            />
          ) : noteList}
        </>
      )}
    </>
  );

  // 109 of 125 real users may not write at all. They get one honest column, not a dead pane.
  const shelfView = data && !mayWrite && !error ? (
    <div className="mx-auto max-w-md space-y-5">
      <section>{receivedBlock}</section>
      <section className="border-t border-border pt-5">{writtenBlock}</section>
    </div>
  ) : (
    <div className="grid gap-5 sm:grid-cols-2 sm:gap-0">
      <section className="sm:pr-5">{receivedBlock}</section>
      <section className="border-t border-border pt-5 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">{writtenBlock}</section>
    </div>
  );

  /* ── The composer ── */
  const composeView = draft && (
    <div className="space-y-4">
      {disabledBanner}
      <div className="grid gap-5 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)] md:gap-6">
        {/* Setup: who, when, and whether it goes at all. */}
        <div className="space-y-4">
          <div>
            <p className={FIELD_LABEL}>{t.gmAudience}</p>
            {/* Arrow keys move and choose; Tab leaves the group. See moveWithinGroup. */}
            <div
              role="radiogroup"
              aria-label={t.gmAudience}
              onKeyDown={e => {
                const el = moveWithinGroup(e);
                const a = el?.dataset.audience as GreetingAudience | undefined;
                // Focus reaches a withheld row so its reason can be read; selection does not.
                if (a && may(a)) setDraft(d => d && ({ ...d, audience: a, target_epf: a === 'person' ? d.target_epf : '' }));
              }}
              className="mt-1.5 overflow-hidden rounded-lg border border-border"
            >
              {GREETING_AUDIENCES.map((a, i) => {
                const on = draft.audience === a;
                const enabled = may(a);
                const reason = a === 'my_team' ? t.gmAudienceTeamNone : a === 'everyone' ? t.gmAudienceEveryoneNo : '';
                const targetName = data?.people.find(p => p.epf === draft.target_epf)?.name;
                return (
                  <button
                    key={a}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    // aria-disabled, never the native attribute: `disabled` takes the row out of
                    // the tab order, and the reason underneath it is the whole point of drawing
                    // the row at all. A keyboard user has to be able to reach the answer.
                    aria-disabled={!enabled}
                    data-group-option
                    data-audience={a}
                    tabIndex={on ? 0 : -1}
                    onClick={() => {
                      if (!enabled) return;
                      if (a === 'person') {
                        setDraft(d => d && ({ ...d, audience: 'person' }));
                        setQ('');
                        setMode('pick');
                        return;
                      }
                      setDraft(d => d && ({ ...d, audience: a, target_epf: '' }));
                    }}
                    className={cn(
                      'flex min-h-11 w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors',
                      FOCUS_RING, 'focus-visible:ring-inset focus-visible:ring-offset-0',
                      i > 0 && 'border-t border-border',
                      on && 'bg-primary/5',
                      enabled ? 'hover:bg-accent' : 'cursor-not-allowed',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                        // border-border alone is 1.28:1 against the card — the unchosen control
                        // was invisible to anyone who needed to see it was there.
                        on ? 'border-primary bg-primary' : 'border-muted-foreground/70',
                      )}
                    >
                      {on && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                    </span>
                    <AudienceIcon audience={a} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className={cn(
                        'block text-xs',
                        enabled ? 'text-foreground' : 'text-muted-foreground',
                        on && 'font-semibold',
                      )}>
                        {audienceLabel(a)}
                      </span>
                      {/* The reason lives in the row. An option that vanishes reads as a missing
                          feature; an option that says why it is closed reads as an answer. */}
                      {!enabled && reason && (
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{reason}</span>
                      )}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                      {a === 'person' ? (
                        <>
                          <span className="max-w-[9rem] truncate">{targetName ?? t.gmPickPerson}</span>
                          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                        </>
                      ) : !enabled ? '—' : t.gmReach.replace(
                        '{n}',
                        String(a === 'everyone' ? (data?.reach.everyone ?? 0) : (data?.reach.my_team ?? 0)),
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className={FIELD_LABEL}>{t.gmOccasions}</p>
            <div className="mt-1.5 space-y-2">
              {OCCASIONS.map(o => (
                <SwitchButton
                  key={o}
                  variant="tile"
                  icon={o === 'birthday' ? Cake : o === 'anniversary' ? Award : Sparkles}
                  checked={draft.occasions.includes(o)}
                  onChange={() => toggleOccasion(o)}
                  label={occasionLabel(o)}
                  hint={o === 'birthday' ? t.gmOccasionBirthdayHint
                    : o === 'anniversary' ? t.gmOccasionAnniversaryHint
                      : t.gmOccasionSpecialHint}
                  onWord={t.greetingsDayOn}
                  offWord={t.greetingsDayOff}
                />
              ))}
            </div>
          </div>

          {/* The Dependent shape without its off-note: this only exists while Special days is on. */}
          {draft.occasions.includes('special') && (data?.special_days ?? []).length > 0 && (
            <div className="space-y-2 border-l-2 border-border pl-3">
              <p className={FIELD_LABEL}>{t.gmSpecialWhich}</p>
              {/* Chosen is said with a mark, not with a hue: --primary and --border are the only
                  difference the old chips had, and --primary is also the same azure as --success
                  and --brand. The tint stays as reinforcement; the check is what carries it. */}
              <div role="group" aria-label={t.gmSpecialWhich} className="flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-pressed={draft.special_day_ids.length === 0}
                  onClick={() => setDraft(d => d && ({ ...d, special_day_ids: [] }))}
                  className={cn(CHIP, draft.special_day_ids.length === 0 ? CHIP_ON : CHIP_OFF)}
                >
                  {draft.special_day_ids.length === 0 && <Check className="h-3 w-3 shrink-0" aria-hidden />}
                  {t.gmSpecialAll}
                </button>
                {(data?.special_days ?? []).map(d => {
                  const on = draft.special_day_ids.includes(d.id);
                  return (
                    <button
                      key={d.id} type="button" onClick={() => toggleSpecialDay(d.id)}
                      aria-pressed={on}
                      className={cn(CHIP, on ? CHIP_ON : CHIP_OFF)}
                    >
                      {on && <Check className="h-3 w-3 shrink-0" aria-hidden />}
                      {d.title}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Deliberately at the far end of the column from Save, so it cannot read as "send now". */}
          <SwitchButton
            variant="row"
            checked={draft.enabled}
            onChange={next => setDraft(d => d && ({ ...d, enabled: next }))}
            label={t.gmActive}
            hint={t.gmActiveHint}
            onWord={t.greetingsDayOn}
            offWord={t.greetingsDayOff}
          />
        </div>

        {/* The words. */}
        <div className="space-y-2.5 md:border-l md:border-border md:pl-6">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-foreground">{t.gmMessage}</p>
            {/* Label-weight on purpose: the biggest thing in this column should be the box you
                write in, not the button that writes for you. */}
            <Button
              type="button" variant="ghost" size="sm" className="gap-1.5"
              disabled={drafting || translating}
              onClick={() => void aiDraftAll()}
            >
              {drafting
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                : <Wand2 className="h-3.5 w-3.5" aria-hidden />}
              {drafting ? t.gmAiWriting : t.gmAiDraft}
            </Button>
          </div>

          <div>
            <div
              role="tablist"
              aria-label={t.gmLanguages}
              onKeyDown={e => {
                const el = moveWithinGroup(e);
                const lang = el?.dataset.lang as 'en' | 'si' | 'ta' | undefined;
                if (lang) setActiveLang(lang);
              }}
              className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1"
            >
              {(['en', 'si', 'ta'] as const).map(lang => {
                const on = activeLang === lang;
                const written = !!valueForLang(draft, lang).trim();
                return (
                  <button
                    key={lang}
                    id={`gm-lang-${lang}`}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    aria-controls="gm-message-panel"
                    data-group-option
                    data-lang={lang}
                    tabIndex={on ? 0 : -1}
                    onClick={() => setActiveLang(lang)}
                    className={cn(
                      'flex min-h-9 flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs transition-colors',
                      FOCUS_RING,
                      on ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <span className="truncate">{langNativeName(lang)}</span>
                    {written && <Check className="h-3 w-3 shrink-0" aria-hidden />}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {langFullName(activeLang)} · {activeLang === 'en' ? t.gmRequired : t.gmOptional}
            </p>
          </div>

          {/* One box holds three languages, so the panel has to say WHICH one it is holding —
              pressing සිංහල swaps every character in it, and without the tabpanel and the named
              textarea below, a screen reader is told nothing at all happened. */}
          <div
            role="tabpanel"
            id="gm-message-panel"
            aria-labelledby={`gm-lang-${activeLang}`}
            className="space-y-2.5"
          >
            {/* Offered the moment a second language is open, rather than appearing only once the
                English is already written — a control nobody has seen cannot be discovered. */}
            {activeLang !== 'en' && (
              <button
                type="button"
                onClick={() => void translateWithAi()}
                disabled={translating || drafting}
                className={cn(
                  'flex min-h-9 w-full items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2',
                  'text-[11px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50',
                  FOCUS_RING,
                )}
              >
                {translating
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
                  : <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />}
                {translating ? t.gmTranslating : t.gmTranslateInto.replace('{lang}', langFullName(activeLang))}
              </button>
            )}

            {/* 24x24 is the floor for a tap target and these were about 21 tall with a 6px gap —
                the smallest things in a dialog that promises to work on a 360px phone, and the
                one affordance that makes a note written once read personally to 112 people. */}
            <div className="flex flex-wrap items-center gap-2">
              <span className={FIELD_LABEL}>{t.gmInsertToken}</span>
              {['{name}', '{first_name}', ...(draft.occasions.includes('anniversary') ? ['{years}'] : [])].map(token => (
                <button
                  key={token}
                  type="button"
                  aria-label={`${t.gmInsertToken} +${token}`}
                  onClick={() => insertToken(token)}
                  className={cn(
                    'inline-flex min-h-6 items-center rounded border border-border bg-card px-2 py-1',
                    'font-mono text-[11px] text-foreground transition-colors hover:bg-accent',
                    FOCUS_RING,
                  )}
                >
                  +{token}
                </button>
              ))}
            </div>

            <div className="relative">
              <Textarea
                id="gm-message-box"
                ref={textareaRef}
                // The name states the language, so activating a tab renames the field rather
                // than silently replacing 500 characters behind an unchanged name.
                aria-label={`${t.gmMessage} — ${langFullName(activeLang)}`}
                aria-describedby="gm-message-count gm-message-hint"
                value={valueForLang(draft, activeLang)}
                onChange={e => setValueForLang(e.target.value.slice(0, GREETING_MESSAGE_MAX))}
                placeholder={activeLang === 'en'
                  ? t.gmMessagePlaceholder
                  : t.gmMessagePlaceholderLang.replace('{lang}', langFullName(activeLang))}
                maxLength={GREETING_MESSAGE_MAX}
                className="min-h-[7rem] resize-none pr-14 text-sm md:min-h-[9rem]"
              />
              <span
                id="gm-message-count"
                // Announced only as the cap comes into view. On every keystroke it would talk
                // over the words being typed.
                aria-live={valueForLang(draft, activeLang).length > GREETING_MESSAGE_MAX - 50 ? 'polite' : 'off'}
                className="absolute bottom-2 right-2.5 select-none text-[10px] text-muted-foreground"
              >
                {valueForLang(draft, activeLang).length}/{GREETING_MESSAGE_MAX}
              </span>
            </div>

            <p id="gm-message-hint" className="text-[11px] text-muted-foreground">{t.gmPlaceholderHint}</p>

            {valueForLang(draft, activeLang).trim() && (
              <p className="rounded-lg border border-border/60 bg-card px-2.5 py-2 text-[11px] italic text-foreground">
                <span className="mr-1 font-semibold not-italic text-muted-foreground">{t.gmPreview}:</span>
                {preview(valueForLang(draft, activeLang).trim(), activeLang)}
              </p>
            )}
          </div>

          {/* Defensive: this client posts one string, so it cannot create alternates — but if
              anything else ever does, the first person to edit that row is told what saving
              costs rather than losing four wordings silently. */}
          {hasVariants && (
            <p className="flex items-start gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-2.5 py-2 text-[11px] text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {t.gmWordingsReplaced}
            </p>
          )}
        </div>
      </div>
    </div>
  );

  /* ── The person picker, as a mode. A nested 32px-tall scroller with 112 names in it was the
       second scroll region this dialog could not afford. ── */
  const pickRovingIdx = people.findIndex(p => p.epf === draft?.target_epf);

  const pickView = (
    <div className="space-y-3">
      {/* The ring lives on the wrapper because the input is borderless inside it — without it
          this was the one control in the dialog with no visible focus state at all. */}
      <div className={cn(
        'flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-2.5',
        'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
      )}>
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <input
          type="search"
          // A placeholder is a hint, not a name. It is also the first thing to disappear.
          aria-label={t.gmSearchPeople}
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={t.gmSearchPeople}
          autoFocus
          className="w-full bg-transparent text-xs outline-none"
        />
      </div>
      {people.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">{t.gmNoMatches}</p>
      ) : (
        <div
          role="radiogroup"
          aria-label={t.gmPickPerson}
          // Fifty names were fifty tab stops between the search box and the rest of the dialog.
          // One stop now; the arrows walk the list and choose as they go, Enter closes the
          // picker the way a click does.
          onKeyDown={e => {
            const el = moveWithinGroup(e);
            const epf = el?.dataset.epf;
            if (epf) setDraft(d => d && ({ ...d, target_epf: epf }));
          }}
          className="overflow-hidden rounded-lg border border-border"
        >
          {people.map((p, i) => {
            const on = draft?.target_epf === p.epf;
            return (
              <button
                key={p.epf}
                type="button"
                role="radio"
                aria-checked={on}
                data-group-option
                data-epf={p.epf}
                // Nothing chosen yet still needs one way in, so the first row holds the stop.
                tabIndex={on || (pickRovingIdx < 0 && i === 0) ? 0 : -1}
                onClick={() => { setDraft(d => d && ({ ...d, target_epf: p.epf })); setMode('compose'); }}
                className={cn(
                  'flex min-h-11 w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors hover:bg-accent',
                  FOCUS_RING, 'focus-visible:ring-inset focus-visible:ring-offset-0',
                  i > 0 && 'border-t border-border',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                    on ? 'border-primary bg-primary' : 'border-muted-foreground/70',
                  )}
                >
                  {on && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">{p.name}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{p.epf}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  const body = mode === 'compose' && draft ? composeView
    : mode === 'pick' && draft ? pickView
      : shelfView;

  return (
    <>
      <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
        <DialogContent
          closeLabel={t.closeWord}
          // Escape steps back one screen instead of destroying the whole dialog. In `pick` it
          // used to take the composer with it; in `compose` it threw away up to three 500-
          // character messages, an audience and an occasion set with nothing asked.
          onEscapeKeyDown={e => {
            if (mode === 'shelf') return;
            e.preventDefault();
            if (mode === 'pick') setMode('compose'); else leaveCompose();
          }}
          // A stray tap on the backdrop is not an instruction to discard a draft.
          onInteractOutside={e => { if (mode !== 'shelf' && dirty) e.preventDefault(); }}
          className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-1.5rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:w-[calc(100%-2rem)] sm:max-w-3xl"
        >
          <DialogHeader className="flex-shrink-0 border-b border-border px-4 py-3.5 pr-12 sm:px-5 sm:py-4 sm:pr-14">
            <div className="flex items-start gap-1.5">
              {mode !== 'shelf' && (
                <button
                  ref={backBtnRef}
                  type="button"
                  aria-label={t.gmBack}
                  title={t.gmBack}
                  onClick={() => (mode === 'pick' ? setMode('compose') : leaveCompose())}
                  className={cn(
                    '-ml-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                    'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                    FOCUS_RING,
                  )}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              )}
              <div className="min-w-0 flex-1 space-y-1">
                <DialogTitle className="flex items-center gap-2 text-base">
                  {mode === 'shelf' && <PartyPopper className="h-4 w-4 shrink-0 text-brand" aria-hidden />}
                  <span className="min-w-0 truncate">{headerTitle}</span>
                </DialogTitle>
                <DialogDescription className="text-xs">{headerDesc}</DialogDescription>
                {/* Radix announces the title once, on open. Three screens share this dialog, so
                    the change of screen has to be said out loud too. */}
                <span role="status" className="sr-only">{headerTitle}</span>
              </div>
            </div>
          </DialogHeader>

          {/* The one scroll region in this dialog. Nothing inside it scrolls or sticks. */}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 py-4 sm:px-5">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={mode}
                initial={{ opacity: 0, x: reduce ? 0 : dir * 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: reduce ? 0 : -dir * 8 }}
                transition={{ duration: 0.14, ease: 'easeOut' }}
              >
                {body}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Outside the scroller, so Save never sits below a picker, three tiles and a preview.
              "Saved now, sent on the day" is the header's line and only the header's: it used to
              be printed here as well, so it appeared twice at once on any screen wide enough to
              show both, and once on the phone where it was needed most. */}
          {mode === 'compose' && draft && (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-card/80 px-4 py-3 sm:px-5">
              <Button type="button" variant="outline" size="sm" disabled={saving} onClick={leaveCompose}>
                {t.cancel}
              </Button>
              <Button
                type="button" size="sm" className="flex-1 gap-1.5 sm:flex-none"
                // Legible before the click: a note whose audience is now withheld cannot be
                // saved, and the row above already says why in words.
                disabled={saving || drafting || translating || !may(draft.audience)}
                onClick={() => void save()}
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                {saving ? t.saving : t.gmSave}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmModal
        open={!!confirmDelete}
        onOpenChange={() => setConfirmDelete(null)}
        variant="danger"
        title={t.gmDeleteTitle}
        description={t.gmDeleteDesc}
        confirmText={t.gmDelete}
        busy={saving}
        onConfirm={async () => {
          const row = confirmDelete;
          setConfirmDelete(null);
          if (row) await remove(row);
        }}
      />

      {/* Only ever raised for a draft that has actually been changed — confirming an untouched
          composer would be a dialog asking about nothing. */}
      <ConfirmModal
        open={confirmDiscard}
        onOpenChange={() => setConfirmDiscard(false)}
        variant="warning"
        title={t.gmDiscardTitle}
        description={t.gmDiscardDesc}
        confirmText={t.gmDiscard}
        cancelText={t.gmKeepWriting}
        onConfirm={() => { setConfirmDiscard(false); backToShelf(); }}
      />
    </>
  );
}
