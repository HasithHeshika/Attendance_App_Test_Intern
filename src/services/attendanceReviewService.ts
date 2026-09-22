// Attendance review lifecycle — Southern Lanka only.
//
// A flagged session (overlong check-out, reopened-after-missing-checkout, still-open past
// MAX_PLAUSIBLE_SHIFT_HOURS, or a retro-roster split) gets one `attendance_reviews` row,
// written by the fingerprint engine or the open-session-monitor cron (Admin SDK, deterministic
// doc id → idempotent). This module is the web-app side: list the queue and move a row through
// flagged → in_review → resolved. The raw attendance session timestamps are NEVER touched here.
//
// Same shape as otRequestService / leaveService: plain client-SDK functions, single-field
// equality reads (no composite index to deploy — sorted in memory), capability gating done
// client-side (the app-wide posture — see firestore.southernlanka.rules).

import {
  collection, doc, getDoc, getDocs, query, updateDoc, where, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { AttendanceReview, AttendanceReviewResolution, AttendanceReviewStatus } from '@/lib/types';

export const ATTENDANCE_REVIEWS_COL = 'attendance_reviews';

const tsMillis = (t: Timestamp | null | undefined): number => (t ? t.toMillis() : 0);

function mapReview(id: string, d: Record<string, unknown>): AttendanceReview {
  return {
    id,
    epf_number: String(d.epf_number ?? ''),
    employee_name: String(d.employee_name ?? '') || '',
    attendance_date: String(d.attendance_date ?? ''),
    session_id: String(d.session_id ?? ''),
    review_reason: (d.review_reason as AttendanceReview['review_reason']) ?? 'overlong',
    review_status: (d.review_status as AttendanceReviewStatus) ?? 'flagged',
    severity_hours: Number(d.severity_hours ?? 0),
    actual_hours: Number(d.actual_hours ?? 0),
    scheduled_hours: d.scheduled_hours == null ? null : Number(d.scheduled_hours),
    source_channel: (d.source_channel as AttendanceReview['source_channel']) ?? 'fingerprint',
    created_at: (d.created_at as Timestamp) ?? Timestamp.fromMillis(0),
    in_review_by: (d.in_review_by as string) ?? null,
    in_review_at: (d.in_review_at as Timestamp) ?? null,
    resolved_by: (d.resolved_by as string) ?? null,
    resolved_at: (d.resolved_at as Timestamp) ?? null,
    resolution: (d.resolution as AttendanceReviewResolution) ?? null,
    resolution_note: (d.resolution_note as string) ?? null,
    linked_ot_request_id: (d.linked_ot_request_id as string) ?? null,
    linked_edit_request_id: (d.linked_edit_request_id as string) ?? null,
    is_deleted: d.is_deleted === true,
  };
}

/**
 * The review queue. Filter by `status` and/or `epf` (both single-field equality — no composite
 * index); everything else is filtered/sorted in memory (newest first). Soft-deleted rows are
 * always excluded.
 */
export async function getAttendanceReviews(opts: {
  status?: AttendanceReviewStatus;
  epf?: string;
  limit?: number;
} = {}): Promise<AttendanceReview[]> {
  // One single-field equality clause at most (no composite index to deploy); the other filter,
  // if any, is applied in memory.
  const epf = opts.epf ? String(opts.epf) : null;
  const clause = opts.status
    ? where('review_status', '==', opts.status)
    : epf ? where('epf_number', '==', epf) : null;

  const snap = await getDocs(clause
    ? query(collection(db, ATTENDANCE_REVIEWS_COL), clause)
    : query(collection(db, ATTENDANCE_REVIEWS_COL)));

  let rows = snap.docs.map(d => mapReview(d.id, d.data()))
    .filter(r => !r.is_deleted)
    .filter(r => (opts.status ? !epf || r.epf_number === epf : true)) // epf filtered in memory when status was the query clause
    .sort((a, b) => tsMillis(b.created_at) - tsMillis(a.created_at));

  if (opts.limit && opts.limit > 0) rows = rows.slice(0, opts.limit);
  return rows;
}

export async function getAttendanceReview(id: string): Promise<AttendanceReview | null> {
  const snap = await getDoc(doc(db, ATTENDANCE_REVIEWS_COL, id));
  return snap.exists() ? mapReview(snap.id, snap.data()) : null;
}

/** flagged → in_review. No-op-safe if it is already past flagged. */
export async function startAttendanceReview(id: string, byEpf: string): Promise<void> {
  const ref = doc(db, ATTENDANCE_REVIEWS_COL, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Review not found.');
  if ((snap.data() as { review_status?: string }).review_status !== 'flagged') return;
  await updateDoc(ref, {
    review_status: 'in_review',
    in_review_by: byEpf,
    in_review_at: Timestamp.now(),
  });
}

/** → resolved. `resolution` records how the extra hours were handled (a Time Correction, an
 *  approved OT request, or accepted as-is). Does not itself create those artefacts. */
export async function resolveAttendanceReview(id: string, input: {
  by: string;
  resolution: AttendanceReviewResolution;
  note?: string;
  linkedOtRequestId?: string | null;
  linkedEditRequestId?: string | null;
}): Promise<void> {
  const ref = doc(db, ATTENDANCE_REVIEWS_COL, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Review not found.');
  if ((snap.data() as { review_status?: string }).review_status === 'resolved') {
    throw new Error('This review is already resolved.');
  }
  await updateDoc(ref, {
    review_status: 'resolved',
    resolved_by: input.by,
    resolved_at: Timestamp.now(),
    resolution: input.resolution,
    resolution_note: input.note?.trim() || null,
    linked_ot_request_id: input.linkedOtRequestId ?? null,
    linked_edit_request_id: input.linkedEditRequestId ?? null,
  });
}
