'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarRange, Loader2, Plus, Trash2, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import { tenant } from '@/lib/firebase';
import { DEFAULT_DAYS, type WorkPattern, type Weekday } from '@/lib/workPatterns';
import {
  HOLIDAY_WORK_KINDS, NO_PREMIUM, type HolidayWorkKind, type HolidayWorkPolicy,
} from '@/lib/holidayWorkPolicy';
import {
  createHolidayWorkPolicy, createWorkPattern, deactivateWorkPattern, deleteHolidayWorkPolicy,
  getHolidayWorkPolicies, getWorkPatterns,
} from '@/services/workPatternService';
import { getAllUsers } from '@/services/userService';
import { getCompanies } from '@/services/companyService';
import { getWorkingPlaces } from '@/services/workingPlaceService';
import { getActiveRoles } from '@/services/roleService';
import { getEffectiveScheduleMap } from '@/services/workingScheduleService';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

/**
 * Working patterns and holiday-work premiums, for System Settings.
 *
 * English-only, deliberately. Every other section on this page is written the same way
 * (`'Maintenance'`, `'Expense float — voucher grouping…'`) because it is reachable only by a
 * System Admin, and adding sixty en/si/ta triples for a screen a handful of people open twice
 * a year buys nothing. Anything an ORDINARY employee can read — the calendar, the month
 * summary — is translated as usual.
 *
 * Implements the admin half of
 * `docs/superpowers/specs/2026-09-01-working-patterns-and-holiday-work-design.md`.
 */

