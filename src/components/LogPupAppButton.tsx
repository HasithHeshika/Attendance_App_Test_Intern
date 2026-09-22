'use client';
import { useState } from 'react';
import { ListChecks, ExternalLink, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { auth } from '@/lib/firebase';
import { useT } from '@/store/appStore';

const LOGPUP_URL = 'https://logpup.altavision.lk';

/**
 * Opens LogPup with one-tap auto-login: requests a short-lived SSO token from /api/logpup-sso
 * (signed server-side), then navigates to LogPup's receiver. On any failure it falls back to
 * opening LogPup normally (manual sign-in).
 *
 * THE FALLBACK IS THE FEATURE, not an error path. Both apps are PWAs with persistent sessions,
 * so the common case is that the person is already signed in at the other end and the SSO round
 * trip was never needed. A broken handoff should cost a click, not a journey.
 *
 * Copied from SolarAppButton, including three details that were paid for in production and are
 * invisible if this is rewritten from scratch — see the comments inside `open`.
 */
export default function LogPupAppButton({ onNavigate }: { onNavigate?: () => void }) {
  const tr = useT();
  const [loading, setLoading] = useState(false);

  const open = async () => {
    if (loading) return;
    onNavigate?.();

    // How to land on LogPup:
    //  • Touch devices → a TOP-LEVEL navigation. This is the one reliable trigger for OS
    //    link-capturing: if the LogPup PWA is installed it opens in the installed app, and if
    //    not it opens in the browser. (A redirected about:blank popup is NOT captured.)
    //  • Desktop → a new tab, opened synchronously so it isn't blocked as a popup, then
    //    redirected once the SSO token is ready.
    const handoff = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
    const go = (url: string) => {
      if (handoff) window.location.href = url;
      else if (win) { win.opener = null; win.location.href = url; }  // sever opener after we have the handle
      else window.open(url, '_blank', 'noopener,noreferrer');
    };
    // Opened WITHOUT 'noopener' — with it, window.open returns null and we lose the handle,
    // leaving an orphaned blank tab. We drop win.opener in go() instead.
    const win = handoff ? null : window.open('about:blank', '_blank');
    setLoading(true);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new Error('not signed in');
      const res = await fetch('/api/logpup-sso', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) throw new Error('sso failed');
      const { url } = await res.json();
      go(url);
    } catch {
      go(LOGPUP_URL);
      toast(tr.logpupOpenedManualSignIn, { icon: '🐾' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={open}
      disabled={loading}
      className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-primary transition-colors hover:bg-primary/10 disabled:opacity-60"
    >
      {loading
        ? <Loader2 className="w-[18px] h-[18px] animate-spin" />
        : <ListChecks className="w-[18px] h-[18px] transition-transform group-hover:scale-110" />}
      <span className="text-sm font-medium">LogPup</span>
      <ExternalLink className="ml-auto w-3.5 h-3.5 opacity-60" />
    </button>
  );
}
