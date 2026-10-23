import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveHealedDocument } from '../scripts/heal-document-metadata.mjs';

// A good stored row (as metadata_json would hold post-normalization).
const storedGood = {
  title: 'A Study of Kelp Forest Recovery',
  author: 'Rivera, Dana',
  abstract: 'An investigation into kelp forest dynamics.',
  subjects: ['Marine biology'],
  degree: 'Doctor of Philosophy',
  program: 'Oceanography',
  pages: 210,
  wordCount: 51000,
};

test('#28: heal refuses to run on a trimmed source_json (never blanks good metadata)', () => {
  // Post-#28, documents.source_json holds only the provenance stub.
  const trimmedSource = { id: 'oc:123', sourceUpdatedAt: '2026-01-01T00:00:00Z' };

  const result = deriveHealedDocument({ source: trimmedSource, stored: storedGood });

  assert.equal(result.skip, true, 'must skip when the source cannot reproduce core metadata');
  assert.equal(result.reason, 'insufficient-source');
  assert.equal(result.doc, undefined, 'must not produce a document to save');
});

test('#28: heal still works on a full upstream record (legacy, pre-migration row)', () => {
  // A full record still carrying real fields (a row not yet trimmed).
  const fullSource = {
    id: 'oc:123',
    title: 'A Study of Kelp Forest Recovery',
    creator: ['Rivera, Dana'],
    description: 'An investigation into kelp forest dynamics.',
    subject: ['Marine biology'],
    sourceUpdatedAt: '2026-01-01T00:00:00Z',
  };

  const result = deriveHealedDocument({ source: fullSource, stored: storedGood });

  assert.ok(!result.skip, 'a full source should heal, not skip');
  assert.ok(result.doc, 'should return a document to save');
  assert.ok(result.doc.title && result.doc.title.trim() !== '', 'title is preserved from the source');
  // PDF/metric fields from the stored row are re-applied.
  assert.equal(result.doc.pages, 210);
  assert.equal(result.doc.wordCount, 51000);
});
