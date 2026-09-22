'use client';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { resizeImage, jpgName } from '@/lib/imageResize';
import type { CloudProvider } from '@/lib/types';

async function idToken(): Promise<string> {
  const t = await auth.currentUser?.getIdToken();
  if (!t) throw new Error('Not signed in.');
  return t;
}

// The active provider is mirrored (non-secret) into a client-readable doc by the config API.
export async function getActiveProvider(): Promise<CloudProvider> {
  try {
    const snap = await getDoc(doc(db, 'app_config', 'cloud_storage_public'));
    return snap.exists() && snap.data().provider === 'onedrive' ? 'onedrive' : 'firebase';
  } catch { return 'firebase'; }
}

export interface CloudConfigView {
  provider: CloudProvider;
  onedrive: {
    tenant_id: string; client_id: string; folder_path: string;
    secret_created_date: string; secret_duration_months: number; has_secret: boolean;
  } | null;
  updated_at: string | null;
}

export async function getCloudConfig(): Promise<CloudConfigView> {
  const res = await fetch('/api/cloud-storage/config', { headers: { Authorization: `Bearer ${await idToken()}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to load cloud config.');
  return res.json();
}

export interface SaveCloudInput {
  provider: CloudProvider;
  onedrive?: {
    tenant_id: string; client_id: string; client_secret?: string; folder_path: string;
    secret_created_date?: string; secret_duration_months?: number;
  };
}

export async function saveCloudConfig(config: SaveCloudInput): Promise<void> {
  const res = await fetch('/api/cloud-storage/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: await idToken(), config }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to save cloud config.');
}

export async function testCloudConnection(): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch('/api/cloud-storage/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: await idToken() }),
  });
  return res.json().catch(() => ({ ok: false, detail: 'Test failed.' }));
}

// Sanitize a single path/file segment (no slashes survive). Exported so callers that build their
// own customPath (e.g. suspense bills — see billFilePath in suspenseService.ts) stay consistent.
export function seg(s: string): string {
  return (s || '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}
// Compact filesystem-safe timestamp: YYYYMMDD-HHmmss (no colons).
function stampNow(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Bills are photographed on phones, which produce 3000-4000px, 6-12 MB captures. The OneDrive
// branch POSTs that to a serverless route, and serverless platforms cap a function's request
// body well below it (Netlify: ~6 MB, 10s) — the PLATFORM rejected the request before our route
// ran, so the response wasn't JSON, `data.error` was undefined, and the person uploading got a
// bare "OneDrive upload failed." with nothing to act on. Two defences: shrink every image so it
// comfortably fits, and refuse what still doesn't with a message that says what's wrong.
//
// 2400px/0.82 brings a typical phone photo under ~700 KB while keeping a receipt's small print
// readable when zoomed — deliberately gentler than the OCR resize (1800px), because that one is
// throwaway and this is the copy that gets filed and audited.
const UPLOAD_MAX_DIM = 2400;
const UPLOAD_QUALITY = 0.82;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

// A too-large file, phrased for the person holding the phone. Exported so callers can reject at
// ATTACH time (see the suspense bill picker) rather than after the form has been filled in.
export function tooLargeMessage(file: File): string {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    ? `This PDF is too large (${mb(file.size)}). The maximum is ${mb(MAX_UPLOAD_BYTES)} — attach a smaller file, or photograph the bill instead.`
    : `This file is too large (${mb(file.size)}). The maximum is ${mb(MAX_UPLOAD_BYTES)}.`;
}

// Upload a file via the ACTIVE provider. OneDrive → server/Graph route; Firebase → client SDK.
// By default, files are foldered per user (`{epf}_{name}`) then by month (`YYYY-MM`), and named
// `{base}_{datetime}_{epf}_{username}.{ext}` so every upload is self-describing. Pass `customPath`
// to use a caller-built relative path (folders + filename) instead — e.g. suspense bills use
// `{company}/{year}/{month}/{billNo}-{employee}-{epf}.{ext}`.
export async function uploadCloudFile(
  file: File, opts: { epf: string; name: string; prefix?: string; customPath?: string },
): Promise<{ url: string; type: 'image' | 'pdf'; name: string; provider: CloudProvider }> {
  const provider = await getActiveProvider();
  const isPdf    = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const type     = isPdf ? 'pdf' : 'image';

  // Shrink BEFORE anything else — a PDF (or an already-small image) comes back untouched, so
  // `upload === file` is exactly "nothing was re-encoded".
  const upload = await resizeImage(file, { maxDim: UPLOAD_MAX_DIM, quality: UPLOAD_QUALITY, maxBytes: MAX_UPLOAD_BYTES });
  if (upload.size > MAX_UPLOAD_BYTES) throw new Error(tooLargeMessage(upload));
  const shrunk = upload !== file;   // re-encoded to JPEG, so any stored path must say .jpg

  let relPath: string;
  if (opts.customPath) {
    relPath = shrunk ? jpgName(opts.customPath) : opts.customPath;
  } else {
    const now      = new Date();
    const epfSeg   = seg(opts.epf)  || 'epf';
    const nameSeg  = seg(opts.name) || 'user';
    const userDir  = `${epfSeg}_${nameSeg}`;                                                   // {userepf}_{name}
    const monthDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;   // YYYY-MM
    const dot      = upload.name.lastIndexOf('.');
    const ext      = dot >= 0 ? upload.name.slice(dot).toLowerCase() : (isPdf ? '.pdf' : '');
    const base     = seg(dot >= 0 ? upload.name.slice(0, dot) : upload.name) || (opts.prefix ?? 'file');
    const filename = `${base}_${stampNow(now)}_${epfSeg}_${nameSeg}${ext}`;                    // filename_datetime_userepf_username
    relPath = `${userDir}/${monthDir}/${filename}`;
  }

  if (provider === 'onedrive') {
    const fd = new FormData();
    fd.append('file', upload);
    fd.append('idToken', await idToken());
    fd.append('path', relPath);
    const res  = await fetch('/api/cloud-storage/upload', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // No JSON body means the PLATFORM rejected this before our route ran (body-size cap,
      // function timeout) — carry the status through either way. A bare "upload failed" is
      // undiagnosable by the time it reaches us as a screenshot of a toast.
      if (data?.error) throw new Error(data.error);
      if (res.status === 413) throw new Error(tooLargeMessage(upload));
      throw new Error(`OneDrive upload failed (${res.status}). Please try again — if it keeps failing, attach a smaller file.`);
    }
    // Graph's download URL expires (~1h). Persist a STABLE proxy URL keyed by the item id so the
    // bill still loads later — the server route re-resolves a fresh link on each view.
    const url = data.id ? `/api/cloud-storage/file?id=${encodeURIComponent(data.id)}` : data.url;
    return { url, type, name: upload.name, provider };
  }

  // Firebase Storage (client SDK) — same folder structure under the prefix.
  const { ref: sref, uploadBytes, getDownloadURL } = await import('firebase/storage');
  const { storage } = await import('@/lib/firebase');
  const r = sref(storage, `${opts.prefix ?? 'uploads'}/${relPath}`);
  await uploadBytes(r, upload);
  return { url: await getDownloadURL(r), type, name: upload.name, provider };
}
