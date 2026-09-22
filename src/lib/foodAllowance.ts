// Auto-calculated food allowance categories from a LOCAL "YYYY-MM-DD HH:MM:SS" time string.
// Shared by the Approvals page (its editable cards seed from these) and the user activity
// panel's bulk approve (which never edits times, so these are the values it writes).
//
// Check-in:  before 06:45 → cat 1, 06:45–07:00 → cat 2, after 07:00 → none
// Check-out: before 19:00 → none, 19:00 onwards → cat 1
export function calcMorningAllowance(timeStr: string | null | undefined): number {
  if (!timeStr) return 0;
  const d = new Date(timeStr);
  if (Number.isNaN(d.getTime())) return 0;
  const mins = d.getHours() * 60 + d.getMinutes();
  if (mins < 6 * 60 + 45) return 1;   // before 06:45
  if (mins <= 7 * 60) return 2;        // 06:45 – 07:00
  return 0;                             // after 07:00
}

export function calcEveningAllowance(timeStr: string | null | undefined): number {
  if (!timeStr) return 0;
  const d = new Date(timeStr);
  if (Number.isNaN(d.getTime())) return 0;
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= 19 * 60 ? 1 : 0; // after 19:00
}
