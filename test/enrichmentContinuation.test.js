// H-03 (#16): enrichment continuation is O(1) per batch.
//
// Three things were flagged as never measured:
//   1. startContinuationJob's params_json stays the same size at continuation 20
//      as at continuation 1 — no growing skipPdfDocIds-style list (zero test
//      coverage before this file).
//   2. Draining several hundred pending documents in fixed-size batches costs the
//      same per batch regardless of how many batches came before.
//   3. The same, under a "sparse pending tail" corpus shape — most of the
//      documents the scan has to step over (by doc_id order, because
//      listDocumentsPendingEnrichment's `+d.sync_key` deliberately forces a PK
//      scan instead of an index lookup) belong to *other* sync keys, densely
//      packed between the cursor and the next document this rule still needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tempDir;
let db;
let runDocumentSync;
let getSyncKeyForOptions;
let startContinuationJob;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-enrich-cont-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');
  process.env.NODE_ENV = 'test';
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  ({ runDocumentSync, getSyncKeyForOptions } = await import('../src/sync.js'));
  ({ startContinuationJob } = await import('../src/services/importPdfJobRunner.js'));
  await db.ensureStorage();
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

function statementCounter(client) {
  const originalExecute = client.execute.bind(client);
  const originalBatch = client.batch.bind(client);
  const counter = { count: 0 };
  client.execute = async (...args) => {
    counter.count += 1;
    return originalExecute(...args);
  };
  client.batch = async (...args) => {
    counter.count += 1;
    return originalBatch(...args);
  };
  counter.restore = () => {
    client.execute = originalExecute;
    client.batch = originalBatch;
  };
  return counter;
}

// Statement *count* cannot tell a cheap indexed page apart from an expensive
// scan that happens to still be one statement (that is exactly what the
// sparse-pending-tail test's own comment concedes). This captures the EXPLAIN
// QUERY PLAN for every real listDocumentsPendingEnrichment SELECT (db.js
// ~2217) issued while it runs, by intercepting client.execute and running
// `EXPLAIN QUERY PLAN <the same SQL and args>` alongside the real call — so
// the plan is asserted against the exact statement the drain path issues,
// not a hand-copied lookalike.
const PENDING_ENRICHMENT_QUERY_RE = /FROM\s+documents\s+d\b[\s\S]*ORDER BY d\.doc_id/;
function explainCapturer(client) {
  const originalExecute = client.execute.bind(client);
  const captured = [];
  client.execute = async (arg) => {
    const sql = typeof arg === 'string' ? arg : arg.sql;
    if (PENDING_ENRICHMENT_QUERY_RE.test(sql)) {
      const args = typeof arg === 'string' ? [] : (arg.args || []);
      const plan = await originalExecute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args });
      captured.push({ sql, args, details: plan.rows.map((row) => String(row.detail)) });
    }
    return originalExecute(arg);
  };
  captured.restore = () => { client.execute = originalExecute; };
  return captured;
}

// --- 1. startContinuationJob: params_json size is constant across continuations ---

test('startContinuationJob keeps nextParams JSON size constant across many continuations', async () => {
  const rule = { id: 'rule-fixed', contentMode: 'full_text_only' };
  const fixedAttemptedBefore = '2024-01-01T00:00:00.000Z';
  let job = {
    id: 'job-0000',
    params: {
      mode: 'sync_missing_pdfs',
      scope: 'selected',
      ruleIds: [rule.id],
      autoContinuePdfBatches: true,
      rules: [rule],
    },
  };

  const sizes = [];
  const CONTINUATIONS = 25;
  for (let i = 1; i <= CONTINUATIONS; i += 1) {
    // Fixed-width cursor and job id per iteration: a real chain's cursor is a
    // doc id (bounded length) and its job id a bounded-format identifier, so
    // this does not itself introduce growth the production code doesn't have.
    const cursor = `1.08${String(i).padStart(5, '0')}`;
    const result = {
      ok: true,
      pdfBatchLimitReached: true,
      totalEnrichmentAttempted: 5,
      totalSaved: 5,
      rules: [{ ruleId: rule.id, pdfBatchLimitReached: true }],
      enrichmentAttemptedBefore: fixedAttemptedBefore,
      enrichmentCursors: { [rule.id]: cursor },
    };
    let nextParams = null;
    // eslint-disable-next-line no-await-in-loop
    await startContinuationJob(job, result, null, {
      createContinuationJob: async (payload) => {
        nextParams = payload.params;
        return { jobId: `job-${String(i).padStart(4, '0')}` };
      },
    });
    assert.ok(nextParams, `continuation ${i} did not schedule a next job`);
    sizes.push(JSON.stringify(nextParams).length);
    job = { id: `job-${String(i).padStart(4, '0')}`, params: nextParams };
  }

  assert.equal(
    sizes[sizes.length - 1], sizes[0],
    `params_json grew from ${sizes[0]} bytes at continuation 1 to ${sizes[sizes.length - 1]} bytes at continuation ${CONTINUATIONS}`
  );
  assert.ok(
    sizes.every((size) => size === sizes[0]),
    `params_json size was not constant across continuations: ${sizes.join(', ')}`
  );
});

