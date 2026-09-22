'use client';
// Overtime requests — Southern Lanka Hospitals payroll tenant.
//
// One page, two audiences:
//   • My OT      — any employee: file a request (OTRequestModal) and track its status.
//   • Approvals  — anyone with can_approve_ot: the pending queue for requests whose frozen
//                  approver_pool contains them, decided via OTApprovalDialog.
// Which tabs show is driven purely by capabilities, mirroring the Leaves page's
// "My Leaves" / "Team Requests" split. Payroll-tenant only; the sidebar entry
// (useSidebarNav.ts) is gated the same way.

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Timer, Clock, Inbox, Pencil, Loader2, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { tenant } from '@/lib/firebase';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { PageTransition } from '@/components/ui/motion';
import OTRequestModal from '@/components/ot/OTRequestModal';
import OTApprovalDialog from '@/components/ot/OTApprovalDialog';
import {
  getMyOtRequests, getPendingOtRequestsForApprover, cancelOtRequest,
} from '@/services/otRequestService';
import { type OtRequest, type OtRequestStatus, OT_TYPE_LABELS } from '@/types/otRequest';

function statusVariant(s: OtRequestStatus): BadgeProps['variant'] {
  return s === 'approved' ? 'success' : s === 'rejected' ? 'destructive' : s === 'pending' ? 'warning' : 'muted';
}

const tsDate = (t: OtRequest['created_at']): string => {
  try { return t ? formatDate(t.toDate().toISOString().slice(0, 10)) : ''; } catch { return ''; }
};

export default function OtRequestsPage() {
  const caps = useUserCapabilities();

  if (!tenant.features.payroll) {
    return <div className="p-10 text-center text-muted-foreground">Overtime requests are not enabled for this organisation.</div>;
  }
  if (!caps.is_employee && !caps.can_approve_ot) {
    return <div className="p-10 text-center text-muted-foreground">You don’t have access to overtime requests.</div>;
  }
  return (
    // useSearchParams() inside OtRequestsContent (the "shift auto-closed" notification deep-link
    // pre-fills the OT form) needs a Suspense boundary at the static-render edge — same pattern
    // as users/leaves/departments pages.
    <Suspense fallback={<p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>}>
      <OtRequestsContent canMine={caps.is_employee} canApprove={caps.can_approve_ot} />
    </Suspense>
  );
}

