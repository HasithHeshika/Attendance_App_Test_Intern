'use client';
import { useEffect, useState, useRef, useCallback, useMemo, type RefObject } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Portal from '@/components/Portal';
import {
  MapPin, Clock, CalendarDays,
  Loader2, Check, AlertCircle, CalendarOff, Palmtree,
  ShieldCheck, ShieldAlert, Edit2, X, UserX, MessageSquare, Moon, Crosshair, AlertTriangle,
  UtensilsCrossed, CornerDownLeft
} from 'lucide-react';
import {
  DayPicker, useDayRender, Button as DayButton,
  type DayContentProps, type DayProps,
} from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { useAuthStore } from '@/store/authStore';
import { patternExpectation, localDateKey, type WorkPattern } from '@/lib/workPatterns';
import { getWorkPatterns } from '@/services/workPatternService';
import { getLatestSchedule } from '@/services/workingScheduleService';
import { getScheduleAssignmentsForEmployee } from '@/services/scheduleAssignmentService';
import { mergeShiftBlocks } from '@/lib/attendanceShortfallEngine';
import { useRoles, useUserCapabilities } from '@/store/rolesStore';
import { categoryAllowed, roleCategory } from '@/lib/permissions';
import { useT } from '@/store/appStore';
import { _attendanceApi as attendanceApi, _leaveApi as leaveApi, attendanceApi as attendanceApiRT } from '@/services/apiCompat';
import { tenant } from '@/lib/firebase';
import TodayCheckInOut from '@/components/TodayCheckInOut';
import { invalidateDanglingCheckout } from '@/components/useDanglingCheckout';
import { Skeleton } from '@/components/ui/Skeleton';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageTransition, Reveal, Stagger, StaggerItem } from '@/components/ui/motion';
import { formatTime, formatDate, localDateString } from '@/lib/utils';
import SmartWorkingPlaceSelect from '@/components/SmartWorkingPlaceSelect';
import SessionLocations from '@/components/SessionLocations';
import CallButton from '@/components/CallButton';
import { useWorkingPlaces } from '@/store/workingPlacesStore';
import { getHolidaySettings } from '@/services/holidayService';
import { listAllChamaries, type ChamaryWithPlace } from '@/services/workingPlaceService';
import { requestMeal, cancelMeal, getMyMealsForDate, getChamaryOffdaysForDay } from '@/services/mealService';
import { chamaryMeals, mealOf, type MealType } from '@/lib/meals';
import type { LunchRequest, ChamaryMealOffday, ScheduleAssignment } from '@/lib/types';
import { mapsLink } from '@/lib/geo';
import UpdateSessionLocation from '@/components/UpdateSessionLocation';
import OutstationBadge from '@/components/OutstationBadge';
// ── The calendar's own model and marks ────────────────────────────────────────
// The hardcoded work pattern (Mon–Fri 8h, Sat 4h, Sun rest) now lives in ONE pure module,
// `workDayModel.ts`, rather than being spread through this page. Everything that depends on it
// — the day gauge, the "short day" flag, the month fold — is derived from `expectedHours()`
// there, so the `work_patterns` migration described in
// docs/superpowers/specs/2026-09-01-working-patterns-and-holiday-work-design.md is a change to
// one function instead of a hunt through this file.
import {
  dayMark, markNotes, dayKey, isSameDay, isSameMonth, hoursCaption, summariseMonth,
  type DayMark,
} from '@/components/attendance/workDayModel';
import {
  Gauge, RING_R,
  LEAVE_TINT, LEAVE_RIM, LEAVE_INK, HOLIDAY_TINT, HOLIDAY_RIM, HOLIDAY_INK, EDIT_RING_COLORS,
} from '@/components/attendance/dayMarks';
import { CalendarLegend } from '@/components/attendance/CalendarLegend';
import { MonthSummary } from '@/components/attendance/MonthSummary';
import { SelectedDayCard } from '@/components/attendance/SelectedDayCard';
import toast from 'react-hot-toast';

