// #17 (H-02) Track 1 + Track 2 tests: OC-scan paging stability.
//
// Track 1 (unconditional, no vendor-capability dependency):
//   - incomplete vs completed run status is covered in test/syncBatch.test.js
//     (extending its existing scanLimited/exhausted fixtures).
//   - overlap/skip detector: a mocked-fetch test simulating an unstable-order
//     endpoint that re-serves an id across two pages.
//
// Track 2 (contingent on the vendor endpoint's capability — unverified from
// this sandbox, oc-index.library.ubc.ca is proxy-blocked; see
// docs/phase-b-completion-plan.md §1):
//   - the OC-scan loop's capability probe degrades gracefully when the
//     endpoint rejects sort/search_after, and uses search_after cursoring
//     across pages when the endpoint accepts it AND round-trips a cursor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tempDir;
let closeDb;
let runDocumentSync;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-paging-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');
  process.env.NODE_ENV = 'test';
  const db = await import('../src/db.js');
  closeDb = db.closeDb;
  ({ runDocumentSync } = await import('../src/sync.js'));
  await db.ensureStorage();
});

test.after(async () => {
  await closeDb?.();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

function page(docs, total) {
  return {
    data: { hits: { total, hits: docs.map((doc) => ({ _source: doc })) } },
  };
}

// --- Track 1: overlap/skip detector ---

test('overlap detector logs when a page returns a doc id already seen this pass', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = (await import('../src/logger.js')).logger.warn;
  const warnings = [];
  (await import('../src/logger.js')).logger.warn = (...args) => warnings.push(args);

  const suffix = `17${Date.now()}`;
  // Simulates unstable relevance-score ordering: page 2 re-serves the last id
  // from page 1 (a tie-break shift under an unsorted `from` window) — the
  // exact failure mode #17 describes, encoded as a fixed, testable fixture
  // rather than assumed live ES tie-break behaviour.
  const idA = `1.${suffix}00`;
  const idB = `1.${suffix}01`;
  const idC = `1.${suffix}01`; // duplicate of idB, simulating the overlap
  const idD = `1.${suffix}02`;
  let call = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/search/8.5')) {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify(page(
          [{ id: idA, title: 'A', author: 'X' }, { id: idB, title: 'B', author: 'X' }], 4
        )), { headers: { 'content-type': 'application/json' } });
      }
      if (call === 2) {
        return new Response(JSON.stringify(page(
          [{ id: idC, title: 'B again', author: 'X' }, { id: idD, title: 'D', author: 'X' }], 4
        )), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(page([], 4)), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await runDocumentSync({
      mode: 'import_all',
      baseUrl: 'https://oc-index.test',
      term: `degree.raw,Overlap-${suffix}`,
      source: 'id,title,author',
      pageSize: 2,
      scanLimit: 100,
      syncMaxRecords: 100,
      downloadFiles: false,
    });
    assert.equal(result.ok, true);
    // The detector counts the re-served id, without failing the run.
    assert.equal(result.duplicateDocIdsThisPass, 1,
      `expected exactly one detected overlap, got ${result.duplicateDocIdsThisPass}`);
    assert.equal(result.upstreamUniqueSeen, 3, 'only distinct upstream ids count toward completion');
    assert.equal(result.runStatus, 'incomplete', 'an overlap must not falsely satisfy the upstream total');
    assert.ok(
      warnings.some((args) => /already seen this pass/.test(args[0] || '')),
      'expected the overlap detector to log a warning'
    );
  } finally {
    globalThis.fetch = originalFetch;
    (await import('../src/logger.js')).logger.warn = originalWarn;
  }
});

// --- Track 2: capability detection degrades gracefully ---

test('a sort/search_after rejection falls back to plain unsorted paging for the rest of the run', async () => {
  const originalFetch = globalThis.fetch;
  const suffix = `18${Date.now()}`;
  const docs = Array.from({ length: 3 }, (_, i) => ({
    id: `1.${suffix}${String(i).padStart(2, '0')}`, title: `Doc ${i}`, author: 'Tester',
  }));
  let sawSortedRequest = false;
  let sawUnsortedRequest = false;
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (!text.includes('/search/8.5')) throw new Error(`Unexpected fetch: ${url}`);
    if (text.includes('sort=')) {
      sawSortedRequest = true;
      // Simulates the endpoint rejecting the unrecognized `sort` parameter.
      return new Response(JSON.stringify({ data: { error: 'unknown parameter: sort' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    }
    sawUnsortedRequest = true;
    return new Response(JSON.stringify(page(docs, docs.length)), { headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await runDocumentSync({
      mode: 'import_all',
      baseUrl: 'https://oc-index.test',
      term: `degree.raw,Reject-${suffix}`,
      source: 'id,title,author',
      pageSize: 100,
      scanLimit: 100,
      syncMaxRecords: 100,
      downloadFiles: false,
    });
    assert.equal(result.ok, true, 'the run must not fail just because sort/search_after is unsupported');
    assert.equal(result.totalSaved, docs.length);
    assert.equal(sawSortedRequest, true, 'expected the capability probe to attempt sort at least once');
    assert.equal(sawUnsortedRequest, true, 'expected a graceful fallback retry without sort');
    assert.equal(result.runStatus, 'completed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('search_after cursoring is used across pages once the endpoint round-trips a sort cursor', async () => {
  const originalFetch = globalThis.fetch;
  const suffix = `19${Date.now()}`;
  const allDocs = Array.from({ length: 4 }, (_, i) => ({
    id: `1.${suffix}${String(i).padStart(2, '0')}`, title: `Doc ${i}`, author: 'Tester',
  }));
  const requests = [];

  function hitFor(doc) {
    return { _source: doc, sort: [doc.id] };
  }

  globalThis.fetch = async (url) => {
    const text = String(url);
    if (!text.includes('/search/8.5')) throw new Error(`Unexpected fetch: ${url}`);
    requests.push(text);
    const params = new URL(text).searchParams;
    if (params.has('search_after')) {
      const cursor = JSON.parse(params.get('search_after'))[0];
      const startIndex = allDocs.findIndex((doc) => doc.id === cursor) + 1;
      const pageDocs = allDocs.slice(startIndex, startIndex + 2);
      return new Response(JSON.stringify({
        data: { hits: { total: allDocs.length, hits: pageDocs.map(hitFor) } },
      }), { headers: { 'content-type': 'application/json' } });
    }
    // First page: no cursor yet, plain sorted `from=0`.
    const pageDocs = allDocs.slice(0, 2);
    return new Response(JSON.stringify({
      data: { hits: { total: allDocs.length, hits: pageDocs.map(hitFor) } },
    }), { headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await runDocumentSync({
      mode: 'import_all',
      baseUrl: 'https://oc-index.test',
      term: `degree.raw,SearchAfter-${suffix}`,
      source: 'id,title,author',
      pageSize: 2,
      scanLimit: 100,
      syncMaxRecords: 100,
      downloadFiles: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.totalSaved, allDocs.length);
    assert.equal(result.duplicateDocIdsThisPass, 0);
    assert.ok(requests.length >= 2, 'expected at least two pages to be fetched');
    assert.ok(requests[0].includes('sort='), 'first page should carry the sort param');
    assert.ok(!requests[0].includes('search_after'), 'first page has no cursor yet');
    assert.ok(requests[1].includes('search_after='), 'second page should use search_after once a cursor is known');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
