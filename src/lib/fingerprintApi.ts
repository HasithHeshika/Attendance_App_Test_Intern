// Shared server-side helpers for the fingerprint-terminal API routes
// (src/app/api/fingerprint/*, src/app/api/admin/fingerprint-devices/*).
//
// Admin SDK only — never imported by client code. See:
//   FINGERPRINT_ATTENDANCE_API.md                                  (wire contract for Android)
//   FINGERPRINT_APP_FIREBASE_BE_FUNCTION_CONTRACT_V1.md             (original proposal this adapts)
//
// Design notes (why this differs from the original contract):
//   - This app has no opaque Firestore-auto-id "userId" — epf_number IS the users/{doc id}
//     and is used everywhere (attendances, tasks, leaves...). The wire contract's `userId`
//     maps to epf_number; `employeeId` maps to employee_number, falling back to epf_number.
//   - Attendance from a fingerprint scan is written directly into the SAME
//     attendances/{epf}_{date}.sessions[] array the mobile check-in/out flow uses (see
//     apiCompat.ts checkIn/checkOut) — first scan of the day opens a session, the next scan
//     closes the most recently opened one — so it shows up immediately in every existing
//     report/export with no new screens. Sessions are auto-approved (check_in_status /
//     check_out_status = 'approved', *_approved_by = 'FINGERPRINT' — a recognizable sentinel,
//     not an epf) since a fingerprint match already confirms identity + physical presence.
//   - Idempotency (`fingerprint_attendance_events/{attendanceEventId}`) is only recorded on a
//     RECORDED outcome. A REJECTED event (e.g. the user was inactive at the time) is NOT
//     locked in — retrying the same attendanceEventId after the underlying issue is fixed can
//     still succeed, matching how an offline terminal actually retries its queue.
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  FieldValue, Timestamp, type Firestore, type DocumentData, type DocumentReference,
} from 'firebase-admin/firestore';
import { adminAuth, tenantForRequest } from '@/lib/firebaseAdmin';
import {
  isDuplicatePunch, DUP_PUNCH_DEBOUNCE_SECONDS,
  isOverlong, deriveReviewReason, reviewSeverityHours,
  pickOpenSessionToClose, CHECKOUT_LOOKBACK_HOURS,
  type AttendanceReviewReason, type OpenSessionRef,
} from '@/lib/shiftAutoClose';
import {
  closeSessionRaw, reviewRef, reviewDocData, notifyReviewFlag,
} from '@/lib/attendanceAutoClose';
import { secretEquals } from '@/lib/timingSafe';
import {
  actionOf, attendanceBiometricPersistence, biometricTypeOf,
  type AttendanceAction,
} from '@/lib/attendanceBiometric';

export const TIME_ZONE = 'Asia/Colombo';
export const APPROVED_BY_SENTINEL = 'FINGERPRINT';

// ─── Error codes (contract §11) ────────────────────────────────────────────────
export const FPA = {
  DEVICE_NOT_FOUND:      'FPA-001',
  DEVICE_DISABLED:       'FPA-002',
  USER_NOT_FOUND:        'FPA-003',
  USER_DISABLED:         'FPA-004',
  EMPLOYEE_ID_MISMATCH:  'FPA-005',
  TENANT_NOT_SUPPORTED:  'FPA-006',
  INVALID_ENROLLMENT:    'FPA-101',
  ENROLLMENT_CONFLICT:   'FPA-102',
  INVALID_TEMPLATE_SET:  'FPA-103',
  INVALID_ATTENDANCE_EVENT: 'FPA-201',
  ATTENDANCE_REJECTED:   'FPA-202',
  INVALID_SYNC_REQUEST:  'FPA-301',
  UNAUTHENTICATED:       'FPA-401',
  INTERNAL_ERROR:        'FPA-999',
} as const;
export type FpaCode = (typeof FPA)[keyof typeof FPA];

