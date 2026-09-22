import type { Theme } from '@/store/appStore';

// Animated theme switch using the View Transitions API: a circular/clip reveal of
// the new theme over the old. Adapted from the animate-ui theme-toggler so it works
// with this app's dual `.dark` / `.light` class scheme (the vendored primitive only
// toggles `.dark`). Falls back to an instant switch where unsupported or when the
// user prefers reduced motion.

type Direction = 'btt' | 'ttb' | 'ltr' | 'rtl';

function resolve(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function clipKeyframes(direction: Direction): [string, string] {
  switch (direction) {
    case 'rtl': return ['inset(0 0 0 100%)', 'inset(0 0 0 0)'];
    case 'ttb': return ['inset(0 0 100% 0)', 'inset(0 0 0 0)'];
    case 'btt': return ['inset(100% 0 0 0)', 'inset(0 0 0 0)'];
    case 'ltr':
    default:    return ['inset(0 100% 0 0)', 'inset(0 0 0 0)'];
  }
}

function applyClasses(resolved: 'light' | 'dark') {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.classList.toggle('light', resolved !== 'dark');
}

type StartViewTransition = (cb: () => void) => { ready: Promise<void> };

export async function animateThemeChange(
  target: Theme,
  commit: (theme: Theme) => void,
  direction: Direction = 'ttb',
): Promise<void> {
  const resolved = resolve(target);
  const start = (document as Document & { startViewTransition?: StartViewTransition }).startViewTransition;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // No View Transitions support (or reduced motion) → just switch.
  if (!start || reduce) {
    commit(target);
    return;
  }

  const [fromClip, toClip] = clipKeyframes(direction);

  await start.call(document, () => {
    applyClasses(resolved);
  }).ready;

  document.documentElement
    .animate(
      { clipPath: [fromClip, toClip] },
      { duration: 600, easing: 'ease-in-out', pseudoElement: '::view-transition-new(root)' },
    )
    .finished.finally(() => {
      // Persist to the store; ThemeProvider re-applies the (identical) classes.
      commit(target);
    });
}
