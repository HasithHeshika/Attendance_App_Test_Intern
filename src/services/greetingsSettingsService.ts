import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { DEFAULT_GREETING_SETTINGS, type GreetingSettings, type OccasionKind, type Sender } from '@/lib/greetings';

// Thin client for the admin-verified greetings routes. Reads and writes both go through the
// server: the settings doc is client-readable, but keeping one path means the page always
// shows what the server normalised, and writes stay behind verifyAdminCaller.
async function idToken(): Promise<string> {
  const tok = await auth.currentUser?.getIdToken();
  if (!tok) throw new Error('Not signed in');
  return tok;
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  try {
    const j = await res.json();
    return typeof j?.error === 'string' ? j.error : fallback;
  } catch { return fallback; }
}

export async function getGreetingSettings(): Promise<GreetingSettings> {
  // The token goes in a header, never the query string: a URL is written to the server's access
  // log, the browser's history and any Referer it sends, and a Firebase ID token is a live
  // credential for the admin's whole session. POST/PUT can carry it in the body safely; a GET
  // has no body, so it uses Authorization.
  const res = await fetch('/api/admin/greetings/settings', {
    cache: 'no-store',
    headers: { authorization: `Bearer ${await idToken()}` },
  });
  if (!res.ok) throw new Error(await errorOf(res, 'Failed to load greeting settings'));
  const d = await res.json();
  return { ...DEFAULT_GREETING_SETTINGS, ...(d.settings ?? {}) };
}

export async function saveGreetingSettings(settings: GreetingSettings): Promise<GreetingSettings> {
  const res = await fetch('/api/admin/greetings/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: await idToken(), settings }),
  });
  if (!res.ok) throw new Error(await errorOf(res, 'Failed to save greeting settings'));
  return (await res.json()).settings as GreetingSettings;
}

export async function sendTestGreeting(
  epf: string, occasion: OccasionKind, dayId?: string,
): Promise<{ name: string; senders: Sender[] }> {
  const res = await fetch('/api/admin/greetings/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: await idToken(), epf, occasion, dayId }),
  });
  if (!res.ok) throw new Error(await errorOf(res, 'Failed to send the test greeting'));
  return res.json();
}

// ─── Device-side read ─────────────────────────────────────────────────────────
// A special day is the SAME for everyone, so having the server write one notification and one
// push per employee is 300 writes and 300 pushes to say one identical sentence. The settings
// document is client-readable, so each device resolves the day itself and renders the card
// locally instead (see GreetingCard). Birthdays and anniversaries stay server-side: they are
// per-person, need a push when the app is closed, and are a handful of sends a day.
//
// One in-flight read is shared per page load; the settings doc is tiny and changes rarely.
let publicSettings: Promise<GreetingSettings> | null = null;

export function readGreetingSettingsForDevice(): Promise<GreetingSettings> {
  publicSettings ??= (async () => {
    try {
      const snap = await getDoc(doc(db, 'settings', 'greetings'));
      if (!snap.exists()) return { ...DEFAULT_GREETING_SETTINGS };
      const d = snap.data();
      const days = Array.isArray(d.special_days) ? d.special_days : [];
      return {
        ...DEFAULT_GREETING_SETTINGS,
        enabled: d.enabled === true,
        birthday: d.birthday !== false,
        anniversary: d.anniversary !== false,
        special: d.special !== false,
        special_days: days,
      };
    } catch {
      // Not signed in yet, offline, or rules said no — the card simply does not show.
      return { ...DEFAULT_GREETING_SETTINGS };
    }
  })();
  return publicSettings;
}
