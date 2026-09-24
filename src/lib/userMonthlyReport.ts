'use client';
// Per-employee monthly attendance report (Users page → detail calendar → Download Excel).
// One .xlsx per employee for the selected month. Two layouts, chosen by role category:
//   • Technician  — full sheet incl. food-allowance columns + one column-pair per outstation.
//   • Executive / non-technician — no food/allowance columns, no outstation columns.
// Ported from the legacy MySQL report; field names mapped to this app's Firestore model
// (status 'approved' ↔ old 'accept'; is_paid boolean ↔ old paid='paid'; Medical identified
// by leave-type name/id 3). See computeUserMonthlyReport for each column's calculation.

import { addDays, differenceInCalendarDays, getDaysInMonth, parseISO, format } from 'date-fns';
import { canonPlaceName, stripSiteNo } from './placeName';
import { resolvePattern, expectedHoursFor, type WorkPattern, type PatternSubject } from './workPatterns';
import type { AppUser, AttendanceRecord, LeaveRecord, OutstationLocation, ScheduleAssignment } from './types';
import { mergeShiftBlocks, computeShortfallForDay, formatMinutes } from './attendanceShortfallEngine';
import { localDateString } from './utils';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Firestore Timestamp | {seconds} | Date | ISO string → epoch ms (null when absent/invalid).
function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'object') {
    const o = v as { toDate?: () => Date; seconds?: number };
    if (typeof o.toDate === 'function') return o.toDate().getTime();
    if (typeof o.seconds === 'number') return o.seconds * 1000;
    if (v instanceof Date) return v.getTime();
  }
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}

interface Sess {
  check_in?: unknown;
  check_out?: unknown;
  check_in_status?: string;
  check_in_approved_by?: string | null;
  check_out_status?: string;
  check_out_approved_by?: string | null;
  is_outstation?: boolean;
  outstation_location_id?: string | null;
  outstation_name?: string | null;
  working_place?: unknown;
  check_in_site_name?: string | null;
  morning_allowance?: number;
  evening_allowance?: number;
}

// Normalize a record into its sessions (back-compat with old single-session docs).
function recSessions(rec: AttendanceRecord): Sess[] {
  if (Array.isArray(rec.sessions)) return rec.sessions as unknown as Sess[];
  return [{
    check_in:               rec.check_in,
    check_out:              rec.check_out,
    check_in_status:        rec.check_in_status,
    check_in_approved_by:   rec.check_in_approved_by,
    check_out_status:       rec.check_out_status,
    check_out_approved_by:  rec.check_out_approved_by,
    is_outstation:          rec.is_outstation,
    outstation_location_id: rec.outstation_location_id,
    outstation_name:        rec.outstation_name,
    working_place:          rec.working_place,
    morning_allowance:      rec.morning_allowance,
    evening_allowance:      rec.evening_allowance,
  }];
}

// A check-in counts as an approved working session when it's been approved. In this app a
// check-in is "approved" either explicitly (check_in_approved_by set by an approver) or
// automatically (check_in_status === 'approved' with no request_from, so approved_by is null).
// A checkout approval counts as evidence too: overnight-shift sessions surface next day as a
// checkout-only card, so the approver may only ever have approved the checkout — the session
// was still reviewed and must count as a worked day.
function isApproved(s: Sess): boolean {
  return s.check_in_status === 'approved' || !!s.check_in_approved_by
      || s.check_out_status === 'approved' || !!s.check_out_approved_by;
}

function isSundayISO(ds: string): boolean {
  return new Date(ds + 'T00:00:00').getDay() === 0;
}

function isSaturdayISO(ds: string): boolean {
  return new Date(ds + 'T00:00:00').getDay() === 6;
}

