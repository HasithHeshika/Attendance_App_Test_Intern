// Pure roster-coverage check — no Firestore, no React. Given one company's active employees
// and, for the target month, which dates each employee actually attended vs which dates their
// roster covers, returns every date an employee showed up with nobody having scheduled them.
//
// "Covered" means either a schedule_assignments row OR a declared day_offs row exists for that
// employee/date — a declared rest day is still a roster decision, just one that says "don't
// work". Treating it as uncovered would spuriously block a run over an employee who briefly
// clocked in on their day off, which is a different (already-handled) rest-day-work scenario,
// not a missing-roster one.
//
// Southern Lanka tenant only — gated by TenantFeatures.strictRosterPayroll (src/lib/tenants.ts).
// See findRosterCoverageGaps in src/services/payrollRunService.ts for the Firestore-fetching
// caller that builds these inputs.

export interface RosterCoverageGap {
  employeeId: string; // epf_number
  employeeName: string;
  date: string; // 'yyyy-MM-dd'
  reason: 'MISSING_SHIFT_ASSIGNMENT';
}

export interface RosterCoverageInput {
  employees: { epf_number: string; display_name: string }[];
  /** Dates (per epf) with at least one attendance session carrying a real check-in. */
  attendanceDatesByEpf: Map<string, Set<string>>;
  /** Dates (per epf) covered by a schedule_assignments row or a day_offs row. */
  coveredDatesByEpf: Map<string, Set<string>>;
}

export function computeRosterCoverageGaps(input: RosterCoverageInput): RosterCoverageGap[] {
  const gaps: RosterCoverageGap[] = [];
  for (const employee of input.employees) {
    const attendanceDates = input.attendanceDatesByEpf.get(employee.epf_number);
    if (!attendanceDates || attendanceDates.size === 0) continue;
    const coveredDates = input.coveredDatesByEpf.get(employee.epf_number);
    for (const date of attendanceDates) {
      if (coveredDates?.has(date)) continue;
      gaps.push({
        employeeId: employee.epf_number,
        employeeName: employee.display_name,
        date,
        reason: 'MISSING_SHIFT_ASSIGNMENT',
      });
    }
  }
  return gaps.sort((a, b) => (a.date === b.date ? a.employeeName.localeCompare(b.employeeName) : a.date < b.date ? -1 : 1));
}
