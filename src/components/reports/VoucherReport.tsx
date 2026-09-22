'use client';
import { useEffect, useMemo, useState } from 'react';
import { Receipt, Loader2, Building2, Users as UsersIcon, ChevronDown, Download, FileDown, CheckCircle2, FileText } from 'lucide-react';
import toast from 'react-hot-toast';
import type { Company, AppUser, SuspenseVoucher, SuspenseSubmission } from '@/lib/types';
import { useAuthStore } from '@/store/authStore';
import { getAllEmployees } from '@/services/userService';
import {
  listVouchers, markVouchersSettled, unmarkVouchersSettled, getSubmissionsByIds,
  formatSuspenseAmount, type Actor,
} from '@/services/suspenseService';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import Combobox from '@/components/Combobox';
import Select from '@/components/Select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { useReportEditor, ReportEditControls, EditableCell, numeric } from '@/components/reports/editableReport';
import { groupBillsByCategory } from '@/lib/voucherCategories';
import { useAuthedBillUrl } from '@/components/BillThumb';

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** One bill inside an expanded voucher. Extracted so the category grouping around it stays
 *  readable — the row itself is unchanged from when the list was flat. */
function VoucherBillRow({ bill: s, editor, onView, showEmployee }: {
  bill: SuspenseSubmission;
  editor: ReturnType<typeof useReportEditor>;
  onView: (s: SuspenseSubmission) => void;
  /** Prefix the employee's name — only worth it on a voucher that spans more than one person. */
  showEmployee: boolean;
}) {
  // Inputs cannot live inside a <button>, and click-to-view would fight with typing anyway —
  // while editing, the same row is a plain div.
  const Row = editor.editing ? 'div' : 'button';
  // Not <BillThumb>: that renders its own <button> and this row is already one. The hook is the
  // shared part — a bare src={bill_url} is a OneDrive proxy link with no session token on it,
  // which the route answers with 401 and the browser paints as a broken image.
  const thumbUrl = useAuthedBillUrl(s.bill_url ?? null);
  return (
    <Row type={editor.editing ? undefined : 'button'}
      onClick={editor.editing ? undefined : () => onView(s)}
      className="flex w-full items-center gap-3 rounded-lg border border-border/60 bg-card/40 p-2 text-left transition-colors hover:bg-accent/40">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
        {!s.bill_url ? <FileText className="h-4 w-4 text-muted-foreground" />
          : s.bill_type === 'pdf' ? <FileText className="h-5 w-5 text-muted-foreground" />
          : <img src={thumbUrl ?? undefined} alt="" loading="lazy" className="h-full w-full object-cover" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1 text-xs text-foreground">
          <EditableCell editor={editor} rowKey={s.id} field="shop_name" value={s.shop_name || '—'} className="truncate" />
          {(editor.editing || s.item) && (
            <>
              <span aria-hidden="true" className="shrink-0 text-muted-foreground">·</span>
              <EditableCell editor={editor} rowKey={s.id} field="item" value={s.item || ''} className="truncate" />
            </>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {showEmployee ? `${s.employee_name} · ` : ''}{s.company_name}
          {s.subcategory ? ` · ${s.subcategory}` : ''}
        </div>
      </div>
      <div className="w-24 shrink-0 text-xs font-semibold tabular-nums text-foreground">
        <EditableCell editor={editor} rowKey={s.id} field="amount" value={round2(s.amount)} type="number" align="right"
          render={val => formatSuspenseAmount(numeric(val), 'LKR')} />
      </div>
    </Row>
  );
}

function whenMs(ts: unknown): number | null {
  const v = ts as { toMillis?: () => number; seconds?: number } | null;
  if (v?.toMillis) return v.toMillis();
  if (v?.seconds != null) return v.seconds * 1000;
  return null;
}
function fmtWhen(ts: unknown): string {
  const ms = whenMs(ts);
  if (ms == null) return '—';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Vouchers: a rolling set of approved bills (any category/subcategory/company) — every approval
// joins whichever voucher is currently open, until it's marked settled, at which point it's
// closed and the next approval starts a new one (see addApprovedBillToVoucher in
// suspenseService.ts). Whether "open" is scoped per employee or shared across everyone is the
// System Settings voucher-mode toggle — either way settlement (reconciled in QuickBooks) is
// tracked HERE, not on individual submissions.
export default function VoucherReport({ companies, autoLoad = true }: { companies: Company[]; autoLoad?: boolean }) {
  const user = useAuthStore(s => s.user);
  const actor: Actor = { epf: user?.epf_number ?? '', name: user?.name ?? '' };

  const [vouchers, setVouchers]   = useState<SuspenseVoucher[] | null>(null);
  const [loading, setLoading]     = useState(false);
  const [employees, setEmployees] = useState<AppUser[]>([]);
  const [epf, setEpf]             = useState('');
  const [companyId, setCompanyId] = useState('');
  const [settleFilter, setSettleFilter] = useState<'unsettled' | 'settled' | 'all'>('unsettled');
  const [selected, setSelected]   = useState<Set<string>>(new Set());
  const [expanded, setExpanded]   = useState<Set<string>>(new Set());
  const [bills, setBills]         = useState<Record<string, SuspenseSubmission[]>>({});
  const [busy, setBusy]           = useState(false);
  const [exporting, setExporting] = useState(false);
  const [viewing, setViewing]     = useState<SuspenseSubmission | null>(null);
  // Same 401 as the row thumbnails: the modal's full-size image and PDF need the session token
  // on the URL too, or opening a bill from this tab shows an empty frame.
  const viewingUrl = useAuthedBillUrl(viewing?.bill_url ?? null);

  useEffect(() => { getAllEmployees().then(setEmployees).catch(() => setEmployees([])); }, []);

  const load = async () => {
    setLoading(true);
    try { setVouchers(await listVouchers()); setSelected(new Set()); }
    catch { toast.error('Failed to load vouchers.'); setVouchers([]); }
    finally { setLoading(false); }
  };
  // On some hosts (e.g. the Reports page) vouchers carry real financial totals, so they
  // shouldn't dump onto the screen the moment the tab opens — require an explicit "Load"
  // (works with or without employee/company picked, so "all employees" is one click away).
  useEffect(() => { if (autoLoad) load(); }, [autoLoad]);

  // employee_epfs/_names are backfilled from the single epf_number/employee_name for any voucher
  // created before multi-employee ("overall" mode) support existed.
  const epfsOf   = (v: SuspenseVoucher) => v.employee_epfs?.length ? v.employee_epfs : [v.epf_number];
  const namesOf  = (v: SuspenseVoucher) => v.employee_names?.length ? v.employee_names : [v.employee_name];

  const shown = useMemo(() => (vouchers ?? []).filter(v =>
    (!epf || epfsOf(v).includes(epf)) &&
    (!companyId || v.company_ids.includes(companyId)) &&
    (settleFilter === 'all' || (settleFilter === 'settled' ? v.settled : !v.settled))
  ), [vouchers, epf, companyId, settleFilter]);

  const empOptions  = employees.map(u => ({ value: u.epf_number, label: `${u.display_name} · ${u.epf_number}` }));
  const companyName = (id: string) => companies.find(c => c.id === id)?.name ?? id;

  const toggleExpand = async (v: SuspenseVoucher) => {
    setExpanded(prev => { const n = new Set(prev); if (n.has(v.id)) n.delete(v.id); else n.add(v.id); return n; });
    if (!bills[v.id]) {
      try { const subs = await getSubmissionsByIds(v.submission_ids); setBills(b => ({ ...b, [v.id]: subs })); }
      catch { toast.error('Failed to load this voucher’s bills.'); }
    }
  };

  const toggleSelect = (id: string) =>
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allShownSelected = shown.length > 0 && shown.every(v => selected.has(v.id));
  const toggleSelectAll  = () => setSelected(allShownSelected ? new Set() : new Set(shown.map(v => v.id)));

  const markSettled = async () => {
    if (!selected.size) return;
    setBusy(true);
    try { await markVouchersSettled([...selected], actor); toast.success(`${selected.size} voucher${selected.size > 1 ? 's' : ''} marked as settled.`); await load(); }
    catch (e) { toast.error(errMsg(e, 'Failed to mark as settled.')); }
    finally { setBusy(false); }
  };
  const unmarkSettled = async () => {
    if (!selected.size) return;
    setBusy(true);
    try { await unmarkVouchersSettled([...selected]); toast.success(`${selected.size} voucher${selected.size > 1 ? 's' : ''} unmarked.`); await load(); }
    catch (e) { toast.error(errMsg(e, 'Failed to unmark.')); }
    finally { setBusy(false); }
  };

  // Summary sheet (one row per voucher) + one sheet per voucher with every constituent bill
  // listed one by one, ending in a TOTAL row (amount + VAT) aligned under those columns.
  // Edit-before-download. Vouchers are keyed by their own id and bills by theirs, so a bill
  // corrected inside one voucher carries the same correction into the sheet built for it.
  const editor = useReportEditor();
  const v_ = <T extends string | number>(id: string, field: string, original: T): T => editor.value(id, field, original);

  const exportXlsx = async () => {
    if (!shown.length) return;
    setExporting(true);
    try {
      const { utils, writeFile } = await import('xlsx');

      // Reuse already-expanded vouchers' cached bills; fetch the rest, all in parallel.
      const billsByVoucher = await Promise.all(shown.map(async v => {
        if (bills[v.id]) return bills[v.id];
        try {
          const subs = await getSubmissionsByIds(v.submission_ids);
          setBills(b => ({ ...b, [v.id]: subs }));
          return subs;
        } catch { toast.error(`Failed to load bills for voucher ${v.voucher_no}.`); return null; }
      }));

      const wb = utils.book_new();

      const sumHeader = ['VOUCHER NO', 'CREATED', 'EMPLOYEES', 'EPFS', 'COMPANIES', 'BILLS', 'TOTAL', 'VAT TOTAL', 'SETTLED', 'SETTLED AT', 'SETTLED BY'];
      const sumRows = shown.map(v => [
        v.voucher_no, fmtWhen(v.created_at), namesOf(v).join(', '), epfsOf(v).join(', '),
        v.company_ids.map(companyName).join(', '), v.submission_ids.length,
        numeric(v_(v.id, 'total_amount', round2(v.total_amount))),
        numeric(v_(v.id, 'total_vat_amount', round2(v.total_vat_amount))),
        v.settled ? 'YES' : 'NO', v.settled ? fmtWhen(v.settled_at) : '', v.settled_by_name ?? '',
      ]);
      const sumWs = utils.aoa_to_sheet([sumHeader, ...sumRows]);
      sumWs['!cols'] = sumHeader.map((h, i) => ({ wch: Math.max(String(h).length, ...sumRows.map(r => String(r[i] ?? '').length)) + 2 }));
      utils.book_append_sheet(wb, sumWs, 'Summary');

      const usedSheetNames = new Set<string>(['Summary']);
      shown.forEach((v, i) => {
        const subs = billsByVoucher[i];
        if (!subs) return;   // failed to load — already toasted above

        const multiEmployee = namesOf(v).length > 1;
        const billHeader = [...(multiEmployee ? ['EMPLOYEE'] : []), 'BILL NO', 'BILL DATE', 'SHOP', 'ITEM', 'CATEGORY', 'SUB CATEGORY', 'COMPANY', 'AMOUNT', 'VAT'];
        const amountIdx = billHeader.indexOf('AMOUNT');
        const vatIdx = billHeader.indexOf('VAT');
        const billAmount = (s: typeof subs[number]) => numeric(v_(s.id, 'amount', round2(s.amount)));
        const billVat    = (s: typeof subs[number]) => (s.is_vat ? numeric(v_(s.id, 'vat_amount', round2(s.vat_amount ?? 0))) : 0);
        const billRows = subs.map(s => [
          ...(multiEmployee ? [s.employee_name] : []),
          s.bill_no ?? '', fmtWhen(s.bill_date ?? s.created_at),
          v_(s.id, 'shop_name', s.shop_name || '—'), v_(s.id, 'item', s.item || '—'),
          s.category || '—', s.subcategory || '—', s.company_name,
          billAmount(s), billVat(s),
        ]);
        // Totals are recomputed from the EDITED bill amounts — a sheet whose TOTAL row
        // contradicts the lines above it is worse than no total at all.
        const totalAmount = round2(subs.reduce((t, s) => t + billAmount(s), 0));
        const totalVat    = round2(subs.reduce((t, s) => t + billVat(s), 0));
        const totalRow = billHeader.map((_, idx) => idx === 0 ? 'TOTAL' : idx === amountIdx ? totalAmount : idx === vatIdx ? totalVat : '');
        const blankRow = billHeader.map(() => '');

        const aoa: (string | number)[][] = [
          [`Voucher ${v.voucher_no}`],
          [`${namesOf(v).join(', ')} · ${epfsOf(v).join(', ')}`],
          [`Companies: ${v.company_ids.map(companyName).join(', ')}`],
          [v.settled ? `Settled ${fmtWhen(v.settled_at)} by ${v.settled_by_name ?? ''}` : 'Unsettled'],
          blankRow,
          billHeader,
          ...billRows,
          blankRow,
          totalRow,
        ];
        const ws = utils.aoa_to_sheet(aoa);
        ws['!cols'] = billHeader.map((h, idx) => ({ wch: Math.max(String(h).length, ...billRows.map(r => String(r[idx] ?? '').length)) + 2 }));

        // Sheet names: max 31 chars, no : \ / ? * [ ] — voucher_no is already safe; de-dupe defensively.
        let name = v.voucher_no.slice(0, 31) || `Voucher ${i + 1}`;
        let n = 2;
        while (usedSheetNames.has(name)) name = `${v.voucher_no.slice(0, 28)}_${n++}`;
        usedSheetNames.add(name);
        utils.book_append_sheet(wb, ws, name);
      });

      writeFile(wb, `suspense_vouchers_${new Date().getFullYear()}_${new Date().getMonth() + 1}.xlsx`);
    } finally { setExporting(false); }
  };

  // A settled voucher's own printable record — voucher number, who/what, and every constituent
  // bill with its amount/VAT — for attaching to the QuickBooks entry or filing physically.
  const downloadVoucherPdf = async (v: SuspenseVoucher) => {
    let subs = bills[v.id];
    if (!subs) {
      try { subs = await getSubmissionsByIds(v.submission_ids); setBills(b => ({ ...b, [v.id]: subs! })); }
      catch { toast.error('Failed to load this voucher’s bills.'); return; }
    }
    const { default: JsPDF } = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');
    const doc = new JsPDF({ unit: 'pt', format: 'a4' });

    doc.setFontSize(16);
    doc.text(`Voucher ${v.voucher_no}`, 40, 40);
    doc.setFontSize(10);
    doc.setTextColor(90);
    doc.text(namesOf(v).map((n, i) => `${n} · ${epfsOf(v)[i] ?? ''}`).join(' | '), 40, 60);
    doc.text(`Companies: ${v.company_ids.map(companyName).join(', ')}`, 40, 74);
    doc.text(`Settled ${fmtWhen(v.settled_at)} by ${v.settled_by_name ?? '—'}`, 40, 88);
    doc.setFontSize(12);
    doc.setTextColor(0);
    doc.text(`Total: ${formatSuspenseAmount(v.total_amount, 'LKR')}${v.total_vat_amount > 0 ? `   ·   VAT total: ${formatSuspenseAmount(v.total_vat_amount, 'LKR')}` : ''}`, 40, 108);

    const multiEmployee = namesOf(v).length > 1;
    // Grouped by category with a subtotal on each heading row, the same way the expanded voucher
    // reads on screen — this is the sheet finance reconciles against expense heads, so "how much
    // on what" has to survive the export, not just the browser.
    const cols = multiEmployee ? 7 : 6;
    const HEAD_FILL: [number, number, number] = [236, 241, 246];
    const body: Parameters<typeof autoTable>[1]['body'] = [];
    for (const g of groupBillsByCategory(subs)) {
      const headCell = (content: string, halign: 'left' | 'right', colSpan = 1) => ({
        content, colSpan,
        styles: { fontStyle: 'bold' as const, fillColor: HEAD_FILL, halign },
      });
      body.push([
        headCell(`${g.category}  (${g.count} bill${g.count === 1 ? '' : 's'})`, 'left', cols - 2),
        headCell(formatSuspenseAmount(g.total, 'LKR'), 'right'),
        headCell(g.vat > 0 ? formatSuspenseAmount(g.vat, 'LKR') : '—', 'right'),
      ]);
      for (const s of g.bills) {
        body.push([
          ...(multiEmployee ? [s.employee_name] : []),
          fmtWhen(s.bill_date ?? s.created_at), s.shop_name || '—', s.item || '—', s.company_name,
          formatSuspenseAmount(s.amount, 'LKR'), s.is_vat ? formatSuspenseAmount(s.vat_amount ?? 0, 'LKR') : '—',
        ]);
      }
    }
    autoTable(doc, {
      head: [[...(multiEmployee ? ['EMPLOYEE'] : []), 'BILL DATE', 'SHOP', 'ITEM', 'COMPANY', 'AMOUNT', 'VAT']],
      body,
      startY: 126,
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [12, 142, 202] },
    });

    doc.save(`voucher_${v.voucher_no}.pdf`);
  };

  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-brand text-primary-foreground shadow-soft ring-1 ring-inset ring-[hsl(0_0%_100%/0.15)]">
          <Receipt className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Vouchers</h2>
          <p className="text-sm text-muted-foreground">Approved bills accumulate into one open voucher until you mark it settled — then the next approval starts a new one.</p>
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Find vouchers</Label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><UsersIcon className="h-3.5 w-3.5" /> Employee</Label>
            <Combobox value={epf} onChange={setEpf} allowCustom={false} placeholder="All employees" options={empOptions} />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><Building2 className="h-3.5 w-3.5" /> Company</Label>
            <Select searchable value={companyId || 'all'} onChange={v => setCompanyId(v === 'all' ? '' : v)}
              options={[{ value: 'all', label: 'All companies' }, ...companies.map(c => ({ value: c.id, label: c.name }))]} />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5" /> Settlement</Label>
            <Select value={settleFilter} onChange={v => setSettleFilter(v as typeof settleFilter)} options={[
              { value: 'unsettled', label: 'Unsettled' },
              { value: 'settled', label: 'Settled' },
              { value: 'all', label: 'Any' },
            ]} />
          </div>
        </div>
      </div>

      {!autoLoad && (
        <div className="mt-3">
          <Button onClick={load} disabled={loading} className="h-11">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Load vouchers'}
          </Button>
        </div>
      )}

      {vouchers === null && !loading ? (
        <p className="mt-5 text-center text-sm text-muted-foreground">Choose filters above (optional), then <span className="font-medium text-foreground">Load vouchers</span> — leave them as "All" to load every employee's vouchers.</p>
      ) : loading ? (
        <div className="mt-6 flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : shown.length === 0 ? (
        <div className="mt-4"><EmptyState icon={Receipt} title="No vouchers" description="No vouchers match these filters." /></div>
      ) : (
        <>
          <div className="mt-5 mb-2 flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox checked={allShownSelected} onCheckedChange={toggleSelectAll} /> Select all shown ({shown.length})
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {selected.size > 0 && settleFilter !== 'settled' && (
                <Button size="sm" disabled={busy} onClick={markSettled}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><CheckCircle2 className="h-4 w-4" /> Mark {selected.size} settled</>}
                </Button>
              )}
              {selected.size > 0 && settleFilter !== 'unsettled' && (
                <Button size="sm" variant="outline" disabled={busy} onClick={unmarkSettled}>Unmark {selected.size}</Button>
              )}
              <ReportEditControls editor={editor} />
              <Button size="sm" variant="outline" disabled={exporting} onClick={exportXlsx}>
                {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Export
              </Button>
            </div>
          </div>

          <div className="max-h-[34rem] space-y-2.5 overflow-y-auto pr-1 scrollbar-thin">
            {shown.map(v => {
              const open = expanded.has(v.id);
              return (
                <div key={v.id} className="overflow-hidden rounded-xl border border-border bg-card/60">
                  <div className="flex items-start gap-3 p-3">
                    <Checkbox className="mt-1" checked={selected.has(v.id)} onCheckedChange={() => toggleSelect(v.id)} aria-label="Select voucher" />
                    <button type="button" onClick={() => toggleExpand(v)} className="min-w-0 flex-1 text-left">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-semibold text-foreground">{v.voucher_no}</span>
                        <Badge variant={v.settled ? 'success' : 'warning'}>{v.settled ? 'Settled' : 'Unsettled'}</Badge>
                      </div>
                      <div className="mt-0.5 text-sm text-muted-foreground">{namesOf(v).join(', ')} · {v.submission_ids.length} bill{v.submission_ids.length > 1 ? 's' : ''}</div>
                      <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground"><Building2 className="h-3 w-3 shrink-0" /> {v.company_ids.map(companyName).join(', ')}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">Opened {fmtWhen(v.created_at)}{v.settled ? ` · Settled ${fmtWhen(v.settled_at)} by ${v.settled_by_name ?? ''}` : ''}</div>
                    </button>
                    <div className="w-28 shrink-0 text-right">
                      <div className="text-sm font-bold tabular-nums text-foreground">
                        <EditableCell editor={editor} rowKey={v.id} field="total_amount" value={round2(v.total_amount)} type="number" align="right"
                          render={val => formatSuspenseAmount(numeric(val), 'LKR')} />
                      </div>
                      {(v.total_vat_amount > 0 || editor.editing) && (
                        <div className="text-[11px] text-primary">
                          VAT <EditableCell editor={editor} rowKey={v.id} field="total_vat_amount" value={round2(v.total_vat_amount)} type="number" align="right"
                            render={val => formatSuspenseAmount(numeric(val), 'LKR')} />
                        </div>
                      )}
                      {v.settled && (
                        <button type="button" onClick={() => downloadVoucherPdf(v)} aria-label="Download voucher PDF" title="Download voucher PDF"
                          className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline">
                          <FileDown className="h-3 w-3" /> PDF
                        </button>
                      )}
                      <button type="button" onClick={() => toggleExpand(v)} aria-label="Expand voucher" className="block">
                        <ChevronDown className={`mt-1 h-4 w-4 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                      </button>
                    </div>
                  </div>
                  {open && (
                    <div className="space-y-2 border-t border-border/60 p-3">
                      {!bills[v.id] ? (
                        <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
                      ) : bills[v.id].length === 0 ? (
                        <p className="text-[11px] text-muted-foreground">No bills found for this voucher.</p>
                      ) : groupBillsByCategory(bills[v.id]).map(g => {
                        // The subtotal follows what is TYPED, not what is saved — the rows below
                        // stay bound to the original bills (EditableCell compares against the
                        // original to know whether a cell is still edited), so the group total is
                        // summed off the editor instead of off the grouped copies.
                        const groupTotal = round2(g.bills.reduce(
                          (t, s) => t + numeric(editor.value(s.id, 'amount', round2(s.amount))), 0));
                        return (
                        <div key={g.category} className="rounded-lg border border-border/60 bg-muted/20">
                          {/* Category heading. The name is the loud part and the money is right-
                              aligned under the bill amounts below it, so the column reads down. */}
                          <div className="flex items-center gap-3 border-b border-border/60 px-2.5 py-1.5">
                            <div className="min-w-0 flex-1">
                              <span className="truncate text-xs font-semibold text-foreground">{g.category}</span>
                              <span className="ml-2 text-[11px] text-muted-foreground">
                                {g.count} bill{g.count === 1 ? '' : 's'}
                                {g.vat > 0 && ` · VAT ${formatSuspenseAmount(g.vat, 'LKR')}`}
                              </span>
                            </div>
                            <div className="w-24 shrink-0 text-right text-xs font-bold tabular-nums text-foreground">
                              {formatSuspenseAmount(groupTotal, 'LKR')}
                            </div>
                          </div>
                          <div className="space-y-2 p-2">
                            {g.bills.map(s => (
                              <VoucherBillRow
                                key={s.id} bill={s} editor={editor} onView={setViewing}
                                showEmployee={namesOf(v).length > 1}
                              />
                            ))}
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Bill + details side by side — read-only (settlement is on the voucher, not the bill). */}
      <Dialog open={!!viewing} onOpenChange={o => { if (!o) setViewing(null); }}>
        <DialogContent className="max-w-3xl p-4 sm:p-6">
          <DialogHeader><DialogTitle>Bill{viewing?.bill_no ? ` · ${viewing.bill_no}` : ''}</DialogTitle></DialogHeader>
          {viewing && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex h-56 items-center justify-center overflow-hidden rounded-md border border-border bg-muted sm:h-72">
                {!viewing.bill_url ? <span className="text-xs text-muted-foreground">No bill attached</span>
                  : viewing.bill_type === 'pdf' ? <iframe src={viewingUrl ?? undefined} title="Bill" className="h-full w-full" />
                  : <img src={viewingUrl ?? undefined} alt="Bill" className="h-full w-full object-contain" />}
              </div>
              <div className="space-y-2 text-sm">
                <div><span className="text-muted-foreground">Category:</span> <span className="font-medium text-foreground">{viewing.category || '—'}</span></div>
                <div><span className="text-muted-foreground">Sub category:</span> <span className="font-medium text-foreground">{viewing.subcategory || '—'}</span></div>
                <div><span className="text-muted-foreground">Shop / vendor:</span> <span className="font-medium text-foreground">{viewing.shop_name || '—'}</span></div>
                <div><span className="text-muted-foreground">Item:</span> <span className="font-medium text-foreground">{viewing.item || '—'}</span></div>
                <div><span className="text-muted-foreground">Amount:</span> <span className="font-semibold text-foreground">{formatSuspenseAmount(viewing.amount, 'LKR')}</span></div>
                {viewing.is_vat && (
                  <div><span className="text-muted-foreground">VAT:</span> <span className="font-medium text-foreground">{formatSuspenseAmount(viewing.vat_amount ?? 0, 'LKR')}{viewing.vat_number ? ` · Reg ${viewing.vat_number}` : ''}</span></div>
                )}
                <div><span className="text-muted-foreground">Employee:</span> <span className="font-medium text-foreground">{viewing.employee_name} · {viewing.epf_number}</span></div>
                <div><span className="text-muted-foreground">Company:</span> <span className="font-medium text-foreground">{viewing.company_name}</span></div>
                <div><span className="text-muted-foreground">Bill date:</span> <span className="font-medium text-foreground">{fmtWhen(viewing.bill_date ?? viewing.created_at)}</span></div>
                <div><span className="text-muted-foreground">Submitted:</span> <span className="font-medium text-foreground">{fmtWhen(viewing.created_at)}</span></div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
