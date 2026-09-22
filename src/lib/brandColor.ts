// Derives a per-company brand colour. Prefers the dominant colour of the company
// logo (so branding matches the real brand); falls back to a deterministic hue
// from a seed (company id/name) when there's no logo or the image can't be
// sampled (cross-origin taint). Lightness/saturation are normalised so white
// text/overlays stay legible regardless of the source colour.

export interface Hsl { h: number; s: number; l: number }

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Route remote images through the same-origin proxy so getImageData() is canvas-safe.
function proxify(url: string): string {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url;
  if (typeof location === 'undefined') return url;
  try {
    const u = new URL(url, location.origin);
    if (u.origin === location.origin) return url;
    return `/api/img?url=${encodeURIComponent(url)}`;
  } catch {
    return url;
  }
}

export function loadImageCors(url: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = proxify(url);
  });
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s: s * 100, l: l * 100 };
}

// Sample a downscaled copy of the logo and average the "brand" pixels
// (skipping transparent, near-white and near-black background/outline pixels).
export function dominantHslFromImage(img: HTMLImageElement): Hsl | null {
  const size = 28;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch {
    return null; // cross-origin taint
  }
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 200) continue;
    const R = data[i], G = data[i + 1], B = data[i + 2];
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    if (max > 238 && min > 238) continue;       // near-white
    if (max < 22) continue;                      // near-black
    if (max - min < 14 && max > 150) continue;   // light grey
    r += R; g += G; b += B; n++;
  }
  if (n < 6) return null;
  return rgbToHsl(r / n, g / n, b / n);
}

export function hashHsl(seed: string): Hsl {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return { h: (h >>> 0) % 360, s: 62, l: 48 };
}

// Parse any CSS colour string (hex, rgb(), named) via a 1×1 canvas → HSL.
export function cssColorToHsl(css: string): Hsl | null {
  if (!css) return null;
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#000';
  ctx.fillStyle = css;            // invalid input leaves it '#000'
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return rgbToHsl(d[0], d[1], d[2]);
}

// Normalised hsl() string (comma form for broad canvas support).
export function hslCss(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function relLuminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// Whether to put 'light' (white) or 'dark' (near-black) text on a surface painted
// with this brand colour at the given lightness. Tuned so saturated colours keep
// white text and only genuinely light colours (yellow/pastel) flip to dark.
export function textToneForHsl(hsl: Hsl, lightness = 52): 'light' | 'dark' {
  const S = clamp(hsl.s, 45, 78);
  return relLuminance(hslToRgb(hsl.h, S, lightness)) > 0.42 ? 'dark' : 'light';
}

// Cover gradient + the text tone that stays readable on it, computed from one
// brand-colour resolution (accent → logo → seed).
export async function brandCoverForCompany(opts: {
  logoUrl?: string | null;
  seed?: string | null;
  accentColor?: string | null;
}): Promise<{ gradient: string; tone: 'light' | 'dark' }> {
  const hsl = await brandHslForCompany(opts);
  return { gradient: gradientFromHsl(hsl), tone: textToneForHsl(hsl) };
}

// Two-stop gradient with normalised S/L so it reads as a crafted brand surface
// and keeps enough contrast for white overlays.
export function gradientFromHsl({ h, s }: Hsl): string {
  const S = clamp(s, 45, 78);
  return `linear-gradient(135deg, ${hslCss(h, S, 52)}, ${hslCss(h, clamp(S - 6, 40, 72), 32)})`;
}

// Resolve the brand HSL for a company (logo dominant colour, else seeded hash).
export async function brandHslForCompany(opts: {
  logoUrl?: string | null;
  seed?: string | null;
  logoImg?: HTMLImageElement | null;
  accentColor?: string | null;
}): Promise<Hsl> {
  // Explicit accent colour (set in the companies admin) always wins.
  if (opts.accentColor) {
    const hsl = cssColorToHsl(opts.accentColor);
    if (hsl) return hsl;
  }
  let hsl: Hsl | null = null;
  const img = opts.logoImg ?? (opts.logoUrl ? await loadImageCors(opts.logoUrl) : null);
  if (img) hsl = dominantHslFromImage(img);
  return hsl ?? hashHsl(opts.seed || 'company');
}

export async function brandGradientForCompany(opts: {
  logoUrl?: string | null;
  seed?: string | null;
  accentColor?: string | null;
}): Promise<string> {
  return gradientFromHsl(await brandHslForCompany(opts));
}

// Synchronous gradient for lists/tiles: explicit accent colour, else seeded hash.
export function gradientFromColorOrSeed(accentColor: string | null | undefined, seed: string): string {
  const hsl = (accentColor ? cssColorToHsl(accentColor) : null) ?? hashHsl(seed);
  return gradientFromHsl(hsl);
}
