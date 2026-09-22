'use client';
import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CalendarClock, Check, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { cn, formatDate, localDateString } from '@/lib/utils';
import { useT } from '@/store/appStore';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

// One pending team request whose dates are already behind us.
export interface PassedRequest {
  leave_id:        string | number;
  epf_number?:     string;
  employee_name?:  string;
  leave_type_name?: string;
  from_date:       string;
  to_date:         string;
  reason?:         string;
}

// Whole days between the last day of the leave and today.
function daysSince(to: string, today: string): number {
  const a = new Date(to.slice(0, 10) + 'T00:00:00').getTime();
  const b = new Date(today + 'T00:00:00').getTime();
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

const errText = (err: unknown): string =>
  (err as { response?: { data?: { message?: string } } })?.response?.data?.message
  ?? (err as { message?: string })?.message
  ?? 'Failed';

type RowResult = { ok: true } | { ok: false; error: string };

export default function PassedRequestsDialog({
  open, onOpenChange, requests, excludedOwn, onApprove, onFinished,
}: {
  open:         boolean;
  onOpenChange: (open: boolean) => void;
  /** Already narrowed to pending requests that have passed and are not the approver's own. */
  requests:     PassedRequest[];
  /** How many passed requests were dropped because they belong to the approver themselves. */
  excludedOwn:  number;
  /** Approve exactly one request. Rejects on failure; the loop below catches and carries on. */
  onApprove:    (leaveId: string | number, isPaid: boolean) => Promise<void>;
  /** Called once the whole run ends, so the page can reload its lists. */
  onFinished:   () => void;
}) {
  const t = useT();
  const today = localDateString();

  // The list is snapshotted when the dialog opens. Southern Lanka streams team requests live,
  // so a row approved mid-run would vanish from the incoming prop and take its tick with it —
  // the approver would watch the batch dissolve instead of seeing what happened to each row.
  const [rows,     setRows]     = useState<PassedRequest[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isPaid,   setIsPaid]   = useState(true);
  const [running,  setRunning]  = useState(false);
  const [done,     setDone]     = useState(0);
  const [results,  setResults]  = useState<Record<string, RowResult>>({});

  useEffect(() => {
    if (!open) return;
    setRows(requests);
    setSelected(new Set(requests.map(r => String(r.leave_id))));
    setIsPaid(true);
    setRunning(false);
    setDone(0);
    setResults({});
    // Deliberately keyed on `open` alone: re-snapshotting on every `requests` change would
    // reset the approver's ticks and selection under them while a run is in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedCount = useMemo(
    () => rows.filter(r => selected.has(String(r.leave_id))).length,
    [rows, selected],
  );
  const allSelected = rows.length > 0 && selectedCount === rows.length;

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const run = async () => {
    if (running) return;                                   // guard the double click
    const targets = rows.filter(r => selected.has(String(r.leave_id)));
    if (targets.length === 0) return;

    setRunning(true);
    setDone(0);
    setResults({});
    const collected: Record<string, RowResult> = {};
    const failedRows: PassedRequest[] = [];
    let approved = 0;

    // Strictly one at a time. Each call re-derives authorization server-side, and firing a
    // dozen at once would hammer the same reads for no gain.
    for (const r of targets) {
      const id = String(r.leave_id);
      try {
        await onApprove(r.leave_id, isPaid);
        collected[id] = { ok: true };
        approved += 1;
      } catch (err) {
        // One bad row must not cost the approver the rest of the batch.
        collected[id] = { ok: false, error: errText(err) };
        failedRows.push(r);
      }
      setResults({ ...collected });
      setDone(d => d + 1);
    }

    setRunning(false);
    onFinished();

    if (failedRows.length > 0) {
      // Leave the failures on screen with their reason so the approver can retry just those.
      toast.error(`${approved} approved · ${failedRows.length} failed`);
      setRows(failedRows);
      setSelected(new Set(failedRows.map(r => String(r.leave_id))));
    } else {
      toast.success(`${approved} approved`);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!running) onOpenChange(o); }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col gap-0 p-0">
        <DialogHeader className="flex-shrink-0 border-b border-border px-5 py-4 pr-14">
          {/* No translation key covers this backlog screen. */}
          <DialogTitle className="text-base">Requests that have already passed</DialogTitle>
          <DialogDescription className="text-xs">
            Their dates are in the past and they are still waiting on a decision.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {rows.length === 0 ? (
            <EmptyState icon={CalendarClock} title="Nothing left to review" />
          ) : (
            <>
              {/* Select all / none + live count */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  disabled={running}
                  onClick={() => setSelected(allSelected ? new Set() : new Set(rows.map(r => String(r.leave_id))))}
                  className="rounded-sm text-xs font-semibold text-primary underline-offset-4 hover:underline disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  {/* No translation key pairs select-all with its opposite. */}
                  {allSelected ? 'Select none' : t.selectAll}
                </button>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {selectedCount} of {rows.length} selected
                </span>
              </div>

              {/* Paid / Unpaid for the whole batch */}
              <div className="rounded-lg border border-border bg-muted/50 p-3">
                <div className="grid grid-cols-2 gap-2">
                  {[{ val: true, label: t.paidWord }, { val: false, label: t.unpaidWord }].map(opt => (
                    <button
                      key={opt.label}
                      type="button"
                      disabled={running}
                      aria-pressed={isPaid === opt.val}
                      onClick={() => setIsPaid(opt.val)}
                      className={cn(
                        'rounded-md border py-2 text-sm font-semibold transition-colors disabled:opacity-60',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                        isPaid === opt.val
                          ? (opt.val
                              ? 'border-success/40 bg-success/10 text-success'
                              : 'border-warning/40 bg-warning/10 text-warning')
                          : 'border-border bg-card text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {/* No translation key explains a batch-wide paid decision. */}
                  This applies to every request in the batch. To decide one differently, leave it
                  unticked and approve it on its own.
                </p>
              </div>

              {excludedOwn > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {/* No translation key covers the self-approval exclusion. */}
                  {excludedOwn} of your own {excludedOwn === 1 ? 'request was' : 'requests were'} left
                  out — you cannot approve your own leave.
                </p>
              )}

              {/* The rows */}
              <div className="space-y-2">
                {rows.map(r => {
                  const id  = String(r.leave_id);
                  const res = results[id];
                  const ago = daysSince(r.to_date, today);
                  const from = r.from_date.slice(0, 10);
                  const to   = r.to_date.slice(0, 10);
                  return (
                    <div
                      key={id}
                      className={cn(
                        'rounded-xl border p-3 transition-colors',
                        res && !res.ok ? 'border-destructive/40 bg-destructive/5' : 'border-border bg-card',
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <Checkbox
                          className="mt-0.5 flex-shrink-0"
                          checked={selected.has(id)}
                          disabled={running || (res?.ok === true)}
                          onCheckedChange={() => toggle(id)}
                          aria-label={`Include ${r.employee_name ?? r.epf_number ?? 'this request'} in the batch`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-sm font-semibold text-foreground">{r.employee_name ?? '—'}</span>
                            <span className="text-[11px] text-muted-foreground">EPF {r.epf_number ?? '—'}</span>
                            {r.leave_type_name && <Badge variant="muted">{r.leave_type_name}</Badge>}
                          </div>
                          <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                            {from === to ? formatDate(from) : `${formatDate(from)} → ${formatDate(to)}`}
                            {/* No translation key for "ended N days ago". */}
                            <span className="ml-1.5">
                              · {ago === 0 ? 'ended today' : ago === 1 ? 'ended yesterday' : `ended ${ago} days ago`}
                            </span>
                          </p>
                          {r.reason && (
                            <div className="mt-2 rounded-lg border border-border bg-muted/60 px-3 py-2">
                              <p className="text-xs leading-relaxed text-foreground">{r.reason}</p>
                            </div>
                          )}
                          {res && !res.ok && (
                            <p className="mt-2 flex items-start gap-1.5 text-[11px] text-destructive">
                              <AlertCircle className="mt-px h-3 w-3 flex-shrink-0" />
                              {res.error}
                            </p>
                          )}
                        </div>
                        {/* Per-row outcome: a tick as each one lands. */}
                        <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                          {res?.ok === true && <Check className="h-4 w-4 text-success" strokeWidth={3} />}
                          {res && !res.ok && <AlertCircle className="h-4 w-4 text-destructive" />}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <DialogFooter className="flex-shrink-0 flex-row flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3 sm:justify-between">
          <p className="text-[11px] text-muted-foreground" aria-live="polite">
            {/* No translation key for batch progress. */}
            {running ? `Approving ${Math.min(done + 1, selectedCount)} of ${selectedCount}…` : ''}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={running}>
              {t.cancel}
            </Button>
            <Button size="sm" onClick={run} disabled={running || selectedCount === 0}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {/* No translation key takes a count inside the approve verb. */}
              {t.approveVerb} {selectedCount} {selectedCount === 1 ? 'request' : 'requests'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
