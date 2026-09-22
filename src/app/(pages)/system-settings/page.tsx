'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Copy, DatabaseBackup, Eye, RefreshCw, Search, SearchX, Settings, ShieldAlert,
  ShieldCheck, Wallet, SlidersHorizontal, Wrench, PartyPopper, X, CalendarRange,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useUserCapabilities } from '@/store/rolesStore';
import { useMaintenanceUiStore } from '@/store/maintenanceUiStore';
import { PageHeader } from '@/components/ui/page-header';
import { PageTransition, Reveal } from '@/components/ui/motion';
import { EmptyState } from '@/components/ui/empty-state';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import ConfirmModal from '@/components/ConfirmModal';
import SuspenseSettings from '@/components/suspense/SuspenseSettings';
import VoucherModeSettings from '@/components/suspense/VoucherModeSettings';
import GreetingsSettings from '@/components/system-settings/GreetingsSettings';
import WorkPatternSettings from '@/components/system-settings/WorkPatternSettings';
import SettingsBackupSettings, { formatSnapshotMoment } from '@/components/settings/SettingsBackupSettings';
import { useT } from '@/store/appStore';
import SuspenseLimitsSettings from '@/components/suspense/SuspenseLimitsSettings';
import { auth, tenant } from '@/lib/firebase';
import { APP_VERSION } from '@/lib/version';
import { describeSnapshot } from '@/lib/settingsBackup';
import { useSettingsBackupStore } from '@/store/settingsBackupStore';
import { cn } from '@/lib/utils';
import type { SuperAdminSyncResult } from '@/lib/superAdminSync';

// Tenants live in the `tenants` database now, so this page cannot look a label up locally —
// the sync result carries the id→label map it needs (see SuperAdminSyncResult.dbLabels).
const labelIn = (labels: Record<string, string> | undefined, dbId: string): string =>
  labels?.[dbId] ?? (dbId || 'Default database');

function CountChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 px-3 py-2">
      <div className="text-lg font-bold leading-none text-foreground">{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

/**
 * Superadmin mirroring across tenant databases — see src/lib/superAdminSync.ts for the model.
 * Nothing runs on mount: scanning every tenant's users collection is far too costly to do on a
 * page load, and a live sync writes accounts into databases the admin isn't even looking at.
 * Sync now stays disabled until a preview exists, so the confirmation can name real numbers.
 */
function SuperAdminSyncSettings() {
  const [busy,       setBusy]       = useState<'preview' | 'sync' | null>(null);
  const [result,     setResult]     = useState<SuperAdminSyncResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  const preview = result?.dryRun ? result : null;

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'preview' : 'sync');
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const res = await fetch('/api/admin/sync-superadmins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, dryRun }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Sync failed');
      setResult(data);
      if (!dryRun) toast.success(`${data.created + data.updated} mirrored, ${data.deleted} removed`);
    } catch (e) {
      toast.error((e as Error).message || 'Sync failed');
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Superadmin mirroring</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Copies every active superadmin into every tenant database so they can sign in
            anywhere, and removes those copies once someone is no longer an active superadmin.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" disabled={!!busy} onClick={() => run(true)}>
            {busy === 'preview' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            Preview
          </Button>
          <Button size="sm" disabled={!!busy || !preview} onClick={() => setConfirming(true)}>
            {busy === 'sync' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
            Sync now
          </Button>
        </div>
      </div>

      {result && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={result.dryRun ? 'muted' : 'success'}>
              {result.dryRun ? 'Preview only — nothing was written' : 'Sync applied'}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {result.databases.length} databases · {result.admins.length} active superadmins
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:max-w-md">
            <CountChip label={result.dryRun ? 'To create' : 'Created'} value={result.created} />
            <CountChip label={result.dryRun ? 'To refresh' : 'Refreshed'} value={result.updated} />
            <CountChip label={result.dryRun ? 'To remove' : 'Removed'} value={result.deleted} />
          </div>

          {/* A conflict means a real doc already sits where a mirror would go — the sync never
              touches it, so it stays broken until a person decides which record is right. */}
          {result.conflicts.length > 0 && (
            <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
                <AlertTriangle className="h-4 w-4" />
                {result.conflicts.length} blocked by an existing employee record
              </div>
              {result.conflicts.map(c => (
                <div key={`${c.dbId}-${c.epf}`} className="text-xs text-muted-foreground">
                  <span className="font-mono text-foreground">{c.epf}</span>
                  <span> in {labelIn(result.dbLabels, c.dbId)} — {c.reason}</span>
                </div>
              ))}
            </div>
          )}

          {result.errors.length > 0 && (
            <div className="space-y-1 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
              {result.errors.map((e, i) => (
                <div key={i}>{labelIn(result.dbLabels, e.dbId)}{e.epf ? ` · ${e.epf}` : ''}: {e.message}</div>
              ))}
            </div>
          )}

          {result.admins.length > 0 && (
            <div className="space-y-2">
              {result.admins.map(a => (
                <div key={a.epf} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-card/40 p-3 text-xs">
                  <span className="font-medium text-foreground">{a.name || a.epf}</span>
                  <span className="font-mono text-muted-foreground">{a.epf}</span>
                  <span className="text-muted-foreground">{a.email}</span>
                  <Badge variant="outline">Home: {labelIn(result.dbLabels, a.homeDb)}</Badge>
                  {a.mirroredTo.map(id => <Badge key={id} variant="muted">{labelIn(result.dbLabels, id)}</Badge>)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        open={confirming}
        onOpenChange={() => setConfirming(false)}
        variant="warning"
        title="Sync superadmins to every database?"
        description={preview
          ? `${preview.created + preview.updated} mirror ${preview.created + preview.updated === 1 ? 'account' : 'accounts'} will be written and ${preview.deleted} deleted across ${preview.databases.length} databases.${preview.conflicts.length ? ` ${preview.conflicts.length} blocked by an existing employee record will be skipped.` : ''}`
          : undefined}
        confirmText="Sync now"
        busy={busy === 'sync'}
        onConfirm={async () => {
          await run(false);
          setConfirming(false);
        }}
      />
    </div>
  );
}

/**
 * Planned maintenance — the admin entry point to the control popup.
 *
 * The popup itself is rendered globally by MaintenanceGate (root layout) and opened through the
 * shared store, so this works whether or not a window is currently armed. Until now the only way
 * in was the `window.maintenance(<password>)` console command (or, mid-window, the blocking
 * overlay's own button) — which meant scheduling a window ahead of time required knowing a
 * console incantation.
 */
function MaintenanceSettings() {
  const openControlPopup = useMaintenanceUiStore(s => s.openControlPopup);
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-foreground">Planned maintenance</h3>
        <p className="mt-1 max-w-prose text-xs text-muted-foreground">
          Schedule a window, adjust its times or the message staff see, or end one early. Everyone
          gets a countdown banner beforehand and a blocking screen while it runs; admins can still
          get in.
        </p>
      </div>
      <Button onClick={openControlPopup} className="shrink-0 gap-2">
        <SlidersHorizontal className="h-4 w-4" /> Open controls
      </Button>
    </div>
  );
}

// ─── The section model ─────────────────────────────────────────────────────────
// One entry per category. The rail, the search and the page body all read this same list, so
// adding a category is one object — there is no second place that has to agree with it.

type BadgeVariant = React.ComponentProps<typeof Badge>['variant'];

interface SettingsSection {
  id:          string;
  title:       string;
  description: string;
  icon:        React.ElementType;
  /** Extra words a person might search for — the settings inside, in their own language. */
  keywords:    string;
  /** Rail chip. Defaults to the number of settings in the category. */
  chip?:       { label: string; variant: BadgeVariant };
  /** Each entry becomes one block, separated from the next by a rule. */
  items:       React.ReactNode[];
}

function matchesQuery(section: SettingsSection, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${section.title} ${section.description} ${section.keywords}`.toLowerCase();
  // Every word must match somewhere: "voucher limit" should find the suspense card, while
  // "voucher payroll" should find nothing rather than everything.
  return q.split(/\s+/).every(word => hay.includes(word));
}

/** The scrollable ancestor an element actually lives in — the app shell scrolls its own
 *  content div, not the window, so an observer rooted at the viewport drifts. */
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Which section is currently under the top of the viewport. Tracks the set of sections in view
 * and reports the first of them in page order, so scrolling through a tall category doesn't
 * hand the highlight to the one below it.
 */
function useScrollSpy(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const inView = useRef<Set<string>>(new Set());
  const key = ids.join('|');

  useEffect(() => {
    const order = key ? key.split('|') : [];
    inView.current = new Set();
    if (!order.length) { setActive(null); return; }

    const elements = order
      .map(id => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (!elements.length) { setActive(null); return; }

    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) inView.current.add(entry.target.id);
        else inView.current.delete(entry.target.id);
      }
      const first = order.find(id => inView.current.has(id));
      // Between two sections nothing qualifies; keeping the last answer beats blanking the rail.
      setActive(prev => first ?? prev);
    }, {
      root: scrollParentOf(elements[0]),
      // Ignore the sticky chip row at the top, and stop counting a section once its heading has
      // scrolled past the middle of the screen.
      rootMargin: '-72px 0px -55% 0px',
      threshold: 0,
    });

    elements.forEach(el => observer.observe(el));
    setActive(order[0]);
    return () => observer.disconnect();
  }, [key]);

  return active;
}

// ─── The system summary strip ──────────────────────────────────────────────────
// Every figure here is read from something real: the tenant the server injected into this page
// (window.__TENANT__, via the `tenant` const in @/lib/firebase), the version file the release
// workflow edits, and the settings-backup history. Nothing on this strip is a placeholder.
function SystemSummary() {
  const snapshots = useSettingsBackupStore(s => s.snapshots);
  const loaded    = useSettingsBackupStore(s => s.loaded);
  const last      = snapshots[0] ?? null;

  // The cross-cutting subsystems only. The per-page flags are /platform's business, and thirty
  // badges would say less than four.
  const modules: Array<{ key: string; label: string; on: boolean }> = [
    { key: 'suspense', label: 'Suspense',   on: tenant.features.suspense },
    { key: 'payroll',  label: 'Payroll',    on: tenant.features.payroll },
    { key: 'solarApp', label: 'Solar App',  on: tenant.features.solarApp },
    { key: 'whatsNew', label: "What's New", on: tenant.features.whatsNew },
  ];
  const enabled = modules.filter(m => m.on);

  return (
    <Card className="p-4 sm:p-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Organisation
          </div>
          <div className="mt-1 truncate text-sm font-semibold text-foreground">{tenant.label}</div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {tenant.id} · {tenant.dbId || 'default'} database
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Modules
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {enabled.length === 0
              ? <span className="text-xs text-muted-foreground">No optional modules</span>
              : enabled.map(m => <Badge key={m.key} variant="muted">{m.label}</Badge>)}
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            App version
          </div>
          <div className="mt-1 font-mono text-sm font-semibold text-foreground">{APP_VERSION}</div>
        </div>

        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Settings backup
          </div>
          {!loaded ? (
            <div className="mt-1 text-xs text-muted-foreground">Checking…</div>
          ) : last ? (
            <>
              <div className="mt-1 truncate text-sm font-semibold text-foreground">
                {formatSnapshotMoment(last.taken_at)}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {last.taken_by_name ? `${last.taken_by_name} · ` : ''}{describeSnapshot(last)}
              </div>
            </>
          ) : (
            <div className="mt-1 text-sm font-semibold text-warning">Never backed up</div>
          )}
        </div>
      </div>
    </Card>
  );
}

// Application-wide settings, grouped by functional area and navigable from a rail. To add a
// category, push one more object into `sections` below — the rail, the search index and the
// page body are all built from that one list.
export default function SystemSettingsPage() {
  const caps = useUserCapabilities();
  const t = useT();
  const [query, setQuery] = useState('');

  // The summary strip and the Backup category both want the history; the store makes that one
  // request. Loaded here so the strip has an answer before the section is scrolled to.
  const loadBackups     = useSettingsBackupStore(s => s.load);
  const backupSnapshots = useSettingsBackupStore(s => s.snapshots);
  const backupsLoaded   = useSettingsBackupStore(s => s.loaded);

  // Automatic greetings — admins and user managers configure them; no suspense dependency.
  const canGreetings = caps.is_system_admin || caps.can_manage_users;
  // Suspense settings are Alta Vision-only; other categories can drop the tenant check when added.
  const canSuspense = tenant.features.suspense && (caps.is_system_admin || caps.can_approve_suspense);
  // Mirroring hands an account admin standing in every tenant database — System Admin only,
  // matching the gate on /api/admin/sync-superadmins.
  const canSyncSuperAdmins = caps.is_system_admin;
  // Arming maintenance takes the whole app offline for everyone — System Admin only, matching
  // the live role check inside window.maintenance().
  const canMaintenance = caps.is_system_admin;
  // Patterns restate everyone's gauge and month summary, so this sits with scheduling
  // rather than with user administration — same reach as editing a roster.
  const canWorkPatterns = caps.is_system_admin || caps.can_manage_working_schedules || caps.can_manage_shifts;
  // The settings backup copies configuration into the shared tenants database — the same System
  // Admin gate /api/admin/settings-backup enforces.
  const canBackup = caps.is_system_admin;

  useEffect(() => {
    if (canBackup) void loadBackups();
  }, [canBackup, loadBackups]);

  const sections = useMemo<SettingsSection[]>(() => {
    const list: SettingsSection[] = [];

    if (canMaintenance) list.push({
      id: 'maintenance',
      title: 'Maintenance',
      description: 'Take the app offline for a planned window.',
      icon: Wrench,
      keywords: 'downtime offline window banner countdown blocking screen schedule outage',
      items: [<MaintenanceSettings key="maintenance" />],
    });

    if (canGreetings) list.push({
      id: 'greetings',
      title: t.greetingsSettingsTitle,
      description: t.greetingsSettingsDesc,
      icon: PartyPopper,
      keywords: 'greeting birthday wish anniversary message automatic notification celebration',
      items: [<GreetingsSettings key="greetings" />],
    });

    if (canWorkPatterns) list.push({
      id: 'work-patterns',
      title: 'Working time',
      description: 'Which days are worked and for how long, and what working a holiday or rest day is worth.',
      icon: CalendarRange,
      keywords: 'work pattern week weekday rest day half day hours expected shift roster saturday sunday holiday poya premium multiplier overtime rate',
      items: [<WorkPatternSettings key="work-patterns" />],
    });

    if (canSuspense) list.push({
      id: 'suspense',
      title: 'Suspense',
      description: 'Expense float — voucher grouping, float limits and expense categories.',
      icon: Wallet,
      keywords: 'voucher grouping mode bills expense float limit balance categories reimbursement advance',
      items: [
        <VoucherModeSettings key="voucher" />,
        <SuspenseLimitsSettings key="limits" />,
        <SuspenseSettings key="categories" />,
      ],
    });

    if (canSyncSuperAdmins) list.push({
      id: 'access',
      title: 'Access',
      description: 'Superadmin accounts across tenant databases.',
      icon: ShieldCheck,
      keywords: 'superadmin mirror sync admin account tenant database sign in permission',
      items: [<SuperAdminSyncSettings key="superadmins" />],
    });

    // Last on purpose: it is the thing you reach for after changing everything above it.
    if (canBackup) list.push({
      id: 'backup',
      title: 'Backup',
      description: 'Copy this tenant’s configuration into the shared tenants database.',
      icon: DatabaseBackup,
      keywords: 'backup snapshot restore export settings copy tenant database disaster recovery download json',
      chip: backupsLoaded
        ? (backupSnapshots.length > 0
            ? { label: String(backupSnapshots.length), variant: 'success' as BadgeVariant }
            : { label: 'Never', variant: 'warning' as BadgeVariant })
        : undefined,
      items: [<SettingsBackupSettings key="settings-backup" />],
    });

    return list;
  }, [
    canMaintenance, canGreetings, canSuspense, canSyncSuperAdmins, canBackup,
    t.greetingsSettingsTitle, t.greetingsSettingsDesc, backupsLoaded, backupSnapshots.length,
  ]);

  const visible   = useMemo(() => sections.filter(s => matchesQuery(s, query)), [sections, query]);
  const visibleIds = useMemo(() => visible.map(s => s.id), [visible]);
  const activeId  = useScrollSpy(visibleIds);

  const goTo = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  if (sections.length === 0) {
    return (
      <PageTransition>
        <EmptyState icon={ShieldAlert} title="No access"
          description="System settings are available to administrators and suspense approvers." />
      </PageTransition>
    );
  }

  return (
    <PageTransition className="space-y-6">
      <PageHeader icon={Settings} title="System Settings" description="Configure application-wide settings." />

      {canBackup && <SystemSummary />}

      {/* Search first: on a screen made of categories, finding one beats scrolling to it. */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search settings — try “voucher”, “backup”, “maintenance”"
          aria-label="Search settings"
          className="h-10 pl-9 pr-9"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No settings match that"
          description={`Nothing here matches “${query.trim()}”.`}
          action={<Button variant="outline" onClick={() => setQuery('')}>Clear search</Button>}
        />
      ) : (
        <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-6 lg:items-start">
          {/* ── The rail ──────────────────────────────────────────────────────────
              A column on lg+, a scrolling chip row pinned under the header on phones. Both are
              the same list of buttons; only the box around them changes. */}
          <nav
            aria-label="Settings categories"
            className={cn(
              // The negative margins cancel the shell's own page padding so the pinned row
              // spans the full width; they have to track it at each breakpoint (p-4 → md:p-6).
              'sticky top-0 z-20 -mx-4 mb-4 border-b border-border bg-background/85 px-4 py-2 backdrop-blur-xl md:-mx-6 md:px-6',
              'lg:mx-0 lg:mb-0 lg:top-4 lg:border-0 lg:bg-transparent lg:px-0 lg:py-0 lg:backdrop-blur-none',
            )}
          >
            <ul className="flex gap-2 overflow-x-auto scrollbar-none lg:flex-col lg:gap-1 lg:overflow-visible">
              {visible.map(section => {
                const Icon = section.icon;
                const isActive = section.id === activeId;
                const chip = section.chip ?? { label: String(section.items.length), variant: 'muted' as BadgeVariant };
                return (
                  <li key={section.id} className="shrink-0 lg:shrink">
                    <button
                      type="button"
                      onClick={() => goTo(section.id)}
                      aria-current={isActive ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                        // --primary, --success and --brand are the same azure, so the current
                        // row is marked by weight and a filled ground, never by hue alone.
                        isActive
                          ? 'bg-primary/10 font-semibold text-primary'
                          : 'font-medium text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden />
                      <span className="truncate">{section.title}</span>
                      <Badge variant={chip.variant} className="ml-auto hidden shrink-0 lg:inline-flex">
                        {chip.label}
                      </Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="space-y-6">
            {visible.map((section, i) => {
              const Icon = section.icon;
              return (
                <Reveal key={section.id} delay={Math.min(i, 4) * 0.05}>
                  {/* scroll-mt keeps the heading clear of the sticky chip row on phones. */}
                  <section id={section.id} className="scroll-mt-20 lg:scroll-mt-6">
                    <Card>
                      <div className="flex items-start gap-3 p-5 pb-4">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Icon className="h-4 w-4" aria-hidden />
                        </div>
                        <div className="min-w-0">
                          <h2 className="text-base font-semibold tracking-tight text-foreground">{section.title}</h2>
                          <p className="mt-0.5 text-xs text-muted-foreground">{section.description}</p>
                        </div>
                      </div>
                      <Separator />
                      {/* One card per category, its settings ruled off from each other — the
                          old page stacked a floating Card per setting and read as a pile. */}
                      <div className="divide-y divide-border">
                        {section.items.map((item, index) => (
                          <div key={index} className="p-5">{item}</div>
                        ))}
                      </div>
                    </Card>
                  </section>
                </Reveal>
              );
            })}
          </div>
        </div>
      )}
    </PageTransition>
  );
}
