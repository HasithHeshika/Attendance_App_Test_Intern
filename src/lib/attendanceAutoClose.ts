// Admin-SDK helpers for the hybrid attendance model — shared by the fingerprint engine
// (src/lib/fingerprintApi.ts) and the open-session monitor cron
// (src/app/api/cron/auto-checkout/route.ts).
//
// The pure decision logic and rationale live in src/lib/shiftAutoClose.ts. This module is the
// Firestore side: it closes a session at its RAW punch timestamp (never a scheduled end —
// sessions are sacred), writes the deduplicated attendance_reviews row that gates the session
// out of the approved-attendance reports, and fires the "flagged for review" prompt.
import {
  FieldValue, Timestamp, type Firestore, type DocumentData, type DocumentReference,
} from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getApps } from 'firebase-admin/app';
import { formatPushText } from '@/lib/serverPush';
import type {
  AttendanceReviewReason, AttendanceReviewSource, PunchSource,
} from '@/lib/shiftAutoClose';

// Duplicated from userService/fingerprintApi — those pull in the client SDK, which admin-only
// modules must not touch (same convention as the cron routes' own local copies).
function epfDocId(epf: string): string {
  return epf.includes('/') ? epf.replace(/\//g, '%2F') : epf;
}

function tokensOf(u: DocumentData): string[] {
  const arr = Array.isArray(u.fcm_tokens) ? u.fcm_tokens.filter((t: unknown) => typeof t === 'string') : [];
  if (typeof u.fcm_token === 'string' && u.fcm_token) arr.push(u.fcm_token);
  return [...new Set(arr)] as string[];
}

// Check-out evening allowance rule (mirrors fingerprintApi.calcEveningAllowance): >= 19:00 → 1.
function eveningAllowanceAt(ms: number): 0 | 1 {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Colombo', hour: '2-digit', hour12: false,
  }).format(new Date(ms)).replace(/\D/g, ''));
  return hour >= 19 ? 1 : 0;
}

// ─── Raw close ────────────────────────────────────────────────────────────────────────────
// Close sessions[idx] at `atMs` — the employee's ACTUAL punch instant (Rule 2), never a
// guessed/scheduled time. The session stays raw; it is parked for review, not approved.
// Returns a NEW sessions array (the caller passes it to tx.update). FieldValue.serverTimestamp()
// is not allowed inside an array element, so concrete Timestamps are used.
export function closeSessionRaw(
  sessions: DocumentData[], idx: number, atMs: number, opts: { source: PunchSource },
): DocumentData[] {
  const next = sessions.map(s => ({ ...s }));
  next[idx] = {
    ...next[idx],
    check_out: Timestamp.fromMillis(atMs),
    check_out_status: 'pending',
    check_out_approved_by: null,
    check_out_method: 'system_auto',
    check_out_source: opts.source,
    review_status: 'flagged',
    evening_allowance: eveningAllowanceAt(atMs),
    auto_closed_at: Timestamp.now(),
  };
  return next;
}

// ─── attendance_reviews row ───────────────────────────────────────────────────────────────
export function reviewDocId(epf: string, dateStr: string, sessionId: string): string {
  return `${epfDocId(epf)}_${dateStr}_${sessionId}`;
}
export function reviewRef(db: Firestore, epf: string, dateStr: string, sessionId: string): DocumentReference {
  return db.collection('attendance_reviews').doc(reviewDocId(epf, dateStr, sessionId));
}

export interface ReviewInput {
  epf: string;
  employeeName?: string | null;
  dateStr: string;
  sessionId: string;
  reason: AttendanceReviewReason;
  actualHrs: number;
  scheduledHrs: number | null;
  severityHrs: number;
  source: AttendanceReviewSource;
}

