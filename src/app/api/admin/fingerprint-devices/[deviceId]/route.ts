import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { FieldValue } from 'firebase-admin/firestore';
import {
  requireUserManager, requireSouthernlankaTenant, fpaErrorResponse, FpaError, FPA,
} from '@/lib/fingerprintApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PATCH /api/admin/fingerprint-devices/{deviceId} — rename / enable / disable / re-point a
// terminal. Deliberately no DELETE: prefer active=false (soft-disable), same convention as
// users/departments/rosters elsewhere in this app — a disabled deviceId still fails device
// auth immediately (see authenticateDevice) without losing its enrollment/attendance history.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
  try {
    requireSouthernlankaTenant(req);
    const { deviceId } = await params;
    const body = await req.json().catch(() => ({}));
    const db = adminDbFor(req);
    await requireUserManager(db, body.idToken);

    const ref = db.collection('attendance_devices').doc(deviceId);
    if (!(await ref.get()).exists) {
      throw new FpaError(FPA.DEVICE_NOT_FOUND, 404, `Unknown device: ${deviceId}`);
    }

    const patch: Record<string, unknown> = { updated_at: FieldValue.serverTimestamp() };
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.active === 'boolean') patch.active = body.active;
    if (typeof body.workingPlace === 'string' || body.workingPlace === null) patch.working_place = body.workingPlace || null;
    if (typeof body.companyId === 'string' || body.companyId === null) patch.company_id = body.companyId || null;
    if (typeof body.companyName === 'string' || body.companyName === null) patch.company_name = body.companyName || null;

    await ref.update(patch);
    return NextResponse.json({ success: true, deviceId });
  } catch (e) {
    return fpaErrorResponse(e);
  }
}
