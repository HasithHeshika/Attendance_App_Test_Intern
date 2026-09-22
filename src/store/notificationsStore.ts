'use client';
// Unified notification-center store. Merges every source the app has —
//   'app'   → Firestore inbox docs (id `fs-<docId>`) + foreground FCM (`fcm-<…>`)
//   'solar' → external Solar feed (id `solar-<id>`)
//   'local' → client-side reminders (id `local-<…>`)
// — into one persisted, per-user list with stable ids and real per-item read state.
// This replaces the old in-memory bell list whose session-counter ids collided with
// the persisted read-id set (new notifications appeared already-read after reloads).

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { safeLocalStorage } from '@/lib/persistStorage';
import { tenant } from '@/lib/firebase';

// The Solar cross-feed is Alta Vision-only (tenant.features.solarApp). On every other tenant
// no 'solar' item may enter or survive in the store — the feed hook is inert there, this is
// the store-side guarantee (rejects any that slip in, purges any left over from before).
const SOLAR_ALLOWED = tenant.features.solarApp;

export type NotifSource = 'app' | 'solar' | 'local';

export interface CenterNotif {
  id: string;                 // globally stable: 'fs-…' | 'solar-…' | 'fcm-…' | 'local-…'
  source: NotifSource;
  type: string;
  title: string;              // English fallback; UI localizes known types via meta
  body: string;
  actorName?: string | null;
  meta?: Record<string, string>;
  link?: string | null;
  external?: boolean;         // link opens outside the app (Solar)
  time: string;               // ISO timestamp
  read: boolean;
  direct?: boolean;           // Firestore direct doc — read state syncs to the server
}

const MAX_ITEMS = 100;

// One-time migration: the old bell persisted read ids (mixed 'solar-<id>' strings and
// legacy numeric FCM ids) under this key. Honour the solar ones so upgrading doesn't
// resurface everything as unread.
function legacyReadIds(epf: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(`notif-read:${epf || 'anon'}`);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch { return new Set(); }
}

interface NotifState {
  owner: string;              // epf the persisted items belong to
  items: CenterNotif[];       // newest first
  clearedBefore: string;      // ISO — items at/before this moment are hidden ("Clear all")
  isOpen: boolean;            // whether the notification center is currently open
  setOwner: (epf: string) => void;
  setIsOpen: (open: boolean) => void;
  openNotificationCenter: () => void;
  closeNotificationCenter: () => void;
  toggleNotificationCenter: () => void;
  /** Merge items from a live source; keeps local read=true, respects clear cutoff. */
  upsert: (incoming: CenterNotif[]) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
  /** Raise the clear cutoff to `iso` (server-synced value); never lowers it. Drops now-hidden items. */
  setClearedBefore: (iso: string) => void;
  unreadCount: () => number;
}

function sortDesc(items: CenterNotif[]): CenterNotif[] {
  return items.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
}

export const useNotificationsStore = create<NotifState>()(
  persist(
    (set, get) => ({
      owner: '',
      items: [],
      clearedBefore: '',
      isOpen: false,

      setIsOpen: (isOpen) => set({ isOpen }),
      openNotificationCenter: () => set({ isOpen: true }),
      closeNotificationCenter: () => set({ isOpen: false }),
      toggleNotificationCenter: () => set((s) => ({ isOpen: !s.isOpen })),

      setOwner: (epf) => {
        if (get().owner === epf) return;
        // Different user on this browser — never leak the previous user's items.
        set({ owner: epf, items: [], clearedBefore: '', isOpen: false });
      },

      upsert: (incoming) => {
        if (!SOLAR_ALLOWED) incoming = incoming.filter(i => i.source !== 'solar');
        if (!incoming.length) return;
        const { items, clearedBefore, owner } = get();
        const legacy = legacyReadIds(owner);
        const byId = new Map(items.map(i => [i.id, i]));
        for (const raw of incoming) {
          if (clearedBefore && raw.time <= clearedBefore) continue;
          const prev = byId.get(raw.id);
          byId.set(raw.id, {
            ...raw,
            // Read is sticky: once read anywhere (locally, server flag, old bell) it
            // never flips back to unread on a refetch.
            read: raw.read || prev?.read === true || legacy.has(raw.id),
          });
        }
        set({ items: sortDesc([...byId.values()]).slice(0, MAX_ITEMS) });
      },

      markRead: (id) => set(s => ({
        items: s.items.map(i => (i.id === id && !i.read ? { ...i, read: true } : i)),
      })),

      markAllRead: () => set(s => ({
        items: s.items.map(i => (i.read ? i : { ...i, read: true })),
      })),

      clearAll: () => set({
        items: [],
        clearedBefore: new Date().toISOString(),
      }),

      setClearedBefore: (iso) => set(s => {
        if (!iso || (s.clearedBefore && iso <= s.clearedBefore)) return s;   // only ever raise the cutoff
        return { clearedBefore: iso, items: s.items.filter(i => i.time > iso) };
      }),

      unreadCount: () => get().items.reduce((n, i) => n + (i.read ? 0 : 1), 0),
    }),
    {
      name: 'notif-center',
      version: 1,
      storage: createJSONStorage(safeLocalStorage),
      partialize: (s) => ({
        owner: s.owner,
        items: s.items.slice(0, MAX_ITEMS),
        clearedBefore: s.clearedBefore,
      }),
      // One-time purge of any 'solar' items left in localStorage from before the feed was
      // gated — for a tenant without solarApp they can never be shown again anyway, this
      // just removes the dead weight so the next persist writes a clean list.
      onRehydrateStorage: () => (state) => {
        if (state && !SOLAR_ALLOWED && state.items.some(i => i.source === 'solar')) {
          state.items = state.items.filter(i => i.source !== 'solar');
        }
      },
    },
  ),
);

// Imperative helper for non-React code (reminder scheduler): add one local item.
export function pushLocalNotification(n: Omit<CenterNotif, 'source' | 'read' | 'time'> & { time?: string }) {
  useNotificationsStore.getState().upsert([{
    ...n,
    source: 'local',
    read: false,
    time: n.time ?? new Date().toISOString(),
  }]);
}

export function openNotificationCenter() {
  useNotificationsStore.getState().openNotificationCenter();
}

export function closeNotificationCenter() {
  useNotificationsStore.getState().closeNotificationCenter();
}
