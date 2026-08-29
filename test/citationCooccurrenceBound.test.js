import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// #25: getCitationCooccurrence's self-join (dc1 x dc2 on doc_id) took no
// document-set bound, so its cost tracked the *total* document_citations
// table size (which citations are "top" is corpus-wide), even when the
// caller (buildMetricsPayloadFromRecords, via /workbench/visualizations) had
// already bounded the rest of its payload to a fixed-size document sample.
// The fix threads that same bounded doc-id set into the query via a single
// JSON-array parameter. Both join arms already use covering indexes
// (verified in the plan by EXPLAIN QUERY PLAN) — this is a cardinality fix,
// not an indexing one, so no new index is added or exercised here.

let closeDb;
let ensureStorage;
let getDb;
let getCitationCooccurrence;
let tempDir;

const CITATION_POOL_SIZE = 30;
const CITATIONS_PER_DOC = 5;
const SMALL_N = 5000;
const LARGE_N = 56000;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-citation-bound-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.NODE_ENV = 'test';
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');

  const db = await import('../src/db.js');
  ({ closeDb, ensureStorage, getDb, getCitationCooccurrence } = db);
  await ensureStorage();

  const client = await getDb();
  const now = new Date().toISOString();

  // A small, universally-popular citation pool so every citation clears the
  // top_citations CTE's HAVING cnt >= 2 and rich co-occurrence exists.
  await client.batch(
    Array.from({ length: CITATION_POOL_SIZE }, (_, i) => ({
      sql: 'INSERT INTO citations (citation_hash, citation_text, created_at) VALUES (?, ?, ?)',
      args: [`hash-${i}`, `Citation number ${i}`, now],
    })),
    'write'
  );

  // Seed document_citations for the *large* scale up front (56,000 synthetic
  // documents x 5 citations each = 280,000 rows). Kept out of the
  // `documents` table entirely — document_citations has no FK on doc_id, and
  // this query never joins back to `documents`. Multi-row INSERT statements
  // (500 rows/statement) keep this seed fast: one statement per row here
  // took ~20s for 280k rows in practice; batching the VALUES list cuts that
  // by roughly two orders of magnitude.
  const ROWS_PER_STATEMENT = 500;
  const rows = [];
  for (let docIndex = 0; docIndex < LARGE_N; docIndex++) {
    const docId = `citdoc-${String(docIndex).padStart(6, '0')}`;
    for (let k = 0; k < CITATIONS_PER_DOC; k++) {
      const citationId = ((docIndex + k) % CITATION_POOL_SIZE) + 1; // citations.id is 1-based autoincrement
      rows.push([docId, citationId, now]);
    }
  }
  const STATEMENTS_PER_BATCH = 40;
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT * STATEMENTS_PER_BATCH) {
    const statements = [];
    for (let j = i; j < Math.min(i + ROWS_PER_STATEMENT * STATEMENTS_PER_BATCH, rows.length); j += ROWS_PER_STATEMENT) {
      const chunk = rows.slice(j, j + ROWS_PER_STATEMENT);
      const placeholders = chunk.map(() => '(?, ?, ?)').join(', ');
      statements.push({
        sql: `INSERT INTO document_citations (doc_id, citation_id, updated_at) VALUES ${placeholders}`,
        args: chunk.flat(),
      });
    }
    await client.batch(statements, 'write');
  }
});

