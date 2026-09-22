/**
 * Birthday notifications — Firebase Scheduled Function (Cloud Scheduler).
 *
 * Runs daily at 00:30 Asia/Colombo (native timezone — no UTC math). Finds every
 * active user whose birthday is "today" (year-agnostic, Feb-29 → Feb-28 fallback in
 * non-leap years) and:
 *   • writes a direct `notifications` doc so it shows in the in-app bell, and
 *   • sends an FCM push so they get it with the app closed.
 *
 * Credentials: runs with the project's default service account — no keys needed.
 * Database: runs against every tenant database in TENANT_DB_IDS (see below), because a
 * scheduled function has no request host to resolve a single tenant from.
 * Idempotent: a `birthday_sent/{epf}-{year}` marker is claimed with create() before
 * sending, so a re-run (or the /api/cron/birthday manual trigger) can't double-send.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import {
  getFirestore, FieldValue, Timestamp, type Firestore, type DocumentData, type DocumentReference,
} from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

initializeApp();

// One Firebase project serves every domain, each with its OWN Firestore database
// (see src/lib/tenants.ts — altavision.lk → (default), carecode.org → southernlanka).
// A scheduled function has no request to resolve a tenant from, so every job runs against
// EVERY tenant database in turn. Keep this list in sync with src/lib/tenants.ts.
//
// TENANT_DB_IDS in functions/.env overrides it (comma-separated; "default" or an empty
// entry selects the default database).
const DEFAULT_TENANT_DB_IDS = ['', 'southernlanka'];

function normalizeDbId(raw: string): string {
  const v = raw.trim();
  return /^(\(default\)|default)$/i.test(v) ? '' : v;
}

const TENANT_DB_IDS: string[] = (
  process.env.TENANT_DB_IDS
    ? process.env.TENANT_DB_IDS.split(',').map(normalizeDbId)
    : DEFAULT_TENANT_DB_IDS
).filter((v, i, a) => a.indexOf(v) === i);

const tenantDbs = (): Array<{ dbId: string; db: Firestore }> =>
  TENANT_DB_IDS.map(dbId => ({
    dbId: dbId || '(default)',
    db: dbId ? getFirestore(dbId) : getFirestore(),
  }));

function epfDocId(epf: string): string {
  return epf.includes('/') ? epf.replace(/\//g, '%2F') : epf;
}

function tokensOf(u: DocumentData): string[] {
  const arr = Array.isArray(u.fcm_tokens) ? u.fcm_tokens.filter((t: unknown) => typeof t === 'string') : [];
  if (typeof u.fcm_token === 'string' && u.fcm_token) arr.push(u.fcm_token);
  return [...new Set(arr)] as string[];
}

// Year-agnostic "today" in Colombo → { monthDay: 'MM-DD', year: 'YYYY', isLeap }.
function colomboToday(): { monthDay: string; year: string; isLeap: boolean } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()); // 'YYYY-MM-DD'
  const [year, mm, dd] = parts.split('-');
  const isLeap = new Date(Number(year), 1, 29).getMonth() === 1; // Feb still Feb on the 29th → leap
  return { monthDay: `${mm}-${dd}`, year, isLeap };
}

function isBirthdayToday(dob: string | null | undefined, monthDay: string, isLeap: boolean): boolean {
  if (!dob || dob.length < 10) return false;
  const dobMd = dob.slice(5, 10); // 'MM-DD'
  if (dobMd === monthDay) return true;
  // Feb-29 births fall back to Feb-28 in non-leap years so they're never skipped.
  return dobMd === '02-29' && !isLeap && monthDay === '02-28';
}

async function run(db: Firestore): Promise<{ date: string; birthdays: number; wished: number; pushed: number }> {
  const { monthDay, year, isLeap } = colomboToday();

  const usersSnap = await db.collection('users').get();
  const today = usersSnap.docs
    .map((d) => ({ ref: d.ref, data: d.data() }))
    .filter(({ data }) =>
      data.is_active !== false &&
      !(data.date_of_resign && String(data.date_of_resign) <= new Date().toISOString().slice(0, 10)) &&
      isBirthdayToday(data.date_of_birth, monthDay, isLeap));

  const messaging = getMessaging();
  let wished = 0;
  let pushed = 0;

  for (const { ref, data } of today) {
    const epf = String(data.epf_number ?? '');
    if (!epf) continue;
    const safe = epfDocId(epf);

    // Claim the once-per-year marker. If it exists, this user was already handled today.
    const marker = db.collection('birthday_sent').doc(`${safe}-${year}`);
    try {
      await marker.create({ epf, year, created_at: FieldValue.serverTimestamp() });
    } catch {
      continue; // already sent this year
    }

    const firstName = String(data.first_name || data.display_name || 'there').trim();
    const title = `🎂 Happy Birthday, ${firstName}!`;
    const body = 'Wishing you a wonderful day from the whole PearlCluster team. 🎉';

    // In-app bell notification (deterministic id so a same-day re-run can't duplicate it).
    await db.collection('notifications').doc(`bday-${safe}-${year}`).set({
      to_epf: epf,
      audience: null,
      type: 'general',
      actor_epf: null,
      actor_name: 'PearlCluster',
      meta: { birthday: '1' },
      title,
      body,
      link: '/dashboard',
      read: false,
      created_at: FieldValue.serverTimestamp(),
    }).catch(() => undefined);
    wished++;

    // FCM push (both `notification` + `data` so iOS Safari web push renders content).
    const tokens = tokensOf(data);
    if (!tokens.length) continue;
    const tag = `bday-${safe}-${year}`;
    try {
      const resp = await messaging.sendEachForMulticast({
        tokens,
        data: { type: 'general', title, body, link: '/dashboard', docId: tag, tag },
        webpush: { notification: { title, body, icon: '/app.png', badge: '/app.png', tag } },
      });
      pushed += resp.successCount;
      // Prune dead tokens off the user doc.
      const dead = new Set<string>();
      resp.responses.forEach((r, i) => {
        const code = r.error?.code ?? '';
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
          dead.add(tokens[i]);
        }
      });
      if (dead.size) {
        const patch: Record<string, unknown> = { fcm_tokens: FieldValue.arrayRemove(...dead) };
        if (dead.has(String(data.fcm_token))) patch.fcm_token = null;
        await ref.update(patch).catch(() => undefined);
      }
    } catch (e) {
      logger.warn('birthday push failed', { epf, error: String(e) });
    }
  }

  return { date: `${year}-${monthDay}`, birthdays: today.length, wished, pushed };
}

export const birthdayNotify = onSchedule(
  {
    schedule: '30 0 * * *',
    timeZone: 'Asia/Colombo',
    memory: '256MiB',
    timeoutSeconds: 300,
  },
  async () => {
    for (const { dbId, db } of tenantDbs()) {
      try {
        logger.info('birthday-notify complete', { database: dbId, ...(await run(db)) });
      } catch (e) {
        // One tenant's failure must not skip the rest — log and carry on.
        logger.error('birthday-notify failed', { database: dbId, error: String(e) });
      }
    }
  },
);

/**
 * Scheduled-notification dispatcher — Firebase Scheduled Function (every 5 minutes).
 *
 * Sends `scheduled_notifications` docs whose send_at has passed (composed in-app via the
 * bell → Schedule). For each due doc it writes the in-app `notifications` doc(s) (broadcast
 * or one per recipient) and an FCM push, then flips the doc to `sent`.
 *
 * Idempotent: each doc is claimed pending→sending in a transaction before sending, and the
 * fan-out uses deterministic notification ids (`sched-<id>` / `sched-<id>-<epf>`) so a retry
 * overwrites rather than duplicates. A `sending` doc left stale (>10 min) is retried.
 */
