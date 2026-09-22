'use client';
import { useRef, useState, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';

const THRESHOLD = 72;  // px — pull distance that triggers refresh
const MAX_PULL  = 110; // px — maximum indicator travel

export default function PullToRefresh({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef    = useRef(0);
  const pullingRef   = useRef(false);
  const [pullY,      setPullY]      = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const onTouchStart = useCallback((e: TouchEvent) => {
    const el = containerRef.current;
    if (!el || el.scrollTop > 0) return;
    startYRef.current  = e.touches[0].clientY;
    pullingRef.current = true;
  }, []);

  const onTouchMove = useCallback((e: TouchEvent) => {
    if (!pullingRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    const delta = e.touches[0].clientY - startYRef.current;
    if (delta <= 0 || el.scrollTop > 0) {
      pullingRef.current = false;
      setPullY(0);
      return;
    }
    e.preventDefault(); // requires non-passive listener
    // Exponential ease-out so pulling feels springy
    const eased = MAX_PULL * (1 - Math.exp(-delta / MAX_PULL));
    setPullY(eased);
  }, []);

  const onTouchEnd = useCallback(() => {
    if (!pullingRef.current) return;
    pullingRef.current = false;
    setPullY(prev => {
      if (prev >= THRESHOLD) {
        setRefreshing(true);
        setTimeout(() => window.location.reload(), 350);
        return THRESHOLD; // hold in place while reloading
      }
      return 0;
    });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('touchstart', onTouchStart, { passive: true  });
    el.addEventListener('touchmove',  onTouchMove,  { passive: false }); // non-passive to allow preventDefault
    el.addEventListener('touchend',   onTouchEnd,   { passive: true  });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove',  onTouchMove);
      el.removeEventListener('touchend',   onTouchEnd);
    };
  }, [onTouchStart, onTouchMove, onTouchEnd]);

  const progress = Math.min(pullY / THRESHOLD, 1);
  const isReady  = progress >= 1;

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto scrollbar-none relative">
      {/* Indicator */}
      <div
        aria-hidden
        className="absolute left-0 right-0 flex justify-center z-20 pointer-events-none"
        style={{
          top: -48,
          transform: `translateY(${pullY}px)`,
          opacity: Math.max(0, (progress - 0.15) / 0.85),
          transition: (refreshing || pullingRef.current) ? 'none' : 'transform 0.3s ease, opacity 0.3s ease',
        }}
      >
        <div className={`w-9 h-9 rounded-full flex items-center justify-center shadow-soft border transition-colors ${
          isReady ? 'bg-primary/20 border-primary/40' : 'bg-card border-border'
        }`}>
          <RefreshCw
            className={`w-4 h-4 transition-colors ${isReady ? 'text-primary' : 'text-muted-foreground'} ${refreshing ? 'animate-spin' : ''}`}
            style={refreshing ? {} : { transform: `rotate(${progress * 270}deg)` }}
          />
        </div>
      </div>

      {/* Content slides down with the pull.
          IMPORTANT: only set transform when actually pulling — any transform (even translateY(0))
          makes this element the containing block for position:fixed children, breaking modals. */}
      <div
        style={pullY > 0 ? {
          transform: `translateY(${pullY}px)`,
          transition: (refreshing || pullingRef.current) ? 'none' : 'transform 0.3s ease',
        } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
