'use client';
// PAYE / APIT summary export (CSV/Excel) — one row per employee for a finalized run: Basic
// Salary, the taxable base APIT was computed on, and the APIT amount itself. Mirrors
// payrollStatutoryExport.ts's export pattern exactly (same "one sheet, all staff" shape as the
// EPF/ETF C-Form data). NIC is not stored on PayrollResult (it's an AppUser/HR field, not a
// payroll one) — pass an epf→NIC lookup map when available; it renders blank otherwise rather
// than blocking export.
//
// "PAYE" is the term used in the original request; this codebase's own calculation engine and
// payslip both call the same figure "APIT" (Sri Lanka's current scheme name) — see
// PayrollResult.apit_amount and the 'APIT (Income Tax)' payslip line. Labelled "PAYE / APIT"
// throughout so neither reader has to translate.

import type { PayrollResult } from '@/lib/payrollTypes';

export interface PayeExportRow {
  epf: string;
  name: string;
  nic: string;
  basicSalary: number;
  taxableBase: number | null;
  apitAmount: number | null;
}

export interface PayeExportData {
  periodLabel: string;
  companyName: string;
  rows: PayeExportRow[];
  totals: { apitAmount: number };
  // How many rows actually had APIT deducted (amount > 0) — the report's own quick answer to
  // "how many people does this actually apply to this month", without opening the file.
  employeesWithApit: number;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function periodLabelFromRunId(runId: string): string {
  const m = runId.match(/_(\d{4})_(\d{2})$/);
  if (!m) return runId;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

export function buildPayeExportData(results: PayrollResult[], nicByEpf?: Map<string, string>): PayeExportData {
  const rows: PayeExportRow[] = results
    .map(r => ({
      epf: r.epf_number,
      name: r.employee_name,
      nic: nicByEpf?.get(r.epf_number) ?? '',
      basicSalary: r.basic_salary,
      taxableBase: r.taxable_base,
      apitAmount: r.apit_amount,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    periodLabel: results[0] ? periodLabelFromRunId(results[0].run_id) : '',
    companyName: results[0]?.company_name ?? '',
    rows,
    totals: { apitAmount: rows.reduce((s, r) => s + (r.apitAmount ?? 0), 0) },
    employeesWithApit: rows.filter(r => (r.apitAmount ?? 0) > 0).length,
  };
}

const fmt = (v: number | null) => (v == null ? '—' : v.toFixed(2));

function header(): string[] {
  return ['EPF No', 'Employee Name', 'NIC', 'Basic Salary', 'Taxable Base', 'APIT (PAYE)'];
}
function bodyRows(data: PayeExportData): (string | number)[][] {
  return data.rows.map(r => [r.epf, r.name, r.nic, r.basicSalary.toFixed(2), fmt(r.taxableBase), fmt(r.apitAmount)]);
}
function totalsRow(data: PayeExportData): (string | number)[] {
  return ['', 'TOTAL', '', '', '', data.totals.apitAmount.toFixed(2)];
}
function baseFilename(data: PayeExportData): string {
  const co = data.companyName.replace(/[^\w-]+/g, '_');
  const period = data.periodLabel.replace(/[^\w-]+/g, '_');
  return `paye_apit_summary_${co}_${period}`;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function exportPayeCsv(data: PayeExportData): void {
  const lines: string[][] = [
    [`PAYE / APIT Summary — ${data.periodLabel} — ${data.companyName}`],
    [],
    header(),
    ...bodyRows(data).map(r => r.map(String)),
    totalsRow(data).map(String),
  ];
  const csv = lines.map(r => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${baseFilename(data)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportPayeXlsx(data: PayeExportData): Promise<void> {
  const { utils, writeFile } = await import('xlsx');
  const wb = utils.book_new();
  const sheet = utils.aoa_to_sheet([header(), ...bodyRows(data), totalsRow(data)]);
  sheet['!cols'] = [{ wch: 14 }, { wch: 24 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
  utils.book_append_sheet(wb, sheet, 'PAYE-APIT');
  writeFile(wb, `${baseFilename(data)}.xlsx`);
}
