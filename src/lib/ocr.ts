'use client';
// Client-side OCR for printed bills, via tesseract.js. Dynamically imported so the (heavy)
// wasm/worker only loads when a printed bill is actually scanned — never on the main bundle.
import { resizeImage } from '@/lib/imageResize';
import { isPlausibleExtractedBillDate, readAmbiguousBillDate } from '@/lib/billDatePlausibility';

// Downscale + re-encode a bill photo before sending it off for reading (Gemini vision or
// tesseract.js) — phone cameras routinely produce 3000-4000px, multi-MB images, and neither
// reader needs that much resolution to read printed/handwritten receipt text; the extra pixels
// only cost upload time (to our server, then on to Gemini) and OCR processing time. This is
// the READING resize; the upload path runs its own, gentler one (2400px — see uploadCloudFile),
// because what gets filed as the actual bill should stay legible when zoomed into. Returns the
// original file untouched if it's already small enough, or if anything in the resize pipeline
// fails (reading a photo slower is fine; silently reading nothing because a resize hiccuped
// is not).
export async function resizeImageForOcr(file: File, maxDim = 1800, quality = 0.85): Promise<File> {
  return resizeImage(file, { maxDim, quality });
}

// Pull the most likely bill total out of raw OCR text. Heuristic: prefer a money-looking
// number on a line mentioning a total/amount keyword (or one carrying a currency prefix);
// otherwise the largest number seen. Long comma-less integer runs (invoice/phone/barcode
// IDs) are ignored unless they carry a currency prefix.
export function parseBillAmount(text: string): number | null {
  // Group 1 = optional currency prefix; group 2 = the number (comma-grouped OR plain).
  // The comma-grouped alternative REQUIRES a comma so it can't swallow the plain case
  // (which previously truncated "4500" → "450").
  const numRe = /(rs\.?|lkr|රු)?\s*((?:[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?)|(?:[0-9]+(?:\.[0-9]{1,2})?))/gi;
  const candidates: { value: number; weight: number }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const boost = /total|amount|grand|net\b|payable|balance\s*due/i.test(line) ? 1_000_000 : 0;
    let m: RegExpExecArray | null;
    numRe.lastIndex = 0;
    while ((m = numRe.exec(line)) !== null) {
      const hasCurrency = !!m[1];
      const raw = m[2];
      const hasDecimal = raw.includes('.');
      const digits = raw.replace(/[^0-9]/g, '').length;
      const v = parseFloat(raw.replace(/,/g, ''));
      if (isNaN(v) || v <= 0) continue;
      // Ignore long plain integers — serials, invoice/receipt numbers, phone numbers,
      // barcodes — which have NO currency prefix, NO decimal, and don't sit on a total/amount
      // line. A real bill amount almost always carries a currency prefix, a decimal, or a
      // total keyword, so this discards IDs without discarding genuine totals.
      if (!hasCurrency && !hasDecimal && boost === 0 && digits >= 5) continue;
      candidates.push({
        value: v,
        // Decimals and currency prefixes strongly signal a money value; the total keyword
        // strongest of all. Raw magnitude is only the final tie-breaker.
        weight: boost + (hasCurrency ? 500_000 : 0) + (hasDecimal ? 300_000 : 0) + v,
      });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.weight - a.weight);
  return Math.round(candidates[0].value * 100) / 100;
}

// Best-guess vendor / shop name — typically the first meaningful text line at the top of a
// receipt (mostly letters, before any comma-separated registration code).
export function parseVendor(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    const digits  = (line.match(/[0-9]/g) || []).length;
    if (letters < 3 || digits > letters) continue;
    if (/^(no\b|date|time|bill|invoice|receipt|tel|phone|route|cashier)/i.test(line)) continue;
    const name = line.split(',')[0].replace(/[^A-Za-z0-9&.\-'/ ]/g, '').replace(/\s+/g, ' ').trim();
    if (name.length >= 3) return name.slice(0, 60);
  }
  return null;
}

// Best-guess item/description — the first descriptive line that isn't the vendor, a header,
// a total/keyword line, or just a number. Best-effort; the user can edit it.
export function parseItem(text: string): string | null {
  const vendor = parseVendor(text);
  const bad = /^(no\b|date|time|bill|invoice|receipt|tel|phone|route|total|amount|sub\s*total|cash|change|balance|thank|vat|tax|qty|price|discount|rs\b|lkr|full\b|half\b|journey)/i;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || (vendor && line.startsWith(vendor))) continue;
    if ((line.match(/[A-Za-z]/g) || []).length < 3) continue;
    if (bad.test(line)) continue;
    // Drop a trailing price so "Printer cartridge  Rs 1,200.00" → "Printer cartridge".
    const cleaned = line.replace(/\s*(rs\.?|lkr)?\s*[0-9][0-9,]*\.?[0-9]*\s*$/i, '').replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 3) return cleaned.slice(0, 60);
  }
  return null;
}

