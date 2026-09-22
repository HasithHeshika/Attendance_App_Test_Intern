// Netlify Scheduled Function — the in-code trigger for the recurring-shift-pattern extend job.
//
// Runs on the published PRODUCTION deploy once a week (Netlify's own scheduler — no external
// cron, no pinger URL) and calls this same deployment's /api/cron/schedule-pattern-extend
// route with ?tenant=all. The route is southernlanka-scoped and idempotent (see
// src/app/api/cron/schedule-pattern-extend/route.ts + src/lib/schedulePattern.ts), so a
// missed or doubled run is harmless — patterns are materialised HORIZON_WEEKS ahead, far
// more slack than a weekly cadence needs.
//
// Required env (already set for the route itself): CRON_SECRET. Netlify injects URL.

export const config = {
  // Mondays 03:00 UTC (08:30 Asia/Colombo). Standard cron syntax; the Go-style "@weekly"
  // shorthand is NOT supported by Netlify Scheduled Functions.
  schedule: '0 3 * * 1',
};

export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  const secret = process.env.CRON_SECRET;

  if (!base || !secret) {
    console.error('[schedule-pattern-extend] misconfigured: missing', !base ? 'URL' : 'CRON_SECRET');
    return new Response('misconfigured', { status: 500 });
  }

  const target = `${base}/api/cron/schedule-pattern-extend?tenant=all`;
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[schedule-pattern-extend] ${res.status}: ${text.slice(0, 500)}`);
      return new Response(text, { status: 502 });
    }
    console.log(`[schedule-pattern-extend] ok: ${text.slice(0, 500)}`);
    return new Response(text, { status: 200 });
  } catch (e) {
    console.error('[schedule-pattern-extend] request failed:', e);
    return new Response('request failed', { status: 502 });
  }
};
