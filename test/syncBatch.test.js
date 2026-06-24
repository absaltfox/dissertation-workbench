import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tempDir;
let closeDb;
let createAdminJob;
let ensureStorage;
let getAdminJob;
let loadStoredFileMetric;
let runDocumentSync;
let runImportPdfAdminJob;
let saveImportRule;

function searchPayload() {
  return {
    data: {
      hits: {
        total: 3,
        hits: [
          { _source: { id: '1.0000001', title: 'Batch Fixture One', author: 'Tester One' } },
          { _source: { id: '1.0000002', title: 'Batch Fixture Two', author: 'Tester Two' } },
          { _source: { id: '1.0000003', title: 'Batch Fixture Three', author: 'Tester Three' } },
        ],
      },
    },
  };
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-sync-batch-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');
  process.env.NODE_ENV = 'test';

  ({
    closeDb,
    createAdminJob,
    ensureStorage,
    getAdminJob,
    loadStoredFileMetric,
    saveImportRule,
  } = await import('../src/db.js'));
  ({ runDocumentSync } = await import('../src/sync.js'));
  ({ runImportPdfAdminJob } = await import('../src/services/importPdfJobRunner.js'));
  await ensureStorage();
});

test.after(async () => {
  await closeDb?.();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test('sync_missing_pdfs batches missing PDF attempts and reports per-document progress', async () => {
  const originalFetch = globalThis.fetch;
  const events = [];
  globalThis.fetch = async (url) => {
    if (String(url).includes('/search/8.5')) {
      return new Response(JSON.stringify(searchPayload()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const first = await runDocumentSync({
      mode: 'sync_missing_pdfs',
      baseUrl: 'https://oc-index.test',
      term: 'degree.raw,Doctor of Philosophy - PhD',
      source: 'id,title,author',
      pageSize: 100,
      scanLimit: 100,
      syncMaxRecords: 100,
      pdfBatchSize: 2,
      downloadFiles: true,
      onProgress: async (event) => events.push(event),
    });

    assert.equal(first.ok, true);
    assert.equal(first.totalSaved, 2);
    assert.equal(first.pdfBatchLimitReached, true);
    assert.deepEqual(first.pdfAttemptedIds, ['1.0000001', '1.0000002']);
    assert.equal((await loadStoredFileMetric('1.0000001')).status, 'not_found');
    assert.equal((await loadStoredFileMetric('1.0000002')).status, 'not_found');
    assert.equal(await loadStoredFileMetric('1.0000003'), null);
    assert.deepEqual(
      events.filter((event) => event.phase === 'pdf_document' && event.status === 'running')
        .map((event) => event.counts),
      [{ processed: 1, total: 2 }, { processed: 2, total: 2 }]
    );

    const second = await runDocumentSync({
      mode: 'sync_missing_pdfs',
      baseUrl: 'https://oc-index.test',
      term: 'degree.raw,Doctor of Philosophy - PhD',
      source: 'id,title,author',
      pageSize: 100,
      scanLimit: 100,
      syncMaxRecords: 100,
      pdfBatchSize: 2,
      downloadFiles: true,
    });

    assert.equal(second.ok, true);
    assert.equal(second.totalSaved, 2);
    assert.equal(await loadStoredFileMetric('1.0000003'), null);

    const continuation = await runDocumentSync({
      mode: 'sync_missing_pdfs',
      baseUrl: 'https://oc-index.test',
      term: 'degree.raw,Doctor of Philosophy - PhD',
      source: 'id,title,author',
      pageSize: 100,
      scanLimit: 100,
      syncMaxRecords: 100,
      pdfBatchSize: 2,
      skipPdfDocIds: first.pdfAttemptedIds,
      downloadFiles: true,
    });

    assert.equal(continuation.ok, true);
    assert.equal(continuation.totalSaved, 1);
    assert.equal((await loadStoredFileMetric('1.0000003')).status, 'not_found');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('import-rule PDF batches share one job-level cap across selected rules', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const docBase = String(Date.now()).slice(-7);
  const docIds = {
    oneA: `1.${docBase}1`,
    oneB: `1.${docBase}2`,
    twoA: `1.${docBase}3`,
    twoB: `1.${docBase}4`,
  };
  const ruleOne = await saveImportRule({
    id: `rule-one-${suffix}`,
    name: `Rule One ${suffix}`,
    degree: `Rule One ${suffix}`,
    source: 'id,title,author',
  });
  const ruleTwo = await saveImportRule({
    id: `rule-two-${suffix}`,
    name: `Rule Two ${suffix}`,
    degree: `Rule Two ${suffix}`,
    source: 'id,title,author',
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const text = String(url);
    const docs = text.includes(encodeURIComponent(`Rule One ${suffix}`).replace(/%20/g, '+'))
      ? [
          { _source: { id: docIds.oneA, title: 'Rule One A', author: 'Tester One' } },
          { _source: { id: docIds.oneB, title: 'Rule One B', author: 'Tester One' } },
        ]
      : [
          { _source: { id: docIds.twoA, title: 'Rule Two A', author: 'Tester Two' } },
          { _source: { id: docIds.twoB, title: 'Rule Two B', author: 'Tester Two' } },
        ];
    if (text.includes('/search/8.5')) {
      return new Response(JSON.stringify({ data: { hits: { total: docs.length, hits: docs } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const jobId = await createAdminJob({
      type: 'import_rules_sync',
      label: 'Import Rules Sync Batch Test',
      params: {
        mode: 'sync_missing_pdfs',
        scope: 'selected',
        ruleIds: [ruleOne.id, ruleTwo.id],
        downloadFiles: true,
        pdfBatchSize: 2,
        autoContinuePdfBatches: false,
      },
      runnerType: 'local',
    });
    const result = await runImportPdfAdminJob(await getAdminJob(jobId));

    assert.equal(result.ok, true);
    assert.equal(result.totalSaved, 2);
    assert.equal(result.pdfBatchLimitReached, true);
    assert.equal(result.rules.length, 1);
    if (result.rules[0].ruleId === ruleOne.id) {
      assert.equal((await loadStoredFileMetric(docIds.oneA)).status, 'not_found');
      assert.equal((await loadStoredFileMetric(docIds.oneB)).status, 'not_found');
      assert.equal(await loadStoredFileMetric(docIds.twoA), null);
    } else {
      assert.equal(result.rules[0].ruleId, ruleTwo.id);
      assert.equal((await loadStoredFileMetric(docIds.twoA)).status, 'not_found');
      assert.equal((await loadStoredFileMetric(docIds.twoB)).status, 'not_found');
      assert.equal(await loadStoredFileMetric(docIds.oneA), null);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
