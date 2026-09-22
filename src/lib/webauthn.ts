import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';

/**
 * Server-side plumbing for passkey (WebAuthn) sign-in.
 *
 * Everything here runs with the Admin SDK, which bypasses firestore.rules. The two
 * collections it owns (`webauthn_credentials`, `webauthn_challenges`) are therefore denied to
 * the browser outright in the rules — a client that could read `webauthn_challenges` could
 * answer its own challenge, and a client that could WRITE `webauthn_credentials` could
 * register a key against somebody else's uid and sign in as them. Neither collection has any
 * legitimate client read: the API routes are the only door.
 *
 * ── Why the RP ID comes from the live request host ──────────────────────────────────────
 * A WebAuthn credential is bound to a Relying Party ID, which must be the origin's domain or
 * a registrable suffix of it. This deployment serves several domains off ONE Firebase project
 * — the same auth pool, the same uids, only the Firestore database differs (src/lib/tenants.ts).
 * That makes the RP ID the only thing keeping a passkey minted on one organisation's domain
 * from being presented on another's. So it is read from the request that is actually in front
 * of us, stored on the credential, and re-checked on every assertion. Deriving it from
 * `primaryDomain(tenant)` instead would be wrong twice over: a tenant with several registered
 * domains would mint credentials the other domains cannot use, and `tenantForDbId` returns a
 * synthetic tenant with `domains: []` on localhost and preview builds, where primaryDomain
 * degrades to a database id — not a hostname at all.
 */

/** Firestore collection holding one document per enrolled passkey. Server-owned. */
export const CREDENTIALS_COLLECTION = 'webauthn_credentials';
/** Firestore collection holding in-flight, single-use challenges. Server-owned. */
export const CHALLENGES_COLLECTION = 'webauthn_challenges';

/**
 * How long a challenge stays answerable. Short on purpose: the window is the whole attack
 * surface for a replay, and a person who has already tapped "Sign in with passkey" answers
 * the prompt in seconds. The browser's own `timeout` in the options is advisory and is not
 * what enforces this — this is.
 */
export const CHALLENGE_TTL_MS = 3 * 60 * 1000;

/** Cap on passkeys per account. Enough for phone + laptop + tablet + a spare, not unbounded. */
export const MAX_CREDENTIALS_PER_USER = 10;

export type ChallengeKind = 'registration' | 'authentication';

/** One enrolled passkey, as stored. Doc id is `credential_id`. */
export interface StoredCredential {
  /** Base64URL credential id, as WebAuthn hands it back. Also the Firestore doc id. */
  credential_id: string;
  /** COSE public key, base64url. Verified against, never sent to a client. */
  public_key: string;
  /** Signature counter. Cloned-authenticator detection; many passkeys always report 0. */
  counter: number;
  transports: string[];
  /** Firebase Auth uid this credential signs in as. The whole point of the record. */
  uid: string;
  /** EPF number, denormalised so the device list can be rendered without a users lookup. */
  epf_number: string;
  /** RP ID this credential was minted under — re-checked on every assertion. */
  rp_id: string;
  /** What the person chose to call this device, or a guess from the user agent. */
  label: string;
  /**
   * FingerprintJS visitorId of the browser that enrolled it, if one was obtained. A LABEL,
   * never a check: its confidence is 0.3 on iOS/iPadOS and 0.4 on Android (the library's own
   * getOpenConfidenceScore), so identical company phones collide. Used to say "your iPhone"
   * instead of showing a base64 blob. Nothing is ever granted or denied on it.
   */
  visitor_id: string | null;
  /** True for a synced passkey (iCloud Keychain, Google Password Manager). Display only. */
  backed_up: boolean;
  aaguid: string;
  created_at: Timestamp;
  last_used_at: Timestamp | null;
}

/** What the profile page is allowed to see. Never includes the public key or the counter. */
export interface CredentialSummary {
  id: string;
  label: string;
  rp_id: string;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
}

/**
 * The RP ID for this request: the host, lowercased, port and any trailing dot removed.
 *
 * `x-forwarded-host` first because Netlify sets it and `host` is then the internal name.
 * Returns null when there is no host header at all, which no real browser request lacks —
 * callers must fail closed rather than substitute a default, since a wrong RP ID would mint
 * credentials nobody can ever use.
 */
export function rpIdFromRequest(req: { headers: Headers }): string | null {
  const raw = req.headers.get('x-forwarded-host') || req.headers.get('host');
  if (!raw) return null;
  // A forwarded-host list ("a.example, b.example") means a proxy chain appended to it; the
  // first entry is the one the browser actually addressed.
  const first = raw.split(',')[0].trim().toLowerCase();
  const host = first.replace(/:\d+$/, '').replace(/\.$/, '');
  return host || null;
}

/**
 * The origin the assertion must have come from: scheme + host + port, exactly as the browser
 * reports it in clientDataJSON. Unlike the RP ID the PORT stays, because `http://localhost:3000`
 * and `http://localhost` are different origins to a browser and dev runs on the former.
 */
