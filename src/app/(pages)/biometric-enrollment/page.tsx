'use client';
import { useEffect, useState } from 'react';
import { ScanFace, UserCheck, UserX, Search, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import { useUserCapabilities } from '@/store/rolesStore';
import { useCompanyContext } from '@/store/companyContextStore';
import { useT } from '@/store/appStore';
import { getAllUsers } from '@/services/userService';
import type { AppUser } from '@/lib/types';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeaderSkeleton, StatCardsSkeleton, TableSkeleton } from '@/components/ui/Skeleton';
import { PageTransition, Reveal, Stagger, StaggerItem } from '@/components/ui/motion';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import Pagination from '@/components/Pagination';

// Gated by its own per-tenant module flag (TenantFeatures.biometricEnrollment in
// src/lib/tenants.ts) — a tenant with the flag off never renders this route ((pages)/layout.tsx)
// and never sees the sidebar row (useSidebarNav.ts). The capability gate below
// (can_view_biometric_enrollment) is the second, independent layer, same two-gate convention
// as every other admin page in this app.

type Tab = 'not_registered' | 'registered';

function fmtDate(ts: AppUser['face_updated_at']): string {
  if (!ts) return '—';
  try { return ts.toDate().toLocaleDateString(); } catch { return '—'; }
}

function BiometricEnrollmentContent() {
  const caps = useUserCapabilities();
  const t = useT();
  // Southern Lanka multi-company admins get the Global Company Selector's pick; everyone else
  // is hard-locked to their own company — same source of truth /users and /departments use.
  const { companyId, blocked: companyContextBlocked } = useCompanyContext();

  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [tab, setTab] = useState<Tab>('not_registered');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const load = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setUsers(await getAllUsers(companyId, false));
    } catch (e) {
      console.error(e);
      setLoadError(true);
      toast.error(t.biometricLoadError);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!caps.can_view_biometric_enrollment) { setLoading(false); return; }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, caps.can_view_biometric_enrollment]);

  // Reset to page 1 whenever the tab or search query changes the underlying list.
  useEffect(() => {
    setPage(1);
  }, [tab, search]);

  if (!caps.can_view_biometric_enrollment) {
    return (
      <PageTransition className="space-y-6">
        <PageHeader title={t.biometricEnrollmentTitle} icon={ScanFace} />
        <Card className="p-0">
          <EmptyState
            icon={ScanFace}
            title={t.biometricNoPermissionTitle}
            description={t.biometricNoPermissionDesc}
          />
        </Card>
      </PageTransition>
    );
  }

  // Same fail-closed guard departments/page.tsx uses: a locked user with no company assigned
  // must see an explicit message, never a silently-empty (and misleadingly "everyone registered")
  // list.
  if (companyContextBlocked) {
    return (
      <div className="p-10 text-center text-muted-foreground">
        <Users className="w-8 h-8 mx-auto mb-3 opacity-40" />
        <p className="font-medium text-foreground">No assigned company</p>
        <p className="text-sm mt-1">Your account has no company assigned — contact an admin.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <StatCardsSkeleton count={3} />
        <TableSkeleton rows={6} cols={4} />
      </div>
    );
  }

  const registered = users.filter((u) => u.face_enrolled);
  const notRegistered = users.filter((u) => !u.face_enrolled);
  const faceCount = registered.length;

  const activeList = tab === 'registered' ? registered : notRegistered;
  const searchTrimmed = search.trim().toLowerCase();
  const filtered = searchTrimmed
    ? activeList.filter(
        (u) =>
          u.display_name?.toLowerCase().includes(searchTrimmed) ||
          u.epf_number?.toLowerCase().includes(searchTrimmed) ||
          u.employee_number?.toLowerCase().includes(searchTrimmed),
      )
    : activeList;
  // Clamped inline rather than via an effect (page state is declared above the loading/
  // permission guards, but this derived total isn't known until after them) — a shrinking
  // list (switch tabs, narrow the search) can never strand the viewer past the last page.
  const maxPage = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, maxPage);
  const paginated = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const isEmpty = users.length === 0;
  const noSearchResults = !isEmpty && searchTrimmed !== '' && filtered.length === 0 && activeList.length > 0;
  const tabEmpty = !isEmpty && !noSearchResults && activeList.length === 0;

  return (
    <PageTransition className="space-y-6">
      <PageHeader
        title={t.biometricEnrollmentTitle}
        description={t.biometricEnrollmentDescTemplate
          .replace('{n}', String(users.length))
          .replace('{r}', String(registered.length))
          .replace('{u}', String(notRegistered.length))}
        icon={ScanFace}
      />

      {loadError ? (
        <Card>
          <EmptyState
            icon={ScanFace}
            title={t.biometricLoadError}
            action={<Button variant="outline" onClick={load}>{t.biometricRetry}</Button>}
          />
        </Card>
      ) : isEmpty ? (
        <Reveal>
          <Card>
            <EmptyState icon={Users} title={t.biometricNoUsersTitle} description={t.biometricNoUsersDesc} />
          </Card>
        </Reveal>
      ) : (
        <>
          <Stagger className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <StaggerItem>
              <StatCard label={t.biometricStatTotal} value={users.length} icon={Users} tone="primary" />
            </StaggerItem>
            <StaggerItem>
              <StatCard label={t.biometricStatFaceId} value={faceCount} icon={ScanFace} tone="success" />
            </StaggerItem>
            <StaggerItem>
              <StatCard
                label={t.biometricStatNotEnrolled}
                value={notRegistered.length}
                icon={UserX}
                tone={notRegistered.length > 0 ? 'warning' : 'muted'}
              />
            </StaggerItem>
          </Stagger>

          <Reveal delay={0.05}>
            <Card className="p-3 space-y-3">
              <div className="inline-flex rounded-lg border border-border p-0.5">
                <button
                  type="button"
                  onClick={() => setTab('not_registered')}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors inline-flex items-center gap-1.5 ${
                    tab === 'not_registered' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <UserX className="w-3.5 h-3.5" />{t.biometricNotRegisteredTab} ({notRegistered.length})
                </button>
                <button
                  type="button"
                  onClick={() => setTab('registered')}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors inline-flex items-center gap-1.5 ${
                    tab === 'registered' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <UserCheck className="w-3.5 h-3.5" />{t.biometricRegisteredTab} ({registered.length})
                </button>
              </div>
              <div className="relative">
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
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t.biometricSearchPlaceholder}
                  className="pl-9"
                />
              </div>
            </Card>
          </Reveal>

          {noSearchResults ? (
            <Reveal>
              <Card>
                <EmptyState
                  icon={Search}
                  title={t.biometricNoMatchesTitle}
                  description={t.biometricNoMatchesDescTemplate.replace('{q}', search.trim())}
                  action={<Button variant="outline" onClick={() => setSearch('')}>{t.biometricClearSearch}</Button>}
                />
              </Card>
            </Reveal>
          ) : tabEmpty ? (
            <Reveal>
              <Card>
                <EmptyState
                  icon={tab === 'registered' ? UserCheck : UserX}
                  title={tab === 'registered' ? t.biometricRegisteredTab : t.biometricNotRegisteredTab}
                  description={tab === 'registered' ? t.biometricNoOneRegistered : t.biometricEveryoneRegistered}
                />
              </Card>
            </Reveal>
          ) : (
            <>
              <Reveal delay={0.08}>
                <Card className="overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t.biometricColName}</TableHead>
                        <TableHead>{t.biometricColEpf}</TableHead>
                        <TableHead>{t.employeeNumber}</TableHead>
                        <TableHead>{t.biometricFaceIdBadge}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paginated.map((u) => (
                        <TableRow key={u.epf_number}>
                          <TableCell className="font-medium text-foreground">{u.display_name}</TableCell>
                          <TableCell className="text-muted-foreground">{u.epf_number}</TableCell>
                          <TableCell className="text-muted-foreground">{u.employee_number || '—'}</TableCell>
                          <TableCell>
                            {u.face_enrolled ? (
                              <Badge variant="brand">
                                <ScanFace className="w-3 h-3" />{fmtDate(u.face_updated_at)}
                              </Badge>
                            ) : (
                              <Badge variant="muted">{t.biometricNotRegisteredTab}</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              </Reveal>

              {filtered.length > pageSize && (
                <Pagination
                  page={safePage}
                  pageSize={pageSize}
                  total={filtered.length}
                  onPageChange={setPage}
                  onPageSizeChange={setPageSize}
                  pageSizeOptions={[20, 50, 100]}
                />
              )}
            </>
          )}
        </>
      )}
    </PageTransition>
  );
}

export default function BiometricEnrollmentPage() {
  return <BiometricEnrollmentContent />;
}
