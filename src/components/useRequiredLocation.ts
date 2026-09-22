'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  requestDeviceLocation, claimDenialReload, COLD_START_SETTLE_MS,
  type GeoResult, type GeoRequestOpts,
} from '@/lib/geo';

// 'checking' — a request is in flight (mount or retry)
// 'ready'    — we have a usable fix; check-in/out is allowed
// 'blocked'  — permission denied / position unavailable / timeout / insecure / unsupported
export type LocationStatus = 'checking' | 'ready' | 'blocked';

export interface Coords { lat: number; lng: number; accuracy: number | null }

// Owns location state and asks for it proactively on mount. `ensureLocation()` is the
// authoritative gate — call it at the moment of check-in/out for a fresh fix.
export function useRequiredLocation() {
  const [status, setStatus] = useState<LocationStatus>('checking');
  const [reason, setReason] = useState('');
  const [coords, setCoords] = useState<Coords | null>(null);
  // Latest status readable inside event handlers without re-subscribing.
  const statusRef = useRef(status);
  statusRef.current = status;
  // Generation token. A later attempt always supersedes an earlier one, so the answer to
  // a request that the OS froze mid-flight while the app sat in the background can never
  // overwrite the fresh one we asked for on the way back in.
  const genRef = useRef(0);

  // Request a fix and reflect the outcome in state. Stable identity.
  //   • `selfHeal` — permitted to reload the page to clear WebKit's per-document denial
  //     latch (see src/lib/geo.ts). Off at the moment of check-in/out, where a reload
  //     would throw away what the user has already filled in.
  const capture = useCallback(async (
    { timeoutMs, settleMs, fresh, selfHeal = false }: GeoRequestOpts & { selfHeal?: boolean } = {},
  ): Promise<GeoResult> => {
    const gen = ++genRef.current;
    const res = await requestDeviceLocation({ timeoutMs, settleMs, fresh });
    if (gen !== genRef.current) return res; // superseded by a newer attempt
    if (res.ok) {
      setCoords({ lat: res.lat, lng: res.lng, accuracy: res.accuracy });
      setReason('');
      setStatus('ready');
      return res;
    }
    // A 'denied' here is not proof the user refused — it is equally the latch WebKit sets
    // for the lifetime of a document, which only a new document clears. Spend the one
    // reload we are allowed per app launch rather than showing settings guidance that
    // cannot possibly help.
    if (res.code === 'denied' && selfHeal && await claimDenialReload()) {
      if (gen === genRef.current) setStatus('checking'); // don't flash the gate on the way out
      window.location.reload();
      return res;
    }
    if (gen !== genRef.current) return res;
    setReason(res.reason);
    setStatus('blocked');
    return res;
  }, []);

  // The check-in/out gate: a fresh fix, and never a reload — see `selfHeal` above.
  const ensureLocation = useCallback(() => capture({ fresh: true }), [capture]);

  // Proactive request on mount (warms GPS, surfaces a blocked state early). Held until the
  // document is actually foreground: asking during an installed app's launch is what makes
  // the platform answer "no" without ever showing a prompt.
  useEffect(() => { void capture({ settleMs: COLD_START_SETTLE_MS, selfHeal: true }); }, [capture]);

  // Auto-recover when the user flips the OS/browser permission while on the page.
  // If it flips to "granted" while we were blocked, reload so the whole app reflects it.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;
    let perm: PermissionStatus | null = null;
    const onChange = () => {
      if (perm?.state === 'granted' && statusRef.current === 'blocked') { window.location.reload(); return; }
      void capture({ fresh: true, selfHeal: true });
    };
    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then(p => { perm = p; p.addEventListener('change', onChange); })
      .catch(() => { /* Permissions API unavailable — visibility fallback below covers iOS */ });
    return () => { perm?.removeEventListener('change', onChange); };
  }, [capture]);

  // iOS/Safari have no geolocation Permissions API. When the user returns to the app (e.g.
  // from device Settings) and location now works though it was blocked before, reload so
  // the mandatory-location gate clears everywhere.
  //
  // `fresh` matters more than it looks: iOS freezes JS on background, so the attempt that
  // was in flight when the user left is still pending and would otherwise be handed back
  // here as a stale failure — the exact reason the old code appeared to ignore the trip to
  // Settings. `pageshow` covers the bfcache restore, which is also the moment WebKit calls
  // resetAllGeolocationPermission() and a retry can genuinely succeed.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const recheck = async () => {
      if (document.visibilityState !== 'visible' || statusRef.current !== 'blocked') return;
      const res = await capture({ timeoutMs: 8000, fresh: true, selfHeal: true });
      if (res.ok) window.location.reload();
    };
    const onVisible = () => { void recheck(); };
    const onPageShow = () => { void recheck(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [capture]);

  const retry = useCallback(() => {
    setStatus('checking');
    void capture({ fresh: true, selfHeal: true });
  }, [capture]);

  return { status, reason, coords, ensureLocation, retry };
}
