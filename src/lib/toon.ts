// ─── TOON (Token-Oriented Object Notation) encoder ──────────────────────────────
// A compact, indentation-based serialization of structured data that uses far fewer
// tokens than JSON for uniform record sets. Use this ONLY at the LLM/API boundary —
// e.g. encode attendance/task rows right before sending them to Claude to cut input
// tokens/cost. NEVER store TOON in Firestore: the DB must keep structured fields so
// queries and indexes keep working.
//
// Supported (the high-value DB cases):
//   • objects            → `key: value`, nested objects indented
//   • primitive arrays   → `key[N]: a,b,c`
//   • uniform flat-object arrays → tabular `key[N]{f1,f2}:` + comma rows
//   • mixed/complex arrays → list form (`-` items, recursively encoded)

export type ToonValue =
  | string | number | boolean | null
  | ToonValue[]
  | { [k: string]: ToonValue };

const RESERVED = /^(true|false|null)$/i;
const NUMERIC  = /^-?\d+(?:\.\d+)?$/;
const SPECIAL  = /[",:[\]{}\n]/;

const PAD = (n: number) => '  '.repeat(n);
const isScalar = (v: ToonValue): v is string | number | boolean | null =>
  v === null || typeof v !== 'object';
const isObj = (v: ToonValue): v is { [k: string]: ToonValue } =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function quoteString(s: string): string {
  const needs = s === '' || /^\s|\s$/.test(s) || SPECIAL.test(s) || RESERVED.test(s) || NUMERIC.test(s);
  return needs
    ? '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
    : s;
}

function fmtScalar(v: string | number | boolean | null): string {
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return quoteString(v);
}

function fmtKey(k: string): string {
  return /^[A-Za-z0-9_]+$/.test(k) ? k : quoteString(k);
}

// Returns the shared key order if `arr` is a non-empty array of flat objects that all
// share the same keys with scalar values (→ encodable as a table), else null.
function tableKeys(arr: ToonValue[]): string[] | null {
  if (!arr.length || !arr.every(isObj)) return null;
  const keys = Object.keys(arr[0] as object);
  if (!keys.length) return null;
  for (const o of arr as Record<string, ToonValue>[]) {
    const k = Object.keys(o);
    if (k.length !== keys.length) return null;
    for (const key of keys) if (!(key in o) || !isScalar(o[key])) return null;
  }
  return keys;
}

function writeObject(obj: Record<string, ToonValue>, indent: number, out: string[]): void {
  for (const [k, v] of Object.entries(obj)) writeKeyed(k, v, indent, out);
}

function writeKeyed(key: string, v: ToonValue, indent: number, out: string[]): void {
  if (isScalar(v)) { out.push(`${PAD(indent)}${fmtKey(key)}: ${fmtScalar(v)}`); return; }
  if (Array.isArray(v)) { writeArray(key, v, indent, out); return; }
  out.push(`${PAD(indent)}${fmtKey(key)}:`);
  writeObject(v, indent + 1, out);
}

function writeArray(key: string | null, arr: ToonValue[], indent: number, out: string[]): void {
  const head = key === null ? '' : fmtKey(key);
  if (!arr.length) { out.push(`${PAD(indent)}${head}[0]:`); return; }

  if (arr.every(isScalar)) {
    out.push(`${PAD(indent)}${head}[${arr.length}]: ${arr.map(v => fmtScalar(v as string | number | boolean | null)).join(',')}`);
    return;
  }

  const keys = tableKeys(arr);
  if (keys) {
    out.push(`${PAD(indent)}${head}[${arr.length}]{${keys.map(fmtKey).join(',')}}:`);
    for (const o of arr as Record<string, ToonValue>[]) {
      out.push(`${PAD(indent + 1)}${keys.map(k => fmtScalar(o[k] as string | number | boolean | null)).join(',')}`);
    }
    return;
  }

  out.push(`${PAD(indent)}${head}[${arr.length}]:`);
  for (const item of arr) {
    if (isScalar(item)) out.push(`${PAD(indent + 1)}- ${fmtScalar(item)}`);
    else if (Array.isArray(item)) writeArray(null, item, indent + 1, out);
    else { out.push(`${PAD(indent + 1)}-`); writeObject(item, indent + 2, out); }
  }
}

/** Encode any JSON-serializable value as TOON. */
export function encodeToon(value: ToonValue): string {
  if (isScalar(value)) return fmtScalar(value);
  const out: string[] = [];
  if (Array.isArray(value)) writeArray(null, value, 0, out);
  else writeObject(value, 0, out);
  return out.join('\n');
}

/**
 * Convenience for the common case: encode an array of flat records as a TOON table
 * under a named key, ready to drop into an LLM prompt. Example output:
 *   tasks[2]{date,status,hours}:
 *     2026-06-22,Completed,4
 *     2026-06-22,On Progress,0.5
 */
export function toonTable(key: string, rows: Array<Record<string, ToonValue>>): string {
  return encodeToon({ [key]: rows });
}
