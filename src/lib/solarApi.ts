/**
 * Server-side client for the Solar app's external REST API (solar.altavision.lk
 * `/api/external/*`). The shared `EXTERNAL_API_KEY` is sent server-to-server only —
 * NEVER import this from client code (it would leak the key). Use it inside API
 * route handlers (src/app/api/solar/**) that the browser calls instead.
 *
 * Docs: .claude/skills/external_api_docs/external-integration.md
 */

const BASE = (process.env.SOLAR_APP_URL || 'https://solar.altavision.lk').replace(/\/$/, '');

function authHeaders(): Record<string, string> {
  const key = process.env.EXTERNAL_API_KEY;
  if (!key) throw new Error('EXTERNAL_API_KEY is not configured');
  return { 'x-api-key': key, Accept: 'application/json' };
}

async function solarGet<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`Solar API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

// ─── Generic passthrough (for the admin API playground) ─────────────────────────
const EXTERNAL_PREFIX = '/api/external/';

export interface SolarRawResult { status: number; ok: boolean; ms: number; data: unknown }

// Forwards an arbitrary request to a Solar /api/external/* endpoint with the server key.
// Path is restricted to the external namespace (no SSRF to other hosts/paths).
export async function solarRaw(
  path: string,
  opts?: { method?: string; query?: Record<string, string>; body?: unknown },
): Promise<SolarRawResult> {
  if (!path.startsWith(EXTERNAL_PREFIX)) throw new Error('Only /api/external/* paths are allowed');
  const url = new URL(`${BASE}${path}`);
  if (opts?.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const method = (opts?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { ...authHeaders() };
  let body: string | undefined;
  if (method !== 'GET' && method !== 'HEAD' && opts?.body != null) {
    headers['Content-Type'] = 'application/json';
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const started = Date.now();
  const res = await fetch(url.toString(), { method, headers, body, cache: 'no-store' });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, ms: Date.now() - started, data };
}

// ─── Identity match params (EPF → email → phone, at least one required) ──────────
export interface SolarIdentity { epf?: string; email?: string; phone?: string }

// ─── Notifications ──────────────────────────────────────────────────────────────
export interface SolarNotification {
  id: string;
  title: string;
  message: string;
  type?: string;
  category?: string;
  link?: string | null;
  recipientType?: string;
  createdAt: string;
  createdByName?: string;
  read: boolean;
}
export interface SolarNotificationsResponse {
  success: boolean;
  matched: boolean;
  user?: { uid: string; email: string; displayName: string };
  count: number;
  unread: number;
  data: SolarNotification[];
  timestamp: string;
}

export function getSolarNotifications(
  who: SolarIdentity & { since?: string; limit?: number },
): Promise<SolarNotificationsResponse> {
  return solarGet<SolarNotificationsResponse>('/api/external/notifications', {
    epf: who.epf, email: who.email, phone: who.phone, since: who.since, limit: who.limit,
  });
}

// ─── Service plans (upcoming + assigned people) ─────────────────────────────────
export interface SolarServicePlan {
  id: string; planNo: string; date: string; status: string;
  lorry?: string | null; routeUrl?: string | null; notes?: string | null;
  team: {
    leader?: SolarPerson | null;
    siteEngineer?: SolarPerson | null;
    members: SolarPerson[];
  };
  sites: Array<{
    projectNo: string; siteNo: string; customerName: string;
    contactPhone?: string | null; address?: string | null;
    gpsLat?: number | null; gpsLng?: number | null;
    routeOrder?: number; siteStatus?: string; serviceNo?: string;
  }>;
}
export interface SolarPerson {
  name: string; uid?: string | null; email?: string | null; phone?: string | null; epfNumber?: string | null;
}

export function getSolarServicePlans(
  params?: { from?: string; to?: string; includeCompleted?: boolean },
): Promise<{ success: boolean; count: number; data: SolarServicePlan[]; timestamp: string }> {
  return solarGet('/api/external/service-plans', {
    from: params?.from, to: params?.to, includeCompleted: params?.includeCompleted ? 1 : undefined,
  });
}

// ─── Projects / sites (GPS for geofencing) ──────────────────────────────────────
export interface SolarProject {
  siteNo: string; projectNo: string; customerName: string;
  contactPhone?: string | null; contactPhone2?: string | null; email?: string | null;
  address?: string | null; gpsLat?: number | null; gpsLng?: number | null;
  plusCode?: string | null; capacityKw?: number | null; systemType?: string | null;
  stage?: string | null; installedAt?: string | null; commissionedAt?: string | null;
  source?: 'new' | 'legacy';
}

export function getSolarProjects(
  params?: { withGps?: boolean; source?: 'new' | 'legacy' | 'all' },
): Promise<{ success: boolean; count: number; data: SolarProject[]; timestamp: string }> {
  return solarGet('/api/external/projects', {
    withGps: params?.withGps ? 1 : undefined, source: params?.source,
  });
}
