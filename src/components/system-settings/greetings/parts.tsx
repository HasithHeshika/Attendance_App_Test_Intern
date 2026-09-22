'use client';
import type { ElementType, ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Small pieces shared by the four greetings blocks. They exist so the blocks look like the
// rest of System Settings rather than like a form somebody typed once: every other block on
// that page opens with a header and states its rule in one sentence.

/**
 * A block header in the house shape — name, one sentence stating the RULE, room for a count
 * badge and for the block's own action on the right (SettingsBackupSettings and the
 * Maintenance block do the same). Greetings used to open straight into a switch, which is why
 * four separate settings read as one long form.
 */
export function BlockHeader({
  icon: Icon, title, description, badge, action,
}: {
  icon?: ElementType;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
      <div className="min-w-0 max-w-prose">
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
          {Icon && <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <span className="min-w-0">{title}</span>
          {badge}
        </h3>
        {description && (
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * A switch whose WHOLE row is the hit area.
 *
 * The Radix <Switch> is 20x36 CSS px and this screen is edited on phones, where that is half a
 * comfortable target — and its <Label> cannot be wired with htmlFor either, because a button is
 * not a labelable element, so tapping the words did nothing. A button can't contain a button,
 * so the track here is drawn rather than mounted; it is the same geometry and the same tokens
 * as ui/switch.tsx, and the row itself carries role="switch".
 *
 * `onWord`/`offWord` are required: --primary, --success and --brand are one azure, so the state
 * has to be readable as a word as well as a position.
 */
export function SwitchButton({
  checked, onChange, label, hint, meta, icon: Icon, onWord, offWord,
  variant = 'row', disabled, busy, ariaLabel, className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  /** A third line — what this occasion will actually send on the next run. */
  meta?: ReactNode;
  icon?: ElementType;
  onWord: string;
  offWord: string;
  /** 'row' — full width with its text; 'tile' — bordered, for a group of choices; 'bare' — the
   *  track alone in a tap-sized button, for a list row that already has its own label. */
  variant?: 'row' | 'tile' | 'bare';
  disabled?: boolean;
  busy?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const track = (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors motion-reduce:transition-none',
        checked ? 'bg-primary' : 'bg-input',
        busy && 'opacity-60',
      )}
    >
      <span
        className={cn(
          'block h-4 w-4 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </span>
  );

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'group flex items-center gap-3 rounded-lg text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-60',
        variant === 'bare' && 'h-11 w-11 shrink-0 justify-center hover:bg-accent',
        variant === 'row' && 'min-h-11 w-full px-2 py-2 -mx-2 hover:bg-accent/60',
        variant === 'tile' && cn(
          'min-h-11 w-full items-start border p-3',
          checked ? 'border-primary bg-primary/10' : 'border-border bg-muted/20 hover:bg-accent',
        ),
        className,
      )}
    >
      {variant === 'bare' ? track : (
        <>
          {Icon && (
            <Icon
              aria-hidden
              className={cn('h-4 w-4 shrink-0', variant === 'tile' && 'mt-0.5',
                checked ? 'text-primary' : 'text-muted-foreground')}
            />
          )}
          <span className="min-w-0 flex-1">
            <span className={cn('block text-sm text-foreground', checked && 'font-semibold')}>{label}</span>
            {hint && <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{hint}</span>}
            {meta && <span className="mt-1 block text-[11px] font-medium text-foreground">{meta}</span>}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {checked ? onWord : offWord}
            </span>
            {track}
          </span>
        </>
      )}
    </button>
  );
}

/**
 * The subordinate half of a master switch: an indented, ruled-off region that reads as
 * belonging to the switch above it, plus one plain sentence when the master is off. The old
 * screen greyed three switches out with nothing anywhere saying why.
 */
export function Dependent({
  active, offNote, children, className,
}: {
  active: boolean;
  offNote: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-2 border-l-2 border-border pl-3 sm:pl-4', className)}>
      {!active && (
        <p className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          {offNote}
        </p>
      )}
      {/* No extra dimming on top of the controls' own disabled state — two layers of opacity on
          11px text is how the old screen got below AA. The sentence above is the signal. */}
      <div>{children}</div>
    </div>
  );
}
