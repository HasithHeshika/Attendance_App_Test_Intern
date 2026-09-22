'use client';
import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Portal from '@/components/Portal';
import { Building2, Plus, X, Save, UserPlus, UserMinus, MapPin, ChevronRight, Users, ShieldCheck, Palette, Image as ImageIcon } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities, useRoles } from '@/store/rolesStore';
import { useT } from '@/store/appStore';
import { tenant } from '@/lib/firebase';
import { roleCan } from '@/lib/permissions';
import { getCompanies, createCompany, updateCompany, addSupervisorToCompany, removeSupervisorFromCompany } from '@/services/companyService';
import { getAllUsers } from '@/services/userService';
import Select from '@/components/Select';
import InlineError from '@/components/InlineError';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeaderSkeleton, StatCardsSkeleton, ListSkeleton } from '@/components/ui/Skeleton';
import { PageTransition, Reveal, Stagger, StaggerItem, MotionCard } from '@/components/ui/motion';
import type { Company, AppUser } from '@/lib/types';

// A company logo is optional, but if given it must be a real URL — otherwise the avatar
// just renders a broken-image icon (the actual reported bug: "hello" was accepted). Any
// absolute http(s) URL or data:image/… URI passes; an explicit image file extension is
// NOT required, so Firebase/S3 storage links with query params (…/logo?alt=media&token=…)
// and extension-less CDN URLs are all fine. Blank passes (it's optional).
function isValidLogoUrl(value: string): boolean {
  const s = value.trim();
  if (!s) return true;
  if (/^data:image\//i.test(s)) return true;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function CompaniesAdminContent() {
  const { user } = useAuthStore();
  const caps = useUserCapabilities();
  const { roles } = useRoles();
  const t = useT();
  // Southern Lanka only — granular Manage/View company capability instead of the blanket
  // can_manage_users every other tenant still uses here (see the isSouthernlanka gate on
  // roles/page.tsx).
  const isSouthernlanka = tenant.id === 'southernlanka';
  const canManage = isSouthernlanka ? caps.can_manage_company : caps.can_manage_users;
  const canView = isSouthernlanka ? (canManage || caps.can_view_company) : canManage;
  const [companies,  setCompanies]  = useState<Company[]>([]);
  const [allUsers,   setAllUsers]   = useState<AppUser[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName,    setNewName]    = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [newLogo,    setNewLogo]    = useState('');
  const [newAccent,  setNewAccent]  = useState('');
  const [saving,     setSaving]     = useState(false);
  // Surface the "name is required" error only once the user has tried to submit —
  // a fresh modal shouldn't open pre-flagged red.
  const [triedCreate, setTriedCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [supToAdd,   setSupToAdd]   = useState('');
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [logoDraft,     setLogoDraft]     = useState('');
  const [accentDraft,   setAccentDraft]   = useState('');
  const [nameDraft,     setNameDraft]     = useState('');
  const [addressDraft,  setAddressDraft]  = useState('');
  const [savingDetails, setSavingDetails] = useState(false);

  // `silent` re-fetches WITHOUT flipping the full-page skeleton. A mutation must use it:
  // toggling `loading` unmounts the content, so on remount the PageTransition/Reveal/Stagger
  // entrance animations replay — which looks like the whole page "resetting" after every change.
  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [c, u] = await Promise.all([getCompanies(), getAllUsers()]);
      setCompanies(c);
      setAllUsers(u);
    } catch (e) { console.error(e); }
    finally    { if (!silent) setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  // Dismissing the "New Company" modal (Cancel / X / after a successful create) always
  // clears every field, so the next "Add Company" opens a fresh form.
  const closeCreate = () => {
    setShowCreate(false);
    setNewName(''); setNewAddress(''); setNewLogo(''); setNewAccent('');
    setTriedCreate(false);
  };

  const newNameError = !newName.trim() ? t.enterCompanyName : '';
  const newLogoError = !isValidLogoUrl(newLogo) ? t.invalidImageUrl : '';
  const createDisabled = saving || !!newNameError || !!newLogoError;
  // In the edit modal, only flag a CHANGED logo value — a company whose stored URL predates
  // this check (e.g. an extension-less storage link) must never block unrelated edits.
  const selectedCompany = selectedId ? companies.find(x => x.id === selectedId) : undefined;
  const logoDraftError =
    logoDraft.trim() !== (selectedCompany?.logo_url ?? '') && !isValidLogoUrl(logoDraft)
      ? t.invalidImageUrl
      : '';

  const handleCreate = async () => {
    setTriedCreate(true);
    if (newNameError) { toast.error(newNameError); return; }
    if (newLogoError) { toast.error(newLogoError); return; }
    setSaving(true);
    try {
      await createCompany(newName.trim(), newAddress.trim(), newLogo.trim(), newAccent.trim());
      toast.success(t.companyCreated);
      closeCreate();
      await load(true);
    } catch { toast.error(t.failedGeneric); }
    finally  { setSaving(false); }
  };

  // Seed the detail editors whenever a company detail opens.
  useEffect(() => {
    const c = companies.find(x => x.id === selectedId);
    setLogoDraft(c?.logo_url ?? '');
    setAccentDraft(c?.accent_color ?? '');
    setNameDraft(c?.name ?? '');
    setAddressDraft(c?.address ?? '');
  }, [selectedId, companies]);

  const saveDetails = async (company: Company) => {
    if (!nameDraft.trim()) { toast.error(t.enterCompanyName); return; }
    if (logoDraftError) { toast.error(logoDraftError); return; }
    setSavingDetails(true);
    try {
      await updateCompany(company.id, {
        name:         nameDraft.trim(),
        address:      addressDraft.trim(),
        logo_url:     logoDraft.trim(),
        accent_color: accentDraft.trim(),
      });
      toast.success(t.companySaved);
      await load(true);
    } catch { toast.error(t.failedGeneric); }
    finally  { setSavingDetails(false); }
  };

  const closeModal = () => { setSelectedId(null); setSupToAdd(''); setRoleFilter(null); };

  const addSupervisor = async (companyId: string, epf: string) => {
    try {
      await addSupervisorToCompany(companyId, epf);
      toast.success(t.supervisorAdded);
      await load(true);
    } catch { toast.error(t.failedGeneric); }
  };

  const removeSupervisor = async (companyId: string, epf: string) => {
    try {
      await removeSupervisorFromCompany(companyId, epf);
      toast.success(t.supervisorRemoved);
      await load(true);
    } catch { toast.error(t.failedGeneric); }
  };

  const supervisorCandidates = allUsers.filter(u =>
    roleCan(u.role, 'can_approve', roles) && u.is_active
  );

  if (user?.capabilities && !canView) return <div className="text-muted-foreground p-10 text-center">{t.noAccessSection}</div>;
  if (loading) return (
    <div className="space-y-6">
      <PageHeaderSkeleton />
      <StatCardsSkeleton count={3} />
      <ListSkeleton rows={6} />
    </div>
  );

  // Page-level metrics for the KPI row.
  const activeEmployees = allUsers.filter(u => u.company_id && u.is_active !== false);
  const totalSupervisors = companies.reduce((sum, c) => sum + c.supervisor_epfs.length, 0);

  return (
    <PageTransition className="space-y-6">
      <PageHeader
        title={t.companiesTitle}
        description={t.companiesDesc}
        icon={Building2}
        actions={
          canManage && (
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4" />{t.addCompany}
            </Button>
          )
        }
      />

      {companies.length === 0 ? (
        <Reveal>
          <Card>
            <EmptyState
              icon={Building2}
              title={t.noCompaniesYet}
              description={t.noCompaniesDesc}
              action={
                canManage && (
                  <Button onClick={() => setShowCreate(true)}>
                    <Plus className="w-4 h-4" />{t.addCompany}
                  </Button>
                )
              }
            />
          </Card>
        </Reveal>
      ) : (
        <>
          {/* ── KPI summary row ── */}
          <Stagger className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <StaggerItem>
              <StatCard label={t.companiesTitle} value={companies.length} icon={Building2} tone="primary" hint={t.activeOrganizations} />
            </StaggerItem>
            <StaggerItem>
              <StatCard label={t.employeesCap} value={activeEmployees.length} icon={Users} tone="brand" hint={t.assignedToCompany} />
            </StaggerItem>
            <StaggerItem>
              <StatCard label={t.supervisorsCap} value={totalSupervisors} icon={ShieldCheck} tone="success" hint={t.immediateSupervisorsHint} />
            </StaggerItem>
          </Stagger>

          {/* ── Primary content: company directory ── */}
          <Reveal delay={0.05}>
            <Card className="overflow-hidden">
              <CardHeader className="border-b border-border">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Building2 className="w-4 h-4 text-primary" /> {t.companyDirectory}
                </CardTitle>
              </CardHeader>
              <Stagger className="divide-y divide-border">
                {companies.map(c => {
                  const companyEmployees = allUsers.filter(u => u.company_id === c.id && u.is_active !== false);
                  const supervisorUsers = c.supervisor_epfs
                    .map(epf => allUsers.find(u => u.epf_number === epf))
                    .filter(Boolean) as AppUser[];

                  return (
                    <StaggerItem key={c.id}>
                      <MotionCard lift={false}>
                        <button onClick={() => setSelectedId(c.id)}
                          className="w-full text-left p-4 flex items-center gap-4 hover:bg-accent transition-colors">
                          <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden ${c.accent_color ? '' : 'bg-brand/10'}`}
                            style={c.accent_color ? { backgroundColor: `color-mix(in srgb, ${c.accent_color} 14%, transparent)` } : undefined}>
                            {c.logo_url
                              ? <img src={c.logo_url} alt="" className="w-full h-full object-contain" />
                              : <Building2 className={`w-5 h-5 ${c.accent_color ? '' : 'text-brand'}`} style={c.accent_color ? { color: c.accent_color } : undefined} />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold text-foreground truncate">{c.name}</div>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                              {c.address ? (
                                <><MapPin className="w-3 h-3 flex-shrink-0" /><span className="truncate">{c.address}</span></>
                              ) : (
                                <span className="text-muted-foreground">{t.noAddress}</span>
                              )}
                            </div>
                            <div className="text-[11px] text-muted-foreground mt-0.5">{companyEmployees.length} {t.employeesWord} · {supervisorUsers.length} {t.immediateSupervisorsShort}</div>
                          </div>
                          <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        </button>
                      </MotionCard>
                    </StaggerItem>
                  );
                })}
              </Stagger>
            </Card>
          </Reveal>
        </>
      )}

      {/* ── Company detail modal ── Portalled to <body>: a `fixed inset-0` overlay nested
          inside PageTransition (whose enter animation leaves an active transform in place)
          gets its containing block hijacked to PageTransition's own box instead of the
          viewport, so the dimmed backdrop only covers a band in the middle of the screen. */}
      <Portal>
      <AnimatePresence>
        {selectedId && (() => {
          const c = companies.find(x => x.id === selectedId);
          if (!c) return null;
          const companyEmployees = allUsers.filter(u => u.company_id === c.id && u.is_active !== false);
          // One stat tile per employee role that has at least one member in this company.
          // Decorative tiles rotate through the three major colours only (primary / brand / success).
          const roleColors = [
            { color: 'text-primary', bg: 'bg-primary/10 border-primary/20', active: 'ring-2 ring-primary/50' },
            { color: 'text-brand',   bg: 'bg-brand/10 border-brand/20',     active: 'ring-2 ring-brand/50' },
            { color: 'text-success', bg: 'bg-success/10 border-success/20', active: 'ring-2 ring-success/50' },
          ];
          const roleStats = roles
            .filter(r => r.is_active !== false && r.is_employee)
            .map((r, i) => ({
              key: r.name,
              label: r.name,
              count: companyEmployees.filter(u => u.role === r.name).length,
              ...roleColors[i % roleColors.length],
            }))
            .filter(s => s.count > 0);
          const supervisorUsers = c.supervisor_epfs
            .map(epf => allUsers.find(u => u.epf_number === epf))
            .filter(Boolean) as AppUser[];
          const availableSupervisors = supervisorCandidates.filter(
            s => s.company_id === c.id && !c.supervisor_epfs.includes(s.epf_number)
          );

          return (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={closeModal}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4">
              <motion.div initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }}
                onClick={e => e.stopPropagation()}
                className="w-full sm:max-w-lg bg-card border border-border rounded-t-2xl sm:rounded-xl shadow-popover overflow-hidden max-h-[92vh] sm:max-h-[88vh] flex flex-col">

                {/* Header — tinted with the company's accent colour (live as you edit) */}
                <div className={`relative px-5 pt-6 pb-5 flex-shrink-0 border-b border-border ${accentDraft.trim() ? '' : 'bg-muted'}`}
                  style={accentDraft.trim() ? { background: `linear-gradient(to bottom, color-mix(in srgb, ${accentDraft.trim()} 22%, transparent), transparent)` } : undefined}>
                  <div className="sm:hidden w-10 h-1 rounded-full bg-border mx-auto mb-3" />
                  <button onClick={closeModal}
                    className="absolute top-4 right-4 w-8 h-8 rounded-md hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors">
                    <X className="w-4 h-4" />
                  </button>
                  <div className="flex flex-col items-center text-center">
                    <div className={`w-16 h-16 rounded-xl flex items-center justify-center mb-3 overflow-hidden ${accentDraft.trim() ? '' : 'bg-brand/10'}`}
                      style={accentDraft.trim() ? { backgroundColor: `color-mix(in srgb, ${accentDraft.trim()} 18%, transparent)` } : undefined}>
                      {c.logo_url
                        ? <img src={c.logo_url} alt="" className="w-full h-full object-contain" />
                        : <Building2 className={`w-8 h-8 ${accentDraft.trim() ? '' : 'text-brand'}`} style={accentDraft.trim() ? { color: accentDraft.trim() } : undefined} />}
                    </div>
                    <h2 className="text-lg font-bold text-foreground">{c.name}</h2>
                    {c.address && (
                      <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1 justify-center">
                        <MapPin className="w-3 h-3 flex-shrink-0" /> {c.address}
                      </p>
                    )}
                  </div>
                </div>

                {/* Scrollable body */}
                <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
                  {/* Role counts — click to view list */}
                  <div>
                    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2 flex items-center gap-1.5">
                      <Users className="w-3 h-3" /> {t.employeesCap} ({companyEmployees.length})
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {roleStats.map(s => (
                        <button key={s.key}
                          onClick={() => setRoleFilter(roleFilter === s.key ? null : s.key)}
                          className={`rounded-md border p-3 text-center transition-all ${s.bg} ${roleFilter === s.key ? s.active : 'hover:brightness-110'}`}>
                          <div className={`text-2xl font-bold ${s.color}`}>{s.count}</div>
                          <div className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium mt-0.5">{s.label}</div>
                        </button>
                      ))}
                    </div>

                    {/* Employee list for selected role */}
                    {roleFilter && (
                      <div className="mt-3 space-y-1.5">
                        {companyEmployees.filter(u => u.role === roleFilter).length === 0 ? (
                          <div className="text-xs text-muted-foreground py-2 px-1">{t.noWord} {roleFilter} {t.employeesWord}</div>
                        ) : companyEmployees.filter(u => u.role === roleFilter).map(u => (
                          <div key={u.epf_number} className="flex items-center gap-3 px-3 py-2 rounded-md bg-muted border border-border">
                            <div className="w-7 h-7 rounded-md bg-card border border-border flex items-center justify-center text-[11px] font-bold text-muted-foreground flex-shrink-0">
                              {u.first_name.charAt(0)}{u.last_name.charAt(0)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-foreground truncate">{u.display_name}</div>
                              <div className="text-[11px] text-muted-foreground">{u.epf_number}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Company details — edit name, address & logo */}
                  <div>
                    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2 flex items-center gap-1.5">
                      <Building2 className="w-3 h-3" /> {t.companyDetails}
                    </div>
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="edit-name">{t.companyName} <span className="text-destructive">*</span></Label>
                        <Input id="edit-name" type="text" value={nameDraft} onChange={e => setNameDraft(e.target.value)}
                          placeholder={t.egCompanyName} disabled={!canManage} aria-invalid={!nameDraft.trim()} />
                        {!nameDraft.trim() && <InlineError>{t.enterCompanyName}</InlineError>}
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="edit-address">{t.locationAddress}</Label>
                        <Textarea id="edit-address" rows={2} value={addressDraft} onChange={e => setAddressDraft(e.target.value)}
                          placeholder={t.egCompanyAddress} className="resize-none" disabled={!canManage} />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="edit-logo" className="flex items-center gap-1.5"><ImageIcon className="w-3.5 h-3.5" /> {t.companyLogo}</Label>
                        <div className="flex items-center gap-3">
                          <div className={`w-12 h-12 rounded-lg border border-border flex items-center justify-center overflow-hidden flex-shrink-0 ${accentDraft.trim() ? '' : 'bg-muted'}`}
                            style={accentDraft.trim() ? { backgroundColor: `color-mix(in srgb, ${accentDraft.trim()} 14%, transparent)` } : undefined}>
                            {logoDraft.trim()
                              ? <img src={logoDraft.trim()} alt="" className="w-full h-full object-contain" />
                              : <Building2 className={`w-5 h-5 ${accentDraft.trim() ? '' : 'text-muted-foreground'}`} style={accentDraft.trim() ? { color: accentDraft.trim() } : undefined} />}
                          </div>
                          <Input id="edit-logo" type="url" value={logoDraft} onChange={e => setLogoDraft(e.target.value)}
                            placeholder={t.logoUrlPlaceholder} className="flex-1" disabled={!canManage}
                            aria-invalid={!!logoDraftError} />
                        </div>
                        {logoDraftError
                          ? <InlineError>{logoDraftError}</InlineError>
                          : <p className="text-[11px] text-muted-foreground">{t.logoUrlHint}</p>}
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="edit-accent" className="flex items-center gap-1.5"><Palette className="w-3.5 h-3.5" /> {t.accentColor}</Label>
                        <div className="flex items-center gap-2">
                          <input type="color" aria-label={t.accentColor}
                            value={/^#[0-9a-fA-F]{6}$/.test(accentDraft) ? accentDraft : '#3B82F6'}
                            onChange={e => setAccentDraft(e.target.value)}
                            disabled={!canManage}
                            className="h-9 w-12 flex-shrink-0 cursor-pointer rounded-md border border-input bg-card p-0.5 disabled:cursor-not-allowed disabled:opacity-50" />
                          <Input id="edit-accent" type="text" value={accentDraft} onChange={e => setAccentDraft(e.target.value)}
                            placeholder="#3B82F6" className="flex-1" disabled={!canManage} />
                        </div>
                      </div>
                      {canManage && (
                        <div className="flex justify-end">
                          <Button size="sm" onClick={() => saveDetails(c)}
                            disabled={savingDetails || !nameDraft.trim() || !!logoDraftError || (nameDraft.trim() === c.name && addressDraft.trim() === (c.address ?? '') && logoDraft.trim() === (c.logo_url ?? '') && accentDraft.trim() === (c.accent_color ?? ''))}>
                            <Save className="w-3.5 h-3.5" /> {savingDetails ? t.saving : t.save}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Manage immediate supervisors */}
                  <div>
                    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">{t.immediateSupervisorsCap}</div>

                    {/* Add via searchable select */}
                    {canManage && availableSupervisors.length > 0 && (
                      <div className="flex gap-2 mb-3">
                        <div className="flex-1">
                          <Select
                            value={supToAdd}
                            onChange={setSupToAdd}
                            placeholder={t.addSupervisorPlaceholder}
                            searchable
                            options={availableSupervisors.map(s => ({
                              value: s.epf_number,
                              label: s.display_name,
                              sublabel: `${s.role} · ${s.epf_number}`,
                            }))}
                          />
                        </div>
                        <Button
                          onClick={async () => { if (supToAdd) { await addSupervisor(c.id, supToAdd); setSupToAdd(''); } }}
                          disabled={!supToAdd}
                          className="flex-shrink-0">
                          <UserPlus className="w-4 h-4" /> {t.addWord}
                        </Button>
                      </div>
                    )}

                    {/* Current immediate supervisors with remove */}
                    <div className="space-y-1.5">
                      {supervisorUsers.length === 0 ? (
                        <div className="text-xs text-muted-foreground py-2 px-1">{t.noImmediateSupervisors}</div>
                      ) : supervisorUsers.map(s => (
                        <div key={s.epf_number} className="flex items-center gap-3 px-3 py-2.5 rounded-md bg-muted border border-border">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-foreground truncate">{s.display_name}</div>
                            <div className="text-[11px] text-muted-foreground">{s.role} · {s.epf_number}</div>
                          </div>
                          {canManage && (
                            <Button variant="ghost" size="sm" onClick={() => removeSupervisor(c.id, s.epf_number)}
                              className="flex-shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10">
                              <UserMinus className="w-3.5 h-3.5" /> {t.removeWord}
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
      </Portal>

      {/* See the Portal note above. */}
      <Portal>
      <AnimatePresence>
        {showCreate && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              className="w-full max-w-md bg-card border border-border rounded-xl shadow-popover p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-base font-semibold text-foreground">{t.newCompany}</div>
                <button onClick={closeCreate}
                  className="w-8 h-8 rounded-md hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"><X className="w-4 h-4" /></button>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="company-name">{t.companyName} <span className="text-destructive">*</span></Label>
                <Input id="company-name" type="text" value={newName} onChange={e => setNewName(e.target.value)}
                  placeholder={t.egCompanyName} aria-invalid={triedCreate && !!newNameError} />
                {triedCreate && <InlineError>{newNameError}</InlineError>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="company-address">{t.locationAddress}</Label>
                <Textarea id="company-address" value={newAddress} onChange={e => setNewAddress(e.target.value)} rows={2}
                  placeholder={t.egCompanyAddress}
                  className="resize-none" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="company-logo">{t.companyLogo}</Label>
                <Input id="company-logo" type="url" value={newLogo} onChange={e => setNewLogo(e.target.value)}
                  placeholder={t.logoUrlPlaceholder} aria-invalid={!!newLogoError} />
                {newLogoError
                  ? <InlineError>{newLogoError}</InlineError>
                  : <p className="text-[11px] text-muted-foreground">{t.logoUrlHint}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="company-accent" className="flex items-center gap-1.5"><Palette className="w-3.5 h-3.5" /> {t.accentColor}</Label>
                <div className="flex items-center gap-2">
                  <input type="color" aria-label={t.accentColor}
                    value={/^#[0-9a-fA-F]{6}$/.test(newAccent) ? newAccent : '#3B82F6'}
                    onChange={e => setNewAccent(e.target.value)}
                    className="h-9 w-12 flex-shrink-0 cursor-pointer rounded-md border border-input bg-card p-0.5" />
                  <Input id="company-accent" type="text" value={newAccent} onChange={e => setNewAccent(e.target.value)}
                    placeholder="#3B82F6" className="flex-1" />
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <Button variant="outline" onClick={closeCreate} className="flex-1">{t.cancel}</Button>
                <Button onClick={handleCreate} disabled={createDisabled} className="flex-1">
                  <Save className="w-4 h-4" />{saving ? t.creating : t.createWord}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </Portal>
    </PageTransition>
  );
}

export default function CompaniesAdminPage() {
  return <CompaniesAdminContent />;
}
