import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Standard live inline field error: small red text with an alert icon, rendered
 * directly beneath an invalid or empty required input. Use in place of (or
 * alongside) toast-only validation so the user sees exactly which field is wrong.
 *
 * Renders nothing when `children` is falsy, so callers can pass a possibly-empty
 * error string without an extra guard:
 *   <InlineError>{nameError}</InlineError>
 */
export default function InlineError({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  if (!children) return null;
  return (
    <p className={cn('mt-1 flex items-start gap-1 text-[11px] text-destructive', className)}>
      <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
