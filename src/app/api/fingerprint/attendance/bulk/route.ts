import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import {
  authenticateDevice, processAttendanceEvent, fpaErrorResponse, type AttendanceEventInput,
} from '@/lib/fingerprintApi';

// POST /api/fingerprint/attendance/bulk — bulkRecordFingerprintAttendance (contract §6), for
// terminals flushing a queue built up while offline. Always 200s with a per-event result —
// one bad event must never fail the whole batch (contract requirement). Each event MAY carry
// its own `action` ('CHECK_IN' | 'CHECK_OUT'); it flows straight through the AttendanceEventInput
// spread below. Events are applied strictly in deviceTimestamp order, so an explicit CHECK_OUT
// replayed before its CHECK_IN is REJECTED ("no open session") — a later replay of the CHECK_IN
// reconciles, and the REJECTED event id is not locked in, so the terminal can retry it.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const db = adminDbFor(req);
    const device = await authenticateDevice(req, db, body.deviceId);

    const events: AttendanceEventInput[] = Array.isArray(body.events) ? body.events : [];

    // Process strictly in device-timestamp order (not in parallel) so a single person's
    // scans toggle check-in/check-out correctly regardless of the order the offline queue
    // happened to store them in. Invalid deviceTimestamp values sort last and simply fail
    // their own event inside processAttendanceEvent.
    const ordered = [...events].sort((a, b) => {
      const ta = typeof a.deviceTimestamp === 'string' ? Date.parse(a.deviceTimestamp) : NaN;
      const tb = typeof b.deviceTimestamp === 'string' ? Date.parse(b.deviceTimestamp) : NaN;
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return ta - tb;
    });

    const results = [];
    for (const event of ordered) {
      const r = await processAttendanceEvent(db, device, event);
      results.push({
        attendanceEventId: r.attendanceEventId,
        status: r.status,
        attendanceRecordId: r.attendanceRecordId ?? null,
        attendanceAction: r.attendanceAction ?? null,
        reviewStatus: r.reviewStatus ?? null,
        errorCode: r.errorCode,
        message: r.message,
      });
    }

    return NextResponse.json({ results, serverTimestamp: new Date().toISOString() });
  } catch (e) {
    return fpaErrorResponse(e);
  }
}
