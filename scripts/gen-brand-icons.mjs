/**
 * Generate a tenant's full icon set from a single source image.
 *
 *   node scripts/gen-brand-icons.mjs southernlanka
 *
 * Source (first that exists) in public/brand/<tenant>/:
 *   source.png  — drop the real artwork here to replace the SVG rendition
 *   icon.svg
 *
 * Produces, in the same folder:
 *   favicon.ico            16+32+48, PNG-in-ICO (Vista+), what /favicon.ico rewrites to
 *   icon-192.png           /icon.png  — in-app logos, PWA icon
 *   icon-512.png           /app.png   — push notification icon/badge, PWA icon
 *   icon-maskable-512.png  Android adaptive icon (padded into the safe zone)
 *   apple-touch-icon.png   180, iOS home screen
 *
 * The maskable variant matters: Android crops icons to a circle/squircle, so the plain
 * icon's arms would be clipped at the tips. This one is padded to ~62% and sits on an
 * opaque background, which is what the maskable spec requires.
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const tenant = process.argv[2];
if (!tenant) {
  console.error('usage: node scripts/gen-brand-icons.mjs <tenant-brandDir>');
  process.exit(1);
}

const dir = path.join('public', 'brand', tenant);
if (!fs.existsSync(dir)) {
  console.error(`no such folder: ${dir}`);
  process.exit(1);
}

const srcPng = path.join(dir, 'source.png');
const srcSvg = path.join(dir, 'icon.svg');
const src = fs.existsSync(srcPng) ? srcPng : srcSvg;
if (!fs.existsSync(src)) {
  console.error(`no source: expected ${srcPng} or ${srcSvg}`);
  process.exit(1);
}
const input = fs.readFileSync(src);
const load = () => sharp(input, { density: 384 });

// Background for the maskable icon — read from manifest.json if present.
let maskableBg = '#F4F3FB';
const manifestPath = path.join(dir, 'manifest.json');
if (fs.existsSync(manifestPath)) {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (m.background_color) maskableBg = m.background_color;
  } catch { /* keep the default */ }
}

const png = (size) => load().resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png();

for (const [name, size] of Object.entries({
  'icon-512.png': 512,
  'icon-192.png': 192,
  'apple-touch-icon.png': 180,
})) {
  await png(size).toFile(path.join(dir, name));
  console.log('  ', name.padEnd(24), `${size}x${size}`);
}

// Maskable: content at 62% of the canvas, opaque background, so a circular crop keeps it whole.
const inner = Math.round(512 * 0.62);
const pad = Math.round((512 - inner) / 2);
await sharp({ create: { width: 512, height: 512, channels: 4, background: maskableBg } })
  .composite([{ input: await png(inner).toBuffer(), top: pad, left: pad }])
  .png()
  .toFile(path.join(dir, 'icon-maskable-512.png'));
console.log('  ', 'icon-maskable-512.png'.padEnd(24), '512x512 (padded, opaque)');

// favicon.ico — an ICO container wrapping PNG images (supported since Windows Vista and by
// every current browser). sharp cannot write .ico, so the container is assembled by hand.
const icoSizes = [16, 32, 48];
const images = [];
for (const s of icoSizes) images.push({ size: s, buf: await png(s).toBuffer() });

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);                 // reserved
header.writeUInt16LE(1, 2);                 // type 1 = icon
header.writeUInt16LE(images.length, 4);     // image count

const entries = [];
let offset = 6 + images.length * 16;
for (const { size, buf } of images) {
  const e = Buffer.alloc(16);
  e.writeUInt8(size === 256 ? 0 : size, 0); // width  (0 means 256)
  e.writeUInt8(size === 256 ? 0 : size, 1); // height
  e.writeUInt8(0, 2);                       // palette size
  e.writeUInt8(0, 3);                       // reserved
  e.writeUInt16LE(1, 4);                    // colour planes
  e.writeUInt16LE(32, 6);                   // bits per pixel
  e.writeUInt32LE(buf.length, 8);           // payload size
  e.writeUInt32LE(offset, 12);              // payload offset
  entries.push(e);
  offset += buf.length;
}

fs.writeFileSync(
  path.join(dir, 'favicon.ico'),
  Buffer.concat([header, ...entries, ...images.map(i => i.buf)]),
);
console.log('  ', 'favicon.ico'.padEnd(24), icoSizes.join('+'));
console.log(`\n${tenant}: icon set written from ${src}`);
