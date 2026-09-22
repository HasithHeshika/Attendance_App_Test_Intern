'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { UtensilsCrossed, Loader2, Building2, Check, Lock, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { getMyMealsThisMonth, getChamaryMealsMonthly, cancelMeal } from '@/services/mealService';
import { getChamaryExpenses, formatSuspenseAmount } from '@/services/suspenseService';
import { useT } from '@/store/appStore';
import { localDateString, cn } from '@/lib/utils';
import { mealOf, MEAL_ORDER, type MealType } from '@/lib/meals';
import { indicativeMealRate, INDICATIVE_LOOKBACK_MONTHS, type IndicativeRate } from '@/lib/foodReport';
import type { LunchRequest } from '@/lib/types';
import { Card } from '@/components/ui/card';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

interface MealGroup { meal: MealType; rows: LunchRequest[] }
interface ChamaryGroup { chamary_id: string; chamary_name: string; total: number; meals: MealGroup[] }

// "Mon 3" — the card header already names the month, so the weekday and day place a booking on
// their own; the full date rides along in each pill's title and aria text.
function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
}

/**
 * Why this booking can no longer be changed, or null when the person may still cancel it.
 *
 * Every booking feeds its chamary's monthly split (approved spend ÷ total meals × each person's
 * own count), so removing one after the fact silently shifts that cost onto everyone else who
 * ate — the chamary has already cooked and been billed. Hence: today only, and only until the
 * responsible person ticks it served. Nothing ever writes a booking for a future day
 * (requestMeal is only ever called with the current date), so "not today" means the day passed.
 */
function frozenReason(r: LunchRequest, today: string): string | null {
  if (r.served)         return 'Already ticked as served — you collected this meal, so it stays on the count.';
  if (r.date !== today) return 'Past day — the chamary has already cooked and been billed for it.';
  return null;
}

// A closed month's rate only moves if a late bill is approved against it, and this card sits on a
// page every one of 300+ employees opens, so an answer is held for the session rather than
// re-fetched per mount. Keyed by the month it was worked out FOR — the basis shifts when a month
// rolls over.
const rateCache = new Map<string, { value: IndicativeRate; at: number }>();
const RATE_TTL_MS = 60 * 60_000;

/**
 * The per-meal rate to show for one chamary in the month `ref` falls in: the newest CLOSED month
 * that actually had meals, at most INDICATIVE_LOOKBACK_MONTHS back.
 *
 * Lives here rather than in foodReport.ts, which stays free of Firestore so the arithmetic can be
 * unit tested; FoodReport.tsx (admin) imports it from here so both surfaces show staff the same
 * number and share this cache.
 */
export async function loadIndicativeRate(chamaryId: string, ref: Date): Promise<IndicativeRate> {
  const key = `${chamaryId}__${ref.getFullYear()}-${ref.getMonth()}`;
  const hit = rateCache.get(key);
  if (hit && Date.now() - hit.at < RATE_TTL_MS) return hit.value;

  const closed: Array<{ month: string; bookings: LunchRequest[]; approvedSpend: number }> = [];
  for (let back = 1; back <= INDICATIVE_LOOKBACK_MONTHS; back++) {
    const from  = new Date(ref.getFullYear(), ref.getMonth() - back, 1);
    const year  = from.getFullYear();
    const month = from.getMonth() + 1;
    const [bookings, expenses] = await Promise.all([
      getChamaryMealsMonthly(chamaryId, year, month),
      getChamaryExpenses(chamaryId, from.getTime(), new Date(year, month, 1).getTime() - 1),
    ]);
    closed.push({
      month:         `${MONTHS[month - 1]} ${year}`,
      bookings,
      approvedSpend: expenses.reduce((total, s) => total + (s.amount || 0), 0),
    });
    // getChamaryMealsMonthly re-reads the chamary's ENTIRE booking history on every call, so stop
    // at the first month with meals. Walking further back is only for a chamary that sat idle.
    if (bookings.length) break;
  }

  const value = indicativeMealRate(closed);
  rateCache.set(key, { value, at: Date.now() });
  return value;
}

