'use client';
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, RotateCcw, Power, Check } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import { armMaintenance, cancelMaintenance } from '@/services/maintenanceService';
import {
  autoMaintenanceMessage, datetimeLocalValueToMs, defaultMaintenanceWindow, extendEndAtMs,
  formatWindowRange, msToDatetimeLocalValue, presetNowPlusHours, presetNowToSixAM, presetTonight,
  MAINTENANCE_KIND_LABEL, MAINTENANCE_MODE_LABEL,
  type MaintenanceAccessMode, type MaintenanceDoc, type MaintenanceKind, type MaintenanceWindow,
} from '@/lib/maintenance';
import { MAINTENANCE_KIND_ICON } from './maintenanceIcons';

const KINDS: MaintenanceKind[] = ['maintenance', 'upgrade', 'emergency'];
const MODES: MaintenanceAccessMode[] = ['readonly', 'block', 'lockdown'];
const EXTEND_CHIPS: { label: string; minutes: number }[] = [
  { label: '+30m', minutes: 30 },
  { label: '+1h', minutes: 60 },
  { label: '+2h', minutes: 120 },
  { label: '+12h', minutes: 12 * 60 },
];

interface Props {
  doc: MaintenanceDoc | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function MaintenanceControlPopup({ doc, open, onOpenChange }: Props) {
  const user = useAuthStore(s => s.user);

  const [window_, setWindow] = useState<MaintenanceWindow>(() => (
    doc ? { startAtMs: doc.startAtMs, endAtMs: doc.endAtMs } : defaultMaintenanceWindow(Date.now())
  ));
  const [kind, setKind] = useState<MaintenanceKind>(doc?.kind ?? 'maintenance');
  const [mode, setMode] = useState<MaintenanceAccessMode>(doc?.mode ?? 'block');
  const [message, setMessage] = useState(() => doc?.message ?? autoMaintenanceMessage(kind, window_.startAtMs, window_.endAtMs));
  const [autoMessage, setAutoMessage] = useState(!doc); // an already-armed doc starts as hand-authored
  const [notifyNow, setNotifyNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Re-seed the form whenever the popup is (re)opened, from whatever's currently armed.
  useEffect(() => {
    if (!open) return;
    const w = doc ? { startAtMs: doc.startAtMs, endAtMs: doc.endAtMs } : defaultMaintenanceWindow(Date.now());
    setWindow(w);
    setKind(doc?.kind ?? 'maintenance');
    setMode(doc?.mode ?? 'block');
    setAutoMessage(!doc);
    setMessage(doc?.message ?? autoMaintenanceMessage(doc?.kind ?? 'maintenance', w.startAtMs, w.endAtMs));
    setNotifyNow(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Auto-regenerate the message from kind + window until the admin hand-edits the textarea.
  useEffect(() => {
    if (!autoMessage) return;
    setMessage(autoMaintenanceMessage(kind, window_.startAtMs, window_.endAtMs));
  }, [autoMessage, kind, window_.startAtMs, window_.endAtMs]);

  const applyPreset = (w: MaintenanceWindow) => setWindow(w);
  const applyExtend = (minutes: number) => setWindow(w => ({ ...w, endAtMs: extendEndAtMs(w.endAtMs, minutes) }));

  const startValue = useMemo(() => msToDatetimeLocalValue(window_.startAtMs), [window_.startAtMs]);
  const endValue = useMemo(() => msToDatetimeLocalValue(window_.endAtMs), [window_.endAtMs]);

  const windowValid = window_.endAtMs > window_.startAtMs;
  const canSubmit = windowValid && message.trim().length > 0 && !saving;

  const handleUpdate = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await armMaintenance(
        { startAtMs: window_.startAtMs, endAtMs: window_.endAtMs, message, mode, kind, notifyNow },
        { epf: user?.epf_number ?? '', name: user?.name ?? 'Admin' },
      );
      toast.success('Maintenance window updated.');
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update maintenance.');
    } finally {
      setSaving(false);
    }
  };

  const handleCancelMaintenance = async () => {
    setCancelling(true);
    try {
      await cancelMaintenance();
      toast.success('Maintenance cancelled.');
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to cancel maintenance.');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="print:hidden max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Planned maintenance</DialogTitle>
          <DialogDescription>Arm, adjust, or cancel the app-wide maintenance window.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* ── Kind ───────────────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label>Kind</Label>
            <div className="grid grid-cols-3 gap-2">
              {KINDS.map(k => {
                const Icon = MAINTENANCE_KIND_ICON[k];
                const active = kind === k;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={cn(
                      'flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-xs font-medium transition-colors',
                      active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {MAINTENANCE_KIND_LABEL[k]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Window ─────────────────────────────────────────────────────── */}
          <div className="space-y-2">
            <Label>Window</Label>
            <div className="flex flex-wrap gap-1.5">
              <Button type="button" size="sm" variant="outline" onClick={() => applyPreset(presetTonight(Date.now()))}>
                Tonight 20:00 → 06:00
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => applyPreset(presetNowToSixAM(Date.now()))}>
                Now → 06:00
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => applyPreset(presetNowPlusHours(Date.now(), 1))}>
                Now +1h
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => applyPreset(presetNowPlusHours(Date.now(), 2))}>
                Now +2h
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="mnt-start" className="text-xs text-muted-foreground">Start</Label>
                <Input
                  id="mnt-start"
                  type="datetime-local"
                  value={startValue}
                  onChange={e => {
                    const ms = datetimeLocalValueToMs(e.target.value);
                    if (ms != null) setWindow(w => ({ ...w, startAtMs: ms }));
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="mnt-end" className="text-xs text-muted-foreground">End</Label>
                <Input
                  id="mnt-end"
                  type="datetime-local"
                  value={endValue}
                  onChange={e => {
                    const ms = datetimeLocalValueToMs(e.target.value);
                    if (ms != null) setWindow(w => ({ ...w, endAtMs: ms }));
                  }}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground mr-1">Extend end:</span>
              {EXTEND_CHIPS.map(c => (
                <Button key={c.minutes} type="button" size="sm" variant="secondary" onClick={() => applyExtend(c.minutes)}>
                  {c.label}
                </Button>
              ))}
            </div>

            <p className={cn('text-xs', windowValid ? 'text-muted-foreground' : 'text-destructive font-medium')}>
              {windowValid ? formatWindowRange(window_.startAtMs, window_.endAtMs) : 'End must be after start.'}
            </p>
          </div>

          {/* ── Access level ───────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label>Access level</Label>
            <div className="space-y-1.5">
              {MODES.map(m => {
                const active = mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                      active ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent',
                    )}
                  >
                    <span className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                      active ? 'border-primary bg-primary' : 'border-input',
                    )}>
                      {active && <Check className="h-2.5 w-2.5 text-primary-foreground" strokeWidth={3} />}
                    </span>
                    <span className="text-foreground">{MAINTENANCE_MODE_LABEL[m]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Message ────────────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="mnt-message">Message</Label>
              {!autoMessage && (
                <Button
                  type="button" size="sm" variant="ghost"
                  className="h-6 gap-1 px-2 text-xs text-muted-foreground"
                  onClick={() => setAutoMessage(true)}
                >
                  <RotateCcw className="h-3 w-3" /> Auto-write
                </Button>
              )}
            </div>
            <Textarea
              id="mnt-message"
              rows={3}
              value={message}
              onChange={e => { setMessage(e.target.value); setAutoMessage(false); }}
            />
          </div>

          {/* ── Notify ─────────────────────────────────────────────────────── */}
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Checkbox checked={notifyNow} onCheckedChange={v => setNotifyNow(v === true)} />
            Notify all users now
          </label>
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button" variant="destructive" onClick={handleCancelMaintenance}
            disabled={!doc?.enabled || cancelling} className="gap-2"
          >
            {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
            Cancel maintenance
          </Button>
          <Button type="button" onClick={handleUpdate} disabled={!canSubmit} className="gap-2">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Update
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
