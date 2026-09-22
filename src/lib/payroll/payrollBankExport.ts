'use client';
// PAYROLL-006 — bank transfer schedule export (CSV/Excel only — no PDF, this is a
// machine-imported file, not a printed document). Mirrors src/lib/attendanceExport.ts's
// export pattern. Reads only bank_snapshot/net_pay off already-finalized PayrollResult
// docs — never re-reads the live employee_pay_profile, so a later profile edit can never
// silently change an already-exported transfer file.

import type { PayrollResult } from '@/lib/payrollTypes';

export interface BankExportRow {
  epf: string;
  name: string;
  bankName: string;
  bankBranch: string;
  accountNumber: string;
  netPay: number;
}

export interface BankExportData {
  periodLabel: string;
  companyName: string;
  rows: BankExportRow[];
  /** Employees with a null net pay (calculation blocked) or missing bank details — excluded
   *  from `rows`, surfaced here so the UI can warn before the file downloads rather than
   *  silently shipping blank/zero transfer lines. */
  excluded: Array<{ epf: string; name: string; reason: string }>;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function periodLabelFromRunId(runId: string): string {
  const m = runId.match(/_(\d{4})_(\d{2})$/);
  if (!m) return runId;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

export function buildBankExportData(results: PayrollResult[]): BankExportData {
  const rows: BankExportRow[] = [];
  const excluded: BankExportData['excluded'] = [];

  results.forEach(r => {
    if (r.net_pay == null) {
      excluded.push({ epf: r.epf_number, name: r.employee_name, reason: 'Net pay could not be calculated (see warnings).' });
      return;
    }
    if (!r.bank_snapshot.bank_name || !r.bank_snapshot.account_number) {
      excluded.push({ epf: r.epf_number, name: r.employee_name, reason: 'No bank details on file.' });
      return;
    }
    rows.push({
      epf: r.epf_number,
      name: r.employee_name,
      bankName: r.bank_snapshot.bank_name,
      bankBranch: r.bank_snapshot.bank_branch ?? '',
      accountNumber: r.bank_snapshot.account_number,
      netPay: r.net_pay,
    });
  });

  return {
    periodLabel: results[0] ? periodLabelFromRunId(results[0].run_id) : '',
    companyName: results[0]?.company_name ?? '',
    rows,
    excluded,
  };
}

function header(): string[] {
  return ['EPF No', 'Employee Name', 'Bank Name', 'Branch', 'Account Number', 'Net Pay'];
}
function bodyRows(data: BankExportData): (string | number)[][] {
  return data.rows.map(r => [r.epf, r.name, r.bankName, r.bankBranch, r.accountNumber, r.netPay.toFixed(2)]);
}
function baseFilename(data: BankExportData): string {
  const co = data.companyName.replace(/[^\w-]+/g, '_');
  const period = data.periodLabel.replace(/[^\w-]+/g, '_');
  return `bank_transfer_${co}_${period}`;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function exportBankTransferCsv(data: BankExportData): void {
  const lines: string[][] = [
    [`Bank Transfer Schedule — ${data.periodLabel} — ${data.companyName}`],
    [],
    header(),
    ...bodyRows(data).map(r => r.map(String)),
  ];
  const csv = lines.map(r => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${baseFilename(data)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportBankTransferXlsx(data: BankExportData): Promise<void> {
  const { utils, writeFile } = await import('xlsx');
  const wb = utils.book_new();
  const sheet = utils.aoa_to_sheet([header(), ...bodyRows(data)]);
  sheet['!cols'] = [{ wch: 14 }, { wch: 24 }, { wch: 18 }, { wch: 14 }, { wch: 18 }, { wch: 12 }];
  utils.book_append_sheet(wb, sheet, 'Bank Transfer');
  writeFile(wb, `${baseFilename(data)}.xlsx`);
}
