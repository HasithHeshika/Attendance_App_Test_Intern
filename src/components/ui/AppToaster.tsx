'use client';
import * as React from 'react';
import {
  Toaster, toast as hotToast, resolveValue, type Toast,
} from 'react-hot-toast';
import { CheckCircle2, AlertCircle, Info, Loader2, X } from 'lucide-react';
import { openNotificationCenter } from '@/store/notificationsStore';

/* ════════════════════════════════════════════════════════════════════════════
   AppToaster — the V2 branded toast surface.

   • One glass surface + entrance/exit animation for EVERY toast (driven by
     react-hot-toast's `t.visible`, the library-sanctioned way to animate a
     custom render) — so existing toast.success / toast.error calls upgrade for
     free, no migration.
   • Semantic colour + icon per type (success / error / loading / info).
   • Smart placement: top-right on desktop, top-center on mobile, safe-area aware.
   • Rich toasts (toast.custom or a function message — e.g. the PWA update bar)
     bring their own content; we only lend them the animated shell.
   ════════════════════════════════════════════════════════════════════════════ */

export type ToastTone = 'success' | 'error' | 'warning' | 'primary';

const CHIP: Record<ToastTone, string> = {
  success: 'bg-success/10 text-success',
  error:   'bg-destructive/10 text-destructive',
  warning: 'bg-warning/10 text-warning',
  primary: 'bg-primary/10 text-primary',
};
const BAR: Record<ToastTone, string> = {
  success: 'bg-success',
  error:   'bg-destructive',
  warning: 'bg-warning',
  primary: 'bg-primary',
};

function toneForType(type: Toast['type']): ToastTone {
  if (type === 'success') return 'success';
  if (type === 'error') return 'error';
  return 'primary';
}

function typeIcon(type: Toast['type']): React.ReactNode {
  if (type === 'success') return <CheckCircle2 className="h-4 w-4" />;
  if (type === 'error') return <AlertCircle className="h-4 w-4" />;
  if (type === 'loading') return <Loader2 className="h-4 w-4 animate-spin" />;
  return <Info className="h-4 w-4" />;
}

function useIsDesktop() {
  const [desktop, setDesktop] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const sync = () => setDesktop(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return desktop;
}

// Installed as a PWA? On Android standalone the OS status bar overlays the
// viewport but is NOT reported via safe-area-inset-top, so toasts at the very
// top get hidden behind it. We add a guaranteed minimum top gap in that case.
function useIsStandalone() {
  const [standalone, setStandalone] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia('(display-mode: standalone)');
    const sync = () => setStandalone(
      mq.matches || (window.navigator as Navigator & { standalone?: boolean }).standalone === true,
    );
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return standalone;
}

/** Shared toast shell. The `app-toast-surface` class guarantees a fully opaque,
 *  theme-aware background with a plain-hex fallback (see globals.css), so the card is
 *  never see-through over page content — even on older browsers that can't parse
 *  `hsl(var(--popover))`. `t.visible` toggles the enter/leave keyframes. */
function ToastShell({ t, children, bar }: { t: Toast; children: React.ReactNode; bar?: ToastTone }) {
  return (
    <div
      className={`${t.visible ? 'toast-enter' : 'toast-leave'} app-toast-surface pointer-events-auto relative w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border shadow-popover`}
      role={t.type === 'error' ? 'alert' : 'status'}
      aria-live={t.type === 'error' ? 'assertive' : 'polite'}
    >
      {bar && <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${BAR[bar]}`} />}
      {children}
    </div>
  );
}

export default function AppToaster() {
  const isDesktop = useIsDesktop();
  const isStandalone = useIsStandalone();

  // Keep toasts clear of the phone's status/notification bar. In a standalone PWA
  // (esp. Android, where safe-area-inset-top is 0) force a minimum gap so the OS
  // bar never overlaps the toast; otherwise just respect the safe-area inset.
  const topOffset = isDesktop
    ? '16px'
    : isStandalone
      ? 'calc(max(env(safe-area-inset-top, 0px), 32px) + 12px)'
      : 'calc(env(safe-area-inset-top, 0px) + 12px)';

  return (
    <Toaster
      position={isDesktop ? 'top-right' : 'top-center'}
      gutter={10}
      containerStyle={{ top: topOffset }}
      toastOptions={{
        duration: 4000,
        success: { duration: 3000 },
        error: { duration: 5000 },
      }}
    >
      {(t) => {
        // Rich toast: a function message (e.g. the PWA update bar) or toast.custom.
        // It owns its content — we only give it the animated shell.
        const isRich = t.type === 'custom' || typeof t.message === 'function';
        if (isRich) {
          return <ToastShell t={t}>{resolveValue(t.message, t)}</ToastShell>;
        }

        const tone = toneForType(t.type);
        // Honour an explicitly-passed icon (e.g. FCM's 🔔) on plain toasts.
        const icon = t.type === 'blank' && t.icon ? t.icon : typeIcon(t.type);
        const isNotifToast = t.icon === '🔔';

        return (
          <ToastShell t={t} bar={tone}>
            <div
              onClick={() => {
                if (isNotifToast) {
                  hotToast.dismiss(t.id);
                  openNotificationCenter();
                }
              }}
              className={`flex items-start gap-3 py-3 pl-3.5 pr-2.5 ${isNotifToast ? 'cursor-pointer hover:bg-accent/40 active:scale-[0.99] transition-all' : ''}`}
            >
              <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${CHIP[tone]}`}>
                {icon}
              </div>
              <div className="min-w-0 flex-1 self-center text-sm leading-snug text-foreground">
                {resolveValue(t.message, t)}
                {isNotifToast && (
                  <div className="mt-1 text-[11px] font-medium text-primary">
                    Tap to open notification center
                  </div>
                )}
              </div>
              {t.type !== 'loading' && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    hotToast.dismiss(t.id);
                  }}
                  aria-label="Dismiss notification"
                  className="-mr-0.5 mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </ToastShell>
        );
      }}
    </Toaster>
  );
}

/* ─── Structured (title + description) toast helper ──────────────────────────────
   For richer, self-explaining notifications (e.g. network status). Creates a
   `toast.custom`. IMPORTANT: react-hot-toast renders `toast.custom` toasts by
   resolving the message directly — it does NOT route them through <Toaster>'s
   children render fn — so a custom toast gets NO surface unless it renders one
   itself. We therefore wrap the content in the same <ToastShell> that normal
   toasts use, which supplies the opaque `app-toast-surface` background, border,
   shadow and enter/leave animation. (Rendering a bare fragment here was the bug
   that left the offline / slow-network banners see-through over page content.)
   Returns the toast id. */
export function notifyStructured(opts: {
  tone: ToastTone;
  icon: React.ReactNode;
  title: React.ReactNode;
  desc?: React.ReactNode;
  duration?: number;
  /** Stable id → re-emitting updates the same toast instead of stacking. */
  id?: string;
}): string {
  const { tone, icon, title, desc, duration, id } = opts;
  return hotToast.custom(
    (t) => (
      <ToastShell t={t} bar={tone}>
        <div className="flex items-start gap-3 py-3 pl-3.5 pr-2.5">
          <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${CHIP[tone]}`}>
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold leading-snug text-foreground">{title}</div>
            {desc && <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{desc}</div>}
          </div>
          <button
            type="button"
            onClick={() => hotToast.dismiss(t.id)}
            aria-label="Dismiss notification"
            className="-mr-0.5 mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </ToastShell>
    ),
    { id, duration: duration ?? 4000 },
  );
}
