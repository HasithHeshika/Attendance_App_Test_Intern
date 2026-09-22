import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, Timestamp, limit,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { LeaveRecord, LeaveType, LeaveBalance, LeaveStatus } from '@/lib/types';
import { format, parseISO, eachDayOfInterval, isWeekend } from 'date-fns';

const LEAVE_COL   = 'leaves';
const LTYPE_COL   = 'leave_types';
const BALANCE_COL = 'leave_balances';

// ─── Leave Types ──────────────────────────────────────────────────────────────
// By default only active types are returned (leave-request forms, reports, apiCompat).
// The Leave Types admin screen passes { includeInactive: true } so a deactivated type
// stays visible there — it's toggled off, not deleted — and can be switched back on.
export async function getLeaveTypes(opts?: { includeInactive?: boolean }): Promise<LeaveType[]> {
  const col  = collection(db, LTYPE_COL);
  const snap = await getDocs(opts?.includeInactive ? query(col) : query(col, where('is_active', '==', true)));
  return snap.docs
    .map(d => {
      const data = d.data() as LeaveType;
      // Legacy types predate allow_direct_apply — treat a missing flag as "allowed".
      return {
        ...data,
        id: d.id,
        allow_direct_apply: data.allow_direct_apply ?? true,
        // Opt-in flag — a missing value is "not the trainee accrual type".
        is_trainee_accruable: data.is_trainee_accruable === true,
      } as LeaveType;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Southern Lanka — the single leave type configured as the target of the Intern/Trainee
// first-year 0.5-day/month accrual (its `is_trainee_accruable` flag is set). Config-driven so
// no leave-type NAME is hardcoded anywhere in the accrual engine. Returns null when no active
// type carries the flag (the accrual then simply does not apply). If more than one is flagged,
// the first by name wins — the admin screen should keep it to one.
export async function getTraineeAccruableLeaveType(): Promise<LeaveType | null> {
  const types = await getLeaveTypes();
  return types.find(t => t.is_trainee_accruable === true) ?? null;
}

// Drop the apiCompat leave-types cache after an admin edits leave types.
// Dynamic import keeps this module free of an apiCompat dependency cycle.
function invalidateLeaveTypesCache(): void {
  import('@/services/apiCompat').then(m => m.invalidateLeaveTypesCache?.()).catch(() => {});
}

export async function createLeaveType(data: Omit<LeaveType, 'id'>): Promise<string> {
  const ref = await addDoc(collection(db, LTYPE_COL), data);
  invalidateLeaveTypesCache();
  return ref.id;
}

export async function updateLeaveType(id: string, data: Partial<LeaveType>): Promise<void> {
  await updateDoc(doc(db, LTYPE_COL, id), data as Record<string, unknown>);
  invalidateLeaveTypesCache();
}

// ─── Leave Balance ────────────────────────────────────────────────────────────
export async function getLeaveBalance(epf: string, year?: number): Promise<LeaveBalance | null> {
  const y   = year ?? new Date().getFullYear();
  const id  = `${epf}_${y}`;
  const ref = doc(db, BALANCE_COL, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return snap.data() as LeaveBalance;
}

export async function deductLeaveBalance(
  epf: string, leaveTypeId: string, days: number, year?: number
): Promise<void> {
  const y   = year ?? new Date().getFullYear();
  const id  = `${epf}_${y}`;
  const ref = doc(db, BALANCE_COL, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const bal = snap.data() as LeaveBalance;
  const current = bal.balances[leaveTypeId] ?? 0;
  await updateDoc(ref, {
    [`balances.${leaveTypeId}`]: Math.max(0, current - days),
    updated_at: Timestamp.now(),
  });
}

export async function restoreLeaveBalance(
  epf: string, leaveTypeId: string, days: number, year?: number
): Promise<void> {
  const y   = year ?? new Date().getFullYear();
  const id  = `${epf}_${y}`;
  const ref = doc(db, BALANCE_COL, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const bal = snap.data() as LeaveBalance;
  const current = bal.balances[leaveTypeId] ?? 0;
  await updateDoc(ref, {
    [`balances.${leaveTypeId}`]: current + days,
    updated_at: Timestamp.now(),
  });
}

// ─── Business Days Count ──────────────────────────────────────────────────────
function countBusinessDays(from: string, to: string): number {
  const days = eachDayOfInterval({ start: parseISO(from), end: parseISO(to) });
  return days.filter(d => !isWeekend(d)).length;
}

// ─── Leave Records ────────────────────────────────────────────────────────────
export async function applyLeave(data: {
  epf_number:     string;
  employee_name:  string;
  company_id:     string;
  from_date:      string;
  to_date:        string;
  leave_type_id:  string;
  leave_type_name: string;
  is_half_day:    boolean;
  half_day_period?: 'morning' | 'afternoon';
  reason:         string;
  supervisor_epf: string;
  is_paid:        boolean;
}): Promise<string> {
  const now = Timestamp.now();
  const ref = await addDoc(collection(db, LEAVE_COL), {
    ...data,
    half_day_period: data.is_half_day ? (data.half_day_period ?? 'morning') : null,
    status:          'pending',
    considered_by:   null,
    considered_at:   null,
    reject_reason:   null,
    created_at:      now,
    updated_at:      now,
  });
  return ref.id;
}

export async function removeLeave(leaveId: string): Promise<void> {
  await deleteDoc(doc(db, LEAVE_COL, leaveId));
}

// Soft-delete a leave — keeps the document (for audit) but flags it deleted so reads skip it.
// System-admin action; a reason is recorded.
export async function softDeleteLeave(
  leaveId: string, deletedBy: string, reason: string
): Promise<void> {
  await updateDoc(doc(db, LEAVE_COL, leaveId), {
    is_deleted:    true,
    deleted_by:    deletedBy,
    deleted_at:    Timestamp.now(),
    delete_reason: reason,
    updated_at:    Timestamp.now(),
  });
}

export async function updateLeave(leaveId: string, data: {
  from_date?:       string;
  to_date?:         string;
  leave_type_id?:   string;
  leave_type_name?: string;
  is_half_day?:     boolean;
  half_day_period?: 'morning' | 'afternoon' | null;
  reason?:          string;
  supervisor_epf?:  string;
}): Promise<void> {
  await updateDoc(doc(db, LEAVE_COL, leaveId), {
    ...data,
    status:     'pending',
    updated_at: Timestamp.now(),
  });
}

export async function getMyLeaves(epf: string, state?: 'Upcoming' | 'Past'): Promise<LeaveRecord[]> {
  const today = format(new Date(), 'yyyy-MM-dd');
  // Single-field equality query on epf_number — covered by the automatic single-field index.
  // Filter and sort client-side to avoid requiring composite indexes (epf_number, from_date).
  const snap = await getDocs(query(collection(db, LEAVE_COL), where('epf_number', '==', epf)));
  const list = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as LeaveRecord))
    .filter(l => !l.is_deleted);

  if (state === 'Upcoming') {
    return list
      .filter(l => l.from_date >= today)
      .sort((a, b) => a.from_date.localeCompare(b.from_date));
  }
  if (state === 'Past') {
    return list
      .filter(l => l.from_date < today)
      .sort((a, b) => b.from_date.localeCompare(a.from_date))
      .slice(0, 30);
  }
  return list
    .sort((a, b) => b.from_date.localeCompare(a.from_date))
    .slice(0, 50);
}

export async function getThisMonthLeaves(epf: string, year?: number, month?: number): Promise<LeaveRecord[]> {
  const now   = new Date();
  const y     = year  ?? now.getFullYear();
  const m     = month ?? now.getMonth() + 1;
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end   = `${y}-${String(m).padStart(2, '0')}-31`;
  // Single-field equality query — covered by the automatic index, so it works WITHOUT the
  // (epf_number, from_date) composite index being deployed (that missing index made the old
  // range query throw, which the caller's Promise.allSettled swallowed → "no leaves"). Clamp to
  // the month client-side; leaves that OVERLAP the month are included (not just those starting
  // in it), so a leave spanning a month edge still shows.
  const snap = await getDocs(query(collection(db, LEAVE_COL), where('epf_number', '==', epf)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as LeaveRecord))
    .filter(l => !l.is_deleted && l.from_date <= end && l.to_date >= start)
    .sort((a, b) => a.from_date.localeCompare(b.from_date));
}

// getLeaveRequests / getAllLeaveRequests used to live here. Both queried
// `status == 'pending'` with `orderBy('created_at','desc')`, which needs a composite index that
// was never deployed — so both threw FAILED_PRECONDITION on every tenant, and their only caller
// (the sidebar badge) swallowed it into a 0. Neither could see a Southern Lanka leave either,
// which is stored with no supervisor_epf. Who may see a pending leave is decided in ONE place —
// leaveApi.getLeaveRequests in apiCompat — and both the /leaves Team tab and the badge call it.
// Do not reintroduce a second answer here.

export async function getTodayLeaveList(companyId: string, date?: string): Promise<LeaveRecord[]> {
  const d = date ?? format(new Date(), 'yyyy-MM-dd');
  const q = query(
    collection(db, LEAVE_COL),
    where('company_id', '==', companyId),
    where('from_date', '<=', d),
    where('to_date',   '>=', d),
    where('status', '==', 'approved'),
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as LeaveRecord));
}

export async function checkIsTodayLeave(epf: string): Promise<LeaveRecord | null> {
  const today = format(new Date(), 'yyyy-MM-dd');
  const q = query(
    collection(db, LEAVE_COL),
    where('epf_number', '==', epf),
    where('from_date', '<=', today),
    where('to_date',   '>=', today),
    where('status', '==', 'approved'),
    limit(1),
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() } as LeaveRecord;
}

export async function considerLeave(data: {
  leave_id:       string;
  consider_by:    string;
  action:         'approve' | 'reject';
  reject_reason?: string;
}): Promise<void> {
  await updateDoc(doc(db, LEAVE_COL, data.leave_id), {
    status:        data.action === 'approve' ? 'approved' : 'rejected',
    considered_by: data.consider_by,
    considered_at: Timestamp.now(),
    reject_reason: data.reject_reason ?? null,
    updated_at:    Timestamp.now(),
  });
}

// All leaves for one employee that overlap the given month, ANY status. Used by the
// per-employee monthly Excel report (leave days are clamped to the month; medical split by
// paid). Uses a single-field equality query (epf_number) — covered by the automatic index, so
// no composite index to deploy — then clamps the month overlap client-side. A single
// employee's leave history is small, so fetching all their leaves is cheap.
// Overlap = from_date <= month-end AND to_date >= month-start.
export async function getEmployeeLeavesForMonth(
  epf: string, year: number, month: number
): Promise<LeaveRecord[]> {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end   = `${year}-${String(month).padStart(2, '0')}-31`;
  const snap = await getDocs(query(collection(db, LEAVE_COL), where('epf_number', '==', epf)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as LeaveRecord))
    .filter(l => l.from_date <= end && l.to_date >= start && !l.is_deleted)
    .sort((a, b) => a.from_date.localeCompare(b.from_date));
}

export async function getAllLeavesByMonth(
  companyId: string, year: number, month: number
): Promise<LeaveRecord[]> {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end   = `${year}-${String(month).padStart(2, '0')}-31`;
  if (!companyId) {
    // All companies: range on from_date only (single-field index — no composite needed),
    // then filter to approved client-side to avoid requiring a new (status, from_date) index.
    const q = query(
      collection(db, LEAVE_COL),
      where('from_date', '>=', start),
      where('from_date', '<=', end),
      orderBy('from_date'),
    );
    const snap = await getDocs(q);
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() } as LeaveRecord))
      .filter(l => l.status === 'approved' && !l.is_deleted);
  }
  const q = query(
    collection(db, LEAVE_COL),
    where('company_id', '==', companyId),
    where('from_date', '>=', start),
    where('from_date', '<=', end),
    where('status', '==', 'approved'),
    orderBy('from_date'),
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as LeaveRecord)).filter(l => !l.is_deleted);
}

// Leaves for the monthly REPORT — ALL statuses (the report needs total & unapproved leave
// counts, not just approved) and any leave that OVERLAPS the month, including ones that
// started in a prior month and straddle in. Overlap is filtered in memory so no new
// composite index is needed: per-company uses the company_id equality index; the org-wide
// path ranges from_date from a year before the month (a wide-enough lower bound to catch
// straddlers) so it doesn't scan the whole collection.
export async function getCompanyLeavesForReport(
  companyId: string, year: number, month: number,
): Promise<LeaveRecord[]> {
  const mm    = String(month).padStart(2, '0');
  const start = `${year}-${mm}-01`;
  const end   = `${year}-${mm}-31`;
  const overlaps = (l: LeaveRecord) => l.from_date <= end && l.to_date >= start && !l.is_deleted;

  const snap = companyId
    ? await getDocs(query(collection(db, LEAVE_COL), where('company_id', '==', companyId)))
    : await getDocs(query(
        collection(db, LEAVE_COL),
        where('from_date', '>=', `${year - 1}-${mm}-01`),
        where('from_date', '<=', end),
        orderBy('from_date'),
      ));

  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as LeaveRecord))
    .filter(overlaps)
    .sort((a, b) => a.from_date.localeCompare(b.from_date));
}
