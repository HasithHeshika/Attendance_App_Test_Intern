import { create } from 'zustand';

// Shared "which company" selection across the whole Payroll module (Settings, Employees,
// Monthly Run, Loans, Reports) — changing the company selector on any one of those pages
// carries over to the others instead of each page defaulting back to
// pickDefaultCompanyId() on every navigation. Plain in-memory store (same convention as
// suspenseStore.ts) — resets on a full page reload, which is fine since each page still
// re-derives a sensible default (pickDefaultCompanyId) whenever the store is empty.
interface PayrollUiState {
  companyId: string;
  setCompanyId: (id: string) => void;
}

export const usePayrollUiStore = create<PayrollUiState>((set) => ({
  companyId: '',
  setCompanyId: (id) => set({ companyId: id }),
}));
