'use client';
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CheckCircle, MapPin, Loader2, AlertTriangle,
  Users, Briefcase, Edit2, ChevronDown, Check, Coffee,
  FileEdit, MessageSquare, ArrowRight, X, Calendar, UserCheck, Hand, RotateCcw, Clock, LogOut, ClipboardCheck, Search,
  Smartphone, Fingerprint, ScanFace, History, ListChecks, Layers, Minus,
} from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities, useRoles } from '@/store/rolesStore';
import { roleCan, roleCategory, canPickTechnicians, canApproveTechnicians } from '@/lib/permissions';
import { useT } from '@/store/appStore';
import { _attendanceApi as attendanceApi, attendanceApi as attendanceApiRT } from '@/services/apiCompat';
import { tenant } from '@/lib/firebase';
import { getScheduleForDate } from '@/services/workingScheduleService';
import { useSolarSites } from '@/components/useSolarSites';
import { formatTime, formatDate } from '@/lib/utils';
import { backlogStartFor } from '@/lib/approvalRouting';

// Furthest the past/backlog window can be widened (months before today). Each extra month is
// a full month of attendance docs read once; widening is incremental (see loadOlderPast).
// Shared with the person panel's approve-from-calendar flow (src/lib/panelApprovals.ts).
import { PAST_BACKLOG_MAX_MONTHS } from '@/lib/panelApprovals';
import { calcMorningAllowance, calcEveningAllowance } from '@/lib/foodAllowance';

// Page-facing shape of one past/backlog approval row, shared by the initial load and the
// incremental "Load older" widen so both produce identical records.
function mapPastRecords(pastRes: any): PastApprovalRecord[] {
  const raw = Array.isArray(pastRes?.data?.data) ? pastRes.data.data : Array.isArray(pastRes?.data) ? pastRes.data : [];
  return raw.map((r: any) => ({
    id: r.attendance_id, name: r.employee_name, epf_number: r.epf_number, phone: r.phone ?? null,
    check_in_time: r.check_in, check_out_time: r.check_out, working_place: r.working_place,
    site_no: r.site_number, is_outstation: r.is_outstation, outstation_name: r.outstation_name,
    outstation_address: r.outstation_address, user_type: r.user_type, date: r.date,
    check_in_approved: !!r.check_in_approved,
    morning_allowance: r.morning_allowance ?? null,
    evening_allowance: r.evening_allowance ?? null,
  }));
}
import { mapsLink, distanceMeters } from '@/lib/geo';
import dynamic from 'next/dynamic';

// Read-only OpenStreetMap preview (Leaflet via CDN) — loaded only when an approver
// expands a record, so it never weighs on the initial approvals bundle.
const LeafletMiniMap = dynamic(() => import('@/components/LeafletMiniMap'), {
  ssr: false,
  loading: () => <div className="h-[150px] w-full animate-pulse bg-muted" />,
});
import ApprovalsSkeleton, { ApprovalsQueueSkeleton } from '@/components/approvals/ApprovalsSkeleton';
import { EditRequestDetail } from '@/components/EditRequestCard';
import { IssueBanner } from '@/components/approvals/IssueIndicators';
import { getRecordIssues } from '@/lib/approvalIssues';
import ApprovalsMasterDetail from '@/components/approvals/ApprovalsMasterDetail';
import ApprovalsTriageBar, { type TriageTile } from '@/components/approvals/ApprovalsTriageBar';
import ApprovalsQueue, { buildApprovalQueue, PROBLEMS_BUCKET, type QueueItem } from '@/components/approvals/ApprovalsQueue';
import ApprovalsBulkBar from '@/components/approvals/ApprovalsBulkBar';
import ApprovalsBacklogCard from '@/components/approvals/ApprovalsBacklogCard';
import ApprovalsDetailHeader from '@/components/approvals/ApprovalsDetailHeader';
import ApprovalsKeyboardHint from '@/components/approvals/ApprovalsKeyboardHint';
import { useApprovalKeyboard } from '@/components/approvals/useApprovalKeyboard';
import { readClearedToday, addClearedToday } from '@/components/approvals/clearedToday';
import ApprovalListRow from '@/components/approvals/ApprovalListRow';
import EditRequestListRow from '@/components/approvals/EditRequestListRow';
import PickListRow from '@/components/approvals/PickListRow';
import SmartWorkingPlaceSelect from '@/components/SmartWorkingPlaceSelect';
import SessionLocations from '@/components/SessionLocations';
import CallButton from '@/components/CallButton';
import ConfirmModal from '@/components/ConfirmModal';
import { useWorkingPlaces } from '@/store/workingPlacesStore';
import { isLocationSupervisor } from '@/services/workingPlaceService';
import toast from 'react-hot-toast';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageTransition, Reveal, Stagger, StaggerItem, MotionCard } from '@/components/ui/motion';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

// Southern Lanka: only mobile-app check-in/checkout needs manual approval there (fingerprint
// check-in/checkout stays auto-approved — see apiCompat.ts checkIn/checkOut/fingerprintApi.ts),
// and Pick / My Team is excluded entirely (see canPick below). The Technician/Executive
// pending-check-in stat cards below the channel breakdown reflect real (mobile-only) pending
// counts for this tenant, same as every other tenant.
const isSouthernlanka = tenant.id === 'southernlanka';

// ─── Types ────────────────────────────────────────────────────────────────────
interface ApprovalRecord {
  attendance_id: number;
  name: string;
  epf_number: string;
  phone?: string | null;
  time?: string | null;
  working_place?: string | null;
  site_no?: string | null;
  is_outstation?: boolean;
  outstation_name?: string | null;
  outstation_address?: string | null;
  check_in_lat?: number | null;
  check_in_lng?: number | null;
  check_out_lat?: number | null;
  check_out_lng?: number | null;
  check_out_within_radius?: boolean | null;
  check_in_site_name?: string | null;
}

interface PastApprovalRecord {
  id: number;
  name: string;
  epf_number: string;
  phone?: string | null;
  check_in_time: string;
  check_out_time: string;
  working_place?: string | null;
  site_no?: string | null;
  is_outstation?: boolean;
  outstation_name?: string | null;
  outstation_address?: string | null;
  date?: string;
  // Role NAME of the employee — the Staff / Executives split is derived from it.
  user_type?: string;
  // Backlog (stranded-pending) extras: a checkout-only record's check-in is already
  // approved — its editor is locked and approve won't touch it. Stored allowances (when
  // present) seed the edit state instead of recomputing from the times.
  check_in_approved?: boolean;
  morning_allowance?: number | null;
  evening_allowance?: number | null;
}

// A today's-technician row from getCheckedInToday (drives the Pick / My Team features).
interface PickRow {
  docId: string;
  sessionId: string;
  epf_number: string;
  name: string;
  role: string;
  pickable: boolean;
  phone: string | null;
  check_in: string | null;
  check_in_lat: number | null;
  check_in_lng: number | null;
  site_name: string | null;
  site_distance_m: number | null;
  check_in_status: string;
  check_out: string | null;
  check_out_status: string | null;
  check_in_approved_by: string | null;
  morning_allowance: number;
  picked_by: string | null;
  picked_by_name: string | null;
  picked_at: string | null;
}

interface ApprovalData {
  tech_count: number;
  tech_list_type: 'check_in' | 'check_out' | 'both';
  tech_list: ApprovalRecord[];
  exe_list_type: 'check_in' | 'check_out' | 'both';
  exe_list: ApprovalRecord[];
  past_tech_list?: PastApprovalRecord[];
  past_exe_list?: PastApprovalRecord[];
  has_technicians?: boolean;
  has_executives?: boolean;
}

// Edit request from employee
interface AttendanceEditRequest {
  id: number;
  attendance_id: number;
  epf_number: string;
  name: string;
  reason: string;
  created_at: string;
  current: {
    check_in?: string | null;
    check_out?: string | null;
    working_place?: string | null;
    site_number?: string | null;
    is_outstation?: boolean;
    outstation_name?: string | null;
    outstation_address?: string | null;
  };
  requested: {
    check_in?: string | null;
    check_out?: string | null;
    working_place?: string | null;
    site_number?: string | null;
    is_outstation?: boolean | null;
    outstation_name?: string | null;
    outstation_address?: string | null;
  };
}

// What a bulk approve actually did, so a caller running several batches can keep going after a
// failure and report one honest summary at the end. `skips` counts the past-record validation
// reasons (missing checkout, missing working place, …) by reason.
type ApproveResult = { approved: number[]; failed: number[]; skips: Map<string, number> };

// Editable state per record
interface EditState {
  time: string;
  check_out_time: string;      // only used for a combined ('both') session card
  working_place: string;
  site_no: string;
  outstation_name: string;
  outstation_address: string;
  is_outstation: boolean;          // approver-editable outstation tick (auto-derived at check-out)
  is_outstation_approved: boolean;
  morning_allowance: number;
  evening_allowance: number;   // checkout: 0=none,1=cat1
}

interface PastEditState {
  check_in_time: string;
  check_out_time: string;
  working_place: string;
  site_no: string;
  outstation_name: string;
  outstation_address: string;
  is_outstation_approved: boolean;
  morning_allowance: number;
  evening_allowance: number;
}

// ─── Food Allowance Helpers ───────────────────────────────────────────────────
// calcMorningAllowance / calcEveningAllowance live in src/lib/foodAllowance.ts (shared with
// the person panel's bulk approve, which writes the same auto-calculated values).
function morningLabel(val: number) {
  if (val === 1) return { text: 'Food Allowance Cat. 1', color: 'text-success', bg: 'bg-success/10 border-success/20' };
  if (val === 2) return { text: 'Food Allowance Cat. 2', color: 'text-warning', bg: 'bg-warning/10 border-warning/20' };
  return { text: 'No Food Allowance', color: 'text-muted-foreground', bg: 'bg-muted border-border' };
}

function eveningLabel(val: number) {
  if (val === 1) return { text: 'Food Allowance Cat. 1', color: 'text-success', bg: 'bg-success/10 border-success/20' };
  return { text: 'No Food Allowance', color: 'text-muted-foreground', bg: 'bg-muted border-border' };
}

