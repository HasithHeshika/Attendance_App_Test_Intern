'use client';
import { useEffect, useRef, useState } from 'react';
import { getDocs, query, collection, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { specialLeaveOn } from '@/lib/utils';
import { shapeDayPeople, computeStats, type DayPerson, type DayStats } from '@/lib/overviewData';
import { getScheduleAssignmentsForRange } from '@/services/scheduleAssignmentService';

const cache = new Map<string, DayPerson[]>();

export function useOverviewDay(args: {
  date: string; company: string; getEmployees: () => Promise<any[]>; refreshNonce?: number;
  // Southern Lanka only — when true, also fetches that day's schedule_assignments so someone
  // with no shift on file classifies as 'unscheduled' instead of 'missing'. Every other tenant
  // omits this and gets the exact same present/leave/missing split as before this existed.
  useShiftGate?: boolean;
}): { people: DayPerson[]; stats: DayStats; loading: boolean } {
  const { date, company, getEmployees, refreshNonce, useShiftGate } = args;
  const [people, setPeople] = useState<DayPerson[]>([]);
  const [loading, setLoading] = useState(true);
  const getEmpRef = useRef(getEmployees); getEmpRef.current = getEmployees;
  const prevNonce = useRef(refreshNonce);

  useEffect(() => {
    let cancelled = false;
    // The shift gate changes what the SAME (date, company) key resolves to, so it has to be
    // part of the cache key — otherwise switching tenants (or toggling the gate) could serve a
    // stale shape cached under the other mode.
    const key = `${date}|${company}|${useShiftGate ? 1 : 0}`;
    if (refreshNonce !== prevNonce.current) { cache.delete(key); prevNonce.current = refreshNonce; }
    if (cache.has(key)) { setPeople(cache.get(key)!); setLoading(false); return; }
    setLoading(true); setPeople([]);
    (async () => {
      try {
        const employees = await getEmpRef.current();
        const [attSnap, leaveSnap, assignments] = await Promise.all([
          getDocs(query(collection(db, 'attendances'), where('date', '==', date))),
          // Narrow to leaves that can cover this date: from_date ≤ date ≤ to_date.
          // Firestore can only filter on one inequality field, so we use from_date <= date
          // and post-filter to_date >= date on the client. This is far cheaper than
          // fetching every approved leave for every day view.
          getDocs(query(
            collection(db, 'leaves'),
            where('status', '==', 'approved'),
            where('from_date', '<=', date),
          )).catch(() => ({ docs: [] as any[] })),
          useShiftGate ? getScheduleAssignmentsForRange(date, date).catch(() => []) : Promise.resolve(null),
        ]);
        const empEpfs = new Set(employees.map(e => e.epf_number as string));
        const attendanceByEpf: Record<string, any> = {};
        attSnap.docs.forEach(d => { const a = d.data(); if (empEpfs.has(a.epf_number)) attendanceByEpf[a.epf_number] = a; });
        const leaveEpfs = new Set(leaveSnap.docs.map(d => d.data())
          .filter(l => empEpfs.has(l.epf_number) && String(l.to_date).slice(0, 10) >= date)
          .map(l => l.epf_number as string));
        const specialEpfs = new Set(employees.filter(e => specialLeaveOn(e.special_leaves, date)).map(e => e.epf_number as string));
        const scheduledEpfs = assignments
          ? new Set(assignments.filter(a => empEpfs.has(a.epf_number)).map(a => a.epf_number))
          : null;
        const shaped = shapeDayPeople({ employees, attendanceByEpf, leaveEpfs, specialEpfs, scheduledEpfs });
        cache.set(key, shaped);
        if (!cancelled) setPeople(shaped);
      } catch { if (!cancelled) setPeople([]); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [date, company, refreshNonce, useShiftGate]);

  return { people, stats: computeStats(people), loading };
}
