'use client';
import {
  browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import { getVisitorId, localDeviceLabel } from '@/lib/deviceFingerprint';

/**
 * Browser half of passkey sign-in. Talks to /api/auth/passkey/* and to the platform
 * authenticator; holds no policy of its own.
 *
 * Every server call is a POST under /api/auth/, and that path is load-bearing rather than
 * tidy: serwist's defaultCache serves same-origin GETs under /api/ from a 24-hour
 * NetworkFirst cache, and treats /api/auth/* as NetworkOnly. A cached challenge is a replay
 * window, and a cached device list is how someone comes to believe a passkey they deleted is
 * still there.
 */

/** A passkey as the profile page shows it. Mirrors CredentialSummary in src/lib/webauthn.ts. */
export interface PasskeySummary {
  id: string;
  label: string;
  rp_id: string;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
}

/** Does this browser do WebAuthn at all? False on old browsers and in insecure contexts. */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && browserSupportsWebAuthn();
}

/**
 * Can this browser fill a passkey from the username field itself (conditional mediation)?
 * Where it can, the person often never presses the button — the browser offers the passkey as
 * they focus the field. Where it cannot, the button is the whole affordance, which is why the
 * button is always rendered and this only decides whether to ALSO arm autofill.
 */
export async function passkeyAutofillAvailable(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  try { return await browserSupportsWebAuthnAutofill(); } catch { return false; }
}

/** Carries the server's error code so callers can map it to a translated message. */
export class PasskeyError extends Error {
  readonly status: number;
  constructor(code: string, status = 0) {
    super(code);
    this.name = 'PasskeyError';
    this.status = status;
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new PasskeyError(String(data?.error ?? `HTTP ${res.status}`), res.status);
  return data as T;
}

/**
 * Enrol a passkey for the signed-in caller. `idToken` proves who that is; the server never
 * accepts a uid from the client.
 *
 * The visitorId is best-effort — a device label is worth less than a working passkey, so a
 * fingerprint that cannot be computed becomes null rather than an error.
 */
export async function enrolPasskey(idToken: string, label?: string): Promise<PasskeySummary> {
  if (!passkeysSupported()) throw new PasskeyError('Unsupported');

  const { options, handle } = await postJson<{
    options: Parameters<typeof startRegistration>[0]['optionsJSON'];
    handle: string;
  }>('/api/auth/passkey/register/options', { idToken });

  // Anything the authenticator throws — a cancelled prompt, a key already registered, no
  // biometric enrolled — surfaces as one code the UI can translate. The browser's own
  // messages are not something to show a warehouse supervisor in English.
  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'InvalidStateError') throw new PasskeyError('AlreadyRegistered');
    if (name === 'NotAllowedError') throw new PasskeyError('Cancelled');
    throw new PasskeyError('AuthenticatorFailed');
  }

  const visitorId = await getVisitorId().catch(() => null);
  const { credential } = await postJson<{ credential: PasskeySummary }>(
    '/api/auth/passkey/register/verify',
    { idToken, handle, response, label: label ?? localDeviceLabel(), visitorId },
  );
  return credential;
}

/**
 * Sign in with a passkey. Returns a Firebase custom token for `signInWithCustomToken`.
 *
 * No identifier is sent. The passkeys are discoverable, so the device shows the person their
 * own accounts and the server learns who they are from the assertion — which also means this
 * flow cannot be used to ask "does this employee have an account here?".
 *
 * `useAutofill` drives conditional mediation: with it, the prompt is the browser's own
 * suggestion on the username field rather than a modal.
 */
export async function passkeySignInToken(useAutofill = false): Promise<string> {
  if (!passkeysSupported()) throw new PasskeyError('Unsupported');

  const { options, handle } = await postJson<{
    options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
    handle: string;
  }>('/api/auth/passkey/login/options', {});

  let response;
  try {
    response = await startAuthentication({ optionsJSON: options, useBrowserAutofill: useAutofill });
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'NotAllowedError' || name === 'AbortError') throw new PasskeyError('Cancelled');
    throw new PasskeyError('AuthenticatorFailed');
  }

  const { token } = await postJson<{ token: string }>(
    '/api/auth/passkey/login/verify', { handle, response },
  );
  return token;
}

/** The caller's own passkeys. Labels and dates only — the server never returns key material. */
export async function listPasskeys(idToken: string): Promise<PasskeySummary[]> {
  const { credentials } = await postJson<{ credentials: PasskeySummary[] }>(
    '/api/auth/passkey/list', { idToken },
  );
  return credentials;
}

/** Remove one of the caller's own passkeys. The server refuses anyone else's. */
export async function deletePasskey(idToken: string, credentialId: string): Promise<void> {
  await postJson('/api/auth/passkey/delete', { idToken, credentialId });
}
