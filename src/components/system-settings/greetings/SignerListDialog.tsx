'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown, ArrowUp, Building2, Globe, Loader2, PenLine, Plus, Trash2, Users, X,
} from 'lucide-react';
import { useT } from '@/store/appStore';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import SearchableSelect, { type SearchOption } from '@/components/SearchableSelect';
import ConfirmModal from '@/components/ConfirmModal';
import { canonName, isHumanSenderName, resolveSigners, type GreetingSettings, type SignerGroup } from '@/lib/greetings';
import type { AppUser, Company } from '@/lib/types';

export type Scope = { kind: 'default' } | { kind: 'company' | 'department'; key: string };

export const scopeId = (s: Scope): string =>
  s.kind === 'default' ? '' : `${s.kind === 'company' ? 'c' : 'd'}:${s.key}`;

export function parseScope(v: string): Scope {
  if (v.startsWith('c:')) return { kind: 'company', key: v.slice(2) };
  if (v.startsWith('d:')) return { kind: 'department', key: v.slice(2) };
  return { kind: 'default' };
}

export function sameKey(a: string, b: string, kind: 'company' | 'department'): boolean {
  return kind === 'company' ? a.trim() === b.trim() : canonName(a) === canonName(b);
}

export interface SignerListDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialScopeId?: string;
  settings: GreetingSettings;
  users: AppUser[];
  companies: Company[];
  departments: Array<{ name: string; companyId: string }>;
  onWrite: (next: GreetingSettings, key: string) => void;
  pending: string | null;
}

