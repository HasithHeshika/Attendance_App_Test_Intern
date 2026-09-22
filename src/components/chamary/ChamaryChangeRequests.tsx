'use client';
import { Loader2, ArrowRight, ClipboardList, Check, X, User } from 'lucide-react';
import { useT } from '@/store/appStore';
import type { MealChangeRequest } from '@/lib/types';
import { MEAL_LABEL, mealOf } from '@/lib/meals';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Props {
  changes:  MealChangeRequest[];
  /** Id of the request a decision is in flight for — its buttons lock while it lands. */
  busyId:   string | null;
  onDecide: (req: MealChangeRequest, approve: boolean) => void;
}

export default function ChamaryChangeRequests({ changes, busyId, onDecide }: Props) {
  const t = useT();
  if (changes.length === 0) return null;

  return (
    <Card className="overflow-hidden border-border/80 bg-card p-4 shadow-sm sm:p-5">
      <div className="flex items-center justify-between gap-2 border-b border-border/40 pb-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <ClipboardList className="h-4 w-4" />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-foreground">{t.changeRequestsTitle}</span>
              <Badge variant="warning">{changes.length}</Badge>
            </div>
            <p className="text-[11px] text-muted-foreground">{t.changeRequestsHint}</p>
          </div>
        </div>
      </div>

      <div className="mt-3 space-y-2.5">
        {changes.map(c => {
          const busy = busyId === c.id;
          const initials = c.employee_name.trim().slice(0, 2).toUpperCase();

          return (
            <div
              key={c.id}
              className="rounded-xl border border-border/70 bg-muted/15 p-3.5 transition-all hover:border-border"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                    {initials || <User className="h-4 w-4" />}
                  </div>
                  <div>
                    <span className="text-sm font-semibold text-foreground">{c.employee_name}</span>
                    <span className="ml-2 text-xs tabular-nums text-muted-foreground">{c.date}</span>
                  </div>
                </div>

                <Badge variant={c.kind === 'remove' ? 'destructive' : 'secondary'}>
                  {c.kind === 'remove' ? t.removeWord : t.moveWord}
                </Badge>
              </div>

              {/* Movement route details */}
              <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg bg-background/80 px-3 py-2 text-xs">
                <div className="flex items-center gap-1.5 font-medium text-foreground">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase font-bold text-muted-foreground">
                    {MEAL_LABEL[mealOf(c.meal)]}
                  </span>
                  <span>{c.chamary_name}</span>
                </div>

                {c.to_chamary_name && (
                  <>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    <div className="flex items-center gap-1.5 font-semibold text-primary">
                      <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] uppercase font-bold text-primary">
                        {MEAL_LABEL[mealOf(c.to_meal ?? c.meal)]}
                      </span>
                      <span>{c.to_chamary_name}</span>
                    </div>
                  </>
                )}
              </div>

              {/* Stated reason */}
              {c.reason && (
                <div className="mt-2.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-foreground/90">
                  <span className="font-semibold text-muted-foreground mr-1">Reason:</span>
                  &ldquo;{c.reason}&rdquo;
                </div>
              )}

              {/* Actions */}
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  className="gap-1.5 text-xs"
                  onClick={() => onDecide(c, false)}
                >
                  <X className="h-3.5 w-3.5 text-destructive" />
                  {t.turnDownWord}
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  className="gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                  onClick={() => onDecide(c, true)}
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  {t.approveWord}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
