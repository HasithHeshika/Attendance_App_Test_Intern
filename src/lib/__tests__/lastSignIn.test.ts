import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableMethod, maskEmail, maskIdentifier, shouldCollapsePasswordForm, type LastSignIn,
} from '../lastSignIn';

// Only the pure half is covered here — read/remember/forget touch localStorage and need a
// browser. What matters most is that the mask cannot leak, and that a remembered method which
// is no longer available never reaches the screen as a dead button.

test('maskEmail keeps the first and last character of the local part and the whole domain', () => {
  assert.equal(maskEmail('someone@example.com'), 's•••••e@example.com');
});

test('maskEmail hides the length of the local part', () => {
  // These two have very different local-part lengths and must be indistinguishable in that
  // respect — a variable-length dot run would announce it.
  const short = maskEmail('abcd@example.com');
  const long = maskEmail('abcdefghijklmnop@example.com');
  const dotsOf = (s: string) => s.slice(1, s.indexOf('@') - 1);
  assert.equal(dotsOf(short), dotsOf(long));
});

test('maskEmail shows only the first character when the local part is short', () => {
  // 'ab' -> 'a•••••b' would be the entire address in clear, which is not a mask.
  assert.equal(maskEmail('ab@x.io'), 'a•••••@x.io');
  assert.equal(maskEmail('abc@x.io'), 'a•••••@x.io');
});

test('maskEmail returns empty string for anything that is not an address', () => {
  assert.equal(maskEmail(''), '');
  assert.equal(maskEmail(null), '');
  assert.equal(maskEmail(undefined), '');
  assert.equal(maskEmail('no-at-sign'), '');
  assert.equal(maskEmail('@leading.com'), '');   // nothing before the @
  assert.equal(maskEmail('trailing@'), '');      // nothing after it
});

test('maskIdentifier masks an employee number by its tail, not its head', () => {
  // carecode.org staff sign in with an employee number. A company-wide prefix like "EMP-"
  // identifies nobody, so the recognisable part is the end.
  assert.equal(maskIdentifier('EMP-00123'), '•••••23');
});

test('maskIdentifier falls back to email masking when it sees an address', () => {
  assert.equal(maskIdentifier('someone@example.com'), maskEmail('someone@example.com'));
});

test('maskIdentifier never renders empty for a non-email identifier', () => {
  // The bug this exists to prevent: maskEmail returns '' for an employee number, which would
  // blank the account card on the one tenant where password is the only way in.
  assert.notEqual(maskIdentifier('EMP-00123'), '');
  assert.notEqual(maskIdentifier('12'), '');
  assert.equal(maskIdentifier(''), '');
  assert.equal(maskIdentifier(null), '');
});

test('shouldCollapsePasswordForm never hides the form when password is the only way in', () => {
  // availableMethod() has already dropped anything unavailable, so a null or 'password'
  // primary means the form IS the screen.
  assert.equal(shouldCollapsePasswordForm(null), false);
  assert.equal(shouldCollapsePasswordForm('password'), false);
});

test('shouldCollapsePasswordForm collapses only behind a genuinely different method', () => {
  assert.equal(shouldCollapsePasswordForm('passkey'), true);
  assert.equal(shouldCollapsePasswordForm('google'), true);
  assert.equal(shouldCollapsePasswordForm('microsoft'), true);
});

const last = (method: LastSignIn['method']): LastSignIn => ({ method, email: 'someone@example.com' });
const ALL_ON = { passkeyOffered: true, oauthOffered: true };

test('availableMethod passes a method through when it is still offered', () => {
  assert.equal(availableMethod(last('passkey'), ALL_ON), 'passkey');
  assert.equal(availableMethod(last('google'), ALL_ON), 'google');
  assert.equal(availableMethod(last('password'), ALL_ON), 'password');
});

test('availableMethod drops a passkey the browser or tenant can no longer do', () => {
  // Leading with a control that opens a prompt nothing can answer is worse than leading with
  // nothing — the screen falls back to its default order instead.
  assert.equal(availableMethod(last('passkey'), { passkeyOffered: false, oauthOffered: true }), null);
});

test('availableMethod drops OAuth where the tenant has it hidden', () => {
  const noOauth = { passkeyOffered: true, oauthOffered: false };
  assert.equal(availableMethod(last('google'), noOauth), null);
  assert.equal(availableMethod(last('microsoft'), noOauth), null);
});

test('availableMethod always allows password, which no tenant can turn off', () => {
  assert.equal(
    availableMethod(last('password'), { passkeyOffered: false, oauthOffered: false }),
    'password',
  );
});

test('availableMethod returns null when nothing is remembered', () => {
  assert.equal(availableMethod(null, ALL_ON), null);
});
