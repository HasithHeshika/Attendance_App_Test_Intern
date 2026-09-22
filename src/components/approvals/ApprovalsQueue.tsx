'use client';

import type { ReactNode } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle, Loader2 } from 'lucide-react';
import { formatDate } from '@/lib/utils';
import { getRecordIssues, type ApprovalIssue } from '@/lib/approvalIssues';
import { useT } from '@/store/appStore';
import { Button } from '@/components/ui/button';
import ApprovalsMasterDetail from '@/components/approvals/ApprovalsMasterDetail';
import ApprovalListRow from '@/components/approvals/ApprovalListRow';

/** One row of the single prioritised queue. `live` rows come from the realtime pending lists
 *  (today's and earlier-dated sessions); `past` rows are back-dated / stranded submissions. */
export interface QueueItem {
  id: number;
  kind: 'live' | 'past';
  name: string;
  epf: string;
  /** 'YYYY-MM-DD'. Empty when the record carries no date — those are treated as today. */
  date: string;
  issues: ApprovalIssue[];
  /** Which separator the row renders under: 'problems', or the day it belongs to. */
  bucket: string;
  record: any;
}

export const PROBLEMS_BUCKET = 'problems';

/**
 * Build the queue: one list, sorted (a) records with issues, (b) oldest day first, (c) name.
 * Pure — the page owns the data, this owns the order, and the order is stated on screen so it
 * is never a mystery.
 *
 * Issues are derived for live records only. A back-dated record's mapped shape carries no GPS
 * columns at all, so deriving issues there would mark the whole backlog "no GPS recorded" —
 * a statement about the fetch, not about the day's work.
 */
export function buildApprovalQueue({
  live,
  past,
  todayStr,
  problemsFirst,
}: {
  live: any[];
  past: any[];
  todayStr: string;
  problemsFirst: boolean;
}): QueueItem[] {
  const items: QueueItem[] = [
    ...live.map((r): QueueItem => ({
      id: r.attendance_id ?? r.id,
      kind: 'live',
      name: String(r.name ?? ''),
      epf: String(r.epf_number ?? ''),
      date: String(r.date ?? ''),
      issues: getRecordIssues(r),
      bucket: '',
      record: r,
    })),
    ...past.map((r): QueueItem => ({
      id: r.id,
      kind: 'past',
      name: String(r.name ?? ''),
      epf: String(r.epf_number ?? ''),
      date: String(r.date ?? ''),
      issues: [],
      bucket: '',
      record: r,
    })),
  ];

  const dayOf = (it: QueueItem) => it.date || todayStr;
  const problem = (it: QueueItem) => problemsFirst && it.issues.length > 0;

  items.sort((a, b) => {
    const pa = problem(a) ? 0 : 1;
    const pb = problem(b) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const da = dayOf(a);
    const db = dayOf(b);
    if (da !== db) return da < db ? -1 : 1;   // oldest first
    return a.name.localeCompare(b.name);
  });

  for (const it of items) it.bucket = problem(it) ? PROBLEMS_BUCKET : dayOf(it);
  return items;
}

/** Adapts a back-dated record into the shape the shared list row reads. */
function pastRowRecord(r: any) {
  return { ...r, type: 'both', time: r.check_in_time, check_out_time: r.check_out_time };
}

export default function ApprovalsQueue({
  items,
  todayStr,
  selectedId,
  onSelect,
  isChecked,
  onToggleCheck,
  renderDetail,
  onApproveDay,
  approvingDayKey,
  teamGroup,
  emptyState,
  boundHeight,
}: {
  items: QueueItem[];
  todayStr: string;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  isChecked: (item: QueueItem) => boolean;
  onToggleCheck: (item: QueueItem) => void;
  renderDetail: (item: QueueItem) => ReactNode;
  /** Omitted when the viewer may not bulk-approve this tab — then day rows carry no action. */
  onApproveDay?: (ids: number[]) => void;
  /** Bucket key whose "Approve this day" is mid-flight. */
  approvingDayKey?: string | null;
  /** Team (leader + their picked technicians) sub-grouping inside each day separator. */
  teamGroup?: { keyOf: (item: QueueItem) => string | null; renderHeader: (key: string, groupItems: QueueItem[]) => ReactNode };
  emptyState?: ReactNode;
  boundHeight?: boolean;
}) {
  const t = useT();

  const dayHeader = (key: string, groupItems: QueueItem[]) => {
    if (key === PROBLEMS_BUCKET) {
      return (
        <div className="mt-1 flex items-center gap-2 rounded-lg border border-destructive/25 bg-destructive/[0.07] px-3 py-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 text-destructive" aria-hidden />
          {/* English fallback — no translation key exists for the problems separator. */}
          <span className="text-sm font-semibold text-foreground">Problems</span>
          <span className="whitespace-nowrap text-[11px] text-muted-foreground">· {groupItems.length}</span>
        </div>
      );
    }
    const isToday = key === todayStr;
    const ids = groupItems.map(it => it.id);
    const busy = approvingDayKey === key;
    return (
      <div className={`mt-1 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 ${
        isToday ? 'border-border bg-muted/50' : 'border-warning/25 bg-warning/[0.07]'
      }`}>
        <div className="flex min-w-0 items-center gap-2">
          <CalendarDays className={`h-4 w-4 flex-shrink-0 ${isToday ? 'text-muted-foreground' : 'text-warning'}`} aria-hidden />
          <span className="truncate text-sm font-semibold text-foreground">
            {isToday ? t.todayWord : formatDate(key)}
          </span>
          <span className="whitespace-nowrap text-[11px] text-muted-foreground">· {groupItems.length}</span>
        </div>
        {onApproveDay && (
          <Button
            variant="success" size="sm" className="flex-shrink-0"
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); onApproveDay(ids); }}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
            {/* English fallback — no translation key exists for the per-day bulk action. */}
            <span className="hidden sm:inline">Approve this day</span>
            <span className="sm:hidden">{t.approveVerb}</span>
          </Button>
        )}
      </div>
    );
  };

  return (
    <ApprovalsMasterDetail
      boundHeight={boundHeight}
      items={items}
      getId={(it) => it.id}
      selectedId={selectedId}
      onSelect={(id) => onSelect(id as number | null)}
      bulk={{ isChecked, onToggle: onToggleCheck }}
      group={{
        keyOf: (it) => it.bucket,
        renderHeader: dayHeader,
        ...(teamGroup ? { subKeyOf: teamGroup.keyOf, renderSubHeader: teamGroup.renderHeader } : {}),
      }}
      renderRow={(it, sel) => (
        it.kind === 'past'
          // English fallback — "Backlog" has no translation key; it marks a back-dated row.
          ? <ApprovalListRow record={pastRowRecord(it.record)} selected={sel} issues={it.issues} meta="Backlog" />
          : <ApprovalListRow record={it.record} selected={sel} issues={it.issues} />
      )}
      renderDetail={renderDetail}
      emptyState={emptyState}
    />
  );
}
