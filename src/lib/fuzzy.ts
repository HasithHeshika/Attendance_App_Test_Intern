// Lightweight fuzzy matching for combobox / search filters (working-place pickers,
// supervisor search, …). Ranks candidates so search tolerates word-order changes,
// dropped/extra letters and small typos — not just literal substrings.
//
// `fuzzyScore(query, text)` returns a number: higher = better match, 0 = no match
// (filter it out). Callers score each option's searchable text, drop zeros, then sort
// by score descending (use a stable sort so equal scores keep the caller's incoming
// order — e.g. nearest-first for GPS-sorted places).

// Bounded Levenshtein edit distance. Returns the true distance when it is ≤ `max`,
// otherwise any value > max (it bails out early once every cell in a row exceeds the
// budget), which keeps typo matching cheap over large option lists.
function boundedLevenshtein(a: string, b: string, max: number): number {
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  let prev = new Array<number>(bl + 1);
  let curr = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;      // whole row over budget → give up early
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[bl];
}

// Do the characters of `q` appear in order within `t` (a subsequence)? Rewards
// contiguous runs so "clmbo" scores against "colombo" but tighter matches rank higher.
// Returns 0 when any character can't be placed in order.
function subsequenceScore(q: string, t: string): number {
  let ti = 0, score = 0, run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    let found = -1;
    for (let j = ti; j < t.length; j++) { if (t[j] === c) { found = j; break; } }
    if (found === -1) return 0;
    run = found === ti ? run + 1 : 1;      // consecutive to the previous match?
    score += run;
    ti = found + 1;
  }
  return score;
}

/**
 * Score how well `rawQuery` matches `rawText`. Tiers (best → worst), so a literal
 * substring always outranks a reordered-token match, which outranks a subsequence,
 * which outranks a small typo:
 *   1. substring of the whole query   (prefix / whole-string boosted)
 *   2. every whitespace token present, any order
 *   3. subsequence (dropped / extra letters)
 *   4. small edit distance to a single word (transposition / substitution typos)
 * Returns 0 when nothing matches.
 */
export function fuzzyScore(rawQuery: string, rawText: string): number {
  const q = rawQuery.trim().toLowerCase();
  const t = rawText.toLowerCase();
  if (!q) return 1;

  // 1) Substring of the whole query — strongest signal.
  const idx = t.indexOf(q);
  if (idx !== -1) {
    let score = 4000 - Math.min(idx, 500);   // earlier position ranks higher
    if (idx === 0) score += 1000;            // prefix match
    if (t === q) score += 2000;              // exact whole-text match
    return score;
  }

  // 2) All whitespace tokens present, order-independent ("office colombo" → "Colombo Office").
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every(tok => t.includes(tok))) {
    return 3000 - Math.min(tokens.reduce((s, tok) => s + t.indexOf(tok), 0), 500);
  }

  // 3) Subsequence over space-stripped text ("clmbo" → "colombo", "kandy off" → "Kandy Office").
  const sub = subsequenceScore(q.replace(/\s+/g, ''), t.replace(/\s+/g, ''));
  if (sub > 0) return 1000 + sub;

  // 4) Small typo against any single word (transpositions, substitutions).
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  const budget = q.length <= 4 ? 1 : 2;
  let best = budget + 1;
  for (const w of words) {
    const d = boundedLevenshtein(q, w, budget);
    if (d < best) best = d;
    if (best === 0) break;
  }
  if (best <= budget) return 500 - best * 100;

  return 0;
}
