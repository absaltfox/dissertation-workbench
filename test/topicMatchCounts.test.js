import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Topic Hierarchy under filters: per-topic match counts come from SQL over the
// whole filtered set, counting each manuscript toward its best topic only (the
// same rule the clicked topic list uses).

let tempDir;
let closeDb;
let getTopicMatchCounts;
let buildViz;

const SYNC_KEY = 'topic-match-counts-key';
const EDD = 'Doctor of Education - EdD';
const PHD = 'Doctor of Philosophy - PhD';
const loadSyncModule = async () => ({ getSyncKeyForOptions: () => SYNC_KEY });

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-topic-match-counts-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;

  const db = await import('../src/db.js');
  closeDb = db.closeDb;
  getTopicMatchCounts = db.getTopicMatchCounts;
  await db.ensureStorage();
  for (let i = 1; i <= 6; i++) {
    await db.saveDocumentMetadata({
      id: `1.000000${i}`, title: `Manuscript ${i}`, author: `Author ${i}`, authors: [`Author ${i}`],
      supervisors: [], affiliation: ['UBC'], year: 2000 + i, degree: i <= 3 ? EDD : PHD, program: 'Education',
      abstract: `Abstract ${i}`, subjects: ['education'], themes: [], methodologies: [], conceptTerms: [],
    }, { syncKey: SYNC_KEY });
  }
  const client = await db.getDb();
  const now = new Date().toISOString();
  await client.batch([0, 1, 2].map((id) => ({
    sql: `INSERT INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at) VALUES (?, ?, '[]', 2, 'test', ?)`,
    args: [id, `${id}_t`, now],
  })), 'write');
  // doc -> [topic, probability]; doc 1 also has a weaker topic-1 assignment.
  const rows = [
    ['1.0000001', 0, 0.9], ['1.0000001', 1, 0.4],
    ['1.0000002', 0, 0.8], ['1.0000003', 1, 0.7],
    ['1.0000004', 2, 0.9], ['1.0000005', 2, 0.9], ['1.0000006', 1, 0.6],
  ];
  await client.batch(rows.map(([doc, topic, p]) => ({
    sql: 'INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, ?, ?)',
    args: [doc, topic, p],
  })), 'write');

  const routes = await import('../src/routes/metricsRoutes.js');
  buildViz = routes.buildWorkbenchVisualizationsPayload;
});

test.after(async () => {
  await closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('counts each manuscript once, toward its best topic', async () => {
  const counts = await getTopicMatchCounts({ syncKey: SYNC_KEY, filters: { degree: EDD } });
  assert.deepEqual(counts, { 0: 2, 1: 1 });
});

test('different filters give different counts', async () => {
  const edd = await getTopicMatchCounts({ syncKey: SYNC_KEY, filters: { degree: EDD } });
  const phd = await getTopicMatchCounts({ syncKey: SYNC_KEY, filters: { degree: PHD } });
  assert.deepEqual(phd, { 1: 1, 2: 2 });
  assert.notDeepEqual(edd, phd);
});

test('visualizations payload carries matchCounts only when filtered', async () => {
  const unfiltered = await buildViz({ subjectLimit: 25 }, { degree: '', program: '', affiliation: '' }, loadSyncModule);
  assert.equal(unfiltered.topicData.matchCounts, undefined);
  const filters = { degree: EDD, program: '', affiliation: '' };
  const filtered = await buildViz({ subjectLimit: 25 }, filters, loadSyncModule);
  assert.deepEqual(filtered.topicData.matchCounts, await getTopicMatchCounts({ syncKey: SYNC_KEY, filters }));
});
