// Employee-raised requests for a salary advance or a loan (see PayrollRequest in
// payrollTypes.ts). Raised from the profile page; decided on the Salary Advances / Loans
// pages by whoever manages pay profiles. Approving one does NOT create the advance or loan
// here — the approver records it through payrollSalaryAdvanceService / payrollLoanService
// exactly as they would without a request, then this marks the request approved with the new
// record's id. That keeps the money path single: one create function per collection, one
// audit action, one place the Finalize route has to trust.

import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { PayrollRequest, PayrollRequestKind } from '@/lib/payrollTypes';
import type { AppUser } from '@/lib/types';
import { getRoles } from '@/services/roleService';
import { getAllUsers } from '@/services/userService';
import { resolveUserCapabilities } from '@/lib/permissions';
import { createAppNotification } from '@/services/notificationService';
import { writePayrollAudit } from '@/services/payrollAuditService';

const COL = 'payroll_requests';

export interface Actor { epf: string; name: string; }

const KIND_LABEL: Record<PayrollRequestKind, string> = { advance: 'salary advance', loan: 'loan' };

const money = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;

export interface PayrollRequestInput {
  kind:          PayrollRequestKind;
  company_id:    string;
  company_name:  string;
  epf_number:    string;
  employee_name: string;
  amount:        number;
  reason:        string;
  period:        string;            // 'YYYY-MM'
  repay_months?: number | null;     // loans only
}

/** What is wrong with a request before it is saved — the same checks the form shows. */
export function validatePayrollRequest(r: PayrollRequestInput): string[] {
  const errors: string[] = [];
  if (!r.epf_number) errors.push('We could not tell who you are — reload and try again.');
  if (!r.company_id) errors.push('Your profile has no company — ask an admin to set one before requesting.');
  if (!(money(r.amount) > 0)) errors.push('Enter an amount greater than zero.');
  if (!r.reason.trim()) errors.push('Say what the money is for.');
  if (!/^\d{4}-\d{2}$/.test(r.period)) errors.push('Pick a month.');
  if (r.kind === 'loan') {
    const m = Number(r.repay_months);
    if (!Number.isInteger(m) || m < 1 || m > 60) errors.push('Repayment must be between 1 and 60 months.');
  }
  return errors;
}

/** Everyone who may decide these: whoever manages pay profiles, plus system admins. Resolved
 *  from the roles registry the same way the sidebar decides who sees the Loans page.
 *
 *  `requestCompanyId`, when given, drops an approver who could never actually SEE the request:
 *  useCompanyContext() hard-locks anyone without is_system_admin or can_manage_all_companies to
 *  their own AppUser.company_id, with no "All companies" option to fall back on — so a plain
 *  can_manage_pay_profiles holder for a different company would be notified about a request
 *  that the Salary Advances / Loans queue can never show them, no matter what they do on that
 *  page. Omit it (e.g. for the approvers list a UI merely displays) to get everyone regardless
 *  of company. */
export async function getPayrollRequestApprovers(excludeEpf?: string, requestCompanyId?: string): Promise<AppUser[]> {
  const [roles, users] = await Promise.all([getRoles(), getAllUsers()]);
  return users.filter((u) => {
    if (!u.epf_number || u.epf_number === excludeEpf) return false;
    const caps = resolveUserCapabilities(u, roles);
    if (!(caps.is_system_admin || caps.can_manage_pay_profiles)) return false;
    if (!requestCompanyId || caps.is_system_admin || caps.can_manage_all_companies) return true;
    return u.company_id === requestCompanyId;
  });
}

/** One employee's own requests, newest first. */
export async function getMyPayrollRequests(epf: string): Promise<PayrollRequest[]> {
  if (!epf) return [];
  const snap = await getDocs(query(collection(db, COL), where('epf_number', '==', epf)));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as PayrollRequest))
    .sort((a, b) => (b.created_at?.toMillis?.() ?? 0) - (a.created_at?.toMillis?.() ?? 0));
}

/** Everything still waiting on a decision — the approvers' queue. Optionally one kind, or one
 *  company ('' = every company). Two equality filters at most, so no composite index. */
export async function getPendingPayrollRequests(opts: { kind?: PayrollRequestKind; companyId?: string } = {}): Promise<PayrollRequest[]> {
  const clauses = [where('status', '==', 'pending')];
  if (opts.kind) clauses.push(where('kind', '==', opts.kind));
  const snap = await getDocs(query(collection(db, COL), ...clauses));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as PayrollRequest))
    .filter((r) => !opts.companyId || r.company_id === opts.companyId)
    .sort((a, b) => (a.created_at?.toMillis?.() ?? 0) - (b.created_at?.toMillis?.() ?? 0));
}

/**
 * Raise a request. One live request per person per kind: a second one while the first is still
 * pending is refused rather than queued, so the approver never has to reconcile two versions of
 * the same ask. Tells every approver — nobody watches a queue they were never told about.
 */
