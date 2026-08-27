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
let reserveImportRuleRequestSlot;
let rulesForContinuation;
let setDownloadSafetyOptions;

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
    reserveImportRuleRequestSlot,
    saveImportRule,
  } = await import('../src/db.js'));
  ({ runDocumentSync } = await import('../src/sync.js'));
  ({ _setDownloadSafetyOptionsForTests: setDownloadSafetyOptions } = await import('../src/pdf.js'));
  ({ runImportPdfAdminJob } = await import('../src/services/importPdfJobRunner.js'));
  ({ rulesForContinuation } = await import('../src/services/importPdfJobRunner.js'));
  await ensureStorage();
});

test('continuations retain only the capped enrichment rule and rules not yet processed', () => {
  const rules = [
    { id: 'metadata-done', contentMode: 'metadata_only' },
    { id: 'text-done', contentMode: 'full_text_only' },
    { id: 'text-capped', contentMode: 'full_text_only' },
    { id: 'metadata-pending', contentMode: 'metadata_only' },
  ];
  const continued = rulesForContinuation(rules, [
    { ruleId: 'metadata-done', pdfBatchLimitReached: false },
    { ruleId: 'text-done', pdfBatchLimitReached: false },
    { ruleId: 'text-capped', pdfBatchLimitReached: true },
  ]);
  assert.deepEqual(continued.map((rule) => rule.id), ['text-capped', 'metadata-pending']);
});

test('durable per-rule request reservations are atomic across workers', async () => {
  const rule = await saveImportRule({
    id: `rate-reservation-${Date.now()}`,
    name: 'Rate reservation fixture',
  });
  const reservations = await Promise.all([
    reserveImportRuleRequestSlot(rule.id, 2, { nowMs: 10_000, windowMs: 60_000 }),
    reserveImportRuleRequestSlot(rule.id, 2, { nowMs: 10_000, windowMs: 60_000 }),
    reserveImportRuleRequestSlot(rule.id, 2, { nowMs: 10_000, windowMs: 60_000 }),
  ]);
  assert.deepEqual(reservations.sort((left, right) => left - right), [0, 0, 60_000]);
});

