'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronLeft, Check } from 'lucide-react';
import { useT } from '@/store/appStore';
import Portal from '@/components/Portal';

interface ApprovalsMasterDetailProps<T> {
  items: T[];
  getId: (item: T) => string | number;
  selectedId: string | number | null;
  onSelect: (id: string | number | null) => void;
  renderRow: (item: T, selected: boolean) => ReactNode;
  renderDetail: (item: T) => ReactNode;
  emptyState?: ReactNode;
  /** Desktop-only: cap the master-detail to whatever viewport height is actually left below it
   *  so its list + detail columns scroll INTERNALLY instead of growing the page forever (e.g. a
   *  long edit-request list). MEASURED at render time (this component's own top offset,
   *  subtracted from window.innerHeight) rather than a hand-guessed "reserve N rem for
   *  everything above" — a hardcoded guess drifts out of sync the moment a sibling above wraps
   *  onto an extra line (the triage-tile hints, the scope-chip row, ...) and under-reserves,
   *  which is what made the detail pane read as clipped/over-scrolled. Omitted → the previous
   *  `lg:h-full` behaviour (grows with its content; no internal scroll). */
  boundHeight?: boolean;
  /** Optional per-row multi-select checkbox (for bulk actions). Separate from the
   *  row click that opens the detail. */
  bulk?: { isChecked: (item: T) => boolean; onToggle: (item: T) => void };
  /** Optional display-only grouping of the left list. Items sharing a non-null `keyOf`
   *  render under `renderHeader`; null-key items fall into a trailing ungrouped section
   *  (under `ungroupedLabel`). Selection, detail and bulk behaviour are unchanged. When no
   *  item yields a key, the list renders flat (no headers). */
  group?: {
    keyOf: (item: T) => string | null;
    renderHeader: (key: string, groupItems: T[]) => ReactNode;
    ungroupedLabel?: ReactNode;
    /** Optional second level INSIDE each group — used by the queue to keep a team (leader +
     *  their picked technicians) together under the day separator it belongs to. Items with a
     *  null sub-key render after the sub-grouped ones, with no sub-header. */
    subKeyOf?: (item: T) => string | null;
    renderSubHeader?: (key: string, subItems: T[]) => ReactNode;
  };
}

/** Tailwind's `lg` breakpoint, as a JS media query. */
const DESKTOP_QUERY = '(min-width: 1024px)';

/**
 * Live `lg:` breakpoint state. The mobile detail is portalled to <body>, which puts it OUTSIDE
 * the `lg:hidden` wrapper — so CSS alone cannot suppress it and the overlay would cover the
 * desktop layout. The same value therefore drives BOTH the auto-select below and whether the
 * overlay renders at all, so the two can never disagree.
 *
 * `null` until measured on the client, so the server render and first paint agree.
 */
