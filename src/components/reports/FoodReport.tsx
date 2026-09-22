'use client';
import { useEffect, useRef, useState } from 'react';
import { UtensilsCrossed, Loader2, Building2, Download, CalendarOff } from 'lucide-react';
import toast from 'react-hot-toast';
import type { Company, ChamaryMealOffday } from '@/lib/types';
import { useT } from '@/store/appStore';
import { computeChamaryFoodReport, type FoodReportRow, type IndicativeRate } from '@/lib/foodReport';
import { MEAL_ORDER } from '@/lib/meals';
import { loadIndicativeRate } from '@/components/lunch/MyLunchCount';
import { listAllChamaries, type ChamaryWithPlace } from '@/services/workingPlaceService';
import { getChamaryMealsMonthly, getChamaryOffdaysMonthly } from '@/services/mealService';
import { getChamaryExpenses, formatSuspenseAmount } from '@/services/suspenseService';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import Select from '@/components/Select';
import MonthYearPicker from '@/components/MonthYearPicker';
import { EmptyState } from '@/components/ui/empty-state';
import { useReportEditor, ReportEditControls, EditableCell, numeric } from '@/components/reports/editableReport';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const safe = (s: string) => String(s).replace(/[^\w.-]+/g, '_');

interface ChamaryBlock {
  chamary:       ChamaryWithPlace;
  offdays:       ChamaryMealOffday[];
  approvedSpend: number;
  rows:          FoodReportRow[];
  totalMeals:    number;
  perMealCost:   number;
  indicative:    IndicativeRate | null;   // null = its lookback read failed, not "no rate"
}

