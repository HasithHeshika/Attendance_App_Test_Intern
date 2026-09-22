'use client';
import 'leaflet/dist/leaflet.css';
import { AlertTriangle, Loader2, Route, Eye, EyeOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadLeaflet } from '@/lib/leaflet';
import { distanceMeters } from '@/lib/geo';
import type { DayPerson } from '@/lib/overviewData';
/* eslint-disable @typescript-eslint/no-explicit-any */

const SRI_LANKA_CENTER: [number, number] = [7.8731, 80.7718];

const COL_ONSITE = '#0ea5e9';
const COL_OUTSIDE = '#f59e0b';
const COL_OUTSTATION = '#8b5cf6';

/** Beyond this many raw points the bucketing pass itself is the freeze, so kinds are dropped —
 *  location updates first, then check-outs — and the reader is told on screen rather than being
 *  handed a quietly incomplete map. 300 people × 26 days × 3 kinds is ~23k, so an ordinary month
 *  never trims; a month with minute-by-minute location updates does. */
const MAX_POINTS = 40_000;

export type MapKind = 'checkin' | 'checkout' | 'update';
const DEFAULT_KINDS: readonly MapKind[] = ['checkin'];

/** One in-session location ping. Mirrors `sessions[].locations[]` on the attendance document. */
export type MapUpdate = { lat: number; lng: number; name: string; atMs: number | null; accuracyM: number | null };

/** The session fields the map reads.
 *
 *  Everything past the check-in fix is declared optional on purpose: `SessionView`
 *  (`src/lib/overviewData.ts`) is being widened with the check-out fix, accuracy, the site id and
 *  `updates[]`, and this component must compile and behave correctly both before and after that
 *  lands. A widened `SessionView` — and therefore a `DayPerson` — satisfies this structurally, so
 *  this is the map's read side of one shape, not a second declaration of it. */
export type MapSession = {
  checkIn: string | null; checkOut: string | null;
  lat: number | null; lng: number | null;
  place: string | null; outstation: boolean; outOfRadius: boolean | null;
  outLat?: number | null; outLng?: number | null;
  accuracyM?: number | null; outAccuracyM?: number | null;
  /** Carried for the geofence ring a later step draws; the map does not read it yet. */
  siteId?: string | null;
  updates?: readonly MapUpdate[] | null;
};

/** A person as the map needs them. `DayPerson` is structurally assignable to this, so the
 *  single-day call site keeps passing exactly what it already has. */
export type MapPerson = { epf: string; name: string; sessions: readonly MapSession[] };

/** One calendar day of positions. Built straight from the month snapshot the page already holds
 *  — no leave/status resolution, because the map only ever draws people who checked in. */
export type MapDay = { date: string; people: readonly MapPerson[] };

export type SriLankaMapProps = {
  /** Single-day mode. Still required: it is what the map draws while the month is still loading,
   *  so period mode never opens onto a blank rectangle. */
  people: DayPerson[];
  /** Period mode. When present and non-empty it REPLACES `people` as the marker source.
   *  Absent or empty ⇒ identical behaviour to the single-day map. */
  days?: readonly MapDay[] | null;
  /** Which captures to plot. Default `['checkin']` — exactly the single-day behaviour. */
  kinds?: readonly MapKind[];
  focusedEpf: string | null;
  onFocus: (epf: string | null) => void;
  /** A marker resolving to exactly ONE person opens their dossier. */
  onOpen?: (epf: string) => void;
  /** Period mode only: a popup row names a day; clicking it selects that day on the page. */
  onOpenDay?: (date: string) => void;
  /** Period mode only: rendered under the legend, e.g. "24 days · 187 people · 3,412 captures". */
  summaryLine?: string | null;
  /** The month is still being read. Day markers stay on screen underneath. */
  loading?: boolean;
  /** The month read failed. Without this the map would render a confident, empty, wrong month. */
  error?: boolean;
  /** Index of the checkpoint in the trail (0-based) to highlight — for bidirectional drawer sync. */
  highlightedWaypointIdx?: number | null;
  /** Called when a trail waypoint marker is clicked — passes the 0-based trail index. */
  onWaypointClick?: (idx: number) => void;
  height?: number; className?: string; t: any;
};

// ── points ────────────────────────────────────────────────────────────────────────────────────

type Point = {
  epf: string; name: string; lat: number; lng: number;
  color: string; place: string; kind: MapKind;
  /** ISO date, or '' in single-day mode — there is only one day there and it carries no label. */
  date: string;
  time: string;
  /** The single-day tooltip's two columns, kept verbatim so that tooltip does not change. */
  checkIn: string; checkOut: string;
  atMs: number | null;
};

const KIND_ORDER: Record<MapKind, number> = { checkin: 0, update: 1, checkout: 2 };

function sessionColor(s: MapSession): string {
  return s.outstation ? COL_OUTSTATION : s.outOfRadius ? COL_OUTSIDE : COL_ONSITE;
}

// Outstation beats outside-radius beats on-site — the same precedence the single-day map has
// always used when several people share one circle.
function notable(colors: readonly string[]): string {
  return colors.some(c => c === COL_OUTSTATION) ? COL_OUTSTATION
    : colors.some(c => c === COL_OUTSIDE) ? COL_OUTSIDE : COL_ONSITE;
}

