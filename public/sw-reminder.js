// Reminder Service Worker
// Heartbeat-based scheduler (55s interval from client keeps SW alive).
// Handles:
//   1. Time-based check-in / check-out reminders
//   2. Location-based reminders:
//        - Arriving near office while not checked in  → check-in reminder
//        - Leaving office area while checked in       → check-out reminder

const CACHE_NAME = 'reminder-prefs-v1';

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

// ─── Cache helpers ────────────────────────────────────────────────────────────
async function cacheSet(key, value) {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(key, new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  }));
}
async function cacheGet(key) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const res   = await cache.match(key);
    return res ? await res.json() : null;
  } catch { return null; }
}

// ─── Message handler ──────────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  const { type, prefs, attendanceState, position } = event.data ?? {};

  if (type === 'UPDATE_REMINDER_PREFS') {
    cacheSet('/sw-prefs', prefs).then(() => checkTimeBased());
  }
  if (type === 'HEARTBEAT') {
    // Client sends current attendance state + geolocation on each tick
    Promise.all([
      attendanceState != null ? cacheSet('/sw-att-state', attendanceState) : Promise.resolve(),
      position        != null ? cacheSet('/sw-position',  position)        : Promise.resolve(),
    ]).then(() => Promise.all([checkTimeBased(), checkLocationBased()]));
  }
});

// ─── Fired-today tracker ──────────────────────────────────────────────────────
async function getFired() {
  const fired    = await cacheGet('/sw-fired') ?? {};
  const todayKey = new Date().toDateString();
  if (fired._date !== todayKey) {
    const fresh = { _date: todayKey };
    await cacheSet('/sw-fired', fresh);
    return fresh;
  }
  return fired;
}
async function markFired(key) {
  const fired = await getFired();
  fired[key]  = true;
  await cacheSet('/sw-fired', fired);
}

// ─── 1. Time-based reminders ──────────────────────────────────────────────────
async function checkTimeBased() {
  const prefs = await cacheGet('/sw-prefs');
  if (!prefs?.reminders_enabled) return;

  const now     = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const fired   = await getFired();

  // Translated texts arrive with the prefs (UPDATE_REMINDER_PREFS attaches `strings`
  // in the user's language); English literals are only the fallback.
  const s = prefs.strings ?? {};
  const tryTime = async (type, timeStr) => {
    if (fired[`time_${type}`] || !timeStr) return;
    const [h, m]  = timeStr.split(':').map(Number);
    if (Math.abs(nowMins - (h * 60 + m)) <= 1) {
      await notify(
        type === 'checkin' ? (s.checkinTitle ?? 'Time to check in') : (s.checkoutTitle ?? 'Time to check out'),
        type === 'checkin' ? (s.checkinBody ?? 'Don\'t forget to check in for today.') : (s.checkoutBody ?? 'Have a great evening!'),
        `time-${type}`
      );
      await markFired(`time_${type}`);
    }
  };

  await tryTime('checkin',  prefs.checkin_time);
  await tryTime('checkout', prefs.checkout_time);
}

// ─── 2. Location-based reminders ─────────────────────────────────────────────
// Geofences come from the user's real working places (those with GPS set). We remind
// on arrival at ANY configured site, and on leaving the site they were inside.
function geofenceList(prefs) {
  if (Array.isArray(prefs.geofences) && prefs.geofences.length) return prefs.geofences;
  // Legacy single-coordinate fallback.
  if (prefs.location_lat != null && prefs.location_lng != null) {
    return [{ name: 'Office', lat: prefs.location_lat, lng: prefs.location_lng, radius: prefs.location_radius }];
  }
  return [];
}

// Nearest configured site whose own radius (falling back to the global one) contains pos.
function siteContaining(pos, sites, fallbackRadius) {
  let best = null;
  for (const s of sites) {
    if (s.lat == null || s.lng == null) continue;
    const dist = haversine(pos.lat, pos.lng, s.lat, s.lng);
    const r    = s.radius ?? fallbackRadius;
    if (dist <= r && (best === null || dist < best.dist)) best = { name: s.name, dist };
  }
  return best;
}

async function checkLocationBased() {
  const prefs = await cacheGet('/sw-prefs');
  if (!prefs?.reminders_enabled || !prefs?.location_enabled) return;

  const sites = geofenceList(prefs);
  if (!sites.length) return;

  const pos = await cacheGet('/sw-position');
  if (!pos) return;

  const att      = await cacheGet('/sw-att-state') ?? {};
  const fired    = await getFired();
  const fallback = prefs.location_radius ?? 300;
  const match    = siteContaining(pos, sites, fallback);   // null when outside every site
  const inside   = !!match;

  const s = prefs.strings ?? {};

  // Arriving: inside any site, not checked in → check-in reminder (once per day)
  if (inside && !att.checked_in && !fired.loc_arrive) {
    await notify(
      (s.arriveTitle ?? 'You\'re near {site}').replace('{site}', match.name),
      s.arriveBody ?? 'Don\'t forget to check in!',
      'loc-checkin'
    );
    await markFired('loc_arrive');
  }

  // Leaving: outside all sites, was inside, checked in → check-out reminder (once per day)
  if (!inside && att.checked_in && !att.checked_out && !fired.loc_leave) {
    const wasInside = await cacheGet('/sw-was-inside');
    if (wasInside) {
      await notify(
        s.leaveTitle ?? 'You\'ve left your work area',
        s.leaveBody ?? 'Don\'t forget to check out!',
        'loc-checkout'
      );
      await markFired('loc_leave');
    }
  }

  // Track whether we were inside on this tick (for leave detection)
  await cacheSet('/sw-was-inside', inside);
}

// ─── Haversine distance (metres) ─────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R   = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Brand name for the domain this worker was registered on. A service worker is a static file
// shared byte-for-byte by every domain and cannot import src/lib/tenants.ts, so the server
// resolves the brand from this request's own Host header and hands it back as a script.
// No domain is named here: adding a tenant means editing TENANTS and nothing else.
// Wrapped because a failed importScripts would abort the whole worker — brand text is not
// worth that, so an offline start just falls back to an unbranded title.
try {
  importScripts('/api/brand-sw-config');
} catch (e) {
  // leaves self.TENANT_BRAND undefined
}
const BRAND = (self.TENANT_BRAND && self.TENANT_BRAND.appName) || '';

// ─── Show notification ────────────────────────────────────────────────────────
function notify(title, body, tag) {
  return self.registration.showNotification(BRAND ? `${BRAND} — ${title}` : title, {
    body,
    icon:               '/app.png',
    badge:              '/app.png',
    tag,
    data:               { url: '/attendance' },
    vibrate:            [200, 100, 200],
    requireInteraction: true,
  });
}

// ─── Notification click ───────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/attendance';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          client.postMessage({ type: 'NAVIGATE', url: self.location.origin + url });
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(self.location.origin + url);
    })
  );
});
