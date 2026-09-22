/* eslint-disable @typescript-eslint/no-explicit-any */
// Loads the bundled Leaflet library once, on demand. Uses the local npm package
// (leaflet@1.9.4) instead of a CDN so the map still initializes when the browser is
// offline or unpkg.com is blocked/slow — otherwise the map area renders as a blank box.
// The dynamic import keeps Leaflet out of the initial bundle (its only callers are
// dynamically-imported, client-only map components). Leaflet's CSS is imported by those
// components directly (`leaflet/dist/leaflet.css`).
let leafletPromise: Promise<any> | null = null;

export function loadLeaflet(): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if ((window as any).L) return Promise.resolve((window as any).L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = import('leaflet')
    .then((mod) => {
      const L = (mod as any).default ?? mod;
      (window as any).L = L; // cache globally for reuse + back-compat with existing callers
      return L;
    })
    .catch((err) => { leafletPromise = null; throw err; });
  return leafletPromise;
}
