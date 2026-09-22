import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { authenticateDevice, fpaErrorResponse, FPA } from '@/lib/fingerprintApi';
import type { DocumentData } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';

// POST /api/fingerprint/sync-users — full/incremental user sync for an HF-X05 terminal.
// See FINGERPRINT_ATTENDANCE_API.md §3 (syncAttendanceDeviceUsers in the original contract).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function toIso(v: unknown): string {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  return new Date(0).toISOString();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const db = adminDbFor(req);
    await authenticateDevice(req, db, body.deviceId);

    const updatedAfter = typeof body.updatedAfter === 'string' && body.updatedAfter ? new Date(body.updatedAfter) : null;
    if (updatedAfter && Number.isNaN(updatedAfter.getTime())) {
      return NextResponse.json({ code: FPA.INVALID_SYNC_REQUEST, message: 'updatedAfter is not a valid ISO timestamp.' }, { status: 400 });
    }

    const serverNow = new Date();
    let query = db.collection('users') as FirebaseFirestore.Query;
    if (updatedAfter) query = query.where('updated_at', '>', Timestamp.fromDate(updatedAfter));
    const snap = await query.get();

    const users = snap.docs
      .map((d) => d.data() as DocumentData)
      .filter((u) => u.epf_number) // skip any malformed doc with no epf
      .map((u) => ({
        userId: String(u.epf_number),
        employeeId: String(u.employee_number || u.epf_number),
        displayName: String(u.display_name || `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim()),
        active: u.is_active !== false,
        fingerprintEnrolled: !!u.fingerprint_enrolled,
        fingerprintEnrollmentId: (u.fingerprint_enrollment_id as string) ?? null,
        faceEnrolled: !!u.face_enrolled,
        faceEnrollmentId: (u.face_enrollment_id as string) ?? null,
        updatedAt: toIso(u.updated_at),
      }));

    return NextResponse.json({
      users,
      serverTime: serverNow.toISOString(),
      nextUpdatedAfter: serverNow.toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return fpaErrorResponse(e);
  }
}
