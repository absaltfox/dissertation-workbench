import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// #15 scale test: the five SQL-ported panels (supervisorNgramMatrix,
// conceptTimeline, methodologyConceptMatrix, methodologyTopicMatrix,
// topicData) must return real data promptly at a corpus size well beyond
// DETAILED_ANALYTICS_RECORD_LIMIT (5,000) — proving the SQL port, not just
// the below-threshold JS path, is what serves a corpus this large. 20,000
// documents (4x the threshold) is used here rather than a literal 56,000 to
// keep this test's own runtime reasonable; the aggregates are bounded SQL
// queries whose cost is dominated by the same json_each/GROUP BY shapes
// exercised at 5,100 elsewhere in this suite, not by row count in a way
// that would behave qualitatively differently at 56k.

let closeDb;
let ensureStorage;
let getDb;
let saveDocumentMetadataBatch;
let getDocumentServingAnalytics;
let tempDir;

const TOTAL_DOCUMENTS = 20000;

function fixtureDoc(index) {
  return {
    id: `bigscale-${String(index).padStart(6, '0')}`,
    title: `Big scale dissertation ${index}`,
    author: `Author ${index}`,
    year: 1980 + (index % 45),
    degree: index % 2 === 0 ? 'PhD' : 'EdD',
    program: `Program ${index % 8}`,
    affiliation: ['UBC'],
    supervisors: [`Supervisor ${index % 60}`],
    abstract: `Big scale fixture ${index}`,
    subjects: ['education'],
    conceptTerms: ['concept alpha', 'concept beta', `concept gamma ${index % 25}`],
    methodologies: [index % 2 === 0 ? 'Qualitative' : 'Quantitative'],
    charCount: 100 + index,
  };
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-sql-port-scale-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.NODE_ENV = 'test';
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');

  const db = await import('../src/db.js');
  ({ closeDb, ensureStorage, getDb, saveDocumentMetadataBatch, getDocumentServingAnalytics } = db);
  await ensureStorage();

  for (let start = 0; start < TOTAL_DOCUMENTS; start += 500) {
    const count = Math.min(500, TOTAL_DOCUMENTS - start);
    await saveDocumentMetadataBatch(Array.from({ length: count }, (_, offset) => ({
      doc: fixtureDoc(start + offset),
      syncKey: 'bigscale',
    })));
  }

  const client = await getDb();
  const now = new Date().toISOString();
  await client.execute({
    sql: `INSERT INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at) VALUES (1, 'Big topic', '[]', ?, 'test', ?)`,
    args: [TOTAL_DOCUMENTS, now],
  });
  for (let start = 0; start < TOTAL_DOCUMENTS; start += 1000) {
    const count = Math.min(1000, TOTAL_DOCUMENTS - start);
    await client.batch(Array.from({ length: count }, (_, offset) => ({
      sql: 'INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, 1, 0.9)',
      args: [`bigscale-${String(start + offset).padStart(6, '0')}`],
    })), 'write');
  }
});

test.after(async () => {
  await closeDb?.();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test('#15 scale: SQL-ported panels return real data at 4x the detailed-analytics threshold, promptly', async () => {
  const t0 = Date.now();
  const analytics = await getDocumentServingAnalytics({ syncKey: 'bigscale' });
  const elapsedMs = Date.now() - t0;

  assert.equal(analytics.metrics.recordCount, TOTAL_DOCUMENTS);

  assert.ok(analytics.supervisorNgramMatrix.supervisors.length > 0);
  assert.ok(analytics.supervisorNgramMatrix.matrix.some((row) => row.some((cell) => cell > 0)));

  assert.ok(analytics.conceptTimeline.length > 0);
  assert.ok(analytics.conceptTimeline.some((series) => series.data.length > 0));

  assert.ok(analytics.methodologyConceptMatrix.methodologies.length > 0);
  assert.ok(analytics.methodologyConceptMatrix.matrix.some((row) => row.some((cell) => cell > 0)));

  assert.ok(analytics.methodologyTopicMatrix.methodologies.length > 0);
  assert.ok(analytics.methodologyTopicMatrix.topics.length > 0);

  assert.notEqual(analytics.topicData, null);
  assert.ok(analytics.topicData.byYear.length > 0);
  assert.ok(analytics.topicData.byYear[0].data.length > 0);

  // Not a strict scaling-law assertion (single scale point) — just a sanity
  // bound that this is bounded SQL aggregation, not something that hangs a
  // request. metadataScaleServing.test.js exercises the same shape at 5,100
  // documents for direct before/after comparison of the panels' realness.
  assert.ok(elapsedMs < 5000, `getDocumentServingAnalytics took ${elapsedMs}ms at ${TOTAL_DOCUMENTS} documents`);
});
