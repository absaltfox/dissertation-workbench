import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Item 1 (citation query optimization): the admin page polls /api/admin/jobs every
// 5 s, and getCatalogueLookupStats() used to recompute the expensive unscoped
// pending count on every poll. The pending count is now memoized with a TTL.

let tempDir;
let db;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-stats-cache-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  await db.ensureStorage();
  await db.saveCitations('1.0100001', ['Smith, J. (1990). Cache test one. City: Press.'], (t) => `h-${t}`);
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

// Counts executed statements that evaluate the pending predicate.
async function countPendingStatements(fn) {
  const client = await db.getDb();
  const original = client.execute.bind(client);
  let pendingStatements = 0;
  client.execute = (stmt, ...rest) => {
    const sql = typeof stmt === 'string' ? stmt : stmt.sql;
    if (/FROM citations c\b/.test(sql) && /NOT EXISTS \(SELECT 1 FROM catalogue_lookups/.test(sql)) pendingStatements += 1;
    return original(stmt, ...rest);
  };
  try {
    await fn();
  } finally {
    client.execute = original;
  }
  return pendingStatements;
}

test('getCatalogueLookupStats reuses the pending count within the TTL', async () => {
  db.clearCatalogueLookupStatsCache();
  let first;
  let second;
  const statements = await countPendingStatements(async () => {
    first = await db.getCatalogueLookupStats();
    second = await db.getCatalogueLookupStats();
  });
  assert.equal(statements, 1, 'the unscoped pending count must be computed once for two polls');
  assert.equal(first.pending, 1);
  assert.deepEqual(second, first);
});

test('clearCatalogueLookupStatsCache forces a recompute that sees new pending work', async () => {
  await db.getCatalogueLookupStats();
  await db.saveCitations('1.0100002', ['Jones, K. (1991). Cache test two. City: Press.'], (t) => `h-${t}`);
  assert.equal((await db.getCatalogueLookupStats()).pending, 1, 'still memoized within the TTL');
  db.clearCatalogueLookupStatsCache();
  assert.equal((await db.getCatalogueLookupStats()).pending, 2);
});

test('the lookup counts stay live; only pending is memoized', async () => {
  db.clearCatalogueLookupStatsCache();
  await db.getCatalogueLookupStats();
  const [pending] = await db.listPendingLookups(1);
  await db.saveCatalogueLookup(pending.id, { hits: 3, queryAuthor: 'A', queryTitle: 'T', bibId: 'b' });
  const stats = await db.getCatalogueLookupStats();
  assert.equal(stats.found, 1);
  assert.equal(stats.total, 1);
});

test('a finished lookup run invalidates the memo', async () => {
  const { runPendingCatalogueLookups } = await import('../src/catalogue.js');
  db.clearCatalogueLookupStatsCache();
  assert.equal((await db.getCatalogueLookupStats()).pending, 1);
  await runPendingCatalogueLookups({
    pageSize: 10,
    isYazAvailable: async () => true,
    lookupBatch: async (texts) => texts.map(() => ({ hits: 0, found: false, author: 'x', title: 'y' })),
  });
  assert.equal((await db.getCatalogueLookupStats()).pending, 0);
});
