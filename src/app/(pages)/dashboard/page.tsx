'use client';
import { useEffect, useState, useCallback, useMemo, type ReactNode } from 'react';
import {
  Clock, CalendarDays, TrendingUp, AlertCircle,
  ArrowUp, ArrowDown, ArrowRight, Users, Loader2, ExternalLink, CalendarCheck
} from 'lucide-react';
import Link from 'next/link';
import { useAuthStore } from '@/store/authStore';
import { useLanyardStore } from '@/store/lanyardStore';
import { useUserCapabilities, useRoles } from '@/store/rolesStore';
import { useT, useAppStore } from '@/store/appStore';
import { useNavBadgesStore } from '@/store/navBadgesStore';
import { isTechnicianRole } from '@/lib/permissions';
import { _attendanceApi as attendanceApi, _leaveApi as leaveApi } from '@/services/apiCompat';
import TodayCheckInOut from '@/components/TodayCheckInOut';
import TodayTasksCard from '@/components/TodayTasksCard';
import MyChamaryLunchCard from '@/components/lunch/MyChamaryLunchCard';
import { getDueTasks, updateTask, propagateCompletion } from '@/services/taskService';
import { getMyAssignedTasks, updateAssignedTaskStatus } from '@/services/assignedTaskService';
import { toWorkItem, assignedTaskToWorkItem, type WorkItem } from '@/lib/workItem';
import type { DailyTask, AssignedTask, TaskStatus } from '@/lib/types';
import { formatTime, formatDate, localDateString } from '@/lib/utils';
import { readSnapshot, writeSnapshot } from '@/lib/snapshotCache';
import DayProgress from '@/components/ui/DayProgress';
import WorkingDaysViz from '@/components/ui/WorkingDaysViz';
import LeaveBalanceViz from '@/components/ui/LeaveBalanceViz';
import PendingViz from '@/components/ui/PendingViz';
import { DashboardSkeleton } from '@/components/ui/Skeleton';
import { CountUp } from '@/components/ui/CountUp';
import { StatCard, type Tone } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageTransition, Stagger, StaggerItem, Reveal, MotionCard } from '@/components/ui/motion';

// Live wall-clock for the dashboard hero — ticks every second so the app feels alive.
function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const p = (n: number) => String(n).padStart(2, '0');
  return <span className="font-mono tabular-nums">{p(now.getHours())}:{p(now.getMinutes())}:{p(now.getSeconds())}</span>;
}

interface TodayAttendance {
  check_in?:              string | null;
  check_out?:             string | null;
  check_in_approved_by?:  string | null;
  check_out_approved_by?: string | null;
  working_place?:         string | null;
  check_in_site_id?:      string | null;   // working-place doc id — feeds the lunch-chamary suggestion
}
interface LeaveSummary {
  leave_balance?:       number;
  accepted_leaves?:     number;
  rejected_leaves?:     number;
  pending_leaves?:      number;
  // The share of pending_leaves that will actually draw on an entitlement. Only this one may
  // feed the balance GAUGE; pending_leaves stays the "awaiting a decision" count for Card 4,
  // which a pending non-entitlement request belongs in just as much as any other.
  pending_leaves_quota?: number;
  // half / full breakdown (returned when backend supports it)
  pending_full_leaves?: number;
  pending_half_leaves?: number;
  balance_full_days?:   number;
  balance_half_days?:   number;
  // Derived (normalised in loadAttendanceData so it survives snapshot caching):
  used_days?:           number;  // sum of `used` across leave types this year
  total_days?:          number;  // sum of `total` (annual entitlement) across types
  by_type?:             { name: string; remaining: number }[];
  // Tracked-but-not-entitled types (LeaveType.excluded_from_quota): days TAKEN, never a balance.
  // Kept out of by_type so nothing that sums or gauges a remaining balance can reach them.
  taken_only?:          { name: string; taken: number }[];
}
type LeaveCheck = { can_mark_attendance: boolean; is_half_day?: boolean; half_day_period?: string | null };

// Everything the dashboard needs to render its hero + KPI row, cached per user so a
// cold open paints the last-known state instantly instead of a full skeleton.
interface DashSnapshot {
  attendance:   TodayAttendance | null;
  leaveSummary: LeaveSummary | null;
  workingDays:  number;
  monthDates:   string[];
  monthHours:   Record<string, number>;
  leaveCheck:   LeaveCheck | null;
  hasServicePlan?: boolean;
  servicePlanDate?: string | null;
  expectedWorkingDays?: number;
  thisWeekHoliday?: { name: string; date: string; day: string; daysUntil: number } | null;
  // Local date (YYYY-MM-DD) the snapshot was written — used to date-guard the cached
  // attendance so a NEW day never paints YESTERDAY's session before today's data loads.
  savedDate?: string;
}

