import { NextRequest, NextResponse } from 'next/server';
import { verifyUser, readCloudConfig } from '@/lib/cloudStorageServer';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { uploadToOneDrive } from '@/lib/msgraph';

export const runtime = 'nodejs';

// Upload a file to OneDrive via Microsoft Graph. Any authenticated user may upload a bill;
// the Firebase path is handled client-side, so this route is only hit when OneDrive is active.
export async function POST(req: NextRequest) {
  try {
    const form    = await req.formData();
    const idToken = String(form.get('idToken') ?? '');
    const file    = form.get('file') as File | null;
    const relPath = String(form.get('path') ?? form.get('filename') ?? file?.name ?? 'upload');

    const user = await verifyUser(idToken);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

    const cfg = await readCloudConfig(adminDbFor(req));
    if (cfg?.provider !== 'onedrive' || !cfg.onedrive) {
      return NextResponse.json({ error: 'OneDrive is not the active provider.' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await uploadToOneDrive(cfg.onedrive, relPath, buffer, file.type);
    return NextResponse.json({ url: result.url, id: result.id, name: result.name });
  } catch (e) {
    console.error('[cloud-storage/upload]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Upload failed' }, { status: 500 });
  }
}
