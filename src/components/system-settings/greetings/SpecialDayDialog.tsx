'use client';
import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CalendarClock, CalendarDays, Check, Languages, Loader2, Repeat, Search, Sparkles } from 'lucide-react';
import toast from 'react-hot-toast';
import { useT } from '@/store/appStore';
import { useBrandName } from '@/lib/brand';
import { tenant } from '@/lib/firebase';
import { cacheSpecialDayMessages } from '@/lib/specialDayCache';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import Select from '@/components/Select';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { draftSpecialDayGreeting } from '@/services/greetingMessagesService';
import {
  canonName, greetingCopy, isValidSpecialDate, modeOf, resolveSpecialDayDate, titleCaseHoliday,
  type HolidayCalendar, type SpecialDay, type SpecialDayMode, type Sender,
} from '@/lib/greetings';
import type { HolidayType } from '@/services/holidayService';
import { daysInMonth, formatLongDate, monthNames, type HolidayOption } from './holidayOptions';

// Adding a special day, in the order the question is actually answered: what KIND of day this
// is, then WHICH day, then the words. The old inline row asked for a title first and buried the
// kind in the middle, so you had to name a day before you had chosen it — and the field below
// the kind changed meaning depending on a Select you had already scrolled past.
//
// The same dialog edits an existing day; editing opens on the words, because that is what an
// edit is nearly always for, with both earlier steps one click away.

type Step = 1 | 2 | 3;
type Filter = 'all' | HolidayType;

