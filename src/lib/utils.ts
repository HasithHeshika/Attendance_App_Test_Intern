import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Returns YYYY-MM-DD in Asia/Colombo (UTC+5:30) — avoids UTC date being one day behind late at night
export function localDateString(date: Date = new Date()): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });
}

export function isSunday(dateStr: string): boolean {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay() === 0;
}

// ─── Special leave helpers ──────────────────────────────────────────────────
interface SpecialLeaveRule {
  id: string; leave_type: string; from_date: string; to_date: string;
  recurring_weekday: number | null; reason: string; is_paid: boolean;
  must_cover: boolean; assigned_by: string; created_at: string;
}

// Returns the matching special-leave rule for a given date, or null.
export function specialLeaveOn(
  rules: SpecialLeaveRule[] | undefined | null,
  dateStr: string,
): SpecialLeaveRule | null {
  if (!rules?.length) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  for (const r of rules) {
    // from_date/to_date may be stored as ISO datetimes ("2026-07-04T…") — compare on the date
    // part only, else a single-day range excludes its own start day.
    if (dateStr < String(r.from_date).slice(0, 10) || dateStr > String(r.to_date).slice(0, 10)) continue;
    if (r.recurring_weekday === null || r.recurring_weekday === undefined) return r; // whole range
    if (r.recurring_weekday === weekday) return r;
  }
  return null;
}

export function formatTime(dateString: string): string {
  if (!dateString || typeof dateString !== 'string') return '--:--';
  const cleanStr = dateString.trim();

  // Handle simple time format (e.g., "HH:MM" or "HH:MM:SS") directly
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(cleanStr)) {
    const [hoursStr, minutesStr] = cleanStr.split(':');
    const hours = parseInt(hoursStr, 10);
    const minutes = parseInt(minutesStr, 10);
    if (!isNaN(hours) && !isNaN(minutes)) {
      const ampm = hours >= 12 ? 'PM' : 'AM';
      const formattedHours = hours % 12 || 12;
      const formattedMinutes = String(minutes).padStart(2, '0');
      const hourPart = String(formattedHours).padStart(2, '0');
      return `${hourPart}:${formattedMinutes} ${ampm}`;
    }
  }

  const date = new Date(dateString);
  if (isNaN(date.getTime())) {
    // If Date parsing fails, try prefixing a dummy date to parse time-only strings
    const dummyDate = new Date(`1970-01-01T${cleanStr}`);
    if (!isNaN(dummyDate.getTime())) {
      return dummyDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    }
    const dummyDate2 = new Date(`1970/01/01 ${cleanStr}`);
    if (!isNaN(dummyDate2.getTime())) {
      return dummyDate2.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    }
    return '--:--';
  }

  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

export function formatDate(dateString: string): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function getStatusColor(status: string) {
  switch (status?.toLowerCase()) {
    case 'accept':
    case 'accepted':
    case 'approved': return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20';
    case 'reject':
    case 'rejected': return 'text-rose-400 bg-rose-400/10 border-rose-400/20';
    case 'pending': return 'text-amber-400 bg-amber-400/10 border-amber-400/20';
    default: return 'text-slate-400 bg-slate-400/10 border-slate-400/20';
  }
}
