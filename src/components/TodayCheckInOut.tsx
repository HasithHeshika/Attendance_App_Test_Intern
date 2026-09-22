'use client';
import { useEffect, useId, useState, useRef } from 'react';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowRight, Loader2, Check, LogIn, LogOut, MapPin, ChevronDown,
  Clock, AlertCircle, UserCheck, CalendarCheck,
  Palmtree, CalendarOff, Fingerprint, Smartphone,
} from 'lucide-react';
import Link from 'next/link';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { useT } from '@/store/appStore';
import { tenant } from '@/lib/firebase';
import { _attendanceApi as attendanceApi } from '@/services/apiCompat';
import { getScheduleForDate } from '@/services/workingScheduleService';
import { getScheduleAssignmentsForEmployee } from '@/services/scheduleAssignmentService';
import type { ScheduleAssignment } from '@/lib/types';
import OutstationBadge from '@/components/OutstationBadge';
import ReleasePicksDialog from '@/components/ReleasePicksDialog';
import LunchButton from '@/components/lunch/LunchButton';
import { formatTime, formatDate, localDateString } from '@/lib/utils';
import { SwipeButton } from '@/components/ui/SwipeButton';
import SmartWorkingPlaceSelect from '@/components/SmartWorkingPlaceSelect';
import SessionLocations from '@/components/SessionLocations';
import UpdateSessionLocation from '@/components/UpdateSessionLocation';
import { useWorkingPlaces } from '@/store/workingPlacesStore';
import { requestDeviceLocation, mapsLink, nearestWorkingPlace, distanceMeters, matchWithinRadius } from '@/lib/geo';
import { useSolarSites } from '@/components/useSolarSites';
import { useRequiredLocation } from '@/components/useRequiredLocation';
import { useDanglingCheckout } from '@/components/useDanglingCheckout';
import LocationGate from '@/components/LocationGate';
import toast from 'react-hot-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Reveal } from '@/components/ui/motion';

// Leaflet mini-map — client-only and lazy (keeps leaflet out of the initial bundle;
// only fetched when a user actually expands the attendance map).
const AttendanceMiniMap = dynamic(() => import('@/components/AttendanceMiniMap'), {
  ssr: false,
  loading: () => <div className="h-44 w-full rounded-xl bg-muted animate-pulse" />,
});
import type { TrailPoint } from '@/components/AttendanceMiniMap';

function localDateTimeString() {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// How far ahead to look for the next-shift strip (southernlanka only) — same window
// my-schedule/page.tsx uses for its own "Next shift" card.
const NEXT_SHIFT_LOOKAHEAD_DAYS = 30;

// "yyyy-mm-dd" → a local-midnight Date, built from numeric parts (not `new Date(str)`) so it
// can't drift a day from a UTC-vs-local mismatch — same helper as my-schedule/page.tsx.
function parseDateInput(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
function timeRange(start: string, end: string): string {
  if (!start && !end) return '—';
  return `${start || '—'} – ${end || '—'}`;
}

// Minutes worked today, summed across every session — ticks while one is still open so the
// figure stays live without the parent refetching. Parses "YYYY-MM-DD HH:MM:SS" as local time.
function useWorkedMinutes(sessions: any[] | null | undefined, live: boolean): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => tick(n => n + 1), 30000);
    return () => clearInterval(id);
  }, [live]);
  if (!sessions || sessions.length === 0) return null;
  let totalMins = 0;
  const now = Date.now();
  for (const s of sessions) {
    if (!s.check_in) continue;
    const start = new Date(String(s.check_in).replace(' ', 'T')).getTime();
    if (isNaN(start)) continue;
    const end = s.check_out ? new Date(String(s.check_out).replace(' ', 'T')).getTime() : now;
    totalMins += Math.max(0, Math.floor((end - start) / 60000));
  }
  return totalMins;
}

// "5h 42m" from the shared short h/m units (no new strings).
function durationLabel(mins: number, hShort: string, mShort: string) {
  return `${Math.floor(mins / 60)}${hShort} ${String(mins % 60).padStart(2, '0')}${mShort}`;
}

// Keyboard / screen-reader path to a swipe action. SwipeButton is driven purely by pointer
// drag events, so without this there is no way to check in or out without a pointer. It keeps
// the swipe's deliberate two-step contract rather than bypassing it: the first press arms, the
// second commits, and the arm lapses on blur or after five seconds.
function KeyboardConfirm({ label, armedLabel, blockedLabel, blocked, onConfirm }: {
  label: string; armedLabel: string; blockedLabel?: string; blocked?: boolean; onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      type="button"
      aria-disabled={blocked || undefined}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (blocked) return;
        if (armed) { setArmed(false); onConfirm(); } else setArmed(true);
      }}
      className="sr-only focus:not-sr-only focus:flex focus:h-11 focus:w-full focus:items-center focus:justify-center focus:rounded-full focus:border focus:border-primary focus:bg-primary/10 focus:px-4 focus:text-sm focus:font-semibold focus:text-primary focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
    >
      {blocked ? (blockedLabel ?? label) : armed ? armedLabel : label}
    </button>
  );
}

// Hardcoded because appStore.ts is owned elsewhere this merge — see the report.
const PRESS_AGAIN = 'Press again to confirm';

