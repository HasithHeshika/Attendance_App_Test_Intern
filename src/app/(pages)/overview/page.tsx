'use client';
import { useState, useEffect, useCallback, useRef, useMemo, type ComponentProps, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import dynamic from 'next/dynamic';
import {
  Loader2, ChevronLeft, ChevronRight, RefreshCw, LayoutDashboard, ChevronDown, ChevronUp, Download, FileSpreadsheet, FileText, Map as MapIcon, MoreHorizontal, CalendarDays, X, Info, Search, User,
} from 'lucide-react';
import { format, addMonths, subMonths, getDaysInMonth, startOfMonth, isSameMonth, isAfter, startOfDay, getDay } from 'date-fns';
import { getDocs, query, collection, where } from 'firebase/firestore';
import { db, tenant } from '@/lib/firebase';
import { isValidLatLng } from '@/lib/geo';
import { specialLeaveOn, cn, formatTime } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities, useRoles } from '@/store/rolesStore';
import { useCompanyContext } from '@/store/companyContextStore';
import { useT } from '@/store/appStore';
import { roleCan } from '@/lib/permissions';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { DashboardSkeleton } from '@/components/ui/Skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageTransition, Reveal } from '@/components/ui/motion';
import { useOverviewDay } from '@/hooks/useOverviewDay';
import { getScheduleAssignmentsForRange } from '@/services/scheduleAssignmentService';
import { normalizeSessions, toDisplayTime, type DayPerson } from '@/lib/overviewData';
import OverviewDateControl from '@/components/overview/OverviewDateControl';
import PeoplePanel from '@/components/overview/PeoplePanel';
import PersonDossier from '@/components/overview/PersonDossier';
import OverviewKpiBand, { type OverviewCore } from '@/components/overview/OverviewKpiBand';
import HolidayTooltipChip, { type HolidayStaffInfo } from '@/components/overview/HolidayTooltipChip';
import BirthdayTooltipChip, { type BirthdayPersonInfo } from '@/components/overview/BirthdayTooltipChip';
import OverviewMonthModal from '@/components/overview/OverviewMonthModal';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getHolidaySettings } from '@/services/holidayService';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import toast from 'react-hot-toast';
import {
  buildMonthRegister, exportRegisterCsv, exportRegisterXlsx, exportRegisterPdf,
} from '@/lib/attendanceExport';
import SearchableSelect, { type SearchOption } from '@/components/SearchableSelect';

/* ── The period map's payload ─────────────────────────────────────────────────────────────
   These are the period-map design spec's §3b shapes, written out here rather than imported.
   The shared `src/lib/overviewMapPoints.ts` is landing in a parallel change and every one of
   these is structural, so the day it arrives these declarations collapse into one import and
   not a single call site below moves. */

/** One in-session location ping, out of `sessions[].locations[]`. */
type MapUpdate = { lat: number; lng: number; name: string; atMs: number | null; accuracyM: number | null };

/** The widened session the map needs. `overviewData.SessionView` keeps the CHECK-IN fix and
 *  nothing else, so a month map built on it would plot half of what the attendance document
 *  already holds and bin the rest — every field below is on the raw doc today. */
type MapSession = {
  checkIn: string | null; checkOut: string | null;
  lat: number | null; lng: number | null;
  place: string | null; outstation: boolean; outOfRadius: boolean | null;
  outLat: number | null; outLng: number | null;
  accuracyM: number | null; outAccuracyM: number | null;
  siteId: string | null;
  updates: MapUpdate[];
};
type MapPerson = { epf: string; name: string; sessions: MapSession[] };
type MapDay = { date: string; people: MapPerson[] };
type MapKind = 'checkin' | 'checkout' | 'update';

/** What the map gains for period mode. Every prop is optional by contract — an absent `days`
 *  is byte-identical to the single-day map — which is exactly what lets this half of the
 *  change compile before the component's half lands. The INTERSECTION below is deliberate and
 *  is not a blanket cast: the moment SriLankaMap declares these itself, the two declarations
 *  have to agree or the intersection stops accepting the values passed to it. Delete it, and
 *  the types above, when the component and `overviewMapPoints.ts` are both in. */
type PeriodMapProps = {
  days?: readonly MapDay[] | null;
  kinds?: readonly MapKind[];
  onOpenDay?: (date: string) => void;
  summaryLine?: string | null;
};

// Dynamically import SriLankaMap to keep Leaflet off the initial bundle
const SriLankaMapBase = dynamic(() => import('@/components/overview/SriLankaMap'), { ssr: false });
const SriLankaMap = SriLankaMapBase as ComponentType<ComponentProps<typeof SriLankaMapBase> & PeriodMapProps>;

/** The month's positions, keyed by (month, company). The extraction is pure and the input is
 *  a read the page already makes, so this saves the rebuild — not reads — when the reader
 *  pages back to a month they have already looked at. Cleared by Refresh. */
const monthMapCache = new Map<string, MapDay[]>();

// Southern Lanka runs on shift assignments (schedule_assignments — same collection /schedule
// and /attendance-view use), not a fixed working-week — see the Present/Absent/No-Shift model
// in loadMonth and the useOverviewDay call below. Every other tenant keeps the original
// "every non-Sunday day is a working day for everyone" formula untouched.
const isSouthernlanka = tenant.id === 'southernlanka';

