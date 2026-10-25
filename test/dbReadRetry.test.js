// Read-only statements issued through the db.js get/all helpers retry once on a
// transient connection error. On Turso, a long synchronous stretch (e.g. building
// the visualizations payload over thousands of documents) lets the server close
// an idle keep-alive socket; undici then reuses the dead socket and the next
// query fails with "fetch failed" / "other side closed". A fresh attempt
// succeeds, and re-running a SELECT is always safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tempDir;
let db;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-db-read-retry-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');
  process.env.NODE_ENV = 'test';
  db = await import('../src/db.js');
  await db.ensureStorage();
});

test.after(async () => {
  await db.closeDb?.();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

function staleSocketError() {
  return new TypeError('fetch failed', { cause: new Error('other side closed') });
}

async function withPatchedExecute(failFor, fn) {
  const client = await db.getDb();
  const originalExecute = client.execute;
  const calls = [];
  client.execute = async (statement, ...rest) => {
    const sql = typeof statement === 'string' ? statement : statement?.sql;
    calls.push(sql);
    const error = failFor(sql, calls.length);
    if (error) throw error;
    return originalExecute.call(client, statement, ...rest);
  };
  try {
    return { result: await fn(), calls };
  } finally {
    client.execute = originalExecute;
  }
}

test('a SELECT that hits a stale Turso socket is retried and succeeds', async () => {
  let failed = false;
  const { result, calls } = await withPatchedExecute((sql) => {
    if (!failed && /SELECT d\.doc_id, d\.metadata_json/.test(sql)) {
      failed = true;
      return staleSocketError();
    }
    return null;
  }, () => db.queryTopicDocumentPage({ limit: 10 }));

  assert.deepEqual(result, { total: 0, documents: [] });
  assert.equal(calls.filter((sql) => /SELECT d\.doc_id, d\.metadata_json/.test(sql)).length, 2);
});

test('a permanent error on a SELECT is not retried', async () => {
  let attempts = 0;
  await assert.rejects(
    withPatchedExecute((sql) => {
      if (/SELECT COUNT\(\*\) AS total/.test(sql)) {
        attempts += 1;
        return Object.assign(new Error('no such column: x'), { code: 'SQLITE_ERROR' });
      }
      return null;
    }, () => db.queryTopicDocumentPage({ limit: 10 })),
    /no such column/,
  );
  assert.equal(attempts, 1);
});

test('a transient error that persists is re-thrown after bounded attempts', async () => {
  let attempts = 0;
  await assert.rejects(
    withPatchedExecute((sql) => {
      if (/SELECT COUNT\(\*\) AS total/.test(sql)) {
        attempts += 1;
        return staleSocketError();
      }
      return null;
    }, () => db.queryTopicDocumentPage({ limit: 10 })),
    /fetch failed/,
  );
  assert.ok(attempts >= 2 && attempts <= 4, `expected 2-4 attempts, got ${attempts}`);
});
