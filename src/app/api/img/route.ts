import { NextRequest } from 'next/server';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Same-origin image proxy so arbitrary company-logo URLs can be drawn onto a
// <canvas> without CORS taint (the lanyard card/strap composite logos into a
// texture — see src/components/lanyard/idCardCanvas.ts and src/lib/brandColor.ts).
// Re-serves the bytes with `Access-Control-Allow-Origin: *`.
//
// This route is UNAUTHENTICATED and takes a caller-supplied URL, which makes it a textbook
// SSRF surface: without the guards below it will happily fetch http://169.254.169.254/… or
// anything else inside the deployment's network and hand the answer back, and the
// 400/415/502/200 split alone is a clean reachability oracle for scanning a private range.
// So every hop is resolved to an IP and checked before a socket is opened, redirects are
// followed by hand (a redirect to a private address is exactly how a naive check gets
// bypassed), and the response is capped.
export const runtime = 'nodejs';

const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 8 * 1024 * 1024; // a logo/avatar; anything larger is not one
const MAX_REDIRECTS = 3;

/**
 * Is this a literal address nobody outside the host's own network should be able to make us
 * talk to? Covers loopback, RFC1918, carrier-grade NAT, link-local (which is where cloud
 * instance-metadata lives), benchmarking, multicast and reserved space, plus the IPv6
 * equivalents and IPv4-mapped IPv6.
 */
function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);

  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;                 // this-network, private, loopback
    if (a === 100 && b >= 64 && b <= 127) return true;                 // 100.64/10 CGNAT
    if (a === 169 && b === 254) return true;                           // 169.254/16 link-local (metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;                  // 172.16/12 private
    if (a === 192 && b === 168) return true;                           // 192.168/16 private
    if (a === 192 && b === 0) return true;                             // 192.0.0/24 + 192.0.2/24
    if (a === 198 && (b === 18 || b === 19)) return true;              // 198.18/15 benchmarking
    if (a >= 224) return true;                                         // multicast + reserved
    return false;
  }

  if (v === 6) {
    const lower = ip.toLowerCase();
    // An IPv4-mapped address (::ffff:127.0.0.1) reaches the same host as the v4 form.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true;                // unspecified, loopback
    if (/^f[cd]/.test(lower)) return true;                             // fc00::/7 unique-local
    if (/^fe[89ab]/.test(lower)) return true;                          // fe80::/10 link-local
    if (lower.startsWith('ff')) return true;                           // multicast
    return false;
  }

  return true; // not a parseable address — refuse
}

/** Reject anything we should not open a socket to, resolving DNS names to real addresses. */
async function assertSafeTarget(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('unsupported protocol');
  }
  // Only the standard web ports. A logo does not live on :22, and allowing arbitrary ports
  // turns this into a port scanner for anything the checks below happen not to catch.
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443) throw new Error('unsupported port');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('blocked address');
    return;
  }
  // A name can resolve to several addresses; ALL of them must be public, or a host with one
  // public and one private A record slips straight through.
  const resolved = await lookup(host, { all: true });
  if (!resolved.length) throw new Error('unresolvable host');
  for (const { address } of resolved) {
    if (isBlockedAddress(address)) throw new Error('blocked address');
  }
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url');
  if (!url) return new Response('missing url', { status: 400 });

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return new Response('invalid url', { status: 400 });
  }

  try {
    // Follow redirects by hand so every hop is re-validated. `redirect: 'manual'` is the
    // whole point: letting fetch follow them would check only the first URL, and "302 to
    // 169.254.169.254" is the standard way past a first-hop-only check.
    let upstream: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertSafeTarget(target);
      const res = await fetch(target.toString(), {
        headers: { Accept: 'image/*,*/*' },
        redirect: 'manual',
        // 6s budget so a slow host can't hang the request.
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return new Response('fetch failed', { status: 502 });
        target = new URL(location, target); // a relative Location is legal
        continue;
      }
      upstream = res;
      break;
    }
    if (!upstream) return new Response('too many redirects', { status: 502 });
    if (!upstream.ok) return new Response('fetch failed', { status: 502 });

    const contentType = upstream.headers.get('content-type') || 'image/png';
    if (!contentType.startsWith('image/')) return new Response('not an image', { status: 415 });

    const declared = Number(upstream.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      return new Response('image too large', { status: 413 });
    }
    const buf = await upstream.arrayBuffer();
    // Content-Length is a hint, not a promise — check what actually arrived too.
    if (buf.byteLength > MAX_BYTES) return new Response('image too large', { status: 413 });

    return new Response(buf, {
      headers: {
        'Content-Type': contentType,
        // No caching: this proxy serves profile pictures (and logos). A cached/immutable
        // response could keep showing a stale — or a different person's — picture after an
        // avatar change/account switch. Always re-fetch the current image.
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch {
    // Deliberately one opaque status for every rejection reason. Distinguishing "blocked
    // address" from "connection refused" from "timeout" is what turns a proxy into a
    // network-mapping tool for whoever is probing it.
    return new Response('proxy error', { status: 502 });
  }
}
