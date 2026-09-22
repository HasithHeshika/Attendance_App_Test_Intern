'use client';

import React, { useState, useRef, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  CalendarDays,
  Users,
  Sparkles,
  Cake,
  Check,
  Building2,
  CheckCircle2,
  Calendar,
} from 'lucide-react';
import {
  format,
  addMonths,
  subMonths,
  getDaysInMonth,
  startOfMonth,
  getDay,
  isSameMonth,
  isAfter,
  startOfDay,
} from 'date-fns';
import { useT } from '@/store/appStore';
import { cn } from '@/lib/utils';
import type { BirthdayPersonInfo } from '@/components/overview/BirthdayTooltipChip';
import type { HolidayStaffInfo } from '@/components/overview/HolidayTooltipChip';

export interface DaySummaryData {
  date: string;
  present: number;
  onLeave: number;
  missing: number;
  total: number;
  birthdays: string[];
  birthdayPeople?: BirthdayPersonInfo[];
  presentPeople?: HolidayStaffInfo[];
}

export interface OverviewMonthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  calMonth: Date;
  onMonthChange: (month: Date) => void;
  selectedDay: string;
  onSelectDay: (day: string) => void;
  calData: Record<string, DaySummaryData>;
  holidays: Record<string, string>;
  loading?: boolean;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getInitials(n: string) {
  const parts = n.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function DayCardTooltipContent({
  ds,
  holidayName,
  summary,
  kind,
}: {
  ds: string;
  holidayName?: string;
  summary?: DaySummaryData;
  kind: 'holiday' | 'future' | 'rest' | 'empty' | 'worked';
}) {
  const isPoya = holidayName ? /poya|full moon/i.test(holidayName) : false;
  const bdays = summary?.birthdays ?? [];
  const bdayPeople = summary?.birthdayPeople ?? [];
  const denom = summary ? Math.max(1, summary.present + summary.onLeave + summary.missing) : 1;
  const turnoutPct = summary ? Math.round((summary.present / denom) * 100) : 0;

  return (
    <div className="z-[160] w-72 sm:w-80 p-3 rounded-2xl border border-border/80 bg-popover/95 backdrop-blur-2xl text-popover-foreground shadow-2xl space-y-2.5">
      {/* Day header */}
      <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-2">
        <span className="font-bold text-xs text-foreground">
          {format(new Date(`${ds}T00:00:00`), 'EEEE, d MMMM yyyy')}
        </span>
        <span
          className={cn(
            'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider',
            kind === 'holiday'
              ? 'bg-amber-500/20 text-amber-600 dark:text-amber-300 border border-amber-500/40'
              : kind === 'worked'
              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
              : kind === 'rest'
              ? 'bg-muted text-muted-foreground border border-border/60'
              : 'bg-primary/10 text-primary border border-primary/25'
          )}
        >
          {kind === 'holiday'
            ? (isPoya ? 'Full Moon Poya' : 'Public Holiday')
            : kind === 'worked'
            ? 'Worked Day'
            : kind === 'rest'
            ? 'Rest Day'
            : 'Upcoming'}
        </span>
      </div>

      {/* Holiday block */}
      {holidayName && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-bold text-amber-700 dark:text-amber-300">
            <span>{isPoya ? '🌕' : '🌴'}</span>
            <span className="leading-tight">{holidayName}</span>
          </div>
          {summary && (
            <div className="flex items-center justify-between text-[11px] pt-0.5">
              <span className="text-muted-foreground">Holiday Turnout:</span>
              {summary.present > 0 ? (
                <span className="inline-flex items-center gap-1 font-bold text-emerald-600 dark:text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  {summary.present} staff logged in
                </span>
              ) : (
                <span className="text-muted-foreground">Attendance exempt</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Birthday block */}
      {bdays.length > 0 && (
        <div className="rounded-xl border border-pink-500/30 bg-pink-500/10 p-2.5 space-y-1.5">
          <div className="flex items-center justify-between text-xs font-bold text-pink-700 dark:text-pink-300">
            <span className="flex items-center gap-1.5">
              <span>🎂</span>
              <span>{bdays.length} {bdays.length === 1 ? 'Birthday Today' : 'Birthdays Today'}</span>
            </span>
          </div>
          <div className="space-y-1.5 max-h-32 overflow-y-auto pr-0.5">
            {bdays.map((name, idx) => {
              const matchedPerson = bdayPeople.find(p => p.name === name || p.epf === name);
              return (
                <div key={`${name}-${idx}`} className="flex items-center justify-between gap-2 text-[11px]">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <Avatar className="h-5 w-5 rounded-full ring-1 ring-pink-400/40 shrink-0">
                      {matchedPerson?.avatar && <AvatarImage src={matchedPerson.avatar} alt={name} />}
                      <AvatarFallback className="bg-pink-500/20 text-pink-700 dark:text-pink-200 text-[9px] font-bold">
                        {getInitials(name)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="font-semibold text-foreground truncate">{name}</span>
                  </div>
                  {matchedPerson?.department && (
                    <span className="text-[10px] text-muted-foreground truncate bg-muted/60 px-1.5 py-0.2 rounded shrink-0">
                      {matchedPerson.department}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Attendance stats block */}
      {summary && (kind === 'worked' || summary.present > 0) && (
        <div className="rounded-xl border border-border/70 bg-card/60 p-2.5 space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-muted-foreground">Attendance Turnout:</span>
            <span className="font-bold text-foreground font-mono">{turnoutPct}%</span>
          </div>
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-emerald-500" style={{ width: `${(summary.present / denom) * 100}%` }} />
            <div className="h-full bg-cyan-500" style={{ width: `${(summary.onLeave / denom) * 100}%` }} />
            <div className="h-full bg-rose-500" style={{ width: `${(summary.missing / denom) * 100}%` }} />
          </div>
          <div className="flex items-center justify-between text-[11px] pt-0.5 text-muted-foreground font-mono">
            <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{summary.present} Present</span>
            <span>·</span>
            <span className="text-cyan-600 dark:text-cyan-400 font-medium">{summary.onLeave} Leave</span>
            <span>·</span>
            <span className="text-rose-600 dark:text-rose-400 font-medium">{summary.missing} Missing</span>
          </div>
        </div>
      )}

      {/* Click hint footer */}
      <div className="text-[10px] text-muted-foreground/80 flex items-center justify-between pt-0.5">
        <span>Click day to select</span>
        <ChevronRight className="h-3 w-3 text-muted-foreground" />
      </div>
    </div>
  );
}

export default function OverviewMonthModal({
  open,
  onOpenChange,
  calMonth,
  onMonthChange,
  selectedDay,
  onSelectDay,
  calData,
  holidays,
  loading = false,
}: OverviewMonthModalProps) {
  const t = useT();
  const [viewMode, setViewMode] = useState<'grid' | 'strip'>('grid');
  const stripScrollRef = useRef<HTMLDivElement | null>(null);

  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const todayStart = useMemo(() => startOfDay(new Date()), []);
  const isCurrentMonth = isSameMonth(calMonth, new Date());

  const daysInMonth = getDaysInMonth(calMonth);
  const firstDayOfMonth = startOfMonth(calMonth);
  const startDayOfWeek = getDay(firstDayOfMonth); // 0 = Sun, 1 = Mon ...

  const isFuture = (ds: string) => isAfter(startOfDay(new Date(`${ds}T00:00:00`)), todayStart);

  const dayKind = (ds: string): 'holiday' | 'future' | 'rest' | 'empty' | 'worked' => {
    if (holidays[ds]) return 'holiday';
    if (isFuture(ds)) return 'future';
    const d = calData[ds];
    if (!d || d.total === 0) return 'rest';
    if (d.present === 0) return 'empty';
    return 'worked';
  };

  const dayChrome = (ds: string): { bg: string; text: string; border: string } => {
    switch (dayKind(ds)) {
      case 'holiday':
        return { bg: 'bg-amber-500/10', text: 'text-amber-700 dark:text-amber-300', border: 'border-amber-500/30' };
      case 'future':
        return { bg: 'bg-muted/15', text: 'text-muted-foreground opacity-45', border: 'border-dashed border-border/60' };
      case 'rest':
        return { bg: 'bg-muted/30', text: 'text-muted-foreground', border: 'border-border/40' };
      case 'empty':
        return { bg: 'bg-destructive/10', text: 'text-destructive', border: 'border-destructive/30' };
      default: {
        const d = calData[ds];
        const pct = d.present / Math.max(1, d.total - d.onLeave);
        if (pct >= 0.8) return { bg: 'bg-success/10', text: 'text-success', border: 'border-success/30' };
        if (pct >= 0.5) return { bg: 'bg-warning/10', text: 'text-warning', border: 'border-warning/30' };
        return { bg: 'bg-destructive/10', text: 'text-destructive', border: 'border-destructive/30' };
      }
    }
  };

  // Popover open state and hover timer refs for Holidays and Birthdays chips
  const [holidaysOpen, setHolidaysOpen] = useState(false);
  const [birthdaysOpen, setBirthdaysOpen] = useState(false);
  const holidaysTimerRef = useRef<NodeJS.Timeout | null>(null);
  const birthdaysTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleHolidaysEnter = () => {
    if (holidaysTimerRef.current) clearTimeout(holidaysTimerRef.current);
    setHolidaysOpen(true);
  };
  const handleHolidaysLeave = () => {
    holidaysTimerRef.current = setTimeout(() => setHolidaysOpen(false), 220);
  };

  const handleBirthdaysEnter = () => {
    if (birthdaysTimerRef.current) clearTimeout(birthdaysTimerRef.current);
    setBirthdaysOpen(true);
  };
  const handleBirthdaysLeave = () => {
    birthdaysTimerRef.current = setTimeout(() => setBirthdaysOpen(false), 220);
  };

  // Monthly stats
  const monthStats = useMemo(() => {
    let workedDays = 0;
    let holidaysCount = 0;
    let workedHolidaysCount = 0;
    let holidayStaffCount = 0;
    let birthdaysCount = 0;
    let totalPresent = 0;
    let totalExpected = 0;
    let restDaysCount = 0;
    let futureDaysCount = 0;
    let bestDay: { date: string; rate: number } | null = null;

    for (let i = 1; i <= daysInMonth; i++) {
      const ds = `${format(calMonth, 'yyyy-MM')}-${String(i).padStart(2, '0')}`;
      if (holidays[ds]) holidaysCount++;
      const bCount = calData[ds]?.birthdays?.length ?? 0;
      birthdaysCount += bCount;
      const s = calData[ds];
      const kind = dayKind(ds);
      if (kind === 'worked') {
        workedDays++;
        if (s) {
          const exp = Math.max(0, s.total - s.onLeave);
          totalPresent += s.present;
          totalExpected += exp;
          if (exp > 0) {
            const rate = Math.round((s.present / exp) * 100);
            if (!bestDay || rate > bestDay.rate) {
              bestDay = { date: format(new Date(`${ds}T00:00:00`), 'EEE, d MMM'), rate };
            }
          }
        }
      } else if (kind === 'holiday') {
        if (s && s.present > 0) {
          workedHolidaysCount++;
          holidayStaffCount += s.present;
          totalPresent += s.present;
        }
      } else if (kind === 'rest') {
        restDaysCount++;
        if (s && s.present > 0) {
          totalPresent += s.present;
        }
      } else if (kind === 'future') {
        futureDaysCount++;
      }
    }
    const avgRate = totalExpected > 0 ? Math.round((totalPresent / totalExpected) * 100) : null;
    return {
      workedDays,
      holidaysCount,
      workedHolidaysCount,
      holidayStaffCount,
      birthdaysCount,
      avgRate,
      totalPresent,
      totalExpected,
      restDaysCount,
      futureDaysCount,
      bestDay,
    };
  }, [calData, calMonth, daysInMonth, holidays]);

  const monthHolidays = useMemo(() => {
    const list: Array<{
      date: string;
      name: string;
      present: number;
    }> = [];
    for (let i = 1; i <= daysInMonth; i++) {
      const ds = `${format(calMonth, 'yyyy-MM')}-${String(i).padStart(2, '0')}`;
      if (holidays[ds]) {
        list.push({
          date: ds,
          name: holidays[ds],
          present: calData[ds]?.present ?? 0,
        });
      }
    }
    return list;
  }, [calData, calMonth, daysInMonth, holidays]);

  const monthBirthdaysList = useMemo(() => {
    const list: Array<{
      date: string;
      name: string;
      department?: string;
      designation?: string;
      avatar?: string;
      epf?: string;
    }> = [];
    for (let i = 1; i <= daysInMonth; i++) {
      const ds = `${format(calMonth, 'yyyy-MM')}-${String(i).padStart(2, '0')}`;
      const s = calData[ds];
      if (s?.birthdays?.length) {
        s.birthdays.forEach(name => {
          const matched = s.birthdayPeople?.find(p => p.name === name || p.epf === name);
          list.push({
            date: ds,
            name,
            department: matched?.department,
            designation: matched?.designation,
            avatar: matched?.avatar,
            epf: matched?.epf,
          });
        });
      }
    }
    return list;
  }, [calData, calMonth, daysInMonth]);

  const scrollStrip = (dir: 'left' | 'right') => {
    if (stripScrollRef.current) {
      const amount = dir === 'left' ? -260 : 260;
      stripScrollRef.current.scrollBy({ left: amount, behavior: 'smooth' });
    }
  };

  const selectedSummary = calData[selectedDay];
  const selectedKind = dayKind(selectedDay);
  const selectedHoliday = holidays[selectedDay];
  const selectedBdays = selectedSummary?.birthdays ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl w-[calc(100%-2rem)] max-h-[92vh] flex flex-col p-4 sm:p-6 overflow-hidden rounded-2xl border border-border/80 bg-card/95 backdrop-blur-2xl shadow-2xl">
        {/* Modal Top Header */}
        <DialogHeader className="mb-0 flex-shrink-0">
          {/* pr-10 — DialogContent's own close button is position: absolute (right-4 top-4,
              ~2.5rem of footprint including its own padding+icon), completely outside this
              row's flex layout. justify-between pushes the View Mode toggle all the way to
              this row's own right edge with no awareness that the close button already claims
              that same corner, which is what let "Timeline Strip" overlap/clip under it. */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-2 pr-10 border-b border-border/60">
            {/* Title & Month Navigation */}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 rounded-lg"
                aria-label={t.ovsPrevMonth}
                onClick={() => onMonthChange(subMonths(calMonth, 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>

              <span className="text-base sm:text-lg font-bold text-foreground min-w-[130px] text-center tracking-tight">
                {format(calMonth, 'MMMM yyyy')}
              </span>

              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 rounded-lg"
                aria-label={t.ovsNextMonth}
                disabled={isCurrentMonth}
                onClick={() => onMonthChange(addMonths(calMonth, 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>

              {!isCurrentMonth && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs font-semibold text-primary"
                  onClick={() => {
                    onMonthChange(new Date());
                    onSelectDay(todayStr);
                  }}
                >
                  Current Month
                </Button>
              )}
            </div>

            {/* View Mode Toggle */}
            <div className="flex items-center gap-1.5 p-1 rounded-xl bg-muted/60 border border-border/60">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setViewMode('grid')}
                className={cn(
                  'h-7 px-2.5 rounded-lg text-xs font-medium gap-1.5 transition-all',
                  viewMode === 'grid'
                    ? 'bg-background shadow-xs text-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                <span>Calendar Grid</span>
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setViewMode('strip')}
                className={cn(
                  'h-7 px-2.5 rounded-lg text-xs font-medium gap-1.5 transition-all',
                  viewMode === 'strip'
                    ? 'bg-background shadow-xs text-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <CalendarDays className="h-3.5 w-3.5" />
                <span>Timeline Strip</span>
              </Button>
            </div>
          </div>

          {/* Month KPI Badges with interactive tooltips & popovers */}
          <div className="flex flex-wrap items-center gap-2 pt-2.5">
            {/* 1. Working Days */}
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5 rounded-lg bg-muted/40 hover:bg-muted/70 border border-border/50 hover:border-border/80 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer transition-colors shadow-xs">
                    <Calendar className="h-3.5 w-3.5 text-primary" />
                    <span className="font-semibold text-foreground">{monthStats.workedDays}</span>
                    <span>Working Days</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="z-[160] w-72 p-3 space-y-2.5 rounded-xl border border-border/80 bg-popover/95 backdrop-blur-xl shadow-2xl">
                  <div className="flex items-center justify-between border-b border-border/50 pb-2">
                    <div className="flex items-center gap-2">
                      <div className="h-6 w-6 rounded-md bg-primary/15 text-primary flex items-center justify-center text-xs">
                        📅
                      </div>
                      <span className="font-bold text-xs text-foreground">Working Days Schedule</span>
                    </div>
                    <span className="text-[10px] font-mono text-muted-foreground">{monthStats.workedDays} / {daysInMonth} days</span>
                  </div>

                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-center justify-between py-0.5">
                      <span className="text-muted-foreground flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-primary" />
                        Operational Working Days:
                      </span>
                      <span className="font-bold font-mono text-foreground">{monthStats.workedDays}</span>
                    </div>
                    <div className="flex items-center justify-between py-0.5">
                      <span className="text-muted-foreground flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-slate-400" />
                        Rest Days / Sundays:
                      </span>
                      <span className="font-medium font-mono text-foreground">{monthStats.restDaysCount}</span>
                    </div>
                    {monthStats.holidaysCount > 0 && (
                      <div className="flex items-center justify-between py-0.5">
                        <span className="text-muted-foreground flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full bg-amber-500" />
                          Statutory Holidays:
                        </span>
                        <span className="font-medium font-mono text-amber-600 dark:text-amber-400">
                          {monthStats.holidaysCount}
                          {monthStats.workedHolidaysCount > 0 && (
                            <span className="text-[10px] text-muted-foreground ml-1">
                              ({monthStats.workedHolidaysCount} with duty staff)
                            </span>
                          )}
                        </span>
                      </div>
                    )}
                    {monthStats.futureDaysCount > 0 && (
                      <div className="flex items-center justify-between py-0.5">
                        <span className="text-muted-foreground flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full bg-purple-400" />
                          Upcoming Days Remaining:
                        </span>
                        <span className="font-medium font-mono text-foreground">{monthStats.futureDaysCount}</span>
                      </div>
                    )}
                  </div>

                  <div className="pt-1.5 border-t border-border/40 text-[10px] text-muted-foreground/80 flex items-center justify-between">
                    <span>Month total: {daysInMonth} calendar days</span>
                    <span className="text-primary font-medium">Click any day to view</span>
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {/* 2. Avg Turnout */}
            {monthStats.avgRate != null && (
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-1.5 rounded-lg bg-success/10 hover:bg-success/20 border border-success/30 hover:border-success/50 px-2.5 py-1 text-xs text-success font-medium cursor-pointer transition-colors shadow-xs">
                      <Users className="h-3.5 w-3.5" />
                      <span className="font-bold">{monthStats.avgRate}%</span>
                      <span>Avg Turnout</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="start" className="z-[160] w-72 p-3 space-y-2.5 rounded-xl border border-success/30 bg-popover/95 backdrop-blur-xl shadow-2xl">
                    <div className="flex items-center justify-between border-b border-border/50 pb-2">
                      <div className="flex items-center gap-2">
                        <div className="h-6 w-6 rounded-md bg-success/15 text-success flex items-center justify-center text-xs">
                          📊
                        </div>
                        <span className="font-bold text-xs text-foreground">Monthly Turnout Insights</span>
                      </div>
                      <span className="text-[10px] font-bold text-success bg-success/15 px-1.5 py-0.5 rounded-full">{monthStats.avgRate}% Rate</span>
                    </div>

                    <div className="space-y-1.5 text-xs">
                      <div className="flex items-center justify-between py-0.5">
                        <span className="text-muted-foreground">Cumulative Present Logins:</span>
                        <span className="font-mono font-bold text-foreground">{monthStats.totalPresent.toLocaleString()}</span>
                      </div>
                      <div className="flex items-center justify-between py-0.5">
                        <span className="text-muted-foreground">Expected Operational Capacity:</span>
                        <span className="font-mono text-muted-foreground">{monthStats.totalExpected.toLocaleString()}</span>
                      </div>
                      <div className="flex items-center justify-between py-0.5">
                        <span className="text-muted-foreground">Daily Average Present:</span>
                        <span className="font-mono font-semibold text-success">{Math.round(monthStats.totalPresent / Math.max(1, monthStats.workedDays))} staff / day</span>
                      </div>
                      {monthStats.bestDay && (
                        <div className="flex items-center justify-between py-0.5 text-[11px]">
                          <span className="text-muted-foreground">Highest Turnout Day:</span>
                          <span className="font-medium text-emerald-600 dark:text-emerald-400">{monthStats.bestDay.date} ({monthStats.bestDay.rate}%)</span>
                        </div>
                      )}
                    </div>

                    <div className="pt-1.5 border-t border-border/40 text-[10px] text-muted-foreground/80">
                      Calculated across {monthStats.workedDays} working days with recorded attendance
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}

            {/* 3. Holidays */}
            {monthStats.holidaysCount > 0 && (
              <Popover open={holidaysOpen} onOpenChange={setHolidaysOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    onMouseEnter={handleHolidaysEnter}
                    onMouseLeave={handleHolidaysLeave}
                    onClick={() => setHolidaysOpen(prev => !prev)}
                    className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 hover:border-amber-500/50 px-2.5 py-1 text-xs text-amber-700 dark:text-amber-300 font-medium cursor-pointer transition-colors shadow-xs"
                  >
                    <span>🌕</span>
                    <span className="font-bold">{monthStats.holidaysCount}</span>
                    <span>{monthStats.holidaysCount === 1 ? 'Holiday' : 'Holidays'}</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="start"
                  sideOffset={6}
                  onMouseEnter={handleHolidaysEnter}
                  onMouseLeave={handleHolidaysLeave}
                  className="z-[160] w-80 sm:w-88 p-3 space-y-2.5 rounded-xl border border-amber-500/30 bg-popover/95 backdrop-blur-xl shadow-2xl"
                >
                  <div className="flex items-center justify-between border-b border-border/50 pb-2">
                    <div className="flex items-center gap-2">
                      <div className="h-6 w-6 rounded-md bg-amber-500/20 text-amber-600 dark:text-amber-300 flex items-center justify-center text-xs">
                        🌕
                      </div>
                      <span className="font-bold text-xs text-foreground">
                        {monthStats.holidaysCount} {monthStats.holidaysCount === 1 ? 'Holiday' : 'Holidays'} in {format(calMonth, 'MMMM yyyy')}
                      </span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">Click to jump</span>
                  </div>

                  <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                    {monthHolidays.map(h => (
                      <div
                        key={h.date}
                        onClick={() => {
                          onSelectDay(h.date);
                          setHolidaysOpen(false);
                        }}
                        className={cn(
                          'group/h flex items-center justify-between gap-2 p-2 rounded-lg border transition-all cursor-pointer',
                          h.date === selectedDay
                            ? 'bg-amber-500/15 border-amber-500/40 ring-1 ring-amber-500/40'
                            : 'bg-muted/30 hover:bg-accent/60 border-border/60 hover:border-amber-500/30'
                        )}
                      >
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-foreground truncate group-hover/h:text-amber-600 dark:group-hover/h:text-amber-300">
                              {h.name}
                            </span>
                          </div>
                          <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                            <span>📅 {format(new Date(`${h.date}T00:00:00`), 'EEE, d MMM yyyy')}</span>
                          </div>
                        </div>

                        <div className="shrink-0 flex items-center gap-1.5">
                          {h.present > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                              {h.present} worked
                            </span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
                              Off
                            </span>
                          )}
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground group-hover/h:text-amber-500 group-hover/h:translate-x-0.5 transition-all" />
                        </div>
                      </div>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}

            {/* 4. Birthdays */}
            {monthStats.birthdaysCount > 0 && (
              <Popover open={birthdaysOpen} onOpenChange={setBirthdaysOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    onMouseEnter={handleBirthdaysEnter}
                    onMouseLeave={handleBirthdaysLeave}
                    onClick={() => setBirthdaysOpen(prev => !prev)}
                    className="flex items-center gap-1.5 rounded-lg bg-pink-500/10 hover:bg-pink-500/20 border border-pink-500/30 hover:border-pink-500/50 px-2.5 py-1 text-xs text-pink-700 dark:text-pink-300 font-medium cursor-pointer transition-colors shadow-xs"
                  >
                    <span>🎂</span>
                    <span className="font-bold">{monthStats.birthdaysCount}</span>
                    <span>{monthStats.birthdaysCount === 1 ? 'Birthday' : 'Birthdays'}</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="start"
                  sideOffset={6}
                  onMouseEnter={handleBirthdaysEnter}
                  onMouseLeave={handleBirthdaysLeave}
                  className="z-[160] w-84 sm:w-92 p-3 space-y-2.5 rounded-xl border border-pink-500/30 bg-popover/95 backdrop-blur-xl shadow-2xl"
                >
                  <div className="flex items-center justify-between border-b border-border/50 pb-2">
                    <div className="flex items-center gap-2">
                      <div className="h-6 w-6 rounded-md bg-pink-500/20 text-pink-600 dark:text-pink-300 flex items-center justify-center text-xs">
                        🎂
                      </div>
                      <span className="font-bold text-xs text-foreground">
                        {monthStats.birthdaysCount} Birthdays in {format(calMonth, 'MMMM yyyy')}
                      </span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">Click to jump</span>
                  </div>

                  <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                    {monthBirthdaysList.map((item, idx) => (
                      <div
                        key={`${item.date}-${item.name}-${idx}`}
                        onClick={() => {
                          onSelectDay(item.date);
                          setBirthdaysOpen(false);
                        }}
                        className={cn(
                          'group/b flex items-center justify-between gap-2 p-2 rounded-lg border transition-all cursor-pointer',
                          item.date === selectedDay
                            ? 'bg-pink-500/15 border-pink-500/40 ring-1 ring-pink-500/40'
                            : 'bg-muted/30 hover:bg-accent/60 border-border/60 hover:border-pink-500/30'
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <Avatar className="h-7 w-7 rounded-full ring-1 ring-pink-400/40 shrink-0">
                            {item.avatar && <AvatarImage src={item.avatar} alt={item.name} />}
                            <AvatarFallback className="bg-pink-500/20 text-pink-700 dark:text-pink-200 text-[10px] font-bold">
                              {getInitials(item.name)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-semibold text-foreground truncate group-hover/b:text-pink-600 dark:group-hover/b:text-pink-300">
                              {item.name}
                            </div>
                            <div className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                              {item.department && <span>{item.department} ·</span>}
                              <span>{format(new Date(`${item.date}T00:00:00`), 'd MMMM')}</span>
                            </div>
                          </div>
                        </div>

                        <div className="shrink-0 flex items-center gap-1">
                          <span className="text-[10px] font-medium bg-pink-500/15 text-pink-700 dark:text-pink-300 border border-pink-500/25 px-1.5 py-0.2 rounded-md">
                            {format(new Date(`${item.date}T00:00:00`), 'd MMM')}
                          </span>
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground group-hover/b:text-pink-500 group-hover/b:translate-x-0.5 transition-all" />
                        </div>
                      </div>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </DialogHeader>

        {/* Modal Body: Grid or Strip. px-1 alongside the existing py-3 — this is the
            overflow-y-auto scroll container itself, and with no horizontal padding at all the
            grid's rightmost (Saturday) column sat flush against its own right edge, exactly
            where the vertical scrollbar track renders, clipping that column's border/focus
            ring. Equal padding on both sides keeps the grid visually centred and clear of it. */}
        <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-1 py-3 space-y-3">
          {viewMode === 'grid' ? (
            /* 7-Column Calendar Grid */
            <div className="w-full space-y-2">
              {/* Day of Week Headers */}
              <div className="grid grid-cols-7 gap-2 text-center text-xs font-semibold text-muted-foreground pb-1 border-b border-border/40">
                {WEEKDAYS.map((wd, i) => (
                  <div key={wd} className={cn(i === 0 && 'text-rose-500/90 dark:text-rose-400/90')}>
                    {wd}
                  </div>
                ))}
              </div>

              {/* Day Cards Grid */}
              <div className="grid grid-cols-7 gap-2">
                {/* Blank placeholder cells for preceding days */}
                {Array.from({ length: startDayOfWeek }).map((_, idx) => (
                  <div
                    key={`blank-${idx}`}
                    className="min-h-[76px] sm:min-h-[88px] rounded-xl border border-transparent bg-muted/10 opacity-30"
                  />
                ))}

                {/* Days of the Month */}
                {Array.from({ length: daysInMonth }).map((_, idx) => {
                  const d = idx + 1;
                  const ds = `${format(calMonth, 'yyyy-MM')}-${String(d).padStart(2, '0')}`;
                  const isSel = ds === selectedDay;
                  const isT = ds === todayStr;
                  const kind = dayKind(ds);
                  const summary = calData[ds];
                  const hasBirthday = (summary?.birthdays?.length ?? 0) > 0;
                  const bdays = summary?.birthdays ?? [];
                  const holidayName = holidays[ds];
                  const { bg, text, border } = dayChrome(ds);
                  const denom = summary ? Math.max(1, summary.present + summary.onLeave + summary.missing) : 1;

                  return (
                    <TooltipProvider key={d} delayDuration={120}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => onSelectDay(ds)}
                            className={cn(
                              // overflow-hidden + min-w-0: at 7 columns this cell is only
                              // ~45-50px wide on a phone — nowhere near enough for "Rest Day" +
                              // "Xp worked" on one line. Without a hard boundary that text (and
                              // this cell's own min-content width as a grid item) spills past
                              // the button's own box into the NEXT column instead of wrapping or
                              // clipping — which is what read as Sep 7 being "displaced": it's
                              // Sep 6's overflow painting across it, not an actual grid-position bug.
                              'group relative min-h-[76px] sm:min-h-[88px] min-w-0 overflow-hidden p-2 rounded-xl border flex flex-col justify-between text-left transition-all duration-150',
                              bg,
                              border,
                              isSel && 'ring-2 ring-primary border-primary shadow-md bg-primary/10',
                              isT && !isSel && 'ring-1 ring-primary/60',
                              'hover:border-primary/50 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary'
                            )}
                          >
                            {/* Card Top: Day number + Kind Badge */}
                            <div className="flex items-start justify-between gap-1">
                              <span className={cn('text-sm sm:text-base font-bold leading-none', text)}>
                                {d}
                              </span>

                              <div className="flex items-center gap-1">
                                {kind === 'holiday' && (
                                  <span className="rounded bg-amber-500/20 text-amber-700 dark:text-amber-300 px-1 text-[9px] font-extrabold leading-tight">
                                    PH
                                  </span>
                                )}
                                {hasBirthday && (
                                  <span className="text-[11px] leading-none select-none" title="Birthday">
                                    🎂
                                  </span>
                                )}
                                {kind === 'empty' && (
                                  <span className="rounded bg-destructive/20 text-destructive px-1 text-[9px] font-bold leading-tight">
                                    0
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* Card Middle: Short Holiday / Birthday Tag */}
                            <div className="min-w-0 py-0.5 space-y-0.5">
                              {holidayName && (
                                <p className="text-[10px] text-amber-600 dark:text-amber-300 font-semibold truncate leading-tight">
                                  {holidayName}
                                </p>
                              )}
                              {hasBirthday && !holidayName && (
                                <p className="text-[10px] text-pink-600 dark:text-pink-300 font-semibold truncate leading-tight">
                                  {bdays[0]}
                                </p>
                              )}
                            </div>

                            {/* Card Bottom: Stacked Progress Bar & Ratio */}
                            <div className="space-y-1">
                              {summary && (kind === 'worked' || kind === 'empty') ? (
                                <>
                                  <div className="flex h-1 w-full overflow-hidden rounded-full bg-border/60">
                                    <div className="h-full bg-success" style={{ width: `${(summary.present / denom) * 100}%` }} />
                                    <div className="h-full bg-brand" style={{ width: `${(summary.onLeave / denom) * 100}%` }} />
                                    <div className="h-full bg-destructive" style={{ width: `${(summary.missing / denom) * 100}%` }} />
                                  </div>
                                  <div className="flex flex-wrap items-center justify-between gap-x-1 text-[9px] text-muted-foreground leading-none">
                                    <span>{summary.present}p</span>
                                    <span>{Math.round((summary.present / denom) * 100)}%</span>
                                  </div>
                                </>
                              ) : summary && summary.present > 0 ? (
                                <>
                                  <div className="flex h-1 w-full overflow-hidden rounded-full bg-amber-500/20">
                                    <div className="h-full bg-emerald-500 rounded-full" style={{ width: '100%' }} />
                                  </div>
                                  {/* flex-wrap, not nowrap — "Rest Day" + "Xp worked" together
                                      rarely fit one line at this cell width; wrapping to a
                                      second line (the cell's min-h can grow) keeps both fully
                                      readable instead of overflowing into the next column. */}
                                  <div className="flex flex-wrap items-center justify-between gap-x-1 gap-y-0.5 text-[9px] leading-none">
                                    <span className="text-amber-700 dark:text-amber-300 font-medium">
                                      {kind === 'holiday' ? 'Holiday' : 'Rest Day'}
                                    </span>
                                    <span className="font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse flex-shrink-0" />
                                      {summary.present}p worked
                                    </span>
                                  </div>
                                </>
                              ) : (
                                <div className="text-[9px] text-muted-foreground/60 leading-none capitalize">
                                  {kind === 'rest' ? 'Rest Day' : kind === 'holiday' ? 'Holiday' : ''}
                                </div>
                              )}
                            </div>
                          </button>
                        </TooltipTrigger>

                        <TooltipContent side="top" className="z-[150] p-0 border-none bg-transparent shadow-none">
                          <DayCardTooltipContent
                            ds={ds}
                            holidayName={holidayName}
                            summary={summary}
                            kind={kind}
                          />
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  );
                })}
              </div>
            </div>
          ) : (
            /* Timeline Strip View (Controlled and horizontally contained) */
            <div className="w-full min-w-0 relative flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => scrollStrip('left')}
                className="h-10 w-10 rounded-xl shrink-0 shadow-sm"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>

              <div
                ref={stripScrollRef}
                className="flex-1 min-w-0 overflow-x-auto flex gap-2 py-3 px-1 scrollbar-thin"
              >
                {Array.from({ length: daysInMonth }).map((_, idx) => {
                  const d = idx + 1;
                  const ds = `${format(calMonth, 'yyyy-MM')}-${String(d).padStart(2, '0')}`;
                  const isSel = ds === selectedDay;
                  const isT = ds === todayStr;
                  const kind = dayKind(ds);
                  const summary = calData[ds];
                  const hasBirthday = (summary?.birthdays?.length ?? 0) > 0;
                  const bdays = summary?.birthdays ?? [];
                  const holidayName = holidays[ds];
                  const { bg, text, border } = dayChrome(ds);
                  const dow = format(new Date(`${ds}T00:00:00`), 'EEEEE');
                  const denom = summary ? Math.max(1, summary.present + summary.onLeave + summary.missing) : 1;

                  return (
                    <TooltipProvider key={d} delayDuration={120}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => onSelectDay(ds)}
                            className={cn(
                              'min-w-[56px] w-14 shrink-0 rounded-xl flex flex-col items-center justify-between border py-2 relative transition-all duration-150',
                              bg,
                              border,
                              isSel && 'ring-2 ring-primary border-primary shadow-md bg-primary/10',
                              isT && !isSel && 'ring-1 ring-primary/60',
                              'hover:border-primary/50'
                            )}
                          >
                            <span className="text-[10px] uppercase text-muted-foreground font-semibold leading-none">
                              {dow}
                            </span>
                            <span className={cn('text-base font-bold leading-none mt-1', text)}>
                              {d}
                            </span>

                            {kind === 'holiday' && (
                              <div className="flex flex-col items-center mt-0.5">
                                <span className="text-[8px] font-bold text-amber-600 dark:text-amber-300 leading-none">
                                  PH
                                </span>
                                {summary && summary.present > 0 && (
                                  <span className="text-[8px] font-bold text-emerald-600 dark:text-emerald-400 leading-none mt-0.5">
                                    {summary.present}p
                                  </span>
                                )}
                              </div>
                            )}
                            {kind === 'rest' && summary && summary.present > 0 && (
                              <span className="text-[8px] font-bold text-emerald-600 dark:text-emerald-400 leading-none mt-1">
                                {summary.present}p
                              </span>
                            )}
                            {kind === 'empty' && (
                              <span className="text-[9px] font-semibold text-destructive leading-none mt-1">
                                0
                              </span>
                            )}
                            {kind === 'worked' && summary && (
                              <span className={cn('text-[9px] font-semibold opacity-80 mt-1 leading-none', text)}>
                                {summary.present}p
                              </span>
                            )}

                            {/* Stacked bar */}
                            <span className="mt-1.5 flex h-1 w-9 overflow-hidden rounded-full bg-border/70" aria-hidden>
                              {summary && (kind === 'worked' || kind === 'empty') ? (
                                <>
                                  <span className="h-full bg-success" style={{ width: `${(summary.present / denom) * 100}%` }} />
                                  <span className="h-full bg-brand" style={{ width: `${(summary.onLeave / denom) * 100}%` }} />
                                  <span className="h-full bg-destructive" style={{ width: `${(summary.missing / denom) * 100}%` }} />
                                </>
                              ) : summary && summary.present > 0 ? (
                                <span className="h-full bg-emerald-500 w-full" />
                              ) : null}
                            </span>

                            {hasBirthday && (
                              <span className="absolute -top-1 -right-1 text-[10px] leading-none">
                                🎂
                              </span>
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="z-[150] p-0 border-none bg-transparent shadow-none">
                          <DayCardTooltipContent
                            ds={ds}
                            holidayName={holidayName}
                            summary={summary}
                            kind={kind}
                          />
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  );
                })}
              </div>

              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => scrollStrip('right')}
                className="h-10 w-10 rounded-xl shrink-0 shadow-sm"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>

        {/* Modal Bottom: Selected Day Summary & Close Button */}
        <div className="flex-shrink-0 pt-3 border-t border-border/60 flex flex-wrap items-center justify-between gap-3 bg-muted/20 -mx-4 -mb-4 sm:-mx-6 sm:-mb-6 p-4 rounded-b-2xl">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-bold text-foreground text-sm">
                {format(new Date(`${selectedDay}T00:00:00`), 'EEE, d MMM yyyy')}
              </span>
              <span className="rounded-full bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 font-semibold text-[10px]">
                Selected
              </span>
            </div>

            {selectedHoliday && (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-300 font-medium bg-amber-500/10 border border-amber-500/25 px-2 py-0.5 rounded-full text-[11px]">
                <span>🌕</span>
                <span>{selectedHoliday}</span>
              </span>
            )}

            {selectedBdays.length > 0 && (
              <span className="inline-flex items-center gap-1 text-pink-600 dark:text-pink-300 font-medium bg-pink-500/10 border border-pink-500/25 px-2 py-0.5 rounded-full text-[11px]">
                <span>🎂</span>
                <span>{selectedBdays.join(', ')}</span>
              </span>
            )}

            {selectedSummary && selectedKind === 'worked' && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="font-semibold text-foreground">
                  {selectedSummary.present} / {selectedSummary.total} present
                </span>
                <span>· {selectedSummary.onLeave} leave</span>
                <span>· {selectedSummary.missing} missing</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="h-8 px-4 text-xs font-semibold gap-1.5 shadow-sm"
            >
              <Check className="h-3.5 w-3.5" />
              <span>Done</span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
