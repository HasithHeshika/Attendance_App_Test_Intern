'use client';
import { useState, useEffect } from 'react';
import {
  TerminalSquare, Send, Plus, Trash2, Loader2, Copy, Check, ShieldAlert,
} from 'lucide-react';
import { auth } from '@/lib/firebase';
import { useUserCapabilities } from '@/store/rolesStore';
import { useAuthStore } from '@/store/authStore';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import CloudStoragePanel from '@/components/settings/CloudStoragePanel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { PageTransition, Reveal } from '@/components/ui/motion';

type Method = 'GET' | 'POST';
interface ParamRow { k: string; v: string }
interface Preset { name: string; method: Method; path: string; query: ParamRow[]; body?: string; hint?: string }

// One entry per documented Solar external endpoint — click to load into the builder.
const PRESETS: Preset[] = [
  { name: 'Projects / sites (GPS)', method: 'GET', path: '/api/external/projects',
    query: [{ k: 'withGps', v: '1' }], hint: 'Installed sites: name, contact, GPS' },
  { name: 'Service records', method: 'GET', path: '/api/external/services',
    query: [{ k: 'status', v: '' }], hint: 'status / source / projectNo' },
  { name: 'Service plans + people', method: 'GET', path: '/api/external/service-plans',
    query: [], hint: 'Upcoming plans, assigned email/phone/EPF' },
  { name: 'Notifications (per user)', method: 'GET', path: '/api/external/notifications',
    query: [{ k: 'email', v: '' }], hint: 'one of epf / email / phone required' },
  { name: 'EPF — look up', method: 'GET', path: '/api/external/users/epf',
    query: [{ k: 'epf', v: '' }], hint: 'epf / email / phone' },
  { name: 'EPF — sync (POST)', method: 'POST', path: '/api/external/users/epf',
    query: [], body: '{\n  "email": "",\n  "epfNumber": "",\n  "phone": ""\n}', hint: 'push an EPF number' },
  { name: 'Next-available service', method: 'GET', path: '/api/external/services/next-available',
    query: [], hint: 'next free service per proposal' },
];

interface ProxyResult { status: number; ok: boolean; ms: number; data: unknown }

interface FilledReq { method: Method; path: string; params: ParamRow[]; body: string }

// Auto-fill a preset with the signed-in user's own identity so per-user endpoints
// (notifications, EPF) return real data with a single click.
function fillPreset(p: Preset, id: { epf: string; email: string; phone: string }): FilledReq {
  const { epf, email, phone } = id;
  let params = p.query.map(q => ({ ...q }));
  let body   = p.body ?? '';

  const today = new Date().toISOString().slice(0, 10);

  if (p.path.endsWith('/notifications')) {
    // Match by the strongest identity available (EPF → email), plus a small page size.
    params = [epf ? { k: 'epf', v: epf } : { k: 'email', v: email }, { k: 'limit', v: '20' }];
  } else if (p.path.endsWith('/service-plans')) {
    params = [{ k: 'from', v: today }];
  } else if (p.path.endsWith('/users/epf') && p.method === 'GET') {
    params = epf ? [{ k: 'epf', v: epf }] : [{ k: 'email', v: email }];
  } else if (p.path.endsWith('/users/epf') && p.method === 'POST') {
    body = JSON.stringify({ email, epfNumber: epf, phone }, null, 2);
  }
  return { method: p.method, path: p.path, params: params.length ? params : [{ k: '', v: '' }], body };
}

