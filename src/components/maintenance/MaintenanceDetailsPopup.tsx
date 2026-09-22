'use client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Settings, User, CalendarClock } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  formatCountdown, formatWindowRange, MAINTENANCE_KIND_LABEL,
  type MaintenanceDoc,
} from '@/lib/maintenance';
import { MAINTENANCE_KIND_ICON, MAINTENANCE_KIND_ACCENT } from './maintenanceIcons';
import MaintenanceMessage from './MaintenanceMessage';

interface Props {
  doc: MaintenanceDoc;
  nowMs: number;
  phase: 'scheduled' | 'active';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
  onJumpToControls: () => void;
}

// Read-only — opened by clicking the countdown banner. Admins additionally get a shortcut into
// the (write) control popup.
export default function MaintenanceDetailsPopup({
  doc, nowMs, phase, open, onOpenChange, isAdmin, onJumpToControls,
}: Props) {
  const Icon = MAINTENANCE_KIND_ICON[doc.kind];
  const accent = MAINTENANCE_KIND_ACCENT[doc.kind];
  const targetMs = phase === 'scheduled' ? doc.startAtMs : doc.endAtMs;
  const remaining = targetMs - nowMs;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="print:hidden max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', accent.bg, accent.text)}>
              <Icon className="h-5 w-5" />
            </span>
            {MAINTENANCE_KIND_LABEL[doc.kind]}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className={cn('rounded-xl p-5 text-center', accent.bg)}>
            <div className={cn('text-[11px] font-semibold uppercase tracking-wider', accent.text)}>
              {phase === 'scheduled' ? 'Starts in' : 'Ends in'}
            </div>
            <div className="mt-1 text-4xl font-bold tabular-nums text-foreground">{formatCountdown(remaining)}</div>
          </div>

          <MaintenanceMessage message={doc.message} className="text-sm leading-relaxed text-foreground" />

          <div className="flex items-center gap-2.5 rounded-lg border border-border px-3.5 py-2.5 text-sm text-muted-foreground">
            <CalendarClock className="h-4 w-4 shrink-0" />
            {formatWindowRange(doc.startAtMs, doc.endAtMs)}
          </div>

          {doc.createdByName && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <User className="h-3.5 w-3.5" />
              Scheduled by <Badge variant="outline">{doc.createdByName}</Badge>
            </div>
          )}
        </div>

        {isAdmin && (
          <DialogFooter>
            <Button variant="outline" onClick={onJumpToControls} className="gap-2">
              <Settings className="h-4 w-4" /> Jump to controls
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
