'use client';
// Shared "pick a component + amount, one row per line" editor — used for an employee's
// recurring Allowances/Deductions on the Payroll Employees page, and for the common
// baseline allowances/deductions on the Bulk Add wizard (where the SAME row applies to every
// selected employee at once). A component can only appear once per list — the picker only
// offers ones not already used elsewhere in the same list.
//
// Picking a component (via Add, or by changing an existing row's selection) pre-fills the
// amount from that component's own `default_amount` (Payroll Settings) — purely a starting
// point, the amount input stays a normal editable field afterward so it can be overridden per
// employee (single profile) or before applying to the whole batch (Bulk Add).

import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { PayrollEmployeeComponentLine, PayrollComponent } from '@/lib/payrollTypes';

export function ComponentRows({
  rows, options, canEdit, onChange,
}: { rows: PayrollEmployeeComponentLine[]; options: PayrollComponent[]; canEdit: boolean; onChange: (rows: PayrollEmployeeComponentLine[]) => void }) {
  const usedIds = new Set(rows.map(r => r.component_id));
  const unusedOptions = options.filter(o => !usedIds.has(o.id as string));
  const addRow = () => {
    const first = unusedOptions[0];
    onChange([...rows, { component_id: first?.id ?? '', amount: first?.default_amount ?? 0 }]);
  };
  const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  const update = (i: number, patch: Partial<PayrollEmployeeComponentLine>) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  // Switching a row's component re-pre-fills the amount from the newly picked component's own
  // default — the input remains freely editable right after, this is only the starting point.
  const selectComponent = (i: number, componentId: string) => {
    const comp = options.find(o => o.id === componentId);
    update(i, { component_id: componentId, amount: comp?.default_amount ?? 0 });
  };

  return (
    <div className="space-y-2">
      {rows.map((r, i) => {
        // A row keeps its own current selection available even if every other component
        // is already used elsewhere in this list — only OTHER rows' picks are excluded.
        const rowOptions = options.filter(o => o.id === r.component_id || !usedIds.has(o.id as string));
        return (
          <div key={i} className="flex items-center gap-2">
            <Select value={r.component_id} onValueChange={v => selectComponent(i, v)}>
              <SelectTrigger className="flex-1" disabled={!canEdit}><SelectValue placeholder="Component" /></SelectTrigger>
              <SelectContent>{rowOptions.map(o => <SelectItem key={o.id} value={o.id as string}>{o.name}</SelectItem>)}</SelectContent>
            </Select>
            <Input type="number" min={0} className="w-28" disabled={!canEdit} placeholder="0"
              aria-invalid={!(r.amount >= 0)}
              value={Number.isFinite(r.amount) ? r.amount : ''}
              onChange={e => update(i, { amount: e.target.value === '' ? NaN : +e.target.value })} />
            {canEdit && <Button variant="outline" size="sm" onClick={() => removeRow(i)}>Remove</Button>}
          </div>
        );
      })}
      {canEdit && <Button variant="outline" size="sm" onClick={addRow} disabled={unusedOptions.length === 0}><Plus className="w-3.5 h-3.5" />Add</Button>}
      {canEdit && options.length > 0 && unusedOptions.length === 0 && rows.length > 0 && (
        <p className="text-[10px] text-muted-foreground">Every available component is already listed above.</p>
      )}
    </div>
  );
}
