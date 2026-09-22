'use client';
import { motion } from 'framer-motion';
import { useT } from '@/store/appStore';

// Professional preloader shown during the post-login reveal while the 3D bundle,
// the card model and the dashboard settle — so the physics drop only starts once
// the main thread is calm (no jank/crash). Built on the project's motion stack.
export default function LanyardPreloader({ progress }: { progress: number }) {
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-8 text-center">
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: -8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="relative flex h-20 w-20 items-center justify-center rounded-3xl bg-white/10 ring-1 ring-white/15 backdrop-blur-sm"
      >
        <motion.span
          aria-hidden
          className="absolute inset-0 rounded-3xl ring-2 ring-white/20"
          animate={{ scale: [1, 1.18, 1], opacity: [0.5, 0, 0.5] }}
          transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
        />
        <img src="/icon.png" alt="" className="h-10 w-10 rounded-xl object-contain" />
      </motion.div>

      <div className="space-y-1.5">
        <div className="text-base font-semibold text-white">{t.lanyardPreparing}</div>
        <div className="text-xs text-white/55">{t.lanyardPreparingSub}</div>
      </div>

      <div className="relative h-1.5 w-64 overflow-hidden rounded-full bg-white/15">
        <motion.div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-primary to-brand"
          animate={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          transition={{ ease: 'easeOut', duration: 0.4 }}
        />
        <motion.div
          aria-hidden
          className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/40 to-transparent"
          animate={{ x: ['-120%', '420%'] }}
          transition={{ repeat: Infinity, duration: 1.25, ease: 'linear' }}
        />
      </div>

      <div className="font-mono text-[11px] tabular-nums text-white/45">{Math.round(progress)}%</div>
    </div>
  );
}
