import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkInNeedsApproval } from '../checkInApprovalPolicy';

// Defaults for the tenants that have NOT asked for this: an ordinary employee, flag off.
const base = { roleNeedsApproval: true, autoApproveInRange: false, withinPlaceRadius: null } as const;

test('flag off: every tenant keeps the role rule exactly as it was', () => {
  assert.equal(checkInNeedsApproval({ ...base, withinPlaceRadius: true }), true);
  assert.equal(checkInNeedsApproval({ ...base, withinPlaceRadius: false }), true);
  assert.equal(checkInNeedsApproval({ ...base, withinPlaceRadius: null }), true);
});

test('flag on: inside a working place radius is approved by the system', () => {
  assert.equal(checkInNeedsApproval({ ...base, autoApproveInRange: true, withinPlaceRadius: true }), false);
});

test('flag on: outside every radius still needs an approver', () => {
  assert.equal(checkInNeedsApproval({ ...base, autoApproveInRange: true, withinPlaceRadius: false }), true);
});

test('flag on: an unanswerable location needs an approver, never a free pass', () => {
  // No GPS fix, or no place has coordinates yet. Auto-approving here would mean a denied
  // location permission approves its own check-in.
  assert.equal(checkInNeedsApproval({ ...base, autoApproveInRange: true, withinPlaceRadius: null }), true);
});

test('a role that self-approves today is unaffected in every combination', () => {
  for (const autoApproveInRange of [false, true]) {
    for (const withinPlaceRadius of [true, false, null]) {
      assert.equal(
        checkInNeedsApproval({ roleNeedsApproval: false, autoApproveInRange, withinPlaceRadius }),
        false,
      );
    }
  }
});

test('the rule only ever relaxes — turning the flag on never adds an approval', () => {
  for (const roleNeedsApproval of [true, false]) {
    for (const withinPlaceRadius of [true, false, null]) {
      const off = checkInNeedsApproval({ roleNeedsApproval, autoApproveInRange: false, withinPlaceRadius });
      const on  = checkInNeedsApproval({ roleNeedsApproval, autoApproveInRange: true,  withinPlaceRadius });
      assert.ok(!(on && !off), `flag turned a free check-in into a pending one (${roleNeedsApproval}/${withinPlaceRadius})`);
    }
  }
});
