'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { format } from 'date-fns';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { FireworksBackground } from '@/components/animate-ui/components/backgrounds/fireworks';
import { APP_VERSION, CHANGELOG, ChangelogEntry } from '@/lib/version';
import { useT } from '@/store/appStore';

const SEEN_KEY     = 'pc-whatsnew-seen';
const FIREWORKS_MS = 8000;
const FADE_MS      = 900;
const PAGE_SIZE    = 5;

// ── Category metadata ─────────────────────────────────────────────────────────
const CATEGORY_META: Record<string, { label: string; bg: string; text: string }> = {
  '🎫': { label: 'ID Card & Lanyard',  bg: 'bg-violet-500/15', text: 'text-violet-300' },
  '🏢': { label: 'Working Places',     bg: 'bg-sky-500/15',    text: 'text-sky-300'    },
  '✅': { label: 'Approvals',          bg: 'bg-emerald-500/15',text: 'text-emerald-300'},
  '⚡': { label: 'Performance',        bg: 'bg-amber-500/15',  text: 'text-amber-300'  },
  '☀️': { label: 'Solar',             bg: 'bg-orange-500/15', text: 'text-orange-300' },
  '🎨': { label: 'UI & Accessibility', bg: 'bg-pink-500/15',   text: 'text-pink-300'   },
  '🐛': { label: 'Bug Fixes',         bg: 'bg-red-500/15',    text: 'text-red-300'    },
};

function leadingEmoji(s: string): string {
  const m = s.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/u);
  return m ? m[0] : '';
}

interface Group { emoji: string; label: string; bg: string; text: string; items: string[] }

function groupChanges(changes: string[]): Group[] {
  const map = new Map<string, Group>();
  const order: string[] = [];
  for (const c of changes) {
    const e = leadingEmoji(c);
    if (!map.has(e)) {
      const meta = CATEGORY_META[e] ?? { label: 'Other', bg: 'bg-muted/50', text: 'text-muted-foreground' };
      map.set(e, { emoji: e, ...meta, items: [] });
      order.push(e);
    }
    map.get(e)!.items.push(c.replace(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)\s*/u, ''));
  }
  return order.map(e => map.get(e)!);
}

// ── Collapse consecutive identical single-change entries ──────────────────────
type DisplayItem =
  | { kind: 'single'; entry: ChangelogEntry; isLatest: boolean }
  | { kind: 'range';  entries: ChangelogEntry[]; label: string };

function buildDisplayItems(entries: ChangelogEntry[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let i = 0;
  let latestUsed = false;
  while (i < entries.length) {
    const entry = entries[i];
    if (entry.changes.length === 1) {
      const label = entry.changes[0];
      let j = i + 1;
      while (j < entries.length && entries[j].changes.length === 1 && entries[j].changes[0] === label) j++;
      if (j - i > 1) {
        items.push({ kind: 'range', entries: entries.slice(i, j), label });
        i = j;
        continue;
      }
    }
    const isLatest = !latestUsed;
    latestUsed = true;
    items.push({ kind: 'single', entry, isLatest });
    i++;
  }
  return items;
}

// ── Date formatter ────────────────────────────────────────────────────────────
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return format(d, 'MMM d · h:mm a');
}