// Shared "Today's Attendance" check-in / check-out hero card. Extracted from the dashboard
// (the canonical copy) so the dashboard and attendance pages render identical behaviour.
// Derives all of its state from the `attendance` prop; calls `onMutated` after a successful
// check-in / check-out so the parent can reload its own data.
export default function TodayCheckInOut(props: {
  attendance: any;            // today's attendance object (sessions[], check_in, check_out, check_in_lat/lng, is_shift_day, working_place, …)
  loading: boolean;           // parent's initial-load flag
  onMutated: () => void | Promise<void>;  // call after a successful check-in or check-out so the parent reloads its data
  // Today's leave status — drives the leave banners + blocks check-in/out on an approved leave day.
  leaveCheck?: { can_mark_attendance: boolean; is_half_day?: boolean; half_day_period?: string | null } | null;
  className?: string;
}) {
  const { attendance, loading, leaveCheck } = props;
  const { user } = useAuthStore();
  const caps = useUserCapabilities();
  const t = useT();
  const { requiresSite, options: workingPlaceOptions, placeHasTag } = useWorkingPlaces();
  // Solar sites (GPS-tagged) — also candidates for the "you're here" 50 m auto-recommend.
  const solarSites = useSolarSites(true);
  // isExec = a self-recording approver (Technicians instead pick a supervisor on check-in)
  const isExec = caps.can_approve;
  // Full-day leave blocks check-in/out entirely; half-day only shows an info banner.
  const isLeaveDay = leaveCheck?.can_mark_attendance === false;
  const isHalfDay  = leaveCheck?.is_half_day === true;
  // Mandatory location: check-in/out require a live GPS fix (requested proactively on mount).
  const reqLoc = useRequiredLocation();
  // A prior day left open (checked in, never out). Normal users see it the next day;
  // shift workers only once 24h have passed since the shift's check-in.
  const dangling = useDanglingCheckout(user?.epf_number, !!user?.is_shift_worker);
  // Southernlanka only — per-user attendance-method policy (see AppUser.attendance_methods
  // and the Users admin page). Every other tenant has no such restriction, so mobile
  // check-in/out always stays available there.
  const isSouthernlanka = tenant.id === 'southernlanka';
  const mobileAllowed = !isSouthernlanka || !!user?.attendance_methods?.includes('mobile');

  // Swiper state
  const [workingPlace,      setWorkingPlace]      = useState('');
  const [siteNumber,        setSiteNumber]        = useState('');
  // Working place scheduled for the current user TODAY (if any) — the outstation reference.
  const [todaySchedule, setTodaySchedule] = useState<{ working_place: string; site_number?: string | null } | null>(null);
  const [showCheckoutForm,  setShowCheckoutForm]  = useState(false);
  // Auto-detected working place at check-out (from GPS); falls back to manual select.
  const [detecting,         setDetecting]         = useState(false);
  const [detectedPlace,     setDetectedPlace]     = useState<string | null>(null);
  const [detectedDistance,  setDetectedDistance]  = useState<number | null>(null);
  const [geoError,          setGeoError]          = useState<string>('');
  const [changeClicked,     setChangeClicked]     = useState(false);
  const detectedLocRef = useRef<{ lat: number; lng: number; accuracy: number | null } | null>(null);
  // Latest options in a ref so the detect effect can read them without depending on the
  // array reference — otherwise it re-fires on every render and wipes a manual selection.
  const workingPlaceOptionsRef = useRef(workingPlaceOptions);
  workingPlaceOptionsRef.current = workingPlaceOptions;
  const solarSitesRef = useRef(solarSites);
  solarSitesRef.current = solarSites;
  const [actionLoading,     setActionLoading]     = useState(false);
  const [checkinResetKey,   setCheckinResetKey]   = useState(0);
  const [checkoutResetKey,  setCheckoutResetKey]  = useState(0);
  const [releaseOpen,       setReleaseOpen]       = useState(false);
  // "Update location" form for the current session (adds to its location history).
  const [showLocForm,       setShowLocForm]       = useState(false);
  // One-time coachmark that points out the (new) "Update location" button for a few seconds.
  const [showLocHint,       setShowLocHint]       = useState(false);
  // Location chip being hovered → the map zooms to it.
  const [focusedLoc,        setFocusedLoc]        = useState<{ lat: number; lng: number } | null>(null);
  // Blink the (new) "Update location" button until the user first opens it.
  const [locBlink,          setLocBlink]          = useState(false);
  // The trail map is opt-in (see the location block below); the choice is remembered per device.
  // Starts closed so SSR and the first client paint agree.
  const [mapOpen,           setMapOpen]           = useState(false);
  const mapPanelId = useId();
  // Southernlanka only — this employee's next scheduled shift(s), if any within the lookahead
  // window (see the effect below). A date may carry more than one shift, so this is every
  // shift on the nearest upcoming date with anything scheduled, not a single assignment.
  const [nextShift,         setNextShift]         = useState<ScheduleAssignment[] | null>(null);

  // Today's scheduled working place for this employee (shown as a badge; the outstation reference).
  useEffect(() => {
    const epf = user?.epf_number;
    if (!epf) return;
    let cancelled = false;
    (async () => {
      try {
        const sched = await getScheduleForDate(epf, localDateString());
        if (!cancelled) setTodaySchedule(sched ? { working_place: sched.working_place, site_number: sched.site_number } : null);
      } catch { if (!cancelled) setTodaySchedule(null); }
    })();
    return () => { cancelled = true; };
  }, [user?.epf_number]);

  // Southernlanka only — this employee's very next scheduled shift (today → +30 days), so the
  // check-in/out card also answers "when am I next working" without a trip to My Schedule.
  // Same source my-schedule/page.tsx's "Next shift" strip reads (schedule_assignments, one
  // shift per employee per date); skipped entirely for every other tenant, which has no
  // shift-schedule system.
  useEffect(() => {
    const epf = user?.epf_number;
    if (!isSouthernlanka || !epf) { setNextShift(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const from = localDateString();
        const to = localDateString(new Date(Date.now() + NEXT_SHIFT_LOOKAHEAD_DAYS * 86400000));
        const assignments = await getScheduleAssignmentsForEmployee(epf);
        if (cancelled) return;
        const upcoming = assignments.filter((a) => a.date >= from && a.date <= to);
        const nextDate = upcoming.map((a) => a.date).sort()[0];
        setNextShift(nextDate ? upcoming.filter((a) => a.date === nextDate) : null);
      } catch { if (!cancelled) setNextShift(null); }
    })();
    return () => { cancelled = true; };
  }, [isSouthernlanka, user?.epf_number]);

  // Session-aware: the open session (checked in, not out) drives the current state.
  const sessions: any[] = (attendance as any)?.sessions ?? [];
  const openSession = sessions.find((s: any) => s.check_in && !s.check_out) ?? null;
  const currentSession = openSession || (sessions.length > 0 ? sessions[sessions.length - 1] : null);
  const lastSession = sessions.length ? sessions[sessions.length - 1] : null;
  const isCheckedIn  = !!openSession;
  const canStartSession = !openSession && (caps.multi_session || sessions.length === 0);
  const isCheckedOut = !openSession && !canStartSession && !!lastSession?.check_out;
  // Check-out is allowed only once a working place (and site # where required) is chosen.
  const canCheckOut = !!workingPlace && (!requiresSite(workingPlace) || !!siteNumber);

  // An approved check-in has no approver stamp when nobody approved it BY HAND — top
  // management self-approving, or the system approving an in-range check-in where
  // TenantFeatures.autoApproveInRangeCheckIn is on. Read the status first, or those people are
  // told their check-in is waiting on an approver who is never coming.
  const checkInPendingApproval = !isExec && !!openSession
    && openSession.check_in_status !== 'approved' && !openSession.check_in_approved_by;
  const checkoutBlocked  = false;
  // Display flags (current session, independent of whether a new one can start) + shift status
  const hasCheckIn  = !!attendance?.check_in;
  const hasCheckOut = !!attendance?.check_out;
  const isShiftDay      = !!(attendance as any)?.is_shift_day;   // today is within a roster period
  const isOvernightOpen = !!openSession?.is_overnight;
  // Leave-day handling lives at the page level (the dashboard hero shows an "On Leave" pill,
  // the attendance page swaps in its LeaveDayBanner). This shared card only owns the
  // check-in/out flow and never receives leave state, so its swipe blocks are unguarded here.

  // ── Attendance map data: GPS pins + the matched/selected working place marker ──
  const attAny  = attendance as any;
  const ciPoint = attAny?.check_in_lat != null && attAny?.check_in_lng != null
    ? { lat: attAny.check_in_lat as number, lng: attAny.check_in_lng as number, accuracy: (attAny.check_in_accuracy_m ?? null) as number | null }
    : null;
  const coPoint = attAny?.check_out_lat != null && attAny?.check_out_lng != null
    ? { lat: attAny.check_out_lat as number, lng: attAny.check_out_lng as number, accuracy: (attAny.check_out_accuracy_m ?? null) as number | null }
    : null;
  // Office/site coordinates come from the cached working-places store (no extra API call).
  const mapPlaceOpt = workingPlaceOptions.find(o =>
    (attAny?.check_in_site_id && o.id === attAny.check_in_site_id) ||
    (attAny?.working_place && o.name === attAny.working_place),
  ) ?? null;
  const mapPlace = mapPlaceOpt && mapPlaceOpt.latitude != null && mapPlaceOpt.longitude != null
    ? { lat: mapPlaceOpt.latitude, lng: mapPlaceOpt.longitude, radius: mapPlaceOpt.radius_m ?? null }
    : null;

  // ── Location trail for the single map: check-in → each in-session update → check-out ──
  // In-session updates come from the location history (source 'manual', with GPS + time).
  const updatePoints: TrailPoint[] = (Array.isArray(attAny?.locations) ? attAny.locations : [])
    .filter((l: any) => l?.source === 'manual' && l.lat != null && l.lng != null)
    .map((l: any) => ({
      lat: l.lat as number, lng: l.lng as number, accuracy: null,
      kind: 'update' as const,
      label: `${l.name ?? t.updateLocation}${l.added_at ? ` · ${formatTime(l.added_at)}` : ''}`,
    }));
  const trail: TrailPoint[] = [
    ...(ciPoint ? [{ lat: ciPoint.lat, lng: ciPoint.lng, accuracy: ciPoint.accuracy, kind: 'checkin' as const, label: `${t.checkIn} · ${formatTime(attendance?.check_in ?? '')}` }] : []),
    ...updatePoints,
    ...(coPoint ? [{ lat: coPoint.lat, lng: coPoint.lng, accuracy: coPoint.accuracy, kind: 'checkout' as const, label: `${t.checkOut} · ${formatTime(attendance?.check_out ?? '')}` }] : []),
  ];
  const hasTrailPoints = !!(ciPoint || coPoint);

  // ── Status block inputs: state → since → how long → where, in that order ──
  const workedMins = useWorkedMinutes(sessions, isCheckedIn);
  const statusLabel = isCheckedIn ? t.currentlyCheckedIn
    : isCheckedOut ? t.attendanceCompleted
    : hasCheckOut  ? t.completed          // a closed session, but another may still be started
    : t.notCheckedIn;
  // "Where" in plain text, so the map never has to be opened just to answer it. The location
  // history is append-ordered, so its last entry is the most recent place.
  const locNames: string[] = (Array.isArray(attAny?.locations) ? attAny.locations : [])
    .map((l: any) => l?.name).filter((n: unknown): n is string => typeof n === 'string' && n.length > 0);
  const placeLabel = locNames[locNames.length - 1]
    ?? (attendance?.working_place || (hasTrailPoints ? t.locationCaptured : null));

  // Warn when a check-in / check-out lands OUTSIDE every working-place radius — unless the spot
  // is a Solar app site (valid work locations that aren't in the working_places list). Returns
  // the message, or null when in range / at a Solar site / places not yet loaded.
  const outOfRangeWarning = (lat: number, lng: number): string | null => {
    const places = workingPlaceOptionsRef.current.filter(p => p.latitude != null && p.longitude != null);
    if (places.length === 0) return null;                    // nothing geolocated to measure against
    if (matchWithinRadius(lat, lng, places)) return null;    // inside some place's own radius → fine
    const SOLAR_NEAR_M = 500;                                // within 500 m of a Solar app site → at the site
    for (const s of solarSitesRef.current) {
      if (distanceMeters(lat, lng, s.lat, s.lng) <= SOLAR_NEAR_M) return null;
    }
    const nearest = nearestWorkingPlace(lat, lng, places, Number.POSITIVE_INFINITY);
    const fmt = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);
    return nearest
      ? t.outsideRangeWarn.replace('{dist}', fmt(nearest.distance)).replace('{place}', nearest.name)
      : t.outsideAllPlacesWarn;
  };

  const handleCheckIn = async () => {
    setActionLoading(true);
    // Location is mandatory — no fix, no check-in.
    const fix = await reqLoc.ensureLocation();
    if (!fix.ok) { toast.error(fix.reason); setCheckinResetKey(k => k + 1); setActionLoading(false); return; }
    try {
      // Working-place geofence match is computed server-side from this GPS.
      await attendanceApi.checkIn({
        epf_number: user?.epf_number ?? '',
        check_in_time: localDateTimeString(),
        request_from: [],
        check_in_lat: fix.lat,
        check_in_lng: fix.lng,
        check_in_accuracy_m: fix.accuracy,
      });
      toast.success(t.checkInSuccess);
      const rangeWarn = outOfRangeWarning(fix.lat, fix.lng);
      if (rangeWarn) toast(rangeWarn, { icon: '⚠️', duration: 8000 });
      import('@/services/reminderScheduler').then(({ invalidateAttendanceCache }) => invalidateAttendanceCache());
      // Keep the spinner up until the refreshed state arrives — otherwise the swipe button
      // flashes back briefly before the checked-in UI renders.
      await props.onMutated();
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t.checkInFailed);
      setCheckinResetKey(k => k + 1);
    }
    setActionLoading(false);
  };

  const doCheckOut = async () => {
    setActionLoading(true);
    // Location is mandatory — reuse the fix captured when the form opened, else get a fresh one; block if unavailable.
    let loc = detectedLocRef.current;
    if (!loc) {
      const fix = await reqLoc.ensureLocation();
      if (!fix.ok) { toast.error(fix.reason); setCheckoutResetKey(k => k + 1); setActionLoading(false); return; }
      loc = { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy };
    }
    try {
      // Outstation is auto-derived server-side from the check-out distance to the day's
      // scheduled (or primary) working place — no longer self-declared.
      const payload: Record<string, unknown> = { epf_number: user?.epf_number ?? '', check_out_time: localDateTimeString(), working_place: workingPlace, check_out_lat: loc.lat, check_out_lng: loc.lng, check_out_accuracy_m: loc.accuracy };
      if (requiresSite(workingPlace)) payload.site_number = siteNumber;
      const coRes = await attendanceApi.checkOut(payload as Parameters<typeof attendanceApi.checkOut>[0]);
      const outReason = (coRes as { data?: { outstation_reason?: string } })?.data?.outstation_reason;
      toast.success(t.checkOutSuccess);
      if (outReason) toast(outReason, { duration: 7000, icon: 'ℹ️' });
      const rangeWarn = outOfRangeWarning(loc.lat, loc.lng);
      if (rangeWarn) toast(rangeWarn, { icon: '⚠️', duration: 8000 });
      import('@/services/reminderScheduler').then(({ invalidateAttendanceCache }) => invalidateAttendanceCache());
      setShowCheckoutForm(false);
      // Keep the spinner up until the refreshed state arrives (avoids a button flash).
      await props.onMutated();
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? (err as Error)?.message ?? t.checkOutFailed);
      setCheckoutResetKey(k => k + 1);
    }
    setActionLoading(false);
  };

  const handleCheckOut = async () => {
    if (!workingPlace) { toast.error(t.selectWorkingPlace); setCheckoutResetKey(k => k + 1); return; }
    if (requiresSite(workingPlace) && !siteNumber) { toast.error(t.enterSiteNumber); setCheckoutResetKey(k => k + 1); return; }
    // Executives can't check out while still holding picked technicians — surface the
    // release popup instead of letting the check-out fail server-side.
    if (isExec) {
      try {
        const res = await attendanceApi.getCheckedInToday(user?.epf_number ?? '');
        const mine = ((res as { data?: { data?: Array<{ picked_by?: string | null }> } })?.data?.data ?? [])
          .filter(r => String(r.picked_by ?? '') === String(user?.epf_number ?? ''));
        if (mine.length > 0) { setReleaseOpen(true); return; }
      } catch { /* non-blocking — fall through to a normal check-out */ }
    }
    await doCheckOut();
  };

  // When the check-out form opens, capture GPS and auto-match the nearest working place
  // within its radius. If matched, use it silently; otherwise fall back to manual select.
  useEffect(() => {
    if (!showCheckoutForm) {
      setDetecting(false);
      setDetectedPlace(null);
      setDetectedDistance(null);
      detectedLocRef.current = null;
      setChangeClicked(false);
      return;
    }
    let cancelled = false;
    setDetecting(true);
    setDetectedPlace(null);
    setDetectedDistance(null);
    setGeoError('');
    // Start each check-out with a clean slate — never carry over a previously-picked place.
    setWorkingPlace('');
    setSiteNumber('');
    (async () => {
      const res = await requestDeviceLocation({ timeoutMs: 8000 });
      if (cancelled) return;
      setDetecting(false);
      if (!res.ok) {
        setGeoError(res.reason);
        detectedLocRef.current = null;
        setDetectedPlace(null);
        setWorkingPlace('');
        return;
      }
      detectedLocRef.current = { lat: res.lat, lng: res.lng, accuracy: res.accuracy };

      // "You're here": if the single closest place — saved OR Solar site — is within 50 m,
      // auto-recommend it (high confidence you're standing at it).
      const CONFIDENT_M = 50;
      let best: { name: string; value: string; distance: number } | null = null;
      for (const p of workingPlaceOptionsRef.current) {
        if (p.latitude == null || p.longitude == null) continue;
        const d = distanceMeters(res.lat, res.lng, p.latitude, p.longitude);
        if (d <= CONFIDENT_M && (!best || d < best.distance)) best = { name: p.name, value: p.name, distance: Math.round(d) };
      }
      for (const s of solarSitesRef.current) {
        const d = distanceMeters(res.lat, res.lng, s.lat, s.lng);
        if (d <= CONFIDENT_M && (!best || d < best.distance)) best = { name: s.name, value: `${s.name} (#${s.siteNo})`, distance: Math.round(d) };
      }
      // Fallback to the looser saved-place match (up to 1 km) when nothing is within 20 m.
      if (!best) {
        const match = nearestWorkingPlace(res.lat, res.lng, workingPlaceOptionsRef.current, 1000);
        if (match) best = { name: match.name, value: match.name, distance: match.distance };
      }
      if (best) {
        setDetectedPlace(best.name);
        setDetectedDistance(best.distance);
        setWorkingPlace(best.value);
        setSiteNumber('');
      } else {
        setDetectedPlace(null);
        setWorkingPlace('');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCheckoutForm]);

  // No "Prepare Check Out" step: the moment the user is checked in, open the check-out UI so
  // its GPS auto-detect (above) fires immediately when the page opens.
  useEffect(() => {
    if (isCheckedIn && !isCheckedOut && !checkoutBlocked) setShowCheckoutForm(true);
  }, [isCheckedIn, isCheckedOut, checkoutBlocked]);

  // First time a checked-in user sees the "Update location" button, flash a short coachmark so
  // they notice the new feature. Shown once (persisted in localStorage), auto-hides after 6s.
  useEffect(() => {
    if (loading || !isCheckedIn || showLocForm) return;
    if (typeof window === 'undefined') return;
    try { if (localStorage.getItem('seenUpdateLocHint')) return; } catch { /* ignore */ }
    setShowLocHint(true);
    const id = setTimeout(() => {
      setShowLocHint(false);
      try { localStorage.setItem('seenUpdateLocHint', '1'); } catch { /* ignore */ }
    }, 6000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, isCheckedIn, showLocForm]);

  // Blink the Update-location button until it's been used at least once (persisted).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { setLocBlink(!localStorage.getItem('usedUpdateLoc')); } catch { /* ignore */ }
  }, []);

  // Restore the user's last map choice after hydration (never during the first render).
  useEffect(() => {
    try { setMapOpen(localStorage.getItem('attMapOpen') === '1'); } catch { /* ignore */ }
  }, []);

  const toggleMap = () => {
    setMapOpen(open => {
      try { localStorage.setItem('attMapOpen', open ? '0' : '1'); } catch { /* ignore */ }
      return !open;
    });
  };

  return (
    <>
      {isExec && (
        <ReleasePicksDialog
          open={releaseOpen}
          onOpenChange={setReleaseOpen}
          supervisorEpf={user?.epf_number ?? ''}
          onCheckout={doCheckOut}
        />
      )}
      {/* Check-In / Check-Out Card */}
      <Reveal delay={0.05} className={props.className}>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 p-4 sm:p-5">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm text-foreground">{t.todayAttendance}</CardTitle>
            {isShiftDay && (
              <Badge variant="default" className="text-[10px]">
                <Clock className="w-2.5 h-2.5" aria-hidden="true" /> {t.shiftDay}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Meal booking (chamary/food module) — books whichever meal the app clock is in
                right now. Self-gates on tenant feature + role, so it renders nothing for most
                employees, and only appears once checked in today (before that there's no
                check-in location to suggest a chamary from). Sits here so it lands next to
                "Full View" on the dashboard and top-right of the card on /attendance. */}
            {hasCheckIn && (
              <LunchButton
                user={user}
                checkInSiteId={attAny?.check_in_site_id ?? mapPlaceOpt?.id ?? null}
                checkInPlaceName={attAny?.working_place ?? attendance?.working_place ?? mapPlaceOpt?.name ?? todaySchedule?.working_place ?? null}
              />
            )}
            <Button asChild variant="link" size="sm" className="h-auto p-0">
              <Link href="/attendance">
                {t.fullView} <ArrowRight className="w-3 h-3" />
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0 sm:p-5 sm:pt-0">

        {/* Forgot-to-check-out banner — a prior day left open. Links to the attendance
            page so the user can set the missing check-out time for that day. */}
        {!loading && dangling && (
          <Link href="/attendance" className="block">
            <div className="flex items-start gap-2.5 rounded-xl border border-warning/20 bg-warning/10 p-3 transition-colors hover:bg-warning/15">
              <AlertCircle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-warning">{t.forgotCheckoutTitle}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t.forgotCheckoutBody.replace('{date}', formatDate(dangling.date)).replace('{time}', formatTime(dangling.checkIn))}
                </p>
                <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-primary">
                  {t.forgotCheckoutAction} <ArrowRight className="w-3 h-3" />
                </span>
              </div>
            </div>
          </Link>
        )}

        {/* Status block — the card's headline, answering in order: am I checked in, for how
            long, since when, until when. Deliberately above every optional strip so all four
            survive a 360px viewport without scrolling. Not gated on `loading`: while a refresh
            runs the previous values stay put instead of collapsing the card. */}
        {hasCheckIn && (
          <div className="overflow-hidden rounded-xl border border-border">
            {/* Only the state line is a live region — the worked figure below re-renders every
                half minute and would otherwise re-announce itself all day. */}
            {/* While the session is OPEN this block is red; before check-in the card stays blue.
                Note --success, --primary and --brand all resolve to the SAME azure in
                globals.css, so a "success" class here rendered blue and made checked-in and
                not-yet-checked-in look identical. --destructive is the only distinct hue. */}
            <div
              role="status"
              className={`flex items-center gap-2 px-3 py-2.5 ${isCheckedIn ? 'bg-destructive/10' : 'bg-muted/40'}`}
            >
              {isCheckedIn ? (
                <span className="relative flex h-2.5 w-2.5 flex-shrink-0" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-destructive opacity-60 animate-ping motion-reduce:animate-none" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-destructive" />
                </span>
              ) : (
                <Check className={`h-4 w-4 flex-shrink-0 ${hasCheckOut ? 'text-success' : 'text-muted-foreground'}`} aria-hidden="true" />
              )}
              <span className={`min-w-0 flex-1 truncate text-sm font-bold ${isCheckedIn ? 'text-destructive' : 'text-foreground'}`}>
                {statusLabel}
              </span>
              {(isCheckedIn || hasCheckOut) && (
                <Badge variant={isCheckedIn ? 'destructive' : 'muted'} className="flex-shrink-0 text-[10px]">
                  {isCheckedIn ? t.statusActive : t.statusDone}
                </Badge>
              )}
            </div>

            {/* How long — the single most important number on the card, now carrying its label. */}
            <div className="border-t border-border px-3 py-2.5">
              <div className="text-[10px] font-semibold uppercase leading-tight tracking-wide text-muted-foreground">
                {t.workedLegend}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="font-mono text-2xl font-bold leading-none tabular-nums text-foreground">
                  {workedMins == null ? '—' : durationLabel(workedMins, t.hShort, t.mShort)}
                </span>
                {isCheckedIn && (
                  <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-success animate-pulse motion-reduce:animate-none" aria-hidden="true" />
                )}
              </div>
            </div>

            {/* Since / until. An empty check-out reads "Not yet" rather than a dead "--:--". */}
            <div className="grid grid-cols-2 border-t border-border">
              <div className="flex items-center gap-2 px-3 py-2">
                <LogIn className="h-4 w-4 flex-shrink-0 text-success" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase leading-tight tracking-wide text-muted-foreground">{t.checkIn}</div>
                  <div className="mt-0.5 truncate font-mono text-sm font-bold leading-none text-foreground">
                    {formatTime(attendance?.check_in ?? '')}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 border-l border-border px-3 py-2">
                <LogOut className={`h-4 w-4 flex-shrink-0 ${hasCheckOut ? 'text-primary' : 'text-muted-foreground/60'}`} aria-hidden="true" />
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase leading-tight tracking-wide text-muted-foreground">{t.checkOut}</div>
                  <div className={`mt-0.5 truncate text-sm font-bold leading-none ${hasCheckOut ? 'font-mono text-foreground' : 'text-muted-foreground'}`}>
                    {hasCheckOut ? formatTime(attendance?.check_out ?? '') : t.notYet}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Picked supervisor info banner */}
        {!loading && !isExec && currentSession?.picked_by_name && (
          <div className="p-2.5 rounded-lg bg-brand/10 border border-brand/20 text-[11px] text-brand font-medium flex items-center gap-2">
            <UserCheck className="w-3.5 h-3.5 flex-shrink-0 text-brand" />
            <span>
              Picked by <strong>{currentSession.picked_by_name}</strong>
              {currentSession.picked_at && (
                <>
                  {' '}at{' '}
                  <strong>
                    {(() => {
                      try {
                        const dateObj = currentSession.picked_at.toDate ? currentSession.picked_at.toDate() : new Date(currentSession.picked_at);
                        return dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                      } catch {
                        return '';
                      }
                    })()}
                  </strong>
                </>
              )}
            </span>
          </div>
        )}

        {/* Overnight shift in progress */}
        {isOvernightOpen && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-primary/10 border border-primary/20 text-xs text-primary">
            <Clock className="w-4 h-4 flex-shrink-0" />
            {t.overnightInProgress}
          </div>
        )}

        {/* Scheduled working place today (badge above the check-in / check-out cards) */}
        {todaySchedule && (
          <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-xs text-primary">
            <CalendarCheck className="w-4 h-4 flex-shrink-0" />
            <span>
              Scheduled today: <span className="font-semibold">{todaySchedule.working_place}{todaySchedule.site_number ? ` (${todaySchedule.site_number})` : ''}</span>
            </span>
            {placeHasTag(todaySchedule.working_place, 'shift') && (
              <Badge variant="default" className="ml-auto flex-shrink-0 text-[10px]">
                <Clock className="w-2.5 h-2.5" /> {t.shiftDay}
              </Badge>
            )}
          </div>
        )}

        {/* Next scheduled shift (southernlanka only — see the lookahead effect above). Also
            surfaces the attendance-method reminder alongside it, so it doubles as a nudge for
            how to actually mark attendance when that shift comes around. */}
        {isSouthernlanka && nextShift && nextShift.length > 0 && (
          <Link href="/my-schedule" className="block">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50 transition-colors">
              <Clock className="w-4 h-4 flex-shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate">
                Next shift:{' '}
                <span className="font-semibold text-foreground">
                  {parseDateInput(nextShift[0].date)?.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  {' — '}{nextShift.map((s) => s.shift_name).join(', ')}
                </span>{' '}
                <span className="text-muted-foreground">
                  ({nextShift.map((s) => timeRange(s.start_time, s.end_time)).join(', ')})
                </span>
              </span>
              <span className="flex-shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold text-primary">
                {mobileAllowed ? <Smartphone className="w-3 h-3" /> : <Fingerprint className="w-3 h-3" />}
                {mobileAllowed ? 'Mobile or Fingerprint' : 'Fingerprint only'}
              </span>
            </div>
          </Link>
        )}

        {/* Where — answered in text first. The trail map was the largest element on the card
            while carrying the least information (two pins), so it is now opt-in and the choice
            is remembered. That also makes the lazy import at the top of this file behave as its
            comment claims: leaflet is fetched only once someone actually opens the map. */}
        {hasCheckIn && (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="flex items-center gap-2 px-3 py-2">
            <MapPin className="h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase leading-tight tracking-wide text-muted-foreground">{t.workplaceMapLabel}</div>
              <div className="mt-0.5 truncate text-xs font-semibold text-foreground">{placeLabel ?? '—'}</div>
            </div>
            {hasTrailPoints && (
              <button
                type="button"
                onClick={toggleMap}
                aria-expanded={mapOpen}
                aria-controls={mapPanelId}
                className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {mapOpen ? t.hideMapBtn : t.showMapBtn}
                <ChevronDown className={`h-3 w-3 transition-transform motion-reduce:transition-none ${mapOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
              </button>
            )}
          </div>

          {/* Every place this session worked at (with the time each was recorded) — shown once
              the history holds more than one. Hovering a chip focuses the map when it's open. */}
          {Array.isArray(attAny?.locations) && attAny.locations.length > 1 && (
            <div className="border-t border-border px-3 py-2">
              <SessionLocations
                locations={attAny.locations}
                showTime
                onHover={loc => setFocusedLoc(loc && loc.lat != null && loc.lng != null ? { lat: loc.lat, lng: loc.lng } : null)}
              />
            </div>
          )}

          {hasTrailPoints ? (
            <div id={mapPanelId}>
              {mapOpen && (
                <>
                  <div className="h-48 w-full border-t border-border sm:h-56">
                    <AttendanceMiniMap
                      variant="panel"
                      trail={trail}
                      focus={focusedLoc}
                      place={mapPlace}
                      labels={{ checkIn: t.checkIn, checkOut: t.checkOut, place: mapPlaceOpt?.name ?? t.workplaceMapLabel }}
                      className="h-full w-full"
                    />
                  </div>
                  {/* Legend + open-in-maps */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-muted/20 px-3 py-1.5 text-[10px] text-muted-foreground">
                    {/* Check-in and check-out are the same azure on the map — the design system
                        gives them no distinct hue — so the pins are told apart by SHAPE: solid
                        vs hollow. These swatches mirror that exactly: a filled dot and a ring.
                        They used to be two identical-looking dots. */}
                    <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-success" aria-hidden="true" />{t.checkIn}</span>
                    {updatePoints.length > 0 && (
                      <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-warning" aria-hidden="true" />{updatePoints.length} update{updatePoints.length > 1 ? 's' : ''}</span>
                    )}
                    <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full border-2 border-primary bg-card" aria-hidden="true" />{t.checkOut}</span>
                    {(coPoint ?? ciPoint) && (
                      <a href={mapsLink((coPoint ?? ciPoint)!.lat, (coPoint ?? ciPoint)!.lng)} target="_blank" rel="noopener noreferrer"
                        className="ml-auto inline-flex items-center gap-0.5 font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
                        <MapPin className="h-2.5 w-2.5" aria-hidden="true" /> {t.openInMaps}
                      </a>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : (
            <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">Location not captured</p>
          )}
        </div>
        )}

        {loading && <div className="flex items-center justify-center py-4"><Loader2 className="w-5 h-5 text-muted-foreground animate-spin" /></div>}

        {/* The former standalone "Attendance Completed" panel is gone: the status block above
            already states the completed state, and the location block already names the places
            it used to repeat. */}

        {/* Full-day leave → block all check-in/out with an explanatory banner */}
        {!loading && isLeaveDay && (
          <div className="rounded-xl p-6 border border-brand/20 bg-brand/5 flex flex-col items-center text-center gap-3">
            <div className="w-14 h-14 rounded-xl bg-brand/15 border border-brand/20 flex items-center justify-center">
              <Palmtree className="w-7 h-7 text-brand" />
            </div>
            <div>
              <h3 className="text-base font-bold text-foreground">{t.leaveTodayTitle}</h3>
              <p className="text-muted-foreground text-xs mt-0.5">{t.attendanceUnavailable}</p>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand/10 border border-brand/20">
              <CalendarOff className="w-3.5 h-3.5 text-brand" />
              <span className="text-xs font-semibold text-brand">{formatDate(localDateString())}</span>
            </div>
          </div>
        )}

        {/* Half-day leave → info only; check-in/out still allowed */}
        {!loading && !isLeaveDay && isHalfDay && (
          <div className="rounded-xl px-4 py-3 border border-warning/20 bg-warning/5 flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-warning/15 border border-warning/20 flex items-center justify-center flex-shrink-0">
              <Palmtree className="w-4 h-4 text-warning" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-warning">{t.halfDayLeaveToday}</p>
              {(leaveCheck?.half_day_period === 'morning' || leaveCheck?.half_day_period === 'afternoon') && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t.halfDayHintTemplate
                    .replace('{a}', leaveCheck.half_day_period === 'morning' ? t.periodMorning : t.periodAfternoon)
                    .replace('{b}', leaveCheck.half_day_period === 'morning' ? t.periodAfternoon : t.periodMorning)}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Checkout blocked for technician */}
        {!loading && !isLeaveDay && checkoutBlocked && (
          <div className="p-3 rounded-xl bg-warning/10 border border-warning/20 text-xs text-warning font-medium">{t.checkInPending}</div>
        )}

        {/* Fingerprint-only account (southernlanka) → mobile check-in/out disabled entirely.
            Shown in place of whichever actionable block below would otherwise render. */}
        {!loading && !isLeaveDay && !mobileAllowed &&
          (canStartSession || (isCheckedIn && !isCheckedOut && !checkoutBlocked)) && (
          <div className="rounded-xl p-6 border border-border bg-muted/40 flex flex-col items-center text-center gap-3">
            <div className="w-14 h-14 rounded-xl bg-muted border border-border flex items-center justify-center">
              <Fingerprint className="w-7 h-7 text-muted-foreground" />
            </div>
            <div>
              <h3 className="text-base font-bold text-foreground">Fingerprint Only</h3>
              <p className="text-muted-foreground text-xs mt-0.5">
                Attendance for your account is recorded using the fingerprint terminal —
                check-in/out from this app isn&apos;t available.
              </p>
            </div>
          </div>
        )}

        {/* Can start a session → Swipe to Check In (approvals route automatically by role tier) */}
        {!loading && !isLeaveDay && mobileAllowed && canStartSession && (
          <div className="space-y-3">
            {sessions.length > 0 && <p className="text-xs text-muted-foreground text-center">{t.startAnotherSession}</p>}
            <LocationGate status={reqLoc.status} reason={reqLoc.reason} onRetry={reqLoc.retry} action="checkin" />
            {reqLoc.status === 'ready' && (actionLoading
              ? <div className="h-14 flex items-center justify-center"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>
              : (
                <div className="space-y-2">
                  <SwipeButton onComplete={handleCheckIn} label={t.swipeCheckIn} type="checkin" resetKey={checkinResetKey} />
                  <KeyboardConfirm label={t.checkIn} armedLabel={PRESS_AGAIN} onConfirm={handleCheckIn} />
                </div>
              ))
            }
          </div>
        )}

        {/* Checked in, not checked out, not blocked → Checkout form. The "Currently Checked In"
            line that used to open this block now lives in the status block at the top of the
            card, where it leads rather than trails. */}
        {!loading && !isLeaveDay && mobileAllowed && isCheckedIn && !isCheckedOut && !checkoutBlocked && (
          <div className="space-y-3">
            {checkInPendingApproval && (
              <div className="p-2.5 rounded-lg bg-warning/10 border border-warning/20 text-[11px] text-warning font-medium flex items-center gap-2 mb-2">
                <AlertCircle className="w-3.5 h-3.5" />
                <span>{t.checkInPending} (You can still check out)</span>
              </div>
            )}

            {showLocForm ? (
              /* Update location — auto-GPS form (adds the current place to today's trail) */
              <div className="rounded-xl border border-border bg-muted/40 p-3">
                <UpdateSessionLocation
                  epfNumber={user?.epf_number ?? ''}
                  date={(attendance?.date ?? '').split(' ')[0] || localDateString()}
                  sessionId={openSession?.id ?? null}
                  onDone={async () => { setShowLocForm(false); await props.onMutated(); }}
                  onCancel={() => setShowLocForm(false)}
                />
              </div>
            ) : (
              <>
                {/* Location is mandatory. When it isn't ready, show ONLY the gate. */}
                <LocationGate status={reqLoc.status} reason={reqLoc.reason} onRetry={reqLoc.retry} action="checkout" />
                {reqLoc.status === 'ready' && (
                  <>
                    {/* Auto-detected working place (GPS captured the moment the page opened) */}
                    <div>
                      <div className="flex items-center flex-wrap gap-2 mb-2">
                        {/* No required-field asterisk: the swipe below is the one that states
                            the requirement, in words, and stays disabled until it is met. */}
                        <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">{t.workingPlaceLabel}</p>
                        {workingPlace && (
                          <OutstationBadge
                            date={localDateString()}
                            place={workingPlace}
                            gps={detectedLocRef.current ? { lat: detectedLocRef.current.lat, lng: detectedLocRef.current.lng } : null}
                          />
                        )}
                      </div>
                      {detecting ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted border border-border rounded-md px-3 py-2.5">
                          <Loader2 className="w-4 h-4 animate-spin text-primary" /> {t.detectingLocation}
                        </div>
                      ) : detectedPlace ? (
                        <div className="flex items-center justify-between gap-2 bg-success/10 border border-success/20 rounded-md px-3 py-2.5">
                          <span className="flex items-center gap-2 text-sm text-success min-w-0">
                            <MapPin className="w-4 h-4 flex-shrink-0" />
                            <span className="truncate">{detectedPlace}</span>
                            {detectedDistance != null && (
                              <span className="text-success/60 text-xs flex-shrink-0">· {detectedDistance}m</span>
                            )}
                          </span>
                          <button
                            type="button"
                            onClick={() => { setDetectedPlace(null); setWorkingPlace(''); setSiteNumber(''); setChangeClicked(true); }}
                            className="text-xs text-muted-foreground hover:text-foreground flex-shrink-0 transition-colors"
                          >
                            {t.changeWord}
                          </button>
                        </div>
                      ) : (
                        <>
                          {!changeClicked && geoError && <p className="text-[11px] text-warning mb-1.5">{geoError}</p>}
                          <SmartWorkingPlaceSelect
                            value={workingPlace}
                            onChange={name => { setWorkingPlace(name); setSiteNumber(''); }}
                            gps={detectedLocRef.current}
                          />
                        </>
                      )}
                    </div>
                    {requiresSite(workingPlace) && (
                      <Input type="text" value={siteNumber} onChange={e => setSiteNumber(e.target.value)} placeholder={t.siteNumberPlaceholder} />
                    )}

                    {/* Check-out swipe, with "Update location" as a compact icon button beside it
                        rather than a full-width control stacked underneath — it is an occasional
                        action and should not read as a second primary button.
                        The swipe keeps SwipeButton's own destructive palette: red means "you are
                        currently checked in", matching the status block at the top of the card.
                        It used to be re-toned to primary here, which made it indistinguishable
                        from the blue pre-check-in swipe. */}
                    <div className="space-y-2">
                      <div className="flex items-stretch gap-2">
                        <div className="min-w-0 flex-1">
                          {actionLoading ? (
                            <div className="flex h-14 items-center justify-center rounded-full border border-border bg-muted/30"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>
                          ) : (
                            <SwipeButton onComplete={handleCheckOut} label={canCheckOut ? t.swipeCheckOut : t.selectPlaceFirst} type="checkout" disabled={!canCheckOut} resetKey={checkoutResetKey} />
                          )}
                        </div>

                        {/* Icon-only, so it needs its accessible name from aria-label. Blinks
                            until first use, with the EN/SI coachmark anchored to its right edge
                            (it sits at the edge of the card now, so a centred tooltip would
                            overflow). */}
                        <div className="relative flex-shrink-0">
                          <button
                            type="button"
                            onMouseEnter={() => setShowLocHint(true)}
                            onMouseLeave={() => setShowLocHint(false)}
                            onClick={() => {
                              setShowLocForm(true); setShowLocHint(false); setLocBlink(false);
                              try { localStorage.setItem('seenUpdateLocHint', '1'); localStorage.setItem('usedUpdateLoc', '1'); } catch { /* ignore */ }
                            }}
                            title={t.updateLocation}
                            aria-label={t.updateLocation}
                            className={`inline-flex h-14 w-14 items-center justify-center rounded-full border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${locBlink ? 'animate-attn-blink border-primary/40 text-primary' : 'border-border'}`}
                          >
                            <MapPin className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
                          </button>
                          <AnimatePresence>
                            {showLocHint && (
                              <motion.div
                                /* Opacity only — a fade needs no reduced-motion guard. */
                                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                                className="absolute right-0 top-full z-20 mt-2 w-max max-w-[240px] space-y-0.5 rounded-lg bg-primary px-3 py-2 text-[11px] font-medium leading-snug text-primary-foreground shadow-popover"
                              >
                                <div>📍 Log where you&apos;re working now — added to today&apos;s attendance trail.</div>
                                <div className="opacity-90">📍 ඔබ දැන් සේවය කරන ස්ථානය සටහන් කරන්න — අද පැමිණීමේ මාර්ගයට එක් වේ.</div>
                                <span className="absolute right-5 bottom-full h-0 w-0 border-4 border-transparent border-b-primary" />
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      </div>

                      <KeyboardConfirm
                        label={t.checkOut}
                        armedLabel={PRESS_AGAIN}
                        blockedLabel={t.selectPlaceFirst}
                        blocked={!canCheckOut}
                        onConfirm={handleCheckOut}
                      />
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}
        </CardContent>
      </Card>
      </Reveal>
    </>
  );
}