// A Firebase rejection carries `.code` — 'permission-denied', 'unavailable',
// 'failed-precondition', 'unauthenticated' — and that one token is what separates an outage
// from a rules problem from a bad index. Worth showing the user: a support message quoting the
// code is a diagnosis, where "it didn't load" is a guessing game. Non-Firebase throws (a plain
// Error, a string) have no code and simply show none.
function firebaseErrorCode(reason: unknown): string | null {
  const code = (reason as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function monthLabel(month: number, year: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

// Day cell content: the date number and this day's hours gauge around it. The missing-checkout
// warning used to live here too, as a badge pinned to the digit's corner — but `.rdp-day` (the
// day button itself, see node_modules/react-day-picker/dist/style.css) is a 36px circle with
// `overflow: hidden`, and there is no offset that lands a legible badge both clear of the digit
// and inside that circle at once: pull it out far enough to miss the glyph and the round clip
// cuts it instead, pull it in far enough to survive the clip and it sits back on the glyph. The
// warning now renders in CalendarDayCell's figure line below the button — see that comment for
// why that's already where this class of problem gets solved in this file.
function CalendarDayContent(props: DayContentProps & {
  mark?: DayMark;
  srNote?: string;
  // Passed down rather than read from useT() because this component sits outside the page.
  labels?: { companyHoliday: string };
}) {
  const mods = props.activeModifiers as Record<string, boolean>;
  const companyHoliday = mods.companyHoliday;   // a day the company observes as a holiday
  const mark           = props.mark;
  return (
    <span className="relative inline-flex h-4 w-4 items-center justify-center leading-none">
      {props.date.getDate()}
      {props.srNote && <span className="sr-only">, {props.srNote}</span>}
      {mark && mark.kind !== 'none' && (
        // Decorative: everything it shows is also in srNote and in the hover tooltip.
        <svg
          viewBox="0 0 32 32"
          aria-hidden="true"
          focusable="false"
          className="pointer-events-none absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2"
        >
          <Gauge mark={mark} r={RING_R} scale={1} />
        </svg>
      )}
      {companyHoliday && (
        // A small solid brand dot centred just below the date number. Was a tiny CalendarOff
        // glyph in a 14px corner badge — at that size the icon rendered muddy and its
        // top-left offset clipped against the cell edge / overlapped the coloured day circle.
        // A filled dot stays crisp at any DPI and can't collide with the digit; the calendar
        // legend still carries the labelled icon.
        <span
          aria-label={props.labels?.companyHoliday ?? 'Company holiday'}
          title={props.labels?.companyHoliday ?? 'Company holiday'}
          className="pointer-events-none absolute left-1/2 -bottom-1.5 z-10 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-brand ring-1 ring-white/80 dark:ring-black/40"
        />
      )}
    </span>
  );
}

function todayString(): string { return localDateString(); }

// Pure calendar-day arithmetic on a "YYYY-MM-DD" string — same idiom as the attendance-view
// admin page's own copy (kept separate: each page owns its date helpers, no shared module).
function shiftDateStr(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// "" when `dateTimeStr`'s own date (its first 10 chars — apiCompat.ts's tsToStr always shapes
// sessions this way) matches `referenceDateStr`, else " (+1d)" / " (+2d)" etc. A checkout within
// the 36h cross-day lookback (see CHECKOUT_LOOKBACK_HOURS in shiftAutoClose.ts) can genuinely
// land a day or two after its own check-in — the existing "Overnight" badge says THAT happened,
// this says by how much, the same distinction the Attendance View admin page's PunchLabel makes.
function dayOffsetLabelFromStr(dateTimeStr: string | null | undefined, referenceDateStr: string): string {
  if (!dateTimeStr || !referenceDateStr) return '';
  const datePart = dateTimeStr.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return '';
  const offset = Math.round((Date.parse(datePart) - Date.parse(referenceDateStr)) / 86_400_000);
  return offset === 0 ? '' : ` (${offset > 0 ? '+' : ''}${offset}d)`;
}

function toLocalTime24h(s: string | null | undefined): string {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) {
    const match = s.trim().match(/^(\d{1,2}):(\d{2})/);
    if (match) {
      return `${match[1].padStart(2, '0')}:${match[2]}`;
    }
    return '';
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


interface AttendanceData {
  attendance_id?: number;
  epf_number?: string;
  date?: string;
  check_in?: string | null;
  check_out?: string | null;
  check_in_approved_by?: string | null;
  check_out_approved_by?: string | null;
  working_place?: string | null;
  site_number?: string | null;
  is_outstation?: boolean | null;
  outstation_name?: string | null;
  outstation_address?: string | null;
}

interface LeaveCheckResult { can_mark_attendance: boolean; is_half_day?: boolean; half_day_period?: string | null; message?: string; }

// ─── Leave Day Banner ─────────────────────────────────────────────────────────
function LeaveDayBanner({ t }: { t: Record<string, string> }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl p-8 border border-brand/20 bg-brand/5 flex flex-col items-center text-center gap-4"
    >
      <div className="w-16 h-16 rounded-xl bg-brand/15 border border-brand/20 flex items-center justify-center">
        <Palmtree className="w-8 h-8 text-brand" />
      </div>
      <div>
        <h2 className="text-xl font-bold text-foreground mb-1">{t.onLeaveToday}</h2>
        <p className="text-muted-foreground text-sm max-w-xs">
          {t.onLeaveTodayDesc}
        </p>
      </div>
      <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-brand/10 border border-brand/20">
        <CalendarOff className="w-4 h-4 text-brand" />
        <span className="text-sm font-semibold text-brand">
          {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">If this is incorrect, please contact your HR administrator.</p>
    </motion.div>
  );
}

function HalfDayLeaveBanner({ period }: { period?: string | null }) {
  const label = period === 'morning' ? 'Morning' : period === 'afternoon' ? 'Afternoon' : null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl px-4 py-3 border border-warning/20 bg-warning/5 flex items-center gap-3"
    >
      <div className="w-8 h-8 rounded-xl bg-warning/15 border border-warning/20 flex items-center justify-center flex-shrink-0">
        <Palmtree className="w-4 h-4 text-warning" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-warning">Half-Day Leave Today</p>
        {label && (
          <p className="text-xs text-muted-foreground mt-0.5">
            {label} off — you can still mark attendance for the {period === 'morning' ? 'afternoon' : 'morning'}.
          </p>
        )}
      </div>
    </motion.div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
// Shift places run two very different patterns off the same check-in time: a same-day
// shift (e.g. 6am → 6pm, ~12h) and an overnight one (e.g. 6am → 6-8am next day, ~24-26h —
// the checkout can run a bit late, so it's not exactly 24h). A plain "checkout clock-time
// <= check-in clock-time" test (used elsewhere for live check-out) misidentifies the
// overnight case whenever the checkout lands an hour or two AFTER the check-in time-of-day
// (e.g. 6am → 7am is read as a 1h same-day stub instead of a 25h overnight shift). Since a
// same-day shift is always many hours long and a "wrapped" overnight checkout is always
// only a short same-day gap, a minimum-duration threshold disambiguates the two without
// needing the requester to pick a date.
const MIN_SAME_DAY_SHIFT_HOURS = 6;
function shiftRunsOvernight(checkInHHMM: string, checkOutHHMM: string): boolean {
  const [inH, inM]   = checkInHHMM.split(':').map(Number);
  const [outH, outM] = checkOutHHMM.split(':').map(Number);
  if ([inH, inM, outH, outM].some(n => Number.isNaN(n))) return false;
  const sameDayHours = (outH * 60 + outM - (inH * 60 + inM)) / 60;
  return sameDayHours < MIN_SAME_DAY_SHIFT_HOURS;
}

// The day's actual scheduled shift(s) — Southern Lanka only (dayScheduledShifts is always []
// elsewhere). Same visual language as the pre-existing shift-allocation banner (brand-tinted
// pill with an icon), shown across the worked-day view AND the no-record/edit-request forms —
// knowing what was scheduled is exactly the context someone needs while requesting a
// correction, not just after the fact.
function ScheduledShiftsBanner({ shifts, label }: { shifts: ScheduleAssignment[]; label: string }) {
  if (shifts.length === 0) return null;
  return (
    <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-brand/10 border border-brand/20">
      <Clock className="w-4 h-4 text-brand flex-shrink-0 mt-0.5" />
      <div className="text-xs text-foreground min-w-0">
        <span className="font-semibold text-brand">{label}</span>
        <span className="text-muted-foreground ml-1">
          {shifts.map(s => `${s.shift_name} (${s.start_time || '—'}–${s.end_time || '—'})`).join(' + ')}
        </span>
      </div>
    </div>
  );
}

// Live wall-clock for the attendance hero — ticks every second.
function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const p = (n: number) => String(n).padStart(2, '0');
  return <span className="font-mono tabular-nums">{p(now.getHours())}:{p(now.getMinutes())}:{p(now.getSeconds())}</span>;
}

export default function AttendancePage() {
  const { user } = useAuthStore();
  // The signed-in person's configured week. Empty until loaded, and empty is not a problem:
  // patternExpectation([]) IS the built-in Mon-Fri 8h / Sat 4h week, so the calendar renders
  // identically before, during and after the fetch for anyone with no pattern configured.
  const [workPatterns, setWorkPatterns] = useState<WorkPattern[]>([]);
  const [myPlace, setMyPlace] = useState<string | null>(null);
  // Roster hours per date ('yyyy-MM-dd' -> hours), for a shift-scoped work pattern
  // (WorkPattern.is_shift) — a shift worker has no fixed weekday shape, so expectedHoursFor()
  // needs THIS instead of `days`. Same source (schedule_assignments) and same merge rule
  // (mergeShiftBlocks — contiguous shifts merge, non-contiguous ones don't) that payroll's own
  // "Sync from Attendance" already uses, so a shift day's expectation here always matches what
  // payroll derives for the same day. Empty for anyone with no schedule_assignments at all —
  // harmless, since expectedHoursFor only consults this when the resolved pattern is_shift.
  const [shiftHoursByDate, setShiftHoursByDate] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [pats, sched, assignments] = await Promise.all([
          getWorkPatterns(),
          // Location-scoped patterns key on the place NAME, which is what a working schedule
          // stores. Best-effort: without it a location pattern simply does not apply, and the
          // person falls back to their company pattern rather than to nothing.
          user?.epf_number ? getLatestSchedule(user.epf_number) : Promise.resolve(null),
          user?.epf_number ? getScheduleAssignmentsForEmployee(user.epf_number) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setWorkPatterns(pats);
        setMyPlace(sched?.working_place ?? null);

        const byDate = new Map<string, ScheduleAssignment[]>();
        for (const a of assignments) {
          const list = byDate.get(a.date) ?? [];
          list.push(a);
          byDate.set(a.date, list);
        }
        const hoursByDate = new Map<string, number>();
        for (const [date, dayAssignments] of byDate) {
          const blocks = mergeShiftBlocks(dayAssignments);
          hoursByDate.set(date, blocks.reduce((s, b) => s + (b.scheduledEndMin - b.scheduledStartMin) / 60, 0));
        }
        setShiftHoursByDate(hoursByDate);
      } catch (e) {
        // A failed fetch leaves the built-in week in place. The calendar must never be blank
        // because a configuration collection could not be read.
        console.warn('[attendance] work patterns unavailable; using the built-in week.', e);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.epf_number]);

  const workExpectation = useMemo(
    () => patternExpectation(workPatterns, {
      company_id: user?.company_id ?? null,
      role: user?.role ?? null,
      working_place: myPlace,
    }, date => shiftHoursByDate.get(localDateKey(date)) ?? null),
    [workPatterns, user?.company_id, user?.role, myPlace, shiftHoursByDate],
  );
  const caps = useUserCapabilities();
  const { roles } = useRoles();
  const myCategory = roleCategory(user?.role, roles);
  const t = useT();
  const { requiresSite, placeHasTag } = useWorkingPlaces();
  const isExec = caps.can_approve;
  const isTrainee = user?.employee_type?.toLowerCase() === 'trainee';
  // Southern Lanka records attendance ONLY via fingerprint terminals + mobile clock-ins —
  // there is no manual "create a past attendance" form for this tenant. A day with no record
  // instead opens a read-only summary whose only action is "Request Attendance Edit".
  const isSouthernlanka = tenant.id === 'southernlanka';

  const [attendance, setAttendance] = useState<AttendanceData | null>(null);
  const [leaveCheck, setLeaveCheck] = useState<LeaveCheckResult | null>(null);

  const [loading, setLoading] = useState(true);
  const [highlightedDays, setHighlightedDays] = useState<Date[]>([]);
  const [workedDays, setWorkedDays] = useState<Date[]>([]);
  // Hours worked per 'YYYY-MM-DD', from the same monthly payload as workedDays — drives the
  // progress ring drawn around each worked day's number.
  const [workedHours, setWorkedHours] = useState<Record<string, number>>({});
  // Worked days where a session was checked in but never checked out → warning icon.
  const [missingCheckoutDays, setMissingCheckoutDays] = useState<Date[]>([]);
  // Always initialise calendar to today's month so it never shows a stale month
  const [calendarMonth, setCalendarMonth] = useState<Date>(new Date());
  const [calendarLoading, setCalendarLoading] = useState(false);
  // The monthly attendance read is one batch of doc reads, so a single failure (offline,
  // permission-denied) rejects the whole batch and used to blank the month silently — a failed
  // load and a month with no attendance looked identical. Surfaced instead, with a retry.
  const [calendarError, setCalendarError] = useState(false);
  // The rejection's Firebase code, shown beside the banner sentence. Null when the throw
  // carried none — the banner then reads exactly as it did before.
  const [calendarErrorCode, setCalendarErrorCode] = useState<string | null>(null);
  // Same treatment for TODAY's read. A rejection there left `attendance` null, which renders
  // exactly like a day nobody has marked yet — so an outage told a checked-in employee they
  // were not checked in. Now it says so, with the Firebase code and a retry.
  const [todayError, setTodayError] = useState(false);
  const [todayErrorCode, setTodayErrorCode] = useState<string | null>(null);
  // Colour key: collapsed by default so the calendar keeps the card.
  const [legendOpen, setLegendOpen] = useState(false);
  const [holidayDays, setHolidayDays] = useState<Date[]>([]);
  const [holidayNames, setHolidayNames] = useState<Record<string, string>>({});
  // Cache fetched years so we never hit the API twice for the same year
  const holidayCache = useRef<Set<number>>(new Set());
  // Company-accepted holidays (the org's curated list from holiday_settings) — shown on the
  // calendar with a distinct "company holiday" badge. Names come from custom entries; public
  // ones fall back to the API holiday names.
  const [companyHolidayDays, setCompanyHolidayDays]   = useState<Date[]>([]);
  const [companyHolidayNames, setCompanyHolidayNames] = useState<Record<string, string>>({});
  const companyHolidayCache = useRef<Set<number>>(new Set());

  // Day Details Modal
  const [holidayTooltip, setHolidayTooltip] = useState<{ name: string; x: number; y: number } | null>(null);
  const [showDayModal, setShowDayModal] = useState(false);
  const [dayModalMode, setDayModalMode] = useState<'view' | 'submitPast' | 'editRequest' | 'updateLocation' | 'noRecord'>('view');
  const [dayModalLoading, setDayModalLoading] = useState(false);
  const [dayModalData, setDayModalData] = useState<AttendanceData | null>(null);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  // A checkout within the 36h cross-day lookback is written back into the CHECK-IN day's own
  // document, not this one's — so a day with no record of its own (the 'noRecord' mode below)
  // can still be the day a PREVIOUS day's session actually closed on. Populated by the calendar
  // click handler; null whenever there's nothing to show.
  const [dayModalSpillover, setDayModalSpillover] = useState<{ time: string; fromDate: string } | null>(null);
  // The calendar day whose summary is shown under the grid. Set by a CLICK ONLY — hover used to
  // set it too, which meant a pointer crossing the calendar silently swapped the page's
  // check-in control for a read-only summary. Everything it needs — hours, leave, holiday, edit
  // state — is already in this page's month state, so picking a day costs no read at all.
  // There is no separate "pinned" flag now that hover cannot set it: every pick is deliberate.
  const [previewDay, setPreviewDay] = useState<Date | null>(null);

  // Day-modal edit request form (for past-date attendance records). When the picked working
  // place is a shift place, the check-out date is always the day after check-in — never
  // user-entered — and is just shown as a badge next to the check-out time (see dayShiftCheckoutDate).
  const [dayEditForm, setDayEditForm] = useState({
    check_in: '', check_out: '', working_place: '', site_number: '',
    is_outstation: false, outstation_name: '', outstation_address: '', reason: '',
  });

  // Past Attendance Form
  const [pastAttForm, setPastAttForm] = useState({
    check_in: '', check_out: '', working_place: '', site_number: '',
    is_outstation: false, outstation_name: '', outstation_address: '', overnight: false,
  });
  const [pastAttLoading, setPastAttLoading] = useState(false);
  // Extra locations stashed for a past submission ("Add another location") — the picker's
  // current value joins these on submit; the first entry becomes the primary working place.
  const [pastLocs, setPastLocs] = useState<{ name: string; site_number: string }[]>([]);

  const [editReqLoading, setEditReqLoading] = useState(false);
  // Which session an edit request targets (multi-session days)
  const [dayEditSessionId, setDayEditSessionId] = useState<string>('');
  // Which session the day modal's "Update location" form (shared component) targets.
  const [locSessionId, setLocSessionId] = useState<string | null>(null);

  // Day-modal meal booking (suspense/food module): every active chamary, the meals it has
  // marked off for the selected date, and this user's own bookings that day.
  const [dayChamaries, setDayChamaries] = useState<ChamaryWithPlace[]>([]);
  const [dayOffdays,   setDayOffdays]   = useState<ChamaryMealOffday[]>([]);
  const [dayMeals,     setDayMeals]     = useState<LunchRequest[]>([]);
  const [dayMealsLoading, setDayMealsLoading] = useState(false);
  // `${chamary_id}__${meal}` of the booking currently being written — disables just that button.
  const [dayMealBusy, setDayMealBusy] = useState('');
  // Shift allocations for the signed-in user (lazy-loaded for shift workers) — drives
  // the day modal's shift banner / overnight context.
  const [myShifts, setMyShifts] = useState<{ from_date: string; to_date: string }[]>([]);
  // Southern Lanka's REAL per-day scheduled shift(s) — shift name + start/end time, the same
  // ScheduleAssignment data /my-schedule reads (schedule_assignments). Distinct from myShifts
  // above (a different, legacy shift_assignments date-RANGE allocation used by other tenants).
  // Lazy-loaded once, same pattern as myShifts, so a day's modal can show what was actually
  // scheduled next to what was actually punched.
  const [myScheduleAssignments, setMyScheduleAssignments] = useState<ScheduleAssignment[]>([]);
  const [myEditRequests, setMyEditRequests] = useState<{
    id: string; attendance_id?: number; session_id?: string | null; date?: string;
    status: string; reason: string;
    reject_reason?: string; created_at: string;
    requested: { check_in?: string; check_out?: string; working_place?: string; site_number?: string };
  }[]>([]);
  // The pending edit request currently being amended (null = creating a brand-new request).
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);

  const [absentees, setAbsentees] = useState<{ name: string; epf_number: string; office_phonenumber?: string | null; personal_phonenumber?: string | null }[]>([]);
  const [absenteesLoading, setAbsenteesLoading] = useState(false);
  // Only an immediate supervisor (someone with direct reports) sees the Missing Attendance card.
  const [isImmediateSupervisor, setIsImmediateSupervisor] = useState(false);
  const [selectedAbsentees, setSelectedAbsentees] = useState<Set<string>>(new Set());
  const [showBulkMsgModal, setShowBulkMsgModal] = useState(false);

  // Dates used as the outstation-reference day for the past / edit-request forms.
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const selectedDayStr = useMemo(
    () => selectedDay ? `${selectedDay.getFullYear()}-${pad2(selectedDay.getMonth() + 1)}-${pad2(selectedDay.getDate())}` : '',
    [selectedDay],
  );

  // Dates that have edit requests — split by status for calendar badge colours
  const editRequestDates = useMemo(() => {
    const toDate = (r: typeof myEditRequests[0]) => {
      // raw can be a string, null, undefined, or a Firestore-like object — guard all
      const rawVal = r.date ?? r.requested?.check_in ?? r.attendance_id ?? '';
      const raw = typeof rawVal === 'string' ? rawVal : String(rawVal ?? '');
      if (!raw) return null;
      // Handle "YYYY-MM-DD HH:MM:SS", "YYYY-MM-DDTHH:MM:SS", and "YYYY-MM-DD"
      const dateStr = raw.split('T')[0].split(' ')[0];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
      const [y, m, d] = dateStr.split('-').map(Number);
      return new Date(y, m - 1, d);
    };
    const pending: Date[] = [];
    const approved: Date[] = [];
    const rejected: Date[] = [];
    myEditRequests.forEach(r => {
      const dt = toDate(r);
      if (!dt) return;
      if (r.status === 'pending') pending.push(dt);
      else if (r.status === 'approved') approved.push(dt);
      else rejected.push(dt);
    });
    return { pending, approved, rejected };
  }, [myEditRequests]);

  // ── Month summary ───────────────────────────────────────────────────────────────────────
  // A pure fold over state the calendar already holds — no network call. It lives in
  // workDayModel.summariseMonth() with expectedHours(), because "extra hours" and "short days"
  // are the two figures that move when the hardcoded work pattern is replaced.
  const monthStats = useMemo(
    () => summariseMonth({
      month: calendarMonth,
      workedDays,
      workedHours,
      leaveDays: highlightedDays,
      holidayDays,
      companyHolidayDays,
      missingCheckoutDays,
    }, workExpectation),
    [calendarMonth, workedDays, workedHours, highlightedDays, holidayDays, companyHolidayDays, missingCheckoutDays, workExpectation],
  );

  // Whether the selected day is strictly in the past (drives "add session" on past days).
  const selectedDayIsPast = useMemo(() => {
    if (!selectedDay) return false;
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const d0 = new Date(selectedDay); d0.setHours(0, 0, 0, 0);
    return d0 < t0;
  }, [selectedDay]);

  // The pending edit request (if any) that targets a SPECIFIC session of the selected day.
  // Blocking is per-session: a pending request on one session never blocks another session.
  const pendingEditForSession = useCallback((sess: { id?: string | null } | null) => {
    if (!selectedDay) return null;
    const ds = selectedDayStr;
    const sameDay = (r: typeof myEditRequests[number]) =>
      r.date === ds ||
      (typeof r.requested?.check_in === 'string' ? r.requested.check_in : '').replace('T', ' ').startsWith(ds) ||
      (dayModalData?.attendance_id != null && r.attendance_id === dayModalData.attendance_id);
    // Normalise both sides to 's0' — the id sessionsOf() gives a legacy single-session record and
    // that _resolveTarget() falls back to when the submit sends no session id. Without this, a
    // session carrying no `id` matches as null here but was STORED as 's0', so its own pending
    // request never matched: the modal offered "request an edit" again and stacked a duplicate.
    const norm = (v?: string | null) => v ?? 's0';
    const sid = norm(sess?.id);
    return myEditRequests.find(r =>
      r.status === 'pending' && sameDay(r) && norm(r.session_id) === sid
    ) ?? null;
  }, [myEditRequests, selectedDay, selectedDayStr, dayModalData]);

  // Day modal: the shift allocation (if any) covering the selected day.
  const dayShiftInfo = useMemo(() => {
    if (!selectedDay || myShifts.length === 0) return null;
    const pad = (n: number) => String(n).padStart(2, '0');
    const ds = `${selectedDay.getFullYear()}-${pad(selectedDay.getMonth() + 1)}-${pad(selectedDay.getDate())}`;
    return myShifts.find(s => ds >= s.from_date && ds <= s.to_date) ?? null;
  }, [selectedDay, myShifts]);

  // Day modal: this day's actual scheduled shift(s), Southern Lanka only — every
  // ScheduleAssignment row for the selected date, in start-time order. May be more than one
  // (a split day, or a genuinely merged back-to-back pair) — shown as a simple list here rather
  // than the shortfall engine's merged-block treatment, since this is informational context for
  // the employee, not a scoring surface.
  const dayScheduledShifts = useMemo(() => {
    if (!isSouthernlanka || !selectedDayStr) return [];
    return myScheduleAssignments
      .filter(a => a.date === selectedDayStr)
      .sort((a, b) => (a.start_time || '99:99').localeCompare(b.start_time || '99:99'));
  }, [isSouthernlanka, selectedDayStr, myScheduleAssignments]);

  // Load the user's shift allocations the first time the day modal opens, so the modal
  // can tell whether a given day falls inside an allocated shift period. (Loaded for
  // any user — allocations live in `shift_assignments`, not the legacy user flag.)
  const shiftsLoaded = useRef(false);
  useEffect(() => {
    if (!showDayModal || !user?.epf_number || shiftsLoaded.current) return;
    shiftsLoaded.current = true;
    import('@/services/shiftService')
      .then(({ getShiftAssignmentsForEpf }) => getShiftAssignmentsForEpf(user.epf_number!))
      .then(setMyShifts)
      .catch(() => { shiftsLoaded.current = false; /* allow retry */ });
  }, [showDayModal, user?.epf_number]);

  // Southern Lanka only — load this employee's whole ScheduleAssignment history the first
  // time the day modal opens (same lazy-once pattern as myShifts above), so dayScheduledShifts
  // below can look up any date without a per-click fetch.
  const scheduleAssignmentsLoaded = useRef(false);
  useEffect(() => {
    if (!showDayModal || !isSouthernlanka || !user?.epf_number || scheduleAssignmentsLoaded.current) return;
    scheduleAssignmentsLoaded.current = true;
    import('@/services/scheduleAssignmentService')
      .then(({ getScheduleAssignmentsForEmployee }) => getScheduleAssignmentsForEmployee(user.epf_number!))
      .then(setMyScheduleAssignments)
      .catch(() => { scheduleAssignmentsLoaded.current = false; /* allow retry */ });
  }, [showDayModal, isSouthernlanka, user?.epf_number]);

  // Meal data for the day the modal is showing. Fetched only while the modal is open and only
  // on a tenant with the food module, and dropped on close so a stale day's chamaries can never
  // be shown against the next day opened.
  useEffect(() => {
    const epf = user?.epf_number;
    if (!showDayModal || !tenant.features.suspense || !selectedDayStr || !epf) {
      setDayChamaries([]); setDayOffdays([]); setDayMeals([]);
      return;
    }
    let cancelled = false;
    setDayMealsLoading(true);
    (async () => {
      try {
        const chamaries = await listAllChamaries();
        const [offdays, mine] = await Promise.all([
          Promise.all(chamaries.map(c => getChamaryOffdaysForDay(c.id, selectedDayStr))),
          getMyMealsForDate(epf, selectedDayStr),
        ]);
        if (cancelled) return;

        const offdaysFlat = offdays.flat();

        // 1. Role category filter: only chamaries permitted for this user's role
        const forRole = chamaries.filter(c => categoryAllowed(c.categories, myCategory));

        // 2. Location filter: only chamaries at the location for that day
        const dayPlaceName = dayModalData?.working_place
          || (dayModalData as any)?.sessions?.[0]?.working_place
          || (dayShiftInfo as any)?.working_place
          || null;
        const daySiteId = (dayModalData as any)?.check_in_site_id || (dayModalData as any)?.site_id || null;
        const dayPlaceNorm = dayPlaceName?.trim().toLowerCase() || null;
        const hasDayLocation = !!(daySiteId || dayPlaceNorm);

        const forLocation = forRole.filter(c => {
          if (mine.some(m => m.chamary_id === c.id)) return true;
          if (!hasDayLocation) return true;
          if (daySiteId && c.working_place_id === daySiteId) return true;
          if (dayPlaceNorm && c.working_place_name.trim().toLowerCase() === dayPlaceNorm) return true;
          return false;
        });

        // 3. Available for that day: only chamaries that serve at least one meal that is NOT marked off
        const available = forLocation.filter(c => {
          if (mine.some(m => m.chamary_id === c.id)) return true;
          const meals = chamaryMeals(c.meals);
          if (!meals.length) return false;
          return meals.some(m => !offdaysFlat.some(o => o.chamary_id === c.id && mealOf(o.meal) === m));
        });

        setDayChamaries(available);
        setDayOffdays(offdaysFlat);
        setDayMeals(mine);
      } catch {
        if (!cancelled) { setDayChamaries([]); setDayOffdays([]); setDayMeals([]); }
      } finally {
        if (!cancelled) setDayMealsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [showDayModal, selectedDayStr, user?.epf_number, myCategory, dayModalData, dayShiftInfo]);

  const mealLabel = (m: MealType) => (m === 'breakfast' ? t.mealBreakfast : m === 'lunch' ? t.mealLunch : t.mealDinner);
  // This user's booking for one meal on the selected day, whichever chamary it sits at.
  const myMealBooking = (m: MealType) => dayMeals.find(r => mealOf(r.meal) === m) ?? null;
  const chamaryIsOff = (chamaryId: string, m: MealType) =>
    dayOffdays.some(o => o.chamary_id === chamaryId && mealOf(o.meal) === m);

  const bookDayMeal = async (c: ChamaryWithPlace, meal: MealType) => {
    const epf = user?.epf_number ?? '';
    if (!epf || !selectedDayStr) return;
    setDayMealBusy(`${c.id}__${meal}`);
    try {
      await requestMeal({
        epf_number: epf, employee_name: user?.name ?? '',
        company_id: user?.company_id ?? '', company_name: user?.company ?? '',
        date: selectedDayStr, meal,
        chamary_id: c.id, chamary_name: c.name,
        working_place_id: c.working_place_id, working_place_name: c.working_place_name,
      }, { epf, name: user?.name ?? '' });
      setDayMeals(await getMyMealsForDate(epf, selectedDayStr));
      // The toast carries BOTH a {meal} and a {chamary} placeholder; useT() does no
      // interpolation, so every one of them has to be substituted here or the user reads the
      // literal token — "lunch requested at {chamary}." was exactly that, a half-done fix.
      toast.success(
        t.mealRequestedToast
          .replace(/\{meal\}/g, mealLabel(meal).toLowerCase())
          .replace(/\{chamary\}/g, c.name),
      );
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t.failedRequestMeal);
    } finally { setDayMealBusy(''); }
  };

  const cancelDayMeal = async (c: ChamaryWithPlace, meal: MealType) => {
    const epf = user?.epf_number ?? '';
    if (!epf || !selectedDayStr) return;
    // Cancelling DELETES the booking, and a booking is one share of the chamary's monthly bill —
    // removing one re-prices the month for everyone else in it. /food fences this to
    // "today, and not yet collected" and sends every other case through meal_change_requests
    // for the responsible person to approve. This calendar had no guard at all: any past day
    // could be picked and its already-served meal hard-deleted from here, which quietly made
    // that approval flow optional. Same fence, same reason.
    const row = dayMeals.find(r => mealOf(r.meal) === mealOf(meal) && r.chamary_id === c.id);
    if (selectedDayStr !== todayString() || row?.served === true) {
      toast.error(t.foodChangeNeedsApproval);
      return;
    }
    setDayMealBusy(`${c.id}__${meal}`);
    try {
      await cancelMeal(epf, selectedDayStr, meal);
      setDayMeals(await getMyMealsForDate(epf, selectedDayStr));
      toast.success(t.mealCancelledToast.replace(/\{meal\}/g, mealLabel(meal).toLowerCase()));
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t.failedCancelMeal);
    } finally { setDayMealBusy(''); }
  };

  // Track the last date we loaded data for — used to detect midnight crossover
  const lastLoadedDate = useRef<string>(todayString());

  // On mount: load data. Also set up a 60-second interval that reloads
  // if the date has changed (handles the midnight crossover case).
  useEffect(() => {
    loadData();

    const interval = setInterval(() => {
      const currentDate = todayString();
      if (currentDate !== lastLoadedDate.current) {
        // Date has changed — reset everything and reload fresh
        lastLoadedDate.current = currentDate;
        setAttendance(null);
        setLeaveCheck(null);
        // Reset calendar to new today's month
        setCalendarMonth(new Date());
        loadData();
      }
    }, 60_000); // check every minute

    return () => clearInterval(interval);
  }, []);

  // Southern Lanka only — real-time sync for this employee's own Time Change / Attendance
  // Edit requests: a new submission shows up instantly, and an approver's decision (approve/
  // reject) updates its status here with no manual refresh (see
  // attendanceApi.subscribeMyEditRequests in apiCompat.ts). Fires once immediately with
  // current data — a harmless redundant overlap with loadData()'s own one-shot fetch above —
  // then again on every relevant write.
  useEffect(() => {
    const epf = user?.epf_number;
    if (tenant.id !== 'southernlanka' || !epf) return;
    const unsub = attendanceApiRT.subscribeMyEditRequests(epf, (requests: unknown[]) => {
      setMyEditRequests(requests as typeof myEditRequests);
    });
    return () => unsub();
  }, [user?.epf_number]);

  // Every month read is stamped with a token, and only the newest one is allowed to paint.
  // Month navigation is one click per month, so tapping back three months fires three reads
  // whose responses can land in any order: without this, a slower EARLIER response overwrote
  // the month actually on screen (and its `setCalendarLoading(false)` cleared the spinner
  // while the real request was still in flight).
  const calendarReqId = useRef(0);

  // Fetch both leave dates AND worked days in parallel for the calendar
  const fetchCalendarDates = async (month: Date) => {
    const reqId = ++calendarReqId.current;
    const isStale = () => calendarReqId.current !== reqId;
    setCalendarLoading(true);
    const epf = user?.epf_number ?? '';
    const now = new Date();
    const isCurrent =
      month.getMonth() === now.getMonth() &&
      month.getFullYear() === now.getFullYear();
    const mo = month.getMonth() + 1;
    const yr = month.getFullYear();

    const [leaveRes, workedRes] = await Promise.allSettled([
      isCurrent
        ? leaveApi.getThisMonthLeaves(epf)
        : leaveApi.getThisMonthLeaves(epf, mo, yr),
      attendanceApi.getMonthlyAttendanceDates(
        epf,
        isCurrent ? undefined : mo,
        isCurrent ? undefined : yr,
      ),
    ]);

    // A newer month is already being fetched (or has landed) — drop this one on the floor
    // rather than repainting the grid with a month the reader has navigated away from.
    if (isStale()) return;

    // ── Leave dates → blue ─────────────────────────────────────────────────
    if (leaveRes.status === 'fulfilled') {
      const inner = leaveRes.value.data?.data ?? leaveRes.value.data ?? {};
      const dates: string[] = inner?.leave_dates ?? [];
      setHighlightedDays(
        Array.isArray(dates) && dates.length > 0
          ? dates.map(d => { const [y, m, day] = d.split('-').map(Number); return new Date(y, m - 1, day); })
          : []
      );
    } else {
      // No banner for leave dates — the calendar is still usable without them — but the reason
      // is logged rather than dropped, so a month that silently loses its blue days is traceable.
      console.error(
        `[attendance] calendar leave dates failed for ${monthLabel(mo, yr)} (epf ${epf}) — code=${firebaseErrorCode(leaveRes.reason) ?? 'none'}`,
        leaveRes.reason,
      );
      setHighlightedDays([]);
    }

    // ── Worked dates → green (all employees) ──────────────────────────────
    if (workedRes.status === 'fulfilled') {
      setCalendarError(false);
      setCalendarErrorCode(null);
      const inner = workedRes.value.data?.data ?? workedRes.value.data ?? {};
      const dates: string[] = inner?.attendance_dates ?? [];
      setWorkedDays(
        Array.isArray(dates) && dates.length > 0
          ? dates.map(d => { const [y, m, day] = d.split('-').map(Number); return new Date(y, m - 1, day); })
          : []
      );

      // ── Hours per date → progress ring ──────────────────────────────────
      const hours = inner?.dates_hours;
      setWorkedHours(hours && typeof hours === 'object' ? hours as Record<string, number> : {});

      // ── Missing-checkout dates → warning icon ───────────────────────────
      // Exclude today: a same-day check-out may just not have happened yet.
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const missing: string[] = inner?.missing_checkout_dates ?? [];
      setMissingCheckoutDays(
        Array.isArray(missing)
          ? missing
              .map(d => { const [y, m, day] = d.split('-').map(Number); return new Date(y, m - 1, day); })
              .filter(dt => dt < todayStart)
          : []
      );
    } else {
      // getMonthlyAttendanceDates only rejects when EVERY day read in the month failed, so this
      // reason is the whole story. Log it whole — the code and message are what identify the
      // cause, and without this the banner was the only evidence anyone had.
      const reason = workedRes.reason;
      const code = firebaseErrorCode(reason);
      console.error(
        `[attendance] calendar month read FAILED for ${monthLabel(mo, yr)} (epf ${epf}) — code=${code ?? 'none'}`,
        reason,
      );
      setCalendarError(true);
      setCalendarErrorCode(code);
      setWorkedDays([]);
      setWorkedHours({});
      setMissingCheckoutDays([]);
    }

    setCalendarLoading(false);
  };

  // Keep these as aliases so existing call sites still work
  const fetchLeaveDates = fetchCalendarDates;
  const fetchWorkedDays = fetchCalendarDates;

  // react-day-picker gives DayContent no way to pass extra props, so the hours map is bound
  // into the component here. Memoised on the data so a hover — which re-renders this page via
  // the tooltip state — doesn't remount every day cell.
  const CalendarDay = useMemo(() => {
    const labels = { companyHoliday: t.companyHoliday };
    const noteLabels = { halfDay: t.halfDay, workedDay: t.workedDay, loggedHours: t.loggedHoursLabel };
    const Day = (props: DayContentProps) => {
      const mods = props.activeModifiers as Record<string, boolean>;
      const raw  = Number(workedHours[dayKey(props.date)]);
      const h    = Number.isFinite(raw) && raw > 0 ? raw : 0;
      const mark = dayMark(h, props.date, !!mods.worked, workExpectation);
      // Every word the gauge is saying, in the same order the tooltip says them — both come
      // out of markNotes so they cannot drift.
      const notes = markNotes(mark, h, !!mods.worked, noteLabels);
      return (
        <CalendarDayContent
          {...props}
          mark={mark}
          labels={labels}
          srNote={notes.join(', ') || undefined}
        />
      );
    };
    Day.displayName = 'CalendarDay';
    return Day;
  }, [workedHours, t]);

  // ── The day cell: the day button, and this day's hours (+ missing-checkout warning) printed
  //    underneath it ─────────────────────────────────────────────────────────────────────────
  // The figure sits OUTSIDE the button, not inside it, and that is the whole reason this
  // component exists. Inside a 36px button there is no room left — the digit, the gauge and the
  // company-holiday dot already fill it — and growing the button to make room would have cost
  // two things at once: the leave / holiday discs and the three edit-request outlines are drawn
  // by `modifiersStyles` at `borderRadius: 50%` ON THE BUTTON, so a taller-than-wide button turns
  // every one of them into an ellipse; and a wider button stops seven columns fitting a phone.
  // Putting the figure in the table cell underneath keeps the button exactly --rdp-cell-size
  // square and adds nothing to the calendar's width. The missing-checkout warning used to be a
  // corner badge ON the button for exactly this reason too, until it turned out there's no
  // offset that clears the digit without also clearing the button's own circular overflow:hidden
  // clip — so it lives here now, next to the hours figure, same as everything else that didn't
  // fit inside the circle.
  //
  // WIDTH, at the narrowest phone this has to survive (360px viewport):
  //   360 − 32 (the page's p-4) − 32 (the calendar Card's p-4) = 296px for .rdp-table, which is
  //   width:100% + table-layout:fixed → 296 / 7 = 42.3px per column. The button is unchanged at
  //   36px, so each column still has 6.3px of slack, and the widest figure this can print
  //   ("23.9h", five characters of 10px tabular numerals ≈ 30px) fits inside 42.3px with room
  //   over. The missing-checkout icon (h-2 w-2, gap-px) adds ~9px on top of that on the days
  //   that need it, which is why it's kept that small rather than matched to the legend's — the
  //   worst case (a missing-checkout day that also prints "23.9h") still clears the column, just
  //   with little of the 6.3px left. Nothing here can scroll sideways: .rdp-cell itself has no
  //   overflow:hidden (only the round day button does), so even a figure that did run over its
  //   column would spill visually into the gap rather than get clipped or push the grid wider.
  //
  // This is the v8 custom-Day recipe from the react-day-picker docs — useDayRender + its own
  // Button — so every modifier, style, event handler and the roving focus behave exactly as
  // they do in the stock component.
  const CalendarDayCell = useMemo(() => {
    const Cell = (props: DayProps) => {
      const buttonRef = useRef<HTMLButtonElement>(null);
      // react-day-picker v8 types this ref as RefObject<HTMLButtonElement>. Under React 19's
      // types useRef(null) yields RefObject<HTMLButtonElement | null>, which no longer matches;
      // the cast is that version gap and nothing more — RDP only ever reads .current, guarded,
      // inside its focus effect.
      const dayRender = useDayRender(props.date, props.displayMonth, buttonRef as RefObject<HTMLButtonElement>);
      const raw = Number(workedHours[dayKey(props.date)]);
      const caption = hoursCaption(Number.isFinite(raw) && raw > 0 ? raw : 0);
      const isMissingCheckout = missingCheckoutDays.some(d => isSameDay(d, props.date));

      if (dayRender.isHidden) return <div role="gridcell" />;
      if (!dayRender.isButton) return <div {...dayRender.divProps} />;
      return (
        // The tile a thumb aims at is now taller than the button, so a tap that lands on the
        // figure is forwarded to the day itself — otherwise the bottom third of every day on a
        // phone would silently do nothing and read as a broken calendar. The figure row takes no
        // pointer events itself (the icon inside it is the one exception, see below), so a tap
        // there targets THIS div and never the button; the containment check is what stops a real
        // button click bouncing back through here in a loop. Keyboard is untouched: the button is
        // still the only focusable thing, with RDP's roving tabindex.
        <div
          className="flex flex-col items-center"
          onClick={e => {
            if (!buttonRef.current?.contains(e.target as Node)) buttonRef.current?.click();
          }}
        >
          <DayButton name="day" ref={buttonRef} {...dayRender.buttonProps} />
          {/* Rendered whether or not it has a figure in it: a table row is as tall as its
              tallest cell, so a line reserved only on the days that have hours would make the
              month's rows jump between two heights. The hours text is aria-hidden because the
              same number is already in the button's own screen-reader note, via markNotes —
              announcing it twice per day is worse than not announcing it at all. The warning
              icon is the opposite: it's the ONLY place "missing checkout" is exposed visually
              (see CalendarDayContent's comment for why it isn't a badge on the button any more),
              so it keeps its own accessible name rather than inheriting the row's aria-hidden.
              Left in the muted tone on EVERY kind of day, including the short and the long
              ones: the gauge is what says a day is unusual, and colouring the figure too would
              state that a second time and cost the ordinary day its quiet. */}
          {/* h-2 w-2, no gap: the widest hours figure ("23.9h") already uses ~30px of the
              42.3px mobile column budget (see the WIDTH note above) — an icon needs to add as
              little as possible on top of that so a long figure + the warning can never push
              the row wider than its column, even though nothing here would clip it if it did
              (no overflow:hidden below the button — see the .rdp-cell CSS this file already
              leans on). Kept this small deliberately rather than reaching for the width back. */}
          <span className="pointer-events-none flex h-3 items-center justify-center gap-px leading-3">
            {isMissingCheckout && (
              // lucide's SVGProps has no `title` — the native hover tooltip needs its own
              // wrapper; the icon itself carries the accessible name for screen readers.
              <span title={t.missingCheckout} className="flex-shrink-0">
                <AlertTriangle
                  role="img"
                  aria-label={t.missingCheckout}
                  className="h-2 w-2 text-amber-500"
                  strokeWidth={2.5}
                />
              </span>
            )}
            <span aria-hidden="true" className="text-[10px] tabular-nums text-muted-foreground">
              {caption}
            </span>
          </span>
        </div>
      );
    };
    Cell.displayName = 'CalendarDayCell';
    return Cell;
  }, [workedHours, missingCheckoutDays, t.missingCheckout]);

  // Fetch Sri Lanka mercantile holidays from Calendarific (cached per year)
  const fetchHolidays = useCallback(async (year: number) => {
    if (holidayCache.current.has(year)) return;
    holidayCache.current.add(year);
    try {
      const res = await fetch(`/api/holidays?year=${year}`);
      if (!res.ok) return;
      const data = await res.json();
      const allHolidays: {
        name: string;
        primary_type: string;
        type: string[];
        date: { datetime: { year: number; month: number; day: number } };
      }[] = data.response?.holidays ?? [];
      // Keep only gazetted mercantile/public holidays (primary_type is "Public Holiday" in the API)
      const holidays = allHolidays.filter(h => h.primary_type === 'Public Holiday');
      const newDates: Date[] = [];
      const newNames: Record<string, string> = {};
      holidays.forEach(h => {
        const { year: y, month: m, day: d } = h.date.datetime;
        newDates.push(new Date(y, m - 1, d));
        const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        newNames[key] = h.name;
      });
      setHolidayDays(prev => {
        // merge without duplicating across year fetches
        const existing = new Set(prev.map(d => d.toDateString()));
        return [...prev, ...newDates.filter(d => !existing.has(d.toDateString()))];
      });
      setHolidayNames(prev => ({ ...prev, ...newNames }));
    } catch { /* non-critical */ }
  }, []);

  // Fetch the org's accepted company holidays for a year (cached per year). Marks the
  // calendar days with the "company holiday" badge; custom entries carry their own names.
  const fetchCompanyHolidays = useCallback(async (year: number) => {
    if (companyHolidayCache.current.has(year)) return;
    companyHolidayCache.current.add(year);
    try {
      const { dates, custom } = await getHolidaySettings(year);
      if (dates.length === 0) return;
      const newDates = dates.map(ds => {
        const [y, m, d] = ds.split('-').map(Number);
        return new Date(y, m - 1, d);
      });
      const newNames: Record<string, string> = {};
      custom.forEach(c => { newNames[c.date] = c.name; });
      setCompanyHolidayDays(prev => {
        const existing = new Set(prev.map(d => d.toDateString()));
        return [...prev, ...newDates.filter(d => !existing.has(d.toDateString()))];
      });
      setCompanyHolidayNames(prev => ({ ...prev, ...newNames }));
    } catch { /* non-critical */ }
  }, []);

  // `silent` skips the full-page skeleton — used after a mutation (check-in/out, edit request)
  // so the page updates in place instead of remounting (which replays entrance animations and
  // looks like the whole page resetting).
  const loadData = async (silent = false) => {
    if (!silent) setLoading(true);
    // Record which date this load is for
    lastLoadedDate.current = todayString();

    try {
      const [leaveRes, attRes] = await Promise.allSettled([
        leaveApi.checkIsTodayLeave(user?.epf_number ?? ''),
        attendanceApi.getMyTodayAttendance(user?.epf_number ?? '', user),
      ]);

      if (leaveRes.status === 'fulfilled' && leaveRes.value) {
        const ldata = leaveRes.value.data?.data ?? leaveRes.value.data;
        setLeaveCheck({
          can_mark_attendance: ldata?.can_mark_attendance ?? true,
          is_half_day: ldata?.is_half_day ?? false,
          half_day_period: ldata?.half_day_period ?? null,
        });
      } else {
        // Falling back to "can mark attendance" is deliberate — a failed leave check must not
        // lock someone out of checking in — but it hides that the read failed at all, so say so.
        if (leaveRes.status === 'rejected') {
          console.error(
            `[attendance] today leave check failed — code=${firebaseErrorCode(leaveRes.reason) ?? 'none'}`,
            leaveRes.reason,
          );
        }
        setLeaveCheck({ can_mark_attendance: true });
      }

      if (attRes.status === 'rejected') {
        const code = firebaseErrorCode(attRes.reason);
        console.error(
          `[attendance] today attendance read failed — code=${code ?? 'none'}`,
          attRes.reason,
        );
        // Surfaced, not just logged: `attendance` stays null on a rejection, and null is
        // indistinguishable from "hasn't checked in yet" everywhere downstream.
        setTodayError(true);
        setTodayErrorCode(code);
      } else {
        setTodayError(false);
        setTodayErrorCode(null);
      }

      if (attRes.status === 'fulfilled' && attRes.value) {
        const outer = attRes.value.data?.data ?? attRes.value.data;
        const att = outer?.today_attendance ?? outer;

        // Guard: if the attendance record is for a previous date, discard it.
        // This handles the case where the user has the page open past midnight.
        const today = todayString();
        const attDate = att?.date?.split(' ')[0] ?? att?.date ?? '';
        if (attDate && attDate !== today) {
          // Record belongs to yesterday — treat as no attendance today
          setAttendance(null);
        } else {
          setAttendance(att);
        }
      }

      // Primary status + leave are in → reveal the page NOW (was ~10s because setLoading(false)
      // sat at the very end, after the serial schedule/edit-request/absentee reads below). Those
      // secondary reads fill their own cards in and must not keep the skeleton up.
      if (!silent) setLoading(false);

      // Fetch leave dates + worked days for the calendar
      fetchCalendarDates(new Date());

      // Fetch Sri Lanka holidays for this year (and next, so month-nav stays populated)
      const yr = new Date().getFullYear();
      fetchHolidays(yr);
      fetchHolidays(yr + 1);
      // Company-accepted holidays for the same years (calendar badge)
      fetchCompanyHolidays(yr);
      fetchCompanyHolidays(yr + 1);

      // Load my edit requests (show status to employee)
      try {
        const erRes = await attendanceApi.getMyEditRequests(user?.epf_number ?? '');
        const erData = erRes.data?.data ?? erRes.data;
        setMyEditRequests(erData?.requests ?? []);
      } catch { /* non-critical */ }

      // Load absentees for exec (non-trainee)
      if (isExec && !isTrainee) {
        try {
          setAbsenteesLoading(true);
          const absRes = await leaveApi.getTodayAbsentees(user?.company ?? '', user?.epf_number ?? '');
          const absData = absRes.data?.data ?? absRes.data;
          setAbsentees(Array.isArray(absData?.absent_list) ? absData.absent_list : []);
          setIsImmediateSupervisor(!!absData?.is_immediate_supervisor);
        } catch { setAbsentees([]); setIsImmediateSupervisor(false); }
        setAbsenteesLoading(false);
      }

    } catch (err) {
      console.error('[attendance] loadData error', err);
      setLeaveCheck({ can_mark_attendance: true });
    }
    if (!silent) setLoading(false);
  };

  // Session-aware state: a day holds one or more sessions; the "open" one (checked in,
  // not yet out) drives the check-out control. Multi-session roles can start another.
  const sessions: any[] = (attendance as any)?.sessions ?? [];
  const openSession = sessions.find((s: any) => s.check_in && !s.check_out) ?? null;
  const lastSession = sessions.length ? sessions[sessions.length - 1] : null;

  const isCheckedIn  = !!openSession;
  const canStartSession = !openSession && (caps.multi_session || sessions.length === 0);
  const isCheckedOut = !openSession && !canStartSession && !!lastSession?.check_out;
  // Drives the hero status pill + the LeaveDayBanner / HalfDayLeaveBanner branch below.
  const isLeaveDay   = leaveCheck?.can_mark_attendance === false;

  const handleSubmitDayEditRequest = async () => {
    if (!dayEditForm.check_in || !dayEditForm.check_out) { toast.error(t.checkInOutTimesRequired); return; }
    // Southern Lanka has no GPS-based Working Place to pick — fingerprint/face terminals are
    // the only clock there, so there's never a "where" to ask about on a time correction.
    // Every other tenant (mobile GPS check-in) still requires it.
    if (!isSouthernlanka) {
      if (!dayEditForm.working_place) { toast.error(t.workingPlaceRequired); return; }
      if (requiresSite(dayEditForm.working_place) && !dayEditForm.site_number.trim()) {
        toast.error(t.siteNumberRequiredForPlace); return;
      }
    }
    if (!dayEditForm.reason.trim()) { toast.error(t.provideEditReason); return; }
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr = selectedDay
      ? `${selectedDay.getFullYear()}-${pad(selectedDay.getMonth() + 1)}-${pad(selectedDay.getDate())}`
      : (dayModalData?.date ?? '').split('T')[0].split(' ')[0];
    // Shift places can run a same-day shift (e.g. 6am-6pm) or an overnight one (e.g.
    // 6am-6/7/8am the next day) — computed automatically from the two times, never
    // user-picked; every other place's check-out always shares the check-in date. Southern
    // Lanka has no working place to carry the 'shift' tag at all — there's no legitimate
    // same-day case where a requested check-out is numerically before check-in, so there it
    // always means the shift crossed midnight, unconditionally.
    let outDateStr = dateStr;
    if ((isSouthernlanka || placeHasTag(dayEditForm.working_place, 'shift')) && shiftRunsOvernight(dayEditForm.check_in, dayEditForm.check_out)) {
      const outDay = selectedDay ? new Date(selectedDay) : new Date(`${dateStr}T00:00:00`);
      outDay.setDate(outDay.getDate() + 1);
      outDateStr = `${outDay.getFullYear()}-${pad(outDay.getMonth() + 1)}-${pad(outDay.getDate())}`;
    }
    if (`${outDateStr} ${dayEditForm.check_out}` <= `${dateStr} ${dayEditForm.check_in}`) {
      toast.error(t.checkoutAfterCheckinOvernight);
      return;
    }
    setEditReqLoading(true);
    try {
      const requested = {
        requested_check_in: dayEditForm.check_in ? `${dateStr} ${dayEditForm.check_in}:00` : null,
        requested_check_out: dayEditForm.check_out ? `${outDateStr} ${dayEditForm.check_out}:00` : null,
        requested_working_place: dayEditForm.working_place || null,
        requested_site_number: dayEditForm.site_number || null,
        // Outstation is auto-derived on approval from the working place — not requested here.
        requested_is_outstation: null,
        requested_outstation_name: null,
        requested_outstation_address: null,
      };
      if (editingRequestId) {
        // Amend the existing pending request in place rather than stacking a duplicate.
        await attendanceApi.updateAttendanceEditRequest({
          id: editingRequestId,
          epf_number: user?.epf_number ?? '',
          reason: dayEditForm.reason,
          ...requested,
        });
        toast.success(t.requestUpdated);
      } else {
        await attendanceApi.requestAttendanceEdit({
          attendance_id: dayModalData?.attendance_id ?? 0,
          // No record for this day (Southern Lanka missed-punch flow) → the service builds the
          // target doc id from epf + date, and approval creates the record from the requested values.
          date: dateStr,
          session_id: dayEditSessionId || (dayModalData as any)?.sessions?.slice(-1)[0]?.id || null,
          epf_number: user?.epf_number ?? '',
          reason: dayEditForm.reason,
          ...requested,
        });
        toast.success(t.editRequestSubmitted);
      }
      // The day now has a pending edit request → drop the cached "forgot to check out" result
      // so the banner re-evaluates (and stays hidden) on the next dashboard/attendance mount.
      invalidateDanglingCheckout(user?.epf_number);
      setEditingRequestId(null);
      setShowDayModal(false);
      loadData(true);
    } catch (err: unknown) {
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? (editingRequestId ? t.failedUpdateRequest : t.failedSubmitEditRequest)
      );
    }
    setEditReqLoading(false);
  };

  const handleSubmitPastAttendance = async () => {
    // Multi-location: places stashed via "Add another location" plus the current pick.
    const allLocs = [
      ...pastLocs,
      ...(pastAttForm.working_place ? [{ name: pastAttForm.working_place, site_number: pastAttForm.site_number }] : []),
    ];
    if (!pastAttForm.check_in || !pastAttForm.check_out) { toast.error(t.checkInOutTimesRequired); return; }
    if (allLocs.length === 0) { toast.error(t.workingPlaceRequired); return; }
    if (pastAttForm.working_place && requiresSite(pastAttForm.working_place) && !pastAttForm.site_number) { toast.error(t.siteNumberRequired); return; }
    // Overnight (shift) days check out on the next calendar day; otherwise check-out must
    // be after check-in on the same day.
    if (!pastAttForm.overnight && pastAttForm.check_out <= pastAttForm.check_in) {
      toast.error(dayShiftInfo
        ? t.checkoutAfterCheckinOvernight
        : t.checkoutAfterCheckin);
      return;
    }

    setPastAttLoading(true);
    try {
      const pad = (n: number) => String(n).padStart(2, '0');
      const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const dateStr = fmt(selectedDay!);
      const outDay = new Date(selectedDay!);
      if (pastAttForm.overnight) outDay.setDate(outDay.getDate() + 1);
      const outDateStr = fmt(outDay);

      const primary = allLocs[0];
      const payload: any = {
        epf_number: user?.epf_number ?? '',
        date: dateStr,                                  // record stays under the check-in (start) day
        check_in_time: `${dateStr} ${pastAttForm.check_in}:00`,
        check_out_time: `${outDateStr} ${pastAttForm.check_out}:00`,
        working_place: primary.name,
        locations: allLocs.map(l => ({ name: l.name, site_number: l.site_number || null })),
        request_from: [],
      };
      if (requiresSite(primary.name)) payload.site_number = primary.site_number;
      // Outstation is auto-derived server-side from the working place vs the day's base.

      await attendanceApi.submitPastAttendance(payload);
      toast.success(t.pastAttendanceSubmitted);
      setPastLocs([]);
      setShowDayModal(false);
      loadData(true);
    } catch (err: unknown) {
      console.error('[submitPastAttendance] failed', err);
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? (err as Error)?.message
        ?? t.failedPastAttendance,
      );
    } finally {
      setPastAttLoading(false);
    }
  };

  if (loading) {
    // The skeleton mirrors the SHAPE the page actually renders — hero band, then two equal
    // columns holding the check-in card and the calendar. The old one drew a page that does
    // not exist here (a pair of KPI tiles, no hero) at the old 3/5–2/5 split, so every load
    // ended with the whole layout jumping as the real content replaced it.
    return (
      <div className="space-y-6">
        {/* Hero band */}
        <div className="rounded-2xl glass-strong px-5 py-5 shadow-soft sm:px-6 sm:py-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className="h-3 w-44" />
              <Skeleton className="h-7 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
            <Skeleton className="h-7 w-28 rounded-full" />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Check-in / check-out card */}
          <Card className="p-4 space-y-4">
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-8 rounded-lg" />
              <Skeleton className="h-4 w-36" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Skeleton className="h-2.5 w-16" />
                <Skeleton className="h-6 w-20" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-2.5 w-16" />
                <Skeleton className="h-6 w-20" />
              </div>
            </div>
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-12 w-full rounded-full" />
          </Card>

          {/* Calendar card: header, month grid, month summary */}
          <Card className="p-4 space-y-4">
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-8 rounded-lg" />
              <Skeleton className="h-4 w-40" />
            </div>
            <Skeleton className="h-64 w-full rounded-lg" />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full rounded-lg" />
              ))}
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <PageTransition className="space-y-6">
      {/* Flagship hero — date, live clock, and the one-glance today status */}
      <Reveal>
        <div className="relative isolate overflow-hidden rounded-2xl glass-strong px-5 py-5 shadow-soft sm:px-6 sm:py-6">
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-br from-primary/10 via-transparent to-brand/10" />
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
                <CalendarDays className="h-3.5 w-3.5 flex-shrink-0" />
                <span>{formatDate(localDateString())}</span>
                <span className="text-muted-foreground/40">·</span>
                <Clock className="h-3.5 w-3.5 flex-shrink-0" />
                <LiveClock />
              </div>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{t.attendanceTitle}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{t.attendanceDesc}</p>
            </div>

            {(() => {
              const s = isLeaveDay
                ? { label: t.onLeave,       cls: 'bg-brand/10 text-brand border-brand/20',       dot: 'bg-brand',            pulse: false }
                : isCheckedOut
                ? { label: t.dayComplete,   cls: 'bg-success/10 text-success border-success/20', dot: 'bg-success',          pulse: false }
                : isCheckedIn
                ? { label: t.checkedIn,     cls: 'bg-primary/10 text-primary border-primary/20', dot: 'bg-primary',          pulse: true }
                : { label: t.notCheckedIn,  cls: 'bg-muted text-muted-foreground border-border', dot: 'bg-muted-foreground', pulse: false };
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

      {/* Two equal columns rather than 3/5 + 2/5. For an employee who is not a supervisor the
          left column held ONE card and the right held the calendar, its month summary, its
          chips and its legend — so the page ran ~1100px tall down a 40%-wide rail beside an
          empty half-screen. Equal halves give the month its width back (the four summary
          figures stop wrapping their labels) without shrinking the one thing that matters
          most, the check-in control, below any width it is already used at on the dashboard. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-4">

          {/* A failed today-read used to be INVISIBLE: getMyTodayAttendance rejecting left
              `attendance` null, and null renders as "Not checked in" — the same thing a genuine
              unmarked day renders as. Somebody who had checked in hours earlier was told they
              had not, on a page whose whole job is that one fact. Outside the leave branch on
              purpose: the leave verdict comes from a DIFFERENT read, so a leave day can be
              showing while today's attendance never loaded. */}
          {todayError && (
            <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-warning/25 bg-warning/5 px-3 py-2 text-xs text-warning">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              <span>{t.failedLoadAttendanceDetails}</span>
              {todayErrorCode && (
                <code className="rounded bg-warning/10 px-1 py-px font-mono text-[10px] text-warning/80">
                  {todayErrorCode}
                </code>
              )}
              <button
                type="button"
                onClick={() => loadData(true)}
                className="rounded font-semibold underline underline-offset-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {t.tryAgain}
              </button>
            </div>
          )}

          {isLeaveDay ? (
            <LeaveDayBanner t={t as Record<string, string>} />
          ) : (
            <>
              {leaveCheck?.is_half_day && (
                <HalfDayLeaveBanner period={leaveCheck.half_day_period} />
              )}
              {/* Today's Attendance — shared check-in / check-out card (also used on the
                  dashboard). It is ALWAYS mounted now. A picked calendar day used to take this
                  slot, and the pick happened on hover, so moving a pointer over the calendar
                  made "check out" vanish and a click pinned it away until the reader found
                  "Back to today". The day summary moved next to the calendar instead (see
                  SelectedDayCard); a readout must not be able to evict a control. */}
              <TodayCheckInOut attendance={attendance} loading={loading} onMutated={() => loadData(true)} />

              {/* Missing-attendance card — immediate supervisor only (people with direct reports) */}
              {isExec && !isTrainee && isImmediateSupervisor && (
                <Reveal as="div">
                <Card className="p-4">
                  {/* Header */}
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-8 h-8 rounded-lg bg-destructive/15 border border-destructive/20 flex items-center justify-center flex-shrink-0">
                      <UserX className="w-4 h-4 text-destructive" />
                    </div>
                    <span className="text-sm font-semibold text-foreground">{t.missingAttendanceToday}</span>
                    {absentees.length > 0 && (
                      <Badge variant="destructive" className="ml-auto font-semibold">
                        {absentees.length}
                      </Badge>
                    )}
                  </div>

                  {absenteesLoading ? (
                    /* Skeleton rows while the absentee list loads */
                    <div className="space-y-2" aria-busy="true">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-border bg-muted">
                          <Skeleton className="h-4 w-4 rounded flex-shrink-0" />
                          <Skeleton className="h-4 flex-1 max-w-[55%]" />
                          <Skeleton className="h-8 w-8 rounded-lg flex-shrink-0" />
                          <Skeleton className="h-8 w-8 rounded-lg flex-shrink-0" />
                        </div>
                      ))}
                    </div>
                  ) : absentees.length === 0 ? (
                    <EmptyState icon={Check} title={t.noMissingAttendance} />
                  ) : (
                    <>
                      {/* Select-all + bulk-message toolbar */}
                      <div className="flex items-center justify-between mb-2 px-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            const withPhone = absentees.filter(p => p.office_phonenumber || p.personal_phonenumber);
                            const allSelected = withPhone.every(p => selectedAbsentees.has(p.epf_number));
                            setSelectedAbsentees(allSelected ? new Set() : new Set(withPhone.map(p => p.epf_number)));
                          }}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          {absentees.filter(p => p.office_phonenumber || p.personal_phonenumber).every(p => selectedAbsentees.has(p.epf_number)) && absentees.some(p => p.office_phonenumber || p.personal_phonenumber)
                            ? t.deselectAll
                            : t.selectAll}
                        </Button>
                        {selectedAbsentees.size > 0 && (
                          <Button
                            variant="success"
                            size="sm"
                            onClick={() => {
                              const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
                              if (isIOS) {
                                setShowBulkMsgModal(true);
                              } else {
                                const numbers = absentees
                                  .filter(p => selectedAbsentees.has(p.epf_number))
                                  .map(p => p.office_phonenumber || p.personal_phonenumber)
                                  .join(',');
                                const body = encodeURIComponent("Hi, your attendance for today hasn't been marked yet. Please mark your attendance as soon as possible. Thank you.");
                                window.open(`sms:${numbers}?body=${body}`, '_self');
                                setSelectedAbsentees(new Set());
                              }
                            }}
                          >
                            <MessageSquare className="w-3.5 h-3.5" />
                            {t.messageWord} {selectedAbsentees.size}
                          </Button>
                        )}
                      </div>

                      <Stagger className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
                        {absentees.map((person) => {
                          const phone = person.office_phonenumber || person.personal_phonenumber || null;
                          const isSelected = selectedAbsentees.has(person.epf_number);
                          return (
                            <StaggerItem
                              key={person.epf_number}
                              onClick={() => {
                                if (!phone) return;
                                setSelectedAbsentees(prev => {
                                  const next = new Set(prev);
                                  next.has(person.epf_number) ? next.delete(person.epf_number) : next.add(person.epf_number);
                                  return next;
                                });
                              }}
                              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all cursor-pointer ${isSelected
                                  ? 'bg-success/10 border-success/30'
                                  : 'bg-muted border-border hover:border-foreground/20'
                                } ${!phone ? 'opacity-50 cursor-default' : ''}`}
                            >
                              {/* Checkbox */}
                              <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border transition-colors ${isSelected ? 'bg-success border-success' : 'border-muted-foreground'
                                }`}>
                                {isSelected && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                              </div>

                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium text-foreground truncate">{person.name}</div>
                              </div>

                              {phone && (
                                <div className="flex items-center gap-1.5 flex-shrink-0" onClick={e => e.stopPropagation()}>
                                  <a
                                    href={`sms:${phone}?body=${encodeURIComponent(`Hi ${person.name}, your attendance for today hasn't been marked yet. Please mark your attendance as soon as possible. Thank you.`)}`}
                                    className="flex items-center justify-center w-8 h-8 rounded-lg bg-success/10 border border-success/20 text-success hover:bg-success/20 transition-colors"
                                    title={t.messageWord}
                                  >
                                    <MessageSquare className="w-3.5 h-3.5" />
                                  </a>
                                  <CallButton
                                    phone={phone}
                                    name={person.name}
                                    title={t.callWord}
                                    className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 text-primary hover:bg-primary/20 transition-colors"
                                    iconClassName="w-3.5 h-3.5"
                                  />
                                </div>
                              )}
                            </StaggerItem>
                          );
                        })}
                      </Stagger>
                    </>
                  )}
                </Card>
                </Reveal>
              )}
            </>
          )}
        </div>

        {/* ── Day Details Modal ── Portalled to <body>: a `fixed inset-0` overlay nested inside
            PageTransition (whose enter animation leaves an active transform in place) gets its
            containing block hijacked to PageTransition's own box instead of the viewport. */}
        <Portal>
        <AnimatePresence>
          {showDayModal && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
              onClick={e => e.target === e.currentTarget && setShowDayModal(false)}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                className="bg-popover border border-border rounded-xl shadow-card w-full max-w-sm max-h-[85dvh] flex flex-col"
              >
                <div className="flex items-center justify-between flex-shrink-0 p-6 pb-4">
                  <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
                    <Clock className="w-5 h-5 text-primary" />
                    {selectedDay?.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    {dayModalMode === 'submitPast' && <span className="text-xs px-2 py-0.5 rounded bg-primary/15 text-primary ml-1">{t.submit}</span>}
                    {dayModalMode === 'editRequest' && <span className="text-xs px-2 py-0.5 rounded bg-brand/15 text-brand ml-1">{t.editRequestBadge}</span>}
                    {dayModalMode === 'updateLocation' && <span className="text-xs px-2 py-0.5 rounded bg-primary/15 text-primary ml-1">{t.updateLocation}</span>}
                  </h2>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setShowDayModal(false)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-5 h-5" />
                  </Button>
                </div>

                {/* Scrollable body — days with many sessions can outgrow the viewport */}
                <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-6 pb-6">
                {dayModalMode === 'noRecord' ? (
                  /* ── Southern Lanka: no record for this day → read-only summary + edit request.
                     Fingerprint / mobile clock-ins are the only ways attendance is created here,
                     so a missed punch is corrected through an approved edit request, never a
                     manual direct entry. ── */
                  (() => {
                    const pend = pendingEditForSession(null);
                    const openEdit = () => {
                      setDayEditSessionId('');
                      setEditingRequestId(pend?.id ?? null);
                      setDayEditForm({
                        check_in: toLocalTime24h(pend?.requested?.check_in ?? ''),
                        check_out: toLocalTime24h(pend?.requested?.check_out ?? ''),
                        working_place: pend?.requested?.working_place ?? '',
                        site_number: pend?.requested?.site_number ?? '',
                        is_outstation: false, outstation_name: '', outstation_address: '',
                        reason: pend?.reason ?? '',
                      });
                      setDayModalMode('editRequest');
                    };
                    return (
                      <div className="space-y-3">
                        <ScheduledShiftsBanner shifts={dayScheduledShifts} label={t.scheduledShiftLabel} />
                        <div className="bg-muted border border-border rounded-xl p-3 space-y-2">
                          <span className="text-xs font-semibold text-foreground">{t.attendanceTitle}</span>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <div className="text-[10px] text-muted-foreground uppercase tracking-wide font-semibold mb-0.5">Check In</div>
                              <div className="text-sm font-bold font-mono text-muted-foreground">--:-- --</div>
                            </div>
                            <div>
                              <div className="text-[10px] text-muted-foreground uppercase tracking-wide font-semibold mb-0.5">Check Out</div>
                              <div className="text-sm font-bold font-mono text-muted-foreground">--:-- --</div>
                            </div>
                          </div>
                          <p className="text-[11px] text-muted-foreground">{t.noPunchesRecorded}</p>
                        </div>
                        {dayModalSpillover && (
                          <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2">
                            <CornerDownLeft className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                            <p className="text-[11px] text-foreground">
                              {t.spilloverCheckoutNote
                                .replace('{time}', formatTime(dayModalSpillover.time))
                                .replace('{date}', formatDate(dayModalSpillover.fromDate))}
                            </p>
                          </div>
                        )}
                        {pend ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={openEdit}
                            className="w-full text-warning hover:text-warning border-warning/30 hover:border-warning/50"
                          >
                            <AlertCircle className="w-3.5 h-3.5" /> {t.editPendingRequest}
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={openEdit}
                            className="w-full text-muted-foreground hover:text-primary hover:border-primary/30"
                          >
                            <Edit2 className="w-3.5 h-3.5" /> {t.requestAttendanceEdit}
                          </Button>
                        )}
                      </div>
                    );
                  })()
                ) : dayModalMode === 'editRequest' ? (
                  /* ── Edit request form for past attendance ── */
                  <div className="space-y-4">
                    <ScheduledShiftsBanner shifts={dayScheduledShifts} label={t.scheduledShiftLabel} />
                    {editingRequestId && (
                      <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-warning/10 border border-warning/20 text-warning text-xs">
                        <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                        <span>{t.editingPendingHint}</span>
                      </div>
                    )}
                    {/* Session picker only when creating a fresh request — editing a pending one is locked to its session */}
                    {!editingRequestId && ((dayModalData as any)?.sessions?.length ?? 0) > 1 && (
                      <div>
                        <label className="text-xs text-muted-foreground mb-1.5 block font-medium">{t.sessionToEdit}</label>
                        <select
                          value={dayEditSessionId || (dayModalData as any)?.sessions?.slice(-1)[0]?.id || ''}
                          onChange={e => {
                            const sid = e.target.value;
                            setDayEditSessionId(sid);
                            const sess = (dayModalData as any)?.sessions?.find((s: any) => s.id === sid);
                            if (sess) setDayEditForm(p => ({
                              ...p,
                              check_in: toLocalTime24h(sess.check_in),
                              check_out: toLocalTime24h(sess.check_out),
                              working_place: sess.working_place ?? '',
                              site_number: sess.site_number ?? '',
                              is_outstation: sess.is_outstation ?? false,
                              outstation_name: sess.outstation_name ?? '',
                              outstation_address: sess.outstation_address ?? '',
                            }));
                          }}
                          className="h-9 w-full bg-background border border-border rounded-md px-3 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                        >
                          {(dayModalData as any).sessions.map((s: any, i: number) => (
                            <option key={s.id} value={s.id}>
                              {t.sessionLabel.replace('{n}', String(i + 1))} ({s.check_in ? formatTime(s.check_in) : '--:--'} → {s.check_out ? formatTime(s.check_out) : t.openWord})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {/* min-w-0 on both columns (and both inputs) — a native type="time" control's
                        segmented HH:MM chrome can force intrinsic width past its grid track
                        without it, letting Check-out overlap/overflow past Check-in exactly the
                        way the type="month"/type="date" fields elsewhere on this page did. Below
                        sm: they stack to one field per row instead — min-w-0 alone still left
                        both segmented HH:MM controls visibly cramped side by side at phone
                        widths, even without literal overlap. */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="min-w-0">
                        {/* min-h-5, matching Check-out's label row below: that row only grows
                            past a bare label's own height when the overnight badge renders,
                            which pushed its input a few px lower than Check-in's on desktop,
                            where the two sit side by side (min- so a wrapped badge on a very
                            narrow screen can still grow the row instead of clipping — no
                            alignment to keep by then anyway, since sm:grid-cols-2 has already
                            stacked the two fields into separate rows). */}
                        <div className="flex min-h-5 items-center mb-1.5">
                          <label className="text-xs text-muted-foreground block font-medium">{t.checkInTime}</label>
                        </div>
                        <input type="time" value={dayEditForm.check_in}
                          onChange={e => setDayEditForm(p => ({ ...p, check_in: e.target.value }))}
                          className="h-9 w-full min-w-0 bg-background border border-border rounded-md px-3 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex min-h-5 items-center flex-wrap gap-1.5 mb-1.5">
                          <label className="text-xs text-muted-foreground block font-medium">{t.checkOutTime}</label>
                          {/* Shift working place + these two times land on the next calendar day
                              (see shiftRunsOvernight) → badge only; a same-day shift (e.g. 6am-6pm)
                              shows no badge and keeps the check-in's date. Never user-picked. */}
                          {(isSouthernlanka || placeHasTag(dayEditForm.working_place, 'shift')) && selectedDay
                            && dayEditForm.check_in && dayEditForm.check_out
                            && shiftRunsOvernight(dayEditForm.check_in, dayEditForm.check_out) && (
                            <Badge variant="brand" className="text-[9px] px-1.5 py-0.5 rounded flex items-center gap-1">
                              <Moon className="w-2.5 h-2.5" />
                              {new Date(selectedDay.getTime() + 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                            </Badge>
                          )}
                        </div>
                        <input type="time" value={dayEditForm.check_out}
                          onChange={e => setDayEditForm(p => ({ ...p, check_out: e.target.value }))}
                          className="h-9 w-full min-w-0 bg-background border border-border rounded-md px-3 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring" />
                      </div>
                    </div>

                    {/* Southern Lanka: fingerprint/face terminals are the only clock, so there's
                        no GPS-based place to ask about on a time correction — the section is
                        skipped entirely rather than shown-but-optional. Every other tenant
                        (mobile GPS check-in) still needs it, unchanged. */}
                    {!isSouthernlanka && (
                      <>
                        <div>
                          <div className="flex items-center flex-wrap gap-2 mb-1.5">
                            <label className="text-xs text-muted-foreground block font-medium">{t.workingPlaceLabel}</label>
                            {dayEditForm.working_place && <OutstationBadge date={selectedDayStr} place={dayEditForm.working_place} />}
                          </div>
                          <SmartWorkingPlaceSelect value={dayEditForm.working_place}
                            onChange={name => setDayEditForm(p => ({ ...p, working_place: name, site_number: requiresSite(name) ? p.site_number : '' }))} />
                        </div>

                        {requiresSite(dayEditForm.working_place) && (
                          <div>
                            <label className="text-xs text-muted-foreground mb-1 block font-medium">
                              {t.siteNumberLabel} <span className="text-destructive">*</span>
                            </label>
                            <input type="text" value={dayEditForm.site_number}
                              onChange={e => setDayEditForm(p => ({ ...p, site_number: e.target.value }))}
                              className={`h-9 w-full bg-background border rounded-md px-3 text-foreground text-sm focus:outline-none placeholder:text-muted-foreground ${!dayEditForm.site_number.trim() ? 'border-destructive/40 focus:border-destructive/60' : 'border-border focus:border-ring focus:ring-1 focus:ring-ring'}`}
                              placeholder={t.egSite} />
                            {!dayEditForm.site_number.trim() && (
                              <p className="text-[11px] text-destructive mt-1">{t.requiredForThisPlace}</p>
                            )}
                          </div>
                        )}
                      </>
                    )}

                    {/* Outstation is auto-derived from the working place vs the day's base — not declared here. */}

                    <div>
                      <label className="text-xs text-muted-foreground mb-1.5 block font-medium">
                        {t.reasonForEdit} <span className="text-destructive">*</span>
                      </label>
                      <textarea value={dayEditForm.reason}
                        onChange={e => setDayEditForm(p => ({ ...p, reason: e.target.value }))}
                        rows={3}
                        className="w-full bg-background border border-border rounded-md px-3 py-2.5 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring placeholder:text-muted-foreground resize-none"
                        placeholder={t.explainCorrection} />
                    </div>

                    <div className="flex gap-3">
                      <Button variant="outline" onClick={() => { setEditingRequestId(null); setDayModalMode(!dayModalData && isSouthernlanka ? 'noRecord' : 'view'); }}
                        className="flex-1 py-2.5 h-auto">
                        ← {t.backWord}
                      </Button>
                      <Button onClick={handleSubmitDayEditRequest} disabled={editReqLoading}
                        className="flex-1 py-2.5 h-auto font-semibold">
                        {editReqLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Edit2 className="w-4 h-4" />}
                        {editingRequestId ? t.updateRequest : t.submitRequest}
                      </Button>
                    </div>
                  </div>
                ) : dayModalMode === 'updateLocation' ? (
                  /* ── Add a location to a session (shared form; direct write) ── */
                  <UpdateSessionLocation
                    key={locSessionId ?? 'session'}
                    epfNumber={user?.epf_number ?? ''}
                    date={selectedDayStr || (dayModalData?.date ?? '').split('T')[0].split(' ')[0]}
                    sessionId={locSessionId}
                    onDone={async () => {
                      const dateStr = selectedDayStr || (dayModalData?.date ?? '').split('T')[0].split(' ')[0];
                      // Refresh the modal in place so the session card shows the new place.
                      try {
                        const res = await attendanceApi.getAttendanceByDate(user?.epf_number ?? '', dateStr);
                        const data = res.data?.data ?? res.data;
                        setDayModalData((data as any)?.attendance ?? (data as any)?.today_attendance ?? data);
                      } catch { /* non-critical — the card refreshes on next open */ }
                      setDayModalMode('view');
                      loadData(true);
                    }}
                    onCancel={() => setDayModalMode('view')}
                  />
                ) : dayModalMode === 'submitPast' ? (
                  <div className="space-y-4">
                    {/* Shift day → overnight (shift) attendance is available for this date */}
                    {dayShiftInfo && (
                      <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-brand/10 border border-brand/20">
                        <Moon className="w-4 h-4 text-brand flex-shrink-0" />
                        <div className="text-xs text-foreground">
                          <span className="font-semibold text-brand">Shift day</span>
                          <span className="text-muted-foreground ml-1">{dayShiftInfo.from_date} → {dayShiftInfo.to_date} · you can record an overnight shift below</span>
                        </div>
                      </div>
                    )}
                    {/* Times */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1.5 block font-medium">{t.checkInTime} <span className="text-destructive">*</span></label>
                        <input type="time" value={pastAttForm.check_in} onChange={e => setPastAttForm(p => ({ ...p, check_in: e.target.value }))} className="h-9 w-full bg-background border border-border rounded-md px-3 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring" />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1.5 block font-medium">{t.checkOutTime} <span className="text-destructive">*</span></label>
                        <input type="time" value={pastAttForm.check_out} onChange={e => setPastAttForm(p => ({ ...p, check_out: e.target.value }))} className="h-9 w-full bg-background border border-border rounded-md px-3 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring" />
                      </div>
                    </div>
                    {/* Working Place */}
                    <div>
                      <div className="flex items-center flex-wrap gap-2 mb-1.5">
                        <label className="text-xs text-muted-foreground block font-medium">{t.workingPlaceLabel} <span className="text-destructive">*</span></label>
                        {pastAttForm.working_place && <OutstationBadge date={selectedDayStr} place={pastAttForm.working_place} />}
                      </div>
                      <SmartWorkingPlaceSelect value={pastAttForm.working_place}
                        onChange={name => setPastAttForm(p => ({ ...p, working_place: name, site_number: requiresSite(name) ? p.site_number : '' }))} />
                    </div>
                    {/* Site */}
                    {requiresSite(pastAttForm.working_place) && (
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block font-medium">{t.siteNumberLabel} <span className="text-destructive">*</span></label>
                        <input type="text" value={pastAttForm.site_number} onChange={e => setPastAttForm(p => ({ ...p, site_number: e.target.value }))} className="h-9 w-full bg-background border border-border rounded-md px-3 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring placeholder:text-muted-foreground" placeholder={t.egSite} />
                      </div>
                    )}
                    {/* Multi-location: places already stashed for this submission (first = primary) */}
                    {pastLocs.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {pastLocs.map((l, i) => (
                          <span key={`${l.name}-${i}`} className="inline-flex items-center gap-1 text-[10px] font-medium pl-1.5 pr-0.5 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-primary max-w-full">
                            <MapPin className="w-2.5 h-2.5 flex-shrink-0" />
                            <span className="truncate">{l.name}{l.site_number ? ` · ${l.site_number}` : ''}</span>
                            <button
                              type="button"
                              aria-label="Remove"
                              onClick={() => setPastLocs(p => p.filter((_, j) => j !== i))}
                              className="rounded-full p-0.5 hover:bg-primary/20 transition-colors"
                            >
                              <X className="w-2.5 h-2.5" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    {/* Stash the picked place and clear the picker for the next one */}
                    {pastAttForm.working_place && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (requiresSite(pastAttForm.working_place) && !pastAttForm.site_number.trim()) {
                            toast.error(t.siteNumberRequiredForPlace); return;
                          }
                          setPastLocs(p => [...p, { name: pastAttForm.working_place, site_number: pastAttForm.site_number }]);
                          setPastAttForm(p => ({ ...p, working_place: '', site_number: '' }));
                        }}
                        className="w-full text-primary border-primary/30 hover:border-primary/50 hover:text-primary"
                      >
                        <MapPin className="w-3.5 h-3.5" /> {t.addAnotherLocation}
                      </Button>
                    )}
                    {/* Outstation is auto-derived from the working place vs the day's base — not declared here. */}
                    {/* Overnight shift toggle — only on days inside an allocated shift period */}
                    {dayShiftInfo && (
                      <>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <div onClick={() => setPastAttForm(p => ({ ...p, overnight: !p.overnight }))}
                            className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${pastAttForm.overnight ? 'bg-brand border-brand' : 'border-border bg-muted'}`}>
                            {pastAttForm.overnight && <Check className="w-3 h-3 text-primary-foreground" />}
                          </div>
                          <span className="text-xs text-foreground flex items-center gap-1.5">
                            <Moon className="w-3 h-3 text-brand" /> {t.checkoutNextDay}
                          </span>
                        </label>
                        {pastAttForm.overnight && selectedDay && (
                          <p className="text-[11px] text-brand/80 -mt-2 pl-6">
                            {t.checkoutRecordedOn.replace('{date}', new Date(selectedDay.getTime() + 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}
                          </p>
                        )}
                      </>
                    )}
                    <div className="flex gap-3">
                      {/* Back appears only when adding a session to a day that already has records */}
                      {dayModalData?.attendance_id && (
                        <Button variant="outline" onClick={() => setDayModalMode('view')}
                          className="flex-1 py-2.5 h-auto">
                          ← {t.backWord}
                        </Button>
                      )}
                      <Button onClick={handleSubmitPastAttendance} disabled={pastAttLoading} className="flex-1 py-2.5 h-auto font-semibold">
                        {pastAttLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {t.submit}
                      </Button>
                    </div>
                  </div>
                ) : dayModalLoading ? (
                  /* Skeleton mirroring a session detail card while the day's data loads */
                  <div className="space-y-3" aria-busy="true">
                    <div className="bg-muted border border-border rounded-xl p-3 space-y-3">
                      <Skeleton className="h-3 w-24" />
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Skeleton className="h-2.5 w-14" />
                          <Skeleton className="h-5 w-16" />
                        </div>
                        <div className="space-y-1.5">
                          <Skeleton className="h-2.5 w-14" />
                          <Skeleton className="h-5 w-16" />
                        </div>
                      </div>
                      <Skeleton className="h-3 w-2/3" />
                      <Skeleton className="h-8 w-full rounded-md" />
                    </div>
                  </div>
                ) : dayModalData ? (
                  <div className="space-y-3">
                    <ScheduledShiftsBanner shifts={dayScheduledShifts} label={t.scheduledShiftLabel} />
                    {/* Shift allocation banner (shift workers) */}
                    {dayShiftInfo && (
                      <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-brand/10 border border-brand/20">
                        <Moon className="w-4 h-4 text-brand flex-shrink-0" />
                        <div className="text-xs text-foreground">
                          <span className="font-semibold text-brand">{t.overnightShiftAllocated}</span>
                          <span className="text-muted-foreground ml-1">{dayShiftInfo.from_date} → {dayShiftInfo.to_date}</span>
                        </div>
                      </div>
                    )}

                    {/* Sessions — multi-session aware; falls back to a single card for legacy days */}
                    {(() => {
                      const raw = (dayModalData as any)?.sessions as any[] | undefined;
                      const list = (raw && raw.length) ? raw : [{
                        id: null,
                        check_in: dayModalData.check_in, check_out: dayModalData.check_out,
                        working_place: dayModalData.working_place, site_number: dayModalData.site_number,
                        locations: dayModalData.working_place
                          ? [{ name: dayModalData.working_place, site_number: dayModalData.site_number ?? null }]
                          : [],
                        is_outstation: dayModalData.is_outstation, outstation_name: dayModalData.outstation_name,
                        outstation_address: dayModalData.outstation_address,
                        check_in_approved_by: dayModalData.check_in_approved_by,
                        check_out_approved_by: dayModalData.check_out_approved_by,
                        is_overnight: false,
                      }];
                      const multi = list.length > 1;
                      return list.map((s: any, i: number) => (
                        <div key={s.id ?? i} className="bg-muted border border-border rounded-xl p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-foreground">{multi ? t.sessionLabel.replace('{n}', String(i + 1)) : t.attendanceTitle}</span>
                            {s.is_overnight && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-brand/15 border border-brand/30 text-brand">
                                <Moon className="w-2.5 h-2.5" /> {t.overnightWord}
                              </span>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <div className="text-[10px] text-muted-foreground uppercase tracking-wide font-semibold mb-0.5 flex items-center gap-1">
                                Check In
                                {s.check_in_approved_by ? <ShieldCheck className="w-3 h-3 text-success" /> : s.check_in ? <ShieldAlert className="w-3 h-3 text-warning" /> : null}
                              </div>
                              <div className="text-sm font-bold font-mono text-success">{s.check_in ? formatTime(s.check_in) : '--:--'}</div>
                            </div>
                            <div>
                              <div className="text-[10px] text-muted-foreground uppercase tracking-wide font-semibold mb-0.5 flex items-center gap-1">
                                Check Out
                                {s.check_out_approved_by ? <ShieldCheck className="w-3 h-3 text-success" /> : s.check_out ? <ShieldAlert className="w-3 h-3 text-warning" /> : null}
                              </div>
                              <div className="text-sm font-bold font-mono text-primary">
                                {s.check_out ? formatTime(s.check_out) : '--:--'}
                                {s.check_out && dayOffsetLabelFromStr(s.check_out, selectedDayStr) && (
                                  <span className="text-[10px] font-semibold text-warning ml-1">
                                    {dayOffsetLabelFromStr(s.check_out, selectedDayStr)}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          {((s.locations?.length ?? 0) > 0 || s.working_place || !!s.is_outstation) && (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {(s.locations?.length ?? 0) > 1 ? (
                                <SessionLocations locations={s.locations} showTime />
                              ) : (s.working_place || s.locations?.[0]?.name) ? (
                                <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                                  <MapPin className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                                  {s.working_place ?? s.locations?.[0]?.name}
                                  {s.site_number ? <span className="text-muted-foreground">· {s.site_number}</span> : null}
                                </span>
                              ) : null}
                              {!!s.is_outstation && (
                                <span className="inline-flex items-center gap-1 rounded-md border border-warning/20 bg-warning/10 px-1.5 py-0.5 text-[10px] font-bold text-warning">
                                  <AlertCircle className="w-2.5 h-2.5" /> Outstation
                                </span>
                              )}
                            </div>
                          )}
                          {(s.check_in_lat != null || s.check_out_lat != null) && (
                            <div className="flex items-center gap-3 text-[11px] text-muted-foreground pl-0.5">
                              <Crosshair className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                              {s.check_in_lat != null && (
                                <a href={mapsLink(s.check_in_lat, s.check_in_lng)} target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary/80">{t.checkInGps}</a>
                              )}
                              {s.check_out_lat != null && (
                                <a href={mapsLink(s.check_out_lat, s.check_out_lng)} target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary/80">{t.checkOutGps}</a>
                              )}
                            </div>
                          )}
                          {(s.check_in_site_name || s.check_out_within_radius != null) && (
                            <div className="flex flex-wrap items-center gap-1.5 pl-0.5">
                              {s.check_in_site_name && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-success/15 border border-success/30 text-success">
                                  <MapPin className="w-2.5 h-2.5" /> {s.check_in_site_name}{s.check_in_site_distance_m != null ? ` · ${s.check_in_site_distance_m}m` : ''}
                                </span>
                              )}
                              {s.check_out_within_radius != null && (
                                <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${s.check_out_within_radius ? 'bg-success/15 border-success/30 text-success' : 'bg-warning/15 border-warning/30 text-warning'}`}>
                                  <MapPin className="w-2.5 h-2.5" /> {t.checkOut} {s.check_out_within_radius ? t.inRange : t.outsideRange}{s.check_out_site_distance_m != null ? ` · ${s.check_out_site_distance_m}m` : ''}
                                </span>
                              )}
                            </div>
                          )}
                          {dayModalData.attendance_id && (() => {
                            // Per-session pending state: a pending request on THIS session becomes
                            // an "edit pending request" action; a pending request on another session
                            // never blocks this one.
                            const pend = pendingEditForSession(s);
                            const openEdit = () => {
                              setDayEditSessionId(s.id ?? '');
                              setEditingRequestId(pend?.id ?? null);
                              const inVal  = pend?.requested?.check_in  ?? s.check_in  ?? '';
                              const outVal = pend?.requested?.check_out ?? s.check_out ?? '';
                              setDayEditForm({
                                check_in: toLocalTime24h(inVal),
                                check_out: toLocalTime24h(outVal),
                                working_place: pend?.requested?.working_place ?? s.working_place ?? '',
                                site_number: pend?.requested?.site_number ?? s.site_number ?? '',
                                is_outstation: s.is_outstation ?? false,
                                outstation_name: s.outstation_name ?? '',
                                outstation_address: s.outstation_address ?? '',
                                reason: pend?.reason ?? '',
                              });
                              setDayModalMode('editRequest');
                            };
                            return pend ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={openEdit}
                                className="w-full text-warning hover:text-warning border-warning/30 hover:border-warning/50"
                              >
                                <AlertCircle className="w-3.5 h-3.5" /> {t.editPendingRequest}
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={openEdit}
                                className="w-full text-muted-foreground hover:text-primary hover:border-primary/30"
                              >
                                <Edit2 className="w-3.5 h-3.5" /> {multi ? t.editThisSession : t.requestAttendanceEdit}
                              </Button>
                            );
                          })()}
                          {dayModalData.attendance_id && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setLocSessionId(s.id ?? null);
                                setDayModalMode('updateLocation');
                              }}
                              className="w-full text-muted-foreground hover:text-primary hover:border-primary/30"
                            >
                              <MapPin className="w-3.5 h-3.5" /> {t.updateLocation}
                            </Button>
                          )}
                        </div>
                      ));
                    })()}

                    {/* Session-mode users can append another session to a past day. */}
                    {dayModalData.attendance_id && selectedDayIsPast && caps.multi_session && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditingRequestId(null);
                          setPastAttForm({
                            check_in: '', check_out: '', working_place: '', site_number: '',
                            is_outstation: false, outstation_name: '', outstation_address: '', overnight: false,
                          });
                          setPastLocs([]);
                          setDayModalMode('submitPast');
                        }}
                        className="w-full text-primary hover:text-primary border-primary/30 hover:border-primary/50"
                      >
                        <Check className="w-3.5 h-3.5" /> {t.addSession}
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    {t.noAttendanceDetails}
                  </div>
                )}

                {/* Meal bookings for the day being viewed (suspense/food module). Deliberately
                    NOT limited to the current meal slot the way the dashboard button is — the
                    user is looking at one specific day and may add any meal that day offers. */}
                {tenant.features.suspense && dayModalMode === 'view' && (
                  <div className="mt-4 pt-4 border-t border-border space-y-2">
                    <div className="flex items-center gap-2">
                      <UtensilsCrossed className="w-4 h-4 text-primary flex-shrink-0" />
                      <span className="text-sm font-semibold text-foreground">{t.addMealRequest}</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{t.mealsAvailableThatDay}</p>
                    {dayMealsLoading ? (
                      <Skeleton className="h-16 w-full rounded-xl" />
                    ) : dayChamaries.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t.noChamariesYet}</p>
                    ) : dayChamaries.map(c => (
                      <div key={c.id} className="bg-muted border border-border rounded-xl p-3 space-y-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-xs font-semibold text-foreground truncate">{c.name}</span>
                          <span className="text-[11px] text-muted-foreground truncate">· {c.working_place_name}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {chamaryMeals(c.meals).map(m => {
                            const key  = `${c.id}__${m}`;
                            const mine = myMealBooking(m);
                            const here = mine?.chamary_id === c.id;
                            // An off meal stays listed rather than vanishing, so the absence of
                            // (say) dinner reads as "not cooking" and not as a bug.
                            if (chamaryIsOff(c.id, m)) return (
                              <span key={key} className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground">
                                {mealLabel(m)} · {t.notCookingThatDay}
                              </span>
                            );
                            return (
                              <Button
                                key={key}
                                size="sm"
                                variant={here ? 'default' : 'outline'}
                                disabled={dayMealBusy === key}
                                onClick={() => (here ? cancelDayMeal(c, m) : bookDayMeal(c, m))}
                                className="h-7 px-2.5 text-[11px]"
                              >
                                {dayMealBusy === key
                                  ? <Loader2 className="w-3 h-3 animate-spin" />
                                  : here ? <Check className="w-3 h-3" /> : <UtensilsCrossed className="w-3 h-3" />}
                                {mealLabel(m)}{here ? ` · ${t.cancelMealWord}` : mine ? ` · ${t.moveHereWord}` : ''}
                              </Button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
        </Portal>

        {/* Calendar */}
        {/* No onMouseMove here any more. It re-rendered this whole page — DayPicker, 42 day
            cells and all — on every pointer move while a tooltip was open, purely to make the
            tooltip trail the cursor. The tooltip is now placed once, where the pointer entered
            the day, which is already beside the cell it describes. */}
        <Reveal as="div" delay={0.05}>
          <Card className="p-4 lg:sticky lg:top-0">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/20 flex items-center justify-center flex-shrink-0">
                <CalendarDays className="w-4 h-4 text-primary" />
              </div>
              <span className="text-sm font-semibold text-foreground">{t.attendanceCalendar}</span>
              {/* Getting back from March to now took one click per month and nothing said how
                  far you had gone. Shown only while the grid is off the current month, so it
                  never sits there as a control that does nothing. */}
              {!isSameMonth(calendarMonth, new Date()) && (
                <button
                  type="button"
                  onClick={() => {
                    const now = new Date();
                    setCalendarMonth(now);
                    setPreviewDay(null);
                    fetchCalendarDates(now);
                    fetchHolidays(now.getFullYear());
                    fetchCompanyHolidays(now.getFullYear());
                  }}
                  className="ml-auto rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {t.todayWord}
                </button>
              )}
            </div>
            <DayPicker
              mode="single"
              weekStartsOn={1}
              month={calendarMonth}
              onDayMouseEnter={(day, _m, e) => {
                const key = dayKey(day);
                // Self-explaining tooltip for ANY day that has data (not just holidays):
                // holiday name → worked → leave → edit status, joined with " · ".
                const sameDay = (arr?: Date[]) => !!arr?.some(
                  d => d.getFullYear() === day.getFullYear() && d.getMonth() === day.getMonth() && d.getDate() === day.getDate());
                const parts: string[] = [];
                // A company-observed holiday takes precedence in the label (its own custom name,
                // else the public holiday name, else a generic "Company Holiday").
                if (sameDay(companyHolidayDays)) parts.push(companyHolidayNames[key] ?? holidayNames[key] ?? t.companyHoliday);
                else if (holidayNames[key]) parts.push(holidayNames[key]);
                // Saturday is a half day, so 4h — not 8 — completes its half-circle gauge.
                // markNotes is the same function the cell's screen-reader note uses, so what a
                // hover says and what a screen reader hears can never disagree with the gauge.
                const worked = sameDay(workedDays);
                const rawHrs = Number(workedHours[key]);
                const hrs = Number.isFinite(rawHrs) && rawHrs > 0 ? rawHrs : 0;
                parts.push(...markNotes(
                  dayMark(hrs, day, worked, workExpectation),
                  hrs,
                  worked,
                  { halfDay: t.halfDay, workedDay: t.workedDay, loggedHours: t.loggedHoursLabel },
                ));
                if (sameDay(missingCheckoutDays)) parts.push(t.missingCheckout);
                if (sameDay(highlightedDays)) parts.push(t.leaveDay);
                if (sameDay(editRequestDates.pending)) parts.push(t.editPending);
                if (sameDay(editRequestDates.approved)) parts.push(t.editApproved);
                if (sameDay(editRequestDates.rejected)) parts.push(t.editRejected);
                const label = parts.join(' · ');
                if (label) setHolidayTooltip({ name: label, x: e.clientX, y: e.clientY });
                else setHolidayTooltip(null);
              }}
              onDayMouseLeave={() => setHolidayTooltip(null)}
              onMonthChange={(month) => {
                setCalendarMonth(month);
                // The picked-day panel belongs to the month it was picked in; leaving it up
                // under a different grid reads as a day of THAT month.
                setPreviewDay(null);
                fetchCalendarDates(month);
                fetchHolidays(month.getFullYear());
                fetchCompanyHolidays(month.getFullYear());
              }}
              onDayClick={async (day, modifiers) => {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const isPast = day < today;
                setEditingRequestId(null);
                // Cleared up front so a stale note from whichever day was open before this click
                // can't flash under the newly-opened one while the lookback below is in flight.
                setDayModalSpillover(null);
                // A click is the ONLY thing that picks a day. The summary under the grid then
                // stays put — including after the detail modal is closed — until the reader
                // dismisses it or picks another day.
                setPreviewDay(day);
                // Touch has no real hover: a tap synthesises onDayMouseEnter (which pins this
                // fixed, z-[9999] hint at the tap's raw x/y) but never the mouseleave that would
                // normally clear it, so on mobile it survived past the click and sat on top of
                // the day modal that opens right after — reading as a stray, half-clipped bar of
                // text floating over "Request Attendance Edit" / "Add session". A click always
                // means the hint's job (if any) is done, so it always gets dismissed here too.
                setHolidayTooltip(null);

                if (!modifiers.worked && !modifiers.highlighted && isPast) {
                  setSelectedDay(day);
                  setPastLocs([]);
                  // Southern Lanka has no manual direct-creation form — a day with no record
                  // shows the read-only summary + "Request Attendance Edit" instead.
                  if (isSouthernlanka) {
                    setDayModalData(null);
                    setDayModalLoading(false);
                    setDayModalMode('noRecord');
                    setShowDayModal(true);
                    // Best-effort, fire-and-forget: this date's own doc has no record, but a
                    // checkout within the 36h cross-day lookback (CHECKOUT_LOOKBACK_HOURS in
                    // shiftAutoClose.ts) is written back into the CHECK-IN day's own document —
                    // so check the 1-2 days before this one for a session whose checkout actually
                    // landed on this date, same window the backend itself allows.
                    const pad = (n: number) => String(n).padStart(2, '0');
                    const dateStr = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
                    (async () => {
                      for (const back of [1, 2]) {
                        const backDateStr = shiftDateStr(dateStr, -back);
                        try {
                          const res = await attendanceApi.getAttendanceByDate(user?.epf_number ?? '', backDateStr);
                          const data = res.data?.data ?? res.data;
                          const rec: any = data?.attendance ?? data?.today_attendance ?? data;
                          const sessions: any[] = rec?.sessions ?? ((rec?.check_in || rec?.check_out) ? [rec] : []);
                          const hit = sessions.find(s => s.check_out && String(s.check_out).slice(0, 10) === dateStr);
                          if (hit) { setDayModalSpillover({ time: hit.check_out, fromDate: backDateStr }); return; }
                        } catch {
                          // A failed lookback just means no note shows — never breaks the modal.
                        }
                      }
                    })();
                    return;
                  }
                  setDayModalMode('submitPast');
                  setPastAttForm({
                    check_in: '', check_out: '', working_place: '', site_number: '',
                    is_outstation: false, outstation_name: '', outstation_address: '', overnight: false,
                  });
                  setShowDayModal(true);
                  return;
                }

                if (!modifiers.worked) return;

                setSelectedDay(day);
                setDayModalMode('view');
                setShowDayModal(true);
                setDayModalLoading(true);
                setDayModalData(null);

                try {
                  const pad = (n: number) => String(n).padStart(2, '0');
                  const dateStr = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
                  const res = await attendanceApi.getAttendanceByDate(user?.epf_number ?? '', dateStr);
                  const data = res.data?.data ?? res.data;
                  // Handle different possible backend response shapes
                  setDayModalData(data?.attendance ?? data?.today_attendance ?? data);
                } catch (error) {
                  toast.error(t.failedLoadAttendanceDetails);
                  setShowDayModal(false);
                } finally {
                  setDayModalLoading(false);
                }
              }}
              selected={attendance?.check_in ? new Date(attendance.check_in) : undefined}
              components={{ DayContent: CalendarDay, Day: CalendarDayCell }}
              // ── DECLARATION ORDER IS THE PRECEDENCE ORDER. ──────────────────────────────
              // react-day-picker builds a day's active modifiers by iterating Object.keys of
              // THIS object and then merges modifiersStyles in that same order
              // (contexts/Modifiers/utils/getActiveModifiers → hooks/useDayRender/utils/
              // getDayStyle), so the LAST matching entry wins each CSS property. The order
              // below is therefore deliberate, weakest first:
              //   sunday          a weekday tint, must lose to anything factual
              //   worked          no style at all any more — the gauge in the cell says it
              //   highlighted     leave: a filled disc
              //   holiday         public holiday: a filled disc
              //   companyHoliday  the org's own accepted list — the authority, so it is last
              //   edit*           outline only, so it composes with whatever it lands on
              //
              // `saturday` is gone: it existed only to colour the digit amber, and that job is
              // now done by the half-circle gauge (see the Hours gauge section at the top).
              modifiers={{ sunday: { dayOfWeek: [0] }, worked: workedDays, missingCheckout: missingCheckoutDays, highlighted: highlightedDays, holiday: holidayDays, companyHoliday: companyHolidayDays, editPending: editRequestDates.pending, editApproved: editRequestDates.approved, editRejected: editRequestDates.rejected }}
              modifiersStyles={{
                sunday: {
                  color: '#ef4444',
                },
                // `worked` intentionally carries NO style. It used to paint a green disc AND a
                // green digit underneath a green ring — the same fact drawn three times, which
                // is what buried every exception in a month of ~20 worked days.
                highlighted: {
                  backgroundColor: LEAVE_TINT,
                  boxShadow: LEAVE_RIM,
                  borderRadius: '50%',
                  color: LEAVE_INK,
                  fontWeight: '600',
                },
                // REGRESSION FIX. `holiday` is the Calendarific feed, which silently yields
                // nothing whenever /api/holidays has no CALENDARIFIC_API_KEY or the upstream
                // call fails — fetchHolidays swallows both. On those loads a day like 26 or 27
                // August matched ONLY `companyHoliday`, and `companyHoliday` had no entry here
                // at all, so it rendered as a bare digit with just the small brand dot from
                // CalendarDayContent. Both sources now draw the same holiday disc, so the
                // org's own accepted list is enough on its own and the tint no longer depends
                // on a third-party feed being reachable.
                holiday: {
                  backgroundColor: HOLIDAY_TINT,
                  boxShadow: HOLIDAY_RIM,
                  borderRadius: '50%',
                  color: HOLIDAY_INK,
                  fontWeight: '600',
                },
                companyHoliday: {
                  backgroundColor: HOLIDAY_TINT,
                  boxShadow: HOLIDAY_RIM,
                  borderRadius: '50%',
                  color: HOLIDAY_INK,
                  fontWeight: '600',
                },
                // Rim only, never `border`: .rdp-button:focus-visible sets `border` to signal
                // keyboard focus, and an inline border here would silently outrank it.
                // The three colours come from EDIT_RING_COLORS, the same array the legend's
                // swatches read, so the key and the grid cannot be given different colours
                // for the same status — which is exactly how they had drifted before.
                editPending: {
                  outline: `2px solid ${EDIT_RING_COLORS[0]}`,
                  outlineOffset: '-2px',
                  borderRadius: '50%',
                },
                editApproved: {
                  outline: `2px solid ${EDIT_RING_COLORS[1]}`,
                  outlineOffset: '-2px',
                  borderRadius: '50%',
                },
                editRejected: {
                  outline: `2px solid ${EDIT_RING_COLORS[2]}`,
                  outlineOffset: '-2px',
                  borderRadius: '50%',
                },
              }}
              className="w-full"
            />
            {calendarLoading && (
              <div className="flex items-center justify-center gap-2 py-2 text-[11px] text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" />
                {t.loading}
              </div>
            )}
            {/* A failed month read is no longer indistinguishable from an empty month. */}
            {!calendarLoading && calendarError && (
              <div role="status" className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-[11px] text-warning">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                {/* Was an English literal on a page whose every other string is translated. */}
                <span>{t.failedLoadAttendanceDetails}</span>
                {/* The Firebase code, quoted verbatim: a user who reports "unavailable" or
                    "permission-denied" has already done the diagnosis. Muted so it never
                    competes with the sentence, and simply absent when there is no code. */}
                {calendarErrorCode && (
                  <code className="rounded bg-warning/10 px-1 py-px font-mono text-[10px] text-warning/80">
                    {calendarErrorCode}
                  </code>
                )}
                <button
                  type="button"
                  onClick={() => fetchCalendarDates(calendarMonth)}
                  className="rounded font-semibold underline underline-offset-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {t.tryAgain}
                </button>
              </div>
            )}

            {/* The picked day, summarised WHERE IT WAS PICKED — see SelectedDayCard for why it
                no longer evicts the check-in control. Today is excluded on purpose: today's
                answer, including a session still running, is the card above, and this panel
                reads only the month payload (which does not include an open session) so it
                would report "no hours" to somebody who is currently checked in. */}
            {previewDay && !isSameDay(previewDay, new Date()) && (
              <SelectedDayCard
                day={previewDay}
                hours={workedHours[dayKey(previewDay)]}
                worked={workedDays.some(d => isSameDay(d, previewDay))}
                onLeave={highlightedDays.some(d => isSameDay(d, previewDay))}
                holidayName={companyHolidayNames[dayKey(previewDay)] ?? holidayNames[dayKey(previewDay)] ?? null}
                missingCheckout={missingCheckoutDays.some(d => isSameDay(d, previewDay))}
                editState={
                  editRequestDates.pending.some(d => isSameDay(d, previewDay)) ? 'pending'
                  : editRequestDates.approved.some(d => isSameDay(d, previewDay)) ? 'approved'
                  : editRequestDates.rejected.some(d => isSameDay(d, previewDay)) ? 'rejected'
                  : null
                }
                onClear={() => setPreviewDay(null)}
                labels={{
                  loggedHours: t.loggedHoursLabel,
                  halfDay: t.halfDay,
                  leaveDay: t.leaveDay,
                  missingCheckout: t.missingCheckout,
                  editPending: t.editPending,
                  editApproved: t.editApproved,
                  editRejected: t.editRejected,
                  noDetails: t.noAttendanceDetails,
                  close: t.closeWord,
                }}
              />
            )}

            {/* Hidden entirely when the month failed to load, because zeros would then be a
                lie rather than a fact. */}
            {!calendarError && (
              <MonthSummary
                stats={monthStats}
                loading={calendarLoading}
                labels={{
                  loggedHours: t.loggedHoursLabel,
                  daysWorked: t.attendanceDays,
                  leaveDay: t.leaveDay,
                  publicHoliday: t.publicHoliday,
                  missingCheckout: t.missingCheckout,
                  extraHours: t.extraHoursLabel,
                  shortDays: t.shortDaysLabel,
                }}
              />
            )}

            <CalendarLegend
              labels={{
                workedDay: t.workedDay,
                halfDay: t.halfDay,
                leaveDay: t.leaveDay,
                publicHoliday: t.publicHoliday,
                companyHoliday: t.companyHoliday,
                missingCheckout: t.missingCheckout,
                selectedToday: t.selectedToday,
                editPending: t.editPending,
                editApproved: t.editApproved,
                editRejected: t.editRejected,
                whatMarksMean: t.legendWhatMarksMean,
                gaugeHint: t.legendGaugeHint,
                editRingHint: t.legendEditRingHint,
                noHours: t.legendNoHours,
                short: t.legendShort,
                fullDay: t.legendFullDay,
                extraHours: t.extraHoursLabel,
              }}
            />

            {holidayTooltip && (() => {
              // Flip the tooltip to the LEFT of the cursor when it's near the right edge, so it
              // never runs off-screen and gets clipped (the "Worked da…" bug on Sun/Sat columns).
              const nearRight = typeof window !== 'undefined' && holidayTooltip.x > window.innerWidth - 180;
              return (
                <div
                  className="fixed z-[9999] pointer-events-none px-2.5 py-1.5 rounded-lg bg-popover border border-border text-[11px] text-popover-foreground font-medium shadow-popover whitespace-nowrap max-w-[calc(100vw-1rem)]"
                  style={nearRight
                    ? { left: holidayTooltip.x - 14, top: holidayTooltip.y + 14, transform: 'translateX(-100%)' }
                    : { left: holidayTooltip.x + 14, top: holidayTooltip.y + 14 }}
                >
                  {holidayTooltip.name}
                </div>
              );
            })()}
          </Card>
        </Reveal>

      </div>

      {/* ── Bulk Message Modal (iOS) ── see the Portal note above. */}
      <Portal>
      <AnimatePresence>
        {showBulkMsgModal && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4"
            onClick={e => e.target === e.currentTarget && setShowBulkMsgModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }}
              className="bg-popover border border-border rounded-xl shadow-card p-5 w-full max-w-sm"
            >
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-success" />
                  <span className="text-sm font-semibold text-foreground">
                    {t.sendMessage} ({selectedAbsentees.size})
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShowBulkMsgModal(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>

              {/* Message preview + copy */}
              <div className="bg-muted border border-border rounded-xl p-3 mb-4">
                <p className="text-xs text-foreground leading-relaxed">
                  {"Hi [name], your attendance for today hasn't been marked yet. Please mark your attendance as soon as possible. Thank you."}
                </p>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard.writeText("your attendance for today hasn't been marked yet. Please mark your attendance as soon as possible. Thank you.");
                    toast.success(t.messageCopied);
                  }}
                  className="mt-2 h-auto p-0 gap-1.5"
                >
                  <Check className="w-3 h-3" /> {t.copyMessage}
                </Button>
              </div>

              {/* Per-person SMS links */}
              <Stagger className="space-y-2">
                {absentees
                  .filter(p => selectedAbsentees.has(p.epf_number))
                  .map(person => {
                    const phone = person.office_phonenumber || person.personal_phonenumber;
                    return (
                      <StaggerItem key={person.epf_number}>
                        <a
                          href={`sms:${phone}?body=${encodeURIComponent(`Hi ${person.name}, your attendance for today hasn't been marked yet. Please mark your attendance as soon as possible. Thank you.`)}`}
                          className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-success/10 border border-success/20 hover:bg-success/20 transition-colors"
                        >
                          <span className="text-sm font-medium text-foreground truncate">{person.name}</span>
                          <div className="flex items-center gap-1.5 text-success flex-shrink-0">
                            <MessageSquare className="w-3.5 h-3.5" />
                            <span className="text-xs">{phone}</span>
                          </div>
                        </a>
                      </StaggerItem>
                    );
                  })}
              </Stagger>

              <Button
                variant="outline"
                onClick={() => { setShowBulkMsgModal(false); setSelectedAbsentees(new Set()); }}
                className="mt-4 w-full py-2.5 h-auto"
              >
                {t.doneWord}
              </Button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </Portal>
    </PageTransition>
  );
}
