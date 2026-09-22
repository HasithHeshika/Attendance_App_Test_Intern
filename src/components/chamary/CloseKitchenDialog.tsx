'use client';
import { useEffect, useMemo, useState } from 'react';
import { CalendarOff, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { cn } from '@/lib/utils';
import { useT } from '@/store/appStore';
import type { AppUser, LunchRequest } from '@/lib/types';
import { chamaryMeals, MEAL_LABEL, type MealType } from '@/lib/meals';
import type { ChamaryWithPlace } from '@/services/workingPlaceService';
import {
  setMealOffdayRange, OFFDAY_RANGE_MAX_DAYS, type Actor,
} from '@/services/mealService';
import { getActiveSystemAdmins } from '@/services/userService';
import { createAppNotification } from '@/services/notificationService';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import SearchableSelect from '@/components/SearchableSelect';

interface Props {
  open:         boolean;
  onOpenChange: (open: boolean) => void;
  /** The chamaries this viewer may manage. */
  chamaries:    ChamaryWithPlace[];
  /** The chamary the page is scoped to, if any — the one to open on. */
  preselectedId: string;
  actor:        Actor;
  today:        string;
  /** Called once the closure has landed, so the month re-reads itself. */
  onDone:       () => void;
}

const spanDays = (from: string, to: string): number => {
  if (!from || !to || to < from) return 0;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const a = new Date(fy, fm - 1, fd).getTime();
  const b = new Date(ty, tm - 1, td).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
};

/**
 * Close a kitchen for a stretch of days — the shutdown, the site holiday, the cook on leave that
 * used to mean ticking "not cooking" once per day per meal, or (more often) not being recorded
 * at all until people turned up to a cold kitchen.
 *
 * Everything already booked inside the range is cancelled and those people are told, so the
 * dialog says so before the button is pressed, not after.
 */
export default function CloseKitchenDialog({
  open, onOpenChange, chamaries, preselectedId, actor, today, onDone,
}: Props) {
  const t = useT();
  const [chamaryId, setChamaryId] = useState('');
  const [from, setFrom]     = useState(today);
  const [to, setTo]         = useState(today);
  const [meals, setMeals]   = useState<MealType[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy]     = useState(false);

  const chamary = useMemo(() => chamaries.find(c => c.id === chamaryId) ?? null, [chamaries, chamaryId]);
  const mealName: Record<MealType, string> = {
    breakfast: t.mealBreakfast, lunch: t.mealLunch, dinner: t.mealDinner,
  };

  // Every open starts clean: the picked chamary, today, every meal it serves. A half-filled
  // form left over from a closure that was thought better of is how the wrong week gets closed.
  useEffect(() => {
    if (!open) return;
    const id = (preselectedId && chamaries.some(c => c.id === preselectedId))
      ? preselectedId
      : (chamaries[0]?.id ?? '');
    setChamaryId(id);
    setFrom(today); setTo(today);
    setMeals(chamaryMeals(chamaries.find(c => c.id === id)?.meals));
    setReason('');
  }, [open, preselectedId, chamaries, today]);

  const pickChamary = (id: string) => {
    setChamaryId(id);
    setMeals(chamaryMeals(chamaries.find(c => c.id === id)?.meals));
  };

  const span    = spanDays(from, to);
  const tooLong = span > OFFDAY_RANGE_MAX_DAYS;
  const valid   = !!chamary && span > 0 && !tooLong && meals.length > 0;

  const toggleMeal = (m: MealType) =>
    setMeals(list => (list.includes(m) ? list.filter(x => x !== m) : [...list, m]));

  // Same duty as the single-day path in MyChamaryLunchCard: whoever loses a booking hears about
  // it, and the system admins do too — the food deduction is theirs to answer for. One message
  // per person for the whole range, not one per cancelled day.
  const notifyClosure = async (name: string, days: number, cancelled: LunchRequest[]) => {
    const label = meals.map(m => MEAL_LABEL[m].toLowerCase()).join(' / ');
    const tail  = reason.trim() ? ` — ${reason.trim()}` : '';
    const when  = from === to ? `on ${from}` : `from ${from} to ${to}`;
    const title = from === to ? `No ${label} at ${name}` : `No ${label} at ${name} from ${from} to ${to}`;
    const perPerson = new Map<string, number>();
    for (const r of cancelled) perPerson.set(r.epf_number, (perPerson.get(r.epf_number) ?? 0) + 1);
    const admins = await getActiveSystemAdmins(actor.epf).catch(() => [] as AppUser[]);
    await Promise.all([
      ...[...perPerson].map(([toEpf, n]) => createAppNotification({
        toEpf, type: 'general', actorEpf: actor.epf, actorName: actor.name,
        title,
        body: `${name} is not cooking ${label} ${when}${tail}. ${n} booking(s) of yours have been cancelled.`,
        link: '/dashboard',
      })),
      ...admins.map(a => createAppNotification({
        toEpf: a.epf_number, type: 'general', actorEpf: actor.epf, actorName: actor.name,
        title,
        body: `${actor.name} closed ${name} for ${label} ${when} (${days} days)${tail}. ${cancelled.length} booking(s) cancelled.`,
        link: '/chamary',
      })),
    ]);
  };

  const submit = async () => {
    if (!chamary || !valid) return;
    setBusy(true);
    try {
      const { days, cancelled } = await setMealOffdayRange({
        chamary_id: chamary.id, chamary_name: chamary.name, from, to, meals, reason: reason.trim(),
      }, actor);
      await notifyClosure(chamary.name, days.length, cancelled);
      // English fallback — no TRANSLATIONS key for a range closure toast.
      toast.success(days.length === 1
        ? `Closed ${chamary.name} on ${from}.`
        : `Closed ${chamary.name} for ${days.length} ${t.daysWord}.`);
      onDone();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not close the kitchen.');
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          {/* "Close kitchen" has no TRANSLATIONS key — see the report. */}
          <DialogTitle className="flex items-center gap-2">
            <CalendarOff className="h-4 w-4 text-muted-foreground" aria-hidden />
            Close kitchen
          </DialogTitle>
          <DialogDescription>
            Mark a chamary as not cooking for a stretch of days — a shutdown, a site holiday, a cook on leave.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {chamaries.length > 1 && (
            <div>
              <div className="mb-1 text-xs font-medium text-foreground">{t.chamaryLabel}</div>
              <SearchableSelect
                value={chamaryId}
                onChange={pickChamary}
                ariaLabel={t.chamaryLabel}
                options={chamaries.map(c => ({
                  value: c.id, label: c.name, sublabel: c.working_place_name || undefined,
                }))}
                emptyLabel={t.noChamariesYet}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground" htmlFor="close-kitchen-from">
                {t.fromWord}
              </label>
              <Input
                id="close-kitchen-from"
                type="date"
                value={from}
                min={today}
                onChange={e => {
                  const v = e.target.value;
                  setFrom(v);
                  // An end before the start is not a range anyone means — carry it along.
                  if (v && to < v) setTo(v);
                }}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground" htmlFor="close-kitchen-to">
                {t.toWord}
              </label>
              <Input
                id="close-kitchen-to"
                type="date"
                value={to}
                min={from || today}
                onChange={e => setTo(e.target.value)}
              />
            </div>
          </div>

          <div className={cn('text-[11px] tabular-nums', tooLong ? 'text-destructive' : 'text-muted-foreground')}>
            {/* "N days" — English fallback around t.daysWord; the cap keeps a mistyped year
                from closing a kitchen for months. */}
            {span > 0 ? (span === 1 ? '1 day' : `${span} ${t.daysWord}`) : `${t.fromWord} / ${t.toWord}`}
            {tooLong && ` · at most ${OFFDAY_RANGE_MAX_DAYS} ${t.daysWord}`}
          </div>

          <div>
            <div className="mb-1 text-xs font-medium text-foreground">{t.mealsWord}</div>
            <div className="flex flex-wrap gap-2">
              {chamaryMeals(chamary?.meals).map(m => (
                <label
                  key={m}
                  className={cn(
                    'inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs transition-colors',
                    meals.includes(m) ? 'border-primary/40 bg-primary/10 font-medium text-foreground' : 'border-border text-muted-foreground hover:bg-accent',
                  )}
                >
                  <Checkbox
                    checked={meals.includes(m)}
                    onCheckedChange={() => toggleMeal(m)}
                    aria-label={mealName[m]}
                    className="h-3.5 w-3.5"
                  />
                  {mealName[m]}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-foreground" htmlFor="close-kitchen-reason">
              {t.offdayReasonLabel}
            </label>
            <Input
              id="close-kitchen-reason"
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <p className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
            Everyone already booked for these meals is cancelled and told.
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t.cancel}
          </Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={!valid || busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Close kitchen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
