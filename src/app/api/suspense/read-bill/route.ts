import { NextRequest, NextResponse } from 'next/server';
import { verifyUser } from '@/lib/cloudStorageServer';
import { readBillWithGemini } from '@/lib/geminiBillReader';
import { getAiBudget, recordAiUsage, utcMonthKey } from '@/lib/aiUsageBudget';

export const runtime = 'nodejs';

// Read a bill/receipt/invoice photo with Gemini vision and return structured fields (shop,
// item, amount, VAT bill + registration number + amount). Any authenticated user may call this
// — it's read-only against an external AI. Client-side fallback: if this fails, the suspense
// form falls back to the (much less accurate) client-side OCR rather than leaving the user
// stuck. That fallback is what makes the monthly spend cap below safe to enforce as a hard
// stop — refusing the call costs accuracy, not the ability to file the expense.
export async function POST(req: NextRequest) {
  try {
    const form     = await req.formData();
    const idToken  = String(form.get('idToken') ?? '');
    const file     = form.get('file') as File | null;
    const billKind = String(form.get('billKind') ?? '');

    const user = await verifyUser(idToken);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!file)  return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    if (!file.type.startsWith('image/')) {
      return NextResponse.json({ error: 'Only image bills can be read automatically.' }, { status: 400 });
    }

    // Spend the money only if there's budget left. Google's console monthly limit is the hard
    // cap; this stops us short of it (src/lib/aiUsageBudget.ts) so the key never dies mid-month.
    const budget = await getAiBudget();
    if (!budget.allowed) {
      return NextResponse.json({
        error: `AI bill reading has used its $${budget.limitUsd.toFixed(2)} budget for ${utcMonthKey()} and resumes next month.`,
      }, { status: 429 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await readBillWithGemini(buffer, file.type, billKind === 'handwritten' ? 'handwritten' : billKind === 'printed' ? 'printed' : '');

    // Count what it cost, then answer with exactly the fields the suspense form reads — `_usage`
    // is ours, not part of the response contract. A tracking failure is logged, never thrown: a
    // bill that WAS read must not come back as an error because the counter couldn't be updated.
    const { _usage, ...fields } = result;
    if (_usage) {
      await recordAiUsage({ inputTokens: _usage.inputTokens, outputTokens: _usage.outputTokens })
        .catch(err => console.error('[suspense/read-bill] usage tracking failed', err));
    }
    return NextResponse.json(fields);
  } catch (e) {
    console.error('[suspense/read-bill]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Bill reading failed' }, { status: 500 });
  }
}
