'use client';
// Notification center — bell + panel, extracted from the app-shell layout.
// Feeds (all merged into the persisted notificationsStore with stable ids):
//   · Firestore inbox (direct + approver broadcast) via a live onSnapshot
//   · Solar external feed (polled)
//   · Foreground FCM messages (also deduped against their Firestore doc when present)
// Unlike the old bell, opening the panel does NOT mark everything read: items carry
// real per-item read state (clicking reads one; an explicit button reads all), every
// item deep-links to its page, and all chrome is translated (en/si/ta).

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Bell, CheckCheck, CheckCircle, AlertCircle, CalendarOff, CalendarRange, Edit2, Sun, Clock,
  UserRound, Trash2, ExternalLink, Send, ShieldAlert, UserPlus, PartyPopper, X, ChevronRight,
  ListChecks } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { useAppStore, useT } from '@/store/appStore';
import { tenant } from '@/lib/firebase';
import { useNotificationsStore, type CenterNotif } from '@/store/notificationsStore';
import { useSolarNotifications } from '@/components/useSolarNotifications';
import { onFCMMessage } from '@/services/firebase';
import ComposeNotification from '@/components/ComposeNotification';
import { isHumanSenderName, joinNames } from '@/lib/greetings';
import { openGreeting } from '@/components/greetings/openGreeting';
import ScheduledNotifications from '@/components/ScheduledNotifications';
import GreetingsPanel from '@/components/greetings/GreetingsPanel';
import {
  filterByTab, groupByRecency, tabCounts, visibleTabs,
  type NotifTab, type RecencyGroup,
} from '@/lib/notificationCenter';
import {
  subscribeAppNotifications, markNotificationReadRemote, markManyReadRemote,
  getNotifClearedAt, setNotifClearedAt, getComposeAudience,
} from '@/services/notificationService';

const SOLAR_URL = 'https://solar.altavision.lk';

// Solar level → pill colour classes. Solar's default/success tone is a real, explicit
// green (not `--success`, which resolves to the same blue as `--primary` in this app's
// palette) so Solar items read as visually distinct from regular attendance notifications.
// Warning/error stay on the shared semantic colours — those signal real urgency.
function levelPill(level?: string): string {
  switch ((level ?? '').toLowerCase()) {
    case 'warning': return 'bg-warning/10 text-warning';
    case 'error':
    case 'danger':  return 'bg-destructive/10 text-destructive';
    default:        return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
  }
}

// Notification type → icon + tone.
function typeIcon(type?: string) {
  switch (type) {
    case 'approval_request':
    case 'leave_approved':
    case 'leave_assigned':
    case 'leave_delete_approved':
    case 'edit_approved':   return <CheckCircle className="w-4 h-4 text-success" />;
    case 'leave_rejected':
    case 'leave_delete_rejected':
    case 'edit_rejected':   return <AlertCircle className="w-4 h-4 text-destructive" />;
    case 'leave_delete_request': return <Trash2 className="w-4 h-4 text-brand" />;
    case 'leave_request':
    case 'leave_update':    return <CalendarOff className="w-4 h-4 text-brand" />;
    case 'attendance_edit': return <Edit2 className="w-4 h-4 text-primary" />;
    case 'email_change':    return <UserRound className="w-4 h-4 text-warning" />;
    case 'reminder':        return <Clock className="w-4 h-4 text-primary" />;
    case 'schedule_updated': return <CalendarRange className="w-4 h-4 text-brand" />;
    case 'task_assigned':
    case 'task_status':     return <CheckCircle className="w-4 h-4 text-primary" />;
    case 'logpup_task_assigned': return <ListChecks className="w-4 h-4 text-brand" />;
    case 'task_flagged':    return <AlertCircle className="w-4 h-4 text-warning" />;
    case 'security_alert':      return <ShieldAlert className="w-4 h-4 text-destructive" />;
    case 'registration_pending': return <UserPlus className="w-4 h-4 text-brand" />;
    case 'greeting':        return <PartyPopper className="w-4 h-4 text-brand" />;
    default:                return <AlertCircle className="w-4 h-4 text-warning" />;
  }
}

