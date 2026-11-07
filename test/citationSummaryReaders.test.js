import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Stage C: the readers use citation_doc_counts / document_citation_counts when
// the readiness flag is set and keep the live-aggregate SQL as the fallback. Both
// paths must return exactly the same rows, and the summary path must not read the
// whole link table.

const SYNC_KEY = 'summary-readers';
let tempDir;
let db;
let client;

const plain = (rows) => rows.map((r) => ({ ...r }));

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

async function withReady(value, fn) {
  const before = db.isCitationCountsReady();
  db.__setCitationCountsReadyForTesting(value);
  try {
    return await fn();
  } finally {
    db.__setCitationCountsReadyForTesting(before);
  }
}

async function planOf(fn) {
  const seen = [];
  const original = client.execute.bind(client);
  client.execute = (stmt, ...rest) => { if (typeof stmt === 'object') seen.push(stmt); return original(stmt, ...rest); };
  try {
    await fn();
  } finally {
    client.execute = original;
  }
  const details = [];
  for (const stmt of seen.filter((s) => /citation_doc_counts|document_citation_counts|document_citations/.test(s.sql) && /^\s*(SELECT|WITH)/i.test(s.sql))) {
    const plan = (await client.execute({ sql: `EXPLAIN QUERY PLAN ${stmt.sql}`, args: stmt.args })).rows;
    details.push(...plan.map((r) => String(r.detail)));
  }
  return details;
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-summary-readers-'));
  Object.assign(process.env, {
    SKIP_LOCAL_ENV: '1', NODE_ENV: 'test', APP_DATA_DIR: tempDir,
    SQLITE_PATH: path.join(tempDir, 'metrics.sqlite'),
    PDF_CACHE_DIR: path.join(tempDir, 'pdf'), FULL_TEXT_CACHE_DIR: path.join(tempDir, 'ft'),
  });
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  await db.ensureStorage();
  client = await db.getDb();

  await db.saveDocumentMetadataBatch(Array.from({ length: 60 }, (_, i) => ({
    doc: {
      id: `sr-${String(i).padStart(3, '0')}`, title: `Reader dissertation ${i % 5} ${i}`, author: `Author ${i}`,
      year: 2000 + (i % 8), degree: i % 2 ? 'PhD' : 'EdD', program: 'Education',
      supervisors: ['Shared Supervisor'], abstract: `Abstract ${i}`,
    },
    syncKey: SYNC_KEY,
  })));
  const now = new Date().toISOString();
  const rand = prng(11);
  const citationIds = [];
  for (let c = 0; c < 120; c += 1) {
    const res = await client.execute({
      sql: 'INSERT INTO citations (citation_hash, citation_text, created_at) VALUES (?, ?, ?)',
      args: [`sr-h-${c}`, `Reader citation ${c % 9} ${c}`, now],
    });
    citationIds.push(Number(res.lastInsertRowid));
  }
  // Heavy tail: a few documents cite many works, many cite few, some none.
  for (let i = 0; i < 60; i += 1) {
    if (i % 7 === 3) continue;
    const size = i % 11 === 0 ? 80 : 1 + Math.floor(rand() * 12);
    const picks = new Set();
    while (picks.size < size) picks.add(Math.floor((rand() ** 2) * 120));
    for (const p of picks) {
      await client.execute({
        sql: 'INSERT INTO document_citations (doc_id, citation_id, updated_at) VALUES (?, ?, ?)',
        args: [`sr-${String(i).padStart(3, '0')}`, citationIds[p], now],
      });
    }
  }
  for (const [text, hits] of [['Reader citation 0 0', 2], ['Reader citation 1 1', 0]]) {
    const row = (await client.execute({ sql: 'SELECT id FROM citations WHERE citation_text = ?', args: [text] })).rows[0];
    await db.saveCatalogueLookup(Number(row.id), { hits, queryAuthor: 'A', queryTitle: 'T', bibId: hits ? 'b' : null });
  }
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('summary tables are in step with the seeded links', async () => {
  assert.deepEqual(await db.reconcileCitationCounts(), { citationDrift: 0, docDrift: 0 });
});

test('getTopCitedWorks returns identical rows from the summary table and the live aggregate', async () => {
  for (const limit of [1, 7, 50, 200]) {
    const live = plain(await withReady(false, () => db.getTopCitedWorks(limit)));
    const summary = plain(await withReady(true, () => db.getTopCitedWorks(limit)));
    assert.ok(live.length > 0);
    assert.deepEqual(summary, live, `limit ${limit}`);
  }
});

test('getTopCitedWorks on the summary path reads the shared-citation index, not the link table', async () => {
  const details = await withReady(true, () => planOf(() => db.getTopCitedWorks(50)));
  assert.ok(details.some((d) => /idx_citation_doc_counts_shared/.test(d)), details.join(' | '));
  assert.ok(!details.some((d) => /document_citations/.test(d)), details.join(' | '));
});

test('co-occurrence on the summary path equals the live path, bounded and unbounded', async () => {
  const all = Array.from({ length: 60 }, (_, i) => `sr-${String(i).padStart(3, '0')}`);
  const bounds = [null, all, all.filter((_, i) => i % 2), all.slice(5, 20), ['sr-000', 'no-such-doc'], ['sr-001']];
  for (const ids of bounds) {
    for (const limit of [100, 9]) {
      const live = plain(await withReady(false, () => db.getCitationCooccurrence(limit, ids)));
      const summary = plain(await withReady(true, () => db.getCitationCooccurrence(limit, ids)));
      assert.deepEqual(summary, live, `bound ${ids ? ids.length : 'null'} limit ${limit}`);
    }
  }
  assert.ok((await db.getCitationCooccurrence(100, null)).length > 0, 'fixture must produce edges');
  assert.deepEqual(await withReady(true, () => db.getCitationCooccurrence(100, [])), []);
});

test('co-occurrence on the summary path drives from the shared-citation index', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `sr-${String(i).padStart(3, '0')}`);
  const details = await withReady(true, () => planOf(() => db.getCitationCooccurrence(100, ids)));
  assert.ok(details.some((d) => /citation_doc_counts/.test(d) && /idx_citation_doc_counts_shared/.test(d)), details.join(' | '));
});

