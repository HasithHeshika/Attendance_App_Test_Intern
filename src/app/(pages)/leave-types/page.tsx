'use client';
import { useState, useEffect } from 'react';
import { CalendarDays, Plus, Edit2, Save, ToggleLeft, ToggleRight, CheckCircle2, Wallet, SlidersHorizontal } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { tenant } from '@/lib/firebase';
import { useUserCapabilities, useRoles } from '@/store/rolesStore';
import { roleCan } from '@/lib/permissions';
import { getLeaveTypes, createLeaveType, updateLeaveType } from '@/services/leaveService';
import type { LeaveType } from '@/lib/types';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/ui/empty-state';
import { useT } from '@/store/appStore';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { PageHeaderSkeleton, ListSkeleton, StatCardsSkeleton } from '@/components/ui/Skeleton';
import { PageTransition, Reveal, Stagger, StaggerItem, MotionCard } from '@/components/ui/motion';
import ManageHolidaysDialog from '@/components/ManageHolidaysDialog';
import InlineError from '@/components/InlineError';

// Numeric quota / backdate fields are held as strings so the box can go transiently empty
// (Backspace on a lone "0") and so a pasted "-14" / "1e5" is stripped as-typed rather than
// silently coerced and saved. Digits only — no sign, no decimal, no exponent.
const digitsOnly = (v: string) => v.replace(/\D/g, '');

const MAX_QUOTA = 365;
const MAX_BACKDATE = 90;
// '' is allowed (saved as 0); anything left is digits-only, so the only real failure is
// exceeding the field's ceiling.
const rangeError = (v: string, max: number): string =>
  v.trim() !== '' && Number(v) > max ? `Enter a value between 0 and ${max}.` : '';

const empty = {
  name: '',
  default_quota: '14',
  quotas: {} as Record<string, string>,  // role name → days, '' = inherit the default
  is_paid: true,
  requires_reason: false,
  allow_backdate_days: '0',
  allow_unpaid_choice: false,
  allow_direct_apply: true,
  is_trainee_accruable: false,
  excluded_from_quota: false,
  is_active: true,
};