const SCHED_STALE_MS = 10 * 60 * 1000;

async function dispatchDue(db: Firestore): Promise<{ due: number; processed: number; delivered: number; pushed: number }> {
  const nowMs = Date.now();

  // Equality-only queries (auto-indexed); "due"/"stale" filtered in memory.
  const [pendingSnap, sendingSnap] = await Promise.all([
    db.collection('scheduled_notifications').where('status', '==', 'pending').get(),
    db.collection('scheduled_notifications').where('status', '==', 'sending').get(),
  ]);

  const due = [
    ...pendingSnap.docs.filter((d) => {
      const sa = d.get('send_at') as Timestamp | undefined;
      return sa ? sa.toMillis() <= nowMs : false;
    }),
    ...sendingSnap.docs.filter((d) => {
      const ua = d.get('updated_at') as Timestamp | undefined;
      return ua ? nowMs - ua.toMillis() > SCHED_STALE_MS : true;
    }),
  ];

  const messaging = getMessaging();
  let processed = 0;
  let delivered = 0;
  let pushed = 0;

  for (const d of due) {
    const ref = d.ref;

    // Claim: proceed only if still pending, or a stale `sending` we're allowed to retry.
    let claimed = false;
    try {
      await db.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        const status = cur.get('status');
        const ua = cur.get('updated_at') as Timestamp | undefined;
        const stale = status === 'sending' && (!ua || nowMs - ua.toMillis() > SCHED_STALE_MS);
        if (status !== 'pending' && !stale) return;
        tx.update(ref, { status: 'sending', updated_at: FieldValue.serverTimestamp() });
        claimed = true;
      });
    } catch {
      claimed = false;
    }
    if (!claimed) continue;

    const data = d.data();
    const title = String(data.title ?? '');
    const body = String(data.body ?? '');
    const link = (data.link as string) ?? null;
    const isAll = data.audience === 'all';
    const toEpfs = Array.isArray(data.to_epfs) ? [...new Set(data.to_epfs.map(String))] : [];

    try {
      const common = {
        type: 'announcement',
        actor_epf: (data.actor_epf as string) ?? null,
        actor_name: (data.actor_name as string) ?? null,
        title,
        body,
        link: link ?? null,
        read: false,
        created_at: FieldValue.serverTimestamp(),
      };

      // Remember each token's owner doc so a dead token (below) can be pruned off the
      // right user — same pattern as birthdayNotify / /api/notify.
      const tokenOwner = new Map<string, DocumentReference>();
      if (isAll) {
        await db.collection('notifications').doc(`sched-${ref.id}`).set({
          ...common, to_epf: null, audience: 'all', meta: { broadcast: '1', scheduled: '1' },
        });
        const users = await db.collection('users').get();
        users.forEach((u) => {
          const ud = u.data();
          if (ud.is_active === false) return;
          for (const tok of tokensOf(ud)) if (!tokenOwner.has(tok)) tokenOwner.set(tok, u.ref);
        });
      } else {
        for (const epf of toEpfs) {
          const safe = epfDocId(epf);
          await db.collection('notifications').doc(`sched-${ref.id}-${safe}`).set({
            ...common, to_epf: epf, audience: null, meta: { scheduled: '1' },
          });
          const us = await db.collection('users').doc(safe).get();
          if (us.exists) {
            for (const tok of tokensOf(us.data() as DocumentData)) if (!tokenOwner.has(tok)) tokenOwner.set(tok, us.ref);
          }
        }
      }
      delivered++;

      // FCM push (best-effort; in-app docs are the reliable channel). Chunk to the 500 cap.
      const uniqueTokens = [...tokenOwner.keys()];
      if (uniqueTokens.length) {
        const tag = `sched-${ref.id}`;
        const deadByRef = new Map<string, { ownerRef: DocumentReference; dead: Set<string> }>();
        for (let i = 0; i < uniqueTokens.length; i += 500) {
          const chunk = uniqueTokens.slice(i, i + 500);
          try {
            const resp = await messaging.sendEachForMulticast({
              tokens: chunk,
              data: { type: 'general', title, body, link: link ?? '/dashboard', docId: tag, tag },
              webpush: { notification: { title, body, icon: '/app.png', badge: '/app.png', tag } },
            });
            pushed += resp.successCount;
            // Prune dead tokens off their owner's user doc — without this, a stale token
            // (e.g. left behind by a device's token rotating) never gets removed by this
            // send path and keeps being sent to indefinitely.
            resp.responses.forEach((r, j) => {
              const code = r.error?.code ?? '';
              if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
                const tok = chunk[j];
                const ownerRef = tokenOwner.get(tok);
                if (!ownerRef) return;
                if (!deadByRef.has(ownerRef.path)) deadByRef.set(ownerRef.path, { ownerRef, dead: new Set() });
                deadByRef.get(ownerRef.path)!.dead.add(tok);
              }
            });
          } catch (e) {
            logger.warn('scheduled push failed', { id: ref.id, error: String(e) });
          }
        }
        await Promise.all([...deadByRef.values()].map(async ({ ownerRef, dead }) => {
          const patch: Record<string, unknown> = { fcm_tokens: FieldValue.arrayRemove(...dead) };
          const snap = await ownerRef.get().catch(() => null);
          if (snap && dead.has(String(snap.data()?.fcm_token))) patch.fcm_token = null;
          await ownerRef.update(patch).catch(() => undefined);
        }));
      }

      await ref.update({
        status: 'sent', sent_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(), error: null,
      });
      processed++;
    } catch (e) {
      await ref.update({
        status: 'failed', error: String((e as Error)?.message ?? 'failed'),
        updated_at: FieldValue.serverTimestamp(),
      }).catch(() => undefined);
    }
  }

  return { due: due.length, processed, delivered, pushed };
}

