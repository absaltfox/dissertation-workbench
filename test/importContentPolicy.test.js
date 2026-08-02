import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  _setDownloadSafetyOptionsForTests, analyzeDocumentFile, cleanupOrphanedPdfStreamDirs,
  fetchPdfToTempForDocument
} from '../src/pdf.js';
import {
  deleteImportRule, getImportRule, loadStoredFileMetric, saveFileMetric, saveImportRule
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
  assert.equal(hasCachedEnrichmentMetric({
    content_source: 'streamed_pdf',
    content_checksum: 'sha256:abc',
    word_count: 80_000,
    page_count: 250,
  }, 'pdf_stream'), true);
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

test('cached full-text recomputation replaces stale PDF provenance', async () => {
  const docId = `cached-text-provenance-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempDir = await fs.mkdtemp(`${os.tmpdir()}/oc-cached-text-test-`);
  const fullTextPath = `${tempDir}/document.txt`;
  const fullText = `Cached extracted dissertation text\n${'education research methods '.repeat(250)}`;
  const fullTextSourceUrl = 'https://example.test/document.txt';
  await fs.writeFile(fullTextPath, fullText, 'utf8');

  try {
    await saveFileMetric(docId, {
      status: 'cached',
      fullTextPath,
      fullTextBytes: Buffer.byteLength(fullText, 'utf8'),
      fullTextSourceUrl,
      contentSource: 'cached_pdf',
      contentChecksum: `sha256:${'a'.repeat(64)}`,
      contentSourceUrl: 'https://example.test/document.pdf',
      contentRetrievedAt: '2025-01-02T03:04:05.000Z',
      parserVersion: 'pdf-v1',
    });

    await analyzeDocumentFile({ id: docId }, {
      contentMode: 'full_text_only',
      downloadFiles: false,
      forceDownload: false,
      recomputeFromCache: true,
      extractCommittee: false,
      extractCitations: false,
    });

    const stored = await loadStoredFileMetric(docId);
    const checksum = crypto.createHash('sha256').update(fullText, 'utf8').digest('hex');
    assert.equal(stored.content_source, 'extracted_full_text');
    assert.equal(stored.content_checksum, `sha256:${checksum}`);
    assert.equal(stored.content_source_url, fullTextSourceUrl);
    assert.equal(stored.content_retrieved_at, null);
    assert.equal(stored.parser_version, 'full-text-v1');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

async function listPdfStreamTempDirs() {
  return new Set((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith('oc-pdf-stream-')));
}

async function assertNoNewPdfStreamTempDirs(before) {
  const after = await listPdfStreamTempDirs();
  assert.deepEqual([...after].filter((name) => !before.has(name)), []);
}

test('stream janitor removes a directory orphaned by a prior worker process', async () => {
  const orphan = await fs.mkdtemp(`${os.tmpdir()}/oc-pdf-stream-orphan-`);
  assert.equal(await cleanupOrphanedPdfStreamDirs() >= 1, true);
  await assert.rejects(fs.access(orphan));
});

test('pdf_stream accounts for bytes received before an oversized stream is rejected', async () => {
  const originalFetch = globalThis.fetch;
  const before = await listPdfStreamTempDirs();
  const pdfBytes = Buffer.from('%PDF-1234567890');
  const events = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/rest/handle/2429/stream-oversize')) {
      return new Response(JSON.stringify({
        bitstreams: [{
          id: 302,
          bundleName: 'ORIGINAL',
          mimeType: 'application/pdf',
          name: 'stream-oversize.pdf',
        }],
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/rest/bitstreams/302/retrieve')) {
      return new Response(pdfBytes, { headers: { 'content-type': 'application/pdf' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  _setDownloadSafetyOptionsForTests({ allowOriginalPdfRetrieval: true });
  try {
    const result = await fetchPdfToTempForDocument({
      id: 'stream-oversize',
      originalRecordUrl: 'https://circle.library.ubc.ca/rest/handle/2429/stream-oversize',
    }, {
      maxBytes: 10,
      onContentRequest: async (event) => events.push(event),
    });
    assert.equal(result, null);
    assert.equal(events.some((event) => (
      event.source === 'original_pdf'
      && event.request === false
      && event.bytes === pdfBytes.length
    )), true);
    await assertNoNewPdfStreamTempDirs(before);
  } finally {
    _setDownloadSafetyOptionsForTests(null);
    globalThis.fetch = originalFetch;
  }
});

test('pdf_stream persists derived provenance and always removes its temporary PDF', async () => {
  const originalFetch = globalThis.fetch;
  const docId = `stream-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nstream\nBT (Streamed dissertation words for analysis) Tj ET\nendstream\nendobj\n');
  const before = await listPdfStreamTempDirs();

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/rest/handle/2429/stream-fixture')) {
      return new Response(JSON.stringify({
        id: 101,
        bitstreams: [{
          id: 102,
          bundleName: 'ORIGINAL',
          mimeType: 'application/pdf',
          name: 'stream-fixture.pdf',
        }],
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/rest/bitstreams/102/retrieve')) {
      return new Response(pdfBytes, {
        headers: {
          'content-type': 'application/pdf',
          'content-length': String(pdfBytes.length),
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  _setDownloadSafetyOptionsForTests({ allowOriginalPdfRetrieval: true });
  try {
    const doc = {
      id: docId,
      originalRecordUrl: 'https://circle.library.ubc.ca/rest/handle/2429/stream-fixture',
    };
    await analyzeDocumentFile(doc, {
      contentMode: 'pdf_stream',
      downloadFiles: true,
      forceDownload: false,
      recomputeFromCache: false,
      extractCommittee: false,
      extractCitations: false,
    });

    const stored = await loadStoredFileMetric(docId);
    assert.equal(stored.status, 'streamed');
    assert.equal(Number(stored.word_count) > 0, true);
    assert.equal(stored.pdf_path, null);
    assert.equal(stored.content_source, 'streamed_pdf');
    assert.match(stored.content_checksum, /^sha256:[a-f0-9]{64}$/);
    assert.match(stored.content_source_url, /\/rest\/bitstreams\/102\/retrieve/);
    assert.equal(stored.parser_version, 'pdf-v1');
    assert.equal(Number(stored.metadata_request_count), 1);
    assert.equal(Number(stored.original_pdf_request_count), 1);
    assert.equal(Number(stored.retrieved_bytes) >= pdfBytes.length, true);
    await saveFileMetric(docId, {
      status: stored.status,
      error: stored.error,
      pdfPath: stored.pdf_path,
      downloadUrl: stored.download_url,
      fileBytes: stored.file_bytes,
      wordCount: stored.word_count,
      bodyWordCount: stored.body_word_count,
      pageCount: stored.page_count,
      wordSource: stored.word_source,
      pageSource: stored.page_source,
    });
    const afterReplacementWithoutProvenance = await loadStoredFileMetric(docId);
    assert.equal(afterReplacementWithoutProvenance.content_checksum, null);
    assert.equal(afterReplacementWithoutProvenance.content_source, null);
    await assertNoNewPdfStreamTempDirs(before);
  } finally {
    _setDownloadSafetyOptionsForTests(null);
    globalThis.fetch = originalFetch;
  }
});

test('pdf_stream removes its temporary PDF when analysis is interrupted', async () => {
  const originalFetch = globalThis.fetch;
  const docId = `stream-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n');
  const before = await listPdfStreamTempDirs();
  const requested = [];

  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/rest/handle/2429/stream-failure')) {
      return new Response(JSON.stringify({
        id: 201,
        bitstreams: [{
          id: 202,
          bundleName: 'ORIGINAL',
          mimeType: 'application/pdf',
          name: 'stream-failure.pdf',
        }, {
          id: 203,
          bundleName: 'TEXT',
          mimeType: 'text/plain',
          name: 'stream-failure.pdf.txt',
        }],
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/rest/bitstreams/202/retrieve')) {
      return new Response(pdfBytes, {
        headers: { 'content-type': 'application/pdf' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  _setDownloadSafetyOptionsForTests({ allowOriginalPdfRetrieval: true });
  try {
    await analyzeDocumentFile({
      id: docId,
      originalRecordUrl: 'https://circle.library.ubc.ca/rest/handle/2429/stream-failure',
    }, {
      contentMode: 'pdf_stream',
      downloadFiles: true,
      forceDownload: false,
      recomputeFromCache: false,
      extractCommittee: false,
      extractCitations: false,
      onProgress: async (event) => {
        if (event.phase === 'pdf_analysis' && event.status === 'running') {
          throw new Error('forced analysis interruption');
        }
      },
    });
    await assertNoNewPdfStreamTempDirs(before);
    const stored = await loadStoredFileMetric(docId);
    assert.equal(stored.pdf_path, null);
    assert.equal(stored.status, 'stream_failed');
    assert.equal(stored.word_source, null);
    assert.equal(requested.some((url) => url.includes('/rest/bitstreams/203/retrieve')), false);
  } finally {
    _setDownloadSafetyOptionsForTests(null);
    globalThis.fetch = originalFetch;
  }
});