export default function ApiPlaygroundPage() {
  const caps = useUserCapabilities();
  const user = useAuthStore(s => s.user);

  const [method, setMethod] = useState<Method>('GET');
  const [path,   setPath]   = useState('/api/external/projects');
  const [params, setParams] = useState<ParamRow[]>([{ k: 'withGps', v: '1' }]);
  const [body,   setBody]   = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ProxyResult | null>(null);
  const [error,  setError]  = useState('');
  const [copied, setCopied] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, { status: number; ms: number; ok: boolean }>>({});
  const [runningAll, setRunningAll] = useState(false);

  // Test identity for per-user endpoints (notifications, EPF). Defaults to the
  // signed-in admin, but is editable so you can test any Solar user.
  const [testEpf,   setTestEpf]   = useState('');
  const [testEmail, setTestEmail] = useState('');
  const [testPhone, setTestPhone] = useState('');
  useEffect(() => {
    if (!user) return;
    setTestEpf(p   => p || (user.epf_number ? String(user.epf_number) : ''));
    setTestEmail(p => p || (user.email ?? ''));
    setTestPhone(p => p || ((user as { phone_personal?: string }).phone_personal ?? ''));
  }, [user]);
  const testId = { epf: testEpf, email: testEmail, phone: testPhone };

  if (!caps.is_system_admin) {
    return (
      <PageTransition>
        <EmptyState icon={ShieldAlert} title="Admins only"
          description="The API Playground is available to system administrators." />
      </PageTransition>
    );
  }

  const setParam   = (i: number, key: 'k' | 'v', val: string) =>
    setParams(rows => rows.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)));
  const addParam   = () => setParams(rows => [...rows, { k: '', v: '' }]);
  const removeParam = (i: number) => setParams(rows => (rows.length > 1 ? rows.filter((_, idx) => idx !== i) : [{ k: '', v: '' }]));

  const send = async (override?: FilledReq) => {
    const reqMethod = override?.method ?? method;
    const reqPath   = override?.path   ?? path;
    const reqParams = override?.params ?? params;
    const reqBody   = override?.body   ?? body;
    setLoading(true); setError(''); setResult(null);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) { setError('Not signed in'); setLoading(false); return; }

      const query: Record<string, string> = {};
      reqParams.forEach(r => { if (r.k.trim()) query[r.k.trim()] = r.v; });

      const payload: Record<string, unknown> = { idToken, path: reqPath, method: reqMethod, query };
      if (reqMethod === 'POST' && reqBody.trim()) {
        try { payload.body = JSON.parse(reqBody); }
        catch { setError('Request body is not valid JSON'); setLoading(false); return; }
      }

      const res = await fetch('/api/solar/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error ?? `Proxy error (${res.status})`); }
      else         { setResult(data as ProxyResult); }
    } catch {
      setError('Request failed — is the dev server / Solar reachable?');
    } finally {
      setLoading(false);
    }
  };

  // One click: auto-fill the preset with your data, reflect it in the builder, and run it.
  const runPreset = (p: Preset) => {
    const f = fillPreset(p, testId);
    setMethod(f.method); setPath(f.path); setParams(f.params); setBody(f.body);
    setActivePreset(p.name);
    send(f);
  };

  // Health-check every GET endpoint (read-only) and record pass/fail per endpoint.
  const runAll = async () => {
    setRunningAll(true); setChecks({});
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) { setError('Not signed in'); return; }
      for (const p of PRESETS.filter(x => x.method === 'GET')) {
        const f = fillPreset(p, testId);
        const query: Record<string, string> = {};
        f.params.forEach(r => { if (r.k.trim()) query[r.k.trim()] = r.v; });
        try {
          const res = await fetch('/api/solar/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken, path: f.path, method: 'GET', query }),
          });
          const data = await res.json();
          const status = (data?.status ?? res.status) as number;
          setChecks(prev => ({ ...prev, [p.name]: { status, ms: data?.ms ?? 0, ok: status >= 200 && status < 300 } }));
        } catch {
          setChecks(prev => ({ ...prev, [p.name]: { status: 0, ms: 0, ok: false } }));
        }
      }
    } finally {
      setRunningAll(false);
    }
  };

  const copyResult = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result.data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const statusTone = (s: number) =>
    s >= 200 && s < 300 ? 'success' : s >= 400 && s < 500 ? 'warning' : 'destructive';

  return (
    <PageTransition className="space-y-6">
      <PageHeader
        title="API Playground"
        description="Test the Solar (solar.altavision.lk) external APIs — key stays server-side."
        icon={TerminalSquare}
      />

      {/* Presets */}
      <Reveal>
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-sm">Endpoints</CardTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">Click one to auto-fill your test data and run it.</p>
            </div>
            <Button variant="outline" size="sm" onClick={runAll} disabled={runningAll}>
              {runningAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Run all (GET)
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Test identity — used to auto-fill notifications & EPF endpoints */}
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Test identity <span className="font-normal normal-case">— for notifications & EPF (matches Solar by EPF → email → phone)</span>
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Input value={testEpf}   onChange={e => setTestEpf(e.target.value)}   placeholder="EPF (e.g. 151)" className="text-xs" />
                <Input value={testEmail} onChange={e => setTestEmail(e.target.value)} placeholder="email" className="text-xs" />
                <Input value={testPhone} onChange={e => setTestPhone(e.target.value)} placeholder="phone" className="text-xs" />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
            {PRESETS.map(p => {
              const chk = checks[p.name];
              return (
                <button key={p.name} onClick={() => runPreset(p)} title={p.hint}
                  className={`group flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                    activePreset === p.name
                      ? 'border-primary/50 bg-primary/10 text-primary'
                      : 'border-border bg-card text-foreground hover:border-primary/40 hover:bg-accent'}`}>
                  <Badge variant={p.method === 'POST' ? 'brand' : 'muted'} className="text-[9px] font-bold">{p.method}</Badge>
                  {p.name}
                  {chk && (
                    <span className={`ml-0.5 inline-flex items-center gap-0.5 text-[10px] font-bold tabular-nums ${chk.ok ? 'text-success' : 'text-destructive'}`}>
                      {chk.ok ? <Check className="h-3 w-3" /> : '✗'} {chk.status || '—'}
                    </span>
                  )}
                </button>
              );
            })}
            </div>
          </CardContent>
        </Card>
      </Reveal>

      <div className="grid gap-4 lg:grid-cols-2 items-start">
        {/* ── Request builder ── */}
        <Reveal>
          <Card>
            <CardHeader><CardTitle className="text-sm">Request</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {/* method + path */}
              <div className="flex gap-2">
                <div className="flex rounded-md border border-border p-0.5">
                  {(['GET', 'POST'] as Method[]).map(m => (
                    <button key={m} onClick={() => setMethod(m)}
                      className={`px-3 py-1.5 rounded text-xs font-bold transition-colors ${
                        method === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                      {m}
                    </button>
                  ))}
                </div>
                <Input value={path} onChange={e => setPath(e.target.value)}
                  className="flex-1 font-mono text-xs" placeholder="/api/external/…" />
              </div>

              {/* query params */}
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Query params</span>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={addParam}>
                    <Plus className="h-3 w-3" /> Add
                  </Button>
                </div>
                <div className="space-y-2">
                  {params.map((r, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input value={r.k} onChange={e => setParam(i, 'k', e.target.value)}
                        placeholder="key" className="font-mono text-xs" />
                      <Input value={r.v} onChange={e => setParam(i, 'v', e.target.value)}
                        placeholder="value" className="font-mono text-xs" />
                      <Button variant="ghost" size="icon-sm" onClick={() => removeParam(i)}
                        className="shrink-0 text-muted-foreground hover:text-destructive">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>

              {/* body (POST only) */}
              {method === 'POST' && (
                <div>
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Body (JSON)</span>
                  <Textarea value={body} onChange={e => setBody(e.target.value)} rows={6}
                    className="font-mono text-xs" placeholder='{ "epfNumber": "151" }' />
                </div>
              )}

              <Button onClick={() => send()} disabled={loading} className="w-full">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Send request
              </Button>
            </CardContent>
          </Card>
        </Reveal>

        {/* ── Response ── */}
        <Reveal delay={0.05}>
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm">Response</CardTitle>
              {result && (
                <div className="flex items-center gap-2">
                  <Badge variant={statusTone(result.status)} className="font-bold">{result.status}</Badge>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{result.ms} ms</span>
                  <Button variant="ghost" size="icon-sm" onClick={copyResult} title="Copy JSON">
                    {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent>
              {error && (
                <div className="mb-3 flex items-center gap-2 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
                  <ShieldAlert className="h-4 w-4 flex-shrink-0" /> {error}
                </div>
              )}
              {!result && !error && !loading && (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  Pick an endpoint and hit <span className="font-medium text-foreground">Send</span> to see the response.
                </p>
              )}
              {loading && (
                <div className="flex items-center justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
              )}
              {result && (
                <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-[11px] leading-relaxed text-foreground scrollbar-thin">
{typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)}
                </pre>
              )}
            </CardContent>
          </Card>
        </Reveal>
      </div>

      <Reveal>
        <CloudStoragePanel />
      </Reveal>
    </PageTransition>
  );
}
