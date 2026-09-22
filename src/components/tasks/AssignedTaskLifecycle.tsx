'use client';
// The assigned-task lifecycle, as UI: when it started and ended, the raised-hand flags, the
// note prompt every status change goes through, and the trail. Shared by the Tasks page
// (calendar day panel, list, board, detail modal) and the dashboard widget so a task reads
// and acts the same wherever it shows up. Everything writes through assignedTaskService with
// the signed-in person as the actor — that is what stamps the clock and the trail.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, Clock, Ellipsis, Flag, Loader2,
  MessageSquare, Play, RotateCcw, UserPlus, Users,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useT } from '@/store/appStore';
import { localDateString } from '@/lib/utils';
import type { AssignedTask, AssignedTaskEvent, AssignedTaskFlagKind } from '@/lib/types';
import {
  addAssignedTaskNote, clearAssignedTaskFlag, completeAssignedTask, flagAssignedTask,
  getAssignedTaskEvents, startAssignedTask, updateAssignedTaskStatus, type TaskActor,
} from '@/services/assignedTaskService';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { elapsedSince, fmtClock, fmtDay, fmtDuration, fmtStamp, statusTone } from './assignedTaskFormat';

const ms = (t: { toMillis?: () => number } | null | undefined): number | null => t?.toMillis?.() ?? null;

// A dialog opened from a dropdown item on the same tick the menu closes can leave the page
// with the menu's pointer-events lock still on. Let the menu finish closing first.
const afterMenuCloses = (fn: () => void) => { setTimeout(fn, 0); };

// ─── Status badge ───────────────────────────────────────────────────────────────
export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={statusTone(status)}>{status}</Badge>;
}

// ─── Times: "Started 09:12 · Finished 11:40 · Took 2h 28m" ───────────────────────
// Accepts either shape so the board (WorkItem, ms) and the rows (AssignedTask, Timestamp)
// can pass what they already hold.
type TimesSource =
  | { startedAt?: number | null; endedAt?: number | null }
  | Pick<AssignedTask, 'started_at' | 'ended_at'>;

function timesOf(item: TimesSource): { start: number | null; end: number | null } {
  if ('started_at' in item || 'ended_at' in item) {
    const a = item as Pick<AssignedTask, 'started_at' | 'ended_at'>;
    return { start: ms(a.started_at), end: ms(a.ended_at) };
  }
  const w = item as { startedAt?: number | null; endedAt?: number | null };
  return { start: w.startedAt ?? null, end: w.endedAt ?? null };
}

