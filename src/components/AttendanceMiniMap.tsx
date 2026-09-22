'use client';
// Small Leaflet + OpenStreetMap map for the attendance card: the day's location trail
// (check-in → in-session updates → check-out) plotted against the matched working place
// and its geofence. It is a phone-sized card, so it is tuned to answer ONE question at a
// glance — was I inside the place I was meant to be at?
//
// CONSTRAINT: --success, --primary and --brand all resolve to the SAME azure in this design
// system (globals.css), so hue can never separate check-in from check-out. They are separated
// by SHAPE instead: check-in is a solid pin with an inward arrow, check-out a hollow pin with
// an outward arrow. The legend in TodayCheckInOut mirrors that — a filled dot and a ring, not
// two dots of different colours.
//
// Do NOT reach for --destructive to force a hue apart here: it is a 350° rose that reads as hot
// pink against map tiles and collides with the orange update dot two hues away. The card's
// "currently checked in" state is red on purpose, but that is a different axis from
// check-in-vs-check-out and must not be conflated with it.
//
// Only inside-vs-outside the geofence earns its own hue (azure vs --warn-strong), and that is
// doubled with a dash pattern and an icon + words in the status chip, so colour is never the
// sole signal.
//
// Leaflet touches `window`, so this component is only ever loaded client-side
// (the dashboard imports it via next/dynamic { ssr:false }) and pulls leaflet in
// a dynamic import inside the effect — keeping it out of the initial bundle.
import { useEffect, useRef } from 'react';
import { useReducedMotion } from 'framer-motion';
import { ShieldCheck, AlertTriangle } from 'lucide-react';
import { distanceMeters } from '@/lib/geo';
import 'leaflet/dist/leaflet.css';

export interface MapPoint { lat: number; lng: number; accuracy?: number | null }
export interface MapPlace { lat: number; lng: number; radius?: number | null }
// One stop on the day's location trail (check-in → each in-session update → check-out).
// `label` is the full pre-formatted tooltip (e.g. "Check-in · 8:15 AM") so this component
// stays translation-agnostic.
export interface TrailPoint {
  lat: number; lng: number; accuracy?: number | null;
  kind: 'checkin' | 'update' | 'checkout';
  label?: string;
  /** Short permanent map label for an anchor (e.g. "In 08:15"); used with `permanentLabels`. */
  short?: string;
}

interface Props {
  checkIn?:  MapPoint | null;
  checkOut?: MapPoint | null;
  place?:    MapPlace | null;
  /** Ordered location trail. When set (and non-empty) it drives the map instead of
   *  checkIn/checkOut: a marker per stop, coloured by kind, joined by a connecting line. */
  trail?:    TrailPoint[] | null;
  /** Fly-to point (e.g. hovering a location chip) — the map zooms in and rings it; null
   *  eases back to the whole-trail view. Applied imperatively, never rebuilds the map. */
  focus?:    { lat: number; lng: number } | null;
  /** Tooltip labels (i18n) supplied by the parent so this stays translation-agnostic. */
  labels?:   { checkIn: string; checkOut: string; place: string };
  /** 'panel' = interactive card; 'background' = static, non-interactive faded backdrop. */
  variant?:  'panel' | 'background';
  /** Show each check-in / check-out stop's `short` text as an always-visible label. */
  permanentLabels?: boolean;
  /** Draw the connecting line through the stops (default). Off for a month of unrelated days. */
  connect?:  boolean;
  /** Called with the stop's index in `trail` when its marker is clicked. */
  onStopClick?: (index: number) => void;
  className?: string;
}

type Stop = { lat: number; lng: number; accuracy?: number | null; kind: TrailPoint['kind']; label?: string; short?: string };

const FALLBACK_RADIUS = 200;   // metres, when a working place carries no radius
const MIN_SEP         = 28;    // px — below this two markers read as one blob, so they fan out
// Only halo GPS points this fuzzy or worse: a tight fix adds a ring that says nothing,
// a loose one is the reason a verdict might be wrong.
const HALO_MIN_ACCURACY = 25;  // metres
// Fit padding is asymmetric: the status chip sits top-left and attribution bottom-right,
// and pins are anchored at their tip so they grow upward.
const FIT = { paddingTopLeft: [18, 34] as [number, number], paddingBottomRight: [18, 26] as [number, number], maxZoom: 15.5 };

