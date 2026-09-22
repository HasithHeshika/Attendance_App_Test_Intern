import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { requestDeviceLocation, claimDenialReload } from '../geo';

// ─── A scriptable stand-in for navigator.geolocation ──────────────────────────
// watchPosition is driven by hand so each test can reproduce one real-world sequence:
// a coarse fix that never sharpens, a provider that errors once then answers, a hard
// permission block, and so on.
type PosCb = (p: { coords: { latitude: number; longitude: number; accuracy: number } }) => void;
type ErrCb = (e: { code: number; message: string }) => void;

let cleared: number[] = [];
function installGeolocation() {
  let nextId = 1;
  const watchers = new Map<number, { onPos: PosCb; onErr: ErrCb }>();
  const geolocation = {
    watchPosition(onPos: PosCb, onErr: ErrCb) {
      const id = nextId++;
      watchers.set(id, { onPos, onErr });
      return id;
    },
    clearWatch(id: number) { cleared.push(id); watchers.delete(id); },
    getCurrentPosition() { throw new Error('requestDeviceLocation must not fall back to getCurrentPosition'); },
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { geolocation, userAgent: 'test' },
    configurable: true,
    writable: true,
  });
  return {
    emit(accuracy: number, lat = 6.9, lng = 79.9) {
      for (const w of watchers.values()) w.onPos({ coords: { latitude: lat, longitude: lng, accuracy } });
    },
    // Deliberately a PLAIN object: no PERMISSION_DENIED/TIMEOUT constants on it, the way
    // several Android WebViews report a geolocation failure.
    emitError(code: number) {
      for (const w of watchers.values()) w.onErr({ code, message: 'geolocation error' });
    },
    get watching() { return watchers.size; },
  };
}

afterEach(() => {
  cleared = [];
  // The self-heal tests install window/sessionStorage — nothing else may inherit them.
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.sessionStorage;
});

test('a permission denial is reported as denied even when the error carries no constants', async () => {
  const geo = installGeolocation();
  const p = requestDeviceLocation({ timeoutMs: 5_000 });
  geo.emitError(1); // PERMISSION_DENIED
  const res = await p;
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.code, 'denied');
  // The whole point: it must NOT degrade into the generic "could not get your location".
  assert.ok(res.ok === false && /blocked|Location is off/i.test(res.reason), res.ok === false ? res.reason : '');
  assert.equal(geo.watching, 0, 'the watch must be released');
});

test('a sharp fix resolves immediately and stops the watch', async () => {
  const geo = installGeolocation();
  const p = requestDeviceLocation({ timeoutMs: 5_000 });
  geo.emit(20);
  const res = await p;
  assert.deepEqual(res, { ok: true, lat: 6.9, lng: 79.9, accuracy: 20 });
  assert.equal(geo.watching, 0);
  assert.equal(cleared.length, 1);
});

test('a coarse fix that never sharpens is still an answer, not an error', async () => {
  const geo = installGeolocation();
  const p = requestDeviceLocation({ timeoutMs: 120 });
  geo.emit(800); // far too coarse to settle early
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(res.ok === true && res.accuracy, 800);
});

test('the sharpest reading wins when several arrive', async () => {
  const geo = installGeolocation();
  const p = requestDeviceLocation({ timeoutMs: 120 });
  geo.emit(900, 1, 1);
  geo.emit(300, 2, 2);
  geo.emit(600, 3, 3);
  const res = await p;
  assert.equal(res.ok === true && res.accuracy, 300);
  assert.equal(res.ok === true && res.lat, 2);
});

test('a transient POSITION_UNAVAILABLE does not end the attempt', async () => {
  const geo = installGeolocation();
  const p = requestDeviceLocation({ timeoutMs: 5_000 });
  geo.emitError(2);  // cold GPS errors first…
  geo.emit(30);      // …then delivers, as it routinely does on Android
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(res.ok === true && res.accuracy, 30);
});

