'use client';
// Southern Lanka only — "Import Day Offs" on the Schedule page. Enabled only once a department
// is picked; the template then downloads pre-filled with that department's active employees
// (EPF + Name), one row each, with five Date columns to fill in (a monthly rest-day
// allocation — ~1 off per week). Every non-empty date becomes one `day_offs` doc via
// dayOffService.bulkCreateDayOffs, and the Schedule grid overlays them.
import { useRef, useState } from 'react';
import { CalendarPlus, Upload, Loader2, Check, FileDown, AlertTriangle, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { getAllUsers } from '@/services/userService';
import { bulkCreateDayOffs } from '@/services/dayOffService';
import {
  parseDayOffWorkbook, buildDayOffDraftRows, downloadDayOffTemplate,
  MissingDayOffHeadersError, type DayOffDraftRow, type DayOffTemplateEmployee,
} from '@/lib/dayOffImport';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

export default function ImportDayOffsDialog({
  createdByEpf,
  disabled = false,
  departmentName,
  employees = [],
  onImported,
}: {
  createdByEpf: string;
  /** Disable the trigger until a department is selected. */
  disabled?: boolean;
  /** Selected department — used for the template filename and header copy. */
  departmentName?: string;
  /** The selected department's active employees — pre-fills the downloadable template. */
  employees?: DayOffTemplateEmployee[];
  /** Called after a successful import so the grid can refetch. */
  onImported?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<DayOffDraftRow[]>([]);
  const [fileName, setFileName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importable = rows.filter((r) => !r.issue);
  const blocked = rows.filter((r) => r.issue);

  const reset = () => { setRows([]); setFileName(''); setParsing(false); setSaving(false); };
  const close = () => { setOpen(false); reset(); };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file after a fix
    if (!file) return;
    setParsing(true);
    setRows([]);
    try {
      const parsed = await parseDayOffWorkbook(file);
      if (!parsed.length) {
        toast.error('No data rows found — fill in a row below the header and try again.');
        return;
      }
      const users = await getAllUsers();
      // departmentName scopes validation — every EPF in the sheet must belong to it.
      setRows(buildDayOffDraftRows(parsed, users, departmentName));
      setFileName(file.name);
    } catch (err) {
      console.error(err);
      if (err instanceof MissingDayOffHeadersError) {
        toast.error(`This sheet is missing column(s): ${err.missingHeaders.join(', ')}. Use the template.`);
      } else {
        toast.error("Couldn't read that file — make sure it's an .xlsx/.csv built from the template.");
      }
    } finally {
      setParsing(false);
    }
  };

  const submit = async () => {
    if (!importable.length) return;
    setSaving(true);
    try {
      const { created, skipped } = await bulkCreateDayOffs(
        importable.map((r) => ({
          epf_number: r.epf_number,
          employee_name: r.employee_name,
          date: r.date,
          source: 'excel' as const,
        })),
        createdByEpf,
      );
      toast.success(
        `${created} day off${created === 1 ? '' : 's'} imported`
        + (skipped ? ` · ${skipped} already declared, skipped` : ''),
      );
      close();
      onImported?.();
    } catch (err) {
      console.error(err);
      toast.error('Failed to import day offs.');
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
        <CalendarPlus className="w-4 h-4" /> Import Day Offs
      </Button>

      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarPlus className="w-5 h-5 text-primary" />
              Import Day Offs{departmentName ? ` · ${departmentName}` : ''}
            </DialogTitle>
            <DialogDescription>
              One row per employee, up to five dates each (<span className="font-medium text-foreground">Date 1</span>–
              <span className="font-medium text-foreground">Date 5</span>), formatted <span className="font-medium text-foreground">YYYY/MM/DD</span>.
              Every EPF must belong to {departmentName ? <span className="font-medium text-foreground">{departmentName}</span> : 'the selected department'};
              every listed date becomes a Day Off. Already-declared dates are skipped.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadDayOffTemplate(employees, departmentName).catch(() => toast.error('Failed to build the template'))}
            >
              <FileDown className="w-3.5 h-3.5" />
              {employees.length ? `Template · ${employees.length} employee${employees.length === 1 ? '' : 's'}` : 'Template'}
            </Button>
            <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={parsing}>
              {parsing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              {rows.length ? 'Choose another file' : 'Choose file'}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={handleFile}
            />
          </div>

          {fileName && (
            <p className="text-[11px] text-muted-foreground">
              {fileName} — <span className="text-success font-medium">{importable.length} day off{importable.length === 1 ? '' : 's'} ready</span>
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
                    <th className="px-2.5 py-1.5 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-2.5 py-1.5">
                        <div className="font-medium text-foreground truncate max-w-[12rem]">{r.employee_name}</div>
                        <div className="text-[10px] text-muted-foreground">{r.epfRaw || '—'}</div>
                      </td>
                      <td className="px-2.5 py-1.5 tabular-nums text-foreground">{r.date || r.dateRaw || '—'}</td>
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
                : <><Check className="w-4 h-4" />Import {importable.length || ''} day off{importable.length === 1 ? '' : 's'}</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
