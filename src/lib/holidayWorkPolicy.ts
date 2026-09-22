/**
 * What working on a holiday, a rest day or an approved leave day is worth.
 *
 * Pure — no React, no Firestore, no Date.now(). Implements Part B2 of
 * `docs/superpowers/specs/2026-09-01-working-patterns-and-holiday-work-design.md`.
 *
 * ── This does NOT invent a second multiplier model ───────────────────────────────────────
 * The payroll module already owns holiday premiums: `PayrollSettings.ph_day_multiplier` and
 * `poya_day_multiplier` are tenant-wide and priced by `payrollCalculationEngine`. The spec is
 * explicit — extend those, do not build a parallel model. So for the `public` and `poya` kinds
 * this resolver FALLS BACK to those existing settings when no policy row overrides them, and
 * only genuinely new kinds (`rest_day`, `leave`, `company`) have nowhere else to come from.
 *
 * Per-employee OT (`PayrollEmployee.ot_multiplier_normal`, default 1.5) is a different concept
 * again — a negotiated rate for ordinary overtime — and is untouched by any of this.
 *
 * ── Why the default is 1 and why `enabled` exists ────────────────────────────────────────
 * 1 means "worked it, no premium", which is the honest description of a company that pays
 * nothing extra. CLAUDE.md is blunt that this app has no overtime pay and that implying an
 * entitlement which does not exist is a real harm, so the tenant gate is enforced HERE, in the
 * resolver, rather than only in the UI: with `enabled: false` every kind returns 1 no matter
 * what rows exist. A feature switched off cannot quietly price anything.
 */

/** The kinds of day that can carry a premium when someone works them anyway. */
export type HolidayWorkKind = 'public' | 'poya' | 'company' | 'rest_day' | 'leave';

export const HOLIDAY_WORK_KINDS: readonly HolidayWorkKind[] =
  ['public', 'poya', 'company', 'rest_day', 'leave'];

/**
 * No premium — the rate for a company that pays nothing extra, and the answer whenever nothing
 * is configured. Every path that cannot find a policy ends here rather than guessing.
 */
export const NO_PREMIUM = 1;

/** Mirrors the `holiday_work_policies` document, minus the timestamps the service owns. */
export interface HolidayWorkPolicy {
  id: string;
  company_id: string;
  kind: HolidayWorkKind;
  /** 1 = no premium, 1.5, 2 … Must be at least 1; see `usableMultiplier`. */
  multiplier: number;
  /** YYYY-MM-DD. Required, so last March's payslip keeps last March's rate. */
  effective_from: string;
  is_active: boolean;
}

/**
 * The existing tenant-wide payroll premiums, passed in rather than imported — this module
 * stays free of the payroll types so it can be used from the attendance side without dragging
 * the payroll module along.
 */
export interface PayrollHolidayRates {
  ph_day_multiplier?: number | null;
  poya_day_multiplier?: number | null;
}

export interface HolidayWorkOptions {
  /** The tenant's `holidayPayMultipliers` flag. Absent or false means no premium, ever. */
  enabled?: boolean;
  /** Restricts which policies apply. A policy with no company_id matches any. */
  companyId?: string | null;
  /** Fallback for `public` and `poya`, from `payroll_settings/global`. */
  payrollRates?: PayrollHolidayRates | null;
}

/**
 * A multiplier is only usable if it is a finite number of at least 1.
 *
 * Below 1 would CUT someone's pay for having worked a holiday, which no configuration should be
 * able to express by accident — and `null`/`undefined` is what an unconfigured settings field
 * reads back as (the payroll engine carries a long comment about exactly that hazard). Both are
 * treated as "not configured" so resolution falls through to the next source.
 */
function usableMultiplier(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value : null;
}

/** YYYY-MM-DD in LOCAL time — never toISOString, which shifts a day east of Greenwich. */
function localDateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The policy row governing this kind on this date, or null.
 *
 * Newest `effective_from` on or before the date wins; a future-dated row is ignored so a rate
 * change can be scheduled without rewriting the month in progress. Ties break by id, so the
 * same inputs always produce the same answer regardless of Firestore's iteration order — an
 * unstable rate would make a payslip irreproducible.
 */
export function resolvePolicy(
  kind: HolidayWorkKind,
  date: Date,
  policies: readonly HolidayWorkPolicy[],
  companyId?: string | null,
): HolidayWorkPolicy | null {
  const key = localDateKey(date);
  let best: HolidayWorkPolicy | null = null;
  for (const p of policies) {
    if (!p.is_active) continue;
    if (p.kind !== kind) continue;
    if (!p.effective_from || p.effective_from > key) continue;
    if (p.company_id && companyId && p.company_id !== companyId) continue;
    if (usableMultiplier(p.multiplier) === null) continue;
    if (!best
      || p.effective_from > best.effective_from
      || (p.effective_from === best.effective_from && p.id > best.id)) {
      best = p;
    }
  }
  return best;
}

/**
 * The multiplier to apply for working a day of this kind.
 *
 * Order: the tenant gate, then a policy row, then the payroll module's existing premium for
 * `public`/`poya`, then no premium. Always returns a usable number — never null, never NaN —
 * because a caller that has to handle "no answer" will invent one.
 */
export function holidayWorkMultiplier(
  kind: HolidayWorkKind,
  date: Date,
  policies: readonly HolidayWorkPolicy[] = [],
  opts: HolidayWorkOptions = {},
): number {
  // The gate comes first and admits no exceptions. A tenant without the feature pays nothing
  // extra, whatever rows happen to exist in its database.
  if (opts.enabled !== true) return NO_PREMIUM;

  const policy = resolvePolicy(kind, date, policies, opts.companyId);
  const fromPolicy = policy ? usableMultiplier(policy.multiplier) : null;
  if (fromPolicy !== null) return fromPolicy;

  // Extend, don't duplicate: these two kinds already have a home in payroll settings.
  const rates = opts.payrollRates;
  if (rates) {
    if (kind === 'public') {
      const v = usableMultiplier(rates.ph_day_multiplier);
      if (v !== null) return v;
    }
    if (kind === 'poya') {
      const v = usableMultiplier(rates.poya_day_multiplier);
      if (v !== null) return v;
    }
  }

  return NO_PREMIUM;
}

/**
 * Is there a premium worth telling anyone about?
 *
 * The approvals screen should say "this day pays 2×" only when it actually does. Exactly 1 is
 * not worth a badge — it is the ordinary case wearing a label.
 */
export function hasPremium(multiplier: number): boolean {
  return Number.isFinite(multiplier) && multiplier > NO_PREMIUM;
}
