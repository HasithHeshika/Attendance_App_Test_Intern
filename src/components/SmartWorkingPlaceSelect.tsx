'use client';
import { useMemo } from 'react';
import { MapPin, Star, Navigation, Check } from 'lucide-react';
import SearchableSelect, { type SearchOption } from './SearchableSelect';
import { useWorkingPlaces } from '@/store/workingPlacesStore';
import { useSolarSites } from './useSolarSites';
import { useAuthStore } from '@/store/authStore';
import { useUserCapabilities } from '@/store/rolesStore';
import { useT } from '@/store/appStore';
import { distanceMeters } from '@/lib/geo';
// Canonical name for de-duplication: drop a trailing "(#site-no)" and normalise case/space.
import { canonPlaceName as canonName } from '@/lib/placeName';

const RECENT_MAX = 5;
const WFH_NAME = 'Work From Home';   // executives-only working place
const NEAREST = '#0C8ECA'; // cyan accent reserved for the single closest GPS match
const DEDUP_M = 25;        // two places within this many metres count as the same spot

type Gps = { lat: number; lng: number } | null | undefined;
type Cat = 'nearby' | 'recent' | 'saved';

function fmtDist(d: number): string {
  return d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`;
}
function distLabel(gps: Gps, lat?: number | null, lng?: number | null): string | undefined {
  if (!gps || lat == null || lng == null) return undefined;
  return fmtDist(distanceMeters(gps.lat, gps.lng, lat, lng));
}

const recentKey = (epf?: string) => `wp_recent_${epf ?? 'anon'}`;
function readRecent(epf?: string): string[] {
  try { const r = JSON.parse(localStorage.getItem(recentKey(epf)) ?? '[]'); return Array.isArray(r) ? r : []; }
  catch { return []; }
}
function pushRecent(epf: string | undefined, name: string) {
  try {
    const list = [name, ...readRecent(epf).filter(n => n !== name)].slice(0, RECENT_MAX);
    localStorage.setItem(recentKey(epf), JSON.stringify(list));
  } catch { /* ignore */ }
}

interface Pick { value: string; label: string; dist?: string; sub?: string; lat?: number | null; lng?: number | null }
type Chip = Pick & { cat: Cat; nearest: boolean };

// Per-category visual language — also drives the colour legend. Each category gets its OWN
// distinct hue applied to the WHOLE chip (tinted surface + border + icon + label), so the
// three groups read apart at a glance; the selected pick deepens that same hue and adds a check.
// Nearby = blue, Recent = green, Saved = orange — three clearly different colours.
// NOTE: the `success` and `brand` tokens are both overridden to azure-blue in globals.css
// (same as `primary`), so we use an explicit emerald for Recent to get a real, distinct green
// without recolouring every "approved/present" indicator app-wide.
const CAT_META: Record<Cat, { Icon: typeof MapPin; icon: string; chip: string; active: string }> = {
  nearby: { Icon: Navigation, icon: 'text-primary',      chip: 'border-primary/45 bg-primary/15 text-primary hover:bg-primary/25',                            active: 'border-primary bg-primary/30 text-primary' },                       // blue
  recent: { Icon: Star,       icon: 'text-emerald-500',  chip: 'border-emerald-500/45 bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25 dark:text-emerald-400', active: 'border-emerald-500 bg-emerald-500/30 text-emerald-600 dark:text-emerald-400' }, // green
  saved:  { Icon: MapPin,     icon: 'text-warning',      chip: 'border-warning/45 bg-warning/15 text-warning hover:bg-warning/25',                            active: 'border-warning bg-warning/30 text-warning' },                       // orange
};

/**
 * Intelligent working-place picker (compact V2 layout):
 *  • One dense, dynamic-width chip rail of all quick-picks — nearest Solar sites (GPS) →
 *    recent → saved — colour-coded by category with a legend, wrapping to pack as many
 *    per row as fit. The single closest match is accented cyan.
 *  • Search + an inline Outstation toggle share one row. The toggle only appears once a
 *    non-saved place is chosen (saved places are never outstations).
 *  • Typing an unknown place → "Use as outstation" (custom outstations) via onOutstation.
 */
export default function SmartWorkingPlaceSelect({
  value, onChange, gps, onOutstation, isOutstation, onOutstationToggle, disabled, className,
}: {
  value: string;
  onChange: (name: string) => void;
  gps?: Gps;
  onOutstation?: (name: string) => void;
  isOutstation?: boolean;
  onOutstationToggle?: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { options: adminPlacesRaw } = useWorkingPlaces();
  const sites = useSolarSites(true);
  const epf = useAuthStore(s => s.user?.epf_number);
  const caps = useUserCapabilities();
  const t = useT();
  // "Work From Home" is an executives-only place — hide it from everyone else.
  const isExec = caps.can_approve;
  const adminPlaces = useMemo(
    () => isExec ? adminPlacesRaw : adminPlacesRaw.filter(p => p.name !== WFH_NAME),
    [adminPlacesRaw, isExec],
  );

  const siteValue = (s: { name: string; siteNo: string }) => `${s.name} (#${s.siteNo})`;

  // Combined, distance-sorted options for the dropdown.
  const options = useMemo<SearchOption[]>(() => {
    type Entry = SearchOption & { lat: number | null; lng: number | null };
    const admin: Entry[] = adminPlaces.map(p => ({
      value: p.name,
      label: p.name,
      sublabel: [distLabel(gps, p.latitude, p.longitude), p.address].filter(Boolean).join(' · ') || undefined,
      badge: p.requires_site ? 'site #' : 'saved',
      keywords: p.address ?? '',
      lat: p.latitude ?? null, lng: p.longitude ?? null,
    }));
    const siteOpts: Entry[] = sites
      .map(s => ({ s, d: gps ? distanceMeters(gps.lat, gps.lng, s.lat, s.lng) : Infinity }))
      .sort((a, b) => a.d - b.d)
      .map(({ s, d }): Entry => ({
        value: siteValue(s),
        label: siteValue(s),
        sublabel: [Number.isFinite(d) ? fmtDist(d) : undefined, s.address].filter(Boolean).join(' · ') || undefined,
        badge: 'site',
        keywords: `${s.siteNo} ${s.projectNo ?? ''} ${s.address ?? ''} ${s.name}`,
        lat: s.lat, lng: s.lng,
      }));
    // De-duplicate: never list the same place twice — same canonical name (ignoring a
    // "(#site-no)" suffix) OR within 25 m. Saved places come first so they win over raw sites.
    const kept: Entry[] = [];
    const seenName = new Set<string>();
    for (const e of [...admin, ...siteOpts]) {
      const name = canonName(e.value);
      const dupLoc = e.lat != null && e.lng != null
        && kept.some(k => k.lat != null && k.lng != null && distanceMeters(e.lat!, e.lng!, k.lat!, k.lng!) <= DEDUP_M);
      if (seenName.has(name) || dupLoc) continue;
      seenName.add(name);
      kept.push(e);
    }
    return kept.map(({ value, label, sublabel, badge, keywords }) => ({ value, label, sublabel, badge, keywords }));
  }, [adminPlaces, sites, gps]);

  // Quick picks grouped by intent: nearest sites (GPS) → recent → saved. Deduped across
  // groups, each enriched with distance + city/address so the chip is self-explaining.
  const groups = useMemo(() => {
    const infoByValue = new Map(options.map(o => [o.value, o.sublabel]));
    const seen = new Set<string>();
    const take = (v: string) => (v && !seen.has(v) ? (seen.add(v), true) : false);

    const nearby: Pick[] = [];
    if (gps) {
      sites
        .map(s => ({ s, d: distanceMeters(gps.lat, gps.lng, s.lat, s.lng) }))
        .sort((a, b) => a.d - b.d).slice(0, 12)
        .forEach(({ s, d }) => {
          const v = siteValue(s);
          if (nearby.length < 4 && take(v)) nearby.push({ value: v, label: s.name, dist: fmtDist(d), sub: s.address || undefined, lat: s.lat, lng: s.lng });
        });
    }
    const recent: Pick[] = [];
    readRecent(epf).forEach(n => { if (recent.length < 4 && take(n)) recent.push({ value: n, label: n, sub: infoByValue.get(n) ?? undefined }); });

    const saved: Pick[] = [];
    adminPlaces.forEach(p => {
      if (saved.length < 6 && take(p.name)) saved.push({ value: p.name, label: p.name, dist: distLabel(gps, p.latitude, p.longitude), sub: p.address || undefined, lat: p.latitude ?? null, lng: p.longitude ?? null });
    });

    return { nearby, recent, saved };
  }, [epf, gps, sites, adminPlaces, options]);

  // Flatten into a single colour-coded rail (nearby → recent → saved); first nearby = closest.
  const chips = useMemo<Chip[]>(() => {
    const all: Chip[] = [
      ...groups.nearby.map((p, i): Chip => ({ ...p, cat: 'nearby', nearest: i === 0 })),
      ...groups.recent.map((p): Chip => ({ ...p, cat: 'recent', nearest: false })),
      ...groups.saved.map((p): Chip => ({ ...p, cat: 'saved', nearest: false })),
    ];
    // Drop chips that repeat a place already shown — same canonical name OR within 25 m.
    const kept: Chip[] = [];
    const seenName = new Set<string>();
    for (const c of all) {
      const name = canonName(c.value);
      const dupLoc = c.lat != null && c.lng != null
        && kept.some(k => k.lat != null && k.lng != null && distanceMeters(c.lat!, c.lng!, k.lat!, k.lng!) <= DEDUP_M);
      if (seenName.has(name) || dupLoc) continue;
      seenName.add(name);
      kept.push(c);
    }
    return kept;
  }, [groups]);

  const isSavedSelection = useMemo(() => adminPlaces.some(p => p.name === value), [adminPlaces, value]);
  const showOutstationToggle = !!onOutstationToggle && !!value && !isSavedSelection;

  const select = (name: string) => { onChange(name); pushRecent(epf, name); };

  // One compact, content-width chip: category-tinted icon, the (truncating) name, then
  // distance. ONLY the actually-selected pick gets the filled "selected" accent. The closest
  // GPS match gets just a subtle cyan icon/distance tint — never a selected-looking fill — so
  // an unselected picker doesn't look like a place is already chosen.
  const chip = (p: Chip) => {
    const active = p.value === value;
    const cyan = p.nearest && !active;
    const meta = CAT_META[p.cat];
    const Icon = meta.Icon;
    return (
      <button
        key={`${p.cat}:${p.value}`} type="button" disabled={disabled} onClick={() => select(p.value)}
        aria-pressed={active} title={[p.label, p.sub].filter(Boolean).join(' · ')}
        className={`group inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 transition-colors ${
          active ? meta.active : meta.chip}`}
      >
        <Icon
          className={`h-3.5 w-3.5 shrink-0 ${cyan ? '' : meta.icon}`}
          style={cyan ? { color: NEAREST } : undefined}
        />
        <span className="truncate text-xs font-medium" style={{ maxWidth: '11rem' }}>{p.label}</span>
        {p.dist && (
          <span className="shrink-0 text-[10px] font-bold tabular-nums opacity-80"
            style={cyan ? { color: NEAREST } : undefined}>{p.dist}</span>
        )}
        {active && <Check className="h-3.5 w-3.5 shrink-0" />}
      </button>
    );
  };

  const legendItems = ([
    { cat: 'nearby', label: t.nearbySites },
    { cat: 'recent', label: t.recentLabel },
    { cat: 'saved', label: t.savedPlaces },
  ] as { cat: Cat; label: string }[]).filter(l => groups[l.cat].length > 0);

  return (
    <div className={className}>
      {chips.length > 0 && (
        <div className="mb-2.5">
          {/* Colour legend — each category's symbol in its colour; only categories with picks */}
          <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-medium text-muted-foreground">
            {legendItems.map(l => {
              const LIcon = CAT_META[l.cat].Icon;
              return (
                <span key={l.cat} className="inline-flex items-center gap-1">
                  <LIcon className={`h-3 w-3 ${CAT_META[l.cat].icon}`} /> {l.label}
                </span>
              );
            })}
          </div>
          {/* Dense, dynamic-width rail — wraps to fit as many per row as possible */}
          <div className="flex flex-wrap gap-1.5">{chips.map(chip)}</div>
        </div>
      )}

      {/* Search + inline Outstation toggle on one row */}
      <div className="flex items-stretch gap-2 m-1">
        <div className="min-w-0 flex-1">
          <SearchableSelect
            value={value}
            onChange={select}
            options={options}
            disabled={disabled}
            placeholder={t.searchSitePlaceholder}
            emptyLabel={t.noMatchingPlaces}
            icon={<MapPin className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
            onCreate={onOutstation ?? select}
            createLabel={(q) => t.addCustomLocationLabel.replace('{q}', q)}
          />
        </div>
        {showOutstationToggle && (
          <button
            type="button" disabled={disabled}
            onClick={() => onOutstationToggle?.(!isOutstation)}
            aria-pressed={!!isOutstation}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs font-medium transition-colors ${
              isOutstation ? 'border-warning/40 bg-warning/10 text-warning'
                           : 'border-border bg-card text-muted-foreground hover:text-foreground'}`}
          >
            <span className={`flex h-4 w-4 items-center justify-center rounded border ${
              isOutstation ? 'border-warning bg-warning/20 text-warning' : 'border-border'}`}>
              {isOutstation && <Check className="h-3 w-3" />}
            </span>
            {t.outstationShort}
          </button>
        )}
      </div>
    </div>
  );
}
