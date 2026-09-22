'use client';
import { motion, useReducedMotion } from 'framer-motion';

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Card 3 micro-graph — a part-to-whole leave meter split into three segments of the
 * annual entitlement: taken (approved, neutral) · pending (requested, amber) · free
 * (still available, carries the tone). `className` sets the tone colour (text-*), which
 * the free segment + the "left" label inherit via currentColor — so the dashboard can
 * escalate it azure → amber → orange → red as the balance depletes. Reduced-motion safe.
 */
export default function UsageMeter({
  used, pending = 0, remaining, takenLabel = 'taken', pendingLabel = 'pending',
  leftLabel = 'left', showLeft = true, className = 'text-brand',
}: {
  used: number;
  pending?: number;
  remaining: number;
  takenLabel?: string;
  pendingLabel?: string;
  leftLabel?: string;
  /** Drop the "N left" label when the caller already prints that number beside the bar —
   *  otherwise the same figure appears twice, in two formats, in one card. */
  showLeft?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const u = Math.max(0, used);
  const r = Math.max(0, remaining);
  const total = u + r;            // pending is not deducted from balance until approved
  const p = Math.max(0, Math.min(pending, r)); // pending is carved out of the remaining balance
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  const usedPct = pct(u);
  const pendingPct = pct(p);
  const freePct = total > 0 ? Math.max(0, 100 - usedPct - pendingPct) : 100;

  return (
    <div className={className}>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-current/10">
        {/* taken — neutral, anchored left */}
        {usedPct > 0 && (
          <motion.div
            className="h-full bg-foreground/25"
            initial={reduce ? false : { width: 0 }}
            animate={{ width: `${usedPct}%` }}
            transition={{ duration: 0.6, ease: EASE, delay: reduce ? 0 : 0.1 }}
          />
        )}
        {/* pending — amber, "awaiting a decision" */}
        {pendingPct > 0 && (
          <motion.div
            className="h-full bg-warning"
            initial={reduce ? false : { width: 0 }}
            animate={{ width: `${pendingPct}%` }}
            transition={{ duration: 0.6, ease: EASE, delay: reduce ? 0 : 0.18 }}
          />
        )}
        {/* free — the tone colour (fuel gauge) */}
        <motion.div
          className="h-full bg-current"
          initial={reduce ? false : { width: 0 }}
          animate={{ width: `${freePct}%` }}
          transition={{ duration: 0.6, ease: EASE, delay: reduce ? 0 : 0.26 }}
        />
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-1 text-[10px] font-medium">
        <span className="text-muted-foreground">
          <span className="font-semibold text-foreground tabular-nums">{u.toFixed(1)}</span> {takenLabel}
        </span>
        {p > 0 && (
          <span className="text-warning">
            <span className="font-semibold tabular-nums">{p.toFixed(1)}</span> {pendingLabel}
          </span>
        )}
        {showLeft && (
          <span className="text-current">
            <span className="font-semibold tabular-nums">{r.toFixed(1)}</span> {leftLabel}
          </span>
        )}
      </div>
    </div>
  );
}
