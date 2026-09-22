'use client';
import { Download } from 'lucide-react';

/**
 * Sidebar footer link for tenants without the Solar App cross-link (see
 * Tenant.features.solarApp) — points at this tenant's own /install page.
 *
 * One build serves every domain, so the URL can't be hardcoded like Solar's: it's built from
 * `window.location.origin` at click time, so carecode.org links to carecode.org/install and
 * altavision.lk (were this ever shown there) would link to altavision.lk/install.
 */
export default function GetAppButton({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const href =
    typeof window !== 'undefined'
      ? `${window.location.origin}/install`
      : '/install';

  return (
    <a
      href={href}
      onClick={() => onNavigate?.()}
      className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-primary transition-colors hover:bg-primary/10"
    >
      <Download className="w-[18px] h-[18px] transition-transform group-hover:translate-y-0.5" />
      <span className="text-sm font-medium">Get the App</span>
    </a>
  );
}
