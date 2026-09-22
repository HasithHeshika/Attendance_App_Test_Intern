'use client';
import { useState } from 'react';
import { ChevronDown, ShieldCheck, X } from 'lucide-react';
import type { AppUser, SuspenseApprover } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import SearchableSelect from '@/components/SearchableSelect';

// Who must sign a CREDIT REQUEST filed under this category. A pool, not a chain: any one of them
// clears it. Lives in a popover because it is set once and then left alone — it used to expand the
// card and push the subcategory table down every time someone glanced at it.
export default function CreditApproversPopover({ approvers, people, busy, onAdd, onRemove }: {
  approvers: SuspenseApprover[];
  people: AppUser[];
  busy: boolean;
  onAdd: (epf: string) => void;
  onRemove: (epf: string) => void;
}) {
  const [pick, setPick] = useState('');

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="ghost"
          className={`h-7 gap-1.5 px-2 ${approvers.length ? 'text-primary' : 'text-muted-foreground'}`}
          title="Who must approve a credit request filed under this category, before it reaches the suspense approvers">
          <ShieldCheck className="h-3.5 w-3.5" />
          Credit approvers{approvers.length ? ` · ${approvers.length}` : ''}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-3"
        // SearchableSelect renders its menu in a portal, i.e. outside this popover. Without this,
        // clicking an option counts as an outside press and closes the popover before the pick lands.
        onInteractOutside={e => {
          const t = e.target as HTMLElement | null;
          if (t?.closest('[data-searchable-select-menu]')) e.preventDefault();
        }}
      >
        <p className="text-xs font-semibold text-foreground">Credit approvers</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          A credit request filed under this category waits for <span className="font-medium text-foreground">any one</span> of
          these people before it reaches the suspense approvers. Leave it empty and the category adds no extra step.
          Expenses (bills) are unaffected.
        </p>

        {approvers.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {approvers.map(a => (
              <span key={a.epf} className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                {a.name}
                <span className="opacity-60">· {a.epf}</span>
                <button type="button" disabled={busy} onClick={() => onRemove(a.epf)}
                  aria-label={`Remove ${a.name}`} title="Remove" className="rounded-full p-0.5 hover:bg-primary/20">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="mt-2.5">
          <SearchableSelect
            value={pick}
            onChange={epf => { onAdd(epf); setPick(''); }}
            options={people
              .filter(u => u.epf_number && !approvers.some(a => a.epf === u.epf_number))
              .map(u => ({
                value: u.epf_number,
                label: u.display_name || u.epf_number,
                sublabel: [u.epf_number, u.role].filter(Boolean).join(' · ') || undefined,
                keywords: `${u.epf_number} ${u.email ?? ''} ${u.role ?? ''}`,
              }))}
            placeholder="Add an approver…"
            ariaLabel="Add a credit approver"
            emptyLabel="No matching users"
          />
        </div>

        <p className="mt-2 text-[11px] text-muted-foreground/80">
          Changes apply to requests filed from now on — requests already in flight keep the approvers they were filed with.
        </p>
      </PopoverContent>
    </Popover>
  );
}
