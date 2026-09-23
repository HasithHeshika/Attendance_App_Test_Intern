'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import Portal from '@/components/Portal';
import { ChevronLeft, ChevronRight, Loader2, CalendarDays, ListChecks, Palmtree, Clock, X, CheckCircle2, Download, LogIn, LogOut, MapPin, AlertTriangle, Moon, Coffee, Trash2, Pencil, Check, CalendarOff, Map as MapIcon, Layers } from 'lucide-react';
import toast from 'react-hot-toast';
import { tenant } from '@/lib/firebase';
import { _attendanceApi as attendanceApi } from '@/services/apiCompat';
import { getMonthlyTasks } from '@/services/taskService';
import { getThisMonthLeaves, getEmployeeLeavesForMonth, softDeleteLeave } from '@/services/leaveService';
import { getMonthlyAttendance, softDeleteAttendance, adminUpdateAttendanceTimes } from '@/services/attendanceService';
import { getOutstationLocations } from '@/services/outstationService';
import { getShiftAssignmentsForEpf } from '@/services/shiftService';
import { getScheduleAssignmentsForEmployee } from '@/services/scheduleAssignmentService';
import { getWorkingPlaces } from '@/services/workingPlaceService';
import { getWorkPatterns } from '@/services/workPatternService';
import { getLatestSchedule } from '@/services/workingScheduleService';
import { getAcceptedHolidays, getHolidaySettings, fetchPublicHolidays } from '@/services/holidayService';
import {
  computeUserMonthlyReport, exportUserMonthlyReportXlsx,
  buildDailyRegister, exportDailyRegisterXlsx,
  LEAVE_COUNT_CUTOFF,
} from '@/lib/userMonthlyReport';
import { roleCategory } from '@/lib/permissions';
import { canonPlaceName, stripSiteNo } from '@/lib/placeName';
import { useRoles, useUserCapabilities } from '@/store/rolesStore';
import { useWorkingPlaces } from '@/store/workingPlacesStore';
import { useAuthStore } from '@/store/authStore';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import SessionLocations from '@/components/SessionLocations';
import ConfirmModal from '@/components/ConfirmModal';
import { useT } from '@/store/appStore';
import { formatTime } from '@/lib/utils';
import { calcMorningAllowance, calcEveningAllowance } from '@/lib/foodAllowance';
import { distanceMeters, DEFAULT_RADIUS_M } from '@/lib/geo';
import {
  monthsBackFor, buildApprovableMap, approvableForSession, toApprovalPayloads, PAST_BACKLOG_MAX_MONTHS,
  buildTrail, buildMonthMap, sessionSpan,
  type ApprovableSession, type SkipReason, type PastQueueRow, type LiveQueueRow, type TrailStop,
} from '@/lib/panelApprovals';
import { approvalQueueCache, pastQueueKey, liveQueueKey } from '@/lib/approvalQueueCache';
import type { SessionLocationView } from '@/components/SessionLocations';
import type { MapPlace } from '@/components/AttendanceMiniMap';
import type { AppUser, AttendanceRecord, ScheduleAssignment, WorkingPlaceLocation } from '@/lib/types';

// Leaflet mini-map — client-only and lazy, same as the dashboard card: it is only fetched
// when a day with GPS is opened, so leaflet never weighs on the users page bundle.
const AttendanceMiniMap = dynamic(() => import('@/components/AttendanceMiniMap'), {
  ssr: false,
  loading: () => <div className="h-40 w-full rounded-lg bg-muted animate-pulse" />,
});

// A self-contained "what has this person been doing" panel for the admin user detail:
// a month calendar (worked days + leave days), plus the month's tasks and leaves.
// All reads are by EPF; tolerant of partial failures (each section degrades alone).

interface TaskLite { id: string; date: string; description: string; status: string; hours?: number }
interface LeaveLite { id?: string; leave_id?: number; from_date: string; to_date: string; leave_type_name?: string; status: string; is_half_day?: boolean; considered_by?: string | null }
// A company-observed holiday, keyed by date on the calendar. `accepted` is always true for
// now (only company-accepted dates are shown) but is kept on the shape so a future "public
// holiday the company skipped" overlay can share it.
interface HolidayInfo { name: string; kind: 'poya' | 'public' | 'mercantile' | 'company'; accepted: boolean }
type HolidayByDate = Record<string, HolidayInfo>;

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const timeRangeOf = (start?: string, end?: string): string =>
  (!start && !end) ? '—' : `${start || '—'} – ${end || '—'}`;
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']; // week starts Monday
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function statusTone(status: string): 'success' | 'warning' | 'destructive' | 'muted' {
  const s = status?.toLowerCase();
  if (s === 'approved' || s === 'accept' || s === 'accepted' || s === 'completed') return 'success';
  if (s === 'pending' || s === 'on progress') return 'warning';
  if (s === 'rejected' || s === 'reject') return 'destructive';
  return 'muted';
}

// ── Per-day attendance detail helpers ───────────────────────────────────────────
interface DaySess {
  check_in?: unknown; check_out?: unknown;
  working_place?: string | null; site_number?: string | null;
  check_in_site_name?: string | null;   // GPS-matched place at check-in (may be the only place)
  check_in_site_id?: string | null;     // → working place (its geofence ring on the day map)
  // Multi-location history (raw session entries); absent on older docs. `added_at` is a
  // Firestore Timestamp on the raw doc.
  locations?: { name: string; site_number?: string | null; lat?: number | null; lng?: number | null; accuracy_m?: number | null; source?: string; added_at?: unknown }[];
  // Device GPS captured at check-in / check-out (recorded, not enforced) + its accuracy.
  check_in_lat?: number | null;  check_in_lng?: number | null;  check_in_accuracy_m?: number | null;
  check_out_lat?: number | null; check_out_lng?: number | null; check_out_accuracy_m?: number | null;
  check_out_within_radius?: boolean | null;
  is_outstation?: boolean; outstation_name?: string | null; outstation_address?: string | null;
  morning_allowance?: number; evening_allowance?: number;
  check_in_status?: string; check_out_status?: string;
}

