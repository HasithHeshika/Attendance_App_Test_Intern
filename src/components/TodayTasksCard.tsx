'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ListTodo, AlertTriangle, Play, CheckCircle2, ChevronDown, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useT } from '@/store/appStore';
import { localDateString } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TASK_STATUSES, type TaskStatus } from '@/lib/types';
import type { WorkItem } from '@/lib/workItem';
import { StatusNoteDialog, TaskTimes, TaskFlagPill } from '@/components/tasks/AssignedTaskLifecycle';

export default function TodayTasksCard({
  items, loading, onStatusChange,
}: {
  items: WorkItem[];
  loading: boolean;
  // `note` travels with assigned-task changes only; daily items never ask for one.
  onStatusChange: (item: WorkItem, next: TaskStatus, note?: string) => void | Promise<void>;
}) {
  const tr = useT();
  const todayStr = localDateString();
  // One prompt for the whole card — only one status change happens at a time here.
  const [prompt, setPrompt] = useState<{ item: WorkItem; next: TaskStatus } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Assigned items: Start and Complete act at once (the clock is the point); any other
  // status goes through the note prompt. The dashboard handler rethrows for assigned items
  // so a failure is heard here instead of a false "done".
  const runAssigned = async (item: WorkItem, next: TaskStatus, note?: string): Promise<boolean> => {
    setBusyKey(item.key);
    try {
      await onStatusChange(item, next, note);
      toast.success(next === 'Completed' ? tr.taskCompletedToast : next === 'On Progress' && item.status === 'Pending' ? tr.taskStartedToast : tr.statusSavedToast);
      return true;
    } catch {
      toast.error(tr.failedUpdateStatus);
      return false;
    } finally { setBusyKey(null); }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm text-foreground flex items-center gap-2">
          <ListTodo className="w-4 h-4 text-primary" />{tr.todaysTasksTitle}
        </CardTitle>
        <Link href="/tasks" className="text-xs font-semibold text-primary flex items-center gap-1 hover:underline">
          {tr.viewAllTasks} <ArrowRight className="w-3 h-3" />
        </Link>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading && items.length === 0 ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-14 w-full rounded-lg" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">{tr.nothingDueToday}</p>
        ) : (
          items.map(item => {
            const overdueDays = item.date < todayStr
              ? Math.round((new Date(todayStr).getTime() - new Date(item.date).getTime()) / 86_400_000)
              : 0;
            const busy = busyKey === item.key;
            const otherStatuses = TASK_STATUSES.filter(st => st !== item.status);
            return (
              <div key={item.key} className="rounded-lg border border-border p-3 space-y-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{item.description}</p>
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    {overdueDays > 0
                      ? <Badge variant="destructive"><AlertTriangle className="w-3 h-3" />{tr.overdueByTpl.replace('{n}', String(overdueDays))}</Badge>
                      : <Badge variant="default">{tr.dueTodayBadge}</Badge>}
                    {item.assigned_by_name && (
                      <span className="text-[11px] text-muted-foreground">{tr.assignedByTpl.replace('{name}', item.assigned_by_name)}</span>
                    )}
                  </div>
                  {item.kind === 'assigned' && (
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <TaskTimes item={item} />
                      <TaskFlagPill flag={item.flag} date={item.date} />
                    </div>
                  )}
                </div>
                {item.kind === 'assigned' ? (
                  <div className="flex items-center gap-1.5">
                    {item.status === 'Pending' && (
                      <Button type="button" size="sm" disabled={busy} onClick={() => runAssigned(item, 'On Progress')} className="gap-1.5 flex-1">
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}{tr.taskStartWord}
                      </Button>
                    )}
                    {item.status !== 'Completed' && (
                      <Button type="button" size="sm" variant={item.status === 'Pending' ? 'outline' : 'success'} disabled={busy}
                        onClick={() => runAssigned(item, 'Completed')} className="gap-1.5 flex-1">
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}{tr.taskCompleteWord}
                      </Button>
                    )}
                    {otherStatuses.length > 0 && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button type="button" size="sm" variant="ghost" disabled={busy} className="gap-1">
                            {tr.statusChangeTitle}<ChevronDown className="w-3.5 h-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {otherStatuses.map(st => (
                            <DropdownMenuItem key={st} onSelect={() => setTimeout(() => setPrompt({ item, next: st }), 0)}>
                              <span className={`w-2 h-2 rounded-full mr-2 ${st === 'Completed' ? 'bg-success' : st === 'On Progress' ? 'bg-warning' : 'bg-muted-foreground'}`} />
                              {st}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-1.5">
                    {TASK_STATUSES.map(st => (
                      <button key={st} type="button" onClick={() => onStatusChange(item, st)}
                        className={`px-2 py-1.5 rounded-md text-[11px] font-semibold border transition-colors ${
                          item.status === st
                            ? st === 'Completed' ? 'bg-success/15 border-success/40 text-success'
                            : st === 'On Progress' ? 'bg-warning/15 border-warning/40 text-warning'
                            : 'bg-secondary border-border text-secondary-foreground'
                            : 'bg-muted border-border text-muted-foreground hover:text-foreground'}`}>
                        {st}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>

      <StatusNoteDialog
        open={prompt !== null}
        status={prompt?.next ?? null}
        busy={busyKey !== null}
        onConfirm={async note => { if (prompt && await runAssigned(prompt.item, prompt.next, note)) setPrompt(null); }}
        onSkip={async () => { if (prompt && await runAssigned(prompt.item, prompt.next, '')) setPrompt(null); }}
        onCancel={() => { if (busyKey === null) setPrompt(null); }}
      />
    </Card>
  );
}
