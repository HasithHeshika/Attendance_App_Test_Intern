'use client';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Portal from '@/components/Portal';
import {
  ListTodo, Plus, Trash2, Check, Clock, MapPin, ChevronLeft, ChevronRight,
  CalendarDays, Loader2, AlertTriangle, CornerDownRight, Users, Pencil, X, CircleDot,
  LayoutGrid, Rows3, CheckCircle2, Hourglass, Kanban, UserPlus, GripVertical, MessageSquare, Send,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { DayPicker, type DayContentProps } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import {
  DndContext, useDroppable, useDraggable, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { useT } from '@/store/appStore';
import { localDateString, formatTime } from '@/lib/utils';
import { parseQuickAdd } from '@/lib/taskQuickAdd';
import { parseMentions, splitMentionSegments } from '@/lib/mentions';
import { type WorkItem, toWorkItem, assignedTaskToWorkItem } from '@/lib/workItem';
import { getUserByEpf } from '@/services/userService';
import {
  getMonthlyTasks, getTeamTasks, getTeamTasksForMonth, getTeamRoster, getDayAttendance,
  createTask, updateTask, deleteTask, rollOverOpenTasks, computeWorkedHours,
  getOpenTaskSuggestions, propagateCompletion, nextTaskStatus,
  type TaskInput, type TaskSuggestion, type RosterMember,
} from '@/services/taskService';
import {
  createAssignedTask, deleteAssignedTask,
  addAssigneeToTask, removeAssigneeFromTask,
  addComment, getComments, getMyAssignedTasks, getTeamAssignedTasks,
  getCustomStatuses, addCustomStatus, type TaskActor,
} from '@/services/assignedTaskService';
import {
  AssignedTaskRow, AssignedTaskTimeline, AssignedTaskActionCluster, useAssignedTaskActions,
  TaskTimes, TaskFlagLine, TaskFlagPill,
} from '@/components/tasks/AssignedTaskLifecycle';
import LogPupTaskList from '@/components/tasks/LogPupTaskList';
import {
  TASK_TYPES, TASK_STATUSES, type DailyTask, type TaskType, type TaskStatus,
  type AttendanceRecord, type AttendanceSession,
  type AssignedTask, type AssignedTaskComment,
} from '@/lib/types';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState as UiEmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/Skeleton';
import { PageTransition, Reveal, Stagger, StaggerItem } from '@/components/ui/motion';
import ConfirmModal from '@/components/ConfirmModal';
import { auth } from '@/lib/firebase';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const HOURS_TOLERANCE = 0.25; // mismatch threshold between logged & attended hours
const GENERAL = '__general__';

const fmtLong  = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const fmtRow   = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const fmtShort = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtMonth = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
// Assigned tasks list newest first — the latest thing put on someone's plate is on top.
const newestFirst = (a: AssignedTask, b: AssignedTask) => (b.created_at?.toMillis?.() ?? 0) - (a.created_at?.toMillis?.() ?? 0);

interface TaskMeta {
  epf_number: string; employee_name: string; company_id: string;
  company_name: string; department: string;
}

interface FormState {
  description: string; task_type: TaskType; status: TaskStatus;
  hours: string; remarks: string; target: string; date: string; // target = session id or GENERAL
}

const emptyForm: FormState = {
  description: '', task_type: 'One Time', status: 'On Progress',
  hours: '', remarks: '', target: GENERAL, date: '',
};

interface AssignFormState {
  assignees: RosterMember[]; description: string; task_type: TaskType; date: string;
}

const emptyAssignForm: AssignFormState = {
  assignees: [], description: '', task_type: 'One Time', date: '',
};

// ─── Page ─────────────────────────────────────────────────────────────────────
// A Firestore read that lands after the session ends — the page is still mounted while the
// sign-out redirect runs, so an in-flight query comes back "Missing or insufficient
// permissions". That is the session ending, not a failure the person needs to hear about, so it
// is swallowed instead of shown as "Failed to load tasks" over the login screen. A denial while
// still signed in is a real rules problem and is still reported.
function isSignedOutDenial(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return !auth.currentUser && (code === 'permission-denied' || code === 'unauthenticated');
}

export default function TasksPage() {
  const { user } = useAuthStore();
  const caps = useUserCapabilities();
  const tr = useT();
  const canViewTeam = caps.can_view_team_tasks;
  const canLogOwn = caps.has_tasks;
  const canAssign = caps.can_assign_tasks;
  // Back-office roles see the whole company's tasks; line supervisors see direct reports.
  const companyWideTeam = caps.is_system_admin || caps.can_manage_users || caps.can_report;

  const [view, setView] = useState<'calendar' | 'list' | 'board'>('calendar');
  const [mode, setMode] = useState<'mine' | 'team'>('mine');
  const [selectedEmp, setSelectedEmp] = useState<string | null>(null); // team view: epf filter (null = all)

  const [calMonth, setCalMonth] = useState<Date>(() => parseYmd(localDateString()));
  const [selectedDate, setSelectedDate] = useState<Date>(() => parseYmd(localDateString()));

  const [monthTasks, setMonthTasks] = useState<DailyTask[]>([]);
  const [teamTasks, setTeamTasks] = useState<DailyTask[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [teamMonthTasks, setTeamMonthTasks] = useState<DailyTask[]>([]); // month-ranged, for the team Board
  const [assignedTasksMine, setAssignedTasksMine] = useState<AssignedTask[]>([]); // month-ranged, for the personal Board
  const [teamAssignedTasks, setTeamAssignedTasks] = useState<AssignedTask[]>([]); // for the team Board
  const [dayAttendance, setDayAttendance] = useState<AttendanceRecord | null>(null);
  const [monthBusy, setMonthBusy] = useState(false);
  const [dayBusy, setDayBusy] = useState(false);
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamMonthBusy, setTeamMonthBusy] = useState(false);
  const [assignedMineBusy, setAssignedMineBusy] = useState(false);
  const [teamAssignedBusy, setTeamAssignedBusy] = useState(false);
  const [rosterBusy, setRosterBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rolledNote, setRolledNote] = useState(0);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [suggestions, setSuggestions] = useState<TaskSuggestion[]>([]);
  const [descFocused, setDescFocused] = useState(false);

  const [showAssignForm, setShowAssignForm] = useState(false);
  const [assignForm, setAssignForm] = useState<AssignFormState>(emptyAssignForm);
  const [assignSaving, setAssignSaving] = useState(false);
  const [quickAddText, setQuickAddText] = useState('');
  const [quickAddPreview, setQuickAddPreview] = useState<string | null>(null);

  const [assignedDetailId, setAssignedDetailId] = useState<string | null>(null);
  const [comments, setComments] = useState<AssignedTaskComment[]>([]);
  const [commentsBusy, setCommentsBusy] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [postingComment, setPostingComment] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null); // non-null while an "@partial" is being typed in the comment box
  const [addAssigneePickerOpen, setAddAssigneePickerOpen] = useState(false);
  const [newAssignees, setNewAssignees] = useState<RosterMember[]>([]);
  const [addingAssignees, setAddingAssignees] = useState(false);
  const [removingAssignee, setRemovingAssignee] = useState<string | null>(null); // epf currently being removed
  const [timelineKey, setTimelineKey] = useState(0); // bumped after every lifecycle action so the detail trail refetches

  const [customStatuses, setCustomStatuses] = useState<string[]>([]);
  const [addStatusOpen, setAddStatusOpen] = useState(false);
  const [newStatusName, setNewStatusName] = useState('');
  const [addingStatus, setAddingStatus] = useState(false);

  const metaRef = useRef<TaskMeta | null>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const rolledOnce = useRef(false);
  const loadedOnce = useRef(false); // true after the first data load → never blank again
  const monthKeyRef = useRef('');   // latest requested month — stale background refreshes are dropped

  const selDateStr = ymd(selectedDate);
  const todayStr = localDateString();

  // Resolve the canonical user doc once (auth store lacks company_id).
  const ensureMeta = useCallback(async (): Promise<TaskMeta | null> => {
    if (metaRef.current) return metaRef.current;
    const epf = user?.epf_number ?? '';
    if (!epf) return null;
    const u = await getUserByEpf(epf);
    metaRef.current = {
      epf_number: epf,
      employee_name: u?.display_name ?? user?.name ?? epf,
      company_id: u?.company_id ?? '',
      company_name: u?.company_name ?? user?.company ?? '',
      department: u?.department ?? user?.department ?? '',
    };
    return metaRef.current;
  }, [user]);

  // ── Data loading — split per section so a background refresh updates only the
  //    relevant part instead of blanking the whole page, and switching the selected
  //    day doesn't refetch the whole month (day tasks derive from monthTasks). ──
  // Returns how many tasks were rolled (0 when it already ran) so the caller knows
  // whether the month needs a refresh.
  const carryOverOnce = useCallback(async (epf: string): Promise<number> => {
    if (rolledOnce.current) return 0;
    rolledOnce.current = true;
    try {
      const n = await rollOverOpenTasks(epf);
      if (n > 0) setRolledNote(n);
      return n;
    } catch (e) { console.warn('[tasks] roll-over failed (non-critical)', e); return 0; }
  }, []);

  const loadMonth = useCallback(async () => {
    const epf = user?.epf_number ?? '';
    if (!epf || mode !== 'mine') return;
    const monthKey = `${calMonth.getFullYear()}-${calMonth.getMonth() + 1}`;
    monthKeyRef.current = monthKey;
    setMonthBusy(true);
    try {
      // Paint the month immediately; the carry-over (reads + writes) used to block
      // this and is now a background pass that refreshes the month only if it
      // actually rolled something forward.
      setMonthTasks(await getMonthlyTasks(epf, calMonth.getFullYear(), calMonth.getMonth() + 1));
    } catch (e) {
      if (isSignedOutDenial(e)) return;
      console.error('[tasks] month load error', e); toast.error(tr.failedLoadTasks);
    }
    finally { setMonthBusy(false); loadedOnce.current = true; }
    try {
      if (await carryOverOnce(epf) > 0 && monthKeyRef.current === monthKey) {
        const fresh = await getMonthlyTasks(epf, calMonth.getFullYear(), calMonth.getMonth() + 1);
        // Drop the refresh if the user moved to another month while it was in flight.
        if (monthKeyRef.current === monthKey) setMonthTasks(fresh);
      }
    } catch (e) { console.warn('[tasks] post-rollover refresh failed', e); }
  }, [user?.epf_number, mode, calMonth, carryOverOnce]);

  const loadDay = useCallback(async () => {
    const epf = user?.epf_number ?? '';
    if (!epf || mode !== 'mine') return;
    setDayBusy(true);
    try {
      setDayAttendance(await getDayAttendance(epf, selDateStr));
    } catch (e) { console.error('[tasks] day load error', e); }
    finally { setDayBusy(false); loadedOnce.current = true; }
  }, [user?.epf_number, mode, selDateStr]);

  const loadTeam = useCallback(async () => {
    const epf = user?.epf_number ?? '';
    if (!epf || mode !== 'team' || !canViewTeam) return;
    setTeamBusy(true);
    try {
      // Only company_id is needed here — use the auth store's copy when present and
      // save the user-doc round trip; ensureMeta remains the fallback (older sessions
      // persisted before company_id was added to the store).
      const companyId = user?.company_id || (await ensureMeta())?.company_id;
      setTeamTasks(await getTeamTasks({
        viewerEpf: epf, date: selDateStr,
        companyId: companyId || undefined, companyWide: companyWideTeam,
      }));
    } catch (e) {
      if (isSignedOutDenial(e)) return;
      console.error('[tasks] team load error', e); toast.error(tr.failedLoadTasks);
    }
    finally { setTeamBusy(false); loadedOnce.current = true; }
  }, [user?.epf_number, user?.company_id, mode, canViewTeam, companyWideTeam, selDateStr, ensureMeta]);

  // Team roster — every teammate the viewer may see/assign to, independent of whether
  // they have a task on any particular day. Needed for the Assign Task picker and to
  // let zero-task teammates still appear (with an Assign action) on the team calendar.
  const loadRoster = useCallback(async () => {
    const epf = user?.epf_number ?? '';
    if (!epf || (!canViewTeam && !canAssign)) return;
    setRosterBusy(true);
    try {
      const companyId = user?.company_id || (await ensureMeta())?.company_id;
      setRoster(await getTeamRoster({
        viewerEpf: epf, companyId: companyId || undefined, companyWide: companyWideTeam,
      }));
    } catch (e) { console.error('[tasks] roster load error', e); }
    finally { setRosterBusy(false); }
  }, [user?.epf_number, user?.company_id, canViewTeam, canAssign, companyWideTeam, ensureMeta]);

  // Month-ranged team tasks — only needed for the team Board (a single day is too
  // narrow for a persistent Kanban view).
  const loadTeamMonth = useCallback(async () => {
    const epf = user?.epf_number ?? '';
    if (!epf || mode !== 'team' || view !== 'board' || !canViewTeam) return;
    setTeamMonthBusy(true);
    try {
      const companyId = user?.company_id || (await ensureMeta())?.company_id;
      setTeamMonthTasks(await getTeamTasksForMonth({
        viewerEpf: epf, year: calMonth.getFullYear(), month: calMonth.getMonth() + 1,
        companyId: companyId || undefined, companyWide: companyWideTeam,
      }));
    } catch (e) {
      if (isSignedOutDenial(e)) return;
      console.error('[tasks] team month load error', e); toast.error(tr.failedLoadTasks);
    }
    finally { setTeamMonthBusy(false); }
  }, [user?.epf_number, user?.company_id, mode, view, canViewTeam, companyWideTeam, calMonth, ensureMeta]);

  // Shared/multi-assignee tasks (assigned_tasks collection) — month-ranged. Every view
  // needs them now: the calendar dots and day panel, the list groups and the Board.
  const loadAssignedMine = useCallback(async () => {
    const epf = user?.epf_number ?? '';
    if (!epf || mode !== 'mine') return;
    setAssignedMineBusy(true);
    try {
      const prefix = `${calMonth.getFullYear()}-${String(calMonth.getMonth() + 1).padStart(2, '0')}`;
      setAssignedTasksMine(await getMyAssignedTasks(epf, { fromDate: `${prefix}-01`, toDate: `${prefix}-31` }));
    } catch (e) { console.error('[tasks] assigned (mine) load error', e); }
    finally { setAssignedMineBusy(false); }
  }, [user?.epf_number, mode, calMonth]);

  const loadTeamAssigned = useCallback(async () => {
    const epf = user?.epf_number ?? '';
    if (!epf || mode !== 'team' || !canViewTeam) return;
    setTeamAssignedBusy(true);
    try {
      const companyId = user?.company_id || (await ensureMeta())?.company_id;
      setTeamAssignedTasks(await getTeamAssignedTasks({
        viewerEpf: epf, companyId: companyId || undefined, companyWide: companyWideTeam,
      }));
    } catch (e) { console.error('[tasks] assigned (team) load error', e); }
    finally { setTeamAssignedBusy(false); }
  }, [user?.epf_number, user?.company_id, mode, canViewTeam, companyWideTeam, ensureMeta]);

  // Custom Board statuses shared across the company (beyond Pending/On Progress/
  // Completed) — only needed once the Board is actually shown.
  const loadCustomStatuses = useCallback(async () => {
    if (view !== 'board') return;
    try {
      const companyId = user?.company_id || (await ensureMeta())?.company_id;
      if (companyId) setCustomStatuses(await getCustomStatuses(companyId));
    } catch (e) { console.warn('[tasks] custom statuses load failed (non-critical)', e); }
  }, [view, user?.company_id, ensureMeta]);

  // Re-fetch only what the current view shows (used after add/edit/delete).
  const refresh = useCallback(() => {
    if (mode === 'team') { loadTeam(); loadTeamMonth(); loadTeamAssigned(); }
    else { loadMonth(); loadDay(); loadAssignedMine(); }
  }, [mode, loadTeam, loadTeamMonth, loadTeamAssigned, loadMonth, loadDay, loadAssignedMine]);

  const enabled = canLogOwn || canViewTeam;
  useEffect(() => { if (enabled) loadMonth(); }, [enabled, loadMonth]);
  useEffect(() => { if (enabled) loadDay(); }, [enabled, loadDay]);
  useEffect(() => { if (enabled) loadTeam(); }, [enabled, loadTeam]);
  useEffect(() => { if (enabled) loadRoster(); }, [enabled, loadRoster]);
  useEffect(() => { if (enabled) loadTeamMonth(); }, [enabled, loadTeamMonth]);
  useEffect(() => { if (enabled) loadAssignedMine(); }, [enabled, loadAssignedMine]);
  useEffect(() => { if (enabled) loadTeamAssigned(); }, [enabled, loadTeamAssigned]);
  useEffect(() => { if (enabled) loadCustomStatuses(); }, [enabled, loadCustomStatuses]);

  const busy = monthBusy || dayBusy || teamBusy;

  // Lock the mode for single-capability roles (team-only → Team; own-only → My Tasks).
  useEffect(() => {
    if (!canLogOwn && canViewTeam) setMode('team');
    else if (canLogOwn && !canViewTeam) setMode('mine');
  }, [canLogOwn, canViewTeam]);

  // "List" is a mine-only view (per-day groups) — fall back to Calendar if Team mode
  // is selected while it's active.
  useEffect(() => { if (mode === 'team' && view === 'list') setView('calendar'); }, [mode, view]);

  // Load pending-task suggestions when the Add form opens.
  useEffect(() => {
    if (!showForm || editingId) return;
    let active = true;
    getOpenTaskSuggestions(user?.epf_number ?? '')
      .then(s => { if (active) setSuggestions(s); })
      .catch(() => { /* non-critical */ });
    return () => { active = false; };
  }, [showForm, editingId, user?.epf_number]);

  // ── Derived ────────────────────────────────────────────────────────────────
  // A carried-over task is one logical task spread across day-docs linked by
  // rolled_from/rolled_to. When it's finished on a later day, stamp EVERY day it
  // appeared with that completion date so each shows a "Completed <date>" badge.
  // The stored `completed_on` (written at completion time) wins; otherwise we derive
  // it from the completed doc in the same chain within the loaded month — so tasks
  // completed before this field existed still show the badge without any migration.
  const displayTasks = useMemo(() => {
    const byId = new Map(monthTasks.map(t => [t.id, t]));
    const chainOf = (startId: string) => {
      const ids = new Set<string>([startId]);
      let cur = byId.get(startId);
      while (cur?.rolled_from && byId.has(cur.rolled_from) && !ids.has(cur.rolled_from)) { ids.add(cur.rolled_from); cur = byId.get(cur.rolled_from); }
      cur = byId.get(startId);
      while (cur?.rolled_to && byId.has(cur.rolled_to) && !ids.has(cur.rolled_to)) { ids.add(cur.rolled_to); cur = byId.get(cur.rolled_to); }
      return ids;
    };
    return monthTasks.map(t => {
      if (t.completed_on) return t;                       // already stamped
      const done = Array.from(chainOf(t.id))
        .map(id => byId.get(id))
        .filter((x): x is DailyTask => !!x && x.status === 'Completed')
        .sort((a, b) => (a.completed_on ?? a.date).localeCompare(b.completed_on ?? b.date))
        .pop();
      return done ? { ...t, completed_on: done.completed_on ?? done.date } : t;
    });
  }, [monthTasks]);

  const dayTasks = useMemo(
    () => displayTasks.filter(t => t.date === selDateStr)
      .sort((a, b) => (a.created_at?.toMillis?.() ?? 0) - (b.created_at?.toMillis?.() ?? 0)),
    [displayTasks, selDateStr],
  );

  const sessions: AttendanceSession[] = dayAttendance?.sessions?.length ? dayAttendance.sessions : [];
  const sessionIds = new Set(sessions.map(s => s.id));
  const generalTasks = dayTasks.filter(t => !t.session_id || !sessionIds.has(t.session_id));
  const tasksForSession = (id: string) => dayTasks.filter(t => t.session_id === id);

  const loggedHours = dayTasks.reduce((sum, t) => sum + (Number(t.hours) || 0), 0);
  const attendedHours = computeWorkedHours(dayAttendance);
  const hoursMismatch = attendedHours > 0 && Math.abs(loggedHours - attendedHours) > HOURS_TOLERANCE;

  // Whoever is acting on an assigned task — stamps the clock and the trail in the service.
  const actor: TaskActor | null = useMemo(
    () => user?.epf_number ? { epf: user.epf_number, name: user.name || user.epf_number } : null,
    [user?.epf_number, user?.name],
  );
  // Who may act on an assigned task: the people on it, the person who assigned it, or a
  // supervisor who can assign. Everyone else only reads.
  const canActOn = useCallback((t: AssignedTask) => {
    const me = user?.epf_number ?? '';
    return canAssign || t.assigned_by === me || (t.assignee_epfs ?? []).includes(me);
  }, [user?.epf_number, canAssign]);

  // The assigned tasks the current mode is looking at.
  const assignedInView = mode === 'team' ? teamAssignedTasks : assignedTasksMine;
  const dayAssigned = useMemo(
    () => assignedInView.filter(t => t.date === selDateStr).sort(newestFirst),
    [assignedInView, selDateStr],
  );

  // Per-day info for the calendar dots (amber = something open, emerald = all done, rose =
  // something needs attention: an assigned task nobody can start, or one open past its date).
  // A task carried over and finished later counts as done on its earlier days too
  // (completed_on set), so a day whose work is ultimately complete shows the "done" dot.
  // Assigned tasks land on their current date — a delay with a new date already moved them.
  const dayInfo = useMemo(() => {
    const m = new Map<string, { open: boolean; attention: boolean; total: number }>();
    const at = (date: string) => m.get(date) ?? { open: false, attention: false, total: 0 };
    displayTasks.forEach(t => {
      const cur = at(t.date);
      cur.total += Number(t.hours) || 0;
      if (t.status !== 'Completed' && !t.completed_on) cur.open = true;
      m.set(t.date, cur);
    });
    assignedInView.forEach(t => {
      const cur = at(t.date);
      const open = t.status !== 'Completed';
      if (open) cur.open = true;
      if (t.flag?.kind === 'cannot_start' || (open && t.date < todayStr)) cur.attention = true;
      m.set(t.date, cur);
    });
    return m;
  }, [displayTasks, assignedInView, todayStr]);

  // Month summary for the list view — hours are personal (assigned tasks carry none), the
  // counts cover both.
  const monthSummary = useMemo(() => {
    const total = monthTasks.reduce((s, t) => s + (Number(t.hours) || 0), 0);
    const done = monthTasks.filter(t => t.status === 'Completed').length
      + assignedTasksMine.filter(t => t.status === 'Completed').length;
    const count = monthTasks.length + assignedTasksMine.length;
    return { total, done, open: count - done, count };
  }, [monthTasks, assignedTasksMine]);

  // Month tasks grouped by date (newest first) for the list view — the personal rows and,
  // under them, whatever was assigned to me that day.
  const listGroups = useMemo(() => {
    const byDate = new Map<string, { items: DailyTask[]; assigned: AssignedTask[] }>();
    const at = (date: string) => byDate.get(date) ?? byDate.set(date, { items: [], assigned: [] }).get(date)!;
    displayTasks.forEach(t => { at(t.date).items.push(t); });
    assignedTasksMine.forEach(t => { at(t.date).assigned.push(t); });
    return Array.from(byDate.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, g]) => ({
        date,
        items: g.items.sort((a, b) => (a.created_at?.toMillis?.() ?? 0) - (b.created_at?.toMillis?.() ?? 0)),
        assigned: g.assigned.sort(newestFirst),
        total: g.items.reduce((s, t) => s + (Number(t.hours) || 0), 0),
      }));
  }, [displayTasks, assignedTasksMine]);

  // Team tasks grouped by employee (keyed by EPF) for the selected day — only
  // teammates who actually have a task that day appear here (assigning to someone
  // new is done via the header-level "Assign Task" button, which lists the whole
  // roster regardless of that day's tasks).
  const teamGroups = useMemo(() => {
    const byEpf = new Map<string, { name: string; items: DailyTask[] }>();
    for (const t of teamTasks) {
      const g = byEpf.get(t.epf_number) ?? { name: t.employee_name, items: [] };
      g.items.push(t);
      byEpf.set(t.epf_number, g);
    }
    return Array.from(byEpf.entries())
      .map(([epf, g]) => ({
        epf, name: g.name, items: g.items,
        total: g.items.reduce((s, x) => s + (Number(x.hours) || 0), 0),
        hasOpen: g.items.some(t => t.status !== 'Completed'),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [teamTasks]);
  // Selected teammate, auto-falling back to "All" if they have nothing on the chosen day.
  const activeEmp = selectedEmp && teamGroups.some(g => g.epf === selectedEmp) ? selectedEmp : null;

  // Board data source: own month tasks + assigned-to-me tasks in 'mine' mode,
  // month-ranged team tasks + team-scoped assigned tasks in 'team' mode (single-day
  // getTeamTasks is too narrow for a persistent Kanban view). Normalized to WorkItem
  // so both underlying doc shapes render/drag identically — an AssignedTask maps to
  // exactly one WorkItem now (one shared status for the whole task).
  const boardItems: WorkItem[] = useMemo(() => {
    if (mode === 'team') {
      return [...teamMonthTasks.map(toWorkItem), ...teamAssignedTasks.map(assignedTaskToWorkItem)];
    }
    return [...monthTasks.map(toWorkItem), ...assignedTasksMine.map(assignedTaskToWorkItem)];
  }, [mode, teamMonthTasks, teamAssignedTasks, monthTasks, assignedTasksMine]);
  const boardBusy = mode === 'team' ? (teamMonthBusy || teamAssignedBusy) : (monthBusy || assignedMineBusy);

  // Board/detail-modal status columns: the 3 built-in defaults, plus any custom
  // statuses the company has added, plus (belt-and-suspenders) any stray status value
  // already present in the loaded data that isn't in either list yet.
  const statusColumns: string[] = useMemo(() => {
    const base = [...TASK_STATUSES] as string[];
    const known = new Set(base);
    const customs = customStatuses.filter(s => !known.has(s));
    customs.forEach(s => known.add(s));
    const stray = Array.from(new Set(boardItems.map(i => i.status))).filter(s => !known.has(s));
    return [...base, ...customs, ...stray];
  }, [customStatuses, boardItems]);

  const handleAddStatus = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || statusColumns.includes(trimmed)) return;
    setAddingStatus(true);
    try {
      const companyId = user?.company_id || (await ensureMeta())?.company_id;
      if (companyId) { await addCustomStatus(companyId, trimmed); await loadCustomStatuses(); }
    } catch (e) { console.error('[tasks] add status failed', e); toast.error(tr.failedSaveTask); }
    setAddingStatus(false);
    return trimmed;
  };

  // Lifecycle actions for the detail modal and the Board — one hook, so a drop on a
  // column and a pill in the modal go through the same note prompt and the same write.
  // Its dialogs render at page level (see the end of the JSX), outside the modal backdrop.
  const afterAssignedAction = useCallback(() => {
    loadAssignedMine(); loadTeamAssigned(); setTimelineKey(k => k + 1);
  }, [loadAssignedMine, loadTeamAssigned]);
  const taskActions = useAssignedTaskActions({ actor, onChanged: afterAssignedAction });
  const findAssigned = (id: string) => [...assignedTasksMine, ...teamAssignedTasks].find(a => a.id === id) ?? null;

  // Status-change / click dispatch for the Board — branches by WorkItem.kind since
  // 'daily' and 'assigned' items are backed by different collections/services. An
  // assigned card asks for a note first (StatusNoteDialog; Skip sends an empty one) and
  // then writes with the actor so the clock and the trail are kept.
  const handleWorkItemStatusChange = (item: WorkItem, next: string) => {
    if (item.kind === 'daily') {
      // Personal daily tasks only ever support the 3 built-in statuses — a custom
      // column is an assigned-task-only concept, silently ignore a drop there.
      if (!(TASK_STATUSES as readonly string[]).includes(next)) return;
      const source = mode === 'team' ? teamMonthTasks : monthTasks;
      const t = source.find(x => x.id === item.id);
      if (t) changeTaskStatus(t, next as TaskStatus);
      return;
    }
    const task = findAssigned(item.id);
    if (task) taskActions.changeStatus(task, next);
  };
  const handleWorkItemClick = (item: WorkItem) => {
    if (item.kind === 'daily') {
      const source = mode === 'team' ? teamMonthTasks : monthTasks;
      const t = source.find(x => x.id === item.id);
      if (t) openEdit(t);
      return;
    }
    setAssignedDetailId(item.id);
  };

  // ── Navigation ─────────────────────────────────────────────────────────────
  const goToMonth = (m: Date) => {
    setCalMonth(m);
    const now = new Date();
    setSelectedDate(
      m.getFullYear() === now.getFullYear() && m.getMonth() === now.getMonth()
        ? now
        : new Date(m.getFullYear(), m.getMonth(), 1),
    );
  };
  const shiftMonth = (delta: number) => goToMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() + delta, 1));

  // ── Form handlers ──────────────────────────────────────────────────────────
  const openAdd = (target: string = GENERAL, date: string = selDateStr) => {
    setEditingId(null);
    // Future-dated tasks start life as 'Pending' (not yet started); today/past keep
    // the existing 'On Progress' default.
    setForm({ ...emptyForm, target, date, status: date > todayStr ? 'Pending' : 'On Progress' });
    setShowForm(true);
  };
  const openEdit = (t: DailyTask) => {
    setEditingId(t.id);
    setForm({
      description: t.description, task_type: t.task_type, status: t.status,
      hours: t.hours ? String(t.hours) : '', remarks: t.remarks ?? '',
      target: t.session_id ?? GENERAL, date: t.date,
    });
    setShowForm(true);
  };
  const closeForm = () => { setShowForm(false); setEditingId(null); setForm(emptyForm); setDescFocused(false); };

  // Fill the form from a pending-task suggestion (continue existing open work).
  const pickSuggestion = (s: TaskSuggestion) => {
    setForm(f => ({
      ...f,
      description: s.description,
      task_type: s.task_type,
      status: 'On Progress',
      remarks: f.remarks || s.remarks,
    }));
    setDescFocused(false);
  };

  // Load open-task suggestions when the Add form opens.
  const descQuery = form.description.trim().toLowerCase();
  const filteredSuggestions = (descFocused && !editingId)
    ? suggestions.filter(s => s.description.toLowerCase().includes(descQuery)).slice(0, 6)
    : [];

  // Sessions are only known for the loaded selected day; assigning to a session is
  // therefore only offered when the form's date matches it.
  const formOnSelectedDay = form.date === selDateStr;
  const formSessions = formOnSelectedDay ? sessions : [];

  // The task being edited was carried over and finished on a LATER day → its status is
  // locked here (completing it on this day would move the completion to the wrong date).
  const editingTask = editingId ? displayTasks.find(x => x.id === editingId) : null;
  const editingCompletedElsewhere = !!editingTask?.completed_on && editingTask.completed_on !== editingTask.date;

  // Auto-timing: the worked duration of the task's target (a single session, or the whole
  // day for a general task). Quick-fill buttons set the hours to a % of this; exceeding it
  // is allowed — we only warn (a person may log more than their check-in/out span).
  const sessionHours = (s?: AttendanceSession | null) => {
    const ci = s?.check_in?.toDate?.();
    if (!ci) return 0;
    const co = s?.check_out?.toDate?.();
    return Math.max(0, ((co ?? new Date()).getTime() - ci.getTime()) / 3_600_000);
  };
  const formTargetSession = form.target !== GENERAL ? formSessions.find(s => s.id === form.target) : null;
  const availableHours = formTargetSession ? sessionHours(formTargetSession)
    : (formOnSelectedDay ? attendedHours : 0);
  const hoursExceed = availableHours > 0 && Number(form.hours || 0) > availableHours + 0.01;

  const handleSave = async () => {
    if (!form.description.trim()) { toast.error(tr.taskDescRequired); return; }
    if (!form.date) { toast.error(tr.pickDate); return; }
    const hoursNum = form.hours === '' ? 0 : Number(form.hours);
    if (isNaN(hoursNum) || hoursNum < 0) { toast.error(tr.enterValidHours); return; }

    const m = await ensureMeta();
    if (!m) { toast.error(tr.userNotReady); return; }

    const sessionId = (form.target === GENERAL || !formOnSelectedDay) ? null : form.target;
    const sess = sessions.find(s => s.id === sessionId);

    setSaving(true);
    try {
      if (editingId) {
        await updateTask(editingId, {
          description: form.description.trim(), task_type: form.task_type, status: form.status,
          hours: hoursNum, remarks: form.remarks.trim(),
          date: form.date, session_id: sessionId, working_place: sess?.working_place ?? null,
          // A task finished on another day has its status/completion locked — leave the
          // chain's completion date untouched so editing hours/remarks can't wipe it.
          ...(editingCompletedElsewhere ? {} : { completed_on: form.status === 'Completed' ? form.date : null }),
        });
        // Keep the whole rolled chain's completion date in sync with this edit (skip when
        // completion is locked — see above).
        if (!editingCompletedElsewhere) {
          const orig = monthTasks.find(x => x.id === editingId);
          if (orig) await propagateCompletion(orig, form.status === 'Completed' ? form.date : null);
        }
        toast.success(tr.taskUpdated);
      } else {
        const input: TaskInput = {
          ...m, date: form.date, session_id: sessionId, working_place: sess?.working_place ?? null,
          description: form.description.trim(), task_type: form.task_type, status: form.status,
          hours: hoursNum, remarks: form.remarks.trim(),
        };
        await createTask(input);
        toast.success(tr.taskAdded);
      }
      // Keep the month in sync with the date we just wrote to.
      const d = parseYmd(form.date);
      if (d.getMonth() !== calMonth.getMonth() || d.getFullYear() !== calMonth.getFullYear()) {
        setCalMonth(d); setSelectedDate(d);
      }
      closeForm();
      refresh();
    } catch (e) {
      console.error('[tasks] save error', e);
      toast.error(tr.failedSaveTask);
    }
    setSaving(false);
  };

  // ── Assign Task (supervisor → one or more teammates) ──────────────────────
  const openAssign = (epf: string = '') => {
    const preseed = epf ? roster.filter(r => r.epf_number === epf) : [];
    setAssignForm({ ...emptyAssignForm, assignees: preseed, date: todayStr });
    setQuickAddText('');
    setQuickAddPreview(null);
    setShowAssignForm(true);
  };
  const closeAssign = () => {
    setShowAssignForm(false); setAssignForm(emptyAssignForm);
    setQuickAddText(''); setQuickAddPreview(null);
  };

  // Local heuristic parse of the quick-add sentence (@ mentions still work manually
  // via AssigneePicker below — this just fast-fills the same fields from freeform
  // text). Never auto-submits; the user reviews the populated fields before Assign.
  const runQuickAddParse = () => {
    if (!quickAddText.trim()) return;
    const result = parseQuickAdd(quickAddText, roster, new Date());
    setAssignForm(f => {
      const merged = new Map(f.assignees.map(a => [a.epf_number, a]));
      result.assignees.forEach(a => merged.set(a.epf_number, a));
      return {
        ...f,
        assignees: Array.from(merged.values()),
        date: result.date,
        description: result.description || f.description,
      };
    });
    const names = result.assignees.map(a => a.employee_name).join(', ');
    setQuickAddPreview(
      tr.matchedPreviewTpl.replace('{names}', names || tr.noMatchesFound).replace('{date}', result.date),
    );
  };

  // Auto-parse the quick-add sentence as the user types, debounced so structured
  // fields don't jump around on every keystroke.
  useEffect(() => {
    if (!showAssignForm || !quickAddText.trim()) { setQuickAddPreview(null); return; }
    const id = setTimeout(runQuickAddParse, 500);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickAddText, showAssignForm]);

  const handleAssignSave = async () => {
    if (assignForm.assignees.length === 0) { toast.error(tr.selectEmployee); return; }
    if (!assignForm.description.trim()) { toast.error(tr.taskDescRequired); return; }
    if (!assignForm.date) { toast.error(tr.pickDate); return; }
    const m = await ensureMeta();
    if (!m) { toast.error(tr.userNotReady); return; }

    setAssignSaving(true);
    try {
      // One shared task, all picked assignees on it — NOT one doc per person.
      await createAssignedTask({
        company_id: m.company_id, company_name: m.company_name,
        description: assignForm.description.trim(), task_type: assignForm.task_type, date: assignForm.date,
        assignees: assignForm.assignees,
        assigned_by: m.epf_number, assigned_by_name: m.employee_name,
      });
      toast.success(assignForm.assignees.length > 1
        ? tr.taskAssignedPluralTpl.replace('{n}', String(assignForm.assignees.length))
        : tr.taskAssigned);
      closeAssign();
      refresh();
    } catch (e) {
      console.error('[tasks] assign save error', e);
      toast.error(tr.failedSaveTask);
    }
    setAssignSaving(false);
  };

  // ── Assigned Task detail (shared, multi-person task) ──────────────────────
  // Looked up from the already-loaded Board arrays rather than a fresh Firestore
  // read — the modal is only ever opened from a Board card, so the doc is
  // guaranteed to already be in one of these two, mirroring how the personal
  // edit modal derives `editingTask` from `displayTasks` below.
  const assignedDetailTask = assignedDetailId
    ? [...assignedTasksMine, ...teamAssignedTasks].find(a => a.id === assignedDetailId) ?? null
    : null;

  // Pending task-delete awaiting confirmation in <ConfirmModal> — either the personal
  // task row's delete, or the assigned-task detail modal's delete.
  const [confirmDelete, setConfirmDelete] = useState<
    { kind: 'assigned' } | { kind: 'task'; task: DailyTask } | null
  >(null);

  const closeAssignedDetail = () => {
    setAssignedDetailId(null); setComments([]); setCommentText(''); setMentionQuery(null);
    setAddAssigneePickerOpen(false); setNewAssignees([]); setAddStatusOpen(false); setNewStatusName('');
  };

  useEffect(() => {
    if (!assignedDetailId) return;
    let active = true;
    setCommentsBusy(true);
    getComments(assignedDetailId)
      .then(c => { if (active) setComments(c); })
      .catch(e => console.error('[tasks] comments load error', e))
      .finally(() => { if (active) setCommentsBusy(false); });
    return () => { active = false; };
  }, [assignedDetailId]);

  const reloadAssignedDetailSource = afterAssignedAction;

  // One shared status for the whole task — anyone changing it changes it for every
  // assignee, no per-person tracking. Goes through the note prompt like every other
  // status change.
  const handleDetailStatusChange = (next: string) => {
    if (!assignedDetailTask) return;
    taskActions.changeStatus(assignedDetailTask, next);
  };
  const statusChanging = taskActions.busy;

  const handleAddStatusInModal = async (name: string) => {
    const applied = await handleAddStatus(name);
    if (applied) handleDetailStatusChange(applied);
    setAddStatusOpen(false); setNewStatusName('');
  };

  const handleAddAssigneesToTask = async () => {
    if (!assignedDetailTask || newAssignees.length === 0) return;
    setAddingAssignees(true);
    try {
      await Promise.all(newAssignees.map(m => addAssigneeToTask(assignedDetailTask.id, m)));
      setNewAssignees([]);
      setAddAssigneePickerOpen(false);
      reloadAssignedDetailSource();
    } catch (e) { console.error('[tasks] add assignee failed', e); toast.error(tr.failedSaveTask); }
    setAddingAssignees(false);
  };

  const handleRemoveAssignee = async (epf: string) => {
    if (!assignedDetailTask) return;
    setRemovingAssignee(epf);
    try {
      await removeAssigneeFromTask(assignedDetailTask.id, epf);
      reloadAssignedDetailSource();
    } catch (e) {
      console.error('[tasks] remove assignee failed', e);
      toast.error(e instanceof Error && e.message === 'at-least-one-assignee-required' ? tr.atLeastOneAssigneeRequired : tr.failedSaveTask);
    }
    setRemovingAssignee(null);
  };

  const handlePostComment = async () => {
    if (!assignedDetailTask || !commentText.trim()) return;
    const m = await ensureMeta();
    if (!m) { toast.error(tr.userNotReady); return; }
    setPostingComment(true);
    try {
      const mentioned = parseMentions(commentText, roster);
      await addComment(assignedDetailTask.id, {
        author_epf: m.epf_number, author_name: m.employee_name, text: commentText.trim(),
        mentioned, taskDescription: assignedDetailTask.description,
      });
      setCommentText(''); setMentionQuery(null);
      setComments(await getComments(assignedDetailTask.id));
    } catch (e) { console.error('[tasks] post comment failed', e); toast.error(tr.failedSaveTask); }
    setPostingComment(false);
  };

  // @mention dropdown for the comment box — same "type @ then filter" affordance as
  // AssigneePicker, but inserts plain "@FirstName" text at the cursor instead of a chip.
  const commentMentionMatches = mentionQuery
    ? roster.filter(r => r.employee_name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6)
    : [];
  const handleCommentTextChange = (value: string) => {
    setCommentText(value);
    const at = value.lastIndexOf('@');
    if (at === -1) { setMentionQuery(null); return; }
    const fragment = value.slice(at + 1);
    setMentionQuery(/^[A-Za-z]*$/.test(fragment) ? fragment : null);
  };
  const insertMention = (member: RosterMember) => {
    const at = commentText.lastIndexOf('@');
    const firstName = member.employee_name.split(/\s+/)[0];
    const next = (at === -1 ? commentText : commentText.slice(0, at)) + `@${firstName} `;
    setCommentText(next);
    setMentionQuery(null);
    commentInputRef.current?.focus();
  };

  const handleDeleteAssignedTask = async () => {
    if (!assignedDetailTask) return;
    try {
      await deleteAssignedTask(assignedDetailTask.id);
      toast.success(tr.taskDeleted);
      closeAssignedDetail();
      reloadAssignedDetailSource();
    } catch (e) { console.error('[tasks] delete assigned task failed', e); toast.error(tr.failedDelete); }
  };

  // Optimistically move a task (and its rolled-over chain) to `next` status in
  // whichever loaded array currently holds it — a no-op on arrays that don't contain
  // it, so this is safe to fan out to both `monthTasks` and the team Board's
  // `teamMonthTasks` unconditionally.
  const applyChainUpdate = (
    setter: React.Dispatch<React.SetStateAction<DailyTask[]>>,
    t: DailyTask, next: TaskStatus, completedOn: string | null,
  ) => {
    setter(prev => {
      if (!prev.some(x => x.id === t.id)) return prev;
      const byId = new Map(prev.map(x => [x.id, x]));
      const chain = new Set<string>([t.id]);
      let cur = byId.get(t.id);
      while (cur?.rolled_from && byId.has(cur.rolled_from) && !chain.has(cur.rolled_from)) { chain.add(cur.rolled_from); cur = byId.get(cur.rolled_from); }
      cur = byId.get(t.id);
      while (cur?.rolled_to && byId.has(cur.rolled_to) && !chain.has(cur.rolled_to)) { chain.add(cur.rolled_to); cur = byId.get(cur.rolled_to); }
      return prev.map(x =>
        x.id === t.id      ? { ...x, status: next, completed_on: completedOn }
        : chain.has(x.id)  ? { ...x, completed_on: completedOn }
        : x);
    });
  };

  // Set a task to a specific status (used by the Board's drag-and-drop, which drops
  // directly onto a target column) — persists + propagates the completion date the
  // same way the checkbox cycle (toggleStatus) does.
  const changeTaskStatus = async (t: DailyTask, next: TaskStatus) => {
    // Already finished on another day (carried-over chain) — don't let completing it here
    // hijack the completion date onto the wrong day.
    if (t.completed_on && t.completed_on !== t.date) { toast(tr.alreadyCompletedElsewhere, { icon: 'ℹ️' }); return; }
    if (next === t.status) return;
    // Completing stamps the finish date; re-opening clears it. The date is denormalized
    // onto every day-doc in the rolled chain so each day the task appeared shows it.
    const completedOn = next === 'Completed' ? t.date : null;
    applyChainUpdate(setMonthTasks, t, next, completedOn);
    applyChainUpdate(setTeamMonthTasks, t, next, completedOn);
    try {
      await updateTask(t.id, { status: next, completed_on: completedOn });
      await propagateCompletion(t, completedOn);
    }
    catch { toast.error(tr.failedUpdateStatus); refresh(); }
  };

  const toggleStatus = (t: DailyTask) => changeTaskStatus(t, nextTaskStatus(t.status));

  const handleDelete = async (t: DailyTask) => {
    setMonthTasks(prev => prev.filter(x => x.id !== t.id));
    try { await deleteTask(t.id); toast.success(tr.taskDeleted); }
    catch { toast.error(tr.failedDelete); refresh(); }
  };

  // ── Calendar day cell (number + task dot) ──────────────────────────────────
  const DayCell = (p: DayContentProps) => {
    const info = dayInfo.get(ymd(p.date));
    return (
      <span className="relative inline-flex flex-col items-center justify-center leading-none">
        <span>{p.date.getDate()}</span>
        {info && <span className={`mt-1 w-1.5 h-1.5 rounded-full ${info.attention ? 'bg-destructive' : info.open ? 'bg-warning' : 'bg-success'}`} />}
      </span>
    );
  };

  // Role gate (sidebar hides this too — guards direct URL access).
  if (!canLogOwn && !canViewTeam) {
    return (
      <div className="space-y-6">
        <PageHeader title={tr.dailyTasksTitle} icon={ListTodo} />
        <Card>
          <UiEmptyState
            icon={ListTodo}
            title={tr.dailyTasksNotEnabled}
            description={tr.contactAdminAccess}
          />
        </Card>
      </div>
    );
  }

  const showCalendarLayout = view === 'calendar';
  const showBoardLayout = view === 'board';
  const viewOptions = mode === 'mine'
    ? ([['calendar', tr.calendarView, LayoutGrid], ['list', tr.listView, Rows3], ['board', tr.boardView, Kanban]] as const)
    : ([['calendar', tr.calendarView, LayoutGrid], ['board', tr.boardView, Kanban]] as const);

  return (
    <PageTransition className="space-y-6">
      {/* Header */}
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            {tr.dailyTasksTitle}
            {busy && loadedOnce.current && <Loader2 className="w-4 h-4 text-primary/70 animate-spin" />}
          </span>
        }
        description={tr.dailyTasksDesc}
        icon={ListTodo}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {canAssign && (
              <Button variant="outline" size="sm" onClick={() => openAssign()} className="gap-1.5">
                <UserPlus className="w-3.5 h-3.5" /> {tr.assignTask}
              </Button>
            )}
            {canViewTeam && canLogOwn && (
              <div className="flex items-center gap-1 p-1 rounded-md bg-muted border border-border">
                {(['mine', 'team'] as const).map(m => (
                  <button key={m} onClick={() => setMode(m)}
                    className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                      mode === m ? 'bg-primary/10 text-primary border border-primary/20' : 'text-muted-foreground hover:text-foreground'}`}>
                    {m === 'mine' ? <ListTodo className="w-3.5 h-3.5" /> : <Users className="w-3.5 h-3.5" />}
                    {m === 'mine' ? tr.myTasksTab : tr.teamTab}
                  </button>
                ))}
              </div>
            )}
          </div>
        }
      />

      {/* View switcher */}
      <div className="flex items-center gap-1 p-1 rounded-md bg-muted border border-border w-fit">
        {viewOptions.map(([v, label, Icon]) => (
          <button key={v} onClick={() => setView(v)}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors flex items-center gap-1.5 ${
              view === v ? 'bg-primary/10 text-primary border border-primary/20' : 'text-muted-foreground hover:text-foreground'}`}>
            <Icon className="w-3.5 h-3.5" /> {label}
          </button>
        ))}
      </div>

      {/* Carry-over notice */}
      <AnimatePresence>
        {rolledNote > 0 && mode === 'mine' && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="flex items-center gap-3 p-3 rounded-xl bg-primary/10 border border-primary/20">
            <CornerDownRight className="w-4 h-4 text-primary flex-shrink-0" />
            <span className="text-xs text-muted-foreground">
              {(rolledNote > 1 ? tr.carriedOverPlural : tr.carriedOverSingular).replace('{n}', String(rolledNote))}
            </span>
            <button onClick={() => setRolledNote(0)} className="ml-auto text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {!loadedOnce.current ? (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          <div className="lg:col-span-2">
            <Card className="p-4 space-y-3">
              <Skeleton className="h-7 w-40 mx-auto" />
              <Skeleton className="h-56 w-full rounded-lg" />
            </Card>
          </div>
          <div className="lg:col-span-3 space-y-4">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-12 w-full rounded-xl" />
            {[0, 1, 2].map(i => (
              <Card key={i} className="p-4 space-y-3">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </Card>
            ))}
          </div>
        </div>
      ) : showCalendarLayout ? (
        /* ───────────────────────── Calendar layout ───────────────────────── */
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Calendar */}
          <div className="lg:col-span-2">
            <Reveal>
            <Card className="p-4">
              <DayPicker
                mode="single" weekStartsOn={1} showOutsideDays
                month={calMonth} onMonthChange={goToMonth}
                selected={selectedDate}
                onSelect={d => {
                  if (!d) return;
                  setSelectedDate(d);
                  if (d.getMonth() !== calMonth.getMonth() || d.getFullYear() !== calMonth.getFullYear()) setCalMonth(d);
                }}
                components={{ DayContent: DayCell }}
              />
              <div className="flex items-center gap-4 flex-wrap mt-3 pt-3 border-t border-border text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-warning" /> {tr.hasOpenTasks}</span>
                <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-destructive" /> {tr.needsAttentionLegend}</span>
                <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-success" /> {tr.allCompletedLegend}</span>
              </div>
            </Card>
            </Reveal>
          </div>

          {/* Selected-day detail */}
          <div className="lg:col-span-3 space-y-4">
            <div className="flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-primary" />
              <span className="text-sm font-semibold text-foreground">{fmtLong(selectedDate)}</span>
              {selDateStr === todayStr && <Badge variant="default">{tr.todayBadge}</Badge>}
            </div>

            {mode === 'team' ? (
              <>
              {teamGroups.length === 0 ? (
                teamBusy
                  ? <Card className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 text-primary animate-spin" /></Card>
                  : dayAssigned.length === 0 && <Card><UiEmptyState icon={ListTodo} title={tr.noTeamTasks} /></Card>
              ) : (
                <>
                  {/* Per-user toggle — pick a teammate to see only their tasks */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <button onClick={() => setSelectedEmp(null)}
                      className={`px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors flex items-center gap-1.5 ${
                        activeEmp === null ? 'bg-primary/10 text-primary border-primary/20' : 'bg-muted text-muted-foreground border-border hover:text-foreground'}`}>
                      <Users className="w-3.5 h-3.5" /> {tr.allWord}
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{teamGroups.length}</span>
                    </button>
                    {teamGroups.map(g => (
                      <button key={g.epf} onClick={() => setSelectedEmp(g.epf)}
                        className={`px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors flex items-center gap-1.5 ${
                          activeEmp === g.epf ? 'bg-primary/10 text-primary border-primary/20' : 'bg-muted text-muted-foreground border-border hover:text-foreground'}`}>
                        {g.name}
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                          g.hasOpen ? 'bg-warning/15 text-warning' : 'bg-success/15 text-success'}`}>{g.items.length}</span>
                      </button>
                    ))}
                  </div>

                  {/* Cards — all teammates, or just the selected one */}
                  <Stagger className="space-y-4">
                    {teamGroups.filter(g => !activeEmp || g.epf === activeEmp).map(g => (
                      <StaggerItem key={g.epf}>
                        <Card className="overflow-hidden">
                          <div className="flex items-center justify-between border-b border-border bg-muted/50 px-4 py-2.5">
                            <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                              <Users className="h-3.5 w-3.5 text-brand" />{g.name}
                              {g.hasOpen
                                ? <Badge variant="warning">{g.items.length} {tr.openLower}</Badge>
                                : <Badge variant="success">{tr.allDone}</Badge>}
                            </span>
                            <div className="flex items-center gap-3 flex-shrink-0">
                              <span className="text-xs text-muted-foreground">{g.total.toFixed(2)} hr</span>
                              {canAssign && (
                                <button onClick={() => openAssign(g.epf)}
                                  className="w-7 h-7 rounded-md bg-muted border border-border flex items-center justify-center text-muted-foreground hover:text-primary hover:border-primary/30 transition-colors">
                                  <UserPlus className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="divide-y divide-border">{g.items.map(t => <TaskRow key={t.id} t={t} readOnly />)}</div>
                        </Card>
                      </StaggerItem>
                    ))}
                  </Stagger>
                </>
              )}

              {/* Shared tasks due this day across the team — the assigner and the people on
                  them can act here; everyone else reads. */}
              {dayAssigned.length > 0 && (
                <Reveal>
                  <Card className="overflow-hidden">
                    <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2.5">
                      <Users className="h-3.5 w-3.5 text-brand" />
                      <span className="text-sm font-semibold text-foreground">{tr.assignedTasksTitle}</span>
                      <Badge variant="muted">{dayAssigned.length}</Badge>
                    </div>
                    <div className="divide-y divide-border">
                      {dayAssigned.map(t => (
                        <AssignedTaskRow key={t.id} task={t} actor={actor} canAct={canActOn(t)} statusColumns={statusColumns}
                          showAssignees onOpen={a => setAssignedDetailId(a.id)} onChanged={afterAssignedAction} />
                      ))}
                    </div>
                  </Card>
                </Reveal>
              )}
              </>
            ) : (
              <Stagger className="space-y-4">
                <StaggerItem>
                  <button onClick={() => openAdd()}
                    className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-primary/30 bg-primary/5 py-3 text-sm font-semibold text-primary transition-colors hover:bg-primary/10">
                    <Plus className="h-4 w-4" /> {tr.addTask}
                  </button>
                </StaggerItem>

                {/* What others put on my plate for this day — above my own log, since it is
                    the part someone else is waiting on. A delayed task with a new date shows
                    on that new date (the data already moved). */}
                {dayAssigned.length > 0 && (
                  <StaggerItem>
                    <Card className="overflow-hidden">
                      <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2.5">
                        <Users className="h-3.5 w-3.5 text-brand" />
                        <span className="text-sm font-semibold text-foreground">{tr.assignedToYouTitle}</span>
                        <Badge variant="muted">{dayAssigned.length}</Badge>
                      </div>
                      <div className="divide-y divide-border">
                        {dayAssigned.map(t => (
                          <AssignedTaskRow key={t.id} task={t} actor={actor} canAct={canActOn(t)} statusColumns={statusColumns}
                            onOpen={a => setAssignedDetailId(a.id)} onChanged={afterAssignedAction} />
                        ))}
                      </div>
                    </Card>
                  </StaggerItem>
                )}

                {sessions.map((s, i) => {
                  const sessionItems = tasksForSession(s.id);
                  return (
                    <StaggerItem key={s.id}>
                      <GroupCard
                        title={s.working_place ?? tr.sessionLabel.replace('{n}', String(i + 1))}
                        subtitle={`${fmtTs(s.check_in)} → ${s.check_out ? fmtTs(s.check_out) : tr.openWord}`}
                        icon={<MapPin className="w-3.5 h-3.5 text-primary" />}
                        onAdd={() => openAdd(s.id)}
                        items={sessionItems}
                        onToggle={toggleStatus} onEdit={openEdit} onDelete={(task) => setConfirmDelete({ kind: 'task', task })}
                      />
                    </StaggerItem>
                  );
                })}

                <StaggerItem>
                  <GroupCard
                    title={tr.generalTitle} subtitle={tr.dayLevelTasks}
                    icon={<ListTodo className="w-3.5 h-3.5 text-brand" />}
                    onAdd={() => openAdd(GENERAL)}
                    items={generalTasks}
                    onToggle={toggleStatus} onEdit={openEdit} onDelete={(task) => setConfirmDelete({ kind: 'task', task })}
                  />
                </StaggerItem>

                {dayTasks.length === 0 && (
                  <StaggerItem>
                    <Card><UiEmptyState icon={ListTodo} title={tr.noTasksThisDay} description={dayAssigned.length === 0 ? tr.noAssignedTasksDay : undefined} /></Card>
                  </StaggerItem>
                )}

                {dayTasks.length > 0 && (
                  <StaggerItem>
                  <Card className={`flex items-center justify-between p-4 ${hoursMismatch ? 'border-warning/30 bg-warning/5' : ''}`}>
                    <div className="flex items-center gap-2"><Clock className="w-4 h-4 text-muted-foreground" /><span className="text-sm text-muted-foreground">{tr.totalLogged}</span></div>
                    <div className="flex items-center gap-3">
                      <span className="text-lg font-bold text-foreground font-mono">{loggedHours.toFixed(2)} hr</span>
                      {attendedHours > 0 && (
                        <span className={`text-xs ${hoursMismatch ? 'text-warning' : 'text-muted-foreground'}`}>
                          {hoursMismatch && <AlertTriangle className="w-3 h-3 inline mr-1" />}{tr.attendedHrs.replace('{n}', attendedHours.toFixed(2))}
                        </span>
                      )}
                    </div>
                  </Card>
                  </StaggerItem>
                )}
              </Stagger>
            )}
          </div>
        </div>
      ) : showBoardLayout ? (
        /* ─────────────────────────── Board layout ──────────────────────────── */
        <div className="space-y-4">
          <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" onClick={() => shiftMonth(-1)}><ChevronLeft className="w-4 h-4" /></Button>
              <span className="w-36 text-center text-sm font-semibold text-foreground">{fmtMonth(calMonth)}</span>
              <Button variant="outline" size="icon" onClick={() => shiftMonth(1)}><ChevronRight className="w-4 h-4" /></Button>
            </div>
            {mode === 'mine'
              ? <Button onClick={() => openAdd(GENERAL, todayStr)} className="gap-2"><Plus className="h-4 w-4" /> {tr.addTask}</Button>
              : canAssign && <Button onClick={() => openAssign()} className="gap-2"><UserPlus className="h-4 w-4" /> {tr.assignTask}</Button>}
          </Card>
          {boardBusy && boardItems.length === 0 ? (
            <Card className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 text-primary animate-spin" /></Card>
          ) : (
            <TaskBoard
              items={boardItems}
              statuses={statusColumns}
              showEmployee={mode === 'team'}
              onStatusChange={handleWorkItemStatusChange}
              onCardClick={handleWorkItemClick}
              onAddStatus={handleAddStatus}
              addingStatus={addingStatus}
            />
          )}
        </div>
      ) : (
        /* ─────────────────────────── List layout ──────────────────────────── */
        <div className="space-y-6">
          {/* Month nav toolbar */}
          <Reveal>
            <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon" onClick={() => shiftMonth(-1)}><ChevronLeft className="w-4 h-4" /></Button>
                <span className="w-36 text-center text-sm font-semibold text-foreground">{fmtMonth(calMonth)}</span>
                <Button variant="outline" size="icon" onClick={() => shiftMonth(1)}><ChevronRight className="w-4 h-4" /></Button>
              </div>
              <Button onClick={() => openAdd(GENERAL, selDateStr)} className="gap-2">
                <Plus className="h-4 w-4" /> {tr.addTask}
              </Button>
            </Card>
          </Reveal>

          {/* KPI summary row */}
          <Stagger className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StaggerItem>
              <StatCard label={tr.loggedHoursLabel} value={`${monthSummary.total.toFixed(2)} hr`} icon={Clock} tone="primary" hint={tr.thisMonth} />
            </StaggerItem>
            <StaggerItem>
              <StatCard label={tr.totalTasksLabel} value={monthSummary.count} icon={ListTodo} tone="brand" hint={tr.daysActive.replace('{n}', String(listGroups.length))} />
            </StaggerItem>
            <StaggerItem>
              <StatCard label={tr.completedLabel} value={monthSummary.done} icon={CheckCircle2} tone="success" hint={tr.markedDone} />
            </StaggerItem>
            <StaggerItem>
              <StatCard label={tr.openLabel} value={monthSummary.open} icon={Hourglass} tone="warning" hint={tr.stillInProgress} />
            </StaggerItem>
          </Stagger>

          {/* Per-day task groups */}
          {listGroups.length === 0 ? (
            <Reveal><Card><UiEmptyState icon={ListTodo} title={tr.noTasksThisMonth} /></Card></Reveal>
          ) : (
            <Stagger className="space-y-4">
              {listGroups.map(g => {
                const gd = parseYmd(g.date);
                return (
                  <StaggerItem key={g.date}>
                    <Card className="overflow-hidden">
                      <div className="flex items-center justify-between border-b border-border bg-muted/50 px-4 py-2.5">
                        <button onClick={() => { setSelectedDate(gd); setView('calendar'); }}
                          className="flex items-center gap-2 text-sm font-semibold text-foreground transition-colors hover:text-primary">
                          <CalendarDays className="h-3.5 w-3.5 text-primary" />{fmtRow(gd)}
                          {g.date === todayStr && <Badge variant="default">{tr.todayBadge}</Badge>}
                        </button>
                        <span className="text-xs text-muted-foreground">{g.total.toFixed(2)} hr</span>
                      </div>
                      <div className="divide-y divide-border">
                        {g.items.map(t => <TaskRow key={t.id} t={t} onToggle={toggleStatus} onEdit={openEdit} onDelete={(task) => setConfirmDelete({ kind: 'task', task })} />)}
                      </div>
                      {g.assigned.length > 0 && (
                        <>
                          <div className={`flex items-center gap-2 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground ${g.items.length > 0 ? 'border-t border-border' : ''}`}>
                            <Users className="h-3 w-3 text-brand" />{tr.assignedCountTpl.replace('{n}', String(g.assigned.length))}
                          </div>
                          <div className="divide-y divide-border border-t border-border">
                            {g.assigned.map(t => (
                              <AssignedTaskRow key={t.id} task={t} actor={actor} canAct={canActOn(t)} statusColumns={statusColumns}
                                onOpen={a => setAssignedDetailId(a.id)} onChanged={afterAssignedAction} />
                            ))}
                          </div>
                        </>
                      )}
                    </Card>
                  </StaggerItem>
                );
              })}
            </Stagger>
          )}
        </div>
      )}

      {/* LogPup project tasks — the person's own work from the LogPup sprint boards, read live
          and never stored here. Self-contained: it renders nothing when the tenant flag is off
          or there is nothing to show, so no branch above has to know about it. `mine` only —
          the team roster is EPF-keyed and says nothing about who is on a LogPup board. */}
      {mode === 'mine' && <LogPupTaskList enabled={!!user?.epf_number} />}

      {/* Add / edit modal — Portalled to <body>: a `fixed inset-0` overlay nested inside
          PageTransition (whose enter animation leaves an active transform in place) gets its
          containing block hijacked to PageTransition's own box instead of the viewport. */}
      <Portal>
      <AnimatePresence>
        {showForm && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-background/80 backdrop-blur-sm p-4" onClick={closeForm}>
            <motion.div initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }}
              onClick={e => e.stopPropagation()} className="w-full max-w-lg bg-card text-card-foreground rounded-xl border border-border shadow-card overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
                <span className="text-sm font-semibold text-foreground">{editingId ? tr.editTask : tr.addTask}</span>
                <button onClick={closeForm} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
              </div>
              <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
                <Field label={tr.taskDescription} required>
                  <div className="relative">
                    <input autoFocus value={form.description}
                      onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                      onFocus={() => setDescFocused(true)}
                      onBlur={() => setTimeout(() => setDescFocused(false), 120)}
                      placeholder={tr.egTaskDesc}
                      className="h-9 w-full bg-muted border border-border rounded-md px-3 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring placeholder:text-muted-foreground" />
                    {filteredSuggestions.length > 0 && (
                      <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-popover rounded-md border border-border shadow-card overflow-hidden">
                        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground border-b border-border">
                          {tr.continuePendingTask}
                        </div>
                        {filteredSuggestions.map(s => (
                          <button key={s.description} type="button"
                            onMouseDown={e => { e.preventDefault(); pickSuggestion(s); }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors">
                            <CircleDot className="w-3.5 h-3.5 text-warning flex-shrink-0" />
                            <span className="text-sm text-foreground truncate flex-1">{s.description}</span>
                            <span className="text-[10px] text-muted-foreground flex-shrink-0">{s.date}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label={tr.dateLabel}>
                    <input type="date" value={form.date} max={todayStr}
                      onChange={e => setForm(f => ({ ...f, date: e.target.value, target: e.target.value === selDateStr ? f.target : GENERAL }))}
                      className="h-9 w-full bg-muted border border-border rounded-md px-3 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring" />
                  </Field>
                  <Field label={tr.timingHr}>
                    <input type="number" min="0" step="0.25" value={form.hours}
                      onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} placeholder="0.00"
                      className={`h-9 w-full bg-muted border rounded-md px-3 text-foreground text-sm focus:outline-none focus:ring-1 placeholder:text-muted-foreground ${hoursExceed ? 'border-warning/50 focus:border-warning focus:ring-warning' : 'border-border focus:border-ring focus:ring-ring'}`} />
                    {/* Quick-fill from the worked duration of the selected session / day */}
                    {availableHours > 0 && (
                      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] text-muted-foreground">{tr.autoFillLabel} ({availableHours.toFixed(2)}h)</span>
                        {[0.25, 0.5, 0.75, 1].map(p => (
                          <button key={p} type="button"
                            onClick={() => setForm(f => ({ ...f, hours: (availableHours * p).toFixed(2) }))}
                            className="px-1.5 py-0.5 rounded-md border border-border bg-muted text-[10px] font-bold text-muted-foreground hover:text-primary hover:border-primary/30 transition-colors">
                            {p * 100}%
                          </button>
                        ))}
                      </div>
                    )}
                    {hoursExceed && (
                      <p className="mt-1 flex items-center gap-1 text-[10px] text-warning">
                        <AlertTriangle className="w-3 h-3 flex-shrink-0" /> {tr.exceedsDuration.replace('{h}', availableHours.toFixed(2))}
                      </p>
                    )}
                  </Field>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Field label={tr.taskTypeLabel}>
                    <select value={form.task_type} onChange={e => setForm(f => ({ ...f, task_type: e.target.value as TaskType }))}
                      className="h-9 w-full bg-muted border border-border rounded-md px-3 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring">
                      {TASK_TYPES.map(tt => <option key={tt} value={tt} className="bg-popover text-popover-foreground">{tt}</option>)}
                    </select>
                  </Field>
                  <Field label={tr.assignTo}>
                    <select value={form.target} disabled={!formOnSelectedDay} onChange={e => setForm(f => ({ ...f, target: e.target.value }))}
                      className="h-9 w-full bg-muted border border-border rounded-md px-3 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-60">
                      <option value={GENERAL} className="bg-popover text-popover-foreground">{tr.generalDayLevel}</option>
                      {formSessions.map((s, i) => (
                        <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">{tr.sessionLabel.replace('{n}', String(i + 1))}{s.working_place ? ` · ${s.working_place}` : ''}</option>
                      ))}
                    </select>
                  </Field>
                </div>

                <Field label={tr.statusLabel}>
                  <div className="grid grid-cols-3 gap-2">
                    {TASK_STATUSES.map(st => (
                      <button key={st} disabled={editingCompletedElsewhere}
                        onClick={() => { if (!editingCompletedElsewhere) setForm(f => ({ ...f, status: st })); }}
                        className={`px-3 py-2 rounded-md text-xs font-semibold border transition-colors ${editingCompletedElsewhere ? 'cursor-not-allowed opacity-60' : ''} ${
                          form.status === st
                            ? st === 'Completed' ? 'bg-success/15 border-success/40 text-success'
                            : st === 'On Progress' ? 'bg-warning/15 border-warning/40 text-warning'
                            : 'bg-secondary border-border text-secondary-foreground'
                            : 'bg-muted border-border text-muted-foreground hover:text-foreground'}`}>
                        {st}
                      </button>
                    ))}
                  </div>
                  {editingCompletedElsewhere && (
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                      {tr.completedOnTpl.replace('{date}', fmtShort(parseYmd(editingTask!.completed_on!)))} · {tr.alreadyCompletedElsewhere}
                    </p>
                  )}
                </Field>

                <Field label={tr.remarksLabel}>
                  <textarea value={form.remarks} rows={2} onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))}
                    placeholder={tr.optionalNotes}
                    className="w-full bg-muted border border-border rounded-md px-3 py-2.5 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring placeholder:text-muted-foreground resize-none" />
                </Field>
              </div>
              <div className="px-5 py-3.5 border-t border-border flex gap-3">
                <Button variant="outline" onClick={closeForm} className="flex-1">{tr.cancel}</Button>
                <Button onClick={handleSave} disabled={saving} className="flex-1">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}{editingId ? tr.save : tr.addWord}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </Portal>

      {/* Assign task (supervisor → teammate) modal — see the Portal note above. */}
      <Portal>
      <AnimatePresence>
        {showAssignForm && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-background/80 backdrop-blur-sm p-4" onClick={closeAssign}>
            <motion.div initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }}
              onClick={e => e.stopPropagation()} className="w-full max-w-lg bg-card text-card-foreground rounded-xl border border-border shadow-card overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
                <span className="text-sm font-semibold text-foreground">{tr.assignTask}</span>
                <button onClick={closeAssign} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
              </div>
              <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
                <Field label={tr.quickAddLabel}>
                  <input value={quickAddText}
                    onChange={e => setQuickAddText(e.target.value)}
                    placeholder={tr.quickAddPlaceholder}
                    className="h-9 w-full bg-muted border border-border rounded-md px-3 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring placeholder:text-muted-foreground" />
                  {quickAddPreview && <p className="mt-1.5 text-[11px] text-primary">{quickAddPreview}</p>}
                </Field>

                <Field label={tr.assignTaskFor} required>
                  <AssigneePicker
                    roster={roster} busy={rosterBusy}
                    selected={assignForm.assignees}
                    onChange={next => setAssignForm(f => ({ ...f, assignees: next }))}
                  />
                </Field>

                <Field label={tr.taskDescription} required>
                  <input autoFocus value={assignForm.description}
                    onChange={e => setAssignForm(f => ({ ...f, description: e.target.value }))}
                    placeholder={tr.egTaskDesc}
                    className="h-9 w-full bg-muted border border-border rounded-md px-3 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring placeholder:text-muted-foreground" />
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label={tr.dateLabel} required>
                    <input type="date" value={assignForm.date} min={todayStr}
                      onChange={e => setAssignForm(f => ({ ...f, date: e.target.value }))}
                      className="h-9 w-full bg-muted border border-border rounded-md px-3 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring" />
                  </Field>
                  <Field label={tr.taskTypeLabel}>
                    <select value={assignForm.task_type} onChange={e => setAssignForm(f => ({ ...f, task_type: e.target.value as TaskType }))}
                      className="h-9 w-full bg-muted border border-border rounded-md px-3 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring">
                      {TASK_TYPES.map(tt => <option key={tt} value={tt} className="bg-popover text-popover-foreground">{tt}</option>)}
                    </select>
                  </Field>
                </div>
              </div>
              <div className="px-5 py-3.5 border-t border-border flex gap-3">
                <Button variant="outline" onClick={closeAssign} className="flex-1">{tr.cancel}</Button>
                <Button onClick={handleAssignSave} disabled={assignSaving} className="flex-1">
                  {assignSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}{tr.assignTask}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </Portal>

      {/* Assigned task detail (shared, multi-person task) modal — see the Portal note above. */}
      <Portal>
      <AnimatePresence>
        {assignedDetailTask && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-background/80 backdrop-blur-sm p-4" onClick={closeAssignedDetail}>
            <motion.div initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }}
              onClick={e => e.stopPropagation()} className="w-full max-w-lg bg-card text-card-foreground rounded-xl border border-border shadow-card overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
                <span className="text-sm font-semibold text-foreground truncate">{assignedDetailTask.description}</span>
                <button onClick={closeAssignedDetail} className="text-muted-foreground hover:text-foreground flex-shrink-0"><X className="w-4 h-4" /></button>
              </div>
              <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
                <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                  <span className="flex items-center gap-1"><CalendarDays className="w-3.5 h-3.5" />{fmtLong(parseYmd(assignedDetailTask.date))}</span>
                  <span>{assignedDetailTask.task_type}</span>
                  <span className="text-primary">{tr.assignedByTpl.replace('{name}', assignedDetailTask.assigned_by_name)}</span>
                </div>

                {/* Lifecycle: the clock, any raised hand, and the moves the viewer may make. */}
                <div className="space-y-2">
                  <TaskTimes item={assignedDetailTask} className="text-xs" />
                  <TaskFlagLine flag={assignedDetailTask.flag} originalDate={assignedDetailTask.original_date} date={assignedDetailTask.date} />
                  {assignedDetailTask.status_note && !assignedDetailTask.flag && (
                    <p className="text-[11px] text-muted-foreground">
                      <span className="font-semibold">{tr.lastNoteLabel}:</span> {assignedDetailTask.status_note}
                      {assignedDetailTask.status_changed_by_name && <span className="opacity-70"> · {tr.byTpl.replace('{name}', assignedDetailTask.status_changed_by_name)}</span>}
                    </p>
                  )}
                  {canActOn(assignedDetailTask) && (
                    <AssignedTaskActionCluster task={assignedDetailTask} actions={taskActions} layout="bar" />
                  )}
                </div>

                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide font-semibold mb-2 block">{tr.statusLabel}</span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {statusColumns.map(st => (
                      <button key={st} disabled={statusChanging} onClick={() => handleDetailStatusChange(st)}
                        className={`px-2.5 py-1.5 rounded-md text-xs font-semibold border transition-colors ${statusChanging ? 'opacity-60' : ''} ${
                          assignedDetailTask.status === st
                            ? st === 'Completed' ? 'bg-success/15 border-success/40 text-success'
                            : st === 'On Progress' ? 'bg-warning/15 border-warning/40 text-warning'
                            : 'bg-secondary border-border text-secondary-foreground'
                            : 'bg-muted border-border text-muted-foreground hover:text-foreground'}`}>
                        {st}
                      </button>
                    ))}
                    {addStatusOpen ? (
                      <div className="flex items-center gap-1">
                        <input autoFocus value={newStatusName} onChange={e => setNewStatusName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddStatusInModal(newStatusName); } if (e.key === 'Escape') setAddStatusOpen(false); }}
                          placeholder={tr.newStatusPlaceholder}
                          className="w-28 bg-muted border border-border rounded-md px-2 py-1.5 text-foreground text-xs focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring placeholder:text-muted-foreground" />
                        <button onClick={() => handleAddStatusInModal(newStatusName)} disabled={addingStatus || !newStatusName.trim()}
                          className="w-7 h-7 rounded-md bg-muted border border-border flex items-center justify-center text-muted-foreground hover:text-primary flex-shrink-0">
                          {addingStatus ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    ) : (
                      <button onClick={() => setAddStatusOpen(true)}
                        className="px-2 py-1.5 rounded-md text-xs font-semibold border border-dashed border-border text-muted-foreground hover:text-primary hover:border-primary/30 transition-colors">
                        + {tr.addStatus}
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">{tr.assigneesLabel}</span>
                    {canAssign && (
                      <button onClick={() => setAddAssigneePickerOpen(v => !v)}
                        className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
                        <UserPlus className="w-3.5 h-3.5" /> {tr.addAssignee}
                      </button>
                    )}
                  </div>
                  {addAssigneePickerOpen && (
                    <div className="mb-3 space-y-2">
                      <AssigneePicker
                        roster={roster.filter(r => !assignedDetailTask.assignees.some(a => a.epf_number === r.epf_number))}
                        selected={newAssignees}
                        onChange={setNewAssignees}
                      />
                      <Button size="sm" onClick={handleAddAssigneesToTask} disabled={addingAssignees || newAssignees.length === 0}>
                        {addingAssignees ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} {tr.addWord}
                      </Button>
                    </div>
                  )}
                  <div className="space-y-1.5">
                    {assignedDetailTask.assignees.map(a => (
                      <div key={a.epf_number} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                        <span className="text-sm text-foreground truncate">{a.employee_name}</span>
                        <button onClick={() => handleRemoveAssignee(a.epf_number)}
                          disabled={removingAssignee === a.epf_number || assignedDetailTask.assignees.length <= 1}
                          title={assignedDetailTask.assignees.length <= 1 ? tr.atLeastOneAssigneeRequired : tr.removeAssignee}
                          className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-destructive disabled:opacity-30 disabled:hover:text-muted-foreground transition-colors flex-shrink-0">
                          {removingAssignee === a.epf_number ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide font-semibold mb-2 block">{tr.timelineLabel}</span>
                  <div className="max-h-56 overflow-y-auto pr-1">
                    <AssignedTaskTimeline taskId={assignedDetailTask.id} refreshKey={timelineKey} />
                  </div>
                </div>

                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide font-semibold mb-2 block">{tr.commentsLabel}</span>
                  <div className="space-y-2 max-h-48 overflow-y-auto mb-2">
                    {commentsBusy ? (
                      <Skeleton className="h-10 w-full rounded-md" />
                    ) : comments.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{tr.noCommentsYet}</p>
                    ) : (
                      comments.map(c => {
                        const mentionedPeople = assignedDetailTask.assignees.filter(a => c.mentioned_epfs?.includes(a.epf_number));
                        return (
                          <div key={c.id} className="text-xs">
                            <span className="font-semibold text-foreground">{c.author_name}</span>{' '}
                            <span className="text-muted-foreground">
                              {splitMentionSegments(c.text, mentionedPeople).map((seg, i) => (
                                seg.isMention
                                  ? <span key={i} className="text-primary font-medium">{seg.text}</span>
                                  : <span key={i}>{seg.text}</span>
                              ))}
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>
                  <div className="relative">
                    <div className="flex gap-2">
                      <textarea ref={commentInputRef} value={commentText} rows={2}
                        onChange={e => handleCommentTextChange(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePostComment(); } }}
                        placeholder={tr.writeCommentPlaceholder}
                        className="flex-1 bg-muted border border-border rounded-md px-3 py-2 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring placeholder:text-muted-foreground resize-none" />
                      <Button size="icon" onClick={handlePostComment} disabled={postingComment || !commentText.trim()}>
                        {postingComment ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                      </Button>
                    </div>
                    {commentMentionMatches.length > 0 && (
                      <div className="absolute left-0 right-12 bottom-full mb-1 z-20 bg-popover rounded-md border border-border shadow-card overflow-hidden">
                        {commentMentionMatches.map(m => (
                          <button key={m.epf_number} type="button"
                            onMouseDown={e => { e.preventDefault(); insertMention(m); }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors">
                            <span className="text-sm text-foreground truncate">{m.employee_name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="px-5 py-3.5 border-t border-border flex items-center justify-between">
                <Button variant="outline" size="icon" onClick={() => setConfirmDelete({ kind: 'assigned' })} className="text-destructive hover:text-destructive">
                  <Trash2 className="w-4 h-4" />
                </Button>
                <Button variant="outline" onClick={closeAssignedDetail}>{tr.cancel}</Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </Portal>

      {/* Note / flag prompts for the detail modal and the Board — rendered here, outside the
          modal backdrop, so a click inside them cannot bubble up to its close handler. */}
      {taskActions.dialogs}

      <ConfirmModal
        open={confirmDelete !== null}
        onOpenChange={() => setConfirmDelete(null)}
        variant="danger"
        title="Delete task?"
        description={
          confirmDelete?.kind === 'task'
            ? `“${confirmDelete.task.description}” will be permanently deleted.`
            : assignedDetailTask
              ? `“${assignedDetailTask.description}” will be permanently deleted for everyone it's assigned to.`
              : undefined
        }
        confirmText={tr.deleteWord}
        onConfirm={async () => {
          if (confirmDelete?.kind === 'task') await handleDelete(confirmDelete.task);
          else if (confirmDelete?.kind === 'assigned') await handleDeleteAssignedTask();
          setConfirmDelete(null);
        }}
      />
    </PageTransition>
  );
}

// ─── Helpers / reusable components ──────────────────────────────────────────────
function fmtTs(ts: AttendanceSession['check_in']): string {
  const d = ts?.toDate?.();
  return d ? formatTime(d.toISOString()) : '--:--';
}

function StatusPill({ status }: { status: TaskStatus }) {
  if (status === 'Completed') return <Badge variant="success"><Check className="w-3 h-3" />{status}</Badge>;
  if (status === 'On Progress') return <Badge variant="warning"><CircleDot className="w-3 h-3" />{status}</Badge>;
  return <Badge variant="secondary"><Clock className="w-3 h-3" />{status}</Badge>;
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold mb-1.5 block">
        {label}{required && <span className="text-destructive"> *</span>}
      </label>
      {children}
    </div>
  );
}

// Multi-select "@mention" people picker — chips for selected roster members + a text
// input. Typing filters by name; if the typed text contains "@", only the substring
// after the last "@" is used as the filter (the literal mention trigger), but plain
// typing (no "@") filters too, which is more forgiving. Reuses the same
// onMouseDown+preventDefault dropdown pattern as the description autocomplete above,
// so a click registers before the input's blur can close the dropdown first.
function AssigneePicker({
  roster, busy, selected, onChange,
}: {
  roster: RosterMember[]; busy?: boolean;
  selected: RosterMember[]; onChange: (next: RosterMember[]) => void;
}) {
  const tr = useT();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const filterText = query.includes('@') ? query.slice(query.lastIndexOf('@') + 1) : query;
  const selectedEpfs = new Set(selected.map(s => s.epf_number));
  const matches = filterText.trim()
    ? roster
        .filter(r => !selectedEpfs.has(r.epf_number) && r.employee_name.toLowerCase().includes(filterText.trim().toLowerCase()))
        .slice(0, 8)
    : [];

  const addMember = (m: RosterMember) => {
    onChange([...selected, m]);
    setQuery('');
    inputRef.current?.focus();
  };
  const removeMember = (epf: string) => onChange(selected.filter(s => s.epf_number !== epf));

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1.5 w-full bg-muted border border-border rounded-md px-2 py-1.5 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
        {selected.map(m => (
          <span key={m.epf_number} className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-xs font-medium">
            {m.employee_name}
            <button type="button" onClick={() => removeMember(m.epf_number)} className="hover:text-destructive"><X className="w-3 h-3" /></button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Backspace' && !query && selected.length > 0) {
              removeMember(selected[selected.length - 1].epf_number);
            } else if (e.key === 'Enter' && matches.length > 0) {
              e.preventDefault();
              addMember(matches[0]);
            }
          }}
          placeholder={selected.length === 0 ? (busy ? tr.loading : tr.assignTaskFor) : ''}
          className="flex-1 min-w-[100px] bg-transparent text-sm text-foreground focus:outline-none placeholder:text-muted-foreground py-1"
        />
      </div>
      {matches.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-popover rounded-md border border-border shadow-card overflow-hidden max-h-56 overflow-y-auto">
          {matches.map(m => (
            <button key={m.epf_number} type="button"
              onMouseDown={e => { e.preventDefault(); addMember(m); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors">
              <span className="text-sm text-foreground truncate flex-1">{m.employee_name}</span>
            </button>
          ))}
        </div>
      )}
      {filterText.trim() && matches.length === 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-popover rounded-md border border-border shadow-card px-3 py-2 text-xs text-muted-foreground">
          {tr.noMatchesFound}
        </div>
      )}
    </div>
  );
}

function GroupCard({
  title, subtitle, icon, onAdd, items, onToggle, onEdit, onDelete,
}: {
  title: string; subtitle: string; icon: React.ReactNode; onAdd?: () => void;
  items: DailyTask[];
  onToggle: (t: DailyTask) => void; onEdit: (t: DailyTask) => void; onDelete: (t: DailyTask) => void;
}) {
  if (items.length === 0 && !onAdd) return null;
  const total = items.reduce((s, x) => s + (Number(x.hours) || 0), 0);
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/50">
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <span className="text-sm font-semibold text-foreground truncate">{title}</span>
          <span className="text-[11px] text-muted-foreground truncate hidden sm:inline">· {subtitle}</span>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {items.length > 0 && <span className="text-xs text-muted-foreground">{total.toFixed(2)} hr</span>}
          {onAdd && (
            <button onClick={onAdd} className="w-7 h-7 rounded-md bg-muted border border-border flex items-center justify-center text-muted-foreground hover:text-primary hover:border-primary/30 transition-colors">
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      {items.length > 0 && (
        <div className="divide-y divide-border">
          {items.map(t => <TaskRow key={t.id} t={t} onToggle={onToggle} onEdit={onEdit} onDelete={onDelete} />)}
        </div>
      )}
    </Card>
  );
}

function TaskRow({
  t, readOnly, onToggle, onEdit, onDelete,
}: {
  t: DailyTask; readOnly?: boolean;
  onToggle?: (t: DailyTask) => void; onEdit?: (t: DailyTask) => void; onDelete?: (t: DailyTask) => void;
}) {
  const tr = useT();
  // This day-doc is really the same task carried over and finished on a LATER day.
  // It's already done, so completing it here is disallowed (it would hijack the
  // completion onto the wrong day) — the checkbox is shown done-but-locked instead.
  const completedElsewhere = !!t.completed_on && t.completed_on !== t.date;
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent transition-colors group">
      {!readOnly && onToggle && (
        <button
          onClick={() => { if (!completedElsewhere) onToggle(t); }}
          disabled={completedElsewhere}
          aria-pressed={t.status === 'Completed' || completedElsewhere}
          title={completedElsewhere ? tr.completedOnTpl.replace('{date}', fmtShort(parseYmd(t.completed_on!))) : undefined}
          className={`w-5 h-5 rounded-md border flex-shrink-0 flex items-center justify-center transition-colors ${
            completedElsewhere ? 'border-success/40 bg-success/20 cursor-not-allowed'
            : t.status === 'Completed' ? 'bg-success border-success'
            : t.status === 'On Progress' ? 'border-warning/50 bg-warning/10 hover:border-success/50'
            : 'border-border bg-muted hover:border-warning/50'}`}>
          {t.status === 'Completed'
            ? <Check className="w-3 h-3 text-success-foreground" />
            : t.status === 'On Progress' ? <CircleDot className="w-3 h-3 text-warning" />
            : completedElsewhere && <Check className="w-3 h-3 text-success" />}
        </button>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-sm truncate ${t.status === 'Completed' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{t.description}</span>
          {t.rolled_from && (
            <span title={tr.carriedOverTitle} className="flex items-center gap-0.5 text-[10px] text-primary flex-shrink-0"><CornerDownRight className="w-3 h-3" /></span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className="text-[10px] text-muted-foreground">{t.task_type}</span>
          {t.working_place && <span className="text-[10px] text-muted-foreground">· {t.working_place}</span>}
          {t.remarks && <span className="text-[10px] text-muted-foreground truncate">· {t.remarks}</span>}
          {t.assigned_by_name && (
            <span className="text-[10px] text-primary truncate flex items-center gap-0.5">
              · {tr.assignedByTpl.replace('{name}', t.assigned_by_name)}
              {t.assignment_group_id && (
                <span title={tr.groupAssignmentTitle}><Users className="w-2.5 h-2.5 flex-shrink-0" /></span>
              )}
            </span>
          )}
          {/* Task carried over across days and finished later — show when it was completed
              on each earlier day it appeared (the day it was actually done needs no badge). */}
          {completedElsewhere && (
            <span title={tr.completedOnTpl.replace('{date}', t.completed_on!)}
              className="inline-flex items-center gap-0.5 rounded-full bg-success/15 px-1.5 py-0.5 text-[9px] font-semibold text-success flex-shrink-0">
              <CheckCircle2 className="w-2.5 h-2.5" />{tr.completedOnTpl.replace('{date}', fmtShort(parseYmd(t.completed_on!)))}
            </span>
          )}
        </div>
      </div>
      <span className="text-xs font-mono text-muted-foreground flex-shrink-0">{(Number(t.hours) || 0).toFixed(2)}h</span>
      {readOnly ? (
        <StatusPill status={t.status} />
      ) : (
        <div className="flex items-center gap-1 flex-shrink-0">
          <StatusPill status={t.status} />
          {onEdit && <button onClick={() => onEdit(t)} className="w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition-all"><Pencil className="w-3.5 h-3.5" /></button>}
          {onDelete && <button onClick={() => onDelete(t)} className="w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-all"><Trash2 className="w-3.5 h-3.5" /></button>}
        </div>
      )}
    </div>
  );
}

// ─── Board (Jira-style Kanban) ──────────────────────────────────────────────────
function TaskBoard({
  items, statuses, showEmployee, onStatusChange, onCardClick, onAddStatus, addingStatus,
}: {
  items: WorkItem[]; statuses: string[]; showEmployee: boolean;
  onStatusChange: (item: WorkItem, next: string) => void;
  onCardClick: (item: WorkItem) => void;
  onAddStatus: (name: string) => void; addingStatus: boolean;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const byKey = useMemo(() => new Map(items.map(item => [item.key, item])), [items]);

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over) return;
    const item = byKey.get(String(active.id));
    const targetStatus = String(over.id);
    if (!item || !statuses.includes(targetStatus)) return;
    if (item.status === targetStatus) return;
    onStatusChange(item, targetStatus);
  };

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="flex gap-4 overflow-x-auto pb-2">
        {statuses.map(status => (
          <BoardColumn
            key={status} status={status}
            items={items.filter(item => item.status === status).sort((a, b) => a.date.localeCompare(b.date))}
            showEmployee={showEmployee} onCardClick={onCardClick}
          />
        ))}
        <AddStatusColumn onAdd={onAddStatus} busy={addingStatus} />
      </div>
    </DndContext>
  );
}

const BOARD_COLUMN_DOT: Record<string, string> = {
  Pending: 'bg-muted-foreground', 'On Progress': 'bg-warning', Completed: 'bg-success',
};

function BoardColumn({
  status, items, showEmployee, onCardClick,
}: {
  status: string; items: WorkItem[]; showEmployee: boolean; onCardClick: (item: WorkItem) => void;
}) {
  const tr = useT();
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div ref={setNodeRef}
      className={`flex flex-col rounded-xl border p-3 min-h-[200px] w-64 flex-shrink-0 transition-colors ${
        isOver ? 'border-primary/40 bg-primary/5' : 'border-border bg-muted/30'}`}>
      <div className="flex items-center gap-2 mb-3 px-1">
        <span className={`w-2 h-2 rounded-full ${BOARD_COLUMN_DOT[status] ?? 'bg-brand'}`} />
        <span className="text-xs font-semibold text-foreground truncate">{status}</span>
        <span className="text-[10px] font-bold text-muted-foreground ml-auto flex-shrink-0">{items.length}</span>
      </div>
      <div className="space-y-2">
        {items.map(item => <BoardCard key={item.key} item={item} showEmployee={showEmployee} onCardClick={onCardClick} />)}
        {items.length === 0 && (
          <p className="text-[11px] text-muted-foreground text-center py-6">{tr.noTasksThisDay}</p>
        )}
      </div>
    </div>
  );
}

// Trailing "+ Add status" tile — click reveals an inline text input; Enter/confirm
// creates a new shared Board column for the whole company (see addCustomStatus).
function AddStatusColumn({ onAdd, busy }: { onAdd: (name: string) => void; busy: boolean }) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const submit = () => { if (name.trim()) { onAdd(name.trim()); setName(''); setOpen(false); } };
  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border w-64 flex-shrink-0 min-h-[200px] text-muted-foreground hover:text-primary hover:border-primary/30 transition-colors">
        <Plus className="w-4 h-4" /> <span className="text-xs font-semibold">{tr.addStatus}</span>
      </button>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3 w-64 flex-shrink-0 min-h-[200px] space-y-2">
      <input autoFocus value={name} onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } if (e.key === 'Escape') setOpen(false); }}
        placeholder={tr.newStatusPlaceholder}
        className="w-full bg-muted border border-border rounded-md px-2.5 py-1.5 text-foreground text-xs focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring placeholder:text-muted-foreground" />
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={busy || !name.trim()} className="flex-1">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)} className="flex-1"><X className="w-3.5 h-3.5" /></Button>
      </div>
    </div>
  );
}

