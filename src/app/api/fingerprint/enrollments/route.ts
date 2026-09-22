import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { FieldValue, Timestamp, type DocumentData } from 'firebase-admin/firestore';
import {
  authenticateDevice, loadAndValidateUser, fpaErrorResponse, FPA, FpaError,
} from '@/lib/fingerprintApi';
import type { FingerPosition } from '@/lib/types';

// POST /api/fingerprint/enrollments — fingerprint enrollment plus portable face-template backup.
// GET  /api/fingerprint/enrollments — enrollment/restore lookup.  Omitting biometricType
// remains the original fingerprint-only contract for deployed terminals.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FINGER_POSITIONS: FingerPosition[] = [
  'RIGHT_THUMB', 'RIGHT_INDEX', 'RIGHT_MIDDLE', 'RIGHT_RING', 'RIGHT_LITTLE',
  'LEFT_THUMB', 'LEFT_INDEX', 'LEFT_MIDDLE', 'LEFT_RING', 'LEFT_LITTLE',
];

interface FingerprintTemplateIn { templateRecordId: unknown; templateSlot: unknown }
interface FaceTemplateIn { templateSlot: unknown; templateDataBase64: unknown }

type BiometricType = 'FINGERPRINT' | 'FACE';

function biometricTypeOf(value: unknown): BiometricType {
  // Backwards compatibility: every pre-face terminal omitted this field.
  if (value == null || value === '') return 'FINGERPRINT';
  if (value === 'FINGERPRINT' || value === 'FACE') return value;
  throw new FpaError(FPA.INVALID_ENROLLMENT, 400, 'biometricType must be FINGERPRINT or FACE.');
}

function faceEnrollmentDocId(epf: string, deviceId: string): string {
  // A stable employee/device key makes face re-registration an overwrite, never 3 → 6 → 9.
  return `face_${encodeURIComponent(epf)}_${encodeURIComponent(deviceId)}`;
}

