'use client';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import { loadLeaflet } from '@/lib/leaflet';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MapMarker {
  lat: number;
  lng: number;
  label?: string;
  color?: string;
  fillColor?: string;
  radius?: number;
  popup?: string;
}

// A small read-only OpenStreetMap (Leaflet) preview with one or more markers — and an optional
// geofence radius circle.
export default function LeafletMiniMap({
  lat,
  lng,
  markers,
  zoom = 15,
  radiusMeters,
  height = 168,
  className = '',
}: {
  lat?: number;
  lng?: number;
  markers?: MapMarker[];
  zoom?: number;
  radiusMeters?: number;
  height?: number;
  className?: string;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersGroupRef = useRef<any>(null);
  const polylineRef = useRef<any>(null);
  const circleRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    const activeMarkers: MapMarker[] = markers && markers.length > 0
      ? markers
      : (typeof lat === 'number' && typeof lng === 'number' ? [{ lat, lng, color: '#0ea5e9', fillColor: '#38bdf8' }] : []);

    if (activeMarkers.length === 0) return;

    const initialCenter: [number, number] = [activeMarkers[0].lat, activeMarkers[0].lng];

    loadLeaflet().then((L) => {
      if (cancelled || !elRef.current) return;
      if (!mapRef.current) {
        mapRef.current = L.map(elRef.current, { zoomControl: true, scrollWheelZoom: false })
          .setView(initialCenter, zoom);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap contributors',
        }).addTo(mapRef.current);
        markersGroupRef.current = L.layerGroup().addTo(mapRef.current);
        // The container is often inside an animating modal — fix tile sizing once laid out.
        setTimeout(() => mapRef.current?.invalidateSize(), 60);
      }

      const map = mapRef.current;
      const group = markersGroupRef.current;
      if (group) group.clearLayers();
      if (polylineRef.current) { polylineRef.current.remove(); polylineRef.current = null; }

      const latLngs: [number, number][] = [];

      activeMarkers.forEach((m) => {
        const markerPos: [number, number] = [m.lat, m.lng];
        latLngs.push(markerPos);
        const cm = L.circleMarker(markerPos, {
          radius: m.radius ?? 8,
          color: m.color ?? '#0ea5e9',
          weight: 2.5,
          fillColor: m.fillColor ?? m.color ?? '#38bdf8',
          fillOpacity: 0.9,
        }).addTo(group);

        if (m.label) {
          cm.bindTooltip(m.label, {
            permanent: true,
            direction: 'top',
            offset: [0, -8],
            className: 'leaflet-tooltip-site',
          });
        }
        if (m.popup) {
          cm.bindPopup(m.popup);
        }
      });

      // If multiple markers, draw dual-layer glowing route + directional arrows
      if (latLngs.length > 1) {
        // Outer glow aura
        L.polyline(latLngs, {
          color: '#0284c7', weight: 8, opacity: 0.18, dashArray: '12 8',
        }).addTo(map);
        // Crisp core
        polylineRef.current = L.polyline(latLngs, {
          color: '#38bdf8', weight: 2.5, opacity: 0.9, dashArray: '5 7',
        }).addTo(map);
        // Directional arrows
        const toRad = (d: number) => (d * Math.PI) / 180;
        for (let i = 0; i < latLngs.length - 1; i++) {
          const [aLat, aLng] = latLngs[i], [bLat, bLng] = latLngs[i + 1];
          const dLng = toRad(bLng - aLng);
          const lat1 = toRad(aLat), lat2 = toRad(bLat);
          const y = Math.sin(dLng) * Math.cos(lat2);
          const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
          const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
          const midLat = (aLat + bLat) / 2, midLng = (aLng + bLng) / 2;
          const html = `<div style="width:16px;height:16px;display:flex;align-items:center;justify-content:center;transform:rotate(${deg}deg);opacity:0.7"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 2 L11 9 L7 7 L3 9 Z" fill="#38bdf8" stroke="#0ea5e9" stroke-width="0.8"/></svg></div>`;
          L.marker([midLat, midLng], {
            icon: L.divIcon({ className: 'lm-arrow', html, iconSize: [16, 16], iconAnchor: [8, 8] }),
            interactive: false,
          }).addTo(map);
        }
      }

      // Radius circle if single point with radiusMeters
      if (activeMarkers.length === 1 && radiusMeters && radiusMeters > 0) {
        if (!circleRef.current) {
          circleRef.current = L.circle(initialCenter, {
            radius: radiusMeters, color: '#0ea5e9', weight: 1, fillColor: '#38bdf8', fillOpacity: 0.12,
          }).addTo(map);
        } else {
          circleRef.current.setLatLng(initialCenter).setRadius(radiusMeters);
        }
        map.fitBounds(circleRef.current.getBounds(), { padding: [14, 14], maxZoom: 17 });
      } else {
        if (circleRef.current) { circleRef.current.remove(); circleRef.current = null; }
        if (latLngs.length > 1) {
          const bounds = L.latLngBounds(latLngs);
          map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
        } else {
          map.setView(initialCenter, zoom);
        }
      }
    }).catch(() => { /* offline / blocked — silently skip the map */ });
    return () => { cancelled = true; };
  }, [lat, lng, markers, zoom, radiusMeters]);

  // Tear the map down on unmount.
  useEffect(() => () => { mapRef.current?.remove(); mapRef.current = null; }, []);

  return (
    <div ref={elRef} className={`rounded-xl overflow-hidden border border-border ${className}`}
      style={{ height }} />
  );
}
