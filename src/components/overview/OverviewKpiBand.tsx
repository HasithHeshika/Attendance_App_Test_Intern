'use client';
// The Overview's KPI band.
//
// EVERY FIGURE HERE ANSWERS A QUESTION ABOUT A DIFFERENT PERIOD, and that used to be invisible.
// Nine identical tiles sat in one flat grid mixing the selected day, the displayed month and
// standing totals at equal weight, so "On Leave 0" could mean the day, the month or all time
// and nothing on screen said which. The band is now three labelled sections — the selected
// day, the displayed month, and figures tied to neither — and a tile's period is read off the
// heading above it instead of guessed from its wording.
//
// Two tiles were also simply wrong about their period, in all three languages: `presentTodayLabel`
// ("Present Today") sat above the SELECTED day's count, and the meals tile's hint was hardcoded
// to the word "Today". Page back a week and both still claimed today. Neither says "today" any
// more; the day heading names the date the page is actually showing.
//
// Two kinds of tile live here:
//
//   • Core tiles, computed by the page from reads it already makes (headcount, the day's
//     present/leave/missing, the month's attendance rate, attendance still waiting on an
//     approval decision). They cost nothing extra.
//   • Module tiles — open tasks, suspense float, meals booked on the day — each behind BOTH the
//     tenant's feature flag and the viewer's capability, and each read here, lazily, once per
//     (month, company, day) and cached.
//
// Every tile comes from a real read, and a figure nobody can stand behind is never printed as a
// zero. Four states are deliberately kept apart:
//
//   • a real zero      — printed as 0 with the words next to it ("All clear", "No bookings"),
//                        so it reads as a claim rather than an absence;
//   • no figure        — an em dash and a reason, when the input a tile needs is empty
//                        (an empty roster cannot produce a meaningful present/leave/missing);
//   • still loading    — a skeleton tile, so "not fetched yet" never looks like "nothing to report";
//   • a failed read    — the tile is REMOVED, because a wrong zero on a KPI band is worse than a
//                        missing tile: nobody questions it.
//
// One zero this component still cannot vouch for: `core.approvalsWaiting`. The page's `loadMonth`
// swallows its own errors and leaves the count at its initial 0, so a failed month read arrives
// here indistinguishable from a clean backlog. Fixing that means giving the page a null on
// failure the way it already does for the attendance rate — it cannot be fixed from inside here.
import { useEffect, useRef, useState, type ElementType } from 'react';
import {
  Users, UserCheck, CalendarDays, CalendarRange, Clock, TrendingUp, ClipboardCheck,
  ListChecks, Wallet, UtensilsCrossed,
} from 'lucide-react';
import { format } from 'date-fns';

import { useT } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { tenant } from '@/lib/firebase';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { Stagger, StaggerItem } from '@/components/ui/motion';
import { getTeamTasksForMonth } from '@/services/taskService';
import { listSuspenseAccounts, formatSuspenseAmount } from '@/services/suspenseService';
import { listAllChamaries } from '@/services/workingPlaceService';
import { getChamaryMealsForDay } from '@/services/mealService';

/** Everything the page already knows, handed over rather than re-read. */
export interface OverviewCore {
  /** Active users on this company filter, whether or not their role takes attendance. */
  activeTotal: number;
  /** Of those, the ones whose role has attendance — the denominator every day figure uses. */
  attendanceEligible: number;
  resignedThisMonth: number;
  present: number;
  onLeave: number;
  missing: number;
  /** Present ÷ expected across the month's elapsed working days, or null when nothing counts yet. */
  attendanceRatePct: number | null;
  ratedDays: number;
  /** Attendance dated before today still marked pending. null when the viewer may not see it. */
  approvalsWaiting: number | null;
  approvalsOldest: string | null;
}

interface Extra { openTasks?: number; float?: number; floatAccounts?: number; meals?: number }
type ModuleKey = 'tasks' | 'float' | 'meals';

// One cache per module tile, keyed by exactly the inputs that change its answer. 300+ users
// makes each of these a non-trivial read; paging back and forth through a month must not
// re-run them.
const taskCache = new Map<string, number>();
const floatCache = new Map<string, { total: number; accounts: number }>();
const mealCache = new Map<string, number>();

