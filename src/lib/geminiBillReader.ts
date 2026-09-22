// Server-only: reads a bill/receipt/invoice image with Gemini vision and returns structured
// fields — the AI actually reads the invoice, instead of tesseract.js's plain OCR text being
// regex-guessed at (which silently corrupts vendor/item names on stylised or annotated bills,
// and has no way to recognise a VAT/Tax invoice as such). NEVER import into client code — uses
// the server-only GOOGLE_API_KEY.

// Google's own always-current flash aliases — pinning to a specific dated model (e.g.
// gemini-2.0-flash) risks exactly the breakage this caused: that model was retired and the
// bill reader silently stopped working.
//
// The model is picked per bill, because the two kinds carry very different risk. Handwritten
// bills are where a misread digit becomes a wrong reimbursement (see HANDWRITTEN_ADDENDUM), so
// they get the stronger multimodal flash model; printed bills are the easy, high-volume
// majority and go to the much cheaper flash-lite. A bill the submitter did NOT mark takes the
// handwritten route — we can't tell that it isn't handwritten, and guessing cheap is the
// expensive way to be wrong. Note the spend guard prices every call at one rate regardless
// (see AI_PRICE_* in .env.example), so routing makes it over-count, never under-count.
// GEMINI_BILL_MODEL still forces ONE model for every call if you want to pin the behaviour;
// the two per-route vars override just one leg of the routing.
import { isPlausibleExtractedBillDate } from '@/lib/billDatePlausibility';

const MODEL_PIN         = process.env.GEMINI_BILL_MODEL || '';
const MODEL_HANDWRITTEN = process.env.GEMINI_BILL_MODEL_HANDWRITTEN || 'gemini-flash-latest';
const MODEL_PRINTED     = process.env.GEMINI_BILL_MODEL_PRINTED     || 'gemini-flash-lite-latest';

function modelFor(billKind?: 'handwritten' | 'printed' | ''): string {
  if (MODEL_PIN) return MODEL_PIN;
  return billKind === 'printed' ? MODEL_PRINTED : MODEL_HANDWRITTEN;
}

// What the call cost, in tokens — fed to the monthly spend guard (src/lib/aiUsageBudget.ts).
export interface BillReadUsage {
  inputTokens:  number;
  outputTokens: number;
}

export interface BillReadResult {
  shop_name:  string | null;
  item:       string | null;
  amount:     number | null;   // the final total payable (VAT-inclusive if it's a VAT bill)
  is_vat:     boolean;
  vat_number: string | null;   // the SUPPLIER's VAT registration number / TIN
  vat_amount: number | null;   // the VAT portion within `amount`
  bill_date:  string | null;   // the date printed ON the bill (YYYY-MM-DD), not the scan date
  // Bookkeeping, not a bill field — the API route strips it before responding, because the
  // suspense form's contract is exactly the fields above. Absent if Gemini returned no
  // usageMetadata, in which case the call goes uncounted rather than counted as zero.
  _usage?:    BillReadUsage;
}

const BASE_PROMPT = `You are reading a photo of a purchase bill, receipt, or tax invoice for an expense-claim system. Extract these fields as JSON:

- shop_name: the SELLER/SUPPLIER's business name (the company that issued and is being paid on this bill) — never the buyer/purchaser's name, even if a "Purchaser" or "Bill To" field is more prominent.
- item: a short one-line description of what was purchased (summarise if there are multiple line items — pick the main one or a brief combined description).
- amount: the FINAL total amount payable on the bill, as a plain number with no currency symbol or thousands separators. If the bill shows both an amount excluding VAT and a total including VAT, use the TOTAL INCLUDING VAT.
- is_vat: true if this is clearly a VAT bill or Tax Invoice — look for wording like "TAX INVOICE", "VAT No", "VAT Reg", "VAT Registration", a VAT percentage/amount line, or a Supplier TIN. The Sinhala equivalents count exactly as much: "බදු ඉන්වොයිසිය" or "බදු බිල්පත" (tax invoice), "වැට්" (VAT), "වැට් අංකය" / "වැට් ලියාපදිංචි අංකය" (VAT number / VAT registration number), "බදු" (tax). Otherwise false.
- vat_number: the SUPPLIER's VAT registration number or TIN if printed on the bill (never the purchaser's), else null.
- vat_amount: the VAT portion of the total, as a plain number, if it is printed on the bill or unambiguously computable from a shown VAT percentage and the total — else null.
- bill_date: the date printed ON the bill itself (when the purchase/invoice was issued — e.g. next to "Date:", a printed receipt timestamp, or an invoice date field), formatted as YYYY-MM-DD. If no date appears on the bill, or it's illegible, use null — do not guess or use today's date.
  TWO-DIGIT YEARS AND FIELD ORDER: these bills are submitted within days or weeks of purchase, so the date is always RECENT — today's date is given below. A short date like "26/8/8" or "8/8/26" is ambiguous, and you must resolve it to the reading that is actually recent, not to a fixed convention. "26/8/8" is 2026-08-08 (year first), NOT 2008-08-26. Expand a two-digit year into the 2000s. If the only reading you can justify would be years in the past or in the future, return null instead — a wrong year is worse than no date, because nobody re-checks it.

LANGUAGE: Sri Lankan bills are printed in Sinhala, in English, or in a mix of the two — an English total on an otherwise Sinhala receipt, or a Sinhala shop name above Latin numerals. Read whichever you are given. A bill not being in English is NEVER a reason to return nulls or to say you cannot read it.
- Return shop_name and item in the SCRIPT THEY ARE PRINTED IN. Do NOT translate or transliterate a Sinhala name into English — the person checking the claim is matching your answer against the paper bill in front of them.
- Digits are usually Latin (0-9) even on an otherwise Sinhala bill; read them normally.
- Currency is marked as "Rs.", "රු.", "රුපියල්" or "LKR" — all the same thing. Strip it: amount and vat_amount are still plain numbers.
- Sinhala terms that locate the other fields: බිල්පත / කුවිතාන්සිය (bill / receipt), ඉන්වොයිසිය (invoice), එකතුව / මුළු එකතුව (total / grand total), දිනය (date), අංකය (number).

If a field truly cannot be determined from the image, use null (or false for is_vat). Respond with ONLY the JSON object, no other text.`;

