'use client';
import * as React from 'react';
import { motion, useReducedMotion, type Variants, type HTMLMotionProps } from 'framer-motion';
import { cn } from '@/lib/utils';

/* ════════════════════════════════════════════════════════════════════════════
   Shared motion primitives — consistent, tasteful animation across the app.
   All respect prefers-reduced-motion (fall back to instant / no transform).

   PERFORMANCE: every animation here is transform/opacity only (GPU-composited,
   no layout/paint), short (≤0.4s), and reduced-motion aware. Compose these
   instead of writing ad-hoc framer-motion so timing/easing/perf stay uniform.
   ════════════════════════════════════════════════════════════════════════════ */

export { AnimatePresence } from 'framer-motion';

const EASE = [0.22, 1, 0.36, 1] as const; // gentle "easeOutExpo"-ish

// Shared transition presets.
export const springs = {
  soft:   { type: 'spring', stiffness: 300, damping: 30 } as const,
  snappy: { type: 'spring', stiffness: 500, damping: 32 } as const,
  gentle: { duration: 0.35, ease: EASE } as const,
};

// ─── Variants (exported for ad-hoc use) ────────────────────────────────────────
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.3, ease: EASE } },
};

export const staggerContainer: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } },
};

// ─── Reveal: fade + rise on mount ──────────────────────────────────────────────
interface RevealProps extends Omit<HTMLMotionProps<'div'>, 'variants' | 'initial' | 'animate'> {
  delay?: number;
  y?: number;
  as?: 'div' | 'section' | 'li' | 'header';
}

export function Reveal({ children, className, delay = 0, y = 12, as = 'div', ...props }: RevealProps) {
  const reduce = useReducedMotion();
  const Comp = motion[as] as typeof motion.div;
  return (
    <Comp
      initial={reduce ? false : { opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE, delay }}
      className={className}
      {...props}
    >
      {children}
    </Comp>
  );
}

// ─── Stagger: container that reveals its <StaggerItem> children in sequence ─────
interface StaggerProps extends Omit<HTMLMotionProps<'div'>, 'variants' | 'initial' | 'animate'> {
  gap?: number;
  delay?: number;
}

export function Stagger({ children, className, gap = 0.06, delay = 0.04, ...props }: StaggerProps) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : 'hidden'}
      animate="show"
      variants={{ hidden: {}, show: { transition: { staggerChildren: gap, delayChildren: delay } } }}
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  );
}

interface StaggerItemProps extends Omit<HTMLMotionProps<'div'>, 'variants'> {
  y?: number;
}

export function StaggerItem({ children, className, y = 10, ...props }: StaggerItemProps) {
  return (
    <motion.div
      variants={{ hidden: { opacity: 0, y }, show: { opacity: 1, y: 0, transition: { duration: 0.38, ease: EASE } } }}
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  );
}

// ─── PageTransition: wrap a page's root content for a smooth entrance ───────────
export function PageTransition({ children, className }: { children: React.ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ─── MotionCard: subtle hover lift + tap press for interactive cards ────────────
export function MotionCard({ children, className, lift = true, ...props }: HTMLMotionProps<'div'> & { lift?: boolean }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      whileHover={reduce || !lift ? undefined : { y: -2 }}
      whileTap={reduce || !lift ? undefined : { scale: 0.985 }}
      transition={{ type: 'spring', stiffness: 400, damping: 28 }}
      className={cn('transition-shadow hover:shadow-soft', className)}
      {...props}
    >
      {children}
    </motion.div>
  );
}

// ─── Pressable: tactile hover-lift + tap-press for any interactive element ───────
export function Pressable({ children, className, lift = -2, ...props }: HTMLMotionProps<'div'> & { lift?: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      whileHover={reduce ? undefined : { y: lift }}
      whileTap={reduce ? undefined : { scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 400, damping: 26 }}
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  );
}

// ─── Pop: spring scale + fade in on mount (icons, badges, dialogs, counts) ───────
export function Pop({ children, className, delay = 0, ...props }: HTMLMotionProps<'div'> & { delay?: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: 'spring', stiffness: 500, damping: 24, delay }}
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  );
}

// ─── AnimatedItem: for AnimatePresence lists (rows entering / leaving) ───────────
export function AnimatedItem({ children, className, ...props }: HTMLMotionProps<'div'>) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.98 }}
      transition={{ duration: 0.25, ease: EASE }}
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  );
}