const toStops = (
  trail: TrailPoint[] | null | undefined,
  checkIn: MapPoint | null | undefined,
  checkOut: MapPoint | null | undefined,
  labels: Props['labels'],
): Stop[] => {
  if (trail && trail.length) return trail.map(p => ({ ...p }));
  const out: Stop[] = [];
  if (checkIn)  out.push({ ...checkIn,  kind: 'checkin',  label: labels?.checkIn });
  if (checkOut) out.push({ ...checkOut, kind: 'checkout', label: labels?.checkOut });
  return out;
};

// How far outside the geofence the worst stop landed. Check-in/check-out decide the
// verdict; mid-session updates are excluded — walking off-site during the day is not the
// question this card answers.
function geofenceVerdict(stops: Stop[], place: MapPlace | null | undefined) {
  if (!place || !stops.length) return null;
  const radius  = place.radius && place.radius > 0 ? place.radius : FALLBACK_RADIUS;
  const anchors = stops.filter(s => s.kind !== 'update');
  const judged  = anchors.length ? anchors : stops;
  let worst = { stop: judged[0], outside: -Infinity };
  for (const stop of judged) {
    const outside = distanceMeters(stop.lat, stop.lng, place.lat, place.lng) - radius;
    if (outside > worst.outside) worst = { stop, outside };
  }
  return { radius, stop: worst.stop, outside: Math.max(0, worst.outside), inside: worst.outside <= 0 };
}

