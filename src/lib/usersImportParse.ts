'use client';
// Bulk Import Users — turns an uploaded .xlsx/.csv into editable draft rows for the review
// screen on /users/bulk-add. Nothing here writes to Firestore; that happens row-by-row from
// the page once the admin has reviewed/fixed the drafts and hits Import.

import { parse as parseDate, isValid as isValidDate, format as formatDate } from 'date-fns';
import { fuzzyScore } from '@/lib/fuzzy';
import type { Company, Department } from '@/lib/types';
import type { Role } from '@/lib/permissions';
import { USERS_IMPORT_COLUMNS, type UsersImportFieldKey } from '@/lib/usersImportTemplate';

// ─── Editable draft row shape (bound directly to the review table's inputs) ──────────────
export interface ImportRowDraft {
  id: string;                 // local key only (crypto.randomUUID) — never sent anywhere
  full_name: string;
  name_with_initials: string;
  first_name: string;         // best-effort derived, always editable — see deriveNames
  last_name: string;
  role: string;                // resolved role NAME, or the raw sheet text if unmatched
  department: string;          // resolved/typed department NAME (free text — no FK to match)
  company_id: string;          // resolved company id, or the raw sheet text if unmatched
  nic: string;
  epf_number: string;
  employee_number: string;
  email: string;
  date_of_join: string;        // 'yyyy-MM-dd' or '' if blank/unparseable
  gender: string;               // 'Male' | 'Female', or the raw sheet text if unmatched
  date_of_birth: string;        // 'yyyy-MM-dd' or '' if blank/unparseable
  address: string;
  phone_personal: string;
  guardian_contact: string;
  // Raw sheet text kept around so the review table can show "not matched: <text>" hints even
  // after the field above has been edited/cleared.
  roleTextRaw: string;
  departmentTextRaw: string;
  companyTextRaw: string;
}

// ─── Step 1: read the file into raw column text, keyed by our known field names ──────────
type RawRow = Record<UsersImportFieldKey, string>;

// Loosens header text before comparing so spacing/punctuation differences in a hand-edited
// sheet ("Designation (Role)", "designation-role") still match our canonical header.
function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
const HEADER_TO_KEY = new Map<string, UsersImportFieldKey>(
  USERS_IMPORT_COLUMNS.map((c) => [normalizeHeader(c.header), c.key]),
);

// Thrown when the sheet's header row is missing one or more of the template's columns —
// the caller shows this specifically (naming what's missing) instead of the generic
// "couldn't read that file" error, and aborts before touching any row data.
export class MissingHeadersError extends Error {
  missingHeaders: string[];
  constructor(missingHeaders: string[]) {
    super(`Missing required column(s): ${missingHeaders.join(', ')}`);
    this.name = 'MissingHeadersError';
    this.missingHeaders = missingHeaders;
  }
}