function fmtHM(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

export interface UserMonthlyReport {
  isTechnician: boolean;
  company: string;
  name: string;
  epf: string;
  // The employee's last day, when they have one. The company report deliberately keeps a
  // leaver on the roster for a month they actually worked (see /reports), so the row has to
  // say so — otherwise a short month of working days reads as somebody who barely turned up.
  dateOfResign: string | null;
  // Day counts. FRACTIONAL when the tenant works a half Saturday (see saturdayHalfDay in
  // the options below): workingDays, the three leave figures and absentDays can all land on
  // a .5. Everything else here stays whole.
  workingDays: number;
  extraSunDays: number;
  outstationDays: number;
  foodCat1: number;
  foodCat2: number;
  checkoutAllowanceDays: number;
  foodPoints: number;
  totalLeaves: number;
  approvedLeaves: number;
  unapprovedLeaves: number;
  absentDays: number;
  paidMedical: number;
  nonPaidMedical: number;
  outstationByLoc: Array<{ name: string; days: number; minutes: number }>;
  // Shift work (technician sheet): a separate count of shift working days + total worked
  // hours grouped by the working place recorded that day.
  shiftWorkingDays: number;
  shiftByPlace: Array<{ name: string; minutes: number }>;
  // Σ of suspense-bill portions charged to this employee this month (another holder split a bill
  // with them) — a salary deduction. Pre-computed and passed in; the compute itself stays pure.
  suspenseDeduction: number;
}

/**
 * The first day on which the corrected leave count applies: from this date, a company holiday
 * or a rest day inside a leave is no longer charged as leave.
 *
 * Salary is paid for the 10th of one month to the 10th of the next. This is the first day of
 * the first pay period that was still unpaid when the correction was released, so no figure
 * behind a salary already paid changes. It is one date for every tenant, because it corrects a
 * shared rule rather than a policy that one organisation chose. Treat any change to it as a
 * payroll decision, not a code change.
 */
export const LEAVE_COUNT_CUTOFF = '2026-09-11';

export function computeUserMonthlyReport(opts: {
  user: AppUser;
  isTechnician: boolean;
  attendance: AttendanceRecord[];
  leaves: LeaveRecord[];
  outstations: OutstationLocation[];
  holidays: Set<string>;
  year: number;
  month: number;         // 1-based
  today?: string;        // yyyy-MM-dd (defaults to actual today); absent walk stops here
  // Poya (full-moon) dates in the year → set of 'yyyy-MM-dd'. Working one is an EXTRA day
  // even when the company didn't tick it in its accepted-holiday list.
  poyaDates?: Set<string>;
  // Shift inputs (technician sheet). A day is a "shift working day" when a roster assignment
  // covers it OR the day's working place is shift-tagged. shiftPlaceNames holds the names of
  // working places tagged 'shift' (any casing) — matched canonically, so a place recorded via
  // the Solar app as "<name> (#site-no)" still counts as the same place.
  shiftAssignments?: Array<{ from_date?: string; to_date?: string }>;
  shiftPlaceNames?: Set<string>;
  // This tenant works Saturday as a HALF day (TenantFeatures.saturdayHalfDay). A normal
  // Saturday then weighs 0.5 instead of 1 in workingDays, in the leave columns and in
  // absentDays. SHIFT work is exempt — a Saturday the roster covers is a whole day, because
  // a shift is a shift whatever the weekday. Left off, every day weighs 1 exactly as before.
  saturdayHalfDay?: boolean;
  // From this date (yyyy-MM-dd) onwards, a leave day is not charged when it falls on an
  // accepted company holiday or on a rest day of the employee's work pattern. Days before it
  // keep the old count, so a month that has already been reported does not change. Left out,
  // every day is charged exactly as before.
  leaveCountCutoff?: string;
  // The configured work patterns, and the employee they are resolved for. Only a rest day of a
  // configured, non-shift pattern changes the count. With no pattern the built-in week applies,
  // and it has no rest day, so the count stays exactly as before.
  workPatterns?: readonly WorkPattern[];
  patternSubject?: PatternSubject;
  // Suspense salary deduction for this employee this month (fetched separately, passed in).
  suspenseDeduction?: number;
}): UserMonthlyReport {
  const { user, isTechnician, attendance, leaves, outstations, holidays, year, month } = opts;
  const poyaDates        = opts.poyaDates        ?? new Set<string>();
  const shiftAssignments = opts.shiftAssignments ?? [];
  const shiftPlaceCanon  = new Set([...(opts.shiftPlaceNames ?? [])].map(canonPlaceName));
  const saturdayHalfDay  = opts.saturdayHalfDay ?? false;
  const leaveCountCutoff = opts.leaveCountCutoff ?? null;
  const workPatterns     = opts.workPatterns     ?? [];
  const patternSubject   = opts.patternSubject   ?? {};
  const mm         = String(month).padStart(2, '0');
  const daysInMo   = getDaysInMonth(new Date(year, month - 1));
  const monthStart = `${year}-${mm}-01`;
  const monthEnd   = `${year}-${mm}-${String(daysInMo).padStart(2, '0')}`;
  const today      = opts.today ?? format(new Date(), 'yyyy-MM-dd');

  /** Does the shift roster cover this date? Then the whole day is shift work. */
  const rosterCovers = (ds: string): boolean =>
    shiftAssignments.some(a => (a.from_date ?? '') <= ds && ds <= (a.to_date ?? ''));

  // How much of a working day this date is worth. On a half-Saturday tenant a Saturday is
  // 0.5 — but only as NORMAL work: a shift day is a whole day whatever the weekday, so a
  // rostered (or shift-place) Saturday still weighs 1. Every other day, and every day at a
  // tenant without the flag, weighs 1.
  const dayWeight = (ds: string, isShiftDay: boolean): number =>
    saturdayHalfDay && !isShiftDay && isSaturdayISO(ds) ? 0.5 : 1;

  let workingDays = 0, extraSunDays = 0, outstationDays = 0;
  // Days actually worked, UNWEIGHTED. Food points are meals eaten, not hours owed: somebody
  // who worked a half Saturday still ate that day, so J must not inherit the 0.5.
  let workedDayCount = 0;
  let foodCat1 = 0, foodCat2 = 0, checkoutAllowanceDays = 0;
  const checkInDates = new Set<string>();  // any check-in (approved or not) → not absent
  const locAgg = outstations.map(l => ({ id: l.id, name: l.name, days: 0, minutes: 0 }));
  const shiftDates = new Set<string>();               // distinct shift working days
  // Canonical place key → display name + minutes, so "Ranna 2MW" and a Solar-app
  // "Ranna 2MW (#123)" aggregate into ONE column.
  const shiftPlaceAgg = new Map<string, { name: string; minutes: number }>();

  attendance.forEach(rec => {
    const ds  = rec.date;
    let dayHasCheckIn = false;
    // Day-level flags: each record IS one calendar day (one attendance doc per day), and the
    // day columns (working / extra / outstation / per-location days) must count DAYS — a day
    // with several approved sessions is still one working day.
    let dayApproved = false, dayOutstation = false;
    const dayLocs = new Set<(typeof locAgg)[number]>();
    // A roster assignment covering this date makes the whole day a shift day.
    const dateIsRoster = rosterCovers(ds);
    let dayIsShift = false;
    recSessions(rec).forEach(s => {
      const hasCheckIn = toMs(s.check_in) != null;
      if (hasCheckIn) dayHasCheckIn = true;
      const approved = hasCheckIn && isApproved(s);

      if (approved) {
        dayApproved = true;                         // D (counted per day below)
        if (s.is_outstation) dayOutstation = true;  // F (per day below)
      }

      // Allowance day counts (spec: counted per row, no approval gate) — G / H / I
      if (s.morning_allowance === 1) foodCat1++;
      if (s.morning_allowance === 2) foodCat2++;
      if (s.evening_allowance === 1) checkoutAllowanceDays++;

      // Per-outstation days + hours (approved outstation sessions matching the location)
      if (approved && s.is_outstation) {
        for (const la of locAgg) {
          const nameMatch = !!s.outstation_name && !!la.name &&
            s.outstation_name.toLowerCase().includes(la.name.toLowerCase());
          const idMatch = s.outstation_location_id != null &&
            String(s.outstation_location_id) === String(la.id);
          if (idMatch || nameMatch) {
            dayLocs.add(la);
            const inMs = toMs(s.check_in), outMs = toMs(s.check_out);
            if (inMs != null && outMs != null && outMs > inMs) {
              la.minutes += Math.round((outMs - inMs) / 60000);
            }
          }
        }
      }

      // Shift work: an approved session counts as shift when the date is roster-covered OR the
      // session's place is shift-tagged. The place may be recorded by the Solar app as
      // "<name> (#site-no)" — or only exist as the GPS-matched check-in site — so match
      // canonically and fall back to the check-in site name. Hours are attributed to the
      // bare place name, same as regular working places.
      const place = stripSiteNo(s.working_place) || String(s.check_in_site_name ?? '').trim();
      const placeIsShift = !!place && shiftPlaceCanon.has(canonPlaceName(place));
      if (approved && (dateIsRoster || placeIsShift)) {
        dayIsShift = true;
        const inMs = toMs(s.check_in), outMs = toMs(s.check_out);
        if (place && inMs != null && outMs != null && outMs > inMs) {
          const key = canonPlaceName(place);
          const cur = shiftPlaceAgg.get(key) ?? { name: place, minutes: 0 };
          cur.minutes += Math.round((outMs - inMs) / 60000);
          shiftPlaceAgg.set(key, cur);
        }
      }
    });
    if (dayApproved) {
      workingDays += dayWeight(ds, dayIsShift);                  // D (0.5 on a half Saturday)
      workedDayCount++;
      // E: an "extra" day is work on a normally-off day — a Sunday, a Poya (full-moon) day,
      // or an accepted company holiday.
      if (isSundayISO(ds) || poyaDates.has(ds) || holidays.has(ds)) extraSunDays++;
      if (dayOutstation) outstationDays++;                       // F
    }
    dayLocs.forEach(la => la.days++);
    if (dayHasCheckIn) checkInDates.add(ds);
    if (dayIsShift)    shiftDates.add(ds);
  });

  const shiftWorkingDays = shiftDates.size;
  const shiftByPlace = [...shiftPlaceAgg.values()]
    .sort((a, b) => a.name.localeCompare(b.name));

  const foodPoints = workedDayCount * 3 + checkoutAllowanceDays * 3;   // J

  // ── Leave days in the month ──────────────────────────────────────────────────
  // Clamp each leave's [from,to] to the month boundaries; inclusive day count (diff + 1).
  // A leave straddling a month edge only contributes the portion inside this month.
  //
  // On a half-Saturday tenant the span is walked day by day instead of taken whole, so a
  // Saturday inside the range contributes 0.5. A leave day carries no working place, so the
  // only way to ask "was this a shift day?" is the roster — a Saturday the roster covers
  // stays a whole leave day, matching how the same Saturday would have counted as work.
  //
  // From leaveCountCutoff onwards, a leave day is not charged when nobody was expected to work
  // it: an accepted company holiday, or a rest day of the employee's own work pattern. A day
  // the roster covers is still charged, because a rostered person was expected to work it.
  const isPatternRestDay = (ds: string): boolean => {
    const date = parseISO(ds);
    const pattern = resolvePattern(date, workPatterns, patternSubject);
    // No configured pattern: the built-in week applies, and it has no rest day. A shift
    // pattern: rest depends on the roster, which rosterCovers already handles.
    if (!pattern || pattern.is_shift) return false;
    return expectedHoursFor(date, workPatterns, patternSubject) === 0;
  };

  const isUnchargedDay = (ds: string): boolean => {
    if (leaveCountCutoff === null || ds < leaveCountCutoff) return false;
    if (rosterCovers(ds)) return false;
    return holidays.has(ds) || isPatternRestDay(ds);
  };

  const leaveDaysInMonth = (l: LeaveRecord): number => {
    const from = l.from_date > monthStart ? l.from_date : monthStart;
    const to   = l.to_date   < monthEnd   ? l.to_date   : monthEnd;
    if (from > to) return 0;
    const span = differenceInCalendarDays(parseISO(to), parseISO(from)) + 1;
    if (!saturdayHalfDay && leaveCountCutoff === null) return span;
    const start = parseISO(from);
    let days = 0;
    for (let i = 0; i < span; i++) {
      const ds = format(addDays(start, i), 'yyyy-MM-dd');
      if (isUnchargedDay(ds)) continue;
      days += dayWeight(ds, rosterCovers(ds));
    }
    return days;
  };
  const isMedical = (l: LeaveRecord): boolean =>
    /medical/i.test(l.leave_type_name ?? '') || String(l.leave_type_id) === '3';

  let totalLeaves = 0, approvedLeaves = 0, unapprovedLeaves = 0;
  let paidMedical = 0, nonPaidMedical = 0;
  leaves.forEach(l => {
    const d = leaveDaysInMonth(l);
    if (d <= 0) return;
    totalLeaves += d;                                          // K
    if (l.status === 'approved') approvedLeaves += d;          // L
    else unapprovedLeaves += d;                                // M
    if (isMedical(l)) {
      if (l.is_paid) paidMedical += d;                         // O
      else nonPaidMedical += d;                                // P
    }
  });

  // ── Absent days ──────────────────────────────────────────────────────────────
  // Walk month-start … min(month-end, today, last day). A day is absent only if: not Sunday,
  // not a confirmed holiday, no check-in (approved OR not), and no non-rejected leave covers
  // it. A missed day costs what the day was worth, so on a half-Saturday tenant an absent
  // Saturday is 0.5 — otherwise skipping one would cost more than working it earned.
  // The walk also stops on the employee's LAST DAY (inclusive): somebody who resigned on the
  // 12th owes nothing for the 13th onwards, and counting those days would hand a leaver a
  // fortnight of absences in the very month they worked out their notice.
  const resignedOn = user.date_of_resign || null;
  let walkEnd = monthEnd < today ? monthEnd : today;
  if (resignedOn && resignedOn < walkEnd) walkEnd = resignedOn;
  let absentDays = 0;
  for (let day = 1; day <= daysInMo; day++) {
    const ds = `${year}-${mm}-${String(day).padStart(2, '0')}`;
    if (ds > walkEnd) break;                    // future / beyond today → never absent
    if (isSundayISO(ds)) continue;
    if (holidays.has(ds)) continue;
    if (checkInDates.has(ds)) continue;
    const onLeave = leaves.some(l =>
      l.status !== 'rejected' && l.from_date <= ds && l.to_date >= ds);
    if (onLeave) continue;
    absentDays += dayWeight(ds, rosterCovers(ds));             // N
  }

  return {
    isTechnician,
    company: user.company_name ?? '',
    name:    user.display_name ?? user.epf_number,
    epf:     user.epf_number,
    dateOfResign: resignedOn,
    workingDays, extraSunDays, outstationDays,
    foodCat1, foodCat2, checkoutAllowanceDays, foodPoints,
    totalLeaves, approvedLeaves, unapprovedLeaves, absentDays,
    paidMedical, nonPaidMedical,
    outstationByLoc: locAgg.map(l => ({ name: l.name, days: l.days, minutes: l.minutes })),
    shiftWorkingDays,
    shiftByPlace,
    suspenseDeduction: opts.suspenseDeduction ?? 0,
  };
}

// ─── Daily register (per-day detail sheet) ───────────────────────────────────────
// A one-row-per-day attendance sheet for a single employee/month, matching the legacy
// "MONTHLY ATTENDANCE" layout. Reads the record's top-level (migrated) fields when present —
// which is what that report showed — and falls back to the first session otherwise. "Shift
// Worker" is Yes when the shift roster covers the day OR the day's recorded place is a
// shift-tagged working place (matched canonically — Solar-app "(#site-no)" suffix ignored).
// Times are shown as stored (wall-clock, no TZ shift) to match the source report.

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayName(ds: string): string {
  return DAY_NAMES[new Date(ds + 'T00:00:00').getDay()];
}
function fmtDateTime(v: unknown): string {
  const ms = toMs(v);
  if (ms == null) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  // Use UTC components so the printed wall-clock equals the stored value (matches the
  // legacy report, which displayed the raw stored time without timezone conversion).
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export interface DailyRegisterRow {
  date: string; day: string;
  leave: string; leaveDuration: string;
  checkIn: string; checkOut: string;
  shiftWorker: string; workingHours: string; outstation: string;
  outstationName: string; outstationAddress: string;
  workingPlace: string; siteNumber: string;
}
export interface DailyRegister {
  name: string; epf: string; monthLabel: string;
  rows: DailyRegisterRow[];
}

export function buildDailyRegister(opts: {
  user: AppUser;
  attendance: AttendanceRecord[];
  leaves: LeaveRecord[];
  shiftAssignments: Array<{ from_date?: string; to_date?: string }>;
  // Names of working places tagged 'shift' — attendance at one marks the day a shift day.
  shiftPlaceNames?: Set<string>;
  year: number;
  month: number;
}): DailyRegister {
  const { user, attendance, leaves, shiftAssignments, year, month } = opts;
  const shiftPlaceCanon = new Set([...(opts.shiftPlaceNames ?? [])].map(canonPlaceName));

  const shiftOn = (ds: string) =>
    shiftAssignments.some(a => (a.from_date ?? '') <= ds && ds <= (a.to_date ?? ''));
  const atShiftPlace = (rec: AttendanceRecord) =>
    shiftPlaceCanon.size > 0 && recSessions(rec).some(s => {
      const place = stripSiteNo(s.working_place) || String(s.check_in_site_name ?? '').trim();
      return !!place && shiftPlaceCanon.has(canonPlaceName(place));
    });
  const leaveOn = (ds: string) =>
    leaves.find(l => l.status !== 'rejected' && l.from_date <= ds && l.to_date >= ds) ?? null;

  const rows: DailyRegisterRow[] = [...attendance]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(rec => {
      const ds = rec.date;
      // Prefer the migrated top-level fields (what the source report showed); else the first session.
      const useTop = rec.check_in != null || rec.check_out != null || rec.working_place != null;
      const firstSess = Array.isArray(rec.sessions) && rec.sessions[0] ? rec.sessions[0] as Sess : null;
      const s: Sess & { check_out?: unknown; working_place?: unknown; site_number?: unknown; outstation_address?: unknown } =
        useTop ? (rec as never) : (firstSess ?? (rec as never));
      const lv = leaveOn(ds);
      const isShiftWorker = shiftOn(ds) || atShiftPlace(rec);
      const inMs = toMs((s as { check_in?: unknown }).check_in);
      const outMs = toMs((s as { check_out?: unknown }).check_out);
      const workingHours = isShiftWorker && inMs != null && outMs != null && outMs > inMs
        ? fmtHM(Math.round((outMs - inMs) / 60000))
        : '';
      return {
        date: ds,
        day: dayName(ds),
        leave: lv?.leave_type_name ?? '',
        leaveDuration: lv ? (lv.is_half_day ? `Half day${lv.half_day_period ? ` (${lv.half_day_period})` : ''}` : 'Full day') : '',
        checkIn: fmtDateTime((s as { check_in?: unknown }).check_in),
        checkOut: fmtDateTime((s as { check_out?: unknown }).check_out),
        shiftWorker: isShiftWorker ? 'Yes' : 'No',
        workingHours,
        outstation: s.is_outstation ? 'Yes' : 'No',
        outstationName: (s.outstation_name as string) ?? '',
        outstationAddress: ((s as { outstation_address?: string }).outstation_address) ?? '',
        workingPlace: ((s as { working_place?: string }).working_place) ?? '',
        siteNumber: ((s as { site_number?: string }).site_number) ?? '',
      };
    });

  return {
    name: user.display_name ?? user.epf_number,
    epf: user.epf_number,
    monthLabel: `${MONTHS[month - 1]} ${year}`,
    rows,
  };
}

export async function exportDailyRegisterXlsx(
  reg: DailyRegister, year: number, month: number,
): Promise<void> {
  const { utils, writeFile } = await import('xlsx');
  const header = [
    'Date', 'Day', 'Leave', 'Leave Duration', 'Check In', 'Check Out',
    'Shift Worker', 'Working Hours', 'Outstation', 'Outstation Name', 'Outstation Address',
    'Working Place', 'Site Number',
  ];
  const aoa: (string | number)[][] = [
    [`MONTHLY ATTENDANCE — ${reg.name}`],
    ['EPF:', reg.epf],
    ['Month:', reg.monthLabel],
    [],
    header,
    ...reg.rows.map(r => [
      r.date, r.day, r.leave, r.leaveDuration, r.checkIn, r.checkOut,
      r.shiftWorker, r.workingHours, r.outstation, r.outstationName, r.outstationAddress,
      r.workingPlace, r.siteNumber,
    ]),
  ];
  const ws = utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 12 }, { wch: 6 }, { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 18 },
    { wch: 12 }, { wch: 13 }, { wch: 11 }, { wch: 18 }, { wch: 22 }, { wch: 16 }, { wch: 14 },
  ];
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, reg.monthLabel);
  writeFile(wb, `attendance_${safe(reg.name)}_${safe(reg.epf)}_${year}_${String(month).padStart(2, '0')}.xlsx`);
}

