'use client';
import { useCallback, useEffect, useRef } from 'react';
import { GoogleAuthProvider, signInWithCredential, type UserCredential } from 'firebase/auth';
import { auth } from '@/lib/firebase';

// ── Google One Tap (Google Identity Services) → Firebase ──────────────────────
// Shows Google's One Tap box (auto on mount, and on demand from the "Continue with
// Google" button). The box returns a Google ID token which we exchange for a
// Firebase credential via signInWithCredential — the same identity a popup sign-in
// would produce, so the downstream profile gate (getUserByEmail + finaliseLogin)
// is unchanged.
//
// FedCM is enabled: on modern Chrome the third-party cookies the legacy One Tap
// relied on are deprecated, so the box only renders through the browser's FedCM
// API. The popup sign-in remains available as a fallback for when One Tap can't
// display at all (no Google session, cooldown, unsupported browser).

const GSI_SRC = 'https://accounts.google.com/gsi/client';

// Minimal typings for the slice of GIS we use (the library ships no types here).
interface CredentialResponse { credential?: string }
interface IdConfig {
  client_id: string;
  callback: (res: CredentialResponse) => void;
  auto_select?: boolean;
  cancel_on_tap_outside?: boolean;
  use_fedcm_for_prompt?: boolean;
  context?: 'signin' | 'signup' | 'use';
}
interface GoogleId {
  initialize: (cfg: IdConfig) => void;
  prompt: (cb?: (notification: any) => void) => void;
  cancel: () => void;
  disableAutoSelect: () => void;
}
declare global {
  interface Window { google?: { accounts?: { id?: GoogleId } } }
}

// Load the GIS client script once per document, shared across mounts.
let gsiPromise: Promise<void> | null = null;
function loadGsi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gsiPromise) return gsiPromise;
  gsiPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('GSI failed to load')));
      if (window.google?.accounts?.id) resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = GSI_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => { gsiPromise = null; reject(new Error('GSI failed to load')); };
    document.head.appendChild(s);
  });
  return gsiPromise;
}

const isValidClientId = (cid?: string): cid is string =>
  !!cid && cid.endsWith('.apps.googleusercontent.com');

// Best-effort log of why the box did/didn't show. Under FedCM these status methods
// are unsupported and throw, so it's all guarded. Returns true if we could tell the
// box was NOT shown (so a caller can fall back), false/undefined otherwise.
function logMoment(notification: any): boolean {
  try {
    console.log(`[Google One Tap] Prompt moment: ${notification.getMomentType?.()}`);
    if (notification.isNotDisplayed?.()) {
      console.warn(`[Google One Tap] NOT DISPLAYED — reason: ${notification.getNotDisplayedReason?.()}`);
      return true;
    }
    if (notification.isSkippedMoment?.()) {
      console.warn(`[Google One Tap] SKIPPED — reason: ${notification.getSkippedReason?.()}`);
      return true;
    }
    if (notification.isDismissedMoment?.()) {
      console.info(`[Google One Tap] DISMISSED — reason: ${notification.getDismissedReason?.()}`);
    }
  } catch {
    // FedCM: detailed status unavailable — we can't tell, so don't claim it failed.
    console.log('[Google One Tap] prompt fired (FedCM mode: detailed status unavailable)');
  }
  return false;
}

interface Params {
  clientId?: string;
  /** Skip the auto-prompt on mount (already authenticated, a sign-in in flight, a modal open, …). */
  disabled?: boolean;
  /** Auto-show the box on mount. Default true. The returned `promptOneTap` works regardless. */
  autoPrompt?: boolean;
  /** Called after a successful Firebase sign-in with the resulting credential. */
  onSignIn: (cred: UserCredential) => void | Promise<void>;
  /** Called when exchanging the Google token for a Firebase session fails. */
  onError?: (err: unknown) => void;
}