function clockOf(atMs: number | null): string {
  if (atMs == null) return '';
  const d = new Date(atMs);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fmtDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Walk every session the map could draw, in either mode, exactly once. Both the counting pass
 *  (which decides whether kinds have to be dropped) and the building pass use this, so the two
 *  can never disagree about what is on the map. */
function forEachSession(
  days: readonly MapDay[] | null | undefined,
  people: DayPerson[],
  cb: (epf: string, name: string, s: MapSession, date: string) => void,
): void {
  if (days && days.length) {
    for (const d of days) {
      for (const p of d.people) {
        for (const s of p.sessions) cb(p.epf, p.name, s, d.date);
      }
    }
    return;
  }
  for (const p of people) {
    // Single-day mode still answers to the day's status: only people who were actually present
    // have a position worth drawing.
    if (p.status !== 'present') continue;
    for (const s of p.sessions) cb(p.epf, p.name, s, '');
  }
}

const usable = (lat: unknown, lng: unknown): boolean =>
  typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng);

function buildPoints(
  days: readonly MapDay[] | null | undefined,
  people: DayPerson[],
  kinds: readonly MapKind[],
  t: any,
): Point[] {
  const want = new Set(kinds);
  const out: Point[] = [];
  forEachSession(days, people, (epf, name, s, date) => {
    const color = sessionColor(s);
    const place = s.place ?? '';
    const checkIn = s.checkIn ?? '—';
    const checkOut = s.checkOut ?? t.ovStillIn;
    const base = { epf, name, color, place, date, checkIn, checkOut };
    if (want.has('checkin') && usable(s.lat, s.lng)) {
      out.push({ ...base, lat: s.lat as number, lng: s.lng as number, kind: 'checkin', time: checkIn, atMs: null });
    }
    if (want.has('checkout') && usable(s.outLat, s.outLng)) {
      out.push({ ...base, lat: s.outLat as number, lng: s.outLng as number, kind: 'checkout', time: s.checkOut ?? '—', atMs: null });
    }
    if (want.has('update') && s.updates) {
      for (const u of s.updates) {
        if (!usable(u.lat, u.lng)) continue;
        out.push({
          ...base, lat: u.lat, lng: u.lng, kind: 'update',
          place: u.name || place, time: clockOf(u.atMs ?? null), atMs: u.atMs ?? null,
        });
      }
    }
  });
  return out;
}

/** How many points each kind would contribute, without allocating any of them. */
function countPoints(days: readonly MapDay[] | null | undefined, people: DayPerson[]): Record<MapKind, number> {
  const n: Record<MapKind, number> = { checkin: 0, checkout: 0, update: 0 };
  forEachSession(days, people, (_epf, _name, s) => {
    if (usable(s.lat, s.lng)) n.checkin += 1;
    if (usable(s.outLat, s.outLng)) n.checkout += 1;
    if (s.updates) for (const u of s.updates) if (usable(u.lat, u.lng)) n.update += 1;
  });
  return n;
}

// ── clustering ────────────────────────────────────────────────────────────────────────────────

/** One PERSON at one place, however many days they were there. This is the collapse that keeps a
 *  month honest: somebody who stood at the same site for twenty days is one visit saying twenty
 *  days, never twenty markers and never a "20" in a circle that reads as twenty people. */
type DayVisit = {
  date: string;
  time: string;
  checkIn: string;
  checkOut: string;
  captures: number;
  color: string;
  place: string;
  kinds: Set<MapKind>;
};

type Visit = {
  epf: string; name: string; place: string;
  days: string[];
  dayVisits: DayVisit[];
  captures: number;
  lastAtMs: number | null; lastTime: string; lastDate: string;
  kinds: Set<MapKind>;
  color: string;
};

type Cluster = {
  lat: number; lng: number; color: string;
  visits: Visit[];
  epfs: Set<string>;
  people: number;
  dayCount: number;
  captures: number;
  /** Pre-rendered so the Leaflet effect never needs `t` and never re-runs for a callback. */
  html: string;
  /** Period markers get a popup (scrollable, clickable); day markers keep their hover tooltip. */
  popup: boolean;
};

