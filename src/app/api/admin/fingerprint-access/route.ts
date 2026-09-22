import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { adminDbFor } from '@/lib/firebaseAdmin';
import { fpaErrorResponse, requireUserManager } from '@/lib/fingerprintApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function bearerTokenFrom(req: NextRequest): string {
  const authorization = req.headers.get('authorization') ?? '';
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1].trim() ?? '';
}

// Human-admin authorization check for the HF-X05 Admin Tools entry point.
// Device credentials are deliberately not considered here.
export async function GET(req: NextRequest) {
  try {
    const db = adminDbFor(req);
    await requireUserManager(db, bearerTokenFrom(req));
    return NextResponse.json({ authorized: true });
  } catch (error) {
    return fpaErrorResponse(error);
  }
}