export class FpaError extends Error {
  code: FpaCode;
  status: number;
  constructor(code: FpaCode, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function fpaErrorResponse(e: unknown): NextResponse {
  if (e instanceof FpaError) {
    return NextResponse.json({ code: e.code, message: e.message }, { status: e.status });
  }
  console.error('[fingerprint-api]', e);
  return NextResponse.json({ code: FPA.INTERNAL_ERROR, message: 'Internal error' }, { status: 500 });
}

// ─── EPF helpers (duplicated from userService.ts — that module imports the client SDK,
// which admin-only API routes must not pull in; same convention as the birthday/cron routes) ──
export function normalizeEpf(epf: string): string {
  return epf.replace(/\s+/g, '');
}
export function epfDocId(epf: string): string {
  const clean = normalizeEpf(epf);
  return clean.includes('/') ? clean.replace(/\//g, '%2F') : clean;
}

// ─── Shared-secret auth ─────────────────────────────────────────────────────────
// Every device-facing request must carry FINGERPRINT_API_KEY (same convention as
// WORKFORCE_API_KEY on /api/working-status) — proves the caller is a legitimate terminal
// deployment before we even look at the deviceId it claims to be.
function requireSharedSecret(req: NextRequest): void {
  const expected = process.env.FINGERPRINT_API_KEY;
  if (!expected) {
    throw new FpaError(FPA.UNAUTHENTICATED, 503, 'API not configured: set FINGERPRINT_API_KEY on the server.');
  }
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const provided = bearer || req.headers.get('x-api-key') || new URL(req.url).searchParams.get('key') || '';
  if (!secretEquals(provided, expected)) {
    throw new FpaError(FPA.UNAUTHENTICATED, 401, 'Unauthorized');
  }
}

export interface DeviceDoc {
  ref: DocumentReference;
  id: string;
  name: string;
  active: boolean;
  working_place: string | null;
  company_id: string | null;
  company_name: string | null;
}

// Fingerprint terminals are a Southernlanka (carecode.org) initiative only — same tenant
// scope as AppUser.attendance_methods (see the isSouthernlanka gate on users/page.tsx).
// `adminDbFor(req)` would happily resolve altavision.lk's database too, so this is the guard
// that actually stops a mis-pointed terminal (or a device doc created by mistake) from ever
// reading/writing there. Same tenant-id-comparison convention the client side already uses.
export function requireSouthernlankaTenant(req: NextRequest): void {
  const tenant = tenantForRequest(req);
  if (tenant.id !== 'southernlanka') {
    throw new FpaError(
      FPA.TENANT_NOT_SUPPORTED, 403,
      `Fingerprint attendance is only available for the southernlanka tenant (resolved: ${tenant.id}).`,
    );
  }
}

// Validates the shared secret, the tenant, AND that `deviceId` names an active
// attendance_devices doc. The shared secret alone would let any decommissioned/disabled
// terminal keep writing.
export async function authenticateDevice(req: NextRequest, db: Firestore, deviceId: unknown): Promise<DeviceDoc> {
  requireSharedSecret(req);
  requireSouthernlankaTenant(req);
  const id = typeof deviceId === 'string' ? deviceId.trim() : '';
  if (!id) throw new FpaError(FPA.DEVICE_NOT_FOUND, 400, 'deviceId is required.');

  const ref = db.collection('attendance_devices').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new FpaError(FPA.DEVICE_NOT_FOUND, 404, `Unknown device: ${id}`);
  const data = snap.data() as DocumentData;
  if (data.active !== true) throw new FpaError(FPA.DEVICE_DISABLED, 403, `Device is disabled: ${id}`);

  return {
    ref, id,
    name: (data.name as string) ?? id,
    active: true,
    working_place: (data.working_place as string) ?? null,
    company_id: (data.company_id as string) ?? null,
    company_name: (data.company_name as string) ?? null,
  };
}

// ─── User lookup / validation ──────────────────────────────────────────────────
export interface UserValidation {
  ok: boolean;
  code?: FpaCode;
  message?: string;
  ref: DocumentReference;
  data: DocumentData | null;
  employeeId: string; // resolved employee_number || epf_number
}

// Non-transactional read — used by routes (enrollments) that should hard-fail on a bad
// user/employeeId pair rather than fold it into a per-event REJECTED result.
export async function loadAndValidateUser(
  db: Firestore, userId: unknown, employeeId: unknown,
): Promise<{ ref: DocumentReference; data: DocumentData; employeeId: string }> {
  const epf = typeof userId === 'string' ? normalizeEpf(userId.trim()) : '';
  if (!epf) throw new FpaError(FPA.USER_NOT_FOUND, 400, 'userId is required.');
  const ref = db.collection('users').doc(epfDocId(epf));
  const snap = await ref.get();
  const v = validateUserSnap(ref, snap.exists ? (snap.data() as DocumentData) : null, employeeId);
  if (!v.ok) throw new FpaError(v.code!, v.code === FPA.USER_NOT_FOUND ? 404 : 409, v.message!);
  return { ref, data: v.data!, employeeId: v.employeeId };
}

// Pure validation over an already-fetched snapshot — shared by loadAndValidateUser (throws)
// and processAttendanceEvent (returns a soft REJECTED result instead of throwing).
export function validateUserSnap(
  ref: DocumentReference, data: DocumentData | null, employeeIdInput: unknown,
): UserValidation {
  if (!data) return { ok: false, code: FPA.USER_NOT_FOUND, message: 'User not found.', ref, data: null, employeeId: '' };
  if (data.is_active === false) {
    return { ok: false, code: FPA.USER_DISABLED, message: 'User is not active.', ref, data, employeeId: '' };
  }
  const resolvedEmployeeId = (data.employee_number as string) || (data.epf_number as string) || '';
  const claimed = typeof employeeIdInput === 'string' ? employeeIdInput.trim() : '';
  if (claimed && claimed !== resolvedEmployeeId) {
    return {
      ok: false, code: FPA.EMPLOYEE_ID_MISMATCH,
      message: 'Employee ID does not match the requested user.', ref, data, employeeId: resolvedEmployeeId,
    };
  }
  return { ok: true, ref, data, employeeId: resolvedEmployeeId };
}

// ─── Colombo local-time helpers (mirrors approvals/page.tsx allowance rules + the
// birthday/working-status routes' Colombo date convention — servers run in UTC) ──────────────
export function colomboDateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(d); // 'YYYY-MM-DD'
}

function colomboMinutesOfDay(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}

// Check-in: before 06:45 → cat1, 06:45–07:00 → cat2, after 07:00 → none.
export function calcMorningAllowance(d: Date): 0 | 1 | 2 {
  const mins = colomboMinutesOfDay(d);
  if (mins < 6 * 60 + 45) return 1;
  if (mins <= 7 * 60) return 2;
  return 0;
}

// Check-out: before 19:00 → none, after 19:00 → cat1.
export function calcEveningAllowance(d: Date): 0 | 1 {
  return colomboMinutesOfDay(d) >= 19 * 60 ? 1 : 0;
}

export function prevDateStr(date: string): string {
  const [y, m, dd] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dd));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function parseDeviceTimestamp(raw: unknown): Date {
  if (typeof raw !== 'string' || !raw) {
    throw new FpaError(FPA.INVALID_ATTENDANCE_EVENT, 400, 'deviceTimestamp is required.');
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new FpaError(FPA.INVALID_ATTENDANCE_EVENT, 400, `deviceTimestamp is not a valid ISO timestamp: ${raw}`);
  }
  return d;
}

// ─── Session helpers (mirrors apiCompat.ts newSessionId/openSessionOf) ─────────────────────
function newSessionId(): string {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function sessionsOf(rec: DocumentData | undefined): DocumentData[] {
  if (!rec) return [];
  return Array.isArray(rec.sessions) ? (rec.sessions as DocumentData[]) : [];
}

// Every still-open session (checked in, not yet out) in one day's sessions array, tagged with
// `dayKey` — an opaque label the caller maps back to its own day-document — and its own
// check_in ms, so candidates from different day-documents can be compared directly by
// pickOpenSessionToClose (shiftAutoClose.ts), which knows nothing about Firestore or dates.
function openSessionCandidatesOf(sessions: DocumentData[], dayKey: string): OpenSessionRef[] {
  const out: OpenSessionRef[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (!s.check_in || s.check_out) continue;
    const checkInMs = (s.check_in as Timestamp | undefined)?.toMillis?.() ?? null;
    if (checkInMs == null) continue;
    out.push({ dayKey, sessionIndex: i, checkInMs });
  }
  return out;
}

// ─── Attendance event processing (shared by the single + bulk record routes) ──────────────
export interface AttendanceEventInput {
  attendanceEventId: unknown;
  userId: unknown;
  employeeId: unknown;
  deviceTimestamp: unknown;
  clientSequence?: unknown;
  // Hybrid model: the terminal's explicit intent. Optional — an old terminal build sends
  // nothing and the backend falls back to inferring direction from session state.
  action?: unknown;
  // Which sensor made this scan. Optional — omitted keeps meaning FINGERPRINT, so an old
  // terminal build (fingerprint-only) needs no change. See attendanceBiometric.ts.
  biometricType?: unknown;
}

export interface AttendanceEventResult {
  attendanceEventId: string;
  status: 'RECORDED' | 'ALREADY_RECORDED' | 'REJECTED' | 'DEBOUNCED' | 'FAILED';
  attendanceRecordId?: string | null;
  attendanceAction?: 'CHECK_IN' | 'CHECK_OUT' | null;
  /** Set to 'flagged' when the session this punch touched was parked for supervisor review. */
  reviewStatus?: 'flagged' | null;
  errorCode?: string;
  message?: string;
}

// Post-commit notification plan — set when a session was flagged for review in the transaction.
interface ReviewPlan {
  dateStr: string;
  sessionId: string;
  actualHrs: number;
}
type TxResult = AttendanceEventResult & { _review?: ReviewPlan };

// A scan on an OPEN session this soon after its own check-in is a sensor double-read / retried
// duplicate, not a real second punch — never toggle a session on it (inferred path only; the
// global fingerprint_last_punch debounce covers the explicit-action paths).
const MIN_SESSION_DURATION_SECONDS = 60;

type DeclaredAction = AttendanceAction | null;

function userDisplayName(data: DocumentData | null | undefined): string | null {
  if (!data) return null;
  const s = String(data.display_name ?? data.name ?? data.first_name ?? '').trim();
  return s || null;
}

const HOURS_MS = 3_600_000;

export async function processAttendanceEvent(
  db: Firestore, device: DeviceDoc, input: AttendanceEventInput,
): Promise<AttendanceEventResult> {
  const attendanceEventId = typeof input.attendanceEventId === 'string' ? input.attendanceEventId.trim() : '';
  if (!attendanceEventId) {
    return { attendanceEventId: '', status: 'REJECTED', errorCode: FPA.INVALID_ATTENDANCE_EVENT, message: 'attendanceEventId is required.' };
  }

  let scanDate: Date;
  try {
    scanDate = parseDeviceTimestamp(input.deviceTimestamp);
  } catch (e) {
    const err = e as FpaError;
    return { attendanceEventId, status: 'REJECTED', errorCode: err.code, message: err.message };
  }
  const scanMs = scanDate.getTime();

  const epfRaw = typeof input.userId === 'string' ? input.userId.trim() : '';
  if (!epfRaw) {
    return { attendanceEventId, status: 'REJECTED', errorCode: FPA.USER_NOT_FOUND, message: 'userId is required.' };
  }
  const epf = normalizeEpf(epfRaw);
  const attendanceEpfId = epfDocId(epf);
  const userRef = db.collection('users').doc(epfDocId(epf));
  const date = colomboDateStr(scanDate);
  const todayRef = db.collection('attendances').doc(`${attendanceEpfId}_${date}`);
  const prevDate = prevDateStr(date);
  const prevRef = db.collection('attendances').doc(`${attendanceEpfId}_${prevDate}`);
  // A CHECKOUT_LOOKBACK_HOURS (36h) window can span at most 3 local calendar-day documents —
  // worked out from the worst case, a scan at 00:00:01 today reaching back to noon two days
  // prior — so this third day is the only additional candidate ever needed.
  const dayBeforePrevDate = prevDateStr(prevDate);
  const dayBeforePrevRef = db.collection('attendances').doc(`${attendanceEpfId}_${dayBeforePrevDate}`);
  const eventRef = db.collection('fingerprint_attendance_events').doc(attendanceEventId);
  const lastPunchRef = db.collection('fingerprint_last_punch').doc(attendanceEpfId);

  const biometricType = biometricTypeOf(input.biometricType);
  if (!biometricType) {
    return { attendanceEventId, status: 'REJECTED', errorCode: FPA.INVALID_ATTENDANCE_EVENT, message: 'biometricType must be FINGERPRINT or FACE.' };
  }
  const declared = actionOf(input.action);
  if (input.action != null && !declared) {
    return { attendanceEventId, status: 'REJECTED', errorCode: FPA.INVALID_ATTENDANCE_EVENT, message: 'action must be CHECK_IN or CHECK_OUT.' };
  }
  const biometric = attendanceBiometricPersistence(biometricType);

  try {
    const result = await db.runTransaction(async (tx): Promise<TxResult> => {
      // ── Idempotency ── A prior RECORDED/DEBOUNCED event is locked in. A prior REJECTED is
      // NOT (e.g. "no open session" that was since fixed) — fall through and reprocess it.
      const eventSnap = await tx.get(eventRef);
      if (eventSnap.exists) {
        const prev = eventSnap.data() as DocumentData;
        const st = String(prev.status ?? '');
        if (st === 'RECORDED') {
          return {
            attendanceEventId, status: 'ALREADY_RECORDED',
            attendanceRecordId: (prev.attendance_record_id as string) ?? null,
            attendanceAction: (prev.attendance_action as 'CHECK_IN' | 'CHECK_OUT') ?? null,
          };
        }
        if (st === 'DEBOUNCED') {
          return { attendanceEventId, status: 'DEBOUNCED', attendanceRecordId: null, attendanceAction: null, message: 'Already processed (debounced).' };
        }
      }

      // ── All reads before any writes (Firestore transaction requirement) ──
      const userSnap = await tx.get(userRef);
      const v = validateUserSnap(userRef, userSnap.exists ? (userSnap.data() as DocumentData) : null, input.employeeId);

      const todaySnap = await tx.get(todayRef);
      const todaySessions = sessionsOf(todaySnap.exists ? (todaySnap.data() as DocumentData) : undefined);

      // Checkout matching: "if a person checked in, they must be able to check out" — no
      // is_shift_worker flag, no roster dependency. Always read both fallback days (all reads
      // must precede writes in a Firestore transaction, same as every other read here); across
      // every still-open session found in the three, pick the most recent one still within
      // CHECKOUT_LOOKBACK_HOURS of this scan (see pickOpenSessionToClose, shiftAutoClose.ts).
      const prevSnap = await tx.get(prevRef);
      const prevSessions = sessionsOf(prevSnap.exists ? (prevSnap.data() as DocumentData) : undefined);
      const dayBeforePrevSnap = await tx.get(dayBeforePrevRef);
      const dayBeforePrevSessions = sessionsOf(dayBeforePrevSnap.exists ? (dayBeforePrevSnap.data() as DocumentData) : undefined);

      const dayBuckets = [
        { key: 'today', ref: todayRef, date, sessions: todaySessions },
        { key: 'prev', ref: prevRef, date: prevDate, sessions: prevSessions },
        { key: 'prev2', ref: dayBeforePrevRef, date: dayBeforePrevDate, sessions: dayBeforePrevSessions },
      ] as const;
      const openCandidates = dayBuckets.flatMap(b => openSessionCandidatesOf(b.sessions, b.key));
      const chosenOpen = pickOpenSessionToClose(openCandidates, scanMs, CHECKOUT_LOOKBACK_HOURS);
      const chosenBucket = chosenOpen ? dayBuckets.find(b => b.key === chosenOpen.dayKey) ?? null : null;
      let openIdx = chosenOpen ? chosenOpen.sessionIndex : -1;

      // Single-session-role guard read (all reads must precede writes).
      const roleName = v.ok && typeof v.data?.role === 'string' ? v.data.role : null;
      let multiSessionAllowed = true;
      if (roleName && todaySessions.length >= 1) {
        const roleSnap = await tx.get(db.collection('roles').where('name', '==', roleName).limit(1));
        multiSessionAllowed = !roleSnap.empty && !!(roleSnap.docs[0].data() as DocumentData).multi_session;
      }

      const lastPunchSnap = await tx.get(lastPunchRef);
      const lastPunchMs = lastPunchSnap.exists
        ? ((lastPunchSnap.data() as DocumentData).last_punch_ms as number | undefined) ?? null
        : null;

      if (!v.ok) {
        return { attendanceEventId, status: 'REJECTED', errorCode: v.code, message: v.message };
      }

      const now = FieldValue.serverTimestamp();
      const openRef = chosenBucket ? chosenBucket.ref : todayRef;
      const openDate = chosenBucket ? chosenBucket.date : date;
      const openSessions = chosenBucket ? chosenBucket.sessions : todaySessions;
      const openSession = openIdx !== -1 ? openSessions[openIdx] : null;
      const openCheckInMs = openSession
        ? ((openSession.check_in as Timestamp | undefined)?.toMillis?.() ?? null)
        : null;
      const openSessionId = openSession ? String(openSession.id ?? `s${openIdx}`) : '';

      // Read any existing review row for the open session BEFORE any writes below — needed so a
      // reconcile/overlong-close never clobbers a supervisor's in-progress or resolved review
      // (Firestore transactions require all reads to precede all writes).
      const existingReviewSnap = openIdx !== -1
        ? await tx.get(reviewRef(db, epf, openDate, openSessionId))
        : null;

      const eventDoc = (
        status: string,
        o: { action: 'CHECK_IN' | 'CHECK_OUT' | null; recordId: string | null },
      ): DocumentData => ({
        attendance_event_id: attendanceEventId,
        epf_number: epf,
        // Resolved employee_number (falling back to epf_number when the employee has none —
        // see validateUserSnap) — the wire contract's `employeeId` was already being checked
        // against this same value for a mismatch, just never persisted. Every eventDoc() call
        // site runs after the `if (!v.ok) return` guard above, so v.employeeId is always the
        // validated value here, never the caller's unverified claim.
        employee_number: v.employeeId,
        device_id: device.id,
        biometric_type: biometricType,
        status,
        declared_action: declared,
        attendance_record_id: o.recordId,
        attendance_action: o.action,
        device_timestamp: input.deviceTimestamp,
        client_sequence: typeof input.clientSequence === 'number' ? input.clientSequence : null,
        received_at: FieldValue.serverTimestamp(),
      });

      // ── Global duplicate-punch debounce (explicit + inferred) ──
      if (isDuplicatePunch(lastPunchMs, scanMs)) {
        const agoSeconds = Math.round((scanMs - (lastPunchMs ?? 0)) / 1000);
        tx.set(eventRef, eventDoc('DEBOUNCED', { action: null, recordId: null }));
        return {
          attendanceEventId, status: 'DEBOUNCED', attendanceRecordId: null, attendanceAction: null,
          message: `Ignored: another punch was recorded ${agoSeconds}s ago, under the ${DUP_PUNCH_DEBOUNCE_SECONDS}s duplicate-punch window.`,
        };
      }

      let attendanceAction!: 'CHECK_IN' | 'CHECK_OUT';
      let attendanceRecordId!: string;
      let reviewFlagged = false;
      let reviewPlan: ReviewPlan | null = null;
      const writes: Array<() => void> = [];

      const newCheckInSession = (flagged: boolean): DocumentData => ({
        id: newSessionId(),
        locations: device.working_place
          ? [{ name: device.working_place, site_number: null, lat: null, lng: null, accuracy_m: null, source: 'check_in', added_at: Timestamp.now(), added_by: null }]
          : [],
        check_in: Timestamp.fromDate(scanDate),
        check_in_method: biometric.method,
        check_in_source: declared === 'CHECK_IN' ? biometric.explicitSource : 'inferred',
        check_out_method: null,
        check_out: null,
        check_out_source: null,
        check_in_lat: null, check_in_lng: null, check_in_accuracy_m: null,
        check_out_lat: null, check_out_lng: null, check_out_accuracy_m: null,
        check_in_site_id: null,
        check_in_site_name: device.working_place,
        check_in_site_distance_m: null,
        picked_by: null, picked_by_name: null, picked_at: null,
        working_place: null, site_number: null,
        is_outstation: false, outstation_location_id: null, outstation_name: null, outstation_address: null,
        is_outstation_approved: false,
        morning_allowance: calcMorningAllowance(scanDate),
        evening_allowance: 0,
        check_in_approved_by: biometric.approvalBy,
        check_out_approved_by: null,
        check_in_status: 'approved',
        check_out_status: 'pending',
        review_status: flagged ? 'flagged' : null,
        is_past_submission: false,
        past_approved_by: null,
      });

      const queueNewSession = (base: DocumentData[], s: DocumentData) => {
        if (todaySnap.exists) {
          writes.push(() => tx.update(todayRef, { sessions: [...base, s], updated_at: now }));
        } else {
          writes.push(() => tx.set(todayRef, {
            id: todayRef.id, epf_number: epf,
            company_id: (v.data?.company_id as string) ?? '',
            company_name: (v.data?.company_name as string) ?? '',
            date, sessions: [s], request_from: [], is_past_submission: false,
            created_at: now, updated_at: now,
          }));
        }
      };

      const existingReviewStatus = existingReviewSnap?.exists
        ? ((existingReviewSnap.data() as DocumentData).review_status as string | undefined)
        : undefined;
      // A supervisor who already moved this session's review to in_review/resolved must never
      // have that silently reverted by a later punch touching the same session — e.g. a delayed
      // fingerprint check-out (live or from a bulk offline-queue flush) closing a session the
      // cron already flagged as open_session_stale and a supervisor has since actioned.
      const reviewLockedBySupervisor = existingReviewStatus === 'in_review' || existingReviewStatus === 'resolved';

      const queueReview = (reason: AttendanceReviewReason, sessionId: string, dateStr: string, actualHrs: number) => {
        reviewFlagged = true;
        if (reviewLockedBySupervisor) return; // preserve the supervisor's existing review row untouched
        writes.push(() => tx.set(
          reviewRef(db, epf, dateStr, sessionId),
          reviewDocData({
            epf, employeeName: userDisplayName(v.data), dateStr, sessionId,
            reason, actualHrs, scheduledHrs: null,
            severityHrs: reviewSeverityHours(actualHrs, null),
            source: biometric.reviewSource,
          }),
        ));
        reviewPlan = { dateStr, sessionId, actualHrs };
      };

      // A late check-out closes the open session at the real punch; flagged when overlong.
      const queueCloseCheckOut = (source: 'fingerprint_explicit' | 'face_explicit' | 'inferred') => {
        const actualHrs = openCheckInMs != null ? (scanMs - openCheckInMs) / HOURS_MS : 0;
        const overlong = openCheckInMs != null && isOverlong(openCheckInMs, scanMs);
        const sessions = [...openSessions];
        const s = { ...sessions[openIdx] };
        s.check_out = Timestamp.fromDate(scanDate);
        s.check_out_method = biometric.method;
        s.check_out_source = source;
        s.working_place = s.working_place ?? device.working_place ?? null;
        s.evening_allowance = calcEveningAllowance(scanDate);
        if (overlong) {
          s.check_out_status = 'pending';
          s.check_out_approved_by = null;
          s.review_status = 'flagged';
        } else {
          s.check_out_status = 'approved';
          s.check_out_approved_by = biometric.approvalBy;
        }
        sessions[openIdx] = s;
        writes.push(() => tx.update(openRef, { sessions, updated_at: now }));
        if (overlong) queueReview(deriveReviewReason({ actualHrs, scheduledHrs: null }), openSessionId, openDate, actualHrs);
        attendanceAction = 'CHECK_OUT';
        attendanceRecordId = openRef.id;
      };

      if (declared === 'CHECK_OUT') {
        if (openIdx === -1) {
          // Never fabricate a phantom session from an OUT-only punch. Log it (retryable).
          tx.set(eventRef, eventDoc('REJECTED', { action: null, recordId: null }));
          return {
            attendanceEventId, status: 'REJECTED', errorCode: FPA.ATTENDANCE_REJECTED,
            message: 'No open session found to check out.',
          };
        }
        queueCloseCheckOut(biometric.explicitSource);

      } else if (declared === 'CHECK_IN' && openIdx !== -1) {
        // ── Rule 2: reconcile ── Close the stale open session at THIS punch (raw, never a
        // guessed time), flag it, and open a fresh session for the new shift.
        const actualHrs = openCheckInMs != null ? (scanMs - openCheckInMs) / HOURS_MS : 0;
        const closed = closeSessionRaw(openSessions, openIdx, scanMs, { source: 'system_auto' });
        const fresh = newCheckInSession(true);
        if (openRef.id === todayRef.id) {
          queueNewSession(closed, fresh);                       // same doc — one write
        } else {
          writes.push(() => tx.update(openRef, { sessions: closed, updated_at: now })); // prev doc
          queueNewSession(todaySessions, fresh);
        }
        queueReview('reopened_after_missing_checkout', openSessionId, openDate, actualHrs);
        attendanceAction = 'CHECK_IN';
        attendanceRecordId = todayRef.id;

      } else if (declared === 'CHECK_IN') {
        if (roleName && todaySessions.length >= 1 && !multiSessionAllowed) {
          return {
            attendanceEventId, status: 'REJECTED', errorCode: FPA.ATTENDANCE_REJECTED,
            message: 'Attendance is already recorded for today — this role is not enabled for multiple sessions per day.',
          };
        }
        queueNewSession(todaySessions, newCheckInSession(false));
        attendanceAction = 'CHECK_IN';
        attendanceRecordId = todayRef.id;

      } else if (openIdx !== -1) {
        // ── Inferred (no explicit action), open session → treat as a check-out ──
        const elapsedSeconds = openCheckInMs != null ? (scanMs - openCheckInMs) / 1000 : Infinity;
        if (elapsedSeconds >= 0 && elapsedSeconds < MIN_SESSION_DURATION_SECONDS) {
          tx.set(eventRef, eventDoc('DEBOUNCED', { action: null, recordId: openRef.id }));
          return {
            attendanceEventId, status: 'DEBOUNCED', attendanceRecordId: openRef.id, attendanceAction: null,
            message: `Ignored: this scan arrived ${Math.round(elapsedSeconds)}s after check-in, under the ${MIN_SESSION_DURATION_SECONDS}s minimum shift duration.`,
          };
        }
        queueCloseCheckOut('inferred');

      } else {
        // ── Inferred, no open session → check-in ──
        if (roleName && todaySessions.length >= 1 && !multiSessionAllowed) {
          return {
            attendanceEventId, status: 'REJECTED', errorCode: FPA.ATTENDANCE_REJECTED,
            message: 'Attendance is already recorded for today — this role is not enabled for multiple sessions per day.',
          };
        }
        queueNewSession(todaySessions, newCheckInSession(false));
        attendanceAction = 'CHECK_IN';
        attendanceRecordId = todayRef.id;
      }

      // ── Write phase ──
      for (const w of writes) w();
      tx.set(lastPunchRef, { epf_number: epf, last_punch_ms: scanMs, updated_at: now });
      tx.set(eventRef, eventDoc('RECORDED', { action: attendanceAction, recordId: attendanceRecordId }));

      return {
        attendanceEventId, status: 'RECORDED', attendanceRecordId, attendanceAction,
        reviewStatus: reviewFlagged ? 'flagged' : null,
        _review: reviewPlan ?? undefined,
      };
    });

    // ── Post-commit: "flagged for review" prompt (best-effort) ──
    const rp = result._review;
    if (result.status === 'RECORDED' && rp) {
      try {
        await notifyReviewFlag(db, {
          epf, dateStr: rp.dateStr, sessionId: rp.sessionId, actualHrs: rp.actualHrs,
          brand: device.company_name ?? undefined,
        });
      } catch (e) {
        console.warn('[fingerprint-attendance] review notify failed (non-critical):', e);
      }
    }

    delete (result as { _review?: unknown })._review; // internal — never part of the wire result
    return result;
  } catch (e) {
    console.error('[fingerprint-attendance]', attendanceEventId, e);
    return { attendanceEventId, status: 'FAILED', errorCode: FPA.INTERNAL_ERROR, message: 'Internal error processing this event.' };
  }
}

// ─── Admin (web-app caller) auth — device provisioning ─────────────────────────
// Mirrors the verify-token → look up users/{uid} → check role capability pattern used by
// src/app/api/admin/reset-password (and the other /api/admin/* routes). Provisioning a
// terminal is a user-management-grade action, so it's gated the same way.
export async function requireUserManager(db: Firestore, idToken: unknown): Promise<{ epf: string }> {
  if (typeof idToken !== 'string' || !idToken) {
    throw new FpaError(FPA.UNAUTHENTICATED, 401, 'Missing idToken.');
  }
  let uid: string;
  try {
    uid = (await adminAuth().verifyIdToken(idToken)).uid;
  } catch {
    throw new FpaError(FPA.UNAUTHENTICATED, 401, 'Unauthorized');
  }
  const callerSnap = await db.collection('users').where('uid', '==', uid).limit(1).get();
  if (callerSnap.empty) throw new FpaError(FPA.UNAUTHENTICATED, 403, 'User management access required.');
  const caller = callerSnap.docs[0].data() as DocumentData;
  const roleSnap = caller.role
    ? await db.collection('roles').where('name', '==', caller.role).limit(1).get()
    : null;
  const roleData = roleSnap && !roleSnap.empty ? (roleSnap.docs[0].data() as DocumentData) : null;
  const canManageUsers = !!(roleData?.is_system_admin || roleData?.can_manage_users);
  if (!canManageUsers) throw new FpaError(FPA.UNAUTHENTICATED, 403, 'User management access required.');
  return { epf: String(caller.epf_number ?? '') };
}
