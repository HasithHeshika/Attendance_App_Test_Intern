'use client';
import { auth } from '@/lib/firebase';

export interface BillReadResult {
  shop_name:  string | null;
  item:       string | null;
  amount:     number | null;
  is_vat:     boolean;
  vat_number: string | null;
  vat_amount: number | null;
  bill_date:  string | null;   // YYYY-MM-DD, the date printed on the bill
}

// Send a bill photo to the server, which asks Gemini vision to read it — far more reliable
// than client-side OCR (tesseract.js) for vendor/item names and recognising a VAT/Tax invoice,
// since it reads the invoice semantically instead of regex-guessing at plain recognized text.
// `billKind` sharpens the prompt for handwritten bills (extra care on ambiguous digits — see
// geminiBillReader.ts) when known; omit it if the bill type hasn't been chosen yet.
export async function readBillWithAI(file: File, billKind?: 'handwritten' | 'printed' | ''): Promise<BillReadResult> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');

  const fd = new FormData();
  fd.append('idToken', idToken);
  fd.append('file', file);
  if (billKind) fd.append('billKind', billKind);

  const res = await fetch('/api/suspense/read-bill', { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Failed to read the bill.');
  return data as BillReadResult;
}
