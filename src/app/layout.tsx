import type { Metadata, Viewport } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";
import ThemeProvider from "@/components/ThemeProvider";
import { headers } from "next/headers";
import { tenantByHost, tenantForDbId, splitBrandName } from "@/lib/tenants";
import { awaitTenants } from "@/lib/tenantRegistry";
import { TENANT_GLOBAL } from "@/lib/tenantClient";
import NetworkStatus from "@/components/NetworkStatus";
import BrandMeta from "@/components/BrandMeta";
import AppToaster from "@/components/ui/AppToaster";
import LanyardOverlay from "@/components/lanyard/LanyardOverlay";
import MaintenanceGate from "@/components/maintenance/MaintenanceGate";
import { TenantProvider } from "@/components/TenantProvider";
import "./globals.css";

// Self-hosted, preloaded fonts — replaces the render-blocking Google Fonts
// @import that used to top globals.css. next/font inlines the font CSS, serves
// the files same-origin (so Serwist can cache them), and uses `display: swap`
// so text paints immediately in the fallback then swaps with no blocking
// round-trip on the critical path. Exposed as CSS vars consumed by Tailwind
// (font-sans / font-mono) and the body font-family in globals.css.
const fontSans = Outfit({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});
const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: 'PearlCluster',
  description: 'Enterprise Attendance & Leave Management',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'PearlCluster',
  },
  icons: {
    icon: '/favicon.ico',
    apple: '/app.png',
    shortcut: '/icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#0C8ECA',
  width: 'device-width',
  initialScale: 1,
  minimumScale: 1,
  // Required for `env(safe-area-inset-*)` to resolve to anything but 0 on iOS — without it,
  // every safe-area padding this app already applies (BottomNav, dialogs, the toaster,
  // NotificationCenter) silently computes to zero on iOS/standalone-PWA, letting fixed-position
  // UI sit flush against the notch/home-indicator with no cushion.
  viewportFit: 'cover',
};

