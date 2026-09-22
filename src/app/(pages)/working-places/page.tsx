'use client';
import { useState, useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Portal from '@/components/Portal';
import { MapPin, Plus, Edit2, Trash2, X, Save, ToggleLeft, ToggleRight, Crosshair, RefreshCw, ExternalLink, Link2, Hash, Loader2, Check, CheckCircle2, ListChecks, Sun, UtensilsCrossed } from 'lucide-react';
import toast from 'react-hot-toast';
import SearchableSelect, { type SearchOption } from '@/components/SearchableSelect';
import { useSolarSites } from '@/components/useSolarSites';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { useT } from '@/store/appStore';
import { useWorkingPlacesStore } from '@/store/workingPlacesStore';
import {
  getWorkingPlaces, createWorkingPlace, updateWorkingPlace, deleteWorkingPlace, seedDefaultWorkingPlacesIfEmpty,
} from '@/services/workingPlaceService';
import { getAllUsers } from '@/services/userService';
import { listSuspenseCategories, updateCategory as updateSuspenseCategory, newSubcategoryId } from '@/services/suspenseService';
import {
  requestDeviceLocation, mapsLink, parseGoogleMapsLink, decodePlusCode, isValidLatLng,
  isShortPlusCode, splitPlusCode, recoverPlusCode, geocodePlace, DEFAULT_RADIUS_M,
} from '@/lib/geo';
import {
  chamaryMeals, mealSlots, mealWindowLabel, minutesToTimeInput, timeInputToMinutes,
  DEFAULT_MEAL_SLOTS, MEAL_TYPES, MEAL_ORDER, type MealType, type MealSlots,
} from '@/lib/meals';
import { ROLE_CATEGORY_OPTIONS, categoryLabel, type RoleCategory } from '@/lib/permissions';
import LeafletMiniMap from '@/components/LeafletMiniMap';
import OutstationManager from '@/components/OutstationManager';
import Combobox from '@/components/Combobox';
import ConfirmModal from '@/components/ConfirmModal';
import InlineError from '@/components/InlineError';
import type { WorkingPlaceLocation, WorkingPlaceTag, AppUser, Chamary, SuspenseCategory } from '@/lib/types';
import { WORKING_PLACE_TAGS } from '@/lib/types';
import { tenant } from '@/lib/firebase';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeaderSkeleton, ListSkeleton, StatCardsSkeleton } from '@/components/ui/Skeleton';
import { PageTransition, Reveal, Stagger, StaggerItem, MotionCard } from '@/components/ui/motion';

type LocMethod = 'latlng' | 'maps' | 'plus';
interface FormState {
  name: string; address: string;
  locMethod: LocMethod;
  latitude: string; longitude: string;   // used when locMethod = 'latlng'
  mapsLink: string;                        // used when locMethod = 'maps'
  plusCode: string;                        // used when locMethod = 'plus'
  radius: string;                          // geofence radius (metres)
  requires_site: boolean; tags: WorkingPlaceTag[]; sort_order: string;
  supervisor_epfs: string[];   // EPF numbers of this location's assigned supervisors
  chamaries: Chamary[];        // canteens at this place (suspense/food module)
}
const emptyForm: FormState = {
  name: '', address: '', locMethod: 'latlng',
  latitude: '', longitude: '', mapsLink: '', plusCode: '', radius: '',
  requires_site: false, tags: [], sort_order: '', supervisor_epfs: [], chamaries: [],
};

// Short, human descriptions for each working-place tag (shown beside the checkboxes).
const TAG_META: Record<WorkingPlaceTag, { label: string; desc: string }> = {
  primary: { label: 'Primary', desc: 'Base / default place — the 60km outstation reference when no schedule is set.' },
  shift:   { label: 'Shift',   desc: 'Checking in here lets a technician work a shift that day (overnight check-out allowed).' },
  site:    { label: 'Site',    desc: 'Site-type location classifier.' },
};

// The suspense-link fields a ChamaryCategoryLink patch can carry. A key the patch spells out as
// `undefined` means CLEAR that field (the category changed, or the link was removed) — NOT "leave
// it as it was" — so mergeChamaryLink DELETES it instead of spreading it in. An explicit
// `undefined` reaching Firestore fails the whole working-place write ("Unsupported field value:
// undefined"), and spreading the patch without the key would keep the stale link instead. Deleting
// is enough to clear it: `chamaries` is written as a whole array, so a key that isn't in the object
// isn't in the stored document either.
type ChamaryLinkPatch = { category_id?: string; category_name?: string; subcategory_id?: string; subcategory_name?: string };
function mergeChamaryLink<T extends ChamaryLinkPatch>(base: T, patch: ChamaryLinkPatch): T {
  const merged: Record<string, unknown> = { ...base, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete merged[k];
  return merged as T;
}

// Cascading category → subcategory picker for a chamary's suspense link. A subcategory is an
// ORDINARY SuspenseSubcategory (managed in Settings) — this just links to one, by picking an
// existing one or creating a new one named after the chamary on the fly. `chamary` only needs
// enough shape to drive the UI; works identically for an already-added chamary (from
// form.chamaries) and the not-yet-created add-row draft (id: '').
function ChamaryCategoryLink({ chamary, categories, checkTaken, onChange, createSubcategory }: {
  chamary: { id: string; name: string; category_id?: string; category_name?: string; subcategory_id?: string; subcategory_name?: string };
  categories: SuspenseCategory[];
  checkTaken: (subcategoryId: string, excludeChamaryId: string) => string | null;
  onChange: (patch: { category_id?: string; category_name?: string; subcategory_id?: string; subcategory_name?: string }) => void;
  createSubcategory: (categoryId: string, name: string) => Promise<{ id: string; name: string } | null>;
}) {
  const [creating, setCreating] = useState(false);
  const cat = categories.find(c => c.id === chamary.category_id) ?? null;
  const subOptions = cat?.subcategories ?? [];

  const pickCategory = (v: string) => {
    if (v === chamary.category_id) return;
    const c = categories.find(x => x.id === v);
    // Changing category invalidates any linked subcategory — it belonged to the old category.
    onChange({ category_id: c?.id, category_name: c?.name, subcategory_id: undefined, subcategory_name: undefined });
  };
  const pickSubcategory = (v: string) => {
    const s = subOptions.find(x => x.id === v);
    if (!s) return;
    const takenBy = checkTaken(s.id, chamary.id);
    if (takenBy) { toast.error(`That subcategory is already linked to “${takenBy}”.`); return; }
    onChange({ subcategory_id: s.id, subcategory_name: s.name });
  };
  const createAndLink = async () => {
    if (!cat || !chamary.name.trim()) return;
    setCreating(true);
    const made = await createSubcategory(cat.id, chamary.name);
    setCreating(false);
    if (made) onChange({ subcategory_id: made.id, subcategory_name: made.name });
  };
  const clear = () => onChange({ category_id: undefined, category_name: undefined, subcategory_id: undefined, subcategory_name: undefined });

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="shrink-0 text-[11px] text-muted-foreground">Category:</span>
      <div className="w-36">
        <Combobox value={chamary.category_id ?? ''} onChange={pickCategory} allowCustom={false} placeholder="None"
          options={categories.map(c => ({ value: c.id, label: c.name }))} />
      </div>
      {chamary.category_id && (
        <>
          <span className="shrink-0 text-[11px] text-muted-foreground">Subcategory:</span>
          <div className="w-36">
            <Combobox value={chamary.subcategory_id ?? ''} onChange={pickSubcategory} allowCustom={false} placeholder="None"
              options={subOptions.map(s => ({ value: s.id, label: s.name }))} />
          </div>
          {!chamary.subcategory_id && (
            <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-[11px]"
              disabled={creating || !chamary.name.trim()} onClick={createAndLink}>
              {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : `+ New “${chamary.name.trim() || '…'}”`}
            </Button>
          )}
        </>
      )}
      {(chamary.category_id || chamary.subcategory_id) && (
        <button type="button" aria-label="Clear suspense link" onClick={clear}
          className="text-muted-foreground transition-colors hover:text-destructive"><X className="h-3 w-3" /></button>
      )}
    </div>
  );
}

