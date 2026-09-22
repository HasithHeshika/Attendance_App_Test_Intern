'use client';
import { clientTenant } from '@/lib/tenantClient';
import { useTenant } from '@/components/TenantProvider';

/**
 * The current domain's app name — "PearlCluster" on altavision.lk, "CareCode" on carecode.org.
 * Read from the tenant the server injected into the page (src/lib/tenantClient.ts), not from
 * the hostname: the domain→brand map lives in the `tenants` database now.
 */
export function brandName(): string {
  return clientTenant().appName;
}

/**
 * React-safe form of brandName().
 *
 * Reads the tenant the root layout resolved on the server, so the FIRST render — server and
 * client alike — already carries the right name. It used to start on the default tenant's
 * name and correct after mount, which painted "PearlCluster" for a frame on carecode.org;
 * there is no such frame now, and no hydration mismatch to suppress.
 */
export function useBrandName(): string {
  return useTenant().appName;
}

// Re-exported from tenants.ts (the root layout needs it server-side too) so every
// existing `import { splitBrandName } from '@/lib/brand'` keeps working.
export { splitBrandName } from '@/lib/tenants';
