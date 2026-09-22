'use client';
// EPF/ETF C-Form data export (CSV/Excel) — one row per employee for a finalized run:
// EPF base/employee/employer contributions and ETF base/employer contribution, the figures
// a C-Form submission needs. Mirrors src/lib/attendanceExport.ts's export pattern. NIC is not
// stored on PayrollResult (it's an AppUser/HR field, not a payroll one) — pass a
// epf→NIC lookup map when available; it renders blank otherwise rather than blocking export.

import type { PayrollResult } from '@/lib/payrollTypes';

export interface StatutoryExportRow {
  epf: string;
  name: string;
  nic: string;
  epfBase: number | null;
  epfEmployee: number | null;
  epfEmployer: number | null;
  etfBase: number | null;
  etfEmployer: number | null;
}

export interface StatutoryExportData {
  periodLabel: string;
  companyName: string;
  rows: StatutoryExportRow[];
  totals: { epfEmployee: number; epfEmployer: number; etfEmployer: number };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function periodLabelFromRunId(runId: string): string {
  const m = runId.match(/_(\d{4})_(\d{2})$/);
  if (!m) return runId;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

export function buildStatutoryExportData(results: PayrollResult[], nicByEpf?: Map<string, string>): StatutoryExportData {
  const epfLine = (r: PayrollResult, type: 'epf_employee' | 'epf_employer') => r.lines.find(l => l.type === type)?.amount ?? null;
  const etfLine = (r: PayrollResult) => r.lines.find(l => l.type === 'etf_employer')?.amount ?? null;

  const rows: StatutoryExportRow[] = results
    .map(r => ({
      epf: r.epf_number,
      name: r.employee_name,
      nic: nicByEpf?.get(r.epf_number) ?? '',
      epfBase: r.epf_base,
      epfEmployee: epfLine(r, 'epf_employee'),
      epfEmployer: epfLine(r, 'epf_employer'),
      etfBase: r.etf_base,
      etfEmployer: etfLine(r),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const sum = (f: (r: StatutoryExportRow) => number | null) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);
  return {
    periodLabel: results[0] ? periodLabelFromRunId(results[0].run_id) : '',
    companyName: results[0]?.company_name ?? '',
    rows,
    totals: { epfEmployee: sum(r => r.epfEmployee), epfEmployer: sum(r => r.epfEmployer), etfEmployer: sum(r => r.etfEmployer) },
  };
}

const fmt = (v: number | null) => (v == null ? '—' : v.toFixed(2));

function header(): string[] {
  return ['EPF No', 'Employee Name', 'NIC', 'EPF Base', 'EPF Employee', 'EPF Employer', 'ETF Base', 'ETF Employer'];
}
function bodyRows(data: StatutoryExportData): (string | number)[][] {
  return data.rows.map(r => [r.epf, r.name, r.nic, fmt(r.epfBase), fmt(r.epfEmployee), fmt(r.epfEmployer), fmt(r.etfBase), fmt(r.etfEmployer)]);
}
function totalsRow(data: StatutoryExportData): (string | number)[] {
  return ['', 'TOTAL', '', '', data.totals.epfEmployee.toFixed(2), data.totals.epfEmployer.toFixed(2), '', data.totals.etfEmployer.toFixed(2)];
}
function baseFilename(data: StatutoryExportData): string {
  const co = data.companyName.replace(/[^\w-]+/g, '_');
  const period = data.periodLabel.replace(/[^\w-]+/g, '_');
  return `epf_etf_cform_${co}_${period}`;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function exportStatutoryCsv(data: StatutoryExportData): void {
  const lines: string[][] = [
    [`EPF/ETF C-Form Data — ${data.periodLabel} — ${data.companyName}`],
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

export async function exportStatutoryXlsx(data: StatutoryExportData): Promise<void> {
  const { utils, writeFile } = await import('xlsx');
  const wb = utils.book_new();
  const sheet = utils.aoa_to_sheet([header(), ...bodyRows(data), totalsRow(data)]);
  sheet['!cols'] = [{ wch: 14 }, { wch: 24 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
  utils.book_append_sheet(wb, sheet, 'EPF-ETF');
  writeFile(wb, `${baseFilename(data)}.xlsx`);
}