// Fallback route per type when an item carries no explicit link (legacy pushes).
function typeRoute(type?: string): string {
  switch (type) {
    case 'approval_request':
    case 'attendance_edit': return '/approvals';
    case 'leave_request':
    case 'leave_update':
    case 'leave_assigned':
    case 'leave_approved':
    case 'leave_rejected':
    case 'leave_delete_request':
    case 'leave_delete_approved':
    case 'leave_delete_rejected': return '/leaves';
    case 'edit_approved':
    case 'edit_rejected':
    case 'reminder':        return '/attendance';
    case 'email_change':
    case 'registration_pending': return '/users';
    case 'schedule_updated': return '/my-schedule';
    case 'task_mention':
    case 'task_assigned':
    case 'task_status':
    case 'task_flagged':    return '/tasks';
    default:                return '/dashboard';
  }
}

type T = ReturnType<typeof useT>;

// ── Greetings ─────────────────────────────────────────────────────────────────
// A greeting is the one notification whose whole point is WHO it is from. The names live in
// meta.senders (written by deliverGreeting) and EVERY one of them is named here — the bell
// used to show two and a "+3", which told the reader nothing except that it was hiding
// something. A translated joiner (greetingListAnd) is what makes the full list sayable in
// si/ta; that missing word is why the old line counted instead.
function senderNames(rawSenders: string | undefined, t: T): string {
  if (!rawSenders) return '';
  let list: Array<{ name?: unknown; supervisor?: unknown; role?: unknown }> = [];
  try {
    const v: unknown = JSON.parse(rawSenders);
    list = Array.isArray(v) ? (v as Array<{ name?: unknown; supervisor?: unknown; role?: unknown }>) : [];
  } catch { return ''; }
  const named = list
    .map(s => ({
      name: String(s?.name ?? '').trim(),
      supervisor: s?.supervisor === true,
      role: String(s?.role ?? '').trim(),
    }))
    .filter(s => !!s.name && isHumanSenderName(s.name, s.role));
  if (!named.length) return '';
  // The supervisor leads, same as the push and the card: theirs is the signature that is
  // personal to this reader, so it is the one that must be impossible to miss.
  const ordered = [...named.filter(s => s.supervisor), ...named.filter(s => !s.supervisor)];
  return joinNames(
    ordered.map(s => (s.supervisor ? `${t.greetingYourSupervisor} ${s.name}` : s.name)),
    t.greetingListAnd,
  );
}

// The greeting as the reader should see it: the occasion, their name, and who signed it.
// Falls back to the stored English title/body — which greetingCopy() already wrote with both
// — whenever meta cannot supply a translated equivalent, and only then to a generic line.
function renderGreeting(n: CenterNotif, t: T): { title: string; body: string } {
  const m = n.meta ?? {};
  const name = (m.name ?? '').trim();
  const from = senderNames(m.senders, t);
  const fromLine = from ? `${t.greetingFrom} ${from}` : '';
  switch (m.occasion) {
    case 'birthday':
      return {
        // birthdayGreeting is the one key with a {name} slot, so the reader is greeted by name
        // in their own language. Without a name the stored (named) English line is still better
        // than the nameless generic one.
        title: name ? t.birthdayGreeting.replace('{name}', name) : (n.title || t.greetingBirthdayTitle),
        body: fromLine || n.body || t.greetingBirthdayBody,
      };
    case 'anniversary':
      return {
        // The stored title reads "5 years with us, Nimal!" — it names the person, which the
        // translated key cannot, so it leads. The key covers docs written before meta existed.
        title: n.title || t.greetingAnniversaryTitle.replace('{years}', m.years ?? ''),
        body: fromLine || n.body || t.greetingAnniversaryBody,
      };
    case 'special': {
      const lang = useAppStore.getState().lang;
      let title = m.special_title || n.title;
      let body = m.special_message || fromLine || n.body || t.greetingSpecialBody;
      if (lang === 'si') {
        if (m.special_title_si) title = m.special_title_si;
        if (m.special_message_si) body = m.special_message_si;
      } else if (lang === 'ta') {
        if (m.special_title_ta) title = m.special_title_ta;
        if (m.special_message_ta) body = m.special_message_ta;
      }
      return { title, body };
    }
    default:
      // No meta at all (a foreground push, or a pre-meta doc): the stored copy IS the greeting.
      return { title: n.title || t.greetingBirthdayTitle, body: n.body || t.greetingBirthdayBody };
  }
}

