import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { logger } from '../src/logger.js';
import { seedServingCorpus } from './fixtures/documentsServingCorpus.js';

// The covering indexes on `documents` cost a cold full-table scan each to build, and
// a remote libSQL write transaction over about 5 s is aborted (TRANSACTION_TIMEOUT)
// when another connection waits. So the boot pass must never build them on a large
// table: a background migration warms the table, builds each index with its planner
// statistics row in one batch, retries on a timeout, drops the legacy indexes only
// once all four exist, and backfills document_affiliations in chunks.

const NEW_INDEXES = ['idx_documents_cover_doc', 'idx_documents_cover_degree', 'idx_documents_cover_year', 'idx_documents_cover_program'];
const LEGACY_INDEXES = {
  idx_documents_degree: 'documents(degree)',
  idx_documents_degree_year: 'documents(degree, year)',
  idx_documents_program: 'documents(program)',
  idx_documents_year: 'documents(year)',
};

let tempDir;
let dbPath;
let db;
let client;

const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
async function rows(sql, args = []) {
  return (await client.execute({ sql, args })).rows.map((r) => Object.values(r).map(num));
}
const indexNames = async () => (await rows("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'documents'")).map(([n]) => n);

// The state of a production database from before this release: legacy indexes,
// no covering indexes, no statistics rows for them, no affiliation projection.
async function resetToPreMigration() {
  for (const name of NEW_INDEXES) await client.execute(`DROP INDEX IF EXISTS ${name}`);
  await client.executeMultiple(`
    DROP TRIGGER IF EXISTS trg_documents_affiliations_ins;
    DROP TRIGGER IF EXISTS trg_documents_affiliations_upd;
    DROP TRIGGER IF EXISTS trg_documents_affiliations_del;
    DROP TABLE IF EXISTS document_affiliations;
    DELETE FROM serving_projection_state WHERE projection_key = 'document_affiliations_backfill';
  `);
  for (const [name, columns] of Object.entries(LEGACY_INDEXES)) {
    await client.execute(`CREATE INDEX IF NOT EXISTS ${name} ON ${columns}`);
  }
  db.__setAffiliationsReadyForTesting(false);
}

