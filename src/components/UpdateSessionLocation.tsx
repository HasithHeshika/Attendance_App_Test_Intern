'use client';
import { useEffect, useRef, useState } from 'react';
import { Loader2, MapPin } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import OutstationBadge from '@/components/OutstationBadge';
import { useWorkingPlaces } from '@/store/workingPlacesStore';
import { useSolarSites } from '@/components/useSolarSites';
import { useT } from '@/store/appStore';
import { _attendanceApi as attendanceApi } from '@/services/apiCompat';
import { requestDeviceLocation, distanceMeters, nearestWorkingPlace } from '@/lib/geo';

// One-tap "Update location" — adds the CURRENT place to a session's location history.
// Shared by the attendance day modal and the Today card (dashboard + attendance page).
// On mount it captures GPS, resolves the place exactly like the check-out flow (confident
// ≤50 m match on saved places + Solar sites, else nearest saved place within 1 km, else a
// time-stamped GPS label) and SAVES IMMEDIATELY — no confirmation step. Buttons appear
// only when input is genuinely needed: a site number for site places, or a retry/cancel
// after a failure.
export default function UpdateSessionLocation({ epfNumber, date, sessionId, onDone, onCancel }: {
  epfNumber: string;
  date: string;                       // YYYY-MM-DD of the attendance record
  sessionId: string | null;
  onDone?: () => void | Promise<void>;  // called after a successful update
  onCancel?: () => void;
}) {
  const t = useT();
  const { requiresSite, options: wpOptions } = useWorkingPlaces();
  const solarSites = useSolarSites(true);

  const [form, setForm] = useState({ working_place: '', site_number: '' });
  const [detecting, setDetecting] = useState(true);
  const [detectedPlace, setDetectedPlace] = useState<string | null>(null);
  const [detectedDistance, setDetectedDistance] = useState<number | null>(null);
  const [geoError, setGeoError] = useState('');
  const [saving, setSaving] = useState(false);
  // Auto-save failed (network etc.) → surface manual retry/cancel buttons.
  const [autoFailed, setAutoFailed] = useState(false);
  const gpsRef = useRef<{ lat: number; lng: number; accuracy: number | null } | null>(null);
  // Latest option lists in refs so the one-shot detect effect reads fresh data without
  // re-firing (and wiping the resolved place) when the arrays load in.
  const wpRef = useRef(wpOptions); wpRef.current = wpOptions;
  const solarRef = useRef(solarSites); solarRef.current = solarSites;

  const save = async (placeName?: string, site?: string) => {
    const wp = placeName ?? form.working_place;
    const sn = site ?? form.site_number;
    if (!wp) { toast.error(t.workingPlaceRequired); return; }
    if (requiresSite(wp) && !sn.trim()) { toast.error(t.siteNumberRequiredForPlace); return; }
    setSaving(true);
    try {
      await attendanceApi.updateSessionLocation({
        epf_number: epfNumber,
        date,
        session_id: sessionId,
        working_place: wp,
        site_number: requiresSite(wp) ? sn : null,
        gps_lat: gpsRef.current?.lat ?? null,
        gps_lng: gpsRef.current?.lng ?? null,
      });
      toast.success(t.locationUpdated);
      await onDone?.();
    } catch (err: unknown) {
      toast.error(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? (err as Error)?.message
        ?? t.failedUpdateLocation,
      );
      setAutoFailed(true);
    }
    setSaving(false);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await requestDeviceLocation({ timeoutMs: 8000 });
      if (cancelled) return;
      setDetecting(false);
      if (!res.ok) { setGeoError(res.reason); return; }
      gpsRef.current = { lat: res.lat, lng: res.lng, accuracy: res.accuracy };
      const CONFIDENT_M = 50;
      let best: { name: string; value: string; distance: number } | null = null;
      for (const p of wpRef.current) {
        if (p.latitude == null || p.longitude == null) continue;
        const d = distanceMeters(res.lat, res.lng, p.latitude, p.longitude);
        if (d <= CONFIDENT_M && (!best || d < best.distance)) best = { name: p.name, value: p.name, distance: Math.round(d) };
      }
      for (const s of solarRef.current) {
        const d = distanceMeters(res.lat, res.lng, s.lat, s.lng);
        if (d <= CONFIDENT_M && (!best || d < best.distance)) best = { name: s.name, value: `${s.name} (#${s.siteNo})`, distance: Math.round(d) };
      }
      if (!best) {
        const match = nearestWorkingPlace(res.lat, res.lng, wpRef.current, 1000);
        if (match) best = { name: match.name, value: match.name, distance: match.distance };
      }
      let value: string;
      if (best) {
        setDetectedPlace(best.name);
        setDetectedDistance(best.distance);
        value = best.value;
      } else {
        // No known place nearby — auto-record the raw GPS under a time-stamped label so each
        // update stays a distinct stop on the map trail (location history dedups by name).
        const now = new Date();
        const label = `${t.updateLocation} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        setDetectedPlace(label);
        setDetectedDistance(null);
        value = label;
      }
      setForm({ working_place: value, site_number: '' });
      // One tap: save straight away unless the place needs a site number typed first.
      if (!requiresSite(value)) void save(value, '');
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Manual input is only needed for a site number, after a failed auto-save, or on GPS error.
  const needsManual = !detecting && (!form.working_place || requiresSite(form.working_place) || autoFailed);

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center flex-wrap gap-2 mb-1.5">
          <label className="text-xs text-muted-foreground block font-medium">{t.workingPlaceLabel} <span className="text-destructive">*</span></label>
          {form.working_place && <OutstationBadge date={date} place={form.working_place} />}
        </div>
        {detecting ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted border border-border rounded-md px-3 py-2.5">
            <Loader2 className="w-4 h-4 animate-spin text-primary" /> {t.detectingLocation}
          </div>
        ) : form.working_place ? (
          /* Auto-captured from GPS — location is fixed to where you are now (not selectable). */
          <div className="flex items-center gap-2 bg-success/10 border border-success/20 rounded-md px-3 py-2.5">
            <MapPin className="w-4 h-4 flex-shrink-0 text-success" />
            <span className="truncate text-sm text-success min-w-0">{detectedPlace}</span>
            {detectedDistance != null && (
              <span className="text-success/60 text-xs flex-shrink-0">· {detectedDistance}m</span>
            )}
            {saving ? (
              <Loader2 className="ml-auto w-3.5 h-3.5 flex-shrink-0 animate-spin text-success" />
            ) : (
              <span className="ml-auto flex-shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold text-success">Auto</span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 bg-warning/10 border border-warning/20 rounded-md px-3 py-2.5 text-sm text-warning">
            <MapPin className="w-4 h-4 flex-shrink-0" />
            <span className="truncate">{geoError || t.failedUpdateLocation}</span>
          </div>
        )}
      </div>

      {requiresSite(form.working_place) && (
        <div>
          <label className="text-xs text-muted-foreground mb-1 block font-medium">
            {t.siteNumberLabel} <span className="text-destructive">*</span>
          </label>
          <input type="text" value={form.site_number}
            onChange={e => setForm(p => ({ ...p, site_number: e.target.value }))}
            className={`h-9 w-full bg-background border rounded-md px-3 text-foreground text-sm focus:outline-none placeholder:text-muted-foreground ${!form.site_number.trim() ? 'border-destructive/40 focus:border-destructive/60' : 'border-border focus:border-ring focus:ring-1 focus:ring-ring'}`}
            placeholder={t.egSite} />
          {!form.site_number.trim() && (
            <p className="text-[11px] text-destructive mt-1">{t.requiredForThisPlace}</p>
          )}
        </div>
      )}

      {needsManual && (
        <div className="flex gap-3">
          {onCancel && (
            <Button variant="outline" onClick={onCancel} className="flex-1 py-2.5 h-auto">
              {t.cancel}
            </Button>
          )}
          {form.working_place && (
            <Button onClick={() => save()} disabled={saving || detecting} className="flex-1 py-2.5 h-auto font-semibold">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <MapPin className="w-4 h-4" />}
              {t.updateWord}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
