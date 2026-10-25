import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import test from 'node:test';

// Prefer the project venv (has numpy); fall back to system python3.
const PYTHON = existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3';

function hasNumpy() {
  try {
    execFileSync(PYTHON, ['-c', 'import numpy'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skip = hasNumpy() ? false : 'numpy is not installed';

function runPython(body) {
  const source = `
import sys
sys.modules["torch"] = None  # keep the module importable without loading torch
import importlib.util, json, sqlite3, tempfile, os
spec = importlib.util.spec_from_file_location("bt", "scripts/build-topics.py")
bt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)
tmp = tempfile.mkdtemp()
client = bt.SqliteClientWrapper(os.path.join(tmp, "t.sqlite"))
client.execute("CREATE TABLE document_embeddings (doc_id TEXT PRIMARY KEY, embedding TEXT, created_at TEXT)")
def put(doc_id, vec):
    client.execute("INSERT INTO document_embeddings VALUES (?, ?, 'x')", [doc_id, json.dumps(vec)])
${body}
`;
  const output = execFileSync(PYTHON, ['-c', source], { cwd: process.cwd(), encoding: 'utf8' });
  // The loader logs to stdout; the snippet's JSON result is the last line.
  return JSON.parse(output.trim().split('\n').pop());
}

test('load_cached_embeddings pages through rows into a float32 matrix', { skip }, () => {
  const r = runPython(`
for i in range(7):
    put(f"d{i}", [i, i + 0.5, i + 0.25])
ids = ["d6", "d0", "d3", "missing", "d1"]
m, filled, dim = bt.load_cached_embeddings(client, ids, page_size=2)
print(json.dumps({"dtype": str(m.dtype), "shape": list(m.shape), "dim": dim,
  "filled": filled.tolist(), "rows": [m[0].tolist(), m[1].tolist(), m[2].tolist(), m[4].tolist()]}))
`);
  assert.equal(r.dtype, 'float32');
  assert.deepEqual(r.shape, [5, 3]);
  assert.equal(r.dim, 3);
  assert.deepEqual(r.filled, [true, true, true, false, true]);
  assert.deepEqual(r.rows, [[6, 6.5, 6.25], [0, 0.5, 0.25], [3, 3.5, 3.25], [1, 1.5, 1.25]]);
});

test('load_cached_embeddings ignores rows not in doc_ids', { skip }, () => {
  const r = runPython(`
for i in range(5):
    put(f"d{i}", [i, i])
m, filled, dim = bt.load_cached_embeddings(client, ["d1", "d4"], page_size=2)
print(json.dumps({"shape": list(m.shape), "filled": filled.tolist(), "rows": m.tolist()}))
`);
  assert.deepEqual(r.shape, [2, 2]);
  assert.deepEqual(r.filled, [true, true]);
  assert.deepEqual(r.rows, [[1, 1], [4, 4]]);
});

test('load_cached_embeddings treats a dimension mismatch as missing', { skip }, () => {
  const r = runPython(`
put("a", [1, 2, 3])
put("b", [9, 9])
put("c", [4, 5, 6])
m, filled, dim = bt.load_cached_embeddings(client, ["a", "b", "c"], page_size=1)
print(json.dumps({"dim": dim, "filled": filled.tolist(), "rows": [m[0].tolist(), m[2].tolist()]}))
`);
  assert.equal(r.dim, 3);
  assert.deepEqual(r.filled, [true, false, true]);
  assert.deepEqual(r.rows, [[1, 2, 3], [4, 5, 6]]);
});

test('load_cached_embeddings returns no matrix when nothing is cached', { skip }, () => {
  const r = runPython(`
put("zzz", [1, 2])
m, filled, dim = bt.load_cached_embeddings(client, ["a", "b"])
print(json.dumps({"matrix": m is None, "dim": dim, "filled": filled.tolist()}))
`);
  assert.equal(r.matrix, true);
  assert.equal(r.dim, null);
  assert.deepEqual(r.filled, [false, false]);
});

test('load_cached_embeddings retries a transient page read failure instead of discarding the cache', { skip }, () => {
  const r = runPython(`
import time
time.sleep = lambda s: None
for i in range(4):
    put(f"d{i}", [i, i])
class Flaky:
    def __init__(self, inner):
        self.inner = inner
        self.calls = 0
    def execute(self, sql, params=None):
        self.calls += 1
        if self.calls in (2, 3):
            raise RuntimeError("transient turso error")
        return self.inner.execute(sql, params)
flaky = Flaky(client)
m, filled, dim = bt.load_cached_embeddings(flaky, [f"d{i}" for i in range(4)], page_size=2)
class Dead:
    def execute(self, sql, params=None):
        raise RuntimeError("down")
try:
    bt.load_cached_embeddings(Dead(), ["d0"])
    raised = False
except RuntimeError:
    raised = True
print(json.dumps({"filled": filled.tolist(), "calls": flaky.calls, "raised": raised}))
`);
  assert.deepEqual(r.filled, [true, true, true, true]);
  assert.ok(r.calls >= 4);
  assert.equal(r.raised, true);
});

test('load_cached_embeddings treats malformed JSON rows as missing and caps the log', { skip }, () => {
  const r = runPython(`
import io, contextlib
put("a", [1, 2])
for i in range(7):
    client.execute("INSERT INTO document_embeddings VALUES (?, ?, 'x')", [f"b{i}", "{not json"])
client.execute("INSERT INTO document_embeddings VALUES ('c', '\\"scalar\\"', 'x')")
put("d", [3, 4])
ids = ["a"] + [f"b{i}" for i in range(7)] + ["c", "d"]
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    m, filled, dim = bt.load_cached_embeddings(client, ids, page_size=3)
lines = buf.getvalue().splitlines()
print(json.dumps({"filled": filled.tolist(), "logged": sum("malformed cached embedding for" in l for l in lines),
  "summary": [l for l in lines if "were malformed" in l], "dim": dim}))
`);
  assert.deepEqual(r.filled, [true, ...Array(7).fill(false), false, true]);
  assert.equal(r.dim, 2);
  assert.equal(r.logged, 5);
  assert.match(r.summary[0], /8 cached/);
});