// Records every write batch (as SQL text) and fails chosen ones before they run.
function recordingClient(target, { failBatch = null } = {}) {
  const batches = [];
  const proxy = new Proxy(target, {
    get(obj, prop) {
      if (prop === 'batch') {
        return async (stmts, mode) => {
          const sqls = stmts.map((s) => (typeof s === 'string' ? s : s.sql));
          batches.push(sqls);
          const failure = failBatch?.(sqls, batches.length);
          if (failure) throw Object.assign(new Error(failure.message || 'injected failure'), { code: failure.code });
          return obj.batch(stmts, mode);
        };
      }
      const value = obj[prop];
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
  return { proxy, batches };
}

const isCreateOf = (name) => (sqls) => sqls.some((sql) => new RegExp(`CREATE INDEX IF NOT EXISTS ${name}\\b`).test(sql));
const timeout = { code: 'TRANSACTION_TIMEOUT', message: 'Transaction timed out' };

// Silent waits and an always-warm clock, so tests run instantly.
const fastOptions = (extra = {}) => {
  const waits = [];
  return { waits, options: { wait: async (ms) => { waits.push(ms); }, now: () => 0, ...extra } };
};

function captureWarnings() {
  const seen = [];
  const original = logger.warn;
  logger.warn = (...args) => { seen.push(args); };
  return { seen, restore: () => { logger.warn = original; } };
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-docs-migration-'));
  dbPath = path.join(tempDir, 'metrics.sqlite');
  Object.assign(process.env, {
    SKIP_LOCAL_ENV: '1', NODE_ENV: 'test', APP_DATA_DIR: tempDir, SQLITE_PATH: dbPath,
    PDF_CACHE_DIR: path.join(tempDir, 'pdf'), FULL_TEXT_CACHE_DIR: path.join(tempDir, 'ft'),
    // Treat every table as "large": the schema pass must leave the builds alone.
    DOCUMENTS_INDEX_INLINE_MAX_ROWS: '0',
    DOCUMENT_AFFILIATIONS_BACKFILL_CHUNK: '20',
  });
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  await db.ensureStorage();
  client = await db.getDb();
  await seedServingCorpus(db);
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('the boot schema pass does not build covering indexes on a large table', async () => {
  await resetToPreMigration();
  const rec = recordingClient(client);
  await db.ensureSchemaWithRetry(rec.proxy);
  const names = await indexNames();
  for (const name of NEW_INDEXES) assert.ok(!names.includes(name), `${name} must be left to the background migration`);
  for (const name of Object.keys(LEGACY_INDEXES)) assert.ok(names.includes(name), `${name} stays until the new indexes exist`);
  assert.deepEqual(rec.batches.flat().filter((sql) => /CREATE INDEX[^;]*idx_documents_cover/.test(sql)), []);
  // The projection DDL is cheap and does go in the boot pass; its backfill does not.
  assert.equal(await db.initAffiliationsReadiness(client), false);
});

test('a small table gets the whole migration inline in the schema pass', async () => {
  await resetToPreMigration();
  process.env.DOCUMENTS_INDEX_INLINE_MAX_ROWS = '100000';
  try {
    await db.ensureSchemaWithRetry(client);
  } finally { process.env.DOCUMENTS_INDEX_INLINE_MAX_ROWS = '0'; }
  const names = await indexNames();
  for (const name of NEW_INDEXES) assert.ok(names.includes(name), name);
  for (const name of Object.keys(LEGACY_INDEXES)) assert.ok(!names.includes(name), `${name} dropped`);
  assert.equal(await db.initAffiliationsReadiness(client), true);
});

test('each index is built with its statistics row in one batch; the legacy indexes are dropped last, once', async () => {
  await resetToPreMigration();
  const rec = recordingClient(client);
  const { options } = fastOptions();
  const result = await db.runDocumentsIndexMigration({ client: rec.proxy, ...options });
  assert.equal(result.complete, true);

  const creates = NEW_INDEXES.map((name) => {
    const at = rec.batches.findIndex(isCreateOf(name));
    assert.ok(at >= 0, `${name} was built`);
    const batch = rec.batches[at];
    assert.equal(batch.length, 2, `${name}: CREATE INDEX and its sqlite_stat1 row travel together`);
    assert.match(batch[1], /INSERT OR REPLACE INTO sqlite_stat1/);
    return at;
  });
  assert.deepEqual(creates, [...creates].sort((a, b) => a - b), 'built in the documented order');
  const dropAt = rec.batches.findIndex((sqls) => sqls.some((sql) => /DROP INDEX/.test(sql)));
  assert.ok(dropAt > Math.max(...creates), 'legacy indexes dropped only after all four exist');
  assert.equal(rec.batches[dropAt].length, 4);
  assert.deepEqual((await indexNames()).filter((n) => n in LEGACY_INDEXES), []);

  const stats = await rows("SELECT idx, stat FROM sqlite_stat1 WHERE tbl = 'documents' AND idx LIKE 'idx_documents_cover%' ORDER BY idx");
  assert.deepEqual(stats.map(([idx]) => idx), [...NEW_INDEXES].sort());
  const [[total]] = await rows('SELECT COUNT(doc_id) FROM documents');
  for (const [, stat] of stats) assert.equal(Number(String(stat).split(' ')[0]), total, 'the stat row starts with the table row count');
  assert.deepEqual((await rows("SELECT idx FROM sqlite_stat1 WHERE idx IN ('idx_documents_degree', 'idx_documents_year')")), [], 'dropping an index removes its statistics');
});

test('a second run is a no-op that writes nothing', async () => {
  const rec = recordingClient(client);
  const { options } = fastOptions();
  const result = await db.runDocumentsIndexMigration({ client: rec.proxy, ...options });
  assert.equal(result.complete, true);
  assert.deepEqual(rec.batches, []);
});

test('a TRANSACTION_TIMEOUT on a build only logs a warning, is retried after a backoff, and then succeeds', async () => {
  await resetToPreMigration();
  const warnings = captureWarnings();
  let failures = 0;
  const rec = recordingClient(client, {
    failBatch: (sqls) => (isCreateOf('idx_documents_cover_degree')(sqls) && (failures += 1) <= 2 ? timeout : null),
  });
  const { options, waits } = fastOptions();
  let result;
  try {
    result = await db.runDocumentsIndexMigration({ client: rec.proxy, ...options }); // must not throw
  } finally { warnings.restore(); }
  assert.equal(result.complete, true);
  assert.equal(failures, 3, 'two timeouts, then the third attempt built it');
  assert.deepEqual(waits, [30_000, 120_000], 'backs off between attempts');
  assert.equal(warnings.seen.filter(([message]) => /build failed/i.test(message)).length, 2);
  assert.ok((await indexNames()).includes('idx_documents_cover_degree'));
});

test('a build that keeps timing out gives up for this run, leaves the legacy indexes, and the next run finishes', async () => {
  await resetToPreMigration();
  const warnings = captureWarnings();
  const rec = recordingClient(client, {
    failBatch: (sqls) => (isCreateOf('idx_documents_cover_program')(sqls) ? timeout : null),
  });
  const { options, waits } = fastOptions();
  let result;
  try {
    result = await db.runDocumentsIndexMigration({ client: rec.proxy, ...options });
  } finally { warnings.restore(); }
  assert.equal(result.complete, false);
  assert.equal(result.indexes.idx_documents_cover_program, 'failed');
  assert.equal(waits.length, 2, 'three attempts, two backoffs');
  const names = await indexNames();
  assert.ok(!names.includes('idx_documents_cover_program'), 'nothing partial is left behind');
  assert.deepEqual(await rows("SELECT 1 FROM sqlite_stat1 WHERE idx = 'idx_documents_cover_program'"), [], 'no statistics row without its index');
  for (const name of Object.keys(LEGACY_INDEXES)) assert.ok(names.includes(name), `${name} is dropped only after all four new indexes exist`);
  assert.equal(rec.batches.some((sqls) => sqls.some((sql) => /DROP INDEX/.test(sql))), false);
  assert.ok(warnings.seen.length >= 3);

  const next = await db.runDocumentsIndexMigration({ client, ...fastOptions().options });
  assert.equal(next.complete, true);
  assert.ok((await indexNames()).includes('idx_documents_cover_program'));
});

test('a permanent error is logged and not retried', async () => {
  await resetToPreMigration();
  const warnings = captureWarnings();
  const rec = recordingClient(client, {
    failBatch: (sqls) => (isCreateOf('idx_documents_cover_doc')(sqls) ? { code: 'SQLITE_ERROR', message: 'near "INDEX": syntax error' } : null),
  });
  const { options, waits } = fastOptions();
  let result;
  try {
    result = await db.runDocumentsIndexMigration({ client: rec.proxy, ...options });
  } finally { warnings.restore(); }
  assert.equal(result.complete, false);
  assert.deepEqual(waits, []);
  assert.equal(rec.batches.filter(isCreateOf('idx_documents_cover_doc')).length, 1);
  assert.equal(result.indexes.idx_documents_cover_degree, 'pending', 'later indexes are not attempted after a failure');
  await db.runDocumentsIndexMigration({ client, ...fastOptions().options });
});

test('SQLITE_BUSY is retried like a timeout', async () => {
  await resetToPreMigration();
  const warnings = captureWarnings();
  let failures = 0;
  const rec = recordingClient(client, {
    failBatch: (sqls) => (isCreateOf('idx_documents_cover_year')(sqls) && (failures += 1) === 1 ? { code: 'SQLITE_BUSY', message: 'database is locked' } : null),
  });
  const { options, waits } = fastOptions();
  try {
    assert.equal((await db.runDocumentsIndexMigration({ client: rec.proxy, ...options })).complete, true);
  } finally { warnings.restore(); }
  assert.deepEqual(waits, [30_000]);
});

test('a table that will not stay warm defers the build without issuing any write', async () => {
  await resetToPreMigration();
  const rec = recordingClient(client);
  let tick = 0;
  const slowClock = () => { tick += 5_000; return tick; }; // every prewarm "takes" 5 s
  const prewarms = [];
  const spied = new Proxy(rec.proxy, {
    get(obj, prop) {
      if (prop === 'execute') {
        return (stmt) => {
          if (/MAX\(synced_at\)/.test(typeof stmt === 'string' ? stmt : stmt.sql)) prewarms.push(1);
          return obj.execute(stmt);
        };
      }
      const value = obj[prop];
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
  const warnings = captureWarnings();
  let result;
  try {
    result = await db.runDocumentsIndexMigration({ client: spied, wait: async () => {}, now: slowClock });
  } finally { warnings.restore(); }
  assert.equal(result.indexes.idx_documents_cover_doc, 'deferred');
  assert.equal(prewarms.length, 3, 'at most three prewarm reads');
  assert.equal(rec.batches.some((sqls) => sqls.some((sql) => /CREATE INDEX IF NOT EXISTS idx_documents_cover/.test(sql))), false);
  assert.equal(result.complete, false);
  assert.ok(warnings.seen.some(([message]) => /not warm|deferred/i.test(message)));
});

test('a warm table builds after the first fast prewarm read', async () => {
  await resetToPreMigration();
  const prewarms = [];
  const spied = new Proxy(client, {
    get(obj, prop) {
      if (prop === 'execute') {
        return (stmt) => {
          if (/MAX\(synced_at\)/.test(typeof stmt === 'string' ? stmt : stmt.sql)) prewarms.push(1);
          return obj.execute(stmt);
        };
      }
      const value = obj[prop];
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
  let tick = 0;
  // Prewarm brackets: first read slow (2 s), second fast (10 ms), then every later read fast.
  const durations = [2_000, 10];
  let call = 0;
  const clock = () => { call += 1; if (call % 2 === 1) return tick; tick += durations[Math.floor(call / 2) - 1] ?? 10; return tick; };
  const result = await db.runDocumentsIndexMigration({ client: spied, wait: async () => {}, now: clock });
  assert.equal(result.complete, true);
  assert.ok(prewarms.length >= 2 + 3, `warmed (slow then fast), then once per index: saw ${prewarms.length}`);
});

test('an interrupted affiliation backfill resumes from its cursor on the next run', async () => {
  await resetToPreMigration();
  const warnings = captureWarnings();
  let chunk = 0;
  const failing = recordingClient(client, {
    failBatch: (sqls) => (sqls.some((sql) => /INSERT INTO document_affiliations[\s\S]*FROM documents d/.test(sql)) && (chunk += 1) === 3 ? timeout : null),
  });
  let first;
  try {
    first = await db.runDocumentsIndexMigration({ client: failing.proxy, ...fastOptions().options });
  } finally { warnings.restore(); }
  assert.equal(first.affiliations, 'interrupted');
  assert.equal(first.complete, false);
  assert.equal(db.isAffiliationsReady(), false, 'readers stay on json_each');
  assert.deepEqual((await rows("SELECT projection_value FROM serving_projection_state WHERE projection_key = 'document_affiliations_backfill'")).map(([v]) => v === 'complete'), [false]);

  const resumed = recordingClient(client);
  const second = await db.runDocumentsIndexMigration({ client: resumed.proxy, ...fastOptions().options });
  assert.equal(second.complete, true);
  assert.equal(db.isAffiliationsReady(), true, 'the readiness flag is set when the backfill completes');
  assert.ok(resumed.batches.length > 0 && resumed.batches.length < 10, 'only the remaining chunks ran');
  const [[mismatch]] = await rows(`
    SELECT (SELECT COUNT(*) FROM (SELECT DISTINCT d.doc_id, trim(CAST(a.value AS TEXT)) v FROM documents d, json_each(d.metadata_json, '$.affiliation') a
            WHERE v IS NOT NULL EXCEPT SELECT doc_id, value FROM document_affiliations))
         + (SELECT COUNT(*) FROM (SELECT doc_id, value FROM document_affiliations EXCEPT
            SELECT DISTINCT d.doc_id, trim(CAST(a.value AS TEXT)) FROM documents d, json_each(d.metadata_json, '$.affiliation') a))`);
  assert.equal(mismatch, 0);
});

test('the guarded entry point defers while a writer-heavy admin job runs, and is single-flight', async () => {
  await resetToPreMigration();
  const jobId = await db.createAdminJob({ type: 'citation_scan', label: 'test scan' });
  try {
    const deferred = await db.ensureDocumentServingIndexes(fastOptionsForEntry());
    assert.equal(deferred.complete, false);
    assert.equal(deferred.deferred, 'admin_job');
    assert.ok(!(await indexNames()).includes('idx_documents_cover_doc'), 'nothing was built while the job ran');
  } finally {
    await client.execute({ sql: "UPDATE admin_jobs SET status = 'completed', finished_at = ? WHERE id = ?", args: [new Date().toISOString(), jobId] });
  }
  const [a, b] = await Promise.all([db.ensureDocumentServingIndexes(fastOptionsForEntry()), db.ensureDocumentServingIndexes(fastOptionsForEntry())]);
  assert.equal(a, b, 'concurrent callers share one run');
  assert.equal(a.complete, true);
  const again = await db.ensureDocumentServingIndexes(fastOptionsForEntry());
  assert.equal(again.complete, true);
});

function fastOptionsForEntry() {
  return fastOptions().options;
}

test('the entry point never throws, even when the database is unusable', async () => {
  const warnings = captureWarnings();
  try {
    const broken = {
      execute: async () => { throw Object.assign(new Error('connection refused'), { code: 'HRANA_CLOSED_ERROR' }); },
      batch: async () => { throw new Error('connection refused'); },
    };
    const result = await db.runDocumentsIndexMigration({ client: broken, ...fastOptions().options });
    assert.equal(result.complete, false);
  } finally { warnings.restore(); }
});

test('the schema pass of a small table never fails the boot when an inline build fails', async () => {
  await resetToPreMigration();
  process.env.DOCUMENTS_INDEX_INLINE_MAX_ROWS = '100000';
  const warnings = captureWarnings();
  const rec = recordingClient(client, { failBatch: (sqls) => (isCreateOf('idx_documents_cover_year')(sqls) ? timeout : null) });
  try {
    await db.ensureSchemaWithRetry(rec.proxy); // must resolve
  } finally {
    process.env.DOCUMENTS_INDEX_INLINE_MAX_ROWS = '0';
    warnings.restore();
  }
  assert.ok(warnings.seen.some(([message]) => /build failed/i.test(message)));
  const names = await indexNames();
  assert.ok(names.includes('idx_documents_cover_doc') && !names.includes('idx_documents_cover_year'));
  assert.ok(names.includes('idx_documents_degree'), 'legacy indexes survive a failed build');
  await db.runDocumentsIndexMigration({ client, ...fastOptions().options });
});

test('the scheduler runs after the delay, retries while incomplete up to maxRuns, and can be cancelled', async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let runs = 0;
  const stop = db.scheduleDocumentServingIndexes({
    delayMs: 5, retryMs: 5, maxRuns: 3, run: async () => { runs += 1; return { complete: runs >= 2 }; },
  });
  await sleep(80);
  assert.equal(runs, 2, 'stops retrying once complete');
  stop();

  let always = 0;
  db.scheduleDocumentServingIndexes({ delayMs: 1, retryMs: 1, maxRuns: 3, run: async () => { always += 1; throw new Error('boom'); } });
  await sleep(80);
  assert.equal(always, 3, 'a throwing run is logged and capped by maxRuns');

  let cancelled = 0;
  const cancel = db.scheduleDocumentServingIndexes({ delayMs: 30, run: async () => { cancelled += 1; return { complete: true }; } });
  cancel();
  await sleep(80);
  assert.equal(cancelled, 0);
});

// --- Query plans ---

const PLAN_FILTERS = [
  ['none', {}],
  ['degree', { degree: 'Master of Arts - MA' }],
  ['program', { program: 'Education' }],
  ['affiliation', { affiliation: 'UBC' }],
  ['degree+affiliation', { degree: 'Doctor of Philosophy - PhD', affiliation: 'sfu' }],
];

const PLAN_READERS = {
  'Documents page': (filters) => db.queryCachedDocumentPage({ filters, limit: 20 }),
  'Documents page by title': (filters) => db.queryCachedDocumentPage({ filters, sortKey: 'title', sortDir: 'asc', limit: 20, offset: 20 }),
  'topic document page': (filters) => db.queryTopicDocumentPage({ filters, limit: 20 }),
  'visualization documents': (filters) => db.queryVisualizationDocuments({ filters }),
  'topic match counts': (filters) => db.getTopicMatchCounts({ filters }),
  'topic by year': (filters) => db.getTopicByYearCounts({ filters }),
  'analytics': (filters) => db.getDocumentServingAnalytics({ filters }),
  'citation documents': (filters) => db.queryCitationDocumentPage({ filters, limit: 20 }),
  'people page': (filters) => db.queryPeoplePage({ filters, limit: 20 }),
  'summary (facets)': () => db.getDocumentServingSummary({}),
  'cache stats': () => db.getDocumentCacheStats(null),
  'related documents': () => db.queryRelatedDocuments({ id: 'corp-0001', themes: ['theme 1'], conceptTerms: ['concept 1'] }),
};

// Statements the serving readers run, with their arguments.
async function captureReaderStatements(read, targetClient = client) {
  const seen = [];
  const original = targetClient.execute.bind(targetClient);
  targetClient.execute = (stmt) => {
    if (typeof stmt !== 'string' && /^\s*(SELECT|WITH)\b/i.test(stmt.sql)) seen.push(stmt);
    return original(stmt);
  };
  try { await read(); } finally { targetClient.execute = original; }
  return seen;
}

async function planDetails(statement, targetClient = client) {
  const plan = await targetClient.execute({ sql: `EXPLAIN QUERY PLAN ${statement.sql}`, args: statement.args });
  return plan.rows.map((row) => String(row.detail));
}

// A documents access that is not index-only: a table scan, or an index search that
// goes back to the table. Allowed: the analytics "overall" statement (it reads
// charCount out of metadata_json), the q search (LIKE over metadata_json), and
// phase two of the Documents page, which fetches metadata_json for the page's rows.
function tableAccessViolations(statement, details) {
  const sql = statement.sql;
  if (/json_extract\(d\.metadata_json, '\$\.charCount'\)/.test(sql)) return [];
  if (/FROM page p\b/.test(sql)) {
    const isRowFetch = (d) => /^SEARCH d USING INDEX \S+ \(doc_id=\?\)$/.test(d);
    if (details.filter(isRowFetch).length > 1) return ['more than one row-fetch of documents'];
    details = details.filter((d) => !isRowFetch(d));
  }
  return details.filter((d) => /^(SCAN|SEARCH) d\b/.test(d) && !/COVERING INDEX/.test(d));
}

test('every serving reader reaches documents only through a covering index, for every filter shape', async () => {
  await resetToPreMigration();
  assert.equal((await db.runDocumentsIndexMigration({ client, ...fastOptions().options })).complete, true);
  db.__setDocumentTermsReadyForTesting(true);
  await db.initCitationCountsReadiness(client);
  assert.equal(db.isAffiliationsReady(), true);
  // A connection opened after the build, as every other connection is: SQLite reads
  // sqlite_stat1 when it loads the schema, not when a statistics row is inserted.
  const planClient = createClient({ url: `file:${dbPath}` });
  const problems = [];
  let examined = 0;
  for (const [filterName, filters] of PLAN_FILTERS) {
    for (const [readerName, read] of Object.entries(PLAN_READERS)) {
      for (const statement of await captureReaderStatements(() => read(filters))) {
        if (!/\bdocuments d?\b/.test(statement.sql)) continue;
        examined += 1;
        const details = await planDetails(statement, planClient);
        const bad = tableAccessViolations(statement, details);
        if (bad.length) problems.push(`${readerName} / ${filterName}: ${bad.join(' | ')}\n    ${statement.sql.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
  }
  planClient.close();
  assert.ok(examined > 40, `examined ${examined} statements`);
  assert.deepEqual(problems, []);
});

test('without the statistics rows the planner falls back to the primary-key index and reads the table again', async () => {
  await resetToPreMigration();
  assert.equal((await db.runDocumentsIndexMigration({ client, ...fastOptions().options })).complete, true);
  db.__setDocumentTermsReadyForTesting(true);
  // The shape of the topic probes: driven from a child table (pinned with CROSS JOIN so the
  // result does not depend on table sizes), fetching documents' columns by doc_id.
  const statement = { sql: 'SELECT t.topic_id, d.year, d.title, d.access_status FROM document_topics t CROSS JOIN documents d ON d.doc_id = t.doc_id', args: [] };
  const probe = async () => {
    const fresh = createClient({ url: `file:${dbPath}` });
    try { return await planDetails(statement, fresh); } finally { fresh.close(); }
  };
  const withStats = await probe();
  assert.ok(withStats.some((d) => /SEARCH d USING COVERING INDEX idx_documents_cover_doc \(doc_id=\?\)/.test(d)), `with statistics: ${withStats.join(' | ')}`);
  await client.execute("DELETE FROM sqlite_stat1 WHERE idx LIKE 'idx_documents_cover%'");
  const without = await probe();
  assert.ok(without.some((d) => /SEARCH d USING INDEX sqlite_autoindex_documents_1 \(doc_id=\?\)/.test(d)), `without statistics: ${without.join(' | ')}`);
  // Restore what the migration wrote.
  for (const index of db.DOCUMENT_SERVING_INDEXES) await client.execute({ sql: 'DROP INDEX IF EXISTS ' + index.name });
  await db.runDocumentsIndexMigration({ client, ...fastOptions().options });
});

// Review (DBA, phase 4): the warm gate must warm what CREATE INDEX reads, the table.
// Once one covering index exists, the planner answers the prewarm aggregate from that
// index (every column it reads is covered), so the gate would report "warm" while the
// table pages the next build scans are still cold.
test('every prewarm read scans the documents table itself, also after a covering index exists', async () => {
  await resetToPreMigration();
  const prewarmSql = new Set();
  const spied = new Proxy(client, {
    get(obj, prop) {
      if (prop === 'execute') {
        return (stmt) => {
          const sql = typeof stmt === 'string' ? stmt : stmt.sql;
          if (/MAX\(synced_at\)/.test(sql)) prewarmSql.add(sql);
          return obj.execute(stmt);
        };
      }
      const value = obj[prop];
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
  assert.equal((await db.runDocumentsIndexMigration({ client: spied, wait: async () => {}, now: () => 0 })).complete, true);
  assert.ok(prewarmSql.size > 0, 'the migration issued prewarm reads');
  const fresh = createClient({ url: `file:${dbPath}` });
  try {
    for (const sql of prewarmSql) {
      const plan = (await fresh.execute(`EXPLAIN QUERY PLAN ${sql}`)).rows.map((r) => String(r.detail));
      assert.ok(plan.some((d) => /^SCAN documents$/.test(d)) && !plan.some((d) => /INDEX/.test(d)),
        `prewarm must scan the table, not an index: ${plan.join(' | ')}`);
    }
  } finally { fresh.close(); }
});

// Review (DBA, phase 4): the admin-job guard ran once, before the run. A writer-heavy job
// that starts during the run (e.g. inside a 30 s / 2 min build backoff) must stop the
// remaining builds and the backfill, not run alongside them.
test('a writer-heavy admin job that starts mid-run defers the remaining builds', async () => {
  await resetToPreMigration();
  let jobId = null;
  const onStep = async (step) => {
    if (step.step === 'build' && step.index === 'idx_documents_cover_doc' && jobId == null) {
      jobId = await db.createAdminJob({ type: 'citation_scan', label: 'scan started mid-migration' });
    }
  };
  let result;
  try {
    result = await db.ensureDocumentServingIndexes({ ...fastOptions().options, onStep });
    assert.notEqual(jobId, null, 'the job was started after the first build');
    assert.equal(result.complete, false);
    assert.equal(result.indexes.idx_documents_cover_doc, 'built');
    assert.equal(result.indexes.idx_documents_cover_degree, 'deferred');
    const names = await indexNames();
    assert.ok(!names.includes('idx_documents_cover_degree'), 'no build after the job started');
    assert.ok(names.includes('idx_documents_degree'), 'legacy indexes kept');
  } finally {
    if (jobId != null) {
      await client.execute({ sql: "UPDATE admin_jobs SET status = 'completed', finished_at = ? WHERE id = ?", args: [new Date().toISOString(), jobId] });
    }
  }
  const resumed = await db.ensureDocumentServingIndexes(fastOptions().options);
  assert.equal(resumed.complete, true);
});

// Review (DBA, phase 4, after the Turso-branch rehearsal of 2026-11-09): Turso's planner
// did not use a covering index for a plain full scan of documents. Every unfiltered
// serving statement printed `SCAN d` (the 18k-page table) although a covering index had
// every column. A doc_id range lets any planner SEARCH idx_documents_cover_doc instead.
// The rule here is planner-independent: an unfiltered serving statement must reach
// documents through an index SEARCH (or the one-column primary-key index the branch did
// use for COUNT(d.doc_id)), never through a full SCAN of the table or a wide index.
test('unfiltered serving statements reach documents through an index SEARCH, not a full scan', async () => {
  await resetToPreMigration();
  assert.equal((await db.runDocumentsIndexMigration({ client, ...fastOptions().options })).complete, true);
  db.__setDocumentTermsReadyForTesting(true);
  await db.initCitationCountsReadiness(client);
  const readers = {
    'Documents page': () => db.queryCachedDocumentPage({ filters: {}, limit: 20 }),
    'Documents page by title': () => db.queryCachedDocumentPage({ filters: {}, sortKey: 'title', sortDir: 'asc', limit: 20 }),
    analytics: () => db.getDocumentServingAnalytics({ filters: {} }),
    'citation documents': () => db.queryCitationDocumentPage({ filters: {}, limit: 20 }),
    'citation documents by title': () => db.queryCitationDocumentPage({ filters: {}, sortKey: 'title', sortDir: 'asc', limit: 20 }),
    summary: () => db.getDocumentServingSummary({}),
    'cache stats': () => db.getDocumentCacheStats(null),
    'concept terms': () => db.queryConceptTermsByDoc({ filters: {} }),
  };
  const planClient = createClient({ url: `file:${dbPath}` });
  const problems = [];
  try {
    for (const [name, read] of Object.entries(readers)) {
      const seen = [];
      const original = client.execute.bind(client);
      client.execute = (stmt) => {
        const s = typeof stmt === 'string' ? { sql: stmt, args: [] } : stmt;
        if (/^\s*(SELECT|WITH)\b/i.test(s.sql) && /\bdocuments\b/.test(s.sql)) seen.push(s);
        return original(stmt);
      };
      try { await read(); } finally { client.execute = original; }
      for (const statement of seen) {
        if (/json_extract\(d\.metadata_json, '\$\.charCount'\)/.test(statement.sql)) continue; // reads metadata_json anyway
        const details = await planDetails(statement, planClient);
        // The unfiltered COUNT(d.doc_id) may scan the narrowest index: the branch chose the
        // one-column primary-key index for it.
        if (/^\s*SELECT COUNT\(d\.doc_id\) AS total FROM documents d\s*$/.test(statement.sql)) continue;
        const fullScans = details.filter((d) => /^SCAN (d|documents)\b/.test(d)
          && !/USING COVERING INDEX sqlite_autoindex_documents_1$/.test(d));
        const tableReads = tableAccessViolations(statement, details);
        if (fullScans.length || tableReads.length) {
          problems.push(`${name}: ${[...fullScans, ...tableReads].join(' | ')}\n    ${statement.sql.replace(/\s+/g, ' ').slice(0, 140)}`);
        }
      }
    }
  } finally { planClient.close(); }
  assert.deepEqual(problems, []);
});

// Review (DBA, phase 4): with the projection filter `d.doc_id IN (SELECT … affiliations)`,
// the people page's filtered_people CTE was planned as a co-routine evaluated twice; the
// second pass looped over every matched person key and, inside it, over every document in
// the affiliation list (`SEARCH p (doc_id=? AND person_key=?)` + REUSE LIST SUBQUERY). On
// the Turso branch that read 10.08 M rows in 4.9 s per statement. Materialized, it is
// computed once.
test('the people page computes its filtered rows once (no per-key loop over the affiliation list)', async () => {
  await resetToPreMigration();
  assert.equal((await db.runDocumentsIndexMigration({ client, ...fastOptions().options })).complete, true);
  assert.equal(db.isAffiliationsReady(), true);
  const statements = await captureReaderStatements(() => db.queryPeoplePage({ filters: { affiliation: 'UBC' }, limit: 20 }));
  assert.ok(statements.length >= 2);
  for (const statement of statements) {
    const details = await planDetails(statement);
    assert.ok(details.some((d) => /MATERIALIZE filtered_people/.test(d)), `filtered_people is not materialized: ${details.join(' | ')}`);
    assert.ok(!details.some((d) => /SEARCH p USING INDEX \S+ \(doc_id=\? AND person_key=\?\)/.test(d)),
      `per-key probe over the affiliation list: ${details.join(' | ')}`);
  }
});
