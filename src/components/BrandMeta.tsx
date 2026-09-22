'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useTenant } from '@/components/TenantProvider';

/**
 * Keeps <title> and the theme-colour metas on the current domain's brand.
 *
 * The root layout's `metadata` export is baked into the prerendered HTML that EVERY domain
 * shares, so it always names the default tenant. The inline script in layout.tsx patches it
 * before first paint — but React owns those head tags, so it restores the prerendered value
 * the moment it hydrates, and again on every client-side navigation. That is why carecode.org
 * showed a "PearlCluster" tab and Alta Vision's blue theme colour.
 *
 * The body's brand text does not need this: those nodes carry suppressHydrationWarning, so
 * React leaves the script's work alone. Only the head is contested, hence the observer.
 */
export default function BrandMeta() {
  const pathname = usePathname();
  const tenant = useTenant();

  useEffect(() => {

    const setMeta = (name: string, value: string) => {
      const el = document.querySelector(`meta[name="${name}"]`);
      if (el && el.getAttribute('content') !== value) el.setAttribute('content', value);
    };

    const apply = () => {
      if (document.title !== tenant.appName) document.title = tenant.appName;
      setMeta('theme-color', tenant.themeColor);
      setMeta('apple-mobile-web-app-title', tenant.appName);
    };

    apply();

    // React rewrites these tags whenever it re-renders metadata, which a plain useEffect
    // cannot catch. Every write above is skipped when the value already matches, so the
    // observer reacting to its own mutations settles immediately instead of looping.
    const observer = new MutationObserver(apply);
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['content'],
    });
    return () => observer.disconnect();
  }, [pathname, tenant]);

  return null;
}
