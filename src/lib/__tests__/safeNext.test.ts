import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNext } from '../safeNext';

test('an ordinary relative path passes through unchanged', () => {
  assert.equal(safeNext('/tasks'), '/tasks');
  assert.equal(safeNext('/leaves?month=2026-09#row-9'), '/leaves?month=2026-09#row-9');
  // A bare slash is a legitimate destination, not an absolute-looking form.
  assert.equal(safeNext('/'), '/');
});

test('a protocol-relative URL is refused', () => {
  // The whole reason this helper exists: it looks like a path and is not.
  assert.equal(safeNext('//evil.example'), '/');
  assert.equal(safeNext('//evil.example/tasks'), '/');
});

test('a leading backslash is refused, because browsers normalise it to a second slash', () => {
  // The rejection both private copies were missing. '/\evil.example' passes a '//' check and
  // then becomes protocol-relative in the browser.
  assert.equal(safeNext('/\\evil.example'), '/');
  assert.equal(safeNext('/\\/evil.example'), '/');
});

test('anything absolute is refused', () => {
  assert.equal(safeNext('https://evil.example'), '/');
  assert.equal(safeNext('http://evil.example'), '/');
  assert.equal(safeNext('javascript:alert(1)'), '/');
  assert.equal(safeNext('evil.example'), '/');
});

test('a non-string is refused, including the missing case', () => {
  assert.equal(safeNext(undefined), '/');
  assert.equal(safeNext(null), '/');
  assert.equal(safeNext(''), '/');
  assert.equal(safeNext(42), '/');
  assert.equal(safeNext(['/tasks']), '/');
});

test('the caller supplies the fallback, and a refusal uses it', () => {
  // The receiver signs somebody in before redirecting, so its fallback is the dashboard.
  assert.equal(safeNext('//evil.example', '/dashboard'), '/dashboard');
  assert.equal(safeNext('/\\evil.example', '/dashboard'), '/dashboard');
  assert.equal(safeNext(null, '/dashboard'), '/dashboard');
  assert.equal(safeNext('/tasks', '/dashboard'), '/tasks');
});
