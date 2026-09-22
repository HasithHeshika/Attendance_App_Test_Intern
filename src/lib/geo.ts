// Failure kind: 'denied' means THIS DOCUMENT cannot obtain a position — a new request in
// it will not re-open the native prompt. That is not the same as the user having refused:
// see the note above COLD_START_SETTLE_MS, and treat 'denied' as "needs a fresh document
// or a settings change", never as proof of what the user chose.
export type GeoFailCode = 'unsupported' | 'insecure' | 'denied' | 'unavailable' | 'timeout';
export type GeoResult =
  | { ok: true; lat: number; lng: number; accuracy: number | null }
  | { ok: false; reason: string; code?: GeoFailCode };

// True when running as an installed PWA (standalone/fullscreen) — there is NO address bar,
// so "click the address-bar icon" guidance is wrong; the user must use OS/app settings.
export function isStandalonePWA(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return !!(window.matchMedia?.('(display-mode: standalone)').matches
        || window.matchMedia?.('(display-mode: fullscreen)').matches
        || window.matchMedia?.('(display-mode: minimal-ui)').matches
        || nav.standalone === true);
}

// Build permission-denied guidance tailored to context: installed PWA vs browser tab,
// and iOS vs Android vs desktop — since each re-enables location in a different place.
export function permissionDeniedHelp(): string {
  if (typeof navigator === 'undefined') return 'Location permission is blocked. Allow location access, then try again.';
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua)
    || (/Macintosh/i.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document); // iPadOS reports as Mac
  const isAndroid = /Android/i.test(ua);
  const standalone = isStandalonePWA();

  if (standalone) {
    // Installed app — no address bar. Point at OS settings.
    if (isIOS) return 'Location is off for this app. Open iOS Settings → Privacy & Security → Location Services (turn on) → find this app and choose “While Using”, then come back and try again.';
    if (isAndroid) return 'Location is off for this app. Open Settings → Apps → this app → Permissions → Location → Allow, then come back and try again.';
    return 'Location is off for this app. Enable location for it in your device settings, then try again.';
  }
  // Browser tab.
  if (isIOS) return 'Location is blocked. In Safari tap “aA” in the address bar → Website Settings → Location → Allow. Also check iOS Settings → Privacy → Location Services is on. Then try again.';
  if (isAndroid) return 'Location is blocked. Tap the lock/tune icon in the address bar → Permissions → Location → Allow, then try again.';
  return 'Location is blocked. Click the location icon at the left of the address bar → allow Location for this site, then try again.';
}

// Human wording for the two failures that are NOT the user's browser permission.
const UNAVAILABLE_MSG = 'Your device couldn’t find a position. Turn on your device’s location service (GPS), then try again.';
const TIMEOUT_MSG = 'Locating timed out — try again (turning Wi-Fi on usually helps).';

// Accuracy (metres) at or below which a reading is good enough to stop early. A working
// place's geofence is DEFAULT_RADIUS_M (200 m), so anything tighter than this already
// decides the match — there is nothing to gain by waiting for the GPS to sharpen further.
const GOOD_ENOUGH_M = 100;
// Once ANY fix is in hand, spend at most this long chasing a better one. A coarse fix that
// lands in 400 ms must not be held behind a 10 s budget while someone waits to check in.
const REFINE_MS = 3_000;

// A GeolocationPositionError's numeric codes. Deliberately NOT read off the error object
// (err.PERMISSION_DENIED & co.): those constants live on the real error's prototype, and
// several Android WebViews hand the callback a plain `{ code, message }` instead — every
// comparison against the missing constant is then false, and a perfectly diagnosable
// "permission denied" degrades into the generic "could not get your location", which tells
// the user nothing about the setting they need to change.
const DENIED = 1;
const UNAVAILABLE = 2;

