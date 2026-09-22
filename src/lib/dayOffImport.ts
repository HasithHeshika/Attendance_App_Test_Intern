'use client';
// Bulk Import Day Offs (Southern Lanka) — turns an uploaded .xlsx/.csv into reviewable draft
// rows for the import dialog on the Schedule page. Nothing here writes to Firestore; that
// happens from dayOffService.bulkCreateDayOffs once the reviewer confirms.
//
// Day Offs are the company-offered weekly rest-day allocation, NOT leave: an employee working
// 7 days a week gets ~1 off per week (4–5 per month). No "reason" — it's a roster line, not a
// request. The sheet is ONE ROW PER EMPLOYEE with up to five date columns (Date 1 … Date 5);
// every listed date becomes its own Day Off record.
//
// Strict validation (see below):
//   · every EPF must belong to the currently selected department;
//   · every date must be YYYY/MM/DD or YYYY-MM-DD — anything else is flagged, not guessed.
import type { AppUser } from '@/lib/types';

function normalizeHeader(h: string): string {
  return String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// A header is a "date column" if it normalizes to `date`, `dates`, `dateN` (Date 1 … Date 99),
// or one of the explicit aliases — there can be any number of them on a sheet.
const DATE_HEADER_ALIASES = new Set(['date', 'dates', 'dayoffdate', 'dayoffdates', 'offdate', 'leavedate']);
function isDateHeader(normalized: string): boolean {
  return DATE_HEADER_ALIASES.has(normalized) || /^date\d{1,2}$/.test(normalized);
}

type SingleFieldKey = 'epf' | 'name';
const SINGLE_HEADER_ALIASES: Record<SingleFieldKey, string[]> = {
  epf:  ['epfnumber', 'epf', 'epfno', 'employeeid', 'empno', 'employeenumber'],
  name: ['name', 'employeename', 'empname', 'fullname'],
};
const ALIAS_TO_SINGLE = new Map<string, SingleFieldKey>();
for (const key of Object.keys(SINGLE_HEADER_ALIASES) as SingleFieldKey[]) {
  for (const a of SINGLE_HEADER_ALIASES[key]) ALIAS_TO_SINGLE.set(a, key);
}

// Split one date cell into its individual tokens. Comma / semicolon / newline separated — NOT
// "/" or "-", which are the date-part separators of the accepted YYYY/MM/DD format.
function splitDateCell(cell: string): string[] {
  return String(cell ?? '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── Strict date parsing — YYYY/MM/DD or YYYY-MM-DD only ──────────────────────
// Year FIRST, 4 digits, then month then day, separated by "/" or "-". Month/day may be 1- or
// 2-digit. The value must be a real calendar date (no month 13, no Feb 30, no rollover).
// Returns the normalized 'YYYY-MM-DD' string, or '' for ANY other input — Excel serials,
// MM/DD/YYYY, DD-MM-YYYY, 2-digit years, and free text are all rejected, not guessed.
const STRICT_DATE_RE = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/;
export function parseStrictDayOffDate(raw: string): string {
  const t = String(raw ?? '').trim();
  const m = STRICT_DATE_RE.exec(t);
  if (!m) return '';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}`;
}

export class MissingDayOffHeadersError extends Error {
  missingHeaders: string[];
  constructor(missingHeaders: string[]) {
    super(`Missing required column(s): ${missingHeaders.join(', ')}`);
    this.name = 'MissingDayOffHeadersError';
    this.missingHeaders = missingHeaders;
  }
}

// One sheet row = one employee, with every date it listed (across every Date column, each
// possibly multi-valued) flattened into `dateRaws`.
export interface ParsedDayOffRow {
  epfRaw: string;
  nameRaw: string;
  dateRaws: string[];
}

export async function parseDayOffWorkbook(file: File): Promise<ParsedDayOffRow[]> {
  const { read, utils } = await import('xlsx');
  const buf = await file.arrayBuffer();
  // cellDates + dateNF: a real Excel date cell comes back as a clean 'yyyy-mm-dd' string
  // (which then passes strict parsing below) rather than a serial number.
  const wb = read(buf, { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const aoa = utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '', dateNF: 'yyyy-mm-dd' });
  if (!aoa.length) return [];

  const headerRow = aoa[0].map((h) => String(h ?? ''));
  const normalized = headerRow.map(normalizeHeader);
  const epfCol   = normalized.findIndex((h) => ALIAS_TO_SINGLE.get(h) === 'epf');
  const nameCol  = normalized.findIndex((h) => ALIAS_TO_SINGLE.get(h) === 'name');
  const dateCols = normalized.map((h, i) => (isDateHeader(h) ? i : -1)).filter((i) => i >= 0);

  const missing: string[] = [];
  if (epfCol < 0) missing.push('EPF Number');
  if (dateCols.length === 0) missing.push('Date 1');
  if (missing.length) throw new MissingDayOffHeadersError(missing);

  const rows: ParsedDayOffRow[] = [];
  for (const line of aoa.slice(1)) {
    const epfRaw   = String(line[epfCol] ?? '').trim();
    const nameRaw  = nameCol >= 0 ? String(line[nameCol] ?? '').trim() : '';
    const dateRaws = dateCols.flatMap((i) => splitDateCell(String(line[i] ?? '')));

    if (!epfRaw && !nameRaw && !dateRaws.length) continue; // fully blank row
    // Drop the shipped example row if it's still there (matched on EPF + its first date).
    if (epfRaw.toLowerCase() === EXAMPLE_ROW.epf.toLowerCase() && dateRaws[0] === EXAMPLE_ROW.dates[0]) continue;

    rows.push({ epfRaw, nameRaw, dateRaws });
  }
  return rows;
}

// One reviewable line per (employee, date) — an employee with 4 dates fans out into 4 rows,
// each with its own importable/issue status.
export interface DayOffDraftRow {
  id: string;
  epf_number: string;    // normalized
  employee_name: string; // resolved from the user directory, else the sheet's name, else EPF
  date: string;          // 'yyyy-MM-dd' or '' when invalid / missing
  epfRaw: string;
  dateRaw: string;
  matchedUser: boolean;
  issue: string;         // '' → importable
}

// EPF normalization mirrors userService.normalizeEpf / usersImportParse (kept local so this
// stays a plain parsing module): strip ALL whitespace so "SLH/E 378" keys the same as
// "SLH/E378".
function normalizeEpf(raw: string): string {
  return String(raw ?? '').replace(/\s+/g, '');
}

function sameDepartment(a: string | undefined, b: string): boolean {
  return String(a ?? '').trim().toLowerCase() === b.trim().toLowerCase();
}

// Resolve each parsed row against the active-user directory, enforce the department scope and
// strict date format, and fan out to one line per (employee, date). `departmentName` — the
// currently selected department on the Schedule page; when set, every EPF must belong to it.
export function buildDayOffDraftRows(
  rows: ParsedDayOffRow[],
  users: AppUser[],
  departmentName?: string,
): DayOffDraftRow[] {
  const byEpf = new Map<string, AppUser>();
  for (const u of users) {
    if (u.is_active === false) continue;
    byEpf.set(normalizeEpf(u.epf_number).toLowerCase(), u);
  }
  const scope = departmentName?.trim() ?? '';

  const seenInSheet = new Set<string>();
  const out: DayOffDraftRow[] = [];

  for (const r of rows) {
    const epf = normalizeEpf(r.epfRaw);
    const user = byEpf.get(epf.toLowerCase()) ?? null;
    const name = user?.display_name || r.nameRaw || epf;
    // A pre-filled template row for an employee who wasn't allocated any dates this round is
    // just an unfilled worksheet line — skip it silently (no import, no noisy "issue").
    if (user && r.dateRaws.length === 0) continue;
    // Row-level problems (bad EPF, unknown EPF, wrong department) — reported once, one line.
    const rowIssue = !epf
      ? 'No EPF number'
      : !user
        ? `EPF "${r.epfRaw}" is not an active employee`
        : (scope && !sameDepartment(user.department, scope))
          ? 'Employee does not belong to the selected department'
          : '';
    if (rowIssue) {
      out.push({
        id: crypto.randomUUID(),
        epf_number: epf,
        employee_name: name,
        date: '',
        epfRaw: r.epfRaw,
        dateRaw: r.dateRaws.join(', '),
        matchedUser: !!user,
        issue: rowIssue,
      });
      continue;
    }
    // One line per listed date — strict YYYY/MM/DD (or YYYY-MM-DD) only.
    for (const dateRaw of r.dateRaws) {
      const date = parseStrictDayOffDate(dateRaw);
      const key = `${epf.toLowerCase()}|${date}`;
      const dupInSheet = !!date && seenInSheet.has(key);
      if (date) seenInSheet.add(key);
      out.push({
        id: crypto.randomUUID(),
        epf_number: epf,
        employee_name: name,
        date,
        epfRaw: r.epfRaw,
        dateRaw,
        matchedUser: true,
        issue: !date
          ? `Invalid date "${dateRaw}" — use YYYY/MM/DD`
          : dupInSheet
            ? 'This employee/date appears more than once in the sheet'
            : '',
      });
    }
  }
  return out;
}

// ─── Template ─────────────────────────────────────────────────────────────────
export const DAY_OFF_TEMPLATE_HEADERS = [
  'EPF Number', 'Employee Name', 'Date 1', 'Date 2', 'Date 3', 'Date 4', 'Date 5',
] as const;
const DATE_SLOTS = 5;

const EXAMPLE_ROW = {
  epf: 'SLH/E123',
  name: 'Nimal Perera',
  dates: ['2026/01/04', '2026/01/11', '2026/01/18', '2026/01/25'],
};

export interface DayOffTemplateEmployee { epf_number: string; employee_name: string }

// Download a ready-to-fill .xlsx. When `employees` is supplied (the selected department's
// active staff), it's pre-filled with one row per employee — EPF Number + Employee Name
// populated, the five Date columns blank for the allocator to fill in (YYYY/MM/DD).
export async function downloadDayOffTemplate(
  employees?: DayOffTemplateEmployee[],
  departmentName?: string,
): Promise<void> {
  const { utils, writeFile } = await import('xlsx');
  const blanks = Array(DATE_SLOTS).fill('');
  const body = employees?.length
    ? employees.map((e) => [e.epf_number, e.employee_name, ...blanks])
    : [[
        EXAMPLE_ROW.epf,
        EXAMPLE_ROW.name,
        ...Array.from({ length: DATE_SLOTS }, (_, i) => EXAMPLE_ROW.dates[i] ?? ''),
      ]];
  const ws = utils.aoa_to_sheet([[...DAY_OFF_TEMPLATE_HEADERS], ...body]);
  ws['!cols'] = [{ wch: 16 }, { wch: 24 }, ...Array(DATE_SLOTS).fill({ wch: 12 })];
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, 'Day Offs');
  const slug = (departmentName ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  writeFile(wb, slug ? `day-offs-${slug}.xlsx` : 'day-offs-template.xlsx');
}
