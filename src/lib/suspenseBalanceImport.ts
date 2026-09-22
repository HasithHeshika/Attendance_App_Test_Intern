// Suspense carry-forward upload — turns an uploaded .xlsx/.csv of "EPF → amount" into reviewable
// draft rows for ImportBalancesDialog on the /suspense Accounts tab. Nothing here writes to
// Firestore; applyCarryForward in suspenseService.ts does that once the approver confirms.
//
// The uploaded figure is the PREVIOUS PERIOD'S CLOSING BALANCE, carried forward as a MOVEMENT:
// it is added to whatever the account holds today, so a positive figure raises the balance and a
// negative one (the holder spent past their float) lowers it. It is NOT the balance the account
// should end at — an account sitting at 10,000 with 0.00 in the sheet keeps its 10,000, it is
// not zeroed.
//
// Because adding is not repeatable the way setting a balance was, every upload names the PERIOD
// it carries ('YYYY-MM'). An account that already records that period is flagged here as a
// repeat and left out unless the approver deliberately overrides it — re-running one sheet would
// otherwise double every amount on it.
//
// A blank amount cell means "leave this account alone". The template ships pre-filled with
// everyone's current balance in a reference column and an empty one to fill in, so an approver
// can send a sheet back having filled in only the handful of rows that actually carry anything.
import type { AppUser, SuspenseAccount } from '@/lib/types';

