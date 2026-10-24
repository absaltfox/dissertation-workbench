import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

function runPython(body) {
  const source = `
import importlib.util, json, os, sqlite3, tempfile
spec = importlib.util.spec_from_file_location("bt", "scripts/build-topics.py")
bt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)
tmp = tempfile.mkdtemp()
client = bt.SqliteClientWrapper(os.path.join(tmp, "t.sqlite"))
def count(t):
    return client.execute(f"SELECT COUNT(*) AS c FROM {t}").rows[0]["c"]
def tables():
    return sorted(r["name"] for r in client.execute("SELECT name FROM sqlite_master WHERE type='table'").rows)
bt.ensure_live_topic_tables(client)
client.execute("INSERT INTO topics VALUES (1, 'old', '[]', 1, 'm', 't')")
client.execute("INSERT INTO document_topics VALUES ('d_old', 1, 0.5)")
client.execute("INSERT INTO document_topic_coords VALUES ('d_old', 0.1, 0.2)")
client.execute("INSERT INTO topic_hierarchy_meta VALUES (1, '[1]', '[]', 't')")
def stage():
    bt.prepare_staging_topic_tables(client)
    bt.write_rows(client, "INSERT OR REPLACE INTO topics_next (topic_id, label, top_terms, doc_count, model_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [[7, 'new', '[]', 2, 'm', 't2'], [8, 'new2', '[]', 1, 'm', 't2']])
    bt.write_rows(client, "INSERT OR REPLACE INTO document_topics_next (doc_id, topic_id, probability) VALUES (?, ?, ?)",
        [['d1', 7, 0.9], ['d2', 8, 0.8]])
    bt.write_rows(client, "INSERT OR REPLACE INTO document_topic_coords_next (doc_id, umap_x, umap_y) VALUES (?, ?, ?)",
        [['d1', 1.0, 2.0], ['d2', 3.0, 4.0]])
    client.execute("INSERT OR REPLACE INTO topic_hierarchy_meta_next (id, leaf_topic_ids, linkage_json, created_at) VALUES (1, '[7,8]', '[[0,1]]', 't2')")
${body}
`;
  return JSON.parse(execFileSync('python3', ['-c', source], { cwd: process.cwd(), encoding: 'utf8' }));
}

test('live topic tables keep old rows until the swap, then hold staged rows and staging is gone', () => {
  const r = runPython(`
stage()
before = {"topics": count("topics"), "labels": [x["label"] for x in client.execute("SELECT label FROM topics").rows],
          "dt": count("document_topics"), "staged": count("topics_next")}
bt.publish_staged_topics(client)
print(json.dumps({"before": before,
  "labels": sorted(x["label"] for x in client.execute("SELECT label FROM topics").rows),
  "dt": sorted(x["doc_id"] for x in client.execute("SELECT doc_id FROM document_topics").rows),
  "coords": sorted(x["doc_id"] for x in client.execute("SELECT doc_id FROM document_topic_coords").rows),
  "hier": client.execute("SELECT leaf_topic_ids FROM topic_hierarchy_meta").rows[0]["leaf_topic_ids"],
  "tables": tables()}))
`);
  assert.deepEqual(r.before, { topics: 1, labels: ['old'], dt: 1, staged: 2 });
  assert.deepEqual(r.labels, ['new', 'new2']);
  assert.deepEqual(r.dt, ['d1', 'd2']);
  assert.deepEqual(r.coords, ['d1', 'd2']);
  assert.equal(r.hier, '[7,8]');
  assert.ok(r.tables.every((t) => !t.endsWith('_next')), r.tables.join());
});

test('a failed swap rolls back and leaves live rows intact', () => {
  const r = runPython(`
stage()
client.execute("DROP TABLE document_topic_coords_next")
try:
    bt.publish_staged_topics(client)
    failed = False
except Exception:
    failed = True
print(json.dumps({"failed": failed,
  "labels": [x["label"] for x in client.execute("SELECT label FROM topics").rows],
  "dt": [x["doc_id"] for x in client.execute("SELECT doc_id FROM document_topics").rows],
  "coords": [x["doc_id"] for x in client.execute("SELECT doc_id FROM document_topic_coords").rows],
  "hier": count("topic_hierarchy_meta")}))
`);
  assert.equal(r.failed, true);
  assert.deepEqual(r.labels, ['old']);
  assert.deepEqual(r.dt, ['d_old']);
  assert.deepEqual(r.coords, ['d_old']);
  assert.equal(r.hier, 1);
});

test('cleanup drops staging tables without touching live rows, and staging inserts are idempotent', () => {
  const r = runPython(`
stage()
# a retried chunk after an ambiguous commit must not hit a primary-key conflict
bt.write_rows(client, "INSERT OR REPLACE INTO document_topics_next (doc_id, topic_id, probability) VALUES (?, ?, ?)",
    [['d1', 7, 0.9]])
staged_dt = count("document_topics_next")
bt.drop_staging_topic_tables(client)
bt.drop_staging_topic_tables(client)
print(json.dumps({"staged_dt": staged_dt, "tables": tables(), "topics": count("topics")}))
`);
  assert.equal(r.staged_dt, 2);
  assert.ok(r.tables.every((t) => !t.endsWith('_next')));
  assert.equal(r.topics, 1);
});

test('prepare_staging_topic_tables empties leftover staging rows from a crashed run', () => {
  const r = runPython(`
stage()
bt.prepare_staging_topic_tables(client)
print(json.dumps({"n": count("topics_next") + count("document_topics_next") + count("document_topic_coords_next") + count("topic_hierarchy_meta_next")}))
`);
  assert.equal(r.n, 0);
});

test('staging_swap_committed distinguishes a committed swap from a rolled-back one', () => {
  const r = runPython(`
stage()
rolled_back = bt.staging_swap_committed(client)
bt.publish_staged_topics(client)
committed = bt.staging_swap_committed(client)
class Broken:
    def execute(self, *a, **k):
        raise RuntimeError("down")
print(json.dumps({"rolled_back": rolled_back, "committed": committed, "broken": bt.staging_swap_committed(Broken())}))
`);
  assert.equal(r.rolled_back, false);
  assert.equal(r.committed, true);
  assert.equal(r.broken, false);
});
