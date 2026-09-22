'use client';
import { useEffect, useState } from 'react';
import { onIdTokenChanged } from 'firebase/auth';
import { auth } from '@/lib/firebase';

/**
 * Should this user be shown the Platform Config button?
 *
 * Read from the `platform_admin` custom claim already inside the ID token the browser holds:
 * no network call, no Firestore read. The alternative — asking a server route "am I a platform
 * admin?" — would have 300+ users each firing a request per session to be told no.
 *
 * PRESENTATION ONLY. The claim decides whether a button renders and nothing else. Every
 * /platform request re-verifies the token and re-checks the platform_admins list server-side
 * (see src/lib/platformAdmins.ts), so a forged or stale claim buys a door that refuses to open.
 *
 * onIdTokenChanged rather than onAuthStateChanged: it also fires when the token is refreshed,
 * so a freshly granted admin picks the button up without a reload.
 */
export function useIsPlatformAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => onIdTokenChanged(auth, async (user) => {
    if (!user) { setIsAdmin(false); return; }
    try {
      // No force-refresh: this reads the token already in hand. A grant revokes refresh
      // tokens, so the next natural refresh picks the change up on its own.
      const { claims } = await user.getIdTokenResult();
      setIsAdmin(claims.platform_admin === true);
    } catch {
      setIsAdmin(false);
    }
  }), []);

  return isAdmin;
}
