'use client';

/**
 * A stable-ish label for THIS browser, from FingerprintJS.
 *
 * ── Read this before using the value for anything ───────────────────────────────────────
 * FingerprintJS's open-source agent scores its own confidence, and on the platforms this
 * workforce actually uses the score is low. From `getOpenConfidenceScore` in
 * @fingerprintjs/fingerprintjs v5:
 *
 *     iOS + iPadOS (every browser)  0.3      macOS Chrome/Firefox   0.5
 *     macOS Safari 16.4+            0.3      Windows                0.6
 *     Android (Chrome, Samsung)     0.4      Linux / other          0.7
 *
 * iOS and iPadOS sit at the floor and cannot be improved: every browser on them is WebKit
 * underneath, so Chrome and Firefox there hit the same branch as Safari. 0.3 means a fleet of
 * identical company iPhones on the same iOS version will collide on one visitorId.
 *
 * So this is a LABEL and a HINT. It may say "we have seen this browser before" or "this looks
 * like a new device", and it may put a recognisable name next to a passkey. It must never gate
 * access, approve anything, or be the reason a check-in is rejected. Passkeys carry the
 * security here; this carries the wording.
 *
 * The agent is loaded lazily so it never lands in the login bundle, and every failure path
 * returns null rather than throwing — a fingerprint is a nicety, and nothing that depends on
 * it may block a sign-in.
 */

const STORAGE_KEY = 'device_visitor_id';

let cached: string | null = null;
let inFlight: Promise<string | null> | null = null;

/** The last id this browser computed, if it is still in localStorage. Synchronous. */
export function cachedVisitorId(): string | null {
  if (cached) return cached;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && /^[a-zA-Z0-9]{8,64}$/.test(v)) { cached = v; return v; }
  } catch { /* private mode, or site data blocked */ }
  return null;
}

/**
 * Compute (or recall) this browser's visitorId. Never throws; returns null when the agent
 * cannot run — a locked-down browser, a blocked CDN-free bundle, an SSR pass.
 *
 * The localStorage copy is a cache, not the source of truth: FingerprintJS derives the id
 * from browser signals, so it survives cleared storage and private mode. Caching it just
 * spares the ~100ms of entropy collection on every page that asks.
 */
export async function getVisitorId(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const known = cachedVisitorId();
  if (known) return known;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      // Dynamic import: keeps ~40KB of entropy-collection code out of the login bundle for
      // the many sessions that never need it.
      const FingerprintJS = (await import('@fingerprintjs/fingerprintjs')).default;
      const agent = await FingerprintJS.load();
      const { visitorId } = await agent.get();
      if (!visitorId) return null;
      cached = visitorId;
      try { localStorage.setItem(STORAGE_KEY, visitorId); } catch { /* nothing to do */ }
      return visitorId;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * A device name from what the browser will tell us directly, for the passkey list.
 *
 * Better than the server's user-agent guess in one specific case that matters here: iPadOS 13+
 * sends a Macintosh user agent, so an iPad is indistinguishable from a Mac server-side.
 * `maxTouchPoints` settles it, and only the client can see it.
 */
export function localDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'This device';
  const ua = navigator.userAgent || '';
  const touch = typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0;
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh|Mac OS/i.test(ua)) return touch > 1 ? 'iPad' : 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/CrOS/i.test(ua)) return 'Chromebook';
  if (/Linux/i.test(ua)) return 'Linux PC';
  return 'This device';
}
