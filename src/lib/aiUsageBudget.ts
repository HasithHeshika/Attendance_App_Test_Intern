// Server-only monthly spend guard for the Gemini calls this app makes (currently just bill
// reading — src/lib/geminiBillReader.ts). NEVER import into client code.
//
// Google's own monthly limit on the billing account (Cloud console → Billing → Auto-reload →
// "Monthly limit") is the AUTHORITATIVE hard cap: it is the only thing that actually stops the
// charges. This module is the EARLY guard in front of it. It stops calls and warns the system
// admins before that hard cap is reached, so bill reading degrades to the client-side OCR
// fallback on our terms — with a warning we saw coming — instead of the API key dying mid-month
// with no notice. Keep AI_MONTHLY_LIMIT_USD at or below whatever is set in the console.
//
// Spend is tracked in the DEFAULT database (adminDb('')) no matter which tenant made the call.
// GOOGLE_API_KEY, and the billing account behind it, are SHARED across every tenant — a
// per-tenant counter would let each tenant spend the whole limit independently, so one key gets
// one budget and one counter.

import type { Firestore, DocumentData, DocumentReference } from 'firebase-admin/firestore';

// Users are keyed by EPF and '/' is illegal in a doc id — the same local helper every
// server-side module in this codebase carries (they must not import the client SDK).
function epfDocId(epf: string): string {
  return epf.includes('/') ? epf.replace(/\//g, '%2F') : epf;
}

export const AI_USAGE_COLLECTION = 'ai_usage';

// ─── Configuration (all overridable by env) ────────────────────────────────────

/** Matches the $50 monthly limit set on the Google billing account. AI_MONTHLY_LIMIT_USD. */
export const DEFAULT_MONTHLY_LIMIT_USD = 50;

/** Percent of the limit at which the system admins are warned. AI_WARN_PCT. */
export const DEFAULT_WARN_PCT = 80;

// USD per MILLION tokens. These two numbers are DELIBERATE OVER-ESTIMATES chosen as a safe
// placeholder — they are NOT a published Google rate, and nothing here can keep them current:
// GEMINI_BILL_MODEL points at a moving alias (gemini-flash-latest) whose price changes without
// this file changing. Over-estimating is the safe direction for a spend cap — the guard trips
// early rather than after the money is gone — but an over-estimate still means the figure this
// module reports is not the real bill.
//
// VERIFY the current rate for the model you actually run at https://ai.google.dev/pricing and
// set AI_PRICE_INPUT_PER_MTOK / AI_PRICE_OUTPUT_PER_MTOK in the environment. Treat these
// defaults as "nobody has set the price yet", not as a price.
export const DEFAULT_PRICE_INPUT_PER_MTOK  = 0.50;
export const DEFAULT_PRICE_OUTPUT_PER_MTOK = 4.00;

export interface AiPricing {
  inputPerMTok:  number;
  outputPerMTok: number;
}

/** A negative, non-numeric or blank env value falls back — a typo must never silently widen
 *  the cap or zero out the price. */
function envNum(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function monthlyLimitUsd(): number {
  return envNum(process.env.AI_MONTHLY_LIMIT_USD, DEFAULT_MONTHLY_LIMIT_USD);
}

export function warnPct(): number {
  return Math.min(100, envNum(process.env.AI_WARN_PCT, DEFAULT_WARN_PCT));
}

export function pricing(): AiPricing {
  return {
    inputPerMTok:  envNum(process.env.AI_PRICE_INPUT_PER_MTOK,  DEFAULT_PRICE_INPUT_PER_MTOK),
    outputPerMTok: envNum(process.env.AI_PRICE_OUTPUT_PER_MTOK, DEFAULT_PRICE_OUTPUT_PER_MTOK),
  };
}

// ─── Pure arithmetic ───────────────────────────────────────────────────────────
// Everything down to the next divider takes its inputs as arguments and touches nothing —
// that is what lets the cap, the warn threshold and the pricing be unit tested without a
// service account or a Firestore stub (src/lib/__tests__/aiUsageBudget.test.ts).

/**
 * Cost of one call in USD. Deliberately NOT rounded to cents: a single bill read costs a small
 * fraction of a cent, so rounding here would floor almost every call to 0.00 and the month
 * would accumulate nothing at all.
 */
export function aiCostUsd(inputTokens: number, outputTokens: number, p: AiPricing): number {
  const inTok  = Math.max(0, Number(inputTokens)  || 0);
  const outTok = Math.max(0, Number(outputTokens) || 0);
  return (inTok / 1_000_000) * p.inputPerMTok + (outTok / 1_000_000) * p.outputPerMTok;
}

/** Percent of the monthly limit used. A limit of 0 means "no AI at all", which is 100% used. */
export function spendPct(spendUsd: number, limitUsd: number): number {
  if (!(limitUsd > 0)) return 100;
  return (Math.max(0, spendUsd) / limitUsd) * 100;
}

/** Exactly AT the limit is already over budget — the next call would cross it. */
export function isUnderBudget(spendUsd: number, limitUsd: number): boolean {
  return limitUsd > 0 && spendUsd < limitUsd;
}

/** Warn at AI_WARN_PCT, then again at 100% — the point where calls start being refused and
 *  bill reading silently degrades to on-device OCR, which admins need to know about. */
export function warnThresholds(warnAtPct: number): number[] {
  return warnAtPct >= 100 ? [100] : [warnAtPct, 100];
}

/**
 * The threshold to warn at right now, or null. `warnedPct` is the highest threshold already
 * notified this month (0 = none), which is what makes this fire ONCE per threshold per month
 * rather than on every call once past it.
 */
export function pendingWarnThreshold(pct: number, warnAtPct: number, warnedPct: number): number | null {
  const due = warnThresholds(warnAtPct).filter(t => pct >= t && t > warnedPct);
  return due.length ? Math.max(...due) : null;
}

/** Usage doc id: the UTC month. UTC, not local time, so the counter rolls over at one instant
 *  for every tenant regardless of where the request came from. */
export function utcMonthKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface AiBudget {
  spendUsd:     number;
  limitUsd:     number;
  pct:          number;
  remainingUsd: number;
  allowed:      boolean;
  /** False when nothing is counting (see usageStore) — "under budget" and "not counting" must
   *  never look the same to a caller. */
  tracking:     boolean;
}

export function budgetOf(spendUsd: number, limitUsd: number, tracking: boolean): AiBudget {
  return {
    spendUsd,
    limitUsd,
    pct:          spendPct(spendUsd, limitUsd),
    remainingUsd: Math.max(0, limitUsd - spendUsd),
    allowed:      tracking ? isUnderBudget(spendUsd, limitUsd) : true,
    tracking,
  };
}

// ─── Firestore-backed counter ──────────────────────────────────────────────────

interface UsageStore {
  db: Firestore;
  FieldValue: typeof import('firebase-admin/firestore').FieldValue;
}

let warnedNotTracking = false;

/**
 * Firestore for the shared usage counter, or null when Firebase Admin isn't configured
 * (adminDb → getAdminApp throws when the FIREBASE_ADMIN_* vars are absent — the normal state
 * in local dev).
 *
 * That case FAILS OPEN: the call is allowed through. The trade-off, stated plainly — failing
 * closed would break bill reading for every developer who has a GOOGLE_API_KEY but no service
 * account, and Google's console monthly limit still backstops the spend. The cost is that in
 * this state NOTHING in this app is counting, so that console cap is the ONLY thing between a
 * runaway loop and the bill. Hence the one-time console warning, and `tracking: false` on the
 * budget every caller gets back.
 *
 * firebase-admin is imported here rather than at the top of the file so the arithmetic above
 * stays importable on its own — the unit tests run it under plain node, with no service
 * account and no Admin SDK loaded.
 */
async function usageStore(): Promise<UsageStore | null> {
  try {
    const [{ FieldValue }, { adminDb }] = await Promise.all([
      import('firebase-admin/firestore'),
      import('@/lib/firebaseAdmin'),
    ]);
    return { db: adminDb(''), FieldValue };
  } catch {
    if (!warnedNotTracking) {
      warnedNotTracking = true;
      console.warn('[aiUsageBudget] Firebase Admin is not configured — AI spend is NOT being tracked. Only the Google console monthly limit is protecting the bill.');
    }
    return null;
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** This month's spend against the limit. Never throws — a failed read must not take bill
 *  reading down with it, so it degrades to the same fail-open state as an unconfigured Admin
 *  SDK. */
export async function getAiBudget(now: Date = new Date()): Promise<AiBudget> {
  const limitUsd = monthlyLimitUsd();
  const store = await usageStore();
  if (!store) return budgetOf(0, limitUsd, false);

  try {
    const snap = await store.db.collection(AI_USAGE_COLLECTION).doc(utcMonthKey(now)).get();
    return budgetOf(num(snap.data()?.spend_usd), limitUsd, true);
  } catch (e) {
    console.warn('[aiUsageBudget] could not read this month’s spend — allowing the call:', e);
    return budgetOf(0, limitUsd, false);
  }
}

/** Add one call's tokens to this month's totals and return the new figures. */
export async function recordAiUsage(
  { inputTokens, outputTokens }: { inputTokens: number; outputTokens: number },
  now: Date = new Date(),
): Promise<AiBudget> {
  const limitUsd = monthlyLimitUsd();
  const store = await usageStore();
  if (!store) return budgetOf(0, limitUsd, false);

  const { db, FieldValue } = store;
  const inTok  = Math.max(0, Math.round(Number(inputTokens)  || 0));
  const outTok = Math.max(0, Math.round(Number(outputTokens) || 0));
  const month  = utcMonthKey(now);
  const ref    = db.collection(AI_USAGE_COLLECTION).doc(month);

  // FieldValue.increment, never read-modify-write: bill reads arrive concurrently (a whole
  // site filing expenses at month end), and a read-then-write would keep only the last one —
  // silently under-counting the exact number the cap depends on.
  await ref.set({
    month,
    spend_usd:     FieldValue.increment(aiCostUsd(inTok, outTok, pricing())),
    calls:         FieldValue.increment(1),
    input_tokens:  FieldValue.increment(inTok),
    output_tokens: FieldValue.increment(outTok),
    updated_at:    FieldValue.serverTimestamp(),
  }, { merge: true });

  const snap   = await ref.get();
  const budget = budgetOf(num(snap.data()?.spend_usd), limitUsd, true);
  await warnAdminsIfDue(store, ref, budget, num(snap.data()?.warned_pct), month);
  return budget;
}

// ─── Threshold warning ─────────────────────────────────────────────────────────

/** EPFs of the active System Admins, resolved the way every server-side caller does it (see
 *  src/app/api/admin/backup/route.ts): role docs carry `is_system_admin`, user docs carry the
 *  role NAME. Default database only — that is where the shared counter lives, and where the
 *  people who own the Google billing account are. */
async function systemAdminEpfs(db: Firestore): Promise<string[]> {
  const roleSnap = await db.collection('roles').where('is_system_admin', '==', true).get();
  const names = roleSnap.docs.map(d => String(d.data().name)).filter(Boolean);
  if (!names.length) return [];

  const epfs = new Set<string>();
  for (let i = 0; i < names.length; i += 30) {   // Firestore 'in' caps at 30
    const snap = await db.collection('users').where('role', 'in', names.slice(i, i + 30)).get();
    snap.docs.forEach(d => {
      const u = d.data();
      if (u.is_active === false) return;
      const epf = u.epf_number != null ? String(u.epf_number) : '';
      if (epf) epfs.add(epf);
    });
  }
  return [...epfs];
}

function warningText(budget: AiBudget, threshold: number, month: string): { title: string; body: string } {
  const used = `$${budget.spendUsd.toFixed(2)} of $${budget.limitUsd.toFixed(2)}`;
  if (threshold >= 100) {
    return {
      title: `AI budget for ${month} is used up`,
      body: `Bill reading has used ${used} and is paused until next month — bills still scan on the phone, less accurately. Raise AI_MONTHLY_LIMIT_USD, and the Google billing limit, to resume it.`,
    };
  }
  return {
    title: `AI budget for ${month} is ${Math.round(budget.pct)}% used`,
    body: `Bill reading has used ${used} this month. At 100% it stops and bills fall back to on-device scanning.`,
  };
}

/**
 * One notification per threshold per month to the system admins. NEVER throws — a failed
 * warning must not turn a successful bill read into an error.
 *
 * Written straight to `notifications` with the Admin SDK, matching the document shape
 * createAppNotification writes, because that service is 'use client'. No FCM push: /api/notify
 * pushes on behalf of a signed-in actor, and there is no actor here.
 */
async function warnAdminsIfDue(
  { db, FieldValue }: UsageStore,
  ref: DocumentReference<DocumentData>,
  budget: AiBudget,
  warnedPct: number,
  month: string,
): Promise<void> {
  try {
    const threshold = pendingWarnThreshold(budget.pct, warnPct(), warnedPct);
    if (threshold == null) return;

    // Claim the threshold before sending, so two calls that cross it at the same moment don't
    // both notify.
    const claimed = await db.runTransaction(async tx => {
      const cur = await tx.get(ref);
      if (num(cur.data()?.warned_pct) >= threshold) return false;
      tx.update(ref, { warned_pct: threshold });
      return true;
    });
    if (!claimed) return;

    const epfs = await systemAdminEpfs(db);
    if (!epfs.length) return;

    const { title, body } = warningText(budget, threshold, month);
    const batch = db.batch();
    for (const epf of epfs) {
      batch.set(db.collection('notifications').doc(), {
        to_epf:     epf,
        audience:   null,
        type:       'general',
        actor_epf:  null,
        actor_name: 'AI budget',
        meta: {
          month,
          pct:       String(Math.round(budget.pct)),
          spend_usd: budget.spendUsd.toFixed(2),
          limit_usd: budget.limitUsd.toFixed(2),
        },
        title,
        body,
        link:       null,
        read:       false,
        created_at: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();

    // …and push it, so an admin sees the budget warning without opening the app. The bell doc
    // above is the reliable path; this is best-effort and never throws (sendServerPush catches).
    const admins = await Promise.all(epfs.map(async (epf) => {
      const snap = await db.collection('users').doc(epfDocId(epf)).get().catch(() => null);
      return snap?.exists ? { ref: snap.ref, data: snap.data()! } : null;
    }));
    const recipients = admins.filter((a): a is { ref: DocumentReference; data: DocumentData } => a !== null);
    if (recipients.length) {
      // Loaded lazily and by relative path: this module is unit-tested, and a top-level
      // import of the push helper would drag firebase-admin into that test's require graph
      // (the compiled tests resolve real paths, not the '@/' alias).
      const { sendServerPush } = await import('./serverPush');
      await sendServerPush(recipients, {
        type: 'general', title, body, tag: `ai-budget-${month}-${threshold}`,
      });
    }
  } catch (e) {
    console.warn('[aiUsageBudget] budget warning failed (non-critical):', e);
  }
}
