'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2, MapPin, MapPinOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { requestDeviceLocation, claimDenialReload, isStandalonePWA, COLD_START_SETTLE_MS } from '@/lib/geo';
import { useT } from '@/store/appStore';

// App-wide "location is off" prompt, rendered under the header for attendance users.
// Requests location shortly after the app opens — which pops the native permission
// prompt while it's still undecided — and whenever a fix can't be obtained it keeps
// a one-tap "Turn on location" button in front of the user:
//   · browser tab   → a persistent bar under the header (the address-bar controls
//                     are also available there);
//   · installed PWA → a popup dialog (there is no address bar to fix it from), with
//                     an "Open in browser" escape hatch when the permission is
//                     hard-blocked and the native prompt can't be re-opened.
// Clears automatically via the Permissions API change event, on returning to the app
// (iOS has no geolocation Permissions API at all), or — when the denial is WebKit's
// per-document latch rather than the user's answer — by reloading once to get a
// document that is allowed to ask again. See the note in src/lib/geo.ts.
export default function LocationOffBanner() {
  const t = useT();
  const [off,    setOff]    = useState(false); // no usable fix right now
  const [busy,   setBusy]   = useState(false); // a request is in flight
  const [help,   setHelp]   = useState('');    // failure reason / where to re-enable
  const [denied, setDenied] = useState(false); // hard-blocked: a request won't re-prompt
  // A reload is on its way to clear the denial latch — render nothing rather than flash a
  // dialog the user has no time to act on.
  const [healing, setHealing] = useState(false);
  // Installed-PWA mode (read after mount — window isn't available during SSR).
  const [standalone, setStandalone] = useState(false);
  // "Not now" collapses the PWA popup to the bar for this app load only.
  const [popupDismissed, setPopupDismissed] = useState(false);
  // Latest values readable inside stable callbacks/listeners.
  const offRef  = useRef(off); offRef.current = off;
  const tRef    = useRef(t);   tRef.current   = t;
  // A generation token rather than a busy flag. The old busy guard dropped exactly the
  // probe that mattered: iOS freezes JS on background, so the request in flight when the
  // user left for Settings was still "busy" when they came back, the return probe was
  // discarded, and the frozen request then resolved as a failure with nothing left to
  // retry — the app stayed wrong until it was force-quit.
  const genRef = useRef(0);

  useEffect(() => { setStandalone(isStandalonePWA()); }, []);

  // Request a fix and reflect the outcome. Toasts only on an off → on transition.
  const probe = useCallback(async ({ settleMs, fresh }: { settleMs?: number; fresh?: boolean } = {}) => {
    const gen = ++genRef.current;
    setBusy(true);
    const res = await requestDeviceLocation({ timeoutMs: 12_000, settleMs, fresh });
    if (gen !== genRef.current) return; // superseded by a newer probe
    setBusy(false);
    if (res.ok) {
      if (offRef.current) toast.success(tRef.current.locationEnabledToast, { id: 'location-on' });
      setOff(false);
      setHelp('');
      setDenied(false);
      return;
    }
    // 'denied' is not proof the user refused: WebKit latches a denial for the lifetime of
    // the document, and a request fired while an installed app is still launching can be
    // refused by the platform with no prompt ever shown. Retrying in this document cannot
    // work — only a new document can — so spend the one reload allowed per app launch.
    if (res.code === 'denied' && await claimDenialReload()) {
      if (gen !== genRef.current) return;
      setHealing(true);
      window.location.reload();
      return;
    }
    if (gen !== genRef.current) return;
    setOff(true);
    setHelp(res.reason);
    setDenied(res.code === 'denied');
  }, []);

  // Ask on app load so the user is always prompted to turn location on — but only once the
  // document is genuinely foreground and settled. Asking during an installed app's launch
  // is what gets the request refused without a prompt in the first place.
  useEffect(() => { void probe({ settleMs: COLD_START_SETTLE_MS }); }, [probe]);

  // Re-check when the user flips the browser/OS permission while the app is open.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;
    let perm: PermissionStatus | null = null;
    const onChange = () => { void probe({ fresh: true }); };
    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then(p => { perm = p; p.addEventListener('change', onChange); })
      .catch(() => { /* Permissions API unavailable — visibility fallback below */ });
    return () => { perm?.removeEventListener('change', onChange); };
  }, [probe]);

  // iOS/Safari fallback: re-check when the user returns (e.g. from device Settings).
  // `fresh` is what makes it a real re-check rather than a subscription to the stale answer
  // of the request the OS froze on the way out. `pageshow` catches the bfcache restore,
  // which is also the moment WebKit resets the permission latch and a retry can succeed.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const recheck = () => {
      if (document.visibilityState !== 'visible' || !offRef.current) return;
      void probe({ fresh: true });
    };
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('pageshow', recheck);
    return () => {
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('pageshow', recheck);
    };
  }, [probe]);

  if (!off || healing) return null;

  const turnOnButton = (
    <button
      type="button"
      onClick={() => { void probe({ fresh: true }); }}
      disabled={busy}
      className="inline-flex flex-shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPin className="h-3.5 w-3.5" />}
      {t.turnOnLocation}
    </button>
  );

  // Installed PWA → popup dialog (no browser chrome to fix the permission from).
  if (standalone && !popupDismissed) {
    return (
      <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-popover">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl border border-warning/20 bg-warning/10">
              <MapPinOff className="h-5 w-5 text-warning" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-foreground">{t.locationOffTitle}</h3>
              <p className="text-xs text-muted-foreground">{t.locationOffDesc}</p>
            </div>
          </div>
          {help && <p className="mt-3 text-[11px] leading-snug text-muted-foreground">{help}</p>}
          <div className="mt-4 space-y-2">
            <button
              type="button"
              onClick={() => { void probe({ fresh: true }); }}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
              {t.turnOnLocation}
            </button>
            {denied && (
              <>
                <p className="text-[11px] leading-snug text-muted-foreground">{t.locationOpenBrowserHint}</p>
                <button
                  type="button"
                  onClick={() => { window.open(window.location.href, '_blank', 'noopener'); }}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-accent"
                >
                  <ExternalLink className="h-4 w-4" /> {t.openInBrowser}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setPopupDismissed(true)}
              className="w-full rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {t.notNow}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Browser tab (or dismissed popup) → persistent bar under the header.
  return (
    <div className="flex-shrink-0 border-b border-warning/20 bg-warning/10 px-4 py-2.5 md:px-6">
      <div className="mx-auto flex max-w-7xl items-center gap-3">
        <MapPinOff className="h-4 w-4 flex-shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-foreground">{t.locationOffTitle}</p>
          <p className="text-[11px] leading-snug text-muted-foreground">{help || t.locationOffDesc}</p>
        </div>
        {turnOnButton}
      </div>
    </div>
  );
}
