'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Cake, CalendarDays, Loader2, Medal, PartyPopper } from 'lucide-react';
import toast from 'react-hot-toast';
import { useT } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn, localDateString } from '@/lib/utils';
import { formatSnapshotMoment } from '@/components/settings/SettingsBackupSettings';
import { getAllUsers } from '@/services/userService';
import { Button } from '@/components/ui/button';
import { getCompanies } from '@/services/companyService';
import { getDepartments } from '@/services/departmentService';
import { getGreetingSettings, saveGreetingSettings } from '@/services/greetingsSettingsService';
import {
  DEFAULT_GREETING_SETTINGS, anniversaryYears, canonName, isActiveOn, modeOf, monthDayMatches,
  resolveSpecialDayDate, specialDaysOn,
  type GreetingSettings, type HolidayCalendar, type SpecialDay,
} from '@/lib/greetings';
import { getHolidaySettings, fetchPublicHolidays } from '@/services/holidayService';
import SpecialDayDialog from '@/components/system-settings/greetings/SpecialDayDialog';
import SignerLists from '@/components/system-settings/greetings/SignerLists';
import SpecialDaysBlock from '@/components/system-settings/greetings/SpecialDaysBlock';
import TestGreeting from '@/components/system-settings/greetings/TestGreeting';
import { BlockHeader, Dependent, SwitchButton } from '@/components/system-settings/greetings/parts';
import {
  buildHolidayOptions, formatDayMonth, holidayCalendarOf, type HolidayOption,
} from '@/components/system-settings/greetings/holidayOptions';
import type { AppUser, Company } from '@/lib/types';

// The greetings screen, in the order an admin answers its questions: is it on and what is it
// sending, who signs, which special days, and only then "send me one so I can see it".
//
// Each of those is a block with its own header, ruled off from the next — the same four rules
// the page draws between Suspense's three settings. Everything saves immediately through the
// admin route (optimistic, reverted on failure), which is why there is no Save button: the
// section is one row per thing on a settings page that is already too tall.

// Every date on this screen is a Colombo date, because the job that acts on them is
// (colomboToday in greetingsServer). An admin travelling — or a browser left on another
// timezone — must not be shown a different "today" from the one the 8:00 run will use.
function thisYear(): string { return localDateString().slice(0, 4); }

function colomboHour(): number {
  return Number(new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Colombo', hour: '2-digit', hour12: false,
  }));
}

/** The date the 8:00 job will next run on — today while it is still before 8, else tomorrow. */
function nextRunDate(): string {
  const now = new Date();
  if (colomboHour() < 8) return localDateString(now);
  return localDateString(new Date(now.getTime() + 24 * 60 * 60 * 1000));
}