test('citation document list and cached page counts match between summary and live paths', async () => {
  for (const sortKey of ['citationCount', 'title', 'year']) {
    for (const sortDir of ['asc', 'desc']) {
      const args = { syncKey: SYNC_KEY, sortKey, sortDir, limit: 1000 };
      const live = await withReady(false, () => db.queryCitationDocumentPage(args));
      const summary = await withReady(true, () => db.queryCitationDocumentPage(args));
      assert.deepEqual(summary, live, `citations page ${sortKey} ${sortDir}`);
    }
  }
  for (const sortDir of ['asc', 'desc']) {
    const args = { syncKey: SYNC_KEY, sortKey: 'citationCount', sortDir, limit: 1000 };
    const live = await withReady(false, async () => (await db.queryCachedDocumentPage(args)).documents.map((d) => [d.id, d.citationCount]));
    const summary = await withReady(true, async () => (await db.queryCachedDocumentPage(args)).documents.map((d) => [d.id, d.citationCount]));
    assert.deepEqual(summary, live, `cached page citationCount ${sortDir}`);
  }
});

test('the citationCount sort on the summary path does not aggregate the link table', async () => {
  const details = await withReady(true, () => planOf(async () => {
    await db.queryCitationDocumentPage({ syncKey: SYNC_KEY, sortKey: 'citationCount', limit: 50 });
    await db.queryCachedDocumentPage({ syncKey: SYNC_KEY, sortKey: 'citationCount', limit: 50 });
  }));
  assert.ok(details.length > 0);
  assert.ok(!details.some((d) => /MATERIALIZE|SCAN document_citations/.test(d)), details.join(' | '));
});

test('applyCitationCountsToDocuments matches between summary and live paths', async () => {
  const mk = () => Array.from({ length: 70 }, (_, i) => ({ id: i < 60 ? `sr-${String(i).padStart(3, '0')}` : `missing-${i}` }));
  const live = await withReady(false, () => db.applyCitationCountsToDocuments(mk()));
  const summary = await withReady(true, () => db.applyCitationCountsToDocuments(mk()));
  assert.deepEqual(summary, live);
  assert.ok(summary.some((d) => d.citationCount > 0) && summary.some((d) => d.citationCount === 0));
});

test('readers fall back to the live SQL when the triggers are missing', async () => {
  await client.executeMultiple(`
    DROP TRIGGER trg_document_citations_count_ins;
    DROP TRIGGER trg_document_citations_count_del;
  `);
  try {
    assert.equal(await db.initCitationCountsReadiness(), false);
    // Writes now bypass the summaries, which therefore drift; readers must not use them.
    await client.execute("DELETE FROM document_citations WHERE doc_id = 'sr-000'");
    const live = plain(await withReady(false, () => db.getTopCitedWorks(50)));
    const viaFlag = plain(await db.getTopCitedWorks(50));
    assert.deepEqual(viaFlag, live);
    const fresh = (await client.execute(`
      SELECT c.id FROM citations c JOIN document_citations dc ON dc.citation_id = c.id
      GROUP BY c.id HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC, c.citation_text LIMIT 50`)).rows.map((r) => Number(r.id));
    assert.deepEqual(viaFlag.map((r) => Number(r.id)), fresh, 'fallback reflects the live link table');
    const pages = await db.queryCitationDocumentPage({ syncKey: SYNC_KEY, limit: 1000 });
    const first = pages.documents.find((d) => d.id === 'sr-000');
    assert.equal(first.citationCount, 0, 'count comes from the live link table');
    assert.ok((await db.reconcileCitationCounts()).docDrift > 0, 'summaries really drifted');
  } finally {
    await db.ensureSchemaWithRetry(client);
    await db.initCitationCountsReadiness();
  }
  assert.equal(db.isCitationCountsReady(), true);
  assert.deepEqual(await db.reconcileCitationCounts(), { citationDrift: 0, docDrift: 0 }, 'the migration rebuilt the summaries');
});
