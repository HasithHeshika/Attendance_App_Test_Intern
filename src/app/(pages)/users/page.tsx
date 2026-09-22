'use client';
import { useState, useEffect, useRef, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import Portal from '@/components/Portal';
import {
  Users,
  Plus,
  Upload,
  Search,
  X,
  Save,
  Eye,
  Edit2,
  UserX,
  UserCheck,
  Lock,
  Mail,
  Phone,
  MapPin,
  CreditCard,
  Calendar,
  Briefcase,
  Building2,
  Shield,
  AlertTriangle,
  UserCircle,
  Fingerprint,
  Crown,
} from 'lucide-react';
import { sendPasswordResetEmail } from 'firebase/auth';
import { auth, tenant } from '@/lib/firebase';
import { createAuthUser } from '@/lib/createAuthUser';
import { generateInitialPassword } from '@/lib/initialPassword';
import { placeholderEmail, isPlaceholderEmail } from '@/lib/phone';
import {
  isValidEmail,
  isValidNIC,
  isValidLocalPhone,
  sanitizeNICInput,
  sanitizePhoneInput,
} from '@/lib/validation';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities, useRoles } from '@/store/rolesStore';
import { useCompanyContext } from '@/store/companyContextStore';
import { useT } from '@/store/appStore';
import { roleCan } from '@/lib/permissions';
import {
  getAllUsers,
  createUser,
  updateUser,
  reassignEpf,
  epfExists,
  DuplicateEpfError,
} from '@/services/userService';
import { getCompanies } from '@/services/companyService';
import { getDepartments } from '@/services/departmentService';
import Combobox from '@/components/Combobox';
import ConfirmModal from '@/components/ConfirmModal';
import InlineError from '@/components/InlineError';
import Pagination from '@/components/Pagination';
import type {
  AppUser,
  AttendanceMethod,
  Company,
  Department,
  UserRole,
} from '@/lib/types';
import { PageHeader } from '@/components/ui/page-header';
import UserSuspenseCard from '@/components/suspense/UserSuspenseCard';
import NewPasswordDialog from '@/components/users/NewPasswordDialog';
import OrphanAuthPanel from '@/components/users/OrphanAuthPanel';
import RoleFilter from '@/components/users/RoleFilter';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import UserActivityPanel from '@/components/UserActivityPanel';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  PageHeaderSkeleton,
  TableSkeleton,
  StatCardsSkeleton,
  FormSkeleton,
} from '@/components/ui/Skeleton';
import {
  PageTransition,
  Reveal,
  Stagger,
  StaggerItem,
} from '@/components/ui/motion';

const MotionTableRow = motion(TableRow);

const EMP_TYPES = ['Permanent', 'Contract', 'Trainee', 'Intern'] as const;
// Southernlanka (carecode.org) only — see the isSouthernlanka gate below.
const GENDER_OPTIONS = ['Male', 'Female'] as const;

function isResigned(d: string | null | undefined): boolean {
  if (!d) return false;
  return d <= new Date().toISOString().slice(0, 10);
}

// The four states the Status column can show, in one place, so the toolbar's status filter
// can never disagree with the badge on the row. Precedence matters: a leaving date wins over
// everything (a resigned account is resigned even if its EPF was never confirmed), and a
// pending self-registration reads as Pending rather than Inactive — /register creates it
// with is_active: false, so the plain is_active check would otherwise swallow it.
type UserStatus = 'active' | 'pending' | 'inactive' | 'resigned';

function userStatus(u: AppUser): UserStatus {
  if (isResigned(u.date_of_resign)) return 'resigned';
  if (u.awaiting_epf) return 'pending';
  return u.is_active ? 'active' : 'inactive';
}

// Order of the status dropdown: everything, then the states you act on, then the archive.
// Labels are resolved per render so a language switch re-reads them.
const STATUS_OPTIONS: {
  key: UserStatus | 'all';
  label: (t: ReturnType<typeof useT>) => string;
}[] = [
  { key: 'all', label: (t) => t.allStatuses },
  { key: 'active', label: (t) => t.statusActive },
  { key: 'pending', label: (t) => t.pending },
  { key: 'inactive', label: (t) => t.inactiveWord },
  { key: 'resigned', label: (t) => t.resignedLabel },
];

const emptyForm = {
  first_name: '',
  last_name: '',
  email: '',
  password: '',
  epf_number: '',
  employee_number: '',
  full_name: '',
  name_with_initials: '',
  gender: '',
  guardian_contact: '',
  role: 'Technician' as UserRole,
  designation: '',
  department: '',
  company_id: '',
  employee_type: 'Permanent' as 'Permanent' | 'Contract' | 'Trainee' | 'Intern',
  supervisor_epf: '',
  phone_personal: '',
  phone_office: '',
  phone_emergency: '',
  address: '',
  nic: '',
  date_of_birth: '',
  date_of_join: '',
  date_of_resign: '',
  is_shift_worker: false,
  // Southernlanka only — see the multi-select below the Department field, shown only for
  // roles carrying the is_department_head capability. Auto-cleared if the role stops being
  // HOD-capable — see the effect below.
  hod_department_ids: [] as string[],
  // No default — southernlanka requires an explicit pick (see handleSave); an
  // unset/empty array is what makes attendanceMethodChoice below show as unselected.
  attendance_methods: [] as AttendanceMethod[],
  // Southernlanka only — see AppUser.is_super_admin. A per-user override, independent of
  // the assigned Role, that grants full System Admin capabilities. Toggle shown only to
  // users who can already manage users (see canManage below).
  is_super_admin: false,
};

