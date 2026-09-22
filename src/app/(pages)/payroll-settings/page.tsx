'use client';
// Payroll Settings — Step 1: allowance/deduction components, tax slabs, default target
// hours. Southern Lanka Hospitals tenant only (tenant.features.payroll). TENANT-WIDE — no
// company selector on this page at all; every company/branch shares the same rates, tax
// slabs and component list. Nothing here calculates a salary — this is configuration only.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Wallet, Plus, Save, Trash2, Pencil, Search, ToggleLeft, ToggleRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { tenant } from '@/lib/firebase';
import type { PayrollSettings, PayrollComponent, PayrollTaxSlab, PayrollComponentType } from '@/lib/payrollTypes';
import {
  getOrCreatePayrollSettings, updatePayrollSettings, normalizedTaxSlabs,
  getPayrollComponents, createPayrollComponent, updatePayrollComponent, deletePayrollComponent,
} from '@/services/payrollSettingsService';
import {
  PAYROLL_SETTING_RULES, payrollSettingFieldError, validateTaxSlabs, type PayrollSettingKey,
} from '@/lib/payrollValidation';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import ConfirmModal from '@/components/ConfirmModal';
import InlineError from '@/components/InlineError';
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

function useActor() {
  const { user } = useAuthStore();
  return { epf: user?.epf_number ?? '', name: user?.name ?? '' };
}

// A round, easy-to-follow Basic Salary used only to show a live "here's what this actually
// pays" example next to each holiday-pay formula — never sent anywhere, purely illustrative
// for someone who isn't going to mentally verify a multiplier/divisor formula on sight.
const SAMPLE_BASIC = 50000;

// One "Holiday Pay" card, one type visible at a time via this dropdown — three formulas that
// each require their own explanation are more to scan as three stacked cards than as one
// focused section. PH deliberately has no Rate Divisor field (see its own explanatory text
// below): it's priced off Hourly Rate × Hours per Day instead, so the field set genuinely
// differs per type rather than all three sharing one fixed template.
type HolidayTypeKey = 'ph' | 'poya' | 'mercantile';
const HOLIDAY_TYPE_OPTIONS: { key: HolidayTypeKey; label: string }[] = [
  { key: 'ph', label: 'Public Holiday (PH) Pay' },
  { key: 'poya', label: 'Poya Day Pay' },
  { key: 'mercantile', label: 'Mercantile Holiday Pay' },
];

function FormulaExample({
  amount, basicSalary, formula, missingHint,
}: {
  amount: number | null; basicSalary: number; formula: ReactNode; missingHint: string;
}) {
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
      {amount == null ? missingHint : (
        <>
          Example: for an employee with Basic Salary Rs. {basicSalary.toLocaleString()}, this pays{' '}
          <span className="font-semibold text-foreground">
            Rs. {amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>{' '}
          for that day ({formula}).
        </>
      )}
    </div>
  );
}

export default function PayrollSettingsPage() {
  const caps = useUserCapabilities();

  if (!tenant.features.payroll) {
    return <div className="p-10 text-center text-muted-foreground">Payroll is not enabled for this organisation.</div>;
  }
  if (!caps.is_system_admin && !caps.can_view_payroll && !caps.can_manage_payroll_config) {
    return <div className="p-10 text-center text-muted-foreground">You don&apos;t have access to this section.</div>;
  }
  return <PayrollSettingsContent canEdit={caps.is_system_admin || caps.can_manage_payroll_config} />;
}

