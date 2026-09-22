'use client';
import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';

interface CountUpProps {
  value: number;
  /** Animation length in seconds. */
  duration?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}

/**
 * Animates a number from 0 → value on mount (and on value change), easing out.
 * Respects prefers-reduced-motion: renders the final value instantly with no tween.
 * A tasteful V2 KPI micro-interaction — keep it short (≤1s) and only on numerics.
 */
export function CountUp({ value, duration = 0.9, decimals = 0, prefix = '', suffix = '', className }: CountUpProps) {
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(reduce ? value : 0);
  const rafRef = useRef<number | undefined>(undefined);
  const fromRef = useRef(0);

  useEffect(() => {
    if (reduce || duration <= 0) { setDisplay(value); return; }
    const from = fromRef.current;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / (duration * 1000));
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setDisplay(from + (value - from) * eased);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [value, duration, reduce]);

  const text = decimals > 0 ? display.toFixed(decimals) : Math.round(display).toLocaleString();
  return <span className={className}>{prefix}{text}{suffix}</span>;
}
