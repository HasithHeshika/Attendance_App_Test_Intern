import { NextRequest, NextResponse } from 'next/server';
import { verifyManager, readCloudConfig } from '@/lib/cloudStorageServer';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { testOneDrive } from '@/lib/msgraph';

export const runtime = 'nodejs';

// Test the currently-saved OneDrive connection (token + folder read).
export async function POST(req: NextRequest) {
  const { idToken } = await req.json().catch(() => ({} as { idToken?: string }));
  const db = adminDbFor(req);
  const mgr = await verifyManager(db, idToken ?? '');
  if (!mgr) return NextResponse.json({ ok: false, detail: 'User management access required' }, { status: 403 });

  const cfg = await readCloudConfig(db);
  if (cfg?.provider !== 'onedrive' || !cfg.onedrive) {
    return NextResponse.json({ ok: false, detail: 'Save OneDrive as the active provider first.' });
  }
  const result = await testOneDrive(cfg.onedrive);
  return NextResponse.json(result);
}
