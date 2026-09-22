'use client';
import { useState, useRef, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { LogIn, LogOut, Check } from 'lucide-react';

export function SwipeButton({
  onComplete, label, type, disabled, resetKey,
}: {
  onComplete: () => void;
  label:      string;
  type:       'checkin' | 'checkout';
  disabled?:  boolean;
  resetKey?:  number;
}) {
  const [dragging,  setDragging]  = useState(false);
  const [x,         setX]         = useState(0);
  const [completed, setCompleted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const startXRef    = useRef(0);

  useEffect(() => { setCompleted(false); setX(0); setDragging(false); }, [resetKey]);

  const maxX = () => (containerRef.current?.offsetWidth || 300) - 56;

  const handleMove = useCallback((clientX: number) => {
    if (!dragging) return;
    const nx = Math.max(0, Math.min(clientX - startXRef.current, maxX()));
    setX(nx);
    if (nx >= maxX() - 5) { setCompleted(true); setDragging(false); setX(maxX()); setTimeout(onComplete, 200); }
  }, [dragging, onComplete]);

  useEffect(() => {
    const mm  = (e: MouseEvent) => handleMove(e.clientX);
    const tm  = (e: TouchEvent) => handleMove(e.touches[0].clientX);
    const end = () => { if (dragging && !completed) { setDragging(false); setX(0); } };
    if (dragging) {
      window.addEventListener('mousemove', mm); window.addEventListener('mouseup', end);
      window.addEventListener('touchmove', tm); window.addEventListener('touchend', end);
    }
    return () => {
      window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', end);
      window.removeEventListener('touchmove', tm); window.removeEventListener('touchend', end);
    };
  }, [dragging, completed, handleMove]);

  return (
    <div
      ref={containerRef}
      className={`swipe-container ${type === 'checkin' ? 'swipe-track-checkin' : 'swipe-track-checkout'} select-none`}
      style={{ opacity: disabled ? 0.45 : 1, pointerEvents: disabled ? 'none' : 'auto' }}
    >
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span className={`text-sm font-semibold tracking-wide transition-opacity ${completed ? 'opacity-0' : 'opacity-100'} ${type === 'checkin' ? 'text-primary/70' : 'text-destructive/70'}`}>
          {label}
        </span>
      </div>
      <motion.div
        className={`swipe-thumb ${type === 'checkin' ? 'bg-primary' : 'bg-destructive'} shadow-card`}
        style={{ x }}
        animate={completed ? { scale: 1.1 } : {}}
        onMouseDown={e => { if (!disabled && !completed) { setDragging(true); startXRef.current = e.clientX - x; } }}
        onTouchStart={e => { if (!disabled && !completed) { setDragging(true); startXRef.current = e.touches[0].clientX - x; } }}
      >
        {completed ? <Check className="w-5 h-5 text-primary-foreground" /> : type === 'checkin' ? <LogIn className="w-5 h-5 text-primary-foreground" /> : <LogOut className="w-5 h-5 text-destructive-foreground" />}
      </motion.div>
    </div>
  );
}
