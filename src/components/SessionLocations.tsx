'use client';
import { MapPin } from 'lucide-react';
import { formatTime } from '@/lib/utils';

// One session's full location history (check-in match, check-out pick, manual adds)
// as a compact wrapping chip rail. Renders nothing when the list is empty, so callers
// can pass `session.locations` unguarded. Entries carry an optional site number and
// the time they were recorded (`added_at`, shown when `showTime` is set).
export interface SessionLocationView {
  name: string;
  site_number?: string | null;
  source?: string;
  added_at?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export default function SessionLocations({ locations, showTime, className, onHover }: {
  locations?: SessionLocationView[] | null;
  showTime?: boolean;
  className?: string;
  // Hover a chip → report its location (null on leave), so a parent map can zoom to it.
  onHover?: (loc: SessionLocationView | null) => void;
}) {
  const list = (locations ?? []).filter(l => !!l?.name);
  if (list.length === 0) return null;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}>
      {list.map((l, i) => {
        const hoverable = !!onHover && l.lat != null && l.lng != null;
        return (
          <span
            key={`${l.name}-${l.site_number ?? ''}-${i}`}
            onMouseEnter={hoverable ? () => onHover!(l) : undefined}
            onMouseLeave={hoverable ? () => onHover!(null) : undefined}
            className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-primary max-w-full transition-colors ${hoverable ? 'cursor-pointer hover:bg-primary/20 hover:border-primary/40' : ''}`}
          >
            <MapPin className="w-2.5 h-2.5 flex-shrink-0" />
            <span className="truncate">{l.name}{l.site_number ? ` · ${l.site_number}` : ''}</span>
            {showTime && l.added_at && (
              <span className="flex-shrink-0 font-normal opacity-70">· {formatTime(l.added_at)}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}
