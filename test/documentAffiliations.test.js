import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { corpusDocument, seedServingCorpus } from './fixtures/documentsServingCorpus.js';

// document_affiliations projects `$.affiliation` out of documents.metadata_json so
// the affiliation filter and facet stop parsing every document's JSON. The
// triggers must keep it exactly equal to a fresh json_each recount for every
// writer; the backfill runs in bounded chunks, resumes after a failure, and the
// readers use the projection only once it has completed.

let tempDir;
let db;
let client;

const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
async function rows(sql, args = []) {
  return (await client.execute({ sql, args })).rows.map((r) => Object.values(r).map(num));
}

// A fresh recount with exactly the expressions the affiliation filter and facet
// used before the projection existed (NULL members drop out: lower(NULL) never
// matches an IN list and NULL <> '' is not true).
const RECOUNT_SQL = `
  SELECT DISTINCT d.doc_id, trim(CAST(a.value AS TEXT)), lower(trim(CAST(a.value AS TEXT)))
  FROM documents d, json_each(CASE WHEN json_valid(d.metadata_json) THEN d.metadata_json END, '$.affiliation') a
  WHERE trim(CAST(a.value AS TEXT)) IS NOT NULL
  ORDER BY 1, 2`;
const PROJECTION_SQL = 'SELECT doc_id, value, value_norm FROM document_affiliations ORDER BY 1, 2';

async function expectProjectionMatchesRecount(label) {
  assert.deepEqual(await rows(PROJECTION_SQL), await rows(RECOUNT_SQL), `${label}: projection drifted from a recount`);
}

async function putDocument(overrides) {
  await db.saveDocumentMetadataBatch([{ doc: { ...corpusDocument(1), ...overrides } }]);
}

// Simulates a database from before this release: documents exist, the projection does not.
async function dropProjection() {
  await client.executeMultiple(`
    DROP TRIGGER IF EXISTS trg_documents_affiliations_ins;
    DROP TRIGGER IF EXISTS trg_documents_affiliations_upd;
    DROP TRIGGER IF EXISTS trg_documents_affiliations_del;
    DROP TABLE IF EXISTS document_affiliations;
    DELETE FROM serving_projection_state WHERE projection_key = 'document_affiliations_backfill';
  `);
  db.__setAffiliationsReadyForTesting(false);
}

