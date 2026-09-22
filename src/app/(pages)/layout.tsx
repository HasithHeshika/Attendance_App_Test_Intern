'use client';
import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence, useReducedMotion, type Transition } from 'framer-motion';
import {
  Settings, User, LogOut, Menu, X, Zap, Shield,
  Building2, ChevronRight, ShieldCheck, Check,
} from 'lucide-react';
import PWAInstallBanner from '@/components/PWAInstallBanner';
import UpdateNotificationBanner from '@/components/UpdateNotificationBanner';
import LocationOffBanner from '@/components/LocationOffBanner';
import PullToRefresh from '@/components/PullToRefresh';
import BottomNav, { BOTTOM_NAV_MAX } from '@/components/BottomNav';
import SidebarVersion from '@/components/SidebarVersion';
import GreetingCard from '@/components/GreetingCard';
import SolarAppButton from '@/components/SolarAppButton';
import GetAppButton from '@/components/GetAppButton';
import LogPupAppButton from '@/components/LogPupAppButton';
import NotificationCenter from '@/components/NotificationCenter';
import ThemeToggle from '@/components/ThemeToggle';
import AuthProvider from '@/components/AuthProvider';
import { useBrandName, splitBrandName } from '@/lib/brand';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { useCompanyContext } from '@/store/companyContextStore';
import Select from '@/components/Select';
import { useSidebarNav, MANAGEMENT_PATHS, type NavItem } from '@/components/useSidebarNav';
import { useIsPlatformAdmin } from '@/components/usePlatformAdmin';
import { useT } from '@/store/appStore';
import { useLanyardStore } from '@/store/lanyardStore';
import { signOut } from 'firebase/auth';
import { auth, tenant } from '@/lib/firebase';
import { isPathEnabled } from '@/lib/tenants';
import toast from 'react-hot-toast';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { userScopedAvatar } from '@/lib/avatarCache';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const isEmployeeOnlyPath = (p: string) =>
  p === '/dashboard' || p.startsWith('/dashboard/') ||
  p === '/attendance' || p.startsWith('/attendance/');

// Which admin sidebar sections the user has collapsed. Only the CLOSED ids are stored, so
// a first-time (or storage-less) client falls back to everything open rather than to a
// sidebar that looks empty. Storage access itself throws in private windows and some
// embedded browsers — a failure just means the preference lasts this session only.
const NAV_COLLAPSE_KEY = 'sidebar-collapsed-nav-groups';
function readCollapsedGroups(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(NAV_COLLAPSE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch { return []; }
}
function writeCollapsedGroups(ids: string[]) {
  try { window.localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify(ids)); } catch { /* storage blocked */ }
}

// Role → badge tone. Trainee = violet (brand), approver = amber (warning), employee = blue (primary).
function roleTone(isTrainee: boolean, canApprove: boolean): 'brand' | 'warning' | 'default' {
  if (isTrainee) return 'brand';
  if (canApprove) return 'warning';
  return 'default';
}

