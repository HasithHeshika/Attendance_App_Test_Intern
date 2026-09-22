'use client';
// Reminder scheduler — client side.
// Sends a HEARTBEAT to the reminder SW every 55 seconds with:
//   - current attendance state (checked_in, checked_out)
//   - current geolocation (if location reminder enabled and permission granted)
// Also fires time-based notifications directly from the page (belt-and-suspenders).

import { attendanceApi } from './apiCompat';
import { useAuthStore }  from '@/store/authStore';
import { useAppStore, TRANSLATIONS } from '@/store/appStore';
import { pushLocalNotification } from '@/store/notificationsStore';
import { brandName } from '@/lib/brand';

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// Reminder texts in the user's language. Computed fresh at every post to the SW (SWs
// can't call useT) — previously all reminder strings were hardcoded English.
export function reminderStrings() {
  const t = TRANSLATIONS[useAppStore.getState().lang];
  return {
    checkinTitle:  t.reminderCheckinTitle,
    checkinBody:   t.reminderCheckinBody,
    checkoutTitle: t.reminderCheckoutTitle,
    checkoutBody:  t.reminderCheckoutBody,
    arriveTitle:   t.geoArriveTitle,       // contains {site}
    arriveBody:    t.geoArriveBody,
    leaveTitle:    t.geoLeaveTitle,
    leaveBody:     t.geoLeaveBody,
  };
}

function getPrefs() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('notif-prefs');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// Resolve the reminder service worker registration. There can be several SWs (the
// Serwist precache SW + the FCM SW + this reminder SW), so we match by script URL
// instead of trusting getRegistration('/') to return the right one.
async function getReminderReg(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    const hit  = regs.find(r => (r.active ?? r.waiting ?? r.installing)?.scriptURL?.endsWith('/sw-reminder.js'));
    return hit ?? (await navigator.serviceWorker.getRegistration('/sw-reminder-scope/')) ?? null;
  } catch { return null; }
}

// True when location-based reminders should poll GPS this tick: enabled AND at least one
// geofence site is configured (the new multi-site list, or the legacy single coordinate).
function locationActive(prefs: ReturnType<typeof getPrefs>): boolean {
  if (!prefs?.reminders_enabled || !prefs?.location_enabled) return false;
  return (Array.isArray(prefs.geofences) && prefs.geofences.length > 0) || prefs.location_lat != null;
}

// ─── Attendance state (cached, refreshed every ~5 min) ────────────────────────
let cachedAttState: { checked_in: boolean; checked_out: boolean } | null = null;
let lastAttFetch = 0;

async function getAttendanceState() {
  const now = Date.now();
  // Checked-in status is stable across a shift, and check-in/out invalidates this cache
  // immediately, so a long TTL is safe and roughly halves background reads.
  if (cachedAttState && now - lastAttFetch < 15 * 60 * 1000) return cachedAttState;
  try {
    const u   = useAuthStore.getState().user;
    const epf = u?.epf_number ?? '';
    if (!epf) return cachedAttState ?? { checked_in: false, checked_out: false };
    // Pass the in-memory user so getMyTodayAttendance skips its users/{epf} read.
    const res  = await attendanceApi.getMyTodayAttendance(epf, u ?? undefined);
    const data = res.data?.data ?? res.data;
    const att  = data?.today_attendance ?? data;
    cachedAttState = {
      checked_in:  !!att?.check_in,
      checked_out: !!att?.check_out,
    };
    lastAttFetch = now;
  } catch { /* use cached */ }
  return cachedAttState ?? { checked_in: false, checked_out: false };
}

// ─── Geolocation ──────────────────────────────────────────────────────────────
function getCurrentPosition(): Promise<{ lat: number; lng: number } | null> {
  return new Promise(resolve => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      p  => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
    );
  });
}

// Continuous position watch (foreground only) so ARRIVAL at a site is caught within
// seconds instead of waiting for the next 55s heartbeat. NOTE: this — like all web
// geolocation — pauses when the app is backgrounded/closed; there is no true background
// geofencing on the web (see the platform warning in Settings).
let watchId: number | null = null;
let lastWatchPos: { lat: number; lng: number; t: number } | null = null;
let lastWatchPing = 0;

