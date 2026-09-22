'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronRight, X, Users } from 'lucide-react';
import { useT } from '@/store/appStore';
import { DayPerson, SessionView } from '@/lib/overviewData';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { dayHours, dayIssues } from './dayMetrics';
import { IssueChips } from './PersonDossier';

type DayTab = 'all' | 'present' | 'missing' | 'leave' | 'unscheduled';
type SortKey = 'name' | 'hours' | 'status';

// Present first, then leave, then missing, then unscheduled last — the order the panel has
// always listed people in, and the one the status sort restores. 'unscheduled' (Southern Lanka
// only — nobody assigned them a shift that day) sorts after 'missing' so it never gets mistaken
// for a worse outcome than an actual absence.
const STATUS_ORDER: Record<DayPerson['status'], number> = { present: 0, leave: 1, missing: 2, unscheduled: 3 };

// One lookup per status instead of nested ternaries at each call site — clearer once there are
// four states, and it's what actually stops 'unscheduled' from inheriting the destructive/red
// styling every "else" branch used to fall into before this state existed.
const STATUS_STYLES: Record<DayPerson['status'], {
  dot: string; rowBg: string; rowBgFocused: string;
  badgeVariant: 'success' | 'brand' | 'destructive' | 'muted';
}> = {
  present:     { dot: 'bg-success',          rowBg: 'bg-success/5 hover:bg-success/10',         rowBgFocused: 'bg-success/20 ring-1 ring-success/50', badgeVariant: 'success' },
  leave:       { dot: 'bg-brand',             rowBg: 'bg-brand/5 hover:bg-brand/10',             rowBgFocused: 'bg-brand/5 hover:bg-brand/10',         badgeVariant: 'brand' },
  missing:     { dot: 'bg-destructive',      rowBg: 'bg-destructive/5 hover:bg-destructive/10', rowBgFocused: 'bg-destructive/5 hover:bg-destructive/10', badgeVariant: 'destructive' },
  unscheduled: { dot: 'bg-muted-foreground', rowBg: 'bg-muted/40 hover:bg-muted/60',            rowBgFocused: 'bg-muted/40 hover:bg-muted/60',        badgeVariant: 'muted' },
};

