import { create } from 'zustand';

type LanyardMode = 'loginReveal' | 'manual' | null;

interface LanyardState {
  open: boolean;
  mode: LanyardMode;
  dashboardReadyAt: number | null;
  startLoginReveal: () => void;
  signalDashboardReady: () => void;
  openManual: () => void;
  close: () => void;
}

export const useLanyardStore = create<LanyardState>((set) => ({
  open: false,
  mode: null,
  dashboardReadyAt: null,
  startLoginReveal: () => set({ open: true, mode: 'loginReveal', dashboardReadyAt: null }),
  signalDashboardReady: () => set((s) => (s.dashboardReadyAt == null ? { dashboardReadyAt: Date.now() } : {})),
  openManual: () => set({ open: true, mode: 'manual' }),
  close: () => set({ open: false, mode: null, dashboardReadyAt: null }),
}));
