'use client';
// Southern Lanka only — "Assign Leave for Employee" on the Leave Management page.
//
// Shown to a user whose role has `can_apply_restricted_leaves` (or any System Admin — see
// the gate in src/app/(pages)/leaves/page.tsx). Lets HR/Admin place a RESTRICTED leave type
// (leave_types.allow_direct_apply === false — the ones hidden from the normal "+ Apply Leave"
// dropdown) directly onto any active employee. The write goes through
// leaveApi.assignRestrictedLeave, which stores an already-APPROVED leave (so the target's
// quota/balance cards reflect it immediately) and notifies the target.
import { useEffect, useMemo, useState } from 'react';
import { UserPlus, Loader2, CalendarPlus, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { _leaveApi as leaveApi } from '@/services/apiCompat';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import SearchableSelect from '@/components/SearchableSelect';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

type Employee   = { epf_number: string; name: string; role?: string; department?: string };
type LeaveTypeT = { id: string; name: string; requires_reason?: boolean; allow_direct_apply?: boolean };
type BalanceRow = { leave_type?: string; type?: string; total?: number; used?: number; available?: number };

type Duration = 'one' | 'range' | 'half';
type HalfPeriod = 'morning' | 'afternoon';

const todayStr = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export default function AssignRestrictedLeaveDialog({
  onAssigned,
}: {
  /** Called after a successful assignment (lets the page refresh in place). */
  onAssigned?: () => void;
}) {
  const { user } = useAuthStore();

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [types, setTypes] = useState<LeaveTypeT[]>([]);

  const [empEpf, setEmpEpf] = useState('');
  const [leaveType, setLeaveType] = useState('');
  const [duration, setDuration] = useState<Duration>('one');
  const [date, setDate] = useState('');          // one-day + half-day
  const [fromDate, setFromDate] = useState('');   // range
  const [toDate, setToDate] = useState('');       // range
  const [halfPeriod, setHalfPeriod] = useState<HalfPeriod>('morning');
  const [reason, setReason] = useState('');
  const [triedSave, setTriedSave] = useState(false);

  // The selected employee's derived balance — fetched on pick so the type picker can show
  // what remains and the admin isn't guessing.
  const [balance, setBalance] = useState<BalanceRow[] | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  const reset = () => {
    setEmpEpf(''); setLeaveType(''); setDuration('one');
    setDate(''); setFromDate(''); setToDate(''); setHalfPeriod('morning');
    setReason(''); setTriedSave(false); setBalance(null);
  };

  // Load the picker pools the first time the dialog opens.
  useEffect(() => {
    if (!open || (employees.length && types.length)) return;
    setLoading(true);
    Promise.all([leaveApi.getAssignableEmployees(), leaveApi.getLeaveTypes()])
      .then(([empRes, ltRes]: any[]) => {
        const emps = empRes?.data?.data?.employees ?? empRes?.data?.employees ?? [];
        setEmployees(Array.isArray(emps) ? emps : []);
        const raw = ltRes?.data?.data?.leave_types ?? ltRes?.data?.leave_types ?? ltRes?.data?.data ?? [];
        // Restricted types only — the whole point of this dialog.
        setTypes((Array.isArray(raw) ? raw : []).filter((t: LeaveTypeT) => t.allow_direct_apply === false));
      })
      .catch(() => { toast.error('Could not load employees / leave types.'); })
      .finally(() => setLoading(false));
  }, [open, employees.length, types.length]);

  // Pull the picked employee's balance so the type list can annotate "N left".
  useEffect(() => {
    if (!empEpf) { setBalance(null); return; }
    setBalanceLoading(true);
    leaveApi.getLeaveSummary(empEpf)
      .then((res: any) => {
        const arr = res?.data?.data ?? res?.data ?? [];
        setBalance(Array.isArray(arr) ? arr : []);
      })
      .catch(() => setBalance([]))
      .finally(() => setBalanceLoading(false));
  }, [empEpf]);

  const selectedType = types.find(t => t.name === leaveType);
  const reasonRequired = !!selectedType?.requires_reason;

  const remainingFor = (typeName: string): number | null => {
    const row = balance?.find(b => (b.leave_type ?? b.type) === typeName);
    if (!row || typeof row.total !== 'number') return null;
    return Math.max(0, (row.total ?? 0) - (row.used ?? 0));
  };

  const empOptions = useMemo(
    () => employees.map(e => ({
      value: e.epf_number,
      label: e.name,
      sublabel: [e.role, e.department].filter(Boolean).join(' · ') || e.epf_number,
      keywords: e.epf_number,
    })),
    [employees],
  );

  const typeOptions = useMemo(
    () => types.map(t => {
      const left = remainingFor(t.name);
      return {
        value: t.name,
        label: t.name,
        sublabel: left == null
          ? (balanceLoading && empEpf ? 'checking balance…' : 'restricted')
          : `${left} day(s) left`,
      };
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [types, balance, balanceLoading, empEpf],
  );

  // Switching duration mode starts that mode's fields clean — otherwise a date/reason typed
  // under one mode (e.g. "One day") silently carries into another (e.g. "Date range") even
  // though the fields look empty, since range uses fromDate/toDate while one-day/half-day
  // share `date`.
  const switchDuration = (v: Duration) => {
    setDuration(v);
    setDate(''); setFromDate(''); setToDate(''); setHalfPeriod('morning');
    setReason('');
  };

  const effFrom = duration === 'range' ? fromDate : date;
  const effTo   = duration === 'range' ? toDate : date;

  const dateError =
    !effFrom ? 'Pick the leave date(s).'
    : duration === 'range' && !toDate ? 'Pick the end date.'
    : duration === 'range' && toDate < fromDate ? 'The end date is before the start date.'
    : '';
  const reasonError = reasonRequired && !reason.trim() ? `A reason is required for ${leaveType}.` : '';
  const formInvalid = !empEpf || !leaveType || !!dateError || !!reasonError;

  const close = () => { setOpen(false); reset(); };

  const submit = async () => {
    setTriedSave(true);
    if (formInvalid) return;
    setSaving(true);
    try {
      await leaveApi.assignRestrictedLeave({
        target_epf:      empEpf,
        assigned_by_epf: user?.epf_number ?? '',
        leave_type:      leaveType,
        from_date:       effFrom,
        to_date:         effTo,
        is_half_day:     duration === 'half',
        half_day_period: duration === 'half' ? halfPeriod : undefined,
        reason:          reason.trim() || undefined,
        is_paid:         true,
      });
      const who = employees.find(e => e.epf_number === empEpf)?.name ?? 'the employee';
      toast.success(`${leaveType} assigned to ${who}.`);
      close();
      onAssigned?.();
    } catch (err: unknown) {
      toast.error((err as { message?: string })?.message ?? 'Could not assign the leave.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <UserPlus className="w-4 h-4" /> Assign Leave
      </Button>

      <Dialog open={open} onOpenChange={o => (o ? setOpen(true) : close())}>
        <DialogContent
          className="max-w-md max-h-[90vh] overflow-y-auto"
          onOpenAutoFocus={e => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarPlus className="w-5 h-5 text-primary" />
              Assign Leave for Employee
            </DialogTitle>
            <DialogDescription>
              Place a restricted leave type directly onto an employee. It is approved
              immediately, deducted from their balance, and they are notified.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : types.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No restricted leave types exist. Turn off “Allow Users to Direct Apply” on a
              leave type first.
            </p>
          ) : (
            <div className="space-y-4">
              {/* Employee */}
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Employee <span className="text-destructive">*</span>
                </Label>
                <SearchableSelect
                  value={empEpf}
                  onChange={setEmpEpf}
                  options={empOptions}
                  placeholder="Search an employee…"
                  emptyLabel="No matching employee"
                />
                {triedSave && !empEpf && (
                  <p className="text-[11px] text-destructive">Select an employee.</p>
                )}
              </div>

              {/* Leave type (restricted only) */}
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Restricted leave type <span className="text-destructive">*</span>
                </Label>
                <SearchableSelect
                  value={leaveType}
                  onChange={setLeaveType}
                  options={typeOptions}
                  placeholder="Select a leave type…"
                  emptyLabel="No restricted leave types"
                />
                {triedSave && !leaveType && (
                  <p className="text-[11px] text-destructive">Select a leave type.</p>
                )}
              </div>

              {/* Duration */}
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Duration</Label>
                <div className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted p-1">
                  {([['one', 'One day'], ['range', 'Date range'], ['half', 'Half day']] as const).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => switchDuration(v)}
                      className={`rounded-md px-2 py-1.5 text-xs font-semibold transition-colors ${
                        duration === v ? 'bg-primary/10 text-primary border border-primary/20' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Dates */}
              {duration === 'range' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5 min-w-0">
                    <Label className="text-xs font-medium text-muted-foreground">From</Label>
                    {/* min-w-0 alongside Input's own w-full — a native date control's
                        calendar-icon chrome can force intrinsic width past its grid track
                        without it, which is what let this column overlap its neighbour. Stacked
                        to one field per row below sm: too — even with min-w-0, two native date
                        pickers side by side left too little room inside the dialog's width on
                        phones. Back to grid-cols-2 from sm: up, where there's room for both. */}
                    <Input type="date" className="w-full min-w-0" value={fromDate} onChange={e => setFromDate(e.target.value)} />
                  </div>
                  <div className="space-y-1.5 min-w-0">
                    <Label className="text-xs font-medium text-muted-foreground">To</Label>
                    <Input type="date" className="w-full min-w-0" value={toDate} min={fromDate || undefined} onChange={e => setToDate(e.target.value)} />
                  </div>
                </div>
              ) : (
                // Date + Period (half day only) — stacked to one field per row on mobile: side
                // by side, Period's own two-way toggle left too little room next to a native
                // date control's calendar-icon chrome at phone widths. Back to grid-cols-2 from
                // sm: up, where there's room for both.
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5 min-w-0">
                    <Label className="text-xs font-medium text-muted-foreground">Date</Label>
                    <Input type="date" className="w-full min-w-0" value={date} onChange={e => setDate(e.target.value)} />
                  </div>
                  {duration === 'half' && (
                    <div className="space-y-1.5 min-w-0">
                      <Label className="text-xs font-medium text-muted-foreground">Period</Label>
                      <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted p-1">
                        {(['morning', 'afternoon'] as const).map(p => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setHalfPeriod(p)}
                            className={`rounded-md px-2 py-1.5 text-xs font-semibold capitalize transition-colors ${
                              halfPeriod === p ? 'bg-primary/10 text-primary border border-primary/20' : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {triedSave && dateError && <p className="text-[11px] text-destructive">{dateError}</p>}

              {/* Reason */}
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Reason {reasonRequired && <span className="text-destructive">*</span>}
                </Label>
                <Textarea
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  rows={3}
                  placeholder="Why is this leave being assigned?"
                />
                {triedSave && reasonError && <p className="text-[11px] text-destructive">{reasonError}</p>}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" className="flex-1" onClick={close} disabled={saving}>Cancel</Button>
            <Button
              className="flex-1"
              onClick={submit}
              disabled={saving || loading || types.length === 0 || (triedSave && formInvalid)}
            >
              {saving ? <><Loader2 className="w-4 h-4 animate-spin" />Assigning…</> : <><Check className="w-4 h-4" />Assign leave</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