function startLocationWatch() {
  if (watchId != null || typeof navigator === 'undefined' || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(
    p => {
      lastWatchPos = { lat: p.coords.latitude, lng: p.coords.longitude, t: Date.now() };
      // Push the fresh fix to the SW promptly (throttled) for near-instant arrival alerts.
      const now = Date.now();
      if (now - lastWatchPing > 15_000) {
        lastWatchPing = now;
        pingReminderSW({ lat: lastWatchPos.lat, lng: lastWatchPos.lng });
      }
    },
    () => { /* transient error — the heartbeat falls back to a one-shot getCurrentPosition */ },
    { enableHighAccuracy: false, maximumAge: 30_000, timeout: 20_000 },
  );
}

function stopLocationWatch() {
  if (watchId != null && typeof navigator !== 'undefined' && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
  }
  watchId = null;
  lastWatchPos = null;
}

// Send a heartbeat message to the reminder SW. Omitting attendanceState leaves the SW's
// last cached state intact (used by the fast watch-driven pings, which carry only position).
async function pingReminderSW(position: { lat: number; lng: number } | null, attState?: unknown) {
  const reg = await getReminderReg();
  reg?.active?.postMessage({ type: 'HEARTBEAT', attendanceState: attState ?? null, position });
}

// ─── Ping the SW with full context ────────────────────────────────────────────
async function heartbeat() {
  const prefs = getPrefs();

  // Time-based: also fire directly from the page when tab is open
  checkTimeBasedDirect(prefs);

  // Nothing to send to the reminder service worker unless reminders are enabled — skip
  // the attendance read entirely for sessions that haven't turned reminders on.
  if (!prefs?.reminders_enabled) return;

  // Gather context to send to SW
  const attState = await getAttendanceState();
  let position: { lat: number; lng: number } | null = null;

  if (locationActive(prefs)) {
    startLocationWatch();   // keep a live watch running for fast arrival detection
    // Prefer the freshest watched fix (<60s old); otherwise take a one-shot reading.
    position = (lastWatchPos && Date.now() - lastWatchPos.t < 60_000)
      ? { lat: lastWatchPos.lat, lng: lastWatchPos.lng }
      : await getCurrentPosition();
  } else {
    stopLocationWatch();    // location reminders off — release the GPS watch
  }

  // Send heartbeat to the reminder SW (matched by script URL, not scope).
  await pingReminderSW(position, attState);
}

// ─── Direct in-page time check (fires when tab is open) ───────────────────────
function checkTimeBasedDirect(prefs: ReturnType<typeof getPrefs>) {
  if (!prefs?.reminders_enabled) return;
  // Guard the whole API: iOS Safari (browser tab) has no Notification constructor at
  // all — the unguarded permission read used to throw on every 55s heartbeat there.
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  const now     = new Date();
  const today   = now.toDateString();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const firedKey = `reminder-fired-${today}`;

  const fired: Record<string, boolean> = (() => {
    try { return JSON.parse(localStorage.getItem(firedKey) ?? '{}'); }
    catch { return {}; }
  })();

  const tryFire = (type: 'checkin' | 'checkout', timeStr: string) => {
    const key = `time_${type}`;
    if (fired[key]) return;
    const [h, m] = timeStr.split(':').map(Number);
    if (Math.abs(nowMins - (h * 60 + m)) <= 1) {
      const s     = reminderStrings();
      const title = type === 'checkin' ? s.checkinTitle : s.checkoutTitle;
      const body  = type === 'checkin' ? s.checkinBody  : s.checkoutBody;

      // Surface it in the in-app notification center (reminders used to vanish —
      // OS-notification only). Stable per-day id so re-fires merge, not duplicate.
      pushLocalNotification({
        id:   `local-rem-${type}-${new Date().toISOString().slice(0, 10)}`,
        type: 'reminder',
        title,
        body,
        link: '/attendance',
      });

      // Mark fired BEFORE the async display path — never re-fire even if display fails.
      fired[key] = true;
      localStorage.setItem(firedKey, JSON.stringify(fired));

      // System notification via the SW (the page `new Notification()` constructor
      // throws "Illegal constructor" on Android Chrome). Same tag as the SW path so
      // the two belt-and-suspenders deliveries collapse into one.
      void (async () => {
        try {
          const reg = await getReminderReg();
          const opts = { body, icon: '/app.png', badge: '/app.png', tag: `time-${type}` };
          if (reg) await reg.showNotification(`${brandName()} — ${title}`, opts);
          else new Notification(`${brandName()} — ${title}`, opts);
        } catch { /* the SW heartbeat path delivers it */ }
      })();
    }
  };

  if (prefs.checkin_time)  tryFire('checkin',  prefs.checkin_time);
  if (prefs.checkout_time) tryFire('checkout', prefs.checkout_time);
}

// ─── Public API ───────────────────────────────────────────────────────────────
export function startReminderScheduler() {
  if (typeof window === 'undefined') return;
  if (heartbeatTimer) return;
  // Sweep yesterday's (and older) fired-tracker keys — they used to accumulate forever.
  try {
    const todayKey = `reminder-fired-${new Date().toDateString()}`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('reminder-fired-') && k !== todayKey) localStorage.removeItem(k);
    }
  } catch { /* non-critical */ }
  heartbeat();
  heartbeatTimer = setInterval(heartbeat, 55 * 1000);
}

export function stopReminderScheduler() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  stopLocationWatch();
}

// Invalidate attendance cache when user checks in/out
export function invalidateAttendanceCache() {
  cachedAttState = null;
  lastAttFetch   = 0;
}

export async function updateReminderPrefs(prefs: object) {
  localStorage.setItem('notif-prefs', JSON.stringify(prefs));
  if (!('serviceWorker' in navigator)) return;
  const reg = await getReminderReg();
  // Attach the current-language reminder texts — the SW can't translate by itself.
  reg?.active?.postMessage({ type: 'UPDATE_REMINDER_PREFS', prefs: { ...prefs, strings: reminderStrings() } });
}

// Fire a one-off notification so the user can confirm the PWA actually delivers them.
// Prefers a service-worker notification (required on iOS / works when backgrounded),
// falling back to the page Notification constructor. Returns false if not permitted.
export async function sendTestNotification(title: string, body: string): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission !== 'granted') {
    const perm = await Notification.requestPermission().catch(() => 'denied');
    if (perm !== 'granted') return false;
  }
  const opts = { body, icon: '/app.png', badge: '/app.png', tag: 'pc-test', vibrate: [120, 60, 120] } as NotificationOptions;
  try {
    const reg = (await getReminderReg())
      ?? (await navigator.serviceWorker?.getRegistration?.())
      ?? null;
    if (reg) { await reg.showNotification(title, opts); return true; }
    new Notification(title, opts);
    return true;
  } catch { return false; }
}
