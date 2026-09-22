'use client';

import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CheckCircle, X, Loader2, MessageSquare, MapPin,
  ArrowRight, Calendar, Clock, Plane, ChevronRight, ShieldCheck, Moon,
  ExternalLink, Navigation, Compass, AlertCircle,
} from 'lucide-react';
import { formatTime } from '@/lib/utils';
import Portal from '@/components/Portal';
import SessionLocations from '@/components/SessionLocations';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MotionCard } from '@/components/ui/motion';
import type { MapMarker } from '@/components/LeafletMiniMap';

const LeafletMiniMap = dynamic(() => import('@/components/LeafletMiniMap'), {
  ssr: false,
  loading: () => <div className="h-[200px] w-full animate-pulse rounded-xl bg-muted/60" />,
});

export interface EditRequestData {
  id: number | string;
  attendance_id: number | string;
  epf_number: string;
  name: string;
  reason: string;
  created_at: string;
  group?: string;
  role?: string;
  user_type?: string;
  session_no?: number;
  session_count?: number;
  current: {
    check_in?: string | null;
    check_out?: string | null;
    check_in_lat?: number | null;
    check_in_lng?: number | null;
    check_out_lat?: number | null;
    check_out_lng?: number | null;
    working_place?: string | null;
    site_number?: string | null;
    is_outstation?: boolean | null;
    outstation_name?: string | null;
    outstation_address?: string | null;
    // Full multi-location history of the targeted session.
    locations?: { name: string; site_number?: string | null }[];
    // Display names of whoever approved the existing check-in / check-out.
    check_in_approved_by_name?: string | null;
    check_out_approved_by_name?: string | null;
  };
  requested: {
    check_in?: string | null;
    check_out?: string | null;
    check_in_lat?: number | null;
    check_in_lng?: number | null;
    working_place?: string | null;
    site_number?: string | null;
    is_outstation?: boolean | null;
    outstation_name?: string | null;
    outstation_address?: string | null;
  };
}

function groupOf(req: EditRequestData) {
  return req.group ?? req.role ?? req.user_type ?? 'Executive';
}

function changed(a: unknown, b: unknown) {
  return (a ?? '') !== (b ?? '');
}

