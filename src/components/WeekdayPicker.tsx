'use client';
// Seven round toggle buttons — M T W T F S S (Monday-first) — for picking the weekdays a
// recurring shift pattern runs on. Controlled: `value` is the selected weekday numbers
// (0=Sun … 6=Sat, matching Date.getDay() and SchedulePattern.weekdays). Purely presentational
// — the caller owns the array and decides what an empty selection means.
import { WEEKDAYS, MON_FRI, describeWeekdays } from '@/lib/schedulePattern';

interface WeekdayPickerProps {
  value: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
  /** Show the "Mon–Fri" / "Clear" quick-set row (default true). */
  shortcuts?: boolean;
}

export default function WeekdayPicker({
  value, onChange, disabled = false, shortcuts = true,
}: WeekdayPickerProps) {
  const selected = new Set(value);
  const toggle = (v: number) => {
    if (disabled) return;
    const next = new Set(selected);
    next.has(v) ? next.delete(v) : next.add(v);
    // Keep the array in canonical 0..6 order so equal selections always compare equal.
    onChange([...next].sort((a, b) => a - b));
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5" role="group" aria-label="Days of the week">
        {WEEKDAYS.map((w) => {
          const on = selected.has(w.value);
          return (
            <button
              key={w.value}
              type="button"
              disabled={disabled}
              onClick={() => toggle(w.value)}
              aria-pressed={on}
              aria-label={w.label}
              title={w.label}
              className={`h-9 w-9 flex-shrink-0 rounded-full border text-xs font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                on
                  ? 'bg-primary/10 border-primary/40 text-primary'
                  : 'bg-card border-border text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
            >
              {w.short}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">{describeWeekdays(value)}</p>
        {shortcuts && !disabled && (
          <div className="flex gap-2 text-[11px] font-semibold">
            <button
              type="button"
              onClick={() => onChange([...MON_FRI])}
              className="text-primary hover:underline"
            >
              Mon–Fri
            </button>
            {value.length > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-muted-foreground hover:text-foreground hover:underline"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
