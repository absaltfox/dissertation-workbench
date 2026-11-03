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
bt.generate_labels = lambda *a, **k: {}
print(json.dumps(bt.generate_band_labels(bands, labels, terms, titles)))`);
  assert.deepEqual(r, { 0: 'Fish Physiology and related topics' });
});

test('generate_band_labels passes band evidence to the labeller', () => {
  const r = runPython(`${BAND_SETUP}
seen = {}
def fake(model, abstracts, assignments, reporter=None):
    seen["abstracts"] = abstracts
    seen["assignments"] = assignments
    seen["terms"] = model.get_topic(0)
    seen["info"] = [dict(r) for _, r in model.get_topic_info().iterrows()]
    return {0: "Aquatic Animal Biology"}
bt.generate_labels = fake
out = bt.generate_band_labels(bands, labels, terms, titles)
print(json.dumps({"out": out, **seen}))`);
  assert.equal(r.out['0'], 'Aquatic Animal Biology');
  assert.equal(r.abstracts.length, 1);
  assert.ok(r.abstracts[0].includes('Gill Function') && r.abstracts[0].includes('Fish Physiology'));
  assert.ok(r.abstracts[0].includes('T two') && r.abstracts[0].includes('T three') && !r.abstracts[0].includes('T four'));
  assert.deepEqual(r.assignments, [0]);
  assert.equal(r.terms[0][0], 'fish');
  assert.equal(r.info[0].Count, 30);
});

test('the full-rebuild hierarchy no longer uses topic_embeddings_', () => {
  const src = readFileSync('scripts/build-topics.py', 'utf8');
  const main = src.slice(src.indexOf('\ndef main('));
  assert.ok(!main.includes('topic_embeddings_'));
  assert.ok(!main.includes('cosine_similarity('));
});
