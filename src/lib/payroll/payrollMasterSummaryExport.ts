'use client';
// PAYROLL-006 — master payroll summary export (CSV/Excel), one row per employee for a
// finalized run: gross, deductions, net, employer contributions, warning count. Mirrors
// src/lib/attendanceExport.ts's export pattern.

import type { PayrollResult } from '@/lib/payrollTypes';

export interface MasterSummaryRow {
  epf: string;
  name: string;
  grossPay: number | null;
  totalDeductions: number | null;
  netPay: number | null;
  epfBase: number | null;
  employerEpf: number | null;
  employerEtf: number | null;
  warnings: number;
}

export interface MasterSummaryData {
  periodLabel: string;
  companyName: string;
  rows: MasterSummaryRow[];
  totals: { grossPay: number; totalDeductions: number; netPay: number; employerEpf: number; employerEtf: number };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function periodLabelFromRunId(runId: string): string {
  const m = runId.match(/_(\d{4})_(\d{2})$/);
  if (!m) return runId;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

export function buildMasterSummaryData(results: PayrollResult[]): MasterSummaryData {
  const rows: MasterSummaryRow[] = results
    .map(r => ({
      epf: r.epf_number,
      name: r.employee_name,
      grossPay: r.gross_pay,
      totalDeductions: r.total_deductions,
      netPay: r.net_pay,
      epfBase: r.epf_base,
      employerEpf: r.employer_epf,
      employerEtf: r.employer_etf,
      warnings: r.warnings.length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const sum = (f: (r: MasterSummaryRow) => number | null) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);
  return {
    periodLabel: results[0] ? periodLabelFromRunId(results[0].run_id) : '',
    companyName: results[0]?.company_name ?? '',
    rows,
    totals: {
      grossPay: sum(r => r.grossPay),
      totalDeductions: sum(r => r.totalDeductions),
      netPay: sum(r => r.netPay),
      employerEpf: sum(r => r.employerEpf),
      employerEtf: sum(r => r.employerEtf),
    },
  };
}

const fmt = (v: number | null) => (v == null ? '—' : v.toFixed(2));

function header(): string[] {
  return ['EPF No', 'Employee Name', 'Gross Pay', 'Total Deductions', 'Net Pay', 'PF Base', 'Employer EPF', 'Employer ETF', 'Warnings'];
}
function bodyRows(data: MasterSummaryData): (string | number)[][] {
  return data.rows.map(r => [r.epf, r.name, fmt(r.grossPay), fmt(r.totalDeductions), fmt(r.netPay), fmt(r.epfBase), fmt(r.employerEpf), fmt(r.employerEtf), r.warnings]);
}
function totalsRow(data: MasterSummaryData): (string | number)[] {
  return ['', 'TOTAL', data.totals.grossPay.toFixed(2), data.totals.totalDeductions.toFixed(2), data.totals.netPay.toFixed(2), '', data.totals.employerEpf.toFixed(2), data.totals.employerEtf.toFixed(2), ''];
}
function baseFilename(data: MasterSummaryData): string {
  const co = data.companyName.replace(/[^\w-]+/g, '_');
  const period = data.periodLabel.replace(/[^\w-]+/g, '_');
  return `payroll_summary_${co}_${period}`;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function exportMasterSummaryCsv(data: MasterSummaryData): void {
  const lines: string[][] = [
    [`Payroll Master Summary — ${data.periodLabel} — ${data.companyName}`],
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

export async function exportMasterSummaryXlsx(data: MasterSummaryData): Promise<void> {
  const { utils, writeFile } = await import('xlsx');
  const wb = utils.book_new();
  const sheet = utils.aoa_to_sheet([header(), ...bodyRows(data), totalsRow(data)]);
  sheet['!cols'] = [{ wch: 14 }, { wch: 24 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 9 }];
  utils.book_append_sheet(wb, sheet, 'Summary');
  writeFile(wb, `${baseFilename(data)}.xlsx`);
}
