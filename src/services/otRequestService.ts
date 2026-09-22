// Overtime request lifecycle — Southern Lanka Hospitals payroll tenant only.
//
// Structured like leaveService.ts: plain client-SDK functions, an auto-id `ot_requests`
// collection, single-field-equality reads (so no composite index needs deploying — the rest
// is filtered/sorted in memory), and soft-delete rather than hard delete.
//
// Routing is DELIBERATELY not HOD-based (unlike leaves/suspense) — OT approval is an explicit
// role capability, `can_approve_ot`, held by whichever roles the org configures for it,
// independent of the applicant's department or place in the reporting ladder. The pool is
// every active user (other than the applicant) whose role carries that capability. It is
// resolved once, at submit time, and frozen onto the doc so a later role change never
// strands a pending row.

import {
  addDoc, collection, doc, getDoc, getDocs, query, updateDoc, where, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { AppUser } from '@/lib/types';
import { resolveUserCapabilities } from '@/lib/permissions';
import { getRoles } from '@/services/roleService';
import { getAllUsers, getUserByEpf } from '@/services/userService';
import { createAppNotification } from '@/services/notificationService';
import {
  type OtRequest, type OtRequestStatus, type OtType,
  OT_TYPE_LABELS, MAX_OT_HOURS_PER_REQUEST, periodForDate,
} from '@/types/otRequest';

export const OT_REQUESTS_COL = 'ot_requests';

const tsMillis = (t: Timestamp | null | undefined): number => (t ? t.toMillis() : 0);

// ─── Approver routing ────────────────────────────────────────────────────────────────────

interface RoutingSubject {
  epf_number: string;
}

/** Resolves the frozen approver pool for one OT request. Exported for reuse/testing. */
export function resolveOtApproverPool(
  subject: RoutingSubject, users: AppUser[], roles: Awaited<ReturnType<typeof getRoles>>,
): string[] {
  return users
    .filter(u => u.is_active && u.epf_number && u.epf_number !== subject.epf_number)
    .filter(u => resolveUserCapabilities(u, roles).can_approve_ot)
    .map(u => u.epf_number);
}

// ─── Submit / mutate ─────────────────────────────────────────────────────────────────────

export interface SubmitOtRequestInput {
  epf_number: string;
  employee_name: string;
  company_id: string;
  department?: string | null;
  date: string;               // 'YYYY-MM-DD'
  period?: string;            // 'YYYY-MM' — defaults to date's month
  ot_type: OtType;
  requested_hours: number;
  reason: string;
  submitted_by_epf: string;
}

export async function submitOtRequest(input: SubmitOtRequestInput): Promise<string> {
  const hours = Number(input.requested_hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_OT_HOURS_PER_REQUEST) {
    throw new Error(`Overtime hours must be between 0 and ${MAX_OT_HOURS_PER_REQUEST}.`);
  }
  if (!input.reason.trim()) throw new Error('A reason is required.');

  const [users, roles] = await Promise.all([getAllUsers(input.company_id), getRoles()]);
  const self = users.find(u => u.epf_number === input.epf_number);
  const department = (input.department ?? self?.department ?? null) || null;

  const approver_pool = resolveOtApproverPool({ epf_number: input.epf_number }, users, roles);

  const now = Timestamp.now();
  const ref = await addDoc(collection(db, OT_REQUESTS_COL), {
    company_id: input.company_id,
    epf_number: input.epf_number,
    employee_name: input.employee_name,
    department,
    date: input.date,
    period: input.period || periodForDate(input.date),
    ot_type: input.ot_type,
    requested_hours: hours,
    reason: input.reason.trim(),
    status: 'pending' as OtRequestStatus,
    submitted_by_epf: input.submitted_by_epf,
    approver_pool,
    considered_by_epf: null,
    considered_by_name: null,
    considered_at: null,
    decision_note: null,
    applied_to_run_id: null,
    applied_hours: null,
    applied_at: null,
    is_deleted: false,
    created_at: now,
    updated_at: now,
  });

  await Promise.all(approver_pool.map(epf => createAppNotification({
    toEpf: epf,
    type: 'ot_request',
    actorEpf: input.submitted_by_epf,
    actorName: input.employee_name,
    title: `OT request — ${input.employee_name}`,
    body: `${OT_TYPE_LABELS[input.ot_type]} · ${hours}h on ${input.date}`,
    link: '/ot-requests',
    meta: { request_id: ref.id, ot_type: input.ot_type, hours: String(hours) },
  })));

  return ref.id;
}

export interface UpdateOtRequestPatch {
  date?: string;
  period?: string;
  ot_type?: OtType;
  requested_hours?: number;
  reason?: string;
}

/** Edit an own request while it is still pending. Stays pending; does not re-route. */
export async function updateOtRequest(id: string, patch: UpdateOtRequestPatch): Promise<void> {
  const ref = doc(db, OT_REQUESTS_COL, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('OT request not found.');
  if ((snap.data() as OtRequest).status !== 'pending') {
    throw new Error('Only a pending request can be edited.');
  }
  if (patch.requested_hours != null) {
    const h = Number(patch.requested_hours);
    if (!Number.isFinite(h) || h <= 0 || h > MAX_OT_HOURS_PER_REQUEST) {
      throw new Error(`Overtime hours must be between 0 and ${MAX_OT_HOURS_PER_REQUEST}.`);
    }
  }
  const next: Record<string, unknown> = { updated_at: Timestamp.now() };
  if (patch.date != null) { next.date = patch.date; next.period = patch.period || periodForDate(patch.date); }
  if (patch.period != null) next.period = patch.period;
  if (patch.ot_type != null) next.ot_type = patch.ot_type;
  if (patch.requested_hours != null) next.requested_hours = Number(patch.requested_hours);
  if (patch.reason != null) next.reason = patch.reason.trim();
  await updateDoc(ref, next);
}

export async function cancelOtRequest(id: string, epf: string): Promise<void> {
  const ref = doc(db, OT_REQUESTS_COL, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('OT request not found.');
  const req = snap.data() as OtRequest;
  if (req.epf_number !== epf && req.submitted_by_epf !== epf) {
    throw new Error('You can only cancel your own request.');
  }
  if (req.status !== 'pending') throw new Error('Only a pending request can be cancelled.');
  await updateDoc(ref, { status: 'cancelled', updated_at: Timestamp.now() });
}

/** Soft-delete (admin) — keeps the doc for audit; every read here skips is_deleted rows. */
export async function softDeleteOtRequest(id: string, deletedBy: string, reason: string): Promise<void> {
  await updateDoc(doc(db, OT_REQUESTS_COL, id), {
    is_deleted: true,
    deleted_by: deletedBy,
    deleted_at: Timestamp.now(),
    delete_reason: reason,
    updated_at: Timestamp.now(),
  });
}

// ─── Decide ──────────────────────────────────────────────────────────────────────────────

export interface ConsiderOtRequestInput {
  request_id: string;
  approver_epf: string;
  approver_name: string;
  action: 'approve' | 'reject';
  note?: string;
}

export async function considerOtRequest(input: ConsiderOtRequestInput): Promise<void> {
  const ref = doc(db, OT_REQUESTS_COL, input.request_id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('OT request not found.');
  const req = snap.data() as OtRequest;
  if (req.status !== 'pending') throw new Error(`This request is already ${req.status}.`);
  if (input.action === 'reject' && !input.note?.trim()) {
    throw new Error('A reason is required to reject a request.');
  }

  const now = Timestamp.now();
  const approved = input.action === 'approve';
  await updateDoc(ref, {
    status: approved ? 'approved' : 'rejected',
    considered_by_epf: input.approver_epf,
    considered_by_name: input.approver_name,
    considered_at: now,
    decision_note: input.note?.trim() || null,
    updated_at: now,
  });

  await createAppNotification({
    toEpf: req.submitted_by_epf,
    type: approved ? 'ot_approved' : 'ot_rejected',
    actorEpf: input.approver_epf,
    actorName: input.approver_name,
    title: `Overtime ${approved ? 'approved' : 'rejected'} — ${req.date}`,
    body: `${OT_TYPE_LABELS[req.ot_type]} · ${req.requested_hours}h${input.note?.trim() ? ` — ${input.note.trim()}` : ''}`,
    link: '/ot-requests',
    meta: { request_id: input.request_id },
  });
}

// ─── Reads ───────────────────────────────────────────────────────────────────────────────

export async function getMyOtRequests(epf: string, opts?: { limit?: number }): Promise<OtRequest[]> {
  const snap = await getDocs(query(collection(db, OT_REQUESTS_COL), where('epf_number', '==', epf)));
  const rows = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as OtRequest))
    .filter(r => !r.is_deleted)
    .sort((a, b) => b.date.localeCompare(a.date) || tsMillis(b.created_at) - tsMillis(a.created_at));
  return opts?.limit ? rows.slice(0, opts.limit) : rows;
}

/** An approver's pending queue.
 *
 *  1. Every request whose frozen `approver_pool` contains their EPF — the common case.
 *  2. A live fallback for someone who holds `can_approve_ot` today but didn't when an
 *     already-pending request was filed (a role grant always lands after the fact):
 *     recomputed with today's capability routing — the exact same `resolveOtApproverPool`
 *     used at submit time — so a fresh approver isn't stranded until the applicant happens to
 *     file again. Frozen pools stay untouched; this only widens what a *read* can surface.
 */
export async function getPendingOtRequestsForApprover(approverEpf: string): Promise<OtRequest[]> {
  const approver = await getUserByEpf(approverEpf);
  const [poolSnap, roles] = await Promise.all([
    getDocs(query(collection(db, OT_REQUESTS_COL), where('approver_pool', 'array-contains', approverEpf))),
    getRoles(),
  ]);

  const byId = new Map<string, OtRequest>();
  poolSnap.docs.forEach(d => byId.set(d.id, { id: d.id, ...d.data() } as OtRequest));

  if (approver && resolveUserCapabilities(approver, roles).can_approve_ot) {
    const [allPendingSnap, users] = await Promise.all([
      getDocs(query(collection(db, OT_REQUESTS_COL), where('status', '==', 'pending'))),
      getAllUsers(),
    ]);
    allPendingSnap.docs.forEach(d => {
      if (byId.has(d.id) || d.data().is_deleted) return;
      const req = { id: d.id, ...d.data() } as OtRequest;
      const pool = resolveOtApproverPool({ epf_number: req.epf_number }, users, roles);
      if (pool.includes(approverEpf)) byId.set(d.id, req);
    });
  }

  return [...byId.values()]
    .filter(r => r.status === 'pending' && !r.is_deleted)
    .sort((a, b) => tsMillis(a.created_at) - tsMillis(b.created_at));
}

/** Source query for the payroll "Sync Approved OT" step. Period + status filtered in memory
 *  (single-field company_id equality → covered by the automatic index). */
export async function getOtRequestsForPeriod(
  companyId: string, period: string, status?: OtRequestStatus,
): Promise<OtRequest[]> {
  const snap = await getDocs(query(collection(db, OT_REQUESTS_COL), where('company_id', '==', companyId)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as OtRequest))
    .filter(r => r.period === period && !r.is_deleted && (status ? r.status === status : true));
}

/** One employee's requests for a calendar month — for the Bulk Sheet per-row drill-down. */
export async function getOtRequestsForEmployeeMonth(
  epf: string, year: number, month: number,
): Promise<OtRequest[]> {
  const period = `${year}-${String(month).padStart(2, '0')}`;
  const snap = await getDocs(query(collection(db, OT_REQUESTS_COL), where('epf_number', '==', epf)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as OtRequest))
    .filter(r => r.period === period && !r.is_deleted)
    .sort((a, b) => a.date.localeCompare(b.date));
}
