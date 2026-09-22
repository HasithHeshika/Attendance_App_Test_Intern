'use client';
// Month attendance register export (overview page): one row per employee, one column
// per day — P present · L leave · A absent · H holiday · "-" Sunday · blank future —
// plus per-employee totals and a per-day summary. Emitted as CSV (no deps), Excel
// (xlsx, dynamic import) or PDF (jspdf + autotable, dynamic import), so none of the
// export libraries ever reach the initial bundle.

import { format, getDaysInMonth } from 'date-fns';
import { getDocs, query, collection, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { specialLeaveOn } from '@/lib/utils';

export interface MonthRegister {
  year: number;
  month: number;               // 1-based
  monthLabel: string;          // e.g. "July 2026"
  companyLabel: string;
  dayNums: number[];           // 1..N
  rows: Array<{
    epf: string;
    name: string;
    statuses: string[];        // one per day: 'P' | 'L' | 'A' | 'H' | '-' | ''
    present: number;
    leave: number;
    absent: number;
  }>;
  daily: Array<{ date: string; present: number; onLeave: number; absent: number; total: number }>;
}

const STATUS_LEGEND = 'P = Present · L = Leave · A = Absent · H = Holiday · "-" = Sunday';

// Assemble the register for the month. `employees` is the overview page's already
// company-filtered active-attendance-user list; `holidays` its public-holiday map.
export async function buildMonthRegister(opts: {
  month: Date;
  employees: Array<Record<string, unknown>>;
  holidays: Record<string, string>;
  companyLabel: string;
}): Promise<MonthRegister> {
  const { month, employees, holidays, companyLabel } = opts;
  const y = month.getFullYear(), m = month.getMonth() + 1;
  const prefix = `${y}-${String(m).padStart(2, '0')}`;
  const daysInMo = getDaysInMonth(month);
  const today = format(new Date(), 'yyyy-MM-dd');

  // Same source queries the overview month view uses.
  const [attSnap, leaveSnap] = await Promise.all([
    getDocs(query(collection(db, 'attendances'), where('date', '>=', `${prefix}-01`), where('date', '<=', `${prefix}-31`))),
    getDocs(query(collection(db, 'leaves'), where('status', '==', 'approved'))),
  ]);

  const empEpfs = new Set(employees.map(e => String(e.epf_number)));
  const hasCheckIn = (a: Record<string, unknown>) => Array.isArray(a.sessions)
    ? (a.sessions as Array<{ check_in?: unknown }>).some(s => s.check_in)
    : !!a.check_in;

  // date → set of present epfs
  const presentByDay = new Map<string, Set<string>>();
  attSnap.docs.forEach(d => {
    const a = d.data();
    if (hasCheckIn(a) && empEpfs.has(String(a.epf_number))) {
      if (!presentByDay.has(a.date)) presentByDay.set(a.date, new Set());
      presentByDay.get(a.date)!.add(String(a.epf_number));
    }
  });

  // Approved leaves per employee (date-ranged), applied per day below.
  const leaves = leaveSnap.docs.map(d => d.data()).filter(l => empEpfs.has(String(l.epf_number)));

  const dayNums = Array.from({ length: daysInMo }, (_, i) => i + 1);
  const dates = dayNums.map(d => `${prefix}-${String(d).padStart(2, '0')}`);

  const rows = [...employees]
    .sort((a, b) => String(a.display_name ?? '').localeCompare(String(b.display_name ?? '')))
    .map(emp => {
      const epf = String(emp.epf_number);
      const onLeaveDay = (ds: string) =>
        leaves.some(l => String(l.epf_number) === epf && String(l.from_date).slice(0, 10) <= ds && String(l.to_date).slice(0, 10) >= ds) ||
        !!specialLeaveOn(emp.special_leaves as never, ds);

      let present = 0, leave = 0, absent = 0;
      const statuses = dates.map(ds => {
        if (ds > today) return '';
        const isSunday = new Date(ds + 'T00:00:00').getDay() === 0;
        if (presentByDay.get(ds)?.has(epf)) { present++; return 'P'; }
        if (isSunday) return '-';
        if (holidays[ds]) return 'H';
        if (onLeaveDay(ds)) { leave++; return 'L'; }
        absent++; return 'A';
      });

      return {
        epf,
        name: String(emp.display_name ?? epf),
        statuses,
        present, leave, absent,
      };
    });

  const daily = dates.map((ds, i) => {
    const isSunday = new Date(ds + 'T00:00:00').getDay() === 0;
    const future = ds > today;
    const present = rows.reduce((n, r) => n + (r.statuses[i] === 'P' ? 1 : 0), 0);
    const onLeave = rows.reduce((n, r) => n + (r.statuses[i] === 'L' ? 1 : 0), 0);
    const absent  = rows.reduce((n, r) => n + (r.statuses[i] === 'A' ? 1 : 0), 0);
    return {
      date: ds,
      present,
      onLeave,
      absent,
      total: future || isSunday ? 0 : employees.length,
    };
  });

  return {
    year: y, month: m,
    monthLabel: format(month, 'MMMM yyyy'),
    companyLabel,
    dayNums, rows, daily,
  };
}

// ─── Shared table shapes ─────────────────────────────────────────────────────────
function registerHeader(reg: MonthRegister): string[] {
  return ['EPF', 'Name', ...reg.dayNums.map(String), 'Present', 'Leave', 'Absent'];
}
function registerRows(reg: MonthRegister): string[][] {
  return reg.rows.map(r => [r.epf, r.name, ...r.statuses, String(r.present), String(r.leave), String(r.absent)]);
}
function summaryHeader(): string[] {
  return ['Date', 'Present', 'On Leave', 'Absent', 'Employees'];
}
function summaryRows(reg: MonthRegister): string[][] {
  return reg.daily.map(d => [d.date, String(d.present), String(d.onLeave), String(d.absent), d.total ? String(d.total) : '-']);
}
function baseFilename(reg: MonthRegister): string {
  const co = reg.companyLabel.replace(/[^\w-]+/g, '_');
  return `attendance_${co}_${reg.year}_${String(reg.month).padStart(2, '0')}`;
}

// ─── CSV ─────────────────────────────────────────────────────────────────────────
function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function exportRegisterCsv(reg: MonthRegister): void {
  const lines: string[][] = [
    [`Attendance register — ${reg.monthLabel} — ${reg.companyLabel}`],
    [STATUS_LEGEND],
    [],
    registerHeader(reg),
    ...registerRows(reg),
    [],
    summaryHeader(),
    ...summaryRows(reg),
  ];
  const csv = lines.map(r => r.map(csvCell).join(',')).join('\r\n');
  // BOM so Excel opens it as UTF-8 (Sinhala/Tamil names).
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${baseFilename(reg)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Excel (.xlsx) ───────────────────────────────────────────────────────────────
export async function exportRegisterXlsx(reg: MonthRegister): Promise<void> {
  const { utils, writeFile } = await import('xlsx');
  const wb = utils.book_new();

  const regSheet = utils.aoa_to_sheet([registerHeader(reg), ...registerRows(reg)]);
  regSheet['!cols'] = [
    { wch: 12 },
    { wch: Math.max(10, ...reg.rows.map(r => r.name.length)) + 2 },
    ...reg.dayNums.map(() => ({ wch: 3 })),
    { wch: 8 }, { wch: 7 }, { wch: 7 },
  ];
  utils.book_append_sheet(wb, regSheet, 'Register');

  const sumSheet = utils.aoa_to_sheet([summaryHeader(), ...summaryRows(reg)]);
  sumSheet['!cols'] = [{ wch: 12 }, { wch: 8 }, { wch: 9 }, { wch: 8 }, { wch: 10 }];
  utils.book_append_sheet(wb, sumSheet, 'Daily summary');

  writeFile(wb, `${baseFilename(reg)}.xlsx`);
}

// ─── PDF ─────────────────────────────────────────────────────────────────────────
// English-only content by design: jsPDF's built-in fonts can't render Sinhala/Tamil
// glyphs, and the register body is codes + names (stored in Latin script).
export async function exportRegisterPdf(reg: MonthRegister): Promise<void> {
  const { default: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new JsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

  doc.setFontSize(14);
  doc.text(`Attendance register — ${reg.monthLabel}`, 40, 36);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`${reg.companyLabel} · generated ${format(new Date(), 'yyyy-MM-dd HH:mm')}`, 40, 52);
  doc.text(STATUS_LEGEND, 40, 64);
  doc.setTextColor(0);

  autoTable(doc, {
    head: [registerHeader(reg)],
    body: registerRows(reg),
    startY: 76,
    styles: { fontSize: 5.5, cellPadding: 1.5, halign: 'center' },
    headStyles: { fillColor: [12, 142, 202], fontSize: 5.5 },
    columnStyles: {
      0: { halign: 'left', cellWidth: 52 },
      1: { halign: 'left', cellWidth: 90 },
    },
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      const v = data.cell.raw;
      if (v === 'A') data.cell.styles.textColor = [200, 40, 70];
      else if (v === 'L') data.cell.styles.textColor = [150, 100, 220];
      else if (v === 'P') data.cell.styles.textColor = [30, 140, 80];
    },
  });

  doc.addPage('a4', 'portrait');
  doc.setFontSize(12);
  doc.text(`Daily summary — ${reg.monthLabel}`, 40, 40);
  autoTable(doc, {
    head: [summaryHeader()],
    body: summaryRows(reg),
    startY: 54,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [12, 142, 202] },
  });

  doc.save(`${baseFilename(reg)}.pdf`);
}
