'use client';
// The admin surface for the float ceiling — how much suspense balance a person may hold.
//
// The rule engine is src/lib/suspenseLimits.ts and the enforcement is in suspenseService
// (approveRequest / adjustSuspenseAccount). This screen only edits the config those read, so it
// deliberately mirrors the resolution ladder one section per level, broadest last in effect but
// listed company-first here so the page reads top-down from "everyone" to "this one person".
//
// Everything is edited locally and written in ONE save. A half-typed row must never reach
// Firestore: a limit is what an approval is refused against, so a stray blank key or a negative
// amount is caught inline and blocks the save rather than being silently dropped.
import { useEffect, useMemo, useState } from 'react';
import { Gauge, Plus, Trash2, Loader2, Building2, Users, Briefcase, ShieldCheck, User, Undo2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import {
  EMPTY_LIMITS, LIMIT_SOURCE_LABEL, countLimitRules, isLimitValue, normalizeLimitConfig,
  resolveSuspenseLimit, type SuspenseLimitConfig,
} from '@/lib/suspenseLimits';
import { getSuspenseLimits, saveSuspenseLimits, formatSuspenseAmount, SUSPENSE_CURRENCY } from '@/services/suspenseService';
import { getAllEmployees, getAllUsers } from '@/services/userService';
import { getRoles } from '@/services/roleService';
import { getDepartments } from '@/services/departmentService';
import { getCompanies } from '@/services/companyService';
import type { AppUser, Company } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/Skeleton';
import Select from '@/components/Select';
import Combobox from '@/components/Combobox';
import SearchableSelect from '@/components/SearchableSelect';
import InlineError from '@/components/InlineError';
import { errMsg } from '@/components/suspense/shared';

type Section = keyof SuspenseLimitConfig;

// A row is edited as STRINGS, not numbers: "" and "-" are states a person passes through while
// typing, and coercing them to a number mid-keystroke is what makes an amount field fight back.
interface Row { rid: string; key: string; amount: string }
type Rows = Record<Section, Row[]>;

const SECTIONS: Section[] = ['company_default', 'by_department', 'by_position', 'by_role', 'by_person'];

// One word per level — it has to fit a dropdown and a 6rem column on a rule row.
const SECTION_LABEL: Record<Section, string> = {
  company_default: 'Company',
  by_department:   'Department',
  by_position:     'Position',
  by_role:         'Role',
  by_person:       'Person',
};
const SECTION_ICON: Record<Section, React.ComponentType<{ className?: string }>> = {
  company_default: Building2,
  by_department:   Users,
  by_position:     Briefcase,
  by_role:         ShieldCheck,
  by_person:       User,
};

let rid = 0;
const nextRid = () => `r${++rid}`;

const rowsFromConfig = (c: SuspenseLimitConfig): Rows => ({
  company_default: Object.entries(c.company_default).map(([key, v]) => ({ rid: nextRid(), key, amount: String(v) })),
  by_department:   Object.entries(c.by_department).map(([key, v]) => ({ rid: nextRid(), key, amount: String(v) })),
  by_position:     Object.entries(c.by_position).map(([key, v]) => ({ rid: nextRid(), key, amount: String(v) })),
  by_role:         Object.entries(c.by_role).map(([key, v]) => ({ rid: nextRid(), key, amount: String(v) })),
  by_person:       Object.entries(c.by_person).map(([key, v]) => ({ rid: nextRid(), key, amount: String(v) })),
});

/** Only complete, valid rows become config — an invalid row is reported inline and blocks the
 *  save, so nothing here can quietly drop a rule the admin thinks they set. */
const configFromRows = (rows: Rows): SuspenseLimitConfig => {
  const map = (list: Row[]) => {
    const out: Record<string, number> = {};
    for (const r of list) {
      const key = r.key.trim();
      const num = Number(r.amount);
      if (key && r.amount.trim() !== '' && isLimitValue(num)) out[key] = num;
    }
    return out;
  };
  return {
    company_default: map(rows.company_default),
    by_department:   map(rows.by_department),
    by_position:     map(rows.by_position),
    by_role:         map(rows.by_role),
    by_person:       map(rows.by_person),
  };
};

/** Why a row cannot be saved, or '' when it is fine. `siblings` are the other rows in the same
 *  section — two rules for the same key would make the winner depend on object order. */
function rowError(row: Row, siblings: Row[]): string {
  if (!row.key.trim()) return 'Pick who this applies to.';
  const dupe = siblings.some(o => o.rid !== row.rid && o.key.trim().toLowerCase() === row.key.trim().toLowerCase());
  if (dupe) return 'Already listed above — edit that row instead.';
  if (row.amount.trim() === '') return 'Enter an amount.';
  const num = Number(row.amount);
  if (!isLimitValue(num)) return 'Enter an amount of 0 or more.';
  return '';
}

/** Order-independent fingerprint of a config, for the dirty check. */
const canonical = (c: SuspenseLimitConfig): string =>
  JSON.stringify(SECTIONS.map(s => Object.entries(c[s]).sort(([a], [b]) => a.localeCompare(b))));

export default function SuspenseLimitsSettings() {
  const user = useAuthStore(s => s.user);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  // `saved` is the last config known to be in Firestore — the yardstick for "dirty".
  const [saved, setSaved]     = useState<SuspenseLimitConfig>(EMPTY_LIMITS);
  const [rows, setRows]       = useState<Rows>(() => rowsFromConfig(EMPTY_LIMITS));
  // ONE draft with the level on it, rather than a waiting row per level. Five near-identical
  // add-forms stacked down the page was most of this screen's height, and four of them were
  // always the wrong one.
  const [draft, setDraft]     = useState<{ section: Section; key: string; amount: string }>(
    { section: 'by_person', key: '', amount: '' },
  );

  const [companies, setCompanies]     = useState<Company[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [roleNames, setRoleNames]     = useState<string[]>([]);
  const [positions, setPositions]     = useState<string[]>([]);
  const [employees, setEmployees]     = useState<AppUser[]>([]);
  // Resolving a check needs the person's role/designation/department, which getAllEmployees
  // already carries — but a limit may name someone getAllEmployees filters out (an admin, say),
  // so keep the full user list for looking a key's display name up.
  const [allUsers, setAllUsers]       = useState<AppUser[]>([]);

  const [checkEpf, setCheckEpf] = useState('');

  useEffect(() => {
    let alive = true;
    getSuspenseLimits()
      .then(c => { if (!alive) return; setSaved(c); setRows(rowsFromConfig(c)); })
      .catch(() => toast.error('Failed to load float limits.'))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    getCompanies().then(setCompanies).catch(() => {});
    getRoles().then(rs => setRoleNames(rs.filter(r => r.is_active !== false).map(r => r.name))).catch(() => {});
    // Departments are a Southern Lanka-only collection; on a tenant without them this comes back
    // empty and the Department picker degrades to plain free text (allowCustom), which is the
    // only sensible fallback — the department names still live on the user profiles.
    getDepartments().then(ds => setDepartments([...new Set(ds.map(d => d.name).filter(Boolean))].sort())).catch(() => {});
    getAllEmployees().then(setEmployees).catch(() => {});
    getAllUsers()
      .then(us => {
        setAllUsers(us);
        setPositions([...new Set(us.map(u => (u.designation ?? '').trim()).filter(Boolean))].sort());
      })
      .catch(() => {});
  }, []);

  const setRowAmount = (s: Section, rowId: string, amount: string) =>
    setRows(r => ({ ...r, [s]: r[s].map(x => (x.rid === rowId ? { ...x, amount } : x)) }));
  const removeRow = (s: Section, rowId: string) =>
    setRows(r => ({ ...r, [s]: r[s].filter(x => x.rid !== rowId) }));

  const addDraft = () => {
    const s = draft.section;
    const err = rowError({ rid: 'draft', key: draft.key, amount: draft.amount }, rows[s]);
    if (err) { toast.error(err); return; }
    setRows(r => ({ ...r, [s]: [...r[s], { rid: nextRid(), key: draft.key.trim(), amount: String(Number(draft.amount)) }] }));
    // The level stays put: setting several limits at one level is the common run.
    setDraft(d => ({ ...d, key: '', amount: '' }));
  };

  const pending  = useMemo(() => configFromRows(rows), [rows]);
  // Compared on sorted keys: removing a rule and adding it back leaves a different object order
  // but the same set of rules, and that must not read as an unsaved change.
  const dirty    = useMemo(() => canonical(pending) !== canonical(saved), [pending, saved]);
  const ruleCount = countLimitRules(pending);
  const anyRowInvalid = SECTIONS.some(s => rows[s].some(r => rowError(r, rows[s]) !== ''));

  const save = async () => {
    if (anyRowInvalid) { toast.error('Fix the highlighted rows first.'); return; }
    setSaving(true);
    try {
      const clean = normalizeLimitConfig(pending);
      await saveSuspenseLimits(clean, { epf: user?.epf_number ?? '', name: user?.name ?? '' });
      setSaved(clean);
      setRows(rowsFromConfig(clean));
      toast.success(ruleCount === 0 ? 'Float limits cleared.' : 'Float limits saved.');
    } catch (e) { toast.error(errMsg(e, 'Failed to save float limits.')); }
    finally { setSaving(false); }
  };

  const discard = () => {
    setRows(rowsFromConfig(saved));
    setDraft(d => ({ ...d, key: '', amount: '' }));
  };

  // ── How a stored key is shown back. The stored key is the raw thing the rule matches on (a
  // company id, an EPF); the label is what a human recognises. An unknown key still renders —
  // a deleted company or a person who left must stay visible so it can be removed.
  const companyName = (id: string) => companies.find(c => c.id === id)?.name ?? id;
  const personLabel = (epf: string) => {
    const u = allUsers.find(x => x.epf_number === epf) ?? employees.find(x => x.epf_number === epf);
    return u ? `${u.display_name} · ${epf}` : epf;
  };

  const checkUser = allUsers.find(u => u.epf_number === checkEpf) ?? employees.find(u => u.epf_number === checkEpf) ?? null;
  const checkResult = checkUser
    ? resolveSuspenseLimit(pending, {
        epf: checkUser.epf_number, role: checkUser.role, designation: checkUser.designation,
        department: checkUser.department, company_id: checkUser.company_id,
      })
    : null;

  const personOptions = useMemo(
    () => employees.map(u => ({
      value: u.epf_number,
      label: u.display_name,
      sublabel: [u.epf_number, u.role].filter(Boolean).join(' · '),
      keywords: [u.designation, u.department, u.company_name].filter(Boolean).join(' '),
    })),
    [employees],
  );

  // Every rule as one flat list, most specific first — the order the engine resolves in, so the
  // list itself teaches the ladder instead of five headings doing it.
  const flatRules = useMemo(() => {
    const order: Section[] = ['by_person', 'by_role', 'by_position', 'by_department', 'company_default'];
    return order.flatMap(section => rows[section].map(row => ({ section, row })));
  }, [rows]);

  const labelOf = (section: Section, key: string): string =>
    section === 'company_default' ? companyName(key) : section === 'by_person' ? personLabel(key) : key;

  const draftError = draft.key.trim() || draft.amount.trim()
    ? rowError({ rid: 'draft', key: draft.key, amount: draft.amount }, rows[draft.section])
    : '';

  // The picker for the level being added to. One control that changes, rather than five.
  const targetPicker = () => {
    const onChange = (v: string) => setDraft(d => ({ ...d, key: v }));
    switch (draft.section) {
      case 'company_default':
        return <Select value={draft.key} onChange={onChange} allowCustom={false} placeholder="Select company"
          options={companies.map(c => ({ value: c.id, label: c.name }))} />;
      case 'by_department':
        return <Combobox value={draft.key} onChange={onChange} allowCustom options={departments}
          placeholder={departments.length ? 'Select or type a department' : 'Type a department name'} />;
      case 'by_position':
        return <Combobox value={draft.key} onChange={onChange} allowCustom options={positions}
          placeholder={positions.length ? 'Select or type a position' : 'Type a position'} />;
      case 'by_role':
        return <Select value={draft.key} onChange={onChange} allowCustom={false} placeholder="Select role"
          options={roleNames.map(n => ({ value: n, label: n }))} />;
      default:
        return <SearchableSelect value={draft.key} onChange={onChange} options={personOptions}
          placeholder="Search staff" emptyLabel="No matching staff" ariaLabel="Person this limit applies to" />;
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-full max-w-lg" />
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-8 w-full rounded-md" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Gauge className="h-3.5 w-3.5" /> Float limits
        </Label>
        <Badge variant={ruleCount ? 'brand' : 'muted'}>{ruleCount} rule{ruleCount === 1 ? '' : 's'}</Badge>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Most specific wins: person, role, position, department, company. No rule means no limit; a limit of 0 means no float.
      </p>

      {/* Add a rule — one row: which level, who, how much. */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-2 sm:flex-row sm:items-start">
        <div className="w-full sm:w-40 sm:shrink-0">
          <Select
            value={draft.section}
            onChange={v => setDraft({ section: v as Section, key: '', amount: draft.amount })}
            allowCustom={false}
            options={SECTIONS.map(sec => ({ value: sec, label: SECTION_LABEL[sec] }))}
          />
        </div>
        <div className="min-w-0 flex-1">{targetPicker()}</div>
        <Input type="number" inputMode="numeric" min="0" step="1" value={draft.amount} disabled={saving}
          onChange={e => setDraft(d => ({ ...d, amount: e.target.value }))}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDraft(); } }}
          placeholder="Limit" aria-label="Limit amount"
          className="h-9 w-full tabular-nums sm:w-28" />
        <Button type="button" variant="outline" size="sm" className="h-9 w-full sm:w-auto" disabled={saving} onClick={addDraft}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
      <InlineError>{draftError}</InlineError>

      {/* Every rule, most specific first. */}
      {flatRules.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
          No limits set — anyone may hold any balance.
        </p>
      ) : (
        <div className="divide-y divide-border/60 rounded-lg border border-border">
          {flatRules.map(({ section, row }) => {
            const label = labelOf(section, row.key);
            const err = rowError(row, rows[section]);
            const Icon = SECTION_ICON[section];
            return (
              <div key={`${section}:${row.rid}`} className="px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="inline-flex w-24 shrink-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <Icon className="h-3 w-3" /> {SECTION_LABEL[section]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={label}>{label}</span>
                  <Input type="number" inputMode="numeric" min="0" step="1" value={row.amount} disabled={saving}
                    onChange={e => setRowAmount(section, row.rid, e.target.value)}
                    aria-label={`Limit for ${label}`} aria-invalid={!!err}
                    className="h-8 w-28 text-xs tabular-nums" />
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove the limit for ${label}`} disabled={saving} onClick={() => removeRow(section, row.rid)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <InlineError>{err}</InlineError>
              </div>
            );
          })}
        </div>
      )}

      {/* Resolve against the UNSAVED config: the point is to see what a rule you just typed
          would do to a real person before it starts refusing their approvals. */}
      <div className="flex flex-col gap-2 border-t border-border/60 pt-3 sm:flex-row sm:items-center">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground sm:shrink-0">Check</span>
        <div className="min-w-0 flex-1">
          <SearchableSelect value={checkEpf} onChange={setCheckEpf} options={personOptions}
            placeholder="Search staff" emptyLabel="No matching staff" ariaLabel="Person to check the limit for" />
        </div>
        {checkUser && checkResult && (
          <p className="min-w-0 text-xs text-muted-foreground sm:max-w-[50%] sm:text-right">
            {checkResult.limit === null ? (
              <span className="font-semibold text-foreground">No limit</span>
            ) : (
              <>
                <span className="font-semibold tabular-nums text-foreground">{formatSuspenseAmount(checkResult.limit, SUSPENSE_CURRENCY)}</span>
                {checkResult.source && (
                  <> · {LIMIT_SOURCE_LABEL[checkResult.source]}
                    {checkResult.source !== 'person' && checkResult.key ? `: ${checkResult.source === 'company' ? companyName(checkResult.key) : checkResult.key}` : ''}</>
                )}
              </>
            )}
            {dirty && <span className="text-warning"> · unsaved</span>}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        {dirty && (
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={discard}>
            <Undo2 className="h-3.5 w-3.5" /> Discard
          </Button>
        )}
        <Button type="button" size="sm" disabled={!dirty || saving || anyRowInvalid} onClick={save}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save limits'}
        </Button>
      </div>
    </div>
  );
}
