import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/firebaseAdmin';
import {
  TENANTS_COLLECTION, TENANTS_DB_ID, awaitTenants, invalidateTenants,
} from '@/lib/tenantRegistry';
import { FEATURE_KEYS, normalizeDbId, normalizeTenant, type Tenant } from '@/lib/tenants';

/**
 * Tenant configuration writes — SERVER ONLY, and only from /platform.
 *
 * Everything here is guarded by rules that exist because the blast radius is a whole domain:
 *
 *   • `dbId` is immutable. Re-pointing a live domain at another organisation's database is
 *     the single worst thing this UI could do, and no amount of confirmation dialog makes it
 *     safe. Registering a tenant only ever ASSOCIATES a domain with a database that already
 *     exists — the app cannot create one.
 *   • A domain belongs to exactly one tenant. Two tenants claiming carecode.org would make
 *     host resolution depend on document order, which is not a thing anyone should debug.
 *   • Every write is recorded with before/after, so a bad edit is one click from undone.
 */

export const AUDIT_COLLECTION = 'tenant_audit';

export type AuditAction = 'create' | 'update' | 'disable' | 'enable' | 'restore'
  | 'admin_add' | 'admin_remove';

export interface AuditEntry {
  id: string;
  tenantId: string | null;
  actorEmail: string;
  at: string | null;
  action: AuditAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** Field names that differ between before and after — what the history list shows. */
  changed: string[];
}

/** A tenant plus the bookkeeping the UI shows but the app itself never reads. */
export interface TenantRecord extends Tenant {
  createdAt: string | null;
  createdBy: string;
  updatedAt: string | null;
  updatedBy: string;
}

const db = () => adminDb(TENANTS_DB_ID);
const tenantsCol = () => db().collection(TENANTS_COLLECTION);
const auditCol = () => db().collection(AUDIT_COLLECTION);

const iso = (v: unknown): string | null => {
  const t = v as { toDate?: () => Date } | undefined;
  return t?.toDate ? t.toDate().toISOString() : null;
};

/** The editable half of a tenant — what a UI form may send. Never includes `dbId`. */
export interface TenantPatch {
  label?: string;
  domains?: string[];
  appName?: string;
  themeColor?: string;
  brandDir?: string | null;
  features?: Record<string, boolean>;
  status?: 'active' | 'disabled';
}

export class PlatformError extends Error {}

const cleanDomains = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const d of raw) {
    if (typeof d !== 'string') continue;
    // Accept a pasted URL or a host with a port and reduce it to a bare hostname, because
    // that is what tenantByHost compares against.
    const host = d.trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .replace(/\.$/, '');
    if (host && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) seen.add(host);
  }
  return [...seen];
};

/** Reject a domain already claimed by a DIFFERENT tenant — host resolution must be unambiguous. */
async function assertDomainsFree(domains: string[], selfId: string | null): Promise<void> {
  if (domains.length === 0) return;
  const all = await awaitTenants(true);
  for (const t of all) {
    if (t.id === selfId) continue;
    const clash = domains.find(d => t.domains.includes(d));
    if (clash) throw new PlatformError(`${clash} is already registered to "${t.id}".`);
  }
}

/** Only known flags, only booleans — a UI cannot invent a module by posting a new key. */
const cleanFeatures = (raw: unknown): Record<string, boolean> => {
  const src = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const out: Record<string, boolean> = {};
  for (const k of FEATURE_KEYS) if (typeof src[k] === 'boolean') out[k] = src[k] as boolean;
  return out;
};

function diffKeys(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changed: string[] = [];
  for (const k of keys) {
    if (k === 'features') {
      for (const f of FEATURE_KEYS) {
        const b = (before?.features as Record<string, unknown> | undefined)?.[f];
        const a = (after?.features as Record<string, unknown> | undefined)?.[f];
        if (b !== a) changed.push(`features.${f}`);
      }
      continue;
    }
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])) changed.push(k);
  }
  return changed.sort();
}

