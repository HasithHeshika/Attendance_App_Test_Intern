// Tiny localStorage-backed "last-known" snapshot cache. Lets a screen paint real
// content instantly on a cold open (instead of a blocking skeleton) and then
// revalidate in the background. SSR-safe and best-effort — it must never throw
// into render, and must never wedge boot on corrupt/over-quota storage.
//
// For UI hints only (last-seen status, lists), never secrets/tokens. Bake a
// version into the key (e.g. `dash:v1:${id}`) so a shape change retires old data.

export function readSnapshot<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeSnapshot<T>(key: string, data: T): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* private mode / quota exceeded — losing the cache is fine, never block */
  }
}

export function clearSnapshot(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* noop */
  }
}
