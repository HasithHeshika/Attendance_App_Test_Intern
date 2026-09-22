'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CalendarDays, ChevronDown, ChevronRight, Clock, FileText, Trash2, X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { _leaveApi as leaveApi } from '@/services/apiCompat';
import { cn, localDateString } from '@/lib/utils';
import { useT } from '@/store/appStore';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, ListSkeleton } from '@/components/ui/Skeleton';
import UsageMeter from '@/components/ui/UsageMeter';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { statusBadgeVariant, statusBucket, statusVisual, type LeaveStatusBucket } from './leaveStatus';

// ─── Shared leave shape ───────────────────────────────────────────────────────
// Exactly what buildMyLeavesList (apiCompat) returns for one leave. The leaves page's own
// `Leave` extends this, so the page and this dialog can never drift on field names.
export interface HistoryLeave {
  leave_id:        string | number;  // Firestore doc id (string) — never Number() it
  epf_number?:     string;
  employee_name?:  string;
  from_date:       string;
  to_date:         string;
  leave_type_name?: string;
  reason?:         string;
  status:          string;
  requested_from?: string | null;   // approver the leave was routed to (display name)
  consider_by?:    string | null;   // who decided it (display name)
  requested_at?:   string | null;   // ISO
  considered_at?:  string | null;   // ISO
  reject_reason?:  string | null;
  is_half_day?:    boolean;
  half_day_period?: string | null;
  is_paid?:        boolean;
  delete_request_status?: string | null;
  delete_request_reason?: string | null;
}

// ─── The window ───────────────────────────────────────────────────────────────
// The On Leave tab's "Search Employee" view and this dialog show the SAME slice of a person's
// record — 6 months back, 6 months forward — so the two can never disagree about what "their
// leave history" means. Both go through fetchEmployeeLeaveHistory below.
export const HISTORY_WINDOW_MONTHS = 6;

// `iso` shifted by `months` calendar months (negative = earlier).
function addMonths(iso: string, months: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setMonth(d.getMonth() + months);
  return localDateString(d);
}

export async function fetchEmployeeLeaveHistory(epf: string): Promise<HistoryLeave[]> {
  const today = localDateString();
  const res = await leaveApi.getEmployeeLeaveHistory(
    epf, addMonths(today, -HISTORY_WINDOW_MONTHS), addMonths(today, HISTORY_WINDOW_MONTHS),
  );
  const leaves = res.data?.data?.leaves;
  return Array.isArray(leaves) ? (leaves as HistoryLeave[]) : [];
}

// ─── The balance ──────────────────────────────────────────────────────────────
/**
 * What an approver is actually deciding against: how much of each entitlement is left. All of
 * this already arrives on the getLeaveSummary read — the old version summed one column and
 * threw the rest away, which is why the dialog could not answer "can they afford this
 * request?". No extra network call.
 */
type BalanceSummary = {
  remaining: number;
  used:      number;
  total:     number;
  pending:   number;
  byType:    { name: string; remaining: number; total: number }[];
  // Types that are tracked but are not entitlements (LeaveType.excluded_from_quota) — Medical
  // Leaves at Alta Vision. They never reach `byType` and never touch remaining/used/total: an
  // illness is not an allowance, so there is no "left of" to print and nothing here may widen
  // the quota. All the card can honestly say about them is how many days were taken.
  takenOnly: { name: string; taken: number }[];
};

// Returns null when the summary comes back in a shape we can't read, and the caller then simply
// omits the balance block rather than showing a zero it can't stand behind.
async function fetchRemainingBalance(epf: string): Promise<BalanceSummary | null> {
  const res = await leaveApi.getLeaveSummary(epf);
  const rows = res.data?.data;
  if (!Array.isArray(rows)) return null;
  const half = (n: unknown): number => Math.round((Number(n) || 0) * 2) / 2;
  const list = rows as { leave_type?: string; type?: string; total?: number; used?: number; remaining?: number }[];
  // The dashboard fields are Object.assign'd onto the array, so they need the cast.
  const extra = rows as unknown as {
    pending_leaves?:       number;
    pending_leaves_quota?: number;
    excluded_leave_types?: { leave_type?: string; type?: string; taken?: number }[];
  };
  return {
    // Non-entitlement types are already absent from `rows`, so none of these three sums can
    // include them — which is the whole point. Nothing here needs to know they exist.
    remaining: half(list.reduce((s, r) => s + (Number(r.remaining) || 0), 0)),
    used:      half(list.reduce((s, r) => s + (Number(r.used)      || 0), 0)),
    total:     half(list.reduce((s, r) => s + (Number(r.total)     || 0), 0)),
    // pending_leaves_quota is the share of the pending days that will actually draw on an
    // entitlement — the only kind this meter can measure. Falling back to pending_leaves keeps
    // a summary from before that field existed rendering exactly as it used to. It has to land
    // on 0 rather than NaN, or UsageMeter computes a NaN percentage and draws an empty bar.
    pending:   Number(extra.pending_leaves_quota ?? extra.pending_leaves) || 0,
    byType:    list.map(r => ({
      name:      String(r.leave_type ?? r.type ?? ''),
      remaining: half(r.remaining),
      total:     half(r.total),
    })),
    takenOnly: (Array.isArray(extra.excluded_leave_types) ? extra.excluded_leave_types : []).map(r => ({
      name:  String(r.leave_type ?? r.type ?? ''),
      taken: half(r.taken),
    })),
  };
}

