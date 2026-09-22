import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FEATURES,
  FEATURE_KEYS,
  MODULE_ROUTES,
  hasFeatures,
  isPathEnabled,
  moduleForPath,
  normalizeDbId,
  normalizeFeatures,
  normalizeTenant,
  primaryDomain,
  splitBrandName,
  tenantByDbId,
  tenantByHost,
  tenantById,
  tenantForDbId,
  type Tenant,
  type TenantFeatures,
} from '../tenants';

// Fixtures, not the real registry: tenants live in Firestore now, so these functions are pure
// over a list somebody hands them. Building the list here keeps the suite hermetic and lets a
// case say exactly what it is testing.
function tenant(over: Partial<Tenant> & { id: string }): Tenant {
  return {
    label: over.id,
    domains: [],
    dbId: '',
    appName: over.id,
    themeColor: '#000000',
    brandDir: null,
    features: { ...DEFAULT_FEATURES },
    status: 'active',
    ...over,
  };
}

const alpha = tenant({
  id: 'alpha',
  domains: ['alpha.example', 'attendance.alpha.example'],
  dbId: '',
  features: { ...DEFAULT_FEATURES, suspense: true, payroll: false, tasks: true, schedule: false },
});
const beta = tenant({
  id: 'beta',
  domains: ['beta.example'],
  dbId: 'betadb',
  features: { ...DEFAULT_FEATURES, payroll: true, suspense: false, tasks: false, schedule: true },
});
const LIST = [alpha, beta];

// ─── Host resolution ──────────────────────────────────────────────────────────

test('tenantByHost: exact domain, and any subdomain of it', () => {
  assert.equal(tenantByHost('alpha.example', LIST)?.id, 'alpha');
  assert.equal(tenantByHost('www.alpha.example', LIST)?.id, 'alpha');
  assert.equal(tenantByHost('attendance.alpha.example', LIST)?.id, 'alpha');
  assert.equal(tenantByHost('beta.example', LIST)?.id, 'beta');
});

test('tenantByHost: tolerates the shapes a Host header actually arrives in', () => {
  assert.equal(tenantByHost('ALPHA.example', LIST)?.id, 'alpha');
  assert.equal(tenantByHost('alpha.example:3000', LIST)?.id, 'alpha');
  assert.equal(tenantByHost('alpha.example.', LIST)?.id, 'alpha');   // trailing dot, FQDN form
  assert.equal(tenantByHost('  alpha.example  ', LIST)?.id, 'alpha');
});

test('tenantByHost: an unknown or empty host resolves to nothing, never to a guess', () => {
  assert.equal(tenantByHost('unknown.example', LIST), undefined);
  assert.equal(tenantByHost('', LIST), undefined);
  assert.equal(tenantByHost(null, LIST), undefined);
  // Not a subdomain — "notalpha.example" merely ENDS WITH the same letters.
  assert.equal(tenantByHost('notalpha.example', LIST), undefined);
});

test('tenantByHost: a disabled tenant stops serving its own domains', () => {
  const off = [{ ...alpha, status: 'disabled' as const }, beta];
  assert.equal(tenantByHost('alpha.example', off), undefined);
  assert.equal(tenantByHost('beta.example', off)?.id, 'beta');
});

test('tenantById / tenantByDbId find the right record', () => {
  assert.equal(tenantById('beta', LIST)?.id, 'beta');
  assert.equal(tenantById('BETA', LIST)?.id, 'beta');
  assert.equal(tenantById('nope', LIST), undefined);
  assert.equal(tenantById('', LIST), undefined);
  assert.equal(tenantByDbId('betadb', LIST)?.id, 'beta');
  assert.equal(tenantByDbId('', LIST)?.id, 'alpha');       // '' IS the default database
});

test('tenantForDbId: an unknown id gets its OWN database, never production', () => {
  // The bug this prevents: resolving FIRESTORE_DB_ID=scratch to the first registered tenant
  // would point local dev at the (default) production database.
  const t = tenantForDbId('scratch', LIST);
  assert.equal(t.dbId, 'scratch');
  assert.equal(t.id, 'scratch');
  assert.notEqual(t.dbId, alpha.dbId);
});

