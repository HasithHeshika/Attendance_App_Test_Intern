'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  UtensilsCrossed, Loader2, CalendarDays, Check, CookingPot, ClipboardList, Receipt, CalendarOff,
  ChevronDown, AlertTriangle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { useT } from '@/store/appStore';
import { tenant } from '@/lib/firebase';
import { cn, localDateString } from '@/lib/utils';
import { buildChamaryMonth, dayKey, monthPrefix, type ChamaryMonthView } from '@/lib/chamaryMonth';
import { appMinutes, mealOf } from '@/lib/meals';
import { autoServeKey, planAutoServe } from '@/lib/mealAutoServe';
import { splitFoodCost, isMonthProvisional, colomboMonthWindow } from '@/lib/foodCost';
import type { ChamaryMealOffday, LunchRequest, MealChangeRequest } from '@/lib/types';
import { listAllChamaries, type ChamaryWithPlace } from '@/services/workingPlaceService';
import {
  getChamaryMealsMonthly, getChamaryOffdaysMonthly, clearMealOffdayRange,
  markMealsAutoServed, type Actor,
} from '@/services/mealService';
import {
  getPendingMealChanges, approveMealChange, rejectMealChange,
} from '@/services/mealChangeService';
import { getChamaryExpenses, formatSuspenseAmount } from '@/services/suspenseService';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { StatCard } from '@/components/ui/stat-card';
import { Progress } from '@/components/ui/progress';
import { StatCardsSkeleton } from '@/components/ui/Skeleton';
import { PageTransition, Reveal } from '@/components/ui/motion';
import MonthYearPicker from '@/components/MonthYearPicker';
import ChamaryCalendar from '@/components/chamary/ChamaryCalendar';
import ChamaryDayStrip from '@/components/chamary/ChamaryDayStrip';
import ChamaryDayPanel from '@/components/chamary/ChamaryDayPanel';
import ChamaryCostBlock from '@/components/chamary/ChamaryCostBlock';
import ChamaryChangeRequests from '@/components/chamary/ChamaryChangeRequests';
import ChamaryPeopleTable from '@/components/chamary/ChamaryPeopleTable';
import ChamaryClosures from '@/components/chamary/ChamaryClosures';
import CloseKitchenDialog from '@/components/chamary/CloseKitchenDialog';
import {
  breakdownText, closureRuns, prettyDateShort, servedMeals, type ClosureRun,
} from '@/components/chamary/chamaryFormat';

/** How much of the month failed to load. `null` is the normal case: everything answered. */
type MonthError = { kind: 'all' } | { kind: 'partial'; count: number } | null;

