import { NextRequest, NextResponse } from 'next/server';
import { adminAuth, adminDbFor, tenantForRequest } from '@/lib/firebaseAdmin';
import { resolveCapabilities } from '@/lib/permissions';
import { placeholderEmail } from '@/lib/phone';
import { provisionAuthUser, EmailInUseError } from '@/lib/provisionAuthUser';
import { isValidEmail, isValidNIC, isValidLocalPhone } from '@/lib/validation';
import { generateInitialPassword } from '@/lib/initialPassword';

// firebase-admin needs the Node runtime (not edge) — see the same note on
// src/app/api/notify/route.ts / src/app/api/register/route.ts.
export const runtime = 'nodejs';

/**
 * Server-side bulk user import — southernlanka only (see /users/bulk-add).
 *
 * WHY THIS EXISTS: the bulk-add page used to create Firebase Auth accounts one-by-one
 * from the BROWSER via the client SDK (createUserWithEmailAndPassword on a secondary app —
 * see src/lib/createAuthUser.ts). Creating 100+ accounts back-to-back from one browser
 * session trips Firebase's account-creation abuse/velocity protection
 * (auth/too-many-requests) partway through a large sheet — reproducibly, e.g. "first ~100
 * succeed, the remaining ~21 fail, and keep failing on every retry" (the block persists;
 * it isn't a simple per-request rate limit a short delay fixes). The Admin SDK used here
 * runs server-side under this project's OWN service-account quota and is NOT subject to
 * that per-browser-session abuse guard, so it reliably handles large batches.
 *
 * The client (bulk-add/page.tsx) chunks its rows and POSTs one chunk at a time so each
 * invocation stays well within a serverless function's execution time limit; this route
 * itself also caps a single request to MAX_ROWS_PER_REQUEST as a defensive backstop against
 * being called directly with an oversized payload.
 *
 * Security: the caller must present a valid idToken belonging to a user whose role carries
 * can_manage_users (or is_system_admin) — same gate as the client-side Users page — and the
 * request must land on the southernlanka tenant. Nothing here trusts the client's own
 * field-level validation (duplicate/format checks) beyond what's needed to avoid corrupt
 * records; that validation already ran in the browser before rows ever reach this route.
 */

const ALLOWED_TENANT_ID = 'southernlanka';
const MAX_ROWS_PER_REQUEST = 40;

// Each imported employee gets their OWN random temporary password (see
// src/lib/initialPassword.ts) rather than the shared '12345678' every account used to
// share. It is returned per row so the importer can hand each person their own, and is
// never persisted.

