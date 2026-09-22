'use client';
import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Download, Share2, Plus, Monitor, MoreVertical,
  Loader2, CheckCircle2, LayoutGrid, Smartphone,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBrandName } from '@/lib/brand';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type UIState  = 'banner' | 'installing' | 'instructions' | 'success' | 'hidden';
type InstMode = 'chrome' | 'edge' | 'samsung' | 'ios' | 'macos-safari' | 'firefox';

// ─── Detection ────────────────────────────────────────────────────────────────

function getBrowser() {
  const ua = navigator.userAgent;
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/Edg\//.test(ua))          return 'edge';
  if (/Chrome\//.test(ua))       return 'chrome';
  if (/Firefox\//.test(ua))      return 'firefox';
  if (/Safari\//.test(ua))       return 'safari';
  return 'other';
}

function getPlatform() {
  const ua = navigator.userAgent;
  const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (/iPhone|iPod/.test(ua) || isIPad) return 'ios';
  if (/Android/.test(ua))               return 'android';
  if (/Macintosh/.test(ua))             return 'macos';
  return 'other';
}

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

function wasDismissed() {
  try {
    const ts = localStorage.getItem('pwa-dismissed');
    return !!ts && Date.now() - Number(ts) < 7 * 24 * 60 * 60 * 1000;
  } catch { return false; }
}

// ─── Browser-specific install steps ──────────────────────────────────────────

const STEPS: Record<Exclude<InstMode, 'ios'>, { icon: React.ReactNode; title: string; detail: string }[]> = {
  chrome: [
    {
      icon:   <MoreVertical className="w-4 h-4 text-primary" />,
      title:  'Open Menu',
      detail: 'Click the ⋮ menu at the top-right corner of Chrome.',
    },
    {
      icon:   <Share2 className="w-4 h-4 text-primary" />,
      title:  'Cast, save and share',
      detail: 'Hover over "Cast, save and share" in the dropdown.',
    },
    {
      icon:   <Download className="w-4 h-4 text-primary" />,
      title:  'Install page as app',
      detail: 'Click "Install page as app…" then click Install.',
    },
  ],
  edge: [
    {
      icon:   <MoreVertical className="w-4 h-4 text-primary" />,
      title:  'Open Menu',
      detail: 'Click the … menu at the top-right corner of Edge.',
    },
    {
      icon:   <LayoutGrid className="w-4 h-4 text-primary" />,
      title:  'Apps',
      detail: 'Click "Apps" in the dropdown menu.',
    },
    {
      icon:   <Download className="w-4 h-4 text-primary" />,
      title:  'Install {app}',
      detail: 'Click "Install {app}" then click Install.',
    },
  ],
  samsung: [
    {
      icon:   <MoreVertical className="w-4 h-4 text-primary" />,
      title:  'Open Menu',
      detail: 'Tap the ≡ menu icon at the bottom of Samsung Internet.',
    },
    {
      icon:   <Plus className="w-4 h-4 text-primary" />,
      title:  'Add page to',
      detail: 'Tap "Add page to" in the menu.',
    },
    {
      icon:   <Smartphone className="w-4 h-4 text-primary" />,
      title:  'Home screen',
      detail: 'Tap "Home screen" then tap Add to confirm.',
    },
  ],
  'macos-safari': [
    {
      icon:   <Monitor className="w-4 h-4 text-primary" />,
      title:  'File menu',
      detail: 'In the Safari menu bar click File → Add to Dock (Safari 17+).',
    },
    {
      icon:   <Share2 className="w-4 h-4 text-primary" />,
      title:  'Or use Share',
      detail: 'Click the toolbar Share button and choose "Add to Dock".',
    },
  ],
  firefox: [
    {
      icon:   <Monitor className="w-4 h-4 text-primary" />,
      title:  'Switch browser',
      detail: 'Firefox does not support installing web apps. Open this page in Chrome or Edge for one-click install.',
    },
  ],
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function PWAInstallBanner() {
  const brand = useBrandName();
  const [ui,        setUI]       = useState<UIState>('hidden');
  const [instMode,  setInstMode] = useState<InstMode>('chrome');
  const promptRef                 = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (isStandalone() || wasDismissed()) return;

    const browser  = getBrowser();
    const platform = getPlatform();

    if      (platform === 'ios')                           setInstMode('ios');
    else if (platform === 'macos' && browser === 'safari') setInstMode('macos-safari');
    else if (browser  === 'firefox')                       setInstMode('firefox');
    else if (browser  === 'edge')                          setInstMode('edge');
    else if (browser  === 'samsung')                       setInstMode('samsung');
    else                                                   setInstMode('chrome');

    setUI('banner');

    const capture = (e: Event) => {
      e.preventDefault();
      promptRef.current = e as BeforeInstallPromptEvent;
      (window as { __pwaInstallPrompt?: unknown }).__pwaInstallPrompt = e;
    };
    const existing = (window as { __pwaInstallPrompt?: BeforeInstallPromptEvent }).__pwaInstallPrompt;
    if (existing) promptRef.current = existing;

    const onReady = () => {
      const p = (window as { __pwaInstallPrompt?: BeforeInstallPromptEvent }).__pwaInstallPrompt;
      if (p) promptRef.current = p;
    };
    const onInstalled = () => {
      setUI('success');
      setTimeout(() => setUI('hidden'), 3500);
    };

    window.addEventListener('beforeinstallprompt', capture);
    window.addEventListener('pwa-prompt-ready',    onReady);
    window.addEventListener('appinstalled',        onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', capture);
      window.removeEventListener('pwa-prompt-ready',    onReady);
      window.removeEventListener('appinstalled',        onInstalled);
    };
  }, []);

  const handleInstall = async () => {
    if (instMode === 'ios') { setUI('instructions'); return; }

    const prompt = promptRef.current;
    if (prompt) {
      setUI('installing');
      try {
        await prompt.prompt();
        const { outcome } = await prompt.userChoice;
        if (outcome === 'accepted') {
          setUI('success');
          setTimeout(() => setUI('hidden'), 3500);
        } else {
          setUI('instructions');
        }
      } catch {
        setUI('instructions');
      }
    } else {
      setUI('instructions');
    }
  };

  const handleDismiss = () => {
    try { localStorage.setItem('pwa-dismissed', String(Date.now())); } catch { /* noop */ }
    setUI('hidden');
  };

  if (ui === 'hidden') return null;

  // ── Success toast ──────────────────────────────────────────────────────────
  if (ui === 'success') {
    return (
      <AnimatePresence>
        <motion.div
          key="success"
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0,  opacity: 1 }}
          exit={{   y: 80, opacity: 0 }}
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-5 py-3 rounded-xl bg-success/10 border border-success/20 text-success text-sm font-semibold shadow-card whitespace-nowrap"
        >
          <Download className="w-4 h-4" />
          Installed! Find {brand} in your app launcher.
        </motion.div>
      </AnimatePresence>
    );
  }

  const nonIOSSteps = instMode !== 'ios'
    ? STEPS[instMode].map(s => ({
        ...s,
        title:  s.title.replace(/{app}/g, brand),
        detail: s.detail.replace(/{app}/g, brand),
      }))
    : null;

  const browserLabel =
    instMode === 'edge'    ? 'Microsoft Edge' :
    instMode === 'samsung' ? 'Samsung Internet' :
    instMode === 'chrome'  ? 'Google Chrome' :
    instMode === 'macos-safari' ? 'Safari' :
    instMode === 'firefox' ? 'Firefox' : '';

  return (
    <AnimatePresence>
      <motion.div
        key="banner"
        initial={{ y: 120, opacity: 0 }}
        animate={{ y: 0,   opacity: 1 }}
        exit={{   y: 120, opacity: 0 }}
        transition={{ type: 'spring', damping: 24, stiffness: 300 }}
        className="fixed bottom-0 left-3 right-3 z-50 pb-safe-banner md:left-auto md:bottom-6 md:right-6 md:pb-0 md:w-80"
      >
        <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden">
          {/* Accent line */}
          <div className="h-0.5 bg-primary" />

          {/* Header: app.png thumbnail · title · dismiss */}
          <div className="flex items-center gap-3 px-4 pt-4 pb-3">
            <img
              src="/app.png"
              alt=""
              className="w-9 h-9 rounded-xl border border-border object-cover flex-shrink-0"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-foreground truncate leading-tight">Install {brand}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                {ui === 'instructions'
                  ? instMode === 'ios'
                    ? 'iOS Safari · tap share button below'
                    : `${browserLabel} · follow the steps below`
                  : 'Add to your home screen — works like a native app'}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={handleDismiss}
              className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground flex-shrink-0"
              aria-label="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>

          {/* Install / Share button */}
          {(ui === 'banner' || ui === 'installing') && (
            <div className="px-4 pb-4">
              <Button
                type="button"
                onClick={handleInstall}
                disabled={ui === 'installing'}
                className="w-full text-xs font-bold"
              >
                {ui === 'installing'
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Opening…</>
                  : instMode === 'ios'
                    ? <><Plus className="w-3.5 h-3.5" /> How to Install</>
                    : <><Download className="w-3.5 h-3.5" /> Install App</>
                }
              </Button>
            </div>
          )}

          {/* Instruction panel */}
          <AnimatePresence>
            {ui === 'instructions' && (
              <motion.div
                key="steps"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{   height: 0, opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="overflow-hidden"
              >
                {/* iOS: static Safari toolbar share guide */}
                {instMode === 'ios' ? (
                  <div className="px-4 pb-4 border-t border-border pt-3 space-y-2.5">
                    <div className="flex items-start gap-2.5">
                      <div className="w-6 h-6 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <Share2 className="w-3.5 h-3.5 text-primary" />
                      </div>
                      <p className="text-xs text-muted-foreground leading-snug flex-1">
                        <span className="font-bold text-primary">Step 1 · Share button — </span>
                        Tap the <span className="text-foreground font-medium">share icon</span> (box with arrow) in Safari's bottom toolbar.
                      </p>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <div className="w-6 h-6 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <Plus className="w-3.5 h-3.5 text-primary" />
                      </div>
                      <p className="text-xs text-muted-foreground leading-snug flex-1">
                        <span className="font-bold text-primary">Step 2 · Add to Home Screen — </span>
                        Scroll down and tap <span className="text-foreground font-medium">"Add to Home Screen"</span>.
                      </p>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <div className="w-6 h-6 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                      </div>
                      <p className="text-xs text-muted-foreground leading-snug flex-1">
                        <span className="font-bold text-primary">Step 3 · Confirm — </span>
                        Tap <span className="text-foreground font-medium">"Add"</span> in the top-right corner.
                      </p>
                    </div>
                  </div>
                ) : (
                  /* Browser-specific step-by-step instructions */
                  <div className="px-4 pb-4 space-y-2.5 border-t border-border pt-3">
                    {nonIOSSteps?.map((s, i) => (
                      <div key={i} className="flex items-start gap-2.5">
                        <div className="w-6 h-6 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                          {s.icon}
                        </div>
                        <p className="text-xs text-muted-foreground leading-snug flex-1">
                          <span className="font-bold text-primary">Step {i + 1} · {s.title} — </span>
                          {s.detail}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