function toVisit(ps: Point[]): Visit {
  const sorted = [...ps].sort((a, b) =>
    a.date.localeCompare(b.date) || (a.atMs ?? 0) - (b.atMs ?? 0) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const days: string[] = [];
  for (const p of sorted) if (p.date && days[days.length - 1] !== p.date) days.push(p.date);
  const lastDate = days[days.length - 1] ?? '';
  const onLast = sorted.filter(p => p.date === lastDate);
  // "Last seen" reads as the arrival on that last day, so prefer the check-in over a later ping.
  const anchor = onLast.find(p => p.kind === 'checkin') ?? onLast[onLast.length - 1] ?? sorted[sorted.length - 1];

  const byDateMap = new Map<string, Point[]>();
  for (const p of sorted) {
    const d = p.date || '';
    const arr = byDateMap.get(d);
    if (arr) arr.push(p); else byDateMap.set(d, [p]);
  }
  const dayVisits: DayVisit[] = [];
  for (const [date, datePoints] of byDateMap.entries()) {
    const inPt = datePoints.find(p => p.kind === 'checkin');
    const outPt = datePoints.find(p => p.kind === 'checkout');
    const firstPt = datePoints[0];
    const checkIn = inPt?.checkIn ?? (firstPt?.checkIn || '—');
    const checkOut = outPt?.checkOut ?? (inPt?.checkOut || '—');
    const time = inPt?.time || firstPt?.time || '';
    dayVisits.push({
      date,
      time,
      checkIn,
      checkOut,
      captures: datePoints.length,
      color: notable(datePoints.map(p => p.color)),
      place: datePoints.find(p => p.place)?.place ?? '',
      kinds: new Set(datePoints.map(p => p.kind)),
    });
  }
  dayVisits.sort((a, b) => b.date.localeCompare(a.date));

  return {
    epf: sorted[0].epf,
    name: sorted[0].name,
    place: sorted.find(p => p.place)?.place ?? '',
    days,
    dayVisits,
    captures: sorted.length,
    lastAtMs: anchor?.atMs ?? null,
    lastTime: anchor?.time || '',
    lastDate,
    kinds: new Set(sorted.map(p => p.kind)),
    color: notable(sorted.map(p => p.color)),
  };
}

/** Bucket on the same ~111 m key the single-day map has always used, then collapse each bucket by
 *  person. Day mode comes out of this with one visit per person per cell, which is what its
 *  tooltip already showed; period mode comes out with the day count in the popup instead of in
 *  the marker's number. */
function buildClusters(points: Point[], period: boolean, t: any): Cluster[] {
  const buckets = new Map<string, Point[]>();
  for (const p of points) {
    const key = `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;
    const arr = buckets.get(key);
    if (arr) arr.push(p); else buckets.set(key, [p]);
  }
  const out: Cluster[] = [];
  for (const ps of buckets.values()) {
    const lat = ps.reduce((s, p) => s + p.lat, 0) / ps.length;
    const lng = ps.reduce((s, p) => s + p.lng, 0) / ps.length;
    const byEpf = new Map<string, Point[]>();
    for (const p of ps) {
      const arr = byEpf.get(p.epf);
      if (arr) arr.push(p); else byEpf.set(p.epf, [p]);
    }
    const visits = [...byEpf.values()].map(toVisit);
    const dates = new Set<string>();
    for (const p of ps) if (p.date) dates.add(p.date);
    const c: Cluster = {
      lat, lng,
      color: notable(ps.map(p => p.color)),
      visits,
      epfs: new Set(visits.map(v => v.epf)),
      people: visits.length,
      dayCount: Math.max(1, dates.size),
      captures: ps.length,
      html: '',
      popup: period,
    };
    c.html = period ? popupHtml(c, t) : tooltipHtml(ps);
    out.push(c);
  }
  return out;
}

// ── markup ────────────────────────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

/** The store's strings carry {placeholders}; the codebase fills them with plain `.replace`, and
 *  this is the same thing for the ones that carry more than one. Values are escaped by the
 *  caller — the template itself is ours and must not be. */
function fill(tpl: unknown, vars: Record<string, string | number>): string {
  let s = typeof tpl === 'string' ? tpl : '';
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Single-day hover tooltip: everyone at this spot with their check-in → check-out times.
 *  Unchanged from the day-only map, deliberately — this path must not shift. */
function tooltipHtml(ps: Point[]): string {
  const place = esc(ps[0].place);
  const head = `${ps.length} ${ps.length > 1 ? 'check-ins' : 'check-in'}${place ? ` · ${place}` : ''}`;
  const shown = ps.slice(0, 12);
  const rows = shown.map(e => {
    const p = e.place && e.place !== ps[0].place ? ` <span style="opacity:.6">· ${esc(e.place)}</span>` : '';
    return `<div style="display:flex;justify-content:space-between;gap:14px;padding:1px 0">
      <span style="font-weight:600">${esc(e.name)}${p}</span>
      <span style="opacity:.85;white-space:nowrap">${esc(e.checkIn)} → ${esc(e.checkOut)}</span>
    </div>`;
  }).join('');
  const more = ps.length > shown.length
    ? `<div style="opacity:.7;margin-top:2px">+${ps.length - shown.length} more</div>` : '';
  return `<div style="min-width:180px;max-width:280px"><div style="font-weight:700;margin-bottom:3px">${head}</div>${rows}${more}</div>`;
}

/** Period popup: one row per PERSON, saying how many days and which ones. A popup rather than a
 *  tooltip because a month at a busy site has more rows than fit — these have to be scrollable
 *  and clickable, and a `sticky:false` tooltip is neither. */
function popupHtml(c: Cluster, t: any): string {
  const place = c.visits.find(v => v.place)?.place ?? '';
  const isSinglePerson = c.people === 1;

  if (isSinglePerson && c.visits[0]) {
    const v = c.visits[0];
    const placeTitle = place ? esc(place) : (esc(v.place) || 'Location');
    const head = `<div class="ov-visit-head">
      <div style="font-weight:700;font-size:12px">${placeTitle}</div>
      <div style="font-size:11px;font-weight:600;opacity:0.9;margin-top:2px">${esc(v.name)} <span style="opacity:0.65;font-weight:normal">(EPF ${esc(v.epf)})</span></div>
      <div style="font-size:10px;opacity:0.75;margin-top:1px">${v.days.length} ${v.days.length === 1 ? 'day' : 'days'} · ${c.captures} ${c.captures === 1 ? 'capture' : 'captures'}</div>
    </div>`;

    const shown = (v.dayVisits && v.dayVisits.length ? v.dayVisits : [{ date: v.lastDate, time: v.lastTime, checkIn: '', checkOut: '', captures: c.captures, color: v.color, place: v.place, kinds: v.kinds }]).slice(0, 15);
    const rows = shown.map(dv => {
      const dateFormatted = dv.date ? fmtDay(dv.date) : 'Today';
      const timeSpan = dv.checkIn && dv.checkOut && dv.checkOut !== '—'
        ? `${esc(dv.checkIn)} → ${esc(dv.checkOut)}`
        : esc(dv.time || dv.checkIn || '');
      const status = dv.color === COL_OUTSTATION ? esc(t.ovOutstation)
        : dv.color === COL_OUTSIDE ? esc(t.ovOutsideRadius) : '';
      const label = esc(`${t.ovmOpenDay ?? 'Open day'} — ${dateFormatted}`);
      return `<button type="button" class="ov-visit-row" data-epf="${esc(v.epf)}" data-date="${esc(dv.date)}"
        title="${esc(t.ovmOpenDay)}" aria-label="${label}">
        <span class="ov-visit-top">
          <span class="ov-visit-name">📅 ${esc(dateFormatted)}</span>
          <span class="ov-visit-days">${timeSpan}</span>
        </span>
        <span class="ov-visit-sub">
          <span>${dv.captures} ${dv.captures === 1 ? 'capture' : 'captures'}</span>
          ${status ? `<span class="ov-visit-status">${status}</span>` : ''}
        </span>
      </button>`;
    }).join('');

    const more = (v.dayVisits?.length ?? 0) > shown.length
      ? `<div style="opacity:.7;margin-top:3px;font-size:11px">+${(v.dayVisits?.length ?? 0) - shown.length} more dates</div>` : '';

    return `<div class="ov-visit-wrap">
      ${head}
      <div class="ov-visit-list">${rows}</div>
      ${more}
      <div style="margin-top:6px;padding-top:4px;border-top:1px solid rgba(120,120,120,.2);display:flex;justify-content:flex-end">
        <button type="button" data-open-dossier="${esc(v.epf)}" style="font-size:11px;font-weight:600;color:#38bdf8;background:none;border:none;cursor:pointer;padding:2px 4px">
          Open profile →
        </button>
      </div>
    </div>`;
  }

  const stats = [fill(t.ovmPeopleHere, { n: c.people }), fill(t.ovmCaptures, { n: c.captures })]
    .filter(Boolean).map(esc).join(' · ');
  const title = place ? `${esc(place)} — ${stats}` : stats;

  const ordered = [...c.visits].sort((a, b) => b.days.length - a.days.length || a.name.localeCompare(b.name));
  const shown = ordered.slice(0, 12);
  const rows = shown.map(v => {
    const daysLabel = esc(fill(t.ovmDaysCount, { n: Math.max(1, v.days.length) }));
    const span = v.days.length > 1
      ? esc(fill(t.ovmDateRange, { from: fmtDay(v.days[0]), to: fmtDay(v.days[v.days.length - 1]) }))
      : esc(v.days[0] ? fmtDay(v.days[0]) : '');
    const last = v.lastDate && v.lastTime
      ? esc(fill(t.ovmLastSeen, { date: fmtDay(v.lastDate), time: v.lastTime })) : '';
    // Status in words as well as hue: the three marker colours are the only thing separating
    // on-site from outside-radius from outstation, and a colour on its own cannot carry that.
    const status = v.color === COL_OUTSTATION ? esc(t.ovOutstation)
      : v.color === COL_OUTSIDE ? esc(t.ovOutsideRadius) : '';
    const sub = [span, last].filter(Boolean).join(' · ');
    const label = esc(`${t.ovmOpenDay ?? ''} — ${v.name}`);
    return `<button type="button" class="ov-visit-row" data-epf="${esc(v.epf)}" data-date="${esc(v.lastDate)}"
      title="${esc(t.ovmOpenDay)}" aria-label="${label}">
      <span class="ov-visit-top"><span class="ov-visit-name">${esc(v.name)}</span><span class="ov-visit-days">${daysLabel}</span></span>
      <span class="ov-visit-sub"><span>${sub}</span>${status ? `<span class="ov-visit-status">${status}</span>` : ''}</span>
    </button>`;
  }).join('');
  const more = ordered.length > shown.length
    ? `<div style="opacity:.7;margin-top:3px">+${ordered.length - shown.length} more</div>` : '';
  return `<div class="ov-visit-wrap"><div class="ov-visit-head">${title}</div><div class="ov-visit-list">${rows}</div>${more}</div>`;
}

/** A circular marker. The number and the size are both the count of distinct PEOPLE — a site
 *  twenty people visited has to look bigger than a site one person visited twenty times, and
 *  volume belongs in the popup, never in the radius. A cell holding more than one day gets a
 *  second concentric ring: no hue is spent on it, because all three of this map's hues are
 *  already spoken for by on-site / outside-radius / outstation. */
function clusterIcon(L: any, c: Cluster, dim: boolean, focused: boolean): any {
  const isSinglePerson = c.people === 1;
  const count = isSinglePerson && c.dayCount > 1 ? c.dayCount : c.people;
  const size = count > 1 ? Math.min(40, 22 + count * 2) : 18;
  const stacked = c.dayCount > 1;
  const box = stacked ? size + 8 : size;
  const ring = focused ? '0 0 0 3px rgba(255,255,255,.9),0 1px 5px rgba(0,0,0,.5)' : '0 1px 4px rgba(0,0,0,.45)';
  const label = count > 1
    ? `<span style="color:#fff;font-size:${size >= 30 ? 13 : 11}px;font-weight:700;line-height:1">${count}${isSinglePerson ? 'd' : ''}</span>` : '';
  const inner = `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${c.color};`
    + `border:2px solid #fff;box-shadow:${ring};display:flex;align-items:center;justify-content:center">${label}</div>`;
  const html = stacked
    ? `<div style="width:${box}px;height:${box}px;border-radius:50%;border:2px solid ${c.color};`
      + `display:flex;align-items:center;justify-content:center;opacity:${dim ? 0.3 : 1};transition:opacity .15s">${inner}</div>`
    : `<div style="opacity:${dim ? 0.3 : 1};transition:opacity .15s">${inner}</div>`;
  return L.divIcon({ className: 'ov-cluster-marker', html, iconSize: [box, box], iconAnchor: [box / 2, box / 2] });
}

// ── trail ─────────────────────────────────────────────────────────────────────────────────────

/** One ordered waypoint on a person's travel route for a given date. */
type TrailWaypoint = {
  lat: number; lng: number;
  kind: MapKind;
  time: string;
  place: string;
  stepNum: number;   // 1-based
  isFirst: boolean;
  isLast: boolean;
};

/** Extract chronologically-ordered trail for a focused/single-person context.
 *  Returns [] when there is nothing to draw (no GPS, multi-person, etc.). */
function extractTrail(people: DayPerson[], days: readonly MapDay[] | null | undefined): TrailWaypoint[] {
  // Only draw a trail for a single-person view (PersonDossier or focused mode with one person).
  if (!people.length) return [];
  const targetEpf = people[0].epf;

  // Collect all sessions from the MapDay slice, already filtered to this person.
  const sessions: MapSession[] = [];
  if (days && days.length) {
    for (const d of days) {
      const p = d.people.find(x => x.epf === targetEpf);
      if (p) sessions.push(...p.sessions);
    }
  } else {
    // Single-day: use sessions directly from the people prop.
    const p = people.find(x => x.epf === targetEpf);
    if (p && p.status === 'present') sessions.push(...p.sessions);
  }
  if (!sessions.length) return [];

  const raw: { lat: number; lng: number; kind: MapKind; time: string; place: string; sortKey: number }[] = [];
  sessions.forEach((s, sIdx) => {
    if (usable(s.lat, s.lng)) {
      raw.push({ lat: s.lat as number, lng: s.lng as number, kind: 'checkin', time: s.checkIn ?? '', place: s.place ?? '', sortKey: sIdx * 10000 });
    }
    if (s.updates) {
      s.updates.forEach((u, uIdx) => {
        if (!usable(u.lat, u.lng)) return;
        raw.push({ lat: u.lat, lng: u.lng, kind: 'update', time: clockOf(u.atMs ?? null), place: u.name || (s.place ?? ''), sortKey: sIdx * 10000 + 1 + uIdx + (u.atMs ?? uIdx) });
      });
    }
    if (usable(s.outLat, s.outLng)) {
      raw.push({ lat: s.outLat as number, lng: s.outLng as number, kind: 'checkout', time: s.checkOut ?? '', place: s.place ?? '', sortKey: sIdx * 10000 + 9999 });
    }
  });

  if (raw.length < 2) return []; // need at least 2 points to draw a path

  // Sort chronologically by sortKey (session index, then within session by kind/timestamp)
  raw.sort((a, b) => a.sortKey - b.sortKey);

  return raw.map((r, i) => ({
    lat: r.lat, lng: r.lng, kind: r.kind, time: r.time, place: r.place,
    stepNum: i + 1,
    isFirst: i === 0,
    isLast: i === raw.length - 1,
  }));
}

/** Calculate total route distance (metres) from a list of waypoints. */
function trailDistance(pts: TrailWaypoint[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += distanceMeters(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
  }
  return total;
}

/** Compass bearing (degrees) from point a to point b. */
function bearing(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Format metres into a human-readable distance string. */
function fmtDist(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

/** Build the Leaflet path overlay for a trail (dual glow + arrows + numbered markers).
 *  Returns cleanup function. All L and map refs are already guaranteed non-null here. */
function renderTrail(
  L: any,
  map: any,
  trail: TrailWaypoint[],
  highlightIdx: number | null | undefined,
  onWaypointClick?: (idx: number) => void,
): { layers: any[]; cleanup: () => void } {
  const layers: any[] = [];
  const lls: [number, number][] = trail.map(p => [p.lat, p.lng]);

  // ── dual-layer glow polyline ──────────────────────────────────────────
  // Outer soft aura
  const glowLine = L.polyline(lls, {
    color: '#0284c7', weight: 9, opacity: 0.22, lineCap: 'round', lineJoin: 'round',
    interactive: false,
  }).addTo(map);
  layers.push(glowLine);

  // Crisp core line
  const coreLine = L.polyline(lls, {
    color: '#0ea5e9', weight: 3, opacity: 0.92, lineCap: 'round', lineJoin: 'round',
    interactive: false,
  }).addTo(map);
  layers.push(coreLine);

  // ── directional arrow markers at segment midpoints ────────────────────
  for (let i = 0; i < trail.length - 1; i++) {
    const a = trail[i], b = trail[i + 1];
    const segDist = distanceMeters(a.lat, a.lng, b.lat, b.lng);
    if (segDist < 80) continue; // skip arrows for very short (overlapping) segments
    const midLat = (a.lat + b.lat) / 2;
    const midLng = (a.lng + b.lng) / 2;
    const deg = bearing(a.lat, a.lng, b.lat, b.lng);
    const arrowHtml = `<div style="width:18px;height:18px;display:flex;align-items:center;justify-content:center;transform:rotate(${deg}deg);opacity:0.75">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M7 2 L11 9 L7 7 L3 9 Z" fill="#38bdf8" stroke="#0ea5e9" stroke-width="0.8"/>
      </svg>
    </div>`;
    const arrowMarker = L.marker([midLat, midLng], {
      icon: L.divIcon({ className: 'trail-arrow', html: arrowHtml, iconSize: [18, 18], iconAnchor: [9, 9] }),
      interactive: false, zIndexOffset: -50,
    }).addTo(map);
    layers.push(arrowMarker);
  }

  // ── numbered sequential waypoint markers ─────────────────────────────
  trail.forEach((wp, idx) => {
    const isHighlit = highlightIdx != null && idx === highlightIdx;
    let badgeBg: string, badgeBorder: string, label: string;
    if (wp.isFirst) {
      badgeBg = 'linear-gradient(135deg,#10b981,#059669)'; badgeBorder = '#34d399';
      label = 'IN';
    } else if (wp.isLast) {
      badgeBg = 'linear-gradient(135deg,#f43f5e,#e11d48)'; badgeBorder = '#fb7185';
      label = 'OUT';
    } else {
      badgeBg = 'linear-gradient(135deg,#0ea5e9,#0284c7)'; badgeBorder = '#38bdf8';
      label = String(wp.stepNum);
    }

    const ringStyle = isHighlit
      ? `box-shadow:0 0 0 3px rgba(251,191,36,0.9),0 0 12px rgba(251,191,36,0.5);border-color:#fbbf24!important;`
      : '';

    const size = wp.isFirst || wp.isLast ? 28 : 22;
    const fontSize = wp.isFirst || wp.isLast ? 9 : label.length > 1 ? 9 : 11;
    const html = `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${badgeBg};border:2px solid ${badgeBorder};
      display:flex;align-items:center;justify-content:center;
      color:#fff;font-size:${fontSize}px;font-weight:800;letter-spacing:-.3px;
      box-shadow:0 2px 6px rgba(0,0,0,.5);cursor:pointer;
      ${ringStyle}
    ">${label}</div>`;

    const m = L.marker([wp.lat, wp.lng], {
      icon: L.divIcon({ className: 'trail-wp', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
      zIndexOffset: wp.isFirst || wp.isLast ? 800 : 200,
    }).addTo(map);

    const tooltipParts = [
      `<strong>${wp.isFirst ? 'Check-in' : wp.isLast ? 'Check-out' : `Stop ${wp.stepNum}`}</strong>`,
      wp.time ? `🕐 ${wp.time}` : null,
      wp.place ? `📍 ${wp.place}` : null,
      `${wp.lat.toFixed(5)}, ${wp.lng.toFixed(5)}`,
    ].filter(Boolean).join('<br/>');
    m.bindTooltip(`<div style="min-width:120px">${tooltipParts}</div>`, { direction: 'top', opacity: 1, offset: [0, -size / 2 - 4] });

    if (onWaypointClick) {
      m.on('click', (e: any) => { e.originalEvent?.stopPropagation?.(); onWaypointClick(idx); });
    }
    layers.push(m);
  });

  const cleanup = () => { for (const l of layers) { try { map.removeLayer(l); } catch {} } };
  return { layers, cleanup };
}

// ── component ─────────────────────────────────────────────────────────────────────────────────

export default function SriLankaMap({
  people, days, kinds, focusedEpf, onFocus, onOpen, onOpenDay,
  summaryLine, loading = false, error = false,
  highlightedWaypointIdx, onWaypointClick,
  height = 460, className = '', t,
}: SriLankaMapProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const LRef = useRef<any>(null);
  const markersRef = useRef<{ c: Cluster; m: any }[]>([]);
  const trailCleanupRef = useRef<(() => void) | null>(null);
  const [ready, setReady] = useState(false);
  const [showRoute, setShowRoute] = useState(true);
  const onWaypointClickRef = useRef(onWaypointClick);
  useEffect(() => { onWaypointClickRef.current = onWaypointClick; });

  // Callbacks live in a ref, not in an effect's dep array. `onOpen` is an inline arrow at the
  // call site, so it is a new identity on every parent render; keying the Leaflet effect on it
  // tore down and rebuilt every marker on each keystroke in the people-panel search box. With a
  // month of positions behind it that is a visible freeze.
  const cbs = useRef({ onFocus, onOpen, onOpenDay });
  useEffect(() => { cbs.current = { onFocus, onOpen, onOpenDay }; });

  // One delegated listener for the whole popup rather than one per row: Leaflet rebuilds the
  // popup's DOM every time it opens, and a busy site has twelve rows.
  const onPopupClick = useCallback((ev: Event) => {
    const target = ev.target as HTMLElement | null;
    const dossierBtn = target?.closest?.('[data-open-dossier]') as HTMLElement | null;
    if (dossierBtn) {
      const epf = dossierBtn.getAttribute('data-open-dossier');
      if (epf) cbs.current.onOpen?.(epf);
      return;
    }
    const row = target?.closest?.('[data-epf]') as HTMLElement | null;
    if (!row) return;
    const epf = row.getAttribute('data-epf') ?? '';
    const date = row.getAttribute('data-date') ?? '';
    if (date) cbs.current.onOpenDay?.(date);
    else if (epf) cbs.current.onOpen?.(epf);
  }, []);

  const period = !!days && days.length > 0;
  // A new array literal from the parent must not invalidate the expensive pass, so the memo is
  // keyed on the kinds' content rather than on the array's identity.
  const kindKey = (kinds && kinds.length ? [...kinds] : DEFAULT_KINDS).join(',');

  // Extract the ordered trail for single-person/focused mode (pure, cheap).
  const trail = useMemo(() => {
    if (people.length !== 1) return [];
    return extractTrail(people, days);
  }, [people, days]);

  // Bucketing is pure and it is the expensive half, so it happens here and not inside the
  // Leaflet effect.
  const view = useMemo(() => {
    const asked = kindKey.split(',').filter(Boolean) as MapKind[];
    const n = countPoints(days, people);
    // Trim loudly, never silently: updates go first, then check-outs.
    let active = asked;
    let total = active.reduce((s, k) => s + n[k], 0);
    let trimmed = false;
    if (total > MAX_POINTS && active.includes('update')) {
      active = active.filter(k => k !== 'update'); trimmed = true;
      total = active.reduce((s, k) => s + n[k], 0);
    }
    if (total > MAX_POINTS && active.includes('checkout')) {
      active = active.filter(k => k !== 'checkout'); trimmed = true;
    }
    const clusters = buildClusters(buildPoints(days, people, active, t), period, t);
    return { clusters, trimmed, period };
  }, [days, people, kindKey, period, t]);

  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then((L) => {
      if (cancelled || !elRef.current) return;
      LRef.current = L;
      if (!mapRef.current) {
        mapRef.current = L.map(elRef.current, { zoomControl: true, scrollWheelZoom: false }).setView(SRI_LANKA_CENTER, 7);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(mapRef.current);
        mapRef.current.on('click', () => cbs.current.onFocus(null));
        // Popup content stops click propagation, so a listener on the map container would never
        // see these; the popup's own element is where the rows can be reached.
        mapRef.current.on('popupopen', (e: any) => e.popup?.getElement()?.addEventListener('click', onPopupClick));
        mapRef.current.on('popupclose', (e: any) => e.popup?.getElement()?.removeEventListener('click', onPopupClick));
        layerRef.current = L.layerGroup().addTo(mapRef.current);
        setTimeout(() => mapRef.current?.invalidateSize(), 60);
      }
      setReady(true);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [onPopupClick]);

  // Markers: keyed on the clusters alone, so a parent re-render no longer rebuilds the layer.
  useEffect(() => {
    const L = LRef.current, map = mapRef.current, group = layerRef.current;
    if (!ready || !L || !map || !group) return;
    const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    group.clearLayers();
    markersRef.current = view.clusters.map((c) => {
      const m = L.marker([c.lat, c.lng], { icon: clusterIcon(L, c, false, false) });
      if (c.popup) {
        m.bindPopup(c.html, { maxWidth: 320, minWidth: 230, className: 'ov-map-popup', autoPanPadding: [24, 24] });
      } else {
        m.bindTooltip(c.html, { direction: 'top', opacity: 1, sticky: false, offset: [0, -6] });
      }
      m.on('click', (e: any) => {
        e.originalEvent?.stopPropagation?.();
        if (c.popup) {
          if (c.people === 1 && c.visits[0]) {
            cbs.current.onFocus(c.visits[0].epf);
          }
          m.openPopup();
        } else {
          if (c.people === 1 && c.visits[0]) {
            const epf = c.visits[0].epf;
            cbs.current.onFocus(epf);
            if (cbs.current.onOpen) { cbs.current.onOpen(epf); }
          } else {
            map.setView([c.lat, c.lng], Math.min(16, map.getZoom() + 3), { animate: !reduce }); // spread the group out
          }
        }
      });
      m.addTo(group);
      return { c, m };
    });
  }, [ready, view]);

  // Dim and framing: a second pass so changing the focused person repaints icons instead of
  // rebuilding every marker.
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    if (!ready || !L || !map) return;
    const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const focusLatLngs: any[] = [];
    for (const { c, m } of markersRef.current) {
      const hasFocus = focusedEpf ? c.epfs.has(focusedEpf) : true;
      m.setIcon(clusterIcon(L, c, !!focusedEpf && !hasFocus, !!focusedEpf && hasFocus));
      m.setZIndexOffset(hasFocus ? 1000 : 0);
      if (focusedEpf && hasFocus) focusLatLngs.push([c.lat, c.lng]);
    }
    if (focusedEpf && focusLatLngs.length) {
      map.fitBounds(L.latLngBounds(focusLatLngs), { padding: [40, 40], maxZoom: 15, animate: !reduce });
    } else if (view.clusters.length) {
      map.fitBounds(L.latLngBounds(view.clusters.map(c => [c.lat, c.lng])), { padding: [30, 30], maxZoom: 12, animate: !reduce });
    } else {
      map.setView(SRI_LANKA_CENTER, 7, { animate: !reduce });
    }
  }, [ready, view, focusedEpf]);

  useEffect(() => () => { mapRef.current?.remove(); mapRef.current = null; layerRef.current = null; markersRef.current = []; trailCleanupRef.current?.(); trailCleanupRef.current = null; }, []);

  // Trail rendering: keyed separately from cluster markers so highlight updates are cheap.
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    // Remove any previous trail overlay
    trailCleanupRef.current?.();
    trailCleanupRef.current = null;
    if (!ready || !L || !map || trail.length < 2 || !showRoute) return;
    const { cleanup } = renderTrail(L, map, trail, highlightedWaypointIdx, onWaypointClickRef.current);
    trailCleanupRef.current = cleanup;
    // Fit map to trail extent
    const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    try {
      const bounds = L.latLngBounds(trail.map(p => [p.lat, p.lng]));
      map.fitBounds(bounds, { padding: [48, 48], maxZoom: 16, animate: !reduce });
    } catch {}
  }, [ready, trail, showRoute, highlightedWaypointIdx]);

  // Re-render trail markers when highlight changes (highlights specific waypoint ring)
  // Already covered by the dep on highlightedWaypointIdx above.

  const showEmpty = view.period && !loading && !error && view.clusters.length === 0;
  const trailDist = trail.length >= 2 ? trailDistance(trail) : 0;
  const trailFirst = trail[0];
  const trailLast = trail[trail.length - 1];
  const showHud = trail.length >= 2;

  return (
    <div className={`relative ${className}`} style={{ height }}>
      {/* Popup rows are Leaflet-owned HTML, so their hover/focus affordance cannot come from a
          className on a React element. */}
      <style>{`
        .ov-map-popup .leaflet-popup-content { margin: 8px 10px; }
        .ov-visit-wrap { min-width: 210px; }
        .ov-visit-head { font-weight: 700; margin-bottom: 4px; }
        .ov-visit-list { max-height: 232px; overflow-y: auto; }
        .ov-visit-row { display: block; width: 100%; padding: 3px 4px; border: 0; border-radius: 6px;
          background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
        .ov-visit-row:hover, .ov-visit-row:focus-visible { background: rgba(120,120,120,.16); }
        .ov-visit-top { display: flex; justify-content: space-between; gap: 14px; }
        .ov-visit-name { font-weight: 600; }
        .ov-visit-days { white-space: nowrap; font-weight: 600; }
        .ov-visit-sub { display: flex; justify-content: space-between; gap: 10px; opacity: .72; font-size: 11px; }
        .ov-visit-status { white-space: nowrap; font-weight: 600; }
      `}</style>
      <div ref={elRef} className="absolute inset-0 rounded-xl overflow-hidden border border-border" />

      {/* Status — top centre. Loading leaves the day's markers on screen underneath rather than
          blanking the map; an error says so instead of showing a confident empty month. */}
      {(loading || error || showEmpty || view.trimmed) && (
        <div className="pointer-events-none absolute inset-x-0 top-2 z-[1000] flex flex-col items-center gap-1">
          {error && (
            <span className="flex items-center gap-1.5 rounded-lg bg-popover/95 px-2.5 py-1 text-[11px] font-semibold text-foreground shadow-popover ring-1 ring-border">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-hidden />{t.ovmLoadError}
            </span>
          )}
          {loading && !error && (
            <span className="flex items-center gap-1.5 rounded-lg bg-popover/95 px-2.5 py-1 text-[11px] font-medium text-foreground shadow-popover ring-1 ring-border">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />{t.ovmPeriodLoading}
            </span>
          )}
          {showEmpty && (
            <span className="rounded-lg bg-popover/95 px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-popover ring-1 ring-border">
              {t.ovmNoPeriodGps}
            </span>
          )}
          {view.trimmed && !error && (
            <span className="flex items-center gap-1.5 rounded-lg bg-popover/95 px-2.5 py-1 text-[11px] font-medium text-foreground shadow-popover ring-1 ring-border">
              <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />{t.ovmTrimmed}
            </span>
          )}
        </div>
      )}

      {/* Legend — bottom-left, non-interactive */}
      <div className="pointer-events-none absolute bottom-2 left-2 z-[1000] flex max-w-[70%] flex-col gap-1 rounded-lg bg-popover/90 px-2.5 py-2 text-[11px] shadow-popover ring-1 ring-border">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: COL_ONSITE }} />{t.ovOnSite}</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: COL_OUTSIDE }} />{t.ovOutsideRadius}</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: COL_OUTSTATION }} />{t.ovOutstation}</span>
        {view.period && (
          <span className="flex items-center gap-1.5">
            <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-foreground/70">
              <span className="h-1.5 w-1.5 rounded-full bg-foreground/70" />
            </span>
            {t.ovmLegendStack}
          </span>
        )}
        {summaryLine && (
          <span className="mt-0.5 border-t border-border pt-1 text-muted-foreground">{summaryLine}</span>
        )}
      </div>

      {/* Route HUD — only in trail mode (single-person with >= 2 GPS points) */}
      {showHud && (
        <div className="pointer-events-auto absolute bottom-12 right-2 z-[1000] flex flex-col gap-1 rounded-xl bg-popover/95 px-3 py-2.5 text-[11px] shadow-popover ring-1 ring-border backdrop-blur-md">
          <div className="flex items-center gap-1.5 font-bold text-foreground">
            <Route className="h-3 w-3 text-sky-400" aria-hidden />
            <span>Route</span>
            <span className="ml-1 text-sky-400">{fmtDist(trailDist)}</span>
          </div>
          <div className="text-muted-foreground">
            {trail.length} stops{trailFirst?.time && trailLast?.time ? ` · ${trailFirst.time} → ${trailLast.time}` : ''}
          </div>
          <button
            type="button"
            onClick={() => setShowRoute(v => !v)}
            className="mt-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold transition-colors hover:bg-accent"
            style={{ color: showRoute ? '#38bdf8' : 'var(--muted-foreground)' }}
          >
            {showRoute ? <Eye className="h-3 w-3" aria-hidden /> : <EyeOff className="h-3 w-3" aria-hidden />}
            {showRoute ? 'Hide path' : 'Show path'}
          </button>
        </div>
      )}

      {/* Show-all — top-right, only when a person is focused; clears focus */}
      {focusedEpf && (
        <button type="button" onClick={() => onFocus(null)}
          className="pointer-events-auto absolute right-2 top-2 z-[1000] rounded-lg bg-popover/90 px-2.5 py-1 text-[11px] font-medium text-foreground shadow-popover ring-1 ring-border transition-colors hover:bg-accent">
          {t.ovMapAll}
        </button>
      )}
    </div>
  );
}
