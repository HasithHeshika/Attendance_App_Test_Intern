'use client';
import { useMemo, useState } from 'react';
import { ExternalLink, Loader2, CloudOff, ListChecks } from 'lucide-react';
import toast from 'react-hot-toast';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { tenant } from '@/lib/firebase';
import { useT } from '@/store/appStore';
import { useLogPupTasks, type LogPupTask } from '@/components/useLogPupTasks';
import {
  LOGPUP_STATUS_ORDER,
  toAttendanceStatus,
  type LogPupMappedStatus,
} from '@/lib/logpupStatus';
import { fmtDay } from '@/components/tasks/assignedTaskFormat';
import { localDateString } from '@/lib/utils';

/**
 * The signed-in person's own LogPup project tasks, shown beneath their personal task list.
 *
 * SELF-CONTAINED ON PURPOSE. /tasks is already 2,000+ lines with three views and two modes;
 * threading a third source of work items through that state machine would make every existing
 * branch read "…unless it's a LogPup one". This component owns its hook, renders nothing at all
 * when the tenant flag is off, and can be removed in one commit.
 *
 * Read-mostly: a LogPup task's title, deadline, app and people are decided on the LogPup board.
 * The only thing editable here is status, because that is the thing somebody wants to change
 * while they are in this app anyway.
 */
export default function LogPupTaskList({ enabled }: { enabled: boolean }) {
  const tr = useT();
  const { tasks, loading, reachable, setStatus, saving } = useLogPupTasks(enabled);
  const [showDone, setShowDone] = useState(false);

  // The flag is checked in the hook too (so it issues no request), and again here so the
  // section leaves no heading behind on a tenant without LogPup.
  if (!tenant.features.logpupTasks) return null;

  const open = tasks.filter(t => t.status !== 'done');
  const done = tasks.filter(t => t.status === 'done');
  const shown = showDone ? [...open, ...done] : open;

  // Nothing to say yet: no tasks, still loading, and LogPup is fine. Stay out of the way
  // rather than adding an empty card to a page that already has content.
  if (!loading && reachable && tasks.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-semibold text-foreground">{tr.logpupSectionTitle}</h2>
          {open.length > 0 && (
            <Badge variant="muted" className="text-[10px]">{open.length}</Badge>
          )}
        </div>
        {done.length > 0 && (
          <button
            type="button"
            onClick={() => setShowDone(v => !v)}
            className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {showDone
              ? tr.logpupHideDone
              : tr.logpupShowDoneTpl.replace('{n}', String(done.length))}
          </button>
        )}
      </div>

      {loading && tasks.length === 0 && (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          {tr.logpupLoading}
        </div>
      )}

      {!reachable && (
        // Quiet, and not an error: this app's job is attendance. A person who cannot reach
        // LogPup for a minute has lost nothing they need right now.
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <CloudOff className="h-3.5 w-3.5" aria-hidden />
          {tr.logpupUnreachable}
        </div>
      )}

      <div className="space-y-2">
        {shown.map(task => (
          <LogPupRow
            key={task.id}
            task={task}
            saving={saving.has(task.id)}
            onStatus={setStatus}
          />
        ))}
      </div>
    </section>
  );
}

function LogPupRow({
  task, saving, onStatus,
}: {
  task: LogPupTask;
  saving: boolean;
  onStatus: (id: string, next: LogPupMappedStatus) => Promise<void>;
}) {
  const tr = useT();
  const status = toAttendanceStatus(task.status);
  const due = useMemo(() => describeDue(task, tr), [task, tr]);

  const change = async (next: LogPupMappedStatus) => {
    if (saving || next === status) return;
    try {
      await onStatus(task.id, next);
    } catch (e) {
      // LogPup writes its refusals as sentences for a person ("You are not on this task").
      toast.error(e instanceof Error ? e.message : tr.logpupUpdateFailed);
    }
  };

  return (
    <Card className={saving ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
      <CardContent className="p-3 sm:p-4 space-y-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-foreground leading-snug break-words">
              {task.title}
            </p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              {task.app && <span className="font-medium text-foreground/80">{task.app.name}</span>}
              {task.sprint && <span>· {task.sprint.name}</span>}
              {!task.isPrimaryAssignee && (
                <Badge variant="outline" className="text-[9px]">{tr.logpupSupporting}</Badge>
              )}
            </div>
          </div>
          {task.url && (
            <a
              href={task.url}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              aria-label={tr.logpupOpenInApp}
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          )}
        </div>

        {due && (
          <div className="flex items-center gap-1.5">
            <Badge variant={due.tone} className="text-[10px]">{due.label}</Badge>
            {due.note && (
              <span className="text-[11px] text-muted-foreground truncate">{due.note}</span>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden />}
          {/* Only LogPup's three. A tenant's custom statuses have no LogPup equivalent, and
              offering one would throw at the mapping boundary (see logpupStatus.ts). */}
          {LOGPUP_STATUS_ORDER.map(s => {
            const active = s === status;
            return (
              <button
                key={s}
                type="button"
                disabled={saving}
                onClick={() => void change(s)}
                aria-pressed={active}
                className={
                  active
                    ? 'rounded-md px-2 py-1 text-[11px] font-semibold bg-primary text-primary-foreground'
                    : 'rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50'
                }
              >
                {s}
              </button>
            );
          })}
          {status === null && (
            // LogPup grew a status this build does not know. Show the raw value rather than
            // rendering finished work as outstanding.
            <Badge variant="outline" className="text-[10px]">{task.status}</Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * How a deadline reads on a row.
 *
 * `dueDate` is a plain YYYY-MM-DD string and is COMPARED AS ONE, never parsed into a Date:
 * `new Date('2026-08-12')` is midnight UTC, which is still the 11th in Asia/Colombo. The same
 * trap is documented in taskService.getDueTasks, which compares strings for this reason.
 *
 * A committed date is named explicitly. LogPup keeps `dueKind` in its own column precisely
 * because a commitment was promised to somebody who is planning around it, and rendering it
 * identically to a target would discard that whole distinction.
 */
function describeDue(
  task: LogPupTask,
  tr: ReturnType<typeof useT>,
): { label: string; tone: 'destructive' | 'warning' | 'muted'; note: string | null } | null {
  if (!task.dueDate) return null;
  const today = localDateString();
  const committed = task.dueKind === 'committed';
  const kind = committed ? tr.logpupCommittedWord : tr.dueWord;
  const note = committed ? task.dueCommitmentNote : null;

  if (task.status !== 'done' && task.dueDate < today) {
    return {
      label: tr.logpupOverdueTpl.replace('{date}', fmtDay(task.dueDate)),
      tone: 'destructive',
      note,
    };
  }
  if (task.dueDate === today) {
    return { label: tr.logpupDueTodayTpl.replace('{kind}', kind), tone: 'warning', note };
  }
  return {
    label: tr.logpupDueOnTpl.replace('{kind}', kind).replace('{date}', fmtDay(task.dueDate)),
    tone: committed ? 'warning' : 'muted',
    note,
  };
}
