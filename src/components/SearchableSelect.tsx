'use client';
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { fuzzyScore } from '@/lib/fuzzy';
import { cn } from '@/lib/utils';

export interface SearchOption {
  value: string;
  label: string;
  sublabel?: string;   // muted second line
  badge?: string;      // small tag shown next to the label (e.g. "site #")
  keywords?: string;   // extra text to match on (not displayed)
}

// Searchable single-select combobox: the field itself is the search input. Type to
// filter; suggestions appear below. Matches the app's dark inputs.
export default function SearchableSelect({
  value, onChange, options, placeholder = 'Select…', disabled, icon, emptyLabel = 'No matches', className, inputClassName, ariaLabel,
  onClear, onCreate, createLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SearchOption[];
  placeholder?: string;
  disabled?: boolean;
  icon?: React.ReactNode;
  emptyLabel?: string;
  className?: string;
  inputClassName?: string;
  onClear?: () => void;
  /** Accessible name for the input when several pickers share one placeholder (e.g. one per row). */
  ariaLabel?: string;
  /** When set, a "create" row appears for a typed value that isn't an exact match. */
  onCreate?: (query: string) => void;
  createLabel?: (query: string) => React.ReactNode;
}) {
  const selected = options.find(o => o.value === value);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);   // keyboard-highlighted option index
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The menu is rendered in a portal on document.body so it can't be clipped by any
  // ancestor's `overflow-hidden` (cards, animated collapse panels, modals). We position
  // it with fixed coordinates derived from the field's viewport rect.
  const [rect, setRect] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);

  // Keep the field text in sync with the externally-selected option. When the current value
  // isn't among the options (e.g. a Solar-app site or custom place not in this list), still
  // show the raw value instead of blanking the field.
  useEffect(() => { setQuery(selected?.label ?? value ?? ''); }, [value, selected?.label]);

  // Reset the keyboard highlight to the top match whenever the list / open-state changes.
  useEffect(() => { setActive(0); }, [query, open]);

  const updateRect = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    // Flip up when there isn't room for the menu below and there's more room above.
    const openUp = spaceBelow < 260 && r.top > spaceBelow;
    // 8px gap clears the focused field's ring (ring-2 + ring-offset-1 ≈ 3px) so the menu
    // border doesn't visually collide with the focus border.
    setRect({
      left: r.left,
      width: r.width,
      top: openUp ? undefined : r.bottom + 8,
      bottom: openUp ? window.innerHeight - r.top + 8 : undefined,
    });
  }, []);

  // While open: keep the menu anchored as the page (or any scroll container) scrolls/resizes,
  // and close on any outside click (counting the portal menu as "inside").
  useEffect(() => {
    if (!open) return;
    updateRect();
    // Re-measure for a short window after opening. A Dialog's open animation (zoom/translate)
    // moves the anchor while it auto-focuses this field — which opens the menu mid-animation.
    // Without this, the menu would stick to the anchor's transient position and never re-align.
    const timers = [0, 60, 150, 250, 400].map(d => setTimeout(updateRect, d));
    const onScrollOrResize = () => updateRect();
    window.addEventListener('scroll', onScrollOrResize, true); // capture → catches nested scrollers
    window.addEventListener('resize', onScrollOrResize);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
      setQuery(selected?.label ?? ''); // discard a half-typed query
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, selected?.label, updateRect]);

  const MAX_RESULTS = 60;
  const filtered = useMemo(() => {
    const s = query.trim();
    // Show the full list when nothing is typed, or when the field is just displaying the
    // current selection (so opening the menu never hides the other options).
    if (!s || query === (selected?.label ?? '') || query === (value ?? '')) {
      return options.slice(0, MAX_RESULTS);
    }
    // Fuzzy: score every option (tolerates word-order, dropped letters and small typos),
    // drop non-matches, then sort best-first. Array.sort is stable, so options with equal
    // scores keep their incoming order (e.g. the nearest-first GPS ordering).
    const scored: { o: SearchOption; score: number }[] = [];
    for (const o of options) {
      const score = fuzzyScore(s, `${o.label} ${o.sublabel ?? ''} ${o.keywords ?? ''}`);
      if (score > 0) scored.push({ o, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map(x => x.o);   // lazy render — keep the DOM light
  }, [options, query, selected?.label, value]);

  const queryTrim  = query.trim();
  const exactMatch = options.some(o => o.label.toLowerCase() === queryTrim.toLowerCase());
  const canCreate  = !!onCreate && queryTrim.length > 0 && !exactMatch && queryTrim !== (selected?.label ?? '');

  const pick = (o: SearchOption) => {
    onChange(o.value);
    // Clear the typed query on pick. For a normal single-select the value-sync effect
    // immediately refills the field with the new option's label; for an "adder" picker
    // (the parent keeps `value` constant and pushes picks into a list elsewhere, e.g. a
    // chip multi-select) it stays empty — so reopening the menu shows the full list
    // instead of filtering by the name that was just picked ("No matches").
    setQuery(o.value === value ? o.label : '');
    setOpen(false);
  };
  const create = () => { if (onCreate && queryTrim) { onCreate(queryTrim); setOpen(false); } };

  const isKeyboardNavRef = useRef(false);

  // Stop native wheel and touchmove events from bubbling to document where modal
  // scroll-locks (Radix Dialog / react-remove-scroll) cancel them via preventDefault().
  useEffect(() => {
    const el = menuRef.current;
    if (!el || !open) return;

    const stopScrollBubble = (e: Event) => {
      e.stopPropagation();
    };

    el.addEventListener('wheel', stopScrollBubble, { passive: false });
    el.addEventListener('touchmove', stopScrollBubble, { passive: false });

    return () => {
      el.removeEventListener('wheel', stopScrollBubble);
      el.removeEventListener('touchmove', stopScrollBubble);
    };
  }, [open]);

  // Keep the highlighted option scrolled into view only when navigating via keyboard.
  useEffect(() => {
    if (!open || !isKeyboardNavRef.current) return;
    menuRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
    isKeyboardNavRef.current = false;
  }, [active, open]);

  // Full keyboard support: ↑/↓ move, Enter picks the highlighted (top) match, Esc closes.
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      isKeyboardNavRef.current = true;
      if (!open) { setOpen(true); return; }
      setActive(a => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      isKeyboardNavRef.current = true;
      if (!open) { setOpen(true); return; }
      setActive(a => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && filtered[active]) { e.preventDefault(); pick(filtered[active]); }
      else if (open && canCreate)  { e.preventDefault(); create(); }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); setOpen(false); setQuery(selected?.label ?? ''); }
    }
  };

  return (
    <div className={`relative ${className ?? ''}`} ref={ref}>
      <div className="relative">
        {icon && <span className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none flex items-center text-muted-foreground">{icon}</span>}
        <Input
          ref={inputRef}
          value={query}
          disabled={disabled}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { setOpen(true); inputRef.current?.select(); }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={cn(`h-10 ${onClear && value && value !== 'all' ? 'pr-14' : 'pr-9'} ${icon ? 'pl-9' : 'pl-3'}`, inputClassName)}
        />
        {onClear && value && value !== 'all' && (
          <button
            type="button"
            aria-label="Clear selection"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onClear();
              setQuery('');
            }}
            className="absolute right-7 top-1/2 -translate-y-1/2 p-0.5 rounded-full text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        <ChevronDown onClick={() => { if (disabled) return; setOpen(o => !o); inputRef.current?.focus(); }}
          className={`absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground cursor-pointer transition-transform ${open ? 'rotate-180' : ''}`} />
      </div>

      {open && rect && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          data-searchable-select-menu=""
          data-combobox-menu=""
          // The menu is portaled to <body>. Inside a modal dialog the body is made inert
          // (pointer-events: none) — so force them back on, and stop pointer events from
          // bubbling to the dialog's outside-dismiss listener (which would otherwise close it).
          onPointerDown={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          onWheel={e => e.stopPropagation()}
          onTouchMove={e => e.stopPropagation()}
          style={{ position: 'fixed', left: rect.left, width: rect.width, top: rect.top, bottom: rect.bottom, zIndex: 9999, pointerEvents: 'auto' }}
          className="bg-popover rounded-xl border border-border shadow-card overflow-hidden"
        >
          <div
            className="max-h-60 overflow-y-auto overscroll-contain scrollbar-thin py-1"
            style={{ WebkitOverflowScrolling: 'touch' }}
            onWheel={e => e.stopPropagation()}
            onTouchMove={e => e.stopPropagation()}
          >
            {filtered.length === 0 && !canCreate ? (
              <div className="px-3 py-3 text-xs text-muted-foreground text-center">{emptyLabel}</div>
            ) : filtered.map((o, idx) => (
              <button key={o.value} type="button"
                data-active={idx === active}
                onMouseEnter={() => {
                  isKeyboardNavRef.current = false;
                  setActive(idx);
                }}
                onMouseDown={e => { e.preventDefault(); pick(o); }}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left transition-colors ${
                  idx === active ? 'bg-accent' : value === o.value ? 'bg-primary/10' : 'hover:bg-accent'}`}>
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className={`text-sm truncate ${value === o.value ? 'text-primary' : 'text-foreground'}`}>{o.label}</span>
                    {o.badge && <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-warning/10 text-warning flex-shrink-0">{o.badge}</span>}
                  </span>
                  {o.sublabel && <span className="block text-[11px] text-muted-foreground truncate">{o.sublabel}</span>}
                </span>
                {value === o.value && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
              </button>
            ))}
            {canCreate && (
              <button type="button"
                onMouseDown={e => { e.preventDefault(); create(); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-left border-t border-border hover:bg-accent transition-colors">
                <span className="text-sm text-primary truncate">
                  {createLabel ? createLabel(queryTrim) : `Add “${queryTrim}”`}
                </span>
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
