import { normalizeTenant, tenantForDbId, type Tenant } from '@/lib/tenants';

/**
 * The browser's view of "which tenant am I?".
 *
 * The client CANNOT resolve this itself any more. The tenant list lives in the `tenants`
 * Firestore database, and reading it would require already knowing which database to open —
 * the chicken and egg this whole design exists to break. So the server resolves the host and
 * injects the answer into the page, and this module reads it.
 *
 * The injection is an inline script at the top of <body> (see src/app/layout.tsx), which runs
 * before any bundle. That ordering is load-bearing: it is what lets module-scope reads like
 * `const F = tenant.features` in useSidebarNav.ts keep working, so roughly twenty call sites
 * never had to change.
 */

declare global {
  interface Window {
    /** Injected by the root layout. Shape of a Tenant, but treated as untrusted here. */
    __TENANT__?: unknown;
  }
}

/** The key the layout writes and this module reads. Kept in one place so they cannot drift. */
export const TENANT_GLOBAL = '__TENANT__';

/**
 * The injected tenant, or null when there is nothing to read — during SSR of a client
 * component, or if the script somehow did not run. Every field is re-normalised rather than
 * trusted: this arrives as JSON on a global, and the cost of a malformed one is a crash deep
 * inside rendering.
 */
export function readInjectedTenant(): Tenant | null {
  if (typeof window === 'undefined') return null;
  const raw = window.__TENANT__;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return typeof o.id === 'string' && o.id ? normalizeTenant(o.id, o) : null;
}

/**
 * The tenant for this browser. Falls back to NEXT_PUBLIC_FIRESTORE_DB_ID when nothing was
 * injected, which covers SSR of client components and any non-browser evaluation.
 *
 * The fallback deliberately carries NO registered tenant's branding or flags — an empty list
 * means tenantForDbId builds a synthetic tenant around the database id it was given. Guessing
 * some other tenant's identity here is exactly how a domain ends up rendering the wrong brand.
 */
export function clientTenant(): Tenant {
  return readInjectedTenant() ?? tenantForDbId(process.env.NEXT_PUBLIC_FIRESTORE_DB_ID, []);
}
