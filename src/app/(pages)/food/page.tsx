'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ClipboardList, Receipt, UtensilsCrossed } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { useRoles, useUserCapabilities } from '@/store/rolesStore';
import { categoryAllowed, roleCategory } from '@/lib/permissions';
import { useT } from '@/store/appStore';
import { tenant } from '@/lib/firebase';
import { localDateString } from '@/lib/utils';
import { mealOf, type MealType } from '@/lib/meals';
import { multiplierOf } from '@/lib/foodCost';
import { buildChamaryMonth, dayKey } from '@/lib/chamaryMonth';
import { formatSuspenseAmount } from '@/services/suspenseService';
import {
  getMyMealsThisMonth, cancelMeal, markMealNotTaken, setMealServed, getMyFoodCost,
  type Actor, type MyFoodCost,
} from '@/services/mealService';
import { getMyMealChangeRequests } from '@/services/mealChangeService';
import { listAllChamaries, type ChamaryWithPlace } from '@/services/workingPlaceService';
import type { LunchRequest, MealChangeRequest } from '@/lib/types';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, StatCardsSkeleton } from '@/components/ui/Skeleton';
import { PageTransition, Reveal } from '@/components/ui/motion';
import MonthYearPicker from '@/components/MonthYearPicker';
import { prettyDateShort } from '@/components/chamary/chamaryFormat';
import MyMealCalendar from '@/components/food/MyMealCalendar';
import MealDayPanel from '@/components/food/MealDayPanel';
import MealChangeDialog from '@/components/food/MealChangeDialog';
import MyChamaryBreakdown, { type ChamaryGroup } from '@/components/food/MyChamaryBreakdown';
import MultiplierBadge from '@/components/food/MultiplierBadge';
import WhoIsEatingCard from '@/components/food/WhoIsEatingCard';
import { bookingKey, groupByDate } from '@/components/food/foodFormat';

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const pad2 = (n: number) => String(n).padStart(2, '0');

