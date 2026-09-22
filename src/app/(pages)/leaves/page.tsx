'use client';
import { useEffect, useState, Suspense, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSearchParams } from 'next/navigation';
import {
  CalendarDays, Plus, Edit2, Trash2, CheckCircle, XCircle,
  Clock, ChevronRight, Loader2, X, Users, FileText, Search,
  CalendarOff, RefreshCw, CalendarClock, History,
} from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { useT } from '@/store/appStore';
import { tenant } from '@/lib/firebase';
import { _leaveApi as leaveApi, _profileApi as profileApi, leaveApi as leaveApiRT } from '@/services/apiCompat';
import { getScheduleAssignmentsForEmployee } from '@/services/scheduleAssignmentService';
import type { ScheduleAssignment } from '@/lib/types';
import {
  shiftCutoffViolation, leaveTypeHasApplyCutoff,
  LEAVE_APPLY_CUTOFF_HOURS, LEAVE_DELETION_CUTOFF_HOURS,
  LEAVE_APPLY_SHIFT_CUTOFF_MSG, LEAVE_DELETION_SHIFT_CUTOFF_MSG,
} from '@/lib/shiftCutoff';
import { formatDate, localDateString, isSunday } from '@/lib/utils';
import { LeaveRequestRow, LeaveRequestModal, type LeaveRequestData } from '@/components/LeaveRequestCard';
import AssignRestrictedLeaveDialog from '@/components/AssignRestrictedLeaveDialog';
import Portal from '@/components/Portal';
import EmployeeLeaveHistoryDialog, {
  EmployeeNameButton, fetchEmployeeLeaveHistory, type HistoryLeave,
} from '@/components/leaves/EmployeeLeaveHistory';
import PassedRequestsDialog from '@/components/leaves/PassedRequestsDialog';
import { statusBadgeVariant, statusVisual } from '@/components/leaves/leaveStatus';
import { ListSkeleton, PageHeaderSkeleton, StatCardsSkeleton, FormSkeleton } from '@/components/ui/Skeleton';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { PageTransition, Stagger, StaggerItem, Reveal, MotionCard } from '@/components/ui/motion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import toast from 'react-hot-toast';

const cardInitial = (n?: string | null) => (n?.trim()?.charAt(0)?.toUpperCase() ?? '?');

// Short "Jul 3, 09:12"-style stamp for the requested/considered times.
const formatDateTime = (iso?: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

// "Jul 3, 2026" or "Jul 3 → Jul 10" style date range (single date when from === to).
const fmtRange = (a: string, b: string): string => (a === b ? formatDate(a) : `${formatDate(a)} → ${formatDate(b)}`);

// ─── Types ────────────────────────────────────────────────────────────────────
// `HistoryLeave` is the shape apiCompat's leave builders return (leave_id, dates, status,
// reason, the requested/considered trail and the deletion-request tags — see
// @/components/leaves/EmployeeLeaveHistory). The page adds the two fields only it needs, so a
// leave read here and a leave read by the history dialog can never drift apart.
interface Leave extends HistoryLeave {
  leave_type_id?:    string;  // leave_types doc id — see apiCompat.ts's resolveLeaveTypeName
  supervisor_epf?:   string | null; // epf of the supervisor the leave was requested from
}

// Shared by loadData's one-shot fetch and the southernlanka real-time subscription further
// down — both need the exact same raw leave_requests[] → Leave[] shape, mapping `name` →
// `employee_name` and adding status='pending' (all of these are pending by definition).
function mapTeamLeaveRequests(arr: unknown[]): Leave[] {
  return (Array.isArray(arr) ? arr : []).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      leave_id:         r.leave_id as number,
      epf_number:       r.epf_number as string | undefined,
      from_date:        r.from_date as string,
      to_date:          r.to_date as string,
      leave_type_name:  r.leave_type_name as string,
      reason:           r.reason as string | undefined,
      employee_name:    r.name as string,
      status:           'pending',
      is_half_day:      r.is_half_day as boolean | undefined,
      half_day_period:  r.half_day_period as string | null | undefined,
      is_paid:          r.is_paid as boolean | undefined,
      supervisor_epf:   r.supervisor_epf as string | null | undefined,
      requested_from:   r.requested_from as string | undefined,
      requested_at:     r.requested_at as string | null | undefined,
    };
  });
}

interface Supervisor  { epf_number: string; name: string; }
interface LeaveBalance { leave_type?: string; type?: string; available?: number; total?: number; }

/**
 * The tracked-but-not-entitled leave types (LeaveType.excluded_from_quota) that ride on a
 * getLeaveSummary array as an attached prop, alongside the trainee meta.
 *
 * They are deliberately NOT LeaveBalance rows: they have no quota and no `available`, so mixing
 * them in would have every consumer here read `available` off them and print a confident 0 —
 * on the apply guard, that zero would read as "exhausted" and refuse the type outright.
 */
function readTakenOnly(summary: unknown): { name: string; taken: number }[] {
  const rows = (summary as { excluded_leave_types?: { leave_type?: string; type?: string; taken?: number }[] })
    ?.excluded_leave_types;
  if (!Array.isArray(rows)) return [];
  return rows.map(r => ({
    name:  String(r.leave_type ?? r.type ?? ''),
    taken: Math.round((Number(r.taken) || 0) * 2) / 2,
  }));
}
interface LeaveTypeOption {
  id: string;
  name: string;
  is_paid: boolean;
  requires_reason: boolean;
  allow_backdate_days: number;
  allow_unpaid_choice: boolean;
  allow_direct_apply: boolean;
  is_trainee_accruable: boolean;
}

type LeaveDuration = 'half' | 'one' | 'range';
type HalfPeriod    = 'morning' | 'afternoon' | '';

// Form state — matches backend field names exactly
const BLANK_FORM = {
  duration:         'one' as LeaveDuration,
  date:             '',   // used for half-day and one-day tabs
  from_date:        '',   // used for range tab
  to_date:          '',   // used for range tab
  half_day_period:  '' as HalfPeriod,
  leave_type:       '',
  request_from:     '',
  reason:           '',
  is_paid:          true,   // for leave types that allow paid/unpaid choice
};

// One on-leave person as returned by getTodayLeaveList.
type OnLeaveItem = { name: string; epf_number: string; status: string; leave_type_name?: string; is_half_day?: boolean; half_day_period?: string | null; consider_by?: string | null };

