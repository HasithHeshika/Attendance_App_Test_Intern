'use client';
// Small display helpers shared by the suspense page and its extracted views (holder overview,
// approver ledger, accounts). Kept here so the page and the components never drift on how a
// status, an approver line or a split is shown.
import { useEffect, useId, useState } from 'react';
import { ShieldAlert, Users as UsersIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import BillThumb from '@/components/BillThumb';
import { formatSuspenseAmount, resolveLimitForEpf } from '@/services/suspenseService';
import { LIMIT_SOURCE_LABEL, limitHeadroom, type ResolvedLimit } from '@/lib/suspenseLimits';
import type { SuspenseSplit, SuspenseStatus } from '@/lib/types';

export const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
export const millis = (ts: { toMillis?: () => number } | null | undefined) => ts?.toMillis?.() ?? 0;

export function fmtDateTime(ts: { toDate?: () => Date } | null | undefined): string {
  try { return ts?.toDate?.().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) ?? '—'; } catch { return '—'; }
}

/** "Tue, 5 Aug 2026" from a YYYY-MM-DD key, on the browser's own clock. */
export function prettyDay(iso: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

/** First letters of the first two words — the avatar fallback. */
export function initialsOf(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function StatusBadge({ status }: { status: SuspenseStatus }) {
  const variant = status === 'approved' ? 'success' : status === 'rejected' ? 'destructive' : 'warning';
  return <Badge variant={variant}>{status[0].toUpperCase() + status.slice(1)}</Badge>;
}

// Who approved / rejected a considered item (and the reason, if rejected).
export function ConsideredBy({ status, byName, by, reason }: {
  status: SuspenseStatus; byName: string | null; by: string | null; reason: string | null;
}) {
  const who = byName || by;
  if (status === 'approved') return <div className="mt-1 text-xs text-success">Approved{who ? ` by ${who}` : ''}</div>;
  if (status === 'rejected') return (
    <div className="mt-1 text-xs text-destructive">
      <div>Rejected{who ? ` by ${who}` : ''}</div>
      {/* The reason is the part that matters to the person reading it — give it its own line
          and a quieter treatment so the whole thing stops reading as one long red sentence. */}
      {reason && (
        <div className="mt-1 rounded-md border border-destructive/20 bg-destructive/5 px-2 py-1 text-[11px] leading-relaxed text-foreground/80">
          {reason}
        </div>
      )}
    </div>
  );
  return null;
}

// Bill thumbnail + modal (shared with the suspense report).
export const BillLink = BillThumb;

export const sumSplits = (s?: SuspenseSplit[]) => (s ?? []).reduce((t, x) => t + (x.amount || 0), 0);

// Lists the other employees a bill was split with — each amount is a salary deduction for them.
export function SplitsLine({ splits, currency }: { splits?: SuspenseSplit[]; currency: string }) {
  if (!splits?.length) return null;
  return (
    <div className="mt-1 space-y-0.5">
      {splits.map((s, i) => (
        <div key={i} className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <UsersIcon className="h-3 w-3 shrink-0" /> <span className="truncate">{s.employee_name}</span>
          <span className="tabular-nums">· {formatSuspenseAmount(s.amount, currency)}</span>
          <span className="text-muted-foreground/60">salary deduction</span>
        </div>
      ))}
    </div>
  );
}

/** A person chip: initials disc + name + EPF. */
export function PersonAvatar({ name, size = 'md', className = '' }: { name: string; size?: 'sm' | 'md'; className?: string }) {
  const cls = size === 'sm' ? 'h-7 w-7 text-[11px]' : 'h-9 w-9 text-sm';
  return (
    <div aria-hidden className={`flex ${cls} shrink-0 items-center justify-center rounded-full bg-primary/10 font-bold text-primary ${className}`}>
      {initialsOf(name)}
    </div>
  );
}

// ─── Float limits (see src/lib/suspenseLimits.ts) ───────────────────────────────
// The UI half of the ceiling the service already enforces. Everything here is a HINT: the
// authoritative check lives in approveRequest / adjustSuspenseAccount, which re-resolve the
// limit at write time. These helpers only make sure nobody has to discover the ceiling by
// having their approval thrown back at them.

/** resolveLimitForEpf reads two docs (the settings doc + the person's profile). An approvals
 *  queue mounts one card per pending request, so the same reads would fire on every render of
 *  every card. Cache per person+company for a minute — long enough to cover a queue, short
 *  enough that a limit an admin just changed shows up without a reload. */
const LIMIT_TTL_MS = 60_000;
const limitCache = new Map<string, { at: number; p: Promise<ResolvedLimit> }>();

export function resolveLimitCached(epf: string, companyId: string): Promise<ResolvedLimit> {
  const key = `${epf}__${companyId}`;
  const hit = limitCache.get(key);
  if (hit && Date.now() - hit.at < LIMIT_TTL_MS) return hit.p;
  // A failed lookup must not be cached, or one flaky read would hide the limit for a minute.
  const p = resolveLimitForEpf(epf, companyId).catch((e) => { limitCache.delete(key); throw e; });
  limitCache.set(key, { at: Date.now(), p });
  return p;
}

/** The limit that applies to one person's account, or null while it is still loading / could
 *  not be read. A resolved value with `limit === null` means "no limit applies", which is a
 *  different thing — callers render nothing for either, so both collapse to "show no line". */
export function useResolvedLimit(epf: string | null | undefined, companyId: string | null | undefined): ResolvedLimit | null {
  const [resolved, setResolved] = useState<ResolvedLimit | null>(null);
  useEffect(() => {
    if (!epf || !companyId) { setResolved(null); return; }
    let alive = true;
    setResolved(null);
    resolveLimitCached(epf, companyId)
      .then(r => { if (alive) setResolved(r); })
      .catch(() => { if (alive) setResolved(null); });
    return () => { alive = false; };
  }, [epf, companyId]);
  return resolved;
}

export const limitSourceLabel = (r: ResolvedLimit | null) =>
  (r?.source ? LIMIT_SOURCE_LABEL[r.source] : 'limit');

/** "Balance x · limit y (role limit) · headroom z" — the one line an approver needs before
 *  typing an amount. Renders nothing when no limit applies to this account. */
export function LimitHeadroomLine({ resolved, balance, currency, className = '' }: {
  resolved: ResolvedLimit | null; balance: number; currency: string; className?: string;
}) {
  if (!resolved || resolved.limit === null) return null;
  const room = limitHeadroom(resolved.limit, balance) ?? 0;
  return (
    <p className={`text-[11px] text-muted-foreground ${className}`}>
      Balance <span className="font-medium tabular-nums text-foreground">{formatSuspenseAmount(balance, currency)}</span>
      {' · '}limit <span className="font-medium tabular-nums text-foreground">{formatSuspenseAmount(resolved.limit, currency)}</span>
      {' '}({limitSourceLabel(resolved)})
      {' · '}headroom{' '}
      <span className={`font-medium tabular-nums ${room < 0 ? 'text-destructive' : 'text-foreground'}`}>
        {formatSuspenseAmount(room, currency)}
      </span>
    </p>
  );
}

/** The amber gate shown when the amount on screen would push the balance past the ceiling.
 *  Ticking the box + typing a reason is what unlocks the action; the reason is passed to the
 *  service as `overrideLimit` and lands in the ledger note, so it is never a silent bypass. */
export function LimitOverridePanel({ name, resolved, balanceAfter, excess, currency, checked, onCheckedChange, reason, onReasonChange, disabled }: {
  name: string; resolved: ResolvedLimit | null; balanceAfter: number; excess: number; currency: string;
  checked: boolean; onCheckedChange: (v: boolean) => void;
  reason: string; onReasonChange: (v: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="mt-2 rounded-lg border border-warning/30 bg-warning/10 p-2.5">
      <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-warning">
        <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
        <span>
          This would put <span className="font-semibold">{name}</span> at{' '}
          <span className="font-semibold tabular-nums">{formatSuspenseAmount(balanceAfter, currency)}</span>,{' '}
          <span className="font-semibold tabular-nums">{formatSuspenseAmount(excess, currency)}</span> over their {limitSourceLabel(resolved)}.
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Checkbox id={`${id}-ovr`} checked={checked} disabled={disabled}
          onCheckedChange={v => onCheckedChange(v === true)} />
        <Label htmlFor={`${id}-ovr`} className="cursor-pointer text-[11px] font-medium text-foreground">Override the limit</Label>
      </div>
      {checked && (
        <Input value={reason} disabled={disabled} onChange={e => onReasonChange(e.target.value)}
          className="mt-2 h-8 text-xs" placeholder="Why is this being allowed? (required)"
          aria-label="Reason for overriding the limit" />
      )}
    </div>
  );
}