// Rounded to 5 m — GPS does not justify metre precision.
const fmtDistance = (m: number) =>
  m >= 950 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(5, Math.round(m / 5) * 5)} m`;

const PIN_W = 26, PIN_H = 34;
const GLYPH_IN  = '<path d="M12 5.9V13"/><path d="M8.7 9.9 12 13.2 15.3 9.9"/><path d="M7.8 16.6h8.4"/>';
const GLYPH_OUT = '<path d="M12 13.2V6"/><path d="M8.7 9.3 12 6 15.3 9.3"/><path d="M7.8 16.6h8.4"/>';

const pinSvg = (fill: string, stroke: string, glyph: string, glyphColor: string) =>
  `<svg width="${PIN_W}" height="${PIN_H}" viewBox="0 0 24 32" fill="none" aria-hidden="true" focusable="false">
     <path d="M12 30.6C12 30.6 21.5 19.4 21.5 11.5A9.5 9.5 0 1 0 2.5 11.5C2.5 19.4 12 30.6 12 30.6Z"
           fill="${fill}" stroke="${stroke}" stroke-width="2.4" stroke-linejoin="round"/>
     <g stroke="${glyphColor}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>
   </svg>`;

const placeSvg = (color: string, halo: string) =>
  `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true" focusable="false">
     <circle cx="11" cy="11" r="7" stroke="${halo}" stroke-width="4"/>
     <circle cx="11" cy="11" r="7" stroke="${color}" stroke-width="2"/>
     <circle cx="11" cy="11" r="2.4" fill="${color}" stroke="${halo}" stroke-width="1.2"/>
   </svg>`;

// In-session update dot. Sized so it reads as a deliberate stop beside a 26x34 pin instead of
// a speck of map furniture, while staying clearly subordinate to the two anchor pins.
const DOT_D = 18;
const dotSvg = (color: string, halo: string) =>
  `<svg width="${DOT_D}" height="${DOT_D}" viewBox="0 0 18 18" fill="none" aria-hidden="true" focusable="false">
     <circle cx="9" cy="9" r="5.6" fill="${color}" stroke="${halo}" stroke-width="2.8"/>
   </svg>`;

export default function AttendanceMiniMap({ checkIn, checkOut, place, trail, focus, labels, variant = 'panel', permanentLabels = false, connect = true, onStopClick, className }: Props) {
  const ref    = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const bg     = variant === 'background';
  // Latest click handler without it being a rebuild trigger for the map.
  const onStopClickRef = useRef(onStopClick);
  onStopClickRef.current = onStopClick;
  // Serialised trail so the effect re-runs when the trail changes (arrays get a new ref each render).
  const trailKey = (trail ?? []).map(p => `${p.lat},${p.lng},${p.kind},${p.short ?? ''}`).join('|');

  // Persist the Leaflet map + module + fitted bounds so the focus effect can pan/zoom
  // imperatively (on chip hover) WITHOUT rebuilding the whole map each time.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const mapRef    = useRef<any>(null);
  const LRef      = useRef<any>(null);
  const boundsRef = useRef<any[]>([]);
  const focusRef  = useRef<any>(null);   // transient highlight ring layer
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // Verdict is recomputed on every render (cheap, a handful of points) so the chip and the
  // announcement stay live even though the map itself is only rebuilt on primitive changes.
  const verdict   = geofenceVerdict(toStops(trail, checkIn, checkOut, labels), place);
  const placeName = labels?.place ?? 'the workplace';
  const stopLabel = verdict?.stop.kind === 'checkout'
    ? (labels?.checkOut ?? 'Check-out')
    : verdict?.stop.kind === 'checkin' ? (labels?.checkIn ?? 'Check-in') : placeName;
  const chipText = !verdict ? ''
    : verdict.inside ? `In range · ${placeName}`
    : `${stopLabel} · ${fmtDistance(verdict.outside)} outside`;
  const announcement = !verdict ? ''
    : verdict.inside
      ? `Recorded inside the ${placeName} area.`
      : `${stopLabel} is ${fmtDistance(verdict.outside)} outside the ${placeName} area.`;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !ref.current) return;
      LRef.current = L;

      // Pull live theme colours from the Daylight CSS tokens (so pins match light/dark).
      const cs  = getComputedStyle(document.documentElement);
      const tok = (name: string, fb: string) => {
        const v = cs.getPropertyValue(name).trim();
        return v ? `hsl(${v})` : fb;
      };
      const C_IN     = tok('--success', 'hsl(201 88% 42%)');  // check-in  (SOLID pin)
      const C_OUT    = tok('--primary', 'hsl(201 88% 42%)');  // check-out (hollow pin)
      const C_UPDATE = tok('--warning', 'hsl(32 94% 44%)');   // in-session location updates
      const C_PLACE  = tok('--brand',   'hsl(201 88% 42%)');  // working place + geofence
      const C_BREACH = tok('--warn-strong', 'hsl(22 92% 45%)'); // geofence missed
      const C_LINE   = tok('--muted-foreground', 'hsl(215 16% 47%)');
      const HALO     = tok('--card', '#ffffff');              // pin outline / knock-out

      const map = (mapRef.current = L.map(ref.current, {
        // The +/- control eats a corner of a 190px-tall map and is rarely the thing you
        // want here; pinch, double-click (shift to zoom out) and keyboard +/- still work.
        zoomControl:         false,
        attributionControl:  true,           // OSM tiles require visible attribution
        scrollWheelZoom:     false,
        dragging:            !bg,
        doubleClickZoom:     !bg,
        boxZoom:             !bg,
        keyboard:            !bg,
        touchZoom:           !bg,
        fadeAnimation:       !reduce,
        zoomAnimation:       !reduce,
        markerZoomAnimation: !reduce,
      }));
      map.attributionControl.setPrefix(false);          // drop the "Leaflet" link, keep © OSM
      map.attributionControl.setPosition('bottomleft'); // the card's own "Open in Maps" owns bottom-right

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom:     19,
        attribution: '&copy; OpenStreetMap',
      }).addTo(map);

      const icon = (html: string, w: number, h: number, anchor: [number, number], tipY: number) =>
        L.divIcon({ className: 'av-marker', html, iconSize: [w, h], iconAnchor: anchor, tooltipAnchor: [0, tipY] });
      const iconFor = (kind: TrailPoint['kind']) =>
        kind === 'update'
          ? icon(dotSvg(C_UPDATE, HALO), DOT_D, DOT_D, [DOT_D / 2, DOT_D / 2], -(DOT_D / 2 + 2))
          : kind === 'checkin'
            ? icon(pinSvg(C_IN, HALO, GLYPH_IN, HALO), PIN_W, PIN_H, [PIN_W / 2, PIN_H], -PIN_H + 4)
            : icon(pinSvg(HALO, C_OUT, GLYPH_OUT, C_OUT), PIN_W, PIN_H, [PIN_W / 2, PIN_H], -PIN_H + 4);

      const stops   = toStops(trail, checkIn, checkOut, labels);
      const v       = geofenceVerdict(stops, place);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bounds: any[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const markers: { marker: any; latlng: [number, number]; prio: number }[] = [];

      // Working place + its geofence. Solid ring = every anchor landed inside; dashed +
      // warn hue = one did not (the dash is the signal that survives greyscale).
      if (place) {
        const missed = !!v && !v.inside;
        const radius = place.radius && place.radius > 0 ? place.radius : FALLBACK_RADIUS;
        L.circle([place.lat, place.lng], {
          radius,
          color:       missed ? C_BREACH : C_PLACE,
          weight:      missed ? 2 : 1.75,
          dashArray:   missed ? '6 5' : undefined,
          fillColor:   missed ? C_BREACH : C_PLACE,
          fillOpacity: missed ? 0.05 : 0.10,
          interactive: false,               // never swallow a drag on a small map
        }).addTo(map);
        const placeMarker = L.marker([place.lat, place.lng], {
          icon: icon(placeSvg(C_PLACE, HALO), 22, 22, [11, 11], -12),
          zIndexOffset: -200,               // the day's own points sit on top
          keyboard: false,                  // markers must not each become a tab stop
        }).addTo(map);
        if (!bg && labels?.place) placeMarker.bindTooltip(labels.place, { direction: 'top', className: 'av-tip', opacity: 1 });
        bounds.push([place.lat, place.lng]);

        // The gap itself, drawn from the offending stop to the nearest point on the ring —
        // the chip says "180 m outside", this shows which way and how far.
        if (!bg && missed && v) {
          const d = distanceMeters(v.stop.lat, v.stop.lng, place.lat, place.lng);
          if (d > 0) {
            const t = 1 - v.radius / d;
            L.polyline([
              [v.stop.lat, v.stop.lng],
              [v.stop.lat + (place.lat - v.stop.lat) * t, v.stop.lng + (place.lng - v.stop.lng) * t],
            ], { color: C_BREACH, weight: 2, dashArray: '3 4', opacity: 0.9, interactive: false }).addTo(map);
          }
        }
      }

      stops.forEach((stop, index) => {
        // GPS accuracy halo — only when the fix is loose enough to put the verdict in doubt.
        if (stop.accuracy && stop.accuracy >= HALO_MIN_ACCURACY && stop.kind !== 'update') {
          L.circle([stop.lat, stop.lng], {
            radius: stop.accuracy, color: C_LINE, weight: 1, opacity: 0.45,
            fillColor: C_LINE, fillOpacity: 0.07, interactive: false,
          }).addTo(map);
        }
        const marker = L.marker([stop.lat, stop.lng], {
          icon: iconFor(stop.kind),
          zIndexOffset: stop.kind === 'update' ? 0 : 400,
          keyboard: false,
        }).addTo(map);
        // An anchor with a short text gets a permanent label (the full label is still the hover
        // tooltip's job on updates); everything else keeps the hover tooltip.
        if (!bg && permanentLabels && stop.short && stop.kind !== 'update') {
          marker.bindTooltip(stop.short, { permanent: true, direction: 'right', offset: [8, -PIN_H / 2 - 2], className: 'av-tip av-tip-perm', opacity: 1 });
        } else if (!bg && stop.label) {
          marker.bindTooltip(stop.label, { direction: 'top', className: 'av-tip', opacity: 1 });
        }
        if (!bg && onStopClickRef.current) marker.on('click', () => onStopClickRef.current?.(index));
        bounds.push([stop.lat, stop.lng]);
        markers.push({
          marker, latlng: [stop.lat, stop.lng],
          prio: stop.kind === 'checkin' ? 0 : stop.kind === 'checkout' ? 1 : 2,
        });
      });

      // Connecting route: dual-layer glowing path + directional arrows.
      const line = connect ? stops.map(s => [s.lat, s.lng] as [number, number]) : [];
      if (line.length > 1) {
        const isDash = !(trail && trail.length);
        // Outer glow aura
        L.polyline(line, {
          color: '#0284c7', weight: 9, opacity: 0.18, lineCap: 'round', lineJoin: 'round',
          dashArray: isDash ? '12 8' : undefined, interactive: false,
        }).addTo(map);
        // Crisp core
        L.polyline(line, {
          color: '#38bdf8', weight: 2.5, opacity: 0.92, lineCap: 'round', lineJoin: 'round',
          dashArray: isDash ? '6 6' : undefined, interactive: false,
        }).addTo(map);
        // Directional arrows at segment midpoints
        const toRad = (d: number) => (d * Math.PI) / 180;
        for (let i = 0; i < stops.length - 1; i++) {
          const a = stops[i], b = stops[i + 1];
          const dLng = toRad(b.lng - a.lng);
          const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
          const y = Math.sin(dLng) * Math.cos(lat2);
          const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
          const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
          const midLat = (a.lat + b.lat) / 2;
          const midLng = (a.lng + b.lng) / 2;
          const arrowHtml = `<div style="width:16px;height:16px;display:flex;align-items:center;justify-content:center;transform:rotate(${deg}deg);opacity:0.7"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 2 L11 9 L7 7 L3 9 Z" fill="#38bdf8" stroke="#0ea5e9" stroke-width="0.8"/></svg></div>`;
          L.marker([midLat, midLng], {
            icon: L.divIcon({ className: 'av-arrow', html: arrowHtml, iconSize: [16, 16], iconAnchor: [8, 8] }),
            interactive: false, zIndexOffset: -100,
          }).addTo(map);
        }
      }

      // Stops closer together than a pin is wide read as a single blob (a whole shift
      // clocked at one desk is the common case). Fan them apart in SCREEN pixels rather
      // than in degrees, so the markers stay on their true coordinates and slide back
      // together as you zoom in far enough for the real gap to show.
      const deoverlap = () => {
        const claimed: { x: number; y: number }[] = [];
        [...markers].sort((a, b) => a.prio - b.prio).forEach(({ marker, latlng }) => {
          const p = map.latLngToLayerPoint(latlng);
          let dx = 0, dy = 0;
          for (let k = 1; k <= 12; k++) {
            if (!claimed.some(c => Math.hypot(c.x - (p.x + dx), c.y - (p.y + dy)) < MIN_SEP)) break;
            const angle = k * 2.39996;                 // golden angle → an even spiral
            const r     = MIN_SEP * (0.8 + 0.28 * k);
            dx = Math.cos(angle) * r; dy = Math.sin(angle) * r;
          }
          claimed.push({ x: p.x + dx, y: p.y + dy });
          const el = marker.getElement();
          if (el) { el.style.marginLeft = `${Math.round(dx)}px`; el.style.marginTop = `${Math.round(dy)}px`; }
        });
      };
      map.on('zoomend', deoverlap);
      map.on('resize',  deoverlap);

      boundsRef.current = bounds;
      if (bounds.length === 0)      map.setView([7.0, 80.5], 7);      // Sri Lanka fallback
      else if (bounds.length === 1) map.setView(bounds[0], 14.5);
      else                          map.fitBounds(bounds, { ...FIT, animate: !reduce });
      deoverlap();

      // Leaflet mis-sizes when created inside an animating/collapsing container — recompute.
      setTimeout(() => {
        if (!cancelled && mapRef.current && ref.current) {
          mapRef.current.invalidateSize();
          setTimeout(() => {
            // Only the faded background tile shifts its content left (to clear the text scrim);
            // the interactive trail/panel map stays centred.
            if (!cancelled && bg && mapRef.current && ref.current && bounds.length > 0) {
              const width = ref.current.clientWidth || ref.current.getBoundingClientRect().width || 350;
              mapRef.current.panBy([-Math.floor(width * 0.25), 0], { animate: false });
            }
          }, 50);
        }
      }, 100);
    })();

    return () => {
      cancelled = true;
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
      focusRef.current = null;
      LRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkIn?.lat, checkIn?.lng, checkIn?.accuracy, checkOut?.lat, checkOut?.lng, checkOut?.accuracy, place?.lat, place?.lng, place?.radius, trailKey, reduce, bg, permanentLabels, connect]);

  // Imperative focus (chip hover): fly to the point + ring it; clearing eases back to the
  // whole-trail bounds. Runs only after the map exists, and never rebuilds it.
  useEffect(() => {
    const map = mapRef.current, L = LRef.current;
    if (!map || !L) return;
    if (focusRef.current) { try { map.removeLayer(focusRef.current); } catch { /* ignore */ } focusRef.current = null; }
    if (focus) {
      // Neutral white spotlight, not a hue: amber and orange already mean "update" and
      // "outside the geofence" on this map.
      focusRef.current = L.circleMarker([focus.lat, focus.lng], {
        radius: 15, color: '#ffffff', weight: 3, fillColor: 'hsl(38 92% 50%)',
        fillOpacity: 0.35, interactive: false,
      }).addTo(map);
      map.flyTo([focus.lat, focus.lng], 17, { animate: !reduce, duration: 0.45 });
    } else if (boundsRef.current.length > 1) {
      map.flyToBounds(boundsRef.current, { ...FIT, animate: !reduce, duration: 0.45 });
    } else if (boundsRef.current.length === 1) {
      map.setView(boundsRef.current[0], 14.5, { animate: !reduce });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.lat, focus?.lng]);

  return (
    <div className={className} style={{ position: 'relative', height: '100%', width: '100%' }}>
      <style dangerouslySetInnerHTML={{ __html: `
        .dark .leaflet-tile {
          filter: invert(100%) hue-rotate(180deg) brightness(75%) contrast(90%);
        }
        .dark .leaflet-container {
          background: hsl(var(--muted)) !important;
        }
        .leaflet-container:focus-visible {
          outline: 2px solid hsl(var(--ring));
          outline-offset: -2px;
        }
        .av-marker svg { filter: drop-shadow(0 1px 2px rgb(0 0 0 / .38)); }
        /* Licence attribution stays legible but stops competing with the map itself. */
        .leaflet-container .leaflet-control-attribution {
          background: hsl(var(--card) / .78);
          color: hsl(var(--muted-foreground));
          font-size: 9px; line-height: 1.5; padding: 0 4px;
          border-radius: 0 6px 0 0; box-shadow: none;
        }
        .leaflet-tooltip.av-tip {
          background: hsl(var(--popover)); color: hsl(var(--popover-foreground));
          border: 1px solid hsl(var(--border)); border-radius: 8px;
          padding: 3px 7px; font-size: 11px; font-weight: 600; white-space: nowrap;
          box-shadow: 0 4px 12px -2px rgb(0 0 0 / .18);
        }
        .leaflet-tooltip.av-tip.leaflet-tooltip-top::before { border-top-color: hsl(var(--border)); }
        .leaflet-tooltip.av-tip.av-tip-perm { padding: 2px 6px; font-size: 10px; }
        .leaflet-tooltip.av-tip.av-tip-perm.leaflet-tooltip-right::before { border-right-color: hsl(var(--border)); }
        @media (prefers-reduced-motion: reduce) {
          .leaflet-fade-anim .leaflet-tile,
          .leaflet-zoom-anim .leaflet-zoom-animated { transition: none !important; }
        }
      `}} />
      <div
        ref={ref}
        className="h-full w-full"
        style={{ zIndex: 0 }}
        role="img"
        aria-label="Map of your check-in and check-out locations"
      />

      {/* The answer, in words, over the corner the zoom buttons used to hold: icon shape +
          wording carry it, colour only reinforces. */}
      {!bg && verdict && (
        <div className="pointer-events-none absolute left-2 top-2 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-full border bg-card/95 px-2 py-1 shadow-sm"
             style={{ borderColor: verdict.inside ? 'hsl(var(--border))' : 'hsl(var(--warn-strong) / .55)' }}>
          {verdict.inside
            ? <ShieldCheck   aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-success" />
            : <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-warn-strong" />}
          <span className="min-w-0 truncate text-[10px] font-semibold leading-none text-foreground">{chipText}</span>
        </div>
      )}

      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </div>
  );
}
