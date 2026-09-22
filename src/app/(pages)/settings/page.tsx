'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Bell, BellRing, BellOff, Smartphone, Sun, Moon, Monitor, Languages, Check, Clock,
  LogIn, LogOut, MapPin, Navigation, Send, Settings as SettingsIcon, AlertTriangle, KeyRound, Loader2,
} from 'lucide-react';
import { useAppStore, useT, type Theme, type Lang } from '@/store/appStore';
import { animateThemeChange } from '@/lib/themeTransition';
import { useUserCapabilities } from '@/store/rolesStore';
import { useWorkingPlaces } from '@/store/workingPlacesStore';
import { useAuthStore } from '@/store/authStore';
import { getUserByEpf, updateUser } from '@/services/userService';
import { hasApprovalPin, setApprovalPin } from '@/services/suspenseService';
import { tenant } from '@/lib/firebase';
import { parseGoogleMapsLink, decodePlusCode, isValidLatLng, mapsLink, requestDeviceLocation } from '@/lib/geo';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { PageHeader } from '@/components/ui/page-header';
import { PageHeaderSkeleton, SkeletonCard, Skeleton } from '@/components/ui/Skeleton';
import { PageTransition, Reveal } from '@/components/ui/motion';
import toast from 'react-hot-toast';
import { useBrandName } from '@/lib/brand';

function getSetting<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try { const v = localStorage.getItem(key); return v !== null ? JSON.parse(v) as T : fallback; }
  catch { return fallback; }
}

interface Geofence { name: string; lat: number; lng: number; radius: number | null; }

interface NotifPrefs {
  attendance:        boolean;
  leaves:            boolean;
  approvals:         boolean;
  reminders_enabled: boolean;
  checkin_time:      string;
  checkout_time:     string;
  location_enabled:  boolean;
  location_radius:   number;        // metres — global fallback when a site has no own radius
  geofences:         Geofence[];    // resolved from the SELECTED working places that have GPS set
  selected_places?:  string[];      // keys (id||name) of sites the user chose; undefined = all
  location_lat?:     number | null; // legacy single office (kept so old saved prefs still parse)
  location_lng?:     number | null;
}

const DEFAULT_PREFS: NotifPrefs = {
  attendance:        true,
  leaves:            true,
  approvals:         true,
  reminders_enabled: false,
  checkin_time:      '08:30',
  checkout_time:     '17:30',
  location_enabled:  false,
  location_radius:   300,
  geofences:         [],
};

function getNotifPrefs(): NotifPrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  return { ...DEFAULT_PREFS, ...getSetting<Partial<NotifPrefs>>('notif-prefs', {}) };
}

type Perm = NotificationPermission | 'unsupported';

