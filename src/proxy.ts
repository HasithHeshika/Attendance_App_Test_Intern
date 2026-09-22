import { NextResponse, type NextRequest } from 'next/server';
import { BRANDED_ASSETS, tenantByHost } from '@/lib/tenants';
import { snapshotTenants } from '@/lib/tenantSnapshot';

/**
 * Per-domain branding.
 *
 * ONE deployment serves altavision.lk and carecode.org, and the page HTML is prerendered
 * once and shared by both — so the icon links inside it are identical. Rather than rewrite
 * the ~18 places that hardcode /icon.png, /app.png and /favicon.ico (UI images, push
 * notification payloads, firebase-messaging-sw.js and sw-reminder.js), we serve DIFFERENT
 * BYTES at the SAME paths depending on the request host.
 *
 * Everything stays a static file, so this costs one rewrite and no dynamic rendering:
 *
 *   carecode.org/icon.png  →  /brand/southernlanka/icon-192.png
 *   altavision.lk/icon.png →  (untouched — brandDir is null)
 *
 * Because the two domains return different bytes for one path, the response MUST NOT be
 * cached under a host-agnostic key, or one brand's icon would be served to the other. See
 * the Vary header below.
 *
 * Tenants live in the `tenants` Firestore database, but this is EDGE middleware and
 * firebase-admin cannot run here — so it reads the snapshot that shipped with the deploy
 * instead. All it needs is host → brandDir, and a new tenant's icons require a deploy
 * regardless: brandDir names real files under public/brand/ that no config UI can upload.
 */
export function proxy(req: NextRequest) {
  const target = BRANDED_ASSETS[req.nextUrl.pathname];
  if (!target) return NextResponse.next();

  const tenant = tenantByHost(
    req.headers.get('x-forwarded-host') || req.headers.get('host'),
    snapshotTenants(),
  );
  if (!tenant?.brandDir) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = `/brand/${tenant.brandDir}/${target}`;

  const res = NextResponse.rewrite(url);
  // Host is normally part of the CDN cache key, but these four paths are the one place
  // where being wrong is visible (a rival brand's logo on your home screen). Vary makes
  // the dependency explicit for any cache in front of us.
  res.headers.set('Vary', 'Host, X-Forwarded-Host');
  return res;
}

export const config = {
  // Only the branded asset paths — everything else skips the middleware entirely.
  matcher: ['/favicon.ico', '/icon.png', '/app.png', '/manifest.json'],
};
