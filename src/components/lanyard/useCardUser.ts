'use client';
import { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/authStore';
import { getCachedAvatar, liveOAuthPhotoForEmail } from '@/lib/avatarCache';
import { getCompanies } from '@/services/companyService';
import type { CardUser } from './idCardCanvas';

// Build the CardUser the lanyard renders from: the auth user, the live
// Google/Microsoft photo (when no avatar is stored yet), and the company logo
// resolved from the companies registry (matched by id, then name).
export function useCardUser(): CardUser | null {
  const user = useAuthStore(s => s.user);
  const [logo, setLogo] = useState<string | null>(null);
  const [accent, setAccent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user) { setLogo(null); setAccent(null); return; }
      try {
        const companies = await getCompanies();
        const match = companies.find(
          c => (user.company_id && c.id === user.company_id) || (user.company && c.name === user.company)
        );
        const rawLogo = match?.logo_url || null;

        // Collect ALL possible personal-photo URLs for this user so we can reject
        // any of them if they accidentally ended up stored as the company logo.
        const personalUrls = new Set<string>(
          [
            user.avatar,
            liveOAuthPhotoForEmail(user.email),
            getCachedAvatar(user.email),
          ].filter((u): u is string => !!u)
        );

        const safeLogo =
          rawLogo && !isPersonalPhotoUrl(rawLogo, personalUrls)
            ? rawLogo
            : null;

        if (!cancelled) { setLogo(safeLogo); setAccent(match?.accent_color || null); }
      } catch {
        if (!cancelled) { setLogo(null); setAccent(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  if (!user) return null;

  // Only ever the current user's own picture: their stored avatar, the live OAuth photo
  // when the Firebase session is the SAME identity, else their email-keyed cached photo.
  // Never the browser-global `auth.currentUser.photoURL` of a different/previous person.
  const resolvedAvatar =
    user.avatar ?? liveOAuthPhotoForEmail(user.email) ?? getCachedAvatar(user.email) ?? undefined;

  return {
    name:          user.name,
    email:         user.email,
    role:          user.role,
    designation:   user.designation,
    epf_number:    user.epf_number,
    company:       user.company,
    avatar:        resolvedAvatar,
    employee_type: user.employee_type,
    department:    user.department,
    companyLogo:   logo,
    accentColor:   accent,
  };
}

/**
 * Returns true when `url` is a personal-photo URL and must NOT be used as a
 * company logo. Checks (in order):
 *
 *  1. Direct match against any known personal-photo URL for this user.
 *  2. Domain is a known personal-photo CDN.
 *  3. Firebase Storage path looks like a user-avatar upload (checks both the
 *     raw pathname and the URL-decoded version to handle %2F-encoded paths).
 */
function isPersonalPhotoUrl(url: string, personalUrls: Set<string>): boolean {
  // 1. Exact match against the current user's own avatar sources.
  if (personalUrls.has(url)) return true;

  // Normalise: strip query params for domain/path checks.
  let hostname = '';
  let rawPath = '';
  let decodedPath = '';
  try {
    const parsed = new URL(url);
    hostname    = parsed.hostname.toLowerCase();
    rawPath     = parsed.pathname;
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return false; // malformed URL — let it through
  }

  // 2. Known personal-photo CDN domains.
  if (
    hostname.endsWith('.googleusercontent.com') || // Google OAuth photos
    hostname === 'graph.microsoft.com' ||           // Microsoft profile photos
    hostname.endsWith('.msftauth.net') ||
    hostname === 'www.gravatar.com' ||
    hostname === 's.gravatar.com'
  ) return true;

  // 3. Firebase Storage — but only paths that look like user avatar uploads.
  //    We check BOTH raw and decoded paths because Firebase Storage URLs use
  //    %2F to encode slashes inside the object key, e.g.:
  //    /v0/b/project.appspot.com/o/avatars%2Fuid%2Favatar.jpg?alt=media
  if (hostname === 'firebasestorage.googleapis.com') {
    const pathsToCheck = [rawPath, decodedPath];
    const avatarSegments = ['/avatars/', '/users/', '/profile/', '/profilePictures/', '/userPhotos/'];
    for (const p of pathsToCheck) {
      if (avatarSegments.some(seg => p.includes(seg))) return true;
    }
  }

  return false;
}
