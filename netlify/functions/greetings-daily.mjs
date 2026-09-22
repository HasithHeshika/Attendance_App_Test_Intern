// Netlify Scheduled Function — the in-code trigger for the daily greetings job.
//
// Runs on the published PRODUCTION deploy once a day and calls this same deployment's
// /api/cron/greetings route with ?tenant=all. The route is idempotent (once-per-year markers
// per person and occasion), so a doubled run is harmless. A missed run is not back-filled:
// the next morning only greets people whose occasion is that day.
// See src/app/api/cron/greetings/route.ts and docs/superpowers/specs/2026-09-05-automatic-greetings-design.md.
//
// Required env (already set for the route itself): CRON_SECRET. Netlify injects URL.

export const config = {
  // 02:30 UTC = 08:00 Asia/Colombo. Standard 5-field cron; "@daily" shorthand is NOT supported.
  schedule: '30 2 * * *',
};

export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  const secret = process.env.CRON_SECRET;

  if (!base || !secret) {
    console.error('[greetings-daily] misconfigured: missing', !base ? 'URL' : 'CRON_SECRET');
    return new Response('misconfigured', { status: 500 });
  }

  const target = `${base}/api/cron/greetings?tenant=all`;
  try {
    const res = await fetch(target, { method: 'POST', headers: { authorization: `Bearer ${secret}` } });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[greetings-daily] ${res.status}: ${text.slice(0, 500)}`);
      return new Response(text, { status: 502 });
    }
    console.log(`[greetings-daily] ok: ${text.slice(0, 500)}`);
    return new Response(text, { status: 200 });
  } catch (e) {
    console.error('[greetings-daily] request failed:', e);
    return new Response('request failed', { status: 502 });
  }
};