export function expectedOriginFromRequest(req: { headers: Headers }): string | null {
  const raw = req.headers.get('x-forwarded-host') || req.headers.get('host');
  if (!raw) return null;
  const host = raw.split(',')[0].trim().toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  const proto = (req.headers.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  // Only localhost may be http — WebAuthn's secure-context carve-out. Everywhere else assume
  // https even when a misconfigured proxy omits the header, because accepting an http origin
  // on a real domain would accept a stripped connection.
  const bare = host.replace(/:\d+$/, '');
  const isLocal = bare === 'localhost' || bare === '127.0.0.1';
  const scheme = isLocal && proto !== 'https' ? 'http' : 'https';
  return `${scheme}://${host}`;
}

/**
 * Store a challenge and return its handle. The handle travels to the browser and back; the
 * challenge itself is never trusted from the client, which is what makes this a server-side
 * challenge rather than a decorative one.
 */
export async function putChallenge(
  db: Firestore,
  kind: ChallengeKind,
  challenge: string,
  rpId: string,
  uid: string | null,
): Promise<string> {
  const handle = randomUUID();
  await db.collection(CHALLENGES_COLLECTION).doc(handle).set({
    kind,
    challenge,
    rp_id: rpId,
    uid,
    created_at: FieldValue.serverTimestamp(),
    expires_at: Timestamp.fromMillis(Date.now() + CHALLENGE_TTL_MS),
  });
  return handle;
}

/**
 * Redeem a challenge — read it, delete it, and only then decide whether it was valid.
 *
 * Deleting BEFORE the verdict is deliberate: a challenge is single-use, and if the delete
 * only happened on success then a failed assertion would leave it answerable again. Returns
 * null for missing, expired, wrong-kind, wrong-RP-ID or wrong-uid, all indistinguishable to
 * the caller so a probe learns nothing about which handles exist.
 */
export async function takeChallenge(
  db: Firestore,
  handle: unknown,
  kind: ChallengeKind,
  rpId: string,
  uid: string | null,
): Promise<string | null> {
  if (typeof handle !== 'string' || !handle || handle.includes('/')) return null;
  const ref = db.collection(CHALLENGES_COLLECTION).doc(handle);
  const snap = await ref.get();
  if (!snap.exists) return null;
  await ref.delete().catch(() => { /* best effort: the verdict below is what matters */ });

  const d = snap.data() ?? {};
  if (d.kind !== kind) return null;
  if (d.rp_id !== rpId) return null;
  if (uid !== null && d.uid !== uid) return null;
  const expires = d.expires_at instanceof Timestamp ? d.expires_at.toMillis() : 0;
  if (!expires || expires < Date.now()) return null;
  return typeof d.challenge === 'string' && d.challenge ? d.challenge : null;
}

/**
 * Sweep expired challenges. Called opportunistically from the options routes rather than on a
 * cron, because the collection only grows when someone starts a sign-in and abandons it —
 * a few documents a day, not a workload. Failures are swallowed: a stale challenge is
 * already unusable (takeChallenge checks expiry), so this is tidiness, not security.
 */
export async function sweepExpiredChallenges(db: Firestore): Promise<void> {
  try {
    const stale = await db.collection(CHALLENGES_COLLECTION)
      .where('expires_at', '<', Timestamp.now())
      .limit(50)
      .get();
    if (stale.empty) return;
    const batch = db.batch();
    stale.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  } catch { /* tidiness only */ }
}

/** Every credential enrolled by this uid under this RP ID. */
export async function credentialsForUid(
  db: Firestore,
  uid: string,
  rpId: string,
): Promise<StoredCredential[]> {
  const snap = await db.collection(CREDENTIALS_COLLECTION)
    .where('uid', '==', uid)
    .where('rp_id', '==', rpId)
    .get();
  return snap.docs.map(d => d.data() as StoredCredential);
}

/** One credential by its id, or null. The RP ID is checked by the caller against the request. */
export async function credentialById(
  db: Firestore,
  credentialId: string,
): Promise<StoredCredential | null> {
  if (!credentialId || credentialId.includes('/')) return null;
  const snap = await db.collection(CREDENTIALS_COLLECTION).doc(credentialId).get();
  return snap.exists ? (snap.data() as StoredCredential) : null;
}

/** Strip a stored credential down to what a browser may see. */
export function toSummary(c: StoredCredential): CredentialSummary {
  return {
    id: c.credential_id,
    label: c.label,
    rp_id: c.rp_id,
    backed_up: c.backed_up === true,
    created_at: c.created_at instanceof Timestamp ? c.created_at.toDate().toISOString() : '',
    last_used_at: c.last_used_at instanceof Timestamp ? c.last_used_at.toDate().toISOString() : null,
  };
}

/**
 * A readable device name from a user agent, for when the person doesn't supply one.
 * Coarse on purpose — "iPhone" and "Android" are what a person recognises in a device list;
 * a version string is noise they cannot act on. iPadOS 13+ reports a Macintosh UA, so an
 * iPad signs in as "Mac" here; the client sends its own label when it can tell the difference.
 */
export function deviceLabelFromUserAgent(ua: string | null): string {
  const s = (ua ?? '').toLowerCase();
  if (!s) return 'Unknown device';
  if (s.includes('ipad')) return 'iPad';
  if (s.includes('iphone')) return 'iPhone';
  if (s.includes('android')) return 'Android device';
  if (s.includes('macintosh') || s.includes('mac os')) return 'Mac';
  if (s.includes('windows')) return 'Windows PC';
  if (s.includes('linux')) return 'Linux PC';
  return 'Unknown device';
}

/** Trim and cap a user-supplied device label. Empty becomes null so the caller can fall back. */
export function sanitiseLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/\p{C}/gu, '').trim().slice(0, 40);
  return clean || null;
}

/**
 * Accept a FingerprintJS visitorId only if it looks like one. Never a security check — see
 * the note on StoredCredential.visitor_id — just a guard against an oversized or oddly shaped
 * value being written into a document the admin console has to render.
 */
export function sanitiseVisitorId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return /^[a-zA-Z0-9]{8,64}$/.test(raw) ? raw : null;
}
