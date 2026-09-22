// What counts as this tenant's SETTINGS, and what must never leave the tenant database.
//
// The backup copies configuration — the things an admin sets up once and would have to rebuild
// by hand — into the shared `tenants` database, one snapshot per run, per tenant. It is
// deliberately NOT a data backup: attendance, leaves, bills, payroll results and every other
// transactional collection stay where they are (see scripts/firestore-backup.mjs and
// /api/admin/backup for the full export).
//
// Pure and Firestore-free so the policy — especially what is redacted — can be unit tested
// (see src/lib/__tests__/settingsBackup.test.ts).

/** One configuration collection worth keeping a copy of. */
export interface SettingsSource {
  /** Firestore collection id in the tenant's own database. */
  collection: string;
  /** What it holds, in a sentence an admin would recognise. */
  label: string;
  /**
   * Only these document ids are copied. Absent means the whole collection — used for the
   * small, purely-configuration collections where every document is settings.
   */
  onlyDocs?: string[];
  /**
   * Document ids to skip, matched exactly or by prefix (a trailing '*'). Used where a
   * settings collection also holds credentials.
   */
  skipDocs?: string[];
  /** Field names dropped from every document in this collection, at any depth. */
  redactFields?: string[];
}

/**
 * The settings this app backs up.
 *
 * Two rules decided every entry:
 *   • it is configuration a person entered, not a record the system produced; and
 *   • losing it would mean rebuilding the tenant by hand.
 *
 * Counters (suspense_bill_counters, suspense_voucher_counters) are deliberately absent: they
 * are running sequence state, and restoring an old one would re-issue numbers that already
 * exist. app_config is absent too — it holds the OneDrive client secret, and a secret has no
 * business being copied into another database (see SECRET_COLLECTIONS below).
 */
export const SETTINGS_SOURCES: SettingsSource[] = [
  { collection: 'roles',                 label: 'Roles and their capabilities' },
  { collection: 'companies',             label: 'Companies' },
  { collection: 'departments',           label: 'Departments' },
  { collection: 'working_places',        label: 'Working places and their chamaries' },
  { collection: 'outstation_locations',  label: 'Outstation locations' },
  { collection: 'leave_types',           label: 'Leave types' },
  { collection: 'holiday_settings',      label: 'Accepted holidays, per year' },
  { collection: 'shift_definitions',     label: 'Shift definitions' },
  { collection: 'task_status_config',    label: 'Task board statuses' },
  { collection: 'suspense_categories',   label: 'Suspense expense categories' },
  {
    collection: 'suspense_settings',
    label: 'Suspense voucher grouping and float limits',
    // Every approval PIN lives in this collection as `approval_pin_<epf>` (a salted hash).
    // A hash is not a password, but it is a credential, and a credential copied into a
    // second database is a second place it can leak from. An approver who loses one simply
    // sets a new PIN, so nothing of value is lost by leaving them behind.
    skipDocs: ['approval_pin_*'],
  },
  { collection: 'payroll_settings',      label: 'Payroll policy' },
  { collection: 'payroll_components',    label: 'Payroll components' },
];

/**
 * Collections that must NEVER be copied out of the tenant database, whatever else changes.
 * Checked at runtime as a second gate, so adding a source above can't quietly ship a secret.
 */
export const SECRET_COLLECTIONS = new Set(['app_config']);

/** Field names dropped from every backed-up document, at any depth. */
export const ALWAYS_REDACTED_FIELDS = new Set([
  'client_secret', 'clientSecret', 'secret', 'password', 'api_key', 'apiKey',
  'access_token', 'refresh_token', 'private_key', 'privateKey', 'pin_hash', 'pin_salt',
  'fcm_token',
]);

/** Placeholder left where a redacted value was, so a restore never silently writes a blank. */
export const REDACTED = '[redacted]';

export function isSecretCollection(collection: string): boolean {
  return SECRET_COLLECTIONS.has(collection);
}

/** Does `docId` match one of `patterns`? A trailing '*' matches by prefix. */
export function matchesDocPattern(docId: string, patterns: string[] | undefined): boolean {
  if (!patterns?.length) return false;
  return patterns.some(p => (p.endsWith('*') ? docId.startsWith(p.slice(0, -1)) : docId === p));
}

/** Should this document be copied? */
export function shouldBackupDoc(source: SettingsSource, docId: string): boolean {
  if (isSecretCollection(source.collection)) return false;
  if (source.onlyDocs && !source.onlyDocs.includes(docId)) return false;
  if (matchesDocPattern(docId, source.skipDocs)) return false;
  return true;
}

/** Strip every redacted field from a document, at any depth, leaving REDACTED in its place. */
export function redactDocument(data: unknown, extra?: string[]): unknown {
  const extraSet = new Set(extra ?? []);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const rec = v as Record<string, unknown>;
      // A tagged Firestore value (see the encoder in /api/admin/backup) is a leaf, not a map
      // to walk into — walking it would rename its own fields.
      if (typeof rec.__fs__ === 'string') return v;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(rec)) {
        out[k] = (ALWAYS_REDACTED_FIELDS.has(k) || extraSet.has(k)) ? REDACTED : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(data);
}

export interface SettingsSnapshotCollection {
  label:  string;
  docs:   Record<string, unknown>;
  /** Documents skipped by policy (credentials, non-settings docs) — counted, never copied. */
  skipped: number;
}

