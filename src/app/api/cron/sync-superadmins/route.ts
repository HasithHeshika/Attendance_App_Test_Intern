import { NextRequest, NextResponse } from 'next/server';
import { syncSuperAdmins } from '@/lib/superAdminSync';
import { secretEquals } from '@/lib/timingSafe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Superadmin mirroring job — poll this daily from the same scheduler that drives the other
 * cron routes. It writes for real (dryRun: false), so a tenant database added to TENANTS since
 * the last run is seeded with every active superadmin on the next run, and an admin revoked in
 * their home database loses their mirrors everywhere else. See src/lib/superAdminSync.ts.
 *
 * No `?tenant=` handling on purpose: mirroring is inherently cross-database, so this job always
 * covers every tenant regardless of which host the scheduler hits.
 *
 * Auth: a shared secret in the `Authorization: Bearer <CRON_SECRET>` header (or `?key=` for
 * schedulers that can't set headers). Never callable by end users.
 */

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if unconfigured
  const header = req.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const key = bearer || req.nextUrl.searchParams.get('key') || '';
  return secretEquals(key, secret);
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const result = await syncSuperAdmins({ dryRun: false });
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    console.error('[cron/sync-superadmins]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// Allow GET too — many cron/uptime pingers only issue GETs.
export async function GET(req: NextRequest) {
  return POST(req);
}
