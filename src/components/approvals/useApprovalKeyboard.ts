'use client';

import { useEffect, useRef } from 'react';

/** True when the keystroke belongs to something the user is typing in, or to a dialog. */
function shouldIgnore(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  const el = e.target as HTMLElement | null;
  const tag = el?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el?.isContentEditable) return true;
  // A modal owns the keyboard while it is open — never approve behind a dialog.
  if (typeof document !== 'undefined' && document.querySelector('[role="dialog"]')) return true;
  return false;
}

/**
 * Keyboard review for the approvals queue. Desktop only, and only while the detail pane is
 * actually on screen (on a phone the detail is a full-screen overlay and there is no keyboard).
 *
 *   j / ArrowDown   next record        k / ArrowUp   previous record
 *   x               tick the checkbox  a             approve the focused record
 *   r               reject it          Escape        clear the tick selection
 *
 * Handlers are read through a ref so a page that rebuilds its callbacks every render (this one
 * does) never has to re-bind the listener.
 */
export function useApprovalKeyboard({
  enabled,
  ids,
  focusedId,
  onFocus,
  onToggleCheck,
  onApprove,
  onReject,
  onClearSelection,
}: {
  enabled: boolean;
  /** Queue ids in display order. */
  ids: number[];
  focusedId: number | null;
  onFocus: (id: number) => void;
  onToggleCheck: (id: number) => void;
  onApprove: (id: number) => void;
  onReject: (id: number) => void;
  onClearSelection: () => void;
}) {
  const latest = useRef({ ids, focusedId, onFocus, onToggleCheck, onApprove, onReject, onClearSelection });
  latest.current = { ids, focusedId, onFocus, onToggleCheck, onApprove, onReject, onClearSelection };

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (shouldIgnore(e)) return;
      // Re-checked per keystroke, not once on mount: a window resized down to phone width
      // must stop responding to keys the same way the layout stops showing the detail pane.
      if (!window.matchMedia('(min-width: 1024px)').matches) return;

      const s = latest.current;
      const key = e.key;
      if (key === 'Escape') { s.onClearSelection(); return; }
      if (s.ids.length === 0) return;

      const move = key === 'j' || key === 'ArrowDown' ? 1 : key === 'k' || key === 'ArrowUp' ? -1 : 0;
      if (move !== 0) {
        e.preventDefault();
        const at = s.focusedId == null ? -1 : s.ids.indexOf(s.focusedId);
        const next = at < 0
          ? s.ids[move > 0 ? 0 : s.ids.length - 1]
          : s.ids[Math.min(s.ids.length - 1, Math.max(0, at + move))];
        if (next != null) {
          s.onFocus(next);
          // Keep the focused row visible inside the list column's own scroller.
          requestAnimationFrame(() => {
            document.querySelector(`[data-row-id="${next}"]`)?.scrollIntoView({ block: 'nearest' });
          });
        }
        return;
      }

      if (s.focusedId == null) return;
      if (key === 'x') { e.preventDefault(); s.onToggleCheck(s.focusedId); return; }
      if (key === 'a') { e.preventDefault(); s.onApprove(s.focusedId); return; }
      if (key === 'r') { e.preventDefault(); s.onReject(s.focusedId); return; }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

export default useApprovalKeyboard;
