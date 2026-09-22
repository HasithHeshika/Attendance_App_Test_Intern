'use client';
import { Phone } from 'lucide-react';
import toast from 'react-hot-toast';

// True only on devices that actually have a dialer (phones/tablets). On desktop a `tel:`
// navigation is handed straight to the browser's external-protocol handler, which pops a
// native "<origin> wants to open this application" dialog that exposes the raw deployment
// URL (e.g. dev-yasitha--av-attendance.netlify.app). There we copy the number instead.
export function canPlaceCall(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

// A tap-to-call button — render only when the person has a phone number on file.
// Phone/tablet: opens the dialer seamlessly. Desktop: copies the number and shows a
// toast — no protocol hand-off, so no OS "open external app" prompt leaking the origin.
export default function CallButton({
  phone,
  name,
  title,
  className = 'inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-border bg-card text-primary transition-colors hover:bg-accent',
  iconClassName = 'h-4 w-4',
}: {
  phone?: string | null;
  name?: string;
  /** Overrides the default "Call {name}" tooltip / aria-label. */
  title?: string;
  className?: string;
  iconClassName?: string;
}) {
  if (!phone) return null;
  const num = phone;
  const label = title ?? (name ? `Call ${name}` : 'Call');

  const handleCall = () => {
    if (canPlaceCall()) {
      window.location.href = `tel:${num}`;
      return;
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(num).then(
        () => toast.success(`Phone number copied — ${num}`),
        () => toast(`Phone: ${num}`, { icon: '📞' }),
      );
    } else {
      toast(`Phone: ${num}`, { icon: '📞' });
    }
  };

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        handleCall();
      }}
      title={label}
      aria-label={label}
      className={className}
    >
      <Phone className={iconClassName} />
    </button>
  );
}