// What this month is likely to cost at one chamary. Never the running month's own rate: the bills
// land in bulk early while the meals accrue daily, so a mid-month figure reads several times what
// it settles at — see indicativeMealRate.
function IndicativeCost({ rate, meals, mealsWord }: { rate: IndicativeRate; meals: number; mealsWord: string }) {
  return (
    <div className="mb-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
      {rate.ratePerMeal === null ? (
        'No settled rate yet — the cost per meal is set when the month closes.'
      ) : (
        <>
          <span className="font-semibold text-foreground">{formatSuspenseAmount(rate.ratePerMeal)}</span> per meal
          {' — indicative, from '}{rate.basisMonth}
          <div className="text-muted-foreground/80">
            Your {meals} {mealsWord} this month ≈{' '}
            <span className="font-semibold text-foreground">{formatSuspenseAmount(rate.ratePerMeal * meals)}</span>.
            {' '}The real rate is set when this month closes.
          </div>
        </>
      )}
    </div>
  );
}

// This employee's own meal count for the current month — how many meals will feed into the food
// deduction (a chamary's approved bills ÷ its total meals × their own meal count; the split is
// equal across meal types, so breakfast, lunch and dinner all count the same).
// Not role-gated: a technician could've been added to a chamary's list by its responsible
// person even without the self-request button, so this shows real data for anyone who has any.
export default function MyLunchCount({ epf }: { epf: string }) {
  const t = useT();
  // The app clock the bookings are filed under, not the device's — a raw `new Date()` would call
  // a booking "past" (and freeze it) for anyone whose device sits in a later zone near midnight.
  const today = localDateString();
  const [rows, setRows]       = useState<LunchRequest[] | null>(null);
  const [label, setLabel]     = useState('');
  const [rates, setRates]     = useState<Record<string, IndicativeRate>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Re-read after a cancel rather than splicing the row out locally: the header count, the
  // chamary grouping and the indicative cost line all derive from `rows`, so one shared source
  // keeps them from disagreeing.
  const reload = useCallback(async () => {
    const now = new Date();
    setRows(await getMyMealsThisMonth(epf, now.getFullYear(), now.getMonth() + 1));
  }, [epf]);

  useEffect(() => {
    if (!epf) return;
    const now = new Date();
    setLabel(`${MONTHS[now.getMonth()]} ${now.getFullYear()}`);
    reload().catch(() => setRows([]));
  }, [epf, reload]);

  // Group by chamary — the deduction basis is per-chamary, so seeing meals clustered that way
  // matters more than a flat chronological list — then by meal within each chamary. `rows` is
  // already date-ascending, so each group's dates come out chronological for free. Busiest
  // chamary first.
  const groups = useMemo<ChamaryGroup[]>(() => {
    if (!rows) return [];
    const byId = new Map<string, ChamaryGroup>();
    for (const r of rows) {
      let g = byId.get(r.chamary_id);
      if (!g) {
        g = { chamary_id: r.chamary_id, chamary_name: r.chamary_name, total: 0, meals: [] };
        byId.set(r.chamary_id, g);
      }
      const meal = mealOf(r.meal);
      const mg = g.meals.find(m => m.meal === meal);
      if (mg) mg.rows.push(r);
      else g.meals.push({ meal, rows: [r] });
      g.total += 1;
    }
    for (const g of byId.values()) g.meals.sort((a, b) => MEAL_ORDER[a.meal] - MEAL_ORDER[b.meal]);
    return Array.from(byId.values()).sort((a, b) => b.total - a.total || a.chamary_name.localeCompare(b.chamary_name));
  }, [rows]);

  // One pass per chamary the person ate at, all of them at once, and only when that set actually
  // changes — a string key, so a re-render with the same chamaries re-runs nothing. A chamary whose
  // read fails is left out of `rates` and simply shows no cost line, rather than claiming there is
  // no settled rate.
  const chamaryKey = groups.map(g => g.chamary_id).join(',');
  useEffect(() => {
    if (!chamaryKey) return;
    let cancelled = false;
    const ref = new Date();
    Promise.all(chamaryKey.split(',').map(async id => {
      try { return [id, await loadIndicativeRate(id, ref)] as const; }
      catch { return null; }
    })).then(pairs => {
      if (!cancelled) setRates(Object.fromEntries(pairs.filter((p): p is [string, IndicativeRate] => p !== null)));
    });
    return () => { cancelled = true; };
  }, [chamaryKey]);

  const mealName: Record<MealType, string> = {
    breakfast: t.mealBreakfast, lunch: t.mealLunch, dinner: t.mealDinner,
  };

  // Self-cancel: no expectedChamaryId guard — this deletes the person's OWN booking, whatever
  // chamary it currently sits at. Only reachable when frozenReason() says the day is still open.
  const cancel = async (r: LunchRequest) => {
    const meal = mealOf(r.meal);
    setBusyKey(`${r.date}__${meal}`);
    try {
      await cancelMeal(epf, r.date, meal);
      toast.success(t.mealCancelledToast.replace('{meal}', mealName[meal]));
    } catch (e) { toast.error(errMsg(e, t.failedCancelMeal)); }
    // Re-read either way, and outside the try: a failed cancel usually means the booking changed
    // underneath, and a re-read that fails after the delete DID land must not be reported as a
    // failed cancel. A re-read that fails leaves the last known list up rather than blanking it.
    finally {
      await reload().catch(() => undefined);
      setBusyKey(null);
    }
  };

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
          <UtensilsCrossed className="h-3.5 w-3.5" /> {t.mealRequestsTitle} · {label}
        </div>
        {rows !== null && <div className="text-base font-bold tabular-nums text-foreground">{rows.length}</div>}
      </div>

      {rows === null ? (
        <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t.noMealRequestsMonth}</p>
      ) : (
        <div className="space-y-3">
          {groups.map(g => (
            <div key={g.chamary_id}>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> {g.chamary_name}
                </span>
                <span className="text-[11px] font-medium text-muted-foreground">
                  {g.total} {t.mealsWord}
                </span>
              </div>
              {rates[g.chamary_id] && (
                <IndicativeCost rate={rates[g.chamary_id]} meals={g.total} mealsWord={t.mealsWord} />
              )}
              <div className="space-y-1.5">
                {g.meals.map(m => (
                  <div key={m.meal}>
                    <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                      {mealName[m.meal]} <span className="text-muted-foreground/70">({m.rows.length})</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {m.rows.map(r => {
                        const frozen = frozenReason(r, today);
                        const busy   = busyKey === `${r.date}__${m.meal}`;
                        return (
                          <span
                            key={r.date}
                            title={`${r.date}${frozen ? ` — ${frozen}` : ''}`}
                            className={cn(
                              'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs',
                              r.served
                                ? 'border-primary/40 bg-primary/10 text-foreground'
                                : 'border-border/60 bg-card/50 text-muted-foreground',
                            )}
                          >
                            {/* Served is carried by the tick as well as the tint — never colour alone. */}
                            {r.served && <Check className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />}
                            <time dateTime={r.date}>{dayLabel(r.date)}</time>
                            {(r.served || frozen) && (
                              <span className="sr-only">
                                {r.served ? ` — ${t.servedWord}` : ''}{frozen ? ` — ${frozen}` : ''}
                              </span>
                            )}
                            {!frozen ? (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => cancel(r)}
                                title={`${t.cancelMealWord} — ${mealName[m.meal]} · ${r.date}`}
                                aria-label={`${t.cancelMealWord} — ${mealName[m.meal]} · ${r.date}`}
                                className="-mr-1 rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                              >
                                {busy
                                  ? <Loader2 className="h-3 w-3 animate-spin" />
                                  : <X className="h-3 w-3" />}
                              </button>
                            ) : r.served ? null : (
                              // A frozen day shows a lock instead of a dead button; the reason is on
                              // the pill's title and in its screen-reader text.
                              <Lock className="h-3 w-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                            )}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
