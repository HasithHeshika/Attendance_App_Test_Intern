'use client';
import { useEffect, useMemo, useState } from 'react';
import { Wallet, Loader2, Building2, Users as UsersIcon, X, Download, ArrowDownRight, SlidersHorizontal, ChevronDown, CheckCircle2, Tags, Layers, GitBranch, Rows3, Receipt } from 'lucide-react';
import toast from 'react-hot-toast';
import type { Company, AppUser, SuspenseSubmission, SuspenseSplit, SuspenseCategory } from '@/lib/types';
import { getAllEmployees } from '@/services/userService';
import { getSuspenseSubmissionsReport, formatSuspenseAmount, listSuspenseCategories } from '@/services/suspenseService';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import Combobox from '@/components/Combobox';
import Select from '@/components/Select';
import MonthYearPicker from '@/components/MonthYearPicker';
import BillThumb from '@/components/BillThumb';
import { EmptyState } from '@/components/ui/empty-state';
import { useReportEditor, ReportEditControls, EditableCell, numeric, type ReportEditor } from '@/components/reports/editableReport';

type GroupBy = 'none' | 'type' | 'shop';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const sumSplits = (s?: SuspenseSplit[]) => (s ?? []).reduce((t, x) => t + (x.amount || 0), 0);
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;   // match the service's money()

function whenMs(ts: unknown): number | null {
  const v = ts as { toMillis?: () => number; seconds?: number } | null;
  if (v?.toMillis) return v.toMillis();
  if (v?.seconds != null) return v.seconds * 1000;
  return null;
}
function fmtWhen(ts: unknown): string {
  const ms = whenMs(ts);
  if (ms == null) return '';
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}
function fmtDateOnly(ts: unknown): string {
  const ms = whenMs(ts);
  if (ms == null) return '';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const statusVariant = (s: string): 'success' | 'destructive' | 'warning' =>
  s === 'approved' ? 'success' : s === 'rejected' ? 'destructive' : 'warning';

// Buckets bills for on-screen display — by type (e.g. Fuel bills split into Diesel vs Petrol) or
// by shop/supplier name (VAT bills filtered to one shop each, for filing/reconciliation) — same
// grouping rationale as the VAT export below, just for the live list instead of a download.
function groupRows(items: SuspenseSubmission[], by: Exclude<GroupBy, 'none'>): { label: string; items: SuspenseSubmission[] }[] {
  const map = new Map<string, SuspenseSubmission[]>();
  for (const s of items) {
    const key = by === 'type' ? (s.type || '(no type)') : (s.shop_name || '(unknown supplier)');
    const arr = map.get(key);
    if (arr) arr.push(s); else map.set(key, [s]);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, its]) => ({ label, items: its }));
}

// Excel sheet names: no \ / ? * [ ] : , max 31 chars, must be unique in the workbook (case-insensitive).
function xlsxSheetName(base: string, used: Set<string>): string {
  const cleaned = base.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let name = cleaned;
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = cleaned.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

// Chunked to avoid blowing the call stack on String.fromCharCode(...bytes) for large images.
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

type FetchedImage = { base64: string; extension: 'jpeg' | 'png' | 'gif' };

// Best-effort fetch of a bill's image bytes for embedding into the export — failures (network,
// non-image content, CORS) just mean that row falls back to a plain hyperlink, never a thrown error.
async function fetchBillImage(url: string): Promise<FetchedImage | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const extension: FetchedImage['extension'] = ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : 'jpeg';
    const base64 = arrayBufferToBase64(await res.arrayBuffer());
    return { base64: `data:image/${extension};base64,${base64}`, extension };
  } catch { return null; }
}

