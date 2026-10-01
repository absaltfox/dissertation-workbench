import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

let getDb, ensureStorage, closeDb, saveDocumentMetadataBatch, queryConceptTermsByDoc, tempDir, buildTermCooccurrence;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term-cooc-'));
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;
  ({ getDb, ensureStorage, closeDb, saveDocumentMetadataBatch, queryConceptTermsByDoc } = await import('../src/db.js'));
  ({ buildTermCooccurrence } = await import('../src/metrics.js'));
  await ensureStorage();
  await getDb();
});
test.after(async () => { await closeDb(); await fs.rm(tempDir, { recursive: true, force: true }); });

// Overlapping conceptTerms across docs so real multi-doc co-occurrence pairs
// are produced (buildTermCooccurrence drops single-doc-frequency concepts).
const SYNC_KEY = 'term-cooc-test-key';
const DOC_CONCEPT_TERMS = [
  ['indigenous education', 'language policy', 'curriculum reform'],
  ['indigenous education', 'language policy'],
  ['indigenous education', 'curriculum reform', 'teacher training'],
  ['language policy', 'teacher training'],
  ['curriculum reform', 'teacher training', 'indigenous education'],
];

test('full-corpus co-occurrence from the document_terms projection equals a direct build over the same records', async () => {
  const docs = DOC_CONCEPT_TERMS.map((conceptTerms, i) => ({
    id: `tc-${i}`,
    title: `Doc ${i}`,
    author: `Author ${i}`,
    year: 2020,
    degree: 'PhD',
    program: 'Education',
    themes: [],
    conceptTerms,
    methodologies: [],
  }));
  await saveDocumentMetadataBatch(docs.map((doc) => ({ doc, syncKey: SYNC_KEY })));

  const referenceRecords = DOC_CONCEPT_TERMS.map((conceptTerms) => ({ conceptTerms }));
  const reference = buildTermCooccurrence(referenceRecords);

  const projected = await queryConceptTermsByDoc({ syncKey: SYNC_KEY });
  assert.equal(projected.length, DOC_CONCEPT_TERMS.length);
  const actual = buildTermCooccurrence(projected);

  assert.deepEqual(actual, reference);
});
