import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { authenticateDevice, processAttendanceEvent, fpaErrorResponse } from '@/lib/fingerprintApi';

// POST /api/fingerprint/attendance — recordFingerprintAttendance (contract §5). One scan =
// one event. The terminal MAY send an explicit `action` ('CHECK_IN' | 'CHECK_OUT'); when
// absent the backend infers direction from session state (see fingerprintApi.processAttendanceEvent).
// The terminal MAY also send `biometricType` ('FINGERPRINT' | 'FACE'); omitted keeps meaning
// FINGERPRINT, same convention as the enrollment endpoint (see attendanceBiometric.ts).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const db = adminDbFor(req);
    const device = await authenticateDevice(req, db, body.deviceId);

    const result = await processAttendanceEvent(db, device, {
      attendanceEventId: body.attendanceEventId,
      userId: body.userId,
      employeeId: body.employeeId,
      deviceTimestamp: body.deviceTimestamp,
      clientSequence: body.clientSequence,
      action: body.action,
      biometricType: body.biometricType,
    });

    return NextResponse.json({
      // DEBOUNCED is a legitimate, fully-handled outcome (a duplicate scan was correctly
      // ignored) — not a failure the terminal should retry.
      success: result.status === 'RECORDED' || result.status === 'ALREADY_RECORDED' || result.status === 'DEBOUNCED',
      attendanceEventId: result.attendanceEventId,
      status: result.status,
      attendanceRecordId: result.attendanceRecordId ?? null,
      attendanceAction: result.attendanceAction ?? null,
      // 'flagged' when the session this punch touched was parked for supervisor review
      // (reconciled overlong reopen, or an overlong check-out).
      reviewStatus: result.reviewStatus ?? null,
      serverTimestamp: new Date().toISOString(),
      message: result.message,
    });
  } catch (e) {
    return fpaErrorResponse(e);
  }
}
