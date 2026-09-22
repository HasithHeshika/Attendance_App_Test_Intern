'use client';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { WifiOff, Wifi, SignalLow } from 'lucide-react';
import { useT } from '@/store/appStore';
import { notifyStructured, type ToastTone } from '@/components/ui/AppToaster';

// Detects offline / slow / back-online transitions and surfaces a single,
// non-stacking toast for each state. Offline & slow toasts persist (and are
// dismissed automatically when the condition clears); "back online" auto-hides.
// Mounted once at the app root so it works on every page, including /login.

// Stable ids keep each state to a single toast (re-emitting just updates it).
const OFFLINE_ID = 'net-offline';
const SLOW_ID    = 'net-slow';
const ONLINE_ID  = 'net-online';

type ConnLike = {
  effectiveType?: string;
  downlink?:      number;   // Mbps
  rtt?:           number;   // ms
  saveData?:      boolean;
  addEventListener?:    (type: 'change', cb: () => void) => void;
  removeEventListener?: (type: 'change', cb: () => void) => void;
};

function getConnection(): ConnLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const nav = navigator as Navigator & {
    connection?: ConnLike; mozConnection?: ConnLike; webkitConnection?: ConnLike;
  };
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
}

// Network Information API isn't in Safari/iOS — there we simply never flag "slow".
function isSlowConnection(c: ConnLike | undefined): boolean {
  if (!c) return false;
  if (c.saveData) return true;
  if (c.effectiveType === 'slow-2g' || c.effectiveType === '2g') return true;
  if (typeof c.downlink === 'number' && c.downlink > 0 && c.downlink < 0.6) return true;
  if (typeof c.rtt === 'number' && c.rtt >= 600) return true;
  return false;
}

type Accent = 'destructive' | 'warning' | 'success';
const ACCENT_TONE: Record<Accent, ToastTone> = {
  destructive: 'error',
  warning:     'warning',
  success:     'success',
};

// Network cards render through the shared AppToaster shell (glass surface +
// entrance/exit animation + smart placement); this only supplies the content,
// keyed by a stable id so each state stays a single, non-stacking toast.
function showCard(opts: {
  id: string; icon: ReactNode; title: string; desc: string; accent: Accent; duration: number;
}) {
  notifyStructured({
    id:       opts.id,
    tone:     ACCENT_TONE[opts.accent],
    icon:     opts.icon,
    title:    opts.title,
    desc:     opts.desc,
    duration: opts.duration,
  });
}

export default function NetworkStatus() {
  const t = useT();
  // Listeners are registered once but must always read the current language.
  const tRef = useRef(t);
  tRef.current = t;
  const wasOfflineRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const conn = getConnection();

    const showOffline = () => showCard({
      id: OFFLINE_ID, icon: <WifiOff className="w-4 h-4" />, accent: 'destructive',
      title: tRef.current.netOfflineTitle, desc: tRef.current.netOfflineDesc, duration: Infinity,
    });
    const showSlow = () => showCard({
      id: SLOW_ID, icon: <SignalLow className="w-4 h-4" />, accent: 'warning',
      title: tRef.current.netSlowTitle, desc: tRef.current.netSlowDesc, duration: Infinity,
    });
    const showBackOnline = () => showCard({
      id: ONLINE_ID, icon: <Wifi className="w-4 h-4" />, accent: 'success',
      title: tRef.current.netOnlineTitle, desc: tRef.current.netOnlineDesc, duration: 4000,
    });

    const evaluate = () => {
      if (!navigator.onLine) {
        // Offline supersedes the slow / back-online toasts.
        toast.dismiss(SLOW_ID);
        toast.dismiss(ONLINE_ID);
        showOffline();
        wasOfflineRef.current = true;
        return;
      }
      // Online: clear the offline toast and celebrate only if we were actually offline.
      toast.dismiss(OFFLINE_ID);
      if (wasOfflineRef.current) {
        wasOfflineRef.current = false;
        showBackOnline();
      }
      // Slow is independent of the online/offline edge.
      if (isSlowConnection(conn)) showSlow();
      else toast.dismiss(SLOW_ID);
    };

    // Initial state: flag offline immediately, but don't fire "slow" until the
    // connection has had a moment to report real numbers after load.
    if (!navigator.onLine) { showOffline(); wasOfflineRef.current = true; }
    const initialSlow = setTimeout(() => { if (navigator.onLine && isSlowConnection(conn)) showSlow(); }, 4000);

    window.addEventListener('online', evaluate);
    window.addEventListener('offline', evaluate);
    conn?.addEventListener?.('change', evaluate);

    return () => {
      clearTimeout(initialSlow);
      window.removeEventListener('online', evaluate);
      window.removeEventListener('offline', evaluate);
      conn?.removeEventListener?.('change', evaluate);
      toast.dismiss(OFFLINE_ID);
      toast.dismiss(SLOW_ID);
      toast.dismiss(ONLINE_ID);
    };
  }, []);

  return null;
}