function newId(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function todayMonthDay(): string {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface SpecialDayDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null adds a new day; a day edits that one. */
  day: SpecialDay | null;
  /** This year's holidays, name + date + category (see buildHolidayOptions). */
  holidays: HolidayOption[];
  /** The same list as the engine sees it, for the "falls on" line. */
  calendar: HolidayCalendar | null;
  year: string;
  /** The default signer list, resolved to names — so the preview shows the signer phrase this
   *  tenant actually sends instead of the no-signer fallback. */
  previewSenders?: Sender[];
  /** A real reader's name to address the preview to. The pool line is seeded from it, so an
   *  empty name would pin the preview to one fixed line that most people never receive. */
  previewName?: string;
  onSave: (day: SpecialDay) => void;
  busy?: boolean;
}

export default function SpecialDayDialog({
  open, onOpenChange, day, holidays, calendar, year,
  previewSenders = [], previewName = '', onSave, busy = false,
}: SpecialDayDialogProps) {
  const t = useT();
  const brand = useBrandName();
  const reduced = useReducedMotion();

  const [step, setStep] = useState<Step>(1);
  const [mode, setMode] = useState<SpecialDayMode | null>(null);
  const [calName, setCalName] = useState('');
  const [md, setMd] = useState(todayMonthDay());        // annual, 'MM-DD'
  const [ymd, setYmd] = useState('');                   // one-off, 'YYYY-MM-DD'
  const [override, setOverride] = useState('');         // this year's manual date, calendar mode
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [titleSi, setTitleSi] = useState('');
  const [messageSi, setMessageSi] = useState('');
  const [titleTa, setTitleTa] = useState('');
  const [messageTa, setMessageTa] = useState('');
  const [activeLang, setActiveLang] = useState<'en' | 'si' | 'ta'>('en');
  const [previewLang, setPreviewLang] = useState<'en' | 'si' | 'ta'>('en');
  const [drafting, setDrafting] = useState(false);
  const [draftingAll, setDraftingAll] = useState(false);
  // Once someone types their own heading, picking a different holiday must not overwrite it.
  const [titleTouched, setTitleTouched] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    if (!open) return;
    const m = day ? modeOf(day) : null;
    setStep(day ? 3 : 1);
    setMode(m);
    setCalName(day?.calendar_name ?? '');
    setMd(m === 'annual' ? (day?.date ?? todayMonthDay()) : todayMonthDay());
    setYmd(m === 'once' ? (day?.date ?? '') : '');
    setOverride(day?.dates_by_year?.[year] ?? '');
    setTitle(day?.title ?? '');
    setMessage(day?.message ?? '');
    setTitleSi(day?.title_si ?? '');
    setMessageSi(day?.message_si ?? '');
    setTitleTa(day?.title_ta ?? '');
    setMessageTa(day?.message_ta ?? '');
    setActiveLang('en');
    setPreviewLang('en');
    setTitleTouched(!!day?.title?.trim());
    setQuery('');
    setFilter('all');
  }, [open, day, year]);

  // What the published calendar itself says about the chosen name. Null means the name is not in
  // this year's calendar — only reachable for a day saved before this picker existed.
  const fromCalendar = mode === 'calendar' && calendar?.year === year
    ? calendar.byName[canonName(calName)] ?? null
    : null;

  const draft = useMemo<SpecialDay>(() => {
    const base: SpecialDay = {
      id: day?.id ?? '',
      title: title.trim(),
      message: message.trim(),
      ...(titleSi.trim() ? { title_si: titleSi.trim() } : {}),
      ...(messageSi.trim() ? { message_si: messageSi.trim() } : {}),
      ...(titleTa.trim() ? { title_ta: titleTa.trim() } : {}),
      ...(messageTa.trim() ? { message_ta: messageTa.trim() } : {}),
      enabled: day?.enabled ?? true,
      mode: mode ?? 'annual',
    };
    if (mode === 'calendar') base.calendar_name = calName.trim();
    else base.date = mode === 'once' ? ymd : md;
    // Per-year overrides: other years are left alone, but THIS year's is dropped as soon as the
    // calendar can resolve the day itself. Keeping it would pin the day to the previously picked
    // holiday's date after the holiday is changed, because an override always wins.
    const others = Object.fromEntries(
      Object.entries(day?.dates_by_year ?? {}).filter(([y]) => y !== year),
    );
    const mine = mode === 'calendar' && !fromCalendar && override.length === 10 && isValidSpecialDate(override)
      ? { [year]: override }
      : {};
    const byYear = { ...others, ...mine };
    if (Object.keys(byYear).length) base.dates_by_year = byYear;
    return base;
  }, [day, title, message, titleSi, messageSi, titleTa, messageTa, mode, calName, ymd, md, override, fromCalendar, year]);

  const handleAiDraft = async (lang: 'en' | 'si' | 'ta') => {
    const specialTitle = title.trim() || calName.trim();
    if (!specialTitle) {
      toast.error(t.greetingsDayNeedsTitle);
      return;
    }
    setDrafting(true);
    try {
      const res = await draftSpecialDayGreeting({ special_title: specialTitle, language: lang });
      const text = res.draft;
      if (!text) {
        toast.error(t.greetingsSaveFailed);
        return;
      }
      if (lang === 'en') setMessage(text);
      else if (lang === 'si') setMessageSi(text);
      else if (lang === 'ta') setMessageTa(text);
      toast.success(t.greetingsAiDraftSuccess);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t.greetingsSaveFailed);
    } finally {
      setDrafting(false);
    }
  };

  const handleAiDraftAll = async () => {
    const specialTitle = title.trim() || calName.trim();
    if (!specialTitle) {
      toast.error(t.greetingsDayNeedsTitle);
      return;
    }
    setDraftingAll(true);
    try {
      const res = await draftSpecialDayGreeting({ special_title: specialTitle, draft_all: true });
      let count = 0;
      if (res.drafts?.en) { setMessage(res.drafts.en); count++; }
      if (res.drafts?.si) { setMessageSi(res.drafts.si); count++; }
      if (res.drafts?.ta) { setMessageTa(res.drafts.ta); count++; }
      if (count > 0) {
        toast.success(t.greetingsAiDraftAllSuccess);
      } else {
        toast.error(t.greetingsSaveFailed);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t.greetingsSaveFailed);
    } finally {
      setDraftingAll(false);
    }
  };

  // The date this day lands on. A one-off in another year resolves to nothing for `year`, but it
  // still has a date worth showing back to the person who just picked it.
  const resolved = mode
    ? resolveSpecialDayDate(draft, year, calendar)
      ?? (mode === 'once' && ymd.length === 10 && isValidSpecialDate(ymd) ? ymd : null)
    : null;

  const stepDone = (s: Step): boolean => {
    if (s === 1) return mode !== null;
    if (s === 2) {
      if (mode === 'calendar') return calName.trim() !== '';
      if (mode === 'annual') return md.length === 5 && isValidSpecialDate(md);
      if (mode === 'once') return ymd.length === 10 && isValidSpecialDate(ymd);
      return false;
    }
    return title.trim() !== '';
  };
  const canSave = stepDone(1) && stepDone(2) && stepDone(3);

  const counts = useMemo(() => ({
    all: holidays.length,
    poya: holidays.filter(h => h.category === 'poya').length,
    public: holidays.filter(h => h.category === 'public').length,
    mercantile: holidays.filter(h => h.category === 'mercantile').length,
  }), [holidays]);

  const shown = useMemo(() => {
    const q = canonName(query);
    return holidays.filter(h =>
      (filter === 'all' || h.category === filter)
      && (q === ''
        || canonName(h.name).includes(q)
        || h.date.includes(q)
        || formatLongDate(h.date).toLowerCase().includes(q)));
  }, [holidays, filter, query]);

  const pickHoliday = (h: HolidayOption) => {
    setCalName(h.name);
    // The heading follows the holiday name until you write your own.
    if (!titleTouched) setTitle(titleCaseHoliday(h.name));
  };

  const kinds: Array<{ value: SpecialDayMode; label: string; hint: string; icon: typeof CalendarDays }> = [
    { value: 'calendar', label: t.greetingsKindCalendar, hint: t.greetingsKindCalendarHint, icon: CalendarDays },
    { value: 'annual',   label: t.greetingsKindAnnual,   hint: t.greetingsKindAnnualHint,   icon: Repeat },
    { value: 'once',     label: t.greetingsKindOnce,     hint: t.greetingsKindOnceHint,     icon: CalendarClock },
  ];

  const stepTitle = step === 1 ? t.greetingsStepKind : step === 2 ? t.greetingsStepDay : t.greetingsStepWords;

  const chips: Array<{ value: Filter; label: string; n: number }> = [
    { value: 'all', label: t.greetingsHolidayFilterAll, n: counts.all },
    { value: 'poya', label: t.greetingsHolidayFilterPoya, n: counts.poya },
    { value: 'public', label: t.greetingsHolidayFilterPublic, n: counts.public },
    { value: 'mercantile', label: t.greetingsHolidayFilterMercantile, n: counts.mercantile },
  ];

  // Twelve Intl lookups, once — not on every keystroke in the message box.
  const months = useMemo(monthNames, []);
  const monthOf = md.slice(0, 2) || '01';
  const dayOf = md.slice(3, 5) || '01';

  const previewTitle = useMemo(() => {
    if (previewLang === 'si') return titleSi.trim() || title.trim();
    if (previewLang === 'ta') return titleTa.trim() || title.trim();
    return title.trim();
  }, [previewLang, titleSi, titleTa, title]);

  const previewMessage = useMemo(() => {
    if (previewLang === 'si') return messageSi.trim() || message.trim();
    if (previewLang === 'ta') return messageTa.trim() || message.trim();
    return message.trim();
  }, [previewLang, messageSi, messageTa, message]);

  // The preview used to pass an empty recipient name and no signers, which made it wrong in
  // three ways at once: an empty name seeds the pool at variantIndex('', 0) so it showed one
  // fixed line forever rather than the line a reader actually gets; no senders made fromPhrase
  // fall back to "your team at {brand}", the one signer phrase a configured tenant never sends;
  // and greetingCopy ignored the language toggle entirely, so the SI/TA tabs showed English
  // pool copy under a translated heading.
  //
  // A named sample reader fixes the first two — a preview of a message nobody is addressed in
  // is not a preview of anything. `previewLang` is now honoured for the pool line too.
  const preview = greetingCopy(
    { kind: 'special', dayId: draft.id || 'preview', title: previewTitle || draft.title, message: previewMessage },
    previewName, brand, previewSenders, { key: previewName, year: Number(year) }, previewLang,
  );

  const save = () => {
    if (!canSave) return;
    const saved = { ...draft, id: draft.id || newId() };
    onSave(saved);
    // Fire-and-forget: generate AI variants and cache them on this device.
    // If it fails (no API key, budget exhausted, network down) the hand-written
    // message or pool copy is used — the greeting always goes out either way.
    cacheSpecialDayMessages(saved, tenant.dbId ?? 'default').catch(() => {});
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* dvh, not vh: with Safari's URL bar showing, 88vh is taller than the visual viewport,
          and this dialog is centred — the bottom of it, footer included, ends up off screen. */}
      <DialogContent className="max-h-[88dvh] overflow-y-auto overscroll-contain sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{day ? t.greetingsEditDay : t.greetingsAddDay}</DialogTitle>
          <DialogDescription>{stepTitle}</DialogDescription>
        </DialogHeader>

        {/* Where you are, and a way back to a step you have already answered. Numbered rather
            than coloured: --primary and --success are the same azure here. */}
        <ol className="flex items-center gap-1.5">
          {([1, 2, 3] as Step[]).map(s => {
            const reachable = s === 1 || ([1, 2, 3] as Step[]).slice(0, s - 1).every(stepDone);
            return (
              <li key={s} className="flex flex-1 items-center gap-1.5">
                <button
                  type="button"
                  disabled={!reachable}
                  onClick={() => setStep(s)}
                  aria-current={s === step ? 'step' : undefined}
                  aria-label={t.greetingsStepOf.replace('{n}', String(s))}
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums transition-colors',
                    s === step
                      ? 'border-primary bg-primary font-bold text-primary-foreground'
                      : stepDone(s)
                        ? 'border-primary/50 font-semibold text-primary'
                        : 'border-border text-muted-foreground',
                    !reachable && 'cursor-not-allowed opacity-50',
                  )}
                >
                  {stepDone(s) && s !== step ? <Check className="h-3 w-3" /> : s}
                </button>
                <span aria-hidden className={cn('h-px flex-1', s === 3 ? 'invisible' : 'bg-border')} />
              </li>
            );
          })}
        </ol>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={reduced ? false : { opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduced ? undefined : { opacity: 0, x: -12 }}
            // Zero for a reduced-motion reader: the point is not to make them wait through a
            // fade, it is not to move anything.
            transition={{ duration: reduced ? 0 : 0.18, ease: 'easeOut' }}
            className="space-y-3"
          >
            {/* ── 1. What kind of day ──────────────────────────────────────────────── */}
            {step === 1 && kinds.map(k => {
              const Icon = k.icon;
              const on = mode === k.value;
              return (
                <button
                  key={k.value}
                  type="button"
                  onClick={() => setMode(k.value)}
                  aria-pressed={on}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                    on ? 'border-primary bg-primary/10' : 'border-border bg-muted/20 hover:bg-accent',
                  )}
                >
                  <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', on ? 'text-primary' : 'text-muted-foreground')} />
                  <span className="min-w-0 flex-1">
                    <span className={cn('block text-sm text-foreground', on && 'font-semibold')}>{k.label}</span>
                    <span className="block text-[11px] leading-relaxed text-muted-foreground">{k.hint}</span>
                  </span>
                  {on && <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
                </button>
              );
            })}

            {/* ── 2. Which day ─────────────────────────────────────────────────────── */}
            {step === 2 && mode === 'calendar' && (
              holidays.length === 0 ? (
                <div className="space-y-2 rounded-lg border border-dashed border-border bg-muted/20 px-3 py-3">
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {t.greetingsHolidayCalendarEmpty.replace('{year}', year)}
                  </p>
                  <Button type="button" variant="outline" size="sm" className="h-9"
                    onClick={() => { setMode('annual'); setStep(2); }}>
                    {t.greetingsKindAnnual}
                  </Button>
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input value={query} onChange={e => setQuery(e.target.value)} className="pl-8"
                      placeholder={t.greetingsHolidaySearch} aria-label={t.greetingsHolidaySearch} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {chips.filter(c => c.value === 'all' || c.n > 0).map(c => (
                      <button key={c.value} type="button" aria-pressed={filter === c.value}
                        onClick={() => setFilter(c.value)}
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                          filter === c.value
                            ? 'border-primary bg-primary/15 font-semibold text-primary'
                            : 'border-border text-muted-foreground hover:bg-accent',
                        )}>
                        {c.label} <span className="tabular-nums opacity-70">{c.n}</span>
                      </button>
                    ))}
                  </div>
                  {/* One scroll region on a phone. Nested inside the dialog's own scroller, a
                      14rem list meant a flick near the boundary scrolled the wrong thing. */}
                  <ul className="space-y-1 sm:max-h-56 sm:overflow-y-auto sm:pr-0.5">
                    {shown.map(h => {
                      const on = canonName(h.name) === canonName(calName);
                      return (
                        <li key={`${h.date}-${h.name}`}>
                          <button type="button" onClick={() => pickHoliday(h)} aria-pressed={on}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors',
                              on ? 'border-primary bg-primary/10' : 'border-transparent bg-muted/30 hover:bg-accent',
                            )}>
                            <span className="min-w-0 flex-1">
                              <span className={cn('block truncate text-sm text-foreground', on && 'font-semibold')}>
                                {titleCaseHoliday(h.name)}
                              </span>
                              <span className="block text-[11px] text-muted-foreground">
                                {formatLongDate(h.date)}
                                {h.category === 'poya' && ` · ${t.greetingsHolidayFilterPoya}`}
                                {h.category === 'mercantile' && ` · ${t.greetingsHolidayFilterMercantile}`}
                              </span>
                            </span>
                            {on && <Check className="h-4 w-4 shrink-0 text-primary" />}
                          </button>
                        </li>
                      );
                    })}
                    {/* A dead end otherwise: the right next move is a fixed date, and that is
                        one step back, so offer it here rather than making them find it. */}
                    {shown.length === 0 && (
                      <li className="flex flex-wrap items-center gap-2 px-1 py-2 text-[11px] text-muted-foreground">
                        {t.greetingsHolidayNoMatch}
                        <Button type="button" variant="outline" size="sm" className="h-9"
                          onClick={() => { setMode('annual'); setStep(2); }}>
                          {t.greetingsKindAnnual}
                        </Button>
                      </li>
                    )}
                  </ul>
                </>
              )
            )}

            {step === 2 && mode === 'annual' && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">{t.greetingsMonth}</Label>
                  <Select value={monthOf} onChange={v => setMd(`${v}-${dayOf}`)}
                    options={months.map((name, i) => ({ value: String(i + 1).padStart(2, '0'), label: name }))} />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">{t.greetingsDayOfMonth}</Label>
                  <Select value={dayOf} onChange={v => setMd(`${monthOf}-${v}`)}
                    options={Array.from({ length: daysInMonth(Number(monthOf)) }, (_, i) => ({
                      value: String(i + 1).padStart(2, '0'), label: String(i + 1),
                    }))} />
                </div>
              </div>
            )}

            {step === 2 && mode === 'once' && (
              <Input type="date" value={ymd} onChange={e => setYmd(e.target.value)}
                aria-label={t.greetingsDayDate} className="w-full sm:w-52" />
            )}

            {/* What the day actually lands on, on the step where it can still be changed. */}
            {step === 2 && (resolved || (mode === 'calendar' && calName.trim() !== '')) && (
              <p className={cn('text-[11px]', resolved ? 'text-muted-foreground' : 'text-warning')}>
                {resolved
                  ? t.greetingsFallsOn.replace('{date}', formatLongDate(resolved))
                  : t.greetingsCalendarUnresolved.replace('{year}', year)}
              </p>
            )}
            {/* The escape hatch for a year the calendar has nothing for. It used to appear as a
                bare date box under a warning, with nothing saying what typing in it did or that
                it is dropped again the moment the calendar can resolve the name itself. */}
            {step === 2 && mode === 'calendar' && !fromCalendar && calName.trim() !== '' && (
              <div className="space-y-1">
                <Label htmlFor="sd-override" className="text-[11px] text-muted-foreground">
                  {t.greetingsSetDateForYear.replace('{year}', year)}
                </Label>
                <Input id="sd-override" type="date" className="w-full sm:w-52" value={override}
                  onChange={e => setOverride(e.target.value)} />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t.greetingsOverrideHint.replace('{year}', year)}
                </p>
              </div>
            )}

            {/* ── 3. The words ─────────────────────────────────────────────────────── */}
            {step === 3 && (
              <div className="space-y-3.5">
                {/* Language Switcher & AI Actions */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2.5">
                  <div className="flex items-center gap-1">
                    {[
                      { id: 'en' as const, label: t.greetingsLangEn, hasContent: !!message.trim() },
                      { id: 'si' as const, label: t.greetingsLangSi, hasContent: !!(titleSi.trim() || messageSi.trim()) },
                      { id: 'ta' as const, label: t.greetingsLangTa, hasContent: !!(titleTa.trim() || messageTa.trim()) },
                    ].map(tab => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => {
                          setActiveLang(tab.id);
                          setPreviewLang(tab.id);
                        }}
                        className={cn(
                          'relative flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                          activeLang === tab.id
                            ? 'bg-primary/10 text-primary font-semibold'
                            : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                        )}
                      >
                        <span>{tab.label}</span>
                        {tab.hasContent && (
                          <span
                            className={cn(
                              'h-1.5 w-1.5 rounded-full',
                              activeLang === tab.id ? 'bg-primary' : 'bg-muted-foreground/60',
                            )}
                            title="Has custom content"
                          />
                        )}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={drafting || draftingAll || !title.trim()}
                      onClick={() => handleAiDraft(activeLang)}
                      className="h-7 gap-1 px-2 text-xs font-medium text-primary hover:text-primary"
                      title={t.greetingsAiDraft}
                    >
                      {drafting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 text-primary" />}
                      <span>{drafting ? t.greetingsAiDrafting : t.greetingsAiDraft}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={drafting || draftingAll || !title.trim()}
                      onClick={handleAiDraftAll}
                      className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                      title={t.greetingsAiDraftAll}
                    >
                      {draftingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Languages className="h-3.5 w-3.5" />}
                      <span className="hidden sm:inline">{t.greetingsAiDraftAll}</span>
                    </Button>
                  </div>
                </div>

                {/* Input Fields for the selected language */}
                {activeLang === 'en' && (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <Label htmlFor="sd-title" className="text-[11px] text-muted-foreground">{t.greetingsDayTitle}</Label>
                      <Input
                        id="sd-title"
                        value={title}
                        placeholder={t.greetingsDayTitle}
                        onChange={e => { setTitle(e.target.value); setTitleTouched(true); }}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="sd-msg" className="text-[11px] text-muted-foreground">{t.greetingsDayMessage}</Label>
                      <Textarea
                        id="sd-msg"
                        value={message}
                        rows={3}
                        className="min-h-[64px]"
                        placeholder={t.greetingsMessagePlaceholder}
                        onChange={e => setMessage(e.target.value)}
                      />
                    </div>
                  </div>
                )}

                {activeLang === 'si' && (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="sd-title-si" className="text-[11px] text-muted-foreground">{t.greetingsTitleSi}</Label>
                        <span className="text-[10px] text-muted-foreground">සිංහල</span>
                      </div>
                      <Input
                        id="sd-title-si"
                        value={titleSi}
                        placeholder={title.trim() ? `e.g. ${title}` : 'සිංහල මාතෘකාව'}
                        onChange={e => setTitleSi(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="sd-msg-si" className="text-[11px] text-muted-foreground">{t.greetingsMessageSi}</Label>
                        <span className="text-[10px] text-muted-foreground">සිංහල</span>
                      </div>
                      <Textarea
                        id="sd-msg-si"
                        value={messageSi}
                        rows={3}
                        className="min-h-[64px]"
                        placeholder="සුභ පැතුම් පණිවිඩය මෙහි ලියන්න (හෝ AI මගින් කෙටුම්පත් කරන්න)..."
                        onChange={e => setMessageSi(e.target.value)}
                      />
                    </div>
                  </div>
                )}

                {activeLang === 'ta' && (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="sd-title-ta" className="text-[11px] text-muted-foreground">{t.greetingsTitleTa}</Label>
                        <span className="text-[10px] text-muted-foreground">தமிழ்</span>
                      </div>
                      <Input
                        id="sd-title-ta"
                        value={titleTa}
                        placeholder={title.trim() ? `e.g. ${title}` : 'தமிழ் தலைப்பு'}
                        onChange={e => setTitleTa(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="sd-msg-ta" className="text-[11px] text-muted-foreground">{t.greetingsMessageTa}</Label>
                        <span className="text-[10px] text-muted-foreground">தமிழ்</span>
                      </div>
                      <Textarea
                        id="sd-msg-ta"
                        value={messageTa}
                        rows={3}
                        className="min-h-[64px]"
                        placeholder="வாழ்த்துச் செய்தியை இங்கே உள்ளிடவும் (அல்லது AI மூலம் வரைவு செய்யவும்)..."
                        onChange={e => setMessageTa(e.target.value)}
                      />
                    </div>
                  </div>
                )}

                {/* The card, as it will read */}
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {t.greetingsPreview}
                    </p>
                    <div className="flex items-center gap-1 rounded-md border border-border/60 bg-background/60 p-0.5 text-[11px]">
                      {(['en', 'si', 'ta'] as const).map(l => (
                        <button
                          key={l}
                          type="button"
                          onClick={() => setPreviewLang(l)}
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors',
                            previewLang === l
                              ? 'bg-primary text-primary-foreground shadow-xs'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {l.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="mt-2 text-sm font-semibold text-foreground">{preview.title || '—'}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{preview.body}</p>
                  {resolved && (
                    <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <CalendarDays aria-hidden className="h-3.5 w-3.5" />
                      {t.greetingsFallsOn.replace('{date}', formatLongDate(resolved))}
                    </p>
                  )}
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        {/* Pinned to the bottom of the dialog's own scroller and clear of the home indicator:
            the action must never be the thing you have to scroll to find. */}
        <DialogFooter className="sticky bottom-0 -mx-6 -mb-6 border-t border-border bg-card/95 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4 backdrop-blur-xl sm:justify-between">
          <Button type="button" variant="ghost" disabled={busy}
            onClick={() => (step === 1 ? onOpenChange(false) : setStep((step - 1) as Step))}>
            {step === 1 ? t.cancel : t.greetingsBack}
          </Button>
          <div className="flex gap-2">
            {/* Editing an existing day is usually one field on one step. Walking it through the
                words step to save a changed date is a tax on the commonest edit there is. */}
            {day && step !== 3 && (
              <Button type="button" variant="outline" className="flex-1 sm:flex-none"
                disabled={!canSave || busy} onClick={save}>
                {t.save}
              </Button>
            )}
            {step === 3 ? (
              <Button type="button" className="flex-1 sm:flex-none" disabled={!canSave || busy} onClick={save}>
                {day ? t.save : t.greetingsAddDay}
              </Button>
            ) : (
              <Button type="button" className="flex-1 sm:flex-none" disabled={!stepDone(step)}
                onClick={() => setStep((step + 1) as Step)}>
                {t.greetingsNext}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