function useIsDesktop(): boolean | null {
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const apply = () => setIsDesktop(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return isDesktop;
}

export default function ApprovalsMasterDetail<T>({
  items,
  getId,
  selectedId,
  onSelect,
  renderRow,
  renderDetail,
  emptyState,
  bulk,
  group,
  boundHeight,
}: ApprovalsMasterDetailProps<T>) {
  const t = useT();
  const isDesktop = useIsDesktop();
  const containerRef = useRef<HTMLDivElement>(null);
  const [desktopHeight, setDesktopHeight] = useState<number | null>(null);

  // Re-measured on resize and whenever the row count changes (a day approved/cleared reflows
  // whatever sits above this component on some pages, e.g. the backlog card's own count).
  // 24px matches the breathing room the rest of the app leaves at the foot of a bottom-anchored
  // panel; 320px is a floor so a very short window never collapses this to nothing.
  useEffect(() => {
    if (!boundHeight || !isDesktop) return;
    const measure = () => {
      const el = containerRef.current;
      if (!el) return;
      setDesktopHeight(Math.max(320, window.innerHeight - el.getBoundingClientRect().top - 24));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [boundHeight, isDesktop, items.length]);

  useEffect(() => {
    // Wait until the breakpoint is measured — auto-selecting before then would guess, and on
    // mobile a wrong guess buries the list under the full-screen overlay.
    if (isDesktop === null) return;
    // Compute what the selection SHOULD be, then only fire onSelect when it actually
    // differs from the current selectedId — so a parent passing a freshly-built list each
    // render (e.g. an issues-first sort) can't cause redundant/looping onSelect calls.
    // Auto-select the first item ONLY on desktop (where the detail fills the right pane).
    // On mobile the detail is a full-screen overlay, so auto-selecting would immediately
    // bury the list — there we leave nothing selected until the user taps a row, and
    // "Back to list" (onSelect(null)) stays cleared instead of being re-selected here.
    const stillValid = selectedId !== null && items.some(it => getId(it) === selectedId);
    const targetId = items.length === 0
      ? null
      : stillValid
        ? selectedId
        : isDesktop ? getId(items[0]) : null;
    if (targetId !== selectedId) onSelect(targetId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, selectedId, isDesktop]);

  if (items.length === 0) {
    return <>{emptyState}</>;
  }

  const selectedItem = items.find(it => getId(it) === selectedId) ?? null;

  const renderItemRow = (item: T) => {
    const id = getId(item);
    const selected = id === selectedId;
    const checked = bulk ? bulk.isChecked(item) : false;
    return (
      // data-row-id lets the keyboard reviewer scroll the newly-focused row into view without
      // the list having to hand refs back up to the page.
      <div key={id} data-row-id={String(id)} className="flex items-center gap-2 group/row">
        {bulk && (
          <button
            type="button"
            aria-label="Select"
            aria-pressed={checked}
            onClick={(e) => { e.stopPropagation(); bulk.onToggle(item); }}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-all ${
              checked
                ? 'border-primary bg-primary text-primary-foreground shadow-xs'
                : 'border-border/80 bg-muted/60 hover:border-primary/50 hover:bg-muted'
            }`}
          >
            {checked && <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />}
          </button>
        )}
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect(id)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id); } }}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          {renderRow(item, selected)}
        </div>
      </div>
    );
  };

  // Partition into groups (preserving first-appearance order) when a `group` config is
  // supplied and at least one item yields a key; otherwise render a flat list.
  const buildListBody = () => {
    if (!group) return items.map(renderItemRow);
    const order: string[] = [];
    const grouped = new Map<string, T[]>();
    const ungrouped: T[] = [];
    for (const item of items) {
      const k = group.keyOf(item);
      if (k == null) { ungrouped.push(item); continue; }
      if (!grouped.has(k)) { grouped.set(k, []); order.push(k); }
      grouped.get(k)!.push(item);
    }
    if (order.length === 0) return items.map(renderItemRow);
    // Second level inside a group (optional). Sub-groups keep first-appearance order too, and
    // anything without a sub-key trails them un-headed — so a day that has no teams in it looks
    // exactly like a plain list of rows.
    const renderGroupBody = (groupItems: T[]) => {
      const subKeyOf = group.subKeyOf;
      const renderSubHeader = group.renderSubHeader;
      if (!subKeyOf || !renderSubHeader) return groupItems.map(renderItemRow);
      const subOrder: string[] = [];
      const subGrouped = new Map<string, T[]>();
      const loose: T[] = [];
      for (const item of groupItems) {
        const k = subKeyOf(item);
        if (k == null) { loose.push(item); continue; }
        if (!subGrouped.has(k)) { subGrouped.set(k, []); subOrder.push(k); }
        subGrouped.get(k)!.push(item);
      }
      if (subOrder.length === 0) return groupItems.map(renderItemRow);
      return (
        <>
          {subOrder.map(k => (
            <div key={`sub-${k}`} className="flex flex-col gap-2">
              {renderSubHeader(k, subGrouped.get(k)!)}
              {subGrouped.get(k)!.map(renderItemRow)}
            </div>
          ))}
          {loose.map(renderItemRow)}
        </>
      );
    };
    return (
      <>
        {order.map(k => (
          <div key={`grp-${k}`} className="flex flex-col gap-2">
            {group.renderHeader(k, grouped.get(k)!)}
            {renderGroupBody(grouped.get(k)!)}
          </div>
        ))}
        {ungrouped.length > 0 && (
          <div className="flex flex-col gap-2">
            {group.ungroupedLabel}
            {ungrouped.map(renderItemRow)}
          </div>
        )}
      </>
    );
  };

  const list = (
    <div className="flex flex-col gap-2 overflow-y-auto lg:w-[38%]">
      {buildListBody()}
    </div>
  );

  return (
    <>
      {/* Desktop: side-by-side */}
      <div
        ref={containerRef}
        className={`hidden lg:flex lg:gap-4 ${boundHeight ? '' : 'lg:h-full'}`}
        style={boundHeight && desktopHeight ? { height: desktopHeight } : undefined}
      >
        {list}
        <div className="lg:flex-1 overflow-y-auto">
          {selectedItem ? (
            renderDetail(selectedItem)
          ) : (
            <div className="flex h-full items-center justify-center text-center text-muted-foreground">
              {t.apSelectRecord}
            </div>
          )}
        </div>
      </div>

      {/* Mobile: full-width list, full-screen detail overlay */}
      <div className="lg:hidden">
        {list}
        {/* isDesktop is checked in JS, not by the `lg:hidden` above: the overlay is portalled to
            <body>, so it escapes that wrapper entirely and CSS can never hide it. Without this
            guard the desktop layout is covered by the mobile overlay, and its "Back to list"
            only bounces back as the effect re-selects the first row. */}
        {isDesktop === false && selectedItem && (
          // Portalled to <body>: a `fixed inset-0` element nested inside PageTransition (whose
          // enter animation leaves an active transform in place) gets its containing block
          // hijacked to PageTransition's own box instead of the viewport, so this full-screen
          // mobile detail view wouldn't actually cover the topbar/sidebar.
          <Portal>
            <div className="fixed inset-0 z-50 bg-background overflow-auto">
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-4 py-3">
                <button
                  type="button"
                  onClick={() => onSelect(null)}
                  className="flex items-center gap-1 text-sm font-medium"
                >
                  <ChevronLeft className="h-4 w-4" />
                  {t.apBackToList}
                </button>
              </div>
              <div className="p-4">{renderDetail(selectedItem)}</div>
            </div>
          </Portal>
        )}
      </div>
    </>
  );
}