export function useGoogleOneTap({ clientId, disabled, autoPrompt = true, onSignIn, onError }: Params) {
  // Keep the latest callbacks/clientId in refs so the once-registered GIS callback
  // never fires against stale closures (t, router, state setters change each render).
  const onSignInRef = useRef(onSignIn);
  const onErrorRef = useRef(onError);
  const clientIdRef = useRef(clientId);
  onSignInRef.current = onSignIn;
  onErrorRef.current = onError;
  clientIdRef.current = clientId;

  const initedRef = useRef(false);
  // True only between calling id.prompt() and its notification callback firing — the window
  // during which a REAL FedCM navigator.credentials.get() may be genuinely in flight. Gates
  // every `.cancel()` call so we don't invoke it (and have GIS log an AbortError to the
  // console) when nothing is actually pending.
  const promptActiveRef = useRef(false);
  // Bumped every time a NEW prompt attempt starts — from the auto-mount effect or the manual
  // button — so an older attempt still awaiting ensureInit() can tell it's been superseded and
  // quietly drop out instead of also reaching id.prompt(). Without this, two attempts racing
  // (e.g. StrictMode's dev-only double effect-invocation, or a click landing while auto-mount
  // is still loading the GIS script) can BOTH call id.prompt() — and GIS reacts to a second
  // prompt() by aborting the first FedCM get() itself, which is exactly the
  // "[GSI_LOGGER]: FedCM get() rejects with AbortError" console error. cancelIfActive() both
  // claims a fresh token (invalidating any older attempt) and dismisses an already-VISIBLE
  // prompt, so at most one id.prompt() is ever outstanding.
  const seqRef = useRef(0);
  const cancelIfActive = () => {
    seqRef.current += 1;
    if (promptActiveRef.current) window.google?.accounts?.id?.cancel();
    promptActiveRef.current = false;
  };

  // Load GIS + initialize the One Tap client once. Resolves to the shared `id`
  // object (or null when there's no real client ID / the script failed to load).
  const ensureInit = useCallback(async (): Promise<GoogleId | null> => {
    const cid = clientIdRef.current;
    // A missing / placeholder client ID would make GIS log "client ID is not found".
    if (!isValidClientId(cid)) return null;
    await loadGsi();
    const id = window.google?.accounts?.id;
    if (!id) return null;
    if (!initedRef.current) {
      id.initialize({
        client_id: cid,
        // FedCM ON — required for the box to render on modern Chrome (legacy One Tap
        // depended on now-deprecated third-party cookies). Trade-off: the prompt-moment
        // status methods don't work under FedCM (handled in logMoment).
        use_fedcm_for_prompt: true,
        // Require an explicit tap — never silently sign a returning user back in.
        auto_select: false,
        cancel_on_tap_outside: true,
        context: 'signin',
        callback: async (res) => {
          const idToken = res.credential;
          if (!idToken) return;
          try {
            const credential = GoogleAuthProvider.credential(idToken);
            const userCred = await signInWithCredential(auth, credential);
            await onSignInRef.current(userCred);
          } catch (e) {
            onErrorRef.current?.(e);
          }
        },
      });
      initedRef.current = true;
    }
    return id;
  }, []);

  // Manually show the One Tap box — for the "Continue with Google" button. If it
  // can't display (no client ID, script blocked, or a detectable non-display), the
  // `onUnavailable` callback fires so the caller can fall back to a popup sign-in.
  const promptOneTap = useCallback((onUnavailable?: () => void) => {
    cancelIfActive();               // supersede whatever attempt (if any) is already underway
    const mySeq = seqRef.current;
    ensureInit()
      .then((id) => {
        if (seqRef.current !== mySeq) return;   // a newer attempt has since taken over
        if (!id) { onUnavailable?.(); return; }
        promptActiveRef.current = true;
        id.prompt((notification) => {
          if (seqRef.current !== mySeq) return; // superseded while the box was showing
          promptActiveRef.current = false;   // the FedCM get() has settled — nothing left to cancel
          if (logMoment(notification)) onUnavailable?.();
        });
      })
      .catch(() => { if (seqRef.current === mySeq) onUnavailable?.(); });
  }, [ensureInit]);

  // Auto-show the box on mount (unless disabled). Same init + credential path.
  useEffect(() => {
    if (!isValidClientId(clientId) || disabled || !autoPrompt) {
      // Dismiss any showing prompt when we become disabled (e.g. sign-in started) — but only
      // if one is actually outstanding, so this never fires a spurious GIS abort log.
      cancelIfActive();
      return;
    }
    cancelIfActive();               // supersede whatever attempt (if any) is already underway
    const mySeq = seqRef.current;
    ensureInit()
      .then((id) => {
        if (seqRef.current !== mySeq || !id) return;
        promptActiveRef.current = true;
        id.prompt((notification) => {
          if (seqRef.current !== mySeq) return;
          promptActiveRef.current = false;
          logMoment(notification);
        });
      })
      .catch((e) => { if (seqRef.current === mySeq) onErrorRef.current?.(e); });

    return () => { cancelIfActive(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, disabled, autoPrompt, ensureInit]);

  return { promptOneTap };
}
