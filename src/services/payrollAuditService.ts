// PAYROLL-001 — audit log for payroll configuration / pay-profile changes.
// See PAYROLL_FIRESTORE_DATA_MODEL.md §18, PAYROLL_IMPLEMENTATION_START_HERE.md §25.
// Southern Lanka Hospitals tenant only.

import { collection, addDoc, getDocs, query, where, orderBy, limit, Timestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { PayrollAuditAction, PayrollAuditLogEntry } from '@/lib/payrollTypes';

const COL = 'payroll_audit_logs';

export async function writePayrollAudit(entry: {
  company_id: string;
  action: PayrollAuditAction;
  entity_type: PayrollAuditLogEntry['entity_type'];
  entity_id: string;
  epf_number?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  performed_by_epf: string;
  performed_by_name: string;
}): Promise<void> {
  try {
    await addDoc(collection(db, COL), {
      ...entry,
      epf_number: entry.epf_number ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      reason: entry.reason ?? null,
      performed_at: Timestamp.now(),
    } satisfies Omit<PayrollAuditLogEntry, 'id'>);
  } catch (e) {
    // Never let an audit-write failure block the underlying config change — log and move on.
    console.error('[payrollAuditService] failed to write audit entry:', e);
  }
}

export async function listPayrollAudit(companyId: string, max = 200): Promise<PayrollAuditLogEntry[]> {
  const snap = await getDocs(query(
    collection(db, COL),
    where('company_id', '==', companyId),
    orderBy('performed_at', 'desc'),
    limit(max),
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as PayrollAuditLogEntry));
}

export async function listPayrollAuditForEmployee(companyId: string, epfNumber: string, max = 100): Promise<PayrollAuditLogEntry[]> {
  const snap = await getDocs(query(
    collection(db, COL),
    where('company_id', '==', companyId),
    where('epf_number', '==', epfNumber),
    orderBy('performed_at', 'desc'),
    limit(max),
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as PayrollAuditLogEntry));
}
