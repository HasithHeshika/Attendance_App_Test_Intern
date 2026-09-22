'use client';

import type { ReactNode } from 'react';
import { CheckCircle, Loader2, X, Calendar, Clock, AlertTriangle, UserCheck, Hand, RotateCcw } from 'lucide-react';
import { formatDate } from '@/lib/utils';
import { useT } from '@/store/appStore';
import { Button } from '@/components/ui/button';
import { IssueBadges } from '@/components/approvals/IssueIndicators';
import CallButton from '@/components/CallButton';
import type { ApprovalIssue } from '@/lib/approvalIssues';

/**
 * Unified Command Hero Header at the top of the detail pane.
 * Houses all employee context, badges, and the single authoritative decision cluster,
 * completely eliminating duplicate cards and buttons below it.
 */
export default function ApprovalsDetailHeader({
  name,
  epf,
  date,
  phone,
  role,
  workingPlace,
  siteNo,
  isShiftWorker,
  isOutstation,
  pickedByName,
  pickedAt,
  issues = [],
  onApprove,
  onReject,
  approving = false,
  busy = false,
  approveLabel,
  onPick,
  pickBusy = false,
  pickLabel,
  onRelease,
  releaseBusy = false,
  onEndShift,
  endShiftBusy = false,
  extraBadges,
}: {
  name: string;
  epf?: string;
  /** 'YYYY-MM-DD' — omitted when the record carries no date. */
  date?: string;
  phone?: string | null;
  role?: string;
  workingPlace?: string;
  siteNo?: string;
  isShiftWorker?: boolean;
  isOutstation?: boolean;
  pickedByName?: string | null;
  pickedAt?: string | null;
  issues?: ApprovalIssue[];
  /** Omitted when the viewer may not approve this record (pick-only team leaders). */
  onApprove?: () => void;
  onReject?: () => void;
  approving?: boolean;
  busy?: boolean;
  approveLabel?: string;
  onPick?: () => void;
  pickBusy?: boolean;
  pickLabel?: string;
  onRelease?: () => void;
  releaseBusy?: boolean;
  onEndShift?: () => void;
  endShiftBusy?: boolean;
  extraBadges?: ReactNode;
}) {
  const t = useT();

  return (
    <div className="z-10 -mx-1 mb-3 rounded-xl border border-border/80 bg-card/90 p-3.5 shadow-sm backdrop-blur-md transition-all lg:sticky lg:top-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Left: Identity & Badges */}
        <div className="flex min-w-0 items-start gap-3">
          <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 via-primary/10 to-primary/5 text-base font-bold text-primary shadow-inner ring-1 ring-primary/20">
            {name?.charAt(0) ?? '?'}
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold tracking-tight text-foreground">{name}</h2>
              {role && (
                <span className="rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {role}
                </span>
              )}
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
              {epf && <span className="font-mono text-[11px]">EPF: {epf}</span>}
              {date && (
                <span className="inline-flex items-center gap-1 text-[11px]">
                  <Calendar className="h-3 w-3 text-muted-foreground" aria-hidden /> {formatDate(date)}
                </span>
              )}
            </div>

            {/* Context Badges */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {workingPlace && (
                <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/50 px-2 py-0.5 text-[10px] font-medium text-foreground">
                  {workingPlace} {siteNo ? `· ${siteNo}` : ''}
                </span>
              )}
              {isShiftWorker && (
                <span className="inline-flex items-center gap-1 rounded-md border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                  <Clock className="h-2.5 w-2.5" /> Shift
                </span>
              )}
              {isOutstation && (
                <span className="inline-flex items-center gap-1 rounded-md border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning">
                  <AlertTriangle className="h-2.5 w-2.5" /> Outstation
                </span>
              )}
              {pickedByName && (
                <span className="inline-flex items-center gap-1 rounded-md border border-brand/25 bg-brand/10 px-2 py-0.5 text-[10px] font-semibold text-brand">
                  <UserCheck className="h-2.5 w-2.5" /> Picked: {pickedByName}
                </span>
              )}
              <IssueBadges issues={issues} />
              {extraBadges}
            </div>
          </div>
        </div>

        {/* Right: Authoritative Action Cluster */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {phone && <CallButton phone={phone} name={name} />}

          {onEndShift && isShiftWorker && (
            <Button
              variant="outline"
              size="sm"
              onClick={onEndShift}
              disabled={endShiftBusy || busy}
              title="End shift worker's shift"
              className="hover:border-warning hover:text-warning"
            >
              {endShiftBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{t.endShift}</span>
            </Button>
          )}

          {onRelease && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRelease}
              disabled={releaseBusy || busy}
              className="hover:border-destructive hover:text-destructive"
            >
              {releaseBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              <span>Release</span>
            </Button>
          )}

          {onPick && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onPick}
              disabled={pickBusy || busy}
              className="border border-primary/20 bg-primary/10 text-primary hover:bg-primary/20"
            >
              {pickBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Hand className="h-3.5 w-3.5" />}
              <span>{pickLabel ?? (t.pickToTeam ?? 'Pick to team')}</span>
            </Button>
          )}

          {onReject && (
            <Button variant="outline" size="sm" onClick={onReject} disabled={busy}>
              <X className="h-3.5 w-3.5" />
              <span>{t.rejectVerb}</span>
            </Button>
          )}

          {onApprove && (
            <Button
              variant="success"
              size="sm"
              onClick={onApprove}
              disabled={busy || approving}
              className="shadow-sm shadow-success/20"
            >
              {approving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
              <span>{approveLabel ?? t.approveVerb}</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

