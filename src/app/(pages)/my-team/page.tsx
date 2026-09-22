'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeaderSkeleton, ListSkeleton } from '@/components/ui/Skeleton';
import { PageTransition } from '@/components/ui/motion';

// My Team merged into the Approvals page (Staff tab → "My team" toggle). Redirect any
// old links/bookmarks there.
export default function MyTeamRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/approvals'); }, [router]);
  return (
    <PageTransition className="space-y-6">
      <PageHeaderSkeleton />
      <ListSkeleton rows={6} />
    </PageTransition>
  );
}
