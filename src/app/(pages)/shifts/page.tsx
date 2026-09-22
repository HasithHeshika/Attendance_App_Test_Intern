'use client';
import { useState, useEffect, useMemo, useRef } from 'react';
import { CalendarRange, Plus, Trash2, Save, Clock, Search, Users, CalendarClock, Upload, Download, CalendarCheck, Loader2, Pencil, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import SearchableSelect from '@/components/SearchableSelect';
import ConfirmModal from '@/components/ConfirmModal';
import WorkingPlaceSelect from '@/components/WorkingPlaceSelect';
import SmartWorkingPlaceSelect from '@/components/SmartWorkingPlaceSelect';
import { tenant } from '@/lib/firebase';
import SouthernlankaShifts from './SouthernlankaShifts';
import { useWorkingPlaces } from '@/store/workingPlacesStore';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities, useRoles } from '@/store/rolesStore';
import { useT } from '@/store/appStore';
import { getAllUsers } from '@/services/userService';
import {
  getShiftAssignments, createShiftAssignment, deleteShiftAssignment,
} from '@/services/shiftService';
import { upsertWorkingSchedules, getEffectiveScheduleMap, deleteSchedule, type WorkingScheduleInput, type WorkingScheduleRecord } from '@/services/workingScheduleService';
import { descendantRoleNamesOf, resolveCapabilitiesByName, roleCategory } from '@/lib/permissions';
import { localDateString } from '@/lib/utils';
import type { AppUser, ShiftAssignment } from '@/lib/types';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { PageHeaderSkeleton, StatCardsSkeleton, ListSkeleton, FormSkeleton } from '@/components/ui/Skeleton';
import { PageTransition, Reveal, Stagger, StaggerItem, MotionCard } from '@/components/ui/motion';

// Local (Asia/Colombo) calendar date "YYYY-MM-DD". Shift from/to dates are stored as local
// calendar dates, so today must also be local — NOT toISOString() (UTC), which is a day
// behind in the early-morning hours and would mis-classify a just-ended shift as active.
const todayStr = () => localDateString();
const empty = { epf_number: '', from_date: todayStr(), to_date: todayStr(), working_place: '', site_number: '' };
const emptySched = { epf_number: '', from_date: todayStr(), working_place: '', site_number: '' };

// ─── CSV helpers (working-schedule upload / sample) ────────────────────────────
const isDateHeader = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s.trim());

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function toCsv(rows: string[][]): string {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}
// Minimal RFC-4180-ish parser: handles quoted fields, escaped quotes, CRLF/LF.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// Normalize a working-place name for tolerant matching: lowercase, and treat any run of
// non-alphanumeric characters as a single space. So "Colombo-Office", "colombo  office",
// and "Colombo - Office" all normalize to the same key.
function normalizePlaceName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Levenshtein edit distance (small strings) — powers fuzzy "did you mean" matching.
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[m];
}

