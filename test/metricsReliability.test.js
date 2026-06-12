import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureSourceFields,
  hasReliablePageCount,
  hasReliableWordCount,
  normalizeRecord
} from '../src/metrics.js';

test('ensureSourceFields keeps original-record URL needed for cIRcle full-text fallback', () => {
  assert.equal(
    ensureSourceFields('title,uri'),
    'title,uri,id,identifier,digitalResourceOriginalRecord'
  );
});

test('normalizeRecord preserves digitalResourceOriginalRecord without exposing full text', () => {
  const doc = normalizeRecord({
    id: '1.0451810',
    title: 'Example',
    creator: 'Author',
    ubc_date_sort: '2026',
    digitalResourceOriginalRecord: 'http://circle.library.ubc.ca/rest/handle/2429/93916?expand=metadata',
    text: 'full text should only be used for metadata estimates',
  });

  assert.equal(doc.originalRecordUrl, 'http://circle.library.ubc.ca/rest/handle/2429/93916?expand=metadata');
  assert.equal(Object.hasOwn(doc, 'fullText'), false);
});

test('length chart reliability filters exclude metadata-only and tiny counts', () => {
  assert.equal(hasReliableWordCount({ wordCount: 92, wordCountSource: 'metadata_text' }), false);
  assert.equal(hasReliablePageCount({ pages: 1, pagesSource: 'estimated_from_metadata_words' }), false);
  assert.equal(hasReliableWordCount({ wordCount: 75_000, wordCountSource: 'dspace_full_text' }), true);
  assert.equal(hasReliablePageCount({ pages: 250, pagesSource: 'estimated_from_full_text_words' }), true);
});
