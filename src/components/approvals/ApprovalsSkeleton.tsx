'use client';

import { Skeleton, SkeletonCard } from '@/components/ui/Skeleton';

/** Loading shape that matches what actually arrives: a triage strip, then a list on the left
 *  and one open record on the right. A flat list skeleton would promise the wrong layout. */
export default function ApprovalsSkeleton() {
  return (
    <div className="space-y-5" aria-hidden="true">
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-32" />
        </div>
      </div>

      {/* Triage tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-lg flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-2.5 w-1/2" />
            </div>
          </SkeletonCard>
        ))}
      </div>

      {/* Tabs + search */}
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-9 w-64 rounded-lg" />
        <Skeleton className="h-9 w-56 rounded-lg" />
      </div>

      <ApprovalsQueueSkeleton />
    </div>
  );
}

/** Just the two-pane part — used when the shell is already on screen and only the queue is
 *  still resolving (a tab switch, a widened backlog window). */
export function ApprovalsQueueSkeleton() {
  return (
    <div className="flex flex-col gap-4 lg:flex-row" aria-hidden="true">
        <div className="space-y-2 lg:w-[38%]">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} className="flex items-center gap-3 p-3">
              <Skeleton className="h-8 w-8 rounded-lg flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-1/2" />
                <Skeleton className="h-2.5 w-2/3" />
              </div>
            </SkeletonCard>
          ))}
        </div>
        <SkeletonCard className="hidden flex-1 space-y-4 lg:block">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
          <Skeleton className="h-10 w-40 rounded-md" />
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-[150px] w-full rounded-xl" />
        </SkeletonCard>
    </div>
  );
}