function BoardCard({
  item, showEmployee, onCardClick,
}: {
  item: WorkItem; showEmployee: boolean; onCardClick: (item: WorkItem) => void;
}) {
  const tr = useT();
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: item.key });
  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;
  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}
      onClick={() => { if (!isDragging) onCardClick(item); }}
      className={`rounded-lg border border-border bg-card p-2.5 cursor-grab active:cursor-grabbing shadow-sm hover:border-primary/30 transition-colors touch-none ${
        isDragging ? 'opacity-50 z-10' : ''}`}>
      <div className="flex items-start gap-1.5">
        <GripVertical className="w-3.5 h-3.5 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground line-clamp-2">{item.description}</p>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <span className="text-[10px] text-muted-foreground">{fmtShort(parseYmd(item.date))}</span>
            {!!item.hours && item.hours > 0 && <span className="text-[10px] text-muted-foreground">· {item.hours.toFixed(2)}h</span>}
            {showEmployee && <span className="text-[10px] font-semibold text-primary truncate">{item.employee_name}</span>}
            {item.kind === 'assigned' && (
              <span title={tr.groupAssignmentTitle}><Users className="w-2.5 h-2.5 text-muted-foreground flex-shrink-0" /></span>
            )}
            {!!item.commentCount && item.commentCount > 0 && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                <MessageSquare className="w-2.5 h-2.5" />{item.commentCount}
              </span>
            )}
          </div>
          {item.assigned_by_name && (
            <p className="text-[10px] text-muted-foreground mt-1 truncate">
              {tr.assignedByTpl.replace('{name}', item.assigned_by_name)}
            </p>
          )}
          {/* Assigned cards carry the clock and any raised hand — kept to one line each. */}
          {item.kind === 'assigned' && (
            <div className="mt-1 flex items-center gap-1.5 flex-wrap">
              <TaskTimes item={item} className="text-[10px]" />
              <TaskFlagPill flag={item.flag} date={item.date} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