// Check-out landing on a later calendar date than check-in → shift/overnight session.
function overnightBadgeDate(checkIn?: string | null, checkOut?: string | null): string | null {
  if (!checkIn || !checkOut) return null;
  const inDate = String(checkIn).slice(0, 10);
  const outDate = String(checkOut).slice(0, 10);
  if (outDate <= inDate) return null;
  const [y, m, d] = outDate.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function calcDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

// ─── Compact list row ───────────────────────────────────────────────────────
export function EditRequestRow({ req, onClick }: { req: EditRequestData; onClick: () => void }) {
  const group = groupOf(req);
  const isTech = group === 'Technician';
  const attendanceDate = String(req.attendance_id ?? '').split('_')[1] ?? '';

  return (
    <MotionCard className="rounded-xl">
      <button
        onClick={onClick}
        className="w-full bg-card rounded-xl border border-border hover:border-primary/40 hover:bg-accent transition-all flex items-center gap-3 px-4 py-3 text-left group"
      >
        {/* Avatar */}
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold text-sm flex-shrink-0 ${
          isTech ? 'bg-primary/10 text-primary' : 'bg-brand/10 text-brand'}`}>
          {req.name?.charAt(0)?.toUpperCase() ?? '?'}
        </div>

        {/* Name + meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground truncate">{req.name}</span>
            <span className="text-[11px] text-muted-foreground flex-shrink-0">{req.epf_number}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {attendanceDate && (
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Calendar className="w-2.5 h-2.5" /> {attendanceDate}
              </span>
            )}
            {(req.session_count ?? 1) > 1 && (
              <Badge variant="brand" className="text-[10px] px-1.5 py-0.5 rounded">
                Session {req.session_no}/{req.session_count}
              </Badge>
            )}
            {req.reason && (
              <span className="text-[11px] text-muted-foreground truncate italic">· "{req.reason}"</span>
            )}
          </div>
        </div>

        <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0" />
      </button>
    </MotionCard>
  );
}

// ─── Punch Time Display Row ──────────────────────────────────────────────────
function PunchTimeRow({
  label,
  value,
  isChanged,
  shiftDate,
}: {
  label: string;
  value: string | null | undefined;
  isChanged?: boolean;
  shiftDate?: string | null;
}) {
  if (!value) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-8">{label}</span>
        <span className="text-xs font-mono text-muted-foreground italic">—</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-8">{label}</span>
      <span className={`text-sm font-bold font-mono tracking-tight ${isChanged ? 'text-primary' : 'text-foreground'}`}>
        {formatTime(value)}
      </span>
      {isChanged && (
        <span className="inline-flex items-center rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-primary">
          changed
        </span>
      )}
      {shiftDate && (
        <Badge variant="brand" className="text-[9px] px-1.5 py-0.5 rounded flex items-center gap-1">
          <Moon className="w-2.5 h-2.5" /> {shiftDate}
        </Badge>
      )}
    </div>
  );
}

// ─── Detail view ─────────────────────────────────────────────────────────────
export function EditRequestDetail({
  req,
  onClose,
  hideHeader = false,
  curCoords,
  reqCoords,
}: {
  req: EditRequestData;
  onClose?: () => void;
  hideHeader?: boolean;
  curCoords?: { lat: number; lng: number; label?: string } | null;
  reqCoords?: { lat: number; lng: number; label?: string } | null;
}) {
  const group = groupOf(req);
  const isTech = group === 'Technician';
  const createdDate = req.created_at
    ? new Date(req.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  const attendanceDate = String(req.attendance_id ?? '').split('_')[1] ?? '';

  // Check what changed
  const inChanged = changed(req.requested.check_in, req.current.check_in);
  const outChanged = changed(req.requested.check_out, req.current.check_out);
  const placeChanged = changed(req.requested.working_place, req.current.working_place) ||
    changed(req.requested.site_number, req.current.site_number);
  const outstationChanged = changed(req.requested.is_outstation, req.current.is_outstation);

  // Geographic coordinates & map setup
  const currentPunchLat = req.current?.check_in_lat;
  const currentPunchLng = req.current?.check_in_lng;
  const hasCurrentPunchGps = typeof currentPunchLat === 'number' && typeof currentPunchLng === 'number';

  const effectiveCurCoords = curCoords ?? (hasCurrentPunchGps ? { lat: currentPunchLat, lng: currentPunchLng, label: req.current.working_place ?? 'Check-in Punch' } : null);
  const hasRequestedGps = typeof req.requested?.check_in_lat === 'number' && typeof req.requested?.check_in_lng === 'number';
  const effectiveReqCoords = reqCoords ?? (hasRequestedGps ? { lat: req.requested.check_in_lat!, lng: req.requested.check_in_lng!, label: req.requested.working_place ?? 'Requested Site' } : null);

  const markers: MapMarker[] = [];
  if (effectiveCurCoords) {
    markers.push({
      lat: effectiveCurCoords.lat,
      lng: effectiveCurCoords.lng,
      label: `Current: ${effectiveCurCoords.label ?? req.current.working_place ?? 'Punch'}`,
      color: '#0284c7',
      fillColor: '#38bdf8',
    });
  }
  if (effectiveReqCoords) {
    const isSameCoord = effectiveCurCoords &&
      Math.abs(effectiveCurCoords.lat - effectiveReqCoords.lat) < 0.0001 &&
      Math.abs(effectiveCurCoords.lng - effectiveReqCoords.lng) < 0.0001;
    if (!isSameCoord) {
      markers.push({
        lat: effectiveReqCoords.lat,
        lng: effectiveReqCoords.lng,
        label: `Requested: ${effectiveReqCoords.label ?? req.requested.working_place ?? 'Site'}`,
        color: '#10b981',
        fillColor: '#34d399',
      });
    }
  }

  const hasMap = markers.length > 0;
  const distKm = markers.length >= 2 ? calcDistanceKm(markers[0].lat, markers[0].lng, markers[1].lat, markers[1].lng) : null;

  return (
    <div className="space-y-4">
      {/* Optional Standalone Header (omitted in MasterDetail where ApprovalsDetailHeader sits above) */}
      {!hideHeader && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-border bg-card">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center font-bold text-base flex-shrink-0 ${
              isTech ? 'bg-primary/10 text-primary' : 'bg-brand/10 text-brand'}`}>
              {req.name?.charAt(0)?.toUpperCase() ?? '?'}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-base font-bold text-foreground truncate">{req.name}</span>
                <Badge variant={isTech ? 'default' : 'brand'} className="text-[9px] px-1.5 py-0.5 flex-shrink-0">
                  {group}
                </Badge>
              </div>
              <div className="flex items-center gap-2.5 flex-wrap mt-0.5">
                <span className="text-[11px] text-muted-foreground font-mono">EPF: {req.epf_number}</span>
                {attendanceDate && (
                  <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                    <Calendar className="w-2.5 h-2.5" /> {attendanceDate}
                  </span>
                )}
                {createdDate && (
                  <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                    <Clock className="w-2.5 h-2.5" /> {createdDate}
                  </span>
                )}
              </div>
            </div>
          </div>
          {onClose && (
            <Button variant="ghost" size="icon-sm" onClick={onClose} className="flex-shrink-0">
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      )}

      {/* Reason Card */}
      {req.reason && (
        <div className="rounded-xl border border-border/70 bg-card/80 p-3.5 shadow-sm backdrop-blur-sm space-y-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 font-semibold text-foreground">
              <MessageSquare className="w-3.5 h-3.5 text-primary" /> Reason for Edit Request
            </span>
            {createdDate && (
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Clock className="w-3 h-3 text-muted-foreground" /> Submitted {createdDate}
              </span>
            )}
          </div>
          <div className="rounded-lg border border-border/50 bg-muted/40 px-3.5 py-2.5 text-xs italic text-foreground/90 leading-relaxed">
            "{req.reason}"
          </div>
        </div>
      )}

      {/* Visual Diff: Current vs Requested */}
      <div className="relative grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Center Transformation Indicator */}
        <div className="hidden md:flex absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10">
          <div className="w-8 h-8 rounded-full bg-card border border-primary/30 flex items-center justify-center shadow-md ring-4 ring-background">
            <ArrowRight className="w-4 h-4 text-primary" />
          </div>
        </div>

        {/* Current Record */}
        <div className="rounded-xl border border-border/70 bg-card p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" /> Current Record
            </span>
            {req.session_no && (
              <span className="text-[11px] text-muted-foreground font-medium">
                Session {req.session_no}/{req.session_count ?? 1}
              </span>
            )}
          </div>

          <div className="space-y-2">
            <PunchTimeRow label="IN" value={req.current.check_in} />
            <PunchTimeRow
              label="OUT"
              value={req.current.check_out}
              shiftDate={overnightBadgeDate(req.current.check_in, req.current.check_out)}
            />
          </div>

          {/* Verification / Previous Approvals */}
          {(req.current.check_in_approved_by_name || req.current.check_out_approved_by_name) && (
            <div className="rounded-lg border border-border/40 bg-muted/30 p-2.5 space-y-1.5 text-[11px]">
              {req.current.check_in_approved_by_name && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <ShieldCheck className="w-3.5 h-3.5 text-success shrink-0" />
                  <span>In approved by <strong className="text-foreground font-semibold">{req.current.check_in_approved_by_name}</strong></span>
                </div>
              )}
              {req.current.check_out_approved_by_name && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <ShieldCheck className="w-3.5 h-3.5 text-primary shrink-0" />
                  <span>Out approved by <strong className="text-foreground font-semibold">{req.current.check_out_approved_by_name}</strong></span>
                </div>
              )}
            </div>
          )}

          {/* Working Place */}
          {req.current.working_place && (
            <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
              <span>
                <span className="font-medium text-foreground">{req.current.working_place}</span>
                {req.current.site_number ? ` · #${req.current.site_number}` : ''}
              </span>
            </div>
          )}

          {(req.current.locations?.length ?? 0) > 1 && (
            <SessionLocations locations={req.current.locations} />
          )}

          {req.current.is_outstation && (
            <div className="rounded-lg border border-warning/25 bg-warning/[0.08] p-2.5">
              <div className="flex items-center gap-1.5 text-[10px] font-bold text-warning uppercase tracking-wide">
                <Plane className="w-3 h-3 text-warning" /> Outstation
              </div>
              {req.current.outstation_name && <div className="mt-0.5 text-xs text-foreground font-medium">{req.current.outstation_name}</div>}
              {req.current.outstation_address && <div className="text-[11px] text-muted-foreground">{req.current.outstation_address}</div>}
            </div>
          )}
        </div>

        {/* Requested Changes */}
        <div className="rounded-xl border border-primary/30 bg-primary/[0.02] p-4 shadow-sm space-y-3 ring-1 ring-primary/15">
          <div className="flex items-center justify-between gap-2 border-b border-primary/20 pb-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-primary uppercase tracking-wider">
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" /> Requested Changes
            </span>
            {(inChanged || outChanged || placeChanged || outstationChanged) && (
              <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                Modifications pending
              </span>
            )}
          </div>

          <div className="space-y-2">
            <PunchTimeRow label="IN" value={req.requested.check_in} isChanged={inChanged} />
            <PunchTimeRow
              label="OUT"
              value={req.requested.check_out}
              isChanged={outChanged}
              shiftDate={overnightBadgeDate(req.requested.check_in, req.requested.check_out)}
            />
          </div>

          {/* Requested Working Place */}
          {req.requested.working_place && (
            <div className="flex items-start gap-1.5 text-xs">
              <MapPin className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${placeChanged ? 'text-primary' : 'text-muted-foreground'}`} />
              <div>
                <div className="flex items-center gap-1.5">
                  <span className={`font-semibold ${placeChanged ? 'text-primary' : 'text-foreground'}`}>
                    {req.requested.working_place}
                  </span>
                  {placeChanged && (
                    <span className="inline-flex items-center rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.2 text-[9px] font-bold uppercase text-primary">
                      changed
                    </span>
                  )}
                </div>
                {req.requested.site_number && (
                  <span className="text-[11px] text-muted-foreground">Site #{req.requested.site_number}</span>
                )}
              </div>
            </div>
          )}

          {req.requested.is_outstation && (
            <div className="rounded-lg border border-primary/25 bg-primary/[0.08] p-2.5">
              <div className="flex items-center justify-between gap-1">
                <div className="flex items-center gap-1.5 text-[10px] font-bold text-primary uppercase tracking-wide">
                  <Plane className="w-3 h-3 text-primary" /> Outstation Requested
                </div>
                {outstationChanged && (
                  <span className="text-[9px] font-bold uppercase text-primary bg-primary/20 px-1.5 py-0.2 rounded">
                    new
                  </span>
                )}
              </div>
              {req.requested.outstation_name && <div className="mt-0.5 text-xs text-foreground font-medium">{req.requested.outstation_name}</div>}
              {req.requested.outstation_address && <div className="text-[11px] text-muted-foreground">{req.requested.outstation_address}</div>}
            </div>
          )}
        </div>
      </div>

      {/* Location & Geographic Map Card */}
      <div className="rounded-xl border border-border/70 bg-card p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2.5">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Compass className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-foreground">Location & Geographic Verification</h3>
              <p className="text-[11px] text-muted-foreground">Compare registered punch locations vs requested site location</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {distKm != null && (
              <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                <Navigation className="h-3 w-3" />
                <span>{formatDistance(distKm)} apart</span>
              </span>
            )}
            {effectiveReqCoords && (
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${effectiveReqCoords.lat},${effectiveReqCoords.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
              >
                <span>Google Maps</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>

        {hasMap ? (
          <div className="space-y-2">
            <LeafletMiniMap markers={markers} height={220} className="w-full" />
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground pt-1">
              <div className="flex flex-wrap items-center gap-3">
                {effectiveCurCoords && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[#0284c7]" />
                    <span>Current: <strong className="text-foreground">{effectiveCurCoords.label ?? req.current.working_place}</strong></span>
                  </span>
                )}
                {effectiveReqCoords && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[#10b981]" />
                    <span>Requested: <strong className="text-foreground">{effectiveReqCoords.label ?? req.requested.working_place}</strong></span>
                  </span>
                )}
              </div>
              {distKm != null && effectiveCurCoords && effectiveReqCoords && (
                <a
                  href={`https://www.google.com/maps/dir/?api=1&origin=${effectiveCurCoords.lat},${effectiveCurCoords.lng}&destination=${effectiveReqCoords.lat},${effectiveReqCoords.lng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
                >
                  <span>Get directions</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-muted-foreground shrink-0" />
              <span>
                Coordinates are not configured for <strong>{req.requested.working_place || req.current.working_place}</strong>.
              </span>
            </div>
            {(req.requested.working_place || req.current.working_place) && (
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(req.requested.working_place || req.current.working_place || '')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline font-medium shrink-0"
              >
                <span>Search location on Google Maps</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Modal view for standalone requests ──────────────────────────────────────
export function EditRequestModal({
  req, busy, onApprove, onReject, onClose,
}: {
  req: EditRequestData | null;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onClose: () => void;
}) {
  return (
    <Portal>
      <AnimatePresence>
        {req && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              onClick={e => e.stopPropagation()}
              className="w-full max-w-xl max-h-[90vh] overflow-y-auto"
            >
              <Card className="overflow-hidden border border-border shadow-card p-5 space-y-4">
                <EditRequestDetail req={req} onClose={onClose} hideHeader={false} />

                {/* Authoritative Modal Actions */}
                <div className="flex gap-3 pt-2 border-t border-border">
                  <Button
                    variant="outline" onClick={onReject} disabled={busy}
                    className="flex-1"
                  >
                    <X className="w-4 h-4" /> Reject
                  </Button>
                  <Button
                    variant="success" onClick={onApprove} disabled={busy}
                    className="flex-1 shadow-sm shadow-success/20"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                    Approve
                  </Button>
                </div>
              </Card>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </Portal>
  );
}
