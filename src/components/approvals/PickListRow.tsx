'use client';

import { Hand, Loader2, RotateCcw } from 'lucide-react';
import { getRecordIssues } from '@/lib/approvalIssues';
import { IssueBadges } from '@/components/approvals/IssueIndicators';
import { Button } from '@/components/ui/button';

interface PickListRowRecord {
  name?: string;
  role?: string;
  epf_number?: string;
  check_in_lat?: number | null;
  check_in_lng?: number | null;
  [k: string]: any;
}

export default function PickListRow({
  row,
  selected,
  onPick,
  pickBusy = false,
  onRelease,
  releaseBusy = false,
  members,
}: {
  row: PickListRowRecord;
  selected: boolean;
  /** Pick action shown inline on the row. Stops row-click (which opens the detail). */
  onPick?: () => void;
  pickBusy?: boolean;
  /** Release action shown inline on the row (My team). Stops row-click. */
  onRelease?: () => void;
  releaseBusy?: boolean;
  /** Team members already picked by this row (a team leader) — shown nested for context. */
  members?: Array<{ name?: string; role?: string; epf_number?: string }>;
}) {
  return (
    <div
      className={`rounded-lg border p-3 text-sm transition-colors ${
        selected ? 'ring-1 ring-primary/40 bg-accent/40 border-primary/30' : 'border-border bg-card hover:bg-accent/20'
      }`}
    >
      <div className="flex items-center gap-3">
        {/* Initial avatar */}
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary font-bold text-xs flex-shrink-0">
          {row.name?.charAt(0) ?? '?'}
        </div>

        <div className="flex-1 min-w-0">
          <span className="font-semibold text-foreground truncate block">{row.name}</span>

          <div className="mt-0.5 flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
            <span>{row.role} · {row.epf_number}</span>
          </div>

          <div className="mt-1.5">
            <IssueBadges issues={getRecordIssues(row as any)} />
          </div>
        </div>

        {onPick && (
          <Button
            variant="success" size="sm"
            className="flex-shrink-0"
            disabled={pickBusy}
            title="Pick onto your team"
            onClick={(e) => { e.stopPropagation(); onPick(); }}
          >
            {pickBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Hand className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">Pick to Team</span>
          </Button>
        )}

        {onRelease && (
          <Button
            variant="outline" size="sm"
            className="flex-shrink-0 hover:text-destructive hover:border-destructive"
            disabled={releaseBusy}
            title="Release this technician so someone else can pick them"
            onClick={(e) => { e.stopPropagation(); onRelease(); }}
          >
            {releaseBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">Release</span>
          </Button>
        )}
      </div>

      {/* Team members already picked by this leader — read-only context; Pick to Team claims them all. */}
      {members && members.length > 0 && (
        <div className="mt-2 ml-11 space-y-1 border-l-2 border-primary/20 pl-3">
          {members.map((m, i) => (
            <div key={m.epf_number ?? i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-1 w-1 rounded-full bg-primary/50 flex-shrink-0" />
              <span className="truncate">{m.name}</span>
              {m.role && <span className="text-[10px] whitespace-nowrap">· {m.role}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
