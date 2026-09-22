'use client';
import { useEffect, useState } from 'react';
import { Wallet, Loader2, Building2 } from 'lucide-react';
import { getEmployeeDeductions, formatSuspenseAmount, type EmployeeDeduction } from '@/services/suspenseService';
import { Card } from '@/components/ui/card';
import BillThumb from '@/components/BillThumb';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Suspense split-deductions charged to THIS employee for the current month (approved bills only) —
// the amount that will be recovered from their salary. Shown on the profile page.
export default function MyDeductions({ epf }: { epf: string }) {
  const [rows, setRows]   = useState<EmployeeDeduction[] | null>(null);
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (!epf) return;
    const now  = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const to   = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() - 1;
    setLabel(`${MONTHS[now.getMonth()]} ${now.getFullYear()}`);
    getEmployeeDeductions(epf, from, to).then(setRows).catch(() => setRows([]));
  }, [epf]);

  const total = (rows ?? []).reduce((t, r) => t + r.amount, 0);

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
          <Wallet className="h-3.5 w-3.5" /> Suspense deductions · {label}
        </div>
        {rows !== null && <div className="text-base font-bold tabular-nums text-destructive">{formatSuspenseAmount(total, 'LKR')}</div>}
      </div>

      {rows === null ? (
        <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing charged to you this month. When a colleague splits part of a bill to you, it shows here and is deducted from your salary.</p>
      ) : (
        <div className="space-y-2">
          {rows.map(r => (
            <div key={r.submission_id} className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/50 p-2">
              <BillThumb url={r.bill_url} type={r.bill_type} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-foreground">{r.expense_type}{r.item ? ` · ${r.item}` : ''}</div>
                <div className="flex items-center gap-1 text-[11px] text-muted-foreground"><Building2 className="h-3 w-3 shrink-0" /> {r.company_name} · paid by {r.payer_name}</div>
              </div>
              <div className="shrink-0 text-sm font-semibold tabular-nums text-destructive">{formatSuspenseAmount(r.amount, 'LKR')}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
