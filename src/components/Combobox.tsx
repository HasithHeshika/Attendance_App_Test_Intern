'use client';
import { useState, useRef, useEffect, useId, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Check, Plus } from 'lucide-react';
import Portal from '@/components/Portal';

type Opt = { value: string; label: string; sublabel?: string };
interface Props {
  value: string;
  onChange: (value: string) => void;
  // Either plain strings (value === label) or {value,label} pairs (e.g. company id → name).
  // An optional `sublabel` renders as a muted second line and is also matched when filtering.
  options: Array<string | Opt>;
  placeholder?: string;
  allowCustom?: boolean;   // let the typed text stand as a custom value (default true)
  disabled?: boolean;
  id?: string;
}

interface MenuPos { left: number; top: number; bottom: number; width: number }

// A searchable single-select where the FIELD ITSELF is the search input (a combobox) — type
// to filter, pick from the list, or (allowCustom) keep your own typed value. No separate
// search bar. The dropdown is portalled with fixed positioning so it's never clipped by a
// scrolling/overflow parent (e.g. a modal). Supports {value,label} options: the input shows
// the LABEL while the committed value is the option's `value`.
export default function Combobox({
  value, onChange, options, placeholder = 'Select or type…', allowCustom = true, disabled, id,
}: Props) {
  const opts: Opt[]   = options.map(o => (typeof o === 'string' ? { value: o, label: o } : o));
  const selectedLabel = opts.find(o => o.value === value)?.label ?? (allowCustom ? value : '');

  const [open, setOpen]       = useState(false);
  const [touched, setTouched] = useState(false); // true once the user types (enables filtering)
  const [query, setQuery]     = useState('');
  const [dropUp, setDropUp]   = useState(false);
  const [maxH, setMaxH]       = useState(288);
  const [pos, setPos]         = useState<MenuPos | null>(null);
  const ref      = useRef<HTMLDivElement>(null);
  const menuRef  = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId   = useId();

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r     = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up    = below < 240 && above > below;
    setDropUp(up);
    setMaxH(Math.max(160, Math.min(320, up ? above : below)));
    setPos({ left: r.left, top: r.top, bottom: r.bottom, width: r.width });
  }, []);

  const openMenu = () => { if (disabled) return; measure(); setOpen(true); };

  // Close (and discard the in-progress query) when a press lands outside field + menu.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setTouched(false); setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    const on = () => measure();
    window.addEventListener('scroll', on, true);
    window.addEventListener('resize', on);
    return () => { window.removeEventListener('scroll', on, true); window.removeEventListener('resize', on); };
  }, [open, measure]);

  // Keep the portalled menu locked to the field while open even as ancestors settle — a dialog's
  // open animation (transform) moves the field but fires no scroll/resize event, so re-measure each
  // animation frame until the field's rect holds steady, then stop (bounded, so it never busy-loops).
  useEffect(() => {
    if (!open) return;
    let raf = 0, frames = 0, stable = 0, prev = '';
    const tick = () => {
      frames += 1;
      const el = ref.current;
      if (el) {
        const r   = el.getBoundingClientRect();
        const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}`;
        if (key !== prev) { prev = key; stable = 0; measure(); } else { stable += 1; }
      }
      if (stable < 3 && frames < 90) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open, measure]);

  useEffect(() => {
    const el = menuRef.current;
    if (!el || !open) return;
    const stopScrollBubble = (e: Event) => { e.stopPropagation(); };
    el.addEventListener('wheel', stopScrollBubble, { passive: false });
    el.addEventListener('touchmove', stopScrollBubble, { passive: false });
    return () => {
      el.removeEventListener('wheel', stopScrollBubble);
      el.removeEventListener('touchmove', stopScrollBubble);
    };
  }, [open]);

  // While actively typing show the query; otherwise show the selected option's label.
  const displayValue = touched ? query : selectedLabel;
  const typed        = query.trim();
  const filtered = touched && typed
    ? opts.filter(o => {
        const q = typed.toLowerCase();
        return o.label.toLowerCase().includes(q) || !!o.sublabel?.toLowerCase().includes(q);
      })
    : opts;
  const exact      = opts.some(o => o.label.toLowerCase() === typed.toLowerCase());
  const showCreate = allowCustom && touched && typed.length > 0 && !exact;

  const pickOpt = (o: Opt) => { onChange(o.value); setQuery(''); setTouched(false); setOpen(false); inputRef.current?.blur(); };
  const pickCustom = () => { onChange(typed); setQuery(''); setTouched(false); setOpen(false); inputRef.current?.blur(); };

  const menuStyle: React.CSSProperties = pos
    ? {
        position: 'fixed',
        left: pos.left,
        width: pos.width,
        maxHeight: maxH,
        zIndex: 200,
        // The menu is portalled to <body>. A modal Radix dialog sets pointer-events:none on
        // everything outside its content, which would make these options unclickable — re-enable
        // pointer events on the menu so a pick still registers inside a dialog.
        pointerEvents: 'auto',
        ...(dropUp ? { bottom: window.innerHeight - pos.top + 8 } : { top: pos.bottom + 8 }),
      }
    : {};

  return (
    <div className="relative" ref={ref}>
      <div
        className={`h-9 flex items-center gap-1 rounded-md border bg-card pl-3 pr-2 transition-colors ${
          open ? 'border-primary/50 ring-2 ring-ring ring-offset-1 ring-offset-background' : 'border-border'
        } ${disabled ? 'opacity-50' : ''}`}
      >
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          value={displayValue}
          disabled={disabled}
          placeholder={placeholder}
          // A plain <input> just hard-clips overflow with no visual cue — text-overflow:ellipsis
          // (needs the pair of overflow-hidden + whitespace-nowrap below to apply) shows "…" for
          // a selected label wider than the field, and the title gives the full value on hover
          // as a fallback for whenever it's still cut off.
          title={!touched && selectedLabel ? selectedLabel : undefined}
          // Open only on real user intent (a click below, ArrowDown/typing further down) — NOT on
          // plain focus, so a dialog auto-focusing this field on open doesn't pop the menu (which
          // would then measure the field mid-open-animation and mis-place the portal). Using click
          // (not pointerdown) also lets a touch-drag that starts on the field scroll without opening,
          // and works on engines that don't dispatch Pointer Events.
          onFocus={() => { setTouched(false); }}
          onClick={() => openMenu()}
          onChange={(e) => {
            setQuery(e.target.value); setTouched(true);
            if (allowCustom) onChange(e.target.value);   // free-text commits live; picks set the value
            if (!open) openMenu(); else measure();
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && !open) { openMenu(); return; }
            if (e.key === 'Enter') {
              if (!open) return;                 // menu closed → let Enter do its default; never auto-pick opts[0]
              e.preventDefault();
              if (filtered.length) pickOpt(filtered[0]);
              else if (showCreate) pickCustom();
            } else if (e.key === 'Escape') {
              setTouched(false); setOpen(false); inputRef.current?.blur();
            }
          }}
          className="w-full truncate bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed"
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-label="Toggle options"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { if (open) setOpen(false); else { inputRef.current?.focus(); openMenu(); } }}
          className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground disabled:pointer-events-none"
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      <Portal>
        <AnimatePresence>
          {open && pos && (filtered.length > 0 || showCreate) && (
            <motion.ul
              ref={menuRef}
              id={listId}
              role="listbox"
              data-combobox-menu=""
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
              initial={{ opacity: 0, y: dropUp ? 6 : -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: dropUp ? 6 : -6, scale: 0.98 }}
              transition={{ duration: 0.12 }}
              style={menuStyle}
              className="overflow-y-auto overscroll-contain rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-popover scrollbar-thin"
            >
              {filtered.map((o) => {
                const sel = o.value === value;
                return (
                  <li key={o.value} role="option" aria-selected={sel}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickOpt(o)}
                      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                        sel ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-accent'
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{o.label}</span>
                        {o.sublabel && (
                          <span className="block truncate text-[11px] text-muted-foreground">{o.sublabel}</span>
                        )}
                      </span>
                      {sel && <Check className="h-3.5 w-3.5 flex-shrink-0 text-primary" />}
                    </button>
                  </li>
                );
              })}
              {showCreate && (
                <li role="option" aria-selected={false}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={pickCustom}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-accent"
                  >
                    <Plus className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <span className="truncate">Use “{typed}”</span>
                  </button>
                </li>
              )}
            </motion.ul>
          )}
        </AnimatePresence>
      </Portal>
    </div>
  );
}
