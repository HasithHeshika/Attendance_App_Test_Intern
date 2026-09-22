'use client';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  KeyRound, RefreshCw, Trash2, ChevronDown, AlertTriangle, ShieldCheck, Database, Search,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { auth } from '@/lib/firebase';
import { useT } from '@/store/appStore';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import Pagination from '@/components/Pagination';
import ConfirmModal from '@/components/ConfirmModal';

export type OrphanAuthAccount = {
  uid:           string;
  email:         string | null;
  displayName:   string | null;
  providers:     string[];
  emailVerified: boolean;
  disabled:      boolean;
  createdAt:     string | null;
  lastSignInAt:  string | null;
};

/** One tenant database the server consulted, straight from the scan response. */
type DbScan = { dbId: string; label: string; profiles: number; ok: boolean };

type ScanMeta = {
  totalAuth: number;
  profiles:  number;
  truncated: boolean;
  databases: DbScan[];
  snapshot:  boolean;
};

/** A scan error, carrying the databases the server could not read when it names them. */
type ScanError = Error & { failedDatabases?: string[] };

const PROVIDER_LABEL: Record<string, string> = {
  password: 'Password',
  'google.com': 'Google',
  'microsoft.com': 'Microsoft',
  phone: 'Phone',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Firebase Auth accounts with no matching employee profile — typically left behind when a
 * user create failed after the login account was already provisioned, or when a profile was
 * hard-deleted from Firestore. Listing and deleting both run server-side (Admin SDK).
 *
 * Kept out of the users table on purpose: these have no EPF, no role and no company, so they
 * aren't employees — they're stray credentials.
 */
export default function OrphanAuthPanel() {
  const tr = useT();
  const [open,      setOpen]      = useState(false);
  const [scanned,   setScanned]   = useState(false);
  const [loading,   setLoading]   = useState(false);
  const [rows,      setRows]      = useState<OrphanAuthAccount[]>([]);
  const [meta,      setMeta]      = useState<ScanMeta | null>(null);
  const [error,     setError]     = useState<string | null>(null);
  const [selected,  setSelected]  = useState<Set<string>>(new Set());
  const [deleting,  setDeleting]  = useState(false);
  const [confirmUids, setConfirmUids] = useState<string[] | null>(null);
  const [page,      setPage]      = useState(1);
  const [pageSize,  setPageSize]  = useState(10);
  const [query,     setQuery]     = useState('');

  // Filtering is client-side because the whole orphan list is already in memory — the scan
  // walks the entire Auth pool once, so looking one address up must not cost another walk.
  // uid and display name are matched too: an admin chasing a specific account often has the
  // uid from a log line, and plenty of these rows have no email at all.
  const q = query.trim().toLowerCase();
  const filtered = q
    ? rows.filter(r =>
        (r.email ?? '').toLowerCase().includes(q) ||
        (r.displayName ?? '').toLowerCase().includes(q) ||
        r.uid.toLowerCase().includes(q))
    : rows;

  // Clamp after a delete empties the last page, or after a search shrinks the list. Derived
  // `safePage` drives the slice so the list never blanks for a frame while state catches up.
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage   = Math.min(page, totalPages);
  useEffect(() => { if (page !== safePage) setPage(safePage); }, [page, safePage]);

  // A new search starts at the top; staying on page 4 of a one-page result reads as "no hits".
  useEffect(() => { setPage(1); }, [q]);

  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  // Selection deliberately survives a search — an admin may collect accounts across several
  // queries before deleting. That makes it possible to have accounts selected that the
  // current filter hides, so the count is shown rather than left to be discovered afterwards.
  const hiddenSelected = (() => {
    if (!q || !selected.size) return 0;
    const visible = new Set(filtered.map(r => r.uid));
    return [...selected].filter(u => !visible.has(u)).length;
  })();

  const post = async (body: Record<string, unknown>) => {
    const idToken = await auth.currentUser?.getIdToken();
    const res  = await fetch('/api/admin/orphan-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, ...body }),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error ?? tr.orphanScanFailed) as ScanError;
      if (Array.isArray(data.failedDatabases)) err.failedDatabases = data.failedDatabases;
      throw err;
    }
    return data;
  };

  // A database the server could not read gets its own message: the generic "scan failed"
  // hides the one fact that matters, which is that coverage was incomplete.
  const errorMessage = (e: unknown, fallback: string) => {
    const err = e as ScanError;
    return err?.failedDatabases?.length
      ? tr.orphanDbUnreadable.replace('{dbs}', err.failedDatabases.join(', '))
      : err?.message || fallback;
  };

  const scan = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await post({ action: 'list' });
      setRows(data.orphans ?? []);
      setMeta({
        totalAuth: data.totalAuth ?? 0,
        profiles:  data.profiles ?? 0,
        truncated: !!data.truncated,
        databases: data.databases ?? [],
        snapshot:  !!data.snapshot,
      });
      setSelected(new Set());
      setPage(1);
      setScanned(true);
    } catch (e) {
      // Drop a stale list rather than leave rows on screen that a failed scan cannot vouch for,
      // and never fall through to the "no orphans" empty state — that reads as an all-clear.
      const message = errorMessage(e, tr.orphanScanFailed);
      setRows([]);
      setMeta(null);
      setError(message);
      setScanned(true);
      toast.error(message);
    } finally { setLoading(false); }
  };

  // Scan on first expand only — listing the whole Auth pool is too costly to run on
  // every users-page load.
  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next && !scanned && !loading) void scan();
  };

  const labelForUids = (uids: string[]) =>
    uids.length === 1
      ? (rows.find(r => r.uid === uids[0])?.email ?? uids[0])
      : `${uids.length} ${tr.orphanAccountsWord}`;

  const remove = async (uids: string[]) => {
    if (!uids.length) return;
    setDeleting(true);
    try {
      const data = await post({ action: 'delete', uids });
      const deleted: string[] = data.deleted ?? [];
      const skipped: { uid: string; reason: string }[] = data.skipped ?? [];
      if (deleted.length) toast.success(tr.orphanDeleted.replace('{n}', String(deleted.length)));
      for (const s of skipped) toast.error(`${rows.find(r => r.uid === s.uid)?.email ?? s.uid}: ${s.reason}`);
      setRows(prev => prev.filter(r => !deleted.includes(r.uid)));
      setSelected(new Set());
    } catch (e) {
      toast.error(errorMessage(e, tr.orphanDeleteFailed));
    } finally { setDeleting(false); }
  };

  const toggleRow = (uid: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(uid)) next.delete(uid); else next.add(uid);
    return next;
  });

  // The header checkbox covers THIS PAGE only — selecting 30-odd logins for deletion with
  // one click on a control that shows 10 rows is too easy to do by accident. Selecting
  // every orphan is still one click away, but it's an explicit one that names the count.
  const pageUids     = pageRows.map(r => r.uid);
  const pageSelected = pageUids.filter(u => selected.has(u)).length;
  const pageState: boolean | 'indeterminate' =
    pageSelected === 0 ? false : pageSelected === pageUids.length ? true : 'indeterminate';

  const togglePage = (checked: boolean) => setSelected(prev => {
    const next = new Set(prev);
    for (const u of pageUids) { if (checked) next.add(u); else next.delete(u); }
    return next;
  });

  return (
    <Card className="border border-warning/20">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between gap-3">
          <button onClick={toggleOpen} className="flex items-center gap-3 text-left min-w-0 flex-1">
            <div className="w-9 h-9 rounded-lg bg-warning/10 flex items-center justify-center shrink-0">
              <KeyRound className="w-4 h-4 text-warning" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base flex items-center gap-2">
                {tr.orphanAuthTitle}
                {scanned && rows.length > 0 && <Badge variant="warning">{rows.length}</Badge>}
              </CardTitle>
              <div className="text-xs text-muted-foreground mt-0.5 truncate">{tr.orphanAuthDesc}</div>
            </div>
            <ChevronDown className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          {open && (
            <Button variant="outline" size="sm" onClick={scan} disabled={loading || deleting}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{tr.orphanRescan}</span>
            </Button>
          )}
        </div>
      </CardHeader>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <CardContent className="space-y-3">
              {/* Scan provenance sits ABOVE the list, not in a footnote below it: this is the
                  evidence for the claim "no employee record points to these", and it has to be
                  in front of the admin at the moment they reach for Delete. It renders in every
                  state — an empty result needs its coverage shown just as much as a full one. */}
              {meta && (
                <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
                  <div className="flex gap-2 text-[11px] text-muted-foreground">
                    <Database className="w-3.5 h-3.5 shrink-0 mt-px" />
                    <span>
                      {tr.orphanScanMeta
                        .replace('{auth}', String(meta.totalAuth))
                        .replace('{profiles}', String(meta.profiles))}
                      {meta.truncated && ` — ${tr.orphanTruncated}`}
                    </span>
                  </div>

                  {meta.databases.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] font-medium text-foreground">{tr.orphanDbsChecked}</span>
                      {meta.databases.map(d => (
                        <Badge key={d.dbId} variant="outline" className="font-normal">
                          {d.label}
                          <span className="opacity-60">{d.profiles}</span>
                        </Badge>
                      ))}
                    </div>
                  )}

                  {meta.snapshot && (
                    <div className="flex gap-2 text-[11px] text-warning">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                      <span>{tr.orphanSnapshotNote}</span>
                    </div>
                  )}
                </div>
              )}

              {loading || !scanned ? (
                <div className="py-8 text-center text-sm text-muted-foreground">{tr.orphanScanning}</div>
              ) : error ? (
                <div className="flex gap-2 rounded-lg bg-destructive/5 border border-destructive/20 p-3 text-xs text-foreground">
                  <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-px" />
                  <span>{error}</span>
                </div>
              ) : rows.length === 0 ? (
                <EmptyState icon={ShieldCheck} title={tr.orphanNoneTitle} description={tr.orphanNoneDesc} />
              ) : (
                <>
                  {/* Deleting a login is irreversible and the account may belong to a real
                      person who simply has no profile yet — say so before they click. */}
                  <div className="flex gap-2 rounded-lg bg-warning/5 border border-warning/20 p-3 text-xs text-muted-foreground">
                    <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-px" />
                    <span>{tr.orphanWarning}</span>
                  </div>

                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                      placeholder={tr.orphanSearchPlaceholder}
                      className="pl-9"
                      aria-label={tr.orphanSearchPlaceholder}
                    />
                  </div>

                  {/* Selected-but-hidden accounts would still be deleted, so name the count
                      instead of letting it surface only in the confirmation dialog. */}
                  {hiddenSelected > 0 && (
                    <div className="flex gap-2 rounded-lg bg-warning/5 border border-warning/20 p-3 text-xs text-muted-foreground">
                      <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-px" />
                      <span>{tr.orphanSelectedHidden.replace('{n}', String(hiddenSelected))}</span>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3 flex-wrap">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                        <Checkbox
                          checked={pageState}
                          onCheckedChange={c => togglePage(c === true)}
                        />
                        {tr.selectAll}
                      </label>
                      {/* Selects every account the CURRENT search matches, not every orphan —
                          the count says which, so a filtered "select all" is never a surprise. */}
                      {filtered.some(r => !selected.has(r.uid)) && (
                        <button type="button" onClick={() => setSelected(prev => new Set([...prev, ...filtered.map(r => r.uid)]))}
                          className="text-xs font-medium text-primary hover:underline">
                          {tr.orphanSelectEvery.replace('{n}', String(filtered.length))}
                        </button>
                      )}
                      {selected.size > 0 && (
                        <button type="button" onClick={() => setSelected(new Set())}
                          className="text-xs text-muted-foreground hover:underline">
                          {tr.clearAll}
                        </button>
                      )}
                    </div>
                    <Button
                      variant="destructive" size="sm"
                      disabled={!selected.size || deleting}
                      onClick={() => setConfirmUids([...selected])}
                    >
                      <Trash2 className="w-4 h-4" />
                      {tr.orphanDeleteSelected.replace('{n}', String(selected.size))}
                    </Button>
                  </div>

                  {filtered.length === 0 ? (
                    <EmptyState icon={Search} title={tr.noMatchesFound} description={tr.orphanNoMatchDesc} />
                  ) : (
                  <div className="space-y-2">
                    {pageRows.map(r => (
                      <div key={r.uid}
                        className="flex items-start gap-3 rounded-lg border border-border bg-card/40 p-3">
                        <Checkbox
                          className="mt-1"
                          checked={selected.has(r.uid)}
                          onCheckedChange={() => toggleRow(r.uid)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-foreground break-all">
                              {r.email ?? tr.orphanNoEmail}
                            </span>
                            {r.disabled && <Badge variant="muted">{tr.disabledWord}</Badge>}
                            {!r.emailVerified && r.email && <Badge variant="warning">{tr.unverifiedWord}</Badge>}
                            {r.providers.map(p => (
                              <Badge key={p} variant="outline">{PROVIDER_LABEL[p] ?? p}</Badge>
                            ))}
                          </div>
                          {r.displayName && (
                            <div className="text-xs text-muted-foreground mt-0.5">{r.displayName}</div>
                          )}
                          <div className="text-[11px] text-muted-foreground mt-1 flex gap-x-3 gap-y-0.5 flex-wrap">
                            <span>{tr.createdWord}: {fmtDate(r.createdAt)}</span>
                            <span>{tr.lastSignInWord}: {fmtDate(r.lastSignInAt)}</span>
                            <span className="font-mono opacity-70 break-all">{r.uid}</span>
                          </div>
                        </div>
                        <Button
                          variant="ghost" size="icon-sm" disabled={deleting}
                          onClick={() => setConfirmUids([r.uid])}
                          title={tr.orphanDeleteOne}
                          className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  )}

                  {filtered.length > pageSize && (
                    <Pagination
                      page={safePage}
                      pageSize={pageSize}
                      total={filtered.length}
                      onPageChange={setPage}
                      onPageSizeChange={setPageSize}
                      pageSizeOptions={[10, 25, 50]}
                    />
                  )}
                </>
              )}

            </CardContent>
          </motion.div>
        )}
      </AnimatePresence>

      <ConfirmModal
        open={!!confirmUids}
        onOpenChange={() => setConfirmUids(null)}
        variant="danger"
        title={tr.orphanDeleteOne}
        description={confirmUids ? tr.orphanDeleteConfirm.replace('{what}', labelForUids(confirmUids)) : undefined}
        confirmText={tr.deleteWord}
        busy={deleting}
        onConfirm={async () => {
          if (confirmUids) await remove(confirmUids);
          setConfirmUids(null);
        }}
      />
    </Card>
  );
}