// On-page suspense report: expense submissions (with the bill image), filterable by its OWN
// company / year / month / employee / status — independent of the attendance report's filters.
export default function SuspenseReport({ companies }: { companies: Company[] }) {
  const now = new Date();
  const [companyId, setCompanyId] = useState('');
  const [year, setYear]           = useState(now.getFullYear());
  const [month, setMonth]         = useState(now.getMonth() + 1);
  const [employees, setEmployees] = useState<AppUser[]>([]);
  const [epf, setEpf]         = useState('');
  const [status, setStatus]   = useState('all');
  const [category, setCategory]       = useState('');
  const [subcategory, setSubcategory] = useState('');
  const [type, setType]       = useState('');
  const [vatOnly, setVatOnly] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [rows, setRows]       = useState<SuspenseSubmission[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Full expense taxonomy (Settings), fetched independently of any loaded report — so Category /
  // Sub category / Type are pickable BEFORE "Load report" is ever clicked, not just refinements
  // of whatever happens to already be on screen.
  const [taxonomy, setTaxonomy] = useState<SuspenseCategory[]>([]);
  // Employee / category / subcategory / type / status / VAT are refinements applied after
  // loading — tucked behind a toggle so the primary "pick a period, load" action isn't buried
  // under a wall of fields at once.
  const [showFilters, setShowFilters] = useState(false);

  const yearOptions = [2023, 2024, 2025, 2026].filter(y => y <= now.getFullYear());

  useEffect(() => { getAllEmployees(companyId).then(setEmployees).catch(() => setEmployees([])); }, [companyId]);
  useEffect(() => { listSuspenseCategories().then(setTaxonomy).catch(() => {}); }, []);
  // Drop the employee filter if the picked person isn't in the (company-scoped) list.
  useEffect(() => { if (epf && !employees.some(u => u.epf_number === epf)) setEpf(''); }, [employees, epf]);
  // Loaded rows belong to the company/month they were fetched for; clear them when the shared
  // scope changes so the (live-prop) header, summary and export can never mislabel stale data.
  useEffect(() => { setRows(null); }, [companyId, year, month]);

  const load = async () => {
    setLoading(true);
    try {
      const fromMs = new Date(year, month - 1, 1).getTime();
      const toMs   = new Date(year, month, 1).getTime() - 1;
      setRows(await getSuspenseSubmissionsReport({ companyId: companyId || undefined, fromMs, toMs }));
    } catch { toast.error('Failed to load the suspense report.'); setRows([]); }
    finally { setLoading(false); }
  };

  // Every category name in the taxonomy — always available, independent of whether/what's been
  // loaded. Sub category and Type options are scoped to the picked category (if any), same
  // cascading idea as the submit form's Category → Sub category → Type picker.
  const categoryOptions = useMemo(() =>
    taxonomy.map(c => c.name).sort((a, b) => a.localeCompare(b)),
    [taxonomy]);
  const categoryScoped = useMemo(() => category ? taxonomy.filter(c => c.name === category) : taxonomy, [taxonomy, category]);
  const subcategoryOptions = useMemo(() =>
    [...new Set(categoryScoped.flatMap(c => c.subcategories.map(s => s.name)))].sort((a, b) => a.localeCompare(b)),
    [categoryScoped]);
  const typeOptions = useMemo(() =>
    [...new Set(categoryScoped.flatMap(c => (c.types ?? []).map(t => t.name)))].sort((a, b) => a.localeCompare(b)),
    [categoryScoped]);
  // Drop the subcategory/type filter if it's no longer valid once the category changes.
  useEffect(() => { if (subcategory && !subcategoryOptions.includes(subcategory)) setSubcategory(''); }, [subcategoryOptions, subcategory]);
  useEffect(() => { if (type && !typeOptions.includes(type)) setType(''); }, [typeOptions, type]);

  const shown = useMemo(() => (rows ?? []).filter(s =>
    (!epf || s.epf_number === epf) && (status === 'all' || s.status === status) && (!type || s.type === type) &&
    (!category || s.category === category) && (!subcategory || s.subcategory === subcategory) && (!vatOnly || s.is_vat)
  ), [rows, epf, status, type, category, subcategory, vatOnly]);

  const totalBill   = shown.reduce((t, s) => t + s.amount, 0);
  const companyName = companyId ? (companies.find(c => c.id === companyId)?.name ?? '—') : 'All companies';
  const activeFilterCount = (epf ? 1 : 0) + (status !== 'all' ? 1 : 0) + (type ? 1 : 0) + (category ? 1 : 0) + (subcategory ? 1 : 0) + (vatOnly ? 1 : 0);
  const clearFilters = () => { setEpf(''); setStatus('all'); setType(''); setCategory(''); setSubcategory(''); setVatOnly(false); };

  const empOptions = employees.map(u => ({ value: u.epf_number, label: `${u.display_name} · ${u.epf_number}` }));

  // Full export, one sheet per employee, with the actual bill photo embedded in each row
  // (not just a link to it) — PDFs and bills that fail to fetch fall back to a "View bill" link.
  // Edit-before-download: corrections live on screen and in the file, never in Firestore.
  // Keyed by submission id, so an edit sticks to the right bill through filtering and grouping.
  const editor = useReportEditor();
  const v = <T extends string | number>(id: string, field: string, original: T): T => editor.value(id, field, original);

  const exportXlsx = async () => {
    if (!shown.length) return;
    setExporting(true);
    try {
      const ExcelJS = (await import('exceljs')).default;
      const header = ['BILL NO', 'SUBMITTED', 'BILL DATE', 'EMPLOYEE', 'EPF', 'SUBMITTED BY', 'COMPANY', 'EXPENSE TYPE', 'SHOP', 'ITEM', 'BILL TOTAL', 'VAT BILL', 'VAT NO', 'VAT AMOUNT', 'OWN SHARE', 'SPLIT TO OTHERS', 'STATUS', 'CONSIDERED BY', 'BILL'];
      const billCol = header.length;

      // Fetch every image-type bill's bytes up front, in parallel, once — reused across sheets.
      const imageBills = shown.filter(s => s.bill_type === 'image' && s.bill_url);
      const fetched = await Promise.all(imageBills.map(s => fetchBillImage(s.bill_url!)));
      const images = new Map(imageBills.map((s, i) => [s.id, fetched[i]] as const));

      const wb = new ExcelJS.Workbook();

      // One sheet per employee — an "all employees" export otherwise mixes everyone's bills
      // into one long list, which isn't handy to split up or hand out per person afterwards.
      const byEpf = new Map<string, SuspenseSubmission[]>();
      for (const s of shown) {
        const arr = byEpf.get(s.epf_number);
        if (arr) arr.push(s); else byEpf.set(s.epf_number, [s]);
      }
      const groups = [...byEpf.values()].sort((a, b) => a[0].employee_name.localeCompare(b[0].employee_name));

      const usedNames = new Set<string>();
      for (const group of groups) {
        const ws = wb.addWorksheet(xlsxSheetName(`${group[0].employee_name} ${group[0].epf_number}`, usedNames));
        ws.columns = header.map((h, i) => ({ header: h, width: i === billCol - 1 ? 14 : Math.max(h.length, 10) + 2 }));
        ws.getRow(1).font = { bold: true };

        group.forEach(s => {
          const amount = numeric(v(s.id, 'amount', round2(s.amount)));
          const row = ws.addRow([
            v(s.id, 'bill_no', s.bill_no ?? ''), fmtWhen(s.created_at), fmtDateOnly(s.bill_date ?? s.created_at),
            v(s.id, 'employee_name', s.employee_name), s.epf_number,
            (s.submitted_by_epf && s.submitted_by_epf !== s.epf_number) ? `${s.submitted_by_name ?? ''} · ${s.submitted_by_epf}` : '',
            s.company_name, s.expense_type, v(s.id, 'shop_name', s.shop_name ?? ''), v(s.id, 'item', s.item ?? ''),
            amount,
            s.is_vat ? 'YES' : 'NO', s.is_vat ? v(s.id, 'vat_number', s.vat_number ?? '') : '',
            s.is_vat ? numeric(v(s.id, 'vat_amount', round2(s.vat_amount ?? 0))) : 0,
            round2(amount - sumSplits(s.splits)),
            (s.splits ?? []).map(sp => `${sp.employee_name}:${round2(sp.amount)}`).join('; '),
            s.status, s.considered_by_name ?? '', '',
          ]);
          row.height = 55;

          const img = images.get(s.id);
          if (img) {
            const imageId = wb.addImage({ base64: img.base64, extension: img.extension });
            ws.addImage(imageId, { tl: { col: billCol - 1, row: row.number - 1 }, ext: { width: 70, height: 70 } });
          } else if (s.bill_url) {
            const cell = row.getCell(billCol);
            cell.value = { text: s.bill_type === 'pdf' ? 'View PDF' : 'View bill', hyperlink: s.bill_url };
            cell.font = { color: { argb: 'FF1155CC' }, underline: true };
          }
        });
      }

      const safe = (companyName || 'all').replace(/[^a-z0-9]+/gi, '_');
      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `suspense_report_${safe}_${year}_${String(month).padStart(2, '0')}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to build the report.');
    } finally {
      setExporting(false);
    }
  };

  // VAT bills only, grouped into sections by supplier and then by type (e.g. Fuel bills split into
  // Diesel vs Petrol) — for filing/reconciliation, where bills need to be organized by who they
  // were paid to before anything else. Same columns as the full export, just sectioned/sorted.
  const exportVatBillsXlsx = async () => {
    const vatRows = shown.filter(s => s.is_vat);
    if (!vatRows.length) { toast.error('No VAT bills match the current filters.'); return; }
    const { utils, writeFile } = await import('xlsx');
    const header = ['BILL NO', 'SUBMITTED', 'BILL DATE', 'EMPLOYEE', 'EPF', 'SUBMITTED BY', 'COMPANY', 'EXPENSE TYPE', 'SHOP', 'ITEM', 'BILL TOTAL', 'VAT NO', 'VAT AMOUNT', 'STATUS', 'CONSIDERED BY', 'BILL LINK'];
    const sorted = [...vatRows].sort((a, b) =>
      (a.shop_name || '').localeCompare(b.shop_name || '') ||
      (a.type || '').localeCompare(b.type || '') ||
      (whenMs(a.created_at) ?? 0) - (whenMs(b.created_at) ?? 0)
    );
    const aoa: (string | number)[][] = [header];
    let curShop: string | null = null, curType: string | null = null;
    for (const s of sorted) {
      const shop = s.shop_name || '(unknown supplier)';
      const type = s.type || '(none)';
      if (shop !== curShop) { aoa.push([`SUPPLIER: ${shop}`]); curShop = shop; curType = null; }
      if (type !== curType) { aoa.push([`  TYPE: ${type}`]); curType = type; }
      aoa.push([
        v(s.id, 'bill_no', s.bill_no ?? ''), fmtWhen(s.created_at), fmtDateOnly(s.bill_date ?? s.created_at),
        v(s.id, 'employee_name', s.employee_name), s.epf_number,
        (s.submitted_by_epf && s.submitted_by_epf !== s.epf_number) ? `${s.submitted_by_name ?? ''} · ${s.submitted_by_epf}` : '',
        s.company_name, s.expense_type, v(s.id, 'shop_name', s.shop_name ?? ''), v(s.id, 'item', s.item ?? ''),
        numeric(v(s.id, 'amount', round2(s.amount))),
        v(s.id, 'vat_number', s.vat_number ?? ''),
        numeric(v(s.id, 'vat_amount', round2(s.vat_amount ?? 0))),
        s.status, s.considered_by_name ?? '', s.bill_url ?? '',
      ]);
    }
    const ws = utils.aoa_to_sheet(aoa);
    ws['!cols'] = header.map((h, i) => ({ wch: Math.max(String(h).length, ...aoa.map(r => String(r[i] ?? '').length)) + 2 }));
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, `VAT bills ${MONTHS[month - 1]} ${year}`);
    const safe = (companyName || 'all').replace(/[^a-z0-9]+/gi, '_');
    writeFile(wb, `suspense_vat_bills_${safe}_${year}_${String(month).padStart(2, '0')}.xlsx`);
  };

  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-brand text-primary-foreground shadow-soft ring-1 ring-inset ring-[hsl(0_0%_100%/0.15)]">
          <Wallet className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Suspense report</h2>
          <p className="text-sm text-muted-foreground">Expense bills for {companyName} · {MONTHS[month - 1]} {year}</p>
        </div>
      </div>

      {/* Step 1: pick a period, then load — the primary, always-visible action */}
      <div className="space-y-2">
        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Report period</Label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select searchable value={companyId || 'all'} onChange={v => setCompanyId(v === 'all' ? '' : v)}
            options={[{ value: 'all', label: 'All companies' }, ...companies.map(c => ({ value: c.id, label: c.name }))]} />
          <MonthYearPicker year={year} month={month} years={yearOptions} onChange={(y, m) => { setYear(y); setMonth(m); }} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={load} disabled={loading} className="h-11">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Load report'}
        </Button>
        <button
          type="button"
          onClick={() => setShowFilters(v => !v)}
          className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-border px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${showFilters ? 'rotate-180' : ''}`} />
        </button>
        {activeFilterCount > 0 && (
          <button type="button" onClick={clearFilters} className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" /> Clear
          </button>
        )}
      </div>

      {/* Step 2 (optional): narrow down by employee / category / subcategory / type / status / VAT
          — refines what's already loaded. Group by is a display preference, not a filter. */}
      {showFilters && (
        <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-border/60 bg-muted/20 p-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><UsersIcon className="h-3.5 w-3.5" /> Employee</Label>
            <Combobox value={epf} onChange={setEpf} allowCustom={false} placeholder="All employees" options={empOptions} />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><Layers className="h-3.5 w-3.5" /> Category</Label>
            <Select value={category || 'all'} onChange={v => setCategory(v === 'all' ? '' : v)}
              options={[{ value: 'all', label: 'Any category' }, ...categoryOptions.map(c => ({ value: c, label: c }))]} />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><GitBranch className="h-3.5 w-3.5" /> Sub category</Label>
            <Select value={subcategory || 'all'} onChange={v => setSubcategory(v === 'all' ? '' : v)}
              options={[{ value: 'all', label: 'Any sub category' }, ...subcategoryOptions.map(s => ({ value: s, label: s }))]} />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><Tags className="h-3.5 w-3.5" /> Type</Label>
            <Select value={type || 'all'} onChange={v => setType(v === 'all' ? '' : v)}
              options={[{ value: 'all', label: 'Any type' }, ...typeOptions.map(t => ({ value: t, label: t }))]} />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5" /> Status</Label>
            <Select value={status} onChange={setStatus} options={[
              { value: 'all', label: 'Any status' },
              { value: 'pending', label: 'Pending' },
              { value: 'approved', label: 'Approved' },
              { value: 'rejected', label: 'Rejected' },
            ]} />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><Rows3 className="h-3.5 w-3.5" /> Group by</Label>
            <Select value={groupBy} onChange={v => setGroupBy(v as GroupBy)} options={[
              { value: 'none', label: 'No grouping' },
              { value: 'type', label: 'Type' },
              { value: 'shop', label: 'Shop / supplier' },
            ]} />
          </div>
          <label className="flex items-center gap-2 self-end pb-1.5 text-xs font-medium text-foreground">
            <Switch checked={vatOnly} onCheckedChange={setVatOnly} />
            <Receipt className="h-3.5 w-3.5 text-muted-foreground" /> VAT bills only
          </label>
        </div>
      )}

      {/* Results */}
      {rows === null ? (
        <p className="mt-5 text-center text-sm text-muted-foreground">Choose a company / month above, then <span className="font-medium text-foreground">Load report</span>.</p>
      ) : loading ? (
        <div className="mt-6 flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : shown.length === 0 ? (
        <div className="mt-4"><EmptyState icon={Wallet} title="No suspense bills" description="No expense submissions match these filters for the selected period." /></div>
      ) : (
        <>
          <div className="mt-5 mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{shown.length}</span> bill{shown.length === 1 ? '' : 's'} · total <span className="font-semibold text-foreground tabular-nums">{formatSuspenseAmount(totalBill, 'LKR')}</span>
              <span className="hidden sm:inline"> · tap a bill to view it</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ReportEditControls editor={editor} />
              <Button size="sm" variant="outline" onClick={exportXlsx} disabled={exporting}>
                {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Export
              </Button>
              <Button size="sm" variant="outline" onClick={exportVatBillsXlsx}><Download className="h-4 w-4" /> Export VAT bills</Button>
            </div>
          </div>

          {groupBy === 'none' ? (
            <div className="max-h-[34rem] space-y-2.5 overflow-y-auto pr-1 scrollbar-thin">
              {shown.map(s => <BillRow key={s.id} s={s} editor={editor} />)}
            </div>
          ) : (
            <div className="max-h-[34rem] space-y-4 overflow-y-auto pr-1 scrollbar-thin">
              {groupRows(shown, groupBy).map(g => (
                <div key={g.label}>
                  <div className="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{g.label} · {g.items.length}</div>
                  <div className="space-y-2.5">
                    {g.items.map(s => <BillRow key={s.id} s={s} editor={editor} />)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// In edit mode the fields an admin actually corrects before sending a report out — the name,
// what was bought and where, and the money — become inputs in place. Everything else (dates,
// EPF, status, who approved it) stays read-only: those are facts about the record, not the
// presentation of it.
function BillRow({ s, editor }: { s: SuspenseSubmission; editor: ReportEditor }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-card/60 p-3">
      <BillThumb url={s.bill_url} type={s.bill_type} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><ArrowDownRight className="h-3.5 w-3.5 text-destructive" /> {s.expense_type || 'Expense'}</span>
          <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-sm text-foreground">
          <EditableCell editor={editor} rowKey={s.id} field="employee_name" value={s.employee_name} className="truncate" />
          <span className="shrink-0 text-muted-foreground">· {s.epf_number}</span>
        </div>
        {s.submitted_by_epf && s.submitted_by_epf !== s.epf_number && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">Filed by {s.submitted_by_name || s.submitted_by_epf}</div>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          <Building2 className="h-3 w-3 shrink-0" /> {s.company_name}
          {editor.editing ? (
            <>
              <span aria-hidden="true">·</span>
              <EditableCell editor={editor} rowKey={s.id} field="item" value={s.item ?? ''} className="max-w-[9rem]" />
              <span aria-hidden="true">@</span>
              <EditableCell editor={editor} rowKey={s.id} field="shop_name" value={s.shop_name ?? ''} className="max-w-[9rem]" />
            </>
          ) : (
            [editor.value(s.id, 'item', s.item ?? ''), editor.value(s.id, 'shop_name', s.shop_name ?? '')]
              .filter(Boolean).length
              ? <span>· {[editor.value(s.id, 'item', s.item ?? ''), editor.value(s.id, 'shop_name', s.shop_name ?? '')].filter(Boolean).join(' @ ')}</span>
              : null
          )}
        </div>
        {s.is_vat && (
          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] font-medium text-primary">
            VAT
            <EditableCell editor={editor} rowKey={s.id} field="vat_amount" value={s.vat_amount ?? 0} type="number" align="right"
              className={editor.editing ? 'max-w-[6rem]' : undefined}
              render={val => formatSuspenseAmount(numeric(val), 'LKR')} />
            {(editor.editing || s.vat_number) && (
              <>
                <span aria-hidden="true">·</span> Reg
                <EditableCell editor={editor} rowKey={s.id} field="vat_number" value={s.vat_number ?? ''}
                  className={editor.editing ? 'max-w-[8rem]' : undefined} />
              </>
            )}
          </div>
        )}
        {(s.splits?.length ?? 0) > 0 && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">Split: {s.splits!.map(sp => `${sp.employee_name} ${formatSuspenseAmount(sp.amount, 'LKR')}`).join(', ')}</div>
        )}
        <div className="mt-0.5 text-[11px] text-muted-foreground">{fmtWhen(s.created_at)}{s.considered_by_name ? ` · by ${s.considered_by_name}` : ''}</div>
      </div>
      <div className="w-28 shrink-0 text-right">
        <div className="text-sm font-bold tabular-nums text-foreground">
          <EditableCell editor={editor} rowKey={s.id} field="amount" value={s.amount} type="number" align="right"
            render={val => formatSuspenseAmount(numeric(val), 'LKR')} />
        </div>
        {(s.splits?.length ?? 0) > 0 && (
          <div className="text-[11px] text-muted-foreground">own {formatSuspenseAmount(s.amount - sumSplits(s.splits), 'LKR')}</div>
        )}
      </div>
    </div>
  );
}
