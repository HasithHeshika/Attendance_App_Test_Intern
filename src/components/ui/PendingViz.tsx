'use client';
import { memo } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useT } from '@/store/appStore';

const fmt = (n: number) => (n % 1 === 0 ? String(n) : n.toFixed(1));

/**
 * Card 4 trailing — adaptive. Pending leaves → amber full/half breakdown. Otherwise
 * the good state still carries data: an upcoming-holiday countdown when one is within
 * the week, else an "all clear" with how much leave has been used this year.
 */
function PendingVizBase({
  hasPending, pendingFull, pendingHalf, holiday, usedDays,
}: {
  hasPending: boolean;
  pendingFull: number;
  pendingHalf: number;
  holiday: { name: string; day: string; daysUntil: number } | null;
  usedDays: number;
}) {
  const t = useT();

  if (hasPending) {
    return (
      <div className="flex items-center gap-2 text-warning">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-warning/10">
          <AlertCircle className="h-3.5 w-3.5" />
        </span>
        <span className="text-xs font-medium text-muted-foreground">
          <span className="font-semibold text-foreground tabular-nums">{pendingFull}</span> {t.fullLabel}
          <span className="mx-1 text-muted-foreground/50">·</span>
          <span className="font-semibold text-foreground tabular-nums">{pendingHalf}</span> {t.halfLabel}
        </span>
      </div>
    );
  }

  if (holiday) {
    const soon = holiday.daysUntil <= 0;
    return (
      <div className="flex items-center gap-2 w-full rounded-lg border border-primary/10 bg-primary/5 p-2 text-left">
        <div className="flex flex-col items-center justify-center rounded-md bg-primary/10 px-1.5 py-1 leading-none text-primary">
          <span className="text-sm font-bold tabular-nums">{soon ? '•' : holiday.daysUntil}</span>
          <span className="text-[7px] font-semibold uppercase tracking-wide">{soon ? t.todayWord : t.daysUnit}</span>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-primary">
            <span className="flex h-1.5 w-1.5 rounded-full bg-primary animate-pulse motion-reduce:animate-none" />
            <span>{t.holidayWord}</span>
          </div>
          <div className="line-clamp-1 text-[11px] font-semibold leading-tight text-foreground">{holiday.name}</div>
          <div className="text-[10px] font-medium text-muted-foreground">{holiday.day}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-success">
      <CheckCircle2 className="h-4 w-4 shrink-0" />
      <div className="leading-tight">
        <div className="text-xs font-medium">{t.allClear}</div>
        {usedDays > 0 && (
          <div className="text-[10px] text-muted-foreground">
            {t.leaveUsedYearTemplate.replace('{n}', fmt(usedDays))}
          </div>
        )}
      </div>
    </div>
  );
}

// Memoised — pending/holiday data is static across the dashboard's 30s live-clock tick.
const PendingViz = memo(PendingVizBase);
export default PendingViz;
