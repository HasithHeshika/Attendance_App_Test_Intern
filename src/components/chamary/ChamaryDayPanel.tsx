'use client';
import { ChevronLeft, ChevronRight, Loader2, Search, X, Calendar as CalendarIcon, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/store/appStore';
import type { User } from '@/store/authStore';
import type { MealType } from '@/lib/meals';
import type { ChamaryDay } from '@/lib/chamaryMonth';
import type { ChamaryWithPlace } from '@/services/workingPlaceService';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import MyChamaryLunchCard from '@/components/lunch/MyChamaryLunchCard';
import { dayPhase, prettyDate } from './chamaryFormat';

interface Props {
  date:         string;
  /** The month view's row for `date`; null until the month has loaded. */
  day:          ChamaryDay | null;
  served:       MealType[];
  loadingMonth: boolean;
  today:        string;
  search:       string;
  onSearch:     (q: string) => void;
  user:         User | null;
  chamaries:    ChamaryWithPlace[];
  onChanged:    () => void;
  onSelectDate?: (date: string) => void;
  /** Bumped by the page when an auto-serve pass wrote something. The roster below holds its own
   *  copy of the day, fetched on mount, so a change made behind its back is only visible if it
   *  reads again — remounting on this token is what makes it. */
  rosterToken?: number;
  /** The month read failed, so `day` is not evidence of anything. The roster below fetches the day
   *  itself and can still be full — which is exactly what happened: the panel announced "nobody is
   *  down for this day" directly above seven names it had just listed. */
  monthUnknown?: boolean;
}

function shiftDate(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + deltaDays);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export default function ChamaryDayPanel({
  date, day, served, loadingMonth, today, search, onSearch, user, chamaries, onChanged, onSelectDate,
  rosterToken = 0, monthUnknown = false,
}: Props) {
  const t = useT();
  const mealName: Record<MealType, string> = {
    breakfast: t.mealBreakfast, lunch: t.mealLunch, dinner: t.mealDinner,
  };
  const phase = dayPhase(date, today);
  const isToday = date === today;
  const only = chamaries.length === 1 ? chamaries[0] : null;

  const collectedPct = day && day.total > 0 ? Math.round((day.served / day.total) * 100) : 0;
  const missedCount = day && phase === 'past' ? Math.max(0, day.total - day.served) : 0;
  const pendingCount = day && phase === 'today' ? Math.max(0, day.total - day.served) : 0;

  return (
    <Card className="overflow-hidden border-border/80 bg-card shadow-sm">
      {/* ── Top Header & Stepper Bar ── */}
      <div className="border-b border-border/60 bg-muted/20 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          {/* Phase Badge & Kitchen identity */}
          <div className="flex items-center gap-2">
            {isToday ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                {t.todayWord}
              </span>
            ) : phase === 'future' ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-sky-600 dark:text-sky-400">
                <CalendarIcon className="h-3 w-3" />
                {t.bookedWord}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                Past Record
              </span>
            )}

            {only && (
              <span className="truncate text-xs font-medium text-muted-foreground">
                {only.name}{only.working_place_name ? ` · ${only.working_place_name}` : ''}
              </span>
            )}
          </div>

          {/* Stepper Controls (< Prev, Today, Next >) */}
          {onSelectDate && (
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                onClick={() => onSelectDate(shiftDate(date, -1))}
                title="Previous day"
                aria-label="Previous day"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>

              {!isToday && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px] font-medium text-foreground"
                  onClick={() => onSelectDate(today)}
                >
                  {t.todayWord}
                </Button>
              )}

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                onClick={() => onSelectDate(shiftDate(date, 1))}
                title="Next day"
                aria-label="Next day"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>

        {/* Date Title & Total Meals Hero */}
        <div className="mt-2 flex items-baseline justify-between gap-2">
          <div>
            <h3 className="text-lg font-bold tracking-tight text-foreground sm:text-xl">
              {prettyDate(date)}
            </h3>
          </div>

          {day && day.total > 0 && (
            <div className="flex items-baseline gap-1 text-right">
              <span className="text-2xl font-black tabular-nums tracking-tight text-foreground sm:text-3xl">
                {day.total}
              </span>
              <span className="text-xs font-medium text-muted-foreground">
                {t.mealsWord.toLowerCase()}
              </span>
            </div>
          )}
        </div>

        {/* Collection & Breakdown Metrics */}
        {day && day.total > 0 && (
          <div className="mt-3 space-y-2 pt-2 border-t border-border/40">
            {/* Meal pills */}
            <div className="flex flex-wrap items-center gap-1.5">
              {served.map(m => {
                const off = day.off.includes(m);
                return (
                  <span
                    key={m}
                    title={off ? (day.offReason[m] || t.notCookingWord) : undefined}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium transition-colors',
                      off
                        ? 'border border-dashed border-border bg-muted/40 text-muted-foreground line-through'
                        : day.byMeal[m] > 0
                          ? 'border border-primary/20 bg-primary/10 text-primary font-semibold'
                          : 'border border-border/60 text-muted-foreground',
                    )}
                  >
                    <span>{mealName[m]}</span>
                    {!off && <span className="tabular-nums">{day.byMeal[m]}</span>}
                  </span>
                );
              })}

              <div className="ml-auto text-xs tabular-nums">
                {phase === 'past' ? (
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    <span>{day.served} {t.servedWord.toLowerCase()}</span>
                    {missedCount > 0 && (
                      <span className="font-semibold text-destructive inline-flex items-center gap-0.5">
                        · {missedCount} {t.noShowWord.toLowerCase()}
                      </span>
                    )}
                  </span>
                ) : phase === 'today' ? (
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                      {day.served} {t.collectedWord.toLowerCase()}
                    </span>
                    <span>·</span>
                    <span className="font-medium text-foreground">
                      {pendingCount} not yet
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    {day.total} {t.bookedWord.toLowerCase()}
                  </span>
                )}
              </div>
            </div>

            {/* Daily Fulfillment Progress Bar */}
            {phase !== 'future' && (
              <div className="space-y-1 pt-1">
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>{t.collectedWord} Progress</span>
                  <span className="font-semibold text-foreground">{collectedPct}%</span>
                </div>
                <Progress value={collectedPct} className="h-1.5" />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="p-4 sm:p-5 space-y-4">
        {/* Future day or empty hint */}
        {phase === 'future' && (
          <p className="rounded-lg border border-dashed border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
            {t.futureDayHint}
          </p>
        )}
        {/* "Nobody booked" and "we could not find out" are different answers and must not share a
            banner — the second one said the first for days, over a full roster. */}
        {!loadingMonth && monthUnknown && phase !== 'future' && (
          <div className="rounded-lg border border-dashed border-destructive/40 bg-destructive/5 px-3 py-4 text-center text-xs text-foreground">
            <AlertCircle className="mx-auto mb-1 h-4 w-4 text-destructive" />
            {t.chamaryDayUnknown}
          </div>
        )}
        {!loadingMonth && !monthUnknown && day && day.total === 0 && phase !== 'future' && (
          <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
            <AlertCircle className="mx-auto mb-1 h-4 w-4 text-muted-foreground/60" />
            {t.noBookingsDay}
          </div>
        )}

        {/* What the ticks below mean now that nobody has to make them. Says it on any day that
            has a list and is not still ahead, because the rule is the same whether the meal has
            settled yet or is about to. English fallback: no TRANSLATIONS keys yet — see the
            report accompanying this change. */}
        {!loadingMonth && day && day.total > 0 && phase !== 'future' && (
          <p className="flex items-start gap-2 border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
            <span>{t.chamaryAutoServedNote}</span>
          </p>
        )}

        {/* Live Filter / Search Input */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => onSearch(e.target.value)}
            placeholder={t.searchNameEpf}
            aria-label={t.searchNameEpf}
            className="pl-9 pr-8 text-xs bg-muted/30"
          />
          {search && (
            <button
              type="button"
              onClick={() => onSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Loader */}
        {loadingMonth && (
          <div className="flex justify-center py-4" role="status" aria-live="polite">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
          </div>
        )}

        {/* The Roster Operations (MyChamaryLunchCard). Keyed on the auto-serve token so a pass
            that ticked names behind its back makes it fetch the day again. */}
        <div>
          <MyChamaryLunchCard
            key={`roster-${rosterToken}`}
            bare
            user={user}
            date={date}
            chamaries={chamaries}
            search={search}
            onChanged={onChanged}
          />
        </div>
      </div>
    </Card>
  );
}
