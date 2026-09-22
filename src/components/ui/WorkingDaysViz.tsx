'use client';
import { memo } from 'react';
import { Clock, BarChart3 } from 'lucide-react';
import WeekStrip from '@/components/ui/WeekStrip';
import { useT, useAppStore } from '@/store/appStore';

/**
 * Card 2 trailing — the week strip plus a compact derived-stats row (total hours,
 * average hours/day this month). `usesShift` users (self-recording approvers, i.e. the
 * same group whose hours are metered against an 8h shift) get the overtime-red treatment
 * on the strip (>8h days) and per-day hour labels; everyone else stays blue, no labels.
 */
function WorkingDaysVizBase({
  workedDates, workedHours, usesShift,
}: {
  workedDates: Set<string>;
  workedHours: Record<string, number>;
  usesShift: boolean;
}) {
  const t = useT();
  const lang = useAppStore(s => s.lang);

  const totalHours = Object.values(workedHours).reduce((a, b) => a + b, 0);
  const dayCount = Object.keys(workedHours).filter(k => workedHours[k] > 0).length || workedDates.size;
  const avg = dayCount > 0 ? totalHours / dayCount : 0;

  return (
    <div className="space-y-2.5">
      <WeekStrip
        workedDates={workedDates}
        workedHours={workedHours}
        locale={lang}
        hideHoursText={!usesShift}
        overtimeHours={usesShift ? 8 : null}
      />
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Clock className="h-3 w-3 text-primary" />
          {t.totalLabel}{' '}
          <span className="font-mono font-semibold text-foreground tabular-nums">{totalHours.toFixed(1)}{t.hShort}</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <BarChart3 className="h-3 w-3 text-primary" />
          {t.avgLabel}{' '}
          <span className="font-mono font-semibold text-foreground tabular-nums">{avg.toFixed(1)}{t.hShort}</span>
        </span>
      </div>
    </div>
  );
}

// Memoised: the dashboard re-renders every 30s for the live clock; this card only needs
// to re-render when its month data actually changes.
const WorkingDaysViz = memo(WorkingDaysVizBase);
export default WorkingDaysViz;
