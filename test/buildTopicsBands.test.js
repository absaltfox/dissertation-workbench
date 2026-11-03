import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const PYTHON = existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3';

function hasScipy() {
  try {
    execFileSync(PYTHON, ['-c', 'import numpy, scipy'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skipScipy = hasScipy() ? false : 'numpy/scipy are not installed';

function runPython(body, env = {}) {
  const source = `
import sys
sys.modules["torch"] = None
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("bt", "scripts/build-topics.py")
bt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)
${body}
`;
  const output = execFileSync(PYTHON, ['-c', source], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, TOPIC_BANDS_MIN: '', TOPIC_BANDS_MAX: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output.trim().split('\n').pop());
}

test('choose_band_count picks the largest relative gap in range', () => {
  const r = runPython(`print(json.dumps(bt.choose_band_count([1,1.1,1.2,1.3,1.4,1.5,2.5,2.6,2.7,2.8,4.0], 12, 3, 8)))`);
  assert.equal(r, 6);
});

test('choose_band_count ties go to the smaller k', () => {
  // gap(6) = (h[6]-h[5])/h[5] = 1 and gap(8) = (h[4]-h[3])/h[3] = 1 exactly; all other k score 0.
  const r = runPython(`print(json.dumps(bt.choose_band_count([1,1,1,1,2,2,4,4,4,4,4], 12, 3, 9)))`);
  assert.equal(r, 6);
});

test('choose_band_count returns n when n is at or below the minimum', () => {
  assert.equal(runPython(`print(json.dumps(bt.choose_band_count([1,2,3], 4, 6, 15)))`), 4);
});

test('choose_band_count does not divide by zero', () => {
  const r = runPython(`print(json.dumps(bt.choose_band_count([0,0,0,1,2,3,4,5,6], 10, 6, 9)))`);
  assert.equal(r, 7);
});

test('choose_band_count never scores k=1 when k_min is 1', () => {
  const r = runPython(`print(json.dumps(bt.choose_band_count([1.,2.,3.], 4, 1, 3)))`);
  assert.ok(r >= 2 && r <= 3);
});

test('choose_band_count falls back to k_min when every candidate is skipped', () => {
  assert.equal(runPython(`print(json.dumps(bt.choose_band_count([0,0,0,0,0,0,0,0,0], 10, 6, 9)))`), 6);
});

test('topic_centroids are unit length and mean-centred', { skip: skipScipy }, () => {
  const r = runPython(`
import numpy as np
rng = np.random.default_rng(0)
emb = rng.normal(size=(13, 5))
assign = [0]*4 + [1]*4 + [2]*4 + [-1]
c = bt.topic_centroids(emb, assign, [0, 1, 2])
try:
    bt.topic_centroids(emb, assign, [0, 1, 7])
    err = None
except ValueError as e:
    err = str(e)
# manual reference
mask = np.array(assign) != -1
centred = emb - emb[mask].mean(axis=0)
ref = np.vstack([centred[np.array(assign) == t].mean(axis=0) for t in (0, 1, 2)])
ref /= np.linalg.norm(ref, axis=1, keepdims=True)
print(json.dumps({"shape": list(c.shape), "norms": np.linalg.norm(c, axis=1).tolist(), "match": bool(np.allclose(c, ref)), "err": err}))
`);
  assert.deepEqual(r.shape, [3, 5]);
  for (const n of r.norms) assert.ok(Math.abs(n - 1) < 1e-9);
  assert.equal(r.match, true);
  assert.match(r.err, /7/);
});

test('cut_bands on two obvious blobs', { skip: skipScipy }, () => {
  const r = runPython(`
import numpy as np
cent = np.array([[1,0,0],[1.01,0.01,0],[0.99,0,0.01],[0,1,0],[0.01,1.01,0],[0,0.99,0.01]], dtype=float)
ids = [10, 11, 12, 20, 21, 22]
counts = {10: 5, 11: 5, 12: 5, 20: 4, 21: 4, 22: 4}
Z = bt.centroid_linkage(cent)
print(json.dumps(bt.cut_bands(Z, ids, counts, 2)))
`);
  assert.deepEqual(r, [
    { band_id: 0, child_topic_ids: [10, 11, 12], doc_count: 15 },
    { band_id: 1, child_topic_ids: [20, 21, 22], doc_count: 12 },
  ]);
});

test('resolve_band_range defaults, honours env, and rejects min > max', () => {
  assert.deepEqual(runPython(`print(json.dumps(bt.resolve_band_range()))`), [6, 15]);
  assert.deepEqual(runPython(`print(json.dumps(bt.resolve_band_range()))`, { TOPIC_BANDS_MIN: '4', TOPIC_BANDS_MAX: '9' }), [4, 9]);
  assert.deepEqual(runPython(`print(json.dumps(bt.resolve_band_range()))`, { TOPIC_BANDS_MIN: '10', TOPIC_BANDS_MAX: '5' }), [6, 15]);
});

test('resolve_band_range clamps the minimum to 2 and keeps defaults when min > max after clamping', () => {
  assert.deepEqual(runPython(`print(json.dumps(bt.resolve_band_range()))`, { TOPIC_BANDS_MIN: '1', TOPIC_BANDS_MAX: '9' }), [2, 9]);
  assert.deepEqual(runPython(`print(json.dumps(bt.resolve_band_range()))`, { TOPIC_BANDS_MIN: '1', TOPIC_BANDS_MAX: '1' }), [6, 15]);
});

test('cut_bands may return fewer than k bands with contiguous ids when heights tie', { skip: skipScipy }, () => {
  const r = runPython(`
import numpy as np
cent = np.array([[1,0,0],[1,0,0],[1,0,0],[0,1,0]], dtype=float)
Z = bt.centroid_linkage(cent)
print(json.dumps(bt.cut_bands(Z, [1, 2, 3, 4], {1: 1, 2: 1, 3: 1, 4: 1}, 3)))
`);
  assert.ok(r.length <= 3);
  assert.deepEqual(r.map((b) => b.band_id), r.map((_, i) => i));
  assert.equal(r.reduce((a, b) => a + b.doc_count, 0), 4);
});

test('cut_bands breaks doc_count ties by smallest child topic id', { skip: skipScipy }, () => {
  const r = runPython(`
import numpy as np
cent = np.array([[0,1,0],[0.01,1.01,0],[0,0.99,0.01],[1,0,0],[1.01,0.01,0],[0.99,0,0.01]], dtype=float)
ids = [20, 21, 22, 10, 11, 12]
counts = {t: 4 for t in ids}
print(json.dumps(bt.cut_bands(bt.centroid_linkage(cent), ids, counts, 2)))
`);
  assert.deepEqual(r.map((b) => b.child_topic_ids[0]), [10, 20]);
});

const BAND_SETUP = `
bands = [{"band_id": 0, "child_topic_ids": [1, 2], "doc_count": 30, "child_doc_counts": {1: 10, 2: 20}}]
labels = {1: "Gill Function", 2: "Fish Physiology"}
terms = {1: [("gill", 0.5)], 2: [("fish", 0.9), ("gill", 0.1)]}
titles = {1: ["T one"], 2: ["T two", "T three", "T four"]}
`;

test('generate_band_labels falls back to a whole-band name', () => {
  const r = runPython(`${BAND_SETUP}
bt.complete_band_names = lambda *a, **k: {}
print(json.dumps(bt.generate_band_labels(bands, labels, terms, titles)))`);
  assert.deepEqual(r, { 0: 'Fish Physiology and related topics' });
});

const BIG_BAND_SETUP = `
ids = list(range(1, 12))
bands = [{"band_id": 0, "child_topic_ids": ids, "doc_count": 500,
          "child_doc_counts": {t: (400 if t == 1 else 10) for t in ids}}]
labels = {t: f"Child Label Number {t} With A Fairly Long Descriptive Name" for t in ids}
terms = {t: [(f"term{t}a", 0.9), (f"term{t}b", 0.5)] for t in ids}
titles = {t: [f"Dissertation title {t}x", f"Dissertation title {t}y"] for t in ids}
`;

test('generate_band_labels prompts with every child label, titles and a whole-band ask', () => {
  const r = runPython(`${BIG_BAND_SETUP}
seen = {}
def fake(prompts, reporter=None):
    seen["prompts"] = prompts
    return {0: "Teaching and Learning Contexts"}
bt.complete_band_names = fake
def boom(*a, **k):
    raise AssertionError("per-topic labeller must not be used for bands")
bt.generate_labels = boom
out = bt.generate_band_labels(bands, labels, terms, titles)
print(json.dumps({"out": out, "prompts": {str(k): v for k, v in seen["prompts"].items()}}))`);
  assert.equal(r.out['0'], 'Teaching and Learning Contexts');
  const prompt = r.prompts['0'];
  for (let t = 1; t <= 11; t++) assert.ok(prompt.includes(`Child Label Number ${t} With A Fairly Long Descriptive Name`), `label ${t}`);
  assert.ok(prompt.includes('Dissertation title 1x'));
  assert.match(prompt, /\(2 to 6 words\) that covers the WHOLE band/);
  assert.match(prompt, /cross-department research theme/);
  assert.doesNotMatch(prompt, /abstract/i);
  assert.doesNotMatch(prompt, /Sample/);
  // the 400-paper child must not crowd out the others: terms come from several children
  const termChildren = new Set([...prompt.matchAll(/term(\d+)a/g)].map((m) => m[1]));
  assert.ok(termChildren.size >= 8, `terms drawn from ${termChildren.size} children`);
});

test('the full-rebuild hierarchy no longer uses topic_embeddings_', () => {
  const src = readFileSync('scripts/build-topics.py', 'utf8');
  const main = src.slice(src.indexOf('\ndef main('));
  assert.ok(!main.includes('topic_embeddings_'));
  assert.ok(!main.includes('cosine_similarity('));
});

const BANDS_DB_SETUP = `
import tempfile, sqlite3
tmp = tempfile.mkdtemp()
db = os.path.join(tmp, "t.sqlite")
client = bt.SqliteClientWrapper(db)
client.execute("CREATE TABLE documents (doc_id TEXT PRIMARY KEY, metadata_json TEXT)")
client.execute("CREATE TABLE document_embeddings (doc_id TEXT PRIMARY KEY, embedding TEXT NOT NULL, created_at TEXT NOT NULL)")
client.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)")
client.execute("CREATE TABLE topic_label_overrides (topic_id INTEGER, generation TEXT, label TEXT)")
bt.ensure_live_topic_tables(client)
client.execute("INSERT INTO settings VALUES ('topics_generation', 'g1', 'x')")
client.execute("INSERT INTO topic_label_overrides VALUES (3, 'g1', 'Manual Name')")
import random
rnd = random.Random(1)
def vec(t):
    base = [0.0] * 6
    base[0 if t < 4 else 3] = 5.0
    base[1 + t % 2] += 1.0 * (t % 4)
    return [b + rnd.gauss(0, 0.05) for b in base]
for t in range(8):
    client.execute("INSERT INTO topics VALUES (?, ?, ?, ?, 'm', 'c')", [t, f"Topic {t}", json.dumps([[f"term{t}", 0.5]]), 3])
    for j in range(3):
        d = f"d{t}_{j}"
        client.execute("INSERT INTO document_topics VALUES (?, ?, 0.9)", [d, t])
        client.execute("INSERT INTO documents VALUES (?, ?)", [d, json.dumps({"title": f"Title {d}", "abstract": "x" * 60})])
        if not (SKIP_TOPIC is not None and t == SKIP_TOPIC):
            client.execute("INSERT INTO document_embeddings VALUES (?, ?, 'c')", [d, json.dumps(vec(t))])
def snap():
    return {n: [tuple(r) for r in client.execute(f"SELECT * FROM {n} ORDER BY 1, 2").rows]
            for n in ("topics", "document_topics", "topic_label_overrides", "settings")}
bt.generate_labels = lambda model, abstracts, assignments, reporter=None: {}
bt.complete_band_names = lambda *a, **k: {}
os.environ["TOPIC_BANDS_MIN"] = "2"
os.environ["TOPIC_BANDS_MAX"] = "3"
`;

test('bands-only writes bands and hierarchy for the current generation', { skip: skipScipy }, () => {
  const r = runPython(`SKIP_TOPIC = None
${BANDS_DB_SETUP}
before = snap()
out = bt.run_bands_only(client)
after = snap()
bands = [dict(r) for r in client.execute("SELECT * FROM topic_bands ORDER BY band_id").rows]
meta = dict(client.execute("SELECT * FROM topic_hierarchy_meta WHERE id = 1").rows[0])
settings = {r["key"]: r["value"] for r in client.execute("SELECT key, value FROM settings").rows}
tb = {k: v for k, v in before.items() if k != "settings"}
ta = {k: v for k, v in after.items() if k != "settings"}
print(json.dumps({"out": out, "bands": bands, "leaf": meta["leaf_topic_ids"], "settings": settings, "same": tb == ta}))`);
  assert.equal(r.out.leaves, 8);
  assert.equal(r.out.bands, r.bands.length);
  assert.ok(r.bands.length >= 2 && r.bands.length <= 3);
  const kids = r.bands.flatMap((b) => JSON.parse(b.child_topic_ids)).sort((a, b) => a - b);
  assert.deepEqual(kids, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(JSON.parse(r.leaf), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(r.settings.topics_generation, 'g1');
  assert.ok(r.settings.topic_bands_version);
  assert.equal(r.same, true);
});

test('bands-only leaves live tables intact on failure', { skip: skipScipy }, () => {
  const r = runPython(`SKIP_TOPIC = 5
${BANDS_DB_SETUP}
client.execute("INSERT INTO topic_bands VALUES (0, 'Old', '[1]', 1, 'old')")
client.execute("INSERT INTO topic_hierarchy_meta VALUES (1, '[1]', '[]', 'old')")
try:
    bt.run_bands_only(client)
    err = None
except Exception as e:
    err = str(e)
bands = [tuple(r) for r in client.execute("SELECT * FROM topic_bands").rows]
meta = [tuple(r) for r in client.execute("SELECT * FROM topic_hierarchy_meta").rows]
print(json.dumps({"err": err, "bands": bands, "meta": meta}))`);
  assert.ok(r.err && !/no attribute/.test(r.err), r.err);
  assert.deepEqual(r.bands, [[0, 'Old', '[1]', 1, 'old']]);
  assert.deepEqual(r.meta, [[1, '[1]', '[]', 'old']]);
});

test('labels-only refreshes band names but not membership', { skip: skipScipy }, () => {
  const r = runPython(`SKIP_TOPIC = None
${BANDS_DB_SETUP}
client.execute("INSERT INTO topic_bands VALUES (0, 'Stale', '[0, 1, 2, 3]', 12, 'old')")
client.execute("INSERT INTO topic_bands VALUES (1, 'Stale 2', '[4, 5, 6, 7]', 12, 'old')")
bt.run_label_only(client)
rows = [dict(r) for r in client.execute("SELECT * FROM topic_bands ORDER BY band_id").rows]
v1 = client.execute("SELECT value FROM settings WHERE key = 'topic_bands_version'").rows[0]["value"]
bt.run_label_only(client, topic_id=2)
rows2 = [dict(r) for r in client.execute("SELECT * FROM topic_bands ORDER BY band_id").rows]
v2 = client.execute("SELECT value FROM settings WHERE key = 'topic_bands_version'").rows[0]["value"]
print(json.dumps({"rows": rows, "rows2": rows2, "v1": v1, "v2": v2}))`);
  assert.deepEqual(r.rows.map((b) => b.child_topic_ids), ['[0, 1, 2, 3]', '[4, 5, 6, 7]']);
  assert.ok(r.rows.every((b) => b.label !== 'Stale' && b.label !== 'Stale 2'));
  assert.deepEqual(r.rows2, r.rows);
  assert.equal(r.v1, r.v2);
});

test('bands-only rolls back a batch that fails partway through', { skip: skipScipy }, () => {
  const r = runPython(`SKIP_TOPIC = None
${BANDS_DB_SETUP}
client.execute("INSERT INTO topic_bands VALUES (0, 'Old', '[1]', 1, 'old')")
client.execute("INSERT INTO topic_hierarchy_meta VALUES (1, '[1]', '[]', 'old')")
client.execute("INSERT INTO settings VALUES ('topic_bands_version', 'oldv', 'old')")
bt.generate_band_labels = lambda bands, *a, **k: {b["band_id"]: (None if b["band_id"] == 1 else "Named") for b in bands}
try:
    bt.run_bands_only(client)
    err = None
except Exception as e:
    err = str(e)
bands = [tuple(r) for r in client.execute("SELECT * FROM topic_bands").rows]
meta = [tuple(r) for r in client.execute("SELECT * FROM topic_hierarchy_meta").rows]
v = client.execute("SELECT value FROM settings WHERE key = 'topic_bands_version'").rows[0]["value"]
print(json.dumps({"err": err, "bands": bands, "meta": meta, "v": v}))`);
  assert.ok(r.err && /NOT NULL/.test(r.err), r.err);
  assert.deepEqual(r.bands, [[0, 'Old', '[1]', 1, 'old']]);
  assert.deepEqual(r.meta, [[1, '[1]', '[]', 'old']]);
  assert.equal(r.v, 'oldv');
});

test('bands-only refuses to write when topics_generation changes during the run', { skip: skipScipy }, () => {
  const r = runPython(`SKIP_TOPIC = None
${BANDS_DB_SETUP}
client.execute("INSERT INTO topic_bands VALUES (0, 'Old', '[1]', 1, 'old')")
def swap(bands, *a, **k):
    client.execute("UPDATE settings SET value = 'g2' WHERE key = 'topics_generation'")
    return {b["band_id"]: "Named" for b in bands}
bt.generate_band_labels = swap
try:
    bt.run_bands_only(client)
    err = None
except Exception as e:
    err = str(e)
bands = [tuple(r) for r in client.execute("SELECT * FROM topic_bands").rows]
print(json.dumps({"err": err, "bands": bands}))`);
  assert.match(r.err, /topics_generation changed/);
  assert.deepEqual(r.bands, [[0, 'Old', '[1]', 1, 'old']]);
});

test('band naming reports under its own task key with the real band count', () => {
  const r = runPython(`${BIG_BAND_SETUP}
bands = bands + [{"band_id": 1, "child_topic_ids": [1, 2], "doc_count": 5, "child_doc_counts": {1: 3, 2: 2}}]
calls = []
class R:
    def report(self, key, label, **kw):
        calls.append({"key": key, "label": label, "status": kw.get("status"), "counts": kw.get("counts")})
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("LOCAL_LABEL_BACKEND", None)
bt.load_local_chat_model = lambda name: ("tok", "model")
bt.local_chat_complete = lambda tok, model, system, prompt, max_new_tokens=18, sample=False: "Some Band Name"
out = bt.generate_band_labels(bands, labels, terms, titles, R())
print(json.dumps({"out": out, "calls": calls}))`);
  assert.equal(r.out['0'], 'Some Band Name');
  assert.ok(r.calls.length > 0);
  for (const c of r.calls) {
    assert.equal(c.key, 'generate_band_labels');
    assert.equal(c.label, 'Naming Research Areas');
    assert.equal(c.counts.total, 2);
  }
  assert.equal(r.calls.at(-1).status, 'completed');
});
