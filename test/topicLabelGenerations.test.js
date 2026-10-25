import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Label overrides and labelling runs are scoped to the topics generation:
// BERTopic renumbers topics on every fit, so rows from another generation
// (or with NULL generation) must never be applied, shown or deleted.

let db;
let client;
let tempDir;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-label-gen-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  await db.ensureStorage();
  client = await db.getDb();
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

const NOW = '2026-10-25T00:00:00.000Z';

async function reset(generation) {
  for (const t of ['topic_label_candidates', 'topic_label_overrides', 'topic_label_runs', 'topics']) {
    await client.execute(`DELETE FROM ${t}`);
  }
  await db.setSetting('topics_generation', generation);
  for (const id of [1, 2]) {
    await client.execute({
      sql: 'INSERT INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, `Topic ${id}`, '[]', 5, 'm', NOW],
    });
  }
}

async function addRun(generation) {
  const r = await client.execute({
    sql: "INSERT INTO topic_label_runs (backend, model_name, status, started_at, generation) VALUES ('b', 'm', 'completed', ?, ?)",
    args: [NOW, generation],
  });
  return Number(r.lastInsertRowid);
}

async function addCandidate(runId, topicId, label, score = 90) {
  const r = await client.execute({
    sql: "INSERT INTO topic_label_candidates (run_id, topic_id, label, source, score, status, created_at) VALUES (?, ?, ?, 'x', ?, 'pending', ?)",
    args: [runId, topicId, label, score, NOW],
  });
  return Number(r.lastInsertRowid);
}

async function addOverride(topicId, generation) {
  await client.execute({
    sql: "INSERT INTO topic_label_overrides (topic_id, label, source, created_at, updated_at, generation) VALUES (?, 'Old', 'manual', ?, ?, ?)",
    args: [topicId, NOW, NOW, generation],
  });
}

test('stale overrides are hidden from the label review and do not block publishing', async () => {
  await reset('g-new');
  await addOverride(1, null);
  await addOverride(2, 'g-old');
  const run = await addRun('g-new');
  await addCandidate(run, 1, 'Fresh One');
  await addCandidate(run, 2, 'Fresh Two');
  const review = await db.listTopicLabelReviews();
  for (const t of review.topics) assert.equal(t.override, null);
  const result = await db.publishPassingTopicLabels();
  assert.equal(result.published, 2);
  const rows = (await client.execute('SELECT topic_id, label FROM topics ORDER BY topic_id')).rows;
  assert.deepEqual(rows.map((r) => r.label), ['Fresh One', 'Fresh Two']);
});

test('stale candidates are hidden', async () => {
  await reset('g-new');
  const oldRun = await addRun('g-old');
  const nullRun = await addRun(null);
  const newRun = await addRun('g-new');
  await addCandidate(oldRun, 1, 'Stale Old');
  await addCandidate(nullRun, 1, 'Stale Null');
  await addCandidate(newRun, 1, 'Current');
  const review = await db.listTopicLabelReviews();
  const labels = review.topics.find((t) => t.topicId === 1).candidates.map((c) => c.label);
  assert.deepEqual(labels, ['Current']);
  const published = await db.publishPassingTopicLabels();
  assert.equal(published.published, 1);
});

test('selecting a candidate or saving a manual label records the current generation', async () => {
  await reset('g-new');
  const run = await addRun('g-new');
  const cid = await addCandidate(run, 1, 'Pick Me');
  await db.selectTopicLabelCandidate(1, cid);
  await db.updateTopicManualLabel(2, 'Manual');
  const rows = (await client.execute('SELECT topic_id, generation FROM topic_label_overrides ORDER BY topic_id')).rows;
  assert.deepEqual(rows.map((r) => r.generation), ['g-new', 'g-new']);
});

function runPython(body) {
  const source = `
import importlib.util, json, os, tempfile
spec = importlib.util.spec_from_file_location("bt", "scripts/build-topics.py")
bt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)
d = tempfile.mkdtemp()
c = bt.SqliteClientWrapper(os.path.join(d, "t.sqlite"))
bt.ensure_topic_label_tables(c)
${body}
`;
  const out = execFileSync('python3', ['-c', source], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

test('load_topic_label_overrides returns only the requested generation', () => {
  const r = runPython(`
for tid, gen in [(1, None), (2, "g-old"), (3, "g-new")]:
    c.execute("INSERT INTO topic_label_overrides (topic_id, label, source, created_at, updated_at, generation) VALUES (?, 'L', 'manual', 'n', 'n', ?)", [tid, gen])
print(json.dumps({"new": {str(k): v for k, v in bt.load_topic_label_overrides(c, "g-new").items()}, "none": bt.load_topic_label_overrides(c, None)}))
`);
  assert.deepEqual(r.new, { 3: 'L' });
  assert.deepEqual(r.none, {});
});

test('save_topic_label_candidates stores the generation on the run', () => {
  const r = runPython(`
cands = {1: [{"label": "A", "source": "s", "score": 90, "warnings": [], "evidence": {}}]}
bt.save_topic_label_candidates(c, cands, "b", "m", None, "g-new")
bt.save_topic_label_candidates(c, cands, "b", "m")
print(json.dumps([r["generation"] for r in c.execute("SELECT generation FROM topic_label_runs ORDER BY id").rows]))
`);
  assert.deepEqual(r, ['g-new', null]);
});

test('ensure_topic_label_tables adds generation to pre-existing tables', () => {
  const r = runPython(`
c.execute("DROP TABLE topic_label_runs")
c.execute("DROP TABLE topic_label_overrides")
c.execute("CREATE TABLE topic_label_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, backend TEXT NOT NULL, model_name TEXT NOT NULL, status TEXT NOT NULL, config_json TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT)")
c.execute("CREATE TABLE topic_label_overrides (topic_id INTEGER PRIMARY KEY, label TEXT NOT NULL, source TEXT NOT NULL, candidate_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
bt.ensure_topic_label_tables(c)
bt.ensure_topic_label_tables(c)
cols = lambda t: [x["name"] for x in c.execute(f"PRAGMA table_info({t})").rows]
print(json.dumps([("generation" in cols("topic_label_runs")), ("generation" in cols("topic_label_overrides"))]))
`);
  assert.deepEqual(r, [true, true]);
});

test('choose_topic_labels with no overrides or existing labels never reuses a previous label', () => {
  const r = runPython(`
class M:
    def get_topic(self, tid):
        return [("alpha", 1.0), ("beta", 0.9), ("gamma", 0.8)]
info = bt.ExistingTopicInfo([{"Topic": 0, "Name": "0_alpha_beta"}])
cands = {0: [{"label": "Bad", "score": 10, "warnings": ["w"], "evidence": {}}]}
labels = bt.choose_topic_labels(M(), info, cands)
print(json.dumps({"label": labels[0], "default": bt.bertopic_default_label(M(), 0, {"Name": "0_alpha_beta"})}))
`);
  assert.equal(r.label, r.default);
  assert.notEqual(r.label, 'Bad');
});
