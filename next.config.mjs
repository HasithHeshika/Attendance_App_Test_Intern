import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  // Source of the precache service worker (compiled by Serwist).
  swSrc: "src/app/sw.ts",
  // Output path + URL must stay /sw.js — registration is done manually in
  // src/app/layout.tsx, so we tell Serwist not to inject its own registration.
  swDest: "public/sw.js",
  swUrl: "/sw.js",
  register: false,
  reloadOnOnline: true,
  // Don't build/enable the precache SW in development.
  disable: process.env.NODE_ENV !== "production",
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['three', '@react-three/fiber', '@react-three/drei', '@react-three/rapier', 'meshline'],
  images: {
    // `images.domains` was removed in Next.js 16 — use remotePatterns.
    remotePatterns: [
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
    ],
  },
  // ── Security headers ───────────────────────────────────────────────────────────
  // Deliberately NOT a script-src CSP: src/app/layout.tsx ships five inline <script> blocks
  // (pre-paint theme, the window.__TENANT__ handoff, brand patch, PWA install capture, SW
  // registration) that a strict policy would have to allow by nonce, and a nonce needs the
  // whole layout to become request-scoped. `'unsafe-inline'` would be theatre, so the CSP
  // here carries only the directives that are genuinely enforceable as-is. Adding script-src
  // with per-request nonces is the follow-up.
  async headers() {
    const csp = [
      "frame-ancestors 'none'",   // nothing may frame this app (clickjacking)
      "object-src 'none'",        // no <object>/<embed> plugin content
      "base-uri 'self'",          // an injected <base> can't re-point every relative URL
      "form-action 'self'",       // a submitted form can't be redirected off-origin
    ].join('; ');

    const base = [
      { key: 'Content-Security-Policy', value: csp },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      // HSTS: production is HTTPS-only behind Netlify. Not preloaded — that is a one-way
      // door for the apex domain and belongs to whoever owns DNS, not to this file.
      { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
      // Attendance check-in needs geolocation and bill capture needs the camera, so those
      // stay self-enabled; everything else is off.
      { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(self), microphone=(), payment=(), usb=()' },
    ];

    return [
      {
        source: '/:path*',
        headers: [...base, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }],
      },
      {
        // API routes are stricter about Referer specifically because several of them accept
        // a secret in the query string where a header is impossible — the EventSource key on
        // /api/working-status, the session token on /api/cloud-storage/file. Those must not
        // ride along to any third party the response happens to link to.
        source: '/api/:path*',
        headers: [...base, { key: 'Referrer-Policy', value: 'no-referrer' }],
      },
    ];
  },

  async rewrites() {
    // MUST be `fallback`, not a flat array (= implicit `afterFiles`). afterFiles rewrites are
    // checked BEFORE Next resolves dynamic app routes (e.g. anything under a [param] segment),
    // so a flat-array catch-all here would silently swallow every dynamic API route this app
    // defines itself (…/api/payroll/runs/[runId]/generate and its siblings included) and proxy
    // them to the legacy server below instead — even though a real route.ts exists for them.
    // `fallback` is checked last, only once neither a static NOR a dynamic route matched, which
    // is what a "legacy/unmigrated endpoint" proxy is actually supposed to do.
    return {
      beforeFiles: [],
      afterFiles: [],
      fallback: [
        {
          source: "/api/:path*",
          destination: `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api"}/:path*`,
        },
      ],
    };
  },
};

// Serwist injects a webpack config for the service-worker build, which clashes with
// Next 16's default Turbopack dev server (and is a no-op in dev anyway). So only wrap
// for production builds: `next dev` stays on clean Turbopack with no webpack config,
// and the SW is compiled by `next build --webpack` (see the `build` script).
export default process.env.NODE_ENV === "production" ? withSerwist(nextConfig) : nextConfig;
