'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  FileBarChart2, Calendar, Building2,
  Users, Loader2, AlertTriangle, Lock,
  MapPin, Palmtree,
  CalendarCog, Wrench, Briefcase, Wallet, Receipt, UtensilsCrossed,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities, useRoles } from '@/store/rolesStore';
import { useT } from '@/store/appStore';
import { roleCategory } from '@/lib/permissions';
import { getCompanies } from '@/services/companyService';
import { getAllUsers, getAllEmployees } from '@/services/userService';
import { getCompanyAttendanceForMonth } from '@/services/attendanceService';
import { getCompanyLeavesForReport, getLeaveTypes } from '@/services/leaveService';
import { getOutstationLocations } from '@/services/outstationService';
import { getShiftAssignments } from '@/services/shiftService';
import { getWorkingPlaces } from '@/services/workingPlaceService';
import { getDepartments } from '@/services/departmentService';
import { getScheduleAssignmentsForMonth } from '@/services/scheduleAssignmentService';
import { getAcceptedHolidays, fetchPublicHolidays } from '@/services/holidayService';
import { getWorkPatterns } from '@/services/workPatternService';
import { getEffectiveScheduleMap } from '@/services/workingScheduleService';
import { localDateString } from '@/lib/utils';
import {
  computeUserMonthlyReport, exportCompanyCategoryReportXlsx,
  computeAttendanceViewReportRows, exportAttendanceViewReportXlsx,
  LEAVE_COUNT_CUTOFF,
} from '@/lib/userMonthlyReport';
import { getMonthlyDeductionTotals } from '@/services/suspenseService';
import SuspenseReport from '@/components/reports/SuspenseReport';
import VoucherReport from '@/components/reports/VoucherReport';
import FoodReport from '@/components/reports/FoodReport';
import { tenant } from '@/lib/firebase';
import type { Company, AppUser, AttendanceRecord, LeaveRecord, ShiftAssignment } from '@/lib/types';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { StatCard, type Tone } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import Select from '@/components/Select';
import MonthYearPicker from '@/components/MonthYearPicker';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { PageTransition, Reveal, Stagger, StaggerItem } from '@/components/ui/motion';
import { useReportEditor, ReportEditControls, EditableCell, numeric } from '@/components/reports/editableReport';
import type { UserMonthlyReport } from '@/lib/userMonthlyReport';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

// Group an array of records by epf_number for per-employee slicing.
function groupByEpf<T extends { epf_number: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const arr = map.get(it.epf_number);
    if (arr) arr.push(it);
    else map.set(it.epf_number, [it]);
  }
  return map;
}

// 'all' — southernlanka (hospital) only: one report over every employee (no technician /
// non-technician split there). Routed to generateStaffAttendanceReport, which mirrors the
// Attendance View page rather than the technician/executive sheets.
type Category = 'technician' | 'executive' | 'all';

// A generated-but-not-yet-downloaded report. Generation and download used to be one click; they
// are now two for the technician/executive reports, with an editable table in between — the
// admin fixes what the raw data got wrong (a name, a count the department corrected by hand)
// and downloads what they see. Edits are export-only, exactly as in the other report tabs:
// nothing is written back to attendance. Southern Lanka's "Download Report" (generateStaffAttendanceReport
// above) deliberately skips this — one click, straight to a downloaded file, as it always was.
type ReportPreview =
  { kind: 'category'; rows: UserMonthlyReport[]; isTechnician: boolean; shiftPlaceNames: string[]; companyLabel: string };

