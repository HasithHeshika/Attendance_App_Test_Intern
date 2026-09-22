'use client';
import { Receipt } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/store/appStore';
import { formatSuspenseAmount } from '@/services/suspenseService';
import type { CostSplit } from '@/lib/foodCost';

interface Props {
  /** One chamary's month, split. `null` while the bills are still being read. */
  split: CostSplit | null;
  /** How many bills the total came from — the only way to tell "none filed yet" from "they
   *  came to nothing". A month with no bills must not print a confident LKR 0.00 per share. */
  billsCount: number;
  /** The month is still running, so BOTH halves of the division are still growing. */
  provisional: boolean;
  /** More than one chamary in scope. Says why there is no figure instead of showing nothing. */
  oneChamary: boolean;
}

// The kitchen's month, reconciled against the bills it filed.
//
// This block exists to make the arithmetic checkable by the person who answers for it: bills in,
// shares out, price per share, what that charged, and — on its own line — the rounding nobody
// was made to absorb. Three hundred people rounded independently will not sum to the bill total
// to the cent, and forcing that difference onto somebody to make a total look tidy is exactly
// the kind of quiet, unexplainable charge this page exists to prevent. See splitFoodCost.
export default function ChamaryCostBlock({ split, billsCount, provisional, oneChamary }: Props) {
  const t = useT();

  // A share price across two canteens is not a price — each kitchen files its own bills and
  // serves its own food. Say that rather than averaging them into a number nobody can act on.
  if (!oneChamary) {
    return (
      <p className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
        {t.chamaryCostOneOnly}
      </p>
    );
  }
  if (!split) return null;

  const figures: Array<{ label: string; value: string; strong?: boolean }> = [
    { label: t.chamaryCostBills,       value: formatSuspenseAmount(split.billsTotal), strong: true },
    { label: t.chamaryCostShares,      value: String(split.weightedShares) },
    { label: t.chamaryCostSharePrice,  value: formatSuspenseAmount(split.sharePrice), strong: true },
    { label: t.chamaryCostCharged,     value: formatSuspenseAmount(split.chargedTotal) },
    { label: t.chamaryCostUnallocated, value: formatSuspenseAmount(split.unallocated) },
  ];

  return (
    <div className="rounded-xl border border-border bg-card/40 p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-border/40 pb-2.5">
        <Receipt className="h-4 w-4 text-primary" aria-hidden />
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          {t.chamaryCostTitle}
        </span>
        {/* Provisional is not decoration — it is the difference between a figure somebody can
            budget against and one that is still moving. Carried by a word and a dashed border,
            never by hue: --success, --primary and --brand are all the same azure here. */}
        {provisional && (
          <span className="rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t.foodProvisionalWord}
          </span>
        )}
      </div>

      {billsCount === 0 ? (
        <p className="text-xs text-muted-foreground">{t.chamaryCostNoBills}</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3 lg:grid-cols-5">
            {figures.map(f => (
              <div key={f.label}>
                <dt className="text-[11px] leading-tight text-muted-foreground">{f.label}</dt>
                <dd className={cn(
                  'mt-0.5 text-sm tabular-nums text-foreground',
                  f.strong ? 'font-bold' : 'font-medium',
                )}>
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
          {provisional && (
            <p className="mt-3 border-t border-border/40 pt-2.5 text-[11px] text-muted-foreground">
              {t.chamaryCostProvisionalHint}
            </p>
          )}
        </>
      )}
    </div>
  );
}
