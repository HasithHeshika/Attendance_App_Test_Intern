'use client';
import { cn } from '@/lib/utils';
import type { MealType } from '@/lib/meals';
import { mealInitial } from '@/components/chamary/chamaryFormat';
import { MEAL_ACCENT, type BookingState } from './foodFormat';

// One meal on one day, small enough to sit three-across in a calendar cell.
//
// Three states have to be told apart at 16px, and hue cannot do it: `--success`, `--primary`
// and `--brand` are the same azure in this app (see globals.css), and the colour here is
// already spent on WHICH meal it is. So the state is carried by fill, border style and weight:
//
//   collected  filled wash, no border, bold      — the meal was ticked
//   missed     dashed border, dimmed             — a past booking nobody ticked (still charged)
//   booked     solid outline, normal weight      — today or later; nothing has happened yet
//
// The letter is always the ENGLISH initial (B / L / D), matching the chamary calendar: a cell
// this size has room for one glyph, and the translated name is on the row it belongs to.
export default function MealChip({
  meal, state, title, className,
}: {
  meal:  MealType;
  state: BookingState;
  title?: string;
  className?: string;
}) {
  const a = MEAL_ACCENT[meal];
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded border px-[3px] text-[9px] leading-none tabular-nums',
        a.text,
        state === 'collected' ? cn('border-transparent font-bold', a.fill)
          : state === 'missed' ? cn('border-dashed opacity-60', a.ring)
            : cn('font-medium', a.ring),
        className,
      )}
    >
      {mealInitial(meal)}
    </span>
  );
}
