'use client';
// Overtime summary by department (CSV/Excel) — one row per department, aggregating every
// overtime-type line (ordinary OT 1.5x/2.0x, PH/Poya/Mercantile Overtime) across everyone
// snapshotted into that department for the run. This is the MONTHLY TOTAL per department HR
// asked for — a per-employee breakdown already exists (Master Summary / Salary by Department),
// so this deliberately aggregates rather than repeating those.
//
// Sourced entirely from PayrollResult — hours from hours_summary (the same snapshot the
// payslip prints), pay from the matching result lines — so this needs no extra Firestore read
// beyond the results already loaded on the Reports page.

import type { PayrollResult, PayrollResultLineType } from '@/lib/payrollTypes';

const UNASSIGNED = 'Unassigned';

export interface OtByDepartmentRow {
  department: string;
  employees: number;
  otHours: number;               // ordinary OT, 1.5x + 2.0x combined (hours_summary.ot_hours)
  otPay: number;                 // ot_normal + ot_double lines
  phOvertimeHours: number;
  phOvertimePay: number;
  poyaOvertimeHours: number;
  poyaOvertimePay: number;
  mercantileOvertimeHours: number;
  mercantileOvertimePay: number;
  totalOtPay: number;            // every OT-type pay line combined
}

export interface OtByDepartmentData {
  periodLabel: string;
  companyName: string;
  rows: OtByDepartmentRow[];
  totals: Omit<OtByDepartmentRow, 'department'>;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function periodLabelFromRunId(runId: string): string {
  const m = runId.match(/_(\d{4})_(\d{2})$/);
  if (!m) return runId;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

function lineAmount(r: PayrollResult, type: PayrollResultLineType): number {
  return r.lines.find(l => l.type === type)?.amount ?? 0;
}

function sumOt(list: PayrollResult[]): Omit<OtByDepartmentRow, 'department'> {
  const otHours = list.reduce((s, r) => s + r.hours_summary.ot_hours, 0);
  const otPay = list.reduce((s, r) => s + lineAmount(r, 'ot_normal') + lineAmount(r, 'ot_double'), 0);
  const phOvertimeHours = list.reduce((s, r) => s + r.hours_summary.ph_overtime_hours, 0);
  const phOvertimePay = list.reduce((s, r) => s + lineAmount(r, 'ph_overtime'), 0);
  const poyaOvertimeHours = list.reduce((s, r) => s + r.hours_summary.poya_overtime_hours, 0);
  const poyaOvertimePay = list.reduce((s, r) => s + lineAmount(r, 'poya_overtime'), 0);
  const mercantileOvertimeHours = list.reduce((s, r) => s + r.hours_summary.mercantile_overtime_hours, 0);
  const mercantileOvertimePay = list.reduce((s, r) => s + lineAmount(r, 'mercantile_overtime'), 0);
  return {
    employees: list.length,
    otHours, otPay, phOvertimeHours, phOvertimePay, poyaOvertimeHours, poyaOvertimePay,
    mercantileOvertimeHours, mercantileOvertimePay,
    totalOtPay: otPay + phOvertimePay + poyaOvertimePay + mercantileOvertimePay,
  };
}

export function buildOtByDepartmentData(results: PayrollResult[]): OtByDepartmentData {
  const byDept = new Map<string, PayrollResult[]>();
  for (const r of results) {
    const dept = r.department_snapshot?.trim() || UNASSIGNED;
    const list = byDept.get(dept) ?? [];
    list.push(r);
    byDept.set(dept, list);
  }

  const rows = Array.from(byDept.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([department, list]) => ({ department, ...sumOt(list) }));

  const totals = sumOt(results);

  return {
    periodLabel: results[0] ? periodLabelFromRunId(results[0].run_id) : '',
    companyName: results[0]?.company_name ?? '',
    rows,
    totals,
  };
}

const n = (v: number) => v.toFixed(2);

function header(): string[] {
  return ['Department', 'Employees', 'OT Hours', 'OT Pay', 'PH OT Hours', 'PH OT Pay', 'Poya OT Hours', 'Poya OT Pay', 'Mercantile OT Hours', 'Mercantile OT Pay', 'Total OT Pay'];
}
function bodyRows(data: OtByDepartmentData): (string | number)[][] {
  return data.rows.map(r => [
    r.department, r.employees, n(r.otHours), n(r.otPay), n(r.phOvertimeHours), n(r.phOvertimePay),
    n(r.poyaOvertimeHours), n(r.poyaOvertimePay), n(r.mercantileOvertimeHours), n(r.mercantileOvertimePay), n(r.totalOtPay),
  ]);
}
function totalsRow(data: OtByDepartmentData): (string | number)[] {
  const t = data.totals;
  return [
    'TOTAL', t.employees, n(t.otHours), n(t.otPay), n(t.phOvertimeHours), n(t.phOvertimePay),
    n(t.poyaOvertimeHours), n(t.poyaOvertimePay), n(t.mercantileOvertimeHours), n(t.mercantileOvertimePay), n(t.totalOtPay),
  ];
}
function baseFilename(data: OtByDepartmentData): string {
  const co = data.companyName.replace(/[^\w-]+/g, '_');
  const period = data.periodLabel.replace(/[^\w-]+/g, '_');
  return `ot_summary_by_department_${co}_${period}`;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function exportOtByDepartmentCsv(data: OtByDepartmentData): void {
  const lines: string[][] = [
    [`Overtime Summary by Department — ${data.periodLabel} — ${data.companyName}`],
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

export async function exportOtByDepartmentXlsx(data: OtByDepartmentData): Promise<void> {
  const { utils, writeFile } = await import('xlsx');
  const wb = utils.book_new();
  const sheet = utils.aoa_to_sheet([header(), ...bodyRows(data), totalsRow(data)]);
  sheet['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 11 }, { wch: 10 }, { wch: 13 }, { wch: 11 }, { wch: 16 }, { wch: 14 }, { wch: 12 }];
  utils.book_append_sheet(wb, sheet, 'OT by Dept');
  writeFile(wb, `${baseFilename(data)}.xlsx`);
}