async function writeAudit(
  action: AuditAction,
  tenantId: string | null,
  actorEmail: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  try {
    await auditCol().add({
      tenant_id: tenantId,
      actor_email: actorEmail,
      at: FieldValue.serverTimestamp(),
      action,
      before,
      after,
      changed: diffKeys(before, after),
    });
  } catch (e) {
    // A lost audit line must not fail the change the operator actually asked for; it is
    // logged loudly instead so the gap is visible.
    console.error('[platformTenants] audit write failed:', e);
  }
}

/** Everything the config UI lists, newest bookkeeping included. */
export async function listTenantRecords(): Promise<TenantRecord[]> {
  const snap = await tenantsCol().get();
  return snap.docs
    .map(d => {
      const data = d.data() as Record<string, unknown>;
      return {
        ...normalizeTenant(d.id, data),
        createdAt: iso(data.created_at),
        createdBy: typeof data.created_by === 'string' ? data.created_by : '',
        updatedAt: iso(data.updated_at),
        updatedBy: typeof data.updated_by === 'string' ? data.updated_by : '',
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The stored fields of one tenant, for auditing and for the editor to preload. */
async function rawTenant(id: string): Promise<Record<string, unknown> | null> {
  const doc = await tenantsCol().doc(id).get();
  return doc.exists ? (doc.data() as Record<string, unknown>) : null;
}

/** Just the fields worth recording — server timestamps are noise in a diff. */
const auditable = (d: Record<string, unknown> | null): Record<string, unknown> | null => {
  if (!d) return null;
  const { created_at: _c, updated_at: _u, created_by: _cb, updated_by: _ub, ...rest } = d;
  return rest;
};

export interface CreateTenantInput extends TenantPatch {
  id: string;
  dbId: string;
}

/**
 * Register a NEW tenant against a database that already exists. Bootstrap only.
 *
 * Note what this cannot do: create a Firestore database (that is a console operation), upload
 * brand images (they are deployed files under public/brand/), or deploy security rules to a
 * new database. Registering a domain is the last step of adding a tenant, not the first.
 */
export async function createTenant(input: CreateTenantInput, actor: string): Promise<TenantRecord> {
  const id = (input.id || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,38}$/.test(id)) {
    throw new PlatformError('Id must be 2–39 characters: lowercase letters, digits and hyphens.');
  }
  if (await rawTenant(id)) throw new PlatformError(`A tenant with the id "${id}" already exists.`);

  const domains = cleanDomains(input.domains);
  await assertDomainsFree(domains, null);

  const dbId = normalizeDbId(input.dbId);
  const doc = {
    label: (input.label || id).trim(),
    domains,
    dbId,
    appName: (input.appName || input.label || id).trim(),
    themeColor: input.themeColor || '#0C8ECA',
    brandDir: input.brandDir?.trim() || null,
    features: cleanFeatures(input.features),
    status: input.status === 'disabled' ? 'disabled' : 'active',
    created_at: FieldValue.serverTimestamp(),
    created_by: actor,
    updated_at: FieldValue.serverTimestamp(),
    updated_by: actor,
  };
  await tenantsCol().doc(id).set(doc);
  invalidateTenants();
  await writeAudit('create', id, actor, null, auditable(doc));

  const saved = await rawTenant(id);
  return {
    ...normalizeTenant(id, saved ?? doc),
    createdAt: iso(saved?.created_at), createdBy: actor,
    updatedAt: iso(saved?.updated_at), updatedBy: actor,
  };
}

/**
 * Change an existing tenant. `dbId` and `id` are not accepted here at all — not validated and
 * rejected, simply absent from TenantPatch, so there is no code path that could write one.
 */
export async function updateTenant(
  id: string, patch: TenantPatch, actor: string,
): Promise<TenantRecord> {
  const before = await rawTenant(id);
  if (!before) throw new PlatformError(`No tenant with the id "${id}".`);

  const next: Record<string, unknown> = {};
  if (patch.label !== undefined) next.label = patch.label.trim();
  if (patch.appName !== undefined) next.appName = patch.appName.trim();
  if (patch.themeColor !== undefined) next.themeColor = patch.themeColor;
  if (patch.brandDir !== undefined) next.brandDir = patch.brandDir?.trim() || null;
  if (patch.status !== undefined) next.status = patch.status === 'disabled' ? 'disabled' : 'active';
  if (patch.domains !== undefined) {
    const domains = cleanDomains(patch.domains);
    await assertDomainsFree(domains, id);
    next.domains = domains;
  }
  if (patch.features !== undefined) {
    // Merged over what is stored, so a UI that posts a subset cannot blank the rest.
    next.features = {
      ...(before.features as Record<string, unknown> ?? {}),
      ...cleanFeatures(patch.features),
    };
  }
  if (Object.keys(next).length === 0) throw new PlatformError('Nothing to change.');

  await tenantsCol().doc(id).set(
    { ...next, updated_at: FieldValue.serverTimestamp(), updated_by: actor },
    { merge: true },
  );
  invalidateTenants();

  const after = await rawTenant(id);
  await writeAudit(
    patch.status === 'disabled' ? 'disable' : patch.status === 'active' ? 'enable' : 'update',
    id, actor, auditable(before), auditable(after),
  );

  return {
    ...normalizeTenant(id, after ?? {}),
    createdAt: iso(after?.created_at),
    createdBy: typeof after?.created_by === 'string' ? after.created_by : '',
    updatedAt: iso(after?.updated_at), updatedBy: actor,
  };
}

/** Recent changes, newest first. */
export async function listAudit(limit = 100): Promise<AuditEntry[]> {
  const snap = await auditCol().orderBy('at', 'desc').limit(limit).get();
  return snap.docs.map(d => {
    const x = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      tenantId: typeof x.tenant_id === 'string' ? x.tenant_id : null,
      actorEmail: typeof x.actor_email === 'string' ? x.actor_email : '',
      at: iso(x.at),
      action: (x.action as AuditAction) ?? 'update',
      before: (x.before as Record<string, unknown> | null) ?? null,
      after: (x.after as Record<string, unknown> | null) ?? null,
      changed: Array.isArray(x.changed)
        ? x.changed.filter((c): c is string => typeof c === 'string')
        : [],
    };
  });
}

/** Record an admin-list change in the same trail, so "who let them in" is answerable. */
export async function auditAdminChange(
  action: 'admin_add' | 'admin_remove', actor: string, subject: string,
): Promise<void> {
  await writeAudit(action, null, actor, null, { email: subject });
}

/**
 * Put a tenant back the way an audit entry found it.
 *
 * Applied as a normal update, so it goes through the same domain-collision check and lands in
 * the audit trail itself — history stays append-only and a restore is as reversible as the
 * change it undoes. `dbId` is not restorable for the same reason it is not editable.
 */
export async function restoreFromAudit(entryId: string, actor: string): Promise<TenantRecord> {
  const doc = await auditCol().doc(entryId).get();
  if (!doc.exists) throw new PlatformError('That history entry no longer exists.');
  const entry = doc.data() as Record<string, unknown>;
  const tenantId = typeof entry.tenant_id === 'string' ? entry.tenant_id : null;
  const before = entry.before as Record<string, unknown> | null;
  if (!tenantId) throw new PlatformError('That entry is not a tenant change.');
  if (!before) throw new PlatformError('That entry created the tenant — there is nothing to restore to.');

  const restored = await updateTenant(tenantId, {
    label: before.label as string | undefined,
    appName: before.appName as string | undefined,
    themeColor: before.themeColor as string | undefined,
    brandDir: (before.brandDir ?? null) as string | null,
    domains: before.domains as string[] | undefined,
    features: before.features as Record<string, boolean> | undefined,
    status: before.status === 'disabled' ? 'disabled' : 'active',
  }, actor);

  await writeAudit('restore', tenantId, actor, null, { restored_from: entryId });
  return restored;
}