export default function GreetingsSettings() {
  const t = useT();
  const myEpf = useAuthStore(s => s.user?.epf_number ?? '');
  const [settings, setSettings] = useState<GreetingSettings>(DEFAULT_GREETING_SETTINGS);
  const [loading, setLoading] = useState(true);
  // A failed load used to leave `settings` sitting on DEFAULT_GREETING_SETTINGS with the panel
  // fully editable — and because the PUT route writes the whole document, the very first toggle
  // .set() the DEFAULTS over the tenant's real configuration. Losing every special day and
  // signer list because one read timed out is not an acceptable failure mode, so a failed load
  // now refuses to render the form at all.
  const [loadFailed, setLoadFailed] = useState(false);
  // Which control started the write in flight, so one slow save spins on its own row instead
  // of freezing every control on the screen.
  const [pending, setPending] = useState<string | null>(null);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [usersFailed, setUsersFailed] = useState(false);
  const [companies, setCompanies] = useState<Company[]>([]);
  // Department docs exist on one tenant only; everywhere else the department names come from
  // the profiles themselves, so a failed read here is normal and must not break the section.
  const [deptDocs, setDeptDocs] = useState<Array<{ name: string; company_id: string }>>([]);
  // The special-day editor. `editing` null with the dialog open means "adding".
  const [dayOpen, setDayOpen] = useState(false);
  const [editing, setEditing] = useState<SpecialDay | null>(null);
  // This year's holidays with their dates and categories, for the picker; and the same list as
  // the engine's name → date map, for resolving. The org's own accepted list is authoritative;
  // the public feed only ever *offers* extra names and is allowed to fail (no API key, upstream
  // down) without breaking anything here.
  const [holidays, setHolidays] = useState<HolidayOption[]>([]);
  const [calendar, setCalendar] = useState<HolidayCalendar | null>(null);

  const loadSettings = async () => {
    setLoading(true);
    try {
      setSettings(await getGreetingSettings());
      setLoadFailed(false);
    } catch (e) {
      setLoadFailed(true);
      toast.error(e instanceof Error && e.message ? e.message : t.greetingsLoadFailed);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSettings();
    // A failed staff read is not fatal but it IS visible: the signer rows fall back to raw EPFs
    // and the test picker comes up empty, so the screen has to admit it is showing less than
    // the truth rather than looking merely unconfigured.
    getAllUsers().then(setUsers).catch(() => setUsersFailed(true));
    getCompanies().then(setCompanies).catch(() => { /* the scope list degrades to departments */ });
    getDepartments()
      .then(ds => setDeptDocs(ds.map(d => ({ name: d.name, company_id: d.company_id }))))
      .catch(() => { /* no departments collection on this tenant — profiles supply the names */ });
    (async () => {
      const year = Number(thisYear());
      const [own, feed] = await Promise.allSettled([getHolidaySettings(year), fetchPublicHolidays(year)]);
      // One merge, two shapes: the picker needs date and category, the engine needs name → date.
      // Deriving both from the same list is what keeps a pickable holiday resolvable.
      const options = buildHolidayOptions(
        feed.status === 'fulfilled' ? feed.value : [],
        own.status === 'fulfilled' ? own.value : { custom: [], types: {} },
      );
      setHolidays(options);
      setCalendar(holidayCalendarOf(thisYear(), options));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Writes can overlap now that the section no longer goes inert while one is in flight (moving
  // a signer twice quickly is the ordinary case). Every request carries the WHOLE document built
  // from the newest optimistic state, so last-write-wins is correct — but an earlier response
  // must not be allowed to land on top of a later one, hence the sequence guard.
  const seqRef = useRef(0);
  const persist = async (nextIn: GreetingSettings, key: string) => {
    const prev = settings;
    // Freeze this year's date onto every calendar-linked row we can resolve. The browser can
    // see the public holiday feed; the nightly job deliberately cannot depend on it, so the
    // resolution is persisted here and the name is kept for future years.
    const year = thisYear();
    const next: GreetingSettings = {
      ...nextIn,
      special_days: nextIn.special_days.map(d => {
        if (modeOf(d) !== 'calendar' || d.dates_by_year?.[year]) return d;
        const hit = resolveSpecialDayDate(d, year, calendar);
        return hit ? { ...d, dates_by_year: { ...(d.dates_by_year ?? {}), [year]: hit } } : d;
      }),
    };
    const seq = ++seqRef.current;
    setSettings(next);
    setPending(key);
    try {
      const saved = await saveGreetingSettings(next);
      if (seqRef.current === seq) setSettings(saved);
    } catch (e) {
      if (seqRef.current === seq) setSettings(prev);
      // Success is quiet — it is reported on the "last saved" line at the foot of the section,
      // because a toast per write meant flipping the master switch produced a stack of them.
      // A failure still shouts: the change on screen has just been taken back.
      toast.error(e instanceof Error && e.message ? e.message : t.greetingsSaveFailed);
    } finally {
      if (seqRef.current === seq) setPending(null);
    }
  };

  // The dialog hands back a whole day, valid, with its id already decided. Adding and editing
  // are the same write: replace the row of that id, or append it.
  const saveDay = (next: SpecialDay) => {
    const exists = settings.special_days.some(d => d.id === next.id);
    setDayOpen(false);
    void persist({
      ...settings,
      special_days: exists
        ? settings.special_days.map(d => (d.id === next.id ? next : d))
        : [...settings.special_days, next],
    }, `day-${next.id}`);
  };

  const openDay = (d: SpecialDay | null) => { setEditing(d); setDayOpen(true); };

  // Every department this tenant knows: the department docs where they exist, plus the
  // distinct department typed on a profile, de-duplicated case-insensitively.
  const departments = useMemo(() => {
    const byCanon = new Map<string, { name: string; companyId: string }>();
    for (const d of deptDocs) {
      const k = canonName(d.name);
      if (k && !byCanon.has(k)) byCanon.set(k, { name: d.name.trim(), companyId: d.company_id ?? '' });
    }
    for (const u of users) {
      const k = canonName(u.department);
      if (!k || byCanon.has(k)) continue;
      byCanon.set(k, { name: String(u.department).trim(), companyId: u.company_id ?? '' });
    }
    return [...byCanon.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [deptDocs, users]);

  // What the next 8:00 run will actually do. Every number here comes from data this block has
  // already loaded, and it is the question an admin opens this screen with — the old screen
  // made them read the whole form and work it out themselves.
  const run = nextRunDate();
  const due = useMemo(() => ({
    birthday: users.filter(u => isActiveOn(u, run) && monthDayMatches(u.date_of_birth, run)).length,
    anniversary: users.filter(u => isActiveOn(u, run) && anniversaryYears(u.date_of_join, run) !== null).length,
    special: specialDaysOn(settings.special_days, run, calendar).length,
  }), [users, settings.special_days, calendar, run]);

  const dueLine = (n: number) => (n > 0
    ? t.greetingsDueOnNextRun.replace('{n}', String(n)).replace('{date}', formatDayMonth(run))
    : undefined);

  const savedLine = (() => {
    const u = settings.updated_at as { _seconds?: number; seconds?: number } | undefined;
    const secs = u?._seconds ?? u?.seconds;
    if (!settings.updated_by_name || !secs) return null;
    return t.greetingsLastSaved
      .replace('{name}', settings.updated_by_name)
      .replace('{when}', formatSnapshotMoment(new Date(secs * 1000).toISOString()));
  })();

  if (loading) {
    // Shaped like what is coming, so the card does not jump from one line to a tall form.
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-3 w-full max-w-md" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <div className="grid gap-2 sm:grid-cols-3">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    );
  }

  // What the preview should be addressed to and signed by. Both come from real configuration:
  // an unnamed, unsigned preview is a preview of a message nobody ever receives.
  const previewName = users.find(u => u.epf_number === myEpf)?.display_name
    || users[0]?.display_name || '';
  const previewSenders = (settings.signers ?? []).map(epf => {
    const u = users.find(x => x.epf_number === epf);
    return {
      epf,
      name: u?.display_name || epf,
      role: u?.role ?? '',
      avatar_url: u?.avatar_url ?? null,
    };
  });

  // Refuse to render an editable form we could not populate — see `loadFailed` above.
  if (loadFailed) {
    return (
      <div className="flex flex-col items-start gap-3 py-6">
        <p className="text-sm text-muted-foreground">{t.greetingsLoadFailed}</p>
        <Button variant="outline" size="sm" onClick={() => void loadSettings()}>{t.tryAgain}</Button>
      </div>
    );
  }

  const on = t.greetingsDayOn;
  const off = t.greetingsDayOff;

  return (
    // The page gives every settings item p-5 inside one card and rules the items off from each
    // other (system-settings/page.tsx). Greetings is registered as ONE item, so it borrows the
    // same rules for its own four blocks instead of inventing a second visual language for
    // "these are different settings".
    <div className="-mx-5 -my-5 divide-y divide-border">
      <section className="space-y-4 p-5">
        <BlockHeader
          icon={PartyPopper}
          title={t.greetingsEnable}
          description={t.greetingsEnableHint}
          action={(
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {settings.enabled ? on : off}
              </span>
              <SwitchButton
                variant="bare"
                checked={settings.enabled}
                onChange={v => void persist({ ...settings, enabled: v }, 'enabled')}
                onWord={on}
                offWord={off}
                ariaLabel={t.greetingsEnable}
                busy={pending === 'enabled'}
              />
            </div>
          )}
        />

        {/* What happens next, in one line, before anything is touched. */}
        <p className={cn(
          'rounded-lg border px-3 py-2.5 text-xs leading-relaxed',
          settings.enabled
            ? 'border-border bg-card/40 text-foreground'
            : 'border-dashed border-border bg-muted/20 text-muted-foreground',
        )}>
          {settings.enabled
            ? t.greetingsNextRun.replace('{date}', formatDayMonth(run))
            : t.greetingsNotSending}
        </p>

        {usersFailed && (
          <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-foreground">
            <AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
            <span>{t.greetingsStaffLoadFailed}</span>
          </p>
        )}

        {/* The three occasions are the master switch's dependants, so they are drawn as its
            dependants — indented under it, with a sentence rather than silent greying when it
            is off. They used to be a flat divide-y list of four peers. */}
        <Dependent active={settings.enabled} offNote={t.greetingsOccasionsOffNote}>
          <Label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t.greetingsOccasionsHeading}
          </Label>
          <div className="grid gap-2 sm:grid-cols-3">
            <SwitchButton
              variant="tile" icon={Cake}
              checked={settings.birthday}
              disabled={!settings.enabled}
              onChange={v => void persist({ ...settings, birthday: v }, 'birthday')}
              label={t.greetingsBirthdays}
              hint={t.greetingsBirthdaysHint}
              meta={settings.enabled && settings.birthday ? dueLine(due.birthday) : undefined}
              onWord={on} offWord={off}
            />
            <SwitchButton
              variant="tile" icon={Medal}
              checked={settings.anniversary}
              disabled={!settings.enabled}
              onChange={v => void persist({ ...settings, anniversary: v }, 'anniversary')}
              label={t.greetingsAnniversaries}
              hint={t.greetingsAnniversariesHint}
              meta={settings.enabled && settings.anniversary ? dueLine(due.anniversary) : undefined}
              onWord={on} offWord={off}
            />
            <SwitchButton
              variant="tile" icon={CalendarDays}
              checked={settings.special}
              disabled={!settings.enabled}
              onChange={v => void persist({ ...settings, special: v }, 'special')}
              label={t.greetingsSpecialDays}
              hint={t.greetingsSpecialDaysHint}
              meta={settings.enabled && settings.special ? dueLine(due.special) : undefined}
              onWord={on} offWord={off}
            />
          </div>
        </Dependent>
      </section>

      <section className="p-5">
        <SignerLists
          settings={settings}
          users={users}
          companies={companies}
          departments={departments}
          onWrite={(next, key) => void persist(next, key)}
          pending={pending}
        />
      </section>

      <section className="p-5">
        <SpecialDaysBlock
          settings={settings}
          calendar={calendar}
          year={thisYear()}
          today={localDateString()}
          live={settings.enabled && settings.special}
          onWrite={(next, key) => void persist(next, key)}
          pending={pending}
          onEdit={openDay}
        />
      </section>

      <section className="space-y-4 p-5">
        <TestGreeting
          users={users}
          specialDays={settings.special_days}
          calendar={calendar}
          year={thisYear()}
          myEpf={myEpf}
        />

        {/* Provenance, in the house's bordered strip — and where a quiet save reports itself,
            now that a toast no longer fires on every switch. */}
        <div className="rounded-lg border border-border bg-card/40 px-3 py-2.5 text-xs text-muted-foreground">
          {pending ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> {t.saving}
            </span>
          ) : savedLine ?? t.greetingsNeverSaved}
        </div>
      </section>

      <SpecialDayDialog open={dayOpen} onOpenChange={setDayOpen} day={editing} holidays={holidays}
        calendar={calendar} year={thisYear()}
        previewSenders={previewSenders} previewName={previewName}
        onSave={saveDay} busy={pending !== null} />
    </div>
  );
}
