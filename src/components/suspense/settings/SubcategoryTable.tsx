'use client';
import { useMemo, useState } from 'react';
import { Check, ListChecks, Plus, Search, Trash2, X } from 'lucide-react';
import type { SuspenseSubcategory, SuspenseType } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// Radix Select forbids an empty item value, so "no type assigned" needs a sentinel.
const NONE = '__none';

// Above this many rows the list gets a search box and a "Showing N of M" count…
const SEARCH_AT = 5;
// …and above this many it also gets its own scroll area, so a 30-row category stops pushing every
// other category off the screen.
const SCROLL_AT = 12;

const COLS = 'sm:grid-cols-[minmax(0,1fr)_10rem_4.5rem_2rem]';

/**
 * One line per subcategory: name, its single type, Split, delete. A subcategory has at most ONE
 * type, so the type is a select — the old two-chip toggle row was a control lying about its shape,
 * and it doubled the height of every row.
 */
export default function SubcategoryTable({ subs, types, busy, ver, onChange, onRemove, onAdd, onBulkSetType }: {
  subs: SuspenseSubcategory[];
  types: SuspenseType[];
  busy: boolean;
  ver: number;
  onChange: (s: SuspenseSubcategory) => void;
  onRemove: (id: string) => void;
  /** Returns false when the name was rejected (duplicate) so the field keeps what was typed. */
  onAdd: (name: string) => boolean;
  onBulkSetType: (ids: string[], typeId: string | null) => void;
}) {
  const [query, setQuery]   = useState('');
  const [newSub, setNewSub] = useState('');
  // A bulk assignment stages in local state first: the rows show what WOULD happen and nothing is
  // written until Apply, so a mis-click is undone by walking away rather than by 28 more clicks.
  const [pending, setPending] = useState<{ typeId: string | null; ids: string[] } | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const searchable = subs.length > SEARCH_AT;
  const scrolls    = subs.length > SCROLL_AT;

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q ? subs.filter(s => s.name.toLowerCase().includes(q)) : subs), [subs, q]);

  const pendingIds  = useMemo(() => new Set(pending?.ids ?? []), [pending]);
  const typeName    = (id: string | null) => (id ? types.find(t => t.id === id)?.name ?? '' : 'No type');
  const stageBulk   = (typeId: string | null) => setPending({ typeId, ids: shown.map(s => s.id) });
  const applyBulk   = () => { if (pending) onBulkSetType(pending.ids, pending.typeId); setPending(null); };
  // The staged set is a snapshot of what was on screen — re-filtering would silently change what
  // Apply writes, so a new search drops the staging instead.
  const search      = (v: string) => { setQuery(v); setPending(null); };

  const add = () => { if (onAdd(newSub.trim())) setNewSub(''); };

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {searchable && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-2 py-2">
          <div className="relative min-w-0 flex-1 sm:max-w-[16rem]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={e => search(e.target.value)} placeholder="Search subcategories"
              className="h-8 pl-8 pr-8 text-xs" aria-label="Search subcategories" />
            {query && (
              <button type="button" onClick={() => search('')} aria-label="Clear search" title="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {types.length > 0 && (
            <Popover open={bulkOpen} onOpenChange={setBulkOpen}>
              <PopoverTrigger asChild>
                <Button type="button" size="sm" variant="outline" className="h-8" disabled={busy || shown.length === 0}>
                  <ListChecks className="h-3.5 w-3.5" /> Set type for all shown
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-1.5">
                <p className="px-2 py-1 text-[11px] text-muted-foreground">
                  Apply one type to the {shown.length} subcategor{shown.length === 1 ? 'y' : 'ies'} listed below.
                </p>
                {[...types.map(t => ({ id: t.id as string | null, name: t.name })), { id: null, name: 'No type' }].map(o => (
                  <button key={o.id ?? NONE} type="button" onClick={() => { stageBulk(o.id); setBulkOpen(false); }}
                    className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm text-foreground hover:bg-accent">
                    {o.name}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          )}

          <span className="text-[11px] tabular-nums text-muted-foreground">
            Showing {shown.length} of {subs.length}
          </span>
        </div>
      )}

      {pending && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-warning/10 px-2.5 py-2">
          <p className="min-w-0 flex-1 text-xs text-foreground">
            <span className="font-semibold tabular-nums">{pending.ids.length}</span> subcategor{pending.ids.length === 1 ? 'y' : 'ies'} will
            be set to <span className="font-semibold">{typeName(pending.typeId)}</span>. Nothing is saved until you apply.
          </p>
          <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setPending(null)}>Discard</Button>
          <Button type="button" size="sm" className="h-7" disabled={busy} onClick={applyBulk}>
            <Check className="h-3.5 w-3.5" /> Apply
          </Button>
        </div>
      )}

      <div className={scrolls ? 'max-h-[24rem] overflow-y-auto scrollbar-thin' : ''}>
        {/* Column names. Hidden on phones, where each subcategory reads as a small card instead. */}
        <div className={`sticky top-0 z-10 hidden border-b border-border bg-card px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid sm:items-center sm:gap-2 ${COLS}`}>
          <span>Subcategory</span>
          <span>Type</span>
          <span className="text-center">Split</span>
          <span className="sr-only">Actions</span>
        </div>

        {shown.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {subs.length === 0
              ? 'No subcategories yet — this category has no split option.'
              : `No subcategory matches “${query.trim()}”.`}
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {shown.map(s => (
              <SubRow
                key={s.id}
                sub={s}
                types={types}
                busy={busy}
                ver={ver}
                staged={pendingIds.has(s.id)}
                stagedTypeId={pending?.typeId ?? null}
                staging={!!pending}
                onChange={onChange}
                onRemove={onRemove}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add is pinned to the bottom of the table so it stays findable in a 30-row list — appending
          a blank row into the middle of one was a change nobody could locate. */}
      <div className="flex items-center gap-2 border-t border-border bg-muted/30 px-2 py-2">
        <Input value={newSub} onChange={e => setNewSub(e.target.value)} placeholder="New subcategory name"
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          className="h-8 max-w-[18rem] flex-1 text-sm" aria-label="New subcategory name" />
        <Button type="button" size="sm" variant="outline" className="h-8 shrink-0" disabled={busy || !newSub.trim()} onClick={add}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
    </div>
  );
}

function SubRow({ sub, types, busy, ver, staged, stagedTypeId, staging, onChange, onRemove }: {
  sub: SuspenseSubcategory;
  types: SuspenseType[];
  busy: boolean;
  ver: number;
  staged: boolean;
  stagedTypeId: string | null;
  staging: boolean;
  onChange: (s: SuspenseSubcategory) => void;
  onRemove: (id: string) => void;
}) {
  const typeId = staged ? stagedTypeId : sub.type_id ?? null;

  return (
    <div className={`px-2 py-2 transition-colors hover:bg-muted/30 sm:grid sm:items-center sm:gap-2 sm:py-1 ${COLS} ${staged ? 'bg-warning/5' : ''}`}>
      {/* On phones this wrapper is the card's first line (name + delete); from sm up `contents`
          dissolves it so both land in their own columns — delete last, via order. */}
      <div className="flex items-center gap-2 sm:contents">
        <Input
          key={`s${ver}`}
          defaultValue={sub.name}
          onBlur={e => { const n = e.target.value.trim(); if (n && n !== sub.name) onChange({ ...sub, name: n }); }}
          aria-label={`Subcategory name, ${sub.name}`}
          // Reads as plain text in the list; the field only draws itself when you reach for it.
          className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-2 shadow-none hover:border-input hover:bg-card focus-visible:border-input focus-visible:bg-card"
        />
        <Button type="button" size="icon-sm" variant="ghost" disabled={busy}
          className="shrink-0 text-muted-foreground hover:text-destructive sm:order-last sm:h-7 sm:w-7 sm:justify-self-end"
          onClick={() => onRemove(sub.id)} aria-label={`Delete subcategory ${sub.name}`} title="Delete subcategory">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="mt-1.5 flex items-center gap-3 sm:contents">
        <div className="min-w-0 flex-1 sm:flex-none">
          {types.length === 0 ? (
            <span className="block px-2 text-sm text-muted-foreground" title="This category has no types">—</span>
          ) : (
            <Select
              value={typeId ?? NONE}
              onValueChange={v => onChange({ ...sub, type_id: v === NONE ? null : v })}
              disabled={busy || staging}
            >
              <SelectTrigger className={`h-8 px-2 text-xs ${staged ? 'border-warning' : ''}`} aria-label={`Type for ${sub.name}`}>
                <SelectValue placeholder="No type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No type</SelectItem>
                {types.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* A span, not a label: Radix's Switch renders a <button>, which a <label> cannot activate. */}
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground sm:justify-center">
          <Switch checked={sub.allow_split} onCheckedChange={v => onChange({ ...sub, allow_split: v })}
            aria-label={`Allow employee split for ${sub.name}`} />
          <span className="sm:hidden">Split</span>
        </span>
      </div>
    </div>
  );
}
