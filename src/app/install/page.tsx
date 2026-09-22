'use client';
import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Download, Share2, Plus, Monitor, MoreVertical,
  Loader2, CheckCircle2, Smartphone, ArrowRight,
} from 'lucide-react';
import Link from 'next/link';
import { useBrandName } from '@/lib/brand';
import { Button } from '@/components/ui/button';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type Platform = 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'unknown';
type Browser  = 'chrome' | 'edge' | 'samsung' | 'safari' | 'firefox' | 'other';
type UIState  = 'idle' | 'installing' | 'success' | 'instructions';

// ─── Detection helpers ────────────────────────────────────────────────────────

function getPlatform(): Platform {
  const ua = navigator.userAgent;
  const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (/iPhone|iPod/.test(ua) || isIPad) return 'ios';
  if (/Android/.test(ua))               return 'android';
  if (/Windows/.test(ua))               return 'windows';
  if (/Macintosh/.test(ua))             return 'macos';
  if (/Linux/.test(ua))                 return 'linux';
  return 'unknown';
}

function getBrowser(): Browser {
  const ua = navigator.userAgent;
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/Edg\//.test(ua))          return 'edge';
  if (/Chrome\//.test(ua))       return 'chrome';
  if (/Firefox\//.test(ua))      return 'firefox';
  if (/Safari\//.test(ua))       return 'safari';
  return 'other';
}

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

// ─── Step data (non-iOS only) ─────────────────────────────────────────────────

const STEPS = {
  'macos-safari': [
    { icon: Monitor,      label: 'File → Add to Dock',       desc: 'In the Safari menu bar click File → Add to Dock (requires Safari 17 or later).' },
    { icon: Share2,       label: 'Or use Share',             desc: 'Click the Share button in the toolbar and choose "Add to Dock".' },
  ],
  firefox: [
    { icon: Monitor,      label: 'Switch to Chrome or Edge', desc: 'Firefox does not support installing web apps. Open this page in Chrome or Microsoft Edge for a one-click install.' },
  ],
  chrome: [
    { icon: MoreVertical, label: 'Open browser menu',        desc: 'Click the install icon (⊕) in the address bar, or open the menu (⋮) and choose "Install {app}".' },
    { icon: Download,     label: 'Tap Install',              desc: 'Click "Install" in the confirmation dialog that appears.' },
  ],
} as const;

// ─── Page component ───────────────────────────────────────────────────────────

export default function InstallPage() {
  const brand = useBrandName();
  const [platform,  setPlatform]  = useState<Platform>('unknown');
  const [browser,   setBrowser]   = useState<Browser>('other');
  const [ui,        setUI]        = useState<UIState>('idle');
  const [mounted,   setMounted]   = useState(false);
  const [alreadyInstalled, setAlreadyInstalled] = useState(false);
  const promptRef = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    setMounted(true);
    const p = getPlatform();
    const b = getBrowser();
    setPlatform(p);
    setBrowser(b);
    setAlreadyInstalled(isStandalone());

    const existing = (window as { __pwaInstallPrompt?: BeforeInstallPromptEvent }).__pwaInstallPrompt;
    if (existing) promptRef.current = existing;

    const capture = (e: Event) => {
      e.preventDefault();
      promptRef.current = e as BeforeInstallPromptEvent;
      (window as { __pwaInstallPrompt?: unknown }).__pwaInstallPrompt = e;
    };
    const onReady = () => {
      const stored = (window as { __pwaInstallPrompt?: BeforeInstallPromptEvent }).__pwaInstallPrompt;
      if (stored) promptRef.current = stored;
    };
    window.addEventListener('beforeinstallprompt', capture);
    window.addEventListener('pwa-prompt-ready', onReady);
    window.addEventListener('appinstalled', () => setAlreadyInstalled(true));
    return () => {
      window.removeEventListener('beforeinstallprompt', capture);
      window.removeEventListener('pwa-prompt-ready', onReady);
    };
  }, []);

  // iOS WebKit never fires beforeinstallprompt — show guide instead.
  // On Android, beforeinstallprompt fires in all Chromium-based browsers regardless of brand.
  const canOneClick = platform !== 'ios' && browser !== 'firefox' && (platform === 'android' || browser === 'chrome' || browser === 'edge' || browser === 'samsung');

  const browserDisplayName =
    browser === 'edge'    ? 'Microsoft Edge' :
    browser === 'samsung' ? 'Samsung Internet' :
    browser === 'chrome'  ? 'Google Chrome' :
    platform === 'android' ? 'your browser' : 'Google Chrome';

  const handleInstall = async () => {
    const prompt = promptRef.current;
    if (prompt) {
      setUI('installing');
      try {
        await prompt.prompt();
        const { outcome } = await prompt.userChoice;
        setUI(outcome === 'accepted' ? 'success' : 'instructions');
      } catch {
        setUI('instructions');
      }
    } else {
      setUI('instructions');
    }
  };

  const instrKey: keyof typeof STEPS =
    platform === 'macos' && browser === 'safari' ? 'macos-safari' :
    browser  === 'firefox'                        ? 'firefox' :
    'chrome';

  const steps = STEPS[instrKey].map(s => ({ ...s, desc: s.desc.replace(/{app}/g, brand) }));

  if (!mounted) return null;

  // ── Already installed ──────────────────────────────────────────────────────
  if (alreadyInstalled) {
    return (
      <PageShell>
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center text-center gap-6"
        >
          <div className="w-20 h-20 rounded-3xl overflow-hidden border-2 border-success/40 shadow-soft">
            <img src="/icon.png" alt={brand} className="w-full h-full object-cover" />
          </div>
          <div>
            <div className="flex items-center justify-center gap-2 text-success mb-2">
              <CheckCircle2 className="w-5 h-5" />
              <span className="text-sm font-semibold">Already installed</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{brand} is ready</h1>
            <p className="text-muted-foreground text-sm mt-2">You can open it from your home screen or app launcher.</p>
          </div>
          <Button asChild size="lg">
            <Link href="/dashboard">Open App <ArrowRight className="w-4 h-4" /></Link>
          </Button>
        </motion.div>
      </PageShell>
    );
  }

  // ── Success state ──────────────────────────────────────────────────────────
  if (ui === 'success') {
    return (
      <PageShell>
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center text-center gap-6"
        >
          <div className="w-20 h-20 rounded-3xl overflow-hidden border-2 border-success/40 shadow-soft">
            <img src="/icon.png" alt={brand} className="w-full h-full object-cover" />
          </div>
          <div>
            <div className="flex items-center justify-center gap-2 text-success mb-2">
              <CheckCircle2 className="w-5 h-5" />
              <span className="text-sm font-semibold">Installed successfully!</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{brand} is installed</h1>
            <p className="text-muted-foreground text-sm mt-2">Find it in your home screen or app launcher.</p>
          </div>
          <Button asChild size="lg">
            <Link href="/dashboard">Open App <ArrowRight className="w-4 h-4" /></Link>
          </Button>
        </motion.div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-sm flex flex-col gap-6"
      >
        {/* App identity */}
        <div className="flex flex-col items-center text-center gap-4">
          <div className="w-20 h-20 rounded-3xl overflow-hidden border border-border shadow-soft">
            <img src="/icon.png" alt={brand} className="w-full h-full object-cover" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground" data-brand="text" suppressHydrationWarning>Install {brand}</h1>
            <p className="text-muted-foreground text-sm mt-1.5 leading-relaxed">
              Add to your home screen for instant access — no app store required.
            </p>
          </div>
        </div>

        {/* Feature pills */}
        <div className="flex flex-wrap justify-center gap-2">
          {['Works offline', 'Push notifications', 'Native feel', 'No app store'].map(f => (
            <span key={f} className="text-[11px] font-medium px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary">
              {f}
            </span>
          ))}
        </div>

        <AnimatePresence mode="wait">

          {/* ── iOS: static Safari share-button guide ── */}
          {platform === 'ios' && (
            <motion.div
              key="ios-card"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="glass rounded-2xl shadow-card p-5 flex flex-col gap-4"
            >
              {/* Header */}
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <Share2 className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">Add to Home Screen</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {browser === 'safari' ? 'iOS · Safari — 3 quick steps' : 'Open this page in Safari to install'}
                  </p>
                </div>
              </div>

              {/* Step 1 */}
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-xs font-bold text-primary">1</span>
                </div>
                <div className="flex-1">
                  <p className="text-xs font-bold text-primary mb-1">Tap the Share button</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Look for the{' '}
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted text-foreground font-medium text-[11px]">
                      <Share2 className="w-3 h-3" /> share
                    </span>{' '}
                    icon (box with an arrow) in <span className="text-foreground font-medium">Safari's bottom toolbar</span>.
                  </p>
                </div>
              </div>

              {/* Step 2 */}
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-xs font-bold text-primary">2</span>
                </div>
                <div className="flex-1">
                  <p className="text-xs font-bold text-primary mb-1">Tap "Add to Home Screen"</p>
                  <div className="flex items-center gap-2.5 p-2.5 rounded-xl bg-primary/10 border border-primary/20 mt-1">
                    <div className="w-9 h-9 rounded-xl bg-muted border border-border flex items-center justify-center flex-shrink-0">
                      <Plus className="w-4 h-4 text-foreground" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-foreground">Add to Home Screen</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">Scroll down if you don't see it</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Step 3 */}
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-xs font-bold text-primary">3</span>
                </div>
                <div className="flex-1">
                  <p className="text-xs font-bold text-primary mb-1">Tap "Add" to confirm</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Tap <span className="text-foreground font-medium">"Add"</span> in the top-right corner of the dialog.
                  </p>
                </div>
              </div>

              {/* Warn if not in Safari */}
              {browser !== 'safari' && (
                <div className="flex items-start gap-2 p-3 rounded-xl bg-warning/10 border border-warning/25">
                  <span className="text-warning flex-shrink-0 text-sm">💡</span>
                  <p className="text-[11px] text-warning leading-snug">
                    Must be done in Safari. Chrome and Firefox on iPhone cannot install web apps.
                  </p>
                </div>
              )}
            </motion.div>
          )}

          {/* ── One-click install (Chrome / Edge / Samsung, non-iOS) ── */}
          {platform !== 'ios' && (ui === 'idle' || ui === 'installing') && canOneClick && (
            <motion.div
              key="install-card"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="glass rounded-2xl shadow-card p-5 flex flex-col gap-4"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <Smartphone className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">Install App</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {browserDisplayName} · {platform === 'android' ? 'Android' : platform === 'windows' ? 'Windows' : platform}
                  </p>
                </div>
              </div>
              <Button
                onClick={handleInstall}
                disabled={ui === 'installing'}
                size="lg"
                className="w-full"
              >
                {ui === 'installing'
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Installing…</>
                  : <><Download className="w-4 h-4" /> Install App</>
                }
              </Button>
              <button
                onClick={() => setUI('instructions')}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors text-center"
              >
                Button not working? View manual steps →
              </button>
            </motion.div>
          )}

          {/* ── Manual instructions (non-iOS: macOS Safari / Firefox / Chrome fallback) ── */}
          {platform !== 'ios' && (ui === 'instructions' || !canOneClick) && (
            <motion.div
              key="steps-card"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="glass rounded-2xl shadow-card p-5 flex flex-col gap-4"
            >
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {platform === 'macos' && browser === 'safari'
                  ? 'Safari on macOS'
                  : browser === 'firefox'
                    ? 'Firefox — switch browser'
                    : 'Manual install steps'}
              </p>

              <div className="space-y-4">
                {steps.map((step, i) => {
                  const Icon = step.icon;
                  return (
                    <div key={i} className="flex items-start gap-4">
                      <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                        <Icon className="w-4 h-4 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0 pt-0.5">
                        <p className="text-xs font-bold text-primary mb-0.5">
                          Step {i + 1} · {step.label}
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">{step.desc}</p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {ui === 'instructions' && canOneClick && (
                <button
                  onClick={() => setUI('idle')}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors text-center"
                >
                  ← Back to install button
                </button>
              )}
            </motion.div>
          )}

        </AnimatePresence>

        {/* Sign-in link */}
        <div className="flex items-center justify-center gap-4 pt-2">
          <div className="h-px flex-1 bg-border" />
          <Link
            href="/login"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors whitespace-nowrap"
          >
            Already have an account? Sign in <ArrowRight className="w-3 h-3" />
          </Link>
          <div className="h-px flex-1 bg-border" />
        </div>
      </motion.div>
    </PageShell>
  );
}

// ─── Shared page shell ────────────────────────────────────────────────────────

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center p-6 safe-top">
      <div className="fixed top-0 left-0 right-0 flex items-center justify-between px-6 py-4 safe-top">
        <Link href="/" className="flex items-center gap-2.5">
          <img src="/icon.png" alt="" className="w-7 h-7 rounded-lg object-cover" />
          <span className="text-sm font-bold text-foreground">
            Pearl<span className="text-primary">Cluster</span>
          </span>
        </Link>
        <Link href="/login" className="text-xs text-muted-foreground hover:text-primary transition-colors">
          Sign in →
        </Link>
      </div>

      <div className="w-full max-w-sm mt-16">
        {children}
      </div>
    </div>
  );
}
