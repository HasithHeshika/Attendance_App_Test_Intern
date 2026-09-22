// Working-place name matching across sources. A place picked from the Solar app's site
// list is recorded as "<name> (#<site-no>)" while the admin working_places doc stores the
// bare name — so any comparison between a session's recorded place and the admin list
// (shift tags, approval routing, dedup) must go through these helpers, never exact equality.

// Bare display name: drop a trailing "(#site-no)" suffix (Solar site format).
export const stripSiteNo = (v: unknown): string =>
  String(v ?? '').replace(/\s*\(#.*?\)\s*$/, '').trim();

// Canonical key for matching: bare name, case-insensitive.
export const canonPlaceName = (v: unknown): string => stripSiteNo(v).toLowerCase();
