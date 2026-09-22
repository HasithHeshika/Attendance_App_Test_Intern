'use client';
// Redesigned Person Dossier popup UI and UX.
// Everything the viewer is allowed to know about one person, presented in a high-end,
// executive-grade dashboard popup with full interactive map and date filtering.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  User, Clock, CalendarDays, ListChecks, CalendarRange, Wallet, UtensilsCrossed,
  Banknote, ExternalLink, AlertTriangle, Cake, Flag, LayoutDashboard,
  MapPin, CheckCircle2, ChevronRight, ChevronLeft, Navigation, Map as MapIcon,
  Building2, Briefcase, Calendar, Phone, Mail, ArrowUpRight,
  ShieldCheck, AlertCircle, Sparkles, Fingerprint, ScanFace, Smartphone
} from 'lucide-react';
import { format, getDaysInMonth } from 'date-fns';

import { useT } from '@/store/appStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { tenant } from '@/lib/firebase';
import { MODULE_ROUTES, type TenantFeatures } from '@/lib/tenants';
import type { DayPerson } from '@/lib/overviewData';
import { normalizeSessions } from '@/lib/overviewData';
import { isValidLatLng } from '@/lib/geo';
import { cn, formatTime, localDateString } from '@/lib/utils';

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/Skeleton';
import { auth } from '@/lib/firebase';
import { liveOAuthPhotoForEmail, getCachedAvatar } from '@/lib/avatarCache';
import { useAuthStore } from '@/store/authStore';
import Sparkline from '@/components/ui/Sparkline';
import { useResolvedLimit, LimitHeadroomLine } from '@/components/suspense/shared';
import { formatSuspenseAmount } from '@/services/suspenseService';

import {
  visibleDossierBlocks, type DossierBlockId, type DossierCtx,
  loadIdentity, loadAttendance, loadLeave, loadTasks, loadSchedule, loadSuspense, loadFood, loadPayroll,
  type IdentityData, type AttendanceData, type LeaveData, type TaskData,
  type ScheduleData, type SuspenseData, type FoodData, type PayrollData,
} from './dossierData';
import { dayHours, dayIssues, type DayIssue } from './dayMetrics';
import type { MapDay, MapPerson, MapSession, MapUpdate } from './SriLankaMap';

// Dynamically load SriLankaMap to keep Leaflet bundle out of initial load
const SriLankaMap = dynamic(() => import('./SriLankaMap'), { ssr: false });

// ── Types ──────────────────────────────────────────────────────────────────────────────────
export type DossierTabId = 'all' | 'map' | DossierBlockId;

export interface PersonDossierProps {
  person: DayPerson | null;
  date: string;
  monthDays?: readonly MapDay[] | null;
  onClose: () => void;
}

interface Loaded {
  identity?: IdentityData;
  attendance?: AttendanceData;
  leave?: LeaveData;
  tasks?: TaskData;
  schedule?: ScheduleData;
  suspense?: SuspenseData;
  food?: FoodData;
  payroll?: PayrollData;
}

type BlockStatus = 'loading' | 'ok' | 'error';

export interface CheckpointItem {
  id: string;
  kind: 'checkin' | 'update' | 'checkout';
  time: string;
  lat: number;
  lng: number;
  place?: string | null;
  accuracy?: number | null;
  outstation?: boolean;
  outOfRadius?: boolean | null;
}

export interface PersonDateCapture {
  date: string;
  formattedDate: string;
  isToday: boolean;
  sessionsCount: number;
  capturesCount: number;
  place: string | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  checkpoints: CheckpointItem[];
}

const LOADERS = {
  identity: loadIdentity, attendance: loadAttendance, leave: loadLeave, tasks: loadTasks,
  schedule: loadSchedule, suspense: loadSuspense, food: loadFood, payroll: loadPayroll,
} as const;
type LoadableId = keyof typeof LOADERS;

const routeAllowed = (path: string, f: TenantFeatures) =>
  (MODULE_ROUTES.find(r => r.path === path)?.needs ?? []).every(k => f[k] === true);

const initialsOf = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0)).join('').toUpperCase() || '?';

const lkr = (n: number) => `LKR ${Math.round(n).toLocaleString('en-US')}`;

export const MONTH_OPTIONS = [
  { value: 1, label: 'January', short: 'Jan' },
  { value: 2, label: 'February', short: 'Feb' },
  { value: 3, label: 'March', short: 'Mar' },
  { value: 4, label: 'April', short: 'Apr' },
  { value: 5, label: 'May', short: 'May' },
  { value: 6, label: 'June', short: 'Jun' },
  { value: 7, label: 'July', short: 'Jul' },
  { value: 8, label: 'August', short: 'Aug' },
  { value: 9, label: 'September', short: 'Sep' },
  { value: 10, label: 'October', short: 'Oct' },
  { value: 11, label: 'November', short: 'Nov' },
  { value: 12, label: 'December', short: 'Dec' },
];

const currentYearNum = new Date().getFullYear();
export const YEAR_OPTIONS = [
  currentYearNum - 2,
  currentYearNum - 1,
  currentYearNum,
  currentYearNum + 1,
];