// Render a notification in the viewer's language when the type is known, falling
// back to the stored (English) title/body for foreign items (Solar, unknown pushes).
function renderNotif(n: CenterNotif, t: T): { title: string; body: string } {
  const m = n.meta ?? {};
  const name = n.actorName ?? '';
  const dates = m.from && m.to ? (m.from === m.to ? m.from : `${m.from} → ${m.to}`) : '';
  const join = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(' · ');
  switch (n.type) {
    case 'leave_request':  return { title: t.ntfLeaveRequestTitle.replace('{name}', name), body: join(m.leave_type, dates, m.reason) };
    case 'leave_assigned': return { title: t.ntfLeaveAssignedTitle.replace('{name}', name), body: join(m.leave_type, dates, m.reason) };
    case 'leave_approved': return { title: t.ntfLeaveApprovedTitle, body: join(m.leave_type, dates) };
    case 'leave_rejected': return { title: t.ntfLeaveRejectedTitle, body: join(m.leave_type, dates, m.reason) };
    case 'leave_delete_request':  return { title: t.ntfLeaveDeleteRequestTitle.replace('{name}', name), body: join(m.leave_type, dates, m.reason) };
    case 'leave_delete_approved': return { title: t.ntfLeaveDeleteApprovedTitle, body: join(m.leave_type, dates) };
    case 'leave_delete_rejected': return { title: t.ntfLeaveDeleteRejectedTitle, body: join(m.leave_type, dates, m.reason) };
    case 'attendance_edit': return { title: t.ntfEditRequestTitle.replace('{name}', name), body: join(m.date, m.reason) };
    case 'edit_approved':  return { title: t.ntfEditApprovedTitle, body: m.date ?? n.body };
    case 'edit_rejected':  return { title: t.ntfEditRejectedTitle, body: join(m.date, m.reason) };
    case 'greeting':       return renderGreeting(n, t);
    default:               return { title: n.title, body: n.body };
  }
}

function timeAgo(iso: string, t: T): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60)    return t.justNow;
  if (s < 3600)  return t.minsAgoShort.replace('{n}', String(Math.floor(s / 60)));
  if (s < 86400) return t.hoursAgoShort.replace('{n}', String(Math.floor(s / 3600)));
  return new Date(iso).toLocaleDateString();
}

// Clock time the notification actually arrived. "6m ago" alone can't answer "when did this
// land?" — which matters most for scheduled sends, where the body quotes a target time.
function receivedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Group headers. Which bucket an item falls in is decided by recencyOf() in
// src/lib/notificationCenter.ts (pure, unit-tested); this only names the buckets, in the
// reader's language.
function groupLabel(group: RecencyGroup, t: T): string {
  switch (group) {
    case 'today':     return t.todayWord;
    case 'yesterday': return t.notifYesterday;
    case 'week':      return t.notifThisWeek;
    case 'earlier':   return t.notifEarlier;
  }
}

function tabLabel(tab: NotifTab, t: T): string {
  switch (tab) {
    case 'all':        return t.notifFilterAll;
    case 'unread':     return t.notifFilterUnread;
    case 'approvals':  return t.notifFilterApprovals;
    case 'greetings':  return t.notifFilterGreetings;
  }
}

