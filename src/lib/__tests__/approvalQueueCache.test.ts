import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTtlCache, pastQueueKey, liveQueueKey, APPROVAL_QUEUE_TTL_MS } from '../approvalQueueCache';

const fakeFetcher = () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return { n: calls }; };
  return { fetcher, calls: () => calls };
};

test('ttl cache: the same key within the TTL is fetched once and shares the in-flight promise', async () => {
  let now = 1_000;
  const cache = createTtlCache({ ttlMs: 60_000, now: () => now });
  const f = fakeFetcher();
  const [a, b] = await Promise.all([cache.get('k', f.fetcher), cache.get('k', f.fetcher)]);
  assert.equal(f.calls(), 1);
  assert.deepEqual(a, { n: 1 });
  assert.equal(a, b);                              // literally the same resolved object
  now += 59_999;
  assert.deepEqual(await cache.get('k', f.fetcher), { n: 1 });
  assert.equal(f.calls(), 1);
  now += 2;                                        // past the TTL
  assert.deepEqual(await cache.get('k', f.fetcher), { n: 2 });
  assert.equal(f.calls(), 2);
});

test('ttl cache: different keys are independent', async () => {
  const cache = createTtlCache({ ttlMs: 60_000, now: () => 0 });
  const f = fakeFetcher();
  await cache.get('a', f.fetcher);
  await cache.get('b', f.fetcher);
  assert.equal(f.calls(), 2);
  assert.equal(cache.size(), 2);
});

test('ttl cache: bypass refetches and replaces the entry; invalidate drops everything (or a prefix)', async () => {
  const cache = createTtlCache({ ttlMs: 60_000, now: () => 0 });
  const f = fakeFetcher();
  await cache.get('past|v|c|1', f.fetcher);
  assert.deepEqual(await cache.get('past|v|c|1', f.fetcher, { bypass: true }), { n: 2 });
  assert.deepEqual(await cache.get('past|v|c|1', f.fetcher), { n: 2 });   // the bypass result is what is cached now
  await cache.get('live|v|c', f.fetcher);
  assert.equal(cache.size(), 2);
  cache.invalidate('past|');
  assert.equal(cache.size(), 1);
  cache.invalidate();
  assert.equal(cache.size(), 0);
  await cache.get('past|v|c|1', f.fetcher);
  assert.equal(f.calls(), 4);
});

test('ttl cache: a rejected fetch is not kept, so the next call retries', async () => {
  const cache = createTtlCache({ ttlMs: 60_000, now: () => 0 });
  let calls = 0;
  const flaky = async () => { calls += 1; if (calls === 1) throw new Error('boom'); return 'ok'; };
  await assert.rejects(cache.get('k', flaky));
  assert.equal(cache.size(), 0);
  assert.equal(await cache.get('k', flaky), 'ok');
  assert.equal(calls, 2);
});

test('queue keys: one per viewer + company (+ window), never colliding across the two builders', () => {
  assert.equal(APPROVAL_QUEUE_TTL_MS, 60_000);
  assert.notEqual(pastQueueKey('V1', 'Co', 1), pastQueueKey('V1', 'Co', 6));
  assert.notEqual(pastQueueKey('V1', 'Co', 1), pastQueueKey('V2', 'Co', 1));
  assert.notEqual(liveQueueKey('V1', 'Co'), pastQueueKey('V1', 'Co', 1));
  assert.ok(pastQueueKey('V1', 'Co', 6).startsWith('past|'));
  assert.ok(liveQueueKey('V1', 'Co').startsWith('live|'));
});
