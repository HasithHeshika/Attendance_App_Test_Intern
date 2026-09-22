'use client';

import { useState } from 'react';
import { Zap, RefreshCw, X, Sparkles } from 'lucide-react';
import { APP_VERSION } from '@/lib/version';
import { useBrandName } from '@/lib/brand';

interface UpdateNotificationBannerProps {
  onReload: () => void;
  onDismiss: () => void;
}

export default function UpdateNotificationBanner({
  onReload,
  onDismiss,
}: UpdateNotificationBannerProps) {
  const brand = useBrandName();
  const [isReloading, setIsReloading] = useState(false);

  const handleReloadClick = () => {
    setIsReloading(true);
    onReload();
  };

  return (
    <div className="relative overflow-hidden rounded-2xl border border-sky-500/30 bg-card/95 backdrop-blur-xl p-4 shadow-2xl shadow-sky-500/10 transition-all duration-300 hover:border-sky-500/40 w-full max-w-[380px]">
      {/* Decorative background glow gradient */}
      <div className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-gradient-to-br from-sky-500/20 via-primary/10 to-transparent blur-2xl" />
      <div className="pointer-events-none absolute -bottom-10 -left-10 h-28 w-28 rounded-full bg-gradient-to-tr from-indigo-500/15 via-sky-400/10 to-transparent blur-xl" />

      <div className="relative flex items-start gap-3.5">
        {/* Animated Icon Badge */}
        <div className="relative shrink-0 mt-0.5">
          <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white shadow-md shadow-sky-500/25">
            <Zap className="h-5 w-5 fill-white/20 text-white animate-pulse" />
          </div>
          <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500 ring-2 ring-card">
            <span className="h-1.5 w-1.5 rounded-full bg-white animate-ping" />
          </span>
        </div>

        {/* Text Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-bold tracking-tight text-foreground flex items-center gap-1.5">
              Update Available
            </h4>
            <span className="inline-flex items-center gap-0.5 rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-400 border border-sky-500/20">
              <Sparkles className="h-2.5 w-2.5" />
              v{APP_VERSION}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            A new version of {brand} is ready. Reload to get the latest updates.
          </p>

          {/* Action Row */}
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={handleReloadClick}
              disabled={isReloading}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-sky-500 to-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm shadow-sky-500/25 transition-all hover:brightness-110 hover:shadow-sky-500/40 active:scale-95 disabled:opacity-80"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isReloading ? 'animate-spin' : ''}`} />
              {isReloading ? 'Reloading...' : 'Reload Now'}
            </button>
            <button
              onClick={onDismiss}
              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              Later
            </button>
          </div>
        </div>

        {/* Close Button */}
        <button
          onClick={onDismiss}
          className="shrink-0 rounded-lg p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground transition-colors"
          aria-label="Dismiss update banner"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
