'use client';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import {
  formatCountdown, isUrgentCountdown, MAINTENANCE_KIND_LABEL,
  type MaintenanceDoc,
} from '@/lib/maintenance';
import { MAINTENANCE_KIND_ICON } from './maintenanceIcons';

interface Props {
  doc: MaintenanceDoc;
  nowMs: number;
  // 'scheduled' counts down to start (this route's normal state); 'active' counts down to end
  // (used only where the full-screen overlay must NOT show — the auth screens, see MaintenanceGate).
  phase: 'scheduled' | 'active';
  onClick: () => void;
}

// Slim full-width countdown banner pinned to the top. Measures its own height with a
// ResizeObserver and pushes an inline `padding-top` onto <body> so it never covers the app
// header — an inline style, since no stylesheet class (however specific) can beat it, which is
// exactly why the print override below also has to target `body` directly with `!important`.
export default function MaintenanceBanner({ doc, nowMs, phase, onClick }: Props) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const apply = () => { document.body.style.paddingTop = `${el.offsetHeight}px`; };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.body.style.paddingTop = '';
    };
  }, []);

  const targetMs = phase === 'scheduled' ? doc.startAtMs : doc.endAtMs;
  const remaining = targetMs - nowMs;
  const urgent = isUrgentCountdown(remaining);
  const Icon = MAINTENANCE_KIND_ICON[doc.kind];

  return (
    <>
      {/* The banner's body padding is an inline style — the only way to neutralise it for print
          is targeting body directly, since no print: utility class can outrank an inline style. */}
      <style>{'@media print { body { padding-top: 0 !important; } }'}</style>
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        className={cn(
          // z-35: above the app header (z-30) so it's always visible on a normal page, but
          // BELOW the mobile nav drawer (z-40, itself `fixed` — see (pages)/layout.tsx). The
          // drawer ignores body's padding-top (fixed elements don't follow ancestor padding),
          // so at a higher z-index the banner used to slice across the open drawer's header
          // instead of coexisting with it. Sitting under the drawer instead just lets the
          // (opaque, blurred) open drawer cover the banner completely — informational content
          // briefly hidden behind a full-screen drawer is the right trade-off here.
          'print:hidden fixed inset-x-0 top-0 z-[35] flex w-full items-center justify-center gap-2',
          'px-4 py-2 text-sm font-medium text-left transition-colors hover:brightness-95',
          urgent ? 'bg-destructive text-destructive-foreground' : 'bg-warning text-warning-foreground',
        )}
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.5rem)' }}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate">
          {MAINTENANCE_KIND_LABEL[doc.kind]}
          {phase === 'scheduled' ? ' starts in ' : ' — ends in '}
          <strong className="tabular-nums">{formatCountdown(remaining)}</strong>
        </span>
      </button>
    </>
  );
}
