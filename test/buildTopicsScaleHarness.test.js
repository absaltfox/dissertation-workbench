import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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

function env(extra = {}) {
  const e = { ...process.env, ...extra };
  delete e.TURSO_DATABASE_URL;
  return { ...e, ...extra };
}

test('scale harness io-only run with failure injection succeeds', { skip, timeout: 60000 }, () => {
  const out = execFileSync(
    PYTHON,
    ['scripts/bench-topics-scale.py', '--io-only', '-n', '2000', '--inject-failure'],
    { cwd: process.cwd(), encoding: 'utf8', env: env() },
  );
  const summary = JSON.parse(out.trim().split('\n').pop());
  assert.equal(summary.mode, 'io-only');
  assert.equal(summary.docs, 2000);
  assert.equal(summary.empty_reads, 0);
  assert.ok(summary.reads > 0, 'reader should have polled');
  assert.equal(summary.injected_failure_ok, true);
  assert.ok(summary.batches > 0);
  assert.ok(summary.peak_rss_mb > 0);
});

test('scale harness refuses to seed a remote database without --allow-remote', { skip }, () => {
  const r = spawnSync(PYTHON, ['scripts/bench-topics-scale.py', '-n', '10'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: env({ TURSO_DATABASE_URL: 'libsql://example.invalid' }),
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /allow-remote/);
});
