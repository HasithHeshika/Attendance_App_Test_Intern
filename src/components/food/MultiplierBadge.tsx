'use client';
import { cn } from '@/lib/utils';
import { useT } from '@/store/appStore';
import { multiplierOf, type MealMultiplier } from '@/lib/foodCost';

/**
 * The word that goes beside the number. The NUMBER is never translated — it is a value, and
 * "2×" means the same thing in all three languages. Only the reason is language.
 */
export function useMultiplierWord(): (m: MealMultiplier) => string {
  const t = useT();
  return m => (m < 1 ? t.foodMultHelped : m === 1 ? t.foodMultNormalWord : t.foodMultLate);
}

interface Props {
  /** A booking row. Anything that is not one of the four values reads as 1 — see multiplierOf. */
  row: { multiplier?: unknown; multiplier_note?: string; multiplier_by_name?: string } | null | undefined;
  /** Print the reason beside the number instead of only in the tooltip. For a roomy row. */
  detail?: boolean;
  className?: string;
}

// What one meal was charged at, when it was not charged at the usual rate.
//
// Somebody charged more is told so on the row that charges them, rather than being left to
// decompose a month's total and work out where the difference came from.
export default function MultiplierBadge({ row, detail = false, className }: Props) {
  const t = useT();
  const word = useMultiplierWord();
  const m = multiplierOf(row);

  // A meal at the normal rate shows nothing at all. Nearly every row is one, and a badge on each
  // would make the exception invisible by surrounding it with its own decoration.
  if (m === 1) return null;

  const note = String(row?.multiplier_note ?? '').trim();
  const by   = String(row?.multiplier_by_name ?? '').trim();
  const hint = [note, by ? t.foodChargeSetBy.replace('{name}', by) : '']
    .filter(Boolean).join(' — ');

  return (
    <span
      title={hint || undefined}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
        // Shape and weight, not hue: a charge above the normal rate is solid, a credit is
        // dashed and quiet. --success, --primary and --brand are all the same azure in this
        // system, so hue alone is never allowed to carry the difference.
        m > 1
          ? 'border border-warn-strong/60 bg-warn-strong/10 text-warn-strong'
          : 'border border-dashed border-border text-muted-foreground',
        className,
      )}
    >
      <span>{m}× {word(m)}</span>
      {detail && note && <span className="font-normal opacity-90">· {note}</span>}
    </span>
  );
}
