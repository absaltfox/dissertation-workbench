import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const PYTHON = existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3';

function hasNumpy() {
  try {
    execFileSync(PYTHON, ['-c', 'import numpy'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skipNumpy = hasNumpy() ? false : 'numpy is not installed';

function runPython(body, env = {}) {
  const source = `
import sys
sys.modules["torch"] = None
import importlib.util, json, os, sqlite3, tempfile
spec = importlib.util.spec_from_file_location("bt", "scripts/build-topics.py")
bt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)
${body}
`;
  const output = execFileSync(PYTHON, ['-c', source], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, BERTOPIC_MIN_TOPIC_SIZE: '', BERTOPIC_MAX_TOPICS: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output.trim().split('\n').pop());
}

test('resolve_min_topic_size scales with corpus size and floors at 5', () => {
  const r = runPython(`print(json.dumps([bt.resolve_min_topic_size(n) for n in (10, 100, 2500, 13655, 14000)]))`);
  assert.deepEqual(r, [5, 5, 5, 27, 28]);
});

test('cluster_model_params seeds UMAP and does not merge HDBSCAN clusters', () => {
  const r = runPython(`
umap_kw, hdb_kw = bt.cluster_model_params(27)
print(json.dumps({"umap": umap_kw, "hdbscan": hdb_kw, "seed": bt.TOPIC_RANDOM_STATE}))`);
  assert.deepEqual(r.umap, { n_neighbors: 15, n_components: 5, min_dist: 0.0, metric: 'cosine', random_state: 42 });
  assert.deepEqual(r.hdbscan, {
    min_cluster_size: 27, min_samples: 1, metric: 'euclidean', prediction_data: true,
  });
  assert.equal(r.seed, 42);
});

test('the clustering fit and the 2D projection use the shared seed', () => {
  const source = readFileSync('scripts/build-topics.py', 'utf8');
  assert.match(source, /umap_model=umap_model/);
  assert.match(source, /umap\.UMAP\(n_components=2, random_state=TOPIC_RANDOM_STATE/);
  assert.doesNotMatch(source, /random_state=42/);
});

test('resolve_min_topic_size honours a valid env override', () => {
  const r = runPython(`print(json.dumps(bt.resolve_min_topic_size(14000)))`, { BERTOPIC_MIN_TOPIC_SIZE: '12' });
  assert.equal(r, 12);
});

test('resolve_min_topic_size falls back on invalid env values', () => {
  for (const bad of ['abc', '0', '-3', '2.5', '1']) {
    const r = runPython(`print(json.dumps(bt.resolve_min_topic_size(14000)))`, { BERTOPIC_MIN_TOPIC_SIZE: bad });
    assert.equal(r, 28, bad);
  }
});

test('resolve_max_topics is unset by default and validates env', () => {
  assert.equal(runPython(`print(json.dumps(bt.resolve_max_topics()))`), null);
  assert.equal(runPython(`print(json.dumps(bt.resolve_max_topics()))`, { BERTOPIC_MAX_TOPICS: '40' }), 40);
  assert.equal(runPython(`print(json.dumps(bt.resolve_max_topics()))`, { BERTOPIC_MAX_TOPICS: 'x' }), null);
});

test('load_cached_embeddings caps per-row mismatch log lines', { skip: skipNumpy }, () => {
  const r = runPython(`
import io, contextlib
tmp = tempfile.mkdtemp()
client = bt.SqliteClientWrapper(os.path.join(tmp, "t.sqlite"))
client.execute("CREATE TABLE document_embeddings (doc_id TEXT PRIMARY KEY, embedding TEXT, created_at TEXT)")
client.execute("INSERT INTO document_embeddings VALUES ('a00', '[1,2,3]', 'x')")
ids = ["a00"]
for i in range(1, 13):
    client.execute("INSERT INTO document_embeddings VALUES (?, '[9,9]', 'x')", [f"a{i:02d}"])
    ids.append(f"a{i:02d}")
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    m, filled, dim = bt.load_cached_embeddings(client, ids, page_size=4)
lines = buf.getvalue().splitlines()
print(json.dumps({"ignoring": sum("Ignoring cached" in l for l in lines),
  "summary": [l for l in lines if "mismatched dimension" in l], "filled": int(filled.sum())}))
`);
  assert.equal(r.ignoring, 5);
  assert.equal(r.summary.length, 1);
  assert.match(r.summary[0], /12 cached/);
  assert.equal(r.filled, 1);
});

test('resolve_max_topics ignores values below 2', () => {
  for (const bad of ['1', '0']) {
    assert.equal(runPython(`print(json.dumps(bt.resolve_max_topics()))`, { BERTOPIC_MAX_TOPICS: bad }), null, bad);
  }
  assert.equal(runPython(`print(json.dumps(bt.resolve_max_topics()))`, { BERTOPIC_MAX_TOPICS: '2' }), 2);
});

test('embedding page size is 500', () => {
  assert.equal(runPython(`print(json.dumps(bt.EMBEDDING_PAGE_SIZE))`), 500);
});

test('label candidate writes are batched with unchanged semantics', () => {
  const r = runPython(`
tmp = tempfile.mkdtemp()
client = bt.SqliteClientWrapper(os.path.join(tmp, "t.sqlite"))
class Counting:
    def __init__(self, inner):
        self.inner = inner
        self.executes = 0
        self.batches = 0
    def execute(self, sql, params=None):
        if "INSERT INTO topic_label_candidates" in sql or "UPDATE topic_label_candidates" in sql:
            self.executes += 1
        return self.inner.execute(sql, params)
    def batch(self, statements):
        self.batches += 1
        return self.inner.batch(statements)
c = Counting(client)
bt.ensure_topic_label_tables(client)
cand = lambda label, score, warn=None: {"label": label, "source": "claude", "score": score, "warnings": warn or [], "evidence": {}}
first = {1: [cand("Old One", 90)], 2: [cand("Old Two", 90)]}
bt.save_topic_label_candidates(client, first, "claude", "m")
c.executes = 0
second = {1: [cand("Alpha Topic", 95), cand("Beta Topic", 70)], 2: [cand("Gamma Topic", 85, ["w"])]}
bt.save_topic_label_candidates(c, second, "claude", "m")
save_executes = c.executes
bt.mark_auto_selected_candidates(c, second, {-1: "Uncategorized", 1: "Alpha Topic", 2: "Gamma Topic"})
rows = client.execute("SELECT topic_id, label, status FROM topic_label_candidates ORDER BY id").rows
print(json.dumps({"save_executes": save_executes, "batches": c.batches, "rows": [[x["topic_id"], x["label"], x["status"]] for x in rows]}))
`);
  assert.equal(r.save_executes, 0, 'candidate rows go through batch, not per-row execute');
  assert.ok(r.batches >= 2);
  assert.deepEqual(r.rows, [
    [1, 'Old One', 'rejected'], [2, 'Old Two', 'rejected'],
    [1, 'Alpha Topic', 'auto_selected'], [1, 'Beta Topic', 'pending'], [2, 'Gamma Topic', 'pending'],
  ]);
});

test('claude label prompt uses the actual document count', () => {
  const src = readFileSync('scripts/build-topics.py', 'utf8');
  assert.ok(!src.includes('~418'));
  assert.match(src, /clustering \{len\(abstracts\)\} Education/);
});
