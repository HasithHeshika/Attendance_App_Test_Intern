import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, arrayUnion, runTransaction, writeBatch, Timestamp, type Transaction,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { epfDocId, getUserByEpf } from '@/services/userService';
import { createAppNotification } from '@/services/notificationService';
import { uploadCloudFile, seg } from '@/services/cloudStorageService';
import { getRoles } from '@/services/roleService';
import { getCompanies } from '@/services/companyService';
import { roleCategory } from '@/lib/permissions';
import { readBillSlot, planBillBackfillMove, nextCounterSeq } from '@/lib/billNumbering';
import {
  findDuplicateBill, DUPLICATE_WINDOW_MS, type CandidateBill, type ExistingBill,
} from '@/lib/billDuplicates';
import { billDayOf, localDayKey, msOf } from '@/lib/suspenseMonthView';
import {
  normalizeLimitConfig, resolveSuspenseLimit, checkAgainstLimit, limitHeadroom, LIMIT_SOURCE_LABEL,
  type SuspenseLimitConfig, type ResolvedLimit,
} from '@/lib/suspenseLimits';
import type {
  SuspenseAccount, SuspenseLedgerEntry, SuspenseLedgerKind,
  SuspenseSubmission, SuspenseRequest, SuspenseCloseRequest, SuspenseSplit,
  SuspenseCategory, SuspenseSubcategory, SuspenseType, SuspenseVoucher,
  SuspenseApprover, SuspenseBillEventKind, SuspenseBillEventChange,
} from '@/lib/types';

// Sanitize a raw split list → drop blanks, coerce amounts, and MERGE repeated employees so one
// person appears at most once. The merge is not tidiness: a split row is addressed by EPF when it
// is recovered (recoverSplit) and getEmployeeDeductions reads a person's share with .find(), which
// takes the FIRST match — two rows for the same colleague would have shown them half of what
// payroll actually deducts, and left the rest unrecoverable.
function cleanSplits(raw: SuspenseSplit[] | undefined): SuspenseSplit[] {
  const byEpf = new Map<string, SuspenseSplit>();
  for (const s of raw ?? []) {
    if (!s?.epf_number || money(s.amount) <= 0) continue;
    const found = byEpf.get(s.epf_number);
    if (found) found.amount = money(found.amount + money(s.amount));
    else byEpf.set(s.epf_number, {
      epf_number: s.epf_number, employee_name: s.employee_name || s.epf_number, amount: money(s.amount),
    });
  }
  return [...byEpf.values()];
}

/** What a bill's splits still owe the payer — the rows payroll has not yet deducted. */
export function splitsOutstanding(splits: SuspenseSplit[] | undefined): number {
  return money((splits ?? []).filter(s => !s?.recovered_at).reduce((t, s) => t + money(s.amount), 0));
}
export function splitsTotal(splits: SuspenseSplit[] | undefined): number {
  return money((splits ?? []).reduce((t, s) => t + money(s.amount), 0));
}

// Firestore collections. Balance-changing operations run inside runTransaction so a
// concurrent approval can never corrupt the running balance or the ledger. Reads are
// single-field (equality) so they're covered by Firestore's automatic indexes.
//
// ACCOUNTS ARE PER (user, company): doc id = `${epfDocId(epf)}__${company_id}`. An employee's
// own-company account is opened by a user-manager; executive/top-management staff can spend
// for OTHER companies too, whose per-company account is auto-created the first time an item
// for that company is approved. Technicians only ever have their own-company account.
const ACCOUNTS = 'suspense_accounts';
const LEDGER   = 'suspense_ledger';
const SUBS     = 'suspense_submissions';
const REQS     = 'suspense_requests';
const CLOSES   = 'suspense_close_requests';
const CATS     = 'suspense_categories';
const VOUCHERS = 'suspense_vouchers';
const SETTINGS = 'suspense_settings';
// Append-only trail of what happened to each bill — created/edited/resubmitted/deleted/renumbered.
// Has its own append-only match block in firestore.rules (same isAuth() posture as the other
// suspense_* collections). A denied or undeliverable event write by design only console.warns —
// bills keep saving, the trail just stays empty. See logBillEvent.
const BILL_EVENTS = 'suspense_bill_events';

export const SUSPENSE_CURRENCY = 'LKR';

export interface Actor { epf: string; name: string; }

// Whether approved bills accumulate into one voucher PER EMPLOYEE (default) or into a single
// voucher SHARED across everyone — a System Settings toggle (see getVoucherMode/setVoucherMode).
export type VoucherMode = 'per_user' | 'overall';

// Composite account id — one suspense balance per (user, company).
function accountId(epf: string, companyId: string): string {
  return `${epfDocId(epf)}__${companyId}`;
}

function millis(t: { toMillis?: () => number } | null | undefined): number {
  return t?.toMillis?.() ?? 0;
}