// The next `count` upcoming dates excluding Sundays (starting today).
function nextWorkingDates(count: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let guard = 0; out.length < count && guard < count * 3 + 14; guard++) {
    const iso = localDateString(d);
    if (!isSunday(iso)) out.push(iso);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// "Mon, Jul 14"-style label for a YYYY-MM-DD date.
function prettyWeekday(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// Build a list of every calendar date between two YYYY-MM-DD strings (inclusive)
function getDatesInRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const cur = new Date(fy, fm - 1, fd);
  const end = new Date(ty, tm - 1, td);
  while (cur <= end) {
    const pad = (n: number) => String(n).padStart(2, '0');
    dates.push(`${cur.getFullYear()}-${pad(cur.getMonth()+1)}-${pad(cur.getDate())}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// ─── Leave Card ───────────────────────────────────────────────────────────────
function LeaveCard({
  leave, onEdit, onDelete, onRequestDelete, onApprove, onReject, loading, showEmployee,
}: {
  leave:         Leave;
  onEdit?:       () => void;
  onDelete?:     () => void;
  onRequestDelete?: () => void;   // approved leaves — routes a deletion request to the approver
  onApprove?:    () => void;
  onReject?:     () => void;
  loading:       boolean;
  showEmployee?: boolean;
}) {
  const t = useT();
  const sv = statusVisual(leave.status);

  return (
    <Card className={`p-3.5 border-l-[3px] ${sv.accent} transition-colors hover:bg-accent/40`}>
      <div className="flex items-start gap-3">
        {/* ── Status icon chip ── */}
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${sv.chip}`}>
          <sv.Icon className={`w-5 h-5 ${sv.text}`} />
        </div>

        <div className="flex-1 min-w-0">
          {/* Employee name (team view) */}
          {showEmployee && leave.employee_name && (
            <div className="text-sm font-semibold text-foreground truncate mb-0.5">{leave.employee_name}</div>
          )}

          {/* ── Date range — the headline ── */}
          <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground flex-wrap">
            <CalendarDays className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <span>{formatDate(leave.from_date)}</span>
            {leave.from_date !== leave.to_date && (
              <><ChevronRight className="w-3.5 h-3.5 text-muted-foreground" /><span>{formatDate(leave.to_date)}</span></>
            )}
            {leave.is_half_day && leave.half_day_period && (
              <Badge variant="brand" className="capitalize ml-0.5">{leave.half_day_period}</Badge>
            )}
          </div>

          {/* ── Meta pills: status + type + half-day + deletion-request state ── */}
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <Badge variant={statusBadgeVariant(leave.status)} className="capitalize gap-1">
              <sv.Icon className="w-3 h-3" />{leave.status}
            </Badge>
            {leave.leave_type_name && <Badge variant="muted">{leave.leave_type_name}</Badge>}
            {leave.is_half_day && <Badge variant="brand">{t.halfDay}</Badge>}
            {/* An in-context tag for a deletion request the approver turned down (or one still
                pending) — so the card isn't just a bare "Approved" after the notification. */}
            {leave.delete_request_status === 'rejected' && (
              <Badge variant="destructive" className="gap-1">
                <Trash2 className="w-3 h-3" />{t.deletionRejectedBadge}
              </Badge>
            )}
            {leave.delete_request_status === 'pending' && (
              <Badge variant="warning" className="gap-1">
                <Trash2 className="w-3 h-3" />{t.deletionPendingBadge}
              </Badge>
            )}
          </div>

          {/* ── Reason ── */}
          {leave.reason && (
            <p className="text-xs text-muted-foreground mt-2 line-clamp-2">{leave.reason}</p>
          )}

          {/* Approver's note when a deletion request was rejected */}
          {leave.delete_request_status === 'rejected' && leave.delete_request_reason && (
            <p className="text-xs text-destructive/90 mt-1.5 line-clamp-2">
              {t.deletionRejectedBadge}: {leave.delete_request_reason}
            </p>
          )}

          {/* ── Footer: requested / approved with avatar initials + timestamps ── */}
          {(leave.requested_from || leave.consider_by || leave.requested_at || leave.considered_at) && (
            <div className="flex flex-wrap items-start gap-x-4 gap-y-1.5 mt-2.5 pt-2.5 border-t border-border">
              {(leave.requested_from || leave.requested_at) && (
                <div className="flex items-start gap-1.5 min-w-0">
                  <div className="w-5 h-5 rounded-full bg-muted border border-border flex items-center justify-center text-[9px] font-bold text-muted-foreground flex-shrink-0 mt-px">{cardInitial(leave.requested_from)}</div>
                  <div className="min-w-0">
                    {leave.requested_from && (
                      <span className="text-[11px] text-muted-foreground truncate block">{t.requestedToLabel}: <span className="text-foreground font-medium">{leave.requested_from}</span></span>
                    )}
                    {leave.requested_at && (
                      <span className="text-[10px] text-muted-foreground/70 flex items-center gap-1"><Clock className="w-2.5 h-2.5 flex-shrink-0" />{formatDateTime(leave.requested_at)}</span>
                    )}
                  </div>
                </div>
              )}
              {(leave.consider_by || leave.considered_at) && (
                <div className="flex items-start gap-1.5 min-w-0">
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0 mt-px ${sv.chip} ${sv.text}`}>{cardInitial(leave.consider_by)}</div>
                  <div className="min-w-0">
                    {leave.consider_by && (
                      <span className="text-[11px] text-muted-foreground truncate block">{leave.status?.toLowerCase() === 'approved' ? t.approved : t.consideredWord} {t.byLabel}: <span className="text-foreground font-medium">{leave.consider_by}</span></span>
                    )}
                    {leave.considered_at && (
                      <span className="text-[10px] text-muted-foreground/70 flex items-center gap-1"><Clock className="w-2.5 h-2.5 flex-shrink-0" />{formatDateTime(leave.considered_at)}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Action buttons ── */}
        <div className="flex flex-col gap-1.5 flex-shrink-0">
          {loading ? (
            <Loader2 className="w-4 h-4 text-primary animate-spin" />
          ) : (
            <>
              {/* Approve / Reject — executive team view */}
              {onApprove && (
                <Button variant="success" size="icon-sm" onClick={onApprove} title={t.approveVerb}>
                  <CheckCircle className="w-4 h-4" />
                </Button>
              )}
              {onReject && (
                <Button variant="destructive" size="icon-sm" onClick={onReject} title={t.rejectVerb}>
                  <XCircle className="w-4 h-4" />
                </Button>
              )}
              {/* Edit / Delete — only for pending leaves */}
              {onEdit && (
                <Button variant="outline" size="icon-sm" onClick={onEdit} title={t.editLeaveTitle}>
                  <Edit2 className="w-3.5 h-3.5" />
                </Button>
              )}
              {onDelete && (
                <Button variant="outline" size="icon-sm" onClick={onDelete} title={t.cancelLeaveTitle}
                  className="hover:text-destructive">
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              )}
              {/* Approved leaves: request deletion (routes to the approver) */}
              {onRequestDelete && (
                <Button variant="outline" size="sm" onClick={onRequestDelete} title="Request to delete this leave"
                  className="hover:text-destructive hover:border-destructive">
                  <Trash2 className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Request delete</span>
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

// ─── Page content ─────────────────────────────────────────────────────────────
function LeavePageContent() {
  const { user }     = useAuthStore();
  const caps = useUserCapabilities();
  const t = useT();
  const searchParams = useSearchParams();
  const isExec       = caps.can_approve;
  // Only employees have personal leaves (System Admin etc. are non-employees).
  const isEmployee   = caps.is_employee;
  // Southern Lanka only: no manual "Requested By" pick on Apply for Leave — see the guard
  // around that field below. Routing is automatic instead (Head of Department + every role
  // above the applicant's — see apiCompat.ts applyLeave/getLeaveRequests).
  const isSouthernlanka = tenant.id === 'southernlanka';
  // Southern Lanka only: a Head of Department (see hod_department_ids, set on the Users
  // page) also approves pending leaves from their assigned departments' members — independent
  // of can_approve_leaves on their role (see apiCompat.ts getLeaveRequests, which scopes what
  // actually comes back). Folded into canApproveLeaves below so the Team Requests tab, its
  // pending badge and the fetch trigger all just work for a HOD too, same as any approver.
  const isDeptHOD = tenant.id === 'southernlanka' && !!user?.hod_department_ids?.length;
  // Approving team LEAVE requests is its own role setting. caps already reflect the
  // user's trainee access set, so no separate trainee check is needed.
  const canApproveLeaves = caps.can_approve_leaves || isDeptHOD;
  // Southern Lanka only — HR/Admin may assign a restricted leave type (one users can't apply
  // for themselves) directly onto an employee. System Admin always qualifies.
  const canAssignRestrictedLeave = isSouthernlanka && (caps.can_apply_restricted_leaves || caps.is_system_admin);
  const isTrainee    = user?.employee_type?.toLowerCase() === 'trainee';
  const defaultTab   = (searchParams.get('tab') === 'delete' && canApproveLeaves) ? 'delete'
    : (searchParams.get('tab') === 'team' && canApproveLeaves) ? 'team'
    : isEmployee ? 'my'
    : canApproveLeaves ? 'team' : 'my';

  const [tab,            setTab]            = useState<'my' | 'team' | 'onleave' | 'delete'>(defaultTab as 'my' | 'team' | 'onleave' | 'delete');
  // Leave-list search (applies to My & Team tabs) + team-request scope filter.
  const [search,   setSearch]   = useState('');
  const [reqScope, setReqScope] = useState<'all' | 'own' | 'others'>('all');

  // On-leave list state (exec only). Default 'week' view = next 7 working days; 'date' = one
  // specific date picked via the filter.
  const todayISO = localDateString();
  const [onLeaveMode,    setOnLeaveMode]    = useState<'week' | 'date' | 'employee'>('week');
  const [onLeaveDate,    setOnLeaveDate]    = useState(todayISO);
  const [onLeaveList,    setOnLeaveList]    = useState<OnLeaveItem[]>([]);
  const [onLeaveLoading, setOnLeaveLoading] = useState(false);
  const [weekData,       setWeekData]       = useState<{ date: string; list: OnLeaveItem[] }[]>([]);
  const [weekLoading,    setWeekLoading]    = useState(false);

  // "On Leave → Search Employee": pick any employee and see their full leave history for
  // the ~1-year window centred on today (6 months back / 6 months forward).
  const [empQuery,       setEmpQuery]       = useState('');
  const [showEmpDrop,    setShowEmpDrop]    = useState(false);
  const [empSearchPool,  setEmpSearchPool]  = useState<{ epf_number: string; name: string }[]>([]);
  const [empPoolLoaded,  setEmpPoolLoaded]  = useState(false);
  const [selectedEmp,    setSelectedEmp]    = useState<{ epf_number: string; name: string } | null>(null);
  const [empLeaves,      setEmpLeaves]      = useState<Leave[]>([]);
  const [empLeavesLoading, setEmpLeavesLoading] = useState(false);
  const empRef = useRef<HTMLDivElement>(null);
  const [myLeaves,       setMyLeaves]       = useState<Leave[]>([]);  // upcoming only (for pending badge)
  const [upcomingLeaves, setUpcomingLeaves] = useState<Leave[]>([]);  // state=Upcoming
  const [pastLeaves,     setPastLeaves]     = useState<Leave[]>([]);  // state=Past
  const [teamLeaves,     setTeamLeaves]     = useState<Leave[]>([]);
  const [leaveTypes,   setLeaveTypes]   = useState<LeaveTypeOption[]>([]); // full type objects
  // Separate "loaded" flag from emptiness: the Apply-for-Leave form must distinguish
  // "still loading" (skeleton) from "loaded but no types" (empty/retry) so it never sits
  // on the skeleton forever when types are empty or the fetch failed.
  const [leaveTypesLoaded,    setLeaveTypesLoaded]    = useState(false);
  const [leaveTypesReloading, setLeaveTypesReloading] = useState(false);
  const [supervisors,  setSupervisors]  = useState<Supervisor[]>([]); // default suggestions (supervisor + company sup + HR)
  const [allApprovers, setAllApprovers] = useState<Supervisor[]>([]); // search pool (executive + top management)
  const [leaveBalance, setLeaveBalance] = useState<LeaveBalance[]>([]);
  // Days taken on types that carry no entitlement — see readTakenOnly above. Kept apart from
  // leaveBalance so no quota arithmetic on this page can ever reach them.
  const [takenOnlyBalance, setTakenOnlyBalance] = useState<{ name: string; taken: number }[]>([]);
  // Southern Lanka only — set alongside leaveBalance from getLeaveSummary's own explicit
  // is_trainee_first_year/trainee_accrual_type fields (computed server-side, where
  // employee_type/date_of_join are actually available). Deliberately NOT inferred from
  // leaveBalance's shape (e.g. "it has exactly one entry") — that heuristic breaks the moment
  // a tenant happens to have only one active leave type configured for an unrelated reason.
  const [traineeFirstYear, setTraineeFirstYear] = useState<{ inWindow: boolean; typeName: string | null }>({ inWindow: false, typeName: null });
  // Southern Lanka only — this employee's assigned shifts, for the 12h leave-apply and
  // 3h leave-deletion shift cut-off rules (see @/lib/shiftCutoff).
  const [shiftAssignments, setShiftAssignments] = useState<ScheduleAssignment[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [showForm,     setShowForm]     = useState(false);
  const [editLeave,    setEditLeave]    = useState<Leave | null>(null);
  const [actionId,     setActionId]     = useState<string | number | null>(null);
  const [selectedTeamLeave, setSelectedTeamLeave] = useState<LeaveRequestData | null>(null);
  const [deleteLeave,  setDeleteLeave]  = useState<Leave | null>(null);
  const [form,         setForm]         = useState({ ...BLANK_FORM });
  // Approver: pending leave-deletion requests. Employee: the request-to-delete modal.
  const [deleteRequests, setDeleteRequests] = useState<any[]>([]);
  const [reqDeleteLeave,  setReqDeleteLeave]  = useState<Leave | null>(null);
  const [reqDeleteMode,   setReqDeleteMode]   = useState<'all' | 'specific'>('all');
  const [reqDeleteDates,  setReqDeleteDates]  = useState<string[]>([]);
  const [reqDeleteReason, setReqDeleteReason] = useState('');
  const [reqDeleteBusy,   setReqDeleteBusy]   = useState(false);

  // One history dialog for the whole page — every employee name on every tab points at it.
  const [historyFor, setHistoryFor] = useState<{ epf: string; name: string } | null>(null);
  // The bulk review of pending requests whose dates are already behind us.
  const [showPassed, setShowPassed] = useState(false);

  // Autocomplete state for "Requested By" field
  const [supQuery,          setSupQuery]          = useState('');
  const [showSupDrop,       setShowSupDrop]       = useState(false);
  const [showLeaveTypeDrop, setShowLeaveTypeDrop] = useState(false);
  const supRef       = useRef<HTMLDivElement>(null);
  const leaveTypeRef = useRef<HTMLDivElement>(null);

  // Southern Lanka only — exactly two states, both driven by traineeFirstYear (set from
  // getLeaveSummary's own explicit is_trainee_first_year/trainee_accrual_type — computed
  // server-side, where employee_type/date_of_join actually live):
  //   • Inside their first year on the Intern/Trainee track → ONLY the accrual type, full
  //     stop. Every other leave type is unavailable to them for that whole first year.
  //   • Anyone else (Permanent/standard, or a Trainee/Intern past their first year) → every
  //     active, directly-applicable leave type, is_trainee_accruable or not, with its normal
  //     quota — the flag only ever changes HOW a type accrues for a first-year Trainee/Intern,
  //     never who else gets to see or apply for it.
  const directApplyTypes = isSouthernlanka
    ? leaveTypes.filter(lt => lt.allow_direct_apply !== false)
    : leaveTypes;
  const applyLeaveTypes = (isSouthernlanka && traineeFirstYear.inWindow && traineeFirstYear.typeName)
    ? directApplyTypes.filter(lt => lt.name === traineeFirstYear.typeName)
    : directApplyTypes;

  // No search → the default suggestions (supervisor + company supervisor + HR). When searching →
  // the full upper-layer pool (executives + top management).
  const filteredSups = supQuery.trim().length === 0
    ? supervisors
    : allApprovers.filter(s =>
        s.name.toLowerCase().includes(supQuery.toLowerCase()) ||
        s.epf_number.includes(supQuery)
      );

  // Config of the currently selected leave type (reason/backdate/paid rules)
  const selectedType = leaveTypes.find(t => t.name === form.leave_type);
  const reasonRequired = selectedType?.requires_reason ?? false;
  const backdateDays   = selectedType?.allow_backdate_days ?? 0;
  const allowPayChoice = selectedType?.allow_unpaid_choice ?? false;
  // Minimum selectable date (today minus allowed backdate days)
  const minDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() - backdateDays);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();

  // Southern Lanka only — a directly-applicable leave type (its `allow_direct_apply` flag is
  // not `false`) must be filed at least 12h before the first shift it would cover. Restricted
  // assign-only types are exempt. Recomputed live so the inline error appears the moment the
  // picked type + dates violate it; handleSubmit re-checks and blocks. The gate is the leave
  // type's config flag — there is no leave-type-name matching.
  const typeHasShiftCutoff = leaveTypeHasApplyCutoff(selectedType);
  const applyCutoffError = (isSouthernlanka && !editLeave && !!selectedType && typeHasShiftCutoff
    && shiftCutoffViolation(
      shiftAssignments,
      form.duration === 'range' ? form.from_date : form.date,
      form.duration === 'range' ? form.to_date : form.date,
      LEAVE_APPLY_CUTOFF_HOURS,
    ))
    ? LEAVE_APPLY_SHIFT_CUTOFF_MSG
    : '';

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (supRef.current && !supRef.current.contains(e.target as Node))
        setShowSupDrop(false);
      if (leaveTypeRef.current && !leaveTypeRef.current.contains(e.target as Node))
        setShowLeaveTypeDrop(false);
      if (empRef.current && !empRef.current.contains(e.target as Node))
        setShowEmpDrop(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Search-as-you-type over the lazily-loaded employee pool (loaded on first entry into the
  // "Search Employee" on-leave view — see loadEmpSearchPool).
  const filteredEmpSearch = empQuery.trim().length === 0
    ? []
    : empSearchPool.filter(e =>
        e.name.toLowerCase().includes(empQuery.toLowerCase()) ||
        e.epf_number.includes(empQuery)
      ).slice(0, 20);

  useEffect(() => { loadData(); }, []);

  // Southern Lanka only — real-time sync for the Comprehensive Approval Engine: a newly
  // submitted request pops into the approver's Pending tab live, and an approver's decision
  // updates the applicant's own view instantly, with no manual page refresh (see
  // leaveApi.subscribeMyLeaves/subscribeLeaveRequests/subscribeLeaveDeleteRequests in
  // apiCompat.ts). Each fires once immediately with current data — a harmless redundant
  // overlap with loadData()'s own initial fetch above — then again on every relevant write.
  // Cleaned up on unmount / whenever the signed-in user or approver status changes.
  useEffect(() => {
    const epf = user?.epf_number;
    if (!isSouthernlanka || !epf) return;
    const unsubs: Array<() => void> = [];

    unsubs.push(leaveApiRT.subscribeMyLeaves(epf, ({ upcoming, past, summary }: {
      upcoming: Leave[]; past: Leave[]; summary: LeaveBalance[];
    }) => {
      setUpcomingLeaves(upcoming);
      setPastLeaves(past);
      setMyLeaves(upcoming); // combined for the pending-count badge, mirrors loadData above
      setLeaveBalance(summary);
      setTakenOnlyBalance(readTakenOnly(summary));
      const meta = summary as unknown as { is_trainee_first_year?: boolean; trainee_accrual_type?: string | null };
      setTraineeFirstYear({ inWindow: !!meta?.is_trainee_first_year, typeName: meta?.trainee_accrual_type ?? null });
    }));

    if (canApproveLeaves) {
      unsubs.push(leaveApiRT.subscribeLeaveRequests(epf, (arr: unknown[]) => {
        setTeamLeaves(mapTeamLeaveRequests(arr));
      }));
      unsubs.push(leaveApiRT.subscribeLeaveDeleteRequests(epf, (arr: unknown[]) => {
        setDeleteRequests(Array.isArray(arr) ? arr : []);
      }));
    }

    return () => unsubs.forEach((u) => u());
  }, [isSouthernlanka, user?.epf_number, canApproveLeaves]);

  // Southern Lanka only — pull this employee's assigned shifts once, for the 12h leave-apply
  // and 3h leave-deletion cut-off checks below. Cheap single-person read; the write path
  // (apiCompat applyLeave / requestLeaveDeletion) re-checks against live data so a slightly
  // stale roster here can't let a genuinely-late request through.
  useEffect(() => {
    const epf = user?.epf_number;
    if (!isSouthernlanka || !epf) { setShiftAssignments([]); return; }
    let cancelled = false;
    getScheduleAssignmentsForEmployee(String(epf))
      .then(rows => { if (!cancelled) setShiftAssignments(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setShiftAssignments([]); });
    return () => { cancelled = true; };
  }, [isSouthernlanka, user?.epf_number]);

  // `silent` skips the full-page skeleton (used after a mutation so the page updates in place
  // instead of remounting/replaying entrance animations — the "whole page resets" effect).
  const loadData = async (silent = false) => {
    if (!silent) setLoading(true);
    // Kick everything off in parallel, but reveal the page as soon as the PRIMARY data (my
    // leaves + balance + types) is in. The approver's team requests and the supervisor list for
    // the apply form fill in after and must not hold the skeleton up (was the ~10s wait).
    const trP  = canApproveLeaves ? leaveApi.getLeaveRequests(user?.epf_number ?? '') : Promise.resolve(null);
    // Southern Lanka never shows the "Requested By" picker (see isSouthernlanka above) — the
    // supervisor pool it fills is unused there, so skip the read entirely.
    const supP = isSouthernlanka ? Promise.resolve(null) : profileApi.getSupervisorsForLeave(user?.epf_number ?? '', user?.company ?? '');

    // Leave types gate the Apply-for-Leave form. They're a small, cached read, so set them
    // the MOMENT they arrive — independent of the slower my-leaves / summary reads below
    // (previously they shared one Promise.allSettled, so the form waited for the slowest of
    // four). Always flip `leaveTypesLoaded` (even on empty/failure) so the form shows an
    // empty/retry state instead of sitting on its skeleton forever.
    leaveApi.getLeaveTypes()
      .then((res: any) => {
        const d = res.data?.data ?? res.data;
        const types = d?.leave_types ?? d;
        setLeaveTypes(Array.isArray(types) ? types : []);
      })
      .catch((err) => {
        // Leave empty → form shows retry, never a stuck skeleton — but log so a real
        // Firestore/network failure isn't indistinguishable from "no active types".
        console.error('[leaves] getLeaveTypes failed', err);
      })
      .finally(() => setLeaveTypesLoaded(true));

    const [upcomingR, pastR, lbR] = await Promise.allSettled([
      // Two separate calls: state=Upcoming and state=Past (no state param)
      leaveApi.getMyLeaves(user?.epf_number ?? '', 'Upcoming'),
      leaveApi.getMyLeaves(user?.epf_number ?? ''),
      leaveApi.getLeaveSummary(user?.epf_number ?? ''),
    ]);

    // Response: { status, message, data: { leaves: [...] } }
    if (upcomingR.status === 'fulfilled') {
      const d = upcomingR.value.data?.data ?? upcomingR.value.data;
      const arr = d?.leaves ?? d ?? [];
      setUpcomingLeaves(Array.isArray(arr) ? arr : []);
    }
    if (pastR.status === 'fulfilled') {
      const d = pastR.value.data?.data ?? pastR.value.data;
      const arr = d?.leaves ?? d ?? [];
      setPastLeaves(Array.isArray(arr) ? arr : []);
    }
    // Keep myLeaves as combined for pendingCount badge
    const upArr = upcomingR.status === 'fulfilled'
      ? (upcomingR.value.data?.data?.leaves ?? upcomingR.value.data?.data ?? upcomingR.value.data?.leaves ?? [])
      : [];
    setMyLeaves(Array.isArray(upArr) ? upArr : []);
    if (lbR.status === 'fulfilled') {
      const d = lbR.value.data?.data ?? lbR.value.data;
      setLeaveBalance(Array.isArray(d) ? d : []);
      setTakenOnlyBalance(readTakenOnly(d));
      const meta = d as unknown as { is_trainee_first_year?: boolean; trainee_accrual_type?: string | null };
      setTraineeFirstYear({ inWindow: !!meta?.is_trainee_first_year, typeName: meta?.trainee_accrual_type ?? null });
    }
    if (!silent) setLoading(false);

    // Secondary — these fill their own sections in and must not gate the page reveal.
    if (canApproveLeaves) {
      trP.then(trVal => {
        if (!trVal) return;
        // Response: { data: { leave_requests: [{ leave_id, name, from_date, to_date, leave_type_name, reason }] } }
        const d    = trVal.data?.data ?? trVal.data;
        const arr  = d?.leave_requests ?? d ?? [];
        setTeamLeaves(mapTeamLeaveRequests(arr));
      }).catch(() => {});

      // Pending leave-deletion requests routed to this approver.
      leaveApi.getLeaveDeleteRequests(user?.epf_number ?? '').then((res: any) => {
        const d = res.data?.data ?? res.data;
        setDeleteRequests(Array.isArray(d?.requests) ? d.requests : []);
      }).catch(() => setDeleteRequests([]));
    }
    supP.then(supVal => {
      if (!supVal) return;
      // Response: { data: { supervisors: [...default...], all_approvers: [...upper layers...] } }
      const d = supVal.data?.data ?? supVal.data;
      const notMe = (s: Supervisor) => s.epf_number !== user?.epf_number;
      const sups = (Array.isArray(d?.supervisors) ? d.supervisors : Array.isArray(d) ? d : []).filter(notMe);
      const allApp = (Array.isArray(d?.all_approvers) ? d.all_approvers : []).filter(notMe);
      setSupervisors(sups);
      setAllApprovers(allApp.length ? allApp : sups);
    }).catch(() => {});
  };

  // Retry just the leave types (the Apply form's gate) without reloading the whole page —
  // used by the empty/error state when the first fetch returned nothing or failed. A prior
  // network failure didn't cache, so this re-hits Firestore; genuinely-empty types stay empty.
  const reloadLeaveTypes = async () => {
    setLeaveTypesReloading(true);
    try {
      const res: any = await leaveApi.getLeaveTypes();
      const d = res.data?.data ?? res.data;
      const types = d?.leave_types ?? d;
      setLeaveTypes(Array.isArray(types) ? types : []);
    } catch (err) {
      // Keep empty → the retry state stays visible — but log so a real failure is visible.
      console.error('[leaves] getLeaveTypes retry failed', err);
    }
    finally { setLeaveTypesLoaded(true); setLeaveTypesReloading(false); }
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    const isRange   = form.duration === 'range';
    const isHalf    = form.duration === 'half';
    const singleDate = form.date;
    const fromDate  = isRange ? form.from_date : singleDate;
    const toDate    = isRange ? form.to_date   : singleDate;

    // Validation — a supervisor must be picked only when upper-tier options exist
    // (top-of-tree roles have no one above them, so their leave is auto-approved). Southern
    // Lanka never shows that field at all — routing is automatic (see isSouthernlanka above).
    const hasApprovers = supervisors.length > 0 || allApprovers.length > 0;
    if (!fromDate || (isRange && !toDate) || !form.leave_type || (!isSouthernlanka && hasApprovers && !form.request_from)) {
      toast.error(t.fillRequiredFields); return;
    }
    if (isHalf && !form.half_day_period) {
      toast.error(t.selectHalfDayPeriod); return;
    }
    if (isRange && toDate < fromDate) {
      toast.error(t.toBeforeFrom); return;
    }
    // Reason mandatory for certain leave types (e.g. Medical)
    if (reasonRequired && !form.reason.trim()) {
      toast.error(t.reasonRequiredFor.replace('{type}', form.leave_type)); return;
    }
    // Enforce backdate window — dates can't be older than the type allows
    if (fromDate < minDate) {
      toast.error(backdateDays > 0
        ? t.backdateLimit.replace('{days}', String(backdateDays))
        : t.pastDatesNotAllowed);
      return;
    }
    // Southern Lanka — 12-hour shift cut-off for directly-applicable leave types (mirrors
    // applyCutoffError above and apiCompat.applyLeave's write-path re-check). Gated on the
    // selected type's `allow_direct_apply` flag, not its name.
    if (isSouthernlanka && !editLeave && !!selectedType && leaveTypeHasApplyCutoff(selectedType)
      && shiftCutoffViolation(shiftAssignments, fromDate, toDate, LEAVE_APPLY_CUTOFF_HOURS)) {
      toast.error(LEAVE_APPLY_SHIFT_CUTOFF_MSG);
      return;
    }

    const leaveDates = isRange
      ? getDatesInRange(fromDate, toDate)
      : [singleDate];

    // Southern Lanka — instant conflict + quota feedback (the backend re-checks the same on
    // the write path). Not run when editing an existing leave (its own dates would "clash"
    // with itself, and updateLeave doesn't go through this validation).
    if (isSouthernlanka && !editLeave) {
      const wantDates = new Set(leaveDates);
      const clash = [...upcomingLeaves, ...pastLeaves].find(l => {
        const st = l.status?.toLowerCase();
        if (st !== 'pending' && st !== 'approved') return false;
        return getDatesInRange(l.from_date.slice(0, 10), l.to_date.slice(0, 10)).some(d => wantDates.has(d));
      });
      if (clash) {
        const cf = clash.from_date.slice(0, 10), ct = clash.to_date.slice(0, 10);
        toast.error(t.leaveDateConflict
          .replace('{status}', clash.status?.toLowerCase() === 'approved' ? 'approved' : 'pending')
          .replace('{range}', cf === ct ? formatDate(cf) : fmtRange(cf, ct)));
        return;
      }
      // Quota — block if the chosen type is exhausted or this request exceeds what's left.
      const isPaidReq = allowPayChoice ? form.is_paid : true;
      if (isPaidReq) {
        const bal = leaveBalance.find(b => (b.leave_type ?? b.type) === form.leave_type);
        const avail = bal?.available;
        if (typeof avail === 'number') {
          const requested = isHalf
            ? 0.5
            : leaveDates.filter(d => { const wd = new Date(d + 'T00:00:00').getDay(); return wd !== 0 && wd !== 6; }).length;
          if (avail <= 0) {
            toast.error(t.leaveTypeExhausted.replace('{type}', form.leave_type));
            return;
          }
          if (requested > avail) {
            toast.error(t.leaveQuotaShort
              .replace('{n}', String(avail)).replace('{type}', form.leave_type).replace('{req}', String(requested)));
            return;
          }
        }
      }
    }

    const payload = {
      epf_number:       user?.epf_number ?? '',
      from_date:        fromDate,
      to_date:          toDate,
      leave_type:       form.leave_type,
      request_from:     form.request_from,
      reason:           form.reason || undefined,
      leave_dates:      leaveDates,
      is_half_day:      isHalf,
      ...(allowPayChoice ? { is_paid: form.is_paid } : {}),
      ...(isHalf ? { half_day_period: form.half_day_period } : {}),
    };

    setActionId(-1);
    try {
      if (editLeave) {
        await leaveApi.updateLeave({ leave_id: editLeave.leave_id, ...payload });
        toast.success(t.leaveUpdated);
      } else {
        await leaveApi.applyLeave(payload);
        toast.success(t.leaveSubmitted);
      }
      closeForm();
      loadData(true);
    } catch (err: unknown) {
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? (err as { message?: string })?.message
        ?? t.failedSubmitLeave
      );
    }
    setActionId(null);
  };

  // Allow delete if: pending (any time) OR accepted but before 10:00 AM on from_date
  const canDelete = (leave: Leave) => {
    const status = leave.status?.toLowerCase();
    const isApproved = status === 'accept' || status === 'accepted' || status === 'approved';
    const isPending  = status === 'pending';
    if (!isApproved && !isPending) return false; // rejected etc. — locked

    const fromDate = leave.from_date?.split('T')[0];
    if (!fromDate) return true;
    const now = new Date();
    const todayStr = localDateString(now);

    // Deletable any time before the leave day
    if (fromDate > todayStr) return true;
    // On the leave day — only until 10:00 AM
    if (fromDate === todayStr) return now.getHours() < 10;
    // Past leave day — locked
    return false;
  };

  const handleDelete = async (id: string | number) => {
    setActionId(id);
    try {
      await leaveApi.removeLeave(id);
      toast.success(t.leaveCancelled);
      setDeleteLeave(null);
      loadData(true);
    } catch { toast.error(t.failedCancelLeave); }
    setActionId(null);
  };

  // Employee: open the request-to-delete modal for an approved leave (reset its choices).
  const openRequestDelete = (leave: Leave) => {
    setReqDeleteLeave(leave);
    setReqDeleteMode('all');
    setReqDeleteDates([]);
    setReqDeleteReason('');
  };

  const handleSubmitDeleteRequest = async () => {
    if (!reqDeleteLeave) return;
    const from = reqDeleteLeave.from_date?.slice(0, 10) ?? '';
    const to   = reqDeleteLeave.to_date?.slice(0, 10) ?? '';
    const removeAll = from === to || reqDeleteMode === 'all';
    if (!removeAll && reqDeleteDates.length === 0) { toast.error('Select at least one date to remove'); return; }
    // Southern Lanka — a deletion request for a directly-applicable leave type must be filed at
    // least 3h before the start of the shift on the affected day(s) (mirrors
    // apiCompat.requestLeaveDeletion's write-path check). Gated on the leave type's
    // `allow_direct_apply` flag; restricted assign-only types are exempt.
    // Scope: the specific dates being removed, else the whole leave range.
    if (isSouthernlanka
      && leaveTypeHasApplyCutoff(leaveTypes.find(lt => lt.name === reqDeleteLeave.leave_type_name))) {
      const scoped = !removeAll && reqDeleteDates.length ? [...reqDeleteDates].sort() : [from, to];
      if (shiftCutoffViolation(shiftAssignments, scoped[0], scoped[scoped.length - 1], LEAVE_DELETION_CUTOFF_HOURS)) {
        toast.error(LEAVE_DELETION_SHIFT_CUTOFF_MSG);
        return;
      }
    }
    setReqDeleteBusy(true);
    try {
      await leaveApi.requestLeaveDeletion({
        leave_id:        reqDeleteLeave.leave_id,
        epf_number:      user?.epf_number ?? '',
        remove_all:      removeAll,
        requested_dates: removeAll ? [] : reqDeleteDates,
        reason:          reqDeleteReason.trim() || undefined,
      });
      toast.success('Deletion request sent to your approver');
      setReqDeleteLeave(null);
      loadData(true);
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { message?: string } }; message?: string })?.response?.data?.message
        ?? (err as { message?: string })?.message ?? 'Failed to send request');
    } finally { setReqDeleteBusy(false); }
  };

  // Switching deletion scope ("Entire leave" ⇄ "Specific dates") starts that scope with
  // clean inputs. The date selection and the Reason field are otherwise shared across both
  // scopes, so stale dates/text typed under one scope would carry over into the other.
  const changeReqDeleteMode = (val: 'all' | 'specific') => {
    if (val === reqDeleteMode) return;
    setReqDeleteMode(val);
    setReqDeleteDates([]);
    setReqDeleteReason('');
  };

  // Approver: approve (soft-delete + split) or reject a leave-deletion request.
  const handleConsiderDeletion = async (id: string, action: 'approve' | 'reject') => {
    setActionId(id);
    try {
      await leaveApi.considerLeaveDeletion({ id, action, consider_by: user?.epf_number ?? '' });
      toast.success(action === 'approve' ? 'Leave deletion approved' : 'Request rejected');
      setDeleteRequests(prev => prev.filter((r: { id: string }) => r.id !== id));
      loadData(true);
    } catch (err: unknown) {
      toast.error((err as { message?: string })?.message ?? t.actionFailed);
    } finally { setActionId(null); }
  };

  const fetchOnLeaveList = async (date: string) => {
    setOnLeaveLoading(true);
    try {
      // Scoped by the viewer's visibility inside getTodayLeaveList (admin → all companies;
      // other approvers → their own company), so pass the viewer's EPF, not a company id.
      const res = await leaveApi.getTodayLeaveList(user?.epf_number ?? '', date);
      const d = res.data?.data ?? res.data;
      setOnLeaveList(Array.isArray(d?.leave_list) ? d.leave_list : []);
    } catch { setOnLeaveList([]); }
    setOnLeaveLoading(false);
  };

  // Default On-Leave view: who's on leave across the next 7 working days (Sundays excluded).
  const fetchOnLeaveWeek = async () => {
    setWeekLoading(true);
    try {
      const dates = nextWorkingDates(7);
      const results = await Promise.all(dates.map(async (date) => {
        try {
          const res = await leaveApi.getTodayLeaveList(user?.epf_number ?? '', date);
          const d = res.data?.data ?? res.data;
          return { date, list: (Array.isArray(d?.leave_list) ? d.leave_list : []) as OnLeaveItem[] };
        } catch { return { date, list: [] as OnLeaveItem[] }; }
      }));
      setWeekData(results);
    } finally { setWeekLoading(false); }
  };

  // Lazy-load the employee search pool once, the first time "Search Employee" is opened.
  const loadEmpSearchPool = async () => {
    if (empPoolLoaded) return;
    try {
      const res = await leaveApi.getEmployeesForLeaveSearch(user?.epf_number ?? '');
      const d = res.data?.data ?? res.data;
      setEmpSearchPool(Array.isArray(d?.employees) ? d.employees : []);
    } catch { setEmpSearchPool([]); }
    setEmpPoolLoaded(true);
  };

  // Full leave history for the picked employee. The window lives in
  // fetchEmployeeLeaveHistory so this inline list and the history dialog always show the same
  // slice of the record.
  const fetchEmpLeaveHistory = async (epf: string) => {
    setEmpLeavesLoading(true);
    try { setEmpLeaves(await fetchEmployeeLeaveHistory(epf)); }
    catch { setEmpLeaves([]); }
    setEmpLeavesLoading(false);
  };

  // On-leave people as a responsive table (shared by the week view and the single-date filter).
  // Real table on md+; on mobile each row stacks into a labelled block (no horizontal scroll).
  const renderOnLeaveTable = (list: OnLeaveItem[], keyPrefix: string) => (
    <Card className="overflow-hidden p-0">
      <Table>
        <TableHeader className="hidden md:table-header-group">
          <TableRow>
            <TableHead>{t.employeeWord}</TableHead>
            <TableHead>EPF</TableHead>
            <TableHead>{t.leaveTypeLabel}</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Approved By</TableHead>
            <TableHead className="text-right">{t.statusLabel}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map(lv => {
            const approved = ['accept', 'accepted', 'approved'].includes(lv.status?.toLowerCase());
            return (
              <TableRow key={`${keyPrefix}-${lv.epf_number}`} className="flex flex-col gap-1.5 py-3 md:table-row md:gap-0 md:py-0">
                <TableCell className="md:align-middle">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-brand/10 flex items-center justify-center text-brand font-bold text-xs flex-shrink-0">
                      {lv.name?.charAt(0) ?? '?'}
                    </div>
                    <EmployeeNameButton
                      name={lv.name}
                      epf={lv.epf_number}
                      onClick={() => setHistoryFor({ epf: lv.epf_number, name: lv.name })}
                    />
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground md:align-middle">
                  <span className="md:hidden text-muted-foreground mr-1">EPF:</span>{lv.epf_number}
                </TableCell>
                <TableCell className="text-xs text-foreground md:align-middle">
                  <span className="md:hidden text-muted-foreground mr-1">{t.leaveTypeLabel}:</span>{lv.leave_type_name ?? '—'}
                </TableCell>
                <TableCell className="md:align-middle">
                  {lv.is_half_day
                    ? <Badge variant="brand" className="capitalize">{t.halfDay}{lv.half_day_period ? ` · ${lv.half_day_period}` : ''}</Badge>
                    : <span className="text-xs text-muted-foreground">Full day</span>}
                </TableCell>
                <TableCell className="text-xs text-foreground md:align-middle">
                  <span className="md:hidden text-muted-foreground mr-1">Approved By:</span>{lv.consider_by ?? '—'}
                </TableCell>
                <TableCell className="md:text-right md:align-middle">
                  <Badge variant={statusBadgeVariant(lv.status)}>{approved ? t.approved : lv.status}</Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );

  const handleConsider = async (id: string | number, action: 'accept' | 'reject', isPaid?: boolean) => {
    setActionId(id);
    try {
      // Backend fields: consider_by (exec epf), leave_id, action ('accept'|'reject'). On accept
      // the approver also decides paid vs unpaid.
      await leaveApi.considerLeave({
        consider_by: user?.epf_number ?? '', leave_id: id, action,
        ...(action === 'accept' && isPaid !== undefined ? { is_paid: isPaid } : {}),
      });
      toast.success(action === 'accept' ? t.leaveAccepted : t.leaveRejected);
      loadData(true);
    } catch (err) {
      console.error('[considerLeave] failed', err);
      toast.error((err as Error)?.message ?? t.actionFailed);
    }
    setActionId(null);
  };

  // One request, one call — the exact same considerLeave the single-row approve above makes.
  // No toast and no reload here: PassedRequestsDialog runs these strictly in sequence, reports
  // one summary at the end and reloads once, so a twelve-request batch doesn't fire twelve
  // toasts and twelve refetches.
  const approvePassedRequest = async (id: string | number, isPaid: boolean) => {
    await leaveApi.considerLeave({
      consider_by: user?.epf_number ?? '', leave_id: id, action: 'accept', is_paid: isPaid,
    });
  };

  const openEdit = (leave: Leave) => {
    setEditLeave(leave);

    // requested_from from backend is a NAME string (e.g. "Rajitha mihiranga").
    // We need the epf_number for the form's request_from field.
    // Find the matching supervisor from our loaded list by name.
    const matchedSup = supervisors.find(
      s => s.name.toLowerCase() === (leave.requested_from ?? '').toLowerCase()
    );

    // Pre-fill the search box with the supervisor name for display
    setSupQuery(leave.requested_from ?? '');

    const fromD = leave.from_date?.split('T')[0] ?? '';
    const toD   = leave.to_date?.split('T')[0]   ?? '';
    const isSameDay = fromD && toD && fromD === toD;
    const isHalf    = !!leave.is_half_day;
    const duration: LeaveDuration = isHalf ? 'half' : isSameDay ? 'one' : 'range';
    setForm({
      duration,
      date:            (isHalf || isSameDay) ? fromD : '',
      from_date:       duration === 'range' ? fromD : '',
      to_date:         duration === 'range' ? toD   : '',
      half_day_period: (leave.half_day_period ?? '') as HalfPeriod,
      leave_type:      leave.leave_type_name ?? '',
      request_from:    matchedSup?.epf_number ?? '',
      reason:          leave.reason ?? '',
      is_paid:         true,
    });
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditLeave(null);
    setForm({ ...BLANK_FORM });
    setSupQuery('');
    setShowSupDrop(false);
    setShowLeaveTypeDrop(false);
  };

  const safeMyLeaves = Array.isArray(myLeaves) ? myLeaves : [];
  const pendingCount = safeMyLeaves.filter(l => l.status?.toLowerCase() === 'pending').length;

  // ── Search + own/others scope (My & Team tabs) ──
  const meEpf    = String(user?.epf_number ?? '');
  const searchLc = search.trim().toLowerCase();
  const matchesSearch = (l: Leave) =>
    !searchLc || [l.employee_name, l.leave_type_name, l.reason, l.status, l.requested_from, l.from_date, l.to_date, l.epf_number]
      .some(v => String(v ?? '').toLowerCase().includes(searchLc));
  // "Others" requests only appear for company/management viewers (they see the whole company's
  // pending leaves); regular approvers only ever see their own, so the toggle stays hidden.
  const teamHasOthers = teamLeaves.some(l => l.supervisor_epf && String(l.supervisor_epf) !== meEpf);

  // ── Requests that have already passed ──
  // Pending requests whose LAST day is behind us: the leave has been and gone and nobody ever
  // decided it. Nothing else on the page separates them from the fresh ones, so they sink to
  // the bottom of a long list and stay there.
  const passedAll = teamLeaves.filter(l =>
    l.status?.toLowerCase() === 'pending' && String(l.to_date ?? '').slice(0, 10) < todayISO);
  // An approver may not approve their own request — considerLeave refuses it on southernlanka
  // ("You cannot approve your own request."), so batching one in would only ever produce a
  // failure the approver can do nothing about. Counted, excluded, and said out loud.
  const passedOwnCount  = passedAll.filter(l => String(l.epf_number ?? '') === meEpf).length;
  const passedRequests  = passedAll.filter(l => String(l.epf_number ?? '') !== meEpf);
  const filteredTeam = teamLeaves.filter(l => {
    if (reqScope === 'own'    && String(l.supervisor_epf ?? '') !== meEpf) return false;
    if (reqScope === 'others' && (!l.supervisor_epf || String(l.supervisor_epf) === meEpf)) return false;
    return matchesSearch(l);
  });
  const filteredUpcoming = upcomingLeaves.filter(matchesSearch);
  const filteredPast     = pastLeaves.filter(matchesSearch);

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <StatCardsSkeleton count={5} />
        <ListSkeleton rows={4} />
      </div>
    );
  }

  // Rotate decorative StatCard tones among the three major colours (no amber).
  const balanceTones = ['primary', 'brand', 'success'] as const;

  return (
    <PageTransition className="space-y-6">
      {/* Header */}
      <PageHeader
        title={t.leavesTitle}
        description={t.leavesDesc}
        icon={CalendarDays}
        actions={(isEmployee || canAssignRestrictedLeave) && (
          <div className="flex items-center gap-2">
            {canAssignRestrictedLeave && (
              <AssignRestrictedLeaveDialog onAssigned={() => loadData(true)} />
            )}
            {isEmployee && (
              <Button onClick={() => { closeForm(); setShowForm(true); }}>
                <Plus className="w-4 h-4" /> {t.applyLeave}
              </Button>
            )}
          </div>
        )}
      />

      {/* Leave balance cards */}
      {isEmployee && (leaveBalance.length > 0 || takenOnlyBalance.length > 0) && (
        <Stagger className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {leaveBalance.map((lb, i) => (
            <StaggerItem key={i}>
              <StatCard
                label={lb.leave_type ?? lb.type ?? t.typeFallback.replace('{n}', String(i + 1))}
                value={lb.available ?? 0}
                icon={CalendarDays}
                tone={balanceTones[i % balanceTones.length]}
                hint={t.ofDaysHint.replace('{n}', String(lb.total ?? 0))}
                trailing={
                  <Progress value={lb.total ? ((lb.available ?? 0) / lb.total) * 100 : 0} className="h-1" />
                }
              />
            </StaggerItem>
          ))}
          {/* Types that are tracked but carry no entitlement. The number is days TAKEN, not days
              left, and two things say so without relying on hue: the hint reads "Taken this
              year" where the cards beside it read "of N days", and there is no progress bar,
              because a count of days off is not a proportion of anything. A bar drawn to some
              invented denominator is exactly the claim this card exists to stop making. */}
          {takenOnlyBalance.map((row, i) => (
            <StaggerItem key={`taken-${row.name}-${i}`}>
              <StatCard
                label={row.name || t.typeFallback.replace('{n}', String(leaveBalance.length + i + 1))}
                value={row.taken}
                icon={CalendarDays}
                tone="muted"
                hint={t.takenThisYear}
              />
            </StaggerItem>
          ))}
        </Stagger>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 bg-muted rounded-lg w-fit">
        {isEmployee && (
          <button onClick={() => setTab('my')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${tab === 'my' ? 'bg-primary/10 text-primary border border-primary/20' : 'text-muted-foreground hover:text-foreground'}`}>
            <FileText className="w-3.5 h-3.5" /> {t.myLeaves}
            {pendingCount > 0 && (
              <span className="w-5 h-5 rounded-full bg-warning text-warning-foreground text-[10px] font-bold flex items-center justify-center">
                {pendingCount}
              </span>
            )}
          </button>
        )}
        {canApproveLeaves && (
          <button onClick={() => setTab('team')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${tab === 'team' ? 'bg-primary/10 text-primary border border-primary/20' : 'text-muted-foreground hover:text-foreground'}`}>
            <Users className="w-3.5 h-3.5" /> {t.teamRequests}
            {(Array.isArray(teamLeaves) ? teamLeaves : []).filter(l => l.status?.toLowerCase() === 'pending').length > 0 && (
              <span className="w-5 h-5 rounded-full bg-warning text-warning-foreground text-[10px] font-bold flex items-center justify-center">
                {(Array.isArray(teamLeaves) ? teamLeaves : []).filter(l => l.status?.toLowerCase() === 'pending').length}
              </span>
            )}
          </button>
        )}
        {canApproveLeaves && (
          <button onClick={() => { setTab('onleave'); setOnLeaveMode('week'); fetchOnLeaveWeek(); }}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${tab === 'onleave' ? 'bg-brand/10 text-brand border border-brand/20' : 'text-muted-foreground hover:text-foreground'}`}>
            <CalendarDays className="w-3.5 h-3.5" /> {t.onLeaveTab}
          </button>
        )}
        {canApproveLeaves && (
          <button onClick={() => setTab('delete')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${tab === 'delete' ? 'bg-primary/10 text-primary border border-primary/20' : 'text-muted-foreground hover:text-foreground'}`}>
            <Trash2 className="w-3.5 h-3.5" /> Delete Requests
            {deleteRequests.length > 0 && (
              <span className="w-5 h-5 rounded-full bg-warning text-warning-foreground text-[10px] font-bold flex items-center justify-center">
                {deleteRequests.length}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Search + own/others scope filter (My & Team tabs) */}
      {(tab === 'my' || tab === 'team') && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t.leaveSearchPlaceholder}
              className="pl-9"
            />
          </div>
          {/* Own vs others — shown only when the viewer sees other supervisors' requests too. */}
          {tab === 'team' && teamHasOthers && (
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              {([['all', t.reqScopeAll], ['own', t.reqScopeMine], ['others', t.reqScopeOthers]] as const).map(([s, label]) => (
                <button key={s} type="button" onClick={() => setReqScope(s)}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${reqScope === s ? 'border border-primary/20 bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Content */}
      {tab === 'my' ? (
        <div className="space-y-6">
          <Reveal>
            <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
              <Clock className="w-4 h-4 text-warning" /> {t.upcomingPending}
            </h2>
            {filteredUpcoming.length === 0 ? (
              <Card>
                <EmptyState icon={searchLc ? Search : Clock} title={searchLc ? t.noMatchingLeaves : t.noUpcomingLeaves} />
              </Card>
            ) : (
              <Stagger className="space-y-2">
                {filteredUpcoming.map(leave => (
                  <StaggerItem key={leave.leave_id}>
                    <MotionCard className="rounded-xl">
                      <LeaveCard leave={leave}
                        onEdit={leave.status?.toLowerCase() === 'pending' ? () => openEdit(leave) : undefined}
                        onDelete={leave.status?.toLowerCase() === 'pending' && canDelete(leave) ? () => setDeleteLeave(leave) : undefined}
                        onRequestDelete={['accept', 'accepted', 'approved'].includes(leave.status?.toLowerCase()) ? () => openRequestDelete(leave) : undefined}
                        loading={actionId === leave.leave_id} />
                    </MotionCard>
                  </StaggerItem>
                ))}
              </Stagger>
            )}
          </Reveal>
          {filteredPast.length > 0 && (
            <Reveal delay={0.05}>
              <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                <CalendarDays className="w-4 h-4 text-muted-foreground" /> {t.pastLeaves}
              </h2>
              <Stagger className="space-y-2">
                {filteredPast.map(leave => (
                  <StaggerItem key={leave.leave_id}>
                    <MotionCard className="rounded-xl">
                      <LeaveCard leave={leave}
                        onEdit={leave.status?.toLowerCase() === 'pending' ? () => openEdit(leave) : undefined}
                        onDelete={leave.status?.toLowerCase() === 'pending' && canDelete(leave) ? () => setDeleteLeave(leave) : undefined}
                        onRequestDelete={['accept', 'accepted', 'approved'].includes(leave.status?.toLowerCase()) ? () => openRequestDelete(leave) : undefined}
                        loading={actionId === leave.leave_id} />
                    </MotionCard>
                  </StaggerItem>
                ))}
              </Stagger>
            </Reveal>
          )}
        </div>
      ) : tab === 'onleave' ? (
        <div className="space-y-4">
          {/* View toggle + date filter / employee search */}
          <Card className="p-4 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <button type="button"
                onClick={() => { setOnLeaveMode('week'); fetchOnLeaveWeek(); }}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold border transition-all ${
                  onLeaveMode === 'week'
                    ? 'bg-brand/10 border-brand/30 text-brand'
                    : 'bg-card border-border text-muted-foreground hover:text-foreground hover:border-ring'
                }`}>
                Next 7 days
              </button>
              {onLeaveMode === 'date' && (
                <span className="px-3 py-1.5 rounded-md text-xs font-semibold border border-brand/30 bg-brand/10 text-brand">
                  {prettyWeekday(onLeaveDate)}
                </span>
              )}
              <button type="button"
                onClick={() => { setOnLeaveMode('employee'); loadEmpSearchPool(); }}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold border transition-all inline-flex items-center gap-1.5 ${
                  onLeaveMode === 'employee'
                    ? 'bg-brand/10 border-brand/30 text-brand'
                    : 'bg-card border-border text-muted-foreground hover:text-foreground hover:border-ring'
                }`}>
                <Search className="w-3.5 h-3.5" /> {t.searchEmployeeToggle}
              </button>
            </div>
            {onLeaveMode === 'employee' ? (
              <div ref={empRef} className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none z-10" />
                <Input
                  type="text"
                  value={empQuery}
                  onChange={e => {
                    setEmpQuery(e.target.value);
                    setShowEmpDrop(true);
                    if (!e.target.value.trim()) { setSelectedEmp(null); setEmpLeaves([]); }
                  }}
                  onFocus={() => setShowEmpDrop(true)}
                  className="pl-9"
                  placeholder={t.searchEmployeePlaceholder}
                />
                <AnimatePresence>
                  {showEmpDrop && filteredEmpSearch.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      className="absolute left-0 right-0 top-[calc(100%+6px)] rounded-md border border-border bg-popover overflow-hidden max-h-56 overflow-y-auto shadow-soft z-20"
                    >
                      {filteredEmpSearch.map(emp => (
                        <button
                          key={emp.epf_number}
                          type="button"
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => {
                            setSelectedEmp(emp);
                            setEmpQuery(emp.name);
                            setShowEmpDrop(false);
                            fetchEmpLeaveHistory(emp.epf_number);
                          }}
                          className={`w-full flex items-center justify-between px-3 py-2.5 hover:bg-accent transition-colors text-left border-b border-border last:border-0 ${
                            selectedEmp?.epf_number === emp.epf_number ? 'bg-primary/10' : ''
                          }`}
                        >
                          <div className="text-sm text-foreground font-medium">{emp.name}</div>
                        </button>
                      ))}
                    </motion.div>
                  )}
                  {showEmpDrop && empQuery.trim().length > 0 && filteredEmpSearch.length === 0 && (
                    <motion.div
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                      className="absolute left-0 right-0 top-[calc(100%+6px)] rounded-md border border-border bg-popover px-3 py-3 text-sm text-muted-foreground text-center z-20"
                    >
                      {t.noMatchingLeaves}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground font-medium whitespace-nowrap">{t.pickDate}</label>
                <Input
                  type="date"
                  value={onLeaveMode === 'date' ? onLeaveDate : ''}
                  onClick={e => { try { (e.currentTarget as HTMLInputElement).showPicker?.(); } catch { /* not supported */ } }}
                  onChange={e => {
                    if (!e.target.value) { setOnLeaveMode('week'); fetchOnLeaveWeek(); return; }
                    if (isSunday(e.target.value)) { toast.error(t.sundaysNotWorking); return; }
                    setOnLeaveMode('date');
                    setOnLeaveDate(e.target.value);
                    fetchOnLeaveList(e.target.value);
                  }}
                  className="flex-1 min-w-0"
                />
              </div>
            )}
          </Card>

          {/* Results */}
          {onLeaveMode === 'employee' ? (
            !selectedEmp ? (
              <Card>
                <EmptyState icon={Search} title={t.pickEmployeePrompt} />
              </Card>
            ) : empLeavesLoading ? (
              <ListSkeleton rows={4} />
            ) : empLeaves.length === 0 ? (
              <Card>
                <EmptyState icon={CalendarDays} title={t.noLeaveHistoryFound} />
              </Card>
            ) : (
              <div className="space-y-2">
                {/* The inline list below and the dialog read the same window through the same
                    fetch, so this is a fuller view of what's already here — never a second,
                    differently-scoped answer. */}
                <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                  <EmployeeNameButton
                    name={selectedEmp.name}
                    epf={selectedEmp.epf_number}
                    onClick={() => setHistoryFor({ epf: selectedEmp.epf_number, name: selectedEmp.name })}
                  >
                    <span className="block text-xs text-muted-foreground">
                      EPF {selectedEmp.epf_number} · {empLeaves.length} {t.leaveRecordsCount}
                    </span>
                  </EmployeeNameButton>
                  <Button variant="outline" size="sm"
                    onClick={() => setHistoryFor({ epf: selectedEmp.epf_number, name: selectedEmp.name })}>
                    <History className="h-3.5 w-3.5" /> {t.openFullHistory}
                  </Button>
                </div>
                <Stagger className="space-y-2">
                  {empLeaves.map(leave => (
                    <StaggerItem key={leave.leave_id}>
                      <MotionCard className="rounded-xl">
                        <LeaveCard leave={leave} loading={false} />
                      </MotionCard>
                    </StaggerItem>
                  ))}
                </Stagger>
              </div>
            )
          ) : onLeaveMode === 'week' ? (
            weekLoading ? (
              <ListSkeleton rows={4} />
            ) : weekData.every(d => d.list.length === 0) ? (
              <Card>
                <EmptyState icon={CalendarDays} title={t.noOneOnLeave} description="No one is on leave in the next 7 working days" />
              </Card>
            ) : (
              <div className="space-y-5">
                {weekData.map(({ date, list }) => (
                  <div key={date} className="space-y-2">
                    <div className="flex items-center justify-between px-1">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{prettyWeekday(date)}</h3>
                      {list.length > 0 && (
                        <span className="text-[11px] text-muted-foreground">{list.length} {t.employeesOnLeave}</span>
                      )}
                    </div>
                    {list.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground/60 px-1">{t.noOneOnLeave}</p>
                    ) : (
                      renderOnLeaveTable(list, date)
                    )}
                  </div>
                ))}
              </div>
            )
          ) : onLeaveLoading ? (
            <ListSkeleton rows={4} />
          ) : onLeaveList.length === 0 ? (
            <Card>
              <EmptyState icon={CalendarDays} title={t.noOneOnLeave} />
            </Card>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground px-1">{onLeaveList.length} {t.employeesOnLeave}</p>
              {renderOnLeaveTable(onLeaveList, 'single')}
            </div>
          )}
        </div>
      ) : tab === 'delete' ? (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <Trash2 className="w-4 h-4 text-destructive" /> Leave Deletion Requests
          </h2>
          {deleteRequests.length === 0 ? (
            <Card>
              <EmptyState icon={Trash2} title="No deletion requests" description="No pending leave-deletion requests" />
            </Card>
          ) : (
            <Stagger className="space-y-2">
              {deleteRequests.map((r: any) => (
                <StaggerItem key={r.id}>
                  <Card className="p-4">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-xl bg-destructive/10 flex items-center justify-center text-destructive flex-shrink-0">
                        <Trash2 className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <EmployeeNameButton
                          name={String(r.employee_name ?? '—')}
                          epf={String(r.epf_number ?? '')}
                          onClick={() => setHistoryFor({ epf: String(r.epf_number ?? ''), name: String(r.employee_name ?? '') })}
                        />
                        <div className="mt-0.5 flex items-center gap-1.5 flex-wrap text-[11px] text-muted-foreground">
                          {r.leave_type_name && <Badge variant="muted">{r.leave_type_name}</Badge>}
                          <span className="inline-flex items-center gap-1"><CalendarDays className="w-3 h-3" />{fmtRange(r.from_date, r.to_date)}</span>
                        </div>
                        <div className="mt-2">
                          {r.remove_all ? (
                            <Badge variant="destructive" className="text-[10px]">Remove entire leave</Badge>
                          ) : (
                            <div className="flex items-center gap-1 flex-wrap">
                              <span className="mr-1 text-[10px] font-semibold text-muted-foreground">Remove {r.requested_dates.length} date{r.requested_dates.length > 1 ? 's' : ''}:</span>
                              {r.requested_dates.map((d: string) => (
                                <span key={d} className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive tabular-nums">{d}</span>
                              ))}
                            </div>
                          )}
                        </div>
                        {r.reason && <p className="mt-2 text-xs italic text-muted-foreground">&quot;{r.reason}&quot;</p>}
                        <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[10px] text-muted-foreground">
                          {/* Same field, same label as the row and the history dialog — requested_from
                              is the approver this was routed to, and it was reading here as if that
                              person had asked for the leave. */}
                          {r.requested_from && <span>{t.requestedToLabel}: <span className="font-medium text-foreground">{r.requested_from}</span></span>}
                          {r.requested_at && <span className="inline-flex items-center gap-0.5"><Clock className="w-2.5 h-2.5" />{formatDateTime(r.requested_at)}</span>}
                        </div>
                      </div>
                      <div className="flex flex-shrink-0 flex-col gap-1.5">
                        {actionId === r.id ? (
                          <Loader2 className="w-4 h-4 animate-spin text-primary" />
                        ) : (
                          <>
                            <Button variant="success" size="icon-sm" title={t.approveVerb} onClick={() => handleConsiderDeletion(r.id, 'approve')}>
                              <CheckCircle className="w-4 h-4" />
                            </Button>
                            <Button variant="destructive" size="icon-sm" title={t.rejectVerb} onClick={() => handleConsiderDeletion(r.id, 'reject')}>
                              <XCircle className="w-4 h-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </Card>
                </StaggerItem>
              ))}
            </Stagger>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <Users className="w-4 h-4 text-brand" /> {t.teamLeaveRequests}
          </h2>

          {/* Backlog nudge — only when something pending has actually gone past its own dates. */}
          {canApproveLeaves && passedRequests.length > 0 && (
            <Card className="mb-3 flex flex-col gap-3 border-l-[3px] border-l-warning p-4 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-warning/10">
                  <CalendarClock className="h-5 w-5 text-warning" />
                </div>
                <div className="min-w-0">
                  {/* No translation key covers the passed-request backlog. */}
                  <p className="text-sm font-semibold text-foreground">
                    {passedRequests.length} {passedRequests.length === 1 ? 'request has' : 'requests have'} already passed
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Their dates are in the past and they are still waiting on a decision.
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" className="flex-shrink-0" onClick={() => setShowPassed(true)}>
                <CalendarClock className="h-4 w-4" /> Review passed requests
              </Button>
            </Card>
          )}

          {teamLeaves.length === 0 ? (
            <Card>
              <EmptyState icon={Users} title={t.noTeamLeaveRequests} />
            </Card>
          ) : filteredTeam.length === 0 ? (
            <Card>
              <EmptyState icon={Search} title={t.noMatchingLeaves} />
            </Card>
          ) : (
            <Stagger role="list" className="space-y-2">
              {filteredTeam.map(leave => (
                <StaggerItem role="listitem" key={leave.leave_id}>
                  <LeaveRequestRow
                    leave={leave as unknown as LeaveRequestData}
                    currentEpf={user?.epf_number}
                    onClick={() => setSelectedTeamLeave(leave as unknown as LeaveRequestData)}
                    // The name inside the card is the way into this person's record now. The dialog
                    // fetches by epf, so the epf is the only thing it cannot do without — it will
                    // title itself with whatever the row is already showing. Guarding on the name
                    // too locked the supervisor out of exactly the record they most need when the
                    // backend omits it. The `!` is here because LeaveRequestData types epf_number
                    // as required and the page's mapper does not.
                    onOpenHistory={leave.epf_number
                      ? () => setHistoryFor({ epf: leave.epf_number!, name: leave.employee_name ?? leave.epf_number! })
                      : undefined}
                  />
                </StaggerItem>
              ))}
            </Stagger>
          )}
        </div>
      )}

      {/* Team leave detail modal */}
      <LeaveRequestModal
        leave={selectedTeamLeave}
        busy={selectedTeamLeave ? actionId === selectedTeamLeave.leave_id : false}
        allowPaymentChoice={leaveTypes.find(lt => lt.name === selectedTeamLeave?.leave_type_name)?.allow_unpaid_choice ?? false}
        onClose={() => setSelectedTeamLeave(null)}
        onApprove={(isPaid) => { if (selectedTeamLeave) { handleConsider(selectedTeamLeave.leave_id, 'accept', isPaid); setSelectedTeamLeave(null); } }}
        onReject={() => { if (selectedTeamLeave) { handleConsider(selectedTeamLeave.leave_id, 'reject'); setSelectedTeamLeave(null); } }}
      />

      {/* One employee-history dialog for the whole page — every name on every tab opens this
          one, so there is a single place that decides what "their leave history" shows. */}
      <EmployeeLeaveHistoryDialog
        open={!!historyFor}
        onOpenChange={o => { if (!o) setHistoryFor(null); }}
        epf={historyFor?.epf ?? ''}
        name={historyFor?.name ?? ''}
        canApprove={canApproveLeaves}
      />

      {/* Bulk review of pending requests whose dates have already passed */}
      {canApproveLeaves && (
        <PassedRequestsDialog
          open={showPassed}
          onOpenChange={setShowPassed}
          requests={passedRequests}
          excludedOwn={passedOwnCount}
          onApprove={approvePassedRequest}
          onFinished={() => loadData(true)}
        />
      )}

      {/* Request-to-delete (approved leave) modal — employee picks all vs specific dates.
          Portalled to <body>: a `fixed inset-0` overlay nested inside PageTransition (which
          carries an active transform from its own enter animation) gets its containing block
          hijacked to PageTransition's own box instead of the viewport, so the dimmed backdrop
          only covers a band in the middle of the screen instead of the whole page. */}
      <Portal>
      <AnimatePresence>
        {reqDeleteLeave && (() => {
          const from = reqDeleteLeave.from_date?.slice(0, 10) ?? '';
          const to   = reqDeleteLeave.to_date?.slice(0, 10) ?? '';
          const single = from === to;
          const rangeDates = single ? [from] : getDatesInRange(from, to);
          const toggleDate = (d: string) => setReqDeleteDates(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);
          const canSend = single || reqDeleteMode === 'all' || reqDeleteDates.length > 0;
          // Southern Lanka — 3h shift cut-off on the affected day(s) (specific dates being
          // removed, else the whole leave range), for directly-applicable leave types only
          // (gated on `allow_direct_apply`). handleSubmitDeleteRequest re-checks and blocks.
          const cutoffScope = (!single && reqDeleteMode === 'specific' && reqDeleteDates.length)
            ? [...reqDeleteDates].sort() : [from, to];
          const deletionCutoffError = isSouthernlanka
            && leaveTypeHasApplyCutoff(leaveTypes.find(lt => lt.name === reqDeleteLeave.leave_type_name))
            && shiftCutoffViolation(shiftAssignments, cutoffScope[0], cutoffScope[cutoffScope.length - 1], LEAVE_DELETION_CUTOFF_HOURS)
            ? LEAVE_DELETION_SHIFT_CUTOFF_MSG : '';
          return (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => !reqDeleteBusy && setReqDeleteLeave(null)}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
              <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 10 }}
                onClick={e => e.stopPropagation()}
                className="w-full max-w-md max-h-[92dvh] overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-soft">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-base font-bold text-foreground">Request leave deletion</h3>
                  <Button variant="ghost" size="icon-sm" onClick={() => setReqDeleteLeave(null)}><X className="w-4 h-4" /></Button>
                </div>
                <p className="mb-3 text-xs text-muted-foreground">This goes to your leave approver for approval.</p>

                <div className="rounded-lg border border-border bg-muted px-3 py-2 text-xs">
                  <div className="font-semibold text-foreground">{reqDeleteLeave.leave_type_name ?? '—'}</div>
                  <div className="tabular-nums text-muted-foreground">{fmtRange(from, to)}</div>
                </div>

                {!single && (
                  <div className="mt-4">
                    <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">What to remove?</label>
                    <div className="grid grid-cols-2 gap-2">
                      {([['all', 'Entire leave'], ['specific', 'Specific dates']] as const).map(([val, label]) => (
                        <button key={val} type="button" onClick={() => changeReqDeleteMode(val)}
                          className={`rounded-md border py-2 text-sm font-semibold transition-all ${reqDeleteMode === val ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground hover:text-foreground'}`}>
                          {label}
                        </button>
                      ))}
                    </div>
                    {reqDeleteMode === 'specific' && (
                      <div className="mt-3">
                        <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">Select dates to remove</label>
                        <div className="flex flex-wrap gap-1.5">
                          {rangeDates.map(d => {
                            const on = reqDeleteDates.includes(d);
                            return (
                              <button key={d} type="button" onClick={() => toggleDate(d)}
                                className={`rounded-md border px-2 py-1 text-[11px] font-medium tabular-nums transition-all ${on ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-card text-muted-foreground hover:text-foreground'}`}>
                                {d.slice(5)}
                              </button>
                            );
                          })}
                        </div>
                        <p className="mt-1 text-[10px] text-muted-foreground">{reqDeleteDates.length} of {rangeDates.length} selected</p>
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-4">
                  <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">Reason <span className="font-normal text-muted-foreground">{t.optionalWord}</span></label>
                  <Textarea rows={3} value={reqDeleteReason} onChange={e => setReqDeleteReason(e.target.value)} className="resize-none" placeholder="Why should this leave be deleted?" />
                </div>

                {deletionCutoffError && (
                  <p className="mt-3 text-xs text-destructive flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {deletionCutoffError}
                  </p>
                )}

                <div className="mt-4 flex gap-3">
                  <Button variant="outline" className="flex-1" onClick={() => setReqDeleteLeave(null)} disabled={reqDeleteBusy}>{t.cancel}</Button>
                  <Button variant="destructive" className="flex-1" onClick={handleSubmitDeleteRequest} disabled={reqDeleteBusy || !canSend || !!deletionCutoffError}>
                    {reqDeleteBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    Send request
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
      </Portal>

      {/* Delete confirmation modal — see the Portal note above. */}
      <Portal>
      <AnimatePresence>
        {deleteLeave && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setDeleteLeave(null)}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 10 }}
              onClick={e => e.stopPropagation()}
              className="w-full max-w-sm bg-card border border-border rounded-xl shadow-soft p-6">
              <div className="w-12 h-12 rounded-xl bg-destructive/10 flex items-center justify-center mx-auto mb-4">
                <Trash2 className="w-6 h-6 text-destructive" />
              </div>
              <h3 className="text-base font-bold text-foreground text-center mb-1">{t.cancelLeaveConfirm}</h3>
              <p className="text-xs text-muted-foreground text-center mb-1">
                {formatDate(deleteLeave.from_date)}
                {deleteLeave.from_date !== deleteLeave.to_date ? ` → ${formatDate(deleteLeave.to_date)}` : ''}
                {deleteLeave.leave_type_name ? ` · ${deleteLeave.leave_type_name}` : ''}
              </p>
              <p className="text-xs text-muted-foreground text-center mb-5">{t.actionCannotUndo}</p>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1" onClick={() => setDeleteLeave(null)} disabled={actionId === deleteLeave.leave_id}>
                  {t.keepWord}
                </Button>
                <Button variant="destructive" className="flex-1" onClick={() => handleDelete(deleteLeave.leave_id)} disabled={actionId === deleteLeave.leave_id}>
                  {actionId === deleteLeave.leave_id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  {t.deleteWord}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </Portal>

      {/* ── Apply / Edit modal — see the Portal note above. ── */}
      <Portal>
      <AnimatePresence>
        {showForm && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4"
            onClick={e => e.target === e.currentTarget && closeForm()}
          >
            {/* Bottom-sheet on mobile, centered card on sm+ */}
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 320 }}
              className="bg-card border border-border shadow-soft w-full sm:max-w-md rounded-t-2xl sm:rounded-xl max-h-[92dvh] flex flex-col"
            >
              {/* Drag handle (mobile only) */}
              <div className="flex justify-center pt-3 sm:hidden flex-shrink-0">
                <div className="w-10 h-1 rounded-full bg-muted" />
              </div>

              {/* Scrollable body */}
              <div className="overflow-y-auto flex-1 px-5 pb-6 pt-4 sm:p-6 space-y-4">

                {/* Header */}
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-bold text-foreground">
                    {editLeave ? t.editLeaveRequest : t.applyForLeave}
                  </h2>
                  <Button variant="ghost" size="icon-sm" onClick={closeForm}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>

                {/* Form gate: skeleton WHILE types load, a clear empty/retry state if they
                    loaded but none are available (or the fetch failed) — so the form never
                    sits on its skeleton forever — otherwise the form itself. */}
                {!leaveTypesLoaded ? (
                  <FormSkeleton fields={5} className="!bg-transparent !shadow-none !p-0" />
                ) : leaveTypes.length === 0 ? (
                  <div className="py-10 flex flex-col items-center text-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-muted border border-border flex items-center justify-center">
                      <CalendarOff className="w-6 h-6 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-semibold text-foreground">{t.noLeaveTypesYet}</p>
                    <Button variant="outline" size="sm" onClick={reloadLeaveTypes} disabled={leaveTypesReloading}>
                      <RefreshCw className={`w-3.5 h-3.5 ${leaveTypesReloading ? 'animate-spin' : ''}`} />
                      {t.tryAgain}
                    </Button>
                  </div>
                ) : (
                <>

                {/* Duration tabs + date fields */}
                {(() => {
                  const today        = localDateString();
                  const toDateError  = form.duration === 'range' && form.from_date && form.to_date && form.to_date < form.from_date;
                  const TABS: { key: LeaveDuration; label: string }[] = [
                    { key: 'half',  label: t.halfDay },
                    { key: 'one',   label: t.oneDayLabel  },
                    { key: 'range', label: t.dateRangeLabel },
                  ];
                  return (
                    <div className="space-y-3">
                      {/* Tab switcher */}
                      <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-muted border border-border">
                        {TABS.map(tab => (
                          <button
                            key={tab.key}
                            type="button"
                            onClick={() => setForm(p => p.duration === tab.key ? p : ({
                              ...p,
                              duration: tab.key,
                              // Every duration-specific input starts clean on a tab switch —
                              // the date fields already reset here; Reason must too, or text
                              // typed under one tab (e.g. "personal matter" on One Day) leaks
                              // into the next.
                              date: '', from_date: '', to_date: '',
                              half_day_period: '' as HalfPeriod,
                              reason: '',
                              leave_type: tab.key === 'half' ? 'Casual Leaves' : (p.leave_type === 'Casual Leaves' && p.duration === 'half' ? '' : p.leave_type),
                            }))}
                            className={`py-1.5 rounded-md text-xs font-semibold transition-all ${
                              form.duration === tab.key
                                ? 'bg-primary/10 border border-primary/30 text-primary'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>

                      {/* Single date (half-day / one-day) */}
                      {(form.duration === 'half' || form.duration === 'one') && (
                        <div className="min-w-0">
                          <label className="text-xs text-muted-foreground mb-1.5 block font-medium">
                            {t.dateLabel} <span className="text-destructive">*</span>
                          </label>
                          <Input
                            type="date"
                            value={form.date}
                            min={minDate}
                            onClick={e => { try { (e.currentTarget as HTMLInputElement).showPicker?.(); } catch { /* not supported */ } }}
                            onChange={e => {
                              if (isSunday(e.target.value)) { toast.error(t.sundaysNotWorking); return; }
                              setForm(p => ({ ...p, date: e.target.value }));
                            }}
                            className="min-w-0"
                          />
                        </div>
                      )}

                      {/* Half-day period selector */}
                      {form.duration === 'half' && (
                        <div>
                          <label className="text-xs text-muted-foreground mb-1.5 block font-medium">
                            {t.periodLabel} <span className="text-destructive">*</span>
                          </label>
                          <div className="grid grid-cols-2 gap-2">
                            {([
                              { value: 'morning',   label: t.morningLabel   },
                              { value: 'afternoon', label: t.afternoonLabel },
                            ] as { value: HalfPeriod; label: string }[]).map(({ value, label }) => (
                              <button
                                key={value}
                                type="button"
                                onClick={() => setForm(prev => ({ ...prev, half_day_period: value }))}
                                className={`py-2.5 rounded-md text-sm font-semibold border transition-all ${
                                  form.half_day_period === value
                                    ? 'bg-primary/10 border-primary/30 text-primary'
                                    : 'bg-card border-border text-muted-foreground hover:border-ring hover:text-foreground'
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Date range (from + to) */}
                      {form.duration === 'range' && (
                        <div className="space-y-2">
                          <div className="flex flex-col gap-2 min-w-0">
                            <div className="min-w-0">
                              <label className="text-xs text-muted-foreground mb-1.5 block font-medium">
                                {t.fromDateLabel} <span className="text-destructive">*</span>
                              </label>
                              <Input
                                type="date"
                                value={form.from_date}
                                min={minDate}
                                onClick={e => { try { (e.currentTarget as HTMLInputElement).showPicker?.(); } catch { /* not supported */ } }}
                                onChange={e => {
                                  const val = e.target.value;
                                  if (isSunday(val)) { toast.error(t.sundaysNotWorking); return; }
                                  setForm(p => ({
                                    ...p,
                                    from_date: val,
                                    to_date: p.to_date && p.to_date < val ? '' : p.to_date,
                                  }));
                                }}
                                className="min-w-0"
                              />
                            </div>
                            <div className="min-w-0">
                              <label className="text-xs text-muted-foreground mb-1.5 block font-medium">
                                {t.toDateLabel} <span className="text-destructive">*</span>
                              </label>
                              <Input
                                type="date"
                                value={form.to_date}
                                min={form.from_date || minDate}
                                onClick={e => { try { (e.currentTarget as HTMLInputElement).showPicker?.(); } catch { /* not supported */ } }}
                                onChange={e => {
                                  if (isSunday(e.target.value)) { toast.error(t.sundaysNotWorking); return; }
                                  setForm(p => ({ ...p, to_date: e.target.value }));
                                }}
                                className={`min-w-0 ${
                                  toDateError ? 'border-destructive focus-visible:ring-destructive' : ''
                                }`}
                              />
                            </div>
                          </div>
                          {toDateError && (
                            <p className="text-xs text-destructive flex items-center gap-1.5">
                              <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              {t.toBeforeFrom}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Leave type — custom styled dropdown */}
                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block font-medium">
                    {t.leaveTypeLabel} <span className="text-destructive">*</span>
                  </label>
                  {applyLeaveTypes.length === 0 ? (
                    // Not actually "still loading" — this whole form only renders once
                    // leaveTypesLoaded is true (see the gate above), so an empty
                    // applyLeaveTypes here means every type got filtered out (Southern
                    // Lanka's allow_direct_apply / trainee-accrual narrowing above), not
                    // that the fetch hasn't finished. A perpetual spinner would hide that.
                    <div className="px-3 py-2.5 rounded-md bg-muted border border-border">
                      <span className="text-sm text-muted-foreground">{t.noLeaveTypesYet}</span>
                    </div>
                  ) : (
                    <div ref={leaveTypeRef} className="relative">
                      {/* Trigger button */}
                      <button
                        type="button"
                        disabled={form.duration === 'half'}
                        onClick={() => setShowLeaveTypeDrop(o => !o)}
                        className={`w-full flex items-center justify-between px-3 py-2.5 rounded-md border text-sm font-medium transition-all ${
                          form.duration === 'half'
                            ? 'bg-muted border-border text-muted-foreground cursor-not-allowed'
                            : showLeaveTypeDrop
                              ? 'bg-primary/10 border-primary/40 text-foreground'
                              : form.leave_type
                                ? 'bg-card border-border text-foreground hover:border-ring'
                                : 'bg-card border-border text-muted-foreground hover:border-ring hover:text-foreground'
                        }`}
                      >
                        <span>{form.leave_type || t.selectLeaveType}</span>
                        {form.duration === 'half' ? (
                          <svg className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                          </svg>
                        ) : (
                          <svg
                            className={`w-4 h-4 flex-shrink-0 text-muted-foreground transition-transform duration-200 ${showLeaveTypeDrop ? 'rotate-180' : ''}`}
                            fill="none" viewBox="0 0 24 24" stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        )}
                      </button>

                      {/* Options panel */}
                      <AnimatePresence>
                        {showLeaveTypeDrop && (
                          <motion.div
                            initial={{ opacity: 0, y: -6, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0,  scale: 1    }}
                            exit={{   opacity: 0, y: -6, scale: 0.98 }}
                            transition={{ duration: 0.15 }}
                            className="absolute left-0 right-0 top-[calc(100%+6px)] rounded-md border border-border bg-popover shadow-soft overflow-hidden z-20"
                          >
                            {applyLeaveTypes.map((type, idx) => {
                              const bal = leaveBalance.find(b => (b.leave_type ?? b.type) === type.name);
                              const avail = bal?.available;
                              // Southern Lanka — an exhausted type can't be picked (the submit
                              // guard + backend also block it, this just makes it obvious).
                              const exhausted = isSouthernlanka && typeof avail === 'number' && avail <= 0;
                              return (
                              <button
                                key={type.id}
                                type="button"
                                disabled={exhausted}
                                onMouseDown={e => e.preventDefault()}
                                onClick={() => {
                                  if (exhausted) return;
                                  setForm(p => ({ ...p, leave_type: type.name, is_paid: type.is_paid }));
                                  setShowLeaveTypeDrop(false);
                                }}
                                className={`w-full flex items-center justify-between px-3 py-2.5 text-sm transition-colors text-left
                                  ${idx !== applyLeaveTypes.length - 1 ? 'border-b border-border' : ''}
                                  ${exhausted
                                    ? 'text-muted-foreground opacity-60 cursor-not-allowed'
                                    : form.leave_type === type.name
                                      ? 'bg-primary/10 text-primary'
                                      : 'text-foreground hover:bg-accent'
                                  }`}
                              >
                                <span>
                                  {type.name}
                                  {typeof avail === 'number' && (
                                    <span className={`ml-1.5 text-[11px] ${exhausted ? 'text-destructive' : 'text-muted-foreground'}`}>
                                      ({t.leaveAvailShort.replace('{n}', String(avail))})
                                    </span>
                                  )}
                                </span>
                                {form.leave_type === type.name && !exhausted && (
                                  <svg className="w-3.5 h-3.5 text-primary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                                  </svg>
                                )}
                              </button>
                              );
                            })}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                  {applyCutoffError && (
                    <p className="mt-1.5 text-xs text-destructive flex items-center gap-1.5">
                      <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {applyCutoffError}
                    </p>
                  )}
                </div>

                {/* Requested By — supervisor autocomplete. Hidden for Southern Lanka: leave
                    requests there route automatically to the applicant's Head of Department
                    and every role above theirs (see isSouthernlanka above and
                    apiCompat.ts applyLeave/getLeaveRequests) instead of a manual pick. */}
                {!isSouthernlanka && (
                <div ref={supRef}>
                  <label className="text-xs text-muted-foreground mb-1.5 block font-medium">
                    {t.requestedBySupervisor} <span className="text-destructive">*</span>
                  </label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none z-10" />
                    <Input
                      type="text"
                      value={supQuery}
                      onChange={e => {
                        setSupQuery(e.target.value);
                        setForm(p => ({ ...p, request_from: '' }));
                        setShowSupDrop(true);
                      }}
                      onFocus={() => setShowSupDrop(true)}
                      className={`pl-9 pr-9 ${
                        form.request_from ? 'border-success/40 bg-success/5' : ''
                      }`}
                      placeholder={t.searchSupervisor}
                    />
                    {form.request_from && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-success" />
                    )}
                  </div>
                  <AnimatePresence>
                    {showSupDrop && filteredSups.length > 0 && (
                      <motion.div
                        initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="mt-1.5 rounded-md border border-border bg-popover overflow-hidden max-h-44 overflow-y-auto shadow-soft"
                      >
                        {filteredSups.map(sup => (
                          <button
                            key={sup.epf_number}
                            type="button"
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => {
                              setForm(p => ({ ...p, request_from: sup.epf_number }));
                              setSupQuery(sup.name);
                              setShowSupDrop(false);
                            }}
                            className={`w-full flex items-center justify-between px-3 py-2.5 hover:bg-accent transition-colors text-left border-b border-border last:border-0 ${
                              form.request_from === sup.epf_number ? 'bg-primary/10' : ''
                            }`}
                          >
                            <div>
                              <div className="text-sm text-foreground font-medium">{sup.name}</div>
                              {/* <div className="text-[11px] text-muted-foreground">EPF: {sup.epf_number}</div> */}
                            </div>
                            {form.request_from === sup.epf_number && (
                              <svg className="w-3.5 h-3.5 text-primary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </button>
                        ))}
                      </motion.div>
                    )}
                    {showSupDrop && supQuery.trim().length > 0 && filteredSups.length === 0 && (
                      <motion.div
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="mt-1.5 rounded-md border border-border bg-popover px-3 py-3 text-sm text-muted-foreground text-center"
                      >
                        {t.noSupervisorsMatch} &quot;{supQuery}&quot;
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                )}
                {isSouthernlanka && (
                  <p className="text-[11px] text-muted-foreground -mt-1">
                    Routes automatically to your Head of Department and the role(s) above you.
                  </p>
                )}

                {/* Backdate hint */}
                {backdateDays > 0 && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-brand/10 border border-brand/20">
                    <CalendarDays className="w-3.5 h-3.5 text-brand flex-shrink-0 mt-0.5" />
                    <span className="text-[11px] text-brand">
                      {t.backdateInfo.replace('{days}', String(backdateDays))}
                    </span>
                  </div>
                )}

                {/* Payment (Paid / Unpaid) is decided by the approver — not chosen by the employee. */}

                {/* Reason — required for some types (e.g. Medical) */}
                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block font-medium">
                    {t.reasonLabel} {reasonRequired
                      ? <span className="text-destructive">*</span>
                      : <span className="text-muted-foreground">{t.optionalWord}</span>}
                  </label>
                  <Textarea value={form.reason}
                    onChange={e => setForm(p => ({ ...p, reason: e.target.value }))}
                    rows={3}
                    className={`resize-none ${
                      reasonRequired && !form.reason.trim() ? 'border-destructive/40 focus-visible:ring-destructive' : ''
                    }`}
                    placeholder={reasonRequired ? t.reasonRequiredPlaceholder : t.reasonOptionalPlaceholder} />
                </div>

                {/* Action buttons */}
                <div className="flex gap-3 pt-1">
                  <Button variant="outline" className="flex-1" onClick={closeForm}>
                    {t.cancel}
                  </Button>
                  <Button className="flex-1" onClick={handleSubmit} disabled={actionId === -1 || !!applyCutoffError}>
                    {actionId === -1
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : editLeave ? t.updateWord : t.submit}
                  </Button>
                </div>

                </>
                )}

              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </Portal>
    </PageTransition>
  );
}

export default function LeavesPage() {
  return (
    <Suspense fallback={
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <StatCardsSkeleton count={5} />
        <ListSkeleton rows={4} />
      </div>
    }>
      <LeavePageContent />
    </Suspense>
  );
}
