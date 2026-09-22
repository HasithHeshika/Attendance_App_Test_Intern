import { NextRequest, NextResponse } from 'next/server';
import { getSolarServicePlans } from '@/lib/solarApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { epfNumber } = await req.json().catch(() => ({}));
    if (!epfNumber) {
      return NextResponse.json({ success: false, hasPlan: false, reason: 'EPF number is required' }, { status: 400 });
    }

    const today = new Date();
    const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, ..., 5 = Friday, 6 = Saturday

    // Determine the date range to check:
    // - Friday: check Friday, Saturday, Sunday, and Monday (3 days ahead)
    // - Saturday: check Saturday, Sunday, and Monday (2 days ahead)
    // - Other days: check today and tomorrow (1 day ahead)
    let daysToCheck = 1;
    if (dayOfWeek === 5) {
      daysToCheck = 3;
    } else if (dayOfWeek === 6) {
      daysToCheck = 2;
    }

    const pad2 = (n: number) => String(n).padStart(2, '0');
    const formatDateStr = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

    const fromStr = formatDateStr(today);

    const endDate = new Date(today);
    endDate.setDate(today.getDate() + daysToCheck);
    const toStr = formatDateStr(endDate);

    // Fetch service plans scheduled within the target date range
    const res = await getSolarServicePlans({ from: fromStr, to: toStr });
    const plans = res?.data ?? [];

    const userEpf = String(epfNumber).trim().toLowerCase();
    
    // Sort plans by date ascending to find the earliest matched date first
    const sortedPlans = plans.sort((a, b) => a.date.localeCompare(b.date));

    let matchedDate: string | null = null;
    for (const plan of sortedPlans) {
      const leaderEpf = plan.team?.leader?.epfNumber;
      const engineerEpf = plan.team?.siteEngineer?.epfNumber;
      
      const leaderMatch = leaderEpf ? String(leaderEpf).trim().toLowerCase() === userEpf : false;
      const engineerMatch = engineerEpf ? String(engineerEpf).trim().toLowerCase() === userEpf : false;
      const memberMatch = plan.team?.members?.some(m => 
        m.epfNumber ? String(m.epfNumber).trim().toLowerCase() === userEpf : false
      ) ?? false;

      if (leaderMatch || engineerMatch || memberMatch) {
        matchedDate = plan.date; // e.g. "2026-06-29"
        break;
      }
    }

    return NextResponse.json({ success: true, hasPlan: matchedDate !== null, planDate: matchedDate });
  } catch (err: any) {
    return NextResponse.json({ success: false, hasPlan: false, error: err.message }, { status: 500 });
  }
}
