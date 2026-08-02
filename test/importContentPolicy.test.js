import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _setDownloadSafetyOptionsForTests, analyzeDocumentFile
} from '../src/pdf.js';
import {
  deleteImportRule, getImportRule, loadStoredFileMetric, saveImportRule
} from '../src/db.js';
import { hasCachedEnrichmentMetric } from '../src/sync.js';

test('content policy satisfaction is mode-specific', () => {
  const fullTextMetric = {
    word_source: 'dspace_full_text',
    word_count: 80_000,
    page_count: 250,
    pdf_path: null,
  };
  assert.equal(hasCachedEnrichmentMetric(fullTextMetric, 'full_text_only'), true);
  assert.equal(hasCachedEnrichmentMetric(fullTextMetric, 'pdf_cache'), false);
  assert.equal(hasCachedEnrichmentMetric({ pdf_path: '/cache/doc.pdf' }, 'pdf_cache'), true);
});

test('metadata_only and invalid policies make no content network requests', async () => {
  let requested = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    requested = true;
    throw new Error('network must not be called');
  };
  try {
    await analyzeDocumentFile({ id: `metadata-${Date.now()}` }, {
      contentMode: 'metadata_only',
      downloadFiles: false,
      forceDownload: false,
      recomputeFromCache: false,
    });
    await assert.rejects(
      analyzeDocumentFile({ id: `invalid-${Date.now()}` }, {
        contentMode: 'invalid_mode',
        downloadFiles: false,
        forceDownload: false,
        recomputeFromCache: false,
      }),
      /Unsupported content mode/
    );
    assert.equal(requested, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pdf_cache fails closed when original retrieval is disabled', async () => {
  let requested = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    requested = true;
    throw new Error('network must not be called');
  };
  _setDownloadSafetyOptionsForTests({ allowOriginalPdfRetrieval: false });
  try {
    await assert.rejects(
      analyzeDocumentFile({ id: `blocked-pdf-${Date.now()}` }, {
        contentMode: 'pdf_cache',
        downloadFiles: true,
        forceDownload: false,
        recomputeFromCache: false,
      }),
      /disabled by deployment policy/
    );
    assert.equal(requested, false);
  } finally {
    _setDownloadSafetyOptionsForTests(null);
    globalThis.fetch = originalFetch;
  }
});

test('import-rule content modes persist through the database contract', async () => {
  const id = `content-rule-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await saveImportRule({
      id,
      name: 'Streamed document rule',
      contentMode: 'pdf_stream',
    });
    assert.equal((await getImportRule(id)).contentMode, 'pdf_stream');
  } finally {
    await deleteImportRule(id);
  }
});

test('full_text_only analyzes the TEXT derivative without retrieving or retaining the original PDF', async () => {
  const originalFetch = globalThis.fetch;
  const docId = `policy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const requested = [];
  const fullText = `Extracted dissertation text\n${'education policy research '.repeat(250)}`;

  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/rest/handle/2429/99999')) {
      return new Response(JSON.stringify({
        id: 99,
        bitstreams: [
          { id: 11, bundleName: 'ORIGINAL', mimeType: 'application/pdf', name: 'document.pdf' },
          { id: 12, bundleName: 'TEXT', mimeType: 'text/plain', name: 'document.pdf.txt' },
        ],
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/rest/bitstreams/12/retrieve')) {
      return new Response(fullText, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const doc = {
      id: docId,
      originalRecordUrl: 'https://circle.library.ubc.ca/rest/handle/2429/99999',
    };
    await analyzeDocumentFile(doc, {
      contentMode: 'full_text_only',
      downloadFiles: false,
      forceDownload: false,
      recomputeFromCache: false,
      extractCommittee: false,
      extractCitations: false,
    });

    const stored = await loadStoredFileMetric(docId);
    assert.equal(doc.wordCount > 0, true);
    assert.equal(doc.pagesSource, 'estimated_from_full_text_words');
    assert.equal(stored.full_text_path, null);
    assert.equal(stored.pdf_path, null);
    assert.equal(requested.some((url) => url.includes('/rest/bitstreams/11/retrieve')), false);
    assert.equal(requested.some((url) => url.includes('/rest/bitstreams/12/retrieve')), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