// Which meals a chamary serves (Chamary.meals). Read through chamaryMeals() so a chamary saved
// before meal types existed shows as lunch — the value it has always behaved as. Unticking the
// LAST meal is blocked rather than allowed: an empty array reads back as lunch-only, so the
// admin would see a chamary they just emptied come back serving lunch.
function ChamaryMealsPicker({ meals, onChange }: {
  meals: MealType[] | undefined;
  onChange: (meals: MealType[]) => void;
}) {
  const t = useT();
  const current = chamaryMeals(meals);
  const label = (m: MealType) => (m === 'breakfast' ? t.mealBreakfast : m === 'lunch' ? t.mealLunch : t.mealDinner);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="shrink-0 text-[11px] text-muted-foreground">{t.mealsLabel}:</span>
      <div className="flex flex-wrap gap-1">
        {MEAL_TYPES.map(m => {
          const on = current.includes(m);
          // The only selected meal can't be switched off — an empty array reads back as lunch-only
          // (see chamaryMeals), which would silently contradict what the admin just did.
          const locked = on && current.length === 1;
          return (
            <button
              key={m}
              type="button"
              aria-pressed={on}
              disabled={locked}
              title={locked ? 'A chamary must serve at least one meal.' : undefined}
              onClick={() => onChange(
                (on ? current.filter(x => x !== m) : [...current, m]).sort((a, b) => MEAL_ORDER[a] - MEAL_ORDER[b]),
              )}
              className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors ${
                on
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground'
              } ${locked ? 'cursor-default' : 'cursor-pointer'}`}
            >
              {on && <Check className="h-3 w-3 shrink-0" />}
              {label(m)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// When each meal stops being orderable here (Chamary.slots). Two boundaries rather than three
// ranges, because the day is a partition — see MealSlots in src/lib/meals.ts. That is what makes
// "lunch until 12pm" a single number an admin can move, with no way to leave a gap nobody can
// order in or an overlap where two meals are open at once.
//
// Only the boundaries that touch a meal this chamary actually serves are shown; each one is
// labelled by what it means for THOSE meals ("Lunch until / dinner from"), because the same
// instant is the end of one meal and the start of the next.
function ChamaryMealTimesPicker({ meals, slots, onChange }: {
  meals:  MealType[] | undefined;
  slots:  MealSlots | undefined;
  onChange: (slots: MealSlots) => void;
}) {
  const t = useT();
  const served = chamaryMeals(meals);
  const s = mealSlots(slots);
  const has = (m: MealType) => served.includes(m);

  const mealLabel = (m: MealType) => (m === 'breakfast' ? t.mealBreakfast : m === 'lunch' ? t.mealLunch : t.mealDinner);
  const showLunchFrom  = has('breakfast') || has('lunch');
  const showDinnerFrom = has('lunch') || has('dinner');
  const lunchFromLabel = has('breakfast') && has('lunch') ? `${t.mealBreakfast} until / ${t.mealLunch.toLowerCase()} from`
    : has('lunch') ? `${t.mealLunch} from` : `${t.mealBreakfast} until`;
  const dinnerFromLabel = has('lunch') && has('dinner') ? `${t.mealLunch} until / ${t.mealDinner.toLowerCase()} from`
    : has('dinner') ? `${t.mealDinner} from` : `${t.mealLunch} until`;

  // Moving one boundary past the other would leave the meal between them with a zero-length
  // window (never orderable). Drag the other boundary along instead of silently closing a meal.
  const setLunchFrom  = (v: number) => onChange(mealSlots({ lunch_from: v, dinner_from: Math.max(s.dinner_from, v) }));
  const setDinnerFrom = (v: number) => onChange(mealSlots({ lunch_from: Math.min(s.lunch_from, v), dinner_from: v }));

  const field = (label: string, value: number, onSet: (v: number) => void) => (
    <label className="flex items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input
        type="time"
        value={minutesToTimeInput(value)}
        onChange={e => onSet(timeInputToMinutes(e.target.value, value))}
        className="h-7 rounded-md border border-border bg-background px-2 text-[11px] text-foreground tabular-nums focus:border-primary focus:outline-none"
      />
    </label>
  );

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="shrink-0 text-[11px] text-muted-foreground">{t.mealTimesLabel}:</span>
        {showLunchFrom  && field(lunchFromLabel,  s.lunch_from,  setLunchFrom)}
        {showDinnerFrom && field(dinnerFromLabel, s.dinner_from, setDinnerFrom)}
      </div>
      {/* Read the rule back in plain hours, so the admin can check the two numbers they typed
          against the three windows staff will actually see. */}
      <div className="ml-0 text-[11px] text-muted-foreground/80">
        {served.map(m => `${mealLabel(m)} ${mealWindowLabel(m, s)}`).join(' · ')}
      </div>
    </div>
  );
}

// Which employee categories (Technician/Executive/Top Management) may book this chamary.
// Unlike meals, an EMPTY selection is a valid, meaningful state — "open to everyone" — so
// nothing here is locked; toggling the last category off just goes back to that default (see
// categoryAllowed in @/lib/permissions).
function ChamaryCategoriesPicker({ categories, onChange }: {
  categories: RoleCategory[] | undefined;
  onChange: (categories: RoleCategory[]) => void;
}) {
  const current = categories ?? [];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="shrink-0 text-[11px] text-muted-foreground">Open to:</span>
      <div className="flex flex-wrap gap-1">
        {ROLE_CATEGORY_OPTIONS.map(o => {
          const on = current.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              title={o.desc}
              onClick={() => onChange(on ? current.filter(x => x !== o.value) : [...current, o.value])}
              className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors cursor-pointer ${
                on
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground'
              }`}
            >
              {on && <Check className="h-3 w-3 shrink-0" />}
              {categoryLabel(o.value)}
            </button>
          );
        })}
      </div>
      {current.length === 0 && (
        <span className="text-[11px] text-muted-foreground/70">(everyone)</span>
      )}
    </div>
  );
}

