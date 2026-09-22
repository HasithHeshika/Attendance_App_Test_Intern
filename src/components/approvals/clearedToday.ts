'use client';

// "Cleared today" counter for the all-caught-up state. Per browser, per calendar day, and
// deliberately local: it is a note to the approver about their own afternoon, not a figure
// anyone reports on. Every access is wrapped — a private window throws on localStorage.

const PREFIX = 'approvals:cleared:';

export function readClearedToday(dateStr: string): number {
  try {
    const raw = window.localStorage.getItem(PREFIX + dateStr);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

export function addClearedToday(dateStr: string, n: number): number {
  if (n <= 0) return readClearedToday(dateStr);
  const next = readClearedToday(dateStr) + n;
  try { window.localStorage.setItem(PREFIX + dateStr, String(next)); } catch { /* nothing to persist to */ }
  return next;
}
