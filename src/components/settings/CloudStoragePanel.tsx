'use client';
import { useEffect, useState } from 'react';
import { Cloud, Flame, Loader2, Check, X, Save, RefreshCw, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CloudProvider } from '@/lib/types';
import { getCloudConfig, saveCloudConfig, testCloudConnection, uploadCloudFile } from '@/services/cloudStorageService';
import { useAuthStore } from '@/store/authStore';

function expiryInfo(created: string, months: number): { date: string; days: number } | null {
  if (!created || !months) return null;
  const d = new Date(`${created}T00:00:00`);
  if (isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + months);
  const days = Math.ceil((d.getTime() - Date.now()) / 86_400_000);
  return { date: d.toISOString().slice(0, 10), days };
}

function Field({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div>
      <Label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</Label>
      <Input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

// Cloud storage configuration — pick the provider that receives service photos & suspense
// bill uploads. OneDrive uses an Azure AD app (client-credentials + Microsoft Graph); the
// client secret is written through a server route and stored server-only.
export default function CloudStoragePanel() {
  const me = useAuthStore(s => s.user);

  const [loading, setLoading]   = useState(true);
  const [provider, setProvider] = useState<CloudProvider>('firebase');
  const [tenant, setTenant]     = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret]     = useState('');       // blank = keep existing
  const [hasSecret, setHasSecret] = useState(false);
  const [folder, setFolder]     = useState('');
  const [secretDate, setSecretDate] = useState('');
  const [months, setMonths]     = useState(24);

  const [saving, setSaving]     = useState(false);
  const [testing, setTesting]   = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [uploading, setUploading]   = useState(false);
  const [uploadUrl, setUploadUrl]   = useState('');

  useEffect(() => {
    (async () => {
      try {
        const cfg = await getCloudConfig();
        setProvider(cfg.provider);
        if (cfg.onedrive) {
          setTenant(cfg.onedrive.tenant_id); setClientId(cfg.onedrive.client_id);
          setFolder(cfg.onedrive.folder_path); setSecretDate(cfg.onedrive.secret_created_date);
          setMonths(cfg.onedrive.secret_duration_months || 24); setHasSecret(cfg.onedrive.has_secret);
        }
      } catch { /* not set yet / not accessible */ }
      finally { setLoading(false); }
    })();
  }, []);

  const exp = expiryInfo(secretDate, months);

  const save = async () => {
    setSaving(true);
    try {
      await saveCloudConfig({
        provider,
        onedrive: provider === 'onedrive' ? {
          tenant_id: tenant.trim(), client_id: clientId.trim(),
          client_secret: secret.trim() || undefined, folder_path: folder.trim(),
          secret_created_date: secretDate, secret_duration_months: months,
        } : undefined,
      });
      toast.success('Cloud settings saved.');
      if (secret.trim()) setHasSecret(true);
      setSecret('');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to save.'); }
    finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true); setTestResult(null);
    try { setTestResult(await testCloudConnection()); }
    catch (e) { setTestResult({ ok: false, detail: e instanceof Error ? e.message : 'Test failed.' }); }
    finally { setTesting(false); }
  };

  const testUpload = async (file: File | null) => {
    if (!file) return;
    if (!me?.epf_number) { toast.error('Sign-in required.'); return; }
    setUploading(true); setUploadUrl('');
    try {
      const r = await uploadCloudFile(file, { epf: me.epf_number, name: me.name, prefix: 'test' });
      setUploadUrl(r.url);
      toast.success(`Uploaded to ${r.provider}.`);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Upload failed.'); }
    finally { setUploading(false); }
  };

  if (loading) {
    return <Card><CardContent className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></CardContent></Card>;
  }

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Cloud className="h-4 w-4" /> Cloud Storage</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs text-muted-foreground">Where service photos &amp; suspense bills are uploaded.</p>

        {/* Provider cards */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {([
            { key: 'firebase' as const, name: 'Firebase Storage', sub: 'Internal · no setup', Icon: Flame },
            { key: 'onedrive' as const, name: 'OneDrive', sub: 'Microsoft 365 account', Icon: Cloud },
          ]).map(({ key, name, sub, Icon }) => (
            <button key={key} type="button" onClick={() => setProvider(key)}
              className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                provider === key ? 'border-primary bg-primary/5 ring-1 ring-primary/40' : 'border-border hover:bg-accent'
              }`}>
              <Icon className="h-5 w-5 text-primary" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">{name}</div>
                <div className="text-[11px] text-muted-foreground">{sub}</div>
              </div>
              {provider === key && <Check className="ml-auto h-4 w-4 text-primary" />}
            </button>
          ))}
        </div>

        {provider === 'onedrive' && (
          <div className="space-y-4">
            <div className="space-y-1 rounded-xl border border-primary/20 bg-primary/[0.04] p-3 text-[11px] text-muted-foreground">
              <div className="text-xs font-semibold text-primary">Setup steps</div>
              <div>1. Register an app in Azure Active Directory (portal.azure.com)</div>
              <div>2. Grant <code className="rounded bg-muted px-1">Files.ReadWrite.All</code> (Microsoft Graph, application permission)</div>
              <div>3. Enter the Tenant ID, Client ID, Client Secret and destination folder path below</div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Tenant ID"   value={tenant}   onChange={setTenant} />
              <Field label="Client ID"   value={clientId} onChange={setClientId} />
              <div>
                <Label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Client Secret</Label>
                <Input type="password" value={secret} onChange={e => setSecret(e.target.value)}
                  placeholder={hasSecret ? '•••••••• (leave blank to keep)' : 'Enter client secret'} />
              </div>
              <Field label="Upload Folder Path" value={folder} onChange={setFolder} placeholder="user@org.com/drive/root:/Solar/bills" />
              <div>
                <Label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Secret Created Date</Label>
                <Input type="date" value={secretDate} onChange={e => setSecretDate(e.target.value)} />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Duration (months · max 24)</Label>
                <Input type="number" min="1" max="24" value={months}
                  onChange={e => setMonths(Math.min(24, Math.max(1, Number(e.target.value) || 1)))} />
              </div>
            </div>

            {exp && (
              <div className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${
                exp.days < 30 ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-success/30 bg-success/10 text-success'
              }`}>
                <span>Expiry date: <b>{exp.date}</b></span>
                <span>{exp.days > 0 ? `Expires in ${exp.days} days (${Math.round(exp.days / 30)} months)` : 'Expired'}</span>
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save cloud settings
          </Button>
          {provider === 'onedrive' && (
            <Button variant="outline" onClick={test} disabled={testing}>
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Test connection
            </Button>
          )}
          {testResult && (
            <span className={`inline-flex items-center gap-1 text-xs ${testResult.ok ? 'text-success' : 'text-destructive'}`}>
              {testResult.ok ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />} {testResult.detail}
            </span>
          )}
        </div>

        {/* Test upload */}
        <div className="border-t border-border pt-4">
          <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            <Upload className="h-3.5 w-3.5" /> Test file upload ({provider})
          </div>
          <input type="file" accept="image/*,application/pdf" disabled={uploading}
            onChange={e => testUpload(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary hover:file:bg-primary/20" />
          {uploading && <p className="mt-2 inline-flex items-center gap-1 text-xs text-primary"><Loader2 className="h-3 w-3 animate-spin" /> Uploading…</p>}
          {uploadUrl && <a href={uploadUrl} target="_blank" rel="noopener noreferrer" className="mt-2 block truncate text-xs text-primary hover:underline">{uploadUrl}</a>}
        </div>
      </CardContent>
    </Card>
  );
}
