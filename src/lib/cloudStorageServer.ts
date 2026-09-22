// Server-only helpers for the cloud-storage config + upload API routes.
//
// The Firestore instance is passed in rather than resolved here: one deployment serves
// several domains, so only the route handler (which has the request) knows which tenant
// database to use. Call these with adminDbFor(req).
import { adminAuth } from '@/lib/firebaseAdmin';
import type { Firestore } from 'firebase-admin/firestore';
import type { CloudStorageConfig } from '@/lib/types';

export const CONFIG_COL = 'app_config';
export const CONFIG_ID  = 'cloud_storage';        // full config incl. the secret (server-only)
export const PUBLIC_ID  = 'cloud_storage_public'; // just the provider (client-readable)

export async function verifyUser(idToken: string): Promise<{ uid: string } | null> {
  if (!idToken) return null;
  try { const d = await adminAuth().verifyIdToken(idToken); return { uid: d.uid }; }
  catch { return null; }
}

// Any user who can manage users (or a system admin) may read/write the config.
export async function verifyManager(db: Firestore, idToken: string): Promise<{ uid: string } | null> {
  const u = await verifyUser(idToken);
  if (!u) return null;
  const userSnap = await db.collection('users').where('uid', '==', u.uid).limit(1).get();
  const role     = userSnap.empty ? null : userSnap.docs[0].data().role;
  const roleSnap = role ? await db.collection('roles').where('name', '==', role).limit(1).get() : null;
  const rd       = roleSnap && !roleSnap.empty ? roleSnap.docs[0].data() : null;
  return (rd?.is_system_admin || rd?.can_manage_users) ? u : null;
}

export async function readCloudConfig(db: Firestore): Promise<CloudStorageConfig | null> {
  const snap = await db.collection(CONFIG_COL).doc(CONFIG_ID).get();
  return snap.exists ? (snap.data() as CloudStorageConfig) : null;
}