function base64Feature(value: unknown): string {
  if (typeof value !== 'string' || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new FpaError(FPA.INVALID_TEMPLATE_SET, 400, 'templateDataBase64 must be a non-empty standard Base64 string.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length) throw new FpaError(FPA.INVALID_TEMPLATE_SET, 400, 'templateDataBase64 must decode to non-empty bytes.');
  // A feature payload is expected, never a camera image. Reject common image signatures.
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  const isGif = bytes.length >= 6 && /GIF87a|GIF89a/.test(bytes.subarray(0, 6).toString());
  const isBmp = bytes.length >= 2 && bytes.subarray(0, 2).toString() === 'BM';
  const isIsoImage = bytes.length >= 12 && bytes.subarray(4, 8).toString() === 'ftyp';
  if (isJpeg || isPng || isWebp || isGif || isBmp || isIsoImage) {
    throw new FpaError(FPA.INVALID_TEMPLATE_SET, 400, 'Raw image payloads are not accepted; send SFace feature bytes only.');
  }
  return value;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const db = adminDbFor(req);
    const device = await authenticateDevice(req, db, body.deviceId);

    const biometricType = biometricTypeOf(body.biometricType);
    const enrollmentId = typeof body.enrollmentId === 'string' ? body.enrollmentId.trim() : '';
    if (!enrollmentId) throw new FpaError(FPA.INVALID_ENROLLMENT, 400, 'enrollmentId is required.');

    if (biometricType === 'FACE') {
      const engineId = typeof body.engineId === 'string' ? body.engineId.trim() : '';
      const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
      const modelVersion = typeof body.modelVersion === 'string' ? body.modelVersion.trim() : '';
      const templateFormat = typeof body.templateFormat === 'string' ? body.templateFormat.trim() : '';
      if (!engineId) throw new FpaError(FPA.INVALID_ENROLLMENT, 400, 'engineId is required for FACE.');
      if (modelId !== 'face_recognition_sface') throw new FpaError(FPA.INVALID_ENROLLMENT, 400, 'modelId must be face_recognition_sface for FACE.');
      if (modelVersion !== '2021dec') throw new FpaError(FPA.INVALID_ENROLLMENT, 400, 'modelVersion must be 2021dec for FACE.');
      if (templateFormat !== 'sface-f32le-v1') throw new FpaError(FPA.INVALID_ENROLLMENT, 400, 'templateFormat must be sface-f32le-v1 for FACE.');

      const templates = Array.isArray(body.templates) ? body.templates as FaceTemplateIn[] : [];
      if (templates.length !== 3) throw new FpaError(FPA.INVALID_TEMPLATE_SET, 400, 'Exactly 3 face templates are required.');
      const slots = templates.map(t => t.templateSlot).sort();
      if (JSON.stringify(slots) !== JSON.stringify([1, 2, 3])) {
        throw new FpaError(FPA.INVALID_TEMPLATE_SET, 400, 'FACE templateSlot values must be exactly 1,2,3.');
      }
      const featureBySlot = new Map(templates.map(t => [t.templateSlot as number, base64Feature(t.templateDataBase64)]));

      const { ref: userRef, data: user, employeeId } = await loadAndValidateUser(db, body.userId, body.employeeId);
      const epf = String(user.epf_number);
      const enrollmentRef = db.collection('fingerprint_enrollments').doc(faceEnrollmentDocId(epf, device.id));
      const existing = await enrollmentRef.get();
      const sameEnrollment = existing.exists && (existing.data() as DocumentData).enrollment_id === enrollmentId;
      const now = FieldValue.serverTimestamp();
      const batch = db.batch();
      batch.set(enrollmentRef, {
        id: enrollmentRef.id,
        enrollment_id: enrollmentId,
        biometric_type: 'FACE',
        epf_number: epf,
        employee_id: employeeId,
        device_id: device.id,
        template_count: 3,
        engine_id: engineId,
        model_id: modelId,
        model_version: modelVersion,
        template_format: templateFormat,
        active: true,
        enrolled_at_device: body.enrolledAtDevice ?? null,
        created_at: existing.exists ? (existing.data() as DocumentData).created_at ?? now : now,
        updated_at: now,
      });
      [1, 2, 3].forEach(templateSlot => {
        const templateRef = enrollmentRef.collection('templates').doc(String(templateSlot));
        batch.set(templateRef, {
          id: templateRef.id, enrollment_id: enrollmentId, epf_number: epf, device_id: device.id,
          biometric_type: 'FACE', template_slot: templateSlot,
          template_data_base64: featureBySlot.get(templateSlot),
          created_at_device: body.enrolledAtDevice ?? null, created_at: Timestamp.now(),
        });
      });
      batch.set(userRef, {
        face_enrolled: true, face_enrollment_id: enrollmentId, face_updated_at: now, updated_at: now,
      }, { merge: true });
      await batch.commit();
      return NextResponse.json({
        success: true, enrollmentId, userId: epf,
        status: sameEnrollment ? 'ALREADY_RECORDED' : 'RECORDED', biometricType: 'FACE', templateCount: 3,
        serverTimestamp: new Date().toISOString(),
      });
    }

    const fingerPosition = body.fingerPosition as string;
    if (!FINGER_POSITIONS.includes(fingerPosition as FingerPosition)) {
      throw new FpaError(FPA.INVALID_ENROLLMENT, 400, `Unsupported fingerPosition: ${fingerPosition}`);
    }

    const templates = Array.isArray(body.templates) ? (body.templates as FingerprintTemplateIn[]) : [];
    if (templates.length !== 5) {
      throw new FpaError(FPA.INVALID_TEMPLATE_SET, 400, 'Exactly 5 templates are required.');
    }
    const slots = templates.map((t) => t.templateSlot).sort();
    if (JSON.stringify(slots) !== JSON.stringify([1, 2, 3, 4, 5])) {
      throw new FpaError(FPA.INVALID_TEMPLATE_SET, 400, 'templateSlot values must be exactly 1,2,3,4,5.');
    }
    const recordIds = templates.map((t) => (typeof t.templateRecordId === 'string' ? t.templateRecordId.trim() : ''));
    if (recordIds.some((id) => !id) || new Set(recordIds).size !== 5) {
      throw new FpaError(FPA.INVALID_TEMPLATE_SET, 400, 'templateRecordId values must be 5 unique, non-empty UUIDs.');
    }
    // RAW/BMP image payload guard — this contract never accepts image bytes at all (V1
    // metadata-only decision), so reject outright if a caller tries to smuggle one in.
    if (templates.some((t) => 'templateDataBase64' in (t as object)) || 'templateDataBase64' in body) {
      throw new FpaError(FPA.INVALID_TEMPLATE_SET, 400, 'Central template backup is not enabled on this server; do not send template bytes.');
    }

    const { ref: userRef, data: user, employeeId } = await loadAndValidateUser(db, body.userId, body.employeeId);
    const epf = String(user.epf_number);

    const enrollmentRef = db.collection('fingerprint_enrollments').doc(enrollmentId);
    const existing = await enrollmentRef.get();
    if (existing.exists) {
      const e = existing.data() as DocumentData;
      const same = e.epf_number === epf && e.device_id === device.id && e.finger_position === fingerPosition;
      if (same) {
        return NextResponse.json({
          success: true, enrollmentId, userId: epf, status: 'ALREADY_RECORDED',
          templateCount: 5, serverTimestamp: new Date().toISOString(),
        });
      }
      throw new FpaError(FPA.ENROLLMENT_CONFLICT, 409, 'enrollmentId already exists with different enrollment data.');
    }

    const now = FieldValue.serverTimestamp();
    const batch = db.batch();
    batch.set(enrollmentRef, {
      id: enrollmentId,
      biometric_type: 'FINGERPRINT',
      epf_number: epf,
      employee_id: employeeId,
      device_id: device.id,
      finger_position: fingerPosition,
      template_count: 5,
      matcher_engine: body.matcherEngine ?? null,
      matcher_implementation_version: body.matcherImplementationVersion ?? null,
      template_format: body.templateFormat ?? null,
      template_format_version: body.templateFormatVersion ?? null,
      active: true,
      enrolled_at_device: body.enrolledAtDevice ?? null,
      created_at: now,
      updated_at: now,
    });
    templates.forEach((t) => {
      const templateRef = enrollmentRef.collection('templates').doc(String(t.templateRecordId).trim());
      batch.set(templateRef, {
        id: String(t.templateRecordId).trim(),
        enrollment_id: enrollmentId,
        epf_number: epf,
        device_id: device.id,
        finger_position: fingerPosition,
        template_slot: t.templateSlot,
        created_at_device: body.enrolledAtDevice ?? null,
        created_at: Timestamp.now(), // top-level field on its own doc — sentinel is fine here,
      });                            // kept concrete anyway for consistency with the array rule above.
    });
    batch.set(userRef, {
      fingerprint_enrolled: true,
      fingerprint_enrollment_id: enrollmentId,
      fingerprint_updated_at: now,
      updated_at: now,
    }, { merge: true });

    await batch.commit();

    return NextResponse.json({
      success: true, enrollmentId, userId: epf, status: 'RECORDED',
      templateCount: 5, serverTimestamp: new Date().toISOString(),
    });
  } catch (e) {
    return fpaErrorResponse(e);
  }
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const deviceId = url.searchParams.get('deviceId');
    const userId = url.searchParams.get('userId');
    const enrollmentId = url.searchParams.get('enrollmentId');
    const biometricType = biometricTypeOf(url.searchParams.get('biometricType'));

    const db = adminDbFor(req);
    await authenticateDevice(req, db, deviceId);

    let enrollmentSnap: FirebaseFirestore.DocumentSnapshot;
    if (biometricType === 'FACE') {
      if (!userId) throw new FpaError(FPA.INVALID_ENROLLMENT, 400, 'userId is required for FACE restore.');
      const { data: user } = await loadAndValidateUser(db, userId, null);
      enrollmentSnap = await db.collection('fingerprint_enrollments').doc(faceEnrollmentDocId(String(user.epf_number), String(deviceId))).get();
      if (!enrollmentSnap.exists || (enrollmentSnap.data() as DocumentData).active === false) return NextResponse.json({ enrollment: null });
      const e = enrollmentSnap.data() as DocumentData;
      const templatesSnap = await enrollmentSnap.ref.collection('templates').orderBy('template_slot').get();
      return NextResponse.json({
        enrollment: {
          enrollmentId: e.enrollment_id, userId: e.epf_number, employeeId: e.employee_id, biometricType: 'FACE',
          engineId: e.engine_id, modelId: e.model_id, modelVersion: e.model_version,
          templateFormat: e.template_format,
          templates: templatesSnap.docs.map(d => ({
            templateSlot: (d.data() as DocumentData).template_slot,
            templateDataBase64: (d.data() as DocumentData).template_data_base64,
          })),
        },
      });
    }

    if (enrollmentId) {
      enrollmentSnap = await db.collection('fingerprint_enrollments').doc(enrollmentId).get();
      if (!enrollmentSnap.exists) return NextResponse.json({ enrollment: null });
    } else {
      if (!userId) throw new FpaError(FPA.INVALID_ENROLLMENT, 400, 'userId or enrollmentId is required.');
      const { data: user } = await loadAndValidateUser(db, userId, null);
      // Equality-only query (single field) — no composite index needed; filter `active`
      // in memory (same convention as attendanceService.getMonthlyAttendance).
      const snap = await db.collection('fingerprint_enrollments').where('epf_number', '==', user.epf_number).get();
      // Old fingerprint documents have no biometric_type; FACE documents are explicitly
      // marked and must never be returned to an unchanged fingerprint client.
      const active = snap.docs.find((d) => {
        const data = d.data() as DocumentData;
        return data.active !== false && data.biometric_type !== 'FACE';
      });
      if (!active) return NextResponse.json({ enrollment: null });
      enrollmentSnap = active;
    }

    const e = enrollmentSnap.data() as DocumentData;
    const templatesSnap = await enrollmentSnap.ref.collection('templates').get();
    return NextResponse.json({
      enrollment: {
        enrollmentId: e.id,
        userId: e.epf_number,
        employeeId: e.employee_id,
        fingerPosition: e.finger_position,
        matcherEngine: e.matcher_engine,
        matcherImplementationVersion: e.matcher_implementation_version,
        templateFormat: e.template_format,
        templateFormatVersion: e.template_format_version,
        // No templateDataBase64 — central template backup is not enabled (see file header).
        templates: templatesSnap.docs.map((d) => ({
          templateRecordId: d.id,
          templateSlot: (d.data() as DocumentData).template_slot,
        })),
      },
    });
  } catch (e) {
    return fpaErrorResponse(e);
  }
}