function localDateTimeString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function toTimeInput(timeStr: string | null | undefined): string {
  if (!timeStr) return '';
  const d = new Date(timeStr);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function applyTimeToDate(originalStr: string, timeInput: string): string {
  const base = originalStr ? new Date(originalStr) : new Date();
  const [h, m] = timeInput.split(':').map(Number);
  base.setHours(h, m, 0, 0);
  return localDateTimeString(base);
}

// ─── Single Record Card (Detail Panel) ──────────────────────────────────────
function RecordCard({
  record, listType, edit, setEdit, isTech, computeOutstation,
}: {
  record: ApprovalRecord;
  listType: 'check_in' | 'check_out' | 'both';
  edit: EditState;
  setEdit: (e: EditState) => void;
  isTech: boolean;
  computeOutstation?: (placeName: string) => boolean | null;
  [key: string]: any;
}) {
  const { requiresSite } = useWorkingPlaces();
  const issues = getRecordIssues(record as any);

  // Check-in time editor (used by 'check_in' and 'both').
  const handleCheckInTime = (val: string) => {
    const newTime = applyTimeToDate(record.time ?? new Date().toISOString(), val);
    setEdit({ ...edit, time: newTime, morning_allowance: calcMorningAllowance(newTime) });
  };

  // Check-out time editor.
  const handleCheckOutTime = (val: string) => {
    if (listType === 'both') {
      const base = edit.check_out_time || (record as any).check_out_time || new Date().toISOString();
      const newTime = applyTimeToDate(base, val);
      setEdit({ ...edit, check_out_time: newTime, evening_allowance: calcEveningAllowance(newTime) });
    } else {
      const newTime = applyTimeToDate(record.time ?? new Date().toISOString(), val);
      setEdit({ ...edit, time: newTime, evening_allowance: calcEveningAllowance(newTime) });
    }
  };

  // Calculate duty duration if both check-in and check-out exist
  const inTimeStr = edit.time;
  const outTimeStr = listType === 'both' ? edit.check_out_time : (listType === 'check_out' ? edit.time : null);
  let durationStr: string | null = null;
  if (inTimeStr && outTimeStr) {
    try {
      const ms = new Date(outTimeStr).getTime() - new Date(inTimeStr).getTime();
      if (ms > 0) {
        const hrs = Math.floor(ms / (1000 * 60 * 60));
        const mins = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
        durationStr = `${hrs}h ${mins}m duty`;
      }
    } catch {}
  }

  const inLat = record.check_in_lat, inLng = record.check_in_lng;
  const outLat = record.check_out_lat, outLng = record.check_out_lng;
  const hasIn = inLat != null && inLng != null;
  const hasOut = outLat != null && outLng != null;
  const differ = !!(hasIn && hasOut &&
    (Math.abs((inLat as number) - (outLat as number)) > 0.00005 ||
      Math.abs((inLng as number) - (outLng as number)) > 0.00005));
  const twoMaps = hasIn && hasOut && differ;

  return (
    <div className="space-y-3.5">
      {/* ── 1. Geofence & Issue Diagnostics Banner ── */}
      {issues.length > 0 && (
        <IssueBanner issues={issues} />
      )}

      {/* ── 2. Dual-Punch Timing & Allowance Matrix ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Check-In Column */}
        {(listType === 'check_in' || listType === 'both') && (
          <div className="rounded-xl border border-border/70 bg-card p-3.5 shadow-sm space-y-3">
            <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-success">
                <Clock className="w-3.5 h-3.5" /> Check-in Punch
              </span>
              <span className="font-mono text-xs font-bold text-success">
                {edit.time ? formatTime(edit.time) : '--:--'}
              </span>
            </div>

            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                <Edit2 className="w-3 h-3 text-muted-foreground" /> Punch Time
              </label>
              <Input
                type="time"
                value={toTimeInput(edit.time)}
                onChange={e => handleCheckInTime(e.target.value)}
                className="w-full font-mono text-sm [color-scheme:light] dark:[color-scheme:dark]"
              />
            </div>

            {isTech && (
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1.5 flex items-center justify-between">
                  <span className="flex items-center gap-1"><Coffee className="w-3 h-3" /> Morning Allowance</span>
                  <span className="text-[10px] text-muted-foreground font-normal">auto-calculated</span>
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                  {[
                    { val: 1, label: 'Cat. 1', sub: '< 06:45', color: 'emerald' },
                    { val: 2, label: 'Cat. 2', sub: '06:45–07:00', color: 'amber' },
                    { val: 0, label: 'None', sub: '> 07:00', color: 'slate' },
                  ].map(opt => {
                    const active = edit.morning_allowance === opt.val;
                    return (
                      <button
                        key={opt.val}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setEdit({ ...edit, morning_allowance: opt.val })}
                        className={`flex flex-col items-center justify-center p-1.5 rounded-lg border text-center transition-all ${
                          active
                            ? opt.color === 'emerald'
                              ? 'bg-success/15 border-success/50 text-success font-semibold shadow-xs'
                              : opt.color === 'amber'
                                ? 'bg-warning/15 border-warning/50 text-warning font-semibold shadow-xs'
                                : 'bg-muted border-foreground/20 text-foreground font-semibold'
                            : 'bg-muted/40 border-border text-muted-foreground hover:text-foreground hover:bg-muted/70'
                        }`}
                      >
                        <span className="text-xs flex items-center gap-1">
                          {active && <Check className="w-2.5 h-2.5" />}
                          {opt.label}
                        </span>
                        <span className="text-[9px] opacity-75">{opt.sub}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Check-Out Column */}
        {(listType === 'check_out' || listType === 'both') && (
          <div className="rounded-xl border border-border/70 bg-card p-3.5 shadow-sm space-y-3">
            <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                <LogOut className="w-3.5 h-3.5" /> Check-out Punch
              </span>
              <div className="flex items-center gap-2">
                {durationStr && (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                    {durationStr}
                  </span>
                )}
                <span className="font-mono text-xs font-bold text-primary">
                  {(listType === 'both' ? edit.check_out_time : edit.time) ? formatTime(listType === 'both' ? edit.check_out_time : edit.time) : '--:--'}
                </span>
              </div>
            </div>

            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                <Edit2 className="w-3 h-3 text-muted-foreground" /> Punch Time
              </label>
              <Input
                type="time"
                value={toTimeInput(listType === 'both' ? edit.check_out_time : edit.time)}
                onChange={e => handleCheckOutTime(e.target.value)}
                className="w-full font-mono text-sm [color-scheme:light] dark:[color-scheme:dark]"
              />
            </div>

            {isTech && (
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1.5 flex items-center justify-between">
                  <span className="flex items-center gap-1"><Coffee className="w-3 h-3" /> Evening Allowance</span>
                  <span className="text-[10px] text-muted-foreground font-normal">auto-calculated</span>
                </label>
                <div className="grid grid-cols-2 gap-1.5">
                  {[
                    { val: 1, label: 'Cat. 1', sub: '> 19:00', color: 'emerald' },
                    { val: 0, label: 'None', sub: '< 19:00', color: 'slate' },
                  ].map(opt => {
                    const active = edit.evening_allowance === opt.val;
                    return (
                      <button
                        key={opt.val}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setEdit({ ...edit, evening_allowance: opt.val })}
                        className={`flex flex-col items-center justify-center p-1.5 rounded-lg border text-center transition-all ${
                          active
                            ? opt.color === 'emerald'
                              ? 'bg-success/15 border-success/50 text-success font-semibold shadow-xs'
                              : 'bg-muted border-foreground/20 text-foreground font-semibold'
                            : 'bg-muted/40 border-border text-muted-foreground hover:text-foreground hover:bg-muted/70'
                        }`}
                      >
                        <span className="text-xs flex items-center gap-1">
                          {active && <Check className="w-2.5 h-2.5" />}
                          {opt.label}
                        </span>
                        <span className="text-[9px] opacity-75">{opt.sub}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 3. Working Place & Outstation Assignment ── */}
      <div className="rounded-xl border border-border/70 bg-card p-3.5 shadow-sm space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block font-medium flex items-center gap-1.5">
              <MapPin className="w-3 h-3" /> Working Place
            </label>
            <SmartWorkingPlaceSelect
              value={edit.working_place}
              onChange={name => {
                const out = computeOutstation?.(name) ?? null;
                setEdit({
                  ...edit,
                  working_place: name,
                  site_no: requiresSite(name) ? edit.site_no : '',
                  ...(out != null ? { is_outstation: out } : {}),
                });
              }}
            />
          </div>

          {requiresSite(edit.working_place) && (
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block font-medium">Site Number</label>
              <Input
                type="text"
                value={edit.site_no}
                onChange={e => setEdit({ ...edit, site_no: e.target.value })}
                placeholder="e.g. SITE-001"
              />
            </div>
          )}
        </div>

        {/* Outstation toggle */}
        {isTech && (
          <div className="rounded-lg border border-warning/25 bg-warning/[0.06] p-2.5">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <div
                onClick={() => setEdit({ ...edit, is_outstation: !edit.is_outstation })}
                className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                  edit.is_outstation ? 'bg-warning border-warning' : 'border-border bg-muted'
                }`}
              >
                {edit.is_outstation && <Check className="w-2.5 h-2.5 text-warning-foreground" />}
              </div>
              <span className="text-xs font-semibold text-foreground">Outstation Work Assignment</span>
            </label>
            <p className="mt-1 text-[11px] text-muted-foreground pl-6.5">
              {(record as any).outstation_ref_distance_m != null
                ? `Measured ${((record as any).outstation_ref_distance_m / 1000).toFixed(1)} km from base location${(record as any).is_outstation_auto && record.is_outstation ? ' (> 60 km qualifies for outstation)' : ''}. Override if needed.`
                : 'Primary location not configured — tick if this was outstation duty.'}
            </p>
          </div>
        )}
      </div>

      {/* ── 4. Location Verification Maps ── */}
      {(hasIn || hasOut) && (
        <div className="rounded-xl border border-border/70 bg-card p-3.5 shadow-sm space-y-2.5">
          <label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 text-primary" /> Location Verification {twoMaps ? '(In & Out Coordinates)' : ''}
          </label>
          <div className={twoMaps ? 'grid grid-cols-1 sm:grid-cols-2 gap-3' : ''}>
            {hasIn && (
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="flex items-center justify-between gap-2 bg-muted/50 px-3 py-1.5 text-xs">
                  <span className="flex items-center gap-1.5 font-semibold text-success">
                    <span className="h-1.5 w-1.5 rounded-full bg-success" /> Check-in Pin
                  </span>
                  {record.check_in_site_name && (
                    <span className="truncate text-[11px] text-muted-foreground">{record.check_in_site_name}</span>
                  )}
                </div>
                <LeafletMiniMap lat={inLat as number} lng={inLng as number} height={140} />
                <a
                  href={mapsLink(inLat as number, inLng as number)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block bg-muted/20 px-3 py-1 text-[10px] font-medium text-primary hover:underline"
                >
                  View in Google Maps →
                </a>
              </div>
            )}
            {hasOut && (twoMaps || !hasIn) && (
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="flex items-center justify-between gap-2 bg-muted/50 px-3 py-1.5 text-xs">
                  <span className="flex items-center gap-1.5 font-semibold text-primary">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Check-out Pin
                  </span>
                  {record.check_out_within_radius != null && (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${record.check_out_within_radius ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`}>
                      {record.check_out_within_radius ? 'In range' : 'Outside radius'}
                    </span>
                  )}
                </div>
                <LeafletMiniMap lat={outLat as number} lng={outLng as number} height={140} />
                <a
                  href={mapsLink(outLat as number, outLng as number)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block bg-muted/20 px-3 py-1 text-[10px] font-medium text-primary hover:underline"
                >
                  View in Google Maps →
                </a>
              </div>
            )}
          </div>
          {hasIn && hasOut && !differ && (
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Check className="h-3 w-3 text-success" /> Checked in and out within 5m of the same location.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Past Record Card (Backlog Detail Panel) ──────────────────────────────────
function PastRecordCard({
  record, edit, setEdit, isTech,
}: {
  record: PastApprovalRecord;
  edit: PastEditState;
  setEdit: (e: PastEditState) => void;
  isTech: boolean;
  [key: string]: any;
}) {
  const { requiresSite } = useWorkingPlaces();
  const checkInApproved = !!record.check_in_approved;

  const handleTimeChange = (type: 'in' | 'out', val: string) => {
    if (type === 'in') {
      const newTime = applyTimeToDate(record.check_in_time ?? new Date().toISOString(), val);
      setEdit({ ...edit, check_in_time: newTime, morning_allowance: calcMorningAllowance(newTime) });
    } else {
      const newTime = applyTimeToDate(record.check_out_time ?? record.check_in_time ?? new Date().toISOString(), val);
      setEdit({ ...edit, check_out_time: newTime, evening_allowance: calcEveningAllowance(newTime) });
    }
  };

  return (
    <div className="space-y-3.5">
      {checkInApproved && (
        <div className="rounded-lg border border-primary/20 bg-primary/[0.06] p-2.5 text-xs text-primary flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-primary shrink-0" />
          <span>Check-in was already approved. Editing check-out and allowances only.</span>
        </div>
      )}

      {/* Dual-Punch Timing & Allowance Matrix */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Check-In Column */}
        <div className="rounded-xl border border-border/70 bg-card p-3.5 shadow-sm space-y-3">
          <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-success">
              <Clock className="w-3.5 h-3.5" /> Check-in Punch
            </span>
            <span className="font-mono text-xs font-bold text-success">
              {edit.check_in_time ? formatTime(edit.check_in_time) : '--:--'}
            </span>
          </div>

          <div>
            <label className="text-[11px] font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
              <Edit2 className="w-3 h-3 text-muted-foreground" /> Punch Time
            </label>
            <Input
              type="time"
              disabled={checkInApproved}
              value={toTimeInput(edit.check_in_time)}
              onChange={e => handleTimeChange('in', e.target.value)}
              className="w-full font-mono text-sm [color-scheme:light] dark:[color-scheme:dark]"
            />
          </div>

          {isTech && (
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1.5 flex items-center justify-between">
                <span className="flex items-center gap-1"><Coffee className="w-3 h-3" /> Morning Allowance</span>
                <span className="text-[10px] text-muted-foreground font-normal">auto-calculated</span>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                {[
                  { val: 1, label: 'Cat. 1', sub: '< 06:45', color: 'emerald' },
                  { val: 2, label: 'Cat. 2', sub: '06:45–07:00', color: 'amber' },
                  { val: 0, label: 'None', sub: '> 07:00', color: 'slate' },
                ].map(opt => {
                  const active = edit.morning_allowance === opt.val;
                  return (
                    <button
                      key={opt.val}
                      type="button"
                      aria-pressed={active}
                      disabled={checkInApproved}
                      onClick={() => setEdit({ ...edit, morning_allowance: opt.val })}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-lg border text-center transition-all disabled:opacity-50 ${
                        active
                          ? opt.color === 'emerald'
                            ? 'bg-success/15 border-success/50 text-success font-semibold shadow-xs'
                            : opt.color === 'amber'
                              ? 'bg-warning/15 border-warning/50 text-warning font-semibold shadow-xs'
                              : 'bg-muted border-foreground/20 text-foreground font-semibold'
                          : 'bg-muted/40 border-border text-muted-foreground hover:text-foreground hover:bg-muted/70'
                      }`}
                    >
                      <span className="text-xs flex items-center gap-1">
                        {active && <Check className="w-2.5 h-2.5" />}
                        {opt.label}
                      </span>
                      <span className="text-[9px] opacity-75">{opt.sub}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Check-Out Column */}
        <div className="rounded-xl border border-border/70 bg-card p-3.5 shadow-sm space-y-3">
          <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-primary">
              <LogOut className="w-3.5 h-3.5" /> Check-out Punch
            </span>
            <span className="font-mono text-xs font-bold text-primary">
              {edit.check_out_time ? formatTime(edit.check_out_time) : '--:--'}
            </span>
          </div>

          <div>
            <label className="text-[11px] font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
              <Edit2 className="w-3 h-3 text-muted-foreground" /> Punch Time
            </label>
            <Input
              type="time"
              value={toTimeInput(edit.check_out_time)}
              onChange={e => handleTimeChange('out', e.target.value)}
              className="w-full font-mono text-sm [color-scheme:light] dark:[color-scheme:dark]"
            />
          </div>

          {isTech && (
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1.5 flex items-center justify-between">
                <span className="flex items-center gap-1"><Coffee className="w-3 h-3" /> Evening Allowance</span>
                <span className="text-[10px] text-muted-foreground font-normal">auto-calculated</span>
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  { val: 1, label: 'Cat. 1', sub: '> 19:00', color: 'emerald' },
                  { val: 0, label: 'None', sub: '< 19:00', color: 'slate' },
                ].map(opt => {
                  const active = edit.evening_allowance === opt.val;
                  return (
                    <button
                      key={opt.val}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setEdit({ ...edit, evening_allowance: opt.val })}
                      className={`flex flex-col items-center justify-center p-1.5 rounded-lg border text-center transition-all ${
                        active
                          ? opt.color === 'emerald'
                            ? 'bg-success/15 border-success/50 text-success font-semibold shadow-xs'
                            : 'bg-muted border-foreground/20 text-foreground font-semibold'
                          : 'bg-muted/40 border-border text-muted-foreground hover:text-foreground hover:bg-muted/70'
                      }`}
                    >
                      <span className="text-xs flex items-center gap-1">
                        {active && <Check className="w-2.5 h-2.5" />}
                        {opt.label}
                      </span>
                      <span className="text-[9px] opacity-75">{opt.sub}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Workplace & Site */}
      <div className="rounded-xl border border-border/70 bg-card p-3.5 shadow-sm space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block font-medium flex items-center gap-1.5">
              <MapPin className="w-3 h-3" /> Working Place
            </label>
            <SmartWorkingPlaceSelect
              value={edit.working_place}
              onChange={name => setEdit({ ...edit, working_place: name, site_no: requiresSite(name) ? edit.site_no : '' })}
            />
          </div>

          {requiresSite(edit.working_place) && (
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block font-medium">Site Number</label>
              <Input
                type="text"
                value={edit.site_no}
                onChange={e => setEdit({ ...edit, site_no: e.target.value })}
                placeholder="e.g. SITE-001"
              />
            </div>
          )}
        </div>

        {record.is_outstation && (
          <div className="rounded-lg border border-warning/25 bg-warning/[0.06] p-2.5">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-warning" />
              <span className="text-xs font-semibold text-warning">Outstation Request</span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              <span className="text-foreground">{record.outstation_name}</span>
              {record.outstation_address && <span> · {record.outstation_address}</span>}
            </div>
            <label className="mt-2 flex items-center gap-2 cursor-pointer">
              <div
                onClick={() => setEdit({ ...edit, is_outstation_approved: !edit.is_outstation_approved })}
                className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                  edit.is_outstation_approved ? 'bg-warning border-warning' : 'border-border bg-muted'
                }`}
              >
                {edit.is_outstation_approved && <Check className="w-2.5 h-2.5 text-warning-foreground" />}
              </div>
              <span className="text-xs font-medium text-foreground">Approve outstation working</span>
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

function pickFmtTime(s: string | null) { return s ? s.slice(11, 16) : '—'; }

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function ApprovalsPage() {
  const { user } = useAuthStore();
  const caps = useUserCapabilities();
  const { roles, loaded: rolesLoaded } = useRoles();
  const t = useT();
  // Picking is available only to non-technician employee approvers (executive / top mgmt).
  // System Admin can do everything, including pick — so no is_system_admin exclusion here.
  // Southern Lanka excludes Pick / My Team entirely (see apiCompat.ts pickTechnician).
  const canPick = rolesLoaded && !isSouthernlanka && canPickTechnicians(user?.role, roles);
  // Full approver of technicians? Pick-only team leaders (can_lead_team without
  // can_approve_technicians) can pick but must NOT approve — an approver above approves the team.
  const canApproveTech = rolesLoaded && canApproveTechnicians(user?.role, roles);
  // Southern Lanka only — an assigned department HOD may open Approvals and approve their
  // department's Attendance/Time-Change requests purely by virtue of being HOD, independent of
  // the generic can_approve capability (see apiCompat.ts southernlankaApprovers). Mirrors the
  // same hod_department_ids/hod_department_names read useHodScope.ts uses.
  const isSouthernlankaHod = isSouthernlanka
    && !!(user?.hod_department_names?.length || user?.hod_department_ids?.length);
  const router = useRouter();
  const { requiresSite, options: wpOptions, placeHasTag } = useWorkingPlaces();
  const solarSites = useSolarSites(true);
  // Scheduled working-place NAME per record (its coords are resolved lazily). Storing the name
  // keeps the fetch effect dependent only on the record set, not on the per-render place lists.
  const [schedPlaceById, setSchedPlaceById] = useState<Record<number, string | null>>({});
  const [data, setData] = useState<ApprovalData | null>(null);
  const [loading, setLoading] = useState(true);
  // Southern Lanka only — today's check-in counts by channel (mobile app vs fingerprint
  // device vs face device), shown in place of the Technician/Executive pending-check-in stat
  // cards (see isSouthernlanka above).
  const [checkInMethodCounts, setCheckInMethodCounts] = useState<{ mobile: number; fingerprint: number; face: number } | null>(null);
  // Whether the viewer supervises ≥1 working place → may open Approvals even without an
  // approver role. null = still resolving (don't redirect yet).
  const [isLocSup, setIsLocSup] = useState<boolean | null>(null);
  useEffect(() => {
    if (user?.epf_number) isLocationSupervisor(user.epf_number).then(setIsLocSup).catch(() => setIsLocSup(false));
    else setIsLocSup(false);
  }, [user?.epf_number]);
  const [actKey, setActKey] = useState<string | null>(null);
  const [tab, setTab] = useState<'all' | 'tech' | 'exec' | 'edits'>('all');
  const [editRequests, setEditRequests] = useState<{ tech: AttendanceEditRequest[]; exe: AttendanceEditRequest[] }>({ tech: [], exe: [] });
  const [rejectModal, setRejectModal] = useState<{ open: boolean; id: number | null }>({ open: false, id: null });
  const [rejectReason, setRejectReason] = useState('');

  // Edit states keyed by attendance_id
  const [editStates, setEditStates] = useState<Record<number, EditState>>({});
  const [pastEditStates, setPastEditStates] = useState<Record<number, PastEditState>>({});
  // How far back the past/backlog list reaches, in months before today (1 = previous month).
  // Widened on demand by the "Load older" control — every extra month is a full month of
  // attendance docs to read, so it is never the default.
  const [pastMonthsBack, setPastMonthsBack] = useState(1);
  const [pastLoadingOlder, setPastLoadingOlder] = useState(false);
  // Selected attendance_ids for bulk approve
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Selected edit-request ids for bulk approve (edits tab has its own selection set).
  const [selectedEdits, setSelectedEdits] = useState<Set<number>>(new Set());
  // Pick / My-Team (Staff tab) — today's technicians from getCheckedInToday.
  const [pickRows, setPickRows] = useState<PickRow[]>([]);
  const [staffView, setStaffView] = useState<'pool' | 'myteam'>('pool');
  // Which slice of the queue the card shows. 'past' hides today's list, the pick pool and the
  // picked rosters so the past/backlog records are the whole card — before this they sat at the
  // very bottom of the Staff tab under 40+ live rows and two pick sections, and approvers
  // concluded there was nothing to approve for people whose sessions were weeks old. 'today'
  // hides the backlog instead. Default 'all' keeps both, which is what the page always did.
  const [scope, setScope] = useState<'today' | 'past' | 'all'>('all');
  const showToday = scope !== 'past';
  const showPast  = scope !== 'today';
  const [pickBusyId, setPickBusyId] = useState<string | null>(null);
  const [endShiftBusyId, setEndShiftBusyId] = useState<number | null>(null);
  const [confirmEndShift, setConfirmEndShift] = useState<{ recId: number; name: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  // Master–detail selection for the tech/exec/all pending lists (kept per-tab so switching
  // tabs doesn't clobber the other tab's selection).
  const [selTech, setSelTech] = useState<number | null>(null);
  const [selExec, setSelExec] = useState<number | null>(null);
  const [selAll, setSelAll] = useState<number | null>(null);
  // "Problems first" sort toggle for the queue. ON by default — a record with an issue is the
  // one an approver most needs to look at, and the summary line states the order out loud so
  // the default never reads as the list being in a mysterious order.
  const [issuesFirst, setIssuesFirst] = useState(true);
  // Force missing details toggle for bulk approvals (auto-fills default check-out/site if missing)
  const [bulkForce, setBulkForce] = useState(false);
  // The "Problems" triage tile: narrows the queue to records that have an issue.
  const [problemsOnly, setProblemsOnly] = useState(false);
  // Which people tab the triage tiles describe. On the Edit requests tab the tiles keep
  // describing the people queue you came from, so clicking one takes you back to it.
  const [lastPeopleTab, setLastPeopleTab] = useState<'all' | 'tech' | 'exec'>('all');
  // Whole-backlog approve: a run of batches, its progress caption, and the day separator whose
  // "Approve this day" is currently in flight.
  const [backlogRunning, setBacklogRunning] = useState(false);
  const [backlogProgress, setBacklogProgress] = useState<string | null>(null);
  const [approvingDayKey, setApprovingDayKey] = useState<string | null>(null);
  // Keyboard reject asks first — a stray 'r' must never reject someone's day silently.
  const [confirmReject, setConfirmReject] = useState<{ ids: number[]; name: string } | null>(null);
  // How many records this browser has cleared today (see clearedToday.ts) — the one number
  // worth showing on an empty queue.
  const [clearedToday, setClearedToday] = useState(0);
  // Master–detail selection for the edit-requests tab.
  const [selEdit, setSelEdit] = useState<string | number | null>(null);
  // Edit-requests tab: filter to technician-only / executive-only requests (or all).
  const [editRoleFilter, setEditRoleFilter] = useState<'all' | 'tech' | 'exec'>('all');
  // Master–detail selection for the pool/my-team picking tabs (shared; reset on tab switch).
  const [selPick, setSelPick] = useState<string | number | null>(null);

  const myEpf = String(user?.epf_number ?? '');
  // Today's local date. Declared up here (not down with the derived lists) because the
  // cleared-today counter and several handlers close over it.
  const todayStr = (() => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();

  useEffect(() => { setClearedToday(readClearedToday(todayStr)); }, [todayStr]);

  // Count records this browser has cleared today. Called from every successful approve path.
  const bumpCleared = (n: number) => { if (n > 0) setClearedToday(addClearedToday(todayStr, n)); };

  // Remember the last people tab so the triage tiles keep meaning something on the Edits tab.
  useEffect(() => { if (tab !== 'edits') setLastPeopleTab(tab); }, [tab]);

  // Resolve a working-place name (admin place or Solar site) to coordinates.
  const placeCoords = useCallback((name: string | null | undefined, siteNo?: string | null): { lat: number; lng: number; label?: string } | null => {
    if (!name && !siteNo) return null;
    const cleanName = (name ?? '').trim();
    const cleanSiteNo = (siteNo ?? '').replace(/^[#\s]+/, '').trim();

    // 1. By solar site number
    if (cleanSiteNo) {
      const s = solarSites.find((x: any) => String(x.siteNo).toLowerCase() === cleanSiteNo.toLowerCase() && x.lat != null && x.lng != null);
      if (s) return { lat: s.lat, lng: s.lng, label: `${s.name} (#${s.siteNo})` };
    }

    if (cleanName) {
      // 2. Exact match on working place
      const wp = wpOptions.find(o => o.name?.toLowerCase() === cleanName.toLowerCase() && o.latitude != null && o.longitude != null);
      if (wp) return { lat: wp.latitude as number, lng: wp.longitude as number, label: wp.name };

      // 3. Exact match on solar site name (#siteNo)
      const sExact = solarSites.find((x: any) => `${x.name} (#${x.siteNo})`.toLowerCase() === cleanName.toLowerCase() && x.lat != null && x.lng != null);
      if (sExact) return { lat: sExact.lat, lng: sExact.lng, label: `${sExact.name} (#${sExact.siteNo})` };

      // 4. Solar site matching name alone
      const sName = solarSites.find((x: any) => x.name?.toLowerCase() === cleanName.toLowerCase() && x.lat != null && x.lng != null);
      if (sName) return { lat: sName.lat, lng: sName.lng, label: `${sName.name} (#${sName.siteNo})` };

      // 5. Partial / substring match
      const sSub = solarSites.find((x: any) => (cleanName.toLowerCase().includes(x.name?.toLowerCase()) || `${x.name} (#${x.siteNo})`.toLowerCase().includes(cleanName.toLowerCase())) && x.lat != null && x.lng != null);
      if (sSub) return { lat: sSub.lat, lng: sSub.lng, label: `${sSub.name} (#${sSub.siteNo})` };
    }

    return null;
  }, [wpOptions, solarSites]);

  // Stable list of pending+past records (id/epf/date) so references are fetched only when the
  // set changes — not on every realtime snapshot.
  const refRecords = useMemo(() => {
    const rows = [
      ...((data?.tech_list ?? []) as any[]),
      ...((data?.exe_list ?? []) as any[]),
      ...((data?.past_tech_list ?? []) as any[]),
      ...((data?.past_exe_list ?? []) as any[]),
    ];
    return rows.map(r => ({ id: r.attendance_id ?? r.id, epf: String(r.epf_number), date: r.date ?? '' }))
      .filter(r => r.id != null && r.epf && r.date);
  }, [data]);
  const refRecordsKey = refRecords.map(r => `${r.id}:${r.epf}:${r.date}`).join(',');

  // Fetch each record's SCHEDULED place NAME for its day (if any). Depends ONLY on the record
  // set — NOT on placeCoords/wpOptions/solarSites (which get fresh references every render and
  // would otherwise re-run this effect forever). Coordinates are resolved lazily below.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Concurrent, not one-await-per-record: the per-employee schedule reads coalesce
      // in workingScheduleService, so N records cost one round trip per distinct EPF.
      const entries = await Promise.all(refRecords.map(async (r) => {
        try {
          const sched = await getScheduleForDate(r.epf, r.date);
          return [r.id, sched?.working_place ?? null] as const;
        } catch { return [r.id, null] as const; }
      }));
      if (cancelled) return;
      const next: Record<number, string | null> = {};
      for (const [id, place] of entries) next[id] = place;
      setSchedPlaceById(next);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refRecordsKey]);

  // Nearest saved (admin) working place to a point — the no-schedule outstation reference.
  const nearestSavedCoords = useCallback((lat: number, lng: number): { lat: number; lng: number } | null => {
    let best: { lat: number; lng: number } | null = null, bestD = Infinity;
    for (const o of wpOptions) {
      if (o.latitude == null || o.longitude == null) continue;
      const d = distanceMeters(lat, lng, o.latitude, o.longitude);
      if (d < bestD) { bestD = d; best = { lat: o.latitude, lng: o.longitude }; }
    }
    return best;
  }, [wpOptions]);

  // Recompute the outstation flag when a record's working place is edited: the edited place's
  // location vs the day's reference (scheduled place, else nearest saved place). >60km →
  // outstation. null = can't determine (place/reference lacks coordinates).
  const computeOutstationFor = useCallback((recId: number, placeName: string): boolean | null => {
    const c = placeCoords(placeName);
    if (!c) return null;
    const schedName = schedPlaceById[recId];
    const ref = (schedName ? placeCoords(schedName) : null) ?? nearestSavedCoords(c.lat, c.lng);
    if (!ref) return null;
    return distanceMeters(c.lat, c.lng, ref.lat, ref.lng) > 60_000;
  }, [schedPlaceById, placeCoords, nearestSavedCoords]);

  // Splits a raw attendance-edit-requests response into tech/exe buckets by role category —
  // shared by loadAux's one-shot fetch and the southernlanka real-time subscription below.
  const mapEditRequests = useCallback((erd: any): { tech: any[]; exe: any[] } => {
    let techReqs: any[] = [];
    let exeReqs: any[] = [];
    if (Array.isArray(erd?.tech_requests) || Array.isArray(erd?.exe_requests)) {
      techReqs = Array.isArray(erd.tech_requests) ? erd.tech_requests : [];
      exeReqs = Array.isArray(erd.exe_requests) ? erd.exe_requests : [];
    } else {
      const rawRequests = Array.isArray(erd?.requests) ? erd.requests : (Array.isArray(erd) ? erd : []);
      rawRequests.forEach((r: any) => {
        const role = r.user_type || r.role || r.role_name || '';
        const isStaff = !role || roleCategory(role, roles) === 'technician';
        (isStaff ? techReqs : exeReqs).push(r);
      });
    }
    return { tech: techReqs, exe: exeReqs };
  }, [roles]);

  // One-shot: past submissions + edit requests. Not peer-realtime-critical, and refreshed
  // optimistically on action. Merged into `data.past_*` / editRequests.
  const loadAux = useCallback(async () => {
    if (!user?.epf_number) return;
    // Past submissions and edit requests are independent — load them concurrently,
    // each with its own error handling.
    const loadPast = async () => {
    try {
      // Initial window only (previous month + current). Older months are appended by
      // loadOlderPast, never by re-running this — see that handler.
      const pastRes = await attendanceApi.getPastAttendanceApprovalList(user.epf_number!, user?.company ?? '');
      const mappedPastRecords = mapPastRecords(pastRes);
      const pastTech = mappedPastRecords.filter((r: any) => roleCategory(r.user_type, roles) === 'technician');
      const pastExe = mappedPastRecords.filter((r: any) => roleCategory(r.user_type, roles) !== 'technician');
      setData(prev => ({ ...((prev ?? {}) as ApprovalData), past_tech_list: pastTech, past_exe_list: pastExe }));
      const pastStates: Record<number, PastEditState> = {};
      [...pastTech, ...pastExe].forEach(r => { pastStates[r.id] = makePastEditState(r); });
      // Record ids are stable per session, so a refetch mid-edit must not wipe times the
      // approver already typed — keep any existing edit state, add defaults only for new rows.
      setPastEditStates(prev => ({ ...pastStates, ...prev }));
    } catch (e) {
      // Never swallow this silently: an empty "Past Attendance" section is indistinguishable
      // from a failed load, and a failed load leaves every backlog record un-approvable.
      console.error('Past attendance approvals failed to load', e);
      toast.error('Past attendance could not be loaded — refresh to retry.');
    }
    };

    const loadEdits = async () => {
    try {
      const erRes = await attendanceApi.getAttendanceEditRequests(user.epf_number!, user?.company ?? '');
      setEditRequests(mapEditRequests(erRes.data?.data ?? erRes.data));
    } catch (e) { console.error('Edit requests failed to load', e); }
    };

    // Southern Lanka only — see isSouthernlanka above.
    const loadCheckInMethodCounts = async () => {
      if (!isSouthernlanka) return;
      try {
        setCheckInMethodCounts(await attendanceApi.getTodayCheckInMethodCounts(user.epf_number!));
      } catch { /* non-critical */ }
    };

    await Promise.all([loadPast(), loadEdits(), loadCheckInMethodCounts()]);
  }, [user?.epf_number, user?.company, roles, mapEditRequests]);

  // "Load older": widen the past/backlog window by ONE month, reading only the newly added
  // month and merging it in — the months already on screen (and the edit requests, and the
  // check-in counts) are never re-fetched. Rows are deduped by id so a session that is
  // somehow already listed is not doubled.
  const loadOlderPast = useCallback(async () => {
    if (!user?.epf_number || pastLoadingOlder || pastMonthsBack >= PAST_BACKLOG_MAX_MONTHS) return;
    const next = pastMonthsBack + 1;
    setPastLoadingOlder(true);
    try {
      const res = await attendanceApi.getPastAttendanceApprovalList(
        user.epf_number!, user?.company ?? '', { monthsBack: next, olderThanMonthsBack: pastMonthsBack });
      const older = mapPastRecords(res);
      const olderTech = older.filter(r => roleCategory(r.user_type, roles) === 'technician');
      const olderExe  = older.filter(r => roleCategory(r.user_type, roles) !== 'technician');
      const merge = (cur: PastApprovalRecord[] | undefined, add: PastApprovalRecord[]) => {
        const seen = new Set((cur ?? []).map(r => r.id));
        return [...(cur ?? []), ...add.filter(r => !seen.has(r.id))];
      };
      setData(prev => ({
        ...((prev ?? {}) as ApprovalData),
        past_tech_list: merge(prev?.past_tech_list, olderTech),
        past_exe_list:  merge(prev?.past_exe_list, olderExe),
      }));
      setPastEditStates(prev => {
        const add: Record<number, PastEditState> = {};
        older.forEach(r => { if (!prev[r.id]) add[r.id] = makePastEditState(r); });
        return { ...prev, ...add };
      });
      setPastMonthsBack(next);
    } catch (e) {
      console.error('Older past attendance failed to load', e);
      toast.error('Older past attendance could not be loaded — try again.');
    } finally {
      setPastLoadingOlder(false);
    }
  }, [user?.epf_number, user?.company, roles, pastLoadingOlder, pastMonthsBack]);

  // Realtime check-in/checkout lists + pickable rows via Firestore snapshots. The approver's
  // own approve/pick/release fire the listener immediately (optimistic); a technician's new
  // check-in streams in live — no reload, no polling. Heavy context resolved once internally.
  const didInitTab = useRef(false);
  useEffect(() => {
    if (rolesLoaded && user?.capabilities && !caps.can_approve && !canPick && !isSouthernlankaHod && isLocSup === false) { router.replace('/dashboard'); return; }
    if (!user?.epf_number || !rolesLoaded) return;
    let unsub = () => { };
    let cancelled = false;
    setLoading(true);
    attendanceApi.subscribeApprovals(user.epf_number, user?.company ?? '', ({ checkin, pick }: { checkin: any; pick: any[] }) => {
      setData(prev => ({ ...((prev ?? {}) as ApprovalData), ...checkin }));
      setPickRows((pick ?? []) as PickRow[]);
      setLoading(false);
      if (!didInitTab.current) {
        didInitTab.current = true;
        setTab(checkin?.has_technicians && checkin?.has_executives ? 'all' : checkin?.has_technicians ? 'tech' : checkin?.has_executives ? 'exec' : 'edits');
      }
    }).then((u: () => void) => { if (cancelled) u(); else unsub = u; }).catch(() => setLoading(false));
    return () => { cancelled = true; unsub(); };
  }, [user?.epf_number, user?.company, caps.can_approve, canPick, rolesLoaded, router, isLocSup]);

  useEffect(() => { loadAux(); }, [loadAux]);

  // Southern Lanka only — real-time sync for Time Change / Attendance Edit approval requests:
  // a newly submitted request appears in the Edits tab live, and an approver's decision
  // anywhere updates the list instantly, with no manual refresh (see
  // attendanceApi.subscribeAttendanceEditRequests in apiCompat.ts). Fires once immediately
  // with current data — a harmless redundant overlap with loadAux's own initial fetch above —
  // then again on every relevant write.
  useEffect(() => {
    const epf = user?.epf_number;
    if (!isSouthernlanka || !epf) return;
    const unsub = attendanceApiRT.subscribeAttendanceEditRequests(
      epf, user?.company ?? '',
      (raw: unknown[]) => setEditRequests(mapEditRequests({ requests: raw })),
    );
    return () => unsub();
  }, [user?.epf_number, user?.company, mapEditRequests]);

  function makeEditState(r: ApprovalRecord, listType: 'check_in' | 'check_out' | 'both'): EditState {
    const time = r.time ?? localDateTimeString(new Date());
    const checkOutTime = (r as any).check_out_time ?? '';
    const hasCheckIn = listType === 'check_in' || listType === 'both';
    const hasCheckOut = listType === 'check_out' || listType === 'both';
    // For a pure check-out card the single `time` IS the checkout time; for 'both' it's separate.
    const evalCheckoutTime = listType === 'both' ? checkOutTime : time;
    return {
      time,
      check_out_time: checkOutTime,
      working_place: r.working_place ?? '',
      site_no: r.site_no ?? '',
      outstation_name: r.outstation_name ?? '',
      outstation_address: r.outstation_address ?? '',
      is_outstation: !!r.is_outstation,
      is_outstation_approved: !!r.is_outstation,
      morning_allowance: hasCheckIn ? calcMorningAllowance(time) : 0,
      evening_allowance: hasCheckOut ? calcEveningAllowance(evalCheckoutTime) : 0,
    };
  }

  function makePastEditState(r: PastApprovalRecord): PastEditState {
    // Normalize to "YYYY-MM-DD HH:MM:SS" — API may return ISO format with T or microseconds
    const norm = (s: string | null | undefined) => (s ?? '').replace('T', ' ').slice(0, 19);
    return {
      check_in_time: norm(r.check_in_time),
      check_out_time: norm(r.check_out_time),
      working_place: r.working_place ?? '',
      site_no: r.site_no ?? '',
      outstation_name: r.outstation_name ?? '',
      outstation_address: r.outstation_address ?? '',
      is_outstation_approved: !!r.is_outstation,
      // Stored allowances (a picked/approved half may carry a hand-adjusted value) win over
      // the auto-calc from the times.
      morning_allowance: r.morning_allowance ?? calcMorningAllowance(r.check_in_time),
      evening_allowance: r.evening_allowance ?? calcEveningAllowance(r.check_out_time),
    };
  }

  const currentList = tab === 'tech' ? (data?.tech_list ?? []) :
    tab === 'exec' ? (data?.exe_list ?? []) :
    tab === 'all' ? [...(data?.tech_list ?? []), ...(data?.exe_list ?? [])] : [];
  const currentType = tab === 'tech' ? (data?.tech_list_type ?? 'check_in') :
    tab === 'exec' ? (data?.exe_list_type ?? 'check_in') :
    (data?.tech_list_type === data?.exe_list_type ? (data?.tech_list_type ?? 'check_in') : 'both');

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    // Toggle only the currently-visible (filtered) records, preserving any selection outside view.
    const allOn = allTabIds.length > 0 && allTabIds.every(id => selected.has(id));
    setSelected(prev => {
      const n = new Set(prev);
      if (allOn) allTabIds.forEach(id => n.delete(id));
      else allTabIds.forEach(id => n.add(id));
      return n;
    });
  };

  // Each record carries its own check-in/check-out type (a session shows whichever is
  // pending), so approvals are driven per-record, not by a single list type.
  const typeOf = (id: number): 'check_in' | 'check_out' | 'both' =>
    ((currentList as any[]).find(r => (r.attendance_id ?? r.id) === id)?.type) ?? currentType;

  // Approve/reject a mixed set of ids: split by type and call the matching endpoint.
  // A 'both' record (session with check-in AND check-out pending) goes through BOTH calls —
  // check-in first (awaited), then check-out — so the claim order is preserved.
  const submitByType = async (rawIds: number[], rejectMode = false, force = false) => {
    // Hard guard: past/backlog records must NEVER pass through here — with no live edit
    // state, a fabricated one stamped with TODAY's time would overwrite the historic
    // session. They are handled exclusively by handleApprovePast.
    const ids = rawIds.filter(id => !(id in pastEditStates));
    const findRec = (id: number) => (currentList as any[]).find(x => (x.attendance_id ?? x.id) === id);
    const inIds = ids.filter(id => { const ty = typeOf(id); return ty === 'check_in' || ty === 'both'; });
    const outIds = ids.filter(id => { const ty = typeOf(id); return ty === 'check_out' || ty === 'both'; });
    const epf = user?.epf_number ?? '';

    if (inIds.length) {
      const approved_list = inIds.map(id => {
        const rec = findRec(id) as ApprovalRecord;
        const e = editStates[id] ?? makeEditState(rec ?? { attendance_id: id, name: '', epf_number: '' }, 'check_in');
        const inTime = e.time || (force ? `${(rec as any)?.date || todayStr} 08:30:00` : e.time);
        return { id, time: inTime, morning_allowance: e.morning_allowance };
      });
      await attendanceApi.approveCheckIn({ epf_number: epf, approved_list } as Parameters<typeof attendanceApi.approveCheckIn>[0]);
    }
    if (outIds.length) {
      const approved_list = outIds.map(id => {
        const rec = findRec(id) as ApprovalRecord;
        const e = editStates[id] ?? makeEditState(rec ?? { attendance_id: id, name: '', epf_number: '' }, 'check_out');
        // For 'both' the checkout time lives in check_out_time; for a pure check-out it's `time`.
        let outTime = typeOf(id) === 'both' ? (e.check_out_time || e.time) : e.time;
        if (force && (!outTime || !outTime.trim())) {
          outTime = `${(rec as any)?.date || todayStr} 17:00:00`;
        }
        const wp = e.working_place || (rejectMode ? 'Unknown' : (force ? (wpOptions[0]?.name || 'Head Office') : ''));
        const site = e.site_no || (force && requiresSite(wp) ? ((rec as any)?.site_no || 'SITE-01') : null);
        return {
          id, time: outTime, evening_allowance: e.evening_allowance,
          working_place: wp,
          site_no: site,
          is_outstation: rejectMode ? false : !!e.is_outstation,
          is_outstation_approved: rejectMode ? false : !!e.is_outstation,
        };
      });
      await attendanceApi.approveCheckOut({ epf_number: epf, approved_list } as Parameters<typeof attendanceApi.approveCheckOut>[0]);
    }
  };

  const handleConsiderEdit = async (id: number, action: 'approve' | 'reject') => {
    setActKey(`edit-${id}`);
    try {
      await attendanceApi.considerAttendanceEditRequest({
        id,
        epf_number: user?.epf_number ?? '',
        action,
        reject_reason: action === 'reject' ? rejectReason : undefined,
      });
      toast.success(`Edit request ${action === 'approve' ? 'approved' : 'rejected'}`);
      setRejectModal({ open: false, id: null });
      setRejectReason('');
      // Optimistic: drop the handled request from its list (no full reload).
      setEditRequests(prev => ({
        tech: prev.tech.filter((r: any) => r.id !== id),
        exe: prev.exe.filter((r: any) => r.id !== id),
      }));
    } catch (e) { console.error('[approvals] consider edit request failed', e); toast.error('Action failed'); }
    setActKey(null);
  };

  const toggleSelectEdit = (id: number) => setSelectedEdits(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Bulk-approve the selected edit requests (applies each requested correction in turn).
  const handleApproveEdits = async (ids: number[]) => {
    if (ids.length === 0) return;
    setActKey(`edit-bulk-${ids.join('-')}`);
    let ok = 0;
    try {
      for (const id of ids) {
        try {
          await attendanceApi.considerAttendanceEditRequest({
            id, epf_number: user?.epf_number ?? '', action: 'approve',
          });
          ok++;
          // Optimistic: drop each approved request as it succeeds.
          setEditRequests(prev => ({
            tech: prev.tech.filter((r: any) => r.id !== id),
            exe: prev.exe.filter((r: any) => r.id !== id),
          }));
          setSelectedEdits(prev => { const n = new Set(prev); n.delete(id); return n; });
        } catch (e) {
          // Keep going; the shortfall is reported below. Logged because a silent bulk
          // failure is indistinguishable from "nothing was selected" — a permission-denied
          // here means the approver's token is missing its capability claims.
          console.error('[approvals] bulk edit approval failed for', id, e);
        }
      }
      bumpCleared(ok);
      if (ok === ids.length) toast.success(`${ok} edit request${ok > 1 ? 's' : ''} approved`);
      else if (ok > 0) toast.success(`${ok} of ${ids.length} approved — ${ids.length - ok} failed`);
      else toast.error('Approval failed');
    } finally { setActKey(null); }
  };

  // Compare at minute granularity: the time editor is minute-only (applyTimeToDate zeroes
  // seconds), but an unedited check-in keeps its real capture seconds. Comparing full
  // "HH:MM:SS" strings lets a same-minute Out slip past as "different" by a few seconds and
  // then get silently rolled a full day forward by the overnight check below.
  const toMinute = (s: string) => s.slice(0, 16);

  const handleApprovePast = async (ids: number[], opts?: { quiet?: boolean; force?: boolean }): Promise<ApproveResult> => {
    if (ids.length === 0) return { approved: [], failed: [], skips: new Map() };

    const isForce = !!opts?.force;
    const readyIds: number[] = [];
    const skipReasons = new Map<string, number>();
    const skip = (reason: string) => skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
    const healedUpdates: Record<number, PastEditState> = {};

    for (const id of ids) {
      let s = pastEditStates[id];
      const rec = rawPastList.find(r => r.id === id) || (currentList as any[]).find(r => (r.attendance_id ?? r.id) === id);
      const recDate = rec?.date || s?.check_in_time?.slice(0, 10) || s?.check_out_time?.slice(0, 10) || todayStr;

      if (!s) {
        if (rec && 'check_in_time' in rec) {
          s = makePastEditState(rec as PastApprovalRecord);
        } else {
          s = {
            check_in_time: `${recDate} 08:30:00`,
            check_out_time: `${recDate} 17:00:00`,
            working_place: wpOptions[0]?.name || 'Head Office',
            site_no: '',
            outstation_name: '',
            outstation_address: '',
            is_outstation_approved: false,
            morning_allowance: 0,
            evening_allowance: 0,
          };
        }
      }

      if (isForce) {
        let inTime = s.check_in_time;
        if (!inTime || !inTime.trim()) {
          inTime = `${recDate} 08:30:00`;
        }
        let outTime = s.check_out_time;
        if (!outTime || !outTime.trim() || toMinute(outTime) === toMinute(inTime)) {
          outTime = `${recDate} 17:00:00`;
          if (toMinute(outTime) === toMinute(inTime)) {
            outTime = `${recDate} 17:30:00`;
          }
        }
        let wp = s.working_place;
        if (!wp || !wp.trim()) {
          wp = rec?.working_place || wpOptions[0]?.name || 'Head Office';
        }
        let site = s.site_no;
        if (requiresSite(wp) && (!site || !site.trim())) {
          site = rec?.site_no || 'SITE-01';
        }
        const healed: PastEditState = {
          ...s,
          check_in_time: inTime,
          check_out_time: outTime,
          working_place: wp,
          site_no: site,
          morning_allowance: s.morning_allowance ?? calcMorningAllowance(inTime),
          evening_allowance: s.evening_allowance ?? calcEveningAllowance(outTime),
        };
        pastEditStates[id] = healed;
        healedUpdates[id] = healed;
        s = healed;
      }

      if (!s?.check_in_time) { skip('missing check-in time'); continue; }
      if (!s?.check_out_time) { skip('missing checkout'); continue; }
      // A zero-length session is never real — typical of stranded records whose checkout
      // was auto-filled with the check-in time. Force a real Out time before approving.
      if (toMinute(s.check_out_time) === toMinute(s.check_in_time)) {
        skip('checkout equals check-in'); continue;
      }
      if (!s?.working_place) { skip('missing working place'); continue; }
      if (requiresSite(s.working_place) && !s.site_no) {
        skip('missing site number'); continue;
      }
      readyIds.push(id);
    }

    if (Object.keys(healedUpdates).length > 0) {
      setPastEditStates(prev => ({ ...prev, ...healedUpdates }));
    }

    if (readyIds.length === 0) {
      if (!opts?.quiet) toast.error(`No records approved — ${ids.length} skipped (${[...skipReasons.entries()].map(([r, n]) => `${n} ${r}`).join(', ')})`);
      return { approved: [], failed: [], skips: skipReasons };
    }

    // Out before In (same-day editor) is stored as a next-day checkout — computed here so
    // the approver is told, but the toast fires only after the write actually succeeds.
    const overnightCount = readyIds.filter(id =>
      toMinute(pastEditStates[id].check_out_time) < toMinute(pastEditStates[id].check_in_time)).length;

    const key = `approve-past-${readyIds.join('-')}`;
    setActKey(key);
    try {
      const payload = {
        epf_number: user?.epf_number ?? '',
        approved_list: readyIds.map(id => ({
          id,
          ...pastEditStates[id]
        }))
      };
      await attendanceApi.approvePastAttendance(payload as Parameters<typeof attendanceApi.approvePastAttendance>[0]);
      if (!opts?.quiet) {
        toast.success(`${readyIds.length} past record${readyIds.length > 1 ? 's' : ''} approved`);
        if (overnightCount > 0) {
          toast(`${overnightCount} record${overnightCount > 1 ? 's' : ''} saved as overnight (check-out next day)`);
        }
        if (skipReasons.size > 0) {
          const skippedCount = ids.length - readyIds.length;
          toast.error(`${skippedCount} record${skippedCount > 1 ? 's' : ''} not approved (${[...skipReasons.entries()].map(([r, n]) => `${n} ${r}`).join(', ')})`);
        }
      }
      // Optimistic: drop approved past records (no full reload).
      setData(prev => prev ? {
        ...prev,
        past_tech_list: (prev.past_tech_list ?? []).filter(r => !readyIds.includes(r.id)),
        past_exe_list: (prev.past_exe_list ?? []).filter(r => !readyIds.includes(r.id)),
      } : prev);
      // Surgical: drop only the processed ids, preserving any selection on the other tab or
      // hidden by the current search filter (the toolbar's own contract — see allTabIds).
      setSelected(prev => { const n = new Set(prev); readyIds.forEach(id => n.delete(id)); return n; });
      return { approved: readyIds, failed: [], skips: skipReasons };
    } catch {
      if (!opts?.quiet) toast.error('Approval failed');
      return { approved: [], failed: readyIds, skips: skipReasons };
    } finally {
      setActKey(null);
    }
  };

  const handleApprove = async (ids: number[], opts?: { quiet?: boolean; force?: boolean }): Promise<ApproveResult> => {
    if (ids.length === 0) {
      if (!opts?.quiet) toast.error('No records selected');
      return { approved: [], failed: [], skips: new Map() };
    }
    // Select-all mixes live records with past/backlog ones — route each id to its own
    // flow. Past ids must never reach submitByType (it would fabricate an edit state
    // stamped with today's time and overwrite the historic session).
    const pastIds = ids.filter(id => id in pastEditStates);
    const liveIds = ids.filter(id => !(id in pastEditStates));
    const approved: number[] = [];
    const failed: number[] = [];
    let skips = new Map<string, number>();
    if (liveIds.length > 0) {
      const key = `approve-${liveIds.join('-')}`;
      setActKey(key);
      try {
        await submitByType(liveIds, false, !!opts?.force);
        approved.push(...liveIds);
        if (!opts?.quiet) toast.success(`${liveIds.length} record${liveIds.length > 1 ? 's' : ''} approved`);
        // The realtime listener removes the approved records; just drop them from the selection.
        setSelected(prev => { const n = new Set(prev); liveIds.forEach(id => n.delete(id)); return n; });
      } catch {
        failed.push(...liveIds);
        if (!opts?.quiet) toast.error('Approval failed');
      }
      setActKey(null);
    }
    if (pastIds.length > 0) {
      const res = await handleApprovePast(pastIds, opts);
      approved.push(...res.approved);
      // Anything the past flow skipped for a data problem is a failure from the caller's point
      // of view: it is still pending and must stay ticked.
      failed.push(...pastIds.filter(id => !res.approved.includes(id)));
      skips = res.skips;
    }
    bumpCleared(approved.length);
    return { approved, failed, skips };
  };

  // How many ids go into one approve call when clearing a whole backlog. Small enough that a
  // failure costs one batch, not the run.
  const BACKLOG_BATCH = 20;

  // Approve the entire pre-today backlog. Runs the SAME handleApprove path as every other
  // approve on this page (no new service call), one batch at a time, and never lets a bad batch
  // strand the rest — failures are collected, summarised once, and left ticked for a retry.
  const handleApproveBacklogAll = async (ids: number[], force = false) => {
    if (ids.length === 0 || backlogRunning) return;
    setBacklogRunning(true);
    setBacklogProgress(`0 of ${ids.length}`);
    const failedAll: number[] = [];
    const skipTotals = new Map<string, number>();
    let done = 0;
    let ok = 0;
    try {
      for (let i = 0; i < ids.length; i += BACKLOG_BATCH) {
        const chunk = ids.slice(i, i + BACKLOG_BATCH);
        const res = await handleApprove(chunk, { quiet: true, force });
        const approvedSet = new Set(res.approved);
        ok += res.approved.length;
        failedAll.push(...chunk.filter(id => !approvedSet.has(id)));
        res.skips.forEach((n, reason) => skipTotals.set(reason, (skipTotals.get(reason) ?? 0) + n));
        done += chunk.length;
        setBacklogProgress(`${done} of ${ids.length}`);
      }
      if (ok > 0) toast.success(`${ok} of ${ids.length} approved`);
      if (failedAll.length > 0) {
        const why = skipTotals.size > 0
          ? ` (${[...skipTotals.entries()].map(([r, n]) => `${n} ${r}`).join(', ')})`
          : '';
        toast.error(`${failedAll.length} not approved${why} — still selected`);
        setSelected(prev => { const n = new Set(prev); failedAll.forEach(id => n.add(id)); return n; });
      }
    } finally {
      setBacklogRunning(false);
      setBacklogProgress(null);
    }
  };

  // "Approve this day" on a day separator — same path, plus a per-day busy flag so only that
  // separator's button spins.
  const handleApproveDay = async (key: string, ids: number[]) => {
    setApprovingDayKey(key);
    try { await handleApprove(ids); } finally { setApprovingDayKey(null); }
  };

  const handleReject = async (ids: number[]) => {
    if (ids.length === 0) { toast.error('No records selected'); return; }
    // Past/backlog records have no reject flow — delete them from the employee's monthly
    // view instead. Only live records go through the reject endpoints.
    const pastIds = ids.filter(id => id in pastEditStates);
    const liveIds = ids.filter(id => !(id in pastEditStates));
    if (pastIds.length > 0) {
      toast(`${pastIds.length} past record${pastIds.length > 1 ? 's' : ''} skipped — remove past attendance from the employee's monthly view instead`);
    }
    if (liveIds.length === 0) return;
    const key = `reject-${liveIds.join('-')}`;
    setActKey(key);
    try {
      // Rejection reuses the approve endpoints (backend records the approver); per-record
      // type is honored so a mixed check-in/check-out batch is handled correctly.
      await submitByType(liveIds, true);
      toast.success(`${liveIds.length} record${liveIds.length > 1 ? 's' : ''} rejected`);
      setSelected(prev => { const n = new Set(prev); liveIds.forEach(id => n.delete(id)); return n; });
    } catch { toast.error('Rejection failed'); }
    setActKey(null);
  };

  // ─── Pick / release (Staff tab) ───────────────────────────────────────────
  const handlePickRow = async (
    docId: string, sessionId: string, name: string,
    edits?: { checkInTime?: string; morningAllowance?: number },
  ) => {
    setPickBusyId(sessionId);
    try {
      const res = await attendanceApi.pickTechnician({
        supervisorEpf: myEpf, supervisorName: user?.name ?? '',
        docId, sessionId,
        checkInTime: edits?.checkInTime,
        morningAllowance: edits?.morningAllowance,
      } as Parameters<typeof attendanceApi.pickTechnician>[0]);
      toast.success((res as any)?.data?.approved ? `Picked ${name} — check-in approved` : `${name} added to your team`);
      // The realtime listener reflects the pick instantly — no reload.
    } catch (e) { toast.error((e as Error)?.message ?? 'Failed to pick'); }
    finally { setPickBusyId(null); }
  };

  // Pick a pending-check-in record from the approvals list (resolves the session via the
  // id map, and uses the card's edited check-in time + allowance — same as the first pick).
  const handlePickRecord = (recId: number) => {
    const target = (typeof window !== 'undefined')
      ? (window as Window & { __attIdMap?: Record<number, { docId: string; sessionId: string }> }).__attIdMap?.[recId]
      : undefined;
    if (!target) { toast.error('Could not resolve this session'); return; }
    const rec = (currentList as any[]).find(r => (r.attendance_id ?? r.id) === recId);
    const e = editStates[recId];
    handlePickRow(target.docId, target.sessionId, rec?.name ?? '', { checkInTime: e?.time, morningAllowance: e?.morning_allowance });
  };

  const handleRelease = async (row: PickRow) => {
    setPickBusyId(row.sessionId);
    try {
      await attendanceApi.releaseTechnician({ supervisorEpf: myEpf, docId: row.docId, sessionId: row.sessionId });
      toast.success(`Released ${row.name}`);
      // The realtime listener reflects the release instantly — no reload.
    } catch (e) { toast.error((e as Error)?.message ?? 'Failed to release'); }
    finally { setPickBusyId(null); }
  };

  const handleReleaseRecord = async (recId: number) => {
    const target = (typeof window !== 'undefined')
      ? (window as Window & { __attIdMap?: Record<number, { docId: string; sessionId: string }> }).__attIdMap?.[recId]
      : undefined;
    if (!target) { toast.error('Could not resolve this session'); return; }
    const rec = (currentList as any[]).find(r => (r.attendance_id ?? r.id) === recId);
    setPickBusyId(target.sessionId);
    try {
      await attendanceApi.releaseTechnician({ supervisorEpf: myEpf, docId: target.docId, sessionId: target.sessionId });
      toast.success(`Released ${rec?.name ?? 'technician'}`);
    } catch (e) {
      toast.error((e as Error)?.message ?? 'Failed to release');
    } finally {
      setPickBusyId(null);
    }
  };

  // Release a whole claimed team back to its original leader (the inverse of Pick team), so it
  // becomes available for anyone to pick again.
  const handleReleaseTeam = async (leaderEpf: string) => {
    setPickBusyId(`team-${leaderEpf}`);
    try {
      await attendanceApi.releaseTeam({ supervisorEpf: myEpf, leaderEpf, date: todayStr });
      toast.success('Team released');
    } catch (e) {
      toast.error((e as Error)?.message ?? 'Failed to release team');
    } finally {
      setPickBusyId(null);
    }
  };

  // Location supervisor ends a shift worker's shift early (marks it closed; no check-out set).
  const requestEndShift = (recId: number) => {
    const rec = (currentList as any[]).find(r => (r.attendance_id ?? r.id) === recId);
    setConfirmEndShift({ recId, name: rec?.name ?? 'this shift worker' });
  };

  const handleEndShift = async (recId: number) => {
    const target = (typeof window !== 'undefined')
      ? (window as Window & { __attIdMap?: Record<number, { docId: string; sessionId: string }> }).__attIdMap?.[recId]
      : undefined;
    if (!target) { toast.error('Could not resolve this session'); return; }
    const rec = (currentList as any[]).find(r => (r.attendance_id ?? r.id) === recId);
    setEndShiftBusyId(recId);
    try {
      await attendanceApi.endShift({ supervisorEpf: myEpf, docId: target.docId, sessionId: target.sessionId });
      toast.success(`Shift ended for ${rec?.name ?? 'shift worker'}`);
    } catch (e) {
      toast.error((e as Error)?.message ?? 'Failed to end shift');
    } finally {
      setEndShiftBusyId(null);
    }
  };

  // Pick / My-Team derived lists (Staff tab, pickers only).
  const myTeam = pickRows.filter(r => String(r.picked_by ?? '') === myEpf);
  // Original team leaders present in my team (members claimed via "Pick team" carry their leader
  // in team_leader_epf) → used to group My team into teams under each leader.
  const myTeamLeaderEpfs = new Set(
    (myTeam as any[]).map(r => (r as any).team_leader_epf).filter(Boolean).map(String),
  );
  // Order My team so claimed teams come first and my own direct picks trail last (their
  // "Individually picked" group sits at the bottom).
  const myTeamOrdered = [...(myTeam as any[])].sort((a, b) => {
    const aSelf = !a.team_leader_epf && !myTeamLeaderEpfs.has(String(a.epf_number)) ? 1 : 0;
    const bSelf = !b.team_leader_epf && !myTeamLeaderEpfs.has(String(b.epf_number)) ? 1 : 0;
    return aSelf - bSelf;
  });
  // Members already picked by each team leader (grouped by picker EPF) → used to show a leader's
  // team nested under them in the Available-to-pick pool, so an executive sees the whole team.
  const membersByLeader = new Map<string, any[]>();
  for (const r of pickRows as any[]) {
    const pb = r.picked_by ? String(r.picked_by) : '';
    if (!pb) continue;
    const arr = membersByLeader.get(pb);
    if (arr) arr.push(r); else membersByLeader.set(pb, [r]);
  }
  // Already-picked people grouped by their picker → shown at the end of the pool so OTHER teams'
  // rosters are visible group-wise, not only via search. My own team is excluded here — it lives
  // in the "My team" sub-tab.
  const pickerGroups = [...membersByLeader.entries()]
    .filter(([epf]) => epf !== myEpf)
    .map(([epf, members]) => ({
      epf,
      name: (members[0] as any)?.picked_by_name ?? 'Picked',
      members,
    }));
  // Any picker — a pick-only team leader OR a full technician-approver (can_approve_technicians) —
  // can ALWAYS pick any unpicked technician in scope, whoever approved them (pending ones show in
  // the list above, approved ones here). Non-pickers fall back to their own "approved by me" pool.
  const availableToPick = pickRows.filter(r =>
    r.pickable && !r.picked_by && !r.check_out && r.check_in_status === 'approved'
    && (canPick || String(r.check_in_approved_by ?? '') === myEpf));
  const showStaffPick = tab === 'tech' && canPick;
  // In the Staff (tech) tab or All tab, only full approvers may approve; pick-only team leaders can pick
  // but not approve. Executive/edit tabs are unaffected. Southern Lanka has no Pick feature at
  // all (see canPick above), so that distinction doesn't apply there — a technician surfacing
  // in this tab already means the viewer is its department HOD or ladder approver (see
  // apiCompat.ts buildCheckinResult), which is authority enough to approve it.
  const approveEnabled = tab === 'exec' ? true : (isSouthernlanka || canApproveTech);

  const hasTech = !!(data?.has_technicians);
  const hasExec = !!(data?.has_executives);
  const techList = data?.tech_list ?? [];
  const exeList = data?.exe_list ?? [];
  const techType = data?.tech_list_type ?? 'check_in';
  const exeType = data?.exe_list_type ?? 'check_in';
  // A list can mix types (some sessions check-in only, some have both) — when it isn't a single
  // clear type, label it generically as "Pending".
  const labelForType = (ty: string) => ty === 'check_in' ? 'Check-in' : ty === 'check_out' ? 'Check-out' : 'Pending';
  const techLabel = labelForType(techType);
  const exeLabel = labelForType(exeType);

  // Search filters the pending approval records (Staff/Executive tabs) by name, EPF or working
  // place — applied to BOTH today's and past lists so results span all dates. Multi-select and
  // bulk approve/reject then work on the filtered records exactly as in the normal view.
  const isSearching = searchQuery.trim().length > 0;
  const sq = searchQuery.trim().toLowerCase();
  const matchesSearch = (r: any) => !isSearching
    || String(r.name ?? '').toLowerCase().includes(sq)
    || String(r.epf_number ?? '').toLowerCase().includes(sq)
    || String(r.working_place ?? '').toLowerCase().includes(sq);

  const rawPastList = tab === 'tech' ? (data?.past_tech_list ?? []) :
    tab === 'exec' ? (data?.past_exe_list ?? []) :
    tab === 'all' ? [...(data?.past_tech_list ?? []), ...(data?.past_exe_list ?? [])] : [];
  const pastTabList = rawPastList.filter(matchesSearch);
  // Split the live list by date: genuinely-today sessions vs earlier-dated ones (e.g. an
  // overnight check-out still pending from yesterday). Both go into the one queue; the split
  // survives only as the Today / Past scope filter and the backlog card's counts.
  const todayPending = (currentList as any[]).filter(r => (!r.date || r.date === todayStr) && matchesSearch(r));
  const earlierPending = (currentList as any[]).filter(r => r.date && r.date !== todayStr && matchesSearch(r));

  // ── The one prioritised queue ────────────────────────────────────────────────
  // Today's sessions, earlier-dated sessions and back-dated submissions in a single list:
  // problems first (when the toggle is on), then oldest day first, then name. The Today / Past
  // scope chips filter it; they no longer split it into separately-rendered sections.
  const queueAll = buildApprovalQueue({
    live: [...(showToday ? todayPending : []), ...(showPast ? earlierPending : [])],
    past: showPast ? pastTabList : [],
    todayStr,
    problemsFirst: issuesFirst,
  });
  const queueItems = problemsOnly ? queueAll.filter(it => it.issues.length > 0) : queueAll;
  const queueIds = queueItems.map(it => it.id);
  // Team leaders that picked ≥1 person in the queue's live rows → used to group the Staff
  // queue into teams (leader + their picked technicians) under the day they belong to.
  const pickedLeaderEpfs = new Set(
    queueItems.filter(it => it.kind === 'live').map(it => it.record.picked_by).filter(Boolean).map(String),
  );
  // Bulk-selection covers exactly what the queue is showing, so "Select all" during a search
  // (or with a triage tile active) selects only those records.
  const allTabIds = queueIds;
  const visiblePendingCount = todayPending.length + earlierPending.length + pastTabList.length;
  // Bulk actions operate ONLY on visible (filtered) selected records — so a search + Select all +
  // Approve never touches records hidden by the current filter.
  const selectedIds = allTabIds.filter(id => selected.has(id));
  const allSelected = allTabIds.length > 0 && selectedIds.length === allTabIds.length;
  const someSelected = selectedIds.length > 0 && !allSelected;

  // ── Prior months vs this month ───────────────────────────────────────────────
  const currentMonthStart = todayStr.slice(0, 7) + '-01';

  // Queue item splitting by prior months (< currentMonthStart) vs this month (>= currentMonthStart)
  const itemDate = (it: QueueItem) => it.date || (it.kind === 'past' ? it.record?.date : '') || todayStr;
  const isPriorMonthItem = (it: QueueItem) => itemDate(it) < currentMonthStart;
  const isThisMonthItem = (it: QueueItem) => itemDate(it) >= currentMonthStart;

  const priorMonthQueueItems = queueItems.filter(isPriorMonthItem);
  const thisMonthQueueItems = queueItems.filter(isThisMonthItem);
  const priorMonthIds = priorMonthQueueItems.map(it => it.id);
  const thisMonthIds = thisMonthQueueItems.map(it => it.id);

  const isPriorOnlySelected = priorMonthIds.length > 0 && selectedIds.length === priorMonthIds.length && priorMonthIds.every(id => selected.has(id));
  const isThisOnlySelected = thisMonthIds.length > 0 && selectedIds.length === thisMonthIds.length && thisMonthIds.every(id => selected.has(id));

  // ── Triage tiles ─────────────────────────────────────────────────────────────
  // The tiles describe the people queue (tech, exec, or all) — unfiltered by the search box, because
  // they are what tells you whether searching is even the right move. On the Edits tab they
  // keep describing the people tab you came from, so clicking one takes you back to it.
  const tileLive = (lastPeopleTab === 'tech' ? (data?.tech_list ?? []) :
    lastPeopleTab === 'exec' ? (data?.exe_list ?? []) :
    [...(data?.tech_list ?? []), ...(data?.exe_list ?? [])]) as any[];
  const tilePast = lastPeopleTab === 'tech' ? (data?.past_tech_list ?? []) :
    lastPeopleTab === 'exec' ? (data?.past_exe_list ?? []) :
    [...(data?.past_tech_list ?? []), ...(data?.past_exe_list ?? [])];
  
  // Prior months backlog strictly (NOT this month):
  const priorMonthLive = tileLive.filter(r => r.date && String(r.date) < currentMonthStart);
  const priorMonthPast = tilePast.filter(r => (r.date ? String(r.date) < currentMonthStart : true));
  const priorMonthRecords = [...priorMonthLive, ...priorMonthPast];

  const needsYouCount = tileLive.length + tilePast.length;
  const problemsCount = tileLive.filter(r => getRecordIssues(r as any).length > 0).length;
  const backlogCount = priorMonthRecords.length;
  const backlogOldest = priorMonthRecords
    .map((r: any) => String(r.date ?? ''))
    .filter(Boolean)
    .sort()[0] ?? '';
  // Every id waiting from prior months strictly (NOT this month):
  const backlogIds = [
    ...(currentList as any[]).filter(r => r.date && String(r.date) < currentMonthStart).map(r => r.attendance_id ?? r.id),
    ...rawPastList.filter(r => !r.date || String(r.date) < currentMonthStart).map(r => r.id),
  ];

  // Tech ID set for distinguishing tech vs exec in the All tab
  const techIds = useMemo(() => {
    const ids = new Set<number>();
    (data?.tech_list ?? []).forEach(r => ids.add(r.attendance_id ?? (r as any).id));
    (data?.past_tech_list ?? []).forEach(r => ids.add(r.id));
    return ids;
  }, [data?.tech_list, data?.past_tech_list]);

  // ── Keyboard review (desktop, queue tabs only) ───────────────────────────────
  const focusedQueueId = tab === 'tech' ? selTech : tab === 'exec' ? selExec : selAll;
  const setFocusedQueueId = (id: number | null) => (tab === 'tech' ? setSelTech : tab === 'exec' ? setSelExec : setSelAll)(id);
  useApprovalKeyboard({
    enabled: !loading && (tab === 'all' || tab === 'tech' || tab === 'exec') && queueItems.length > 0,
    ids: queueIds,
    focusedId: focusedQueueId,
    onFocus: (id) => setFocusedQueueId(id),
    onToggleCheck: (id) => toggleSelect(id),
    onApprove: (id) => { if (approveEnabled) void handleApprove([id]); },
    onReject: (id) => {
      const it = queueItems.find(x => x.id === id);
      // Back-dated records have no reject path (they are removed from the monthly view
      // instead), so 'r' does nothing on one rather than pretending.
      if (it && it.kind === 'live') setConfirmReject({ ids: [id], name: it.name });
    },
    onClearSelection: () => setSelected(new Set()),
  });

  if (user?.capabilities && !caps.can_approve && !canPick && !isSouthernlankaHod && isLocSup === false) return null;

  // Initial load — a skeleton in the shape of what actually arrives (triage strip, then the
  // two-pane queue), not a flat list that promises the wrong layout.
  if (loading && !data) return <ApprovalsSkeleton />;

  const editReqCount = editRequests.tech.length + editRequests.exe.length;
  // Merged edit-request list for the master–detail edits tab.
  const editReqList = [
    ...editRequests.tech.map(r => ({ ...r, group: 'Technician' })),
    ...editRequests.exe.map(r => ({ ...r, group: 'Executive' })),
  ];
  // Role filter (all / technicians only / executives only) — applied before the search query.
  const roleFilteredEditReqList = editRoleFilter === 'tech'
    ? editReqList.filter((r: any) => r.group === 'Technician')
    : editRoleFilter === 'exec'
      ? editReqList.filter((r: any) => r.group === 'Executive')
      : editReqList;
  // Edits-tab search: match name, EPF, or working place (current or requested).
  const editQuery = searchQuery.trim().toLowerCase();
  const filteredEditReqList = editQuery
    ? roleFilteredEditReqList.filter((r: any) => {
        const place = [r.current?.working_place, r.requested?.working_place]
          .filter(Boolean).join(' ').toLowerCase();
        return (r.name ?? '').toLowerCase().includes(editQuery)
          || String(r.epf_number ?? '').toLowerCase().includes(editQuery)
          || place.includes(editQuery);
      })
    : roleFilteredEditReqList;
  // Bulk-select bookkeeping for the edits tab (scoped to what's currently visible/filtered).
  const editIds = filteredEditReqList.map((r: any) => r.id as number);
  const selectedEditIds = editIds.filter(id => selectedEdits.has(id));
  const allEditsSelected = editIds.length > 0 && selectedEditIds.length === editIds.length;
  const someEditsSelected = selectedEditIds.length > 0 && !allEditsSelected;
  const toggleSelectAllEdits = () => setSelectedEdits(prev => {
    const next = new Set(prev);
    if (editIds.length > 0 && editIds.every(id => next.has(id))) editIds.forEach(id => next.delete(id));
    else editIds.forEach(id => next.add(id));
    return next;
  });
  // ── Detail pane for one queue row ────────────────────────────────────────────
  // RecordCard / PastRecordCard are unchanged; they gain a header strip above them so the two
  // decisions sit at the top of the pane as well as inside the card.
  const renderQueueDetail = (item: QueueItem) => {
    if (item.kind === 'past') {
      const record = item.record as PastApprovalRecord;
      const edit = pastEditStates[record.id] ?? makePastEditState(record);
      const isShift = placeHasTag(edit.working_place, 'shift');
      return (
        <div className="space-y-3">
          <ApprovalsDetailHeader
            name={record.name}
            epf={record.epf_number}
            date={record.date}
            phone={record.phone}
            role={record.user_type}
            workingPlace={edit.working_place}
            siteNo={edit.site_no}
            isShiftWorker={isShift}
            isOutstation={edit.is_outstation_approved || record.is_outstation}
            issues={item.issues}
            onApprove={approveEnabled ? () => handleApprove([record.id]) : undefined}
            approving={actKey === `approve-past-${record.id}`}
            busy={!!actKey}
          />
          <PastRecordCard
            record={record}
            edit={edit}
            setEdit={e => setPastEditStates(prev => ({ ...prev, [record.id]: e }))}
            isTech={tab === 'tech' || (tab === 'all' && techIds.has(record.id))}
          />
        </div>
      );
    }

    const record = item.record as ApprovalRecord;
    const recId = item.id;
    const recType = (record as any).type ?? currentType;
    const isPastDate = !!(record as any).date && (record as any).date !== todayStr;
    const edit = editStates[recId] ?? makeEditState(record, recType);
    const isShiftWorker = (record as any).is_shift_worker || placeHasTag(edit.working_place, 'shift');

    return (
      <div className="space-y-3">
        <ApprovalsDetailHeader
          name={record.name}
          epf={record.epf_number}
          date={(record as any).date}
          phone={record.phone}
          role={(record as any).role ?? (record as any).user_type}
          workingPlace={edit.working_place}
          siteNo={edit.site_no}
          isShiftWorker={isShiftWorker}
          isOutstation={edit.is_outstation ?? record.is_outstation}
          pickedByName={(record as any).picked_by_name}
          pickedAt={(record as any).picked_at}
          issues={item.issues}
          onApprove={approveEnabled ? () => handleApprove([recId]) : undefined}
          onReject={() => handleReject([recId])}
          approving={actKey === `approve-${recId}`}
          busy={!!actKey}
          onPick={showStaffPick && !isPastDate && recType === 'check_in' ? () => handlePickRecord(recId) : undefined}
          pickBusy={pickBusyId != null}
          pickLabel={canApproveTech ? (t.pickAndApprove ?? 'Pick & Approve') : (t.pickToTeam ?? 'Pick')}
          onRelease={(record as any).picked_by ? () => handleReleaseRecord(recId) : undefined}
          releaseBusy={pickBusyId != null}
          onEndShift={isShiftWorker ? () => requestEndShift(recId) : undefined}
          endShiftBusy={endShiftBusyId === recId}
        />
        <RecordCard
          record={record}
          listType={recType}
          edit={edit}
          setEdit={e => setEditStates(prev => ({ ...prev, [recId]: e }))}
          isTech={tab === 'tech' || (tab === 'all' && techIds.has(recId))}
          computeOutstation={(name) => computeOutstationFor(recId, name)}
        />
      </div>
    );
  };

  // ── The triage strip ─────────────────────────────────────────────────────────
  // Leaving the Edits tab for a people tab is a queue change, so it clears both selections
  // exactly as the tab row does.
  const goPeopleTab = () => {
    if (tab === 'edits') { setTab(lastPeopleTab); setSelected(new Set()); setSelectedEdits(new Set()); }
  };
  // English fallbacks throughout the tiles — there are no translation keys for the triage
  // vocabulary, and appStore is owned elsewhere.
  const triageTiles: TriageTile[] = [
    {
      id: 'needs',
      label: 'Needs you',
      count: needsYouCount,
      hint: needsYouCount > 0 ? 'pending in your scope' : 'nothing waiting on you',
      icon: ListChecks,
      tone: 'primary',
      active: tab !== 'edits' && !problemsOnly && scope === 'all',
      onSelect: () => { goPeopleTab(); setProblemsOnly(false); setScope('all'); },
    },
    {
      id: 'problems',
      label: 'Problems',
      count: problemsCount,
      hint: problemsCount > 0 ? 'missing GPS, outside radius, outstation' : 'nothing flagged',
      icon: AlertTriangle,
      tone: 'destructive',
      active: tab !== 'edits' && problemsOnly,
      onSelect: () => { goPeopleTab(); setScope('all'); setProblemsOnly(v => !v); },
    },
    {
      id: 'backlog',
      label: 'Backlog',
      count: backlogCount,
      hint: backlogCount > 0
        ? (backlogOldest ? `oldest ${formatDate(backlogOldest)}` : 'waiting from before today')
        : 'nothing older than today',
      icon: History,
      tone: 'warning',
      active: tab !== 'edits' && scope === 'past',
      onSelect: () => { goPeopleTab(); setProblemsOnly(false); setScope(scope === 'past' ? 'all' : 'past'); },
    },
    {
      id: 'edits',
      label: 'Edit requests',
      count: editReqCount,
      hint: editReqCount > 0 ? 'time and place corrections' : 'none open',
      icon: FileEdit,
      tone: 'brand',
      active: tab === 'edits',
      onSelect: () => { if (tab !== 'edits') { setTab('edits'); setSelected(new Set()); setSelectedEdits(new Set()); } },
    },
  ];

  // One line of plain English: what is on screen, and the rule it is ordered by. The sort is
  // stated rather than implied, so "Problems first" being on by default is never a surprise.
  const queueSummary = tab === 'edits'
    ? `Showing ${filteredEditReqList.length} edit request${filteredEditReqList.length === 1 ? '' : 's'}${editQuery ? ` matching "${searchQuery.trim()}"` : ''}`
    : [
        `Showing ${queueItems.length} pending`,
        issuesFirst ? 'problems first, then oldest first' : 'oldest first',
        scope === 'today' ? 'today only' : scope === 'past' ? 'before today only' : null,
        problemsOnly ? 'problems only' : null,
        isSearching ? `matching "${searchQuery.trim()}"` : null,
      ].filter(Boolean).join(' · ');

  const queueEmptyState = (
    <EmptyState
      icon={problemsOnly ? AlertTriangle : CheckCircle}
      title={problemsOnly ? 'No problems in this queue' : 'All caught up!'}
      description={problemsOnly
        ? 'Nothing here is flagged. Clear the Problems filter to see the rest.'
        : scope === 'past' ? 'Everything older than today is approved.' : 'No pending approvals'}
    />
  );

  return (
    <PageTransition className="space-y-5 pb-28 lg:pb-6">
      <PageHeader
        title={t.approvalsTitle}
        description={t.approvalsDesc}
        icon={ClipboardCheck}
      />

      {/* WHAT needs doing: four slices of the queue, each one a filter. */}
      <Reveal>
        <ApprovalsTriageBar
          tiles={triageTiles}
          summary={queueSummary}
          aside={isSouthernlanka && checkInMethodCounts ? (
            /* Southern Lanka auto-approves check-in/checkout, so there is no pending count to
               show for it — today's channel split is the useful number instead. */
            <span className="inline-flex items-center gap-3">
              <span className="inline-flex items-center gap-1"><Smartphone className="h-3 w-3" />{checkInMethodCounts.mobile} mobile</span>
              <span className="inline-flex items-center gap-1"><Fingerprint className="h-3 w-3" />{checkInMethodCounts.fingerprint} fingerprint</span>
              <span className="inline-flex items-center gap-1"><ScanFace className="h-3 w-3" />{checkInMethodCounts.face} face</span>
            </span>
          ) : undefined}
        />
      </Reveal>

      {/* WHO the queue is about: tabs, demoted to a compact segmented control beside search. */}
      <Reveal>
        <div className="flex flex-col gap-2 rounded-2xl border border-border/50 bg-muted/20 p-2 lg:flex-row lg:items-center lg:justify-between">
          <Tabs
            value={tab}
            onValueChange={(v) => { setTab(v as 'all' | 'tech' | 'exec' | 'edits'); setSelected(new Set()); setSelectedEdits(new Set()); }}
            className="w-full lg:w-auto"
          >
            {/* flex-none (never flex-1) on every trigger + overflow-x-auto on the row itself —
                on a narrow phone these four labels ("Edit requests" alone runs ~110px) don't
                fit without either wrapping or shrinking, and flex-1 tried to force an even
                squeeze that whitespace-nowrap content refuses to shrink below, so the row grew
                wider than the card and the last tab visibly clipped past its right edge. Natural
                width + horizontal scroll (thumb hidden, same as the rest of this app's compact
                strips — see .scrollbar-none in globals.css) keeps every label fully readable
                instead of truncating or overflowing the card. */}
            <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto scrollbar-none p-1 sm:w-fit">
              {hasTech && hasExec && (
                <TabsTrigger value="all" className="flex-none px-3 py-1.5">
                  <Layers className="h-3.5 w-3.5 flex-shrink-0" />
                  <span>{t.allWord}</span>
                  {(techList.length + exeList.length) > 0 && (
                    <span className="ml-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">
                      {techList.length + exeList.length}
                    </span>
                  )}
                </TabsTrigger>
              )}
              {hasTech && (
                <TabsTrigger value="tech" className="flex-none px-3 py-1.5">
                  <Briefcase className="h-3.5 w-3.5 flex-shrink-0" />
                  <span>Staff</span>
                  {techList.length > 0 && (
                    <span className="ml-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">{techList.length}</span>
                  )}
                </TabsTrigger>
              )}
              {hasExec && (
                <TabsTrigger value="exec" className="flex-none px-3 py-1.5">
                  <Users className="h-3.5 w-3.5 flex-shrink-0" />
                  <span>Executives</span>
                  {exeList.length > 0 && (
                    <span className="ml-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">{exeList.length}</span>
                  )}
                </TabsTrigger>
              )}
              <TabsTrigger value="edits" className="flex-none px-3 py-1.5">
                <FileEdit className="h-3.5 w-3.5 flex-shrink-0" />
                <span>Edit requests</span>
                {editReqCount > 0 && (
                  <span className="ml-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">{editReqCount}</span>
                )}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:justify-end">
            <div className="relative min-w-[12rem] flex-1 lg:w-64 lg:flex-none">
              <Input
                type="text"
                placeholder="Search name, EPF or working place…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-9 py-1.5 pl-9 pr-8 text-xs"
              />
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label={t.clearAll}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {showStaffPick && (
              <Tabs
                value={staffView}
                onValueChange={(v) => { setStaffView(v as 'pool' | 'myteam'); setSelected(new Set()); setSelPick(null); }}
                className="w-full sm:w-auto"
              >
                <TabsList className="h-auto w-full gap-1 p-1 sm:w-fit">
                  <TabsTrigger value="pool" className="flex-1 px-3 py-1.5 sm:flex-none">
                    <Briefcase className="h-3.5 w-3.5 flex-shrink-0" /><span>{t.pickYourTeam ?? 'Pick your team'}</span>
                  </TabsTrigger>
                  <TabsTrigger value="myteam" className="flex-1 px-3 py-1.5 sm:flex-none">
                    <UserCheck className="h-3.5 w-3.5 flex-shrink-0" /><span>My team</span>
                    {myTeam.length > 0 && (
                      <span className="ml-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">{myTeam.length}</span>
                    )}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            )}

            {tab === 'edits' && editRequests.tech.length > 0 && editRequests.exe.length > 0 && (
              <Tabs
                value={editRoleFilter}
                onValueChange={(v) => { setEditRoleFilter(v as 'all' | 'tech' | 'exec'); setSelEdit(null); }}
                className="w-full sm:w-auto"
              >
                <TabsList className="h-auto w-full gap-1 p-1 sm:w-fit">
                  <TabsTrigger value="all" className="flex-1 px-3 py-1.5 sm:flex-none">
                    <span>{t.allWord}</span>
                    <span className="ml-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">{editReqCount}</span>
                  </TabsTrigger>
                  <TabsTrigger value="tech" className="flex-1 px-3 py-1.5 sm:flex-none">
                    <Briefcase className="h-3.5 w-3.5 flex-shrink-0" /><span>{t.techniciansLabel}</span>
                    <span className="ml-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">{editRequests.tech.length}</span>
                  </TabsTrigger>
                  <TabsTrigger value="exec" className="flex-1 px-3 py-1.5 sm:flex-none">
                    <Users className="h-3.5 w-3.5 flex-shrink-0" /><span>Executives</span>
                    <span className="ml-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">{editRequests.exe.length}</span>
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            )}
          </div>
        </div>
      </Reveal>

      {loading ? (
        <ApprovalsQueueSkeleton />
      ) : (!isSearching && showStaffPick && staffView === 'myteam') ? (
        <Reveal>
          <ApprovalsMasterDetail
            items={myTeamOrdered}
            getId={(r: any) => r.sessionId}
            selectedId={selPick}
            onSelect={setSelPick}
            group={myTeam.length > 0 ? {
              // Group My team by each member's leader — their claimed original leader (team_leader_epf),
              // else whoever picked them. Show the leader header ONLY when the leader is someone else;
              // my own picks (leader === me) render with no header, since "My team" already implies mine.
              keyOf: (r: any) => {
                if (r.team_leader_epf) return String(r.team_leader_epf);
                if (myTeamLeaderEpfs.has(String(r.epf_number))) return String(r.epf_number);
                return myEpf || 'me';
              },
              renderHeader: (key: string, groupItems: any[]) => {
                if (key === myEpf) {
                  // My own direct picks. Label them as their own group ONLY when there's also a
                  // claimed team to tell apart; a pure team leader's flat team needs no header.
                  if (myTeamLeaderEpfs.size === 0) return null;
                  return (
                    <div className="mt-1 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                      <Hand className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm font-semibold text-foreground">Individually picked</span>
                      <span className="whitespace-nowrap text-[11px] text-muted-foreground">· {groupItems.length}</span>
                    </div>
                  );
                }
                const leaderRec = groupItems.find(r => String(r.epf_number) === key);
                const leaderName = leaderRec?.name
                  ?? groupItems.find(r => r.team_leader_name)?.team_leader_name
                  ?? 'Team';
                const memberCount = groupItems.filter(r => String(r.team_leader_epf ?? '') === key).length;
                return (
                  <div className="mt-1 flex items-center justify-between gap-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Users className="h-4 w-4 flex-shrink-0 text-primary" />
                      <span className="truncate text-sm font-semibold text-foreground">{leaderName}</span>
                      <span className="whitespace-nowrap text-[11px] text-muted-foreground">· {memberCount} in team</span>
                    </div>
                    {/* Release the whole team back to its leader — anyone can Pick team it again. */}
                    <Button variant="outline" size="sm"
                      className="flex-shrink-0 hover:text-destructive hover:border-destructive"
                      disabled={pickBusyId != null}
                      onClick={() => handleReleaseTeam(key)}>
                      {pickBusyId === `team-${key}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      Release team
                    </Button>
                  </div>
                );
              },
            } : undefined}
            renderRow={(r: any, sel) => (
              <PickListRow row={r} selected={sel}
                onRelease={() => handleRelease(r)}
                releaseBusy={pickBusyId === r.sessionId} />
            )}
            renderDetail={(row: any) => (
              <div className="space-y-3">
                <ApprovalsDetailHeader
                  name={row.name}
                  epf={row.epf_number}
                  date={todayStr}
                  phone={row.phone}
                  role={row.role}
                  workingPlace={row.site_name}
                  issues={getRecordIssues(row)}
                  onRelease={() => handleRelease(row)}
                  releaseBusy={pickBusyId === row.sessionId}
                />
                {typeof row.check_in_lat === 'number' && typeof row.check_in_lng === 'number' && (
                  <div className="overflow-hidden rounded-xl border border-border/70 bg-card p-3 shadow-sm space-y-2">
                    <span className="text-xs font-semibold flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5 text-primary" /> Check-in Location</span>
                    <LeafletMiniMap lat={row.check_in_lat} lng={row.check_in_lng} height={180} />
                  </div>
                )}
              </div>
            )}
            emptyState={
              <Card>
                <EmptyState
                  icon={UserCheck}
                  title="No one on your team yet"
                  description="Pick a checked-in technician to add them here."
                />
              </Card>
            }
          />
        </Reveal>
      ) : tab === 'edits' ? null : (isSearching && visiblePendingCount === 0) ? (
        <Reveal>
          <Card>
            <EmptyState
              icon={Search}
              title={t.noMatchesFound}
              description={`No pending approval matches "${searchQuery}"`}
            />
          </Card>
        </Reveal>
      ) : (!isSearching && !problemsOnly && currentList.length === 0 && rawPastList.length === 0 && !(showStaffPick && availableToPick.length > 0)) ? (
        <Reveal>
          <Card>
            <EmptyState
              icon={CheckCircle}
              title="All caught up!"
              description={showStaffPick && !approveEnabled
                ? 'No technicians available to pick right now'
                : clearedToday > 0
                  ? `Nothing pending. ${clearedToday} cleared today.`
                  : 'No pending approvals'}
            />
          </Card>
        </Reveal>
      ) : (
        <Reveal className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 border-b border-border">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-success/10 text-success">
                  <ClipboardCheck className="h-5 w-5" />
                </span>
                <div>
                  <CardTitle className="text-base">
                    {isSearching ? 'Search results' : showStaffPick && staffView === 'pool' ? (t.pickYourTeam ?? 'Pick your team') : (t.pendingApprovals ?? 'Pending Approvals')}
                  </CardTitle>
                  {/* Scope chips filter the one queue — they no longer split it into sections. */}
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] font-medium" role="group" aria-label="Show">
                    <button type="button" onClick={() => setScope('today')} aria-pressed={scope === 'today'}
                      className={`rounded-md border px-1.5 py-0.5 transition-colors ${scope === 'today' ? 'border-primary/40 bg-primary/15 font-semibold text-primary' : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground'}`}>
                      {t.todayWord} {todayPending.length}
                    </button>
                    <button type="button" onClick={() => setScope('past')} aria-pressed={scope === 'past'}
                      className={`rounded-md border px-1.5 py-0.5 transition-colors ${scope === 'past' ? 'border-warning/40 bg-warning/15 font-semibold text-warning' : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground'}`}>
                      {t.pastWord} {earlierPending.length + pastTabList.length}
                    </button>
                    <button type="button" onClick={() => setScope('all')} aria-pressed={scope === 'all'}
                      className={`rounded-md border px-1.5 py-0.5 transition-colors ${scope === 'all' ? 'border-brand/40 bg-brand/15 font-semibold text-brand' : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground'}`}>
                      {t.allWord} {todayPending.length + earlierPending.length + pastTabList.length}
                    </button>
                  </div>
                </div>
              </div>

              {/* Toolbar — select-all, prior months filter, this month filter, and sort toggle */}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant={allSelected ? 'secondary' : 'outline'}
                  size="sm"
                  onClick={toggleSelectAll}
                >
                  {/* Tri-state: a solid fill + check means EVERY item is selected; a partial
                      pick must read differently at a glance, not as the same fill at 50%
                      opacity (indistinguishable from full at this size) — so it gets an
                      outlined box and a dash, the standard indeterminate-checkbox mark. */}
                  <div className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${allSelected ? 'border-primary bg-primary' : someSelected ? 'border-primary bg-card' : 'border-border'
                    }`}>
                    {allSelected && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                    {someSelected && <Minus className="h-2.5 w-2.5 text-primary" />}
                  </div>
                  {allSelected ? t.deselectAll : t.selectAll}
                </Button>

                {priorMonthIds.length > 0 && (
                  <Button
                    variant={isPriorOnlySelected ? 'secondary' : 'outline'}
                    size="sm"
                    className="text-xs"
                    onClick={() => {
                      if (isPriorOnlySelected) setSelected(new Set());
                      else setSelected(new Set(priorMonthIds));
                    }}
                  >
                    <History className="h-3.5 w-3.5 mr-1 text-warning" />
                    Prior months only ({priorMonthIds.length})
                  </Button>
                )}

                {thisMonthIds.length > 0 && priorMonthIds.length > 0 && (
                  <Button
                    variant={isThisOnlySelected ? 'secondary' : 'outline'}
                    size="sm"
                    className="text-xs"
                    onClick={() => {
                      if (isThisOnlySelected) setSelected(new Set());
                      else setSelected(new Set(thisMonthIds));
                    }}
                  >
                    <Calendar className="h-3.5 w-3.5 mr-1 text-primary" />
                    This month only ({thisMonthIds.length})
                  </Button>
                )}

                {(tab === 'all' || tab === 'tech' || tab === 'exec') && (
                  <Button
                    variant={issuesFirst ? 'default' : 'outline'}
                    size="sm"
                    aria-pressed={issuesFirst}
                    onClick={() => setIssuesFirst(v => !v)}
                  >
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {/* English fallback — the toggle is the old apIssuesFirst, said plainly. */}
                    Problems first
                  </Button>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-3 pt-5">
              {/* The backlog, said out loud — count, oldest day, widen control, one-shot approve. */}
              {(tab === 'all' || tab === 'tech' || tab === 'exec') && (
                <ApprovalsBacklogCard
                  count={backlogCount}
                  oldestDate={backlogOldest}
                  windowCaption={t.pastBacklogSince.replace('{date}', formatDate(backlogStartFor(todayStr, pastMonthsBack)))}
                  maxCaption={t.pastBacklogMax.replace('{n}', String(PAST_BACKLOG_MAX_MONTHS))}
                  onLoadOlder={pastMonthsBack < PAST_BACKLOG_MAX_MONTHS ? loadOlderPast : undefined}
                  loadingOlder={pastLoadingOlder}
                  onApproveAll={approveEnabled && backlogIds.length > 0 ? (force) => handleApproveBacklogAll(backlogIds, force) : undefined}
                  approveAllBusy={backlogRunning}
                  progress={backlogProgress}
                />
              )}

              {(tab === 'all' || tab === 'tech' || tab === 'exec') && <ApprovalsKeyboardHint />}

              {/* One list: day separators instead of Today / Past sections, teams nested inside
                  the day they belong to. */}
              {(tab === 'all' || tab === 'tech' || tab === 'exec') && (
                <ApprovalsQueue
                  boundHeight
                  items={queueItems}
                  todayStr={todayStr}
                  selectedId={focusedQueueId}
                  onSelect={setFocusedQueueId}
                  isChecked={(it) => selected.has(it.id)}
                  onToggleCheck={(it) => toggleSelect(it.id)}
                  onApproveDay={approveEnabled ? (ids) => {
                    const key = queueItems.find(it => it.id === ids[0])?.bucket ?? '';
                    void handleApproveDay(key, ids);
                  } : undefined}
                  approvingDayKey={approvingDayKey}
                  teamGroup={(tab === 'tech' || tab === 'all') && pickedLeaderEpfs.size > 0 ? {
                    // A record belongs to a team keyed by its picker; a leader's own record is
                    // keyed by its own EPF so it sits inside its team. Everyone else is ungrouped.
                    keyOf: (it: QueueItem) => {
                      if (it.kind !== 'live' || it.bucket === PROBLEMS_BUCKET) return null;
                      const r = it.record;
                      if (r.picked_by) return String(r.picked_by);
                      if (pickedLeaderEpfs.has(String(r.epf_number))) return String(r.epf_number);
                      return null;
                    },
                    renderHeader: (key: string, groupItems: QueueItem[]) => {
                      const records = groupItems.map(it => it.record);
                      const leaderRec = records.find(r => String(r.epf_number) === key);
                      const memberCount = records.filter(r => String(r.picked_by ?? '') === key).length;
                      const leaderName = leaderRec?.name
                        ?? records.find(r => r.picked_by_name)?.picked_by_name
                        ?? 'Team';
                      // Approve the whole team in one action: the leader's own record + their picks.
                      const groupIds = groupItems.map(it => it.id);
                      const groupBusy = actKey === `approve-${groupIds.join('-')}`;
                      return (
                        <div className="mt-1 flex items-center justify-between gap-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <Users className="h-4 w-4 flex-shrink-0 text-primary" />
                            <span className="truncate text-sm font-semibold text-foreground">{leaderName}</span>
                            <span className="whitespace-nowrap text-[11px] text-muted-foreground">· {memberCount} picked</span>
                          </div>
                          <div className="flex flex-shrink-0 items-center gap-2">
                            {/* Pick the whole team onto me: picking the leader reassigns their
                                entire team to me (and approves it). Executive action only —
                                pick-only leaders can't pick a peer leader. Needs the leader's
                                own pending record and an unclaimed leader. */}
                            {canApproveTech && leaderRec && !leaderRec.picked_by && (
                              <Button variant="secondary" size="sm" disabled={pickBusyId != null}
                                onClick={() => handlePickRecord(leaderRec.attendance_id ?? leaderRec.id)}>
                                {pickBusyId != null ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Hand className="h-3.5 w-3.5" />}
                                Pick team
                              </Button>
                            )}
                            {approveEnabled && (
                              <Button variant="success" size="sm" disabled={!!actKey}
                                onClick={() => handleApprove(groupIds)}>
                                {groupBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
                                Approve team
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    },
                  } : undefined}
                  renderDetail={renderQueueDetail}
                  emptyState={queueEmptyState}
                />
              )}

              {/* Everything selected acts from here — no hunting back up to a toolbar. */}
              {approveEnabled && (
                <ApprovalsBulkBar
                  count={selectedIds.length}
                  approving={!!actKey?.startsWith('approve')}
                  rejecting={!!actKey?.startsWith('reject')}
                  busy={!!actKey || backlogRunning}
                  force={bulkForce}
                  onToggleForce={() => setBulkForce(v => !v)}
                  onApprove={() => handleApprove(selectedIds, { force: bulkForce })}
                  onReject={() => handleReject(selectedIds)}
                  onClear={() => setSelected(new Set())}
                />
              )}

              {/* Approved & available to (re)pick — not checked out, not currently picked */}
              {!isSearching && showToday && showStaffPick && staffView === 'pool' && availableToPick.length > 0 && (
                <>
                  <div className="flex items-center gap-3 pt-2">
                    <div className="flex-1 border-t border-border" />
                    <span className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Available to pick</span>
                    <div className="flex-1 border-t border-border" />
                  </div>
                  <ApprovalsMasterDetail
                    items={availableToPick}
                    getId={(r: any) => r.sessionId}
                    selectedId={selPick}
                    onSelect={setSelPick}
                    renderRow={(r: any, sel) => (
                      <PickListRow row={r} selected={sel}
                        onPick={() => handlePickRow(r.docId, r.sessionId, r.name)}
                        pickBusy={pickBusyId === r.sessionId}
                        members={membersByLeader.get(String(r.epf_number))} />
                    )}
                    renderDetail={(row: any) => (
                      <div className="space-y-3">
                        <ApprovalsDetailHeader
                          name={row.name}
                          epf={row.epf_number}
                          date={todayStr}
                          phone={row.phone}
                          role={row.role}
                          workingPlace={row.site_name}
                          issues={getRecordIssues(row)}
                          onPick={() => handlePickRow(row.docId, row.sessionId, row.name)}
                          pickBusy={pickBusyId === row.sessionId}
                          pickLabel={t.pickToTeam ?? 'Pick to team'}
                        />
                        {typeof row.check_in_lat === 'number' && typeof row.check_in_lng === 'number' && (
                          <div className="overflow-hidden rounded-xl border border-border/70 bg-card p-3 shadow-sm space-y-2">
                            <span className="text-xs font-semibold flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5 text-primary" /> Check-in Location</span>
                            <LeafletMiniMap lat={row.check_in_lat} lng={row.check_in_lng} height={180} />
                          </div>
                        )}
                      </div>
                    )}
                    emptyState={undefined}
                  />
                </>
              )}

              {/* Already-picked roster — OTHER teams' picked people, grouped under whoever picked
                  them. Read-only context; your own team lives in the My team sub-tab. */}
              {!isSearching && showToday && showStaffPick && staffView === 'pool' && pickerGroups.length > 0 && (
                <>
                  <div className="flex items-center gap-3 pt-2">
                    <div className="flex-1 border-t border-border" />
                    <span className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Already picked</span>
                    <div className="flex-1 border-t border-border" />
                  </div>
                  {pickerGroups.map(g => (
                    <div key={g.epf} className="flex flex-col gap-2">
                      <div className="mt-1 flex items-center gap-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2">
                        <UserCheck className="h-4 w-4 flex-shrink-0 text-primary" />
                        <span className="truncate text-sm font-semibold text-foreground">{g.name}</span>
                        <span className="whitespace-nowrap text-[11px] text-muted-foreground">· {g.members.length} picked</span>
                      </div>
                      {g.members.map((m: any) => (
                        <PickListRow key={m.sessionId} row={m} selected={false} />
                      ))}
                    </div>
                  ))}
                </>
              )}

              {/* For admins: show approved but not picked technicians */}
              {!isSearching && showToday && !showStaffPick && tab === 'tech' && availableToPick.length > 0 && (
                <>
                  <div className="flex items-center gap-3 pt-2">
                    <div className="flex-1 border-t border-border" />
                    <span className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                      Approved but Not Picked ({availableToPick.length})
                    </span>
                    <div className="flex-1 border-t border-border" />
                  </div>
                  <Stagger className="mt-2 space-y-2">
                    {availableToPick.map(row => (
                      <StaggerItem key={row.sessionId}>
                        <MotionCard className="flex flex-col justify-between gap-3 rounded-xl border border-border bg-card p-4 shadow-card sm:flex-row sm:items-center">
                          <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-success/10 text-sm font-bold text-success">
                              {row.name?.charAt(0) ?? '?'}
                            </div>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="truncate text-sm font-semibold text-foreground">{row.name}</span>
                                <span className="text-[11px] text-muted-foreground">{row.role} · EPF: {row.epf_number}</span>
                                <Badge variant="success" className="rounded-full">{t.approved}</Badge>
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                                <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" />In {pickFmtTime(row.check_in)}</span>
                                {row.site_name && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{row.site_name}</span>}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <CallButton phone={row.phone} name={row.name} />
                            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                              <UserCheck className="h-3.5 w-3.5" />
                              <span>Not picked yet</span>
                            </span>
                          </div>
                        </MotionCard>
                      </StaggerItem>
                    ))}
                  </Stagger>
                </>
              )}
            </CardContent>
          </Card>
        </Reveal>
      )}

      {/* ── Edit Requests Tab Content ── */}
      {tab === 'edits' && !loading && (
        <>
          {editReqList.length === 0 ? (
            <Reveal>
              <Card>
                <EmptyState
                  icon={FileEdit}
                  title="No edit requests"
                  description={clearedToday > 0 ? `Nothing pending. ${clearedToday} cleared today.` : 'No pending attendance corrections'}
                />
              </Card>
            </Reveal>
          ) : filteredEditReqList.length === 0 ? (
            <Reveal>
              <Card>
                <EmptyState
                  icon={Search}
                  title={t.noMatchesFound}
                  description={editQuery
                    ? `No edit request matches "${searchQuery}"`
                    : `No ${editRoleFilter === 'tech' ? 'technician' : 'executive'} edit requests`}
                />
              </Card>
            </Reveal>
          ) : (
            <Reveal className="space-y-3">
              {/* Toolbar — select-all only; approving happens in the sticky bar below. */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {filteredEditReqList.length} request{filteredEditReqList.length > 1 ? 's' : ''}
                  {editQuery && roleFilteredEditReqList.length !== filteredEditReqList.length ? ` of ${roleFilteredEditReqList.length}` : ''}
                </span>
                <Button variant={allEditsSelected ? 'secondary' : 'outline'} size="sm" onClick={toggleSelectAllEdits}>
                  <div className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
                    allEditsSelected ? 'border-primary bg-primary' : someEditsSelected ? 'border-primary bg-card' : 'border-border'
                  }`}>
                    {allEditsSelected && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                    {someEditsSelected && <Minus className="h-2.5 w-2.5 text-primary" />}
                  </div>
                  {allEditsSelected ? t.deselectAll : t.selectAll}
                </Button>
              </div>

              <ApprovalsMasterDetail
                boundHeight
                items={filteredEditReqList}
                getId={(r: any) => r.id}
                selectedId={selEdit}
                onSelect={setSelEdit}
                bulk={{
                  isChecked: (r: any) => selectedEdits.has(r.id),
                  onToggle: (r: any) => toggleSelectEdit(r.id),
                }}
                renderRow={(r: any, sel) => <EditRequestListRow req={r} selected={sel} />}
                renderDetail={(r: any) => {
                  const curCoords = placeCoords(r.current?.working_place, r.current?.site_number);
                  const reqCoords = placeCoords(r.requested?.working_place, r.requested?.site_number);
                  const attendanceDate = String(r.attendance_id ?? '').split('_')[1] ?? undefined;
                  const role = r.role ?? r.group ?? r.user_type;

                  return (
                    <div className="space-y-3">
                      <ApprovalsDetailHeader
                        name={r.name}
                        epf={r.epf_number}
                        date={attendanceDate}
                        role={role}
                        workingPlace={r.requested?.working_place ?? r.current?.working_place ?? undefined}
                        siteNo={r.requested?.site_number ?? r.current?.site_number ?? undefined}
                        isOutstation={r.requested?.is_outstation || r.current?.is_outstation}
                        extraBadges={
                          (r.session_count ?? 1) > 1 ? (
                            <span className="inline-flex items-center gap-1 rounded-md border border-brand/25 bg-brand/10 px-2 py-0.5 text-[10px] font-semibold text-brand">
                              Session {r.session_no}/{r.session_count}
                            </span>
                          ) : undefined
                        }
                        onApprove={() => handleConsiderEdit(r.id as number, 'approve')}
                        onReject={() => { setRejectModal({ open: true, id: r.id as number }); setRejectReason(''); }}
                        approving={actKey === `edit-${r.id}`}
                        busy={!!actKey}
                      />
                      <EditRequestDetail
                        req={r}
                        hideHeader={true}
                        curCoords={curCoords}
                        reqCoords={reqCoords}
                      />
                    </div>
                  );
                }}
                emptyState={
                  <EmptyState
                    icon={FileEdit}
                    title="No edit requests"
                    description="No pending attendance corrections"
                  />
                }
              />

              <ApprovalsBulkBar
                count={selectedEditIds.length}
                approving={!!actKey?.startsWith('edit-bulk')}
                busy={!!actKey}
                onApprove={() => handleApproveEdits(selectedEditIds)}
                onClear={() => setSelectedEdits(new Set())}
              />
            </Reveal>
          )}

          {/* Reject reason modal */}
          <Dialog open={rejectModal.open} onOpenChange={(open) => { if (!open) setRejectModal({ open: false, id: null }); }}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Reject Edit Request</DialogTitle>
                <DialogDescription>Provide a reason so the employee understands why.</DialogDescription>
              </DialogHeader>
              <Textarea
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                rows={3}
                className="resize-none"
                placeholder="Reason for rejection…"
                autoFocus
              />
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setRejectModal({ open: false, id: null })}
                  className="flex-1"
                >
                  {t.cancel}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => rejectModal.id !== null && handleConsiderEdit(rejectModal.id, 'reject')}
                  disabled={!rejectReason.trim() || !!actKey}
                  className="flex-1"
                >
                  {actKey ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                  {t.rejectVerb}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}

      <ConfirmModal
        open={!!confirmEndShift}
        onOpenChange={() => setConfirmEndShift(null)}
        variant="warning"
        title="End this shift now?"
        description={
          confirmEndShift
            ? `${confirmEndShift.name}'s shift will be marked closed. They can still check out themselves.`
            : undefined
        }
        confirmText="End shift"
        busy={endShiftBusyId !== null}
        onConfirm={async () => {
          const recId = confirmEndShift?.recId;
          setConfirmEndShift(null);
          if (recId != null) await handleEndShift(recId);
        }}
      />

      {/* Keyboard reject asks first — the mouse path is one deliberate click, a keystroke is not. */}
      <ConfirmModal
        open={!!confirmReject}
        onOpenChange={() => setConfirmReject(null)}
        variant="danger"
        title="Reject this record?"
        description={confirmReject ? `${confirmReject.name}'s session will be sent back as rejected.` : undefined}
        confirmText={t.rejectVerb}
        onConfirm={async () => {
          const ids = confirmReject?.ids ?? [];
          setConfirmReject(null);
          if (ids.length > 0) await handleReject(ids);
        }}
      />
    </PageTransition>
  );
}
