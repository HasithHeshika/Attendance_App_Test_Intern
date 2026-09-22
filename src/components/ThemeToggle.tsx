'use client';
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Moon, Sun } from 'lucide-react';
import { useAppStore } from '@/store/appStore';
import { animateThemeChange } from '@/lib/themeTransition';
import { cn } from '@/lib/utils';

// Compact light/dark switch with the animated View-Transition reveal. Resolves
// `system` to the actual scheme so a tap flips to the opposite of what's shown.
export default function ThemeToggle({ className }: { className?: string }) {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const compute = () =>
      setIsDark(theme === 'dark' || (theme === 'system'
        && window.matchMedia('(prefers-color-scheme: dark)').matches));
    compute();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', compute);
    return () => mq.removeEventListener('change', compute);
  }, [theme]);

  const toggle = () => animateThemeChange(isDark ? 'light' : 'dark', setTheme);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle theme"
      className={cn(
        'relative w-9 h-9 rounded-lg border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground overflow-hidden transition-colors',
        className,
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={isDark ? 'moon' : 'sun'}
          initial={{ y: 12, opacity: 0, rotate: -30 }}
          animate={{ y: 0, opacity: 1, rotate: 0 }}
          exit={{ y: -12, opacity: 0, rotate: 30 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="absolute inset-0 flex items-center justify-center"
        >
          {isDark ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