export function TaskTimes({ item, className = '' }: { item: TimesSource; className?: string }) {
  const tr = useT();
  const { start, end } = timesOf(item);
  const running = !!start && !end;
  // A running task re-renders once a minute so "Running 2h 10m" stays honest without a
  // per-second timer on every row.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [running]);

  if (!start) {
    return <span className={`text-[11px] text-muted-foreground ${className}`}>{tr.notStartedWord}</span>;
  }
  const parts = [tr.startedAtTpl.replace('{time}', fmtClock(start))];
  if (end) {
    parts.push(tr.endedAtTpl.replace('{time}', fmtClock(end)));
    parts.push(tr.tookTpl.replace('{duration}', fmtDuration(elapsedSince(start, end))));
  } else {
    parts.push(tr.runningForTpl.replace('{duration}', fmtDuration(elapsedSince(start, null, now))));
  }
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] tabular-nums ${end ? 'text-muted-foreground' : 'text-warning'} ${className}`}>
      {end ? <CheckCircle2 className="w-3 h-3 flex-shrink-0" /> : <Play className="w-3 h-3 flex-shrink-0" />}
      <span className="truncate">{parts.join(' · ')}</span>
    </span>
  );
}

// ─── Flag: a raised hand ─────────────────────────────────────────────────────────
type FlagShape = { kind: AssignedTaskFlagKind; reason: string; until?: string | null } | null | undefined;

/** Just the pill — for board cards where there is no room for the reason. */
export function TaskFlagPill({ flag, date }: { flag: FlagShape; date?: string }) {
  const tr = useT();
  if (!flag) return null;
  if (flag.kind === 'cannot_start') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold text-destructive">
        <AlertTriangle className="w-3 h-3" />{tr.cannotStartWord}
      </span>
    );
  }
  const movedTo = flag.until && date && flag.until === date ? date : flag.until ?? null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">
      <Clock className="w-3 h-3" />{movedTo ? tr.delayedToTpl.replace('{date}', fmtDay(movedTo)) : tr.delayedWord}
    </span>
  );
}

export function TaskFlagLine({ flag, originalDate, date }: { flag: FlagShape; originalDate?: string | null; date: string }) {
  const tr = useT();
  if (!flag) return null;
  const showOriginal = !!originalDate && originalDate !== date;
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <TaskFlagPill flag={flag} date={date} />
        {showOriginal && (
          <span className="text-[10px] text-muted-foreground">{tr.originallyDueTpl.replace('{date}', fmtDay(originalDate!))}</span>
        )}
      </div>
      {flag.reason && (
        <p className="rounded-md bg-muted px-2.5 py-1.5 text-[11px] text-muted-foreground whitespace-pre-wrap break-words">{flag.reason}</p>
      )}
    </div>
  );
}

// ─── Status-note prompt ──────────────────────────────────────────────────────────
// Shown on every status change, from every surface. `mode: 'note'` is the standalone
// "Add note" variant: no target status, no Skip, and Save needs text.
export function StatusNoteDialog({
  open, status, mode = 'status', onConfirm, onSkip, onCancel, busy,
}: {
  open: boolean; status?: string | null; mode?: 'status' | 'note';
  onConfirm: (note: string) => void; onSkip?: () => void; onCancel: () => void; busy?: boolean;
}) {
  const tr = useT();
  const [note, setNote] = useState('');
  useEffect(() => { if (open) setNote(''); }, [open]);
  const canSave = mode === 'status' || note.trim().length > 0;
  const save = () => { if (canSave && !busy) onConfirm(note.trim()); };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{mode === 'note' ? tr.addNoteWord : tr.statusChangeTitle}</DialogTitle>
          {mode === 'status' && status && (
            <DialogDescription asChild>
              <div className="flex items-center gap-2 pt-1">
                <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
                <StatusBadge status={status} />
              </div>
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="assigned-task-note">{tr.statusNoteLabel}</Label>
          <Textarea
            id="assigned-task-note" autoFocus rows={3} value={note}
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } }}
            placeholder={tr.statusNotePlaceholder}
            className="min-h-[72px] resize-none"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>{tr.cancel}</Button>
          {mode === 'status' && onSkip && (
            <Button type="button" variant="ghost" onClick={onSkip} disabled={busy}>{tr.skipNoteWord}</Button>
          )}
          <Button type="button" onClick={save} disabled={!canSave || busy}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}{tr.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Flag prompt: why, and (for a delay) until when ──────────────────────────────
export function FlagDialog({
  open, kind, date, onConfirm, onCancel, busy,
}: {
  open: boolean; kind: AssignedTaskFlagKind; date: string;
  onConfirm: (input: { reason: string; until: string | null }) => void; onCancel: () => void; busy?: boolean;
}) {
  const tr = useT();
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [showError, setShowError] = useState(false);
  useEffect(() => { if (open) { setReason(''); setUntil(''); setShowError(false); } }, [open]);
  const today = localDateString();
  const valid = reason.trim().length > 0;
  const submit = () => {
    if (!valid) { setShowError(true); return; }
    if (busy) return;
    onConfirm({ reason: reason.trim(), until: kind === 'delayed' && until ? until : null });
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            {kind === 'cannot_start'
              ? <><AlertTriangle className="w-4 h-4 text-destructive" />{tr.cannotStartWord}</>
              : <><Clock className="w-4 h-4 text-warning" />{tr.delayWord}</>}
          </DialogTitle>
          <DialogDescription className="text-xs">{tr.dueWord} {fmtDay(date)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="assigned-task-flag-reason">{tr.flagReasonLabel} <span className="text-destructive">*</span></Label>
            <Textarea
              id="assigned-task-flag-reason" autoFocus rows={3} value={reason}
              onChange={e => { setReason(e.target.value); if (e.target.value.trim()) setShowError(false); }}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
              aria-invalid={showError && !valid}
              className={`min-h-[72px] resize-none ${showError && !valid ? 'border-destructive focus-visible:ring-destructive' : ''}`}
            />
            {showError && !valid && <p className="text-[11px] text-destructive">{tr.flagReasonRequired}</p>}
          </div>
          {kind === 'delayed' && (
            <div className="space-y-1.5">
              <Label htmlFor="assigned-task-flag-until">{tr.newDueDateLabel}</Label>
              <input
                id="assigned-task-flag-until" type="date" min={today} value={until}
                onChange={e => setUntil(e.target.value)}
                className="h-9 w-full bg-muted border border-border rounded-md px-3 text-foreground text-sm focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring"
              />
              <p className="text-[11px] text-muted-foreground">{tr.keepDateHint}</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>{tr.cancel}</Button>
          <Button type="button" variant={kind === 'cannot_start' ? 'destructive' : 'default'} onClick={submit} disabled={!valid || busy}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}{tr.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── The actions, shared by every surface ────────────────────────────────────────
// One hook owns the prompts and the writes; the row, the detail modal and the board drop
// all call into it so the rules (Start and Complete act at once, everything else asks for
// a note or a reason first) live in exactly one place. `dialogs` must be rendered by the
// caller — outside any element whose click handler would react to a click inside them.
export interface AssignedTaskActions {
  busy: boolean;
  start: (task: AssignedTask) => void;
  complete: (task: AssignedTask) => void;
  reopen: (task: AssignedTask) => void;
  changeStatus: (task: AssignedTask, next: string) => void;
  addNote: (task: AssignedTask) => void;
  flag: (task: AssignedTask, kind: AssignedTaskFlagKind) => void;
  clearFlag: (task: AssignedTask) => void;
  dialogs: ReactNode;
}

type NotePrompt =
  | { mode: 'status'; task: AssignedTask; next: string }
  | { mode: 'note'; task: AssignedTask };
type FlagPrompt = { task: AssignedTask; kind: AssignedTaskFlagKind };

export function useAssignedTaskActions({ actor, onChanged }: {
  actor: TaskActor | null; onChanged?: (task: AssignedTask) => void;
}): AssignedTaskActions {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const [notePrompt, setNotePrompt] = useState<NotePrompt | null>(null);
  const [flagPrompt, setFlagPrompt] = useState<FlagPrompt | null>(null);

  // Resolves true when the write landed — prompts stay open on failure so nothing typed
  // is lost.
  const run = useCallback(async (task: AssignedTask, work: (a: TaskActor) => Promise<void>, done: string): Promise<boolean> => {
    if (!actor) { toast.error(tr.userNotReady); return false; }
    setBusy(true);
    try {
      await work(actor);
      toast.success(done);
      onChanged?.(task);
      return true;
    } catch (e) {
      console.error('[assignedTask] action failed', e);
      toast.error(tr.failedUpdateStatus);
      return false;
    } finally { setBusy(false); }
  }, [actor, onChanged, tr]);

  const start = useCallback((task: AssignedTask) =>
    run(task, a => startAssignedTask(task.id, task.date, a), tr.taskStartedToast), [run, tr]);
  const complete = useCallback((task: AssignedTask) =>
    run(task, a => completeAssignedTask(task.id, task.date, a), tr.taskCompletedToast), [run, tr]);
  const reopen = useCallback((task: AssignedTask) => setNotePrompt({ mode: 'status', task, next: 'On Progress' }), []);
  const changeStatus = useCallback((task: AssignedTask, next: string) => {
    if (next === task.status) return;
    setNotePrompt({ mode: 'status', task, next });
  }, []);
  const addNote = useCallback((task: AssignedTask) => setNotePrompt({ mode: 'note', task }), []);
  const flag = useCallback((task: AssignedTask, kind: AssignedTaskFlagKind) => setFlagPrompt({ task, kind }), []);
  const clearFlag = useCallback((task: AssignedTask) =>
    run(task, a => clearAssignedTaskFlag(task.id, a), tr.flagClearedToast), [run, tr]);

  const submitNote = async (note: string) => {
    const p = notePrompt;
    if (!p) return;
    let ok: boolean;
    if (p.mode === 'note') {
      ok = await run(p.task, a => addAssignedTaskNote(p.task.id, a, note), tr.noteSavedToast);
    } else {
      const done = p.next === 'Completed' ? tr.taskCompletedToast
        : (p.task.status === 'Pending' && p.next !== 'Pending') ? tr.taskStartedToast
        : tr.statusSavedToast;
      ok = await run(p.task, a => updateAssignedTaskStatus(p.task.id, p.next, p.task.date, { actor: a, note }), done);
    }
    if (ok) setNotePrompt(null);
  };
  const submitFlag = async (input: { reason: string; until: string | null }) => {
    const p = flagPrompt;
    if (!p) return;
    const ok = await run(p.task, a => flagAssignedTask(p.task.id, { kind: p.kind, reason: input.reason, until: input.until }, a), tr.flaggedToast);
    if (ok) setFlagPrompt(null);
  };

  const dialogs = (
    <>
      <StatusNoteDialog
        open={notePrompt !== null}
        mode={notePrompt?.mode ?? 'status'}
        status={notePrompt?.mode === 'status' ? notePrompt.next : null}
        busy={busy}
        onConfirm={submitNote}
        onSkip={() => submitNote('')}
        onCancel={() => { if (!busy) setNotePrompt(null); }}
      />
      <FlagDialog
        open={flagPrompt !== null}
        kind={flagPrompt?.kind ?? 'delayed'}
        date={flagPrompt?.task.date ?? localDateString()}
        busy={busy}
        onConfirm={submitFlag}
        onCancel={() => { if (!busy) setFlagPrompt(null); }}
      />
    </>
  );

  return useMemo(() => ({ busy, start, complete, reopen, changeStatus, addNote, flag, clearFlag, dialogs }),
    // dialogs is rebuilt every render on purpose — it carries the prompt state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, start, complete, reopen, changeStatus, addNote, flag, clearFlag, notePrompt, flagPrompt]);
}

// ─── Action cluster ──────────────────────────────────────────────────────────────
// `row`: the primary move (Start / Complete / Reopen) plus an overflow menu — for lists.
// `bar`: every action laid out flat — for the detail modal, where there is room.
export function AssignedTaskActionCluster({
  task, actions, statusColumns, layout = 'row',
}: {
  task: AssignedTask; actions: AssignedTaskActions; statusColumns?: string[]; layout?: 'row' | 'bar';
}) {
  const tr = useT();
  const { busy } = actions;
  const pending = task.status === 'Pending';
  const done = task.status === 'Completed';
  const flagged = !!task.flag;
  const spinner = busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null;

  const primary = pending ? (
    <Button type="button" size="sm" onClick={() => actions.start(task)} disabled={busy} className="gap-1.5">
      {spinner ?? <Play className="w-3.5 h-3.5" />}{tr.taskStartWord}
    </Button>
  ) : done ? (
    <Button type="button" size="sm" variant="outline" onClick={() => actions.reopen(task)} disabled={busy} className="gap-1.5">
      {spinner ?? <RotateCcw className="w-3.5 h-3.5" />}{tr.taskReopenWord}
    </Button>
  ) : (
    <Button type="button" size="sm" variant="success" onClick={() => actions.complete(task)} disabled={busy} className="gap-1.5">
      {spinner ?? <CheckCircle2 className="w-3.5 h-3.5" />}{tr.taskCompleteWord}
    </Button>
  );

  if (layout === 'bar') {
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        {primary}
        {pending && (
          <Button type="button" size="sm" variant="outline" onClick={() => actions.flag(task, 'cannot_start')} disabled={busy} className="gap-1.5 text-destructive hover:text-destructive">
            <AlertTriangle className="w-3.5 h-3.5" />{tr.cannotStartWord}
          </Button>
        )}
        {!done && (
          <Button type="button" size="sm" variant="outline" onClick={() => actions.flag(task, 'delayed')} disabled={busy} className="gap-1.5 text-warning hover:text-warning">
            <Clock className="w-3.5 h-3.5" />{tr.delayWord}
          </Button>
        )}
        {flagged && (
          <Button type="button" size="sm" variant="outline" onClick={() => actions.clearFlag(task)} disabled={busy} className="gap-1.5">
            <Flag className="w-3.5 h-3.5" />{tr.clearFlagWord}
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={() => actions.addNote(task)} disabled={busy} className="gap-1.5">
          <MessageSquare className="w-3.5 h-3.5" />{tr.addNoteWord}
        </Button>
      </div>
    );
  }

  const otherStatuses = (statusColumns ?? []).filter(s => s !== task.status);
  return (
    <div className="flex items-center gap-1 flex-shrink-0">
      {primary}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* No key for "more actions" — English fallback for the screen-reader label only. */}
          <Button type="button" size="icon-sm" variant="ghost" disabled={busy} aria-label="More actions">
            <Ellipsis className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {pending && (
            <DropdownMenuItem onSelect={() => afterMenuCloses(() => actions.flag(task, 'cannot_start'))} className="text-destructive focus:text-destructive">
              <AlertTriangle className="w-3.5 h-3.5 mr-2" />{tr.cannotStartWord}
            </DropdownMenuItem>
          )}
          {!done && (
            <DropdownMenuItem onSelect={() => afterMenuCloses(() => actions.flag(task, 'delayed'))}>
              <Clock className="w-3.5 h-3.5 mr-2" />{tr.delayWord}
            </DropdownMenuItem>
          )}
          {flagged && (
            <DropdownMenuItem onSelect={() => actions.clearFlag(task)}>
              <Flag className="w-3.5 h-3.5 mr-2" />{tr.clearFlagWord}
            </DropdownMenuItem>
          )}
          {otherStatuses.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <ArrowRight className="w-3.5 h-3.5 mr-2" />{tr.statusChangeTitle}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {otherStatuses.map(s => (
                  <DropdownMenuItem key={s} onSelect={() => afterMenuCloses(() => actions.changeStatus(task, s))}>
                    <span className={`w-2 h-2 rounded-full mr-2 ${
                      s === 'Completed' ? 'bg-success' : s === 'On Progress' ? 'bg-warning' : s === 'Pending' ? 'bg-muted-foreground' : 'bg-brand'}`} />
                    {s}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => afterMenuCloses(() => actions.addNote(task))}>
            <MessageSquare className="w-3.5 h-3.5 mr-2" />{tr.addNoteWord}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Row: the list / day-panel line for one assigned task ────────────────────────
export function AssignedTaskRow({
  task, actor, canAct, statusColumns, showAssignees, onOpen, onChanged,
}: {
  task: AssignedTask; actor: TaskActor | null; canAct: boolean; statusColumns: string[];
  showAssignees?: boolean; onOpen?: (task: AssignedTask) => void; onChanged: (task: AssignedTask) => void;
}) {
  const tr = useT();
  const actions = useAssignedTaskActions({ actor, onChanged });
  const done = task.status === 'Completed';
  const today = localDateString();
  const overdue = !done && task.date < today;
  const assigneeNames = (task.assignees ?? []).map(a => a.employee_name).join(', ');

  return (
    <div className="px-4 py-2.5 hover:bg-accent transition-colors">
      <div className="flex items-start gap-3">
        <button type="button" onClick={() => onOpen?.(task)} disabled={!onOpen}
          className="flex-1 min-w-0 text-left disabled:cursor-default">
          <span className={`block text-sm truncate ${done ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{task.description}</span>
          <span className="flex items-center gap-2 mt-1 flex-wrap">
            <StatusBadge status={task.status} />
            {overdue && <Badge variant="destructive"><AlertTriangle className="w-3 h-3" />{tr.overdueByTpl.replace('{n}', String(Math.round((new Date(today).getTime() - new Date(task.date).getTime()) / 86_400_000)))}</Badge>}
            <span className="text-[10px] text-muted-foreground">{task.task_type}</span>
            <span className="text-[10px] text-primary truncate">{tr.assignedByTpl.replace('{name}', task.assigned_by_name)}</span>
            {showAssignees && assigneeNames && (
              <span className="text-[10px] text-muted-foreground truncate inline-flex items-center gap-1"><Users className="w-2.5 h-2.5" />{assigneeNames}</span>
            )}
          </span>
          <span className="block mt-1"><TaskTimes item={task} /></span>
          <TaskFlagLine flag={task.flag} originalDate={task.original_date} date={task.date} />
          {task.status_note && !task.flag && (
            <span className="block mt-1 text-[11px] text-muted-foreground truncate">
              <span className="font-semibold">{tr.lastNoteLabel}:</span> {task.status_note}
              {task.status_changed_by_name && <span className="opacity-70"> · {tr.byTpl.replace('{name}', task.status_changed_by_name)}</span>}
            </span>
          )}
        </button>
        {canAct && <AssignedTaskActionCluster task={task} actions={actions} statusColumns={statusColumns} layout="row" />}
      </div>
      {canAct && actions.dialogs}
    </div>
  );
}

