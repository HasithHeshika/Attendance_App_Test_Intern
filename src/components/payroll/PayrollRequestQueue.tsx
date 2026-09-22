'use client';
// The approver's side of employee-raised advance / loan requests (see PayrollRequest in
// payrollTypes.ts). Mounted on the Salary Advances and Loans pages, above the record list.
// Renders nothing at all while the queue is empty, so the pages look exactly as they did
// before anyone could ask — the card only appears once there is something to decide.
//
// Approving here does NOT create money. "Approve" hands the request back to the page, which
// opens its ordinary Record / New form pre-filled; recording the advance or loan there is what
// marks the request approved (with the new record's id). Turning one down is decided here.

import { useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import toast from 'react-hot-toast';
import type { PayrollRequest, PayrollRequestKind } from '@/lib/payrollTypes';
import { getPendingPayrollRequests, rejectPayrollRequest } from '@/services/payrollRequestService';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** What a page's dialog needs to open pre-filled from a request. `period` is the recovery
 *  month (advance) or the first deduction month (loan); `repayMonths` is the employee's
 *  preferred term for a loan, which the approver may still change before recording. */
export interface RequestPrefill {
  requestId: string;
  epf: string;
  amount: number;
  note: string;
  period: string;
  repayMonths?: number | null;
}

interface Props {
  kind: PayrollRequestKind;
  /** Scope to one company; '' or undefined shows every company's requests. */
  companyId?: string;
  canDecide: boolean;
  actor: { epf: string; name: string };
  /** Bump to reload — the page does this after it records something for a request. */
  refreshKey?: number;
  onApprove: (r: PayrollRequest) => void;
}

function periodLine(r: PayrollRequest): string {
  if (r.kind === 'advance') return `recover in ${r.period}`;
  const months = Number(r.repay_months) || 0;
  if (months < 1) return `from ${r.period}`;
  const perMonth = Math.ceil(r.amount / months);
  return `from ${r.period} · over ${months} month${months === 1 ? '' : 's'} ≈ ${perMonth.toLocaleString()} a month`;
}

export default function PayrollRequestQueue({ kind, companyId, canDecide, actor, refreshKey, onApprove }: Props) {
  const [requests, setRequests] = useState<PayrollRequest[]>([]);
  // Which row has its "turn down" reason open, and what has been typed so far.
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    try {
      setRequests(await getPendingPayrollRequests({ kind, companyId: companyId || undefined }));
    } catch (err) {
      // A failed read leaves the card hidden rather than showing an empty shell — the page
      // itself is unaffected, and the toast says why nothing is listed.
      console.error(err);
      toast.error('Could not load pending requests.');
    }
  };
  useEffect(() => { load(); }, [kind, companyId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (requests.length === 0) return null;

  const handleReject = async (r: PayrollRequest) => {
    if (!r.id) return;
    setBusyId(r.id);
    try {
      await rejectPayrollRequest(r.id, actor, rejectNote);
      toast.success(`${r.employee_name}'s request turned down.`);
      setRejectingId(null); setRejectNote('');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not turn down the request.');
    } finally { setBusyId(null); }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Inbox className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
          <CardTitle className="text-base">Requests</CardTitle>
          <Badge variant="warning">{requests.length}</Badge>
        </div>
        <CardDescription>
          Employees asked for these from their profile. Approving opens the usual form pre-filled; recording it there is what approves the request.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {requests.map(r => {
          const busy = busyId === r.id;
          const rejecting = rejectingId === r.id;
          return (
            <div key={r.id} className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {r.employee_name} <span className="text-muted-foreground font-normal">· {r.epf_number}{!companyId ? ` · ${r.company_name}` : ''}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {periodLine(r)}
                    {r.created_at ? ` · asked ${r.created_at.toDate().toLocaleDateString()}` : ''}
                  </div>
                </div>
                <div className="text-sm font-semibold tabular-nums text-foreground">{r.amount.toLocaleString()}</div>
              </div>

              {/* The employee's own words, in full — the approver was not there, so nothing is trimmed. */}
              <p className="rounded-md bg-muted/50 px-3 py-2 text-sm text-foreground whitespace-pre-wrap break-words">{r.reason}</p>

              {canDecide && (
                rejecting ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      className="flex-1 min-w-[180px]"
                      placeholder="Reason (the employee will see this)"
                      value={rejectNote}
                      onChange={e => setRejectNote(e.target.value)}
                      disabled={busy}
                      autoFocus
                    />
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setRejectingId(null); setRejectNote(''); }}>Cancel</Button>
                    <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => handleReject(r)}>{busy ? 'Turning down…' : 'Confirm'}</Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setRejectingId(r.id ?? null); setRejectNote(''); }}>Turn down</Button>
                    <Button type="button" size="sm" disabled={busy} onClick={() => onApprove(r)}>Approve</Button>
                  </div>
                )
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
