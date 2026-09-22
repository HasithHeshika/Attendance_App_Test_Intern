'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import toast from 'react-hot-toast';
import { auth } from '@/lib/firebase';
import { getUserByUid, bootstrapAdminProfile, isBootstrapAdminEmail } from '@/services/userService';
import { useAuthStore, type User, type UserRole } from '@/store/authStore';
import { useRolesStore } from '@/store/rolesStore';
import { resolveUserCapabilities, type Role } from '@/lib/permissions';
import { cacheAvatar, getCachedAvatar, liveOAuthPhotoForEmail, isForeignOAuthPhoto } from '@/lib/avatarCache';
import { clearStaleCachesForNewVersion, userProfileNeedsRebuild, markUserProfileRebuilt } from '@/lib/versionReset';
import type { AppUser } from '@/lib/types';

// Map Firestore AppUser → the User shape the pages all depend on.
// Capabilities are resolved from the roles registry and denormalized onto the user
// so gating stays synchronous everywhere.
export function firestoreToUser(u: AppUser, roles?: Role[]): User {
  return {
    name:          u.display_name || `${u.first_name} ${u.last_name}`.trim(),
    email:         u.email,
    role:          (u.role as UserRole) ?? 'Technician',
    capabilities:  resolveUserCapabilities(u, roles),
    epf_number:    u.epf_number,
    designation:   u.designation,
    department:    u.department,
    phone:         u.phone_personal,
    avatar:        u.avatar_url ?? undefined,
    company:       u.company_name,
    company_id:    u.company_id,
    employee_type: u.employee_type,
    is_shift_worker: u.is_shift_worker ?? false,
    hod_department_ids: u.hod_department_ids ?? [],
    hod_department_names: u.hod_department_names ?? [],
    is_super_admin: u.is_super_admin ?? false,
    date_of_birth: u.date_of_birth ?? null,
    attendance_methods: u.attendance_methods ?? [],
  };
}

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, user, _hasHydrated, setAuth, logout, setHasHydrated, updateUser } = useAuthStore();
  const started = useRef(false);
  // `_hasHydrated` only means zustand finished reading localStorage — it says NOTHING about
  // Firebase Auth. Rendering children on that alone let pages mount and fire Firestore reads
  // while `auth.currentUser` was still null, so the rules saw `request.auth == null` and
  // returned permission-denied on a perfectly valid session (the calendar's 31 day reads were
  // the visible casualty). Children now also wait for the FIRST onAuthStateChanged callback,
  // which is the point Firebase has actually settled signed-in-or-out.
  const [authResolved, setAuthResolved] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    // A new build was just deployed → wipe caches from the old build (service-worker
    // precache + re-fetchable data caches) once, so stale assets/shapes can't crash the
    // new code. Fire-and-forget; the auth flow below rebuilds the user profile in place.
    void clearStaleCachesForNewVersion();

    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      // Firebase has settled either way — from here a Firestore read carries a real token (or is
      // legitimately anonymous). Set before the branches below so an early return still releases
      // the gate; a stuck flag would leave the whole app on the spinner.
      setAuthResolved(true);
      if (!firebaseUser) {
        if (isAuthenticated) logout();
        setHasHydrated(true);
        return;
      }

      // A cached Firebase user is NOT proof of a usable session. If the account was deleted or
      // disabled, or its refresh token was revoked, `onAuthStateChanged` still hands back the
      // user restored from IndexedDB while every Firestore read fails permission-denied — the
      // app then renders a fully authenticated shell in which nothing loads. Force a token
      // refresh here so a dead session is caught once, up front, and ends as a clean sign-out
      // instead of a page of errors.
      try {
        // Refresh the capability claims BEFORE the forced refresh below, so the new token
        // carries them. firestore.rules resolves every admin / approver / payroll permission
        // from these claims (see src/lib/authClaims.ts) — a token without them can do little
        // more than read. Best-effort: a failure here must never block sign-in, since the
        // token simply keeps whatever claims it already had, but it IS logged, because a
        // persistent failure looks from the outside exactly like "the admin lost access".
        try {
          const currentToken = await firebaseUser.getIdToken();
          await fetch('/api/auth/claims', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken: currentToken }),
          });
        } catch (e) {
          console.warn('[auth] capability claim sync failed; keeping existing token claims.', e);
        }
        await firebaseUser.getIdToken(true);
      } catch (e) {
        console.error('[auth] session is no longer valid — signing out.', e);
        try { await signOut(auth); } catch { /* already gone */ }
        logout();
        setHasHydrated(true);
        toast.error('Your session has expired. Please sign in again.');
        router.replace('/login');
        return;
      }

      // Capture the Google/Microsoft profile photo (present only on an OAuth sign-in) and
      // cache it by THIS Firebase identity's email, so it still shows after a later
      // password/JWT login by the same person. The photo is adopted onto a profile later,
      // but only when the profile's email matches this identity (see ownPhotoFor below) —
      // never a different/previous person's browser-global photo.
      cacheAvatar(firebaseUser.email, firebaseUser.photoURL);
      const ownPhotoFor = (email?: string | null) =>
        liveOAuthPhotoForEmail(email) ?? getCachedAvatar(email);

      // Make sure the roles registry is loaded so capabilities can be resolved.
      await useRolesStore.getState().loadRoles();
      let roles = useRolesStore.getState().roles;

      // Ensure the bootstrap admin always has a persisted System Admin record, even
      // for already-authenticated sessions — so it shows up in the Users list.
      if (isBootstrapAdminEmail(firebaseUser.email)) {
        await bootstrapAdminProfile(firebaseUser.uid, firebaseUser.email).catch(() => null);
      }

      // If a System Admin signs in and the registry is empty, seed it automatically
      // so roles/permissions work without a manual "Initialize defaults" first.
      const probe = resolveUserCapabilities(user, roles);
      if (roles.length === 0 && probe.is_system_admin) {
        try {
          const { seedDefaultRolesIfEmpty } = await import('@/services/roleService');
          await seedDefaultRolesIfEmpty();
          await useRolesStore.getState().loadRoles(true);
          roles = useRolesStore.getState().roles;
        } catch { /* rules may block; manual seed still available */ }
      }

      // Firebase session exists and Zustand already has this user — keep the
      // denormalized capabilities fresh (handles stale/legacy-role sessions), and
      // refresh the shift-worker flag so admin changes show without a re-login.
      if (isAuthenticated && user) {
        const patch: Partial<User> = {};
        // When we can't load the authoritative profile (offline / Firestore error / no doc),
        // we still must not show a previous person's OAuth photo that an older build may have
        // persisted: fill an empty avatar with a same-identity photo, else scrub a foreign
        // OAuth photo to initials. Uploaded avatars are left intact.
        const reconcileWithoutProfile = () => {
          if (!user.avatar) {
            const ownPhoto = ownPhotoFor(user.email);
            if (ownPhoto) patch.avatar = ownPhoto;
          } else if (isForeignOAuthPhoto(user.avatar, user.email)) {
            patch.avatar = undefined;
          }
        };
        // Declared outside the try so the capabilities recompute below can see whichever
        // profile (or none) was actually fetched.
        let profile: Awaited<ReturnType<typeof getUserByUid>> = null;
        try {
          profile = await getUserByUid(firebaseUser.uid);
          if (profile) {
            // A new app version shipped since this device last built its user profile. The
            // partial refresh below only touches a few fields, so any user field the new build
            // newly relies on (employee_type, company_id, a renamed role, …) would stay stale
            // until a manual logout/login — the "can't check in after an update" bug. Rebuild
            // the WHOLE profile from Firestore once per new version: a re-login without signing
            // out. Only mark it done on success, so an offline/failed read retries next load.
            if (userProfileNeedsRebuild()) {
              const rebuilt = firestoreToUser(profile, roles);
              if (!rebuilt.avatar) rebuilt.avatar = ownPhotoFor(profile.email) ?? undefined;
              cacheAvatar(profile.email, rebuilt.avatar);
              setAuth(rebuilt);
              markUserProfileRebuilt();
              setHasHydrated(true);
              return;
            }
            if (!!profile.is_shift_worker !== !!user.is_shift_worker) {
              patch.is_shift_worker = !!profile.is_shift_worker;
            }
            // Same treatment for hod_department_ids — an admin changing a HOD's assigned
            // departments (see the Users page) should gate/restore Schedule/Shifts access
            // without a re-login.
            const freshHodDepts = profile.hod_department_ids ?? [];
            if (JSON.stringify(freshHodDepts) !== JSON.stringify(user.hod_department_ids ?? [])) {
              patch.hod_department_ids = freshHodDepts;
            }
            const freshHodDeptNames = profile.hod_department_names ?? [];
            if (JSON.stringify(freshHodDeptNames) !== JSON.stringify(user.hod_department_names ?? [])) {
              patch.hod_department_names = freshHodDeptNames;
            }
            // ...and department itself, since a HOD's Schedule access is locked to it.
            if ((profile.department ?? '') !== (user.department ?? '')) {
              patch.department = profile.department ?? '';
            }
            // Same treatment for is_super_admin — an admin granting/revoking the Super Admin
            // override (see the Users page) should take effect without a re-login.
            if (!!profile.is_super_admin !== !!user.is_super_admin) {
              patch.is_super_admin = !!profile.is_super_admin;
            }
            // Same treatment for attendance_methods — an admin flipping this (see the Users
            // page) should gate/restore mobile check-in/out without a re-login.
            const freshMethods = profile.attendance_methods ?? [];
            if (JSON.stringify(freshMethods) !== JSON.stringify(user.attendance_methods ?? [])) {
              patch.attendance_methods = freshMethods;
            }
            // Keep DOB fresh so the birthday wish works on sessions predating this field.
            if ((profile.date_of_birth ?? null) !== (user.date_of_birth ?? null)) {
              patch.date_of_birth = profile.date_of_birth ?? null;
            }
            // Self-heal the avatar: the Firestore avatar_url is authoritative. Anything else
            // (incl. a foreign photo persisted by an older build) is replaced by the stored
            // avatar, or a same-identity OAuth/cached photo, or cleared to initials.
            const authoritative = profile.avatar_url ?? ownPhotoFor(profile.email) ?? undefined;
            if (authoritative !== user.avatar) patch.avatar = authoritative;
          } else {
            reconcileWithoutProfile();
          }
        } catch {
          reconcileWithoutProfile();
        }
        // Recompute capabilities AFTER the profile fetch above (not before) so a same-tick
        // is_super_admin grant/revoke (patched just above) is reflected immediately — computing
        // this from the pre-fetch `user` used to leave a granted Super Admin's nav/pages stale
        // until a SECOND reload, since patch.is_super_admin and patch.capabilities disagreed for
        // one tick. Also still catches plain capability-toggle changes to the current role.
        const fresh = resolveUserCapabilities(
          { role: user.role, employee_type: user.employee_type, is_super_admin: profile ? !!profile.is_super_admin : !!user.is_super_admin },
          roles,
        );
        if (JSON.stringify(fresh) !== JSON.stringify(user.capabilities)) patch.capabilities = fresh;
        if (Object.keys(patch).length) updateUser(patch);
        setHasHydrated(true);
        return;
      }

      // Load Firestore profile
      try {
        let profile = await getUserByUid(firebaseUser.uid);
        // Break-glass: the bootstrap email becomes System Admin even with no record.
        if (!profile) profile = await bootstrapAdminProfile(firebaseUser.uid, firebaseUser.email);
        const resigned = profile?.date_of_resign && profile.date_of_resign <= new Date().toISOString().slice(0, 10);
        if (!profile || profile.is_active === false || resigned) {
          logout();
          setHasHydrated(true);
          return;
        }
        const su = firestoreToUser(profile, roles);
        // Stored avatar wins (uploaded picture or a previously-saved photo); otherwise use
        // the OAuth/cached photo for THIS profile's email only — so every login method shows
        // a picture, but never an unrelated identity's.
        if (!su.avatar) su.avatar = ownPhotoFor(profile.email) ?? undefined;
        cacheAvatar(profile.email, su.avatar); // keep the cache fresh (remote URLs only)
        setAuth(su);
        // A fresh login already builds the profile from Firestore with the current build's
        // mapping — record the version so the returning-session rebuild doesn't redo it.
        markUserProfileRebuilt();
        setHasHydrated(true);
      } catch {
        logout();
        setHasHydrated(true);
      }
    });

    return () => unsub();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!_hasHydrated || !authResolved) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3">
        <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        <p className="text-xs text-muted-foreground font-medium tracking-widest uppercase">
          Loading…
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
