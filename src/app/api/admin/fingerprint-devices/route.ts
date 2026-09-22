import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { FieldValue, type DocumentData } from 'firebase-admin/firestore';
import {
  requireUserManager, requireSouthernlankaTenant, fpaErrorResponse, FpaError, FPA,
} from '@/lib/fingerprintApi';

// Fingerprint terminal (attendance_devices) provisioning — the piece the original contract
// left to "provisioning/backend" with no API of its own. Gated the same way as the other
// /api/admin/* routes: a Firebase ID token belonging to a user-manager / system admin.
//
//   GET  /api/admin/fingerprint-devices             list every registered terminal
//   POST /api/admin/fingerprint-devices             provision a new terminal
//   PATCH /api/admin/fingerprint-devices/{deviceId}  rename / enable / disable / re-point
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function idTokenFrom(req: NextRequest): string {
  return req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
}

export async function GET(req: NextRequest) {
  try {
    requireSouthernlankaTenant(req);
    const db = adminDbFor(req);
    await requireUserManager(db, idTokenFrom(req));

    const snap = await db.collection('attendance_devices').orderBy('created_at', 'desc').get();
    const devices = snap.docs.map((d) => {
      const v = d.data() as DocumentData;
      return {
        deviceId: d.id,
        name: v.name ?? d.id,
        active: v.active !== false,
        workingPlace: v.working_place ?? null,
        companyId: v.company_id ?? null,
        companyName: v.company_name ?? null,
        createdByName: v.created_by_name ?? null,
      };
    });
    return NextResponse.json({ devices });
  } catch (e) {
    return fpaErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireSouthernlankaTenant(req);
    const body = await req.json().catch(() => ({}));
    const db = adminDbFor(req);
    const caller = await requireUserManager(db, body.idToken);

    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
    if (!deviceId) throw new FpaError(FPA.INVALID_SYNC_REQUEST, 400, 'deviceId is required.');

    const ref = db.collection('attendance_devices').doc(deviceId);
    if ((await ref.get()).exists) {
      throw new FpaError(FPA.INVALID_SYNC_REQUEST, 409, `Device already exists: ${deviceId}`);
    }

    const now = FieldValue.serverTimestamp();
    await ref.set({
      id: deviceId,
      name: (typeof body.name === 'string' && body.name.trim()) || deviceId,
      active: true,
      working_place: (typeof body.workingPlace === 'string' && body.workingPlace.trim()) || null,
      company_id: (typeof body.companyId === 'string' && body.companyId.trim()) || null,
      company_name: (typeof body.companyName === 'string' && body.companyName.trim()) || null,
      created_by: caller.epf,
      created_by_name: (typeof body.callerName === 'string' && body.callerName) || caller.epf,
      created_at: now,
      updated_at: now,
    });

    return NextResponse.json({ success: true, deviceId });
  } catch (e) {
    return fpaErrorResponse(e);
  }
}
