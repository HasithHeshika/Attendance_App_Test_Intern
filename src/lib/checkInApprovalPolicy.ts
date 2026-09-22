// Pure check-in approval policy: may the SYSTEM approve a self-service (mobile) check-in on
// the spot, or does it need a person?
//
// Kept free of firebase — and of the tenant object itself — so the rule can be unit-tested.
// An approval rule that wrongly says "approved" silently removes a control; one that wrongly
// says "needs approval" buries the approvals page in rows nobody expected. Neither is visible
// in a diff, which is why this lives here rather than inline in apiCompat's checkIn.
//
// The CHECK-OUT is deliberately not part of this and always needs approval, on every tenant:
// it is the half that settles the working place, the hours, the outstation flag and the
// allowances, none of which a geofence can vouch for.

export interface CheckInApprovalInput {
  /** Does this employee's ROLE require approval at all? False for top management, and for any
   *  role with no approver tier above it — they self-approve today and must keep doing so. */
  roleNeedsApproval: boolean;
  /** TenantFeatures.autoApproveInRangeCheckIn — off everywhere but the tenants that asked. */
  autoApproveInRange: boolean;
  /** Was the check-in GPS inside a configured working place's OWN radius? `null` means the
   *  question could not be answered at all (no GPS fix, or no place has coordinates), which is
   *  NOT the same as "outside" — but it is treated the same way here, see below. */
  withinPlaceRadius: boolean | null;
}

/**
 * True when the check-in must go to an approver, false when the system may approve it.
 *
 * Only ever RELAXES the existing role rule; it can never make an approval newly required, so
 * turning the flag on cannot strand anyone who self-approves today.
 */
export function checkInNeedsApproval(input: CheckInApprovalInput): boolean {
  if (!input.roleNeedsApproval) return false;
  if (!input.autoApproveInRange) return true;
  // `true` alone auto-approves. `false` (outside every radius) and `null` (unanswerable) both
  // go to a person — an unknown location is precisely the case an approver exists for, and
  // treating it as "in range" would turn a denied location permission into a free pass.
  return input.withinPlaceRadius !== true;
}
