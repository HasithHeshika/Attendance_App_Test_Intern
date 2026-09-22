// Planned-maintenance mode — pure logic (no Firebase/React imports so this stays trivially
// unit-testable and can never itself be the reason a client gets locked out). Everything that
// touches Firestore/sessionStorage/the DOM lives in src/services/maintenanceService.ts and
// src/components/maintenance/*.
//
// Doc lives at settings/maintenance. A malformed or partially-written doc must NEVER lock
// clients out, so parseMaintenanceDoc() is strict: any structurally-wrong safety field (enabled,
// startAtMs, endAtMs, mode, kind) makes the whole doc parse to `null`, which derives to the
// 'off' phase — the same as maintenance mode never having been armed.

export type MaintenanceKind = 'maintenance' | 'upgrade' | 'emergency';
export type MaintenanceAccessMode = 'readonly' | 'block' | 'lockdown';
export type MaintenancePhase = 'off' | 'scheduled' | 'active' | 'ended';

export interface MaintenanceDoc {
  enabled: boolean;
  startAtMs: number;
  endAtMs: number;
  message: string;
  mode: MaintenanceAccessMode;
  kind: MaintenanceKind;
  createdBy: string;
  createdByName: string;
  // Lifecycle-notification dedupe stamps (written by the Cloud Function) — each compared
  // against the CURRENT startAtMs/endAtMs so a re-armed window announces again.
  startNotifiedAtMs?: number;
  endNotifiedAtMs?: number;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Strict on the fields that gate access (enabled/startAtMs/endAtMs/mode/kind) — any of those
// being missing, the wrong type, or end<=start makes the whole doc parse to null ("off").
// Lenient on display-only fields (message/createdBy/createdByName) since a blank label is
// harmless, unlike a bad boundary.
export function parseMaintenanceDoc(raw: unknown): MaintenanceDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.enabled !== 'boolean') return null;
  if (!isFiniteNumber(r.startAtMs) || !isFiniteNumber(r.endAtMs)) return null;
  if (r.endAtMs <= r.startAtMs) return null;
  if (r.mode !== 'readonly' && r.mode !== 'block' && r.mode !== 'lockdown') return null;
  if (r.kind !== 'maintenance' && r.kind !== 'upgrade' && r.kind !== 'emergency') return null;

  return {
    enabled: r.enabled,
    startAtMs: r.startAtMs,
    endAtMs: r.endAtMs,
    mode: r.mode,
    kind: r.kind,
    message: asString(r.message),
    createdBy: asString(r.createdBy),
    createdByName: asString(r.createdByName),
    ...(isFiniteNumber(r.startNotifiedAtMs) ? { startNotifiedAtMs: r.startNotifiedAtMs } : {}),
    ...(isFiniteNumber(r.endNotifiedAtMs) ? { endNotifiedAtMs: r.endNotifiedAtMs } : {}),
  };
}

// Phase is derived purely from the wall clock — start inclusive, end exclusive, so a window
// is never simultaneously "scheduled" and "active", or "active" and "ended".
export function deriveMaintenancePhase(doc: MaintenanceDoc | null, nowMs: number): MaintenancePhase {
  if (!doc || !doc.enabled) return 'off';
  if (nowMs < doc.startAtMs) return 'scheduled';
  if (nowMs < doc.endAtMs) return 'active';
  return 'ended';
}

export const URGENT_COUNTDOWN_MS = 10 * 60 * 1000; // banner/overlay turn red under 10 minutes

export function isUrgentCountdown(remainingMs: number): boolean {
  return remainingMs <= URGENT_COUNTDOWN_MS;
}

// "1h 5m 30s" / "5m 30s" / "30s" — never negative, drops the hours/minutes segment once it hits 0.
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// ─── datetime-local round trip ──────────────────────────────────────────────────
// <input type="datetime-local"> works in the browser's LOCAL time with no timezone info
// ("YYYY-MM-DDTHH:mm"), so both directions must go through the local Date constructor —
// never toISOString(), which is UTC and would shift the picked time.
export function msToDatetimeLocalValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function datetimeLocalValueToMs(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), s ? Number(s) : 0, 0);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ─── Quick presets & extend chips ───────────────────────────────────────────────
export interface MaintenanceWindow { startAtMs: number; endAtMs: number }

function atLocalTime(base: Date, hour: number, minute: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
}

// "Tonight 20:00 → 06:00" — rolls to tomorrow night if 20:00 has already passed today.
export function presetTonight(nowMs: number): MaintenanceWindow {
  const now = new Date(nowMs);
  let start = atLocalTime(now, 20, 0);
  if (start.getTime() <= nowMs) start = atLocalTime(new Date(start.getTime() + 24 * 60 * 60 * 1000), 20, 0);
  const end = atLocalTime(new Date(start.getTime() + 24 * 60 * 60 * 1000), 6, 0);
  return { startAtMs: start.getTime(), endAtMs: end.getTime() };
}

// "Now → 06:00" — rolls to tomorrow 06:00 if 06:00 has already passed today.
export function presetNowToSixAM(nowMs: number): MaintenanceWindow {
  const now = new Date(nowMs);
  let end = atLocalTime(now, 6, 0);
  if (end.getTime() <= nowMs) end = atLocalTime(new Date(end.getTime() + 24 * 60 * 60 * 1000), 6, 0);
  return { startAtMs: nowMs, endAtMs: end.getTime() };
}

// "Now +1h" / "Now +2h"
export function presetNowPlusHours(nowMs: number, hours: number): MaintenanceWindow {
  return { startAtMs: nowMs, endAtMs: nowMs + hours * 60 * 60 * 1000 };
}

// Sane default window for a fresh control popup (no doc armed yet).
export function defaultMaintenanceWindow(nowMs: number): MaintenanceWindow {
  return presetNowPlusHours(nowMs, 1);
}

// Extend-end chips: +30m / +1h / +2h / +12h.
export function extendEndAtMs(currentEndMs: number, minutes: number): number {
  return currentEndMs + minutes * 60 * 1000;
}

// ─── Kind / mode display metadata (labels only — icons are chosen in the component layer) ──
export const MAINTENANCE_KIND_LABEL: Record<MaintenanceKind, string> = {
  maintenance: 'Scheduled Maintenance',
  upgrade: 'System Upgrade',
  emergency: 'Emergency Maintenance',
};

export const MAINTENANCE_MODE_LABEL: Record<MaintenanceAccessMode, string> = {
  readonly: 'Read-only — users may view (no edits)',
  block: 'Blocked — only admins may enter',
  lockdown: 'Lockdown — cannot be dismissed',
};

export function formatWindowRange(startAtMs: number, endAtMs: number): string {
  const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  return `${fmt(startAtMs)} – ${fmt(endAtMs)}`;
}

// Auto-regenerated message — the control popup uses this until the admin hand-edits the
// textarea (tracked separately in the component; this function is the "Auto-write" source).
export function autoMaintenanceMessage(kind: MaintenanceKind, startAtMs: number, endAtMs: number): string {
  const range = formatWindowRange(startAtMs, endAtMs);
  switch (kind) {
    case 'upgrade':
      return `We're upgrading the system on ${range}. The app will be briefly unavailable while we roll out improvements. Thanks for your patience!`;
    case 'emergency':
      return `We've identified an urgent issue and are performing emergency maintenance from ${range}. We're working to restore full service as quickly as possible.`;
    case 'maintenance':
    default:
      return `Scheduled maintenance is planned for ${range}. The app may be unavailable during this window. Thanks for your patience!`;
  }
}
