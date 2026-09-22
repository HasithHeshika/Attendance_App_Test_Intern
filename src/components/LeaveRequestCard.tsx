'use client';
import { useState, useEffect } from 'react';
import {
  CalendarDays, CheckCircle2, XCircle, Loader2, X, User, ChevronRight, Clock, FileText, Wallet,
  History,
} from 'lucide-react';
import { format } from 'date-fns';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { useT } from '@/store/appStore';
import { cn } from '@/lib/utils';
import { statusBadgeVariant, statusBucket, statusVisual } from '@/components/leaves/leaveStatus';

export interface LeaveRequestData {
  leave_id: string | number;
  epf_number: string;
  name?: string;
  employee_name?: string;
  from_date: string;
  to_date: string;
  leave_type_name?: string;
  reason?: string;
  status: string;
  is_half_day?: boolean;
  half_day_period?: string | null;
  is_paid?: boolean;
  applied_at?: string;
  supervisor_epf?: string | null;  // epf of the supervisor the leave was requested from
  requested_from?: string | null;  // that supervisor's display name
  requested_at?: string | null;    // ISO — when the leave was applied
}

// Short "Jul 3, 9:12 AM"-style stamp for the requested time.
function fmtRequestedAt(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : format(d, 'MMM d, h:mm a');
}

function nameOf(l: LeaveRequestData) {
  return l.employee_name ?? l.name ?? l.epf_number;
}

function dateRange(l: LeaveRequestData) {
  const from = format(new Date(l.from_date + 'T00:00:00'), 'MMM d, yyyy');
  if (l.from_date === l.to_date) return from;
  const to = format(new Date(l.to_date + 'T00:00:00'), 'MMM d, yyyy');
  return `${from} → ${to}`;
}

function dayCount(l: LeaveRequestData, dayWord: string, daysWord: string) {
  if (l.is_half_day) return `0.5 ${dayWord}`;
  const from = new Date(l.from_date + 'T00:00:00');
  const to = new Date(l.to_date + 'T00:00:00');
  const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
  return `${days} ${days > 1 ? daysWord : dayWord}`;
}

// The row gets scanned twenty at a time, so its date carries only what changes: the year is
// implied unless the leave leaves this one, and a range inside a single month prints that month
// once. dateRange() stays as it is — the modal still shows the long form.
function rowDateRange(l: LeaveRequestData): string {
  const from = new Date(l.from_date + 'T00:00:00');
  const to   = new Date(l.to_date + 'T00:00:00');
  const now  = new Date().getFullYear();
  // Leave over New Year is an ordinary request here, and it is the one range that cannot be
  // compacted: a single year suffix on both ends prints "Dec 30 – Jan 2, 2027", which reads as a
  // leave that ended three days before it started. Spell both years out.
  if (from.getFullYear() !== to.getFullYear())
    return `${format(from, 'MMM d, yyyy')} – ${format(to, 'MMM d, yyyy')}`;
  const yr = from.getFullYear() === now ? '' : `, ${format(to, 'yyyy')}`;
  if (l.from_date === l.to_date) return format(from, 'MMM d') + yr;
  if (from.getMonth() === to.getMonth())
    return `${format(from, 'MMM d')}–${format(to, 'd')}${yr}`;
  return `${format(from, 'MMM d')} – ${format(to, 'MMM d')}${yr}`;
}

// The backend spells a status four ways and always in English. Collapse it with the shared bucket
// helper, then print it in the language the supervisor is actually reading.
function statusWord(status: string, t: ReturnType<typeof useT>): string {
  switch (statusBucket(status)) {
    case 'approved': return t.approved;
    case 'pending':  return t.pending;
    case 'rejected': return t.rejectedPrefix;
    default:         return status;   // a spelling we do not know — print it rather than lie
  }
}