function LeaveTypesAdminContent() {
  const { user }       = useAuthStore();
  const caps           = useUserCapabilities();
  const { roles }      = useRoles();
  const tr             = useT();
  // "Allow Users to Direct Apply" is a Southern Lanka-only policy — hide the toggle elsewhere.
  const isSouthernlanka = tenant.id === 'southernlanka';
  // Only employees take leave, so only employee roles get a quota.
  const employeeRoles  = roles
    .filter(r => r.is_employee && r.is_active !== false)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const [types,   setTypes]   = useState<LeaveType[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm,setShowForm]= useState(false);
  const [editId,  setEditId]  = useState<string | null>(null);
  const [form,    setForm]    = useState(empty);
  const [saving,  setSaving]  = useState(false);
  // The "name required" message only appears after a save attempt; out-of-range number
  // errors show live (the user had to type an over-ceiling value to trigger them).
  const [triedSave, setTriedSave] = useState(false);

  // `silent` re-fetches without flipping the full-page skeleton, so a mutation updates the
  // list in place instead of remounting it (which replays the entrance animations — the
  // "whole page resets" effect).
  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try { setTypes(await getLeaveTypes({ includeInactive: true })); }
    catch (e) { console.error(e); }
    finally   { if (!silent) setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => { setForm({ ...empty, quotas: {} }); setEditId(null); setTriedSave(false); setShowForm(true); };
  const openEdit   = (t: LeaveType) => {
    setTriedSave(false);
    const hasMap = !!t.quotas && Object.keys(t.quotas).length > 0;
    const def = t.annual_quota ?? t.quota_nontech ?? t.quota_tech ?? 0;
    // Prefill per-role overrides. For legacy (tech/non-tech) types, surface the split as
    // explicit overrides only where a role differs from the default, so nothing changes silently.
    const quotas: Record<string, string> = {};
    for (const r of employeeRoles) {
      const explicit = t.quotas?.[r.name];
      if (explicit != null) { quotas[r.name] = String(explicit); continue; }
      if (!hasMap) {
        const legacy = roleCan(r.name, 'can_approve', roles)
          ? (t.quota_nontech ?? t.annual_quota)
          : (t.quota_tech ?? t.annual_quota);
        if (legacy != null && legacy !== def) { quotas[r.name] = String(legacy); continue; }
      }
      quotas[r.name] = ''; // inherit default
    }
    setForm({
      name: t.name,
      default_quota: String(def),
      quotas,
      is_paid: t.is_paid,
      requires_reason:     t.requires_reason ?? false,
      allow_backdate_days: String(t.allow_backdate_days ?? 0),
      allow_unpaid_choice: t.allow_unpaid_choice ?? false,
      allow_direct_apply: t.allow_direct_apply ?? true,
      is_trainee_accruable: t.is_trainee_accruable ?? false,
      excluded_from_quota: t.excluded_from_quota ?? false,
      is_active: t.is_active,
    });
    setEditId(t.id); setShowForm(true);
  };

  // Live form validation — negatives can't be typed (digitsOnly strips them), so the only
  // failures are a missing/duplicate name or an over-ceiling number. The Save button and the
  // inline messages both read these.
  const nameTrimmed = form.name.trim();
  // Case-insensitive uniqueness across ALL leave types (active + inactive — `types` now holds
  // both), excluding the one being edited.
  const nameDupe =
    !!nameTrimmed &&
    types.some(x => x.id !== editId && x.name.trim().toLowerCase() === nameTrimmed.toLowerCase());
  const nameError = !nameTrimmed
    ? tr.enterLeaveTypeName
    : nameDupe
      ? 'A leave type with this name already exists'
      : '';
  const defaultQuotaError = rangeError(form.default_quota, MAX_QUOTA);
  const backdateError = rangeError(form.allow_backdate_days, MAX_BACKDATE);
  const roleQuotaInvalid = employeeRoles.some(r => rangeError(form.quotas[r.name] ?? '', MAX_QUOTA));
  const formInvalid = !!nameError || !!defaultQuotaError || !!backdateError || roleQuotaInvalid;

  const handleSave = async () => {
    setTriedSave(true);
    if (formInvalid) { toast.error(nameError || tr.failedToSave); return; }
    setSaving(true);
    try {
      // Only non-blank inputs become overrides; blanks inherit the default. Clamp to the
      // field ceiling defensively even though the UI already blocks out-of-range saves.
      const quotas: Record<string, number> = {};
      Object.entries(form.quotas).forEach(([role, v]) => {
        const s = String(v).trim();
        if (s !== '' && !Number.isNaN(Number(s))) quotas[role] = Math.min(MAX_QUOTA, Math.max(0, Number(s)));
      });
      const payload = {
        name:                form.name.trim(),
        annual_quota:        Math.min(MAX_QUOTA, Math.max(0, Number(form.default_quota) || 0)),
        quotas,
        is_paid:             form.is_paid,
        requires_reason:     form.requires_reason,
        allow_backdate_days: Math.min(MAX_BACKDATE, Math.max(0, Number(form.allow_backdate_days) || 0)),
        allow_unpaid_choice: form.allow_unpaid_choice,
        // Not tenant-gated, deliberately: what it describes is a property of the leave type, not
        // of an organisation. It is off unless somebody ticks it, so a tenant that never opens
        // this toggle is untouched — the same shape as a feature flag, without a tenant check.
        excluded_from_quota: form.excluded_from_quota,
        // Southern Lanka-only fields — never persist them onto other tenants' leave-type docs
        // (they have no toggle for them, and nothing outside SL reads them).
        ...(isSouthernlanka ? {
          allow_direct_apply:   form.allow_direct_apply,
          is_trainee_accruable: form.is_trainee_accruable,
        } : {}),
        is_active:           form.is_active,
      };
      if (editId) {
        await updateLeaveType(editId, payload as Partial<LeaveType>);
        toast.success(tr.leaveTypeUpdated);
      } else {
        await createLeaveType(payload as Omit<LeaveType, 'id'>);
        toast.success(tr.leaveTypeCreated);
      }
      setShowForm(false);
      await load(true);
    } catch { toast.error(tr.failedToSave); }
    finally  { setSaving(false); }
  };

  const toggleActive = async (t: LeaveType) => {
    try {
      await updateLeaveType(t.id, { is_active: !t.is_active });
      toast.success(t.is_active ? tr.deactivatedWord : tr.activatedWord);
      await load(true);
    } catch { toast.error(tr.failedGeneric); }
  };

  if (user?.capabilities && !caps.can_manage_leaves) return <div className="text-muted-foreground p-10 text-center">{tr.noAccessSection}</div>;

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <StatCardsSkeleton count={4} />
        <ListSkeleton rows={6} />
      </div>
    );
  }

  // Derived summary metrics (presentation only).
  const activeCount   = types.filter(t => t.is_active).length;
  const paidCount     = types.filter(t => t.is_paid).length;
  const overrideCount = types.filter(t => t.quotas && Object.keys(t.quotas).length > 0).length;

  return (
    <PageTransition className="space-y-6">
      <PageHeader
        title={tr.leaveTypesTitle}
        description={tr.typesConfigured.replace('{n}', String(types.length))}
        icon={CalendarDays}
        actions={
          <>
            <ManageHolidaysDialog />
            <Button onClick={openCreate}>
              <Plus className="w-4 h-4" />{tr.addType}
            </Button>
          </>
        }
      />

      {types.length === 0 ? (
        <Reveal>
          <Card>
            <EmptyState
              icon={CalendarDays}
              title={tr.noLeaveTypesYet}
              description={tr.noLeaveTypesDesc}
              action={
                <Button onClick={openCreate}>
                  <Plus className="w-4 h-4" />{tr.addType}
                </Button>
              }
            />
          </Card>
        </Reveal>
      ) : (
        <>
          {/* KPI summary row */}
          <Stagger className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StaggerItem>
              <StatCard label={tr.totalTypes} value={types.length} icon={CalendarDays} tone="brand" hint={tr.configuredPolicies} />
            </StaggerItem>
            <StaggerItem>
              <StatCard label={tr.statusActive} value={activeCount} icon={CheckCircle2} tone="success" hint={`${types.length - activeCount} ${tr.inactiveLower}`} />
            </StaggerItem>
            <StaggerItem>
              <StatCard label={tr.paidWord} value={paidCount} icon={Wallet} tone="primary" hint={tr.paidByDefaultHint} />
            </StaggerItem>
            <StaggerItem>
              <StatCard label={tr.withOverrides} value={overrideCount} icon={SlidersHorizontal} tone="brand" hint={tr.perRoleQuotas} />
            </StaggerItem>
          </Stagger>

          {/* Primary content — the list of leave types */}
          <Reveal delay={0.05}>
            <Card className="p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold tracking-tight text-foreground">{tr.allLeaveTypes}</h2>
                <span className="text-xs text-muted-foreground">{types.length} {tr.totalWord}</span>
              </div>
              <Stagger className="space-y-2.5">
                {types.map(t => (
                  <StaggerItem key={t.id}>
                    <MotionCard className="rounded-xl">
                      <Card className={`flex items-center gap-4 p-4 ${!t.is_active ? 'opacity-60' : ''}`}>
                        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                          <CalendarDays className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold text-foreground">{t.name}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            {/* A quota figure on a type that is explicitly not counted is a
                                contradiction the row has no space to explain, so the badge
                                below replaces it. The stored numbers are kept, untouched, for
                                whenever the flag comes back off. */}
                            {!t.excluded_from_quota && (
                              <>
                                <span className="text-xs text-muted-foreground">
                                  {t.annual_quota ?? t.quota_nontech ?? t.quota_tech ?? 0} {tr.daysYrDefault}
                                </span>
                                {t.quotas && Object.keys(t.quotas).length > 0 && (
                                  <Badge variant="default">
                                    {tr.roleOverridesTpl.replace('{n}', String(Object.keys(t.quotas).length))}
                                  </Badge>
                                )}
                              </>
                            )}
                            {t.excluded_from_quota && (
                              <Badge variant="outline">{tr.notCountedInQuota}</Badge>
                            )}
                            <Badge variant={t.is_paid ? 'success' : 'muted'}>
                              {t.is_paid ? tr.paidWord : tr.unpaidWord}
                            </Badge>
                            {t.allow_unpaid_choice && (
                              <Badge variant="brand">{tr.paidUnpaidChoice}</Badge>
                            )}
                            {(t.allow_backdate_days ?? 0) > 0 && (
                              <Badge variant="brand">{tr.backdateBadge.replace('{n}', String(t.allow_backdate_days))}</Badge>
                            )}
                            {t.requires_reason && (
                              <Badge variant="outline">{tr.reasonRequiredBadge}</Badge>
                            )}
                            {t.is_trainee_accruable && (
                              <Badge variant="outline" className="gap-1">
                                <SlidersHorizontal className="h-3 w-3" />{tr.traineeAccrualBadge}
                              </Badge>
                            )}
                            {!t.is_active && (
                              <Badge variant="muted">{tr.inactiveWord}</Badge>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-2">
                          <Button variant="outline" size="icon-sm" onClick={() => openEdit(t)} aria-label={tr.editLabel}>
                            <Edit2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="outline" size="icon-sm" onClick={() => toggleActive(t)} aria-label={t.is_active ? tr.deactivateLabel : tr.activateLabel}>
                            {t.is_active ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
                          </Button>
                        </div>
                      </Card>
                    </MotionCard>
                  </StaggerItem>
                ))}
              </Stagger>
            </Card>
          </Reveal>
        </>
      )}

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editId ? tr.editLeaveType : tr.newLeaveType}</DialogTitle>
            <DialogDescription className="sr-only">{tr.configureLeaveType}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {tr.nameWord} <span className="text-destructive">*</span>
              </Label>
              <Input
                type="text"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder={tr.egLeaveTypeName}
                aria-invalid={(triedSave || nameDupe) && !!nameError}
              />
              {(triedSave || nameDupe) && <InlineError>{nameError}</InlineError>}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{tr.defaultQuota}</Label>
              <Input
                type="number" inputMode="numeric" min={0} max={MAX_QUOTA} value={form.default_quota}
                onChange={e => setForm(f => ({ ...f, default_quota: digitsOnly(e.target.value) }))}
                aria-invalid={!!defaultQuotaError}
              />
              <InlineError>{defaultQuotaError}</InlineError>
              <p className="text-[11px] text-muted-foreground">{tr.defaultQuotaHint}</p>
            </div>

            {/* Per-role quota overrides */}
            <div className="space-y-2 pt-3 border-t border-border">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{tr.perRoleQuota}</div>
              <p className="text-[11px] text-muted-foreground -mt-1">
                {tr.perRoleQuotaHintA}<span className="text-foreground font-semibold">{form.default_quota}</span>{tr.perRoleQuotaHintB}
              </p>
              {employeeRoles.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">{tr.noEmployeeRoles}</p>
              ) : (
                <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                  {employeeRoles.map(r => (
                    <div key={r.id} className="flex items-center gap-3">
                      <span className="text-sm text-muted-foreground flex-1 truncate">{r.name}</span>
                      <Input
                        type="number" inputMode="numeric" min={0} max={MAX_QUOTA}
                        value={form.quotas[r.name] ?? ''}
                        placeholder={form.default_quota}
                        onChange={e => setForm(f => ({ ...f, quotas: { ...f.quotas, [r.name]: digitsOnly(e.target.value) } }))}
                        aria-invalid={!!rangeError(form.quotas[r.name] ?? '', MAX_QUOTA)}
                        className="w-20 text-center"
                      />
                    </div>
                  ))}
                </div>
              )}
              {roleQuotaInvalid && <InlineError>Enter a value between 0 and {MAX_QUOTA} for every role.</InlineError>}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {tr.backdatingAllowed} <span className="text-muted-foreground/70 normal-case font-normal">{tr.medicalEq14}</span>
              </Label>
              <Input
                type="number" inputMode="numeric" min={0} max={MAX_BACKDATE} value={form.allow_backdate_days}
                onChange={e => setForm(f => ({ ...f, allow_backdate_days: digitsOnly(e.target.value) }))}
                aria-invalid={!!backdateError}
              />
              <InlineError>{backdateError}</InlineError>
              <p className="text-[11px] text-muted-foreground">{tr.backdatingHint}</p>
            </div>

            <div className="space-y-2.5">
              {[
                { key: 'is_paid' as const,             label: tr.paidByDefaultOpt },
                { key: 'allow_unpaid_choice' as const, label: tr.allowPaidUnpaidChoice },
                { key: 'requires_reason' as const,     label: tr.reasonRequiredBadge },
                { key: 'excluded_from_quota' as const, label: tr.notCountedInQuota },
                ...(isSouthernlanka
                  ? [
                      { key: 'allow_direct_apply' as const,   label: tr.allowDirectApply },
                      { key: 'is_trainee_accruable' as const, label: tr.isTraineeAccruable },
                    ]
                  : []),
                { key: 'is_active' as const,           label: tr.statusActive },
              ].map(opt => (
                <label key={opt.key} className="flex items-center gap-3 cursor-pointer">
                  <Switch
                    checked={form[opt.key]}
                    onCheckedChange={() => setForm(f => ({ ...f, [opt.key]: !f[opt.key] }))}
                  />
                  <span className="text-sm text-foreground">{opt.label}</span>
                </label>
              ))}
              {/* The one toggle in this list whose effect isn't readable from its label: it
                  changes what the balance MEANS, not just what is shown. Spelled out only while
                  it is on, so it arrives as a consequence of the choice rather than as noise
                  above it. */}
              {form.excluded_from_quota && (
                <p className="text-[11px] leading-snug text-muted-foreground">{tr.notCountedInQuotaHint}</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" className="flex-1" onClick={() => setShowForm(false)}>{tr.cancel}</Button>
            <Button className="flex-1" onClick={handleSave} disabled={saving || formInvalid}>
              <Save className="w-4 h-4" />{saving ? tr.saving : tr.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}

export default function LeaveTypesAdminPage() {
  return <LeaveTypesAdminContent />;
}
