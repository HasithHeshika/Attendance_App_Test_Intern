'use client';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useWorkingPlaces } from '@/store/workingPlacesStore';
import { useAuthStore } from '@/store/authStore';
import { useSolarSites } from './useSolarSites';
import { distanceMeters } from '@/lib/geo';
import { getScheduleForDate } from '@/services/workingScheduleService';

const OUTSTATION_M = 60_000; // 60 km

type LatLng = { lat: number; lng: number };

/**
 * Live outstation preview shown next to a working-place picker. Mirrors the server rule:
 * the location (a live GPS reading when given, else the chosen place's coordinates) vs that
 * day's reference base — the SCHEDULED place for the date, else the nearest saved working
 * place. >60km → outstation. Renders nothing when it can't be measured (missing coordinates).
 */
export default function OutstationBadge({
  epf, date, place, gps, className,
}: {
  epf?: string;                 // whose schedule to check (defaults to the signed-in user)
  date: string;                 // YYYY-MM-DD
  place: string;                // selected working-place name
  gps?: LatLng | null;          // live location override (check-out); else the place is the location
  className?: string;
}) {
  const { options } = useWorkingPlaces();
  const sites = useSolarSites(true);
  const meEpf = useAuthStore(s => s.user?.epf_number);
  const targetEpf = epf ?? meEpf;
  // Scheduled place NAME for (employee, date); its coordinates are resolved lazily below so the
  // fetch effect doesn't depend on the per-render place lists (which would loop forever).
  const [schedPlace, setSchedPlace] = useState<string | null>(null);

  // Resolve a working-place name (admin place or Solar site) to coordinates.
  const placeCoords = (name: string | null | undefined): LatLng | null => {
    if (!name) return null;
    const wp = options.find(o => o.name === name && o.latitude != null && o.longitude != null);
    if (wp) return { lat: wp.latitude as number, lng: wp.longitude as number };
    const s = sites.find((x: { name: string; siteNo: string; lat: number; lng: number }) => `${x.name} (#${x.siteNo})` === name);
    if (s && s.lat != null && s.lng != null) return { lat: s.lat, lng: s.lng };
    return null;
  };

  const nearestSaved = (lat: number, lng: number): LatLng | null => {
    let best: LatLng | null = null, bestD = Infinity;
    for (const o of options) {
      if (o.latitude == null || o.longitude == null) continue;
      const d = distanceMeters(lat, lng, o.latitude, o.longitude);
      if (d < bestD) { bestD = d; best = { lat: o.latitude, lng: o.longitude }; }
    }
    return best;
  };

  // Fetch the scheduled-place NAME for this (employee, date). Depends ONLY on epf + date —
  // never on the place lists, which get fresh references each render and would loop the effect.
  useEffect(() => {
    let cancelled = false;
    setSchedPlace(null);
    if (!targetEpf || !date) return;
    (async () => {
      try {
        const s = await getScheduleForDate(targetEpf, date);
        if (!cancelled) setSchedPlace(s?.working_place ?? null);
      } catch { if (!cancelled) setSchedPlace(null); }
    })();
    return () => { cancelled = true; };
  }, [targetEpf, date]);

  const out = useMemo<boolean | null>(() => {
    // The selected working place drives the result; a live GPS reading is only a fallback when
    // that place has no coordinates. So changing the working place recalculates outstation.
    const loc = placeCoords(place) ?? gps;
    if (!loc) return null;
    const ref = (schedPlace ? placeCoords(schedPlace) : null) ?? nearestSaved(loc.lat, loc.lng);
    if (!ref) return null;
    return distanceMeters(loc.lat, loc.lng, ref.lat, ref.lng) > OUTSTATION_M;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gps?.lat, gps?.lng, place, schedPlace, options, sites]);

  // Only surface the badge when it's actually outstation — stay silent when within range.
  if (out !== true) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border border-warning/20 bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning ${className ?? ''}`}>
      <AlertTriangle className="w-3 h-3 flex-shrink-0" />
      Outstation
    </span>
  );
}
