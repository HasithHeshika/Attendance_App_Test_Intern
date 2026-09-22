import { create } from 'zustand';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import type { SettingsSnapshot } from '@/lib/settingsBackup';

/**
 * The settings-backup history, shared between the System Settings summary strip (which shows
 * the last backup line) and the Backup section below it (which shows the whole list). Both
 * mount on the same screen, so a store keeps them to ONE request instead of two, and lets a
 * backup run in the section update the line at the top without any wiring between them.
 *
 * Held in memory only. A snapshot list is cheap to fetch and stale-when-persisted is worse
 * than absent here: an admin looking at this screen is usually looking because they want to
 * know the CURRENT state of the backups.
 */

/** One row of history — the snapshot's metadata, never its documents. */
export interface SettingsSnapshotSummary {
  id:            string;
  taken_at:      string;
  taken_by_name: string;
  taken_by_epf:  string;
  totals:        SettingsSnapshot['totals'];
  chunked:       boolean;
  bytes:         number;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  // Wait for Firebase Auth before deciding nobody is signed in. `auth.currentUser` is null
  // for the first moments of every page load — reading it too early is the same mistake
  // CLAUDE.md documents for Firestore reads, and it showed up here as a "Not signed in"
  // toast on a perfectly good session. onAuthStateChanged fires once with the restored user
  // (or with null when there really is none).
  const user = auth.currentUser ?? await new Promise<User | null>(resolve => {
    const stop = onAuthStateChanged(auth, u => { stop(); resolve(u); });
  });
  const idToken = await user?.getIdToken();
  if (!idToken) throw new Error('Not signed in');
  const res = await fetch('/api/admin/settings-backup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  // The route sends `detail` alongside `error` on a server failure (it is admin-only), and
  // that detail is the whole difference between "try again" and knowing what to fix.
  if (!res.ok) {
    const base = data.error || `Request failed (${res.status})`;
    throw new Error(data.detail ? `${base} ${data.detail}` : base);
  }
  return data as T;
}

interface BackupResult {
  id: string;
  taken_at: string;
  taken_by_name: string;
  totals: SettingsSnapshot['totals'];
  chunked: boolean;
  chunks: number;
}

interface SettingsBackupState {
  snapshots: SettingsSnapshotSummary[];
  /** True once a list has come back, so a genuinely empty history renders as empty, not busy. */
  loaded:   boolean;
  loading:  boolean;
  running:  boolean;
  error:    string | null;
  /** The snapshot a restore or delete is currently working on, so one row can show a spinner. */
  busyId:   string | null;
  load:     (force?: boolean) => Promise<void>;
  runBackup: () => Promise<BackupResult>;
  fetchSnapshot: (id: string) => Promise<SettingsSnapshot>;
  restoreSnapshot: (id: string) => Promise<RestoreResult>;
  deleteSnapshot:  (id: string) => Promise<void>;
}

/** What a restore reports back — see runRestore in the route for why each number exists. */
export interface RestoreResult {
  ok: boolean;
  restored_from: string;
  documents: number;
  collections: number;
  /** Credentials the backup redacted; the live values were left untouched, not overwritten. */
  redacted_fields_left_alone: number;
  /** The snapshot taken automatically just before the restore, so this is undoable. */
  safety_snapshot_id: string | null;
  restored_by: string;
}

// Shared by concurrent callers so two components mounting together make one request.
let inflight: Promise<void> | null = null;

export const useSettingsBackupStore = create<SettingsBackupState>((set, get) => ({
  snapshots: [],
  loaded:  false,
  loading: false,
  running: false,
  busyId:  null,
  error:   null,

  load: async (force = false) => {
    if (!force && (get().loaded || get().loading)) return inflight ?? Promise.resolve();
    if (inflight && !force) return inflight;

    set({ loading: true, error: null });
    inflight = (async () => {
      try {
        const data = await call<{ snapshots: SettingsSnapshotSummary[] }>({ action: 'list' });
        set({ snapshots: data.snapshots ?? [], loaded: true, error: null });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not load the backup history.';
        // Not being signed in yet is a state, not a failure: leave the section quiet and let
        // the next mount (with a resolved session) load it.
        set({ error: msg === 'Not signed in' ? null : msg });
      } finally {
        set({ loading: false });
        inflight = null;
      }
    })();
    return inflight;
  },

  runBackup: async () => {
    set({ running: true, error: null });
    try {
      const result = await call<BackupResult>({ action: 'backup' });
      // Re-read rather than splice the result in: the server is the one that decides what a
      // stored snapshot looks like, and a history that disagrees with it helps nobody.
      await get().load(true);
      return result;
    } finally {
      set({ running: false });
    }
  },

  fetchSnapshot: async (id: string) => {
    const data = await call<{ snapshot: SettingsSnapshot }>({ action: 'get', id });
    return data.snapshot;
  },

  restoreSnapshot: async (id: string) => {
    set({ busyId: id, error: null });
    try {
      const result = await call<RestoreResult>({ action: 'restore', id });
      // The restore takes a safety snapshot of its own, so the history has changed.
      await get().load(true);
      return result;
    } finally {
      set({ busyId: null });
    }
  },

  deleteSnapshot: async (id: string) => {
    set({ busyId: id, error: null });
    try {
      await call<{ ok: boolean }>({ action: 'delete', id });
      await get().load(true);
    } finally {
      set({ busyId: null });
    }
  },
}));

/** The most recent snapshot, or null when nothing has been backed up yet. */
export function useLastSettingsSnapshot(): SettingsSnapshotSummary | null {
  return useSettingsBackupStore(s => s.snapshots[0] ?? null);
}
