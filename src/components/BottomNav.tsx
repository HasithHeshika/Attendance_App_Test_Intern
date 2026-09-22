'use client';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence, useReducedMotion, type Transition } from 'framer-motion';
import { useSidebarNav } from '@/components/useSidebarNav';

// Largest set of destinations that still fits comfortably in a bottom tab bar.
// Roles with more than this keep the sidebar/drawer instead (decided in the layout).
export const BOTTOM_NAV_MAX = 5;

// Mobile-only floating bottom tab bar — a glassy pill that hovers above the content.
// Rendered only when the user's whole set of nav destinations fits (<= BOTTOM_NAV_MAX)
// so every item is shown, no "More" tab. Hidden at md+ where the sidebar takes over.
// Shares useSidebarNav() with the sidebar so the two never drift out of sync. It takes the
// flat `adminNav`, not the sidebar's collapsible `adminGroups` — a tab bar has nothing to
// collapse, and the flat list is those same groups concatenated in order.
export default function BottomNav() {
  const pathname = usePathname();
  const { navItems, adminNav } = useSidebarNav();
  const raw = [...navItems, ...adminNav];
  const reduce = !!useReducedMotion();

  // Surface Dashboard in the centre slot of the bar (the sidebar keeps its own order).
  // Everything else keeps its relative order around it.
  const dashIdx = raw.findIndex((i) => i.href === '/dashboard');
  const tabs =
    dashIdx === -1
      ? raw
      : (() => {
          const rest = raw.filter((_, i) => i !== dashIdx);
          const center = Math.floor(raw.length / 2);
          return [...rest.slice(0, center), raw[dashIdx], ...rest.slice(center)];
        })();

  // Safety guard — the layout gates on the same rule, but never overflow the bar.
  if (tabs.length === 0 || tabs.length > BOTTOM_NAV_MAX) return null;

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  // Shared spring vocabulary — matches the sidebar's gentle-bounce layout springs.
  // Reduced-motion collapses every transition to an instant cut.
  const pillSpring: Transition = reduce ? { duration: 0 } : { type: 'spring', bounce: 0.22, duration: 0.55 };
  const iconSpring: Transition = reduce ? { duration: 0 } : { type: 'spring', bounce: 0.34, duration: 0.5 };
  const labelSpring: Transition = reduce ? { duration: 0 } : { type: 'spring', bounce: 0.2, duration: 0.42 };
  const pressSpring: Transition = reduce ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 30 };

  return (
    // Full-width wrapper is click-through; only the floating capsule catches taps, so
    // content beside it (on wider phones) stays interactive.
    <nav
      aria-label="Primary"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.5rem)' }}
      className="md:hidden pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center px-3"
    >
      <div
        className="pointer-events-auto relative flex w-full max-w-md items-stretch justify-around gap-1 rounded-[1.9rem] border border-border/70 bg-background/80 p-1.5 backdrop-blur-2xl supports-[backdrop-filter]:bg-background/60"
        style={{
          boxShadow:
            'inset 0 1px 0 0 hsla(0,0%,100%,0.06), 0 12px 34px -12px rgba(2,6,23,0.32), 0 4px 12px -6px rgba(2,6,23,0.18)',
        }}
      >
        {/* Whisper of a top sheen — reads as a glass highlight in dark, vanishes on light. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-2 top-0 z-0 h-1/2 rounded-t-[1.6rem]"
          style={{ background: 'linear-gradient(to bottom, hsla(0,0%,100%,0.10), hsla(0,0%,100%,0) 72%)' }}
        />

        {tabs.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              className={`relative flex min-h-[3.5rem] min-w-0 flex-1 flex-col items-center justify-center rounded-[1.45rem] px-1 transition-colors duration-200 ${
                active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {/* Morphing active indicator — a soft brand-glowing pill that slides
                  between tabs via the shared layoutId. */}
              {active && (
                <motion.span
                  layoutId="bottomNavPill"
                  transition={pillSpring}
                  className="absolute inset-0 z-0 rounded-[1.45rem] bg-primary/15 ring-1 ring-inset ring-primary/25"
                  style={{
                    boxShadow:
                      '0 6px 20px -6px hsl(var(--primary) / 0.40), inset 0 1px 0 0 hsla(0,0%,100%,0.14)',
                  }}
                />
              )}

              {/* Icon + label group. whileTap gives a material press-in; the group is
                  vertically centred, so the label growing in gently lifts the icon. */}
              <motion.span
                className="relative z-10 flex flex-col items-center gap-1"
                whileTap={reduce ? undefined : { scale: 0.88 }}
                transition={pressSpring}
              >
                <motion.span
                  className="flex"
                  animate={reduce ? undefined : { scale: active ? 1.08 : 1, y: active ? -1 : 0 }}
                  transition={iconSpring}
                >
                  <item.icon className="h-5 w-5 flex-shrink-0" />
                </motion.span>

                {/* Label crossfades in for the active tab only; inactive tabs stay
                    icon-only (their name still reaches assistive tech via aria-label). */}
                <AnimatePresence initial={false}>
                  {active && (
                    <motion.span
                      key="label"
                      initial={{ opacity: 0, height: 0, y: -3 }}
                      animate={{ opacity: 1, height: 'auto', y: 0 }}
                      exit={{ opacity: 0, height: 0, y: -3 }}
                      transition={labelSpring}
                      className="max-w-full overflow-hidden truncate text-[10px] font-semibold leading-none tracking-tight"
                    >
                      {item.label}
                    </motion.span>
                  )}
                </AnimatePresence>
              </motion.span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