// Rendered per request, never prerendered: the tenant list lives in the `tenants` Firestore
// database (src/lib/tenantRegistry.ts), so which brand and which Firestore database this
// response belongs to is only knowable once we have a Host header. This is the single place
// the whole app resolves that — everything downstream reads the answer, nobody re-derives it.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // awaitTenants() blocks on the registry (60s cache, last-good on error, shipped snapshot on
  // a cold start). The browser must never be told the wrong tenant, so this one place waits.
  const [tenants, headerList] = await Promise.all([awaitTenants(), headers()]);
  // x-forwarded-host first — that's the one Netlify sets to the real domain.
  const host = headerList.get('x-forwarded-host') || headerList.get('host');
  const tenant = tenantByHost(host, tenants)
    ?? tenantForDbId(process.env.FIRESTORE_DB_ID, tenants);
  const [brandHead, brandTail] = splitBrandName(tenant.appName);

  // Everything the browser needs to know about itself. Serialised into an inline script that
  // runs before any bundle, which is what lets src/lib/firebase.ts keep `tenant` a plain
  // synchronous const and module-scope reads like `const F = tenant.features` keep working.
  const injected = JSON.stringify({ ...tenant, brandHead, brandTail })
    // A tenant field is admin-editable text; "</script>" inside one would end this tag early.
    .replace(/</g, '\\u003c');
  return (
    // `dark` is only the no-JS fallback. The head script below sets the user's
    // saved theme BEFORE first paint, so the loading screen and first content
    // render in the correct theme (no dark flash for light-mode users).
    // suppressHydrationWarning: the script mutates <html> class before hydration.
    <html lang="en" className={`dark ${fontSans.variable} ${fontMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){try{
            var d=document.documentElement,pref='system',raw=localStorage.getItem('app-prefs');
            if(raw){var p=JSON.parse(raw);if(p&&p.state&&p.state.theme)pref=p.state.theme;}
            var dark=pref==='dark'||(pref==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
            d.classList.toggle('dark',dark);d.classList.toggle('light',!dark);
            d.style.colorScheme=dark?'dark':'light';
          }catch(e){}})();
        ` }} />
      </head>
      <body className="antialiased" suppressHydrationWarning={true}>
        {/* THE tenant handoff. First thing in <body>, so it runs before any bundle is
            evaluated — src/lib/tenantClient.ts reads it back, and src/lib/firebase.ts depends
            on that ordering to open the right Firestore database synchronously at import. */}
        <script dangerouslySetInnerHTML={{ __html: `window.${TENANT_GLOBAL}=${injected};` }} />

        {/* Per-domain branding, applied from the tenant injected above.

            The <head> metadata is baked into the shared build and always names the default
            brand, so it is patched here before first paint rather than after React hydrates.
            Icons need no such swap: src/proxy.ts serves each domain different bytes at
            /favicon.ico, /icon.png, /app.png and /manifest.json.

            The visible brand TEXT needs nothing here any more: TenantProvider hands the
            resolved tenant to React, so the server already renders the right name. This
            script exists only for the <head> tags React does not own on first paint. */}
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){try{
            var t=window.${TENANT_GLOBAL};
            if(!t)return;
            document.title=t.appName;
            var c=document.querySelector('meta[name="theme-color"]');
            if(c)c.setAttribute('content',t.themeColor);
            var a=document.querySelector('meta[name="apple-mobile-web-app-title"]');
            if(a)a.setAttribute('content',t.appName);
          }catch(e){}})();
        `}} />
        {/* Capture beforeinstallprompt before React mounts — the event fires early
            and would be missed if we only listen inside component useEffect.
            Also register the SW immediately so Chrome evaluates installability
            on the very first page load (not just after Firebase/auth setup). */}
        <script dangerouslySetInnerHTML={{ __html: `
          window.__pwaInstallPrompt = null;
          window.addEventListener('beforeinstallprompt', function(e) {
            e.preventDefault();
            window.__pwaInstallPrompt = e;
            window.dispatchEvent(new CustomEvent('pwa-prompt-ready'));
          });
          if ('serviceWorker' in navigator) {
            ${process.env.NODE_ENV === 'production'
              ? `
            var hadSW = !!navigator.serviceWorker.controller;
            navigator.serviceWorker.register('/sw.js').then(function(reg){
              // Installed PWAs can stay open for days without a navigation, so they
              // never re-check /sw.js on their own — poll hourly and on foreground.
              var check = function(){ try { reg.update(); } catch(e) {} };
              setInterval(check, 60 * 60 * 1000);
              document.addEventListener('visibilitychange', function(){
                if (document.visibilityState === 'visible') check();
              });
            });
            // The SW uses skipWaiting/clientsClaim: a new release activates immediately
            // and PURGES the previous build's precached chunks, so pages still running
            // the old build would crash on their next lazy import. Reload them into the
            // new build the moment it takes control. hadSW guards the very first
            // install (no previous controller) so a first visit never reloads.
            var swReloaded = false;
            navigator.serviceWorker.addEventListener('controllerchange', function(){
              if (!hadSW || swReloaded) return;
              swReloaded = true;
              window.location.reload();
            });`
              : `navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){if(r.active&&r.active.scriptURL&&r.active.scriptURL.endsWith('/sw.js'))r.unregister();});});if(window.caches){caches.keys().then(function(ks){ks.forEach(function(k){caches.delete(k);});});}`}
          }
        `}} />
        {/* Version-skew self-healing: when a deploy replaced the hashed chunks this page's
            HTML still references, script/CSS chunk loads fail (ChunkLoadError / failed
            dynamic import). Instead of stranding the user on a broken page until they
            manually clear site data, purge all caches and reload once to pick up the new
            build. sessionStorage-throttled to one attempt per minute so a genuinely
            broken deploy can't cause a reload loop; skipped offline, where the cached
            (working) page is strictly better than a failed reload. */}
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){
            var KEY = 'app-chunk-recover-at';
            function recover(){
              if (!navigator.onLine) return;
              var last = 0; try { last = +sessionStorage.getItem(KEY) || 0; } catch(e){}
              if (Date.now() - last < 60000) return;
              try { sessionStorage.setItem(KEY, String(Date.now())); } catch(e){}
              var reload = function(){ window.location.reload(); };
              if (window.caches) {
                caches.keys().then(function(ks){ return Promise.all(ks.map(function(k){ return caches.delete(k); })); }).then(reload, reload);
              } else { reload(); }
            }
            function isChunkErr(msg){
              return /ChunkLoadError|Loading chunk|Loading CSS chunk|dynamically imported module|Importing a module script failed/i.test(msg || '');
            }
            window.addEventListener('error', function(e){
              if (e && isChunkErr(e.message)) { recover(); return; }
              var t = e && e.target;
              var src = (t && (t.src || t.href)) || '';
              if (t && (t.tagName === 'SCRIPT' || t.tagName === 'LINK') && String(src).indexOf('/_next/') !== -1) recover();
            }, true);
            window.addEventListener('unhandledrejection', function(e){
              var r = e && e.reason;
              if (r && (r.name === 'ChunkLoadError' || isChunkErr(r.message))) recover();
            });
          })();
        `}} />
        {/* TenantProvider wraps everything that renders, BrandMeta included: both the page
            and the <head> tags must describe the same tenant, and this is the only place that
            tenant was resolved. */}
        <TenantProvider tenant={tenant}>
          <ThemeProvider>
            {children}
          </ThemeProvider>
          <BrandMeta />
          <NetworkStatus />
          <AppToaster />
          <LanyardOverlay />
          <MaintenanceGate />
        </TenantProvider>
      </body>
    </html>
  );
}
