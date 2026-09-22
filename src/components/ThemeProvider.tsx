'use client';
import { useEffect } from 'react';
import { useAppStore, type Theme } from '@/store/appStore';

// Applies the correct class to <html> based on the theme setting.
// Must run client-side — theme is stored in localStorage, not available on server.
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark);
  root.classList.toggle('dark',  isDark);
  root.classList.toggle('light', !isDark);
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useAppStore(s => s.theme);

  // Apply on mount and whenever theme changes
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Also react to system preference changes when theme === 'system'
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  return <>{children}</>;
}