// --- 2 & 3: per-batch statement count as the local queue drains ---

async function runBatches({ syncKey, contentMode = 'full_text_only', pdfBatchSize, batches, client }) {
  let enrichmentAttemptedBefore = null;
  let enrichmentCursor = '';
  const costs = [];
  for (let i = 0; i < batches; i += 1) {
    const counter = statementCounter(client);
    // eslint-disable-next-line no-await-in-loop
    const result = await runDocumentSync({
      mode: 'sync_missing_pdfs',
      baseUrl: 'https://oc-index.test',
      term: 'degree.raw,Doctor of Philosophy - PhD',
      source: 'id,title,author',
      pageSize: 1000,
      scanLimit: 100_000,
      syncMaxRecords: 100_000,
      downloadFiles: true,
      contentMode,
      pdfBatchSize,
      enrichmentAttemptedBefore: enrichmentAttemptedBefore || undefined,
      enrichmentCursor,
    });
    counter.restore();
    costs.push({ statements: counter.count, result });
    enrichmentAttemptedBefore = result.enrichmentAttemptedBefore;
    enrichmentCursor = result.enrichmentCursor;
    if (!result.pdfBatchLimitReached && !result.totalEnrichmentAttempted) break;
  }
  return { costs, syncKey };
}

test('draining several hundred pending documents costs the same per batch regardless of batch number', async () => {
  const syncKeyOptions = {
    baseUrl: 'https://oc-index.test',
    requestedIndex: '',
    query: '',
    term: 'degree.raw,Doctor of Philosophy - PhD',
    source: 'id,title,author',
  };
  const syncKey = getSyncKeyForOptions(syncKeyOptions);
  const client = await db.getDb();

  const TOTAL = 520;
  const items = Array.from({ length: TOTAL }, (_, index) => ({
    doc: { id: `dense-pending-${String(index).padStart(6, '0')}` },
    syncKey,
    source: null,
  }));
  await db.saveDocumentMetadataBatch(items);

  const BATCH_SIZE = 20;
  const { costs } = await runBatches({ syncKey, pdfBatchSize: BATCH_SIZE, batches: 20, client });

  assert.ok(costs.length >= 20, `expected at least 20 batches to run, only got ${costs.length}`);
  for (const { result } of costs) {
    assert.equal(result.ok, true);
    assert.equal(result.totalEnrichmentAttempted, BATCH_SIZE, 'each batch should attempt exactly pdfBatchSize documents from the local queue alone (no upstream scan)');
  }

  const firstBatch = costs[0].statements;
  const twentiethBatch = costs[19].statements;
  const maxStatements = Math.max(...costs.map((c) => c.statements));
  const minStatements = Math.min(...costs.map((c) => c.statements));

  assert.ok(
    twentiethBatch <= firstBatch * 1.5 + 2,
    `batch 20 cost ${twentiethBatch} statements vs batch 1's ${firstBatch} — cost grew with batch number (all: ${costs.map((c) => c.statements).join(',')})`
  );
  assert.ok(
    maxStatements <= minStatements * 1.5 + 2,
    `statement count was not flat across batches: min=${minStatements} max=${maxStatements} (${costs.map((c) => c.statements).join(',')})`
  );
});

