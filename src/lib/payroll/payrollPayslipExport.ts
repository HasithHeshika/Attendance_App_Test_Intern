'use client';
// PDF payslip renderer — matches the Southern Lanka Hospitals physical payslip template
// 1-to-1: letterhead (company name / address / period bar), then a single stacked
// Description|Amount sheet with the exact section order and row labels of the paper form
// (TOTAL → No Pay/Late Time → TOTAL FOR PROVIDENT FUND/OT Payment → ALLOWANCES → GROSS PAY →
// DEDUCTIONS → BALANCE PAY → EMPLOYER'S CONTRIBUTION), then a subtle centered
// "computer-generated payslip, no signature" footer note.
//
// Rows the paper form doesn't have — Poya Overtime Hours/pay, and the entire Mercantile block
// (Normal/Overtime Hours, Overtime pay, Day, Day payment) — are spliced in only when actually
// logged that month (poya_hours_overtime > 0, or any Mercantile activity respectively).
// Nobody using only the flat per-day premiums (the common case) ever sees them, so the printed
// sheet still matches the template exactly; the extra rows only appear for the (real) case of
// hours worked beyond a normal day's length, or a Mercantile holiday at all. Same conditional
// treatment for APIT — it's folded into TOTAL DEDUCTIONS either way, but only gets its own
// labelled row when it's actually non-zero, so a slip with no tax due keeps the template's
// original deduction list unchanged.
//
// Mirrors src/lib/attendanceExport.ts's export pattern: a pure buildPayslipData() assembly
// step, then a dynamic-import PDF export so jspdf/jspdf-autotable never reach the initial
// bundle. Reads ONLY from a finalized PayrollResult snapshot — never recalculates, never
// re-reads live employee/settings data. English-only content (jsPDF can't render
// Sinhala/Tamil).

import { format } from 'date-fns';
import type { PayrollResult, PayrollResultLine } from '@/lib/payrollTypes';

export interface PayslipRow {
  label: string;
  value: string;
  bold?: boolean; // TOTAL / GROSS PAY / TOTAL DEDUCTIONS / BALANCE PAY style rows
}

export interface PayslipData {
  companyName: string;
  companyAddress: string | null;
  employeeName: string;
  epfNumber: string;
  periodLabel: string; // e.g. "August 2026"
  periodShortLabel: string; // e.g. "Aug-26" — matches the template's own header style
  runStatus: string;

  // Description | Amount rows, grouped exactly as the template's sections.
  topRows: PayslipRow[]; // Total Hours … OT Payment
  allowanceRows: PayslipRow[]; // ALLOWANCES … TOTAL ALLOWANCE, GROSS PAY
  deductionRows: PayslipRow[]; // DEDUCTIONS … TOTAL DEDUCTIONS, BALANCE PAY
  employerRows: PayslipRow[]; // EMPLOYER'S CONTRIBUTION: NIC NO / E.P.F. NO / Employee No / Designation / Department / E.P.F. / E.T.F.

