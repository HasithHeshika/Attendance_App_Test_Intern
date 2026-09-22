/**
 * Which way this browser signed in last, so the login screen can lead with it.
 *
 * Stored per browser, never on the server — it is a convenience, not a claim about anyone. It
 * grants nothing: whatever is remembered here, the person still has to satisfy the actual
 * method, and an unavailable method is dropped rather than offered (see `availableMethod`).
 *
 * ── What is stored, and the shared-device problem ────────────────────────────────────────
 * Site offices share tablets. Remembering an address means the next person to pick one up sees
 * a trace of the last. That is why the address is only ever rendered MASKED, and why the login
 * screen must always offer a way to clear this — `forgetLastSignIn()` exists for that and the
 * UI is expected to call it. Both halves matter: masking without an escape hatch just strands
 * the next person inside somebody else's identity.
 *
 * Kept separate from the existing `remember_me` key, which stores the full address to prefill
 * the email field and is untouched by any of this.
 */

export type SignInMethod = 'password' | 'passkey' | 'google' | 'microsoft';

const STORAGE_KEY = 'last_sign_in';
const METHODS: readonly SignInMethod[] = ['password', 'passkey', 'google', 'microsoft'];

export interface LastSignIn {
  method: SignInMethod;
  /** Full address as stored; render it through `maskEmail` and never raw. */
  email: string | null;
}

/**
 * Hide the middle of an address while leaving enough to recognise your own account.
 *
 * Pure, so it is unit-tested. The dot run is a FIXED length rather than the real one — a
 * variable run would leak how long the address is, which is a surprising amount of signal when
 * you are staring at a colleague's tablet trying to work out whose account it is.
 */
export function maskEmail(email: string | null | undefined): string {
  const raw = (email ?? '').trim();
  const at = raw.lastIndexOf('@');
  if (at < 1 || at === raw.length - 1) return '';
  const local = raw.slice(0, at);
  const domain = raw.slice(at);
  const dots = '•'.repeat(5);
  // One character is not a recognisable hint and two out of two is no mask at all, so short
  // local parts show only their first character.
  if (local.length <= 3) return `${local[0]}${dots}${domain}`;
  return `${local[0]}${dots}${local[local.length - 1]}${domain}`;
}

/**
 * Mask whatever this tenant uses as an identifier — an address OR an employee number.
 *
 * carecode.org staff sign in with either (see resolveIdentifierEmail in the login page), so a
 * mask that only understands addresses renders EMPTY for exactly the tenant where password is
 * the only way in. Same fixed-length dot run, same reason.
 */
export function maskIdentifier(identifier: string | null | undefined): string {
  const raw = (identifier ?? '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return maskEmail(raw);
  const dots = '•'.repeat(5);
  // An employee number is recognised by its tail ("...23"), not its head — the prefix is
  // usually shared across the whole company and identifies nobody.
  if (raw.length <= 3) return dots;
  return `${dots}${raw.slice(-2)}`;
}

/**
 * Should the email/password form start collapsed behind "Use password instead"?
 *
 * Only when something else is genuinely leading. If the resolved primary is password — or
 * nothing at all — the form IS the screen, and hiding it behind a tap would put the only
 * available route to sign in one interaction further away. That is not a preference: on a
 * tenant with OAuth hidden and passkeys off, password is the sole path.
 */
export function shouldCollapsePasswordForm(primary: SignInMethod | null): boolean {
  return primary !== null && primary !== 'password';
}

/** What this browser last used, or null if nothing usable is stored. */
export function readLastSignIn(): LastSignIn | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { method?: unknown; email?: unknown };
    // An unknown method means the value predates a rename or was hand-edited. Treat it as
    // absent rather than guessing — a wrong guess renders the wrong primary button.
    if (!METHODS.includes(parsed.method as SignInMethod)) return null;
    return {
      method: parsed.method as SignInMethod,
      email: typeof parsed.email === 'string' && parsed.email ? parsed.email : null,
    };
  } catch {
    // Private mode, blocked site data, or corrupt JSON. No memory is a fine outcome.
    return null;
  }
}

/** Record a SUCCESSFUL sign-in. Never call this on a failed or cancelled attempt. */
export function rememberLastSignIn(method: SignInMethod, email?: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ method, email: email ?? null }));
  } catch { /* storage unavailable — the screen simply won't lead with anything next time */ }
}

/** Forget it. Backs the "Not you?" control, which a shared device needs to have. */
export function forgetLastSignIn(): void {
  if (typeof window === 'undefined') return;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* nothing to do */ }
}

/**
 * The remembered method, but only if it can still actually be used.
 *
 * A tenant can turn passkeys or OAuth off, and a browser can lose WebAuthn support between
 * visits. Leading with a control that cannot work is worse than leading with nothing, so an
 * unavailable method resolves to null and the screen falls back to its default order.
 */
export function availableMethod(
  last: LastSignIn | null,
  opts: { passkeyOffered: boolean; oauthOffered: boolean },
): SignInMethod | null {
  if (!last) return null;
  if (last.method === 'passkey' && !opts.passkeyOffered) return null;
  if ((last.method === 'google' || last.method === 'microsoft') && !opts.oauthOffered) return null;
  return last.method;
}