// ─── Single app shell for every authenticated page (capability-gated) ───────────
// The notification bell + panel live in NotificationCenter (persisted store, Firestore
// inbox, Solar feed, per-item read state) — see src/components/NotificationCenter.tsx.
function AppShell({ children }: { children: React.ReactNode }) {
  const router   = useRouter();
  const pathname = usePathname();
  const { user, isAuthenticated, logout, _hasHydrated } = useAuthStore();
  const caps     = useUserCapabilities();
  // Southern Lanka only — Global Company Selector in the header below. canSwitch is false
  // (and companies stays empty) for anyone without can_manage_all_companies/is_system_admin;
  // companyId then just mirrors their own AppUser.company_id, unused here but consumed by
  // schedule/page.tsx and SouthernlankaShifts.tsx to scope departments/employees.
  const companyContext = useCompanyContext();
  const t = useT();
  const brand = useBrandName();
  const [brandHead, brandTail] = splitBrandName(brand);
  const [sidebarOpen,   setSidebarOpen]   = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  // The Global Company Selector below is a plain <Select> that only renders from md: up —
  // there's no room for it in the mobile header row. Below md:, a switching admin got NOTHING
  // in its place (not even the read-only badge, which is only shown to non-switching users),
  // so companyId stayed at whatever was last persisted with no way to change it on the phone
  // that actually needed changing it — surfacing everywhere else as disabled buttons and empty
  // "no data" states. This opens a picker dialog from a small icon button instead, so a
  // switching admin always has a way to change company, mobile included.
  const [companyPickerOpen, setCompanyPickerOpen] = useState(false);
  const reduceMotion = !!useReducedMotion();
  // Safe to seed straight from storage: the shell renders a spinner until the auth store
  // has rehydrated, so the sidebar never exists during hydration and can't mismatch.
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(readCollapsedGroups);

  const { navItems: filteredNav, adminNav, adminGroups } = useSidebarNav();
  // Read straight off the ID token's custom claim — no request. Presentation only; /platform
  // re-checks the platform_admins list server-side on every call.
  const isPlatformAdmin = useIsPlatformAdmin();
  // A Super Admin also sees the entry, because the alternative is worse: they hold the highest
  // role this system has, and hiding the door entirely makes "why can't I configure the
  // platform?" a mystery instead of an answer. /platform tells them, in one screen, that
  // platform configuration is granted separately — it still refuses to open. The claim stays
  // the fast path; this just widens who gets to read that explanation.
  const showPlatformEntry = isPlatformAdmin || caps.is_super_admin;
  const isActivePath = (href: string) => pathname === href || pathname.startsWith(href + '/');
  const activeGroupId = adminGroups.find(g => g.items.some(i => isActivePath(i.href)))?.id;

  // Accordion: at most ONE admin section stands open. Four sections holding ~17 destinations
  // between them will happily all sit open at once, which just reproduces the undifferentiated
  // wall the grouping exists to break up — so opening one closes the rest.
  const closeAllExcept = (openId: string | null) =>
    adminGroups.map(g => g.id).filter(id => id !== openId);

  const toggleNavGroup = (id: string) => setCollapsedGroups((prev) => {
    const next = closeAllExcept(prev.includes(id) ? id : null);
    writeCollapsedGroups(next);
    return next;
  });

  // Whatever section holds the current route is opened, so a closed section never hides
  // where the user is — on load, and when something outside the sidebar (bottom nav, a
  // deep link) drops them into a different section. Deliberately not persisted and keyed
  // on the section rather than the path: it must not overwrite the user's own choice, and
  // collapsing the section you're working in has to survive moving around inside it.
  useEffect(() => {
    if (!activeGroupId) return;
    setCollapsedGroups(prev => {
      const next = closeAllExcept(activeGroupId);
      // Only when it actually differs, or this re-runs itself on every render.
      if (next.length === prev.length && next.every(id => prev.includes(id))) return prev;
      writeCollapsedGroups(next);
      return next;
    });
    // Keyed on the SECTION alone: moving between pages inside one section must not reopen a
    // section the user deliberately closed while working in it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroupId]);
  // Few destinations → floating bottom tab bar on mobile; many → keep the sidebar/drawer.
  const totalNavCount = filteredNav.length + adminNav.length;
  const showBottomNav = totalNavCount > 0 && totalNavCount <= BOTTOM_NAV_MAX;
  const onAdminPage   = MANAGEMENT_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'));
  // Does the module owning this route exist on this tenant at all? (MODULE_ROUTES in
  // src/lib/tenants.ts.) Capabilities decide who may use a page; this decides whether the
  // page exists here. Enforced on the ROUTE, not just the sidebar row, so a bookmark or a
  // typed URL can't reach a module the tenant doesn't have.
  const moduleOn = isPathEnabled(tenant, pathname);
  const hasBackOffice = caps.is_system_admin || caps.can_manage_users || caps.can_view_users || caps.can_manage_leaves || caps.can_report || caps.can_manage_shifts
    || caps.can_manage_departments || caps.can_view_departments || caps.can_manage_company || caps.can_view_company || caps.can_manage_schedules || caps.can_view_schedules
    // Payroll-only roles (no other back-office capability) still need to reach the payroll
    // pages under MANAGEMENT_PATHS instead of being redirected away by the check below.
    || caps.can_view_payroll || caps.can_manage_payroll_config || caps.can_manage_pay_profiles
    || caps.can_generate_payroll || caps.can_review_payroll || caps.can_finalize_payroll || caps.can_view_attendance;
  // Head of Department — reaches a few MANAGEMENT_PATHS pages without a general back-office
  // capability, each filtered to their department(s) on the page itself. Deliberately
  // narrower than folding into hasBackOffice above, and STRICT: an is_department_head role
  // only counts as an HOD once it has department(s) actually assigned
  // (AppUser.hod_department_ids) — an empty list gets nothing here, matching the page guards
  // and the sidebar. Covers /schedule, /shifts and /attendance-view.
  const isHOD = tenant.id === 'southernlanka' && !!user?.hod_department_ids?.length;
  const hodPageAllowed =
    isHOD && ['/schedule', '/shifts', '/attendance-view'].some(p => pathname === p || pathname.startsWith(p + '/'));
  // Where to send a user who lands on a page they can't use.
  // Each candidate must also be a module this tenant HAS — otherwise a redirect could land
  // someone on the "not enabled" screen. filteredNav/adminNav are already module-filtered,
  // so their first entry is a safe last resort.
  const landingPage = caps.is_employee && isPathEnabled(tenant, '/dashboard') ? '/dashboard'
    : caps.can_approve && isPathEnabled(tenant, '/approvals') ? '/approvals'
    : caps.can_report && isPathEnabled(tenant, '/reports') ? '/reports'
    : (filteredNav[0]?.href ?? adminNav[0]?.href ?? '/login');

  useEffect(() => {
    if (!_hasHydrated) return;
    // Give Firebase a brief moment to restore a token before bouncing to login.
    if (!isAuthenticated) {
      const timer = setTimeout(() => {
        import('firebase/auth').then(({ getAuth }) => {
          if (!getAuth().currentUser) router.replace('/login');
        });
      }, 500);
      return () => clearTimeout(timer);
    }
    if (!user) return;
    // Non-employees have no dashboard/attendance — send them to their first usable page.
    if (!caps.is_employee && isEmployeeOnlyPath(pathname)) {
      router.replace(landingPage);
    }
    // Management pages require a back-office capability — except the handful a Head of
    // Department may also reach (see hodPageAllowed above) without holding any of those.
    if (onAdminPage && !hasBackOffice && !hodPageAllowed) {
      router.replace(landingPage);
    }
  }, [_hasHydrated, isAuthenticated, user, caps.is_employee, onAdminPage, hasBackOffice, hodPageAllowed, landingPage, pathname, router]);

  // Service Worker update banner (PWA & web app updates).
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    const showUpdateToast = (newWorker: ServiceWorker) => {
      toast.custom(
        (t) => (
          <UpdateNotificationBanner
            onReload={() => {
              newWorker.postMessage({ type: 'SKIP_WAITING' });
              toast.dismiss(t.id);
              window.location.reload();
            }}
            onDismiss={() => toast.dismiss(t.id)}
          />
        ),
        {
          id: 'pwa-update-toast',
          duration: Infinity,
          position: 'bottom-right',
        }
      );
    };

    const startDelay = setTimeout(async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration('/');
        if (!reg) return;

        if (reg.waiting && navigator.serviceWorker.controller) {
          showUpdateToast(reg.waiting);
          return;
        }

        const onUpdateFound = () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateToast(newWorker);
            }
          });
        };

        reg.addEventListener('updatefound', onUpdateFound);
        reg.update().catch(() => {});
        const poll = setInterval(() => { reg.update().catch(() => {}); }, 30 * 60 * 1000);
        return () => { reg.removeEventListener('updatefound', onUpdateFound); clearInterval(poll); };
      } catch { /* non-critical */ }
    }, 5000);

    return () => clearTimeout(startDelay);
  }, []);

  // FCM registration + reminder scheduler. Incoming messages are consumed by
  // NotificationCenter (toast + persisted inbox entry).
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    const setup = async () => {
      try {
        const { setupFCM }                = await import('@/services/firebase');
        const { startReminderScheduler }  = await import('@/services/reminderScheduler');
        await setupFCM();
        startReminderScheduler();
      } catch (e) { console.warn('FCM setup failed (non-critical):', e); }
    };
    setup();
  }, [isAuthenticated, user?.epf_number]);

  const handleLogout = async () => {
    try { await signOut(auth); } catch { /* ignore */ }
    logout();
    toast.success('Signed out successfully');
    router.push('/login');
  };

  const canApprove  = caps.can_approve;
  const isTrainee   = user?.employee_type?.toLowerCase() === 'trainee';
  const displayRole = user?.role ?? '';
  const tone        = roleTone(isTrainee, canApprove);

  if (!_hasHydrated) {
    return <div className="min-h-[100dvh] flex items-center justify-center"><div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" /></div>;
  }
  if (!isAuthenticated || !user) return null;
  // Show a spinner (not the page) while the effect above redirects away from a wrong page —
  // mirrors that effect's condition exactly, including the HOD page exceptions (see
  // hodPageAllowed), or a HOD would spin here forever instead of ever reaching the page the
  // effect deliberately leaves them on.
  if ((!caps.is_employee && isEmployeeOnlyPath(pathname)) || (onAdminPage && !hasBackOffice && !hodPageAllowed)) {
    return <div className="min-h-[100dvh] flex items-center justify-center"><div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" /></div>;
  }

  // Shared spring vocabulary with BottomNav; reduced motion collapses both to a cut.
  const activePillSpring: Transition = reduceMotion ? { duration: 0 } : { type: 'spring', bounce: 0.15, duration: 0.4 };
  const sectionSpring:    Transition = reduceMotion ? { duration: 0 } : { type: 'spring', bounce: 0, duration: 0.34 };

  // Called as `navLink(...)`, never rendered as `<NavLink />` — same reason as the NOTE on
  // SidebarContent below. `tone` is the only difference between the employee and admin
  // lists, so the two can't drift apart visually.
  const navLink = (item: NavItem, tone: 'primary' | 'brand', layoutId: string) => {
    const active = isActivePath(item.href);
    return (
      <Link key={item.href} href={item.href} onClick={() => setSidebarOpen(false)}
        title={item.label} aria-current={active ? 'page' : undefined}
        className={`group relative flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          active ? (tone === 'brand' ? 'text-brand' : 'text-primary') : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}>
        {active && (
          <motion.div layoutId={layoutId} transition={activePillSpring}
            className={`absolute inset-0 rounded-lg border-l-[3px] ring-1 ring-inset ${
              tone === 'brand' ? 'border-brand bg-brand/10 ring-brand/20' : 'border-primary bg-primary/10 ring-primary/20'}`} />
        )}
        <item.icon className={`relative z-10 h-[18px] w-[18px] flex-shrink-0 transition-transform ${active ? '' : 'group-hover:translate-x-0.5'}`} />
        <span className={`relative z-10 min-w-0 flex-1 truncate text-sm ${active ? 'font-semibold' : 'font-medium'}`}>{item.label}</span>
        {/* How many things are waiting on that page (see navBadgesStore). Hidden at zero — a
            row reading "0" says "look here" about nothing. Capped at 99+ so a long queue can't
            widen the sidebar. */}
        {!!item.badge && (
          <span
            className={`relative z-10 ml-auto flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
              tone === 'brand' ? 'bg-brand/15 text-brand' : 'bg-primary/15 text-primary'}`}
            aria-label={`${item.badge} waiting`}
          >
            {item.badge > 99 ? '99+' : item.badge}
          </span>
        )}
      </Link>
    );
  };

  // NOTE: rendered via `{SidebarContent()}` (a plain call), NOT `<SidebarContent />`.
  // `AppShell` re-renders on every navigation (usePathname changes), which would give this
  // inner function a new identity each time; as a JSX element that remounts the whole sidebar
  // and resets the nav's scroll position to top on each nav click. Calling it inlines the tree
  // in place so React reconciles the same <nav> and preserves its scroll.
  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      <div className="safe-top-spacer" />
      {/* ── Fixed header: brand + user card ── */}
      <div className="shrink-0 px-4 pt-4">
        {/* Brand */}
        <div className="flex items-center gap-2.5 mb-5 px-2 pt-1">
          <Link
            href="/dashboard"
            onClick={() => setSidebarOpen(false)}
            aria-label={`${brand} — Home`}
            className="w-9 h-9 rounded-xl bg-card ring-1 ring-border shadow-xs flex items-center justify-center flex-shrink-0 transition-transform active:scale-95 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <img src="/icon.png" alt={brand} className="w-6 h-6 rounded-md object-contain" />
          </Link>
          <Link
            href="/dashboard"
            onClick={() => setSidebarOpen(false)}
            aria-label={`${brand} — Home`}
            className="leading-tight rounded-md transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="text-sm font-bold tracking-tight text-foreground">{brandHead}<span className="text-primary">{brandTail}</span></div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-[0.2em]">Enterprise</div>
          </Link>
        </div>

        {/* User card — employees drop the ID lanyard; non-employees (admins) just open their profile */}
        <button type="button"
          onClick={() => { setSidebarOpen(false); if (caps.is_employee) useLanyardStore.getState().openManual(); else router.push('/profile'); }}
          className="group relative block w-full text-left glass rounded-2xl p-3.5 mb-5 overflow-hidden transition-all hover:bg-accent/40 hover:ring-1 hover:ring-primary/20">
          {/* Faint brand wash — the one subtle gradient accent on this surface. */}
          <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-px h-16 -z-0 bg-gradient-to-b from-primary/[0.07] to-transparent" />
          <div className="relative flex items-center gap-3">
            <Avatar className="h-12 w-12 rounded-2xl ring-2 ring-primary/20 ring-offset-2 ring-offset-card shadow-xs">
              {user.avatar ? <AvatarImage src={userScopedAvatar(user.avatar, user.epf_number)} alt={user.name} className="rounded-2xl" /> : null}
              <AvatarFallback className="rounded-2xl bg-primary/10 text-primary text-base font-bold">{user.name?.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold leading-tight text-foreground truncate">{user.name}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground truncate">{user.designation ?? user.role}</div>
              {user.company && (
                <div className="mt-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground truncate">
                  <Building2 className="h-3 w-3 shrink-0 text-primary/70" />
                  <span className="truncate">{user.company}</span>
                </div>
              )}
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 self-start text-muted-foreground/40 transition-all group-hover:translate-x-0.5 group-hover:text-primary" />
          </div>
          <div className="relative mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
            <Badge variant={tone} className="gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${isTrainee ? 'bg-brand' : canApprove ? 'bg-warning' : 'bg-primary'}`} />
              {displayRole}{isTrainee ? ' · Trainee' : ''}
            </Badge>
            {user.epf_number && (
              <span className="font-mono text-[11px] font-semibold tracking-wide text-muted-foreground tabular-nums">EPF {user.epf_number}</span>
            )}
          </div>
        </button>
      </div>

      {/* ── Scrollable middle: navigation scrolls when vertical space runs out ── */}
      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-none px-3 py-3">
          <div className="px-2 pb-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.15em]">{t.navHeadingMain}</div>
          <div className="space-y-1">
            {filteredNav.map((item) => navLink(item, 'primary', 'activeNav'))}
          </div>

          {adminGroups.length > 0 && (
            <>
              <div className="h-px bg-border my-3" />
              <div className="px-2 pb-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.15em]">{t.navHeadingAdmin}</div>
              {/* Admin is long enough (up to ~17 entries) that a flat list is unreadable —
                  it's split into collapsible sections; see NavGroup in useSidebarNav.ts. */}
              <div className="space-y-0.5">
                {adminGroups.map((group) => {
                  const collapsed  = collapsedGroups.includes(group.id);
                  const holdsActive = group.id === activeGroupId;
                  const panelId    = `nav-section-${group.id}`;
                  return (
                    <div key={group.id}>
                      <button type="button" onClick={() => toggleNavGroup(group.id)}
                        aria-expanded={!collapsed} aria-controls={panelId}
                        className="group/section flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <ChevronRight aria-hidden className={`h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60 transition-transform duration-200 group-hover/section:text-foreground ${collapsed ? '' : 'rotate-90'}`} />
                        <span className={`truncate text-xs font-semibold ${holdsActive ? 'text-brand' : 'text-muted-foreground group-hover/section:text-foreground'}`}>{group.label}</span>
                        {/* Closed sections say how much is hidden, and flag the one holding
                            the current page — the user may close it after landing there. */}
                        {collapsed && (
                          <span aria-hidden className="ml-auto flex items-center gap-1.5">
                            {holdsActive && <span className="h-1.5 w-1.5 rounded-full bg-brand" />}
                            <span className="text-[10px] font-medium tabular-nums text-muted-foreground/60">{group.items.length}</span>
                          </span>
                        )}
                      </button>
                      {/* Wrapper stays mounted so aria-controls always resolves. */}
                      <div id={panelId}>
                        <AnimatePresence initial={false}>
                          {!collapsed && (
                            <motion.div key="items" className="overflow-hidden"
                              initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                              transition={sectionSpring}>
                              <div className="ml-2 space-y-1 border-l border-border/60 py-1 pl-2">
                                {group.items.map((item) => navLink(item, 'brand', 'activeAdminNav'))}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
      </nav>

      {/* ── Fixed footer: What's New + Solar App, then compact icon actions ── */}
      <div className="shrink-0 px-4 pb-4 pt-3 border-t border-border space-y-1">
        {/* Platform configuration — the tenant registry itself. Shown to a platform admin (the
            platform_admin claim) and to a Super Admin, who gets a page explaining that platform
            configuration is granted separately rather than a silent nothing. Invisible to
            everyone else. It lives OUTSIDE this app shell, so it opens in a plain navigation
            rather than a client-side route change. */}
        {showPlatformEntry && (
          <a
            href="/platform"
            className="mb-1.5 flex items-center gap-2 rounded-xl border border-brand/30 bg-brand/5 px-3 py-2 text-xs font-semibold text-brand transition-colors hover:bg-brand/10"
          >
            <ShieldCheck className="h-4 w-4 flex-shrink-0" />
            Platform Config
          </a>
        )}

        {tenant.features.whatsNew && <SidebarVersion />}
        {tenant.features.solarApp
          // Solar App — auto-login via signed SSO token, opens installed PWA or browser
          ? <SolarAppButton onNavigate={() => setSidebarOpen(false)} />
          // Tenants without Solar get a plain install link instead (dynamic base URL).
          : <GetAppButton onNavigate={() => setSidebarOpen(false)} />}
        {/* LogPup — same handoff shape as Solar. Additive rather than part of the ternary
            above: a tenant can have both, and neither stands in for the other. */}
        {tenant.features.logpupTasks && (
          <LogPupAppButton onNavigate={() => setSidebarOpen(false)} />
        )}

        {/* Profile · Settings · Sign out — a contained segmented action bar (icon + label) */}
        <div className="mt-1.5 flex items-stretch rounded-xl border border-border bg-muted/40 p-1">
          {/* Profile and Settings are modules like any other (tenant.features) — a tenant
              without one loses its slot here rather than showing a dead link. */}
          {tenant.features.profile && (
            <Link href="/profile" onClick={() => setSidebarOpen(false)} aria-label={t.profile}
              className="flex flex-1 flex-col items-center justify-center gap-1 rounded-lg py-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <User className="h-[18px] w-[18px]" />
              <span className="text-[10px] font-medium leading-none">{t.profile}</span>
            </Link>
          )}

          {tenant.features.profile && <div className="my-1.5 w-px self-stretch bg-border/70" />}

          {tenant.features.settings && (
            <Link href="/settings" onClick={() => setSidebarOpen(false)} aria-label={t.settings}
              className="group flex flex-1 flex-col items-center justify-center gap-1 rounded-lg py-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Settings className="h-[18px] w-[18px] transition-transform group-hover:rotate-45" />
              <span className="text-[10px] font-medium leading-none">{t.settings}</span>
            </Link>
          )}

          {tenant.features.settings && <div className="my-1.5 w-px self-stretch bg-border/70" />}

          <div className="relative flex-1">
            <button type="button" onClick={() => setConfirmSignOut(v => !v)} aria-label={t.signOut} aria-expanded={confirmSignOut}
              className="flex w-full flex-col items-center justify-center gap-1 rounded-lg py-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <LogOut className="h-[18px] w-[18px]" />
              <span className="text-[10px] font-medium leading-none">{t.signOut}</span>
            </button>
            <AnimatePresence>
              {confirmSignOut && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setConfirmSignOut(false)} aria-hidden />
                  <motion.div
                    initial={{ opacity: 0, y: 6, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.96 }}
                    transition={{ duration: 0.15 }}
                    className="absolute bottom-full right-0 z-50 mb-2 w-48 rounded-xl border border-border bg-card p-3 shadow-popover"
                  >
                    <div className="text-xs font-medium text-foreground">{t.signOutConfirm}</div>
                    <div className="mt-2.5 flex gap-2">
                      <button type="button" onClick={() => setConfirmSignOut(false)}
                        className="flex-1 rounded-md border border-border px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent">
                        {t.cancel}
                      </button>
                      <button type="button" onClick={() => { setConfirmSignOut(false); handleLogout(); }}
                        className="flex-1 rounded-md bg-destructive px-2 py-1.5 text-xs font-semibold text-destructive-foreground transition-colors hover:bg-destructive/90">
                        {t.signOut}
                      </button>
                    </div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );

  const allLabels: Record<string, string> = {
    '/profile':  t.profile,
    '/settings': t.settings,
    ...Object.fromEntries(filteredNav.map(n => [n.href, n.label])),
    ...Object.fromEntries(adminNav.map(n => [n.href, n.label])),
  };
  const currentLabel = allLabels[pathname] ?? '';

  return (
    <div className="flex h-[100dvh] overflow-hidden text-foreground transition-colors duration-300">
      <aside className="hidden md:flex w-64 flex-shrink-0 flex-col bg-sidebar/70 backdrop-blur-xl border-r border-border relative z-20">
        {SidebarContent()}
      </aside>

      <AnimatePresence>
        {sidebarOpen && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setSidebarOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-30 md:hidden" />
            <motion.aside initial={{ x: -288 }} animate={{ x: 0 }} exit={{ x: -288 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="fixed left-0 top-0 h-[100dvh] w-72 bg-sidebar/85 backdrop-blur-2xl border-r border-border z-40 md:hidden flex flex-col">
              <button onClick={() => setSidebarOpen(false)} aria-label={t.closeMenu}
                style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}
                className="absolute right-4 w-8 h-8 rounded-lg border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground">
                <X className="w-4 h-4" />
              </button>
              {SidebarContent()}
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="flex flex-col border-b border-border bg-background/70 backdrop-blur-xl flex-shrink-0 relative z-30">
          <div className="safe-top-spacer" />
          <div className="h-16 flex items-center px-4 md:px-6">
            <button onClick={() => setSidebarOpen(true)} aria-label={t.openMenu}
              className="md:hidden w-9 h-9 rounded-lg border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground mr-3">
              <Menu className="w-4 h-4" />
            </button>
            <div className="flex-1 min-w-0">
              <div className="text-base font-semibold tracking-tight text-foreground truncate">{currentLabel}</div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={tone} className="hidden sm:inline-flex gap-1.5 px-2.5 py-1">
                <Shield className="w-3.5 h-3.5 flex-shrink-0" />
                {displayRole}{isTrainee ? ' · Trainee' : ''}
              </Badge>
              {/* Global Company Selector — southernlanka only, and only once useCompanyContext
                  has actually resolved (companyContext.ready) for a can_manage_all_companies/
                  is_system_admin holder (companyContext.canSwitch — itself already false while
                  !ready, but the explicit `ready` check here is belt-and-braces so this render
                  branch can never show the switcher off a still-loading/default capability
                  read). Replaces the plain company-name badge for them; everyone else
                  (including the still-loading window) gets that badge instead, unchanged, and
                  is silently locked to their own company everywhere that reads
                  useCompanyContext(). */}
              {tenant.id === 'southernlanka' && companyContext.ready && companyContext.canSwitch ? (
                <>
                  <div className="hidden md:block w-44 lg:w-64">
                    <Select
                      value={companyContext.companyId}
                      onChange={companyContext.setCompanyId}
                      options={[
                        { value: '', label: 'All companies' },
                        ...companyContext.companies.map((c) => ({ value: c.id, label: c.name })),
                      ]}
                      placeholder="All companies"
                    />
                  </div>
                  {/* Mobile stand-in for the <Select> above, which has no room in this row
                      below md: — a small icon trigger opens the same choice as a dialog
                      instead of losing it below that breakpoint. */}
                  <button
                    type="button"
                    onClick={() => setCompanyPickerOpen(true)}
                    aria-label="Select company"
                    title={companyContext.companyId
                      ? companyContext.companies.find(c => c.id === companyContext.companyId)?.name ?? 'Select company'
                      : 'All companies'}
                    className="md:hidden w-9 h-9 rounded-lg border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground flex-shrink-0"
                  >
                    <Building2 className="w-4 h-4" />
                  </button>
                </>
              ) : user.company && (
                <div className="hidden md:flex items-center px-2.5 py-1.5 rounded-md border border-border bg-card">
                  <span className="text-xs font-medium text-muted-foreground">{user.company}</span>
                </div>
              )}

              <ThemeToggle />

              <NotificationCenter />

              {tenant.features.profile ? (
                <Link href="/profile">
                  <Avatar className="h-9 w-9 cursor-pointer transition-opacity hover:opacity-90">
                    {user.avatar ? <AvatarImage src={userScopedAvatar(user.avatar, user.epf_number)} alt={user.name} /> : null}
                    <AvatarFallback>{user.name?.charAt(0).toUpperCase()}</AvatarFallback>
                  </Avatar>
                </Link>
              ) : (
                <Avatar className="h-9 w-9">
                  {user.avatar ? <AvatarImage src={userScopedAvatar(user.avatar, user.epf_number)} alt={user.name} /> : null}
                  <AvatarFallback>{user.name?.charAt(0).toUpperCase()}</AvatarFallback>
                </Avatar>
              )}
            </div>
          </div>
        </header>

        {/* Mobile company picker — the dialog behind the icon button above. Same value/options/
            setCompanyId as the desktop <Select>, just triggered and closed differently. */}
        {tenant.id === 'southernlanka' && companyContext.ready && companyContext.canSwitch && (
          <Dialog open={companyPickerOpen} onOpenChange={setCompanyPickerOpen}>
            <DialogContent className="max-w-xs">
              <DialogHeader>
                <DialogTitle>Select company</DialogTitle>
              </DialogHeader>
              <div className="space-y-1">
                {[{ id: '', name: 'All companies' }, ...companyContext.companies].map((c) => {
                  const active = companyContext.companyId === c.id;
                  return (
                    <button
                      key={c.id || '__all'}
                      type="button"
                      onClick={() => { companyContext.setCompanyId(c.id); setCompanyPickerOpen(false); }}
                      className={`w-full flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                        active
                          ? 'border-primary/40 bg-primary/10 text-primary font-medium'
                          : 'border-border bg-card text-foreground hover:bg-muted'
                      }`}
                    >
                      <span className="truncate">{c.name}</span>
                      {active && <Check className="w-4 h-4 flex-shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </DialogContent>
          </Dialog>
        )}

        {/* Employees mark attendance with mandatory GPS — keep a one-tap "turn on
            location" prompt in front of them whenever location is off. */}
        {caps.is_employee && <LocationOffBanner />}

        <PullToRefresh>
          <div className="p-4 md:p-6 max-w-7xl mx-auto">
            {moduleOn
              ? children
              : <div className="p-10 text-center text-muted-foreground">{t.moduleUnavailable}</div>}
          </div>
          {/* Clearance so the last row isn't hidden behind the floating mobile bottom nav. */}
          {showBottomNav && <div className="md:hidden h-24" />}
          <div className="safe-bottom-spacer" />
        </PullToRefresh>
      </div>

      {/* Mobile-only floating bottom tab bar — shown only when the nav set fits. */}
      {showBottomNav && <BottomNav />}

      <PWAInstallBanner />

      {/* One-time fireworks birthday wish on the birthday person's first open today. */}
      <Suspense fallback={null}><GreetingCard /></Suspense>
    </div>
  );
}

export default function PagesLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AppShell>{children}</AppShell>
    </AuthProvider>
  );
}
