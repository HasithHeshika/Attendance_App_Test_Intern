'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import toast from 'react-hot-toast';
import {
  ShieldCheck, ShieldAlert, Building2, History, Users, Plus, RotateCcw, LogOut, Loader2, Globe,
  Database, ArrowLeft,
} from 'lucide-react';
import { auth, googleProvider } from '@/lib/firebase';
import { getUserByUid } from '@/services/userService';
import { getRoles } from '@/services/roleService';
import { isSuperAdminUser } from '@/lib/permissions';
import {
  FEATURE_GROUPS, FEATURE_LABELS, FEATURE_UMBRELLA, type Tenant, type TenantFeatures,
} from '@/lib/tenants';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

/**
 * Platform configuration — who every domain is, and which modules it gets.
 *
 * Deliberately outside the (pages) app shell. It has its own sign-in and talks only to
 * /api/platform/*, so a platform administrator never needs a users document in whichever
 * tenant database they happen to have landed on. There is no nav link to it anywhere; a
 * signed-in platform admin gets a button in the sidebar footer, everyone else gets a 404 from
 * the API and the "nothing here" screen below.
 *
 * The API is the authority on access. This page renders what it is allowed to see; it never
 * decides what that is.
 */

interface TenantRecord extends Tenant {
  createdAt: string | null; createdBy: string; updatedAt: string | null; updatedBy: string;
}
interface PlatformAdminRow {
  email: string; name: string; addedBy: string; addedAt: string | null;
  disabled: boolean; isBootstrap: boolean;
}
interface AuditRow {
  id: string; tenantId: string | null; actorEmail: string; at: string | null;
  action: string; changed: string[];
}
type Screen = 'loading' | 'signedOut' | 'denied' | 'ready';
type Tab = 'tenants' | 'admins' | 'history';
type Api = (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export default function PlatformPage() {
  const [user, setUser] = useState<User | null>(null);
  const [screen, setScreen] = useState<Screen>('loading');
  const [tab, setTab] = useState<Tab>('tenants');
  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [isBootstrap, setIsBootstrap] = useState(false);
  const [busy, setBusy] = useState(false);
  // Refused, but the person holds Super Admin in the tenant this page was served from. Resolved
  // ONLY on the refusal path, against that tenant's own database — it changes what the screen
  // says, never whether the API opens.
  const [superAdminHere, setSuperAdminHere] = useState(false);

  /** Every call carries a freshly-minted ID token; the server re-checks the list each time. */
  const api = useCallback<Api>(async (path, init) => {
    const current = auth.currentUser;
    if (!current) throw new Error('Signed out.');
    const token = await current.getIdToken();
    const res = await fetch(`/api/platform/${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
        Authorization: `Bearer ${token}`,
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
    return body;
  }, []);

  const loadTenants = useCallback(async () => {
    const body = await api('tenants');
    setTenants((body.tenants as TenantRecord[]) ?? []);
    setIsBootstrap(!!(body.caller as { isBootstrap?: boolean } | undefined)?.isBootstrap);
  }, [api]);

  useEffect(() => onAuthStateChanged(auth, async (u) => {
    setUser(u);
    if (!u) { setScreen('signedOut'); return; }
    try {
      await loadTenants();
      setScreen('ready');
    } catch {
      // A 404 here means "you are not a platform administrator". It reads the same as a route
      // that does not exist, which is the intent — for everyone except the one person who was
      // told, by their own sidebar, that this page was for them. Ask the tenant database this
      // page was served from whether they hold Super Admin there; if so they get a specific
      // answer below instead of "nothing here". This is a read of their OWN tenant only, and
      // it changes copy, not access.
      try {
        const [profile, roles] = await Promise.all([getUserByUid(u.uid), getRoles()]);
        setSuperAdminHere(isSuperAdminUser({
          role:           profile?.role,
          employee_type:  profile?.employee_type,
          is_super_admin: profile?.is_super_admin,
        }, roles));
      } catch {
        setSuperAdminHere(false);   // no profile here, or rules said no — generic screen
      }
      setScreen('denied');
    }
  }), [loadTenants]);

  const signIn = async () => {
    try { await signInWithPopup(auth, googleProvider); }
    catch { toast.error('Sign-in failed.'); }
  };

  if (screen === 'loading') {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </main>
    );
  }

  // Refused, but this person runs the system they came from. Say exactly why the door is shut
  // and exactly what opens it — and nothing whatsoever about any other organisation, which
  // they have no standing to be told about.
  if (screen === 'denied' && superAdminHere) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center p-6">
        <Card className="w-full max-w-md p-6">
          <ShieldAlert className="h-8 w-8 text-warning" />
          <h1 className="mt-3 text-lg font-semibold">Platform configuration is granted separately</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            You hold the Super Admin role in this system, which gives you full access to it — and
            to any other organisation your account has been added to.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            This page is not part of that. It configures the platform itself, and access to it is
            held in a separate list that no role can grant. An existing platform administrator has
            to add <span className="font-medium text-foreground">{user?.email}</span> to it. Once
            they have, this page opens on your next visit.
          </p>
          <div className="mt-5 flex gap-2">
            <Button className="flex-1" asChild>
              <a href="/dashboard">Back to app</a>
            </Button>
            <Button variant="outline" onClick={() => signOut(auth)}>
              Sign out
            </Button>
          </div>
        </Card>
      </main>
    );
  }

  if (screen === 'signedOut' || screen === 'denied') {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center p-6">
        <Card className="w-full max-w-sm p-6 text-center">
          {screen === 'signedOut' ? (
            <>
              <ShieldCheck className="mx-auto h-8 w-8 text-muted-foreground" />
              <h1 className="mt-3 text-lg font-semibold">Platform configuration</h1>
              <p className="mt-1 text-sm text-muted-foreground">Restricted. Sign in to continue.</p>
              <Button className="mt-5 w-full" onClick={signIn}>Sign in with Google</Button>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold">Nothing here</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                This page isn’t available for {user?.email}.
              </p>
              <Button className="mt-5 w-full" asChild>
                <a href="/dashboard">Back to app</a>
              </Button>
              <Button variant="outline" className="mt-2 w-full" onClick={() => signOut(auth)}>
                Sign out
              </Button>
            </>
          )}
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <ShieldCheck className="h-5 w-5 text-primary" /> Platform configuration
          </h1>
          {/* Not a <p>: Badge renders a <div>, which is invalid inside one and breaks
              hydration. Same span + Badge shape the admin rows below use. */}
          <div className="mt-0.5 flex items-center gap-2 text-sm text-muted-foreground">
            <span>{user?.email}</span>
            {isBootstrap && <Badge variant="outline">Bootstrap</Badge>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* A plain navigation, not a router push: /platform lives outside the (pages) app
              shell, so going back has to re-enter it. */}
          <Button variant="outline" size="sm" asChild>
            <a href="/dashboard">
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Back to app
            </a>
          </Button>
          <Button variant="outline" size="sm" onClick={() => signOut(auth)}>
            <LogOut className="mr-1.5 h-3.5 w-3.5" /> Sign out
          </Button>
        </div>
      </header>

      <nav className="mb-6 flex gap-1">
        {([
          ['tenants', 'Tenants', Building2],
          ['admins', 'Administrators', Users],
          ['history', 'History', History],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              tab === key ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </nav>

      {tab === 'tenants' && (
        <TenantsTab
          tenants={tenants}
          isBootstrap={isBootstrap}
          busy={busy}
          setBusy={setBusy}
          api={api}
          reload={loadTenants}
        />
      )}
      {tab === 'admins' && <AdminsTab isBootstrap={isBootstrap} api={api} />}
      {tab === 'history' && <HistoryTab api={api} reload={loadTenants} />}
    </main>
  );
}

// ─── Tenants ──────────────────────────────────────────────────────────────────

function TenantsTab({ tenants, isBootstrap, busy, setBusy, api, reload }: {
  tenants: TenantRecord[]; isBootstrap: boolean; busy: boolean;
  setBusy: (b: boolean) => void; api: Api; reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const current = tenants.find(t => t.id === editing) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {tenants.length} registered {tenants.length === 1 ? 'tenant' : 'tenants'}
        </p>
        {isBootstrap && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Register tenant
          </Button>
        )}
      </div>

      {tenants.map(t => (
        <Card key={t.id} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{t.label}</span>
                <Badge variant={t.status === 'active' ? 'outline' : 'muted'}>{t.status}</Badge>
                {t.appName !== t.label && (
                  <span className="text-xs text-muted-foreground">shows as “{t.appName}”</span>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Globe className="h-3 w-3" />
                  {t.domains.length ? t.domains.join(', ') : 'no domains'}
                </span>
                <span className="flex items-center gap-1 font-mono">
                  <Database className="h-3 w-3" /> {t.dbId || '(default)'}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground/70">
                Updated {fmt(t.updatedAt)}{t.updatedBy ? ` by ${t.updatedBy}` : ''}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setEditing(t.id)}>Configure</Button>
          </div>
        </Card>
      ))}

      {current && (
        <TenantEditor
          key={current.id}
          tenant={current}
          isBootstrap={isBootstrap}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            setBusy(true);
            try {
              await api('tenants', {
                method: 'PATCH',
                body: JSON.stringify({ id: current.id, ...patch }),
              });
              await reload();
              toast.success(`${current.label} updated.`);
              setEditing(null);
            } catch (e) {
              toast.error(e instanceof Error ? e.message : 'Save failed.');
            } finally { setBusy(false); }
          }}
        />
      )}

      {creating && (
        <CreateTenantDialog
          busy={busy}
          onClose={() => setCreating(false)}
          onCreate={async (body) => {
            setBusy(true);
            try {
              await api('tenants', { method: 'POST', body: JSON.stringify(body) });
              await reload();
              toast.success(`${body.id} registered.`);
              setCreating(false);
            } catch (e) {
              toast.error(e instanceof Error ? e.message : 'Could not register.');
            } finally { setBusy(false); }
          }}
        />
      )}
    </div>
  );
}

function TenantEditor({ tenant, isBootstrap, busy, onClose, onSave }: {
  tenant: TenantRecord; isBootstrap: boolean; busy: boolean;
  onClose: () => void; onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [label, setLabel] = useState(tenant.label);
  const [appName, setAppName] = useState(tenant.appName);
  const [themeColor, setThemeColor] = useState(tenant.themeColor);
  const [brandDir, setBrandDir] = useState(tenant.brandDir ?? '');
  const [domains, setDomains] = useState(tenant.domains.join('\n'));
  const [features, setFeatures] = useState<TenantFeatures>({ ...tenant.features });
  const [confirming, setConfirming] = useState(false);

  const domainList = useMemo(
    () => domains.split(/[\s,]+/).map(d => d.trim()).filter(Boolean),
    [domains],
  );

  const changes = useMemo(() => {
    const out: string[] = [];
    if (label !== tenant.label) out.push(`Label → “${label}”`);
    if (appName !== tenant.appName) out.push(`App name → “${appName}”`);
    if (themeColor !== tenant.themeColor) out.push(`Theme colour → ${themeColor}`);
    if ((brandDir || null) !== tenant.brandDir) out.push(`Brand folder → ${brandDir || 'none'}`);
    if (domainList.join(',') !== tenant.domains.join(',')) {
      out.push(`Domains → ${domainList.join(', ') || 'none'}`);
    }
    for (const k of Object.keys(features) as Array<keyof TenantFeatures>) {
      if (features[k] !== tenant.features[k]) {
        out.push(`${FEATURE_LABELS[k]} ${features[k] ? 'on' : 'off'}`);
      }
    }
    return out;
  }, [label, appName, themeColor, brandDir, domainList, features, tenant]);

  const save = () => onSave({
    label, appName, themeColor, brandDir: brandDir || null, domains: domainList, features,
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tenant.label}</DialogTitle>
          <DialogDescription>
            Changes take effect on every domain of this tenant within a minute.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="p-label">Label</Label>
              <Input id="p-label" value={label} onChange={e => setLabel(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="p-app">App name (browser tab, PWA)</Label>
              <Input id="p-app" value={appName} onChange={e => setAppName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="p-color">Theme colour</Label>
              <div className="flex gap-2">
                <Input id="p-color" value={themeColor} onChange={e => setThemeColor(e.target.value)} />
                <input
                  type="color" aria-label="Pick theme colour" value={themeColor}
                  onChange={e => setThemeColor(e.target.value)}
                  className="h-9 w-10 shrink-0 rounded-md border border-input bg-card"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="p-brand">Brand folder</Label>
              <Input
                id="p-brand" value={brandDir} placeholder="none"
                onChange={e => setBrandDir(e.target.value)}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Names a folder under <code>public/brand/</code>. Its images ship with a deploy.
              </p>
            </div>
          </section>

          <section>
            <Label htmlFor="p-domains">Domains — one per line</Label>
            <textarea
              id="p-domains" rows={3} value={domains} onChange={e => setDomains(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-sm"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Subdomains match automatically. Database:{' '}
              <span className="font-mono">{tenant.dbId || '(default)'}</span> — fixed at
              registration and not editable.
            </p>
          </section>

          {FEATURE_GROUPS.map(group => (
            <section key={group.title}>
              <h3 className="text-sm font-semibold">{group.title}</h3>
              <p className="mb-2 text-xs text-muted-foreground">{group.description}</p>
              <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                {group.keys.map(k => {
                  const umbrella = FEATURE_UMBRELLA[k];
                  const inert = !!umbrella && !features[umbrella];
                  return (
                    <label key={k} className="flex items-center justify-between gap-2 py-1.5">
                      <span className={`text-sm ${inert ? 'text-muted-foreground/60' : ''}`}>
                        {FEATURE_LABELS[k]}
                        {inert && umbrella && (
                          <span className="ml-1.5 text-[10px] uppercase tracking-wide">
                            needs {FEATURE_LABELS[umbrella]}
                          </span>
                        )}
                      </span>
                      <Switch
                        checked={features[k]}
                        onCheckedChange={(v) => setFeatures(f => ({ ...f, [k]: v }))}
                      />
                    </label>
                  );
                })}
              </div>
            </section>
          ))}

          {isBootstrap && (
            <section className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">
                    {tenant.status === 'active' ? 'Disable this tenant' : 'Enable this tenant'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    A disabled tenant stops resolving — every one of its domains goes offline.
                  </p>
                </div>
                <Button
                  variant="outline" size="sm" disabled={busy}
                  onClick={() => onSave({ status: tenant.status === 'active' ? 'disabled' : 'active' })}
                >
                  {tenant.status === 'active' ? 'Disable' : 'Enable'}
                </Button>
              </div>
            </section>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => setConfirming(true)} disabled={busy || changes.length === 0}>
            {changes.length === 0
              ? 'No changes'
              : `Save ${changes.length} change${changes.length === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>

        {confirming && (
          <Dialog open onOpenChange={(o) => { if (!o) setConfirming(false); }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Apply to {tenant.domains[0] ?? tenant.label}?</DialogTitle>
                <DialogDescription>
                  These take effect for everyone on this tenant within a minute.
                </DialogDescription>
              </DialogHeader>
              <ul className="max-h-56 list-disc space-y-1 overflow-y-auto pl-5 text-sm">
                {changes.map(c => <li key={c}>{c}</li>)}
              </ul>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirming(false)}>Back</Button>
                <Button onClick={() => { setConfirming(false); void save(); }} disabled={busy}>
                  Apply
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateTenantDialog({ busy, onClose, onCreate }: {
  busy: boolean; onClose: () => void;
  onCreate: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [dbId, setDbId] = useState('');
  const [domains, setDomains] = useState('');

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register a tenant</DialogTitle>
          <DialogDescription>
            Associates a domain with a Firestore database that <strong>already exists</strong>.
            Create the database, deploy its rules and indexes, and add the domain to Firebase
            Auth’s authorised list first.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="c-id">Id</Label>
            <Input
              id="c-id" value={id} placeholder="northern-clinic"
              onChange={e => setId(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Permanent. Lowercase letters, digits and hyphens.
            </p>
          </div>
          <div>
            <Label htmlFor="c-label">Label</Label>
            <Input id="c-label" value={label} onChange={e => setLabel(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="c-db">Firestore database id</Label>
            <Input
              id="c-db" value={dbId} placeholder="(default)" className="font-mono"
              onChange={e => setDbId(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Cannot be changed afterwards — it decides whose data this domain serves.
            </p>
          </div>
          <div>
            <Label htmlFor="c-domains">Domains — one per line</Label>
            <textarea
              id="c-domains" rows={2} value={domains} onChange={e => setDomains(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            disabled={busy || !id.trim()}
            onClick={() => onCreate({
              id: id.trim(), label: label.trim() || id.trim(), dbId: dbId.trim(),
              domains: domains.split(/[\s,]+/).map(d => d.trim()).filter(Boolean),
            })}
          >
            Register
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Administrators ───────────────────────────────────────────────────────────

function AdminsTab({ isBootstrap, api }: { isBootstrap: boolean; api: Api }) {
  const [admins, setAdmins] = useState<PlatformAdminRow[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setAdmins(((await api('admins')).admins as PlatformAdminRow[]) ?? []); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not load administrators.'); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); await load(); toast.success(ok); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Platform administrators configure every tenant. This is separate from a tenant’s own
        system admins, who have no access here.
      </p>

      {isBootstrap && (
        <Card className="flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-[12rem] flex-1">
            <Label htmlFor="a-email">Email</Label>
            <Input
              id="a-email" type="email" value={email} placeholder="person@example.com"
              onChange={e => setEmail(e.target.value)}
            />
          </div>
          <div className="min-w-[10rem] flex-1">
            <Label htmlFor="a-name">Name</Label>
            <Input id="a-name" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <Button
            disabled={busy || !email.trim()}
            onClick={() => act(
              async () => {
                await api('admins', { method: 'POST', body: JSON.stringify({ email, name }) });
                setEmail(''); setName('');
              },
              'Access granted.',
            )}
          >
            Grant access
          </Button>
        </Card>
      )}

      {admins.map(a => (
        <Card key={a.email} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{a.name || a.email}</span>
              {a.isBootstrap && <Badge variant="outline">Bootstrap</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">{a.email}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground/70">
              {a.isBootstrap
                ? 'Defined in code — cannot be revoked.'
                : `Added ${fmt(a.addedAt)}${a.addedBy ? ` by ${a.addedBy}` : ''}`}
            </p>
          </div>
          {isBootstrap && !a.isBootstrap && (
            <Button
              variant="outline" size="sm" disabled={busy}
              onClick={() => act(
                () => api(`admins?email=${encodeURIComponent(a.email)}`, { method: 'DELETE' }),
                'Access revoked.',
              )}
            >
              Revoke
            </Button>
          )}
        </Card>
      ))}
    </div>
  );
}

// ─── History ──────────────────────────────────────────────────────────────────

function HistoryTab({ api, reload }: { api: Api; reload: () => Promise<void> }) {
  const [entries, setEntries] = useState<AuditRow[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setEntries(((await api('audit')).entries as AuditRow[]) ?? []); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not load history.'); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const restore = async (entryId: string) => {
    setBusy(true);
    try {
      await api('audit', { method: 'POST', body: JSON.stringify({ entryId }) });
      await Promise.all([load(), reload()]);
      toast.success('Restored.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Restore failed.');
    } finally { setBusy(false); }
  };

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No changes recorded yet.</p>;
  }

  return (
    <div className="space-y-2">
      {entries.map(e => (
        <Card key={e.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="muted">{e.action}</Badge>
              <span className="text-sm font-medium">{e.tenantId ?? 'administrators'}</span>
              <span className="text-xs text-muted-foreground">{fmt(e.at)}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {e.actorEmail}
              {e.changed.length > 0 && ` · ${e.changed.slice(0, 6).join(', ')}`}
              {e.changed.length > 6 && ` +${e.changed.length - 6} more`}
            </p>
          </div>
          {e.tenantId && e.action !== 'create' && e.action !== 'restore' && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => restore(e.id)}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Restore
            </Button>
          )}
        </Card>
      ))}
    </div>
  );
}
