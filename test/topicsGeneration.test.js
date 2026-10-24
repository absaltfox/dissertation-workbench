import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The BERTopic worker swaps topics in the database and bumps `topics_generation`
// in the same transaction; the web process drops its slice cache when it sees a
// new generation (memoised so it is not a DB read per request).

let syncTopicsGeneration;
let resetTopicsGenerationMemo;
let TOPICS_GENERATION_MEMO_MS;

test.before(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-topics-generation-'));
  process.env.APP_DATA_DIR = dir;
  process.env.SQLITE_PATH = path.join(dir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;
  ({ syncTopicsGeneration, resetTopicsGenerationMemo, TOPICS_GENERATION_MEMO_MS } = await import('../src/routes/metricsRoutes.js'));
});

function fakeCache() {
  return { clears: 0, clear() { this.clears += 1; } };
}

test('clears the cache only when the topics generation changes, reading at most once per memo window', async () => {
  const cache = fakeCache();
  let generation = 'g1';
  let reads = 0;
  let clock = 1_000_000;
  const opts = { read: async () => { reads += 1; return generation; }, now: () => clock };

  await syncTopicsGeneration(cache, opts);
  assert.equal(cache.clears, 0, 'first observation is only a baseline');

  generation = 'g2'; // worker swapped, but the memo has not expired
  await syncTopicsGeneration(cache, opts);
  await syncTopicsGeneration(cache, opts);
  assert.equal(reads, 1);
  assert.equal(cache.clears, 0);

  clock += TOPICS_GENERATION_MEMO_MS + 1;
  await syncTopicsGeneration(cache, opts);
  assert.equal(reads, 2);
  assert.equal(cache.clears, 1);

  clock += TOPICS_GENERATION_MEMO_MS + 1;
  await syncTopicsGeneration(cache, opts);
  assert.equal(cache.clears, 1, 'unchanged generation does not clear');
});

test('a generation appearing for the first time (null to value) clears; read errors do not', async () => {
  const cache = fakeCache();
  let value = null;
  let fail = false;
  let clock = 5_000_000;
  const opts = { read: async () => { if (fail) throw new Error('turso down'); return value; }, now: () => clock };

  await syncTopicsGeneration(cache, opts);
  value = 'first-run';
  fail = true;
  clock += TOPICS_GENERATION_MEMO_MS + 1;
  await syncTopicsGeneration(cache, opts);
  assert.equal(cache.clears, 0, 'a failed read keeps the cache');

  fail = false;
  clock += TOPICS_GENERATION_MEMO_MS + 1;
  await syncTopicsGeneration(cache, opts);
  assert.equal(cache.clears, 1);
});

test('concurrent callers share one in-flight read', async () => {
  const cache = fakeCache();
  resetTopicsGenerationMemo(cache);
  let reads = 0;
  const opts = { read: async () => { reads += 1; return 'g'; }, now: () => 9_000_000 };
  await Promise.all([syncTopicsGeneration(cache, opts), syncTopicsGeneration(cache, opts), syncTopicsGeneration(cache, opts)]);
  assert.equal(reads, 1);
});

test('the default reader reads the topics_generation setting from the database', async () => {
  const db = await import('../src/db.js');
  await db.ensureStorage();
  const cache = fakeCache();
  await syncTopicsGeneration(cache, { now: () => 1 });
  await db.setSetting('topics_generation', '2026-10-23T00:00:00Z');
  await syncTopicsGeneration(cache, { now: () => 1 + TOPICS_GENERATION_MEMO_MS + 1 });
  assert.equal(cache.clears, 1);
  await db.closeDb();
});
