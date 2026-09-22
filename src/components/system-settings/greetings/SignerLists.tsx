'use client';
import { useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowDown, ArrowUp, Building2, ChevronRight, Globe, Pencil, PenLine, Undo2, Users, X,
} from 'lucide-react';
import { useT } from '@/store/appStore';
import { cn } from '@/lib/utils';
import { Badge, badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import SearchableSelect, { type SearchOption } from '@/components/SearchableSelect';
import ConfirmModal from '@/components/ConfirmModal';
import { BlockHeader } from '@/components/system-settings/greetings/parts';
import SignerListDialog from '@/components/system-settings/greetings/SignerListDialog';
import { canonName, isHumanSenderName, resolveSigners, type GreetingSettings, type SignerGroup } from '@/lib/greetings';
import type { AppUser, Company } from '@/lib/types';

// Who signs, per scope.
//
// The model is a ladder — department, then company, then the default list, then whatever the
// role tree calls top management (resolveSigners). The old screen hid every scope behind a
// dropdown and showed one at a time, so "2 scopes have their own list" was the only evidence
// the other lists existed and there was no way to see WHICH two. Every list is on screen here,
// most specific first, in the order the engine resolves them: the list is what teaches the
// ladder, exactly as SuspenseLimitsSettings does for float limits.

type Scope = { kind: 'default' } | { kind: 'company' | 'department'; key: string };

const scopeId = (s: Scope): string =>
  s.kind === 'default' ? '' : `${s.kind === 'company' ? 'c' : 'd'}:${s.key}`;

// The prefix keeps a company id and a department name that happen to read the same apart;
// '' is the default list.
function parseScope(v: string): Scope {
  if (v.startsWith('c:')) return { kind: 'company', key: v.slice(2) };
  if (v.startsWith('d:')) return { kind: 'department', key: v.slice(2) };
  return { kind: 'default' };
}

// Matched the way resolveSigners matches: company ids exactly, department names loosely,
// because a department name is free text on both a profile and this setting.
function sameKey(a: string, b: string, kind: 'company' | 'department'): boolean {
  return kind === 'company' ? a.trim() === b.trim() : canonName(a) === canonName(b);
}

export interface SignerListsProps {
  settings: GreetingSettings;
  users: AppUser[];
  companies: Company[];
  /** Every department this tenant knows, with the company it sits in. */
  departments: Array<{ name: string; companyId: string }>;
  /** Writes the whole document; `key` names the control that started it, for its own spinner. */
  onWrite: (next: GreetingSettings, key: string) => void;
  /** The key of the write in flight, or null. */
  pending: string | null;
}

export default function SignerLists({
  settings, users, companies, departments, onWrite, pending,
}: SignerListsProps) {
  const t = useT();
  const reduced = useReducedMotion();
  // '' is the default list — open to begin with, because it is the base of the ladder and the
  // one an admin who has never configured a scope is actually editing. null is "all collapsed".
  const [openScope, setOpenScope] = useState<string | null>('');
  const [confirmDrop, setConfirmDrop] = useState<{ epf: string; name: string } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogScopeId, setDialogScopeId] = useState('');

  const groups = useMemo(() => settings.signer_groups ?? [], [settings.signer_groups]);
  const scope = useMemo(() => parseScope(openScope ?? ''), [openScope]);
  const personByEpf = useMemo(() => new Map(users.map(u => [String(u.epf_number), u])), [users]);

  const companyName = (id: string) => companies.find(c => c.id === id)?.name || id;
  const groupOf = (s: Scope): SignerGroup | undefined =>
    s.kind === 'default' ? undefined : groups.find(g => g.scope === s.kind && sameKey(g.key, s.key, s.kind));
  const listOf = (s: Scope): string[] =>
    s.kind === 'default' ? (settings.signers ?? []) : (groupOf(s)?.signers ?? []);

  // Every list there is, most specific first — plus the still-empty one the admin has just
  // opened, kept in place so "I added a list and put nobody in it" is a visible state rather
  // than a row that silently fails to appear (an empty group is never stored).
  const rows = useMemo(() => {
    const nameOf = (s: Scope) =>
      s.kind === 'company' ? companyName(s.key) : s.kind === 'department' ? s.key : t.greetingsScopeEveryone;
    const configured = groups
      .map(g => ({ scope: { kind: g.scope, key: g.key } as Scope, signers: g.signers }))
      .map(r => ({ ...r, id: scopeId(r.scope), name: nameOf(r.scope) }))
      // Departments before companies, alphabetical inside each: the order resolveSigners tries.
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

    if (scope.kind !== 'default' && openScope !== null && !listed.some(r => r.id === openScope)) {
      listed.unshift({
        id: openScope,
        name: nameOf(scope),
        signers: [],
        level: scope.kind === 'company' ? t.companyWord : t.departmentLabel,
        icon: scope.kind === 'company' ? Building2 : Users,
      });
    }

    return [...listed, {
      id: '', name: t.greetingsScopeEveryone, signers: settings.signers ?? [],
      level: '', icon: Globe,
    }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, companies, settings.signers, openScope, scope, t]);

  const writeSigners = (next: string[], key: string) => {
    if (scope.kind === 'default') { onWrite({ ...settings, signers: next }, key); return; }
    const matches = (g: SignerGroup) => g.scope === scope.kind && sameKey(g.key, scope.key, scope.kind);
    // An emptied group is removed rather than stored empty — the save route drops it anyway,
    // and an empty group and no group mean the same thing when they are read back.
    const nextGroups: SignerGroup[] = groups.some(matches)
      ? groups.flatMap(g => (matches(g) ? (next.length ? [{ ...g, signers: next }] : []) : [g]))
      : (next.length ? [...groups, { scope: scope.kind, key: scope.key, signers: next }] : groups);
    onWrite({ ...settings, signer_groups: nextGroups }, key);
  };

  const signers = listOf(scope);

  // Up and down, both keyboard-reachable buttons. Moving the sixth signer to the front used to
  // cost five taps on a single up arrow with no way back down.
  const move = (from: number, to: number) => {
    if (to < 0 || to >= signers.length) return;
    const next = signers.slice();
    [next[from], next[to]] = [next[to], next[from]];
    writeSigners(next, `signer-move-${signers[from]}`);
  };

  // What this scope gets while it has no list of its own — replayed through the real resolution
  // order, so the sentence stays true when another list is edited.
  const fallbackNote = (): string => {
    if (scope.kind === 'default') return t.greetingsNoSigners;
    const companyId = scope.kind === 'company'
      ? scope.key
      : departments.find(d => sameKey(d.name, scope.key, 'department'))?.companyId ?? '';
    const resolved = resolveSigners(settings, {
      company_id: companyId,
      department: scope.kind === 'department' ? scope.key : null,
    });
    if (!resolved) return t.greetingsFallbackTop;
    if (resolved === settings.signers) return t.greetingsFallbackDefault;
    // resolveSigners hands back the winning group's own array, so identity names the group.
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

  const scopeName = scope.kind === 'default'
    ? t.greetingsScopeEveryone
    : scope.kind === 'company' ? companyName(scope.key) : scope.key;

  // Removing the last member of a scoped list deletes the list, and the scope goes back to
  // inheriting. That is a real consequence and it used to happen on one unconfirmed tap.
  const droppingLast = !!confirmDrop && signers.length === 1 && scope.kind !== 'default';

  return (
    <div className="space-y-3">
      <BlockHeader
        icon={PenLine}
        title={t.greetingsSigners}
        description={t.greetingsLadderHint}
        badge={(
          <button
            type="button"
            onClick={() => {
              setDialogScopeId(openScope ?? '');
              setDialogOpen(true);
            }}
            className={cn(
              badgeVariants({ variant: rows.length > 1 ? 'brand' : 'muted' }),
              'cursor-pointer transition-all hover:opacity-80 active:scale-95 flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
            title={t.greetingsEditLists}
            aria-label={`${t.greetingsListsBadge.replace('{n}', String(rows.length))} — ${t.greetingsEditLists}`}
          >
            <span>{t.greetingsListsBadge.replace('{n}', String(rows.length))}</span>
            <Pencil className="h-2.5 w-2.5 opacity-70" />
          </button>
        )}
        action={(
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-10 gap-1.5"
            onClick={() => {
              setDialogScopeId(openScope ?? '');
              setDialogOpen(true);
            }}
          >
            <Pencil className="h-4 w-4" />
            <span>{t.greetingsEditLists}</span>
          </Button>
        )}
      />

      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {rows.map(row => {
          const open = row.id === openScope;
          const Icon = row.icon;
          return (
            <li key={row.id || 'default'}>
              <div className="flex items-center">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenScope(open ? null : row.id)}
                  className={cn(
                    'flex min-h-11 flex-1 items-center gap-2 px-2.5 py-2 text-left transition-colors',
                    open ? 'bg-primary/10' : 'hover:bg-accent',
                  )}
                >
                  <Icon aria-hidden className={cn('h-4 w-4 shrink-0', open ? 'text-primary' : 'text-muted-foreground')} />
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate text-sm text-foreground', open && 'font-semibold')}>
                      {row.name}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                      {row.level && <span className="uppercase tracking-wide">{row.level}</span>}
                      <span>
                        {row.signers.length
                          ? t.greetingsSignerCount.replace('{n}', String(row.signers.length))
                          : t.greetingsNoListYet}
                      </span>
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      'h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
                      open && 'rotate-90',
                    )}
                  />
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 shrink-0 text-muted-foreground hover:text-foreground"
                  title={t.greetingsEditingList.replace('{name}', row.name)}
                  aria-label={t.greetingsEditingList.replace('{name}', row.name)}
                  onClick={() => {
                    setDialogScopeId(row.id);
                    setDialogOpen(true);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </div>

              <AnimatePresence initial={false}>
                {open && (
                  <motion.div
                    initial={reduced ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: reduced ? 0 : 0.15 }}
                    className="space-y-2 border-t border-border bg-muted/20 p-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {t.greetingsEditingList.replace('{name}', scopeName)}
                      </p>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-9 gap-1 text-xs"
                          onClick={() => {
                            setDialogScopeId(row.id);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil className="h-3 w-3" /> {t.greetingsEditLists}
                        </Button>
                        {scope.kind !== 'default' && (
                          <Button type="button" variant="ghost" size="sm" className="h-9 text-xs"
                            onClick={() => setOpenScope('')}>
                            <Undo2 className="h-3.5 w-3.5" /> {t.greetingsBackToDefault}
                          </Button>
                        )}
                      </div>
                    </div>

                    {signers.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] leading-relaxed text-muted-foreground">
                        {fallbackNote()}
                      </p>
                    ) : (
                      <ol className="space-y-1.5">
                        {signers.map((epf, i) => {
                          const u = personByEpf.get(epf);
                          // `users` empty means the list has not loaded; only then is a miss meaningless.
                          const gone = users.length > 0 && (!u || !isHumanSenderName(u.display_name || `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim(), u.role));
                          const who = u?.display_name || epf;
                          const busy = pending === `signer-move-${epf}` || pending === `signer-drop-${epf}`;
                          return (
                            <li key={epf} className={cn('rounded-lg border border-border bg-card/60 p-2', busy && 'opacity-60')}>
                              <div className="flex items-center gap-1">
                                <span className="w-5 shrink-0 text-center text-[11px] font-semibold tabular-nums text-muted-foreground">
                                  {i + 1}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-sm text-foreground">{who}</span>
                                <Button type="button" variant="ghost" size="icon" className="h-10 w-10 shrink-0"
                                  disabled={i === 0}
                                  aria-label={`${t.greetingsMoveUp}: ${who}`} onClick={() => move(i, i - 1)}>
                                  <ArrowUp className="h-4 w-4 text-muted-foreground" />
                                </Button>
                                <Button type="button" variant="ghost" size="icon" className="h-10 w-10 shrink-0"
                                  disabled={i === signers.length - 1}
                                  aria-label={`${t.greetingsMoveDown}: ${who}`} onClick={() => move(i, i + 1)}>
                                  <ArrowDown className="h-4 w-4 text-muted-foreground" />
                                </Button>
                                <Button type="button" variant="ghost" size="icon"
                                  className="h-10 w-10 shrink-0 text-muted-foreground hover:text-destructive"
                                  aria-label={`${t.greetingsRemoveSigner}: ${who}`}
                                  onClick={() => setConfirmDrop({ epf, name: who })}>
                                  <X className="h-4 w-4" />
                                </Button>
                              </div>
                              {/* Second line, so the role and a warning are never squeezed out
                                  by three buttons on a 360px screen — which is where this is
                                  actually edited. */}
                              <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-6 text-[11px] text-muted-foreground">
                                {u?.role && <span className="truncate">{u.role}</span>}
                                {i === 0 && <Badge variant="outline">{t.greetingsSignsFirst}</Badge>}
                                {gone && <Badge variant="destructive">{t.greetingsSignerGone}</Badge>}
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                    )}

                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">{t.greetingsAddSigner}</Label>
                      {/* Keyed by list: switching list must not leave the previous one's
                          half-typed search sitting in the field. */}
                      <SearchableSelect
                        key={openScope ?? 'none'}
                        value=""
                        onChange={epf => { if (epf && !signers.includes(epf)) writeSigners([...signers, epf], 'signer-add'); }}
                        options={userOptions.filter(o => !signers.includes(o.value))}
                        placeholder={t.greetingsAddSigner}
                        ariaLabel={t.greetingsAddSigner}
                      />
                      <p className="leading-relaxed text-[11px] text-muted-foreground">{t.greetingsSignersHint}</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>

      {/* The picker is the ADD control now, not the only way to see what exists. */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-2 sm:flex-row sm:items-center">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground sm:shrink-0">
          {t.greetingsAddScopedList}
        </span>
        <div className="min-w-0 flex-1">
          <SearchableSelect value="" onChange={v => setOpenScope(v)} options={scopeOptions}
            placeholder={t.greetingsScopePick} ariaLabel={t.greetingsAddScopedList} />
        </div>
      </div>

      <ConfirmModal
        open={!!confirmDrop}
        onOpenChange={() => setConfirmDrop(null)}
        variant={droppingLast ? 'warning' : 'danger'}
        title={t.greetingsRemoveSignerConfirm.replace('{name}', confirmDrop?.name ?? '')}
        description={droppingLast
          ? t.greetingsRemoveLastSignerWarn.replace('{scope}', scopeName)
          : t.greetingsRemoveSignerBody.replace('{scope}', scopeName)}
        confirmText={t.greetingsRemoveSigner}
        onConfirm={() => {
          if (confirmDrop) {
            writeSigners(signers.filter(e => e !== confirmDrop.epf), `signer-drop-${confirmDrop.epf}`);
          }
          setConfirmDrop(null);
        }}
      />

      <SignerListDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialScopeId={dialogScopeId}
        settings={settings}
        users={users}
        companies={companies}
        departments={departments}
        onWrite={onWrite}
        pending={pending}
      />
    </div>
  );
}