// Round to 2dp — money must never carry float drift.
function money(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ─── Expense taxonomy (categories with a type pool; subcategories assigned type ids) ────
const cleanTypes = (types: SuspenseType[] | undefined): SuspenseType[] =>
  (types ?? []).filter(t => t?.id && t.name?.trim()).map(t => ({ id: t.id, name: t.name.trim() }));
const cleanSubs = (subs: SuspenseSubcategory[] | undefined): SuspenseSubcategory[] =>
  (subs ?? []).filter(s => s?.id && s.name?.trim()).map(s => {
    // Back-compat: a doc saved before subcategories were limited to one type may still carry the
    // old `type_ids` array — fold it down to its first entry rather than losing the assignment.
    const legacy = (s as unknown as { type_ids?: unknown }).type_ids;
    const typeId = s.type_id ?? (Array.isArray(legacy) && typeof legacy[0] === 'string' ? legacy[0] : null);
    return { id: s.id, name: s.name.trim(), allow_split: !!s.allow_split, type_id: typeId || null };
  });

// Approval personas on a category — deduplicated by EPF, blanks dropped, names trimmed (falling
// back to the EPF so a row never renders as an empty string).
const cleanApprovers = (people: SuspenseApprover[] | undefined): SuspenseApprover[] => {
  const byEpf = new Map<string, SuspenseApprover>();
  for (const p of people ?? []) {
    const epf = (p?.epf ?? '').trim();
    if (!epf || byEpf.has(epf)) continue;
    byEpf.set(epf, { epf, name: (p.name ?? '').trim() || epf });
  }
  return [...byEpf.values()];
};

export async function listSuspenseCategories(): Promise<SuspenseCategory[]> {
  const snap = await getDocs(collection(db, CATS));
  return snap.docs
    .map(d => {
      const raw = d.data() as SuspenseCategory;
      return {
        id: d.id, ...(d.data() as Omit<SuspenseCategory, 'id'>),
        types: cleanTypes(raw.types), subcategories: cleanSubs(raw.subcategories),
        credit_approvers: cleanApprovers(raw.credit_approvers),
      };
    })
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}

export async function createCategory(name: string): Promise<string> {
  const ref = doc(collection(db, CATS));
  const now = Timestamp.now();
  await setDoc(ref, { name: name.trim(), types: [], subcategories: [], credit_approvers: [], vat_default: false, vat_rate: 0, order: now.toMillis(), created_at: now, updated_at: now });
  return ref.id;
}

export async function updateCategory(id: string, patch: { name?: string; types?: SuspenseType[]; subcategories?: SuspenseSubcategory[]; vat_default?: boolean; vat_rate?: number; group_in_vouchers?: boolean; credit_approvers?: SuspenseApprover[] }): Promise<void> {
  const data: Record<string, unknown> = { updated_at: Timestamp.now() };
  if (patch.name !== undefined)         data.name = patch.name.trim();
  if (patch.types !== undefined)        data.types = cleanTypes(patch.types);
  if (patch.subcategories !== undefined) data.subcategories = cleanSubs(patch.subcategories);
  if (patch.vat_default !== undefined)  data.vat_default = !!patch.vat_default;
  if (patch.vat_rate !== undefined)     data.vat_rate = Math.max(0, Number(patch.vat_rate) || 0);
  if (patch.group_in_vouchers !== undefined) data.group_in_vouchers = !!patch.group_in_vouchers;
  if (patch.credit_approvers !== undefined) data.credit_approvers = cleanApprovers(patch.credit_approvers);
  await updateDoc(doc(db, CATS, id), data);
}

export async function deleteCategory(id: string): Promise<void> {
  await deleteDoc(doc(db, CATS, id));
}

// A stable id for a new subcategory/type (uses a throwaway Firestore ref id — no write).
export function newSubcategoryId(): string {
  return doc(collection(db, CATS)).id;
}

// Display helper reused by the UI: "LKR 1,250.00" / "-LKR 300.00".
export function formatSuspenseAmount(n: number, currency: string = SUSPENSE_CURRENCY): string {
  const v = Math.abs(money(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${currency} ${v}`;
}

async function notifyOwner(
  epf: string, type: 'suspense_approved' | 'suspense_rejected', title: string, body: string, actor: Actor,
): Promise<void> {
  if (!epf) return;
  await createAppNotification({ toEpf: epf, type, title, body, link: '/suspense', actorEpf: actor.epf, actorName: actor.name });
}

// Reject every still-pending submission & request for ONE (user, company) — used when that
// company's account is closed or deleted. Chunked to respect the 500-write batch limit.
async function rejectPendingForCompany(epf: string, companyId: string, reason: string, actor: Actor): Promise<void> {
  const [subsSnap, reqsSnap] = await Promise.all([
    getDocs(query(collection(db, SUBS), where('epf_number', '==', epf))),
    getDocs(query(collection(db, REQS), where('epf_number', '==', epf))),
  ]);
  const pending = [
    // A cancelled submission keeps status 'pending' (deleteSubmission only sets `deleted`), so it
    // must be excluded here too — it is already withdrawn and has already given up its bill number.
    // Credit requests have no soft delete (deleteRequest removes the doc), so they need no such filter.
    ...subsSnap.docs.filter((d) => d.data().status === 'pending' && d.data().company_id === companyId && !d.data().deleted),
    ...reqsSnap.docs.filter((d) => d.data().status === 'pending' && d.data().company_id === companyId),
  ];
  if (!pending.length) return;
  const now = Timestamp.now();
  const payload = { status: 'rejected', considered_by: actor.epf, considered_by_name: actor.name, considered_at: now, reject_reason: reason, updated_at: now };
  for (let i = 0; i < pending.length; i += 450) {
    const batch = writeBatch(db);
    pending.slice(i, i + 450).forEach((d) => batch.update(d.ref, payload));
    await batch.commit();
  }
}

// ─── Ledger ───────────────────────────────────────────────────────────────────
async function addLedgerEntry(e: {
  epf_number: string; company_id: string; kind: SuspenseLedgerKind; amount: number; balance_after: number;
  ref_type: SuspenseLedgerEntry['ref_type']; ref_id: string | null; note: string; actor: Actor;
}): Promise<void> {
  // Pre-generate the ref so `id` is written in the SAME create, matching the transaction
  // paths below. The old addDoc + updateDoc({id}) stamp needed a second write, which the
  // append-only ledger rule (`allow update, delete: if false`) denies — it threw
  // "Missing or insufficient permissions" after the entry had already been created.
  const ref = doc(collection(db, LEDGER));
  await setDoc(ref, {
    id:            ref.id,
    epf_number:    e.epf_number,
    company_id:    e.company_id,
    kind:          e.kind,
    amount:        money(e.amount),
    balance_after: money(e.balance_after),
    ref_type:      e.ref_type,
    ref_id:        e.ref_id,
    note:          e.note,
    actor_epf:     e.actor.epf,
    actor_name:    e.actor.name,
    created_at:    Timestamp.now(),
  });
}

export async function getLedger(epf: string): Promise<SuspenseLedgerEntry[]> {
  if (!epf) return [];
  const snap = await getDocs(query(collection(db, LEDGER), where('epf_number', '==', epf)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as SuspenseLedgerEntry))
    .sort((a, b) => millis(b.created_at) - millis(a.created_at));
}

// ─── Accounts ───────────────────────────────────────────────────────────────
export async function getSuspenseAccount(epf: string, companyId: string): Promise<SuspenseAccount | null> {
  if (!epf || !companyId) return null;
  const snap = await getDoc(doc(db, ACCOUNTS, accountId(epf, companyId)));
  return snap.exists() ? (snap.data() as SuspenseAccount) : null;
}

// All of a user's per-company accounts (own company + any auto-created ones).
export async function getUserAccounts(epf: string): Promise<SuspenseAccount[]> {
  if (!epf) return [];
  const snap = await getDocs(query(collection(db, ACCOUNTS), where('epf_number', '==', epf)));
  return snap.docs.map(d => d.data() as SuspenseAccount)
    .sort((a, b) => a.company_name.localeCompare(b.company_name));
}

export async function listSuspenseAccounts(): Promise<SuspenseAccount[]> {
  const snap = await getDocs(collection(db, ACCOUNTS));
  return snap.docs
    .map(d => d.data() as SuspenseAccount)
    .sort((a, b) => a.employee_name.localeCompare(b.employee_name) || a.company_name.localeCompare(b.company_name));
}

export interface CreateAccountInput {
  epf_number:    string;
  employee_name: string;
  company_id:    string;
  company_name:  string;
  currency?:     string;
}

// Open a per-company suspense account — starts empty (balance 0) and active. Used by a
// user-manager to open the employee's OWN-company account. Refuses to clobber an existing one.
export async function createSuspenseAccount(input: CreateAccountInput, actor: Actor): Promise<void> {
  const id = accountId(input.epf_number, input.company_id);
  if ((await getDoc(doc(db, ACCOUNTS, id))).exists()) {
    throw new Error('A suspense account for this company already exists for this user.');
  }
  const now = Timestamp.now();
  const account: SuspenseAccount = {
    epf_number:      input.epf_number,
    employee_name:   input.employee_name,
    company_id:      input.company_id,
    company_name:    input.company_name,
    balance:         0,
    currency:        input.currency ?? SUSPENSE_CURRENCY,
    is_active:       true,
    created_by:      actor.epf,
    created_by_name: actor.name,
    created_at:      now,
    updated_at:      now,
  };
  await setDoc(doc(db, ACCOUNTS, id), account);
  await addLedgerEntry({
    epf_number: input.epf_number, company_id: input.company_id, kind: 'opening', amount: 0, balance_after: 0,
    ref_type: 'account', ref_id: null, note: `Account opened (${input.company_name})`, actor,
  });
  try {
    await updateDoc(doc(db, 'users', epfDocId(input.epf_number)), { has_suspense_account: true, updated_at: now });
  } catch { /* denormalized flag only — non-critical */ }
}

// Immediately delete a per-company account — the "old approach" for a ZERO-balance account
// (no fund transfer needed). Rejects any leftover pending items for that company. A non-zero
// balance must go through the close request → settlement flow instead.
export async function deleteCompanyAccount(epf: string, companyId: string, actor: Actor): Promise<void> {
  const accRef = doc(db, ACCOUNTS, accountId(epf, companyId));
  // A pending close request freezes this account awaiting settlement; deleting it here would
  // orphan that close doc (approveCloseRequest then fails on the missing account). Resolve first.
  if (await hasPendingClose(epf, companyId)) {
    throw new Error('A close request is pending for this account — resolve it first.');
  }
  const snap = await getDoc(accRef);
  if (!snap.exists()) return;
  const companyName = (snap.data() as SuspenseAccount).company_name;
  // Reject leftover pending items BEFORE deleting so a racing approval can't resurrect the account
  // with a hidden balance after removal — the balance-0 guard below then fails safe if one slips in.
  await rejectPendingForCompany(epf, companyId, `Suspense account deleted (${companyName})`, actor);
  await runTransaction(db, async (tx) => {
    const fresh = await tx.get(accRef);
    if (!fresh.exists()) return;
    if (money((fresh.data() as SuspenseAccount).balance) !== 0) {
      throw new Error('Only a zero-balance account can be deleted. Close it with a settlement instead.');
    }
    tx.delete(accRef);
  });
}

// Manual credit (delta > 0) or debit (delta < 0) on a specific company account. If the employee
// has no account yet for this company, a positive delta opens one (same auto-create the approval
// flow already does for expenses/requests — see approveSubmission); a debit still requires an
// existing account, since there's nothing to debit otherwise. `employeeName`/`companyName` are
// only needed for that auto-create path.
//
// A credit (delta > 0) is checked against the person's float limit (see suspenseLimits.ts): it is
// refused when the balance would land over it, unless `overrideLimit` carries the approver's
// reason — which is then written into the ledger note so the exception is on the record.
// Debits are never limited.
export async function adjustSuspenseAccount(args: { epf: string; companyId: string; employeeName?: string; companyName?: string; delta: number; note: string; actor: Actor; overrideLimit?: string }): Promise<number> {
  const accRef = doc(db, ACCOUNTS, accountId(args.epf, args.companyId));
  const delta  = money(args.delta);
  const resolved = delta > 0 ? await resolveLimitForEpf(args.epf, args.companyId) : null;
  const override = (args.overrideLimit ?? '').trim();
  let balAfter = 0;
  let limitNote = '';
  await runTransaction(db, async (tx) => {
    const accSnap = await tx.get(accRef);
    const now = Timestamp.now();
    if (!accSnap.exists()) {
      if (delta <= 0) throw new Error('No suspense account for this company.');
      if (!args.employeeName || !args.companyName) throw new Error('No suspense account for this company.');
      balAfter = delta;
      tx.set(accRef, {
        epf_number: args.epf, employee_name: args.employeeName,
        company_id: args.companyId, company_name: args.companyName,
        balance: balAfter, currency: SUSPENSE_CURRENCY, is_active: true,
        created_by: args.actor.epf, created_by_name: args.actor.name, created_at: now, updated_at: now,
      });
    } else {
      const acc = accSnap.data() as SuspenseAccount;
      if (acc.is_closed) throw new Error('This account is closed.');
      if (!acc.is_active) throw new Error('This account is frozen (a close request is pending).');
      balAfter = money(acc.balance + delta);
      tx.update(accRef, { balance: balAfter, updated_at: now });
    }
    if (resolved && resolved.limit !== null) {
      const before = balAfter - delta;
      const check = checkAgainstLimit(resolved.limit, balAfter);
      if (check.over && !override) {
        throw new Error(describeLimitBreach(args.employeeName || args.epf, resolved, before, balAfter));
      }
      if (check.over) limitNote = ` · Limit ${formatSuspenseAmount(resolved.limit)} overridden: ${override}`;
    }
    const ledRef = doc(collection(db, LEDGER));
    tx.set(ledRef, {
      id: ledRef.id, epf_number: args.epf, company_id: args.companyId, kind: 'adjustment' as SuspenseLedgerKind,
      amount: delta, balance_after: balAfter, ref_type: 'account', ref_id: null,
      note: (args.note || (delta >= 0 ? 'Manual credit' : 'Manual debit')) + limitNote,
      actor_epf: args.actor.epf, actor_name: args.actor.name, created_at: now,
    });
  });
  return balAfter;
}

export interface CarryForwardInput {
  epf:          string;
  companyId:    string;
  employeeName: string;
  companyName:  string;
  /**
   * The previous period's closing position, applied as a MOVEMENT: a positive figure ADDS to the
   * balance, a negative one REDUCES it. Not the balance the account should end at — the account
   * keeps whatever it already holds and this is carried in on top of it.
   */
  amount:       number;
  /** The period being carried in, 'YYYY-MM'. Recorded so the same month can't be applied twice. */
  period:       string;
  /** The date that figure is "as at" — the first of the period after it, e.g. 1 Sep 2026. */
  asAt:         Date;
  note:         string;
  /**
   * Apply even though this period is already recorded on the account. A repeat is refused by
   * default because adding is not repeatable the way setting a balance was — re-running one
   * sheet would double every amount on it. This is the deliberate override.
   */
  allowRepeat?: boolean;
}

/**
 * Carry a period's closing balance into an account — the write half of the balance upload (see
 * src/lib/suspenseBalanceImport.ts).
 *
 * The uploaded figure is a MOVEMENT, the same thing adjustSuspenseAccount takes: it is ADDED to
 * whatever the account already holds (a negative figure reduces it), so last month's position
 * carries forward on top of this month's activity instead of replacing it. That is the whole
 * difference from setting a balance, and it is why the period matters — `carry_forward_periods`
 * is the record that makes a re-upload detectable rather than silently doubled.
 *
 * The account moves by exactly one ledger entry: `opening` when this call is what opens the
 * account (the only path that may open one at a NEGATIVE balance — someone already spent past a
 * float that was never recorded here), `adjustment` otherwise. A zero amount writes nothing at
 * all rather than a 0.00 entry that says nothing, and is not recorded as a period carried in.
 */
export async function applyCarryForward(input: CarryForwardInput, actor: Actor): Promise<{ opened: boolean; amount: number; balance: number }> {
  const accRef = doc(db, ACCOUNTS, accountId(input.epf, input.companyId));
  const amount = money(input.amount);
  const asAt   = Timestamp.fromDate(input.asAt);
  let opened  = false;
  let balance = 0;
  await runTransaction(db, async (tx) => {
    const accSnap = await tx.get(accRef);
    const now = Timestamp.now();
    opened = !accSnap.exists();
    if (opened) {
      if (!input.employeeName || !input.companyName) throw new Error('No suspense account for this company.');
      balance = amount;
      tx.set(accRef, {
        epf_number: input.epf, employee_name: input.employeeName,
        company_id: input.companyId, company_name: input.companyName,
        balance, currency: SUSPENSE_CURRENCY, is_active: true,
        carry_forward: amount, carry_forward_at: asAt, carry_forward_periods: [input.period],
        created_by: actor.epf, created_by_name: actor.name, created_at: now, updated_at: now,
      });
    } else {
      const acc = accSnap.data() as SuspenseAccount;
      if (acc.is_closed) throw new Error('This account is closed.');
      if (!acc.is_active) throw new Error('This account is frozen (a close request is pending).');
      // Re-checked here and not only in the preview: the preview was built from a snapshot read
      // before the run started, so two uploads of the same sheet (a second tab, a double click
      // through the confirm) would otherwise both read "not carried yet" and both apply.
      if (!input.allowRepeat && (acc.carry_forward_periods ?? []).includes(input.period)) {
        throw new Error(`${input.period} has already been carried into this account.`);
      }
      balance = money(money(acc.balance) + amount);
      tx.update(accRef, {
        balance, updated_at: now,
        carry_forward: amount, carry_forward_at: asAt,
        carry_forward_periods: arrayUnion(input.period),
      });
    }
    const ledRef = doc(collection(db, LEDGER));
    tx.set(ledRef, {
      id: ledRef.id, epf_number: input.epf, company_id: input.companyId,
      kind: (opened ? 'opening' : 'adjustment') as SuspenseLedgerKind,
      amount, balance_after: balance, ref_type: 'account', ref_id: null,
      note: input.note || `Carried forward from ${input.period}`,
      actor_epf: actor.epf, actor_name: actor.name, created_at: now,
    });
  });
  if (opened) {
    try {
      await updateDoc(doc(db, 'users', epfDocId(input.epf)), { has_suspense_account: true, updated_at: Timestamp.now() });
    } catch { /* denormalized flag only — non-critical */ }
  }
  return { opened, amount, balance };
}

// ─── Close / clear account ─────────────────────────────────────────────────────
export async function getMyCloseRequests(epf: string): Promise<SuspenseCloseRequest[]> {
  if (!epf) return [];
  const snap = await getDocs(query(collection(db, CLOSES), where('epf_number', '==', epf)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as SuspenseCloseRequest))
    .sort((a, b) => millis(b.created_at) - millis(a.created_at));
}

export async function getPendingCloseRequests(): Promise<SuspenseCloseRequest[]> {
  const snap = await getDocs(query(collection(db, CLOSES), where('status', '==', 'pending')));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as SuspenseCloseRequest))
    .sort((a, b) => millis(a.created_at) - millis(b.created_at));
}

async function hasPendingClose(epf: string, companyId: string): Promise<boolean> {
  const snap = await getDocs(query(collection(db, CLOSES), where('epf_number', '==', epf)));
  return snap.docs.some((d) => d.data().status === 'pending' && d.data().company_id === companyId);
}

export interface CloseRequestInput {
  epf_number: string; employee_name: string; company_id: string; company_name: string; note: string;
}

// Request to close a company account. FREEZES that account so its balance can't change while
// pending. A positive balance REQUIRES a fund-transfer proof for exactly that amount.
export async function createCloseRequest(
  input: CloseRequestInput, actor: Actor, transfer?: File | null,
): Promise<string> {
  const acc = await getSuspenseAccount(input.epf_number, input.company_id);
  if (!acc) throw new Error('No suspense account for this company.');
  if (acc.is_closed) throw new Error('This account is already closed.');
  if (await hasPendingClose(input.epf_number, input.company_id)) throw new Error('A close request is already pending for this account.');

  const balance = money(acc.balance);
  let transfer_amount = 0;
  let transfer_url: string | null = null;
  let transfer_type: 'image' | 'pdf' | null = null;
  let transfer_name: string | null = null;
  let transfer_provider: 'firebase' | 'onedrive' | null = null;

  if (balance > 0) {
    if (!transfer || transfer.size === 0) {
      throw new Error('Attach a fund-transfer proof for the full balance to close this account.');
    }
    transfer_amount = balance;
    const up = await uploadCloudFile(transfer, { epf: input.epf_number, name: input.employee_name, prefix: 'suspense-close' });
    transfer_url = up.url; transfer_type = up.type; transfer_name = up.name; transfer_provider = up.provider;
  }

  const now = Timestamp.now();
  const ref = await addDoc(collection(db, CLOSES), {
    epf_number: input.epf_number, employee_name: input.employee_name,
    company_id: input.company_id, company_name: input.company_name,
    balance_at_request: balance, transfer_amount,
    transfer_url, transfer_type, transfer_name, transfer_provider,
    note: input.note ?? '',
    status: 'pending',
    requested_by: actor.epf, requested_by_name: actor.name,
    considered_by: null, considered_by_name: null, considered_at: null, reject_reason: null,
    created_at: now, updated_at: now,
  });
  await updateDoc(ref, { id: ref.id });
  // Freeze the company account so its balance is fixed while the close is pending.
  await updateDoc(doc(db, ACCOUNTS, accountId(input.epf_number, input.company_id)), { is_active: false, updated_at: now });
  return ref.id;
}

// Directly close an account in ONE step — for a suspense approver / account manager who doesn't
// need a second approval. Uploads the fund-transfer proof (required when balance > 0), settles the
// balance to zero with a settlement ledger entry, closes the account, rejects leftover pending
// items, and records a self-approved close doc for the audit trail.
export async function closeAccountNow(
  input: CloseRequestInput, actor: Actor, transfer?: File | null,
): Promise<void> {
  const acc = await getSuspenseAccount(input.epf_number, input.company_id);
  if (!acc) throw new Error('No suspense account for this company.');
  if (acc.is_closed) throw new Error('This account is already closed.');
  if (await hasPendingClose(input.epf_number, input.company_id)) {
    throw new Error('A close request is already pending for this account — resolve it first.');
  }

  const balance = money(acc.balance);
  let transfer_amount = 0;
  let transfer_url: string | null = null;
  let transfer_type: 'image' | 'pdf' | null = null;
  let transfer_name: string | null = null;
  let transfer_provider: 'firebase' | 'onedrive' | null = null;

  if (balance > 0) {
    if (!transfer || transfer.size === 0) {
      throw new Error('Attach a fund-transfer proof for the full balance to close this account.');
    }
    transfer_amount = balance;
    const up = await uploadCloudFile(transfer, { epf: input.epf_number, name: input.employee_name, prefix: 'suspense-close' });
    transfer_url = up.url; transfer_type = up.type; transfer_name = up.name; transfer_provider = up.provider;
  }

  const now = Timestamp.now();
  // Audit doc, recorded as already-approved (closed directly by an approver).
  const closeRef = await addDoc(collection(db, CLOSES), {
    epf_number: input.epf_number, employee_name: input.employee_name,
    company_id: input.company_id, company_name: input.company_name,
    balance_at_request: balance, transfer_amount,
    transfer_url, transfer_type, transfer_name, transfer_provider,
    note: input.note ?? '',
    status: 'approved',
    requested_by: actor.epf, requested_by_name: actor.name,
    considered_by: actor.epf, considered_by_name: actor.name, considered_at: now, reject_reason: null,
    created_at: now, updated_at: now,
  });
  await updateDoc(closeRef, { id: closeRef.id });

  const accRef = doc(db, ACCOUNTS, accountId(input.epf_number, input.company_id));
  await runTransaction(db, async (tx) => {
    const accSnap = await tx.get(accRef);
    if (!accSnap.exists()) throw new Error('The account no longer exists.');
    const a = accSnap.data() as SuspenseAccount;
    if (a.is_closed) throw new Error('This account is already closed.');
    const bal = money(a.balance);
    // The proof was attached for `balance`; refuse if the balance moved under us (concurrent expense).
    if (bal !== balance) throw new Error('The balance changed — reopen the dialog and retry so the transfer matches.');
    if (bal !== 0) {
      const ledRef = doc(collection(db, LEDGER));
      tx.set(ledRef, {
        id: ledRef.id, epf_number: a.epf_number, company_id: a.company_id, kind: 'settlement' as SuspenseLedgerKind,
        amount: -bal, balance_after: 0, ref_type: 'account', ref_id: closeRef.id,
        note: bal > 0
          ? `Account closed — ${formatSuspenseAmount(bal, a.currency)} returned to the company via fund transfer`
          : `Account closed — outstanding ${formatSuspenseAmount(-bal, a.currency)} written off (to reconcile with salary)`,
        actor_epf: actor.epf, actor_name: actor.name, created_at: now,
      });
    }
    tx.update(accRef, { balance: 0, is_active: false, is_closed: true, closed_at: now, updated_at: now });
  });

  await rejectPendingForCompany(input.epf_number, input.company_id, 'Suspense account closed', actor);
  await notifyOwner(input.epf_number, 'suspense_approved', 'Suspense account closed',
    'Your suspense account was closed and settled.', actor);
}

// Approve → settle the company balance to zero (record fund transfer / write-off) and CLOSE
// that company account, then reject its leftover pending items.
export async function approveCloseRequest(args: { id: string; actor: Actor }): Promise<void> {
  const closeRef = doc(db, CLOSES, args.id);
  let ownerEpf = '', companyId = '';
  await runTransaction(db, async (tx) => {
    const cSnap = await tx.get(closeRef);
    if (!cSnap.exists()) throw new Error('Close request not found.');
    const cr = cSnap.data() as SuspenseCloseRequest;
    if (cr.status !== 'pending') throw new Error('This request has already been processed.');
    ownerEpf = cr.epf_number; companyId = cr.company_id;
    const accRef  = doc(db, ACCOUNTS, accountId(cr.epf_number, cr.company_id));
    const accSnap = await tx.get(accRef);
    if (!accSnap.exists()) throw new Error('The account no longer exists.');
    const acc = accSnap.data() as SuspenseAccount;
    if (acc.is_closed) throw new Error('This account is already closed.');
    const bal = money(acc.balance);
    const now = Timestamp.now();
    if (bal !== 0) {
      const ledRef = doc(collection(db, LEDGER));
      tx.set(ledRef, {
        id: ledRef.id, epf_number: acc.epf_number, company_id: acc.company_id, kind: 'settlement' as SuspenseLedgerKind,
        amount: -bal, balance_after: 0, ref_type: 'account', ref_id: args.id,
        note: bal > 0
          ? `Account closed — ${formatSuspenseAmount(bal, acc.currency)} returned to the company via fund transfer`
          : `Account closed — outstanding ${formatSuspenseAmount(-bal, acc.currency)} written off (to reconcile with salary)`,
        actor_epf: args.actor.epf, actor_name: args.actor.name, created_at: now,
      });
    }
    tx.update(accRef, { balance: 0, is_active: false, is_closed: true, closed_at: now, updated_at: now });
    tx.update(closeRef, {
      status: 'approved', considered_by: args.actor.epf, considered_by_name: args.actor.name,
      considered_at: now, updated_at: now,
    });
  });

  await rejectPendingForCompany(ownerEpf, companyId, 'Suspense account closed', args.actor);
  await notifyOwner(ownerEpf, 'suspense_approved', 'Suspense account closed',
    'Your suspense account close request was approved — the account is now closed.', args.actor);
}

export async function rejectCloseRequest(args: { id: string; reason: string; actor: Actor }): Promise<void> {
  const closeRef = doc(db, CLOSES, args.id);
  const snap = await getDoc(closeRef);
  if (!snap.exists()) throw new Error('Close request not found.');
  const cr = snap.data() as SuspenseCloseRequest;
  if (cr.status !== 'pending') throw new Error('This request has already been processed.');
  const now = Timestamp.now();
  await updateDoc(closeRef, {
    status: 'rejected', considered_by: args.actor.epf, considered_by_name: args.actor.name,
    considered_at: now, reject_reason: args.reason || null, updated_at: now,
  });
  // Unfreeze the company account (unless it was already closed by another path).
  const accRef  = doc(db, ACCOUNTS, accountId(cr.epf_number, cr.company_id));
  const accSnap = await getDoc(accRef);
  if (accSnap.exists() && !(accSnap.data() as SuspenseAccount).is_closed) {
    await updateDoc(accRef, { is_active: true, updated_at: now });
  }
  await notifyOwner(cr.epf_number, 'suspense_rejected', 'Close request rejected',
    args.reason ? `Your account close request was rejected: ${args.reason}` : 'Your account close request was rejected.', args.actor);
}

// Reopen a CLOSED account — the exact inverse of the final update in closeAccountNow /
// approveCloseRequest. Closing settles the balance to zero and nothing can move a closed
// account, so the balance is already 0 and is carried over as-is rather than reset: the money
// really was returned to the company, and the ledger already says so.
//
// The whole ledger stays in place, so the history still reads opening → … → settlement →
// reopened, and the approved close doc is left alone as the record of what happened. The
// reopen is written as an 'opening' entry of 0 (exactly what createSuspenseAccount writes)
// rather than a new ledger kind, so every existing statement and month view renders it with no
// change. Guarded inside the transaction: an account that isn't closed must not be touched,
// since clearing is_active on a live account would silently unfreeze a pending close request.
export async function reopenSuspenseAccount(epf: string, companyId: string, actor: Actor): Promise<void> {
  const accRef = doc(db, ACCOUNTS, accountId(epf, companyId));
  let companyName = '';
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(accRef);
    if (!snap.exists()) throw new Error('No suspense account for this company.');
    const acc = snap.data() as SuspenseAccount;
    if (!acc.is_closed) throw new Error('This account is not closed.');
    companyName = acc.company_name;
    const now = Timestamp.now();
    const bal = money(acc.balance);
    tx.update(accRef, { is_active: true, is_closed: false, closed_at: null, updated_at: now });
    const ledRef = doc(collection(db, LEDGER));
    tx.set(ledRef, {
      id: ledRef.id, epf_number: acc.epf_number, company_id: acc.company_id,
      kind: 'opening' as SuspenseLedgerKind, amount: 0, balance_after: bal,
      ref_type: 'account', ref_id: null,
      note: `Account reopened (${acc.company_name})`,
      actor_epf: actor.epf, actor_name: actor.name, created_at: now,
    });
  });
  try {
    await updateDoc(doc(db, 'users', epfDocId(epf)), { has_suspense_account: true, updated_at: Timestamp.now() });
  } catch { /* denormalized flag only — non-critical */ }
  await notifyOwner(epf, 'suspense_approved', 'Suspense account reopened',
    `Your ${companyName} suspense account was reopened — you can submit expenses again.`, actor);
}

// ─── Submissions (expenses) ───────────────────────────────────────────────────
export interface SubmissionInput {
  epf_number:    string;    // the belonger — whose account this bill debits on approval
  employee_name: string;
  // Who's actually filling in this submission — the logged-in actor. Equal to epf_number/
  // employee_name for an ordinary self-submitted bill; different when submitting on another
  // employee's behalf (the "belongs to" picker in the submit form).
  submitted_by_epf:    string;
  submitted_by_name:   string;
  company_id:    string;    // the company this EXPENSE belongs to (debited on approval)
  company_name:  string;
  category?:     string;
  subcategory?:  string;
  type?:         string;
  chamary_id?:   string;    // set when subcategory was picked from the live chamary list
  expense_type:  string;    // derived label ("Category · Subcategory · Type") for legacy display/search
  is_vat?:       boolean;
  vat_number?:   string;
  vat_amount?:   number;
  shop_name:     string;
  item:          string;
  amount:        number;
  bill_date?:    Timestamp;   // when the bill was issued; defaults to now if omitted
  note:          string;
  bill_kind:     'handwritten' | 'printed' | null;
  splits?:       SuspenseSplit[];   // portions charged to other employees (netted off the debit)
}

export async function getMySubmissions(epf: string): Promise<SuspenseSubmission[]> {
  if (!epf) return [];
  const snap = await getDocs(query(collection(db, SUBS), where('epf_number', '==', epf)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as SuspenseSubmission))
    .filter(s => !s.deleted)
    .sort((a, b) => millis(b.created_at) - millis(a.created_at));
}

export async function getPendingSubmissions(): Promise<SuspenseSubmission[]> {
  const snap = await getDocs(query(collection(db, SUBS), where('status', '==', 'pending')));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as SuspenseSubmission))
    .filter(s => !s.deleted)
    .sort((a, b) => millis(a.created_at) - millis(b.created_at));
}

// A chamary's own expenses — a submission belongs to a chamary because it was created with
// chamary_id set (the form sets this automatically when the picked subcategory is a chamary
// whose own category_id matches the chosen category; see ExpenseFields). Single-field where on
// the FK (no composite index), approved + date-windowed in memory — the query the food-deduction
// calc and any "this chamary's spend" view will read.
/**
 * Bills filed against one chamary in a window.
 *
 * `status` decides which of them count, and the two answers are for two different questions:
 *
 *   'approved' (default) — money the organisation has actually accepted. What the reports and
 *                          the month's spend figure mean.
 *   'any'                — every bill somebody filed, pending included. What the food COST
 *                          split means: a bill counts from the moment it is added, because the
 *                          kitchen has already spent that money whether or not anyone has
 *                          signed it off yet. Rejected bills are excluded — a rejected bill is
 *                          one somebody decided was not a cost.
 *
 * A soft-deleted bill never counts in either mode. It used to count in the approved one, which
 * meant deleting a bill left its money in the totals until somebody noticed.
 */
export async function getChamaryExpenses(
  chamaryId: string, fromMs: number, toMs: number,
  opts: { status?: 'approved' | 'any' } = {},
): Promise<SuspenseSubmission[]> {
  if (!chamaryId) return [];
  const wanted = opts.status ?? 'approved';
  // WHICH DATE PUTS A BILL IN A MONTH — and it is not the same question in the two modes.
  //
  // 'approved' is spend reporting: a bill belongs to the month it was signed off in, so it keys
  // on considered_at, exactly as it always has.
  //
  // 'any' is food COST, where the rule is "a bill counts from the moment it is added" — so it
  // keys on created_at alone. considered_at is null until somebody decides on the bill, so
  // keying on it there would move a bill between months the instant it was approved: one filed
  // 29 Sep and approved 2 Oct would price September while pending, then silently vanish out of
  // a SETTLED September into October, to be divided among people who did not eat that food.
  // Not bill_date either — that field is editable and absent on older bills, so it would
  // quietly zero out past months.
  const keyOf = (s: SuspenseSubmission) =>
    (wanted === 'approved' ? millis(s.considered_at ?? s.created_at) : millis(s.created_at));
  const snap = await getDocs(query(collection(db, SUBS), where('chamary_id', '==', chamaryId)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as SuspenseSubmission))
    .filter(s => !s.deleted)
    .filter(s => (wanted === 'approved' ? s.status === 'approved' : s.status !== 'rejected'))
    .filter(s => {
      const at = keyOf(s);
      return at >= fromMs && at <= toMs;
    })
    .sort((a, b) => keyOf(b) - keyOf(a));
}

// Bills whose BILL DATE falls in [fromMs, toMs]. One range filter on a single field, so no
// composite index. Bills written before bill_date existed carry no such field and never match
// here — getSuspenseMonthData merges this with a created_at window so they still surface.
export async function getSubmissionsByBillDate(fromMs: number, toMs: number): Promise<SuspenseSubmission[]> {
  const snap = await getDocs(query(
    collection(db, SUBS),
    where('bill_date', '>=', Timestamp.fromMillis(fromMs)),
    where('bill_date', '<=', Timestamp.fromMillis(toMs)),
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as SuspenseSubmission)).filter(s => !s.deleted);
}

// Bills SUBMITTED in [fromMs, toMs] — the same window getSuspenseSubmissionsReport applies in
// memory, but filtered on the server (that one reads the whole collection when no company is
// given, which is what an approver's month view would otherwise do on every open).
export async function getSubmissionsByCreatedAt(fromMs: number, toMs: number): Promise<SuspenseSubmission[]> {
  const snap = await getDocs(query(
    collection(db, SUBS),
    where('created_at', '>=', Timestamp.fromMillis(fromMs)),
    where('created_at', '<=', Timestamp.fromMillis(toMs)),
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as SuspenseSubmission)).filter(s => !s.deleted);
}

// Every balance movement posted in [fromMs, toMs], across every account — the approver's
// "who was given what, when". Single-field range, no composite index. The ledger is append-only
// (see firestore.rules), so a window read is stable once the month has closed.
export async function getLedgerInWindow(fromMs: number, toMs: number): Promise<SuspenseLedgerEntry[]> {
  const snap = await getDocs(query(
    collection(db, LEDGER),
    where('created_at', '>=', Timestamp.fromMillis(fromMs)),
    where('created_at', '<=', Timestamp.fromMillis(toMs)),
  ));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as SuspenseLedgerEntry))
    .sort((a, b) => millis(b.created_at) - millis(a.created_at));
}

// What the Ledger tab needs for one month: bills dated in the month (by bill date, with the
// submission-date window as the fallback for legacy bills) and every credit posted in it. A bill
// dated last month but submitted this month comes back too — buildSuspenseMonthView drops it by
// day, so the caller need not. Bills are deduped by id there as well.
export async function getSuspenseMonthData(year: number, month: number): Promise<{
  submissions: SuspenseSubmission[]; ledger: SuspenseLedgerEntry[];
}> {
  const fromMs = new Date(year, month - 1, 1).getTime();
  const toMs   = new Date(year, month, 1).getTime() - 1;
  // Bill date ONLY. This used to also fetch the created_at window and merge the two, as a
  // fallback for legacy bills written before bill_date existed — but createSubmission has always
  // written `bill_date: input.bill_date ?? now`, so the field cannot be absent, and a live count
  // found 0 of 358 submissions without it. The second query was therefore fetching 354 documents
  // (~440 KB, essentially the whole collection) on every month load, only for buildSuspenseMonthView
  // to drop every one of them again by bill day. It was the single heaviest read on the page.
  //
  // If a bill ever does turn up with no bill_date it will be invisible here — billDayOf falls back
  // to created_at, so re-adding getSubmissionsByCreatedAt would surface it again.
  const [submissions, ledger] = await Promise.all([
    getSubmissionsByBillDate(fromMs, toMs),
    getLedgerInWindow(fromMs, toMs),
  ]);
  const byId = new Map<string, SuspenseSubmission>();
  for (const s of submissions) if (!byId.has(s.id)) byId.set(s.id, s);
  return { submissions: [...byId.values()], ledger };
}

// All submissions for the suspense report — scoped by company (single-field query) when given,
// then filtered to the [fromMs, toMs] window (by created_at) in memory. Employee/status filtering
// is done client-side by the report UI. Newest first.
export async function getSuspenseSubmissionsReport(opts: { companyId?: string; fromMs?: number; toMs?: number }): Promise<SuspenseSubmission[]> {
  const q = opts.companyId
    ? query(collection(db, SUBS), where('company_id', '==', opts.companyId))
    : query(collection(db, SUBS));
  const snap = await getDocs(q);
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as SuspenseSubmission))
    .filter(s => {
      if (s.deleted) return false;
      const at = millis(s.created_at);
      if (opts.fromMs != null && at < opts.fromMs) return false;
      if (opts.toMs   != null && at > opts.toMs) return false;
      return true;
    })
    .sort((a, b) => millis(b.created_at) - millis(a.created_at));
}

// SHA-256 of the file bytes — the fingerprint used to detect a re-uploaded bill.
async function fileSha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// A bill's OneDrive/Firebase path: {company}/{year}/{month}/{billNo}-{employee}-{epf}.{ext}, where
// billNo is the submission's own Firestore doc id (there's no separate invoice-number concept) and
// year/month are the UPLOAD date — matches /api/cloud-storage/file's scoping check, which requires
// the item to sit under a 4-digit year folder followed by a 2-digit month folder.
function billFilePath(companyName: string, employeeName: string, epf: string, billNo: string, originalFileName: string, isPdf: boolean): string {
  const now = new Date();
  const year  = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const dot = originalFileName.lastIndexOf('.');
  const ext = dot >= 0 ? originalFileName.slice(dot).toLowerCase() : (isPdf ? '.pdf' : '');
  const fileName = `${seg(billNo)}-${seg(employeeName) || 'user'}-${seg(epf) || 'epf'}${ext}`;
  return `${seg(companyName) || 'company'}/${year}/${month}/${fileName}`;
}

/** The day printed on a bill being submitted (YYYY-MM-DD). An omitted bill_date means today —
 *  that is what createSubmission writes — so it must mean today here too, or a bill filed with
 *  no date would be compared against the epoch and match nothing. */
function candidateBillDay(billDate: Timestamp | null | undefined): string {
  return localDayKey(msOf(billDate) ?? Date.now());
}

// Duplicate-bill guard across the submitter's OWN bills in the last 30 days. The rule itself
// lives in src/lib/billDuplicates.ts (pure, unit-tested) — read the header there. In short: the
// BILL DATE is checked first and decides on its own, and only among bills of that same date
// does the file hash or the shop/VAT + amount identity get a say. This function only does the
// reading and the refusing. `excludeId` skips the row being edited.
async function assertNotDuplicateBill(
  epf: string,
  candidate: CandidateBill,
  excludeId?: string,
): Promise<void> {
  const cutoffMs = Timestamp.now().toMillis() - DUPLICATE_WINDOW_MS;
  const snap = await getDocs(query(collection(db, SUBS), where('epf_number', '==', epf)));
  const existing: ExistingBill[] = snap.docs.map(d => {
    const s = d.data() as SuspenseSubmission;
    return {
      id: d.id,
      billHash: s.bill_hash,
      amount: money(s.amount),
      shop: s.shop_name,
      vatNumber: s.vat_number,
      day: billDayOf(s),
      status: s.status,
      deleted: s.deleted,
      createdMs: millis(s.created_at),
    };
  });

  const hit = findDuplicateBill(candidate, existing, { cutoffMs, excludeId });
  if (!hit) return;

  const filed = new Date(hit.bill.createdMs).toLocaleDateString();
  // Two different mistakes, two different sentences: one is "you uploaded that photo twice",
  // the other is "you already claimed that purchase". Both name the bill date the guard matched
  // on, because a mistyped date is the likeliest reason an honest bill lands here at all —
  // "check the bill date", never "change it", since the date has to say what the bill says.
  throw new Error(hit.reason === 'file'
    ? `This exact bill image was already submitted for ${candidate.day} on ${filed} (${hit.bill.status}). The same image can’t be sent twice for one date.`
    : `A bill dated ${candidate.day} from ${hit.reason === 'vat' ? `VAT ${candidate.vatNumber}` : candidate.shop} for the same amount was already submitted on ${filed} (${hit.bill.status}). Check the bill date if this is a different purchase.`);
}

export async function createSubmission(input: SubmissionInput, bill?: File | null): Promise<{ id: string; bill_no: string }> {
  // If a company account already exists it must be usable; if it doesn't, the submission is
  // still allowed — the account is auto-created when it's approved (executive other-company).
  if (!bill || bill.size === 0) throw new Error('A bill is required.');

  // The account check and the file hash need nothing from each other, and on a phone they are a
  // network round trip and a multi-megabyte digest respectively — run them together rather than
  // making the submitter wait for one and then the other.
  const [acc, billHash] = await Promise.all([
    getSuspenseAccount(input.epf_number, input.company_id),
    fileSha256(bill),
  ]);
  if (acc?.is_closed) throw new Error('The account for this company is closed.');
  if (acc && !acc.is_active) throw new Error('The account for this company is frozen (a close request is pending).');

  // Block a re-submitted bill — same bill date first, then the same file or the same shop and
  // amount — within the last month, BEFORE uploading, so a duplicate never reaches cloud storage.
  await assertNotDuplicateBill(input.epf_number, {
    billHash,
    amount:    money(input.amount),
    shop:      input.shop_name,
    vatNumber: input.is_vat ? (input.vat_number ?? '') : '',
    day:       candidateBillDay(input.bill_date),
  });

  // Everything that can be refused from the input alone is refused BEFORE the upload, for the
  // same reason the duplicate check is: a throw after uploadCloudFile leaves the file sitting in
  // cloud storage with no document that will ever point at it, and the submitter's natural
  // response — fix the amount, submit again — leaves another one. updateSubmission already
  // validates in this order; create was the odd one out.
  const splits = cleanSplits(input.splits);
  if (splitsTotal(splits) > money(input.amount)) {
    throw new Error('The amount split to other employees cannot exceed the bill amount.');
  }

  // VAT is money too — round to 2dp and refuse a negative or oversized figure.
  const vatAmount = money(input.vat_amount ?? 0);
  if (vatAmount < 0) throw new Error('VAT amount can’t be negative.');
  if (input.is_vat && vatAmount > money(input.amount)) throw new Error('VAT amount can’t exceed the bill amount.');

  // Pre-allocate the doc id (same pattern as the ledger's own pre-allocated refs elsewhere in
  // this file) so the uploaded file can be named after it — the bill's "billNo".
  const ref = doc(collection(db, SUBS));
  const up = await uploadCloudFile(bill, {
    epf: input.epf_number, name: input.employee_name, prefix: 'suspense',
    customPath: billFilePath(input.company_name, input.employee_name, input.epf_number, ref.id, bill.name, bill.type === 'application/pdf'),
  });
  const bill_url = up.url, bill_type = up.type, bill_name = up.name, bill_provider = up.provider;

  // Bill number allocation must be atomic with the doc write (same reasoning as voucher numbers)
  // so two concurrent submissions can never end up with the same number.
  let billNo = '';
  await runTransaction(db, async (tx) => {
    const now = Timestamp.now();
    // Numbered against the EXPENSE's company (input.company_id — the account this bill debits),
    // not the submitter's own, so an executive filing for another company lands in that company's
    // run. Because the number can't be reissued once it's out on a printed/exported bill, an edit
    // that would move a numbered bill to a different company is REFUSED rather than renumbered —
    // see updateSubmission.
    const issued = await nextBillNo(tx, input.company_id, now.toDate());
    billNo = issued.bill_no;
    tx.set(ref, {
      ...input,
      id:                 ref.id,
      bill_no:            billNo,
      bill_no_scope:      issued.scope,
      bill_seq:           issued.seq,
      previous_bill_no:   null,
      renumbered_at:      null,
      amount:             money(input.amount),
      // Firestore rejects a literal `undefined` field value — chamary_id is the one genuinely
      // optional field in SubmissionInput (unset unless the category links to chamaries), so
      // normalize it explicitly rather than let the ...input spread carry undefined through.
      chamary_id:         input.chamary_id ?? null,
      // Same normalize-explicitly reasoning as chamary_id — falls back to the submission time
      // when the bill has no legible date on it (or a date couldn't be read at all).
      bill_date:          input.bill_date ?? now,
      is_vat:             !!input.is_vat,
      vat_number:         input.is_vat ? (input.vat_number ?? '').trim() : '',
      vat_amount:         input.is_vat ? vatAmount : 0,
      splits,
      split_epfs:         splits.map(s => s.epf_number),
      bill_url, bill_type, bill_name, bill_provider, bill_hash: billHash,
      status:             'pending',
      considered_by:      null,
      considered_by_name: null,
      considered_at:      null,
      reject_reason:      null,
      created_at:         now,
      updated_at:         now,
    });
  });
  // Fire-and-forget — the bill is already committed; the trail must never hold up its return.
  logBillEvent({
    submission_id: ref.id, event: 'created', bill_no: billNo,
    actor: { epf: input.submitted_by_epf || input.epf_number, name: input.submitted_by_name || input.employee_name },
  });
  return { id: ref.id, bill_no: billNo };
}

// Editing a PENDING submission just updates it in place. Editing a REJECTED one is treated as
// fixing-and-resubmitting: the same edit also sends it back to 'pending' and clears the old
// verdict (considered_by/_name/_at, reject_reason), so it reappears in the approver's queue as a
// fresh item. Approved or cancelled (soft-deleted) submissions can no longer be edited at all.
export async function updateSubmission(
  id: string,
  patch: { category?: string; subcategory?: string; type?: string; chamary_id?: string | null; expense_type?: string; is_vat?: boolean; vat_number?: string; vat_amount?: number; shop_name?: string; item?: string; amount?: number; bill_date?: Timestamp; note?: string; bill_kind?: 'handwritten' | 'printed' | null; company_id?: string; company_name?: string; splits?: SuspenseSplit[] },
  uploader: { epf: string; name: string },
  bill?: File | null,
): Promise<void> {
  const cur = (await getDoc(doc(db, SUBS, id))).data() as SuspenseSubmission | undefined;
  if (!cur) throw new Error('Submission not found.');
  if (cur.deleted) throw new Error('This submission was cancelled and can no longer be edited.');
  if (cur.status === 'approved') throw new Error('An approved expense can no longer be edited.');
  const wasRejected = cur.status === 'rejected';

  // A current-scheme number belongs to ONE company's run (bill_no_scope = company + fiscal year)
  // and the report reads a run back by company_id — so moving a numbered bill to another company
  // lands its number in a run that never issued it (that company's report then shows two rows
  // numbered "3") while the bill still occupies a slot in the old run for a cancellation there to
  // renumber. Refusing the move is the only resolution that can't reissue a number already on a
  // printed or exported bill; cancel-and-refile does the same thing correctly, freeing the slot in
  // the old run through the tested backfill path and drawing a fresh number in the new one.
  // Only current-scheme bills are held: a legacy "YYMM<epf>####" number belongs to no run, and the
  // edit dialog always sends company_id, so an unchanged one must stay a no-op (approvers edit
  // bills inline while reviewing them).
  if (patch.company_id !== undefined && patch.company_id !== cur.company_id
      && cur.bill_no_scope && billSlotOf(cur) !== null) {
    throw new Error('This bill already holds a number in its company’s bill run — cancel it and submit it again under the other company.');
  }

  const data: Record<string, unknown> = { ...patch, updated_at: Timestamp.now() };
  if (patch.amount !== undefined) data.amount = money(patch.amount);
  if (patch.vat_amount !== undefined) {
    const v = money(patch.vat_amount);
    if (v < 0) throw new Error('VAT amount can’t be negative.');
    data.vat_amount = v;
  }

  // Enforce Σsplits ≤ amount against the EFFECTIVE values whenever either side changes, so an
  // amount-only or splits-only edit can't leave an oversized split (a negative debit on approval).
  if (patch.amount !== undefined || patch.splits !== undefined) {
    const effSplits = patch.splits !== undefined ? cleanSplits(patch.splits) : cleanSplits(cur.splits);
    const effAmount = patch.amount  !== undefined ? money(patch.amount)      : money(cur.amount ?? 0);
    if (splitsTotal(effSplits) > effAmount) {
      throw new Error('The amount split to other employees cannot exceed the bill amount.');
    }
    if (patch.splits !== undefined) {
      data.splits = effSplits;
      data.split_epfs = effSplits.map(s => s.epf_number);
    }
  }
  const hasBill = !!(bill && bill.size > 0);
  if (hasBill) {
    // Same duplicate guard as create — the bill date first, then the file or the shop/VAT and
    // amount — against the submitter's other bills in the last month (excluding this row). Every
    // field is the EFFECTIVE one: the patch where it changes a value, the stored bill where it
    // does not, so a file-only replacement is still checked against what the bill actually says
    // — including its date, which is what now decides whether anything is compared at all.
    const billHash  = await fileSha256(bill!);
    const effIsVat  = patch.is_vat ?? cur.is_vat ?? false;
    await assertNotDuplicateBill(cur.epf_number ?? uploader.epf, {
      billHash,
      amount:    money(patch.amount ?? cur.amount ?? 0),
      shop:      patch.shop_name ?? cur.shop_name ?? '',
      vatNumber: effIsVat ? (patch.vat_number ?? cur.vat_number ?? '') : '',
      // billDayOf's own fallback: the date on the bill, else the day it was filed.
      day:       billDayOf({ bill_date: patch.bill_date ?? cur.bill_date, created_at: cur.created_at }),
    }, id);
    // Named after the BILL'S OWNER (cur), not whoever is uploading — an approver can replace a
    // bill inline while reviewing it, and the filename should still read as the submitter's.
    const effCompanyName = patch.company_name ?? cur.company_name;
    const up = await uploadCloudFile(bill!, {
      epf: uploader.epf, name: uploader.name, prefix: 'suspense',
      customPath: billFilePath(effCompanyName, cur.employee_name, cur.epf_number, id, bill!.name, bill!.type === 'application/pdf'),
    });
    data.bill_url = up.url; data.bill_type = up.type; data.bill_name = up.name; data.bill_provider = up.provider; data.bill_hash = billHash;
  }

  if (wasRejected) {
    data.status = 'pending';
    data.considered_by = null; data.considered_by_name = null; data.considered_at = null; data.reject_reason = null;
  }
  await updateDoc(doc(db, SUBS, id), data);
  // Neither branch above touches bill_no/bill_seq/bill_no_scope — a resubmitted bill KEEPS the
  // number it was first issued (it may already be on paper), and `patch` has no way to reach those
  // fields. That is safe only because the guard at the top refuses the one edit that would put the
  // number and the run out of step: moving a numbered bill to another company.
  // Fire-and-forget, never awaited — see logBillEvent. The edit is already committed.
  logBillEvent({
    submission_id: id,
    event:    wasRejected ? 'resubmitted' : 'edited',
    bill_no:  cur.bill_no ?? null,
    changes:  trackedChanges(cur, data),
    note:     hasBill ? 'bill file replaced' : null,
    actor:    { epf: uploader.epf, name: uploader.name },
  });
}

// Soft delete — the submitter cancelling a pending draft, or withdrawing a rejected bill they
// don't intend to fix and resubmit. Never a hard delete: the doc stays for audit purposes but is
// filtered out of every normal read (getMySubmissions/getPendingSubmissions/the report). An
// approved submission can't be cancelled this way — it's already money that moved.
//
// Cancelling also keeps the bill's numbering run GAP-FREE: the run's highest un-approved bill
// drops into the freed slot (planBillBackfill), inside the same transaction as the cancel so a
// concurrent submission can't be handed the number that's being reused.
export async function deleteSubmission(id: string, actor: Actor): Promise<void> {
  const subRef = doc(db, SUBS, id);
  const snap = await getDoc(subRef);
  if (!snap.exists()) return;
  const cur = { id, ...snap.data() } as SuspenseSubmission;
  if (cur.status === 'approved') throw new Error('An approved expense can no longer be cancelled.');

  // Already cancelled → re-stamp as before, but never re-run the backfill: this bill's slot was
  // freed the first time round and another bill may already be sitting in it.
  let plan = cur.deleted ? null : await planBillBackfill(cur);
  // Held in arrays, not plain `let`s: they're assigned inside the transaction callback, which
  // control-flow analysis can't see, so a nullable local would read as `never` afterwards.
  const moved: { id: string; from: string | null; to: string }[] = [];
  // The freshest read of the bill, carried OUT of a failed attempt so the re-plan below works from
  // what the transaction actually saw. Re-planning from `cur` could never match: its bill_seq is
  // the one captured before the loop, so the in-transaction gate compares it against a doc that has
  // since moved, every attempt fails the same way, and the gap is left open for nothing.
  const seen: SuspenseSubmission[] = [];
  let gapNote: string | null = plan?.blocked ? plan.blocked_reason : null;

  // Each attempt re-verifies the plan inside the transaction and aborts on any drift, then re-plans
  // against the fresh picture. After the last one the cancel still goes through, just without a
  // renumber — a gap is recoverable and visible in the trail; a duplicated bill number is neither.
  // This budget only ever counts BILL_SLOT_RACED, i.e. drift this code detected itself; Firestore's
  // own ABORTED contention retries happen inside runTransaction and are left entirely to the SDK.
  for (let attempt = 0; ; attempt++) {
    try {
      await runTransaction(db, async (tx) => {
        // The SDK re-runs this callback on contention, so it must stay idempotent — reset anything
        // collected here at the top of the attempt rather than outside runTransaction.
        moved.length = 0;
        // Every read first — Firestore forbids a read after a write in the same transaction.
        const fresh = await tx.get(subRef);
        if (!fresh.exists()) return;
        const live = { id, ...fresh.data() } as SuspenseSubmission;
        seen[0] = live;
        if (live.status === 'approved') throw new Error('An approved expense can no longer be cancelled.');

        // A blocked plan writes nothing but the cancel itself, so it never reads the counter and
        // never compare-and-sets it — that would be a read and a race on a document it will not touch.
        const counterRef  = plan && !plan.blocked ? doc(db, BILL_COUNTERS, plan.scope) : null;
        const counterSnap = counterRef ? await tx.get(counterRef) : null;
        const moveRef     = plan?.move_id ? doc(db, SUBS, plan.move_id) : null;
        const moveSnap    = moveRef ? await tx.get(moveRef) : null;

        if (plan) {
          // Compare-and-set. The plan came from a query, which a transaction can't run, so it is
          // only honoured against the exact counter value and candidate bill it was built from —
          // any drift means a concurrent submission/cancel/approval and the plan is thrown away.
          if (counterRef) {
            const seqNow = counterSnap?.exists() ? (Number(counterSnap.data().seq) || 0) : 0;
            if (seqNow !== plan.counter_seq) throw new Error(BILL_SLOT_RACED);
          }
          if (live.deleted || live.bill_no_scope !== plan.scope || billSlotOf(live) !== plan.slot) {
            throw new Error(BILL_SLOT_RACED);
          }
          if (moveRef) {
            const m = moveSnap?.exists() ? { id: moveRef.id, ...moveSnap.data() } as SuspenseSubmission : null;
            if (!m || m.deleted || billNumberFrozen(m) || m.bill_no_scope !== plan.scope
                || billSlotOf(m) !== plan.move_from_slot || (m.bill_no ?? null) !== plan.move_from_no) {
              throw new Error(BILL_SLOT_RACED);
            }
          }
        }

        const now = Timestamp.now();
        tx.update(subRef, {
          deleted: true, deleted_at: now, deleted_by: actor.epf, deleted_by_name: actor.name,
          updated_at: now,
        });
        if (plan && moveRef) {
          tx.update(moveRef, {
            bill_no: String(plan.slot), bill_seq: plan.slot,
            previous_bill_no: plan.move_from_no, renumbered_at: now, updated_at: now,
          });
          moved.push({ id: moveRef.id, from: plan.move_from_no, to: String(plan.slot) });
        }
        // Leave the counter pointing at the highest slot still occupied, so the next submission
        // fills the top of the run instead of opening a fresh hole above it.
        if (plan && counterRef && plan.new_counter_seq != null && plan.new_counter_seq !== plan.counter_seq) {
          tx.set(counterRef, { seq: plan.new_counter_seq }, { merge: true });
        }
      });
      break;
    } catch (e) {
      if ((e as Error)?.message !== BILL_SLOT_RACED) throw e;
      if (attempt >= 2) {
        // Out of retries: cancel without renumbering. With no plan there is nothing left to race
        // on, so the next pass is the last one.
        plan = null;
        gapNote = 'Slot left open — the run kept changing while this bill was being cancelled.';
        continue;
      }
      // Re-plan against the bill as the failed attempt saw it, never the pre-loop snapshot. Already
      // cancelled under us → nothing left to backfill, exactly as the pre-loop check decides.
      const latest = seen[0] ?? cur;
      plan = latest.deleted ? null : await planBillBackfill(latest);
      gapNote = plan?.blocked ? plan.blocked_reason : null;
    }
  }

  // Fire-and-forget, never awaited — see logBillEvent. The cancel and any renumber are already
  // committed; a trail write that can't settle must not hold the caller (and the UI) behind it.
  // The number this bill actually held when it was cancelled. `cur` was read before the retry
  // loop, and a concurrent cancel can renumber THIS bill underneath us, so the committed value is
  // the one the last attempt saw. Logging `cur` here would name a number the bill no longer held,
  // in the very record that exists to say which bill held which number.
  const atCancel = seen[0] ?? cur;
  logBillEvent({ submission_id: id, event: 'deleted', bill_no: atCancel.bill_no ?? null, actor });
  const took = moved[0];
  if (took) {
    logBillEvent({
      submission_id: took.id, event: 'renumbered', bill_no: took.to, previous_bill_no: took.from,
      related_submission_id: id, note: `Took the slot freed by bill ${atCancel.bill_no ?? id}.`, actor,
    });
  } else if (gapNote) {
    logBillEvent({
      submission_id: id, event: 'gap_left_open', bill_no: atCancel.bill_no ?? null,
      related_submission_id: id, note: gapNote, actor,
    });
  }
}

// ─── Keeping a bill numbering run gap-free ────────────────────────────────────
// A bill's number is FROZEN once it has been approved — it is already on a voucher and in the
// exports, so it can never be moved into another slot or reused. voucher_id is the durable half of
// the test: it is stamped on approval and never cleared, so a bill that was EVER approved still
// reads as frozen.
function billNumberFrozen(s: SuspenseSubmission): boolean {
  return s.status === 'approved' || !!s.voucher_id;
}

// The slot a bill occupies in its run, or null for a legacy "YYMM<epf>####" number (and for any
// malformed value) — never throws, so an old or half-written row simply sits out the density maths.
function billSlotOf(s: SuspenseSubmission): number | null {
  return readBillSlot(s.bill_seq);
}

// Thrown out of the cancel transaction when the picture the plan was built from moved underneath
// it — the counter advanced, or the bill picked to backfill was itself cancelled/approved/moved.
const BILL_SLOT_RACED = 'suspense/bill-slot-raced';

interface BackfillPlan {
  scope:           string;
  slot:            number;          // the slot being freed
  // Counter value this plan was built against (compare-and-set), and where it ends up. Both null
  // on a BLOCKED plan, which never reads or writes the counter — see planBillBackfill.
  counter_seq:     number | null;
  move_id:         string | null;   // the bill that takes the freed slot, if one can
  move_from_slot:  number | null;
  move_from_no:    string | null;
  new_counter_seq: number | null;   // highest slot still occupied once the plan is applied
  blocked:         boolean;         // the hole can't be closed — see blocked_reason
  blocked_reason:  string | null;
}

// Work out how to keep a run gap-free when `sub` is cancelled. WHICH bill moves and where the
// counter lands are decided by the pure functions in src/lib/billNumbering.ts (unit-tested without
// Firestore); this reads the picture they decide against and nothing more.
//
// This reads the whole run, which a transaction cannot do (transactions don't support where()), so
// nothing it decides is trusted at write time — deleteSubmission re-verifies every part of the
// plan with tx.get() before touching anything.
//
// READ COST. One run query per plan, and one counter read only when the plan will actually write
// the counter — a blocked plan touches neither the counter document nor the compare-and-set that
// guards it, so a frozen bill above the hole costs exactly one query and can no longer burn retries
// on a counter it was never going to write. Reading only the top of the run instead of all of it
// would need a composite index this file can't add: suspense_submissions (bill_no_scope ASC,
// bill_seq DESC), which would allow orderBy('bill_seq','desc') + limit() under the equality filter.
// Until that index exists the query stays index-free and reads the whole run.
async function planBillBackfill(sub: SuspenseSubmission): Promise<BackfillPlan | null> {
  const scope = sub.bill_no_scope;
  if (!scope || billSlotOf(sub) === null) return null;   // legacy-numbered bill — don't even query

  // Single-field equality, so it rides the automatic index; legacy bills carry no bill_no_scope
  // at all and are therefore never returned.
  const runSnap = await getDocs(query(collection(db, SUBS), where('bill_no_scope', '==', scope)));
  const run = runSnap.docs
    .map(d => ({ id: d.id, ...d.data() } as SuspenseSubmission))
    .filter(s => s.id !== sub.id && !s.deleted)
    .map(s => ({ id: s.id, slot: billSlotOf(s), bill_no: s.bill_no ?? null, frozen: billNumberFrozen(s) }));

  const move = planBillBackfillMove({ scope, seq: sub.bill_seq }, run);
  if (!move) return null;
  if (move.blocked) {
    return {
      scope, slot: move.slot, counter_seq: null, move_id: null, move_from_slot: null,
      move_from_no: null, new_counter_seq: null, blocked: true, blocked_reason: move.blocked_reason,
    };
  }

  const counterSnap = await getDoc(doc(db, BILL_COUNTERS, scope));
  return {
    scope, slot: move.slot,
    counter_seq:     counterSnap.exists() ? (Number(counterSnap.data().seq) || 0) : 0,
    move_id:         move.move_id,
    move_from_slot:  move.move_from_slot,
    move_from_no:    move.move_from_no,
    new_counter_seq: nextCounterSeq(move, run),
    blocked:         false,
    blocked_reason:  null,
  };
}

const VOUCHER_COUNTERS = 'suspense_voucher_counters';
const BILL_COUNTERS    = 'suspense_bill_counters';

// Fiscal year starts in April — Jan/Feb/Mar belong to the PREVIOUS calendar year's fiscal year
// (e.g. Feb 2026 is fiscal year "2025", running Apr 2025 – Mar 2026).
function fiscalYearKey(d: Date): string {
  const y = d.getFullYear();
  return String(d.getMonth() + 1 >= 4 ? y : y - 1);
}

// Atomically allocates the next VOUCHER number for the current fiscal year: "YYMM####", where
// YY/MM are the ACTUAL date (not the fiscal-year label) and #### is a 4-digit sequence that counts
// continuously across the fiscal year and resets to 1 each April. One shared counter across all
// employees — matches how a paper voucher book is numbered. Bills have their own scheme and their
// own counter collection (see nextBillNo), so the two sequences never interfere. Must be called
// inside the same transaction that creates the numbered doc, so the counter and the doc never
// drift apart even under concurrent writes (Firestore transactions allow reads on one ref then
// writes on others, as long as all reads happen before any writes on that same transaction).
async function nextSequenceNo(tx: Transaction, counterCollection: string, now: Date): Promise<string> {
  const seq = await bumpCounter(tx, counterCollection, fiscalYearKey(now));
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `${yy}${mm}${String(seq).padStart(4, '0')}`;
}

// The read-increment-write both numbering schemes share, split out of nextSequenceNo so bill
// numbers can key their counter differently (per company + fiscal year) without a second copy of
// the increment. Same transaction rules apply — call it before this transaction's first write.
async function bumpCounter(tx: Transaction, counterCollection: string, counterId: string): Promise<number> {
  const ref  = doc(db, counterCollection, counterId);
  const snap = await tx.get(ref);
  const seq  = (snap.exists() ? (snap.data().seq as number) : 0) + 1;
  tx.set(ref, { seq }, { merge: true });
  return seq;
}

// The counter run a bill's number belongs to: ONE continuous sequence PER COMPANY PER FISCAL
// YEAR, resetting each April with the fiscal year itself. Doubles as the BILL_COUNTERS doc id and
// as the value stamped on the submission (SuspenseSubmission.bill_no_scope), so "which run is this
// number from" is answerable from the bill alone. Company ids are Firestore doc ids, so they can't
// contain the '/' that would break the path; the `__` separator keeps the two halves readable.
function billScopeKey(companyId: string, now: Date): string {
  return `${companyId || 'unknown'}__${fiscalYearKey(now)}`;
}

// Bill numbers are a PLAIN DENSE COUNTER within their run — "1", "2", "3", … — not the composite
// "YYMM…" string vouchers use, because the whole point of the scheme is that a finished set reads
// 1,2,3,4 with no gaps (a cancelled bill's number is taken over by another bill; see
// deleteSubmission). That density is only meaningful WITHIN one run, so a number is unique per
// (bill_no_scope, bill_no) pair and never on its own — two companies each have a bill "1".
// Bills numbered under the previous per-employee-per-month scheme ("YYMM<epf>####") keep those
// numbers untouched and carry no scope/seq, which is exactly what keeps them out of the density
// bookkeeping here. Their old counter docs in BILL_COUNTERS are simply abandoned — the doc ids
// can't collide, being keyed by epf+YYMM rather than company+fiscal year.
//
// CONTENTION CEILING — KNOWN AND ACCEPTED. This scope puts every bill a company files in a fiscal
// year through ONE counter document, written by every submission and again by every cancellation
// that steps the counter back. Firestore sustains roughly ONE WRITE PER SECOND per document, so a
// month-end filing peak in a busy company will produce ABORTED transactions. That is left entirely
// to the SDK's own retry inside runTransaction (5 attempts by default, backed off) and nothing here
// may defeat it: each transaction body re-reads the counter and re-derives its number on every
// attempt, holds no side effect that would repeat (the doc write is a tx.set on a ref allocated
// outside), and deleteSubmission's own retry budget counts only BILL_SLOT_RACED — never contention
// — so it can never fire before the SDK has finished retrying. A wider scope (per employee, per
// month) would raise the ceiling but is a business decision about how bills are numbered, not a
// performance knob to turn here.
async function nextBillNo(tx: Transaction, companyId: string, now: Date): Promise<{ bill_no: string; seq: number; scope: string }> {
  const scope = billScopeKey(companyId, now);
  const seq   = await bumpCounter(tx, BILL_COUNTERS, scope);
  return { bill_no: String(seq), seq, scope };
}

// ─── Bill audit trail ─────────────────────────────────────────────────────────
// Append one suspense_bill_events doc. BEST-EFFORT BY DESIGN: this trail records what happened,
// it never decides whether something may happen, so a failed write (offline, quota, rules) is
// warned about and swallowed. A bill must never fail to save, cancel or move because its log entry
// didn't land — and nothing reads these events back, so no caller can depend on one existing.
//
// RETURNS void, NOT A PROMISE, on purpose: it must be impossible to await. With offline
// persistence (persistentLocalCache — see src/lib/firebase.ts) a setDoc promise does not settle
// while the client is offline; the write is queued and the doc reads back locally, but the promise
// only resolves once it reaches the server. An awaited call here would therefore hang the
// already-committed operation it describes — the bill cancelled, another bill renumbered
// server-side, and the caller never returning — and no try/catch can rescue a promise that never
// settles. Fire it and forget it.
function logBillEvent(e: {
  submission_id:          string;
  event:                  SuspenseBillEventKind;
  bill_no:                string | null;
  previous_bill_no?:      string | null;
  related_submission_id?: string | null;
  changes?:               SuspenseBillEventChange[];
  note?:                  string | null;
  actor:                  Actor;
}): void {
  const warn = (err: unknown) => console.warn('[suspense] bill event not logged:', e.event, e.submission_id, err);
  try {
    const ref = doc(collection(db, BILL_EVENTS));
    void setDoc(ref, {
      id:                    ref.id,
      submission_id:         e.submission_id,
      event:                 e.event,
      bill_no:               e.bill_no ?? null,
      previous_bill_no:      e.previous_bill_no ?? null,
      related_submission_id: e.related_submission_id ?? null,
      changes:               e.changes ?? [],
      note:                  e.note ?? null,
      actor_epf:             e.actor.epf,
      actor_name:            e.actor.name,
      created_at:            Timestamp.now(),
    }).catch(warn);
  } catch (err) {
    warn(err);
  }
}

// The fields an 'edited'/'resubmitted' event keeps a before/after of — the ones that change what
// the bill IS (money, taxonomy, supplier, date). note/bill file/company are deliberately left out.
const EDIT_TRACKED_FIELDS = [
  'amount', 'category', 'subcategory', 'type', 'expense_type',
  'is_vat', 'vat_amount', 'vat_number', 'shop_name', 'item', 'bill_date',
] as const;

// Render any submission field as a comparable display string — Timestamps included, which is why
// this can't just be String(). Never throws on an unexpected shape.
function eventValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  const ms = (v as { toMillis?: () => number })?.toMillis?.();
  if (typeof ms === 'number') return new Date(ms).toISOString();
  try { return JSON.stringify(v) ?? ''; } catch { return ''; }
}

// Before/after for the tracked fields only, and only where the rendered value actually moved —
// an edit that re-saves the same values logs an event with no changes rather than a wall of noise.
function trackedChanges(before: SuspenseSubmission, after: Record<string, unknown>): SuspenseBillEventChange[] {
  const out: SuspenseBillEventChange[] = [];
  for (const f of EDIT_TRACKED_FIELDS) {
    if (!(f in after)) continue;
    const b = eventValue((before as unknown as Record<string, unknown>)[f]);
    const a = eventValue(after[f]);
    if (b !== a) out.push({ field: f, before: b, after: a });
  }
  return out;
}

// ─── Float limits (see src/lib/suspenseLimits.ts) ─────────────────────────────
// One doc under suspense_settings holds every rule: company defaults plus department, position,
// role and per-person ceilings. Read fresh on every approval — a limit an admin just tightened
// must bind the very next approval, and this is one small read against a money decision.
const LIMITS_DOC = 'limits';

export async function getSuspenseLimits(): Promise<SuspenseLimitConfig> {
  try {
    const snap = await getDoc(doc(db, SETTINGS, LIMITS_DOC));
    return normalizeLimitConfig(snap.exists() ? snap.data() : null);
  } catch { return normalizeLimitConfig(null); }
}

export async function saveSuspenseLimits(config: SuspenseLimitConfig, actor: Actor): Promise<void> {
  const clean = normalizeLimitConfig(config);
  await setDoc(doc(db, SETTINGS, LIMITS_DOC), {
    ...clean, updated_at: Timestamp.now(), updated_by: actor.epf, updated_by_name: actor.name,
  });
}

/** The limit that applies to one person's account, resolved from their live profile (role,
 *  designation, department) and the company the account belongs to. */
export async function resolveLimitForEpf(epf: string, companyId: string): Promise<ResolvedLimit> {
  if (!epf) return { limit: null, source: null, key: null };
  const [config, user] = await Promise.all([getSuspenseLimits(), getUserByEpf(epf).catch(() => null)]);
  return resolveSuspenseLimit(config, {
    epf, role: user?.role ?? null, designation: user?.designation ?? null,
    department: user?.department ?? null, company_id: companyId || user?.company_id || null,
  });
}

/** The line an approver reads when a credit would breach a limit. Exported so the UI can show
 *  the same words before the click that the service throws after it. */
export function describeLimitBreach(name: string, resolved: ResolvedLimit, balanceBefore: number, balanceAfter: number, currency = SUSPENSE_CURRENCY): string {
  const room = Math.max(0, limitHeadroom(resolved.limit, balanceBefore) ?? 0);
  return `This would put ${name}'s float at ${formatSuspenseAmount(balanceAfter, currency)}, over their ${resolved.source ? LIMIT_SOURCE_LABEL[resolved.source] : 'limit'} of ${formatSuspenseAmount(resolved.limit ?? 0, currency)}. Grant at most ${formatSuspenseAmount(room, currency)}, or override with a reason.`;
}

// Read fresh each time rather than cached — this rarely changes and correctness (an approval
// landing in the right voucher) matters far more than saving one small read.
// Approving ONE bill used to read the voucher mode twice and the category taxonomy twice — the
// preview does both, then addApprovedBillToVoucher does both again — on top of two voucher
// queries and the transaction, all in series. That is eight sequential round trips for a single
// click, three of them fetching the very same two documents; on a phone it is most of the wait.
// Both are near-static config, so a short TTL collapses the repeats without going stale in any
// way an approver would notice. setVoucherMode clears it immediately.
const CONFIG_TTL_MS = 60_000;
let voucherModeCache: { at: number; value: VoucherMode } | null = null;
const categoryIsolateCache = new Map<string, { at: number; value: boolean }>();
/** Drop the cached voucher mode / category flags — called after anything that changes them. */
export function clearSuspenseConfigCache(): void {
  voucherModeCache = null;
  categoryIsolateCache.clear();
}

export async function getVoucherMode(): Promise<VoucherMode> {
  if (voucherModeCache && Date.now() - voucherModeCache.at < CONFIG_TTL_MS) return voucherModeCache.value;
  try {
    const snap = await getDoc(doc(db, SETTINGS, 'voucher_mode'));
    const value: VoucherMode = snap.exists() && snap.data().mode === 'overall' ? 'overall' : 'per_user';
    voucherModeCache = { at: Date.now(), value };
    return value;
  } catch { return voucherModeCache?.value ?? 'per_user'; }
}
export async function setVoucherMode(mode: VoucherMode, actor: Actor): Promise<void> {
  await setDoc(doc(db, SETTINGS, 'voucher_mode'), {
    mode, updated_at: Timestamp.now(), updated_by: actor.epf, updated_by_name: actor.name,
  });
  clearSuspenseConfigCache();
}

// ─── Approval PIN (per suspense approver) ──────────────────────────────────────
// A 4-digit PIN each suspense approver sets for themselves (Settings page) and must re-enter to
// approve a credit request — a deliberate-confirmation step, not a cryptographic boundary (this
// app has no server-side enforcement layer; every other capability gate here is client-side too
// — see the "no custom claims provider" posture elsewhere in this file). Only the salted hash is
// ever stored, one doc per approver under the existing suspense_settings collection (no new
// collection/rule needed — it's already isAuth()-gated read/write for any doc id).
function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hashPin(pin: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}
// EPF numbers like "EMPAV/00117" contain "/", which Firestore reads as a path separator —
// route through epfDocId() (userService.ts) the same way every other EPF-keyed doc id does.
const pinDocRef = (epf: string) => doc(db, SETTINGS, `approval_pin_${epfDocId(epf)}`);

export async function hasApprovalPin(epf: string): Promise<boolean> {
  if (!epf) return false;
  const snap = await getDoc(pinDocRef(epf));
  return snap.exists();
}

// Set/change the caller's own approval PIN.
export async function setApprovalPin(epf: string, pin: string): Promise<void> {
  if (!/^\d{4}$/.test(pin)) throw new Error('PIN must be exactly 4 digits.');
  const salt = randomSalt();
  const pin_hash = await hashPin(pin, salt);
  await setDoc(pinDocRef(epf), { epf, pin_hash, pin_salt: salt, updated_at: Timestamp.now() });
}

// Verify a 4-digit PIN against the caller's own stored one. Throws (rather than returning false)
// when no PIN has been set yet, so the caller can show a distinct "set one up first" message.
export async function verifyApprovalPin(epf: string, pin: string): Promise<boolean> {
  const snap = await getDoc(pinDocRef(epf));
  if (!snap.exists()) throw new Error('You haven’t set an approval PIN yet — set one in Settings first.');
  const { pin_hash, pin_salt } = snap.data() as { pin_hash: string; pin_salt: string };
  return (await hashPin(pin, pin_salt)) === pin_hash;
}

// The open (settled === false) voucher a bill for this employee would currently land in, under
// the given mode — 'per_user' scopes to just this employee (plain equality query, matching
// SuspenseVoucher.epf_number, the "who opened it" field — no array-contains index needed);
// 'overall' ignores the employee entirely, since there's at most one shared open voucher.
// Isolated (per-bill, is_isolated === true) vouchers are excluded client-side rather than via an
// extra where() clause — an equality filter on is_isolated would silently hide every voucher
// created before this field existed, since Firestore never matches a missing field against a
// literal value.
async function findOpenVoucherId(epf: string, mode: VoucherMode): Promise<string | undefined> {
  const q = mode === 'per_user'
    ? query(collection(db, VOUCHERS), where('epf_number', '==', epf), where('settled', '==', false))
    : query(collection(db, VOUCHERS), where('settled', '==', false));
  const snap = await getDocs(q);
  return snap.docs.find(d => !(d.data() as SuspenseVoucher).is_isolated)?.id;
}

// True when this bill's category has "Group in vouchers" switched OFF (explicit
// SuspenseCategory.group_in_vouchers === false) — meaning it never pools with the shared rolling
// voucher; every approved bill in it opens its own standalone voucher instead. undefined/true
// (the default) means normal pooling, same as any other category. Read fresh (categories rarely
// change; correctness here matters more than saving one small lookup).
async function categoryIsolatesVouchers(category: string | undefined): Promise<boolean> {
  if (!category) return false;
  const hit = categoryIsolateCache.get(category);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.value;
  const snap = await getDocs(query(collection(db, CATS), where('name', '==', category)));
  const value = snap.docs[0]?.data()?.group_in_vouchers === false;
  categoryIsolateCache.set(category, { at: Date.now(), value });
  return value;
}

// A read-only look at what approving this bill would do to vouchers — used to show the approver
// a confirmation ("this will join Voucher #26080001" / "this will open a new voucher") before
// they commit. The real assignment (addApprovedBillToVoucher, below) re-verifies independently at
// approval time, so a race between preview and the actual click is harmless — worst case the
// approver sees a stale-by-one-bill preview, never a wrong write.
export interface VoucherPreview { voucherNo: string | null; isNew: boolean; billCount: number }
export async function previewVoucherForApproval(sub: SuspenseSubmission): Promise<VoucherPreview> {
  // In parallel: these two do not depend on each other, and running them in series was half the
  // preview's latency on a phone.
  const [isolate, mode] = await Promise.all([categoryIsolatesVouchers(sub.category), getVoucherMode()]);
  if (isolate) return { voucherNo: null, isNew: true, billCount: 0 };
  const id = await findOpenVoucherId(sub.epf_number, mode);
  if (!id) return { voucherNo: null, isNew: true, billCount: 0 };
  const snap = await getDoc(doc(db, VOUCHERS, id));
  const v = snap.data() as SuspenseVoucher | undefined;
  if (!v) return { voucherNo: null, isNew: true, billCount: 0 };
  return { voucherNo: v.voucher_no, isNew: false, billCount: v.submission_ids.length };
}

// Fold a just-approved bill into the currently OPEN voucher (settled === false) for its scope
// (per employee, or shared — see VoucherMode) — or open a brand-new one if none exists (first-
// ever, the previous one was just settled, or the category isolates — see
// categoryIsolatesVouchers). A voucher spans ANY category/subcategory/company; it keeps absorbing
// newly approved bills until someone marks it settled, at which point it's closed permanently and
// the next approval starts a fresh one. Called only from approveSubmission (a rejected bill never
// joins a voucher). The outer query can't run inside a transaction (Firestore transactions don't
// support where() queries), so the candidate is re-verified with tx.get() before use — if it raced
// closed in the meantime, this safely falls through to opening a new voucher instead.
async function addApprovedBillToVoucher(sub: SuspenseSubmission): Promise<void> {
  // Parallel, and both now served from the short-lived config cache the preview just filled —
  // this runs moments after previewVoucherForApproval asked the same two questions.
  const [isolate, mode] = await Promise.all([categoryIsolatesVouchers(sub.category), getVoucherMode()]);
  const candidateId = isolate ? undefined : await findOpenVoucherId(sub.epf_number, mode);

  await runTransaction(db, async (tx) => {
    const subRef = doc(db, SUBS, sub.id);
    const candidateRef = candidateId ? doc(db, VOUCHERS, candidateId) : null;
    const candidateSnap = candidateRef ? await tx.get(candidateRef) : null;
    const now = Timestamp.now();

    // Re-verify the candidate is still open AND still a normal (non-isolated) voucher — a
    // defense-in-depth check mirroring findOpenVoucherId's own filter, in case of a race.
    if (candidateSnap?.exists() && !(candidateSnap.data() as SuspenseVoucher).settled && !(candidateSnap.data() as SuspenseVoucher).is_isolated) {
      const v = candidateSnap.data() as SuspenseVoucher;
      tx.update(candidateRef!, {
        submission_ids: [...v.submission_ids, sub.id],
        company_ids: v.company_ids.includes(sub.company_id) ? v.company_ids : [...v.company_ids, sub.company_id],
        employee_epfs: v.employee_epfs.includes(sub.epf_number) ? v.employee_epfs : [...v.employee_epfs, sub.epf_number],
        employee_names: v.employee_names.includes(sub.employee_name) ? v.employee_names : [...v.employee_names, sub.employee_name],
        total_amount: money(v.total_amount + sub.amount),
        total_vat_amount: money(v.total_vat_amount + (sub.is_vat ? (sub.vat_amount ?? 0) : 0)),
      });
      tx.update(subRef, { voucher_id: candidateRef!.id });
      return;
    }

    const voucherRef = doc(collection(db, VOUCHERS));
    const voucherNo = await nextSequenceNo(tx, VOUCHER_COUNTERS, now.toDate());
    tx.set(voucherRef, {
      id: voucherRef.id, voucher_no: voucherNo, epf_number: sub.epf_number, employee_name: sub.employee_name,
      employee_epfs: [sub.epf_number], employee_names: [sub.employee_name],
      company_ids: [sub.company_id], submission_ids: [sub.id],
      total_amount: money(sub.amount), total_vat_amount: money(sub.is_vat ? (sub.vat_amount ?? 0) : 0),
      is_isolated: isolate,
      created_at: now, settled: false, settled_at: null, settled_by: null, settled_by_name: null,
    });
    tx.update(subRef, { voucher_id: voucherRef.id });
  });
}

// Approve an expense → debit the (auto-created if needed) company account. May go negative.
export async function approveSubmission(args: { id: string; actor: Actor }): Promise<void> {
  const subRef = doc(db, SUBS, args.id);
  let ownerEpf = '', amount = 0, balAfter = 0, owedBack = 0;
  let approved: SuspenseSubmission | null = null;
  await runTransaction(db, async (tx) => {
    const subSnap = await tx.get(subRef);
    if (!subSnap.exists()) throw new Error('Submission not found.');
    const sub = subSnap.data() as SuspenseSubmission;
    if (sub.status !== 'pending') throw new Error('This submission has already been processed.');
    // A cancelled bill stays 'pending' (deleteSubmission only sets `deleted`), so the status check
    // alone would let a stale approver queue approve one. It has already given up its number — the
    // run's highest un-approved bill may be sitting in that slot by now — and approving it would
    // FREEZE a second bill onto the same number and fold it into a voucher. Checked in here, inside
    // the transaction, so a cancel racing this approval is caught as well as an already-stale row.
    if (sub.deleted) throw new Error('This submission was cancelled by the submitter and can no longer be approved.');
    ownerEpf = sub.epf_number;
    approved = { ...sub, id: args.id, status: 'approved' };
    // The FULL bill leaves the float, splits included. The payer handed over the whole amount in
    // cash, so the whole amount leaves the balance and the float keeps meaning "what you still
    // hold". Portions split to colleagues are a RECEIVABLE owed back to the payer: recoverSplit
    // credits each one back when payroll has actually deducted it from that colleague's salary.
    //
    // Netting splits off here instead is what put one payer LKR 12,792 down — the cash left his
    // hand, the balance never moved, and two fully-split bills debited exactly nothing.
    const debit = money(sub.amount);
    amount   = debit;
    owedBack = splitsTotal(sub.splits);
    const accRef  = doc(db, ACCOUNTS, accountId(sub.epf_number, sub.company_id));
    const accSnap = await tx.get(accRef);
    const now     = Timestamp.now();
    const acc     = accSnap.exists() ? (accSnap.data() as SuspenseAccount) : null;
    if (acc?.is_closed) throw new Error('The account for this company is closed.');
    if (acc && !acc.is_active) throw new Error('The account for this company is frozen.');
    balAfter = money((acc ? acc.balance : 0) - debit);   // no floor — balance may go negative
    if (!acc) {
      // Auto-create the company account (executive's first item for this company).
      tx.set(accRef, {
        epf_number: sub.epf_number, employee_name: sub.employee_name,
        company_id: sub.company_id, company_name: sub.company_name,
        balance: balAfter, currency: SUSPENSE_CURRENCY, is_active: true,
        created_by: args.actor.epf, created_by_name: args.actor.name, created_at: now, updated_at: now,
      });
    } else {
      tx.update(accRef, { balance: balAfter, updated_at: now });
    }
    tx.update(subRef, {
      status: 'approved', considered_by: args.actor.epf, considered_by_name: args.actor.name,
      considered_at: now, updated_at: now,
    });
    const ledRef = doc(collection(db, LEDGER));
    tx.set(ledRef, {
      id: ledRef.id, epf_number: sub.epf_number, company_id: sub.company_id, kind: 'debit' as SuspenseLedgerKind,
      amount: -amount, balance_after: balAfter, ref_type: 'submission', ref_id: args.id,
      note: [sub.expense_type, sub.company_name].filter(Boolean).join(' · ') || 'Expense',
      actor_epf: args.actor.epf, actor_name: args.actor.name, created_at: now,
    });
  });
  // NOT awaited — same reasoning as logBillEvent. The bill is already approved and the ledger
  // already posted; making the approver wait on a notification write adds a round trip to every
  // click in a long queue, and with offline persistence an awaited write does not settle at all
  // until it reaches the server. A failed notification must never look like a failed approval.
  void notifyOwner(ownerEpf, 'suspense_approved', 'Expense approved',
    `Your expense of ${formatSuspenseAmount(amount)} was approved. New balance ${formatSuspenseAmount(balAfter)}.`
    + (owedBack > 0 ? ` ${formatSuspenseAmount(owedBack)} of it is split to colleagues and comes back to your float once payroll deducts it.` : ''),
    args.actor).catch(e => console.warn('[suspense] approval notification not sent:', e));
  // Awaited, unlike the notification: this is bookkeeping, not a message. The bill must be on a
  // voucher before the caller refetches, or the approver sees it briefly belonging to none.
  if (approved) await addApprovedBillToVoucher(approved);
}

// ─── Split recovery ─────────────────────────────────────────────────────────────
// The other half of charging the full bill to the float. Approval takes the whole amount because
// the whole amount left the payer's hand; these two put a split back once payroll has actually
// taken it off the colleague's salary. Until then the payer is carrying it, which is exactly what
// the outstanding list below is for.

/** One split still owed back to the payer, flattened for the recoveries screen. */
export interface OutstandingSplit {
  submission_id: string;
  bill_no:       string | null;
  /** Who is out of pocket — the bill's owner, whose float gets the money back. */
  payer_epf:     string;
  payer_name:    string;
  company_id:    string;
  company_name:  string;
  /** Who owes it — payroll deducts this from their salary. */
  owed_by_epf:   string;
  owed_by_name:  string;
  amount:        number;
  expense_type:  string;
  item:          string;
  shop_name:     string;
  /** Approval time in ms — how long the payer has been carrying it. */
  at:            number;
}

/** Every approved split that payroll has not yet deducted, newest first. One query on status;
 *  splits live on the submission, so there is nothing else to read. */
export async function listOutstandingSplits(): Promise<OutstandingSplit[]> {
  const snap = await getDocs(query(collection(db, SUBS), where('status', '==', 'approved')));
  const out: OutstandingSplit[] = [];
  for (const d of snap.docs) {
    const s = { id: d.id, ...d.data() } as SuspenseSubmission;
    if (s.deleted || !s.splits?.length) continue;
    const at = millis(s.considered_at ?? s.created_at);
    for (const sp of s.splits) {
      if (sp.recovered_at || money(sp.amount) <= 0) continue;
      out.push({
        submission_id: s.id, bill_no: s.bill_no ?? null,
        payer_epf: s.epf_number, payer_name: s.employee_name,
        company_id: s.company_id, company_name: s.company_name,
        owed_by_epf: sp.epf_number, owed_by_name: sp.employee_name,
        amount: money(sp.amount), expense_type: s.expense_type, item: s.item, shop_name: s.shop_name, at,
      });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Payroll has deducted this split from the colleague's salary → give it back to the payer's float.
 *
 * Runs in a transaction for the same reason approval does: the balance and the ledger entry that
 * explains it must move together. The split row is stamped inside the same transaction, so a
 * double-click or two approvers clicking at once can only credit the float once.
 */
export async function recoverSplit(args: {
  submissionId: string; owedByEpf: string; actor: Actor;
}): Promise<void> {
  const subRef = doc(db, SUBS, args.submissionId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(subRef);
    if (!snap.exists()) throw new Error('Submission not found.');
    const sub = snap.data() as SuspenseSubmission;
    if (sub.status !== 'approved') throw new Error('Only an approved bill has a split to recover.');
    if (sub.deleted) throw new Error('This bill was cancelled.');

    const splits = [...(sub.splits ?? [])];
    const i = splits.findIndex(s => s.epf_number === args.owedByEpf);
    if (i < 0) throw new Error('That employee has no split on this bill.');
    if (splits[i].recovered_at) throw new Error('This split has already been recovered.');
    const amount = money(splits[i].amount);
    if (amount <= 0) throw new Error('There is nothing to recover on this split.');

    const accRef  = doc(db, ACCOUNTS, accountId(sub.epf_number, sub.company_id));
    const accSnap = await tx.get(accRef);
    if (!accSnap.exists()) throw new Error('The payer has no suspense account for this company.');
    const acc = accSnap.data() as SuspenseAccount;
    // A closed account has been settled to zero and its holder has handed the cash back; paying a
    // recovery into it would quietly reopen a balance nobody is watching. Reopen it first.
    if (acc.is_closed) throw new Error('The payer’s account for this company is closed — reopen it before recovering this split.');

    const now = Timestamp.now();
    const balAfter = money(acc.balance + amount);
    const ledRef = doc(collection(db, LEDGER));
    tx.update(accRef, { balance: balAfter, updated_at: now });
    tx.set(ledRef, {
      id: ledRef.id, epf_number: sub.epf_number, company_id: sub.company_id, kind: 'credit' as SuspenseLedgerKind,
      amount, balance_after: balAfter, ref_type: 'submission' as const, ref_id: args.submissionId,
      note: `Split recovered from ${splits[i].employee_name}${sub.bill_no ? ` · bill ${sub.bill_no}` : ''}`,
      actor_epf: args.actor.epf, actor_name: args.actor.name, created_at: now,
    });
    splits[i] = {
      ...splits[i],
      recovered_at: now, recovered_by: args.actor.epf, recovered_by_name: args.actor.name,
      recovered_entry_id: ledRef.id,
    };
    tx.update(subRef, { splits, updated_at: now });
  });
}

/** Undo a recovery — payroll reversed the deduction, or it was marked in error. Takes the money
 *  back off the float with its own ledger line rather than deleting the credit: the original
 *  entry is what the payer was shown, and an append-only trail is the point of a ledger. */
export async function unrecoverSplit(args: {
  submissionId: string; owedByEpf: string; actor: Actor;
}): Promise<void> {
  const subRef = doc(db, SUBS, args.submissionId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(subRef);
    if (!snap.exists()) throw new Error('Submission not found.');
    const sub = snap.data() as SuspenseSubmission;
    const splits = [...(sub.splits ?? [])];
    const i = splits.findIndex(s => s.epf_number === args.owedByEpf);
    if (i < 0) throw new Error('That employee has no split on this bill.');
    if (!splits[i].recovered_at) throw new Error('This split has not been recovered.');
    const amount = money(splits[i].amount);

    const accRef  = doc(db, ACCOUNTS, accountId(sub.epf_number, sub.company_id));
    const accSnap = await tx.get(accRef);
    if (!accSnap.exists()) throw new Error('The payer has no suspense account for this company.');
    const acc = accSnap.data() as SuspenseAccount;
    if (acc.is_closed) throw new Error('The payer’s account for this company is closed.');

    const now = Timestamp.now();
    const balAfter = money(acc.balance - amount);
    const ledRef = doc(collection(db, LEDGER));
    tx.update(accRef, { balance: balAfter, updated_at: now });
    tx.set(ledRef, {
      id: ledRef.id, epf_number: sub.epf_number, company_id: sub.company_id, kind: 'adjustment' as SuspenseLedgerKind,
      amount: -amount, balance_after: balAfter, ref_type: 'submission' as const, ref_id: args.submissionId,
      note: `Split recovery reversed · ${splits[i].employee_name}${sub.bill_no ? ` · bill ${sub.bill_no}` : ''}`,
      actor_epf: args.actor.epf, actor_name: args.actor.name, created_at: now,
    });
    splits[i] = {
      ...splits[i],
      recovered_at: null, recovered_by: null, recovered_by_name: null, recovered_entry_id: null,
    };
    tx.update(subRef, { splits, updated_at: now });
  });
}

export async function rejectSubmission(args: { id: string; reason: string; actor: Actor }): Promise<void> {
  const subRef = doc(db, SUBS, args.id);
  const snap = await getDoc(subRef);
  if (!snap.exists()) throw new Error('Submission not found.');
  const sub = snap.data() as SuspenseSubmission;
  if (sub.status !== 'pending') throw new Error('This submission has already been processed.');
  // Same stale-queue case as approveSubmission — a cancelled bill is still 'pending'. Nothing here
  // moves money or a number, but the verdict would land on a withdrawn bill and notify its owner.
  if (sub.deleted) throw new Error('This submission was cancelled by the submitter — there is nothing left to reject.');
  const now = Timestamp.now();
  await updateDoc(subRef, {
    status: 'rejected', considered_by: args.actor.epf, considered_by_name: args.actor.name,
    considered_at: now, reject_reason: args.reason || null, updated_at: now,
  });
  await notifyOwner(sub.epf_number, 'suspense_rejected', 'Expense rejected',
    args.reason ? `Your expense was rejected: ${args.reason}` : 'Your expense was rejected.', args.actor);
  // A rejected bill never joins a voucher — vouchers are a running set of APPROVED bills only.
}

// ─── Vouchers — settlement (QuickBooks reconciliation) operates on these, not raw submissions ──
export async function listVouchers(): Promise<SuspenseVoucher[]> {
  const snap = await getDocs(collection(db, VOUCHERS));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as SuspenseVoucher)).sort((a, b) => millis(b.created_at) - millis(a.created_at));
}

// Chunked writeBatch (450/batch, matching rejectPendingForCompany above) so an arbitrarily large
// selection is fully committed rather than silently truncated at Firestore's 500-write limit.
export async function markVouchersSettled(ids: string[], actor: Actor): Promise<void> {
  if (!ids.length) return;
  const now = Timestamp.now();
  const payload = { settled: true, settled_at: now, settled_by: actor.epf, settled_by_name: actor.name };
  for (let i = 0; i < ids.length; i += 450) {
    const batch = writeBatch(db);
    ids.slice(i, i + 450).forEach(id => batch.update(doc(db, VOUCHERS, id), payload));
    await batch.commit();
  }
}

export async function unmarkVouchersSettled(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const payload = { settled: false, settled_at: null, settled_by: null, settled_by_name: null };
  for (let i = 0; i < ids.length; i += 450) {
    const batch = writeBatch(db);
    ids.slice(i, i + 450).forEach(id => batch.update(doc(db, VOUCHERS, id), payload));
    await batch.commit();
  }
}

// The constituent bills of a voucher (or any small id set) — individual getDoc calls, fine at the
// scale a voucher fans out to (one employee's bills for one category+subcategory batch).
export async function getSubmissionsByIds(ids: string[]): Promise<SuspenseSubmission[]> {
  if (!ids.length) return [];
  const snaps = await Promise.all(ids.map(id => getDoc(doc(db, SUBS, id))));
  return snaps.filter(s => s.exists()).map(s => ({ id: s.id, ...s.data() } as SuspenseSubmission));
}

export interface EmployeeDeduction {
  submission_id: string;
  payer_epf:     string;   // who submitted the bill
  payer_name:    string;
  company_id:    string;
  company_name:  string;
  expense_type:  string;
  item:          string;
  shop_name:     string;
  amount:        number;   // this employee's share of the bill
  bill_url:      string | null;
  bill_type:     'image' | 'pdf' | null;
  at:            number;   // approved (or created) time, ms
}

// Approved bill portions charged to an employee within [fromMs, toMs] — their salary deductions.
// Array-contains on the denormalized split_epfs (single-field; no composite index), then filter
// to approved + date range in memory.
export async function getEmployeeDeductions(epf: string, fromMs: number, toMs: number): Promise<EmployeeDeduction[]> {
  if (!epf) return [];
  const snap = await getDocs(query(collection(db, SUBS), where('split_epfs', 'array-contains', epf)));
  const out: EmployeeDeduction[] = [];
  for (const d of snap.docs) {
    const s = { id: d.id, ...d.data() } as SuspenseSubmission;
    if (s.status !== 'approved') continue;
    const at = millis(s.considered_at ?? s.created_at);
    if (at < fromMs || at > toMs) continue;
    const mine = (s.splits ?? []).find(sp => sp.epf_number === epf);
    if (!mine || money(mine.amount) <= 0) continue;
    out.push({
      submission_id: s.id, payer_epf: s.epf_number, payer_name: s.employee_name,
      company_id: s.company_id, company_name: s.company_name,
      expense_type: s.expense_type, item: s.item, shop_name: s.shop_name,
      amount: money(mine.amount), bill_url: s.bill_url, bill_type: s.bill_type, at,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

// Total suspense salary-deduction per employee across approved submissions in [fromMs, toMs].
// One query (status == approved, single-field), summed in memory by tagged epf → total. Used by
// the monthly report to show each employee's suspense deductions for the period.
export async function getMonthlyDeductionTotals(fromMs: number, toMs: number): Promise<Map<string, number>> {
  const snap = await getDocs(query(collection(db, SUBS), where('status', '==', 'approved')));
  const totals = new Map<string, number>();
  for (const d of snap.docs) {
    const s = d.data() as SuspenseSubmission;
    if (!s.splits?.length) continue;
    const at = millis(s.considered_at ?? s.created_at);
    if (at < fromMs || at > toMs) continue;
    for (const sp of s.splits) {
      const amt = money(sp.amount);
      if (amt > 0) totals.set(sp.epf_number, money((totals.get(sp.epf_number) ?? 0) + amt));
    }
  }
  return totals;
}

// ─── Requests (credit top-ups) ─────────────────────────────────────────────────
export interface RequestInput {
  epf_number:    string;
  employee_name: string;
  company_id:    string;    // the company account this credit tops up (credited on approval)
  company_name:  string;
  amount:        number;
  reason:        string;
  // What the credit is for — an id from the SAME expense taxonomy the bills use. Whether the
  // request then needs a category sign-off is decided here from the category's own
  // credit_approvers, never passed in by the caller.
  category_id:   string;
  category_name: string;
}

// Who may sign this request's category stage off: the category's own credit_approvers, minus the
// requester (nobody approves their own request). Read FORCE-FRESH from the category doc — like
// the supervisor routing below, the decision is stamped once and never re-evaluated, so a stale
// list would silently skip or misdirect the gate for the whole life of the request. A category
// that names nobody (or only the requester) simply adds no gate.
async function resolveCategoryApprovers(categoryId: string, requesterEpf: string): Promise<SuspenseApprover[]> {
  if (!categoryId) return [];
  const snap = await getDoc(doc(db, CATS, categoryId));
  if (!snap.exists()) return [];
  return cleanApprovers((snap.data() as SuspenseCategory).credit_approvers).filter(a => a.epf !== requesterEpf);
}

// Tell the named approvers a request is sitting with them — the whole point of the gate is that
// it waits on specific people, who otherwise have nothing telling them to look. Fire-and-forget:
// the request is already committed and a failed notification must never fail the submission.
function notifyCategoryApprovers(req: { employee_name: string; amount: number; company_name: string; category_name: string }, approvers: SuspenseApprover[], actor: Actor): void {
  for (const a of approvers) {
    createAppNotification({
      toEpf: a.epf, type: 'general', actorEpf: actor.epf, actorName: actor.name,
      title: 'Credit request needs your approval',
      body: `${req.employee_name} requested ${formatSuspenseAmount(req.amount)} for ${req.category_name} (${req.company_name}).`,
      link: '/suspense',
    }).catch(() => { /* best effort — the request stands either way */ });
  }
}

export async function getMyRequests(epf: string): Promise<SuspenseRequest[]> {
  if (!epf) return [];
  const snap = await getDocs(query(collection(db, REQS), where('epf_number', '==', epf)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as SuspenseRequest))
    .sort((a, b) => millis(b.created_at) - millis(a.created_at));
}

// Whether every gate BEFORE the suspense approver has cleared — stage 1 (the technician's
// supervisor) and stage 2 (the request category's named approvers). Both are opt-in per request
// and both are absent on older docs, which therefore read as cleared, exactly as they used to.
export function requestIsReadyForApprover(r: SuspenseRequest): boolean {
  const supervisorOk = !r.needs_supervisor_approval || r.supervisor_status === 'approved';
  const categoryOk   = !r.needs_category_approval   || r.category_status   === 'approved';
  return supervisorOk && categoryOk;
}

// The stage a still-pending request is currently sitting at — which is also the order they run
// in: the supervisor signs first, then the category's approvers, then the suspense approver.
export function requestStage(r: SuspenseRequest): 'supervisor' | 'category' | 'approver' {
  if (r.needs_supervisor_approval && r.supervisor_status !== 'approved') return 'supervisor';
  if (r.needs_category_approval && r.category_status !== 'approved') return 'category';
  return 'approver';
}

// A request that still needs stage-1 (supervisor) or stage-2 (category) sign-off stays invisible
// here until it clears — see requestIsReadyForApprover.
export async function getPendingRequests(): Promise<SuspenseRequest[]> {
  const snap = await getDocs(query(collection(db, REQS), where('status', '==', 'pending')));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as SuspenseRequest))
    .filter(requestIsReadyForApprover)
    .sort((a, b) => millis(a.created_at) - millis(b.created_at));
}

/**
 * Every credit request an approver should SEE, not just the ones they can act on:
 *
 *  - everything still `pending`, INCLUDING a request an earlier stage has not cleared yet —
 *    stage 1 (the technician's supervisor) or stage 2 (its category's named approvers).
 *    getPendingRequests deliberately hides those because they are not actionable; hiding them
 *    from the screen entirely meant an approver asking "where did that request go?" had nowhere
 *    to look. Here they come back, marked as waiting and on whom.
 *  - the most recent already-decided ones, so an approved/rejected request stays visible for a
 *    while as history instead of vanishing the moment it is signed.
 *
 * Two single-field queries (no composite index): every pending doc, plus the newest
 * `recentLimit` docs by creation. Merged by id — a doc caught by both is kept once.
 */
export async function getAllRequestsForApprovals(recentLimit = 100): Promise<SuspenseRequest[]> {
  const [pendingSnap, recentSnap] = await Promise.all([
    getDocs(query(collection(db, REQS), where('status', '==', 'pending'))),
    getDocs(query(collection(db, REQS), orderBy('created_at', 'desc'), limit(recentLimit))),
  ]);
  const byId = new Map<string, SuspenseRequest>();
  for (const d of [...pendingSnap.docs, ...recentSnap.docs]) {
    if (!byId.has(d.id)) byId.set(d.id, { id: d.id, ...d.data() } as SuspenseRequest);
  }
  return [...byId.values()].sort((a, b) => millis(b.created_at) - millis(a.created_at));
}

// A technician's credit requests still waiting on their supervisor's sign-off (stage 1) —
// visible to whoever is either their personal supervisor (AppUser.supervisor_epf, snapshotted
// onto the request as requester_supervisor_epf at creation) or listed as a supervisor on the
// request's company (Company.supervisor_epfs), regardless of whether that person otherwise has
// any other suspense access at all. Two pure-equality filters — no composite index needed.
export async function getPendingSupervisorRequests(viewerEpf: string): Promise<SuspenseRequest[]> {
  if (!viewerEpf) return [];
  const [snap, companies] = await Promise.all([
    getDocs(query(collection(db, REQS), where('needs_supervisor_approval', '==', true), where('supervisor_status', '==', 'pending'))),
    getCompanies(),
  ]);
  const supervisedCompanyIds = new Set(companies.filter(c => (c.supervisor_epfs ?? []).includes(viewerEpf)).map(c => c.id));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as SuspenseRequest))
    .filter(r => r.status === 'pending' && (
      r.requester_supervisor_epf === viewerEpf ||
      supervisedCompanyIds.has(r.company_id) ||
      // Someone an admin added to THIS request specifically (see addRequestSupervisor).
      (r.extra_supervisors ?? []).some(x => x.epf === viewerEpf)
    ))
    .sort((a, b) => millis(a.created_at) - millis(b.created_at));
}

// Credit requests waiting on THIS viewer as one of the approvers named on the request's category
// (stage 2). Only requests whose supervisor stage has already cleared surface here — the category
// approver signs after the supervisor, never instead of them. Two pure-equality filters (no
// composite index); the membership test runs in memory against the snapshot on each request.
export async function getPendingCategoryRequests(viewerEpf: string): Promise<SuspenseRequest[]> {
  if (!viewerEpf) return [];
  const snap = await getDocs(query(collection(db, REQS),
    where('needs_category_approval', '==', true), where('category_status', '==', 'pending')));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as SuspenseRequest))
    .filter(r => r.status === 'pending'
      && (!r.needs_supervisor_approval || r.supervisor_status === 'approved')
      && (r.category_approvers ?? []).some(a => a.epf === viewerEpf))
    .sort((a, b) => millis(a.created_at) - millis(b.created_at));
}