export async function parseUsersImportWorkbook(file: File): Promise<RawRow[]> {
  const { read, utils } = await import('xlsx');
  const buf = await file.arrayBuffer();
  // cellDates + dateNF: a real Excel date cell comes back as a clean 'yyyy-mm-dd' string
  // instead of a serial number or a locale-dependent formatted string.
  const wb = read(buf, { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  // Read the sheet twice: once formatted (raw:false — gives clean 'yyyy-mm-dd' date strings,
  // "25%", etc.) and once unformatted (raw:true — the underlying cell values). A 12-digit NIC
  // / EPF / phone number typed into a plain (non-Text) Excel cell is stored as a NUMBER, and
  // the formatted pass hands back Excel's scientific-notation *display* for it
  // ("1.9933E+11") — which then fails isValidNIC and shows up verbatim in the review field.
  // For any numeric cell we take the full-precision value from the raw pass instead;
  // everything else keeps the formatted text.
  const aoaFmt = utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
    dateNF: 'yyyy-mm-dd',
  });
  const aoaRaw = utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: '',
  });
  if (aoaFmt.length === 0) return [];

  const cellText = (rowIdx: number, colIdx: number): string => {
    const rawVal = aoaRaw[rowIdx]?.[colIdx];
    if (typeof rawVal === 'number' && Number.isFinite(rawVal)) {
      // toFixed(0) keeps every digit and never flips to exponential notation for the value
      // ranges these ID/phone columns hold (well inside Number.MAX_SAFE_INTEGER). Real date
      // cells come back as Date objects here, not numbers, so they fall through to aoaFmt.
      return Number.isInteger(rawVal) ? rawVal.toFixed(0) : String(rawVal);
    }
    const fmtVal = aoaFmt[rowIdx]?.[colIdx];
    if (fmtVal != null && fmtVal !== '') return String(fmtVal);
    return rawVal == null ? '' : String(rawVal);
  };

  const headerRow = (aoaFmt[0] ?? []).map((h) => String(h ?? ''));
  const colToKey = headerRow.map((h) => HEADER_TO_KEY.get(normalizeHeader(h)) ?? null);

  // Every template column must be present before anything else runs — a short/renamed
  // header row means the sheet isn't built from the template, and guessing at partial data
  // would be worse than refusing outright. Columns the sheet has that we DON'T recognise
  // (colToKey entries left `null` above) are the mirror case and are simply ignored below —
  // nothing is ever stored under an unknown header.
  const foundKeys = new Set(colToKey.filter((k): k is UsersImportFieldKey => !!k));
  const missingColumns = USERS_IMPORT_COLUMNS.filter((c) => !foundKeys.has(c.key));
  if (missingColumns.length > 0) {
    throw new MissingHeadersError(missingColumns.map((c) => c.header));
  }

  const exampleValues = new Set(USERS_IMPORT_COLUMNS.map((c) => c.example.trim().toLowerCase()));

  const rows: RawRow[] = [];
  for (let r = 1; r < aoaFmt.length; r++) {
    const raw = {} as RawRow;
    let hasValue = false;
    let matchesExampleRow = true;
    colToKey.forEach((key, i) => {
      if (!key) return; // unrecognised header — this column's values are never stored
      const cell = cellText(r, i).trim();
      raw[key] = cell;
      if (cell) hasValue = true;
      // The template ships with one filled-in example row — if it's still there, drop it
      // rather than importing "Wickramasinghe Arachchige Nimal Perera" as a real employee.
      const col = USERS_IMPORT_COLUMNS.find((c) => c.key === key)!;
      if (cell.toLowerCase() !== col.example.trim().toLowerCase()) matchesExampleRow = false;
    });
    if (!hasValue) continue;                                  // fully blank row
    if (matchesExampleRow && exampleValues.size > 0) continue; // leftover template example row
    // Fill in any columns the sheet didn't have at all (missing column, not just blank cell).
    for (const c of USERS_IMPORT_COLUMNS) if (!(c.key in raw)) raw[c.key] = '';
    rows.push(raw);
  }
  return rows;
}