export default function SettingsPage() {
  const brand = useBrandName();
  const { theme, lang, setTheme, setLang } = useAppStore();
  const t = useT();
  const caps = useUserCapabilities();
  const noAttendance = !caps.has_attendance;  // only System Admin has no attendance
  // Southern Lanka clocks in/out on fingerprint/face terminals against a shift, not a fixed
  // daily schedule — a "remind me to check in at 08:30" doesn't mean anything when the shift
  // itself decides that. Their working places have no GPS set either (see the attendance edit
  // form's matching comment), so the location-reminder half of this card has nothing to offer
  // them either — the whole Daily Reminders card is skipped, not just the time pickers in it.
  const isSouthernlanka = tenant.id === 'southernlanka';
  const { options: workingPlaceOptions } = useWorkingPlaces();

  // The real GPS-enabled working places drive the location reminders. They come from the
  // cached working-places store (persisted) — so this costs no extra API calls at 300+ users.
  const gpsPlaces = workingPlaceOptions.filter(o => o.latitude != null && o.longitude != null);

  // ── Executive home location (PRIVATE — only the owner ever reads/edits it) ──
  const { user } = useAuthStore();
  const isExec = caps.can_approve;   // WFH + outstation-from-home are executives only
  const [home, setHome] = useState<{ lat: number; lng: number } | null>(null);
  const [homeInput, setHomeInput] = useState('');
  const [homeSaving, setHomeSaving] = useState(false);
  const [homeLocating, setHomeLocating] = useState(false);
  useEffect(() => {
    if (!isExec || !user?.epf_number) return;
    getUserByEpf(user.epf_number).then(u => {
      if (u?.home_lat != null && u?.home_lng != null) setHome({ lat: u.home_lat, lng: u.home_lng });
    }).catch(() => {});
  }, [isExec, user?.epf_number]);
  const saveHome = async () => {
    if (!user?.epf_number) return;
    const parsed = parseGoogleMapsLink(homeInput) ?? decodePlusCode(homeInput);   // "lat,lng" / Maps link / Plus Code
    if (!parsed || !isValidLatLng(parsed.lat, parsed.lng)) { toast.error(t.homeInvalid); return; }
    setHomeSaving(true);
    try {
      await updateUser(user.epf_number, { home_lat: parsed.lat, home_lng: parsed.lng });
      setHome({ lat: parsed.lat, lng: parsed.lng }); setHomeInput('');
      toast.success(t.homeSaved);
    } catch { toast.error(t.failedToSave); }
    finally { setHomeSaving(false); }
  };
  // Capture the device's current GPS fix and save it straight as home.
  const useCurrentHome = async () => {
    if (!user?.epf_number) return;
    setHomeLocating(true);
    try {
      const r = await requestDeviceLocation({ timeoutMs: 12_000 });
      if (!r.ok) { toast.error(r.reason); return; }
      if (!isValidLatLng(r.lat, r.lng)) { toast.error(t.homeInvalid); return; }
      await updateUser(user.epf_number, { home_lat: r.lat, home_lng: r.lng });
      setHome({ lat: r.lat, lng: r.lng }); setHomeInput('');
      toast.success(t.homeSaved);
    } catch { toast.error(t.failedToSave); }
    finally { setHomeLocating(false); }
  };
  const clearHome = async () => {
    if (!user?.epf_number) return;
    setHomeSaving(true);
    try {
      await updateUser(user.epf_number, { home_lat: null, home_lng: null, home_label: null });
      setHome(null); toast.success(t.homeRemoved);
    } catch { toast.error(t.failedToSave); }
    finally { setHomeSaving(false); }
  };

  // ── Approval PIN (suspense approvers only — required to approve credit requests) ──
  const canApproveSuspense = tenant.features.suspense && caps.can_approve_suspense;
  const [pinSet, setPinSet]       = useState(false);
  const [pin1, setPin1]           = useState('');
  const [pin2, setPin2]           = useState('');
  const [pinSaving, setPinSaving] = useState(false);
  useEffect(() => {
    if (!canApproveSuspense || !user?.epf_number) return;
    hasApprovalPin(user.epf_number).then(setPinSet).catch(() => {});
  }, [canApproveSuspense, user?.epf_number]);
  const savePin = async () => {
    if (!user?.epf_number) return;
    if (pin1.length !== 4) { toast.error('Enter a 4-digit PIN.'); return; }
    if (pin1 !== pin2) { toast.error('PINs don’t match.'); return; }
    setPinSaving(true);
    try {
      await setApprovalPin(user.epf_number, pin1);
      setPinSet(true); setPin1(''); setPin2('');
      toast.success('Approval PIN saved.');
    } catch (e) { toast.error(e instanceof Error && e.message ? e.message : 'Failed to save PIN.'); }
    finally { setPinSaving(false); }
  };

  const [notifs, setNotifs] = useState<NotifPrefs>(DEFAULT_PREFS);
  const [mounted, setMounted] = useState(false);
  const [perm, setPerm] = useState<Perm>('default');
  const [enabling, setEnabling] = useState(false);

  useEffect(() => {
    const loaded = getNotifPrefs();
    // The card above is hidden for Southern Lanka, so there is no toggle left to turn this
    // off with — a device where it was already on from before this tenant is shift-based (or
    // from testing) would otherwise keep firing fixed-time reminders forever with no UI to
    // reach. Clear it once, the same way the (now invisible) toggle itself would.
    if (isSouthernlanka && loaded.reminders_enabled) {
      const cleared = { ...loaded, reminders_enabled: false };
      setNotifs(cleared);
      import('@/services/reminderScheduler').then(({ updateReminderPrefs }) => updateReminderPrefs(cleared));
    } else {
      setNotifs(loaded);
    }
    setMounted(true);
    if (typeof window !== 'undefined') setPerm('Notification' in window ? Notification.permission : 'unsupported');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveNotifs = (next: NotifPrefs) => {
    setNotifs(next);
    import('@/services/reminderScheduler').then(({ updateReminderPrefs }) => updateReminderPrefs(next));
  };

  // A site's stable key (id when present, else name) — used for selection membership.
  const placeKey = (p: (typeof gpsPlaces)[number]) => p.id || p.name;
  const allKeys  = useMemo(() => gpsPlaces.map(placeKey), [gpsPlaces]);
  // undefined selected_places = "all sites" (legacy prefs + sensible default on first enable).
  const selectedKeys = notifs.selected_places ?? allKeys;
  const isSel = (p: (typeof gpsPlaces)[number]) => selectedKeys.includes(placeKey(p));

  // Build the geofence snapshot from ONLY the selected GPS sites (what the SW checks).
  const geofencesFor = useCallback((keys: string[]): Geofence[] =>
    gpsPlaces
      .filter(p => keys.includes(p.id || p.name))
      .map(p => ({ name: p.name, lat: p.latitude as number, lng: p.longitude as number, radius: p.radius_m ?? null })),
    [gpsPlaces]);

  const handleToggle = (key: keyof Pick<NotifPrefs, 'attendance' | 'leaves' | 'approvals' | 'reminders_enabled'>) => {
    saveNotifs({ ...notifs, [key]: !notifs[key] });
  };

  const handleTime = (key: 'checkin_time' | 'checkout_time', val: string) => {
    saveNotifs({ ...notifs, [key]: val });
  };

  const resetTimes = () => {
    saveNotifs({ ...notifs, checkin_time: DEFAULT_PREFS.checkin_time, checkout_time: DEFAULT_PREFS.checkout_time });
    toast.success(t.remindersReset);
  };

  const toggleLocation = () => {
    const on = !notifs.location_enabled;
    const keys = notifs.selected_places ?? allKeys;   // default to all sites on first enable
    saveNotifs({
      ...notifs,
      location_enabled: on,
      selected_places:  on ? keys : notifs.selected_places,
      geofences:        on ? geofencesFor(keys) : [],
    });
  };

  // Toggle whether a single site triggers reminders.
  const togglePlace = (p: (typeof gpsPlaces)[number]) => {
    const key  = placeKey(p);
    const cur  = notifs.selected_places ?? allKeys;
    const next = cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key];
    saveNotifs({ ...notifs, selected_places: next, geofences: geofencesFor(next) });
  };

  const handleRadius = (val: number) => {
    const keys = notifs.selected_places ?? allKeys;
    saveNotifs({ ...notifs, location_radius: val, geofences: notifs.location_enabled ? geofencesFor(keys) : notifs.geofences });
  };

  // Keep saved geofences in sync when the working-places list changes while enabled,
  // pruning any selected keys whose site was deleted.
  useEffect(() => {
    if (!mounted || !notifs.location_enabled) return;
    const keys = (notifs.selected_places ?? allKeys).filter(k => allKeys.includes(k));
    const gf   = geofencesFor(keys);
    const pruned = notifs.selected_places && keys.length !== notifs.selected_places.length;
    if (pruned || JSON.stringify(gf) !== JSON.stringify(notifs.geofences)) {
      saveNotifs({ ...notifs, selected_places: notifs.selected_places ? keys : notifs.selected_places, geofences: gf });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, notifs.location_enabled, gpsPlaces.length]);

  // Dynamic platform-aware warning: web geofencing can't run in the true background,
  // and iOS is the strictest. Detected after mount to avoid SSR hydration mismatch.
  const platform: 'ios' | 'android' | 'desktop' = useMemo(() => {
    if (typeof navigator === 'undefined') return 'desktop';
    const ua = navigator.userAgent || '';
    const isIOS = /iPhone|iPad|iPod/i.test(ua)
      || (/Macintosh/i.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
    if (isIOS) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    return 'desktop';
  }, []);
  const platformWarning = platform === 'ios' ? t.reminderWarnIos
    : platform === 'android' ? t.reminderWarnAndroid
    : t.reminderWarnDesktop;

  // Enable push on THIS device: request permission + register the FCM token, then verify.
  const enablePush = async () => {
    if (typeof window === 'undefined') return;
    setEnabling(true);
    try {
      const { setupFCM } = await import('@/services/firebase');
      await setupFCM();
      const p: Perm = 'Notification' in window ? Notification.permission : 'unsupported';
      setPerm(p);
      if (p === 'granted')     toast.success(t.notifEnabledToast);
      else if (p === 'denied') toast.error(t.notifBlockedToast);
    } catch { toast.error(t.notifEnableFailed); }
    setEnabling(false);
  };

  // Fire a one-off notification so the user can confirm the PWA delivers them.
  const sendTest = async () => {
    const { sendTestNotification } = await import('@/services/reminderScheduler');
    const ok = await sendTestNotification(brand, t.testNotifBody);
    if (ok) toast.success(t.testNotifSent); else toast.error(t.notifBlockedToast);
  };

  const handleTheme = (th: Theme) => animateThemeChange(th, setTheme);
  const handleLang = (l: Lang) => {
    setLang(l);
    const msg = l === 'en' ? 'Language set to English'
      : l === 'si' ? 'භාෂාව සිංහලට සකසා ඇත'
      : 'மொழி தமிழாக அமைக்கப்பட்டது';
    toast.success(msg);
  };

  const themeOptions: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: 'dark',   label: t.dark,   icon: Moon    },
    { value: 'light',  label: t.light,  icon: Sun     },
    { value: 'system', label: t.system, icon: Monitor },
  ];

  const generalNotifs: { key: 'attendance' | 'leaves' | 'approvals'; label: string; desc: string }[] = [
    { key: 'attendance', label: t.attendanceNotif, desc: t.attendanceNotifDesc },
    { key: 'leaves',     label: t.leavesNotif,     desc: t.leavesNotifDesc     },
    { key: 'approvals',  label: t.approvalsNotif,  desc: t.approvalsNotifDesc  },
  ];

  if (!mounted) {
    return (
      <div className="space-y-6 max-w-2xl">
        <PageHeaderSkeleton />
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonCard key={i} className="space-y-4">
            <div className="flex items-center gap-3">
              <Skeleton className="h-8 w-8 rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
            <Skeleton className="h-12 w-full rounded-md" />
            <Skeleton className="h-12 w-full rounded-md" />
          </SkeletonCard>
        ))}
      </div>
    );
  }

  return (
    <PageTransition className="space-y-6 max-w-2xl">
      <PageHeader title={t.settingsTitle} description={t.settingsDesc} icon={SettingsIcon} />

      {/* ── Appearance ─────────────────────────────────────────────── */}
      <Reveal delay={0.05}>
        <Card>
          <CardHeader className="flex-row items-center gap-2.5 space-y-0">
            <div className="w-9 h-9 rounded-lg bg-brand/10 flex items-center justify-center shrink-0">
              <Sun className="w-4 h-4 text-brand" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-sm">{t.themeTitle}</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">{t.themeDesc}</p>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-3">
              {themeOptions.map(opt => (
                <button key={opt.value} onClick={() => handleTheme(opt.value)}
                  className={`relative flex flex-col items-center gap-2 py-4 rounded-md border transition-all ${
                    theme === opt.value
                      ? 'bg-brand/10 border-brand/40 text-brand'
                      : 'bg-card border-border text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}>
                  <opt.icon className="w-5 h-5" />
                  <span className="text-xs font-medium">{opt.label}</span>
                  {theme === opt.value && (
                    <div className="absolute top-2 right-2 w-4 h-4 rounded-full bg-brand flex items-center justify-center">
                      <Check className="w-2.5 h-2.5 text-brand-foreground" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </Reveal>

      {/* ── Language ───────────────────────────────────────────────── */}
      <Reveal delay={0.1}>
        <Card>
          <CardHeader className="flex-row items-center gap-2.5 space-y-0">
            <div className="w-9 h-9 rounded-lg bg-success/10 flex items-center justify-center shrink-0">
              <Languages className="w-4 h-4 text-success" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-sm">{t.languageTitle}</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">{t.languageDesc}</p>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {([
                ['en', t.english, 'EN', 'English'],
                ['si', t.sinhala, 'සි', 'Sinhala'],
                ['ta', t.tamil,   'த',  'Tamil'],
              ] as [Lang, string, string, string][]).map(([code, label, badge, sub]) => (
                <button key={code} onClick={() => handleLang(code)}
                  className={`flex items-center gap-3 px-4 py-3.5 rounded-md border transition-all ${
                    lang === code
                      ? 'bg-success/10 border-success/40 text-success'
                      : 'bg-card border-border text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}>
                  <div className={`w-9 h-9 rounded-md flex items-center justify-center text-sm font-bold flex-shrink-0 ${
                    lang === code ? 'bg-success/20 text-success' : 'bg-muted text-muted-foreground'
                  }`}>{badge}</div>
                  <div className="text-left">
                    <div className="text-sm font-medium">{label}</div>
                    <div className="text-[11px] text-muted-foreground">{sub}</div>
                  </div>
                  {lang === code && <Check className="w-4 h-4 ml-auto flex-shrink-0" />}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </Reveal>

      {/* ── Home location (executives only — PRIVATE to you) ──────────── */}
      {isExec && (
      <Reveal delay={0.12}>
        <Card>
          <CardHeader className="flex-row items-center gap-2.5 space-y-0">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
              <MapPin className="w-[18px] h-[18px] text-primary" />
            </div>
            <div>
              <CardTitle className="text-sm">{t.homeLocationTitle}</CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">{t.homePrivateNote}</p>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">{t.homeLocationDesc}</p>
            {home && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2">
                <a href={mapsLink(home.lat, home.lng)} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-success min-w-0">
                  <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">{home.lat.toFixed(5)}, {home.lng.toFixed(5)}</span>
                </a>
                <Button variant="ghost" size="sm" onClick={clearHome} disabled={homeSaving} className="h-auto py-1 text-xs text-destructive">{t.removeWord}</Button>
              </div>
            )}
            {/* Column on mobile — squeezed flex-1 beside a fixed-width Save button left too
                little room for the 34-character placeholder ("Maps link, Plus Code, or lat,
                lng"), which just clips (placeholders never wrap). Full card width on its own
                line fits it comfortably; back to inline from sm: up where there's room. */}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input value={homeInput} onChange={e => setHomeInput(e.target.value)} placeholder={t.homePlaceholder} className="flex-1" />
              <Button onClick={saveHome} disabled={homeSaving || homeLocating || !homeInput.trim()}>{t.save}</Button>
            </div>
            <Button
              variant="outline"
              onClick={useCurrentHome}
              disabled={homeSaving || homeLocating}
              className="w-full"
            >
              {homeLocating
                ? <div className="w-4 h-4 border-2 border-primary/40 border-t-primary rounded-full animate-spin" />
                : <Navigation className="w-4 h-4" />}
              {homeLocating ? t.locatingWord : t.useMyLocation}
            </Button>
          </CardContent>
        </Card>
      </Reveal>
      )}

      {/* ── Approval PIN (suspense approvers only) ──────────────────── */}
      {canApproveSuspense && (
      <Reveal delay={0.13}>
        <Card>
          <CardHeader className="flex-row items-center gap-2.5 space-y-0">
            <div className="w-9 h-9 rounded-lg bg-warning/10 flex items-center justify-center flex-shrink-0">
              <KeyRound className="w-[18px] h-[18px] text-warning" />
            </div>
            <div>
              <CardTitle className="text-sm">Approval PIN</CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">Required to approve suspense credit requests.</p>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {pinSet && (
              <div className="flex items-center gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-xs text-success">
                <Check className="w-3.5 h-3.5" /> A PIN is set — enter it to approve credit requests.
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground font-medium block mb-1">{pinSet ? 'New PIN' : 'PIN'}</Label>
                <Input type="password" inputMode="numeric" maxLength={4} value={pin1}
                  onChange={e => setPin1(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground font-medium block mb-1">Confirm PIN</Label>
                <Input type="password" inputMode="numeric" maxLength={4} value={pin2}
                  onChange={e => setPin2(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••" />
              </div>
            </div>
            <Button size="sm" disabled={pinSaving || pin1.length !== 4 || pin1 !== pin2} onClick={savePin}>
              {pinSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : (pinSet ? 'Update PIN' : 'Set PIN')}
            </Button>
          </CardContent>
        </Card>
      </Reveal>
      )}

      {/* ── Notifications ──────────────────────────────────────────── */}
      <Reveal delay={0.15}>
        <Card>
          <CardHeader className="flex-row items-center gap-2.5 space-y-0">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Bell className="w-4 h-4 text-primary" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-sm">{t.notifications}</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">{t.notifDesc}</p>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* ── Per-device push status: enable + verify it reaches the phone ── */}
            {perm === 'granted' ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-success/20 bg-success/10 p-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <BellRing className="w-4 h-4 text-success shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-success">{t.notifEnabledOnDevice}</div>
                    <div className="text-[11px] text-muted-foreground">{t.pushHint}</div>
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={sendTest} className="shrink-0 gap-1.5">
                  <Send className="w-3.5 h-3.5" />{t.sendTestBtn}
                </Button>
              </div>
            ) : perm === 'denied' ? (
              <div className="flex items-start gap-2.5 rounded-xl border border-destructive/20 bg-destructive/10 p-3">
                <BellOff className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-destructive">{t.notifBlocked}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{t.notifBlockedHelp}</div>
                </div>
              </div>
            ) : perm === 'unsupported' ? (
              <div className="flex items-center gap-2.5 rounded-xl border border-border bg-muted p-3">
                <BellOff className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="text-sm text-muted-foreground">{t.notifUnsupported}</div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/10 p-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Smartphone className="w-4 h-4 text-primary shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{t.enableOnThisDevice}</div>
                    <div className="text-[11px] text-muted-foreground">{t.pushHint}</div>
                  </div>
                </div>
                <Button size="sm" onClick={enablePush} disabled={enabling} className="shrink-0 gap-1.5">
                  <Bell className="w-3.5 h-3.5" />{t.enableBtn}
                </Button>
              </div>
            )}

            {/* ── Per-type preferences ── */}
            <div className="divide-y divide-border border-t border-border pt-1">
              {generalNotifs.map(item => (
                <div key={item.key}
                  className="flex items-center justify-between gap-4 py-3 last:pb-0">
                  <div className="min-w-0">
                    <Label className="text-sm font-medium text-foreground">{item.label}</Label>
                    <div className="text-xs text-muted-foreground mt-0.5">{item.desc}</div>
                  </div>
                  <Switch checked={notifs[item.key] as boolean} onCheckedChange={() => handleToggle(item.key)} />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </Reveal>

      {/* ── Daily Reminders — hidden for non-attendance users (System Admin) and for Southern
          Lanka, whose shift-based fingerprint/face attendance has no fixed daily time or GPS
          site for this card's reminders to be set against. ── */}
      {!noAttendance && !isSouthernlanka && (
      <Reveal delay={0.2}>
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Clock className="w-4 h-4 text-primary" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-sm">{t.reminders}</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">{t.dailyRemindersDesc}</p>
              </div>
            </div>
            <Switch checked={notifs.reminders_enabled} onCheckedChange={() => handleToggle('reminders_enabled')} />
          </CardHeader>

          <AnimatePresence initial={false}>
            {notifs.reminders_enabled && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <CardContent className="space-y-4">
                  <Separator />
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-xs text-muted-foreground font-medium">{t.reminderTimes}</span>
                    <Button variant="link" size="sm" onClick={resetTimes} className="h-auto p-0 text-[11px]">
                      {t.resetToDefault}
                    </Button>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    {/* Check-in time */}
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-md bg-success/10 flex items-center justify-center flex-shrink-0">
                        <LogIn className="w-3.5 h-3.5 text-success" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <Label className="text-xs text-muted-foreground font-medium block mb-1">{t.checkinReminder}</Label>
                        <Input
                          type="time"
                          value={notifs.checkin_time}
                          onChange={e => handleTime('checkin_time', e.target.value)}
                          className="w-full"
                        />
                      </div>
                    </div>

                    {/* Check-out time */}
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-md bg-destructive/10 flex items-center justify-center flex-shrink-0">
                        <LogOut className="w-3.5 h-3.5 text-destructive" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <Label className="text-xs text-muted-foreground font-medium block mb-1">{t.checkoutReminder}</Label>
                        <Input
                          type="time"
                          value={notifs.checkout_time}
                          onChange={e => handleTime('checkout_time', e.target.value)}
                          className="w-full"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Location reminders — driven by your real GPS-enabled working places */}
                  <div className="rounded-xl bg-muted border border-border p-4 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-7 h-7 rounded-md bg-brand/10 flex items-center justify-center flex-shrink-0">
                          <Navigation className="w-3.5 h-3.5 text-brand" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground">{t.locationReminderTitle}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{t.locationReminderDesc}</div>
                        </div>
                      </div>
                      <Switch
                        checked={notifs.location_enabled}
                        onCheckedChange={toggleLocation}
                        disabled={gpsPlaces.length === 0}
                      />
                    </div>

                    {gpsPlaces.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground">{t.noGpsSites}</p>
                    ) : (
                      <AnimatePresence initial={false}>
                        {notifs.location_enabled && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                          >
                            <div className="space-y-3 pt-1">
                              {/* Dynamic, platform-aware limitation warning */}
                              <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
                                <AlertTriangle className="w-3.5 h-3.5 text-warning flex-shrink-0 mt-0.5" />
                                <p className="text-[11px] text-warning leading-snug">{platformWarning}</p>
                              </div>

                              {/* Sites that trigger reminders — tap to choose which ones */}
                              <div>
                                <Label className="text-[11px] text-muted-foreground font-medium block mb-1">{t.yourWorkSites}</Label>
                                <p className="text-[10px] text-muted-foreground/70 mb-1.5">{t.tapSitesToChoose}</p>
                                <div className="flex flex-wrap gap-1.5">
                                  {gpsPlaces.map(p => {
                                    const on = isSel(p);
                                    return (
                                      <button
                                        key={p.id || p.name}
                                        type="button"
                                        onClick={() => togglePlace(p)}
                                        aria-pressed={on}
                                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                                          on
                                            ? 'border-brand/40 bg-brand/10 text-foreground'
                                            : 'border-border bg-transparent text-muted-foreground opacity-60 hover:opacity-100'
                                        }`}
                                      >
                                        {on
                                          ? <Check className="w-3 h-3 text-brand flex-shrink-0" />
                                          : <MapPin className="w-3 h-3 flex-shrink-0" />}
                                        <span className="truncate max-w-[140px]">{p.name}</span>
                                        <span className="text-muted-foreground">{p.radius_m ?? notifs.location_radius} m</span>
                                      </button>
                                    );
                                  })}
                                </div>
                                {selectedKeys.length === 0 && (
                                  <p className="text-[11px] text-warning mt-1.5">{t.pickAtLeastOneSite}</p>
                                )}
                              </div>

                              {/* Global radius (applies to sites without their own) */}
                              <div>
                                <div className="flex items-center justify-between mb-1.5">
                                  <Label className="text-xs text-muted-foreground font-medium">{t.areaRange}</Label>
                                  <span className="text-xs font-semibold text-brand">{notifs.location_radius} m</span>
                                </div>
                                <input
                                  type="range"
                                  min={100} max={1000} step={50}
                                  value={notifs.location_radius}
                                  onChange={e => handleRadius(Number(e.target.value))}
                                  className="w-full accent-brand cursor-pointer"
                                />
                                <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
                                  <span>100 m</span>
                                  <span>500 m</span>
                                  <span>1000 m</span>
                                </div>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    )}
                  </div>
                </CardContent>
              </motion.div>
            )}
          </AnimatePresence>
        </Card>
      </Reveal>
      )}
    </PageTransition>
  );
}