// Kept in sync with src/services/userService.ts (epfDocId / buildNameTokens /
// normalizeEpf / normalizeEmployeeNumber) — duplicated rather than imported for the same
// reason as src/app/api/register/route.ts: this route must never pull in the client SDK.
function normalizeEpf(raw: string): string {
  return raw.replace(/\s+/g, '');
}
function normalizeEmployeeNumber(raw: string): string {
  return raw.replace(/\s+/g, '');
}
function epfDocId(epf: string): string {
  return epf.includes('/') ? epf.replace(/\//g, '%2F') : epf;
}
function buildNameTokens(first: string, last: string): string[] {
  const f = first.toLowerCase().trim();
  const l = last.toLowerCase().trim();
  const full = `${f} ${l}`;
  const tokens = new Set<string>();
  tokens.add(f);
  tokens.add(l);
  tokens.add(full);
  for (let i = 1; i <= f.length; i++) tokens.add(f.slice(0, i));
  for (let i = 1; i <= l.length; i++) tokens.add(l.slice(0, i));
  for (let i = 1; i <= full.length; i++) tokens.add(full.slice(0, i));
  return Array.from(tokens).filter(t => t.length >= 2);
}

interface BulkImportRowInput {
  id: string;
  epf_number: string;
  employee_number: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  department: string;
  company_id: string;
  phone_personal: string;
  address: string;
  nic: string;
  date_of_birth: string;
  date_of_join: string;
  full_name: string;
  name_with_initials: string;
  gender: string;
  guardian_contact: string;
}

// `password` is the one-time password this row's account was created with. It is returned
// so the importer can hand each person their own — it is never persisted anywhere, so this
// response is the only place it exists.
type RowResult = { id: string; status: 'created' | 'updated' | 'error'; message?: string; password?: string };

export async function POST(req: NextRequest) {
  try {
    const tenant = tenantForRequest(req);
    if (tenant.id !== ALLOWED_TENANT_ID) {
      return NextResponse.json({ error: 'Bulk import is not available on this domain' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const idToken = String(body?.idToken ?? '');
    const rows = Array.isArray(body?.rows) ? (body.rows as BulkImportRowInput[]) : [];
    if (!idToken || !rows.length) {
      return NextResponse.json({ error: 'idToken and rows are required' }, { status: 400 });
    }
    if (rows.length > MAX_ROWS_PER_REQUEST) {
      return NextResponse.json({ error: `Send at most ${MAX_ROWS_PER_REQUEST} rows per request` }, { status: 400 });
    }

    let callerUid: string;
    try { callerUid = (await adminAuth().verifyIdToken(idToken)).uid; }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const db = adminDbFor(req);

    // Caller must have can_manage_users (System Admin implies it) — same gate as the
    // client-side Users page (roleCan(..., 'can_manage_users')).
    const callerSnap = await db.collection('users').where('uid', '==', callerUid).limit(1).get();
    const callerData = callerSnap.empty ? null : callerSnap.docs[0].data();
    const roleSnap = callerData?.role
      ? await db.collection('roles').where('name', '==', String(callerData.role)).limit(1).get()
      : null;
    const role = roleSnap && !roleSnap.empty ? roleSnap.docs[0].data() : null;
    const caps = resolveCapabilities(role as never, callerData?.employee_type);
    if (!(caps.is_system_admin || caps.can_manage_users)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // One read for every company so each row can resolve company_name without a
    // per-row round trip (mirrors the client's own `companies` list lookup).
    const companiesSnap = await db.collection('companies').get();
    const companyNameById = new Map<string, string>();
    companiesSnap.docs.forEach(d => companyNameById.set(d.id, String(d.data()?.name ?? '')));

    const auth = adminAuth();
    const results: RowResult[] = [];

    // Sequential, not Promise.all — keeps this within one request's time budget predictably
    // and means each row's existence check sees every earlier row in THIS SAME batch (no
    // read racing against a write from two rows a moment apart).
    for (const row of rows) {
      const rowId = String(row?.id ?? '');
      try {
        const epf = normalizeEpf(String(row?.epf_number ?? ''));
        if (!epf) throw new Error('EPF number is required');
        const firstName = String(row?.first_name ?? '').trim();
        const lastName = String(row?.last_name ?? '').trim();
        if (!firstName || !lastName) throw new Error('First/Last name is required');

        // Format guard — mirrors the browser's per-field checks (src/lib/validation.ts).
        // The review UI already blocks these, but a malformed row that reaches this route
        // directly (or via a future client bug) must never be written as corrupt data.
        const nicRaw = String(row?.nic ?? '').trim();
        if (nicRaw && !isValidNIC(nicRaw)) throw new Error('Invalid NIC — 12 digits, or 9 digits followed by V/X');
        const emailRaw = String(row?.email ?? '').trim();
        if (emailRaw && !isValidEmail(emailRaw)) throw new Error('Not a valid email address');
        const phoneRaw = String(row?.phone_personal ?? '').trim();
        if (phoneRaw && !isValidLocalPhone(phoneRaw)) throw new Error('Contact number must be exactly 10 digits, starting with 0');
        const guardianRaw = String(row?.guardian_contact ?? '').trim();
        if (guardianRaw && !isValidLocalPhone(guardianRaw)) throw new Error('Guardian contact must be exactly 10 digits, starting with 0');

        const employeeNumber = normalizeEmployeeNumber(String(row?.employee_number ?? ''));
        const companyId = String(row?.company_id ?? '');
        const companyName = companyNameById.get(companyId) ?? '';
        const ref = db.collection('users').doc(epfDocId(epf));
        const snap = await ref.get();
        const now = new Date();

        if (snap.exists) {
          // Bulk update deliberately never touches is_active — the sheet has no status
          // column, so a stale/blank cell here must never silently reactivate someone who
          // was deactivated or marked resigned through the normal Users page (mirrors the
          // client's previous updateUser call).
          await ref.update({
            first_name: firstName,
            last_name: lastName,
            display_name: `${firstName} ${lastName}`,
            employee_number: employeeNumber,
            role: String(row?.role ?? ''),
            department: String(row?.department ?? ''),
            company_id: companyId,
            company_name: companyName,
            phone_personal: String(row?.phone_personal ?? ''),
            address: String(row?.address ?? ''),
            nic: String(row?.nic ?? ''),
            date_of_birth: row?.date_of_birth || null,
            date_of_join: row?.date_of_join || null,
            full_name: String(row?.full_name ?? ''),
            name_with_initials: String(row?.name_with_initials ?? ''),
            gender: String(row?.gender ?? ''),
            guardian_contact: String(row?.guardian_contact ?? ''),
            updated_at: now,
          });
          results.push({ id: rowId, status: 'updated' });
          continue;
        }

        const enteredEmail = String(row?.email ?? '').trim();
        const email = enteredEmail || placeholderEmail();

        // Adopts a leftover Auth account when the address belonged to a DELETED employee, and
        // still refuses when a live profile holds it. Without this, re-adding anyone who was
        // ever deleted fails permanently: their Auth account outlives their profile.
        const initialPassword = generateInitialPassword();
        let uid: string;
        let adoptedAuth = false;
        try {
          const provisioned = await provisionAuthUser(auth, db, email, initialPassword);
          uid = provisioned.uid;
          adoptedAuth = provisioned.adopted;
        } catch (e: unknown) {
          if (e instanceof EmailInUseError) throw new Error('Email already in use');
          throw e;
        }

        try {
          await ref.set({
            uid, epf_number: epf, employee_number: employeeNumber, email,
            first_name: firstName, last_name: lastName, display_name: `${firstName} ${lastName}`,
            name_tokens: buildNameTokens(firstName, lastName),
            role: String(row?.role ?? ''), designation: '', department: String(row?.department ?? ''),
            company_id: companyId, company_name: companyName,
            employee_type: 'Permanent', supervisor_epf: null,
            phone_personal: String(row?.phone_personal ?? ''), phone_office: '', phone_emergency: '',
            address: String(row?.address ?? ''), nic: String(row?.nic ?? ''),
            date_of_birth: row?.date_of_birth || null, date_of_join: row?.date_of_join || null, date_of_resign: null,
            insurance: false, blood_type: '', b_card_status: false,
            avatar_url: null, fcm_token: null, is_active: true, is_shift_worker: false,
            full_name: String(row?.full_name ?? ''), name_with_initials: String(row?.name_with_initials ?? ''),
            gender: String(row?.gender ?? ''), guardian_contact: String(row?.guardian_contact ?? ''),
            // The import sheet has no Attendance Method column — default to Fingerprint,
            // same as the bulk-add page did client-side (see its own comment).
            attendance_methods: ['fingerprint'],
            created_at: now, updated_at: now,
          });
        } catch (e) {
          // Roll back the orphaned Auth account so a retry of this same row can create it
          // cleanly instead of hitting auth/email-already-exists forever (mirrors register/route.ts).
          // Only when we created it: an ADOPTED account predates this import, and a retry will
          // simply adopt it again, so deleting it would destroy state we merely borrowed.
          if (!adoptedAuth) await auth.deleteUser(uid).catch(() => { /* best effort */ });
          throw e;
        }
        results.push({ id: rowId, status: 'created', password: initialPassword });
      } catch (e: unknown) {
        console.error('[users/bulk-import] row failed:', rowId, e);
        const message = (e as Error)?.message || 'Failed to save';
        results.push({ id: rowId, status: 'error', message });
      }
    }

    return NextResponse.json({ results });
  } catch (e) {
    console.error('[users/bulk-import]', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
