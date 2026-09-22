'use client';
import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronRight, ChevronDown, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  page: number;                 // 1-based
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions?: number[];
}

// Compact dropdown matching the app's custom Select styling
function PageSizeDropdown({ value, options, onChange }: {
  value: number; options: number[]; onChange: (v: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 bg-card border rounded-md pl-2.5 pr-2 py-1 text-xs text-foreground transition-colors ${
          open ? 'border-primary/50' : 'border-border hover:border-input'}`}>
        <span>{value}</span>
        <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className="absolute bottom-full left-0 mb-2 z-50 min-w-[64px] rounded-xl border border-border bg-popover shadow-card overflow-hidden py-1"
          >
            {options.map(opt => {
              const sel = opt === value;
              return (
                <button key={opt} type="button"
                  onClick={() => { onChange(opt); setOpen(false); }}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs transition-colors ${
                    sel ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'}`}>
                  {opt}
                  {sel && <Check className="w-3 h-3 text-primary" />}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Pagination({
  page, pageSize, total, onPageChange, onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
}: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to   = Math.min(page * pageSize, total);

  // Build a compact page-number window
  const pages: (number | '…')[] = [];
  const push = (p: number | '…') => pages.push(p);
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) push(i);
  } else {
    push(1);
    if (page > 3) push('…');
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) push(i);
    if (page < totalPages - 2) push('…');
    push(totalPages);
  }

  return (
    <div className="flex items-center justify-between gap-4 flex-wrap pt-2">
      {/* Range + page size */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>
          {from}–{to} of <span className="text-foreground font-medium">{total}</span>
        </span>
        <div className="flex items-center gap-1.5">
          <span className="hidden sm:inline">Rows:</span>
          <PageSizeDropdown
            value={pageSize}
            options={pageSizeOptions}
            onChange={(v) => { onPageSizeChange(v); onPageChange(1); }}
          />
        </div>
      </div>

      {/* Page controls */}
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>

        {pages.map((p, i) =>
          p === '…' ? (
            <span key={`e${i}`} className="w-8 h-8 flex items-center justify-center text-muted-foreground text-xs">…</span>
          ) : (
            <Button
              key={p}
              variant={p === page ? 'default' : 'outline'}
              size="sm"
              onClick={() => onPageChange(p)}
              aria-current={p === page ? 'page' : undefined}
              className="min-w-8 px-2 font-semibold"
            >
              {p}
            </Button>
          )
        )}

        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          aria-label="Next page"
        >
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
