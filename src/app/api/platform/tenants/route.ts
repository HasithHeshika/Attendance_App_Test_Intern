import { NextRequest, NextResponse } from 'next/server';
import { verifyPlatformCaller } from '@/lib/platformAdmins';
import {
  PlatformError, createTenant, listTenantRecords, updateTenant,
} from '@/lib/platformTenants';

/**
 * Tenant configuration for the /platform UI.
 *
 *   GET    list every tenant
 *   POST   register a new tenant against an existing database   (bootstrap only)
 *   PATCH  change an existing tenant's branding, domains, flags or status
 *
 * Every response to an unauthorised caller is a 404, not a 403: a 403 confirms the route
 * exists and that there is something here worth finding. The bearer token is re-verified and
 * re-checked against the platform_admins list on EVERY request — the `platform_admin` custom
 * claim only decides whether the app renders a button.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

const bearer = (req: NextRequest): string =>
  (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();

/** PlatformError carries a message meant for the operator; anything else must not leak. */
function fail(e: unknown) {
  if (e instanceof PlatformError) return NextResponse.json({ error: e.message }, { status: 400 });
  console.error('[api/platform/tenants]', e);
  return NextResponse.json({ error: 'Request failed.' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  const caller = await verifyPlatformCaller(bearer(req));
  if (!caller) return notFound();
  try {
    return NextResponse.json({
      tenants: await listTenantRecords(),
      caller: { email: caller.email, isBootstrap: caller.isBootstrap },
    });
  } catch (e) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const caller = await verifyPlatformCaller(bearer(req));
  if (!caller) return notFound();
  // Registering a tenant decides which database a domain talks to. Editing flags is routine;
  // this is not, so it stays with the account that cannot be locked out.
  if (!caller.isBootstrap) {
    return NextResponse.json(
      { error: 'Only the bootstrap administrator can register a tenant.' },
      { status: 403 },
    );
  }
  try {
    const body = await req.json();
    return NextResponse.json({ tenant: await createTenant(body, caller.email) });
  } catch (e) { return fail(e); }
}

export async function PATCH(req: NextRequest) {
  const caller = await verifyPlatformCaller(bearer(req));
  if (!caller) return notFound();
  try {
    const { id, ...patch } = await req.json();
    if (typeof id !== 'string' || !id) {
      return NextResponse.json({ error: 'A tenant id is required.' }, { status: 400 });
    }
    // Disabling a tenant takes every one of its domains offline — same weight as registering
    // one, so the same gate.
    if (patch.status === 'disabled' && !caller.isBootstrap) {
      return NextResponse.json(
        { error: 'Only the bootstrap administrator can disable a tenant.' },
        { status: 403 },
      );
    }
    // `dbId` is absent from TenantPatch, so updateTenant has no path that writes one. Say so
    // out loud rather than accepting the field and silently dropping it.
    if ('dbId' in patch) {
      return NextResponse.json(
        { error: 'A tenant’s database cannot be changed after it is registered.' },
        { status: 400 },
      );
    }
    return NextResponse.json({ tenant: await updateTenant(id, patch, caller.email) });
  } catch (e) { return fail(e); }
}
