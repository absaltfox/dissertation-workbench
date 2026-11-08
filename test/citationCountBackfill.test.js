import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// The citation-count backfill runs inside the startup schema pass. On remote
// libSQL a write transaction that runs longer than about 5 s is aborted with
// TRANSACTION_TIMEOUT when another connection is waiting for the write lock
// (reproduced against a local sqld). Prod measured 6.2 s server time for the
// cold `GROUP BY doc_id` alone, so the backfill must never aggregate the whole
// link table inside one write transaction. It runs in bounded chunks, records
// its progress, does not fail the boot when a chunk fails, and the readers stay
// on the live SQL until it has completed.

let tempDir;
let db;
let client;

const hash = (t) => crypto.createHash('sha256').update(t.toLowerCase().trim()).digest('hex');

async function rows(sql, args = []) {
  return (await client.execute({ sql, args })).rows.map((r) => Object.values(r).map((v) => (typeof v === 'bigint' ? Number(v) : v)));
}

async function expectInSync(label) {
  assert.deepEqual(
    await rows('SELECT citation_id, doc_count FROM citation_doc_counts ORDER BY citation_id'),
    await rows('SELECT citation_id, COUNT(*) FROM document_citations GROUP BY citation_id ORDER BY citation_id'),
    `${label}: citation_doc_counts drifted`,
  );
  assert.deepEqual(
    await rows('SELECT doc_id, citation_count FROM document_citation_counts ORDER BY doc_id'),
    await rows('SELECT doc_id, COUNT(*) FROM document_citations GROUP BY doc_id ORDER BY doc_id'),
    `${label}: document_citation_counts drifted`,
  );
}

// A database from before this release: links exist, summary objects do not.
async function seedPreReleaseDatabase() {
  await db.clearAllCitations();
  await client.executeMultiple(`
    DROP TRIGGER IF EXISTS trg_document_citations_count_ins;
    DROP TRIGGER IF EXISTS trg_document_citations_count_del;
    DROP TABLE IF EXISTS citation_doc_counts;
    DROP TABLE IF EXISTS document_citation_counts;
    DELETE FROM serving_projection_state WHERE projection_key LIKE 'citation_count%';
  `);
  for (let d = 0; d < 12; d += 1) {
    const cites = [`Shared work (2001). Common ${d % 3}.`, `Everyone cites this (1999).`];
    // Distinct leading text per citation so fuzzy matching never merges them.
    for (let k = 0; k < 4; k += 1) cites.push(`${hash(`own-${d}-${k}`).slice(0, 10)} Doc ${d} own citation ${k} (20${10 + k}).`);
    await db.saveCitations(`bf-${String(d).padStart(2, '0')}`, cites, hash);
  }
}