// ─── Asking at the right moment ──────────────────────────────────────────────
// WebKit caches a geolocation DENIAL for the lifetime of the document. From
// Geolocation::startRequest: "Check whether permissions have already been denied.
// Note that if this is the case, the permission state can not change again in the
// lifetime of this page." Once that latch is set, every later watchPosition in the
// document fails instantly with PERMISSION_DENIED — the OS is never consulted and
// the user is never prompted, so a "try again" button in the same document CANNOT
// work. Only a new document clears it (navigation, reload, or a bfcache resume),
// which is why the only fix anyone finds is force-quitting the app.
//
// The latch does not require the user to tap "Don't Allow". A request fired while
// an installed PWA is still launching — before the window is foreground, or while a
// system overlay (an incoming call, the launch animation) owns the screen — can be
// answered "no" by the platform with no prompt shown at all. That is how a phone
// with location fully enabled ends up staring at "Location is off".
//
// So: never ask before the document is visible, ask once rather than once per
// component, and when a denial arrives that we have reason to distrust, spend ONE
// reload on a fresh document rather than retrying into the latch.

// How long a freshly-visible document should settle before we ask. Long enough for an
// iOS PWA launch to finish handing over the screen, short enough not to feel laggy.
export const COLD_START_SETTLE_MS = 700;

function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

// Resolve once the document has been continuously visible for `settleMs`. Resolves at
// once where there is no document (SSR/tests). `maxWaitMs` is a backstop so a tab that
// is never shown can't leave a caller hanging forever.
export function whenForeground(
  { settleMs = 0, maxWaitMs = 30_000 }: { settleMs?: number; maxWaitMs?: number } = {},
): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  return new Promise(resolve => {
    let settle: ReturnType<typeof setTimeout> | null = null;
    let cap: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      document.removeEventListener('visibilitychange', onVis);
      if (settle) clearTimeout(settle);
      if (cap) clearTimeout(cap);
      resolve();
    };
    const arm = () => { if (!done && !settle) settle = setTimeout(finish, settleMs); };
    const onVis = () => {
      if (document.visibilityState === 'visible') { arm(); return; }
      // Hidden again before it settled — the clock restarts on the next return, because
      // a request sent to a backgrounded app is exactly what creates the latch.
      if (settle) { clearTimeout(settle); settle = null; }
    };
    document.addEventListener('visibilitychange', onVis);
    cap = setTimeout(finish, maxWaitMs);
    if (document.visibilityState === 'visible') arm();
  });
}

// The current geolocation permission, where the browser will tell us. WebKit does not
// implement the geolocation Permissions API at all, so iOS always answers 'unknown'.
// On Chrome this reports the SITE permission only: it reads 'granted' even when the
// browser's own OS-level location permission is off, so it can confirm a denial is
// bogus but must never be trusted to confirm that one is real.
export function geolocationPermissionState(): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return Promise.resolve('unknown');
  return navigator.permissions
    .query({ name: 'geolocation' as PermissionName })
    .then(p => p.state as 'granted' | 'denied' | 'prompt')
    .catch(() => 'unknown' as const);
}

// One silent reload per app launch, claimed atomically — sessionStorage is synchronous
// and JS is single-threaded, so the first caller to read-then-write wins and a second
// component reacting to the same denial gets false instead of a second reload.
// sessionStorage is per-tab, so a real app relaunch starts with a fresh budget, and a
// reload inside the launch keeps the spent one. Both are what we want.
const DENIAL_RELOAD_KEY = 'geo:denial-reload';

// True when a PERMISSION_DENIED should be answered with a new document rather than
// believed. Consumes the budget, so call it only when about to act on the answer.
export async function claimDenialReload(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  // Where the Permissions API works and says 'denied', the user really did refuse —
  // don't spend a reload, and don't hide the guidance they need behind one.
  if (await geolocationPermissionState() === 'denied') return false;
  try {
    if (sessionStorage.getItem(DENIAL_RELOAD_KEY)) return false;
    sessionStorage.setItem(DENIAL_RELOAD_KEY, '1');
  } catch {
    return false; // no sessionStorage → no budget we can track → never risk a reload loop
  }
  return true;
}

