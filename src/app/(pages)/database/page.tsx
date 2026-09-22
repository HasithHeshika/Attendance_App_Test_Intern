'use client';
import { useState, useEffect, useRef } from 'react';
import {
  Database, Upload, RotateCcw, Trash2, AlertTriangle, CheckCircle2,
  FileJson, Clock, X, Loader2, Info, Download, ChevronDown, ChevronRight, HardDriveDownload, Cloud,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { auth, tenant } from '@/lib/firebase';
import { primaryDomain } from '@/lib/tenants';

// Every clear on this page hits the database the CURRENT HOSTNAME resolves to (see resolveTenant
// in src/lib/firebase.ts) — never a database chosen here. One deployment serves both tenants, so
// the same page opened at a different domain wipes different data. The target is named in the
// Danger Zone header and repeated inside each confirmation.
const TARGET_DB     = tenant.dbId || '(default)';
const TARGET_DOMAIN = primaryDomain(tenant);
import { useUserCapabilities } from '@/store/rolesStore';
import { useT } from '@/store/appStore';
import type { SeedMeta, SeedSnapshot, ProgressEvent } from '@/lib/seedFirestore';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { Progress } from '@/components/ui/progress';
import { ListSkeleton } from '@/components/ui/Skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { PageTransition, Reveal, Stagger, StaggerItem, MotionCard } from '@/components/ui/motion';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// Progress bar component
function ProgressBar({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground truncate max-w-[240px]">{label}</span>
        <span className="text-primary font-mono font-semibold flex-shrink-0 ml-2">{pct}%</span>
      </div>
      <Progress value={pct} />
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
function DatabaseManagementContent() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  const restoreInputRef = useRef<HTMLInputElement>(null);

  const [baselines,   setBaselines]   = useState<SeedMeta[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [progress,    setProgress]    = useState<ProgressEvent | null>(null);
  const [busy,        setBusy]        = useState(false);
  const [downloading, setDownloading] = useState(false);
  // MySQL migration / seed tools are now a secondary option, hidden until asked for.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [confirmAction, setConfirmAction] = useState<
    | { type: 'reset';  id: string; name: string }
    | { type: 'delete'; id: string; name: string }
    | { type: 'clear' }
    | { type: 'clearKeepUsers' }
    | { type: 'restoreBackup' }
    | null
  >(null);

  // Parsed JSON from file before upload (MySQL seed import)
  const [pendingUpload, setPendingUpload] = useState<{
    snapshot: SeedSnapshot;
    fileName: string;
    fileSize: number;
    counts:   Record<string, number>;
  } | null>(null);

  // Parsed backup selected for restore — either a local file the admin picked, or the
  // latest nightly backup pulled from OneDrive.
  const [pendingRestore, setPendingRestore] = useState<{
    backup:   { collections: Record<string, Record<string, unknown>>; database_id?: string };
    fileName: string;
    fileSize: number;
    counts:   Record<string, number>;
    total:    number;
    source:   'file' | 'onedrive';
    createdAt?: string;
  } | null>(null);
  const [fetchingCloud, setFetchingCloud] = useState(false);

  const caps = useUserCapabilities();
  const isAdmin = caps.is_system_admin;

  useEffect(() => {
    loadBaselines();
  }, []);

  // `silent` re-fetches without flipping the full-page skeleton, so a mutation updates the list
  // in place instead of remounting it (the "whole page resets" effect).
  const loadBaselines = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const { getSeedBaselines } = await import('@/lib/seedFirestore');
      const list = await getSeedBaselines();
      setBaselines(list);
    } catch (e) { console.error(e); }
    finally { if (!silent) setLoading(false); }
  };

  // ─── Download backup ───────────────────────────────────────────────────────────
  // Pulls a full copy of the live database (all collections) from the server via the
  // Admin SDK and saves it as a timestamped .json file. System-Admin only (the API
  // route re-checks is_system_admin — this whole page is already admin-gated).
  const handleDownloadBackup = async () => {
    setDownloading(true);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) { toast.error('Not signed in'); return; }

      const res = await fetch('/api/admin/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({}));
        throw new Error(msg.error || `Backup failed (${res.status})`);
      }

      // Filename comes from the Content-Disposition header the route sets.
      const cd = res.headers.get('Content-Disposition') || '';
      const filename = cd.match(/filename="([^"]+)"/)?.[1] || 'firestore-backup.json';

      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Backup downloaded');
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : 'Backup failed');
    } finally {
      setDownloading(false);
    }
  };

  // ─── Restore backup (upload a downloaded backup .json) ──────────────────────────
  // Validates the file is one produced by "Download Backup", then previews it before
  // the admin confirms writing it back to the live database.
  // Validate + summarise a backup payload. Shared by the local picker and the OneDrive
  // fetch so both paths preview identically. Returns false if it isn't a backup file.
  const stageRestore = (
    raw: { __firestore_backup__?: boolean; collections?: Record<string, Record<string, unknown>>; created_at?: string },
    fileName: string,
    fileSize: number,
    source: 'file' | 'onedrive',
  ): boolean => {
    if (!raw?.__firestore_backup__ || !raw?.collections) return false;
    const counts: Record<string, number> = {};
    let total = 0;
    for (const [name, docs] of Object.entries(raw.collections)) {
      const n = Object.keys(docs || {}).length;
      counts[name] = n;
      total += n;
    }
    setPendingRestore({
      backup: raw as { collections: Record<string, Record<string, unknown>>; database_id?: string },
      fileName, fileSize, counts, total, source, createdAt: raw.created_at,
    });
    return true;
  };

  const handleRestoreFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.json')) { toast.error('Please select a .json backup file'); return; }

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const raw = JSON.parse(evt.target?.result as string);
        if (!stageRestore(raw, file.name, file.size, 'file')) {
          toast.error('Not a backup file — use a file saved with “Download Backup”.');
        }
      } catch (err) {
        toast.error('Failed to read the backup file');
        console.error(err);
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // allow re-selecting the same file
  };

  // ─── Pull the latest backup from OneDrive ──────────────────────────────────────
  // Fetches firestore-latest.json — the file the daily 4 AM job uploads via Microsoft
  // Graph — and stages it in the same preview as a hand-picked file. Nothing is written
  // until the admin confirms.
  const handleFetchFromOneDrive = async () => {
    setFetchingCloud(true);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) { toast.error('Not signed in'); return; }

      const res = await fetch('/api/admin/onedrive-backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({}));
        throw new Error(msg.error || `Fetch failed (${res.status})`);
      }

      const name = res.headers.get('X-Backup-Name') || 'firestore-latest.json';
      const size = Number(res.headers.get('X-Backup-Size') || 0);
      const raw  = JSON.parse(await res.text());

      if (!stageRestore(raw, name, size, 'onedrive')) {
        throw new Error('The file in OneDrive is not a Firestore backup.');
      }
      toast.success(`Loaded ${name} from OneDrive`);
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : 'Could not fetch from OneDrive');
    } finally {
      setFetchingCloud(false);
    }
  };

  // Writes the selected backup back to the live database via the Admin SDK route, in
  // chunks so a large prod backup shows progress and stays under request-size limits.
  const handleRestoreBackup = async () => {
    if (!pendingRestore) return;
    setConfirmAction(null);
    setBusy(true);
    setProgress({ stage: 'Starting restore…', done: 0, total: 100, percent: 0 });
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) { toast.error('Not signed in'); return; }

      // Flatten every collection into one work list, then send it in chunks.
      const items: { c: string; id: string; data: unknown }[] = [];
      for (const [c, docs] of Object.entries(pendingRestore.backup.collections)) {
        for (const [id, data] of Object.entries(docs || {})) items.push({ c, id, data });
      }

      const CHUNK = 300;
      let done = 0;
      for (let i = 0; i < items.length; i += CHUNK) {
        const chunk = items.slice(i, i + CHUNK);
        const res = await fetch('/api/admin/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken, chunk }),
        });
        if (!res.ok) {
          const msg = await res.json().catch(() => ({}));
          throw new Error(msg.error || `Restore failed (${res.status})`);
        }
        done += chunk.length;
        setProgress({
          stage: `Restoring… ${done}/${items.length} documents`,
          done, total: items.length,
          percent: items.length ? Math.round((done / items.length) * 100) : 100,
        });
      }
      toast.success(`Restored ${items.length} documents`);
      setPendingRestore(null);
      await loadBaselines(true);
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : 'Restore failed');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  // ─── File parsing ────────────────────────────────────────────────────────────
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.json')) { toast.error(t.selectJsonFile); return; }
    if (file.size > 100 * 1024 * 1024) { toast.error(t.fileTooLarge); return; }

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const raw = JSON.parse(evt.target?.result as string) as SeedSnapshot & { _meta?: Record<string, unknown> };

        // Validate structure
        const required = ['companies', 'users', 'leave_types', 'attendances', 'leaves'];
        for (const key of required) {
          if (!(key in raw)) { toast.error(`Invalid file — missing "${key}" collection`); return; }
        }

        // Cast to a plain record for safe dynamic access
        const rawMap = raw as unknown as Record<string, Record<string, unknown>>;

        const counts: Record<string, number> = {};
        for (const key of ['companies','users','leave_types','attendances','attendance_edit_requests','leaves','outstation_locations']) {
          counts[key] = Object.keys(rawMap[key] || {}).length;
        }

        const snapshot: SeedSnapshot = {
          _meta:                    rawMap['_meta'] || {},
          companies:                rawMap['companies'] || {},
          users:                    rawMap['users'] || {},
          leave_types:              rawMap['leave_types'] || {},
          attendances:              rawMap['attendances'] || {},
          attendance_edit_requests: rawMap['attendance_edit_requests'] || {},
          leaves:                   rawMap['leaves'] || {},
          outstation_locations:     rawMap['outstation_locations'] || {},
        };

        setPendingUpload({ snapshot, fileName: file.name, fileSize: file.size, counts });
      } catch (err) {
        toast.error(t.failedParseJson);
        console.error(err);
      }
    };
    reader.readAsText(file);
    // Reset input so the same file can be re-selected
    e.target.value = '';
  };

  // ─── Upload ──────────────────────────────────────────────────────────────────
  const handleUpload = async () => {
    if (!pendingUpload) return;
    setBusy(true);
    setProgress({ stage: 'Starting...', done: 0, total: 100, percent: 0 });

    try {
      const { uploadSeed } = await import('@/lib/seedFirestore');
      const metaId = await uploadSeed(
        pendingUpload.snapshot,
        pendingUpload.fileName,
        (evt) => setProgress(evt),
      );
      toast.success(`Seed imported! Baseline ID: ${metaId.slice(-8)}`);
      setPendingUpload(null);
      await loadBaselines(true);
    } catch (e) {
      console.error(e);
      toast.error(t.uploadFailed);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  // ─── Reset to baseline ────────────────────────────────────────────────────────
  const handleReset = async (metaId: string) => {
    setBusy(true);
    setConfirmAction(null);
    setProgress({ stage: 'Starting reset...', done: 0, total: 100, percent: 0 });

    try {
      const { resetToBaseline } = await import('@/lib/seedFirestore');
      await resetToBaseline(metaId, (evt) => setProgress(evt));
      toast.success(t.dbResetSuccess);
    } catch (e) {
      console.error(e);
      toast.error(t.resetFailed);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  // ─── Delete baseline ──────────────────────────────────────────────────────────
  const handleDeleteBaseline = async (metaId: string) => {
    setConfirmAction(null);
    try {
      const { deleteSeedBaseline } = await import('@/lib/seedFirestore');
      await deleteSeedBaseline(metaId);
      toast.success(t.baselineDeleted);
      await loadBaselines(true);
    } catch { toast.error(t.failedDeleteBaseline); }
  };

  // ─── Clear all ────────────────────────────────────────────────────────────────
  const handleClearAll = async () => {
    setBusy(true);
    setConfirmAction(null);
    setProgress({ stage: 'Clearing...', done: 0, total: 100, percent: 0 });

    try {
      const { clearAllData } = await import('@/lib/seedFirestore');
      await clearAllData((evt) => setProgress(evt));
      toast.success(t.allDataCleared);
      await loadBaselines(true);
    } catch (e) {
      console.error(e);
      toast.error(t.clearFailed);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  // Clear attendance/leaves/tasks but keep users + settings.
  const handleClearKeepUsers = async () => {
    setBusy(true);
    setConfirmAction(null);
    setProgress({ stage: 'Clearing...', done: 0, total: 100, percent: 0 });
    try {
      const { clearLiveDataKeepUsers } = await import('@/lib/seedFirestore');
      await clearLiveDataKeepUsers((evt) => setProgress(evt));
      toast.success(t.attLeavesTasksCleared);
      await loadBaselines(true);
    } catch (e) {
      console.error(e);
      toast.error(t.clearFailed);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  if (!isAdmin) return (
    <div className="max-w-3xl">
      <EmptyState
        icon={AlertTriangle}
        title={t.adminAccessRequired}
        description={t.adminAccessDesc}
      />
    </div>
  );

  return (
    <PageTransition className="space-y-6 max-w-3xl">
      {/* Header */}
      <PageHeader
        title={t.dbManagementTitle}
        description={t.dbManagementDesc}
        icon={Database}
      />

      {/* ── PRIMARY — Download backup (full snapshot of the live database) ── */}
      <Reveal delay={0.03}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Download className="w-4 h-4 text-primary" />
              Download Backup
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Save a full copy of the live database (every collection) as a JSON file. Do this before any risky change, and keep a copy off this device.
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-muted p-3.5">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">Full database backup</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Downloads a timestamped <code className="bg-background px-1 py-0.5 rounded">.json</code> file you can restore later.
                </div>
              </div>
              <Button onClick={handleDownloadBackup} disabled={downloading || busy} className="flex-shrink-0">
                {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {downloading ? 'Preparing…' : 'Download Backup'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </Reveal>

      {/* ── PRIMARY — Restore backup (upload a downloaded backup .json) ── */}
      {!busy && (
        <Reveal delay={0.05}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <HardDriveDownload className="w-4 h-4 text-primary" />
                Restore Backup
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Upload a <code className="bg-muted px-1.5 py-0.5 rounded">.json</code> file saved with <strong>Download Backup</strong> to write it back to the live database. Records with the same ID are overwritten.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {!pendingRestore ? (
                <div className="space-y-3">
                  <button
                    onClick={() => restoreInputRef.current?.click()}
                    className="w-full flex flex-col items-center gap-3 py-8 rounded-xl border border-dashed border-border hover:border-primary/40 hover:bg-primary/5 transition-all text-muted-foreground hover:text-primary"
                  >
                    <FileJson className="w-8 h-8" />
                    <div className="text-sm font-medium">Click to select a backup .json</div>
                    <div className="text-xs text-muted-foreground">Only files saved with “Download Backup”</div>
                  </button>

                  <div className="flex items-center gap-3">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">or</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>

                  <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-muted p-3.5">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground">Latest backup from OneDrive</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Pulls <code className="bg-background px-1 py-0.5 rounded">firestore-latest.json</code>, uploaded by the daily 4&nbsp;AM job.
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      onClick={handleFetchFromOneDrive}
                      disabled={fetchingCloud || busy}
                      className="flex-shrink-0"
                    >
                      {fetchingCloud ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cloud className="w-4 h-4" />}
                      {fetchingCloud ? 'Fetching…' : 'Fetch from OneDrive'}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-start gap-3 p-3 rounded-xl bg-success/10 border border-success/20">
                    <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-foreground truncate">{pendingRestore.fileName}</span>
                        {pendingRestore.source === 'onedrive' && (
                          <span className="flex-shrink-0 inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                            <Cloud className="w-3 h-3" /> OneDrive
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">{fmtBytes(pendingRestore.fileSize)} · {pendingRestore.total} documents ready to restore</div>
                      {/* Age of the snapshot matters more than anything else before overwriting live data. */}
                      {pendingRestore.createdAt && (
                        <div className="text-xs text-muted-foreground mt-0.5">Snapshot taken {fmtDate(pendingRestore.createdAt)}</div>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="flex-shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={() => setPendingRestore(null)}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {Object.entries(pendingRestore.counts).filter(([, v]) => v > 0).map(([col, n]) => (
                      <div key={col} className="bg-muted rounded-xl p-2.5 text-center">
                        <div className="text-lg font-bold text-foreground">{n}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5 capitalize">{col.replace(/_/g, ' ')}</div>
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-end gap-3">
                    <Button variant="outline" onClick={() => setPendingRestore(null)}>Cancel</Button>
                    <Button
                      className="bg-warning text-warning-foreground hover:bg-warning/90"
                      onClick={() => setConfirmAction({ type: 'restoreBackup' })}
                    >
                      <RotateCcw className="w-4 h-4" />
                      Restore to Database
                    </Button>
                  </div>
                </div>
              )}

              <input ref={restoreInputRef} type="file" accept=".json" className="hidden" onChange={handleRestoreFileSelect} />
            </CardContent>
          </Card>
        </Reveal>
      )}

      {/* ── Danger zone — kept alongside Restore, not buried under the MySQL tools ── */}
      <Reveal delay={0.07}>
        <Card className="border-destructive/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="w-4 h-4 text-destructive" />
              Danger Zone
            </CardTitle>
            <p className="text-xs text-muted-foreground">{t.destructiveOpsWarning}</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3.5">
              <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-destructive">
                <Database className="h-3.5 w-3.5" /> Affects this database only
              </div>
              <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-sm font-semibold text-foreground">{tenant.label}</span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{TARGET_DB}</code>
                <span className="text-xs text-muted-foreground">{TARGET_DOMAIN}</span>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Resolved from the address you are on. Open this page at another tenant&rsquo;s domain and it clears that tenant&rsquo;s database instead.
              </p>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-xl border border-warning/30 bg-warning/5 p-3.5">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">Clear attendance, leaves &amp; tasks</div>
                <div className="text-xs text-muted-foreground mt-0.5">{t.deletesAttLeaves} <span className="text-foreground">{t.usersSettingsKeptDot}</span></div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmAction({ type: 'clearKeepUsers' })}
                className="flex-shrink-0 border-warning/40 text-warning hover:bg-warning/10 hover:text-warning"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear Data
              </Button>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-xl border border-destructive/30 bg-destructive/5 p-3.5">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">{t.clearAllLiveDataLower}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{t.permanentlyDeletes}</div>
              </div>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmAction({ type: 'clear' })}
                className="flex-shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear All
              </Button>
            </div>
          </CardContent>
        </Card>
      </Reveal>

      {/* Progress overlay — shown while a long operation runs */}
      {busy && progress && (
        <Reveal>
          <Card className="border-primary/30">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 text-primary animate-spin" />
                <span className="text-sm font-semibold text-foreground">Operation in progress…</span>
              </div>
              <ProgressBar pct={progress.percent} label={progress.stage} />
              <p className="text-xs text-muted-foreground">{t.doNotClosePage}</p>
            </CardContent>
          </Card>
        </Reveal>
      )}

      {/* ── Toggle for the secondary MySQL migration / seed tools ── */}
      <Reveal delay={0.07}>
        <button
          type="button"
          onClick={() => setShowAdvanced(v => !v)}
          className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {showAdvanced ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          More options — MySQL migration &amp; seed tools
        </button>
      </Reveal>

      {showAdvanced && (
        <>
          {/* How-to banner */}
          <Reveal>
            <Alert variant="info">
              <Info className="h-4 w-4" />
              <AlertTitle>How to migrate from MySQL</AlertTitle>
              <AlertDescription>
                <ol className="list-decimal list-inside space-y-1 ml-1 mt-1">
                  <li>Run: <code className="bg-muted px-1.5 py-0.5 rounded text-primary">node scripts/convert-sql.mjs av_master.sql</code></li>
                  <li>This creates <code className="bg-muted px-1.5 py-0.5 rounded text-primary">firestore-seed.json</code> next to your SQL file</li>
                  <li>Upload that JSON with <strong>Import</strong> below, then click <strong>Restore</strong> on the new baseline for a clean full replace (clears stale users/leaves/attendance first)</li>
                  <li>Create all logins at once: <code className="bg-muted px-1.5 py-0.5 rounded text-primary">node --env-file=.env.local scripts/create-auth-users.mjs firestore-seed.json</code> — gives every user their own random password, printed as it runs, and links their login</li>
                </ol>
              </AlertDescription>
            </Alert>
          </Reveal>

      {/* File upload zone */}
      {!busy && (
        <Reveal delay={0.05}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Upload className="w-4 h-4 text-primary" />
                Import Firestore Seed File
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Upload a <code className="bg-muted px-1.5 py-0.5 rounded">firestore-seed.json</code> generated by the converter script. The imported data becomes a named baseline that can be restored at any time.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {!pendingUpload ? (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full flex flex-col items-center gap-3 py-8 rounded-xl border border-dashed border-border hover:border-primary/40 hover:bg-primary/5 transition-all text-muted-foreground hover:text-primary"
                >
                  <FileJson className="w-8 h-8" />
                  <div className="text-sm font-medium">{t.clickSelectJson}</div>
                  <div className="text-xs text-muted-foreground">{t.max100mb}</div>
                </button>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-start gap-3 p-3 rounded-xl bg-success/10 border border-success/20">
                    <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-foreground truncate">{pendingUpload.fileName}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{fmtBytes(pendingUpload.fileSize)} · ready to import</div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="flex-shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={() => setPendingUpload(null)}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>

                  {/* Counts preview */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {Object.entries(pendingUpload.counts).filter(([, v]) => v > 0).map(([col, n]) => (
                      <div key={col} className="bg-muted rounded-xl p-2.5 text-center">
                        <div className="text-lg font-bold text-foreground">{n}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5 capitalize">{col.replace(/_/g, ' ')}</div>
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-end gap-3">
                    <Button variant="outline" onClick={() => setPendingUpload(null)}>
                      Cancel
                    </Button>
                    <Button onClick={handleUpload}>
                      <Upload className="w-4 h-4" />
                      Upload to Firestore
                    </Button>
                  </div>
                </div>
              )}

              <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleFileSelect} />
            </CardContent>
          </Card>
        </Reveal>
      )}

      {/* Stored baselines */}
      <Reveal delay={0.1}>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Database className="w-4 h-4 text-brand" />
                Saved Baselines
              </CardTitle>
              <Badge variant="muted">{baselines.length} saved</Badge>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <ListSkeleton rows={3} />
            ) : baselines.length === 0 ? (
              <EmptyState
                icon={Database}
                title={t.noBaselinesYet}
                description={t.importSeedToCreate}
              />
            ) : (
              <Stagger className="space-y-2">
                {baselines.map(baseline => (
                  <StaggerItem key={baseline.id}>
                    <MotionCard className="flex items-center gap-4 p-3.5 rounded-xl bg-muted border border-border">
                      <div className="w-9 h-9 rounded-xl bg-brand/10 flex items-center justify-center flex-shrink-0">
                        <Database className="w-4 h-4 text-brand" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-foreground truncate">{baseline.source_file}</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <Clock className="w-3 h-3 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground">{fmtDate(baseline.imported_at)}</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {Object.entries(baseline.counts).filter(([, v]) => v > 0).map(([col, n]) => (
                            <Badge key={col} variant="muted">
                              {n} {col.replace(/_/g, ' ')}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => setConfirmAction({ type: 'reset', id: baseline.id, name: baseline.source_file })}
                        >
                          <RotateCcw className="w-3 h-3" />
                          Restore
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={busy}
                          onClick={() => setConfirmAction({ type: 'delete', id: baseline.id, name: baseline.source_file })}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </MotionCard>
                  </StaggerItem>
                ))}
              </Stagger>
            )}
          </CardContent>
        </Card>
      </Reveal>

        </>
      )}

      {/* Confirm modal */}
      <Dialog open={!!confirmAction} onOpenChange={(open) => { if (!open) setConfirmAction(null); }}>
        <DialogContent className="max-w-md">
          {confirmAction?.type === 'restoreBackup' && pendingRestore && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-warning/10 flex items-center justify-center flex-shrink-0">
                    <RotateCcw className="w-5 h-5 text-warning" />
                  </div>
                  <div className="min-w-0">
                    <DialogTitle>Restore this backup?</DialogTitle>
                    <DialogDescription>Writes the backup into the live database.</DialogDescription>
                  </div>
                </div>
              </DialogHeader>
              <Alert variant="warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-foreground">
                  <strong className="text-foreground">{pendingRestore.total} documents</strong> from <em className="text-warning">{pendingRestore.fileName}</em> will be written to the live database. Records with the same ID are <strong className="text-foreground">overwritten</strong>; records added after the backup are left untouched.
                </AlertDescription>
              </Alert>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmAction(null)}>{t.cancel}</Button>
                <Button className="bg-warning text-warning-foreground hover:bg-warning/90" onClick={handleRestoreBackup}>
                  Yes, Restore
                </Button>
              </DialogFooter>
            </>
          )}

          {confirmAction?.type === 'reset' && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-warning/10 flex items-center justify-center flex-shrink-0">
                    <RotateCcw className="w-5 h-5 text-warning" />
                  </div>
                  <div className="min-w-0">
                    <DialogTitle>{t.restoreToBaseline}</DialogTitle>
                    <DialogDescription>{t.replacesAllData}</DialogDescription>
                  </div>
                </div>
              </DialogHeader>
              <Alert variant="warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-foreground">
                  All current attendance, users, and leaves will be <strong className="text-foreground">permanently deleted</strong> and replaced with the baseline from <em className="text-warning">{confirmAction.name}</em>.
                </AlertDescription>
              </Alert>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmAction(null)}>{t.cancel}</Button>
                <Button className="bg-warning text-warning-foreground hover:bg-warning/90" onClick={() => handleReset(confirmAction.id)}>
                  Yes, Restore
                </Button>
              </DialogFooter>
            </>
          )}

          {confirmAction?.type === 'delete' && (
            <>
              <DialogHeader>
                <DialogTitle>{t.deleteBaselineQ}</DialogTitle>
                <DialogDescription>
                  This removes the saved baseline <em className="text-destructive">{confirmAction.name}</em>. Live data is not affected.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmAction(null)}>{t.cancel}</Button>
                <Button variant="destructive" onClick={() => handleDeleteBaseline(confirmAction.id)}>{t.deleteWord}</Button>
              </DialogFooter>
            </>
          )}

          {confirmAction?.type === 'clearKeepUsers' && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-warning/10 flex items-center justify-center flex-shrink-0">
                    <AlertTriangle className="w-5 h-5 text-warning" />
                  </div>
                  <div className="min-w-0">
                    <DialogTitle>Clear Attendance, Leaves &amp; Tasks</DialogTitle>
                    <DialogDescription className="text-warning">{t.usersSettingsKept}</DialogDescription>
                  </div>
                </div>
              </DialogHeader>
              <Alert variant="warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-foreground">
                  All <strong className="text-foreground">attendance records, leaves, edit requests, tasks and shift periods</strong> in <strong className="text-foreground">{tenant.label} ({TARGET_DB})</strong> will be permanently deleted. <strong className="text-foreground">Users, companies and settings stay.</strong>
                </AlertDescription>
              </Alert>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmAction(null)}>{t.cancel}</Button>
                <Button className="bg-warning text-warning-foreground hover:bg-warning/90" onClick={handleClearKeepUsers}>
                  Yes, Clear Data
                </Button>
              </DialogFooter>
            </>
          )}

          {confirmAction?.type === 'clear' && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-destructive/10 flex items-center justify-center flex-shrink-0">
                    <AlertTriangle className="w-5 h-5 text-destructive" />
                  </div>
                  <div className="min-w-0">
                    <DialogTitle>{t.clearAllLiveData}</DialogTitle>
                    <DialogDescription className="text-destructive">{t.cannotUndoNoBaseline}</DialogDescription>
                  </div>
                </div>
              </DialogHeader>
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-foreground">
                  All users, attendance records, leaves, and other live data in <strong className="text-foreground">{tenant.label} ({TARGET_DB})</strong> at <strong className="text-foreground">{TARGET_DOMAIN}</strong> will be <strong className="text-foreground">permanently deleted</strong>. Saved baselines will be kept.
                </AlertDescription>
              </Alert>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmAction(null)}>{t.cancel}</Button>
                <Button variant="destructive" onClick={handleClearAll}>
                  Yes, Delete Everything
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}

export default function DatabaseManagementPage() {
  return <DatabaseManagementContent />;
}
