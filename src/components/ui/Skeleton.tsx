'use client';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Shimmering placeholder block. Compose with width/height/rounding via `className`.
// The shimmer + theme-aware base colour come from the `.skeleton` utility in globals.css.
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={cn('skeleton rounded-md', className)} aria-hidden="true" />;
}

// A frosted card shell (matches the new <Card>) wrapping arbitrary skeleton content.
export function SkeletonCard({ className = '', children }: { className?: string; children?: ReactNode }) {
  return <div className={cn('glass rounded-xl shadow-card p-4', className)}>{children}</div>;
}

// ─── Composite skeletons for common page shapes ────────────────────────────────

// Page title block placeholder.
export function PageHeaderSkeleton({ className = '' }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <Skeleton className="h-10 w-10 rounded-lg" />
      <div className="space-y-2">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-3 w-32" />
      </div>
    </div>
  );
}

// A row of stat cards (dashboard / overview KPIs).
export function StatCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} className="space-y-3">
          <div className="flex items-start justify-between">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-9 w-9 rounded-lg" />
          </div>
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </SkeletonCard>
      ))}
    </div>
  );
}

// A vertical list of card rows (approvals / leaves / tasks lists).
export function ListSkeleton({ rows = 4, className = '' }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonCard key={i} className="flex items-center gap-4">
          <Skeleton className="h-10 w-10 rounded-lg flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="h-8 w-20 rounded-md flex-shrink-0" />
        </SkeletonCard>
      ))}
    </div>
  );
}

// A table placeholder inside a card (rows × cols).
export function TableSkeleton({ rows = 6, cols = 4, className = '' }: { rows?: number; cols?: number; className?: string }) {
  return (
    <div className={cn('glass rounded-xl shadow-card overflow-hidden', className)}>
      <div className="flex items-center gap-4 border-b border-border px-4 py-3">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 border-b border-border px-4 py-3.5 last:border-0">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={cn('h-4 flex-1', c === 0 && 'max-w-[40%]')} />
          ))}
        </div>
      ))}
    </div>
  );
}

// A form placeholder (label + field pairs) inside a card.
export function FormSkeleton({ fields = 5, className = '' }: { fields?: number; className?: string }) {
  return (
    <SkeletonCard className={cn('space-y-5', className)}>
      {Array.from({ length: fields }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
      ))}
      <Skeleton className="h-9 w-32 rounded-md" />
    </SkeletonCard>
  );
}

// Full dashboard skeleton (header + stat cards + a wide content card).
export function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeaderSkeleton />
      <StatCardsSkeleton />
      <SkeletonCard className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </SkeletonCard>
    </div>
  );
}
