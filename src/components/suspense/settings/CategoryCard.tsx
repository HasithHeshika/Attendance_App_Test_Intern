'use client';
import { useState } from 'react';
import { ChevronDown, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import type { AppUser, SuspenseApprover, SuspenseCategory, SuspenseSubcategory, SuspenseType } from '@/lib/types';
import { newSubcategoryId } from '@/services/suspenseService';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import ConfirmModal from '@/components/ConfirmModal';
import CreditApproversPopover from '@/components/suspense/settings/CreditApproversPopover';
import SubcategoryTable from '@/components/suspense/settings/SubcategoryTable';
import TypePoolPopover from '@/components/suspense/settings/TypePoolPopover';

/**
 * One expense category. Collapsed it is a single summary line (name, how many subcategories, VAT,
 * how many types); expanding reveals its flags and the subcategory table. The rarely-touched lists
 * — the type pool and the credit approvers — sit behind popovers so they never push the table down.
 */
export default function CategoryCard({ category: c, busy, ver, people, onResync, onRenameCategory, onDeleteCategory, onSaveTaxo, onSaveFlags }: {
  category: SuspenseCategory; busy: boolean; ver: number; people: AppUser[]; onResync: () => void;
  onRenameCategory: (c: SuspenseCategory, name: string) => void;
  onDeleteCategory: (c: SuspenseCategory) => void;
  onSaveTaxo: (c: SuspenseCategory, patch: { types?: SuspenseType[]; subcategories?: SuspenseSubcategory[] }) => void;
  onSaveFlags: (c: SuspenseCategory, patch: { vat_default?: boolean; vat_rate?: number; group_in_vouchers?: boolean; credit_approvers?: SuspenseApprover[] }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<
    | { kind: 'type'; id: string; name: string; used: number }
    | { kind: 'sub'; id: string; name: string }
    | null
  >(null);
  const types   = c.types ?? [];
  const subs    = c.subcategories;
  const nSubs   = subs.length;

  // ── Credit approvers — who has to sign a credit request filed under this category ──
  // ANY ONE of them clears it, so this is a pool, not an ordered chain. The list is snapshotted
  // onto each request when it is filed, so edits here only affect requests filed from now on.
  const approvers = c.credit_approvers ?? [];
  const addApprover = (epf: string) => {
    const u = people.find(p => p.epf_number === epf);
    if (!u || approvers.some(a => a.epf === epf)) return;
    onSaveFlags(c, { credit_approvers: [...approvers, { epf, name: u.display_name || epf }] });
  };
  const removeApprover = (epf: string) =>
    onSaveFlags(c, { credit_approvers: approvers.filter(a => a.epf !== epf) });

  // ── Category-level type pool (e.g. Fuel → Diesel / Petrol) ──
  const addType = (n: string) => {
    if (!n) return false;
    if (types.some(t => t.name.toLowerCase() === n.toLowerCase())) { toast.error('That type already exists in this category.'); return false; }
    onSaveTaxo(c, { types: [...types, { id: newSubcategoryId(), name: n }] });
    return true;
  };
  const renameType = (id: string, name: string) => {
    const n = name.trim();
    if (!n || types.find(t => t.id === id)?.name === n) return;
    if (types.some(t => t.id !== id && t.name.toLowerCase() === n.toLowerCase())) { toast.error('Another type in this category has that name.'); onResync(); return; }
    onSaveTaxo(c, { types: types.map(t => (t.id === id ? { ...t, name: n } : t)) });
  };
  const requestRemoveType = (id: string) => {
    const t = types.find(x => x.id === id);
    if (!t) return;
    setConfirmRemove({ kind: 'type', id, name: t.name, used: subs.filter(s => s.type_id === id).length });
  };
  const removeType = (id: string) => {
    // Cascade: drop the type AND its assignments in one write, so no subcategory keeps a dead id.
    onSaveTaxo(c, {
      types: types.filter(x => x.id !== id),
      subcategories: subs.map(s => (s.type_id === id ? { ...s, type_id: null } : s)),
    });
  };

  // ── Subcategories (each assigned to at most ONE type from the pool above) ──
  const updateSub = (updated: SuspenseSubcategory) => {
    // A rename must not collide with a sibling — name-keyed lookups (form, submissions) would
    // silently bind to the first match and orphan the second.
    if (subs.some(s => s.id !== updated.id && s.name.toLowerCase() === updated.name.toLowerCase())) {
      toast.error('Another subcategory here has that name.'); onResync(); return;
    }
    onSaveTaxo(c, { subcategories: subs.map(s => (s.id === updated.id ? updated : s)) });
  };
  const addSub = (name: string) => {
    if (!name) return false;
    if (subs.some(s => s.name.toLowerCase() === name.toLowerCase())) { toast.error('That subcategory already exists here.'); return false; }
    onSaveTaxo(c, { subcategories: [...subs, { id: newSubcategoryId(), name, allow_split: false, type_id: null }] });
    return true;
  };
  const requestRemoveSub = (subId: string) => {
    const sub = subs.find(s => s.id === subId);
    if (!sub) return;
    setConfirmRemove({ kind: 'sub', id: subId, name: sub.name });
  };
  const removeSub = (subId: string) => {
    onSaveTaxo(c, { subcategories: subs.filter(s => s.id !== subId) });
  };
  // One write for the whole bulk assignment, not one per row.
  const bulkSetType = (ids: string[], typeId: string | null) => {
    const set = new Set(ids);
    onSaveTaxo(c, { subcategories: subs.map(s => (set.has(s.id) ? { ...s, type_id: typeId } : s)) });
  };

  return (
    <Card className="overflow-hidden">
      {/* Line 1 — identity: what it is called, how big it is, and how to get rid of it. */}
      <div className="flex items-center gap-2 p-2.5">
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          aria-label={open ? `Collapse ${c.name}` : `Expand ${c.name}`} title={open ? 'Collapse' : 'Expand'}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${open ? '' : '-rotate-90'}`} />
        </button>

        <Input key={`n${ver}`} defaultValue={c.name} onBlur={e => onRenameCategory(c, e.target.value)}
          className="min-w-0 max-w-xs flex-1 font-semibold" aria-label="Category name" />

        <Badge variant="muted" className="shrink-0 whitespace-nowrap">
          {nSubs} subcategor{nSubs === 1 ? 'y' : 'ies'}
        </Badge>

        {/* Collapsed, the badges have to carry the settings the flag row would have shown. */}
        {!open && c.vat_default && (
          <Badge variant="outline" className="hidden shrink-0 whitespace-nowrap sm:inline-flex">VAT {c.vat_rate ?? 0}%</Badge>
        )}
        {!open && types.length > 0 && (
          <Badge variant="muted" className="hidden shrink-0 whitespace-nowrap sm:inline-flex">
            {types.length} type{types.length > 1 ? 's' : ''}
          </Badge>
        )}

        <div className="flex-1" />

        <Button type="button" size="icon-sm" variant="ghost" disabled={busy}
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={() => onDeleteCategory(c)} aria-label={`Delete category ${c.name}`} title="Delete category">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {open && (
        <>
          {/* Line 2 — settings: the flags on the left, the two drill-ins on the right. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 bg-muted/20 px-3 py-2">
            <span className="flex items-center gap-2 text-xs">
              <Switch checked={!!c.vat_default} onCheckedChange={v => onSaveFlags(c, { vat_default: v })} aria-label="VAT bills by default" />
              <span className="font-medium text-foreground">VAT</span>
            </span>

            {c.vat_default && (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                VAT rate
                <span className="relative inline-block">
                  <Input key={`r${ver}`} type="number" inputMode="decimal" min="0" step="0.1" defaultValue={String(c.vat_rate ?? 0)}
                    onBlur={e => {
                      const n = Math.max(0, parseFloat(e.target.value) || 0);   // clamp; blank → 0 only if actually changed
                      if (n !== (c.vat_rate ?? 0)) onSaveFlags(c, { vat_rate: n });
                    }}
                    className="h-8 w-[5.5rem] pr-7 text-right tabular-nums" aria-label="Default VAT rate in percent" />
                  <span aria-hidden className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">%</span>
                </span>
              </label>
            )}

            <span className="flex items-center gap-2 text-xs"
              title="On (default): approved bills in this category join the shared rolling voucher like any other. Off: every approved bill opens its own new voucher instead — e.g. for one-off Asset purchases">
              <Switch checked={c.group_in_vouchers !== false} onCheckedChange={v => onSaveFlags(c, { group_in_vouchers: v })} aria-label="Group in vouchers" />
              <span className="font-medium text-foreground">Group in vouchers</span>
            </span>

            <div className="flex-1" />

            <div className="flex items-center gap-1">
              <TypePoolPopover types={types} busy={busy} ver={ver}
                onAdd={addType} onRename={renameType} onRemove={requestRemoveType} />
              <CreditApproversPopover approvers={approvers} people={people} busy={busy}
                onAdd={addApprover} onRemove={removeApprover} />
            </div>
          </div>

          <div className="space-y-2 p-2.5">
            <SubcategoryTable
              subs={subs} types={types} busy={busy} ver={ver}
              onChange={updateSub} onRemove={requestRemoveSub} onAdd={addSub} onBulkSetType={bulkSetType}
            />
            <p className="text-[11px] text-muted-foreground/80">
              A chamary (Working Places) can link to one of these subcategories, or create a new one named after itself — its bills then trace back to it automatically.
            </p>
          </div>
        </>
      )}

      <ConfirmModal
        open={!!confirmRemove}
        onOpenChange={() => setConfirmRemove(null)}
        variant="danger"
        title={confirmRemove?.kind === 'type' ? 'Delete type?' : 'Delete subcategory?'}
        description={
          confirmRemove?.kind === 'type'
            ? `“${confirmRemove.name}”${confirmRemove.used ? ` (assigned to ${confirmRemove.used} subcategor${confirmRemove.used > 1 ? 'ies' : 'y'})` : ''} will be deleted.`
            : confirmRemove
              ? `“${confirmRemove.name}” will be deleted.`
              : undefined
        }
        confirmText="Delete"
        onConfirm={() => {
          if (confirmRemove?.kind === 'type') removeType(confirmRemove.id);
          else if (confirmRemove?.kind === 'sub') removeSub(confirmRemove.id);
          setConfirmRemove(null);
        }}
      />
    </Card>
  );
}
