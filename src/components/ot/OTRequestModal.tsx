'use client';
// "Request OT" / "Edit OT request" — Southern Lanka Hospitals payroll tenant.
//
// Files a new pending ot_requests doc (or edits an own still-pending one). Routing to
// approvers is resolved server-side by submitOtRequest; this form only collects the four
// inputs — which OT bucket, which day, how many hours, and why. The payroll period is
// derived from the date (the day's month) and shown read-only; pushing OT into a later cycle
// is a payroll-staff action, not something the employee picks here.
//
// Follows the app's inline-validation convention: triedSave + <InlineError> beneath each
// field, submit disabled once a tried save is still invalid.

import { useEffect, useState } from 'react';
import { Clock3, Loader2, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import InlineError from '@/components/InlineError';
import { submitOtRequest, updateOtRequest } from '@/services/otRequestService';
import {
  type OtRequest, type OtType, OT_TYPES, OT_TYPE_LABELS,
  MAX_OT_HOURS_PER_REQUEST, periodForDate,
} from '@/types/otRequest';

const todayStr = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export default function OTRequestModal({
  editRequest = null,
  open: controlledOpen,
  onOpenChange,
  onSaved,
  triggerLabel = 'Request OT',
  prefillDate,
  prefillHours,
}: {
  /** When set, the dialog edits this request instead of creating a new one. */
  editRequest?: OtRequest | null;
  /** Controlled open state. Omit for the built-in trigger button. */
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  onSaved?: () => void;
  triggerLabel?: string;
  /** Seed a fresh (non-edit) request — e.g. from the "shift auto-closed" notification link. */
  prefillDate?: string;
  prefillHours?: string;
}) {
  const { user } = useAuthStore();
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = (o: boolean) => (isControlled ? onOpenChange?.(o) : setUncontrolledOpen(o));

  const [otType, setOtType] = useState<OtType>('normal');
  const [date, setDate] = useState('');
  const [hours, setHours] = useState('');
  const [reason, setReason] = useState('');
  const [triedSave, setTriedSave] = useState(false);
  const [saving, setSaving] = useState(false);

  // Seed from the edited request each time the dialog opens; clear for a fresh create.
  useEffect(() => {
    if (!open) return;
    if (editRequest) {
      setOtType(editRequest.ot_type);
      setDate(editRequest.date);
      setHours(String(editRequest.requested_hours));
      setReason(editRequest.reason);
    } else {
      setOtType('normal');
      setDate(prefillDate || todayStr());
      setHours(prefillHours ?? '');
      setReason('');
    }
    setTriedSave(false);
  }, [open, editRequest, prefillDate, prefillHours]);

  const hoursNum = Number(hours);
  const hoursError =
    hours.trim() === '' ? 'Enter the number of overtime hours.'
    : !Number.isFinite(hoursNum) || hoursNum <= 0 ? 'Hours must be greater than zero.'
    : hoursNum > MAX_OT_HOURS_PER_REQUEST ? `That is more than ${MAX_OT_HOURS_PER_REQUEST} hours in one day.`
    : '';
  const dateError = !date ? 'Pick the day the overtime was worked.' : '';
  const reasonError = !reason.trim() ? 'A short reason is required.' : '';
  const invalid = !!hoursError || !!dateError || !!reasonError;

  const close = () => setOpen(false);

  const submit = async () => {
    setTriedSave(true);
    if (invalid) return;
    if (!user?.epf_number) { toast.error('Your account has no EPF number set.'); return; }
    setSaving(true);
    try {
      if (editRequest) {
        await updateOtRequest(editRequest.id, {
          date, ot_type: otType, requested_hours: hoursNum, reason,
        });
        toast.success('Overtime request updated.');
      } else {
        await submitOtRequest({
          epf_number: user.epf_number,
          employee_name: user.name,
          company_id: user.company_id ?? '',
          department: user.department ?? null,
          date,
          ot_type: otType,
          requested_hours: hoursNum,
          reason,
          submitted_by_epf: user.epf_number,
        });
        toast.success('Overtime request submitted for approval.');
      }
      close();
      onSaved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the request.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {!isControlled && (
        <Button onClick={() => setOpen(true)}>
          <Clock3 className="w-4 h-4" /> {triggerLabel}
        </Button>
      )}

      <Dialog open={open} onOpenChange={o => (o ? setOpen(true) : close())}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock3 className="w-5 h-5 text-primary" />
              {editRequest ? 'Edit overtime request' : 'Request overtime'}
            </DialogTitle>
            <DialogDescription>
              {editRequest
                ? 'Change the details while the request is still pending.'
                : 'Tell your approver what overtime you worked. It is added to payroll only after approval and a payroll sync.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* OT type */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Overtime type
              </Label>
              <Select value={otType} onValueChange={v => setOtType(v as OtType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OT_TYPES.map(t => (
                    <SelectItem key={t} value={t}>{OT_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Date + hours — stacked on mobile: a native type="date" control's calendar-icon
                chrome forces enough intrinsic width that two columns this narrow (inside a
                modal, not the full viewport) left Hours overlapping/overflowing past Date
                worked even with min-w-0 on both tracks. Back to side-by-side from sm: up,
                where there's room for both. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5 min-w-0">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Date worked</Label>
                <Input type="date" className="w-full min-w-0" value={date} onChange={e => setDate(e.target.value)} />
                {triedSave && <InlineError>{dateError}</InlineError>}
              </div>
              <div className="space-y-1.5 min-w-0">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Hours</Label>
                <Input
                  type="number" min={0} step={0.5} inputMode="decimal" className="min-w-0"
                  value={hours} onChange={e => setHours(e.target.value)} placeholder="e.g. 2.5"
                />
                {triedSave && <InlineError>{hoursError}</InlineError>}
              </div>
            </div>

            {date && (
              <p className="text-[11px] text-muted-foreground">
                Paid in the <span className="font-medium text-foreground">{periodForDate(date)}</span> payroll cycle.
              </p>
            )}

            {/* Reason */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Reason</Label>
              <Textarea
                rows={3} value={reason} onChange={e => setReason(e.target.value)}
                placeholder="What was the overtime for?"
              />
              {triedSave && <InlineError>{reasonError}</InlineError>}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" className="flex-1" onClick={close} disabled={saving}>Cancel</Button>
            <Button
              className="flex-1"
              onClick={submit}
              disabled={saving || (triedSave && invalid)}
            >
              {saving
                ? <><Loader2 className="w-4 h-4 animate-spin" />Saving…</>
                : <><Check className="w-4 h-4" />{editRequest ? 'Save changes' : 'Submit request'}</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
