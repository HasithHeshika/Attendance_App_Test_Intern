'use client';
// Durable per-user avatar cache (keyed by email, which is stable across every login
// method). Google/Microsoft hand us a `photoURL` only on an OAuth sign-in; we stash it
// here so the picture still shows when the same person later signs in with a JWT /
// username-password (which carries no photo). Refreshed whenever a newer photo arrives.
//
// We only cache lightweight remote URLs (http/https) — never giant `data:` URLs, which
// are already persisted server-side as the uploaded avatar and would bloat localStorage.

import { auth } from '@/lib/firebase';

const sameEmail = (a?: string | null, b?: string | null): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The live Google/Microsoft `photoURL` — but ONLY when the Firebase session belongs to
 * the SAME identity as `email`. This is the privacy guard for the ID card / profile:
 * `auth.currentUser` is a browser-global session that can outlive a logout or belong to a
 * different person than the app user (shared device, or a Firebase email that differs from
 * the profile email). Never adopt that photo for someone else — return undefined instead.
 */
export function liveOAuthPhotoForEmail(email?: string | null): string | undefined {
  const cu = auth.currentUser;
  if (!cu?.photoURL) return undefined;
  return sameEmail(cu.email, email) ? cu.photoURL : undefined;
}

// Hostnames that only ever serve an OAuth provider's *personal* profile photo. A URL on one
// of these can never be an uploaded company/employee avatar, so it's safe to scrub when it
// can't be tied to the current identity.
function isOAuthPhotoHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.endsWith('.googleusercontent.com')
      || h === 'graph.microsoft.com'
      || h.endsWith('.msftauth.net')
      || h === 'www.gravatar.com'
      || h === 's.gravatar.com';
  } catch { return false; }
}

/**
 * True when `url` is an OAuth provider personal photo that does NOT belong to the current
 * Firebase session for `email`. Lets us scrub a foreign OAuth photo a previous build may have
 * persisted onto a user even when the authoritative profile can't be loaded (offline) — while
 * leaving uploaded avatars (Firebase Storage / data: URLs) untouched.
 */
export function isForeignOAuthPhoto(url?: string | null, email?: string | null): boolean {
  if (!url || !isOAuthPhotoHost(url)) return false;
  return liveOAuthPhotoForEmail(email) !== url;
}

const KEY = (email: string) => `pc-avatar:${email.trim().toLowerCase()}`;

export function cacheAvatar(email?: string | null, url?: string | null): void {
  if (typeof window === 'undefined' || !email || !url) return;
  if (!/^https?:\/\//i.test(url)) return; // skip data: URLs and blanks
  try {
    if (localStorage.getItem(KEY(email)) !== url) localStorage.setItem(KEY(email), url);
  } catch { /* quota / private mode — non-critical */ }
}

export function getCachedAvatar(email?: string | null): string | undefined {
  if (typeof window === 'undefined' || !email) return undefined;
  try { return localStorage.getItem(KEY(email)) ?? undefined; }
  catch { return undefined; }
}

/**
 * Scope a profile-picture URL to the current user so the browser/SW/proxy can never serve a
 * *different* (or stale) person's cached image for it. Appends a per-user marker (ignored by
 * image hosts) so switching users forces a fresh fetch of the right picture. data:/blob: URLs
 * (local previews/uploads) are returned untouched.
 */
export function userScopedAvatar(url?: string | null, key?: string | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}_pc=${encodeURIComponent(key ?? 'u')}`;
}