export const dispatchScheduledNotifications = onSchedule(
  {
    schedule: '*/5 * * * *',
    timeZone: 'Asia/Colombo',
    memory: '256MiB',
    timeoutSeconds: 300,
  },
  async () => {
    for (const { dbId, db } of tenantDbs()) {
      try {
        logger.info('dispatch-scheduled-notifications complete', { database: dbId, ...(await dispatchDue(db)) });
      } catch (e) {
        // One tenant's failure must not block the others' queues.
        logger.error('dispatch-scheduled-notifications failed', { database: dbId, error: String(e) });
      }
    }
  },
);

/**
 * Planned-maintenance lifecycle — Firebase Scheduled Function (every 5 minutes).
 *
 * Reads settings/maintenance and, purely from the wall clock (mirrors src/lib/maintenance.ts's
 * phase derivation — start inclusive, end exclusive):
 *   • window has started and the start hasn't been announced yet -> notify all users, stamp
 *     startNotifiedAtMs with a COPY of startAtMs
 *   • window has ended and the end hasn't been announced yet -> notify all users "back online",
 *     stamp endNotifiedAtMs with a COPY of endAtMs, and set enabled:false
 *
 * Idempotent: the stamps hold a copy of the boundary VALUE they announced (not a "sent at"
 * time) and are compared against the doc's CURRENT startAtMs/endAtMs — so re-arming the window
 * (which changes one or both) naturally invalidates any stale stamp and it announces again, with
 * no explicit reset needed anywhere. The claim (which run gets to send) happens inside the same
 * transaction that writes the stamp, so two overlapping invocations can't both send.
 * A malformed doc (missing/non-numeric bounds, end<=start) is never acted on — mirrors the
 * client's parseMaintenanceDoc safety net.
 */