export interface SettingsSnapshot {
  /** Tenant this snapshot belongs to. */
  tenant_id:    string;
  tenant_label: string;
  /** The tenant's own Firestore database id ('' = the project default). */
  db_id:        string;
  /** ISO string, stamped by the caller — this module never reads a clock. */
  taken_at:     string;
  taken_by_epf:  string;
  taken_by_name: string;
  /** Schema version of THIS shape, so a future reader can tell what it is looking at. */
  version:      number;
  collections:  Record<string, SettingsSnapshotCollection>;
  totals:       { collections: number; documents: number; skipped: number };
}

export const SNAPSHOT_VERSION = 1;

/**
 * Remove every field the backup redacted, at any depth, so a restore leaves the live value
 * alone instead of overwriting a real credential with the string '[redacted]'. Returns the
 * cleaned value and the dotted paths that were dropped, so a restore can report honestly what
 * it did not put back.
 *
 * A tagged Firestore value (`__fs__`) is a leaf — the same rule redactDocument follows.
 */
export function stripRedacted(
  data: unknown, path = '',
): { value: unknown; dropped: string[] } {
  const dropped: string[] = [];
  const walk = (v: unknown, p: string): unknown => {
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${p}[${i}]`));
    if (v && typeof v === 'object') {
      const rec = v as Record<string, unknown>;
      if (typeof rec.__fs__ === 'string') return v;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(rec)) {
        const child = p ? `${p}.${k}` : k;
        if (val === REDACTED) { dropped.push(child); continue; }
        out[k] = walk(val, child);
      }
      return out;
    }
    return v;
  };
  return { value: walk(data, path), dropped };
}

/** One document a restore will write back. */
export interface RestoreWrite {
  collection: string;
  docId:      string;
  data:       Record<string, unknown>;
}

/**
 * What restoring a snapshot would write. Merge semantics, decided here rather than at the
 * call site: every document in the snapshot is written, redacted fields are left as they are
 * live, and a document that exists now but is absent from the snapshot is NOT deleted.
 *
 * That last rule is deliberate. A settings restore is for getting a configuration back, not
 * for making the database identical to a past moment, and silently deleting a role or a
 * working place someone added since the backup would be the most destructive thing this
 * feature could do. Anything extra is left for a human to remove.
 */
export function planRestore(
  snapshot: Pick<SettingsSnapshot, 'collections'>,
): { writes: RestoreWrite[]; redactedFields: number; collections: number } {
  const writes: RestoreWrite[] = [];
  let redactedFields = 0;
  let collections = 0;
  for (const [collection, c] of Object.entries(snapshot.collections ?? {})) {
    const docs = Object.entries(c?.docs ?? {});
    if (docs.length) collections++;
    for (const [docId, raw] of docs) {
      const { value, dropped } = stripRedacted(raw);
      redactedFields += dropped.length;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        writes.push({ collection, docId, data: value as Record<string, unknown> });
      }
    }
  }
  return { writes, redactedFields, collections };
}

/**
 * The newest snapshot is the one an admin would reach for after a bad restore, so it is not
 * deletable. Ids are ISO timestamps with their punctuation swapped, so the newest is simply
 * the largest string.
 */
export function newestSnapshotId(ids: string[]): string | null {
  return ids.length ? ids.slice().sort((a, b) => b.localeCompare(a))[0] : null;
}

export function canDeleteSnapshot(id: string, allIds: string[]): boolean {
  if (!id || !allIds.includes(id)) return false;
  if (allIds.length <= 1) return false;
  return id !== newestSnapshotId(allIds);
}

/** Build the snapshot from documents already read out of Firestore and encoded for JSON. */
export function buildSettingsSnapshot(opts: {
  tenant:  { id: string; label: string; dbId: string };
  takenAt: string;
  actor:   { epf: string; name: string };
  read:    Array<{ collection: string; docs: Array<{ id: string; data: unknown }> }>;
}): SettingsSnapshot {
  const byCollection = new Map(SETTINGS_SOURCES.map(s => [s.collection, s]));
  const collections: Record<string, SettingsSnapshotCollection> = {};
  let documents = 0, skipped = 0;

  for (const entry of opts.read) {
    const source = byCollection.get(entry.collection);
    if (!source || isSecretCollection(entry.collection)) continue;
    const docs: Record<string, unknown> = {};
    let skippedHere = 0;
    for (const d of entry.docs) {
      if (!shouldBackupDoc(source, d.id)) { skippedHere += 1; continue; }
      docs[d.id] = redactDocument(d.data, source.redactFields);
      documents += 1;
    }
    skipped += skippedHere;
    collections[entry.collection] = { label: source.label, docs, skipped: skippedHere };
  }

  return {
    tenant_id: opts.tenant.id, tenant_label: opts.tenant.label, db_id: opts.tenant.dbId,
    taken_at: opts.takenAt,
    taken_by_epf: opts.actor.epf, taken_by_name: opts.actor.name,
    version: SNAPSHOT_VERSION,
    collections,
    totals: { collections: Object.keys(collections).length, documents, skipped },
  };
}

/** Snapshot id: sortable, readable, and unique per second. */
export function snapshotId(takenAtIso: string): string {
  return takenAtIso.replace(/[:.]/g, '-');
}

/** A one-line summary for the settings screen. */
export function describeSnapshot(s: Pick<SettingsSnapshot, 'totals'>): string {
  const { collections, documents, skipped } = s.totals;
  const base = `${documents} document${documents === 1 ? '' : 's'} across ${collections} collection${collections === 1 ? '' : 's'}`;
  return skipped > 0 ? `${base} · ${skipped} skipped by policy` : base;
}
