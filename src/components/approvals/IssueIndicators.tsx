'use client';

import { AlertTriangle, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/store/appStore';
import type { ApprovalIssue } from '@/lib/approvalIssues';

function useIssueLabel() {
  const t = useT();
  return (issue: ApprovalIssue): string => {
    switch (issue.kind) {
      case 'outsideRadius':
        return t.apIssueOutside;
      case 'outstation':
        return t.apIssueOutstation + (issue.distanceKm != null ? ` · ${issue.distanceKm} km` : '');
      case 'missingGps':
        return t.apIssueMissingGps;
    }
  };
}

const worstSeverity = (issues: ApprovalIssue[]): ApprovalIssue['severity'] =>
  issues.some(i => i.severity === 'error') ? 'error' : 'warn';

/** Compact inline pills for a list row — one per issue. */
export function IssueBadges({ issues }: { issues: ApprovalIssue[] }) {
  const label = useIssueLabel();
  if (issues.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {issues.map((issue, i) => (
        <span
          key={`${issue.kind}-${i}`}
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
            issue.severity === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-warning/10 text-warning'
          )}
        >
          <AlertTriangle className="w-2.5 h-2.5 flex-shrink-0" />
          {label(issue)}
        </span>
      ))}
    </div>
  );
}

/** Prominent bordered banner for a detail pane — one row per issue, tinted by worst severity. */
export function IssueBanner({ issues }: { issues: ApprovalIssue[] }) {
  const label = useIssueLabel();
  if (issues.length === 0) return null;

  const severity = worstSeverity(issues);
  const isError = severity === 'error';

  return (
    <div
      className={cn(
        'rounded-xl border p-3.5 space-y-2 shadow-xs transition-all',
        isError
          ? 'border-destructive/35 bg-gradient-to-r from-destructive/15 via-destructive/10 to-destructive/5 text-destructive'
          : 'border-warning/35 bg-gradient-to-r from-warning/15 via-warning/10 to-warning/5 text-warning'
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider opacity-85">
        <AlertTriangle className="h-3 w-3" />
        <span>Review Notice · Discrepancy Detected</span>
      </div>
      <div className="space-y-1.5">
        {issues.map((issue, i) => {
          const Icon = issue.kind === 'missingGps' ? MapPin : AlertTriangle;
          return (
            <div key={`${issue.kind}-${i}`} className="flex items-center gap-2.5 text-xs font-semibold text-foreground">
              <span className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                isError ? 'bg-destructive/15 text-destructive' : 'bg-warning/15 text-warning'
              )}>
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span>{label(issue)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
