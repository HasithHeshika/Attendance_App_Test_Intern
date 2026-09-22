'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLanyardStore } from '@/store/lanyardStore';
import { useT } from '@/store/appStore';
import LanyardStaticCard from './LanyardStaticCard';
import LanyardPreloader from './LanyardPreloader';
import LanyardErrorBoundary from './LanyardErrorBoundary';

// Heavy 3D bundle — only fetched when the overlay actually opens.
const LanyardCard = dynamic(() => import('./LanyardCard'), { ssr: false });

const MIN_LOAD    = 900;   // login: minimum preloader time
const CAP_LOAD    = 7000;  // login: force-reveal cap (don't wait forever)
const REVEAL_HOLD = 4000;  // login: card dangles 4s after it actually becomes visible
const STUCK_CLOSE = 10000; // login: hard retract if the card never becomes ready (can't hang)
const MANUAL_HOLD = 10000; // sidebar/profile: dangle 10s
const MAX_RESTARTS = 5;    // hard ceiling on silent auto-restarts per session

// Watchdog: if onReady hasn't fired within this many ms of a (re)mount, the
// canvas is stuck/invisible — remount silently. Set slightly above CAP_LOAD.
const WATCHDOG_MS = CAP_LOAD + 1500;

export default function LanyardOverlay() {
  const router  = useRouter();
  const t       = useT();
  const open    = useLanyardStore(s => s.open);
  const mode    = useLanyardStore(s => s.mode);
  const close   = useLanyardStore(s => s.close);
  const reduce  = useReducedMotion();

  const [phase,    setPhase]    = useState<'loading' | 'reveal'>('reveal');
  const [progress, setProgress] = useState(0);
  const cardReady   = useRef(false);
  // Render-time mirror of cardReady: gates the preloader and the auto-retract timer so the
  // overlay never reveals/closes on a card that hasn't actually painted yet.
  const [ready, setReady] = useState(false);

  // ── silent restart machinery ─────────────────────────────────────────────
  // cardKey: incrementing this force-remounts the entire LanyardCard tree.
  const [cardKey,      setCardKey]      = useState(0);
  const restartCount   = useRef(0);
  const watchdogTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearWatchdog = useCallback(() => {
    if (watchdogTimer.current) { clearTimeout(watchdogTimer.current); watchdogTimer.current = null; }
  }, []);

  // Arm/re-arm the watchdog every time cardKey changes (i.e. on every mount).
  useEffect(() => {
    if (!open || reduce) return;
    clearWatchdog();
    watchdogTimer.current = setTimeout(() => {
      if (!cardReady.current && restartCount.current < MAX_RESTARTS) {
        console.warn('[Lanyard] watchdog: card never became ready — silent remount');
        restartCount.current += 1;
        setCardKey(k => k + 1);
      }
    }, WATCHDOG_MS);
    return clearWatchdog;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reduce, cardKey]);

  // Called by the error boundary on crash → silent immediate remount.
  const handleCrash = useCallback(() => {
    if (restartCount.current >= MAX_RESTARTS) {
      console.warn('[Lanyard] max restarts reached — giving up');
      return;
    }
    restartCount.current += 1;
    cardReady.current = false;
    setReady(false);
    setCardKey(k => k + 1);
  }, []);

  // Called when the card signals its textures + physics are ready.
  const handleReady = useCallback(() => {
    cardReady.current = true;
    setReady(true);
    clearWatchdog();          // cancel watchdog — card is alive
    restartCount.current = 0; // success → reset the failure counter
  }, [clearWatchdog]);
  // ─────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) { restartCount.current = 0; setReady(false); return; }
    cardReady.current = false;
    setReady(false);
    if (mode === 'loginReveal' && !reduce) { setPhase('loading'); setProgress(0); }
    else setPhase('reveal');
  }, [open, mode, reduce]);

  // Login loading: ramp progress bar, reveal once card is ready + dashboard ready.
  useEffect(() => {
    if (!open || mode !== 'loginReveal' || reduce || phase !== 'loading') return;
    const start = Date.now();
    let raf = 0;
    let doneTimer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const e = Date.now() - start;
      const dashReady = useLanyardStore.getState().dashboardReadyAt != null;
      let target = Math.min(88, (e / 2200) * 88);
      if (cardReady.current) target = Math.max(target, 78);
      if (dashReady)         target = Math.max(target, 92);
      const done = (e >= MIN_LOAD && cardReady.current && (dashReady || e >= 3500)) || e >= CAP_LOAD;
      if (done) {
        setProgress(100);
        doneTimer = setTimeout(() => setPhase('reveal'), 320);
        return;
      }
      setProgress(p => Math.max(p, target));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); if (doneTimer) clearTimeout(doneTimer); };
  }, [open, mode, reduce, phase]);

  // Auto-retract timers — only fire if the session is not already closed.
  useEffect(() => {
    if (!open) return;
    if (mode === 'manual') {
      const id = setTimeout(() => close(), MANUAL_HOLD);
      return () => clearTimeout(id);
    }
    if (mode === 'loginReveal' && phase === 'reveal') {
      // Only start the dangle-then-retract countdown once the card is actually visible, so a
      // slow texture/WebGL init (or a brief auth-hydration gap) can't make the reveal close on
      // an empty overlay. When `ready` flips true this effect re-runs and starts the real
      // 4s hold from that moment. STUCK_CLOSE still retracts if it never becomes ready.
      const id = setTimeout(() => close(), ready ? REVEAL_HOLD : STUCK_CLOSE);
      return () => clearTimeout(id);
    }
  }, [open, mode, phase, ready, close]);

  // Esc closes manual mode only.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && mode === 'manual') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, mode, close]);

  // Clicking the dark backdrop closes in manual mode only.
  const dismissibleClick = () => { if (mode === 'manual') close(); };
  const goProfile = () => { close(); router.push('/profile'); };

  // Keep the preloader up through the reveal until the card is genuinely ready, so the overlay
  // never shows a blank dark screen while textures / WebGL / auth are still settling.
  const showPreloader = mode === 'loginReveal' && !reduce && (phase === 'loading' || !ready);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35 }}
          onClick={dismissibleClick}
          className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-md"
        >
          {reduce ? (
            // Reduced-motion: static image, no 3D at all.
            <div className="absolute inset-0"><LanyardStaticCard className="h-full" /></div>

          ) : mode === 'loginReveal' ? (
            // Login: mount paused behind the preloader, fade in on reveal.
            <motion.div
              className="absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: phase === 'reveal' ? 1 : 0 }}
              transition={{ duration: 0.5 }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* key={cardKey} ensures a full remount on silent restart */}
              <LanyardErrorBoundary key={cardKey} resetKey={cardKey} onReset={handleCrash}>
                <LanyardCard
                  paused={phase !== 'reveal'}
                  spin
                  position={[0, 0, 14]}
                  gravity={[0, -40, 0]}
                  onReady={handleReady}
                />
              </LanyardErrorBoundary>
            </motion.div>

          ) : (
            // Manual: interactive, clicking outside (canvas background) closes.
            <div className="absolute inset-0" onClick={(e) => e.stopPropagation()}>
              <LanyardErrorBoundary key={cardKey} resetKey={cardKey} onReset={handleCrash}>
                <LanyardCard
                  spin
                  autoRotate
                  position={[0, 0, 14]}
                  gravity={[0, -40, 0]}
                  onReady={handleReady}
                  onPointerMissed={dismissibleClick}
                />
              </LanyardErrorBoundary>
            </div>
          )}

          {/* Preloader (login mode only) */}
          <AnimatePresence>
            {showPreloader && (
              <motion.div
                key="preloader"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="absolute inset-0 z-[2]"
              >
                <LanyardPreloader progress={progress} />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Close button — manual mode only */}
          {mode === 'manual' && (
            <button
              onClick={(e) => { e.stopPropagation(); close(); }}
              aria-label={t.closeMenu}
              style={{ backgroundColor: 'rgba(15,23,42,0.85)', color: '#ffffff' }}
              className="absolute right-5 top-5 z-10 flex h-10 w-10 items-center justify-center rounded-full ring-1 ring-white/40 shadow-lg backdrop-blur-sm transition-[filter] hover:brightness-125"
            >
              <X className="h-5 w-5" strokeWidth={2.5} color="#ffffff" />
            </button>
          )}

          {/* Bottom actions */}
          <div className="pointer-events-none absolute inset-x-0 bottom-10 z-10 flex flex-col items-center gap-3 text-center">
            {mode === 'loginReveal' && phase === 'reveal' && (
              <div className="text-sm font-medium text-white/80">{t.lanyardWelcome}</div>
            )}
            {mode === 'manual' && (
              <button
                onClick={(e) => { e.stopPropagation(); goProfile(); }}
                className="pointer-events-auto rounded-full bg-white/90 px-5 py-2 text-sm font-semibold text-slate-900 shadow-lg transition-colors hover:bg-white"
              >
                {t.lanyardViewProfile}
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