// Stage-2 sign-off by one of the category's named approvers — forwards the request to the
// suspense approvers at its ORIGINAL requested amount (the granted amount is still stage 3's
// call, via approveRequest). Rejecting at this stage uses the existing rejectRequest, which only
// ever requires status === 'pending' and so is valid at every stage.
export async function approveCategoryStage(id: string, actor: Actor): Promise<void> {
  const ref  = doc(db, REQS, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Request not found.');
  const req = snap.data() as SuspenseRequest;
  if (!req.needs_category_approval) throw new Error('This request does not need category approval.');
  if (req.category_status !== 'pending') throw new Error('This request has already been approved for its category.');
  if (req.status !== 'pending') throw new Error('This request has already been processed.');
  if (req.needs_supervisor_approval && req.supervisor_status !== 'approved') {
    throw new Error('This request is still waiting on its supervisor.');
  }
  // The pool was fixed when the request was filed; someone who isn't on it can't sign it, even
  // if they were since added to the category.
  if (!(req.category_approvers ?? []).some(a => a.epf === actor.epf)) {
    throw new Error('You are not an approver for this request’s category.');
  }
  const now = Timestamp.now();
  await updateDoc(ref, {
    category_status: 'approved', category_approved_by: actor.epf, category_approved_by_name: actor.name,
    category_approved_at: now, updated_at: now,
  });
}

/**
 * Let one more person sign this request's stage 1 off.
 *
 * Per request, never global: the company's supervisor pool is a standing arrangement edited on
 * the Companies page, and widening it to unblock one stuck request would quietly hand that
 * person every future request too. The entry records who added them, so "why can this person
 * approve it?" has an answer on the request itself.
 *
 * The added person is notified — the whole point is that nobody was watching this request.
 */
export async function addRequestSupervisor(
  id: string, person: { epf: string; name: string }, actor: Actor,
): Promise<void> {
  if (!person.epf) throw new Error('Pick someone to add.');
  const ref  = doc(db, REQS, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Request not found.');
  const req = snap.data() as SuspenseRequest;
  if (req.status !== 'pending') throw new Error('This request has already been processed.');
  if (!req.needs_supervisor_approval || req.supervisor_status !== 'pending') {
    throw new Error('This request is not waiting on a supervisor.');
  }
  if (person.epf === req.epf_number) throw new Error('Someone cannot approve their own request.');
  if ((req.extra_supervisors ?? []).some(x => x.epf === person.epf)) {
    throw new Error(`${person.name} can already approve this request.`);
  }

  await updateDoc(ref, {
    extra_supervisors: arrayUnion({
      epf: person.epf, name: person.name,
      added_by: actor.epf, added_by_name: actor.name, added_at: Timestamp.now(),
    }),
    updated_at: Timestamp.now(),
  });

  await createAppNotification({
    toEpf: person.epf, type: 'general', actorEpf: actor.epf, actorName: actor.name,
    title: 'Credit request needs your approval',
    body: `${actor.name} asked you to approve ${req.employee_name}'s ${formatSuspenseAmount(req.amount)} credit request (${req.company_name}).`,
    link: '/suspense',
  });
}

export async function createRequest(input: RequestInput): Promise<string> {
  const acc = await getSuspenseAccount(input.epf_number, input.company_id);
  if (acc?.is_closed) throw new Error('The account for this company is closed.');
  if (acc && !acc.is_active) throw new Error('The account for this company is frozen (a close request is pending).');
  if (!input.category_id) throw new Error('Choose what this credit is for.');

  // Technicians' credit requests need their supervisor's sign-off before reaching suspense
  // approvers — either their assigned personal supervisor or any of their company's designated
  // supervisors. If neither is resolvable, fall through to the normal single-stage flow rather
  // than creating a request nobody can ever act on. This routing decision is stamped once and
  // never re-evaluated, so it reads roles/companies FORCE-FRESH (bypassing their module-scope
  // caches) rather than risk a stale cache — from an admin having just added a company
  // supervisor in a different browser tab/session — silently skipping stage 1 forever.
  const [requester, roles, companies, categoryApprovers] = await Promise.all([
    getUserByEpf(input.epf_number), getRoles(true), getCompanies(true),
    resolveCategoryApprovers(input.category_id, input.epf_number),
  ]);
  const isTechnician = requester ? roleCategory(requester.role, roles) === 'technician' : false;
  const personalSupervisorEpf = requester?.supervisor_epf ?? null;
  const hasCompanySupervisors = companies.some(c => c.id === input.company_id && (c.supervisor_epfs ?? []).length > 0);
  const needsSupervisor = isTechnician && !!(personalSupervisorEpf || hasCompanySupervisors);
  const needsCategory   = categoryApprovers.length > 0;

  const now = Timestamp.now();
  const ref = await addDoc(collection(db, REQS), {
    ...input,
    amount:             money(input.amount),
    approved_amount:    null,
    needs_supervisor_approval: needsSupervisor,
    supervisor_status:  needsSupervisor ? 'pending' : null,
    supervisor_approved_by: null,
    supervisor_approved_by_name: null,
    supervisor_approved_at: null,
    requester_supervisor_epf: personalSupervisorEpf,
    needs_category_approval: needsCategory,
    category_status:    needsCategory ? 'pending' : null,
    category_approvers: categoryApprovers,
    category_approved_by: null,
    category_approved_by_name: null,
    category_approved_at: null,
    status:             'pending',
    considered_by:      null,
    considered_by_name: null,
    considered_at:      null,
    reject_reason:      null,
    created_at:         now,
    updated_at:         now,
  });
  await updateDoc(ref, { id: ref.id });
  // Only worth telling them now if it is already theirs to act on; a request still sitting with a
  // supervisor would be a notification about something they cannot do yet.
  if (needsCategory && !needsSupervisor) {
    notifyCategoryApprovers(
      { employee_name: input.employee_name, amount: money(input.amount), company_name: input.company_name, category_name: input.category_name },
      categoryApprovers, { epf: input.epf_number, name: input.employee_name },
    );
  }
  return ref.id;
}

// Editing a request the requester still owns (it is pending, at whatever stage). Changing the
// CATEGORY re-runs the category gate from scratch against the new category's approvers — the old
// category's sign-off cannot stand for a category it was never given — so a request cannot be
// filed under an ungated category, signed, and then quietly moved to a gated one.
export async function updateRequest(id: string, patch: { amount?: number; reason?: string; company_id?: string; company_name?: string; category_id?: string; category_name?: string }): Promise<void> {
  const ref  = doc(db, REQS, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Request not found.');
  const cur = snap.data() as SuspenseRequest;

  const data: Record<string, unknown> = { ...patch, updated_at: Timestamp.now() };
  if (patch.amount !== undefined) data.amount = money(patch.amount);
  if (patch.category_id !== undefined && patch.category_id !== (cur.category_id ?? '')) {
    if (cur.status !== 'pending') throw new Error('A decided request can no longer be recategorised.');
    const approvers = await resolveCategoryApprovers(patch.category_id, cur.epf_number);
    const needsCategory = approvers.length > 0;
    data.needs_category_approval = needsCategory;
    data.category_status    = needsCategory ? 'pending' : null;
    data.category_approvers = approvers;
    data.category_approved_by = null;
    data.category_approved_by_name = null;
    data.category_approved_at = null;
  }
  await updateDoc(ref, data);
}

export async function deleteRequest(id: string): Promise<void> {
  await deleteDoc(doc(db, REQS, id));
}

// Supervisor's stage-1 sign-off — forwards the request to suspense approvers at its ORIGINAL
// requested amount (the supervisor doesn't set the granted amount; that's still the suspense
// approver's call at stage 2, via approveRequest below). Rejecting at this stage just uses the
// existing rejectRequest — it only ever requires status === 'pending', true throughout both stages.
export async function approveSupervisorStage(id: string, actor: Actor): Promise<void> {
  const ref = doc(db, REQS, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Request not found.');
  const req = snap.data() as SuspenseRequest;
  if (!req.needs_supervisor_approval) throw new Error('This request does not need supervisor approval.');
  if (req.supervisor_status !== 'pending') throw new Error('This request has already been processed by a supervisor.');
  if (req.status !== 'pending') throw new Error('This request has already been processed.');
  await updateDoc(ref, {
    supervisor_status: 'approved', supervisor_approved_by: actor.epf, supervisor_approved_by_name: actor.name,
    supervisor_approved_at: Timestamp.now(), updated_at: Timestamp.now(),
  });
  // Stage 2 is now live — this is the moment its named approvers can actually act.
  if (req.needs_category_approval && req.category_status !== 'approved') {
    notifyCategoryApprovers(
      { employee_name: req.employee_name, amount: req.amount, company_name: req.company_name, category_name: req.category_name ?? 'this request' },
      req.category_approvers ?? [], actor,
    );
  }
}

// Approve a credit request → credit the (auto-created if needed) company account.
// The granted amount is checked against the requester's float limit (suspenseLimits.ts) and
// refused when the balance would land over it — unless `overrideLimit` carries the approver's
// reason, which goes into the ledger note so the exception is on the record.
export async function approveRequest(args: { id: string; approved_amount: number; actor: Actor; overrideLimit?: string }): Promise<void> {
  const reqRef  = doc(db, REQS, args.id);
  const granted = money(args.approved_amount);
  if (!(granted > 0)) throw new Error('Approved amount must be greater than zero.');
  let ownerEpf = '', balAfter = 0;
    // Resolve the limit OUTSIDE the transaction (it reads the user doc and the settings doc, which
  // are not part of the money movement) from the request as it stands now; the transaction
  // re-reads the request and would refuse a request that changed underneath anyway.
  const preSnap = await getDoc(doc(db, REQS, args.id));
  const pre = preSnap.exists() ? (preSnap.data() as SuspenseRequest) : null;
  const resolved = pre ? await resolveLimitForEpf(pre.epf_number, pre.company_id) : null;
  const override = (args.overrideLimit ?? '').trim();
  let limitNote = '';
await runTransaction(db, async (tx) => {
    const reqSnap = await tx.get(reqRef);
    if (!reqSnap.exists()) throw new Error('Request not found.');
    const req = reqSnap.data() as SuspenseRequest;
    if (req.status !== 'pending') throw new Error('This request has already been processed.');
    if (req.needs_supervisor_approval && req.supervisor_status !== 'approved') {
      throw new Error('This request needs supervisor approval first.');
    }
    if (req.needs_category_approval && req.category_status !== 'approved') {
      throw new Error('This request needs its category approver’s sign-off first.');
    }
    ownerEpf = req.epf_number;
    const accRef  = doc(db, ACCOUNTS, accountId(req.epf_number, req.company_id));
    const accSnap = await tx.get(accRef);
    const now     = Timestamp.now();
    const acc     = accSnap.exists() ? (accSnap.data() as SuspenseAccount) : null;
    if (acc?.is_closed) throw new Error('The account for this company is closed.');
    if (acc && !acc.is_active) throw new Error('The account for this company is frozen.');
    balAfter = money((acc ? acc.balance : 0) + granted);
    if (resolved && resolved.limit !== null) {
      const check = checkAgainstLimit(resolved.limit, balAfter);
      if (check.over && !override) {
        throw new Error(describeLimitBreach(req.employee_name, resolved, acc ? acc.balance : 0, balAfter));
      }
      if (check.over) limitNote = ` · Limit ${formatSuspenseAmount(resolved.limit)} overridden: ${override}`;
    }
    if (!acc) {
      tx.set(accRef, {
        epf_number: req.epf_number, employee_name: req.employee_name,
        company_id: req.company_id, company_name: req.company_name,
        balance: balAfter, currency: SUSPENSE_CURRENCY, is_active: true,
        created_by: args.actor.epf, created_by_name: args.actor.name, created_at: now, updated_at: now,
      });
    } else {
      tx.update(accRef, { balance: balAfter, updated_at: now });
    }
    tx.update(reqRef, {
      status: 'approved', approved_amount: granted, considered_by: args.actor.epf,
      considered_by_name: args.actor.name, considered_at: now, updated_at: now,
    });
    const ledRef = doc(collection(db, LEDGER));
    tx.set(ledRef, {
      id: ledRef.id, epf_number: req.epf_number, company_id: req.company_id, kind: 'credit' as SuspenseLedgerKind,
      amount: granted, balance_after: balAfter, ref_type: 'request', ref_id: args.id,
      note: `Credit request approved (${req.company_name})` + limitNote, actor_epf: args.actor.epf, actor_name: args.actor.name, created_at: now,
    });
  });
  await notifyOwner(ownerEpf, 'suspense_approved', 'Credit request approved',
    `Your credit request was approved for ${formatSuspenseAmount(granted)}. New balance ${formatSuspenseAmount(balAfter)}.`, args.actor);
}

export async function rejectRequest(args: { id: string; reason: string; actor: Actor }): Promise<void> {
  const reqRef = doc(db, REQS, args.id);
  const snap = await getDoc(reqRef);
  if (!snap.exists()) throw new Error('Request not found.');
  const req = snap.data() as SuspenseRequest;
  if (req.status !== 'pending') throw new Error('This request has already been processed.');
  const now = Timestamp.now();
  await updateDoc(reqRef, {
    status: 'rejected', considered_by: args.actor.epf, considered_by_name: args.actor.name,
    considered_at: now, reject_reason: args.reason || null, updated_at: now,
  });
  await notifyOwner(req.epf_number, 'suspense_rejected', 'Credit request rejected',
    args.reason ? `Your credit request was rejected: ${args.reason}` : 'Your credit request was rejected.', args.actor);
}