// Appended only when the submitter marked the bill as handwritten — pushes the model to slow
// down on digits specifically (the single highest-stakes failure mode, since a wrong AMOUNT
// feeds straight into a reimbursement) rather than confidently guessing at messy handwriting.
const HANDWRITTEN_ADDENDUM = `

This bill is HANDWRITTEN (or has handwritten figures on an otherwise printed form) — read it with extra care:
- Handwritten digits are easily confused: look closely at 1 vs 7, 0 vs 6, 3 vs 8, 4 vs 9, and 5 vs 6. Cross-check the total against any visible line items or arithmetic on the bill to sanity-check your reading before answering.
- If a figure is genuinely illegible, smudged, or ambiguous between two plausible readings, DO NOT GUESS — return null for that field instead. A wrong number is worse than a blank one here, since it feeds directly into a reimbursement that a person will rely on without necessarily re-checking the original photo.
- The same caution applies to the VAT registration number and VAT amount if those are handwritten too.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    shop_name:  { type: 'STRING', nullable: true },
    item:       { type: 'STRING', nullable: true },
    amount:     { type: 'NUMBER', nullable: true },
    is_vat:     { type: 'BOOLEAN' },
    vat_number: { type: 'STRING', nullable: true },
    vat_amount: { type: 'NUMBER', nullable: true },
    bill_date:  { type: 'STRING', nullable: true },
  },
  required: ['is_vat'],
};

// Only trust a well-formed, real calendar date that could plausibly BE this bill — a malformed,
// hallucinated or misread string here would otherwise silently corrupt the stored bill_date,
// which callers treat as always-valid.
//
// This is the PRIMARY extractor, and until now it was the weaker of the two: it checked the
// calendar and nothing else, while the tesseract fallback in src/lib/ocr.ts at least refused a
// future date and claimed in its comment that this function did the same. It did not. The gap
// is what let 102 of 358 live bills store a year misread by OCR (2024/2020/2023 for 2026 — the
// final digit) with a correct day and month. Both paths now share one rule.
function parseBillDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const iso = `${y}-${mo}-${d}`;
  // Fail closed on anything outside the plausible window: the form falls back to today and shows
  // the submitter an editable date field while they are holding the receipt, which beats storing
  // a confident wrong year that nobody looks at again.
  if (!isPlausibleExtractedBillDate(iso, Date.now())) return null;
  return iso;
}

// Hard ceiling on the Gemini call — plain `fetch` has no default timeout in Node, so a stalled
// connection (flaky mobile signal in the field is the common case here) would otherwise hang
// far longer than any user will wait, with no chance for the caller's tesseract.js fallback to
// ever kick in. Failing fast here is what lets that fallback actually do its job.
const GEMINI_TIMEOUT_MS = 20_000;

export async function readBillWithGemini(buffer: Buffer, mimeType: string, billKind?: 'handwritten' | 'printed' | ''): Promise<BillReadResult> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('Bill reading is not configured (GOOGLE_API_KEY missing).');

  // Today's date goes IN the prompt. Without it the model has no way to resolve "26/8/8" —
  // both 8 Aug 2026 and 26 Aug 2008 are valid readings, and it was picking the wrong one.
  const today = new Date().toISOString().slice(0, 10);
  const dateAnchor = `\n\nToday's date is ${today}. Bills are submitted within days or weeks of purchase — use this to resolve any ambiguous or two-digit year.`;
  const prompt = (billKind === 'handwritten' ? BASE_PROMPT + HANDWRITTEN_ADDENDUM : BASE_PROMPT) + dateAnchor;
  const model  = modelFor(billKind);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
            ],
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: SCHEMA,
            temperature: 0,
          },
        }),
        signal: controller.signal,
      },
    );
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error('Bill reading timed out — the connection to the AI reader was too slow.');
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message;
    throw new Error(msg || `Bill reading failed (${res.status}).`);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') throw new Error('Bill reading returned no result.');

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('Bill reading returned an unreadable result.'); }

  const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null);
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);

  const usage = readUsage(data?.usageMetadata);
  return {
    shop_name:  str(parsed.shop_name),
    item:       str(parsed.item),
    amount:     num(parsed.amount),
    is_vat:     parsed.is_vat === true,
    vat_number: str(parsed.vat_number),
    vat_amount: num(parsed.vat_amount),
    bill_date:  parseBillDate(parsed.bill_date),
    ...(usage ? { _usage: usage } : {}),
  };
}

// Gemini reports what the call consumed in `usageMetadata`. Returns undefined rather than
// zeros when the field is missing or unusable — an uncounted call is visibly nothing, whereas
// a zero would look like a free call and quietly under-count the month's spend.
function readUsage(meta: unknown): BillReadUsage | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const m = meta as Record<string, unknown>;
  const tok = (v: unknown): number => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v) : 0);
  const inputTokens = tok(m.promptTokenCount);
  // Thinking tokens are billed at the output rate but counted separately from the answer, so
  // they belong on the output side — leaving them out would under-count what we're charged.
  const outputTokens = tok(m.candidatesTokenCount) + tok(m.thoughtsTokenCount);
  if (!inputTokens && !outputTokens) return undefined;
  return { inputTokens, outputTokens };
}