const MAINTENANCE_KIND_TITLES: Record<string, string> = {
  maintenance: 'Scheduled Maintenance',
  upgrade: 'System Upgrade',
  emergency: 'Emergency Maintenance',
};

async function notifyAllUsersOfMaintenance(db: Firestore, docId: string, title: string, body: string): Promise<void> {
  await db.collection('notifications').doc(docId).set({
    to_epf: null,
    audience: 'all',
    type: 'announcement',
    actor_epf: null,
    actor_name: 'PearlCluster',
    meta: { maintenance: '1' },
    title,
    body,
    link: null,
    read: false,
    created_at: FieldValue.serverTimestamp(),
  });

  const users = await db.collection('users').get();
  const tokens: string[] = [];
  users.forEach((u) => { const ud = u.data(); if (ud.is_active !== false) tokens.push(...tokensOf(ud)); });
  const uniqueTokens = [...new Set(tokens)];
  if (!uniqueTokens.length) return;

  const messaging = getMessaging();
  for (let i = 0; i < uniqueTokens.length; i += 500) {
    const chunk = uniqueTokens.slice(i, i + 500);
    try {
      await messaging.sendEachForMulticast({
        tokens: chunk,
        data: { type: 'general', title, body, link: '/dashboard', docId, tag: docId },
        webpush: { notification: { title, body, icon: '/app.png', badge: '/app.png', tag: docId } },
      });
    } catch (e) {
      logger.warn('maintenance-lifecycle push failed', { error: String(e) });
    }
  }
}

