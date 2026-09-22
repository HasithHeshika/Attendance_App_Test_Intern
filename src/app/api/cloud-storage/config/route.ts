import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { CONFIG_COL, CONFIG_ID, PUBLIC_ID, verifyManager, readCloudConfig } from '@/lib/cloudStorageServer';
import type { CloudStorageConfig } from '@/lib/types';

export const runtime = 'nodejs';

// Return the config WITHOUT the secret (only whether one is set).
export async function GET(req: NextRequest) {
  const db = adminDbFor(req);
  const idToken = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const mgr = await verifyManager(db, idToken);
  if (!mgr) return NextResponse.json({ error: 'User management access required' }, { status: 403 });

  const cfg = await readCloudConfig(db);
  const od  = cfg?.onedrive;
  return NextResponse.json({
    provider: cfg?.provider ?? 'firebase',
    onedrive: od ? {
      tenant_id:              od.tenant_id ?? '',
      client_id:              od.client_id ?? '',
      folder_path:            od.folder_path ?? '',
      secret_created_date:    od.secret_created_date ?? '',
      secret_duration_months: od.secret_duration_months ?? 24,
      has_secret:             !!od.client_secret,
    } : null,
    updated_at: cfg?.updated_at ?? null,
  });
}

// Save the config. A blank client_secret keeps the previously-stored one.
export async function POST(req: NextRequest) {
  const { idToken, config } = await req.json().catch(() => ({} as { idToken?: string; config?: CloudStorageConfig }));
  const db = adminDbFor(req);
  const mgr = await verifyManager(db, idToken ?? '');
  if (!mgr) return NextResponse.json({ error: 'User management access required' }, { status: 403 });

  const existing = await readCloudConfig(db);
  const provider = config?.provider === 'onedrive' ? 'onedrive' : 'firebase';
  const od = config?.onedrive;
  const cfg: CloudStorageConfig = {
    provider,
    onedrive: {
      tenant_id:   od?.tenant_id   ?? existing?.onedrive?.tenant_id   ?? '',
      client_id:   od?.client_id   ?? existing?.onedrive?.client_id   ?? '',
      client_secret: (od?.client_secret && od.client_secret.trim())
        ? od.client_secret.trim()
        : (existing?.onedrive?.client_secret ?? ''),
      folder_path: od?.folder_path ?? existing?.onedrive?.folder_path ?? '',
      secret_created_date:    od?.secret_created_date ?? existing?.onedrive?.secret_created_date ?? '',
      secret_duration_months: Number(od?.secret_duration_months ?? existing?.onedrive?.secret_duration_months ?? 24),
    },
    updated_at: new Date().toISOString(),
    updated_by: mgr.uid,
  };

  // OneDrive must be fully configured before it can become the active provider — otherwise
  // every bill upload would fail opaquely against blank credentials.
  if (provider === 'onedrive') {
    const od2 = cfg.onedrive!;
    const missing = [
      !od2.tenant_id?.trim()     && 'Tenant ID',
      !od2.client_id?.trim()     && 'Client ID',
      !od2.client_secret?.trim() && 'Client Secret',
      !od2.folder_path?.trim()   && 'Folder path',
    ].filter(Boolean) as string[];
    if (missing.length) return NextResponse.json({ error: `OneDrive requires: ${missing.join(', ')}.` }, { status: 400 });
    if (/[?#]|\.\./.test(od2.folder_path)) return NextResponse.json({ error: 'Folder path contains invalid characters (? # ..).' }, { status: 400 });
  }

  // Write the config + the public provider mirror ATOMICALLY so they can never desync
  // (a stale mirror would mis-route or block every bill upload).
  const batch = db.batch();
  batch.set(db.collection(CONFIG_COL).doc(CONFIG_ID), cfg, { merge: true });
  batch.set(db.collection(CONFIG_COL).doc(PUBLIC_ID), { provider, updated_at: cfg.updated_at }, { merge: true });
  await batch.commit();
  return NextResponse.json({ success: true });
}
