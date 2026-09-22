'use client';
import { create } from 'zustand';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { getPendingApprovals } from '@/services/attendanceService';
import {
  getPendingSubmissions, getPendingCloseRequests, getPendingSupervisorRequests,
  getPendingCategoryRequests, getAllRequestsForApprovals, requestIsReadyForApprover,
} from '@/services/suspenseService';
import { getPendingOtRequestsForApprover } from '@/services/otRequestService';

// "Is there anything waiting for me on that page?" — the counts the sidebar puts next to a nav
// row. Only queues the signed-in user can actually act on are counted; a number nobody can
// clear is just noise.
//
// Cost matters here: this runs for every signed-in user on every page, and the backend is
// shared by 300+ of them. So the counts are TTL-cached, every query is capability-gated (a
// non-approver fires none of them at all), and a page with no queue simply has no badge — no
// attempt is made to count "things on that page" in general.

export interface NavBadgeCounts {
  approvals: number;   // /approvals   — attendance edit/approval queue
  leaves:    number;   // /leaves      — leave requests waiting on me as supervisor
  suspense:  number;   // /suspense    — expense + credit + close queues, incl. the stage-1
                       //                (supervisor) and stage-2 (category approver) items that
                       //                are mine regardless of any suspense capability
  ot:        number;   // /ot-requests
}

const EMPTY: NavBadgeCounts = { approvals: 0, leaves: 0, suspense: 0, ot: 0 };

/** How long a set of counts is good enough for. Long on purpose — a badge 90 seconds stale
 *  costs nothing; re-querying five collections on every route change costs a lot. */
const TTL_MS = 2 * 60 * 1000;

export interface BadgeContext {
  epf:        string;
  companyId:  string;
  canApproveAttendance: boolean;
  canApproveLeaves:     boolean;
  canApproveSuspense:   boolean;
  canApproveOt:         boolean;
  /** The suspense FEATURE flag only. Two of its queues (supervisor sign-off, category credit
   *  approver) belong to users with no suspense account and no capability, so this must not be
   *  narrowed to those — the approver-only queries are gated on canApproveSuspense instead. */
  suspenseOn: boolean;
  payrollOn:  boolean;
}

interface NavBadgesState {
  counts:     NavBadgeCounts;
  loadedAt:   number;
  loading:    boolean;
  load:       (ctx: BadgeContext, force?: boolean) => Promise<void>;
  /** Drop the cache so the next load re-queries — for after acting on a queue. */
  invalidate: () => void;
}

const count = async (p: Promise<unknown[]>): Promise<number> => {
  try { return (await p).length; } catch { return 0; }
};

/**
 * The leave requests waiting on this viewer — the SAME call the /leaves Team tab makes
 * (leaves/page.tsx: `leaveApi.getLeaveRequests`).
 *
 * The badge and the tab must answer one question, so they call one function. That function owns
 * the tenant fork (elsewhere: the supervisor the applicant picked; Southern Lanka: the live
 * approver union of department HOD plus every rung of the escalation ladder) and the management
 * bypass. A count from a second query can disagree with the list it points at — and disagree in
 * the hiding direction, which is how a request waits behind a badge reading 0.
 *
 * That is not hypothetical: this used to call leaveService.getLeaveRequests, a
 * `supervisor_epf == me && status == pending` query with an orderBy that needs a composite index
 * nobody ever deployed. Every call threw FAILED_PRECONDITION, `count()` swallowed it, and the
 * badge read 0 for every approver on every tenant. Even indexed it would have found nothing on
 * Southern Lanka, where a leave is written with no supervisor_epf at all.
 *
 * Imported dynamically to keep apiCompat out of the app-shell bundle, matching how
 * leaveService reaches for it. This is a LENGTH of a list the viewer is already shown; it is not
 * a routing rule and must never become one.
 */
const leaveRequestsForApprover = async (epf: string): Promise<unknown[]> => {
  const { leaveApi } = await import('@/services/apiCompat');
  const res = await leaveApi.getLeaveRequests(epf);
  const rows = res?.data?.data?.leave_requests;
  return Array.isArray(rows) ? rows : [];
};

export const useNavBadgesStore = create<NavBadgesState>((set, get) => ({
  counts: EMPTY,
  loadedAt: 0,
  loading: false,
  invalidate: () => set({ loadedAt: 0 }),
  load: async (ctx, force = false) => {
    if (!ctx.epf) return;
    const { loading, loadedAt } = get();
    if (loading) return;
    if (!force && Date.now() - loadedAt < TTL_MS) return;
    set({ loading: true });
    try {
      const [approvals, leaves, suspenseParts, ot] = await Promise.all([
        ctx.canApproveAttendance && ctx.companyId
          ? count(getPendingApprovals(ctx.epf, ctx.companyId))
          : Promise.resolve(0),
        ctx.canApproveLeaves ? count(leaveRequestsForApprover(ctx.epf)) : Promise.resolve(0),
        ctx.suspenseOn
          ? Promise.all([
              // Anyone can be somebody's supervisor — or be named as a category's credit
              // approver — capability or not; those two queues are theirs whether or not they
              // hold can_approve_suspense.
              count(getPendingSupervisorRequests(ctx.epf)),
              count(getPendingCategoryRequests(ctx.epf)),
              ctx.canApproveSuspense ? count(getPendingSubmissions()) : Promise.resolve(0),
              ctx.canApproveSuspense ? count(getPendingCloseRequests()) : Promise.resolve(0),
              // Credit requests: only the actionable ones (every earlier stage cleared), so the
              // badge matches the "Ready for you" list rather than the whole tab.
              ctx.canApproveSuspense
                ? getAllRequestsForApprovals()
                    .then(rs => rs.filter(r => r.status === 'pending' && requestIsReadyForApprover(r)).length)
                    .catch(() => 0)
                : Promise.resolve(0),
            ])
          : Promise.resolve([0, 0, 0, 0, 0]),
        ctx.payrollOn && ctx.canApproveOt
          ? count(getPendingOtRequestsForApprover(ctx.epf))
          : Promise.resolve(0),
      ]);

      set({
        counts: {
          approvals,
          leaves,
          suspense: suspenseParts.reduce((a, b) => a + b, 0),
          ot,
        },
        loadedAt: Date.now(),
      });
    } finally {
      set({ loading: false });
    }
  },
}));

/**
 * Counts for the sidebar. Refreshes on route change, but only once the cache has expired — so
 * walking around the app is free, and a queue just cleared catches up within the TTL.
 */
export function useNavBadges(ctx: BadgeContext): NavBadgeCounts {
  const counts   = useNavBadgesStore(s => s.counts);
  const load     = useNavBadgesStore(s => s.load);
  const pathname = usePathname();

  useEffect(() => { void load(ctx); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pathname, ctx.epf, ctx.companyId, ctx.canApproveAttendance, ctx.canApproveLeaves,
     ctx.canApproveSuspense, ctx.canApproveOt, ctx.suspenseOn, ctx.payrollOn]);

  return ctx.epf ? counts : EMPTY;
}