function OtRequestsContent({ canMine, canApprove }: { canMine: boolean; canApprove: boolean }) {
  const user = useAuthStore(s => s.user);
  const epf = user?.epf_number ?? '';

  const [tab, setTab] = useState<'mine' | 'approvals'>(canMine ? 'mine' : 'approvals');

  const [mine, setMine] = useState<OtRequest[]>([]);
  const [mineLoading, setMineLoading] = useState(canMine);
  const [pending, setPending] = useState<OtRequest[]>([]);
  const [pendingLoading, setPendingLoading] = useState(canApprove);

  const [editing, setEditing] = useState<OtRequest | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [review, setReview] = useState<OtRequest | null>(null);

  // Deep-link pre-fill from the "shift auto-closed" notification
  // (/ot-requests?prefillDate=YYYY-MM-DD&prefillHours=N). Captured once into stable state, then
  // the query string is stripped so a refresh / close doesn't reopen the form.
  const sp = useSearchParams();
  const router = useRouter();
  const prefillConsumed = useRef(false);
  const [prefill, setPrefill] = useState<{ date: string; hours: string } | null>(null);
  useEffect(() => {
    if (prefillConsumed.current || !canMine) return;
    const d = sp.get('prefillDate') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    prefillConsumed.current = true;
    setPrefill({ date: d, hours: sp.get('prefillHours') ?? '' });
    router.replace('/ot-requests');
  }, [canMine, sp, router]);

  const loadMine = useCallback(async () => {
    if (!canMine || !epf) return;
    setMineLoading(true);
    try { setMine(await getMyOtRequests(epf)); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not load your requests.'); }
    finally { setMineLoading(false); }
  }, [canMine, epf]);

  const loadPending = useCallback(async () => {
    if (!canApprove || !epf) return;
    setPendingLoading(true);
    try { setPending(await getPendingOtRequestsForApprover(epf)); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not load the approval queue.'); }
    finally { setPendingLoading(false); }
  }, [canApprove, epf]);

  useEffect(() => { loadMine(); loadPending(); }, [loadMine, loadPending]);

  const doCancel = async (r: OtRequest) => {
    if (!epf) return;
    setCancelling(true);
    try {
      await cancelOtRequest(r.id, epf);
      toast.success('Overtime request cancelled.');
      setConfirmCancel(null);
      loadMine();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not cancel the request.');
    } finally {
      setCancelling(false);
    }
  };

  const showTabs = canMine && canApprove;

  const mineList = (
    <div className="space-y-3">
      {mineLoading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
      ) : mine.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            icon={Clock}
            title="No overtime requests yet"
            description="File one for any extra hours you worked. It reaches payroll only after your approver signs off."
            action={<OTRequestModal onSaved={loadMine} />}
          />
        </Card>
      ) : (
        mine.map(r => (
          <Card key={r.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{formatDate(r.date)}</span>
                  <Badge variant="outline">{OT_TYPE_LABELS[r.ot_type]}</Badge>
                  <span className="text-sm text-muted-foreground tabular-nums">{r.requested_hours} h</span>
                  <Badge variant={statusVariant(r.status)} className="capitalize">{r.status}</Badge>
                </div>
                <p className="text-sm text-muted-foreground break-words">{r.reason}</p>
                {r.status !== 'pending' && r.status !== 'cancelled' && (r.decision_note || r.considered_by_name) && (
                  <p className="text-xs text-muted-foreground">
                    {r.status === 'approved' ? 'Approved' : 'Rejected'}
                    {r.considered_by_name ? ` by ${r.considered_by_name}` : ''}
                    {r.decision_note ? ` — “${r.decision_note}”` : ''}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">Pays in {r.period}</p>
              </div>

              {r.status === 'pending' && (
                <div className="flex shrink-0 items-center gap-2">
                  {confirmCancel === r.id ? (
                    <>
                      <span className="text-xs text-muted-foreground">Cancel it?</span>
                      <Button size="sm" variant="destructive" onClick={() => doCancel(r)} disabled={cancelling}>
                        {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Yes'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(null)} disabled={cancelling}>No</Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setEditing(r)}>
                        <Pencil className="h-3.5 w-3.5" />Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(r.id)}>Cancel</Button>
                    </>
                  )}
                </div>
              )}
            </div>
          </Card>
        ))
      )}
    </div>
  );

  const approvalsList = (
    <div className="space-y-3">
      {pendingLoading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
      ) : pending.length === 0 ? (
        <Card className="p-6">
          <EmptyState icon={Inbox} title="Nothing waiting for your approval" description="Overtime requests routed to you will appear here." />
        </Card>
      ) : (
        pending.map(r => (
          <Card key={r.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.employee_name}</span>
                  <span className="text-xs text-muted-foreground">· {r.epf_number}</span>
                  {r.department && <Badge variant="muted">{r.department}</Badge>}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{formatDate(r.date)}</span>
                  <Badge variant="outline">{OT_TYPE_LABELS[r.ot_type]}</Badge>
                  <span className="text-muted-foreground tabular-nums">{r.requested_hours} h</span>
                </div>
                <p className="text-sm text-muted-foreground break-words">{r.reason}</p>
                <p className="text-[11px] text-muted-foreground">
                  Pays in {r.period}{tsDate(r.created_at) ? ` · requested ${tsDate(r.created_at)}` : ''}
                </p>
              </div>
              <Button size="sm" className="shrink-0" onClick={() => setReview(r)}>
                Review <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </Card>
        ))
      )}
    </div>
  );

  return (
    <PageTransition className="space-y-6">
      <PageHeader
        title="Overtime"
        description="Request overtime you worked and track approvals. Approved hours reach payroll after a Monthly Run sync."
        icon={Timer}
        actions={canMine ? <OTRequestModal onSaved={loadMine} /> : undefined}
      />

      {showTabs ? (
        <Tabs value={tab} onValueChange={v => setTab(v as 'mine' | 'approvals')}>
          <TabsList>
            <TabsTrigger value="mine">My OT</TabsTrigger>
            <TabsTrigger value="approvals">
              Approvals{pending.length > 0 ? ` (${pending.length})` : ''}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="mine">{mineList}</TabsContent>
          <TabsContent value="approvals">{approvalsList}</TabsContent>
        </Tabs>
      ) : canMine ? (
        mineList
      ) : (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">
            Pending approvals{pending.length > 0 ? ` (${pending.length})` : ''}
          </h2>
          {approvalsList}
        </div>
      )}

      {/* Edit an own still-pending request. Mounted always; open is driven by `editing`. */}
      <OTRequestModal
        editRequest={editing}
        open={!!editing}
        onOpenChange={o => { if (!o) setEditing(null); }}
        onSaved={() => { setEditing(null); loadMine(); }}
      />

      {/* Pre-filled new request from the "shift auto-closed" notification. */}
      {canMine && prefill && (
        <OTRequestModal
          open
          onOpenChange={o => { if (!o) setPrefill(null); }}
          prefillDate={prefill.date}
          prefillHours={prefill.hours || undefined}
          onSaved={() => { setPrefill(null); loadMine(); }}
        />
      )}

      <OTApprovalDialog
        request={review}
        open={!!review}
        onOpenChange={o => { if (!o) setReview(null); }}
        onDecided={() => { setReview(null); loadPending(); }}
      />
    </PageTransition>
  );
}
