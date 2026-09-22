'use client';
import { CalendarX2, Repeat, Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

// Shown when a scheduler removes a shift cell that was placed by a recurring pattern
// (ScheduleAssignment.pattern_id set). Two distinct outcomes, so a plain ConfirmModal won't
// do: drop just this date (leaves a tombstone the engine respects), or end the whole series
// from here on.
interface PatternOccurrenceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shiftName: string;
  dateLabel: string;
  weekdaysLabel: string;          // e.g. "Mon–Fri" — describeWeekdays(pattern.weekdays)
  busy: 'occurrence' | 'series' | null;
  onDeleteOccurrence: () => void | Promise<void>;
  onEndSeries: () => void | Promise<void>;
}

export default function PatternOccurrenceModal({
  open, onOpenChange, shiftName, dateLabel, weekdaysLabel, busy,
  onDeleteOccurrence, onEndSeries,
}: PatternOccurrenceModalProps) {
  const anyBusy = busy !== null;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!anyBusy && !o) onOpenChange(false); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Repeat className="w-4 h-4 text-primary" />
            Recurring {shiftName.toLowerCase() === 'day off' ? 'day off' : 'shift'}
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{shiftName}</span> on {dateLabel} is
            part of a repeating pattern ({weekdaysLabel}). What should change?
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <button
            type="button"
            disabled={anyBusy}
            onClick={onDeleteOccurrence}
            className="w-full flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-accent/30 disabled:opacity-50"
          >
            {busy === 'occurrence'
              ? <Loader2 className="w-4 h-4 mt-0.5 flex-shrink-0 animate-spin text-primary" />
              : <CalendarX2 className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />}
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">Delete this occurrence only</span>
              <span className="block text-[11px] text-muted-foreground">
                Removes {dateLabel}. The pattern keeps running and won&rsquo;t re-add this date.
              </span>
            </span>
          </button>

          <button
            type="button"
            disabled={anyBusy}
            onClick={onEndSeries}
            className="w-full flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-left transition-colors hover:border-destructive/50 hover:bg-destructive/10 disabled:opacity-50"
          >
            {busy === 'series'
              ? <Loader2 className="w-4 h-4 mt-0.5 flex-shrink-0 animate-spin text-destructive" />
              : <Repeat className="w-4 h-4 mt-0.5 flex-shrink-0 text-destructive" />}
            <span className="min-w-0">
              <span className="block text-sm font-medium text-destructive">End repeating series</span>
              <span className="block text-[11px] text-muted-foreground">
                Stops the pattern and clears every future date. Past dates stay on the roster.
              </span>
            </span>
          </button>
        </div>

        <DialogFooter>
          <Button variant="outline" className="flex-1" disabled={anyBusy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
