'use client';

import React, { useState, useRef } from 'react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { CalendarDays, Sparkles, Moon, Sun, Users, Palmtree, ShieldCheck, ChevronRight, Clock, Building2, MapPin } from 'lucide-react';
import { format } from 'date-fns';
import { useT } from '@/store/appStore';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

export interface HolidayStaffInfo {
  epf: string;
  name: string;
  department?: string;
  designation?: string;
  avatar?: string;
  email?: string;
  company?: string;
  checkIn?: string | null;
  checkOut?: string | null;
  place?: string | null;
}

export interface HolidayTooltipChipProps {
  date: string; // yyyy-MM-dd
  name: string;
  summary?: {
    present: number;
    onLeave: number;
    missing: number;
    total: number;
  };
  holidayWord?: string;
  presentStaff?: HolidayStaffInfo[];
  onSelectPerson?: (epf: string) => void;
  className?: string;
}

export default function HolidayTooltipChip({
  date,
  name,
  summary,
  holidayWord,
  presentStaff,
  onSelectPerson,
  className,
}: HolidayTooltipChipProps) {
  const t = useT();
  const [isOpen, setIsOpen] = useState(false);
  const closeTimerRef = useRef<NodeJS.Timeout | null>(null);

  const isPoya = /poya|full moon/i.test(name);
  const isSpecialFestive = /new year|vesak|christmas|deepavali|id ul-fitr|ramadan|may day/i.test(name);

  const handleMouseEnter = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsOpen(true);
  };

  const handleMouseLeave = () => {
    closeTimerRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 220);
  };

  let formattedDate = date;
  try {
    formattedDate = format(new Date(`${date}T00:00:00`), 'EEEE, d MMMM yyyy');
  } catch {
    // fallback
  }

  const categoryLabel = isPoya
    ? t.ovPoyaHoliday
    : isSpecialFestive
      ? t.ovPublicHoliday
      : t.ovPublicHoliday;

  const noteText = isPoya ? t.ovPoyaNote : t.ovStatutoryHolidayNote;

  const getInitials = (n: string) => {
    const parts = n.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  };

  const hasPresentStaff = (summary?.present ?? 0) > 0;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={() => setIsOpen(prev => !prev)}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-label={`${holidayWord ?? t.holidayWord}: ${name}`}
          className={cn(
            'group flex h-8 items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 px-3.5 text-xs text-amber-700 dark:text-amber-300 shrink-0 max-w-[20rem] sm:max-w-[26rem] lg:max-w-[32rem] transition-all duration-200 cursor-pointer shadow-sm hover:shadow-amber-500/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40',
            isOpen && 'ring-2 ring-amber-500/40 bg-amber-500/20 border-amber-500/50 shadow-md shadow-amber-500/10',
            className
          )}
        >
          <span className="shrink-0 text-xs transition-transform duration-200 group-hover:scale-125">
            {isPoya ? '🌕' : '🌴'}
          </span>
          <span className="shrink-0 font-semibold text-amber-600 dark:text-amber-400">{holidayWord ?? t.holidayWord}:</span>
          <span className="truncate font-medium text-foreground dark:text-amber-200">{name}</span>
          {hasPresentStaff && (
            <span className="shrink-0 h-5 px-1.5 rounded-full bg-emerald-500/20 border border-emerald-500/35 text-emerald-600 dark:text-emerald-300 text-[10px] font-bold flex items-center justify-center tabular-nums gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              {summary?.present}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="z-[140] w-84 sm:w-96 rounded-2xl border border-amber-500/30 dark:border-amber-500/25 bg-popover/95 backdrop-blur-2xl p-4 text-popover-foreground shadow-2xl outline-none space-y-3.5 overflow-hidden relative animate-in fade-in-0 zoom-in-95 duration-200"
      >
        {/* Subtle decorative amber glow */}
        <div className="absolute top-0 inset-x-0 h-20 bg-gradient-to-b from-amber-500/15 to-transparent pointer-events-none rounded-t-2xl" />

        {/* Header with pill and date */}
        <div className="relative flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className={cn(
              'h-7 w-7 rounded-lg flex items-center justify-center text-sm shadow-sm ring-1',
              isPoya
                ? 'bg-amber-500/20 text-amber-600 dark:text-amber-300 ring-amber-500/40'
                : 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 ring-emerald-500/40'
            )}>
              {isPoya ? '🌕' : '🌴'}
            </div>
            <div>
              <span className="inline-block rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 tracking-wide uppercase">
                {categoryLabel}
              </span>
            </div>
          </div>

          <span className="text-[11px] font-medium text-muted-foreground shrink-0">
            {date}
          </span>
        </div>

        {/* Holiday name and details */}
        <div className="relative space-y-1">
          <h4 className="text-base font-bold text-foreground tracking-tight leading-snug">
            {name}
          </h4>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {noteText}
          </p>
          <div className="text-[11px] text-amber-600/90 dark:text-amber-400/90 font-medium pt-0.5">
            📅 {formattedDate}
          </div>
        </div>

        {/* Turnout & attendance breakdown for the holiday */}
        {summary && (
          <div className="relative rounded-xl border border-border/60 bg-muted/30 p-2.5 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground font-medium">
                {summary.present > 0
                  ? t.ovStaffLoggedOnHoliday.replace('{n}', String(summary.present))
                  : t.ovCompleteRestDay}
              </span>
            </div>
            {summary.present > 0 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                {summary.present}
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                Off
              </span>
            )}
          </div>
        )}

        {/* Logged in personnel list */}
        {hasPresentStaff && (
          <div className="relative space-y-2 pt-0.5">
            <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground px-0.5">
              <span className="flex items-center gap-1.5 font-semibold text-foreground/90 uppercase tracking-wider text-[10px]">
                <Sparkles className="h-3 w-3 text-amber-500 shrink-0" />
                Logged In Personnel ({presentStaff?.length ?? summary?.present})
              </span>
              {Boolean(onSelectPerson) && (
                <span className="text-[10px] text-muted-foreground/80">
                  {t.ovViewPersonDossier}
                </span>
              )}
            </div>

            {presentStaff && presentStaff.length > 0 ? (
              <div className="space-y-1.5 max-h-56 overflow-y-auto pr-0.5">
                {presentStaff.map((person, idx) => {
                  const hasEpf = Boolean(person.epf);
                  const clickable = hasEpf && Boolean(onSelectPerson);

                  return (
                    <div
                      key={person.epf || `${person.name}-${idx}`}
                      onClick={() => {
                        if (clickable && onSelectPerson) {
                          onSelectPerson(person.epf);
                          setIsOpen(false);
                        }
                      }}
                      className={cn(
                        'group/person rounded-xl border border-border/70 bg-card/60 p-2.5 flex items-center gap-2.5 transition-all duration-150 relative overflow-hidden',
                        clickable && 'hover:bg-accent/70 hover:border-amber-500/40 hover:shadow-sm cursor-pointer active:scale-[0.99]'
                      )}
                    >
                      {/* Avatar */}
                      <div className="relative shrink-0">
                        <Avatar className="h-9 w-9 ring-1.5 ring-amber-500/30 rounded-full">
                          {person.avatar && (
                            <AvatarImage src={person.avatar} alt={person.name} className="object-cover" />
                          )}
                          <AvatarFallback className="bg-gradient-to-br from-amber-500/20 to-emerald-500/20 text-amber-700 dark:text-amber-200 font-bold text-xs">
                            {getInitials(person.name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-popover" />
                      </div>

                      {/* Person Details */}
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-xs text-foreground truncate group-hover/person:text-amber-600 dark:group-hover/person:text-amber-300 transition-colors">
                            {person.name}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                          {person.epf && (
                            <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.2 font-mono font-medium text-foreground">
                              EPF: {person.epf}
                            </span>
                          )}
                          {person.department && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-brand/10 text-brand px-1.5 py-0.2 font-medium">
                              <Building2 className="h-2.5 w-2.5" />
                              {person.department}
                            </span>
                          )}
                          {person.designation && !person.department && (
                            <span className="truncate text-muted-foreground">
                              · {person.designation}
                            </span>
                          )}
                        </div>

                        {/* Check-in / Out Time and Place */}
                        {(person.checkIn || person.place) && (
                          <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[10px]">
                            {person.checkIn && (
                              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                                <Clock className="h-2.5 w-2.5" />
                                {person.checkIn}
                                {person.checkOut ? ` - ${person.checkOut}` : ''}
                              </span>
                            )}
                            {person.place && (
                              <span className="inline-flex items-center gap-1 text-muted-foreground truncate max-w-[120px]" title={person.place}>
                                <MapPin className="h-2.5 w-2.5 shrink-0" />
                                {person.place}
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Action Chevron */}
                      {clickable && (
                        <div className="shrink-0 text-muted-foreground group-hover/person:text-amber-500 group-hover/person:translate-x-0.5 transition-all">
                          <ChevronRight className="h-4 w-4" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="py-2.5 px-3 rounded-xl border border-dashed border-border/60 bg-muted/20 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
                <span className="animate-spin text-xs">⏳</span>
                <span>Loading staff details...</span>
              </div>
            )}
          </div>
        )}

        {/* Footer info */}
        {hasPresentStaff && Boolean(onSelectPerson) && (
          <div className="relative pt-1 border-t border-border/50 flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="italic flex items-center gap-1 text-[10px]">
              <Sparkles className="h-3 w-3 text-amber-500 shrink-0" />
              Holiday Attendance
            </span>
            <span className="text-[10px] text-muted-foreground/80">
              {t.ovViewPersonDossier}
            </span>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
