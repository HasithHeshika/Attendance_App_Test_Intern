'use client';
import { MapPinOff, MapPin, Loader2 } from 'lucide-react';
import { useT } from '@/store/appStore';
import type { LocationStatus } from './useRequiredLocation';

// Presentational location banner shown above the check-in/out controls.
// Renders nothing when location is ready; a hint while checking; a blocking
// banner with the failure reason + Retry when blocked.
export default function LocationGate({
  status, reason, onRetry, action,
}: {
  status: LocationStatus;
  reason: string;
  onRetry: () => void;
  action: 'checkin' | 'checkout';
}) {
  const t = useT();

  if (status === 'ready') return null;

  if (status === 'checking') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-xs text-slate-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
        <span>{t.gettingLocation}</span>
      </div>
    );
  }

  // blocked
  const subtitle = action === 'checkin' ? t.locationBlockedCheckin : t.locationBlockedCheckout;
  return (
    <div className="rounded-xl bg-rose-500/10 border border-rose-500/20 p-3">
      <div className="flex items-start gap-2.5">
        <MapPinOff className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-rose-300">{t.locationBlockedTitle}</p>
          <p className="text-xs text-rose-200/80 mt-0.5">{subtitle}</p>
          {reason && <p className="text-[11px] text-slate-400 mt-1.5 leading-snug">{reason}</p>}
          <button
            onClick={onRetry}
            className="mt-2.5 flex w-full items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-rose-500 text-white text-sm font-semibold hover:bg-rose-400 transition-colors"
          >
            <MapPin className="w-4 h-4" /> {t.turnOnLocation}
          </button>
        </div>
      </div>
    </div>
  );
}