export async function createPayrollRequest(input: PayrollRequestInput, actor: Actor): Promise<string> {
  const errors = validatePayrollRequest(input);
  if (errors.length) throw new Error(errors[0]);

  const open = (await getMyPayrollRequests(input.epf_number))
    .find((r) => r.kind === input.kind && r.status === 'pending');
  if (open) throw new Error(`You already have a ${KIND_LABEL[input.kind]} request waiting for a decision.`);

  const now = Timestamp.now();
  const ref = doc(collection(db, COL));
  const record: Omit<PayrollRequest, 'id'> = {
    kind: input.kind,
    company_id: input.company_id, company_name: input.company_name,
    epf_number: input.epf_number, employee_name: input.employee_name,
    amount: money(input.amount),
    reason: input.reason.trim(),
    period: input.period,
    repay_months: input.kind === 'loan' ? Number(input.repay_months) : null,
    status: 'pending',
    linked_id: null,
    decided_by_epf: null, decided_by_name: null, decided_at: null, decision_note: null,
    created_at: now, updated_at: now,
  };
  await setDoc(ref, record);

  // Best effort, after the write: a failed notification must never fail the request.
  try {
    const approvers = await getPayrollRequestApprovers(input.epf_number, input.company_id);
    const link = input.kind === 'advance' ? '/salary-advances' : '/payroll-loans';
    await Promise.all(approvers.map((a) => createAppNotification({
      toEpf: a.epf_number, type: 'general', actorEpf: actor.epf, actorName: actor.name,
      title: `${input.employee_name} asked for a ${KIND_LABEL[input.kind]}`,
      body: `${record.amount.toLocaleString()} · ${input.company_name} — ${record.reason}`,
      link,
    })));
  } catch { /* the request stands either way */ }
  return ref.id;
}

/** The employee takes a pending request back. Anything already decided cannot be withdrawn. */
export async function withdrawPayrollRequest(id: string, actor: Actor): Promise<void> {
  const snap = await getDoc(doc(db, COL, id));
  if (!snap.exists()) throw new Error('Request not found.');
  const r = snap.data() as PayrollRequest;
  if (r.epf_number !== actor.epf) throw new Error('Only the person who raised this can withdraw it.');
  if (r.status !== 'pending') throw new Error('This request has already been decided.');
  await updateDoc(doc(db, COL, id), { status: 'withdrawn', updated_at: Timestamp.now() });
}

/**
 * Mark a request approved, pointing at the advance / loan the approver has just recorded for
 * it (`linkedId`). Call this AFTER that record exists — an approval with nothing behind it
 * would tell the employee money is coming that no payroll run will ever pay.
 */
export async function approvePayrollRequest(id: string, linkedId: string, actor: Actor, note?: string): Promise<void> {
  const snap = await getDoc(doc(db, COL, id));
  if (!snap.exists()) throw new Error('Request not found.');
  const r = snap.data() as PayrollRequest;
  if (r.status !== 'pending') throw new Error('This request has already been decided.');
  await decide(id, r, 'approved', actor, note ?? null, linkedId);
}

export async function rejectPayrollRequest(id: string, actor: Actor, note: string): Promise<void> {
  const snap = await getDoc(doc(db, COL, id));
  if (!snap.exists()) throw new Error('Request not found.');
  const r = snap.data() as PayrollRequest;
  if (r.status !== 'pending') throw new Error('This request has already been decided.');
  await decide(id, r, 'rejected', actor, note.trim() || null, null);
}

async function decide(
  id: string, r: PayrollRequest, status: 'approved' | 'rejected', actor: Actor,
  note: string | null, linkedId: string | null,
): Promise<void> {
  await updateDoc(doc(db, COL, id), {
    status, linked_id: linkedId,
    decided_by_epf: actor.epf, decided_by_name: actor.name, decided_at: Timestamp.now(),
    decision_note: note, updated_at: Timestamp.now(),
  });
  await writePayrollAudit({
    company_id: r.company_id,
    action: status === 'approved' ? 'PAYROLL_REQUEST_APPROVED' : 'PAYROLL_REQUEST_REJECTED',
    entity_type: 'payroll_request', entity_id: id,
    epf_number: r.epf_number, after: { status, linked_id: linkedId, decision_note: note },
    performed_by_epf: actor.epf, performed_by_name: actor.name,
  }).catch(() => { /* audit is evidence, never a gate */ });
  await createAppNotification({
    toEpf: r.epf_number, type: 'general', actorEpf: actor.epf, actorName: actor.name,
    title: status === 'approved' ? `${KIND_LABEL[r.kind][0].toUpperCase()}${KIND_LABEL[r.kind].slice(1)} approved` : `${KIND_LABEL[r.kind][0].toUpperCase()}${KIND_LABEL[r.kind].slice(1)} request turned down`,
    body: status === 'approved'
      ? `${actor.name} approved your ${KIND_LABEL[r.kind]} of ${money(r.amount).toLocaleString()}.${note ? ` — ${note}` : ''}`
      : `${actor.name} turned down your ${KIND_LABEL[r.kind]} request.${note ? ` — ${note}` : ''}`,
    link: '/profile',
  });
}
