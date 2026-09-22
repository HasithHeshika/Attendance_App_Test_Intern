import { NextRequest, NextResponse } from 'next/server';
import { FieldValue, type Firestore, type DocumentData, type DocumentReference } from 'firebase-admin/firestore';
import { adminAuth, adminDbFor, tenantForRequest } from '@/lib/firebaseAdmin';
import { primaryDomain } from '@/lib/tenants';
import { sendServerPush } from '@/lib/serverPush';
import { resolveCapabilities } from '@/lib/permissions';
import { checkRateLimit, clientIp } from '@/lib/rateLimit';
// Plain TS, no client Firebase SDK — safe to import into this Node-runtime route (unlike
// userService.ts, which is why epfDocId/buildNameTokens below are duplicated instead).
import { placeholderEmail } from '@/lib/phone';
import { isValidEmail, isValidNIC, isValidLocalPhone } from '@/lib/validation';

// firebase-admin needs the Node runtime (not edge) — see the same note on
// src/app/api/solar-sso/route.ts / src/app/api/notify/route.ts.
export const runtime = 'nodejs';

// Public self-registration — ONLY for the carecode.org tenant ("southernlanka" in
// src/lib/tenants.ts). The /register page already gates on this client-side (so the page
// itself is dead on every other domain), but a client-side check alone can be bypassed by
// posting straight to this endpoint, so the tenant is re-checked server-side too.
const ALLOWED_TENANT_ID = 'southernlanka';

// ─── Rate limiting ──────────────────────────────────────────────────────────────
// This is the only route in the app an anonymous caller can hit to create real state
// (a Firebase Auth account + Firestore profile), so — unlike every other route here,
// which is gated by an idToken or a shared secret — it needs its own abuse guard (shared
// helper — see src/lib/rateLimit.ts). Keyed by IP, 5 attempts per 15 minutes.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

// Kept in sync with src/services/userService.ts (epfDocId / buildNameTokens) — duplicated
// rather than imported so this server route never pulls in the client Firebase SDK module.
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

