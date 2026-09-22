'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { UtensilsCrossed, Loader2, Check, MapPin, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import type { User } from '@/store/authStore';
import { useRoles } from '@/store/rolesStore';
import { useT } from '@/store/appStore';
import { categoryAllowed, roleCategory } from '@/lib/permissions';
import { localDateString, cn } from '@/lib/utils';
import { tenant } from '@/lib/firebase';
import {
  chamaryMeals, currentMealSlot, mealOf, mealOpenAt, mealWindow, formatMealTime, appMinutes,
  DAY_MINUTES, MEAL_LABEL, MEAL_ORDER, MEAL_TYPES, type MealType,
} from '@/lib/meals';
import { listAllChamaries, type ChamaryWithPlace } from '@/services/workingPlaceService';
import {
  requestMeal, cancelMeal, getMyMealsForDate, getChamaryOffdaysForDay, getChamaryMealsForDay,
  type Actor,
} from '@/services/mealService';
import type { LunchRequest } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

// The hint pops itself open once per page open/reload so the button is discoverable, then
// retracts. Hovering/tapping afterwards still shows it the normal way.
const HINT_MS = 5000;

// Compact "need a meal" action that lives in the Today-Attendance card header — next to the
// "Full View" link on the dashboard, and top-right of the card on /attendance (both pages
// render the same TodayCheckInOut card, so one placement covers both).
//
// Books the meal the app clock is currently in (see currentMealSlot) at a chamary that serves
// it AND is still taking names for it — each chamary sets its own cutoffs in Working Places
// (Chamary.slots; by default lunch closes at noon) — today only, never a future day. Self-gating, exactly like the RequestLunchCard it
// replaces: renders nothing unless the tenant has the suspense module and some chamary open to
// the signed-in user's category is actually cooking that meal today (see categoryAllowed —
// which chamaries that is depends on Chamary.categories, set in Working Places).
export default function LunchButton({ user, checkInSiteId, checkInPlaceName }: {
  user: User | null;
  checkInSiteId?: string | null;
  // Today's SCHEDULED working place name (independent of GPS) — used as a fallback suggestion
  // signal when checkInSiteId is null. checkInSiteId is a GPS-radius match computed once at
  // check-in time, which routinely comes up empty (imprecise fix, place radius too tight, no
  // coordinates configured for that place) even for a perfectly legitimate check-in.
  checkInPlaceName?: string | null;
}) {
  const t = useT();
  const router = useRouter();
  // Gate on the roles registry being loaded too — otherwise roleCategory can transiently
  // misclassify (fallback heuristics for a not-yet-seeded registry) and briefly show the button
  // (and fire its Firestore reads) for a non-eligible employee before the real roles land.
  const { roles, loaded: rolesLoaded } = useRoles();
  const myCategory = roleCategory(user?.role, roles);
  const eligible = tenant.features.suspense && rolesLoaded && !!user?.role;

  const epf    = user?.epf_number ?? '';
  const today  = localDateString();
  // Minute-of-day on the app clock, and the meal the DEFAULT slots put us in. `active` only
  // orders the fallback below; whether a given chamary is actually still taking names is that
  // chamary's own question, since each sets its own cutoffs (see bookableFor).
  const nowMin = appMinutes();
  const active = currentMealSlot();

  const [loading, setLoading]     = useState(true);
  // Every chamary open to this person's category, across all meals. Which of them can take a
  // booking is decided per meal below, because the meal itself is now chosen dynamically.
  const [allowed, setAllowed]     = useState<ChamaryWithPlace[]>([]);
  const [offByMeal, setOffByMeal] = useState<Record<MealType, Set<string>>>(
    () => Object.fromEntries(MEAL_TYPES.map(m => [m, new Set<string>()])) as Record<MealType, Set<string>>,
  );
  // meal → chamary id → WHO is down for it today. The head count is just this list's length:
  // the same read already returns the names, so keeping only a number meant throwing away the
  // answer to "who?" and then having no way to show it.
  const [rosters, setRosters]     = useState<Record<MealType, Record<string, LunchRequest[]>>>(
    () => Object.fromEntries(MEAL_TYPES.map(m => [m, {}])) as Record<MealType, Record<string, LunchRequest[]>>,
  );
  const [mine, setMine]           = useState<LunchRequest[]>([]);
  const [open, setOpen]           = useState(false);
  // "Who asked for lunch today?" — the roster behind the count pill.
  const [rosterOpen, setRosterOpen] = useState(false);
  const [pickedId, setPickedId]   = useState('');
  const [busy, setBusy]           = useState(false);
  const [hint, setHint]           = useState(false);

  useEffect(() => {
    if (!eligible || !epf) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    // Every chamary open to this person, across EVERY meal — the slot the clock reports is only
    // a starting point, since the meal it names may not be served to them today.
    // getChamaryOffdaysForDay returns all meals in one read, so covering all three costs one
    // call per chamary rather than one per chamary per meal.
    Promise.all([getMyMealsForDate(epf, today), listAllChamaries()])
      .then(async ([mineToday, all]) => {
        const open = all.filter(c => categoryAllowed(c.categories, myCategory));
        const [offs, day] = await Promise.all([
          Promise.all(open.map(c => getChamaryOffdaysForDay(c.id, today).catch(() => []))),
          Promise.all(open.map(c => getChamaryMealsForDay(c.id, today).catch(() => []))),
        ]);
        if (cancelled) return;

        const offs2 = {} as Record<MealType, Set<string>>;
        const rosters2 = {} as Record<MealType, Record<string, LunchRequest[]>>;
        MEAL_TYPES.forEach(m => { offs2[m] = new Set<string>(); rosters2[m] = {}; });
        open.forEach((c, i) => {
          offs[i].forEach(o => offs2[mealOf(o.meal)].add(c.id));
          day[i].forEach(r => {
            const m = mealOf(r.meal);
            (rosters2[m][c.id] ??= []).push(r);
          });
        });

        setAllowed(open);
        setOffByMeal(offs2);
        setRosters(rosters2);
        setMine(mineToday);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, epf, today, active, myCategory]);

  // Auto-reveal the hint once the data has landed — showing it while still loading would point
  // at a button that may yet render nothing. Cleared on unmount so a fast route change can't
  // leave a stray timer firing into an unmounted component.
  useEffect(() => {
    if (loading || !eligible) return;
    setHint(true);
    const id = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(id);
  }, [loading, eligible]);

  const scheduleNorm = checkInPlaceName?.trim().toLowerCase() || null;
  const siteId = checkInSiteId?.trim() || null;
  const hasLocation = !!(siteId || scheduleNorm);

  // Chamaries at today's working place — restricts to that location.
  const matchesLocation = (c: ChamaryWithPlace) =>
    !hasLocation ||
    (siteId && c.working_place_id === siteId) ||
    (scheduleNorm && c.working_place_name.trim().toLowerCase() === scheduleNorm);

  // Which chamaries can actually take a booking for a given meal: they serve it, they are not
  // off that day, they match the employee's location, and their ordering window is open.
  const openFor  = (c: ChamaryWithPlace, m: MealType) => mealOpenAt(m, nowMin, c.slots);
  const bookableFor = (m: MealType) =>
    allowed.filter(c =>
      matchesLocation(c) &&
      chamaryMeals(c.meals).includes(m) &&
      !offByMeal[m].has(c.id) &&
      openFor(c, m),
    );

  // The meal this button is about. The clock's slot wins when someone is actually cooking it,
  // but a person whose canteens serve no dinner should be offered lunch rather than nothing —
  // so fall back through the remaining meals, most recent first (dinner → lunch → breakfast).
  // An existing booking always wins outright: you must be able to see and cancel it.
  const mealOrder: MealType[] = [
    active,
    ...MEAL_TYPES.filter(m => m !== active).sort((a, b) => MEAL_ORDER[b] - MEAL_ORDER[a]),
  ];
  const myBooking = mine.find(r => mealOf(r.meal) === active) ?? mine[0] ?? null;
  const effective = myBooking ? mealOf(myBooking.meal)
    : (mealOrder.find(m => bookableFor(m).length > 0) ?? active);
  const existing  = mine.find(r => mealOf(r.meal) === effective) ?? null;

  const offIds    = offByMeal[effective];
  const bookable  = bookableFor(effective);

  // ONLY show available chamaries for that day, that location, and that role.
  // If the user already has a booking, keep it visible so they can review or cancel it.
  const chamaries = allowed.filter(c => {
    if (existing && existing.chamary_id === c.id) return true;
    if (!matchesLocation(c)) return false;
    if (!chamaryMeals(c.meals).includes(effective)) return false;
    const off = offIds.has(c.id);
    const closed = !openFor(c, effective);
    return !off && !closed;
  });

  const localAllowed = allowed.filter(matchesLocation);

  // "Order until 12:00 PM" for one chamary's window on this meal. Dinner runs to end of day,
  // which is not a cutoff worth printing — nothing closes at midnight in anyone's mind.
  const cutoffText = (c: ChamaryWithPlace) => {
    const { to } = mealWindow(effective, c.slots);
    return to < DAY_MINUTES ? t.orderUntil.replace('{time}', formatMealTime(to)) : null;
  };

  // Who is down for this meal today, and how many — across every chamary open to this person.
  const rosterFor = (chamaryId: string) => rosters[effective][chamaryId] ?? [];
  const countFor  = (chamaryId: string) => rosterFor(chamaryId).length;

  // The day's roster and count scoped to this location and role.
  const dayRosterFor = (chamaryId: string) =>
    MEAL_TYPES.flatMap(m => rosters[m][chamaryId] ?? []);
  const dayCountFor  = (chamaryId: string) => dayRosterFor(chamaryId).length;
  const totalToday   = localAllowed.reduce((n, c) => n + dayCountFor(c.id), 0);

  // Per-meal totals for the roster dialog's summary line — "Lunch 12 · Dinner 5" says more than
  // one lump sum when a site serves more than one meal.
  const perMealTotals = MEAL_TYPES
    .map(m => ({ meal: m, count: localAllowed.reduce((n, c) => n + (rosters[m][c.id] ?? []).length, 0) }))
    .filter(x => x.count > 0);

  const suggested = bookable.length === 1 ? bookable[0] : null;

  // The button never disappears. It used to hide itself once every chamary had passed its
  // cutoff, which read as the feature breaking — you cannot tell "nothing is open" apart from
  // "this is gone" by looking at an empty header. With nothing to book it becomes the way into
  // the food page instead, which is where the day's list, the month's cost and any correction
  // you need to ask for all live.
  if (!eligible || loading) return null;
  const canBook = bookable.length > 0 || !!existing;

  const mealName: Record<MealType, string> = {
    breakfast: t.mealBreakfast, lunch: t.mealLunch, dinner: t.mealDinner,
  };
  const label = mealName[effective];
  // Both strings carry a {meal} placeholder — substitute it the same way mealCancelledToast does.
  const needMeal = t.needMealToday.replace(/\{meal\}/g, label.toLowerCase());

  const openModal = () => {
    setHint(false);
    setPickedId(existing?.chamary_id ?? suggested?.id ?? (chamaries[0]?.id ?? ''));
    setOpen(true);
  };

  const submit = async () => {
    // Pick from the BOOKABLE set, not every chamary serving this meal: the list also shows the
    // ones that are off or past their cutoff, and a stale selection must not slip through.
    const ch = bookable.find(c => c.id === pickedId);
    if (!ch || !epf) return;
    const actor: Actor = { epf, name: user?.name ?? '' };
    setBusy(true);
    try {
      await requestMeal({
        epf_number: epf, employee_name: user?.name ?? '',
        company_id: user?.company_id ?? '', company_name: user?.company ?? '',
        date: today, meal: effective, chamary_id: ch.id, chamary_name: ch.name,
        working_place_id: ch.working_place_id, working_place_name: ch.working_place_name,
      }, actor);
      // Both placeholders, not just {meal} — see the same note on the attendance page.
      toast.success(
        t.mealRequestedToast
          .replace(/\{meal\}/g, label.toLowerCase())
          .replace(/\{chamary\}/g, ch.name),
      );
      // Re-read the day so both my booking AND the per-chamary head counts stay truthful —
      // a move between chamaries changes two counts, not one.
      const [fresh, day] = await Promise.all([
        getMyMealsForDate(epf, today),
        Promise.all(chamaries.map(c => getChamaryMealsForDay(c.id, today).catch(() => []))),
      ]);
      setMine(fresh);
      setRosters(prev => {
        const next = { ...prev, [effective]: { ...prev[effective] } };
        chamaries.forEach((c, i) => {
          next[effective][c.id] = day[i].filter(r => mealOf(r.meal) === effective);
        });
        return next;
      });
      setOpen(false);
    } catch (e) { toast.error(errMsg(e, t.failedRequestMeal)); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!epf) return;
    setBusy(true);
    try {
      await cancelMeal(epf, today, effective);
      toast.success(t.mealCancelledToast.replace(/\{meal\}/g, label.toLowerCase()));
      const gone = existing?.chamary_id;
      setMine(prev => prev.filter(r => mealOf(r.meal) !== effective));
      // Drop myself out of that chamary's list rather than decrementing a number — the roster
      // on screen has to lose the right name, not just get shorter.
      if (gone) setRosters(prev => ({
        ...prev,
        [effective]: {
          ...prev[effective],
          [gone]: (prev[effective][gone] ?? []).filter(r => r.epf_number !== epf),
        },
      }));
      setPickedId(''); setOpen(false);
    } catch (e) { toast.error(errMsg(e, t.failedCancelMeal)); }
    finally { setBusy(false); }
  };

  const booked = !!existing;

  return (
    <>
      {/* Two affordances, so two buttons: the meal name books, the count shows who. They were
          one control with the count nested inside it, which is invalid HTML (a button inside a
          button) and gave the number nothing to do. Kept visually joined — the divider reads as
          one segmented pill. */}
      <div className={cn(
        'inline-flex h-7 items-center overflow-hidden rounded-md border text-xs',
        booked ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-transparent text-foreground',
      )}>
      <TooltipProvider>
        <Tooltip open={hint} onOpenChange={setHint}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={canBook ? openModal : () => router.push('/food')}
              aria-label={canBook ? (booked ? t.mealBookedToday : needMeal) : t.viewAllFood}
              className={cn(
                'inline-flex h-full items-center gap-1.5 px-2.5 font-medium transition-colors',
                booked ? 'hover:bg-primary/90' : 'hover:bg-accent',
              )}
            >
              {booked
                ? <Check className="h-3.5 w-3.5" />
                : <UtensilsCrossed className="h-3.5 w-3.5" />}
              {canBook ? label : t.navFood}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" className="max-w-[15rem]">
            {booked
              ? `You're down for ${label.toLowerCase()} at ${existing!.chamary_name} today.${totalToday > 1 ? ` ${totalToday} people requested it.` : ''}`
              : canBook
                ? `${needMeal} ${t.pickChamaryHint}${totalToday > 0 ? ` ${totalToday} requested so far.` : ''}`
                : `Ordering is closed for now — open your food page for today's list, this month's cost, and to ask for a correction.`}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Today's head count — click it to see the names behind the number. */}
      {totalToday > 0 && (
        <button
          type="button"
          onClick={() => setRosterOpen(true)}
          title={t.seeWhoRequested}
          aria-label={t.seeWhoRequested}
          className={cn(
            'inline-flex h-full items-center border-l px-2 font-semibold tabular-nums transition-colors',
            booked ? 'border-primary-foreground/25 hover:bg-primary/80' : 'border-border hover:bg-accent',
          )}
        >
          <Users className="mr-1 h-3 w-3" aria-hidden="true" />
          {totalToday}
        </button>
      )}
      </div>

      {/* Who asked for this meal today. Grouped by chamary because that is the unit the kitchen
          cooks for; within a group, the service already returns names sorted. Nothing here is
          actionable — removing someone is the responsible person's job, on /chamary. */}
      <Dialog open={rosterOpen} onOpenChange={setRosterOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4 text-primary" />
              {t.seeWhoRequested}
            </DialogTitle>
            <DialogDescription>
              {/* The day's own breakdown — "18 today · Lunch 12 · Dinner 6" — because a site
                  serving two meals has two lists, and one total hides which is which. */}
              {t.mealRequestedCount
                .replace('{count}', String(totalToday))
                .replace(/\{meal\}/g, t.mealsWord.toLowerCase())}
              {perMealTotals.length > 1 && (
                <span className="mt-0.5 block text-[11px] tabular-nums">
                  {perMealTotals.map(x => `${MEAL_LABEL[x.meal]} ${x.count}`).join(' · ')}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          {totalToday === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">{t.noOneRequestedYet}</p>
          ) : (
            <div className="-mx-1 max-h-72 space-y-4 overflow-y-auto px-1 py-1">
              {/* Meal first, chamary second: a site that serves lunch AND dinner has two
                  different lists, and merging them would say nothing useful about either. */}
              {perMealTotals.map(({ meal: m, count }) => (
                <div key={m}>
                  <div className="mb-1.5 flex items-baseline gap-2 border-b border-border/60 pb-1">
                    <span className="text-xs font-semibold text-foreground">{MEAL_LABEL[m]}</span>
                    <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>
                  </div>
                  <div className="space-y-2.5">
                    {localAllowed
                      .filter(c => (rosters[m][c.id] ?? []).length > 0)
                      .map(c => (
                        <div key={c.id}>
                          <div className="mb-1 flex items-baseline gap-2">
                            <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">{c.name}</span>
                            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{(rosters[m][c.id] ?? []).length}</span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {(rosters[m][c.id] ?? []).map(r => {
                              const isMe = r.epf_number === epf;
                              return (
                                <span
                                  key={r.epf_number}
                                  title={r.epf_number}
                                  className={cn(
                                    'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs',
                                    isMe
                                      ? 'border-primary/40 bg-primary/10 font-medium text-primary'
                                      : 'border-border bg-muted/40 text-foreground',
                                  )}
                                >
                                  {r.served && <Check className="h-3 w-3 shrink-0 text-success" aria-hidden="true" />}
                                  {r.employee_name}
                                  {isMe && <span className="text-[10px] font-normal opacity-80">· {t.youWord}</span>}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <UtensilsCrossed className="h-4 w-4 text-primary" />
              {label} · {needMeal}
            </DialogTitle>
            <DialogDescription>
              {booked
                ? `You're currently down for ${label.toLowerCase()} at ${existing!.chamary_name}. Pick a different chamary to move, or cancel the request.`
                : t.chooseChamaryForMeal.replace(/\{meal\}/g, label.toLowerCase())}
            </DialogDescription>
          </DialogHeader>

          {chamaries.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {checkInPlaceName
                ? `No available chamaries at ${checkInPlaceName} for ${label.toLowerCase()} today.`
                : t.noChamariesYet}
            </p>
          ) : (
            <div className="-mx-1 max-h-64 space-y-1.5 overflow-y-auto px-1 py-1">
              {chamaries.map(c => {
                const off    = offIds.has(c.id);
                // Past this chamary's cutoff for this meal — shown, but not pickable, so the
                // reason the option is gone is visible rather than the row simply vanishing.
                const closed = !off && !openFor(c, effective);
                const dead   = off || closed;
                const picked = pickedId === c.id;
                const until  = cutoffText(c);
                return (
                  <button
                    key={c.id}
                    type="button"
                    disabled={dead}
                    onClick={() => setPickedId(c.id)}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors',
                      dead
                        ? 'cursor-not-allowed border-dashed border-border bg-muted/20 opacity-60'
                        : picked
                          ? 'border-primary bg-primary/10'
                          : 'border-border bg-muted/30 hover:bg-muted/60',
                    )}
                  >
                    <span className={cn(
                      'mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2',
                      picked && !dead ? 'border-primary' : 'border-muted-foreground/40',
                    )}>
                      {picked && !dead && <span className="h-2 w-2 rounded-full bg-primary" />}
                    </span>
                    {/* One text column, and everything else — place, cutoff, head count, status —
                        wraps beneath the name. A pill row pinned to the right edge instead ate
                        the width the name needed, so "Colombo Executive chamary" read as
                        "Colombo Executive cha…" beside a place truncated to "Co…". */}
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="block break-words text-sm font-medium leading-snug text-foreground">{c.name}</span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                          <MapPin className="h-3 w-3 flex-shrink-0" />
                          <span className="truncate">{c.working_place_name}</span>
                        </span>
                        {until && <span className="whitespace-nowrap tabular-nums">{until}</span>}
                        {/* How many are already down for this meal here — the practical question
                            when choosing between canteens. Hidden at zero rather than shown as
                            "0", which reads as a defect rather than an empty list. */}
                        {!dead && countFor(c.id) > 0 && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground"
                            title={`${countFor(c.id)} requested ${label.toLowerCase()} here today`}
                          >
                            <Users className="h-3 w-3" aria-hidden="true" />
                            {countFor(c.id)}
                          </span>
                        )}
                        {off || closed ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {off ? t.notCookingWord : t.closedNowWord}
                          </span>
                        ) : suggested?.id === c.id && (
                          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                            Suggested
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" size="sm" className="sm:mr-auto"
              onClick={() => { setOpen(false); router.push('/food'); }}>
              {t.viewAllFood}
            </Button>
            {booked && (
              <Button variant="outline" disabled={busy} onClick={cancel}>
                {t.cancelMealWord}
              </Button>
            )}
            <Button
              disabled={busy || !pickedId || pickedId === existing?.chamary_id || !bookable.some(c => c.id === pickedId)}
              onClick={submit}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : booked ? t.moveHereWord : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
