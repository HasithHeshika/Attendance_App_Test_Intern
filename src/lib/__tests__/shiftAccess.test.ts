import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOD_ELIGIBLE_ROLE, shiftIsRestricted, shiftIsGlobal, isEffectiveHod, canUserAccessShift, accessibleShifts,
  isRecurringDayOffEligible,
} from '../shiftAccess';

// Minimal stand-ins — canUserAccessShift only touches these fields.
const user = (o: Partial<Parameters<typeof canUserAccessShift>[0] & object> = {}) => ({
  epf_number: 'E000', role: 'Staff', hod_department_ids: [] as string[], ...o,
}) as Parameters<typeof canUserAccessShift>[0];

const OPEN = {};
const HOD_SHIFT = { eligible_roles: [HOD_ELIGIBLE_ROLE], eligible_user_epfs: ['E100', 'E200', 'E300'] };

test('shiftIsRestricted: false when both fields are absent or empty', () => {
  assert.equal(shiftIsRestricted({}), false);
  assert.equal(shiftIsRestricted({ eligible_roles: [], eligible_user_epfs: [] }), false);
  assert.equal(shiftIsRestricted({ eligible_roles: [HOD_ELIGIBLE_ROLE] }), true);
  assert.equal(shiftIsRestricted({ eligible_user_epfs: ['E100'] }), true);
});

test('shiftIsGlobal: true only for a restricted shift with no departments', () => {
  assert.equal(shiftIsGlobal({ eligible_roles: [HOD_ELIGIBLE_ROLE] }), true);
  assert.equal(shiftIsGlobal({ eligible_user_epfs: ['E1'], department_ids: [] }), true);
  // restricted but department-scoped -> not global
  assert.equal(shiftIsGlobal({ eligible_roles: [HOD_ELIGIBLE_ROLE], department_ids: ['d1'] }), false);
  // legacy single-department field still counts as "has departments"
  assert.equal(shiftIsGlobal({ eligible_user_epfs: ['E1'], department_id: 'd1' }), false);
  // not restricted -> never global, regardless of departments
  assert.equal(shiftIsGlobal({ department_ids: [] }), false);
});

test('isEffectiveHod: a managed department or the legacy flag counts; a bare role does not', () => {
  assert.equal(isEffectiveHod({ hod_department_ids: ['d1'] }), true);
  assert.equal(isEffectiveHod({ is_head_of_department: true }), true);
  assert.equal(isEffectiveHod({ hod_department_ids: [] }), false);
  assert.equal(isEffectiveHod({}), false);
});

test('an unrestricted shift is open to anyone, including a null user', () => {
  assert.equal(canUserAccessShift(user(), OPEN), true);
  assert.equal(canUserAccessShift(null, OPEN), true);
});

test('a restricted shift denies regular staff', () => {
  assert.equal(canUserAccessShift(user(), HOD_SHIFT), false);
  assert.equal(canUserAccessShift(null, HOD_SHIFT), false);
});

test('a restricted shift allows an effective HOD when the HOD token is listed', () => {
  assert.equal(canUserAccessShift(user({ hod_department_ids: ['d1'] }), HOD_SHIFT), true);
  assert.equal(canUserAccessShift(user({ is_head_of_department: true }), HOD_SHIFT), true);
  // token not listed -> HOD status alone is not enough
  assert.equal(canUserAccessShift(user({ hod_department_ids: ['d1'] }), { eligible_user_epfs: ['E100'] }), false);
});

test('a restricted shift allows an explicitly listed EPF (the exec case)', () => {
  assert.equal(canUserAccessShift(user({ epf_number: 'E200' }), HOD_SHIFT), true);
  assert.equal(canUserAccessShift(user({ epf_number: 'E999' }), HOD_SHIFT), false);
});

test('eligible_roles also matches a plain role name verbatim', () => {
  assert.equal(canUserAccessShift(user({ role: 'Executive' }), { eligible_roles: ['Executive'] }), true);
  assert.equal(canUserAccessShift(user({ role: 'Staff' }), { eligible_roles: ['Executive'] }), false);
});

test('isRecurringDayOffEligible: effective HOD OR a restricted-shift exec EPF; plain staff no', () => {
  const restricted = [{ eligible_user_epfs: ['E100', 'E200'] }, {}];
  assert.equal(isRecurringDayOffEligible(user({ epf_number: 'E1', hod_department_ids: ['d1'] }), restricted), true);  // HOD
  assert.equal(isRecurringDayOffEligible(user({ epf_number: 'E200' }), restricted), true);                            // exec EPF
  assert.equal(isRecurringDayOffEligible(user({ epf_number: 'E1' }), restricted), false);                            // plain staff
  assert.equal(isRecurringDayOffEligible(user({ epf_number: 'E200' }), []), false);                                  // no restricted shifts
  assert.equal(isRecurringDayOffEligible(null, restricted), false);
});

test('accessibleShifts filters a mixed list', () => {
  const shifts = [
    { id: 'a', ...OPEN },
    { id: 'b', ...HOD_SHIFT },
    { id: 'c', eligible_user_epfs: ['E200'] },
  ];
  assert.deepEqual(accessibleShifts(user({ epf_number: 'E200' }), shifts).map((s) => s.id), ['a', 'b', 'c']);
  assert.deepEqual(accessibleShifts(user({ epf_number: 'E1' }), shifts).map((s) => s.id), ['a']);
});
