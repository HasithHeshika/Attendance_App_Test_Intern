import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_SOURCES, SECRET_COLLECTIONS, REDACTED, SNAPSHOT_VERSION,
  isSecretCollection, matchesDocPattern, shouldBackupDoc, redactDocument,
  buildSettingsSnapshot, snapshotId, describeSnapshot,
  stripRedacted, planRestore, newestSnapshotId, canDeleteSnapshot,
} from '../settingsBackup';

const source = (collection: string) => SETTINGS_SOURCES.find(s => s.collection === collection)!;

test('the secret-holding collection is never a source and never backed up', () => {
  assert.equal(SETTINGS_SOURCES.some(s => s.collection === 'app_config'), false);
  assert.equal(isSecretCollection('app_config'), true);
  assert.equal(isSecretCollection('roles'), false);
  assert.equal(SECRET_COLLECTIONS.has('app_config'), true);
});

test('running counters are left out — restoring one would re-issue live numbers', () => {
  for (const c of ['suspense_bill_counters', 'suspense_voucher_counters', 'attendances', 'leaves', 'payroll_results']) {
    assert.equal(SETTINGS_SOURCES.some(s => s.collection === c), false, c);
  }
});

test('approval PINs are skipped by prefix; everything else in that collection is kept', () => {
  const s = source('suspense_settings');
  assert.equal(matchesDocPattern('approval_pin_EMPAV-00001', s.skipDocs), true);
  assert.equal(matchesDocPattern('voucher_mode', s.skipDocs), false);
  assert.equal(shouldBackupDoc(s, 'approval_pin_EMPAV-00001'), false);
  assert.equal(shouldBackupDoc(s, 'voucher_mode'), true);
  assert.equal(shouldBackupDoc(s, 'limits'), true);
});

test('onlyDocs, when set, is the whole allow-list', () => {
  const s = { collection: 'x', label: 'x', onlyDocs: ['a', 'b'] };
  assert.equal(shouldBackupDoc(s, 'a'), true);
  assert.equal(shouldBackupDoc(s, 'c'), false);
});

test('secrets are stripped at any depth, and tagged Firestore values are left alone', () => {
  const out = redactDocument({
    name: 'OneDrive',
    onedrive: { tenant_id: 't', client_secret: 'shh', nested: [{ password: 'p', keep: 1 }] },
    when: { __fs__: 'timestamp', seconds: 5, nanoseconds: 0 },
    fcm_token: 'abc',
  }) as any;
  assert.equal(out.name, 'OneDrive');
  assert.equal(out.onedrive.tenant_id, 't');
  assert.equal(out.onedrive.client_secret, REDACTED);
  assert.equal(out.onedrive.nested[0].password, REDACTED);
  assert.equal(out.onedrive.nested[0].keep, 1);
  assert.equal(out.fcm_token, REDACTED);
  assert.deepEqual(out.when, { __fs__: 'timestamp', seconds: 5, nanoseconds: 0 });
});

test('a per-source extra field can be redacted too', () => {
  const out = redactDocument({ a: 1, note: 'x' }, ['note']) as any;
  assert.equal(out.a, 1);
  assert.equal(out.note, REDACTED);
});

test('the snapshot counts what it kept and what policy skipped, and ignores unknown collections', () => {
  const snap = buildSettingsSnapshot({
    tenant: { id: 'altavision', label: 'Alta Vision', dbId: '' },
    takenAt: '2026-09-05T10:20:30.000Z',
    actor: { epf: 'E1', name: 'Admin' },
    read: [
      { collection: 'roles', docs: [{ id: 'r1', data: { name: 'Executive' } }, { id: 'r2', data: { name: 'Technician' } }] },
      { collection: 'suspense_settings', docs: [
        { id: 'voucher_mode', data: { mode: 'per_user' } },
        { id: 'approval_pin_E1', data: { pin_hash: 'deadbeef', pin_salt: 'aa' } },
      ] },
      { collection: 'app_config', docs: [{ id: 'cloud_storage', data: { client_secret: 'shh' } }] },
      { collection: 'attendances', docs: [{ id: 'a1', data: {} }] },
    ],
  });

  assert.equal(snap.version, SNAPSHOT_VERSION);
  assert.equal(snap.tenant_id, 'altavision');
  assert.equal(snap.db_id, '');
  assert.deepEqual(Object.keys(snap.collections).sort(), ['roles', 'suspense_settings']);
  assert.deepEqual(Object.keys(snap.collections.roles.docs), ['r1', 'r2']);
  assert.deepEqual(Object.keys(snap.collections.suspense_settings.docs), ['voucher_mode']);
  assert.equal(snap.collections.suspense_settings.skipped, 1);
  assert.deepEqual(snap.totals, { collections: 2, documents: 3, skipped: 1 });
  assert.equal(JSON.stringify(snap).includes('deadbeef'), false);
  assert.equal(JSON.stringify(snap).includes('shh'), false);
});