// Records every write batch and can fail or interleave writes at chosen points.
function recordingClient(target, { failOnBackfillBatch = null, beforeBackfillBatch = null } = {}) {
  const batches = [];
  const argLog = [];
  let backfillBatches = 0;
  const isBackfill = (stmts) => stmts.some((s) => /INTO (citation_doc_counts|document_citation_counts)[\s\S]*SELECT/i.test(typeof s === 'string' ? s : s.sql));
  const proxy = new Proxy(target, {
    get(obj, prop) {
      if (prop === 'batch') {
        return async (stmts, mode) => {
          batches.push(stmts.map((s) => (typeof s === 'string' ? s : s.sql)));
          argLog.push(stmts.map((s) => (typeof s === 'string' ? [] : s.args || [])));
          if (isBackfill(stmts)) {
            backfillBatches += 1;
            if (beforeBackfillBatch) await beforeBackfillBatch(backfillBatches);
            if (failOnBackfillBatch === backfillBatches) {
              const error = new Error('Transaction timed out');
              error.code = 'TRANSACTION_TIMEOUT';
              throw error;
            }
          }
          return obj.batch(stmts, mode);
        };
      }
      const value = obj[prop];
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
  return { proxy, batches, argLog, backfillCount: () => backfillBatches };
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-cite-backfill-'));
  Object.assign(process.env, {
    SKIP_LOCAL_ENV: '1', NODE_ENV: 'test', APP_DATA_DIR: tempDir,
    SQLITE_PATH: path.join(tempDir, 'metrics.sqlite'),
    PDF_CACHE_DIR: path.join(tempDir, 'pdf'), FULL_TEXT_CACHE_DIR: path.join(tempDir, 'ft'),
    // Small chunks so a dozen documents span several transactions.
    CITATION_COUNT_BACKFILL_ID_SPAN: '7',
    CITATION_COUNT_BACKFILL_DOC_CHUNK: '3',
  });
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  await db.ensureStorage();
  client = await db.getDb();
});

test.after(async () => {
  delete process.env.CITATION_COUNT_BACKFILL_ID_SPAN;
  delete process.env.CITATION_COUNT_BACKFILL_DOC_CHUNK;
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('the backfill never aggregates the whole link table inside one write transaction', async () => {
  await seedPreReleaseDatabase();
  const rec = recordingClient(client);
  await db.ensureSchemaWithRetry(rec.proxy);
  await expectInSync('after chunked backfill');
  const unbounded = rec.batches.flat().filter((sql) => /FROM document_citations\s+GROUP BY/i.test(sql));
  assert.deepEqual(unbounded, [], 'every backfill aggregate carries a key-range bound');
  assert.ok(rec.backfillCount() > 2, `expected several bounded backfill transactions, saw ${rec.backfillCount()}`);
  assert.equal(await db.initCitationCountsReadiness(client), true);
});

test('the citation phase starts at the lowest linked citation id, not at zero', async () => {
  await seedPreReleaseDatabase();
  // Push every id far above the chunk span, as on prod (ids start at 313,657).
  await client.execute("UPDATE sqlite_sequence SET seq = seq + 1000 WHERE name = 'citations'");
  await db.saveCitations('bf-high', ['High id one (2001).', 'High id two (2002).'], hash);
  await client.execute("DELETE FROM document_citations WHERE doc_id <> 'bf-high'");
  const [[minId]] = await rows('SELECT MIN(citation_id) FROM document_citations');
  await client.execute("DELETE FROM serving_projection_state WHERE projection_key = 'citation_count_backfill'");
  await client.execute(`INSERT INTO serving_projection_state (projection_key, projection_value, updated_at)
    VALUES ('citation_count_backfill', '{"phase":"citations","cursor":null}', 'x')`);
  const rec = recordingClient(client);
  await db.ensureSchemaWithRetry(rec.proxy);
  await expectInSync('after high-id backfill');
  const lowerBounds = rec.batches.flatMap((sqls, i) => sqls
    .map((sql, j) => (/INTO citation_doc_counts[\s\S]*SELECT/.test(sql) ? Number(rec.argLog[i][j][0]) : null))
    .filter((v) => v != null));
  assert.ok(lowerBounds.length > 0);
  assert.ok(Math.min(...lowerBounds) >= minId - 1, `first chunk lower bound ${Math.min(...lowerBounds)} vs min id ${minId}`);
});

test('a backfill chunk that times out does not fail the boot, leaves readers on live SQL, and resumes', async () => {
  await seedPreReleaseDatabase();
  const failing = recordingClient(client, { failOnBackfillBatch: 3 });
  await db.ensureSchemaWithRetry(failing.proxy); // must not throw
  assert.equal(await db.initCitationCountsReadiness(client), false, 'not ready while the backfill is incomplete');
  const [[stored]] = await rows("SELECT projection_value FROM serving_projection_state WHERE projection_key = 'citation_count_backfill'");
  assert.notEqual(stored, JSON.stringify({ phase: 'citations', cursor: null }), 'the two committed chunks recorded their progress');
  assert.notEqual(stored, 'complete');
  // Triggers are already live, so writes during the gap are not lost.
  await db.saveCitations('bf-late', ['Everyone cites this (1999).', 'Late arrival (2020).'], hash);

  const resumed = recordingClient(client);
  await db.ensureSchemaWithRetry(resumed.proxy);
  assert.equal(await db.initCitationCountsReadiness(client), true);
  await expectInSync('after resumed backfill');
  // No resumed chunk repeats the first chunk of the interrupted run.
  const citationLowerBounds = (rec) => rec.batches.flatMap((sqls, i) => sqls
    .map((sql, j) => (/INTO citation_doc_counts[\s\S]*SELECT/.test(sql) ? Number(rec.argLog[i][j][0]) : null))
    .filter((v) => v != null));
  const [firstStart] = citationLowerBounds(failing);
  assert.ok(Number.isFinite(firstStart));
  const restartedFromScratch = citationLowerBounds(resumed).includes(firstStart);
  assert.equal(restartedFromScratch, false, 'resume continues from the stored cursor');
  assert.ok(resumed.backfillCount() > 0);
  const firstSql = resumed.batches.flat().join('\n');
  assert.doesNotMatch(firstSql, /CREATE TRIGGER/, 'objects already exist: resume runs only the remaining chunks');
});

test('links written and deleted between backfill chunks are counted exactly', async () => {
  await seedPreReleaseDatabase();
  const rec = recordingClient(client, {
    beforeBackfillBatch: async (n) => {
      // Writes land on both sides of the chunk cursor while the backfill runs.
      if (n === 2) await db.saveCitations('bf-00', ['Interleaved new (2021).', 'Everyone cites this (1999).'], hash);
      if (n === 4) await db.replaceDocumentCitationLinks('bf-11', []);
      if (n === 6) await db.saveCitations('zz-tail', ['Shared work (2001). Common 1.'], hash);
    },
  });
  await db.ensureSchemaWithRetry(rec.proxy);
  await expectInSync('after interleaved writes');
  assert.deepEqual(await db.reconcileCitationCounts(), { citationDrift: 0, docDrift: 0 });
});

test('readiness requires the completed backfill marker, not only the objects', async () => {
  await seedPreReleaseDatabase();
  await db.ensureSchemaWithRetry(client);
  assert.equal(await db.initCitationCountsReadiness(client), true);
  await client.execute("DELETE FROM serving_projection_state WHERE projection_key LIKE 'citation_count%'");
  assert.equal(await db.initCitationCountsReadiness(client), false);
  await db.ensureSchemaWithRetry(client);
  assert.equal(await db.initCitationCountsReadiness(client), true);
  await expectInSync('after re-marking');
});

test('reconcile repair rebuilds in bounded chunks', async () => {
  await seedPreReleaseDatabase();
  await db.ensureSchemaWithRetry(client);
  await db.initCitationCountsReadiness(client);
  await client.execute('UPDATE citation_doc_counts SET doc_count = doc_count + 3');
  await client.execute("INSERT INTO document_citation_counts (doc_id, citation_count) VALUES ('ghost', 9)");
  const drift = await db.reconcileCitationCounts({ repair: true });
  assert.equal(drift.repaired, true);
  await expectInSync('after repair');
  assert.equal(db.isCitationCountsReady(), true, 'readiness survives a repair');
});