// ─── Step 2: name splitting ────────────────────────────────────────────────────────────
// Mirrors splitFullName in src/app/api/register/route.ts (the carecode.org self-registration
// endpoint already solves this exact problem — one formal name string in, first/last out) so
// the two entry points derive names the same way. Kept as a separate copy here (not imported)
// since that route is server-only and this runs in the browser.
const TITLE_RE = /^(mr|mrs|ms|miss|mx|dr|rev|prof)\.?\s*/i;
function splitFullName(full: string): { first: string; last: string } {
  const cleaned = full.trim().replace(TITLE_RE, '').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// "Name with Initials" has no honorific to strip but is often typed with no space before the
// surname (e.g. "I.S.K.Arachchi") — split after the last '.' instead of on whitespace when
// there isn't one.
function splitNameWithInitials(v: string): { first: string; last: string } {
  const cleaned = v.trim();
  if (!cleaned) return { first: '', last: '' };
  if (/\s/.test(cleaned)) {
    const idx = cleaned.lastIndexOf(' ');
    return { first: cleaned.slice(0, idx).trim(), last: cleaned.slice(idx + 1).trim() };
  }
  const lastDot = cleaned.lastIndexOf('.');
  if (lastDot !== -1 && lastDot < cleaned.length - 1) {
    return { first: cleaned.slice(0, lastDot + 1), last: cleaned.slice(lastDot + 1).trim() };
  }
  return { first: '', last: cleaned };
}

// Best-effort only — always shown as plain editable First/Last Name inputs on the review
// screen, so a wrong guess (or a row with neither name field filled in) is just fixed there
// rather than requiring the source sheet to carry data it may not have (e.g. company-provided
// lists that only ever have "Name with Initials").
export function deriveNames(fullName: string, nameWithInitials: string): { first_name: string; last_name: string } {
  const full = splitFullName(fullName);
  if (full.first) return { first_name: full.first, last_name: full.last };
  const init = splitNameWithInitials(nameWithInitials);
  return { first_name: init.first, last_name: init.last };
}

// ─── Step 3: date parsing ──────────────────────────────────────────────────────────────
// Tried in order; first one that structurally matches wins. MM/dd first — confirmed
// month-first, and also the unambiguous ordering in every sample sheet we were given
// (e.g. day values like 24, 27, 13, 19, 28 that can't be a month).
const DATE_FORMATS = ['yyyy-MM-dd', 'MM/dd/yyyy', 'M/d/yyyy', 'dd-MM-yyyy', 'd-M-yyyy'];

// Two-digit-year dates ("12/24/92") — this tenant's real sheets use these, not a 4-digit
// year, so they're parsed by hand rather than via date-fns's own 'yy' token, to keep the
// century pivot exact and documented: 00–49 → 20xx, 50–99 → 19xx. That covers every
// plausible DOB/DOJ here — nobody on the payroll predates 1950, and "20xx" never runs past
// the current year for a birth date typed as two digits.
const TWO_DIGIT_YEAR_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/;
function expandTwoDigitYear(yy: number): number {
  return yy <= 49 ? 2000 + yy : 1900 + yy;
}

export function parseSheetDate(raw: string): string {
  const t = raw.trim();
  if (!t) return '';

  const twoDigit = TWO_DIGIT_YEAR_RE.exec(t);
  if (twoDigit) {
    const month = Number(twoDigit[1]);
    const day = Number(twoDigit[2]);
    const year = expandTwoDigitYear(Number(twoDigit[3]));
    const d = new Date(year, month - 1, day);
    // Guards against rollover (e.g. day 31 in a 30-day month) rather than silently
    // accepting the next month date() would otherwise construct.
    if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) {
      return formatDate(d, 'yyyy-MM-dd');
    }
  }

  for (const fmt of DATE_FORMATS) {
    const d = parseDate(t, fmt, new Date());
    if (isValidDate(d)) return formatDate(d, 'yyyy-MM-dd');
  }
  // Plain Excel serial (date cell whose type sheetjs didn't recognise) — days since the
  // 1899-12-30 epoch, the same base xlsx itself uses.
  if (/^\d{4,6}$/.test(t)) {
    const serial = Number(t);
    const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    if (isValidDate(d) && d.getUTCFullYear() > 1950 && d.getUTCFullYear() < 2100) {
      return formatDate(d, 'yyyy-MM-dd');
    }
  }
  return ''; // left blank — the review screen's date input makes this easy to fill in by hand
}

// ─── Phone number leading-zero recovery ─────────────────────────────────────────────────
// Sri Lankan phone numbers are 10 digits starting with 0 (e.g. "0771234567"). Typing the
// Contact/Guardian Contact column as a plain number in Excel (instead of formatting the
// column as Text first) silently drops that leading zero — Excel can't store a number with
// a leading zero — leaving a 9-digit value like "776863840" in the sheet. Restore it rather
// than importing a wrong number; anything that isn't exactly 9 bare digits is left as-is
// (the review screen's Contact Number field stays a plain editable input either way).
function normalizeSlPhone(raw: string): string {
  const t = raw.trim();
  return /^\d{9}$/.test(t) ? `0${t}` : t;
}

