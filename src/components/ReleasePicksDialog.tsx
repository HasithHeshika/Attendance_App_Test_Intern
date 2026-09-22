'use client';
import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { RotateCcw, UserCheck, Clock, CheckCircle2, Loader2 } from 'lucide-react';
import { _attendanceApi as attendanceApi } from '@/services/apiCompat';
import { useT } from '@/store/appStore';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

type PickedRow = {
  docId: string;
  sessionId: string;
  epf_number: string;
  name: string;
  role?: string;
  check_in?: string | null;
  site_name?: string | null;
  picked_by?: string | null;
};

const fmtTime = (s?: string | null): string => {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T'));
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/**
 * Shown when an executive tries to check out while still holding picked technicians.
 * They can't check out until everyone they picked is released — this lists those
 * technicians with Release buttons, then enables "Check out now" once the team is clear.
 */
export default function ReleasePicksDialog({
  open,
  onOpenChange,
  supervisorEpf,
  onCheckout,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supervisorEpf: string;
  onCheckout: () => void | Promise<void>;
}) {
  const t = useT();
  const [picks, setPicks] = useState<PickedRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);

  const refresh = useCallback(async () => {
    if (!supervisorEpf) return;
    setLoading(true);
    try {
      const res = await attendanceApi.getCheckedInToday(supervisorEpf);
      const rows = ((res as { data?: { data?: PickedRow[] } })?.data?.data ?? []);
      setPicks(rows.filter(r => String(r.picked_by ?? '') === String(supervisorEpf)));
    } catch {
      /* keep the previous list — a failed refresh shouldn't blank the dialog */
    }
    setLoading(false);
  }, [supervisorEpf]);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  const release = async (row: PickedRow) => {
    setBusyId(row.sessionId);
    try {
      await attendanceApi.releaseTechnician({ supervisorEpf, docId: row.docId, sessionId: row.sessionId });
      toast.success(`${t.releasedToast} ${row.name}`);
      await refresh();
    } catch (e) {
      toast.error((e as Error)?.message ?? t.checkOutFailed);
    }
    setBusyId(null);
  };

  const releaseAll = async () => {
    setBusyId('__all__');
    try {
      for (const row of picks) {
        await attendanceApi.releaseTechnician({ supervisorEpf, docId: row.docId, sessionId: row.sessionId });
      }
      toast.success(t.releasePicksClear);
    } catch (e) {
      toast.error((e as Error)?.message ?? t.checkOutFailed);
    }
    await refresh();
    setBusyId(null);
  };

  const proceed = async () => {
    setCheckingOut(true);
    onOpenChange(false);
    try { await onCheckout(); } finally { setCheckingOut(false); }
  };

  const allClear = !loading && picks.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.releasePicksTitle}</DialogTitle>
          <DialogDescription>{allClear ? t.releasePicksClear : t.releasePicksDesc}</DialogDescription>
        </DialogHeader>

        <div className="max-h-72 space-y-2 overflow-y-auto scrollbar-thin">
          {loading && picks.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : allClear ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success/10 text-success">
                <CheckCircle2 className="h-5 w-5" />
              </span>
              <p className="text-sm text-muted-foreground">{t.releasePicksClear}</p>
            </div>
          ) : (
            picks.map(row => (
              <div key={row.sessionId} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                    <UserCheck className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{row.name}</p>
                    <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Clock className="h-3 w-3" />{fmtTime(row.check_in)}
                      {row.site_name ? ` · ${row.site_name}` : ''}
                    </p>
                  </div>
                </div>
                <Button size="sm" variant="outline" disabled={!!busyId} onClick={() => release(row)}>
                  {busyId === row.sessionId
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <><RotateCcw className="mr-1 h-3.5 w-3.5" />{t.releaseAction}</>}
                </Button>
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          {picks.length > 1 && (
            <Button variant="outline" onClick={releaseAll} disabled={!!busyId}>
              {busyId === '__all__' ? <Loader2 className="h-4 w-4 animate-spin" /> : t.releaseAll}
            </Button>
          )}
          <Button onClick={proceed} disabled={!allClear || checkingOut}>
            {checkingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : t.checkOutNow}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
