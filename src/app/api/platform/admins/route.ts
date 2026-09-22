import { NextRequest, NextResponse } from 'next/server';
import {
  addPlatformAdmin, listPlatformAdmins, removePlatformAdmin, verifyPlatformCaller,
} from '@/lib/platformAdmins';
import { auditAdminChange } from '@/lib/platformTenants';

/**
 * The platform administrator list.
 *
 *   GET     who currently holds platform access
 *   POST    grant it        (bootstrap only)
 *   DELETE  revoke it       (bootstrap only)
 *
 * Reading the list needs platform access; CHANGING it is bootstrap-only, because this is the
 * list that decides who can change everything else. The bootstrap account itself cannot be
 * removed — the collection going empty must never mean nobody can get back in.
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
    return NextResponse.json({ admins: await listPlatformAdmins() });
  } catch (e) {
    console.error('[api/platform/admins] list failed', e);
    return NextResponse.json({ error: 'Request failed.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const caller = await verifyPlatformCaller(bearer(req));
  if (!caller) return notFound();
  if (!caller.isBootstrap) {
    return NextResponse.json(
      { error: 'Only the bootstrap administrator can grant platform access.' },
      { status: 403 },
    );
  }
  try {
    const { email, name } = await req.json();
    const admin = await addPlatformAdmin(String(email ?? ''), String(name ?? ''), caller.email);
    await auditAdminChange('admin_add', caller.email, admin.email);
    return NextResponse.json({ admin });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Request failed.' },
      { status: 400 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const caller = await verifyPlatformCaller(bearer(req));
  if (!caller) return notFound();
  if (!caller.isBootstrap) {
    return NextResponse.json(
      { error: 'Only the bootstrap administrator can revoke platform access.' },
      { status: 403 },
    );
  }
  try {
    const email = String(new URL(req.url).searchParams.get('email') ?? '');
    await removePlatformAdmin(email);
    await auditAdminChange('admin_remove', caller.email, email.trim().toLowerCase());
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Request failed.' },
      { status: 400 },
    );
  }
}
