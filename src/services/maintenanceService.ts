'use client';
// Client-side read/write path for planned-maintenance mode (single doc: settings/maintenance).
//
// Server-side enforcement of "who may write" currently piggybacks on isSystemAdmin() in
// firestore.rules — see the posture note at the top of that file: capability claims are never
// minted in this app, so isSystemAdmin() reduces to isAuth() today. Writing here is therefore
// gated at the UI layer (admin-only console command + admin-only control popup), same posture
// as the rest of the app's admin-only collections. It will tighten automatically if/when a real
// claims provider is added.
import {
  doc, onSnapshot, setDoc, updateDoc, serverTimestamp,
} from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, db } from '@/lib/firebase';
import { sendCustomNotification } from '@/services/notificationService';
import {
  parseMaintenanceDoc, MAINTENANCE_KIND_LABEL,
  type MaintenanceDoc, type MaintenanceKind, type MaintenanceAccessMode,
} from '@/lib/maintenance';

const maintenanceRef = () => doc(db, 'settings', 'maintenance');

// Live subscription — never lets a read failure lock anyone in or out. A permission error or
// transient offline state resolves to `null` (the "off" doc), same as a malformed doc.
// Gated on auth, and re-subscribed whenever it changes. MaintenanceGate mounts in the ROOT
// layout, so this used to subscribe while Firebase Auth was still restoring the session: the rule
// on settings/maintenance is `allow read: if isAuth()`, so that first listen was DENIED — and an
// onSnapshot error terminates the listener permanently. The window was then treated as off for
// the rest of the session even after sign-in, so an armed maintenance blocked nobody.
export function subscribeMaintenanceDoc(onDoc: (doc: MaintenanceDoc | null) => void): () => void {
  let unsubDoc: (() => void) | null = null;

  const unsubAuth = onAuthStateChanged(auth, user => {
    unsubDoc?.();
    unsubDoc = null;
    // Signed out: the rule denies the read outright, so there is nothing to listen to. Report
    // "off" rather than spending a listener on a guaranteed permission error.
    if (!user) { onDoc(null); return; }
    unsubDoc = onSnapshot(
      maintenanceRef(),
      snap => onDoc(snap.exists() ? parseMaintenanceDoc(snap.data()) : null),
      err => {
        console.warn('[maintenance] settings/maintenance subscription failed (treating as off):', err?.message ?? err);
        onDoc(null);
      },
    );
  });

  return () => { unsubAuth(); unsubDoc?.(); };
}

export interface ArmMaintenanceInput {
  startAtMs: number;
  endAtMs: number;
  message: string;
  mode: MaintenanceAccessMode;
  kind: MaintenanceKind;
  notifyNow: boolean;
}

// Arms (or re-arms/adjusts) the maintenance window. A full overwrite — no cleanup write is
// needed for a previously-ended doc; this simply replaces it. Lifecycle dedupe stamps
// (startNotifiedAtMs/endNotifiedAtMs) are deliberately left untouched here: the Cloud Function
// compares them against the doc's CURRENT startAtMs/endAtMs, so changing either boundary
// naturally invalidates any stale stamp and the window announces again on its own.
export async function armMaintenance(
  input: ArmMaintenanceInput,
  actor: { epf: string; name: string },
): Promise<void> {
  await setDoc(maintenanceRef(), {
    enabled: true,
    startAtMs: input.startAtMs,
    endAtMs: input.endAtMs,
    message: input.message,
    mode: input.mode,
    kind: input.kind,
    createdBy: actor.epf,
    createdByName: actor.name,
    updatedAt: serverTimestamp(),
  });

  if (input.notifyNow) {
    await sendCustomNotification({
      audience: 'all',
      title: `${MAINTENANCE_KIND_LABEL[input.kind]} scheduled`,
      body: input.message,
      actorEpf: actor.epf,
      actorName: actor.name,
    });
  }
}

// Disarms immediately. Leaves the rest of the doc in place (inert once enabled:false) — the
// next arm overwrites it, so there's nothing to clean up.
export async function cancelMaintenance(): Promise<void> {
  await updateDoc(maintenanceRef(), { enabled: false, updatedAt: serverTimestamp() });
}
