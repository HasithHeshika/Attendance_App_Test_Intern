import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const year = searchParams.get('year') ?? String(new Date().getFullYear());

  const apiKey = process.env.CALENDARIFIC_API_KEY;
  if (!apiKey) {
    // Third-party public holidays are an OPTIONAL overlay — the company's own accepted list
    // (holiday_settings/{year}) is the authoritative one. An unset key is a configuration
    // state, not a failure, so answer with an empty list in the shape every caller already
    // parses (`data.response.holidays ?? []`) rather than a 500 that logs an error on every
    // page load and tells the user nothing they can act on.
    return NextResponse.json({ configured: false, response: { holidays: [] } });
  }

  try {
    const url =
      `https://calendarific.com/api/v2/holidays` +
      `?api_key=${apiKey}&country=LK&year=${year}&type=national`;

    const res = await fetch(url, {
      next: { revalidate: 86400 }, // cache response for 24 h
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Upstream error', status: res.status }, { status: 502 });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch holidays' }, { status: 500 });
  }
}
