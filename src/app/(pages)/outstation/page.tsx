'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { PageTransition } from '@/components/ui/motion';
import { PageHeaderSkeleton, StatCardsSkeleton, TableSkeleton } from '@/components/ui/Skeleton';

// Outstation management was merged into the Working Places page — redirect old links.
export default function OutstationRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/working-places'); }, [router]);
  // Show a layout-mirroring skeleton during the brief redirect so the transition
  // matches the app's loading conventions instead of a bare spinner.
  return (
    <PageTransition className="space-y-6 p-1">
      <PageHeaderSkeleton />
      <StatCardsSkeleton />
      <TableSkeleton rows={5} cols={4} />
    </PageTransition>
  );
}