/** Names the period every tile beneath it belongs to. The whole point of the band's new shape:
 *  a reader should never have to infer a figure's scope from the figure's own wording. */
function ScopeHeading({ id, icon: Icon, scope, detail, note, badge }: {
  id: string;
  icon: ElementType;
  scope: string;
  detail?: string;
  note?: string;
  badge?: string;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5">
      <h2 id={id} className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {scope}
      </h2>
      {detail && <span className="text-[11px] font-semibold text-foreground">{detail}</span>}
      {badge && <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide">{badge}</Badge>}
      {note && <span className="text-[11px] italic text-muted-foreground">{note}</span>}
    </div>
  );
}

/** An em dash where a number would be, plus the reason a screen reader (and a hover) gets. The
 *  dash is the one thing a KPI band can say honestly when it has no figure — a 0 would be read
 *  as an answer. */
function NoFigure({ reason }: { reason: string }) {
  return (
    <span className="font-normal text-muted-foreground" title={reason}>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{reason}</span>
    </span>
  );
}

/** Placeholder for a module tile whose read is still in flight. Mirrors StatCard's padding and
 *  internal rhythm so the row does not resize when the real tile lands. */
function TileSkeleton({ label }: { label: string }) {
  return (
    <Card className="flex h-full flex-col p-3 sm:p-5" role="status" aria-label={label} aria-busy="true">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-2.5 w-14" />
        </div>
        <Skeleton className="h-8 w-8 shrink-0 rounded-lg sm:h-9 sm:w-9" />
      </div>
    </Card>
  );
}

/** The day's roster split three ways. Lives inside the day's hero tile rather than in three
 *  tiles of its own: they are three parts of ONE number (they sum to the roster), and as
 *  separate tiles they competed with figures from entirely different periods.
 *
 *  --success, --primary and --brand are the same azure here, so the bar carries proportion by
 *  LENGTH only and every part is named in words underneath. The unfilled remainder of the track
 *  is the missing count — absence of fill, not another colour. */
function DaySplit({ present, onLeave, missing, total, labels }: {
  present: number; onLeave: number; missing: number; total: number;
  labels: { present: string; leave: string; missing: string };
}) {
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  const cells = [
    { key: 'present', label: labels.present, value: present },
    { key: 'leave', label: labels.leave, value: onLeave },
    { key: 'missing', label: labels.missing, value: missing },
  ];
  return (
    <div className="space-y-2">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div className="bg-primary" style={{ width: `${pct(present)}%` }} />
        <div className="bg-primary/40" style={{ width: `${pct(onLeave)}%` }} />
      </div>
      {/* Same three-up definition list the attendance MonthSummary uses: gap-px over a bg-border
          parent draws the rules, and dt/dd are painted upside down with `order` so every figure
          sits on one line however far its label wraps. */}
      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border">
        {cells.map(c => (
          <div key={c.key} className="flex flex-col items-center gap-0.5 bg-muted/30 px-1 py-1.5">
            <dt className="order-2 text-center text-[10px] font-semibold uppercase leading-tight tracking-wide text-muted-foreground">
              {c.label}
            </dt>
            <dd className="order-1 text-sm font-semibold leading-none tabular-nums text-foreground">{c.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Column counts sized to a section's actual tile count, so a two-tile section never leaves a
 *  hole where a reader expects a third figure. */
const colsFor = (n: number) =>
  n >= 3 ? 'grid-cols-2 sm:grid-cols-3' : n === 2 ? 'grid-cols-2' : 'grid-cols-1';

export default function OverviewKpiBand({ core, month, date, company, refreshNonce }: {
  core: OverviewCore;
  month: Date;
  date: string;
  company: string;
  refreshNonce: number;
}) {
  const t = useT();
  const caps = useUserCapabilities();
  const viewerEpf = useAuthStore(s => s.user?.epf_number) ?? '';
  const f = tenant.features;
  const admin = caps.is_system_admin;

  const showTasks = f.tasks && (admin || caps.can_view_team_tasks);
  const showFloat = f.suspense && (admin || caps.can_approve_suspense);
  const showMeals = f.suspense && f.chamary && (admin || caps.can_approve_suspense);

  const [extra, setExtra] = useState<Extra>({});
  // A read that rejects removes its tile; without this flag an undefined value would be
  // indistinguishable from one still loading, and the tile would spin forever.
  const [failed, setFailed] = useState<Partial<Record<ModuleKey, true>>>({});
  const monthKey = format(month, 'yyyy-MM');
  const scope = `${monthKey}|${company}`;

  // The page's company filter is a company NAME ('all' for no filter). None of the three reads
  // below can filter on it server-side without an id, so each one narrows client-side on the
  // denormalized company_name every one of these documents already carries — otherwise a tile
  // would quietly report the whole group while the rest of the page reports one company.
  const inCompany = (name: string | undefined) => company === 'all' || name === company;

  // Refresh must be able to correct a stale tile, so it drops the caches on the way IN to the
  // load rather than in a second effect — a second effect would run after this one and wipe the
  // results it had just produced.
  const prevNonce = useRef(refreshNonce);

  useEffect(() => {
    let alive = true;
    if (refreshNonce !== prevNonce.current) {
      taskCache.clear(); floatCache.clear(); mealCache.clear();
      prevNonce.current = refreshNonce;
    }

    const taskKey = `${scope}|${viewerEpf}`;
    const mealKey = `${date}|${company}`;

    // Seed synchronously from the caches, then replace the state wholesale. Two things fall out
    // of doing it in one pass rather than per-job: paging back to a month already looked at does
    // not flash a skeleton, and — the correctness half — a value belonging to the PREVIOUS
    // company or day is dropped instead of sitting under the new heading as if it were current.
    const seed: Extra = {};
    if (showTasks && viewerEpf && taskCache.has(taskKey)) seed.openTasks = taskCache.get(taskKey);
    const floatHit = showFloat ? floatCache.get(company) : undefined;
    if (floatHit) { seed.float = floatHit.total; seed.floatAccounts = floatHit.accounts; }
    if (showMeals && mealCache.has(mealKey)) seed.meals = mealCache.get(mealKey);
    setExtra(seed);
    setFailed({});

    const fail = (key: ModuleKey) => { if (alive) setFailed(prev => ({ ...prev, [key]: true })); };

    if (showTasks && viewerEpf && seed.openTasks == null) {
      // companyWide with no companyId is the whole active roster — the same audience rule the
      // Tasks page's team board uses, so the number matches what an approver sees there.
      getTeamTasksForMonth({
        viewerEpf, year: Number(monthKey.slice(0, 4)), month: Number(monthKey.slice(5, 7)), companyWide: true,
      }).then(rows => {
        const open = rows.filter(r => r.status !== 'Completed' && inCompany(r.company_name)).length;
        taskCache.set(taskKey, open);
        if (alive) setExtra(e => ({ ...e, openTasks: open }));
      }).catch(() => fail('tasks'));
    }

    if (showFloat && seed.float == null) {
      listSuspenseAccounts().then(all => {
        const accounts = all.filter(a => a.is_active && !a.is_closed && inCompany(a.company_name));
        const value = { total: accounts.reduce((s, a) => s + (a.balance || 0), 0), accounts: accounts.length };
        floatCache.set(company, value);
        if (alive) setExtra(e => ({ ...e, float: value.total, floatAccounts: value.accounts }));
      }).catch(() => fail('float'));
    }

    if (showMeals && seed.meals == null) {
      // Chamaries belong to working places, not companies, so the company filter has to be
      // applied to the BOOKINGS (which carry company_name) rather than to the sites.
      (async () => {
        const chamaries = await listAllChamaries();
        const perChamary = await Promise.all(chamaries.map(c => getChamaryMealsForDay(c.id, date)));
        return perChamary.reduce((s, rows) => s + rows.filter(r => inCompany(r.company_name)).length, 0);
      })().then(total => {
        mealCache.set(mealKey, total);
        if (alive) setExtra(e => ({ ...e, meals: total }));
      }).catch(() => fail('meals'));
    }

    return () => { alive = false; };
    // `scope` already folds monthKey + company; inCompany is derived from company.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, date, company, viewerEpf, showTasks, showFloat, showMeals, monthKey, refreshNonce]);

  // 'hidden' also covers a failed read — the tile disappears rather than claiming a zero.
  const tileState = (enabled: boolean, key: ModuleKey, value: number | undefined) =>
    !enabled || failed[key] ? 'hidden' : value == null ? 'loading' : 'ready';

  const tasksState = tileState(showTasks && !!viewerEpf, 'tasks', extra.openTasks);
  const floatState = tileState(showFloat, 'float', extra.float);
  const mealsState = tileState(showMeals, 'meals', extra.meals);

  const dayDate = new Date(`${date}T00:00:00`);
  const dayLabel = format(dayDate, 'EEE, d MMM yyyy');
  const monthLabel = format(month, 'MMM yyyy');
  const isToday = date === format(new Date(), 'yyyy-MM-dd');
  // Paging the date picker moves the month without moving the selected day, so the two halves of
  // this band can legitimately be describing different months. Both headings name their own
  // period, which makes the mismatch visible; this note says out loud that it is a mismatch.
  const sameMonth = date.slice(0, 7) === monthKey;

  const eligible = core.attendanceEligible;
  const hasRoster = eligible > 0;
  // Nobody present and nobody on leave, on a day that has people to count: a rest day, a holiday,
  // or a day whose records have not arrived. Whichever it is, "Missing 149" is a false alarm and
  // must not be the only thing the tile says. The band deliberately does NOT guess which day of
  // the week rests — work patterns are a modelled concept this component has no business inventing.
  const noRecords = hasRoster && core.present === 0 && core.onLeave === 0;

  const dayTiles = 1 + (mealsState === 'hidden' ? 0 : 1);
  const monthTiles = 1 + (core.approvalsWaiting != null ? 1 : 0) + (tasksState === 'hidden' ? 0 : 1);
  const standingTiles = 1 + (floatState === 'hidden' ? 0 : 1);

  return (
    <div className="space-y-5">
      {/* ── The selected day ─────────────────────────────────────────────────────── */}
      <section aria-labelledby="ovk-scope-day">
        <ScopeHeading
          id="ovk-scope-day"
          icon={CalendarDays}
          scope={t.ovkScopeDay}
          detail={dayLabel}
          badge={isToday ? t.todayWord : undefined}
        />
        <Stagger className={cn('grid gap-3 sm:gap-4', dayTiles > 1 ? 'sm:grid-cols-3' : 'grid-cols-1')}>
          <StaggerItem className={dayTiles > 1 ? 'sm:col-span-2' : undefined}>
            <StatCard
              label={t.presentCap}
              value={
                hasRoster
                  ? (
                    <span className="tabular-nums text-3xl sm:text-4xl">
                      {core.present}
                      <span className="ml-1 text-base font-normal text-muted-foreground sm:text-lg">/ {eligible}</span>
                    </span>
                  )
                  : <NoFigure reason={t.ovkNoRoster} />
              }
              icon={UserCheck}
              tone={hasRoster ? 'primary' : 'muted'}
              wrapLabel
              hint={hasRoster ? (noRecords ? t.ovkNoRecords : undefined) : t.ovkNoRoster}
              trailing={hasRoster ? (
                <DaySplit
                  present={core.present}
                  onLeave={core.onLeave}
                  missing={core.missing}
                  total={eligible}
                  labels={{ present: t.presentCap, leave: t.onLeaveStat, missing: t.missingLabel }}
                />
              ) : undefined}
            />
          </StaggerItem>

          {mealsState === 'loading' && <StaggerItem><TileSkeleton label={`${t.mealsLabel} — ${t.loading}`} /></StaggerItem>}
          {mealsState === 'ready' && (
            <StaggerItem>
              <StatCard
                label={t.mealsLabel}
                value={extra.meals}
                icon={UtensilsCrossed}
                tone="muted"
                wrapLabel
                /* The heading above already names the day, so the hint is spent on the one thing
                   it cannot say: that a zero here is genuinely "none booked". */
                hint={extra.meals === 0 ? t.ovkNoBookings : undefined}
              />
            </StaggerItem>
          )}
        </Stagger>
      </section>

      {/* ── The displayed month ──────────────────────────────────────────────────── */}
      <section aria-labelledby="ovk-scope-month">
        <ScopeHeading
          id="ovk-scope-month"
          icon={CalendarRange}
          scope={t.thisMonth}
          detail={monthLabel}
          note={sameMonth ? undefined : t.ovkDifferentMonth}
        />
        <Stagger delay={0.1} className={cn('grid gap-3 sm:gap-4', colsFor(monthTiles))}>
          {/* The backlog leads the month row: an attendance session nobody approves stays pending
              forever, and this band is the only place it surfaces on this page. */}
          {core.approvalsWaiting != null && (
            <StaggerItem>
              <StatCard
                label={t.awaitingApproval}
                value={core.approvalsWaiting}
                icon={ClipboardCheck}
                tone="warning"
                wrapLabel
                hint={
                  core.approvalsWaiting === 0
                    ? `${t.allClear} · ${t.ovkBeforeToday}`
                    : core.approvalsOldest
                      ? `${t.ovkBeforeToday} · ${t.ovkOldest} ${format(new Date(`${core.approvalsOldest}T00:00:00`), 'd MMM')}`
                      : t.ovkBeforeToday
                }
              />
            </StaggerItem>
          )}

          <StaggerItem>
            <StatCard
              label={t.ovkAttendanceRate}
              value={
                core.attendanceRatePct != null
                  ? `${core.attendanceRatePct}%`
                  : <NoFigure reason={t.ovkNoFigureYet} />
              }
              icon={TrendingUp}
              tone={core.attendanceRatePct != null ? 'primary' : 'muted'}
              wrapLabel
              hint={`${core.ratedDays} ${t.ovkDaysCounted}`}
            />
          </StaggerItem>

          {tasksState === 'loading' && <StaggerItem><TileSkeleton label={`${t.openLabel} ${t.tasksWord.toLowerCase()} — ${t.loading}`} /></StaggerItem>}
          {tasksState === 'ready' && (
            <StaggerItem>
              <StatCard
                label={`${t.openLabel} ${t.tasksWord.toLowerCase()}`}
                value={extra.openTasks}
                icon={ListChecks}
                tone="warnStrong"
                wrapLabel
                hint={extra.openTasks === 0 ? t.allClear : undefined}
              />
            </StaggerItem>
          )}
        </Stagger>
      </section>

      {/* ── Neither the day nor the month ────────────────────────────────────────── */}
      <section aria-labelledby="ovk-scope-now">
        <ScopeHeading id="ovk-scope-now" icon={Clock} scope={t.ovkScopeNow} note={t.ovkScopeNowNote} />
        <Stagger delay={0.16} className={cn('grid gap-3 sm:gap-4', colsFor(standingTiles))}>
          <StaggerItem>
            <StatCard
              label={t.totalEmployees}
              value={core.activeTotal}
              icon={Users}
              tone="muted"
              wrapLabel
              /* The leaver count is the one month-scoped thing in this section, so it carries the
                 month's name rather than borrowing the heading's "right now". */
              hint={
                `${core.attendanceEligible} ${t.ovkTakeAttendance}` +
                (core.resignedThisMonth > 0
                  ? ` · ${core.resignedThisMonth} ${t.resignedLabel.toLowerCase()} · ${monthLabel}`
                  : '')
              }
            />
          </StaggerItem>

          {floatState === 'loading' && <StaggerItem><TileSkeleton label={`${t.ovkFloatOutstanding} — ${t.loading}`} /></StaggerItem>}
          {floatState === 'ready' && (
            <StaggerItem>
              <StatCard
                label={t.ovkFloatOutstanding}
                value={formatSuspenseAmount(extra.float!)}
                icon={Wallet}
                tone="brand"
                wrapLabel
                hint={extra.floatAccounts ? `${extra.floatAccounts} ${t.ovkOpenAccounts}` : t.ovkNoOpenAccounts}
              />
            </StaggerItem>
          )}
        </Stagger>
      </section>
    </div>
  );
}
