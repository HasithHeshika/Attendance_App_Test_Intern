'use client';
import { useEffect, useState } from 'react';
import { useT, useAppStore } from '@/store/appStore';
import { dominantHslFromImage, hashHsl, hslCss, cssColorToHsl, textToneForHsl, type Hsl } from '@/lib/brandColor';
import { brandName } from '@/lib/brand';

export interface CardUser {
  name?: string;
  email?: string;
  role?: string;
  designation?: string;
  epf_number?: string;
  company?: string;
  avatar?: string;
  employee_type?: string;
  department?: string;
  companyLogo?: string | null;
  accentColor?: string | null;
}

const CARD_W = 640;
const CARD_H = 900;
// Supersample factor: every canvas is rendered at SS× its logical size so the content stays
// crisp when the card is magnified on screen. Drawing code keeps using the logical CARD_W/CARD_H
// coordinates — ctx.scale(SS, SS) maps them onto the larger backing store.
const SS = 2;

// ── helpers ───────────────────────────────────────────────────────────────────
// Route remote images through the same-origin proxy so they're canvas-safe
// (cross-origin logos without CORS headers would otherwise taint toDataURL).
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

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = proxify(url);
  });
}

function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }

function initials(name?: string): string {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('') || '?';
}

function detectProvider(avatar?: string): 'google' | 'microsoft' | null {
  if (!avatar) return null;
  try {
    const host = new URL(avatar).host.toLowerCase();
    if (host.includes('googleusercontent') || host.includes('google')) return 'google';
    if (host.includes('microsoft') || host.includes('msft') || host.includes('graph')) return 'microsoft';
  } catch { /* relative/base64 */ }
  return null;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function decorativeMatrix(seed: string, n = 13): boolean[][] {
  let state = hashStr(seed || 'PEARLCLUSTER') || 1;
  const rand = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return ((state >>> 0) % 1000) / 1000; };
  const m: boolean[][] = [];
  for (let r = 0; r < n; r++) { const row: boolean[] = []; for (let c = 0; c < n; c++) row.push(rand() > 0.5); m.push(row); }
  return m;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawContain(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const s = Math.min(w / img.width, h / img.height);
  const dw = img.width * s, dh = img.height * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s, dh = img.height * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

// ── theme + brand palette ─────────────────────────────────────────────────────
interface Palette {
  headerTop: string; headerBottom: string; accent: string;
  cardBg: string; text: string; sub: string; faint: string; divider: string;
  chipBg: string; chipText: string; ring: string; footChipBg: string; footChipText: string;
  strapTop: string; strapBottom: string;
  onHeader: string; onHeaderSoft: string; onAccent: string;
}

function palette(hsl: Hsl, dark: boolean): Palette {
  const S = clamp(hsl.s, 45, 82);
  const h = hsl.h;
  const headerDarkText = textToneForHsl(hsl, 38) === 'dark'; // header gradient avg ~38% L
  const accentDarkText = textToneForHsl(hsl, 52) === 'dark';
  return {
    onHeader: headerDarkText ? '#0f172a' : '#ffffff',
    onHeaderSoft: headerDarkText ? 'rgba(15,23,42,0.72)' : 'rgba(255,255,255,0.80)',
    onAccent: accentDarkText ? '#0f172a' : '#ffffff',
    headerTop: hslCss(h, S, 47),
    headerBottom: hslCss(h, S, 29),
    accent: hslCss(h, S, 52),
    cardBg: dark ? '#0b1220' : '#ffffff',
    text: dark ? '#f1f5f9' : '#0f172a',
    sub: dark ? '#9aa7bd' : '#64748b',
    faint: dark ? '#64748b' : '#94a3b8',
    divider: dark ? 'rgba(255,255,255,0.10)' : '#e8edf3',
    chipBg: dark ? hslCss(h, clamp(S, 28, 55), 22) : hslCss(h, clamp(S, 22, 48), 93),
    chipText: dark ? hslCss(h, clamp(S, 45, 75), 82) : hslCss(h, S, 32),
    ring: dark ? '#0b1220' : '#ffffff',
    footChipBg: dark ? 'rgba(255,255,255,0.07)' : '#f1f5f9',
    footChipText: dark ? '#cbd5e1' : '#334155',
    // Strap uses the company's brand/accent colour (so each company sets a colour
    // that contrasts with its logo). Darker shade in dark mode, brighter in light.
    strapTop: dark ? hslCss(h, S, 28) : hslCss(h, S, 46),
    strapBottom: dark ? hslCss(h, S, 16) : hslCss(h, S, 30),
  };
}

interface BackLabels { employeeId: string; returnTo: string; property: string; validThru: string; validYear: string }

// ── front face ────────────────────────────────────────────────────────────────
function drawFrontFace(
  ctx: CanvasRenderingContext2D, W: number, H: number, user: CardUser,
  avatarImg: HTMLImageElement | null, logoImg: HTMLImageElement | null,
  pal: Palette, employeeIdLabel: string,
) {
  // Body background
  ctx.fillStyle = pal.cardBg;
  ctx.fillRect(0, 0, W, H);

  // ── Curved brand header ── a gradient panel whose bottom edge sweeps down to a
  // low point at centre; the employee photo straddles that curve (reference style).
  const hBase = Math.round(H * 0.30);            // straight header height at the edges
  const dip   = Math.round(H * 0.12);            // extra depth at the centre
  const hMid  = hBase + dip;                     // lowest point of the curve (centre)
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(W, 0);
  ctx.lineTo(W, hBase);
  ctx.quadraticCurveTo(W / 2, hMid + dip * 0.6, 0, hBase);
  ctx.closePath();
  ctx.clip();
  const grad = ctx.createLinearGradient(0, 0, W, hMid);
  grad.addColorStop(0, pal.headerTop);
  grad.addColorStop(1, pal.headerBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, hMid + dip);
  // Soft diagonal light streaks (the reference's faint rays).
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 5; i++) {
    ctx.save();
    ctx.translate(W * (0.18 + i * 0.17), -60);
    ctx.rotate(0.42);
    ctx.fillRect(0, 0, 30, hMid + 260);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  const sheen = ctx.createRadialGradient(W * 0.82, -30, 10, W * 0.82, -30, 380);
  sheen.addColorStop(0, 'rgba(255,255,255,0.16)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, W, hMid + dip);
  ctx.restore();

  // ── Company wordmark (logo + name), right-aligned in the header (clears the centre clip) ──
  {
    const cy = Math.round(H * 0.13);
    const rightX = W - 40;
    const nm = user.company || brandName();
    ctx.fillStyle = pal.onHeader;
    ctx.font = '700 32px Outfit, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(nm).width;
    if (logoImg) {
      const lh = 46, lw = Math.min((logoImg.width / logoImg.height) * lh, 140);
      const gap = 14, startX = rightX - (lw + gap + tw);
      drawContain(ctx, logoImg, startX, cy - lh / 2, lw, lh);
      ctx.textAlign = 'left';
      ctx.fillText(nm, startX + lw + gap, cy + 1);
    } else {
      ctx.textAlign = 'right';
      ctx.fillText(nm, rightX, cy + 1);
    }
  }

  // ── Employee photo, on the curve ──
  const aR = 88, aCx = W / 2, aCy = hMid;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.30)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  ctx.beginPath();
  ctx.arc(aCx, aCy, aR + 9, 0, Math.PI * 2);
  ctx.fillStyle = pal.cardBg;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(aCx, aCy, aR + 9, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  ctx.strokeStyle = pal.accent;
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.arc(aCx, aCy, aR, 0, Math.PI * 2);
  ctx.clip();
  if (avatarImg) {
    drawCover(ctx, avatarImg, aCx - aR, aCy - aR, aR * 2, aR * 2);
  } else {
    ctx.fillStyle = pal.accent;
    ctx.fillRect(aCx - aR, aCy - aR, aR * 2, aR * 2);
    ctx.fillStyle = pal.onAccent;
    ctx.font = '700 76px Outfit, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials(user.name), aCx, aCy + 4);
  }
  ctx.restore();

  // ── Name (primary), shrunk to fit the card width ──
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = pal.text;
  let nameSize = 46;
  const maxNameW = W - 96;
  ctx.font = `700 ${nameSize}px Outfit, system-ui, sans-serif`;
  while (ctx.measureText(user.name || '—').width > maxNameW && nameSize > 26) {
    nameSize -= 2; ctx.font = `700 ${nameSize}px Outfit, system-ui, sans-serif`;
  }
  let y = aCy + aR + 64;
  ctx.fillText(user.name || '—', W / 2, y);

  // Trainee / intern badge under the name (only those two types).
  const et = (user.employee_type || '').toLowerCase();
  if (et === 'trainee' || et === 'intern') {
    const label = et === 'intern' ? 'Intern' : 'Trainee';
    y += 30;
    ctx.font = '600 20px Outfit, system-ui, sans-serif';
    const lw2 = ctx.measureText(label).width, cw = lw2 + 44, ch = 38, cx = (W - cw) / 2;
    roundRect(ctx, cx, y - ch + 6, cw, ch, ch / 2);
    ctx.fillStyle = pal.chipBg;
    ctx.fill();
    ctx.fillStyle = pal.chipText;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, W / 2, y - ch / 2 + 7);
    ctx.textBaseline = 'alphabetic';
  }

  // ── Field rows: bold label + value, evenly distributed, hairline rules between ──
  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: (employeeIdLabel || 'Employee ID'), value: user.epf_number || '—', mono: true },
    { label: 'Designation', value: user.designation || user.role || '—' },
  ];
  const footTop = H - 58 - 30;                    // top of the footer bar
  const fieldsTop = y + 30;
  const rowH = (footTop - 18 - fieldsTop) / rows.length;
  rows.forEach((r, i) => {
    const cy = fieldsTop + rowH * i + rowH * 0.42;
    ctx.textAlign = 'center';
    ctx.fillStyle = pal.sub;
    ctx.font = '700 21px Outfit, system-ui, sans-serif';
    ctx.fillText(r.label, W / 2, cy);
    ctx.fillStyle = pal.text;
    ctx.font = r.mono
      ? '600 26px "JetBrains Mono", ui-monospace, monospace'
      : '500 26px Outfit, system-ui, sans-serif';
    ctx.fillText(r.value, W / 2, cy + 32);
    if (i < rows.length - 1) {
      ctx.strokeStyle = pal.divider;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(W * 0.22, fieldsTop + rowH * (i + 1));
      ctx.lineTo(W * 0.78, fieldsTop + rowH * (i + 1));
      ctx.stroke();
    }
  });

  // ── Footer bar (brand) with the contact line ──
  const fh = 58, fy = H - fh - 30, fx = 40, fw = W - 80;
  roundRect(ctx, fx, fy, fw, fh, fh / 2);
  ctx.fillStyle = pal.headerBottom;
  ctx.fill();
  ctx.fillStyle = pal.onHeader;
  ctx.font = '600 22px Outfit, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const foot = user.email || user.company || `Secured by ${brandName()}`;
  ctx.fillText(foot, W / 2, fy + fh / 2 + 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// ── back face ─────────────────────────────────────────────────────────────────
function drawBackFace(
  ctx: CanvasRenderingContext2D, W: number, H: number, user: CardUser,
  logoImg: HTMLImageElement | null, pal: Palette, labels: BackLabels,
) {
  ctx.fillStyle = pal.cardBg;
  ctx.fillRect(0, 0, W, H);

  // Curved brand header (matches the front, shorter).
  const hBase = Math.round(H * 0.16);
  const dip   = Math.round(H * 0.08);
  const hMid  = hBase + dip;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(W, 0);
  ctx.lineTo(W, hBase);
  ctx.quadraticCurveTo(W / 2, hMid + dip * 0.6, 0, hBase);
  ctx.closePath();
  ctx.clip();
  const grad = ctx.createLinearGradient(0, 0, W, hMid);
  grad.addColorStop(0, pal.headerTop);
  grad.addColorStop(1, pal.headerBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, hMid + dip);
  ctx.restore();

  // Company wordmark (logo + name), right-aligned in the header.
  {
    const cy = Math.round(H * 0.075);
    const rightX = W - 40;
    const nm = user.company || brandName();
    ctx.fillStyle = pal.onHeader;
    ctx.font = '700 30px Outfit, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(nm).width;
    if (logoImg) {
      const lh = 44, lw = Math.min((logoImg.width / logoImg.height) * lh, 130);
      const gap = 14, startX = rightX - (lw + gap + tw);
      drawContain(ctx, logoImg, startX, cy - lh / 2, lw, lh);
      ctx.textAlign = 'left';
      ctx.fillText(nm, startX + lw + gap, cy + 1);
    } else {
      ctx.textAlign = 'right';
      ctx.fillText(nm, rightX, cy + 1);
    }
  }

  // Eyebrow under the header.
  ctx.fillStyle = pal.sub;
  ctx.font = '600 18px Outfit, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(labels.employeeId.toUpperCase(), W / 2, hMid + 56);

  // Decorative QR (scan placeholder) on a rounded white tile.
  const m = decorativeMatrix(user.epf_number || user.email || 'PEARLCLUSTER');
  const qrSize = 236, cell = qrSize / m.length;
  const qrX = (W - qrSize) / 2, qrY = hMid + 84;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, qrX - 16, qrY - 16, qrSize + 32, qrSize + 32, 18);
  ctx.fill();
  ctx.fillStyle = '#0f172a';
  for (let r = 0; r < m.length; r++) for (let c = 0; c < m[r].length; c++) if (m[r][c]) ctx.fillRect(qrX + c * cell, qrY + r * cell, cell + 0.5, cell + 0.5);
  const finder = (fx: number, fy: number) => {
    ctx.fillStyle = '#0f172a'; ctx.fillRect(fx, fy, cell * 3, cell * 3);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(fx + cell * 0.6, fy + cell * 0.6, cell * 1.8, cell * 1.8);
    ctx.fillStyle = '#0f172a'; ctx.fillRect(fx + cell, fy + cell, cell, cell);
  };
  finder(qrX, qrY); finder(qrX + qrSize - cell * 3, qrY); finder(qrX, qrY + qrSize - cell * 3);

  // Return-to block.
  let ty = qrY + qrSize + 66;
  ctx.textAlign = 'center';
  ctx.fillStyle = pal.sub;
  ctx.font = '600 21px Outfit, system-ui, sans-serif';
  ctx.fillText(labels.returnTo, W / 2, ty);
  ty += 42;
  ctx.fillStyle = pal.text;
  ctx.font = '700 27px Outfit, system-ui, sans-serif';
  ctx.fillText(user.company || brandName(), W / 2, ty);
  if (user.email) {
    ty += 38;
    ctx.fillStyle = pal.sub;
    ctx.font = '500 21px Outfit, system-ui, sans-serif';
    ctx.fillText(user.email, W / 2, ty);
  }
  ty += 32;
  ctx.fillStyle = pal.faint;
  ctx.font = '500 18px Outfit, system-ui, sans-serif';
  ctx.fillText(labels.property, W / 2, ty);

  // Footer bar (brand): valid-thru + EPF.
  const fh = 58, fy = H - fh - 30, fx = 40, fw = W - 80;
  roundRect(ctx, fx, fy, fw, fh, fh / 2);
  ctx.fillStyle = pal.headerBottom;
  ctx.fill();
  ctx.fillStyle = pal.onHeader;
  ctx.textBaseline = 'middle';
  const validLine = `${labels.validThru} ${labels.validYear}`;
  if (user.epf_number) {
    ctx.textAlign = 'left';
    ctx.font = '600 19px Outfit, system-ui, sans-serif';
    ctx.fillText(validLine, fx + 26, fy + fh / 2 + 1);
    ctx.textAlign = 'right';
    ctx.font = '700 20px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillText(user.epf_number, fx + fw - 26, fy + fh / 2 + 1);
  } else {
    ctx.textAlign = 'center';
    ctx.font = '600 19px Outfit, system-ui, sans-serif';
    ctx.fillText(validLine, W / 2, fy + fh / 2 + 1);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// ── lanyard band texture ──────────────────────────────────────────────────────
// Renders the repeating strap texture (1025×250) over a brand gradient.
// • Primary: the company NAME as bold text running vertically down the strap
//   (top→bottom), repeated — a printed-lanyard look, no logo image.
// • Fallback (no company name): the logo image, drawn at its true proportions.
function drawBandTexture(
  logoImg: HTMLImageElement | null,
  companyName: string | undefined,
  dark: boolean,
): string {
  // MUST match the default lanyard.png aspect (1025×250). Rendered at SS× for a crisp strap.
  const W = 1025, H = 250;
  const c = document.createElement('canvas');
  c.width = W * SS; c.height = H * SS;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.scale(SS, SS);
  ctx.imageSmoothingQuality = 'high';

  // Theme-inverted strap: light mode → BLACK strap; dark mode → WHITE strap. (The name's text
  // colour below inverts to match for contrast.) A faint vertical gradient keeps a little depth.
  const g = ctx.createLinearGradient(0, 0, 0, H);
  if (dark) { g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#e9e9ec'); }
  else      { g.addColorStop(0, '#1b1b1f'); g.addColorStop(1, '#000000'); }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const name = (companyName ?? '').trim();
  if (name) {
    // Company NAME as text — no logo. The strap maps the texture's X axis ALONG its length,
    // so text drawn left→right here runs DOWN the strap (top→bottom), reading lengthwise like
    // a printed lanyard band. The name is repeated COUNT times so the brand recurs along the
    // whole strap, and each copy is shrunk to fit its slot so the name is never stretched.
    const text = name.toUpperCase();
    const COUNT = 3;                                   // name repeated down the strap
    const cell = W / COUNT;                            // texture length per copy
    const setFont = (s: number) => { ctx.font = `800 ${s}px Outfit, system-ui, sans-serif`; };
    let fontSize = Math.round(H * 0.30);   // smaller, restrained brand text
    setFont(fontSize);
    try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${Math.round(fontSize * 0.06)}px`; }
    catch { /* letterSpacing unsupported on some engines — harmless */ }
    // Shrink to keep each copy fully inside its slot along the strap length (no stretching).
    const maxLen = cell * 0.9;
    const measured = ctx.measureText(text).width;
    if (measured > maxLen) { fontSize = Math.max(14, Math.floor(fontSize * (maxLen / measured))); setFont(fontSize); }
    ctx.fillStyle = dark ? '#0a0a0a' : '#ffffff';   // dark strap (light mode) → white text; white strap → black text
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < COUNT; i++) {
      ctx.fillText(text, cell * (i + 0.5), H / 2);
    }

  } else if (logoImg) {
    // Fallback (no company name): draw the logo at its TRUE proportions — never stretched.
    // Width and height scale together; the only transform is the strap-geometry compensation.
    // The strap maps texture-X along its length, so each logo is rotated -90° to read upright,
    // and the band (≈4:1) maps onto a ≈3.2:1 ribbon — STRAP_COMP = strapAspect/texAspect, so
    // pre-stretching the length by 1/STRAP_COMP un-squashes it back to its real proportions.
    const STRAP_COMP = 0.8;
    const COUNT = 4;                                    // logos repeated down the strap
    const aspect = logoImg.width / logoImg.height;     // natural w/h — never altered
    const cell = W / COUNT;                             // texture length per logo
    let across = H * 0.62;                              // logo width across the strap width
    let along  = (across / aspect) / STRAP_COMP;        // real height, length-compensated
    const alongMax = cell * 0.86;                       // keep each copy inside its slot
    if (along > alongMax) { const s = alongMax / along; along = alongMax; across *= s; }
    for (let i = 0; i < COUNT; i++) {
      ctx.save();
      ctx.translate(cell * (i + 0.5), H / 2);
      ctx.rotate(-Math.PI / 2);                         // counter the strap's 90° mapping
      ctx.drawImage(logoImg, -across / 2, -along / 2, across, along);
      ctx.restore();
    }
  }

  try { return c.toDataURL('image/png'); } catch { return ''; }
}

function renderFace(draw: (ctx: CanvasRenderingContext2D, W: number, H: number) => void): string {
  const c = document.createElement('canvas');
  c.width = CARD_W * SS; c.height = CARD_H * SS;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.scale(SS, SS);
  ctx.imageSmoothingQuality = 'high';
  draw(ctx, CARD_W, CARD_H);
  try { return c.toDataURL('image/png'); } catch { return ''; }
}

// ── theme hook ────────────────────────────────────────────────────────────────
function useIsDark(): boolean {
  const [dark, setDark] = useState<boolean>(() => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const compute = () => setDark(document.documentElement.classList.contains('dark'));
    compute();
    const mo = new MutationObserver(compute);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

// ── hook ──────────────────────────────────────────────────────────────────────
export function useIdCardTextures(user: CardUser | null): {
  frontUrl: string | null; backUrl: string | null; bandUrl: string | null; ready: boolean;
} {
  const t = useT();
  const lang = useAppStore(s => s.lang);
  const dark = useIsDark();
  const [state, setState] = useState<{ front: string | null; back: string | null; band: string | null; ready: boolean }>({
    front: null, back: null, band: null, ready: false,
  });

  const labels: BackLabels = {
    employeeId: t.lanyardEmployeeId,
    returnTo: t.lanyardReturnTo,
    property: t.lanyardProperty,
    validThru: t.lanyardValidThru,
    validYear: String(new Date().getFullYear() + 1),
  };

  const key = user
    ? [user.epf_number, user.name, user.role, user.designation, user.company, user.email, user.avatar, user.employee_type, user.companyLogo, user.accentColor, dark, lang].join('|')
    : '';

  useEffect(() => {
    if (!user) { setState({ front: null, back: null, band: null, ready: false }); return; }
    let cancelled = false;
    (async () => {
      const [avatarImg, companyLogoImg] = await Promise.all([
        user.avatar ? loadImage(user.avatar) : Promise.resolve(null),
        user.companyLogo ? loadImage(user.companyLogo) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      const hsl: Hsl =
        (user.accentColor ? cssColorToHsl(user.accentColor) : null) ||
        (companyLogoImg && dominantHslFromImage(companyLogoImg)) ||
        hashHsl(user.company || user.epf_number || 'company');
      const pal = palette(hsl, dark);
      // Only use the real company logo — never fall back to /icon.png (which can
      // be a user avatar and would show up in the wrong place).
      const headerLogo = companyLogoImg ?? null;
      const front = renderFace((ctx, W, H) => drawFrontFace(ctx, W, H, user, avatarImg, headerLogo, pal, labels.employeeId));
      const back = renderFace((ctx, W, H) => drawBackFace(ctx, W, H, user, headerLogo, pal, labels));
      const band = drawBandTexture(headerLogo, user.company, dark);
      if (!cancelled) setState({ front, back, band, ready: true });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { frontUrl: state.front, backUrl: state.back, bandUrl: state.band, ready: state.ready };
}
