'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import Portal from '@/components/Portal';
import {
  ArrowLeft,
  Upload,
  Download,
  FileSpreadsheet,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  RotateCcw,
  Trash2,
  Pencil,
  Save,
  X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { tenant, auth } from '@/lib/firebase';
import { useUserCapabilities, useRoles } from '@/store/rolesStore';
import { useT } from '@/store/appStore';
import { roleCan } from '@/lib/permissions';
import {
  USERS_IMPORT_COLUMNS,
  downloadUsersImportTemplate,
} from '@/lib/usersImportTemplate';
import {
  parseUsersImportWorkbook,
  buildImportDraftRows,
  MissingHeadersError,
  type ImportRowDraft,
} from '@/lib/usersImportParse';
import { getAllUsers, findUserByField, normalizeEpf } from '@/services/userService';
import { getCompanies } from '@/services/companyService';
import { getDepartments } from '@/services/departmentService';
import {
  isValidEmail,
  isValidNIC,
  isValidLocalPhone,
  sanitizeNICInput,
  sanitizePhoneInput,
} from '@/lib/validation';
import type { AppUser, Company, Department } from '@/lib/types';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import Select from '@/components/Select';
import ConfirmModal from '@/components/ConfirmModal';
import InlineError from '@/components/InlineError';
import Pagination from '@/components/Pagination';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { PageHeaderSkeleton, ListSkeleton } from '@/components/ui/Skeleton';
import { PageTransition, Reveal } from '@/components/ui/motion';

const GENDER_OPTIONS = ['Male', 'Female'] as const;

type RowResult = { status: 'created' | 'updated' | 'error'; message?: string };
type FieldKey = keyof ImportRowDraft;
// Fields another employee already on file (a different EPF) can't share — checked against
// both the rest of this sheet and the existing Users collection.
type UniqueField = 'epf_number' | 'employee_number' | 'nic' | 'email' | 'phone_personal';

// Reached from /users via its "Import Users" button. Southernlanka (carecode.org) only — see
// the isSouthernlanka gate on the button in ../page.tsx. Bounce any other tenant (e.g. a
// stale bookmark) straight back to /users.
export default function BulkAddUsersPage() {
  const isSouthernlanka = tenant.id === 'southernlanka';
  const caps = useUserCapabilities();
  const { roles } = useRoles();
  const t = useT();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [loadingLists, setLoadingLists] = useState(true);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [existingUsers, setExistingUsers] = useState<AppUser[]>([]);

  const [parsing, setParsing] = useState(false);
  const [rows, setRows] = useState<ImportRowDraft[]>([]);
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [importing, setImporting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [liveChecking, setLiveChecking] = useState(false);
  const [liveConflicts, setLiveConflicts] = useState<Partial<Record<UniqueField, AppUser>>>({});
  // Auto-set after any import run that has at least one failure — narrows the table to just
  // those rows so they're not lost among everything that already succeeded. Cleared on a new
  // upload/Start Over, or manually via the "Show All Rows" button once failures are dealt with.
  const [failedOnlyFilter, setFailedOnlyFilter] = useState(false);
  // Pending destructive action awaiting confirmation in <ConfirmModal>: discard one staged
  // row, or the whole sheet. Nothing here is saved yet, so both are local-only.
  const [pendingAction, setPendingAction] = useState<
    | { kind: 'removeRow'; id: string; label: string }
    | { kind: 'startOver' }
    | null
  >(null);

  useEffect(() => {
    if (!isSouthernlanka) { router.replace('/users'); return; }
    (async () => {
      setLoadingLists(true);
      try {
        const [c, d, u] = await Promise.all([
          getCompanies(),
          getDepartments(),
          getAllUsers(undefined, true),
        ]);
        setCompanies(c);
        setDepartments(d);
        setExistingUsers(u);
      } catch (e) {
        console.error(e);
        toast.error('Failed to load companies/departments/users');
      } finally {
        setLoadingLists(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSouthernlanka]);

  const activeRoles = useMemo(() => roles.filter((r) => r.is_active !== false), [roles]);

  // The row currently open in the edit modal — kept as a plain lookup (not the `editingRow`
  // used by the JSX further down) so it's available up here, above the early returns, for the
  // debounced live-check effect below (hooks can't come after a conditional return).
  const editingRowForCheck = editingId ? rows.find((r) => r.id === editingId) : undefined;

  // Debounced live re-check against Firestore for the row open in the edit modal. The
  // duplicate/"already used" check in computeFieldIssues below only reads the `existingUsers`
  // snapshot fetched when this page loaded — correct for the common case, but it can go stale
  // if another admin added/edited a user since. This re-verifies EPF/Employee No/NIC/Email/
  // Contact Number against the database itself shortly after typing stops, rather than on
  // every keystroke.
  useEffect(() => {
    if (!editingRowForCheck) { setLiveConflicts({}); setLiveChecking(false); return; }
    const row = editingRowForCheck;
    let cancelled = false;
    setLiveChecking(true);
    const timer = setTimeout(async () => {
      try {
        const fields: UniqueField[] = ['epf_number', 'employee_number', 'nic', 'email', 'phone_personal'];
        const entries = await Promise.all(fields.map(async (field) => {
          const value = row[field].trim();
          if (!value) return [field, undefined] as const;
          const found = await findUserByField(field, value);
          // Excludes the row's own record (matched by EPF, normalized the same way
          // createUser/epfDocId key the Firestore doc — see the comment on `epf` in
          // runImport below) — editing yourself back to your own current value must never
          // read as a conflict.
          if (!found || normalizeEpf(found.epf_number).toLowerCase() === normalizeEpf(row.epf_number).toLowerCase()) {
            return [field, undefined] as const;
          }
          return [field, found] as const;
        }));
        if (cancelled) return;
        setLiveConflicts(Object.fromEntries(entries.filter(([, v]) => v)) as Partial<Record<UniqueField, AppUser>>);
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) setLiveChecking(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [
    editingRowForCheck?.id,
    editingRowForCheck?.epf_number,
    editingRowForCheck?.employee_number,
    editingRowForCheck?.nic,
    editingRowForCheck?.email,
    editingRowForCheck?.phone_personal,
  ]);

  const handleDownloadTemplate = async () => {
    try {
      await downloadUsersImportTemplate();
    } catch (e) {
      console.error(e);
      toast.error('Failed to generate the template');
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file after a fix
    if (!file) return;
    setParsing(true);
    try {
      const raw = await parseUsersImportWorkbook(file);
      if (!raw.length) {
        toast.error("No data rows found — fill in a row below the header and try again.");
        return;
      }
      const built = buildImportDraftRows(raw, companies, departments, roles);
      setRows(built);
      setResults({});
      setPage(1);
      setFailedOnlyFilter(false);
      // Surface duplicates immediately, right when the file loads — the per-row table below
      // still carries the specifics, but this can't be scrolled past or missed.
      const dupFields: UniqueField[] = ['epf_number', 'employee_number', 'nic', 'email', 'phone_personal'];
      let dupCount = 0;
      for (const field of dupFields) {
        const seen = new Map<string, number>();
        for (const r of built) {
          const v = r[field].trim().toLowerCase();
          if (v) seen.set(v, (seen.get(v) ?? 0) + 1);
        }
        for (const n of seen.values()) if (n > 1) dupCount++;
      }
      if (dupCount > 0) {
        toast.error(
          `${dupCount} duplicate value${dupCount === 1 ? '' : 's'} found across EPF/Employee No/NIC/Email/Contact Number — check the red rows below.`,
          { duration: 7000 },
        );
      }
    } catch (e) {
      console.error(e);
      if (e instanceof MissingHeadersError) {
        // Nothing is set here — rows/results are left exactly as they were, so a bad file
        // never partially loads.
        toast.error(`This sheet is missing column(s): ${e.missingHeaders.join(', ')}. Download the template from Step 1 and use it as-is.`);
      } else {
        toast.error("Couldn't read that file — make sure it's an .xlsx/.csv built from the template.");
      }
    } finally {
      setParsing(false);
    }
  };

  // Set on any inline field edit in the review modal; drives the "Row updated" toast shown
  // when that modal closes (edits apply live via updateRow, so this is the acknowledgement).
  const editedRef = useRef(false);

  const updateRow = (id: string, patch: Partial<ImportRowDraft>) => {
    editedRef.current = true;
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
    if (editingId === id) setEditingId(null);
    toast.success('Row removed from the import');
  };
  const openEdit = (id: string) => { editedRef.current = false; setEditingId(id); };
  const closeEdit = () => {
    if (editedRef.current) toast.success('Row updated');
    editedRef.current = false;
    setEditingId(null);
  };
  const startOver = () => {
    setRows([]); setResults({}); setEditingId(null); setPage(1); setFailedOnlyFilter(false);
  };

  // ─── Duplicate detection ────────────────────────────────────────────────────────────
  // Values repeated more than once within the sheet itself, per field — every row sharing
  // the value is blocked until it's fixed (which one is "right" isn't decidable here).
  const duplicateSets = useMemo(() => {
    const build = (pick: (r: ImportRowDraft) => string) => {
      const counts = new Map<string, number>();
      for (const r of rows) {
        const v = pick(r).trim().toLowerCase();
        if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([v]) => v));
    };
    return {
      epf_number: build((r) => r.epf_number),
      employee_number: build((r) => r.employee_number),
      nic: build((r) => r.nic),
      email: build((r) => r.email),
      phone_personal: build((r) => r.phone_personal),
    } satisfies Record<UniqueField, Set<string>>;
  }, [rows]);

  // A field value that already belongs to a DIFFERENT existing employee — e.g. two different
  // people ending up with the same NIC. Excludes this row's own record (matched by EPF) so a
  // normal update against yourself never reads as a conflict.
  const conflictingUser = (row: ImportRowDraft, field: UniqueField): AppUser | undefined => {
    const v = row[field].trim().toLowerCase();
    if (!v) return undefined;
    return existingUsers.find((u) => {
      if (normalizeEpf(u.epf_number).toLowerCase() === normalizeEpf(row.epf_number).toLowerCase()) return false;
      return (u[field] ?? '').toString().trim().toLowerCase() === v;
    });
  };

  // Per-field error messages for one row — drives both the red table cells and the small
  // message printed under each one. Any entry here blocks that row from being imported.
  const computeFieldIssues = (row: ImportRowDraft): Partial<Record<FieldKey, string[]>> => {
    const out: Partial<Record<FieldKey, string[]>> = {};
    const add = (key: FieldKey, msg: string) => { (out[key] ??= []).push(msg); };
    const dupe = (field: UniqueField, label: string) => {
      if (duplicateSets[field].has(row[field].trim().toLowerCase())) add(field, `Duplicate ${label} in this sheet`);
      const conflict = conflictingUser(row, field);
      if (conflict) add(field, `Already used by ${conflict.display_name} (${conflict.epf_number})`);
    };

    if (!row.epf_number.trim()) add('epf_number', 'Required');
    else dupe('epf_number', 'EPF Number');

    if (!row.employee_number.trim()) add('employee_number', 'Required');
    else dupe('employee_number', 'Employee No');

    const roleObj = activeRoles.find((r) => r.name === row.role);
    const isEmployeeRole = roleObj ? roleCan(roleObj.name, 'is_employee', roles) : true;
    // Same shared format rules as the single-user Create/Edit form and /register
    // (src/lib/validation.ts) — NIC must be 12 digits or 9 digits + V/X; email must be a
    // real address with a TLD; a contact number must be exactly 10 digits starting with 0.
    // Trailing junk like "…mmm" is rejected (the check does NOT strip non-digits first).
    if (!row.nic.trim()) { if (isEmployeeRole) add('nic', 'Required for this role'); }
    else {
      if (!isValidNIC(row.nic.trim())) add('nic', 'Invalid NIC — 12 digits, or 9 digits followed by V/X');
      dupe('nic', 'ID Number');
    }

    if (row.email.trim()) {
      if (!isValidEmail(row.email.trim())) add('email', 'Not a valid email address');
      dupe('email', 'Email');
    }

    // Not required — southernlanka signs in with email or Employee No, never phone (see
    // src/lib/phone.ts). Still validated/dupe-checked when a value IS entered, same as Email
    // just above.
    if (row.phone_personal.trim()) {
      if (!isValidLocalPhone(row.phone_personal.trim())) add('phone_personal', 'Must be exactly 10 digits, starting with 0');
      dupe('phone_personal', 'Contact Number');
    }

    if (row.guardian_contact.trim() && !isValidLocalPhone(row.guardian_contact.trim())) {
      add('guardian_contact', 'Must be exactly 10 digits, starting with 0');
    }

    // Not required — a self-onboarded/imported account may not have a confirmed joining
    // date yet.

    if (!row.first_name.trim() || !row.last_name.trim())
      add('full_name', "Couldn't work out First/Last Name — check Full Name or Name with Initials");
    if (!row.full_name.trim()) add('full_name', 'Required');
    if (!row.name_with_initials.trim()) add('name_with_initials', 'Required');
    if (!GENDER_OPTIONS.includes(row.gender as (typeof GENDER_OPTIONS)[number])) add('gender', 'Must be Male or Female');
    if (row.company_id && !companies.some((c) => c.id === row.company_id))
      add('company_id', `"${row.company_id}" wasn't found — pick one or clear it`);
    if (row.role && !activeRoles.some((r) => r.name === row.role))
      add('role', `"${row.role}" wasn't found — pick one or clear it`);
    // Date of Birth is left optional — some employees on the real payroll have no birthdate
    // on file, and forcing one here would just block an otherwise-clean row.

    return out;
  };

  const rowHasIssues = (row: ImportRowDraft) => Object.keys(computeFieldIssues(row)).length > 0;

  const readyRows = rows.filter((r) => !results[r.id] && !rowHasIssues(r));
  const failedRows = rows.filter((r) => results[r.id]?.status === 'error');
  const needsAttentionCount = rows.filter((r) => !results[r.id] && rowHasIssues(r)).length;

  // Creating 100+ Firebase Auth accounts back-to-back from the BROWSER used to trip
  // Firebase's account-creation abuse/velocity protection (auth/too-many-requests)
  // partway through a large sheet — reproducibly ("first ~100 succeed, the rest fail, and
  // keep failing on every retry" — the block persists, it isn't a simple per-request rate
  // limit). Account creation now happens server-side (see /api/users/bulk-import), under
  // the project's own service-account quota, which isn't subject to that browser-session
  // guard. Rows are sent in small chunks so each server invocation stays well within a
  // serverless function's execution time budget.
  const BULK_IMPORT_CHUNK_SIZE = 20;

  const runImport = async (targetRows: ImportRowDraft[]) => {
    if (!targetRows.length) return;
    const idToken = await auth.currentUser?.getIdToken().catch(() => null);
    if (!idToken) {
      toast.error('Your session has expired — please sign in again.');
      return;
    }
    setImporting(true);
    let created = 0, updated = 0, failed = 0;

    for (let i = 0; i < targetRows.length; i += BULK_IMPORT_CHUNK_SIZE) {
      const chunk = targetRows.slice(i, i + BULK_IMPORT_CHUNK_SIZE);
      try {
        const res = await fetch('/api/users/bulk-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idToken,
            rows: chunk.map((row) => ({
              id: row.id,
              epf_number: row.epf_number,
              employee_number: row.employee_number,
              email: row.email,
              first_name: row.first_name,
              last_name: row.last_name,
              role: row.role,
              department: row.department,
              company_id: row.company_id,
              phone_personal: row.phone_personal,
              address: row.address,
              nic: row.nic,
              date_of_birth: row.date_of_birth,
              date_of_join: row.date_of_join,
              full_name: row.full_name,
              name_with_initials: row.name_with_initials,
              gender: row.gender,
              guardian_contact: row.guardian_contact,
            })),
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !Array.isArray(json?.results)) {
          throw new Error(json?.error || `Server error (${res.status})`);
        }
        const resultsById = new Map<string, { status: 'created' | 'updated' | 'error'; message?: string }>(
          (json.results as Array<{ id: string; status: 'created' | 'updated' | 'error'; message?: string }>)
            .map((r) => [r.id, { status: r.status, message: r.message }]),
        );
        setResults((prev) => {
          const next = { ...prev };
          for (const row of chunk) {
            const r = resultsById.get(row.id);
            next[row.id] = r ?? { status: 'error', message: 'No result returned' };
          }
          return next;
        });
        for (const row of chunk) {
          const status = resultsById.get(row.id)?.status;
          if (status === 'created') created++;
          else if (status === 'updated') updated++;
          else failed++;
        }
      } catch (e: unknown) {
        // The whole chunk failed before any per-row result came back (network error, 401,
        // 403, etc.) — mark every row in it as failed with that reason so none silently
        // vanish from the table.
        console.error(e);
        failed += chunk.length;
        const message = (e as Error)?.message || 'Failed to save';
        setResults((prev) => {
          const next = { ...prev };
          for (const row of chunk) next[row.id] = { status: 'error', message };
          return next;
        });
      }
    }

    setImporting(false);
    if (created || updated) {
      try { setExistingUsers(await getAllUsers(undefined, true)); } catch { /* non-fatal */ }
    }
    if (failed) {
      toast.error(`${created} created, ${updated} updated, ${failed} failed`);
      setFailedOnlyFilter(true); // narrow the table to the failures so they're easy to find
    } else {
      toast.success(`${created} created, ${updated} updated`);
    }
  };

  if (!isSouthernlanka) return null;

  if (caps && !caps.can_manage_users) {
    return (
      <div className="text-muted-foreground p-10 text-center">
        {t.noAccessSection}
      </div>
    );
  }

  if (loadingLists) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <ListSkeleton rows={4} />
      </div>
    );
  }

  const editingRow = editingId ? rows.find((r) => r.id === editingId) ?? null : null;

  // Every active department in the system — the import-review editor is a correction tool,
  // so an admin must be able to reassign a row to ANY department, not just ones whose
  // `company_id` happens to match the (possibly wrong / unset) company on the imported row.
  // Company is kept as a sublabel for context; `allowCustom` on the picker keeps a typed
  // value that isn't in the list.
  const departmentOptions = departments
    .filter((d) => d.is_active)
    .map((d) => ({ value: d.name, label: d.name, sublabel: d.company_name }));
  // Role is independent of Department entirely (Roles carry no department scoping of their
  // own) — every active role is always offered, regardless of the row's department.
  const roleOptionsFor = (_row: ImportRowDraft) =>
    activeRoles.map((r) => ({ value: r.name, label: r.name }));

  // Review table order: rows needing attention first (most urgent), then Updates, then New
  // records, and anything already saved last (it's done, no longer needs eyes on it). Stable
  // sort keeps each group in its original sheet order.
  const rowPriority = (row: ImportRowDraft): number => {
    if (results[row.id]) return 3;
    if (rowHasIssues(row)) return 0;
    const isUpdate = existingUsers.some((u) => normalizeEpf(u.epf_number) === normalizeEpf(row.epf_number));
    return isUpdate ? 1 : 2;
  };
  const sortedRows = [...rows].sort((a, b) => rowPriority(a) - rowPriority(b));
  // Narrowed to just the failures after a run that had any — see setFailedOnlyFilter above.
  // Falls back to the full list on its own once there's nothing left to narrow to (e.g. every
  // failure got retried successfully), so it never strands the view on an empty table.
  const visibleRows = failedOnlyFilter && failedRows.length > 0
    ? sortedRows.filter((r) => results[r.id]?.status === 'error')
    : sortedRows;
  const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  const safePage = Math.min(page, totalPages); // stays in range if rows shrink (e.g. after Delete)
  const paginatedRows = visibleRows.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <PageTransition className="space-y-6">
      <div className="space-y-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/users')}
          className="-ml-2 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4" />
          {t.userManagement}
        </Button>
        <PageHeader
          title="Import Users"
          description="Bulk-add or update employees from a CSV or Excel sheet."
          icon={Upload}
        />
      </div>

      {/* Step 1 — download the template */}
      <Reveal>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Step 1 · Download the template</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Download the Excel template below, fill in one row per employee, then upload it
              in Step 2.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {USERS_IMPORT_COLUMNS.map((c) => (
                <span
                  key={c.header}
                  className="px-2 py-1 rounded-md bg-muted text-[11px] font-medium text-muted-foreground border border-border"
                >
                  {c.header}
                </span>
              ))}
            </div>
            <Button onClick={handleDownloadTemplate}>
              <Download className="w-4 h-4" />
              Download Template
            </Button>
          </CardContent>
        </Card>
      </Reveal>

      {/* Step 2 — upload the filled sheet */}
      <Reveal delay={0.05}>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Step 2 · Upload the filled sheet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {rows.length === 0 ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Upload the filled-in template — every row will be matched against the
                  Companies, Departments and Roles already set up, and checked for required
                  fields and duplicate EPF/Employee No/NIC/Email/Contact Number, before you
                  get a chance to review and fix anything.
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={handleFileChange}
                />
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={parsing}
                >
                  {parsing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
                  {parsing ? 'Reading…' : 'Choose File'}
                </Button>
              </>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="default">{rows.length} row{rows.length === 1 ? '' : 's'}</Badge>
                  <Badge variant="success">{readyRows.length} ready</Badge>
                  {needsAttentionCount > 0 && (
                    <Badge variant="destructive">{needsAttentionCount} need attention</Badge>
                  )}
                  {Object.values(results).some((r) => r.status !== 'error') && (
                    <Badge variant="brand">
                      {Object.values(results).filter((r) => r.status === 'created').length} created ·{' '}
                      {Object.values(results).filter((r) => r.status === 'updated').length} updated
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {failedRows.length > 0 && (
                    <Button variant="outline" size="sm" onClick={() => runImport(failedRows)} disabled={importing}>
                      <RotateCcw className="w-3.5 h-3.5" /> Retry {failedRows.length} Failed
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setPendingAction({ kind: 'startOver' })} disabled={importing}>
                    <Trash2 className="w-3.5 h-3.5" /> Start Over
                  </Button>
                  <Button onClick={() => runImport(readyRows)} disabled={importing || readyRows.length === 0}>
                    {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    {importing ? 'Importing…' : `Import ${readyRows.length} User${readyRows.length === 1 ? '' : 's'}`}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </Reveal>

      {/* Step 3 — review table: red cells + a message under each invalid value */}
      {rows.length > 0 && (
        <Reveal delay={0.1}>
          <Card className="overflow-hidden">
            <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
              <CardTitle className="text-sm">Step 3 · Review before importing</CardTitle>
              <span className="text-xs font-medium text-muted-foreground">
                Red = duplicate or invalid, shown first · then Update rows · then New rows
              </span>
            </CardHeader>
            {failedOnlyFilter && failedRows.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 bg-destructive/5 border-y border-destructive/20">
                <span className="text-xs font-medium text-destructive flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Showing only the {failedRows.length} row{failedRows.length === 1 ? '' : 's'} that failed to save
                </span>
                <Button variant="outline" size="sm" onClick={() => setFailedOnlyFilter(false)}>
                  Show All {rows.length} Rows
                </Button>
              </div>
            )}
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Employee No</TableHead>
                    <TableHead>ID Number</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Contact Number</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right sticky right-0 bg-card">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedRows.map((row) => {
                    const fieldIssues = computeFieldIssues(row);
                    const hasIssues = Object.keys(fieldIssues).length > 0;
                    const hasDuplicateIssue = Object.values(fieldIssues).some((msgs) =>
                      msgs?.some((m) => m.startsWith('Duplicate') || m.startsWith('Already used')),
                    );
                    const result = results[row.id];
                    const isUpdate = existingUsers.some((u) => normalizeEpf(u.epf_number) === normalizeEpf(row.epf_number));
                    const companyLabel = companies.find((c) => c.id === row.company_id)?.name ?? row.company_id;
                    const rowLocked = importing || !!result;

                    const cell = (value: string, key: FieldKey) => {
                      const msgs = fieldIssues[key];
                      return (
                        <TableCell className={`align-top ${msgs?.length ? 'bg-destructive/5' : ''}`}>
                          <div className={msgs?.length ? 'text-destructive font-medium truncate max-w-[180px]' : 'truncate max-w-[180px]'}>
                            {value || '—'}
                          </div>
                          {msgs?.map((m) => (
                            <div key={m} className="text-[10px] text-destructive mt-0.5">{m}</div>
                          ))}
                        </TableCell>
                      );
                    };

                    return (
                      <TableRow key={row.id} className={hasIssues && !result ? 'bg-destructive/5' : ''}>
                        <TableCell className="align-top">
                          <div className="text-sm font-semibold text-foreground truncate max-w-[200px]">
                            {row.full_name || row.name_with_initials || 'Unnamed row'}
                          </div>
                          <div className={`text-[11px] ${fieldIssues.epf_number?.length ? 'text-destructive' : 'text-muted-foreground'}`}>
                            EPF {row.epf_number || '—'}
                          </div>
                          {fieldIssues.epf_number?.map((m) => (
                            <div key={m} className="text-[10px] text-destructive mt-0.5">{m}</div>
                          ))}
                          {(fieldIssues.full_name || fieldIssues.name_with_initials || fieldIssues.gender || fieldIssues.date_of_birth || fieldIssues.date_of_join || fieldIssues.guardian_contact) && (
                            <div className="text-[10px] text-destructive mt-0.5">
                              {[...(fieldIssues.full_name ?? []), ...(fieldIssues.name_with_initials ?? []), ...(fieldIssues.gender ?? []), ...(fieldIssues.date_of_birth ?? []), ...(fieldIssues.date_of_join ?? []), ...(fieldIssues.guardian_contact ?? []).map((m) => `Guardian contact: ${m}`)].join(' · ')}
                            </div>
                          )}
                        </TableCell>
                        {cell(row.employee_number, 'employee_number')}
                        {cell(row.nic, 'nic')}
                        {cell(row.email, 'email')}
                        {cell(row.phone_personal, 'phone_personal')}
                        {cell(row.role, 'role')}
                        {cell(companyLabel, 'company_id')}
                        <TableCell className="align-top">
                          {result ? (
                            result.status === 'error' ? (
                              <Badge variant="destructive">{result.message ?? 'Failed'}</Badge>
                            ) : (
                              <Badge variant="success">
                                <CheckCircle2 className="w-3 h-3" />
                                {result.status === 'created' ? 'Created' : 'Updated'}
                              </Badge>
                            )
                          ) : (
                            <div className="flex flex-col items-start gap-1">
                              <Badge variant={isUpdate ? 'brand' : 'muted'}>{isUpdate ? 'Update' : 'New'}</Badge>
                              {hasIssues ? (
                                <Badge variant="destructive">
                                  <AlertTriangle className="w-3 h-3" /> {hasDuplicateIssue ? 'Duplicate' : 'Fix required'}
                                </Badge>
                              ) : (
                                <Badge variant="success">Ready</Badge>
                              )}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="align-top text-right sticky right-0 bg-card">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => openEdit(row.id)}
                              disabled={rowLocked}
                              aria-label="Edit row"
                              title="Edit row"
                              className="w-7 h-7 rounded-md hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-primary transition-colors disabled:opacity-40 disabled:pointer-events-none"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingAction({
                                kind: 'removeRow',
                                id: row.id,
                                label: row.full_name || row.name_with_initials || `EPF ${row.epf_number || '—'}`,
                              })}
                              disabled={rowLocked}
                              aria-label="Delete row"
                              title="Delete row"
                              className="w-7 h-7 rounded-md hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40 disabled:pointer-events-none"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              <div className="px-4 py-3 border-t border-border">
                <Pagination
                  page={safePage}
                  pageSize={pageSize}
                  total={visibleRows.length}
                  onPageChange={setPage}
                  onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
                />
              </div>

              {/* Repeated at the bottom too — after scrolling through a long sheet, saving
                  shouldn't require scrolling all the way back up to Step 2's toolbar. */}
              <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-t border-border">
                <span className="text-xs text-muted-foreground">
                  {readyRows.length} ready to save
                  {needsAttentionCount > 0 ? ` · ${needsAttentionCount} need attention` : ''}
                </span>
                <Button onClick={() => runImport(readyRows)} disabled={importing || readyRows.length === 0}>
                  {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {importing ? 'Saving…' : `Save ${readyRows.length} User${readyRows.length === 1 ? '' : 's'}`}
                </Button>
              </div>
            </CardContent>
          </Card>
        </Reveal>
      )}

      {/* ── Edit row modal ── Portalled to <body>: a `fixed inset-0` overlay nested inside
          PageTransition (whose enter animation leaves an active transform in place) gets its
          containing block hijacked to PageTransition's own box instead of the viewport. */}
      <Portal>
      <AnimatePresence>
        {editingRow && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeEdit}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4"
          >
            <motion.div
              initial={{ y: 60 }}
              animate={{ y: 0 }}
              exit={{ y: 60 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full sm:max-w-2xl bg-card border border-border rounded-t-3xl sm:rounded-2xl p-4 sm:p-6 space-y-5 max-h-[92vh] sm:max-h-[90vh] overflow-y-auto shadow-popover"
            >
              <div className="sm:hidden w-10 h-1 rounded-full bg-border mx-auto" />
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-base font-semibold text-foreground">
                    {editingRow.full_name || editingRow.name_with_initials || 'Edit row'}
                  </div>
                  {liveChecking && (
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-0.5">
                      <Loader2 className="w-3 h-3 animate-spin" /> Checking EPF/Employee No/NIC/Email/Contact Number against the database…
                    </div>
                  )}
                </div>
                <button
                  onClick={closeEdit}
                  className="w-8 h-8 rounded-md bg-muted hover:bg-accent border border-border flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {(() => {
                const fieldIssues = computeFieldIssues(editingRow);
                const errorField = (key: keyof ImportRowDraft, label: string) => {
                  // Only the 5 unique fields ever get a live-check entry — undefined for
                  // everything else, so this is a no-op there.
                  const liveConflict = liveConflicts[key as UniqueField];
                  const alreadyShownLocally = fieldIssues[key]?.some((m) => m.startsWith('Already used'));
                  const isPhone = key === 'phone_personal' || key === 'guardian_contact';
                  return (
                    <div key={key}>
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        {label}
                      </Label>
                      <Input
                        value={editingRow[key] as string}
                        inputMode={isPhone ? 'numeric' : undefined}
                        maxLength={isPhone ? 10 : key === 'nic' ? 12 : undefined}
                        onChange={(e) => {
                          // EPF / Employee No: strip spaces (the "SLH/E 378" vs "SLH/E378"
                          // split-identity bug). NIC / contact fields: format-constrain as typed
                          // (src/lib/validation.ts) so letters and over-length input can't get in
                          // — matching the single-user Create/Edit form's field() helper.
                          const raw = e.target.value;
                          const value =
                            key === 'epf_number' || key === 'employee_number'
                              ? raw.replace(/\s+/g, '')
                              : isPhone
                                ? sanitizePhoneInput(raw)
                                : key === 'nic'
                                  ? sanitizeNICInput(raw)
                                  : raw;
                          updateRow(editingRow.id, { [key]: value } as Partial<ImportRowDraft>);
                        }}
                        className={fieldIssues[key]?.length || liveConflict ? 'border-destructive focus-visible:ring-destructive' : ''}
                      />
                      {fieldIssues[key]?.map((m) => (
                        <InlineError key={m}>{m}</InlineError>
                      ))}
                      {liveConflict && !alreadyShownLocally && (
                        <InlineError>
                          Already used by {liveConflict.display_name} ({liveConflict.epf_number}) — just verified against the database
                        </InlineError>
                      )}
                    </div>
                  );
                };
                return (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {errorField('full_name', 'Full Name')}
                    {errorField('name_with_initials', 'Name with Initials')}
                    {errorField('first_name', 'First Name')}
                    {errorField('last_name', 'Last Name')}
                    {errorField('epf_number', 'EPF Number')}
                    {errorField('employee_number', 'Employee No')}
                    {errorField('nic', 'ID Number')}
                    {errorField('email', 'Email')}
                    {errorField('phone_personal', 'Contact Number')}
                    {errorField('guardian_contact', 'Guardian Contact')}
                    <div className="sm:col-span-2">{errorField('address', 'Address')}</div>

                    <div>
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        Date Of Join
                      </Label>
                      <Input
                        type="date"
                        value={editingRow.date_of_join}
                        onChange={(e) => updateRow(editingRow.id, { date_of_join: e.target.value })}
                        className={`[color-scheme:dark] ${fieldIssues.date_of_join?.length ? 'border-destructive' : ''}`}
                      />
                      {fieldIssues.date_of_join?.map((m) => (
                        <InlineError key={m}>{m}</InlineError>
                      ))}
                    </div>
                    <div>
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        Date of Birth
                      </Label>
                      <Input
                        type="date"
                        value={editingRow.date_of_birth}
                        onChange={(e) => updateRow(editingRow.id, { date_of_birth: e.target.value })}
                        className={`[color-scheme:dark] ${fieldIssues.date_of_birth?.length ? 'border-destructive' : ''}`}
                      />
                      {fieldIssues.date_of_birth?.map((m) => (
                        <InlineError key={m}>{m}</InlineError>
                      ))}
                    </div>
                    <div>
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        Gender
                      </Label>
                      <Select
                        value={editingRow.gender}
                        onChange={(v) => updateRow(editingRow.id, { gender: v })}
                        options={GENDER_OPTIONS.map((g) => ({ value: g, label: g }))}
                        placeholder="Select…"
                      />
                      {fieldIssues.gender?.map((m) => (
                        <InlineError key={m}>{m}</InlineError>
                      ))}
                    </div>
                    <div>
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        Branch(Company)
                      </Label>
                      <Select
                        value={editingRow.company_id}
                        onChange={(v) => updateRow(editingRow.id, { company_id: v })}
                        options={companies.map((c) => ({ value: c.id, label: c.name }))}
                        searchable
                        placeholder="Select…"
                      />
                      {fieldIssues.company_id?.map((m) => (
                        <InlineError key={m}>{m}</InlineError>
                      ))}
                    </div>
                    <div>
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        Department(Category)
                      </Label>
                      <Select
                        value={editingRow.department}
                        onChange={(v) => updateRow(editingRow.id, { department: v })}
                        options={departmentOptions}
                        searchable
                        allowCustom
                        placeholder="Select…"
                      />
                    </div>
                    <div>
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        Designation(Role)
                      </Label>
                      <Select
                        value={editingRow.role}
                        onChange={(v) => updateRow(editingRow.id, { role: v })}
                        options={roleOptionsFor(editingRow)}
                        searchable
                        placeholder="Select…"
                      />
                      {fieldIssues.role?.map((m) => (
                        <InlineError key={m}>{m}</InlineError>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {(() => {
                const n = Object.keys(computeFieldIssues(editingRow)).length;
                if (!n) return null;
                return (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                    <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                    <span>
                      This row has {n} unresolved issue{n === 1 ? '' : 's'} — fix {n === 1 ? 'it' : 'them'} to include it in the import.
                    </span>
                  </div>
                );
              })()}

              <Button className="w-full" onClick={closeEdit}>
                Done
              </Button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </Portal>

      {/* Standardised destructive-action confirmation (replaces window.confirm). */}
      <ConfirmModal
        open={pendingAction !== null}
        onOpenChange={() => setPendingAction(null)}
        variant="danger"
        title={pendingAction?.kind === 'startOver' ? 'Discard this import?' : 'Remove this row?'}
        description={
          pendingAction?.kind === 'startOver'
            ? `All ${rows.length} staged row${rows.length === 1 ? '' : 's'} and any review edits will be cleared. Nothing has been saved yet.`
            : pendingAction
              ? `“${pendingAction.label}” will be removed from this import. It has not been saved.`
              : undefined
        }
        confirmText={pendingAction?.kind === 'startOver' ? 'Discard all' : 'Remove'}
        onConfirm={() => {
          if (pendingAction?.kind === 'startOver') startOver();
          else if (pendingAction?.kind === 'removeRow') removeRow(pendingAction.id);
          setPendingAction(null);
        }}
      />
    </PageTransition>
  );
}