// ─── Small helpers ────────────────────────────────────────────────────────────
// A leave's size in days, matching what the leave cards elsewhere already show: a half day is
// 0.5, anything else is the inclusive calendar span.
//
// Careful: this is NOT the same quantity as BalanceSummary.used. That one is calendar-year,
// business-day, paid-leave-only. This one is 12-month-window, calendar-day, every approved
// leave. They will disagree on the same person, they live in two separate bands, and no
// arithmetic may ever span the two.
function leaveDays(l: HistoryLeave): number {
  if (l.is_half_day) return 0.5;
  const from = new Date(l.from_date.slice(0, 10) + 'T00:00:00').getTime();
  const to   = new Date(l.to_date.slice(0, 10)   + 'T00:00:00').getTime();
  if (isNaN(from) || isNaN(to)) return 0;
  return Math.max(1, Math.round((to - from) / 86400000) + 1);
}

// Trim trailing ".0" so 3 days reads "3" and 3.5 reads "3.5".
const fmtDays = (n: number): string => String(Math.round(n * 2) / 2);

const formatDateTime = (iso?: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

// "September 2026" for a YYYY-MM key.
function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// "Fri, Sep 12" — the weekday is the whole point: three Fridays down the column is a habit you
// can see, and the app never has to assert a pattern it can't support from eight records. The
// year is dropped because the month header above already carries it. Parsed as local midnight
// rather than UTC so a YYYY-MM-DD string lands on the right weekday.
function dayDate(iso: string): string {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00');
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// "Mar 2026" — the two ends of the window, in the header.
function shortMonth(iso: string): string {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00');
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/**
 * A '{n}' template with the number in its own span. Sinhala puts the word BEFORE the number
 * ('ඉතිරි {n}' against English's '{n} left'), so building these by concatenation would scramble
 * word order in two of the three languages. Splitting on the placeholder keeps it honest.
 */
function TplNum({ tpl, value, numClass }: { tpl: string; value: string; numClass?: string }) {
  const i = tpl.indexOf('{n}');
  if (i === -1) return <>{tpl}</>;
  return <>{tpl.slice(0, i)}<span className={numClass}>{value}</span>{tpl.slice(i + 3)}</>;
}

// ─── The shared clickable name ────────────────────────────────────────────────
/**
 * An employee's name, everywhere the leaves page prints one, as the way into their history.
 * `children` renders under the name inside the same click target so a row can carry its EPF or
 * a count without adding a second thing to click.
 */
export function EmployeeNameButton({
  name, epf, onClick, className, children,
}: {
  name:      string;
  epf:       string;
  onClick:   () => void;
  className?: string;
  children?: ReactNode;
}) {
  const t = useT();
  // Composed from a translated noun rather than an English sentence — a Sinhala or Tamil
  // approver hears their own language, and no new TRANSLATIONS key is needed for it.
  const label = `${name} · ${t.epfNumber} ${epf} · ${t.leaveRecordsCount}`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'group/name min-w-0 text-left rounded-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className,
      )}
    >
      <span className="block truncate text-sm font-semibold text-foreground transition-colors group-hover/name:text-primary group-hover/name:underline group-hover/name:underline-offset-4">
        {name}
      </span>
      {children}
    </button>
  );
}

// ─── The answer block ─────────────────────────────────────────────────────────
/**
 * What is left, per type, tightest first. A supervisor holding a Medical Leave request needs
 * the Medical line — a grand total and a record count answer a different question.
 *
 * LeaveBalanceViz can't be reused here: it filters byType to remaining > 0, which hides exactly
 * the fact most likely to stop an approval. UsageMeter is used directly instead.
 */
