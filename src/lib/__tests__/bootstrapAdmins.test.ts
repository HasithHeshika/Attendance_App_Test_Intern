import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  BOOTSTRAP_ADMIN_EMAILS,
  PLATFORM_BOOTSTRAP_EMAILS,
  bootstrapAdminEpf,
  isBootstrapAdminEmail,
  isPlatformBootstrapEmail,
} from '../bootstrapAdmins';

const DEVOPS = 'devopsaltavision@gmail.com';
const SYSADMIN = 'sysadminaltavision@gmail.com';

test('both break-glass accounts are admitted, on both authorities', () => {
  for (const email of [DEVOPS, SYSADMIN]) {
    assert.equal(isBootstrapAdminEmail(email), true, `${email} break-glass`);
    assert.equal(isPlatformBootstrapEmail(email), true, `${email} platform`);
  }
});

test('nobody else is admitted', () => {
  for (const email of [
    'someone@example.com',
    // A lookalike on another domain must not inherit the grant.
    'devopsaltavision@gmail.com.attacker.test',
    'sysadminaltavision@googlemail.com',
    '',
    null,
    undefined,
  ]) {
    assert.equal(isBootstrapAdminEmail(email), false, `${String(email)} break-glass`);
    assert.equal(isPlatformBootstrapEmail(email), false, `${String(email)} platform`);
  }
});

test('case and surrounding whitespace do not change the answer', () => {
  assert.equal(isBootstrapAdminEmail('  SysAdminAltaVision@Gmail.COM '), true);
  assert.equal(isPlatformBootstrapEmail('  DevOpsAltaVision@Gmail.COM '), true);
});

test('the lists are stored normalised, so membership tests can be exact', () => {
  for (const email of [...BOOTSTRAP_ADMIN_EMAILS, ...PLATFORM_BOOTSTRAP_EMAILS]) {
    assert.equal(email, email.trim().toLowerCase(), email);
  }
});

test('each break-glass account gets its own EPF, and the first keeps SYSADMIN', () => {
  // The existing production doc is keyed 'SYSADMIN'. Renumbering the first entry would
  // strand it and mint a duplicate.
  assert.equal(bootstrapAdminEpf(DEVOPS), 'SYSADMIN');
  assert.equal(bootstrapAdminEpf(SYSADMIN), 'SYSADMIN_02');
});

test('EPFs are unique — a shared doc id would let one account overwrite the other', () => {
  const epfs = BOOTSTRAP_ADMIN_EMAILS.map(bootstrapAdminEpf);
  assert.equal(new Set(epfs).size, epfs.length);
  assert.equal(epfs.includes(null), false);
});

test('bootstrapAdminEpf is case-insensitive and refuses everyone else', () => {
  assert.equal(bootstrapAdminEpf(' SYSADMINALTAVISION@GMAIL.COM '), 'SYSADMIN_02');
  assert.equal(bootstrapAdminEpf('someone@example.com'), null);
  assert.equal(bootstrapAdminEpf(null), null);
});