function normalizeHeader(h: string): string {
  return String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// EPF normalization mirrors userService.normalizeEpf / dayOffImport (kept local so this stays a
// plain parsing module): strip ALL whitespace so "SLH/E 378" keys the same as "SLH/E378".
function normalizeEpf(raw: string): string {
  return String(raw ?? '').replace(/\s+/g, '');
}

const money = (n: number): number => {
  const r = Math.round((Number(n) || 0) * 100) / 100;
  return r === 0 ? 0 : r;   // never hand back -0, which formats as "-0.00"
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

// ─── Periods ──────────────────────────────────────────────────────────────────
/** 'YYYY-MM' for the month a carry-forward date falls in. */
export function carryForwardPeriod(asAt: Date): string {
  return `${asAt.getFullYear()}-${pad2(asAt.getMonth() + 1)}`;
}

/**
 * The default as-at date: the FIRST of the current month, in local time. A carry-forward dated
 * 1 September 2026 is August's closing position arriving at the top of September, which is how
 * the sheet is actually produced — so the approver normally confirms this rather than typing it.
 */
export function defaultCarryForwardDate(today: Date = new Date()): Date {
  return new Date(today.getFullYear(), today.getMonth(), 1);
}

/** 'YYYY-MM-DD' for an <input type="date"> value, in LOCAL time (never toISOString, which is UTC). */
export function toDateInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Parse an <input type="date"> value back to a LOCAL midnight Date; null if unusable. */
export function fromDateInputValue(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─── Money parsing ────────────────────────────────────────────────────────────
// Accepts what a real ledger export actually looks like: "1,234.50", "-1500", "(1,500)"
// (accounting negative), "LKR 1500", "1500-" (trailing minus). Returns null for anything it
// cannot read with certainty — an amount is never guessed at.
export function parseBalanceAmount(raw: string): number | null {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  const paren = /^\((.*)\)$/.exec(t);
  const body = paren ? paren[1] : t;
  // European "1.234,50" would silently become 1.23 once commas are stripped — reject it rather
  // than corrupt an amount. (Sri Lanka writes money the en-US way: 1,234.50.)
  if (body.includes(',') && body.includes('.') && body.lastIndexOf(',') > body.lastIndexOf('.')) return null;
  let cleaned = body
    .replace(/lkr|rs\.?|₨/gi, '')   // currency label
    .replace(/[\s,]/g, '')          // thousands separators + stray spaces
    .trim();
  if (cleaned.endsWith('-')) cleaned = `-${cleaned.slice(0, -1)}`;   // trailing minus
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return paren ? money(-Math.abs(n)) : money(n);
}

// ─── Workbook → raw rows ──────────────────────────────────────────────────────
const EPF_ALIASES = new Set(['epfnumber', 'epf', 'epfno', 'employeeid', 'empno', 'employeenumber']);
const NAME_ALIASES = new Set(['name', 'employeename', 'empname', 'fullname']);
const COMPANY_ALIASES = new Set(['company', 'companyname', 'branch', 'branchcompany']);
// The template carries exactly two figures: "Current Balance", a read-only reference column, and
// the one the approver fills in. Only the second is ever read — "Current Balance" is deliberately
// NOT an alias, so a sheet can show today's position beside the figure being carried without the
// importer confusing the two.
//
// Matched by PREFIX, not equality, because the template stamps the as-at date into that header
// ("Carry Forward as at 01 Sep 2026" → `carryforwardasat01sep2026`) so a filled-in sheet says on
// its face which month it belongs to. The generic fallbacks below are exact.
const AMOUNT_PREFIXES = ['carryforward', 'broughtforward'];
const AMOUNT_ALIASES = new Set(['balance', 'openingbalance', 'closingbalance', 'amount']);

/**
 * Which column holds the figure to carry, given the sheet's normalized headers. Pure and
 * exported so the header rules are unit-testable without building a workbook — the prefix match
 * is the part that quietly decides whether a real uploaded sheet is read or rejected.
 * Returns -1 when nothing matches.
 */
export function findAmountColumn(normalizedHeaders: string[]): number {
  for (const prefix of AMOUNT_PREFIXES) {
    const i = normalizedHeaders.findIndex((h) => h.startsWith(prefix));
    if (i >= 0) return i;
  }
  return normalizedHeaders.findIndex((h) => AMOUNT_ALIASES.has(h));
}

export class MissingBalanceHeadersError extends Error {
  missingHeaders: string[];
  constructor(missingHeaders: string[]) {
    super(`Missing required column(s): ${missingHeaders.join(', ')}`);
    this.name = 'MissingBalanceHeadersError';
    this.missingHeaders = missingHeaders;
  }
}

export interface ParsedBalanceRow {
  epfRaw: string;
  nameRaw: string;
  companyRaw: string;
  balanceRaw: string;
}

export async function parseBalanceWorkbook(file: File): Promise<ParsedBalanceRow[]> {
  const { read, utils } = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  // raw:false so a formatted currency cell arrives as the text the approver sees — the same
  // string the CSV path produces, which parseBalanceAmount then reads.
  const aoa = utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' });
  if (!aoa.length) return [];

  const normalized = aoa[0].map((h) => normalizeHeader(String(h ?? '')));
  const epfCol = normalized.findIndex((h) => EPF_ALIASES.has(h));
  const nameCol = normalized.findIndex((h) => NAME_ALIASES.has(h));
  const companyCol = normalized.findIndex((h) => COMPANY_ALIASES.has(h));
  const amountCol = findAmountColumn(normalized);

  const missing: string[] = [];
  if (epfCol < 0) missing.push('EPF Number');
  if (amountCol < 0) missing.push('Carry Forward');
  if (missing.length) throw new MissingBalanceHeadersError(missing);

  const rows: ParsedBalanceRow[] = [];
  for (const line of aoa.slice(1)) {
    const epfRaw = String(line[epfCol] ?? '').trim();
    const nameRaw = nameCol >= 0 ? String(line[nameCol] ?? '').trim() : '';
    const companyRaw = companyCol >= 0 ? String(line[companyCol] ?? '').trim() : '';
    const balanceRaw = String(line[amountCol] ?? '').trim();
    if (!epfRaw && !balanceRaw) continue;                                   // fully blank row
    if (epfRaw.toLowerCase() === EXAMPLE_ROW.epf.toLowerCase()) continue;   // shipped example, left in place
    rows.push({ epfRaw, nameRaw, companyRaw, balanceRaw });
  }
  return rows;
}

// ─── Raw rows → reviewable drafts ─────────────────────────────────────────────
export interface BalanceDraftRow {
  id: string;
  epf_number: string;
  employee_name: string;
  company_id: string;
  company_name: string;
  currency: string;
  /** Balance the account reads today; null when the employee has no account for this company. */
  current: number | null;
  /** The carry-forward from the sheet — the movement to apply, positive or negative. */
  amount: number;
  /** What the balance reads once this is carried in (== amount when the account is being opened). */
  resulting: number;
  /** 'unchanged' means the sheet carries 0.00 — nothing to move, so nothing is written. */
  action: 'open' | 'adjust' | 'unchanged';
  /**
   * This account already records the period being uploaded. Not an `issue` — the row is complete
   * and correct, it just looks like a re-upload, so it is held back behind an explicit override
   * rather than refused outright.
   */
  alreadyCarried: boolean;
  epfRaw: string;
  balanceRaw: string;
  issue: string;    // '' → importable
}

const accountKey = (epf: string, companyId: string) => `${normalizeEpf(epf).toLowerCase()}__${companyId}`;

/**
 * Resolve each sheet row against the existing accounts and the user directory.
 *
 * Company resolution, in order: the sheet's own Company column → the employee's single existing
 * account → their own company from the directory (which OPENS an account). Someone holding
 * several company accounts with no Company column named is flagged rather than guessed at —
 * picking the wrong one would silently move the wrong balance.
 *
 * `period` ('YYYY-MM') is the month being carried in. Any account already recording it comes
 * back with `alreadyCarried` set, so the dialog can hold it back instead of doubling it.
 */
export function buildBalanceDraftRows(
  rows: ParsedBalanceRow[],
  accounts: SuspenseAccount[],
  users: AppUser[],
  period = '',
): BalanceDraftRow[] {
  const byEpf = new Map<string, SuspenseAccount[]>();
  for (const a of accounts) {
    const k = normalizeEpf(a.epf_number).toLowerCase();
    const list = byEpf.get(k) ?? [];
    list.push(a);
    byEpf.set(k, list);
  }
  const userByEpf = new Map<string, AppUser>();
  for (const u of users) {
    if (u.is_active === false) continue;
    userByEpf.set(normalizeEpf(u.epf_number).toLowerCase(), u);
  }

  const seen = new Set<string>();
  const out: BalanceDraftRow[] = [];

  rows.forEach((r, i) => {
    // A pre-filled template line the approver didn't fill in is not an error — it just means
    // "this account carries nothing". Trimmed here as well as in the parser, so a cell of
    // spaces reads as empty however these rows were built.
    if (!r.balanceRaw.trim()) return;

    const epf = normalizeEpf(r.epfRaw);
    const key = epf.toLowerCase();
    const user = userByEpf.get(key) ?? null;
    const mine = byEpf.get(key) ?? [];
    const name = user?.display_name || mine[0]?.employee_name || r.nameRaw || epf;

    const push = (patch: Partial<BalanceDraftRow>) => out.push({
      id: `${i}-${key || 'blank'}`,
      epf_number: epf, employee_name: name, company_id: '', company_name: '',
      currency: mine[0]?.currency ?? 'LKR',
      current: null, amount: 0, resulting: 0, action: 'adjust', alreadyCarried: false,
      epfRaw: r.epfRaw, balanceRaw: r.balanceRaw, issue: '',
      ...patch,
    });

    if (!epf) return push({ issue: 'No EPF number' });
    const amount = parseBalanceAmount(r.balanceRaw);
    if (amount === null) return push({ issue: `Invalid amount "${r.balanceRaw}" — use a number like 1500 or -1500` });

    // Which company's account this row carries into.
    const wanted = r.companyRaw.trim().toLowerCase();
    let account: SuspenseAccount | null = null;
    let companyId = '';
    let companyName = '';
    if (wanted) {
      account = mine.find(a => a.company_name.trim().toLowerCase() === wanted || a.company_id.toLowerCase() === wanted) ?? null;
      if (account) {
        companyId = account.company_id;
        companyName = account.company_name;
      } else if (user && (user.company_name.trim().toLowerCase() === wanted || user.company_id.toLowerCase() === wanted)) {
        companyId = user.company_id;
        companyName = user.company_name;
      } else {
        return push({ amount, issue: `No account or company matching "${r.companyRaw}" for this employee` });
      }
    } else if (mine.length === 1) {
      account = mine[0];
      companyId = account.company_id;
      companyName = account.company_name;
    } else if (mine.length > 1) {
      return push({ amount, issue: `Holds ${mine.length} company accounts — add a Company column to say which` });
    } else if (user) {
      companyId = user.company_id;
      companyName = user.company_name;
    } else {
      return push({ amount, issue: `EPF "${r.epfRaw}" is not an active employee` });
    }

    const dupKey = accountKey(epf, companyId);
    if (seen.has(dupKey)) {
      return push({
        amount, company_id: companyId, company_name: companyName, current: account?.balance ?? null,
        issue: 'This employee/company appears more than once in the sheet',
      });
    }
    seen.add(dupKey);

    if (account?.is_closed) {
      return push({
        amount, company_id: companyId, company_name: companyName,
        current: money(account.balance), currency: account.currency, issue: 'This account is closed',
      });
    }
    if (account && account.is_active === false) {
      return push({
        amount, company_id: companyId, company_name: companyName,
        current: money(account.balance), currency: account.currency,
        issue: 'A close request is pending on this account',
      });
    }

    const current = account ? money(account.balance) : null;
    push({
      amount,
      current,
      resulting: money((current ?? 0) + amount),
      company_id: companyId, company_name: companyName,
      currency: account?.currency ?? 'LKR',
      action: !account ? 'open' : amount === 0 ? 'unchanged' : 'adjust',
      alreadyCarried: !!period && !!account && (account.carry_forward_periods ?? []).includes(period),
    });
  });

  return out;
}

// ─── Template ─────────────────────────────────────────────────────────────────
// Fixed, not toLocaleDateString: this string is written INTO a file that gets mailed around and
// opened elsewhere, and the runtime's own ICU decides between "Sep" and "Sept" (Node 22 says
// Sept for en-GB). A header that renders differently per machine is a header nobody can rely on.
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "01 Sep 2026" — the as-at date as it appears in the template's own column header. */
export function formatCarryForwardDate(asAt: Date): string {
  return `${pad2(asAt.getDate())} ${MONTH_ABBR[asAt.getMonth()]} ${asAt.getFullYear()}`;
}

/**
 * The fill-in column's header, carrying the date it is as at, so a sheet that has been mailed
 * around and filled in still says which month it belongs to. findAmountColumn matches it by
 * prefix, so the date can change freely without breaking the upload.
 */
export const carryForwardHeader = (asAt?: Date | null): string =>
  asAt ? `Carry Forward as at ${formatCarryForwardDate(asAt)}` : 'Carry Forward';

export const SUSPENSE_BALANCE_TEMPLATE_HEADERS = [
  'EPF Number', 'Employee Name', 'Company', 'Current Balance', 'Carry Forward',
] as const;

const EXAMPLE_ROW = { epf: 'SLH/E123', name: 'Nimal Perera', company: 'Alta Vision', current: '0.00', balance: '-2500' };

/**
 * Download a ready-to-fill .xlsx. Two figures per row: "Current Balance", pre-filled with what
 * the account reads today and never read back, and the dated "Carry Forward" column, which is
 * the only thing the approver types. Rows left blank are ignored on upload, so an approver can
 * carry three people out of two hundred.
 */
export async function downloadBalanceTemplate(accounts: SuspenseAccount[], asAt?: Date | null): Promise<void> {
  const { utils, writeFile } = await import('xlsx');
  const open = accounts.filter(a => !a.is_closed);
  const headers = [...SUSPENSE_BALANCE_TEMPLATE_HEADERS.slice(0, 4), carryForwardHeader(asAt)];
  const body = open.length
    ? open.map(a => [a.epf_number, a.employee_name, a.company_name, money(a.balance).toFixed(2), ''])
    : [[EXAMPLE_ROW.epf, EXAMPLE_ROW.name, EXAMPLE_ROW.company, EXAMPLE_ROW.current, EXAMPLE_ROW.balance]];
  const ws = utils.aoa_to_sheet([headers, ...body]);
  ws['!cols'] = [{ wch: 16 }, { wch: 26 }, { wch: 22 }, { wch: 16 }, { wch: 26 }];
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, 'Balances');
  writeFile(wb, `suspense-carry-forward${asAt ? `-${carryForwardPeriod(asAt)}` : ''}.xlsx`);
}