// The row body (minus id). `created_at` is a server timestamp — safe here (top-level field,
// not inside an array).
export function reviewDocData(input: ReviewInput): DocumentData {
  return {
    epf_number: input.epf,
    employee_name: input.employeeName ?? null,
    attendance_date: input.dateStr,
    session_id: input.sessionId,
    review_reason: input.reason,
    review_status: 'flagged',
    severity_hours: input.severityHrs,
    actual_hours: input.actualHrs,
    scheduled_hours: input.scheduledHrs,
    source_channel: input.source,
    created_at: FieldValue.serverTimestamp(),
    in_review_by: null,
    in_review_at: null,
    resolved_by: null,
    resolved_at: null,
    resolution: null,
    resolution_note: null,
    linked_ot_request_id: null,
    linked_edit_request_id: null,
    is_deleted: false,
  };
}

// Create the review row only if it does not already exist — so a cron re-run, or the engine
// racing the cron, never clobbers a supervisor who already moved it to in_review/resolved.
// Returns true when this call created it.
export async function createReviewIfAbsent(db: Firestore, input: ReviewInput): Promise<boolean> {
  try {
    await reviewRef(db, input.epf, input.dateStr, input.sessionId).create(reviewDocData(input));
    return true;
  } catch {
    return false; // already flagged
  }
}

// ─── Notification ─────────────────────────────────────────────────────────────────────────
// In-app bell doc (deterministic id → a re-run overwrites, never duplicates) + best-effort FCM
// push. Never throws. Call AFTER the enclosing transaction has committed. Attendance-facing
// copy: "extra hours" / "time correction", never "overtime" (see CLAUDE.md).
export async function notifyReviewFlag(
  db: Firestore,
  opts: { epf: string; dateStr: string; sessionId: string; actualHrs: number; brand?: string },
): Promise<void> {
  const { epf, dateStr, sessionId, actualHrs } = opts;
  const safe = epfDocId(epf);
  const tag = `review-${safe}_${dateStr}_${sessionId}`;
  const hrs = Math.round(actualHrs * 10) / 10;

  const title = 'Shift flagged for review';
  const body = `Your ${dateStr} shift ran about ${hrs}h and is flagged for review. Tap to file an extra-hours or time-correction request.`;
  const link = `/ot-requests?prefillDate=${dateStr}${hrs > 0 ? `&prefillHours=${Math.min(24, Math.round(hrs * 2) / 2)}` : ''}`;

  await db.collection('notifications').doc(tag).set({
    to_epf: epf,
    audience: null,
    type: 'reminder',
    actor_epf: null,
    actor_name: opts.brand ?? 'System',
    meta: { attendance_review: '1', date: dateStr },
    title,
    body,
    link,
    read: false,
    created_at: FieldValue.serverTimestamp(),
  }).catch(() => { /* bell is best-effort — the FCM push below still tries */ });

  try {
    const snap = await db.collection('users').doc(safe).get();
    if (!snap.exists) return;
    const u = snap.data() as DocumentData;
    const tokens = tokensOf(u);
    if (!tokens.length) return;

    const formatted = formatPushText(title, body, 'reminder');
    const dataPayload = {
      type: 'reminder',
      realType: 'reminder',
      title: formatted.title,
      body: formatted.body,
      link,
      docId: tag,
      tag,
    };
    const webpush = {
      headers: {
        Urgency: 'high',
        TTL: '86400',
        Topic: tag.replace(/[^a-zA-Z0-9-_.~%]/g, '').slice(0, 32),
      },
      fcmOptions: {},
    };
    const resp = await getMessaging(getApps()[0]).sendEachForMulticast({
      tokens,
      data: dataPayload,
      webpush,
    });

    const dead = new Set<string>();
    resp.responses.forEach((r, i) => {
      const code = r.error?.code ?? '';
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        dead.add(tokens[i]);
      }
    });
    if (dead.size) {
      const patch: Record<string, unknown> = { fcm_tokens: FieldValue.arrayRemove(...dead) };
      if (dead.has(String(u.fcm_token))) patch.fcm_token = null;
      await snap.ref.update(patch).catch(() => undefined);
    }
  } catch { /* push is optional — the in-app doc already delivered */ }
}
