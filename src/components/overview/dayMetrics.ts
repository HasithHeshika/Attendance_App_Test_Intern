// Day-level arithmetic for the Overview page: how many hours a person's sessions add up to,
// and what is visibly wrong with them. Pure — no Firestore, no React — so the People panel,
// the KPI band and the dossier all read the SAME numbers from the same day payload.
import type { DayPerson, SessionView } from '@/lib/overviewData';
import { getRecordIssues, type ApprovalIssue } from '@/lib/approvalIssues';

// "08:05 AM" / "12:40 PM" → minutes since midnight, or null.
//
// SessionView carries times ALREADY formatted for display; the raw Timestamps stay inside
// useOverviewDay and never reach this page. Re-reading attendance per person purely to total
// a day would be hundreds of extra reads on a 300+ user org, so the display string is parsed
// back instead. It is lossy in exactly one way we care about — no date part — which is why an
// end before the start (an overnight session) is discarded rather than guessed at below.
function toMinutes(display: string | null): number | null {
  if (!display) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(display.trim());
  if (!m) return null;
  const h12 = Number(m[1]);
  const mins = Number(m[2]);
  if (!Number.isFinite(h12) || !Number.isFinite(mins) || h12 < 1 || h12 > 12 || mins > 59) return null;
  const pm = m[3].toUpperCase() === 'PM';
  return ((h12 % 12) + (pm ? 12 : 0)) * 60 + mins;
}

/** Hours worked on the day, summed over CLOSED sessions only. A session still running (or one
 *  whose check-out was never recorded) contributes nothing — better a low number the panel can
 *  explain with a "missing checkout" chip than an invented one. */
export function dayHours(sessions: SessionView[]): number {
  let mins = 0;
  for (const s of sessions) {
    const a = toMinutes(s.checkIn);
    const b = toMinutes(s.checkOut);
    if (a == null || b == null || b <= a) continue;   // open, unparseable, or overnight
    mins += b - a;
  }
  return Math.round((mins / 60) * 10) / 10;
}

export type DayIssue = ApprovalIssue | { kind: 'missingCheckout'; severity: 'warn' };

/** The visible problems with a person's day, deduplicated across their sessions. Reuses the
 *  approvals page's own rules (approvalIssues.getRecordIssues) so the Overview never invents a
 *  second definition of "out of radius" / "no GPS"; the open-session case is added on top
 *  because that is a day-shape problem, not a per-record one. */
export function dayIssues(person: DayPerson): DayIssue[] {
  if (person.status !== 'present') return [];
  const seen = new Set<string>();
  const out: DayIssue[] = [];
  for (const s of person.sessions) {
    // SessionView only ever carries the CHECK-IN fix, so getRecordIssues' missingGps case
    // fires when the check-in had no usable GPS — which is exactly the chip we want.
    const issues = getRecordIssues({
      check_in_lat: s.lat, check_in_lng: s.lng,
      check_out_within_radius: s.outOfRadius == null ? null : !s.outOfRadius,
      is_outstation: s.outstation,
    });
    for (const i of issues) {
      if (seen.has(i.kind)) continue;
      seen.add(i.kind);
      out.push(i);
    }
  }
  if (person.sessions.some(s => s.checkIn && !s.checkOut) && !seen.has('missingCheckout')) {
    out.push({ kind: 'missingCheckout', severity: 'warn' });
  }
  return out;
}
