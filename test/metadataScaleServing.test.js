import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

let tempDir;
let closeDb;
let getDocumentServingAnalytics;
let getDocumentServingSummary;
let getDb;
let queryCachedDocumentPage;
let queryPeoplePage;
let queryPersonDetailPage;
let saveDocumentMetadataBatch;
let app;

const SYNC_KEY = 'metadata-scale-serving';
const TOTAL_DOCUMENTS = 5100;

function fixtureDoc(index) {
  const phd = index % 2 === 0;
  return {
    id: `scale-${String(index).padStart(5, '0')}`,
    title: `Scale dissertation ${String(index).padStart(5, '0')}`,
    author: `Author ${index}`,
    year: 1980 + (index % 45),
    degree: phd ? 'PhD' : 'EdD',
    program: `Program ${index % 8}`,
    affiliation: [phd ? 'UBC' : 'SFU'],
    supervisors: [`Supervisor ${index % 50}`, `Unique Supervisor ${index}`],
    abstract: `Metadata-scale fixture ${index}`,
    subjects: ['education'],
    themes: [`theme-${index % 12}`],
    conceptTerms: [`concept-${index % 20}`],
    methodologies: [`method-${index % 5}`],
    charCount: 100 + index,
  };
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-metadata-scale-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.NODE_ENV = 'test';
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');

  const db = await import('../src/db.js');
  ({
    closeDb,
    getDocumentServingAnalytics,
    getDocumentServingSummary,
    getDb,
    queryCachedDocumentPage,
    queryPeoplePage,
    queryPersonDetailPage,
    saveDocumentMetadataBatch,
  } = db);
  await db.ensureStorage();

  for (let start = 0; start < TOTAL_DOCUMENTS; start += 100) {
    const count = Math.min(100, TOTAL_DOCUMENTS - start);
    await saveDocumentMetadataBatch(Array.from({ length: count }, (_, offset) => ({
      doc: fixtureDoc(start + offset),
      syncKey: SYNC_KEY,
    })));
  }
  const client = await getDb();
  await client.execute({
    sql: `INSERT INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at)
          VALUES (1, 'Scale topic', '["scale"]', ?, 'test', ?)`,
    args: [TOTAL_DOCUMENTS, new Date().toISOString()],
  });
  for (let start = 0; start < TOTAL_DOCUMENTS; start += 500) {
    const count = Math.min(500, TOTAL_DOCUMENTS - start);
    await client.batch(Array.from({ length: count }, (_, offset) => ({
      sql: 'INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, 1, 0.9)',
      args: [`scale-${String(start + offset).padStart(5, '0')}`],
    })), 'write');
  }

  const { createMetricsRouter } = await import('../src/routes/metricsRoutes.js');
  app = express();
  app.use('/api', createMetricsRouter({
    metricsCache: new Map(),
    metricsInflight: new Map(),
    loadSyncModule: async () => ({ getSyncKeyForOptions: () => SYNC_KEY }),
  }));
});

test.after(async () => {
  await closeDb?.();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test('metadata-scale bootstrap aggregates remain corpus-complete and compact', async () => {
  const summary = await getDocumentServingSummary({ syncKey: SYNC_KEY });
  assert.equal(summary.documents, TOTAL_DOCUMENTS);
  assert.equal(summary.supervisors, TOTAL_DOCUMENTS + 50);
  assert.deepEqual(summary.facets.degree, ['EdD', 'PhD']);
  assert.deepEqual(summary.facets.affiliation, ['SFU', 'UBC']);
  assert.equal(JSON.stringify(summary).length < 10_000, true);
});

test('filtered search and sorting are applied before the document page is materialized', async () => {
  const page = await queryCachedDocumentPage({
    syncKey: SYNC_KEY,
    filters: { degree: 'PhD', affiliation: 'The University of British Columbia' },
    sortKey: 'title',
    sortDir: 'desc',
    limit: 25,
    offset: 0,
  });
  assert.equal(page.total, TOTAL_DOCUMENTS / 2);
  assert.equal(page.documents.length, 25);
  assert.equal(page.documents[0].id, 'scale-05098');

  const search = await queryCachedDocumentPage({
    syncKey: SYNC_KEY,
    q: 'scale dissertation 00777',
    limit: 10,
  });
  assert.equal(search.total, 1);
  assert.equal(search.documents[0].id, 'scale-00777');
});

test('database analytics aggregate the full filtered corpus without returning document rows', async () => {
  const analytics = await getDocumentServingAnalytics({
    syncKey: SYNC_KEY,
    filters: { program: 'Program 3' },
    subjectLimit: 10,
  });
  assert.equal(analytics.metrics.recordCount, 638);
  assert.equal(analytics.documents.length, 0);
  assert.equal(analytics.ngramCloud.length <= 10, true);
  assert.equal(analytics.wordCloud.length <= 70, true);
  assert.equal(JSON.stringify(analytics).length < 100_000, true);
});

test('workbench switches to bounded database analytics above the detailed-corpus threshold', async () => {
  const response = await request(app)
    .get('/api/workbench/analytics?maxRecords=1')
    .expect('content-type', /application\/json/)
    .expect(200);
  assert.equal(response.body.metrics.recordCount, TOTAL_DOCUMENTS);
  assert.equal(response.body.source.aggregateSource, 'database');
  assert.equal(response.body.source.documentsTruncated, true);
  assert.equal(response.body.documents.length, 100);
});

test('people projection merges references and paginates before returning rows', async () => {
  const page = await queryPeoplePage({
    syncKey: SYNC_KEY,
    sortKey: 'docCount',
    sortDir: 'desc',
    limit: 10,
    offset: 0,
  });
  assert.equal(page.total, TOTAL_DOCUMENTS + 50);
  assert.equal(page.people.length, 10);
  assert.equal(page.people.every((person) => person.docCount === 102), true);
});

test('person detail returns corpus aggregates with a bounded document page', async () => {
  const page = await queryPersonDetailPage({
    personKey: 'supervisor 0',
    syncKey: SYNC_KEY,
    limit: 5,
  });
  assert.equal(page.person.docCount, 102);
  assert.equal(page.documents.length, 5);
  assert.equal(page.person.roles.includes('Supervisor'), true);
});

test('topic visualizations expose an explicit bounded document sample', async () => {
  const response = await request(app)
    .get('/api/workbench/visualizations')
    .expect('content-type', /application\/json/)
    .expect(200);
  assert.equal(response.body.source.documentsAvailable, TOTAL_DOCUMENTS);
  assert.equal(response.body.source.documentsReturned, 5000);
  assert.equal(response.body.source.documentsTruncated, true);
  assert.equal(response.body.documents.length, 5000);
});