// The realistic "mostly done" shape: this rule's own pending documents are a
// sparse subset scattered across a much larger doc_id range dominated by
// documents belonging to *other* sync keys and by this rule's own already-
// satisfied documents. Because listDocumentsPendingEnrichment's `+d.sync_key`
// deliberately forces a doc_id-PK ordered scan instead of an index lookup on
// sync_key, each page must step over every intervening row — regardless of
// which sync key it belongs to — before it can fill its LIMIT with this rule's
// own outstanding documents.
test('a sparse pending tail behind dense unrelated + satisfied documents still costs flat per batch', async () => {
  const ourOptions = {
    baseUrl: 'https://oc-index.test',
    requestedIndex: '',
    query: '',
    term: 'sparse-tail-rule',
    source: 'id,title,author',
  };
  const ourSyncKey = getSyncKeyForOptions(ourOptions);
  const noiseSyncKey = 'noise-rule-sync-key';
  const client = await db.getDb();

  const CLUSTERS = 30;
  const NOISE_PER_CLUSTER = 25;
  const SATISFIED_PER_CLUSTER = 8;
  const items = [];
  let counter = 0;
  const nextId = () => `doc-${String(counter++).padStart(7, '0')}`;

  const satisfiedIds = [];
  const pendingIds = [];
  for (let c = 0; c < CLUSTERS; c += 1) {
    for (let n = 0; n < NOISE_PER_CLUSTER; n += 1) {
      items.push({ doc: { id: nextId() }, syncKey: noiseSyncKey, source: null });
    }
    for (let s = 0; s < SATISFIED_PER_CLUSTER; s += 1) {
      const id = nextId();
      items.push({ doc: { id }, syncKey: ourSyncKey, source: null });
      satisfiedIds.push(id);
    }
    const pendingId = nextId();
    items.push({ doc: { id: pendingId }, syncKey: ourSyncKey, source: null });
    pendingIds.push(pendingId);
  }

  await db.saveDocumentMetadataBatch(items);
  for (const id of satisfiedIds) {
    // eslint-disable-next-line no-await-in-loop
    await db.saveFileMetric(id, {
      status: 'full_text', wordSource: 'dspace_full_text', wordCount: 500, pageCount: 5,
    });
  }

  const BATCH_SIZE = 1;
  const BATCHES_TO_RUN = Math.min(CLUSTERS, 25);
  const explained = explainCapturer(client);
  let costs;
  try {
    ({ costs } = await runBatches({ syncKey: ourSyncKey, pdfBatchSize: BATCH_SIZE, batches: BATCHES_TO_RUN, client }));
  } finally {
    explained.restore();
  }

  assert.equal(costs.length, BATCHES_TO_RUN, 'every batch should find its one pending document locally, without falling through to the upstream scan');
  for (const { result } of costs) {
    assert.equal(result.totalEnrichmentAttempted, 1);
  }

  const statementCounts = costs.map((c) => c.statements);
  const firstBatch = statementCounts[0];
  const lastBatch = statementCounts[statementCounts.length - 1];
  const maxStatements = Math.max(...statementCounts);
  const minStatements = Math.min(...statementCounts);

  // Statement *count* is the primary metric (per H-05/#19): each page is still
  // exactly one listDocumentsPendingEnrichment SELECT no matter how many
  // intervening rows it has to step over internally, so this should be flat by
  // construction even if the per-statement row-scan cost were not.
  assert.ok(
    maxStatements <= minStatements + 2,
    `statement count was not flat under the sparse-tail shape: min=${minStatements} max=${maxStatements} (${statementCounts.join(',')})`
  );
  assert.equal(
    lastBatch, firstBatch,
    `last batch cost ${lastBatch} statements vs first batch's ${firstBatch} under the sparse-tail shape`
  );

  // The metric the statement count above is blind to: under this exact
  // sparse-tail corpus, does the listDocumentsPendingEnrichment page query stay
  // on the doc_id primary key (as the `+d.sync_key` de-index at db.js ~2212
  // intends), or does the planner fall back to idx_documents_sync_key and
  // re-sort this rule's whole (noise-diluted) corpus on every batch? Either
  // shape is still exactly "one SELECT statement", so the statement-count
  // assertions above pass regardless -- this is the cost the reviewer's
  // finding says they cannot see.
  //
  // Batch 1 has no cursor yet, so its correct plan is a bounded SCAN of the
  // doc_id index from the start (LIMIT stops it at the first match); every
  // later batch has a cursor and its correct plan is a SEARCH seeking
  // straight to it. Both are fine -- what would NOT be fine, and is the
  // actual regression this asserts against, is landing on
  // idx_documents_sync_key instead (which cannot also serve the doc_id
  // ORDER BY, so it forces a "USE TEMP B-TREE FOR ORDER BY" over every
  // matching row instead of stopping at the cursor).
  assert.ok(explained.length >= BATCHES_TO_RUN, `expected an EXPLAIN capture per batch, got ${explained.length} for ${BATCHES_TO_RUN} batches`);
  explained.forEach(({ details, sql }, i) => {
    const hasCursor = sql.includes('d.doc_id > ?'); // absent only on batch 1, before any cursor exists
    assert.ok(
      !details.some((detail) => detail.includes('idx_documents_sync_key')),
      `batch ${i} landed on idx_documents_sync_key instead of the doc_id primary key: ${details.join(' | ')}\nSQL: ${sql}`
    );
    assert.ok(
      !details.some((detail) => /TEMP B-TREE/.test(detail)),
      `batch ${i} needed a temp-b-tree sort -- the doc_id de-index stopped working: ${details.join(' | ')}\nSQL: ${sql}`
    );
    assert.ok(
      details.some((detail) => /USING INDEX sqlite_autoindex_documents_1/.test(detail) && detail.startsWith(hasCursor ? 'SEARCH d ' : '')),
      `batch ${i} did not access documents via the doc_id primary key as expected (cursor present: ${hasCursor}): ${details.join(' | ')}`
    );
    if (hasCursor) {
      assert.ok(
        details.some((detail) => detail.includes('doc_id>?')),
        `batch ${i} had a cursor but did not seek on doc_id>?: ${details.join(' | ')}`
      );
    }
  });
});