function PayrollSettingsContent({ canEdit }: { canEdit: boolean }) {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Payroll Settings"
        description="Default target hours, EPF/ETF rates, tax slabs, and allowance/deduction components — shared across every company, configuration only."
        icon={Wallet}
      />

      <Tabs defaultValue="rates">
        <TabsList>
          <TabsTrigger value="rates">Rates &amp; Tax</TabsTrigger>
          <TabsTrigger value="components">Components</TabsTrigger>
        </TabsList>
        <TabsContent value="rates"><RatesTab canEdit={canEdit} /></TabsContent>
        <TabsContent value="components"><ComponentsTab canEdit={canEdit} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Rates & Tax tab ─────────────────────────────────────────────────────────────────

function RatesTab({ canEdit }: { canEdit: boolean }) {
  const actor = useActor();
  const [settings, setSettings] = useState<PayrollSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [holidayType, setHolidayType] = useState<HolidayTypeKey>('ph');

  const load = async () => {
    setLoading(true);
    try { setSettings(await getOrCreatePayrollSettings()); }
    catch (e) { console.error(e); toast.error('Failed to load settings.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await updatePayrollSettings({
        default_target_hours: settings.default_target_hours,
        default_hours_per_day: settings.default_hours_per_day,
        ph_day_multiplier: settings.ph_day_multiplier,
        ph_day_rate_divisor: settings.ph_day_rate_divisor,
        ph_overtime_multiplier: settings.ph_overtime_multiplier,
        poya_day_multiplier: settings.poya_day_multiplier,
        poya_day_rate_divisor: settings.poya_day_rate_divisor,
        mercantile_day_multiplier: settings.mercantile_day_multiplier,
        mercantile_day_rate_divisor: settings.mercantile_day_rate_divisor,
        mercantile_overtime_multiplier: settings.mercantile_overtime_multiplier,
        poya_overtime_multiplier: settings.poya_overtime_multiplier,
        epf_employee_rate: settings.epf_employee_rate,
        epf_employer_rate: settings.epf_employer_rate,
        etf_employer_rate: settings.etf_employer_rate,
        stamp_duty_amount: settings.stamp_duty_amount,
        tax_slabs: normalizedTaxSlabs(settings.tax_slabs),
      }, actor.epf, actor.name);
      toast.success('Settings saved.');
      await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to save.'); }
    finally { setSaving(false); }
  };

  const addSlab = () => {
    if (!settings) return;
    const last = settings.tax_slabs[settings.tax_slabs.length - 1];
    const from = last ? (last.to != null ? last.to + 1 : last.from) : 0;
    setSettings({ ...settings, tax_slabs: [...settings.tax_slabs, { from, to: null, rate: 0 }] });
  };
  const removeSlab = (i: number) => {
    if (!settings) return;
    setSettings({ ...settings, tax_slabs: settings.tax_slabs.filter((_, idx) => idx !== i) });
  };
  const updateSlab = (i: number, patch: Partial<PayrollTaxSlab>) => {
    if (!settings) return;
    setSettings({ ...settings, tax_slabs: settings.tax_slabs.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) });
  };

  if (loading || !settings) return <Card className="p-8 text-center text-sm text-muted-foreground">Loading…</Card>;

  // ── Live range / non-negative validation (mirrors updatePayrollSettings) ──────────────
  const cfg = settings; // non-null narrowing for the closures below
  // A number <input> whose value maps a blank string to null, so Backspace on a lone "0"
  // clears the field (no snap-back), with an inline range error + red border.
  const renderNumInput = (k: PayrollSettingKey, opts: { step?: string; placeholder?: string } = {}) => {
    const rule = PAYROLL_SETTING_RULES[k];
    const err = payrollSettingFieldError(k, cfg[k]);
    return (
      <>
        <Input
          type="number" step={opts.step} min={rule.min} max={rule.max} disabled={!canEdit}
          placeholder={opts.placeholder} value={cfg[k] ?? ''} aria-invalid={!!err}
          onChange={e => setSettings({ ...cfg, [k]: e.target.value === '' ? null : +e.target.value })}
        />
        <InlineError>{err}</InlineError>
      </>
    );
  };

  const rateFieldErrors = (Object.keys(PAYROLL_SETTING_RULES) as PayrollSettingKey[])
    .map(k => payrollSettingFieldError(k, cfg[k])).filter(Boolean);
  const slabErrors = validateTaxSlabs(cfg.tax_slabs);
  const hasSettingsError = rateFieldErrors.length > 0 || slabErrors.length > 0;

  // Live "what this actually pays" examples shown next to each holiday-pay formula — null
  // whenever a needed field isn't configured yet, so FormulaExample shows the hint instead.
  const phExample = (cfg.ph_day_rate_divisor && cfg.ph_day_rate_divisor > 0 && cfg.ph_day_multiplier != null)
    ? (SAMPLE_BASIC / cfg.ph_day_rate_divisor) * cfg.ph_day_multiplier : null;
  const poyaExample = (cfg.poya_day_rate_divisor && cfg.poya_day_rate_divisor > 0 && cfg.poya_day_multiplier != null)
    ? (SAMPLE_BASIC / cfg.poya_day_rate_divisor) * cfg.poya_day_multiplier : null;
  const mercantileExample = (cfg.mercantile_day_rate_divisor && cfg.mercantile_day_rate_divisor > 0 && cfg.mercantile_day_multiplier != null)
    ? (SAMPLE_BASIC / cfg.mercantile_day_rate_divisor) * cfg.mercantile_day_multiplier : null;

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-4">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Target hours &amp; overtime base</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">Monthly Target Hours</Label>
            {renderNumInput('default_target_hours', { placeholder: 'e.g. 200' })}
            <p className="text-[10px] text-muted-foreground">Standard total working hours per month (used to calculate the basic hourly rate). Can be overridden for individual employees.</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">Hours per Day</Label>
            {renderNumInput('default_hours_per_day', { step: '0.5', placeholder: 'e.g. 8' })}
            <p className="text-[10px] text-muted-foreground">Standard working hours per shift/day (e.g., 8 hours). Used to convert No Pay Days into hours — holiday day pay (PH/Poya/Mercantile) uses its own fixed statutory rate instead, set per holiday type below.</p>
          </div>
        </div>
      </Card>

      <Card className="p-4 space-y-4">
        <div>
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Holiday Pay</div>
          <p className="text-[11px] text-muted-foreground mt-1">Pick a holiday type below to see and edit how it&apos;s paid — each one works a little differently.</p>
        </div>
        <div className="space-y-1.5 max-w-xs">
          <Label className="text-[11px] text-muted-foreground">Holiday Type</Label>
          <Select value={holidayType} onValueChange={v => setHolidayType(v as HolidayTypeKey)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {HOLIDAY_TYPE_OPTIONS.map(o => <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {holidayType === 'ph' && (
          <div className="space-y-3 pt-1 border-t border-border">
            <p className="text-[11px] text-muted-foreground pt-3">
              A full PH day worked pays: <span className="font-medium text-foreground">(Basic Salary ÷ PH Day Rate Divisor) × PH Multiplier</span>.
              This is a fixed statutory rate — it does NOT depend on Target Hours or Hours per Day.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">PH Day Rate Divisor</Label>
                {renderNumInput('ph_day_rate_divisor', { step: '1', placeholder: 'e.g. 25' })}
                <p className="text-[10px] text-muted-foreground">Divides Basic Salary into a single day&apos;s statutory rate (e.g., 25).</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">PH Day Multiplier</Label>
                {renderNumInput('ph_day_multiplier', { step: '0.01', placeholder: 'e.g. 2' })}
                <p className="text-[10px] text-muted-foreground">Fraction of that day&apos;s rate paid for a Public Holiday (e.g., enter 2 for double pay).</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">PH Overtime Multiplier</Label>
                {renderNumInput('ph_overtime_multiplier', { step: '0.01', placeholder: 'e.g. 3' })}
                <p className="text-[10px] text-muted-foreground">Multiplier for extra hours worked on a Public Holiday, beyond a normal day&apos;s length (paid at the ordinary hourly rate, not the statutory day rate above).</p>
              </div>
            </div>
            <FormulaExample amount={phExample} basicSalary={SAMPLE_BASIC}
              formula={<>(Rs. {SAMPLE_BASIC.toLocaleString()} ÷ {cfg.ph_day_rate_divisor ?? '?'}) × {cfg.ph_day_multiplier ?? '?'}</>}
              missingHint="Set the PH Day Rate Divisor and Multiplier above to see an example." />
          </div>
        )}

        {holidayType === 'poya' && (
          <div className="space-y-3 pt-1 border-t border-border">
            <p className="text-[11px] text-muted-foreground pt-3">
              A full Poya day worked pays: <span className="font-medium text-foreground">(Basic Salary ÷ Poya Day Rate Divisor) × Poya Multiplier</span>.
              This is a fixed statutory rate — it does NOT depend on Target Hours or Hours per Day.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Poya Day Rate Divisor</Label>
                {renderNumInput('poya_day_rate_divisor', { step: '1', placeholder: 'e.g. 25' })}
                <p className="text-[10px] text-muted-foreground">Divides Basic Salary into a single day&apos;s statutory rate (e.g., 25 — the number of working days a month is treated as having).</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Poya Day Multiplier</Label>
                {renderNumInput('poya_day_multiplier', { step: '0.01', placeholder: 'e.g. 0.5' })}
                <p className="text-[10px] text-muted-foreground">Fraction of that day&apos;s rate paid for Poya (e.g., enter 0.5 for half a day&apos;s pay).</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Poya Overtime Multiplier</Label>
                {renderNumInput('poya_overtime_multiplier', { step: '0.01', placeholder: 'e.g. 3' })}
                <p className="text-[10px] text-muted-foreground">Multiplier for extra hours worked on a Poya Day, beyond a normal day&apos;s length (paid at the ordinary hourly rate, not the statutory day rate above).</p>
              </div>
            </div>
            <FormulaExample amount={poyaExample} basicSalary={SAMPLE_BASIC}
              formula={<>(Rs. {SAMPLE_BASIC.toLocaleString()} ÷ {cfg.poya_day_rate_divisor ?? '?'}) × {cfg.poya_day_multiplier ?? '?'}</>}
              missingHint="Set the Poya Day Rate Divisor and Multiplier above to see an example." />
          </div>
        )}

        {holidayType === 'mercantile' && (
          <div className="space-y-3 pt-1 border-t border-border">
            <p className="text-[11px] text-muted-foreground pt-3">
              A full Mercantile holiday worked pays: <span className="font-medium text-foreground">(Basic Salary ÷ Mercantile Day Rate Divisor) × Mercantile Multiplier</span>.
              Same fixed statutory shape as Poya. Extra hours beyond a normal day&apos;s length are paid separately, via the Overtime Multiplier below.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Mercantile Day Rate Divisor</Label>
                {renderNumInput('mercantile_day_rate_divisor', { step: '1', placeholder: 'e.g. 25' })}
                <p className="text-[10px] text-muted-foreground">Divides Basic Salary into a single day&apos;s statutory rate (e.g., 25).</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Mercantile Day Multiplier</Label>
                {renderNumInput('mercantile_day_multiplier', { step: '0.01', placeholder: 'e.g. 1' })}
                <p className="text-[10px] text-muted-foreground">Fraction of that day&apos;s rate paid for a Mercantile holiday (e.g., enter 1 for a full day&apos;s pay).</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Mercantile Overtime Multiplier</Label>
                {renderNumInput('mercantile_overtime_multiplier', { step: '0.01', placeholder: 'e.g. 3' })}
                <p className="text-[10px] text-muted-foreground">Multiplier for extra hours worked on a Mercantile holiday, beyond a normal day&apos;s length (paid at the ordinary hourly rate, not the statutory day rate above).</p>
              </div>
            </div>
            <FormulaExample amount={mercantileExample} basicSalary={SAMPLE_BASIC}
              formula={<>(Rs. {SAMPLE_BASIC.toLocaleString()} ÷ {cfg.mercantile_day_rate_divisor ?? '?'}) × {cfg.mercantile_day_multiplier ?? '?'}</>}
              missingHint="Set the Mercantile Day Rate Divisor and Multiplier above to see an example." />
          </div>
        )}
      </Card>

      <Card className="p-4 space-y-4">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Statutory (EPF / ETF)</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">EPF Employee Rate (%)</Label>
            {renderNumInput('epf_employee_rate', { step: '0.01', placeholder: 'e.g. 8' })}
            <p className="text-[10px] text-muted-foreground">Standard contribution percentage deducted from the employee&apos;s pay (e.g., 8%).</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">EPF Employer Rate (%)</Label>
            {renderNumInput('epf_employer_rate', { step: '0.01', placeholder: 'e.g. 12' })}
            <p className="text-[10px] text-muted-foreground">Standard contribution percentage paid by the company on top of the salary (e.g., 12%).</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">ETF Employer Rate (%)</Label>
            {renderNumInput('etf_employer_rate', { step: '0.01', placeholder: 'e.g. 3' })}
            <p className="text-[10px] text-muted-foreground">Standard contribution percentage paid by the company on top of the salary (e.g., 3%).</p>
          </div>
        </div>
      </Card>

      <Card className="p-4 space-y-4">
        <div>
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Stamp Duty</div>
          <p className="text-[11px] text-muted-foreground mt-1">A flat amount deducted from every staff member&apos;s salary, every month — unlike allowances/deductions below, this needs no per-employee setup and applies to everyone automatically.</p>
        </div>
        <div className="max-w-xs space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">Stamp Duty Amount (Rs.)</Label>
          {renderNumInput('stamp_duty_amount', { step: '0.01', placeholder: 'e.g. 25' })}
          <p className="text-[10px] text-muted-foreground">Shown on the payslip as &quot;Stamp Fee&quot;.</p>
        </div>
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">APIT Tax Slabs (progressive)</div>
            <p className="text-[10px] text-muted-foreground mt-1">Each bracket taxes only the income between "From" and "To". Leave the last row&apos;s "To" blank for open-ended. Brackets must be contiguous — each row&apos;s "From" should equal the previous row&apos;s "To", or one rupee after it (e.g. 100,000 then 100,001).</p>
          </div>
          {canEdit && <Button variant="outline" size="sm" onClick={addSlab}><Plus className="w-3.5 h-3.5" />Add Slab</Button>}
        </div>
        {settings.tax_slabs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No tax slabs configured — APIT will not be calculated until slabs are added (or a per-employee manual override is set).</p>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-[1.5rem_1fr_1fr_7rem_2rem] gap-2 px-0 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              <span />
              <span>From (LKR)</span>
              <span>To (LKR)</span>
              <span>Rate %</span>
              <span />
            </div>
            {settings.tax_slabs.map((s, i) => (
              <div key={i} className="grid grid-cols-[1.5rem_1fr_1fr_7rem_2rem] gap-2 items-center">
                <span className="text-xs text-muted-foreground">{i + 1}.</span>
                <Input type="number" min={0} disabled={!canEdit}
                  aria-invalid={!Number.isFinite(s.from) || s.from < 0}
                  value={Number.isFinite(s.from) ? s.from : ''}
                  onChange={e => updateSlab(i, { from: e.target.value === '' ? NaN : +e.target.value })} />
                <Input type="number" min={0} placeholder="Blank = open-ended" disabled={!canEdit}
                  value={s.to ?? ''} onChange={e => updateSlab(i, { to: e.target.value === '' ? null : +e.target.value })} />
                <Input type="number" step="0.01" min={0} max={100} placeholder="Rate %" disabled={!canEdit}
                  aria-invalid={!Number.isFinite(s.rate) || s.rate < 0 || s.rate > 100}
                  value={Number.isFinite(s.rate) ? s.rate : ''}
                  onChange={e => updateSlab(i, { rate: e.target.value === '' ? NaN : +e.target.value })} />
                {canEdit && <Button variant="outline" size="icon-sm" onClick={() => removeSlab(i)}><Trash2 className="w-3.5 h-3.5" /></Button>}
              </div>
            ))}
          </div>
        )}
        {slabErrors.length > 0 && (
          <div className="space-y-1 pt-1">
            {slabErrors.map((msg, i) => <InlineError key={i}>{msg}</InlineError>)}
          </div>
        )}
      </Card>

      {canEdit && (
        <div className="flex flex-col items-end gap-1.5">
          {hasSettingsError && (
            <p className="text-[11px] text-destructive">Fix the highlighted values before saving.</p>
          )}
          <Button onClick={handleSave} disabled={saving || hasSettingsError}>
            <Save className="w-4 h-4" />{saving ? 'Saving…' : 'Save Settings'}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Components tab ──────────────────────────────────────────────────────────────────

const TYPE_TABS: { key: 'all' | PayrollComponentType; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'allowance', label: 'Allowance' },
  { key: 'deduction', label: 'Deduction' },
];

function ComponentsTab({ canEdit }: { canEdit: boolean }) {
  const actor = useActor();
  const [components, setComponents] = useState<PayrollComponent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<PayrollComponent | null>(null);
  const [typeFilter, setTypeFilter] = useState<'all' | PayrollComponentType>('all');
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    try { setComponents(await getPayrollComponents()); }
    catch (e) { console.error(e); toast.error('Failed to load components.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleFlag = async (c: PayrollComponent, field: 'isEpfApplicable' | 'isEtfApplicable' | 'isTaxApplicable' | 'is_active') => {
    try { await updatePayrollComponent(c.id as string, { [field]: !c[field] }, actor.epf, actor.name); await load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update.'); }
  };

  const [confirmDelete, setConfirmDelete] = useState<PayrollComponent | null>(null);
  const handleDelete = async (c: PayrollComponent) => {
    try {
      await deletePayrollComponent(c.id as string, actor.epf, actor.name);
      toast.success('Component deleted.');
      await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to delete.'); }
  };

  const tabCount = (key: 'all' | PayrollComponentType) => (key === 'all' ? components.length : components.filter(c => c.type === key).length);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return components.filter(c => (typeFilter === 'all' || c.type === typeFilter) && (!q || c.name.toLowerCase().includes(q)));
  }, [components, typeFilter, search]);

  const clearFilters = () => { setTypeFilter('all'); setSearch(''); };

  if (loading) return <Card className="p-8 text-center text-sm text-muted-foreground">Loading…</Card>;

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-muted-foreground">Components are shared across every company — one added here is available everywhere.</p>

      {/* Toolbar: type filter + search, grouped in one tidy card — mirrors the Users page toolbar */}
      <Card className="p-4 space-y-4">
        <div className="flex gap-2 overflow-x-auto -mx-1 px-1">
          {TYPE_TABS.map(t => {
            const active = typeFilter === t.key;
            return (
              <button key={t.key} onClick={() => setTypeFilter(t.key)}
                className={`flex-shrink-0 flex items-center gap-2 px-3.5 py-2 rounded-md text-sm font-semibold transition-colors border ${active ? 'bg-primary/10 text-primary border-primary/20' : 'bg-card text-muted-foreground border-border hover:text-foreground hover:bg-accent'}`}>
                <span>{t.label}</span>
                <span className={`text-[10px] font-bold min-w-[20px] h-5 px-1.5 rounded-full flex items-center justify-center ${active ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}>{tabCount(t.key)}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search components by name…" className="pl-9" />
          </div>
          {canEdit && <Button onClick={() => setShowForm(true)}><Plus className="w-4 h-4" />New Component</Button>}
        </div>
      </Card>

      {components.length === 0 ? (
        <Card className="p-8">
          <EmptyState icon={Wallet} title="No components yet"
            description="Add individually named allowances/deductions (e.g. Transport Allowance, Welfare Fee) — each with its own EPF/ETF/tax flags. Shared across every company."
            action={canEdit ? <Button onClick={() => setShowForm(true)}><Plus className="w-4 h-4" />New Component</Button> : undefined} />
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="p-8">
          <EmptyState icon={Search} title="No components match your filters"
            description="Try a different search term, or switch back to All."
            action={<Button variant="outline" onClick={clearFilters}>Clear filters</Button>} />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
            <CardTitle className="text-sm">Components</CardTitle>
            <span className="text-xs font-medium text-muted-foreground">{filtered.length} of {components.length} shown</span>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Default Amount</TableHead>
                  <TableHead className="text-center">EPF</TableHead>
                  <TableHead className="text-center">ETF</TableHead>
                  <TableHead className="text-center">Tax</TableHead>
                  <TableHead className="text-center">Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(c => (
                  <TableRow key={c.id} className={!c.is_active ? 'opacity-50' : ''}>
                    <TableCell className="font-medium text-foreground">{c.name}</TableCell>
                    <TableCell><Badge variant={c.type === 'allowance' ? 'success' : 'muted'}>{c.type}</Badge></TableCell>
                    <TableCell className="text-right text-muted-foreground">{c.default_amount != null ? c.default_amount.toLocaleString() : '—'}</TableCell>
                    <TableCell className="text-center"><Switch checked={c.isEpfApplicable} disabled={!canEdit} onCheckedChange={() => toggleFlag(c, 'isEpfApplicable')} /></TableCell>
                    <TableCell className="text-center"><Switch checked={c.isEtfApplicable} disabled={!canEdit} onCheckedChange={() => toggleFlag(c, 'isEtfApplicable')} /></TableCell>
                    <TableCell className="text-center"><Switch checked={c.isTaxApplicable} disabled={!canEdit} onCheckedChange={() => toggleFlag(c, 'isTaxApplicable')} /></TableCell>
                    <TableCell className="text-center">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!canEdit}
                        onClick={() => toggleFlag(c, 'is_active')}
                        aria-label={c.is_active ? 'Deactivate' : 'Activate'}
                        title={c.is_active ? 'Deactivate' : 'Activate'}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        {c.is_active ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                      </Button>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {canEdit && (
                        <>
                          <Button variant="outline" size="icon-sm" onClick={() => setEditing(c)}><Pencil className="w-3.5 h-3.5" /></Button>
                          <Button variant="outline" size="icon-sm" className="ml-1.5" onClick={() => setConfirmDelete(c)}><Trash2 className="w-3.5 h-3.5" /></Button>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <ComponentDialog open={showForm} onOpenChange={setShowForm}
        onSave={async (payload) => {
          try {
            await createPayrollComponent(payload, actor.epf, actor.name);
            toast.success('Component created.');
            setShowForm(false);
            await load();
          } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create.'); }
        }}
      />
      <ComponentDialog open={!!editing} onOpenChange={v => !v && setEditing(null)} initial={editing ?? undefined}
        onSave={async (payload) => {
          if (!editing) return;
          try {
            await updatePayrollComponent(editing.id as string, payload, actor.epf, actor.name);
            toast.success('Component updated.');
            setEditing(null);
            await load();
          } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update.'); }
        }}
      />

      <ConfirmModal
        open={!!confirmDelete}
        onOpenChange={() => setConfirmDelete(null)}
        variant="danger"
        title="Delete component?"
        description={
          confirmDelete
            ? `"${confirmDelete.name}" will be removed for every company. Any employee or monthly-run row still referencing it will show as an unresolved reference (a warning, not a broken calculation).`
            : undefined
        }
        confirmText="Delete"
        onConfirm={async () => {
          const c = confirmDelete;
          setConfirmDelete(null);
          if (c) await handleDelete(c);
        }}
      />
    </div>
  );
}

function ComponentDialog({
  open, onOpenChange, initial, onSave,
}: {
  open: boolean; onOpenChange: (v: boolean) => void; initial?: PayrollComponent;
  onSave: (payload: Omit<PayrollComponent, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<PayrollComponentType>('allowance');
  const [defaultAmount, setDefaultAmount] = useState<number | null>(null);
  const [isEpf, setIsEpf] = useState(false);
  const [isEtf, setIsEtf] = useState(false);
  const [isTax, setIsTax] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setType(initial?.type ?? 'allowance');
    setDefaultAmount(initial?.default_amount ?? null);
    setIsEpf(initial?.isEpfApplicable ?? false);
    setIsEtf(initial?.isEtfApplicable ?? false);
    setIsTax(initial?.isTaxApplicable ?? false);
  }, [open, initial]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        name: name.trim(), type, default_amount: defaultAmount,
        isEpfApplicable: isEpf, isEtfApplicable: isEtf, isTaxApplicable: isTax, is_active: initial?.is_active ?? true,
      });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit component' : 'New component'}</DialogTitle>
          <DialogDescription className="sr-only">{initial ? 'Edit a payroll allowance or deduction' : 'Add a payroll allowance or deduction'}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Name *</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Transport Allowance"
              aria-invalid={!!initial && !name.trim()} />
            {!!initial && !name.trim() && <InlineError>Enter a component name.</InlineError>}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Type</Label>
            <Select value={type} onValueChange={v => setType(v as PayrollComponentType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="allowance">Allowance</SelectItem>
                <SelectItem value="deduction">Deduction</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Default Amount</Label>
            <Input type="number" min={0} placeholder="e.g. 2500 (blank = 0)" value={defaultAmount ?? ''}
              aria-invalid={defaultAmount != null && !(defaultAmount >= 0)}
              onChange={e => setDefaultAmount(e.target.value === '' ? null : +e.target.value)} />
            {defaultAmount != null && !(defaultAmount >= 0) && <InlineError>Default amount can&apos;t be negative.</InlineError>}
            <p className="text-[10px] text-muted-foreground">Pre-fills the amount whenever this component is attached to an employee — always editable per employee afterward.</p>
          </div>
          <div className="space-y-2 pt-1">
            <label className="flex items-center justify-between cursor-pointer"><span className="text-sm text-foreground">EPF applicable</span><Switch checked={isEpf} onCheckedChange={setIsEpf} /></label>
            <label className="flex items-center justify-between cursor-pointer"><span className="text-sm text-foreground">ETF applicable</span><Switch checked={isEtf} onCheckedChange={setIsEtf} /></label>
            <label className="flex items-center justify-between cursor-pointer"><span className="text-sm text-foreground">Tax applicable</span><Switch checked={isTax} onCheckedChange={setIsTax} /></label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="flex-1" onClick={handleSave} disabled={saving || !name.trim() || (defaultAmount != null && !(defaultAmount >= 0))}><Save className="w-4 h-4" />{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