// EPF format never intentionally contains spaces, but hand-typed source sheets sometimes
// have one (e.g. "SLH/E 378" instead of "SLH/E378") — strip ALL whitespace, not just
// leading/trailing, so imported rows don't create a second, differently-keyed user record
// for someone who already exists. Mirrors normalizeEpf in src/services/userService.ts
// (kept local rather than imported so this stays a plain parsing module).
function normalizeEpf(raw: string): string {
  return raw.replace(/\s+/g, '');
}

// Same treatment for Employee Number (see normalizeEmployeeNumber in userService.ts) —
// stray whitespace in a source sheet cell would otherwise let what's really the same
// Employee No slip past the duplicate checks below as two "different" values.
function normalizeEmployeeNumber(raw: string): string {
  return raw.replace(/\s+/g, '');
}

// ─── Step 4: matching free text against a curated list (Company / Role) ─────────────────
// Exact (case/whitespace-insensitive) match wins outright; otherwise the best fuzzy candidate
// is accepted only above a threshold high enough to rule out "confidently picked the wrong
// one of two short names" — anything weaker is left for the admin to resolve by hand.
const FUZZY_MATCH_THRESHOLD = 450;
function matchByName<T>(text: string, list: T[], name: (item: T) => string): T | null {
  const t = text.trim();
  if (!t) return null;
  const exact = list.find((item) => name(item).trim().toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  let best: T | null = null;
  let bestScore = 0;
  for (const item of list) {
    const score = fuzzyScore(t, name(item));
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= FUZZY_MATCH_THRESHOLD ? best : null;
}

// ─── Step 5: assemble draft rows ──────────────────────────────────────────────────────
export function buildImportDraftRows(
  raw: RawRow[],
  companies: Company[],
  departments: Department[],
  roles: Role[],
): ImportRowDraft[] {
  return raw.map((r) => {
    const { first_name, last_name } = deriveNames(r.full_name, r.name_with_initials);

    const matchedCompany = matchByName(r.company_text, companies, (c) => c.name);
    // Department is free text on AppUser (no FK) — the departments list is only a picklist
    // source, so a match just gets the "known" spelling; an unmatched value still passes
    // through as-is rather than being flagged (see computeRowIssues in the page).
    const deptCandidates = matchedCompany
      ? departments.filter((d) => d.company_id === matchedCompany.id)
      : departments;
    const matchedDepartment = matchByName(r.department_text, deptCandidates, (d) => d.name)
      ?? matchByName(r.department_text, departments, (d) => d.name);

    // Role is independent of Department entirely (Roles carry no department scoping of their
    // own) — every active role is a candidate regardless of the matched department.
    const activeRoles = roles.filter((role) => role.is_active !== false);
    const matchedRole = matchByName(r.role_text, activeRoles, (role) => role.name);

    const genderText = r.gender.trim();
    const matchedGender = ['Male', 'Female'].find((g) => g.toLowerCase() === genderText.toLowerCase());

    return {
      id: crypto.randomUUID(),
      full_name: r.full_name,
      name_with_initials: r.name_with_initials,
      first_name,
      last_name,
      role: matchedRole ? matchedRole.name : r.role_text,
      department: matchedDepartment ? matchedDepartment.name : r.department_text,
      company_id: matchedCompany ? matchedCompany.id : r.company_text,
      nic: r.nic,
      epf_number: normalizeEpf(r.epf_number),
      employee_number: normalizeEmployeeNumber(r.employee_number),
      email: r.email,
      date_of_join: parseSheetDate(r.date_of_join),
      gender: matchedGender ?? genderText,
      date_of_birth: parseSheetDate(r.date_of_birth),
      address: r.address,
      phone_personal: normalizeSlPhone(r.phone_personal),
      guardian_contact: normalizeSlPhone(r.guardian_contact),
      roleTextRaw: r.role_text,
      departmentTextRaw: r.department_text,
      companyTextRaw: r.company_text,
    };
  });
}
