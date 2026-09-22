import { isValidLatLng } from './geo';
import { formatTime } from './utils';

// Read straight from Firestore, a session's check_in/check_out is a Timestamp object
// ({seconds,nanoseconds}) — NOT a string. Rendering that object as a React child throws
// ("Objects are not valid as a React child"). Normalize any of Timestamp | {seconds} |
// Date | ISO string | "HH:MM" to a friendly display string ("08:05 AM"), or null.
export function toDisplayTime(v: any): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return formatTime(v);
  const d =
    typeof v?.toDate === 'function' ? v.toDate() :
    typeof v?.seconds === 'number' ? new Date(v.seconds * 1000) :
    v instanceof Date ? v : null;
  if (!d || isNaN(d.getTime())) return null;
  const h = d.getHours(), m = d.getMinutes();
  const hh = String(h % 12 || 12).padStart(2, '0');
  return `${hh}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export type SessionView = {
  checkIn: string | null; checkOut: string | null;
  lat: number | null; lng: number | null;
  place: string | null; outstation: boolean; outOfRadius: boolean | null;
};
export type DayPerson = {
  epf: string; name: string; company: string;
  // 'unscheduled' is Southern-Lanka-only (shift-based tenants) — see shapeDayPeople's
  // `scheduledEpfs` param. Every other tenant never produces it.
  status: 'present' | 'leave' | 'missing' | 'unscheduled';
  sessions: SessionView[];
  avatar?: string | null;
  email?: string | null;
};
// `total` is the "expected to work" pool (present + onLeave + missing) — it deliberately
// EXCLUDES `unscheduled`, since nobody expected an unscheduled person to work that day. For a
// tenant that never produces 'unscheduled', this is exactly `people.length`, identical to
// before this field existed.
export type DayStats = { total: number; present: number; onLeave: number; missing: number; unscheduled: number };

// Mirror of apiCompat.sessionsOf: a day's attendance is an array of sessions; legacy
// docs stored a single session in top-level fields. Normalize both to an array.
export function normalizeSessions(att: any): any[] {
  if (att && Array.isArray(att.sessions)) return att.sessions;
  if (!att || (!att.check_in && !att.check_out)) return [];
  return [{
    check_in: att.check_in ?? null, check_out: att.check_out ?? null,
    working_place: att.working_place ?? null, check_in_site_name: att.check_in_site_name ?? null,
    check_in_lat: att.check_in_lat ?? null, check_in_lng: att.check_in_lng ?? null,
    is_outstation: att.is_outstation ?? false,
    check_out_within_radius: att.check_out_within_radius ?? null,
  }];
}

function toSessionView(s: any): SessionView {
  const lat = typeof s.check_in_lat === 'number' ? s.check_in_lat : null;
  const lng = typeof s.check_in_lng === 'number' ? s.check_in_lng : null;
  return {
    checkIn: toDisplayTime(s.check_in),
    checkOut: toDisplayTime(s.check_out),
    lat: lat != null && lng != null && isValidLatLng(lat, lng) ? lat : null,
    lng: lat != null && lng != null && isValidLatLng(lat, lng) ? lng : null,
    place: s.check_in_site_name ?? s.working_place ?? null,
    outstation: !!s.is_outstation,
    outOfRadius: s.check_out_within_radius == null ? null : !s.check_out_within_radius,
  };
}

export function shapeDayPeople(input: {
  employees: any[];
  attendanceByEpf: Record<string, any>;
  leaveEpfs: Set<string>;
  specialEpfs: Set<string>;
  // Southern Lanka only — epf_numbers with a schedule_assignments row for this date. Omitted
  // (or null) for every other tenant, which keeps 'missing' meaning exactly what it always
  // has: nobody assigned this shift-gate is ever classified 'unscheduled'.
  scheduledEpfs?: Set<string> | null;
}): DayPerson[] {
  const { employees, attendanceByEpf, leaveEpfs, specialEpfs, scheduledEpfs } = input;
  const order: Record<DayPerson['status'], number> = { present: 0, leave: 1, missing: 2, unscheduled: 3 };
  return employees.map((e): DayPerson => {
    const epf = e.epf_number as string;
    const rawSessions = normalizeSessions(attendanceByEpf[epf]).filter((s: any) => s.check_in);
    const present = rawSessions.length > 0;
    const onLeave = leaveEpfs.has(epf) || specialEpfs.has(epf);
    // A real check-in always wins, shift or not (matches /attendance-view's own rule). Absent
    // only applies to someone actually scheduled — everyone else with no shift on file is
    // 'unscheduled', not absent.
    const status: DayPerson['status'] = present
      ? 'present'
      : onLeave
        ? 'leave'
        : scheduledEpfs && !scheduledEpfs.has(epf)
          ? 'unscheduled'
          : 'missing';
    const avatar = (e.avatar_url ?? e.avatar ?? e.profile_photo_url ?? e.photoURL ?? e.photo_url) as string || undefined;
    const email = (e.email as string) || undefined;
    return {
      epf, name: e.display_name ?? epf, company: e.company_name ?? '',
      status, sessions: present ? rawSessions.map(toSessionView) : [],
      avatar, email,
    };
  }).sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
}

export function computeStats(people: DayPerson[]): DayStats {
  const present = people.filter(p => p.status === 'present').length;
  const onLeave = people.filter(p => p.status === 'leave').length;
  const missing = people.filter(p => p.status === 'missing').length;
  const unscheduled = people.filter(p => p.status === 'unscheduled').length;
  return { total: present + onLeave + missing, present, onLeave, missing, unscheduled };
}
