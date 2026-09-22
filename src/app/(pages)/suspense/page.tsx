'use client';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';
import {
  Wallet, Check, X, Loader2, Receipt, FileText, CalendarDays,
  TrendingUp, RefreshCw, Users as UsersIcon, Clock,
  Send, Search, ChevronDown,
  Camera, Upload, Lock, Landmark, Building2, Plus, UserPlus, ShieldCheck, Tags, HandCoins, ArrowUpDown,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Timestamp } from 'firebase/firestore';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities, useRoles } from '@/store/rolesStore';
import { roleCategory } from '@/lib/permissions';
import { billDateWarning } from '@/lib/billDatePlausibility';
import {
  BILL_DATE_LABEL, filterBillsByDate, sortBillsByDate,
  type BillDateField, type BillDateRange, type SortDir,
} from '@/lib/suspenseBillSort';
import { getCompanies } from '@/services/companyService';
import { useSuspenseAccess } from '@/store/suspenseStore';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge, badgeVariants } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import Combobox from '@/components/Combobox';
import ConfirmModal from '@/components/ConfirmModal';
import InlineError from '@/components/InlineError';
import Select from '@/components/Select';
import SearchableSelect from '@/components/SearchableSelect';
import BillThumb from '@/components/BillThumb';
import Pagination from '@/components/Pagination';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import type {
  SuspenseSubmission, SuspenseRequest, SuspenseAccount, SuspenseCloseRequest, SuspenseLedgerEntry, Company, AppUser, SuspenseSplit, SuspenseCategory,
} from '@/lib/types';
import {
  getMySubmissions, getMyRequests, getPendingSubmissions, getAllRequestsForApprovals, getPendingSupervisorRequests,
  getPendingCategoryRequests, requestIsReadyForApprover, requestStage,
  listSuspenseAccounts, createSubmission, updateSubmission, deleteSubmission,
  approveSubmission, rejectSubmission, createRequest, updateRequest, deleteRequest,
  approveRequest, rejectRequest, approveSupervisorStage, approveCategoryStage, addRequestSupervisor, formatSuspenseAmount, type Actor, deleteCompanyAccount,
  getMyCloseRequests, getPendingCloseRequests, createCloseRequest, approveCloseRequest, rejectCloseRequest, getLedger,
  createSuspenseAccount, closeAccountNow, reopenSuspenseAccount, adjustSuspenseAccount, listSuspenseCategories,
  previewVoucherForApproval, type VoucherPreview, verifyApprovalPin,
} from '@/services/suspenseService';
import { getAllEmployees, getAllUsers } from '@/services/userService';
import { listAllChamaries, type ChamaryWithPlace } from '@/services/workingPlaceService';
import { tenant } from '@/lib/firebase';
import { extractBillData, resizeImageForOcr } from '@/lib/ocr';
import { MAX_UPLOAD_BYTES, tooLargeMessage } from '@/services/cloudStorageService';
import { readBillWithAI } from '@/services/billReaderService';
import VoucherReport from '@/components/reports/VoucherReport';
import HolderOverview from '@/components/suspense/HolderOverview';
import ApproverLedger from '@/components/suspense/ApproverLedger';
import AccountsPanel from '@/components/suspense/AccountsPanel';
import SplitRecoveries from '@/components/suspense/SplitRecoveries';
import { errMsg, fmtDateTime, BillLink, useResolvedLimit, LimitHeadroomLine, LimitOverridePanel } from '@/components/suspense/shared';
import { checkAgainstLimit } from '@/lib/suspenseLimits';

type BillKind = 'handwritten' | 'printed' | '';

// Derived "expense_type" label kept on each submission so legacy display/search/report code
// (which reads expense_type) keeps working after the move to category → subcategory → type.
const expenseLabel = (category: string, subcategory: string, type: string) =>
  [category, subcategory, type].map(s => s.trim()).filter(Boolean).join(' · ');

// The chamary (if any) linked to this exact subcategory id — a submission resolving to that
// subcategory is stamped with the chamary's id, the FK the food-deduction calc sums against.
const chamaryForSubcategory = (chamaries: ChamaryWithPlace[], subcategoryId: string): ChamaryWithPlace | undefined =>
  chamaries.find(c => c.subcategory_id === subcategoryId);

// Validate the picked category/subcategory STRICTLY against the taxonomy — every level must be a
// current member (a renamed/deleted name, or a legacy free-text expense_type, must be re-picked;
// the Combobox renders unknown values as blank, so silent saves of dead names are blocked here).
// Type is NOT user-picked — a subcategory has at most one type, so it's resolved automatically
// from the subcategory here rather than validated against a separately-passed value. Returns the
// normalized triple + derived label (+ chamary_id when the resolved subcategory is one a chamary
// links to), or null after toasting.
function resolveCategory(categories: SuspenseCategory[], chamaries: ChamaryWithPlace[], category: string, subcategory: string):
  { category: string; subcategory: string; type: string; label: string; chamary_id?: string } | null {
  if (!category.trim()) { toast.error('Choose an expense category.'); return null; }
  const cat = categories.find(c => c.name === category.trim());
  if (!cat) { toast.error('Pick an expense category from the list — the previous one may have been renamed or removed.'); return null; }

  let subName = '', typeName = '', chamaryId: string | undefined;
  if (cat.subcategories.length > 0) {
    if (!subcategory.trim()) { toast.error('Choose a sub category.'); return null; }
    const sub = cat.subcategories.find(s => s.name === subcategory.trim());
    if (!sub) { toast.error('Pick a sub category from the list — the previous one may have been renamed or removed.'); return null; }
    subName = sub.name;
    chamaryId = chamaryForSubcategory(chamaries, sub.id)?.id;
    // Types live on the CATEGORY; the subcategory is assigned at most one of them.
    if (sub.type_id) typeName = (cat.types ?? []).find(t => t.id === sub.type_id)?.name ?? '';
  }
  return { category: cat.name, subcategory: subName, type: typeName, label: expenseLabel(cat.name, subName, typeName), chamary_id: chamaryId };
}

// Whether the (category, subcategory) pair currently allows splitting a bill across employees —
// an ordinary per-subcategory flag, same for a chamary-linked subcategory as any other.
const subAllowsSplit = (categories: SuspenseCategory[], category: string, subcategory: string): boolean => {
  const cat = categories.find(c => c.name === category);
  return !!cat?.subcategories.find(s => s.name === subcategory)?.allow_split;
};

// Fuel is never a VAT bill by default — a fuel category's vat_default is deliberately ignored,
// so picking one leaves VAT off however that category is configured. Only the bill read (a
// genuine VAT fuel invoice) or the user's own tick turns VAT on for one.
const isFuelCategory = (category: string): boolean => category.toLowerCase().includes('fuel');

// The taxonomy a user last submitted, remembered so the next bill opens already on it. Kept in
// localStorage, NOT Firestore: it's a per-device convenience and at 300+ users it isn't worth a
// read on every form open. Keyed by the SIGNED-IN epf so a shared device never preselects one
// person's category for another.
type LastExpensePick = { category: string; subcategory: string; type: string };

const lastPickKey = (epf: string) => `suspense_last_expense_${epf}`;

function readLastPick(epf: string): LastExpensePick | null {
  if (!epf) return null;
  try {
    const p = JSON.parse(localStorage.getItem(lastPickKey(epf)) ?? 'null') as Partial<LastExpensePick> | null;
    if (typeof p?.category !== 'string' || !p.category) return null;
    return {
      category:    p.category,
      subcategory: typeof p.subcategory === 'string' ? p.subcategory : '',
      type:        typeof p.type === 'string' ? p.type : '',
    };
  } catch { return null; }   // private windows / embedded browsers throw on access
}
function writeLastPick(epf: string, pick: LastExpensePick) {
  if (!epf) return;
  try { localStorage.setItem(lastPickKey(epf), JSON.stringify(pick)); } catch { /* ignore */ }
}

// How much of a remembered pick still exists in the CURRENT taxonomy — the stored names are
// re-resolved against the live tree rather than trusted, since a category or subcategory may have
// been renamed, deleted or moved under another parent since (and the device may last have been
// used on a different tenant entirely). Degrades a level at a time: a subcategory that no longer
// resolves still preselects its category, a category that doesn't preselects nothing. Type is
// never restored as a value (it's derived from the subcategory) — it's compared only because a
// stored type that no longer matches means the subcategory was re-typed underneath us.
function resolveLastPick(categories: SuspenseCategory[], pick: LastExpensePick): LastExpensePick | null {
  const cat = categories.find(c => c.name === pick.category);
  if (!cat) return null;
  const sub = pick.subcategory ? cat.subcategories.find(s => s.name === pick.subcategory) : undefined;
  if (!sub) return { category: cat.name, subcategory: '', type: '' };
  const type = sub.type_id ? ((cat.types ?? []).find(t => t.id === sub.type_id)?.name ?? '') : '';
  return type === pick.type ? { category: cat.name, subcategory: sub.name, type } : { category: cat.name, subcategory: '', type: '' };
}

// Status, approver-line, bill-thumb and split helpers live in shared.tsx so the extracted
// views (holder overview, ledger, accounts) and this page never drift on how they look.
// They are imported at the top of the file.

// One editable split row (amount kept as a string while typing).
type SplitDraft = { epf_number: string; employee_name: string; amount: string };

// Round to 2dp exactly like the service's money() so the client-side ceiling check and the
// authoritative server check never disagree (e.g. rows of 25.005 rounding up past the bill).
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Bill date ↔ <input type="date"> string (local calendar day, not UTC — a date typed/read off a
// bill has no time-of-day component, so treating it as local avoids an off-by-one near midnight).
const todayDateStr = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const timestampToDateStr = (ts: Timestamp | null | undefined): string => {
  if (!ts?.toDate) return '';
  const d = ts.toDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dateStrToTimestamp = (s: string): Timestamp | null => {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return Timestamp.fromDate(new Date(+y, +mo - 1, +d));
};

// Validate split rows and convert to SuspenseSplit[]; toasts + returns null when invalid.
function resolveSplits(rows: SplitDraft[], billAmount: number): SuspenseSplit[] | null {
  const partial = rows.some(r => (r.epf_number && !((parseFloat(r.amount) || 0) > 0)) || (!r.epf_number && (parseFloat(r.amount) || 0) > 0));
  if (partial) { toast.error('Complete or remove the split rows — pick an employee and a positive amount.'); return null; }
  const valid = rows.filter(r => r.epf_number && (parseFloat(r.amount) || 0) > 0);
  const seen = new Set<string>();
  for (const r of valid) {
    if (seen.has(r.epf_number)) { toast.error('The same employee is added twice in the split.'); return null; }
    seen.add(r.epf_number);
  }
  const total = valid.reduce((t, r) => t + round2(parseFloat(r.amount)), 0);
  if (round2(total) > round2(billAmount) + 1e-9) { toast.error('The amount split to other employees cannot exceed the bill amount.'); return null; }
  return valid.map(r => ({ epf_number: r.epf_number, employee_name: r.employee_name, amount: round2(parseFloat(r.amount)) }));
}

// Split a bill across other employees — each amount is deducted from that employee's salary
// (shown in the monthly report) and netted off the submitter's own float debit.
function SplitEditor({ rows, setRows, billAmount, excludeEpf, currency }: {
  rows: SplitDraft[]; setRows: (r: SplitDraft[]) => void;
  billAmount: number; excludeEpf: string; currency: string;
}) {
  const [users, setUsers] = useState<AppUser[]>([]);
  useEffect(() => { getAllEmployees().then(setUsers).catch(() => {}); }, []);

  const total   = rows.reduce((t, r) => t + (parseFloat(r.amount) || 0), 0);
  const share   = billAmount - total;
  const base    = users.filter(u => u.epf_number !== excludeEpf).map(u => ({ value: u.epf_number, label: `${u.display_name} · ${u.epf_number}` }));
  // Keep already-tagged employees selectable even if they're no longer in the active-users list
  // (e.g. deactivated since the bill was submitted) — otherwise the field would render blank.
  const known   = new Set(base.map(o => o.value));
  const extra   = new Map<string, { value: string; label: string }>();
  for (const r of rows) if (r.epf_number && !known.has(r.epf_number)) extra.set(r.epf_number, { value: r.epf_number, label: `${r.employee_name || r.epf_number} · ${r.epf_number}` });
  const options = [...base, ...extra.values()];

  const setRow = (i: number, patch: Partial<SplitDraft>) => setRows(rows.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const pick   = (i: number, epf: string) => setRow(i, { epf_number: epf, employee_name: users.find(u => u.epf_number === epf)?.display_name ?? '' });
  const add    = () => setRows([...rows, { epf_number: '', employee_name: '', amount: '' }]);
  const remove = (i: number) => setRows(rows.filter((_, idx) => idx !== i));

  return (
    <div>
      <Label className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
        <UsersIcon className="h-3.5 w-3.5" /> Split with employees <span className="font-normal lowercase text-muted-foreground/70">(optional)</span>
      </Label>
      <p className="mb-2 text-[11px] text-muted-foreground">Charge part of this bill to other employees — deducted from their salary (shown in the monthly report) and taken off your own float.</p>

      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <Combobox value={r.epf_number} onChange={(v) => pick(i, v)} allowCustom={false} placeholder="Employee" options={options} />
              </div>
              <Input type="number" inputMode="decimal" min="0" step="0.01" className="w-28 shrink-0" value={r.amount}
                onChange={e => setRow(i, { amount: e.target.value })} placeholder="Amount" />
              <button type="button" onClick={() => remove(i)} aria-label="Remove employee"
                className="mt-2 rounded p-1 text-muted-foreground transition-colors hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
      )}

      <Button type="button" size="sm" variant="outline" className="mt-2" onClick={add}><Plus className="h-3.5 w-3.5" /> Add employee</Button>

      {rows.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          <span className="text-muted-foreground">Employees: <span className="font-semibold tabular-nums text-foreground">{formatSuspenseAmount(total, currency)}</span></span>
          <span className="text-muted-foreground">Your share: <span className={`font-semibold tabular-nums ${share < 0 ? 'text-destructive' : 'text-foreground'}`}>{formatSuspenseAmount(share, currency)}</span></span>
        </div>
      )}
      {share < 0 && <p className="mt-1 text-[11px] text-destructive">The split total exceeds the bill amount.</p>}
    </div>
  );
}

