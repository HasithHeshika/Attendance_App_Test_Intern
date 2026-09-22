'use client';
// Bulk Shift Roster Import (Southern Lanka) — turns an uploaded roster .xlsx/.csv into
// reviewable draft rows for ImportShiftsDialog on the Schedule page. Nothing here writes to
// Firestore; that happens from scheduleAssignmentService.bulkCreateScheduleAssignments once
// the reviewer confirms.
//
// Sheet shape: ONE ROW PER EMPLOYEE. Columns are EPF Number | Employee Name | then one column
// per day of the roster month. The downloaded template heads each with the actual date string
// (YYYY-MM-DD, e.g. 2026-08-01 … 2026-08-31); the parser ALSO still accepts YYYY/MM/DD headers
// and generic "Day N" headers, so hand-built or older sheets keep working. Each date cell holds
// one or more SHIFT NAMES, comma- or slash-separated (e.g. "Morning, Evening" or "Morning/Night").
// Every shift name is matched — case-insensitive, whitespace-trimmed — against the SELECTED
// DEPARTMENT's registered shifts; an unknown name is flagged, never guessed.
import type { AppUser, Shift } from '@/lib/types';
import { canUserAccessShift } from '@/lib/shiftAccess';
import { parseStrictDayOffDate } from '@/lib/dayOffImport';

