'use client';

import { Calendar } from 'lucide-react';
import { formatDate, formatTime } from '@/lib/utils';
import { getRecordIssues, type ApprovalIssue } from '@/lib/approvalIssues';
import { IssueBadges } from '@/components/approvals/IssueIndicators';

interface ApprovalListRowRecord {
  name?: string;
  epf_number?: string;
  time?: string | null;
  [k: string]: any;
}

export default function ApprovalListRow({
  record,
  selected,
  issues,
  meta,
}: {
  record: ApprovalListRowRecord;
  selected: boolean;
  issues?: ApprovalIssue[];
  meta?: string;
}) {
  const listType = record.type as ('check_in' | 'check_out' | 'both' | undefined);
  const shownIssues = issues ?? getRecordIssues(record as any);

  return (
    <div
      className={`relative rounded-xl border p-3 text-sm transition-all duration-150 ${
        selected
          ? 'border-l-4 border-l-primary border-t-primary/30 border-r-primary/30 border-b-primary/30 bg-primary/[0.06] shadow-xs'
          : 'border-border bg-card/80 hover:bg-muted/40 hover:border-border/80'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Initial avatar */}
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold transition-colors ${
            selected ? 'bg-primary text-primary-foreground shadow-xs' : 'bg-primary/10 text-primary'
          }`}
        >
          {record.name?.charAt(0) ?? '?'}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="truncate font-semibold text-foreground">{record.name}</div>
            {/* Time badge(s) */}
            {listType === 'both' ? (
              <div className="flex flex-col items-end gap-0.5 shrink-0">
                <span className="font-mono text-[11px] font-semibold text-success whitespace-nowrap">
                  In: {record.time ? formatTime(record.time) : '--:--'}
                </span>
                <span className="font-mono text-[11px] font-semibold text-primary whitespace-nowrap">
                  Out: {record.check_out_time ? formatTime(record.check_out_time) : '--:--'}
                </span>
              </div>
            ) : record.time ? (
              <span className="font-mono text-xs font-bold text-muted-foreground whitespace-nowrap shrink-0">
                {formatTime(record.time)}
              </span>
            ) : null}
          </div>

          <div className="mt-1 flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
            {record.epf_number && <span className="font-mono text-[11px]">EPF: {record.epf_number}</span>}
            {record.date && (
              <span className="inline-flex items-center gap-1 text-[10px]">
                <Calendar className="w-2.5 h-2.5 text-muted-foreground" /> {formatDate(record.date)}
              </span>
            )}
            {listType && listType !== 'both' && (
              <span className="text-[10px] font-medium text-foreground/80">
                {listType === 'check_in' ? 'Check-in' : 'Check-out'}
              </span>
            )}
            {meta && <span className="text-[10px] font-semibold uppercase tracking-wide text-warning">{meta}</span>}
          </div>

          {shownIssues.length > 0 && (
            <div className="mt-1.5">
              <IssueBadges issues={shownIssues} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