// Firestore hands back a Timestamp for check_in / check_out. `overviewData`'s own
// toDisplayTime already knows how to normalise Timestamp | {seconds} | Date | "HH:MM", but it
// is module-private, so the month extractor carries its own copy. Fold the two together the
// moment that helper is exported — a time should have one answer, not two.
function clockOf(v: any): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return formatTime(v);
  const d =
    typeof v?.toDate === 'function' ? v.toDate() :
    typeof v?.seconds === 'number' ? new Date(v.seconds * 1000) :
    v instanceof Date ? v : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  const h = d.getHours();
  return `${String(h % 12 || 12).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fix = (lat: any, lng: any): [number, number] | null =>
  typeof lat === 'number' && typeof lng === 'number' && isValidLatLng(lat, lng) ? [lat, lng] : null;

function toMsEpoch(v: any): number | null {
  if (v == null) return null;
  if (typeof v?.toDate === 'function') { const d = v.toDate(); return Number.isNaN(d.getTime()) ? null : d.getTime(); }
  if (typeof v?.seconds === 'number') return v.seconds * 1000;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'string') { const ms = Date.parse(v); return Number.isNaN(ms) ? null : ms; }
  return null;
}

function toMapUpdates(raw: any): MapUpdate[] {
  if (!Array.isArray(raw)) return [];
  const out: MapUpdate[] = [];
  for (const u of raw) {
    const at = fix(u?.lat, u?.lng);
    if (!at) continue;
    out.push({ lat: at[0], lng: at[1], name: String(u?.name ?? ''), atMs: toMsEpoch(u?.added_at), accuracyM: num(u?.accuracy_m) });
  }
  // added_at order, the order they were recorded in. Pings without a timestamp keep their
  // document order rather than being sorted to the front.
  return out.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
}

/** Every position the month's attendance documents already carry, grouped by day.
 *
 *  This costs ZERO extra reads. `loadMonth` has always fetched the whole month of attendance
 *  — GPS and all — used it to count heads, and then dropped the coordinates on the floor.
 *  A session with no fix anywhere is skipped outright: it has nothing to plot and would only
 *  inflate what the browser holds for the month. */
function buildMonthMapDays(
  docs: readonly { data(): any }[],
  empEpfs: Set<string>,
  nameByEpf: Map<string, string>,
): MapDay[] {
  const byDate = new Map<string, Map<string, MapPerson>>();
  for (const doc of docs) {
    const a = doc.data();
    const epf = a.epf_number as string;
    const date = typeof a.date === 'string' ? a.date : '';
    if (!date || !empEpfs.has(epf) || a.is_deleted) continue;

    const sessions: MapSession[] = [];
    for (const s of normalizeSessions(a)) {
      const inAt = fix(s.check_in_lat, s.check_in_lng);
      const outAt = fix(s.check_out_lat, s.check_out_lng);
      const updates = toMapUpdates(s.locations);
      if (!inAt && !outAt && updates.length === 0) continue;
      sessions.push({
        checkIn: clockOf(s.check_in), checkOut: clockOf(s.check_out),
        lat: inAt?.[0] ?? null, lng: inAt?.[1] ?? null,
        outLat: outAt?.[0] ?? null, outLng: outAt?.[1] ?? null,
        place: s.check_in_site_name ?? s.working_place ?? null,
        outstation: !!s.is_outstation,
        outOfRadius: s.check_out_within_radius == null ? null : !s.check_out_within_radius,
        accuracyM: num(s.check_in_accuracy_m), outAccuracyM: num(s.check_out_accuracy_m),
        siteId: s.check_in_site_id ?? null,
        updates,
      });
    }
    if (!sessions.length) continue;

    let day = byDate.get(date);
    if (!day) { day = new Map<string, MapPerson>(); byDate.set(date, day); }
    const person = day.get(epf) ?? { epf, name: nameByEpf.get(epf) ?? epf, sessions: [] };
    person.sessions.push(...sessions);
    day.set(epf, person);
  }
  return [...byDate.entries()]
    .map(([date, people]) => ({ date, people: [...people.values()] }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/* ── Scoping ──────────────────────────────────────────────────────────────────────────────
   The sentinels are deliberately unspellable as a real department name: `department` on the
   user document is a free-text name, so `'all'` and `''` are both values somebody could
   plausibly have typed into it. */
const DEPT_ALL = '__all_departments__';
const DEPT_NONE = '__no_department__';

/** The design spec's hard cap. 300 people × 26 days × three kinds is ~23,000 raw points
 *  before clustering; past this the bucketing pass stops being free. Over it, the cheapest
 *  information goes first — in-session updates, then check-outs — and the reader is told, in
 *  words, on screen. A map that quietly stopped drawing half of what was asked for is worse
 *  than one that says it cannot. */
const POINT_CAP = 40000;

interface DaySummary {
  date: string; present: number; onLeave: number; missing: number; total: number;
  // Southern Lanka only — people with no shift assigned this date at all (see loadMonth).
  // Always 0 for every other tenant, and never affects `total`/`missing`'s meaning for them.
  unscheduled?: number;
  birthdays: string[];
  birthdayPeople?: BirthdayPersonInfo[];
  presentPeople?: HolidayStaffInfo[];
}
interface Company { id: string; name: string; }

/** Headcount that the day figures deliberately do NOT show: everyone still on the books,
 *  including roles with no attendance, plus this month's leavers. */
interface Headcount { activeTotal: number; resignedThisMonth: number }

/** Attendance still marked pending on a date before today, within the displayed month. Counted
 *  exactly the way attendanceService.getAllPendingApprovals defines "pending" — either end of
 *  the day is still waiting on a decision. */
interface PendingSummary { count: number; oldest: string | null }

function AdminDashboardContent() {
  const { user } = useAuthStore();
  const caps = useUserCapabilities();
  const { roles } = useRoles();
  const seesAllCompanies = caps.is_system_admin || caps.can_manage_users || caps.can_report;
  const seesApprovalBacklog = caps.is_system_admin || caps.can_approve || caps.can_report;
  // The Top Navbar's Global Company Selector is the single source of truth for a
  // can_manage_all_companies/is_system_admin holder — see the sync effect below, which keeps
  // `selectedCo` (a company NAME, the shape every reader below already expects) mirroring it
  // instead of this page owning a second, independent pick. A user who sees company-wide data
  // here WITHOUT that capability (can_manage_users/can_report only) gets no header selector at
  // all, so their local dropdown stays — removing it would leave them with no way to scope the
  // page and no replacement control, which is not what "single source of truth" asked for.
  const companyContext = useCompanyContext();

  const [companies,    setCompanies]    = useState<Company[]>([]);
  const [selectedCo,  setSelectedCo]   = useState<string>('all');
  const [holidays,    setHolidays]     = useState<Record<string, string>>({});
  const holidayYears  = useRef<Set<number>>(new Set());

  const [calMonth,    setCalMonth]     = useState(new Date());
  const t = useT();
  const [selectedDay, setSelectedDay]  = useState(format(new Date(), 'yyyy-MM-dd'));
  const [calData,     setCalData]      = useState<Record<string, DaySummary>>({});
  const [loadingCal,  setLoadingCal]   = useState(false);
  // The month strip is a dialog now, not a band that costs a screenful on every visit.
  const [monthOpen, setMonthOpen] = useState(false);
  const [focusedEpf,  setFocusedEpf]  = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [headcount,   setHeadcount]    = useState<Headcount>({ activeTotal: 0, resignedThisMonth: 0 });
  const [pending,     setPending]      = useState<PendingSummary>({ count: 0, oldest: null });
  const [dossierEpf,  setDossierEpf]   = useState<string | null>(null);
  const [mapOpen,     setMapOpen]      = useState(false);
  // The map's own SriLankaMap height prop is a hard pixel NUMBER (Leaflet needs a real
  // computed height, not a CSS percentage, to size its tile layer correctly) — it was
  // hardcoded to 520, which on a real desktop monitor left the map a small, cropped canvas
  // with acres of unused space around it in the dialog. Computed once per open from the
  // CURRENT window.innerHeight instead — genuinely viewport-based without needing Leaflet's
  // own resize-invalidation machinery (it only re-measures on this state changing, i.e. once
  // per open, not continuously while the window is being dragged).
  const [mapHeight, setMapHeight] = useState(520);
  useEffect(() => {
    if (!mapOpen || typeof window === 'undefined') return;
    // ~260px reserved for the dialog's own header, range/filter controls and padding;
    // floored so a tiny window never makes the map unusably small, capped so an ultra-tall
    // monitor doesn't turn it into a needlessly enormous canvas.
    setMapHeight(Math.max(420, Math.min(window.innerHeight - 260, 760)));
  }, [mapOpen]);

  // ── Scope: department ──
  // `department` is a free-text name on the user document and there is no departments
  // collection to read, so the list is DERIVED from the roll `loadMonth` already fetched.
  // Zero extra reads: `deptByEpf` is filled from the same `fetchUsersRaw()` result that
  // feeds the headcount tile.
  const [deptByEpf,   setDeptByEpf]    = useState<Record<string, string>>({});
  const [selectedDept, setSelectedDept] = useState<string>(DEPT_ALL);

  // ── The month's positions, for the period map ──
  // `monthErr` exists because `loadMonth` used to swallow every failure (`catch { }`). That
  // cost a calendar strip before; with a map behind it, a failed read would draw a confident,
  // empty, WRONG map — the reader would see "nobody was anywhere this month" and believe it.
  const [monthDays,   setMonthDays]    = useState<MapDay[] | null>(null);
  const [monthErr,    setMonthErr]     = useState(false);
  const [mapMode,     setMapMode]      = useState<'day' | 'month'>('day');
  const [wantedKinds, setWantedKinds]  = useState<MapKind[]>(['checkin']);
  const [selectedMapEpf, setSelectedMapEpf]   = useState<string | null>(null);
  const [selectedMapDate, setSelectedMapDate] = useState<string | null>(null);

  // Reset map-specific person & date filters when the map dialog closes or month changes
  useEffect(() => {
    if (!mapOpen) {
      setSelectedMapEpf(null);
      setSelectedMapDate(null);
    }
  }, [mapOpen]);

  useEffect(() => {
    setSelectedMapEpf(null);
    setSelectedMapDate(null);
  }, [calMonth]);

  useEffect(() => {
    setSelectedMapDate(null);
  }, [mapMode]);

  // The day the reader is pointing at in the month graph — hover on a desktop, focus on a
  // keyboard. It only drives the readout line; the selected day is a separate thing.
  const [hoverDay,    setHoverDay]     = useState<string | null>(null);
  const sparkRef      = useRef<HTMLDivElement>(null);

  const today      = format(new Date(), 'yyyy-MM-dd');
  const todayStart = startOfDay(new Date());

  useEffect(() => {
    // canSwitch users get their company list from useCompanyContext() already — this local
    // read is only for the seesAllCompanies-but-not-canSwitch population that still needs its
    // own dropdown (see the comment by companyContext above).
    if (!seesAllCompanies || companyContext.canSwitch) return;
    getDocs(collection(db, 'companies')).then(snap =>
      setCompanies(snap.docs.map(d => ({ id: d.id, name: d.data().name as string })).sort((a, b) => a.name.localeCompare(b.name)))
    ).catch(() => {});
  }, [user, seesAllCompanies, companyContext.canSwitch]);

  // Mirror the Top Navbar's Global Company Selector into this page's own company-NAME filter
  // (every reader below — fetchUsersRaw, OverviewKpiBand, the register export — already keys
  // off a name, not an id, so this resolves the id rather than threading a second shape
  // through the whole page). Runs only for canSwitch users; everyone else keeps driving
  // `selectedCo` from their own local dropdown (or never leaves 'all'/their own company).
  useEffect(() => {
    if (!companyContext.canSwitch) return;
    const name = companyContext.companyId
      ? (companyContext.companies.find(c => c.id === companyContext.companyId)?.name ?? 'all')
      : 'all';
    setSelectedCo(name);
  }, [companyContext.canSwitch, companyContext.companyId, companyContext.companies]);

  // Holidays come from two places and both matter: the public feed gives the NAMES, while
  // holiday_settings is what the organisation actually ACCEPTED (and it is the list the
  // monthly report and the roster already trust). A date in either is drawn as a holiday.
  const fetchHolidays = useCallback(async (year: number) => {
    if (holidayYears.current.has(year)) return;
    holidayYears.current.add(year);
    const map: Record<string, string> = {};
    try {
      const res = await fetch(`/api/holidays?year=${year}`);
      if (res.ok) {
        const data = await res.json();
        (data.response?.holidays ?? [])
          .filter((h: any) => h.primary_type === 'Public Holiday')
          .forEach((h: any) => {
            const { year: y, month: m, day: d } = h.date.datetime;
            map[`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`] = h.name;
          });
      }
    } catch { }
    try {
      const { dates, custom } = await getHolidaySettings(year);
      const customName = new Map(custom.map(c => [c.date, c.name]));
      dates.forEach(d => { map[d] = customName.get(d) ?? map[d] ?? t.holidayWord; });
    } catch { }
    if (Object.keys(map).length) setHolidays(prev => ({ ...prev, ...map }));
  }, [t]);

  useEffect(() => { fetchHolidays(calMonth.getFullYear()); }, [calMonth, fetchHolidays]);

  // Every user on this company filter, unfiltered. The day figures need the attendance-taking
  // subset; the headcount tile needs the whole roll. Both come off ONE read.
  const fetchUsersRaw = useCallback(async () => {
    const snap = seesAllCompanies
      ? selectedCo === 'all'
        ? await getDocs(collection(db, 'users'))
        : await getDocs(query(collection(db, 'users'), where('company_name', '==', selectedCo)))
      : await getDocs(query(collection(db, 'users'), where('company_name', '==', user?.company ?? '')));
    return snap.docs.map(d => d.data());
  }, [user, selectedCo, seesAllCompanies]);

  const attendanceTakers = useCallback((raw: any[]) => {
    const todayStr = new Date().toISOString().slice(0, 10);
    return raw.filter(
      u => u.is_active !== false
        && !(u.date_of_resign && u.date_of_resign <= todayStr)
        && roleCan(u.role, 'has_attendance', roles)
    );
  }, [roles]);

  const fetchEmployees = useCallback(
    async () => attendanceTakers(await fetchUsersRaw()),
    [fetchUsersRaw, attendanceTakers],
  );

  const loadMonth = useCallback(async (month: Date) => {
    setLoadingCal(true);
    setMonthErr(false);
    try {
      const raw       = await fetchUsersRaw();
      const employees = attendanceTakers(raw);
      const total     = employees.length;
      const y = month.getFullYear(), m = month.getMonth() + 1;
      const daysInMo  = getDaysInMonth(month);
      const prefix    = `${y}-${String(m).padStart(2, '0')}`;
      const monthFrom = `${prefix}-01`;
      const monthTo   = `${prefix}-${String(daysInMo).padStart(2, '0')}`;
      const todayStr  = new Date().toISOString().slice(0, 10);

      setHeadcount({
        activeTotal: raw.filter(u => u.is_active !== false && !(u.date_of_resign && u.date_of_resign <= todayStr)).length,
        resignedThisMonth: raw.filter(u => typeof u.date_of_resign === 'string' && u.date_of_resign.startsWith(prefix)).length,
      });

      // The department index rides on the roll we have already paid for. It covers everyone
      // on the company filter, not just the attendance-taking subset, so a look-up never
      // misses somebody the day view is showing.
      const deptIndex: Record<string, string> = {};
      raw.forEach(u => { if (u.epf_number) deptIndex[u.epf_number as string] = String(u.department ?? '').trim(); });
      setDeptByEpf(deptIndex);

      // Leaves used to be read UNBOUNDED here — `status == approved` with no date filter at
      // all — so every approved leave ever recorded came back on every month change and every
      // company change, and that bill grows forever. Bounding it to leaves that can overlap
      // this month is the shape useOverviewDay already uses: Firestore allows one inequality
      // field, so `from_date <= monthTo` is the query and `to_date >= monthFrom` is a pass on
      // the client.
      //
      // The fallback is not belt-and-braces. That query needs the composite (status,
      // from_date), and firebase.json only deploys indexes to (default) and test —
      // `southernlanka` is not a target — so on that tenant the index may simply not exist
      // and the query throws FAILED_PRECONDITION. Falling back to an EMPTY list would zero
      // every leave figure on this page, on one tenant only, silently and forever. Falling
      // back to the old unbounded read is merely expensive, and expensive is recoverable.
      const [attSnap, leaveSnap, monthAssignments] = await Promise.all([
        getDocs(query(collection(db, 'attendances'), where('date', '>=', monthFrom), where('date', '<=', monthTo))),
        getDocs(query(
          collection(db, 'leaves'),
          where('status', '==', 'approved'),
          where('from_date', '<=', monthTo),
        )).catch(() => getDocs(query(collection(db, 'leaves'), where('status', '==', 'approved')))),
        // Southern Lanka only — schedule_assignments for the whole visible month, org-wide,
        // same query shape /schedule's "All Departments" view already uses. Empty (never
        // fetched) for every other tenant, which is what keeps their missing/total formula
        // below byte-identical to before this existed.
        isSouthernlanka ? getScheduleAssignmentsForRange(monthFrom, monthTo).catch(() => []) : Promise.resolve([]),
      ]);

      const empEpfs = new Set(employees.map(e => e.epf_number as string));

      // Southern Lanka only — who has a shift assigned on which date this month.
      const scheduledByDay: Record<string, Set<string>> = {};
      if (isSouthernlanka) {
        monthAssignments.forEach(a => {
          if (!empEpfs.has(a.epf_number)) return;
          (scheduledByDay[a.date] ??= new Set()).add(a.epf_number);
        });
      }

      // The month map, off the snapshot already in hand. `attSnap`'s coordinates were read
      // and thrown away on every visit to this page; keeping them costs nothing and is the
      // whole reason a month map for everybody is affordable at all.
      const mapKey = `${prefix}|${selectedCo}`;
      const cachedMap = monthMapCache.get(mapKey);
      const days = cachedMap ?? buildMonthMapDays(
        attSnap.docs, empEpfs, new Map(employees.map(e => [e.epf_number as string, (e.display_name ?? e.epf_number) as string])),
      );
      monthMapCache.set(mapKey, days);
      setMonthDays(days);

      const hasCheckIn = (a: any) => Array.isArray(a.sessions)
        ? a.sessions.some((s: any) => s.check_in) : !!a.check_in;
      const presentByDay: Record<string, Set<string>> = {};
      const presentPeopleByDay: Record<string, HolidayStaffInfo[]> = {};
      const empMap = new Map<string, any>();
      raw.forEach(u => { if (u.epf_number) empMap.set(String(u.epf_number), u); });

      // Same pass counts the approval backlog: attendance dated before today whose check-in or
      // check-out is still 'pending'. Bounded to the month on screen — the tile's hint names
      // the oldest day it found, so a wider backlog is never implied.
      let pendingCount = 0; let pendingOldest: string | null = null;
      attSnap.docs.forEach(d => {
        const a = d.data();
        if (!empEpfs.has(a.epf_number) || a.is_deleted) return;
        if (hasCheckIn(a)) {
          (presentByDay[a.date] ??= new Set()).add(a.epf_number);
          const emp = empMap.get(String(a.epf_number));
          const sessions = Array.isArray(a.sessions) && a.sessions.length > 0 ? a.sessions : null;
          const s0 = sessions ? sessions[0] : null;
          const sLast = sessions ? sessions[sessions.length - 1] : null;
          const checkIn = toDisplayTime(s0?.check_in ?? a.check_in);
          const checkOut = toDisplayTime(sLast?.check_out ?? a.check_out);
          const place = s0?.check_in_site_name ?? s0?.working_place ?? a.check_in_site_name ?? a.working_place ?? null;
          const name = (emp?.display_name ?? emp?.name ?? a.epf_number) as string;

          (presentPeopleByDay[a.date] ??= []).push({
            epf: String(a.epf_number),
            name,
            department: (emp?.department as string) || (deptIndex[a.epf_number] as string) || undefined,
            designation: (emp?.designation as string) || (emp?.role as string) || undefined,
            avatar: (emp?.avatar_url ?? emp?.avatar ?? emp?.profile_photo_url) as string || undefined,
            email: (emp?.email as string) || undefined,
            company: (emp?.company_name ?? emp?.company) as string || undefined,
            checkIn,
            checkOut,
            place,
          });
        }
        if (a.date < todayStr && (a.check_in_status === 'pending' || a.check_out_status === 'pending')) {
          pendingCount += 1;
          if (!pendingOldest || a.date < pendingOldest) pendingOldest = a.date;
        }
      });
      setPending({ count: pendingCount, oldest: pendingOldest });

      const leaveByDay: Record<string, Set<string>> = {};
      leaveSnap.docs.forEach(d => {
        const l = d.data();
        if (!empEpfs.has(l.epf_number)) return;
        for (let i = 1; i <= daysInMo; i++) {
          const ds = `${prefix}-${String(i).padStart(2, '0')}`;
          if (String(l.from_date).slice(0, 10) <= ds && String(l.to_date).slice(0, 10) >= ds) (leaveByDay[ds] ??= new Set()).add(l.epf_number);
        }
      });
      employees.forEach(e => {
        if (!e.special_leaves?.length) return;
        for (let i = 1; i <= daysInMo; i++) {
          const ds = `${prefix}-${String(i).padStart(2, '0')}`;
          if (specialLeaveOn(e.special_leaves, ds)) (leaveByDay[ds] ??= new Set()).add(e.epf_number);
        }
      });

      const birthdaysByDay: Record<string, string[]> = {};
      const birthdayPeopleByDay: Record<string, BirthdayPersonInfo[]> = {};
      employees.forEach(e => {
        const dob = e.date_of_birth as string | null;
        if (!dob) return;
        if (dob.slice(5, 7) === String(m).padStart(2, '0')) {
          const ds = `${prefix}-${dob.slice(8, 10)}`;
          const name = (e.display_name ?? e.name ?? e.epf_number) as string;
          (birthdaysByDay[ds] ??= []).push(name);
          (birthdayPeopleByDay[ds] ??= []).push({
            name,
            epf: String(e.epf_number ?? ''),
            department: (e.department as string) || (deptIndex[e.epf_number] as string) || undefined,
            designation: (e.designation as string) || (e.role as string) || undefined,
            avatar: (e.avatar_url ?? e.avatar ?? e.profile_photo_url) as string || undefined,
            company: (e.company_name ?? e.company) as string || undefined,
            email: (e.email as string) || undefined,
            dob: dob,
          });
        }
      });

      const result: Record<string, DaySummary> = {};
      for (let i = 1; i <= daysInMo; i++) {
        const ds        = `${prefix}-${String(i).padStart(2, '0')}`;
        const isSunday  = getDay(new Date(ds + 'T00:00:00')) === 0;
        const presentSet = presentByDay[ds] ?? new Set<string>();
        const leaveSet   = leaveByDay[ds] ?? new Set<string>();
        const present   = presentSet.size;
        const onLeave   = leaveSet.size;
        let missing: number, dayTotal: number, unscheduled: number;
        if (isSouthernlanka) {
          // "Expected to work" pool = anyone present, on leave, or actually scheduled — a
          // present-without-a-shift walk-in still counts (present always wins), but someone
          // with no shift AND no leave AND no check-in is 'unscheduled', never 'missing'.
          const scheduledSet = scheduledByDay[ds] ?? new Set<string>();
          const expectedEpfs = new Set<string>([...presentSet, ...leaveSet, ...scheduledSet]);
          dayTotal    = isSunday ? 0 : expectedEpfs.size;
          missing     = isSunday ? 0 : [...scheduledSet].filter(epf => !presentSet.has(epf) && !leaveSet.has(epf)).length;
          unscheduled = isSunday ? 0 : Math.max(0, total - expectedEpfs.size);
        } else {
          dayTotal    = isSunday ? 0 : total;
          missing     = isSunday ? 0 : Math.max(0, Math.max(0, total - onLeave) - present);
          unscheduled = 0;
        }
        result[ds] = {
          date: ds, present, onLeave, missing, total: dayTotal, unscheduled,
          birthdays: birthdaysByDay[ds] ?? [],
          birthdayPeople: birthdayPeopleByDay[ds] ?? [],
          presentPeople: presentPeopleByDay[ds] ?? [],
        };
      }
      setCalData(result);
    } catch {
      // A swallowed failure here used to leave the page showing a confident, empty month —
      // every calendar day blank, the approvals tile a clean 0, and now a map with nobody on
      // it anywhere. None of those is distinguishable from good news, so the failure is
      // recorded and the map says so instead of drawing.
      setMonthErr(true);
      setMonthDays(null);
    }
    setLoadingCal(false);
  }, [fetchUsersRaw, attendanceTakers, selectedCo]);

  useEffect(() => { loadMonth(calMonth); }, [calMonth, loadMonth, selectedCo]);

  // Day data via the new hook — drives KPIs + map + panel
  const { people, stats, loading: loadingDay } = useOverviewDay({
    date: selectedDay,
    company: selectedCo,
    getEmployees: fetchEmployees,
    refreshNonce,
    useShiftGate: isSouthernlanka,
  });

  // Reset focusedEpf when the day changes
  useEffect(() => { setFocusedEpf(null); setDossierEpf(null); }, [selectedDay]);

  const dossierPerson: DayPerson | null = useMemo(() => {
    if (!dossierEpf) return null;
    const found = people.find(p => p.epf === dossierEpf);
    if (found) return found;
    const calP = calData[selectedDay]?.presentPeople?.find(p => p.epf === dossierEpf);
    if (calP) {
      return {
        epf: calP.epf,
        name: calP.name,
        company: calP.company || '',
        status: 'present' as const,
        avatar: calP.avatar ?? null,
        email: calP.email ?? null,
        sessions: calP.checkIn ? [{
          checkIn: calP.checkIn,
          checkOut: calP.checkOut ?? null,
          lat: null,
          lng: null,
          place: calP.place ?? null,
          outstation: false,
          outOfRadius: null,
        }] : [],
      };
    }
    return null;
  }, [dossierEpf, people, calData, selectedDay]);

  // ── Department scoping ──────────────────────────────────────────────────────────────────
  // One key per person, so the select, the filter and the counts can never disagree about
  // which bucket somebody is in. Anybody the index has not caught up with yet — the day view
  // resolves before `loadMonth` does on a cold load — lands in the no-department bucket for
  // the moment it takes, rather than vanishing from a filtered list.
  const deptKeyOf = useCallback(
    (epf: string) => deptByEpf[epf]?.trim() || DEPT_NONE,
    [deptByEpf],
  );

  // Derived from the roll already on screen, never read. Named departments A–Z, and the
  // no-department bucket last: it is not a department, so it does not belong in their order.
  const departments = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of people) counts.set(deptKeyOf(p.epf), (counts.get(deptKeyOf(p.epf)) ?? 0) + 1);
    const named = [...counts.entries()]
      .filter(([k]) => k !== DEPT_NONE)
      .sort((a, b) => a[0].localeCompare(b[0]));
    const none = counts.get(DEPT_NONE) ?? 0;
    return [...named, ...(none > 0 ? [[DEPT_NONE, none] as [string, number]] : [])]
      .map(([key, count]) => ({ key, count }));
  }, [people, deptKeyOf]);

  const deptLabel = selectedDept === DEPT_NONE ? t.ovsNoDept : selectedDept;
  const deptActive = selectedDept !== DEPT_ALL;
  const coActive = seesAllCompanies && selectedCo !== 'all';
  const scopeActive = deptActive || coActive;

  // Everything below this line — the list, the map, the count — is the scoped set. The KPI
  // band is deliberately NOT, and says so; see the note beside it.
  const scopedPeople = useMemo(
    () => (deptActive ? people.filter(p => deptKeyOf(p.epf) === selectedDept) : people),
    [people, deptActive, selectedDept, deptKeyOf],
  );

  // Staff who logged in on the selected day (especially relevant on holidays)
  const holidayPresentStaff: HolidayStaffInfo[] = useMemo(() => {
    const fromCal = calData[selectedDay]?.presentPeople ?? [];
    const presentDayPeople = people.filter(p => p.status === 'present');
    if (presentDayPeople.length === 0 && fromCal.length > 0) {
      return fromCal;
    }
    if (presentDayPeople.length > 0) {
      const calMap = new Map(fromCal.map(c => [c.epf, c]));
      return presentDayPeople.map(p => {
        const cal = calMap.get(p.epf);
        const s0 = p.sessions?.[0];
        const sLast = p.sessions?.[p.sessions.length - 1];
        return {
          epf: p.epf,
          name: p.name || cal?.name || p.epf,
          department: (deptKeyOf(p.epf) !== DEPT_NONE ? deptKeyOf(p.epf) : cal?.department) || undefined,
          designation: cal?.designation,
          avatar: cal?.avatar,
          company: p.company || cal?.company,
          checkIn: s0?.checkIn ?? cal?.checkIn ?? null,
          checkOut: (sLast?.checkOut ?? cal?.checkOut) ?? null,
          place: s0?.place ?? cal?.place ?? null,
        };
      }).sort((a, b) => a.name.localeCompare(b.name));
    }
    return fromCal;
  }, [calData, selectedDay, people, deptKeyOf]);

  // A department name is a company's own word. Carrying "Finance" across from one company to
  // another would silently filter on a name that means something else there, or nothing.
  useEffect(() => { setSelectedDept(DEPT_ALL); }, [selectedCo]);

  const clearScope = useCallback(() => {
    setSelectedDept(DEPT_ALL);
    if (companyContext.canSwitch) companyContext.setCompanyId('');
    else if (seesAllCompanies) setSelectedCo('all');
  }, [seesAllCompanies, companyContext]);

  // Select a day and keep the month data (calData: per-day counts, birthdays) in sync
  // when the picker jumps to a different month.
  const handleSelectDay = useCallback((ds: string) => {
    setSelectedDay(ds);
    const d = new Date(ds + 'T00:00:00');
    if (!isSameMonth(d, calMonth)) setCalMonth(d);
  }, [calMonth]);

  // Refresh. Paging the calendar strip / date-picker to another month moves `calMonth`
  // but leaves `selectedDay` behind, so the date display + KPI cards can be showing one
  // month while the calendar shows another. Refresh reconciles that first — it pulls the
  // selected day into the month now on screen (same day-of-month, clamped to the month's
  // length and never into the future) — then reloads both that month and that day so
  // every control and every number is for the same period.
  const handleRefresh = useCallback(() => {
    if (!isSameMonth(new Date(selectedDay + 'T00:00:00'), calMonth)) {
      const dom = Math.min(Number(selectedDay.slice(8, 10)), getDaysInMonth(calMonth));
      let day = `${format(calMonth, 'yyyy-MM')}-${String(dom).padStart(2, '0')}`;
      if (day > today) day = today;
      setSelectedDay(day);
    }
    // Refresh means "go and look again", so the month's positions have to be rebuilt rather
    // than served from the cache that made paging back to a month cheap.
    monthMapCache.clear();
    loadMonth(calMonth);
    setRefreshNonce(n => n + 1);
  }, [selectedDay, calMonth, today, loadMonth]);

  // ── The period map ──────────────────────────────────────────────────────────────────────
  // The month's positions, narrowed by the same department filter as the list, so the map and
  // the list are never answering for two different sets of people. A day that ends up with
  // nobody in it is dropped: an empty day would still be counted in "24 days" below.
  const scopedMapDays = useMemo(() => {
    if (!monthDays) return null;
    if (!deptActive) return monthDays;
    return monthDays
      .map(d => ({ date: d.date, people: d.people.filter(p => deptKeyOf(p.epf) === selectedDept) }))
      .filter(d => d.people.length > 0);
  }, [monthDays, deptActive, selectedDept, deptKeyOf]);

  // Filter scoped map days by selected person and date
  const filteredMapDays = useMemo(() => {
    if (!scopedMapDays) return null;
    let days = scopedMapDays;
    if (selectedMapEpf && selectedMapEpf !== 'all') {
      days = days
        .map(d => ({
          date: d.date,
          people: d.people.filter(p => p.epf === selectedMapEpf),
        }))
        .filter(d => d.people.length > 0);
    }
    if (selectedMapDate && selectedMapDate !== 'all') {
      days = days.filter(d => d.date === selectedMapDate);
    }
    return days;
  }, [scopedMapDays, selectedMapEpf, selectedMapDate]);

  const filteredMapPeople = useMemo(() => {
    if (!selectedMapEpf || selectedMapEpf === 'all') return scopedPeople;
    return scopedPeople.filter(p => p.epf === selectedMapEpf);
  }, [scopedPeople, selectedMapEpf]);

  // Extract all people who have recorded GPS captures in the current map scope
  const mapPeopleList = useMemo(() => {
    if (mapMode === 'day') {
      return scopedPeople
        .filter(p => p.status === 'present' && p.sessions && p.sessions.some(s => s.lat != null))
        .map(p => ({
          epf: p.epf,
          name: p.name,
          daysCount: 1,
          capturesCount: p.sessions.filter(s => s.lat != null).length,
          dates: [selectedDay],
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    if (!scopedMapDays) return [];
    const map = new Map<string, { epf: string; name: string; dates: Set<string>; captures: number }>();
    for (const d of scopedMapDays) {
      for (const p of d.people) {
        let entry = map.get(p.epf);
        if (!entry) {
          entry = { epf: p.epf, name: p.name, dates: new Set(), captures: 0 };
          map.set(p.epf, entry);
        }
        let hasGps = false;
        for (const s of p.sessions) {
          if (s.lat != null) { entry.captures += 1; hasGps = true; }
          if (s.outLat != null) { entry.captures += 1; hasGps = true; }
          if (s.updates?.length) { entry.captures += s.updates.length; hasGps = true; }
        }
        if (hasGps) {
          entry.dates.add(d.date);
        }
      }
    }
    return Array.from(map.values())
      .filter(e => e.captures > 0)
      .map(e => ({
        epf: e.epf,
        name: e.name,
        daysCount: e.dates.size,
        capturesCount: e.captures,
        dates: Array.from(e.dates).sort().reverse(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [mapMode, scopedPeople, scopedMapDays, selectedDay]);

  const personSearchOptions: SearchOption[] = useMemo(() => {
    const allOption: SearchOption = {
      value: 'all',
      label: t.ovmAllPeople ?? 'All people',
      sublabel: `${mapPeopleList.length} people with GPS records`,
      keywords: 'all everyone everybody',
    };
    const personOptions: SearchOption[] = mapPeopleList.map(p => ({
      value: p.epf,
      label: p.name,
      sublabel: `EPF: ${p.epf} · ${p.daysCount} ${p.daysCount === 1 ? 'day' : 'days'} · ${p.capturesCount} captures`,
      badge: `${p.daysCount}d`,
      keywords: `${p.epf} ${p.name}`,
    }));
    return [allOption, ...personOptions];
  }, [mapPeopleList, t.ovmAllPeople]);

  const selectedPersonData = useMemo(() => {
    if (!selectedMapEpf || selectedMapEpf === 'all') return null;
    return mapPeopleList.find(p => p.epf === selectedMapEpf) ?? null;
  }, [selectedMapEpf, mapPeopleList]);

  // Counted once per payload, not once per render of the controls: this walks every session
  // of every person for the whole month.
  const kindTotals = useMemo(() => {
    let checkin = 0, checkout = 0, update = 0;
    const epfs = new Set<string>();
    for (const d of scopedMapDays ?? []) {
      for (const p of d.people) {
        epfs.add(p.epf);
        for (const s of p.sessions) {
          if (s.lat != null) checkin += 1;
          if (s.outLat != null) checkout += 1;
          update += s.updates.length;
        }
      }
    }
    return { checkin, checkout, update, people: epfs.size, days: scopedMapDays?.length ?? 0 };
  }, [scopedMapDays]);

  // Map kind totals when filtered by person / date
  const mapKindTotals = useMemo(() => {
    if (!selectedMapEpf && !selectedMapDate) return kindTotals;
    let checkin = 0, checkout = 0, update = 0;
    const epfs = new Set<string>();
    const daysToCount = filteredMapDays ?? [];
    for (const d of daysToCount) {
      for (const p of d.people) {
        epfs.add(p.epf);
        for (const s of p.sessions) {
          if (s.lat != null) checkin += 1;
          if (s.outLat != null) checkout += 1;
          if (s.updates) update += s.updates.length;
        }
      }
    }
    return { checkin, checkout, update, people: epfs.size, days: daysToCount.length };
  }, [selectedMapEpf, selectedMapDate, kindTotals, filteredMapDays]);

  // The cap, applied where the reader can be told about it. Kinds come off in the order they
  // carry the least: in-session updates first, then check-outs. Check-ins are never dropped —
  // a map with no check-ins on it is not a smaller map, it is a different one.
  const { kinds: effectiveKinds, trimmed } = useMemo(() => {
    const asked: MapKind[] = wantedKinds.length ? wantedKinds : ['checkin'];
    const sum = (ks: readonly MapKind[]) => ks.reduce((n, k) => n + kindTotals[k], 0);
    let ks = asked;
    if (sum(ks) > POINT_CAP && ks.includes('update')) ks = ks.filter(k => k !== 'update');
    if (sum(ks) > POINT_CAP && ks.includes('checkout')) ks = ks.filter(k => k !== 'checkout');
    return { kinds: ks, trimmed: ks.length < asked.length };
  }, [wantedKinds, kindTotals]);

  const periodPoints = effectiveKinds.reduce((n, k) => n + kindTotals[k], 0);
  const mapPeriodPoints = effectiveKinds.reduce((n, k) => n + mapKindTotals[k], 0);
  const monthMode = mapMode === 'month';

  const summaryLine = (t.ovmMonthNote ?? '{days} days · {people} people · {points} captures')
    .replace('{days}', String(kindTotals.days))
    .replace('{people}', String(kindTotals.people))
    .replace('{points}', String(periodPoints));

  const mapSummaryLine = (t.ovmMonthNote ?? '{days} days · {people} people · {points} captures')
    .replace('{days}', String(mapKindTotals.days))
    .replace('{people}', String(mapKindTotals.people))
    .replace('{points}', String(mapPeriodPoints));

  // Never let the reader switch every kind off — an empty map with three unticked boxes looks
  // broken rather than chosen. The last one on stays on.
  const toggleKind = useCallback((k: MapKind) => {
    setWantedKinds(prev => (prev.includes(k)
      ? (prev.length === 1 ? prev : prev.filter(x => x !== k))
      : [...prev, k]));
  }, []);

  // Stable across renders on purpose. The map rebuilds its whole Leaflet layer when this
  // identity changes, and in period mode that layer is built from thousands of points — an
  // inline arrow here would tear it down on every keystroke in the panel's search box.
  const handleOpenFromMap = useCallback((epf: string) => {
    setMapOpen(false);
    setDossierEpf(epf);
  }, []);

  // A popup row names a day. Picking it selects that day on the page AND drops the map back
  // to Day, because otherwise the month's markers stay on screen and nothing visibly answers
  // the click. The dialog stays open — the reader asked for a day, not for the map to close.
  const handleOpenMapDay = useCallback((ds: string) => {
    handleSelectDay(ds);
    setMapMode('day');
  }, [handleSelectDay]);

  // Download the displayed month's attendance register (CSV / Excel / PDF).
  const [exporting, setExporting] = useState(false);
  const handleExport = async (kind: 'csv' | 'xlsx' | 'pdf') => {
    if (exporting) return;
    setExporting(true);
    try {
      const employees = await fetchEmployees();
      const reg = await buildMonthRegister({
        month: calMonth,
        employees,
        holidays,
        companyLabel: seesAllCompanies && selectedCo === 'all' ? 'All companies' : (selectedCo === 'all' ? (user?.company ?? '') : selectedCo),
      });
      if (kind === 'csv') exportRegisterCsv(reg);
      else if (kind === 'xlsx') await exportRegisterXlsx(reg);
      else await exportRegisterPdf(reg);
      toast.success(t.reportDownloaded);
    } catch (e) {
      console.error(e);
      toast.error(t.failedGenerateReport);
    } finally {
      setExporting(false);
    }
  };

  const daysInMonth    = getDaysInMonth(calMonth);
  const isFuture       = (ds: string) => isAfter(startOfDay(new Date(ds + 'T00:00:00')), todayStart);

  // Four states a day can be in, and they must not look alike: a holiday, a day that has not
  // happened yet, a day nobody attended, and a day with real attendance. Before this, a day
  // with zero attendance and a day at 40% shared the same red.
  type DayKind = 'holiday' | 'future' | 'rest' | 'empty' | 'worked';
  const dayKind = (ds: string): DayKind => {
    if (holidays[ds]) return 'holiday';
    if (isFuture(ds)) return 'future';
    const d = calData[ds];
    if (!d || d.total === 0) return 'rest';
    if (d.present === 0) return 'empty';
    return 'worked';
  };

  const dayChrome = (ds: string): { bg: string; text: string } => {
    switch (dayKind(ds)) {
      case 'holiday': return { bg: 'bg-brand/10 border-brand/30', text: 'text-brand' };
      case 'future':  return { bg: 'border-dashed border-border/60', text: 'text-muted-foreground opacity-40' };
      case 'rest':    return { bg: 'border-transparent bg-muted/40', text: 'text-muted-foreground' };
      case 'empty':   return { bg: 'bg-destructive/15 border-destructive/40', text: 'text-destructive' };
      default: {
        const d = calData[ds];
        const pct = d.present / Math.max(1, d.total - d.onLeave);
        if (pct >= 0.8) return { bg: 'bg-success/10 border-success/30', text: 'text-success' };
        if (pct >= 0.5) return { bg: 'bg-warning/10 border-warning/30', text: 'text-warning' };
        return { bg: 'bg-destructive/10 border-destructive/30', text: 'text-destructive' };
      }
    }
  };

  // Attendance rate for the month on screen: present ÷ (roll − on leave), over the elapsed
  // days that actually expected anyone. Holidays, Sundays and future days are excluded rather
  // than counted as absence.
  const monthRate = useMemo(() => {
    let presentSum = 0, expectedSum = 0, ratedDays = 0;
    Object.values(calData).forEach(d => {
      if (isFuture(d.date) || holidays[d.date] || d.total === 0) return;
      const expected = Math.max(0, d.total - d.onLeave);
      if (expected === 0) return;
      presentSum += Math.min(d.present, expected);
      expectedSum += expected;
      ratedDays += 1;
    });
    return {
      pct: expectedSum ? Math.round((presentSum / expectedSum) * 100) : null,
      ratedDays,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calData, holidays]);

  const core: OverviewCore = {
    activeTotal: headcount.activeTotal || stats.total,
    attendanceEligible: stats.total,
    resignedThisMonth: headcount.resignedThisMonth,
    present: stats.present,
    onLeave: stats.onLeave,
    missing: stats.missing,
    attendanceRatePct: monthRate.pct,
    ratedDays: monthRate.ratedDays,
    approvalsWaiting: seesApprovalBacklog ? pending.count : null,
    approvalsOldest: pending.oldest,
  };

  // The month as one row of bars. Every day carries what the graph needs to draw itself AND to
  // describe itself, because a bar the reader has to hover to identify is decoration.
  //   rate  — present ÷ (roll − on leave), which is the SAME denominator `dayChrome` and
  //           `monthRate` use. It used to be present ÷ (present + leave + missing), so a day
  //           with a third of the roll on approved leave drew a short bar here while showing
  //           green in the month view and feeding a high percentage into the KPI band — one
  //           day, one page, three answers. -1 still means "no rate exists".
  //   kind  — the five states `dayKind` already separates, so a rest day, a holiday and a day
  //           still to come are never drawn as a day people missed.
  const monthSpark = useMemo(() => {
    const n = getDaysInMonth(calMonth);
    return Array.from({ length: n }, (_, i) => {
      const dayNum   = i + 1;
      const ds       = `${format(calMonth, 'yyyy-MM')}-${String(dayNum).padStart(2, '0')}`;
      const d        = calData[ds];
      const kind     = dayKind(ds);
      const expected = d ? Math.max(0, d.total - d.onLeave) : 0;
      // A public holiday has no expectation, so it has no rate. `total` is NOT zeroed for a
      // holiday the way it is for a Sunday, so present/expected used to produce a real number
      // here — a holiday 40 of 150 people worked drew a filled bar at 27% in the "bad day"
      // colour, reading as a day attendance collapsed rather than a day nobody was due in.
      // Dividing turnout by a phantom expectation is the bug; the fix is not to divide at all.
      // Rest days already landed here through expected === 0; holidays now join them.
      const noExpectation = kind === 'holiday' || kind === 'rest' || kind === 'future';
      return {
        ds, dayNum,
        // Monday. The extra pixel of space before it is what makes the weeks countable.
        weekStart: getDay(new Date(ds + 'T00:00:00')) === 1,
        kind,
        rate: !noExpectation && d && expected > 0 ? Math.min(1, d.present / expected) : -1,
        // People who came in on a day nothing was expected of them. Not a rate — there is
        // nothing for it to be a fraction of — so the column stays hollow and this is drawn as
        // its own mark. Payroll's holiday multipliers are a separate, genuinely paid concept;
        // this is only a count of who turned up, and must not be dressed as attendance figures.
        worked: noExpectation && kind !== 'future' ? (d?.present ?? 0) : 0,
      };
    });
    // dayKind closes over holidays + calData + today, and all three are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calMonth, calData, holidays, today]);

  // A day in one line of prose — the readout above the graph and the bar's own accessible
  // name are the same sentence. A phone has no hover, so the figures have to be text
  // somewhere on the page rather than in a tooltip nobody can reach.
  const describeDay = (ds: string): string => {
    const when = format(new Date(ds + 'T00:00:00'), 'EEE, MMM d');
    const kind = dayKind(ds);
    // A day with no expectation still has people on it sometimes, and they were the ones this
    // sentence used to leave out entirely: a holiday 40 people worked read as "Holiday: New
    // Year" and nothing else, in the readout, the tooltip AND the screen reader. Whoever came
    // in gets counted. Their absence is never reported, because on a day nobody was due in a
    // zero is not information.
    const turnout = (calData[ds]?.present ?? 0) > 0
      ? ` · ${calData[ds].present} ${t.presentWord}`
      : '';
    if (kind === 'future')  return `${when} · ${t.notYet}`;
    if (kind === 'holiday') return `${when} · ${t.holidayWord}: ${holidays[ds]}${turnout}`;
    const d = calData[ds];
    if (!d)                 return `${when} · ${t.noData}`;
    if (kind === 'rest')    return `${when} · ${t.ovgRestDay}${turnout}`;
    const expected = Math.max(0, d.total - d.onLeave);
    const pct = expected > 0 ? ` · ${Math.round((Math.min(d.present, expected) / expected) * 100)}%` : '';
    // Southern Lanka only — named separately so a day full of unscheduled people never reads
    // as a day full of absentees.
    const unscheduled = d.unscheduled ? ` · ${d.unscheduled} ${t.unscheduledCap}` : '';
    return `${when} · ${d.present} ${t.presentWord} · ${d.onLeave} ${t.leaveWord} · ${d.missing} ${t.missingWord}${unscheduled}${pct}`;
  };

  // One tab stop for the whole graph, then arrow keys walk the days: 31 tab stops between the
  // KPI band and the people list would be a wall. The stop is the selected day when it is in
  // the month on screen, otherwise today, otherwise the first day.
  const sparkTabDs = useMemo(() => {
    if (monthSpark.some(b => b.ds === selectedDay)) return selectedDay;
    return monthSpark.find(b => b.ds === today)?.ds ?? monthSpark[0]?.ds ?? null;
  }, [monthSpark, selectedDay, today]);

  const handleSparkKeys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const bars = Array.from(sparkRef.current?.querySelectorAll<HTMLButtonElement>('[data-spark-day]') ?? []);
    const at = bars.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const to = e.key === 'Home'      ? 0
      : e.key === 'End'              ? bars.length - 1
      : e.key === 'ArrowLeft'        ? Math.max(0, at - 1)
      :                                Math.min(bars.length - 1, at + 1);
    bars[to]?.focus();
  };

  // An empty map is a big grey rectangle that teaches the reader nothing, so the entry only
  // exists when there is somewhere to plot. It follows the department filter — a map of
  // people the reader has filtered out is not the map they asked for — and it now also opens
  // when only the MONTH has positions, because a day with no GPS is no longer the only thing
  // behind this button.
  const hasMappable = useMemo(
    () => scopedPeople.some(pp => pp.sessions.some(sn => sn.lat != null && sn.lng != null))
      || (scopedMapDays?.length ?? 0) > 0,
    [scopedPeople, scopedMapDays],
  );

  // Initial full-page load: no calendar data yet → mirror layout with a dashboard skeleton.
  if (loadingCal && Object.keys(calData).length === 0) {
    return (
      <PageTransition className="space-y-6">
        <DashboardSkeleton />
      </PageTransition>
    );
  }

  return (
    <PageTransition>
    <div className="space-y-4 sm:space-y-6">

      {/* ── Title ── */}
      <PageHeader
        title={t.companyOverview}
        description={t.dailySummaryDesc}
        icon={LayoutDashboard}
      />

      {/* ── One control bar ──
          Everything that steers the page, in one place, pinned. This row used to be five
          unrelated things at equal weight — a day picker, a holiday chip, a birthday chip, a
          calendar toggle and a three-format export menu — beside a company select stranded up
          in the header and TWO more month controls inside the slider below. Three ways to move
          through time is two too many. */}
      <div className="sticky top-0 z-20 -mx-4 space-y-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur-xl sm:-mx-6 sm:px-6">
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-none py-0.5">
          <div className="shrink-0">
            <OverviewDateControl
              date={selectedDay}
              onChange={handleSelectDay}
              dayInfo={ds => calData[ds] ?? null}
              onMonthChange={m => { if (!isSameMonth(m, calMonth)) setCalMonth(m); }}
            />
          </div>
          {/* Local company selector only for the seesAllCompanies-but-not-canSwitch population
              (can_manage_users/can_report without can_manage_all_companies) — a canSwitch
              admin already has the Top Navbar's Global Company Selector as the single source
              of truth (see the sync effect above), so showing this one too was a second,
              redundant control filtering the exact same page. */}
          {seesAllCompanies && !companyContext.canSwitch && (
            <Select value={selectedCo} onValueChange={v => setSelectedCo(v)}>
              <SelectTrigger className="w-auto min-w-[130px] max-w-[180px] shrink-0" aria-label={t.companyWord}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t.allCompanies}</SelectItem>
                {companies.map(c => <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}

          {/* Department — shown whenever there is at least one to pick, scoped to whichever
              company is currently selected (departments is derived from the company-filtered
              roster above). Used to require > 1 so a company with only one department never
              showed a single-option dropdown; that made the control disappear entirely the
              moment an admin narrowed to a small company, which read as "the department filter
              got removed" rather than "this company only has one department." */}
          {departments.length > 0 && (
            <Select value={selectedDept} onValueChange={setSelectedDept}>
              <SelectTrigger className="w-auto min-w-[130px] max-w-[190px] shrink-0" aria-label={t.departmentLabel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEPT_ALL}>{t.ovsAllDepts} · {people.length}</SelectItem>
                {departments.map(d => (
                  <SelectItem key={d.key} value={d.key}>
                    {d.key === DEPT_NONE ? t.ovsNoDept : d.key} · {d.count}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Holiday chip in top row with rich hover tooltip */}
          {holidays[selectedDay] && (
            <HolidayTooltipChip
              date={selectedDay}
              name={holidays[selectedDay]}
              summary={calData[selectedDay]}
              holidayWord={t.holidayWord}
              presentStaff={holidayPresentStaff}
              onSelectPerson={(epf) => setDossierEpf(epf)}
            />
          )}

          {/* Birthday chip in top row with rich hover celebration card */}
          {(calData[selectedDay]?.birthdays?.length ?? 0) > 0 && (
            <BirthdayTooltipChip
              date={selectedDay}
              names={calData[selectedDay].birthdays}
              people={calData[selectedDay].birthdayPeople}
              birthdayLabel={t.birthdayLabel}
              onSelectPerson={(epf) => setDossierEpf(epf)}
            />
          )}

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* The month view and the map are what people come back to this page for, so they
                are buttons, not menu items. Two LABELLED buttons do not fit: at 375px this row
                is already 374px wide before the company select, and labels would force a third
                pinned line onto a screen that can spare none. So the icon carries them on a
                phone and the label appears from sm: up, where there is room for it. */}
            <Button
              variant="outline"
              size="icon"
              className="sm:w-auto sm:px-3"
              onClick={() => setMonthOpen(true)}
              aria-label={t.ovMonthView}
              title={t.ovMonthView}
            >
              <CalendarDays className="h-4 w-4" />
              <span className="hidden lg:inline">{t.ovMonthView}</span>
            </Button>
            {/* Still gated on hasMappable — see the note there. */}
            {hasMappable && (
              <Button
                variant="outline"
                size="icon"
                className="sm:w-auto sm:px-3"
                onClick={() => setMapOpen(true)}
                aria-label={t.mapWord}
                title={t.mapWord}
              >
                <MapIcon className="h-4 w-4" />
                <span className="hidden capitalize lg:inline">{t.mapWord}</span>
              </Button>
            )}
            {/* What is left behind the menu is the genuinely occasional: a reconciling
                refresh and the three register formats. None of them is a per-visit action. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label={t.ovMoreActions} title={t.ovMoreActions}>
                  {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleRefresh}>
                  <RefreshCw className="h-4 w-4" /> {t.refreshLabel}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={exporting} onClick={() => handleExport('xlsx')}>
                  <FileSpreadsheet className="h-4 w-4" /> {t.downloadWord} · Excel
                </DropdownMenuItem>
                <DropdownMenuItem disabled={exporting} onClick={() => handleExport('csv')}>
                  <FileSpreadsheet className="h-4 w-4" /> {t.downloadWord} · CSV
                </DropdownMenuItem>
                <DropdownMenuItem disabled={exporting} onClick={() => handleExport('pdf')}>
                  <FileText className="h-4 w-4" /> {t.downloadWord} · PDF
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* ── What the page is narrowed to ──
            A select showing "Finance" and a select showing "All departments" are the same
            shape, the same weight and the same place on screen, so a narrowed page and a whole
            one look alike at a glance — and a short list then reads as a small company rather
            than as a filter nobody remembered switching on. This row exists ONLY while
            something is narrowing, which is what makes it legible: its presence is the signal,
            not its contents. One button clears every part of it at once.

            Dashed outline rather than a tint: --success, --primary and --brand are all the
            same azure here, so a coloured bar would read as a status about the people rather
            than as a statement about the view. */}
        {scopeActive && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-dashed border-border bg-muted/40 px-2.5 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t.ovsScopedTo}
            </span>
            {coActive && <Badge variant="outline" className="py-0 text-[10px] font-semibold">{selectedCo}</Badge>}
            {deptActive && <Badge variant="outline" className="py-0 text-[10px] font-semibold">{deptLabel}</Badge>}
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {(t.ovsShownOf ?? 'Showing {shown} of {total}').replace('{shown}', String(scopedPeople.length)).replace('{total}', String(people.length))}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 gap-1 px-2 text-[11px]"
              onClick={clearScope}
            >
              <X className="h-3 w-3" aria-hidden />{t.ovsClearFilters}
            </Button>
          </div>
        )}
      </div>

      {/* ── The day, in figures ── */}
      <OverviewKpiBand
        core={core}
        month={calMonth}
        date={selectedDay}
        company={selectedCo}
        refreshNonce={refreshNonce}
      />

      {/* The band above does NOT follow the department filter, and pretending otherwise would
          be the worse bug. It is three sections at three different periods: the selected day
          comes from the day hook, the month's rate and approval backlog come from `calData`,
          and the headcount comes from the whole roll — and only the first of those could be
          narrowed from here. Feeding it a department-sized `attendanceEligible` would fix the
          day tiles and quietly corrupt the standing ones, which read the same field. So it
          keeps answering for the whole company selection and says so out loud, rather than
          counting a different set of people from the list underneath it. */}
      {deptActive && (
        <p className="-mt-3 flex items-start gap-1.5 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground sm:-mt-4">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{(t.ovsKpiWholeCompany ?? 'KPIs reflect whole company, not {dept}').replace('{dept}', deptLabel)}</span>
        </p>
      )}

      {/* ── The month, as a graph ──
          This was a row of bare azure bars: height was the rate, the only affordance was a raw
          ISO date in a `title`, and a Sunday, a public holiday, a day still to come and a day
          nobody turned up for all looked alike. Four things changed, and each one is the same
          idea — a graph has to say what it means without being hovered.
            · A SCALE. Gridlines at 0/50/100% and a labelled gutter, so a bar reads as 40%
              rather than "shortish".
            · HOLLOW, not short. A day that expected nobody is drawn as an empty dashed column,
              never as a low bar. --success, --primary and --brand are all the same azure here,
              so hue could never have carried that distinction; filled-versus-hollow can, and
              it doubles as the visible rhythm of the weekends.
            · A DATE ON THE AXIS. Week starts are numbered (so the weeks are countable), today
              is an outlined number and the selected day is a filled one — outline versus fill,
              not two shades of the same blue.
            · FIGURES. A bar is a button: hover or focus writes that day's present / leave /
              missing into the readout line, and clicking selects the day rather than opening a
              dialog. The full strip is still one tap away — the Month view button in the bar
              above is the door to it now, which is why the bars no longer have to be. */}
      {monthSpark.length > 0 && (
        <div className="rounded-lg border border-border bg-card/40 px-3 py-2.5">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="text-xs font-semibold text-foreground">
              {t.ovgTitle}{' '}
              <span className="font-normal text-muted-foreground">· {format(calMonth, 'MMM yyyy')} · {t.ovgLegend}</span>
            </span>
            {/* The readout. It shows the selected day until the reader points at another, so
                the graph is never wordless. */}
            <span className="min-w-0 max-w-full truncate text-[11px] tabular-nums text-muted-foreground">
              {describeDay(hoverDay ?? selectedDay)}
            </span>
          </div>

          <div className="flex gap-2">
            <div
              className="flex h-11 w-7 shrink-0 flex-col justify-between text-[8px] leading-none tabular-nums text-muted-foreground sm:text-[9px]"
              aria-hidden
            >
              <span>100%</span>
              <span>50%</span>
              <span>0</span>
            </div>

            <div
              ref={sparkRef}
              role="group"
              aria-label={t.ovgAria.replace('{month}', format(calMonth, 'MMMM yyyy'))}
              aria-busy={loadingCal}
              onKeyDown={handleSparkKeys}
              onMouseLeave={() => setHoverDay(null)}
              className={cn('relative min-w-0 flex-1', loadingCal && 'opacity-60')}
            >
              {/* Gridlines sit in their own overlay so `top-1/2` is half of the PLOT, not half
                  of the plot plus the axis row below it. */}
              <div className="pointer-events-none absolute inset-x-0 top-0 h-11" aria-hidden>
                <div className="absolute inset-x-0 top-0 border-t border-dashed border-border/70" />
                <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-border/70" />
                <div className="absolute inset-x-0 bottom-0 border-t border-border" />
              </div>

              <div className="flex items-stretch gap-px">
                {monthSpark.map((b, i) => {
                  const isSel   = b.ds === selectedDay;
                  const isToday = b.ds === today;
                  // Same thresholds as the month view's day chrome, so the two agree. Height
                  // already says how the day went; the colour only has to not contradict it.
                  const fill = b.rate >= 0.8 ? 'bg-primary/70' : b.rate >= 0.5 ? 'bg-warning/80' : 'bg-destructive/70';
                  return (
                    <button
                      key={b.ds}
                      type="button"
                      data-spark-day
                      tabIndex={b.ds === sparkTabDs ? 0 : -1}
                      aria-current={isSel ? 'date' : undefined}
                      aria-label={`${describeDay(b.ds)}${isToday ? ` · ${t.todayWord}` : ''}`}
                      title={describeDay(b.ds)}
                      onClick={() => handleSelectDay(b.ds)}
                      onMouseEnter={() => setHoverDay(b.ds)}
                      onFocus={() => setHoverDay(b.ds)}
                      onBlur={() => setHoverDay(null)}
                      className={cn(
                        'flex min-w-0 flex-1 flex-col items-center rounded-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                        b.weekStart && i > 0 && 'ml-1',
                        isSel ? 'bg-accent' : 'hover:bg-accent/60',
                      )}
                    >
                      <span className="relative flex h-11 w-full items-end px-px">
                        {b.rate < 0 ? (
                          <>
                            <span
                              className={cn(
                                'h-full w-full rounded-sm border border-dashed border-border',
                                b.kind === 'future' && 'opacity-50',
                              )}
                            />
                            {b.worked > 0 && (
                              // Somebody worked a day nothing was expected of them. Deliberately
                              // a FIXED height, never proportional: there is no denominator on
                              // this day, so a tall mark would imply a good turnout and a short
                              // one a bad turnout, and neither would mean anything. Neutral
                              // foreground rather than a semantic colour — the three semantic
                              // tokens are the same azure, and this is not a state anyway. The
                              // count itself is in the readout, the tooltip and the aria-label.
                              <span className="absolute inset-x-px bottom-0 h-1.5 rounded-sm bg-foreground/70" aria-hidden />
                            )}
                          </>
                        ) : (
                          // A day where everyone was missing is still a bar — 6% of the track,
                          // so it stays visible and stays clearly different from a hollow one.
                          <span className={cn('w-full rounded-sm', fill)} style={{ height: `${Math.max(6, Math.round(b.rate * 100))}%` }} />
                        )}
                        {b.kind === 'holiday' && (
                          <span className="absolute left-1/2 top-0 h-1 w-1 -translate-x-1/2 rounded-full bg-brand" />
                        )}
                      </span>
                      <span
                        className={cn(
                          'mt-1 w-full rounded-sm text-center text-[8px] leading-[1.3] tabular-nums sm:text-[9px]',
                          isSel
                            ? 'bg-primary font-bold text-primary-foreground'
                            : isToday
                            ? 'border border-foreground/50 font-semibold text-foreground'
                            : 'text-muted-foreground',
                        )}
                      >
                        {isSel || isToday || b.weekStart ? b.dayNum : '\u00A0'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── The people. The page. ── */}
      <Reveal>
        {loadingDay && people.length === 0 ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : (
          /* No fixed height and no inner scrollbar: PeoplePanel used to scroll inside a
             h-[min(70vh,640px)] card, which left dead space under the list on a tall screen
             and fought the page's own scroll on a phone. Its tabs and search box are pinned
             inside it instead, so the filters stay reachable however long the list runs. */
          <Card className="p-4">
            <PeoplePanel
              people={scopedPeople}
              /* The panel cannot see the department select, so an empty list caused by it
                 would read as "nobody works here". Naming the scope — and handing over the
                 way out — is what keeps those two facts apart. */
              scopeLabel={deptActive ? deptLabel : null}
              onClearScope={clearScope}
              focusedEpf={focusedEpf}
              onFocus={setFocusedEpf}
              onOpen={p => setDossierEpf(p.epf)}
            />
          </Card>
        )}
      </Reveal>

      {/* ── Month view — Complete Calendar Grid & Contained Timeline ── */}
      <OverviewMonthModal
        open={monthOpen}
        onOpenChange={setMonthOpen}
        calMonth={calMonth}
        onMonthChange={setCalMonth}
        selectedDay={selectedDay}
        onSelectDay={handleSelectDay}
        calData={calData}
        holidays={holidays}
        loading={loadingCal}
      />

      {/* ── Map — a popup now, not a column. `isolate` still matters: Leaflet's internal
          panes go up to z-index ~700 and would otherwise paint over the dialog's own
          portalled layers. ── */}
      <Dialog open={mapOpen} onOpenChange={setMapOpen}>
        {/* w-[calc(100%-2rem)] max-h-[90vh] overflow-y-auto — a genuine viewport cap (this
            dialog previously had none at all) as a safety net around the computed mapHeight
            below, same sizing convention as OverviewMonthModal.tsx's dialog. */}
        <DialogContent className="max-w-5xl w-[calc(100%-2rem)] max-h-[90vh] overflow-y-auto p-3 sm:p-4">
          <DialogHeader className="mb-1"><DialogTitle className="text-sm capitalize">{t.mapWord}</DialogTitle></DialogHeader>

          {/* ── Range ──
              Day is the map this page has always drawn. Month plots the whole month of
              positions that `loadMonth` already fetched and used to throw away, so it costs
              nothing extra to read — which is precisely why it stops at one month. Six months
              for everybody would be tens of thousands of reads per open, so the cap is stated
              in words under the control rather than enforced by a click that silently does
              less than it says. The month itself is changed with the arrows beside the
              control; a longer period is a question about ONE person, and that is what
              opening somebody does. */}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t.ovmScopeLabel}
                </span>
                <div className="flex gap-1 rounded-md bg-muted p-1">
                  {([{ k: 'day', label: t.ovmScopeDay }, { k: 'month', label: t.ovmScopeMonth }] as const).map(o => (
                    <button
                      key={o.k}
                      type="button"
                      onClick={() => setMapMode(o.k)}
                      aria-pressed={mapMode === o.k}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
                        mapMode === o.k ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>

              {monthMode && (
                <>
                  <div className="flex items-center gap-0.5">
                    <Button
                      variant="ghost" size="icon-sm"
                      aria-label={t.ovsPrevMonth} title={t.ovsPrevMonth}
                      onClick={() => setCalMonth(m => subMonths(m, 1))}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="w-[86px] text-center text-xs font-semibold tabular-nums text-foreground">
                      {format(calMonth, 'MMM yyyy')}
                    </span>
                    <Button
                      variant="ghost" size="icon-sm"
                      aria-label={t.ovsNextMonth} title={t.ovsNextMonth}
                      disabled={isSameMonth(calMonth, new Date())}
                      onClick={() => { if (!isSameMonth(calMonth, new Date())) setCalMonth(m => addMonths(m, 1)); }}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                    {([
                      { k: 'checkin',  label: t.ovmKindIn,      n: mapKindTotals.checkin },
                      { k: 'checkout', label: t.ovmKindOut,     n: mapKindTotals.checkout },
                      { k: 'update',   label: t.ovmKindUpdates, n: mapKindTotals.update },
                    ] as const).map(o => (
                      <button
                        key={o.k}
                        type="button"
                        onClick={() => toggleKind(o.k)}
                        aria-pressed={effectiveKinds.includes(o.k)}
                        disabled={o.n === 0}
                        className={cn(
                          'inline-flex items-center gap-1 tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                          effectiveKinds.includes(o.k)
                            ? 'font-semibold text-foreground underline decoration-2 underline-offset-4'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {o.label}<span className="opacity-60">{o.n}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Right side: Searchable Select person dropdown & Date dropdown */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-52 sm:w-60">
                <SearchableSelect
                  value={selectedMapEpf ?? 'all'}
                  onChange={(v) => {
                    const nextEpf = v === 'all' ? null : v;
                    setSelectedMapEpf(nextEpf);
                    setSelectedMapDate(null);
                    setFocusedEpf(nextEpf);
                  }}
                  onClear={() => {
                    setSelectedMapEpf(null);
                    setSelectedMapDate(null);
                    setFocusedEpf(null);
                  }}
                  options={personSearchOptions}
                  placeholder={t.ovmSearchPerson ?? 'Search person...'}
                  icon={<Search className="h-3.5 w-3.5 text-muted-foreground" />}
                  inputClassName="h-8 text-xs bg-muted/40"
                  ariaLabel={t.ovmSearchPerson ?? 'Search person'}
                />
              </div>

              {selectedPersonData && selectedPersonData.dates.length > 0 && (
                <div className="flex items-center gap-1">
                  <select
                    aria-label={t.ovmFilterDate ?? 'Filter date'}
                    value={selectedMapDate ?? 'all'}
                    onChange={e => setSelectedMapDate(e.target.value === 'all' ? null : e.target.value)}
                    className="h-8 rounded-lg border border-border bg-card px-2 text-xs font-medium text-foreground transition-colors hover:border-primary/50 focus:outline-hidden focus:ring-1 focus:ring-primary max-w-[170px]"
                  >
                    <option value="all">
                      {t.ovmAllDates ?? 'All dates'} ({selectedPersonData.daysCount})
                    </option>
                    {selectedPersonData.dates.map(d => (
                      <option key={d} value={d}>
                        {format(new Date(d + 'T00:00:00'), 'MMM d, yyyy')}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>

          {/* Active person filter chip / banner */}
          {selectedPersonData && (
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs text-foreground">
              <div className="flex items-center gap-2 min-w-0">
                <User className="h-3.5 w-3.5 text-primary shrink-0" />
                <span className="font-semibold truncate">{selectedPersonData.name}</span>
                <span className="text-muted-foreground text-[11px]">(EPF: {selectedPersonData.epf})</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground text-[11px]">
                  {selectedMapDate
                    ? format(new Date(selectedMapDate + 'T00:00:00'), 'EEE, MMM d, yyyy')
                    : `${selectedPersonData.daysCount} ${selectedPersonData.daysCount === 1 ? 'day' : 'days'}`}
                </span>
                <span className="text-muted-foreground">·</span>
                <span className="font-medium text-primary text-[11px]">
                  {mapPeriodPoints} {mapPeriodPoints === 1 ? 'capture' : 'captures'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedMapEpf(null);
                  setSelectedMapDate(null);
                  setFocusedEpf(null);
                }}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                <X className="h-3 w-3" />
                <span>{t.ovmClearFilter ?? 'Clear filter'}</span>
              </button>
            </div>
          )}

          {monthMode && !monthErr && (
            <div className="mb-2 space-y-1 text-[11px] text-muted-foreground">
              <p>{t.ovmMonthLimit}</p>
              {trimmed && <p className="font-semibold text-warning">{t.ovmTrimmed}</p>}
              {!loadingCal && mapPeriodPoints > 0 && <p className="tabular-nums">{mapSummaryLine}</p>}
            </div>
          )}

          <div className="relative isolate overflow-hidden rounded-xl">
            {monthMode && monthErr ? (
              /* A failed month read used to arrive here as an empty map, which is the one
                 thing a map must never be: confident and wrong. */
              <div
                className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 text-center"
                style={{ height: mapHeight }}
              >
                <span className="text-sm font-semibold text-foreground">{t.ovmLoadError}</span>
                <Button variant="outline" size="sm" onClick={handleRefresh}>
                  <RefreshCw className="h-4 w-4" />{t.refreshLabel}
                </Button>
              </div>
            ) : (
              <>
                <SriLankaMap
                  people={filteredMapPeople}
                  /* Absent `days` is the single-day map, unchanged. While the month is still
                     loading it stays absent on purpose, so period mode opens onto the day's
                     markers rather than a blank grey rectangle. */
                  days={monthMode && !loadingCal ? filteredMapDays : null}
                  kinds={effectiveKinds}
                  summaryLine={monthMode && !loadingCal && mapPeriodPoints > 0 ? mapSummaryLine : null}
                  onOpenDay={handleOpenMapDay}
                  focusedEpf={focusedEpf ?? selectedMapEpf}
                  onFocus={setFocusedEpf}
                  // Opening someone from a marker closes the map, so the dossier is not buried
                  // under a dialog the reader then has to dismiss twice.
                  onOpen={handleOpenFromMap}
                  height={mapHeight}
                  className="w-full"
                  t={t}
                />

                {/* Leaflet's own panes stop around z-index 700 and the map's legend sits at
                    1000, so these overlays are above both. */}
                {monthMode && loadingCal && (
                  <div className="pointer-events-none absolute inset-0 z-[1200] flex items-center justify-center">
                    <span className="flex items-center gap-2 rounded-lg bg-popover/95 px-3 py-2 text-xs font-medium text-foreground shadow-popover ring-1 ring-border">
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />{t.ovmPeriodLoading}
                    </span>
                  </div>
                )}
                {monthMode && !loadingCal && periodPoints === 0 && (
                  <div className="pointer-events-none absolute inset-x-0 top-2 z-[1100] flex justify-center px-2">
                    <span className="rounded-lg bg-popover/95 px-2.5 py-1 text-[11px] font-medium text-foreground shadow-popover ring-1 ring-border">
                      {t.ovmNoPeriodGps}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Person dossier — opens from the panel or from a single-person map marker ── */}
      <PersonDossier
        person={dossierPerson}
        date={selectedDay}
        monthDays={monthDays}
        onClose={() => setDossierEpf(null)}
      />

    </div>
    </PageTransition>
  );
}

export default function AdminDashboardPage() {
  return <AdminDashboardContent />;
}