const safe = (s: string) => String(s).replace(/[^\w.-]+/g, '_');

export async function exportUserMonthlyReportXlsx(
  r: UserMonthlyReport, year: number, month: number,
): Promise<void> {
  const { utils, writeFile } = await import('xlsx');

  let header: string[];
  let values: (string | number)[];

  if (r.isTechnician) {
    header = [
      'COMPANY', 'EMPLOYEE NAME', 'EPF NO',
      'WORKING DAYS', 'EXTRA WORKING DAYS (SUN, POYA & HOLIDAYS)', 'OUTSTATION WORKING DAYS',
      'SHIFT WORKING DAYS',
      'FOOD ALLOWANCE CAT 1 DAYS', 'FOOD ALLOWANCE CAT 2 DAYS', 'CHECKOUT ALLOWANCE DAYS',
      'LUNCH & DINNER FOOD POINTS',
      'TOTAL LEAVES', 'APPROVED LEAVES', 'UNAPPROVED LEAVES', 'ABSENT DAYS',
      'PAID MEDICAL LEAVES', 'NON-PAID MEDICAL LEAVES',
    ];
    values = [
      r.company, r.name, r.epf,
      r.workingDays, r.extraSunDays, r.outstationDays,
      r.shiftWorkingDays,
      r.foodCat1, r.foodCat2, r.checkoutAllowanceDays,
      r.foodPoints,
      r.totalLeaves, r.approvedLeaves, r.unapprovedLeaves, r.absentDays,
      r.paidMedical, r.nonPaidMedical,
    ];
    r.shiftByPlace.forEach(sp => {
      header.push(`${sp.name} SHIFT HOURS`);
      values.push(fmtHM(sp.minutes));
    });
  } else {
    header = [
      'COMPANY', 'EMPLOYEE NAME', 'EPF NO',
      'WORKING DAYS', 'EXTRA WORKING DAYS (SUN, POYA & HOLIDAYS)', 'OUTSTATION WORKING DAYS',
      'TOTAL LEAVES', 'APPROVED LEAVES', 'UNAPPROVED LEAVES', 'ABSENT DAYS',
      'PAID MEDICAL LEAVES', 'NON-PAID MEDICAL LEAVES',
    ];
    values = [
      r.company, r.name, r.epf,
      r.workingDays, r.extraSunDays, r.outstationDays,
      r.totalLeaves, r.approvedLeaves, r.unapprovedLeaves, r.absentDays,
      r.paidMedical, r.nonPaidMedical,
    ];
  }

  const ws = utils.aoa_to_sheet([header, values]);
  ws['!cols'] = header.map((h, i) => ({
    wch: Math.max(String(h).length, String(values[i] ?? '').length) + 2,
  }));
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, `${MONTHS[month - 1]} ${year}`);

  writeFile(wb, `report_${safe(r.name)}_${safe(r.epf)}_${year}_${String(month).padStart(2, '0')}.xlsx`);
}