// Firestore Timestamp | {seconds} | Date | ISO string → Date (null when absent/invalid).
function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (typeof v === 'object') {
    const o = v as { toDate?: () => Date; seconds?: number };
    if (typeof o.toDate === 'function') return o.toDate();
    if (typeof o.seconds === 'number') return new Date(o.seconds * 1000);
    if (v instanceof Date) return v;
  }
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : new Date(t); }
  return null;
}
function fmtTime(v: unknown): string {
  const d = toDate(v);
  return d ? formatTime(d.toISOString()) : '—';
}
// Local 'YYYY-MM-DD HH:MM:SS' — the shape the approval queue rows carry their times in.
function localStrOf(v: unknown): string | null {
  const d = toDate(v);
  return d ? `${ymd(d.getFullYear(), d.getMonth() + 1, d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : null;
}
// Minutes → short label for the calendar tile, e.g. 90 → "1.5h", 480 → "8h".
function fmtHoursShort(totalMinutes: number): string {
  const h = totalMinutes / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}
// Normalize a record into its sessions (back-compat with old single-session docs).
function recSessionsOf(rec: AttendanceRecord): DaySess[] {
  if (Array.isArray(rec.sessions) && rec.sessions.length) return rec.sessions as unknown as DaySess[];
  return [{
    check_in: rec.check_in, check_out: rec.check_out,
    working_place: rec.working_place, site_number: rec.site_number,
    is_outstation: rec.is_outstation, outstation_name: rec.outstation_name, outstation_address: rec.outstation_address,
    morning_allowance: rec.morning_allowance, evening_allowance: rec.evening_allowance,
    check_in_status: rec.check_in_status, check_out_status: rec.check_out_status,
  }];
}

export default function UserActivityPanel({ epf, user, usersByEpf }: { epf: string; user?: AppUser; usersByEpf?: Record<string, string> }) {
  // Resolve a leave's considered_by (epf) to a display name for the "Approved/Rejected by" line.
  const approverName = (considerBy?: string | null): string | null =>
    considerBy ? (usersByEpf?.[String(considerBy)] ?? String(considerBy)) : null;
  const t = useT();
  const { roles } = useRoles();
  const caps = useUserCapabilities();
  const { user: me } = useAuthStore();
  // Only a system admin may delete another employee's attendance/leave (soft delete only).
  const canDelete = !!caps.is_system_admin;
  // Southernlanka (carecode.org) hides the Summary/Daily downloads and the Tasks stat/list here.
  const isSouthernlanka = tenant.id === 'southernlanka';
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1–12
  const [loading, setLoading] = useState(true);
  const [worked, setWorked] = useState<string[]>([]);
  const [tasks, setTasks] = useState<TaskLite[]>([]);
  const [leaves, setLeaves] = useState<LeaveLite[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null); // YYYY-MM-DD or null
  const [downloading, setDownloading] = useState(false);
  const [downloadingDaily, setDownloadingDaily] = useState(false);
  // Full attendance records for the month + shift roster — drive the clicked-day detail
  // (check-in/out times, working place, shift, outstation, allowances).
  const [monthAtt, setMonthAtt] = useState<AttendanceRecord[]>([]);
  const [shiftAssignments, setShiftAssignments] = useState<Array<{ from_date?: string; to_date?: string }>>([]);
  // Southernlanka's shift roster (the Schedule page / My Schedule) — the real "shift table" for
  // nurses/other non-technician staff. Distinct from shiftAssignments above (technician
  // roving-site shifts, a different collection). Fetched only for that tenant.
  const [scheduleAssignments, setScheduleAssignments] = useState<ScheduleAssignment[]>([]);
  // Holidays for the displayed year. The company's accepted list is authoritative — a date
  // in the public feed that the company did not accept is NOT a holiday here. Cached per
  // year so paging through months never refetches; a failed load just means no overlay.
  const [holidayByDate, setHolidayByDate] = useState<HolidayByDate>({});
  const holidayCache = useRef<Map<number, HolidayByDate>>(new Map());
  // Soft-delete (system admin): confirmation target + reason, and a key to reload after deleting.
  const [refreshKey, setRefreshKey] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'attendance' | 'leave'; id: string; label: string } | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleting, setDeleting] = useState(false);
  // Inline session time edit (system admin): which session index is being edited + its draft
  // values. editCheckOutDate is only surfaced (and only applied) on shift days, since an
  // overnight shift's checkout lands on the following calendar day.
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editCheckInTime, setEditCheckInTime] = useState('');
  const [editCheckOutTime, setEditCheckOutTime] = useState('');
  const [editCheckOutNextDay, setEditCheckOutNextDay] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  // ── Approve from the calendar ──
  // A pending day is approvable HERE only when it sits in the VIEWER's own approval queue — the
  // two builders the Approvals page calls decide that (getPastAttendanceApprovalList for
  // past/backlog months, getCheckinApprovalList for today/yesterday); the panel never routes
  // on its own. Their numeric ids resolve through window.__attIdMap, which those calls fill.
  const viewerEpf = String(me?.epf_number ?? '');
  const viewerCompany = me?.company ?? '';
  // Anyone looking at someone else's panel gets the two builder calls — they are what decide
  // who may approve what (a pure location supervisor holds none of the approve caps yet is
  // routed rows by the builders). The TTL cache keeps that from costing a fetch per panel.
  const canTryApprove = !!viewerEpf && viewerEpf !== String(epf);
  const hasApproveCap = !!(caps.can_approve || caps.is_system_admin || caps.can_approve_technicians);
  const [approvable, setApprovable] = useState<Map<string, ApprovableSession[]>>(() => new Map());
  const [approvableStatus, setApprovableStatus] = useState<'idle' | 'loading' | 'ready' | 'tooOld'>('idle');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedDays, setSelectedDays] = useState<Set<string>>(() => new Set());
  const [approving, setApproving] = useState(false);
  // "All months…": fetching the viewer's whole backlog for this person, then the confirm step.
  const [allMonthsBusy, setAllMonthsBusy] = useState(false);
  const [allMonthsEmpty, setAllMonthsEmpty] = useState(false);
  const [allMonthsConfirm, setAllMonthsConfirm] = useState<{ entries: ApprovableSession[]; months: number } | null>(null);
  // After an approval: the next queue fetch bypasses the cache, and focus lands on the
  // "Select this month" button (more to approve) or the month heading (nothing left).
  const bypassCacheRef = useRef(false);
  const focusAfterApproveRef = useRef(false);
  const selectThisMonthRef = useRef<HTMLButtonElement>(null);
  const monthHeadingRef = useRef<HTMLSpanElement>(null);
  // Day map: which stop in which session is being hovered/tapped in the stops list.
  const [stopFocus, setStopFocus] = useState<{ session: number; lat: number; lng: number } | null>(null);
  // Month map (every check-in / check-out with GPS this month) — off by default.
  const [showMonthMap, setShowMonthMap] = useState(false);
  // Every working place, inactive ones too — an old session can still be site-matched to a
  // place retired since — for the geofence ring on the day-detail map. Loaded once.
  const [mapPlaces, setMapPlaces] = useState<WorkingPlaceLocation[]>([]);
  useEffect(() => {
    let cancelled = false;
    getWorkingPlaces(false).then(p => { if (!cancelled) setMapPlaces(p); }).catch(() => { /* map falls back to the store's places */ });
    return () => { cancelled = true; };
  }, []);

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    if (!deleteReason.trim()) { toast.error('Please give a reason'); return; }
    setDeleting(true);
    try {
      const by = String(me?.epf_number ?? '');
      if (deleteTarget.type === 'attendance') await softDeleteAttendance(deleteTarget.id, by, deleteReason.trim());
      else await softDeleteLeave(deleteTarget.id, by, deleteReason.trim());
      toast.success(`${deleteTarget.type === 'attendance' ? 'Attendance' : 'Leave'} deleted`);
      setDeleteTarget(null);
      setDeleteReason('');
      setSelectedDate(null);
      setRefreshKey(k => k + 1);   // reload the month so the removed record disappears
    } catch { toast.error('Delete failed'); }
    finally { setDeleting(false); }
  };

  // Download the displayed month's attendance report (.xlsx) for this employee. Fetches the
  // full attendance/leave/outstation/holiday data on demand (heavier than the calendar's
  // date-only read), computes the columns, and saves the file.
  const handleDownload = async () => {
    if (!user) return;
    setDownloading(true);
    try {
      const isTechnician = roleCategory(user.role, roles) === 'technician';
      const [attendance, empLeaves, outstations, holidays, publicHols, shiftAssignments, workingPlaces, workPatterns, latestSchedule] = await Promise.all([
        getMonthlyAttendance(epf, year, month),
        getEmployeeLeavesForMonth(epf, year, month),
        getOutstationLocations(),
        getAcceptedHolidays(year),
        fetchPublicHolidays(year),   // for Poya dates (counted as extra working days)
        isTechnician ? getShiftAssignmentsForEpf(epf) : Promise.resolve([]),
        isTechnician ? getWorkingPlaces() : Promise.resolve([]),
        // Best-effort, as on the attendance calendar: if either read fails, the built-in week
        // applies and the leave count is exactly what it was before work patterns existed.
        getWorkPatterns().catch(() => []),
        getLatestSchedule(epf).catch(() => null),
      ]);
      const poyaDates = new Set(publicHols.filter(h => h.is_poya).map(h => h.date));
      const shiftPlaceNames = new Set(
        workingPlaces.filter(w => w.tags?.includes('shift')).map(w => w.name.toLowerCase()));
      const report = computeUserMonthlyReport({
        user, isTechnician, attendance, leaves: empLeaves, outstations, holidays, year, month,
        poyaDates, shiftAssignments, shiftPlaceNames,
        saturdayHalfDay: tenant.features.saturdayHalfDay,
                leaveCountCutoff: LEAVE_COUNT_CUTOFF,
                        workPatterns,
        patternSubject: {
          company_id: user.company_id ?? null,
          role: user.role ?? null,
          working_place: latestSchedule?.working_place ?? null,
        },
      });
      await exportUserMonthlyReportXlsx(report, year, month);
      toast.success(`Summary downloaded — ${MONTHS[month - 1]} ${year}`);
    } catch (e) {
      console.error(e);
      toast.error('Failed to generate report');
    } finally {
      setDownloading(false);
    }
  };

  // Download the displayed month's per-day attendance register (.xlsx) — one row per day
  // with check-in/out, leave, shift, outstation and working place.
  const handleDownloadDaily = async () => {
    if (!user) return;
    setDownloadingDaily(true);
    try {
      const [attendance, empLeaves, shiftAssignments, workingPlaces] = await Promise.all([
        getMonthlyAttendance(epf, year, month),
        getEmployeeLeavesForMonth(epf, year, month),
        getShiftAssignmentsForEpf(epf),
        getWorkingPlaces(),
      ]);
      const shiftPlaceNames = new Set(
        workingPlaces.filter(w => w.tags?.includes('shift')).map(w => w.name));
      const reg = buildDailyRegister({ user, attendance, leaves: empLeaves, shiftAssignments, shiftPlaceNames, year, month });
      await exportDailyRegisterXlsx(reg, year, month);
      toast.success(`Daily register downloaded — ${MONTHS[month - 1]} ${year}`);
    } catch (e) {
      console.error(e);
      toast.error('Failed to generate register');
    } finally {
      setDownloadingDaily(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const [attR, taskR, leaveR, fullAttR, shiftR, scheduleR] = await Promise.allSettled([
        attendanceApi.getMonthlyAttendanceDates(epf, month, year),
        getMonthlyTasks(epf, year, month),
        getThisMonthLeaves(epf, year, month),
        getMonthlyAttendance(epf, year, month),
        getShiftAssignmentsForEpf(epf),
        isSouthernlanka ? getScheduleAssignmentsForEmployee(epf) : Promise.resolve([]),
      ]);
      if (cancelled) return;
      const att = attR.status === 'fulfilled' ? (attR.value.data?.data ?? attR.value.data) : null;
      setWorked(Array.isArray(att?.attendance_dates) ? att.attendance_dates : []);
      setTasks(taskR.status === 'fulfilled' ? (taskR.value as unknown as TaskLite[]) : []);
      setLeaves(leaveR.status === 'fulfilled' ? (leaveR.value as unknown as LeaveLite[]) : []);
      setMonthAtt(fullAttR.status === 'fulfilled' ? (fullAttR.value as AttendanceRecord[]) : []);
      setShiftAssignments(shiftR.status === 'fulfilled' ? (shiftR.value as Array<{ from_date?: string; to_date?: string }>) : []);
      setScheduleAssignments(scheduleR.status === 'fulfilled' ? (scheduleR.value as ScheduleAssignment[]) : []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [epf, year, month, refreshKey]);

  useEffect(() => {
    const cached = holidayCache.current.get(year);
    if (cached) { setHolidayByDate(cached); return; }
    let cancelled = false;
    (async () => {
      // Both loaders swallow their own errors and return empty shapes, so this never throws.
      const [settings, publicHols] = await Promise.all([getHolidaySettings(year), fetchPublicHolidays(year)]);
      const customName = new Map(settings.custom.map(c => [c.date, c.name]));
      const publicName = new Map(publicHols.map(h => [h.date, h.name]));
      const map: HolidayByDate = {};
      for (const date of settings.dates) {
        const name = customName.get(date) || publicName.get(date) || t.holidayWord;
        map[date] = { name, kind: settings.types[date] ?? 'company', accepted: true };
      }
      holidayCache.current.set(year, map);
      if (!cancelled) setHolidayByDate(map);
    })();
    return () => { cancelled = true; };
    // t.holidayWord only names dates with no better name; a language switch mid-session is
    // not worth a refetch, so it is deliberately left out of the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  const workedSet = useMemo(() => new Set(worked), [worked]);
  // Total worked minutes per date, summed across all sessions that day (check-out − check-in).
  const hoursByDate = useMemo(() => {
    const m = new Map<string, number>();
    monthAtt.forEach(rec => {
      let minutes = 0;
      recSessionsOf(rec).forEach(s => {
        const inMs = toDate(s.check_in)?.getTime();
        const outMs = toDate(s.check_out)?.getTime();
        if (inMs != null && outMs != null && outMs > inMs) minutes += Math.round((outMs - inMs) / 60000);
      });
      if (minutes > 0) m.set(rec.date, (m.get(rec.date) ?? 0) + minutes);
    });
    return m;
  }, [monthAtt]);
  // Dates with a check-in or check-out still awaiting approval (or a checkout not yet
  // submitted at all — check_out_status defaults to 'pending' at check-in time).
  const pendingSet = useMemo(() => {
    const s = new Set<string>();
    monthAtt.forEach(rec => {
      const isPending = recSessionsOf(rec).some(sess =>
        sess.check_in_status === 'pending' || sess.check_out_status === 'pending');
      if (isPending) s.add(rec.date);
    });
    return s;
  }, [monthAtt]);
  // Expand each leave's date range into the set of days that fall inside this month.
  const leaveSet = useMemo(() => {
    const s = new Set<string>();
    const first = ymd(year, month, 1);
    const last = ymd(year, month, new Date(year, month, 0).getDate());
    for (const lv of leaves) {
      let cur = lv.from_date < first ? first : lv.from_date;
      const end = lv.to_date > last ? last : lv.to_date;
      // iterate day by day (ranges are short)
      while (cur <= end) {
        s.add(cur);
        const [y, m, d] = cur.split('-').map(Number);
        const nx = new Date(y, m - 1, d + 1);
        cur = ymd(nx.getFullYear(), nx.getMonth() + 1, nx.getDate());
      }
    }
    return s;
  }, [leaves, year, month]);
  // Holidays this month the person actually checked in on — drives the legend row, the
  // month stat and the "worked on a holiday" note in the day detail.
  const holidaysWorked = useMemo(() => {
    const prefix = `${year}-${pad(month)}`;
    return Object.keys(holidayByDate).filter(d => d.startsWith(prefix) && workedSet.has(d));
  }, [holidayByDate, workedSet, year, month]);
  // Label under the day number for a holiday the person did not work: Poya days say "Poya",
  // everything else says "Holiday" — the name itself goes in the title/aria-label.
  const holidayCellLabel = (h: HolidayInfo) => (h.kind === 'poya' ? t.poyaLabel : t.holidayWord);

  const todayStr = ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const daysInMonth = new Date(year, month, 0).getDate();

  // Rebuild the viewer's approvable set whenever the month (re)loads. Skipped outright when
  // the viewer cannot approve anyone or the month has nothing pending, so a plain viewer's
  // panel makes no extra reads at all.
  useEffect(() => {
    setSelectMode(false);
    setSelectedDays(new Set());
    setAllMonthsEmpty(false);
    const settle = (remaining: number) => {
      if (!focusAfterApproveRef.current) return;
      focusAfterApproveRef.current = false;
      // The button only exists once the new approvable set has rendered.
      setTimeout(() => { (remaining > 0 ? selectThisMonthRef.current : monthHeadingRef.current)?.focus(); }, 0);
    };
    if (!canTryApprove || loading || pendingSet.size === 0) {
      setApprovable(new Map()); setApprovableStatus('idle');
      if (!loading) settle(0);
      return;
    }
    const monthsBack = monthsBackFor(year, month, todayStr);
    if (monthsBack > PAST_BACKLOG_MAX_MONTHS) { setApprovable(new Map()); setApprovableStatus('tooOld'); settle(0); return; }
    let cancelled = false;
    setApprovableStatus('loading');
    const bypass = bypassCacheRef.current;
    bypassCacheRef.current = false;
    (async () => {
      // The live list only ever covers today and yesterday's overnight checkouts.
      const ym = `${year}-${pad(month)}`;
      const [ty, tm, td] = todayStr.split('-').map(Number);
      const yest = new Date(ty, tm - 1, td - 1);
      const liveRelevant = todayStr.startsWith(ym) || ymd(yest.getFullYear(), yest.getMonth() + 1, yest.getDate()).startsWith(ym);
      const [pastR, liveR] = await Promise.allSettled([
        approvalQueueCache.get(pastQueueKey(viewerEpf, viewerCompany, monthsBack),
          () => attendanceApi.getPastAttendanceApprovalList(viewerEpf, viewerCompany, { monthsBack }), { bypass }),
        liveRelevant
          ? approvalQueueCache.get(liveQueueKey(viewerEpf, viewerCompany),
              () => attendanceApi.getCheckinApprovalList(viewerEpf, viewerCompany), { bypass })
          : Promise.resolve(null),
      ]);
      if (cancelled) return;
      const pastRows = (pastR.status === 'fulfilled' ? (pastR.value?.data?.data ?? []) : []) as PastQueueRow[];
      const live = liveR.status === 'fulfilled' ? liveR.value?.data?.data : null;
      const liveRows = (live ? [...(live.tech_list ?? []), ...(live.exe_list ?? [])] : []) as LiveQueueRow[];
      const next = buildApprovableMap(pastRows, liveRows, epf);
      setApprovable(next);
      setApprovableStatus('ready');
      settle(next.size);
    })();
    return () => { cancelled = true; };
  }, [canTryApprove, viewerEpf, viewerCompany, epf, year, month, todayStr, loading, pendingSet]);

  const skipReasonLabel = (r: SkipReason): string => ({
    missing_check_in: t.skipMissingCheckIn, missing_check_out: t.skipMissingCheckOut, zero_length: t.skipZeroLength,
    missing_place: t.skipMissingPlace, missing_site: t.skipMissingSite,
  })[r];
  // Approve queue entries with their RECORDED times and the auto-calculated food allowances —
  // the same payloads the Approvals page sends for an unedited card, to the same endpoints.
  const approveSessions = async (entries: ApprovableSession[]) => {
    if (entries.length === 0 || !viewerEpf || approving) return;
    const { past, checkIn, checkOut, skipped } = toApprovalPayloads(
      entries, { morning: calcMorningAllowance, evening: calcEveningAllowance }, { requiresSite });
    const skippedMsg = () => {
      const counts = new Map<SkipReason, number>();
      skipped.forEach(k => counts.set(k.reason, (counts.get(k.reason) ?? 0) + 1));
      const reasons = [...counts.entries()].map(([r, n]) => `${n} ${skipReasonLabel(r)}`).join(', ');
      return t.sessionsSkipped.replace('{n}', String(skipped.length)).replace('{reasons}', reasons);
    };
    const okCount = entries.length - skipped.length;
    if (okCount === 0) { toast.error(skippedMsg()); return; }
    setApproving(true);
    try {
      if (past.length)     await attendanceApi.approvePastAttendance({ epf_number: viewerEpf, approved_list: past });
      // A 'both' row goes through BOTH calls — check-in first (awaited), then check-out — so
      // the claim order is preserved, exactly as the Approvals page does it.
      if (checkIn.length)  await attendanceApi.approveCheckIn({ epf_number: viewerEpf, approved_list: checkIn });
      if (checkOut.length) await attendanceApi.approveCheckOut({ epf_number: viewerEpf, approved_list: checkOut });
      const skippedIds = new Set(skipped.map(k => k.id));
      const okDays = new Set(entries.filter(e => !skippedIds.has(e.id)).map(e => e.date)).size;
      toast.success(t.sessionsApprovedOnDays.replace('{n}', String(okCount)).replace('{d}', String(okDays)));
      if (skipped.length) toast.error(skippedMsg());
      // The queues changed: nothing cached may be served again, and the reload's fetch is
      // forced past the cache too.
      approvalQueueCache.invalidate();
      bypassCacheRef.current = true;
      focusAfterApproveRef.current = true;
      setSelectMode(false);
      setSelectedDays(new Set());
      setRefreshKey(k => k + 1);   // reload the month; the approvable set is rebuilt off that reload
    } catch (e) {
      console.error(e);
      toast.error(t.approveFailedRetry);
    } finally {
      setApproving(false);
    }
  };
  const approveSelectedDays = () => approveSessions([...selectedDays].flatMap(d => approvable.get(d) ?? []));
  const selectThisMonth = () => { setSelectMode(true); setSelectedDays(new Set(approvable.keys())); };
  // "All months…": the viewer's WHOLE backlog for this person (the builders' furthest window),
  // shown as a count to confirm before anything is approved. Ids come from the builders only.
  const openApproveAllMonths = async () => {
    if (allMonthsBusy || approving || !viewerEpf) return;
    setAllMonthsBusy(true);
    try {
      const [pastR, liveR] = await Promise.allSettled([
        approvalQueueCache.get(pastQueueKey(viewerEpf, viewerCompany, PAST_BACKLOG_MAX_MONTHS),
          () => attendanceApi.getPastAttendanceApprovalList(viewerEpf, viewerCompany, { monthsBack: PAST_BACKLOG_MAX_MONTHS })),
        approvalQueueCache.get(liveQueueKey(viewerEpf, viewerCompany),
          () => attendanceApi.getCheckinApprovalList(viewerEpf, viewerCompany)),
      ]);
      const pastRows = (pastR.status === 'fulfilled' ? (pastR.value?.data?.data ?? []) : []) as PastQueueRow[];
      const live = liveR.status === 'fulfilled' ? liveR.value?.data?.data : null;
      const liveRows = (live ? [...(live.tech_list ?? []), ...(live.exe_list ?? [])] : []) as LiveQueueRow[];
      const all = buildApprovableMap(pastRows, liveRows, epf);
      const entries = [...all.values()].flat();
      if (entries.length === 0) {
        setAllMonthsEmpty(true);
        toast(t.nothingPendingAllMonths.replace('{n}', String(PAST_BACKLOG_MAX_MONTHS)));
        return;
      }
      const months = new Set([...all.keys()].map(d => d.slice(0, 7))).size;
      setAllMonthsConfirm({ entries, months });
    } catch (e) {
      console.error(e);
      toast.error(t.approveFailedRetry);
    } finally {
      setAllMonthsBusy(false);
    }
  };
  const confirmApproveAllMonths = async () => {
    if (!allMonthsConfirm) return;
    await approveSessions(allMonthsConfirm.entries);
    setAllMonthsConfirm(null);
  };
  const exitSelectMode = () => { setSelectMode(false); setSelectedDays(new Set()); };
  const toggleDay = (date: string) => setSelectedDays(prev => {
    const n = new Set(prev);
    if (n.has(date)) n.delete(date); else n.add(date);
    return n;
  });
  // Monday-first: shift JS getDay() (0=Sun) so Mon→0 … Sun→6.
  const leadBlanks = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const cells: (number | null)[] = [
    ...Array.from({ length: leadBlanks }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const goPrev = () => { setSelectedDate(null); if (month === 1) { setMonth(12); setYear(y => y - 1); } else setMonth(m => m - 1); };
  const goNext = () => { setSelectedDate(null); if (month === 12) { setMonth(1); setYear(y => y + 1); } else setMonth(m => m + 1); };
  const fmtRange = (a: string, b: string) => (a === b ? a : `${a} → ${b}`);

  // ── Selected-day detail (from already-loaded data — no extra API calls) ──
  const selWorked = selectedDate ? workedSet.has(selectedDate) : false;
  const selLeave  = selectedDate ? leaveSet.has(selectedDate) : false;
  const selHoliday = selectedDate ? holidayByDate[selectedDate] ?? null : null;
  const selHolidayMinutes = selectedDate ? hoursByDate.get(selectedDate) ?? 0 : 0;
  const selTasks  = useMemo(() => (selectedDate ? tasks.filter(tk => tk.date === selectedDate) : []), [selectedDate, tasks]);
  const selLeaves = useMemo(
    () => (selectedDate ? leaves.filter(lv => String(lv.from_date).slice(0, 10) <= selectedDate && String(lv.to_date).slice(0, 10) >= selectedDate) : []),
    [selectedDate, leaves],
  );
  // Attendance record (+ its sessions) for the clicked day; the record's id drives soft-delete.
  const selAttRec = useMemo(
    () => (selectedDate ? monthAtt.find(r => r.date === selectedDate) ?? null : null),
    [selectedDate, monthAtt],
  );
  const selSessions = useMemo(() => (selAttRec ? recSessionsOf(selAttRec) : [] as DaySess[]), [selAttRec]);
  // Shift day: the roster covers it OR a session that day is at a shift-tagged place.
  // Place names are matched canonically — a Solar-app "<name> (#site-no)" pick counts too.
  const { options: allPlaces, requiresSite } = useWorkingPlaces();
  const shiftPlaceCanon = useMemo(() => new Set(
    allPlaces.filter(p => (p.tags ?? []).includes('shift')).map(p => canonPlaceName(p.name))), [allPlaces]);
  // Southernlanka's shift roster (schedule_assignments), grouped by date — a day can carry more
  // than one shift. This is the actual "shift table" for that tenant's staff (nurses etc.), a
  // different collection from the technician shiftAssignments above.
  const scheduleByDate = useMemo(() => {
    const m = new Map<string, ScheduleAssignment[]>();
    const prefix = `${year}-${pad(month)}`;
    scheduleAssignments
      .filter(a => a.date?.startsWith(prefix))
      .forEach(a => { const arr = m.get(a.date) ?? []; arr.push(a); m.set(a.date, arr); });
    return m;
  }, [scheduleAssignments, year, month]);
  const selSchedule = useMemo(() => (selectedDate ? scheduleByDate.get(selectedDate) ?? [] : []), [selectedDate, scheduleByDate]);
  const selShift = !!selectedDate && (
    selSchedule.length > 0 ||
    shiftAssignments.some(a => (a.from_date ?? '') <= selectedDate && selectedDate <= (a.to_date ?? '')) ||
    selSessions.some(s => [s.working_place, s.check_in_site_name, ...(s.locations ?? []).map(l => l.name)]
      .some(n => !!n && shiftPlaceCanon.has(canonPlaceName(n)))));
  // All dates this month that are "shift" days — a southernlanka schedule assignment, the
  // technician roster covering it, or a session that day at a shift-tagged place (mirrors
  // selShift's logic above, generalized to every date).
  const shiftDateSet = useMemo(() => {
    const s = new Set<string>(scheduleByDate.keys());
    const daysCount = new Date(year, month, 0).getDate();
    for (let d = 1; d <= daysCount; d++) {
      const date = ymd(year, month, d);
      if (shiftAssignments.some(a => (a.from_date ?? '') <= date && date <= (a.to_date ?? ''))) s.add(date);
    }
    monthAtt.forEach(rec => {
      if (recSessionsOf(rec).some(sess => [sess.working_place, sess.check_in_site_name, ...(sess.locations ?? []).map(l => l.name)]
        .some(n => !!n && shiftPlaceCanon.has(canonPlaceName(n))))) {
        s.add(rec.date);
      }
    });
    return s;
  }, [scheduleByDate, shiftAssignments, monthAtt, shiftPlaceCanon, year, month]);
  // "Working Days" for shift staff = shift days this month (schedule roster or technician
  // roster), excluding leave days. Falls back to actual worked (checked-in) days for employees
  // with no shift roster at all.
  const shiftWorkingDaysCount = useMemo(() => {
    let count = 0;
    shiftDateSet.forEach(date => { if (!leaveSet.has(date)) count++; });
    return count;
  }, [shiftDateSet, leaveSet]);
  const workingDaysCount = (shiftAssignments.length > 0 || scheduleAssignments.length > 0) ? shiftWorkingDaysCount : workedSet.size;
  // The month's clock, from the same per-day sums the grid prints in each cell — so the total
  // always agrees with what someone gets adding the cells up by hand. Deliberately NOT an
  // "extra hours" or "short days" reading like the attendance page's: those need a real
  // expected-hours-per-day model (see the working-patterns spec in docs/superpowers/specs),
  // and this panel has no business inventing one.
  const monthMinutes = useMemo(() => {
    let total = 0;
    hoursByDate.forEach(m => { total += m; });
    return total;
  }, [hoursByDate]);
  const daysWithHours = hoursByDate.size;
  // Leaving the day (or its record changing under us, e.g. after a save) closes any open editor.
  useEffect(() => { setEditingIdx(null); setStopFocus(null); }, [selectedDate]);

  const timeInputOf = (v: unknown): string => {
    const d = toDate(v);
    return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
  };
  const dateInputOf = (v: unknown): string => {
    const d = toDate(v);
    return d ? ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()) : '';
  };
  const startEditSession = (i: number, s: DaySess) => {
    setEditingIdx(i);
    setEditCheckInTime(timeInputOf(s.check_in));
    setEditCheckOutTime(timeInputOf(s.check_out));
    const outDateStr = dateInputOf(s.check_out);
    setEditCheckOutNextDay(!!outDateStr && !!selectedDate && outDateStr > selectedDate);
  };
  const handleSaveSessionEdit = async (i: number) => {
    if (!selAttRec || !selectedDate) return;
    if (!editCheckInTime) { toast.error('Check-in time is required'); return; }
    const [y, m, d] = selectedDate.split('-').map(Number);
    const [ciH, ciM] = editCheckInTime.split(':').map(Number);
    const checkIn = new Date(y, m - 1, d, ciH, ciM, 0, 0);
    let checkOut: Date | undefined;
    if (editCheckOutTime) {
      const [coH, coM] = editCheckOutTime.split(':').map(Number);
      const outDay = selShift && editCheckOutNextDay ? d + 1 : d;
      checkOut = new Date(y, m - 1, outDay, coH, coM, 0, 0);
      if (checkOut <= checkIn) { toast.error('Check-out must be after check-in'); return; }
    }
    setSavingEdit(true);
    try {
      const sessionIndex = Array.isArray(selAttRec.sessions) && selAttRec.sessions.length ? i : null;
      await adminUpdateAttendanceTimes(selAttRec.id, sessionIndex, { check_in: checkIn, check_out: checkOut });
      toast.success('Attendance updated');
      setEditingIdx(null);
      setRefreshKey(k => k + 1);
    } catch (e) {
      console.error(e);
      toast.error('Failed to update attendance');
    } finally {
      setSavingEdit(false);
    }
  };
  // Day-detail map inputs for one session: check-in / check-out points, the in-session
  // location updates as a trail, and the check-in-matched working place's geofence. Null when
  // the session recorded no GPS at all (older data, permission denied) — no map is drawn then.
  const placeById = (siteId: string | null) => {
    const opt = siteId ? (mapPlaces.find(p => p.id === siteId) ?? allPlaces.find(p => p.id === siteId)) : undefined;
    const place: MapPlace | null = opt && opt.latitude != null && opt.longitude != null
      ? { lat: opt.latitude, lng: opt.longitude, radius: opt.radius_m ?? null } : null;
    return { opt, place };
  };
  const trailLabels = { checkIn: t.checkIn, checkOut: t.checkOut, update: t.updateWord, inShort: t.inShort, outShort: t.outShort };
  const sessionMap = (s: DaySess): { trail: TrailStop[]; place: MapPlace | null; placeName: string } | null => {
    const trail = buildTrail(s, fmtTime, trailLabels);
    if (trail.length === 0) return null;
    const { opt, place } = placeById(s.check_in_site_id ? String(s.check_in_site_id) : null);
    return { trail, place, placeName: opt?.name ?? s.check_in_site_name ?? t.workplaceMapLabel };
  };
  // A stop's distance from the matched place, worded: in range, or how far outside its ring.
  const stopDistance = (stop: { lat: number; lng: number }, place: MapPlace | null): string | null => {
    if (!place) return null;
    const radius = place.radius && place.radius > 0 ? place.radius : DEFAULT_RADIUS_M;
    const outside = distanceMeters(stop.lat, stop.lng, place.lat, place.lng) - radius;
    return outside <= 0 ? t.inRange : t.metersOutside.replace('{m}', String(Math.max(5, Math.round(outside / 5) * 5)));
  };
  const fmtDuration = (minutes: number) => {
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  };
  // Month map: every check-in / check-out with GPS this month, ringed by the month's most
  // frequent check-in place. Hidden entirely when no session recorded any GPS.
  const shortDay = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  const monthMapData = useMemo(
    () => buildMonthMap(monthAtt.map(r => ({ date: r.date, sessions: recSessionsOf(r) })), fmtTime, shortDay, { inShort: t.inShort, outShort: t.outShort }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [monthAtt, t.inShort, t.outShort],
  );
  const monthMapPlace = placeById(monthMapData.topSiteId);
  const prettyDate = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  };

  return (
    <div className="px-5 pt-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">{t.activityTitle}</div>
        <div className="flex items-center gap-1.5">
          {!loading && monthMapData.stops.length > 0 && (
            <button
              type="button"
              onClick={() => setShowMonthMap(v => !v)}
              aria-pressed={showMonthMap}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                showMonthMap ? 'border-foreground/40 bg-foreground/10 text-foreground' : 'border-border bg-card text-muted-foreground hover:text-foreground'
              }`}
            >
              <MapIcon className="w-3.5 h-3.5" aria-hidden="true" />
              {t.monthMap}
            </button>
          )}
          {user && !isSouthernlanka && (<>
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading}
              title={`Download ${MONTHS[month - 1]} ${year} summary report (Excel)`}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/20 disabled:opacity-60"
            >
              {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              {downloading ? 'Generating…' : 'Summary'}
            </button>
            <button
              type="button"
              onClick={handleDownloadDaily}
              disabled={downloadingDaily}
              title={`Download ${MONTHS[month - 1]} ${year} per-day attendance register (Excel)`}
              className="inline-flex items-center gap-1.5 rounded-md border border-brand/30 bg-brand/10 px-2.5 py-1.5 text-[11px] font-semibold text-brand transition-colors hover:bg-brand/20 disabled:opacity-60"
            >
              {downloadingDaily ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              {downloadingDaily ? 'Generating…' : 'Daily'}
            </button>
          </>)}
        </div>
      </div>

      {/* Calendar card */}
      <div className="rounded-xl border border-border bg-muted/40 p-3">
        <div className="flex items-center justify-between mb-2">
          <button onClick={goPrev} aria-label="Previous month"
            className="w-7 h-7 rounded-md border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span ref={monthHeadingRef} tabIndex={-1} className="text-sm font-semibold text-foreground tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">{MONTHS[month - 1]} {year}</span>
          <button onClick={goNext} aria-label="Next month"
            className="w-7 h-7 rounded-md border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Month map: one stop per check-in / check-out with GPS, no line between days; a
            stop opens its day. Ringed by the month's most frequent check-in place. */}
        {!loading && showMonthMap && monthMapData.stops.length > 0 && (
          <div className="mb-3 overflow-hidden rounded-lg border border-border bg-card">
            <div className="h-56 w-full">
              <AttendanceMiniMap
                variant="panel"
                trail={monthMapData.stops}
                place={monthMapPlace.place}
                connect={false}
                onStopClick={i => { const d = monthMapData.stops[i]?.date; if (d) setSelectedDate(d); }}
                labels={{ checkIn: t.checkIn, checkOut: t.checkOut, place: monthMapPlace.opt?.name ?? t.workplaceMapLabel }}
                className="h-full w-full"
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-2 py-1 text-[10px] text-muted-foreground">
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />{t.checkIn}</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full border-2 border-primary" aria-hidden="true" />{t.checkOut}</span>
              {monthMapPlace.place && <span className="inline-flex items-center gap-1"><MapPin className="w-2.5 h-2.5" aria-hidden="true" />{monthMapPlace.opt?.name}</span>}
              <span className="ml-auto tabular-nums">
                {t.monthMapCoverage.replace('{n}', String(monthMapData.withGps)).replace('{m}', String(monthMapData.withoutGps))}
              </span>
            </div>
          </div>
        )}

        {loading ? (
          <div className="h-44 flex items-center justify-center"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>
        ) : (
          <>
            <div className="grid grid-cols-7 gap-1 mb-1">
              {WEEKDAYS.map((w, i) => (
                <div key={i} className="text-center text-[10px] font-semibold text-muted-foreground/70">{w}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {cells.map((d, i) => {
                if (d === null) return <div key={i} />;
                const date = ymd(year, month, d);
                const isWorked = workedSet.has(date);
                const isLeave = leaveSet.has(date);
                const isToday = date === todayStr;
                const isSel = date === selectedDate;
                const isPending = pendingSet.has(date);
                const isShift = shiftDateSet.has(date);
                const workedMinutes = hoursByDate.get(date) ?? 0;
                // Approvable = in the viewer's own queue. Marked by an amber OUTLINE + a
                // "Pending" pill; the open-day / today rings stay on the ring axis so both
                // can show at once. A pending day that is NOT the viewer's keeps today's look.
                const isApprovable = approvable.has(date);
                const isPicked = isApprovable && selectedDays.has(date);
                const holiday = holidayByDate[date];
                // Worked / leave / pending tones win over the holiday tone — a holiday only
                // colours the cell when nothing else does. The dashed border marks it either way.
                const tone = isPending
                  ? 'bg-warning/15 text-warning hover:bg-warning/25'
                  : isWorked
                    ? 'bg-success/15 text-success hover:bg-success/25'
                    : isLeave
                      ? 'bg-violet-500/15 text-violet-500 hover:bg-violet-500/25'
                      : holiday
                        ? 'bg-brand/10 text-brand hover:bg-brand/20'
                        : 'text-muted-foreground hover:bg-accent';
                const baseLabel = selectMode && isApprovable
                  ? t.selectForApproval.replace('{date}', prettyDate(date))
                  : isApprovable ? `${prettyDate(date)} · ${t.yoursToApproveLegend}` : prettyDate(date);
                const ariaLabel = holiday ? `${baseLabel}, ${holiday.name}${isWorked ? ', worked' : ''}` : baseLabel;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      if (selectMode && isApprovable) toggleDay(date);
                      else setSelectedDate(prev => (prev === date ? null : date));
                    }}
                    aria-pressed={selectMode && isApprovable ? isPicked : isSel}
                    aria-label={ariaLabel}
                    title={holiday ? holiday.name : undefined}
                    className={`relative aspect-square rounded-md flex flex-col items-center justify-center gap-0.5 text-xs font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tone} ${
                      holiday ? 'border border-dashed border-brand/60' : ''
                    } ${
                      isPicked ? 'bg-warning/35' : ''
                    } ${isApprovable ? 'outline outline-2 -outline-offset-2 outline-warning' : ''} ${
                      isSel ? 'ring-2 ring-primary ring-inset' : isToday ? 'ring-1 ring-primary/50 ring-inset' : ''
                    }`}
                  >
                    {holiday && isWorked && (
                      // "Worked, and it was a holiday" — the green tone says worked, the dot says holiday.
                      // It yields the top-right corner to the approve glyph when both apply.
                      <span aria-hidden="true" className={`absolute top-0.5 h-1.5 w-1.5 rounded-full bg-brand ring-1 ring-card ${isApprovable ? 'left-0.5' : 'right-0.5'}`} />
                    )}
                    {isApprovable && (
                      // Yours to approve (clock) / picked (check) — a glyph, so the hours line below
                      // keeps its room; the words live in the aria-label.
                      <span aria-hidden="true" className="absolute top-0.5 right-0.5 leading-none text-warning">
                        {isPicked ? <Check className="w-2.5 h-2.5" strokeWidth={3} /> : <Clock className="w-2.5 h-2.5" />}
                      </span>
                    )}
                    <span className="leading-none">{d}</span>
                    {isWorked && workedMinutes > 0 ? (
                      <span className="text-[8px] font-semibold leading-none opacity-80">{fmtHoursShort(workedMinutes)}</span>
                    ) : isShift ? (
                      <span className="text-[8px] font-semibold leading-none opacity-80">Shift</span>
                    ) : holiday && !isWorked ? (
                      <span className="text-[8px] font-semibold leading-none opacity-80">{holidayCellLabel(holiday)}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {/* Legend */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-success/40" />{t.workedLegend}</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-violet-500/40" />{t.leaveLegend}</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-warning/40" />{t.pendingLegend}</span>
              {approvable.size > 0 && (
                <span className="flex items-center gap-1.5"><Clock className="w-2.5 h-2.5 text-warning" aria-hidden="true" />{t.yoursToApproveLegend}</span>
              )}
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm border border-dashed border-brand/70" />{t.holidayWord}</span>
              {holidaysWorked.length > 0 && (
                <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-brand ring-1 ring-card" />Worked on a holiday</span>
              )}
              {canTryApprove && approvableStatus === 'loading' && (
                <span className="ml-auto inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />{t.checkingApprovable}</span>
              )}
              {canTryApprove && approvableStatus === 'tooOld' && (
                <span className="ml-auto">{t.monthTooOldToApprove.replace('{n}', String(PAST_BACKLOG_MAX_MONTHS))}</span>
              )}
              {!selectMode && (approvable.size > 0 || (canTryApprove && approvableStatus !== 'loading' && (hasApproveCap || approvableStatus === 'tooOld'))) && (
                <span className="ml-auto inline-flex items-center gap-1.5">
                  {approvable.size > 0 && (
                    <button type="button" ref={selectThisMonthRef} onClick={selectThisMonth}
                      className="inline-flex items-center gap-1 rounded-md border border-warning/50 bg-warning/10 px-2 py-1 text-[11px] font-semibold text-warning transition-colors hover:bg-warning/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <ListChecks className="w-3 h-3" aria-hidden="true" /> {t.selectThisMonth} ({approvable.size})
                    </button>
                  )}
                  <button type="button" onClick={openApproveAllMonths} disabled={allMonthsBusy || approving || allMonthsEmpty}
                    aria-busy={allMonthsBusy}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground hover:bg-accent disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {allMonthsBusy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Layers className="w-3 h-3" aria-hidden="true" />} {t.approveAllMonths}
                  </button>
                </span>
              )}
              {selectMode && (
                <button type="button" onClick={exitSelectMode} disabled={approving}
                  className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground hover:bg-accent disabled:opacity-60">
                  <X className="w-3 h-3" /> {t.cancel}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Selected-day detail (click a date to open) ── */}
      <AnimatePresence initial={false}>
        {!loading && selectedDate && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-3 rounded-xl border border-border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-foreground tabular-nums">{prettyDate(selectedDate)}</div>
                <button type="button" onClick={() => setSelectedDate(null)} aria-label={t.closeWord}
                  className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Status */}
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                {selWorked && <Badge variant="success" className="gap-1"><CheckCircle2 className="w-3 h-3" />{t.workedLegend}</Badge>}
                {selLeave && <Badge variant="brand" className="gap-1"><Palmtree className="w-3 h-3" />{t.leaveLegend}</Badge>}
                {selShift && <Badge variant="default" className="gap-1"><Moon className="w-3 h-3" />Shifts</Badge>}
                {selHoliday && (
                  <Badge variant="brand" className="gap-1">
                    <CalendarOff className="w-3 h-3" />
                    {selHoliday.name}
                    {/* Poya days are usually named "... Poya Day" already; only append when not. */}
                    {selHoliday.kind === 'poya' && !/poya/i.test(selHoliday.name) ? ` · ${t.poyaLabel}` : ''}
                  </Badge>
                )}
                {!selWorked && !selLeave && !selHoliday && selSessions.length === 0 && selSchedule.length === 0 && selTasks.length === 0 && selLeaves.length === 0 && (
                  <span className="text-xs text-muted-foreground">{t.noActivityDay}</span>
                )}
              </div>
              {selHoliday && selWorked && (
                <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-brand">
                  <CalendarOff className="w-3 h-3 flex-shrink-0" />
                  <span>
                    Worked on a holiday{selHolidayMinutes > 0 ? ` — ${fmtHoursShort(selHolidayMinutes)}` : ''}
                    {selHolidayMinutes > 0 ? <span className="text-muted-foreground"> · Extra hours</span> : null}
                  </span>
                </div>
              )}

              {/* Scheduled shift(s) — southernlanka's shift roster, shown regardless of leave/worked
                  status, since a leave day can still have had a shift scheduled against it. */}
              {selSchedule.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                    <Moon className="w-3 h-3 text-brand" /> Shifts
                  </div>
                  {selSchedule.map(sc => (
                    <div key={sc.id} className="flex items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5">
                      <Clock className="w-3.5 h-3.5 text-brand flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-foreground truncate">{sc.shift_name}</div>
                        <div className="text-[10px] text-muted-foreground tabular-nums">{timeRangeOf(sc.start_time, sc.end_time)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Attendance detail — times, working place, outstation, allowances */}
              {selSessions.length > 0 && (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                      <Clock className="w-3 h-3 text-success" /> {t.attendance}
                    </div>
                    {canDelete && selAttRec && (
                      <button type="button"
                        onClick={() => { setDeleteReason(''); setDeleteTarget({ type: 'attendance', id: selAttRec.id, label: `${user?.display_name ?? epf}'s attendance on ${prettyDate(selectedDate!)}` }); }}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-semibold text-destructive transition-colors hover:bg-destructive/10">
                        <Trash2 className="w-3 h-3" /> Delete
                      </button>
                    )}
                  </div>
                  {selSessions.map((s, i) => {
                    // This session's entry in the viewer's queue (null = not theirs to approve).
                    const entry = approvableForSession(
                      approvable.get(selectedDate!) ?? null,
                      { checkIn: localStrOf(s.check_in), checkOut: localStrOf(s.check_out) },
                      selSessions.length,
                    );
                    const sessPending = s.check_in_status === 'pending' || (s.check_out != null && s.check_out_status === 'pending');
                    const map = sessionMap(s);
                    return (
                    <div key={i} className="rounded-lg border border-border bg-muted px-2.5 py-2 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        {selSessions.length > 1 ? (
                          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Session {i + 1}</div>
                        ) : <span />}
                        <div className="flex items-center gap-1">
                          {entry && editingIdx !== i && (
                            <button type="button" onClick={() => approveSessions([entry])} disabled={approving}
                              className="inline-flex items-center gap-1 rounded-md border border-warning/50 bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning transition-colors hover:bg-warning/20 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                              {approving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} {t.approveVerb}
                            </button>
                          )}
                          {canDelete && editingIdx !== i && (
                            <button type="button" onClick={() => startEditSession(i, s)}
                              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground transition-colors hover:text-primary hover:bg-primary/10">
                              <Pencil className="w-3 h-3" /> Edit
                            </button>
                          )}
                        </div>
                      </div>
                      {editingIdx === i ? (
                        <div className="space-y-2">
                          <div className="grid grid-cols-2 gap-2">
                            <label className="text-[10px] text-muted-foreground">
                              Check-in time
                              <input type="time" value={editCheckInTime}
                                onChange={e => setEditCheckInTime(e.target.value)}
                                className="mt-0.5 h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground" />
                            </label>
                            <label className="text-[10px] text-muted-foreground">
                              Check-out time
                              <input type="time" value={editCheckOutTime}
                                onChange={e => setEditCheckOutTime(e.target.value)}
                                className="mt-0.5 h-9 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground" />
                            </label>
                          </div>
                          {selShift && (
                            <div className="space-y-1">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <div onClick={() => setEditCheckOutNextDay(v => !v)}
                                  className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${editCheckOutNextDay ? 'bg-brand border-brand' : 'border-border bg-card'}`}>
                                  {editCheckOutNextDay && <Check className="w-3 h-3 text-primary-foreground" />}
                                </div>
                                <span className="text-[11px] text-foreground flex items-center gap-1.5">
                                  <Moon className="w-3 h-3 text-brand" /> Checkout next day
                                </span>
                              </label>
                              {editCheckOutNextDay && selectedDate && (
                                <p className="text-[10px] text-brand/80 pl-6">
                                  Checkout recorded on {new Date(new Date(selectedDate + 'T00:00:00').getTime() + 86400000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                </p>
                              )}
                            </div>
                          )}
                          <div className="flex items-center gap-2">
                            <Button type="button" size="sm" onClick={() => handleSaveSessionEdit(i)} disabled={savingEdit}>
                              {savingEdit ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save
                            </Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => setEditingIdx(null)} disabled={savingEdit}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                      <>
                      {/* Check-in / Check-out times + approval status */}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                        <span className="inline-flex items-center gap-1 text-foreground">
                          <LogIn className="w-3 h-3 text-success flex-shrink-0" /> {fmtTime(s.check_in)}
                          {s.check_in_status && (
                            <Badge variant={statusTone(s.check_in_status)} className="text-[8px] px-1 py-0">{s.check_in_status}</Badge>
                          )}
                        </span>
                        <span className="inline-flex items-center gap-1 text-foreground">
                          <LogOut className="w-3 h-3 text-primary flex-shrink-0" /> {fmtTime(s.check_out)}
                          {s.check_out != null && s.check_out_status && (
                            <Badge variant={statusTone(s.check_out_status)} className="text-[8px] px-1 py-0">{s.check_out_status}</Badge>
                          )}
                        </span>
                      </div>
                      {/* Pending, but not in this viewer's queue — say so rather than hide the button silently. */}
                      {!entry && sessPending && canTryApprove && approvableStatus === 'ready' && (
                        <div className="text-[10px] italic text-muted-foreground">{t.notYoursToApprove}</div>
                      )}
                      {!entry && sessPending && canTryApprove && approvableStatus === 'tooOld' && (
                        <div className="text-[10px] italic text-muted-foreground">{t.monthTooOldToApprove.replace('{n}', String(PAST_BACKLOG_MAX_MONTHS))}</div>
                      )}
                      {/* Working place(s) — the full multi-location history when one exists */}
                      {(s.locations?.length ?? 0) > 1 ? (
                        <SessionLocations locations={s.locations as unknown as SessionLocationView[]} />
                      ) : s.working_place ? (
                        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <MapPin className="w-3 h-3 flex-shrink-0" />
                          <span className="truncate">{s.working_place}{s.site_number ? ` · ${s.site_number}` : ''}</span>
                        </div>
                      ) : null}
                      {/* Outstation */}
                      {s.is_outstation && (
                        <div className="flex items-start gap-1 text-[11px] text-warning">
                          <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                          <span>Outstation{s.outstation_name ? `: ${s.outstation_name}` : ''}{s.outstation_address ? ` · ${s.outstation_address}` : ''}</span>
                        </div>
                      )}
                      {/* Food allowances */}
                      {(s.morning_allowance || s.evening_allowance) ? (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                          {s.morning_allowance ? (
                            <span className="inline-flex items-center gap-1"><Coffee className="w-2.5 h-2.5" />Morning Cat. {s.morning_allowance}</span>
                          ) : null}
                          {s.evening_allowance ? (
                            <span className="inline-flex items-center gap-1"><Coffee className="w-2.5 h-2.5" />Evening Cat. {s.evening_allowance}</span>
                          ) : null}
                        </div>
                      ) : null}
                      {/* Where the session's GPS put them: check-in → updates → check-out against
                          the matched place's geofence. Pins are told apart by SHAPE (solid in,
                          hollow out) — the design system gives them no distinct hue. */}
                      {map && (() => {
                        const span = sessionSpan(s.check_in, s.check_out);
                        const kinds = new Set(map.trail.map(p => p.kind));
                        return (
                        <div className="overflow-hidden rounded-lg border border-border bg-card">
                          {/* The day in one line: when it started, when (and on which day) it ended, how long. */}
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-2 py-1.5 text-[11px] tabular-nums">
                            <span className="font-semibold text-foreground">{prettyDate(selectedDate!)}</span>
                            <span className="text-muted-foreground">
                              {t.inShort} {fmtTime(s.check_in)} → {span.open ? t.stillOpen : `${t.outShort} ${fmtTime(s.check_out)}${span.nextDay ? ` ${t.nextDayShort}` : ''}`}
                            </span>
                            {span.minutes != null && <span className="font-semibold text-foreground">{fmtDuration(span.minutes)}</span>}
                          </div>
                          <div className="h-40 w-full">
                            <AttendanceMiniMap
                              variant="panel"
                              trail={map.trail}
                              place={map.place}
                              permanentLabels
                              focus={stopFocus && stopFocus.session === i ? { lat: stopFocus.lat, lng: stopFocus.lng } : null}
                              labels={{ checkIn: t.checkIn, checkOut: t.checkOut, place: map.placeName }}
                              className="h-full w-full"
                            />
                          </div>
                          {/* Stops: hovering or tapping one spotlights it on the map. */}
                          <ol aria-label={t.stopsWord} className="divide-y divide-border border-t border-border" onMouseLeave={() => setStopFocus(null)}>
                            {map.trail.map((stop, k) => {
                              const dist = stopDistance(stop, map.place);
                              const outside = !!dist && dist !== t.inRange;
                              const kindLabel = stop.kind === 'checkin' ? t.checkIn : stop.kind === 'checkout' ? t.checkOut : t.updateWord;
                              return (
                                <li key={k}>
                                  <button type="button"
                                    onMouseEnter={() => setStopFocus({ session: i, lat: stop.lat, lng: stop.lng })}
                                    onFocus={() => setStopFocus({ session: i, lat: stop.lat, lng: stop.lng })}
                                    onBlur={() => setStopFocus(null)}
                                    onClick={() => setStopFocus(prev => (prev && prev.session === i && prev.lat === stop.lat && prev.lng === stop.lng ? null : { session: i, lat: stop.lat, lng: stop.lng }))}
                                    className="flex w-full items-center gap-2 px-2 py-1 text-left text-[10px] transition-colors hover:bg-accent focus-visible:outline-none focus-visible:bg-accent">
                                    {stop.kind === 'checkin'
                                      ? <span className="h-2 w-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
                                      : stop.kind === 'checkout'
                                        ? <span className="h-2 w-2 shrink-0 rounded-full border-2 border-primary" aria-hidden="true" />
                                        : <span className="h-2 w-2 shrink-0 rounded-full bg-warning" aria-hidden="true" />}
                                    <span className="w-10 shrink-0 tabular-nums text-foreground">{stop.time || '—'}</span>
                                    <span className="min-w-0 flex-1 truncate text-muted-foreground"><span className="sr-only">{kindLabel} · </span>{stop.name || kindLabel}</span>
                                    {dist && (
                                      <span className={`shrink-0 tabular-nums ${outside ? 'text-warn-strong font-semibold' : 'text-muted-foreground'}`}>
                                        {outside && <AlertTriangle className="mr-0.5 inline h-2.5 w-2.5 align-[-1px]" aria-hidden="true" />}{dist}
                                      </span>
                                    )}
                                  </button>
                                </li>
                              );
                            })}
                          </ol>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-2 py-1 text-[10px] text-muted-foreground">
                            {kinds.has('checkin') && <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />{t.checkIn}</span>}
                            {kinds.has('update') && <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-warning" aria-hidden="true" />{t.updateWord}</span>}
                            {kinds.has('checkout') && <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full border-2 border-primary" aria-hidden="true" />{t.checkOut}</span>}
                            {map.place && <span className="inline-flex items-center gap-1"><MapPin className="w-2.5 h-2.5" aria-hidden="true" />{map.placeName}</span>}
                            {s.check_out_within_radius === false && (
                              <span className="inline-flex items-center gap-1 text-warning"><AlertTriangle className="w-2.5 h-2.5" aria-hidden="true" />{t.apIssueOutside}</span>
                            )}
                          </div>
                        </div>
                        );
                      })()}
                      </>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}

              {/* Tasks on this day */}
              {!isSouthernlanka && selTasks.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground"><ListChecks className="w-3 h-3 text-primary" />{t.tasksWord}</div>
                  {selTasks.map(tk => (
                    <div key={tk.id} className="flex items-start gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5">
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-foreground truncate">{tk.description}</div>
                        {typeof tk.hours === 'number' && tk.hours > 0 && (
                          <div className="text-[10px] text-muted-foreground flex items-center gap-0.5 mt-0.5"><Clock className="w-2.5 h-2.5" />{tk.hours}h</div>
                        )}
                      </div>
                      <Badge variant={statusTone(tk.status)} className="text-[9px] flex-shrink-0">{tk.status}</Badge>
                    </div>
                  ))}
                </div>
              )}

              {/* Leaves on this day */}
              {selLeaves.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground"><Palmtree className="w-3 h-3 text-brand" />{t.leaves}</div>
                  {selLeaves.map(lv => (
                    <div key={lv.id ?? lv.leave_id} className="flex items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5">
                      <CalendarDays className="w-3.5 h-3.5 text-brand flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-foreground truncate">{lv.leave_type_name ?? '—'}{lv.is_half_day ? ` · ${t.halfDay}` : ''}</div>
                        <div className="text-[10px] text-muted-foreground tabular-nums">{fmtRange(lv.from_date, lv.to_date)}</div>
                        {approverName(lv.considered_by) && (
                          <div className="text-[10px] text-muted-foreground truncate">
                            {lv.status?.toLowerCase() === 'rejected' ? 'Rejected' : 'Approved'} by: <span className="text-foreground font-medium">{approverName(lv.considered_by)}</span>
                          </div>
                        )}
                      </div>
                      <Badge variant={statusTone(lv.status)} className="text-[9px] flex-shrink-0">{lv.status}</Badge>
                      {canDelete && (lv.id ?? lv.leave_id) != null && (
                        <button type="button"
                          aria-label="Delete leave"
                          onClick={() => { setDeleteReason(''); setDeleteTarget({ type: 'leave', id: String(lv.id ?? lv.leave_id), label: `${user?.display_name ?? epf}'s ${lv.leave_type_name ?? 'leave'} (${fmtRange(lv.from_date, lv.to_date)})` }); }}
                          className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground transition-colors hover:text-destructive hover:bg-destructive/10 flex-shrink-0">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Summary chips — southernlanka gets its Working Days/Leaves counts from the day-detail
          card above (shift + leave info per clicked date) instead, so this whole row is hidden. */}
      {!loading && !isSouthernlanka && (
        <div className={`grid gap-2 mt-3 grid-cols-3 ${holidaysWorked.length > 0 ? 'sm:grid-cols-6' : 'sm:grid-cols-5'}`}>
          {/* The month's total first — it is the figure people scroll here for; the counts that
              explain it follow. */}
          <div className="rounded-lg border border-border bg-card px-2.5 py-2 text-center">
            <div className="text-base font-bold text-foreground tabular-nums">{fmtHoursShort(monthMinutes)}</div>
            <div className="text-[10px] text-muted-foreground">{t.loggedHoursLabel}</div>
          </div>
          <div className="rounded-lg border border-border bg-card px-2.5 py-2 text-center">
            <div className="text-base font-bold text-foreground tabular-nums">
              {daysWithHours > 0 ? fmtHoursShort(Math.round(monthMinutes / daysWithHours)) : '—'}
            </div>
            <div className="text-[10px] text-muted-foreground">{t.avgPerDayLabel}</div>
          </div>
          <div className="rounded-lg border border-border bg-card px-2.5 py-2 text-center">
            <div className="text-base font-bold text-success tabular-nums">{workingDaysCount}</div>
            <div className="text-[10px] text-muted-foreground">{t.workingDays}</div>
          </div>
          <div className="rounded-lg border border-border bg-card px-2.5 py-2 text-center">
            <div className="text-base font-bold text-brand tabular-nums">{leaves.length}</div>
            <div className="text-[10px] text-muted-foreground">{t.leaves}</div>
          </div>
          <div className="rounded-lg border border-border bg-card px-2.5 py-2 text-center">
            <div className="text-base font-bold text-primary tabular-nums">{tasks.length}</div>
            <div className="text-[10px] text-muted-foreground">{t.tasksWord}</div>
          </div>
          {holidaysWorked.length > 0 && (
            <div className="rounded-lg border border-dashed border-brand/60 bg-card px-2.5 py-2 text-center">
              <div className="text-base font-bold text-brand tabular-nums">{holidaysWorked.length}</div>
              <div className="text-[10px] text-muted-foreground">Holidays worked</div>
            </div>
          )}
        </div>
      )}

      {/* Tasks list */}
      {!loading && !isSouthernlanka && (
        <div className="mt-4">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground mb-2">
            <ListChecks className="w-3.5 h-3.5 text-primary" /> {t.tasksWord}
          </div>
          {tasks.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">{t.noTasksMonth}</p>
          ) : (
            <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
              {tasks.slice(0, 30).map((tk) => (
                <div key={tk.id} className="flex items-start gap-2 rounded-lg border border-border bg-muted px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-foreground truncate">{tk.description}</div>
                    <div className="text-[10px] text-muted-foreground flex items-center gap-2 mt-0.5">
                      <span className="tabular-nums">{tk.date}</span>
                      {typeof tk.hours === 'number' && tk.hours > 0 && (
                        <span className="flex items-center gap-0.5"><Clock className="w-2.5 h-2.5" />{tk.hours}h</span>
                      )}
                    </div>
                  </div>
                  <Badge variant={statusTone(tk.status)} className="text-[9px] flex-shrink-0">{tk.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Leaves list — southernlanka sees leave info per-date in the day-detail card instead. */}
      {!loading && !isSouthernlanka && (
        <div className="mt-4 pb-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground mb-2">
            <Palmtree className="w-3.5 h-3.5 text-brand" /> {t.leaves}
          </div>
          {leaves.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">{t.noLeavesMonth}</p>
          ) : (
            <div className="space-y-1.5">
              {leaves.map((lv) => (
                <div key={lv.id ?? lv.leave_id} className="flex items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-2">
                  <CalendarDays className="w-3.5 h-3.5 text-brand flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-foreground truncate">{lv.leave_type_name ?? '—'}{lv.is_half_day ? ` · ${t.halfDay}` : ''}</div>
                    <div className="text-[10px] text-muted-foreground tabular-nums">{fmtRange(lv.from_date, lv.to_date)}</div>
                    {approverName(lv.considered_by) && (
                      <div className="text-[10px] text-muted-foreground truncate">
                        {lv.status?.toLowerCase() === 'rejected' ? 'Rejected' : 'Approved'} by: <span className="text-foreground font-medium">{approverName(lv.considered_by)}</span>
                      </div>
                    )}
                  </div>
                  <Badge variant={statusTone(lv.status)} className="text-[9px] flex-shrink-0">{lv.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Bulk approve bar: sticks to the bottom while days are being picked ── */}
      {selectMode && (
        <div role="group" aria-label={t.approveVerb} className="sticky bottom-2 z-10 mt-3 flex items-center justify-between gap-2 rounded-xl border border-warning/50 bg-card px-3 py-2 shadow-popover">
          <span aria-live="polite" className="text-xs font-semibold text-foreground tabular-nums">
            {t.selectedCount.replace('{n}', String(selectedDays.size))}
          </span>
          <div className="flex items-center gap-1.5">
            <Button type="button" size="sm" variant="ghost" onClick={exitSelectMode} disabled={approving}>
              {t.cancel}
            </Button>
            <Button type="button" size="sm" onClick={approveSelectedDays} disabled={approving || selectedDays.size === 0}>
              {approving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} {t.approveVerb}
            </Button>
          </div>
        </div>
      )}

      {/* ── "All months…" confirmation ── */}
      <ConfirmModal
        open={!!allMonthsConfirm}
        onOpenChange={o => { if (!o) setAllMonthsConfirm(null); }}
        onConfirm={confirmApproveAllMonths}
        variant="warning"
        busy={approving}
        title={t.approveVerb}
        confirmText={t.approveVerb}
        cancelText={t.cancel}
        description={allMonthsConfirm ? t.approveAllMonthsConfirm
          .replace('{n}', String(allMonthsConfirm.entries.length))
          .replace('{k}', String(allMonthsConfirm.months))
          .replace('{name}', user?.display_name ?? String(epf)) : ''}
      />

      {/* ── Soft-delete confirmation (system admin) ── Portalled to <body>: a `fixed inset-0`
          overlay nested inside PageTransition (whose enter animation leaves an active
          transform in place) gets its containing block hijacked to PageTransition's own box
          instead of the viewport. */}
      <Portal>
      <AnimatePresence>
        {deleteTarget && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => !deleting && setDeleteTarget(null)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 10 }}
              onClick={e => e.stopPropagation()}
              className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-popover">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-destructive/10">
                <Trash2 className="h-5 w-5 text-destructive" />
              </div>
              <h3 className="text-center text-base font-bold text-foreground">Delete {deleteTarget.type}?</h3>
              <p className="mt-1 text-center text-xs text-muted-foreground break-words">{deleteTarget.label}</p>
              <p className="mt-1 text-center text-[11px] text-muted-foreground">
                It won&apos;t be erased — it&apos;s marked deleted (kept for audit) and hidden from views.
              </p>
              <label className="mt-4 mb-1.5 block text-xs font-semibold text-muted-foreground">Reason <span className="text-destructive">*</span></label>
              <Textarea
                value={deleteReason}
                onChange={e => setDeleteReason(e.target.value)}
                rows={3}
                autoFocus
                placeholder="Why is this record being deleted?"
                className="resize-none"
              />
              <div className="mt-4 flex gap-3">
                <Button variant="outline" className="flex-1" onClick={() => setDeleteTarget(null)} disabled={deleting}>
                  {t.cancel ?? 'Cancel'}
                </Button>
                <Button variant="destructive" className="flex-1" onClick={handleConfirmDelete} disabled={deleting || !deleteReason.trim()}>
                  {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  {t.deleteWord ?? 'Delete'}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </Portal>
    </div>
  );
}
