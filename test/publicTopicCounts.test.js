import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

// #57: public topic counts (topics[].docCount and topicData.byYear) must be
// full-corpus, never derived from the bounded document page that the
// visualizations payload carries for the scatter.

let tempDir;
let app;
let closeDb;
let buildViz;

const SYNC_KEY = 'public-topic-counts-key';
const TOTAL = 6;
const loadSyncModule = async () => ({ getSyncKeyForOptions: () => SYNC_KEY });

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-public-topic-counts-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;

  const db = await import('../src/db.js');
  closeDb = db.closeDb;
  await db.ensureStorage();
  for (let i = 1; i <= TOTAL; i++) {
    await db.saveDocumentMetadata({
      id: `1.000000${i}`, title: `Dissertation ${i}`, author: `Author ${i}`, authors: [`Author ${i}`],
      supervisors: [], affiliation: ['UBC'], year: 2000 + (i % 2), degree: 'EdD', program: 'Education',
      abstract: `Abstract ${i}`, subjects: ['education'], themes: [], methodologies: [], conceptTerms: [],
    }, { syncKey: SYNC_KEY });
  }
  const client = await db.getDb();
  const now = new Date().toISOString();
  await client.execute({
    sql: `INSERT INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at) VALUES (0, '0_a_b', '[]', ?, 'test', ?)`,
    args: [TOTAL, now],
  });
  await client.batch(Array.from({ length: TOTAL }, (_, i) => ({
    sql: 'INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, 0, 0.9)',
    args: [`1.000000${i + 1}`],
  })), 'write');

  const routes = await import('../src/routes/metricsRoutes.js');
  buildViz = routes.buildWorkbenchVisualizationsPayload;
  app = express();
  app.use(express.json());
  app.use('/api', routes.createMetricsRouter({
    metricsCache: new Map(), metricsInflight: new Map(), loadSyncModule,
  }));
});

test.after(async () => {
  await closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

const total = (byYear) => byYear.reduce((n, t) => n + t.data.reduce((m, p) => m + p.count, 0), 0);

test('public analytics topic counts are full-corpus regardless of maxRecords', async () => {
  const res = await request(app).get('/api/workbench/analytics?maxRecords=2');
  assert.equal(res.status, 200);
  assert.equal(res.body.topicData.topics[0].docCount, TOTAL);
  assert.equal(total(res.body.topicData.byYear), TOTAL);
});

test('visualizations byYear counts come from SQL, not the bounded document page', async () => {
  const filters = {};
  const payload = await buildViz({ subjectLimit: 25 }, filters, loadSyncModule, { documentLimit: 2 });
  assert.equal(payload.documents.length, 2, 'scatter page is bounded');
  assert.equal(payload.topicData.topics[0].docCount, TOTAL);
  assert.equal(total(payload.topicData.byYear), TOTAL, 'byYear must cover all documents, not just the page');
});
