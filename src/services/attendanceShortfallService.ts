// Monthly Late Arrival / Early Departure accumulation — one doc per employee per company per
// month, computed client-side on the Attendance View page (src/lib/attendanceShortfallEngine.ts
// does the actual per-day math) and upserted here so the number is a stable, readable snapshot
// rather than something every consumer has to recompute. Deliberately NOT wired into any
// automatic payroll deduction or leave-balance conversion yet — HR/Payroll read these totals
// and action them manually (e.g. a one-off deduction line on the Monthly Run Bulk Sheet, or a
// manual leave-balance adjustment) until that automation is explicitly requested and designed.

import { collection, doc, getDocs, query, where, writeBatch, Timestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { epfDocId } from '@/services/userService';

export interface AttendanceShortfallSummary {
  id?: string;

  company_id: string;
  epf_number: string;
  employee_name: string;
  period: string; // 'YYYY-MM'

  total_late_minutes: number;
  total_early_departure_minutes: number;
  late_days: number;             // count of days with lateMinutes > 0
  early_departure_days: number;  // count of days with earlyDepartureMinutes > 0

  updated_at?: Timestamp;
}

const COL = 'attendance_shortfall_summary';

function summaryDocId(companyId: string, epf: string, period: string): string {
  return `${companyId}_${epfDocId(epf)}_${period}`;
}

export async function getAttendanceShortfallSummaries(companyId: string, period: string): Promise<AttendanceShortfallSummary[]> {
  const snap = await getDocs(query(
    collection(db, COL),
    where('company_id', '==', companyId),
    where('period', '==', period),
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as AttendanceShortfallSummary));
}

/** Upserts every row in one batch. Called once per Attendance View page load (after computing
 *  the visible month's totals in-memory) — safe to call repeatedly; each write simply
 *  overwrites that employee/month's snapshot with the latest computed totals. */
export async function upsertAttendanceShortfallSummaries(
  rows: Omit<AttendanceShortfallSummary, 'id' | 'updated_at'>[],
): Promise<void> {
  if (rows.length === 0) return;
  const batch = writeBatch(db);
  const now = Timestamp.now();
  for (const r of rows) {
    const ref = doc(db, COL, summaryDocId(r.company_id, r.epf_number, r.period));
    batch.set(ref, { ...r, updated_at: now });
  }
  await batch.commit();
}
