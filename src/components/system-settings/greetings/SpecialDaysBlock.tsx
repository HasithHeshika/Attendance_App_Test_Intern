'use client';
import { useMemo, useState } from 'react';
import { CalendarClock, CalendarDays, Check, PartyPopper, Pencil, Plus, Repeat, Trash2 } from 'lucide-react';
import { useT } from '@/store/appStore';
import { cn } from '@/lib/utils';
import { Badge, badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import ConfirmModal from '@/components/ConfirmModal';
import { BlockHeader, SwitchButton } from '@/components/system-settings/greetings/parts';
import { formatDayMonth, formatLongDate } from '@/components/system-settings/greetings/holidayOptions';
import {
  isValidSpecialDate, modeOf, resolveSpecialDayDate,
  type GreetingSettings, type HolidayCalendar, type SpecialDay,
} from '@/lib/greetings';

// The special-days list. The switch that governs the whole list lives with the other occasions
// two blocks up, so this one says plainly when it is off rather than showing an apparently
// live list of days nothing will ever send.
//
// Quick add exists because typing '12-25' to mean Christmas is a strange thing to ask of anyone.
// Each preset lands as an ordinary annual row and nothing about it stays special afterwards —
// same edit, same removal, same validation.
//
// The titles are stored in English rather than in the admin's language: the title is what every
// recipient reads on the card, so a Sinhala admin adding Christmas must not silently decide that
// all three hundred employees read it in Sinhala. It is free text on an ordinary row, so anyone
// can change it afterwards. Only the chrome around the chips is translated.

interface Preset {
  id: string;
  title: string;
  /** 'MM-DD' for a fixed annual date; empty means only the admin knows it. */
  date: string;
}

const PRESETS: readonly Preset[] = [
  { id: 'preset-new-year',        title: "New Year's Day",              date: '01-01' },
  { id: 'preset-sinhala-tamil-1', title: 'Sinhala & Tamil New Year',      date: '04-13' },
  { id: 'preset-sinhala-tamil-2', title: 'Sinhala & Tamil New Year Day 2', date: '04-14' },
  { id: 'preset-may-day',         title: 'May Day',                       date: '05-01' },
  { id: 'preset-christmas',       title: 'Christmas',                     date: '12-25' },
  // No date: the company's own anniversary is not something this file can know, so this one
  // opens the dialog prefilled instead of writing an undated row — an undated row is invalid and
  // would block every unrelated save on this screen until someone noticed.
  { id: 'preset-company-anniversary', title: 'Company anniversary',       date: '' },
];

export interface SpecialDaysBlockProps {
  settings: GreetingSettings;
  calendar: HolidayCalendar | null;
  year: string;
  /** Today as 'YYYY-MM-DD', for "already passed this year". */
  today: string;
  /** True when the master switch AND the special-days occasion are both on. */
  live: boolean;
  onWrite: (next: GreetingSettings, key: string) => void;
  pending: string | null;
  onEdit: (day: SpecialDay | null) => void;
}

export default function SpecialDaysBlock({
  settings, calendar, year, today, live, onWrite, pending, onEdit,
}: SpecialDaysBlockProps) {
  const t = useT();
  const [confirmRemove, setConfirmRemove] = useState<SpecialDay | null>(null);

  // What makes a row saveable depends on its kind: a dated row needs a valid date, a
  // calendar-linked one needs a name to match against. The dialog cannot produce a broken row,
  // but a row saved by the old inline editor can be one — and the save route rejects the WHOLE
  // document over it, so the list has to say which row is at fault.
  const dayProblem = (d: SpecialDay): string | null => {
    if (d.title.trim() === '') return t.greetingsDayNeedsTitle;
    if (modeOf(d) === 'calendar') {
      return (d.calendar_name ?? '').trim() === '' ? t.greetingsDayNeedsHoliday : null;
    }
    return isValidSpecialDate(d.date ?? '') ? null : t.greetingsDayNeedsDate;
  };

  // An admin's real question is "what is coming up", and the stored order is whatever order the
  // days were added in. Broken rows lead because one of them blocks every unrelated save;
  // then the days still to come, then the ones already gone, then the ones that resolve to
  // nothing at all this year.
  const rows = useMemo(() => settings.special_days
    .map(d => {
      const problem = dayProblem(d);
      const date = resolveSpecialDayDate(d, year, calendar);
      const rank = problem ? '0' : !date ? '3' : date >= today ? '1' : '2';
      return { day: d, problem, date, rank, sort: `${rank}${date ?? ''}` };
    })
    .sort((a, b) => a.sort.localeCompare(b.sort)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.special_days, calendar, year, today, t]);

  const armed = settings.special_days.filter(d => d.enabled).length;

  const presetUsed = (p: Preset) =>
    settings.special_days.some(d => d.id === p.id || d.title.trim().toLowerCase() === p.title.toLowerCase());

  const addPreset = (p: Preset) => {
    const day: SpecialDay = {
      id: p.id, title: p.title, message: '', enabled: true, mode: 'annual', date: p.date,
    };
    // Undated: hand it to the dialog so the admin supplies the date before anything is stored.
    if (!p.date) { onEdit(day); return; }
    onWrite({ ...settings, special_days: [...settings.special_days, day] }, `day-${p.id}`);
  };

  const toggleDay = (d: SpecialDay, on: boolean) => onWrite({
    ...settings,
    special_days: settings.special_days.map(x => (x.id === d.id ? { ...x, enabled: on } : x)),
  }, `day-${d.id}`);

  return (
    <div className="space-y-3">
      <BlockHeader
        icon={PartyPopper}
        title={t.greetingsSpecialDays}
        // What the LIST is, not what an occasion sends — the tile above already says that.
        description={t.greetingsDaysListHint}
        badge={(
          <>
            <Badge variant={armed ? 'brand' : 'muted'}>
              {t.greetingsDaysBadge.replace('{n}', String(settings.special_days.length))}
            </Badge>
            {/* The list can be full and still be sending nothing. Say so here, where the list
                is, rather than leaving the reader to remember a switch two blocks up. */}
            {!live && settings.special_days.length > 0 && (
              <Badge variant="warning">{t.greetingsNotSendingShort}</Badge>
            )}
          </>
        )}
        action={(
          <Button type="button" variant="outline" size="sm" className="h-10" onClick={() => onEdit(null)}>
            <Plus className="h-4 w-4" /> {t.greetingsAddDay}
          </Button>
        )}
      />

      {/* Quick add. A preset already on the list is shown as added rather than hidden, so the
          row of chips does not rearrange itself under the reader's finger. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">{t.greetingsQuickAdd}</span>
        {PRESETS.map(p => {
          const used = presetUsed(p);
          return (
            <button
              key={p.id} type="button" disabled={used || pending !== null}
              onClick={() => addPreset(p)}
              title={used ? t.greetingsPresetAdded : undefined}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                used
                  ? 'cursor-default border-border bg-muted/40 text-muted-foreground'
                  : 'border-border text-foreground hover:border-primary hover:bg-primary/10 hover:text-primary',
              )}
            >
              {used ? <Check aria-hidden className="h-3 w-3" /> : <Plus aria-hidden className="h-3 w-3" />}
              {p.title}
              {/* formatDayMonth wants a full date; a preset carries only 'MM-DD', so this
                  year supplies the rest. The chip is a label, not the stored value. */}
              {p.date && <span className="text-muted-foreground">{formatDayMonth(`${year}-${p.date}`)}</span>}
            </button>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          className="rounded-lg border border-dashed border-border py-10"
          title={t.greetingsNoDays}
          description={t.greetingsNoDaysHint}
          action={(
            <Button type="button" variant="outline" size="sm" className="h-10" onClick={() => onEdit(null)}>
              <Plus className="h-4 w-4" /> {t.greetingsAddDay}
            </Button>
          )}
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {rows.map(({ day: d, problem, date, rank }) => {
            const mode = modeOf(d);
            // The kind is carried by the icon and by a word, never by a colour: --primary,
            // --success and --brand are one azure, so hue cannot tell three kinds of day apart.
            const Icon = mode === 'calendar' ? CalendarDays : mode === 'annual' ? Repeat : CalendarClock;
            const kindWord = mode === 'calendar' ? t.greetingsModeCalendar
              : mode === 'annual' ? t.greetingsModeAnnual : t.greetingsModeOnce;
            const when = date
              ? (mode === 'annual'
                  ? `${t.greetingsEveryYear} · ${formatDayMonth(date)}`
                  : t.greetingsFallsOn.replace('{date}', formatLongDate(date)))
              : null;
            const busy = pending === `day-${d.id}`;
            return (
              <li key={d.id} className={cn('px-2 py-2', busy && 'opacity-60')}>
                <div className="flex items-center gap-1">
                  {/* The row itself opens the editor — a 14px pencil is not a phone target. */}
                  <button
                    type="button"
                    onClick={() => onEdit(d)}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`${t.greetingsEditDay}: ${d.title || d.id}`}
                  >
                    <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate text-sm', d.enabled ? 'text-foreground' : 'text-muted-foreground')}>
                        {d.title || t.greetingsDayTitle}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                        <span className="uppercase tracking-wide">{kindWord}</span>
                        {when && <span>{when}</span>}
                        {rank === '2' && <span>{t.greetingsDayPassed}</span>}
                        {/* Spans, not <Badge> (a div): the whole row is a button, and a button
                            may only hold phrasing content. Same look, from the same variants. */}
                        {/* Off is a word, not 60% opacity on 11px grey text. */}
                        {!d.enabled && (
                          <span className={badgeVariants({ variant: 'muted' })}>{t.greetingsDayOff}</span>
                        )}
                        {!problem && !date && (
                          <span className={badgeVariants({ variant: 'warning' })}>
                            {t.greetingsDayWontFire.replace('{year}', year)}
                          </span>
                        )}
                        {problem && (
                          <span className={badgeVariants({ variant: 'destructive' })}>{t.greetingsDayNeedsFixing}</span>
                        )}
                      </span>
                      {/* A day the calendar cannot place will not go out at all — that is worth
                          a sentence, not the same grey as a healthy row. */}
                      {!problem && !date && (
                        <span className="mt-1 block text-[11px] leading-relaxed text-warning">
                          {t.greetingsCalendarUnresolved.replace('{year}', year)}
                        </span>
                      )}
                      {problem && (
                        <span className="mt-1 block text-[11px] leading-relaxed text-destructive">{problem}</span>
                      )}
                    </span>
                    <Pencil aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                  <SwitchButton
                    variant="bare"
                    checked={d.enabled}
                    onChange={v => toggleDay(d, v)}
                    onWord={t.greetingsDayOn}
                    offWord={t.greetingsDayOff}
                    ariaLabel={`${d.title || t.greetingsSpecialDays} — ${t.greetingsDayOn}`}
                  />
                  <Button type="button" variant="ghost" size="icon"
                    className="h-10 w-10 shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={`${t.greetingsRemoveDay}: ${d.title || d.id}`}
                    onClick={() => setConfirmRemove(d)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmModal
        open={!!confirmRemove}
        onOpenChange={() => setConfirmRemove(null)}
        variant="danger"
        title={t.greetingsRemoveDayConfirm.replace('{name}', confirmRemove?.title || '')}
        description={t.greetingsRemoveDayBody}
        confirmText={t.greetingsRemoveDay}
        onConfirm={() => {
          if (confirmRemove) {
            onWrite({
              ...settings,
              special_days: settings.special_days.filter(d => d.id !== confirmRemove.id),
            }, `day-${confirmRemove.id}`);
          }
          setConfirmRemove(null);
        }}
      />
    </div>
  );
}
