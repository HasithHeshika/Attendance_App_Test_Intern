'use client';
// Firebase Cloud Messaging — full implementation
// Handles: token registration, foreground messages, in-app toast notifications


const FIREBASE_CONFIG = {
  apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain:        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};
const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;

// Callbacks registered by the app to react to incoming messages
type MessageCallback = (payload: FCMPayload) => void;
const messageCallbacks: MessageCallback[] = [];
// One NAVIGATE listener per page load (guards against stacking across re-auths).
let navListenerAdded = false;

export interface FCMPayload {
  title:   string;
  body:    string;
  type?:   string;   // approval_request | leave_update | attendance_edit | edit_approved | edit_rejected
  data?:   Record<string, string>;
}

export function onFCMMessage(cb: MessageCallback) {
  messageCallbacks.push(cb);
  return () => {
    const i = messageCallbacks.indexOf(cb);
    if (i > -1) messageCallbacks.splice(i, 1);
  };
}

export async function initializeFCM(): Promise<string | null> {
  if (typeof window === 'undefined') return null;

  try {
    const { initializeApp, getApps }             = await import('firebase/app');
    const { getMessaging, getToken, onMessage }  = await import('firebase/messaging');

    const app       = getApps().length === 0 ? initializeApp(FIREBASE_CONFIG) : getApps()[0];
    const messaging = getMessaging(app);

    // Register the service worker and wait until it is active
    // Declared outside the if-block so onMessage can reference it for showNotification
    let swReg: ServiceWorkerRegistration | undefined;
    if ('serviceWorker' in navigator) {
      try {
        swReg = await navigator.serviceWorker.register(
          '/firebase-messaging-sw.js',
          { scope: '/firebase-cloud-messaging-push-scope' }
        );
        // Wait for the SW to become active (handles first-install and update cases)
        await new Promise<void>(resolve => {
          const sw = swReg!.installing ?? swReg!.waiting ?? swReg!.active;
          if (swReg!.active) { resolve(); return; }
          if (sw) {
            sw.addEventListener('statechange', function handler() {
              if ((sw as ServiceWorker).state === 'activated') {
                sw.removeEventListener('statechange', handler);
                resolve();
              }
            });
          } else {
            resolve();
          }
        });
      } catch (err) {
        console.warn('SW registration failed:', err);
      }
    }

    // Request notification permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.info('Notification permission denied');
      return null;
    }

    // Get FCM token
    const token = await getToken(messaging, {
      vapidKey:                VAPID_KEY,
      serviceWorkerRegistration: swReg,
    });

    if (!token) {
      console.warn('No FCM token received');
      return null;
    }

    // Handle foreground messages (app is open and focused)
    onMessage(messaging, (payload) => {
      const notification = payload.notification;
      const data         = payload.data ?? {};
      // Pushes are DATA-ONLY (push-only architecture) — the real content lives in `data`.
      // `realType` is the app-facing type; `type` is the SW's legacy click-routing name.
      const type         = (data.realType as string) || (data.type as string) || undefined;

      const fcmPayload: FCMPayload = {
        title: (data.title as string) || notification?.title || 'WorkForce Pro',
        body:  (data.body  as string) || notification?.body  || '',
        type,
        data:  data as Record<string, string>,
      };

      // Notify all registered listeners (e.g. the notification panel)
      messageCallbacks.forEach(cb => cb(fcmPayload));

      // In-app notifications are delivered via messageCallbacks to the notification panel.
      // We deliberately do NOT call swReg.showNotification here because the Service Worker's
      // push event listener already handles and displays the system notification when the app
      // is in the background, avoiding duplicate notifications.
    });

    // Listen for navigation messages from the service worker — registered once per page
    // load (setupFCM re-runs on re-auth and used to stack a new listener each time).
    if (!navListenerAdded) {
      navListenerAdded = true;
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'NAVIGATE' && event.data.url) {
          window.location.href = event.data.url;
        }
        if (event.data?.type === 'OPEN_NOTIFICATIONS') {
          import('@/store/notificationsStore').then(({ useNotificationsStore }) => {
            useNotificationsStore.getState().openNotificationCenter();
          });
        }
      });
    }

    return token;

  } catch (error) {
    console.error('FCM initialization error:', error);
    return null;
  }
}

export async function saveFCMToken(token: string): Promise<void> {
  const { authApi }   = await import('./apiCompat');
  const { useAuthStore } = await import('@/store/authStore');
  try {
    const epf = useAuthStore.getState().user?.epf_number ?? '';
    if (!epf) return;
    // Skip the Firestore write when this device's token is already saved — this runs on
    // every app open for 300+ users, and unchanged tokens were pure write amplification.
    const cacheKey = `fcm-token-saved:${epf}`;
    let oldToken: string | null = null;
    try {
      oldToken = localStorage.getItem(cacheKey);
      if (oldToken === token) return;
    } catch { /* storage off */ }
    // Pass this device's previous token so the backend can drop it from fcm_tokens —
    // otherwise a rotated-but-not-yet-dead token lingers there and the device gets every
    // push delivered twice for as long as both remain live.
    await authApi.saveFcmToken({ fcm_token: token, epf_number: epf, old_fcm_token: oldToken });
    try { localStorage.setItem(cacheKey, token); } catch { /* non-critical */ }
  } catch (error) {
    console.error('Failed to save FCM token:', error);
  }
}

// Register and initialise the reminder service worker.
// Loads saved prefs from localStorage and posts them to the SW so it can
// schedule notifications even when the app tab is closed.
export async function setupReminderSW(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    // Own, narrow scope: only ONE registration can hold a scope, and '/' belongs to the
    // Serwist precache SW (sw.js) — registering here at '/' made the two SWs evict each
    // other on every login. The reminder SW never controls pages (it only shows
    // notifications and answers postMessages), so any scope works.
    const reg = await navigator.serviceWorker.register('/sw-reminder.js', { scope: '/sw-reminder-scope/' });
    // Wait until active
    await new Promise<void>(resolve => {
      const sw = reg.installing ?? reg.waiting ?? reg.active;
      if (reg.active) { resolve(); return; }
      if (sw) sw.addEventListener('statechange', function h() {
        if ((sw as ServiceWorker).state === 'activated') { sw.removeEventListener('statechange', h); resolve(); }
      });
      else resolve();
    });
    // Send stored prefs so the SW can schedule on startup — with the current-language
    // reminder texts attached (the SW can't translate by itself).
    const raw   = localStorage.getItem('notif-prefs');
    const prefs = raw ? JSON.parse(raw) : null;
    if (prefs && reg.active) {
      const { reminderStrings } = await import('./reminderScheduler');
      reg.active.postMessage({ type: 'UPDATE_REMINDER_PREFS', prefs: { ...prefs, strings: reminderStrings() } });
    }
  } catch (err) {
    console.warn('Reminder SW registration failed:', err);
  }
}

// Call on login — initializes FCM and saves token to backend
export async function setupFCM(): Promise<void> {
  const token = await initializeFCM();
  if (token) await saveFCMToken(token);
  await setupReminderSW();
}