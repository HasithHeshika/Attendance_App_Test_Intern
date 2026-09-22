'use client';
import { useEffect, useState } from 'react';
import { doc, getDoc, getDocs, collection, query, where, limit } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { epfDocId } from '@/services/userService';
import { localDateString } from '@/lib/utils';

export interface DanglingCheckout {
  date: string;      // the day whose session was never closed (YYYY-MM-DD)
  checkIn: string;   // that session's check-in time
}

// Cache per epf for the session lifetime (10 min TTL) — the lookup runs on every
// dashboard/attendance mount and the answer only changes when a day rolls over or
// the user acts on it.
const cache = new Map<string, { value: DanglingCheckout | null; at: number }>();
const TTL_MS = 10 * 60_000;

// 'YYYY-MM-DD HH:MM:SS' (local) → ms since epoch, NaN when unparseable.
function localMs(s: string): number {
  return new Date(String(s).replace(' ', 'T')).getTime();
}

/**
 * Finds a "forgot to check out" session: an open session (check-in, no check-out) on
 * one of the last 3 days (3 covers a weekend gap). Normal users are told the very
 * next day; shift sessions (overnight flag / shift day / shift-worker role) only
 * count once 24 hours have passed since the shift's check-in — an open overnight
 * shift inside its first 24h is a working shift, not a mistake.
 */
export function useDanglingCheckout(epf: string | undefined, isShiftWorker: boolean): DanglingCheckout | null {
  const [info, setInfo] = useState<DanglingCheckout | null>(null);

  useEffect(() => {
    if (!epf) { setInfo(null); return; }
    const hit = cache.get(epf);
    if (hit && Date.now() - hit.at < TTL_MS) { setInfo(hit.value); return; }

    let cancelled = false;
    (async () => {
      let found: DanglingCheckout | null = null;
      try {
        // Days the user has already raised an OPEN (pending) edit request for — they've acted on
        // it, so never nag "forgot to check out" for those days. Edit-request docs key their
        // attendance_id as `EPF_YYYY-MM-DD`, so the date is the trailing segment.
        const editReqDates = new Set<string>();
        try {
          const reqSnap = await getDocs(query(
            collection(db, 'attendance_edit_requests'),
            where('epf_number', '==', epf),
            limit(50),
          ));
          reqSnap.docs.forEach(r => {
            const rd = r.data();
            if (rd.status && rd.status !== 'pending') return;   // resolved requests don't suppress
            const ds = String(rd.attendance_id ?? '').split('_').pop() ?? '';
            if (ds) editReqDates.add(ds);
          });
        } catch { /* ignore — fall through and show the banner as before */ }

        const today = localDateString();
        for (let back = 1; back <= 3 && !found; back++) {
          const d = new Date();
          d.setDate(d.getDate() - back);
          const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          if (ds >= today) continue;
          if (editReqDates.has(ds)) continue;   // already has a pending edit request → don't nag

          // Attendance docs are keyed `${epf}_${date}` — a direct read, no query.
          const snap = await getDoc(doc(db, 'attendances', `${epfDocId(epf)}_${ds}`));
          if (!snap.exists()) continue;
          const a = snap.data();
          const sessions: Array<Record<string, unknown>> = Array.isArray(a.sessions) && a.sessions.length ? a.sessions : [a];
          const open = sessions.find(s => s.check_in && !s.check_out);
          if (!open) continue;

          const shiftSession = !!open.is_overnight || !!a.is_shift_day || isShiftWorker;
          const ageMs = Date.now() - localMs(String(open.check_in));
          if (shiftSession && (Number.isNaN(ageMs) || ageMs < 24 * 3600 * 1000)) continue;

          found = { date: ds, checkIn: String(open.check_in) };
        }
      } catch { /* offline — no banner */ }
      cache.set(epf, { value: found, at: Date.now() });
      if (!cancelled) setInfo(found);
    })();
    return () => { cancelled = true; };
  }, [epf, isShiftWorker]);

  return info;
}

// Call after the user submits an edit for the dangling day so the banner re-evaluates.
export function invalidateDanglingCheckout(epf: string | undefined) {
  if (epf) cache.delete(epf);
}
