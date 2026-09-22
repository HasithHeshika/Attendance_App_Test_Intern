import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionOf, attendanceBiometricPersistence, biometricTypeOf } from '../attendanceBiometric';

test('omitted biometric type defaults to fingerprint persistence', () => {
  const type = biometricTypeOf(undefined);
  assert.equal(type, 'FINGERPRINT');
  assert.deepEqual(attendanceBiometricPersistence(type!), {
    method: 'fingerprint', explicitSource: 'fingerprint_explicit', approvalBy: 'FINGERPRINT', reviewSource: 'fingerprint',
  });
});

test('FACE explicit check-in and check-out retain their declared direction and face persistence', () => {
  const face = attendanceBiometricPersistence(biometricTypeOf('FACE')!);
  assert.equal(actionOf('CHECK_IN'), 'CHECK_IN');
  assert.equal(actionOf('CHECK_OUT'), 'CHECK_OUT');
  assert.deepEqual(face, { method: 'face', explicitSource: 'face_explicit', approvalBy: 'FACE', reviewSource: 'face' });
});

test('omitted action remains inferred and invalid wire values are rejected', () => {
  assert.equal(actionOf(undefined), null);
  assert.equal(biometricTypeOf('RETINA'), null);
  assert.equal(actionOf('CHECKIN'), null);
  assert.equal(actionOf('CHECK_OUT '), null);
});
