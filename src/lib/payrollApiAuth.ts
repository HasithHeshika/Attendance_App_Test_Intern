// PAYROLL-004/005 — shared caller verification for the payroll API routes. Mirrors
// src/app/api/admin/reset-password/route.ts's pattern: verify the ID token, look up the
// caller's own `users` doc by uid (never trust a client-supplied epf/capability), then their
// `roles` doc by role name. Capabilities are read directly off the Firestore role doc rather
// than through resolveCapabilities() (client-only, imports the client Firestore SDK) — the
// payroll workflow capabilities all default `false` when absent on a role doc, exactly like
// `!!roleData.can_x` reads them, so this stays equivalent for the fields that matter here.

import type { Firestore } from 'firebase-admin/firestore';
import type { NextRequest } from 'next/server';
import { adminAuth, tenantForRequest } from '@/lib/firebaseAdmin';

export interface PayrollCaller {
  uid: string;
  epf_number: string;
  display_name: string;
  role: string | null;
  is_system_admin: boolean;
  can_view_payroll: boolean;
  can_manage_payroll_config: boolean;
  can_manage_pay_profiles: boolean;
  can_generate_payroll: boolean;
  can_review_payroll: boolean;
  can_finalize_payroll: boolean;
  can_view_own_payslip: boolean;
  can_view_attendance: boolean;
}

/** Verifies the ID token and resolves the caller's own identity + payroll capabilities
 *  server-side. Returns null on any failure (bad/expired token, no linked user doc). */
export async function verifyPayrollCaller(db: Firestore, idToken: string | undefined | null): Promise<PayrollCaller | null> {
  if (!idToken) return null;
  let uid: string;
  try {
    const decoded = await adminAuth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return null;
  }

  const userSnap = await db.collection('users').where('uid', '==', uid).limit(1).get();
  if (userSnap.empty) return null;
  const userData = userSnap.docs[0].data();
  const epfNumber = userData.epf_number as string | undefined;
  if (!epfNumber) return null;
  const roleName = (userData.role as string | undefined) ?? null;

  const roleSnap = roleName ? await db.collection('roles').where('name', '==', roleName).limit(1).get() : null;
  const roleData = roleSnap && !roleSnap.empty ? roleSnap.docs[0].data() : {};

  const isSystemAdmin = !!roleData.is_system_admin;
  return {
    uid,
    epf_number: epfNumber,
    display_name: (userData.display_name as string | undefined) || epfNumber,
    role: roleName,
    is_system_admin: isSystemAdmin,
    can_view_payroll: isSystemAdmin || !!roleData.can_view_payroll,
    can_manage_payroll_config: isSystemAdmin || !!roleData.can_manage_payroll_config,
    can_manage_pay_profiles: isSystemAdmin || !!roleData.can_manage_pay_profiles,
    can_generate_payroll: isSystemAdmin || !!roleData.can_generate_payroll,
    can_review_payroll: isSystemAdmin || !!roleData.can_review_payroll,
    can_finalize_payroll: isSystemAdmin || !!roleData.can_finalize_payroll,
    // Own-data capability — absent on the role doc reads as true (matches
    // src/lib/permissions.ts's `!== false` default for this one field).
    can_view_own_payslip: isSystemAdmin || roleData.can_view_own_payslip !== false,
    can_view_attendance: isSystemAdmin || !!roleData.can_view_attendance,
  };
}

export function epfDocId(epf: string): string {
  return epf.includes('/') ? epf.replace(/\//g, '%2F') : epf;
}

/** Defense-in-depth: every payroll API route calls this before doing anything else. Payroll
 *  data already lives in a physically separate Firestore database per tenant (adminDbFor(req)
 *  resolves it), so a non-payroll tenant's database structurally has none of these
 *  collections populated — this check just makes that explicit and fails fast with a clear
 *  error instead of relying solely on "the query found nothing" to reject the request. */
export function requirePayrollTenant(req: NextRequest): boolean {
  return tenantForRequest(req).features.payroll;
}
