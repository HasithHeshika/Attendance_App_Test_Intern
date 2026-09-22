// Biometric-type + declared-action parsing shared by the fingerprint-terminal attendance API
// (src/lib/fingerprintApi.ts). Pulled out of fingerprintApi.ts so the wire-value parsing has
// its own unit tests independent of the Admin-SDK transaction logic.
//
// Terminals were fingerprint-only originally; FACE (portable SFace, see the enrollment endpoint
// in src/app/api/fingerprint/enrollments/route.ts) is now a first-class biometric type on the
// SAME attendance-recording flow. `biometricType` is optional on the wire — an old terminal
// build that never sends it keeps meaning FINGERPRINT, exactly as before.
export type AttendanceBiometricType = 'FINGERPRINT' | 'FACE';
export type AttendanceAction = 'CHECK_IN' | 'CHECK_OUT';

export type AttendanceBiometricPersistence = {
  method: 'fingerprint' | 'face';
  explicitSource: 'fingerprint_explicit' | 'face_explicit';
  approvalBy: 'FINGERPRINT' | 'FACE';
  reviewSource: 'fingerprint' | 'face';
};

// null means an invalid wire value was sent — the caller should REJECT the event rather than
// silently fall back, since that would misattribute the scan to the wrong sensor.
export function biometricTypeOf(
    value: unknown
): AttendanceBiometricType | null {
  if (value == null) return 'FINGERPRINT';

  return value === 'FINGERPRINT' || value === 'FACE'
      ? value
      : null;
}

// null with a non-null input means an invalid wire value — the caller should REJECT rather than
// silently drop back to inferred-direction mode, since the terminal declared 2-button UI intent.
export function actionOf(
    value: unknown
): AttendanceAction | null {
  if (value == null) return null;

  return value === 'CHECK_IN' || value === 'CHECK_OUT'
      ? value
      : null;
}

export function attendanceBiometricPersistence(
    type: AttendanceBiometricType
): AttendanceBiometricPersistence {
  return type === 'FACE'
      ? {
        method: 'face',
        explicitSource: 'face_explicit',
        approvalBy: 'FACE',
        reviewSource: 'face',
      }
      : {
        method: 'fingerprint',
        explicitSource: 'fingerprint_explicit',
        approvalBy: 'FINGERPRINT',
        reviewSource: 'fingerprint',
      };
}
