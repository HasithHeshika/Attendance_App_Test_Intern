'use client';
// Carry balances forward — the Accounts tab's bulk entry point for suspense approvers who close
// a month outside the app and need each account to pick up where the last one left off.
//
// What the sheet carries is a MOVEMENT: the previous period's closing balance, ADDED to whatever
// the account holds today (a negative figure reduces it). An account reading 10,000 against a
// sheet value of 0.00 keeps its 10,000 — it is not zeroed. Parsing and validation live in
// src/lib/suspenseBalanceImport.ts; each confirmed row then goes through applyCarryForward, which
// moves the balance, stamps the carry-forward on the account and writes the single ledger entry.
// Nothing is written until the approver confirms the previewed numbers.
import { useMemo, useRef, useState } from 'react';
import { Upload, FileDown, Loader2, Check, AlertTriangle, Minus, ArrowRight, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { getAllEmployees } from '@/services/userService';
import { applyCarryForward, formatSuspenseAmount, type Actor } from '@/services/suspenseService';
import {
  parseBalanceWorkbook, buildBalanceDraftRows, downloadBalanceTemplate,
  carryForwardPeriod, defaultCarryForwardDate, toDateInputValue, fromDateInputValue,
  MissingBalanceHeadersError, type BalanceDraftRow, type ParsedBalanceRow,
} from '@/lib/suspenseBalanceImport';
import type { AppUser, SuspenseAccount } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import ConfirmModal from '@/components/ConfirmModal';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

// Same wave size as the bulk account opener on /suspense — a failed row is collected and the
// run carries on, so one bad record never costs the whole upload.
const WAVE = 5;
const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export default function ImportBalancesDialog({ accounts, actor, onImported }: {
  /** Every account the approver can see — resolves each row and pre-fills the template. */
  accounts: SuspenseAccount[];
  actor: Actor;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The parsed sheet and the directory it was resolved against are both kept, so changing the
  // as-at date re-resolves the rows (and so the repeat flags) without re-reading the file.
  const [parsed, setParsed] = useState<ParsedBalanceRow[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [fileName, setFileName] = useState('');
  const [asAtValue, setAsAtValue] = useState(() => toDateInputValue(defaultCarryForwardDate()));
  const [note, setNote] = useState('');
  // Deliberate override for rows whose period is already on the account — off by default,
  // because applying one sheet twice doubles every amount on it.
  const [allowRepeat, setAllowRepeat] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // Per-row failures from the last run — kept on screen (the dialog stays open) so the approver
  // can see exactly whose balance didn't take and retry just those. `failedKeys` narrows the
  // table to them, keyed by account rather than by display name: two people can share a name,
  // and the same person legitimately appears once per company.
  const [failures, setFailures] = useState<{ name: string; message: string }[]>([]);
  const [failedKeys, setFailedKeys] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const asAt = fromDateInputValue(asAtValue);
  const period = asAt ? carryForwardPeriod(asAt) : '';

  const allRows = useMemo(
    () => (parsed.length ? buildBalanceDraftRows(parsed, accounts, users, period) : []),
    [parsed, accounts, users, period],
  );
  const rows = failedKeys.size
    ? allRows.filter(r => failedKeys.has(`${r.epf_number}__${r.company_id}`))
    : allRows;

  const blocked = rows.filter(r => r.issue);
  const unchanged = rows.filter(r => !r.issue && r.action === 'unchanged');
  const repeats = rows.filter(r => !r.issue && r.action !== 'unchanged' && r.alreadyCarried);
  const ready = rows.filter(r => !r.issue && r.action !== 'unchanged' && !r.alreadyCarried);
  const importable = allowRepeat ? [...ready, ...repeats] : ready;
  const opening = importable.filter(r => r.action === 'open');
  const netTotal = importable.reduce((t, r) => t + r.amount, 0);
  const currency = rows[0]?.currency ?? accounts[0]?.currency ?? 'LKR';

  const reset = () => {
    setParsed([]); setUsers([]); setFileName(''); setNote(''); setParsing(false);
    setSaving(false); setProgress(null); setFailures([]); setFailedKeys(new Set()); setConfirming(false);
    setAllowRepeat(false); setAsAtValue(toDateInputValue(defaultCarryForwardDate()));
  };
  const close = () => { setOpen(false); reset(); };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';   // allow re-selecting the same file after a fix
    if (!file) return;
    setParsing(true); setParsed([]); setFailures([]); setFailedKeys(new Set());
    try {
      const rowsIn = await parseBalanceWorkbook(file);
      if (!rowsIn.length) {
        toast.error('No amounts found — fill in the Carry Forward column and try again.');
        return;
      }
      setUsers(await getAllEmployees());
      setParsed(rowsIn);
      setFileName(file.name);
    } catch (err) {
      console.error(err);
      if (err instanceof MissingBalanceHeadersError) {
        toast.error(`This sheet is missing column(s): ${err.missingHeaders.join(', ')}. Use the template.`);
      } else {
        toast.error("Couldn't read that file — make sure it's an .xlsx/.csv built from the template.");
      }
    } finally {
      setParsing(false);
    }
  };

  const apply = async () => {
    if (!importable.length || !asAt) return;
    if (!actor.epf) { toast.error('Could not identify you — reload and retry.'); return; }
    setSaving(true); setFailures([]); setFailedKeys(new Set()); setProgress({ done: 0, total: importable.length });
    const failed: { name: string; message: string }[] = [];
    const failedIds = new Set<string>();
    let applied = 0;
    let opened = 0;
    for (let i = 0; i < importable.length; i += WAVE) {
      const wave = importable.slice(i, i + WAVE);
      await Promise.all(wave.map(async (r) => {
        try {
          const res = await applyCarryForward({
            epf: r.epf_number, companyId: r.company_id,
            employeeName: r.employee_name, companyName: r.company_name,
            amount: r.amount, period, asAt, allowRepeat,
            note: note.trim() || `Carried forward from ${period}${fileName ? ` · ${fileName}` : ''}`,
          }, actor);
          applied++;
          if (res.opened) opened++;
        } catch (e) {
          failed.push({ name: `${r.employee_name} · ${r.company_name}`, message: errMsg(e, 'Failed to carry forward.') });
          failedIds.add(`${r.epf_number}__${r.company_id}`);
        }
      }));
      setProgress({ done: Math.min(i + wave.length, importable.length), total: importable.length });
    }
    setProgress(null); setSaving(false); setFailures(failed); setFailedKeys(failedIds);
    const summary = `${applied} account${applied === 1 ? '' : 's'} carried forward`
      + (opened ? `, ${opened} opened` : '')
      + (failed.length ? `, ${failed.length} failed` : '');
    if (failed.length) toast.error(summary); else toast.success(summary);
    onImported();
    if (!failed.length) close();
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Upload className="w-4 h-4" /> Carry forward balances
      </Button>

      <Dialog open={open} onOpenChange={(o) => { if (saving) return; if (o) setOpen(true); else close(); }}>
        <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="w-5 h-5 text-primary" /> Carry forward balances
            </DialogTitle>
            <DialogDescription>
              One row per account. The <span className="font-medium text-foreground">Carry Forward</span> figure is
              the previous period&apos;s closing balance and is <span className="font-medium text-foreground">added</span> to
              what the account holds now — positive raises it, negative
              (<span className="font-medium text-foreground">-2500</span>) reduces it. A blank cell, or 0.00,
              leaves the account exactly as it is.
            </DialogDescription>
          </DialogHeader>

          {/* First, because it names the template: the as-at date IS the period stamp — it decides
              which month is recorded against each account, and therefore which re-upload gets
              caught. Defaults to the 1st of this month, the previous month's position arriving. */}
          <div>
            <Label className="mb-1.5 block text-xs font-semibold text-muted-foreground">Carried forward as at</Label>
            <Input type="date" value={asAtValue} disabled={saving}
              onChange={e => setAsAtValue(e.target.value)} className="max-w-[12rem]" />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {asAt
                ? <>Names the template&apos;s column and is recorded on every account as <span className="font-medium text-foreground">{period}</span>, so the same month can&apos;t be carried in twice.</>
                : <span className="text-destructive">Pick a valid date — it stamps the period on each account.</span>}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Stamped with the as-at date above, so a sheet that has been mailed around and
                filled in still says on its face which month it belongs to. */}
            <Button variant="outline" size="sm" disabled={saving}
              onClick={() => downloadBalanceTemplate(accounts, asAt).catch(() => toast.error('Failed to build the template'))}>
              <FileDown className="w-3.5 h-3.5" />
              {accounts.length ? `Template · ${accounts.length} account${accounts.length === 1 ? '' : 's'}` : 'Template'}
            </Button>
            <Button size="sm" disabled={parsing || saving} onClick={() => fileInputRef.current?.click()}>
              {parsing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              {parsed.length ? 'Choose another file' : 'Choose file'}
            </Button>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
          </div>

          {fileName && (
            <p className="text-[11px] text-muted-foreground">
              {fileName} — <span className="font-medium text-success">{importable.length} to apply</span>
              {importable.length > 0 && <span> · net {netTotal > 0 ? '+' : ''}{formatSuspenseAmount(netTotal, currency)}</span>}
              {opening.length > 0 && <span className="font-medium text-warning"> · {opening.length} opens a new account</span>}
              {unchanged.length > 0 && <span> · {unchanged.length} carrying nothing</span>}
              {repeats.length > 0 && <span className="font-medium text-warning"> · {repeats.length} already carried</span>}
              {blocked.length > 0 && <span className="font-medium text-destructive"> · {blocked.length} with issues</span>}
            </p>
          )}

          {rows.length > 0 && (
            <div className="max-h-[40vh] overflow-y-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr className="text-left text-muted-foreground">
                    <th className="px-2.5 py-1.5 font-semibold">Employee</th>
                    <th className="px-2.5 py-1.5 font-semibold">Carry forward</th>
                    <th className="px-2.5 py-1.5 font-semibold">Balance</th>
                    <th className="px-2.5 py-1.5 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-2.5 py-1.5">
                        <div className="max-w-[12rem] truncate font-medium text-foreground">{r.employee_name}</div>
                        <div className="text-[10px] text-muted-foreground">{r.epfRaw || '—'}{r.company_name ? ` · ${r.company_name}` : ''}</div>
                      </td>
                      <td className="px-2.5 py-1.5 tabular-nums">
                        {r.issue ? (
                          <span className="text-muted-foreground">{r.balanceRaw || '—'}</span>
                        ) : (
                          <span className={r.amount < 0 ? 'font-semibold text-destructive' : r.amount > 0 ? 'font-semibold text-success' : 'text-muted-foreground'}>
                            {r.amount > 0 ? '+' : ''}{formatSuspenseAmount(r.amount, r.currency)}
                          </span>
                        )}
                      </td>
                      <td className="px-2.5 py-1.5 tabular-nums">
                        {r.issue || r.action === 'unchanged' ? '—' : (
                          <span className="inline-flex items-center gap-1">
                            <span className="text-muted-foreground">
                              {r.current === null ? 'no account' : formatSuspenseAmount(r.current, r.currency)}
                            </span>
                            <ArrowRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                            <span className={`font-semibold ${r.resulting < 0 ? 'text-destructive' : 'text-foreground'}`}>
                              {formatSuspenseAmount(r.resulting, r.currency)}
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="px-2.5 py-1.5">
                        {r.issue ? (
                          <span className="inline-flex items-center gap-1 text-destructive">
                            <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                            <span className="max-w-[13rem] truncate">{r.issue}</span>
                          </span>
                        ) : r.action === 'unchanged' ? (
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <Minus className="h-3 w-3 flex-shrink-0" /> Nothing to carry
                          </span>
                        ) : r.alreadyCarried ? (
                          <span className={`inline-flex items-center gap-1 ${allowRepeat ? 'text-warning' : 'text-muted-foreground'}`}>
                            <RotateCcw className="h-3 w-3 flex-shrink-0" />
                            {allowRepeat ? `Repeating ${period}` : `Already carried ${period}`}
                          </span>
                        ) : r.action === 'open' ? (
                          <span className="inline-flex items-center gap-1 text-warning">
                            <AlertTriangle className="h-3 w-3 flex-shrink-0" /> Opens account
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-success">
                            <Check className="h-3 w-3 flex-shrink-0" /> Ready
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Only offered once a repeat is actually in the sheet — an override with nothing to
              override is just a way to arm a foot-gun in advance. */}
          {repeats.length > 0 && (
            <label className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/5 p-3">
              <Checkbox checked={allowRepeat} disabled={saving} onCheckedChange={v => setAllowRepeat(v === true)} className="mt-0.5" />
              <span className="text-[11px] text-muted-foreground">
                <span className="block font-semibold text-foreground">
                  Apply the {repeats.length} account{repeats.length === 1 ? '' : 's'} that already took {period}
                </span>
                They were carried forward for this period before. Applying again ADDS the amounts a second
                time — only tick this if the first run has since been reversed.
              </span>
            </label>
          )}

          {rows.length > 0 && (
            <div>
              <Label className="mb-1.5 block text-xs font-semibold text-muted-foreground">Ledger note</Label>
              <Input value={note} disabled={saving} onChange={e => setNote(e.target.value)}
                placeholder={`Carried forward from ${period || 'the previous period'}${fileName ? ` · ${fileName}` : ''}`} />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Written against every entry this upload creates — say where the figures came from.
              </p>
            </div>
          )}

          {blocked.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              Rows with issues are ignored — fix them in the sheet and re-upload, or apply the rest.
            </p>
          )}

          {failures.length > 0 && (
            <div className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-[11px] text-muted-foreground">
              <div className="font-semibold text-destructive">{failures.length} didn&apos;t apply — still listed above, retry when ready</div>
              {failures.map((f, i) => <div key={i}>{f.name}: {f.message}</div>)}
            </div>
          )}

          {progress && (
            <p className="text-[11px] text-muted-foreground">Applying {progress.done} of {progress.total}…</p>
          )}

          <DialogFooter>
            <Button variant="outline" className="flex-1" onClick={close} disabled={saving}>Cancel</Button>
            <Button className="flex-1" disabled={saving || parsing || !asAt || importable.length === 0} onClick={() => setConfirming(true)}>
              {saving
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Applying…</>
                : <><Check className="w-4 h-4" /> Carry forward {importable.length || ''} account{importable.length === 1 ? '' : 's'}</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmModal
        open={confirming}
        onOpenChange={() => setConfirming(false)}
        variant="warning"
        title={`Carry ${period} into ${importable.length} account${importable.length === 1 ? '' : 's'}?`}
        description={
          `Each amount is ADDED to the account's current balance (negatives reduce it) and recorded in its ledger.`
          + ` Net movement ${netTotal > 0 ? '+' : ''}${formatSuspenseAmount(netTotal, currency)}.`
          + (opening.length ? ` ${opening.length} account${opening.length === 1 ? '' : 's'} will be opened.` : '')
          + (unchanged.length ? ` ${unchanged.length} carry nothing and are left alone.` : '')
          + (repeats.length && !allowRepeat ? ` ${repeats.length} already took ${period} and are held back.` : '')
          + (repeats.length && allowRepeat ? ` ${repeats.length} already took ${period} and will take it AGAIN.` : '')
        }
        confirmText="Carry forward"
        busy={saving}
        onConfirm={async () => { setConfirming(false); await apply(); }}
      />
    </>
  );
}