function toClockStr(v: any): string {
  if (!v) return '';
  if (typeof v === 'string') return formatTime(v);
  const d = typeof v?.toDate === 'function' ? v.toDate() :
    typeof v?.seconds === 'number' ? new Date(v.seconds * 1000) :
    v instanceof Date ? v : null;
  if (!d || isNaN(d.getTime())) return '';
  const h = d.getHours(), m = d.getMinutes();
  const hh = String(h % 12 || 12).padStart(2, '0');
  return `${hh}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// ── Small UI Building Blocks ───────────────────────────────────────────────────────────────
function Field({ label, value, icon: Icon }: { label: string; value: React.ReactNode; icon?: React.ElementType }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border/50 bg-card/40 p-2.5 transition-colors hover:bg-card/70">
      <dt className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {Icon && <Icon className="h-3 w-3 shrink-0 text-primary/70" />}
        {label}
      </dt>
      <dd className="truncate text-xs font-medium text-foreground">{value}</dd>
    </div>
  );
}

function StatTile({
  label, value, hint, icon: Icon, color = 'primary',
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ElementType;
  color?: 'primary' | 'success' | 'warning' | 'indigo' | 'cyan';
}) {
  const colorMap = {
    primary: 'text-primary border-primary/20 bg-primary/5',
    success: 'text-emerald-500 border-emerald-500/20 bg-emerald-500/5',
    warning: 'text-amber-500 border-amber-500/20 bg-amber-500/5',
    indigo: 'text-indigo-400 border-indigo-500/20 bg-indigo-500/5',
    cyan: 'text-cyan-400 border-cyan-500/20 bg-cyan-500/5',
  };

  return (
    <div className="group relative flex min-h-[94px] flex-col justify-between overflow-hidden rounded-xl border border-border/70 bg-card/60 p-3 transition-all hover:border-border hover:bg-card/90">
      <div className="flex items-start justify-between gap-1.5">
        <span className="line-clamp-2 text-[10px] font-semibold uppercase leading-tight tracking-wider text-muted-foreground">
          {label}
        </span>
        {Icon && (
          <div className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-md border', colorMap[color])}>
            <Icon className="h-3.5 w-3.5" />
          </div>
        )}
      </div>
      <div className="mt-1">
        <div className="text-xl font-bold leading-tight tabular-nums text-foreground">{value}</div>
        {hint && <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

function BlockError({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
      <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
      <span>{text}</span>
    </div>
  );
}

function BlockSkeleton() {
  return (
    <div className="space-y-3 rounded-xl border border-border/40 p-4">
      <Skeleton className="h-4 w-1/3" />
      <div className="grid grid-cols-3 gap-2">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

export function IssueChips({ issues, t }: { issues: DayIssue[]; t: ReturnType<typeof useT> }) {
  if (!issues.length) return null;
  const label = (i: DayIssue): string => {
    if (i.kind === 'missingCheckout') return t.missingCheckout;
    if (i.kind === 'outsideRadius') return t.ovOutsideRadius;
    if (i.kind === 'outstation') return i.distanceKm != null ? `${t.ovOutstation} ${i.distanceKm}km` : t.ovOutstation;
    return 'No GPS';
  };
  return (
    <div className="flex flex-wrap gap-1">
      {issues.map(i => (
        <Badge
          key={i.kind}
          variant={i.severity === 'error' ? 'destructive' : 'warning'}
          className="h-5 px-1.5 py-0 text-[10px] font-medium leading-tight"
        >
          {label(i)}
        </Badge>
      ))}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────────────────
export default function PersonDossier({ person, date, monthDays, onClose }: PersonDossierProps) {
  const t = useT();
  const caps = useUserCapabilities();
  const features = tenant.features;

  const initialYear = useMemo(() => Number(date.slice(0, 4)) || new Date().getFullYear(), [date]);
  const initialMonth = useMemo(() => Number(date.slice(5, 7)) || (new Date().getMonth() + 1), [date]);

  const [activeYear, setActiveYear] = useState<number>(initialYear);
  const [activeMonth, setActiveMonth] = useState<number>(initialMonth);

  useEffect(() => {
    setActiveYear(initialYear);
    setActiveMonth(initialMonth);
  }, [initialYear, initialMonth]);

  const handlePrevMonth = () => {
    if (activeMonth === 1) {
      setActiveYear(y => y - 1);
      setActiveMonth(12);
    } else {
      setActiveMonth(m => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (activeMonth === 12) {
      setActiveYear(y => y + 1);
      setActiveMonth(1);
    } else {
      setActiveMonth(m => m + 1);
    }
  };

  const handleResetToCurrent = () => {
    setActiveYear(initialYear);
    setActiveMonth(initialMonth);
  };

  const [metricViewMode, setMetricViewMode] = useState<'month' | 'year'>('month');

  const blockIds = useMemo(() => visibleDossierBlocks(caps, features), [caps, features]);
  const [data, setData] = useState<Loaded>({});
  const [status, setStatus] = useState<Partial<Record<DossierBlockId, BlockStatus>>>({});
  const [activeTab, setActiveTab] = useState<DossierTabId>('all');
  const [selectedMapDate, setSelectedMapDate] = useState<string | 'all'>('all');
  const [highlightedCheckpointIdx, setHighlightedCheckpointIdx] = useState<number | null>(null);

  const epf = person?.epf ?? null;
  const idsKey = blockIds.join(',');

  const activeMonthStr = `${activeYear}-${String(activeMonth).padStart(2, '0')}`;
  const activeDayStr = (activeYear === initialYear && activeMonth === initialMonth)
    ? date
    : `${activeMonthStr}-01`;

  // Load backend data independently for activeYear and activeMonth
  useEffect(() => {
    if (!epf) return;
    let alive = true;
    const ctx: DossierCtx = { epf, year: activeYear, month: activeMonth, day: activeDayStr };
    const ids = blockIds.filter((id): id is LoadableId => id in LOADERS);

    setData({});
    setSelectedMapDate('all');
    setStatus(Object.fromEntries(ids.map(id => [id, 'loading' as BlockStatus])));

    void Promise.allSettled(ids.map(async (id) => {
      const load = LOADERS[id] as (c: DossierCtx) => Promise<unknown>;
      const result = await load(ctx);
      if (!alive) return;
      setData(d => ({ ...d, [id]: result }));
      setStatus(s => ({ ...s, [id]: 'ok' }));
    })).then(results => {
      if (!alive) return;
      results.forEach((r, i) => {
        if (r.status === 'rejected') setStatus(s => ({ ...s, [ids[i]]: 'error' }));
      });
    });

    return () => { alive = false; };
  }, [epf, activeYear, activeMonth, activeDayStr, idsKey]);

  // ── Build GPS Map Data for this employee across the month ────────────────────────────────
  const personMapDays = useMemo((): MapDay[] => {
    if (!person) return [];
    const daysMap = new Map<string, MapDay>();

    const isCurrentMonth = activeYear === initialYear && activeMonth === initialMonth;

    // 1. From monthDays (passed from overview page, valid when on initial month)
    if (isCurrentMonth && monthDays && monthDays.length > 0) {
      for (const d of monthDays) {
        const p = d.people.find(x => x.epf === person.epf);
        if (p && p.sessions.length > 0) {
          daysMap.set(d.date, {
            date: d.date,
            people: [{ epf: person.epf, name: person.name, sessions: p.sessions }],
          });
        }
      }
    }

    // 2. From data.attendance?.records (loaded live)
    if (data.attendance?.records) {
      for (const rec of data.attendance.records) {
        const recDate = rec.date;
        if (!recDate || daysMap.has(recDate)) continue;
        const rawSessions = normalizeSessions(rec);
        const validSessions: MapSession[] = [];
        for (const s of rawSessions) {
          const inLat = typeof s.check_in_lat === 'number' && isValidLatLng(s.check_in_lat, s.check_in_lng) ? s.check_in_lat : null;
          const inLng = typeof s.check_in_lng === 'number' && isValidLatLng(s.check_in_lat, s.check_in_lng) ? s.check_in_lng : null;
          const outLat = typeof s.check_out_lat === 'number' && isValidLatLng(s.check_out_lat, s.check_out_lng) ? s.check_out_lat : null;
          const outLng = typeof s.check_out_lng === 'number' && isValidLatLng(s.check_out_lat, s.check_out_lng) ? s.check_out_lng : null;
          const updates: MapUpdate[] = Array.isArray(s.locations)
            ? s.locations
                .filter((loc: any) => typeof loc.lat === 'number' && isValidLatLng(loc.lat, loc.lng))
                .map((loc: any) => ({
                  lat: loc.lat,
                  lng: loc.lng,
                  atMs: loc.timestamp?.toMillis ? loc.timestamp.toMillis() : null,
                  accuracyM: loc.accuracy ?? null,
                  name: loc.place ?? loc.name ?? 'Location update',
                }))
            : [];

          if (inLat != null || outLat != null || updates.length > 0) {
            validSessions.push({
              checkIn: toClockStr(s.check_in),
              checkOut: toClockStr(s.check_out),
              lat: inLat,
              lng: inLng,
              outLat,
              outLng,
              place: s.check_in_site_name ?? s.working_place ?? null,
              outstation: !!s.is_outstation,
              outOfRadius: s.check_out_within_radius == null ? null : !s.check_out_within_radius,
              accuracyM: typeof s.check_in_accuracy_m === 'number' ? s.check_in_accuracy_m : null,
              outAccuracyM: typeof s.check_out_accuracy_m === 'number' ? s.check_out_accuracy_m : null,
              siteId: s.check_in_site_id ?? null,
              updates,
            });
          }
        }
        if (validSessions.length > 0) {
          daysMap.set(recDate, {
            date: recDate,
            people: [{ epf: person.epf, name: person.name, sessions: validSessions }],
          });
        }
      }
    }

    // 3. Fallback: today's sessions from person prop (only when on initial month)
    if (isCurrentMonth && !daysMap.has(date) && person.sessions.length > 0) {
      const validSessions: MapSession[] = [];
      for (const s of person.sessions) {
        if (s.lat != null && s.lng != null) {
          validSessions.push({
            checkIn: s.checkIn,
            checkOut: s.checkOut,
            lat: s.lat,
            lng: s.lng,
            outLat: null,
            outLng: null,
            place: s.place,
            outstation: s.outstation,
            outOfRadius: s.outOfRadius,
            accuracyM: null,
            outAccuracyM: null,
            siteId: null,
            updates: [],
          });
        }
      }
      if (validSessions.length > 0) {
        daysMap.set(date, {
          date,
          people: [{ epf: person.epf, name: person.name, sessions: validSessions }],
        });
      }
    }

    return Array.from(daysMap.values()).sort((a, b) => b.date.localeCompare(a.date));
  }, [person, monthDays, data.attendance?.records, date, activeYear, activeMonth, initialYear, initialMonth]);

  // Build per-date captures & timeline checkpoints
  const personDateCaptures = useMemo((): PersonDateCapture[] => {
    return personMapDays.map(day => {
      const p = day.people[0];
      const sessions = p?.sessions ?? [];
      const checkpoints: CheckpointItem[] = [];
      let primaryPlace: string | null = null;
      let firstIn: string | null = null;
      let lastOut: string | null = null;

      sessions.forEach((s, sIdx) => {
        if (!primaryPlace && s.place) primaryPlace = s.place;
        if (!firstIn && s.checkIn) firstIn = s.checkIn;
        if (s.checkOut) lastOut = s.checkOut;

        if (s.lat != null && s.lng != null) {
          checkpoints.push({
            id: `${day.date}-s${sIdx}-in`,
            kind: 'checkin',
            time: s.checkIn || 'Check-in',
            lat: s.lat,
            lng: s.lng,
            place: s.place,
            accuracy: s.accuracyM,
            outstation: s.outstation,
            outOfRadius: s.outOfRadius,
          });
        }

        (s.updates ?? []).forEach((u, uIdx) => {
          checkpoints.push({
            id: `${day.date}-s${sIdx}-u${uIdx}`,
            kind: 'update',
            time: u.atMs ? format(new Date(u.atMs), 'hh:mm a') : 'Update',
            lat: u.lat,
            lng: u.lng,
            place: u.name,
            accuracy: u.accuracyM,
          });
        });

        if (s.outLat != null && s.outLng != null) {
          checkpoints.push({
            id: `${day.date}-s${sIdx}-out`,
            kind: 'checkout',
            time: s.checkOut || 'Check-out',
            lat: s.outLat,
            lng: s.outLng,
            place: s.place,
            accuracy: s.outAccuracyM,
            outstation: s.outstation,
            outOfRadius: s.outOfRadius,
          });
        }
      });

      let formattedDate = day.date;
      try {
        formattedDate = format(new Date(`${day.date}T00:00:00`), 'EEE, d MMM yyyy');
      } catch { /* use raw */ }

      return {
        date: day.date,
        formattedDate,
        isToday: day.date === activeDayStr,
        sessionsCount: sessions.length,
        capturesCount: checkpoints.length,
        place: primaryPlace,
        checkInTime: firstIn,
        checkOutTime: lastOut,
        checkpoints,
      };
    });
  }, [personMapDays, activeDayStr]);

  const totalGpsCaptures = useMemo(() => {
    return personDateCaptures.reduce((acc, c) => acc + c.capturesCount, 0);
  }, [personDateCaptures]);

  // Active map days depending on filter
  const activeMapDays = useMemo(() => {
    if (selectedMapDate === 'all') return personMapDays;
    return personMapDays.filter(d => d.date === selectedMapDate);
  }, [personMapDays, selectedMapDate]);

  // Tabs metadata
  const TABS: Array<{ id: DossierTabId; label: string; icon: React.ElementType; badge?: string | number }> = [
    { id: 'all', label: t.ovdTabAll ?? 'All', icon: LayoutDashboard },
    {
      id: 'map',
      label: t.ovdTabMap ?? 'Map & GPS',
      icon: MapPin,
      badge: totalGpsCaptures > 0 ? totalGpsCaptures : undefined,
    },
    { id: 'identity', label: 'Profile', icon: User },
    { id: 'attendance', label: 'Timesheet', icon: Clock },
    {
      id: 'leave',
      label: t.leaveCap,
      icon: CalendarDays,
      badge: (data.leave?.pending.length ?? 0) > 0 ? data.leave?.pending.length : undefined,
    },
    {
      id: 'tasks',
      label: t.tasksWord,
      icon: ListChecks,
      badge: (data.tasks?.open ?? 0) > 0 ? data.tasks?.open : undefined,
    },
    ...(blockIds.includes('schedule') ? [{ id: 'schedule' as DossierTabId, label: t.navSchedule, icon: CalendarRange }] : []),
    ...(blockIds.includes('suspense') ? [{ id: 'suspense' as DossierTabId, label: t.navSuspense, icon: Wallet }] : []),
    ...(blockIds.includes('food') ? [{ id: 'food' as DossierTabId, label: t.mealsWord, icon: UtensilsCrossed }] : []),
    ...(blockIds.includes('payroll') ? [{ id: 'payroll' as DossierTabId, label: 'Payroll', icon: Banknote }] : []),
    { id: 'links', label: 'Links', icon: ExternalLink },
  ];

  const dayIssueList = person ? dayIssues(person) : [];
  const hoursToday = person ? dayHours(person.sessions) : 0;

  // Resolve profile image from Google OAuth, uploaded avatar, or cache
  const resolvedAvatar = useMemo(() => {
    if (person?.avatar) return person.avatar;

    const u = data.identity?.user as any;
    if (u) {
      const direct = u.avatar_url || u.avatar || u.photo_url || u.photoURL || u.profile_photo_url;
      if (direct) return direct;
      if (u.email) {
        const cached = liveOAuthPhotoForEmail(u.email) || getCachedAvatar(u.email);
        if (cached) return cached;
      }
    }

    const currentAuth = auth.currentUser;
    const authStoreUser = useAuthStore.getState().user;
    const targetEmail = (u?.email || person?.email || '').toLowerCase().trim();
    const currentEmail = (currentAuth?.email || authStoreUser?.email || '').toLowerCase().trim();
    const isSelf = (currentEmail && targetEmail && currentEmail === targetEmail) ||
      (authStoreUser?.epf_number && person?.epf && authStoreUser.epf_number === person.epf);

    if (isSelf) {
      if (currentAuth?.photoURL) return currentAuth.photoURL;
      if (authStoreUser?.avatar) return authStoreUser.avatar;
      if ((authStoreUser as any)?.profile_photo_url) return (authStoreUser as any).profile_photo_url;
    }

    if (person?.email) {
      const cached = liveOAuthPhotoForEmail(person.email) || getCachedAvatar(person.email);
      if (cached) return cached;
    }

    return null;
  }, [person, data.identity]);

  return (
    <Dialog open={!!person} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent
        closeLabel={t.closeWord}
        className="flex max-h-[calc(100dvh-1.5rem)] w-[calc(100%-1rem)] max-w-none flex-col gap-0 overflow-hidden rounded-2xl border border-border/80 bg-background/95 p-0 shadow-2xl backdrop-blur-xl sm:w-[calc(100%-2rem)] md:max-w-4xl lg:max-w-5xl"
      >
        {person && (
          <>
            {/* ── Redesigned Header ── */}
            {/* space-y-4 (was space-y-0) — this is what actually controls the gap between the
                three stacked rows below (avatar/name, status chips, tab strip). A plain mt-*
                utility applied directly to one of those rows ties on CSS specificity with this
                container's own space-y-* sibling rule (Tailwind wraps space-y in :where() to
                keep its specificity at a single class, same as a bare mt-* class), and depending
                on stylesheet order the space-y rule can silently win — which is exactly what
                made two earlier per-row mt-5/mt-4 attempts render with no visible effect. */}
            <DialogHeader className="shrink-0 space-y-4 border-b border-border/60 bg-card/40 px-5 pb-3 pt-4 backdrop-blur">
              <div className="flex flex-col gap-3 pr-10 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-center gap-3.5">
                  {/* Styled Avatar with Photo / Fallback Initials and Status Dot */}
                  <div className="relative shrink-0">
                    <Avatar className="h-12 w-12 rounded-2xl border border-primary/30 shadow-inner overflow-hidden bg-gradient-to-br from-primary/20 via-primary/10 to-primary/5">
                      {resolvedAvatar && (
                        <AvatarImage
                          src={resolvedAvatar}
                          alt={person.name}
                          className="h-full w-full object-cover"
                        />
                      )}
                      <AvatarFallback className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/20 via-primary/10 to-primary/5 text-base font-bold tracking-tight text-primary">
                        {initialsOf(person.name)}
                      </AvatarFallback>
                    </Avatar>

                    {/* Live status dot - positioned cleanly at top-right to prevent badge collision */}
                    <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5" title={person.status}>
                      {person.status === 'present' && (
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      )}
                      <span className={cn(
                        'relative inline-flex h-3.5 w-3.5 rounded-full ring-2 ring-card shadow-xs',
                        person.status === 'present' ? 'bg-emerald-500' :
                        person.status === 'leave' ? 'bg-amber-500' :
                        // Southern Lanka only — nobody assigned them a shift, so this is
                        // deliberately NOT the destructive/red "Absent" color.
                        person.status === 'unscheduled' ? 'bg-muted-foreground' : 'bg-destructive'
                      )} />
                    </span>
                  </div>

                  {/* Name, EPF, Company, Department */}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <DialogTitle className="text-lg font-bold tracking-tight text-foreground">
                        {person.name}
                      </DialogTitle>
                      <span className="rounded-md border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
                        {person.epf}
                      </span>
                    </div>

                    <DialogDescription className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      {person.company && (
                        <span className="inline-flex items-center gap-1 font-medium text-foreground/80">
                          <Building2 className="h-3 w-3 text-muted-foreground" />
                          {person.company}
                        </span>
                      )}
                      {data.identity?.user?.department && (
                        <span className="inline-flex items-center gap-1">
                          <span className="text-muted-foreground/50">·</span>
                          <Briefcase className="h-3 w-3 text-muted-foreground" />
                          {data.identity.user.department}
                        </span>
                      )}
                      {data.identity?.user?.designation && (
                        <span className="hidden sm:inline-flex items-center gap-1 text-muted-foreground">
                          <span className="text-muted-foreground/50">·</span>
                          {data.identity.user.designation}
                        </span>
                      )}
                    </DialogDescription>
                  </div>
                </div>

                {/* Right Controls: Month/Year Stepper + Timesheet */}
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  {/* Month & Year Stepper & Selector */}
                  <div className="flex items-center gap-0.5 rounded-lg border border-border/70 bg-card/80 p-0.5 shadow-2xs backdrop-blur">
                    <button
                      type="button"
                      onClick={handlePrevMonth}
                      title="Previous month"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>

                    <div className="flex items-center gap-1 px-1">
                      <select
                        value={activeMonth}
                        onChange={(e) => setActiveMonth(Number(e.target.value))}
                        aria-label="Select month"
                        className="cursor-pointer bg-transparent text-xs font-semibold text-foreground focus:outline-none"
                      >
                        {MONTH_OPTIONS.map((mo) => (
                          <option key={mo.value} value={mo.value} className="bg-popover text-popover-foreground">
                            {mo.short}
                          </option>
                        ))}
                      </select>

                      <select
                        value={activeYear}
                        onChange={(e) => setActiveYear(Number(e.target.value))}
                        aria-label="Select year"
                        className="cursor-pointer bg-transparent text-xs font-semibold text-foreground focus:outline-none"
                      >
                        {YEAR_OPTIONS.map((y) => (
                          <option key={y} value={y} className="bg-popover text-popover-foreground">
                            {y}
                          </option>
                        ))}
                      </select>
                    </div>

                    <button
                      type="button"
                      onClick={handleNextMonth}
                      title="Next month"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {(activeYear !== initialYear || activeMonth !== initialMonth) && (
                    <button
                      type="button"
                      onClick={handleResetToCurrent}
                      title="Reset to current date"
                      className="rounded-lg border border-primary/30 bg-primary/10 px-2 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/20"
                    >
                      Today
                    </button>
                  )}

                  {/* Right Quick Link: Timesheet */}
                  <button
                    type="button"
                    onClick={() => setActiveTab('attendance')}
                    className={cn(
                      'hidden sm:inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-all shadow-2xs',
                      activeTab === 'attendance'
                        ? 'border-primary bg-primary text-primary-foreground shadow-xs ring-1 ring-primary/40'
                        : 'border-border/70 bg-card/60 text-muted-foreground hover:border-primary/40 hover:text-foreground'
                    )}
                  >
                    <Clock className="h-3.5 w-3.5" />
                    <span>Timesheet</span>
                  </button>
                </div>
              </div>

              {/* Status Chips Row — spacing above this row now comes from DialogHeader's own
                  space-y-4, not a margin here (see that container's comment). */}
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    person.status === 'present' ? 'success'
                    : person.status === 'leave' ? 'brand'
                    // Southern Lanka only — no shift on file is not an absence.
                    : person.status === 'unscheduled' ? 'muted'
                    : 'destructive'
                  }
                  className="h-6 px-2 text-xs font-semibold shadow-xs"
                >
                  {person.status === 'present' ? (
                    <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> {t.presentCap}</span>
                  ) : person.status === 'leave' ? (
                    <span className="flex items-center gap-1"><Calendar className="h-3 w-3" /> {t.leaveCap}</span>
                  ) : person.status === 'unscheduled' ? (
                    <span className="flex items-center gap-1"><CalendarDays className="h-3 w-3" /> {t.unscheduledCap}</span>
                  ) : (
                    <span className="flex items-center gap-1"><AlertCircle className="h-3 w-3" /> {t.missingCap}</span>
                  )}
                </Badge>

                <div className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
                  <Calendar className="h-3 w-3" />
                  <span>
                    {activeYear === initialYear && activeMonth === initialMonth
                      ? format(new Date(`${date}T00:00:00`), 'EEE, d MMM yyyy')
                      : format(new Date(`${activeMonthStr}-01T00:00:00`), 'MMMM yyyy')}
                  </span>
                </div>

                {person.status === 'present' && hoursToday > 0 && (
                  <div className="flex items-center gap-1 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                    <Clock className="h-3 w-3" />
                    <span>{hoursToday}{t.hShort} today</span>
                  </div>
                )}

                {totalGpsCaptures > 0 && (
                  <button
                    type="button"
                    onClick={() => setActiveTab('map')}
                    className="flex items-center gap-1 rounded-md border border-primary/25 bg-primary/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-primary transition-colors hover:bg-primary/20"
                  >
                    <MapPin className="h-3 w-3" />
                    <span>{totalGpsCaptures} GPS captures</span>
                  </button>
                )}

                <IssueChips issues={dayIssueList} t={t} />
              </div>

              {/* ── Modern Segmented Nav Tabs — spacing above this row also comes from
                  DialogHeader's own space-y-4 now, not a margin here. ── */}
              <nav
                aria-label={t.ovdJumpToSection}
                className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1 pt-1 scrollbar-none"
              >
                {TABS.map(tab => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      className={cn(
                        'group flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all',
                        isActive
                          ? 'border-primary/40 bg-primary text-primary-foreground shadow-sm font-semibold'
                          : 'border-transparent bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                      )}
                    >
                      <Icon className={cn('h-3.5 w-3.5', isActive ? 'text-primary-foreground' : 'text-muted-foreground group-hover:text-foreground')} />
                      <span>{tab.label}</span>
                      {tab.badge !== undefined && (
                        <span className={cn(
                          'ml-0.5 rounded-full px-1.5 py-0.2 text-[10px] font-bold tabular-nums',
                          isActive
                            ? 'bg-primary-foreground/20 text-primary-foreground'
                            : 'bg-primary/15 text-primary'
                        )}>
                          {tab.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </nav>
            </DialogHeader>

            {/* ── Content Viewport ── */}
            <div
              tabIndex={0}
              role="region"
              aria-label={t.ovdPersonDetails}
              className="min-h-0 flex-1 overflow-y-auto px-5 py-5 focus-visible:outline-none"
            >
              {activeTab === 'all' && (
                <AllOverviewTab
                  person={person}
                  date={activeDayStr}
                  year={activeYear}
                  activeMonthStr={activeMonthStr}
                  metricViewMode={metricViewMode}
                  onToggleMetricViewMode={setMetricViewMode}
                  onSelectMonth={(m) => setActiveMonth(m)}
                  data={data}
                  status={status}
                  t={t}
                  caps={caps}
                  features={features}
                  personDateCaptures={personDateCaptures}
                  onOpenMapTab={() => setActiveTab('map')}
                />
              )}

              {activeTab === 'map' && (
                <PersonMapBlock
                  person={person}
                  date={activeDayStr}
                  personMapDays={personMapDays}
                  personDateCaptures={personDateCaptures}
                  activeMapDays={activeMapDays}
                  selectedMapDate={selectedMapDate}
                  onSelectMapDate={setSelectedMapDate}
                  highlightedCheckpointIdx={highlightedCheckpointIdx}
                  onHighlightCheckpoint={setHighlightedCheckpointIdx}
                  t={t}
                />
              )}

              {activeTab === 'identity' && (
                <section className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
                      <User className="h-4 w-4 text-primary" />
                      Employee Identity & Work Profile
                    </h3>
                  </div>
                  {status.identity === 'loading' ? <BlockSkeleton /> : <IdentityBlock d={data.identity} t={t} />}
                </section>
              )}

              {activeTab === 'attendance' && (
                <section className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
                      <Clock className="h-4 w-4 text-primary" />
                      Employee Timesheet — {format(new Date(`${activeMonthStr}-01T00:00:00`), 'MMMM yyyy')}
                    </h3>
                  </div>
                  {status.attendance === 'loading' ? <BlockSkeleton /> : (
                    <AttendanceBlock
                      d={data.attendance}
                      person={person}
                      date={activeDayStr}
                      activeMonthStr={activeMonthStr}
                      activeYear={activeYear}
                      leaveData={data.leave}
                      t={t}
                    />
                  )}
                </section>
              )}

              {activeTab === 'leave' && (
                <section className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
                      <CalendarDays className="h-4 w-4 text-primary" />
                      {t.leaveCap} & Balances ({activeYear})
                    </h3>
                  </div>
                  {status.leave === 'loading' ? <BlockSkeleton /> : <LeaveBlock d={data.leave} year={activeYear} t={t} />}
                </section>
              )}

              {activeTab === 'tasks' && (
                <section className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
                      <ListChecks className="h-4 w-4 text-primary" />
                      Tasks & Assigned Workload
                    </h3>
                  </div>
                  {status.tasks === 'loading' ? <BlockSkeleton /> : <TasksBlock d={data.tasks} t={t} />}
                </section>
              )}

              {activeTab === 'schedule' && (
                <section className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
                      <CalendarRange className="h-4 w-4 text-primary" />
                      {t.navSchedule} — Roster & Day-offs
                    </h3>
                  </div>
                  {status.schedule === 'loading' ? <BlockSkeleton /> : <ScheduleBlock d={data.schedule} t={t} />}
                </section>
              )}

              {activeTab === 'suspense' && (
                <section className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
                      <Wallet className="h-4 w-4 text-primary" />
                      {t.navSuspense} Accounts & Headroom
                    </h3>
                  </div>
                  {status.suspense === 'loading' ? <BlockSkeleton /> : <SuspenseBlock d={data.suspense} t={t} />}
                </section>
              )}

              {activeTab === 'food' && (
                <section className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
                      <UtensilsCrossed className="h-4 w-4 text-primary" />
                      {t.mealsWord}
                    </h3>
                  </div>
                  {status.food === 'loading' ? <BlockSkeleton /> : <FoodBlock d={data.food} t={t} />}
                </section>
              )}

              {activeTab === 'payroll' && (
                <section className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
                      <Banknote className="h-4 w-4 text-primary" />
                      Payroll & Active Advances
                    </h3>
                  </div>
                  {status.payroll === 'loading' ? <BlockSkeleton /> : <PayrollBlock d={data.payroll} t={t} />}
                </section>
              )}

              {activeTab === 'links' && (
                <section className="space-y-4">
                  <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
                    <ExternalLink className="h-4 w-4 text-primary" />
                    Open In Dedicated Portals
                  </h3>
                  <LinksBlock caps={caps} features={features} t={t} />
                </section>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Tab 1: Executive Overview "All" Tab ─────────────────────────────────────────────────────
function AllOverviewTab({
  person,
  date,
  year,
  activeMonthStr,
  metricViewMode,
  onToggleMetricViewMode,
  onSelectMonth,
  data,
  status,
  t,
  caps,
  features,
  personDateCaptures,
  onOpenMapTab,
}: {
  person: DayPerson;
  date: string;
  year: number;
  activeMonthStr: string;
  metricViewMode: 'month' | 'year';
  onToggleMetricViewMode: (mode: 'month' | 'year') => void;
  onSelectMonth: (m: number) => void;
  data: Loaded;
  status: Partial<Record<DossierBlockId, BlockStatus>>;
  t: ReturnType<typeof useT>;
  caps: ReturnType<typeof useUserCapabilities>;
  features: TenantFeatures;
  personDateCaptures: PersonDateCapture[];
  onOpenMapTab: () => void;
}) {
  const hoursToday = dayHours(person.sessions);
  const totalCaptures = personDateCaptures.reduce((acc, c) => acc + c.capturesCount, 0);

  return (
    <div className="space-y-6">
      {/* ── Top Metrics Grid ── */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label="Today Logged"
          value={`${hoursToday}${t.hShort}`}
          hint={person.sessions.length > 0 ? `${person.sessions.length} session(s)` : 'No sessions'}
          icon={Clock}
          color="primary"
        />
        <StatTile
          label={metricViewMode === 'year' ? `Worked in ${year}` : t.attendanceDays}
          value={metricViewMode === 'year' ? (data.attendance?.yearWorkedDays ?? 0) : (data.attendance?.workedDays ?? 0)}
          hint={metricViewMode === 'year'
            ? (data.attendance?.yearAvgHours ? `${data.attendance.yearAvgHours}h/day avg` : undefined)
            : (data.attendance?.avgHours ? `${data.attendance.avgHours}h/day avg` : undefined)}
          icon={Calendar}
          color="success"
        />
        <StatTile
          label={metricViewMode === 'year' ? `Total in ${year}` : t.totalLogged}
          value={`${metricViewMode === 'year' ? (data.attendance?.yearTotalHours ?? 0) : (data.attendance?.totalHours ?? 0)}${t.hShort}`}
          hint={metricViewMode === 'year' ? `Full Year ${year}` : format(new Date(`${activeMonthStr}-01T00:00:00`), 'MMM yyyy')}
          icon={Sparkles}
          color="cyan"
        />
        <StatTile
          label={`Leave in ${year}`}
          value={`${data.leave?.daysTakenThisYear ?? 0} ${t.daysWord}`}
          hint={data.leave?.balances.length ? `${data.leave.balances.length} quota categories` : undefined}
          icon={CalendarDays}
          color="warning"
        />
        <StatTile
          label={t.tasksWord}
          value={data.tasks?.open ?? 0}
          hint={data.tasks?.overdue ? `${data.tasks.overdue} overdue` : 'All on track'}
          icon={ListChecks}
          color={data.tasks?.overdue ? 'warning' : 'indigo'}
        />
        <StatTile
          label="GPS Locations"
          value={totalCaptures}
          hint={personDateCaptures.length ? `${personDateCaptures.length} active day(s)` : 'No GPS points'}
          icon={MapPin}
          color="primary"
        />
      </div>

      {/* ── Two Column Structured Layout ── */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Left Column (5/12) */}
        <div className="space-y-5 lg:col-span-6">
          {/* Today's Sessions */}
          <div className="rounded-xl border border-border/70 bg-card/50 p-4 shadow-xs">
            <div className="mb-3 flex items-center justify-between">
              <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-foreground">
                <Clock className="h-3.5 w-3.5 text-primary" />
                {t.todaysSessions}
              </h4>
              <Badge variant="outline" className="text-[10px]">
                {format(new Date(`${date}T00:00:00`), 'd MMM yyyy')}
              </Badge>
            </div>

            {person.sessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/70 py-6 text-center text-xs text-muted-foreground">
                <Clock className="mb-1 h-6 w-6 text-muted-foreground/40" />
                <p>{t.noData}</p>
                <p className="text-[10px] text-muted-foreground/70">No check-in recorded on this date.</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {person.sessions.map((s, i) => (
                  <li
                    key={`${s.checkIn ?? 'x'}-${i}`}
                    className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-muted/30 p-2.5 text-xs transition-colors hover:bg-muted/50"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 font-semibold tabular-nums text-foreground">
                        <span className="flex h-2 w-2 rounded-full bg-emerald-500" />
                        <span>{s.checkIn ?? '–'}</span>
                        <span className="text-muted-foreground">→</span>
                        <span>{s.checkOut ?? <span className="text-warning font-medium">{t.ovStillIn}</span>}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {s.outstation && (
                          <Badge variant="brand" className="h-4 px-1.5 text-[9px]">{t.ovOutstation}</Badge>
                        )}
                        {s.outOfRadius === true && (
                          <Badge variant="destructive" className="h-4 px-1.5 text-[9px]">{t.ovOutsideRadius}</Badge>
                        )}
                      </div>
                    </div>
                    {s.place && (
                      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <MapPin className="h-3 w-3 shrink-0 text-primary/70" />
                        <span className="truncate">{s.place}</span>
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Map Preview Card */}
          <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50 p-4 shadow-xs">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-foreground">
                <MapPin className="h-3.5 w-3.5 text-primary" />
                GPS Location Captures
              </h4>
              <button
                type="button"
                onClick={onOpenMapTab}
                className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
              >
                <span>{t.ovdViewFullMap ?? 'View Full Map'}</span>
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {totalCaptures > 0
                  ? `${totalCaptures} GPS positions recorded across ${personDateCaptures.length} working days in this period.`
                  : 'No GPS position captures recorded for this employee.'}
              </p>

              {personDateCaptures.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {personDateCaptures.slice(0, 4).map(dc => (
                    <button
                      key={dc.date}
                      type="button"
                      onClick={onOpenMapTab}
                      className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted"
                    >
                      <Calendar className="h-3 w-3 text-muted-foreground" />
                      <span>{dc.formattedDate}</span>
                      <span className="rounded-full bg-primary/15 px-1 text-[10px] text-primary">{dc.capturesCount}</span>
                    </button>
                  ))}
                  {personDateCaptures.length > 4 && (
                    <button
                      type="button"
                      onClick={onOpenMapTab}
                      className="inline-flex items-center rounded-md border border-dashed border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      +{personDateCaptures.length - 4} more
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Profile Quick Overview */}
          <div className="rounded-xl border border-border/70 bg-card/50 p-4 shadow-xs">
            <h4 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-foreground">
              <User className="h-3.5 w-3.5 text-primary" />
              Job & Profile Details
            </h4>
            {status.identity === 'loading' ? <Skeleton className="h-20 w-full" /> : (
              <dl className="grid grid-cols-2 gap-2">
                <Field label={t.roleLabel} value={data.identity?.user?.role} icon={ShieldCheck} />
                <Field label={t.designationLabel} value={data.identity?.user?.designation} icon={Briefcase} />
                <Field label={t.departmentLabel} value={data.identity?.user?.department} icon={Building2} />
                <Field label={t.supervisorLabel} value={data.identity?.supervisorName} icon={User} />
                <Field label={t.dateOfJoin} value={data.identity?.user?.date_of_join} icon={Calendar} />
                <Field label={t.phoneLabel} value={data.identity?.user?.phone_personal || data.identity?.user?.phone_office} icon={Phone} />
              </dl>
            )}
          </div>
        </div>

        {/* Right Column (6/12) */}
        <div className="space-y-5 lg:col-span-6">
          {/* Monthly / Yearly Attendance Pattern */}
          <div className="rounded-xl border border-border/70 bg-card/50 p-4 shadow-xs">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-foreground">
                <Clock className="h-3.5 w-3.5 text-primary" />
                {metricViewMode === 'year' ? `Annual Pattern (${year})` : 'Monthly Attendance Pattern'}
              </h4>
              <div className="flex items-center gap-2">
                <div className="inline-flex rounded-md border border-border/70 bg-muted/40 p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => onToggleMetricViewMode('month')}
                    className={cn(
                      'rounded px-2 py-0.5 font-medium transition-colors',
                      metricViewMode === 'month'
                        ? 'bg-primary text-primary-foreground shadow-xs'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    Month
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleMetricViewMode('year')}
                    className={cn(
                      'rounded px-2 py-0.5 font-medium transition-colors',
                      metricViewMode === 'year'
                        ? 'bg-primary text-primary-foreground shadow-xs'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    Year
                  </button>
                </div>
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {metricViewMode === 'year' ? `${year}` : format(new Date(`${activeMonthStr}-01T00:00:00`), 'MMMM yyyy')}
                </span>
              </div>
            </div>

            {status.attendance === 'loading' ? (
              <Skeleton className="h-16 w-full" />
            ) : metricViewMode === 'month' ? (
              <div className="space-y-2">
                {(() => {
                  const ref = new Date(`${activeMonthStr}-01T00:00:00`);
                  const prefix = activeMonthStr;
                  const series = Array.from({ length: getDaysInMonth(ref) }, (_, i) =>
                    data.attendance?.hoursByDate[`${prefix}-${String(i + 1).padStart(2, '0')}`] ?? 0);
                  return (
                    <div className="rounded-lg border border-border/50 bg-background/50 p-2.5">
                      <Sparkline values={series} height={36} className="text-primary" />
                    </div>
                  );
                })()}

                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Worked: <strong className="text-foreground">{data.attendance?.workedDays ?? 0} days</strong></span>
                  <span>Total: <strong className="text-foreground">{data.attendance?.totalHours ?? 0}{t.hShort}</strong></span>
                  <span>Avg: <strong className="text-foreground">{data.attendance?.avgHours ?? 0}{t.hShort}/day</strong></span>
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">
                {(() => {
                  const hours = data.attendance?.yearHoursByMonth ?? Array(12).fill(0);
                  const days = data.attendance?.yearDaysByMonth ?? Array(12).fill(0);
                  const maxH = Math.max(...hours, 1);
                  const currentMonthNum = Number(activeMonthStr.split('-')[1]);

                  return (
                    <div className="grid h-20 grid-cols-12 items-end gap-1 rounded-lg border border-border/50 bg-background/50 p-2">
                      {MONTH_OPTIONS.map((m, idx) => {
                        const h = hours[idx] ?? 0;
                        const d = days[idx] ?? 0;
                        const pct = Math.max(Math.round((h / maxH) * 100), 4);
                        const isCurrent = (idx + 1) === currentMonthNum;
                        return (
                          <button
                            key={m.label}
                            type="button"
                            onClick={() => {
                              onSelectMonth(idx + 1);
                              onToggleMetricViewMode('month');
                            }}
                            title={`${m.label} ${year}: ${h}h (${d} days worked) — Click to view month`}
                            className={cn(
                              'group relative flex h-full w-full flex-col items-center justify-end rounded p-0.5 transition-all',
                              isCurrent ? 'bg-primary/15 ring-1 ring-primary' : 'hover:bg-muted/60'
                            )}
                          >
                            <div
                              className={cn(
                                'w-full max-w-[12px] rounded-xs transition-all',
                                h > 0
                                  ? isCurrent
                                    ? 'bg-primary shadow-xs'
                                    : 'bg-primary/75 group-hover:bg-primary'
                                  : 'bg-muted-foreground/20'
                              )}
                              style={{ height: `${pct}%` }}
                            />
                            <span className={cn(
                              'mt-1 text-[9px] font-medium leading-none',
                              isCurrent ? 'font-bold text-primary' : 'text-muted-foreground group-hover:text-foreground'
                            )}>
                              {m.label.slice(0, 3)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}

                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Worked: <strong className="text-foreground">{data.attendance?.yearWorkedDays ?? 0} days</strong></span>
                  <span>Total: <strong className="text-foreground">{data.attendance?.yearTotalHours ?? 0}{t.hShort}</strong></span>
                  <span>Avg: <strong className="text-foreground">{data.attendance?.yearAvgHours ?? 0}{t.hShort}/day</strong></span>
                </div>
                <p className="text-center text-[10px] text-muted-foreground">
                  Click any month column to drill down into that month&apos;s daily details
                </p>
              </div>
            )}
          </div>

          {/* Leave Balances Summary */}
          <div className="rounded-xl border border-border/70 bg-card/50 p-4 shadow-xs">
            <div className="mb-2.5 flex items-center justify-between">
              <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-foreground">
                <CalendarDays className="h-3.5 w-3.5 text-primary" />
                {t.leaveBalance}
              </h4>
              <span className="text-[11px] text-muted-foreground">{t.lvhBalanceRemainingHint}</span>
            </div>

            {status.leave === 'loading' ? (
              <Skeleton className="h-12 w-full" />
            ) : ((data.leave?.balances.length ?? 0) === 0 && (data.leave?.takenOnly.length ?? 0) === 0) ? (
              <p className="text-xs text-muted-foreground">{t.noData}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {data.leave?.balances.map(b => (
                  <div
                    key={b.typeId}
                    title={b.total != null ? `${b.remaining} remaining of ${b.total} days${b.used != null ? ` (${b.used} used)` : ''}` : undefined}
                    className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-2.5 py-1.5 text-xs shadow-2xs"
                  >
                    <span className="text-muted-foreground">{b.typeName}</span>
                    <span className={cn(
                      'rounded-md bg-background px-1.5 py-0.5 font-bold tabular-nums shadow-2xs',
                      b.remaining === 0 ? 'text-warn-strong' : 'text-foreground',
                    )}>
                      {b.remaining}
                      {b.total != null && b.total > 0 && (
                        <span className="ml-1 text-[10px] font-normal text-muted-foreground">/{b.total}</span>
                      )}
                    </span>
                  </div>
                ))}
                {/* Tracked, but not an entitlement. The chips above print a REMAINING figure, so
                    these carry the word "taken" — "Medical 3" sitting among them would otherwise
                    read as three medical days still in hand. No "/total" either: there is no
                    denominator, which is the entire point of the flag. */}
                {data.leave?.takenOnly.map(b => (
                  <div
                    key={`taken-${b.typeName}`}
                    title={`${b.taken} ${t.takenThisYear.toLowerCase()}`}
                    className="flex items-center gap-2 rounded-lg border border-dashed border-border/70 px-2.5 py-1.5 text-xs shadow-2xs"
                  >
                    <span className="text-muted-foreground">{b.typeName}</span>
                    <span className="rounded-md bg-background px-1.5 py-0.5 font-bold tabular-nums text-foreground shadow-2xs">
                      {b.taken}
                      <span className="ml-1 text-[10px] font-normal text-muted-foreground">{t.takenLabel}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Upcoming leaves preview */}
            {(data.leave?.upcoming.length ?? 0) > 0 && (
              <div className="mt-3 border-t border-border/50 pt-2.5">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t.upcomingWord}</p>
                <div className="space-y-1">
                  {data.leave?.upcoming.slice(0, 2).map(l => (
                    <div key={l.id} className="flex items-center justify-between text-xs">
                      <span className="text-foreground font-medium">{l.leave_type_name}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {format(new Date(`${l.from_date}T00:00:00`), 'd MMM')} – {format(new Date(`${l.to_date}T00:00:00`), 'd MMM')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Quick Links Block */}
          <div className="rounded-xl border border-border/70 bg-card/50 p-4 shadow-xs">
            <h4 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-foreground">
              <ExternalLink className="h-3.5 w-3.5 text-primary" />
              Open In Portals
            </h4>
            <LinksBlock caps={caps} features={features} t={t} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Tab 2: Map & GPS with Dates ────────────────────────────────────────────────────────────
function PersonMapBlock({
  person, date, personMapDays, personDateCaptures, activeMapDays, selectedMapDate, onSelectMapDate,
  highlightedCheckpointIdx, onHighlightCheckpoint,
  t
}: {
  person: DayPerson;
  date: string;
  personMapDays: MapDay[];
  personDateCaptures: PersonDateCapture[];
  activeMapDays: MapDay[];
  selectedMapDate: string | 'all';
  onSelectMapDate: (d: string | 'all') => void;
  highlightedCheckpointIdx: number | null;
  onHighlightCheckpoint: (idx: number | null) => void;
  t: ReturnType<typeof useT>;
}) {
  const totalCaptures = personDateCaptures.reduce((acc, c) => acc + c.capturesCount, 0);

  // Selected date captures object
  const activeDateCapture = useMemo(() => {
    if (selectedMapDate === 'all') return null;
    return personDateCaptures.find(c => c.date === selectedMapDate) ?? null;
  }, [personDateCaptures, selectedMapDate]);

  return (
    <div className="space-y-4">
      {/* ── Toolbar / Filter Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/50 p-3.5 shadow-xs">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs font-bold text-foreground">
            <Navigation className="h-4 w-4 text-primary" />
            <span>GPS Tracking Map</span>
          </div>
          <span className="text-muted-foreground/40">|</span>
          <span className="text-xs text-muted-foreground">
            <strong className="text-foreground">{totalCaptures}</strong> captures across{' '}
            <strong className="text-foreground">{personDateCaptures.length}</strong> active days
          </span>
        </div>

        {/* Date Filter Dropdown */}
        <div className="flex items-center gap-2">
          <label htmlFor="map-date-select" className="text-xs font-medium text-muted-foreground flex items-center gap-1">
            <Calendar className="h-3.5 w-3.5 text-primary/70" />
            <span>Date:</span>
          </label>
          <select
            id="map-date-select"
            value={selectedMapDate}
            onChange={e => onSelectMapDate(e.target.value as any)}
            className="h-8 rounded-lg border border-border/70 bg-background px-2.5 text-xs font-medium text-foreground shadow-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="all">All Dates ({totalCaptures} captures)</option>
            {personDateCaptures.map(dc => (
              <option key={dc.date} value={dc.date}>
                {dc.formattedDate} {dc.isToday ? '(Today)' : ''} — {dc.capturesCount} captures
              </option>
            ))}
          </select>
        </div>
      </div>

      {personMapDays.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/80 bg-card/30 p-10 text-center">
          <MapPin className="mb-2 h-10 w-10 text-muted-foreground/40" />
          <h4 className="text-sm font-semibold text-foreground">{t.ovdNoGps ?? 'No GPS locations recorded'}</h4>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            No latitude/longitude coordinates were recorded for this employee during the month. Coordinates are recorded when mobile check-in/out or live updates occur.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* ── Left Map Container (7/12) ── */}
          <div className="overflow-hidden rounded-xl border border-border/70 bg-card/40 shadow-xs lg:col-span-7">
            <div className="relative h-[480px] w-full">
              <SriLankaMap
                people={[person]}
                days={activeMapDays}
                kinds={['checkin', 'update', 'checkout']}
                focusedEpf={person.epf}
                onFocus={() => {}}
                onOpenDay={(d) => onSelectMapDate(d)}
                highlightedWaypointIdx={highlightedCheckpointIdx}
                onWaypointClick={(idx) => {
                  onHighlightCheckpoint(idx);
                  // If a specific date is not yet selected, auto-select based on trail position
                  // (trail is already filtered to activeMapDays, so this is informational only)
                }}
                height={480}
                className="h-full w-full"
                t={t}
              />
            </div>
          </div>

          {/* ── Right Dates & Checkpoints Drawer (5/12) ── */}
          <div className="flex flex-col rounded-xl border border-border/70 bg-card/40 p-4 shadow-xs lg:col-span-5 h-[480px]">
            <div className="mb-3 flex items-center justify-between border-b border-border/50 pb-2.5">
              <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-foreground">
                <MapIcon className="h-3.5 w-3.5 text-primary" />
                {selectedMapDate === 'all' ? 'Dates with GPS Activity' : 'Date Checkpoints'}
              </h4>
              {selectedMapDate !== 'all' && (
                <button
                  type="button"
                  onClick={() => onSelectMapDate('all')}
                  className="text-[11px] font-semibold text-primary hover:underline"
                >
                  View all dates
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 pr-1 scrollbar-thin">
              {/* If "All Dates" is selected, list all dates with capture cards */}
              {selectedMapDate === 'all' ? (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground">
                    Click any date below to focus the map and see chronological session checkpoints.
                  </p>
                  {personDateCaptures.map(dc => (
                    <button
                      key={dc.date}
                      type="button"
                      onClick={() => onSelectMapDate(dc.date)}
                      className={cn(
                        'flex w-full flex-col gap-1 rounded-lg border p-2.5 text-left transition-all',
                        dc.isToday
                          ? 'border-primary/40 bg-primary/5 hover:bg-primary/10'
                          : 'border-border/60 bg-card/60 hover:border-border hover:bg-card'
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-xs font-bold text-foreground">
                          <Calendar className="h-3 w-3 text-primary" />
                          {dc.formattedDate}
                          {dc.isToday && (
                            <Badge variant="brand" className="h-4 px-1 text-[9px]">Today</Badge>
                          )}
                        </span>
                        <Badge variant="outline" className="text-[10px] font-semibold tabular-nums">
                          {dc.capturesCount} point{dc.capturesCount === 1 ? '' : 's'}
                        </Badge>
                      </div>

                      {dc.place && (
                        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <MapPin className="h-3 w-3 shrink-0 text-muted-foreground/70" />
                          <span className="truncate">{dc.place}</span>
                        </p>
                      )}

                      {(dc.checkInTime || dc.checkOutTime) && (
                        <p className="text-[10px] tabular-nums text-muted-foreground">
                          {dc.checkInTime ?? '–'} → {dc.checkOutTime ?? 'Still in'}
                        </p>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                /* Specific date is selected: show timeline checkpoints */
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-lg border border-primary/20 bg-primary/5 p-2.5">
                    <div>
                      <p className="text-xs font-bold text-foreground">{activeDateCapture?.formattedDate}</p>
                      {activeDateCapture?.place && (
                        <p className="text-[11px] text-muted-foreground">{activeDateCapture.place}</p>
                      )}
                    </div>
                    <Badge variant="brand" className="text-[10px]">
                      {activeDateCapture?.capturesCount} GPS points
                    </Badge>
                  </div>

                  {activeDateCapture?.checkpoints.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No checkpoints on this date.</p>
                  ) : (
                    <div className="relative pl-4 space-y-3 before:absolute before:left-1.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-border/80">
                      {activeDateCapture?.checkpoints.map((cp, idx) => {
                        const isCheckin = cp.kind === 'checkin';
                        const isCheckout = cp.kind === 'checkout';
                        const isHighlit = highlightedCheckpointIdx === idx;
                        return (
                          <div
                            key={cp.id || idx}
                            className="relative flex items-start gap-2.5"
                            onMouseEnter={() => onHighlightCheckpoint(idx)}
                            onMouseLeave={() => onHighlightCheckpoint(null)}
                          >
                            {/* Dot indicator */}
                            <span className={cn(
                              'absolute -left-4 mt-1.5 flex h-2.5 w-2.5 rounded-full border-2 border-background transition-transform',
                              isCheckin ? 'bg-emerald-500' : isCheckout ? 'bg-amber-500' : 'bg-indigo-500',
                              isHighlit && 'scale-125'
                            )} />

                            <button
                              type="button"
                              className={cn(
                                'flex-1 rounded-lg border p-2 text-xs text-left transition-all',
                                isHighlit
                                  ? 'border-amber-400/70 bg-amber-400/10 shadow-[0_0_0_2px_rgba(251,191,36,0.3)]'
                                  : 'border-border/60 bg-muted/20 hover:border-border hover:bg-muted/40'
                              )}
                              onClick={() => onHighlightCheckpoint(isHighlit ? null : idx)}
                            >
                              <div className="flex items-center justify-between">
                                <span className="font-semibold capitalize text-foreground">
                                  {isCheckin ? 'Check-in' : isCheckout ? 'Check-out' : 'GPS Update'}
                                </span>
                                <span className="font-mono text-[10px] font-medium text-muted-foreground">{cp.time}</span>
                              </div>

                              {cp.place && (
                                <p className="mt-0.5 text-[11px] text-muted-foreground flex items-center gap-1">
                                  <MapPin className="h-3 w-3 shrink-0 text-primary/70" />
                                  <span className="truncate">{cp.place}</span>
                                </p>
                              )}

                              <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground/70">
                                <span>{cp.lat.toFixed(4)}, {cp.lng.toFixed(4)}</span>
                                {cp.accuracy && <span>(±{Math.round(cp.accuracy)}m)</span>}
                                {cp.outstation && <Badge variant="brand" className="h-3.5 px-1 text-[8px]">Outstation</Badge>}
                                {cp.outOfRadius && <Badge variant="destructive" className="h-3.5 px-1 text-[8px]">Outside Radius</Badge>}
                              </div>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab: Identity ──────────────────────────────────────────────────────────────────────────
function IdentityBlock({ d, t }: { d?: IdentityData; t: ReturnType<typeof useT> }) {
  if (!d) return null;
  const u = d.user;
  if (!u) return <BlockError text={t.employeeNotFound} />;
  const resigned = !!u.date_of_resign;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Badge variant={resigned ? 'muted' : 'success'} className="font-semibold">
          {resigned ? t.resignedLabel : t.statusActive}
        </Badge>
        {u.employee_type && <Badge variant="outline">{u.employee_type}</Badge>}
        {u.date_of_birth && (
          <Badge variant="brand" className="gap-1 font-medium">
            <Cake className="h-3 w-3" aria-hidden />
            {format(new Date(`${u.date_of_birth}T00:00:00`), 'd MMM yyyy')}
          </Badge>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3">
        <Field label={t.roleLabel} value={u.role} icon={ShieldCheck} />
        <Field label={t.designationLabel} value={u.designation} icon={Briefcase} />
        <Field label={t.departmentLabel} value={u.department} icon={Building2} />
        <Field label={t.companyWord} value={u.company_name} icon={Building2} />
        <Field label={t.employeeType} value={u.employee_type} icon={User} />
        <Field label={t.dateOfJoin} value={u.date_of_join} icon={Calendar} />
        <Field label={t.supervisorLabel} value={d.supervisorName} icon={User} />
        <Field label={t.employeeNumber} value={u.employee_number} icon={ShieldCheck} />
        <Field label={t.emailLabel} value={u.email} icon={Mail} />
        <Field label={t.phoneLabel} value={u.phone_personal || u.phone_office} icon={Phone} />
        {resigned && <Field label={t.resignedLabel} value={u.date_of_resign} icon={Calendar} />}
      </dl>
    </div>
  );
}

function formatTimestampTime(val: unknown): string {
  if (!val) return '–';
  if (typeof val === 'string') {
    if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(val.trim())) return val.trim();
    if (/^\d{1,2}:\d{2}/.test(val.trim())) return formatTime(val);
  }
  const anyVal = val as any;
  const d = typeof anyVal?.toDate === 'function'
    ? anyVal.toDate()
    : (anyVal?.seconds != null ? new Date(anyVal.seconds * 1000) : (anyVal instanceof Date ? anyVal : new Date(anyVal)));
  if (isNaN(d.getTime())) return '–';
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

// ── Tab: Attendance / Timesheet ────────────────────────────────────────────────────────────
function AttendanceBlock({
  d,
  person,
  date,
  activeMonthStr,
  activeYear,
  leaveData,
  t,
}: {
  d?: AttendanceData;
  person: DayPerson;
  date: string;
  activeMonthStr: string;
  activeYear: number;
  leaveData?: LeaveData;
  t: ReturnType<typeof useT>;
}) {
  const [viewMode, setViewMode] = useState<'month' | 'year'>('month');
  const [dayFilter, setDayFilter] = useState<'all' | 'worked' | 'leave' | 'absent' | 'rest'>('all');

  if (!d) return null;
  const ref = new Date(`${activeMonthStr}-01T00:00:00`);
  const prefix = activeMonthStr;
  const daysInMonth = getDaysInMonth(ref);
  const series = Array.from({ length: daysInMonth }, (_, i) =>
    d.hoursByDate[`${prefix}-${String(i + 1).padStart(2, '0')}`] ?? 0);

  const todayStr = localDateString();

  // Build day-by-day timesheet rows for the active month
  const monthDaysList = useMemo(() => {
    return Array.from({ length: daysInMonth }, (_, i) => {
      const dayNum = i + 1;
      const dayDateStr = `${activeMonthStr}-${String(dayNum).padStart(2, '0')}`;
      const dayObj = new Date(`${dayDateStr}T00:00:00`);
      const dayName = format(dayObj, 'EEE');
      const isSunday = dayObj.getDay() === 0;
      const isSaturday = dayObj.getDay() === 6;
      const isToday = dayDateStr === todayStr;
      const isPast = dayDateStr < todayStr;
      const isFuture = dayDateStr > todayStr;

      // Find attendance record for this day
      const rec = d.records?.find(r => r.date === dayDateStr);
      let sessions: Array<{
        id: string;
        checkIn: string;
        checkOut: string | null;
        place: string | null;
        outstation: boolean;
        outOfRadius: boolean;
        status: string;
        method?: string | null;
      }> = [];

      if (rec && Array.isArray(rec.sessions) && rec.sessions.length > 0) {
        sessions = rec.sessions.map((s, idx) => ({
          id: s.id || `s_${idx}`,
          checkIn: formatTimestampTime(s.check_in),
          checkOut: s.check_out ? formatTimestampTime(s.check_out) : null,
          place: s.locations?.[0]?.name ?? (typeof s.working_place === 'string' ? s.working_place : (s.working_place as any)?.name) ?? s.outstation_name ?? null,
          outstation: !!s.is_outstation,
          outOfRadius: s.check_out_within_radius === false,
          status: s.check_in_status === 'pending' || s.check_out_status === 'pending' ? 'pending' : (s.check_in_status || 'approved'),
          method: s.check_in_method || s.check_out_method,
        }));
      } else if (rec?.check_in) {
        sessions = [{
          id: 'legacy',
          checkIn: formatTimestampTime(rec.check_in),
          checkOut: rec.check_out ? formatTimestampTime(rec.check_out) : null,
          place: (typeof rec.working_place === 'string' ? rec.working_place : (rec.working_place as any)?.name) ?? rec.outstation_name ?? null,
          outstation: !!rec.is_outstation,
          outOfRadius: false,
          status: rec.check_in_status || 'approved',
          method: null,
        }];
      } else if (dayDateStr === date && person.sessions.length > 0) {
        sessions = person.sessions.map((s, idx) => ({
          id: `today_${idx}`,
          checkIn: s.checkIn ?? '–',
          checkOut: s.checkOut ?? null,
          place: s.place ?? null,
          outstation: !!s.outstation,
          outOfRadius: !!s.outOfRadius,
          status: 'approved',
          method: null,
        }));
      }

      // Check for approved leave
      const leaveRec = leaveData?.approved?.find(l => {
        const f = String(l.from_date).slice(0, 10);
        const t = String(l.to_date).slice(0, 10);
        return f <= dayDateStr && dayDateStr <= t;
      });

      const dayHours = d.hoursByDate[dayDateStr] ?? 0;
      const hasWork = sessions.length > 0 || dayHours > 0;
      const isLeave = !!leaveRec;
      const isRest = isSunday && !hasWork;
      const isAbsent = isPast && !hasWork && !isLeave && !isRest;

      let statusKind: 'worked' | 'leave' | 'rest' | 'absent' | 'future' = 'future';
      if (hasWork) statusKind = 'worked';
      else if (isLeave) statusKind = 'leave';
      else if (isRest) statusKind = 'rest';
      else if (isAbsent) statusKind = 'absent';
      else if (isFuture) statusKind = 'future';

      const hasPending = sessions.some(s => s.status === 'pending');

      return {
        dateStr: dayDateStr,
        dayNum,
        dayName,
        isSunday,
        isSaturday,
        isToday,
        isPast,
        isFuture,
        hours: dayHours,
        sessions,
        leaveName: leaveRec?.leave_type_name ?? null,
        statusKind,
        hasPending,
      };
    });
  }, [activeMonthStr, daysInMonth, d.records, d.hoursByDate, date, person.sessions, leaveData?.approved, todayStr]);

  const workedCount = useMemo(() => monthDaysList.filter(r => r.statusKind === 'worked').length, [monthDaysList]);
  const leaveCount = useMemo(() => monthDaysList.filter(r => r.statusKind === 'leave').length, [monthDaysList]);
  const restCount = useMemo(() => monthDaysList.filter(r => r.statusKind === 'rest').length, [monthDaysList]);
  const absentCount = useMemo(() => monthDaysList.filter(r => r.statusKind === 'absent').length, [monthDaysList]);

  // Filtered rows
  const filteredRows = useMemo(() => {
    if (dayFilter === 'all') return monthDaysList;
    return monthDaysList.filter(r => r.statusKind === dayFilter);
  }, [monthDaysList, dayFilter]);

  return (
    <div className="space-y-4">
      {/* Mode toggle and External Matrix Link */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-md border border-border/70 bg-muted/40 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setViewMode('month')}
            className={cn(
              'rounded px-3 py-1 font-medium transition-colors',
              viewMode === 'month' ? 'bg-primary text-primary-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {format(ref, 'MMMM yyyy')} Timesheet
          </button>
          <button
            type="button"
            onClick={() => setViewMode('year')}
            className={cn(
              'rounded px-3 py-1 font-medium transition-colors',
              viewMode === 'year' ? 'bg-primary text-primary-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Full Year {activeYear}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href={`/attendance-view?search=${encodeURIComponent(person.name || person.epf)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-card/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            <span>Open in Matrix View</span>
            <ArrowUpRight className="h-3 w-3" />
          </Link>
          <span className="text-xs text-muted-foreground">
            {viewMode === 'month' ? `${d.workedDays} days worked` : `${d.yearWorkedDays} days in ${activeYear}`}
          </span>
        </div>
      </div>

      {/* Top Stat Tiles */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatTile
          label={viewMode === 'year' ? `Worked in ${activeYear}` : 'Days Worked'}
          value={viewMode === 'year' ? d.yearWorkedDays : d.workedDays}
          hint={viewMode === 'month' ? `${Math.round((d.workedDays / daysInMonth) * 100)}% of month` : undefined}
          icon={Calendar}
          color="primary"
        />
        <StatTile
          label={viewMode === 'year' ? `Total in ${activeYear}` : t.totalLogged}
          value={`${viewMode === 'year' ? d.yearTotalHours : d.totalHours}${t.hShort}`}
          hint={viewMode === 'month' ? format(ref, 'MMMM yyyy') : undefined}
          icon={Clock}
          color="success"
        />
        <StatTile
          label={viewMode === 'year' ? `Avg in ${activeYear}` : t.avgPerDayLabel}
          value={`${viewMode === 'year' ? d.yearAvgHours : d.avgHours}${t.hShort}`}
          hint={viewMode === 'month' ? 'per worked day' : undefined}
          icon={Sparkles}
          color="cyan"
        />
        <StatTile
          label={viewMode === 'year' ? `Leave in ${activeYear}` : 'Leave Taken'}
          value={viewMode === 'year' ? `${leaveData?.daysTakenThisYear ?? 0} ${t.daysWord}` : `${leaveCount} ${t.daysWord}`}
          hint={viewMode === 'month' ? (leaveCount > 0 ? `${leaveCount} days this month` : 'No leaves recorded') : undefined}
          icon={CalendarDays}
          color="warning"
        />
      </div>

      {/* Pending Warning Banner */}
      {d.pendingDays > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-2.5 text-xs text-amber-500">
          <Clock className="h-4 w-4" />
          <span>{d.pendingDays} {d.pendingDays === 1 ? 'day has sessions' : 'days have sessions'} awaiting approval decision</span>
        </div>
      )}

      {/* View Mode: Month vs Year */}
      {viewMode === 'year' ? (
        <div className="rounded-xl border border-border/70 bg-card/40 p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {activeYear} — 12-Month Logged Hours Breakdown
          </p>
          <div className="grid h-28 grid-cols-12 items-end gap-1.5 rounded-lg border border-border/50 bg-background/50 p-2.5">
            {MONTH_OPTIONS.map((m, idx) => {
              const h = d.yearHoursByMonth?.[idx] ?? 0;
              const days = d.yearDaysByMonth?.[idx] ?? 0;
              const maxH = Math.max(...(d.yearHoursByMonth ?? []), 1);
              const pct = Math.max(Math.round((h / maxH) * 100), 4);
              const isCurrent = (idx + 1) === Number(activeMonthStr.split('-')[1]);
              return (
                <div
                  key={m.label}
                  title={`${m.label} ${activeYear}: ${h}h (${days} days worked)`}
                  className={cn(
                    'flex h-full w-full flex-col items-center justify-end rounded p-0.5',
                    isCurrent ? 'bg-primary/15 ring-1 ring-primary' : ''
                  )}
                >
                  <div
                    className={cn(
                      'w-full max-w-[14px] rounded-xs',
                      h > 0 ? (isCurrent ? 'bg-primary' : 'bg-primary/75') : 'bg-muted-foreground/20'
                    )}
                    style={{ height: `${pct}%` }}
                  />
                  <span className={cn(
                    'mt-1 text-[9px] font-medium leading-none',
                    isCurrent ? 'font-bold text-primary' : 'text-muted-foreground'
                  )}>
                    {m.label.slice(0, 3)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>Annual Total Worked: <strong className="text-foreground">{d.yearWorkedDays} days</strong></span>
            <span>Annual Total Hours: <strong className="text-foreground">{d.yearTotalHours}h</strong></span>
            <span>Annual Daily Avg: <strong className="text-foreground">{d.yearAvgHours}h/day</strong></span>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Trend Sparkline */}
          <div className="rounded-xl border border-border/70 bg-card/40 p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {format(ref, 'MMMM yyyy')} — Daily Logged Hours Trend
              </p>
              <span className="text-xs font-medium tabular-nums text-foreground">
                Total: {d.totalHours}h
              </span>
            </div>
            <Sparkline values={series} height={36} className="text-primary" />
          </div>

          {/* Timesheet Table Section */}
          <div className="rounded-xl border border-border/70 bg-card/40 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-3">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-primary" />
                <h4 className="text-xs font-bold uppercase tracking-wider text-foreground">
                  Day-by-Day Punch Log
                </h4>
              </div>

              {/* Status Filter Tabs */}
              <div className="flex flex-wrap items-center gap-1 text-[11px]">
                {(
                  [
                    { id: 'all', label: `All (${daysInMonth})` },
                    { id: 'worked', label: `Worked (${workedCount})` },
                    { id: 'leave', label: `Leave (${leaveCount})` },
                    { id: 'rest', label: `Rest (${restCount})` },
                    { id: 'absent', label: `Absent (${absentCount})` },
                  ] as const
                ).map(f => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setDayFilter(f.id)}
                    className={cn(
                      'rounded-md px-2 py-0.5 font-medium transition-colors',
                      dayFilter === f.id
                        ? 'bg-primary text-primary-foreground shadow-2xs font-semibold'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {/* List of Days */}
            {filteredRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center text-xs text-muted-foreground">
                <Clock className="mb-2 h-6 w-6 text-muted-foreground/40" />
                <p>No days match the selected filter ({dayFilter}).</p>
                <button
                  type="button"
                  onClick={() => setDayFilter('all')}
                  className="mt-2 text-xs font-semibold text-primary hover:underline"
                >
                  Show all days
                </button>
              </div>
            ) : (
              <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                {filteredRows.map(row => (
                  <div
                    key={row.dateStr}
                    className={cn(
                      'flex items-center justify-between gap-3 rounded-lg border p-2.5 text-xs transition-colors',
                      row.isToday
                        ? 'border-primary/50 bg-primary/5 shadow-2xs'
                        : row.statusKind === 'worked'
                          ? 'border-border/60 bg-muted/25 hover:bg-muted/45'
                          : row.statusKind === 'leave'
                            ? 'border-brand/30 bg-brand/5'
                            : 'border-border/40 bg-muted/10 opacity-75 hover:opacity-100'
                    )}
                  >
                    {/* Left: Day Badge & Weekday */}
                    <div className="flex items-center gap-3 shrink-0">
                      <div className={cn(
                        'flex h-10 w-10 flex-col items-center justify-center rounded-lg border text-center transition-all',
                        row.isToday
                          ? 'border-primary bg-primary text-primary-foreground shadow-xs'
                          : row.statusKind === 'worked'
                            ? 'border-border bg-card text-foreground'
                            : 'border-border/60 bg-muted/40 text-muted-foreground'
                      )}>
                        <span className="text-sm font-bold tabular-nums leading-none">{row.dayNum}</span>
                        <span className={cn(
                          'text-[9px] font-semibold uppercase leading-none mt-0.5',
                          row.isToday ? 'text-primary-foreground/90' : 'text-muted-foreground'
                        )}>
                          {row.dayName}
                        </span>
                      </div>

                      {/* Status pill */}
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1.5">
                          {row.statusKind === 'worked' && (
                            <Badge variant="success" className="h-5 px-1.5 text-[10px] font-semibold">
                              <span className="mr-1 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                              {row.hours > 0 ? `${row.hours}h Logged` : 'Present'}
                            </Badge>
                          )}
                          {row.statusKind === 'leave' && (
                            <Badge variant="brand" className="h-5 px-1.5 text-[10px] font-semibold">
                              <CalendarDays className="mr-1 h-3 w-3" />
                              {row.leaveName || 'Leave'}
                            </Badge>
                          )}
                          {row.statusKind === 'rest' && (
                            <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-muted-foreground">
                              Rest Day
                            </Badge>
                          )}
                          {row.statusKind === 'absent' && (
                            <Badge variant="destructive" className="h-5 px-1.5 text-[10px] font-semibold">
                              <AlertCircle className="mr-1 h-3 w-3" />
                              Absent
                            </Badge>
                          )}
                          {row.statusKind === 'future' && (
                            <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-muted-foreground/60 border-dashed">
                              Upcoming
                            </Badge>
                          )}
                          {row.isToday && (
                            <Badge variant="brand" className="h-5 px-1.5 text-[10px] font-bold">
                              Today
                            </Badge>
                          )}
                        </div>

                        {/* Date formatted */}
                        <p className="text-[11px] text-muted-foreground">
                          {format(new Date(`${row.dateStr}T00:00:00`), 'd MMMM yyyy')}
                        </p>
                      </div>
                    </div>

                    {/* Middle: Sessions or detail */}
                    <div className="min-w-0 flex-1 px-2">
                      {row.sessions.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {row.sessions.map((s, sIdx) => (
                            <div
                              key={s.id || sIdx}
                              className="inline-flex flex-wrap items-center gap-1.5 rounded-md border border-border/50 bg-background/70 px-2 py-1 text-xs"
                            >
                              <span className="font-semibold tabular-nums text-foreground">
                                {s.checkIn} → {s.checkOut ?? <span className="text-warning font-medium">Still in</span>}
                              </span>
                              {s.place && (
                                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                                  <MapPin className="h-3 w-3 shrink-0 text-primary/70" />
                                  <span className="max-w-[140px] truncate">{s.place}</span>
                                </span>
                              )}
                              {s.outstation && <Badge variant="brand" className="h-4 px-1 text-[9px]">Outstation</Badge>}
                              {s.outOfRadius && <Badge variant="destructive" className="h-4 px-1 text-[9px]">Outside Radius</Badge>}
                              {s.method === 'fingerprint' && (
                                <span title="Fingerprint terminal" className="inline-flex text-muted-foreground">
                                  <Fingerprint className="h-3 w-3 text-primary/80" />
                                </span>
                              )}
                              {s.method === 'face' && (
                                <span title="Face terminal" className="inline-flex text-muted-foreground">
                                  <ScanFace className="h-3 w-3 text-primary/80" />
                                </span>
                              )}
                              {s.status === 'pending' && <Badge variant="warning" className="h-4 px-1 text-[9px]">Pending</Badge>}
                            </div>
                          ))}
                        </div>
                      ) : row.statusKind === 'leave' ? (
                        <p className="text-xs text-purple-400 font-medium">
                          Approved Leave ({row.leaveName})
                        </p>
                      ) : row.statusKind === 'rest' ? (
                        <p className="text-xs text-muted-foreground/60 italic">Weekly Rest Day</p>
                      ) : row.statusKind === 'absent' ? (
                        <p className="text-xs text-rose-400/80">No check-in or approved leave recorded</p>
                      ) : (
                        <p className="text-xs text-muted-foreground/40">–</p>
                      )}
                    </div>

                    {/* Right: Total Hours */}
                    <div className="text-right shrink-0">
                      {row.hours > 0 ? (
                        <div className="font-bold tabular-nums text-sm text-foreground">
                          {row.hours}
                          <span className="text-xs font-normal text-muted-foreground ml-0.5">h</span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground/40 font-mono">–</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab: Leave ─────────────────────────────────────────────────────────────────────────────
function LeaveBlock({ d, year, t }: { d?: LeaveData; year: number; t: ReturnType<typeof useT> }) {
  if (!d) return null;
  const range = (from: string, to: string) =>
    from === to ? format(new Date(`${from}T00:00:00`), 'd MMM')
      : `${format(new Date(`${from}T00:00:00`), 'd MMM')} – ${format(new Date(`${to}T00:00:00`), 'd MMM')}`;

  return (
    <div className="space-y-4">
      <StatTile
        label={(t.lvhDossierAwayTpl ?? 'Taken in {n}').replace('{n}', String(year))}
        value={`${d.daysTakenThisYear} ${t.daysWord}`}
        hint={t.lvhCalendarDaysHint}
        icon={CalendarDays}
        color="primary"
      />

      <div className="rounded-xl border border-border/70 bg-card/40 p-4">
        <p className="mb-2 text-xs font-bold uppercase tracking-wider text-foreground">
          {t.leaveBalance} · {t.lvhBalanceRemainingHint}
        </p>
        {(d.balances.length > 0 || d.takenOnly.length > 0) ? (
          <div className="flex flex-wrap gap-2">
            {d.balances.map(b => (
              <div
                key={b.typeId}
                title={b.total != null ? `${b.remaining} remaining of ${b.total} days${b.used != null ? ` (${b.used} used)` : ''}` : undefined}
                className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-1.5 text-xs shadow-2xs"
              >
                <span className="text-muted-foreground">{b.typeName}</span>
                <span className={cn(
                  'rounded-md bg-background px-1.5 py-0.5 font-bold tabular-nums shadow-2xs',
                  b.remaining === 0 ? 'text-warn-strong' : 'text-foreground',
                )}>
                  {b.remaining}
                  {b.total != null && b.total > 0 && (
                    <span className="ml-1 text-[10px] font-normal text-muted-foreground">/{b.total}</span>
                  )}
                </span>
              </div>
            ))}
            {/* Not entitlements — days taken, with no denominator and no remaining figure. The
                heading above this block says "remaining", so the word on the chip is what keeps
                these from being read as part of that claim. */}
            {d.takenOnly.map(b => (
              <div
                key={`taken-${b.typeName}`}
                title={`${b.taken} ${t.takenThisYear.toLowerCase()}`}
                className="flex items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-1.5 text-xs shadow-2xs"
              >
                <span className="text-muted-foreground">{b.typeName}</span>
                <span className="rounded-md bg-background px-1.5 py-0.5 font-bold tabular-nums text-foreground shadow-2xs">
                  {b.taken}
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">{t.takenLabel}</span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t.noData}</p>
        )}
      </div>

      {d.upcoming.length > 0 && (
        <div className="rounded-xl border border-border/70 bg-card/40 p-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-wider text-foreground">{t.upcomingWord}</p>
          <div className="space-y-1.5">
            {d.upcoming.map(l => (
              <div key={l.id} className="flex items-center justify-between text-xs py-1 border-b border-border/30 last:border-0">
                <span className="text-foreground font-medium">
                  {l.leave_type_name} {l.is_half_day && <span className="ml-1 text-[10px] text-muted-foreground">½</span>}
                </span>
                <span className="text-muted-foreground tabular-nums">{range(l.from_date, l.to_date)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {d.pending.length > 0 && (
        <div className="rounded-xl border border-border/70 bg-card/40 p-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-wider text-warning">{t.pending}</p>
          <div className="space-y-1.5">
            {d.pending.map(l => (
              <div key={l.id} className="flex items-center justify-between text-xs py-1 border-b border-border/30 last:border-0">
                <span className="text-foreground font-medium">{l.leave_type_name}</span>
                <span className="text-muted-foreground tabular-nums">{range(l.from_date, l.to_date)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab: Tasks ─────────────────────────────────────────────────────────────────────────────
function TasksBlock({ d, t }: { d?: TaskData; t: ReturnType<typeof useT> }) {
  if (!d) return null;
  const clock = (n?: number | null) => (n ? format(new Date(n), 'd MMM HH:mm') : null);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5">
        <StatTile label={t.openLabel} value={d.open} icon={ListChecks} color="primary" />
        <StatTile label="Overdue" value={d.overdue} icon={Flag} color={d.overdue > 0 ? 'warning' : 'indigo'} />
      </div>

      {d.recent.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t.noData}</p>
      ) : (
        <ul className="space-y-2">
          {d.recent.map(item => (
            <li key={item.key} className="rounded-xl border border-border/70 bg-card/40 p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 flex-1 text-xs font-medium text-foreground line-clamp-2">{item.description}</p>
                <Badge
                  variant={item.status === 'Completed' ? 'success' : item.status === 'Pending' ? 'muted' : 'warning'}
                  className="h-auto shrink-0 px-1.5 py-0 text-[9px] leading-tight"
                >
                  {item.status}
                </Badge>
              </div>
              <p className="mt-1 text-[10px] tabular-nums text-muted-foreground">
                {format(new Date(`${item.date}T00:00:00`), 'd MMM')}
                {clock(item.startedAt) && ` · ${clock(item.startedAt)}`}
                {clock(item.endedAt) && ` → ${clock(item.endedAt)}`}
              </p>
              {item.flag && (
                <p className="mt-1.5 flex items-start gap-1 text-[10px] text-warning">
                  <Flag className="mt-px h-3 w-3 shrink-0" aria-hidden />
                  <span className="min-w-0">
                    {item.flag.kind === 'cannot_start' ? 'Cannot start' : 'Delayed'} — {item.flag.reason}
                    {item.flag.until ? ` (until ${item.flag.until})` : ''}
                  </span>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Tab: Schedule ──────────────────────────────────────────────────────────────────────────
function ScheduleBlock({ d, t }: { d?: ScheduleData; t: ReturnType<typeof useT> }) {
  if (!d) return null;
  if (!d.shifts.length && !d.dayOffs.length) return <p className="text-xs text-muted-foreground">{t.noData}</p>;

  return (
    <div className="space-y-4">
      {d.shifts.length > 0 && (
        <div className="rounded-xl border border-border/70 bg-card/40 p-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-wider text-foreground">{t.shiftRosterTitle}</p>
          <ul className="space-y-1.5">
            {d.shifts.map(s => (
              <li key={s.id} className="flex items-center justify-between gap-2 text-xs py-1 border-b border-border/30 last:border-0">
                <span className="tabular-nums font-semibold text-foreground">{format(new Date(`${s.date}T00:00:00`), 'EEE d MMM')}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.shift_name}</span>
                <span className="shrink-0 tabular-nums text-foreground">{s.start_time}–{s.end_time}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.dayOffs.length > 0 && (
        <div className="rounded-xl border border-border/70 bg-card/40 p-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">Scheduled Day Offs</p>
          <div className="flex flex-wrap gap-1.5">
            {d.dayOffs.map(o => (
              <Badge key={o.id} variant="muted" className="tabular-nums">
                {format(new Date(`${o.date}T00:00:00`), 'EEE d MMM')}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab: Suspense ──────────────────────────────────────────────────────────────────────────
function SuspenseAccountRow({ account }: { account: SuspenseData['accounts'][number] }) {
  const resolved = useResolvedLimit(account.epf_number, account.company_id);
  return (
    <div className="rounded-xl border border-border/70 bg-card/40 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-semibold text-foreground">{account.company_name}</span>
        <span className={cn(
          'shrink-0 text-sm font-bold tabular-nums',
          account.balance < 0 ? 'text-destructive' : 'text-foreground',
        )}>
          {formatSuspenseAmount(account.balance, account.currency)}
        </span>
      </div>
      <LimitHeadroomLine resolved={resolved} balance={account.balance} currency={account.currency} className="mt-1" />
    </div>
  );
}

function SuspenseBlock({ d, t }: { d?: SuspenseData; t: ReturnType<typeof useT> }) {
  if (!d) return null;
  return (
    <div className="space-y-4">
      {d.accounts.map(a => <SuspenseAccountRow key={`${a.epf_number}-${a.company_id}`} account={a} />)}
      <div className="grid grid-cols-2 gap-2.5">
        <StatTile label="Spent this month" value={formatSuspenseAmount(d.spentThisMonth, d.currency)} icon={Wallet} color="primary" />
        <StatTile label="Pending bills" value={d.pendingBills.length} icon={AlertTriangle} color="warning" />
      </div>
      {d.pendingBills.length > 0 && (
        <div className="rounded-xl border border-border/70 bg-card/40 p-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-wider text-foreground">Pending Bills</p>
          <ul className="space-y-1">
            {d.pendingBills.map(b => (
              <li key={b.id} className="flex items-center justify-between gap-2 text-xs py-1 border-b border-border/30 last:border-0">
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{b.shop_name || b.expense_type}</span>
                <span className="shrink-0 font-semibold tabular-nums text-foreground">{formatSuspenseAmount(b.amount, d.currency)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Tab: Food ──────────────────────────────────────────────────────────────────────────────
function FoodBlock({ d, t }: { d?: FoodData; t: ReturnType<typeof useT> }) {
  if (!d) return null;
  if (d.total === 0) return <p className="text-xs text-muted-foreground">{t.noData}</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2.5">
        <StatTile label={t.mealBreakfast} value={d.counts.breakfast} icon={UtensilsCrossed} color="primary" />
        <StatTile label={t.mealLunch} value={d.counts.lunch} icon={UtensilsCrossed} color="success" />
        <StatTile label={t.mealDinner} value={d.counts.dinner} icon={UtensilsCrossed} color="cyan" />
      </div>
      <div className="rounded-xl border border-border/70 bg-card/40 p-4 space-y-2">
        <div className="flex justify-between items-center text-xs">
          <span className="text-muted-foreground">{t.totalMealsLabel}</span>
          <span className="font-bold tabular-nums text-foreground">{d.total}</span>
        </div>
        {d.likelyCost != null && (
          <div className="flex justify-between items-center text-xs border-t border-border/40 pt-2">
            <span className="text-muted-foreground">Likely Cost</span>
            <span className="font-bold tabular-nums text-foreground">{lkr(d.likelyCost)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tab: Payroll ───────────────────────────────────────────────────────────────────────────
function PayrollBlock({ d, t }: { d?: PayrollData; t: ReturnType<typeof useT> }) {
  if (!d) return null;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/40 p-3 text-xs">
        <span className="text-muted-foreground">Pay profile</span>
        <Badge variant={d.hasProfile ? 'success' : 'muted'}>{d.hasProfile ? t.statusActive : t.noWord}</Badge>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <StatTile
          label={t.activeLoansLabel}
          value={d.loans.length}
          hint={d.loanOutstanding > 0 ? lkr(d.loanOutstanding) : undefined}
          icon={Banknote}
          color="primary"
        />
        <StatTile
          label={t.advanceWord}
          value={d.advances.length}
          hint={d.advanceOutstanding > 0 ? lkr(d.advanceOutstanding) : undefined}
          icon={Banknote}
          color="warning"
        />
      </div>
    </div>
  );
}

// ── Tab: Links ─────────────────────────────────────────────────────────────────────────────
function LinksBlock({ caps, features, t }: {
  caps: ReturnType<typeof useUserCapabilities>;
  features: TenantFeatures;
  t: ReturnType<typeof useT>;
}) {
  const admin = caps.is_system_admin;
  const links: Array<{ href: string; label: string; show: boolean }> = [
    { href: '/users', label: t.navUsers, show: routeAllowed('/users', features) && (admin || caps.can_manage_users || caps.can_view_users) },
    { href: '/attendance-view', label: t.attendanceTitle, show: routeAllowed('/attendance-view', features) && (admin || caps.can_view_attendance) },
    { href: '/tasks', label: t.tasksWord, show: routeAllowed('/tasks', features) && (admin || caps.can_view_team_tasks) },
    {
      href: (admin || caps.can_approve_leaves) ? '/leaves?tab=team' : '/leaves',
      label: t.leavesTitle,
      show: routeAllowed('/leaves', features),
    },
  ];
  const visible = links.filter(l => l.show);
  if (!visible.length) return null;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
      {visible.map(l => (
        <Link
          key={l.href}
          href={l.href}
          className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-3 text-xs font-semibold text-foreground transition-all hover:border-primary/40 hover:bg-card/90"
        >
          <span className="flex items-center gap-2">
            <ExternalLink className="h-4 w-4 text-primary" />
            {l.label}
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Link>
      ))}
    </div>
  );
}