// ─── Timeline: the trail, oldest first ───────────────────────────────────────────
export function AssignedTaskTimeline({ taskId, refreshKey = 0 }: { taskId: string; refreshKey?: number }) {
  const tr = useT();
  const [events, setEvents] = useState<AssignedTaskEvent[] | null>(null);
  useEffect(() => {
    let active = true;
    setEvents(null);
    getAssignedTaskEvents(taskId)
      .then(ev => { if (active) setEvents(ev); })
      .catch(e => { console.error('[tasks] timeline load error', e); if (active) setEvents([]); });
    return () => { active = false; };
  }, [taskId, refreshKey]);

  if (events === null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-3/4 rounded-md" />
        <Skeleton className="h-8 w-2/3 rounded-md" />
      </div>
    );
  }
  if (events.length === 0) return <p className="text-xs text-muted-foreground">{tr.noTimelineYet}</p>;

  return (
    <ol className="space-y-0">
      {events.map((ev, i) => {
        const last = i === events.length - 1;
        const { icon, label, tone } = describeEvent(ev, tr);
        const body = ev.kind === 'flagged' ? ev.reason : ev.kind === 'rescheduled' ? null : ev.note;
        const at = ms(ev.at);
        return (
          <li key={ev.id} className="flex gap-3">
            <div className="flex flex-col items-center flex-shrink-0">
              <span className={`w-6 h-6 rounded-full border flex items-center justify-center ${tone}`}>{icon}</span>
              {!last && <span className="w-px flex-1 min-h-[12px] bg-border" />}
            </div>
            <div className={`min-w-0 flex-1 ${last ? '' : 'pb-3'}`}>
              <p className="text-xs font-medium text-foreground leading-6">{label}</p>
              {body && <p className="mt-0.5 rounded-md bg-muted px-2.5 py-1.5 text-[11px] text-muted-foreground whitespace-pre-wrap break-words">{body}</p>}
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {tr.byTpl.replace('{name}', ev.by_name)}{at ? ` · ${fmtStamp(at)}` : ''}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function describeEvent(ev: AssignedTaskEvent, tr: ReturnType<typeof useT>): { icon: ReactNode; label: string; tone: string } {
  const ic = 'w-3 h-3';
  const neutral = 'border-border bg-muted text-muted-foreground';
  switch (ev.kind) {
    case 'assigned':   return { icon: <UserPlus className={ic} />, label: tr.evAssigned, tone: 'border-primary/30 bg-primary/10 text-primary' };
    case 'status':     return { icon: <ArrowRight className={ic} />, label: tr.evStatusTpl.replace('{from}', ev.from_status ?? '—').replace('{to}', ev.to_status ?? '—'), tone: neutral };
    case 'started':    return { icon: <Play className={ic} />, label: tr.evStarted, tone: 'border-warning/30 bg-warning/10 text-warning' };
    case 'ended':      return { icon: <CheckCircle2 className={ic} />, label: tr.evEnded, tone: 'border-success/30 bg-success/10 text-success' };
    case 'flagged': {
      // The service writes 'Cannot start' / 'Delayed' into note for a flag; the reason sits in `reason`.
      const cannot = ev.note === 'Cannot start';
      return {
        icon: <AlertTriangle className={ic} />,
        label: cannot ? tr.evCannotStart : tr.evDelayed,
        tone: cannot ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-warning/30 bg-warning/10 text-warning',
      };
    }
    case 'flag_cleared': return { icon: <Flag className={ic} />, label: tr.evFlagCleared, tone: neutral };
    case 'rescheduled':  return {
      icon: <CalendarClock className={ic} />,
      label: tr.evRescheduledTpl.replace('{from}', ev.from_date ? fmtDay(ev.from_date) : '—').replace('{to}', ev.to_date ? fmtDay(ev.to_date) : '—'),
      tone: 'border-warning/30 bg-warning/10 text-warning',
    };
    case 'note':
    default:           return { icon: <MessageSquare className={ic} />, label: tr.evNote, tone: neutral };
  }
}
