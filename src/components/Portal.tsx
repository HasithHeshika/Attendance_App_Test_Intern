'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders children into <body> via a portal.
 *
 * Modals use `fixed inset-0` to cover the whole screen, but a `fixed` element is
 * positioned relative to the nearest ancestor that has a transform/filter/contain
 * (a "containing block") instead of the viewport. When that happens the backdrop
 * starts below the header instead of at the very top of the page. Portaling to
 * <body> sidesteps any such ancestor so the overlay always fills the viewport.
 */
export default function Portal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
