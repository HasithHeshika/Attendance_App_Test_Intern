import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compare a caller-supplied secret against the expected one without leaking, through how
 * long the comparison takes, how many leading characters matched.
 *
 * `===` on strings short-circuits at the first differing byte. That is measurable across
 * enough requests, and every shared-secret surface in this app (CRON_SECRET,
 * WORKFORCE_API_KEY, the fingerprint terminals' device keys) is remotely reachable and
 * unthrottled, which is exactly the setting where it becomes worth doing.
 *
 * Both sides are hashed to a fixed 32 bytes first. timingSafeEqual throws on a length
 * mismatch, and comparing the raw strings would leak the expected secret's LENGTH through
 * that throw; hashing makes every comparison the same size whatever the inputs.
 *
 * Returns false for an empty or absent expected secret, so an unconfigured deployment fails
 * closed instead of accepting everything.
 */
export function secretEquals(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!expected || !provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
