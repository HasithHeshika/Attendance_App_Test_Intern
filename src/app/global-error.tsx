'use client';
// Root error boundary (renders when the layout/page tree throws). The most common
// real-world crash on phones is version skew: after a release the old build's hashed
// chunks are gone, so a lazy import throws mid-render. Detect that case and self-heal
// (purge caches + one reload into the new build) instead of stranding the user; the
// sessionStorage throttle matches the inline recovery script in layout.tsx so the two
// never combine into a reload loop.
import { useEffect, useState } from 'react';

const CHUNK_RE = /ChunkLoadError|Loading chunk|Loading CSS chunk|dynamically imported module|Importing a module script failed/i;
const KEY = 'app-chunk-recover-at';

export default function GlobalError({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    const isChunk = CHUNK_RE.test(`${error?.name ?? ''} ${error?.message ?? ''}`);
    if (!isChunk || !navigator.onLine) return;
    let last = 0;
    try { last = Number(sessionStorage.getItem(KEY)) || 0; } catch { /* private mode */ }
    if (Date.now() - last < 60_000) return;
    try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* private mode */ }
    setRecovering(true);
    const reload = () => window.location.reload();
    if (window.caches) {
      caches.keys()
        .then(ks => Promise.all(ks.map(k => caches.delete(k))))
        .then(reload, reload);
    } else {
      reload();
    }
  }, [error]);

  // global-error replaces the root layout, so it must render its own <html>/<body>;
  // globals.css may not have loaded — inline styles only.
  return (
    <html lang="en">
      <body style={{
        margin: 0, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#0b1220', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif', textAlign: 'center', padding: 24,
      }}>
        <div>
          {recovering ? (
            <>
              <h1 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 8px' }}>Updating the app…</h1>
              <p style={{ fontSize: 14, color: '#94a3b8', margin: 0 }}>
                A new version was released. Reloading with the latest files.
              </p>
            </>
          ) : (
            <>
              <h1 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 8px' }}>Something went wrong</h1>
              <p style={{ fontSize: 14, color: '#94a3b8', margin: '0 0 16px' }}>
                Please try again — if it keeps happening, reload the app.
              </p>
              <button
                onClick={() => reset()}
                style={{
                  padding: '8px 20px', borderRadius: 8, border: '1px solid #334155',
                  background: 'transparent', color: '#e2e8f0', fontSize: 14, cursor: 'pointer', marginRight: 8,
                }}
              >
                Try again
              </button>
              <button
                onClick={() => window.location.reload()}
                style={{
                  padding: '8px 20px', borderRadius: 8, border: 0,
                  background: '#0C8ECA', color: '#fff', fontSize: 14, cursor: 'pointer',
                }}
              >
                Reload
              </button>
            </>
          )}
        </div>
      </body>
    </html>
  );
}