test('with nothing but errors, the last one decides the message', async () => {
  const geo = installGeolocation();
  const unavailable = requestDeviceLocation({ timeoutMs: 80 });
  geo.emitError(2);
  const a = await unavailable;
  assert.equal(a.ok === false && a.code, 'unavailable');

  const geo2 = installGeolocation();
  const silent = requestDeviceLocation({ timeoutMs: 80 });
  void geo2; // never emits anything at all
  const b = await silent;
  assert.equal(b.ok === false && b.code, 'timeout');
});

test('no geolocation support is its own reason', async () => {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'test' }, configurable: true, writable: true,
  });
  const res = await requestDeviceLocation();
  assert.equal(res.ok === false && res.code, 'unsupported');
});

// ─── Sharing one attempt, and asking again when it matters ────────────────────
// Two components used to mount and open a watch each, racing a single permission
// prompt. On iOS a request that loses that race — or one fired while the app is still
// launching — can be refused by the platform with no prompt shown, and WebKit then
// latches the denial for the lifetime of the document. Fewer requests, asked at the
// right moment, is the whole defence.

test('two components mounting at once share one attempt rather than racing two watches', async () => {
  const geo = installGeolocation();
  const banner = requestDeviceLocation({ timeoutMs: 5_000 });
  const card   = requestDeviceLocation({ timeoutMs: 5_000 });
  assert.equal(geo.watching, 1, 'a second watch would race the first against one permission prompt');
  geo.emit(25);
  const [a, b] = [await banner, await card];
  assert.equal(a.ok, true);
  assert.deepEqual(a, b, 'both callers get the same answer');
});

test('a re-check after the app returns asks again instead of inheriting the frozen attempt', async () => {
  const geo = installGeolocation();
  // iOS freezes JS on background, so THIS request is still pending when the user comes
  // back from Settings. Handing its stale answer to the return probe is what made the
  // trip to Settings look like it had been ignored.
  const frozen = requestDeviceLocation({ timeoutMs: 5_000 });
  const onReturn = requestDeviceLocation({ timeoutMs: 5_000, fresh: true });
  assert.equal(geo.watching, 2, 'the return probe must open its own watch');
  geo.emit(30);
  assert.equal((await onReturn).ok, true);
  await frozen;
});

// ─── The denial self-heal budget ──────────────────────────────────────────────
// Only a new document clears WebKit's latch, so a distrusted denial is worth one
// reload. "One" is the load-bearing word: a second would be a reload loop on a phone
// whose owner really did say no.

function installBrowserGlobals({ permission }: { permission?: string } = {}) {
  const store = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  g.window = {};
  g.sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  };
  g.navigator = {
    userAgent: 'test',
    permissions: permission ? { query: async () => ({ state: permission }) } : undefined,
  };
}

test('a denial the browser cannot vouch for buys exactly one reload per app launch', async () => {
  installBrowserGlobals(); // iOS: no geolocation Permissions API at all
  assert.equal(await claimDenialReload(), true,  'the first such denial is worth a fresh document');
  assert.equal(await claimDenialReload(), false, 'a second would be a reload loop');
});

test('a denial the browser confirms the user chose is believed, not reloaded away', async () => {
  installBrowserGlobals({ permission: 'denied' });
  // Spending the reload here would only hide the settings guidance behind a page flash.
  assert.equal(await claimDenialReload(), false);
});

test('a denial while the site permission still reads granted is certainly the latch', async () => {
  installBrowserGlobals({ permission: 'granted' });
  assert.equal(await claimDenialReload(), true);
});

test('with no sessionStorage to count in, the reload is never risked', async () => {
  const g = globalThis as Record<string, unknown>;
  g.window = {};
  g.navigator = { userAgent: 'test' };
  delete g.sessionStorage; // private mode / storage blocked — an uncountable budget
  assert.equal(await claimDenialReload(), false);
});