// Monthly food deduction per chamary: its approved food bills split equally across every meal it
// served, times each person's own count. Filterable by its OWN company / year / month —
// independent of the attendance and suspense reports' filters.
export default function FoodReport({ companies }: { companies: Company[] }) {
  const t = useT();
  const now = new Date();
  const [companyId, setCompanyId] = useState('');
  const [year, setYear]           = useState(now.getFullYear());
  const [month, setMonth]         = useState(now.getMonth() + 1);
  const [blocks, setBlocks]       = useState<ChamaryBlock[] | null>(null);
  const [loading, setLoading]     = useState(false);
  // Edit-before-download. Rows are keyed chamary+EPF, because the same person can appear once
  // under each chamary they ate at and those are different rows with different numbers.
  const editor = useReportEditor();

  const yearOptions = [2023, 2024, 2025, 2026].filter(y => y <= now.getFullYear());

  // Loaded blocks belong to the scope they were fetched for, but the header, totals and export
  // filename all read the CURRENT scope. Changing the scope clears the blocks AND bumps the
  // token, so a load still in flight for the old company / month is discarded on arrival instead
  // of landing under the new label.
  const scopeToken = useRef(0);
  // Overrides are keyed by row, and a new scope brings a different set of rows — carrying them
  // across would silently stamp last month's corrections onto this month's names.
  useEffect(() => { scopeToken.current += 1; setBlocks(null); editor.reset(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [companyId, year, month]);

  const companyName = companyId ? (companies.find(c => c.id === companyId)?.name ?? '—') : 'All companies';

  // Only the running month's per-meal cost is provisional. A closed month's is the settled figure
  // the deductions were actually made on, and must not be hedged.
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;

  const load = async () => {
    const token = ++scopeToken.current;
    setLoading(true);
    try {
      const fromMs = new Date(year, month - 1, 1).getTime();
      const toMs   = new Date(year, month, 1).getTime() - 1;
      // A month that has already closed: count deactivated chamaries and working places too, or
      // shutting a site down erases everything it served that month.
      const chamaries = await listAllChamaries({ includeInactive: true });
      const built = await Promise.all(chamaries.map(async (chamary): Promise<Omit<ChamaryBlock, 'indicative'>> => {
        const [bookings, offdays, expenses] = await Promise.all([
          getChamaryMealsMonthly(chamary.id, year, month),
          getChamaryOffdaysMonthly(chamary.id, year, month),
          getChamaryExpenses(chamary.id, fromMs, toMs),
        ]);
        const approvedSpend = expenses.reduce((total, s) => total + (s.amount || 0), 0);
        // Split over EVERY booking the chamary took — narrowing them to one company first would
        // charge that company's people for the whole kitchen. The company filter drops rows from
        // the table afterwards; it never changes what a meal cost.
        const report = computeChamaryFoodReport({ bookings, approvedSpend });
        const epfsInCompany = companyId
          ? new Set(bookings.filter(b => b.company_id === companyId).map(b => b.epf_number))
          : null;
        return {
          chamary,
          offdays: offdays.sort((a, b) => a.date.localeCompare(b.date) || MEAL_ORDER[a.meal] - MEAL_ORDER[b.meal]),
          approvedSpend,
          rows: epfsInCompany ? report.rows.filter(r => epfsInCompany.has(r.epf_number)) : report.rows,
          totalMeals:  report.totalMeals,
          perMealCost: report.perMealCost,
        };
      }));
      // The rate employees were shown for this month, worked out from the closed months BEFORE it,
      // so a past month shows what its own staff saw at the time. Only for the chamaries that made
      // the report: it costs another read or two each, and an idle one has nothing to show it
      // against. It is a side note here — a failed lookback drops that one line, never the report.
      const kept = built.filter(b => b.rows.length > 0 || b.offdays.length > 0);
      const withRates = await Promise.all(kept.map(async (b): Promise<ChamaryBlock> => ({
        ...b, indicative: await loadIndicativeRate(b.chamary.id, new Date(year, month - 1, 1)).catch(() => null),
      })));
      if (scopeToken.current !== token) return;
      setBlocks(withRates);
    } catch {
      if (scopeToken.current !== token) return;
      toast.error('Failed to load the food report.'); setBlocks([]);
    }
    finally { setLoading(false); }
  };

  const mealLabel: Record<string, string> = {
    breakfast: t.mealBreakfast, lunch: t.mealLunch, dinner: t.mealDinner,
  };

  const exportXlsx = async () => {
    if (!blocks?.length) return;
    const { utils, writeFile } = await import('xlsx');
    const header = [
      'CHAMARY', 'WORKING PLACE', 'EMPLOYEE', 'EPF NO', 'COMPANY',
      'BREAKFAST', 'LUNCH', 'DINNER', 'TOTAL MEALS', 'SERVED', 'NO SHOWS',
      'PER MEAL (RS)', 'DEDUCTION (RS)',
    ];
    // Every cell goes through the editor, so what downloads is exactly what is on screen —
    // including the admin's corrections.
    const aoaRows: (string | number)[][] = blocks.flatMap(b => b.rows.map(r => {
      const k = `${b.chamary.id}:${r.epf_number}`;
      return [
        b.chamary.name, b.chamary.working_place_name,
        editor.value(k, 'employee_name', r.employee_name), r.epf_number, r.company_name,
        numeric(editor.value(k, 'breakfast', r.breakfast)),
        numeric(editor.value(k, 'lunch', r.lunch)),
        numeric(editor.value(k, 'dinner', r.dinner)),
        numeric(editor.value(k, 'total', r.total)),
        numeric(editor.value(k, 'served', r.served)),
        numeric(editor.value(k, 'noShows', r.noShows)),
        Math.round(b.perMealCost * 100) / 100,
        numeric(editor.value(k, 'deduction', r.deduction)),
      ];
    }));

    const ws = utils.aoa_to_sheet([header, ...aoaRows]);
    ws['!cols'] = header.map((h, i) => ({
      wch: Math.max(String(h).length, ...aoaRows.map(row => String(row[i] ?? '').length)) + 2,
    }));
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, `${MONTHS[month - 1]} ${year}`);
    writeFile(wb, `food_${safe(companyName)}_${year}_${String(month).padStart(2, '0')}.xlsx`);
  };

  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-brand text-primary-foreground shadow-soft ring-1 ring-inset ring-[hsl(0_0%_100%/0.15)]">
          <UtensilsCrossed className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">{t.foodReports}</h2>
          <p className="text-sm text-muted-foreground">{companyName} · {MONTHS[month - 1]} {year}</p>
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Report period</Label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select searchable disabled={loading} value={companyId || 'all'} onChange={v => setCompanyId(v === 'all' ? '' : v)}
            options={[{ value: 'all', label: 'All companies' }, ...companies.map(c => ({ value: c.id, label: c.name }))]} />
          {/* MonthYearPicker takes no `disabled` prop, so freeze it from out here while a load
              runs — `inert` blocks the pointer and the keyboard alike. */}
          <div inert={loading} className={loading ? 'opacity-50' : undefined}>
            <MonthYearPicker year={year} month={month} years={yearOptions} onChange={(y, m) => { setYear(y); setMonth(m); }} />
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={load} disabled={loading} className="h-11">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Load report'}
        </Button>
        {!!blocks?.length && (
          <>
            <ReportEditControls editor={editor} />
            <Button size="sm" variant="outline" onClick={exportXlsx}><Download className="h-4 w-4" /> Export</Button>
          </>
        )}
      </div>

      {blocks === null ? (
        <p className="mt-5 text-center text-sm text-muted-foreground">Choose a company / month above, then <span className="font-medium text-foreground">Load report</span>.</p>
      ) : loading ? (
        <div className="mt-6 flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : blocks.length === 0 ? (
        <div className="mt-4"><EmptyState icon={UtensilsCrossed} title="No meals this month" description="No chamary served a meal in the selected period." /></div>
      ) : (
        <div className="mt-5 space-y-6">
          {isCurrentMonth && (
            <p className="rounded-xl border border-border bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              Early in a month the provisional per-meal cost runs high — the bills land before the meals do — and settles by month end, so staff are shown the last closed month&apos;s rate instead.
            </p>
          )}
          {blocks.map(b => (
            <div key={b.chamary.id}>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-foreground">{t.chamaryLabel}: {b.chamary.name}</h3>
                  <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Building2 className="h-3 w-3 shrink-0" /> {b.chamary.working_place_name}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {t.totalMealsLabel} <span className="font-semibold tabular-nums text-foreground">{b.totalMeals}</span>
                  {' · '}Approved spend <span className="font-semibold tabular-nums text-foreground">{formatSuspenseAmount(b.approvedSpend, 'LKR')}</span>
                  {' · '}Per meal <span className="font-semibold tabular-nums text-foreground">{formatSuspenseAmount(b.perMealCost, 'LKR')}</span>
                  {isCurrentMonth && ' (provisional)'}
                  {b.indicative && (
                    b.indicative.ratePerMeal === null
                      ? <>{' · '}Shown to staff <span className="italic">none yet</span></>
                      : <>{' · '}Shown to staff <span className="font-semibold tabular-nums text-foreground">{formatSuspenseAmount(b.indicative.ratePerMeal, 'LKR')}</span> (from {b.indicative.basisMonth})</>
                  )}
                </div>
              </div>

              {b.offdays.length > 0 && (
                <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-foreground">
                  <CalendarOff className="h-3.5 w-3.5 shrink-0 text-warning" />
                  <span className="font-semibold">{t.notCookingThatDay}:</span>
                  {b.offdays.map(o => (
                    <span key={`${o.date}__${o.meal}`} className="rounded-full border border-border bg-card px-2 py-0.5">
                      {o.date} · {mealLabel[o.meal]}{o.reason ? ` — ${o.reason}` : ''}
                    </span>
                  ))}
                </div>
              )}

              {b.rows.length === 0 ? (
                <p className="text-xs text-muted-foreground">No meals for {companyName} at this chamary.</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left">Employee</th>
                        <th className="px-3 py-2 text-right">{t.mealBreakfast}</th>
                        <th className="px-3 py-2 text-right">{t.mealLunch}</th>
                        <th className="px-3 py-2 text-right">{t.mealDinner}</th>
                        <th className="px-3 py-2 text-right">{t.totalMealsLabel}</th>
                        <th className="px-3 py-2 text-right">{t.servedWord}</th>
                        <th className="px-3 py-2 text-right">{t.noShowWord}</th>
                        <th className="px-3 py-2 text-right">{t.deductionRsLabel}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {b.rows.map(r => {
                        const k = `${b.chamary.id}:${r.epf_number}`;
                        return (
                        <tr key={r.epf_number}>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1 text-foreground">
                              <EditableCell editor={editor} rowKey={k} field="employee_name" value={r.employee_name} className="truncate" />
                              <span className="shrink-0 text-muted-foreground">· {r.epf_number}</span>
                            </div>
                            <div className="truncate text-[11px] text-muted-foreground">{r.company_name}</div>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            <EditableCell editor={editor} rowKey={k} field="breakfast" value={r.breakfast} type="number" align="right" />
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            <EditableCell editor={editor} rowKey={k} field="lunch" value={r.lunch} type="number" align="right" />
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            <EditableCell editor={editor} rowKey={k} field="dinner" value={r.dinner} type="number" align="right" />
                          </td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">
                            <EditableCell editor={editor} rowKey={k} field="total" value={r.total} type="number" align="right" />
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            <EditableCell editor={editor} rowKey={k} field="served" value={r.served} type="number" align="right" />
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            <EditableCell editor={editor} rowKey={k} field="noShows" value={r.noShows} type="number" align="right" />
                          </td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">
                            <EditableCell editor={editor} rowKey={k} field="deduction" value={r.deduction} type="number" align="right"
                              render={v => numeric(v).toFixed(2)} />
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
