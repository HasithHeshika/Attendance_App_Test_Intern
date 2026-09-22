'use client';
import { useState, useEffect, useRef } from 'react';
import { Loader2, Plus, Tags, Download, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import type { AppUser, SuspenseApprover, SuspenseCategory, SuspenseSubcategory, SuspenseType } from '@/lib/types';
import { listSuspenseCategories, createCategory, updateCategory, deleteCategory, newSubcategoryId } from '@/services/suspenseService';
import { getAllUsers } from '@/services/userService';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import ConfirmModal from '@/components/ConfirmModal';
import CategoryCard from '@/components/suspense/settings/CategoryCard';

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

// Manage the expense taxonomy: category → subcategory → type (each level optional), plus a
// per-category VAT default. "Split with employees" is per-subcategory; the submit form reads all
// of this to drive its Category/Subcategory/Type selects, the VAT checkbox, and the split UI.
export default function SuspenseSettings({ onChanged }: { onChanged?: () => void }) {
  const [cats, setCats]       = useState<SuspenseCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [newCat, setNewCat]   = useState('');
  const [busy, setBusy]       = useState(false);
  // Who can be named as a credit-request approver. getAllUsers, NOT getAllEmployees: the person
  // who signs off a category's spend is usually a manager or an admin, and getAllEmployees keeps
  // only is_employee roles — which would leave half of them unpickable.
  const [people, setPeople]   = useState<AppUser[]>([]);
  useEffect(() => { getAllUsers().then(setPeople).catch(() => {}); }, []);
  // Bumped on every server resync — included in input keys so uncontrolled (defaultValue)
  // fields remount and show the authoritative value after a rejected/failed edit.
  const [ver, setVer]         = useState(0);

  const load = async () => {
    setLoading(true);
    try { setCats(await listSuspenseCategories()); setVer(v => v + 1); }
    catch { toast.error('Failed to load categories.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const patchLocal = (id: string, up: (c: SuspenseCategory) => SuspenseCategory) =>
    setCats(prev => prev.map(c => (c.id === id ? up(c) : c)));

  // Optimistic local update + persist (types and/or subcategories together, so a type delete can
  // cascade out of subcategory assignments in ONE write). On failure, resync from the server.
  const persistTaxo = async (c: SuspenseCategory, patch: { types?: SuspenseType[]; subcategories?: SuspenseSubcategory[] }) => {
    patchLocal(c.id, x => ({ ...x, ...patch }));
    try { await updateCategory(c.id, patch); onChanged?.(); }
    catch (e) { toast.error(errMsg(e, 'Failed to save.')); load(); }
  };
  const persistFlags = async (c: SuspenseCategory, patch: { vat_default?: boolean; vat_rate?: number; group_in_vouchers?: boolean; credit_approvers?: SuspenseApprover[] }) => {
    patchLocal(c.id, x => ({ ...x, ...patch }));
    try { await updateCategory(c.id, patch); onChanged?.(); }
    catch (e) { toast.error(errMsg(e, 'Failed to save.')); load(); }
  };
  const renameCat = async (c: SuspenseCategory, name: string) => {
    const n = name.trim();
    if (!n || n === c.name) { if (!n) load(); return; }   // blank blur → resync the field to the stored name
    if (cats.some(x => x.id !== c.id && x.name.toLowerCase() === n.toLowerCase())) {
      toast.error('Another category already has that name.'); load(); return;   // resync rejected input
    }
    patchLocal(c.id, x => ({ ...x, name: n }));
    try { await updateCategory(c.id, { name: n }); onChanged?.(); }
    catch (e) { toast.error(errMsg(e, 'Failed to rename.')); load(); }
  };

  const addCategory = async () => {
    if (busy) return;   // a held/double Enter must not create the same category twice mid-flight
    const name = newCat.trim();
    if (!name) return;
    if (cats.some(c => c.name.toLowerCase() === name.toLowerCase())) { toast.error('That category already exists.'); return; }
    setBusy(true);
    try { await createCategory(name); setNewCat(''); await load(); onChanged?.(); }
    catch (e) { toast.error(errMsg(e, 'Failed to add category.')); }
    finally { setBusy(false); }
  };
  const [confirmCat, setConfirmCat] = useState<SuspenseCategory | null>(null);
  const removeCategory = async (c: SuspenseCategory) => {
    setBusy(true);
    try { await deleteCategory(c.id); await load(); onChanged?.(); }
    catch (e) { toast.error(errMsg(e, 'Failed to delete category.')); }
    finally { setBusy(false); }
  };

  // ── Bulk import/export via CSV ──
  // One row per subcategory (a category-only row, with subcategory blank, just ensures the
  // category exists/updates its flags). `type` is the ONE type name this subcategory belongs to
  // (blank = none) — matches the one-type-per-subcategory model. Import is a pure MERGE: existing
  // categories/subcategories/types are matched by name (case-insensitive) and updated in place —
  // preserving their ids, since chamaries link to a subcategory by id — new ones are created, and
  // anything already in Settings but NOT mentioned in the file is left untouched, never deleted.
  const importFileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const downloadSample = async () => {
    const { utils, writeFile } = await import('xlsx');
    const aoa = [
      ['category', 'vat_default', 'vat_rate', 'group_in_vouchers', 'subcategory', 'allow_split', 'type'],
      ['Fuel', 'FALSE', '0', 'TRUE', 'ABC-1234', 'FALSE', 'Diesel'],
      ['Fuel', 'FALSE', '0', 'TRUE', 'XYZ-5678', 'FALSE', 'Petrol'],
      ['Travel', 'TRUE', '18', 'TRUE', 'Rohan Travels', 'FALSE', ''],
      ['Assets', 'FALSE', '0', 'FALSE', 'Laptop', 'FALSE', ''],
    ];
    const ws = utils.aoa_to_sheet(aoa);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, 'Categories');
    writeFile(wb, 'suspense_categories_sample.csv', { bookType: 'csv' });
  };

  // Every category/subcategory/type/split setting currently configured, in the same shape the
  // importer reads — one row per subcategory (a category with none gets one category-only row),
  // so the full taxonomy round-trips through a single file: edit it and re-import to bulk-update.
  const exportCsv = async () => {
    if (!cats.length) { toast.error('No categories to export yet.'); return; }
    const { utils, writeFile } = await import('xlsx');
    const aoa: (string | number)[][] = [
      ['category', 'vat_default', 'vat_rate', 'group_in_vouchers', 'subcategory', 'allow_split', 'type'],
    ];
    for (const c of cats) {
      const typeName = (id: string | null | undefined) => c.types?.find(t => t.id === id)?.name ?? '';
      const flags = [c.vat_default ? 'TRUE' : 'FALSE', c.vat_rate ?? 0, c.group_in_vouchers !== false ? 'TRUE' : 'FALSE'];
      if (c.subcategories.length === 0) {
        aoa.push([c.name, ...flags, '', '', '']);
      } else {
        for (const s of c.subcategories) {
          aoa.push([c.name, ...flags, s.name, s.allow_split ? 'TRUE' : 'FALSE', typeName(s.type_id)]);
        }
      }
    }
    const ws = utils.aoa_to_sheet(aoa);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, 'Categories');
    writeFile(wb, `suspense_categories_${new Date().toISOString().slice(0, 10)}.csv`, { bookType: 'csv' });
  };

  const parseBool = (v: unknown, dflt: boolean): boolean => {
    const s = String(v ?? '').trim().toLowerCase();
    if (!s) return dflt;
    return ['true', '1', 'yes', 'y'].includes(s);
  };

  const handleImportFile = async (file: File) => {
    setImporting(true);
    try {
      const { read, utils } = await import('xlsx');
      const text = await file.text();
      const wb = read(text, { type: 'string' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const raw = utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });

      interface Row { category: string; vat_default: boolean; vat_rate: number; group_in_vouchers: boolean; subcategory: string; allow_split: boolean; type: string }
      const rows: Row[] = [];
      let skipped = 0;
      for (const r of raw) {
        const category = String(r.category ?? '').trim();
        if (!category) { skipped++; continue; }
        rows.push({
          category,
          vat_default: parseBool(r.vat_default, false),
          vat_rate: Math.max(0, Number(r.vat_rate) || 0),
          group_in_vouchers: parseBool(r.group_in_vouchers, true),
          subcategory: String(r.subcategory ?? '').trim(),
          allow_split: parseBool(r.allow_split, false),
          type: String(r.type ?? '').trim(),
        });
      }
      if (!rows.length) { toast.error('No valid rows found in that file — every row needs a category.'); return; }

      // Group by category name (case-insensitive), preserving the first-seen casing.
      const byCategory = new Map<string, Row[]>();
      for (const r of rows) {
        const key = r.category.toLowerCase();
        if (!byCategory.has(key)) byCategory.set(key, []);
        byCategory.get(key)!.push(r);
      }

      let catsCreated = 0, catsUpdated = 0, subsCreated = 0, subsUpdated = 0;

      for (const catRows of byCategory.values()) {
        const name = catRows[0].category;
        const existingCat = cats.find(c => c.name.toLowerCase() === name.toLowerCase());
        let catId = existingCat?.id;
        if (catId) catsUpdated++;
        else { catId = await createCategory(name); catsCreated++; }

        // Types: one per distinct non-blank type name in this category's rows — reuse an
        // existing type's id (matched by name) so already-linked subcategories stay linked.
        const types = [...(existingCat?.types ?? [])];
        const typeIdByName = new Map(types.map(t => [t.name.toLowerCase(), t.id]));
        for (const r of catRows) {
          if (!r.type) continue;
          const key = r.type.toLowerCase();
          if (!typeIdByName.has(key)) {
            const id = newSubcategoryId();
            typeIdByName.set(key, id);
            types.push({ id, name: r.type });
          }
        }

        // Subcategories: upsert by name, preserving existing ids.
        const subsByName = new Map((existingCat?.subcategories ?? []).map(s => [s.name.toLowerCase(), s]));
        for (const r of catRows) {
          if (!r.subcategory) continue;
          const key = r.subcategory.toLowerCase();
          const typeId = r.type ? (typeIdByName.get(r.type.toLowerCase()) ?? null) : null;
          const prior = subsByName.get(key);
          if (prior) { subsByName.set(key, { ...prior, allow_split: r.allow_split, type_id: typeId }); subsUpdated++; }
          else { subsByName.set(key, { id: newSubcategoryId(), name: r.subcategory, allow_split: r.allow_split, type_id: typeId }); subsCreated++; }
        }

        await updateCategory(catId, {
          types, subcategories: [...subsByName.values()],
          vat_default: catRows[0].vat_default, vat_rate: catRows[0].vat_rate, group_in_vouchers: catRows[0].group_in_vouchers,
        });
      }

      toast.success(
        `Imported: ${catsCreated} categor${catsCreated === 1 ? 'y' : 'ies'} created, ${catsUpdated} updated · ` +
        `${subsCreated} subcategor${subsCreated === 1 ? 'y' : 'ies'} added, ${subsUpdated} updated` +
        (skipped ? ` · ${skipped} row${skipped > 1 ? 's' : ''} skipped (no category)` : '')
      );
      await load();
      onChanged?.();
    } catch (e) { toast.error(errMsg(e, 'Failed to import the CSV file.')); }
    finally { setImporting(false); if (importFileRef.current) importFileRef.current.value = ''; }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-brand text-primary-foreground shadow-soft ring-1 ring-inset ring-[hsl(0_0%_100%/0.15)]">
          <Tags className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Expense categories</h2>
          <p className="text-sm text-muted-foreground">Category → subcategory → type (each level optional). Turn on <span className="font-medium text-foreground">Split</span> for subcategories that can be shared, and <span className="font-medium text-foreground">VAT</span> for categories whose bills are VAT bills by default. Name <span className="font-medium text-foreground">credit approvers</span> on a category to make its credit requests wait for one of those people.</p>
        </div>
      </div>

      {/* Add category */}
      <div className="flex flex-wrap items-center gap-2">
        <Input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="New category name"
          onKeyDown={e => { if (e.key === 'Enter') addCategory(); }} className="max-w-xs" />
        <Button size="sm" disabled={busy || !newCat.trim()} onClick={addCategory}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plus className="h-4 w-4" /> Add category</>}
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={downloadSample}><Download className="h-4 w-4" /> Sample CSV</Button>
        <Button size="sm" variant="outline" onClick={exportCsv}><Download className="h-4 w-4" /> Export CSV</Button>
        <label className={`inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${importing ? 'pointer-events-none opacity-60' : 'cursor-pointer'}`}>
          {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Import CSV
          <input ref={importFileRef} type="file" accept=".csv,text/csv" className="hidden" disabled={importing}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); }} />
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Export CSV downloads every category, subcategory, type, and split setting currently configured — edit it and re-import to bulk-update. Import merges by name: matching entries are updated, new ones are added, and anything not in the file is left untouched (nothing is deleted).
      </p>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : cats.length === 0 ? (
        <EmptyState icon={Tags} title="No categories yet" description="Add your first expense category above to get started." />
      ) : (
        <div className="space-y-3">
          {cats.map(c => (
            <CategoryCard key={c.id} category={c} busy={busy} ver={ver} people={people} onResync={load}
              onRenameCategory={renameCat} onDeleteCategory={setConfirmCat} onSaveTaxo={persistTaxo} onSaveFlags={persistFlags} />
          ))}
        </div>
      )}

      <ConfirmModal
        open={!!confirmCat}
        onOpenChange={() => setConfirmCat(null)}
        variant="danger"
        title="Delete category?"
        description={confirmCat ? `“${confirmCat.name}” and everything under it will be deleted. Existing expenses keep their label.` : undefined}
        confirmText="Delete"
        busy={busy}
        onConfirm={async () => {
          const c = confirmCat;
          setConfirmCat(null);
          if (c) await removeCategory(c);
        }}
      />
    </div>
  );
}