// ─── Company-wide category report (one row per employee) ──────────────────────────
// Two layouts, matching the per-employee export above but with every employee of a
// category on their own row:
//   • Technician sheet — food/allowance columns + one column-pair per outstation.
//   • Executive / non-technician sheet — no food/outstation columns.
// `outstationNames` fixes the technician sheet's per-outstation column order (every row
// shares the same outstation list, so columns line up); ignored for the executive sheet.
export async function exportCompanyCategoryReportXlsx(opts: {
  rows:            UserMonthlyReport[];
  isTechnician:    boolean;
  shiftPlaceNames: string[];  // ordered union of shift working places worked (technician sheet)
  year:            number;
  month:           number;
  companyLabel:    string;   // used in the file name (e.g. "All_Companies" or a company name)
  includeSuspense?: boolean; // suspense is a per-tenant module — omit its column where it's off
}): Promise<void> {
  const { rows, isTechnician, shiftPlaceNames, year, month, companyLabel, includeSuspense = true } = opts;
  const { utils, writeFile } = await import('xlsx');

  // Column appended only on tenants with the suspense module (header + row value stay in lockstep).
  const suspHeader = includeSuspense ? ['SUSPENSE DEDUCTION (LKR)'] : [];
  const suspValue  = (r: UserMonthlyReport) => (includeSuspense ? [r.suspenseDeduction] : []);

  // The report keeps an employee who left mid-month, because they worked (and must be paid
  // for) part of it — so the sheet has to name them as a leaver, or payroll cannot tell a
  // short month from a bad one. Last column, and only when this month actually has one: a
  // month nobody left produces exactly the sheet payroll has always received.
  const anyResigned  = rows.some(r => !!r.dateOfResign);
  const resignHeader = anyResigned ? ['RESIGNED ON'] : [];
  const resignValue  = (r: UserMonthlyReport) => (anyResigned ? [r.dateOfResign ?? ''] : []);

  let header: string[];
  let aoaRows: (string | number)[][];

  if (isTechnician) {
    header = [
      'COMPANY', 'EMPLOYEE NAME', 'EPF NO',
      'WORKING DAYS', 'EXTRA WORKING DAYS (SUN, POYA & HOLIDAYS)', 'OUTSTATION WORKING DAYS',
      'SHIFT WORKING DAYS',
      'FOOD ALLOWANCE CAT 1 DAYS', 'FOOD ALLOWANCE CAT 2 DAYS', 'CHECKOUT ALLOWANCE DAYS',
      'LUNCH & DINNER FOOD POINTS',
      'TOTAL LEAVES', 'APPROVED LEAVES', 'UNAPPROVED LEAVES', 'ABSENT DAYS',
      'PAID MEDICAL LEAVES', 'NON-PAID MEDICAL LEAVES',
      ...suspHeader,
      ...shiftPlaceNames.map(n => `${n} SHIFT HOURS`),
      ...resignHeader,
    ];
    aoaRows = rows.map(r => {
      const shiftByName = new Map(r.shiftByPlace.map(s => [s.name, s]));
      return [
        r.company, r.name, r.epf,
        r.workingDays, r.extraSunDays, r.outstationDays,
        r.shiftWorkingDays,
        r.foodCat1, r.foodCat2, r.checkoutAllowanceDays,
        r.foodPoints,
        r.totalLeaves, r.approvedLeaves, r.unapprovedLeaves, r.absentDays,
        r.paidMedical, r.nonPaidMedical,
        ...suspValue(r),
        ...shiftPlaceNames.map(n => fmtHM(shiftByName.get(n)?.minutes ?? 0)),
        ...resignValue(r),
      ];
    });
  } else {
    header = [
      'COMPANY', 'EMPLOYEE NAME', 'EPF NO',
      'WORKING DAYS', 'EXTRA WORKING DAYS (SUN, POYA & HOLIDAYS)', 'OUTSTATION WORKING DAYS',
      'TOTAL LEAVES', 'APPROVED LEAVES', 'UNAPPROVED LEAVES', 'ABSENT DAYS',
      'PAID MEDICAL LEAVES', 'NON-PAID MEDICAL LEAVES',
      ...suspHeader,
      ...resignHeader,
    ];
    aoaRows = rows.map(r => [
      r.company, r.name, r.epf,
      r.workingDays, r.extraSunDays, r.outstationDays,
      r.totalLeaves, r.approvedLeaves, r.unapprovedLeaves, r.absentDays,
      r.paidMedical, r.nonPaidMedical,
      ...suspValue(r),
      ...resignValue(r),
    ]);
  }

  const ws = utils.aoa_to_sheet([header, ...aoaRows]);
  ws['!cols'] = header.map((h, i) => ({
    wch: Math.max(String(h).length, ...aoaRows.map(r => String(r[i] ?? '').length)) + 2,
  }));
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, `${MONTHS[month - 1]} ${year}`);

  const kind = isTechnician ? 'technician' : 'executive';
  writeFile(wb, `report_${kind}_${safe(companyLabel)}_${year}_${String(month).padStart(2, '0')}.xlsx`);
}

