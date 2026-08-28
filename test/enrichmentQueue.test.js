// H-03 / H-05: the enrichment work queue and the batched sync lookups.
//
// The queue's SQL predicate (enrichmentPolicySatisfiedSql) is a second
// implementation of hasCachedEnrichmentMetric(). If the two ever disagree the
// full_text_only and pdf_cache rules would differ about what is still
// outstanding, so the first test replays a matrix of stored metric rows through
// both and asserts they answer identically for every content mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tempDir;
let db;
let hasCachedEnrichmentMetric;
let filterSyncItemsForMode;

const CONTENT_MODES = ['metadata_only', 'full_text_only', 'pdf_cache', 'pdf_stream', 'not_a_mode'];
const CONTENT_FALLBACKS = [null, 'fail_document', 'full_text'];

// Every combination that any branch of either implementation can distinguish.
const METRIC_ROWS = [
  {},
  { pdf_path: '/cache/doc.pdf' },
  { pdf_path: '' },
  { word_source: 'dspace_full_text', word_count: 80_000, page_count: 250 },
  { word_source: 'dspace_full_text', word_count: 0, page_count: 250 },
  { word_source: 'dspace_full_text', word_count: 80_000, page_count: 0 },
  { word_source: 'dspace_full_text', word_count: 80_000, page_count: 250, pdf_path: '/cache/doc.pdf' },
  { word_source: 'degraded_pdf_text', word_count: 80_000, page_count: 250 },
  { content_source: 'streamed_pdf', content_checksum: 'sha256:abc', word_count: 900, page_count: 12 },
  { content_source: 'streamed_pdf', content_checksum: '', word_count: 900, page_count: 12 },
  { content_source: 'streamed_pdf', content_checksum: 'sha256:abc', word_count: 0, page_count: 12 },
  { content_source: 'cached_pdf', content_checksum: 'sha256:abc', word_count: 900, page_count: 12 },
  {
    content_source: 'streamed_pdf', content_checksum: 'sha256:abc', word_count: 900,
    page_count: 12, word_source: 'dspace_full_text',
  },
  { word_source: 'dspace_full_text', word_count: null, page_count: null },
  // The rows that separate "the fallback branch wins outright" from "the fallback
  // branch is OR-ed with the mode rule": DSpace full text that does not satisfy the
  // word/page counts, over a document whose mode rule is otherwise satisfied.
  { word_source: 'dspace_full_text', word_count: 0, page_count: 0, pdf_path: '/cache/doc.pdf' },
  {
    word_source: 'dspace_full_text', word_count: 0, page_count: 0,
    content_source: 'streamed_pdf', content_checksum: 'sha256:abc',
  },
];

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-enrich-queue-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');
  process.env.NODE_ENV = 'test';
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  ({ hasCachedEnrichmentMetric, filterSyncItemsForMode } = await import('../src/sync.js'));
  await db.ensureStorage();
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('the queue SQL and hasCachedEnrichmentMetric agree for every content mode', async () => {
  const client = await db.getDb();
  const docIds = METRIC_ROWS.map((_, index) => `equiv-${index}`);
  // Written column by column rather than through saveFileMetric so the fixture can
  // pin down empty strings and NULLs, which is exactly where the two forms could part.
  for (const [index, row] of METRIC_ROWS.entries()) {
    await client.execute({
      sql: `
        INSERT INTO file_metrics (
          doc_id, pdf_path, word_count, page_count, word_source,
          content_source, content_checksum, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        docIds[index],
        row.pdf_path ?? null,
        row.word_count ?? null,
        row.page_count ?? null,
        row.word_source ?? null,
        row.content_source ?? null,
        row.content_checksum ?? null,
        'fixture',
        new Date().toISOString(),
      ],
    });
  }

  let compared = 0;
  for (const contentMode of CONTENT_MODES) {
    for (const contentFallback of CONTENT_FALLBACKS) {
      const expression = db.enrichmentPolicySatisfiedSql(contentMode, contentFallback, 'fm');
      const result = await client.execute({
        sql: `SELECT fm.doc_id, ${expression} AS satisfied FROM file_metrics fm WHERE fm.doc_id LIKE 'equiv-%'`,
        args: [],
      });
      const sqlByDocId = new Map(result.rows.map((row) => [String(row.doc_id), Number(row.satisfied) === 1]));
      for (const [index, docId] of docIds.entries()) {
        const stored = await db.loadStoredFileMetric(docId);
        const inJs = hasCachedEnrichmentMetric(stored, contentMode, contentFallback);
        assert.equal(
          sqlByDocId.get(docId),
          inJs,
          `row ${index} (${JSON.stringify(METRIC_ROWS[index])}) disagreed for `
            + `${contentMode}/${contentFallback}: sql=${sqlByDocId.get(docId)} js=${inJs}`
        );
        compared += 1;
      }
    }
  }
  assert.equal(compared, CONTENT_MODES.length * CONTENT_FALLBACKS.length * METRIC_ROWS.length);
});

test('a document with no file_metrics row at all is outstanding, never satisfied', async () => {
  const syncKey = 'queue-nulls';
  await db.saveDocumentMetadata({ id: 'queue-null-1', title: 'No metric row' }, { syncKey });
  for (const contentMode of CONTENT_MODES) {
    for (const contentFallback of CONTENT_FALLBACKS) {
      const pending = await db.listDocumentsPendingEnrichment({
        syncKey, contentMode, contentFallback, limit: 10,
      });
      assert.deepEqual(
        pending.map((entry) => entry.docId),
        ['queue-null-1'],
        `${contentMode}/${contentFallback} lost a document that has no stored metric`
      );
      assert.equal(hasCachedEnrichmentMetric(null, contentMode, contentFallback), false);
    }
  }
});

test('the queue is scoped, ordered, cursored and drained by durable attempts', async () => {
  const syncKey = 'queue-scope';
  const otherKey = 'queue-other';
  for (let i = 0; i < 6; i += 1) {
    await db.saveDocumentMetadata({ id: `q-${String(i).padStart(2, '0')}`, title: `Doc ${i}` }, { syncKey });
  }
  await db.saveDocumentMetadata({ id: 'q-99', title: 'Other rule' }, { syncKey: otherKey });

  const firstPage = await db.listDocumentsPendingEnrichment({
    syncKey, contentMode: 'full_text_only', limit: 3,
  });
  assert.deepEqual(firstPage.map((entry) => entry.docId), ['q-00', 'q-01', 'q-02']);
  assert.equal(firstPage[0].metadata.title, 'Doc 0');

  const cursored = await db.listDocumentsPendingEnrichment({
    syncKey, contentMode: 'full_text_only', afterDocId: 'q-02', limit: 3,
  });
  assert.deepEqual(cursored.map((entry) => entry.docId), ['q-03', 'q-04', 'q-05']);

  // Documents that already satisfy the policy leave the queue; documents that were
  // attempted during this chain leave it too, even though they are still unenriched.
  await db.saveFileMetric('q-00', {
    status: 'full_text', wordSource: 'dspace_full_text', wordCount: 1000, pageCount: 10,
  });
  const chainStart = new Date().toISOString();
  await db.markEnrichmentAttempts(['q-01', 'q-02'], new Date(Date.now() + 1000).toISOString());
  const remaining = await db.listDocumentsPendingEnrichment({
    syncKey, contentMode: 'full_text_only', attemptedBefore: chainStart, limit: 10,
  });
  assert.deepEqual(remaining.map((entry) => entry.docId), ['q-03', 'q-04', 'q-05']);

  // A later chain retries what the earlier one failed to enrich.
  const laterChain = await db.listDocumentsPendingEnrichment({
    syncKey, contentMode: 'full_text_only', attemptedBefore: new Date(Date.now() + 60_000).toISOString(), limit: 10,
  });
  assert.deepEqual(laterChain.map((entry) => entry.docId), ['q-01', 'q-02', 'q-03', 'q-04', 'q-05']);

  const attempts = await db.loadEnrichmentAttempts(['q-01', 'q-02', 'q-03']);
  assert.equal(attempts.size, 2);
  assert.equal(attempts.has('q-03'), false);
});

test('documentsExist answers a whole page in one shot', async () => {
  await db.saveDocumentMetadata({ id: 'exists-a' }, { syncKey: 'exists-key' });
  await db.saveDocumentMetadata({ id: 'exists-b' }, { syncKey: 'exists-key' });
  const found = await db.documentsExist(['exists-a', 'missing-a', 'exists-b', '', null, 'exists-a']);
  assert.deepEqual([...found].sort(), ['exists-a', 'exists-b']);
  assert.equal((await db.documentsExist([])).size, 0);
});

test('loadStoredFileMetrics returns the same rows loadStoredFileMetric does', async () => {
  await db.saveFileMetric('batch-metric-1', { status: 'full_text', wordCount: 12, pageCount: 3 });
  await db.saveFileMetric('batch-metric-2', { status: 'not_found', error: 'nope' });
  const batched = await db.loadStoredFileMetrics(['batch-metric-1', 'batch-metric-2', 'batch-metric-absent']);
  assert.equal(batched.size, 2);
  for (const docId of ['batch-metric-1', 'batch-metric-2']) {
    assert.deepEqual({ ...batched.get(docId) }, { ...await db.loadStoredFileMetric(docId) });
  }
});

test('the default sync-mode filter batches existence checks into one query per page', async () => {
  const client = await db.getDb();
  const originalExecute = client.execute.bind(client);
  const statements = [];
  client.execute = async (statement, ...rest) => {
    statements.push(typeof statement === 'string' ? statement : statement.sql);
    return originalExecute(statement, ...rest);
  };
  try {
    const items = Array.from({ length: 100 }, (_, index) => ({ doc: { id: `page-${index}` } }));
    await db.saveDocumentMetadataBatch(items.slice(0, 40).map((item) => ({ ...item, syncKey: 'page-key' })));
    statements.length = 0;
    const filtered = await filterSyncItemsForMode(items, 'sync_differences');
    assert.equal(filtered.skipped, 40);
    assert.equal(filtered.items.length, 60);
    const selects = statements.filter((sql) => /FROM documents/i.test(sql));
    assert.equal(selects.length, 1, `expected one SELECT for 100 records, saw ${selects.length}`);
  } finally {
    client.execute = originalExecute;
  }
});
