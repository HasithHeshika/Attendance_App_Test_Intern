import { isValidLatLng } from '@/lib/geo';

export type ApprovalIssue = {
  kind: 'outsideRadius' | 'outstation' | 'missingGps';
  severity: 'warn' | 'error';
  distanceKm?: number;
};

type RecordLike = {
  check_in_lat?: number | null; check_in_lng?: number | null;
  check_out_lat?: number | null; check_out_lng?: number | null;
  check_out_within_radius?: boolean | null;
  is_outstation?: boolean | null;
  outstation_ref_distance_m?: number | null;
};

function hasCoords(lat?: number | null, lng?: number | null): boolean {
  return typeof lat === 'number' && typeof lng === 'number' && isValidLatLng(lat, lng);
}

export function getRecordIssues(r: RecordLike): ApprovalIssue[] {
  const issues: ApprovalIssue[] = [];
  if (r.check_out_within_radius === false) issues.push({ kind: 'outsideRadius', severity: 'warn' });
  if (r.is_outstation === true) {
    const km = typeof r.outstation_ref_distance_m === 'number' ? r.outstation_ref_distance_m / 1000 : undefined;
    issues.push({ kind: 'outstation', severity: 'warn', ...(km != null ? { distanceKm: Math.round(km * 10) / 10 } : {}) });
  }
  const inGps = hasCoords(r.check_in_lat, r.check_in_lng);
  const outGps = hasCoords(r.check_out_lat, r.check_out_lng);
  if (!inGps && !outGps) issues.push({ kind: 'missingGps', severity: 'error' });
  return issues;
}
