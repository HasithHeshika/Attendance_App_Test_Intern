'use client';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { CalendarCog, Calendar, Loader2, Check, Moon, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { useT } from '@/store/appStore';
import {
  getHolidaySettings, setAcceptedHolidays, fetchPublicHolidays,
  type PublicHoliday, type CustomHoliday, type HolidayType,
} from '@/services/holidayService';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';

const CUR = new Date().getFullYear();
// Let admins curate the current year, a couple back, and next year (to set up ahead of time).
const YEARS = [CUR - 2, CUR - 1, CUR, CUR + 1];

// Which of the roster/schedule feature's staffing buckets a date counts as — see the big
// comment on HolidayType in holidayService.ts. Shown as a small segmented control per date.
const HOLIDAY_TYPES: { value: HolidayType; label: string }[] = [
  { value: 'public', label: 'Public' },
  { value: 'poya', label: 'Poya' },
  { value: 'mercantile', label: 'Mercantile' },
];

function HolidayTypePicker({
  value, onChange,
}: {
  value: HolidayType;
  onChange: (type: HolidayType) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-muted/30 p-0.5">
      {HOLIDAY_TYPES.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={(e) => { e.stopPropagation(); onChange(opt.value); }}
          className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
            value === opt.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// Self-contained manager for the org-wide accepted-holiday list. Renders its own trigger
// button + dialog with an internal year selector. Used from the Leave Types page.
export default function ManageHolidaysDialog({
  variant = 'outline',
  className,
}: {
  variant?: React.ComponentProps<typeof Button>['variant'];
  className?: string;
}) {
  const { user } = useAuthStore();
  const t = useT();

  const [open,        setOpen]        = useState(false);
  const [year,        setYear]        = useState(CUR);
  const [pubHolidays, setPubHolidays] = useState<PublicHoliday[]>([]);
  const [accepted,    setAccepted]    = useState<Set<string>>(new Set());
  const [customList,  setCustomList]  = useState<CustomHoliday[]>([]);
  // Poya/Public/Mercantile classification per accepted date — see HolidayType in
  // holidayService.ts. Explicit picks here take priority; typeFor() below fills in a sensible
  // default (Poya auto-detected, else Public) for dates that don't have one yet.
  const [types,       setTypes]       = useState<Record<string, HolidayType>>({});
  const [newDate,     setNewDate]     = useState('');
  const [newName,     setNewName]     = useState('');
  const [newType,     setNewType]     = useState<HolidayType>('public');
  const [loadingHols, setLoadingHols] = useState(false);
  const [savingHols,  setSavingHols]  = useState(false);

  // Closing the dialog discards any unsaved changes — the year filter included. Without this
  // a year picked but not saved (e.g. 2025) stuck around, so reopening showed that year's
  // data instead of the default (current year). The load effect below re-fetches fresh data
  // for CUR on the next open.
  useEffect(() => {
    if (!open) setYear(CUR);
  }, [open]);

  // Load the year's public holidays + saved acceptances whenever the dialog opens or the
  // selected year changes while it's open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingHols(true);
    setNewDate(''); setNewName(''); setNewType('public');
    Promise.all([fetchPublicHolidays(year), getHolidaySettings(year)])
      .then(([pub, saved]) => {
        if (cancelled) return;
        setPubHolidays(pub);
        setAccepted(new Set(saved.dates));
        setCustomList(saved.custom);
        setTypes(saved.types);
      })
      .catch(() => { if (!cancelled) { setPubHolidays([]); setAccepted(new Set()); setCustomList([]); setTypes({}); } })
      .finally(() => { if (!cancelled) setLoadingHols(false); });
    return () => { cancelled = true; };
  }, [open, year]);

  const customDates    = customList.map(c => c.date);
  const pubAcceptedCnt = pubHolidays.filter(h => accepted.has(h.date)).length;
  // Explicit pick wins; otherwise default from the public-feed Poya flag, else Public.
  const typeFor = (date: string, isPoya?: boolean): HolidayType =>
    types[date] ?? (isPoya ? 'poya' : 'public');
  const setType = (date: string, type: HolidayType) =>
    setTypes(prev => ({ ...prev, [date]: type }));

  const toggleHoliday = (date: string) => {
    setAccepted(prev => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date); else next.add(date);
      return next;
    });
  };

  const addCustomDate = () => {
    const date = newDate.trim();
    if (!date) return;
    if (date.slice(0, 4) !== String(year)) { toast.error(t.dateInYearError); return; }
    if (accepted.has(date)) { toast.error(t.dateAlreadyAdded); return; }
    const name = newName.trim() || t.companyHolidays;
    setAccepted(prev => new Set(prev).add(date));
    setCustomList(prev => [...prev, { date, name, type: newType }].sort((a, b) => a.date.localeCompare(b.date)));
    setType(date, newType);
    setNewDate(''); setNewName(''); setNewType('public');
  };

  const removeCustomDate = (date: string) => {
    setAccepted(prev => { const next = new Set(prev); next.delete(date); return next; });
    setCustomList(prev => prev.filter(c => c.date !== date));
  };

  const saveHolidays = async () => {
    setSavingHols(true);
    try {
      // Every accepted date gets a concrete type — explicit picks first, else the same default
      // shown on screen (typeFor), so a date never saves without one even if the admin never
      // touched its picker.
      const cleanTypes = Object.fromEntries(
        [...accepted].map(date => [date, typeFor(date, pubHolidays.find(h => h.date === date)?.is_poya)]),
      );
      await setAcceptedHolidays(year, [...accepted], customList, cleanTypes, String(user?.epf_number ?? ''));
      toast.success(t.holidaysSaved);
      setOpen(false);
    } catch (e) {
      console.error(e);
      toast.error(t.failedSaveHolidays);
    } finally {
      setSavingHols(false);
    }
  };

  return (
    <>
      <Button variant={variant} className={className} onClick={() => setOpen(true)}>
        <CalendarCog className="h-4 w-4" />{t.manageHolidays}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarCog className="h-5 w-5 text-primary" />
              {t.companyHolidays}
            </DialogTitle>
            <DialogDescription>{t.holidaysDialogDesc}</DialogDescription>
          </DialogHeader>

          {/* Year selector — the accepted list is stored per year */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t.yearWord}</Label>
            <Select value={String(year)} onValueChange={v => setYear(+v)}>
              <SelectTrigger className="h-10 rounded-lg px-3.5">
                {/* A div, not a span — SelectTrigger's own `[&>span]:line-clamp-1` rule
                    targets direct span children and beats this wrapper's `flex` class on
                    specificity, forcing display:-webkit-box (vertical), which stacked the
                    icon above the value instead of beside it. */}
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <SelectValue />
                </div>
              </SelectTrigger>
              <SelectContent position="popper" sideOffset={6} className="max-h-[min(16rem,var(--radix-select-content-available-height))]">
                {YEARS.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {/* Public holidays: select-all / clear + accepted count */}
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold uppercase tracking-wide text-muted-foreground">
              {t.publicHolidaysLabel}
              <span className="ml-1.5 font-medium normal-case">({pubAcceptedCnt}/{pubHolidays.length} {t.acceptedLabel})</span>
            </span>
            <div className="flex gap-3">
              <button
                type="button"
                className="font-semibold text-primary hover:underline disabled:opacity-50"
                disabled={loadingHols || pubHolidays.length === 0}
                onClick={() => setAccepted(new Set([...customDates, ...pubHolidays.map(h => h.date)]))}
              >
                {t.selectAll}
              </button>
              <button
                type="button"
                className="font-semibold text-muted-foreground hover:underline disabled:opacity-50"
                disabled={loadingHols || pubAcceptedCnt === 0}
                onClick={() => setAccepted(new Set(customDates))}
              >
                {t.clearAll}
              </button>
            </div>
          </div>

          <div className="max-h-[34vh] space-y-1 overflow-y-auto rounded-lg border border-border p-1.5">
            {loadingHols ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> {t.loading}
              </div>
            ) : pubHolidays.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">{t.noPublicHolidays}</p>
            ) : (
              pubHolidays.map(h => {
                const on = accepted.has(h.date);
                return (
                  <div
                    role="button"
                    tabIndex={0}
                    key={h.date}
                    onClick={() => toggleHoliday(h.date)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHoliday(h.date); } }}
                    className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${on ? 'bg-primary/5' : 'hover:bg-accent/50'}`}
                  >
                    <Checkbox checked={on} tabIndex={-1} className="pointer-events-none" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{h.name}</p>
                      <p className="text-[11px] text-muted-foreground">{h.date}</p>
                    </div>
                    {on ? (
                      // Accepted — classify it for the roster schedule (defaults to Poya when
                      // auto-detected, else Public; pick Mercantile by hand if applicable).
                      <HolidayTypePicker value={typeFor(h.date, h.is_poya)} onChange={(type) => setType(h.date, type)} />
                    ) : h.is_poya && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning">
                        <Moon className="h-3 w-3" />{t.poyaLabel}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Custom dates: add a company-specific holiday not in the public list */}
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t.customDatesLabel}</p>
            {/* Two rows so the name field always has room to show what's typed — cramming
                date + name + type + Add onto one line squished the name box to nothing. */}
            <div className="space-y-2 rounded-lg border border-border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="date"
                  aria-label="Date"
                  value={newDate}
                  min={`${year}-01-01`}
                  max={`${year}-12-31`}
                  onChange={e => setNewDate(e.target.value)}
                  className="h-9 flex-1 min-w-[9.5rem]"
                />
                <HolidayTypePicker value={newType} onChange={setNewType} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="custom-holiday-name" className="text-[11px] font-medium text-muted-foreground">
                  {t.holidayNameLabel}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="custom-holiday-name"
                    value={newName}
                    placeholder={t.holidayNamePlaceholder}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomDate(); } }}
                    className="h-9 flex-1"
                  />
                  <Button type="button" onClick={addCustomDate} disabled={!newDate} className="h-9 shrink-0 gap-1 px-3">
                    <Plus className="h-4 w-4" />{t.addLabel}
                  </Button>
                </div>
              </div>
            </div>
            {customList.length > 0 && (
              <div className="space-y-1 rounded-lg border border-border p-1.5">
                {customList.map(c => (
                  <div key={c.date} className="flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-accent/50">
                    <span className="inline-flex shrink-0 items-center rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-[10px] font-semibold text-brand">
                      {t.customBadge}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{c.name}</p>
                      <p className="text-[11px] text-muted-foreground">{c.date}</p>
                    </div>
                    <HolidayTypePicker value={typeFor(c.date)} onChange={(type) => setType(c.date, type)} />
                    <button
                      type="button"
                      onClick={() => removeCustomDate(c.date)}
                      className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      aria-label={c.name}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={savingHols}>
              {t.cancel}
            </Button>
            <Button onClick={saveHolidays} disabled={savingHols || loadingHols} className="gap-2">
              {savingHols ? <><Loader2 className="h-4 w-4 animate-spin" />{t.saving}</> : <><Check className="h-4 w-4" />{t.save}</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
