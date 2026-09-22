// Pure approval-routing helpers shared by every attendance approval surface in
// src/services/apiCompat.ts (live list, pick rows, past/backlog list). Kept free of firebase
// so the rules can be unit-tested — a routing rule that quietly hides a session from every
// approver leaves it 'pending' forever, which is exactly what these tests guard against.
import { canonPlaceName } from './placeName';

// Working-place keys: doc ids plus CANONICAL names, so a session recorded with the Solar-app
// "<name> (#site-no)" form still matches the bare admin place name.
export interface PlaceKeys { ids: Set<string>; names: Set<string> }

export function placeKeysOf<P extends { id?: unknown; name?: unknown }>(
  places: readonly P[], accept: (p: P) => boolean,
): PlaceKeys {
  const ids = new Set<string>(), names = new Set<string>();
  for (const p of places) {
    if (!accept(p)) continue;
    if (p.id)   ids.add(String(p.id));
    if (p.name) names.add(canonPlaceName(p.name));
  }
  return { ids, names };
}

// Is this session at one of the keyed places? Matches the GPS-matched check-in site (id or
// name) or the recorded working place — past submissions carry no site id at all.
export function sessionAtPlace(
  s: { check_in_site_id?: unknown; check_in_site_name?: unknown; working_place?: unknown } | null | undefined,
  keys: PlaceKeys,
): boolean {
  if (!s) return false;
  return (!!s.check_in_site_id   && keys.ids.has(String(s.check_in_site_id)))
      || (!!s.check_in_site_name && keys.names.has(canonPlaceName(s.check_in_site_name)))
      || (!!s.working_place      && keys.names.has(canonPlaceName(s.working_place)));
}

// Visibility of a session at a 'shift'-tagged place. It routes to the employee's assigned
// supervisor, to system-wide viewers (management / top of tree) AND to the location
// supervisors of that shift place — a place's own supervisor list is the most specific
// routing there is, and before this it was silently overridden by the shift rule, so an
// Executive listed as the place's supervisor could never see (let alone approve) a single
// shift session there. Returns null when the rule does not apply (not a shift place, or the
// employee has no assigned supervisor) so the caller keeps its normal routing and the record
// can never become un-approvable.
export function shiftRouteVisibility(
  isShift: boolean,
  empSupervisor: unknown,
  viewerEpf: string,
  systemWide: boolean,
  viewerSupervisesPlace: boolean,
): boolean | null {
  if (!isShift) return null;
  const sup = String(empSupervisor ?? '');
  if (!sup) return null;
  return systemWide || sup === String(viewerEpf) || viewerSupervisesPlace;
}

// Does a back-dated (past) submission still need an approver? Either half may be the one
// left pending: the check-in (never approved, or a migrated record with no status at all) or
// a submitted check-out. A past submission whose check-in was approved but whose check-out
// stayed 'pending' used to satisfy neither the past pass (check-in only) nor the backlog
// pass (which skips past submissions) — invisible to every approver.
export function pastSubmissionNeedsApproval(s: {
  check_in_status?: unknown; check_in_approved_by?: unknown;
  check_out?: unknown; check_out_status?: unknown;
}): boolean {
  const checkInPending  = !s.check_in_approved_by && (s.check_in_status === 'pending' || !s.check_in_status);
  const checkOutPending = !!s.check_out && s.check_out_status === 'pending';
  return checkInPending || checkOutPending;
}

// First day of the month `monthsBack` months before `todayStr` (YYYY-MM-DD). The backlog
// query is bounded by date because Firestore cannot filter on a nested session status; the
// approvals page starts at one month back and lets an approver widen it on demand.
export function backlogStartFor(todayStr: string, monthsBack: number): string {
  const [y, m] = todayStr.split('-').map(Number);
  const back = Math.max(1, Math.floor(monthsBack));
  // Zero-based month arithmetic, then normalise the year.
  const idx  = (m - 1) - back;
  const year = y + Math.floor(idx / 12);
  const mon  = ((idx % 12) + 12) % 12 + 1;
  return `${year}-${String(mon).padStart(2, '0')}-01`;
}