// ─── Attendance View report (southernlanka "Download Report") ──────────────────
// A column-for-column spreadsheet mirror of the Attendance View page
// (src/app/(pages)/attendance-view/page.tsx). computeAttendanceViewReportRows reproduces
// that page's per-day present/absent tally and its monthly Late / Early totals using the
// SAME Attendance Cutoff & Shift Engine (mergeShiftBlocks + computeShortfallForDay), so the
// downloaded numbers always match what the page shows on screen. Late/Early are scored
// strictly against each day's SCHEDULED shift(s) — never a fixed clock-in cutoff — and a
// split day (non-contiguous same-day shifts) is paired session-for-session against its
// blocks, exactly as attendance-view does in cellsByEmployee.

export interface AttendanceViewRow {
  company:      string;
  employee_name: string;
  epf_number:   string;
  designation:  string;   // designation || role — same as the grid's frozen Employee column
  department:   string;
  presentDays:        number; // days with a check-in (grid status ontime | late | early)
  absentDays:         number; // past days with no check-in (grid status 'absent')
  lateArrivalDays:    number; // days with > 0 late minutes
  earlyDepartureDays: number; // days with > 0 early-departure minutes
  totalLateMinutes:           number; // month sum — the grid's "Late" column
  totalEarlyDepartureMinutes: number; // month sum — the grid's "Early" column
}

