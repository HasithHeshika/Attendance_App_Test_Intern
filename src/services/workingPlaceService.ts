import {
  collection, doc, getDocs, addDoc, updateDoc, deleteDoc, query, where, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { WorkingPlaceLocation, WorkingPlaceTag, Chamary } from '@/lib/types';

const COL = 'working_places';

// Built-in defaults — used to seed the collection and as a fallback for the selection
// dropdown before an admin has configured anything (so check-out never breaks).
export const DEFAULT_WORKING_PLACES: Array<Pick<WorkingPlaceLocation, 'name' | 'requires_site'>> = [
  { name: 'Colombo - Office', requires_site: false },
  { name: 'Matara - Office',  requires_site: false },
  { name: 'Work From Home',   requires_site: false },
  { name: 'Site',             requires_site: true },
  { name: 'Site - Visit',     requires_site: true },
  { name: 'After - Sales',    requires_site: true },
];

// ─── Working-places cache ───────────────────────────────────────────────────────
// Working places change rarely but are read on hot paths: every check-in / check-out,
// the shift-day resolution behind getMyTodayAttendance (up to 4× per attendance load for
// technicians), and the SmartWorkingPlaceSelect dropdown. Reading the whole collection on
// every call multiplied Firestore reads and stalled the attendance page. Cache per
// activeOnly variant at module scope with a short TTL + in-flight coalescing (one read for
// a burst of parallel callers), invalidated explicitly on every write.
const WP_TTL_MS = 5 * 60 * 1000;
const _wpCache = new Map<boolean, { value: WorkingPlaceLocation[]; at: number }>();
const _wpInflight = new Map<boolean, Promise<WorkingPlaceLocation[]>>();

export function invalidateWorkingPlacesCache(): void {
  _wpCache.clear();
  _wpInflight.clear();
}

export async function getWorkingPlaces(activeOnly = true): Promise<WorkingPlaceLocation[]> {
  const hit = _wpCache.get(activeOnly);
  if (hit && Date.now() - hit.at < WP_TTL_MS) return hit.value;
  const inflight = _wpInflight.get(activeOnly);
  if (inflight) return inflight;

  const p = (async () => {
    const q = activeOnly
      ? query(collection(db, COL), where('is_active', '==', true))
      : query(collection(db, COL));
    const snap = await getDocs(q);
    const list = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as WorkingPlaceLocation))
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));
    _wpCache.set(activeOnly, { value: list, at: Date.now() });
    return list;
  })();
  _wpInflight.set(activeOnly, p);
  try { return await p; } finally { _wpInflight.delete(activeOnly); }
}

export interface WorkingPlaceInput {
  name: string;
  address?: string;
  latitude?: number | null;
  longitude?: number | null;
  radius_m?: number | null;
  requires_site?: boolean;
  tags?: WorkingPlaceTag[];
  supervisor_epfs?: string[];
  chamaries?: Chamary[];
  sort_order?: number;
}

export async function createWorkingPlace(data: WorkingPlaceInput): Promise<string> {
  const ref = await addDoc(collection(db, COL), {
    name:          data.name,
    address:       data.address ?? '',
    latitude:      data.latitude ?? null,
    longitude:     data.longitude ?? null,
    radius_m:      data.radius_m ?? null,
    requires_site: data.requires_site ?? false,
    tags:          data.tags ?? [],
    supervisor_epfs: data.supervisor_epfs ?? [],
    chamaries:     data.chamaries ?? [],
    sort_order:    data.sort_order ?? 0,
    is_active:     true,
    created_at:    Timestamp.now(),
  });
  invalidateWorkingPlacesCache();
  return ref.id;
}

export async function updateWorkingPlace(
  id: string,
  data: Partial<Pick<WorkingPlaceLocation,
    'name' | 'address' | 'latitude' | 'longitude' | 'radius_m' | 'requires_site' | 'tags' | 'supervisor_epfs' | 'chamaries' | 'sort_order' | 'is_active'>>,
): Promise<void> {
  await updateDoc(doc(db, COL, id), data as Record<string, unknown>);
  invalidateWorkingPlacesCache();
}

// A chamary flattened out of its working place — the join the "need lunch" prompt and the
// Food-expense picker both read from. `id` is the chamary's own id (stable across renames);
// `working_place_id`/`working_place_name` say where it physically is.
export interface ChamaryWithPlace extends Chamary {
  working_place_id:   string;
  working_place_name: string;
}

// Every ACTIVE chamary across every ACTIVE working place. This is the single source of truth
// both sides of the mapping read: the check-in "need lunch" prompt picks from the chamaries at
// the matched working place, and a Food-category expense submission picks from this same list
// (see SuspenseCategory.link_to_chamaries) — so a bill's chamary_id always names a real chamary.
//
// `includeInactive` drops both active gates (the working place's and the chamary's own). Only
// the monthly food report asks for it: it enumerates a month that has already happened, and a
// site closing at the end of that month must not retroactively erase the bookings, approved
// spend and per-person deductions it already earned. Every forward-looking caller keeps the
// default, so a deactivated chamary can still never be booked into or billed against.
export async function listAllChamaries(
  { includeInactive = false }: { includeInactive?: boolean } = {},
): Promise<ChamaryWithPlace[]> {
  const places = await getWorkingPlaces(!includeInactive);
  return places.flatMap(p => (p.chamaries ?? [])
    .filter(c => includeInactive || c.is_active)
    .map(c => ({ ...c, working_place_id: p.id, working_place_name: p.name })));
}

// Chamaries at a SPECIFIC working place (e.g. the one a check-in's GPS matched) — what the
// "need lunch" prompt offers, in place-visit order (no cross-site noise).
export async function getChamariesAtPlace(workingPlaceId: string): Promise<Chamary[]> {
  const places = await getWorkingPlaces(true);
  return (places.find(p => p.id === workingPlaceId)?.chamaries ?? []).filter(c => c.is_active);
}

// True when this EPF is listed as a supervisor on ANY working place — used to widen
// Approvals-page access to location supervisors even if their role isn't an approver.
export async function isLocationSupervisor(epf: string): Promise<boolean> {
  if (!epf) return false;
  const snap = await getDocs(collection(db, COL));
  return snap.docs.some(d => {
    const sup = (d.data() as { supervisor_epfs?: unknown }).supervisor_epfs;
    return Array.isArray(sup) && sup.map(String).includes(String(epf));
  });
}

// Permanently remove a working place. Historical attendance stores the place's
// display NAME (a string), not this doc id, so deleting here never orphans past
// records — they keep their recorded name. For a reversible hide, use the
// is_active toggle (updateWorkingPlace) instead.
export async function deleteWorkingPlace(id: string): Promise<void> {
  await deleteDoc(doc(db, COL, id));
  invalidateWorkingPlacesCache();
}

// Seed the standard places if the collection is empty. Returns the count created.
export async function seedDefaultWorkingPlacesIfEmpty(): Promise<number> {
  const existing = await getDocs(collection(db, COL));
  if (!existing.empty) return 0;
  await Promise.all(DEFAULT_WORKING_PLACES.map((p, i) =>
    createWorkingPlace({ name: p.name, requires_site: p.requires_site, sort_order: (i + 1) * 10 })));
  invalidateWorkingPlacesCache();
  return DEFAULT_WORKING_PLACES.length;
}
