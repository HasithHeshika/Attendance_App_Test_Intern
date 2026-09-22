'use client';
// sessionStorage-backed bypass flags for the maintenance overlay, keyed by startAtMs so a
// bypass never survives into a DIFFERENT armed window (a re-arm gets a fresh startAtMs, so an
// old flag simply doesn't match it).
//
// IMPORTANT: reading these flags does NOT by itself decide whether to honour a bypass — callers
// must always re-check the LIVE session's role/mode alongside them. A flag set by an earlier
// admin login can linger in the same tab's sessionStorage after a lesser-privileged user signs
// in; only re-checking the live role on every render keeps that stale flag from ever surfacing
// admin controls (like "End maintenance now") to someone who isn't currently an admin.

const adminKey = (startAtMs: number) => `mnt_bypass_admin_${startAtMs}`;
const readonlyKey = (startAtMs: number) => `mnt_bypass_readonly_${startAtMs}`;

function safeGet(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try { return sessionStorage.getItem(key) === '1'; } catch { return false; }
}
function safeSet(key: string): void {
  if (typeof window === 'undefined') return;
  try { sessionStorage.setItem(key, '1'); } catch { /* private-browsing quota etc. — non-critical */ }
}

export function setAdminBypass(startAtMs: number): void { safeSet(adminKey(startAtMs)); }
export function hasAdminBypassFlag(startAtMs: number): boolean { return safeGet(adminKey(startAtMs)); }

export function setReadonlyBypass(startAtMs: number): void { safeSet(readonlyKey(startAtMs)); }
export function hasReadonlyBypassFlag(startAtMs: number): boolean { return safeGet(readonlyKey(startAtMs)); }
