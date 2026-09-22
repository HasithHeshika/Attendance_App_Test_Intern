'use client';

import { Calendar, Clock, MapPin, Plane } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatTime } from '@/lib/utils';
import type { EditRequestData } from '@/components/EditRequestCard';

export default function EditRequestListRow({
  req,
  selected,
}: {
  req: EditRequestData & { group?: string };
  selected: boolean;
}) {
  const group = req.group ?? req.role ?? req.user_type ?? 'Executive';
  const isTech = group === 'Technician';
  const attendanceDate = String(req.attendance_id ?? '').split('_')[1] ?? '';

  const timeChanged = req.requested?.check_in !== req.current?.check_in ||
    req.requested?.check_out !== req.current?.check_out;
  const placeChanged = (req.requested?.working_place && req.requested?.working_place !== req.current?.working_place) ||
    (req.requested?.site_number && req.requested?.site_number !== req.current?.site_number);
  const outstationChanged = !!req.requested?.is_outstation;

  return (
    <div
      className={`relative rounded-xl border p-3 text-sm transition-all duration-150 ${
        selected
          ? 'border-l-4 border-l-primary border-t-primary/30 border-r-primary/30 border-b-primary/30 bg-primary/[0.06] shadow-xs'
          : 'border-border/70 bg-card hover:border-border hover:bg-muted/30'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-xs font-bold ring-1 transition-all ${
            selected
              ? 'bg-primary/20 text-primary ring-primary/40'
              : isTech
                ? 'bg-primary/10 text-primary ring-primary/20'
                : 'bg-brand/10 text-brand ring-brand/20'
          }`}
        >
          {req.name?.charAt(0)?.toUpperCase() ?? '?'}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-foreground truncate text-sm">{req.name}</span>
            <Badge
              variant={isTech ? 'default' : 'brand'}
              className="text-[9px] px-1.5 py-0.2 shrink-0 font-medium"
            >
              {group}
            </Badge>
          </div>

          <div className="mt-1 flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
            <span className="font-mono text-[11px]">EPF: {req.epf_number}</span>
            {attendanceDate && (
              <span className="inline-flex items-center gap-1 text-[11px]">
                <Calendar className="w-2.5 h-2.5" /> {attendanceDate}
              </span>
            )}
          </div>

          {/* Timing preview */}
          {(req.requested?.check_in || req.requested?.check_out) && (
            <div className="mt-1.5 flex items-center gap-1.5 text-xs">
              <Clock className="w-3 h-3 text-muted-foreground shrink-0" />
              <span className="font-mono text-[11px] text-foreground font-medium">
                {req.requested.check_in ? formatTime(req.requested.check_in) : '—'} → {req.requested.check_out ? formatTime(req.requested.check_out) : '—'}
              </span>
            </div>
          )}

          {/* Change tags */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {timeChanged && (
              <span className="inline-flex items-center rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.2 text-[9px] font-semibold text-primary">
                Time change
              </span>
            )}
            {placeChanged && (
              <span className="inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/60 px-1.5 py-0.2 text-[9px] font-medium text-foreground">
                <MapPin className="w-2 h-2 text-primary" /> Site
              </span>
            )}
            {outstationChanged && (
              <span className="inline-flex items-center gap-0.5 rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.2 text-[9px] font-semibold text-warning">
                <Plane className="w-2 h-2 text-warning" /> Outstation
              </span>
            )}
          </div>

          {req.reason && (
            <div className="mt-1.5 rounded-md bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground italic truncate">
              "{req.reason}"
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
