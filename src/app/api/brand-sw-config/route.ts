import { NextResponse } from 'next/server';
import { tenantByHost, tenantForDbId } from '@/lib/tenants';
import { awaitTenants } from '@/lib/tenantRegistry';

/**
 * Serves the requesting domain's brand as a JavaScript snippet, so the service workers can
 * consume it via importScripts('/api/brand-sw-config').
 *
 * Service workers are static files: they cannot import src/lib/tenants.ts, and they are
 * shared byte-for-byte by every domain this deployment serves. Without this route each
 * worker would have to carry its own copy of the host→brand rules, so adding a tenant would
 * mean editing them too. Resolving it here keeps the `tenants` database the only place a
 * tenant is defined.
 *
 * Mirrors the existing /api/firebase-sw-config pattern.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  // x-forwarded-host first — that's the one Netlify sets to the real domain.
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  const tenants = await awaitTenants();
  const tenant = tenantByHost(host, tenants) ?? tenantForDbId(process.env.FIRESTORE_DB_ID, tenants);

  const brand = {
    id: tenant.id,
    appName: tenant.appName,
    themeColor: tenant.themeColor,
  };

  const js = `self.TENANT_BRAND = ${JSON.stringify(brand)};`;

  return new NextResponse(js, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store, no-cache',
      // The response depends entirely on the host, so make that explicit to any CDN in
      // front of us — same reasoning as the branded-asset rewrites in src/proxy.ts.
      Vary: 'x-forwarded-host, host',
    },
  });
}