test('tenantForDbId: "(default)" and "default" mean the default database', () => {
  assert.equal(normalizeDbId('(default)'), '');
  assert.equal(normalizeDbId('DEFAULT'), '');
  assert.equal(normalizeDbId(' betadb '), 'betadb');
  assert.equal(tenantForDbId('(default)', LIST).id, 'alpha');
});

test('tenantForDbId: with no registered tenants at all it still returns something usable', () => {
  const t = tenantForDbId('betadb', []);
  assert.equal(t.dbId, 'betadb');
  assert.equal(typeof t.appName, 'string');
  assert.deepEqual(t.features, DEFAULT_FEATURES);
});

// ─── Documents from Firestore ─────────────────────────────────────────────────

test('normalizeFeatures: a sparse map is filled from DEFAULT_FEATURES', () => {
  const f = normalizeFeatures({ payroll: true });
  assert.equal(f.payroll, true);
  assert.equal(f.suspense, DEFAULT_FEATURES.suspense);
  assert.deepEqual(Object.keys(f).sort(), [...FEATURE_KEYS].sort());
});

test('normalizeFeatures: non-boolean junk falls back rather than being coerced', () => {
  // "false" the STRING is truthy; coercing it would silently enable a module.
  const f = normalizeFeatures({ payroll: 'false', suspense: 1, tasks: null });
  assert.equal(f.payroll, DEFAULT_FEATURES.payroll);
  assert.equal(f.suspense, DEFAULT_FEATURES.suspense);
  assert.equal(f.tasks, DEFAULT_FEATURES.tasks);
});

test('normalizeFeatures: missing or malformed input still yields a complete set', () => {
  for (const input of [undefined, null, 'nonsense', 42, []]) {
    const f = normalizeFeatures(input);
    assert.equal(Object.keys(f).length, FEATURE_KEYS.length);
  }
});

test('normalizeTenant: a well-formed document round-trips', () => {
  const t = normalizeTenant('gamma', {
    label: 'Gamma Ltd', domains: ['Gamma.Example', ' g2.example '],
    dbId: 'gammadb', appName: 'GammaApp', themeColor: '#123456',
    brandDir: 'gamma', status: 'active', features: { payroll: true },
  });
  assert.equal(t.id, 'gamma');
  assert.equal(t.label, 'Gamma Ltd');
  assert.deepEqual(t.domains, ['gamma.example', 'g2.example']);  // lowercased and trimmed
  assert.equal(t.dbId, 'gammadb');
  assert.equal(t.brandDir, 'gamma');
  assert.equal(t.features.payroll, true);
});

test('normalizeTenant: a malformed document degrades instead of throwing', () => {
  // This data is edited through a UI and read on every domain's request path. One bad
  // document must not take rendering down.
  const t = normalizeTenant('broken', {
    domains: ['ok.example', 42, '', null], brandDir: '   ', themeColor: '', features: 'nope',
  });
  assert.deepEqual(t.domains, ['ok.example']);
  assert.equal(t.brandDir, null);          // whitespace is not a folder name
  assert.equal(t.label, 'broken');          // falls back to the id
  assert.ok(t.themeColor.startsWith('#'));
  assert.deepEqual(t.features, DEFAULT_FEATURES);
});

test('normalizeTenant: status is a closed set — anything unrecognised is active', () => {
  assert.equal(normalizeTenant('x', { status: 'disabled' }).status, 'disabled');
  assert.equal(normalizeTenant('x', { status: 'paused' }).status, 'active');
  assert.equal(normalizeTenant('x', {}).status, 'active');
});

// ─── Module routing ───────────────────────────────────────────────────────────

test('MODULE_ROUTES lists each route once, and only known flags', () => {
  const paths = MODULE_ROUTES.map(m => m.path);
  assert.equal(new Set(paths).size, paths.length);
  for (const m of MODULE_ROUTES) {
    for (const f of m.needs) {
      assert.ok(FEATURE_KEYS.includes(f), `${m.path} needs unknown flag ${f}`);
    }
  }
});

test('moduleForPath owns the route and everything beneath it', () => {
  assert.equal(moduleForPath('/users')?.path, '/users');
  assert.equal(moduleForPath('/users/bulk-add')?.path, '/users');
  assert.equal(moduleForPath('/payroll-employees/bulk-add')?.path, '/payroll-employees');
});