// A person's own food: the month on a calendar, one day in detail, what it is likely to cost,
// and the two things they can do about a booking.
//
// Same month/day shape as /chamary on purpose — the calendar on the left drives the panel on
// the right, and (for whoever answers for the food spend) the "who's eating" card underneath,
// so there is ONE date on the page rather than three controls that can disagree. The totals go
// through `buildChamaryMonth`, the same pure reducer the chamary page uses, so "meals",
// "collected" and "no-shows" mean the same thing on both screens.
export default function FoodPage() {
  const t     = useT();
  const user  = useAuthStore(s => s.user);
  const epf   = user?.epf_number ?? '';
  const today = localDateString();
  const caps  = useUserCapabilities();
  const { roles } = useRoles();
  const isFoodAdmin = caps.is_system_admin || caps.can_approve_suspense;

  const now      = new Date();
  const thisYear = now.getFullYear();
  const thisMon  = now.getMonth() + 1;

  const [year, setYear]   = useState(thisYear);
  const [month, setMonth] = useState(thisMon);
  const [date, setDate]   = useState(today);
  const monthKey = `${year}-${pad2(month)}`;

  // Bookings are kept WITH the month they were read for. Holding them apart lets a render
  // between "month changed" and "data arrived" show this month's dates against last month's
  // meals — a lie the calendar cannot detect from the rows alone.
  const [monthData, setMonthData] = useState<{ key: string; rows: LunchRequest[] } | null>(null);
  const [failed, setFailed]       = useState(false);
  const [changes, setChanges]     = useState<MealChangeRequest[]>([]);
  const [chamaries, setChamaries] = useState<ChamaryWithPlace[]>([]);
  // Kept WITH the month it was read for, exactly like the bookings above: a render between
  // "month changed" and "figure arrived" would otherwise print last month's money under this
  // month's dates, and money is the one number nobody can spot as wrong by eye.
  const [cost, setCost]           = useState<{ key: string; data: MyFoodCost | null } | null>(null);
  const [busyKey, setBusyKey]     = useState<string | null>(null);
  const [changeTarget, setChangeTarget] = useState<LunchRequest | null>(null);

  const actor: Actor = { epf, name: user?.name ?? '' };
  const mealName: Record<MealType, string> = {
    breakfast: t.mealBreakfast, lunch: t.mealLunch, dinner: t.mealDinner,
  };

  // ── The month ──────────────────────────────────────────────────────────────
  // A token, not a cancelled flag: stepping quickly through months leaves several reads in
  // flight and only the newest one may write. `silent` is for a re-read after the person
  // cancelled a meal — the numbers stay up rather than collapsing into skeletons.
  const reqRef = useRef(0);
  const load = useCallback(async (silent = false) => {
    const token = ++reqRef.current;
    if (!epf) { setMonthData({ key: monthKey, rows: [] }); return; }
    if (!silent) setMonthData(null);
    setFailed(false);
    try {
      const [meals, mine] = await Promise.all([
        getMyMealsThisMonth(epf, year, month),
        getMyMealChangeRequests(epf).catch(() => [] as MealChangeRequest[]),
      ]);
      if (reqRef.current !== token) return;
      setMonthData({ key: monthKey, rows: meals });
      setChanges(mine);
    } catch {
      if (reqRef.current !== token) return;
      // Deliberately not "no meals this month": a denied or dropped read is not an empty month,
      // and telling someone they ate nothing when the query failed is worse than saying so.
      setMonthData(null);
      setFailed(true);
    }
  }, [epf, year, month, monthKey]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!tenant.features.suspense) return;
    listAllChamaries().then(setChamaries).catch(() => {});
  }, []);

  const rows         = useMemo(() => monthData?.rows ?? [], [monthData]);
  const monthLoading = monthData === null || monthData.key !== monthKey;

  const view = useMemo(() => {
    if (!monthData) return null;
    const y = Number(monthData.key.slice(0, 4));
    const m = Number(monthData.key.slice(5, 7));
    return buildChamaryMonth({ bookings: monthData.rows, offdays: [], year: y, month: m, today });
  }, [monthData, today]);
  const mv = view && view.year === year && view.month === month ? view : null;

  const mealsByDate = useMemo(() => groupByDate(rows), [rows]);

  const byChamary = useMemo<ChamaryGroup[]>(() => {
    const m = new Map<string, ChamaryGroup>();
    for (const r of rows) {
      const g = m.get(r.chamary_id) ?? { id: r.chamary_id, name: r.chamary_name, rows: [] };
      g.rows.push(r);
      m.set(r.chamary_id, g);
    }
    return [...m.values()].sort((a, b) => b.rows.length - a.rows.length);
  }, [rows]);

  // ── What the month actually costs ──────────────────────────────────────────
  // The bills the chamary really filed, divided among the food it served — not a rate inferred
  // from a closed month, which is what this page used to show. It is a server read because the
  // divisor is EVERY booking at that chamary: pricing one person in the browser would mean
  // reading the whole canteen's month, around 6,600 documents for a 300-person site. See
  // /api/food/my-cost and src/lib/foodCost.ts.
  useEffect(() => {
    let cancelled = false;
    setCost(null);
    if (!epf) { setCost({ key: monthKey, data: null }); return; }
    getMyFoodCost(monthKey, today).then(data => {
      if (!cancelled) setCost({ key: monthKey, data });
    });
    return () => { cancelled = true; };
  }, [epf, monthKey, today]);

  const costReady = cost !== null && cost.key === monthKey;
  const myCost    = costReady ? cost.data : null;
  // Per chamary, so the breakdown card can say what each canteen came to rather than repeating
  // one total.
  //
  // FILTERED ON bills_count, and that filter is the whole point: the route returns an entry for
  // every chamary this person ate at, and one with no bills filed yet gets `charge: 0` — a real
  // zero out of a share price of zero. Mapping those in would print a settled-looking "LKR 0.00"
  // for a cost nobody has worked out, which is the exact defect this feature replaced. The
  // filter is on the bill COUNT and not on `charge !== 0`, so a kitchen that really filed a
  // zero-amount bill still shows LKR 0.00 — that one is a priced zero.
  const charges = useMemo(
    () => Object.fromEntries(
      (myCost?.byChamary ?? []).filter(c => c.bills_count > 0).map(c => [c.id, c.charge]),
    ),
    [myCost],
  );

  // Meals charged at other than the normal rate, grouped BY RATE. Surfaced on the month line as
  // well as on the day that carries each one, because a month total nobody can decompose is
  // exactly how an unexplained charge stays unexplained.
  //
  // Grouped rather than "one row's badge plus the count of all of them": a month holding one 2×
  // and two 0.5× would otherwise read as "2× late · 3 meals charged at a different rate", which
  // says somebody was penalised three times when they were penalised once and credited twice.
  const offRate = useMemo(() => rows.filter(r => multiplierOf(r) !== 1), [rows]);
  const offRateByRate = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of offRate) {
      const m = multiplierOf(r);
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    // Dearest first: the charge somebody will ask about leads.
    return [...counts.entries()].sort((a, b) => b[0] - a[0]);
  }, [offRate]);

  // ── Who else can this person see eating ────────────────────────────────────
  const myCategory = roleCategory(user?.role, roles);
  const ateAt = useMemo(() => new Set(rows.map(r => r.chamary_id)), [rows]);
  const scopedChamaries = useMemo(() => {
    if (isFoodAdmin) return chamaries;
    return chamaries.filter(c =>
      c.responsible_epf === epf ||
      categoryAllowed(c.categories, myCategory) ||
      ateAt.has(c.id),
    );
  }, [chamaries, isFoodAdmin, epf, myCategory, ateAt]);

  // ── Corrections this person has asked for ──────────────────────────────────
  const pendingMine = changes.filter(c => c.status === 'pending');
  const decidedMine = changes
    .filter(c => c.status !== 'pending' && c.date.startsWith(monthKey))
    .slice(0, 4);

  // ── Navigation ─────────────────────────────────────────────────────────────
  const isCurrentMonth = year === thisYear && month === thisMon;
  const showToday = date !== today || !isCurrentMonth;
  const goToday = () => { setYear(thisYear); setMonth(thisMon); setDate(today); };
  const changeMonth = (y: number, m: number) => {
    setYear(y); setMonth(m);
    setDate(y === thisYear && m === thisMon ? today : dayKey(y, m, 1));
  };
  // The day stepper may walk off the end of the month; the grid follows it there.
  const selectDate = (next: string) => {
    setDate(next);
    const y = Number(next.slice(0, 4));
    const m = Number(next.slice(5, 7));
    if (y && m && (y !== year || m !== month)) { setYear(y); setMonth(m); }
  };

  const cancelToday = async (row: LunchRequest) => {
    const meal = mealOf(row.meal);
    setBusyKey(bookingKey(row));
    try {
      await cancelMeal(epf, row.date, meal, row.chamary_id);
      toast.success(t.mealCancelledToast.replace(/\{meal\}/g, mealName[meal].toLowerCase()));
      await load(true);
    } catch (e) {
      toast.error(errMsg(e, t.failedCancelMeal));
    } finally { setBusyKey(null); }
  };

  // The person's own statement about a meal already recorded as collected. Deliberately NOT
  // routed through meal_change_requests: needing someone's approval to state a fact about your
  // own lunch is what pushed people into that queue in the first place. The operator can still
  // overrule it from /chamary, which is right — they were at the counter.
  const setNotTaken = async (row: LunchRequest, notTaken: boolean) => {
    const meal = mealOf(row.meal);
    setBusyKey(bookingKey(row));
    try {
      if (notTaken) await markMealNotTaken(epf, row.date, meal);
      else await setMealServed(epf, row.date, meal, true);
      toast.success(notTaken ? t.foodDidNotTakeToast : t.collectedWord);
      await load(true);
    } catch (e) {
      toast.error(errMsg(e, t.foodLoadFailed));
    } finally { setBusyKey(null); }
  };

  if (!tenant.features.suspense) {
    return (
      <PageTransition>
        <EmptyState icon={UtensilsCrossed} title={t.noAccessTitle} description={t.noAccessSection} />
      </PageTransition>
    );
  }

  const collectedPct = mv && mv.totals.meals > 0 ? Math.round((mv.totals.served / mv.totals.meals) * 100) : 0;

  return (
    <PageTransition>
      <div className="space-y-5">
        <PageHeader
          icon={UtensilsCrossed}
          title={t.navMyFood}
          description={t.foodPageDesc}
          actions={(
            <>
              {/* The picker's trigger is w-full by design; boxing it keeps Today beside it. */}
              <div className="w-44">
                <MonthYearPicker
                  year={year}
                  month={month}
                  years={[thisYear - 1, thisYear]}
                  onChange={changeMonth}
                />
              </div>
              {showToday && <Button variant="outline" onClick={goToday}>{t.todayWord}</Button>}
            </>
          )}
        />

        {failed ? (
          <Reveal>
            <Card className="p-2">
              <EmptyState
                icon={AlertCircle}
                title={t.foodLoadFailed}
                action={<Button variant="outline" onClick={() => void load()}>{t.tryAgain}</Button>}
              />
            </Card>
          </Reveal>
        ) : (
          <>
            {/* ── The month, in one line ──
                Four tiles used to say what is really one fact plus one exception: "1 meal",
                "1/1 collected" and "0 not collected" are the same number three times, and on a
                sparse month that grid was almost all chrome. So it is a strip that reads as a
                sentence and grows a line only when there is something extra to say. */}
            {!mv ? (
              <StatCardsSkeleton count={1} />
            ) : (
              <Reveal>
                <Card className="space-y-3 p-4 sm:p-5">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-2xl font-bold tabular-nums leading-none text-foreground">
                      {mv.totals.meals}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {t.mealsWord.toLowerCase()} · {t.thisMonth.toLowerCase()}
                    </span>
                    <span className="ml-auto text-sm text-muted-foreground">
                      {mv.totals.served}/{mv.totals.meals} {t.collectedWord.toLowerCase()}
                    </span>
                  </div>

                  {mv.totals.meals > 0 && (
                    <Progress
                      value={collectedPct}
                      className="h-1.5"
                      aria-label={`${t.collectedWord} ${collectedPct}%`}
                    />
                  )}

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                    {/* The cost tells the truth, and its four states mean four different
                        things: still being read, could not be read, no bills filed yet, and a
                        real figure. This line used to print "LKR 0.00" while admitting in its
                        own hint that no rate was settled — a number somebody could budget
                        against, for a cost that was simply unknown.

                        A month in progress is labelled provisional and carries last month
                        beside it, because its bills are still arriving and its share price
                        usually rises. A provisional figure with nothing to compare against is
                        not information. */}
                    {mv.totals.meals > 0 && (
                      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        <Receipt className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        {!costReady ? (
                          <Skeleton className="h-3.5 w-28" />
                        ) : !myCost ? (
                          <span className="text-muted-foreground">{t.foodCostUnknown}</span>
                        ) : !myCost.priced ? (
                          <span className="text-muted-foreground">{t.foodNotPricedYet}</span>
                        ) : (
                          <>
                            <span className="font-semibold text-foreground">
                              {formatSuspenseAmount(myCost.charge, 'LKR')}
                            </span>
                            <span className="text-muted-foreground">
                              {myCost.provisional ? t.foodProvisional : t.foodSettled}
                            </span>
                            {myCost.provisional && myCost.last_month?.priced && (
                              <span className="text-muted-foreground">
                                · {t.foodLastMonth.replace(
                                  '{amount}',
                                  formatSuspenseAmount(myCost.last_month.charge, 'LKR'),
                                )}
                              </span>
                            )}
                          </>
                        )}
                      </span>
                    )}

                    {/* Charged at something other than the normal rate — each rate with its own
                        count here, the reason on the day. The badge is fed a bare multiplier
                        rather than a row, so one meal's note is never attached to a group. */}
                    {offRateByRate.length > 0 && (
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {offRateByRate.map(([mult, n]) => (
                          <span key={mult} className="inline-flex items-center gap-1">
                            <MultiplierBadge row={{ multiplier: mult }} />
                            <span className="text-muted-foreground">
                              {n} {t.mealsWord.toLowerCase()}
                            </span>
                          </span>
                        ))}
                        <span className="text-muted-foreground">{t.foodChargedDifferently}</span>
                      </span>
                    )}

                    {/* An exception earns its own line; a zero does not. */}
                    {mv.totals.noShows > 0 && (
                      <span className="flex items-center gap-1.5 text-warning">
                        <AlertCircle className="h-3.5 w-3.5" aria-hidden />
                        <span className="font-semibold">
                          {mv.totals.noShows} {t.foodNotCollectedLabel.toLowerCase()}
                        </span>
                        <span className="text-muted-foreground">{t.foodStillChargedHint}</span>
                      </span>
                    )}

                    {/* Where, when there is only one answer — the breakdown card below drops to
                        a single line in that case and this saves the reader looking for it. */}
                    {byChamary.length === 1 && (
                      <span className="text-muted-foreground">
                        {t.foodAllAtOne.replace('{name}', byChamary[0].name)}
                      </span>
                    )}
                  </div>
                </Card>
              </Reveal>
            )}

            {/* ── Corrections asked for ── */}
            {(pendingMine.length > 0 || decidedMine.length > 0) && (
              <Reveal>
                <Card className="p-4 sm:p-5">
                  <div className="mb-3 flex items-center gap-2 border-b border-border/40 pb-3">
                    <ClipboardList className="h-4 w-4 text-primary" aria-hidden />
                    <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      {pendingMine.length > 0 ? t.foodWaitingApprovalTitle : t.foodDecidedRecently}
                    </span>
                    {pendingMine.length > 0 && (
                      <span className="inline-flex items-center rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-warning">
                        {pendingMine.length}
                      </span>
                    )}
                  </div>
                  <ul className="space-y-2">
                    {[...pendingMine, ...decidedMine].map(c => (
                      <li
                        key={c.id}
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs"
                      >
                        <Badge variant={c.status === 'pending' ? 'warning' : c.status === 'approved' ? 'success' : 'destructive'}>
                          {c.status === 'pending' ? t.foodWaitingWord
                            : c.status === 'approved' ? t.foodApprovedWord : t.foodRejectedWord}
                        </Badge>
                        <span className="font-medium text-foreground">
                          {c.kind === 'remove' ? t.foodRemoveWord : t.moveWord} · {mealName[mealOf(c.meal)]}
                        </span>
                        <span className="text-muted-foreground">{prettyDateShort(c.date)}</span>
                        <span className="text-muted-foreground">
                          {c.chamary_name}{c.to_chamary_name ? ` → ${c.to_chamary_name}` : ''}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{c.reason}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </Reveal>
            )}

            {/* ── The month, then the day. Stacked and full width: the old 5fr/7fr split
                   put a half-empty calendar beside a panel reading "nothing booked", and neither
                   half had the room it wanted on a month that WAS busy. ── */}
            <div className="space-y-5">
              <Reveal>
                <MyMealCalendar
                  mealsByDate={mealsByDate}
                  monthKey={monthData?.key ?? ''}
                  loading={monthLoading}
                  year={year}
                  month={month}
                  selected={date}
                  today={today}
                  onSelect={selectDate}
                />
              </Reveal>
              <Reveal delay={0.05}>
                <MealDayPanel
                  date={date}
                  today={today}
                  loading={monthLoading}
                  rows={mealsByDate[date] ?? []}
                  changes={changes}
                  busyKey={busyKey}
                  onCancel={cancelToday}
                  onNotTaken={setNotTaken}
                  onRequestChange={setChangeTarget}
                  onSelectDate={selectDate}
                />
              </Reveal>
            </div>

            <Reveal>
              <MyChamaryBreakdown
                groups={byChamary}
                charges={charges}
                loading={monthLoading}
              />
            </Reveal>

            {isFoodAdmin && scopedChamaries.length > 0 && (
              <Reveal>
                <WhoIsEatingCard date={date} chamaries={scopedChamaries} />
              </Reveal>
            )}
          </>
        )}
      </div>

      <MealChangeDialog
        booking={changeTarget}
        chamaries={chamaries}
        actor={actor}
        onClose={() => setChangeTarget(null)}
        onDone={async () => { setChangeTarget(null); await load(true); }}
      />
    </PageTransition>
  );
}
