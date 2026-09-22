'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Info, KeyRound } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useT } from '@/store/appStore';

interface NewPasswordDialogProps {
  /** The generated password. The dialog is open whenever this is non-null. */
  password: string | null;
  /** Overrides the heading — a brand-new account reads differently from a reset. */
  title?: string;
  /** Whose password it is — an admin working through several people must not mix two up. */
  accountLabel?: string;
  /** One extra line: where a verification or reset mail went, or how they sign in. */
  note?: string | null;
  onClose: () => void;
}

// Selects an element's text and asks the document to copy it. The clipboard API is the
// primary path; this is the fallback for insecure contexts and old WebViews. Selecting
// the on-screen node (rather than a detached textarea) keeps focus inside the dialog, so
// Radix's focus trap can't pull focus away before the copy runs — and it leaves the
// password highlighted for a manual Ctrl+C when even this fails.
function selectAndCopy(el: HTMLElement | null): boolean {
  if (!el) return false;
  const sel = window.getSelection();
  if (!sel) return false;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

// Shown once, right after an admin resets someone's password. The server generates the
// password per request and never stores it, so this dialog is the only place it exists —
// which is why it has no close affordance (no X, no Esc, no backdrop dismiss) until it
// has been copied. A stray click would otherwise lose it for good.
export default function NewPasswordDialog({
  password,
  title,
  accountLabel,
  note,
  onClose,
}: NewPasswordDialogProps) {
  const tr = useT();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const valueRef = useRef<HTMLDivElement>(null);
  const open = password !== null;

  // A second reset while the dialog is still mounted must re-arm the gate.
  useEffect(() => {
    setCopied(false);
    setCopyFailed(false);
  }, [password]);

  const handleCopy = useCallback(async () => {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setCopyFailed(false);
      return;
    } catch {
      // No clipboard API, an insecure origin, or a denied permission — try the old way.
    }
    if (selectAndCopy(valueRef.current)) {
      setCopied(true);
      setCopyFailed(false);
      return;
    }
    // Both paths failed. The text is now selected for a manual copy, and the footer
    // offers an explicit acknowledgement — a dialog nobody can close is worse than no gate.
    setCopyFailed(true);
  }, [password]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && copied) onClose();
      }}
    >
      <DialogContent
        className="max-w-md"
        hideClose={!copied}
        closeLabel={tr.closeWord}
        onEscapeKeyDown={(e) => {
          if (!copied) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (!copied) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-warning/10 text-warning">
              <KeyRound className="h-4 w-4" />
            </span>
            <span className="min-w-0">{title ?? tr.newPasswordTitle}</span>
          </DialogTitle>
          <DialogDescription className="pt-1">{tr.newPasswordDesc}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {accountLabel && (
            <div className="text-[11px] text-muted-foreground break-all">
              {tr.newPasswordFor.replace('{who}', accountLabel)}
            </div>
          )}

          <div
            ref={valueRef}
            onClick={() => selectAndCopy(valueRef.current)}
            className="select-all cursor-text break-all rounded-xl border border-border bg-muted/40 px-4 py-3 text-center font-mono text-lg font-semibold tracking-[0.15em] text-foreground"
          >
            {password}
          </div>

          <Button
            onClick={handleCopy}
            variant={copied ? 'outline' : 'default'}
            className="w-full"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? tr.passwordCopied : tr.copyPassword}
          </Button>

          {copyFailed && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
              {tr.copyFailedManual}
            </div>
          )}

          {note && (
            <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
              <Info className="mt-px h-3.5 w-3.5 flex-shrink-0" />
              <span className="break-all">{note}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          {copied ? (
            <Button variant="outline" className="w-full sm:w-auto" onClick={onClose}>
              {tr.doneWord}
            </Button>
          ) : copyFailed ? (
            <Button variant="outline" className="w-full sm:w-auto" onClick={onClose}>
              {tr.copiedManually}
            </Button>
          ) : (
            <p className="text-[11px] text-muted-foreground sm:self-center">
              {tr.copyToContinue}
            </p>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
