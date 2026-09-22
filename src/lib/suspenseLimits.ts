// How much float a person may be trusted with — the ceiling on a suspense account's balance.
//
// One limit applies to EACH company account a person holds (the balance on that account, not
// the sum across companies). It is resolved most-specific first:
//
//   person (EPF) → role → position (designation) → department → company default
//
// so a named exception always wins, and a company default catches everyone nobody thought
// about. Nothing set at any level means "no limit", which is exactly how every account behaved
// before limits existed. A limit of 0 is a real limit — that person may hold no float at all.
//
// Pure and Firestore-free so the rule an approver's decision hinges on is unit-tested (see
// src/lib/__tests__/suspenseLimits.test.ts). Names (role, designation, department) are typed by
// hand across the app, so they are matched trimmed and case-insensitively; EPFs are trimmed only.

export type LimitSource = 'person' | 'role' | 'position' | 'department' | 'company';

export interface SuspenseLimitConfig {
  company_default: Record<string, number>;   // company_id → limit
  by_department:   Record<string, number>;   // department name → limit
  by_position:     Record<string, number>;   // designation → limit
  by_role:         Record<string, number>;   // role name → limit
  by_person:       Record<string, number>;   // epf_number → limit
}

export const EMPTY_LIMITS: SuspenseLimitConfig = {
  company_default: {}, by_department: {}, by_position: {}, by_role: {}, by_person: {},
};

export const LIMIT_SOURCE_LABEL: Record<LimitSource, string> = {
  person:     'personal limit',
  role:       'role limit',
  position:   'position limit',
  department: 'department limit',
  company:    'company default',
};

export interface LimitSubject {
  epf:          string;
  role?:        string | null;
  designation?: string | null;
  department?:  string | null;
  company_id?:  string | null;
}

export interface ResolvedLimit {
  limit:  number | null;     // null = no limit applies
  source: LimitSource | null;
  /** The key that matched at `source` — the person's EPF, the role name, etc. */
  key:    string | null;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A usable limit is a finite number ≥ 0. Anything else is treated as "not set". */
export function isLimitValue(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Look a name up in a map whose keys were typed by hand. Exact match first, then a
 *  trimmed / case-insensitive one, so "Site Engineer " still finds "site engineer". */
function lookup(map: Record<string, number> | undefined, key: string | null | undefined): { value: number; key: string } | null {
  if (!map || !key) return null;
  const exact = map[key];
  if (isLimitValue(exact)) return { value: exact, key };
  const want = norm(key);
  if (!want) return null;
  for (const [k, v] of Object.entries(map)) {
    if (norm(k) === want && isLimitValue(v)) return { value: v, key: k };
  }
  return null;
}

export function resolveSuspenseLimit(config: SuspenseLimitConfig | null | undefined, subject: LimitSubject): ResolvedLimit {
  const c = config ?? EMPTY_LIMITS;
  const epf = String(subject.epf ?? '').trim();
  const person = epf ? (lookup(c.by_person, epf)) : null;
  if (person) return { limit: person.value, source: 'person', key: person.key };
  const role = lookup(c.by_role, subject.role);
  if (role) return { limit: role.value, source: 'role', key: role.key };
  const position = lookup(c.by_position, subject.designation);
  if (position) return { limit: position.value, source: 'position', key: position.key };
  const department = lookup(c.by_department, subject.department);
  if (department) return { limit: department.value, source: 'department', key: department.key };
  const company = subject.company_id ? c.company_default?.[subject.company_id] : undefined;
  if (isLimitValue(company)) return { limit: company, source: 'company', key: subject.company_id! };
  return { limit: null, source: null, key: null };
}

/** How much more can be credited before the limit is reached. Negative when already over.
 *  null when there is no limit. */
export function limitHeadroom(limit: number | null, balance: number): number | null {
  if (limit === null) return null;
  return round2(limit - (Number(balance) || 0));
}

export interface LimitCheck {
  over:    boolean;
  excess:  number;   // how far past the limit `balanceAfter` lands (0 when not over)
  limit:   number | null;
}

/** Would a balance of `balanceAfter` breach the limit? A tiny tolerance absorbs 2-dp rounding. */
export function checkAgainstLimit(limit: number | null, balanceAfter: number): LimitCheck {
  if (limit === null) return { over: false, excess: 0, limit: null };
  const after = round2(Number(balanceAfter) || 0);
  const over = after > limit + 0.005;
  return { over, excess: over ? round2(after - limit) : 0, limit };
}

/** Tolerant parse of whatever is stored — a hand-edited or half-written doc must never take the
 *  approval path down with it. Unknown keys are dropped, non-numeric values ignored. */
export function normalizeLimitConfig(raw: unknown): SuspenseLimitConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const clean = (m: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (!m || typeof m !== 'object') return out;
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
      const key = String(k).trim();
      const num = typeof v === 'string' ? Number(v) : v;
      if (key && isLimitValue(num)) out[key] = round2(num);
    }
    return out;
  };
  return {
    company_default: clean(src.company_default),
    by_department:   clean(src.by_department),
    by_position:     clean(src.by_position),
    by_role:         clean(src.by_role),
    by_person:       clean(src.by_person),
  };
}

/** How many rules a config holds, for a settings summary line. */
export function countLimitRules(c: SuspenseLimitConfig): number {
  return Object.keys(c.company_default).length + Object.keys(c.by_department).length
    + Object.keys(c.by_position).length + Object.keys(c.by_role).length + Object.keys(c.by_person).length;
}
