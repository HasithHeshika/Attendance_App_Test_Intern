// App version (X.Y.Z) + changelog, both data-driven and auto-updated.
//
//   X (major) — bumped by the user only:        `npm run version:major`
//   Y (minor) — bumped by the user:             `npm run version:minor`  (resets Z)
//   Z (patch) — auto, one per merged GitHub PR:  see .github/workflows/version-bump.yml
//
// `version.json` is the single source of truth; the GitHub Action edits it (and the
// changelog) on every PR merge, so a fresh deploy always shows the current version.
import versionData from '@/data/version.json';
import changelog   from '@/data/whats-new.json';

export const VERSION = versionData as { major: number; minor: number; patch: number };

/** e.g. "1.5.0" */
export const APP_VERSION = `${VERSION.major}.${VERSION.minor}.${VERSION.patch}`;

export interface ChangelogEntry {
  version: string;   // "1.5.0"
  date:    string;   // ISO 8601 (with offset)
  changes: string[]; // human-readable change lines (PR titles / commit subjects)
}

// Newest first.
export const CHANGELOG = changelog as ChangelogEntry[];

/** The last 5 versions, shown in the "What's New" dialog. */
export const LATEST_CHANGES = CHANGELOG.slice(0, 5);
