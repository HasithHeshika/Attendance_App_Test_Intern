import { create } from 'zustand';

// Lets window.maintenance() (registered outside React, in MaintenanceGate) open the admin
// control popup from anywhere, and lets the details popup's "jump to controls" button do the
// same. Deliberately NOT persisted — a popup being open is session-transient UI state.
interface MaintenanceUiState {
  controlPopupOpen: boolean;
  openControlPopup: () => void;
  closeControlPopup: () => void;
}

export const useMaintenanceUiStore = create<MaintenanceUiState>((set) => ({
  controlPopupOpen: false,
  openControlPopup: () => set({ controlPopupOpen: true }),
  closeControlPopup: () => set({ controlPopupOpen: false }),
}));