function UserAdminContent() {
  const router = useRouter();
  const { user: me } = useAuthStore();
  const caps = useUserCapabilities();
  const { roles } = useRoles();
  // Access tiers: a full manager (can_manage_users / System Admin) may add, edit and
  // (de)activate; a view-only role (can_view_users) may only browse the directory and
  // download per-user Summary / Daily reports. `canView` gates the whole page.
  const canManage = caps.can_manage_users;
  const canView = caps.can_manage_users || caps.can_view_users;
  // Full Name / Name with Initials / Gender / Guardian Contact are carecode.org-only
  // fields (they exist on AppUser for self-registered southernlanka accounts) — keep the
  // altavision.lk edit form exactly as it was.
  const isSouthernlanka = tenant.id === 'southernlanka';
  // Top Navbar's Global Company Selector (southernlanka only — see companyContextStore.ts).
  // For a can_manage_all_companies/is_system_admin holder this is whatever they've picked
  // there ('' if nothing yet); for anyone else it's already their own AppUser.company_id.
  // Used below to default a brand-new user's Company to the admin's current working context.
  //
  // Unlike schedule/SouthernlankaShifts/departments/attendance-view, this page's own user
  // directory (`load()` below, getAllUsers(undefined, true)) is intentionally NOT
  // company-scoped — can_manage_users has always meant org-wide visibility here, by design,
  // independent of the navbar feature entirely (companies.tsx/roles.tsx are the same shape).
  // There is no list to fail-closed on. navbarBlocked only affects the CREATE form's default
  // below: a locked admin with no company on their own profile just gets an unfilled Company
  // field (already a required, validated pick from the full company list either way — that
  // picker was never scoped to the acting admin's own company, so there's no boundary to
  // close here, only a default that can't be guessed).
  const { companyId: navbarCompanyId, blocked: navbarBlocked } = useCompanyContext();
  // Role options + tabs are sourced from the data-driven roles registry.
  const activeRoles = roles.filter((r) => r.is_active !== false);
  const ROLE_NAMES = activeRoles.map((r) => r.name);
  const tr = useT();
  // Role options for the toolbar's RoleFilter dropdown ('all' is pinned by the component
  // itself, so it is not in this list).
  const TABS: { key: string; label: string }[] = activeRoles.map((r) => ({ key: r.name, label: r.name }));
  const [users, setUsers] = useState<AppUser[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  // Southernlanka (carecode.org) only — Department becomes an admin-managed
  // Select picker instead of free text. See isSouthernlanka above and the field
  // rendering further down.
  const [departments, setDepartments] = useState<Department[]>([]);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('all');
  // Status category for the toolbar dropdown — the four values the Status column shows,
  // plus 'all'. Independent of the role filter; the two narrow the list together.
  const [statusFilter, setStatusFilter] = useState<UserStatus | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [viewUser, setViewUser] = useState<AppUser | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingEpf, setEditingEpf] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  // Required-field inline errors only appear once the user has attempted a save — a
  // freshly opened form isn't shown pre-flagged. Format errors (NIC/email/phone) still
  // surface live, since a filled-but-malformed field means the user has already typed.
  const [triedSave, setTriedSave] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [resetChecked, setResetChecked] = useState(false);
  const [resetting, setResetting] = useState(false);
  // The freshly generated password, held only until the admin has copied it out of the
  // dialog. Nothing else can show it again — the server never stores it.
  const [newPassword, setNewPassword] = useState<
    { password: string; title?: string; account: string; note: string | null } | null
  >(null);
  const [changingEmail, setChangingEmail] = useState(false);

  // `silent` re-fetches without flipping the full-page skeleton, so a mutation updates the
  // list in place instead of remounting it (which replays the entrance animations — the
  // "whole page resets" effect).
  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      // includeInactive: true — so self-registered accounts pending approval (created
      // is_active: false by /register) still show up here for review/activation.
      const [u, c, d] = await Promise.all([
        getAllUsers(undefined, true),
        getCompanies(),
        isSouthernlanka ? getDepartments() : Promise.resolve([]),
      ]);
      setUsers(u);
      setCompanies(c);
      setDepartments(d);
    } catch (e) {
      console.error(e);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  // Refetch whenever the URL's query string changes, not just on mount. This page fetches
  // its own data client-side, so if you're ALREADY on /users and click a notification
  // linking here (e.g. a new pending registration), a router.push to the same pathname is
  // normally a no-op and the list would stay stale — NotificationCenter appends a
  // cache-busting `_r` param on every click specifically so this effect re-fires.
  const searchParamsKey = useSearchParams().toString();
  const hasLoadedOnce = useRef(false);
  useEffect(() => {
    load(hasLoadedOnce.current);
    hasLoadedOnce.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParamsKey]);

  // epf → display name, for resolving leave approvers in the Activity panel without an
  // extra Firestore read (the full user list is already loaded here).
  const usersByEpf = useMemo(() => {
    const map: Record<string, string> = {};
    users.forEach(u => { if (u.epf_number) map[String(u.epf_number)] = u.display_name || String(u.epf_number); });
    return map;
  }, [users]);

  const q = search.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const filtered = users
    .filter((u) => {
      const matchTab = tab === 'all' || u.role === tab;
      const matchStatus =
        statusFilter === 'all' || userStatus(u) === statusFilter;
      if (!matchTab || !matchStatus) return false;
      if (!q) return true;
      // Null-safe: migrated users can have missing fields — `filter(Boolean)` drops
      // undefined before `.toLowerCase()`, which otherwise throws and kills all search.
      const haystack = [
        u.display_name,
        u.first_name,
        u.last_name,
        u.epf_number,
        u.employee_number,
        u.email,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      // Phone match is digit-only so spacing/dashes/leading-0 differences don't matter.
      const phoneDigits = [u.phone_personal, u.phone_office, u.phone_emergency]
        .filter(Boolean)
        .join(' ')
        .replace(/\D/g, '');
      return (
        haystack.includes(q) ||
        (qDigits.length >= 3 && phoneDigits.includes(qDigits))
      );
    })
    // Resigned employees sink to the bottom of every view — and so onto the last page of
    // the table — because they are history, not the directory you came here to browse.
    // `filter` already returned a fresh array (so `users` is untouched) and sort is stable,
    // so the display_name ordering getAllUsers established survives inside each group.
    .sort(
      (a, b) =>
        Number(isResigned(a.date_of_resign)) -
        Number(isResigned(b.date_of_resign)),
    );

  // Reset to first page whenever filters change
  useEffect(() => {
    setPage(1);
  }, [search, tab, statusFilter]);

  const paginated = filtered.slice((page - 1) * pageSize, page * pageSize);

  const tabCount = (key: string) =>
    key === 'all' ? users.length : users.filter((u) => u.role === key).length;

  const openCreate = () => {
    // Southernlanka has no "Technician" role at all (that's an altavision.lk-only role
    // name) — defaulting to it silently mis-tagged new hires, so leave Role blank instead
    // and require an explicit pick (see handleSave) rather than a wrong default. Company
    // defaults to whatever the admin currently has selected in the navbar's Global Company
    // Selector ('' if they haven't picked one, or aren't allowed to switch — see
    // navbarCompanyId above) — it's now required (see requiredErrors.company_id below), so
    // this saves a redundant re-pick for the common case of adding someone to the company
    // already in view, while still leaving it blank (forcing an explicit pick) when the
    // navbar itself has no company in context.
    setForm(isSouthernlanka ? { ...emptyForm, role: '', company_id: navbarCompanyId } : emptyForm);
    setEditingEpf(null);
    setResetChecked(false);
    setTriedSave(false);
    setShowForm(true);
  };

  const openEdit = (u: AppUser) => {
    setForm({
      first_name: u.first_name,
      last_name: u.last_name,
      // A southernlanka phone-only account has a synthesized email on file (see
      // placeholderEmail in src/lib/phone.ts) — show the field blank rather than that
      // meaningless string; the "unchanged" comparisons in handleChangeEmail/
      // handleResetPassword below re-fetch the real stored value from `users`, not `form`.
      email: isPlaceholderEmail(u.email) ? '' : u.email,
      password: '',
      epf_number: u.epf_number,
      employee_number: u.employee_number ?? '',
      full_name: u.full_name ?? '',
      name_with_initials: u.name_with_initials ?? '',
      gender: u.gender ?? '',
      guardian_contact: u.guardian_contact ?? '',
      role: u.role,
      designation: u.designation,
      department: u.department,
      company_id: u.company_id,
      employee_type: u.employee_type as (typeof emptyForm)['employee_type'],
      supervisor_epf: u.supervisor_epf ?? '',
      phone_personal: u.phone_personal,
      phone_office: u.phone_office ?? '',
      phone_emergency: u.phone_emergency ?? '',
      address: u.address,
      nic: u.nic,
      date_of_birth: u.date_of_birth ?? '',
      date_of_join: u.date_of_join ?? '',
      date_of_resign: u.date_of_resign ?? '',
      is_shift_worker: u.is_shift_worker ?? false,
      hod_department_ids: u.hod_department_ids ?? [],
      // Unset on older/migrated records (never had this required field) — leave blank so
      // the admin has to explicitly pick one, same as a brand-new record (see emptyForm).
      attendance_methods: u.attendance_methods ?? [],
      is_super_admin: u.is_super_admin ?? false,
    });
    setEditingEpf(u.epf_number);
    setResetChecked(false);
    setTriedSave(false);
    setViewUser(null);
    setShowForm(true);
  };

  const handleResetPassword = async () => {
    if (!editingEpf) return;
    setResetting(true);
    try {
      // 1. Reset the account password to the default (server-side, targets by EPF —
      //    also creates & links the auth account for migrated users who never had one).
      const idToken = await auth.currentUser?.getIdToken();
      const res = await fetch('/api/admin/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, targetEpf: editingEpf }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? tr.failedSendReset);
        return;
      }

      // 2. Also send the self-service reset link — but only when there's a real email on
      //    file. Southernlanka phone-only accounts have a synthesized address (see
      //    isPlaceholderEmail) nobody can read, so skip it rather than pretend it went out.
      let linkSent = false;
      if (form.email && !isPlaceholderEmail(form.email)) {
        try {
          await sendPasswordResetEmail(auth, form.email);
          linkSent = true;
        } catch {
          linkSent = false;
        }
      }

      // A toast would take the password away again on a timer; this dialog holds it
      // until it has actually been copied.
      setNewPassword({
        password: data.defaultPassword,
        account: form.email && !isPlaceholderEmail(form.email) ? form.email : editingEpf,
        note: linkSent ? tr.resetLinkSentTpl.replace('{email}', form.email) : null,
      });
      setResetChecked(false);
    } catch {
      toast.error(tr.failedSendReset);
    } finally {
      setResetting(false);
    }
  };

  const handleChangeEmail = async () => {
    if (!editingEpf) return;
    const newEmail = form.email.trim();
    if (!isValidEmail(newEmail)) {
      toast.error(tr.enterValidEmail);
      return;
    }
    const original = users.find((u) => u.epf_number === editingEpf)?.email;
    if (newEmail === original) {
      toast('Email unchanged', { icon: 'ℹ️' });
      return;
    }
    setChangingEmail(true);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const res = await fetch('/api/admin/update-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, targetEpf: editingEpf, newEmail }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? tr.failedUpdateEmail);
        return;
      }
      if (data.created) {
        toast.success(
          `Login account created. Default password: ${data.defaultPassword}`,
          { duration: 8000 },
        );
      } else {
        toast.success(tr.loginEmailUpdated);
      }
      await load(true);
    } catch {
      toast.error(tr.failedUpdateEmail);
    } finally {
      setChangingEmail(false);
    }
  };

  // Live duplicate hint while typing (create mode only). Matches case-insensitively
  // because the EPF is the Firestore doc id — "empav/1" and "EMPAV/1" would become two
  // separate employees. Only scans the loaded list; the authoritative check is on save.
  const epfDuplicate = !editingEpf && form.epf_number.trim()
    ? users.find(u => String(u.epf_number).trim().toLowerCase() === form.epf_number.trim().toLowerCase())
    : undefined;

  // Live, inline format validation for the identification / contact fields (see
  // src/lib/validation.ts). Each is only flagged when it holds a value — emptiness is
  // handled by the required-field checks in handleSave — so an optional field left blank
  // never shows an error, but a filled one must match its exact shape.
  //
  // NIC and phone number formats are SOUTHERNLANKA-ONLY: that's a Sri Lankan hospital, so
  // "9 digits + V/X or 12 digits" NIC and "10 digits starting 0" phone are correct there.
  // Other tenants (e.g. altavision) legitimately hold foreign / passport / alphanumeric IDs
  // and landline / international numbers, so enforcing those shapes would wrongly block or
  // corrupt their data. Email format is universal — kept for every tenant.
  const nicError =
    isSouthernlanka && form.nic.trim() && !isValidNIC(form.nic)
      ? 'Enter a valid NIC — 12 digits, or 9 digits followed by V.'
      : undefined;
  const emailError =
    form.email.trim() && !isPlaceholderEmail(form.email) && !isValidEmail(form.email)
      ? 'Enter a valid email address, e.g. name@example.com.'
      : undefined;
  const phoneError =
    isSouthernlanka && form.phone_personal.trim() && !isValidLocalPhone(form.phone_personal)
      ? 'Enter a valid 10-digit contact number, e.g. 0771234567.'
      : undefined;
  const guardianError =
    isSouthernlanka && form.guardian_contact.trim() && !isValidLocalPhone(form.guardian_contact)
      ? 'Enter a valid 10-digit contact number, e.g. 0771234567.'
      : undefined;
  const hasFieldFormatError =
    !!nicError || !!emailError || !!phoneError || !!guardianError;

  const handleSave = async () => {
    setTriedSave(true);
    const adminType = !roleCan(form.role, 'is_employee', roles);
    // Southernlanka (carecode.org) picks Company/Department/Role through the cascading
    // hierarchy below (see departmentsForForm/roleOptionsForForm) — Department stays optional
    // there (Role no longer does, see the Role check below), plus Employee Type is optional
    // for that tenant too. Company IS required there, same as every other tenant, for any
    // employee-type account (an admin-type role like System Admin still doesn't need one) —
    // see openCreate for how it defaults from the navbar's Global Company Selector.
    if (
      !form.first_name ||
      !form.last_name ||
      !form.epf_number ||
      !form.role ||
      // Not required for southernlanka — a self-registered/self-onboarded account may not
      // have a confirmed joining date yet; every other tenant still requires it.
      (!isSouthernlanka && !form.date_of_join) ||
      (!adminType && !form.company_id)
    ) {
      toast.error(tr.fillRequiredFieldsUser);
      return;
    }
    // Block save on any malformed NIC / email / contact number (errors already shown
    // inline under each field).
    if (hasFieldFormatError) {
      toast.error(
        nicError ?? emailError ?? phoneError ?? guardianError ?? 'Please correct the highlighted fields.',
      );
      return;
    }
    // Southernlanka (carecode.org) collects a fuller profile than the other tenants —
    // these fields are optional elsewhere but required here. Full Name / Name with
    // Initials / Gender / Employee Number / Personal Phone are asked of every role (see
    // the isSouthernlanka gates on the fields below, none of them scoped to
    // !formIsAdminType); NIC / Date of Birth only exist for employee-type roles, same as
    // everywhere else. Designation isn't collected for this tenant at all (dropped from the
    // form — see the !isSouthernlanka gate on the Designation field below), and
    // Company/Department/Role/Employee Type are optional (see the check above).
    if (isSouthernlanka) {
      // Personal Phone is intentionally NOT required here — southernlanka signs in with
      // email or Employee No (see src/lib/phone.ts), never phone, so this tenant has no
      // login-dependent reason to force it.
      if (
        !form.full_name ||
        !form.name_with_initials ||
        !form.gender ||
        !form.employee_number
      ) {
        toast.error(tr.fillRequiredFieldsUser);
        return;
      }
      if (
        !adminType &&
        (!form.nic ||
          !form.date_of_birth ||
          form.attendance_methods.length === 0)
      ) {
        toast.error(tr.fillRequiredFieldsUser);
        return;
      }
      // Not required — a Head of Department may be created/saved with zero departments
      // assigned yet (e.g. onboarding, or between reassignments). The Shift/Schedule pages
      // already handle this gracefully: an HOD with an empty hod_department_ids gets an
      // empty scope (no departments to manage) rather than being blocked from saving here.
    }
    setSaving(true);
    try {
      // Resolve the picked department ids to their current names for both save branches below
      // (same denormalization convention as company_name/department_name elsewhere).
      const selectedHodDepartments = departments.filter((d) => form.hod_department_ids.includes(d.id));
      if (editingEpf) {
        // A pending self-registration (see /register) is created under a placeholder EPF —
        // admin assigns the real Employee No here. Only allowed for those accounts (the
        // epf_number field is disabled/read-only for everyone else, see the `field(...)`
        // call below) since reassignEpf moves the Firestore doc and does NOT migrate any
        // attendance/leave/task/suspense history keyed by the old EPF.
        const editingUser = users.find((u) => u.epf_number === editingEpf);
        const newEpf = form.epf_number.trim();
        let targetEpf = editingEpf;
        if (editingUser?.awaiting_epf) {
          // Approving a pending registration REQUIRES swapping the placeholder for a
          // real Employee No — that's what actually clears `awaiting_epf` (via
          // reassignEpf below). Saving without changing it used to silently succeed
          // and leave the account stuck on "Pending" with no visible way to approve it.
          if (
            !newEpf ||
            newEpf === editingEpf ||
            newEpf.toUpperCase().startsWith('PENDING-')
          ) {
            toast.error(
              'Assign a real Employee No to approve this registration.',
            );
            setSaving(false);
            return;
          }
          await reassignEpf(editingEpf, newEpf);
          targetEpf = newEpf;
          setEditingEpf(newEpf);
        }

        const resigned = isResigned(form.date_of_resign);
        // Persist the denormalized company_name too — the table/detail views read
        // company_name, so updating only company_id left the displayed company stale.
        const company = companies.find((c) => c.id === form.company_id);
        await updateUser(targetEpf, {
          first_name: form.first_name,
          last_name: form.last_name,
          display_name: `${form.first_name} ${form.last_name}`,
          employee_number: form.employee_number,
          role: form.role,
          designation: form.designation,
          department: form.department,
          company_id: form.company_id,
          company_name: company?.name ?? '',
          employee_type: form.employee_type,
          supervisor_epf: form.supervisor_epf || null,
          phone_personal: form.phone_personal,
          phone_office: form.phone_office,
          phone_emergency: form.phone_emergency,
          address: form.address,
          nic: form.nic,
          date_of_birth: form.date_of_birth || null,
          date_of_join: form.date_of_join || null,
          date_of_resign: form.date_of_resign || null,
          is_shift_worker: form.is_shift_worker,
          // Resigned employees are deactivated automatically
          is_active: resigned ? false : true,
          ...(isSouthernlanka
            ? {
                full_name: form.full_name,
                name_with_initials: form.name_with_initials,
                gender: form.gender,
                guardian_contact: form.guardian_contact,
                attendance_methods: form.attendance_methods,
                hod_department_ids:   selectedHodDepartments.map((d) => d.id),
                hod_department_names: selectedHodDepartments.map((d) => d.name),
                is_super_admin: canManage && formIsHOD && form.is_super_admin,
              }
            : {}),
        });
        toast.success(
          editingUser?.awaiting_epf
            ? 'Registration approved — account activated.'
            : tr.userUpdated,
        );
      } else {
        // Email is optional for southernlanka — the employee number entered above is
        // enough to sign in (see src/lib/phone.ts), and it's already required for this
        // tenant (checked above). Everywhere else still needs a real email since there's
        // no employee-number-login fallback. Either way Firebase Auth needs SOME
        // email+password, so a skipped one is filled in with a placeholder nobody ever sees.
        const enteredEmail = form.email.trim();
        if (!enteredEmail && !isSouthernlanka) {
          toast.error(tr.emailRequired);
          return;
        }
        const accountEmail = enteredEmail || placeholderEmail();
        const epf = form.epf_number.trim();
        // Reject a duplicate EPF *before* the auth account is created — otherwise a
        // rejected create leaves an orphan Firebase Auth user behind. epfExists() reads
        // the doc by id, so it also catches deactivated/resigned employees, which the
        // loaded list (getAllUsers filters is_active) never contains.
        const clash = epfDuplicate ?? await epfExists(epf);
        if (clash) {
          toast.error(`${tr.epfAlreadyExists}${clash.display_name ? ` — ${clash.display_name}` : ''}`);
          return;
        }
        // Create the auth account on a secondary app (keeps admin signed in), with a
        // password unique to this account, and send a verification email. Generated HERE
        // rather than inside createAuthUser so the dialog below can show it — it is never
        // stored, so this is the only moment anyone sees it.
        const initialPassword = generateInitialPassword();
        const uid = await createAuthUser(accountEmail, initialPassword);
        const company = companies.find((c) => c.id === form.company_id);
        await createUser({
          uid,
          epf_number: epf,
          employee_number: form.employee_number,
          email: accountEmail,
          first_name: form.first_name,
          last_name: form.last_name,
          display_name: `${form.first_name} ${form.last_name}`,
          name_tokens: [],
          role: form.role,
          designation: form.designation,
          department: form.department,
          company_id: form.company_id,
          company_name: company?.name ?? '',
          employee_type: form.employee_type,
          supervisor_epf: form.supervisor_epf || null,
          phone_personal: form.phone_personal,
          phone_office: form.phone_office,
          phone_emergency: form.phone_emergency,
          address: form.address,
          nic: form.nic,
          date_of_birth: form.date_of_birth || null,
          date_of_join: form.date_of_join || null,
          date_of_resign: null,
          insurance: false,
          blood_type: '',
          b_card_status: false,
          avatar_url: null,
          fcm_token: null,
          is_active: true,
          is_shift_worker: form.is_shift_worker,
          ...(isSouthernlanka
            ? {
                full_name: form.full_name,
                name_with_initials: form.name_with_initials,
                gender: form.gender,
                guardian_contact: form.guardian_contact,
                attendance_methods: form.attendance_methods,
                hod_department_ids:   selectedHodDepartments.map((d) => d.id),
                hod_department_names: selectedHodDepartments.map((d) => d.name),
                is_super_admin: canManage && formIsHOD && form.is_super_admin,
              }
            : {}),
        });
        setNewPassword({
          password: initialPassword,
          title: tr.tempPasswordTitle,
          account: enteredEmail || epf,
          note: enteredEmail
            ? tr.verifyEmailSentTpl.replace('{email}', enteredEmail)
            : tr.signInWithEmpNumber,
        });
      }
      setShowForm(false);
      await load(true);
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      // Race backstop: the transaction in createUser rejects a duplicate EPF that
      // slipped past the pre-flight check above.
      if (e instanceof DuplicateEpfError) {
        toast.error(tr.epfAlreadyExists);
      } else if (code === 'auth/email-already-in-use') {
        toast.error(tr.emailAlreadyInUse);
      } else {
        console.error(e);
        toast.error(tr.failedSaveUser);
      }
    } finally {
      setSaving(false);
    }
  };

  const [confirmDeactivate, setConfirmDeactivate] = useState<AppUser | null>(null);

  const handleToggleActive = async (u: AppUser, makeActive: boolean) => {
    if (String(u.epf_number) === String(me?.epf_number)) {
      toast.error("You can't change your own account status");
      return;
    }
    try {
      await updateUser(u.epf_number, { is_active: makeActive });
      toast.success(makeActive ? 'Account activated' : tr.accountDeactivated);
      setViewUser(null);
      await load(true);
    } catch {
      toast.error(tr.failedUpdateStatus);
    }
  };

  const supervisors = users.filter(
    (u) =>
      roleCan(u.role, 'can_approve', roles) &&
      u.is_active &&
      !isResigned(u.date_of_resign),
  );

  // Only non-employee roles (System Admin) skip the employee-specific fields.
  const formIsAdminType = !roleCan(form.role, 'is_employee', roles);
  // The standalone HOD role (is_department_head capability, ticked from Roles admin) — shows
  // the "departments managed" multi-select below instead of the old single-department checkbox.
  const formIsHOD = roleCan(form.role, 'is_department_head', roles);

  // The Attendance Method field is a two-option picker over the underlying array (see
  // AppUser.attendance_methods) — 'fingerprint' means the array is just ['fingerprint'],
  // 'both' means it's ['mobile', 'fingerprint']. '' means nothing picked yet — required
  // for southernlanka (see handleSave), so this stays empty rather than defaulting.
  const attendanceMethodChoice: '' | 'fingerprint' | 'both' =
    form.attendance_methods.length === 0
      ? ''
      : form.attendance_methods.includes('mobile')
        ? 'both'
        : 'fingerprint';
  const setAttendanceMethodChoice = (choice: 'fingerprint' | 'both') =>
    setForm((f) => ({
      ...f,
      attendance_methods:
        choice === 'both' ? ['mobile', 'fingerprint'] : ['fingerprint'],
    }));

  // Live "required field is empty" errors — mirror the exact guards in handleSave so the
  // Save button's disabled state and the inline messages can never disagree with what a
  // submit would actually reject. Surfaced in the form only once triedSave is set.
  const REQUIRED_MSG = 'This field is required.';
  const requiredErrors: Partial<Record<keyof typeof form, string>> = {
    first_name: !form.first_name.trim() ? REQUIRED_MSG : undefined,
    last_name: !form.last_name.trim() ? REQUIRED_MSG : undefined,
    epf_number: !form.epf_number.trim() ? REQUIRED_MSG : undefined,
    role: !form.role ? REQUIRED_MSG : undefined,
    date_of_join:
      !isSouthernlanka && !form.date_of_join ? REQUIRED_MSG : undefined,
    company_id:
      !formIsAdminType && !form.company_id
        ? REQUIRED_MSG
        : undefined,
    ...(isSouthernlanka
      ? {
          full_name: !form.full_name.trim() ? REQUIRED_MSG : undefined,
          name_with_initials: !form.name_with_initials.trim()
            ? REQUIRED_MSG
            : undefined,
          gender: !form.gender ? REQUIRED_MSG : undefined,
          employee_number: !form.employee_number.trim()
            ? REQUIRED_MSG
            : undefined,
          ...(!formIsAdminType
            ? {
                nic: !form.nic.trim() ? REQUIRED_MSG : undefined,
                date_of_birth: !form.date_of_birth ? REQUIRED_MSG : undefined,
                attendance_methods:
                  form.attendance_methods.length === 0
                    ? REQUIRED_MSG
                    : undefined,
              }
            : {}),
        }
      : {}),
  };
  const hasMissingRequired = Object.values(requiredErrors).some(Boolean);
  // Convenience: the error to show under a given field, gated on triedSave.
  const reqErr = (key: keyof typeof form) =>
    triedSave ? requiredErrors[key] : undefined;

  // Southernlanka only — Department is admin-managed (belongs to exactly one Company via
  // Department.company_id), narrowed by whichever Company is already chosen so the combination
  // stays coherent. Options are only ever filtered, never force-cleared — the Department
  // Combobox is allowCustom, so it still shows the current value as text even if it falls
  // out of the filtered list, keeping an existing mismatched value visible and editable
  // rather than disappearing. Role is independent of Department entirely (Roles carry no department
  // scoping of their own) — every active role is always offered, regardless of which
  // department is picked.
  const departmentsForForm = departments.filter(
    (d) =>
      d.is_active && (!form.company_id || d.company_id === form.company_id),
  );
  const roleOptionsForForm = activeRoles;

  // Southernlanka (carecode.org) only — "Contract" isn't a used employment type for this
  // tenant, so it's hidden from the picker. Options are only ever filtered, never
  // force-cleared (same convention as departmentsForForm above) — an existing record that
  // was already "Contract" keeps showing/saving that value until an admin changes it.
  const empTypeOptions = isSouthernlanka
    ? EMP_TYPES.filter((t) => t !== 'Contract')
    : EMP_TYPES;

  // Multi-department HOD mapping only ever makes sense for an HOD-capable role — if the role
  // is switched away from one (or was never one) while departments are still selected, clear
  // them rather than silently keeping a stale mapping attached to a non-HOD role.
  useEffect(() => {
    if (!formIsHOD && form.hod_department_ids.length) {
      setForm((f) => ({ ...f, hod_department_ids: [] }));
    }
  }, [formIsHOD, form.hod_department_ids.length]);

  // Super Admin override only ever makes sense for a Head of Department role — clear it if
  // the role is switched away from one (or was never one) while it's still set.
  useEffect(() => {
    if (!formIsHOD && form.is_super_admin) {
      setForm((f) => ({ ...f, is_super_admin: false }));
    }
  }, [formIsHOD, form.is_super_admin]);

  const field = (
    label: string,
    key: keyof typeof form,
    type = 'text',
    required = false,
    placeholder = '',
    disabled = false,
    error?: string,
  ) => {
    // As-typed digit/length constraints on NIC & phone fields are SOUTHERNLANKA-ONLY —
    // other tenants hold foreign IDs / landlines / international numbers that these rules
    // would corrupt (see the nicError/phoneError comment above). Elsewhere these are plain
    // free-text inputs, exactly as they were before.
    const isPhoneField =
      isSouthernlanka &&
      (key === 'phone_personal' ||
        key === 'phone_office' ||
        key === 'phone_emergency' ||
        key === 'guardian_contact');
    const isNicField = isSouthernlanka && key === 'nic';
    return (
    <div key={key} className="min-w-0">
      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      <Input
        type={type}
        value={form[key] as string}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete={key === 'password' ? 'new-password' : 'off'}
        inputMode={isPhoneField ? 'numeric' : undefined}
        maxLength={isPhoneField ? 10 : isNicField ? 12 : undefined}
        data-lpignore="true"
        data-1p-ignore="true"
        onChange={(e) => {
          // EPF and Employee No never intentionally contain spaces — strip them as-typed so
          // this can't reintroduce the "SLH/E 378" vs "SLH/E378" split-identity bug (both are
          // re-normalized again on save regardless — see normalizeEpf/normalizeEmployeeNumber
          // in userService.ts — this just keeps what's on screen matching what gets stored).
          // Southernlanka only: NIC / contact fields are format-constrained as typed (see
          // src/lib/validation.ts) so they can't hold arbitrary text or overrun their length.
          const value =
            key === 'epf_number' || key === 'employee_number'
              ? e.target.value.replace(/\s+/g, '')
              : isPhoneField
                ? sanitizePhoneInput(e.target.value)
                : isNicField
                  ? sanitizeNICInput(e.target.value)
                  : e.target.value;
          setForm((f) => ({ ...f, [key]: value }));
        }}
        aria-invalid={error ? true : undefined}
        // w-full min-w-0 — Date of Join / Date of Birth are type="date"; a native date
        // control's calendar-icon chrome can render past its own width:100% box (bleeding
        // past the form's own edge) without min-w-0 reasserted, the same issue every other
        // type="date"/"month" field on this app hit when squeezed in a multi-column grid —
        // here it shows up standalone since this form is already single-column on mobile.
        // Harmless no-op for every other (text/email/tel) field type this helper renders.
        className={`w-full min-w-0 [color-scheme:dark]${error ? ' border-destructive focus-visible:ring-destructive' : ''}`}
      />
      {error && (
        <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
          <AlertTriangle className="w-3 h-3 shrink-0" />{error}
        </p>
      )}
    </div>
    );
  };

  // Southernlanka (carecode.org) only — Department is picked from the admin-managed list
  // (see isSouthernlanka above) instead of typed free text. `allowCustom` keeps existing
  // values that no longer match an active list entry (e.g. renamed/deactivated since the
  // user was created) editable rather than stuck. Same Combobox (type-to-filter, no
  // separate search bar) as every other picker in this form.
  const selectField = (
    label: string,
    key: 'department',
    options: { value: string; label: string; sublabel?: string }[],
    placeholder: string,
    required = false,
  ) => (
    <div key={key}>
      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      <Combobox
        value={form[key]}
        onChange={(v) => setForm((f) => ({ ...f, [key]: v }))}
        options={options.map((o) => ({
          value: o.value,
          label: o.sublabel ? `${o.label} — ${o.sublabel}` : o.label,
        }))}
        placeholder={placeholder}
        allowCustom
      />
    </div>
  );

  // The epf_number input in the edit form is only actually editable for a pending
  // self-registration (see reassignEpf in handleSave) — for every other account it's
  // locked, since changing it there would silently discard the value (updateUser never
  // included epf_number in its payload) rather than move history to match.
  const editingUser = editingEpf
    ? users.find((u) => u.epf_number === editingEpf)
    : null;
  const epfLocked = !!editingEpf && !editingUser?.awaiting_epf;

  if (me?.capabilities && !canView) {
    return (
      <div className="space-y-6">
        <EmptyState
          icon={Shield}
          title={tr.noAccessTitle}
          description={tr.noAccessSection}
        />
      </div>
    );
  }
  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <StatCardsSkeleton count={4} />
        <TableSkeleton rows={8} cols={6} />
      </div>
    );
  }

  // Display-only summary metrics derived from the already-loaded users.
  const resignedCount = users.filter((u) =>
    isResigned(u.date_of_resign),
  ).length;
  const activeCount = users.filter(
    (u) => u.is_active && !isResigned(u.date_of_resign),
  ).length;
  const inactiveCount = users.length - activeCount - resignedCount;

  return (
    <PageTransition className="space-y-6">
      <PageHeader
        title={tr.userManagement}
        description={tr.employeesCountTpl.replace('{n}', String(users.length))}
        icon={Users}
        actions={
          canManage ? (
            <>
              {/* Southernlanka (carecode.org) only — see isSouthernlanka above */}
              {isSouthernlanka && (
                <Button
                  variant="outline"
                  onClick={() => router.push('/users/bulk-add')}
                >
                  <Upload className="w-4 h-4" />
                  <span className="hidden sm:inline">Import Users</span>
                  <span className="sm:hidden">Import</span>
                </Button>
              )}
              <Button onClick={openCreate}>
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">{tr.addUser}</span>
                <span className="sm:hidden">{tr.addWord}</span>
              </Button>
            </>
          ) : undefined
        }
      />

      {/* KPI summary row */}
      <Stagger className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StaggerItem>
          <StatCard
            label={tr.totalUsers}
            value={users.length}
            icon={Users}
            tone="primary"
            hint={tr.allAccounts}
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            label={tr.statusActive}
            value={activeCount}
            icon={UserCheck}
            tone="success"
            hint={tr.canSignIn}
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            label={tr.inactiveWord}
            value={inactiveCount}
            icon={UserX}
            tone="brand"
            hint={tr.deactivatedHint}
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            label={tr.resignedLabel}
            value={resignedCount}
            icon={AlertTriangle}
            tone="destructive"
            hint={tr.leftCompany}
          />
        </StaggerItem>
      </Stagger>

      {/* Toolbar: search + role + status dropdowns on one row (stacked on phones). The role
          filter used to be a chip row that overflowed sideways on every screen once the roles
          registry grew; RoleFilter folds it into a single searchable dropdown. Status is a
          plain Select — five fixed options need no search box, and it matches the filter
          dropdowns on /attendance-view and /payroll-employees. */}
      <Reveal delay={0.05}>
        <Card className="p-4 flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              type="text"
              name="search-field-no-autofill"
              autoComplete="off"
              data-form-type="other"
              data-lpignore="true"
              data-1p-ignore="true"
              autoCorrect="off"
              spellCheck={false}
              readOnly
              onFocus={(e) => e.target.removeAttribute('readonly')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tr.searchUsers}
              className="pl-9 read-only:cursor-text"
            />
          </div>
          <RoleFilter
            value={tab}
            onChange={setTab}
            options={TABS.map((t) => ({ key: t.key, label: t.label, count: tabCount(t.key) }))}
            allLabel={tr.allWord}
            allCount={tabCount('all')}
          />
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as UserStatus | 'all')}
          >
            {/* --success, --primary and --brand are one azure here, so an engaged filter is
                marked by border and weight rather than by colour alone. */}
            <SelectTrigger
              aria-label={tr.statusLabel}
              className={`w-full sm:w-[170px] ${statusFilter === 'all' ? '' : 'border-primary/30 font-semibold text-primary'}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.key} value={o.key}>
                  {o.label(tr)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Card>
      </Reveal>

      {/* User list */}
      {filtered.length === 0 ? (
        <Reveal>
          <Card>
            <EmptyState
              icon={Users}
              title={tr.noUsersFound}
              description={tr.adjustSearch}
            />
          </Card>
        </Reveal>
      ) : (
        <Reveal>
          <Card className="overflow-hidden">
            <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
              <CardTitle className="text-sm">{tr.employeesCap}</CardTitle>
              <span className="text-xs font-medium text-muted-foreground">
                {tr.shownTpl.replace('{n}', String(filtered.length))}
              </span>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader className="hidden md:table-header-group">
                  <TableRow>
                    <TableHead>{tr.employeeWord}</TableHead>
                    <TableHead>EPF</TableHead>
                    <TableHead>{tr.roleLabel}</TableHead>
                    <TableHead>{tr.companyWord}</TableHead>
                    <TableHead>{tr.statusLabel}</TableHead>
                    <TableHead className="text-right">
                      {tr.actionLabel}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginated.map((u, i) => {
                    const st = userStatus(u);
                    const resigned = st === 'resigned';
                    const pending = st === 'pending';
                    // Pending self-registrations need attention, not dimming — only fade
                    // out the "quietly deactivated" case, not the "needs review" one.
                    const inactive = st === 'inactive' || resigned;
                    return (
                      <MotionTableRow
                        key={u.epf_number}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                          duration: 0.25,
                          delay: Math.min(i, 12) * 0.025,
                          ease: [0.22, 1, 0.36, 1],
                        }}
                        onClick={() => setViewUser(u)}
                        className={`cursor-pointer flex flex-col md:table-row ${pending ? 'bg-warning/5 hover:bg-warning/10' : ''} ${inactive ? 'opacity-60' : ''}`}
                      >
                        {/* Employee */}
                        <TableCell className="md:align-middle">
                          <div className="flex items-center gap-3 min-w-0">
                            <div
                              className={`w-9 h-9 rounded-lg flex items-center justify-center text-primary-foreground font-bold text-xs flex-shrink-0 ${resigned ? 'bg-muted-foreground' : 'bg-primary'}`}
                            >
                              {u.first_name.charAt(0)}
                              {u.last_name.charAt(0)}
                            </div>
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-foreground truncate">
                                {u.display_name}
                              </div>
                              <div className="text-[11px] text-muted-foreground truncate">
                                {/* Phone-only account (southernlanka) — the real email
                                is a meaningless placeholder, show the phone instead. */}
                                {isPlaceholderEmail(u.email)
                                  ? u.phone_personal || '—'
                                  : u.email}
                              </div>
                            </div>
                          </div>
                        </TableCell>

                        {/* EPF */}
                        <TableCell className="text-xs text-muted-foreground truncate">
                          <span className="md:hidden text-muted-foreground mr-1">
                            EPF:
                          </span>
                          {u.epf_number}
                        </TableCell>

                        {/* Role */}
                        <TableCell>
                          <Badge variant="default">{u.role}</Badge>
                        </TableCell>

                        {/* Company */}
                        <TableCell className="text-xs text-muted-foreground truncate">
                          {u.company_name || '—'}
                        </TableCell>

                        {/* Status */}
                        <TableCell>
                          {resigned ? (
                            <Badge variant="destructive">
                              {tr.resignedLabel}
                            </Badge>
                          ) : pending ? (
                            <Badge variant="warning">{tr.pending}</Badge>
                          ) : st === 'active' ? (
                            <Badge variant="success">{tr.statusActive}</Badge>
                          ) : (
                            <Badge variant="muted">{tr.inactiveWord}</Badge>
                          )}
                        </TableCell>

                        {/* Action */}
                        <TableCell className="md:text-right">
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-muted text-muted-foreground text-xs font-semibold">
                            <Eye className="w-3.5 h-3.5" />{' '}
                            <span className="md:hidden">{tr.viewLabel}</span>
                          </span>
                        </TableCell>
                      </MotionTableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </Reveal>
      )}

      {/* Pagination */}
      {filtered.length > 0 && (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={filtered.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      )}

      {/* Stray Firebase Auth accounts with no employee profile — kept out of the table
          above because they have no EPF/role/company; they aren't employees. Hidden for
          southernlanka. */}
      {canManage && !isSouthernlanka && (
        <Reveal>
          <OrphanAuthPanel />
        </Reveal>
      )}

      {/* ── View details modal ── Portalled to <body>: a `fixed inset-0` overlay nested inside
          PageTransition (which carries an active transform from its own enter animation) gets
          its containing block hijacked to PageTransition's own box instead of the viewport, so
          the dimmed backdrop only covers a band in the middle of the screen. */}
      <Portal>
      <AnimatePresence>
        {viewUser &&
          (() => {
            const resigned = isResigned(viewUser.date_of_resign);
            // Pending self-registrations have no work assignment, join date, suspense
            // account or activity history yet — those sections would just be empty
            // placeholders, so skip straight from Personal/Contact to the edit action.
            const pending = !!viewUser.awaiting_epf;
            const viewIsAdminType = !roleCan(
              viewUser.role,
              'is_employee',
              roles,
            );
            const isOwnAccount =
              String(viewUser.epf_number) === String(me?.epf_number);
            const supervisor = viewUser.supervisor_epf
              ? users.find(
                  (u) =>
                    String(u.epf_number) === String(viewUser.supervisor_epf),
                )
              : null;
            const supervisorLabel = supervisor
              ? `${supervisor.display_name} (${supervisor.epf_number})`
              : viewUser.supervisor_epf || null;
            const detailRow = (
              icon: React.ReactNode,
              label: string,
              value: string | null | undefined,
              // Keep the value on one line (truncate + hover title) instead of wrapping —
              // for email / phone / NIC, which otherwise break mid-token and make this card
              // taller than its grid neighbour.
              noWrap = false,
            ) =>
              value ? (
                <div className="flex items-start gap-3 px-3 py-2.5 rounded-xl bg-muted border border-border">
                  <div className="w-8 h-8 rounded-lg bg-card flex items-center justify-center flex-shrink-0">
                    {icon}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
                      {label}
                    </div>
                    <div
                      className={`text-sm text-foreground font-medium ${noWrap ? 'truncate' : 'break-words'}`}
                      title={noWrap ? value : undefined}
                    >
                      {value}
                    </div>
                  </div>
                </div>
              ) : null;
            return (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setViewUser(null)}
                className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4"
              >
                <motion.div
                  initial={{ opacity: 0, y: 40 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 40 }}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full sm:max-w-lg bg-card border border-border rounded-t-3xl sm:rounded-2xl overflow-hidden max-h-[92vh] sm:max-h-[88vh] flex flex-col shadow-popover"
                >
                  {/* Hero header — fixed */}
                  <div
                    className={`relative px-4 sm:px-5 pt-5 sm:pt-6 pb-4 sm:pb-5 flex-shrink-0 border-b border-border ${
                      resigned ? 'bg-muted' : 'bg-primary/5'
                    }`}
                  >
                    {/* Mobile drag handle */}
                    <div className="sm:hidden w-10 h-1 rounded-full bg-border mx-auto mb-3" />
                    <button
                      onClick={() => setViewUser(null)}
                      className="absolute top-4 right-4 w-8 h-8 rounded-md bg-card hover:bg-accent border border-border flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                    <div className="flex flex-col items-center text-center">
                      <div
                        className={`w-16 h-16 sm:w-20 sm:h-20 rounded-2xl sm:rounded-3xl flex items-center justify-center text-primary-foreground font-bold text-xl sm:text-2xl shadow-soft mb-3 ${
                          resigned ? 'bg-muted-foreground' : 'bg-primary'
                        }`}
                      >
                        {viewUser.first_name.charAt(0)}
                        {viewUser.last_name.charAt(0)}
                      </div>
                      <h2 className="text-base sm:text-lg font-bold text-foreground px-6">
                        {viewUser.display_name}
                      </h2>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {viewUser.designation || viewUser.role}
                      </p>
                      {/* Badges */}
                      <div className="flex items-center gap-2 mt-3 flex-wrap justify-center">
                        <Badge variant="default">{viewUser.role}</Badge>
                        {isOwnAccount && (
                          <Badge variant="success">{tr.youLabel}</Badge>
                        )}
                        {!viewIsAdminType && (
                          <Badge variant="muted">{viewUser.epf_number}</Badge>
                        )}
                        {!viewIsAdminType && (
                          <Badge variant="brand">
                            {viewUser.employee_type}
                          </Badge>
                        )}
                        {resigned && (
                          <Badge variant="destructive">
                            {tr.resignedLabel}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Scrollable body */}
                  <div className="flex-1 min-h-0 overflow-y-auto pb-2">
                    {/* Resigned banner */}
                    {resigned && (
                      <div className="mx-5 mt-4 px-3 py-2.5 rounded-xl bg-destructive/10 border border-destructive/20 flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                        <span className="text-xs text-destructive">
                          {tr.resignedOnTpl.replace(
                            '{date}',
                            viewUser.date_of_resign ?? '',
                          )}
                        </span>
                      </div>
                    )}

                    {/* Inactive banner (admin types) */}
                    {viewIsAdminType && !viewUser.is_active && (
                      <div className="mx-5 mt-4 px-3 py-2.5 rounded-xl bg-destructive/10 border border-destructive/20 flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                        <span className="text-xs text-destructive">
                          {tr.accountInactive}
                        </span>
                      </div>
                    )}

                    {/* Super Admin override banner — southernlanka only. See AppUser.is_super_admin. */}
                    {isSouthernlanka && viewUser.is_super_admin && (
                      <div className="mx-5 mt-4 px-3 py-2.5 rounded-xl bg-destructive/10 border border-destructive/20 flex items-start gap-2">
                        <Shield className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                        <span className="text-xs text-destructive">
                          Super Admin — has full System Admin access regardless of Role.
                        </span>
                      </div>
                    )}

                    {/* Awaiting Employee No (self-registered from carecode.org) */}
                    {viewUser.awaiting_epf && (
                      <div className="mx-5 mt-4 px-3 py-2.5 rounded-xl bg-warning/10 border border-warning/20 flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                        <span className="text-xs text-warning">
                          Self-registered — edit this account to assign a real
                          Employee No before activating.
                        </span>
                      </div>
                    )}

                    {/* Personal details (self-reported at registration) */}
                    {(viewUser.full_name ||
                      viewUser.name_with_initials ||
                      viewUser.gender ||
                      viewUser.guardian_contact) && (
                      <div className="px-5 pt-4">
                        <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">
                          Personal
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {detailRow(
                            <UserCircle className="w-4 h-4 text-primary" />,
                            'Full Name',
                            viewUser.full_name,
                          )}
                          {detailRow(
                            <UserCircle className="w-4 h-4 text-brand" />,
                            'Name with Initials',
                            viewUser.name_with_initials,
                          )}
                          {detailRow(
                            <UserCircle className="w-4 h-4 text-success" />,
                            'Gender',
                            viewUser.gender,
                          )}
                          {detailRow(
                            <Phone className="w-4 h-4 text-destructive" />,
                            'Guardian Contact',
                            viewUser.guardian_contact,
                            true,
                          )}
                        </div>
                      </div>
                    )}

                    {/* Contact section */}
                    <div className="px-5 pt-4">
                      <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">
                        {tr.contactLabel}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {/* Hide the synthesized placeholder — a phone-only account has
                        nothing meaningful to show here (phone_personal is below instead). */}
                        {detailRow(
                          <Mail className="w-4 h-4 text-primary" />,
                          tr.emailLabel,
                          isPlaceholderEmail(viewUser.email)
                            ? null
                            : viewUser.email,
                          true,
                        )}
                        {detailRow(
                          <Phone className="w-4 h-4 text-success" />,
                          tr.phoneLabel,
                          viewUser.phone_personal,
                          true,
                        )}
                        {!viewIsAdminType &&
                          detailRow(
                            <MapPin className="w-4 h-4 text-brand" />,
                            tr.addressLabel,
                            viewUser.address,
                          )}
                        {!viewIsAdminType &&
                          detailRow(
                            <CreditCard className="w-4 h-4 text-muted-foreground" />,
                            tr.nicLabel,
                            viewUser.nic,
                            true,
                          )}
                      </div>
                    </div>

                    {/* Work section — employees only, and not until a pending account is activated */}
                    {!viewIsAdminType && !pending && (
                      <div className="px-5 pt-4">
                        <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">
                          {tr.workLabel}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {detailRow(
                            <Building2 className="w-4 h-4 text-primary" />,
                            tr.companyWord,
                            viewUser.company_name,
                          )}
                          {detailRow(
                            <Briefcase className="w-4 h-4 text-brand" />,
                            tr.departmentLabel,
                            viewUser.department,
                          )}
                          {isSouthernlanka &&
                            !!viewUser.hod_department_names?.length &&
                            detailRow(
                              <Crown className="w-4 h-4 text-warning" />,
                              'Head of Department',
                              viewUser.hod_department_names.join(', '),
                            )}
                          {/* Southernlanka has no supervisor chain (approvals route through
                          Head-of-Department assignments), so never surface it here — not even
                          if a stale supervisor_epf survived an import/migration. */}
                          {!isSouthernlanka &&
                            detailRow(
                              <UserCircle className="w-4 h-4 text-success" />,
                              tr.supervisorLabel,
                              supervisorLabel,
                            )}
                          {detailRow(
                            <CreditCard className="w-4 h-4 text-muted-foreground" />,
                            tr.employeeNumber,
                            viewUser.employee_number,
                          )}
                          {/* Southernlanka (carecode.org) only — see isSouthernlanka above.
                          Required going forward (see handleSave), so an empty/unset array
                          only happens on an older record never re-saved since — flag it
                          rather than silently reading as 'Fingerprint'. */}
                          {isSouthernlanka &&
                            detailRow(
                              <Fingerprint className="w-4 h-4 text-primary" />,
                              'Attendance Method',
                              !viewUser.attendance_methods?.length
                                ? 'Not set'
                                : viewUser.attendance_methods.includes('mobile')
                                  ? 'Mobile + Fingerprint'
                                  : 'Fingerprint',
                            )}
                        </div>
                      </div>
                    )}

                    {/* Dates section */}
                    {!pending && (
                      <div className="px-5 pt-4 pb-2">
                        <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">
                          {tr.datesLabel}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {!viewIsAdminType &&
                            detailRow(
                              <Calendar className="w-4 h-4 text-success" />,
                              tr.dateOfBirth,
                              viewUser.date_of_birth,
                            )}
                          {detailRow(
                            <Calendar className="w-4 h-4 text-primary" />,
                            tr.dateOfJoin,
                            viewUser.date_of_join,
                          )}
                          {!viewIsAdminType &&
                            detailRow(
                              <Calendar className="w-4 h-4 text-destructive" />,
                              tr.dateOfResign,
                              viewUser.date_of_resign,
                            )}
                        </div>
                      </div>
                    )}

                    {/* Suspense account — user-managers open/adjust a per-user expense float (Alta Vision only) */}
                    {tenant.features.suspense && canManage && !viewIsAdminType && !resigned && !pending && (
                      <div className="px-5 pt-4">
                        <UserSuspenseCard
                          user={viewUser}
                          actor={{
                            epf: me?.epf_number ?? '',
                            name: me?.name ?? '',
                          }}
                        />
                      </div>
                    )}

                    {/* Activity — calendar, tasks & leaves (employees only, once activated) */}
                    {!viewIsAdminType && !pending && (
                      <UserActivityPanel
                        epf={viewUser.epf_number}
                        user={viewUser}
                        usersByEpf={usersByEpf}
                      />
                    )}
                  </div>
                  {/* end scrollable body */}

                  {/* Footer actions — full managers only. View-only roles (can_view_users)
                    see the details + activity/downloads above, but no edit / (de)activate. */}
                  {canManage && (
                    <div className="p-4 border-t border-border flex-shrink-0 space-y-2">
                      {resigned ? (
                        <div className="text-center text-xs text-muted-foreground py-2">
                          {tr.editingDisabledResigned}
                        </div>
                      ) : (
                        <Button
                          onClick={() => openEdit(viewUser)}
                          className="w-full"
                        >
                          <Edit2 className="w-4 h-4" /> {tr.editDetails}
                        </Button>
                      )}

                      {/* Active / Inactive toggle — HR & Admin accounts (not for own account) */}
                      {viewIsAdminType &&
                        !isOwnAccount &&
                        (viewUser.is_active ? (
                          <Button
                            variant="destructive"
                            onClick={() => setConfirmDeactivate(viewUser)}
                            className="w-full"
                          >
                            <UserX className="w-4 h-4" /> {tr.deactivateAccount}
                          </Button>
                        ) : (
                          <Button
                            variant="success"
                            onClick={() => handleToggleActive(viewUser, true)}
                            className="w-full"
                          >
                            <UserCheck className="w-4 h-4" />{' '}
                            {tr.activateAccount}
                          </Button>
                        ))}
                    </div>
                  )}
                </motion.div>
              </motion.div>
            );
          })()}
      </AnimatePresence>
      </Portal>

      {/* ── User form modal ── see the Portal note above. */}
      <Portal>
      <AnimatePresence>
        {showForm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4"
          >
            <motion.div
              initial={{ y: 60 }}
              animate={{ y: 0 }}
              exit={{ y: 60 }}
              className="w-full sm:max-w-2xl bg-card border border-border rounded-t-3xl sm:rounded-2xl p-4 sm:p-6 space-y-5 max-h-[92vh] sm:max-h-[90vh] overflow-y-auto shadow-popover"
            >
              <div className="sm:hidden w-10 h-1 rounded-full bg-border mx-auto" />
              <div className="flex items-center justify-between">
                <div className="text-base font-semibold text-foreground">
                  {editingEpf ? tr.editUser : tr.createNewUser}
                </div>
                <button
                  onClick={() => setShowForm(false)}
                  className="w-8 h-8 rounded-md bg-muted hover:bg-accent border border-border flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {loading ? (
                <FormSkeleton
                  fields={6}
                  className="bg-transparent shadow-none p-0"
                />
              ) : (
                <>
                  {editingUser?.awaiting_epf && (
                    <div className="flex items-start gap-2.5 rounded-xl border border-warning/25 bg-warning/10 p-3 text-xs font-medium text-warning">
                      <AlertTriangle
                        className="mt-0.5 h-4 w-4 flex-shrink-0"
                        aria-hidden
                      />
                      <span>
                        Self-registered from carecode.org — assign a real
                        Employee No below, then fill in Role/Company to
                        activate.
                      </span>
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {field(
                      tr.firstName,
                      'first_name',
                      'text',
                      true,
                      'e.g. John',
                      false,
                      reqErr('first_name'),
                    )}
                    {field(
                      tr.lastName,
                      'last_name',
                      'text',
                      true,
                      'e.g. Doe',
                      false,
                      reqErr('last_name'),
                    )}
                    {/* Southernlanka (carecode.org) only — see isSouthernlanka above */}
                    {isSouthernlanka &&
                      field(
                        'Full Name',
                        'full_name',
                        'text',
                        true,
                        'e.g. John Doe',
                        false,
                        reqErr('full_name'),
                      )}
                    {isSouthernlanka &&
                      field(
                        'Name with Initials',
                        'name_with_initials',
                        'text',
                        true,
                        'e.g. J. Doe',
                        false,
                        reqErr('name_with_initials'),
                      )}
                    {field(
                      tr.epfNumber,
                      'epf_number',
                      'text',
                      true,
                      'e.g. EMPAV/00123',
                      epfLocked,
                      epfDuplicate
                        ? `${tr.epfAlreadyExists}${epfDuplicate.display_name ? ` — ${epfDuplicate.display_name}` : ''}`
                        : reqErr('epf_number'),
                    )}
                    {field(
                      tr.employeeNumber,
                      'employee_number',
                      'text',
                      isSouthernlanka,
                      'e.g. EMP-00123',
                      false,
                      reqErr('employee_number'),
                    )}
                    {/* Optional for southernlanka — the employee number above is enough to
                    sign in (see src/lib/phone.ts); every other tenant still requires a real one. */}
                    {!editingEpf &&
                      field(
                        tr.emailLabel,
                        'email',
                        'email',
                        !isSouthernlanka,
                        isSouthernlanka
                          ? 'e.g. name@gmail.com'
                          : 'name@company.com',
                        false,
                        emailError,
                      )}
                    {/* Not required — southernlanka signs in with email or Employee No, never
                    phone (see the handleSave check above); every other tenant never required
                    this either. */}
                    {field(
                      tr.personalPhone,
                      'phone_personal',
                      'text',
                      false,
                      'e.g. 0771234567',
                      false,
                      phoneError,
                    )}
                    {field(
                      tr.dateOfJoin,
                      'date_of_join',
                      'date',
                      !isSouthernlanka,
                      '',
                      false,
                      reqErr('date_of_join'),
                    )}
                    {/* Employee-only fields — hidden for HR/Admin. Southernlanka doesn't
                    collect Designation at all — its Company → Department → Role hierarchy
                    (rendered further below, after Gender — see departmentsForForm /
                    roleOptionsForForm) replaces it. */}
                    {!formIsAdminType &&
                      !isSouthernlanka &&
                      field(
                        tr.designationLabel,
                        'designation',
                        'text',
                        false,
                        'e.g. Software Engineer',
                      )}
                    {!formIsAdminType &&
                      field(
                        tr.nicLabel,
                        'nic',
                        'text',
                        isSouthernlanka,
                        'e.g. 200012345678',
                        false,
                        nicError ?? reqErr('nic'),
                      )}
                    {!formIsAdminType &&
                      field(
                        tr.dateOfBirth,
                        'date_of_birth',
                        'date',
                        isSouthernlanka,
                        '',
                        false,
                        reqErr('date_of_birth'),
                      )}
                    {/* Southernlanka (carecode.org) only — see isSouthernlanka above */}
                    {isSouthernlanka &&
                      field(
                        'Guardian Contact',
                        'guardian_contact',
                        'text',
                        false,
                        'e.g. 0771234567',
                        false,
                        guardianError,
                      )}
                  </div>

                  {isSouthernlanka && (
                    <div>
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        Gender <span className="text-destructive">*</span>
                      </Label>
                      <Combobox
                        value={form.gender}
                        onChange={(v) => setForm((f) => ({ ...f, gender: v }))}
                        placeholder="Select…"
                        allowCustom={false}
                        options={GENDER_OPTIONS.map((g) => ({
                          value: g,
                          label: g,
                        }))}
                      />
                      <InlineError>{reqErr('gender')}</InlineError>
                    </div>
                  )}

                  {/* Company is required (see requiredErrors.company_id) and defaults from
                  the navbar's Global Company Selector on a brand-new form (see openCreate).
                  Department/Role below only narrow their own options once Company is picked
                  — that part doesn't force an order. */}
                  {isSouthernlanka && !formIsAdminType && (
                    <div key="company_southernlanka">
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        {tr.companyWord} <span className="text-destructive">*</span>
                      </Label>
                      <Combobox
                        value={form.company_id}
                        onChange={(v) =>
                          setForm((f) => ({ ...f, company_id: v }))
                        }
                        placeholder={tr.selectCompany}
                        allowCustom={false}
                        options={companies.map((c) => ({
                          value: c.id,
                          label: c.name,
                        }))}
                      />
                      {/* navbarBlocked: the acting admin's own account has no company assigned
                          (and they can't switch companies from the navbar either), so this
                          field couldn't be pre-filled the way it normally is on a new form —
                          not a validation error, just why it starts empty here. */}
                      {navbarBlocked && !editingEpf && !form.company_id && (
                        <p className="text-[11px] text-muted-foreground mt-1">
                          Your account has no company assigned, so this couldn&apos;t be pre-filled — pick one above.
                        </p>
                      )}
                      <InlineError>{reqErr('company_id')}</InlineError>
                    </div>
                  )}

                  {!formIsAdminType &&
                    (isSouthernlanka
                      ? selectField(
                          tr.departmentLabel,
                          'department',
                          departmentsForForm.map((d) => ({
                            value: d.name,
                            label: d.name,
                            sublabel: d.company_name,
                          })),
                          'Select department…',
                          false,
                        )
                      : field(
                          tr.departmentLabel,
                          'department',
                          'text',
                          false,
                          'e.g. R&D',
                        ))}

                  {/* Company -> Department (home/primary) above -> Role -> Managed Departments:
                  Role has to be picked before the HOD multi-select below it can even show up
                  (it's gated on the picked role's is_department_head capability). */}
                  {isSouthernlanka && (
                    <div>
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        {tr.roleLabel} <span className="text-destructive">*</span>
                      </Label>
                      <Combobox
                        value={form.role}
                        onChange={(v) =>
                          setForm((f) => ({ ...f, role: v as UserRole }))
                        }
                        placeholder="Select…"
                        allowCustom={false}
                        options={
                          isSouthernlanka
                            ? roleOptionsForForm.map((r) => ({ value: r.name, label: r.name }))
                            : ROLE_NAMES.map((r) => ({ value: r, label: r }))
                        }
                      />
                      <InlineError>{reqErr('role')}</InlineError>
                    </div>
                  )}

                  {/* Head of Department — southernlanka only. Shown for any role carrying the
                  is_department_head capability (ticked on the HOD role from Roles admin), never
                  tied to the user's own single Department field above: that field is just where
                  THIS person sits; the departments picked here are which ones they manage leave
                  approvals and shift rosters for (see AppUser.hod_department_ids, and
                  southernlankaApprovers/the Schedule page for how it's consumed). */}
                  {isSouthernlanka && !formIsAdminType && formIsHOD && (
                    <div>
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        Departments managed (as Head of Department)
                      </Label>
                      {departmentsForForm.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground">
                          {form.company_id ? 'No departments for this company yet.' : 'Pick a company first.'}
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {departmentsForForm.map((d) => {
                            const active = form.hod_department_ids.includes(d.id);
                            return (
                              <button
                                key={d.id}
                                type="button"
                                onClick={() =>
                                  setForm((f) => ({
                                    ...f,
                                    hod_department_ids: active
                                      ? f.hod_department_ids.filter((id) => id !== d.id)
                                      : [...f.hod_department_ids, d.id],
                                  }))
                                }
                                className={`px-2.5 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                                  active
                                    ? 'bg-warning/10 border-warning/30 text-warning'
                                    : 'bg-card border-border text-muted-foreground hover:text-foreground hover:bg-accent'
                                }`}
                              >
                                {d.name}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        This user will manage leave approvals and shift rosters for all departments selected here.
                        Optional — leaving this empty is fine (e.g. while onboarding); they'll have no department
                        scope to manage until departments are added here.
                      </p>
                    </div>
                  )}

                  {/* Default password note — create mode */}
                  {!editingEpf && !isSouthernlanka && (
                    <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-primary/5 border border-primary/20">
                      <Lock className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
                      <span className="text-xs text-muted-foreground">
                        {tr.defaultPwNoteA}
                        {tr.defaultPwNoteB}
                      </span>
                    </div>
                  )}

                  {/* Editable login email — edit mode only */}
                  {editingEpf && (
                    <div>
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        {tr.loginEmail}
                        {/* Southernlanka phone-only account (see isPlaceholderEmail in
                        openEdit above) — no real email on file yet. */}
                        {isSouthernlanka && !form.email && (
                          <span className="text-muted-foreground normal-case font-normal">
                            {' '}
                            (optional — signs in by phone)
                          </span>
                        )}
                      </Label>
                      <div className="flex gap-2">
                        <Input
                          type="email"
                          value={form.email}
                          autoComplete="off"
                          placeholder={
                            isSouthernlanka ? 'No email on file' : undefined
                          }
                          onChange={(e) =>
                            setForm((f) => ({ ...f, email: e.target.value }))
                          }
                          aria-invalid={!!emailError}
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleChangeEmail}
                          disabled={
                            changingEmail ||
                            !form.email.trim() ||
                            !!emailError ||
                            form.email ===
                              users.find((u) => u.epf_number === editingEpf)
                                ?.email
                          }
                          className="flex-shrink-0"
                        >
                          {changingEmail ? (
                            <div className="w-4 h-4 border-2 border-primary/40 border-t-primary rounded-full animate-spin" />
                          ) : (
                            <Mail className="w-4 h-4" />
                          )}
                          {tr.changeWord}
                        </Button>
                      </div>
                      {emailError ? (
                        <p className="mt-1 flex items-center gap-1 text-[11px] text-destructive">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          {emailError}
                        </p>
                      ) : (
                        <p className="text-[11px] text-muted-foreground mt-1">
                          {tr.changeEmailHint}
                        </p>
                      )}
                    </div>
                  )}

                  {!isSouthernlanka && (
                    <div>
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        {tr.roleLabel}{' '}
                        <span className="text-destructive">*</span>
                      </Label>
                      <Combobox
                        value={form.role}
                        onChange={(v) =>
                          setForm((f) => ({ ...f, role: v as UserRole }))
                        }
                        placeholder="Select…"
                        allowCustom={false}
                        options={
                          isSouthernlanka
                            ? roleOptionsForForm.map((r) => ({ value: r.name, label: r.name }))
                            : ROLE_NAMES.map((r) => ({ value: r, label: r }))
                        }
                      />
                      <InlineError>{reqErr('role')}</InlineError>
                    </div>
                  )}

                  {/* Employee-only: type, company, supervisor, address */}
                  {!formIsAdminType && (
                    <>
                      <div>
                        {/* Always has a value (defaults to 'Permanent'), and — like
                        Company/Department/Role above — is optional for southernlanka, so
                        no required marker on any tenant. */}
                        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                          {tr.employeeType}
                        </Label>
                        <Combobox
                          value={form.employee_type}
                          onChange={(v) =>
                            setForm((f) => ({
                              ...f,
                              employee_type:
                                v as (typeof form)['employee_type'],
                            }))
                          }
                          placeholder="Select…"
                          allowCustom={false}
                          options={empTypeOptions.map((t) => ({
                            value: t,
                            label: t,
                          }))}
                        />
                      </div>

                      {/* How this employee is allowed to mark attendance — see
                      AppUser.attendance_methods. The 'fingerprint' array value is really "the
                      terminal channel" — a terminal may scan a fingerprint or a face per punch
                      (see fingerprintApi.ts biometricType), decided per-scan, not per-user.
                      'Both' is meant for special-case users only; everyone else should stay on
                      the terminal-only option. Southernlanka (carecode.org) only, and required
                      there — see isSouthernlanka above and the isSouthernlanka block in
                      handleSave. */}
                      {isSouthernlanka && (
                        <div>
                          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                            Attendance Method{' '}
                            <span className="text-destructive">*</span>
                          </Label>
                          <Combobox
                            value={attendanceMethodChoice}
                            onChange={(v) =>
                              setAttendanceMethodChoice(v as 'fingerprint' | 'both')
                            }
                            placeholder="Select…"
                            allowCustom={false}
                            options={[
                              {
                                value: 'fingerprint',
                                label: 'Terminal — fingerprint or face scan only',
                              },
                              {
                                value: 'both',
                                label: 'Mobile + Terminal — special users only',
                              },
                            ]}
                          />
                          <InlineError>{reqErr('attendance_methods')}</InlineError>
                        </div>
                      )}

                      {/* Southernlanka already picked Company up in the
                      Company → Department → Role hierarchy block above. */}
                      {!isSouthernlanka && (
                        <div>
                          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                            {tr.companyWord}{' '}
                            <span className="text-destructive">*</span>
                          </Label>
                          <Combobox
                            value={form.company_id}
                            onChange={(v) =>
                              setForm((f) => ({ ...f, company_id: v }))
                            }
                            placeholder={tr.selectCompany}
                            allowCustom={false}
                            options={companies.map((c) => ({
                              value: c.id,
                              label: c.name,
                            }))}
                          />
                          <InlineError>{reqErr('company_id')}</InlineError>
                        </div>
                      )}

                      {/* Supervisor — the approver this employee reports to. Drives leave-request
                      routing and attendance-approval visibility. Optional (top-of-tree = none).
                      Only shown when EDITING an existing user — it's not a core onboarding
                      attribute, so the "Add User" form stays lean and the reporting line is
                      wired up afterwards. Hidden entirely for southernlanka, which routes
                      leave/attendance approvals through Head-of-Department assignments (see
                      hod_department_ids), not a per-employee supervisor chain. */}
                      {!isSouthernlanka && editingEpf && (
                      <div>
                        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                          {tr.supervisorLabel}
                        </Label>
                        <Combobox
                          value={form.supervisor_epf}
                          onChange={(v) =>
                            setForm((f) => ({ ...f, supervisor_epf: v }))
                          }
                          placeholder={tr.selectSupervisor}
                          allowCustom={false}
                          options={[
                            { value: '', label: tr.noneTopTree },
                            ...supervisors
                              .filter(
                                (u) =>
                                  String(u.epf_number) !== String(editingEpf),
                              )
                              .map((u) => {
                                const name =
                                  u.display_name ||
                                  `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() ||
                                  String(u.epf_number);
                                return {
                                  value: String(u.epf_number),
                                  label: `${name} — ${u.role}${u.epf_number ? ` · ${u.epf_number}` : ''}`,
                                };
                              }),
                          ]}
                        />
                      </div>
                      )}

                      {/* Overnight shift work is now assigned per-period on the Shifts page,
                      not as a permanent per-user flag. */}

                      <div>
                        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                          {tr.addressLabel}
                        </Label>
                        <Textarea
                          value={form.address}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, address: e.target.value }))
                          }
                          rows={2}
                          placeholder={tr.egAddressFull}
                          className="resize-none"
                        />
                      </div>
                    </>
                  )}

                  {/* Resign date — employee edit only */}
                  {editingEpf && !formIsAdminType && (
                    <div>
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        {tr.dateOfResign}{' '}
                        <span className="text-muted-foreground normal-case font-normal">
                          {tr.leaveEmptyIfActive}
                        </span>
                      </Label>
                      <Input
                        type="date"
                        value={form.date_of_resign}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            date_of_resign: e.target.value,
                          }))
                        }
                        className="border-destructive/20 focus-visible:ring-destructive [color-scheme:dark]"
                      />
                      {form.date_of_resign && (
                        <p className="text-[11px] text-destructive mt-1">
                          {tr.resignWarning}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Super Admin override — southernlanka only, shown only to users who can
                  already manage users, AND only for a Head of Department role (formIsHOD) —
                  grants that HOD full System Admin capabilities everywhere (see
                  resolveUserCapabilities in @/lib/permissions) without changing their
                  job-title Role. Auto-cleared if the role stops being HOD-capable — see the
                  effect below (mirrors the hod_department_ids auto-clear above). */}
                  {isSouthernlanka && canManage && formIsHOD && (
                    <div className="rounded-xl bg-destructive/5 border border-destructive/20 p-3">
                      <label className="flex items-start justify-between gap-3 cursor-pointer select-none">
                        <div className="flex items-start gap-2.5">
                          <Shield className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                          <div>
                            <div className="text-sm font-semibold text-destructive">
                              Super Admin
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              Grants full System Admin access everywhere, regardless of this person&apos;s Role.
                            </div>
                          </div>
                        </div>
                        <div
                          role="switch"
                          aria-checked={form.is_super_admin}
                          onClick={() =>
                            setForm((f) => ({ ...f, is_super_admin: !f.is_super_admin }))
                          }
                          className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 cursor-pointer mt-0.5 ${
                            form.is_super_admin ? 'bg-destructive' : 'bg-muted'
                          }`}
                        >
                          <div
                            className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${
                              form.is_super_admin ? 'left-5' : 'left-1'
                            }`}
                          />
                        </div>
                      </label>
                    </div>
                  )}

                  {/* Reset password — edit only */}
                  {editingEpf && (
                    <div className="rounded-xl bg-warning/5 border border-warning/20 p-3 space-y-3">
                      <label className="flex items-start gap-2.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={resetChecked}
                          onChange={(e) => setResetChecked(e.target.checked)}
                          className="mt-0.5 w-4 h-4 rounded accent-warning cursor-pointer"
                        />
                        <div>
                          <div className="text-sm font-semibold text-warning">
                            {tr.resetPasswordLabel}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {tr.resetPasswordDesc}
                          </div>
                        </div>
                      </label>
                      {resetChecked && (
                        <Button
                          onClick={handleResetPassword}
                          disabled={resetting}
                          variant="outline"
                          className="w-full border-warning/30 text-warning hover:bg-warning/10 hover:text-warning"
                        >
                          {resetting ? (
                            <div className="w-4 h-4 border-2 border-warning/40 border-t-warning rounded-full animate-spin" />
                          ) : (
                            <Lock className="w-4 h-4" />
                          )}
                          {resetting ? tr.sendingWord : tr.sendResetEmail}
                        </Button>
                      )}
                    </div>
                  )}

                  <div className="flex gap-3 pt-2">
                    <Button
                      variant="outline"
                      onClick={() => setShowForm(false)}
                      className="flex-1"
                    >
                      {tr.cancel}
                    </Button>
                    <Button
                      onClick={handleSave}
                      disabled={
                        saving ||
                        !!epfDuplicate ||
                        hasFieldFormatError ||
                        hasMissingRequired
                      }
                      className="flex-1"
                    >
                      <Save className="w-4 h-4" />
                      {saving
                        ? tr.saving
                        : editingEpf
                          ? tr.save
                          : tr.createUser}
                    </Button>
                  </div>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </Portal>

      <NewPasswordDialog
        password={newPassword?.password ?? null}
        title={newPassword?.title}
        accountLabel={newPassword?.account}
        note={newPassword?.note}
        onClose={() => setNewPassword(null)}
      />

      <ConfirmModal
        open={!!confirmDeactivate}
        onOpenChange={() => setConfirmDeactivate(null)}
        variant="warning"
        title={tr.deactivateAccount}
        description={
          confirmDeactivate
            ? `${confirmDeactivate.display_name} will no longer be able to sign in. Their records are kept and the account can be re-activated later.`
            : undefined
        }
        confirmText={tr.deactivateAccount}
        onConfirm={async () => {
          const u = confirmDeactivate;
          setConfirmDeactivate(null);
          if (u) await handleToggleActive(u, false);
        }}
      />
    </PageTransition>
  );
}

export default function UserAdminPage() {
  return (
    // useSearchParams() inside UserAdminContent requires a Suspense boundary at the
    // static-render edge (matches the same pattern used in src/app/(pages)/leaves/page.tsx).
    <Suspense
      fallback={
        <div className="space-y-6">
          <PageHeaderSkeleton />
          <StatCardsSkeleton count={4} />
          <TableSkeleton rows={8} cols={6} />
        </div>
      }
    >
      <UserAdminContent />
    </Suspense>
  );
}
