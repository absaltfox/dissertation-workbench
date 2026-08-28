import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestRateLimiter, mapWithConcurrency } from '../src/sync.js';

test('per-rule request limiter serializes callers and enforces the window', async () => {
  let currentTime = 0;
  const waits = [];
  const acquire = createRequestRateLimiter(2, {
    windowMs: 60_000,
    now: () => currentTime,
    wait: async (delayMs) => {
      waits.push(delayMs);
      currentTime += delayMs;
    },
  });
  await Promise.all([acquire(), acquire(), acquire()]);
  assert.deepEqual(waits, [60_000]);
});

test('per-rule request limiter carries its window across worker instances', async () => {
  let currentTime = 0;
  let durableTimestamps = [];
  const waits = [];
  const options = {
    windowMs: 60_000,
    now: () => currentTime,
    wait: async (delayMs) => {
      waits.push(delayMs);
      currentTime += delayMs;
    },
    loadTimestamps: async () => durableTimestamps,
    saveTimestamps: async (timestamps) => { durableTimestamps = [...timestamps]; },
  };
  const firstWorker = createRequestRateLimiter(2, options);
  await firstWorker();
  await firstWorker();
  const continuationWorker = createRequestRateLimiter(2, options);
  await continuationWorker();
  assert.deepEqual(waits, [60_000]);
});

test('per-rule document concurrency never exceeds the configured bound', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results.map((result) => result.value), [2, 4, 6, 8, 10]);
});
