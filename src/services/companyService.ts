import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc,
  query, orderBy, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { Company } from '@/lib/types';

const COL = 'companies';

// Companies change rarely but are read on several pages (users, reports, overview).
// Cache at module scope with a short TTL + in-flight coalescing; invalidate on writes.
const COMPANIES_TTL_MS = 10 * 60 * 1000;
let _companiesCache: Company[] | null = null;
let _companiesCachedAt = 0;
let _companiesInflight: Promise<Company[]> | null = null;

export function invalidateCompaniesCache(): void {
  _companiesCache = null;
  _companiesCachedAt = 0;
  _companiesInflight = null;
}

export async function getCompanies(force = false): Promise<Company[]> {
  if (!force && _companiesCache && Date.now() - _companiesCachedAt < COMPANIES_TTL_MS) return _companiesCache;
  if (!force && _companiesInflight) return _companiesInflight;
  _companiesInflight = (async () => {
    const snap = await getDocs(query(collection(db, COL), orderBy('name')));
    const companies = snap.docs.map(d => ({ id: d.id, ...d.data() } as Company));
    _companiesCache = companies;
    _companiesCachedAt = Date.now();
    return companies;
  })();
  try { return await _companiesInflight; } finally { _companiesInflight = null; }
}

export async function getCompany(id: string): Promise<Company | null> {
  const snap = await getDoc(doc(db, COL, id));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as Company;
}

// The Southern Lanka tenant's primary company — same name already used as the default on
// src/app/(pages)/departments/page.tsx. Falls back to the first company alphabetically so
// this stays harmless on a tenant/environment where that exact name doesn't exist (e.g. a
// dev/test database).
const DEFAULT_COMPANY_NAME = 'Southern Lanka Hospitals (Main)';

export function pickDefaultCompanyId(companies: Company[]): string {
  return companies.find(c => c.name === DEFAULT_COMPANY_NAME)?.id ?? companies[0]?.id ?? '';
}

export async function createCompany(name: string, address = '', logo_url = '', accent_color = ''): Promise<string> {
  const ref = await addDoc(collection(db, COL), {
    name,
    address,
    logo_url,
    accent_color,
    supervisor_epfs: [],
    created_at:      Timestamp.now(),
  });
  invalidateCompaniesCache();
  return ref.id;
}

// Patch editable company fields (name / address / logo_url). Used by the admin
// to attach a public logo link without an upload pipeline.
export async function updateCompany(
  id: string,
  patch: Partial<Pick<Company, 'name' | 'address' | 'logo_url' | 'accent_color'>>,
): Promise<void> {
  await updateDoc(doc(db, COL, id), patch);
  invalidateCompaniesCache();
}

export async function addSupervisorToCompany(companyId: string, epf: string): Promise<void> {
  const ref  = doc(db, COL, companyId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data() as Company;
  if (!data.supervisor_epfs.includes(epf)) {
    await updateDoc(ref, { supervisor_epfs: [...data.supervisor_epfs, epf] });
    invalidateCompaniesCache();
  }
}

export async function removeSupervisorFromCompany(companyId: string, epf: string): Promise<void> {
  const ref  = doc(db, COL, companyId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data() as Company;
  await updateDoc(ref, {
    supervisor_epfs: data.supervisor_epfs.filter(e => e !== epf),
  });
  invalidateCompaniesCache();
}
