'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { Compass, Home, ArrowLeft } from 'lucide-react';
import { useT } from '@/store/appStore';
import { Button } from '@/components/ui/button';

const EASE = [0.22, 1, 0.36, 1] as const;

// Custom 404 — theme-aware (semantic tokens, works in both dark + light), brand
// azure accent, translated, and reduced-motion safe (no infinite animation).
export default function NotFound() {
  const t = useT();
  const router = useRouter();
  const reduce = useReducedMotion();

  return (
    <div className="relative flex min-h-[100dvh] w-full flex-col items-center justify-center overflow-hidden bg-background p-6">
      {/* Ambient azure glow + faint grid — all via tokens, so both themes look intentional. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: 'radial-gradient(46rem 34rem at 50% 38%, hsl(var(--primary) / 0.10), transparent 70%)' }}
      />
      <svg
        aria-hidden
        className="absolute inset-0 -z-10 h-full w-full text-border"
        style={{ maskImage: 'radial-gradient(60% 50% at 50% 42%, black, transparent)', WebkitMaskImage: 'radial-gradient(60% 50% at 50% 42%, black, transparent)' }}
      >
        <defs>
          <pattern id="nf-grid" width="48" height="48" patternUnits="userSpaceOnUse">
            <path d="M 48 0 L 0 0 0 48" fill="none" stroke="currentColor" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#nf-grid)" />
      </svg>

      <motion.div
        initial={reduce ? false : { opacity: 0, scale: 0.96, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE }}
        className="relative flex w-full max-w-md flex-col items-center rounded-3xl border border-border bg-card/80 p-8 text-center shadow-soft backdrop-blur-sm md:p-10"
      >
        <div className="mb-7 flex h-20 w-20 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Compass className="h-10 w-10" strokeWidth={1.5} />
        </div>

        <h1 className="font-mono text-7xl font-bold leading-none tracking-tight text-primary">404</h1>
        <h2 className="mt-4 text-xl font-semibold tracking-tight text-foreground">{t.notFoundTitle}</h2>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{t.notFoundDesc}</p>

        <div className="mt-8 flex w-full flex-col gap-2.5 sm:flex-row sm:justify-center">
          <Button asChild className="gap-2">
            <Link href="/dashboard">
              <Home className="h-4 w-4" /> {t.backToDashboard}
            </Link>
          </Button>
          <Button variant="outline" className="gap-2" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4" /> {t.goBack}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