// Shared expense fields — used by the inline create form and the edit dialog so they never drift.
function ExpenseFields({
  category, setCategory, subcategory, setSubcategory, categories, chamaries, lastUsedCategory,
  isVat, setIsVat, vatNumber, setVatNumber, vatAmount, setVatAmount,
  shop, setShop, item, setItem, amount, setAmount, billDate, setBillDate, note, setNote,
  billKind, setBillKind, bill, onBill, fileRef, existingBill,
  companyId, setCompanyId, companies, multiCompany,
  splits, setSplits, submitterEpf,
}: {
  category: string; setCategory: (v: string) => void;
  subcategory: string; setSubcategory: (v: string) => void;
  categories: SuspenseCategory[]; chamaries: ChamaryWithPlace[];
  // Set only by the create form, and only when it preselected that category from the last
  // submission — marks the field so the prefilled value isn't mysterious. The edit form never
  // passes it: an existing submission always shows its own category.
  lastUsedCategory?: string;
  isVat: boolean; setIsVat: (v: boolean) => void;
  vatNumber: string; setVatNumber: (v: string) => void;
  vatAmount: string; setVatAmount: (v: string) => void;
  shop: string; setShop: (v: string) => void;
  item: string; setItem: (v: string) => void;
  amount: string; setAmount: (v: string) => void;
  billDate: string; setBillDate: (v: string) => void;
  note: string; setNote: (v: string) => void;
  billKind: BillKind; setBillKind: (v: BillKind) => void;
  bill: File | null; onBill: (f: File | null) => void;
  fileRef?: React.RefObject<HTMLInputElement | null>;
  existingBill?: boolean;
  companyId: string; setCompanyId: (v: string) => void;
  companies: Company[]; multiCompany: boolean;
  splits: SplitDraft[]; setSplits: (r: SplitDraft[]) => void; submitterEpf: string;
}) {
  const [scanning, setScanning] = useState(false);
  // For a printed bill the Amount field stays hidden until the scan finishes (or a PDF /
  // manual case makes it ready). Handwritten bills show it immediately; editing an existing
  // submission starts ready so the current amount is visible.
  const [amountReady, setAmountReady] = useState<boolean>(!!existingBill);

  // Live preview of the just-selected bill image (object URL, cleaned up on change).
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (bill && bill.type.startsWith('image/')) {
      const u = URL.createObjectURL(bill);
      setPreviewUrl(u);
      return () => URL.revokeObjectURL(u);
    }
    setPreviewUrl(null);
  }, [bill]);

  // Reads the bill with Gemini vision (server-side, GOOGLE_API_KEY) — far more reliable than
  // plain OCR for vendor/item names and for recognising a VAT/Tax invoice as such (it reads the
  // invoice semantically rather than regex-guessing at raw recognized text). Falls back to the
  // old client-side tesseract OCR if the Google API call fails for any reason — network, quota,
  // misconfigured key — extracting the SAME fields (amount/shop/item/VAT/bill date) via regex
  // heuristics instead, so an outage doesn't silently drop VAT or date detection along with it.
  const runOcr = async (f: File) => {
    setScanning(true);
    // Downscale/compress just for the read — cuts upload + Gemini/tesseract processing time on
    // typical multi-MB phone photos; the ORIGINAL file (f) is still what gets uploaded as the
    // actual bill attachment below, untouched.
    const analysisFile = await resizeImageForOcr(f).catch(() => f);
    try {
      const data = await readBillWithAI(analysisFile, billKind);
      if (data.amount != null) setAmount(String(data.amount));
      if (data.shop_name && !shop.trim()) setShop(data.shop_name);   // only fill empty text fields
      if (data.item && !item.trim()) setItem(data.item);
      if (data.is_vat) {
        setIsVat(true); setVatDecided(true);
        if (data.vat_number && !vatNumber.trim()) setVatNumber(data.vat_number);
        if (data.vat_amount != null) { setVatAmount(String(data.vat_amount)); setVatAuto(false); }
      }
      // Only overwrite the date if the user hasn't touched it — it already defaults to today.
      if (data.bill_date && billDateAuto) setBillDate(data.bill_date);
      if (data.amount == null && !data.shop_name && !data.item) toast('Couldn’t read the bill — enter the details manually.', { icon: '✏️' });
      else if (data.amount == null) toast('Couldn’t read the amount — enter it manually.', { icon: '✏️' });
    } catch {
      try {
        const fallback = await extractBillData(analysisFile);
        if (fallback.amount != null) setAmount(String(fallback.amount));
        if (fallback.vendor && !shop.trim()) setShop(fallback.vendor);
        if (fallback.item && !item.trim()) setItem(fallback.item);
        if (fallback.is_vat) {
          setIsVat(true); setVatDecided(true);
          if (fallback.vat_number && !vatNumber.trim()) setVatNumber(fallback.vat_number);
          if (fallback.vat_amount != null) { setVatAmount(String(fallback.vat_amount)); setVatAuto(false); }
        }
        if (fallback.bill_date && billDateAuto) setBillDate(fallback.bill_date);
        if (fallback.amount == null && !fallback.vendor && !fallback.item) toast('Couldn’t read the bill — enter the details manually.', { icon: '✏️' });
        else if (fallback.amount == null) toast('Couldn’t read the amount — enter it manually.', { icon: '✏️' });
      } catch { toast('Couldn’t scan the bill — enter the details manually.', { icon: '✏️' }); }
    } finally { setScanning(false); setAmountReady(true); }
  };
  // Amount-field state for the chosen bill file — an image is read automatically regardless of
  // bill type (Gemini vision reads a handwritten bill's photo just as well as a printed one; it's
  // not plain-text OCR that needs a clean typeface). A PDF or no file falls back to manual entry.
  const readBillFile = (f: File | null) => {
    if (f && f.type.startsWith('image/')) { setAmountReady(false); void runOcr(f); }
    else { setAmountReady(!!f); }   // PDF → manual field; no file → hide until uploaded
  };
  const handleFile = (f: File | null) => {
    // An image is downscaled on upload so it always fits; a PDF can't be, so refuse an oversized
    // one HERE — the moment it's picked — rather than after the form is filled in and scanned.
    if (f && !f.type.startsWith('image/') && f.size > MAX_UPLOAD_BYTES) { toast.error(tooLargeMessage(f)); return; }
    onBill(f);
    readBillFile(f);
  };
  const chooseKind = (k: 'handwritten' | 'printed') => setBillKind(k);
  // Removing the attached file also clears the bill-derived fields (shop / item / amount).
  const removeBill = () => {
    onBill(null);
    setShop(''); setItem(''); setAmount('');
    setAmountReady(false);
  };

  const showAmount = amountReady && !scanning;

  // Category → subcategory → type taxonomy — an ordinary tree, no chamary special-casing. A
  // subcategory MAY be linked to a chamary (Working Places); that only matters at submit time
  // (resolveCategory stamps chamary_id when the resolved subcategory has one), not for how this
  // form renders — the picker looks the same either way.
  const selectedCat = categories.find(c => c.name === category) ?? null;
  const subOptions  = selectedCat?.subcategories ?? [];
  const selectedSub = subOptions.find(s => s.name === subcategory) ?? null;
  // A subcategory has at most ONE type — resolved automatically, never user-picked.
  const subType     = selectedSub?.type_id ? (selectedCat?.types ?? []).find(t => t.id === selectedSub.type_id) ?? null : null;
  const allowSplit  = !!selectedSub?.allow_split;
  const vatRate     = selectedCat?.vat_rate ?? 0;

  // Picking a category resets the deeper levels. It no longer applies the category's vat_default:
  // a new bill starts with VAT off and only the bill read (is_vat) or the user's own tick turns it
  // on, so a later category change must never overwrite that answer. Fuel is forced off while the
  // answer is still open, so a fuel bill stays non-VAT even if a default is ever re-applied here.
  // Same-value guard: re-clicking the current selection must NOT reset anything (it used to
  // clear the subcategory, silently unmount the split editor, and wipe loaded splits).
  const pickCategory = (v: string) => {
    if (v === category) return;
    setCategory(v); setSubcategory('');
    if (!vatDecided && isFuelCategory(v)) setIsVat(false);
  };
  const pickSubcategory = (v: string) => {
    if (v === subcategory) return;
    setSubcategory(v);
  };
  // Whether billDate is still the system-picked value (today, or an OCR-read date) rather than
  // something the user typed themselves — mirrors vatAuto below. Editing an existing submission
  // starts false so a re-scan can't silently overwrite its already-confirmed date.
  const [billDateAuto, setBillDateAuto] = useState(!existingBill);

  // VAT amount suggestion — the VAT portion of the (VAT-inclusive) bill total at the category
  // rate. Stays auto-synced with the amount (which OCR may fill later) and the category rate
  // until the user types their own figure; editing an existing submission keeps its stored value.
  const [vatAuto, setVatAuto] = useState(!existingBill);
  // Whether VAT has been settled for THIS bill — by the read recognising a VAT invoice, or by the
  // user ticking/unticking it — after which no category pick may touch it. Editing an existing
  // submission starts settled: it shows that submission's stored is_vat.
  const [vatDecided, setVatDecided] = useState(!!existingBill);
  useEffect(() => {
    if (!isVat || !vatAuto) return;
    const amt = parseFloat(amount) || 0;
    setVatAmount(amt > 0 && vatRate > 0 ? (Math.round((amt * vatRate / (100 + vatRate)) * 100) / 100).toFixed(2) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, vatRate, isVat]);
  const toggleVat = (on: boolean) => {
    setIsVat(on); setVatDecided(true);
    if (on) setVatAuto(true);        // the effect above computes/refreshes the suggestion
    else setVatAmount('');
  };

  return (
    <div className="space-y-3">
      {multiCompany && (
        <div>
          <Label className="text-xs font-semibold text-muted-foreground mb-1.5 block flex items-center gap-1"><Building2 className="h-3.5 w-3.5" /> Company <span className="text-destructive">*</span></Label>
          <Combobox value={companyId} onChange={setCompanyId} allowCustom={false} placeholder="Select company"
            options={companies.map(c => ({ value: c.id, label: c.name }))} />
          <p className="mt-1 text-[11px] text-muted-foreground">Which company is this expense for? Defaults to your own company.</p>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label className="text-xs font-semibold text-muted-foreground mb-1.5 block">Expense category <span className="text-destructive">*</span></Label>
          <Combobox value={category} onChange={pickCategory} allowCustom={false}
            placeholder={categories.length ? 'Select category' : 'No categories — add them in Settings'}
            options={categories.map(c => ({ value: c.name, label: c.name }))} />
          {!!lastUsedCategory && category === lastUsedCategory && (
            <p className="mt-1 text-[11px] text-muted-foreground">Last used</p>
          )}
        </div>
        <div>
          <Label className="text-xs font-semibold text-muted-foreground mb-1.5 block">
            Sub category {subOptions.length > 0 && <span className="text-destructive">*</span>}
          </Label>
          <Combobox value={subcategory} onChange={pickSubcategory} allowCustom={false}
            placeholder={!selectedCat ? 'Pick a category first' : subOptions.length ? 'Select sub category' : 'No sub categories'}
            disabled={!selectedCat || subOptions.length === 0}
            options={subOptions.map(s => ({ value: s.name, label: s.name }))} />
          {(() => {
            const ch = selectedSub ? chamaryForSubcategory(chamaries, selectedSub.id) : undefined;
            return ch && <p className="mt-1 text-[11px] text-muted-foreground">chamary at {ch.working_place_name}</p>;
          })()}
          {subType && <p className="mt-1 text-[11px] text-muted-foreground">Type: <span className="font-medium text-foreground">{subType.name}</span></p>}
        </div>
      </div>

      {/* The bill, straight after the categories — it is the thing this form is about, and the
          scan below fills in shop / item / amount / VAT, so it belongs BEFORE the fields it
          overwrites rather than under them. One dashed surface holds the whole step. */}
      <div>
        <Label className="text-xs font-semibold text-muted-foreground mb-1.5 block">Bill (image or PDF) <span className="text-destructive">*</span></Label>
        <div className="rounded-xl border border-dashed border-border bg-muted/20 p-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-4 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground">
              <Camera className="h-5 w-5" /> Take photo
              <input type="file" accept="image/*" capture="environment" className="hidden"
                onChange={e => { const f = e.target.files?.[0] ?? null; e.target.value = ''; handleFile(f); }} />
            </label>
            <label className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-4 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground">
              <Upload className="h-5 w-5" /> Upload file
              <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden"
                onChange={e => { const f = e.target.files?.[0] ?? null; e.target.value = ''; handleFile(f); }} />
            </label>
          </div>

          {bill && (
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-card p-1.5">
              {previewUrl
                ? <img src={previewUrl} alt="" className="h-10 w-10 rounded object-cover" />
                : <span className="flex h-10 w-10 items-center justify-center rounded bg-muted text-muted-foreground"><FileText className="h-4 w-4" /></span>}
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">{bill.name}</span>
              <button type="button" onClick={removeBill} aria-label="Remove bill"
                className="rounded p-1 text-muted-foreground transition-colors hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
            </div>
          )}

          {existingBill && !bill && <p className="mt-2 text-[11px] text-muted-foreground">A bill is already attached — take or choose a file only to replace it.</p>}

          {/* Bill type is a property OF the bill, so it sits with it instead of standing in the
              way of it. It only changes how the amount is captured — hence the quiet treatment
              rather than two full-width buttons above the upload. */}
          <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2.5">
            <span className="text-[11px] font-medium text-muted-foreground">Written by hand or printed? <span className="text-destructive">*</span></span>
            <div className="flex gap-1.5">
              {(['handwritten', 'printed'] as const).map((k) => (
                <button key={k} type="button" onClick={() => chooseKind(k)}
                  aria-pressed={billKind === k}
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium capitalize transition-colors ${
                    billKind === k ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground hover:bg-accent'
                  }`}>
                  {k}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">A bill image — handwritten or printed — is read automatically to fill in the shop, item, amount, and VAT details. PDFs aren’t read — enter details manually.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label className="text-xs font-semibold text-muted-foreground mb-1.5 block">Shop / vendor</Label>
          <Input value={shop} onChange={e => setShop(e.target.value)} placeholder="e.g. Keells Super" />
        </div>
        <div>
          <Label className="text-xs font-semibold text-muted-foreground mb-1.5 block">Item</Label>
          <Textarea value={item} onChange={e => setItem(e.target.value)}
            placeholder={'e.g. Printer cartridge - 2 - 500.00'} rows={3} className="min-h-0 resize-y" />
          <p className="mt-1 text-[11px] text-muted-foreground">One item per line: item name - qty - unit price.</p>
        </div>
      </div>

      {/* Amount — hidden while the bill is being scanned; shown (pre-filled, editable) after */}
      {scanning ? (
        <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5 text-sm font-medium text-primary">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading the bill…
        </div>
      ) : showAmount ? (
        <div>
          <Label className="text-xs font-semibold text-muted-foreground mb-1.5 block">Amount <span className="text-destructive">*</span></Label>
          <Input type="number" inputMode="decimal" min="0" step="0.01" value={amount}
            onChange={e => setAmount(e.target.value)} placeholder="0.00" />
          <p className="mt-1 text-[11px] text-muted-foreground">Auto-extracted from the bill — check and edit if needed.</p>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">Upload the bill above to read the amount.</p>
      )}

      {/* Bill date — the date printed ON the bill if one was read; defaults to today otherwise */}
      <div>
        <Label className="text-xs font-semibold text-muted-foreground mb-1.5 block">Bill date <span className="text-destructive">*</span></Label>
        <Input type="date" value={billDate} onChange={e => { setBillDate(e.target.value); setBillDateAuto(false); }} />
        <p className="mt-1 text-[11px] text-muted-foreground">
          {billDateAuto ? 'Read from the bill when possible — otherwise today. Edit if it’s wrong.' : 'Set manually — edit if it’s wrong.'}
        </p>
      </div>

      {/* VAT — a checkbox (off until the bill read or the user ticks it); when ticked, capture the reg no + VAT amount */}
      <div className="rounded-md border border-border bg-muted/20 p-2.5">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground">
          <Checkbox checked={isVat} onCheckedChange={(v) => toggleVat(v === true)} />
          VAT bill
          {vatRate > 0 && <span className="text-[11px] font-normal text-muted-foreground">(default {vatRate}%)</span>}
        </label>
        {isVat && (
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">VAT registration no.</Label>
              <Input value={vatNumber} onChange={e => setVatNumber(e.target.value)} placeholder="e.g. 114123456-7000" />
            </div>
            <div>
              <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">VAT amount <span className="text-destructive">*</span></Label>
              <Input type="number" inputMode="decimal" min="0" step="0.01" value={vatAmount}
                onChange={e => { setVatAmount(e.target.value); setVatAuto(false); }} placeholder="0.00" />
            </div>
          </div>
        )}
      </div>

      {allowSplit && showAmount && (parseFloat(amount) || 0) > 0 && (
        <SplitEditor rows={splits} setRows={setSplits} billAmount={parseFloat(amount) || 0} excludeEpf={submitterEpf} currency="LKR" />
      )}
      {/* Splits exist but the current selection doesn't allow them — surface it, never wipe silently. */}
      {!allowSplit && splits.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
          <span className="text-xs text-warning">
            This {selectedSub ? 'sub category' : 'selection'} doesn’t allow splitting — {splits.length} split row{splits.length > 1 ? 's' : ''} kept from before. Remove them or pick a subcategory that allows splitting.
          </span>
          <Button type="button" size="sm" variant="outline" onClick={() => setSplits([])}>Remove splits</Button>
        </div>
      )}

      <div>
        <Label className="text-xs font-semibold text-muted-foreground mb-1.5 block">Note</Label>
        <Textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="Optional details" />
      </div>
    </div>
  );
}

// ─── Inline "submit an expense" form (always visible on the holder view) ────────
function NewExpenseForm({ ctx, companies, multiCompany, categories, chamaries, disabled, onSaved }: {
  ctx: { epf: string; name: string; companyId: string; companyName: string };
  companies: Company[]; multiCompany: boolean; categories: SuspenseCategory[]; chamaries: ChamaryWithPlace[];
  disabled?: boolean;
  onSaved: () => void;
}) {
  const [category, setCategory]       = useState('');
  const [subcategory, setSubcategory] = useState('');
  const [isVat, setIsVat]             = useState(false);
  const [vatNumber, setVatNumber]     = useState('');
  const [vatAmount, setVatAmount]     = useState('');
  const [shop, setShop]     = useState('');
  const [item, setItem]     = useState('');
  const [amount, setAmount] = useState('');
  const [billDate, setBillDate] = useState(todayDateStr());
  const [note, setNote]     = useState('');
  const [bill, setBill]     = useState<File | null>(null);
  const [billKind, setBillKind] = useState<BillKind>('');
  const [companyId, setCompanyId] = useState(ctx.companyId);
  const [splits, setSplits] = useState<SplitDraft[]>([]);
  const [busy, setBusy]     = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // The remembered taxonomy currently sitting in the pickers, if it was this form that put it
  // there — drives the "Last used" hint, which the user's own pick then replaces.
  const [lastUsed, setLastUsed] = useState<LastExpensePick | null>(null);

  // Who this bill BELONGS to (whose float it debits on approval) — defaults to yourself, but can
  // be reassigned to file a bill on a colleague's behalf. `ctx` (the logged-in actor) is always
  // recorded separately as submitted_by, so the approver and the belonger can both see who
  // actually filed it. Only employees who already hold a suspense (float) account are offered —
  // most roles never get one, so the full employee directory is mostly noise here — except
  // yourself, who's always selectable even with no account yet (unchanged from before this
  // picker existed: createSubmission already allows it, auto-creating the account on approval).
  const [belongsToEpf, setBelongsToEpf]   = useState(ctx.epf);
  const [belongsToName, setBelongsToName] = useState(ctx.name);
  const [employees, setEmployees] = useState<AppUser[]>([]);
  const [accountEpfs, setAccountEpfs] = useState<Set<string>>(new Set());
  useEffect(() => { getAllEmployees().then(setEmployees).catch(() => {}); }, []);
  useEffect(() => { listSuspenseAccounts().then(accs => setAccountEpfs(new Set(accs.map(a => a.epf_number)))).catch(() => {}); }, []);
  const belongsToChoices = employees.filter(u => u.epf_number === ctx.epf || accountEpfs.has(u.epf_number));
  const belongsToOptions = belongsToChoices.map(u => ({ value: u.epf_number, label: u.epf_number === ctx.epf ? `${u.display_name} · ${u.epf_number} (you)` : `${u.display_name} · ${u.epf_number}` }));
  const pickBelongsTo = (epf: string) => {
    setBelongsToEpf(epf);
    setBelongsToName(epf === ctx.epf ? ctx.name : (employees.find(u => u.epf_number === epf)?.display_name ?? ''));
  };

  // Preselect the taxonomy this user last submitted. Fires once, on the first render where the
  // categories have arrived AND the pickers are still empty — anything already in them is the
  // user's own choice, so we stand down for good rather than overwrite it mid-edit.
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || !ctx.epf || categories.length === 0) return;
    if (category.trim() || subcategory.trim()) { preselected.current = true; return; }
    preselected.current = true;
    const stored = readLastPick(ctx.epf);
    const pick   = stored && resolveLastPick(categories, stored);
    if (!pick) return;
    setCategory(pick.category); setSubcategory(pick.subcategory);
    setLastUsed(pick);
  }, [categories, ctx.epf, category, subcategory]);

  // `keep` carries the just-submitted taxonomy back into the cleared form — the same preselect a
  // reload would apply, so a batch of bills from one trip isn't re-picked every time.
  const reset = (keep?: LastExpensePick) => {
    setCategory(keep?.category ?? ''); setSubcategory(keep?.subcategory ?? '');
    setIsVat(false);   // every new bill starts non-VAT — the bill read turns it on when it sees one
    setVatNumber(''); setVatAmount('');
    setShop(''); setItem(''); setAmount(''); setBillDate(todayDateStr()); setNote(''); setBill(null); setBillKind('');
    setCompanyId(ctx.companyId); setSplits([]);
    setBelongsToEpf(ctx.epf); setBelongsToName(ctx.name);
    if (fileRef.current) fileRef.current.value = '';
  };

  // Live check of the primitive required fields — mirrors the first guards in submit()
  // (the cross-field rules like VAT ≤ amount / split ≤ bill stay as submit-time toasts).
  // Drives the disabled Submit button and a short "what's still missing" inline hint.
  const parsedAmt = parseFloat(amount);
  const missingBits: string[] = [];
  if (multiCompany && !companyId) missingBits.push('company');
  if (!category.trim()) missingBits.push('expense category');
  if (!billKind) missingBits.push('bill type');
  if (!bill) missingBits.push('bill attachment');
  if (amount.trim() === '' || isNaN(parsedAmt) || parsedAmt <= 0) missingBits.push('a valid amount');
  if (!billDate) missingBits.push('bill date');
  if (!belongsToEpf) missingBits.push('who the bill belongs to');
  const submitDisabled = busy || !!disabled || missingBits.length > 0;
  // A category the form preselected on the user's behalf doesn't make the form "started" — the
  // missing-fields hint stays quiet on an untouched form, exactly as it does on a blank one.
  const started = !!amount.trim() || !!bill || !!billKind || (!!category.trim() && category !== lastUsed?.category);

  const submit = async () => {
    const amt = parseFloat(amount);
    if (multiCompany && !companyId) { toast.error('Select the company this expense is for.'); return; }
    const cat = resolveCategory(categories, chamaries, category, subcategory);
    if (cat === null) return;
    if (!billKind) { toast.error('Select the bill type (handwritten or printed).'); return; }
    if (!bill) { toast.error('Attach the bill.'); return; }
    if (isNaN(amt) || amt <= 0) { toast.error('Enter a valid amount.'); return; }
    const billDateTs = dateStrToTimestamp(billDate);
    if (!billDateTs) { toast.error('Enter the bill date.'); return; }
    // A date in the future cannot be a receipt anyone is holding, and one is already in
    // production — block it. An old date only warns: a genuinely late receipt is ordinary, and
    // refusing it would block honest work to chase a typo. See billDatePlausibility.ts.
    const dateIssue = billDateWarning(billDate, Date.now());
    if (dateIssue?.level === 'block') { toast.error(dateIssue.message); return; }
    if (dateIssue) toast(dateIssue.message, { icon: '📅', duration: 6000 });
    const vatAmt = isVat ? round2(parseFloat(vatAmount)) : 0;
    if (isVat && vatAmt <= 0) { toast.error('Enter the VAT amount shown on the bill.'); return; }
    if (isVat && vatAmt > amt) { toast.error('VAT amount can’t exceed the bill amount.'); return; }
    const resolved = resolveSplits(splits, amt);
    if (resolved === null) return;
    if (resolved.length > 0 && !subAllowsSplit(categories, cat.category, cat.subcategory)) {
      toast.error('This sub category doesn’t allow splitting — remove the split rows first.'); return;
    }
    if (!belongsToEpf) { toast.error('Choose who this bill belongs to.'); return; }
    const cid  = multiCompany ? companyId : ctx.companyId;
    const cname = companies.find(c => c.id === cid)?.name ?? ctx.companyName;
    setBusy(true);
    try {
      const { bill_no } = await createSubmission({
        epf_number: belongsToEpf, employee_name: belongsToName,
        submitted_by_epf: ctx.epf, submitted_by_name: ctx.name,
        company_id: cid, company_name: cname,
        category: cat.category, subcategory: cat.subcategory, type: cat.type, chamary_id: cat.chamary_id, expense_type: cat.label,
        is_vat: isVat, vat_number: isVat ? vatNumber.trim() : '', vat_amount: vatAmt,
        shop_name: shop.trim(), item: item.trim(), amount: amt,
        bill_date: billDateTs, note: note.trim(),
        bill_kind: billKind, splits: resolved,
      }, bill);
      toast.success(belongsToEpf === ctx.epf
        ? `Expense submitted for approval. Bill No. ${bill_no}`
        : `Expense submitted for approval on behalf of ${belongsToName}. Bill No. ${bill_no}`);
      // Remembered only once the bill is actually filed — never on opening the form, never on a
      // failed submit. The values are resolveCategory's, so they're known-good taxonomy names.
      const pick: LastExpensePick = { category: cat.category, subcategory: cat.subcategory, type: cat.type };
      writeLastPick(ctx.epf, pick);
      reset(pick);
      setLastUsed(pick);
      onSaved();
    } catch (e) { toast.error(errMsg(e, 'Failed to submit expense.')); }
    finally { setBusy(false); }
  };

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-brand text-primary-foreground shadow-soft ring-1 ring-inset ring-[hsl(0_0%_100%/0.15)]">
          <Receipt className="h-[18px] w-[18px]" />
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-foreground leading-tight">Submit an expense</div>
          <div className="text-xs text-muted-foreground">Paid from your float — attach the bill for approval</div>
        </div>
      </div>

      {disabled && (
        <div className="mb-3 rounded-lg bg-warning/10 border border-warning/20 px-3 py-2 text-xs text-warning">
          Your account is inactive — you can’t submit expenses right now.
        </div>
      )}

      <fieldset disabled={disabled} className="disabled:opacity-60">
        <ExpenseFields
          category={category} setCategory={setCategory} subcategory={subcategory} setSubcategory={setSubcategory} categories={categories} chamaries={chamaries}
          lastUsedCategory={lastUsed?.category}
          isVat={isVat} setIsVat={setIsVat} vatNumber={vatNumber} setVatNumber={setVatNumber} vatAmount={vatAmount} setVatAmount={setVatAmount}
          shop={shop} setShop={setShop} item={item} setItem={setItem}
          amount={amount} setAmount={setAmount} billDate={billDate} setBillDate={setBillDate} note={note} setNote={setNote}
          billKind={billKind} setBillKind={setBillKind} bill={bill}
          onBill={setBill} fileRef={fileRef}
          companyId={companyId} setCompanyId={setCompanyId} companies={companies} multiCompany={multiCompany}
          splits={splits} setSplits={setSplits} submitterEpf={belongsToEpf}
        />
        <div className="mt-3">
          <Label className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
            <UserPlus className="h-3.5 w-3.5" /> This bill belongs to
          </Label>
          <Combobox value={belongsToEpf} onChange={pickBelongsTo} allowCustom={false}
            placeholder="Select employee" options={belongsToOptions} />
          {belongsToEpf !== ctx.epf && (
            <p className="mt-1 text-[11px] text-muted-foreground">Filing this bill on {belongsToName || 'their'} behalf — it debits their float, not yours.</p>
          )}
        </div>
        {!disabled && missingBits.length > 0 && started && (
          <InlineError className="mt-3">Still needed: {missingBits.join(', ')}.</InlineError>
        )}
        <Button onClick={submit} disabled={submitDisabled} className="mt-4 w-full">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Send className="w-4 h-4" /> Submit expense</>}
        </Button>
      </fieldset>
    </Card>
  );
}

// ─── Edit-expense form guts — shared by the submitter's modal edit and the approver's inline
// edit (Approvals panel). No Dialog chrome here; `renderActions` lets each caller place its own
// action buttons (Cancel+Save in a modal footer; Save alongside Approve/Reject inline).
function ExpenseEditForm({ open = true, editing, ctx, companies, multiCompany, categories, chamaries, onSaved, renderActions }: {
  open?: boolean;
  editing: SuspenseSubmission;
  ctx: { epf: string; name: string; companyId: string; companyName: string };
  companies: Company[]; multiCompany: boolean; categories: SuspenseCategory[]; chamaries: ChamaryWithPlace[];
  onSaved: () => void | Promise<void>;   // awaited before this form's own busy state clears
  /** `dirty` is what stops an approver's correction being thrown away: approveSubmission takes an
   *  id and re-reads the stored doc, so anything typed here and not saved is silently discarded
   *  the moment the list refreshes. `save({ silent: true })` writes without firing onSaved, so a
   *  caller can save and then approve in one go; it resolves false when validation refused. */
  renderActions?: (opts: {
    busy: boolean;
    save: (opts?: { silent?: boolean }) => Promise<boolean>;
    dirty: boolean;
  }) => React.ReactNode;
}) {
  const [category, setCategory]       = useState('');
  const [subcategory, setSubcategory] = useState('');
  const [isVat, setIsVat]             = useState(false);
  const [vatNumber, setVatNumber]     = useState('');
  const [vatAmount, setVatAmount]     = useState('');
  const [shop, setShop]     = useState('');
  const [item, setItem]     = useState('');
  const [amount, setAmount] = useState('');
  const [billDate, setBillDate] = useState('');
  const [note, setNote]     = useState('');
  const [bill, setBill]     = useState<File | null>(null);
  const [billKind, setBillKind] = useState<BillKind>('');
  const [companyId, setCompanyId] = useState('');
  const [splits, setSplits] = useState<SplitDraft[]>([]);
  const [busy, setBusy]     = useState(false);

  useEffect(() => {
    if (!open || !editing) return;
    // Legacy items have no category — fall back to the old expense_type as the category so it's
    // at least visible; the editor will require a re-pick if it's not a defined category.
    setCategory(editing.category ?? editing.expense_type ?? ''); setSubcategory(editing.subcategory ?? '');
    setIsVat(!!editing.is_vat); setVatNumber(editing.vat_number ?? ''); setVatAmount(editing.vat_amount != null ? String(editing.vat_amount) : '');
    setShop(editing.shop_name); setItem(editing.item);
    setAmount(String(editing.amount));
    // Legacy docs predate bill_date — fall back to when it was submitted rather than leaving it blank.
    setBillDate(timestampToDateStr(editing.bill_date) || timestampToDateStr(editing.created_at) || todayDateStr());
    setNote(editing.note); setBill(null);
    setBillKind(editing.bill_kind ?? ''); setCompanyId(editing.company_id);
    setSplits((editing.splits ?? []).map(s => ({ epf_number: s.epf_number, employee_name: s.employee_name, amount: String(s.amount) })));
  }, [open, editing]);

  // What the form held when it opened. Compared by value so "typed then typed back" counts as
  // clean, and so a re-render can never report a phantom edit.
  const snapshot = (): string => JSON.stringify({
    category, subcategory, isVat, vatNumber, vatAmount,
    shop, item, amount, billDate, note, billKind, companyId,
    splits: splits.map(s => [s.epf_number, s.amount]),
  });
  const pristine = useRef('');
  useEffect(() => { if (open && editing) pristine.current = snapshot();
    // Runs with the very state the init effect above just wrote — same deps on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);
  // A replacement bill file is always a change; there is nothing on the doc to compare it against.
  const dirty = !!bill || (pristine.current !== '' && snapshot() !== pristine.current);

  const save = async (opts?: { silent?: boolean }): Promise<boolean> => {
    const amt = parseFloat(amount);
    const cat = resolveCategory(categories, chamaries, category, subcategory);
    if (cat === null) return false;
    if (isNaN(amt) || amt <= 0) { toast.error('Enter a valid amount.'); return false; }
    const billDateTs = dateStrToTimestamp(billDate);
    if (!billDateTs) { toast.error('Enter the bill date.'); return false; }
    // Same rule as the submit form — an approver correcting a bill inline must not be able to
    // type a future date either, and gets the same nudge on a suspiciously old one.
    const dateIssue = billDateWarning(billDate, Date.now());
    if (dateIssue?.level === 'block') { toast.error(dateIssue.message); return false; }
    if (dateIssue) toast(dateIssue.message, { icon: '📅', duration: 6000 });
    const vatAmt = isVat ? round2(parseFloat(vatAmount)) : 0;
    if (isVat && vatAmt <= 0) { toast.error('Enter the VAT amount shown on the bill.'); return false; }
    if (isVat && vatAmt > amt) { toast.error('VAT amount can’t exceed the bill amount.'); return false; }
    const resolved = resolveSplits(splits, amt);
    if (resolved === null) return false;
    if (resolved.length > 0 && !subAllowsSplit(categories, cat.category, cat.subcategory)) {
      toast.error('This sub category doesn’t allow splitting — remove the split rows first.'); return false;
    }
    setBusy(true);
    try {
      const cname = companies.find(c => c.id === companyId)?.name ?? editing.company_name;
      await updateSubmission(editing.id,
        { category: cat.category, subcategory: cat.subcategory, type: cat.type, chamary_id: cat.chamary_id ?? null, expense_type: cat.label, is_vat: isVat, vat_number: isVat ? vatNumber.trim() : '', vat_amount: vatAmt, shop_name: shop.trim(), item: item.trim(), amount: amt, bill_date: billDateTs, note: note.trim(), bill_kind: billKind || null, company_id: companyId, company_name: cname, splits: resolved },
        { epf: ctx.epf, name: ctx.name }, bill);
      // Saved — this is the new baseline, so the form stops reporting itself dirty even when the
      // caller kept it open (save-then-approve does exactly that).
      pristine.current = snapshot();
      setBill(null);
      if (!opts?.silent) { toast.success('Expense updated.'); await onSaved(); }
      return true;
    } catch (e) { toast.error(errMsg(e, 'Failed to save expense.')); return false; }
    finally { setBusy(false); }
  };

  return (
    <>
      <ExpenseFields
        category={category} setCategory={setCategory} subcategory={subcategory} setSubcategory={setSubcategory} categories={categories} chamaries={chamaries}
        isVat={isVat} setIsVat={setIsVat} vatNumber={vatNumber} setVatNumber={setVatNumber} vatAmount={vatAmount} setVatAmount={setVatAmount}
        shop={shop} setShop={setShop} item={item} setItem={setItem}
        amount={amount} setAmount={setAmount} billDate={billDate} setBillDate={setBillDate} note={note} setNote={setNote}
        billKind={billKind} setBillKind={setBillKind} bill={bill}
        onBill={setBill} existingBill={!!editing?.bill_url && !bill}
        companyId={companyId} setCompanyId={setCompanyId} companies={companies} multiCompany={multiCompany}
        splits={splits} setSplits={setSplits} submitterEpf={ctx.epf}
      />
      {renderActions ? renderActions({ busy, save, dirty }) : (
        <div className="mt-4 flex justify-end">
          <Button disabled={busy} onClick={() => save()}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save changes'}</Button>
        </div>
      )}
    </>
  );
}

// ─── Edit-expense dialog (pending items only) ───────────────────────────────────
function ExpenseDialog({ open, onOpenChange, editing, ctx, companies, multiCompany, categories, chamaries, onSaved }: {
  open: boolean; onOpenChange: (v: boolean) => void;
  editing: SuspenseSubmission | null;
  ctx: { epf: string; name: string; companyId: string; companyName: string };
  companies: Company[]; multiCompany: boolean; categories: SuspenseCategory[]; chamaries: ChamaryWithPlace[];
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing?.status === 'rejected' ? 'Fix and resubmit expense' : 'Edit expense'}</DialogTitle>
          {editing?.status === 'rejected' && (
            <p className="text-xs text-muted-foreground">Saving sends this back to your approver as a new pending item.</p>
          )}
        </DialogHeader>
        {editing && (
          <ExpenseEditForm
            open={open} editing={editing} ctx={ctx} companies={companies} multiCompany={multiCompany} categories={categories} chamaries={chamaries}
            onSaved={() => { onOpenChange(false); onSaved(); }}
            renderActions={({ busy, save }) => (
              <DialogFooter>
                <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button disabled={busy} onClick={() => save()}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : editing?.status === 'rejected' ? 'Resubmit' : 'Save changes'}</Button>
              </DialogFooter>
            )}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Credit request dialog — create & edit ───────────────────────────────────────
function RequestDialog({ open, onOpenChange, editing, ctx, company, companies, multiCompany, categories, accounts, onSaved }: {
  open: boolean; onOpenChange: (v: boolean) => void;
  editing: SuspenseRequest | null;
  ctx: { epf: string; name: string };
  company: { id: string; name: string } | null;
  companies: Company[]; multiCompany: boolean;
  /** The requester's own accounts — the balance the asked amount would land on top of, which is
   *  what the float limit is measured against. */
  accounts: SuspenseAccount[];
  // The same taxonomy the bills use — a credit request says which category it is for, and the
  // category may name the people who have to sign it off (see credit_approvers).
  categories: SuspenseCategory[];
  onSaved: () => void;
}) {
  const [amount, setAmount]     = useState('');
  const [reason, setReason]     = useState('');
  const [companyId, setCompanyId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [busy, setBusy]         = useState(false);

  useEffect(() => {
    if (!open) return;
    setAmount(editing ? String(editing.amount) : '');
    setReason(editing?.reason ?? '');
    // New request: defaults to the account it was opened from (own company for most staff),
    // but multi-company staff can change it below. Editing keeps the request's original company.
    setCompanyId(editing ? editing.company_id : (company?.id ?? ''));
    // An older request may carry no category at all — the picker then starts empty and, because
    // Category is required, editing such a request is also the moment it gains one.
    setCategoryId(editing?.category_id ?? '');
  }, [open, editing, company]);

  const targetName = editing ? editing.company_name : (companies.find(c => c.id === companyId)?.name ?? company?.name ?? '');
  // The holder's own float limit on the account this request is for. Advisory only: an ask over
  // the ceiling is never blocked here — the approver is the one who decides, and telling the
  // requester up front is kinder than a silent grant of less than they asked for.
  const targetCompanyId = editing ? editing.company_id : companyId;
  const myAccount   = accounts.find(a => a.company_id === targetCompanyId);
  const myBalance   = myAccount?.balance ?? 0;
  const myCurrency  = myAccount?.currency ?? 'LKR';
  const myLimit     = useResolvedLimit(open ? ctx.epf : null, open ? targetCompanyId : null);
  const myHeadroom  = myLimit && myLimit.limit !== null ? Math.max(0, myLimit.limit - myBalance) : null;
  const selectedCat = categories.find(c => c.id === categoryId) ?? null;
  // Who this request will wait on — the category's pool minus the requester themselves, exactly
  // as createRequest resolves it, so the dialog can't promise a gate the service won't create.
  const willWaitOn = (selectedCat?.credit_approvers ?? []).filter(a => a.epf !== ctx.epf);

  // Live validation — mirrors the guards in save() so the inline messages and the
  // disabled Submit button always agree with what a submit would reject.
  const parsedAmount = parseFloat(amount);
  const amountError =
    amount.trim() === ''
      ? 'Enter an amount.'
      : isNaN(parsedAmount) || parsedAmount <= 0
        ? 'Enter an amount greater than zero.'
        : '';
  const needCompany = !editing && multiCompany;
  const companyError = needCompany && !companyId ? 'Select a company.' : '';
  const categoryError = !categoryId ? 'Select a category.' : '';
  const saveDisabled = busy || !!amountError || !!companyError || !!categoryError;

  const save = async () => {
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) { toast.error('Enter a valid amount.'); return; }
    const cat = categories.find(c => c.id === categoryId);
    if (!cat) { toast.error('Select a category.'); return; }
    setBusy(true);
    try {
      if (editing) {
        await updateRequest(editing.id, {
          amount: amt, reason: reason.trim(), category_id: cat.id, category_name: cat.name,
        });
        toast.success('Request updated.');
      } else {
        if (!companyId) { toast.error('Select a company.'); setBusy(false); return; }
        await createRequest({
          epf_number: ctx.epf, employee_name: ctx.name, company_id: companyId, company_name: targetName,
          amount: amt, reason: reason.trim(), category_id: cat.id, category_name: cat.name,
        });
        toast.success('Credit request submitted.');
      }
      onOpenChange(false);
      onSaved();
    } catch (e) { toast.error(errMsg(e, 'Failed to save request.')); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{editing ? 'Edit credit request' : 'Request credit'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {!editing && multiCompany ? (
            <div>
              <Label className="text-xs font-semibold text-muted-foreground mb-1.5 block flex items-center gap-1"><Building2 className="h-3.5 w-3.5" /> Company <span className="text-destructive">*</span></Label>
              <Combobox value={companyId} onChange={setCompanyId} allowCustom={false} placeholder="Select company"
                options={companies.map(c => ({ value: c.id, label: c.name }))} />
              <InlineError>{companyError}</InlineError>
            </div>
          ) : targetName && (
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <Building2 className="h-3.5 w-3.5" /> Company: <span className="font-medium text-foreground">{targetName}</span>
            </div>
          )}
          <div>
            <Label className="text-xs font-semibold text-muted-foreground mb-1.5 block">Category <span className="text-destructive">*</span></Label>
            <Combobox value={categoryId} onChange={setCategoryId} allowCustom={false}
              placeholder={categories.length ? 'What is this credit for?' : 'No categories — add them in Settings'}
              options={categories.map(c => ({ value: c.id, label: c.name }))} />
            <InlineError>{categoryError}</InlineError>
            {willWaitOn.length > 0 && (
              <p className="mt-1 flex items-start gap-1 text-[11px] text-muted-foreground">
                <ShieldCheck className="mt-px h-3 w-3 shrink-0 text-primary" />
                <span>
                  Needs approval from{' '}
                  <span className="font-medium text-foreground">
                    {willWaitOn.length === 1 ? willWaitOn[0].name : `any one of ${willWaitOn.map(a => a.name).join(', ')}`}
                  </span>{' '}
                  before it reaches the suspense approvers.
                </span>
              </p>
            )}
          </div>
          <div>
            <Label className="text-xs font-semibold text-muted-foreground mb-1.5 block">Amount <span className="text-destructive">*</span></Label>
            <Input type="number" inputMode="decimal" min="0" step="0.01" value={amount}
              onChange={e => setAmount(e.target.value)} placeholder="0.00" autoFocus
              aria-invalid={amount.trim() !== '' && !!amountError} />
            {amount.trim() !== '' && <InlineError>{amountError}</InlineError>}
            {myLimit && myLimit.limit !== null && myHeadroom !== null && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Your limit <span className="font-medium tabular-nums text-foreground">{formatSuspenseAmount(myLimit.limit, myCurrency)}</span>
                {' · '}headroom <span className="font-medium tabular-nums text-foreground">{formatSuspenseAmount(myHeadroom, myCurrency)}</span>
              </p>
            )}
            {myHeadroom !== null && !isNaN(parsedAmount) && parsedAmount > myHeadroom && (
              <p className="mt-1 rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] text-warning">
                This is {formatSuspenseAmount(parsedAmount - myHeadroom, myCurrency)} over your limit — the approver may grant less.
              </p>
            )}
          </div>
          <div>
            <Label className="text-xs font-semibold text-muted-foreground mb-1.5 block">Reason</Label>
            <Textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} placeholder="Why do you need this credit?" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={saveDisabled} onClick={save}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : editing ? 'Save changes' : 'Submit request'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


// ─── Approver: pending submission card ──────────────────────────────────────────
// Collapsed: shop · category · subcategory + amount only. Expanded: bill image next to the full
// bill data, editable in place (reuses ExpenseEditForm — the same edit logic the submitter's own
// modal uses), with Save/Reject/Approve in one action bar.
function PendingSubmissionCard({ sub, actor, onDone, onActed, compact, companies, multiCompany, categories, chamaries }: {
  sub: SuspenseSubmission; actor: Actor; onDone: () => void | Promise<void>; compact?: boolean;
  /** Fired the moment this bill is approved or rejected. The page removes it from the queue at
   *  once and debounces the real refetch, so working down a long queue does not re-download
   *  every pending bill after each decision. */
  onActed?: (id: string) => void;
  companies: Company[]; multiCompany: boolean; categories: SuspenseCategory[]; chamaries: ChamaryWithPlace[];
}) {
  const [busy, setBusy]           = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason]       = useState('');
  const [expanded, setExpanded]   = useState(false);
  const [voucherPreview, setVoucherPreview] = useState<VoucherPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Set by the inline editor on every render so approve() can see unsaved edits. approveSubmission
  // takes an id and re-reads the stored doc, so an approver who corrects an amount and hits
  // Approve would otherwise have their correction thrown away and the ORIGINAL amount debited —
  // and since approval now debits the whole bill, that is real money going out at the wrong figure.
  const pendingEdit = useRef<{ dirty: boolean; save: (o?: { silent?: boolean }) => Promise<boolean> } | null>(null);

  const approve = async () => {
    setBusy(true);
    try {
      // Save first when the form has unsaved changes, so the bill that gets approved is the bill
      // on screen. A validation failure inside save() aborts the approval rather than approving
      // the stale figures behind it.
      if (pendingEdit.current?.dirty) {
        const saved = await pendingEdit.current.save({ silent: true });
        if (!saved) { setVoucherPreview(null); return; }
      }
      await approveSubmission({ id: sub.id, actor });
      toast.success('Expense approved.');
      // Drop it from the queue now — the card unmounts, which closes the double-click window far
      // more firmly than the old "await a full refetch before re-enabling the button" did, and
      // without re-downloading every other pending bill. onActed also schedules the real refresh.
      if (onActed) onActed(sub.id); else await onDone();
    }
    catch (e) { toast.error(errMsg(e, 'Failed to approve.')); }
    finally { setBusy(false); setVoucherPreview(null); }
  };
  // Approve is a two-step confirm: preview which voucher this bill will join (or that it opens a
  // new one) and let the approver OK or cancel — cancelling aborts the approval too, not just the
  // voucher assignment.
  const startApprove = async () => {
    setPreviewLoading(true);
    try { setVoucherPreview(await previewVoucherForApproval(sub)); }
    catch { setVoucherPreview({ voucherNo: null, isNew: true, billCount: 0 }); }
    finally { setPreviewLoading(false); }
  };
  const reject = async () => {
    setBusy(true);
    try {
      await rejectSubmission({ id: sub.id, reason: reason.trim(), actor });
      toast.success('Expense rejected.');
      if (onActed) onActed(sub.id); else await onDone();
    }
    catch (e) { toast.error(errMsg(e, 'Failed to reject.')); }
    finally { setBusy(false); }
  };

  const taxonomy = [sub.category, sub.subcategory].filter(Boolean).join(' · ') || sub.expense_type;

  return (
    <Card className="overflow-hidden p-0">
      <button type="button" onClick={() => setExpanded(v => !v)} aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-accent/40">
        <div className="min-w-0">
          {!compact && (
            <div className="mb-0.5 flex flex-wrap items-center gap-2">
              <span className="font-semibold text-foreground">{sub.employee_name}</span>
              <Badge variant="muted">{sub.epf_number}</Badge>
            </div>
          )}
          {sub.submitted_by_epf && sub.submitted_by_epf !== sub.epf_number && (
            <div className="mb-0.5">
              <Badge variant="outline">Filed by {sub.submitted_by_name || sub.submitted_by_epf}</Badge>
            </div>
          )}
          <div className="truncate text-sm font-medium text-foreground">{sub.shop_name || '—'}</div>
          <div className="truncate text-[11px] text-muted-foreground">{taxonomy}</div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-base font-bold tabular-nums text-destructive">−{formatSuspenseAmount(sub.amount)}</span>
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border/60 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            {sub.bill_no && <span>Bill No. <span className="font-medium text-foreground">{sub.bill_no}</span></span>}
            <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> Submitted {fmtDateTime(sub.created_at)}</span>
            <span>Bill date: <span className="font-medium text-foreground">{(sub.bill_date ?? sub.created_at)?.toDate?.().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) ?? '—'}</span></span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <BillThumb url={sub.bill_url} type={sub.bill_type} size="lg" />
            <ExpenseEditForm
              editing={sub} ctx={{ epf: actor.epf, name: actor.name, companyId: sub.company_id, companyName: sub.company_name }}
              companies={companies} multiCompany={multiCompany} categories={categories} chamaries={chamaries}
              onSaved={async () => { await onDone(); setExpanded(false); }}
              renderActions={({ busy: savingBusy, save, dirty }) => {
              pendingEdit.current = { dirty, save };
              return rejecting ? (
                <div className="mt-4 space-y-2 border-t border-border/60 pt-3">
                  <Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for rejection (optional)" autoFocus />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(false)}>Cancel</Button>
                    <Button size="sm" variant="destructive" disabled={busy} onClick={reject}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Confirm reject'}</Button>
                  </div>
                </div>
              ) : (
                <div className="mt-4 space-y-2 border-t border-border/60 pt-3">
                  {/* Unsaved edits used to vanish the moment the list refreshed. They are now
                      carried into the approval, and this line says so before the click rather
                      than leaving the approver to wonder which figures were used. */}
                  {dirty && (
                    <p className="text-[11px] font-medium text-warning">
                      You have unsaved changes. Approving saves them first — the bill is approved as it reads now.
                    </p>
                  )}
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button size="sm" variant="outline" disabled={savingBusy || busy || !dirty} onClick={() => save()}>{savingBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save changes'}</Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(true)}><X className="w-4 h-4" /> Reject</Button>
                    <Button size="sm" variant="success" disabled={busy || savingBusy || previewLoading} onClick={startApprove}>
                      {previewLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Check className="w-4 h-4" /> {dirty ? 'Save & approve' : 'Approve'}</>}
                    </Button>
                  </div>
                </div>
              );
            }}
            />
          </div>
        </div>
      )}

      <Dialog open={!!voucherPreview} onOpenChange={(v) => { if (!v) setVoucherPreview(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Approve this expense?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            {voucherPreview?.isNew
              ? 'This will open a new voucher for this bill.'
              : `This bill will be added to Voucher ${voucherPreview?.voucherNo} — it already has ${voucherPreview?.billCount} bill${(voucherPreview?.billCount ?? 0) === 1 ? '' : 's'}.`}
          </p>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setVoucherPreview(null)}>Cancel</Button>
            <Button variant="success" disabled={busy} onClick={approve}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'OK, approve'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ─── Approver: pending request card (editable amount) ───────────────────────────
function PendingRequestCard({ req, actor, onDone, compact, currency, currentBalance }: {
  req: SuspenseRequest; actor: Actor; onDone: () => void | Promise<void>; compact?: boolean; currency: string;
  /** This person's balance on the request's company account — undefined until the page's
   *  account list has loaded, which is what tells the limit line to stay quiet rather than
   *  claim a balance of zero. */
  currentBalance?: number;
}) {
  const [busy, setBusy]         = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason]     = useState('');
  const [granted, setGranted]   = useState(String(req.amount));
  // Approving a credit request requires re-entering the approver's own PIN (set in Settings) —
  // see verifyApprovalPin in suspenseService.ts. Rejecting is unaffected.
  const [pinDialog, setPinDialog] = useState(false);
  const [pin, setPin]             = useState('');
  const [verifying, setVerifying] = useState(false);
  // Float limit (src/lib/suspenseLimits.ts). approveRequest re-resolves and re-checks this at
  // write time — everything here is so the approver sees the ceiling BEFORE typing an amount,
  // and can override it deliberately instead of having the approval thrown back at them.
  const [override, setOverride]             = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const resolved = useResolvedLimit(req.epf_number, req.company_id);
  const grantedNum = parseFloat(granted);
  const balance    = currentBalance ?? 0;
  const check      = checkAgainstLimit(
    currentBalance === undefined ? null : resolved?.limit ?? null,
    balance + (isNaN(grantedNum) ? 0 : grantedNum),
  );
  const overrideMissing = check.over && (!override || !overrideReason.trim());

  const startApprove = () => {
    const amt = parseFloat(granted);
    if (isNaN(amt) || amt <= 0) { toast.error('Enter a valid amount to grant.'); return; }
    if (overrideMissing) { toast.error('Tick “Override the limit” and give a reason, or grant less.'); return; }
    setPin(''); setPinDialog(true);
  };
  const approve = async () => {
    const amt = parseFloat(granted);
    if (isNaN(amt) || amt <= 0) { toast.error('Enter a valid amount to grant.'); return; }
    setBusy(true);
    try {
      await approveRequest({ id: req.id, approved_amount: amt, actor, overrideLimit: check.over ? overrideReason.trim() : undefined });
      toast.success('Credit approved.'); await onDone();
    }
    catch (e) { toast.error(errMsg(e, 'Failed to approve.')); }
    finally { setBusy(false); }
  };
  const confirmApprove = async () => {
    if (!/^\d{4}$/.test(pin)) { toast.error('Enter your 4-digit approval PIN.'); return; }
    setVerifying(true);
    try {
      const ok = await verifyApprovalPin(actor.epf, pin);
      if (!ok) { toast.error('Incorrect PIN.'); return; }
      setPinDialog(false);
      await approve();
    } catch (e) { toast.error(errMsg(e, 'PIN check failed.')); }
    finally { setVerifying(false); }
  };
  const reject = async () => {
    setBusy(true);
    try { await rejectRequest({ id: req.id, reason: reason.trim(), actor }); toast.success('Request rejected.'); await onDone(); }
    catch (e) { toast.error(errMsg(e, 'Failed to reject.')); }
    finally { setBusy(false); }
  };

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {!compact && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-foreground">{req.employee_name}</span>
              <Badge variant="muted">{req.epf_number}</Badge>
            </div>
          )}
          {req.category_name && <Badge variant="outline" className="mt-1 gap-1"><Tags className="w-3 h-3" /> {req.category_name}</Badge>}
          <div className="mt-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><Building2 className="w-3 h-3" /> {req.company_name}</div>
          {req.reason && <div className="mt-1 text-sm text-muted-foreground">{req.reason}</div>}
          {/* Who already signed this off on the way here — the amount below is the last decision
              left, and it should be made knowing the request has been vouched for. */}
          {req.category_status === 'approved' && (
            <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
              <ShieldCheck className="w-3 h-3 shrink-0" />
              Category approved by {req.category_approved_by_name ?? req.category_approved_by}
            </div>
          )}
          <div className="mt-1.5 text-[11px] text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtDateTime(req.created_at)}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-muted-foreground">Requested</div>
          <div className="text-lg font-bold tabular-nums text-success">+{formatSuspenseAmount(req.amount)}</div>
        </div>
      </div>

      {rejecting ? (
        <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
          <Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for rejection (optional)" autoFocus />
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(false)}>Cancel</Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={reject}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Confirm reject'}</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-col sm:flex-row sm:items-end gap-2 border-t border-border/60 pt-3">
          <div className="flex-1">
            <Label className="text-[11px] font-semibold text-muted-foreground mb-1 block">Amount to grant (editable)</Label>
            <Input type="number" inputMode="decimal" min="0" step="0.01" value={granted} onChange={e => setGranted(e.target.value)} />
            {currentBalance !== undefined && (
              <LimitHeadroomLine className="mt-1" resolved={resolved} balance={balance} currency={currency} />
            )}
            {check.over && (
              <LimitOverridePanel
                name={req.employee_name} resolved={resolved} currency={currency}
                balanceAfter={balance + (isNaN(grantedNum) ? 0 : grantedNum)} excess={check.excess}
                checked={override} onCheckedChange={setOverride}
                reason={overrideReason} onReasonChange={setOverrideReason}
                disabled={busy}
              />
            )}
          </div>
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(true)}><X className="w-4 h-4" /> Reject</Button>
            <Button size="sm" variant="success" disabled={busy || overrideMissing} onClick={startApprove}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Check className="w-4 h-4" /> Approve</>}</Button>
          </div>
        </div>
      )}

      <Dialog open={pinDialog} onOpenChange={setPinDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Enter your approval PIN</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">
            Confirm approving {req.employee_name}’s request for {formatSuspenseAmount(parseFloat(granted) || 0)}.
          </p>
          <Input type="password" inputMode="numeric" maxLength={4} autoFocus value={pin}
            onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onKeyDown={e => { if (e.key === 'Enter') confirmApprove(); }}
            placeholder="••••" className="text-center text-lg tracking-[0.5em]" />
          <DialogFooter>
            <Button variant="outline" disabled={verifying} onClick={() => setPinDialog(false)}>Cancel</Button>
            <Button variant="success" disabled={verifying || pin.length !== 4} onClick={confirmApprove}>
              {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Confirm approve'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// Stage-1 (supervisor) sign-off on a technician's credit request — the personal or company
// supervisor's card. No editable "amount to grant" here: the supervisor only forwards the
// request at its original amount, or rejects it outright; the granted amount is still the
// suspense approver's call at stage 2 (PendingRequestCard, above). See approveSupervisorStage /
// rejectRequest in suspenseService.ts.
function PendingSupervisorRequestCard({ req, actor, onDone, compact }: { req: SuspenseRequest; actor: Actor; onDone: () => void | Promise<void>; compact?: boolean }) {
  const [busy, setBusy]           = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason]       = useState('');

  const approve = async () => {
    setBusy(true);
    try { await approveSupervisorStage(req.id, actor); toast.success('Forwarded for final approval.'); await onDone(); }
    catch (e) { toast.error(errMsg(e, 'Failed to approve.')); }
    finally { setBusy(false); }
  };
  const reject = async () => {
    setBusy(true);
    try { await rejectRequest({ id: req.id, reason: reason.trim(), actor }); toast.success('Request rejected.'); await onDone(); }
    catch (e) { toast.error(errMsg(e, 'Failed to reject.')); }
    finally { setBusy(false); }
  };

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {!compact && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-foreground">{req.employee_name}</span>
              <Badge variant="muted">{req.epf_number}</Badge>
            </div>
          )}
          {req.category_name && <Badge variant="outline" className="mt-1 gap-1"><Tags className="w-3 h-3" /> {req.category_name}</Badge>}
          <div className="mt-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><Building2 className="w-3 h-3" /> {req.company_name}</div>
          {req.reason && <div className="mt-1 text-sm text-muted-foreground">{req.reason}</div>}
          {/* Forwarding doesn't hand this straight to the suspense approvers when the category
              names its own people — say so, so "approved" here isn't mistaken for the last word. */}
          {req.needs_category_approval && req.category_status !== 'approved' && (
            <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
              <ShieldCheck className="w-3 h-3 shrink-0" />
              Then goes to {categoryApproverList(req)} for this category
            </div>
          )}
          <div className="mt-1.5 text-[11px] text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtDateTime(req.created_at)}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-muted-foreground">Requested</div>
          <div className="text-lg font-bold tabular-nums text-success">+{formatSuspenseAmount(req.amount)}</div>
        </div>
      </div>

      {rejecting ? (
        <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
          <Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for rejection (optional)" autoFocus />
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(false)}>Cancel</Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={reject}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Confirm reject'}</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex justify-end gap-2 border-t border-border/60 pt-3">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(true)}><X className="w-4 h-4" /> Reject</Button>
          <Button size="sm" variant="success" disabled={busy} onClick={approve}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Check className="w-4 h-4" /> Approve &amp; forward</>}</Button>
        </div>
      )}
    </Card>
  );
}

// Stage-2 (category) sign-off — the card shown to someone named as a credit approver on the
// request's category. Like the supervisor card there is no editable "amount to grant": this
// person vouches for the SPEND, at the amount asked; how much is actually released stays the
// suspense approver's call at stage 3. See approveCategoryStage / rejectRequest.
function PendingCategoryRequestCard({ req, actor, onDone, compact }: { req: SuspenseRequest; actor: Actor; onDone: () => void | Promise<void>; compact?: boolean }) {
  const [busy, setBusy]           = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason]       = useState('');

  const approve = async () => {
    setBusy(true);
    try { await approveCategoryStage(req.id, actor); toast.success('Forwarded for final approval.'); await onDone(); }
    catch (e) { toast.error(errMsg(e, 'Failed to approve.')); }
    finally { setBusy(false); }
  };
  const reject = async () => {
    setBusy(true);
    try { await rejectRequest({ id: req.id, reason: reason.trim(), actor }); toast.success('Request rejected.'); await onDone(); }
    catch (e) { toast.error(errMsg(e, 'Failed to reject.')); }
    finally { setBusy(false); }
  };

  // Everyone else who could sign this instead — worth naming, because any one of them clears it
  // and the person looking at the card is deciding whether it is really theirs to action.
  const others = (req.category_approvers ?? []).filter(a => a.epf !== actor.epf).map(a => a.name);

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {!compact && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-foreground">{req.employee_name}</span>
              <Badge variant="muted">{req.epf_number}</Badge>
            </div>
          )}
          {req.category_name && <Badge variant="outline" className="mt-1 gap-1"><Tags className="w-3 h-3" /> {req.category_name}</Badge>}
          <div className="mt-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><Building2 className="w-3 h-3" /> {req.company_name}</div>
          {req.reason && <div className="mt-1 text-sm text-muted-foreground">{req.reason}</div>}
          {req.supervisor_status === 'approved' && (
            <div className="mt-1 text-[11px] text-muted-foreground">
              Supervisor: approved by {req.supervisor_approved_by_name ?? req.supervisor_approved_by}
            </div>
          )}
          {others.length > 0 && (
            <div className="mt-1 text-[11px] text-muted-foreground">Also able to approve: {others.join(', ')}</div>
          )}
          <div className="mt-1.5 text-[11px] text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtDateTime(req.created_at)}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-muted-foreground">Requested</div>
          <div className="text-lg font-bold tabular-nums text-success">+{formatSuspenseAmount(req.amount)}</div>
        </div>
      </div>

      {rejecting ? (
        <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
          <Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for rejection (optional)" autoFocus />
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(false)}>Cancel</Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={reject}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Confirm reject'}</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex justify-end gap-2 border-t border-border/60 pt-3">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(true)}><X className="w-4 h-4" /> Reject</Button>
          <Button size="sm" variant="success" disabled={busy} onClick={approve}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Check className="w-4 h-4" /> Approve &amp; forward</>}</Button>
        </div>
      )}
    </Card>
  );
}

// ─── Close account dialog (holder or approver initiates) ────────────────────────
function CloseAccountDialog({ open, onOpenChange, account, actor, direct, onSaved }: {
  open: boolean; onOpenChange: (v: boolean) => void;
  account: SuspenseAccount | null; actor: Actor; direct: boolean; onSaved: () => void;
}) {
  const [note, setNote]         = useState('');
  const [transfer, setTransfer] = useState<File | null>(null);
  const [busy, setBusy]         = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setNote(''); setTransfer(null);
    if (fileRef.current) fileRef.current.value = '';
  }, [open]);

  const bal          = account?.balance ?? 0;
  const currency     = account?.currency ?? 'LKR';
  const needsTransfer = bal > 0;

  const submit = async () => {
    if (!account) return;
    if (needsTransfer && !transfer) { toast.error('Attach the fund-transfer proof for the balance.'); return; }
    setBusy(true);
    try {
      const payload = {
        epf_number: account.epf_number, employee_name: account.employee_name,
        company_id: account.company_id, company_name: account.company_name, note: note.trim(),
      };
      if (direct) {
        await closeAccountNow(payload, actor, transfer);
        toast.success('Account closed and settled.');
      } else {
        await createCloseRequest(payload, actor, transfer);
        toast.success('Close request submitted for approval.');
      }
      onOpenChange(false);
      onSaved();
    } catch (e) { toast.error(errMsg(e, direct ? 'Failed to close account.' : 'Failed to submit close request.')); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Close suspense account</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Balance to settle</div>
            <div className={`text-xl font-bold tabular-nums ${bal < 0 ? 'text-destructive' : 'text-foreground'}`}>{formatSuspenseAmount(bal, currency)}</div>
          </div>

          {needsTransfer ? (
            <div>
              <Label className="text-xs font-semibold text-muted-foreground mb-1.5 block">
                Fund-transfer proof for {formatSuspenseAmount(bal, currency)} <span className="text-destructive">*</span>
              </Label>
              <input ref={fileRef} type="file" accept="image/*,application/pdf"
                onChange={e => {
                  const f = e.target.files?.[0] ?? null;
                  // Same attach-time guard as the bill picker — an oversized PDF is refused now.
                  if (f && !f.type.startsWith('image/') && f.size > MAX_UPLOAD_BYTES) { e.target.value = ''; toast.error(tooLargeMessage(f)); return; }
                  setTransfer(f);
                }}
                className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary hover:file:bg-primary/20" />
              <p className="mt-1 text-[11px] text-muted-foreground">Transfer the full balance back to the company and attach the receipt — the transfer amount must equal the balance.</p>
            </div>
          ) : bal < 0 ? (
            <div className="rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
              The account is overspent — the outstanding {formatSuspenseAmount(-bal, currency)} will be written off (to reconcile with salary) on approval.
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Balance is zero — nothing to transfer.</p>
          )}

          <div>
            <Label className="text-xs font-semibold text-muted-foreground mb-1.5 block">Note</Label>
            <Textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="Optional details" />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {direct
              ? 'This settles the balance and closes the account immediately.'
              : 'The account is frozen while pending; a suspense approver approves or rejects it.'}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={submit}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Lock className="w-4 h-4" /> {direct ? 'Close account' : 'Request close'}</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Approver: pending close-request card ───────────────────────────────────────
function PendingCloseCard({ close, actor, onDone }: { close: SuspenseCloseRequest; actor: Actor; onDone: () => void | Promise<void> }) {
  const [busy, setBusy]         = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason]     = useState('');

  const approve = async () => {
    setBusy(true);
    try { await approveCloseRequest({ id: close.id, actor }); toast.success('Account closed.'); await onDone(); }
    catch (e) { toast.error(errMsg(e, 'Failed to approve.')); }
    finally { setBusy(false); }
  };
  const reject = async () => {
    setBusy(true);
    try { await rejectCloseRequest({ id: close.id, reason: reason.trim(), actor }); toast.success('Close request rejected.'); await onDone(); }
    catch (e) { toast.error(errMsg(e, 'Failed to reject.')); }
    finally { setBusy(false); }
  };

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-foreground">{close.employee_name}</span>
            <Badge variant="muted">{close.epf_number}</Badge>
          </div>
          <div className="mt-1 text-sm text-foreground">Requesting to close the account</div>
          {close.note && <div className="mt-0.5 text-xs text-muted-foreground">{close.note}</div>}
          <div className="mt-1.5 flex items-center gap-3">
            {close.transfer_url
              ? <BillLink url={close.transfer_url} type={close.transfer_type} />
              : <span className="text-[11px] text-muted-foreground">No transfer needed</span>}
            <span className="text-[11px] text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtDateTime(close.created_at)}</span>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">Requested by {close.requested_by_name || close.requested_by}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-muted-foreground">Balance</div>
          <div className={`text-lg font-bold tabular-nums ${close.balance_at_request < 0 ? 'text-destructive' : 'text-foreground'}`}>{formatSuspenseAmount(close.balance_at_request)}</div>
          {close.transfer_amount > 0 && (
            <div className="text-[11px] text-success flex items-center justify-end gap-1"><Landmark className="w-3 h-3" /> {formatSuspenseAmount(close.transfer_amount)} transfer</div>
          )}
        </div>
      </div>

      {rejecting ? (
        <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
          <Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for rejection (optional)" autoFocus />
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(false)}>Cancel</Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={reject}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Confirm reject'}</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex gap-2 justify-end border-t border-border/60 pt-3">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(true)}><X className="w-4 h-4" /> Reject</Button>
          <Button size="sm" variant="success" disabled={busy} onClick={approve}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Check className="w-4 h-4" /> Approve &amp; close</>}</Button>
        </div>
      )}
    </Card>
  );
}

// ─── Approver: group by user + paginate ─────────────────────────────────────────
interface UserGroup<T> { epf: string; name: string; total: number; items: T[] }

function groupByUser<T extends { epf_number: string; employee_name: string; amount: number }>(items: T[]): UserGroup<T>[] {
  const m = new Map<string, UserGroup<T>>();
  for (const it of items) {
    let g = m.get(it.epf_number);
    if (!g) { g = { epf: it.epf_number, name: it.employee_name, total: 0, items: [] }; m.set(it.epf_number, g); }
    g.items.push(it);
    g.total += it.amount;
  }
  return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// Pending items grouped user-wise (one block per user with their running total), paged
// through when there are many users.
/**
 * Date filter + sort for a list of bills. A bill has two dates and they routinely disagree —
 * someone hands in a fortnight of receipts at once, so they share a submitted date while
 * spanning two weeks of bill dates. Which one you are filtering and sorting by is therefore a
 * choice, not a detail, and it is the first control here rather than a buried option.
 */
function BillDateFilterBar({ field, setField, range, setRange, dir, setDir, shown, total }: {
  field: BillDateField; setField: (f: BillDateField) => void;
  range: BillDateRange; setRange: (r: BillDateRange) => void;
  dir: SortDir; setDir: (d: SortDir) => void;
  shown: number; total: number;
}) {
  const filtered = !!(range.from || range.to);
  return (
    <div className="mb-3 rounded-xl border border-border bg-card/40 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[10rem]">
          <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">Date to use</Label>
          <Select value={field} onChange={v => setField(v as BillDateField)}
            options={[{ value: 'bill', label: BILL_DATE_LABEL.bill }, { value: 'submitted', label: BILL_DATE_LABEL.submitted }]} />
        </div>
        <div>
          <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">From</Label>
          <Input type="date" value={range.from ?? ''} onChange={e => setRange({ ...range, from: e.target.value })}
            className="h-9 w-[9.5rem] text-xs" aria-label="From date" />
        </div>
        <div>
          <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">To</Label>
          <Input type="date" value={range.to ?? ''} onChange={e => setRange({ ...range, to: e.target.value })}
            className="h-9 w-[9.5rem] text-xs" aria-label="To date" />
        </div>
        {/* Newest/oldest rather than an arrow alone — the two directions are a word apart and an
            icon-only toggle would need a label anyway. */}
        <Button type="button" size="sm" variant="outline" className="h-9"
          onClick={() => setDir(dir === 'desc' ? 'asc' : 'desc')}
          title={`Sorted by ${BILL_DATE_LABEL[field].toLowerCase()}, ${dir === 'desc' ? 'newest' : 'oldest'} first`}>
          <ArrowUpDown className="h-3.5 w-3.5" /> {dir === 'desc' ? 'Newest first' : 'Oldest first'}
        </Button>
        {filtered && (
          <Button type="button" size="sm" variant="ghost" className="h-9" onClick={() => setRange({})}>
            <X className="h-3.5 w-3.5" /> Clear
          </Button>
        )}
      </div>
      {filtered && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Showing <span className="font-semibold tabular-nums text-foreground">{shown}</span> of {total} by {BILL_DATE_LABEL[field].toLowerCase()}.
        </p>
      )}
    </div>
  );
}

function PaginatedUserGroups<T extends { id: string; epf_number: string; employee_name: string; amount: number }>({
  items, sign, currency, renderCard, renderItems,
}: {
  items: T[]; sign: '+' | '−'; currency: string; renderCard: (it: T) => React.ReactNode;
  // Full control over a user's expanded content (e.g. company/category nesting) — takes priority
  // over renderCard when given. The Credit Requests tab has no such nesting and just uses renderCard.
  renderItems?: (items: T[]) => React.ReactNode;
}) {
  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState(5);
  const [search, setSearch]     = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (epf: string) => setExpanded((prev) => {
    const n = new Set(prev);
    if (n.has(epf)) n.delete(epf); else n.add(epf);
    return n;
  });
  const allGroups  = groupByUser(items);
  const q          = search.trim().toLowerCase();
  const groups     = q ? allGroups.filter(g => g.name.toLowerCase().includes(q) || g.epf.toLowerCase().includes(q)) : allGroups;
  const total      = groups.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p          = Math.min(page, totalPages);
  const pageGroups = groups.slice((p - 1) * pageSize, p * pageSize);

  return (
    <div className="space-y-5">
      {allGroups.length > 1 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by name or EPF…"
            className="pl-9"
          />
        </div>
      )}
      {groups.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No one matches “{search.trim()}”.</p>
      ) : pageGroups.map((g) => {
        const open = expanded.has(g.epf);
        return (
          <div key={g.epf} className="overflow-hidden rounded-2xl border border-border bg-card/40">
            {/* Summary row — click to expand this user's items */}
            <button
              type="button"
              onClick={() => toggle(g.epf)}
              aria-expanded={open}
              className="flex w-full items-center justify-between gap-2 p-3 text-left transition-colors hover:bg-accent/40 sm:p-4"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                  {(g.name || '?').charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="truncate font-semibold text-foreground">{g.name}</div>
                  <div className="text-[11px] text-muted-foreground">{g.epf} · {g.items.length} item{g.items.length > 1 ? 's' : ''}</div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className={`text-sm font-bold tabular-nums ${sign === '−' ? 'text-destructive' : 'text-success'}`}>
                  {sign}{formatSuspenseAmount(g.total, currency)}
                </span>
                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
              </div>
            </button>

            <AnimatePresence initial={false}>
              {open && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: 'easeInOut' }}
                  className="overflow-hidden"
                >
                  <div className="space-y-2.5 border-t border-border/60 p-3 sm:p-4">
                    {renderItems ? renderItems(g.items) : g.items.map(renderCard)}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
      {total > 3 && (
        <Pagination
          page={p}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
          pageSizeOptions={[3, 5, 10, 20]}
        />
      )}
    </div>
  );
}

// Companies present among a user's pending items, in first-seen order — drives the company chip
// row (no "All companies" chip; defaults to the first one, skipped entirely when there's just one).
function companiesOf(items: SuspenseSubmission[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const it of items) if (!seen.has(it.company_id)) seen.set(it.company_id, it.company_name);
  return Array.from(seen, ([id, name]) => ({ id, name }));
}

// Buckets a company's items by category, for display in the Approvals panel.
function groupByCategory(items: SuspenseSubmission[]): { category: string; items: SuspenseSubmission[] }[] {
  const grouped = new Map<string, SuspenseSubmission[]>();
  for (const it of items) {
    const key = it.category || '—';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(it);
  }
  return Array.from(grouped, ([category, its]) => ({ category, items: its })).sort((a, b) => (a.category ?? '').localeCompare(b.category ?? ''));
}

// One user's expanded pending-expense content: company chips (skipped when there's only one),
// then category clusters within the selected company.
function SubmissionUserItems({ items, actor, onDone, onActed, companies, multiCompany, categories, chamaries }: {
  items: SuspenseSubmission[]; actor: Actor; onDone: () => void | Promise<void>;
  onActed?: (id: string) => void;
  companies: Company[]; multiCompany: boolean; categories: SuspenseCategory[]; chamaries: ChamaryWithPlace[];
}) {
  const comps = companiesOf(items);
  const [companyId, setCompanyId] = useState(comps[0]?.id ?? '');
  const activeCompanyId = comps.some(c => c.id === companyId) ? companyId : (comps[0]?.id ?? '');
  const shown    = comps.length > 1 ? items.filter(it => it.company_id === activeCompanyId) : items;
  const clusters = groupByCategory(shown);
  const chipCls  = (active: boolean) =>
    `inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
      active ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card/60 text-muted-foreground hover:bg-accent'
    }`;

  return (
    <div className="space-y-3">
      {comps.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {comps.map(c => (
            <button key={c.id} type="button" onClick={() => setCompanyId(c.id)} className={chipCls(c.id === activeCompanyId)}>
              <Building2 className="h-3 w-3" /> {c.name} <span className="tabular-nums opacity-70">· {items.filter(it => it.company_id === c.id).length}</span>
            </button>
          ))}
        </div>
      )}
      {clusters.map(cl => (
        <div key={cl.category} className="space-y-2">
          <div className="px-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{cl.category} · {cl.items.length}</div>
          <div className="space-y-2">
            {cl.items.map(it => (
              <PendingSubmissionCard key={it.id} sub={it} actor={actor} onDone={onDone} onActed={onActed} compact
                companies={companies} multiCompany={multiCompany} categories={categories} chamaries={chamaries} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SectionLabel({ text }: { text: string }) {
  return <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{text}</div>;
}

// A credit request shown for INFORMATION only: what it is, who still has to sign it, and what
// happened if it is already decided. No approve/reject here — a request waiting on stage 1 can
// only be moved by that requester's own supervisor (Team Requests), and a decided one is done.
// Either one named person (`text`), or the company's supervisor pool (`names`) — which the row
// shows two of, with the rest one click away.
interface SupervisorLabel { text: string; names: string[]; title?: string }

// Who can still clear a request's category stage, read off the snapshot the request itself
// carries — never the live category, which may have been edited since. Any ONE of them is
// enough, which is what "any of" says; a pool of one just reads as that person's name.
const categoryApproverList = (req: SuspenseRequest): string => {
  const names = (req.category_approvers ?? []).map(a => a.name);
  if (names.length === 0) return 'a category approver';
  if (names.length === 1) return names[0];
  return `any of ${names.join(', ')}`;
};

function RequestStatusRow({ req, currency, supervisorLabel, old, actor, onDone, people, canAddSupervisor }: {
  req: SuspenseRequest; currency: string; supervisorLabel: SupervisorLabel; old?: boolean;
  // Only the waiting-on-supervisor list passes these — a decided request has nothing to add.
  actor?: Actor; onDone?: () => void | Promise<void>; people?: AppUser[]; canAddSupervisor?: boolean;
}) {
  const decided  = req.status !== 'pending';
  const approved = req.status === 'approved';
  // A pool of ten names is a wall of text at a glance and the whole answer when you're chasing
  // someone — so it starts short and opens in place.
  const [allSupervisors, setAllSupervisors] = useState(false);
  const pool   = supervisorLabel.names;
  const capped = pool.length > 2 && !allSupervisors;
  const waitingOn = pool.length === 0
    ? supervisorLabel.text
    : `any of ${(capped ? pool.slice(0, 2) : pool).join(pool.length === 2 ? ' or ' : ', ')}`;

  // Admin escape hatch: hand this one request to someone else as well (see addRequestSupervisor).
  const [adding, setAdding]   = useState(false);
  const [pickEpf, setPickEpf] = useState('');
  const [busy, setBusy]       = useState(false);
  const alreadyOn = new Set([
    req.epf_number,
    ...(req.requester_supervisor_epf ? [req.requester_supervisor_epf] : []),
    ...(req.extra_supervisors ?? []).map(x => x.epf),
  ]);
  const addPerson = async () => {
    const p = (people ?? []).find(u => u.epf_number === pickEpf);
    if (!p || !actor) return;
    setBusy(true);
    try {
      await addRequestSupervisor(req.id, { epf: p.epf_number, name: p.display_name || p.epf_number }, actor);
      toast.success(`${p.display_name || p.epf_number} can now approve this request.`);
      setAdding(false); setPickEpf('');
      await onDone?.();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to add.'); }
    finally { setBusy(false); }
  };
  return (
    <div className={cn(
      'rounded-xl border border-border bg-card/60 p-3',
      old && 'border-dashed bg-muted/20',
    )}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{req.employee_name}</span>
            <span className="text-[11px] text-muted-foreground">· {req.epf_number}</span>
            {old && <Badge variant="secondary">Old</Badge>}
            {decided
              ? <Badge variant={approved ? 'success' : 'destructive'}>{approved ? 'Approved' : 'Rejected'}</Badge>
              : <Badge variant="warning">{requestStage(req) === 'supervisor' ? 'Awaiting supervisor' : 'Awaiting category approver'}</Badge>}
            {req.category_name && <Badge variant="outline" className="gap-1"><Tags className="h-3 w-3" /> {req.category_name}</Badge>}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{req.company_name} · {fmtDateTime(req.created_at)}</div>
          {req.reason && <div className="mt-0.5 text-xs text-foreground/90">{req.reason}</div>}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-bold tabular-nums text-foreground">{formatSuspenseAmount(req.amount, currency)}</div>
          {approved && req.approved_amount !== null && req.approved_amount !== req.amount && (
            <div className="text-[11px] text-muted-foreground">granted {formatSuspenseAmount(req.approved_amount, currency)}</div>
          )}
        </div>
      </div>

      {/* Who has to approve, and whether they have. Stage 1 is the supervisor; stage 2 is
          whoever holds the suspense approval capability. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
        <span title={req.supervisor_status === 'approved' ? undefined : supervisorLabel.title}>
          <span className="font-medium text-foreground">Supervisor:</span>{' '}
          {req.supervisor_status === 'approved'
            ? `approved by ${req.supervisor_approved_by_name ?? (supervisorLabel.text || '—')}`
            : req.needs_supervisor_approval
              ? <>
                  waiting on {waitingOn}
                  {pool.length > 2 && (
                    <>
                      {' '}
                      <button
                        type="button"
                        onClick={() => setAllSupervisors(v => !v)}
                        aria-expanded={allSupervisors}
                        className="font-medium text-primary hover:underline"
                      >
                        {capped ? `+${pool.length - 2} more` : 'show fewer'}
                      </button>
                    </>
                  )}
                </>
              : 'not required'}
        </span>
        {req.needs_category_approval && (
          <span>
            <span className="font-medium text-foreground">Category:</span>{' '}
            {req.category_status === 'approved'
              ? `approved by ${req.category_approved_by_name ?? req.category_approved_by ?? '—'}`
              : `waiting on ${categoryApproverList(req)}`}
          </span>
        )}
        <span>
          <span className="font-medium text-foreground">Approver:</span>{' '}
          {decided
            ? `${approved ? 'approved' : 'rejected'} by ${req.considered_by_name ?? '—'}${req.considered_at ? ` · ${fmtDateTime(req.considered_at)}` : ''}`
            : 'not yet'}
        </span>
        {req.status === 'rejected' && req.reject_reason && (
          <span className="text-destructive">Reason: {req.reject_reason}</span>
        )}
        {canAddSupervisor && !adding && (
          <button type="button" onClick={() => setAdding(true)}
            className="ml-auto font-medium text-primary hover:underline">
            + Add approver
          </button>
        )}
      </div>

      {/* Picking someone here gives them stage-1 sign-off on THIS request only, and tells them
          so — the company's standing supervisor list is untouched. */}
      {canAddSupervisor && adding && (
        <div className="mt-2 flex flex-col gap-2 rounded-lg border border-dashed border-border bg-muted/20 p-2 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <SearchableSelect
              value={pickEpf}
              onChange={setPickEpf}
              options={(people ?? [])
                .filter(u => u.epf_number && !alreadyOn.has(u.epf_number))
                .map(u => ({
                  value: u.epf_number,
                  label: u.display_name || u.epf_number,
                  sublabel: [u.epf_number, u.role].filter(Boolean).join(' · ') || undefined,
                  keywords: `${u.epf_number} ${u.email ?? ''} ${u.role ?? ''}`,
                }))}
              placeholder="Who else may approve this request?"
              emptyLabel="No matching users"
            />
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" disabled={!pickEpf || busy} onClick={addPerson}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setAdding(false); setPickEpf(''); }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// The Approvals tab: Expense Submissions vs Credit Requests as sub-tabs, each grouped by user.
// "Team Requests" is a separate, capability-independent sub-tab — a technician's supervisor
// (personal or company) needs to sign off there before a request even reaches the other tabs
// (see getPendingSupervisorRequests/approveSupervisorStage in suspenseService.ts); someone who
// is ONLY a supervisor (no can_approve_suspense) never sees the other three tabs at all.
function ApprovalsPanel({ pendSubs, pendReqs, pendCloses, pendingSupervisorReqs, pendingCategoryReqs, waitingSupervisorReqs, waitingCategoryReqs, decidedReqs, employees, accounts, canApprove, actor, currency, onDone, onSubActed, companies, multiCompany, categories, chamaries }: {
  pendSubs: SuspenseSubmission[]; pendReqs: SuspenseRequest[]; pendCloses: SuspenseCloseRequest[];
  pendingSupervisorReqs: SuspenseRequest[];
  // Requests waiting on THIS user as one of their category's named approvers (stage 2) — its own
  // sub-tab for the same reason Team Requests is: being a category approver is independent of
  // holding can_approve_suspense, so someone may see only this one.
  pendingCategoryReqs: SuspenseRequest[];
  // Read-only context for the Credit Requests tab: what stages 1 and 2 still hold, and what has
  // already been decided. None of it is actionable here — it exists so an approver can SEE the
  // whole picture rather than only their own slice of it.
  waitingSupervisorReqs: SuspenseRequest[]; waitingCategoryReqs: SuspenseRequest[];
  decidedReqs: SuspenseRequest[]; employees: AppUser[];
  // Every suspense account, so a credit decision can be read against the balance it lands on —
  // the float limit is a ceiling on the RESULTING balance, not on the amount being granted.
  accounts: SuspenseAccount[];
  canApprove: boolean;
  actor: Actor; currency: string; onDone: () => void | Promise<void>;
  /** Called the instant a submission is approved or rejected, with its id — the page drops it
   *  from the queue straight away and debounces the authoritative refetch (see scheduleRefresh).
   *  Without this every approval re-downloaded all 232 pending bills before the button came back. */
  onSubActed?: (id: string) => void;
  companies: Company[]; multiCompany: boolean; categories: SuspenseCategory[]; chamaries: ChamaryWithPlace[];
}) {
  const [sub, setSub] = useState(canApprove
    ? (pendSubs.length > 0 ? 'submissions' : pendReqs.length > 0 ? 'requests' : pendCloses.length > 0 ? 'close'
      : pendingSupervisorReqs.length > 0 ? 'team' : 'category')
    : pendingSupervisorReqs.length > 0 ? 'team' : 'category');
  const [closeSearch, setCloseSearch] = useState('');
  // Date filter + sort for the submissions queue. Defaults to the bill date, newest first —
  // what an approver reads by — with "Submitted date" one control away for "what came in today".
  const [subDateField, setSubDateField] = useState<BillDateField>('bill');
  const [subDateRange, setSubDateRange] = useState<BillDateRange>({});
  const [subSortDir, setSubSortDir]     = useState<SortDir>('desc');
  const shownPendSubs = useMemo(
    () => sortBillsByDate(filterBillsByDate(pendSubs, subDateField, subDateRange), subDateField, subSortDir),
    [pendSubs, subDateField, subDateRange, subSortDir],
  );
  // How many decided requests to show before "Show all" — an approver wants the last few, not
  // the whole history, which the Vouchers/Reports tabs already cover properly.
  const [showAllOld, setShowAllOld] = useState(false);
  // History is context, not work — it stays folded away until someone asks for it.
  const [oldOpen, setOldOpen] = useState(false);
  const OLD_PREVIEW = 8;

  // EPF → real person's name. Only users that actually resolve go in; an EPF that matches
  // nobody must never be printed as if it were a name.
  const nameByEpf = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of employees) {
      const name = (u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ')).trim();
      if (u.epf_number && name) m.set(u.epf_number, name);
    }
    return m;
  }, [employees]);

  /**
   * Who has to sign a request off at stage 1.
   *
   * Prefers the requester's OWN supervisor, snapshotted onto the request at creation — that is
   * one person, and the right answer. Only when there is none does it fall back to the
   * company's supervisor list, which is a pool, not an assignment.
   *
   * That pool is entered by hand on the Companies page and reliably contains stale or mistyped
   * rows ("123", "4654656") alongside EPFs of people who have since left. Anything that doesn't
   * resolve to a real user is dropped rather than printed, and the rest is capped at two names
   * plus a count — a ten-name run-on told an approver nothing about who to chase.
   */
  const supervisorLabel = (r: SuspenseRequest): SupervisorLabel => {
    if (r.requester_supervisor_epf) {
      const name = nameByEpf.get(r.requester_supervisor_epf);
      return name
        ? { text: name, names: [] }
        : { text: 'their supervisor (no longer a user)', names: [], title: r.requester_supervisor_epf };
    }
    const names = (companies.find(c => c.id === r.company_id)?.supervisor_epfs ?? [])
      .map(e => nameByEpf.get(e))
      .filter((n): n is string => !!n);
    return names.length === 0
      ? { text: 'any company supervisor', names: [] }
      : { text: '', names };
  };
  // Everyone who can sign a request off, including anyone an admin added to it by hand.
  const supervisorInfo = (r: SuspenseRequest): SupervisorLabel => {
    const base   = supervisorLabel(r);
    const extras = (r.extra_supervisors ?? []).map(x => `${x.name} (added)`);
    if (extras.length === 0) return base;
    return base.names.length > 0
      ? { ...base, names: [...base.names, ...extras] }
      : { text: '', names: [...(base.text && base.text !== 'any company supervisor' ? [base.text] : []), ...extras] };
  };
  const closeQ = closeSearch.trim().toLowerCase();
  const shownCloses = closeQ
    ? pendCloses.filter(c => c.requested_by_name.toLowerCase().includes(closeQ) || c.requested_by.toLowerCase().includes(closeQ))
    : pendCloses;
  return (
    <Tabs value={sub} onValueChange={setSub}>
      <TabsList className="mb-4 h-auto flex-wrap">
        {canApprove && <TabsTrigger value="submissions">Expense Submissions ({pendSubs.length})</TabsTrigger>}
        {canApprove && <TabsTrigger value="requests">Credit Requests ({pendReqs.length})</TabsTrigger>}
        {canApprove && <TabsTrigger value="close">Close Requests ({pendCloses.length})</TabsTrigger>}
        {pendingSupervisorReqs.length > 0 && <TabsTrigger value="team">Team Requests ({pendingSupervisorReqs.length})</TabsTrigger>}
        {pendingCategoryReqs.length > 0 && <TabsTrigger value="category">Category Approvals ({pendingCategoryReqs.length})</TabsTrigger>}
      </TabsList>

      {canApprove && (
      <TabsContent value="submissions">
        {pendSubs.length === 0 ? (
          <EmptyState icon={Receipt} title="No pending expenses" description="Expense submissions awaiting your approval will appear here." />
        ) : (
          <>
          <BillDateFilterBar
            field={subDateField} setField={setSubDateField}
            range={subDateRange} setRange={setSubDateRange}
            dir={subSortDir} setDir={setSubSortDir}
            shown={shownPendSubs.length} total={pendSubs.length}
          />
          {shownPendSubs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No bills in that date range. <button type="button" onClick={() => setSubDateRange({})} className="font-medium text-primary underline underline-offset-2">Clear the filter</button>
            </p>
          ) : (
          <PaginatedUserGroups
            items={shownPendSubs} sign="−" currency={currency}
            renderCard={(it) => <PendingSubmissionCard key={it.id} sub={it} actor={actor} onDone={onDone} onActed={onSubActed} compact companies={companies} multiCompany={multiCompany} categories={categories} chamaries={chamaries} />}
            renderItems={(items) => (
              <SubmissionUserItems items={items} actor={actor} onDone={onDone} onActed={onSubActed}
                companies={companies} multiCompany={multiCompany} categories={categories} chamaries={chamaries} />
            )}
          />
          )}
          </>
        )}
      </TabsContent>
      )}

      {canApprove && (
      <TabsContent value="requests">
        <div className="space-y-6">
          {/* 1. What this approver can act on right now. */}
          <div>
            <SectionLabel text={`Ready for you (${pendReqs.length})`} />
            {pendReqs.length === 0 ? (
              <EmptyState icon={TrendingUp} title="No pending requests" description="Credit requests awaiting your approval will appear here." />
            ) : (
              <PaginatedUserGroups
                items={pendReqs} sign="+" currency={currency}
                renderCard={(it) => (
                  /* `accounts` loads alongside this queue for approvers, so "no row" genuinely
                     means "no account yet" — a balance of zero, which is exactly what
                     approveRequest would open the account at. */
                  <PendingRequestCard key={it.id} req={it} actor={actor} onDone={onDone} compact currency={currency}
                    currentBalance={accounts.find(a => a.epf_number === it.epf_number && a.company_id === it.company_id)?.balance ?? 0} />
                )}
              />
            )}
          </div>

          {/* 2. Technicians' requests stage 1 has not cleared. Visible, named, not actionable
                 here — only that requester's own supervisor can move them along. */}
          {waitingSupervisorReqs.length > 0 && (
            <div>
              <SectionLabel text={`Waiting on a supervisor (${waitingSupervisorReqs.length})`} />
              <div className="space-y-2">
                {waitingSupervisorReqs.map(r => (
                  <RequestStatusRow key={r.id} req={r} currency={currency} supervisorLabel={supervisorInfo(r)}
                    actor={actor} onDone={onDone} people={employees} canAddSupervisor />
                ))}
              </div>
            </div>
          )}

          {/* 2b. Stage 1 done (or never needed), but the request's category names people who
                  still have to sign it. Same read-only treatment: visible, named, not actionable
                  here — only those approvers can move it on, in Category Approvals. */}
          {waitingCategoryReqs.length > 0 && (
            <div>
              <SectionLabel text={`Waiting on a category approver (${waitingCategoryReqs.length})`} />
              <div className="space-y-2">
                {waitingCategoryReqs.map(r => (
                  <RequestStatusRow key={r.id} req={r} currency={currency} supervisorLabel={supervisorInfo(r)} />
                ))}
              </div>
            </div>
          )}

          {/* 3. Already decided — kept on screen as history, marked Old. */}
          {decidedReqs.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setOldOpen(v => !v)}
                aria-expanded={oldOpen}
                className="flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', oldOpen && 'rotate-180')} />
                Old — already decided ({decidedReqs.length})
              </button>
              {oldOpen && (
                <div className="mt-2">
                  <div className="space-y-2">
                    {(showAllOld ? decidedReqs : decidedReqs.slice(0, OLD_PREVIEW)).map(r => (
                      <RequestStatusRow key={r.id} req={r} currency={currency} supervisorLabel={supervisorInfo(r)} old />
                    ))}
                  </div>
                  {decidedReqs.length > OLD_PREVIEW && (
                    <button type="button" onClick={() => setShowAllOld(v => !v)}
                      className="mt-2 text-xs font-medium text-primary hover:underline">
                      {showAllOld ? 'Show fewer' : `Show all ${decidedReqs.length}`}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </TabsContent>
      )}

      {canApprove && (
      <TabsContent value="close">
        {pendCloses.length === 0 ? (
          <EmptyState icon={Lock} title="No close requests" description="Account close/clear requests awaiting your approval will appear here." />
        ) : (
          <div className="space-y-2.5">
            {pendCloses.length > 1 && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={closeSearch}
                  onChange={(e) => setCloseSearch(e.target.value)}
                  placeholder="Search by name or EPF…"
                  className="pl-9"
                />
              </div>
            )}
            {shownCloses.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No one matches “{closeSearch.trim()}”.</p>
            ) : shownCloses.map((c) => <PendingCloseCard key={c.id} close={c} actor={actor} onDone={onDone} />)}
          </div>
        )}
      </TabsContent>
      )}

      {pendingSupervisorReqs.length > 0 && (
      <TabsContent value="team">
        <PaginatedUserGroups
          items={pendingSupervisorReqs} sign="+" currency={currency}
          renderCard={(it) => <PendingSupervisorRequestCard key={it.id} req={it} actor={actor} onDone={onDone} compact />}
        />
      </TabsContent>
      )}

      {pendingCategoryReqs.length > 0 && (
      <TabsContent value="category">
        <p className="mb-3 text-xs text-muted-foreground">
          You are named as an approver for these requests’ categories. Approving forwards the request, at the amount asked,
          to the suspense approvers — they decide how much is actually released.
        </p>
        <PaginatedUserGroups
          items={pendingCategoryReqs} sign="+" currency={currency}
          renderCard={(it) => <PendingCategoryRequestCard key={it.id} req={it} actor={actor} onDone={onDone} compact />}
        />
      </TabsContent>
      )}
    </Tabs>
  );
}

// ─── Approver: open an account for a user ───────────────────────────────────────
// Opens a user's OWN-company suspense account straight from the Accounts tab (the same
// action available in Users management). Other-company accounts still auto-open when an
// expense/credit for that company is approved. Users who already hold their own-company
// account are filtered out of the picker.
// The bulk modes open that SAME own-company account for a whole employee type, or for a
// hand-picked set, by looping the single-account call — one account-opening path, not two.
type OpenAccountMode = 'one' | 'type' | 'role' | 'pick';

const EMPLOYEE_TYPES: AppUser['employee_type'][] = ['Permanent', 'Contract', 'Trainee', 'Intern'];

// How many accounts a bulk run opens at once. Each one is a read plus two writes, and a run can
// cover most of a 300+ user roster, so they go out in small waves rather than all at once.
const BULK_WAVE = 5;

function OpenAccountDialog({ open, onOpenChange, accounts, actor, onCreated }: {
  open: boolean; onOpenChange: (v: boolean) => void;
  accounts: SuspenseAccount[]; actor: Actor; onCreated: () => void;
}) {
  const [users, setUsers]           = useState<AppUser[]>([]);
  const [loadingUsers, setLoading]  = useState(false);
  const [loadErr, setLoadErr]       = useState(false);
  const [epf, setEpf]               = useState('');
  const [busy, setBusy]             = useState(false);
  const [mode, setMode]             = useState<OpenAccountMode>('one');
  const [types, setTypes]           = useState<Set<AppUser['employee_type']>>(new Set());
  const [roleNames, setRoleNames]   = useState<Set<string>>(new Set());   // role names, for mode 'role'
  const [picked, setPicked]         = useState<Set<string>>(new Set());   // epf numbers
  const [search, setSearch]         = useState('');
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [progress, setProgress]     = useState<{ done: number; total: number } | null>(null);
  // Per-person failures from the last bulk run — kept on screen (the dialog stays open) so the
  // approver can see exactly who didn't get an account and retry just those.
  const [failures, setFailures]     = useState<{ name: string; message: string }[]>([]);

  const loadUsers = useCallback(() => {
    setLoading(true); setLoadErr(false);
    getAllEmployees().then(setUsers).catch(() => setLoadErr(true)).finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (open) loadUsers(); }, [open, loadUsers]);

  const existing   = new Set(accounts.map(a => `${a.epf_number}__${a.company_id}`));
  const hasAcct    = (u: AppUser) => existing.has(`${u.epf_number}__${u.company_id}`);
  const candidates = users.filter(u => !hasAcct(u));
  const selected   = users.find(u => u.epf_number === epf) ?? null;

  const clearPicks = () => { setEpf(''); setTypes(new Set()); setRoleNames(new Set()); setPicked(new Set()); setSearch(''); setFailures([]); setConfirmBulk(false); };
  const toggleType = (t: AppUser['employee_type'], on: boolean) =>
    setTypes(prev => { const n = new Set(prev); if (on) n.add(t); else n.delete(t); return n; });
  const toggleRole = (r: string, on: boolean) =>
    setRoleNames(prev => { const n = new Set(prev); if (on) n.add(r); else n.delete(r); return n; });

  // Roles are read off the roster itself rather than the roles registry, so the list is exactly
  // the roles people actually hold — every one of them, including any added since this dialog
  // was written ("or any other") — and the counts beside them can never disagree with it.
  const roleOf = (u: AppUser) => String(u.role ?? '').trim();
  const roleOptions = Array.from(new Set(users.map(roleOf).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));
  // Shares the `search` box with the user picker — both are cleared together on close, and only
  // one of the two is ever on screen at a time.
  const visibleRoles = (() => {
    const rq = search.trim().toLowerCase();
    return rq ? roleOptions.filter(r => r.toLowerCase().includes(rq)) : roleOptions;
  })();
  const togglePick = (e: string, on: boolean) =>
    setPicked(prev => { const n = new Set(prev); if (on) n.add(e); else n.delete(e); return n; });

  // Everyone the current bulk selection covers INCLUDING people who already hold their
  // own-company account — those are reported as skipped, never attempted (createSuspenseAccount
  // refuses to clobber an existing one, so attempting them would just be noise).
  const matched = mode === 'type' ? users.filter(u => types.has(u.employee_type))
                : mode === 'role' ? users.filter(u => roleNames.has(roleOf(u)))
                : mode === 'pick' ? users.filter(u => picked.has(u.epf_number))
                : [];
  const targets = matched.filter(u => !hasAcct(u));
  const skipped = matched.filter(hasAcct);

  const q      = search.trim().toLowerCase();
  const roster = q ? candidates.filter(u => u.display_name.toLowerCase().includes(q) || u.epf_number.includes(q)) : candidates;

  const modeCls = (active: boolean) =>
    `inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
      active ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card/60 text-muted-foreground hover:bg-accent'
    }`;

  // Bulk run: the same createSuspenseAccount as the single path, one person at a time in small
  // waves. A failure for one person is collected and the run carries on — a whole batch must
  // never be lost to one bad record.
  const createBulk = async () => {
    if (!actor.epf) { toast.error('Could not identify you as the creator — reload and retry.'); return; }
    if (targets.length === 0) return;
    setBusy(true); setFailures([]); setProgress({ done: 0, total: targets.length });
    const failed: { name: string; message: string }[] = [];
    let created = 0;
    for (let i = 0; i < targets.length; i += BULK_WAVE) {
      const wave = targets.slice(i, i + BULK_WAVE);
      await Promise.all(wave.map(async (u) => {
        try {
          await createSuspenseAccount({
            epf_number: u.epf_number, employee_name: u.display_name,
            company_id: u.company_id, company_name: u.company_name,
          }, actor);
          created++;
        } catch (e) { failed.push({ name: `${u.display_name} · ${u.epf_number}`, message: errMsg(e, 'Failed to open account.') }); }
      }));
      setProgress({ done: i + wave.length, total: targets.length });
    }
    setProgress(null); setBusy(false); setFailures(failed);
    const summary = `${created} created, ${skipped.length} skipped, ${failed.length} failed.`;
    if (failed.length > 0) toast.error(summary); else toast.success(summary);
    onCreated();
    if (failed.length === 0) { onOpenChange(false); clearPicks(); }
  };

  const create = async () => {
    if (!selected) { toast.error('Select a user.'); return; }
    if (!actor.epf) { toast.error('Could not identify you as the creator — reload and retry.'); return; }
    setBusy(true);
    try {
      await createSuspenseAccount({
        epf_number: selected.epf_number, employee_name: selected.display_name,
        company_id: selected.company_id, company_name: selected.company_name,
      }, actor);
      toast.success(`Suspense account opened for ${selected.display_name}.`);
      onOpenChange(false); setEpf(''); onCreated();
    } catch (e) { toast.error(errMsg(e, 'Failed to open account.')); }
    finally { setBusy(false); }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (busy) return; onOpenChange(v); if (!v) clearPicks(); }}>
        <DialogContent className="max-h-[92vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Open suspense account</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {([['one', 'One user'], ['type', 'By employee type'], ['role', 'By role'], ['pick', 'Pick users']] as const).map(([m, label]) => (
                <button key={m} type="button" disabled={busy} onClick={() => setMode(m)} className={modeCls(mode === m)}>{label}</button>
              ))}
            </div>

            {loadingUsers ? (
              <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading users…</div>
            ) : loadErr ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <span>Couldn’t load users.</span>
                <Button size="sm" variant="outline" onClick={loadUsers}>Retry</Button>
              </div>
            ) : mode === 'one' ? (
              <div>
                <Label className="mb-1.5 block flex items-center gap-1 text-xs font-semibold text-muted-foreground"><UsersIcon className="h-3.5 w-3.5" /> User <span className="text-destructive">*</span></Label>
                {candidates.length === 0 ? (
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    Every active user already has their own-company account.
                  </div>
                ) : (
                  <Combobox
                    value={epf} onChange={setEpf} allowCustom={false} placeholder="Search a user by name or EPF"
                    options={candidates.map(u => ({ value: u.epf_number, label: `${u.display_name} · ${u.epf_number}` }))}
                  />
                )}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Opens the {selected ? selected.company_name : 'user’s own-company'} account. Others auto-open when an expense or credit for that company is approved.
                </p>
              </div>
            ) : mode === 'type' ? (
              <div>
                <Label className="mb-1.5 block flex items-center gap-1 text-xs font-semibold text-muted-foreground"><UsersIcon className="h-3.5 w-3.5" /> Employee types <span className="text-destructive">*</span></Label>
                <div className="grid grid-cols-2 gap-2">
                  {EMPLOYEE_TYPES.map(t => (
                    <label key={t} className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent">
                      <Checkbox checked={types.has(t)} disabled={busy} onCheckedChange={(v) => toggleType(t, v === true)} />
                      {t}
                      <span className="ml-auto text-[11px] font-normal tabular-nums text-muted-foreground">{users.filter(u => u.employee_type === t).length}</span>
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">Opens each person’s own-company account. Anyone who already has one is skipped.</p>
              </div>
            ) : mode === 'role' ? (
              <div>
                <Label className="mb-1.5 block flex items-center gap-1 text-xs font-semibold text-muted-foreground"><UsersIcon className="h-3.5 w-3.5" /> Roles <span className="text-destructive">*</span></Label>
                {roleOptions.length === 0 ? (
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    No roles found on the current roster.
                  </div>
                ) : (
                  <>
                    {/* The role list is open-ended, so it needs the same search the user picker
                        has. Filtering never hides an already-ticked role — the selection lives in
                        roleNames and the preview below always lists every matched person. */}
                    <div className="relative mb-2">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search roles…" className="pl-9" />
                    </div>
                    {visibleRoles.length === 0 ? (
                      <p className="px-1 py-2 text-xs text-muted-foreground">No roles match your search.</p>
                    ) : (
                  /* Scrolls: unlike the four fixed employee types, the role list is open-ended. */
                  <div className="grid max-h-56 grid-cols-2 gap-2 overflow-y-auto pr-1 scrollbar-thin">
                    {visibleRoles.map(r => (
                      <label key={r} className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent">
                        <Checkbox checked={roleNames.has(r)} disabled={busy} onCheckedChange={(v) => toggleRole(r, v === true)} />
                        <span className="min-w-0 truncate">{r}</span>
                        <span className="ml-auto shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">{users.filter(u => roleOf(u) === r).length}</span>
                      </label>
                    ))}
                  </div>
                    )}
                  </>
                )}
                <p className="mt-1 text-[11px] text-muted-foreground">Opens each person’s own-company account. Anyone who already has one is skipped.</p>
              </div>
            ) : (
              <div>
                <Label className="mb-1.5 block flex items-center gap-1 text-xs font-semibold text-muted-foreground"><UsersIcon className="h-3.5 w-3.5" /> Users <span className="text-destructive">*</span></Label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or EPF…" className="pl-9" />
                </div>
                <div className="mt-2 max-h-56 space-y-0.5 overflow-y-auto pr-1 scrollbar-thin">
                  {roster.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">
                      {candidates.length === 0 ? 'Every active user already has their own-company account.' : 'No users match your search.'}
                    </p>
                  ) : roster.map(u => (
                    <label key={u.epf_number} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent">
                      <Checkbox checked={picked.has(u.epf_number)} disabled={busy} onCheckedChange={(v) => togglePick(u.epf_number, v === true)} />
                      <span className="min-w-0 flex-1 truncate text-foreground">{u.display_name}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{u.epf_number} · {u.employee_type}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {mode === 'one' && selected && (
              <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
                <Building2 className="h-3.5 w-3.5 shrink-0" /> {selected.company_name}
              </div>
            )}

            {/* Exactly who a bulk run will affect, before anything is written. */}
            {mode !== 'one' && !loadingUsers && !loadErr && (
              <div className="rounded-lg border border-border bg-muted/30 p-2.5 text-xs">
                {matched.length === 0 ? (
                  <span className="text-muted-foreground">{
                    mode === 'type' ? 'Pick one or more employee types.'
                    : mode === 'role' ? 'Pick one or more roles.'
                    : 'Pick the users to open accounts for.'
                  }</span>
                ) : (
                  <>
                    <div className="font-medium text-foreground">
                      {targets.length} account{targets.length === 1 ? '' : 's'} to open
                      {skipped.length > 0 && <span className="font-normal text-muted-foreground"> · {skipped.length} skipped (already have one)</span>}
                    </div>
                    {targets.length > 0 && (
                      <div className="mt-1.5 max-h-32 space-y-0.5 overflow-y-auto pr-1 scrollbar-thin">
                        {targets.map(u => (
                          <div key={u.epf_number} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <UserPlus className="h-3 w-3 shrink-0" />
                            <span className="truncate">{u.display_name} · {u.epf_number}</span>
                            <span className="shrink-0 opacity-70">· {u.company_name}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {progress && <p className="text-[11px] text-muted-foreground">Opening accounts… {progress.done} of {progress.total}</p>}

            {failures.length > 0 && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
                <div className="font-medium">{failures.length} account{failures.length === 1 ? '' : 's'} couldn’t be opened</div>
                <div className="mt-1 max-h-24 space-y-0.5 overflow-y-auto pr-1 scrollbar-thin">
                  {failures.map(f => <div key={f.name} className="truncate">{f.name} — {f.message}</div>)}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
            {mode === 'one' ? (
              <Button disabled={busy || !selected} onClick={create}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><UserPlus className="h-4 w-4" /> Open account</>}</Button>
            ) : (
              <Button disabled={busy || targets.length === 0} onClick={() => setConfirmBulk(true)}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><UserPlus className="h-4 w-4" /> Open {targets.length} account{targets.length === 1 ? '' : 's'}</>}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmModal
        open={confirmBulk}
        onOpenChange={() => setConfirmBulk(false)}
        variant="warning"
        title={`Open ${targets.length} suspense account${targets.length === 1 ? '' : 's'}?`}
        description={`Each person gets their own-company account with a zero balance.${skipped.length > 0 ? ` ${skipped.length} already have one and will be skipped.` : ''}`}
        confirmText="Open accounts"
        busy={busy}
        onConfirm={async () => { setConfirmBulk(false); await createBulk(); }}
      />
    </>
  );
}

// ─── Approver: allocate credit (top-up) / debit an account ──────────────────────
// `siblingAccounts` is this employee's EXISTING company accounts; `companies` is every company
// in the org — the picker offers all of them, so the approver can open + credit a company this
// employee doesn't have an account for yet in one step, not just switch between existing ones.
function AllocateCreditDialog({ open, onOpenChange, account, siblingAccounts, companies, actor, onSaved }: {
  open: boolean; onOpenChange: (v: boolean) => void;
  account: SuspenseAccount | null; siblingAccounts: SuspenseAccount[]; companies: Company[]; actor: Actor; onSaved: () => void;
}) {
  const [amount, setAmount]       = useState('');
  const [note, setNote]           = useState('');
  const [companyId, setCompanyId] = useState('');
  const [busy, setBusy]           = useState(false);
  // Float limit for the account being credited. Debits never trigger it — a limit is a ceiling,
  // and taking money back can only move the balance away from it.
  const [override, setOverride]             = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  useEffect(() => { if (open) { setAmount(''); setNote(''); setCompanyId(account?.company_id ?? ''); setOverride(false); setOverrideReason(''); } }, [open, account]);

  const existing    = siblingAccounts.find(a => a.company_id === companyId);
  const companyName = companies.find(c => c.id === companyId)?.name ?? existing?.company_name ?? '';
  const currency     = existing?.currency ?? account?.currency ?? 'LKR';
  const delta         = parseFloat(amount);
  const balanceBefore = existing?.balance ?? 0;
  const preview        = !isNaN(delta) && delta !== 0 ? balanceBefore + delta : null;

  const resolved = useResolvedLimit(open ? account?.epf_number : null, open ? companyId : null);
  const check    = checkAgainstLimit(!isNaN(delta) && delta > 0 ? resolved?.limit ?? null : null, balanceBefore + (isNaN(delta) ? 0 : delta));
  const overrideMissing = check.over && (!override || !overrideReason.trim());

  const apply = async () => {
    if (!account || !companyId) return;
    if (isNaN(delta) || delta === 0) { toast.error('Enter a non-zero amount (prefix “-” to debit).'); return; }
    if (!existing && delta < 0) { toast.error('This company has no account yet — enter a positive amount to open it.'); return; }
    if (overrideMissing) { toast.error('Tick “Override the limit” and give a reason, or allocate less.'); return; }
    setBusy(true);
    try {
      await adjustSuspenseAccount({
        epf: account.epf_number, companyId, employeeName: account.employee_name, companyName,
        delta, note: note.trim(), actor, overrideLimit: check.over ? overrideReason.trim() : undefined,
      });
      toast.success(existing ? (delta > 0 ? 'Credit allocated.' : 'Balance debited.') : 'Account opened and credited.');
      onOpenChange(false); onSaved();
    } catch (e) { toast.error(errMsg(e, 'Failed to adjust balance.')); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Allocate credit</DialogTitle></DialogHeader>
        {account && (
          <div className="space-y-3">
            <div>
              <Label className="mb-1.5 block text-xs font-semibold text-muted-foreground flex items-center gap-1"><Building2 className="h-3.5 w-3.5" /> Company</Label>
              <Select value={companyId} onChange={setCompanyId}
                options={companies.map(c => ({ value: c.id, label: siblingAccounts.some(a => a.company_id === c.id) ? c.name : `${c.name} (open new account)` }))} />
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5" /> {account.employee_name} · {companyName}</div>
              <div className="mt-1">
                Current balance{' '}
                <span className="font-semibold text-foreground">{existing ? formatSuspenseAmount(existing.balance, currency) : 'No account yet'}</span>
              </div>
            </div>
            <div>
              <Label className="mb-1.5 block text-xs font-semibold text-muted-foreground">Amount <span className="text-destructive">*</span></Label>
              <Input type="number" inputMode="decimal" step="0.01" autoFocus value={amount}
                onChange={e => setAmount(e.target.value)} placeholder="e.g. 5000 (or -2000 to debit)" />
              {preview != null && (
                <p className="mt-1 text-[11px] text-muted-foreground">New balance: <span className={`font-semibold ${preview < 0 ? 'text-destructive' : 'text-foreground'}`}>{formatSuspenseAmount(preview, currency)}</span></p>
              )}
              <LimitHeadroomLine className="mt-1" resolved={resolved} balance={balanceBefore} currency={currency} />
              {check.over && (
                <LimitOverridePanel
                  name={account.employee_name} resolved={resolved} currency={currency}
                  balanceAfter={balanceBefore + delta} excess={check.excess}
                  checked={override} onCheckedChange={setOverride}
                  reason={overrideReason} onReasonChange={setOverrideReason}
                  disabled={busy}
                />
              )}
            </div>
            <div>
              <Label className="mb-1.5 block text-xs font-semibold text-muted-foreground">Note</Label>
              <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Reason for the adjustment" />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || overrideMissing} onClick={apply}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plus className="h-4 w-4" /> Allocate</>}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────────
// Anchor for the header's "New expense" button to scroll the submit form into view.
const SUBMIT_FORM_ID = 'suspense-submit-form';

export default function SuspensePage() {
  const user = useAuthStore(s => s.user);
  const caps = useUserCapabilities();
  const { roles } = useRoles();
  const { accounts: myAccounts, hasAccount, loaded, reload } = useSuspenseAccess();
  // Feature-gate the approver role too: on a tenant without suspense, even a system admin
  // (whose caps auto-grant approval) must not trigger the org-wide pending/account scans.
  const featureOn  = tenant.features.suspense;
  const canApprove = featureOn && caps.can_approve_suspense;
  // Executive & top-management staff can spend across companies; technicians are single-company.
  const multiCompany = ['executive', 'top_management'].includes(roleCategory(user?.role, roles));

  const epf  = user?.epf_number ?? '';
  const actor: Actor = { epf, name: user?.name ?? '' };
  const ctx = { epf, name: user?.name ?? '', companyId: user?.company_id ?? '', companyName: user?.company ?? '' };

  const [tab, setTab]   = useState('');
  const [loading, setLoading] = useState(true);

  const [mySubs, setMySubs]     = useState<SuspenseSubmission[]>([]);
  const [myReqs, setMyReqs]     = useState<SuspenseRequest[]>([]);
  const [pendSubs, setPendSubs] = useState<SuspenseSubmission[]>([]);
  // Every credit request an approver may SEE — pending (including the technician ones still
  // waiting on their supervisor) plus recently decided ones. The actionable subset is derived
  // below; the rest is shown read-only so nothing silently disappears from the tab.
  const [allReqs, setAllReqs] = useState<SuspenseRequest[]>([]);
  // EPF → display name, for naming the supervisor a request is waiting on.
  const [employees, setEmployees] = useState<AppUser[]>([]);
  // Technicians' credit requests awaiting THIS user's sign-off as their supervisor (personal or
  // company) — fetched for anyone signed in, independent of hasAccount/canApprove, since any
  // employee could be someone's supervisor. See getPendingSupervisorRequests in suspenseService.ts.
  const [pendingSupervisorReqs, setPendingSupervisorReqs] = useState<SuspenseRequest[]>([]);
  // Credit requests waiting on THIS user as one of their category's named approvers (stage 2).
  // Fetched for anyone signed in, for the same reason as the supervisor queue above: being named
  // on a category is independent of every suspense capability.
  const [pendingCategoryReqs, setPendingCategoryReqs] = useState<SuspenseRequest[]>([]);
  const [accounts, setAccounts] = useState<SuspenseAccount[]>([]);
  const [myCloses, setMyCloses]     = useState<SuspenseCloseRequest[]>([]);
  // The holder's own ledger. Their "Credit received" and the unexplained-movement rows in the
  // feed both read from this — money reaches a float by routes that never create a request.
  const [myLedger, setMyLedger]     = useState<SuspenseLedgerEntry[]>([]);
  const [pendCloses, setPendCloses] = useState<SuspenseCloseRequest[]>([]);
  const [companies, setCompanies]   = useState<Company[]>([]);
  const [categories, setCategories] = useState<SuspenseCategory[]>([]);
  const [chamaries, setChamaries]   = useState<ChamaryWithPlace[]>([]);

  const [expenseDialog, setExpenseDialog] = useState<{ open: boolean; editing: SuspenseSubmission | null }>({ open: false, editing: null });
  const [requestDialog, setRequestDialog] = useState<{ open: boolean; editing: SuspenseRequest | null; company: { id: string; name: string } | null }>({ open: false, editing: null, company: null });
  const [closeDialog, setCloseDialog]     = useState<{ open: boolean; account: SuspenseAccount | null }>({ open: false, account: null });
  const [creditDialog, setCreditDialog]   = useState<{ open: boolean; account: SuspenseAccount | null }>({ open: false, account: null });
  const [openAcctDialog, setOpenAcctDialog] = useState(false);
  // Bumped on every refreshAll so the Ledger tab re-fetches its month quietly, and a flag
  // for the header's Refresh button so the icon spins while the round-trip is in flight.
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // `silent` skips the loading flag — used after a single approve/reject/save so the list
  // re-fetches in the background and swaps in via normal React reconciliation (the acted-on row
  // just disappears/updates in place) instead of unmounting the whole panel behind a spinner,
  // which was collapsing every OTHER row's expanded state, pagination, and company-chip
  // selection on every single action. The spinner still shows on the real initial load.
  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const tasks: Promise<unknown>[] = [];
      if (epf) tasks.push(getPendingSupervisorRequests(epf).then(setPendingSupervisorReqs));
      if (epf) tasks.push(getPendingCategoryRequests(epf).then(setPendingCategoryReqs));
      if (hasAccount && epf) {
        tasks.push(getMySubmissions(epf).then(setMySubs));
        tasks.push(getMyRequests(epf).then(setMyReqs));
        tasks.push(getMyCloseRequests(epf).then(setMyCloses));
        tasks.push(getLedger(epf).then(setMyLedger));
      }
      if (canApprove) {
        tasks.push(getPendingSubmissions().then(setPendSubs));
        tasks.push(getAllRequestsForApprovals().then(setAllReqs));
        tasks.push(getPendingCloseRequests().then(setPendCloses));
        tasks.push(listSuspenseAccounts().then(setAccounts));
      }
      await Promise.all(tasks);
    } finally { if (!opts?.silent) setLoading(false); }
  }, [hasAccount, epf, canApprove]);

  // NOTE: React still runs effects when the render below early-returns for a feature-off tenant,
  // so every data-loading effect must gate on featureOn itself — no reads on other tenants.
  useEffect(() => { if (featureOn) load(); }, [featureOn, load]);
  // Refresh the (possibly approver-updated) balances whenever the holder opens the page.
  useEffect(() => { if (featureOn && epf) reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [epf]);
  // Names for the supervisor line on requests still in stage 1. getAllUsers, NOT
  // getAllEmployees: a supervisor is usually a manager or admin, and getAllEmployees keeps only
  // is_employee roles — which is exactly why half of those EPFs had no name to show.
  useEffect(() => { if (featureOn && canApprove) getAllUsers().then(setEmployees).catch(() => {}); }, [featureOn, canApprove]);

  // Company list for the multi-company expense/request selectors.
  useEffect(() => { if (featureOn) getCompanies().then(setCompanies).catch(() => {}); }, [featureOn]);
  // Expense taxonomy for the submit/edit forms.
  const loadCategories = useCallback(() => { if (featureOn) listSuspenseCategories().then(setCategories).catch(() => {}); }, [featureOn]);
  useEffect(() => { loadCategories(); }, [loadCategories]);
  // Live chamary list — what a link_to_chamaries category (e.g. Food) offers as its subcategory.
  useEffect(() => { if (featureOn) listAllChamaries().then(setChamaries).catch(() => {}); }, [featureOn]);

  // The buckets the Credit Requests tab shows. `pendReqs` keeps its old meaning — what an
  // approver can act on right now — which now means EVERY earlier gate has cleared or was never
  // needed: the supervisor (stage 1) and the request category's named approvers (stage 2).
  const pendReqs = allReqs.filter(r => r.status === 'pending' && requestIsReadyForApprover(r));
  const waitingSupervisorReqs = allReqs.filter(r => r.status === 'pending' && requestStage(r) === 'supervisor');
  const waitingCategoryReqs   = allReqs.filter(r => r.status === 'pending' && requestStage(r) === 'category');
  const decidedReqs = allReqs.filter(r => r.status !== 'pending');

  // Pick the first tab the user is entitled to, once access is known. An approver lands on the
  // Ledger — who took how much, on which days — which is what they open this page for; the
  // queue is one tab over, with its count on the trigger. A plain holder lands on their own view.
  useEffect(() => {
    if (tab) return;
    if (canApprove) setTab('ledger');
    else if (hasAccount) setTab('mine');
    else if (pendingSupervisorReqs.length > 0 || pendingCategoryReqs.length > 0) setTab('approvals');
  }, [hasAccount, canApprove, tab, pendingSupervisorReqs.length, pendingCategoryReqs.length]);

  // Awaited by every action handler (approve/reject/save/etc.) before they clear their own busy
  // state — otherwise a button re-enables (and a just-actioned card stays visible) BEFORE the
  // silent background refresh has actually pulled the updated list, so a second click during that
  // window hits "already processed" even though the first click genuinely succeeded.
  const refreshAll = async () => {
    setRefreshing(true);
    try { await Promise.all([load({ silent: true }), epf ? reload() : Promise.resolve()]); }
    finally { setRefreshing(false); setRefreshKey(k => k + 1); }
  };

  // ── Approving in bulk ────────────────────────────────────────────────────────────────────
  // An approver works DOWN a queue — 224 pending bills at the time of writing — and every single
  // approval used to await a full refreshAll: ten queries, among them all 232 pending submissions
  // (~290 KB). Approving thirty bills re-downloaded the same list thirty times, and each approval
  // sat waiting for it before the button came back.
  //
  // Instead: drop the acted-on bill from the list immediately (the card vanishes, which is a
  // stronger guarantee than the awaited refetch ever gave — there is no row left to double-click),
  // then let ONE authoritative refresh land once the approver pauses. The writes are already
  // committed either way; this only governs when the screen catches up.
  const dropPendingSub = useCallback((id: string) => {
    setPendSubs(prev => prev.filter(s => s.id !== id));
  }, []);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { refreshTimer.current = null; void refreshAll(); }, 1500);
    // refreshAll closes over current state each render; the timer only ever calls the latest one
    // because it is rescheduled on every action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A pending timer must not outlive the page, or it fires against unmounted state.
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);

  // "New expense" in the header: the form lives on the My Suspense tab, so switch there first
  // if needed, then scroll it into view once it has rendered.
  const focusSubmitForm = () => {
    const go = () => {
      const el = document.getElementById(SUBMIT_FORM_ID);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.querySelector<HTMLElement>('input, select, textarea, button')?.focus({ preventScroll: true });
    };
    if (tab === 'mine') { go(); return; }
    // The tab content mounts on the next render; give it a frame before looking for the form.
    setTab('mine');
    setTimeout(go, 50);
  };

  const removeSubmission = async (id: string) => {
    try { await deleteSubmission(id, actor); toast.success('Expense cancelled.'); load({ silent: true }); }
    catch (e) { toast.error(errMsg(e, 'Failed to cancel.')); }
  };
  const removeRequest = async (id: string) => {
    try { await deleteRequest(id); toast.success('Request deleted.'); load(); }
    catch (e) { toast.error(errMsg(e, 'Failed to delete.')); }
  };
  // Delete a zero-balance company account (the "old approach" — no settlement needed).
  const removeAccount = async (a: SuspenseAccount) => {
    try { await deleteCompanyAccount(a.epf_number, a.company_id, actor); toast.success('Account deleted.'); refreshAll(); }
    catch (e) { toast.error(errMsg(e, 'Failed to delete.')); }
  };

  // Reopen a closed account. It comes back at the balance it was settled to (zero) with its
  // ledger history intact — see reopenSuspenseAccount.
  const reopenAccount = async (a: SuspenseAccount) => {
    try { await reopenSuspenseAccount(a.epf_number, a.company_id, actor); toast.success('Account reopened.'); refreshAll(); }
    catch (e) { toast.error(errMsg(e, 'Failed to reopen.')); }
  };

  const [confirmAction, setConfirmAction] = useState<
    { kind: 'expense'; id: string }
    | { kind: 'account'; account: SuspenseAccount }
    | { kind: 'reopen'; account: SuspenseAccount }
    | null
  >(null);

  // Suspense is an Alta Vision-only module — not available on other tenants.
  if (!tenant.features.suspense) {
    return (
      <div className="space-y-6">
        <PageHeader icon={Wallet} title="Suspense" description="Company expense float" />
        <EmptyState icon={Wallet} title="Not available" description="The suspense module isn’t enabled for this workspace." />
      </div>
    );
  }

  // Access resolved but the user has neither an account nor approver rights nor anything
  // pending for them to sign off as a supervisor. The added !loading guards against a
  // premature flash before load() (which now also fetches pendingSupervisorReqs) resolves.
  if (loaded && !loading && !hasAccount && !canApprove && pendingSupervisorReqs.length === 0 && pendingCategoryReqs.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader icon={Wallet} title="Suspense" description="Company expense float" />
        <EmptyState icon={Wallet} title="No suspense access"
          description="You don't have a suspense account yet. Ask a user manager to open one for you." />
      </div>
    );
  }

  const currency = myAccounts[0]?.currency ?? 'LKR';
  const showApprovalsTab = canApprove || pendingSupervisorReqs.length > 0 || pendingCategoryReqs.length > 0;
  const pendingCount = pendSubs.length + pendReqs.length + pendCloses.length + pendingSupervisorReqs.length + pendingCategoryReqs.length;
  const tabCount = (hasAccount ? 1 : 0) + (showApprovalsTab ? 1 : 0) + (canApprove ? 3 : 0);   // ledger + vouchers + accounts
  const showTabs = tabCount > 1;
  // A technician can only submit if their own-company account is active; an executive can
  // always submit (they may pick any company — auto-created on approval).
  const ownAcc    = myAccounts.find(a => a.company_id === ctx.companyId);
  const canSubmit = multiCompany || (!!ownAcc && ownAcc.is_active !== false && !ownAcc.is_closed);
  // Every credit request still open somewhere in the pipeline — what the Ledger's "Credit
  // given" card reports as still requested.
  const openCreditRequests = [...pendReqs, ...waitingSupervisorReqs, ...waitingCategoryReqs];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Wallet}
        title="Suspense"
        description="Your expense float — what you have, what you spent, what is waiting."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={refreshAll} disabled={refreshing}>
              <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} /> Refresh
            </Button>
            {hasAccount && (
              <Button size="sm" onClick={focusSubmitForm}>
                <Plus className="w-4 h-4" /> New expense
              </Button>
            )}
          </div>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        {showTabs && (
          <TabsList className="flex-wrap h-auto">
            {canApprove && (
              <TabsTrigger value="ledger"><CalendarDays className="w-3.5 h-3.5" /> Ledger</TabsTrigger>
            )}
            {hasAccount && (
              <TabsTrigger value="mine"><Wallet className="w-3.5 h-3.5" /> My Suspense</TabsTrigger>
            )}
            {showApprovalsTab && (
              <TabsTrigger value="approvals">
                <ShieldCheck className="w-3.5 h-3.5" /> Approvals
                {pendingCount > 0 && <span className={cn(badgeVariants({ variant: 'warning' }), 'ml-1 px-1.5 py-0 text-[10px] tabular-nums')}>{pendingCount}</span>}
              </TabsTrigger>
            )}
            {canApprove && (
              <TabsTrigger value="vouchers"><FileText className="w-3.5 h-3.5" /> Vouchers</TabsTrigger>
            )}
            {canApprove && (
              <TabsTrigger value="recoveries"><HandCoins className="w-3.5 h-3.5" /> Recoveries</TabsTrigger>
            )}
            {canApprove && (
              <TabsTrigger value="accounts"><UsersIcon className="w-3.5 h-3.5" /> Accounts</TabsTrigger>
            )}
          </TabsList>
        )}

        {/* ── Holder overview: balances, month strip, submit form beside the activity feed ── */}
        {hasAccount && (
          <TabsContent value="mine" className={showTabs ? undefined : 'mt-0'}>
            <HolderOverview
              accounts={myAccounts} currency={currency} mySubs={mySubs} myReqs={myReqs} closes={myCloses} ledger={myLedger} loading={loading}
              ctx={ctx} multiCompany={multiCompany} canSubmit={canSubmit}
              submitForm={
                <div id={SUBMIT_FORM_ID} className="scroll-mt-4">
                  <NewExpenseForm ctx={ctx} companies={companies} multiCompany={multiCompany} categories={categories} chamaries={chamaries}
                    disabled={!canSubmit} onSaved={refreshAll} />
                </div>
              }
              onRequest={(a) => setRequestDialog({ open: true, editing: null, company: { id: a.company_id, name: a.company_name } })}
              onClose={(a) => setCloseDialog({ open: true, account: a })}
              onEditExpense={(s) => setExpenseDialog({ open: true, editing: s })}
              onDeleteExpense={(id: string) => setConfirmAction({ kind: 'expense', id })}
              onEditRequest={(r) => setRequestDialog({ open: true, editing: r, company: null })}
              onDeleteRequest={removeRequest}
              onRefresh={refreshAll}
            />
          </TabsContent>
        )}

        {/* ── Approvals ── */}
        {showApprovalsTab && (
          <TabsContent value="approvals">
            {loading ? (
              <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
            ) : pendingCount === 0 ? (
              <EmptyState icon={Check} title="Nothing to review" description="Pending expenses and credit requests will appear here." />
            ) : (
              <ApprovalsPanel pendSubs={pendSubs} pendReqs={pendReqs} pendCloses={pendCloses} pendingSupervisorReqs={pendingSupervisorReqs}
                pendingCategoryReqs={pendingCategoryReqs}
                waitingSupervisorReqs={waitingSupervisorReqs} waitingCategoryReqs={waitingCategoryReqs} decidedReqs={decidedReqs} employees={employees}
                accounts={accounts} canApprove={canApprove} actor={actor} currency={currency} onDone={refreshAll}
                onSubActed={(id) => { dropPendingSub(id); scheduleRefresh(); }}
                companies={companies} multiCompany={multiCompany} categories={categories} chamaries={chamaries} />
            )}
          </TabsContent>
        )}

        {/* ── Ledger: who spent what, on which days, for a chosen month ── */}
        {canApprove && (
          <TabsContent value="ledger">
            <ApproverLedger accounts={accounts} companies={companies} currency={currency}
              pendingRequests={openCreditRequests} refreshKey={refreshKey} />
          </TabsContent>
        )}

        {/* ── Vouchers ── */}
        {canApprove && (
          <TabsContent value="vouchers">
            <VoucherReport companies={companies} />
          </TabsContent>
        )}

        {/* ── Split recoveries: money one employee is carrying for another ── */}
        {canApprove && (
          <TabsContent value="recoveries">
            <SplitRecoveries actor={actor} refreshKey={refreshKey} onRecovered={refreshAll} />
          </TabsContent>
        )}

        {/* ── Accounts overview ── */}
        {canApprove && (
          <TabsContent value="accounts">
            <AccountsPanel
              accounts={accounts} loading={loading} actor={actor}
              onOpenAccount={() => setOpenAcctDialog(true)}
              onAddCredit={(a) => setCreditDialog({ open: true, account: a })}
              onClose={(a) => setCloseDialog({ open: true, account: a })}
              onDelete={(a) => setConfirmAction({ kind: 'account', account: a })}
              onReopen={(a) => setConfirmAction({ kind: 'reopen', account: a })}
              onImported={refreshAll}
            />
          </TabsContent>
        )}

      </Tabs>

      <ExpenseDialog
        open={expenseDialog.open}
        editing={expenseDialog.editing}
        ctx={ctx}
        companies={companies} multiCompany={multiCompany} categories={categories} chamaries={chamaries}
        onOpenChange={(v) => setExpenseDialog(s => ({ ...s, open: v }))}
        onSaved={refreshAll}
      />
      <RequestDialog
        open={requestDialog.open}
        editing={requestDialog.editing}
        ctx={ctx}
        company={requestDialog.company}
        companies={companies} multiCompany={multiCompany} categories={categories}
        accounts={myAccounts}
        onOpenChange={(v) => setRequestDialog(s => ({ ...s, open: v }))}
        onSaved={refreshAll}
      />
      <CloseAccountDialog
        open={closeDialog.open}
        account={closeDialog.account}
        actor={actor}
        direct={canApprove}
        onOpenChange={(v) => setCloseDialog(s => ({ ...s, open: v }))}
        onSaved={refreshAll}
      />
      <OpenAccountDialog
        open={openAcctDialog}
        accounts={accounts}
        actor={actor}
        onOpenChange={setOpenAcctDialog}
        onCreated={refreshAll}
      />
      <AllocateCreditDialog
        open={creditDialog.open}
        account={creditDialog.account}
        siblingAccounts={accounts.filter(a => a.epf_number === creditDialog.account?.epf_number)}
        companies={companies}
        actor={actor}
        onOpenChange={(v) => setCreditDialog(s => ({ ...s, open: v }))}
        onSaved={refreshAll}
      />

      <ConfirmModal
        open={confirmAction !== null}
        onOpenChange={() => setConfirmAction(null)}
        variant={confirmAction?.kind === 'reopen' ? 'warning' : 'danger'}
        title={
          confirmAction?.kind === 'account' ? 'Delete suspense account?'
            : confirmAction?.kind === 'reopen' ? 'Reopen suspense account?'
              : 'Cancel this expense?'
        }
        description={
          confirmAction?.kind === 'account'
            ? `${confirmAction.account.employee_name}'s ${confirmAction.account.company_name} suspense account (zero balance) will be deleted.`
            : confirmAction?.kind === 'reopen'
              ? `${confirmAction.account.employee_name}'s ${confirmAction.account.company_name} suspense account becomes active again at ${formatSuspenseAmount(confirmAction.account.balance, confirmAction.account.currency)}. The settlement that closed it stays on the ledger.`
              : 'It will no longer show anywhere or be considered for approval.'
        }
        confirmText={
          confirmAction?.kind === 'account' ? 'Delete'
            : confirmAction?.kind === 'reopen' ? 'Reopen'
              : 'Cancel expense'
        }
        cancelText="Keep"
        onConfirm={async () => {
          const a = confirmAction;
          setConfirmAction(null);
          if (a?.kind === 'account') await removeAccount(a.account);
          else if (a?.kind === 'reopen') await reopenAccount(a.account);
          else if (a?.kind === 'expense') await removeSubmission(a.id);
        }}
      />
    </div>
  );
}
