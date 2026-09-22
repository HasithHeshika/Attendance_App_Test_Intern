'use client';

import React, { useState, useRef } from 'react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Cake, PartyPopper, ChevronRight, Gift, Sparkles, Building2 } from 'lucide-react';
import { format } from 'date-fns';
import { useT } from '@/store/appStore';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

export interface BirthdayPersonInfo {
  name: string;
  epf: string;
  department?: string;
  designation?: string;
  avatar?: string;
  company?: string;
  email?: string;
  dob?: string;
}

export interface BirthdayTooltipChipProps {
  date: string; // yyyy-MM-dd
  names: string[];
  people?: BirthdayPersonInfo[];
  birthdayLabel?: string;
  onSelectPerson?: (epf: string) => void;
  className?: string;
}

export default function BirthdayTooltipChip({
  date,
  names,
  people = [],
  birthdayLabel,
  onSelectPerson,
  className,
}: BirthdayTooltipChipProps) {
  const t = useT();
  const [isOpen, setIsOpen] = useState(false);
  const closeTimerRef = useRef<NodeJS.Timeout | null>(null);

  const primaryName = names[0] ?? (people[0]?.name || 'Birthday');
  const extraCount = Math.max(0, names.length - 1);

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
    formattedDate = format(new Date(`${date}T00:00:00`), 'd MMMM');
  } catch {
    // fallback
  }

  // Combine names with people info so every person in `names` gets a structured card
  const displayPeople: BirthdayPersonInfo[] = names.map((name, idx) => {
    const matched = people.find(p => p.name.toLowerCase() === name.toLowerCase() || p.epf === name)
      ?? people[idx];
    if (matched) {
      return {
        ...matched,
        name: matched.name || name,
      };
    }
    return {
      name,
      epf: '',
    };
  });

  const handlePersonClick = (epf?: string) => {
    if (epf && onSelectPerson) {
      onSelectPerson(epf);
      setIsOpen(false);
    }
  };

  const getInitials = (n: string) => {
    const parts = n.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  };

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
          aria-label={`${birthdayLabel ?? t.birthdayLabel}: ${names.join(', ')}`}
          className={cn(
            'group flex h-8 items-center gap-2 rounded-full border border-pink-500/30 bg-pink-500/10 hover:bg-pink-500/20 px-3.5 text-xs text-pink-700 dark:text-pink-300 shrink-0 max-w-[20rem] sm:max-w-[26rem] lg:max-w-[32rem] transition-all duration-200 cursor-pointer shadow-sm hover:shadow-pink-500/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-pink-500/40',
            isOpen && 'ring-2 ring-pink-500/40 bg-pink-500/20 border-pink-500/50 shadow-md shadow-pink-500/10',
            className
          )}
        >
          <span aria-hidden className="shrink-0 text-xs transition-transform duration-200 group-hover:scale-125">
            🎂
          </span>
          <span className="shrink-0 font-semibold text-pink-600 dark:text-pink-400">{birthdayLabel ?? t.birthdayLabel}:</span>
          <span className="truncate font-medium text-foreground dark:text-pink-200">{primaryName}</span>
          {extraCount > 0 && (
            <span className="shrink-0 h-5 px-1.5 rounded-full bg-pink-500/25 border border-pink-500/40 text-pink-700 dark:text-pink-200 text-[10px] font-bold flex items-center justify-center tabular-nums">
              +{extraCount}
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
        className="z-[140] w-84 sm:w-96 rounded-2xl border border-pink-500/30 dark:border-pink-500/25 bg-popover/95 backdrop-blur-2xl p-4 text-popover-foreground shadow-2xl outline-none space-y-3.5 overflow-hidden relative animate-in fade-in-0 zoom-in-95 duration-200"
      >
        {/* Celebratory ambient gradient glow */}
        <div className="absolute top-0 inset-x-0 h-20 bg-gradient-to-b from-pink-500/20 via-purple-500/10 to-transparent pointer-events-none rounded-t-2xl" />

        {/* Header row */}
        <div className="relative flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-xl bg-gradient-to-tr from-pink-500 to-rose-400 flex items-center justify-center text-white text-base shadow-md shadow-pink-500/25 ring-1 ring-pink-500/30 shrink-0">
              🎂
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h4 className="text-sm font-bold text-foreground tracking-tight">
                  {t.ovBirthdayCelebrations}
                </h4>
                {displayPeople.length > 1 && (
                  <span className="rounded-full bg-pink-500/20 text-pink-700 dark:text-pink-300 px-1.5 py-0.2 text-[10px] font-extrabold tabular-nums">
                    {displayPeople.length}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t.ovWishHappyBirthday}
              </p>
            </div>
          </div>

          <span className="text-[11px] font-semibold text-pink-600 dark:text-pink-400 bg-pink-500/15 border border-pink-500/30 px-2 py-0.5 rounded-full shrink-0">
            {formattedDate}
          </span>
        </div>

        {/* List of birthday celebrants */}
        <div className="relative space-y-2 max-h-64 overflow-y-auto pr-0.5">
          {displayPeople.map((person, idx) => {
            const hasEpf = Boolean(person.epf);
            const clickable = hasEpf && Boolean(onSelectPerson);

            return (
              <div
                key={person.epf || `${person.name}-${idx}`}
                onClick={() => clickable && handlePersonClick(person.epf)}
                className={cn(
                  'group/person rounded-xl border border-border/70 bg-card/60 p-2.5 flex items-center gap-3 transition-all duration-150 relative overflow-hidden',
                  clickable && 'hover:bg-accent/60 hover:border-pink-500/40 hover:shadow-sm cursor-pointer active:scale-[0.99]'
                )}
              >
                {/* Person Avatar with celebratory status badge */}
                <div className="relative shrink-0">
                  <Avatar className="h-10 w-10 ring-2 ring-pink-400/40 rounded-full">
                    {person.avatar && (
                      <AvatarImage src={person.avatar} alt={person.name} className="object-cover" />
                    )}
                    <AvatarFallback className="bg-gradient-to-br from-pink-500/20 to-purple-500/20 text-pink-700 dark:text-pink-200 font-bold text-xs">
                      {getInitials(person.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="absolute -bottom-1 -right-1 text-xs select-none">
                    🎉
                  </span>
                </div>

                {/* Person details */}
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-sm text-foreground truncate group-hover/person:text-pink-600 dark:group-hover/person:text-pink-300 transition-colors">
                      {person.name}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    {person.epf && (
                      <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.2 font-mono font-medium text-foreground text-[10px]">
                        EPF: {person.epf}
                      </span>
                    )}
                    {person.department && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-brand/10 text-brand px-1.5 py-0.2 text-[10px] font-medium">
                        <Building2 className="h-2.5 w-2.5" />
                        {person.department}
                      </span>
                    )}
                    {person.designation && (
                      <span className="truncate text-muted-foreground text-[10px]">
                        · {person.designation}
                      </span>
                    )}
                  </div>
                </div>

                {/* Action arrow if clickable */}
                {clickable && (
                  <div className="shrink-0 text-muted-foreground group-hover/person:text-pink-500 group-hover/person:translate-x-0.5 transition-all">
                    <ChevronRight className="h-4 w-4" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer info */}
        <div className="relative pt-1 border-t border-border/50 flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="italic flex items-center gap-1">
            <Sparkles className="h-3 w-3 text-pink-500 shrink-0" />
            {t.ovWishHappyBirthday}
          </span>
          {Boolean(onSelectPerson) && (
            <span className="text-[10px] text-muted-foreground/80">
              {t.ovViewPersonDossier}
            </span>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
