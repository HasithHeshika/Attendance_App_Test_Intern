'use client';

import { useState } from 'react';
import { History, Loader2, CheckCircle, Zap, ShieldAlert } from 'lucide-react';
import { formatDate } from '@/lib/utils';
import { useT } from '@/store/appStore';
import { Button } from '@/components/ui/button';

/**
 * The backlog, said out loud. The past/backlog query is date-bounded (Firestore cannot filter
 * on a nested session status), so anything left pending before the window start is reachable
 * only by widening it here — otherwise it stays 'pending' forever and nobody ever sees it.
 */
export default function ApprovalsBacklogCard({
  count,
  oldestDate,
  windowCaption,
  maxCaption,
  onLoadOlder,
  loadingOlder = false,
  onApproveAll,
  approveAllBusy = false,
  progress,
  force: controlledForce,
  onToggleForce,
}: {
  count: number;
  /** 'YYYY-MM-DD' of the oldest pending day currently loaded. */
  oldestDate: string;
  /** "Pending past attendance shown from …" — already interpolated by the page. */
  windowCaption: string;
  /** Shown instead of the widen control once the window is at its maximum. */
  maxCaption?: string;
  /** Omitted once the window cannot widen any further. */
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  /** Omitted when the viewer may not bulk-approve this tab. */
  onApproveAll?: (force: boolean) => void;
  approveAllBusy?: boolean;
  /** Live progress while the batches run, e.g. "40 of 120". */
  progress?: string | null;
  /** Controlled force state */
  force?: boolean;
  onToggleForce?: (val: boolean) => void;
}) {
  const t = useT();
  const [internalForce, setInternalForce] = useState(false);
  const isForce = controlledForce !== undefined ? controlledForce : internalForce;
  const setForce = (val: boolean) => {
    if (onToggleForce) onToggleForce(val);
    else setInternalForce(val);
  };

  // Nothing waiting — but the widen control must survive. The backlog query is date-bounded,
  // so a record stranded before the window start is invisible until someone widens it; hiding
  // the control with the count would make that permanent.
  if (count === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <span>{windowCaption}</span>
        {onLoadOlder ? (
          <button
            type="button"
            onClick={onLoadOlder}
            disabled={loadingOlder}
            aria-busy={loadingOlder}
            className="inline-flex items-center gap-1 font-semibold text-primary hover:underline disabled:cursor-wait disabled:opacity-60"
          >
            {loadingOlder && <Loader2 className="h-3 w-3 animate-spin" />}
            {loadingOlder ? t.loading : t.loadOlderPending}
          </button>
        ) : maxCaption ? (
          <span>{maxCaption}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-x-4 gap-y-3 rounded-xl border border-warning/30 bg-warning/[0.06] p-3 shadow-xs transition-all">
      <div className="flex items-start gap-3 min-w-[14rem] flex-1">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-warning/15 text-warning ring-1 ring-warning/30">
          <History className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 space-y-1">
          <div className="text-xs font-semibold text-foreground flex items-center gap-1.5 flex-wrap">
            <span>{count} prior month records waiting</span>
            {oldestDate ? <span className="font-normal text-muted-foreground text-[11px]">· oldest from {formatDate(oldestDate)}</span> : null}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {progress ? `Approving… ${progress}` : `${windowCaption} (Prior months only)`}
          </div>
          {isForce && (
            <div className="flex items-center gap-1 text-[10px] text-amber-500 font-medium">
              <ShieldAlert className="h-3 w-3 shrink-0" />
              <span>Force active: auto-fills missing check-outs (17:00) &amp; sites so approvals never skip</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        {/* Force approve checkbox toggle */}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer select-none px-2 py-1 rounded-lg border border-border/60 bg-background/60">
          <input
            type="checkbox"
            checked={isForce}
            onChange={(e) => setForce(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-border text-warning focus:ring-warning"
          />
          <span className="flex items-center gap-1 text-[11px] font-medium">
            <Zap className={`h-3 w-3 ${isForce ? 'text-amber-500 fill-amber-500' : 'text-muted-foreground'}`} />
            Force missing details
          </span>
        </label>

        {onLoadOlder ? (
          <Button variant="outline" size="sm" onClick={onLoadOlder} disabled={loadingOlder} aria-busy={loadingOlder} className="h-8 text-xs">
            {loadingOlder && <Loader2 className="h-3 w-3 animate-spin" />}
            {loadingOlder ? t.loading : t.loadOlderPending}
          </Button>
        ) : maxCaption ? (
          <span className="text-[11px] text-muted-foreground">{maxCaption}</span>
        ) : null}

        {onApproveAll && (
          <Button
            variant={isForce ? 'default' : 'outline'}
            size="sm"
            onClick={() => onApproveAll(isForce)}
            disabled={approveAllBusy}
            className={`h-8 text-xs font-semibold shadow-xs transition-all ${
              isForce
                ? 'bg-amber-500 text-white hover:bg-amber-600 border-amber-600'
                : 'border-warning/40 bg-warning/10 text-warning hover:bg-warning/20'
            }`}
          >
            {approveAllBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : isForce ? (
              <Zap className="h-3.5 w-3.5 fill-current" />
            ) : (
              <CheckCircle className="h-3.5 w-3.5" />
            )}
            <span>{isForce ? 'Force Approve Prior Months' : 'Approve Prior Months'} ({count})</span>
          </Button>
        )}
      </div>
    </div>
  );
}