// ── Session timeline row ────────────────────────────────────────────────────
function SessionTimeline({ sessions, t }: {
  sessions: SessionView[];
  t: ReturnType<typeof useT>;
}) {
  const locatedSessions = sessions.filter(s => s.lat != null && s.lng != null);
  if (locatedSessions.length === 0) {
    return (
      <p className="text-[10px] text-muted-foreground italic mt-1">{t.ovNoLocation}</p>
    );
  }
  return (
    <div className="mt-1 space-y-1">
      {locatedSessions.length > 0 && (
        <span className="text-[10px] text-muted-foreground">{locatedSessions.length} {t.ovSessions}</span>
      )}
      {locatedSessions.map((s, i) => (
        <div key={s.checkIn ?? i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
          <span className="font-medium text-foreground/80">
            <span title={t.ovCheckedIn}>{s.checkIn ?? '–'}</span>
            {' → '}
            {s.checkOut
              ? <span title={t.ovCheckedOut}>{s.checkOut}</span>
              : <span className="text-warning">{t.ovStillIn}</span>}
          </span>
          {s.place && (
            <span className="truncate max-w-[120px]">{s.place}</span>
          )}
          {s.outOfRadius === true && (
            <Badge variant="destructive" className="text-[9px] px-1 py-0 leading-tight h-auto">
              {t.ovOutsideRadius}
            </Badge>
          )}
          {s.outstation && (
            <Badge variant="brand" className="text-[9px] px-1 py-0 leading-tight h-auto">
              {t.ovOutstation}
            </Badge>
          )}
        </div>
      ))}
    </div>
  );
}

// The three ways this list can come up empty, which are three different facts and only two of
// them have a way out. Kept as one component so the shapes cannot drift apart.
function PanelEmpty({ title, hint, action }: {
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <Users className="h-6 w-6 text-muted-foreground opacity-20" aria-hidden />
      <span className="text-sm font-medium text-foreground">{title}</span>
      {hint && <span className="max-w-[22rem] text-xs text-muted-foreground">{hint}</span>}
      {action && (
        <Button variant="outline" size="sm" className="mt-1 gap-1" onClick={action.onClick}>
          <X className="h-3.5 w-3.5" aria-hidden />{action.label}
        </Button>
      )}
    </div>
  );
}

// ── PeoplePanel ─────────────────────────────────────────────────────────────
export default function PeoplePanel({
  people,
  focusedEpf,
  onFocus,
  onOpen,
  scopeLabel = null,
  onClearScope,
}: {
  people: DayPerson[];
  focusedEpf: string | null;
  onFocus: (epf: string | null) => void;
  /** Open the full dossier for this person. */
  onOpen: (person: DayPerson) => void;
  /** A page-level filter (the department select) has already narrowed `people` before it got
   *  here. The panel cannot see that filter, so an empty list caused by it would read as
   *  "nobody works here" — naming it is what keeps those two facts apart. */
  scopeLabel?: string | null;
  /** Clears that page-level filter, so the panel's one Clear can clear everything. */
  onClearScope?: () => void;
}) {
  const t = useT();

  const [dayTab, setDayTab]       = useState<DayTab>('all');
  const [sort, setSort]           = useState<SortKey>('status');
  const [search, setSearch]       = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // Hours and issues are derived once per person per day payload, not per render of a row —
  // dayIssues walks every session, and this list can hold 300+ people.
  const rows = useMemo(() => people.map(p => ({
    person: p,
    hours: p.status === 'present' ? dayHours(p.sessions) : 0,
    issues: dayIssues(p),
  })), [people]);

  // Search first, THEN the tab, and the tab counts are taken off the searched set. They used
  // to be counted over everybody while the search was still narrowing the list, so a tab
  // reading "12" could open onto a single row. Each count now says exactly how many rows
  // clicking that tab would produce.
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      r.person.name.toLowerCase().includes(q) || r.person.epf.toLowerCase().includes(q));
  }, [rows, search]);

  const tabCounts = useMemo(() => ({
    all:         searched.length,
    present:     searched.filter(r => r.person.status === 'present').length,
    missing:     searched.filter(r => r.person.status === 'missing').length,
    leave:       searched.filter(r => r.person.status === 'leave').length,
    unscheduled: searched.filter(r => r.person.status === 'unscheduled').length,
  }), [searched]);

  const filteredList = useMemo(() => {
    const list = dayTab === 'all' ? searched : searched.filter(r => r.person.status === dayTab);
    const byName = (a: typeof list[number], b: typeof list[number]) => a.person.name.localeCompare(b.person.name);
    return [...list].sort((a, b) => {
      if (sort === 'name') return byName(a, b);
      if (sort === 'hours') return b.hours - a.hours || byName(a, b);
      return STATUS_ORDER[a.person.status] - STATUS_ORDER[b.person.status] || byName(a, b);
    });
  }, [searched, dayTab, sort]);

  const tabLabel: Record<DayTab, string> = {
    all: t.allWord, present: t.presentCap, missing: t.missingCap, leave: t.leaveCap,
    unscheduled: t.unscheduledCap,
  };
  // Whether the "No Shift" tab even applies today — off the full `people` list (not the
  // search-narrowed `searched`), so it never flickers in/out while someone types, and it's
  // simply never true at all for a tenant that doesn't run on shift assignments.
  const hasUnscheduled = useMemo(() => people.some(p => p.status === 'unscheduled'), [people]);
  // The tab itself only renders while hasUnscheduled is true (below) — if the day changes out
  // from under an open "No Shift" tab (a switching admin picks a different date), fall back to
  // All rather than leave the list silently filtered on a tab nobody can see or click any more.
  useEffect(() => { if (dayTab === 'unscheduled' && !hasUnscheduled) setDayTab('all'); }, [dayTab, hasUnscheduled]);

  // Explicitly typed (rather than `as const`) so `key` stays a real `DayTab` even with the
  // "No Shift" entry conditionally spread in — an `as const` array literal loses that literal
  // narrowing the moment a runtime-conditional spread is mixed into it.
  const tabConfigs: { key: DayTab; label: string; count: number; dot: string }[] = [
    { key: 'all',     label: t.allWord,    count: tabCounts.all,     dot: 'bg-muted-foreground' },
    { key: 'present', label: t.presentCap, count: tabCounts.present, dot: STATUS_STYLES.present.dot },
    { key: 'missing', label: t.missingCap, count: tabCounts.missing, dot: STATUS_STYLES.missing.dot },
    { key: 'leave',   label: t.leaveCap,   count: tabCounts.leave,   dot: STATUS_STYLES.leave.dot },
    // Southern Lanka only — see hasUnscheduled above. Absent entirely for every tenant that
    // doesn't run on shift assignments, rather than a permanently-zero dropdown option.
    ...(hasUnscheduled ? [{ key: 'unscheduled' as const, label: t.unscheduledCap, count: tabCounts.unscheduled, dot: STATUS_STYLES.unscheduled.dot }] : []),
  ];
  const query = search.trim();
  const innerActive = dayTab !== 'all' || query !== '';
  const anyActive = innerActive || !!scopeLabel;

  // One action clears everything that is narrowing the list, including the filter the page
  // owns. A "clear" that left one of three filters on would be the worst of the three.
  const clearAll = () => { setDayTab('all'); setSearch(''); onClearScope?.(); };

  return (
    // No fixed height and no inner scrollbar. This panel used to live in a
    // h-[min(70vh,640px)] card and scroll inside it, which meant a scrollbar inside a
    // scrollbar: dead space under the list on a tall screen, and on a phone the inner
    // scroller swallowed the page's own scroll. The page scrolls now; the controls below
    // stay pinned so the tabs and the search box are always reachable.
    <div className="flex flex-col gap-2">

      {/* ── Status filter + search: pinned, because a list this long is unusable if its
             filters scroll away from it. ── */}
      <div className="sticky top-0 z-10 -mx-1 space-y-2 bg-card px-1 pb-2 pt-1">
      {/* ── Search ── Always visible, never behind a toggle. The status dropdown sits right
          beside it — this page is how someone finds ONE person out of 112, or narrows to
          exactly the group (Present/Missing/Leave/No Shift) they're checking on, and neither
          control should be a separate discovery step from the other. */}
      <div className="flex-shrink-0 space-y-1.5">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none z-10" />
          <Input
            ref={searchRef}
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t.searchNameEpf}
            className="pl-9 pr-9"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label={t.closeWord}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors z-10"
            >
              <span className="text-xs font-bold">✕</span>
            </button>
          )}
          </div>
          <Select value={dayTab} onValueChange={v => setDayTab(v as DayTab)}>
            <SelectTrigger className="w-[9.5rem] h-9 flex-shrink-0 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tabConfigs.map(tab => (
                <SelectItem key={tab.key} value={tab.key}>
                  <span className="flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${tab.dot}`} />
                    {tab.label} ({tab.count})
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2.5 text-[11px]">
          {/* Sort. Underline rather than colour — --success/--primary/--brand are the same
              azure, so a tinted "selected" chip here would read as a status. */}
          {([
            { key: 'status', label: t.statusLabel },
            { key: 'name',   label: t.nameWord },
            // en fallback — TRANSLATIONS has no bare "Hours" noun (hShort is the unit "h")
            { key: 'hours',  label: 'Hours' },
          ] as const).map(s => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSort(s.key)}
              aria-pressed={sort === s.key}
              className={cn(
                'transition-colors',
                sort === s.key
                  ? 'font-semibold text-foreground underline decoration-2 underline-offset-4'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {s.label}
            </button>
          ))}
          {/* Language-neutral on purpose: a count plus the chevron on every row carries the
              "this opens something" affordance without a hardcoded English sentence. Every
              user-facing string in this app needs en + si + ta (see CLAUDE.md) and a prose
              hint here would have been English-only. It reads "12 of 112" while something is
              narrowing, because a bare "12" is the same shape as a company with twelve people
              in it. */}
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground">
            {anyActive
              ? (t.ovsShownOf ?? 'Showing {shown} of {total}').replace('{shown}', String(filteredList.length)).replace('{total}', String(people.length))
              : filteredList.length}
            <ChevronRight className="h-3 w-3 opacity-60" aria-hidden />
          </span>
        </div>
      </div>

      {/* ── What is currently narrowing this list ──
          Every filter on screen, spelled out, and one button that clears all of them — the
          department the page owns included. The row exists only while something is on, so its
          presence is the signal; a filtered short list must never be mistakable for a short
          company. Dashed outline rather than a tint, because the three semantic colours here
          are one azure and a coloured bar would read as a status about the people. */}
      {anyActive && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-dashed border-border bg-muted/40 px-2 py-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t.ovsFiltered}
          </span>
          {scopeLabel && <Badge variant="outline" className="py-0 text-[10px] font-semibold">{scopeLabel}</Badge>}
          {dayTab !== 'all' && <Badge variant="outline" className="py-0 text-[10px] font-semibold">{tabLabel[dayTab]}</Badge>}
          {query && <Badge variant="outline" className="max-w-[10rem] truncate py-0 text-[10px] font-semibold">{query}</Badge>}
          <Button variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-1.5 text-[10px]" onClick={clearAll}>
            <X className="h-3 w-3" aria-hidden />{t.ovsClearFilters}
          </Button>
        </div>
      )}

      </div>

      {/* ── List. Grows to its natural height; the page is the scroller. ── */}
      <div className="space-y-1">
        {filteredList.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
            <Search className="w-6 h-6 opacity-20" />
            <span className="text-sm">{search ? t.noMatchingEmployees : t.noData}</span>
          </div>
        ) : filteredList.map(({ person, hours, issues }) => {
          const isPresent  = person.status === 'present';
          const isFocused  = focusedEpf === person.epf;
          const hasLocated = isPresent && person.sessions.some(s => s.lat != null && s.lng != null);

          const rowBase = `w-full text-left px-3 py-2.5 rounded-md transition-colors cursor-pointer ${
            isFocused ? STATUS_STYLES[person.status].rowBgFocused : STATUS_STYLES[person.status].rowBg
          }`;

          // Hover/focus still drives the map pin (that is what it always did); the CLICK now
          // opens the dossier, which is the only action the row didn't have.
          const focusProps = hasLocated ? {
            onMouseEnter: () => onFocus(person.epf),
            onMouseLeave: () => onFocus(null),
            onFocus:      () => onFocus(person.epf),
            onBlur:       () => onFocus(null),
          } : {};

          return (
            <button
              key={person.epf}
              type="button"
              onClick={() => onOpen(person)}
              title={hasLocated ? t.ovFocusOnMap : undefined}
              className={rowBase}
              {...focusProps}
            >
              {/* Header row */}
              <div className="flex items-center gap-3">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_STYLES[person.status].dot}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-foreground font-medium truncate">{person.name}</div>
                  <div className="text-[10px] text-muted-foreground">{person.epf}</div>
                </div>
                {isPresent && hours > 0 && (
                  <span className="flex-shrink-0 text-xs font-semibold tabular-nums text-foreground">
                    {hours}{t.hShort}
                  </span>
                )}
                <Badge
                  variant={STATUS_STYLES[person.status].badgeVariant}
                  className="flex-shrink-0 font-semibold"
                >
                  {person.status === 'present'
                    ? `✓ ${t.presentCap}`
                    : person.status === 'leave'
                      ? t.leaveCap
                      : person.status === 'unscheduled'
                        ? t.unscheduledCap
                        : `✗ ${t.missingCap}`}
                </Badge>
                <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden />
              </div>

              {issues.length > 0 && <div className="mt-1.5"><IssueChips issues={issues} t={t} /></div>}

              {/* Session timeline (present only) */}
              {isPresent && (
                hasLocated
                  ? <SessionTimeline sessions={person.sessions} t={t} />
                  : <p className="text-[10px] text-muted-foreground italic mt-1">{t.ovNoLocation}</p>
              )}
            </button>
          );
        })}
      </div>

    </div>
  );
}