function ShiftsAdminContent() {
  const me   = useAuthStore(s => s.user);
  const caps = useUserCapabilities();
  const { roles } = useRoles();
  const { requiresSite, options: placeOptions } = useWorkingPlaces();
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [schedBusy, setSchedBusy] = useState(false);
  const [schedResult, setSchedResult] = useState<string | null>(null);
  const [showSchedForm, setShowSchedForm] = useState(false);
  const [schedForm, setSchedForm] = useState(emptySched);
  const [schedSaving, setSchedSaving] = useState(false);
  // Each employee's currently-effective scheduled working place (effective today).
  const [currentScheds, setCurrentScheds] = useState<Record<string, WorkingScheduleRecord>>({});
  // Edit / multi-select state for the "Current scheduled places" list.
  const [selectedEpfs, setSelectedEpfs] = useState<Set<string>>(new Set());
  const [editOpen, setEditOpen] = useState(false);
  const [editTargets, setEditTargets] = useState<{ epf: string; name: string; fromDate: string }[]>([]);
  const [editForm, setEditForm] = useState({ from_date: todayStr(), working_place: '', site_number: '' });
  const [editSaving, setEditSaving] = useState(false);
  const [schedSearch, setSchedSearch] = useState('');
  const [schedPage, setSchedPage] = useState(0);
  const SCHED_PAGE_SIZE = 8;

  const loadCurrentSchedules = async () => {
    try { setCurrentScheds(await getEffectiveScheduleMap(todayStr())); }
    catch (e) { console.error(e); }
  };

  const [assignments, setAssignments] = useState<ShiftAssignment[]>([]);
  const [users,    setUsers]    = useState<AppUser[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form,     setForm]     = useState(empty);
  const [saving,   setSaving]   = useState(false);
  const [search,   setSearch]   = useState('');
  const [tab,      setTab]      = useState<'current' | 'old'>('current');
  const [confirmRemoveAssignment, setConfirmRemoveAssignment] = useState<ShiftAssignment | null>(null);

  // `silent` re-fetches without flipping the full-page skeleton, so a mutation updates the
  // lists in place instead of remounting them (which replays the entrance animations — the
  // "whole page resets" effect).
  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    // Settle independently: a schedule-only manager (no shift access) can still load the
    // user list for the CSV section even if reading shift assignments is restricted.
    const [a, u] = await Promise.allSettled([getShiftAssignments(), getAllUsers()]);
    if (a.status === 'fulfilled') setAssignments(a.value); else console.error(a.reason);
    if (u.status === 'fulfilled') setUsers(u.value); else console.error(u.reason);
    if (!silent) setLoading(false);
  };
  useEffect(() => { load(); loadCurrentSchedules(); }, []);

  // Management can roster anyone; otherwise only the manager's own subtree + company.
  const isMgmt = caps.is_system_admin || caps.can_manage_users;
  const subtreeRoles = useMemo(() => descendantRoleNamesOf(me?.role, roles), [me?.role, roles]);
  const assignable = useMemo(() => users.filter(u => {
    if (u.is_active === false) return false;
    if (!resolveCapabilitiesByName(u.role, roles).is_employee) return false;
    if (isMgmt) return true;
    return u.company_name === me?.company && subtreeRoles.includes(u.role);
  }), [users, roles, isMgmt, me?.company, subtreeRoles]);

  const handleSave = async () => {
    if (!form.epf_number) { toast.error(t.selectEmployee); return; }
    if (!form.from_date || !form.to_date) { toast.error(t.pickDateRange); return; }
    if (form.to_date < form.from_date) { toast.error(t.endBeforeStart); return; }
    if (form.working_place && requiresSite(form.working_place) && !form.site_number.trim()) {
      toast.error(t.siteNumberRequiredForPlace); return;
    }
    const emp = users.find(u => u.epf_number === form.epf_number);
    if (!emp) { toast.error(t.employeeNotFound); return; }
    setSaving(true);
    try {
      await createShiftAssignment({
        epf_number:    emp.epf_number,
        employee_name: emp.display_name,
        company_id:    emp.company_id ?? '',
        company_name:  emp.company_name ?? '',
        from_date:     form.from_date,
        to_date:       form.to_date,
        working_place: form.working_place || null,
        site_number:   form.working_place && requiresSite(form.working_place) ? (form.site_number.trim() || null) : null,
        assigned_by:   me?.epf_number ?? '',
        assigned_by_name: me?.name ?? '',
      });
      toast.success(t.shiftAssigned);
      setShowForm(false);
      setForm(empty);
      await load(true);
    } catch (e) { console.error(e); toast.error(t.failedAssignShift); }
    finally { setSaving(false); }
  };

  const handleDelete = async (a: ShiftAssignment) => {
    try {
      await deleteShiftAssignment(a.id);
      toast.success(t.shiftRemoved);
      await load(true);
    } catch { toast.error(t.failedRemove); }
  };

  // ─── Working-schedule CSV (per-exact-day working place for technicians) ─────────
  // Technicians the current manager may schedule (in scope + technician category).
  const schedulableTechs = useMemo(
    () => assignable.filter(u => roleCategory(u.role, roles) === 'technician'),
    [assignable, roles],
  );

  // Technicians (in scope) that currently have a scheduled place, with that entry — drives the
  // "Current scheduled places" list and its select/edit actions.
  const scheduledRows = useMemo(
    () => schedulableTechs
      .map(u => ({ u, s: currentScheds[u.epf_number] }))
      .filter((x): x is { u: AppUser; s: WorkingScheduleRecord } => !!x.s)
      .sort((a, b) => a.u.display_name.localeCompare(b.u.display_name)),
    [schedulableTechs, currentScheds],
  );

  // Search + paginate the scheduled list.
  const filteredScheduledRows = useMemo(() => {
    const q = schedSearch.trim().toLowerCase();
    if (!q) return scheduledRows;
    return scheduledRows.filter(({ u, s }) =>
      u.display_name.toLowerCase().includes(q) ||
      String(u.epf_number).toLowerCase().includes(q) ||
      (s.working_place ?? '').toLowerCase().includes(q));
  }, [scheduledRows, schedSearch]);
  const schedPageCount = Math.max(1, Math.ceil(filteredScheduledRows.length / SCHED_PAGE_SIZE));
  const safeSchedPage = Math.min(schedPage, schedPageCount - 1);
  const pagedScheduledRows = filteredScheduledRows.slice(safeSchedPage * SCHED_PAGE_SIZE, safeSchedPage * SCHED_PAGE_SIZE + SCHED_PAGE_SIZE);
  // Reset to page 0 whenever the search changes.
  useEffect(() => { setSchedPage(0); }, [schedSearch]);

  const toggleSelectEpf = (epf: string) => setSelectedEpfs(prev => {
    const next = new Set(prev);
    next.has(epf) ? next.delete(epf) : next.add(epf);
    return next;
  });

  const openEditSingle = (u: AppUser, s: WorkingScheduleRecord) => {
    setEditTargets([{ epf: u.epf_number, name: u.display_name, fromDate: s.from_date }]);
    setEditForm({ from_date: s.from_date, working_place: s.working_place, site_number: s.site_number ?? '' });
    setEditOpen(true);
  };

  const openEditBulk = () => {
    const selected = scheduledRows.filter(r => selectedEpfs.has(r.u.epf_number));
    if (!selected.length) return;
    // Pre-fill from the most recently-scheduled entry among the selection.
    const recent = selected.reduce((a, b) => (b.s.from_date > a.s.from_date ? b : a));
    setEditTargets(selected.map(r => ({ epf: r.u.epf_number, name: r.u.display_name, fromDate: r.s.from_date })));
    setEditForm({ from_date: recent.s.from_date, working_place: recent.s.working_place, site_number: recent.s.site_number ?? '' });
    setEditOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!editForm.from_date) { toast.error('Pick a "from" date'); return; }
    if (!editForm.working_place) { toast.error('Select a working place'); return; }
    if (requiresSite(editForm.working_place) && !editForm.site_number.trim()) {
      toast.error('Site number is required for this working place'); return;
    }
    setEditSaving(true);
    try {
      const site = requiresSite(editForm.working_place) ? (editForm.site_number.trim() || null) : null;
      const inputs: WorkingScheduleInput[] = editTargets.map(tgt => {
        const emp = users.find(u => u.epf_number === tgt.epf);
        return {
          epf_number:    tgt.epf,
          employee_name: emp?.display_name ?? tgt.name,
          from_date:     editForm.from_date,
          working_place: editForm.working_place,
          site_number:   site,
          company_id:    emp?.company_id ?? '',
          company_name:  emp?.company_name ?? '',
        };
      });
      // Moving an entry to a new From date: drop the old one so it doesn't linger.
      await Promise.all(editTargets
        .filter(tgt => tgt.fromDate && tgt.fromDate !== editForm.from_date)
        .map(tgt => deleteSchedule(tgt.epf, tgt.fromDate)));
      await upsertWorkingSchedules(inputs, me?.epf_number ?? '', me?.name ?? '');
      toast.success(editTargets.length > 1 ? `Updated ${editTargets.length} schedules` : 'Schedule updated');
      setEditOpen(false);
      setSelectedEpfs(new Set());
      loadCurrentSchedules();
    } catch (e) { console.error(e); toast.error('Failed to update the schedule(s)'); }
    finally { setEditSaving(false); }
  };

  // Download a pre-filled template: one row per in-scope technician, pre-filled with their
  // CURRENT (most recent) scheduled working place + a From date of today. The manager edits the
  // place / From date; the place then applies from that date onward.
  const handleDownloadSample = async () => {
    if (!schedulableTechs.length) { toast.error(t.noTeamToRoster ?? 'No technicians in your scope'); return; }
    setSchedBusy(true);
    try {
      const today = todayStr();
      let current: Record<string, { working_place: string }> = {};
      try { current = await getEffectiveScheduleMap(today); } catch { current = {}; }
      const header = ['EPF', 'Name', 'Working Place', 'From'];
      const rows = schedulableTechs.map(u => [
        u.epf_number,
        u.display_name,
        current[u.epf_number]?.working_place ?? '',
        today,
      ]);
      downloadCsv(`working_schedule_template_${today}.csv`, toCsv([header, ...rows]));
    } finally { setSchedBusy(false); }
  };

  const handleScheduleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    setSchedBusy(true);
    setSchedResult(null);
    try {
      const text = await file.text();
      const rows = parseCsv(text).filter(r => r.some(c => c.trim() !== ''));
      if (rows.length < 2) { toast.error('CSV has no data rows.'); return; }
      const header = rows[0].map(h => h.trim().toLowerCase());
      // Locate columns by header name (falls back to fixed positions: EPF, Name, Working Place, From).
      const findCol = (def: number, ...keys: string[]) => {
        const i = header.findIndex(h => keys.some(k => h.includes(k)));
        return i >= 0 ? i : def;
      };
      const epfIdx   = findCol(0, 'epf');
      const placeIdx = findCol(2, 'working place', 'working_place', 'place');
      const fromIdx  = findCol(3, 'from', 'date');

      // Tolerant place matching: normalize away case/spacing/punctuation, then fall back to a
      // fuzzy match for small typos, so a manually-typed name still resolves.
      const placeByNorm = new Map(placeOptions.map(o => [normalizePlaceName(o.name), o.name]));
      const resolvePlace = (raw: string): { name: string | null; corrected: boolean; suggestion: string | null } => {
        const norm = normalizePlaceName(raw);
        if (!norm) return { name: null, corrected: false, suggestion: null };
        const exact = placeByNorm.get(norm);
        if (exact) return { name: exact, corrected: normalizePlaceName(exact) !== norm ? true : exact !== raw.trim(), suggestion: null };
        let best: string | null = null, bestD = Infinity;
        placeByNorm.forEach((canon, n2) => {
          const d = editDistance(norm, n2);
          if (d < bestD) { bestD = d; best = canon; }
        });
        const tolerance = Math.max(1, Math.floor(norm.length * 0.25));
        if (best != null && bestD <= tolerance) return { name: best, corrected: true, suggestion: best };
        return { name: null, corrected: false, suggestion: best };
      };

      const userByEpf = new Map(users.map(u => [String(u.epf_number), u]));
      const records: WorkingScheduleInput[] = [];
      const corrections = new Map<string, string>();
      const unknown = new Map<string, string | null>();
      const unknownEpfs = new Set<string>();
      const badDates = new Set<string>();
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const epf = (r[epfIdx] ?? '').trim();
        if (!epf) continue;
        const emp = userByEpf.get(epf);
        if (!emp) { unknownEpfs.add(epf); continue; }
        const rawPlace = (r[placeIdx] ?? '').trim();
        const fromDate = (r[fromIdx] ?? '').trim();
        if (!rawPlace) continue;                        // no working place → leave this technician's schedule unchanged
        if (!isDateHeader(fromDate)) { badDates.add(fromDate || '(blank)'); continue; }
        const res = resolvePlace(rawPlace);
        if (!res.name) { unknown.set(rawPlace, res.suggestion); continue; }
        if (res.corrected) corrections.set(rawPlace, res.name);
        records.push({
          epf_number:    epf,
          employee_name: emp.display_name,
          from_date:     fromDate,
          working_place: res.name,
          company_id:    emp.company_id ?? '',
          company_name:  emp.company_name ?? '',
        });
      }
      if (badDates.size) {
        toast.error(`Invalid From date(s): ${Array.from(badDates).slice(0, 5).join(', ')}. Use YYYY-MM-DD.`, { duration: 8000 });
        return;
      }
      if (unknown.size) {
        const list = Array.from(unknown.entries()).slice(0, 5)
          .map(([raw, sug]) => sug ? `"${raw}" (did you mean "${sug}"?)` : `"${raw}"`).join('; ');
        const more = unknown.size > 5 ? ` and ${unknown.size - 5} more` : '';
        toast.error(`Unrecognized working place(s): ${list}${more}. Fix the spelling or use the sample's exact names.`, { duration: 9000 });
        return;
      }
      if (!records.length) { toast.error('No assignments found in the CSV.'); return; }
      const n = await upsertWorkingSchedules(records, me?.epf_number ?? '', me?.name ?? '');
      let msg = `Saved working place for ${n} technician(s), effective from the given date. Technicians not in the file keep their previous schedule.`;
      if (corrections.size) {
        const sample = Array.from(corrections.entries()).slice(0, 3).map(([raw, to]) => `"${raw}" → ${to}`).join(', ');
        msg += ` Auto-matched ${corrections.size} spelling difference(s): ${sample}${corrections.size > 3 ? '…' : ''}.`;
      }
      if (unknownEpfs.size) msg += ` Skipped ${unknownEpfs.size} unknown EPF(s).`;
      setSchedResult(msg);
      toast.success('Working schedule uploaded');
      loadCurrentSchedules();
    } catch (err) {
      console.error(err);
      toast.error('Failed to read / upload the CSV.');
    } finally {
      setSchedBusy(false);
    }
  };

  // Set ONE technician's working place effective from a date (manual single entry).
  const handleSaveSchedule = async () => {
    if (!schedForm.epf_number) { toast.error('Select an employee'); return; }
    if (!schedForm.from_date) { toast.error('Pick a "from" date'); return; }
    if (!schedForm.working_place) { toast.error('Select a working place'); return; }
    if (requiresSite(schedForm.working_place) && !schedForm.site_number.trim()) {
      toast.error('Site number is required for this working place'); return;
    }
    const emp = users.find(u => u.epf_number === schedForm.epf_number);
    if (!emp) { toast.error('Employee not found'); return; }
    setSchedSaving(true);
    try {
      await upsertWorkingSchedules([{
        epf_number:    emp.epf_number,
        employee_name: emp.display_name,
        from_date:     schedForm.from_date,
        working_place: schedForm.working_place,
        site_number:   requiresSite(schedForm.working_place) ? (schedForm.site_number.trim() || null) : null,
        company_id:    emp.company_id ?? '',
        company_name:  emp.company_name ?? '',
      }], me?.epf_number ?? '', me?.name ?? '');
      setSchedResult(`Set ${emp.display_name} → ${schedForm.working_place} from ${schedForm.from_date} onward.`);
      toast.success('Working schedule saved');
      loadCurrentSchedules();
      setShowSchedForm(false);
      setSchedForm(emptySched);
    } catch (e) { console.error(e); toast.error('Failed to save the schedule'); }
    finally { setSchedSaving(false); }
  };

  const canShifts = !!caps.can_manage_shifts;
  const canSchedules = !!caps.can_manage_working_schedules;
  if (caps && !canShifts && !canSchedules) {
    return <div className="text-muted-foreground p-10 text-center">{t.noShiftsPermission}</div>;
  }
  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <StatCardsSkeleton count={4} />
        <ListSkeleton rows={6} />
      </div>
    );
  }

  const today = todayStr();
  const matchesSearch = (a: ShiftAssignment) =>
    !search ||
    a.employee_name?.toLowerCase().includes(search.toLowerCase()) ||
    a.epf_number?.toLowerCase().includes(search.toLowerCase());
  // Upcoming/Ongoing = period not yet ended (to_date today or later); Old = already ended.
  const current = assignments
    .filter(a => matchesSearch(a) && a.to_date >= today)
    .sort((x, y) => x.from_date.localeCompare(y.from_date));   // soonest first
  const old = assignments
    .filter(a => matchesSearch(a) && a.to_date < today)
    .sort((x, y) => y.to_date.localeCompare(x.to_date));       // most recently ended first
  const list = tab === 'current' ? current : old;

  // KPI metrics (presentation-only derivation over the full roster).
  const activeCount   = assignments.filter(a => a.from_date <= today && today <= a.to_date).length;
  const upcomingCount = assignments.filter(a => a.from_date > today).length;
  const endedCount    = assignments.filter(a => a.to_date < today).length;

  // Working-schedule KPIs.
  const scheduledCount   = scheduledRows.length;
  const unscheduledCount = Math.max(0, schedulableTechs.length - scheduledRows.length);
  const distinctPlaces   = new Set(scheduledRows.map(r => r.s.working_place)).size;

  return (
    <PageTransition className="space-y-6">
      <PageHeader
        title={t.shiftRosterTitle}
        description={t.shiftRosterDesc}
        icon={CalendarRange}
      />

      {/* ── KPI summary cards (shift roster + working schedules), top of page ── */}
      {(canShifts || canSchedules) && (
        <Stagger className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {canShifts && (<>
            <StaggerItem>
              <StatCard label={t.totalPeriods} value={assignments.length} icon={CalendarRange} tone="primary" />
            </StaggerItem>
            <StaggerItem>
              <StatCard label={t.activeNow} value={activeCount} icon={Clock} tone="success" hint={t.currentlyOnShift} />
            </StaggerItem>
            <StaggerItem>
              <StatCard label={t.upcomingWord} value={upcomingCount} icon={CalendarClock} tone="brand" hint={t.startingLater} />
            </StaggerItem>
            <StaggerItem>
              <StatCard label={t.endedWord} value={endedCount} icon={CalendarRange} tone="muted" hint={t.pastPeriods} />
            </StaggerItem>
          </>)}
          {canSchedules && (<>
            <StaggerItem>
              <StatCard label="Scheduled" value={scheduledCount} icon={CalendarCheck} tone="brand" hint={`of ${schedulableTechs.length} technician(s)`} />
            </StaggerItem>
            <StaggerItem>
              <StatCard label="Unscheduled" value={unscheduledCount} icon={Users} tone="muted" hint="no working place set" />
            </StaggerItem>
            <StaggerItem>
              <StatCard label="Working places" value={distinctPlaces} icon={CalendarRange} tone="primary" hint="distinct places in use" />
            </StaggerItem>
          </>)}
        </Stagger>
      )}

      {/* ── Working Schedules (per-day working place per technician, CSV) ── */}
      {canSchedules && (
        <Reveal delay={0.05}>
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
                  <CalendarCheck className="h-5 w-5" />
                </span>
                <div>
                  <CardTitle>Working Schedules</CardTitle>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Assign a working place to each technician for specific upcoming dates (used as the check-out outstation reference).
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
                <Button variant="outline" size="sm" onClick={() => { setSchedForm(emptySched); setShowSchedForm(true); }} disabled={schedBusy}>
                  <Plus className="w-3.5 h-3.5" />Add one
                </Button>
                <Button variant="outline" size="sm" onClick={handleDownloadSample} disabled={schedBusy}>
                  <Download className="w-3.5 h-3.5" />Sample CSV
                </Button>
                <Button size="sm" onClick={() => fileRef.current?.click()} disabled={schedBusy}>
                  {schedBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}Upload CSV
                </Button>
                <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleScheduleFile} />
              </div>
            </CardHeader>
            <div className="px-5 pb-5 space-y-3">
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-[11px] text-muted-foreground space-y-1.5">
                <p className="font-medium text-foreground">CSV format</p>
                <p>Columns: <span className="font-mono">EPF, Name, Working Place, From</span>. The working place applies <span className="text-foreground">from the From date onward</span> (until a later From date overrides it). Technicians not in the file keep their previous schedule. Download the sample — it&apos;s pre-filled with each technician&apos;s current place and today&apos;s date.</p>
                <p>Spelling, spacing and capitalization don&apos;t need to be exact — close names are matched automatically (and you&apos;ll get a &ldquo;did you mean?&rdquo; hint for anything unrecognized). Copy a name below to be safe:</p>
                <p className="text-foreground font-mono break-words select-all">{placeOptions.map(o => o.name).join('  |  ') || '—'}</p>
                <p>{schedulableTechs.length} technician(s) in your scope.</p>
              </div>
              {schedResult && (
                <div className="rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-xs text-success">
                  {schedResult}
                </div>
              )}

              {/* Current scheduled working places — selectable, editable, searchable, paginated */}
              {(() => {
                const allFilteredSelected = filteredScheduledRows.length > 0 && filteredScheduledRows.every(r => selectedEpfs.has(r.u.epf_number));
                const toggleAllFiltered = () => setSelectedEpfs(prev => {
                  const next = new Set(prev);
                  filteredScheduledRows.forEach(r => allFilteredSelected ? next.delete(r.u.epf_number) : next.add(r.u.epf_number));
                  return next;
                });
                return (
                  <div className="rounded-lg border border-border overflow-hidden">
                    <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-muted/40">
                      <div className="flex items-center gap-2 min-w-0">
                        {filteredScheduledRows.length > 0 && (
                          <button type="button" onClick={toggleAllFiltered}
                            className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                              allFilteredSelected ? 'bg-primary border-primary' : 'border-border bg-card hover:border-primary/50'}`}
                            title="Select all shown">
                            {allFilteredSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                          </button>
                        )}
                        <span className="text-xs font-semibold text-foreground">Current scheduled places</span>
                      </div>
                      {selectedEpfs.size > 0 ? (
                        <Button size="sm" variant="outline" onClick={openEditBulk} className="h-7">
                          <Pencil className="w-3.5 h-3.5" />Edit selected ({selectedEpfs.size})
                        </Button>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">{scheduledRows.length} of {schedulableTechs.length} technician(s)</span>
                      )}
                    </div>

                    {scheduledRows.length > 0 && (
                      <div className="px-3 py-2 border-b border-border">
                        <div className="relative">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                          <Input value={schedSearch} onChange={e => setSchedSearch(e.target.value)}
                            placeholder="Search name, EPF or working place…" className="pl-8 h-8 text-xs" />
                        </div>
                      </div>
                    )}

                    {scheduledRows.length === 0 ? (
                      <div className="px-3 py-3 text-[11px] text-muted-foreground">No working places scheduled yet — upload a CSV or add one.</div>
                    ) : filteredScheduledRows.length === 0 ? (
                      <div className="px-3 py-3 text-[11px] text-muted-foreground">No match for &ldquo;{schedSearch}&rdquo;.</div>
                    ) : (
                      <>
                        <div className="divide-y divide-border">
                          {pagedScheduledRows.map(({ u, s }) => {
                            const checked = selectedEpfs.has(u.epf_number);
                            return (
                              <div key={u.epf_number} className={`flex items-center gap-3 px-3 py-2 ${checked ? 'bg-primary/5' : ''}`}>
                                <button type="button" onClick={() => toggleSelectEpf(u.epf_number)}
                                  className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                                    checked ? 'bg-primary border-primary' : 'border-border bg-card hover:border-primary/50'}`}>
                                  {checked && <Check className="w-3 h-3 text-primary-foreground" />}
                                </button>
                                <div className="min-w-0 flex-1">
                                  <div className="text-xs font-medium text-foreground truncate">{u.display_name}</div>
                                  <div className="text-[10px] text-muted-foreground">{u.epf_number}</div>
                                </div>
                                <div className="min-w-0 text-right">
                                  <div className="text-xs font-medium text-foreground truncate">{s.working_place}{s.site_number ? ` · ${s.site_number}` : ''}</div>
                                  <div className="text-[10px] text-muted-foreground">from {s.from_date}</div>
                                </div>
                                <Button variant="ghost" size="icon-sm" onClick={() => openEditSingle(u, s)}
                                  className="flex-shrink-0 text-muted-foreground hover:text-primary" title="Edit">
                                  <Pencil className="w-3.5 h-3.5" />
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                        {schedPageCount > 1 && (
                          <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-border bg-muted/20">
                            <span className="text-[11px] text-muted-foreground">Page {safeSchedPage + 1} of {schedPageCount} · {filteredScheduledRows.length} result(s)</span>
                            <div className="flex items-center gap-1.5">
                              <Button size="sm" variant="outline" className="h-7" disabled={safeSchedPage === 0}
                                onClick={() => setSchedPage(p => Math.max(0, p - 1))}>Prev</Button>
                              <Button size="sm" variant="outline" className="h-7" disabled={safeSchedPage >= schedPageCount - 1}
                                onClick={() => setSchedPage(p => Math.min(schedPageCount - 1, p + 1))}>Next</Button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })()}
            </div>
          </Card>
        </Reveal>
      )}

      {canShifts && (<>
      <Reveal delay={0.05}>
        <Card>
          <CardHeader className="flex-col items-stretch gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="flex-shrink-0">{t.rosterWord}</CardTitle>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto sm:justify-end">
              <div className="relative w-full sm:max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={t.searchNameEpf}
                  className="pl-9 w-full" />
              </div>
              <Button onClick={() => { setForm(empty); setShowForm(true); }} className="flex-shrink-0">
                <Plus className="w-4 h-4" />{t.assignShift}
              </Button>
            </div>
          </CardHeader>

          <div className="px-5 pb-5 space-y-4">
            {/* Tabs: upcoming/ongoing vs old (ended) */}
            <div className="flex items-center gap-1 p-1 bg-muted rounded-lg w-full sm:w-fit">
              {([
                { key: 'current', label: t.upcomingOngoing, icon: Clock,        count: current.length },
                { key: 'old',     label: t.oldWord,                icon: CalendarRange, count: old.length },
              ] as const).map(t => (
                <button key={t.key} onClick={() => setTab(t.key)}
                  className={`flex-1 sm:flex-none px-3 sm:px-4 py-1.5 rounded-md text-xs sm:text-sm font-medium transition-all flex items-center justify-center gap-1.5 ${tab === t.key ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}>
                  <t.icon className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{t.label}</span>
                  {t.count > 0 && <span className="min-w-[20px] h-5 px-1 rounded-full bg-muted text-muted-foreground text-[10px] font-bold flex items-center justify-center flex-shrink-0">{t.count}</span>}
                </button>
              ))}
            </div>

            {list.length === 0 ? (
              <EmptyState
                icon={CalendarRange}
                title={tab === 'current' ? t.noUpcomingShifts : t.noOldShifts}
                description={tab === 'current' ? t.noUpcomingShiftsDesc : t.noOldShiftsDesc}
              />
            ) : (
              <Stagger className="space-y-2" gap={0.04}>
                {list.map(a => {
                  const active = a.from_date <= today && today <= a.to_date;
                  const upcoming = a.from_date > today;
                  const ended = a.to_date < today;
                  return (
                    <StaggerItem key={a.id}>
                      <MotionCard className="rounded-xl">
                      <Card className="p-4 flex items-center gap-4">
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${active ? 'bg-success/10' : upcoming ? 'bg-primary/10' : 'bg-muted'}`}>
                          <Clock className={`w-4 h-4 ${active ? 'text-success' : upcoming ? 'text-primary' : 'text-muted-foreground'}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-foreground">{a.employee_name}</span>
                            <span className="text-[11px] text-muted-foreground">{a.epf_number}</span>
                            {active   && <Badge variant="success">{t.statusActive}</Badge>}
                            {upcoming && <Badge variant="default">{t.upcomingWord}</Badge>}
                            {ended    && <Badge variant="muted">{t.endedWord}</Badge>}
                          </div>
                          <div className="text-[11px] text-muted-foreground mt-0.5">
                            {a.from_date} → {a.to_date}{a.working_place ? ` · ${a.working_place}${a.site_number ? ` (${a.site_number})` : ''}` : ''}{a.company_name ? ` · ${a.company_name}` : ''}{a.assigned_by_name ? ` · by ${a.assigned_by_name}` : ''}
                          </div>
                        </div>
                        <Button variant="ghost" size="icon-sm" onClick={() => setConfirmRemoveAssignment(a)}
                          className="text-muted-foreground hover:text-destructive flex-shrink-0">
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </Card>
                      </MotionCard>
                    </StaggerItem>
                  );
                })}
              </Stagger>
            )}
          </div>
        </Card>
      </Reveal>
      </>)}

      {canShifts && (
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t.assignShiftPeriod}</DialogTitle>
          </DialogHeader>

          {loading ? (
            <FormSkeleton fields={4} className="border-0 bg-transparent p-0 shadow-none" />
          ) : (
          <div className="space-y-4">
            <div>
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t.employeeWord} <span className="text-destructive">*</span></Label>
              <SearchableSelect
                value={form.epf_number}
                onChange={epf => setForm(f => ({ ...f, epf_number: epf }))}
                placeholder={t.selectEmployeePlaceholder}
                icon={<Users className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                emptyLabel={t.noMatchingEmployees}
                options={assignable.map(u => ({
                  value: u.epf_number,
                  label: u.display_name,
                  sublabel: `${u.role} · ${u.epf_number}`,
                }))}
              />
              {assignable.length === 0 && <p className="text-[11px] text-warning mt-1">{t.noTeamToRoster}</p>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t.fromWord} <span className="text-destructive">*</span></Label>
                <Input type="date" value={form.from_date} onChange={e => setForm(f => ({ ...f, from_date: e.target.value }))}
                  className="[color-scheme:dark]" />
              </div>
              <div>
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t.toWord} <span className="text-destructive">*</span></Label>
                <Input type="date" value={form.to_date} onChange={e => setForm(f => ({ ...f, to_date: e.target.value }))}
                  className="[color-scheme:dark]" />
              </div>
            </div>

            <div>
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t.workingPlaceLabel}</Label>
              <WorkingPlaceSelect
                value={form.working_place}
                onChange={name => setForm(f => ({ ...f, working_place: name, site_number: requiresSite(name) ? f.site_number : '' }))}
                placeholder={t.selectWorkingPlaceOptional}
              />
            </div>

            {form.working_place && requiresSite(form.working_place) && (
              <div>
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t.siteNumberLabel} <span className="text-destructive">*</span></Label>
                <Input type="text" value={form.site_number} onChange={e => setForm(f => ({ ...f, site_number: e.target.value }))}
                  placeholder={t.egSite} />
              </div>
            )}
          </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)} className="flex-1">{t.cancel}</Button>
            <Button onClick={handleSave} disabled={saving} className="flex-1">
              <Save className="w-4 h-4" />{saving ? t.saving : t.assignWord}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      )}

      {/* Manual single working-schedule entry */}
      {canSchedules && (
      <Dialog open={showSchedForm} onOpenChange={setShowSchedForm}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Define a working place</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">Employee <span className="text-destructive">*</span></Label>
              <SearchableSelect
                value={schedForm.epf_number}
                onChange={epf => setSchedForm(f => ({ ...f, epf_number: epf }))}
                placeholder={t.selectEmployeePlaceholder}
                icon={<Users className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                emptyLabel={t.noMatchingEmployees}
                options={schedulableTechs.map(u => ({
                  value: u.epf_number,
                  label: u.display_name,
                  sublabel: `${u.role} · ${u.epf_number}`,
                }))}
              />
              {schedulableTechs.length === 0 && <p className="text-[11px] text-warning mt-1">No technicians in your scope.</p>}
            </div>

            <div>
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">From date <span className="text-destructive">*</span></Label>
              <Input type="date" value={schedForm.from_date}
                onClick={e => { try { (e.currentTarget as HTMLInputElement).showPicker?.(); } catch { /* not supported */ } }}
                onChange={e => setSchedForm(f => ({ ...f, from_date: e.target.value }))} />
              <p className="text-[11px] text-muted-foreground mt-1">The working place applies from this date onward.</p>
            </div>

            <div>
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t.workingPlaceLabel} <span className="text-destructive">*</span></Label>
              <SmartWorkingPlaceSelect
                value={schedForm.working_place}
                onChange={name => setSchedForm(f => ({ ...f, working_place: name, site_number: requiresSite(name) ? f.site_number : '' }))}
              />
            </div>

            {schedForm.working_place && requiresSite(schedForm.working_place) && (
              <div>
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t.siteNumberLabel} <span className="text-destructive">*</span></Label>
                <Input type="text" value={schedForm.site_number} onChange={e => setSchedForm(f => ({ ...f, site_number: e.target.value }))}
                  placeholder={t.egSite} />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSchedForm(false)} className="flex-1">{t.cancel}</Button>
            <Button onClick={handleSaveSchedule} disabled={schedSaving} className="flex-1">
              <Save className="w-4 h-4" />{schedSaving ? t.saving : t.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      )}

      {/* Edit existing schedule(s) — single or bulk (same working place) */}
      {canSchedules && (
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editTargets.length > 1 ? `Edit ${editTargets.length} schedules` : 'Edit working schedule'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
              <span className="text-muted-foreground">{editTargets.length > 1 ? 'Technicians: ' : 'Technician: '}</span>
              <span className="text-foreground font-medium">
                {editTargets.slice(0, 6).map(tg => tg.name).join(', ')}{editTargets.length > 6 ? `, +${editTargets.length - 6} more` : ''}
              </span>
            </div>

            <div>
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">From date <span className="text-destructive">*</span></Label>
              <Input type="date" value={editForm.from_date}
                onClick={e => { try { (e.currentTarget as HTMLInputElement).showPicker?.(); } catch { /* not supported */ } }}
                onChange={e => setEditForm(f => ({ ...f, from_date: e.target.value }))} />
              <p className="text-[11px] text-muted-foreground mt-1">The working place applies from this date onward.</p>
            </div>

            <div>
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t.workingPlaceLabel} <span className="text-destructive">*</span></Label>
              <SmartWorkingPlaceSelect
                value={editForm.working_place}
                onChange={name => setEditForm(f => ({ ...f, working_place: name, site_number: requiresSite(name) ? f.site_number : '' }))}
              />
            </div>

            {editForm.working_place && requiresSite(editForm.working_place) && (
              <div>
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t.siteNumberLabel} <span className="text-destructive">*</span></Label>
                <Input type="text" value={editForm.site_number} onChange={e => setEditForm(f => ({ ...f, site_number: e.target.value }))}
                  placeholder={t.egSite} />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} className="flex-1">{t.cancel}</Button>
            <Button onClick={handleSaveEdit} disabled={editSaving} className="flex-1">
              <Save className="w-4 h-4" />{editSaving ? t.saving : t.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      )}

      <ConfirmModal
        open={!!confirmRemoveAssignment}
        onOpenChange={() => setConfirmRemoveAssignment(null)}
        variant="danger"
        title={t.deleteWord}
        description={
          confirmRemoveAssignment
            ? t.removeShiftConfirm
                .replace('{name}', confirmRemoveAssignment.employee_name)
                .replace('{from}', confirmRemoveAssignment.from_date)
                .replace('{to}', confirmRemoveAssignment.to_date)
            : undefined
        }
        confirmText={t.removeWord}
        onConfirm={async () => {
          const a = confirmRemoveAssignment;
          setConfirmRemoveAssignment(null);
          if (a) await handleDelete(a);
        }}
      />
    </PageTransition>
  );
}

// Southern Lanka (carecode.org) gets its own /shifts content — the roster-assignment page
// below is every OTHER tenant's Shifts page and stays hidden from southernlanka. Same route,
// same sidebar link (useSidebarNav.ts), branched purely on tenant so nothing else has to know.
export default function ShiftsPage() {
  if (tenant.id === 'southernlanka') return <SouthernlankaShifts />;
  return <ShiftsAdminContent />;
}