// ─── Compact list row ───────────────────────────────────────────────────────
export function LeaveRequestRow({ leave, onClick, currentEpf, onOpenHistory }: {
  leave: LeaveRequestData;
  onClick: () => void;
  currentEpf?: string;
  onOpenHistory?: () => void;   // the page owns the one history dialog; the row only asks for it
}) {
  const t = useT();
  // Who the leave was routed to: the viewer themself, or another supervisor by name. One fact,
  // one label, two values.
  const toMe        = !!currentEpf && String(leave.supervisor_epf ?? '') === String(currentEpf);
  const requestedAt = fmtRequestedAt(leave.requested_at);
  const name        = nameOf(leave);
  const range       = rowDateRange(leave);
  const status      = statusWord(leave.status, t);
  const { Icon: StatusIcon, accent } = statusVisual(leave.status);
  // One breath for a screen reader: the verb first, then just enough to tell this row from the
  // other nineteen. The status is deliberately left out — the badge two nodes later says it, and
  // whatever the label repeats gets read twice in browse mode.
  const reviewLabel = [`${t.reviewVerb}: ${name}`, leave.leave_type_name, range]
    .filter(Boolean).join(', ');

  return (
    <Card
      className={cn(
        // `relative` anchors the stretched action. `isolate` keeps the name's z-10 inside this
        // row, so a card can never paint over the sticky header or a dialog backdrop.
        'group relative isolate flex items-center gap-3 rounded-xl border-l-[3px] py-3 pl-3 pr-9 sm:pl-4 sm:pr-10',
        accent,   // status as a left rail — position, not hue
        'transition-[background-color,box-shadow,transform] duration-150 ease-out',
        'hover:bg-accent hover:shadow-soft',
        // The press belongs to the review action, not to the row. A bare `active:` here fires for
        // any descendant — CSS :active matches ancestors — so tapping the NAME shrank the whole
        // card and promised the review modal while the history dialog opened instead. :has() ties
        // it to the overlay; motion-safe puts back the reduced-motion guard MotionCard used to
        // give us, since globals.css has no blanket reset.
        'motion-safe:has-[[data-row-action]:active]:scale-[0.99]',
      )}
    >
      {/* Identity — decoration. The name beside it is the control, and a lone letter read out
          before every name is noise. */}
      <div aria-hidden="true" className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
        {name.charAt(0).toUpperCase()}
      </div>

      <div className="min-w-0 flex-1">
        {/* Line 1 — who it is, and where the request stands */}
        <div className="flex items-center gap-2">
          {onOpenHistory ? (
            <button
              type="button"
              onClick={onOpenHistory}
              title={name}
              aria-label={`${t.leaveHistoryLabel}: ${name}`}
              // z-10 is what makes this reachable at all — it has to outrank the sheet lying
              // across the card. The tap box then grows UPWARD (-mt-2.5/pt-2.5) into the card's
              // own 12px of top padding and only 4px down: ~34px of target that stops short of
              // line 2. The symmetric -my-2.5 box it replaces hung 8px over the date, so a thumb
              // aimed at "Sep 2–5" opened this person's history instead of the decision.
              className="group/name relative z-10 -mx-1 -mb-1 -mt-2.5 flex min-w-0 items-center gap-1.5 rounded-md px-1 pb-1 pt-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              {/* Everything around this is one big target, so the name has to declare itself a
                  different one — and it cannot do that with colour, since primary, brand and
                  success are one azure. A dotted rule and the history glyph, both there at rest,
                  not only on hover, because a touch screen has no hover. */}
              <span className="truncate text-sm font-semibold text-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 transition-colors group-hover/name:text-primary group-hover/name:decoration-solid group-hover/name:decoration-primary">
                {name}
              </span>
              <History aria-hidden="true" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-colors group-hover/name:text-primary" />
            </button>
          ) : (
            // No EPF means the history dialog has nothing to fetch. Then the row is exactly what
            // it was: one target, and the name is plain text.
            <span className="min-w-0 truncate text-sm font-semibold text-foreground">{name}</span>
          )}

          <Badge variant={statusBadgeVariant(leave.status)} className="ml-auto flex-shrink-0 px-1.5 text-[10px]">
            <StatusIcon aria-hidden="true" className="h-3 w-3" /> {status}
          </Badge>
        </div>

        {/* Line 2 — what kind of leave, and when. The type badge used to be `hidden sm:inline-flex`,
            which hid the one field the decision actually turns on from the phone this screen is
            for. Full width under the name, it fits. mt-1.5 is not decoration: it is the clearance
            the name's tap box needs so the two targets cannot overlap. */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <CalendarDays aria-hidden="true" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
            <span className="truncate text-[11px] text-muted-foreground">{range}</span>
          </span>
          {leave.leave_type_name && (
            // text-foreground on purpose: bg-muted under muted-foreground is 4.2:1 in the light
            // theme, and this is 10px text carrying the field the approval turns on.
            <Badge variant="muted" className="text-[10px] text-foreground">{leave.leave_type_name}</Badge>
          )}
          {leave.is_half_day && (
            // Morning or afternoon IS the half-day request, so the row has to say which. The modal
            // and the passed-requests list both print the backend's word exactly like this.
            <Badge variant="brand" className="text-[10px] font-bold capitalize">
              {t.halfDay}{leave.half_day_period ? ` · ${leave.half_day_period}` : ''}
            </Badge>
          )}
        </div>

        {/* Line 3 — whose decision this is. `requested_from` is the approver the leave was routed
            to, so it takes the label the other two leave surfaces already give that field: a leave
            must not read one way here and another way in the history dialog. "You" is a filled
            badge because it is the one thing on the row that changes what this supervisor does
            next — filled against muted text is a weight difference, not a hue one. */}
        {(toMe || leave.requested_from || requestedAt) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
            {toMe ? (
              <span className="inline-flex flex-shrink-0 items-center gap-1">
                {t.requestedToLabel}:
                {/* Palette swapped off the solid variant: white on azure is 2.5:1 in the dark
                    theme, and this is the smallest text on the card. */}
                <Badge variant="solid" className="bg-foreground px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-background">
                  {t.youLabel}
                </Badge>
              </span>
            ) : leave.requested_from ? (
              // min-w-0 is what makes `truncate` work here: without it a long supervisor name is a
              // nowrap flex item sized to its min-content and spills out over the chevron.
              <span className="min-w-0 truncate">{t.requestedToLabel}: <span className="font-medium text-foreground">{leave.requested_from}</span></span>
            ) : null}
            {requestedAt && (
              <span className="inline-flex flex-shrink-0 items-center gap-0.5">
                <Clock aria-hidden="true" className="h-2.5 w-2.5 flex-shrink-0" />{requestedAt}
              </span>
            )}
          </div>
        )}
      </div>

      {/* The primary action covers the whole card. It is a SIBLING of the history button, never
          its ancestor — that is the whole reason the way into a person's record can finally live
          inside the card. It comes LAST in the DOM so Tab reaches the name before the row action,
          the order the eye takes them in; being absolutely positioned it still paints (and takes
          taps) above the static content above it, and the name lifts itself clear with z-10. */}
      <button
        type="button"
        data-row-action
        onClick={onClick}
        aria-label={reviewLabel}
        className="absolute inset-0 flex items-center justify-end rounded-xl pr-3 text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover:text-primary sm:pr-4"
      >
        <ChevronRight aria-hidden="true" className="h-4 w-4" />
      </button>
    </Card>
  );
}

