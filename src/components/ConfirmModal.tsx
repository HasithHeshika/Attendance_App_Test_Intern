'use client';
import type { ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export type ConfirmVariant = 'danger' | 'warning';

interface ConfirmModalProps {
  open: boolean;
  /** Called with `false` when the modal should close (Cancel, X, Esc, backdrop). */
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
  title: ReactNode;
  description?: ReactNode;
  /** Confirm button label. Defaults: "Delete" (danger) / "Confirm" (warning). */
  confirmText?: string;
  cancelText?: string;
  /** 'danger' — red, for deletes (default). 'warning' — amber, for deactivate/reversible. */
  variant?: ConfirmVariant;
  /** While true: spinner on the confirm button, both buttons disabled, dismissal blocked. */
  busy?: boolean;
}

// App-wide confirmation dialog for destructive / consequential actions — replaces
// window.confirm(). Built on the shared Dialog primitives (focus trap, Esc, portal,
// a11y). Keep the copy specific ("Delete <name>?") and put the consequence in
// `description`.
export default function ConfirmModal({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmText,
  cancelText = 'Cancel',
  variant = 'danger',
  busy = false,
}: ConfirmModalProps) {
  const isDanger = variant === 'danger';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return; // never dismiss mid-action
        if (!o) onOpenChange(false);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <span
              className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${
                isDanger ? 'bg-destructive/10 text-destructive' : 'bg-warning/10 text-warning'
              }`}
            >
              <AlertTriangle className="h-4 w-4" />
            </span>
            <span className="min-w-0">{title}</span>
          </DialogTitle>
          {description && (
            <DialogDescription className="pt-1">{description}</DialogDescription>
          )}
        </DialogHeader>

        <DialogFooter>
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {cancelText}
          </Button>
          <Button
            variant={isDanger ? 'destructive' : 'default'}
            className={`flex-1 ${isDanger ? '' : 'bg-warning text-warning-foreground hover:bg-warning/90'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {confirmText ?? (isDanger ? 'Delete' : 'Confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
