'use client';
// Salary details by department (CSV/Excel) — one section per department: each employee's
// Basic/Gross/Deductions/Net, a subtotal row, then a grand total at the end. Mirrors
// payrollMasterSummaryExport.ts's per-employee row shape, grouped by
// PayrollResult.department_snapshot instead of listed flat — that snapshot is taken from the
// linked AppUser at generate time (see generate/route.ts), so this needs no extra employee
// fetch beyond the results already loaded on the Reports page.

import type { PayrollResult } from '@/lib/payrollTypes';

const UNASSIGNED = 'Unassigned';

export interface DepartmentSalaryRow {
  epf: string;
  name: string;
  basicSalary: number;
  grossPay: number | null;
  totalDeductions: number | null;
  netPay: number | null;
}

interface DeptTotals { basicSalary: number; grossPay: number; totalDeductions: number; netPay: number }

export interface DepartmentSalaryGroup {
  department: string;
  rows: DepartmentSalaryRow[];
  subtotal: DeptTotals;
}

export interface DepartmentSalaryData {
  periodLabel: string;
  companyName: string;
  groups: DepartmentSalaryGroup[];
  grandTotal: DeptTotals;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function periodLabelFromRunId(runId: string): string {
  const m = runId.match(/_(\d{4})_(\d{2})$/);
  if (!m) return runId;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

function sumTotals(rows: DepartmentSalaryRow[]): DeptTotals {
  return {
    basicSalary: rows.reduce((s, r) => s + r.basicSalary, 0),
    grossPay: rows.reduce((s, r) => s + (r.grossPay ?? 0), 0),
    totalDeductions: rows.reduce((s, r) => s + (r.totalDeductions ?? 0), 0),
    netPay: rows.reduce((s, r) => s + (r.netPay ?? 0), 0),
  };
}

export function buildDepartmentSalaryData(results: PayrollResult[]): DepartmentSalaryData {
  const byDept = new Map<string, DepartmentSalaryRow[]>();
  for (const r of results) {
    const dept = r.department_snapshot?.trim() || UNASSIGNED;
    const list = byDept.get(dept) ?? [];
    list.push({ epf: r.epf_number, name: r.employee_name, basicSalary: r.basic_salary, grossPay: r.gross_pay, totalDeductions: r.total_deductions, netPay: r.net_pay });
    byDept.set(dept, list);
  }

  const groups: DepartmentSalaryGroup[] = Array.from(byDept.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([department, rows]) => {
      const sorted = rows.slice().sort((a, b) => a.name.localeCompare(b.name));
      return { department, rows: sorted, subtotal: sumTotals(sorted) };
    });

  const grandTotal: DeptTotals = {
    basicSalary: groups.reduce((s, g) => s + g.subtotal.basicSalary, 0),
    grossPay: groups.reduce((s, g) => s + g.subtotal.grossPay, 0),
    totalDeductions: groups.reduce((s, g) => s + g.subtotal.totalDeductions, 0),
    netPay: groups.reduce((s, g) => s + g.subtotal.netPay, 0),
  };

  return {
    periodLabel: results[0] ? periodLabelFromRunId(results[0].run_id) : '',
    companyName: results[0]?.company_name ?? '',
    groups,
    grandTotal,
  };
}

const fmt = (v: number | null) => (v == null ? '—' : v.toFixed(2));

function header(): string[] {
  return ['EPF No', 'Employee Name', 'Basic Salary', 'Gross Pay', 'Total Deductions', 'Net Pay'];
}
function subtotalRow(t: DeptTotals): (string | number)[] {
  return ['', 'Subtotal', t.basicSalary.toFixed(2), t.grossPay.toFixed(2), t.totalDeductions.toFixed(2), t.netPay.toFixed(2)];
}
function grandTotalRow(data: DepartmentSalaryData): (string | number)[] {
  return ['', 'GRAND TOTAL', data.grandTotal.basicSalary.toFixed(2), data.grandTotal.grossPay.toFixed(2), data.grandTotal.totalDeductions.toFixed(2), data.grandTotal.netPay.toFixed(2)];
}
/** Every row of the sheet, flat — department header, its employees, its subtotal, a blank
 *  line, repeated per department, then the grand total. Used identically for CSV and Excel. */
function sheetRows(data: DepartmentSalaryData): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const g of data.groups) {
    rows.push([g.department]);
    rows.push(header());
    for (const r of g.rows) rows.push([r.epf, r.name, r.basicSalary.toFixed(2), fmt(r.grossPay), fmt(r.totalDeductions), fmt(r.netPay)]);
    rows.push(subtotalRow(g.subtotal));
    rows.push([]);
  }
  rows.push(grandTotalRow(data));
  return rows;
}
function baseFilename(data: DepartmentSalaryData): string {
  const co = data.companyName.replace(/[^\w-]+/g, '_');
  const period = data.periodLabel.replace(/[^\w-]+/g, '_');
  return `salary_by_department_${co}_${period}`;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function exportDepartmentSalaryCsv(data: DepartmentSalaryData): void {
  const lines: string[][] = [
    [`Salary Details by Department — ${data.periodLabel} — ${data.companyName}`],
    [],
    ...sheetRows(data).map(r => r.map(String)),
  ];
  const csv = lines.map(r => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${baseFilename(data)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportDepartmentSalaryXlsx(data: DepartmentSalaryData): Promise<void> {
  const { utils, writeFile } = await import('xlsx');
  const wb = utils.book_new();
  const sheet = utils.aoa_to_sheet(sheetRows(data));
  sheet['!cols'] = [{ wch: 14 }, { wch: 24 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 12 }];
  utils.book_append_sheet(wb, sheet, 'By Department');
  writeFile(wb, `${baseFilename(data)}.xlsx`);
}
