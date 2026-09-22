import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebaseAdmin';
import { getCachedSolarSites, fetchSolarSitesFresh } from '@/lib/solarSitesCache';
import { adminDbFor } from '@/lib/firebaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function adminIsConfigured(): boolean {
  return !!(
    process.env.FIREBASE_ADMIN_PROJECT_ID &&
    process.env.FIREBASE_ADMIN_CLIENT_EMAIL &&
    process.env.FIREBASE_ADMIN_PRIVATE_KEY
  );
}

/**
 * Solar sites (with GPS) for the working-place picker. Requires an authenticated user
 * (any role) when Firebase Admin is configured; in local dev without it, allowed. The
 * EXTERNAL_API_KEY stays server-side.
 *
 * On failure we now return a `reason` (and log it) instead of a silent empty list, so a
 * production-only outage (missing env var, blocked egress, bad token) is diagnosable.
 * See GET below for a no-auth config probe.
 */
export async function POST(req: NextRequest) {
  try {
    const { idToken } = await req.json().catch(() => ({}));

    if (adminIsConfigured()) {
      if (!idToken) return NextResponse.json({ success: false, sites: [], reason: 'no_token' }, { status: 401 });
      try {
        await adminAuth().verifyIdToken(idToken);
      } catch (e) {
        console.error('[solar/projects] verifyIdToken failed:', e);
        return NextResponse.json({ success: false, sites: [], reason: 'bad_token' }, { status: 401 });
      }
    }

    // Served from the server-side hourly cache (in-memory + Firestore) — upstream Solar is
    // hit at most once per hour for the whole deployment, not once per client/reload.
    const { sites, fetchedAt, stale } = await getCachedSolarSites(adminDbFor(req));
    return NextResponse.json(
      { success: true, count: sites.length, sites, cachedAt: new Date(fetchedAt).toISOString(), stale },
      { headers: { 'Cache-Control': 'private, max-age=300' } },
    );
  } catch (e) {
    // Most likely: EXTERNAL_API_KEY missing/wrong, or the Solar API rejected the request.
    console.error('[solar/projects] failed:', e);
    return NextResponse.json(
      { success: false, sites: [], reason: e instanceof Error ? e.message : 'error' },
      { status: 200 },
    );
  }
}

/**
 * Config probe — open `https://<your-site>/api/solar/projects` in a browser to see WHY
 * the picker is empty in production. Returns booleans only (no secret values) plus the
 * live result of the server→Solar fetch. Safe to expose: it leaks no keys.
 *   • keyPresent:false      → EXTERNAL_API_KEY isn't reaching this function (wrong name /
 *                             wrong Netlify context / site not redeployed since you added it)
 *   • solar.ok:false 401/403→ the key value is wrong, or Solar blocks this server's egress
 *   • adminConfigured:true  → the POST also needs a valid Firebase idToken from the client
 */
export async function GET() {
  const keyPresent      = !!process.env.EXTERNAL_API_KEY;
  const adminConfigured = adminIsConfigured();
  const solarAppUrl     = process.env.SOLAR_APP_URL || 'https://solar.altavision.lk (default)';

  // Does Firebase Admin actually initialise with the configured key? This is the check
  // that catches the FIREBASE_ADMIN_PRIVATE_KEY newline/quote/base64 problem. `adminInit.ok`
  // false ⇒ the POST will return "bad_token" for everyone (the prod-only failure).
  let adminInit: { ok: boolean; error?: string } = { ok: false, error: 'not configured' };
  if (adminConfigured) {
    try {
      // createCustomToken signs locally with the private key, so a malformed key throws
      // here (whereas constructing adminAuth() alone parses the key lazily and wouldn't).
      await adminAuth().createCustomToken('__probe__');
      adminInit = { ok: true };
    } catch (e) {
      adminInit = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  let solar: { ok: boolean; count?: number; error?: string };
  try {
    // Probe upstream directly (not the hourly cache) so this diagnoses live connectivity.
    const sites = await fetchSolarSitesFresh();
    solar = { ok: true, count: sites.length };
  } catch (e) {
    solar = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json({
    keyPresent,
    adminConfigured,
    adminInit,
    solarAppUrl,
    solar,
    note: 'Config probe. The picker calls POST { idToken }; this GET leaks no secret values.',
  });
}
