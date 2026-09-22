import { NextRequest, NextResponse } from 'next/server';
import { adminAuth, adminDb, adminDbFor, tenantForRequest } from '@/lib/firebaseAdmin';
import { awaitTenants, isServingSnapshot } from '@/lib/tenantRegistry';
import type { Tenant } from '@/lib/tenants';
import type { UserRecord } from 'firebase-admin/auth';
import { isBootstrapAdminEmail } from '@/lib/bootstrapAdmins';

// listUsers() pages at 1000. Cap the walk so a misconfigured project can't spin forever;
// the response reports whether the scan was cut short.
const PAGE_SIZE  = 1000;
const MAX_PAGES  = 20;

/**
 * One tenant database the scan consulted. Reported back so an admin can SEE which
 * databases answered before deleting anything — the union across every tenant database is
 * the whole safety argument for this panel, and an invisible union is one nobody can check.
 */
type DbScan = {
  dbId:     string;
  label:    string;
  profiles: number;
  ok:       boolean;
};

type Orphan = {
  uid:           string;
  email:         string | null;
  displayName:   string | null;
  providers:     string[];
  emailVerified: boolean;
  disabled:      boolean;
  createdAt:     string | null;
  lastSignInAt:  string | null;
};

/**
 * Every identity that ANY tenant's Firestore links to an auth account.
 *
 * CRITICAL: all tenants share ONE Firebase Auth pool but have SEPARATE Firestore
 * databases (see src/lib/tenants.ts). A Southern Lanka employee's auth account has no
 * doc in the Alta Vision database, so scanning only the caller's database would report
 * every other tenant's staff as orphans and offer to delete their logins. Always union
 * across every tenant database.
 *
 * Both uid AND email are collected: migrated profiles often carry the right email with a
 * stale or empty `uid`, and deleting that auth account would lock a real employee out.
 *
 * `callerDbId` covers databases that belong to no registered tenant — FIRESTORE_DB_ID=test
 * in local dev, preview deploys — which would otherwise contribute no profiles and make
 * every account look orphaned.
 */
/** Display name for a database. Several tenants can share one dbId, so all of them are named. */
function labelForDb(dbId: string, tenants: Tenant[]): string {
  const names = [...new Set(tenants.filter(t => t.dbId === dbId).map(t => t.label).filter(Boolean))];
  const id = dbId || 'default';
  return names.length ? `${names.join(' / ')} (${id})` : id;
}

async function linkedIdentities(callerDbId: string): Promise<{ uids: Set<string>; emails: Set<string>; scanned: number; databases: DbScan[] }> {
  const uids   = new Set<string>();
  const emails = new Set<string>();

  const tenants = await awaitTenants();
  const dbIds = new Set<string>([...tenants.map(t => t.dbId), callerDbId]);
  const databases: DbScan[] = [];

  for (const dbId of dbIds) {
    const label = labelForDb(dbId, tenants);
    // Caught per database instead of thrown, so the response can name the one that failed.
    // The scan then refuses to list or delete anything at all — see partialScan below.
    try {
      const snap = await adminDb(dbId).collection('users').select('uid', 'email').get();
      for (const d of snap.docs) {
        const uid   = (d.get('uid')   as string | undefined)?.trim();
        const email = (d.get('email') as string | undefined)?.trim().toLowerCase();
        if (uid)   uids.add(uid);
        if (email) emails.add(email);
      }
      databases.push({ dbId, label, profiles: snap.size, ok: true });
    } catch (e) {
      console.error('[orphan-auth] could not read users in database', dbId || '(default)', e);
      databases.push({ dbId, label, profiles: 0, ok: false });
    }
  }

  const scanned = databases.reduce((n, d) => n + d.profiles, 0);
  return { uids, emails, scanned, databases };
}

function toOrphan(u: UserRecord): Orphan {
  return {
    uid:           u.uid,
    email:         u.email ?? null,
    displayName:   u.displayName ?? null,
    providers:     u.providerData.map(p => p.providerId),
    emailVerified: u.emailVerified,
    disabled:      u.disabled,
    createdAt:     u.metadata.creationTime ?? null,
    lastSignInAt:  u.metadata.lastSignInTime ?? null,
  };
}

// The break-glass System Admins are allowed in with no Firestore profile BY DESIGN, so they
// always look orphaned — never list them, never delete them.
const isProtected = (u: UserRecord): boolean => isBootstrapAdminEmail(u.email);