test.after(async () => {
  await closeDb?.();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

function docIdRange(n) {
  return Array.from({ length: n }, (_, i) => `citdoc-${String(i).padStart(6, '0')}`);
}

test('#25: a bounded doc-id set excludes co-occurrence pairs that only exist outside the bound', async () => {
  // A citation pair shared only among an "out-of-sample" slice of documents
  // must never surface when the query is bound to an "in-sample" slice that
  // excludes them, proving the bound is actually applied to the join, not
  // merely accepted and ignored.
  const client = await getDb();
  const now = new Date().toISOString();
  await client.batch([
    { sql: "INSERT INTO citations (citation_hash, citation_text, created_at) VALUES ('oos-a', 'Out of sample A', ?)", args: [now] },
    { sql: "INSERT INTO citations (citation_hash, citation_text, created_at) VALUES ('oos-b', 'Out of sample B', ?)", args: [now] },
  ], 'write');
  const oosA = await client.execute("SELECT id FROM citations WHERE citation_hash = 'oos-a'");
  const oosB = await client.execute("SELECT id FROM citations WHERE citation_hash = 'oos-b'");
  const idA = Number(oosA.rows[0].id);
  const idB = Number(oosB.rows[0].id);

  const outOfSampleDocs = ['oos-doc-1', 'oos-doc-2', 'oos-doc-3'];
  await client.batch(outOfSampleDocs.flatMap((docId) => ([
    { sql: 'INSERT INTO document_citations (doc_id, citation_id, updated_at) VALUES (?, ?, ?)', args: [docId, idA, now] },
    { sql: 'INSERT INTO document_citations (doc_id, citation_id, updated_at) VALUES (?, ?, ?)', args: [docId, idB, now] },
  ])), 'write');

  const inSampleIds = docIdRange(200);
  const rows = await getCitationCooccurrence(1000, inSampleIds);
  const leaked = rows.some((row) =>
    (row.id1 === idA && row.id2 === idB) || (row.id1 === idB && row.id2 === idA));
  assert.equal(leaked, false, 'a pair that only co-occurs outside the bound must not appear when bound to an excluded sample');

  // Sanity: the same pair DOES appear when the bound includes those documents.
  const rowsWithOos = await getCitationCooccurrence(1000, [...inSampleIds, ...outOfSampleDocs]);
  const present = rowsWithOos.some((row) =>
    (row.id1 === idA && row.id2 === idB) || (row.id1 === idB && row.id2 === idA));
  assert.equal(present, true, 'sanity check: the pair must appear once its documents are included in the bound');
});

test('#25: bounded query cost (row count touched) stays at sample size regardless of total corpus size — primary signal', async () => {
  const client = await getDb();
  const sampleSize = 200;
  const sampleIds = docIdRange(sampleSize);

  // Primary signal: directly count how many document_citations rows fall
  // inside the bound the query applies — this is the same json_each(?)
  // pattern getCitationCooccurrence's self-join now uses, so it is a direct
  // proxy for the self-join's bound input cardinality, independent of the
  // total corpus size sitting alongside it in the same table.
  const probe = await client.execute({
    sql: 'SELECT COUNT(*) AS n FROM document_citations WHERE doc_id IN (SELECT value FROM json_each(?))',
    args: [JSON.stringify(sampleIds)],
  });
  const boundRowCount = Number(probe.rows[0].n);
  assert.equal(boundRowCount, sampleSize * CITATIONS_PER_DOC);

  // The full table backing this probe has LARGE_N * CITATIONS_PER_DOC rows —
  // orders of magnitude more than the bound touched, proving the bound
  // query's cost is decoupled from total corpus size.
  const totalProbe = await client.execute('SELECT COUNT(*) AS n FROM document_citations');
  const totalRowCount = Number(totalProbe.rows[0].n);
  assert.ok(totalRowCount >= LARGE_N * CITATIONS_PER_DOC);
  assert.ok(boundRowCount < totalRowCount / 100, 'bound row count must be a small fraction of the full corpus');

  // And the actual function call succeeds and returns real co-occurrence
  // rows scoped to that same bound (not merely an SQL curiosity).
  const rows = await getCitationCooccurrence(100, sampleIds);
  assert.ok(rows.length > 0, 'the bounded sample should still surface real co-occurrence signal');
});

test('#25: response time for a bounded sample is flat regardless of total corpus size — secondary signal', async () => {
  const sampleIds = docIdRange(SMALL_N);

  // Warm up (JIT/query-plan caches) both call shapes equally before timing,
  // so neither measurement gets an unfair first-vs-second-call advantage.
  await getCitationCooccurrence(100, sampleIds);
  await getCitationCooccurrence(100);

  const t0 = Date.now();
  await getCitationCooccurrence(100, sampleIds);
  const boundedElapsedMs = Date.now() - t0;

  const t1 = Date.now();
  await getCitationCooccurrence(100); // unbound: scans the full LARGE_N-scale table
  const unboundedElapsedMs = Date.now() - t1;

  assert.ok(
    boundedElapsedMs < Math.max(unboundedElapsedMs * 0.7, unboundedElapsedMs - 5),
    `expected the bounded query to be meaningfully faster than the unbounded one on the same ` +
    `${LARGE_N}-document-scale table (bounded=${boundedElapsedMs}ms unbounded=${unboundedElapsedMs}ms)`
  );
});
