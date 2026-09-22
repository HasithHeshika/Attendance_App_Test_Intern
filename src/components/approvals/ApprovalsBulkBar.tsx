'use client';

import { CheckCircle, Loader2, X, Zap } from 'lucide-react';
import { useT } from '@/store/appStore';
import { Button } from '@/components/ui/button';

/**
 * Bulk actions for whatever is currently ticked. Pinned to the bottom of the queue pane on a
 * laptop and to the bottom of the viewport on a phone, so an approver standing on site never
 * has to scroll back up to a toolbar to act on a selection made at the bottom of the list.
 * Renders nothing when nothing is selected.
 */
export default function ApprovalsBulkBar({
  count,
  onApprove,
  onReject,
  onClear,
  approving = false,
  rejecting = false,
  busy = false,
  canReject = true,
  force = false,
  onToggleForce,
}: {
  count: number;
  onApprove: () => void;
  /** Omitted when this tab has no reject path (edit requests approve in bulk only). */
  onReject?: () => void;
  onClear: () => void;
  approving?: boolean;
  rejecting?: boolean;
  /** Any action in flight anywhere on the page — disables both buttons. */
  busy?: boolean;
  canReject?: boolean;
  force?: boolean;
  onToggleForce?: (val: boolean) => void;
}) {
  const t = useT();
  if (count === 0) return null;

  return (
    <div
      className={
        'fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 px-4 py-3 shadow-lg backdrop-blur ' +
        'pb-[max(0.75rem,env(safe-area-inset-bottom))] ' +
        'lg:sticky lg:inset-x-auto lg:bottom-2 lg:z-20 lg:rounded-xl lg:border lg:px-3.5 lg:py-2.5 lg:pb-2.5'
      }
      role="region"
      aria-label={t.selectedCount.replace('{n}', String(count))}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-xs font-semibold text-foreground tabular-nums flex items-center gap-1.5">
          <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse" />
          <span>{count} selected in queue</span>
        </span>

        {onToggleForce && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer select-none px-2 py-1 rounded-lg border border-border/60 bg-muted/40">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => onToggleForce(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border text-primary focus:ring-primary"
            />
            <span className="flex items-center gap-1 text-[11px] font-medium">
              <Zap className={`h-3 w-3 ${force ? 'text-amber-500 fill-amber-500' : 'text-muted-foreground'}`} />
              Force missing details
            </span>
          </label>
        )}

        <Button variant="ghost" size="sm" onClick={onClear} className="h-8 text-xs">{t.clearAll}</Button>
        {onReject && canReject && (
          <Button variant="destructive" size="sm" onClick={onReject} disabled={busy} className="h-8 text-xs">
            {rejecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
            {t.rejectVerb}
          </Button>
        )}
        <Button
          variant={force ? 'default' : 'success'}
          size="sm"
          onClick={onApprove}
          disabled={busy}
          className={`h-8 text-xs shadow-sm ${force ? 'bg-amber-500 text-white hover:bg-amber-600 border-amber-600' : 'shadow-success/20'}`}
        >
          {approving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : force ? (
            <Zap className="h-3.5 w-3.5 fill-current" />
          ) : (
            <CheckCircle className="h-3.5 w-3.5" />
          )}
          {force ? 'Force Approve' : t.approveVerb} ({count})
        </Button>
      </div>
    </div>
  );
}
