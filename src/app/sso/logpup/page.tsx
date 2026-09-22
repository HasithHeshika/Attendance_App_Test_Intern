'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signInWithCustomToken } from 'firebase/auth';
import { Loader2, AlertCircle } from 'lucide-react';
import { auth } from '@/lib/firebase';
import { useT } from '@/store/appStore';

/**
 * Landing page for a sign-in handoff from LogPup.
 *
 * DELIBERATELY OUTSIDE the (pages) route group. That layout gates on an authenticated session,
 * and a receiver that bounced to /login before it could redeem the token would be a handoff that
 * never works — failing only in the signed-out case, which is the one nobody tests by hand.
 *
 * The token is redeemed server-side (/api/auth/logpup-sso) for a Firebase custom token; from
 * `signInWithCustomToken` on, this is a perfectly ordinary session. AuthProvider's
 * onAuthStateChanged hydrates the profile and mints the capability claims exactly as it does
 * after a password sign-in, so nothing downstream can tell how the person got in.
 */
export default function LogPupSsoPage() {
  return (
    <Suspense fallback={<Centered><Spinner /></Centered>}>
      <Redeem />
    </Suspense>
  );
}

function Redeem() {
  const tr = useT();
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  // React 18+ mounts effects twice in development; redeeming twice would burn the single-use
  // token on the second run and show "already used" on a perfectly good link.
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const token = params.get('token');
    const next = safeNext(params.get('next'));

    if (!token) {
      setError(tr.logpupLinkMissingToken);
      return;
    }

    void (async () => {
      try {
        const res = await fetch('/api/auth/logpup-sso', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.token) {
          setError(messageFor(data?.error, tr));
          return;
        }
        await signInWithCustomToken(auth, data.token);
        router.replace(next);
      } catch {
        setError(tr.logpupSignInFailed);
      }
    })();
  }, [params, router, tr]);

  if (error) {
    return (
      <Centered>
        <div className="flex flex-col items-center gap-4 text-center">
          <AlertCircle className="h-8 w-8 text-warning" aria-hidden />
          <p className="max-w-xs text-sm text-muted-foreground">{error}</p>
          <button
            type="button"
            onClick={() => router.replace('/login')}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            {tr.logpupGoToSignIn}
          </button>
        </div>
      </Centered>
    );
  }

  return <Centered><Spinner /></Centered>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      {children}
    </main>
  );
}

function Spinner() {
  const tr = useT();
  return (
    <div className="flex flex-col items-center gap-3">
      <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
      <p className="text-sm text-muted-foreground">{tr.logpupSigningIn}</p>
    </div>
  );
}

/**
 * The route answers with short codes for the refusals worth wording precisely.
 *
 * An UNRECOGNISED code falls back to the generic sentence rather than being shown verbatim: it
 * arrives from a server response, and rendering it would put unreviewed, untranslated text on a
 * sign-in screen.
 */
function messageFor(code: unknown, tr: ReturnType<typeof useT>): string {
  switch (code) {
    case 'NotRegistered':                 return tr.logpupNoProfile;
    case 'AccountInactive':               return tr.logpupAccountInactive;
    case 'This link has already been used': return tr.logpupLinkUsed;
    default:                              return tr.logpupLinkExpired;
  }
}

/**
 * Where to land after signing in.
 *
 * One leading slash, never two. `//evil.example` is a protocol-relative URL that browsers treat
 * as absolute, so an unvalidated `next` on a sign-in route is an open redirect — the classic way
 * to harvest a session by bouncing somebody to a lookalike host straight after they authenticate.
 */
function safeNext(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/dashboard';
  return value;
}
