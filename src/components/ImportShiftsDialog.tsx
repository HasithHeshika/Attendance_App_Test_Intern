'use client';
// Southern Lanka only — "Import Shift Roster" on the Schedule page. Enabled once a department
// is picked. The template exports one row per department employee with a Day 1 … Day N column
// per calendar day of the visible month; each cell takes one or more shift NAMES (comma- or
// slash-separated). On confirm every validated name is mapped to its shift_id and written as a
// schedule_assignments doc via scheduleAssignmentService.bulkCreateScheduleAssignments.
import { useRef, useState } from 'react';
import { CalendarPlus, Upload, Loader2, Check, FileDown, AlertTriangle, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { getAllUsers } from '@/services/userService';
import { bulkCreateScheduleAssignments } from '@/services/scheduleAssignmentService';
import {
  parseShiftRosterWorkbook, buildRosterDraftRows, downloadShiftRosterTemplate,
  MissingRosterHeadersError, type RosterDraftRow, type RosterTemplateEmployee,
} from '@/lib/shiftRosterImport';
import type { Shift } from '@/lib/types';
import type { HolidayType } from '@/services/holidayService';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

export default function ImportShiftsDialog({
  departmentId,
  departmentName,
  departmentShifts,
  employees = [],
  month,
  holidayTypes,
  actor,
  disabled = false,
  onImported,
}: {
  departmentId?: string;
  departmentName?: string;
  /** The selected department's active shift definitions — the match set for cell names. */
  departmentShifts: Shift[];
  /** The department's active employees — pre-fills the exported template. */
  employees?: RosterTemplateEmployee[];
  /** Visible roster month — resolves "Day N" columns and sets the template's day count. */
  month: Date;
  holidayTypes: Map<string, HolidayType>;
  actor: { epf_number: string; name: string };
  disabled?: boolean;
  onImported?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<RosterDraftRow[]>([]);
  const [fileName, setFileName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importable = rows.filter((r) => !r.issue);
  const blocked = rows.filter((r) => r.issue);
  const monthLabel = month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const reset = () => { setRows([]); setFileName(''); setParsing(false); setSaving(false); };
  const close = () => { setOpen(false); reset(); };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setParsing(true);
    setRows([]);
    try {
      const parsed = await parseShiftRosterWorkbook(file, { month });
      if (!parsed.length) {
        toast.error('No data rows found — fill in a row below the header and try again.');
        return;
      }
      const users = await getAllUsers();
      setRows(buildRosterDraftRows(parsed, users, departmentShifts, departmentName ?? ''));
      setFileName(file.name);
    } catch (err) {
      console.error(err);
      if (err instanceof MissingRosterHeadersError) {
        toast.error(`This sheet is missing column(s): ${err.missingHeaders.join(', ')}. Use the template.`);
      } else {
        toast.error("Couldn't read that file — make sure it's an .xlsx/.csv built from the template.");
      }
    } finally {
      setParsing(false);
    }
  };

  const submit = async () => {
    if (!importable.length || !departmentId || !departmentName) return;
    setSaving(true);
    try {
      const { created, skipped } = await bulkCreateScheduleAssignments(
        importable.map((r) => ({
          department_id: departmentId,
          department_name: departmentName,
          epf_number: r.epf_number,
          employee_name: r.employee_name,
          date: r.date,
          shift_id: r.shift_id,
          shift_name: r.shift_name,
          start_time: r.start_time,
          end_time: r.end_time,
          holiday_type: holidayTypes.get(r.date) ?? null,
        })),
        actor,
      );
      toast.success(
        `${created} shift assignment${created === 1 ? '' : 's'} imported`
        + (skipped ? ` · ${skipped} already on the roster, skipped` : ''),
      );
      close();
      onImported?.();
    } catch (err) {
      console.error(err);
      toast.error('Failed to import the roster.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        disabled={disabled}
        title={disabled ? 'Select a department first' : undefined}
        onClick={() => setOpen(true)}
      >
        <CalendarPlus className="w-4 h-4" /> Import Shift Roster
      </Button>

      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarPlus className="w-5 h-5 text-primary" />
              Import Shift Roster{departmentName ? ` · ${departmentName}` : ''}
            </DialogTitle>
            <DialogDescription>
              One row per employee for <span className="font-medium text-foreground">{monthLabel}</span>. Each
              day cell takes one or more shift names ({departmentShifts.map((s) => s.name).join(', ') || 'no shifts defined'}),
              comma- or slash-separated. Names must match {departmentName ? <span className="font-medium text-foreground">{departmentName}</span> : 'the department'}’s
              shifts. Assignments already on the roster are skipped.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!departmentShifts.length}
              title={!departmentShifts.length ? 'This department has no shifts yet' : undefined}
              onClick={() => downloadShiftRosterTemplate(employees, departmentName, month).catch(() => toast.error('Failed to build the template'))}
            >
              <FileDown className="w-3.5 h-3.5" />
              {employees.length ? `Export Shift Template · ${employees.length}` : 'Export Shift Template'}
            </Button>
            <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={parsing}>
              {parsing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              {rows.length ? 'Choose another file' : 'Choose file'}
            </Button>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
          </div>

          {fileName && (
            <p className="text-[11px] text-muted-foreground">
              {fileName} — <span className="text-success font-medium">{importable.length} assignment{importable.length === 1 ? '' : 's'} ready</span>
              {blocked.length > 0 && <span className="text-destructive font-medium"> · {blocked.length} with issues</span>}
            </p>
          )}

          {rows.length > 0 && (
            <div className="max-h-[42vh] overflow-y-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr className="text-left text-muted-foreground">
                    <th className="px-2.5 py-1.5 font-semibold">Employee</th>
                    <th className="px-2.5 py-1.5 font-semibold">Date</th>
                    <th className="px-2.5 py-1.5 font-semibold">Shift</th>
                    <th className="px-2.5 py-1.5 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-2.5 py-1.5">
                        <div className="font-medium text-foreground truncate max-w-[10rem]">{r.employee_name}</div>
                        <div className="text-[10px] text-muted-foreground">{r.epf_number || '—'}</div>
                      </td>
                      <td className="px-2.5 py-1.5 tabular-nums text-foreground whitespace-nowrap">{r.date || r.dateLabel || '—'}</td>
                      <td className="px-2.5 py-1.5 text-foreground">{r.shift_name || r.rawShift || '—'}</td>
                      <td className="px-2.5 py-1.5 max-w-[16rem]">
                        {r.issue ? (
                          <span className="inline-flex items-start gap-1 text-destructive" title={r.issue}>
                            <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                            <span className="whitespace-normal break-words">{r.issue}</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-success">
                            <Check className="w-3 h-3 flex-shrink-0" /> Ready
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {blocked.length > 0 && (
            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <X className="w-3.5 h-3.5 flex-shrink-0 mt-px text-destructive" />
              Rows with issues are ignored — fix them in the sheet and re-upload, or import the rest.
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" className="flex-1" onClick={close} disabled={saving}>Cancel</Button>
            <Button className="flex-1" onClick={submit} disabled={saving || parsing || importable.length === 0}>
              {saving
                ? <><Loader2 className="w-4 h-4 animate-spin" />Importing…</>
                : <><Check className="w-4 h-4" />Import {importable.length || ''} assignment{importable.length === 1 ? '' : 's'}</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