function BalanceCard({ balance }: { balance: BalanceSummary }) {
  const t = useT();
  // Tightest remaining first — the type they are closest to exhausting is the one an approver
  // needs to see without scrolling.
  const typeRows = useMemo(
    () => [...balance.byType].sort((a, b) => a.remaining - b.remaining),
    [balance.byType],
  );
  // Four rows keep the card the height of the record behind it; the rest are a tap away rather
  // than a bare "+3" with no way to see what it is hiding.
  const [showAllTypes, setShowAllTypes] = useState(false);
  const shown = showAllTypes ? typeRows : typeRows.slice(0, 4);
  const extra = typeRows.length - shown.length;

  // Fuel-gauge escalation. These four are genuinely distinct hues — unlike primary / success /
  // brand, which all resolve to the same azure — and the number sits right above the bar anyway.
  //
  // The denominator is used + remaining, NOT the quota column: that is what UsageMeter draws its
  // 100% against, and it is what the dashboard's leave gauge already escalates on. Per-type
  // remaining is floored at 0, so an over-drawn employee has used + remaining > total — measuring
  // the tone against the quota there would tint the bar differently from the free segment beside
  // it, and the same person would read amber on this screen and azure on the dashboard.
  // Thresholds match dashboard/page.tsx for the same reason. Zero is not a full tank.
  const metered = balance.used + balance.remaining;
  const ratio = metered > 0 ? balance.remaining / metered : 0;
  const toneClass = ratio >= 0.5  ? 'text-brand'
    : ratio >= 0.3  ? 'text-warning'
    : ratio >= 0.12 ? 'text-warn-strong'
    : 'text-destructive';

  // The quota is only printed when it IS the meter's denominator. Over-drawn, "14 left of 20
  // days" sits above a bar whose whole width is 22 — two answers to one question, and the card
  // has no room to explain which is which.
  const showQuota = Math.abs(balance.total - metered) < 0.01 && balance.total > 0;

  return (
    <Card className="p-4">
      {/* No `uppercase`: it is a no-op in Sinhala and Tamil, and `tracking-widest` at 10px pulls
          their conjuncts apart. Weight and size carry the eyebrow on their own. */}
      <p className="text-[10px] font-bold tracking-wide text-muted-foreground">{t.leaveBalance}</p>

      <div className="sm:grid sm:grid-cols-[1fr_auto] sm:items-start sm:gap-5">
        <div>
          <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-base font-medium text-muted-foreground">
              <TplNum
                tpl={t.leaveAvailShort}
                value={fmtDays(balance.remaining)}
                numClass="text-3xl font-bold leading-none tabular-nums text-foreground"
              />
            </p>
            {showQuota && (
              <p className="text-xs text-muted-foreground">
                <TplNum tpl={t.ofDaysHint} value={fmtDays(balance.total)} />
              </p>
            )}
          </div>

          <div className="mt-3">
            {/* showLeft={false}: the hero above already prints the remaining balance, and the
                meter would print the same number again as "14.0 left" twelve pixels under a
                "14 left" — one figure, two formats, in one card. */}
            <UsageMeter
              used={balance.used}
              pending={balance.pending}
              remaining={balance.remaining}
              // NOT t.takenLabel, and that is the whole point. This figure is entitlement drawn
              // down: paid leave only, counted in working days, and it already includes approved
              // leave that has not happened yet. The days-away figures further down the dialog
              // are calendar days in a rolling window. Both ended in the word "taken", so the
              // same person read 5.0 here and 10 there with each number correct and nothing on
              // screen admitting they were different quantities. This word names the quota the
              // number is measured against; the footnote below names its unit and its window.
              takenLabel={t.lvhUsedOfQuota}
              pendingLabel={t.pendingShort}
              showLeft={false}
              className={toneClass}
            />
            {/* The unit and the window, spelled out once for the whole card — the hero, the bar
                and the per-type rows are all this same quantity. Kept out of the eyebrow because
                it is a sentence, not a title, and the eyebrow is 10px bold. */}
            <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">{t.lvhQuotaFootnote}</p>
          </div>
        </div>

        {(shown.length > 0 || balance.takenOnly.length > 0) && (
          <div className="mt-3 space-y-1 sm:mt-1.5 sm:min-w-[12rem]">
            {shown.map((row, i) => (
              // The figure is built from two translated templates, so its width is a locale
              // question — nowrap on it meant Tamil and Sinhala took the room they needed and the
              // type name absorbed every pixel of the loss, on the one row whose job is to name
              // which entitlement is nearly gone. Both children shrink now; the figure wraps.
              <div key={`${row.name}-${i}`} className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="min-w-0 truncate text-muted-foreground">
                  {row.name || t.typeFallback.replace('{n}', String(i + 1))}
                </span>
                <span className="min-w-0 text-right text-muted-foreground">
                  <TplNum
                    tpl={t.leaveAvailShort}
                    value={fmtDays(row.remaining)}
                    numClass={cn(
                      'font-semibold tabular-nums',
                      row.remaining === 0 ? 'text-warn-strong' : 'text-foreground',
                    )}
                  />
                  {' '}
                  <TplNum tpl={t.ofDaysHint} value={fmtDays(row.total)} />
                </span>
              </div>
            ))}
            {(extra > 0 || showAllTypes) && (
              <button
                type="button"
                aria-expanded={showAllTypes}
                onClick={() => setShowAllTypes(v => !v)}
                className="flex min-h-9 items-center gap-1 rounded-sm text-[10px] font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <ChevronDown aria-hidden className={cn('h-3 w-3 transition-transform motion-reduce:transition-none', showAllTypes && 'rotate-180')} />
                {showAllTypes ? t.collapseDetails : `+${extra}`}
              </button>
            )}

            {/* Tracked, but not an entitlement. These types have no quota for a figure to be
                "left of", so what is printed is days TAKEN — and the distinction is carried by
                the words, because it has to be: --success, --primary and --brand are all the
                same azure here, so a colour could not tell the two kinds of number apart. The
                rule above the group does the rest, keeping a taken figure from being read down
                the column as another remaining one. */}
            {balance.takenOnly.length > 0 && (
              <div className={cn('space-y-1', shown.length > 0 && 'mt-2 border-t border-border/60 pt-2')}>
                {balance.takenOnly.map((row, i) => (
                  <div key={`taken-${row.name}-${i}`} className="flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="min-w-0 truncate text-muted-foreground">
                      {/* Numbered on from the quota rows above, so two unnamed types never both
                          come out as "Type 1". */}
                      {row.name || t.typeFallback.replace('{n}', String(typeRows.length + i + 1))}
                    </span>
                    <span className="min-w-0 text-right text-muted-foreground">
                      <TplNum
                        tpl={t.takenDaysShort}
                        value={fmtDays(row.taken)}
                        numClass="font-semibold tabular-nums text-foreground"
                      />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── One leave row ────────────────────────────────────────────────────────────
function HistoryRow({ leave, canApprove }: { leave: HistoryLeave; canApprove: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const sv = statusVisual(leave.status);
  const bucket = statusBucket(leave.status);
  const from = leave.from_date.slice(0, 10);
  const to   = leave.to_date.slice(0, 10);
  const period = leave.half_day_period === 'afternoon' ? t.periodAfternoon : t.periodMorning;
  const days = leaveDays(leave);

  // The translated status word where we recognise the status, the backend's own spelling where
  // we don't. Approved rows carry no badge (they were seven rows out of eight of pure
  // repetition), so this word is what the icon means — and an icon in a hue that equals
  // --primary cannot say "approved" on its own. Hence the sr-only copy on line 1.
  const statusWord = bucket === 'approved' ? t.approved
    : bucket === 'pending'  ? t.pending
    : bucket === 'rejected' ? t.rejectedPrefix
    : leave.status;

  // Who it went to, who decided it, why it was turned down — the trail an approver needs and
  // nobody else does.
  const hasTrail = canApprove && !!(leave.requested_from || leave.consider_by || leave.requested_at
    || leave.considered_at || leave.reject_reason || leave.delete_request_status);
  // A clamped reason is worth expanding even for someone with no approver trail to read. The
  // threshold is the narrowest case, not the widest: two lines of 12px text in a 288px phone
  // column is roughly 80 characters, and 120 left every reason between the two silently cut off
  // with no control to open it.
  const longReason = !!leave.reason && leave.reason.length > 80;
  const canExpand = hasTrail || longReason;

  const deletionPending = canApprove && leave.delete_request_status === 'pending';
  const showBadgeLine = bucket !== 'approved' || !!leave.leave_type_name || !!leave.is_half_day || deletionPending;

  return (
    <Card className={cn('border-l-[3px] p-3 sm:p-3.5', sv.accent, bucket === 'pending' && 'ring-1 ring-warning/30')}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {/* aria-hidden throughout this file: lucide sets no such attribute of its own, so every
            icon is a bare <svg> a screen reader can announce — and the sr-only word on the next
            line exists precisely so the icon never has to carry the status. */}
        <sv.Icon aria-hidden className={cn('h-4 w-4 shrink-0 self-center', sv.text)} />
        <span className="sr-only">{statusWord}</span>
        <span className="text-sm font-semibold text-foreground">{dayDate(from)}</span>
        {from !== to && (
          <>
            <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">{dayDate(to)}</span>
          </>
        )}
        <span className="ml-auto shrink-0 text-[11px] font-semibold tabular-nums text-muted-foreground">
          {fmtDays(days)} {days === 1 ? t.dayWord : t.daysUnit}
        </span>
      </div>

      {showBadgeLine && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {bucket !== 'approved' && (
            <Badge variant={statusBadgeVariant(leave.status)} className="gap-1 capitalize">
              <sv.Icon aria-hidden className="h-3 w-3" />{statusWord}
            </Badge>
          )}
          {leave.leave_type_name && <span>{leave.leave_type_name}</span>}
          {/* The separator belongs to the type name before it — without a type name the line
              used to open with a dangling "· half day". */}
          {leave.is_half_day && (
            <span className="lowercase">{leave.leave_type_name ? '· ' : ''}{t.halfDay} · {period}</span>
          )}
          {/* An approver should not have to expand a row to learn the leave is being un-booked. */}
          {deletionPending && (
            <Badge variant="warning" className="gap-1"><Trash2 aria-hidden className="h-3 w-3" />{t.deletionPendingBadge}</Badge>
          )}
        </div>
      )}

      {/* One copy of the reason, in one place. It used to render clamped here AND in full inside
          the panel, so expanding a long reason printed the same first two lines twice. Opening
          the row simply unclamps it. */}
      {leave.reason && (
        <p className={cn(
          'mt-1.5 text-xs leading-relaxed',
          open ? 'text-foreground' : 'line-clamp-2 text-muted-foreground',
        )}>
          {leave.reason}
        </p>
      )}

      {canExpand && (
        <>
          <button
            type="button"
            aria-expanded={open}
            // Eight rows of a button called "Show details" are indistinguishable in a screen
            // reader's element list, so the name carries the day the row is about.
            aria-label={`${open ? t.collapseDetails : t.expandDetails}, ${dayDate(from)}`}
            onClick={() => setOpen(o => !o)}
            className="mt-1.5 -mb-0.5 flex min-h-9 w-full items-center justify-start gap-1 rounded-sm text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <ChevronDown aria-hidden className={cn('h-3.5 w-3.5 transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
            {open ? t.collapseDetails : t.expandDetails}
          </button>
          {/* hasTrail as well as open: a row that expands only to unclamp a long reason has
              nothing to put in this panel, and an empty ruled box under it reads as a failure. */}
          {open && hasTrail && (
            <div className="mt-2 space-y-1.5 border-t border-border pt-2 text-[11px] text-muted-foreground">
              {(leave.requested_from || leave.requested_at) && (
                <p>
                  {t.requestedToLabel}: <span className="font-medium text-foreground">{leave.requested_from ?? '—'}</span>
                  {leave.requested_at && <span className="ml-1.5 inline-flex items-center gap-1"><Clock aria-hidden className="h-2.5 w-2.5" />{formatDateTime(leave.requested_at)}</span>}
                </p>
              )}
              {(leave.consider_by || leave.considered_at) && (
                <p>
                  {t.consideredWord} {t.byLabel}: <span className="font-medium text-foreground">{leave.consider_by ?? '—'}</span>
                  {leave.considered_at && <span className="ml-1.5 inline-flex items-center gap-1"><Clock aria-hidden className="h-2.5 w-2.5" />{formatDateTime(leave.considered_at)}</span>}
                </p>
              )}
              {leave.reject_reason && (
                // Composed from two keys that already exist in all three languages, rather
                // than an English sentence sitting inside a Sinhala or Tamil dialog.
                <p className="text-destructive">{t.rejectedPrefix} · {t.reasonLabel}: {leave.reject_reason}</p>
              )}
              {leave.delete_request_status === 'rejected' && (
                <div className="space-y-1">
                  <Badge variant="destructive" className="gap-1"><Trash2 aria-hidden className="h-3 w-3" />{t.deletionRejectedBadge}</Badge>
                  {leave.delete_request_reason && <p>{leave.delete_request_reason}</p>}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ─── Filter chip ──────────────────────────────────────────────────────────────
// Two filter dimensions share one band, so they are told apart by SHAPE — squared for status,
// pill for leave type. Hue can't do it: --primary, --success and --brand are the same azure.
function Chip({
  active, onClick, shape = 'square', children,
}: {
  active:   boolean;
  onClick:  () => void;
  shape?:   'square' | 'pill';
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex min-h-9 items-center gap-1 border px-3 py-1.5 text-[11px] font-semibold transition-colors sm:min-h-8',
        shape === 'pill' ? 'rounded-full' : 'rounded-md',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        // Active is a lightness inversion, not a 5% tint of a hue: --primary and
        // --muted-foreground sit within 0.05 relative luminance of each other, so the old
        // tinted-text active state was invisible in greyscale and to a colour-blind viewer.
        // Filled vs outlined survives both.
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-card text-muted-foreground hover:border-ring hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

// Weight, not opacity, separates the count from the label: opacity-70 on muted-foreground
// measures 2.7:1 in light theme, and it de-emphasises nothing in greyscale.
const ChipCount = ({ n }: { n: number }) => <span className="ml-1 font-normal tabular-nums">{n}</span>;

// ─── The dialog ───────────────────────────────────────────────────────────────
// 'other' is in here because statusBucket can produce it and the old chip row couldn't: a leave
// with an unrecognised status counted towards All and matched nothing, so the chips could
// silently fail to add up with no way to see why.
type StatusFilter = 'all' | LeaveStatusBucket;

export default function EmployeeLeaveHistoryDialog({
  open, onOpenChange, epf, name, canApprove,
}: {
  open:         boolean;
  onOpenChange: (open: boolean) => void;
  epf:          string;
  name:         string;
  canApprove:   boolean;
}) {
  const t = useT();
  const [leaves,  setLeaves]  = useState<HistoryLeave[]>([]);
  const [balance, setBalance] = useState<BalanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed,  setFailed]  = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [typeFilter,   setTypeFilter]   = useState<string>('');   // '' = every type

  // `load` used to depend on `t`, so switching language while the dialog was open changed t's
  // identity, changed load, and refired the effect below — a full refetch for a toast string.
  const tRef = useRef(t);
  tRef.current = t;

  // One dialog instance serves the whole leaves page, so tapping name A on a slow connection,
  // closing, then tapping name B leaves A's read in flight. It resolves last and used to commit
  // A's leaves and A's balance under B's name, avatar and EPF, with nothing on screen admitting
  // it. Every read carries a token; a response whose token is no longer current is dropped.
  const reqId = useRef(0);

  const load = useCallback(async () => {
    if (!epf) return;
    const myReq = ++reqId.current;
    setLoading(true);
    setFailed(false);
    // The record and the balance are independent reads — a missing balance document must not
    // cost the approver the history they actually opened this for.
    const [leavesR, balanceR] = await Promise.allSettled([
      fetchEmployeeLeaveHistory(epf),
      fetchRemainingBalance(epf),
    ]);
    if (myReq !== reqId.current) return;   // pointed at someone else since — this answer is stale
    if (leavesR.status === 'fulfilled') {
      setLeaves(leavesR.value);
    } else {
      console.error('[leaves] employee history failed', leavesR.reason);
      setLeaves([]);
      setFailed(true);
      toast.error(tRef.current.actionFailed);
    }
    setBalance(balanceR.status === 'fulfilled' ? balanceR.value : null);
    setLoading(false);
  }, [epf]);

  // Load on open and whenever the dialog is pointed at a different person. Closing wipes
  // everything so a reopen re-reads rather than flashing the previous employee's record.
  useEffect(() => {
    if (!open) {
      // Closing can't cancel an in-flight read, but it can make sure the answer is discarded.
      reqId.current += 1;
      setLeaves([]); setBalance(null); setFailed(false); setLoading(true);
      setStatusFilter('all'); setTypeFilter('');
      return;
    }
    load();
  }, [open, load]);

  // Newest first, by the day the leave starts.
  const sorted = useMemo(
    () => [...leaves].sort((a, b) => b.from_date.localeCompare(a.from_date)),
    [leaves],
  );

  const counts = useMemo(() => {
    const today = localDateString();
    const c: Record<LeaveStatusBucket, number> = { approved: 0, pending: 0, rejected: 0, other: 0 };
    let takenPast = 0, bookedAhead = 0;
    sorted.forEach(l => {
      const b = statusBucket(l.status);
      c[b] += 1;
      // Split at today so "7 days" stops silently mixing days already taken with days merely
      // booked. The two still sum to the same 7 — nothing new is being claimed. A leave that
      // straddles today counts wholly as taken, because its from_date is behind us.
      if (b === 'approved') {
        if (l.from_date.slice(0, 10) <= today) takenPast += leaveDays(l);
        else bookedAhead += leaveDays(l);
      }
    });
    return {
      ...c,
      takenPast:   Math.round(takenPast   * 2) / 2,
      bookedAhead: Math.round(bookedAhead * 2) / 2,
    };
  }, [sorted]);

  // The pending leave that has waited longest — `sorted` is newest-first, so it is the last one.
  const oldestPending = useMemo(() => {
    const p = sorted.filter(l => statusBucket(l.status) === 'pending');
    return p.length ? p[p.length - 1] : null;
  }, [sorted]);

  // A status nobody has a translated word for still needs a chip; label it with the backend's
  // own spelling rather than pretending the bucket doesn't exist. Every distinct spelling, not
  // just the first — one `cancelled` and two `withdrawn` used to read "cancelled 3", which is
  // the same silent mismatch between a label and its count the bucket was added to end.
  const otherLabel = useMemo(() => {
    const seen: string[] = [];
    sorted.forEach(l => {
      if (statusBucket(l.status) === 'other' && l.status && !seen.includes(l.status)) seen.push(l.status);
    });
    return seen.join(' / ');
  }, [sorted]);

  // Nothing to filter when every record sits in the same bucket.
  const showStatusChips = useMemo(
    () => (['approved', 'pending', 'rejected', 'other'] as const).filter(b => counts[b] > 0).length > 1,
    [counts],
  );

  // Only the leave types this person actually has on record — never the types they are merely
  // entitled to. Conflating the two is what put "3 Leave Type" under a balance of 14.
  const presentTypes = useMemo(() => {
    const seen: string[] = [];
    sorted.forEach(l => {
      const n = l.leave_type_name;
      if (n && !seen.includes(n)) seen.push(n);
    });
    return seen.sort((a, b) => a.localeCompare(b));
  }, [sorted]);

  const visible = useMemo(() => sorted.filter(l => {
    if (statusFilter !== 'all' && statusBucket(l.status) !== statusFilter) return false;
    if (typeFilter && l.leave_type_name !== typeFilter) return false;
    return true;
  }), [sorted, statusFilter, typeFilter]);

  // Month key → its leaves, newest month first (the list is already sorted).
  const months = useMemo(() => {
    const out: { key: string; rows: HistoryLeave[] }[] = [];
    visible.forEach(l => {
      const key = l.from_date.slice(0, 7);
      const last = out[out.length - 1];
      if (last && last.key === key) last.rows.push(l);
      else out.push({ key, rows: [l] });
    });
    return out;
  }, [visible]);

  // The row the reverse-chronological list crosses today on — the first one dated today or
  // earlier, and only when something above it is still in the future. A rule with nothing on
  // one side of it says nothing, so an all-past or all-future record gets none. Matching on the
  // id rather than an index keeps it working across the month groups it may fall inside.
  const todayRowId = useMemo(() => {
    const today = localDateString();
    const i = visible.findIndex(l => l.from_date.slice(0, 10) <= today);
    return i > 0 ? String(visible[i].leave_id) : null;
  }, [visible]);

  const filtersOff = statusFilter === 'all' && typeFilter === '';
  const pendingActive = statusFilter === 'pending';
  const clearFilters = useCallback(() => { setStatusFilter('all'); setTypeFilter(''); }, []);
  const today = localDateString();
  const thisMonthKey = today.slice(0, 7);

  const windowLabel = useMemo(() => {
    const d = localDateString();
    return `${shortMonth(addMonths(d, -HISTORY_WINDOW_MONTHS))} – ${shortMonth(addMonths(d, HISTORY_WINDOW_MONTHS))}`;
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* max-w-none has to land before sm:max-w-2xl so twMerge drops DialogContent's own
          max-w-lg cleanly. The width steps stop at sm: on purpose — see the header comment on
          the filter band; lg: is a viewport query and this box is never wider than 672px. */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-1rem)] max-w-none flex-col gap-0 p-0 sm:w-[calc(100%-2rem)] sm:max-w-2xl">
        {/* Header */}
        <DialogHeader className="flex-shrink-0 border-b border-border px-4 py-3.5 pr-12 sm:px-5 sm:py-4 sm:pr-14">
          <div className="flex items-center gap-3">
            {/* Decorative — the name it initialises is the very next thing read out, and `??`
                never fired here: ''.charAt(0) is an empty string, not undefined, so a blank
                name produced an empty azure square instead of the intended '?'. */}
            <div aria-hidden className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary text-base font-bold text-primary-foreground sm:h-11 sm:w-11">
              {(name?.trim()?.charAt(0) || '?').toUpperCase()}
            </div>
            <div className="min-w-0">
              {/* Wraps rather than truncates. Sri Lankan full names routinely pass the ~26
                  characters this box fits at 360px, and this is the one label the approver
                  must be able to read in full — it is also the dialog's accessible name, so
                  truncating it showed a sighted user less than a screen reader was given.
                  The header is flex-shrink-0 and outside the scroll region: a second line
                  costs nothing. */}
              <DialogTitle className="line-clamp-2 break-words text-base leading-snug">{name}</DialogTitle>
              {/* The two months the window actually resolves to, instead of an English sentence
                  describing it. More precise, and it needs no translation key. */}
              <DialogDescription className="text-[11px]">
                {t.epfNumber} {epf} · {windowLabel}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Body — the only scroll region in the dialog. Nothing inside it scrolls or sticks.
            tabIndex/role: every focusable thing in here is conditional (chips need two buckets,
            the Details toggle needs a trail or a long reason), so a clean single-type record
            leaves a scroller with nothing to tab to — and outside Chrome that means a keyboard
            user cannot reach the bottom of the list at all. */}
        <div
          tabIndex={0}
          role="region"
          aria-label={t.leaveRecordsCount}
          aria-busy={loading}
          className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 py-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:space-y-4 sm:px-5 sm:py-4"
        >
          {loading ? (
            <div className="space-y-4">
              {/* Shaped like what actually arrives. The old StatCardsSkeleton hardcodes a
                  4-column grid and never matched the strip it stood in for, so the layout
                  jumped on settle. Skeleton is aria-hidden, so without this line the whole
                  region is empty to a screen reader for the seconds the read takes. */}
              <span className="sr-only">{t.loading}</span>
              <Skeleton className="h-[124px] w-full rounded-xl" />
              <Skeleton className="h-8 w-3/4 rounded-md" />
              <ListSkeleton rows={4} />
            </div>
          ) : failed ? (
            <EmptyState
              icon={CalendarDays}
              title={t.actionFailed}
              action={<Button variant="outline" size="sm" onClick={load}>{t.tryAgain}</Button>}
            />
          ) : sorted.length === 0 ? (
            <EmptyState icon={CalendarDays} title={t.noLeaveHistoryFound} />
          ) : (
            <>
              {/* The answer block. Omitted entirely when the balance read failed — better no
                  number than an invented zero. */}
              {balance && (balance.total > 0 || balance.used > 0 || balance.remaining > 0
                           // A tenant whose every type is tracked-but-not-entitled has no quota
                           // at all, and the card still has something true to say.
                           || balance.takenOnly.length > 0) ? (
                <BalanceCard balance={balance} />
              ) : (
                // …but say so, or a failed read reads as "this person has no entitlement". No
                // retry button: the balance re-reads on every reopen, and a second failing
                // control beside a working record is just noise.
                //
                // An all-zero summary lands here too, and it is NOT a failure: getLeaveSummary
                // always returns an array, so a person with no readable entitlement (every type
                // filtered out, or every quota resolving to 0) arrives as {0,0,0}. Through the
                // card that drew a full-width azure bar over the words "0 left of 0 days" — a
                // healthy fuel gauge for an empty tank.
                <p className="px-0.5 text-[11px] text-muted-foreground">
                  {t.leaveBalance} · {balance ? t.noData : t.actionFailed}
                </p>
              )}

              {/* The thing they opened the dialog for, named rather than tallied. The count
                  belongs to the Pending chip below; this is a pointer. */}
              {counts.pending > 0 && oldestPending && (
                <button
                  type="button"
                  aria-pressed={pendingActive}
                  // Engaging this drops the type pill too: "Pending" plus a type that has no
                  // pending leave lands straight on an empty list with the call-out still
                  // reading pressed, and no visible reason why.
                  onClick={() => { setStatusFilter(f => (f === 'pending' ? 'all' : 'pending')); setTypeFilter(''); }}
                  className={cn(
                    // The sentence is text-foreground, not text-warning: amber-on-amber measures
                    // ~2.9:1 in light theme at 12px. The amber icon and border carry the state —
                    // non-text, so 3:1 is the bar they have to clear.
                    'flex min-h-9 w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                    // Pressed had no visual form at all — the list silently shortened and the
                    // control that did it looked untouched.
                    pendingActive
                      ? 'border-warning bg-warning/15 font-semibold'
                      : 'border-warning/40 bg-warning/[0.07] hover:bg-warning/10',
                  )}
                >
                  <Clock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  {/* Wraps instead of truncating, and shares dayDate with the rows below: the
                      Sinhala and Tamil words for "pending" are wider than the English, so the
                      leave type — the part that says what is waiting — was ellipsized first. */}
                  <span className="min-w-0 flex-1">
                    {t.pending} · {dayDate(oldestPending.from_date)}
                    {oldestPending.leave_type_name ? ` · ${oldestPending.leave_type_name}` : ''}
                  </span>
                  {pendingActive && <X aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />}
                </button>
              )}

              {/* Days, in the window, on calendar days — deliberately a different unit system
                  from the balance card above (entitlement, working days) and from the chips
                  below (records). No number is printed twice. */}
              {(counts.takenPast > 0 || counts.bookedAhead > 0) && (
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-0.5 text-[11px] text-muted-foreground">
                  {/* What these days ARE, then the window they cover, in one unbreakable span.
                      The band used to be the window alone, and both figures ended in the word
                      the balance card also uses — so a supervisor met "5.0 taken" in the card
                      and "10 days taken" three inches below it, both true, of two different
                      quantities. Naming the quantity is what makes the pair readable; the
                      window is what makes each half of it checkable. */}
                  <span className="font-medium text-foreground">{t.lvhCalendarBand} · {windowLabel}</span>
                  {counts.takenPast > 0 && (
                    <span>
                      <span className="font-semibold tabular-nums text-foreground">{fmtDays(counts.takenPast)}</span>
                      {' '}{counts.takenPast === 1 ? t.dayWord : t.daysUnit} {t.lvhAwaySoFar}
                    </span>
                  )}
                  {/* Suffixed like the figure before it rather than prefixed with "Upcoming":
                      two figures that differ only in their last words are read as one pair, and
                      "booked ahead" says that nobody has been anywhere yet — which "Upcoming"
                      left the reader to infer. */}
                  {counts.bookedAhead > 0 && (
                    <span>
                      <span className="font-semibold tabular-nums text-foreground">{fmtDays(counts.bookedAhead)}</span>
                      {' '}{counts.bookedAhead === 1 ? t.dayWord : t.daysUnit} {t.lvhBookedAhead}
                    </span>
                  )}
                </div>
              )}

              {/* Filters — one band, two labelled groups, wrapping rather than scrolling. */}
              {(showStatusChips || presentTypes.length > 1) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {showStatusChips && (
                    <div role="group" aria-label={t.statusLabel} className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
                      <Chip active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>
                        {t.allWord}<ChipCount n={sorted.length} />
                      </Chip>
                      {/* Zero-count chips are never rendered — "Rejected 0" was taking a full
                          tile's worth of attention for a fact nobody needs. */}
                      {counts.approved > 0 && (
                        <Chip active={statusFilter === 'approved'} onClick={() => setStatusFilter('approved')}>
                          {t.approved}<ChipCount n={counts.approved} />
                        </Chip>
                      )}
                      {counts.pending > 0 && (
                        <Chip active={statusFilter === 'pending'} onClick={() => setStatusFilter('pending')}>
                          {t.pending}<ChipCount n={counts.pending} />
                        </Chip>
                      )}
                      {counts.rejected > 0 && (
                        <Chip active={statusFilter === 'rejected'} onClick={() => setStatusFilter('rejected')}>
                          {t.rejectedPrefix}<ChipCount n={counts.rejected} />
                        </Chip>
                      )}
                      {counts.other > 0 && (
                        <Chip active={statusFilter === 'other'} onClick={() => setStatusFilter('other')}>
                          <span className="capitalize">{otherLabel}</span><ChipCount n={counts.other} />
                        </Chip>
                      )}
                    </div>
                  )}

                  {/* hidden on mobile so it can never dangle at the end of a wrapped line. */}
                  {showStatusChips && presentTypes.length > 1 && (
                    <span aria-hidden className="mx-0.5 hidden h-5 w-px bg-border sm:block" />
                  )}

                  {presentTypes.length > 1 && (
                    <div role="group" aria-label={t.leaveTypeLabel} className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
                      {/* No "All types" chip — tapping the active pill clears it, and the X makes
                          that discoverable instead of hidden. No counts either: records are
                          already counted once, in the status group. */}
                      {presentTypes.map(name => (
                        <Chip
                          key={name}
                          shape="pill"
                          active={typeFilter === name}
                          onClick={() => setTypeFilter(f => (f === name ? '' : name))}
                        >
                          {name}
                          {typeFilter === name && <X aria-hidden className="h-3 w-3" />}
                        </Chip>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Leaves, newest month first */}
              {visible.length === 0 ? (
                // A filtered-empty list is not an empty record. Both used to print "No leave
                // records found in this period", so a supervisor who had narrowed to Pending +
                // Annual Leave was told this person has no history — with twelve leaves behind
                // the filter and nothing offering to lift it.
                <EmptyState
                  icon={FileText}
                  title={t.noMatchesFound}
                  action={<Button variant="outline" size="sm" className="min-h-9" onClick={clearFilters}>{t.clearAll}</Button>}
                />
              ) : (
                <div className="space-y-5">
                  {months.map(({ key, rows }) => {
                    // Approved rows only — the old subtotal summed rejected leaves into a
                    // "days" figure. And it is suppressed under a filter, because a days-taken
                    // number beside a list of pending rows is simply untrue.
                    const approvedRows = rows.filter(l => statusBucket(l.status) === 'approved');
                    // Split at today, exactly the way the window summary above does. The old
                    // subtotal summed the whole month and only dropped the word "taken" when
                    // EVERY row was ahead of us — so the current month, the one a decision is
                    // being made in, printed its future leave as already taken and contradicted
                    // the summary three inches above it.
                    const takenDays = approvedRows
                      .filter(l => l.from_date.slice(0, 10) <= today)
                      .reduce((s, l) => s + leaveDays(l), 0);
                    const aheadDays = approvedRows
                      .filter(l => l.from_date.slice(0, 10) > today)
                      .reduce((s, l) => s + leaveDays(l), 0);
                    return (
                      <div key={key} className="space-y-2">
                        <div className="flex flex-wrap items-baseline justify-between gap-2 px-0.5">
                          {/* No `uppercase` — see the balance card's eyebrow. */}
                          <h3 className="flex items-baseline gap-2 text-xs font-bold tracking-wide text-muted-foreground">
                            {monthLabel(key)}
                            {key > thisMonthKey && <Badge variant="muted" className="font-medium normal-case">{t.upcomingWord}</Badge>}
                          </h3>
                          {filtersOff && (takenDays > 0 || aheadDays > 0) && (
                            // min-w-0 rather than shrink-0, and the row wraps: these words are
                            // longer than the single one they replace and longer again in
                            // Sinhala and Tamil, and a subtotal that cannot shrink pushes the
                            // month name it belongs to out of the row. Now it drops to its own
                            // line when it has to, held to the right edge by ml-auto so it stays
                            // the month's subtotal rather than looking like a new heading.
                            <span className="ml-auto min-w-0 text-right text-[11px] tabular-nums text-muted-foreground">
                              {takenDays > 0 && (
                                <>{fmtDays(takenDays)} {takenDays === 1 ? t.dayWord : t.daysUnit} {t.lvhAwayWord}</>
                              )}
                              {takenDays > 0 && aheadDays > 0 && ' · '}
                              {aheadDays > 0 && (
                                <>{fmtDays(aheadDays)} {aheadDays === 1 ? t.dayWord : t.daysUnit} {t.lvhBookedAhead}</>
                              )}
                            </span>
                          )}
                        </div>
                        <div className="space-y-2">
                          {rows.map(l => (
                            <div key={String(l.leave_id)}>
                              {/* The first admission anywhere in this dialog that half the
                                  window is in the future. */}
                              {todayRowId === String(l.leave_id) && (
                                <div role="separator" aria-label={t.todayWord} className="flex items-center gap-2 pb-3 pt-1">
                                  <span aria-hidden className="h-px flex-1 bg-border" />
                                  <span className="text-[10px] font-bold tracking-wide text-muted-foreground">{t.todayWord}</span>
                                  <span aria-hidden className="h-px flex-1 bg-border" />
                                </div>
                              )}
                              <HistoryRow leave={l} canApprove={canApprove} />
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-2.5 sm:px-5 sm:py-3">
          {/* A live region, and one that always has a sentence in it: filtering rewrote the whole
              list with nothing announced, and an element that blinks between empty and populated
              is not reliably picked up. It also gives the record count a permanent home — the All
              chip is suppressed whenever every leave sits in one status bucket, which is the
              common case for a clean record. */}
          <p role="status" aria-live="polite" className="min-w-0 text-[11px] text-muted-foreground">
            {loading ? t.loading
              : failed ? ''
              : !filtersOff ? t.shownTpl.replace('{n}', String(visible.length))
              : sorted.length > 0 ? `${sorted.length} ${t.leaveRecordsCount}`
              : ''}
          </p>
          <Button variant="outline" size="sm" className="min-h-9" onClick={() => onOpenChange(false)}>{t.closeWord}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