function ReportsContent() {
  const { user } = useAuthStore();
  const t = useT();
  const { roles } = useRoles();
  const caps = useUserCapabilities();

  const [companies,  setCompanies]  = useState<Company[]>([]);
  const [companyId,  setCompanyId]  = useState('');
  const [year,       setYear]       = useState(new Date().getFullYear());
  const [month,      setMonth]      = useState(new Date().getMonth() + 1);
  const [generating, setGenerating] = useState<Category | null>(null);
  // null = still checking; false = no accepted holidays for the year → block generation.
  const [holidaysDefined, setHolidaysDefined] = useState<boolean | null>(null);
  const [reportTab, setReportTab] = useState<'attendance' | 'suspense' | 'food'>('attendance');
  // Sub-tab within Suspense Reports — starts on "bills" so Vouchers (which auto-loads its
  // own data on mount) never fetches/renders until the user actually asks for it.
  const [suspenseSubTab, setSuspenseSubTab] = useState<'bills' | 'vouchers'>('bills');

  // Generated report waiting to be checked over and downloaded (see ReportPreview).
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [downloading, setDownloading] = useState(false);
  const editor = useReportEditor();

  // ── At-a-glance overview (counts for the selected scope) ──
  const [overview, setOverview] = useState<{
    employees: number; technicians: number; nonTech: number;
    leaveTypes: number; outstations: number;
  } | null>(null);

  useEffect(() => {
    getCompanies().then(list => {
      setCompanies(list);
      if (list.length === 1) setCompanyId(list[0].id);
    }).catch(() => {});
  }, [user]);

  // Overview counts — reload when the company scope (or the role registry) changes.
  // Employees / technician split follow the selected company; leave types & outstations
  // are org-wide. Cheap collection reads, so it's safe to load on mount.
  useEffect(() => {
    let cancelled = false;
    Promise.all([getAllUsers(companyId), getLeaveTypes(), getOutstationLocations()])
      .then(([users, leaveTypes, outstations]) => {
        if (cancelled) return;
        const technicians = users.filter(u => roleCategory(u.role, roles) === 'technician').length;
        setOverview({
          employees:   users.length,
          technicians,
          nonTech:     users.length - technicians,
          leaveTypes:  leaveTypes.length,
          outstations: outstations.length,
        });
      })
      .catch(() => { if (!cancelled) setOverview(null); });
    return () => { cancelled = true; };
  }, [companyId, roles]);

  // Whether the selected year has any accepted company holidays — drives the guard banner
  // and disables the download buttons until holidays are defined (in Leave Types).
  useEffect(() => {
    let cancelled = false;
    setHolidaysDefined(null);
    getAcceptedHolidays(year)
      .then(set => { if (!cancelled) setHolidaysDefined(set.size > 0); })
      .catch(() => { if (!cancelled) setHolidaysDefined(false); });
    return () => { cancelled = true; };
  }, [year]);

  const canReport = caps.can_report;
  if (!canReport) {
    return (
      <PageTransition className="space-y-6">
        <PageHeader title={t.attendanceReports} description={t.reportsDesc} icon={FileBarChart2} />
        <Reveal>
          <Card>
            <EmptyState icon={Lock} title={t.noAccessReports} description={t.noReportsPermission} />
          </Card>
        </Reveal>
      </PageTransition>
    );
  }

  const yearOptions = [2023, 2024, 2025, 2026].filter(y => y <= new Date().getFullYear());
  const selectedCompanyName = companyId
    ? (companies.find(c => c.id === companyId)?.name ?? '—')
    : t.allCompanies;

  // Southernlanka "Download Report" — a spreadsheet mirror of the Attendance View page
  // (src/app/(pages)/attendance-view/page.tsx): every employee's monthly present/absent
  // tally + Late / Early totals, computed with that page's exact shift engine (see
  // computeAttendanceViewReportRows). No holiday guard — attendance-view doesn't use one
  // (lateness is scored against each day's scheduled shift, not an accepted-holiday list).
  // One click, straight to a downloaded file — unlike the technician/executive reports below,
  // this never goes through the editable preview table. It never did before the edit-mode
  // feature was added; Southern Lanka asked to keep the original one-click behaviour here.
  const generateStaffAttendanceReport = async () => {
    setGenerating('all');
    try {
      const [employees, attendance, departments, monthAssignments] = await Promise.all([
        getAllEmployees(companyId),
        getCompanyAttendanceForMonth(companyId, year, month),
        getDepartments(),
        // Bounded by date server-side (see getScheduleAssignmentsForMonth) — NOT a
        // per-department fetch. Fetching each in-scope department's assignments separately
        // pulled that department's ENTIRE unbounded roster history every time (that function
        // deliberately ignores date), which got slower every month as history piled up until
        // this report effectively never finished generating.
        getScheduleAssignmentsForMonth(year, month),
      ]);

      const deptsInScope = companyId
        ? departments.filter(d => d.company_id === companyId)
        : departments;
      const deptIdsInScope = new Set(deptsInScope.map(d => d.id));
      const assignments = monthAssignments.filter(a => deptIdsInScope.has(a.department_id));

      const rows = computeAttendanceViewReportRows({
        employees, records: attendance, assignments, year, month,
      });
      if (rows.length === 0) {
        toast.error(t.noEmployeesCategory);
        return;
      }

      const companyLabel = companyId
        ? (companies.find(c => c.id === companyId)?.name ?? companyId)
        : 'All_Companies';
      await exportAttendanceViewReportXlsx({ rows, year, month, companyLabel });
      toast.success(t.reportDownloaded);
    } catch (e) {
      console.error(e);
      toast.error(t.failedGenerateReport);
    } finally {
      setGenerating(null);
    }
  };

  // Build + download one category's report (Technician or Executive/non-technician),
  // scoped by the selected company / year / month. Requires the year to have accepted
  // company holidays defined (used to exclude holidays from absent-day counts).
  const generate = async (category: Category) => {
    if (category === 'all') { await generateStaffAttendanceReport(); return; }
    setGenerating(category);
    try {
      const wantTech = category === 'technician';

      // Guard: no company holidays for this year → block and point to Leave Types.
      const holidays = await getAcceptedHolidays(year);
      if (holidays.size === 0) {
        setHolidaysDefined(false);
        toast.error(t.noHolidaysDefined);
        return;
      }
      setHolidaysDefined(true);

      const monthFromMs = new Date(year, month - 1, 1).getTime();
      const monthToMs   = new Date(year, month, 1).getTime() - 1;

      const [employees, attendance, leaves, outstations, publicHols, shiftAssignments, workingPlaces, deductionTotals, workPatterns] = await Promise.all([
        // Inactive accounts INCLUDED — narrowed to the ones who actually worked this month
        // just below. Resigning deactivates the account (see /users), so the default active-
        // only list silently dropped every leaver from the very month they worked out their
        // notice, and payroll never saw the days they are owed.
        getAllUsers(companyId, true),
        getCompanyAttendanceForMonth(companyId, year, month),
        getCompanyLeavesForReport(companyId, year, month),
        getOutstationLocations(),
        fetchPublicHolidays(year),   // for Poya dates (both sheets count Poya as an extra day)
        // Shift inputs only matter for the technician sheet.
        wantTech ? getShiftAssignments(companyId) : Promise.resolve([] as ShiftAssignment[]),
        wantTech ? getWorkingPlaces() : Promise.resolve([]),
        // Suspense salary deductions — Alta Vision-only module; other tenants must not scan
        // (or even show the column for) a collection they don't use.
        tenant.features.suspense ? getMonthlyDeductionTotals(monthFromMs, monthToMs) : Promise.resolve(new Map<string, number>()),
        // Best-effort, as on the attendance calendar: if the read fails, the built-in week
        // applies and the leave count is exactly what it was before work patterns existed.
        getWorkPatterns().catch(() => []),
      ]);
      const poyaDates = new Set(publicHols.filter(h => h.is_poya).map(h => h.date));

      // The month's roster: everyone still active, plus anyone deactivated (a resignation
      // always deactivates; HR also deactivates on its own) who HAS attendance in this month.
      // The attendance test is what keeps the widened fetch honest — a deactivated account
      // that never worked the month, a pending self-registration from /register, a leaver from
      // two years ago, all have no records here and stay out exactly as before.
      const epfsWithAttendance = new Set(attendance.map(r => r.epf_number));
      const roster = employees.filter((u: AppUser) =>
        u.is_active !== false || epfsWithAttendance.has(u.epf_number));

      const catEmployees = roster.filter((u: AppUser) => {
        const isTech = roleCategory(u.role, roles) === 'technician';
        return wantTech ? isTech : !isTech;   // executive sheet = executive + top management
      });

      if (catEmployees.length === 0) {
        toast.error(t.noEmployeesCategory);
        return;
      }

      const attByEpf   = groupByEpf<AttendanceRecord>(attendance);
      const lvByEpf    = groupByEpf<LeaveRecord>(leaves);
      const shiftByEpf = groupByEpf<ShiftAssignment>(shiftAssignments);
      const shiftPlaceNames = new Set(
        workingPlaces.filter(w => w.tags?.includes('shift')).map(w => w.name.toLowerCase()));

      // A location-scoped work pattern needs each employee's current working place. Reading
      // every working schedule is one whole-collection read, so it happens only when such a
      // pattern exists. If it fails, a location pattern simply does not apply.
      const needsPlace = workPatterns.some(p => p.is_active && p.scope === 'location');
      let schedules: Record<string, { working_place: string }> = {};
      if (needsPlace) {
        try { schedules = await getEffectiveScheduleMap(localDateString()); }
        catch { /* fall back to company and role patterns */ }
      }

      const rows = catEmployees.map(u => computeUserMonthlyReport({
        user: u,
        isTechnician: wantTech,
        attendance: attByEpf.get(u.epf_number) ?? [],
        leaves:     lvByEpf.get(u.epf_number) ?? [],
        outstations,
        holidays,
        poyaDates,
        year, month,
        shiftAssignments: shiftByEpf.get(u.epf_number) ?? [],
        shiftPlaceNames,
        saturdayHalfDay: tenant.features.saturdayHalfDay,
        leaveCountCutoff: LEAVE_COUNT_CUTOFF,
        workPatterns,
        patternSubject: {
          company_id: u.company_id ?? null,
          role: u.role ?? null,
          working_place: schedules[u.epf_number]?.working_place ?? null,
        },
        suspenseDeduction: deductionTotals.get(u.epf_number) ?? 0,
      }));

      const companyLabel = companyId
        ? (companies.find(c => c.id === companyId)?.name ?? companyId)
        : 'All_Companies';

      // Column set for the per-place shift-hours columns = every shift place actually worked.
      const shiftPlaceCols = Array.from(
        new Set(rows.flatMap(r => r.shiftByPlace.map(s => s.name)))).sort();

      editor.reset();
      setPreview({ kind: 'category', rows, isTechnician: wantTech, shiftPlaceNames: shiftPlaceCols, companyLabel });
    } catch (e) {
      console.error(e);
      toast.error(t.failedGenerateReport);
    } finally {
      setGenerating(null);
    }
  };

  // Download what is ON SCREEN: every edited cell is folded back into the row before the
  // existing exporters see it, so the spreadsheet and the table can never disagree.
  const downloadPreview = async () => {
    if (!preview) return;
    setDownloading(true);
    try {
      const rows: UserMonthlyReport[] = preview.rows.map(r => ({
        ...r,
        name:             editor.value(r.epf, 'name', r.name),
        workingDays:      numeric(editor.value(r.epf, 'workingDays', r.workingDays)),
        extraSunDays:     numeric(editor.value(r.epf, 'extraSunDays', r.extraSunDays)),
        outstationDays:   numeric(editor.value(r.epf, 'outstationDays', r.outstationDays)),
        foodPoints:       numeric(editor.value(r.epf, 'foodPoints', r.foodPoints)),
        totalLeaves:      numeric(editor.value(r.epf, 'totalLeaves', r.totalLeaves)),
        approvedLeaves:   numeric(editor.value(r.epf, 'approvedLeaves', r.approvedLeaves)),
        unapprovedLeaves: numeric(editor.value(r.epf, 'unapprovedLeaves', r.unapprovedLeaves)),
        absentDays:       numeric(editor.value(r.epf, 'absentDays', r.absentDays)),
        shiftWorkingDays: numeric(editor.value(r.epf, 'shiftWorkingDays', r.shiftWorkingDays)),
        suspenseDeduction: numeric(editor.value(r.epf, 'suspenseDeduction', r.suspenseDeduction)),
      }));
      await exportCompanyCategoryReportXlsx({
        rows, isTechnician: preview.isTechnician,
        shiftPlaceNames: preview.shiftPlaceNames,
        year, month, companyLabel: preview.companyLabel,
        includeSuspense: tenant.features.suspense,
      });
      toast.success(t.reportDownloaded);
    } catch (e) {
      console.error(e);
      toast.error(t.failedGenerateReport);
    } finally {
      setDownloading(false);
    }
  };

  // The columns worth correcting by hand. Everything else the sheet carries (per-location
  // outstation breakdowns, per-place shift hours) is derived from many rows at once and would
  // be misleading to patch one cell at a time, so it is generated and left alone.
  const previewColumns: Array<{ key: string; label: string; numeric?: boolean }> = [
    { key: 'name',             label: 'Employee' },
    { key: 'workingDays',      label: 'Working days', numeric: true },
    { key: 'extraSunDays',     label: 'Extra days', numeric: true },
    { key: 'outstationDays',   label: 'Outstation', numeric: true },
    // Technician sheet only. The executive sheet carries no food or allowance columns at all
    // (see exportCompanyCategoryReportXlsx), so showing this on an executive preview offered
    // a number to correct that the download then silently drops.
    ...(preview?.isTechnician ? [{ key: 'foodPoints', label: 'Food points', numeric: true }] : []),
    { key: 'totalLeaves',      label: 'Leaves', numeric: true },
    { key: 'approvedLeaves',   label: 'Approved', numeric: true },
    { key: 'unapprovedLeaves', label: 'Unapproved', numeric: true },
    { key: 'absentDays',       label: 'Absent', numeric: true },
    { key: 'shiftWorkingDays', label: 'Shift days', numeric: true },
    ...(tenant.features.suspense ? [{ key: 'suspenseDeduction', label: 'Suspense (Rs.)', numeric: true }] : []),
  ];

  const previewCard = preview && (
    <Reveal>
      <Card className="mt-4 p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              {preview.isTechnician ? t.technicianReport : t.executiveReport}
            </h3>
            <p className="text-[11px] text-muted-foreground">
              {preview.rows.length} employees · {selectedCompanyName} · {MONTHS[month - 1]} {year} · check it over, correct anything wrong, then download.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ReportEditControls editor={editor} />
            <Button size="sm" onClick={downloadPreview} disabled={downloading}>
              {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileBarChart2 className="h-4 w-4" />} {t.downloadReport}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setPreview(null); editor.reset(); }}>{t.cancel}</Button>
          </div>
        </div>

        <div className="max-h-[28rem] overflow-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/80 text-xs uppercase tracking-wider text-muted-foreground backdrop-blur">
              <tr>
                <th className="px-3 py-2 text-left">EPF</th>
                {previewColumns.map(c => (
                  <th key={c.key} className={`px-3 py-2 ${c.numeric ? 'text-right' : 'text-left'}`}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {preview.rows.map(r => ({
                key: r.epf,
                resignedOn: r.dateOfResign,
                row: r as unknown as Record<string, string | number>,
              })).map(({ key, resignedOn, row }) => {
                return (
                  <tr key={key}>
                    {/* Leavers are on this list on purpose — they worked part of the month.
                        Said in words, with the last day, because the palette cannot carry it:
                        --warning is not distinct enough from --primary to mean anything here. */}
                    <td className="px-3 py-2 align-top tabular-nums text-muted-foreground">
                      <div>{key}</div>
                      {resignedOn && (
                        <div className="mt-0.5 whitespace-nowrap text-[11px] font-semibold uppercase tracking-wide text-warning">
                          {t.resignedLabel} {resignedOn}
                        </div>
                      )}
                    </td>
                    {previewColumns.map(c => (
                      <td key={c.key} className={`px-3 py-2 ${c.numeric ? 'text-right tabular-nums' : ''}`}>
                        <EditableCell
                          editor={editor}
                          rowKey={key}
                          field={c.key}
                          value={row[c.key] ?? (c.numeric ? 0 : '')}
                          type={c.numeric ? 'number' : 'text'}
                          align={c.numeric ? 'right' : 'left'}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </Reveal>
  );

  const blocked = holidaysDefined === false;

  // Southernlanka is a hospital system — it has no "technician" job category, so the
  // technician / non-technician breakdown is meaningless there. Drop those two tiles and
  // narrow the grid so the remaining labels have room (no truncation).
  const isSouthernlanka = tenant.id === 'southernlanka';
  const overviewTiles = ([
    { label: t.companiesLabel,      value: companies.length,      icon: Building2, tone: 'brand'   },
    { label: t.employeesCap,        value: overview?.employees,   icon: Users,     tone: 'primary' },
    ...(isSouthernlanka ? [] : [
      { label: t.techniciansLabel,    value: overview?.technicians, icon: Wrench,    tone: 'success' },
      { label: t.nonTechniciansLabel, value: overview?.nonTech,     icon: Briefcase, tone: 'warning' },
    ]),
    { label: t.leaveTypesLabel,     value: overview?.leaveTypes,  icon: Palmtree,  tone: 'brand'   },
    { label: t.outstationsLabel,    value: overview?.outstations, icon: MapPin,    tone: 'primary' },
  ] as Array<{ label: string; value: number | undefined; icon: typeof Users; tone: Tone }>);
  const overviewGridCols = overviewTiles.length <= 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-6';
  // Suspense/voucher report tab — gated on can_approve_suspense (NOT just can_report): it
  // surfaces org-wide expense bills/receipts, the same restriction the suspense page applies
  // to its approver views.
  const showSuspenseTab = tenant.features.suspense && caps.can_approve_suspense;
  // Food report tab — the monthly chamary deduction. Only can_report, unlike the suspense tab:
  // it shows meal counts and a salary deduction, never anyone's expense bills.
  const showFoodTab = tenant.features.suspense && caps.can_report;

  // What the export covers, as one plain-language line instead of a separate checklist card.
  const whatsIncluded = [
    t.attendanceDays, t.outstationByLocationLabel, t.morningEveningAllowances,
    t.leaveTotals, t.absenceCount, t.sundayHolidayWork,
  ].join(' · ');

  // ── Monthly attendance report: pick a period, download for your team ──
  // Full-width card — period picker and downloads sit side by side on desktop so the card
  // fills the row like everything else on the page, instead of floating as a narrow box.
  const attendanceSection = (
    <Reveal>
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-brand text-primary-foreground shadow-soft">
              <FileBarChart2 className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight text-foreground">{t.monthlySummaryReport}</h2>
              <p className="text-sm text-muted-foreground">{t.excelExportDesc}</p>
            </div>
          </div>
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            <Calendar className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{selectedCompanyName} · {MONTHS[month - 1]} {year}</span>
          </span>
        </div>

        {/* Guard: no company holidays for the year → block generation, point to Leave Types */}
        {blocked && (
          <div className="mt-5 flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <div className="min-w-0 text-sm">
              <p className="font-semibold text-foreground">{t.noHolidaysTitle}</p>
              <p className="text-muted-foreground">{t.noHolidaysDesc}</p>
              <Link href="/leave-types" className="mt-1.5 inline-flex items-center gap-1 font-semibold text-primary hover:underline">
                <CalendarCog className="h-3.5 w-3.5" />{t.manageHolidays}
              </Link>
            </div>
          </div>
        )}

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr] lg:divide-x lg:divide-border">
          {/* Step 1: pick the period + scope */}
          <div className="space-y-2 lg:pr-6">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Report period</Label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select
                searchable
                value={companyId || 'all'}
                onChange={v => setCompanyId(v === 'all' ? '' : v)}
                options={[{ value: 'all', label: t.allCompanies }, ...companies.map(c => ({ value: c.id, label: c.name }))]}
              />
              <MonthYearPicker year={year} month={month} years={yearOptions} onChange={(y, m) => { setYear(y); setMonth(m); }} />
            </div>

            <p className="pt-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{t.whatsIncluded}:</span> {whatsIncluded}
            </p>
          </div>

          {/* Step 2: download for the right group of employees */}
          <div className="space-y-2 lg:pl-6">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Download</Label>
            <div className="grid grid-cols-1 gap-3">
              {isSouthernlanka ? (
                // Hospital tenant — no technician / non-technician split, so one report
                // covering every employee (full layout: allowances, shift hours, leave).
                <Button
                  onClick={() => generate('all')}
                  disabled={generating !== null || blocked}
                  className="h-12 w-full rounded-xl bg-gradient-to-r from-primary to-brand text-sm font-semibold shadow-soft transition-[opacity,box-shadow] hover:opacity-95 hover:glow-primary disabled:opacity-60"
                >
                  {generating === 'all'
                    ? <><Loader2 className="h-4 w-4 animate-spin" />{t.generatingReport}</>
                    : <><FileBarChart2 className="h-4 w-4" />{t.downloadReport}</>
                  }
                </Button>
              ) : (
                <>
                  <Button
                    onClick={() => generate('technician')}
                    disabled={generating !== null || blocked}
                    className="h-12 w-full rounded-xl bg-gradient-to-r from-primary to-brand text-sm font-semibold shadow-soft transition-[opacity,box-shadow] hover:opacity-95 hover:glow-primary disabled:opacity-60"
                  >
                    {generating === 'technician'
                      ? <><Loader2 className="h-4 w-4 animate-spin" />{t.generatingReport}</>
                      : <><Wrench className="h-4 w-4" />{t.technicianReport}</>
                    }
                  </Button>
                  <Button
                    onClick={() => generate('executive')}
                    disabled={generating !== null || blocked}
                    variant="outline"
                    className="h-12 w-full rounded-xl border-primary/30 text-sm font-semibold text-primary hover:bg-primary/5 disabled:opacity-60"
                  >
                    {generating === 'executive'
                      ? <><Loader2 className="h-4 w-4 animate-spin" />{t.generatingReport}</>
                      : <><Briefcase className="h-4 w-4" />{t.executiveReport}</>
                    }
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </Card>
    </Reveal>
  );

  return (
    <PageTransition className="space-y-6">
      <PageHeader title={t.attendanceReports} description={t.reportsDesc} icon={FileBarChart2} />

      {/* At-a-glance overview — structural counts for the selected scope */}
      <Stagger className={`grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 ${overviewGridCols}`}>
        {overviewTiles.map(tile => (
          <StaggerItem key={tile.label}>
            <StatCard label={tile.label} value={tile.value ?? '—'} icon={tile.icon} tone={tile.tone} wrapLabel />
          </StaggerItem>
        ))}
      </Stagger>

      {showSuspenseTab || showFoodTab ? (
        <Tabs value={reportTab} onValueChange={v => setReportTab(v as 'attendance' | 'suspense' | 'food')}>
          <TabsList className="h-auto w-full justify-start gap-1 p-1 sm:w-fit">
            <TabsTrigger value="attendance" className="flex-1 px-3 py-1.5 sm:flex-none sm:px-4">
              <FileBarChart2 className="h-3.5 w-3.5 shrink-0" />
              <span>{t.monthlySummaryReport}</span>
            </TabsTrigger>
            {showSuspenseTab && (
              <TabsTrigger value="suspense" className="flex-1 px-3 py-1.5 sm:flex-none sm:px-4">
                <Wallet className="h-3.5 w-3.5 shrink-0" />
                <span>Suspense Reports</span>
              </TabsTrigger>
            )}
            {showFoodTab && (
              <TabsTrigger value="food" className="flex-1 px-3 py-1.5 sm:flex-none sm:px-4">
                <UtensilsCrossed className="h-3.5 w-3.5 shrink-0" />
                <span>{t.foodReports}</span>
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="attendance">
            {attendanceSection}
            {previewCard}
          </TabsContent>

          <TabsContent value="suspense">
            <Tabs value={suspenseSubTab} onValueChange={v => setSuspenseSubTab(v as 'bills' | 'vouchers')}>
              <TabsList className="mb-4 h-auto w-full justify-start gap-1 p-1 sm:w-fit">
                <TabsTrigger value="bills" className="flex-1 px-3 py-1.5 sm:flex-none sm:px-4">
                  <Wallet className="h-3.5 w-3.5 shrink-0" />
                  <span>Bills</span>
                </TabsTrigger>
                <TabsTrigger value="vouchers" className="flex-1 px-3 py-1.5 sm:flex-none sm:px-4">
                  <Receipt className="h-3.5 w-3.5 shrink-0" />
                  <span>Vouchers</span>
                </TabsTrigger>
              </TabsList>

              {/* ── Suspense report: expense bills with images, filter by employee & status ── */}
              <TabsContent value="bills" className="mt-0">
                <SuspenseReport companies={companies} />
              </TabsContent>

              {/* ── Vouchers: approved bills consolidated per employee + category/subcategory,
                  settled (QuickBooks-reconciled) tracking. Kept in its own sub-tab (not shown
                  alongside Bills) since it auto-loads all vouchers on mount. ── */}
              <TabsContent value="vouchers" className="mt-0">
                <VoucherReport companies={companies} autoLoad={false} />
              </TabsContent>
            </Tabs>
          </TabsContent>

          {/* ── Food report: each chamary's monthly meals and the salary deduction they work
              out to (its approved food bills ÷ its total meals × each person's count). ── */}
          <TabsContent value="food">
            <p className="mb-4 text-sm text-muted-foreground">{t.foodReportDesc}</p>
            <FoodReport companies={companies} />
          </TabsContent>
        </Tabs>
      ) : attendanceSection}
    </PageTransition>
  );
}

export default function ReportsPage() {
  return <ReportsContent />;
}
