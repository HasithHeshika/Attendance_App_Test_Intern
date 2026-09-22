// Netlify Scheduled Function — the in-code trigger for the open-session monitor.
//
// Runs on the published PRODUCTION deploy every 15 minutes (Netlify's own scheduler — no
// external cron service, no pinger URL) and calls this same deployment's
// /api/cron/auto-checkout route with ?tenant=all. The route scans for Southern Lanka
// attendance sessions still OPEN past MAX_PLAUSIBLE_SHIFT_HOURS and FLAGS them for supervisor
// review — it never closes a session or truncates hours. It is southernlanka-scoped and
// idempotent (deterministic attendance_reviews doc ids), so a missed or doubled run is
// harmless. See src/app/api/cron/auto-checkout/route.ts + src/lib/attendanceAutoClose.ts.
//
// Required env (already set for the route itself): CRON_SECRET. Netlify injects URL.

export const config = {
  // Every 15 minutes. Netlify Scheduled Functions take standard cron syntax; the Go-style
  // "@every 15m" shorthand is NOT supported, and this expression is its equivalent.
  schedule: '*/15 * * * *',
};

export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  const secret = process.env.CRON_SECRET;

  if (!base || !secret) {
    console.error('[auto-checkout-sweep] misconfigured: missing', !base ? 'URL' : 'CRON_SECRET');
    return new Response('misconfigured', { status: 500 });
  }

  const target = `${base}/api/cron/auto-checkout?tenant=all`;
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[auto-checkout-sweep] ${res.status}: ${text.slice(0, 500)}`);
      return new Response(text, { status: 502 });
    }
    console.log(`[auto-checkout-sweep] ok: ${text.slice(0, 500)}`);
    return new Response(text, { status: 200 });
  } catch (e) {
    console.error('[auto-checkout-sweep] request failed:', e);
    return new Response('request failed', { status: 502 });
  }
};
