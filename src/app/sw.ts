// Precache service worker, compiled by @serwist/next (replaces the old next-pwa
// generated public/sw.js). Registered manually from src/app/layout.tsx as /sw.js.
//
// This file targets the Web Worker / Service Worker global scope, so it is
// excluded from the app tsconfig (which uses the DOM lib) and transpiled by
// Serwist on its own.
import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    // Injection point for the precache manifest (default "self.__SW_MANIFEST").
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: defaultCache,
});

serwist.addEventListeners();
