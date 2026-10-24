import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  const r = runPython(`print(json.dumps([bt.resolve_min_topic_size(n) for n in (10, 100, 2500, 14000)]))`);
  assert.deepEqual(r, [5, 5, 5, 28]);
});

test('resolve_min_topic_size honours a valid env override', () => {
  const r = runPython(`print(json.dumps(bt.resolve_min_topic_size(14000)))`, { BERTOPIC_MIN_TOPIC_SIZE: '12' });
  assert.equal(r, 12);
});

test('resolve_min_topic_size falls back on invalid env values', () => {
  for (const bad of ['abc', '0', '-3', '2.5']) {
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
