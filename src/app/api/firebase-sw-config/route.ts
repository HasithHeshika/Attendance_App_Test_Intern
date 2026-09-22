import { NextResponse } from 'next/server';

/**
 * Serves the Firebase configuration as a JavaScript snippet so that
 * firebase-messaging-sw.js can consume it via importScripts('/api/firebase-sw-config').
 *
 * Service workers are static files that cannot access Next.js/webpack-processed
 * env vars, but they CAN importScripts from a dynamic API route that CAN read them.
 */
export async function GET() {
  const config = {
    apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY            ?? '',
    authDomain:        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN        ?? '',
    projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID         ?? '',
    storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET     ?? '',
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '',
    appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID             ?? '',
  };

  const js = `self.FIREBASE_SW_CONFIG = ${JSON.stringify(config)};`;

  return new NextResponse(js, {
    status: 200,
    headers: {
      'Content-Type':  'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store, no-cache',
    },
  });
}
