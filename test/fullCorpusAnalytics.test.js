import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

let tempDir;
let app;
let saveDocumentMetadata;
let closeDb;

const SYNC_KEY = 'full-corpus-test-key';
const loadSyncModule = async () => ({ getSyncKeyForOptions: () => SYNC_KEY });

function makeDoc(i) {
  return {
    id: `1.000000${i}`,
    title: `Dissertation ${i}`,
    author: `Author ${i}`,
    authors: [`Author ${i}`],
    supervisors: [],
    affiliation: ['UBC'],
    year: 2000 + i,
    degree: 'EdD',
    program: 'Education',
    abstract: `Abstract text for dissertation number ${i} about adult education.`,
    subjects: ['education'],
    themes: [],
    methodologies: [],
    conceptTerms: [],
  };
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-full-corpus-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;

  const db = await import('../src/db.js');
  saveDocumentMetadata = db.saveDocumentMetadata;
  closeDb = db.closeDb;
  await db.ensureStorage();

  for (let i = 1; i <= 5; i++) {
    await saveDocumentMetadata(makeDoc(i), { syncKey: SYNC_KEY });
  }

  const { createMetricsRouter } = await import('../src/routes/metricsRoutes.js');
  app = express();
  app.use(express.json());
  app.use('/api', createMetricsRouter({
    metricsCache: new Map(),
    metricsInflight: new Map(),
    loadSyncModule,
  }));
});

test.after(async () => {
  await closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('analytics covers the entire corpus even when maxRecords is small', async () => {
  const res = await request(app).get('/api/workbench/analytics?maxRecords=2');
  assert.equal(res.status, 200);
  assert.equal(res.body.metrics.recordCount, 5);
  assert.equal(res.body.documents.length, 5);
});

test('document page total reflects the full corpus', async () => {
  const res = await request(app).get('/api/workbench/documents?maxRecords=2&limit=2&offset=0');
  assert.equal(res.status, 200);
  assert.equal(res.body.source.total, 5);
  assert.equal(res.body.documents.length, 2);
  assert.equal(res.body.source.hasMore, true);
});

test('bootstrap summary counts the full corpus', async () => {
  const res = await request(app).get('/api/workbench/bootstrap?maxRecords=1');
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.documents, 5);
});

test('person explorer merges middle-initial name variants', async () => {
  await saveDocumentMetadata({
    ...makeDoc(6),
    id: '1.0000006',
    supervisors: ['Deirdre M. Kelly'],
  }, { syncKey: SYNC_KEY });
  await saveDocumentMetadata({
    ...makeDoc(7),
    id: '1.0000007',
    supervisors: ['Deirdre Kelly'],
  }, { syncKey: SYNC_KEY });

  const res = await request(app).get('/api/workbench/people?q=kelly');
  assert.equal(res.status, 200);
  const kellys = res.body.people.filter((p) => /kelly/i.test(p.name));
  assert.equal(kellys.length, 1);
  assert.equal(kellys[0].docCount, 2);
});
