'use client';
import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Check, ChevronDown, Filter, Search, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

// Role filter for the Users directory. The old design was a horizontal row of chips (one
// per role, with counts) that overflowed on every screen once the roles registry grew
// past a handful. This is a single dropdown: one trigger showing the current pick and its
// count, and a searchable list inside a popover.

export interface RoleFilterOption {
  key: string;
  label: string;
  count: number;
}

export interface RoleFilterProps {
  /** Selected role key, or 'all'. */
  value: string;
  onChange: (v: string) => void;
  options: RoleFilterOption[];
  /** Label + count for the "all roles" row (the caller owns the translation). */
  allLabel: string;
  allCount: number;
  /** Placeholder for the role search box inside the popover. */
  placeholder?: string;
  className?: string;
}

const ALL_KEY = 'all';

// No translation key exists for these three strings (the closest, tr.allWord + tr.roleLabel,
// reads as "All Role", which is not natural English) — so they stay English here rather
// than growing appStore's TRANSLATIONS from a component.
const ALL_ROLES_FALLBACK = 'All roles';
const SEARCH_ROLES_FALLBACK = 'Search roles…';
const CLEAR_LABEL = 'Clear role filter';
const NO_MATCH = 'No roles match';

export default function RoleFilter({
  value, onChange, options, allLabel, allCount, placeholder, className,
}: RoleFilterProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const isAll = value === ALL_KEY;
  const current = isAll ? null : options.find(o => o.key === value) ?? null;
  // A role that has been filtered by (via URL, say) but is no longer in the registry still
  // needs a readable trigger — fall back to the raw key rather than showing nothing.
  const triggerLabel = isAll ? (allLabel || ALL_ROLES_FALLBACK) : (current?.label ?? value);
  const triggerCount = isAll ? allCount : (current?.count ?? 0);

  // Order: the selected role first so it is visible without scrolling, then the roles that
  // actually have people (most first), then the empty ones muted at the bottom. Ties break
  // alphabetically so the order is stable across reloads.
  const sorted = useMemo(() => {
    return [...options].sort((a, b) => {
      const aSel = a.key === value ? 1 : 0;
      const bSel = b.key === value ? 1 : 0;
      if (aSel !== bSel) return bSel - aSel;
      const aHas = a.count > 0 ? 1 : 0;
      const bHas = b.count > 0 ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      if (a.count !== b.count) return b.count - a.count;
      return a.label.localeCompare(b.label);
    });
  }, [options, value]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () => (q ? sorted.filter(o => o.label.toLowerCase().includes(q)) : sorted),
    [sorted, q],
  );
  // "All roles" is pinned above the list and only hides when the search text rules it out.
  const showAll = !q || (allLabel || ALL_ROLES_FALLBACK).toLowerCase().includes(q);

  const pick = (key: string) => {
    onChange(key);
    setOpen(false);
  };

  const handleOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) setQuery('');   // a fresh search each time; a stale query would hide roles silently
  };

  // Enter in the search box picks the first row on screen, so keyboard users can type a few
  // letters and confirm without tabbing into the list.
  const handleSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (showAll) { pick(ALL_KEY); return; }
    if (visible.length > 0) pick(visible[0].key);
  };

  const clear = (e: MouseEvent) => {
    e.stopPropagation();
    onChange(ALL_KEY);
  };

  const rowClass = (selected: boolean, muted: boolean) => cn(
    'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    selected ? 'bg-primary/10 text-primary font-semibold' : 'text-foreground hover:bg-accent',
    muted && !selected && 'text-muted-foreground',
  );

  const countPill = (n: number, selected: boolean) => (
    <span
      className={cn(
        'ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums',
        selected ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground',
      )}
    >
      {n}
    </span>
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {/* The clear control is a sibling of the trigger, not a child: a button cannot nest
          inside a button, so it is laid over the trigger's right edge instead. */}
      <div className={cn('relative w-full sm:w-auto', className)}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            className={cn(
              // h-9 matches the Input primitive it sits next to in the toolbar.
              'flex h-9 w-full sm:min-w-[200px] sm:max-w-[280px] items-center gap-2 rounded-md border bg-card pl-3 pr-2.5 text-sm transition-colors hover:bg-accent/50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              open ? 'border-primary/50' : isAll ? 'border-input' : 'border-primary/30',
              !isAll && 'pr-14',
            )}
          >
            <Filter className={cn('h-4 w-4 shrink-0', isAll ? 'text-muted-foreground' : 'text-primary')} />
            <span className={cn('min-w-0 flex-1 truncate text-left', isAll ? 'text-foreground' : 'text-primary font-semibold')}>
              {triggerLabel}
            </span>
            <span
              className={cn(
                'inline-flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums',
                isAll ? 'bg-muted text-muted-foreground' : 'bg-primary/20 text-primary',
              )}
            >
              {triggerCount}
            </span>
            {isAll && (
              <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
            )}
          </button>
        </PopoverTrigger>
        {!isAll && (
          <div className="absolute inset-y-0 right-0 flex items-center gap-0.5 pr-1.5">
            <button
              type="button"
              aria-label={CLEAR_LABEL}
              onClick={clear}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <ChevronDown className={cn('pointer-events-none h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
          </div>
        )}
      </div>

      <PopoverContent align="end" className="w-[min(20rem,calc(100vw-2rem))] p-2">
        <div className="relative mb-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKey}
            placeholder={placeholder || SEARCH_ROLES_FALLBACK}
            aria-label={placeholder || SEARCH_ROLES_FALLBACK}
            className="flex h-9 w-full rounded-md border border-input bg-card pl-8 pr-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div role="listbox" aria-label={allLabel || ALL_ROLES_FALLBACK} className="max-h-72 space-y-0.5 overflow-y-auto scrollbar-thin pr-0.5">
          {showAll && (
            <button
              type="button"
              role="option"
              aria-selected={isAll}
              onClick={() => pick(ALL_KEY)}
              className={rowClass(isAll, false)}
            >
              <span className="min-w-0 flex-1 truncate">{allLabel || ALL_ROLES_FALLBACK}</span>
              {countPill(allCount, isAll)}
              {isAll && <Check className="h-4 w-4 shrink-0 text-primary" />}
            </button>
          )}
          {visible.map((o) => {
            const selected = o.key === value;
            return (
              <button
                key={o.key}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => pick(o.key)}
                className={rowClass(selected, o.count === 0)}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {countPill(o.count, selected)}
                {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </button>
            );
          })}
          {!showAll && visible.length === 0 && (
            <div className="px-2.5 py-3 text-center text-xs text-muted-foreground">{NO_MATCH}</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
