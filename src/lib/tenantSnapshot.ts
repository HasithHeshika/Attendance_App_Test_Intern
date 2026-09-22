import snapshot from '@/generated/tenants.snapshot.json';
import { normalizeTenant, type Tenant } from '@/lib/tenants';

/**
 * The tenant list that SHIPPED with this deploy.
 *
 * Deliberately its own module, importing nothing but JSON and pure helpers, because two very
 * different callers need it and only one of them can touch firebase-admin:
 *
 *   • src/proxy.ts — Edge middleware. firebase-admin cannot run there at all, so the snapshot
 *     is the only tenant list it can have.
 *   • src/lib/tenantRegistry.ts — uses it as the cold-start fallback when the `tenants`
 *     database is unreachable.
 *
 * Written by scripts/generate-tenant-snapshot.mjs from the live database before each build, so
 * it is never hand-authored. It exists so that one bad write or one Firestore outage cannot
 * darken every domain at once: without it, no code path knows what carecode.org is.
 *
 * It is a FALLBACK, not a source of truth. Anything that can afford to await should read the
 * registry instead — the snapshot is only as fresh as the last deploy.
 */
export const SNAPSHOT_GENERATED_AT: string = snapshot.generatedAt ?? '';

const TENANTS: Tenant[] = (snapshot.tenants ?? []).map(t =>
  normalizeTenant(t.id, t as unknown as Record<string, unknown>),
);

/** The shipped tenant list. Same array every call — treat it as read-only. */
export function snapshotTenants(): Tenant[] {
  return TENANTS;
}
