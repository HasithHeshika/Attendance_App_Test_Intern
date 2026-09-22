'use client';
// "Consider OT request" — the approver's approve / reject dialog, Southern Lanka payroll.
//
// Opened from the Approvals tab on /ot-requests for a request whose frozen approver_pool
// contains the current user. Approve is one click; Reject requires a note (the employee sees
// it on the bell and in their history). considerOtRequest re-checks that the request is still
// pending before writing, so two approvers racing the same row can't both decide it.

import { useEffect, useState, type ReactNode } from 'react';
import { Clock3, Loader2, Check, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import InlineError from '@/components/InlineError';
import { considerOtRequest } from '@/services/otRequestService';
import { type OtRequest, OT_TYPE_LABELS } from '@/types/otRequest';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

export default function OTApprovalDialog({
  request,
  open,
  onOpenChange,
  onDecided,
}: {
  request: OtRequest | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDecided?: () => void;
}) {
  const { user } = useAuthStore();
  const [note, setNote] = useState('');
  const [triedReject, setTriedReject] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  useEffect(() => {
    if (open) { setNote(''); setTriedReject(false); setBusy(null); }
  }, [open, request?.id]);

  if (!request) return null;

  const noteError = triedReject && !note.trim() ? 'Add a reason so the employee knows why.' : '';

  const decide = async (action: 'approve' | 'reject') => {
    if (action === 'reject' && !note.trim()) { setTriedReject(true); return; }
    if (!user?.epf_number) { toast.error('Your account has no EPF number set.'); return; }
    setBusy(action);
    try {
      await considerOtRequest({
        request_id: request.id,
        approver_epf: user.epf_number,
        approver_name: user.name,
        action,
        note: note.trim() || undefined,
      });
      toast.success(action === 'approve' ? 'Overtime approved.' : 'Overtime request rejected.');
      onOpenChange(false);
      onDecided?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not record the decision.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock3 className="w-5 h-5 text-primary" />
            Overtime request
          </DialogTitle>
          <DialogDescription>
            {request.employee_name} · {request.epf_number}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 divide-y divide-border">
          <Row label="Type">{OT_TYPE_LABELS[request.ot_type]}</Row>
          <Row label="Date worked">{request.date}</Row>
          <Row label="Hours">{request.requested_hours}</Row>
          <Row label="Pay cycle">{request.period}</Row>
          {request.department && <Row label="Department">{request.department}</Row>}
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Reason given</Label>
          <p className="text-sm whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2">{request.reason}</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Note <span className="normal-case font-normal text-muted-foreground">(required to reject)</span>
          </Label>
          <Textarea
            rows={2} value={note} onChange={e => setNote(e.target.value)}
            placeholder="Optional for approval, required for rejection"
          />
          <InlineError>{noteError}</InlineError>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => decide('reject')}
            disabled={busy !== null}
          >
            {busy === 'reject' ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
            Reject
          </Button>
          <Button
            className="flex-1"
            onClick={() => decide('approve')}
            disabled={busy !== null}
          >
            {busy === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