export default function WorkingPlacesAdminPage() {
  const { user } = useAuthStore();
  const caps = useUserCapabilities();
  const reloadStore = useWorkingPlacesStore(s => s.load);
  const t = useT();

  const [places,  setPlaces]  = useState<WorkingPlaceLocation[]>([]);
  // Users for the location-supervisor picker. Any user can be assigned (assignment grants the right).
  const [users,   setUsers]   = useState<AppUser[]>([]);
  useEffect(() => { getAllUsers().then(setUsers).catch(() => {}); }, []);
  // Suspense categories for the per-chamary category picker (a chamary declares which category
  // its bills fall under, right here — see the Chamaries section below). Alta Vision only.
  const [categories, setCategories] = useState<SuspenseCategory[]>([]);
  useEffect(() => { if (tenant.features.suspense) listSuspenseCategories().then(setCategories).catch(() => {}); }, []);

  // Add a new subcategory named after a chamary to a category, and return it — used by "+ New
  // '<chamary name>'" when no existing subcategory fits. Updates local `categories` too so it's
  // immediately pickable without a reload.
  const createSubcategoryForChamary = async (categoryId: string, name: string): Promise<{ id: string; name: string } | null> => {
    const cat = categories.find(c => c.id === categoryId);
    const trimmed = name.trim();
    if (!cat || !trimmed) return null;
    if (cat.subcategories.some(s => s.name.toLowerCase() === trimmed.toLowerCase())) {
      toast.error('A subcategory with that name already exists in this category — pick it from the list instead.');
      return null;
    }
    const newSub = { id: newSubcategoryId(), name: trimmed, allow_split: false, type_id: null as string | null };
    try {
      await updateSuspenseCategory(categoryId, { subcategories: [...cat.subcategories, newSub] });
      setCategories(cs => cs.map(c => (c.id === categoryId ? { ...c, subcategories: [...c.subcategories, newSub] } : c)));
      return newSub;
    } catch { toast.error('Failed to create the subcategory.'); return null; }
  };

  // A subcategory should map to AT MOST one chamary (a suspense submission resolving to it
  // stamps a SINGLE chamary_id) — check every OTHER chamary, across every OTHER working place
  // plus this place's own in-progress draft, before linking. Returns the other chamary's name
  // if taken, else null. `places` still holds this SAME place's pre-edit snapshot while editing,
  // so it's skipped in favour of the live `form.chamaries` draft.
  const chamarySubcategoryTakenBy = (subcategoryId: string, excludeChamaryId: string): string | null => {
    for (const p of places) {
      if (p.id === editId) continue;
      for (const c of p.chamaries ?? []) {
        if (c.id !== excludeChamaryId && c.subcategory_id === subcategoryId) return c.name;
      }
    }
    for (const c of form.chamaries) {
      if (c.id !== excludeChamaryId && c.subcategory_id === subcategoryId) return c.name;
    }
    return null;
  };

  const userName = (epf: string) => {
    const u = users.find(x => String(x.epf_number) === String(epf));
    return u ? (u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || String(epf)) : String(epf);
  };
  const [loading, setLoading] = useState(true);
  const [busy,    setBusy]    = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editId,  setEditId]  = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<WorkingPlaceLocation | null>(null);
  const [form,    setForm]    = useState<FormState>(emptyForm);
  const [saving,  setSaving]  = useState(false);
  // Show the "name required" error only after a save attempt — a fresh form opens clean.
  const [triedSave, setTriedSave] = useState(false);
  const [locating, setLocating] = useState(false);
  const [plusBusy, setPlusBusy] = useState(false);
  const [plusResolved, setPlusResolved] = useState<{ forCode: string; lat: number; lng: number } | null>(null);
  const [solarPick, setSolarPick] = useState('');   // selected Solar site (siteNo) in the import picker
  // Responsible-person options, shared by the add-chamary form and every saved chamary's
  // in-place picker below.
  const userOptions = useMemo<SearchOption[]>(() => users
    .filter(u => u.epf_number)
    .map(u => ({
      value: String(u.epf_number),
      label: u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || String(u.epf_number),
      sublabel: [String(u.epf_number), u.role].filter(Boolean).join(' · ') || undefined,
      keywords: `${u.epf_number} ${u.email ?? ''} ${u.role ?? ''}`,
    } as SearchOption)), [users]);
  // Draft chamary (canteen) being added in the form's Chamaries section. The draft panel is
  // collapsed behind an "Add a chamary" button — expanded it is five pickers tall, which
  // swamped the rest of the place form for the common case of not adding one.
  const [showAddChamary, setShowAddChamary] = useState(false);
  const [chName, setChName] = useState('');
  const [chResp, setChResp] = useState('');   // responsible person's EPF
  const [chMeals, setChMeals] = useState<MealType[]>(['lunch']);   // meals the new chamary serves
  const [chSlots, setChSlots] = useState<MealSlots>(DEFAULT_MEAL_SLOTS);   // when each of those meals closes
  const [chCategories, setChCategories] = useState<RoleCategory[]>([]);   // empty = open to everyone
  // Suspense category/subcategory this chamary's bills fall under (optional; set via
  // ChamaryCategoryLink below — a subcategory can be picked from the category's existing
  // list, or created on the fly named after the chamary).
  const [chLink, setChLink] = useState<{ category_id?: string; category_name?: string; subcategory_id?: string; subcategory_name?: string }>({});

  // Solar-app import is an Alta Vision-only cross-integration (tenant.features.solarApp) —
  // hidden entirely for tenants without it (e.g. Southern Lanka), where it's just noise.
  const solarImportEnabled = tenant.features.solarApp;
  // Solar app installed sites — only fetched while the form is open AND this tenant has the
  // Solar cross-link. Served from the shared server-side hourly cache (no per-open upstream call).
  const solarSites = useSolarSites(showForm && solarImportEnabled);
  const solarSiteOptions = useMemo<SearchOption[]>(() => solarSites.map(s => ({
    value: s.siteNo,
    label: s.name,
    sublabel: [s.siteNo, s.address].filter(Boolean).join(' · ') || undefined,
    badge: 'site',
    keywords: `${s.siteNo} ${s.projectNo ?? ''} ${s.address ?? ''} ${s.name}`,
  })), [solarSites]);

  // Picking a Solar site prefills name, address and GPS (lat/lng) — the admin can still edit.
  const applySolarSite = (siteNo: string) => {
    setSolarPick(siteNo);
    const s = solarSites.find(x => x.siteNo === siteNo);
    if (!s) return;
    setForm(f => ({
      ...f,
      name: s.name,
      address: s.address ?? '',
      locMethod: 'latlng',
      latitude:  s.lat != null ? s.lat.toFixed(6) : '',
      longitude: s.lng != null ? s.lng.toFixed(6) : '',
    }));
    toast.success(`Loaded “${s.name}” from Solar`);
  };

  // `silent` re-fetches without flipping the full-page skeleton, so a mutation updates the
  // list in place instead of remounting it (which replays the entrance animations — the
  // "whole page resets" effect).
  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try { setPlaces(await getWorkingPlaces(false)); }
    catch (e) { console.error(e); }
    finally    { if (!silent) setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => { setForm(emptyForm); setEditId(null); setSolarPick(''); setChName(''); setChResp(''); setChMeals(['lunch']); setChSlots(DEFAULT_MEAL_SLOTS); setChCategories([]); setChLink({}); setShowAddChamary(false); setTriedSave(false); setShowForm(true); };
  const openEdit = (p: WorkingPlaceLocation) => {
    setSolarPick(''); setChName(''); setChResp(''); setChMeals(['lunch']); setChCategories([]); setChLink({}); setShowAddChamary(false); setTriedSave(false);
    setForm({
      name: p.name, address: p.address ?? '', locMethod: 'latlng',
      latitude: p.latitude != null ? String(p.latitude) : '',
      longitude: p.longitude != null ? String(p.longitude) : '',
      mapsLink: '', plusCode: '', radius: p.radius_m != null ? String(p.radius_m) : '',
      requires_site: !!p.requires_site, tags: p.tags ?? [],
      sort_order: p.sort_order != null ? String(p.sort_order) : '',
      supervisor_epfs: p.supervisor_epfs ?? [],
      chamaries: p.chamaries ?? [],
    });
    setEditId(p.id); setShowForm(true);
  };

  // Switching the GPS input method clears the other methods' fields, so the form only ever
  // holds coordinates for the method that's currently selected — no stale lat/lng lingering
  // behind a Maps link (or vice-versa) that could be read back on a later switch.
  const setLocMethod = (m: LocMethod) =>
    setForm(f => ({
      ...f,
      locMethod: m,
      latitude:  m === 'latlng' ? f.latitude  : '',
      longitude: m === 'latlng' ? f.longitude : '',
      mapsLink:  m === 'maps'   ? f.mapsLink   : '',
      plusCode:  m === 'plus'   ? f.plusCode   : '',
    }));

  const useMyLocation = async () => {
    setLocating(true);
    const r = await requestDeviceLocation();
    setLocating(false);
    if (!r.ok) { toast.error(r.reason, { duration: 6000 }); return; }
    setForm(f => ({ ...f, locMethod: 'latlng', latitude: r.lat.toFixed(6), longitude: r.lng.toFixed(6) }));
    toast.success(t.locationCaptured);
  };

  // Resolve the chosen input method into coordinates (or an error / empty).
  const resolveCoords = (f: FormState): { lat: number | null; lng: number | null; error: string | null } => {
    if (f.locMethod === 'latlng') {
      const latS = f.latitude.trim(), lngS = f.longitude.trim();
      if (latS === '' && lngS === '') return { lat: null, lng: null, error: null }; // GPS optional
      if (latS === '' || lngS === '') return { lat: null, lng: null, error: t.enterBothLatLng };
      const lat = Number(latS), lng = Number(lngS);
      if (!isValidLatLng(lat, lng)) return { lat: null, lng: null, error: t.invalidLatLng };
      return { lat, lng, error: null };
    }
    if (f.locMethod === 'maps') {
      if (!f.mapsLink.trim()) return { lat: null, lng: null, error: null };
      const c = parseGoogleMapsLink(f.mapsLink);
      return c ? { lat: c.lat, lng: c.lng, error: null }
               : { lat: null, lng: null, error: t.mapsLinkError };
    }
    if (!f.plusCode.trim()) return { lat: null, lng: null, error: null };
    const c = decodePlusCode(f.plusCode);
    if (c) return { lat: c.lat, lng: c.lng, error: null };
    if (isShortPlusCode(f.plusCode)) {
      const { locality } = splitPlusCode(f.plusCode);
      if (!locality) return { lat: null, lng: null, error: t.addPlaceNameAfterCode };
      if (plusResolved && plusResolved.forCode === f.plusCode) return { lat: plusResolved.lat, lng: plusResolved.lng, error: null };
      if (plusBusy) return { lat: null, lng: null, error: null }; // resolving…
      return { lat: null, lng: null, error: t.couldntFindPlace.replace('{x}', locality) };
    }
    return { lat: null, lng: null, error: t.invalidPlusCode };
  };

  // Auto-resolve a short Plus Code (geocode its place name + recover) as the user
  // types — debounced, no button. Full codes need no lookup.
  useEffect(() => {
    if (form.locMethod !== 'plus') return;
    const raw = form.plusCode;
    if (!raw.trim() || !isShortPlusCode(raw)) return;
    const { code, locality } = splitPlusCode(raw);
    if (!locality) return;
    if (plusResolved?.forCode === raw) return; // already resolved this exact input
    let cancelled = false;
    setPlusBusy(true);
    const t = setTimeout(async () => {
      const ref = await geocodePlace(locality);
      const c = ref ? recoverPlusCode(code, ref.lat, ref.lng) : null;
      if (cancelled) return;
      setPlusBusy(false);
      setPlusResolved(c ? { forCode: raw, lat: c.lat, lng: c.lng } : null);
    }, 700);
    return () => { cancelled = true; clearTimeout(t); };
  }, [form.locMethod, form.plusCode, plusResolved]);

  const handleSave = async () => {
    setTriedSave(true);
    if (!form.name.trim()) { toast.error(t.nameRequired); return; }
    const coords = resolveCoords(form);
    if (coords.error) { toast.error(coords.error); return; }
    const lat = coords.lat, lng = coords.lng;
    const sort_order = form.sort_order.trim() === '' ? undefined : Number(form.sort_order);
    const radius_m = form.radius.trim() === '' ? null : Number(form.radius);
    if (radius_m !== null && (isNaN(radius_m) || radius_m < 0)) { toast.error(t.validRadius); return; }

    // Enforce uniqueness: a working place must be unique by NAME and by LOCATION.
    // If this save collides with another place, merge into it instead of creating a
    // duplicate — union the tags, keep it active, and (when editing) drop the now
    // redundant original. ~25 m of slack treats GPS jitter as the "same spot".
    const nameKey = form.name.trim().toLowerCase();
    const COORD_EPS = 0.000225;   // ≈ 25 m in degrees
    const conflict = places.find(p => p.id !== editId && (
      p.name.trim().toLowerCase() === nameKey ||
      (lat != null && lng != null && p.latitude != null && p.longitude != null &&
        Math.abs(p.latitude - lat) < COORD_EPS && Math.abs(p.longitude - lng) < COORD_EPS)
    ));

    setSaving(true);
    try {
      if (conflict) {
        // Merge into the conflicting place (same name or same spot) rather than duplicate.
        const mergedTags = Array.from(new Set([...(conflict.tags ?? []), ...form.tags]));
        // Chamaries are UNIONED, exactly like tags above. updateWorkingPlace does an updateDoc,
        // so sending the form's array alone replaced the target's wholesale and destroyed every
        // chamary that place already had — along with the suspense subcategory link its food
        // bills are recovered through. Existing entries are matched by id, then by
        // case-insensitive name, so re-saving a place cannot duplicate a canteen either.
        const byId = new Map((conflict.chamaries ?? []).map(c => [c.id, c] as const));
        const byName = new Set((conflict.chamaries ?? []).map(c => c.name.trim().toLowerCase()));
        for (const c of form.chamaries) {
          if (byId.has(c.id)) { byId.set(c.id, c); continue; }    // same chamary — keep the edit
          if (byName.has(c.name.trim().toLowerCase())) continue;  // same canteen under a new id
          byId.set(c.id, c);
          byName.add(c.name.trim().toLowerCase());
        }
        await updateWorkingPlace(conflict.id, {
          name: form.name.trim(), address: form.address.trim(),
          latitude: lat, longitude: lng, radius_m, requires_site: form.requires_site,
          tags: mergedTags, is_active: true, supervisor_epfs: form.supervisor_epfs,
          chamaries: Array.from(byId.values()),
          ...(sort_order != null ? { sort_order } : {}),
        });
        // Editing a *different* record into a duplicate → remove the leftover original.
        if (editId && editId !== conflict.id) await deleteWorkingPlace(editId);
        toast.success(t.workingPlaceMerged);
      } else if (editId) {
        await updateWorkingPlace(editId, {
          name: form.name.trim(), address: form.address.trim(),
          latitude: lat, longitude: lng, radius_m, requires_site: form.requires_site, tags: form.tags,
          supervisor_epfs: form.supervisor_epfs, chamaries: form.chamaries,
          ...(sort_order != null ? { sort_order } : {}),
        });
        toast.success(t.workingPlaceUpdated);
      } else {
        await createWorkingPlace({
          name: form.name.trim(), address: form.address.trim(),
          latitude: lat, longitude: lng, radius_m, requires_site: form.requires_site, tags: form.tags,
          supervisor_epfs: form.supervisor_epfs, chamaries: form.chamaries, sort_order,
        });
        toast.success(t.workingPlaceCreated);
      }
      setShowForm(false);
      await load(true);
      reloadStore(true);
    } catch { toast.error(t.failedToSave); }
    finally  { setSaving(false); }
  };

  const toggleActive = async (p: WorkingPlaceLocation) => {
    try {
      await updateWorkingPlace(p.id, { is_active: !p.is_active });
      toast.success(p.is_active ? t.deactivatedWord : t.activatedWord);
      await load(true); reloadStore(true);
    } catch { toast.error(t.failedGeneric); }
  };

  const handleDelete = async (p: WorkingPlaceLocation) => {
    setDeletingId(p.id);
    try {
      await deleteWorkingPlace(p.id);
      toast.success(t.workingPlaceDeleted);
      // If the deleted place was open in the editor, close the stale form.
      if (editId === p.id) setShowForm(false);
      await load(true); reloadStore(true);
    } catch { toast.error(t.failedGeneric); }
    finally  { setDeletingId(null); }
  };

  const handleSeed = async () => {
    setBusy(true);
    try {
      const n = await seedDefaultWorkingPlacesIfEmpty();
      toast.success(n > 0 ? t.defaultPlacesAdded.replace('{n}', String(n)) : t.placesAlreadyExist);
      await load(true); reloadStore(true);
    } catch { toast.error(t.failedToInitialize); }
    finally  { setBusy(false); }
  };

  if (user?.capabilities && !caps.can_manage_users) {
    return <div className="text-muted-foreground p-10 text-center">{t.noAccessSection}</div>;
  }
  if (loading) return (
    <div className="space-y-6">
      <PageHeaderSkeleton />
      <StatCardsSkeleton />
      <ListSkeleton rows={6} />
    </div>
  );

  const coords = resolveCoords(form); // live preview of the chosen location method
  // Live form validation — mirrors the guards in handleSave so the Save button and
  // inline messages stay in sync with what a submit would actually reject.
  const nameError = !form.name.trim() ? t.nameRequired : '';
  const radiusNum = form.radius.trim() === '' ? null : Number(form.radius);
  const radiusError = radiusNum !== null && (isNaN(radiusNum) || radiusNum < 0) ? t.validRadius : '';
  const saveDisabled = saving || !!nameError || !!coords.error || !!radiusError;

  // KPI summary (derived from loaded places — display only)
  const activeCount = places.filter(p => p.is_active).length;
  const gpsCount = places.filter(p => p.latitude != null && p.longitude != null).length;
  const siteCount = places.filter(p => p.requires_site).length;

  return (
    <PageTransition className="space-y-6">
      <PageHeader
        title={t.workingPlacesTitle}
        description={t.workingPlacesDesc}
        icon={MapPin}
        actions={
          <>
            {places.length === 0 && (
              <Button variant="outline" onClick={handleSeed} disabled={busy}>
                <RefreshCw className="w-4 h-4" />{t.initializeDefaults}
              </Button>
            )}
            <Button onClick={openCreate}>
              <Plus className="w-4 h-4" />{t.addPlace}
            </Button>
          </>
        }
      />

      {/* KPI summary */}
      <Stagger className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StaggerItem>
          <StatCard label={t.totalPlaces} value={places.length} icon={MapPin} tone="primary" />
        </StaggerItem>
        <StaggerItem>
          <StatCard label={t.statusActive} value={activeCount} icon={CheckCircle2} tone="success"
            hint={places.length > 0 ? `${places.length - activeCount} ${t.inactiveLower}` : undefined} />
        </StaggerItem>
        <StaggerItem>
          <StatCard label={t.gpsTagged} value={gpsCount} icon={Crosshair} tone="brand" />
        </StaggerItem>
        <StaggerItem>
          <StatCard label={t.requireSiteNum} value={siteCount} icon={ListChecks} tone="primary" wrapLabel />
        </StaggerItem>
      </Stagger>

      {/* Primary content: the canonical list */}
      <Reveal>
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>{t.workingPlacesLower}</CardTitle>
            <Badge variant="muted">{places.length} {t.totalWord}</Badge>
          </CardHeader>
          <CardContent>
            {places.length === 0 ? (
              <EmptyState
                icon={MapPin}
                title={t.noWorkingPlacesYet}
                description={t.noWorkingPlacesDesc}
              />
            ) : (
              <Stagger className="space-y-3">
                {places.map(p => (
                  <StaggerItem key={p.id}>
                    <MotionCard className={`glass rounded-xl shadow-card p-4 flex items-center gap-4 ${!p.is_active ? 'opacity-60' : ''}`}>
                      <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <MapPin className="w-4 h-4 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-foreground flex items-center gap-2 flex-wrap">
                          {p.name}
                          {p.requires_site && <Badge variant="brand">{t.siteHash}</Badge>}
                          {(p.tags ?? []).map(tag => (
                            <Badge key={tag} variant="muted" className="capitalize">{tag}</Badge>
                          ))}
                        </div>
                        {/* Column on mobile, row from sm: up — address, GPS link and radius
                            are three differently-shaped pieces (plain text, an icon+text+icon
                            link, another text span); wrapped together in one items-center row
                            they don't share a baseline once they don't all fit on one line,
                            which read as "staggered". A left-aligned vertical stack at narrow
                            widths keeps each piece on its own clean line instead. */}
                        <div className="text-xs text-muted-foreground mt-0.5 flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2 sm:flex-wrap">
                          {p.address && <span className="max-w-full truncate">{p.address}</span>}
                          {p.latitude != null && p.longitude != null && (
                            <a href={mapsLink(p.latitude, p.longitude)} target="_blank" rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-primary hover:text-primary/80">
                              <Crosshair className="w-3 h-3 flex-shrink-0" />{p.latitude.toFixed(4)}, {p.longitude.toFixed(4)}<ExternalLink className="w-3 h-3 flex-shrink-0" />
                            </a>
                          )}
                          {p.latitude != null && p.longitude != null && (
                            <span className="text-muted-foreground before:content-['·'] before:mr-2 before:hidden sm:before:inline">
                              {p.radius_m ?? DEFAULT_RADIUS_M} {t.mRadiusSuffix}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Badge variant={p.is_active ? 'success' : 'muted'}>
                          {p.is_active ? t.statusActive : t.inactiveWord}
                        </Badge>
                        <Button variant="ghost" size="icon-sm" onClick={() => openEdit(p)} aria-label={t.editLocationAria} title={t.editLocationAria} className="text-muted-foreground hover:text-primary"><Edit2 className="w-3.5 h-3.5" /></Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => toggleActive(p)} aria-label={p.is_active ? t.deactivateLocationAria : t.activateLocationAria} title={p.is_active ? t.deactivateLocationAria : t.activateLocationAria} className="text-muted-foreground hover:text-foreground">
                          {p.is_active ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => setConfirmDelete(p)} disabled={deletingId === p.id} aria-label={t.deleteWord} title={t.deleteWord} className="text-muted-foreground hover:text-destructive">
                          {deletingId === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        </Button>
                      </div>
                    </MotionCard>
                  </StaggerItem>
                ))}
              </Stagger>
            )}
          </CardContent>
        </Card>
      </Reveal>

      {/* Secondary content: Outstation locations — merged into this page */}
      <Reveal delay={0.05}>
        <OutstationManager />
      </Reveal>

      {/* Portalled to <body>: a `fixed inset-0` overlay nested inside PageTransition (whose
          enter animation leaves an active transform in place) gets its containing block
          hijacked to PageTransition's own box instead of the viewport. */}
      <Portal>
      <AnimatePresence>
        {showForm && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              className="w-full max-w-md bg-card border border-border rounded-xl shadow-popover p-6 space-y-4 max-h-[85vh] overflow-y-auto">
              <div className="flex items-center justify-between">
                <div className="text-base font-semibold text-foreground">{editId ? t.editWorkingPlace : t.newWorkingPlace}</div>
                <Button variant="ghost" size="icon-sm" onClick={() => setShowForm(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></Button>
              </div>

              {/* Import from the Solar app — pick an installed site to prefill name, address & GPS.
                  Alta Vision-only cross-integration (see solarImportEnabled). */}
              {solarImportEnabled && (
                <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5">
                  <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <Sun className="w-3.5 h-3.5" /> Import from Solar app
                  </Label>
                  <SearchableSelect
                    value={solarPick}
                    onChange={applySolarSite}
                    options={solarSiteOptions}
                    placeholder={solarSites.length ? 'Search a Solar site by name, no. or address…' : 'Loading Solar sites…'}
                    emptyLabel={t.noMatchingPlaces}
                    icon={<MapPin className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                  />
                  <p className="text-[11px] text-muted-foreground">Fills in the name, address and GPS below — you can still edit them.</p>
                </div>
              )}

              <div>
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t.nameWord} <span className="text-destructive">*</span></Label>
                <Input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder={t.egWorkingPlaceName} aria-invalid={triedSave && !!nameError} />
                {triedSave && <InlineError>{nameError}</InlineError>}
              </div>

              <div>
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t.addressLabel}</Label>
                <Textarea value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                  rows={2} placeholder={t.fullAddressOptional}
                  className="resize-none" />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {t.gpsLocation} <span className="normal-case font-normal text-muted-foreground">{t.optionalWord}</span>
                  </Label>
                  <Button type="button" variant="link" size="sm" onClick={useMyLocation} disabled={locating}
                    className="h-auto p-0 text-[11px] font-medium">
                    <Crosshair className="w-3.5 h-3.5" />{locating ? t.locatingWord : t.useMyLocation}
                  </Button>
                </div>

                {/* How to enter the location */}
                <div className="flex items-center gap-1 p-1 rounded-md bg-muted border border-border mb-2">
                  {([['latlng', t.latLngTab, Crosshair], ['maps', t.mapsLinkTab, Link2], ['plus', t.plusCodeTab, Hash]] as const).map(([m, label, Icon]) => (
                    <button key={m} type="button" onClick={() => setLocMethod(m)}
                      className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-semibold flex items-center justify-center gap-1 transition-all ${
                        form.locMethod === m ? 'bg-primary/10 text-primary border border-primary/20' : 'text-muted-foreground hover:text-foreground'}`}>
                      <Icon className="w-3.5 h-3.5" /> {label}
                    </button>
                  ))}
                </div>

                {form.locMethod === 'latlng' && (
                  <div className="grid grid-cols-2 gap-3">
                    <Input type="text" value={form.latitude} onChange={e => setForm(f => ({ ...f, latitude: e.target.value }))}
                      placeholder={t.latitudePlaceholder} />
                    <Input type="text" value={form.longitude} onChange={e => setForm(f => ({ ...f, longitude: e.target.value }))}
                      placeholder={t.longitudePlaceholder} />
                  </div>
                )}
                {form.locMethod === 'maps' && (
                  <Input type="text" value={form.mapsLink} onChange={e => setForm(f => ({ ...f, mapsLink: e.target.value }))}
                    placeholder={t.mapsLinkPlaceholder} />
                )}
                {form.locMethod === 'plus' && (
                  <Input type="text" value={form.plusCode} onChange={e => setForm(f => ({ ...f, plusCode: e.target.value }))}
                    placeholder={t.plusCodePlaceholder} />
                )}

                {/* Live parse preview / validation */}
                {form.locMethod === 'plus' && plusBusy ? (
                  <p className="text-[11px] text-muted-foreground mt-1.5 flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" /> {t.lookingUp.replace('{x}', splitPlusCode(form.plusCode).locality)}
                  </p>
                ) : coords.error ? (
                  <InlineError className="mt-1.5">{coords.error}</InlineError>
                ) : coords.lat != null && coords.lng != null ? (
                  <>
                    <p className="text-[11px] text-success mt-1.5 flex items-center gap-1.5">
                      <Crosshair className="w-3 h-3 flex-shrink-0" /> {coords.lat.toFixed(6)}, {coords.lng.toFixed(6)}
                      <a href={mapsLink(coords.lat, coords.lng)} target="_blank" rel="noopener noreferrer"
                        className="text-primary hover:text-primary/80 inline-flex items-center gap-0.5">{t.viewWord}<ExternalLink className="w-3 h-3" /></a>
                    </p>
                    <LeafletMiniMap lat={coords.lat} lng={coords.lng} radiusMeters={Number(form.radius) || undefined} className="mt-2" />
                  </>
                ) : null}

                {/* Geofence radius — always available (applies once the place has coordinates) */}
                <div className="mt-2">
                  <Label className="text-[11px] text-muted-foreground mb-1 block font-normal normal-case tracking-normal">
                    {t.geofenceRadiusHint.replace('{n}', String(DEFAULT_RADIUS_M))}
                  </Label>
                  <Input type="number" min="0" step="10" value={form.radius}
                    onChange={e => setForm(f => ({ ...f, radius: e.target.value }))}
                    placeholder={t.radiusDefaultPlaceholder.replace('{n}', String(DEFAULT_RADIUS_M))}
                    aria-invalid={!!radiusError} />
                  <InlineError>{radiusError}</InlineError>
                </div>
              </div>

              <label className="flex items-center justify-between gap-3 cursor-pointer rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-foreground block">{t.requiresSiteNumLabel}</span>
                  <span className="text-[11px] text-muted-foreground">{t.requiresSiteNumDesc}</span>
                </div>
                <Switch checked={form.requires_site}
                  onCheckedChange={v => setForm(f => ({ ...f, requires_site: v }))} />
              </label>

              {/* Tags — independent classifiers (a place may carry more than one) */}
              <div>
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">Tags</Label>
                <div className="space-y-2">
                  {WORKING_PLACE_TAGS.map(tag => {
                    const checked = form.tags.includes(tag);
                    const toggle = () => setForm(f => ({
                      ...f,
                      tags: checked ? f.tags.filter(x => x !== tag) : [...f.tags, tag],
                    }));
                    return (
                      <label key={tag} onClick={toggle}
                        className="flex items-start gap-2.5 cursor-pointer rounded-lg border border-border bg-muted/30 px-3 py-2">
                        <div className={`w-5 h-5 rounded border flex-shrink-0 flex items-center justify-center transition-colors mt-0.5 ${
                          checked ? 'bg-primary border-primary' : 'border-border bg-muted'}`}>
                          {checked && <CheckCircle2 className="w-3 h-3 text-primary-foreground" />}
                        </div>
                        <div className="min-w-0">
                          <span className="text-sm font-medium text-foreground block">{TAG_META[tag].label}</span>
                          <span className="text-[11px] text-muted-foreground">{TAG_META[tag].desc}</span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Location supervisors — anyone whose check-in GPS matched this place can be
                  approved by these users (additive; assignment grants the approval right). */}
              <div>
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">Location supervisors</Label>
                <p className="text-[11px] text-muted-foreground mb-1.5">Approve check-ins matched to this location. Being added here grants the approval right even to non-approvers.</p>
                <SearchableSelect
                  value=""
                  onChange={(epf) => setForm(f => f.supervisor_epfs.includes(epf) ? f : { ...f, supervisor_epfs: [...f.supervisor_epfs, epf] })}
                  options={users
                    .filter(u => u.epf_number && !form.supervisor_epfs.includes(String(u.epf_number)))
                    .map(u => ({
                      value: String(u.epf_number),
                      label: u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || String(u.epf_number),
                      sublabel: [String(u.epf_number), u.role].filter(Boolean).join(' · ') || undefined,
                      keywords: `${u.epf_number} ${u.email ?? ''} ${u.role ?? ''}`,
                    } as SearchOption))}
                  placeholder="Add a supervisor…"
                  emptyLabel="No matching users"
                  icon={<MapPin className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                />
                {form.supervisor_epfs.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {form.supervisor_epfs.map(epf => (
                      <span key={epf} className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 text-primary px-2.5 py-1 text-xs font-medium">
                        {userName(epf)}
                        <button type="button" onClick={() => setForm(f => ({ ...f, supervisor_epfs: f.supervisor_epfs.filter(x => x !== epf) }))}
                          className="hover:text-foreground"><X className="w-3 h-3" /></button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Chamaries (canteens) — food suppliers at this place with a responsible person.
                  Drives the "need lunch" prompt at check-in and the food-deduction calculation.
                  Part of the suspense/food module (Alta Vision only). */}
              {tenant.features.suspense && (
                <div>
                  <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block flex items-center gap-1.5">
                    <UtensilsCrossed className="w-3.5 h-3.5" /> Chamaries (canteens)
                  </Label>
                  <p className="text-[11px] text-muted-foreground mb-2">Food suppliers at this place. Staff checking in here can request a meal from a chamary; its Food-category suspense bills are then recovered from those who ate. Pick the meals each chamary actually cooks, until when each one can be ordered, and which employee categories it&apos;s open to (leave empty for everyone) — that is what staff can book and who the responsible person can add.</p>

                  {form.chamaries.length > 0 && (
                    <div className="space-y-1.5 mb-2">
                      {form.chamaries.map(ch => (
                        <div key={ch.id} className="rounded-lg border border-border bg-muted/30 px-2.5 py-1.5">
                          <div className="flex items-center gap-2">
                            <UtensilsCrossed className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{ch.name}</span>
                            <button type="button" aria-label="Remove chamary" title="Remove chamary"
                              onClick={() => setForm(f => ({ ...f, chamaries: f.chamaries.filter(x => x.id !== ch.id) }))}
                              className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-destructive"><X className="w-3.5 h-3.5" /> Remove</button>
                          </div>
                          <div className="mt-1.5 ml-5 space-y-1.5">
                            {/* Responsible person is editable in place — before this the only way to hand a
                                chamary to someone else was to remove it and add it again (losing its
                                meals/times/category link). Takes effect on Save, like every other field. */}
                            <div className="flex items-center gap-2">
                              <span className="w-24 shrink-0 text-[11px] text-muted-foreground">Responsible:</span>
                              <div className="min-w-0 flex-1">
                                <SearchableSelect
                                  value={ch.responsible_epf}
                                  onChange={(epf) => setForm(f => ({ ...f, chamaries: f.chamaries.map(x => x.id === ch.id ? { ...x, responsible_epf: epf, responsible_name: userName(epf) } : x) }))}
                                  options={userOptions}
                                  placeholder="Responsible person…"
                                  ariaLabel={`Responsible person for ${ch.name}`}
                                  emptyLabel="No matching users"
                                  icon={<UtensilsCrossed className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                                />
                              </div>
                            </div>
                            <ChamaryMealsPicker
                              meals={ch.meals}
                              onChange={(meals) => setForm(f => ({ ...f, chamaries: f.chamaries.map(x => x.id === ch.id ? { ...x, meals } : x) }))}
                            />
                            <ChamaryMealTimesPicker
                              meals={ch.meals}
                              slots={ch.slots}
                              onChange={(slots) => setForm(f => ({ ...f, chamaries: f.chamaries.map(x => x.id === ch.id ? { ...x, slots } : x) }))}
                            />
                            <ChamaryCategoriesPicker
                              categories={ch.categories}
                              onChange={(categories) => setForm(f => ({ ...f, chamaries: f.chamaries.map(x => x.id === ch.id ? { ...x, categories } : x) }))}
                            />
                            <ChamaryCategoryLink
                              chamary={ch}
                              categories={categories}
                              checkTaken={chamarySubcategoryTakenBy}
                              createSubcategory={createSubcategoryForChamary}
                              onChange={(patch) => setForm(f => ({ ...f, chamaries: f.chamaries.map(x => x.id === ch.id ? mergeChamaryLink(x, patch) : x) }))}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* The draft's meals/category pickers below only make sense attached to the name
                      and responsible person above them, so the whole add form sits in one panel —
                      otherwise they read as belonging to the last saved chamary in the list. */}
                  {!showAddChamary ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => setShowAddChamary(true)}>
                      <Plus className="w-4 h-4" /> Add a chamary
                    </Button>
                  ) : (
                  <div className="rounded-lg border border-dashed border-border bg-muted/20 p-2.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-[11px] font-medium text-muted-foreground">Add a chamary</div>
                      <button type="button" aria-label="Close" title="Close"
                        onClick={() => { setShowAddChamary(false); setChName(''); setChResp(''); setChMeals(['lunch']); setChCategories([]); setChLink({}); }}
                        className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
                    </div>
                    <Input value={chName} onChange={e => setChName(e.target.value)} placeholder="Chamary name (e.g. Site A Canteen)" />
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
                      <SearchableSelect
                        value={chResp}
                        onChange={setChResp}
                        options={userOptions}
                        placeholder="Responsible person…"
                        emptyLabel="No matching users"
                        icon={<UtensilsCrossed className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                      />
                      <Button type="button" variant="outline" size="sm" className="h-10"
                        disabled={!chName.trim() || !chResp}
                        onClick={() => {
                          const name = chName.trim();
                          if (form.chamaries.some(c => c.name.toLowerCase() === name.toLowerCase())) { toast.error('A chamary with that name already exists here.'); return; }
                          const resp = users.find(u => String(u.epf_number) === chResp);
                          setForm(f => ({
                            ...f,
                            chamaries: [...f.chamaries, {
                              id: crypto.randomUUID(), name,
                              responsible_epf: chResp,
                              responsible_name: resp?.display_name ?? chResp,
                              is_active: true,
                              meals: chMeals,
                              slots: chSlots,
                              categories: chCategories,
                              ...chLink,
                            }],
                          }));
                          setChName(''); setChResp(''); setChMeals(['lunch']); setChCategories([]); setChLink({});
                          setShowAddChamary(false);
                        }}>
                        <Plus className="w-4 h-4" /> Add
                      </Button>
                    </div>
                    <ChamaryMealsPicker meals={chMeals} onChange={setChMeals} />
                    <ChamaryMealTimesPicker meals={chMeals} slots={chSlots} onChange={setChSlots} />
                    <ChamaryCategoriesPicker categories={chCategories} onChange={setChCategories} />
                    <ChamaryCategoryLink
                      chamary={{ id: '', name: chName, ...chLink }}
                      categories={categories}
                      checkTaken={chamarySubcategoryTakenBy}
                      createSubcategory={createSubcategoryForChamary}
                      onChange={(patch) => setChLink(l => mergeChamaryLink(l, patch))}
                    />
                  </div>
                  )}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <Button variant="outline" onClick={() => setShowForm(false)} className="flex-1">{t.cancel}</Button>
                <Button onClick={handleSave} disabled={saveDisabled} className="flex-1">
                  <Save className="w-4 h-4" />{saving ? t.saving : t.save}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </Portal>

      <ConfirmModal
        open={!!confirmDelete}
        onOpenChange={() => setConfirmDelete(null)}
        variant="danger"
        title={t.deleteWord}
        description={confirmDelete ? t.deleteWorkingPlaceConfirm.replace('{name}', confirmDelete.name) : undefined}
        confirmText={t.deleteWord}
        busy={!!deletingId}
        onConfirm={async () => {
          if (confirmDelete) await handleDelete(confirmDelete);
          setConfirmDelete(null);
        }}
      />
    </PageTransition>
  );
}