// A single shared attempt. Two components mounting at once (the app-shell banner and
// the check-in card) used to open two watches racing one permission prompt; they now
// join the same request.
let inFlight: Promise<GeoResult> | null = null;

// The actual geolocation attempt. Everything goes through requestDeviceLocation() below,
// which adds the foreground gate and the sharing — call that, not this.
// `accuracy` is the reading's 68%-confidence radius in metres (browser-reported), or null.
//
// One watchPosition pass, not a chain of getCurrentPosition calls: a watch delivers the
// first fix the moment ANY provider warms up (network positioning usually answers in well
// under a second) and keeps delivering as the GPS sharpens. getCurrentPosition instead sits
// silent until it either succeeds or burns its whole timeout — and a high-accuracy-then-low
// -accuracy pair of those spends the two timeouts back to back, which is how a 10 s budget
// turns into 15 s of staring at a spinner before an error.
//
// The failure rules that matter:
//   • PERMISSION_DENIED ends it immediately — nothing this document does can change it.
//   • POSITION_UNAVAILABLE / TIMEOUT do NOT: on a cold GPS the provider routinely errors
//     once and then delivers a position seconds later, so the watch stays open until the
//     deadline and only then reports the last error seen.
//   • A coarse fix always beats no fix — if the deadline arrives with a low-accuracy
//     reading in hand, that reading is the answer, not an error.
function runGeolocation(opts: { timeoutMs?: number } = {}): Promise<GeoResult> {
  const { timeoutMs = 10_000 } = opts;
  return new Promise(resolve => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve({ ok: false, reason: 'This browser doesn’t support location.', code: 'unsupported' });
      return;
    }
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      resolve({ ok: false, reason: 'Location needs a secure page. Open the app via http://localhost (not an IP address) or over HTTPS.', code: 'insecure' });
      return;
    }

    const geo = navigator.geolocation;
    let watchId: number | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let refine: ReturnType<typeof setTimeout> | null = null;
    // Best reading so far, and the last error code the watch reported.
    let best: { lat: number; lng: number; accuracy: number | null } | null = null;
    let lastCode = 0;
    let settled = false;

    const stop = () => {
      if (watchId !== null) geo.clearWatch(watchId);
      if (deadline) clearTimeout(deadline);
      if (refine) clearTimeout(refine);
    };
    const succeed = (fix: { lat: number; lng: number; accuracy: number | null }) => {
      if (settled) return;
      settled = true;
      stop();
      resolve({ ok: true, ...fix });
    };
    const fail = (reason: string, code?: GeoFailCode) => {
      if (settled) return;
      settled = true;
      stop();
      resolve({ ok: false, reason, code });
    };
    // Out of time (or out of patience waiting for a sharper reading): answer with whatever
    // we have, and only report a failure when we have nothing at all.
    const giveUp = () => {
      if (best) { succeed(best); return; }
      if (lastCode === UNAVAILABLE) fail(UNAVAILABLE_MSG, 'unavailable');
      else fail(TIMEOUT_MSG, 'timeout');
    };

    deadline = setTimeout(giveUp, timeoutMs);

    watchId = geo.watchPosition(
      pos => {
        const accuracy = Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null;
        const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy };
        // Keep the sharpest reading. An unknown accuracy can't be compared, so the newest
        // one wins.
        if (!best || accuracy === null || best.accuracy === null || accuracy < best.accuracy) best = fix;
        if (accuracy === null || accuracy <= GOOD_ENOUGH_M) { succeed(fix); return; }
        // Too coarse to trust a geofence to — give the GPS a moment to sharpen, but never
        // more than REFINE_MS, and never lose what we already have.
        if (!refine) refine = setTimeout(giveUp, REFINE_MS);
      },
      err => {
        const code = typeof (err as GeolocationPositionError | undefined)?.code === 'number' ? err.code : 0;
        lastCode = code;
        // Only a denied permission is final — see the comment above.
        if (code === DENIED) fail(permissionDeniedHelp(), 'denied');
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

// Options accepted by every location request in the app.
//   • `timeoutMs` — overall budget for the attempt.
//   • `settleMs`  — wait for the document to be visible and settled for this long before
//                   asking at all. Cold starts pass COLD_START_SETTLE_MS; anything driven
//                   by a user tap leaves it at 0, because the app is plainly foreground.
//   • `fresh`     — do NOT join an in-flight request. Required when the app has just come
//                   back from the background: iOS freezes JS on background, so a request
//                   that was in flight was frozen mid-attempt and its stale answer must
//                   not be handed to a caller asking precisely because things changed.
export interface GeoRequestOpts { timeoutMs?: number; settleMs?: number; fresh?: boolean }

// Device GPS with a specific failure reason. Foreground-gated and shared — see the note
// above `COLD_START_SETTLE_MS` for why both of those matter on iOS.
export function requestDeviceLocation(opts: GeoRequestOpts = {}): Promise<GeoResult> {
  if (inFlight && !opts.fresh) return inFlight;
  const settleMs = opts.settleMs ?? 0;
  // Register the watch synchronously when there is nothing to wait for: the check-in tap
  // must not pay a microtask of latency, and it keeps the call's timing observable to
  // callers that drive the geolocation mock by hand (see geo.test.ts).
  const started = settleMs === 0 && isDocumentVisible()
    ? runGeolocation(opts)
    : whenForeground({ settleMs }).then(() => runGeolocation(opts));
  inFlight = started;
  void started.finally(() => { if (inFlight === started) inFlight = null; });
  return started;
}

// Best-effort device GPS — resolves to null (never throws) when unavailable/denied.
// Used where location is optional (check-in/out capture). Includes GPS `accuracy` (m).
export async function getDeviceLocation(opts: GeoRequestOpts = {}): Promise<{ lat: number; lng: number; accuracy: number | null } | null> {
  const r = await requestDeviceLocation(opts);
  return r.ok ? { lat: r.lat, lng: r.lng, accuracy: r.accuracy } : null;
}

// Google Maps link for a coordinate (for display).
export function mapsLink(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

// Great-circle distance between two coordinates, in metres (haversine).
export function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000; // earth radius (m)
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// A place with optional coordinates (subset of WorkingPlaceLocation) we can match against.
interface PlaceWithCoords {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
}

// Default geofence radius (metres) when a place has none set.
export const DEFAULT_RADIUS_M = 200;

interface PlaceWithRadius { id: string; name: string; latitude: number | null; longitude: number | null; radius_m?: number | null; }

// Nearest place whose OWN radius contains the GPS reading (auto-match at check-in).
export function matchWithinRadius(
  lat: number | null | undefined, lng: number | null | undefined, places: PlaceWithRadius[],
): { id: string; name: string; distance: number } | null {
  if (lat == null || lng == null) return null;
  let best: { id: string; name: string; distance: number } | null = null;
  for (const p of places) {
    if (!p.id || p.latitude == null || p.longitude == null) continue;
    const d = distanceMeters(lat, lng, p.latitude, p.longitude);
    const r = p.radius_m ?? DEFAULT_RADIUS_M;
    if (d <= r && (best === null || d < best.distance)) best = { id: p.id, name: p.name, distance: Math.round(d) };
  }
  return best;
}

// Distance from a GPS reading to a specific place + whether it's inside the radius
// (check-out validation against the selected place). null when GPS/coords missing.
export function distanceToPlace(
  lat: number | null | undefined, lng: number | null | undefined, place: PlaceWithRadius | undefined | null,
): { distance: number; within: boolean } | null {
  if (lat == null || lng == null || !place || place.latitude == null || place.longitude == null) return null;
  const d = distanceMeters(lat, lng, place.latitude, place.longitude);
  return { distance: Math.round(d), within: d <= (place.radius_m ?? DEFAULT_RADIUS_M) };
}

// Match a GPS reading to the closest configured place that lies within `maxMeters`.
// Returns the place id/name and the distance, or null when no place qualifies (GPS
// missing, no place has coordinates, or nothing is within range).
export function nearestWorkingPlace(
  lat: number | null | undefined,
  lng: number | null | undefined,
  places: PlaceWithCoords[],
  maxMeters = 1000,
): { id: string; name: string; distance: number } | null {
  if (lat == null || lng == null) return null;
  let best: { id: string; name: string; distance: number } | null = null;
  for (const p of places) {
    if (p.latitude == null || p.longitude == null) continue;
    const d = distanceMeters(lat, lng, p.latitude, p.longitude);
    if (d <= maxMeters && (best === null || d < best.distance)) {
      best = { id: p.id, name: p.name, distance: Math.round(d) };
    }
  }
  return best;
}

// ─── Location-string parsers (admin entry of a place's GPS) ─────────────────────
export function isValidLatLng(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

// Extract {lat,lng} from a Google Maps URL (or a bare "lat,lng" string). Returns null
// for shortened links (goo.gl / maps.app.goo.gl) — those must be opened first and the
// full URL (or the coordinates) copied.
export function parseGoogleMapsLink(input: string): { lat: number; lng: number } | null {
  if (!input) return null;
  const s = input.trim();
  const N = '(-?\\d+(?:\\.\\d+)?)';
  const patterns = [
    new RegExp(`@${N},${N}`),
    new RegExp(`!3d${N}!4d${N}`),
    new RegExp(`[?&](?:q|query|ll|center|destination|sll|daddr)=${N}(?:,|%2C)${N}`, 'i'),
    new RegExp(`^${N},\\s*${N}$`),
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const lat = Number(m[1]), lng = Number(m[2]);
      if (isValidLatLng(lat, lng)) return { lat, lng };
    }
  }
  return null;
}

// Decode a FULL Open Location Code (Plus Code), e.g. "8FVC2222+22", to its centre.
// Short codes (separator not at index 8, e.g. "9G8F+6X Colombo") need a reference
// locality and aren't supported → null.
const OLC_ALPHABET = '23456789CFGHJMPQRVWX';
const OLC_PAIR_RES = [20, 1, 0.05, 0.0025, 0.000125];
export function decodePlusCode(input: string): { lat: number; lng: number } | null {
  if (!input) return null;
  const code = input.toUpperCase().replace(/\s+/g, '');
  if (code.indexOf('+') !== 8) return null;            // full codes only
  const clean = code.replace('+', '').replace(/0+$/, '');
  if (clean.length < 2) return null;
  for (const ch of clean) if (!OLC_ALPHABET.includes(ch)) return null;

  let lat = -90, lng = -180, latCell = 0, lngCell = 0;
  const pairs = Math.min(clean.length, 10);
  for (let i = 0; i < pairs; i += 2) {
    const res = OLC_PAIR_RES[i / 2];
    lat += OLC_ALPHABET.indexOf(clean[i]) * res;
    lng += OLC_ALPHABET.indexOf(clean[i + 1]) * res;
    latCell = res; lngCell = res;
  }
  // optional grid refinement (chars 11–15): 5 rows × 4 cols per level
  let lg = 0.000125, cg = 0.000125;
  for (let i = 10; i < Math.min(clean.length, 15); i++) {
    lg /= 5; cg /= 4;
    const v = OLC_ALPHABET.indexOf(clean[i]);
    lat += Math.floor(v / 4) * lg;
    lng += (v % 4) * cg;
    latCell = lg; lngCell = cg;
  }
  const out = { lat: lat + latCell / 2, lng: lng + lngCell / 2 };
  return isValidLatLng(out.lat, out.lng) ? out : null;
}

// Encode coordinates to a 10-digit (pair-precision) Plus Code — used to recover the
// missing prefix of a short code.
export function encodePlusCode(lat: number, lng: number): string {
  lat = Math.min(Math.max(lat, -90), 90);
  lng = ((lng % 360) + 540) % 360 - 180;
  if (lat >= 90) lat = 90 - 1e-9;
  let latR = lat + 90, lngR = lng + 180, pairs = '';
  for (let k = 0; k < 5; k++) {
    const res = OLC_PAIR_RES[k];
    const ld = Math.min(Math.floor(latR / res), 19); latR -= ld * res;
    const gd = Math.min(Math.floor(lngR / res), 19); lngR -= gd * res;
    pairs += OLC_ALPHABET[ld] + OLC_ALPHABET[gd];
  }
  return pairs.slice(0, 8) + '+' + pairs.slice(8);
}

// True when `input` is a short Plus Code (separator before index 8, e.g. "V275+PR").
export function isShortPlusCode(input: string): boolean {
  const c = input.toUpperCase().replace(/\s+/g, '');
  const i = c.indexOf('+');
  return i >= 0 && i < 8;
}

// Split "V275+PR Homagama" → { code: "V275+PR", locality: "Homagama" }.
export function splitPlusCode(input: string): { code: string; locality: string } {
  const parts = input.trim().split(/\s+/);
  const code = parts.find(p => p.includes('+')) ?? parts[0] ?? '';
  const locality = parts.filter(p => p !== code).join(' ').trim();
  return { code, locality };
}

// Recover a short Plus Code to coordinates using a nearby reference location.
export function recoverPlusCode(short: string, refLat: number, refLng: number): { lat: number; lng: number } | null {
  const s = short.toUpperCase().replace(/\s+/g, '');
  const sep = s.indexOf('+');
  if (sep === 8) return decodePlusCode(s);     // already full
  if (sep < 0 || sep >= 8) return null;
  const paddingLength = 8 - sep;               // 2, 4 or 6 chars were removed
  const resolution = Math.pow(20, 2 - paddingLength / 2);
  const halfRes = resolution / 2;
  const prefix = encodePlusCode(refLat, refLng).replace('+', '').substring(0, paddingLength);
  const c = decodePlusCode(prefix + s);
  if (!c) return null;
  let { lat, lng } = c;
  // Snap to the cell nearest the reference (recovery may land one cell off).
  if (refLat + halfRes < lat && lat - resolution >= -90) lat -= resolution;
  else if (refLat - halfRes > lat && lat + resolution <= 90) lat += resolution;
  if (refLng + halfRes < lng) lng -= resolution;
  else if (refLng - halfRes > lng) lng += resolution;
  return isValidLatLng(lat, lng) ? { lat, lng } : null;
}

// Reverse-geocode a coordinate to a human place name + full address via OpenStreetMap
// Nominatim (no API key). Used to auto-fill an outstation from the device GPS so the
// user only ticks "Outstation" — no manual typing.
export async function reverseGeocode(
  lat: number, lng: number,
): Promise<{ name: string; address: string } | null> {
  if (!isValidLatLng(lat, lng)) return null;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const address: string = data?.display_name ?? '';
    if (!address) return null;
    const a = data?.address ?? {};
    const name =
      data?.name ||
      a.amenity || a.building || a.shop || a.office || a.tourism ||
      a.road || a.neighbourhood || a.suburb || a.village || a.town || a.city ||
      address.split(',')[0];
    return { name: String(name).trim(), address };
  } catch { return null; }
}

// Free-text geocode via OpenStreetMap Nominatim (no API key needed). Top hit only.
export async function geocodePlace(query: string): Promise<{ lat: number; lng: number } | null> {
  if (!query.trim()) return null;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    const lat = Number(data[0].lat), lng = Number(data[0].lon);
    return isValidLatLng(lat, lng) ? { lat, lng } : null;
  } catch { return null; }
}