/** Walk the whole Auth pool and return the accounts no tenant database references. */
async function findOrphans(callerDbId: string): Promise<{ orphans: Orphan[]; totalAuth: number; profiles: number; truncated: boolean; databases: DbScan[]; snapshot: boolean }> {
  const auth = adminAuth();
  const { uids, emails, scanned, databases } = await linkedIdentities(callerDbId);

  const orphans: Orphan[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  let totalAuth = 0;

  do {
    const res = await auth.listUsers(PAGE_SIZE, pageToken);
    totalAuth += res.users.length;
    for (const u of res.users) {
      if (isProtected(u)) continue;
      const email = (u.email ?? '').toLowerCase().trim();
      if (uids.has(u.uid)) continue;
      if (email && emails.has(email)) continue;
      orphans.push(toOrphan(u));
    }
    pageToken = res.pageToken;
    pages++;
  } while (pageToken && pages < MAX_PAGES);

  // Oldest first — the stale leftovers an admin is looking for sort to the top.
  // creationTime is a UTC date string ("Mon, 12 Aug 2026 …"), so it must be parsed;
  // comparing the strings would sort by weekday name.
  const ms = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);
  orphans.sort((a, b) => ms(a.createdAt) - ms(b.createdAt));

  return { orphans, totalAuth, profiles: scanned, truncated: !!pageToken, databases, snapshot: isServingSnapshot() };
}

/**
 * A database that did not answer contributed no uid and no email, so every employee in it
 * now looks like a stray credential the admin is invited to delete. There is no safe
 * partial answer: refuse the whole operation and name the database that failed.
 */
function partialScan(databases: DbScan[]): NextResponse | null {
  const failed = databases.filter(d => !d.ok);
  if (!failed.length) return null;
  const names = failed.map(d => d.label);
  return NextResponse.json({
    error: `Could not read ${names.join(', ')} — scan stopped`,
    failedDatabases: names,
    databases,
  }, { status: 503 });
}

export async function POST(req: NextRequest) {
  try {
    const { idToken, action = 'list', uids } = await req.json();
    if (!idToken) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const auth = adminAuth();
    const db   = adminDbFor(req);

    // 1. Verify the caller can manage users
    let callerUid: string;
    try {
      const decoded = await auth.verifyIdToken(idToken);
      callerUid = decoded.uid;
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const callerSnap = await db.collection('users').where('uid', '==', callerUid).limit(1).get();
    const callerRole = callerSnap.empty ? null : callerSnap.docs[0].data().role;
    const roleSnap = callerRole
      ? await db.collection('roles').where('name', '==', callerRole).limit(1).get()
      : null;
    const roleData = roleSnap && !roleSnap.empty ? roleSnap.docs[0].data() : null;
    const canManageUsers = !!(roleData?.is_system_admin || roleData?.can_manage_users);
    if (!canManageUsers) {
      return NextResponse.json({ error: 'User management access required' }, { status: 403 });
    }

    const callerDbId = tenantForRequest(req).dbId;

    if (action === 'list') {
      const result = await findOrphans(callerDbId);
      const partial = partialScan(result.databases);
      if (partial) return partial;
      return NextResponse.json({ success: true, ...result });
    }

    if (action === 'delete') {
      const targets: string[] = Array.isArray(uids) ? uids.filter((u): u is string => !!u) : [];
      if (!targets.length) {
        return NextResponse.json({ error: 'No accounts selected' }, { status: 400 });
      }

      // Re-derive the orphan set server-side. The client's list is a hint, never
      // authority: a crafted request must not be able to delete a linked employee's
      // login, and a profile may have been created since the list was fetched.
      const { orphans, databases } = await findOrphans(callerDbId);
      const partial = partialScan(databases);
      if (partial) return partial;
      const deletable = new Set(orphans.map(o => o.uid));

      const deleted: string[] = [];
      const skipped: { uid: string; reason: string }[] = [];

      for (const uid of targets) {
        if (uid === callerUid) { skipped.push({ uid, reason: 'This is your own login account' }); continue; }
        if (!deletable.has(uid)) { skipped.push({ uid, reason: 'No longer orphaned — it is linked to a user profile' }); continue; }
        try {
          await auth.deleteUser(uid);
          deleted.push(uid);
        } catch (e) {
          console.error('[orphan-auth] delete failed', uid, e);
          skipped.push({ uid, reason: 'Delete failed' });
        }
      }

      return NextResponse.json({ success: true, deleted, skipped });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    console.error('[orphan-auth]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
