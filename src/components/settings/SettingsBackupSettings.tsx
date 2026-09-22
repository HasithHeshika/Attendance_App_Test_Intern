'use client';
import { useEffect, useState } from 'react';
import { CloudUpload, Download, RefreshCw, ShieldOff, Check, History, Trash2, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/Skeleton';
import ConfirmModal from '@/components/ConfirmModal';
import { SETTINGS_SOURCES, describeSnapshot, newestSnapshotId } from '@/lib/settingsBackup';
import { tenant } from '@/lib/firebase';
import { useSettingsBackupStore } from '@/store/settingsBackupStore';

/** "5 Sep 2026, 14:02" — the format the rest of this screen uses for a moment in time. */
export function formatSnapshotMoment(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Settings backup — copies this tenant's configuration into the shared `tenants` database.
 *
 * Deliberately not a data backup, and the copy says so in as many words: an admin who reads
 * "backup" and assumes their attendance records are safe has been misled by the UI, not by
 * the feature. The full export lives on /database.
 */
export default function SettingsBackupSettings() {
  const {
    snapshots, loaded, loading, running, error, busyId,
    load, runBackup, fetchSnapshot, restoreSnapshot, deleteSnapshot,
  } = useSettingsBackupStore();
  const [downloading, setDownloading] = useState<string | null>(null);
  // Restoring overwrites live configuration and deleting is permanent, so neither happens on
  // a single click. `confirming` holds which snapshot and which of the two is being asked.
  const [confirming, setConfirming] = useState<{ id: string; action: 'restore' | 'delete' } | null>(null);

  useEffect(() => { void load(); }, [load]);

  const last = snapshots[0] ?? null;
  // Newest by id rather than by list position, so the protected row stays correct even if the
  // history ever arrives in another order. Ids are timestamps, so the largest string is newest.
  const newestId = newestSnapshotId(snapshots.map(s => s.id));

  const handleBackup = async () => {
    try {
      const result = await runBackup();
      toast.success(`Settings backed up — ${describeSnapshot(result)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Backup failed');
    }
  };

  const handleRestore = async (id: string) => {
    try {
      const r = await restoreSnapshot(id);
      // The counts are the point of the message: an admin needs to know what moved, and that
      // the redacted credentials were left alone rather than overwritten with a placeholder.
      const parts = [`${r.documents} document${r.documents === 1 ? '' : 's'} across ${r.collections} collection${r.collections === 1 ? '' : 's'}`];
      if (r.redacted_fields_left_alone > 0) {
        parts.push(`${r.redacted_fields_left_alone} credential${r.redacted_fields_left_alone === 1 ? '' : 's'} left as they are`);
      }
      if (r.safety_snapshot_id) parts.push('a backup was taken first, so this is undoable');
      toast.success(`Settings restored — ${parts.join(' · ')}`, { duration: 8000 });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Restore failed');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteSnapshot(id);
      toast.success('Backup deleted');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete that backup');
    }
  };

  const handleDownload = async (id: string) => {
    setDownloading(id);
    try {
      const snapshot = await fetchSnapshot(id);
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = `settings-${snapshot.tenant_id || tenant.id}-${id}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-prose">
          <h3 className="text-sm font-semibold text-foreground">Settings backup</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Copies this tenant&apos;s configuration into the shared tenants database, so the
            organisation can be rebuilt if its own database is ever lost.
          </p>
        </div>
        <Button onClick={handleBackup} disabled={running} className="shrink-0 gap-2">
          {running ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4" />}
          {running ? 'Backing up…' : 'Back up settings now'}
        </Button>
      </div>

      {/* The last backup line, in the same words describeSnapshot() uses everywhere else. */}
      <div className="rounded-lg border border-border bg-card/40 px-3 py-2.5 text-xs">
        {!loaded && loading ? (
          <Skeleton className="h-4 w-64" />
        ) : last ? (
          <span className="text-muted-foreground">
            Last backed up{' '}
            <span className="font-medium text-foreground">{formatSnapshotMoment(last.taken_at)}</span>
            {last.taken_by_name ? <> by <span className="font-medium text-foreground">{last.taken_by_name}</span></> : null}
            {' · '}{describeSnapshot(last)}
          </span>
        ) : (
          <span className="text-muted-foreground">
            These settings have never been backed up.
          </span>
        )}
      </div>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      <Separator />

      {/* What a snapshot contains, named from SETTINGS_SOURCES itself so this list can never
          drift from what the backup actually copies. */}
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          What is copied
        </h4>
        <ul className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {SETTINGS_SOURCES.map(source => (
            <li key={source.collection} className="flex items-start gap-2 text-xs text-muted-foreground">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
              <span>{source.label}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Not included: transactional data — attendance, leaves, bills and payroll results —
            and credentials such as the OneDrive secret and approval PINs. For a full copy of
            the database, use Download Backup on the Database page.
          </span>
        </p>
      </div>

      <Separator />

      <div>
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Snapshot history
          </h4>
          <Button
            type="button" variant="ghost" size="sm" className="gap-1.5"
            disabled={loading} onClick={() => void load(true)}
          >
            <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            Refresh
          </Button>
        </div>

        {!loaded && loading ? (
          <div className="mt-2 space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : snapshots.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No snapshots yet. The first backup you run will appear here.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {snapshots.map(s => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-border bg-card/40 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-foreground">
                      {formatSnapshotMoment(s.taken_at)}
                    </span>
                    {s.chunked && <Badge variant="muted">Split across chunks</Badge>}
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {s.taken_by_name || 'Unknown'} · {describeSnapshot(s)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Button
                    type="button" variant="outline" size="sm" className="gap-1.5"
                    disabled={downloading === s.id || busyId === s.id}
                    onClick={() => void handleDownload(s.id)}
                  >
                    {downloading === s.id
                      ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      : <Download className="h-3.5 w-3.5" />}
                    Download
                  </Button>
                  <Button
                    type="button" variant="secondary" size="sm" className="gap-1.5"
                    disabled={busyId !== null}
                    onClick={() => setConfirming({ id: s.id, action: 'restore' })}
                  >
                    {busyId === s.id
                      ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      : <History className="h-3.5 w-3.5" />}
                    Restore
                  </Button>
                  {/* The newest backup is what you would restore from, and after a restore it
                      is the pre-restore undo point — so it has no delete button at all rather
                      than one that fails. The route refuses it too. */}
                  {s.id === newestId ? (
                    <span
                      className="inline-flex items-center gap-1 px-1.5 text-[11px] text-muted-foreground"
                      title="The most recent backup cannot be deleted — take a newer one first."
                    >
                      <Lock className="h-3 w-3" /> Kept
                    </span>
                  ) : (
                    <Button
                      type="button" variant="ghost" size="icon-sm"
                      aria-label={`Delete the backup from ${formatSnapshotMoment(s.taken_at)}`}
                      disabled={busyId !== null}
                      onClick={() => setConfirming({ id: s.id, action: 'delete' })}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmModal
        open={!!confirming}
        onOpenChange={() => setConfirming(null)}
        variant={confirming?.action === 'delete' ? 'danger' : 'warning'}
        title={confirming?.action === 'delete' ? 'Delete this backup?' : 'Restore these settings?'}
        description={confirming?.action === 'delete'
          ? 'The snapshot is removed permanently. Your live settings are not touched.'
          : 'Your current settings are overwritten by this snapshot. A fresh backup is taken first, so you can undo it. Nothing is deleted: anything added since the backup stays, and saved credentials are left as they are.'}
        confirmText={confirming?.action === 'delete' ? 'Delete backup' : 'Restore settings'}
        busy={busyId !== null}
        onConfirm={async () => {
          if (!confirming) return;
          const { id, action } = confirming;
          setConfirming(null);
          if (action === 'delete') await handleDelete(id);
          else await handleRestore(id);
        }}
      />
    </div>
  );
}