async function runMaintenanceLifecycle(db: Firestore): Promise<{ started: boolean; ended: boolean }> {
  const ref = db.collection('settings').doc('maintenance');
  const nowMs = Date.now();

  type Claim = { started: boolean; ended: boolean; kind: string; message: string; startAtMs: number; endAtMs: number };

  const result = await db.runTransaction<Claim | null>(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data() as DocumentData;
    if (data.enabled !== true) return null;

    const startAtMs = data.startAtMs;
    const endAtMs = data.endAtMs;
    if (typeof startAtMs !== 'number' || typeof endAtMs !== 'number' || !(endAtMs > startAtMs)) return null;

    const started = nowMs >= startAtMs && nowMs < endAtMs && data.startNotifiedAtMs !== startAtMs;
    const ended = nowMs >= endAtMs && data.endNotifiedAtMs !== endAtMs;
    if (!started && !ended) return null;

    const updates: DocumentData = {};
    if (started) updates.startNotifiedAtMs = startAtMs;
    if (ended) { updates.endNotifiedAtMs = endAtMs; updates.enabled = false; }
    tx.update(ref, updates);

    return {
      started, ended,
      kind: typeof data.kind === 'string' ? data.kind : 'maintenance',
      message: typeof data.message === 'string' ? data.message : '',
      startAtMs, endAtMs,
    };
  });

  if (!result) return { started: false, ended: false };

  if (result.started) {
    const label = MAINTENANCE_KIND_TITLES[result.kind] ?? MAINTENANCE_KIND_TITLES.maintenance;
    await notifyAllUsersOfMaintenance(
      db, `maint-start-${result.startAtMs}`,
      `${label} started`, result.message || 'Maintenance is now in progress.',
    );
  }
  if (result.ended) {
    await notifyAllUsersOfMaintenance(
      db, `maint-end-${result.endAtMs}`,
      "We're back online", "Maintenance has finished — everything is back to normal. Thanks for your patience!",
    );
  }

  return { started: result.started, ended: result.ended };
}

export const maintenanceLifecycle = onSchedule(
  {
    schedule: '*/5 * * * *',
    timeZone: 'Asia/Colombo',
    memory: '256MiB',
    timeoutSeconds: 300,
  },
  async () => {
    for (const { dbId, db } of tenantDbs()) {
      try {
        logger.info('maintenance-lifecycle complete', { database: dbId, ...(await runMaintenanceLifecycle(db)) });
      } catch (e) {
        logger.error('maintenance-lifecycle failed', { database: dbId, error: String(e) });
      }
    }
  },
);
