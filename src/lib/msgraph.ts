// Server-only Microsoft Graph helper for OneDrive uploads via the Azure AD
// client-credentials flow. NEVER import this into client code — it uses the client secret.
import type { OneDriveConfig } from '@/lib/types';

interface TokenCache { token: string; exp: number }
const _cache = new Map<string, TokenCache>();

// Acquire an app-only Graph token (cached per tenant+client until ~1min before expiry).
export async function getGraphToken(cfg: OneDriveConfig, force = false): Promise<string> {
  if (!cfg.tenant_id || !cfg.client_id || !cfg.client_secret) {
    throw new Error('OneDrive is not fully configured (tenant id, client id, client secret).');
  }
  const key = `${cfg.tenant_id}:${cfg.client_id}`;
  const now = Date.now();
  const hit = _cache.get(key);
  if (!force && hit && hit.exp > now + 60_000) return hit.token;

  const url  = `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant_id)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id:     cfg.client_id,
    client_secret: cfg.client_secret,
    scope:         'https://graph.microsoft.com/.default',
    grant_type:    'client_credentials',
  });
  const res  = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok || !data.access_token) {
    throw new Error((data.error_description as string) || (data.error as string) || `Token request failed (${res.status})`);
  }
  const token = data.access_token as string;
  _cache.set(key, { token, exp: now + Number(data.expires_in ?? 3600) * 1000 });
  return token;
}

// Build the Graph "upload by path" URL from the configured folder + a RELATIVE path (which
// may contain subfolders, e.g. "EPF_Name/2026-07/bill_….jpg"). Graph auto-creates missing
// intermediate folders. Each path segment is sanitized; the "/" separators are preserved.
// folder_path like "user@org.com/drive/root:/Solar/bills" → append "/{relPath}:/content".
function itemUrl(folderPath: string, relPath: string): string {
  const clean = folderPath.replace(/\/+$/, '');
  const safe  = relPath.split('/').map((s) => s.replace(/[^a-zA-Z0-9._-]/g, '_')).filter(Boolean).join('/');
  return `https://graph.microsoft.com/v1.0/users/${clean}/${safe}`;
}

function uploadUrl(folderPath: string, relPath: string): string {
  return `${itemUrl(folderPath, relPath)}:/content`;
}

// Small-file upload via PUT :/content — bills are a few hundred KB. `relPath` is the folder
// path + filename relative to the configured folder.
export async function uploadToOneDrive(
  cfg: OneDriveConfig, relPath: string, buffer: Buffer, contentType: string,
): Promise<{ url: string; id: string; name: string }> {
  const put = async (force: boolean) => {
    const token = await getGraphToken(cfg, force);
    return fetch(uploadUrl(cfg.folder_path, relPath), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType || 'application/octet-stream' },
      body: new Uint8Array(buffer),
    });
  };
  let res = await put(false);
  if (res.status === 401) res = await put(true);   // cached token invalidated → force refresh + retry once
  const data = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message;
    throw new Error(msg || `OneDrive upload failed (${res.status})`);
  }
  return {
    url:  (data['@microsoft.graph.downloadUrl'] as string) || (data.webUrl as string) || '',
    id:   (data.id as string) || '',
    name: (data.name as string) || relPath.split('/').pop() || relPath,
  };
}

// Resolve a stored drive item by id → a FRESH pre-authenticated download URL (Graph's expires
// ~1h) plus enough metadata to serve it safely: its mime type, name, and parent folder path.
// Bills persist only the item id and re-resolve on each view (see /api/cloud-storage/file). The
// drive is taken from the configured folder path (its first segment, before "/drive/").
export async function getOneDriveItemMeta(
  cfg: OneDriveConfig, itemId: string,
): Promise<{ downloadUrl: string; mime: string; name: string; parentPath: string }> {
  const user = cfg.folder_path.split('/drive/')[0].replace(/^\/+|\/+$/g, '');
  const base = `https://graph.microsoft.com/v1.0/users/${user}/drive/items/${encodeURIComponent(itemId)}`;
  const read = async (force: boolean) => {
    const token = await getGraphToken(cfg, force);
    return fetch(base, { headers: { Authorization: `Bearer ${token}` } });
  };
  let res = await read(false);
  if (res.status === 401) res = await read(true);
  const data = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message;
    throw new Error(msg || `OneDrive item read failed (${res.status})`);
  }
  const downloadUrl = data['@microsoft.graph.downloadUrl'] as string | undefined;
  if (!downloadUrl) throw new Error('OneDrive returned no download URL for this item.');
  return {
    downloadUrl,
    mime:       (data.file as { mimeType?: string })?.mimeType || 'application/octet-stream',
    name:       (data.name as string) || '',
    parentPath: (data.parentReference as { path?: string })?.path || '',
  };
}

// Read a file back OUT of OneDrive — used by the admin "restore from OneDrive" flow to pull
// the nightly backup that scripts/onedrive-upload.mjs writes.
//
// Downloads via the item's pre-authenticated @microsoft.graph.downloadUrl rather than
// GET :/content. The latter 302-redirects to a different host, and fetch drops the
// Authorization header across origins, so it is the less predictable of the two.
export async function downloadFromOneDrive(
  cfg: OneDriveConfig, relPath: string,
): Promise<{ text: string; size: number; lastModified: string; name: string }> {
  const base = itemUrl(cfg.folder_path, relPath);

  const readMeta = async (force: boolean) => {
    const token = await getGraphToken(cfg, force);
    return fetch(base, { headers: { Authorization: `Bearer ${token}` } });
  };

  // Metadata first: gives the UI a size/timestamp and turns "no backup yet" into a clean
  // 404 instead of a confusing JSON parse error on an error payload.
  let metaRes = await readMeta(false);
  if (metaRes.status === 401) metaRes = await readMeta(true);
  const meta = await metaRes.json().catch(() => ({} as Record<string, unknown>));
  if (!metaRes.ok) {
    const msg = (meta as { error?: { message?: string } })?.error?.message;
    throw new Error(msg || `Could not read ${relPath} from OneDrive (${metaRes.status})`);
  }

  const downloadUrl = meta['@microsoft.graph.downloadUrl'] as string | undefined;
  if (!downloadUrl) throw new Error(`OneDrive returned no download URL for ${relPath}.`);

  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`OneDrive download failed (${res.status}).`);

  return {
    text:         await res.text(),
    size:         Number(meta.size ?? 0),
    lastModified: (meta.lastModifiedDateTime as string) || '',
    name:         (meta.name as string) || relPath,
  };
}

// Connectivity check: force a fresh token, then read the target folder's metadata.
export async function testOneDrive(cfg: OneDriveConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const token = await getGraphToken(cfg, true);
    const clean = cfg.folder_path.replace(/\/+$/, '');
    const res   = await fetch(`https://graph.microsoft.com/v1.0/users/${clean}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    if (res.ok) return { ok: true, detail: `Reached “${(data.name as string) || 'folder'}”.` };
    const msg = (data as { error?: { message?: string } })?.error?.message;
    return { ok: false, detail: msg || `Folder check failed (${res.status}).` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : 'Connection failed.' };
  }
}
