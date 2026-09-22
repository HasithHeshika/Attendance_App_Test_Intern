'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { useMaintenanceUiStore } from '@/store/maintenanceUiStore';
import { subscribeMaintenanceDoc } from '@/services/maintenanceService';
import { deriveMaintenancePhase, type MaintenanceDoc } from '@/lib/maintenance';
import {
  hasAdminBypassFlag, hasReadonlyBypassFlag, setAdminBypass, setReadonlyBypass,
} from '@/lib/maintenanceBypass';
import MaintenanceBanner from './MaintenanceBanner';
import MaintenanceOverlay from './MaintenanceOverlay';
import MaintenanceDetailsPopup from './MaintenanceDetailsPopup';
import MaintenanceControlPopup from './MaintenanceControlPopup';

// Sha-256 hex of the console-arming password. Only the hash ships in the bundle — the plaintext
// is never sent anywhere and never stored. To change the password, hash a new one (e.g. in a
// browser console: `crypto.subtle.digest('SHA-256', new TextEncoder().encode('<new password>'))`
// → hex-encode the resulting bytes) and swap the constant below.
//
// This password is convenience, not security — it just saves a signed-in admin from digging
// through the UI. The real gate is the live role check below (and, server-side, whatever
// firestore.rules currently enforces for settings/* writes — see the posture note there).
const PASSWORD_HASH_HEX = 'd4990cdd8cb1ac6e5889c37b2928e6356d4e2808faed65d4028e6f913ea0b230';

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Auth screens are never hard-blocked — admins must always be able to sign in to manage the
// window. This app has no /pending route (checked at build time of this feature); if one is
// added later, list it here too.
const NEVER_BLOCK_PATHS = new Set(['/login']);

// Mounted once, app-wide, in the root layout (src/app/layout.tsx) — alongside NetworkStatus /
// AppToaster / LanyardOverlay. Registers window.maintenance(password) and renders whichever of
// the banner / full-screen overlay / popups the CURRENT phase calls for.
export default function MaintenanceGate() {
  const pathname = usePathname();
  const user = useAuthStore(s => s.user);
  const caps = useUserCapabilities();
  const isAdmin = caps.is_system_admin;

  // window.maintenance() runs outside React's render cycle, so it reads role/pathname through
  // refs kept in sync on every render — never a value captured once at mount.
  const isAdminRef = useRef(isAdmin);
  isAdminRef.current = isAdmin;
  const roleRef = useRef(user?.role ?? '(signed out)');
  roleRef.current = user?.role ?? '(signed out)';

  const { controlPopupOpen, openControlPopup, closeControlPopup } = useMaintenanceUiStore();
  const [doc, setDoc] = useState<MaintenanceDoc | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Bumped after setAdminBypass/setReadonlyBypass to force a re-read of sessionStorage — those
  // writes aren't themselves reactive.
  const [bypassTick, setBypassTick] = useState(0);

  useEffect(() => subscribeMaintenanceDoc(setDoc), []);

  useEffect(() => {
    const w = window as unknown as { maintenance?: (password: string) => Promise<void> };
    w.maintenance = async (password: string) => {
      const hash = await sha256Hex(String(password ?? ''));
      const hashOk = hash === PASSWORD_HASH_HEX;
      const adminOk = isAdminRef.current;
      if (hashOk && adminOk) {
        openControlPopup();
        // eslint-disable-next-line no-console
        console.log('%c[maintenance] control panel opened.', 'color:#16a34a;font-weight:bold;');
        return;
      }
      const reasons: string[] = [];
      if (!hashOk) reasons.push('wrong password');
      if (!adminOk) reasons.push(`current role "${roleRef.current}" is not an admin`);
      // eslint-disable-next-line no-console
      console.error(
        `%c[maintenance] access denied — ${reasons.join(' and ')}.`,
        'color:#fff;background:#dc2626;font-weight:bold;padding:2px 6px;border-radius:3px;',
      );
    };
    return () => { delete (window as unknown as { maintenance?: unknown }).maintenance; };
  }, [openControlPopup]);

  const phase = deriveMaintenancePhase(doc, nowMs);

  // Tick once a second ONLY while a countdown is actually on screen — nothing runs in the
  // background on every other page for no reason.
  useEffect(() => {
    if (phase !== 'scheduled' && phase !== 'active') return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

  if (!doc || (phase !== 'scheduled' && phase !== 'active')) {
    // Still render the control popup — an admin can open it via the console command even with
    // nothing currently armed (e.g. to schedule a fresh window).
    return (
      <MaintenanceControlPopup doc={null} open={controlPopupOpen} onOpenChange={o => (o ? openControlPopup() : closeControlPopup())} />
    );
  }

  const neverBlock = NEVER_BLOCK_PATHS.has(pathname ?? '');
  const adminBypassed = isAdmin && hasAdminBypassFlag(doc.startAtMs);
  const readonlyBypassed = doc.mode === 'readonly' && hasReadonlyBypassFlag(doc.startAtMs);
  void bypassTick; // read for its re-render effect only

  // The control panel is a Dialog (z-[120]) and this overlay is z-[500], so the panel would open
  // behind it. Stand the overlay down while an ADMIN has the panel open — gated on isAdmin so
  // opening a panel can never become a way for anyone else to get out of the block.
  const controlsOpenByAdmin = controlPopupOpen && isAdmin;
  const showOverlay = phase === 'active' && !neverBlock && !adminBypassed && !readonlyBypassed && !controlsOpenByAdmin;
  // Auth screens never get the overlay — they get the slim banner instead, even mid-window.
  // Once a normal page is bypassed (admin "Enter anyway" / non-admin "View data read-only"),
  // nothing further shows — that's the whole point of a bypass.
  const showBanner = phase === 'scheduled' || (phase === 'active' && neverBlock);

  return (
    <>
      {showBanner && (
        <MaintenanceBanner doc={doc} nowMs={nowMs} phase={phase === 'active' ? 'active' : 'scheduled'} onClick={() => setDetailsOpen(true)} />
      )}
      {showOverlay && (
        <MaintenanceOverlay
          doc={doc}
          nowMs={nowMs}
          isAdmin={isAdmin}
          isSignedIn={!!user}
          onOpenControls={openControlPopup}
          onEnterAnyway={() => { setAdminBypass(doc.startAtMs); setBypassTick(t => t + 1); }}
          onViewReadOnly={() => { setReadonlyBypass(doc.startAtMs); setBypassTick(t => t + 1); }}
        />
      )}
      <MaintenanceDetailsPopup
        doc={doc}
        nowMs={nowMs}
        phase={phase === 'active' ? 'active' : 'scheduled'}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        isAdmin={isAdmin}
        onJumpToControls={() => { setDetailsOpen(false); openControlPopup(); }}
      />
      <MaintenanceControlPopup doc={doc} open={controlPopupOpen} onOpenChange={o => (o ? openControlPopup() : closeControlPopup())} />
    </>
  );
}
