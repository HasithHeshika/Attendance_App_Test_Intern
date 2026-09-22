import { NextRequest, NextResponse } from 'next/server';
import { resolveLogPupCaller } from '@/lib/logpupIdentity';
import { LogPupError, logpupConfigured, setLogPupTaskStatus } from '@/lib/logpupApi';
import { isLogPupStatus } from '@/lib/logpupStatus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Move one LogPup task's status on behalf of the signed-in user.
 *
 * DELIBERATELY UNLIKE the read proxy next door, this does NOT swallow failures. The read
 * degrades to an empty list because an empty list is honest; a write that silently fails shows
 * somebody a status that never saved, and they close the laptop believing they marked something
 * done. LogPup's own refusal sentence is forwarded verbatim — it answers 403 for "not your
 * task" and 503 during a maintenance window, each written for a person to read.
 *
 * The acting identity comes from the verified ID token, never from the body. LogPup re-derives
 * permission from it and refuses anyone who is not an assignee.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!logpupConfigured()) {
    return NextResponse.json({ success: false, error: 'LogPup is not configured' }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const caller = await resolveLogPupCaller(req, body?.idToken);
  if (!caller.ok) {
    return NextResponse.json({ success: false, error: caller.error }, { status: caller.status });
  }

  // The client sends LogPup's vocabulary, already mapped by @/lib/logpupStatus. Re-check it
  // here rather than trusting the mapping ran: this is the value that reaches another system's
  // database, and LogPup stores exactly three.
  const status = body?.status;
  if (!isLogPupStatus(status)) {
    return NextResponse.json({ success: false, error: 'Unknown status' }, { status: 400 });
  }

  const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : undefined;

  try {
    const result = await setLogPupTaskStatus({
      taskId: id,
      email: caller.caller.email,
      status,
      note,
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof LogPupError) {
      // Forward LogPup's own sentence and a status the client can act on. 5xx from LogPup
      // becomes 502 here: the failure is upstream, not in this request.
      const status = e.status >= 400 && e.status < 500 ? e.status : 502;
      return NextResponse.json({ success: false, error: e.message }, { status });
    }
    console.error('[logpup/status]', e);
    return NextResponse.json(
      { success: false, error: 'Could not reach LogPup — the change was not saved' },
      { status: 502 },
    );
  }
}
