import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// getTopCitedWorks (GET /api/citations/top). The original joined every
// citations row (wide) to its links before grouping. The index-first form
// aggregates the narrow document_citations index first; the result must not
// change, including the citation_text tie-break on equal doc counts.

const ORIGINAL_SQL = `
    SELECT c.id, c.citation_text,
      COUNT(DISTINCT dc.doc_id) AS doc_count,
      cl.hits AS catalogue_hits,
      cl.bib_id AS catalogue_bib_id
    FROM citations c
    JOIN document_citations dc ON dc.citation_id = c.id
    LEFT JOIN catalogue_lookups cl ON cl.citation_id = c.id
    GROUP BY c.id
    HAVING doc_count > 1
    ORDER BY doc_count DESC, c.citation_text
    LIMIT ?`;

let tempDir;
let db;
let client;

async function seed(linksByCitation) {
  const now = new Date().toISOString();
  for (const [text, docs] of Object.entries(linksByCitation)) {
    const res = await client.execute({
      sql: 'INSERT INTO citations (citation_hash, citation_text, created_at) VALUES (?, ?, ?)',
      args: [`hash-${text}`, text, now],
    });
    for (const doc of docs) {
      await client.execute({
        sql: 'INSERT INTO document_citations (doc_id, citation_id, updated_at) VALUES (?, ?, ?)',
        args: [doc, Number(res.lastInsertRowid), now],
      });
    }
  }
}

const plain = (rows) => rows.map((r) => ({ ...r }));

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-top-cited-'));
  Object.assign(process.env, {
    SKIP_LOCAL_ENV: '1', NODE_ENV: 'test', APP_DATA_DIR: tempDir,
    SQLITE_PATH: path.join(tempDir, 'metrics.sqlite'),
    PDF_CACHE_DIR: path.join(tempDir, 'pdf'), FULL_TEXT_CACHE_DIR: path.join(tempDir, 'ft'),
  });
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  await db.ensureStorage();
  client = await db.getDb();
  await seed({
    'Zeta (2001) tie c': ['d1', 'd2'],
    'Alpha (2001) tie a': ['d1', 'd3'],
    'Mid (2001) tie b': ['d2', 'd3'],
    'Popular (1999)': ['d1', 'd2', 'd3', 'd4'],
    'Triple (2005)': ['d2', 'd3', 'd4'],
    'Single only (2010)': ['d1'],
    'Another single (2011)': ['d4'],
  });
  const ids = await client.execute("SELECT id FROM citations WHERE citation_text LIKE 'Popular%'");
  await db.saveCatalogueLookup(Number(ids.rows[0].id), { hits: 2, queryAuthor: 'P', queryTitle: 'Popular', bibId: 'bib-1' });
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('getTopCitedWorks returns the same ids, counts and order as the reference aggregate', async () => {
  for (const limit of [1, 3, 4, 50]) {
    const expected = plain((await client.execute({ sql: ORIGINAL_SQL, args: [limit] })).rows);
    const actual = plain(await db.getTopCitedWorks(limit));
    assert.deepEqual(actual, expected, `limit ${limit}`);
  }
  const all = await db.getTopCitedWorks(50);
  // Ties on doc_count 2 resolve by citation_text.
  assert.deepEqual(all.map((r) => r.citation_text), [
    'Popular (1999)', 'Triple (2005)', 'Alpha (2001) tie a', 'Mid (2001) tie b', 'Zeta (2001) tie c',
  ]);
  assert.equal(all[0].catalogue_hits, 2);
  assert.equal(all[0].catalogue_bib_id, 'bib-1');
  assert.equal(all[1].catalogue_hits, null);
});

test('getTopCitedWorks excludes single-document citations', async () => {
  const works = await db.getTopCitedWorks(50);
  assert.ok(!works.some((r) => /single/i.test(r.citation_text)));
  assert.ok(works.every((r) => Number(r.doc_count) > 1));
});

test('getTopCitedWorks reflects a re-extraction that drops a link', async () => {
  const triple = (await client.execute("SELECT id FROM citations WHERE citation_text LIKE 'Triple%'")).rows[0].id;
  await client.execute({ sql: 'DELETE FROM document_citations WHERE citation_id = ? AND doc_id IN (?, ?)', args: [triple, 'd3', 'd4'] });
  const works = await db.getTopCitedWorks(50);
  assert.ok(!works.some((r) => r.citation_text.startsWith('Triple')), 'now single-document');
  const expected = plain((await client.execute({ sql: ORIGINAL_SQL, args: [50] })).rows);
  assert.deepEqual(plain(works), expected);
});

test('getTopCitedWorks aggregates the narrow link index and never scans citations', async () => {
  const captured = [];
  const original = client.execute.bind(client);
  client.execute = (stmt, ...rest) => { captured.push(stmt); return original(stmt, ...rest); };
  try {
    await db.getTopCitedWorks(10);
  } finally {
    client.execute = original;
  }
  const stmt = captured.find((s) => /document_citations/.test(s.sql));
  assert.ok(stmt, 'expected a document_citations statement');
  const plan = (await client.execute({ sql: `EXPLAIN QUERY PLAN ${stmt.sql}`, args: stmt.args })).rows
    .map((r) => String(r.detail));
  assert.ok(!plan.some((d) => /^SCAN (c|citations)\b/.test(d)), `citations table scanned: ${plan.join(' | ')}`);
});
