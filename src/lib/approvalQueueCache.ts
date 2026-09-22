// A tiny promise-keyed TTL cache for the two approval-queue builders the person panel calls
// (getPastAttendanceApprovalList / getCheckinApprovalList). Opening a few panels in a row, or
// paging months, must not re-run those builders every time: the in-flight promise is stored
// as soon as a fetch starts, so concurrent callers share ONE request, and the result stays
// good for the TTL. Pure — the fetcher is passed in — so the behaviour is unit-tested.
//
// Any approval invalidates the whole cache (the queues have changed), and the panel's
// post-approve refetch also passes `bypass` so it can never be served a stale entry.

export interface TtlCache {
  get<T>(key: string, fetcher: () => Promise<T>, opts?: { bypass?: boolean }): Promise<T>;
  /** Drop every entry, or only those whose key starts with `prefix`. */
  invalidate(prefix?: string): void;
  size(): number;
}

interface Entry { promise: Promise<unknown>; expiresAt: number }

export function createTtlCache(opts: { ttlMs: number; now?: () => number }): TtlCache {
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();
  return {
    get<T>(key: string, fetcher: () => Promise<T>, o?: { bypass?: boolean }): Promise<T> {
      const hit = entries.get(key);
      if (!o?.bypass && hit && hit.expiresAt > now()) return hit.promise as Promise<T>;
      const entry: Entry = { promise: Promise.resolve(), expiresAt: now() + opts.ttlMs };
      entry.promise = fetcher().catch(err => {
        // A failed fetch must not be served for the next TTL — drop it (only if it is still ours).
        if (entries.get(key) === entry) entries.delete(key);
        throw err;
      });
      entries.set(key, entry);
      return entry.promise as Promise<T>;
    },
    invalidate(prefix?: string) {
      if (prefix == null) { entries.clear(); return; }
      for (const k of [...entries.keys()]) if (k.startsWith(prefix)) entries.delete(k);
    },
    size: () => entries.size,
  };
}

export const APPROVAL_QUEUE_TTL_MS = 60_000;

// Module-level instance shared by every panel on the page.
export const approvalQueueCache = createTtlCache({ ttlMs: APPROVAL_QUEUE_TTL_MS });

export const pastQueueKey = (viewerEpf: string, company: string, monthsBack: number) =>
  `past|${viewerEpf}|${company}|${monthsBack}`;
export const liveQueueKey = (viewerEpf: string, company: string) =>
  `live|${viewerEpf}|${company}`;
