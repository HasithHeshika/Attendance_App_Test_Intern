// Overtime request domain — Southern Lanka Hospitals payroll tenant only.
//
// Punch logs never generate OT in this system; the payroll engine only prices whatever OT
// hours sit on a `payroll_monthly_entries` row. This collection is the missing link: an
// employee files a request, an approver decides it, and a dedicated payroll "Sync Approved
// OT" step (see src/services/payrollRunService.ts) sums the APPROVED requests for a period
// onto the Bulk Sheet. Deliberately kept separate from "Sync from Attendance", which derives
// a suggestion from the schedule roster — the two must not write the same field.
//
// Modelled on the leave-request workflow (`leaves` collection): auto-id docs, a
// pending/approved/rejected status, considered_by/considered_at/decision_note on decision,
// an approver pool snapshotted at submit, and an is_deleted soft-delete.

import type { Timestamp } from 'firebase/firestore';

// Which paid line the hours land on. Mirrors the five OT buckets the calculation engine
// already prices (see OT_TYPE_TO_ENTRY_FIELD for the exact Bulk Sheet field each maps to).
export type OtType = 'normal' | 'double' | 'ph' | 'poya' | 'mercantile';

export type OtRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface OtRequest {
  id: string;

  company_id: string;
  epf_number: string;        // the employee the OT is for
  employee_name: string;     // display snapshot, refreshed on write
  department: string | null; // snapshot of AppUser.department — drives HOD routing

  date: string;              // 'YYYY-MM-DD' — the day the OT was worked
  period: string;            // 'YYYY-MM' — payroll cycle to pay it in. Defaults to date's
                             // month; editable so OT can be pushed to a later run.
  ot_type: OtType;
  requested_hours: number;   // > 0, capped at 24; decimal hours allowed (e.g. 2.5)
  reason: string;

  status: OtRequestStatus;
  submitted_by_epf: string;  // usually == epf_number; differs if HR files on someone's behalf

  // EPFs allowed to decide this request — resolved and frozen at submit time so a later role
  // change never strands a pending request. Queried with array-contains.
  approver_pool: string[];

  considered_by_epf: string | null;
  considered_by_name: string | null;
  considered_at: Timestamp | null;
  decision_note: string | null; // approver comment OR rejection reason — one field, either way

  // Set by "Sync Approved OT" on the Monthly Run page. Non-null ⇒ these hours were already
  // counted into that run; used to keep the sync idempotent and to block a second run from
  // double-counting the same request.
  applied_to_run_id: string | null;
  applied_hours: number | null;
  applied_at: Timestamp | null;

  is_deleted?: boolean;
  deleted_by?: string;
  deleted_at?: Timestamp;
  delete_reason?: string;

  created_at: Timestamp;
  updated_at: Timestamp;
}

// ─── Display + payroll mapping ────────────────────────────────────────────────────────────

export const OT_TYPES: readonly OtType[] = ['normal', 'double', 'ph', 'poya', 'mercantile'] as const;

export const OT_TYPE_LABELS: Record<OtType, string> = {
  normal:      'Normal OT',
  double:      'Double OT',
  ph:          'Public Holiday OT',
  poya:        'Poya OT',
  mercantile:  'Mercantile OT',
};

// ot_type → the `payroll_monthly_entries` hour field the approved total is written to.
// Each of these is already priced by calculatePayrollForEmployee, so the sync adds no new
// money line — it only fills a field that has a home.
export const OT_TYPE_TO_ENTRY_FIELD: Record<OtType, 'ot_hours_normal' | 'ot_hours_double' | 'ph_hours_overtime' | 'poya_hours_overtime' | 'mercantile_hours_overtime'> = {
  normal:      'ot_hours_normal',
  double:      'ot_hours_double',
  ph:          'ph_hours_overtime',
  poya:        'poya_hours_overtime',
  mercantile:  'mercantile_hours_overtime',
};

// ot_type → the bookkeeping field that records how much of the entry's hours came from
// approved requests at the last sync. The sync applies (approved − synced) as a delta, so a
// re-run is a no-op, manual edits survive, and a later reject/delete subtracts correctly.
export const OT_TYPE_TO_SYNC_FIELD: Record<OtType, 'ot_synced_normal' | 'ot_synced_double' | 'ot_synced_ph' | 'ot_synced_poya' | 'ot_synced_mercantile'> = {
  normal:      'ot_synced_normal',
  double:      'ot_synced_double',
  ph:          'ot_synced_ph',
  poya:        'ot_synced_poya',
  mercantile:  'ot_synced_mercantile',
};

// Per-employee approved OT hours for one payroll period, split by bucket.
export interface ApprovedOtByType {
  normal: number;
  double: number;
  ph: number;
  poya: number;
  mercantile: number;
}

export function emptyApprovedOt(): ApprovedOtByType {
  return { normal: 0, double: 0, ph: 0, poya: 0, mercantile: 0 };
}

export const MAX_OT_HOURS_PER_REQUEST = 24;

/** 'YYYY-MM' payroll period for a 'YYYY-MM-DD' worked date. */
export function periodForDate(date: string): string {
  return date.slice(0, 7);
}