export default function SignerListDialog({
  open,
  onOpenChange,
  initialScopeId = '',
  settings,
  users,
  companies,
  departments,
  onWrite,
  pending,
}: SignerListDialogProps) {
  const t = useT();
  const [activeScopeId, setActiveScopeId] = useState<string>(initialScopeId);
  const [showAddScope, setShowAddScope] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState<{ epf: string; name: string } | null>(null);
  const [confirmDeleteScope, setConfirmDeleteScope] = useState(false);

  useEffect(() => {
    if (open) {
      setActiveScopeId(initialScopeId || '');
      setShowAddScope(false);
      setConfirmDrop(null);
      setConfirmDeleteScope(false);
    }
  }, [open, initialScopeId]);

  const groups = useMemo(() => settings.signer_groups ?? [], [settings.signer_groups]);
  const activeScope = useMemo(() => parseScope(activeScopeId), [activeScopeId]);
  const personByEpf = useMemo(() => new Map(users.map(u => [String(u.epf_number), u])), [users]);

  const companyName = (id: string) => companies.find(c => c.id === id)?.name || id;

  const groupOf = (s: Scope): SignerGroup | undefined =>
    s.kind === 'default' ? undefined : groups.find(g => g.scope === s.kind && sameKey(g.key, s.key, s.kind));

  const listOf = (s: Scope): string[] =>
    s.kind === 'default' ? (settings.signers ?? []) : (groupOf(s)?.signers ?? []);

  const nameOf = (s: Scope) =>
    s.kind === 'company' ? companyName(s.key) : s.kind === 'department' ? s.key : t.greetingsScopeEveryone;

  const rows = useMemo(() => {
    const configured = groups
      .map(g => ({ scope: { kind: g.scope, key: g.key } as Scope, signers: g.signers }))
      .map(r => ({ ...r, id: scopeId(r.scope), name: nameOf(r.scope) }))
      .sort((a, b) => (a.scope.kind === b.scope.kind
        ? a.name.localeCompare(b.name)
        : a.scope.kind === 'department' ? -1 : 1));

    const listed = configured.map(r => ({
      id: r.id,
      name: r.name,
      signers: r.signers,
      level: r.scope.kind === 'company' ? t.companyWord : t.departmentLabel,
      icon: r.scope.kind === 'company' ? Building2 : Users,
    }));

    if (activeScope.kind !== 'default' && !listed.some(r => r.id === activeScopeId)) {
      listed.unshift({
        id: activeScopeId,
        name: nameOf(activeScope),
        signers: [],
        level: activeScope.kind === 'company' ? t.companyWord : t.departmentLabel,
        icon: activeScope.kind === 'company' ? Building2 : Users,
      });
    }

    return [...listed, {
      id: '',
      name: t.greetingsScopeEveryone,
      signers: settings.signers ?? [],
      level: '',
      icon: Globe,
    }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, companies, settings.signers, activeScopeId, activeScope, t]);

  const writeSigners = (next: string[], key: string) => {
    if (activeScope.kind === 'default') {
      onWrite({ ...settings, signers: next }, key);
      return;
    }
    const matches = (g: SignerGroup) => g.scope === activeScope.kind && sameKey(g.key, activeScope.key, activeScope.kind);
    const nextGroups: SignerGroup[] = groups.some(matches)
      ? groups.flatMap(g => (matches(g) ? (next.length ? [{ ...g, signers: next }] : []) : [g]))
      : (next.length ? [...groups, { scope: activeScope.kind, key: activeScope.key, signers: next }] : groups);
    onWrite({ ...settings, signer_groups: nextGroups }, key);
  };

  const removeScope = (s: Scope) => {
    if (s.kind === 'default') return;
    const nextGroups = groups.filter(g => !(g.scope === s.kind && sameKey(g.key, s.key, s.kind)));
    onWrite({ ...settings, signer_groups: nextGroups }, `scope-delete-${scopeId(s)}`);
    setActiveScopeId('');
  };

  const signers = listOf(activeScope);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= signers.length) return;
    const next = signers.slice();
    [next[from], next[to]] = [next[to], next[from]];
    writeSigners(next, `signer-move-${signers[from]}`);
  };

  const fallbackNote = (): string => {
    if (activeScope.kind === 'default') return t.greetingsNoSigners;
    const companyId = activeScope.kind === 'company'
      ? activeScope.key
      : departments.find(d => sameKey(d.name, activeScope.key, 'department'))?.companyId ?? '';
    const resolved = resolveSigners(settings, {
      company_id: companyId,
      department: activeScope.kind === 'department' ? activeScope.key : null,
    });
    if (!resolved) return t.greetingsFallbackTop;
    if (resolved === settings.signers) return t.greetingsFallbackDefault;
    const hit = groups.find(g => g.signers === resolved);
    return t.greetingsFallbackCompany.replace('{name}', companyName(hit?.key ?? ''));
  };

  const scopeOptions = useMemo<SearchOption[]>(() => {
    const taken = new Set(groups.map(g => scopeId({ kind: g.scope, key: g.key })));
    return [
      ...companies.map(c => ({
        value: `c:${c.id}`, label: c.name, sublabel: t.companyWord, keywords: c.id,
      })),
      ...departments.map(d => ({ value: `d:${d.name}`, label: d.name, sublabel: t.departmentLabel })),
    ].filter(o => !taken.has(o.value));
  }, [companies, departments, groups, t]);

  const userOptions = useMemo<SearchOption[]>(() => users
    .filter(u => u.epf_number && u.is_active !== false && !(u as { is_system_admin?: boolean }).is_system_admin && isHumanSenderName(u.display_name || `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim(), u.role))
    .map(u => ({
      value: String(u.epf_number),
      label: u.display_name || String(u.epf_number),
      sublabel: [String(u.epf_number), u.role].filter(Boolean).join(' · ') || undefined,
      keywords: `${u.epf_number} ${u.email ?? ''} ${u.role ?? ''}`,
    })), [users]);

  const currentScopeName = nameOf(activeScope);
  const activeLevel = activeScope.kind === 'company' ? t.companyWord
    : activeScope.kind === 'department' ? t.departmentLabel : '';
  const ActiveIcon = activeScope.kind === 'company' ? Building2
    : activeScope.kind === 'department' ? Users : Globe;

  const droppingLast = !!confirmDrop && signers.length === 1 && activeScope.kind !== 'default';

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[88dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="border-b border-border p-6 pb-4">
            <div className="flex items-center justify-between gap-3 pr-6">
              <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
                <PenLine className="h-5 w-5 text-primary" />
                <span>{t.greetingsSigners}</span>
                <Badge variant="brand" className="text-xs">
                  {t.greetingsListsBadge.replace('{n}', String(rows.length))}
                </Badge>
              </DialogTitle>
            </div>
            <DialogDescription className="mt-1 text-xs text-muted-foreground">
              {t.greetingsLadderHint}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 space-y-5 overflow-y-auto overscroll-contain p-6 scrollbar-thin">
            {/* Scope selector tabs */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t.greetingsListsBadge.replace('{n}', String(rows.length))}
                </Label>
                {!showAddScope && scopeOptions.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAddScope(true)}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <Plus className="h-3 w-3" />
                    <span>{t.greetingsAddScopedList}</span>
                  </button>
                )}
              </div>

              <div className="flex flex-wrap gap-1.5">
                {rows.map(row => {
                  const isSelected = row.id === activeScopeId;
                  const Icon = row.icon;
                  return (
                    <button
                      key={row.id || 'default'}
                      type="button"
                      onClick={() => {
                        setActiveScopeId(row.id);
                        setShowAddScope(false);
                      }}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                        isSelected
                          ? 'border-primary bg-primary/10 text-primary shadow-sm'
                          : 'border-border bg-card/60 text-muted-foreground hover:bg-accent hover:text-foreground'
                      )}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="max-w-[130px] truncate sm:max-w-[180px]">{row.name}</span>
                      <span className={cn(
                        'rounded-full px-1.5 py-0.2 text-[10px] tabular-nums',
                        isSelected ? 'bg-primary/20 font-semibold text-primary' : 'bg-muted text-muted-foreground'
                      )}>
                        {row.signers.length}
                      </span>
                    </button>
                  );
                })}
              </div>

              {showAddScope && (
                <div className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 sm:flex-row sm:items-center">
                  <span className="text-xs font-semibold text-foreground sm:shrink-0">
                    {t.greetingsAddScopedList}:
                  </span>
                  <div className="min-w-0 flex-1">
                    <SearchableSelect
                      value=""
                      onChange={v => {
                        if (v) {
                          setActiveScopeId(v);
                          setShowAddScope(false);
                        }
                      }}
                      options={scopeOptions}
                      placeholder={t.greetingsScopePick}
                      ariaLabel={t.greetingsAddScopedList}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-9 px-2 text-xs"
                    onClick={() => setShowAddScope(false)}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>

            {/* Active Scope Box */}
            <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
              <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-3">
                <div className="flex min-w-0 items-center gap-2">
                  <ActiveIcon className="h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-foreground">{currentScopeName}</span>
                      {activeLevel && (
                        <Badge variant="outline" className="px-1.5 py-0 text-[10px] uppercase tracking-wider">
                          {activeLevel}
                        </Badge>
                      )}
                    </div>
                    <span className="text-[11px] text-muted-foreground">
                      {signers.length
                        ? t.greetingsSignerCount.replace('{n}', String(signers.length))
                        : t.greetingsNoListYet}
                    </span>
                  </div>
                </div>

                {activeScope.kind !== 'default' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setConfirmDeleteScope(true)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>{t.greetingsDeleteList || 'Delete list'}</span>
                  </Button>
                )}
              </div>

              {signers.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border bg-card/40 px-3.5 py-4 text-center text-xs leading-relaxed text-muted-foreground">
                  {fallbackNote()}
                </p>
              ) : (
                <ol className="space-y-1.5">
                  {signers.map((epf, i) => {
                    const u = personByEpf.get(epf);
                    const gone = users.length > 0 && (!u || !isHumanSenderName(u.display_name || `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim(), u.role));
                    const who = u?.display_name || epf;
                    const busy = pending === `signer-move-${epf}` || pending === `signer-drop-${epf}`;
                    return (
                      <li key={epf} className={cn('rounded-lg border border-border bg-card/80 p-2.5 shadow-sm transition-all', busy && 'opacity-60')}>
                        <div className="flex items-center gap-2">
                          <span className="w-5 shrink-0 text-center text-xs font-semibold tabular-nums text-muted-foreground">
                            {i + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-foreground">{who}</span>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                              {u?.role && <span className="truncate">{u.role}</span>}
                              {i === 0 && <Badge variant="outline" className="py-0 text-[10px]">{t.greetingsSignsFirst}</Badge>}
                              {gone && <Badge variant="destructive" className="py-0 text-[10px]">{t.greetingsSignerGone}</Badge>}
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 shrink-0"
                            disabled={i === 0}
                            aria-label={`${t.greetingsMoveUp}: ${who}`}
                            onClick={() => move(i, i - 1)}
                          >
                            <ArrowUp className="h-4 w-4 text-muted-foreground" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 shrink-0"
                            disabled={i === signers.length - 1}
                            aria-label={`${t.greetingsMoveDown}: ${who}`}
                            onClick={() => move(i, i + 1)}
                          >
                            <ArrowDown className="h-4 w-4 text-muted-foreground" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            aria-label={`${t.greetingsRemoveSigner}: ${who}`}
                            onClick={() => setConfirmDrop({ epf, name: who })}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}

              <div className="space-y-1.5 pt-1">
                <Label className="text-xs font-medium text-foreground">{t.greetingsAddSigner}</Label>
                <SearchableSelect
                  key={activeScopeId}
                  value=""
                  onChange={epf => {
                    if (epf && !signers.includes(epf)) {
                      writeSigners([...signers, epf], 'signer-add');
                    }
                  }}
                  options={userOptions.filter(o => !signers.includes(o.value))}
                  placeholder={t.greetingsAddSigner}
                  ariaLabel={t.greetingsAddSigner}
                />
                <p className="leading-relaxed text-[11px] text-muted-foreground">{t.greetingsSignersHint}</p>
              </div>
            </div>
          </div>

          <DialogFooter className="flex items-center justify-between border-t border-border bg-card/60 p-4 sm:justify-between">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {pending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                  <span>{t.saving || 'Saving…'}</span>
                </>
              ) : (
                <span className="text-[11px]">All changes save automatically</span>
              )}
            </div>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Drop signer confirmation */}
      <ConfirmModal
        open={!!confirmDrop}
        onOpenChange={() => setConfirmDrop(null)}
        variant={droppingLast ? 'warning' : 'danger'}
        title={t.greetingsRemoveSignerConfirm.replace('{name}', confirmDrop?.name ?? '')}
        description={droppingLast
          ? t.greetingsRemoveLastSignerWarn.replace('{scope}', currentScopeName)
          : t.greetingsRemoveSignerBody.replace('{scope}', currentScopeName)}
        confirmText={t.greetingsRemoveSigner}
        onConfirm={() => {
          if (confirmDrop) {
            writeSigners(signers.filter(e => e !== confirmDrop.epf), `signer-drop-${confirmDrop.epf}`);
          }
          setConfirmDrop(null);
        }}
      />

      {/* Delete scoped list confirmation */}
      <ConfirmModal
        open={confirmDeleteScope}
        onOpenChange={() => setConfirmDeleteScope(false)}
        variant="danger"
        title={(t.greetingsDeleteListConfirm || 'Delete the list for {name}?').replace('{name}', currentScopeName)}
        description={t.greetingsRemoveLastSignerWarn.replace('{scope}', currentScopeName)}
        confirmText={t.greetingsDeleteList || 'Delete list'}
        onConfirm={() => {
          removeScope(activeScope);
          setConfirmDeleteScope(false);
        }}
      />
    </>
  );
}
