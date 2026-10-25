import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

// #59: the unfiltered visualizations payload is persisted per topics generation.

let tempDir;
let db;
let routes;
let client;

const SYNC_KEY = 'viz-snapshot-key';
const SENTINEL = '2000-01-01T00:00:00.000Z';
const loadSyncModule = async () => ({ getSyncKeyForOptions: () => SYNC_KEY });

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', routes.createMetricsRouter({
    metricsCache: new Map(), metricsInflight: new Map(), loadSyncModule,
  }));
  return app;
}

const snapshotRow = async () => (await client.execute({
  sql: 'SELECT generation, updated_at FROM serving_snapshots WHERE snapshot_key = ?',
  args: [routes.VISUALIZATIONS_SNAPSHOT_KEY],
})).rows[0];

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-viz-snapshot-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  await db.ensureStorage();
  for (let i = 1; i <= 3; i++) {
    await db.saveDocumentMetadata({
      id: `1.000000${i}`, title: `Dissertation ${i}`, author: `Author ${i}`, authors: [`Author ${i}`],
      supervisors: [], affiliation: ['UBC'], year: 2000 + i, degree: 'MA', program: 'Education',
      abstract: `Abstract ${i}`, subjects: ['education'], themes: [], methodologies: [], conceptTerms: [],
    }, { syncKey: SYNC_KEY });
  }
  client = await db.getDb();
  routes = await import('../src/routes/metricsRoutes.js');
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await client.execute('DELETE FROM serving_snapshots');
});

test('save then load round-trips the payload', async () => {
  const payload = { generatedAt: SENTINEL, items: Array.from({ length: 200 }, (_, i) => ({ i, t: 'repeated text' })) };
  await db.saveServingSnapshot('k', 'g1', payload);
  const loaded = await db.loadServingSnapshot('k');
  assert.deepEqual(loaded.payload, payload);
  assert.equal(loaded.generation, 'g1');
  const row = (await client.execute("SELECT payload_gz, typeof(payload_gz) AS t FROM serving_snapshots WHERE snapshot_key = 'k'")).rows[0];
  assert.equal(row.t, 'blob');
  assert.ok(row.payload_gz.byteLength < JSON.stringify(payload).length);
  assert.equal(await db.loadServingSnapshot('missing'), null);
});

test('a cold cache is seeded from a matching-generation snapshot without rebuilding', async () => {
  await db.saveServingSnapshot(routes.VISUALIZATIONS_SNAPSHOT_KEY, 'g1', { generatedAt: SENTINEL });
  await db.setSetting('topics_generation', 'g1');
  const res = await request(makeApp()).get('/api/workbench/visualizations');
  assert.equal(res.status, 200);
  assert.equal(res.body.generatedAt, SENTINEL);
});

test('a snapshot from an older generation is ignored', async () => {
  await db.saveServingSnapshot(routes.VISUALIZATIONS_SNAPSHOT_KEY, 'g1', { generatedAt: SENTINEL });
  await db.setSetting('topics_generation', 'g2');
  const res = await request(makeApp()).get('/api/workbench/visualizations');
  assert.equal(res.status, 200);
  assert.notEqual(res.body.generatedAt, SENTINEL);
  assert.equal((await snapshotRow()).generation, 'g2');
});

test('an undecodable snapshot falls through to a build', async () => {
  await db.setSetting('topics_generation', 'g3');
  await client.execute({
    sql: "INSERT INTO serving_snapshots (snapshot_key, generation, payload_gz, updated_at) VALUES (?, 'g3', X'00', ?)",
    args: [routes.VISUALIZATIONS_SNAPSHOT_KEY, new Date().toISOString()],
  });
  const res = await request(makeApp()).get('/api/workbench/visualizations');
  assert.equal(res.status, 200);
  assert.ok(res.body.generatedAt);
});

test('filtered requests neither read nor write snapshots', async () => {
  await db.saveServingSnapshot(routes.VISUALIZATIONS_SNAPSHOT_KEY, 'g4', { generatedAt: SENTINEL });
  await db.setSetting('topics_generation', 'g4');
  const before = await snapshotRow();
  const res = await request(makeApp()).get('/api/workbench/visualizations?degree=MA');
  assert.equal(res.status, 200);
  assert.notEqual(res.body.generatedAt, SENTINEL);
  assert.deepEqual(await snapshotRow(), before);
});
