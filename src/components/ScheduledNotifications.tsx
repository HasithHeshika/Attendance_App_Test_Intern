'use client';
// Manage scheduled (one-time) notifications: see upcoming + recent ones and cancel a
// pending one before the dispatch cron fires it. Gated by `can_send_notifications`.

import { useEffect, useState } from 'react';
import { Loader2, Clock, Users, User, X, CalendarClock } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  listScheduledNotifications, cancelScheduledNotification,
  type ScheduledNotification, type ScheduledStatus,
} from '@/services/scheduledNotificationService';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

const STATUS_STYLE: Record<ScheduledStatus, string> = {
  pending:  'border-primary/30 bg-primary/10 text-primary',
  sending:  'border-primary/30 bg-primary/10 text-primary',
  sent:     'border-success/30 bg-success/10 text-success',
  canceled: 'border-border bg-muted text-muted-foreground',
  failed:   'border-destructive/30 bg-destructive/10 text-destructive',
};
const STATUS_LABEL: Record<ScheduledStatus, string> = {
  pending: 'Scheduled', sending: 'Sending', sent: 'Sent', canceled: 'Canceled', failed: 'Failed',
};

function fmt(ts: { toDate: () => Date } | null): string {
  try { return ts ? ts.toDate().toLocaleString() : '—'; } catch { return '—'; }
}

export default function ScheduledNotifications({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [items, setItems] = useState<ScheduledNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [cancelingId, setCancelingId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    listScheduledNotifications()
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { if (open) load(); }, [open]);

  const cancel = async (id: string) => {
    setCancelingId(id);
    try {
      await cancelScheduledNotification(id);
      toast.success('Canceled');
      setItems(prev => prev.map(i => i.id === id ? { ...i, status: 'canceled' } : i));
    } catch {
      toast.error('Failed to cancel');
    } finally {
      setCancelingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-primary" />
            Scheduled notifications
          </DialogTitle>
          <DialogDescription>Upcoming and recent one-time sends. Cancel a scheduled one before it fires.</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
              <Clock className="h-8 w-8 opacity-40" />
              Nothing scheduled yet.
            </div>
          ) : (
            items.map(n => {
              const status = (n.status ?? 'pending') as ScheduledStatus;
              const canCancel = status === 'pending' || status === 'sending';
              return (
                <div key={n.id} className="rounded-xl border border-border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">{n.title || '(no title)'}</p>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body}</p>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[status]}`}>
                      {STATUS_LABEL[status]}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" />{fmt(n.send_at)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      {n.audience === 'all'
                        ? <><Users className="h-3 w-3" />Everyone</>
                        : <><User className="h-3 w-3" />{n.recipient_count} {n.recipient_count === 1 ? 'person' : 'people'}</>}
                    </span>
                    {status === 'failed' && n.error && <span className="text-destructive">· {n.error}</span>}
                  </div>
                  {canCancel && (
                    <div className="mt-2 flex justify-end">
                      <Button variant="outline" size="sm" onClick={() => cancel(n.id)} disabled={cancelingId === n.id} className="h-7 gap-1 text-xs">
                        {cancelingId === n.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
