'use client';
import { useState } from 'react';
import { Sun, ExternalLink, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { auth } from '@/lib/firebase';

const SOLAR_URL = 'https://solar.altavision.lk';

/**
 * Opens the Solar app with one-tap auto-login: requests a short-lived SSO token from
 * /api/solar-sso (signed server-side), then navigates a popup to Solar's SSO URL.
 * On any failure it falls back to opening Solar normally (manual login). On platforms
 * with PWA link-capturing the OS routes the URL to the installed Solar app.
 */
export default function SolarAppButton({ onNavigate }: { onNavigate?: () => void }) {
  const [loading, setLoading] = useState(false);

  const open = async () => {
    if (loading) return;
    onNavigate?.();

    // How to land on Solar:
    //  • Touch devices → a TOP-LEVEL navigation to Solar's (in-scope) URL. This is the one
    //    reliable trigger for OS link-capturing: if the Solar PWA is installed it opens in
    //    the installed app; if not, it opens in the browser. (A redirected about:blank popup
    //    is NOT captured, which is why we don't use one here.)
    //  • Desktop → a new tab, opened synchronously so it isn't blocked as a popup, then
    //    redirected once the SSO token is ready.
    const handoff = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
    const go = (url: string) => {
      if (handoff) window.location.href = url;
      else if (win) { win.opener = null; win.location.href = url; }   // sever opener after we have the handle
      else window.open(url, '_blank', 'noopener,noreferrer');
    };
    // Open the placeholder WITHOUT 'noopener' — with it, window.open returns null and we
    // lose the handle, leaving an orphaned blank tab. We drop win.opener in go() instead.
    const win = handoff ? null : window.open('about:blank', '_blank');
    setLoading(true);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new Error('not signed in');
      const res = await fetch('/api/solar-sso', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) throw new Error('sso failed');
      const { url } = await res.json();
      go(url);
    } catch {
      // Couldn't auto-login — open Solar normally so the user can sign in manually.
      go(SOLAR_URL);
      toast('Opened Solar — please sign in', { icon: '☀️' });
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
        : <Sun className="w-[18px] h-[18px] transition-transform group-hover:rotate-45" />}
      <span className="text-sm font-medium">Solar App</span>
      <ExternalLink className="ml-auto w-3.5 h-3.5 opacity-60" />
    </button>
  );
}
