import type { Firestore } from 'firebase-admin/firestore';

// Firestore-backed IP rate limiter, shared by every public/unauthenticated route (no
// idToken or shared secret to gate on — currently /api/register and /api/resolve-login).
// Stored in Firestore rather than in-memory because serverless function instances don't
// share process memory — an in-memory counter would reset on every cold start and
// throttle nothing.

export function clientIp(req: { headers: { get(name: string): string | null } }): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'unknown';
}

/**
 * Returns the number of ms until the caller may retry, or 0 if this request is allowed.
 * `bucket` namespaces the counter per-route (e.g. 'register', 'resolve_login') so
 * different endpoints don't share the same throttle.
 */
export async function checkRateLimit(
  db: Firestore,
  bucket: string,
  ip: string,
  windowMs: number,
  max: number,
): Promise<number> {
  const safeIp = ip.replace(/[^a-zA-Z0-9.:_-]/g, '_');
  const ref = db.collection('rate_limits').doc(`${bucket}_${safeIp}`);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? (snap.data() as { count: number; windowStart: number }) : null;
    if (!data || now - data.windowStart > windowMs) {
      tx.set(ref, { count: 1, windowStart: now });
      return 0;
    }
    if (data.count >= max) {
      return windowMs - (now - data.windowStart);
    }
    tx.update(ref, { count: data.count + 1 });
    return 0;
  });
}