test('snapshot ids sort chronologically and carry no characters a path rejects', () => {
  const a = snapshotId('2026-09-05T10:20:30.000Z');
  const b = snapshotId('2026-09-05T10:20:31.000Z');
  assert.ok(a < b);
  assert.equal(/[:.]/.test(a), false);
  assert.equal(a.includes('/'), false);
});

test('the summary line reads plainly', () => {
  assert.equal(describeSnapshot({ totals: { collections: 3, documents: 1, skipped: 0 } }), '1 document across 3 collections');
  assert.equal(describeSnapshot({ totals: { collections: 1, documents: 9, skipped: 2 } }), '9 documents across 1 collection · 2 skipped by policy');
});

// ── Restore and delete ───────────────────────────────────────────────────────

test('stripRedacted drops redacted fields at any depth and reports their paths', () => {
  const { value, dropped } = stripRedacted({
    name: 'Solar',
    api_key: REDACTED,
    nested: { secret: REDACTED, keep: 1 },
    list: [{ password: REDACTED, ok: true }],
  });
  assert.deepEqual(value, { name: 'Solar', nested: { keep: 1 }, list: [{ ok: true }] });
  assert.deepEqual(dropped.sort(), ['api_key', 'list[0].password', 'nested.secret']);
});

test('stripRedacted leaves a tagged Firestore value alone — it is a leaf, not a map', () => {
  const ts = { __fs__: 'timestamp', seconds: 1, nanoseconds: 0 };
  const { value, dropped } = stripRedacted({ created_at: ts, secret: REDACTED });
  assert.deepEqual(value, { created_at: ts });
  assert.deepEqual(dropped, ['secret']);
});

test('planRestore writes every snapshot document, counts what it refused to put back', () => {
  const plan = planRestore({
    collections: {
      roles: { label: 'Roles', skipped: 0, docs: { ceo: { name: 'CEO' }, coo: { name: 'COO' } } },
      suspense_settings: { label: 'Suspense', skipped: 3, docs: { voucher_mode: { mode: 'overall', secret: REDACTED } } },
      departments: { label: 'Departments', skipped: 0, docs: {} },
    },
  });
  assert.equal(plan.collections, 2, 'an empty collection is not counted');
  assert.equal(plan.writes.length, 3);
  assert.equal(plan.redactedFields, 1);
  const vm = plan.writes.find(w => w.docId === 'voucher_mode')!;
  assert.deepEqual(vm.data, { mode: 'overall' }, 'the redacted field is absent, not blanked');
  assert.equal(vm.collection, 'suspense_settings');
});

test('planRestore never plans a deletion — extra live documents are left for a human', () => {
  const plan = planRestore({ collections: { roles: { label: 'Roles', skipped: 0, docs: { ceo: {} } } } });
  // The only thing a plan can express is a write; there is no delete channel by design.
  assert.deepEqual(Object.keys(plan.writes[0]).sort(), ['collection', 'data', 'docId']);
  assert.equal(plan.writes.length, 1);
});

test('the newest snapshot cannot be deleted, and a lone snapshot cannot either', () => {
  const ids = ['2026-09-05T10-00-00-000Z', '2026-09-04T10-00-00-000Z', '2026-09-03T10-00-00-000Z'];
  assert.equal(newestSnapshotId(ids), '2026-09-05T10-00-00-000Z');
  assert.equal(newestSnapshotId([]), null);
  assert.equal(canDeleteSnapshot('2026-09-05T10-00-00-000Z', ids), false, 'newest is protected');
  assert.equal(canDeleteSnapshot('2026-09-04T10-00-00-000Z', ids), true);
  assert.equal(canDeleteSnapshot('2026-09-03T10-00-00-000Z', ids), true);
  assert.equal(canDeleteSnapshot('nope', ids), false, 'an unknown id is not deletable');
  assert.equal(canDeleteSnapshot('only', ['only']), false, 'the only snapshot is protected');
});