const WEEKDAYS: { day: Weekday; label: string }[] = [
  { day: 1, label: 'Mon' }, { day: 2, label: 'Tue' }, { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' }, { day: 5, label: 'Fri' }, { day: 6, label: 'Sat' },
  { day: 0, label: 'Sun' },
];

const KIND_LABELS: Record<HolidayWorkKind, string> = {
  public: 'Public holiday',
  poya: 'Poya day',
  company: 'Company holiday',
  rest_day: 'Rest day',
  leave: 'Approved leave day',
};

type Named = { id: string; name?: string; label?: string };

function todayKey(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function WorkPatternSettings() {
  const [patterns, setPatterns] = useState<WorkPattern[] | null>(null);
  const [policies, setPolicies] = useState<HolidayWorkPolicy[] | null>(null);
  const [companies, setCompanies] = useState<Named[]>([]);
  const [places, setPlaces] = useState<Named[]>([]);
  const [roles, setRoles] = useState<Named[]>([]);
  const [users, setUsers] = useState<Array<{ company_id?: string; role?: string }>>([]);
  // epf -> working place NAME, so the affected-count can answer a location scope.
  const [placeByEpf, setPlaceByEpf] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // ── Draft pattern ──
  const [name, setName] = useState('');
  const [scope, setScope] = useState<WorkPattern['scope']>('company');
  const [scopeId, setScopeId] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(todayKey());
  const [isShift, setIsShift] = useState(false);
  const [days, setDays] = useState<Record<Weekday, number>>({ ...DEFAULT_DAYS });

  const load = useCallback(async () => {
    try {
      const [p, pol, co, wp, rl, us, sched] = await Promise.all([
        getWorkPatterns(true), getHolidayWorkPolicies(true), getCompanies(),
        getWorkingPlaces(), getActiveRoles(), getAllUsers(),
        // Which place each person is at TODAY, so the affected-count can answer a location
        // scope. Keyed by EPF, same source the calendar resolves a person's place through.
        getEffectiveScheduleMap(todayKey()),
      ]);
      setPatterns(p);
      setPolicies(pol);
      setCompanies(co as Named[]);
      setPlaces(wp as Named[]);
      setRoles(rl as Named[]);
      setUsers(us as never[]);
      setPlaceByEpf(Object.fromEntries(
        Object.entries(sched).map(([epf, rec]) => [epf, String(rec?.working_place ?? '')]),
      ));
    } catch (e) {
      console.error('[work-patterns] load failed', e);
      setPatterns([]);
      setPolicies([]);
      toast.error('Could not load working patterns.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * How many people this draft would actually govern.
   *
   * The spec asks for this explicitly, and it is the single most useful guard rail on the
   * screen: a company-scoped pattern silently restates the gauge, the "short day" flag and the
   * month summary for everyone it covers, and nothing else on a form conveys that.
   */
  const affected = useMemo(() => {
    if (scope !== 'company' && !scopeId) return null;
    return users.filter(u => {
      if (companyId && u.company_id && u.company_id !== companyId) return false;
      if (scope === 'company') return true;
      if (scope === 'location') {
        return (placeByEpf[String((u as { epf_number?: string }).epf_number ?? '')] ?? '')
          .trim().toLowerCase() === scopeId.trim().toLowerCase();
      }
      return (u.role ?? '').trim().toLowerCase() === scopeId.trim().toLowerCase();
    }).length;
  }, [users, scope, scopeId, companyId, placeByEpf]);

  const allZero = !isShift && WEEKDAYS.every(w => !days[w.day]);

  async function handleSave() {
    if (!name.trim()) { toast.error('Give the pattern a name.'); return; }
    if (!effectiveFrom) { toast.error('An effective-from date is required.'); return; }
    if (scope !== 'company' && !scopeId) { toast.error('Pick what this pattern applies to.'); return; }
    // A week of nothing is almost certainly a mistake, and it would mark every day a rest day
    // for everyone in scope. Refused rather than warned: the cost of being wrong is a month of
    // wrong reports for a whole company.
    if (allZero) { toast.error('Every day is zero — that would make every day a rest day.'); return; }

    setSaving(true);
    try {
      await createWorkPattern({
        name: name.trim(),
        company_id: companyId,
        scope,
        scope_id: scope === 'company' ? '' : scopeId,
        days: isShift ? {} : days,
        is_shift: isShift,
        effective_from: effectiveFrom,
        is_active: true,
      });
      toast.success('Pattern saved.');
      setName('');
      await load();
    } catch (e) {
      console.error('[work-patterns] save failed', e);
      toast.error('Could not save. Check you have permission to manage schedules.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRetire(id: string) {
    if (!confirm('Retire this pattern? Past months keep using it — it just stops applying from now on.')) return;
    try {
      await deactivateWorkPattern(id);
      await load();
      toast.success('Pattern retired.');
    } catch { toast.error('Could not retire that pattern.'); }
  }

  const scopeOptions = scope === 'location' ? places : scope === 'role' ? roles : [];

  return (
    <div className="space-y-4">
      {/* ── Patterns ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <CalendarRange className="w-4 h-4 text-primary" />
            </div>
            <div>
              <CardTitle className="text-sm">Working patterns</CardTitle>
              <CardDescription className="text-xs">
                Which weekdays are worked, and for how many hours. Most specific wins:
                role beats location beats company. Zero hours means a rest day.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {patterns === null ? (
            <div className="h-20 rounded-lg bg-muted animate-pulse" />
          ) : patterns.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-center">
              <p className="text-sm font-medium">No patterns configured</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Everyone is on the built-in week: 8 hours Monday to Friday, 4 on Saturday.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {patterns.map(p => (
                <li key={p.id} className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{p.name || '(unnamed)'}</span>
                      <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {p.scope}{p.scope_id ? `: ${p.scope_id}` : ''}
                      </span>
                      {!p.is_active && (
                        <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          retired
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      From {p.effective_from} ·{' '}
                      {p.is_shift
                        ? 'Shift roster decides each day'
                        : WEEKDAYS.map(w => `${w.label} ${p.days[w.day] ?? 0}h`).join(' · ')}
                    </p>
                  </div>
                  {p.is_active && (
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Retire pattern"
                      onClick={() => handleRetire(p.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* ── Draft ── */}
          <div className="space-y-3 rounded-lg border p-3">
            <p className="text-xs font-medium text-muted-foreground">New pattern</p>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="mb-1.5 block text-xs">Name</Label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="Six-day site crew" />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs">Effective from</Label>
                <Input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs">Company</Label>
                <Select value={companyId || '__any__'} onValueChange={v => setCompanyId(v === '__any__' ? '' : v)}>
                  <SelectTrigger><SelectValue placeholder="Any company" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__any__">Any company</SelectItem>
                    {companies.map(c => (
                      <SelectItem key={c.id} value={c.id}>{c.name ?? c.label ?? c.id}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="mb-1.5 block text-xs">Applies to</Label>
                <Select value={scope} onValueChange={v => { setScope(v as WorkPattern['scope']); setScopeId(''); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="company">Everyone in the company</SelectItem>
                    <SelectItem value="location">One working place</SelectItem>
                    <SelectItem value="role">One role</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {scope !== 'company' && (
                <div className="sm:col-span-2">
                  <Label className="mb-1.5 block text-xs">
                    {scope === 'location' ? 'Working place' : 'Role'}
                  </Label>
                  <Select value={scopeId || '__none__'} onValueChange={v => setScopeId(v === '__none__' ? '' : v)}>
                    <SelectTrigger><SelectValue placeholder="Pick one" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Pick one</SelectItem>
                      {scopeOptions.map(o => {
                        // A role pattern keys on the role NAME — AppUser.role is a display-name
                        // string and is the only foreign key to a role in this codebase.
                        // Both location and role key on the NAME: a working place is only
                        // ever reachable by name at read time (WorkingScheduleRecord stores
                        // the name), and AppUser.role is a display-name string.
                        const value = o.name ?? o.id;
                        return <SelectItem key={o.id} value={value}>{o.name ?? o.label ?? o.id}</SelectItem>;
                      })}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={isShift} onChange={e => setIsShift(e.target.checked)} />
              Shift workers — the roster decides each day, not a fixed week
            </label>

            {!isShift && (
              <div>
                <Label className="mb-1.5 block text-xs">Hours per day (0 = rest day)</Label>
                <div className="grid grid-cols-7 gap-1.5">
                  {WEEKDAYS.map(w => (
                    <div key={w.day} className="text-center">
                      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{w.label}</div>
                      <Input type="number" min={0} max={24} step={0.5} className="h-9 px-1 text-center"
                        value={days[w.day] ?? 0}
                        onChange={e => setDays(d => ({ ...d, [w.day]: Math.max(0, Number(e.target.value) || 0) }))} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Blast radius, before saving rather than after. */}
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {affected === null
                ? <span>Pick what this applies to and the count appears here.</span>
                : <span><strong className="font-semibold text-foreground">{affected}</strong> {affected === 1 ? 'person' : 'people'} would be governed by this pattern.</span>}
            </div>

            {allZero && (
              <p className="rounded-lg border border-dashed px-3 py-2 text-xs">
                Every day is zero. That would make every day a rest day for everyone in scope —
                saving is blocked until at least one day has hours.
              </p>
            )}

            <div className="flex justify-end">
              <Button type="button" onClick={handleSave} disabled={saving || allZero}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {saving ? 'Saving…' : 'Add pattern'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Premiums, only where the tenant actually pays them ── */}
      {tenant.features.holidayPayMultipliers && (
        <HolidayPolicySection policies={policies} onChanged={load} companies={companies} />
      )}
    </div>
  );
}

/**
 * Rendered only where `holidayPayMultipliers` is on — ABSENT, not disabled, everywhere else.
 * A visible multiplier control on a tenant that pays no premium states an entitlement that does
 * not exist, which is the same reason the calendar says "Extra hours" and never "Overtime".
 */
function HolidayPolicySection({
  policies, onChanged, companies,
}: {
  policies: HolidayWorkPolicy[] | null;
  onChanged: () => Promise<void>;
  companies: Named[];
}) {
  const [kind, setKind] = useState<HolidayWorkKind>('rest_day');
  const [multiplier, setMultiplier] = useState('1');
  const [companyId, setCompanyId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(todayKey());
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    const value = Number(multiplier);
    // Below 1 would CUT pay for having worked a holiday. The resolver refuses it too; this is
    // the message that explains why, since the resolver can only fall silently back to 1x.
    if (!Number.isFinite(value) || value < NO_PREMIUM) {
      toast.error('A multiplier must be at least 1 — 1 means no premium.');
      return;
    }
    setSaving(true);
    try {
      await createHolidayWorkPolicy({
        company_id: companyId, kind, multiplier: value,
        effective_from: effectiveFrom, is_active: true,
      });
      await onChanged();
      toast.success('Premium saved.');
    } catch (e) {
      console.error('[holiday-policy] save failed', e);
      toast.error('Could not save. Check you have permission to manage payroll config.');
    } finally { setSaving(false); }
  }

  async function handleDelete(id: string) {
    try { await deleteHolidayWorkPolicy(id); await onChanged(); }
    catch { toast.error('Could not remove that premium.'); }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <CalendarRange className="w-4 h-4 text-primary" />
          </div>
          <div>
            <CardTitle className="text-sm">Holiday and rest-day premiums</CardTitle>
            <CardDescription className="text-xs">
              What working one of these days is worth. 1&times; means no premium. Public holidays
              and Poya days fall back to the payroll settings when nothing is set here.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {policies === null ? (
          <div className="h-16 rounded-lg bg-muted animate-pulse" />
        ) : policies.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nothing configured — every kind pays 1&times;, except public holidays and Poya days,
            which use the payroll settings.
          </p>
        ) : (
          <ul className="space-y-2">
            {policies.map(p => (
              <li key={p.id} className="flex items-center gap-3 rounded-lg border p-3">
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium">{KIND_LABELS[p.kind] ?? p.kind}</span>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {p.multiplier}&times; from {p.effective_from}
                    {p.company_id ? ` · ${p.company_id}` : ' · any company'}
                  </p>
                </div>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove premium"
                  onClick={() => handleDelete(p.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <Label className="mb-1.5 block text-xs">Day kind</Label>
            <Select value={kind} onValueChange={v => setKind(v as HolidayWorkKind)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {HOLIDAY_WORK_KINDS.map(k => (
                  <SelectItem key={k} value={k}>{KIND_LABELS[k]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1.5 block text-xs">Multiplier</Label>
            <Input type="number" min={1} step={0.5} value={multiplier}
              onChange={e => setMultiplier(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1.5 block text-xs">From</Label>
            <Input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} />
          </div>
          <div className="sm:col-span-3">
            <Label className="mb-1.5 block text-xs">Company</Label>
            <Select value={companyId || '__any__'} onValueChange={v => setCompanyId(v === '__any__' ? '' : v)}>
              <SelectTrigger><SelectValue placeholder="Any company" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__any__">Any company</SelectItem>
                {companies.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.name ?? c.label ?? c.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end justify-end">
            <Button type="button" onClick={handleAdd} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
