import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Persisted research-area bands drive Topic Evolution's byYear series, with
// generation-scoped manual names and a cache version that tracks band changes.

let db;
let client;
let tempDir;
let metrics;
let hierarchyLib;

const NOW = '2026-11-02T00:00:00.000Z';
const SYNC_KEY = 'bands-sync';

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-bands-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  metrics = await import('../src/metrics.js');
  hierarchyLib = await import('../src/topicHierarchy.js');
  await db.ensureStorage();
  client = await db.getDb();
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

const NTOPICS = 12;
let docs = [];

async function seed({ bands = true, generation = 'g1' } = {}) {
  for (const t of ['topics', 'document_topics', 'topic_bands', 'topic_band_label_overrides', 'topic_hierarchy_meta', 'documents']) {
    await client.execute(`DELETE FROM ${t}`);
  }
  await db.setSetting('topics_generation', generation);
  await db.setSetting('topic_bands_version', '2026-11-02T00:00:00Z');
  docs = [];
  for (let t = 0; t < NTOPICS; t++) {
    await client.execute({
      sql: 'INSERT INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [t, `Topic ${t}`, '[]', 20 - t, 'm', NOW],
    });
    const id = `1.${String(t).padStart(7, '0')}`;
    const year = 2000 + (t % 4);
    await db.saveDocumentMetadata({
      id, title: `T${t}`, author: `A${t}`, authors: [`A${t}`], supervisors: [], affiliation: ['UBC'],
      year, degree: 'MA', program: 'Education', abstract: 'x', subjects: ['e'], themes: [],
      methodologies: [], conceptTerms: [],
    }, { syncKey: SYNC_KEY });
    await client.execute({ sql: 'INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, ?, 1)', args: [id, t] });
    docs.push({ id, topicId: t, year });
  }
  if (bands) {
    for (let b = 0; b < NTOPICS; b++) {
      await client.execute({
        sql: 'INSERT INTO topic_bands (band_id, label, child_topic_ids, doc_count, created_at) VALUES (?, ?, ?, ?, ?)',
        args: [b, `Band ${b}`, JSON.stringify([b]), 20 - b, NOW],
      });
    }
  }
}

test('byYear uses band names and every band', async () => {
  await seed();
  const byYear = await db.getTopicByYearCounts({ syncKey: SYNC_KEY });
  assert.equal(byYear.length, 12);
  assert.deepEqual(byYear.map((s) => s.label), Array.from({ length: 12 }, (_, i) => `Band ${i}`));
  assert.ok(byYear.every((s) => s.data.length === 1 && s.data[0].count === 1));
});

test('JS and SQL by-year paths agree with bands', async () => {
  await seed();
  const topics = await db.loadTopics();
  const bands = await db.loadTopicBands();
  const sql = await db.getTopicByYearCounts({ syncKey: SYNC_KEY });
  const js = metrics.buildTopicVisualizations(docs, { topics, hierarchy: null, bands }).topicData.byYear;
  assert.deepEqual(js, sql);
});

test('override applies only for the current generation and same children', async () => {
  await seed();
  assert.equal((await db.loadTopicBands())[0].label, 'Band 0');
  assert.deepEqual(await db.updateTopicBandManualLabel(0, ' Custom '), { bandId: 0, label: 'Custom' });
  let b0 = (await db.loadTopicBands())[0];
  assert.equal(b0.label, 'Custom');
  assert.equal(b0.autoLabel, 'Band 0');
  assert.equal(b0.hasOverride, true);
  assert.equal(await db.updateTopicBandManualLabel(99, 'x'), null);

  await db.setSetting('topics_generation', 'g2');
  b0 = (await db.loadTopicBands())[0];
  assert.equal(b0.label, 'Band 0');
  assert.equal(b0.hasOverride, false);

  await db.setSetting('topics_generation', 'g1');
  assert.equal((await db.loadTopicBands())[0].label, 'Custom');
  await client.execute("UPDATE topic_bands SET child_topic_ids = '[0,5]' WHERE band_id = 0");
  assert.equal((await db.loadTopicBands())[0].label, 'Band 0');
});

test('delete override restores the auto label', async () => {
  await seed();
  await db.updateTopicBandManualLabel(1, 'Mine');
  assert.equal(await db.deleteTopicBandLabelOverride(1), true);
  assert.equal((await db.loadTopicBands())[1].label, 'Band 1');
  assert.equal(await db.deleteTopicBandLabelOverride(1), false);
});

test('no bands falls back to today\'s clusters', async () => {
  await seed({ bands: false });
  assert.equal(await db.loadTopicBands(), null);
  const topics = await db.loadTopics();
  const byYear = await db.getTopicByYearCounts({ syncKey: SYNC_KEY });
  assert.equal(byYear.length, 10);
  assert.deepEqual(byYear, hierarchyLib.buildTopicsByYearFromCounts(topics,
    docs.map((d) => ({ topicId: d.topicId, year: d.year, count: 1 })), null));
  assert.equal(hierarchyLib.resolveTopicGrouping(null, topics, null), null);
  assert.equal(hierarchyLib.resolveTopicGrouping(null, topics, []), null);
});

test('cache version changes when bands change', async () => {
  await seed();
  const before = await db.getTopicsCacheVersion();
  assert.match(before, /^g1\|/);
  await new Promise((r) => setTimeout(r, 5));
  await db.updateTopicBandManualLabel(0, 'Renamed');
  const after = await db.getTopicsCacheVersion();
  assert.notEqual(after, before);
  await db.setSetting('topics_generation', '');
  await client.execute("DELETE FROM settings WHERE key = 'topics_generation'");
  assert.equal(await db.getTopicsCacheVersion(), null);
});
