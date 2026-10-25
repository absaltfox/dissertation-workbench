import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

function runPythonSnippet(source) {
  const output = execFileSync('python3', ['-c', source], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}

const PRELUDE = `
import importlib.util, json, os, tempfile
spec = importlib.util.spec_from_file_location("bt", "scripts/build-topics.py")
bt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)
bt.time.sleep = lambda s: None

class FakeClient:
    def __init__(self, fail_times=0):
        self.calls = []
        self.fail_times = fail_times
    def batch(self, statements):
        self.calls.append(len(statements))
        if self.fail_times > 0:
            self.fail_times -= 1
            raise RuntimeError("transient")
`;

test('write_rows chunks rows into batches', () => {
  const result = runPythonSnippet(`${PRELUDE}
c = FakeClient()
bt.write_rows(c, "INSERT INTO t VALUES (?)", [[i] for i in range(1201)], chunk=500)
print(json.dumps({"calls": c.calls}))
`);
  assert.deepEqual(result.calls, [500, 500, 201]);
});

test('write_rows retries a transient failure with backoff then succeeds', () => {
  const result = runPythonSnippet(`${PRELUDE}
delays = []
bt.time.sleep = delays.append
c = FakeClient(fail_times=2)
bt.write_rows(c, "INSERT INTO t VALUES (?)", [[1], [2]], chunk=500)
print(json.dumps({"calls": c.calls, "delays": delays}))
`);
  assert.deepEqual(result.calls, [2, 2, 2]);
  assert.deepEqual(result.delays, [0.5, 1.0]);
});

test('write_rows re-raises after exhausting retries', () => {
  const result = runPythonSnippet(`${PRELUDE}
c = FakeClient(fail_times=99)
raised = None
try:
    bt.write_rows(c, "INSERT INTO t VALUES (?)", [[1]], retries=3)
except RuntimeError as ex:
    raised = str(ex)
print(json.dumps({"calls": c.calls, "raised": raised}))
`);
  assert.equal(result.calls.length, 4);
  assert.equal(result.raised, 'transient');
});

test('SqliteClientWrapper.batch is atomic and write_rows works through it', () => {
  const result = runPythonSnippet(`${PRELUDE}
d = tempfile.mkdtemp()
c = bt.SqliteClientWrapper(os.path.join(d, "t.sqlite"))
c.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
bt.write_rows(c, "INSERT INTO t (id, v) VALUES (?, ?)", [[i, "x"] for i in range(5)], chunk=2)
ok = c.execute("SELECT COUNT(*) AS n FROM t").rows[0]["n"]
failed = False
try:
    c.batch([
        ("INSERT INTO t (id, v) VALUES (?, ?)", [100, "a"]),
        ("INSERT INTO t (id, v) VALUES (?, ?)", [101, "b"]),
        ("INSERT INTO t (id, v) VALUES (?, ?)", [0, "dup"]),
    ])
except Exception:
    failed = True
after = c.execute("SELECT COUNT(*) AS n FROM t").rows[0]["n"]
c.close()
print(json.dumps({"ok": ok, "failed": failed, "after": after}))
`);
  assert.equal(result.ok, 5);
  assert.equal(result.failed, true);
  assert.equal(result.after, 5);
});
