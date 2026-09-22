'use client';

import type { ElementType } from 'react';
import { cn } from '@/lib/utils';

export interface TriageTile {
  /** Stable key — also used as the aria-controls-free identity for the pressed state. */
  id: string;
  label: string;
  count: number;
  /** Second line under the count — e.g. "oldest 14 Aug". Omitted when there is nothing to say. */
  hint?: string;
  icon: ElementType;
  /** Colour family. Hue alone never carries meaning here (see globals.css — success/primary/
   *  brand are the same azure), so every tile also has its own icon and its own label. */
  tone: 'primary' | 'warning' | 'destructive' | 'brand';
  active: boolean;
  onSelect: () => void;
}

// A tile with nothing in it must not shout: no tone wash, no coloured number, no icon tint.
// An approver scanning the strip should see only the slices that actually want them.
const QUIET = 'border-border bg-muted/30 text-muted-foreground';

const toneRing: Record<TriageTile['tone'], string> = {
  primary: 'border-primary/30 bg-primary/[0.06]',
  warning: 'border-warning/30 bg-warning/[0.07]',
  destructive: 'border-destructive/30 bg-destructive/[0.07]',
  brand: 'border-brand/30 bg-brand/[0.06]',
};

const toneIcon: Record<TriageTile['tone'], string> = {
  primary: 'bg-primary/10 text-primary',
  warning: 'bg-warning/10 text-warning',
  destructive: 'bg-destructive/10 text-destructive',
  brand: 'bg-brand/10 text-brand',
};

const toneActive: Record<TriageTile['tone'], string> = {
  primary: 'ring-primary/50',
  warning: 'ring-warning/50',
  destructive: 'ring-destructive/50',
  brand: 'ring-brand/50',
};

/**
 * The triage strip: at most four slices of the queue, each one a button that focuses the
 * queue on that slice, plus one plain-English line saying what is on screen and in what
 * order. The tiles are the WHAT (needs you / problems / backlog / edit requests); the tab
 * row next to the search box is the WHO.
 */
export default function ApprovalsTriageBar({
  tiles,
  summary,
  aside,
}: {
  tiles: TriageTile[];
  /** One sentence: what the queue is showing and why it is in this order. */
  summary: string;
  /** Optional trailing note rendered on the summary line (tenant-specific counts, etc.). */
  aside?: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      {/* Mobile: one horizontally-scrolling row. Desktop: an even grid. */}
      <div
        className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 lg:grid-cols-4"
        role="group"
        aria-label="Queue focus"
      >
        {tiles.map(tile => {
          const empty = tile.count === 0;
          const Icon = tile.icon;
          return (
            <button
              key={tile.id}
              type="button"
              onClick={tile.onSelect}
              aria-pressed={tile.active}
              className={cn(
                'group relative flex min-w-[10.5rem] flex-1 items-center gap-3 rounded-xl border p-3 text-left shadow-card transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                empty ? QUIET : cn('bg-card', toneRing[tile.tone]),
                tile.active && cn('ring-2', empty ? 'ring-border' : toneActive[tile.tone]),
              )}
            >
              <span
                className={cn(
                  'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg',
                  empty ? 'bg-muted text-muted-foreground' : toneIcon[tile.tone],
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className={cn('text-xl font-bold leading-none tabular-nums', empty && 'font-semibold text-muted-foreground')}>
                    {tile.count}
                  </span>
                  <span className="truncate text-xs font-semibold text-foreground">{tile.label}</span>
                </span>
                <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
                  {tile.hint ?? ' '}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* The page telling the user its own rule, rather than hiding it behind a sort toggle. */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-muted-foreground">
        <span>{summary}</span>
        {aside}
      </div>
    </div>
  );
}