export default function NotificationCenter() {
  const router = useRouter();
  const t = useT();
  const { user, isAuthenticated, _hasHydrated } = useAuthStore();
  const caps = useUserCapabilities();
  const epf = user?.epf_number ? String(user.epf_number) : '';
  const enabled = _hasHydrated && isAuthenticated && !!user;

  const open = useNotificationsStore(s => s.isOpen);
  const setOpen = useNotificationsStore(s => s.setIsOpen);
  const [tab, setTab] = useState<NotifTab>('all');
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const [isDesktop, setIsDesktop] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia('(min-width: 640px)');
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // Open notification center if URL has ?openNotifications=1 or #notifications
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('openNotifications') === '1' || window.location.hash === '#notifications') {
      setOpen(true);
      params.delete('openNotifications');
      const newSearch = params.toString();
      const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash.replace('#notifications', '');
      window.history.replaceState(null, '', newUrl);
    }
  }, [setOpen]);

  const items = useNotificationsStore(s => s.items);
  const setOwner = useNotificationsStore(s => s.setOwner);
  const upsert = useNotificationsStore(s => s.upsert);
  const markRead = useNotificationsStore(s => s.markRead);
  const markAllReadLocal = useNotificationsStore(s => s.markAllRead);
  const clearAllLocal = useNotificationsStore(s => s.clearAll);
  const setClearedBefore = useNotificationsStore(s => s.setClearedBefore);

  const [composeOpen, setComposeOpen] = useState(false);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [greetingsOpen, setGreetingsOpen] = useState(false);
  // Whether this person may write a notification to anyone at all. The answer depends on the
  // supervisor tree as well as a role capability, so only the server can give it: an executive
  // with reports may message their team without holding can_send_notifications, and gating the
  // button on that flag alone hid the composer from exactly the people it was built for.
  // Asked once, the first time the panel is opened, and kept for the session.
  const [mayCompose, setMayCompose] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled || !open || mayCompose !== null) return;
    let cancelled = false;
    getComposeAudience()
      .then(d => { if (!cancelled) setMayCompose(d.allowed.length > 0); })
      // No composer is the safe answer to "we could not find out".
      .catch(() => { if (!cancelled) setMayCompose(false); });
    return () => { cancelled = true; };
  }, [enabled, open, mayCompose]);

  // Scope the persisted list to the signed-in user (shared browsers).
  useEffect(() => { if (enabled && epf) setOwner(epf); }, [enabled, epf, setOwner]);

  // Pull the durable per-user "cleared" cutoff from the server so a clear on one device/login hides
  // those items everywhere — this is what stops cleared notifications from re-appearing.
  useEffect(() => {
    if (!enabled || !epf) return;
    let cancelled = false;
    getNotifClearedAt(epf).then(iso => { if (!cancelled && iso) setClearedBefore(iso); });
    return () => { cancelled = true; };
  }, [enabled, epf, setClearedBefore]);

  // ── Feed 1: Firestore inbox (direct + broadcast feeds), live ──
  useEffect(() => {
    if (!enabled || !epf) return;
    const audiences = ['all' as const, ...(caps.can_approve ? (['approvers'] as const) : [])];
    const unsub = subscribeAppNotifications(epf, audiences, docs => {
      upsert(docs
        .filter(d => !(d.audience && d.actor_epf === epf))   // hide my own broadcasts
        .map(d => ({
          id: `fs-${d.id}`,
          source: 'app' as const,
          type: d.type,
          title: d.title,
          body: d.body,
          actorName: d.actor_name,
          meta: d.meta,
          link: d.link ?? typeRoute(d.type),
          time: d.created_at?.toDate?.().toISOString() ?? new Date().toISOString(),
          read: d.read && !!d.to_epf,     // server read flag is authoritative for direct docs
          direct: !!d.to_epf,
        })));
    });
    return unsub;
  }, [enabled, epf, caps.can_approve, upsert]);

  // ── Feed 2: Solar external feed (polled) ──
  const { items: solarItems, refetch: refetchSolar } = useSolarNotifications(enabled);
  useEffect(() => {
    if (!solarItems.length) return;
    upsert(solarItems.map(n => ({
      id: `solar-${n.id}`,
      source: 'solar' as const,
      type: n.type ?? n.category ?? 'info',
      title: n.title,
      body: n.message,
      actorName: n.createdByName ?? null,
      meta: (n.recipientType === 'all' ? { broadcast: '1' } : {}) as Record<string, string>,
      link: n.link ? `${SOLAR_URL}${n.link.startsWith('/') ? '' : '/'}${n.link}` : null,
      external: true,
      time: n.createdAt,
      read: n.read,
    })));
  }, [solarItems, upsert]);

  // ── Feed 3: foreground FCM messages (toast + inbox entry) ──
  useEffect(() => {
    if (!enabled) return;
    let seq = 0;
    return onFCMMessage(payload => {
      // Interactive notification popup toast
      toast.custom(
        (tInstance) => (
          <div
            className={`${tInstance.visible ? 'toast-enter' : 'toast-leave'} app-toast-surface pointer-events-auto relative w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border shadow-popover bg-popover text-popover-foreground transition-all active:scale-[0.99]`}
            role="status"
          >
            <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-primary" />
            <div
              onClick={() => {
                toast.dismiss(tInstance.id);
                setOpen(true);
              }}
              className="cursor-pointer flex items-start gap-3 py-3 pl-3.5 pr-2.5 hover:bg-accent/40 transition-colors"
            >
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Bell className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold leading-snug text-foreground">{payload.title}</div>
                {payload.body ? (
                  <div className="mt-0.5 text-xs leading-snug text-muted-foreground line-clamp-2">{payload.body}</div>
                ) : null}
                <div className="mt-1 text-[11px] font-medium text-primary flex items-center gap-0.5">
                  <span>{t.notifications || 'Open Notification Center'}</span>
                  <ChevronRight className="w-3 h-3" />
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toast.dismiss(tInstance.id);
                }}
                aria-label="Dismiss"
                className="-mr-0.5 mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ),
        { duration: 6000 }
      );
      const docId = payload.data?.docId;
      // When the push mirrors a Firestore inbox doc, reuse its id so the snapshot and the push
      // land on the SAME item instead of duplicating it.
      const id = docId ? `fs-${docId}` : `fcm-${Date.now()}-${++seq}`;
      // …and merge onto that item rather than replacing it. A push payload carries no `meta`
      // and no `direct` flag, so a bare upsert over an already-arrived doc threw away the very
      // fields the item is rendered from (a greeting's occasion and signers) and stopped its
      // read state syncing to the server.
      const prev = useNotificationsStore.getState().items.find(i => i.id === id);
      upsert([{
        ...prev,
        id,
        source: 'app',
        type: payload.type ?? prev?.type ?? 'general',
        title: payload.title || prev?.title || '',
        body: payload.body || prev?.body || '',
        link: prev?.link || payload.data?.link || typeRoute(payload.type),
        time: prev?.time ?? new Date().toISOString(),
        read: false,
      }]);
    });
  }, [enabled, setOpen, t.notifications, upsert]);

  // ── Panel open/close behaviour ──
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || contentRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  // The Solar cross-feed is Alta Vision-only (tenant.features.solarApp). On other tenants
  // (e.g. Southern Lanka) drop any 'solar' items — this hides ones already persisted in a
  // user's local store from before the feed was gated, on top of the hook no longer polling.
  const scopedItems = useMemo(
    () => (tenant.features.solarApp ? items : items.filter(i => i.source !== 'solar')),
    [items],
  );

  const unreadCount = scopedItems.reduce((n, i) => n + (i.read ? 0 : 1), 0);

  // Badge the installed app's icon with the unread count. This is the one piece of
  // native-feeling notification surface a PWA can actually reach: iOS 16.4+ supports it for a
  // home-screen-installed app, as do desktop Chrome and Edge. Unsupported browsers simply
  // don't expose the methods, and Safari throws when the app is not installed — hence the
  // capability check and the try/catch. Never load-bearing: the bell is the real indicator.
  useEffect(() => {
    type BadgeNav = Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (typeof navigator === 'undefined') return;
    const nav = navigator as BadgeNav;
    try {
      if (unreadCount > 0) void nav.setAppBadge?.(unreadCount).catch(() => { /* not installed */ });
      else void nav.clearAppBadge?.().catch(() => { /* not installed */ });
    } catch { /* unsupported — nothing to do */ }
  }, [unreadCount]);
  const counts = useMemo(() => tabCounts(scopedItems), [scopedItems]);
  const tabs = useMemo(() => visibleTabs(counts), [counts]);

  // A chip disappears when its last item is read away or cleared. Landing the reader on a tab
  // that is no longer shown leaves them staring at an empty panel with no chip highlighted and
  // nothing to press, so the selection falls back to All.
  useEffect(() => { if (!tabs.includes(tab)) setTab('all'); }, [tabs, tab]);

  const visible = useMemo(() => filterByTab(scopedItems, tab), [scopedItems, tab]);

  // Today / Yesterday / This week / Earlier, empty buckets omitted. `now` is read when the
  // list changes or the panel opens rather than on every render — passing a fresh Date() into
  // a memo on each pass would rebuild the whole list continuously.
  const grouped = useMemo(
    () => groupByRecency(visible, new Date().toISOString()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, open],
  );

  const readOne = (n: CenterNotif) => {
    if (!n.read) {
      markRead(n.id);
      if (n.direct && n.id.startsWith('fs-')) void markNotificationReadRemote(n.id.slice(3));
    }
  };

  // "Clear all" also raises the durable server-side cutoff so those items never come back.
  const clearAll = () => {
    clearAllLocal();
    if (epf) void setNotifClearedAt(epf, new Date().toISOString());
  };

  const openItem = (n: CenterNotif) => {
    readOne(n);
    // A greeting is not a place, so it does not get a navigation: it opens its card, here, on
    // top of whatever page the reader is on. The old click pushed /dashboard?greeting=<id>,
    // which did nothing at all when the reader was already on /dashboard — the router saw a
    // same-page query change and the card's effect never ran. GreetingCard still honours the
    // URL param for a cold open from a push; this is the direct path for a tap in the app.
    if (n.type === 'greeting' && n.id.startsWith('fs-')) {
      setOpen(false);
      openGreeting(n.id.slice(3));
      return;
    }
    // A notification with no link used to be a dead click — the panel just sat there. Fall back
    // to the route its TYPE implies (the same map used when the item is first stored), so every
    // item lands somewhere; only a typeless, linkless item can still do nothing.
    const target = n.link || typeRoute(n.type);
    if (!target) return;
    setOpen(false);
    if (n.external && n.link) { window.open(n.link, '_blank', 'noopener,noreferrer'); return; }
    // Pages that fetch their own data client-side (e.g. Users) only reload it on mount —
    // if you're ALREADY on the target page (common right after a same-tab event like a
    // registration alert), a plain router.push to the same pathname is a no-op and the
    // page never refetches, so newly-arrived data stays invisible. A cache-busting param
    // makes every click a distinct URL, and pages that care read it to force a refetch.
    const sep = target.includes('?') ? '&' : '?';
    router.push(`${target}${sep}_r=${Date.now()}`);
  };

  const markAllRead = () => {
    const remoteIds = items.filter(i => !i.read && i.direct && i.id.startsWith('fs-')).map(i => i.id.slice(3));
    void markManyReadRemote(remoteIds);
    markAllReadLocal();
  };

  // Mark one day-group read. The store has no notion of a group, so this is the same pair of
  // calls markAllRead makes, narrowed to that group's ids — and only the unread ones, so a
  // group already read costs no write at all.
  const markGroupRead = (group: CenterNotif[]) => {
    const unread = group.filter(i => !i.read);
    if (!unread.length) return;
    const remoteIds = unread.filter(i => i.direct && i.id.startsWith('fs-')).map(i => i.id.slice(3));
    void markManyReadRemote(remoteIds);
    unread.forEach(i => markRead(i.id));
  };

  const panelContent = (
    <>
      {/* Header: title + actions */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <Bell className="w-4 h-4 text-primary flex-shrink-0" />
          <span className="text-sm font-semibold text-foreground truncate">{t.notifications}</span>
          {items.length > 0 && <span className="text-[11px] text-muted-foreground">({items.length})</span>}
        </div>
        <div className="flex items-center gap-1">
          {/* Greetings, for everyone. What is inside the panel is decided by who opened
              it — a technician re-opens the cards they were sent, a manager also writes
              notes for the people under them — so the button itself is never gated. */}
          <button onClick={() => setGreetingsOpen(true)} title={t.greetingsPanelTitle} aria-label={t.greetingsPanelTitle}
            className="rounded-md p-1.5 text-muted-foreground hover:text-brand hover:bg-brand/10 transition-colors">
            <PartyPopper className="w-3.5 h-3.5" />
          </button>
          {/* The scheduled-sends list is company-wide, so it stays with the broadcast
              capability. Composing follows the server's answer instead. */}
          {caps.can_send_notifications && (
            <button onClick={() => setScheduledOpen(true)} title="Scheduled notifications" aria-label="Scheduled notifications"
              className="rounded-md p-1.5 text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors">
              <Clock className="w-3.5 h-3.5" />
            </button>
          )}
          {mayCompose && (
            <button onClick={() => setComposeOpen(true)} title="New notification" aria-label="New notification"
              className="rounded-md p-1.5 text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors">
              <Send className="w-3.5 h-3.5" />
            </button>
          )}
          {unreadCount > 0 && (
            <button onClick={markAllRead} title={t.notifMarkAllRead}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors">
              <CheckCheck className="w-3.5 h-3.5" /> {t.notifMarkAllRead}
            </button>
          )}
          {items.length > 0 && (
            <button onClick={clearAll} title={t.notifClearAll} aria-label={t.notifClearAll}
              className="rounded-md p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          {/* Mobile close button */}
          <button
            type="button"
            onClick={() => setOpen(false)}
            title="Close"
            aria-label="Close notifications"
            className="sm:hidden rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ml-0.5"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filter chips. A content chip is absent rather than shown reading zero, and the
          row scrolls sideways so four chips never wrap on a narrow phone. */}
      {items.length > 0 && (
        <div className="flex items-center gap-1.5 px-4 py-2 border-b border-border overflow-x-auto scrollbar-thin">
          {tabs.map(f => (
            <button key={f} onClick={() => setTab(f)} aria-pressed={tab === f}
              className={`flex-shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                tab === f ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}>
              {/* All carries no count — the header beside the title already shows it. */}
              {tabLabel(f, t)}{f !== 'all' && counts[f] ? ` (${counts[f]})` : ''}
            </button>
          ))}
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto scrollbar-thin sm:flex-none sm:max-h-80">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 gap-3">
            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center"><Bell className="w-5 h-5 text-muted-foreground" /></div>
            {/* Per tab: "nothing has ever arrived", "nothing unread" and "nothing in this
                category" are three different facts, and one sentence for all three reads
                as a bug on the two it does not describe. */}
            <div className="text-center px-6">
              <p className="text-sm text-muted-foreground">
                {tab === 'unread' ? t.notifEmptyUnreadTitle
                  : tab === 'all' ? t.notifEmptyTitle
                  : t.notifEmptyTabTitle}
              </p>
              {tab === 'all' && (
                <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t.notifEmptyDesc}</p>
              )}
            </div>
          </div>
        ) : grouped.map(group => (
          <div key={group.group}>
            <div className="flex items-center justify-between gap-2 px-4 pt-2.5 pb-1 bg-popover/50 sticky top-0 backdrop-blur-sm">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                {groupLabel(group.group, t)}
              </span>
              {group.items.some(i => !i.read) && (
                <button type="button" onClick={() => markGroupRead(group.items)}
                  className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10 transition-colors">
                  {t.notifMarkGroupRead}
                </button>
              )}
            </div>
            {group.items.map(n => {
              const solar = n.source === 'solar';
              const { title, body } = renderNotif(n, t);
              return (
                <button key={n.id} type="button" onClick={() => openItem(n)}
                  className={`w-full text-left flex items-start gap-3 px-4 py-3 border-b border-border last:border-0 hover:bg-accent transition-colors ${
                    solar ? 'border-l-2 border-l-emerald-500/70' : ''
                  } ${!n.read ? (solar ? 'bg-emerald-500/5' : 'bg-primary/5') : ''}`}>
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${solar ? levelPill(n.type) : 'border border-border bg-card'}`}>
                    {solar ? <Sun className="w-4 h-4" /> : typeIcon(n.type)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-semibold text-foreground leading-snug line-clamp-1">{title}</span>
                      {!n.read && <div className={`w-2 h-2 rounded-full flex-shrink-0 mt-1 ${solar ? 'bg-emerald-500' : 'bg-primary'}`} aria-hidden />}
                    </div>
                    {(solar || n.meta?.broadcast) && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {solar && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">Solar</span>}
                        {n.meta?.broadcast && <span className="rounded bg-brand/10 px-1.5 py-0.5 text-[9px] font-semibold text-brand">{t.broadcastLabel}</span>}
                      </div>
                    )}
                    {body && <p className="text-[11px] text-muted-foreground mt-1 leading-snug line-clamp-2">{body}</p>}
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="text-[10px] text-muted-foreground/70 truncate" title={new Date(n.time).toLocaleString()}>
                        {[
                          n.actorName && n.type !== 'leave_request' && n.type !== 'leave_assigned' && n.type !== 'leave_delete_request' && n.type !== 'attendance_edit' ? n.actorName : null,
                          timeAgo(n.time, t),
                          receivedAt(n.time),
                        ].filter(Boolean).join(' · ')}
                      </span>
                      {n.external && n.link && (
                        <span className="flex-shrink-0 inline-flex items-center gap-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                          {t.openInSolar} <ExternalLink className="w-2.5 h-2.5" />
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Capability-gated quick links */}
      {(caps.can_approve || caps.is_employee) && items.length > 0 && (
        <div className="px-4 py-2.5 border-t border-border flex gap-3">
          {caps.can_approve && (
            <button onClick={() => { setOpen(false); router.push('/approvals'); }}
              className="flex-1 text-center text-[11px] font-medium text-primary hover:text-primary/80 transition-colors py-1">{t.approvals}</button>
          )}
          {caps.is_employee && (
            <button onClick={() => { setOpen(false); router.push('/attendance'); }}
              className="flex-1 text-center text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors py-1">{t.attendance}</button>
          )}
        </div>
      )}
    </>
  );

  if (!enabled) return null;

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => { const next = !open; setOpen(next); if (next) void refetchSolar(); }}
        aria-label={t.notifications}
        aria-expanded={open}
        className="w-9 h-9 rounded-lg border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground relative transition-colors"
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-0.5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Desktop dropdown popover (anchored under bell button) */}
      {isDesktop && (
        <AnimatePresence>
          {open && (
            <motion.div
              ref={contentRef}
              initial={{ opacity: 0, y: -8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.96 }} transition={{ duration: 0.15 }}
              role="dialog" aria-label={t.notifications}
              className="absolute right-0 top-11 w-[min(24rem,calc(100vw-1.5rem))] flex flex-col bg-popover text-popover-foreground rounded-xl border border-border shadow-popover z-[100] overflow-hidden"
            >
              {panelContent}
            </motion.div>
          )}
        </AnimatePresence>
      )}

      {/* Mobile sheet modal portalled to document.body (escapes header backdrop-blur containment) */}
      {mounted && !isDesktop && createPortal(
        <AnimatePresence>
          {open && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                onClick={() => setOpen(false)}
                aria-hidden="true"
                className="fixed inset-0 bg-black/60 backdrop-blur-xs z-[99]"
              />
              <motion.div
                ref={contentRef}
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 16, scale: 0.96 }}
                transition={{ duration: 0.2 }}
                role="dialog"
                aria-label={t.notifications}
                className="fixed inset-x-2.5 top-[calc(env(safe-area-inset-top,0px)+3.75rem)] bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)] flex flex-col bg-popover text-popover-foreground rounded-2xl border border-border shadow-2xl z-[100] overflow-hidden"
              >
                {panelContent}
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body
      )}

      {mayCompose && <ComposeNotification open={composeOpen} onClose={() => setComposeOpen(false)} />}
      {caps.can_send_notifications && (
        <ScheduledNotifications open={scheduledOpen} onClose={() => setScheduledOpen(false)} />
      )}

      <GreetingsPanel open={greetingsOpen} onClose={() => setGreetingsOpen(false)} />
    </div>
  );
}
