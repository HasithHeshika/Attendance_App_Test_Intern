'use client';
import { useState } from 'react';
import { ChevronDown, Plus, Tags, Trash2 } from 'lucide-react';
import type { SuspenseType } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// The category's type pool (e.g. Fuel -> Diesel / Petrol), edited in a popover rather than by
// expanding the card: it is a rarely-touched list of two or three words, and inlining it pushed
// the subcategory table — the thing people actually came for — below the fold.
export default function TypePoolPopover({ types, busy, ver, onAdd, onRename, onRemove }: {
  types: SuspenseType[];
  busy: boolean;
  ver: number;
  /** Returns false when the name was rejected (duplicate) so the field keeps what was typed. */
  onAdd: (name: string) => boolean;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
}) {
  const [newType, setNewType] = useState('');
  const add = () => { if (onAdd(newType.trim())) setNewType(''); };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-muted-foreground">
          <Tags className="h-3.5 w-3.5" />
          {types.length ? `${types.length} type${types.length > 1 ? 's' : ''}` : 'Types'}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <p className="text-xs font-semibold text-foreground">Types in this category</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          e.g. Diesel, Petrol. Each subcategory below can be assigned one of them.
        </p>

        <div className="mt-2.5 space-y-1.5">
          {types.length === 0 && <p className="text-[11px] text-muted-foreground">No types yet.</p>}
          {types.map(t => (
            <div key={t.id} className="flex items-center gap-1.5">
              <Input key={`t${ver}`} defaultValue={t.name} onBlur={e => onRename(t.id, e.target.value)}
                className="h-8 flex-1" aria-label={`Type name, ${t.name}`} />
              <Button type="button" size="icon-sm" variant="ghost" disabled={busy}
                className="shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => onRemove(t.id)} aria-label={`Delete type ${t.name}`} title="Delete type">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>

        <div className="mt-2.5 flex items-center gap-1.5 border-t border-border/60 pt-2.5">
          <Input value={newType} onChange={e => setNewType(e.target.value)} placeholder="Add a type"
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} className="h-8 flex-1" aria-label="New type name" />
          <Button type="button" size="sm" variant="outline" className="h-8 shrink-0" disabled={busy || !newType.trim()} onClick={add}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
