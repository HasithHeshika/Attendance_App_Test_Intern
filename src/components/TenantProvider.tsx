'use client';
import { createContext, useContext } from 'react';
import type { Tenant } from '@/lib/tenants';
import { clientTenant } from '@/lib/tenantClient';

/**
 * Makes the request's tenant available to React.
 *
 * There are two channels for the same fact, and they are not redundant:
 *
 *   window.__TENANT__   read at MODULE scope by src/lib/firebase.ts and by the ~20 places
 *                       that do `const F = tenant.features` at import time. Must be a plain
 *                       synchronous global; React cannot help there.
 *   this context        read during RENDER. The root layout resolves the tenant on the server
 *                       and passes it down, so server-rendered HTML already carries the right
 *                       brand — no empty first paint, no hydration mismatch, and no inline
 *                       script rewriting sentences like "Install {brand}" after the fact.
 *
 * Falls back to the injected global when a consumer somehow renders outside the provider, so a
 * misplaced component degrades to the old behaviour instead of throwing.
 */
const TenantContext = createContext<Tenant | null>(null);

export function TenantProvider({ tenant, children }: { tenant: Tenant; children: React.ReactNode }) {
  return <TenantContext.Provider value={tenant}>{children}</TenantContext.Provider>;
}

/** The current tenant, for anything that renders. */
export function useTenant(): Tenant {
  return useContext(TenantContext) ?? clientTenant();
}