// Best-guess: is this a VAT / Tax Invoice? Looks for common VAT/Tax-Invoice wording — the same
// signal Gemini is prompted to look for, just via keyword matching instead of semantic reading.
export function parseIsVat(text: string): boolean {
  return /\btax\s*invoice\b|\bvat\s*(no|reg|registration)?\s*[:#]?\s*\d|\bvat\s*%/i.test(text);
}

// Best-guess supplier VAT registration number / TIN — the numeric token on a line naming VAT/TIN.
export function parseVatNumber(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/\b(vat|tin)\b/i.test(line)) continue;
    // A VAT/TIN reg no is typically 9-12 digits, sometimes with a trailing "-XXXX" branch code.
    const m = line.match(/\b(\d{6,9}-\d{3,4}|\d{9,12})\b/);
    if (m) return m[1];
  }
  return null;
}

// Best-guess VAT amount — same money-parsing heuristic as parseBillAmount, scoped to lines that
// mention VAT but aren't the registration-number line, so a reg no doesn't get read as an amount.
export function parseVatAmount(text: string): number | null {
  const numRe = /(rs\.?|lkr|රු)?\s*((?:[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?)|(?:[0-9]+(?:\.[0-9]{1,2})?))/gi;
  const candidates: { value: number; weight: number }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/\bvat\b/i.test(line) || /\b(no|reg|registration|tin)\b/i.test(line)) continue;
    let m: RegExpExecArray | null;
    numRe.lastIndex = 0;
    while ((m = numRe.exec(line)) !== null) {
      const v = parseFloat(m[2].replace(/,/g, ''));
      if (isNaN(v) || v <= 0) continue;
      candidates.push({ value: v, weight: (m[1] ? 2 : 0) + (m[2].includes('.') ? 1 : 0) });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.weight - a.weight);
  return Math.round(candidates[0].value * 100) / 100;
}

// Best-guess bill date — scans for a YYYY-MM-DD or DD/MM/YYYY (day-first, the local convention)
// date, preferring a line that mentions "date". Only returns a real calendar date inside the
// plausible window for a suspense bill (see isPlausibleExtractedBillDate) — the SAME rule the
// Gemini reader now applies. It previously said that too, and it was not true: this function
// refused a future date while geminiBillReader.ts checked only the calendar, so the primary path
// was the looser one and a misread year passed straight through on 28% of live bills.
export function parseBillDate(text: string): string | null {
  // ONE pattern for all three numbers, two-digit years included. It used to require a literal
  // `20\d{2}`, so the commonest short form on a Sri Lankan receipt — "26/8/8", "12/9/26" —
  // matched nothing here at all and the field was left to whatever the AI path guessed.
  // readAmbiguousBillDate decides the ordering by what could actually be this bill, rather than
  // assuming one: "26/8/8" is 8 Aug 2026, not 26 Aug 2008.
  const re = /\b(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})\b/;
  const lines = text.split(/\r?\n/);
  const now = Date.now();
  for (const wantDateLine of [true, false]) {
    for (const line of lines) {
      if (wantDateLine && !/\bdate\b/i.test(line)) continue;
      const m = line.match(re);
      if (!m) continue;
      const iso = readAmbiguousBillDate(+m[1], +m[2], +m[3], now);
      if (iso) return iso;
    }
  }
  return null;
}

export interface BillData {
  amount:     number | null;
  vendor:     string | null;
  item:       string | null;
  is_vat:     boolean;
  vat_number: string | null;
  vat_amount: number | null;
  bill_date:  string | null;   // YYYY-MM-DD
}

// OCR an image bill once and pull the amount, vendor, item, and (best-effort) VAT/date details —
// used when Gemini vision (the primary reader) is unavailable, so a Google API outage doesn't
// silently drop VAT/date detection along with it. Images only — a PDF bill returns empties (the
// user types the details instead).
export async function extractBillData(file: File): Promise<BillData> {
  if (!file.type.startsWith('image/')) {
    return { amount: null, vendor: null, item: null, is_vat: false, vat_number: null, vat_amount: null, bill_date: null };
  }
  const Tesseract = await import('tesseract.js');
  const { data } = await Tesseract.recognize(file, 'eng');
  const text = data.text ?? '';
  const isVat = parseIsVat(text);
  return {
    amount: parseBillAmount(text), vendor: parseVendor(text), item: parseItem(text),
    is_vat: isVat, vat_number: isVat ? parseVatNumber(text) : null, vat_amount: isVat ? parseVatAmount(text) : null,
    bill_date: parseBillDate(text),
  };
}
