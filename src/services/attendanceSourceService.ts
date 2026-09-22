// Client-side helper for the Attendance View cell-detail modal's "Device ID" lookup.
// fingerprint_attendance_events is Admin-SDK-only (see firestore.rules) — this goes through
// the one narrow server route that exposes it (src/app/api/payroll/attendance-source/route.ts),
// never a direct client query.

import { auth } from '@/lib/firebase';

export interface FingerprintEventInfo {
  attendance_action: 'CHECK_IN' | 'CHECK_OUT' | null;
  device_id: string | null;
  device_timestamp: unknown;
}

/** Every fingerprint-terminal event recorded against one attendances/{epfDocId} doc — at most
 *  one CHECK_IN and one CHECK_OUT entry, since fingerprintApi.ts writes exactly one event per
 *  punch. Empty array for a day with no fingerprint punches at all (pure mobile-app day). */
export async function getAttendanceFingerprintSource(attendanceRecordId: string): Promise<FingerprintEventInfo[]> {
  const idToken = await auth.currentUser?.getIdToken();
  const res = await fetch('/api/payroll/attendance-source', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, attendanceRecordId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'Request failed.');
  return data.events ?? [];
}