  grossPay: number | null;
  totalDeductions: number | null;
  netPay: number | null;
  bankName: string | null;
  bankBranch: string | null;
  accountNumber: string | null;
  warningsCount: number;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The template's five itemized allowance lines and five itemized deduction lines — matched
// case-insensitively against a component's own name. Any OTHER recurring/one-off allowance
// not in this list rolls up into the template's single "Allowances(BR1/BR2)" line instead of
// being dropped.
const NAMED_ALLOWANCES = ['Travelling Allowance', 'Performance Allowance', 'Other Allowance', 'Target Allowance', 'Inflation Allowance'];
const NAMED_DEDUCTIONS = ['Cash Shortage', 'Hostel Fee', 'Welfare', 'T-Shirt Advance', 'Stamp Fee'];

function periodParts(runId: string): { year: number; month: number } | null {
  const m = runId.match(/_(\d{4})_(\d{2})$/);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

// Blank/zero/unresolved all print the same '-' the physical slip uses for an empty cell — the
// template never distinguishes "genuinely zero" from "not applicable" visually, so neither do
// we here (the underlying PayrollResult still keeps the real number for every other view).
function money(v: number | null): string {
  if (v == null || v === 0) return '-';
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Hours/day counts print without forced decimals (e.g. "8" not "8.00"), '-' when genuinely
// zero — matches the template's mostly-blank look for a month with no PH/Poya activity.
function count(v: number): string {
  if (!v) return '-';
  return v % 1 === 0 ? String(v) : v.toFixed(2);
}

function findLine(lines: PayrollResultLine[], type: PayrollResultLine['type']): PayrollResultLine | undefined {
  return lines.find(l => l.type === type);
}

function amountByName(lines: PayrollResultLine[], type: PayrollResultLine['type'], name: string): number {
  const norm = name.trim().toLowerCase();
  return lines.filter(l => l.type === type && l.name.trim().toLowerCase() === norm).reduce((s, l) => s + (l.amount ?? 0), 0);
}

export function buildPayslipData(result: PayrollResult, companyAddress: string | null = null): PayslipData {
  const parts = periodParts(result.run_id);
  const periodLabel = parts ? `${MONTHS[parts.month - 1] ?? parts.month} ${parts.year}` : result.run_id;
  const periodShortLabel = parts ? `${MONTHS_SHORT[parts.month - 1] ?? parts.month}-${String(parts.year).slice(-2)}` : result.run_id;

  const lines = result.lines;
  const hs = result.hours_summary;
  const basicAmount = findLine(lines, 'basic')?.amount ?? 0;
  const otNormalAmount = findLine(lines, 'ot_normal')?.amount;
  const otDoubleAmount = findLine(lines, 'ot_double')?.amount;
  const normalOtPayment = (otNormalAmount == null || otDoubleAmount == null) ? null : otNormalAmount + otDoubleAmount;
  const phOvertimeAmount = findLine(lines, 'ph_overtime')?.amount ?? null;
  const phDayAmount = findLine(lines, 'ph_day')?.amount ?? null;
  const poyaOvertimeAmount = findLine(lines, 'poya_overtime')?.amount ?? null;
  const poyaDayAmount = findLine(lines, 'poya_day')?.amount ?? null;
  const mercantileDayAmount = findLine(lines, 'mercantile_day')?.amount ?? null;
  const mercantileOvertimeAmount = findLine(lines, 'mercantile_overtime')?.amount ?? null;
  const noPayAmount = findLine(lines, 'no_pay')?.amount ?? null; // stored negative — displayed as a positive deduction below

  // Poya Overtime only gets its own template rows when it was actually logged this month —
  // otherwise it stays silently 0 inside the totals it already feeds (never a phantom line,
  // never double-counted: it's summed into "TOTAL"/"OT Payment" exactly once either way).
  const poyaOvertimeLogged = hs.poya_overtime_hours > 0;
  // Same conditional-row treatment for the whole Mercantile block (Day pay AND Overtime) —
  // none of it exists on the physical template, so it must stay invisible for every tenant/
  // month not using it (this file is a 1:1 replica of the paper form; see its own header
  // comment). One flag covers both sub-parts rather than splitting them like poyaOvertimeLogged
  // does, since — unlike Poya's Day row — there's no original template row for Mercantile at
  // all to keep unconditionally.
  const mercantileLogged = hs.mercantile_days > 0 || hs.mercantile_overtime_hours > 0;

  const allowanceLines = lines.filter(l => l.type === 'allowance');
  const namedAllowanceNormSet = new Set(NAMED_ALLOWANCES.map(n => n.toLowerCase()));
  const otherAllowances = allowanceLines
    .filter(l => !namedAllowanceNormSet.has(l.name.trim().toLowerCase()))
    .reduce((s, l) => s + (l.amount ?? 0), 0);

  const subtotal = (normalOtPayment == null || phOvertimeAmount == null || phDayAmount == null || poyaOvertimeAmount == null || poyaDayAmount == null
    || mercantileDayAmount == null || mercantileOvertimeAmount == null)
    ? null : basicAmount + otherAllowances + normalOtPayment + phOvertimeAmount + phDayAmount + poyaOvertimeAmount + poyaDayAmount
      + mercantileDayAmount + mercantileOvertimeAmount;
  // "OT Payment" subtotal — every overtime-type line (ordinary OT + PH/Poya/Mercantile
  // overtime), never the flat PH/Poya/Mercantile Day premiums (those aren't overtime, they're
  // a per-day rate).
  const otPaymentTotal = (normalOtPayment == null || phOvertimeAmount == null || poyaOvertimeAmount == null || mercantileOvertimeAmount == null)
    ? null : normalOtPayment + phOvertimeAmount + poyaOvertimeAmount + mercantileOvertimeAmount;

  const lateLabel = result.late_minutes_snapshot == null ? '-'
    : result.late_minutes_snapshot <= 0 ? '-'
      : `${Math.floor(result.late_minutes_snapshot / 60)}h ${result.late_minutes_snapshot % 60}m`;

  const topRows: PayslipRow[] = [
    { label: 'Total Hours', value: count(hs.total_hours) },
    { label: 'Normal PH Hours', value: count(hs.normal_ph_hours) },
    { label: 'Normal Poya Hours', value: count(hs.normal_poya_hours) },
    { label: 'PH Overtime Hours', value: count(hs.ph_overtime_hours) },
    ...(poyaOvertimeLogged ? [{ label: 'Poya Overtime Hours', value: count(hs.poya_overtime_hours) }] : []),
    { label: 'OT Hours', value: count(hs.ot_hours) },
    { label: 'Normal OT Payment', value: money(normalOtPayment) },
    { label: 'PH Days', value: count(hs.ph_days) },
    { label: 'PH Day payment', value: money(phDayAmount) },
    { label: 'PH Overtime pay', value: money(phOvertimeAmount) },
    ...(poyaOvertimeLogged ? [{ label: 'Poya Overtime pay', value: money(poyaOvertimeAmount) }] : []),
    { label: 'Poya Day', value: count(hs.poya_days) },
    { label: 'Poya day Pay', value: money(poyaDayAmount) },
    ...(mercantileLogged ? [
      { label: 'Normal Mercantile Hours', value: count(hs.normal_mercantile_hours) },
      { label: 'Mercantile Overtime Hours', value: count(hs.mercantile_overtime_hours) },
      { label: 'Mercantile Overtime pay', value: money(mercantileOvertimeAmount) },
      { label: 'Mercantile Day', value: count(hs.mercantile_days) },
      { label: 'Mercantile Day payment', value: money(mercantileDayAmount) },
    ] : []),
    { label: 'Basic Pay', value: money(basicAmount) },
    { label: 'Allowances(BR1/BR2)', value: money(otherAllowances) },
    { label: 'TOTAL', value: money(subtotal), bold: true },
    { label: 'No Pay Deductions', value: noPayAmount == null ? '-' : money(Math.abs(noPayAmount)) },
    { label: 'No Pay Days', value: count(hs.no_pay_days) },
    { label: 'Late Time', value: lateLabel },
    { label: 'TOTAL FOR PROVIDENT FUND', value: money(result.epf_base), bold: true },
    { label: 'OT Payment', value: money(otPaymentTotal), bold: true },
  ];

  const allowanceRows: PayslipRow[] = [
    ...NAMED_ALLOWANCES.map(name => ({ label: name, value: money(amountByName(lines, 'allowance', name)) })),
    { label: 'TOTAL ALLOWANCE', value: money(NAMED_ALLOWANCES.reduce((s, n) => s + amountByName(lines, 'allowance', n), 0)), bold: true },
    { label: 'GROSS PAY', value: money(result.gross_pay), bold: true },
  ];

  // APIT is always folded into TOTAL DEDUCTIONS/BALANCE PAY numerically (see the engine), but
  // only printed as its own labelled row when it's actually present — a slip with no tax due
  // keeps the template's original deduction list exactly as-is.
  const apitAmount = result.apit_amount;
  const suspenseAmount = lines.filter(l => l.type === 'suspense_recovery').reduce((s, l) => s + (l.amount ?? 0), 0);
  const deductionRows: PayslipRow[] = [
    { label: 'FOR PROVIDENT FUND', value: money(findLine(lines, 'epf_employee')?.amount ?? null) },
    ...(apitAmount ? [{ label: 'APIT (Income Tax)', value: money(apitAmount) }] : []),
    { label: 'Salary Advance', value: money(lines.filter(l => l.type === 'salary_advance_repayment').reduce((s, l) => s + (l.amount ?? 0), 0)) },
    // Printed only when there is one, like APIT above — a slip with no split keeps the template's
    // original deduction list exactly as it was. It has to appear when present, though: it is
    // inside result.total_deductions, so omitting it would leave the itemised rows not adding up
    // to the total printed underneath them.
    ...(suspenseAmount ? [{ label: 'Suspense Expense Splits', value: money(suspenseAmount) }] : []),
    ...NAMED_DEDUCTIONS.map(name => ({ label: name, value: money(amountByName(lines, 'deduction', name)) })),
    { label: 'TOTAL DEDUCTIONS', value: money(result.total_deductions), bold: true },
    { label: 'BALANCE PAY', value: money(result.net_pay), bold: true },
  ];

  const epfEmployerLine = findLine(lines, 'epf_employer');
  const etfEmployerLine = findLine(lines, 'etf_employer');
  const employerRows: PayslipRow[] = [
    { label: 'NIC NO', value: result.nic_snapshot || '-' },
    { label: 'E.P.F. NO', value: result.epf_number },
    { label: 'Employee No', value: result.employee_no_snapshot || '-' },
    { label: 'Designation', value: result.designation_snapshot || '-' },
    { label: 'Department', value: result.department_snapshot || '-' },
    { label: `E.P.F.${epfEmployerLine?.rate != null ? ` (${epfEmployerLine.rate}%)` : ''}`, value: money(result.employer_epf) },
    { label: `E.T.F.${etfEmployerLine?.rate != null ? ` (${etfEmployerLine.rate}%)` : ''}`, value: money(result.employer_etf) },
  ];

  return {
    companyName: result.company_name,
    companyAddress,
    employeeName: result.employee_name,
    epfNumber: result.epf_number,
    periodLabel,
    periodShortLabel,
    runStatus: result.run_status,
    topRows, allowanceRows, deductionRows, employerRows,
    grossPay: result.gross_pay,
    totalDeductions: result.total_deductions,
    netPay: result.net_pay,
    bankName: result.bank_snapshot.bank_name,
    bankBranch: result.bank_snapshot.bank_branch,
    accountNumber: result.bank_snapshot.account_number,
    warningsCount: result.warnings.length,
  };
}

export async function exportPayslipPdf(data: PayslipData): Promise<void> {
  const { default: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const PAGE_W = 595.28; // A4 pt
  const MARGIN = 34;
  const doc = new JsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });

  // ── Letterhead ──────────────────────────────────────────────────────────────────────
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text(data.companyName, PAGE_W / 2, 34, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  let y = 47;
  if (data.companyAddress) {
    doc.setFontSize(8.5);
    doc.setTextColor(90);
    for (const line of data.companyAddress.split(/\r?\n|,\s*/).filter(Boolean)) {
      doc.text(line, PAGE_W / 2, y, { align: 'center' });
      y += 9.5;
    }
    doc.setTextColor(0);
  }

  // Period bar — the template's own boxed "Jul-26" section header, directly above the sheet.
  y += 3;
  doc.setFillColor(12, 142, 202);
  doc.rect(MARGIN, y, PAGE_W - MARGIN * 2, 16, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text(data.periodShortLabel, PAGE_W / 2, y + 11.5, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);
  y += 16 + 10; // clear gap below the banner so the name line isn't jammed against it

  // Employee · EPF on the left, run status on the right. A very long name would otherwise
  // run under the right-aligned "Status:" — reserve room for it and wrap the name if needed.
  doc.setFontSize(8);
  doc.setTextColor(90);
  const statusText = `Status: ${data.runStatus}`;
  doc.text(statusText, PAGE_W - MARGIN, y, { align: 'right' });
  const nameMaxW = PAGE_W - MARGIN * 2 - doc.getTextWidth(statusText) - 12;
  const nameLines = doc.splitTextToSize(`${data.employeeName}  ·  ${data.epfNumber}`, Math.max(120, nameMaxW)) as string[];
  doc.text(nameLines, MARGIN, y);
  doc.setTextColor(0);
  y += 3 + nameLines.length * 9;

  // ── Tight, single-page tables ───────────────────────────────────────────────────────
  const rowsBody = (rows: PayslipRow[]) => rows.map(r => [r.label, r.value]);
  const boldRowIndexes = (rows: PayslipRow[]) => rows.reduce<number[]>((acc, r, i) => (r.bold ? [...acc, i] : acc), []);

  const table = (head: string, rows: PayslipRow[], startY: number, fillColor: [number, number, number]): number => {
    autoTable(doc, {
      head: [[head, 'Amount']],
      body: rowsBody(rows),
      startY,
      margin: { left: MARGIN, right: MARGIN },
      styles: { fontSize: 7, cellPadding: { top: 1.2, bottom: 1.2, left: 4, right: 4 }, lineColor: [220, 220, 220], lineWidth: 0.5 },
      headStyles: { fillColor, fontSize: 7, cellPadding: { top: 2, bottom: 2, left: 4, right: 4 } },
      columnStyles: { 1: { halign: 'right', cellWidth: 90 } },
      didParseCell: (hookData) => {
        if (hookData.section === 'body' && boldRowIndexes(rows).includes(hookData.row.index)) {
          hookData.cell.styles.fontStyle = 'bold';
          hookData.cell.styles.fillColor = [240, 240, 240];
        }
      },
    });
    return (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 5;
  };

  y = table('Description', data.topRows, y, [12, 142, 202]);
  y = table('Allowances', data.allowanceRows, y, [40, 160, 100]);
  y = table('Deductions', data.deductionRows, y, [200, 80, 80]);
  y = table("Employer's Contribution", data.employerRows, y, [140, 140, 140]);

  if (data.bankName || data.accountNumber) {
    doc.setFontSize(7);
    doc.setTextColor(110);
    doc.text(`Bank: ${data.bankName ?? '-'}  ·  Branch: ${data.bankBranch ?? '-'}  ·  Account: ${data.accountNumber ?? '-'}`, MARGIN, y);
    doc.setTextColor(0);
    y += 10;
  }

  if (data.warningsCount > 0) {
    doc.setFontSize(7);
    doc.setTextColor(180, 120, 0);
    doc.text(`${data.warningsCount} calculation warning(s) were recorded for this payslip — contact payroll admin for details.`, MARGIN, y);
    doc.setTextColor(0);
    y += 10;
  }

  // Subtle centered footer note — replaces the old signature box / rotated-name block. Placed
  // just below the last content, but clamped up to the bottom margin if the tables ran long,
  // so the payslip always stays on a single A4 page.
  const PAGE_H = 841.89; // A4 pt
  const footerY = Math.min(y + 10, PAGE_H - MARGIN);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(140);
  doc.text('This is a computer-generated payslip and requires no signature.', PAGE_W / 2, footerY, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);

  const safe = (s: string) => s.replace(/[^\w.-]+/g, '_');
  doc.save(`payslip_${safe(data.epfNumber)}_${safe(data.periodShortLabel)}.pdf`);
}
