#!/usr/bin/env node
// Bumps the app version (X.Y.Z) and prepends a "What's New" changelog entry.
//
//   node scripts/bump-version.mjs patch "<change line>"   ← auto, one per merged PR (Z+1)
//   node scripts/bump-version.mjs minor "<note>"          ← user bumps Y, resets Z
//   node scripts/bump-version.mjs major "<note>"          ← user bumps X, resets Y and Z
//
// Rules:
//   X (major) — changes only via `major`.
//   Y (minor) — changes via `minor` (or `major`, which resets it to 0).
//   Z (patch) — auto-increments on every merged PR; resets to 1 right after a
//               minor/major bump (the first PR on a new line is X.Y.1).
//
// Writes src/data/version.json, src/data/whats-new.json AND package.json's "version".
//
// package.json is kept in lockstep deliberately. It used to sit at a hand-written 0.1.0
// while the app shipped 1.9.x, so `npm run dev` announced a version that had not been true
// for nine minor releases, and anything reading npm_package_version got a fiction. It is a
// mirror, never a source: src/data/version.json is still the only place the number is
// decided.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILE   = join(ROOT, 'src/data/version.json');
const CHANGELOG_FILE = join(ROOT, 'src/data/whats-new.json');
const PACKAGE_FILE   = join(ROOT, 'package.json');
const MAX_ENTRIES = 50;

const mode  = (process.argv[2] || 'patch').toLowerCase();
const note  = (process.argv[3] || '').trim();

const readJSON  = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJSON = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

const version   = readJSON(VERSION_FILE, { major: 1, minor: 0, patch: 0 });
const changelog = readJSON(CHANGELOG_FILE, []);

let { major, minor, patch } = version;

if (mode === 'major') {
  major += 1; minor = 0; patch = 0;        // user-only; next PR makes it .1
} else if (mode === 'minor') {
  minor += 1; patch = 0;                   // resets Z; next PR makes it .1
} else if (mode === 'patch') {
  // Detect a hand-edited X/Y since the last published entry → reset Z to 1.
  const [lastMajor, lastMinor] = (changelog[0]?.version ?? '').split('.').map(Number);
  patch = (lastMajor === major && lastMinor === minor) ? patch + 1 : 1;
} else {
  console.error(`Unknown mode "${mode}" (use: patch | minor | major)`);
  process.exit(1);
}

const versionStr = `${major}.${minor}.${patch}`;

// Build the change lines for this entry (supports multi-line PR bodies).
const defaultNote = mode === 'patch' ? 'Improvements & fixes' : `Version ${versionStr}`;
const changes = (note || defaultNote).split('\n').map((s) => s.trim()).filter(Boolean);

const entry = { version: versionStr, date: new Date().toISOString(), changes };

// If the top entry is already this exact version (e.g. re-run), merge into it.
const next = changelog[0]?.version === versionStr
  ? [{ ...changelog[0], date: entry.date, changes: [...new Set([...changes, ...changelog[0].changes])] }, ...changelog.slice(1)]
  : [entry, ...changelog];

writeJSON(VERSION_FILE, { major, minor, patch });
writeJSON(CHANGELOG_FILE, next.slice(0, MAX_ENTRIES));

// Mirror onto package.json. Rewritten via a targeted replace rather than a JSON round-trip
// so the file keeps its existing formatting and key order — a reformatted package.json in
// every release commit would bury the one line that actually changed.
try {
  const pkgRaw = readFileSync(PACKAGE_FILE, 'utf8');
  const bumped = pkgRaw.replace(/^(\s*"version"\s*:\s*")[^"]*(",)/m, `$1${versionStr}$2`);
  if (bumped !== pkgRaw) writeFileSync(PACKAGE_FILE, bumped);
} catch (e) {
  // Never fail the release for the mirror — the authoritative files are already written.
  console.warn('[bump-version] could not update package.json:', e.message);
}

console.log(versionStr);
