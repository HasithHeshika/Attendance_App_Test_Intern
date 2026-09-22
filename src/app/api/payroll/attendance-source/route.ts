import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { verifyPayrollCaller, requirePayrollTenant } from '@/lib/payrollApiAuth';

// POST /api/payroll/attendance-source — resolves which device_id actually recorded a
// fingerprint-terminal punch, for the Attendance View cell-detail modal.
// fingerprint_attendance_events is Admin-SDK-only by design (`allow read, write: if false` in
// firestore.rules) — it's a raw per-scan idempotency ledger for the terminal API, not meant to
// be browsed directly. This is the one narrow, read-only route that exposes just the
// device_id/action/timestamp fields for ONE attendance record, to a caller who already has
// can_view_attendance — never the whole raw log.
export async function POST(req: NextRequest) {
  try {
    if (!requirePayrollTenant(req)) return NextResponse.json({ error: 'Payroll is not enabled for this organisation' }, { status: 404 });
    const { idToken, attendanceRecordId } = await req.json();
    const db = adminDbFor(req);

    const caller = await verifyPayrollCaller(db, idToken);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!caller.is_system_admin && !caller.can_view_attendance) {
      return NextResponse.json({ error: 'Attendance view access required' }, { status: 403 });
    }
    if (!attendanceRecordId || typeof attendanceRecordId !== 'string') {
      return NextResponse.json({ error: 'attendanceRecordId is required' }, { status: 400 });
    }

    const snap = await db.collection('fingerprint_attendance_events')
      .where('attendance_record_id', '==', attendanceRecordId)
      .get();

    const events = snap.docs.map(d => {
      const data = d.data();
      return {
        attendance_action: (data.attendance_action as 'CHECK_IN' | 'CHECK_OUT' | undefined) ?? null,
        device_id: (data.device_id as string | undefined) ?? null,
        device_timestamp: data.device_timestamp ?? null,
      };
    });

    return NextResponse.json({ success: true, events });
  } catch (e) {
    console.error('[payroll/attendance-source]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