// Local YYYY-MM-DD for "today" (matches how attendance dates are keyed).
function localDateStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// getLeaveSummary returns an ARRAY of per-type rows ({leave_type,total,used,remaining})
// WITH the dashboard totals attached as own props. JSON.stringify (snapshot caching)
// drops those non-index props, so flatten everything into a plain object once, here.
function normalizeLeaveSummary(raw: any): LeaveSummary {
  const rows: any[] = Array.isArray(raw) ? raw : [];
  const usedDays  = rows.reduce((s, x) => s + (Number(x.used)  || 0), 0);
  const totalDays = rows.reduce((s, x) => s + (Number(x.total) || 0), 0);
  const byType = rows
    .map(x => ({ name: String(x.leave_type ?? x.type ?? ''), remaining: Number(x.remaining ?? x.available ?? 0) }))
    .filter(x => x.name);
  const balance = Number(raw?.leave_balance ?? 0);
  // Tracked-but-not-entitled types ride alongside the rows as an attached prop, so they are
  // flattened here with everything else or the snapshot cache would drop them.
  const takenOnly = (Array.isArray(raw?.excluded_leave_types) ? raw.excluded_leave_types : [])
    .map((x: any) => ({ name: String(x?.leave_type ?? x?.type ?? ''), taken: Number(x?.taken) || 0 }))
    .filter((x: { name: string }) => x.name);
  return {
    leave_balance:       balance,
    pending_leaves:      Number(raw?.pending_leaves ?? 0),
    // Falls back to the all-in figure so a summary from before this field existed gauges
    // exactly as it used to.
    pending_leaves_quota: Number(raw?.pending_leaves_quota ?? raw?.pending_leaves ?? 0),
    taken_only:          takenOnly,
    accepted_leaves:     Number(raw?.accepted_leaves ?? 0),
    pending_full_leaves: Number(raw?.pending_full_leaves ?? 0),
    pending_half_leaves: Number(raw?.pending_half_leaves ?? 0),
    balance_full_days:   Number(raw?.balance_full_days ?? 0),
    balance_half_days:   Number(raw?.balance_half_days ?? 0),
    used_days:           usedDays,
    total_days:          totalDays || (balance + usedDays),
    by_type:             byType,
  };
}