// Records write batches and can fail or interleave writes at chosen backfill chunks.
function recordingClient(target, { failOnChunk = null, beforeChunk = null } = {}) {
  const batches = [];
  const argLog = [];
  let chunks = 0;
  const isChunk = (stmts) => stmts.some((s) => /INSERT INTO document_affiliations[\s\S]*FROM documents d/i.test(typeof s === 'string' ? s : s.sql));
  const proxy = new Proxy(target, {
    get(obj, prop) {
      if (prop === 'batch') {
        return async (stmts, mode) => {
          batches.push(stmts.map((s) => (typeof s === 'string' ? s : s.sql)));
          argLog.push(stmts.map((s) => (typeof s === 'string' ? [] : s.args || [])));
          if (isChunk(stmts)) {
            chunks += 1;
            if (beforeChunk) await beforeChunk(chunks);
            if (failOnChunk === chunks) {
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
  return { proxy, batches, argLog, chunkCount: () => chunks };
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-doc-aff-'));
  Object.assign(process.env, {
    SKIP_LOCAL_ENV: '1', NODE_ENV: 'test', APP_DATA_DIR: tempDir,
    SQLITE_PATH: path.join(tempDir, 'metrics.sqlite'),
    PDF_CACHE_DIR: path.join(tempDir, 'pdf'), FULL_TEXT_CACHE_DIR: path.join(tempDir, 'ft'),
    // Small chunks so a 140-document corpus spans several transactions.
    DOCUMENT_AFFILIATIONS_BACKFILL_CHUNK: '25',
  });
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  await db.ensureStorage();
  client = await db.getDb();
  await seedServingCorpus(db);
});

test.after(async () => {
  delete process.env.DOCUMENT_AFFILIATIONS_BACKFILL_CHUNK;
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('a fresh database has the projection objects and is ready; seeded documents are projected', async () => {
  const objects = await rows(`SELECT name FROM sqlite_master WHERE name IN (
    'document_affiliations', 'idx_document_affiliations_norm', 'trg_documents_affiliations_ins',
    'trg_documents_affiliations_upd', 'trg_documents_affiliations_del') ORDER BY name`);
  assert.equal(objects.length, 5);
  assert.equal(await db.initAffiliationsReadiness(client), true);
  await expectProjectionMatchesRecount('after seeding');
  assert.ok((await rows('SELECT COUNT(*) FROM document_affiliations'))[0][0] > 50);
});

test('the projection equals a recount after insert, update and delete, for every affiliation shape', async () => {
  const shapes = [
    ['array', ['UBC', 'SFU']], ['scalar string', 'UBC'], ['missing', undefined], ['json null', null],
    ['empty string', ['']], ['whitespace only', ['   ']], ['duplicates', ['UBC', 'UBC']],
    ['case and whitespace variants', ['UBC', 'ubc', '  UBC ', 'Ubc']], ['nested array', [['UBC']]],
    ['non-string members', [123, true, null, 'UBC']], ['empty array', []], ['object', { a: 'UBC' }],
  ];
  for (const [label, affiliation] of shapes) {
    const id = `aff-${label.replace(/\W+/g, '-')}`;
    await putDocument({ id, affiliation });
    await expectProjectionMatchesRecount(`insert ${label}`);
    await putDocument({ id, affiliation: ['Changed', ...(Array.isArray(affiliation) ? affiliation : [])] });
    await expectProjectionMatchesRecount(`update ${label}`);
    await putDocument({ id, affiliation: undefined });
    await expectProjectionMatchesRecount(`cleared ${label}`);
    await putDocument({ id, affiliation });
    await client.execute({ sql: 'DELETE FROM documents WHERE doc_id = ?', args: [id] });
    await expectProjectionMatchesRecount(`delete ${label}`);
    assert.deepEqual(await rows('SELECT 1 FROM document_affiliations WHERE doc_id = ?', [id]), []);
  }
});

test('an upsert that leaves the affiliation unchanged writes no projection rows', async () => {
  await putDocument({ id: 'aff-stable', affiliation: ['UBC', 'SFU'] });
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS aff_write_log (op TEXT);
    DELETE FROM aff_write_log;
    CREATE TRIGGER aff_log_ins AFTER INSERT ON document_affiliations BEGIN INSERT INTO aff_write_log VALUES ('ins'); END;
    CREATE TRIGGER aff_log_del AFTER DELETE ON document_affiliations BEGIN INSERT INTO aff_write_log VALUES ('del'); END;
  `);
  try {
    await putDocument({ id: 'aff-stable', affiliation: ['UBC', 'SFU'], title: 'Retitled, same affiliation' });
    assert.deepEqual(await rows('SELECT op FROM aff_write_log'), [], 'no projection write for an unchanged affiliation');
    await putDocument({ id: 'aff-stable', affiliation: ['UBC'] });
    assert.ok((await rows('SELECT op FROM aff_write_log')).length > 0, 'a changed affiliation does rewrite it');
  } finally {
    await client.executeMultiple('DROP TRIGGER aff_log_ins; DROP TRIGGER aff_log_del; DROP TABLE aff_write_log;');
  }
  await expectProjectionMatchesRecount('after unchanged upsert');
});

test('restricted documents keep their affiliation rows when an upsert takes the embargo json_set branch', async () => {
  await putDocument({ id: 'aff-embargo', affiliation: ['UBC'], accessStatus: 'embargoed', availableAt: '2999-01-01T00:00:00.000Z' });
  // The sync sees "unknown" again: the upsert rewrites metadata_json through json_set.
  await putDocument({ id: 'aff-embargo', affiliation: ['UBC'], accessStatus: undefined, availableAt: undefined });
  assert.ok((await rows("SELECT 1 FROM document_affiliations WHERE doc_id = 'aff-embargo'")).length === 1);
  await expectProjectionMatchesRecount('after embargo json_set upsert');
});

test('bulk metadata rewrites (theme rebuild, legacy access backfill) keep the projection exact', async () => {
  await db.recomputeStoredDocumentThemes({ limit: 40 });
  await expectProjectionMatchesRecount('after theme rebuild');
  // A legacy record the access backfill rewrites: embargo placeholder, status still 'unknown'.
  await client.execute({
    sql: `INSERT INTO documents (doc_id, metadata_json, access_status, updated_at) VALUES ('aff-legacy', ?, 'unknown', 'x')`,
    args: [JSON.stringify({
      id: 'aff-legacy', affiliation: [' University of Victoria '], abstract: 'This thesis is embargoed until 2999-01-01.',
      availableAt: '2999-01-01T00:00:00.000Z', themes: ['x'],
    })],
  });
  await client.execute("DELETE FROM serving_projection_state WHERE projection_key = 'document_access_v2'");
  await db.ensureSchemaWithRetry(client);
  await expectProjectionMatchesRecount('after access-status backfill');
  assert.deepEqual(await rows("SELECT value FROM document_affiliations WHERE doc_id = 'aff-legacy'"), [['University of Victoria']]);
});

test('a document with malformed metadata_json can be written and contributes no rows', async () => {
  await client.execute({ sql: "INSERT INTO documents (doc_id, metadata_json, updated_at) VALUES ('aff-bad', '{not json', 'x')" });
  assert.deepEqual(await rows("SELECT 1 FROM document_affiliations WHERE doc_id = 'aff-bad'"), []);
  await client.execute("UPDATE documents SET metadata_json = '[also bad' WHERE doc_id = 'aff-bad'");
  await client.execute("UPDATE documents SET metadata_json = '{\"affiliation\":[\"UBC\"]}' WHERE doc_id = 'aff-bad'");
  assert.deepEqual(await rows("SELECT value FROM document_affiliations WHERE doc_id = 'aff-bad'"), [['UBC']]);
  await client.execute("UPDATE documents SET metadata_json = '{broken' WHERE doc_id = 'aff-bad'");
  assert.deepEqual(await rows("SELECT 1 FROM document_affiliations WHERE doc_id = 'aff-bad'"), []);
  await client.execute("DELETE FROM documents WHERE doc_id = 'aff-bad'");
});

test('the backfill never reads json_each over the whole table inside one write batch', async () => {
  await dropProjection();
  const rec = recordingClient(client);
  await db.ensureSchemaWithRetry(rec.proxy);
  await expectProjectionMatchesRecount('after chunked backfill');
  const unbounded = rec.batches.flat().filter((sql) => /INSERT INTO document_affiliations[\s\S]*FROM documents d/i.test(sql) && !/doc_id > \?/.test(sql));
  assert.deepEqual(unbounded, [], 'every backfill chunk carries a doc_id range');
  assert.ok(rec.chunkCount() > 3, `expected several bounded chunks, saw ${rec.chunkCount()}`);
  assert.equal(await db.initAffiliationsReadiness(client), true);
  assert.deepEqual(await rows("SELECT projection_value FROM serving_projection_state WHERE projection_key = 'document_affiliations_backfill'"), [['complete']]);
});

test('a chunk that times out does not fail the boot, leaves readers on json_each, and resumes from the cursor', async () => {
  await dropProjection();
  const failing = recordingClient(client, { failOnChunk: 3 });
  await db.ensureSchemaWithRetry(failing.proxy); // must not throw
  assert.equal(await db.initAffiliationsReadiness(client), false, 'not ready while the backfill is incomplete');
  const [[stored]] = await rows("SELECT projection_value FROM serving_projection_state WHERE projection_key = 'document_affiliations_backfill'");
  assert.notEqual(stored, 'complete');
  assert.ok(JSON.parse(stored).cursor, 'the two committed chunks recorded a cursor');
  // The triggers are live, so writes during the gap are not lost.
  await putDocument({ id: 'zz-late', affiliation: ['Late University'] });

  const resumed = recordingClient(client);
  await db.ensureSchemaWithRetry(resumed.proxy);
  assert.equal(await db.initAffiliationsReadiness(client), true);
  await expectProjectionMatchesRecount('after resumed backfill');
  // Each chunk's first statement is `DELETE ... WHERE doc_id > :lo AND doc_id <= :hi`.
  const lowers = (rec) => rec.batches.flatMap((sqls, i) => sqls
    .map((sql, j) => (/^DELETE FROM document_affiliations WHERE doc_id > \? AND doc_id <= \?/.test(sql) ? rec.argLog[i][j][0] : null))
    .filter((v) => v != null));
  assert.equal(lowers(failing)[0], '', 'the interrupted run started at the first document');
  assert.equal(lowers(resumed).includes(''), false, 'resume does not restart from the first chunk');
  assert.doesNotMatch(resumed.batches.flat().join('\n'), /CREATE TRIGGER/, 'objects exist: only the remaining chunks run');
});

test('writes landing on both sides of the cursor between chunks are counted exactly', async () => {
  await dropProjection();
  const rec = recordingClient(client, {
    beforeChunk: async (n) => {
      if (n === 2) await putDocument({ id: 'corp-0001', affiliation: ['Interleaved'] });
      if (n === 3) await client.execute("DELETE FROM documents WHERE doc_id = 'corp-0002'");
      if (n === 4) await putDocument({ id: 'zz-tail', affiliation: ['Tail University', 'UBC'] });
    },
  });
  await db.ensureSchemaWithRetry(rec.proxy);
  await expectProjectionMatchesRecount('after interleaved writes');
  assert.equal(await db.initAffiliationsReadiness(client), true);
});

test('readiness needs the objects as well as the completed marker', async () => {
  assert.equal(await db.initAffiliationsReadiness(client), true);
  await client.execute('DROP TRIGGER trg_documents_affiliations_upd');
  assert.equal(await db.initAffiliationsReadiness(client), false, 'a missing trigger means the table no longer tracks writes');
  await db.ensureSchemaWithRetry(client);
  assert.equal(await db.initAffiliationsReadiness(client), true, 'recreated objects reset and re-run the backfill');
  await expectProjectionMatchesRecount('after trigger repair');
});