test('worker rejects invalid snapshotted content policies before network access', async () => {
  const jobId = await createAdminJob({
    type: 'import_rules_sync',
    label: 'Invalid Policy Test',
    params: {
      mode: 'sync_missing_pdfs',
      scope: 'selected',
      ruleIds: ['invalid-rule'],
      rules: [{ id: 'invalid-rule', name: 'Invalid', contentMode: 'not-a-mode' }],
      autoContinuePdfBatches: false,
    },
    runnerType: 'local',
  });
  await assert.rejects(
    runImportPdfAdminJob(await getAdminJob(jobId)),
    /Invalid snapshotted import rule/
  );
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
    assert.equal(first.totalEnrichmentAttempted, 2);
    assert.equal(first.totalEnriched, 0);
    assert.equal(first.totalEnrichmentFailed, 2);
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

    // A continuation carries the chain's start instant, not a list of doc ids: the
    // documents the chain already attempted are excluded by enrichment_attempts.
    const continuation = await runDocumentSync({
      mode: 'sync_missing_pdfs',
      baseUrl: 'https://oc-index.test',
      term: 'degree.raw,Doctor of Philosophy - PhD',
      source: 'id,title,author',
      pageSize: 100,
      scanLimit: 100,
      syncMaxRecords: 100,
      pdfBatchSize: 2,
      enrichmentAttemptedBefore: first.enrichmentAttemptedBefore,
      enrichmentCursor: first.enrichmentCursor,
      downloadFiles: true,
    });

    assert.equal(continuation.ok, true);
    assert.equal(continuation.totalSaved, 1);
    assert.deepEqual(continuation.pdfAttemptedIds, ['1.0000003']);
    assert.equal((await loadStoredFileMetric('1.0000003')).status, 'not_found');

    const controlled = await runDocumentSync({
      mode: 'sync_missing_pdfs',
      baseUrl: 'https://oc-index.test',
      term: 'degree.raw,Doctor of Philosophy - PhD',
      source: 'id,title,author',
      pageSize: 100,
      scanLimit: 100,
      syncMaxRecords: 100,
      pdfBatchSize: 1,
      enrichmentDocIds: ['1.0000002'],
      downloadFiles: true,
    });
    assert.deepEqual(controlled.pdfAttemptedIds, ['1.0000002']);
    assert.equal(controlled.totalEnrichmentAttempted, 1);
    assert.equal(controlled.enrichmentExhausted, true);

    globalThis.fetch = async (url) => {
      if (String(url).includes('/search/8.5')) {
        const payload = searchPayload();
        payload.data.hits.total = 100;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const scanLimited = await runDocumentSync({
      mode: 'sync_missing_pdfs',
      baseUrl: 'https://oc-index.test',
      term: 'degree.raw,Doctor of Philosophy - PhD',
      source: 'id,title,author',
      pageSize: 100,
      scanLimit: 3,
      syncMaxRecords: 3,
      pdfBatchSize: 1,
      enrichmentDocIds: ['1.0000001'],
      downloadFiles: true,
    });
    assert.equal(scanLimited.enrichmentExhausted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sync enrichment totals count only policy-satisfying results as enriched', async () => {
  const originalFetch = globalThis.fetch;
  const docId = `1.${String(Date.now()).slice(-7)}`;
  const fullText = `Successful extracted thesis text\n${'education research '.repeat(300)}`;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/search/8.5')) {
      return new Response(JSON.stringify({
        data: {
          hits: {
            total: 1,
            hits: [{
              _source: {
                id: docId,
                title: 'Successful Enrichment Fixture',
                author: 'Success Tester',
                digitalResourceOriginalRecord: 'https://circle.library.ubc.ca/rest/handle/2429/sync-success',
              },
            }],
          },
        },
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/rest/handle/2429/sync-success')) {
      return new Response(JSON.stringify({
        bitstreams: [{
          id: 401,
          bundleName: 'TEXT',
          mimeType: 'text/plain',
          name: 'sync-success.pdf.txt',
        }],
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/rest/bitstreams/401/retrieve')) {
      return new Response(fullText, { headers: { 'content-type': 'text/plain' } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await runDocumentSync({
      mode: 'sync_missing_pdfs',
      baseUrl: 'https://oc-index.test',
      term: 'degree.raw,Success',
      source: 'id,title,author,digitalResourceOriginalRecord',
      pageSize: 100,
      scanLimit: 100,
      syncMaxRecords: 100,
      pdfBatchSize: 1,
      contentMode: 'full_text_only',
      downloadFiles: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.totalEnrichmentAttempted, 1);
    assert.equal(result.totalEnriched, 1);
    assert.equal(result.totalEnrichmentFailed, 0);
    assert.equal((await loadStoredFileMetric(docId)).content_source, 'extracted_full_text');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('explicit PDF full-text fallback counts as successful enrichment', async () => {
  const originalFetch = globalThis.fetch;
  const docId = `1.${String(Date.now()).slice(-7)}9`;
  const fullText = `Fallback extracted thesis text\n${'education systems research '.repeat(300)}`;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/search/8.5')) {
      return new Response(JSON.stringify({
        data: { hits: { total: 1, hits: [{ _source: {
          id: docId,
          title: 'PDF Fallback Success Fixture',
          author: 'Fallback Tester',
          digitalResourceOriginalRecord: 'https://circle.library.ubc.ca/rest/handle/2429/pdf-fallback-success',
        } }] } },
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/rest/handle/2429/pdf-fallback-success')) {
      return new Response(JSON.stringify({
        bitstreams: [{ id: 451, bundleName: 'TEXT', mimeType: 'text/plain', name: 'fallback.pdf.txt' }],
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/rest/bitstreams/451/retrieve')) {
      return new Response(fullText, { headers: { 'content-type': 'text/plain' } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  setDownloadSafetyOptions({ allowOriginalPdfRetrieval: true });
  try {
    const result = await runDocumentSync({
      mode: 'sync_missing_pdfs',
      baseUrl: 'https://oc-index.test',
      term: 'degree.raw,PDF Fallback',
      source: 'id,title,author,digitalResourceOriginalRecord',
      pageSize: 100,
      scanLimit: 100,
      syncMaxRecords: 100,
      pdfBatchSize: 1,
      contentMode: 'pdf_stream',
      contentFallback: 'full_text',
      downloadFiles: true,
    });
    const stored = await loadStoredFileMetric(docId);
    assert.equal(result.totalEnriched, 1);
    assert.equal(result.totalEnrichmentFailed, 0);
    assert.equal(stored.status, 'full_text_fallback');
    assert.equal(stored.error, null);
  } finally {
    setDownloadSafetyOptions(null);
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
    contentMode: 'full_text_only',
  });
  const ruleTwo = await saveImportRule({
    id: `rule-two-${suffix}`,
    name: `Rule Two ${suffix}`,
    degree: `Rule Two ${suffix}`,
    source: 'id,title,author',
    contentMode: 'full_text_only',
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
        rules: [ruleOne, ruleTwo],
        pdfBatchSize: 2,
        autoContinuePdfBatches: false,
      },
      runnerType: 'local',
    });
    await saveImportRule({ ...ruleOne, contentMode: 'metadata_only' });
    await saveImportRule({ ...ruleTwo, contentMode: 'metadata_only' });
    const result = await runImportPdfAdminJob(await getAdminJob(jobId));

    assert.equal(result.ok, true);
    assert.equal(result.totalSaved, 2);
    assert.equal(result.totalEnrichmentAttempted, 2);
    assert.equal(result.totalEnriched, 0);
    assert.equal(result.totalEnrichmentFailed, 2);
    assert.equal(result.pdfBatchLimitReached, true);
    assert.equal(result.rules.length, 1);
    assert.equal(result.rules[0].contentMode, 'full_text_only');
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
