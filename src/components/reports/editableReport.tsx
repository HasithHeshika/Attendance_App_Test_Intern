'use client';
import { useMemo, useState } from 'react';
import { Pencil, Check, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

// Edit-before-download, shared by every report tab.
//
// Deliberately EXPORT-ONLY: an edit lives in this hook's state, feeds both the table on screen
// and the spreadsheet the Export button builds, and is gone on reload. Nothing is written back
// to Firestore — a report is a snapshot an admin tidies up (a name spelt properly, a count the
// kitchen corrected by hand) before sending it on, not a second source of truth competing with
// the records the app actually runs on.
//
// Overrides are keyed `${rowKey}:${field}`, so a report only has to name its rows stably (EPF,
// document id) and the same edit survives a re-render of the table.

export type ReportEdits = Record<string, string | number>;

export interface ReportEditor {
  /** Is the table currently in edit mode? */
  editing: boolean;
  setEditing: (on: boolean) => void;
  /** How many cells the admin has changed — what the "edited" badge counts. */
  count: number;
  /** The value to SHOW and to EXPORT: the admin's override if there is one, else the original.
   *  Every report must read its cells through this, including when building the XLSX. */
  value: <T extends string | number>(rowKey: string, field: string, original: T) => T;
  /** Record an override. Passing a value equal to the original drops it, so undoing an edit by
   *  hand really does leave the row unedited rather than "edited back to the same number". */
  set: (rowKey: string, field: string, next: string | number, original: string | number) => void;
  /** Throw every override away. */
  reset: () => void;
}

export function useReportEditor(): ReportEditor {
  const [editing, setEditing] = useState(false);
  const [edits, setEdits]     = useState<ReportEdits>({});

  return useMemo(() => ({
    editing,
    setEditing,
    count: Object.keys(edits).length,
    value: <T extends string | number>(rowKey: string, field: string, original: T): T => {
      const v = edits[`${rowKey}:${field}`];
      return (v === undefined ? original : v) as T;
    },
    set: (rowKey, field, next, original) => {
      const key = `${rowKey}:${field}`;
      setEdits(prev => {
        const copy = { ...prev };
        if (next === original) delete copy[key];
        else copy[key] = next;
        return copy;
      });
    },
    reset: () => setEdits({}),
  }), [editing, edits]);
}

/** Edit / Done toggle plus a revert, for a report's button row. Sits next to Export so the two
 *  read as one sentence: change what's wrong, then download. */
export function ReportEditControls({ editor, className }: { editor: ReportEditor; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Button
        size="sm"
        variant={editor.editing ? 'default' : 'outline'}
        onClick={() => editor.setEditing(!editor.editing)}
      >
        {editor.editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
        {editor.editing ? 'Done' : 'Edit'}
      </Button>
      {editor.count > 0 && (
        <>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
            {editor.count} edited
          </span>
          <Button size="sm" variant="ghost" onClick={editor.reset}>
            <Undo2 className="h-4 w-4" /> Revert
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * One report cell. Plain text until the report is in edit mode, then an input in the same box —
 * the row must not jump height or re-flow when Edit is pressed, or comparing a column against
 * what it said a second ago becomes guesswork.
 *
 * `render` formats the read-only view (2dp money, a badge, whatever the report already did);
 * without it the value is printed as-is. The input always shows the raw value, because that is
 * what the admin is about to type over.
 */
export function EditableCell({
  editor, rowKey, field, value, type = 'text', align = 'left', className, render,
}: {
  editor:  ReportEditor;
  rowKey:  string;
  field:   string;
  value:   string | number;
  type?:   'text' | 'number';
  align?:  'left' | 'right';
  className?: string;
  render?: (v: string | number) => React.ReactNode;
}) {
  const current = editor.value(rowKey, field, value);

  if (!editor.editing) {
    return <span className={className}>{render ? render(current) : current}</span>;
  }

  return (
    <input
      value={current}
      type={type}
      inputMode={type === 'number' ? 'decimal' : undefined}
      step={type === 'number' ? 'any' : undefined}
      onChange={e => {
        const raw = e.target.value;
        // A number column stays numeric so the spreadsheet gets a number, not a string that
        // looks like one — but an empty box while typing must not collapse to 0.
        editor.set(rowKey, field, type === 'number' ? (raw === '' ? '' : Number(raw)) : raw, value);
      }}
      className={cn(
        'w-full min-w-0 rounded-md border border-border bg-background px-1.5 py-0.5 text-sm text-foreground',
        'focus:border-primary focus:outline-none',
        align === 'right' && 'text-right tabular-nums',
        className,
      )}
    />
  );
}

/** Numbers come back from an edited cell as `number | string` (the box can be mid-typing).
 *  Export builders push them through this so a half-typed cell exports as 0, not "". */
export function numeric(v: string | number): number {
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : 0;
}