export default function DashboardPage() {
  const { user } = useAuthStore();
  const caps = useUserCapabilities();
  const { roles } = useRoles();
  const t = useT();
  const lang = useAppStore(s => s.lang);
  const isTechnician = isTechnicianRole(user?.role, roles);
  // isExec = a self-recording approver (Technicians instead pick a supervisor on check-in)
  const isExec     = caps.can_approve;
  const isTrainee  = user?.employee_type?.toLowerCase().includes('trainee') ?? false;

  // Last-known snapshot — read once, synchronously, so the first render already has
  // real content (no skeleton) when we've shown this user the dashboard before.
  const snapKey = `dash:v1:${user?.epf_number ?? 'anon'}`;
  const [seed] = useState<DashSnapshot | null>(() => readSnapshot<DashSnapshot>(snapKey));

  // Trust the cached *attendance* (today's sessions) only when the snapshot is from today —
  // otherwise yesterday's session would flash on a new day until today's data arrives.
  const [attendance,    setAttendance]    = useState<TodayAttendance | null>(
    () => (seed && seed.savedDate === localDateStr() ? (seed.attendance ?? null) : null),
  );
  const [leaveSummary,  setLeaveSummary]  = useState<LeaveSummary | null>(seed?.leaveSummary ?? null);
  const [workingDays,   setWorkingDays]   = useState(seed?.workingDays ?? 0);
  const [monthDates,    setMonthDates]    = useState<string[]>(seed?.monthDates ?? []); // worked dates this month
  const [monthHours,    setMonthHours]    = useState<Record<string, number>>(seed?.monthHours ?? {}); // worked hours this month
  const [hasServicePlan, setHasServicePlan] = useState(seed?.hasServicePlan ?? false);
  const [servicePlanDate, setServicePlanDate] = useState<string | null>(seed?.servicePlanDate ?? null);
  // Expected working days this month (weekdays − public holidays) — for the "X / Y" progress hint.
  const [expectedWorkingDays, setExpectedWorkingDays] = useState(seed?.expectedWorkingDays ?? 0);
  // Last month's attendance totals — immutable once the month closes, so cached forever
  // per user/month (keeps the trend arrow cheap at scale). null until loaded.
  const [lastMonthStats, setLastMonthStats] = useState<{ workingDays: number; totalHours: number } | null>(null);
  const [thisWeekHoliday, setThisWeekHoliday] = useState<{ name: string; date: string; day: string; daysUntil: number } | null>(seed?.thisWeekHoliday ?? null);
  // Full skeleton only on a true cold open (no cached snapshot). Otherwise we show
  // the cached content and revalidate quietly via `refreshing`.
  const [loading,       setLoading]       = useState(!seed);
  const [refreshing,    setRefreshing]    = useState(false);

  // Let the post-login lanyard reveal retract once the dashboard's data is ready
  // (the reveal still honours its 4s minimum).
  useEffect(() => {
    if (!loading) useLanyardStore.getState().signalDashboardReady();
  }, [loading]);

  const [leaveCheck,    setLeaveCheck]    = useState<LeaveCheck | null>(seed?.leaveCheck ?? null);
  // Whether today's leave status has been freshly resolved. Until then we must NOT treat a
  // seeded/stale leaveCheck as "on leave" — that caused the check-in card to flash the leave
  // banner for a moment on load. The check-in/out card is the safe default while this is false.
  const [leaveReady,    setLeaveReady]    = useState(false);

  // Picked-technician count for the executive quick-actions card (live approvals subscription).
  const [pickedCount,       setPickedCount]       = useState(0);

  useEffect(() => {
    if (!user?.epf_number || !isExec) return;
    let unsub: (() => void) | undefined;
    attendanceApi.subscribeApprovals(user.epf_number, user?.company ?? '', ({ pick }: { pick: any[] }) => {
      const myPicked = (pick ?? []).filter((r: any) => String(r.picked_by) === String(user.epf_number));
      setPickedCount(myPicked.length);
    }).then(u => { unsub = u; });
    return () => { if (unsub) unsub(); };
  }, [user?.epf_number, user?.company, isExec]);

  const loadAttendanceData = useCallback(async () => {
    // Don't flip to the full skeleton on a revalidate — keep the cached content
    // visible and show only a subtle "refreshing" hint. `loading` is already true
    // (and stays true until the first load resolves) on a true cold open.
    setRefreshing(true);

    // Start every read in parallel, but gate the full-skeleton `loading` on ONLY the
    // today-attendance read (the hero/status). The aggregate calls — working days (~30 doc
    // reads) and leave summary (2 queries) — are far slower and must NOT hold the hero
    // hostage: each card fills itself in as its own read resolves. This is what made the
    // checked-in hero take ~7s instead of one round-trip.
    const attP   = attendanceApi.getMyTodayAttendance(user?.epf_number ?? '', user);
    const lsP    = leaveApi.getLeaveSummary(user?.epf_number ?? '');
    const wdP    = attendanceApi.getWorkingDays(user?.epf_number ?? '');
    const leaveP = leaveApi.checkIsTodayLeave(user?.epf_number ?? '');

    // Hero/status — reveal the instant the small today-attendance read returns.
    try {
      const attR = await attP;
      const outer = attR.data?.data ?? attR.data;
      setAttendance(outer?.today_attendance ?? outer);
    } catch { /* keep the cached/seed attendance */ }
    setLoading(false);

    // Secondary cards revalidate independently — they never block the hero.
    lsP.then(r => setLeaveSummary(normalizeLeaveSummary(r.data?.data ?? r.data))).catch(() => {});
    wdP.then(r => {
      const wd = r.data?.data ?? r.data;
      setWorkingDays(wd?.working_days ?? wd?.count ?? 0);
      setMonthDates(Array.isArray(wd?.attendance_dates) ? wd.attendance_dates : []);
      setMonthHours(wd?.dates_hours ?? {});
    }).catch(() => {});
    leaveP
      .then(r => {
        const ld = r?.data?.data ?? r?.data;
        setLeaveCheck({
          can_mark_attendance: ld?.can_mark_attendance ?? true,
          is_half_day:         ld?.is_half_day         ?? false,
          half_day_period:     ld?.half_day_period      ?? null,
        });
      })
      .catch(() => setLeaveCheck({ can_mark_attendance: true }))
      .finally(() => setLeaveReady(true));
    Promise.allSettled([lsP, wdP, leaveP]).then(() => setRefreshing(false));
    if (user?.epf_number) {
      fetch('/api/solar/service-plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epfNumber: user.epf_number }),
      })
        .then(res => res.json())
        .then(resData => {
          if (resData.success) {
            setHasServicePlan(!!resData.hasPlan);
            setServicePlanDate(resData.planDate ?? null);
          }
        })
        .catch(err => console.error('Failed to fetch service plans', err));
    }
    const holidayYear = new Date().getFullYear();
    fetch(`/api/holidays?year=${holidayYear}`)
      .then(res => res.json())
      .then(data => {
        const allHolidays: any[] = data.response?.holidays ?? [];
        const LKPublicHolidays = allHolidays.filter(h => h.primary_type === 'Public Holiday');

        const today = new Date();
        today.setHours(0,0,0,0);

        // Expected working days this month = weekdays − public holidays falling on a weekday.
        const yr = today.getFullYear(), mo = today.getMonth();
        const daysInMonth = new Date(yr, mo + 1, 0).getDate();
        const holidayDays = new Set(
          LKPublicHolidays.map(h => String(h.date?.iso ?? '').slice(0, 10)),
        );
        let expected = 0;
        for (let d = 1; d <= daysInMonth; d++) {
          const dt = new Date(yr, mo, d);
          const dow = dt.getDay();
          if (dow === 0 || dow === 6) continue; // weekend
          const ds = `${yr}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          if (holidayDays.has(ds)) continue;    // public holiday on a weekday
          expected++;
        }
        setExpectedWorkingDays(expected);

        const endRange = new Date(today);
        endRange.setDate(today.getDate() + 7);
        endRange.setHours(23,59,59,999);

        const upcomingHol = LKPublicHolidays.find(h => {
          const hDate = new Date(h.date.iso);
          return hDate >= today && hDate <= endRange;
        });

        if (upcomingHol) {
          const hDate = new Date(upcomingHol.date.iso);
          hDate.setHours(0,0,0,0);
          
          const diffDays = Math.round((hDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
          let dayLabel = '';
          if (diffDays === 0) {
            dayLabel = t.todayWord;
          } else if (diffDays === 1) {
            dayLabel = t.tomorrowWord;
          } else {
            dayLabel = hDate.toLocaleDateString(lang === 'si' ? 'si-LK' : lang === 'ta' ? 'ta-LK' : 'en-US', { weekday: 'long' });
          }

          setThisWeekHoliday({
            name: upcomingHol.name,
            date: upcomingHol.date.iso,
            day: dayLabel,
            daysUntil: diffDays,
          });
        } else {
          setThisWeekHoliday(null);
        }
      })
      .catch(err => console.error('Failed to load holidays', err));
    // (status reveal + leave/working-day cards now resolve independently above)
  }, [user, isExec]);

  // Persist the latest rendered data as the cold-open snapshot whenever it changes
  // (skipping the initial loading phase). Captures background refreshes AND the
  // optimistic check-in/out updates, so next launch paints the real state instantly.
  useEffect(() => {
    if (loading) return;
    writeSnapshot<DashSnapshot>(snapKey, { attendance, leaveSummary, workingDays, monthDates, monthHours, leaveCheck, hasServicePlan, servicePlanDate, expectedWorkingDays, thisWeekHoliday, savedDate: localDateStr() });
  }, [loading, snapKey, attendance, leaveSummary, workingDays, monthDates, monthHours, leaveCheck, hasServicePlan, servicePlanDate, expectedWorkingDays, thisWeekHoliday]);

  // Last month's attendance totals power the "vs last mo" trend arrow on the working-days
  // card. A closed month never changes → fetch once, then serve from localStorage forever
  // (keyed by user + month). Keeps the extra ~30 doc reads off the hot path at 300+ users.
  useEffect(() => {
    const epf = user?.epf_number;
    if (!epf) return;
    const now = new Date();
    const lm  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = lm.getFullYear(), m = lm.getMonth() + 1;
    const key = `dash:wd:${epf}:${y}-${String(m).padStart(2, '0')}`;
    const cached = readSnapshot<{ workingDays: number; totalHours: number }>(key);
    if (cached) { setLastMonthStats(cached); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await attendanceApi.getMonthlyAttendanceDates(epf, m, y);
        const d = res.data?.data ?? res.data;
        const hours = (d?.dates_hours ?? {}) as Record<string, number>;
        const totalHours = Object.values(hours).reduce((a, b) => a + b, 0);
        const workingDays = d?.working_days ?? (Array.isArray(d?.attendance_dates) ? d.attendance_dates.length : 0);
        const stats = { workingDays, totalHours };
        if (!cancelled) setLastMonthStats(stats);
        writeSnapshot(key, stats);
      } catch { /* trend is optional — silently skip */ }
    })();
    return () => { cancelled = true; };
  }, [user?.epf_number]);

  useEffect(() => { loadAttendanceData(); }, []);

  // Today's / overdue tasks — self-contained, cached widget (same pattern as
  // lastMonthStats above): seed from the last-known snapshot for an instant paint,
  // then revalidate from Firestore. Independent of the big DashSnapshot/loadAttendanceData
  // since it's an unrelated data source. Merges two collections — the personal daily
  // log (DailyTask) and shared multi-assignee tasks (AssignedTask, this viewer's own
  // row only) — via the shared WorkItem adapter so the widget renders/acts on both
  // the same way the Tasks page Board does.
  const dueTasksKey = `dash:tasks:v1:${user?.epf_number ?? 'anon'}`;
  const assignedDueKey = `dash:assigned:v1:${user?.epf_number ?? 'anon'}`;
  const [dueTasks, setDueTasks] = useState<DailyTask[]>(() => readSnapshot<DailyTask[]>(dueTasksKey) ?? []);
  const [assignedDue, setAssignedDue] = useState<AssignedTask[]>(() => readSnapshot<AssignedTask[]>(assignedDueKey) ?? []);
  const [dueTasksLoading, setDueTasksLoading] = useState(dueTasks.length === 0 && assignedDue.length === 0);
  useEffect(() => {
    const epf = user?.epf_number;
    if (!epf || !caps.has_tasks) { setDueTasksLoading(false); return; }
    let cancelled = false;
    Promise.all([getDueTasks(epf), getMyAssignedTasks(epf)])
      .then(([daily, assigned]) => {
        if (cancelled) return;
        setDueTasks(daily); writeSnapshot(dueTasksKey, daily);
        setAssignedDue(assigned); writeSnapshot(assignedDueKey, assigned);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setDueTasksLoading(false); });
    return () => { cancelled = true; };
  }, [user?.epf_number, caps.has_tasks, dueTasksKey, assignedDueKey]);

  // Completed items drop off the widget immediately regardless of source — "due"
  // means "still on my plate". An AssignedTask is one shared status for the whole
  // task now (not per-assignee), so it maps to exactly one WorkItem.
  const dueWorkItems = useMemo(() => {
    return [
      ...dueTasks.map(toWorkItem),
      ...assignedDue.map(assignedTaskToWorkItem),
    ]
      .filter(item => item.status !== 'Completed')
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [dueTasks, assignedDue]);

  // Explicit status change from the widget — dispatches to whichever service backs the
  // item. Mirrors the Tasks page's status-change pairs. An assigned task is written with
  // the actor (that is what stamps started_at / ended_at and the trail) and the note the
  // widget's prompt collected; a failure there is rethrown so the widget can say so.
  const handleTaskStatusChange = async (item: WorkItem, next: TaskStatus, note?: string) => {
    if (next === item.status) return;
    if (item.kind === 'daily') {
      const t = dueTasks.find(x => x.id === item.id);
      if (!t || (t.completed_on && t.completed_on !== t.date)) return; // finished on another day — locked
      const completedOn = next === 'Completed' ? t.date : null;
      setDueTasks(prev => prev.map(x => x.id === t.id ? { ...x, status: next, completed_on: completedOn } : x));
      try {
        await updateTask(t.id, { status: next, completed_on: completedOn });
        await propagateCompletion(t, completedOn);
      } catch {
        const epf = user?.epf_number;
        if (epf) getDueTasks(epf).then(setDueTasks).catch(() => {});
      }
    } else {
      const a = assignedDue.find(x => x.id === item.id);
      if (!a) return;
      const completedOn = next === 'Completed' ? a.date : null;
      setAssignedDue(prev => prev.map(x => x.id !== a.id ? x : { ...x, status: next, completed_on: completedOn }));
      const epf = user?.epf_number;
      try {
        if (!epf) throw new Error('not signed in');
        await updateAssignedTaskStatus(a.id, next, a.date, { actor: { epf, name: user?.name || epf }, note });
        // Re-read so the card shows the clock the service just stamped.
        getMyAssignedTasks(epf).then(setAssignedDue).catch(() => {});
      } catch (e) {
        if (epf) getMyAssignedTasks(epf).then(setAssignedDue).catch(() => {});
        throw e;
      }
    }
  };

  // Session-aware: the open session (checked in, not out) drives the current state.
  const sessions: any[] = (attendance as any)?.sessions ?? [];
  const openSession = sessions.find((s: any) => s.check_in && !s.check_out) ?? null;
  const lastSession = sessions.length ? sessions[sessions.length - 1] : null;
  const isCheckedIn  = !!openSession;
  const canStartSession = !openSession && (caps.multi_session || sessions.length === 0);
  const isCheckedOut = !openSession && !canStartSession && !!lastSession?.check_out;

  const [liveNow, setLiveNow] = useState(() => Date.now());
  useEffect(() => {
    const hasLive = sessions.some((s: any) => s.check_in && !s.check_out);
    if (!hasLive) return;
    const id = setInterval(() => setLiveNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [sessions]);

  // Today's worked hours for the MONTH aggregate (week strip / total / avg / trend). Always
  // measured check_in→check_out so today shares one basis with every other day (getMonthly-
  // AttendanceDates also uses check_in) and with last month — otherwise the avg/day trend
  // would mix picked_at and check_in units. The live card-1 meter does its own elapsed calc.
  const todayHours = useMemo(() => {
    if (!sessions || sessions.length === 0) return 0;
    let elapsedMs = 0;
    for (const s of sessions) {
      if (!s.check_in) continue;
      const start = s.check_in.toDate
        ? s.check_in.toDate().getTime()
        : (typeof s.check_in === 'string' ? new Date(s.check_in.replace(' ', 'T')).getTime() : new Date(s.check_in).getTime());
      if (Number.isNaN(start)) continue;

      let end = liveNow;
      if (s.check_out) {
        end = s.check_out.toDate
          ? s.check_out.toDate().getTime()
          : (typeof s.check_out === 'string' ? new Date(s.check_out.replace(' ', 'T')).getTime() : new Date(s.check_out).getTime());
      }
      elapsedMs += Math.max(0, end - start);
    }
    return Number((elapsedMs / (1000 * 60 * 60)).toFixed(1));
  }, [sessions, liveNow]);

  const mergedMonthHours = useMemo(() => {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
    const copy = { ...monthHours };
    if (todayHours > 0) {
      copy[todayStr] = todayHours;
    }
    return copy;
  }, [monthHours, todayHours]);
  const isLeaveDay  = leaveCheck?.can_mark_attendance === false;
  // Display flags still needed by the hero status pill + the "today" stat card.
  const isShiftDay      = !!(attendance as any)?.is_shift_day;   // today is within a roster period
  const isOvernightOpen = !!openSession?.is_overnight;

  // ── Micro-graph data ────────────────────────────────────────────────────────
  const workedSet = useMemo(() => new Set(monthDates), [monthDates]); // worked dates this month
  const hasPending  = (leaveSummary?.pending_leaves ?? 0) > 0;

  // ── Leave waiting on MY decision ────────────────────────────────────────────
  // A different fact from `pending_leaves` above. That is the viewer's OWN leave waiting on
  // somebody else; this is somebody else's leave waiting on the viewer. One person routinely
  // holds both at once, so the two are never added together and never share a number.
  //
  // The count is READ out of navBadgesStore, not fetched. The app shell already mounts
  // useNavBadges on every page inside (pages) (see useSidebarNav.ts), so by the time this
  // paints the number is loaded, capability-gated and TTL-cached — subscribing costs zero
  // Firestore reads. Reading is also the only safe move: load() caches its result globally for
  // two minutes, so calling it from here with a narrower context than the sidebar's would
  // poison every other badge. And sharing the store means this card and the sidebar can never
  // quote two different numbers for the same queue, which is the disagreement that file's own
  // comments were written to prevent.
  const canApproveLeaves   = caps.can_approve_leaves;
  const leaveQueueCount    = useNavBadgesStore(s => s.counts.leaves);
  const leaveQueueLoadedAt = useNavBadgesStore(s => s.loadedAt);
  // Someone who cannot approve leave has no queue at all — the store never even runs the
  // query for them, so a raw count would be a meaningless zero rather than an answer.
  const leaveQueueWaiting  = canApproveLeaves ? leaveQueueCount : 0;
  // "Not counted yet" and "counted, and empty" are different states and only one of them is
  // good news. Until the store has resolved once, an approver's queue is UNKNOWN.
  const leaveQueueCounted  = canApproveLeaves && leaveQueueLoadedAt > 0;
  const leaveQueueLabel    = (t.dshWaitingOnYou ?? '{n} waiting on your decision').replace('{n}', String(leaveQueueWaiting));
  const pendingFull = leaveSummary?.pending_full_leaves ?? 0;
  const pendingHalf = leaveSummary?.pending_half_leaves ?? 0;
  const leaveUsed   = leaveSummary?.used_days ?? 0;          // approved leave DAYS used this year
  const leaveLeft   = leaveSummary?.leave_balance ?? 0;      // remaining balance (days)
  // The GAUGE's pending segment: quota-drawing days only. A pending day on a type that carries
  // no entitlement would otherwise eat a free segment it can never consume, shrinking a balance
  // that was never at risk. Card 4 below deliberately still counts every pending day.
  const leavePendingDays = leaveSummary?.pending_leaves_quota ?? leaveSummary?.pending_leaves ?? 0;
  const leaveByType = useMemo(() => leaveSummary?.by_type ?? [], [leaveSummary]);
  const leaveTakenOnly = useMemo(() => leaveSummary?.taken_only ?? [], [leaveSummary]);
  const todayColor  = isCheckedOut ? 'text-success' : 'text-primary';

  // Leave fuel-gauge: azure (plenty) → amber → orange → red as the balance depletes.
  // Denominator matches what UsageMeter renders (used + remaining) so the colour escalation
  // always lines up with the visible free segment, even if a type is over-used.
  const leavePct = (leaveUsed + leaveLeft) > 0 ? leaveLeft / (leaveUsed + leaveLeft) : 1;
  const leaveToneInfo =
    leavePct >= 0.5  ? { tone: 'brand'       as const, text: 'text-brand' } :
    leavePct >= 0.3  ? { tone: 'warning'     as const, text: 'text-warning' } :
    leavePct >= 0.12 ? { tone: 'warnStrong'  as const, text: 'text-warn-strong' } :
                       { tone: 'destructive' as const, text: 'text-destructive' };

  // Working-days progress hint: worked / expected this month (· %). Falls back to the
  // plain "This month" label until the holiday-derived expected count is available.
  const wdHint = expectedWorkingDays > 0
    ? `${workingDays} / ${expectedWorkingDays} · ${Math.round((workingDays / expectedWorkingDays) * 100)}%`
    : t.thisMonth;

  // Working-days trend: average hours/day this month vs last (fair mid-month, unlike a
  // running day count). Only rendered once last month's cached totals are loaded.
  const thisMonthHoursTotal = useMemo(
    () => Object.values(mergedMonthHours).reduce((a, b) => a + b, 0),
    [mergedMonthHours],
  );
  const thisMonthDayCount = useMemo(
    () => Object.keys(mergedMonthHours).filter(k => mergedMonthHours[k] > 0).length,
    [mergedMonthHours],
  );
  const thisMonthAvg = thisMonthDayCount > 0 ? thisMonthHoursTotal / thisMonthDayCount : 0;
  const lastMonthAvg = lastMonthStats && lastMonthStats.workingDays > 0
    ? lastMonthStats.totalHours / lastMonthStats.workingDays
    : null;
  const avgDelta = lastMonthAvg != null ? thisMonthAvg - lastMonthAvg : null;
  const showTrend = avgDelta != null && thisMonthAvg > 0 && Math.abs(avgDelta) >= 0.1;
  const workingDaysTrend = showTrend && avgDelta != null ? (
    <span
      title={`${avgDelta >= 0 ? '+' : ''}${avgDelta.toFixed(1)}${t.hShort} ${t.vsLastMonth}`}
      aria-label={`${avgDelta >= 0 ? '+' : ''}${avgDelta.toFixed(1)}${t.hShort} ${t.vsLastMonth}`}
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
        avgDelta > 0 ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'
      }`}
    >
      {avgDelta > 0 ? <ArrowUp className="h-2.5 w-2.5" /> : <ArrowDown className="h-2.5 w-2.5" />}
      {Math.abs(avgDelta).toFixed(1)}{t.hShort}
    </span>
  ) : null;

  // "All clear" is a promise, so it has to cover everything this viewer could be on the hook
  // for. With nothing of their own pending that is true for a non-approver immediately, but for
  // an approver only once the queue waiting on their decision has actually been counted AND
  // come back empty. Every other case gets the narrower, strictly true line — this card speaks
  // only for the viewer's own leave, and the banner above carries the other fact with its own
  // number. An unknown queue therefore reads as "none of your own", never as all clear.
  const pendingLeavesHint = hasPending
    ? t.awaitingApproval
    : (!canApproveLeaves || (leaveQueueCounted && leaveQueueWaiting === 0))
      ? t.allClear
      : t.dshNoneOfYourOwn;

  const stats = [
    {
      // Card 1 — today: how far through your working day are you (live elapsed vs a standard shift).
      title: t.todayStatus,
      value: isCheckedOut ? t.completed : isCheckedIn ? t.checkedIn : t.notCheckedIn,
      // Include the shift/start date so overnight shifts (which span days) are unambiguous.
      sub: isCheckedIn
        ? `${t.since} ${formatTime(attendance?.check_in ?? '')}${isOvernightOpen || isShiftDay ? ` · ${formatDate(attendance?.check_in ?? '')}` : ''}`
        : t.markAttendance,
      icon: Clock,
      tone: (isCheckedOut ? 'success' : 'primary') as Tone,
      trend: undefined as ReactNode,
      href: '/attendance',
      viz: (
        <DayProgress
          sessions={sessions}
          className={todayColor}
          hShort={t.hShort}
          mShort={t.mShort}
          showTarget={isExec}
        />
      ),
    },
    {
      // Card 2 — working days this month: count + worked/expected progress + hours trend.
      title: t.workingDays,
      value: <CountUp value={workingDays} />,
      sub:   wdHint,
      icon:  TrendingUp,
      tone: 'primary' as Tone,
      trend: workingDaysTrend,
      href:  '/attendance',
      viz: <WorkingDaysViz workedDates={workedSet} workedHours={mergedMonthHours} usesShift={isExec} />,
    },
    {
      // Card 3 — leave balance: a fuel gauge (taken / pending / free) that escalates
      // azure → amber → orange → red as the balance depletes, plus a per-type breakdown.
      title: t.leaveBalance,
      value: <CountUp value={leaveLeft} decimals={1} suffix={` ${t.daysUnit}`} />,
      sub:   t.availableLeaves,
      icon:  CalendarDays,
      tone:  leaveToneInfo.tone as Tone,
      trend: undefined as ReactNode,
      href:  '/leaves',
      viz: (
        <LeaveBalanceViz
          used={leaveUsed}
          pending={leavePendingDays}
          remaining={leaveLeft}
          toneClass={leaveToneInfo.text}
          byType={leaveByType}
          takenOnly={leaveTakenOnly}
        />
      ),
    },
    {
      // Card 4 — pending: zero is the GOOD state → "all clear" / holiday countdown, not an empty ring.
      title: t.pendingLeaves,
      value: <CountUp value={leaveSummary?.pending_leaves ?? 0} />,
      sub:   pendingLeavesHint,
      icon:  AlertCircle,
      // Amber is reserved for a genuine "awaiting action" state — only when something is actually pending.
      tone: (hasPending ? 'warning' : 'success') as Tone,
      trend: undefined as ReactNode,
      href:  '/leaves',
      viz: (
        <PendingViz
          hasPending={hasPending}
          pendingFull={pendingFull}
          pendingHalf={pendingHalf}
          holiday={thisWeekHoliday}
          usedDays={leaveUsed}
        />
      ),
    },
  ];

  const greeting = new Date().getHours() < 12 ? 'Morning' : new Date().getHours() < 17 ? 'Afternoon' : 'Evening';

  if (loading) return <DashboardSkeleton />;

  return (
    <PageTransition className="space-y-4 sm:space-y-6">
      {/* Hero — greeting, live clock, and the one-glance "where am I in my day" status */}
      <Reveal>
        <div className="relative isolate overflow-hidden rounded-2xl glass-strong px-4 py-4 shadow-soft sm:px-6 sm:py-6">
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-br from-primary/10 via-transparent to-brand/10" />
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
                <CalendarDays className="h-3.5 w-3.5 flex-shrink-0" />
                <span>{formatDate(localDateString())}</span>
                <span className="text-muted-foreground/40">·</span>
                <Clock className="h-3.5 w-3.5 flex-shrink-0" />
                <LiveClock />
                {/* Quiet revalidation hint — shown only when refreshing cached content (not on cold skeleton). */}
                {refreshing && !loading && (
                  <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground/70" aria-label={t.loading} />
                )}
              </div>
              <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-foreground sm:text-3xl">
                {t.good} {t[`good${greeting}` as keyof typeof t] ?? greeting},{' '}
                <span className="text-primary">{user?.name ? user.name.split(' ').at(-1) : ''}</span>
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {user?.designation ?? user?.role}{user?.company ? ` · ${user.company}` : ''}
              </p>
            </div>

            {(() => {
              const s = isLeaveDay
                ? { label: t.onLeave,        cls: 'bg-brand/10 text-brand border-brand/20',           dot: 'bg-brand',            pulse: false }
                : isCheckedOut
                ? { label: t.dayComplete,    cls: 'bg-success/10 text-success border-success/20',     dot: 'bg-success',          pulse: false }
                : isCheckedIn
                ? { label: t.checkedIn,      cls: 'bg-primary/10 text-primary border-primary/20',     dot: 'bg-primary',          pulse: true }
                : { label: t.notCheckedIn,   cls: 'bg-muted text-muted-foreground border-border',     dot: 'bg-muted-foreground', pulse: false };
              return (
                <div className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${s.cls}`}>
                  <span className="relative flex h-2 w-2">
                    {s.pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${s.dot}`} />}
                    <span className={`relative inline-flex h-2 w-2 rounded-full ${s.dot}`} />
                  </span>
                  {s.label}
                </div>
              );
            })()}
          </div>
        </div>
      </Reveal>

      {/* Leave requests waiting on THIS viewer's decision.
          It sits above everything else on purpose. The count exists elsewhere only as a digit
          on the sidebar's /leaves row, which is hidden behind the drawer on a phone and is
          ambiguous anyway (that row also covers the viewer's own leave) — and an approval queue
          nobody can see stays pending forever, which has already happened in this app.

          Its own row, its own number, its own link: it is a different fact from the Pending
          Leaves card below, which counts the viewer's own requests. Nothing is added together.

          Three states. Something waiting: this row. Counted and empty: no row, and the Pending
          Leaves card is free to say "All clear". Not counted yet (or a read that failed, which
          navBadgesStore reports as 0): also no row — so that card holds back "All clear" until
          the count is in, and says "none of your own" instead of speaking for a queue it has
          not heard from. */}
      {leaveQueueWaiting > 0 && (
        <Reveal>
          <div className="relative overflow-hidden rounded-xl border border-warning/25 bg-warning/5 p-3 sm:p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning">
                <CalendarCheck className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h4 className="text-sm font-semibold text-foreground flex flex-wrap items-center gap-2">
                  <span>{t.dshLeaveApprovalsTitle}</span>
                  {/* Amber is the one tone here that is genuinely not the same azure as
                      --primary/--success, but it still is not allowed to be the thing that
                      says "act on this". The heading says it in words, the filled chip says it
                      in weight and shape, and the number says how much. Capped at 99+ so a
                      long queue cannot push the button off a narrow screen. */}
                  <span
                    className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-warning px-1.5 text-[11px] font-bold tabular-nums text-warning-foreground"
                    title={leaveQueueLabel}
                    aria-label={leaveQueueLabel}
                  >
                    {leaveQueueWaiting > 99 ? '99+' : leaveQueueWaiting}
                  </span>
                </h4>
                <p className="text-xs text-muted-foreground mt-0.5">{t.dshLeaveApprovalsDesc}</p>
              </div>
            </div>
            {/* Straight to the Team Requests tab — /leaves alone would land an approver on
                their own requests, which are exactly the ones that are not the problem. */}
            <Link
              href="/leaves?tab=team"
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-warning px-3 py-1.5 text-xs font-semibold text-warning-foreground shadow transition-colors hover:bg-warning/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span>{t.dshReviewRequests}</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </Reveal>
      )}

      {servicePlanDate && (() => {
        const pad2 = (n: number) => String(n).padStart(2, '0');
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;

        const tomorrow = new Date();
        tomorrow.setDate(today.getDate() + 1);
        const tomorrowStr = `${tomorrow.getFullYear()}-${pad2(tomorrow.getMonth() + 1)}-${pad2(tomorrow.getDate())}`;

        const isToday = servicePlanDate === todayStr;
        const isTomorrow = servicePlanDate === tomorrowStr;

        const dateLabel = isToday
          ? t.todayWord
          : isTomorrow
          ? t.tomorrowWord
          : new Date(servicePlanDate).toLocaleDateString(
              lang === 'si' ? 'si-LK' : lang === 'ta' ? 'ta-LK' : 'en-US',
              { weekday: 'long', month: 'short', day: 'numeric' }
            );

        const displayDescDate = isToday 
          ? t.todayWord.toLowerCase() 
          : isTomorrow 
          ? t.tomorrowWord.toLowerCase() 
          : dateLabel;

        const titleText = (t.servicePlanScheduled ?? 'Service Plan Scheduled for {date}').replace('{date}', dateLabel);
        const descText = (t.servicePlanDesc ?? 'You are assigned to a service plan route for {date}.').replace('{date}', displayDescDate);
        const btnText = t.viewPlan ?? 'View Plan';

        return (
          <Reveal>
            <div className="relative overflow-hidden rounded-xl border border-primary/20 bg-primary/5 p-3 sm:p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <CalendarDays className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h4 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                    {titleText}
                  </h4>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[280px] sm:max-w-none">
                    {descText}
                  </p>
                </div>
              </div>
              <a
                href="https://solar.altavision.lk/services"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow hover:bg-primary/90 transition-all ml-auto"
              >
                <span>{btnText}</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </Reveal>
        );
      })()}



      {/* Today's Attendance — shared check-in / check-out card (also used on /attendance).
          Its own checked-in row now embeds the "Need lunch today?" prompt. */}
      <TodayCheckInOut attendance={attendance} loading={loading} leaveCheck={leaveReady ? leaveCheck : null} onMutated={loadAttendanceData} />

      {/* Chamary responsible-person's daily list (Alta Vision only) — self-gates and renders
          nothing when not applicable, so it's safe to always mount. */}
      <MyChamaryLunchCard user={user} />

      {/* Quick Stats */}
      <Stagger className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {stats.map((s) => (
          <StaggerItem key={s.title} className="h-full">
            <MotionCard className="h-full rounded-xl">
              <Link href={s.href} className="block h-full rounded-xl outline-none focus:outline-none focus-visible:ring-2 focus-visible:ring-primary transition-shadow">
                <StatCard
                  className="h-full"
                  label={s.title}
                  value={s.value}
                  hint={s.sub}
                  icon={s.icon}
                  tone={s.tone}
                  trend={s.trend}
                  trailing={s.viz}
                />
              </Link>
            </MotionCard>
          </StaggerItem>
        ))}
      </Stagger>

      {/* Today's / overdue tasks — only when there ARE any. An empty task card is a permanent
          "nothing to do here" holding prime dashboard space; the Tasks page is where you go to
          look for work. Kept mounted while loading so it doesn't flash in and out on every
          dashboard visit, and it reappears by itself the moment a task lands. */}
      {caps.has_tasks && (dueTasksLoading || dueWorkItems.length > 0) && (
        <Reveal delay={0.05}>
          <TodayTasksCard items={dueWorkItems} loading={dueTasksLoading} onStatusChange={handleTaskStatusChange} />
        </Reveal>
      )}

      {/* Executive quick actions */}
      {isExec && !isTrainee && (
        <Reveal delay={0.1}>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-foreground">{t.executiveActions}</CardTitle>
          </CardHeader>
          <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Link href="/approvals">
              <MotionCard className="p-4 rounded-xl bg-primary/10 border border-primary/20 hover:bg-primary/15 transition-colors cursor-pointer relative overflow-hidden">
                <Users className="w-5 h-5 text-primary mb-2" />
                <div className="text-sm font-semibold text-foreground flex items-center justify-between">
                  <span>{t.teamApprovals}</span>
                  {pickedCount > 0 && (
                    <span className="inline-flex h-5 items-center justify-center rounded-full bg-brand px-2 text-[10px] font-bold text-brand-foreground animate-pulse">
                      {pickedCount} Picked
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {pickedCount > 0
                    ? `You currently have ${pickedCount} technician(s) picked on your team. Tap to release.`
                    : t.approveAttendance
                  }
                </div>
              </MotionCard>
            </Link>
            <Link href="/leaves?tab=team">
              <MotionCard className="p-4 rounded-xl bg-brand/10 border border-brand/20 hover:bg-brand/15 transition-colors cursor-pointer">
                <CalendarDays className="w-5 h-5 text-brand mb-2" />
                <div className="text-sm font-semibold text-foreground">{t.leaveRequests}</div>
                <div className="text-xs text-muted-foreground mt-1">{t.reviewTeamLeaves}</div>
              </MotionCard>
            </Link>
          </div>
          </CardContent>
        </Card>
        </Reveal>
      )}
    </PageTransition>
  );
}
