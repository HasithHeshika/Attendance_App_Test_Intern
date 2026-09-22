'use client';
import { useEffect, useState } from 'react';
import { FileText, Eye } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { auth } from '@/lib/firebase';

// OneDrive-hosted bills are served through /api/cloud-storage/file, which requires a valid
// Firebase session. The URL persisted on the bill document is deliberately STABLE (it re-
// resolves a fresh Graph link on each view), so the token cannot be baked into it and has to
// be attached at render time. It goes in the query string because these URLs end up in
// <img>/<iframe> src, which cannot carry an Authorization header.
//
// Firebase Storage URLs already carry their own access token and pass through untouched.
const PROXY_PREFIX = '/api/cloud-storage/file';

/**
 * The bill URL an <img>/<iframe> can actually load. EVERY place that renders a stored bill must
 * go through this — a raw `src={bill_url}` gets a 401 from the proxy and paints a broken image,
 * which is exactly what the Vouchers tab did until it was pointed here. Exported for the few
 * callers that cannot use <BillThumb> itself, e.g. a thumbnail sitting inside an existing
 * <button> (nested buttons are invalid HTML).
 */
export function useAuthedBillUrl(url: string | null): string | null {
  const [resolved, setResolved] = useState<string | null>(
    url && url.startsWith(PROXY_PREFIX) ? null : url,
  );

  useEffect(() => {
    if (!url || !url.startsWith(PROXY_PREFIX)) {
      setResolved(url);
      return;
    }
    let cancelled = false;
    // getIdToken() returns the cached token until it is close to expiry, so this is not a
    // network round trip per thumbnail.
    auth.currentUser?.getIdToken()
      .then((t) => {
        if (cancelled) return;
        setResolved(`${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}`);
      })
      .catch(() => { if (!cancelled) setResolved(null); });
    return () => { cancelled = true; };
  }, [url]);

  return resolved;
}

// A bill/receipt thumbnail that opens the full image (or PDF) in a modal — never a download.
// Shared by the suspense holder/approver views and the suspense report. `size="lg"` renders a
// larger inline preview (e.g. side-by-side with editable bill data) but opens the same modal.
export default function BillThumb({ url, type, size = 'sm' }: { url: string | null; type: 'image' | 'pdf' | null; size?: 'sm' | 'lg' | 'grid' }) {
  const [open, setOpen] = useState(false);
  // Hooks must run unconditionally — the "no bill" early return comes after them.
  const authedUrl = useAuthedBillUrl(url);
  if (!url) return <span className="text-[11px] text-muted-foreground">No bill</span>;
  const isPdf = type === 'pdf';
  // 'grid' sits between the two: big enough to recognise a receipt at a glance in a gallery of
  // them, small enough that a month of bills is a few scrolls rather than a few dozen.
  const boxCls = size === 'lg' ? 'h-56 w-full sm:h-72'
    : size === 'grid' ? 'h-32 w-full sm:h-40'
    : 'h-11 w-11';
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="View bill"
        className={`group relative ${boxCls} shrink-0 overflow-hidden rounded-md border border-border bg-muted transition hover:ring-2 hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}>
        {isPdf
          ? <span className="flex h-full w-full items-center justify-center text-muted-foreground"><FileText className={size === 'sm' ? 'h-5 w-5' : size === 'grid' ? 'h-8 w-8' : 'h-10 w-10'} /></span>
          : <img src={authedUrl ?? undefined} alt="Bill" loading="lazy" className={size === 'lg' ? 'h-full w-full object-contain' : 'h-full w-full object-cover'} />}
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-white opacity-0 transition group-hover:bg-black/35 group-hover:opacity-100">
          <Eye className="h-4 w-4" />
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl p-3 sm:p-4">
          <DialogHeader className="mb-1"><DialogTitle className="text-sm">Bill</DialogTitle></DialogHeader>
          {isPdf
            ? <iframe src={authedUrl ?? undefined} title="Bill" className="h-[75vh] w-full rounded-md border border-border" />
            : <img src={authedUrl ?? undefined} alt="Bill" className="mx-auto max-h-[75vh] w-auto max-w-full rounded-md object-contain" />}
        </DialogContent>
      </Dialog>
    </>
  );
}
