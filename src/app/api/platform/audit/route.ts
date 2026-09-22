import { NextRequest, NextResponse } from 'next/server';
import { verifyPlatformCaller } from '@/lib/platformAdmins';
import { PlatformError, listAudit, restoreFromAudit } from '@/lib/platformTenants';

/**
 * The tenant configuration history.
 *
 *   GET   recent changes, newest first
 *   POST  { entryId } — put the tenant back the way that entry found it
 *
 * A restore is applied as an ordinary update, so it passes the same validation and lands in
 * the trail itself. History is append-only: undoing a change adds to it rather than erasing
 * anything, which is the point of having it on a surface this privileged.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

const bearer = (req: NextRequest): string =>
  (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();

export async function GET(req: NextRequest) {
  const caller = await verifyPlatformCaller(bearer(req));
  if (!caller) return notFound();
  try {
    const raw = Number(new URL(req.url).searchParams.get('limit'));
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(raw, 1), 200) : 100;
    return NextResponse.json({ entries: await listAudit(limit) });
  } catch (e) {
    console.error('[api/platform/audit] list failed', e);
    return NextResponse.json({ error: 'Request failed.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const caller = await verifyPlatformCaller(bearer(req));
  if (!caller) return notFound();
  try {
    const { entryId } = await req.json();
    if (typeof entryId !== 'string' || !entryId) {
      return NextResponse.json({ error: 'A history entry id is required.' }, { status: 400 });
    }
    return NextResponse.json({ tenant: await restoreFromAudit(entryId, caller.email) });
  } catch (e) {
    if (e instanceof PlatformError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error('[api/platform/audit] restore failed', e);
    return NextResponse.json({ error: 'Request failed.' }, { status: 500 });
  }
}
