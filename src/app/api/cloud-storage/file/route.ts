import { NextRequest, NextResponse } from 'next/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { readCloudConfig, verifyUser } from '@/lib/cloudStorageServer';
import { getOneDriveItemMeta } from '@/lib/msgraph';

export const runtime = 'nodejs';

// Serve a OneDrive-hosted bill/receipt by its stored item id. Graph's pre-authenticated download
// URL expires (~1h), so bills persist only the opaque item id and this route re-resolves a fresh
// URL on each view. Two things the naive "302 to the download URL" approach got wrong:
//  1. Graph serves file bytes with `Content-Disposition: attachment`, so a redirected <iframe>
//     PDF would download/blank instead of rendering inline — we STREAM with `inline` disposition.
//  2. A by-id resolver can address ANY item in the app's drive (including the nightly DB backup at
//     the drive root). We SCOPE to bills only: suspense bills are filed under a
//     `{company}/{year}/{month}/{billNo}-{employee}-{epf}.{ext}` path (see billFilePath in
//     suspenseService.ts), so we require the item to sit under a 4-digit year folder immediately
//     followed by a 2-digit month folder, and refuse anything else.
//  3. It had NO authentication at all, so the year/month scoping above was the ONLY thing
//     standing between the internet and every employee's expense receipts — security by
//     obscurity of an opaque Graph item id, which leaks through logs and referrers like any
//     other URL fragment. A valid Firebase session is now required.
//
// The token arrives as `?token=` rather than an Authorization header because the stored bill
// URL is rendered straight into <img>/<iframe> src (src/components/BillThumb.tsx), which
// cannot set headers. A header is still accepted for non-browser callers. Both the
// no-referrer header and `Cache-Control: private` below exist to limit where that query
// token can end up.
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const idToken = bearer || req.nextUrl.searchParams.get('token') || '';
  if (!(await verifyUser(idToken))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const cfg = await readCloudConfig(adminDbFor(req));
    if (!cfg?.onedrive) return NextResponse.json({ error: 'OneDrive is not configured.' }, { status: 400 });

    const meta = await getOneDriveItemMeta(cfg.onedrive, id);

    // Scope: bills live under a .../{year}/{month}/ path (new format) or a .../{YYYY-MM}/ path
    // (old format, kept so bills uploaded before this path change stay viewable). Anything else
    // (e.g. the DB backup at the drive root) is not a bill — return 404 so this can't be used as
    // a general drive reader.
    const parts     = meta.parentPath.split('/').filter(Boolean);
    const parentSeg = parts[parts.length - 1] || '';
    const grandSeg  = parts[parts.length - 2] || '';
    const oldFormat = /^\d{4}-\d{2}$/.test(parentSeg);
    const newFormat = /^\d{2}$/.test(parentSeg) && /^\d{4}$/.test(grandSeg);
    if (!oldFormat && !newFormat) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const upstream = await fetch(meta.downloadUrl);
    if (!upstream.ok || !upstream.body) return NextResponse.json({ error: 'Could not fetch file.' }, { status: 502 });

    const headers = new Headers();
    headers.set('Content-Type', meta.mime);
    headers.set('Content-Disposition', 'inline');
    headers.set('Cache-Control', 'private, max-age=300');
    // The session token is in the query string (see above) — keep it out of Referer.
    headers.set('Referrer-Policy', 'no-referrer');
    const len = upstream.headers.get('content-length');
    if (len) headers.set('Content-Length', len);
    return new NextResponse(upstream.body, { status: 200, headers });
  } catch (e) {
    console.error('[cloud-storage/file]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to resolve file' }, { status: 502 });
  }
}