test('moduleForPath never matches across a name boundary', () => {
  // /attendance-view is its own module, NOT part of /attendance — a naive startsWith would
  // hide it whenever the personal attendance page was off.
  assert.equal(moduleForPath('/attendance-view')?.path, '/attendance-view');
  assert.equal(moduleForPath('/my-schedule')?.path, '/my-schedule');
  assert.equal(moduleForPath('/schedule')?.path, '/schedule');
});

test('an unlisted path is always allowed', () => {
  const noneOn = tenant({
    id: 'dark',
    features: Object.fromEntries(FEATURE_KEYS.map(k => [k, false])) as unknown as TenantFeatures,
  });
  assert.equal(moduleForPath('/login'), undefined);
  assert.ok(isPathEnabled(noneOn, '/login'));
  assert.ok(isPathEnabled(noneOn, '/platform'));
  assert.ok(isPathEnabled(noneOn, '/outstation'));   // merged away → redirects to /working-places
  assert.ok(isPathEnabled(noneOn, '/my-team'));      // merged away → redirects to /approvals
});

test('a page inside a subsystem needs BOTH its own flag and the umbrella', () => {
  const allOn = tenant({
    id: 'full',
    features: Object.fromEntries(FEATURE_KEYS.map(k => [k, true])) as unknown as TenantFeatures,
  });

  const noPayroll = { ...allOn, features: { ...allOn.features, payroll: false } };
  assert.equal(isPathEnabled(noPayroll, '/payroll-loans'), false);

  const noLoans = { ...allOn, features: { ...allOn.features, payrollLoans: false } };
  assert.equal(isPathEnabled(noLoans, '/payroll-loans'), false);
  // …and dropping one payroll page leaves the rest of payroll standing — the whole point.
  assert.ok(isPathEnabled(noLoans, '/payroll-runs'));
  assert.ok(isPathEnabled(noLoans, '/payroll-settings'));

  const noSuspense = { ...allOn, features: { ...allOn.features, suspense: false } };
  assert.equal(isPathEnabled(noSuspense, '/chamary'), false);
  // /system-settings is NOT suspense-gated: it hosts the greetings and access categories too,
  // and each category on the page gates itself. Only its own flag closes the route.
  assert.ok(isPathEnabled(noSuspense, '/system-settings'));
  const noSystemSettings = { ...allOn, features: { ...allOn.features, systemSettings: false } };
  assert.equal(isPathEnabled(noSystemSettings, '/system-settings'), false);
});

test('hasFeatures demands every flag, not just one', () => {
  assert.ok(hasFeatures(beta, ['payroll']));
  assert.equal(hasFeatures(beta, ['payroll', 'suspense']), false);
  assert.ok(hasFeatures(beta, []), 'no requirements means nothing to fail');
});

test('the fixture split behaves the way a real two-tenant deployment does', () => {
  assert.ok(isPathEnabled(alpha, '/suspense'));
  assert.ok(isPathEnabled(alpha, '/tasks'));
  assert.equal(isPathEnabled(alpha, '/payroll-runs'), false);
  assert.equal(isPathEnabled(alpha, '/schedule'), false);

  assert.ok(isPathEnabled(beta, '/payroll-runs'));
  assert.ok(isPathEnabled(beta, '/schedule'));
  assert.equal(isPathEnabled(beta, '/suspense'), false);
  assert.equal(isPathEnabled(beta, '/tasks'), false);
});

// ─── Presentation helpers ─────────────────────────────────────────────────────

test('primaryDomain prefers the first domain, then degrades sensibly', () => {
  assert.equal(primaryDomain(alpha), 'alpha.example');
  assert.equal(primaryDomain(tenant({ id: 'x', dbId: 'xdb' })), 'xdb');
  assert.equal(primaryDomain(tenant({ id: 'x' })), 'x');
});

test('splitBrandName splits on the camelCase seam or the last space', () => {
  assert.deepEqual(splitBrandName('PearlCluster'), ['Pearl', 'Cluster']);
  assert.deepEqual(splitBrandName('CareCode'), ['Care', 'Code']);
  assert.deepEqual(splitBrandName('Southern Lanka'), ['Southern ', 'Lanka']);
  assert.deepEqual(splitBrandName('acme'), ['acme', '']);
});