// Mirrors sessionsOf() in attendance-view/page.tsx: every punch cycle for the day, sorted
// chronologically by check-in. `sessions[]` is the source of truth; a legacy single-session
// doc falls back to the top-level check_in/check_out.
function attendanceSessionTimes(rec: AttendanceRecord | undefined): { checkIn: Date | null; checkOut: Date | null }[] {
  if (!rec) return [];
  if (rec.sessions && rec.sessions.length > 0) {
    return [...rec.sessions]
      .sort((a, b) => (a.check_in?.toMillis() ?? 0) - (b.check_in?.toMillis() ?? 0))
      .map(s => ({ checkIn: s.check_in?.toDate() ?? null, checkOut: s.check_out?.toDate() ?? null }));
  }
  if (rec.check_in || rec.check_out) {
    return [{ checkIn: rec.check_in?.toDate() ?? null, checkOut: rec.check_out?.toDate() ?? null }];
  }
  return [];
}

export function computeAttendanceViewReportRows(opts: {
  employees:   AppUser[];
  records:     AttendanceRecord[];
  assignments: ScheduleAssignment[]; // already bounded to the target month
  year:        number;
  month:       number;               // 1-12
}): AttendanceViewRow[] {
  const { employees, records, assignments, year, month } = opts;

  const daysInMonth = new Date(year, month, 0).getDate();
  const dates = Array.from({ length: daysInMonth }, (_, i) => new Date(year, month - 1, i + 1));
  const todayStr = localDateString();

  const recordsByKey = new Map<string, AttendanceRecord>();
  records.forEach(r => recordsByKey.set(`${r.epf_number}|${r.date}`, r));

  const assignmentsByKey = new Map<string, ScheduleAssignment[]>();
  assignments.forEach(a => {
    const key = `${a.epf_number}|${a.date}`;
    const list = assignmentsByKey.get(key) ?? [];
    list.push(a);
    assignmentsByKey.set(key, list);
  });

  return employees.map(emp => {
    let presentDays = 0, absentDays = 0, lateArrivalDays = 0, earlyDepartureDays = 0;
    let totalLateMinutes = 0, totalEarlyDepartureMinutes = 0;

    for (const d of dates) {
      const dateStr = localDateString(d);
      const record = recordsByKey.get(`${emp.epf_number}|${dateStr}`);
      const shiftBlocks = mergeShiftBlocks(assignmentsByKey.get(`${emp.epf_number}|${dateStr}`) ?? []);
      const sessions = attendanceSessionTimes(record);

      // Pair each scheduled block with its own session in chronological order — a split day
      // gets one session per block, never one session spanning both (see cellsByEmployee).
      let dayLate = 0, dayEarly = 0;
      shiftBlocks.forEach((block, i) => {
        const session = sessions[i] ?? null;
        const { lateMinutes, earlyDepartureMinutes } =
          computeShortfallForDay(block, session?.checkIn ?? null, session?.checkOut ?? null);
        dayLate += lateMinutes;
        dayEarly += earlyDepartureMinutes;
      });

      // Monthly Late/Early totals — summed across every day, exactly like monthlyTotals.
      totalLateMinutes += dayLate;
      totalEarlyDepartureMinutes += dayEarly;
      if (dayLate > 0) lateArrivalDays++;
      if (dayEarly > 0) earlyDepartureDays++;

      // Per-day status → present / absent (grid rule: a check-in ⇒ present; otherwise a past
      // day is 'absent' and a future day is blank / counted as neither).
      if ((sessions[0]?.checkIn ?? null) !== null) presentDays++;
      else if (dateStr <= todayStr) absentDays++;
    }

    return {
      company: emp.company_name,
      employee_name: emp.display_name,
      epf_number: emp.epf_number,
      designation: emp.designation || emp.role,
      department: emp.department,
      presentDays, absentDays, lateArrivalDays, earlyDepartureDays,
      totalLateMinutes, totalEarlyDepartureMinutes,
    };
  });
}

