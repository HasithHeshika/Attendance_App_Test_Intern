'use client';

import { useEffect, useState } from 'react';
import { Keyboard, X } from 'lucide-react';
import { useT } from '@/store/appStore';

// Versioned so a future change to the shortcuts can show the hint again to people who
// dismissed the old one.
const DISMISS_KEY = 'approvals:kbdhint:v1';

function readDismissed(): boolean {
  // A private window throws on the very first read — an unreadable store just means
  // "not dismissed", never a crash.
  try { return window.localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}

/** One line, once: the desktop keyboard review shortcuts. Dismissal persists per browser. */
export default function ApprovalsKeyboardHint() {
  const t = useT();
  // Starts hidden and appears after mount, so the server and first client render agree.
  const [show, setShow] = useState(false);

  useEffect(() => { if (!readDismissed()) setShow(true); }, []);

  if (!show) return null;

  const dismiss = () => {
    setShow(false);
    try { window.localStorage.setItem(DISMISS_KEY, '1'); } catch { /* nothing to persist to */ }
  };

  const Key = ({ children }: { children: string }) => (
    <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px] font-semibold text-foreground">{children}</kbd>
  );

  return (
    <div className="hidden items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground lg:flex">
      <Keyboard className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
      {/* English fallback — the shortcut hint has no translation key. */}
      <span className="min-w-0 flex-1">
        <Key>j</Key> <Key>k</Key> move · <Key>x</Key> select · <Key>a</Key> approve · <Key>r</Key> reject · <Key>Esc</Key> clear
      </span>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t.closeWord}
        className="flex-shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
