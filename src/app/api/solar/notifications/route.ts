import { NextRequest, NextResponse } from 'next/server';
import { adminAuth, adminDbFor } from '@/lib/firebaseAdmin';
import { getSolarNotifications } from '@/lib/solarApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// uid → resolved identity, cached in-instance. Identity (epf/email/phone) changes
// ~never, but this route runs for every poll of every user — the per-poll Firestore
// users query was the single biggest read amplifier at 300+ users.
const identityCache = new Map<string, { epf?: string; email?: string; phone?: string; at: number }>();
const IDENTITY_TTL_MS = 10 * 60_000;

/**
 * Per-user Solar notifications proxy. The browser POSTs the caller's Firebase ID
 * token; we verify it, resolve their identity (EPF → email → phone) from the
 * authoritative Firestore profile, then fetch ONLY that user's notifications from
 * Solar with the server-held EXTERNAL_API_KEY. The key never reaches the client,
 * and a user can never request someone else's notifications.
 */
export async function POST(req: NextRequest) {
  try {
    const reqBody = await req.json().catch(() => ({}));
    const { idToken, since } = reqBody;

    // When Firebase Admin creds are configured we derive the user's identity from the
    // verified token (authoritative). In development without those creds, we fall back
    // to the client-supplied identity for the user's OWN notifications. Production with
    // no creds returns nothing rather than trusting the client.
    const adminConfigured = !!(
      process.env.FIREBASE_ADMIN_PROJECT_ID &&
      process.env.FIREBASE_ADMIN_CLIENT_EMAIL &&
      process.env.FIREBASE_ADMIN_PRIVATE_KEY
    );

    let epf: string | undefined;
    let email: string | undefined;
    let phone: string | undefined;

    if (adminConfigured) {
      if (!idToken) return NextResponse.json({ error: 'Missing idToken' }, { status: 400 });
      let uid: string;
      let tokenEmail: string | undefined;
      try {
        const decoded = await adminAuth().verifyIdToken(idToken);
        uid = decoded.uid;
        tokenEmail = decoded.email ?? undefined;
      } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const cached = identityCache.get(uid);
      if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) {
        ({ epf, email, phone } = cached);
      } else {
        const snap = await adminDbFor(req).collection('users').where('uid', '==', uid).limit(1).get();
        const u = snap.empty ? null : snap.docs[0].data();
        epf   = u?.epf_number != null ? String(u.epf_number) : undefined;
        email = u?.email ?? tokenEmail ?? undefined;
        phone = u?.phone_personal ?? undefined;
        identityCache.set(uid, { epf, email, phone, at: Date.now() });
      }
    } else if (process.env.NODE_ENV !== 'production') {
      epf   = reqBody.epf   || undefined;
      email = reqBody.email || undefined;
      phone = reqBody.phone || undefined;
    } else {
      return NextResponse.json({ success: false, matched: false, count: 0, unread: 0, data: [] });
    }

    if (!epf && !email && !phone) {
      return NextResponse.json({ success: true, matched: false, count: 0, unread: 0, data: [] });
    }

    const result = await getSolarNotifications({ epf, email, phone, since, limit: 50 });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // Solar unreachable / not configured — degrade gracefully (no Solar notifications).
    return NextResponse.json({ success: false, matched: false, count: 0, unread: 0, data: [] }, { status: 200 });
  }
}
