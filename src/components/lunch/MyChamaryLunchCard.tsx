import { useEffect, useState, useCallback, type ElementType, type ReactNode } from 'react';
import {
  UtensilsCrossed, Plus, X, Ban, CookingPot, Sunrise, Sun, Moon, Check, UserPlus, MapPin,
  CheckSquare, Square, CheckCheck, Trash2, AlertCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import type { User } from '@/store/authStore';
import type { AppUser, ChamaryMealOffday, LunchRequest } from '@/lib/types';
import { localDateString, cn } from '@/lib/utils';
import { tenant } from '@/lib/firebase';
import { useT } from '@/store/appStore';
import { useRoles, useUserCapabilities } from '@/store/rolesStore';
import { categoryAllowed, roleCategory } from '@/lib/permissions';
import { chamaryMeals, mealOf, MEAL_LABEL, type MealType } from '@/lib/meals';
import { MEAL_MULTIPLIERS, multiplierOf, type MealMultiplier } from '@/lib/foodCost';
import { listAllChamaries, type ChamaryWithPlace } from '@/services/workingPlaceService';
import {
  requestMeal, cancelMeal, setMealServed, getMyMealForDate, getChamaryMealsForDay,
  getChamaryOffdaysForDay, setMealOffday, clearMealOffday, setMealMultiplier, type Actor,
} from '@/services/mealService';
import { getAllEmployees, getActiveSystemAdmins } from '@/services/userService';
import { createAppNotification } from '@/services/notificationService';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import SearchableSelect, { type SearchOption } from '@/components/SearchableSelect';
import { Reveal } from '@/components/ui/motion';
import ConfirmModal from '@/components/ConfirmModal';
import { dayPhase, mealInitial, prettyDateShort } from '@/components/chamary/chamaryFormat';
import MultiplierBadge, { useMultiplierWord } from '@/components/food/MultiplierBadge';

function MealIcon({ meal, className = 'h-3.5 w-3.5' }: { meal: MealType; className?: string }) {
  if (meal === 'breakfast') return <Sunrise className={className} aria-hidden />;
  if (meal === 'lunch') return <Sun className={className} aria-hidden />;
  return <Moon className={className} aria-hidden />;
}

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

// For whoever runs a chamary (any role — set as `responsible_epf` in Working Places, not a
// capability): one day's list for their chamary(ies), with add/remove, a served tick per person,
// and a "not cooking" switch. Self-gating and self-contained — safe to always mount; renders
// nothing for the vast majority of users who aren't responsible for any chamary.
//
// Information-first: a chamary is ONE header row, and only the meals that have someone booked or
// are closed get a row of their own. Meals with nothing to say collapse into a single line of
// ghost buttons ("+ Breakfast") that opens that meal's row when there IS something to add — a
// three-meal canteen that only cooks lunch used to print two empty blocks, each with its own
// picker and its own "Mark not cooking" line, and drown the one list that mattered.
//
// The dashboard mounts it bare=false (today, my own chamaries). The /chamary page drives the same
// component with an explicit day and an explicit chamary set, which is how a food admin who
// runs no canteen at all gets to manage one.
export default function MyChamaryLunchCard({ user, date, chamaries: chamariesProp, search = '', title, onChanged, bare = false }: {
  user: User | null;
  /** Called after any add / remove / served-tick / not-cooking change lands, so a parent that
   *  also holds month-level counts (the /chamary calendar) can re-read them. */
  onChanged?: () => void;
  /** Render without the outer Card and title — for a parent that supplies its own frame. */
  bare?: boolean;
  /** Day being managed. Defaults to today. */
  date?: string;
  /** Chamaries to show. Defaults to every chamary this user is responsible for. */
  chamaries?: ChamaryWithPlace[];
  /** Narrow the names shown to a search string; counts and duplicate checks still use the
   *  whole list, so filtering can never make someone look un-booked. */
  search?: string;
  title?: string;
}) {
  const t     = useT();
  const epf   = user?.epf_number ?? '';
  const today = date ?? localDateString();
  // Identity of the passed-in set, so the effect re-runs when the caller changes WHICH
  // chamaries it wants without depending on a fresh array literal every render.
  const chamaryKey = chamariesProp ? chamariesProp.map(c => c.id).join(',') : '';
  const { roles } = useRoles();
  const caps = useUserCapabilities();
  // A hook, so it runs before the early return below rather than beside the JSX that uses it.
  const multWord = useMultiplierWord();

  const [myChamaries, setMyChamaries] = useState<ChamaryWithPlace[]>([]);
  const [lists, setLists]     = useState<Record<string, LunchRequest[]>>({});
  const [offdays, setOffdays] = useState<Record<string, ChamaryMealOffday[]>>({});
  const [employees, setEmployees] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmMove, setConfirmMove] = useState<
    { chamary: ChamaryWithPlace; meal: MealType; person: AppUser; actor: Actor; fromName: string } | null
  >(null);
  const [offTarget, setOffTarget] = useState<{ chamary: ChamaryWithPlace; meal: MealType } | null>(null);
  const [offReason, setOffReason] = useState('');
  // Setting what one meal is charged at. It is a money decision — the chamary's bills are
  // divided by the sum of these weights, so charging one person more lowers everyone else's
  // share — which is why it goes through POST /api/food/meal-multiplier and not through
  // Firestore: every can*() helper in firestore.rules reduces to isAuth(), so a client-writable
  // `multiplier` would let any signed-in employee halve their own food bill.
  const [multTarget, setMultTarget] = useState<
    { chamary: ChamaryWithPlace; meal: MealType; row: LunchRequest } | null
  >(null);
  const [multValue, setMultValue] = useState<MealMultiplier>(1);
  const [multNote, setMultNote]   = useState('');
  // Meals with nothing booked that the user has asked to open anyway, keyed `chamaryId:meal`.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [pickerGen, setPickerGen] = useState(0);

  // ── Bulk select ────────────────────────────────────────────────────────────
  // Whether the UI is in "select mode" for a specific chamary+meal section.
  // Key format: `chamaryId:meal`. When active, chips show checkboxes instead of remove buttons.
  const [selectMode, setSelectMode] = useState<Record<string, boolean>>({});
  // Set of selected EPFs per chamary+meal key.
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});

  const sectionKey = (chamaryId: string, meal: MealType) => `${chamaryId}:${meal}`;

  const toggleSelectMode = (chamaryId: string, meal: MealType) => {
    const k = sectionKey(chamaryId, meal);
    setSelectMode(s => ({ ...s, [k]: !s[k] }));
    setSelected(s => ({ ...s, [k]: new Set() }));
  };

  const toggleChip = (chamaryId: string, meal: MealType, epf: string) => {
    const k = sectionKey(chamaryId, meal);
    setSelected(s => {
      const cur = new Set(s[k] ?? []);
      if (cur.has(epf)) cur.delete(epf); else cur.add(epf);
      return { ...s, [k]: cur };
    });
  };

  const selectAll = (chamaryId: string, meal: MealType, epfs: string[]) => {
    const k = sectionKey(chamaryId, meal);
    setSelected(s => ({ ...s, [k]: new Set(epfs) }));
  };

  const clearSelect = (chamaryId: string, meal: MealType) => {
    const k = sectionKey(chamaryId, meal);
    setSelected(s => ({ ...s, [k]: new Set() }));
    setSelectMode(sm => ({ ...sm, [k]: false }));
  };

  // Bulk mark selected as served
  const bulkMarkServed = useCallback(async (
    chamaryId: string, meal: MealType, epfs: string[], served: boolean,
  ) => {
    const k = sectionKey(chamaryId, meal);
    setBusyKey(`${k}:bulk`);
    try {
      await Promise.all(epfs.map(epf => setMealServed(epf, today, meal, served)));
      await reloadAll();
    } catch (e) { toast.error(errMsg(e, 'Could not update.')); }
    finally { setBusyKey(null); clearSelect(chamaryId, meal); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  // Mark ALL people in a meal section as served in one click
  const markAllServed = useCallback(async (
    chamaryId: string, meal: MealType, all: LunchRequest[],
  ) => {
    const unserved = all.filter(r => !r.served);
    if (!unserved.length) return;
    const k = sectionKey(chamaryId, meal);
    setBusyKey(`${k}:bulk`);
    try {
      await Promise.all(unserved.map(r => setMealServed(r.epf_number, today, meal, true)));
      await reloadAll();
    } catch (e) { toast.error(errMsg(e, 'Could not mark served.')); }
    finally { setBusyKey(null); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  // Bulk remove selected
  const bulkRemove = useCallback(async (
    chamaryId: string, meal: MealType, epfs: string[],
  ) => {
    const k = sectionKey(chamaryId, meal);
    setBusyKey(`${k}:bulk`);
    try {
      await Promise.all(epfs.map(epf => cancelMeal(epf, today, meal, chamaryId)));
      await reloadAll();
    } catch (e) { toast.error(errMsg(e, 'Could not remove.')); }
    finally { setBusyKey(null); clearSelect(chamaryId, meal); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  useEffect(() => {
    if (!tenant.features.suspense || !epf) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    (chamariesProp
      ? Promise.resolve(chamariesProp)
      : listAllChamaries().then(all => all.filter(c => c.responsible_epf === epf)))
      .then(async (mine) => {
        if (cancelled) return;
        setMyChamaries(mine);
        if (mine.length === 0) return;
        const [dayLists, dayOffs] = await Promise.all([
          Promise.all(mine.map(c => getChamaryMealsForDay(c.id, today))),
          Promise.all(mine.map(c => getChamaryOffdaysForDay(c.id, today))),
          getAllEmployees().then(setEmployees).catch(() => {}),
        ]);
        if (cancelled) return;
        const listMap: Record<string, LunchRequest[]> = {};
        const offMap:  Record<string, ChamaryMealOffday[]> = {};
        mine.forEach((c, i) => { listMap[c.id] = dayLists[i]; offMap[c.id] = dayOffs[i]; });
        setLists(listMap); setOffdays(offMap);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epf, today, chamaryKey]);

  // A meal opened by hand belongs to the day it was opened on — moving to another day starts
  // from the same quiet, information-first state.
  useEffect(() => { setOpened({}); }, [today, chamaryKey]);

  if (loading || myChamaries.length === 0) return null;

  const mealName: Record<MealType, string> = {
    breakfast: t.mealBreakfast, lunch: t.mealLunch, dinner: t.mealDinner,
  };
  const phase = dayPhase(today, localDateString());

  // Re-fetch EVERY chamary this person runs (not just the touched one) — a person can only be on
  // ONE chamary's list per meal per day, so adding/removing them can change what a SIBLING
  // chamary's list should show too; a single-chamary refresh would leave that sibling list
  // showing a stale "ghost" entry for someone who's actually moved elsewhere for that meal.
  const reloadAll = async () => {
    const [dayLists, dayOffs] = await Promise.all([
      Promise.all(myChamaries.map(c => getChamaryMealsForDay(c.id, today))),
      Promise.all(myChamaries.map(c => getChamaryOffdaysForDay(c.id, today))),
    ]);
    const listMap: Record<string, LunchRequest[]> = {};
    const offMap:  Record<string, ChamaryMealOffday[]> = {};
    myChamaries.forEach((c, i) => { listMap[c.id] = dayLists[i]; offMap[c.id] = dayOffs[i]; });
    setLists(listMap); setOffdays(offMap);
    onChanged?.();
  };

  const offdayOf = (chamaryId: string, meal: MealType) =>
    (offdays[chamaryId] ?? []).find(o => o.meal === meal) ?? null;

  // Who is OFFERED the charge picker: whoever runs that kitchen, or whoever owns the food module
  // (a system admin, or the approver the food deduction answers to). The route re-derives this
  // from the ID token, so this decides what to draw and is never what permits the write.
  const isFoodAdmin = caps.is_system_admin || caps.can_approve_suspense;
  const mayPrice = (ch: ChamaryWithPlace) => isFoodAdmin || ch.responsible_epf === epf;

  // The route refuses a chamary that is not yours, a month payroll has already finalised, and any
  // value outside the four — each in its own words. Those words are shown as they come back: "You
  // do not run that chamary" tells the handler something a generic failure cannot.
  const saveMultiplier = async () => {
    if (!multTarget) return;
    const { chamary, meal, row } = multTarget;
    setBusyKey(`${chamary.id}:${meal}:${row.epf_number}:mult`);
    const res = await setMealMultiplier({
      epf: row.epf_number, date: today, meal, multiplier: multValue, note: multNote,
    });
    setBusyKey(null);
    if (!res.ok) { toast.error(res.error || t.foodChargeFailed); return; }
    setMultTarget(null);
    toast.success(t.foodChargeSaved);
    // Re-read rather than patch the row in place: this figure is derived from every booking in
    // the month, so one weight changing moves what everybody else pays. reloadAll also tells the
    // parent, which is how the /chamary month reconciliation follows.
    await reloadAll();
  };

  // The actual write — shared by the direct-add path and the "confirm the move" path below.
  const doAdd = async (chamary: ChamaryWithPlace, meal: MealType, person: AppUser, actor: Actor) => {
    setBusyKey(`${chamary.id}:${meal}:add`);
    try {
      await requestMeal({
        epf_number:         person.epf_number,
        employee_name:      person.display_name || [person.first_name, person.last_name].filter(Boolean).join(' ') || person.epf_number,
        company_id:         person.company_id ?? '',
        company_name:       person.company_name ?? '',
        date:               today,
        meal,
        chamary_id:         chamary.id,
        chamary_name:       chamary.name,
        working_place_id:   chamary.working_place_id,
        working_place_name: chamary.working_place_name,
      }, actor);
      setPickerGen(n => n + 1);
      await reloadAll();
    } catch (e) { toast.error(errMsg(e, 'Could not add to the list.')); }
    finally { setBusyKey(null); }
  };

  const addPerson = async (chamary: ChamaryWithPlace, meal: MealType, personEpf: string) => {
    if (!personEpf || !epf) return;
    const person = employees.find(u => u.epf_number === personEpf);
    if (!person) return;
    const actor: Actor = { epf, name: user?.name ?? '' };

    // Moving someone from one chamary to another for the same meal is an intentional override,
    // but doing it silently when they were booked by somebody else or by themselves would lead
    // to "where did my name go?" confusion. Ask first.
    try {
      const existing = await getMyMealForDate(personEpf, today, meal);
      if (existing && existing.chamary_id !== chamary.id) {
        setConfirmMove({ chamary, meal, person, actor, fromName: existing.chamary_name });
        return;
      }
    } catch {}

    await doAdd(chamary, meal, person, actor);
  };

  const removePerson = async (chamaryId: string, meal: MealType, personEpf: string) => {
    setBusyKey(`${chamaryId}:${meal}:${personEpf}`);
    try {
      await cancelMeal(personEpf, today, meal, chamaryId);
      await reloadAll();
    } catch (e) { toast.error(errMsg(e, 'Could not remove from the list.')); }
    finally { setBusyKey(null); }
  };

  const toggleServed = async (chamaryId: string, meal: MealType, r: LunchRequest) => {
    setBusyKey(`${chamaryId}:${meal}:${r.epf_number}`);
    try {
      await setMealServed(r.epf_number, today, meal, !r.served);
      await reloadAll();
    } catch (e) { toast.error(errMsg(e, 'Failed to update.')); }
    finally { setBusyKey(null); }
  };

  // Everyone whose booking the off-day just cancelled has to hear about it, and so do the system
  // admins — they own the food deduction this silently changes. createAppNotification never throws.
  const notifyOffday = async (
    chamary: ChamaryWithPlace, meal: MealType, reason: string, cancelled: LunchRequest[], actor: Actor,
  ) => {
    const label  = MEAL_LABEL[meal].toLowerCase();
    const tail   = reason ? ` — ${reason}` : '';
    const title  = `No ${label} at ${chamary.name}`;
    const admins = await getActiveSystemAdmins(epf).catch(() => [] as AppUser[]);
    await Promise.all([
      ...cancelled.map(r => createAppNotification({
        toEpf: r.epf_number, type: 'general', actorEpf: actor.epf, actorName: actor.name,
        title,
        body: `${chamary.name} is not cooking ${label} on ${today}${tail}. Your booking has been cancelled.`,
        link: '/dashboard',
      })),
      ...admins.map(a => createAppNotification({
        toEpf: a.epf_number, type: 'general', actorEpf: actor.epf, actorName: actor.name,
        title,
        body: `${actor.name} marked ${chamary.name} as not cooking ${label} on ${today}${tail}. ${cancelled.length} booking(s) cancelled.`,
        link: '/dashboard',
      })),
    ]);
  };

  const markNotCooking = async () => {
    if (!offTarget || !epf) return;
    const { chamary, meal } = offTarget;
    const actor: Actor = { epf, name: user?.name ?? '' };
    const reason = offReason.trim();
    setBusyKey(`${chamary.id}:${meal}:off`);
    try {
      const cancelled = await setMealOffday(
        { chamary_id: chamary.id, chamary_name: chamary.name, date: today, meal, reason }, actor,
      );
      await notifyOffday(chamary, meal, reason, cancelled, actor);
      setOffTarget(null); setOffReason('');
      await reloadAll();
    } catch (e) { toast.error(errMsg(e, 'Failed to mark as not cooking.')); }
    finally { setBusyKey(null); }
  };

  const cookAgain = async (chamary: ChamaryWithPlace, meal: MealType) => {
    setBusyKey(`${chamary.id}:${meal}:off`);
    try {
      await clearMealOffday(chamary.id, today, meal);
      await reloadAll();
    } catch (e) { toast.error(errMsg(e, 'Failed to update.')); }
    finally { setBusyKey(null); }
  };

  /** The one line that says how a meal stands, next to its label. A booking nobody ticked is a
   *  no-show only once the day is over — today it is simply not collected yet, and on a day
   *  still ahead there is nothing to collect at all. */
  const statusLine = (total: number, served: number): ReactNode => {
    if (total === 0) return null;
    if (phase === 'future') return `${total} ${t.bookedWord.toLowerCase()}`;
    if (phase === 'today') {
      // "not yet" has no TRANSLATIONS key — see the report.
      return <>{served} {t.collectedWord.toLowerCase()} · {total - served} not yet</>;
    }
    const missed = total - served;
    return (
      <>
        {served} {t.servedWord.toLowerCase()} ·{' '}
        <span className={cn(missed > 0 && 'text-destructive')}>{missed} {t.noShowWord.toLowerCase()}</span>
      </>
    );
  };

  // Bare + a single chamary: the /chamary day panel already prints whose kitchen this is, so a
  // header here would say it twice. The dashboard keeps its per-chamary header — nothing else
  // on that screen names the canteen.
  const showChamaryHeader = !(bare && myChamaries.length === 1);

  const Frame: ElementType = bare ? 'div' : Card;
  return (
    <Reveal>
      <Frame className={bare ? 'space-y-4' : 'space-y-4 p-4'}>
        {!bare && (
          <div className="flex items-center gap-2">
            <UtensilsCrossed className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">{title ?? t.todaysMealList}</span>
          </div>
        )}

        {myChamaries.map(ch => {
          const q = search.trim().toLowerCase();
          // One pass per meal this chamary serves: everyone booked, what the search shows of
          // them, whether the kitchen is closed, and who is still addable. Counts, the served
          // tally and the already-added guard all read the FULL list — a filtered view must
          // never make someone addable twice.
          const rows = chamaryMeals(ch.meals).map(meal => {
            const off = offdayOf(ch.id, meal);
            const all = (lists[ch.id] ?? []).filter(r => mealOf(r.meal) === meal);
            const already = new Set(all.map(r => r.epf_number));
            return {
              meal,
              off,
              all,
              list: q ? all.filter(r => `${r.employee_name} ${r.epf_number}`.toLowerCase().includes(q)) : all,
              served: all.filter(r => r.served).length,
              // Only people whose category this chamary actually serves — same rule the
              // self-service LunchButton applies, kept consistent for the manual-add path too.
              options: employees
                .filter(u => u.epf_number && !already.has(u.epf_number)
                  && categoryAllowed(ch.categories, roleCategory(u.role, roles)))
                .map<SearchOption>(u => ({
                  value: u.epf_number,
                  label: u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.epf_number,
                  sublabel: [u.epf_number, u.role].filter(Boolean).join(' · ') || undefined,
                  keywords: `${u.epf_number} ${u.email ?? ''} ${u.role ?? ''}`,
                })),
            };
          });
          const total  = rows.reduce((sum, r) => sum + r.all.length, 0);
          const shown  = rows.filter(r => r.all.length > 0 || r.off || opened[`${ch.id}:${r.meal}`]);
          const quiet  = rows.filter(r => !shown.includes(r));

          return (
            <div key={ch.id} className="space-y-3 rounded-xl border border-border/80 bg-muted/10 p-3 sm:p-4">
              {showChamaryHeader && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-foreground">{ch.name}</span>
                    {ch.working_place_name && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        <MapPin className="h-3 w-3" />
                        {ch.working_place_name}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {rows.map(r => (
                      <span
                        key={r.meal}
                        title={r.off ? (r.off.reason || t.notCookingWord) : mealName[r.meal]}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums',
                          r.off
                            ? 'border border-dashed border-border text-muted-foreground line-through'
                            : 'bg-muted/80 text-foreground',
                        )}
                      >
                        <MealIcon meal={r.meal} className="h-3 w-3" />
                        <span>{r.off ? 'Off' : r.all.length}</span>
                      </span>
                    ))}
                    <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold tabular-nums text-primary">
                      {total}
                    </span>
                  </div>
                </div>
              )}

              {/* Each active meal service block */}
              <div className="space-y-3">
                {shown.map(({ meal, off, all, list, served, options }) => {
                  const mealPct = all.length > 0 ? Math.round((served / all.length) * 100) : 0;
                  const mealColor = meal === 'breakfast'
                    ? 'border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400'
                    : meal === 'lunch'
                      ? 'border-orange-500/30 bg-orange-500/5 text-orange-600 dark:text-orange-400'
                      : 'border-indigo-500/30 bg-indigo-500/5 text-indigo-600 dark:text-indigo-400';

                  const sk        = sectionKey(ch.id, meal);
                  const inSelect  = !!selectMode[sk];
                  const selSet    = selected[sk] ?? new Set<string>();
                  const allEpfs   = all.map(r => r.epf_number);
                  const allSelected = allEpfs.length > 0 && allEpfs.every(e => selSet.has(e));
                  const anySelected = selSet.size > 0;
                  const isBulkBusy  = busyKey === `${sk}:bulk`;
                  const allServed   = all.length > 0 && all.every(r => r.served);

                  return (
                    <div
                      key={meal}
                      className={cn(
                        'space-y-3 rounded-xl border p-3 transition-all',
                        off
                          ? 'border-dashed border-border/80 bg-muted/20 opacity-80'
                          : 'border-border/70 bg-card shadow-xs',
                      )}
                    >
                      {/* Service Header Row */}
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className={cn('inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-bold', mealColor)}>
                            <MealIcon meal={meal} className="h-3.5 w-3.5" />
                            <span>{mealName[meal]}</span>
                          </span>

                          {!off && all.length > 0 && (
                            <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-bold tabular-nums text-foreground">
                              {all.length}
                            </span>
                          )}

                          <span className="text-xs text-muted-foreground tabular-nums">
                            {off
                              ? `${t.notCookingWord}${off.reason ? ` — ${off.reason}` : ''}`
                              : statusLine(all.length, served)}
                          </span>
                        </div>

                        {/* Right-side controls */}
                        <div className="flex items-center gap-1.5">
                          {!off && all.length > 0 && phase !== 'future' && (
                            <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-muted-foreground">
                              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${mealPct}%` }} />
                              </div>
                              <span className="font-semibold tabular-nums text-foreground">{mealPct}%</span>
                            </div>
                          )}

                          {/* Mark All Served — one-click auto-serve */}
                          {!off && all.length > 0 && !allServed && phase !== 'future' && !inSelect && (
                            <button
                              type="button"
                              disabled={isBulkBusy}
                              title="Mark everyone served"
                              aria-label={`Mark all ${mealName[meal]} served — ${ch.name}`}
                              onClick={() => markAllServed(ch.id, meal, all)}
                              className="inline-flex h-8 items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                            >
                              <CheckCheck className="h-3.5 w-3.5" />
                              <span className="hidden sm:inline">All served</span>
                            </button>
                          )}

                          {/* Bulk select toggle */}
                          {!off && all.length > 1 && (
                            <button
                              type="button"
                              onClick={() => toggleSelectMode(ch.id, meal)}
                              title={inSelect ? 'Exit selection' : 'Select multiple'}
                              aria-label={inSelect ? 'Exit selection mode' : 'Enter selection mode'}
                              className={cn(
                                'inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium transition-colors disabled:opacity-50',
                                inSelect
                                  ? 'border-primary/50 bg-primary/10 text-primary'
                                  : 'border-dashed border-border/70 text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground',
                              )}
                            >
                              {inSelect ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                              <span className="hidden sm:inline">{inSelect ? 'Selecting' : 'Select'}</span>
                            </button>
                          )}

                          <button
                            type="button"
                            disabled={busyKey === `${ch.id}:${meal}:off`}
                            aria-label={`${off ? t.cookingAgainWord : t.markNotCooking} — ${mealName[meal]}, ${ch.name}`}
                            title={off ? t.cookingAgainWord : t.markNotCooking}
                            onClick={() => {
                              if (off) { cookAgain(ch, meal); return; }
                              setOffReason(''); setOffTarget({ chamary: ch, meal });
                            }}
                            className={cn(
                              'inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                              off
                                ? 'border-border bg-card text-foreground hover:bg-accent'
                                : 'border-dashed border-border/70 text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground',
                            )}
                          >
                            {off ? (
                              <>
                                <CookingPot className="h-3.5 w-3.5 text-emerald-500" />
                                <span>{t.cookingAgainWord}</span>
                              </>
                            ) : (
                              <>
                                <Ban className="h-3.5 w-3.5" />
                                <span className="hidden sm:inline">{t.markNotCooking}</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Bulk action toolbar — visible when in select mode with ≥1 selected */}
                      {inSelect && (
                        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
                          {/* Select all / none toggle */}
                          <button
                            type="button"
                            onClick={() => allSelected ? clearSelect(ch.id, meal) : selectAll(ch.id, meal, allEpfs)}
                            className="flex items-center gap-1.5 text-xs font-medium text-primary"
                          >
                            {allSelected
                              ? <CheckSquare className="h-3.5 w-3.5" />
                              : <Square className="h-3.5 w-3.5" />}
                            {allSelected ? 'Deselect all' : 'Select all'}
                          </button>

                          {selSet.size > 0 && (
                            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-primary">
                              {selSet.size} selected
                            </span>
                          )}

                          <div className="ml-auto flex items-center gap-1.5">
                            {anySelected && (
                              <>
                                <button
                                  type="button"
                                  disabled={isBulkBusy}
                                  onClick={() => bulkMarkServed(ch.id, meal, [...selSet], true)}
                                  className="inline-flex h-7 items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                                >
                                  <Check className="h-3 w-3" /> Served
                                </button>
                                <button
                                  type="button"
                                  disabled={isBulkBusy}
                                  onClick={() => bulkRemove(ch.id, meal, [...selSet])}
                                  className="inline-flex h-7 items-center gap-1 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50"
                                >
                                  <Trash2 className="h-3 w-3" /> Remove
                                </button>
                              </>
                            )}
                            <button
                              type="button"
                              onClick={() => clearSelect(ch.id, meal)}
                              className="inline-flex h-7 items-center gap-1 rounded-lg border border-border px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent"
                            >
                              <X className="h-3 w-3" /> Done
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Diner chips */}
                      {all.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {list.map(r => {
                            const isServed  = !!r.served;
                            const isBusy    = busyKey === `${ch.id}:${meal}:${r.epf_number}`;
                            const isChecked = selSet.has(r.epf_number);

                            return (
                              <div
                                key={r.epf_number}
                                className={cn(
                                  'group relative inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-all shadow-xs select-none',
                                  inSelect && isChecked
                                    ? 'border-primary/50 bg-primary/10 text-primary font-medium ring-1 ring-primary/30'
                                    : isServed
                                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100 font-medium'
                                      : 'border-border/80 bg-card hover:border-primary/40 text-foreground',
                                )}
                              >
                                {/* In select mode: checkbox. Otherwise: served toggle */}
                                {inSelect ? (
                                  <button
                                    type="button"
                                    onClick={() => toggleChip(ch.id, meal, r.epf_number)}
                                    aria-label={`${isChecked ? 'Deselect' : 'Select'} ${r.employee_name}`}
                                    className={cn(
                                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                                      isChecked
                                        ? 'border-primary bg-primary text-white'
                                        : 'border-border bg-background hover:border-primary',
                                    )}
                                  >
                                    {isChecked && <Check className="h-3 w-3 stroke-[3]" />}
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    onClick={() => toggleServed(ch.id, meal, r)}
                                    aria-label={`${t.servedWord} — ${r.employee_name}`}
                                    title={isServed ? 'Mark uncollected' : 'Mark collected'}
                                    className={cn(
                                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                                      isServed
                                        ? 'border-emerald-600 bg-emerald-600 text-white'
                                        : 'border-border hover:border-primary bg-background',
                                    )}
                                  >
                                    {isServed && <Check className="h-3 w-3 stroke-[3]" />}
                                  </button>
                                )}

                                {/* The name doubles as the way in to the charge picker, for
                                    whoever may set one and never in select mode. A meal at the
                                    normal rate has to look like a row with no control at all
                                    (see MultiplierBadge) or a sixty-name list becomes a wall of
                                    pickers — so the affordance is the name, dotted-underlined
                                    and labelled, rather than a control on every chip. */}
                                {mayPrice(ch) && !inSelect ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setMultValue(multiplierOf(r));
                                      setMultNote(String(r.multiplier_note ?? ''));
                                      setMultTarget({ chamary: ch, meal, row: r });
                                    }}
                                    title={t.foodSetChargeAction}
                                    aria-label={`${t.foodSetChargeAction} — ${r.employee_name}`}
                                    className="max-w-[130px] truncate underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:max-w-[170px]"
                                  >
                                    {r.employee_name}
                                  </button>
                                ) : (
                                  <span className="truncate max-w-[130px] sm:max-w-[170px]" title={r.employee_name}>
                                    {r.employee_name}
                                  </span>
                                )}

                                <span className="text-[10px] tabular-nums text-muted-foreground/80">
                                  {r.epf_number}
                                </span>

                                <MultiplierBadge row={r} />

                                {/* The person themselves said they did not take this meal (from
                                    /food). Shown because an operator's own untick and a
                                    statement made after the fact are different facts, and the
                                    operator is the one who was at the counter — they can still
                                    tick it back. Shape + text, never hue alone: --success,
                                    --primary and --brand are all the same azure here. */}
                                {r.served_source === 'employee' && r.no_show === true && (
                                  <span
                                    title={t.foodYouSaidNotTaken}
                                    className="inline-flex items-center gap-1 rounded border border-dashed border-warn-strong/60 px-1 text-[10px] font-semibold text-warn-strong"
                                  >
                                    <AlertCircle className="h-3 w-3" aria-hidden />
                                    {t.foodDidNotTakeIt}
                                  </span>
                                )}

                                {/* In select mode hide the remove button; in normal mode show it */}
                                {!inSelect && (
                                  <button
                                    type="button"
                                    aria-label={`Remove ${r.employee_name}`}
                                    title={`Remove ${r.employee_name}`}
                                    disabled={isBusy}
                                    onClick={() => removePerson(ch.id, meal, r.epf_number)}
                                    className="ml-0.5 rounded-full p-0.5 text-muted-foreground/50 transition-colors hover:bg-destructive/15 hover:text-destructive disabled:opacity-50"
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Quick Add Someone Selector */}
                      {!off && (
                        <div className="pt-1">
                          <SearchableSelect
                            key={`${ch.id}-${meal}-${pickerGen}`}
                            value=""
                            onChange={(v) => addPerson(ch, meal, v)}
                            options={options}
                            disabled={busyKey === `${ch.id}:${meal}:add`}
                            placeholder={t.addSomeoneToList}
                            ariaLabel={`${t.addSomeoneToList} ${mealName[meal]} · ${ch.name}`}
                            emptyLabel={t.noMatchingEmployees}
                            icon={<UserPlus className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Quiet Meals (Meals with 0 diners, ready to be expanded) */}
              {quiet.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/40">
                  <span className="text-[11px] font-medium text-muted-foreground">Add service:</span>
                  {quiet.map(r => (
                    <button
                      key={r.meal}
                      type="button"
                      onClick={() => setOpened(o => ({ ...o, [`${ch.id}:${r.meal}`]: true }))}
                      className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-dashed border-border/80 bg-background/50 px-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Plus className="h-3 w-3" />
                      <MealIcon meal={r.meal} className="h-3 w-3" />
                      <span>{mealName[r.meal]}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </Frame>

      <ConfirmModal
        open={!!confirmMove}
        onOpenChange={() => setConfirmMove(null)}
        variant="warning"
        title={t.moveToChamaryTitle}
        description={
          confirmMove
            ? `${confirmMove.person.display_name} is already down for ${MEAL_LABEL[confirmMove.meal].toLowerCase()} at “${confirmMove.fromName}” today. Move them to “${confirmMove.chamary.name}” instead?`
            : undefined
        }
        confirmText="Move"
        busy={busyKey === (confirmMove ? `${confirmMove.chamary.id}:${confirmMove.meal}:add` : '')}
        onConfirm={async () => {
          if (confirmMove) await doAdd(confirmMove.chamary, confirmMove.meal, confirmMove.person, confirmMove.actor);
          setConfirmMove(null);
        }}
      />

      {/* What this one meal is charged at. Everything inside `description` is phrasing content
          on purpose — the dialog renders it inside a <p>, so spans, buttons and the input only,
          never a <div>. */}
      <ConfirmModal
        open={!!multTarget}
        onOpenChange={() => setMultTarget(null)}
        variant="warning"
        title={t.foodChargeDialogTitle}
        confirmText={t.save}
        busy={busyKey === (multTarget
          ? `${multTarget.chamary.id}:${multTarget.meal}:${multTarget.row.epf_number}:mult`
          : '')}
        onConfirm={saveMultiplier}
        description={multTarget ? (
          <>
            <span className="block font-medium text-foreground">
              {multTarget.row.employee_name} · {mealName[multTarget.meal]} · {prettyDateShort(today)}
            </span>
            <span className="mt-1 block">{t.foodChargeDialogHint}</span>

            {/* Four buttons rather than a select: there are exactly four values, and the one in
                force has to be readable without opening anything. */}
            <span className="mt-3 flex flex-wrap gap-2">
              {MEAL_MULTIPLIERS.map(m => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={multValue === m}
                  onClick={() => setMultValue(m)}
                  className={cn(
                    'inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-xs transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    multValue === m
                      ? 'border-primary bg-primary/10 font-semibold text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <span className="tabular-nums">{m}×</span>
                  <span className="font-normal">{multWord(m)}</span>
                </button>
              ))}
            </span>

            <span className="mt-3 block text-xs font-medium text-foreground">
              {t.foodChargeReasonLabel}
            </span>
            <Input
              className="mt-1"
              value={multNote}
              onChange={e => setMultNote(e.target.value)}
              maxLength={200}
              aria-label={t.foodChargeReasonLabel}
            />
            <span className="mt-1 block text-[11px] text-muted-foreground">
              {t.foodChargeReasonShown}
            </span>
          </>
        ) : undefined}
      />

      <ConfirmModal
        open={!!offTarget}
        onOpenChange={() => { setOffTarget(null); setOffReason(''); }}
        variant="warning"
        title={t.markNotCooking}
        description={
          offTarget ? (
            <>
              <span className="block font-medium text-foreground">
                {offTarget.chamary.name} · {mealName[offTarget.meal]} · {today}
              </span>
              <span className="mt-1 block">
                Everyone already booked for this meal is cancelled and notified.
              </span>
              <span className="mt-3 block text-xs font-medium text-foreground">{t.offdayReasonLabel}</span>
              <Input
                className="mt-1"
                value={offReason}
                onChange={e => setOffReason(e.target.value)}
                placeholder="Optional"
              />
            </>
          ) : undefined
        }
        confirmText={t.notCookingWord}
        busy={busyKey === (offTarget ? `${offTarget.chamary.id}:${offTarget.meal}:off` : '')}
        onConfirm={markNotCooking}
      />
    </Reveal>
  );
}
