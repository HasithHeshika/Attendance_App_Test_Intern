'use client';
import { useEffect, useState } from 'react';
import { ArrowRightLeft, Loader2, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { cn } from '@/lib/utils';
import { useT } from '@/store/appStore';
import { mealOf, type MealType } from '@/lib/meals';
import type { LunchRequest, MealChangeKind } from '@/lib/types';
import { createMealChangeRequest } from '@/services/mealChangeService';
import type { Actor } from '@/services/mealService';
import type { ChamaryWithPlace } from '@/services/workingPlaceService';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import Select from '@/components/Select';
import { prettyDateShort } from '@/components/chamary/chamaryFormat';

interface Props {
  booking:   LunchRequest | null;
  chamaries: ChamaryWithPlace[];
  actor:     Actor;
  onClose:   () => void;
  onDone:    () => void | Promise<void>;
}

// Asking for a past booking to be removed or moved.
//
// This is the only way round the wall in MealDayPanel, and it is deliberately a request rather
// than an edit: the meal was cooked and billed on the strength of the list, so the count only
// moves once the person who ran that kitchen says it should.
export default function MealChangeDialog({ booking, chamaries, actor, onClose, onDone }: Props) {
  const t = useT();
  const [kind, setKind]     = useState<MealChangeKind>('remove');
  const [toId, setToId]     = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy]     = useState(false);

  useEffect(() => { if (booking) { setKind('remove'); setToId(''); setReason(''); } }, [booking]);

  if (!booking) return null;

  const mealName: Record<MealType, string> = {
    breakfast: t.mealBreakfast, lunch: t.mealLunch, dinner: t.mealDinner,
  };
  const meal         = mealOf(booking.meal);
  const owner        = chamaries.find(c => c.id === booking.chamary_id);
  const destinations = chamaries.filter(c => c.id !== booking.chamary_id);

  const submit = async () => {
    setBusy(true);
    try {
      const to = chamaries.find(c => c.id === toId);
      await createMealChangeRequest(
        {
          booking, kind, reason,
          to: kind === 'move' && to ? { chamary_id: to.id, chamary_name: to.name, meal } : undefined,
        },
        actor,
        owner?.responsible_epf ?? null,
      );
      toast.success(t.foodChangeSentToast);
      await onDone();
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t.foodChangeFailedToast);
    } finally { setBusy(false); }
  };

  const options: Array<{ kind: MealChangeKind; label: string; icon: typeof Trash2 }> = [
    { kind: 'remove', label: t.foodRemoveItWord, icon: Trash2 },
    { kind: 'move',   label: t.foodMoveItWord,   icon: ArrowRightLeft },
  ];

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{t.foodRequestChangeTitle}</DialogTitle>
          <DialogDescription>
            {t.foodChangeIntroTpl
              .replace('{meal}', mealName[meal])
              .replace('{date}', prettyDateShort(booking.date))
              .replace('{chamary}', booking.chamary_name)}
            {' '}
            {owner?.responsible_name
              ? t.foodDecidesTpl.replace('{name}', owner.responsible_name)
              : t.foodOwnerDecides}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2" role="group" aria-label={t.foodRequestChangeTitle}>
            {options.map(({ kind: k, label, icon: Icon }) => (
              <button
                key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k}
                className={cn(
                  'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  kind === k
                    ? 'border-primary bg-primary/10 font-semibold text-primary'
                    : 'border-border bg-card font-medium text-muted-foreground hover:bg-accent',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {label}
              </button>
            ))}
          </div>

          {kind === 'move' && (
            <div>
              <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">{t.foodMoveToLabel}</span>
              <Select
                value={toId}
                onChange={setToId}
                options={destinations.map(c => ({ value: c.id, label: `${c.name} · ${c.working_place_name}` }))}
              />
            </div>
          )}

          <div>
            <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">
              {t.foodWhyLabel} <span className="text-destructive">*</span>
            </span>
            <Input
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder={kind === 'remove' ? t.foodWhyRemoveHint : t.foodWhyMoveHint}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {t.foodChangeNeedsApproval}
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>{t.closeWord}</Button>
          <Button disabled={busy || !reason.trim() || (kind === 'move' && !toId)} onClick={submit}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t.foodSendForApproval}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
