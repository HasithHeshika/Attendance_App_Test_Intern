import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jpgName } from '../imageResize';

// jpgName rewrites the extension of an upload path after the image has been re-encoded to
// JPEG. Only the pure path logic is exercised here — resizeImage itself needs a canvas.
// The stakes: a bill filed as ".png" while holding JPEG bytes, or — worse — a company folder
// name mangled because a dot in it was mistaken for a file extension.

test('replaces a plain file extension', () => {
  assert.equal(jpgName('bill.png'), 'bill.jpg');
  assert.equal(jpgName('bill.heic'), 'bill.jpg');
  assert.equal(jpgName('bill.jpg'), 'bill.jpg');
});

test('is case-insensitive about what it replaces', () => {
  assert.equal(jpgName('BILL.PNG'), 'BILL.jpg');
});

test('rewrites only the last segment of a bill path', () => {
  assert.equal(
    jpgName('AltaVision/2026/09/abc123-C_A_Hettiarachchi-EMPAV_00060.png'),
    'AltaVision/2026/09/abc123-C_A_Hettiarachchi-EMPAV_00060.jpg',
  );
});

test('appends when the filename has no extension', () => {
  assert.equal(jpgName('bill'), 'bill.jpg');
  assert.equal(jpgName('AltaVision/2026/09/abc123-Name-EPF'), 'AltaVision/2026/09/abc123-Name-EPF.jpg');
});

// A dot in a COMPANY name is not a file extension. Getting this wrong would file the bill
// under a truncated folder — invisible until someone went looking for it in OneDrive.
test('a dot in a folder name is not treated as an extension', () => {
  assert.equal(jpgName('Alta Vision Ltd./2026/09/bill'), 'Alta Vision Ltd./2026/09/bill.jpg');
  assert.equal(jpgName('Alta Vision Ltd./2026/09/bill.png'), 'Alta Vision Ltd./2026/09/bill.jpg');
});

test('keeps a dotted filename stem intact', () => {
  assert.equal(jpgName('scan.2026.09.05.png'), 'scan.2026.09.05.jpg');
});
