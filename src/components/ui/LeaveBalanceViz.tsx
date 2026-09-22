'use client';
import { memo } from 'react';
import UsageMeter from '@/components/ui/UsageMeter';
import { useT } from '@/store/appStore';

const fmt = (n: number) => (n % 1 === 0 ? String(n) : n.toFixed(1));

/**
 * Card 3 trailing — the three-segment leave meter (taken / pending / free) plus a
 * per-leave-type remaining breakdown (Annual · Casual · Medical …), top 3 by balance.
 * `toneClass` (a text-* colour) drives the fuel-gauge: azure → amber → orange → red.
 */
function LeaveBalanceVizBase({
  used, pending, remaining, toneClass, byType, takenOnly = [],
}: {
  used: number;
  pending: number;
  remaining: number;
  toneClass: string;
  byType: { name: string; remaining: number }[];
  /** Types that are tracked but carry no entitlement (LeaveType.excluded_from_quota). They are
   *  absent from the meter above on purpose — it gauges a quota they draw nothing from — but a
   *  type vanishing from the card entirely reads as a type that no longer exists, so they get
   *  a chip of their own carrying the days TAKEN. */
  takenOnly?: { name: string; taken: number }[];
}) {
  const t = useT();
  const top = byType
    .filter(b => b.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining)
    .slice(0, 3);

  return (
    <div className="space-y-2">
      <UsageMeter
        used={used}
        pending={pending}
        remaining={remaining}
        className={toneClass}
        takenLabel={t.takenLabel}
        pendingLabel={t.pendingShort}
        leftLabel={t.leftLabel}
      />
      {(top.length > 0 || takenOnly.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {top.map(b => (
            <span
              key={b.name}
              className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
            >
              <span className="max-w-[64px] truncate">{b.name}</span>
              <span className="font-semibold text-foreground tabular-nums">{fmt(b.remaining)}</span>
            </span>
          ))}
          {/* The bare number on the chips above means days LEFT. This one means the opposite, so
              it carries the word — unlabelled, "Medical 3" beside "Annual 4" would read as three
              medical days still in hand. */}
          {takenOnly.map(b => (
            <span
              key={`taken-${b.name}`}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-transparent px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
            >
              <span className="max-w-[64px] truncate">{b.name}</span>
              <span className="font-semibold text-foreground tabular-nums">{fmt(b.taken)}</span>
              <span>{t.takenLabel}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Memoised — leave data doesn't change on the dashboard's 30s live-clock tick.
const LeaveBalanceViz = memo(LeaveBalanceVizBase);
export default LeaveBalanceViz;
