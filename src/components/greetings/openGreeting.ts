'use client';

// Opening a greeting is not a navigation.
//
// The card used to be reachable only through `?greeting=<docId>`, so the bell "opened" one by
// pushing /dashboard?greeting=<id>. That works from a cold start — a push tap loads the page
// with the param already on it — but it is the wrong mechanism for a tap inside a running app:
// the reader is usually already on /dashboard, the router treats the push as a same-page
// query change, and the card's effect keys off a param that may arrive before the auth store
// has an EPF to check it against. The tap did nothing and the greeting stayed unopened.
//
// So the bell says what it means: open THIS greeting, now, wherever we are. The URL param
// stays exactly as it was for the cold open; this is the direct path beside it. A DOM event
// rather than another store because there is no state here to keep — the card either hears it
// or was never mounted, and a missed one is not something to replay later.

const EVENT = 'pc:open-greeting';

/** Ask the mounted GreetingCard to open the greeting notification with this doc id. */
export function openGreeting(docId: string): void {
  if (typeof window === 'undefined' || !docId) return;
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: docId }));
}

/** Listen for open requests. Returns the unsubscribe, for a useEffect cleanup. */
export function onOpenGreeting(handler: (docId: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const fn = (e: Event) => {
    const id = (e as CustomEvent<string>).detail;
    if (typeof id === 'string' && id) handler(id);
  };
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