// A chamary's month, and one of its days in detail — the page behind the "Chamary" sidebar row.
//
// Two audiences, one screen: the person who RUNS a chamary (Chamary.responsible_epf, set in
// Working Places — not a capability) sees their own canteen(s); a food admin (system admin, or
// whoever approves suspense — the food deduction is theirs to answer for) sees every chamary and
// picks. The day list is MyChamaryLunchCard, the same manager the dashboard gives the
// responsible person, driven here with an explicit day and an explicit chamary set. This page
// only adds the month around it: the calendar, the counts, who ate, and the change requests.
export default function ChamaryPage() {
  const t    = useT();
  const user = useAuthStore(s => s.user);
  const caps = useUserCapabilities();
  const epf  = user?.epf_number ?? '';

  const now      = new Date();
  const thisYear = now.getFullYear();
  const thisMon  = now.getMonth() + 1;
  const today    = localDateString();

  const [all, setAll]           = useState<ChamaryWithPlace[]>([]);
  const [loading, setLoading]   = useState(true);
  const [year, setYear]         = useState(thisYear);
  const [month, setMonth]       = useState(thisMon);
  const [date, setDate]         = useState(today);
  const [pickedId, setPickedId] = useState('');   // '' = every chamary I can see
  const [search, setSearch]     = useState('');

  const [view, setView]                 = useState<ChamaryMonthView | null>(null);
  const [monthLoading, setMonthLoading] = useState(true);
  // The month's raw bookings, kept beside the view they built. The view is a reduction and does
  // not carry each booking's `multiplier`, which the cost split needs — so the rows are held
  // here, set in the same pass, and never read a second time.
  const [monthRows, setMonthRows]       = useState<LunchRequest[]>([]);
  // Bills filed against the one chamary in scope: the total, and how many there were. The count
  // is what tells "no bills filed yet" apart from "bills that came to nothing".
  const [bills, setBills]               = useState<{ total: number; count: number } | null>(null);
  // The month's raw off-day markers, kept per chamary. The month VIEW folds them into one
  // `day.off` per date across the whole scope, which is right for the calendar and wrong for
  // "reopen this closure" — that needs to know whose kitchen each marker belongs to. Same
  // fetch, no extra reads.
  const [offRows, setOffRows]     = useState<ChamaryMealOffday[]>([]);
  // Why the numbers on screen are not the whole truth, if they aren't. `all` means nothing loaded
  // and there is NO view to trust; `partial` means some kitchens answered and some did not.
  const [monthError, setMonthError] = useState<MonthError>(null);
  // Writes the auto-serve pass could not make. Kept in state rather than a toast because this is
  // exactly the failure that must outlive a four-second notification.
  const [autoServeFailed, setAutoServeFailed] = useState(0);
  const [closeOpen, setCloseOpen] = useState(false);
  // The month grid is the secondary view now. Off by default: the row of days answers the
  // question this page exists for, and the grid answers a different one.
  const [showGrid, setShowGrid] = useState(false);
  const [reopenBusy, setReopenBusy] = useState<string | null>(null);

  // Corrections employees have asked for on past meals (see mealChangeService). They land here
  // because the person who ran the kitchen that day is the only one who can say whether the meal
  // was really eaten — and the count feeds their chamary's deduction.
  const [changes, setChanges]       = useState<MealChangeRequest[]>([]);
  const [changeBusy, setChangeBusy] = useState<string | null>(null);

  // Whoever owns the food module sees every chamary, whether or not they run one.
  const isFoodAdmin = caps.is_system_admin || caps.can_approve_suspense;

  useEffect(() => {
    if (!tenant.features.suspense) { setLoading(false); return; }
    let cancelled = false;
    listAllChamaries()
      .then(list => { if (!cancelled) setAll(list); })
      .catch(() => { if (!cancelled) toast.error('Could not load the chamaries.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // What this person may manage. A responsible person is scoped to their own canteen(s) even if
  // they can see the page for another reason — the list they get is the list they answer for.
  const visible = useMemo(
    () => (isFoodAdmin ? all : all.filter(c => c.responsible_epf === epf)),
    [all, isFoodAdmin, epf],
  );
  const selected = useMemo(
    () => (pickedId ? visible.filter(c => c.id === pickedId) : visible),
    [visible, pickedId],
  );
  // Columns and pills follow what the scope actually serves — a lunch-only canteen must not
  // grow breakfast and dinner columns just because the model has three meals.
  const served = useMemo(() => servedMeals(selected), [selected]);

  const actor: Actor = { epf, name: user?.name ?? '' };

  // ── The month ──────────────────────────────────────────────────────────────
  // Identity of the scope, so the effect re-runs when WHICH chamaries changes and not on every
  // render's fresh array. `tick` is bumped for a silent re-read after a change lands (a name
  // added on the day panel, a change request decided) — no skeleton, the old numbers stay up
  // until the new ones arrive.
  const selectedKey = selected.map(c => c.id).join(',');
  const [tick, setTick] = useState(0);
  const silentRef = useRef(false);
  const refetchMonth = useCallback(() => { silentRef.current = true; setTick(n => n + 1); }, []);
  // The loud one, behind "Try again": the skeletons come back, so a retry looks like a retry.
  const retryMonth = useCallback(() => { silentRef.current = false; setTick(n => n + 1); }, []);

  // The scope's ordering windows, read inside the month effect (which keys off the id STRING, not
  // the array) so auto-serve can ask "is lunch over at this kitchen yet?" without the effect
  // gaining a dependency that re-runs it on every render.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Bumped when an auto-serve pass actually wrote something. The day panel's roster fetches its
  // own copy of the day, so it has to be told to read it again — see ChamaryDayPanel.
  const [autoServeStamp, setAutoServeStamp] = useState(0);

  useEffect(() => {
    if (!tenant.features.suspense || loading) return;
    const silent = silentRef.current;
    silentRef.current = false;
    if (!silent) setMonthLoading(true);
    let cancelled = false;
    const ids = selectedKey ? selectedKey.split(',') : [];
    (async () => {
      try {
        // Settled per chamary, not per collection. One kitchen's read failing used to reject the
        // whole Promise.all and land in the catch below, which then built a month of zeroes —
        // and a month of zeroes is indistinguishable from a month nobody booked. Whatever
        // answered is used; whatever didn't is named rather than counted as nothing.
        const results = await Promise.allSettled(ids.map(async (id) => {
          const [bookings, offdays] = await Promise.all([
            getChamaryMealsMonthly(id, year, month),
            getChamaryOffdaysMonthly(id, year, month),
          ]);
          return { id, bookings, offdays };
        }));
        if (cancelled) return;

        const okIds: string[] = [];
        const offRowsFlat: ChamaryMealOffday[] = [];
        let rows: LunchRequest[] = [];
        let failedReads = 0;
        for (const r of results) {
          if (r.status === 'fulfilled') {
            okIds.push(r.value.id);
            rows = rows.concat(r.value.bookings);
            offRowsFlat.push(...r.value.offdays);
          } else {
            failedReads += 1;
            console.warn('[chamary] month read failed', r.reason);
          }
        }

        // Nothing came back at all. Keep whatever was on screen and SAY so — never replace it
        // with a fabricated empty month, and never claim a sweep ran over rows we do not have.
        if (ids.length > 0 && okIds.length === 0) {
          setMonthError({ kind: 'all' });
          return;
        }
        setMonthError(failedReads > 0 ? { kind: 'partial', count: failedReads } : null);
        setOffRows(offRowsFlat);

        // ── Serve the meals that served themselves ─────────────────────────────
        // Everyone on a finished day's list is recorded as collected unless a person said
        // otherwise. Runs here, on the operator's own screen and over the chamaries they manage,
        // because that is the one place in the app that both sees a whole month of bookings and
        // has the standing to settle them. Re-running is free: planAutoServe skips anything
        // already served, and an explicit no-show is never a target.
        //
        // `chamaries: okIds` is the safety line for a partial read: a kitchen whose closure list
        // did not arrive is left alone, because an unread off-day looks exactly like no off-day
        // and settling on that guess records a meal that was never cooked.
        const slots = new Map(selectedRef.current.map(c => [c.id, c.slots]));
        const plan  = planAutoServe({
          bookings: rows, offdays: offRowsFlat,
          today: localDateString(), nowMinute: appMinutes(),
          slotsFor: id => slots.get(id),
          chamaries: okIds,
        });
        let failedWrites = 0;
        if (plan.targets.length > 0) {
          const done = await markMealsAutoServed(plan.targets);
          if (cancelled) return;
          failedWrites = done.failed.length;
          if (done.served.length > 0) {
            // Reflect the writes in the rows already in hand rather than re-reading the month.
            const flipped = new Set(done.served.map(autoServeKey));
            rows = rows.map(r => (flipped.has(autoServeKey({ ...r, meal: mealOf(r.meal) }))
              ? { ...r, served: true }
              : r));
            setAutoServeStamp(n => n + 1);
            toast.success(
              done.served.length === 1
                ? t.chamaryAutoServedOne
                : t.chamaryAutoServedMany.replace('{count}', String(done.served.length)),
            );
            // A month too large for one pass finishes itself. Only ever re-run after real
            // progress, so a run that writes nothing (denied, or every document gone) stops
            // instead of spinning.
            if (plan.deferred > 0) refetchMonth();
          }
          if (failedWrites > 0) {
            // One line for the whole run: the code is the diagnosis, the count is the size. A
            // per-document warn would bury it sixty times over.
            const byCode: Record<string, number> = {};
            for (const f of done.failed) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
            console.warn('[chamary] auto-serve could not write', byCode);
            toast.error(t.chamaryAutoServeFailed.replace('{count}', String(failedWrites)));
          }
        }
        // Cleared on every run that got as far as trying, so a retry that works stops nagging.
        setAutoServeFailed(failedWrites);

        // Set together, always. Two sources of truth for "which month is on screen" is exactly
        // the bug that crashed this page once already — see ChamaryCalendar.
        setMonthRows(rows);
        setView(buildChamaryMonth({
          bookings: rows, offdays: offRowsFlat, year, month, today: localDateString(),
        }));
      } catch (e) {
        if (cancelled) return;
        // Something outside the per-chamary reads broke. Same rule: say so, keep what was there,
        // do not invent a month.
        console.warn('[chamary] month load failed', e);
        setMonthError({ kind: 'all' });
      } finally {
        if (!cancelled) setMonthLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedKey, year, month, tick, loading, refetchMonth]);

  // Food bills for the month — only when ONE chamary is in scope, because a sum across canteens
  // is not a number anyone budgets by, and a share price across them is not a price.
  //
  // ANY STATUS BUT REJECTED, deliberately. A bill counts from the moment it is filed: the
  // kitchen has already spent that money, and waiting for approval would price a month's food
  // off a fraction of what it cost. A rejected bill is one somebody decided was not a cost, and
  // a deleted one stops counting on the next read — which is the whole reason nothing is stored.
  const singleId = selected.length === 1 ? selected[0].id : '';
  useEffect(() => {
    if (!tenant.features.suspense || !singleId) { setBills(null); return; }
    let cancelled = false;
    setBills(null);
    // Pinned to Asia/Colombo rather than the browser's own clock, and by the SAME function
    // /api/food/my-cost uses — otherwise this page and /food would bracket the month differently
    // and print two different share prices for one kitchen. See colomboMonthWindow.
    const { fromMs, toMs } = colomboMonthWindow(monthPrefix(year, month));
    getChamaryExpenses(singleId, fromMs, toMs, { status: 'any' })
      .then(list => {
        if (cancelled) return;
        setBills({
          total: list.reduce((sum, s) => sum + (Number(s.amount) || 0), 0),
          count: list.length,
        });
      })
      .catch(() => { if (!cancelled) setBills(null); });
    return () => { cancelled = true; };
  }, [singleId, year, month, tick]);

  // ── The month, divided ─────────────────────────────────────────────────────
  // Arithmetic on data already in hand, not another read: this page holds every booking in the
  // month and the bills for the chamary in scope. Nothing computed is stored, which is the whole
  // answer to "might delete a bill then recalculate" — a deleted bill is simply absent from the
  // next read and the figure is correct with no recalculation step at all. See foodCost.ts.
  const monthKey = monthPrefix(year, month);
  const costSplit = useMemo(() => {
    if (!singleId || !bills) return null;
    const bookings = monthRows
      .filter(r => r.chamary_id === singleId && String(r.date ?? '').startsWith(monthKey))
      .map(r => ({ epf: r.epf_number, multiplier: r.multiplier }));
    return splitFoodCost({ bookings, billsTotal: bills.total });
  }, [singleId, bills, monthRows, monthKey]);

  // ── Closures still ahead ───────────────────────────────────────────────────
  // Only the days from today on: a closure that has already happened is history, not something
  // to reopen. Bounded by the month on screen — a closure running into next month shows its
  // remaining days when that month is opened.
  const runs = useMemo(() => closureRuns(offRows, today), [offRows, today]);

  const reopen = async (run: ClosureRun) => {
    const key = `${run.chamaryId}:${run.from}:${run.to}`;
    setReopenBusy(key);
    try {
      await clearMealOffdayRange(run.chamaryId, run.from, run.to, run.meals);
      // Bookings cancelled by the closure are NOT restored — people re-book, which is what
      // clearMealOffday has always done for a single day.
      toast.success(`${run.chamaryName} is cooking again.`);
      refetchMonth();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reopen the kitchen.');
    } finally { setReopenBusy(null); }
  };

  // ── Change requests ────────────────────────────────────────────────────────
  const visibleKey = visible.map(c => c.id).join(',');
  const loadChanges = useCallback(async () => {
    if (!visibleKey) { setChanges([]); return; }
    setChanges(await getPendingMealChanges(visibleKey.split(',')).catch(() => []));
  }, [visibleKey]);
  useEffect(() => { void loadChanges(); }, [loadChanges]);

  const decideChange = async (req: MealChangeRequest, approve: boolean) => {
    setChangeBusy(req.id);
    try {
      if (approve) await approveMealChange(req, actor);
      else await rejectMealChange(req, actor);
      toast.success(approve ? 'Applied and the requester told.' : 'Turned down and the requester told.');
      await loadChanges();
      // An approved move or removal changes a day's count; the calendar should say so.
      if (approve) refetchMonth();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the request.');
    } finally { setChangeBusy(null); }
  };

  // ── Navigation ─────────────────────────────────────────────────────────────
  const isCurrentMonth = year === thisYear && month === thisMon;
  const showToday = date !== today || !isCurrentMonth;
  const goToday = () => { setYear(thisYear); setMonth(thisMon); setDate(today); };
  const changeMonth = (y: number, m: number) => {
    setYear(y); setMonth(m);
    // Landing on the current month should land on today; any other month opens on its 1st.
    setDate(y === thisYear && m === thisMon ? today : dayKey(y, m, 1));
  };
  const handleSelectDate = (newDate: string) => {
    setDate(newDate);
    const [y, m] = newDate.split('-').map(Number);
    if (y && m && (y !== year || m !== month)) {
      setYear(y);
      setMonth(m);
    }
  };

  // ── KPI figures ────────────────────────────────────────────────────────────
  const totals = view?.totals;
  // Nothing loaded, so there is nothing on this page that can be read as a fact about the month.
  const monthBroken = monthError?.kind === 'all';
  // The headline figures follow the day the panel is showing, not the month and not today.
  // A tile that silently means a different day than the list under it is worse than no tile:
  // whoever is marking collection reads the number and the names as one thing.
  const focusDay = view?.byDate[date] ?? null;
  const dayOff   = focusDay?.off ?? [];
  const dayCollectedPct = focusDay && focusDay.total > 0
    ? Math.round((focusDay.served / focusDay.total) * 100)
    : 0;
  // The month's own collection rate still exists — it lives in the summary at the foot of the
  // page, with the rest of the reporting.
  const collectedPct = totals && totals.meals > 0 ? Math.round((totals.served / totals.meals) * 100) : 0;

  if (!tenant.features.suspense) {
    return (
      <PageTransition>
        <EmptyState icon={UtensilsCrossed} title={t.noAccessTitle} description={t.noAccessSection} />
      </PageTransition>
    );
  }

  return (
    <PageTransition>
      <div className="space-y-5">
        <PageHeader
          icon={UtensilsCrossed}
          title={t.navManageChamary}
          description={t.chamaryPageDesc}
        />

        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={UtensilsCrossed}
            title={t.noChamariesYet}
            description={isFoodAdmin ? undefined : t.noAccessSection}
          />
        ) : (
          <>
            {/* Scope. Hidden when there is only one chamary — a choice with one option is a
                decision nobody has to make. */}
            {visible.length > 1 && (
              <Reveal>
                <div className="flex flex-wrap gap-2" role="group" aria-label={t.chamaryLabel}>
                  <ScopeChip pressed={pickedId === ''} onClick={() => setPickedId('')}>{t.allChamariesWord}</ScopeChip>
                  {visible.map(c => (
                    <ScopeChip key={c.id} pressed={pickedId === c.id} onClick={() => setPickedId(c.id)}>
                      <span>{c.name}</span>
                      {c.working_place_name && (
                        <span className={cn('ml-1 text-[11px] font-normal', pickedId === c.id ? 'opacity-80' : 'text-muted-foreground')}>
                          · {c.working_place_name}
                        </span>
                      )}
                    </ScopeChip>
                  ))}
                </div>
              </Reveal>
            )}

            {/* Needs you. A pending decision is an ACTION, so it leads — and it is absent
                entirely when there is nothing to decide. It used to be a count tile up here and
                the actual approve/reject list far below the fold, which meant reading a number
                and then hunting for the thing it counted. */}
            {changes.length > 0 && (
              <Reveal>
                <ChamaryChangeRequests changes={changes} busyId={changeBusy} onDecide={decideChange} />
              </Reveal>
            )}

            {/* The chosen day, in three numbers. Day-scoped and not month-scoped on purpose:
                standing in a canteen the questions are "how many today" and "how many still to
                collect". The month's totals are a report, and reports live in the summary at the
                bottom of the page. */}
            {/* A month that never arrived has no tiles. Not skeletons — those promise a figure
                that is not coming — and not the last month's numbers under today's date either.
                The strip under the month row says what happened. */}
            {monthBroken ? null : monthLoading || !view ? (
              <StatCardsSkeleton count={3} />
            ) : (
              <Reveal>
                <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
                  <StatCard
                    label={date === today ? t.chamaryTodayBookings : prettyDateShort(date)}
                    value={focusDay?.total ?? 0}
                    icon={UtensilsCrossed}
                    tone="brand"
                    hint={focusDay ? (breakdownText(focusDay.byMeal, served) || t.noBookingsDay) : undefined}
                  />
                  <StatCard
                    label={t.collectedWord}
                    value={`${focusDay?.served ?? 0}/${focusDay?.total ?? 0}`}
                    icon={Check}
                    tone="success"
                    trailing={(
                      <Progress
                        value={dayCollectedPct}
                        aria-label={`${t.collectedWord} ${dayCollectedPct}%`}
                        className="h-1.5"
                      />
                    )}
                  />
                  {/* Whether the kitchen is even cooking is a yes/no a number cannot carry, so
                      this tile says the words and only counts when there is something to count. */}
                  <StatCard
                    label={t.notCookingDaysLabel}
                    value={(
                      <span className="text-base sm:text-lg">
                        {dayOff.length > 0 ? t.chamaryNotCookingToday : t.chamaryKitchenOpen}
                      </span>
                    )}
                    icon={CookingPot}
                    tone={dayOff.length > 0 ? 'warning' : 'muted'}
                    hint={dayOff.length > 0 ? `${dayOff.length} ${t.mealsWord.toLowerCase()}` : undefined}
                    wrapLabel
                  />
                </div>
              </Reveal>
            )}

            {/* Month navigation. A scrollable row of days by default — one reach on a phone —
                and the 7-column grid on request, because "how did the month go" is a real
                question, just not the one someone asks mid-service. */}
            <Reveal>
              <div className="space-y-2">
                {/* Which month, and how to look at it — one row. The picker used to sit alone
                    in the page header, a screen away from the grid it navigates. */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {/* The picker's trigger is w-full by design; boxing it keeps the Today
                        button beside it instead of on the next line. */}
                    <div className="w-44">
                      <MonthYearPicker
                        year={year}
                        month={month}
                        years={[thisYear - 1, thisYear]}
                        onChange={changeMonth}
                      />
                    </div>
                    {showToday && (
                      <Button variant="outline" size="sm" onClick={goToday}>{t.todayWord}</Button>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setShowGrid(v => !v)}
                    aria-pressed={showGrid}
                  >
                    <CalendarDays className="h-4 w-4" aria-hidden />
                    {showGrid ? t.chamaryShowDayStrip : t.chamaryShowMonthGrid}
                  </Button>
                </div>
                {/* What did not work, kept on the page rather than in a toast. A month that
                    could not be read, a kitchen that did not answer, or writes that were
                    refused — each of those used to look exactly like a quiet month. */}
                {monthError && !monthLoading && (
                  <FailureStrip
                    text={monthError.kind === 'all'
                      ? t.chamaryMonthLoadFailed
                      : t.chamaryMonthPartial.replace('{count}', String(monthError.count))}
                    actionLabel={t.tryAgain}
                    onAction={retryMonth}
                  />
                )}
                {autoServeFailed > 0 && !monthLoading && (
                  <FailureStrip
                    text={t.chamaryAutoServeFailed.replace('{count}', String(autoServeFailed))}
                    actionLabel={t.tryAgain}
                    onAction={retryMonth}
                  />
                )}
                {showGrid ? (
                  <ChamaryCalendar
                    view={view}
                    loading={monthLoading}
                    served={served}
                    year={year}
                    month={month}
                    selected={date}
                    today={today}
                    onSelect={handleSelectDate}
                    failed={monthBroken}
                  />
                ) : (
                  <ChamaryDayStrip
                    view={view}
                    loading={monthLoading}
                    year={year}
                    month={month}
                    selected={date}
                    today={today}
                    onSelect={handleSelectDate}
                  />
                )}
              </div>
            </Reveal>

            {/* The page. Full width, first thing under the day you picked — this is the job. */}
            <Reveal delay={0.05}>
              <ChamaryDayPanel
                date={date}
                day={monthBroken ? null : (view?.byDate[date] ?? null)}
                served={served}
                loadingMonth={monthLoading}
                today={today}
                search={search}
                onSearch={setSearch}
                user={user}
                chamaries={selected}
                onChanged={refetchMonth}
                onSelectDate={handleSelectDate}
                rosterToken={autoServeStamp}
                monthUnknown={monthBroken}
              />
            </Reveal>

            {/* Everything that answers "how did the month go" rather than "what do I do now".
                Collapsed, because on most visits the answer is nobody asked. */}
            <Reveal>
              <details className="group rounded-xl border border-border bg-card/40">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3">
                  <span className="text-sm font-semibold text-foreground">{t.chamaryMonthSummary}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {totals ? `${totals.meals} ${t.mealsWord.toLowerCase()}` : ''}
                    <ChevronDown
                      className="h-4 w-4 transition-transform group-open:rotate-180"
                      aria-hidden
                    />
                  </span>
                </summary>

                <div className="space-y-5 border-t border-border px-4 py-4">
                  {monthBroken ? (
                    <p className="text-xs text-muted-foreground">{t.chamaryMonthLoadFailed}</p>
                  ) : monthLoading || !view || !totals ? (
                    <StatCardsSkeleton count={4} />
                  ) : (
                    <div className={cn(
                      'grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4',
                      bills && 'xl:grid-cols-5',
                    )}>
                      <StatCard
                        label={t.chamaryMonthMeals}
                        value={totals.meals}
                        icon={UtensilsCrossed}
                        tone="brand"
                        hint={breakdownText(totals.byMeal, served) || `${totals.activeDays} ${t.activeDaysLabel.toLowerCase()}`}
                      />
                      <StatCard
                        label={t.collectedWord}
                        value={`${totals.served}/${totals.meals}`}
                        icon={Check}
                        tone="success"
                        hint={`${totals.noShows} ${t.noShowsLabel.toLowerCase()}`}
                        trailing={<Progress value={collectedPct} aria-label={`${t.collectedWord} ${collectedPct}%`} className="h-1.5" />}
                      />
                      <StatCard
                        label={t.notCookingDaysLabel}
                        value={totals.offDays}
                        icon={CookingPot}
                        tone={totals.offDays > 0 ? 'warning' : 'muted'}
                        hint={totals.offMeals > 0 ? `${totals.offMeals} ${t.mealsWord.toLowerCase()}` : undefined}
                        wrapLabel
                      />
                      <StatCard
                        label={t.changeRequestsTitle}
                        value={changes.length}
                        icon={ClipboardList}
                        tone={changes.length > 0 ? 'warning' : 'muted'}
                        hint={changes.length > 0 ? t.changeRequestsPendingHint.replace('{count}', String(changes.length)) : undefined}
                      />
                      {bills && (
                        <StatCard
                          label={t.chamaryFoodBillsLabel}
                          value={<span className="text-base sm:text-lg">{formatSuspenseAmount(bills.total)}</span>}
                          icon={Receipt}
                          tone="muted"
                          hint={t.thisMonth}
                          wrapLabel
                        />
                      )}
                    </div>
                  )}

                  {/* The arithmetic behind the deduction, where the person who answers for it
                      can check it: bills in, shares out, price per share, what that charged, and
                      the rounding nobody was made to absorb. */}
                  {!monthBroken && !monthLoading && (
                    <ChamaryCostBlock
                      split={costSplit}
                      billsCount={bills?.count ?? 0}
                      provisional={isMonthProvisional(monthKey, today)}
                      oneChamary={!!singleId}
                    />
                  )}

                  {/* Nothing loaded, so nobody is listed — and no skeleton either, because the
                      table would otherwise sit there loading for a month that is not coming. The
                      line above says what happened. */}
                  {!monthBroken && (
                    <ChamaryPeopleTable view={view} loading={monthLoading} served={served} />
                  )}

                  {/* Closures, and the action that creates one, together — a rare admin job
                      does not belong beside month navigation in the header. */}
                  <div className="space-y-3">
                    <ChamaryClosures runs={runs} busyKey={reopenBusy} onReopen={reopen} />
                    <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setCloseOpen(true)}>
                      <CalendarOff className="h-4 w-4" aria-hidden />
                      {t.chamaryCloseKitchenAction}
                    </Button>
                  </div>
                </div>
              </details>
            </Reveal>

            <CloseKitchenDialog
              open={closeOpen}
              onOpenChange={setCloseOpen}
              chamaries={visible}
              preselectedId={pickedId}
              actor={actor}
              today={today}
              onDone={refetchMonth}
            />
          </>
        )}
      </div>
    </PageTransition>
  );
}

/**
 * A failure that stays put. Deliberately not a toast: the two things this reports — a month that
 * did not load, writes that were refused — are conditions, not events, and a notification that
 * clears itself after four seconds is how they went unnoticed for five days.
 *
 * Marked by an icon and a border, not by hue: --destructive is the only non-azure state colour in
 * this system and hue alone is never allowed to carry meaning here.
 */
function FailureStrip({ text, actionLabel, onAction }: { text: string; actionLabel: string; onAction: () => void }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-foreground"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
      <span className="font-medium">{text}</span>
      <Button variant="outline" size="sm" className="ml-auto h-7 px-2 text-[11px]" onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  );
}

function ScopeChip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-9 items-center rounded-full border px-3.5 py-1.5 text-xs transition-all shadow-xs',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        pressed
          ? 'border-primary bg-primary text-primary-foreground font-semibold shadow-sm'
          : 'border-border/80 bg-card text-foreground hover:bg-accent/80 hover:border-border',
      )}
    >
      {children}
    </button>
  );
}
