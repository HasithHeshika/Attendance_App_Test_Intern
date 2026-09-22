'use client';
import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Eye, EyeOff, Mail, Hash, Lock, ArrowRight, AlertCircle, Send, ShieldCheck,
  Clock, CloudOff, CheckCircle2, KeyRound, History,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  signInWithCustomToken,
} from 'firebase/auth';
import { auth, tenant } from '@/lib/firebase';
import { isEmailLike } from '@/lib/phone';
import { cacheAvatar, liveOAuthPhotoForEmail } from '@/lib/avatarCache';
import { getUserByEmail, getUserByUid, getUserByEpf, createUser, updateUser, bootstrapAdminProfile, isBootstrapAdminEmail } from '@/services/userService';
import { notifySystemAdminLogin } from '@/services/notificationService';
import { getActiveRoles } from '@/services/roleService';
import { getCompanies } from '@/services/companyService';
import { DEFAULT_ROLES } from '@/lib/permissions';
import { useAuthStore } from '@/store/authStore';
import { useRolesStore } from '@/store/rolesStore';
import { useT } from '@/store/appStore';
import { useLanyardStore } from '@/store/lanyardStore';
import { firestoreToUser } from '@/components/AuthProvider';
import { useBrandName, splitBrandName } from '@/lib/brand';
import { useGoogleOneTap } from '@/components/useGoogleOneTap';
import {
  PasskeyError, passkeyAutofillAvailable, passkeySignInToken, passkeysSupported,
} from '@/lib/passkey';
import {
  availableMethod, forgetLastSignIn, maskIdentifier, readLastSignIn, rememberLastSignIn,
  shouldCollapsePasswordForm, type LastSignIn, type SignInMethod,
} from '@/lib/lastSignIn';
import { AuthBrandPanel, EASE } from '@/components/AuthBrandPanel';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import ThemeToggle from '@/components/ThemeToggle';

/** Google's mark. Hand-inlined rather than lucide — lucide carries no brand glyphs. */
function GoogleMark() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

/** Microsoft's mark, same reasoning as GoogleMark. */
function MicrosoftMark() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 23 23" aria-hidden>
      <path fill="#f25022" d="M1 1h10v10H1z"/>
      <path fill="#7fba00" d="M12 1h10v10H12z"/>
      <path fill="#00a4ef" d="M1 12h10v10H1z"/>
      <path fill="#ffb900" d="M12 12h10v10H12z"/>
    </svg>
  );
}

const IS_DEV = process.env.NODE_ENV === 'development';
const DEV_EMP_TYPES = ['Permanent', 'Trainee'] as const;
type DevRole = { name: string; is_employee?: boolean; sort_order?: number };

// Dev Quick Login order: System Admin and Admin pinned on top, then the rest by the
// app's canonical role hierarchy (most senior first). Driven by DEFAULT_ROLES so the
// order stays correct regardless of whatever sort_order the dev DB happens to store.
const DEV_CANON_ORDER: string[] = [...DEFAULT_ROLES]
  .sort((a, b) => (b.sort_order ?? 0) - (a.sort_order ?? 0))
  .map(r => r.name);
const devRoleRank = (name: string): number => {
  if (name === 'System Admin') return -2;
  if (name === 'Admin') return -1;
  const i = DEV_CANON_ORDER.indexOf(name);
  return i >= 0 ? i : DEV_CANON_ORDER.length; // unknown custom roles fall to the end
};

// southernlanka only — resolves a typed identifier (email OR employee number) to the
// account's real email via /api/resolve-login. Firebase Auth only ever signs in with
// email+password, and Firestore can't be queried client-side before a session exists (see
// that route's comment), so an employee-number identifier has to be resolved server-side
// first. Every other tenant, and anything that already looks like an email, skips the
// round-trip.
async function resolveIdentifierEmail(identifier: string): Promise<{ email: string | null; error?: string }> {
  const trimmed = identifier.trim();
  if (tenant.id !== 'southernlanka' || !trimmed || isEmailLike(trimmed)) {
    return { email: trimmed || null };
  }
  try {
    const res = await fetch('/api/resolve-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: trimmed }),
    });
    const data = await res.json().catch(() => ({}) as { email?: string | null; error?: string });
    if (!res.ok) return { email: null, error: data?.error };
    return { email: data?.email ?? null };
  } catch {
    return { email: null };
  }
}

