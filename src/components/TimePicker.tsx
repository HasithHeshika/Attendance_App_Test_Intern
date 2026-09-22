'use client';
import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Clock, Check } from 'lucide-react';

// Custom 24h hour/minute picker — same trigger + popup structure as Select.tsx (positioning,
// outside-click close, motion) so it sits visually consistent with the rest of the form
// controls instead of falling back to the browser's native <input type="time"> chrome. The
// trigger itself is a digit-masked text input (type "0830" → "08:30"), so a time can be typed
// directly as well as clicked from the hour/minute lists — strictly 24h throughout, no AM/PM.
interface Props {
  value: string;               // "HH:MM" (24h), or '' for unset
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

const HOURS   = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

// Mask: up to 4 raw digits, formatted as "HH:MM" once 3+ have been typed (first 2 digits are
// always the hour, next 2 the minute — same fixed layout as a card-expiry mask).
function maskDigits(digits: string): string {
  return digits.length <= 2 ? digits : `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
}
// Only a complete 4-digit entry commits — "0830" → "08:30". Anything short, or out of the
// 00-23 / 00-59 range, is invalid.
function parseDigits(digits: string): string | null {
  if (digits.length !== 4) return null;
  const h = Number(digits.slice(0, 2));
  const m = Number(digits.slice(2, 4));
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return maskDigits(digits);
}

export default function TimePicker({ value, onChange, placeholder = 'HH:MM', disabled = false, className = '' }: Props) {
  const [open, setOpen]     = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [digits, setDigits] = useState(value.replace(':', ''));
  const [invalid, setInvalid] = useState(false);
  const ref           = useRef<HTMLDivElement>(null);
  const hourListRef   = useRef<HTMLDivElement>(null);
  const minuteListRef = useRef<HTMLDivElement>(null);

  const [hh, mm] = value ? value.split(':') : ['', ''];

  // Keep the typed digits in sync with the committed value — whether it changed from a list
  // click, a valid parse, or the parent resetting the form (e.g. opening a different shift).
  useEffect(() => { setDigits(value.replace(':', '')); setInvalid(false); }, [value]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); commitDigits(); }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
    // commitDigits closes over current `digits`/`value` each render, which is what we want here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits, value]);

  // Scroll the currently-selected hour/minute into view whenever the dropdown opens.
  useEffect(() => {
    if (!open) return;
    const scrollTo = (listEl: HTMLDivElement | null, index: number) => {
      const item = listEl?.children[index] as HTMLElement | undefined;
      item?.scrollIntoView({ block: 'center' });
    };
    scrollTo(hourListRef.current, hh ? Number(hh) : 0);
    scrollTo(minuteListRef.current, mm ? Number(mm) : 0);
    // Only re-run when the popup opens, not on every value change while it's open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggle = () => {
    if (disabled) return;
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - 12;
      const spaceAbove = rect.top - 12;
      setDropUp(spaceBelow < 240 && spaceAbove > spaceBelow);
    }
    setOpen(o => !o);
  };

  const pickHour   = (h: string) => onChange(`${h}:${mm || '00'}`);
  const pickMinute = (m: string) => onChange(`${hh || '00'}:${m}`);

  // Validates the typed digits on blur / Enter. A complete, in-range time commits via
  // onChange; an empty field clears the value; anything else is rejected and reverted, with a
  // brief invalid flash.
  const commitDigits = () => {
    if (!digits) { if (value) onChange(''); setInvalid(false); return; }
    const parsed = parseDigits(digits);
    if (parsed) { onChange(parsed); setInvalid(false); }
    else { setDigits(value.replace(':', '')); setInvalid(true); }
  };

  return (
    <div className={`relative ${className}`} ref={ref}>
      <div
        className={`h-9 w-full flex items-center gap-2 bg-card border rounded-md pl-3 pr-1.5 text-sm transition-colors ${
          invalid ? 'border-destructive' : open ? 'border-primary/50 ring-2 ring-ring ring-offset-1 ring-offset-background' : 'border-border'
        } ${disabled ? 'opacity-50' : ''}`}
      >
        <Clock className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={maskDigits(digits)}
          disabled={disabled}
          placeholder={placeholder}
          onChange={e => { setDigits(e.target.value.replace(/\D/g, '').slice(0, 4)); setInvalid(false); }}
          onKeyDown={e => { if (e.key === 'Enter') { commitDigits(); (e.target as HTMLInputElement).blur(); } }}
          onBlur={commitDigits}
          className="flex-1 min-w-0 bg-transparent outline-none text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        <button
          type="button"
          disabled={disabled}
          tabIndex={-1}
          onClick={toggle}
          className={`flex-shrink-0 rounded p-1 transition-colors ${disabled ? 'cursor-not-allowed' : 'text-muted-foreground hover:text-foreground hover:bg-accent'}`}
          aria-label="Pick a time"
        >
          <Clock className="w-3.5 h-3.5" />
        </button>
      </div>
      {invalid && <p className="text-[11px] text-destructive mt-1">Invalid time — enter a 24-hour HH:MM (e.g. 0830, 1730)</p>}

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: dropUp ? 6 : -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: dropUp ? 6 : -6, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className={`absolute left-0 z-50 flex w-36 rounded-md border border-border bg-popover text-popover-foreground shadow-popover overflow-hidden ${
              dropUp ? 'bottom-full mb-2' : 'top-full mt-2'
            }`}
          >
            <div ref={hourListRef} className="flex-1 max-h-56 overflow-y-auto scrollbar-thin border-r border-border py-1">
              {HOURS.map(h => {
                const isSel = h === hh;
                return (
                  <button key={h} type="button" onClick={() => pickHour(h)}
                    className={`w-full flex items-center justify-between gap-1.5 px-3 py-1.5 text-sm transition-colors ${
                      isSel ? 'bg-primary/10 text-primary font-medium' : 'text-foreground hover:bg-accent'
                    }`}>
                    {h}
                    {isSel && <Check className="w-3 h-3 flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
            <div ref={minuteListRef} className="flex-1 max-h-56 overflow-y-auto scrollbar-thin py-1">
              {MINUTES.map(m => {
                const isSel = m === mm;
                return (
                  <button key={m} type="button" onClick={() => pickMinute(m)}
                    className={`w-full flex items-center justify-between gap-1.5 px-3 py-1.5 text-sm transition-colors ${
                      isSel ? 'bg-primary/10 text-primary font-medium' : 'text-foreground hover:bg-accent'
                    }`}>
                    {m}
                    {isSel && <Check className="w-3 h-3 flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
