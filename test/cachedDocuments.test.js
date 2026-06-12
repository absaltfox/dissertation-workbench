import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDb,
  ensureStorage,
  listCachedDocuments,
  saveDocumentMetadata,
  saveFileMetric,
} from '../src/db.js';

test.after(async () => {
  await closeDb();
});

test('cached documents overlay persisted file metrics without enrichment work', async () => {
  await ensureStorage();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const syncKey = `test-file-metric-overlay-${suffix}`;
  const docId = `test-doc-${suffix}`;

  await saveDocumentMetadata({
    id: docId,
    title: 'Cached metric overlay fixture',
    author: 'Example Author',
    year: 2026,
    degree: 'Doctor of Education - EdD',
    program: 'Education',
    pages: 1,
    pagesSource: 'estimated_from_metadata_words',
    wordCount: 120,
    wordCountSource: 'metadata_text',
    bodyWordCount: null,
    downloadUrl: null,
    downloadStatus: 'not_attempted',
    downloadError: null,
  }, { syncKey });

  await saveFileMetric(docId, {
    status: 'downloaded',
    error: null,
    pdfPath: '/tmp/cached-metric-overlay.pdf',
    downloadUrl: 'https://circle.library.ubc.ca/rest/bitstreams/123/retrieve',
    fileBytes: 123456,
    wordCount: 60000,
    bodyWordCount: 52000,
    pageCount: 210,
    wordSource: 'downloaded_pdf_text',
    pageSource: 'downloaded_pdf',
  });

  const docs = await listCachedDocuments({ syncKey, limit: 10 });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].id, docId);
  assert.equal(docs[0].pages, 210);
  assert.equal(docs[0].pagesSource, 'downloaded_pdf');
  assert.equal(docs[0].wordCount, 60000);
  assert.equal(docs[0].wordCountSource, 'downloaded_pdf_text');
  assert.equal(docs[0].bodyWordCount, 52000);
  assert.equal(docs[0].fileBytes, 123456);
  assert.equal(docs[0].downloadStatus, 'downloaded');
  assert.equal(docs[0].downloadError, null);
});