export default function LoginPage() {
  const router = useRouter();
  const t = useT();
  const brand = useBrandName();
  const [brandHead, brandTail] = splitBrandName(brand);
  const { setAuth, isAuthenticated, user } = useAuthStore();
  // Benefit-led value props shown on the brand panel — self-explaining, not feature-listy.
  const HIGHLIGHTS = [
    { icon: Clock,        title: t.hlOneTitle,   desc: t.hlOneDesc },
    { icon: CloudOff,     title: t.hlTwoTitle,   desc: t.hlTwoDesc },
    { icon: CheckCircle2, title: t.hlThreeTitle, desc: t.hlThreeDesc },
  ];
  const [email,       setEmail]       = useState('');
  const [password,    setPassword]    = useState('');
  const [showPw,      setShowPw]      = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [microsoftLoading, setMicrosoftLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  // Whether to OFFER passkeys at all. The tenant flag says the organisation has them; this
  // says the browser in front of us can actually do one. Both must hold — a button that
  // opens a prompt the device cannot answer is worse than no button.
  const [passkeyOffered, setPasskeyOffered] = useState(false);
  // What this browser signed in with last. Read once on mount; null until then, so the first
  // paint is the ordinary screen rather than a flash of somebody's account chip.
  const [lastSignIn, setLastSignIn] = useState<LastSignIn | null>(null);
  // Set true by "Use password instead", and by "Not you?" — after which the form is the screen.
  const [formOpen, setFormOpen] = useState(false);
  // finaliseLogin is shared by all four routes in, so each one records how it got there.
  const methodRef = useRef<SignInMethod>('password');
  const identifierRef = useRef<string | null>(null);
  const [error,       setError]       = useState('');
  const [rememberMe,  setRememberMe]  = useState(false);
  const [showReset,   setShowReset]   = useState(false);
  const [resetSent,   setResetSent]   = useState(false);

  useEffect(() => {
    if (isAuthenticated && user) {
      router.replace('/dashboard');
    }
  }, [isAuthenticated, user, router]);

  useEffect(() => { setLastSignIn(readLastSignIn()); }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('remember_me');
      if (saved) {
        const { email: savedEmail, remember } = JSON.parse(saved);
        if (remember) { setEmail(savedEmail ?? ''); setRememberMe(true); }
      }
    } catch { }
  }, []);

  function getFirebaseErrorMessage(code: string): string {
    switch (code) {
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
      case 'auth/user-not-found':
        return t.errIncorrectCreds;
      case 'auth/too-many-requests':
        return t.errTooMany;
      case 'auth/invalid-email':
        return t.errInvalidEmail;
      case 'auth/user-disabled':
        return t.errAccountDisabled;
      default:
        return t.errSignInFailed;
    }
  }

  async function finaliseLogin(uid: string) {
    let profile = await getUserByUid(uid);
    // Break-glass: the bootstrap email is provisioned as System Admin if it has no record.
    if (!profile) profile = await bootstrapAdminProfile(uid, auth.currentUser?.email);
    const resigned = profile?.date_of_resign && profile.date_of_resign <= new Date().toISOString().slice(0, 10);
    if (!profile || profile.is_active === false || resigned) {
      throw new Error(t.errNotActive);
    }
    // Adopt the Google / Microsoft profile photo as the avatar when we don't have one
    // yet (best-effort persist; never overwrites a user-uploaded avatar). Always cache it
    // locally (by email) so the picture also shows on later password / JWT logins.
    // Adopt the OAuth photo ONLY when the signed-in Firebase identity matches this profile's
    // email — otherwise a shared browser / mismatched session would brand this user with
    // someone else's picture (cached + persisted).
    const oauthPhoto = liveOAuthPhotoForEmail(profile.email);
    cacheAvatar(profile.email ?? auth.currentUser?.email, oauthPhoto);
    if (oauthPhoto && !profile.avatar_url) {
      profile = { ...profile, avatar_url: oauthPhoto };
      updateUser(profile.epf_number, { avatar_url: oauthPhoto }).catch(() => { /* non-critical */ });
    }
    // Load the roles registry so capabilities can be resolved onto the user.
    await useRolesStore.getState().loadRoles();
    const roles = useRolesStore.getState().roles;
    const appUser = firestoreToUser(profile, roles);
    setAuth(appUser);
    toast.success(`${t.welcomeBackToast}, ${profile.display_name || profile.first_name}!`);
    // Privileged login alert — notifies every OTHER active System Admin (covers both the
    // 'Admin' and 'System Admin' role names). Fire-and-forget: never awaited, never blocks
    // the redirect below, and never throws (notifySystemAdminLogin swallows its own errors).
    if (appUser.capabilities?.is_system_admin) {
      void notifySystemAdminLogin({ epf_number: profile.epf_number, display_name: profile.display_name, role: profile.role });
    }
    // Non-employees (e.g. System Admin) don't get an ID lanyard.
    if (appUser.capabilities?.is_employee) useLanyardStore.getState().startLoginReveal();
    // Remember HOW, so the next visit can lead with it. Here rather than in each handler
    // because this is the one point every route reaches only on genuine success — past the
    // active/resigned gate above, so a refused account never becomes the remembered one.
    // The identifier is whatever the person would recognise: on carecode.org they type an
    // employee number, and echoing back an email they never use would not reassure anyone.
    rememberLastSignIn(methodRef.current, identifierRef.current ?? profile.email ?? null);
    router.push('/dashboard');
  }

  // ─── Dev quick-login (development only) ───────────────────────────────────────
  const [devRoles, setDevRoles] = useState<DevRole[]>([]);
  const [devBusy,  setDevBusy]  = useState<string | null>(null);
  const [showDev,  setShowDev]  = useState(false);

  useEffect(() => {
    if (!IS_DEV) return;
    getActiveRoles()
      .then(rs => setDevRoles(rs.length ? rs : (DEFAULT_ROLES as DevRole[])))
      .catch(() => setDevRoles(DEFAULT_ROLES as DevRole[]));
  }, []);

  // System Admin → Admin → rest senior-first (see devRoleRank).
  const sortedDevRoles = useMemo(
    () => [...devRoles].sort((a, b) =>
      devRoleRank(a.name) - devRoleRank(b.name) ||
      (b.sort_order ?? 0) - (a.sort_order ?? 0) ||
      a.name.localeCompare(b.name)),
    [devRoles],
  );

  // Sign in (creating it the first time) as a throwaway test account for a given
  // role + employee type. Never bundled in production (IS_DEV gates the UI).
  async function devLogin(roleName: string, empType: 'Permanent' | 'Trainee') {
    const tag = `${roleName}-${empType}`;
    setDevBusy(tag);
    setError('');
    try {
      const slug = roleName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const email = `dev.${slug}.${empType.toLowerCase()}@pearlcluster.dev`;
      const password = 'devtest1234';

      let uid: string;
      try {
        uid = (await signInWithEmailAndPassword(auth, email, password)).user.uid;
      } catch (e: unknown) {
        const code = (e as { code?: string })?.code ?? '';
        if (code === 'auth/user-not-found' || code === 'auth/invalid-credential') {
          uid = (await createUserWithEmailAndPassword(auth, email, password)).user.uid;
        } else { throw e; }
      }

      // Ensure a Firestore profile exists for the dev account. Check the EPF too —
      // it is the doc id and createUser now rejects duplicates, so a profile whose
      // email drifted would otherwise make dev login fail instead of reusing it.
      const devEpf = `DEV-${slug}-${empType}`.toUpperCase();
      if (!(await getUserByEmail(email)) && !(await getUserByEpf(devEpf))) {
        const company = (await getCompanies())[0];
        await createUser({
          uid, epf_number: devEpf, email,
          first_name: roleName, last_name: `(${empType})`,
          display_name: `${roleName} · ${empType}`, name_tokens: [],
          role: roleName, designation: `${roleName} (dev)`, department: 'Dev',
          company_id: company?.id ?? '', company_name: company?.name ?? '',
          employee_type: empType, supervisor_epf: null,
          phone_personal: '', phone_office: '', phone_emergency: '',
          address: '', nic: '', date_of_birth: null, date_of_join: null, date_of_resign: null,
          insurance: false, blood_type: '', b_card_status: false,
          avatar_url: null, fcm_token: null, is_active: true,
        });
      }
      await finaliseLogin(uid);
    } catch (e: unknown) {
      console.error('[devLogin]', e);
      setError((e as { message?: string })?.message ?? 'Dev login failed');
    } finally {
      setDevBusy(null);
    }
  }

  const handleLogin = async (e: React.FormEvent) => {
    methodRef.current = 'password';
    identifierRef.current = email.trim() || null;
    e.preventDefault();
    setError('');
    setShowReset(false);
    setLoading(true);

    try {
      if (rememberMe) {
        localStorage.setItem('remember_me', JSON.stringify({ email, remember: true }));
      } else {
        localStorage.removeItem('remember_me');
      }

      // southernlanka may type an employee number instead of an email — resolve it to the
      // account's real email first (see resolveIdentifierEmail above). No-op elsewhere.
      const { email: signInEmail, error: resolveError } = await resolveIdentifierEmail(email);
      if (resolveError) { setError(resolveError); return; }
      if (!signInEmail) { setError(t.errIncorrectCreds); return; }

      // Try sign in first
      try {
        const cred = await signInWithEmailAndPassword(auth, signInEmail, password);
        await finaliseLogin(cred.user.uid);
        return;
      } catch (signInErr: any) {
        const code = signInErr?.code ?? '';

        // Wrong password — show error + reset option
        if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
          setError(t.errIncorrectPw);
          setShowReset(true);
          return;
        }

        // Rate limited
        if (code === 'auth/too-many-requests') {
          setError(t.errTooManyReset);
          setShowReset(true);
          return;
        }

        // No account yet — create one (first login)
        if (code === 'auth/user-not-found' || code === 'auth/invalid-email') {
          try {
            const newCred = await createUserWithEmailAndPassword(auth, signInEmail, password);
            await finaliseLogin(newCred.user.uid);
            return;
          } catch (createErr: any) {
            const createCode = createErr?.code ?? '';
            if (createCode === 'auth/email-already-in-use') {
              // Account exists but wrong password
              setError(t.errIncorrectPw);
              setShowReset(true);
            } else {
              setError(getFirebaseErrorMessage(createCode));
            }
            return;
          }
        }

        setError(getFirebaseErrorMessage(code));
        if (code !== 'auth/invalid-email') setShowReset(true);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSendReset = async () => {
    if (!email) { setError(t.errEnterEmail); return; }
    try {
      const { email: resolved, error: resolveError } = await resolveIdentifierEmail(email);
      if (resolveError) { setError(resolveError); return; }
      if (!resolved) { setError(t.errNotRegistered); return; }
      await sendPasswordResetEmail(auth, resolved);
      setResetSent(true);
      setShowReset(false);
      toast.success(t.resetEmailSentToast);
    } catch {
      toast.error(t.resetEmailFailToast);
    }
  };

  // Shared Google gate: verify the signed-in Google identity maps to an active
  // Firestore profile (or the bootstrap admin), then finalise. Used by both the
  // popup button and the One Tap prompt so they behave identically. Returns true
  // when the user was let in.
  async function completeGoogleLogin(user: { uid: string; email: string | null }) {
    const googleEmail = user.email ?? '';
    const profile = await getUserByEmail(googleEmail);
    const gResigned = profile?.date_of_resign && profile.date_of_resign <= new Date().toISOString().slice(0, 10);
    // The bootstrap admin email is allowed in even without a record (it gets provisioned).
    if ((!profile && !isBootstrapAdminEmail(googleEmail)) || profile?.is_active === false || gResigned) {
      await auth.signOut();
      setError(t.errNotRegistered);
      return false;
    }
    await finaliseLogin(user.uid);
    return true;
  }

  // Google One Tap — auto-prompts on the login page AND powers the "Continue with
  // Google" button (see handleGoogleSignIn). On success it hands the Firebase
  // credential to the same gate the popup uses. Auto-prompt is suppressed while
  // another sign-in is in flight, the reset panel is open, we're already authed, or
  // social login is hidden for this tenant (southernlanka — see the button block below).
  const { promptOneTap } = useGoogleOneTap({
    clientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
    disabled: isAuthenticated || loading || googleLoading || microsoftLoading || showReset || tenant.id === 'southernlanka',
    onSignIn: async (cred) => {
      setGoogleLoading(true);
      setError('');
      try {
        await completeGoogleLogin(cred.user);
      } catch (err: any) {
        setError(err?.message || t.errGoogleFailed);
      } finally {
        setGoogleLoading(false);
      }
    },
    onError: (err: any) => {
      // One Tap not showing / being dismissed is normal — only surface real
      // credential-exchange failures, not the "prompt didn't display" noise.
      if (err?.code) setError(err?.message || t.errGoogleFailed);
    },
  });

  // Popup sign-in — used only as the fallback when the One Tap box can't display.
  const googlePopupSignIn = async () => {
    setGoogleLoading(true);
    setError('');
    try {
      const provider = new GoogleAuthProvider();
      const cred = await signInWithPopup(auth, provider);
      await completeGoogleLogin(cred.user);
    } catch (err: any) {
      if (err?.code === 'auth/popup-closed-by-user') return;
      setError(err?.message || t.errGoogleFailed);
    } finally {
      setGoogleLoading(false);
    }
  };

  // "Continue with Google" → show the One Tap box; only if it genuinely can't
  // display (no Google session, cooldown, unsupported browser) fall back to popup.
  const handleGoogleSignIn = () => {
    methodRef.current = 'google';
    identifierRef.current = null;
    setError('');
    promptOneTap(() => { googlePopupSignIn(); });
  };

  const handleMicrosoftSignIn = async () => {
    methodRef.current = 'microsoft';
    identifierRef.current = null;
    setMicrosoftLoading(true);
    setError('');
    try {
      // Microsoft (Azure AD / personal accounts) via Firebase OAuth provider.
      const provider = new OAuthProvider('microsoft.com');
      provider.setCustomParameters({ prompt: 'select_account' });
      const cred = await signInWithPopup(auth, provider);
      // Azure may surface the address on the user record or the provider profile.
      const msEmail = cred.user.email ?? cred.user.providerData?.[0]?.email ?? '';

      // Check if this Microsoft account exists in Firestore users.
      const profile = await getUserByEmail(msEmail);
      const mResigned = profile?.date_of_resign && profile.date_of_resign <= new Date().toISOString().slice(0, 10);
      // The bootstrap admin email is allowed in even without a record (it gets provisioned).
      if ((!profile && !isBootstrapAdminEmail(msEmail)) || profile?.is_active === false || mResigned) {
        await auth.signOut();
        setError(t.errNotRegistered);
        return;
      }

      await finaliseLogin(cred.user.uid);
    } catch (err: any) {
      if (err?.code === 'auth/popup-closed-by-user') return;
      setError(err?.message || t.errMicrosoftFailed);
    } finally {
      setMicrosoftLoading(false);
    }
  };

  /** Server error codes and PasskeyError names, mapped to something a person can act on. */
  function passkeyMessage(code: string): string {
    switch (code) {
      case 'Unsupported':        return t.passkeyUnsupported;
      case 'Cancelled':          return t.passkeyCancelled;
      case 'ChallengeExpired':   return t.passkeyExpired;
      case 'VerificationFailed': return t.passkeyNoMatch;
      case 'AccountInactive':    return t.errNotActive;
      case 'NotRegistered':      return t.errNotRegistered;
      default:                   return t.passkeyFailed;
    }
  }

  /**
   * Exchange a passkey assertion for a Firebase session.
   *
   * `signInWithCustomToken` is what makes this a real session rather than a parallel one:
   * from here AuthProvider's onAuthStateChanged mints the capability claims exactly as it
   * does after a password sign-in, and finaliseLogin applies the same active/resigned gate.
   * Nothing downstream can tell how the person got in, which is the point.
   */
  async function completePasskeySignIn(token: string) {
    const cred = await signInWithCustomToken(auth, token);
    await finaliseLogin(cred.user.uid);
  }

  const handlePasskeySignIn = async () => {
    methodRef.current = 'passkey';
    identifierRef.current = null;   // the device chose the account, not the form
    setError('');
    setPasskeyLoading(true);
    try {
      await completePasskeySignIn(await passkeySignInToken(false));
    } catch (err: any) {
      const code = err instanceof PasskeyError ? err.message : '';
      // A cancelled prompt is a decision, not a failure — say nothing and leave the form as
      // it was, the way dismissing the Google popup already behaves.
      if (code === 'Cancelled') return;
      setError(code ? passkeyMessage(code) : (err?.message || t.passkeyFailed));
    } finally {
      setPasskeyLoading(false);
    }
  };

  /**
   * Conditional UI: on browsers that support it, the passkey is offered inside the identifier
   * field's own autofill list, so the fastest path needs no button at all. The request stays
   * open until the person picks a passkey or the page goes away — hence the cancelled flag,
   * without which navigating away could still complete a sign-in on an unmounted page.
   *
   * Everything here is silent by design. This is an offer nobody asked for; if it cannot be
   * made, or is ignored, the button below is still the answer.
   */
  useEffect(() => {
    if (!tenant.features.passkeys || !passkeysSupported()) return;
    setPasskeyOffered(true);

    let cancelled = false;
    void (async () => {
      if (!(await passkeyAutofillAvailable()) || cancelled) return;
      methodRef.current = 'passkey';
      identifierRef.current = null;
      try {
        const token = await passkeySignInToken(true);
        if (!cancelled) await completePasskeySignIn(token);
      } catch { /* dismissed, aborted, or unsupported after all — the button remains */ }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Clear the remembered account and hand the screen to whoever is holding it now. */
  function handleNotYou() {
    forgetLastSignIn();
    setLastSignIn(null);
    setFormOpen(true);
    setEmail('');
    setPassword('');
    try { localStorage.removeItem('remember_me'); } catch { /* nothing to do */ }
  }

  const oauthOffered = tenant.id !== 'southernlanka';
  // Null unless the remembered method can still be used right now.
  const primaryMethod = availableMethod(lastSignIn, { passkeyOffered, oauthOffered });
  const collapsed = shouldCollapsePasswordForm(primaryMethod) && !formOpen;
  const maskedAccount = maskIdentifier(lastSignIn?.email);
  // Is there anything behind "More sign-in options" beyond the password form itself?
  const othersAvailable = oauthOffered || (passkeyOffered && primaryMethod !== 'passkey');

  const PRIMARY: Record<Exclude<SignInMethod, 'password'>, { label: string; icon: React.ReactNode; run: () => void; busy: boolean }> = {
    passkey:   { label: t.passkeySignIn,     icon: <KeyRound className="h-4 w-4" />, run: handlePasskeySignIn,   busy: passkeyLoading },
    google:    { label: t.continueGoogle,    icon: <GoogleMark />,                   run: handleGoogleSignIn,    busy: googleLoading },
    microsoft: { label: t.continueMicrosoft, icon: <MicrosoftMark />,                run: handleMicrosoftSignIn, busy: microsoftLoading },
  };
  const primary = PRIMARY[(primaryMethod ?? 'passkey') as Exclude<SignInMethod, 'password'>];

  return (
    <div className="h-[100dvh] overflow-hidden grid grid-cols-1 lg:grid-cols-2 bg-background">
      {/* ── Brand panel (desktop only) ── */}
      <AuthBrandPanel />

      {/* ── Form panel ── */}
      <main className="relative overflow-y-auto">
        {/* Subtle ambient glow on mobile/tablet where the brand panel is hidden */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden lg:hidden">
          <div className="absolute -right-32 -top-32 h-80 w-80 rounded-full bg-primary/10 blur-3xl" />
          <div className="absolute -bottom-32 -left-32 h-80 w-80 rounded-full bg-brand/10 blur-3xl" />
        </div>

        {/* min-h-full + items-center centers the form when it fits and scrolls when it
            doesn't — so the sign-in button is reachable on any screen height. */}
        <div className="flex min-h-full items-center justify-center p-4 py-8 sm:p-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="relative z-10 w-full max-w-md"
        >
          <div className="safe-top-spacer lg:hidden mb-4" />
          {/* Mobile brand mark */}
          <div className="mb-8 flex items-center justify-center gap-3 lg:hidden">
            <img src="/icon.png" alt="" className="h-9 w-9 rounded-lg object-contain" />
            <div className="text-center">
              <div className="text-xl font-bold tracking-tight text-foreground">
                <span data-brand="head" suppressHydrationWarning>{brandHead}</span>
                <span className="text-primary" data-brand="tail" suppressHydrationWarning>{brandTail}</span>
              </div>
              <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">{t.enterpriseSuite}</div>
            </div>
          </div>

          <div className="glass-strong rounded-2xl p-7 shadow-soft sm:p-8 relative">
            <div className="absolute right-4 top-4">
              <ThemeToggle className="w-8 h-8" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{t.loginWelcome}</h1>
            <p className="mt-1 mb-7 text-sm text-muted-foreground" data-brand="text" suppressHydrationWarning>{t.loginSubtitle.replace(/{app}/g, brand)}</p>

            {/* Temporary onboarding note — auto-hides after 2026-07-04 (3-day window). */}
            {Date.now() < new Date('2026-07-04T00:00:00').getTime() && (
              <div className="mb-6 flex items-start gap-2.5 rounded-xl border border-primary/20 bg-primary/10 p-3 text-xs font-medium text-primary">
                <Lock className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
                <span>{t.loginDefaultPwNote}</span>
              </div>
            )}

            {/* ── Resume slot ─────────────────────────────────────────────────────────
            The method this browser used last, promoted to the one filled control on the
            screen. `availableMethod` has already dropped anything that can no longer work —
            passkeys switched off, OAuth hidden on this tenant — so this never renders a button
            that opens a prompt nothing can answer.

            The account chip is masked (maskIdentifier handles carecode.org's employee numbers
            as well as addresses) and carries "Not you?", because a site tablet passes between
            people and the next one must be able to leave the last one's identity in one tap. */}
            {primaryMethod && primaryMethod !== 'password' && (
              <div className="mb-5 space-y-2.5">
                {maskedAccount && (
                  <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/40 px-3 py-2.5">
                    <p className="min-w-0 truncate text-sm">
                      {t.continueAsTpl.replace('{account}', maskedAccount)}
                    </p>
                    <button type="button" onClick={handleNotYou}
                      className="shrink-0 text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground">
                      {t.notYou}
                    </button>
                  </div>
                )}

                <Button type="button" size="lg" className="w-full"
                  onClick={primary.run} disabled={primary.busy}>
                  {primary.busy
                    ? <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground" />
                    : primary.icon}
                  {primary.label}
                </Button>

                {/* Text, not a colour: --brand, --primary and --success are all the same azure
                here, so hue cannot mark anything. The icon is decorative; the label announces. */}
                <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                  <History className="h-3.5 w-3.5" aria-hidden />
                  <span>{t.lastUsedAria}</span>
                </p>
              </div>
            )}

            {/* Collapsed only when something else genuinely leads — never when password is the
            only way in. See shouldCollapsePasswordForm. */}
            {collapsed ? (
              <div className="space-y-2.5">
                <Button type="button" variant="outline" size="lg" className="w-full"
                  onClick={() => setFormOpen(true)}>
                  <Lock className="h-4 w-4" />
                  {t.usePasswordInstead}
                </Button>
                {othersAvailable && (
                  <button type="button" onClick={() => setFormOpen(true)}
                    className="w-full text-center text-xs text-muted-foreground hover:text-foreground">
                    {t.moreSignInOptions}
                  </button>
                )}
              </div>
            ) : (
            <form onSubmit={handleLogin} className="space-y-5">
              {/* Email (southernlanka: email or employee number) */}
              <div className="space-y-1.5">
                <label htmlFor="login-email" className="text-xs font-medium text-muted-foreground">
                  {tenant.id === 'southernlanka' ? 'Email or employee number' : t.emailLabel}
                </label>
                <div className="relative">
                  {tenant.id === 'southernlanka' && email && !isEmailLike(email)
                    ? <Hash className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    : <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />}
                  <Input id="login-email" type={tenant.id === 'southernlanka' ? 'text' : 'email'}
                    value={email} onChange={e => setEmail(e.target.value)}
                    autoComplete={`${tenant.id === 'southernlanka' ? 'username' : 'email'}${passkeyOffered ? ' webauthn' : ''}`}
                    className="h-11 pl-9"
                    placeholder={tenant.id === 'southernlanka' ? 'name@company.com or EMP-00123' : t.emailPlaceholder}
                    required />
                </div>
              </div>

              {/* Password */}
              <div className="space-y-1.5">
                <label htmlFor="login-password" className="text-xs font-medium text-muted-foreground">{t.passwordLabel}</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input id="login-password" type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                    autoComplete="current-password" className="h-11 pl-9 pr-10" placeholder="••••••••" required />
                  <button type="button" onClick={() => setShowPw(!showPw)}
                    aria-label={showPw ? t.hidePassword : t.showPassword} aria-pressed={showPw}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground">
                    {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* Remember Me */}
              <label className="flex w-fit cursor-pointer select-none items-center gap-2.5">
                <Checkbox checked={rememberMe} onCheckedChange={(v) => setRememberMe(v === true)} />
                <span className="text-sm text-muted-foreground">{t.keepSignedIn}</span>
              </label>

              {/* Error + Reset option */}
              <AnimatePresence>
                {error && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }} className="space-y-2 overflow-hidden">
                    <div className="flex items-center gap-2 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
                      <AlertCircle className="h-4 w-4 flex-shrink-0" />
                      {error}
                    </div>
                    {showReset && (
                      <button type="button" onClick={handleSendReset}
                        className="flex w-full items-center justify-center gap-2 rounded-lg border border-warning/25 bg-warning/10 py-2.5 text-sm font-medium text-warning transition-colors hover:bg-warning/20">
                        <Send className="h-3.5 w-3.5" /> {t.sendResetEmail}
                      </button>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {resetSent && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="flex items-center gap-2 rounded-lg border border-success/25 bg-success/10 p-3 text-sm text-success">
                    <Send className="h-4 w-4 flex-shrink-0" />
                    {t.resetEmailInline}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Submit */}
              <Button type="submit" disabled={loading} size="lg" className="w-full">
                {loading
                  ? <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground" />
                  : <>{t.signIn} <ArrowRight className="h-4 w-4" /></>
                }
              </Button>

              {/* Passkey sign-in. Above the "or" divider on purpose: this is not a third-party
              alternative like Google or Microsoft, it is the same account by a faster door, so
              it belongs with the password rather than beneath a divider that reads "or use
              somebody else's identity". Outline rather than filled — the submit button is
              already the one filled control, and --brand, --primary and --success all resolve
              to the same azure here, so a second filled button would compete without
              distinguishing itself (see globals.css). The icon and the position carry it. */}
              {passkeyOffered && primaryMethod !== 'passkey' && (
                <Button type="button" variant="outline" size="lg" onClick={handlePasskeySignIn}
                  disabled={passkeyLoading} className="w-full">
                  {passkeyLoading
                    ? <div className="h-4 w-4 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground" />
                    : <KeyRound className="h-4 w-4" />
                  }
                  {passkeyLoading ? t.passkeyAdding : t.passkeySignIn}
                </Button>
              )}

              {/* Self-registration — carecode.org ("southernlanka" tenant) only. */}
              {tenant.id === 'southernlanka' && (
                <button type="button" onClick={() => router.push('/register')}
                  className="w-full text-center text-xs text-muted-foreground hover:text-foreground">
                  New here? Create an account
                </button>
              )}

              {/* Social sign-in — hidden for southernlanka (carecode.org) for now; staff
              there sign in with email/employee number + password only (see login field
              above). */}
              {tenant.id !== 'southernlanka' && (
                <>
                  {/* Divider */}
                  <div className="flex items-center gap-3">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-xs font-medium text-muted-foreground">{t.orDivider}</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>

                  {/* Google sign-in */}
                  {primaryMethod !== 'google' && (
                  <Button type="button" variant="outline" size="lg" onClick={handleGoogleSignIn} disabled={googleLoading}
                    className="w-full">
                    {googleLoading
                      ? <div className="h-4 w-4 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground" />
                      : (
                        <svg className="h-4 w-4" viewBox="0 0 24 24">
                          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                        </svg>
                      )
                    }
                    {t.continueGoogle}
                  </Button>
                  )}

                  {/* Microsoft sign-in */}
                  {primaryMethod !== 'microsoft' && (
                  <Button type="button" variant="outline" size="lg" onClick={handleMicrosoftSignIn} disabled={microsoftLoading}
                    className="w-full">
                    {microsoftLoading
                      ? <div className="h-4 w-4 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground" />
                      : (
                        <svg className="h-4 w-4" viewBox="0 0 23 23">
                          <path fill="#f25022" d="M1 1h10v10H1z"/>
                          <path fill="#7fba00" d="M12 1h10v10H12z"/>
                          <path fill="#00a4ef" d="M1 12h10v10H1z"/>
                          <path fill="#ffb900" d="M12 12h10v10H12z"/>
                        </svg>
                      )
                    }
                    {t.continueMicrosoft}
                  </Button>
                  )}
                </>
              )}
            </form>
            )}
          </div>

          {/* ── Dev quick-login (development only) ── */}
          {IS_DEV && (
            <div className="mt-4 rounded-2xl border border-warning/25 bg-card p-4 shadow-card">
              <button type="button" onClick={() => setShowDev(s => !s)}
                className="flex w-full items-center justify-between text-left">
                <span className="text-xs font-bold uppercase tracking-wider text-warning">⚡ Dev Quick Login</span>
                <span className="text-[10px] text-muted-foreground">{showDev ? 'hide' : `${devRoles.length} roles`}</span>
              </button>
              {showDev && (
                <div className="mt-3 max-h-72 overflow-y-auto scrollbar-thin">
                  {/* Two roles per row, ordered System Admin → Admin → rest (senior-first). */}
                  <div className="grid grid-cols-2 gap-1.5">
                    {sortedDevRoles.map(r => (
                      <div key={r.name} className="flex flex-col gap-1 rounded-md border border-border/50 bg-muted/20 px-2 py-1.5">
                        <span className="min-w-0 truncate text-[11px] font-medium text-foreground">{r.name}</span>
                        <div className="flex items-center gap-1">
                          {DEV_EMP_TYPES.map(type => {
                            // Non-employee roles (e.g. System Admin) have no trainee variant.
                            if (type === 'Trainee' && r.is_employee === false) return null;
                            const tag = `${r.name}-${type}`;
                            return (
                              <button key={type} type="button" onClick={() => devLogin(r.name, type)} disabled={!!devBusy}
                                className={`flex-1 rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors disabled:opacity-50 ${type === 'Trainee'
                                  ? 'border-brand/30 bg-brand/10 text-brand hover:bg-brand/20'
                                  : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20'}`}>
                                {devBusy === tag ? '…' : type}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="pt-2 text-[10px] text-muted-foreground">Creates throwaway accounts (password: devtest1234). Dev build only.</p>
                </div>
              )}
            </div>
          )}

          {/* Mobile trust line (brand panel hidden) */}
          <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground lg:hidden">
            <ShieldCheck className="h-3.5 w-3.5" /> {t.trustLine}
          </p>
        </motion.div>
        </div>
      </main>
    </div>
  );
}