// ── RangeCard ─────────────────────────────────────────────────────────────────
function RangeCard({ entries, label }: { entries: ChangelogEntry[]; label: string }) {
  const [open, setOpen] = useState(false);
  const newest = entries[0].version;
  const oldest = entries[entries.length - 1].version;

  return (
    <div className="rounded-lg border border-border/30 bg-muted/20 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left hover:bg-muted/30 transition-colors"
      >
        <Layers className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground tabular-nums">
              v{oldest} → v{newest}
            </span>
            <span className="text-[10px] bg-muted/60 text-muted-foreground/70 px-1.5 py-0.5 rounded-full font-medium">
              {entries.length} patches
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground/50 mt-0.5">{label}</p>
        </div>
        <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground/30 shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-border/20 px-3.5 py-2 space-y-0">
          {entries.map((e, i) => (
            <div key={e.version}
              className={`flex items-center justify-between py-1.5 ${i < entries.length - 1 ? 'border-b border-border/10' : ''}`}>
              <span className="text-[11px] font-medium text-muted-foreground/60 tabular-nums">v{e.version}</span>
              <span className="text-[10px] text-muted-foreground/40 tabular-nums">{fmtDate(e.date)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ChangelogCard ─────────────────────────────────────────────────────────────
function ChangelogCard({ entry, isLatest }: { entry: ChangelogEntry; isLatest: boolean }) {
  const isRich  = entry.changes.length > 1;
  const groups  = isRich ? groupChanges(entry.changes) : [];
  const [open, setOpen] = useState(false);

  return (
    <div className={`rounded-xl border overflow-hidden transition-colors duration-150
      ${isLatest
        ? 'border-primary/25 bg-gradient-to-br from-primary/8 to-primary/3'
        : 'border-border/40 bg-card/40 hover:bg-card/60 hover:border-border/60'}`}
    >
      {/* ── Header ── */}
      <div
        className={`flex items-center gap-3 px-4 py-3 ${isRich ? 'cursor-pointer' : ''}`}
        onClick={() => isRich && setOpen(o => !o)}
      >
        {/* Left: version + description/chips */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Version badge */}
            <span className={`text-[11px] font-bold tabular-nums px-2 py-0.5 rounded-md shrink-0
              ${isLatest ? 'bg-primary text-primary-foreground' : 'bg-muted/80 text-foreground/70'}`}>
              v{entry.version}
            </span>

            {/* For rich entries: emoji-only pills in ONE row */}
            {isRich && !open && (
              <div className="flex items-center gap-1 flex-nowrap overflow-hidden">
                {groups.map(g => (
                  <span key={g.emoji}
                    className={`text-[12px] w-6 h-6 flex items-center justify-center rounded-md shrink-0 ${g.bg}`}
                    title={g.label}>
                    {g.emoji}
                  </span>
                ))}
                <span className="text-[10px] text-muted-foreground/50 ml-1 shrink-0 whitespace-nowrap">
                  {entry.changes.length} changes
                </span>
              </div>
            )}

            {/* For rich expanded: show "click to collapse" hint */}
            {isRich && open && (
              <span className="text-[10px] text-muted-foreground/40">click to collapse</span>
            )}
          </div>

          {/* Simple single description */}
          {!isRich && (
            <p className="text-[11px] text-muted-foreground mt-1 leading-snug">{entry.changes[0]}</p>
          )}
        </div>

        {/* Right: date + chevron */}
        <div className="flex items-center gap-2 shrink-0 ml-auto pl-2">
          <span className="text-[10px] text-muted-foreground/50 tabular-nums">{fmtDate(entry.date)}</span>
          {isRich && (
            <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground/40 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
          )}
        </div>
      </div>

      {/* ── Expanded: grouped categories ── */}
      {isRich && open && (
        <div className="border-t border-border/20 px-4 py-3 space-y-3">
          {groups.map(g => (
            <div key={g.emoji}>
              {/* Category row */}
              <div className={`flex items-center gap-1.5 text-[11px] font-semibold mb-2 ${g.text}`}>
                <span className={`w-5 h-5 flex items-center justify-center rounded-md text-[12px] ${g.bg}`}>{g.emoji}</span>
                {g.label}
              </div>
              {/* Items */}
              <ul className="space-y-1.5 pl-1">
                {g.items.map((item, i) => (
                  <li key={i} className="flex gap-2.5 text-[11px] text-muted-foreground leading-snug">
                    <span className="mt-[4px] w-1 h-1 rounded-full bg-muted-foreground/30 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function SidebarVersion() {
  const t = useT();
  const [open, setOpen]               = useState(false);
  const [seen, setSeen]               = useState<string | null>(null);
  const [mounted, setMounted]         = useState(false);
  const [fireworks, setFireworks]     = useState(false);
  const [fwFade, setFwFade]           = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => {
    try { setSeen(localStorage.getItem(SEEN_KEY)); } catch { /**/ }
    setMounted(true);
  }, []);

  const isNew   = mounted && seen !== APP_VERSION;
  const markSeen = () => {
    try { localStorage.setItem(SEEN_KEY, APP_VERSION); } catch { /**/ }
    setSeen(APP_VERSION);
  };

  useEffect(() => {
    if (!fireworks) return;
    const fade = setTimeout(() => setFwFade(true), FIREWORKS_MS);
    const stop = setTimeout(() => setFireworks(false), FIREWORKS_MS + FADE_MS);
    return () => { clearTimeout(fade); clearTimeout(stop); };
  }, [fireworks]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (isNew && !reduce) { setFwFade(false); setFireworks(true); }
      markSeen();
      setVisibleCount(PAGE_SIZE);
    } else {
      setFireworks(false);
    }
  };

  const visibleEntries = CHANGELOG.slice(0, visibleCount);
  const remaining      = CHANGELOG.length - visibleCount;
  const hasMore        = remaining > 0;
  const displayItems   = buildDisplayItems(visibleEntries);

  return (
    <>
      <button
        onClick={() => handleOpenChange(true)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors group"
      >
        <span className="flex items-center gap-2">
          <span className="relative">
            <Sparkles className="w-[18px] h-[18px]" />
            {isNew && <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-primary ring-2 ring-sidebar animate-pulse" />}
          </span>
          <span className="text-sm font-medium">{t.whatsNew}</span>
        </span>
        <span className="text-[11px] font-semibold tabular-nums text-muted-foreground group-hover:text-primary transition-colors">
          v{APP_VERSION}
        </span>
      </button>

      {fireworks && typeof document !== 'undefined' && createPortal(
        <div
          className={`pointer-events-none fixed inset-0 z-[115] transition-opacity ease-out ${fwFade ? 'opacity-0' : 'opacity-100'}`}
          style={{ transitionDuration: `${FADE_MS}ms` }}
        >
          <FireworksBackground className="size-full" population={3}
            color={['#0ea5e9', '#8b5cf6', '#10b981', '#f59e0b', '#f43f5e']} />
        </div>,
        document.body,
      )}

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-md overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-primary" />
              {t.whatsNew}
            </DialogTitle>
            <DialogDescription>{t.whatsNewDesc} · v{APP_VERSION}</DialogDescription>
          </DialogHeader>

          <div className="max-h-[62vh] overflow-y-auto scrollbar-thin space-y-2 pr-0.5">
            {CHANGELOG.length === 0 ? (
              <div className="text-sm text-muted-foreground py-8 text-center">{t.noUpdates}</div>
            ) : (
              <>
                {displayItems.map(item =>
                  item.kind === 'range'
                    ? <RangeCard key={item.entries[0].version} entries={item.entries} label={item.label} />
                    : <ChangelogCard key={item.entry.version} entry={item.entry} isLatest={item.isLatest} />
                )}
                {hasMore && (
                  <button
                    onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
                    className="w-full flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors border border-border/40"
                  >
                    <ChevronDown className="w-3.5 h-3.5" />
                    Show {Math.min(PAGE_SIZE, remaining)} more
                  </button>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