// The employee gives ONE formal name string (title + full legal name — e.g.
// "Mr. Ishan Shyamantha Kasthuri Arachchi"), not a first/last split. Everywhere else in
// the app still needs first_name/last_name (avatar initials, search tokens, display
// name), so best-effort derive them: drop a leading honorific, first remaining word is
// first_name, everything after is last_name. Admin can correct these at approval.
const TITLE_RE = /^(mr|mrs|ms|miss|mx|dr|rev|prof)\.?\s*/i;
function splitFullName(full: string): { first: string; last: string } {
  const cleaned = full.trim().replace(TITLE_RE, '').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// Immediately notifies every active user who can act on this (can_manage_users covers
// System Admin too — see resolveCapabilities, is_system_admin implies it) — in-app bell
// + push. Mirrors the 'approvers' recipient-resolution branch in src/app/api/notify/route.ts,
// but runs entirely server-side since nobody is signed into the browser at this point (the
// register flow deliberately never creates a client session — see route.ts's top comment).
// Best-effort: any failure here must never fail the registration response.
async function notifyPendingRegistration(
  db: Firestore, req: NextRequest, actorName: string, actorEpf: string,
): Promise<void> {
  try {
    const rolesSnap = await db.collection('roles').get();
    const roleByName = new Map<string, DocumentData>();
    const candidateNames = new Set<string>();
    rolesSnap.docs.forEach(d => {
      const r = d.data();
      roleByName.set(String(r.name), r);
      if (r.is_system_admin || r.can_manage_users) candidateNames.add(String(r.name));
    });
    if (!candidateNames.size) return;
    const names = [...candidateNames];

    // Dedup by epf_number, not just doc ref — belt-and-suspenders against the same
    // person ever being matched twice across chunked queries.
    const recipientDocs: Array<{ ref: DocumentReference; data: DocumentData }> = [];
    const seenEpf = new Set<string>();
    for (let i = 0; i < names.length; i += 30) {   // Firestore 'in' caps at 30
      const snap = await db.collection('users').where('role', 'in', names.slice(i, i + 30)).get();
      snap.docs.forEach(d => {
        const u = d.data();
        if (u.is_active === false) return;
        const epf = String(u.epf_number ?? '');
        if (!epf || seenEpf.has(epf)) return;
        const caps = resolveCapabilities(roleByName.get(String(u.role)) as never, u.employee_type);
        if (caps.is_system_admin || caps.can_manage_users) {
          seenEpf.add(epf);
          recipientDocs.push({ ref: d.ref, data: u });
        }
      });
    }
    if (!recipientDocs.length) return;

    const title = `${actorName} just registered — pending approval`;
    const body = `Self-registered from ${primaryDomain(tenantForRequest(req))}. Assign an Employee No and role to activate.`;
    const link = '/users';
    const now = FieldValue.serverTimestamp();

    // Deterministic doc id (actor + recipient) instead of add()'s random one, so if this
    // function ever runs twice for the same registration (e.g. a client/network retry of
    // the POST) the second pass overwrites the same doc instead of creating a duplicate
    // notification for the same recipient.
    const eventId = actorEpf.replace(/[^a-zA-Z0-9_-]/g, '_');

    // Write + push PER RECIPIENT, not one shared multicast for everyone. Every recipient
    // has their OWN Firestore doc (each addressed `to_epf`), so each needs the push's
    // `docId` to match THEIR doc specifically — NotificationCenter's foreground-push
    // handler (`onFCMMessage`) reuses `payload.data.docId` to land the push on the same
    // list item as the live Firestore doc it already has; a mismatched/shared docId means
    // it can't find that item and renders a second, un-deduped entry instead. That
    // mismatch (a single event-level tag reused for every recipient) is exactly what
    // caused the reported "2 notifications for the same registration" bug.
    await Promise.all(recipientDocs.map(async ({ ref, data }) => {
      const recipientEpf = String(data.epf_number).replace(/[^a-zA-Z0-9_-]/g, '_');
      const docId = `reg_${eventId}_${recipientEpf}`;
      await db.collection('notifications').doc(docId).set({
        to_epf: String(data.epf_number), audience: null,
        type: 'registration_pending', actor_epf: actorEpf, actor_name: actorName,
        meta: {}, title, body, link, read: false, created_at: now,
      });
      await sendServerPush([{ ref, data }], {
        type: 'registration_pending', title, body, link,
        tag: docId, originUrl: req.nextUrl.origin,
      });
    }));
  } catch (e) {
    console.warn('[register] notifyPendingRegistration failed (non-critical):', e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const tenant = tenantForRequest(req);
    if (tenant.id !== ALLOWED_TENANT_ID) {
      return NextResponse.json({ error: 'Registration is not available on this domain' }, { status: 403 });
    }

    const db = adminDbFor(req);

    const retryAfterMs = await checkRateLimit(
      db, 'register', clientIp(req), RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX,
    );
    if (retryAfterMs > 0) {
      return NextResponse.json(
        { error: 'Too many registration attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } },
      );
    }

    const body = await req.json();
    const fullName = String(body.full_name ?? '').trim();
    const nameWithInitials = String(body.name_with_initials ?? '').trim();
    const nic = String(body.nic ?? '').trim();
    const gender = String(body.gender ?? '').trim();
    // Optional — the employee number an admin assigns at approval is enough to sign in
    // with (see src/lib/phone.ts / /api/resolve-login). Firebase Auth still needs SOME
    // email though, so a skipped one gets a synthesized placeholder (below) nobody ever
    // sees or types.
    const enteredEmail = String(body.email ?? '').trim().toLowerCase();
    const phone = String(body.phone_personal ?? '').trim();
    const guardianContact = String(body.guardian_contact ?? '').trim();
    const address = String(body.address ?? '').trim();
    const password = String(body.password ?? '');

    if (!fullName || !nameWithInitials || !nic || !gender || !phone || !address || !password) {
      return NextResponse.json({ error: 'Please fill in every required field.' }, { status: 400 });
    }
    // Strict format checks — mirror src/lib/validation.ts (and the /register client form) so
    // posting straight to this endpoint can't bypass NIC / email / contact-number rules.
    if (!isValidNIC(nic)) {
      return NextResponse.json(
        { error: 'Enter a valid NIC — 12 digits, or 9 digits followed by V.' },
        { status: 400 },
      );
    }
    if (enteredEmail && !isValidEmail(enteredEmail)) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
    }
    if (!isValidLocalPhone(phone)) {
      return NextResponse.json(
        { error: 'Enter a valid 10-digit contact number, e.g. 0771234567.' },
        { status: 400 },
      );
    }
    if (guardianContact && !isValidLocalPhone(guardianContact)) {
      return NextResponse.json(
        { error: 'Enter a valid 10-digit guardian contact number, e.g. 0771234567.' },
        { status: 400 },
      );
    }
    if (password.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters.' }, { status: 400 });
    }

    const { first, last } = splitFullName(fullName);
    if (!first) {
      return NextResponse.json({ error: 'Enter your full name.' }, { status: 400 });
    }

    const auth = adminAuth();

    if (enteredEmail) {
      const emailOwner = await auth.getUserByEmail(enteredEmail).catch(() => null);
      if (emailOwner) {
        return NextResponse.json(
          { error: 'An account with that email already exists. Try signing in instead.' },
          { status: 409 },
        );
      }
    }
    // A synthesized placeholder is guaranteed unique (random) — no uniqueness check needed.
    const email = enteredEmail || placeholderEmail();

    let uid: string;
    try {
      const created = await auth.createUser({ email, password, emailVerified: false });
      uid = created.uid;
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code ?? '';
      if (code === 'auth/email-already-exists') {
        return NextResponse.json(
          { error: 'An account with that email already exists. Try signing in instead.' },
          { status: 409 },
        );
      }
      if (code === 'auth/invalid-password') {
        return NextResponse.json({ error: 'Password must be at least 6 characters.' }, { status: 400 });
      }
      throw e;
    }

    // No Employee No yet — that's assigned by admin at approval (see userService.reassignEpf),
    // which moves this doc from the placeholder id to the real one. The uid is globally unique
    // so it's safe to use directly, no collision check needed.
    const placeholderEpf = `PENDING-${uid}`;
    const epfRef = db.collection('users').doc(epfDocId(placeholderEpf));

    const now = new Date();
    try {
      // Created inactive — the same `is_active: false` gate already used everywhere else
      // (AuthProvider, login) blocks sign-in until an admin reviews and activates the
      // account from the Users page.
      await epfRef.set({
        uid, epf_number: placeholderEpf, email,
        first_name: first, last_name: last, display_name: `${first} ${last}`.trim() || fullName,
        name_tokens: buildNameTokens(first, last),
        full_name: fullName, name_with_initials: nameWithInitials, gender, guardian_contact: guardianContact,
        role: 'Pending Approval', designation: '', department: '',
        company_id: '', company_name: '',
        employee_type: 'Permanent', supervisor_epf: null,
        phone_personal: phone, phone_office: '', phone_emergency: '',
        address, nic, date_of_birth: null, date_of_join: null, date_of_resign: null,
        insurance: false, blood_type: '', b_card_status: false,
        avatar_url: null, fcm_token: null, is_active: false, awaiting_epf: true,
        created_at: now, updated_at: now,
      });
    } catch (e) {
      // Roll back the orphaned Auth account so the email can be retried cleanly.
      await auth.deleteUser(uid).catch(() => { /* best effort */ });
      throw e;
    }

    // Immediately notify admins — awaited (not fire-and-forget) because a serverless
    // function can be frozen the instant the response is sent, which would silently drop
    // an un-awaited async call. notifyPendingRegistration never throws, so this can't
    // turn a successful registration into an error response.
    await notifyPendingRegistration(db, req, fullName, placeholderEpf);

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('[register]', e);
    return NextResponse.json({ error: 'Registration failed. Please try again.' }, { status: 500 });
  }
}