function normalizeHeader(h: string): string {
  return String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function normalizeEpf(raw: string): string {
  return String(raw ?? '').replace(/\s+/g, '');
}
function normalizeShift(raw: string): string {
  return String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function sameDepartment(a: string | undefined, b: string): boolean {
  return String(a ?? '').trim().toLowerCase() === b.trim().toLowerCase();
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

// A date column is either "Day N" (1–31, resolved against the roster month) or a literal
// YYYY/MM/DD header.
type DateCol =
  | { index: number; kind: 'day'; day: number; label: string }
  | { index: number; kind: 'date'; iso: string; label: string };

function classifyDateHeader(raw: string, index: number): DateCol | null {
  const norm = normalizeHeader(raw);
  const dayM = /^day(\d{1,2})$/.exec(norm);
  if (dayM) {
    const day = Number(dayM[1]);
    if (day >= 1 && day <= 31) return { index, kind: 'day', day, label: `Day ${day}` };
    return null;
  }
  const iso = parseStrictDayOffDate(raw);
  if (iso) return { index, kind: 'date', iso, label: raw.trim() };
  return null;
}

// Split one roster cell into individual shift-name tokens — comma OR slash separated (also
// semicolon / newline). "Morning, Evening" and "Morning/Night" both fan out.
function splitShiftCell(cell: string): string[] {
  return String(cell ?? '')
    .split(/[,/;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export class MissingRosterHeadersError extends Error {
  missingHeaders: string[];
  constructor(missingHeaders: string[]) {
    super(`Missing required column(s): ${missingHeaders.join(', ')}`);
    this.name = 'MissingRosterHeadersError';
    this.missingHeaders = missingHeaders;
  }
}

interface RawCell { date: string; label: string; shiftTokens: string[] }
export interface ParsedRosterRow {
  epfRaw: string;
  nameRaw: string;
  cells: RawCell[];
}

export interface RosterParseContext {
  // The roster month — resolves "Day N" columns. Any month/year; only year+month are used.
  month: Date;
}

// Read the sheet into raw {epf, name, cells[]} rows. `ctx.month` resolves "Day N" headers.
// Requires an EPF column and at least one date column.
export async function parseShiftRosterWorkbook(
  file: File, ctx: RosterParseContext,
): Promise<ParsedRosterRow[]> {
  const { read, utils } = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = read(buf, { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const aoa = utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '', dateNF: 'yyyy-mm-dd' });
  if (!aoa.length) return [];

  const headerRow = aoa[0].map((h) => String(h ?? ''));
  const normalized = headerRow.map(normalizeHeader);
  const epfCol  = normalized.findIndex((h) => ALIAS_TO_SINGLE.get(h) === 'epf');
  const nameCol = normalized.findIndex((h) => ALIAS_TO_SINGLE.get(h) === 'name');
  const dateCols: DateCol[] = headerRow
    .map((h, i) => classifyDateHeader(h, i))
    .filter((c): c is DateCol => c !== null);

  const missing: string[] = [];
  if (epfCol < 0) missing.push('EPF Number');
  if (dateCols.length === 0) missing.push('Day 1');
  if (missing.length) throw new MissingRosterHeadersError(missing);

  const year = ctx.month.getFullYear();
  const mon = ctx.month.getMonth();
  const daysInMonth = new Date(year, mon + 1, 0).getDate();
  const p = (n: number) => String(n).padStart(2, '0');

  const rows: ParsedRosterRow[] = [];
  for (const line of aoa.slice(1)) {
    const epfRaw = String(line[epfCol] ?? '').trim();
    const nameRaw = nameCol >= 0 ? String(line[nameCol] ?? '').trim() : '';

    const cells: RawCell[] = [];
    for (const dc of dateCols) {
      const shiftTokens = splitShiftCell(String(line[dc.index] ?? ''));
      if (!shiftTokens.length) continue;
      const date = dc.kind === 'date'
        ? dc.iso
        : (dc.day <= daysInMonth ? `${year}-${p(mon + 1)}-${p(dc.day)}` : '');
      cells.push({ date, label: dc.label, shiftTokens });
    }

    if (!epfRaw && !nameRaw && !cells.length) continue; // fully blank row
    // Drop the shipped example row if it's still there.
    if (epfRaw.toLowerCase() === EXAMPLE_EPF.toLowerCase()) continue;

    rows.push({ epfRaw, nameRaw, cells });
  }
  return rows;
}

// One reviewable line per (employee, date, shift).
export interface RosterDraftRow {
  id: string;
  epf_number: string;
  employee_name: string;
  date: string;        // 'yyyy-MM-dd' or '' when the column couldn't resolve
  dateLabel: string;   // "Day 5" or the literal header
  shift_id: string;    // '' when the shift name didn't match the department
  shift_name: string;  // resolved canonical name, else the raw token
  start_time: string;
  end_time: string;
  rawShift: string;
  matchedUser: boolean;
  issue: string;       // '' → importable
}

// Resolve parsed rows against the active-user directory + the SELECTED DEPARTMENT's shift
// master, and fan out to one line per (employee, date, shift).
//   · every EPF must belong to `departmentName`;
//   · every shift name must exist in `departmentShifts` (case-insensitive, trimmed);
//   · for a RESTRICTED shift (Shift.eligible_roles / eligible_user_epfs — see
//     src/lib/shiftAccess.ts) the employee must be eligible: an effective Head of
//     Department or an explicitly listed EPF. Same gate the Schedule grid's cell dialog
//     applies, so the two import paths can't diverge.
export function buildRosterDraftRows(
  rows: ParsedRosterRow[],
  users: AppUser[],
  departmentShifts: Shift[],
  departmentName: string,
): RosterDraftRow[] {
  const byEpf = new Map<string, AppUser>();
  for (const u of users) {
    if (u.is_active === false) continue;
    byEpf.set(normalizeEpf(u.epf_number).toLowerCase(), u);
  }
  const shiftByName = new Map<string, Shift>();
  for (const s of departmentShifts) shiftByName.set(normalizeShift(s.name), s);
  const scope = departmentName.trim();

  const seen = new Set<string>();
  const out: RosterDraftRow[] = [];

  for (const r of rows) {
    const epf = normalizeEpf(r.epfRaw);
    const user = byEpf.get(epf.toLowerCase()) ?? null;
    const name = user?.display_name || r.nameRaw || epf;

    // An employee row with no shift cells filled in is just an unallocated worksheet line.
    if (user && r.cells.length === 0) continue;

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
        epf_number: epf, employee_name: name,
        date: '', dateLabel: '', shift_id: '', shift_name: '', start_time: '', end_time: '',
        rawShift: '', matchedUser: !!user, issue: rowIssue,
      });
      continue;
    }

    for (const cell of r.cells) {
      for (const token of cell.shiftTokens) {
        const match = shiftByName.get(normalizeShift(token)) ?? null;
        const key = `${epf.toLowerCase()}|${cell.date}|${match?.id ?? token.toLowerCase()}`;
        const dup = !!cell.date && !!match && seen.has(key);
        if (cell.date && match) seen.add(key);
        out.push({
          id: crypto.randomUUID(),
          epf_number: epf,
          employee_name: name,
          date: cell.date,
          dateLabel: cell.label,
          shift_id: match?.id ?? '',
          shift_name: match?.name ?? token,
          start_time: match?.start_time ?? '',
          end_time: match?.end_time ?? '',
          rawShift: token,
          matchedUser: true,
          issue: !cell.date
            ? `${cell.label} is outside the roster month`
            : !match
              ? `Shift '${token}' is not valid for ${departmentName}`
              : dup
                ? 'This employee/date/shift appears more than once in the sheet'
                : !canUserAccessShift(user, match)
                  ? `${name} (${epf}) is not eligible for the restricted shift '${match.name}'`
                  : '',
        });
      }
    }
  }
  return out;
}

// ─── Template ─────────────────────────────────────────────────────────────────
const EXAMPLE_EPF = 'SLH/E123';

export interface RosterTemplateEmployee { epf_number: string; employee_name: string }

// Download a roster template for `month`: headers EPF Number | Employee Name | then one column
// per calendar day of that month, each headed by the ACTUAL date string (YYYY-MM-DD), e.g.
// 2026-08-01 … 2026-08-31. Pre-filled with one row per department employee, date cells blank
// and ready for shift names. (The parser still accepts "Day N" headers too, so an older sheet
// keeps working — see classifyDateHeader.)
export async function downloadShiftRosterTemplate(
  employees: RosterTemplateEmployee[] | undefined,
  departmentName: string | undefined,
  month: Date,
): Promise<void> {
  const { utils, writeFile } = await import('xlsx');
  const year = month.getFullYear();
  const mon = month.getMonth();
  const daysInMonth = new Date(year, mon + 1, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  // Exact dates, day 1 → last day of the selected month, as YYYY-MM-DD.
  const dateHeaders = Array.from({ length: daysInMonth }, (_, i) => `${year}-${pad(mon + 1)}-${pad(i + 1)}`);
  const headers = ['EPF Number', 'Employee Name', ...dateHeaders];
  const blanks = Array(daysInMonth).fill('');
  const body = employees?.length
    ? employees.map((e) => [e.epf_number, e.employee_name, ...blanks])
    : [[EXAMPLE_EPF, 'Nimal Perera', 'Morning', 'Morning, Evening', ...Array(daysInMonth - 2).fill('')]];
  const ws = utils.aoa_to_sheet([headers, ...body]);
  ws['!cols'] = [{ wch: 16 }, { wch: 24 }, ...Array(daysInMonth).fill({ wch: 14 })];
  const wb = utils.book_new();
  const monLabel = month.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  utils.book_append_sheet(wb, ws, `Roster ${monLabel}`.slice(0, 31));
  const slug = (departmentName ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  writeFile(wb, `shift-roster-${slug || 'template'}-${year}-${String(mon + 1).padStart(2, '0')}.xlsx`);
}