export async function exportAttendanceViewReportXlsx(opts: {
  rows:         AttendanceViewRow[];
  year:         number;
  month:        number;
  companyLabel: string;   // "All_Companies" or a company name — used in the file name
}): Promise<void> {
  const { rows, year, month, companyLabel } = opts;
  const { utils, writeFile } = await import('xlsx');

  const header = [
    'COMPANY', 'EMPLOYEE NAME', 'EPF NO', 'DESIGNATION / ROLE', 'DEPARTMENT',
    'PRESENT DAYS', 'ABSENT DAYS', 'LATE ARRIVAL DAYS', 'EARLY DEPARTURE DAYS',
    'TOTAL LATE', 'TOTAL EARLY DEPARTURE',
    'TOTAL LATE (MINUTES)', 'TOTAL EARLY DEPARTURE (MINUTES)',
  ];
  const aoaRows: (string | number)[][] = rows.map(r => [
    r.company, r.employee_name, r.epf_number, r.designation, r.department,
    r.presentDays, r.absentDays, r.lateArrivalDays, r.earlyDepartureDays,
    formatMinutes(r.totalLateMinutes), formatMinutes(r.totalEarlyDepartureMinutes),
    r.totalLateMinutes, r.totalEarlyDepartureMinutes,
  ]);

  const ws = utils.aoa_to_sheet([header, ...aoaRows]);
  ws['!cols'] = header.map((h, i) => ({
    wch: Math.max(String(h).length, ...aoaRows.map(row => String(row[i] ?? '').length)) + 2,
  }));
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, `${MONTHS[month - 1]} ${year}`);
  writeFile(wb, `attendance_view_${safe(companyLabel)}_${year}_${String(month).padStart(2, '0')}.xlsx`);
}
