import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  placeKeysOf, sessionAtPlace, shiftRouteVisibility, pastSubmissionNeedsApproval, backlogStartFor,
} from '../approvalRouting';

const RANNA = { id: 'p_ranna', name: 'Ranna 2MW', tags: ['shift'], supervisor_epfs: ['SUP-1', 'LOC-1'] };
const YARD  = { id: 'p_yard',  name: 'Main Yard', tags: [],        supervisor_epfs: ['LOC-2'] };
const PLACES = [RANNA, YARD];

test('placeKeysOf: id + canonical name of every place the predicate accepts', () => {
  const shift = placeKeysOf(PLACES, p => p.tags.includes('shift'));
  assert.deepEqual([...shift.ids], ['p_ranna']);
  assert.deepEqual([...shift.names], ['ranna 2mw']);
  const mine = placeKeysOf(PLACES, p => p.supervisor_epfs.includes('LOC-1'));
  assert.deepEqual([...mine.ids], ['p_ranna']);
  assert.equal(placeKeysOf(PLACES, () => false).ids.size, 0);
});

test('sessionAtPlace: matches by site id, by site name, or by recorded place name (Solar "(#site)" suffix ignored)', () => {
  const keys = placeKeysOf(PLACES, p => p.tags.includes('shift'));
  assert.equal(sessionAtPlace({ check_in_site_id: 'p_ranna' }, keys), true);
  assert.equal(sessionAtPlace({ check_in_site_name: 'RANNA 2MW' }, keys), true);
  // A past submission carries no site id — only the recorded working place.
  assert.equal(sessionAtPlace({ working_place: 'Ranna 2MW (#GM-0001)' }, keys), true);
  assert.equal(sessionAtPlace({ check_in_site_id: 'p_yard', working_place: 'Main Yard' }, keys), false);
  assert.equal(sessionAtPlace(null, keys), false);
});

test('shiftRouteVisibility: null when the rule does not apply', () => {
  assert.equal(shiftRouteVisibility(false, 'SUP-1', 'LOC-1', false, true), null);
  // No assigned supervisor → normal routing decides, so the record never becomes un-approvable.
  assert.equal(shiftRouteVisibility(true, null, 'LOC-1', false, false), null);
  assert.equal(shiftRouteVisibility(true, '', 'LOC-1', false, false), null);
});

test('shiftRouteVisibility: assigned supervisor, system-wide viewers and the shift place\'s own supervisors see it', () => {
  assert.equal(shiftRouteVisibility(true, 'SUP-1', 'SUP-1', false, false), true);
  assert.equal(shiftRouteVisibility(true, 'SUP-1', 'ADMIN', true, false), true);
  // The regression: a location supervisor of the shift place was routed out entirely.
  assert.equal(shiftRouteVisibility(true, 'SUP-1', 'LOC-1', false, true), true);
  // Anyone else stays out, even a location supervisor of some OTHER place.
  assert.equal(shiftRouteVisibility(true, 'SUP-1', 'LOC-2', false, false), false);
  assert.equal(shiftRouteVisibility(true, 'SUP-1', 'EXEC-9', false, false), false);
});

test('pastSubmissionNeedsApproval: any half still pending needs an approver', () => {
  assert.equal(pastSubmissionNeedsApproval({ check_in_status: 'pending', check_out: 1, check_out_status: 'pending' }), true);
  // Migrated data may lack the status field entirely.
  assert.equal(pastSubmissionNeedsApproval({ check_out: 1 }), true);
  // The regression: check-in already approved, check-out still pending — was skipped by every pass.
  assert.equal(pastSubmissionNeedsApproval({ check_in_status: 'approved', check_in_approved_by: 'SUP-1', check_out: 1, check_out_status: 'pending' }), true);
  assert.equal(pastSubmissionNeedsApproval({ check_in_status: 'approved', check_in_approved_by: 'SUP-1', check_out: 1, check_out_status: 'approved' }), false);
  // No check-out yet → nothing to approve on that half.
  assert.equal(pastSubmissionNeedsApproval({ check_in_status: 'approved', check_in_approved_by: 'SUP-1', check_out: null, check_out_status: 'pending' }), false);
  assert.equal(pastSubmissionNeedsApproval({ check_in_status: 'rejected', check_in_approved_by: null, check_out: 1, check_out_status: 'rejected' }), false);
});

test('backlogStartFor: first day of the month N months before today', () => {
  assert.equal(backlogStartFor('2026-09-05', 1), '2026-08-01');
  assert.equal(backlogStartFor('2026-01-15', 1), '2025-12-01');
  assert.equal(backlogStartFor('2026-09-05', 3), '2026-06-01');
  assert.equal(backlogStartFor('2026-02-10', 14), '2024-12-01');
  // Never less than one month back — the live list only covers today/yesterday.
  assert.equal(backlogStartFor('2026-09-05', 0), '2026-08-01');
});
