'use client';
import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarRange, Clock, Loader2, RefreshCw, CalendarOff } from 'lucide-react';
import { DayPicker, type DayContentProps } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import toast from 'react-hot-toast';
import { tenant } from '@/lib/firebase';
import { localDateString } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import {
  getScheduleAssignmentsForEmployee,
  subscribeScheduleAssignmentsForEmployee,
} from '@/services/scheduleAssignmentService';
import type { ScheduleAssignment } from '@/lib/types';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { PageHeaderSkeleton, ListSkeleton } from '@/components/ui/Skeleton';
import { PageTransition, Reveal } from '@/components/ui/motion';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';

// Per-tenant module flag (TenantFeatures.mySchedule in src/lib/tenants.ts) — the
// shift-schedule system this reads from (schedule_assignments) only exists where the
// Schedule module is on, same gate as ../schedule/page.tsx. The app shell blocks the route
// on the same flag; this keeps the page honest on its own.

const LOOKAHEAD_DAYS = 30; // how far ahead the "Next shift" strip looks

function timeRange(start: string, end: string): string {
  if (!start && !end) return '—';
  return `${start || '—'} – ${end || '—'}`;
}

// "yyyy-mm-dd" → a local-midnight Date, built from numeric parts (not `new Date(str)`) so it
// can't drift a day from a UTC-vs-local mismatch — this is a calendar date, not an instant.
function parseDateInput(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

// Day cell content: just the date number — modifiersStyles below draw the colored circle
// (scheduled = green, same palette as the Attendance page's calendar) so this calendar reads
// as the same visual language, not a new one.
function ScheduleDayContent(props: DayContentProps) {
  return <span>{props.date.getDate()}</span>;
}

// Employee self-service read of "when am I working" — reads directly from
// scheduleAssignmentService (shifts assigned on the admin Schedule page; a date may carry more
// than one), no roster/weekday-recurrence/publish layer to reconcile. Read-only: no editing
// happens here. A month calendar (same react-day-picker already used on the Attendance page)
// rather than a date-range list, since "am I working the 15th" is a calendar question.
export default function MySchedulePage() {
  const router = useRouter();
  const me = useAuthStore((s) => s.user);
  const allowed = tenant.features.mySchedule;

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [assignments, setAssignments] = useState<ScheduleAssignment[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed) router.replace('/dashboard');
  }, [allowed, router]);

  const load = async () => {
    if (!me?.epf_number) return;
    setRefreshing(true);
    try {
      setAssignments(await getScheduleAssignmentsForEmployee(me.epf_number));
    } catch (e) {
      console.error(e);
      toast.error('Failed to load your schedule');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // The manual Refresh button. Unlike the initial load, this forces a server round-trip
  // (the live listener otherwise keeps a plain fetch answering from cache instantly, which
  // made the button look dead) and holds the spinner briefly so the feedback is visible
  // even when the fetch returns immediately.
  const handleRefresh = async () => {
    if (!me?.epf_number || refreshing) return;
    setRefreshing(true);
    try {
      const [rows] = await Promise.all([
        getScheduleAssignmentsForEmployee(me.epf_number, { server: true }),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
      setAssignments(rows);
      toast.success('Schedule up to date');
    } catch (e) {
      console.error(e);
      toast.error('Failed to refresh your schedule');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!allowed || !me?.epf_number) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, me?.epf_number]);

  // Real-time — an Admin/HOD creating, updating or removing one of this employee's shift
  // assignments (Schedule page) re-renders this calendar instantly, with no manual refresh
  // (see subscribeScheduleAssignmentsForEmployee in scheduleAssignmentService.ts). Fires once
  // immediately with current data — a harmless redundant overlap with load() above — then
  // again on every relevant write. The manual Refresh button above still works as a one-shot
  // fetch for reassurance; it's no longer the only way this page stays current.
  useEffect(() => {
    const epf = me?.epf_number;
    if (!allowed || !epf) return;
    const unsub = subscribeScheduleAssignmentsForEmployee(epf, (rows) => {
      setAssignments(rows);
      setLoading(false);
    });
    return () => unsub();
  }, [allowed, me?.epf_number]);

  // A date may carry more than one shift — grouped, not a single value per date.
  const byDate = useMemo(() => {
    const m = new Map<string, ScheduleAssignment[]>();
    for (const a of assignments) {
      const list = m.get(a.date) ?? [];
      list.push(a);
      m.set(a.date, list);
    }
    for (const list of m.values()) list.sort((a, b) => (a.start_time || '99:99').localeCompare(b.start_time || '99:99'));
    return m;
  }, [assignments]);

  const todayStr = localDateString();
  const lookaheadTo = localDateString(new Date(Date.now() + LOOKAHEAD_DAYS * 86400000));
  // The nearest upcoming date with anything scheduled, and every shift on it.
  const nextShiftDay = useMemo(() => {
    const dates = [...byDate.keys()].filter((d) => d >= todayStr && d <= lookaheadTo).sort();
    const date = dates[0];
    return date ? { date, shifts: byDate.get(date)! } : null;
  }, [byDate, todayStr, lookaheadTo]);

  const scheduledDates = useMemo(
    () => [...byDate.keys()].map((d) => parseDateInput(d)).filter((d): d is Date => !!d),
    [byDate],
  );

  const selectedShifts = selectedDate ? byDate.get(selectedDate) ?? [] : [];

  if (!allowed) return null;
  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <ListSkeleton rows={6} />
      </div>
    );
  }

  return (
    <PageTransition className="space-y-6">
      <PageHeader
        title="My Schedule"
        description="Your upcoming shifts, at a glance."
        icon={CalendarRange}
        actions={
          <Button variant="outline" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Refresh
          </Button>
        }
      />

      {/* "What's next" — a calendar answers "am I working the 15th"; this answers the usually
          more immediate question of "what's my very next shift" without hunting for it. */}
      <Reveal>
        <Card className="p-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/15 border border-primary/20 flex items-center justify-center flex-shrink-0">
            <Clock className="w-4 h-4 text-primary" />
          </div>
          {nextShiftDay ? (
            <div className="min-w-0 flex-1">
              <div className="text-xs text-muted-foreground">Next shift</div>
              <div className="text-sm font-semibold text-foreground truncate">
                {parseDateInput(nextShiftDay.date)?.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                {' — '}
                {nextShiftDay.shifts.map((s) => s.shift_name).join(', ')}
                {' '}
                <span className="font-normal text-muted-foreground">
                  ({nextShiftDay.shifts.map((s) => timeRange(s.start_time, s.end_time)).join(', ')})
                </span>
              </div>
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <div className="text-xs text-muted-foreground">Next shift</div>
              <div className="text-sm text-muted-foreground">Nothing scheduled in the next {LOOKAHEAD_DAYS} days</div>
            </div>
          )}
        </Card>
      </Reveal>

      <Reveal delay={0.05}>
        <Card className="p-4">
          <DayPicker
            mode="single"
            weekStartsOn={1}
            month={calendarMonth}
            onMonthChange={setCalendarMonth}
            onDayClick={(day) => setSelectedDate(localDateString(day))}
            components={{ DayContent: ScheduleDayContent }}
            modifiers={{ scheduled: scheduledDates, sunday: { dayOfWeek: [0] } }}
            modifiersStyles={{
              scheduled: {
                backgroundColor: 'rgba(52,211,153,0.25)',
                borderRadius: '50%',
                color: '#34d399',
                fontWeight: '600',
              },
              sunday: { color: '#ef4444' },
            }}
            className="w-full"
          />
          {refreshing && (
            <div className="flex items-center justify-center gap-2 py-2 text-[11px] text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading…
            </div>
          )}
          {/* Legend */}
          <div className="mt-3 pt-3 border-t border-border flex flex-wrap gap-x-4 gap-y-1.5">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full flex-shrink-0" style={{ background: 'rgba(52,211,153,0.25)', border: '1.5px solid #34d399' }} />
              <span className="text-[11px] text-muted-foreground">Scheduled</span>
            </div>
          </div>
        </Card>
      </Reveal>

      <Dialog open={!!selectedDate} onOpenChange={(open) => !open && setSelectedDate(null)}>
        <DialogContent className="max-w-sm">
          {selectedDate && (() => {
            const dateObj = parseDateInput(selectedDate);
            return (
              <>
                <DialogHeader>
                  <DialogTitle>
                    {dateObj?.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }) ?? selectedDate}
                  </DialogTitle>
                  <DialogDescription className="sr-only">Your shift on this date</DialogDescription>
                </DialogHeader>
                {selectedShifts.length === 0 ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                    <CalendarOff className="w-4 h-4 flex-shrink-0" />
                    Nothing scheduled for you on this date.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {selectedShifts.map((s) => (
                      <div key={s.id} className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <Clock className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                          <span className="text-sm font-semibold text-foreground">{s.shift_name}</span>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {timeRange(s.start_time, s.end_time)}
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {s.department_name}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
