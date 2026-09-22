'use client';
import { useEffect, useRef, useState } from 'react';
import { auth, tenant } from '@/lib/firebase';
import { useAuthStore } from '@/store/authStore';

export interface SolarNotif {
  id: string;
  title: string;
  message: string;
  type?: string;          // info | success | warning | error — drives the pill colour
  category?: string;
  link?: string | null;
  recipientType?: string; // e.g. "users" | "all"
  createdByName?: string; // sender
  createdAt: string;
  read: boolean;
}

// Polls the signed-in user's Solar notifications via the server proxy (/api/solar/
// notifications) every 60s — de-duped, newest-first. Degrades silently if Solar is
// unreachable or the user has no match. Pass `enabled` (auth ready) to start.
//
// The Solar cross-feed is an Alta Vision-only integration (tenant.features.solarApp). On
// every other tenant (e.g. Southern Lanka) this hook is inert — no poll, no items — so
// Solar events never leak into the HR/Attendance notification bell.
export function useSolarNotifications(enabled: boolean): { items: SolarNotif[]; refetch: () => Promise<void> } {
  const solarEnabled = enabled && tenant.features.solarApp;
  const user = useAuthStore(s => s.user);
  const epf   = user?.epf_number ? String(user.epf_number) : undefined;
  const email = user?.email ?? undefined;
  const phone = (user as { phone_personal?: string } | null | undefined)?.phone_personal ?? undefined;

  const [items, setItems] = useState<SolarNotif[]>([]);
  const sinceRef = useRef<string | undefined>(undefined);
  const pollRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!solarEnabled) return;
    let stopped = false;

    const poll = async () => {
      try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken || stopped) return;
        const res = await fetch('/api/solar/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken, since: sinceRef.current, epf, email, phone }),
        });
        if (!res.ok || stopped) return;
        const data = await res.json();
        const incoming: SolarNotif[] = Array.isArray(data?.data) ? data.data : [];
        if (!incoming.length) return;
        sinceRef.current = incoming[0]?.createdAt ?? sinceRef.current;
        setItems(prev => {
          const seen = new Set(prev.map(p => p.id));
          const fresh = incoming.filter(n => !seen.has(n.id));
          return fresh.length ? [...fresh, ...prev].slice(0, 50) : prev;
        });
      } catch { /* offline / unreachable — ignore */ }
    };

    pollRef.current = poll;
    poll();
    // 60s (Solar recommends 30–60s): at 300+ users the 30s cadence doubled the load on
    // the shared Solar backend + the proxy for no visible freshness win.
    const id = setInterval(poll, 60_000);
    const onFocus = () => poll();
    window.addEventListener('focus', onFocus);
    return () => { stopped = true; clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, [solarEnabled, epf, email, phone]);

  const refetch = async () => {
    if (solarEnabled && pollRef.current) {
      await pollRef.current();
    }
  };

  return { items, refetch };
}
