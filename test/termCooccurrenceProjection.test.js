import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

let getDb, ensureStorage, closeDb, saveDocumentMetadataBatch, queryConceptTermsByDoc, tempDir, buildTermCooccurrence;

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

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term-cooc-'));
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  process.env.APP_DATA_DIR = tempDir;
  delete process.env.TURSO_DATABASE_URL;

  // loadConceptDictionary() (src/metrics.js) reads DATA_DIR/concepts/latest.json,
  // where DATA_DIR = process.env.APP_DATA_DIR. Without a dictionary on disk it
  // falls back to EMPTY_CONCEPT_DICT, whose multiDocSet is empty — silently
  // zeroing every concept term and making buildTermCooccurrence always return
  // []. Write a fixture dictionary (mirroring test/workbenchRoutes.test.js)
  // covering this test's own conceptTerms with docFreq >= 2 *before* importing
  // db.js/metrics.js, so DATA_DIR is already pointed at tempDir by the time
  // anything reads it, and before buildTermCooccurrence's first call reads it
  // from disk (loadConceptDictionary has no load-time caching — it stats the
  // file on every call — but getting this in place early avoids any ordering
  // ambiguity).
  await fs.mkdir(path.join(tempDir, 'concepts'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'concepts', 'latest.json'), JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    source: { documents: DOC_CONCEPT_TERMS.length },
    stats: { concepts: 4, aliases: 0 },
    concepts: [
      { canonical: 'indigenous education', variants: [], docFreq: 4, idf: 1.2 },
      { canonical: 'language policy', variants: [], docFreq: 3, idf: 1.3 },
      { canonical: 'curriculum reform', variants: [], docFreq: 3, idf: 1.3 },
      { canonical: 'teacher training', variants: [], docFreq: 3, idf: 1.3 },
    ],
    variantToCanonical: {},
  }, null, 2));

  ({ getDb, ensureStorage, closeDb, saveDocumentMetadataBatch, queryConceptTermsByDoc } = await import('../src/db.js'));
  ({ buildTermCooccurrence } = await import('../src/metrics.js'));
  await ensureStorage();
  await getDb();
});
test.after(async () => { await closeDb(); await fs.rm(tempDir, { recursive: true, force: true }); });

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

  // Non-vacuousness guards: with the concept dictionary fixture missing or
  // empty, buildTermCooccurrence silently returns [] for both sides and
  // deepEqual([], []) would pass without proving anything. Assert real pairs
  // exist before comparing, so this test cannot regress to a no-op.
  assert.ok(reference.length > 0, 'reference co-occurrence must be non-empty (dictionary fixture missing?)');
  assert.ok(actual.length > 0, 'projected co-occurrence must be non-empty (dictionary fixture missing?)');

  assert.deepEqual(actual, reference);
});