// ─── Detail modal ───────────────────────────────────────────────────────────
export function LeaveRequestModal({
  leave, busy, allowPaymentChoice, onApprove, onReject, onClose,
}: {
  leave: LeaveRequestData | null;
  busy: boolean;
  allowPaymentChoice?: boolean;   // only types that allow paid/unpaid show the choice
  onApprove: (isPaid?: boolean) => void;
  onReject: () => void;
  onClose: () => void;
}) {
  const t = useT();
  // The approver decides paid/unpaid — but only when the leave type allows that choice.
  const [isPaid, setIsPaid] = useState(true);
  useEffect(() => { if (leave) setIsPaid(leave.is_paid ?? true); }, [leave]);
  const pending = leave?.status?.toLowerCase() === 'pending';
  const showPay = pending && !!allowPaymentChoice;

  // Every row on this screen ends up here, so it has to behave like the history dialog the row's
  // other control opens. The hand-rolled Portal + motion.div was a dialog to nothing but the eye:
  // no role, no aria-modal, no Escape, and focus stayed on the card behind the backdrop, so Tab
  // walked the list underneath and a screen reader kept reading leaves. Radix gives all of that —
  // and hands focus back to the row that opened it — for free.
  return (
    <Dialog open={!!leave} onOpenChange={open => { if (!open) onClose(); }}>
      {leave && (
        // hideClose: the header already carries a close button with a comfortable tap target.
        <DialogContent hideClose className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md flex-col gap-0 overflow-hidden p-0">
          {/* Header */}
          <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex items-center gap-3 min-w-0">
              <div aria-hidden="true" className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center text-primary-foreground font-bold text-base flex-shrink-0 shadow-soft">
                {nameOf(leave).charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <DialogTitle className="truncate text-base font-bold leading-snug">{nameOf(leave)}</DialogTitle>
                <DialogDescription className="mt-0.5 flex items-center gap-1.5 text-[11px]">
                  <User aria-hidden="true" className="w-2.5 h-2.5 flex-shrink-0" /> {leave.epf_number}
                </DialogDescription>
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t.closeWord} className="rounded-lg flex-shrink-0">
              <X aria-hidden="true" className="w-4 h-4" />
            </Button>
          </div>

          {/* Body — the only scroll region, so a long reason cannot push the two buttons off a
              phone screen. */}
          <div className="min-h-0 flex-1 overflow-y-auto p-5 space-y-4">
            {/* Status + type badges */}
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={statusBadgeVariant(leave.status)}>
                {statusWord(leave.status, t)}
              </Badge>
              {leave.leave_type_name && (
                <Badge variant="muted">{leave.leave_type_name}</Badge>
              )}
              {leave.is_half_day && (
                <Badge variant="brand" className="capitalize">
                  {t.halfDay}{leave.half_day_period ? ` · ${leave.half_day_period}` : ''}
                </Badge>
              )}
            </div>

            {/* Date range */}
            <div className="rounded-xl bg-muted border border-border p-4 space-y-2">
              <div className="flex items-center gap-2">
                <CalendarDays aria-hidden="true" className="w-4 h-4 text-primary flex-shrink-0" />
                <span className="text-sm font-semibold text-foreground">{dateRange(leave)}</span>
              </div>
              <div className="flex items-center gap-2">
                <Clock aria-hidden="true" className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="text-xs text-muted-foreground">{dayCount(leave, t.dayWord, t.daysUnit)}</span>
              </div>
            </div>

            {/* Reason */}
            {leave.reason && (
              <div className="rounded-xl bg-muted border border-border p-4">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <FileText aria-hidden="true" className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide">{t.reasonLabel}</span>
                </div>
                <p className="text-sm text-foreground leading-relaxed">{leave.reason}</p>
              </div>
            )}

            {/* Payment — the approver decides paid vs unpaid (only for types that allow it) */}
            {showPay && (
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Wallet aria-hidden="true" className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide">{t.paymentLabel}</span>
                </div>
                <div className="flex gap-2">
                  {[{ val: true, label: t.paidWord }, { val: false, label: t.unpaidWord }].map(opt => (
                    <button key={opt.label} type="button" onClick={() => setIsPaid(opt.val)}
                      // Selected here is a border + tint, and success/warning are one azure away
                      // from each other — aria-pressed is what tells a screen reader which is on.
                      aria-pressed={isPaid === opt.val}
                      className={`flex-1 py-2 rounded-md text-sm font-semibold border transition-all ${
                        isPaid === opt.val
                          ? (opt.val ? 'bg-success/10 border-success/40 text-success' : 'bg-warning/10 border-warning/40 text-warning')
                          : 'bg-card border-border text-muted-foreground hover:text-foreground'
                      }`}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex flex-shrink-0 gap-3 p-4 border-t border-border">
            <Button
              variant="destructive" onClick={onReject} disabled={busy}
              className="flex-1 min-w-0"
            >
              <XCircle aria-hidden="true" className="w-4 h-4 flex-shrink-0" /> {t.rejectVerb}
            </Button>
            <Button
              variant="success" onClick={() => onApprove(showPay ? isPaid : undefined)} disabled={busy}
              className="flex-1 min-w-0"
            >
              {busy ? <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin flex-shrink-0" /> : <CheckCircle2 aria-hidden="true" className="w-4 h-4 flex-shrink-0" />}
              {t.approveVerb}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
