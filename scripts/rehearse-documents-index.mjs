#!/usr/bin/env node
// Rehearses the documents covering-index migration (M-8) end to end against a
// database you can afford to change: a Turso BRANCH of prod, a local sqld, or a
// local file copy.
//
//   turso db create documents-index-rehearsal --from-db <prod>      # the owner's step
//   TURSO_DATABASE_URL=libsql://<branch-host> TURSO_AUTH_TOKEN=<branch token> \
//     node scripts/rehearse-documents-index.mjs --confirm-target=<branch-host>
//
// Local dry runs: TURSO_DATABASE_URL=http://127.0.0.1:8080 (a local sqld) with
// --confirm-target=127.0.0.1:8080, or TURSO_DATABASE_URL=file:/path/copy.sqlite with
// --confirm-target=/path/copy.sqlite (file targets report wall time only).
//
// It writes to the target (CREATE INDEX, sqlite_stat1 rows, DROP INDEX, the
// document_affiliations table and triggers), so it refuses unless --confirm-target
// names the host (or file path) you intend, and it always refuses the production
// database host. It never reads a .env file, and never prints the auth token or the
// database URL (only the host).
//
// Every statement of the boot pass, the migration and the verification goes through
// the raw Hrana /v2/pipeline endpoint, so each step reports the server's own
// rows_read, rows_written and query_duration_ms (what Turso bills and how long the
// server worked), next to wall time. @libsql/client 0.17 drops those fields.
//
// Options:
//   --max-rounds=N        migration rounds before giving up (default 4)
//   --round-pause-ms=N    pause between rounds (default 5000)
//   --retry-scale=X       scale the 30 s / 2 min build backoffs (default 1; 0.01 for a dry run)
//   --cold-build-probe    before the migration, build (then drop) one throwaway index with
//                         the idx_documents_cover_doc columns WITHOUT warming the table, to
//                         measure what an ungated cold build would hold the write lock for.
//                         Run it first thing on a fresh branch, with nothing else connected.
//   --plan-passes=N       repeat the plan check N times on separate requests (default 2), to
//                         catch a server connection still holding pre-build statistics.
//                         Plans are EXPLAINs (no rows read); each reader statement is executed
//                         once, through the stats client, which is also where its cost is read.
//   --shapes=a,b          filter shapes for the reader sweep (default none,degree,program,affiliation)
//   --skip-recount        skip the full json_each recount (reads every metadata_json)

process.env.SKIP_LOCAL_ENV = '1';

const PROD_HOST = 'dissertation-workbench-exampleorg.aws-us-east-1.turso.io';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  return [key, value ?? true];
}));

const url = String(process.env.TURSO_DATABASE_URL || '').trim();
const token = String(process.env.TURSO_AUTH_TOKEN || '').trim();
if (!url) {
  console.error('Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN) to the branch to rehearse against.');
  process.exit(2);
}
const isFile = url.startsWith('file:');
let target;
let pipelineUrl = null;
try {
  if (isFile) {
    target = url.slice('file:'.length);
  } else {
    const parsed = new URL(url.replace(/^libsql:/, 'https:'));
    target = parsed.host;
    pipelineUrl = `${parsed.protocol}//${parsed.host}/v2/pipeline`;
  }
} catch {
  console.error('TURSO_DATABASE_URL is not a valid URL.');
  process.exit(2);
}
if (!isFile && target.split(':')[0].toLowerCase() === PROD_HOST) {
  console.error(`Refusing: ${PROD_HOST} is the production database. Rehearse on a branch.`);
  process.exit(2);
}
if (args['confirm-target'] !== target) {
  console.error(`Refusing to write to ${target}. Re-run with --confirm-target=${target} if that is the branch.`);
  process.exit(2);
}

const { createClient } = await import('@libsql/client');
const { logger } = await import('../src/logger.js');
const db = await import('../src/db.js');

// --- A client whose execute/batch go through /v2/pipeline and record server stats ---

const stats = { current: null, steps: [] };
function beginStep(label) {
  const step = { label, statements: 0, rowsRead: 0, rowsWritten: 0, queryMs: 0, wallMs: 0, started: Date.now(), detail: [] };
  stats.steps.push(step);
  stats.current = step;
  return step;
}
function endStep(step) {
  step.wallMs = Date.now() - step.started;
  if (stats.current === step) stats.current = null;
  return step;
}
function record(sql, result, wallMs) {
  const step = stats.current;
  if (!step || !result) return;
  step.statements += 1;
  step.rowsRead += Number(result.rows_read || 0);
  step.rowsWritten += Number(result.rows_written || 0);
  step.queryMs += Number(result.query_duration_ms || 0);
  if (/^\s*(CREATE INDEX|DROP INDEX|INSERT OR REPLACE INTO sqlite_stat1)/i.test(sql)) {
    step.detail.push({
      sql: sql.replace(/\s+/g, ' ').slice(0, 70),
      rowsRead: Number(result.rows_read || 0), rowsWritten: Number(result.rows_written || 0),
      queryMs: Number(result.query_duration_ms || 0), wallMs,
    });
  }
}

const toHranaValue = (v) => {
  if (v == null) return { type: 'null' };
  if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  return { type: 'text', value: String(v) };
};
const fromHranaValue = (v) => {
  if (!v || v.type === 'null') return null;
  if (v.type === 'integer') return Number(v.value);
  if (v.type === 'float') return Number(v.value);
  return v.value;
};
const toStmt = (stmt) => {
  const sql = typeof stmt === 'string' ? stmt : stmt.sql;
  const params = typeof stmt === 'string' ? [] : (stmt.args || []);
  if (!Array.isArray(params)) throw new Error('named arguments are not supported by the rehearsal client');
  return { sql, args: params.map(toHranaValue) };
};
function toResultSet(result) {
  const columns = result.cols.map((c) => c.name);
  const rows = result.rows.map((row) => {
    const obj = {};
    // Same shape as @libsql/client rows: named columns enumerable, indices and length not.
    row.forEach((v, i) => {
      const value = fromHranaValue(v);
      Object.defineProperty(obj, i, { value, enumerable: false });
      obj[columns[i]] = value;
    });
    Object.defineProperty(obj, 'length', { value: columns.length, enumerable: false });
    return obj;
  });
  return { columns, rows, rowsAffected: Number(result.affected_row_count || 0), lastInsertRowid: result.last_insert_rowid };
}
function hranaError(error) {
  const e = new Error(error?.message || 'statement failed');
  e.code = error?.code || 'UNKNOWN';
  return e;
}
async function pipeline(requests) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(pipelineUrl, { method: 'POST', headers, body: JSON.stringify({ requests: [...requests, { type: 'close' }] }) });
  } catch (error) {
    throw Object.assign(new Error(`request to ${target} failed: ${error?.cause?.code || error?.message || 'network error'}`), { code: 'HRANA_WEBSOCKET_ERROR' });
  }
  if (!response.ok) throw Object.assign(new Error(`${target} answered HTTP ${response.status}`), { code: 'SERVER_ERROR' });
  return (await response.json()).results;
}

function statsClient(fallback) {
  if (isFile) return fallback; // a file target has no server stats: wall time only
  const execute = async (stmt) => {
    const s = toStmt(stmt);
    const started = Date.now();
    const [r] = await pipeline([{ type: 'execute', stmt: s }]);
    if (r.type !== 'ok') throw hranaError(r.error);
    record(s.sql, r.response.result, Date.now() - started);
    const rs = toResultSet(r.response.result);
    Object.defineProperty(rs, 'serverStats', {
      value: { rowsRead: Number(r.response.result.rows_read || 0), queryMs: Number(r.response.result.query_duration_ms || 0) },
      enumerable: false,
    });
    return rs;
  };
  // Same transaction shape as @libsql/client's write batch: BEGIN IMMEDIATE, each
  // statement only if the previous succeeded, COMMIT, and ROLLBACK if COMMIT did not run.
  const batch = async (stmts, mode = 'write') => {
    const list = stmts.map(toStmt);
    const begin = mode === 'read' ? 'BEGIN TRANSACTION READONLY' : (mode === 'deferred' ? 'BEGIN DEFERRED' : 'BEGIN IMMEDIATE');
    const steps = [{ stmt: { sql: begin } }];
    list.forEach((s, i) => steps.push({ stmt: s, condition: { type: 'ok', step: i } }));
    const commitStep = steps.length;
    steps.push({ stmt: { sql: 'COMMIT' }, condition: { type: 'ok', step: commitStep - 1 } });
    steps.push({ stmt: { sql: 'ROLLBACK' }, condition: { type: 'not', cond: { type: 'ok', step: commitStep } } });
    const started = Date.now();
    const [r] = await pipeline([{ type: 'batch', batch: { steps } }]);
    if (r.type !== 'ok') throw hranaError(r.error);
    const { step_results: results, step_errors: errors } = r.response.result;
    const wallMs = Date.now() - started;
    const failed = errors.findIndex((e, i) => e && i < commitStep + 1);
    list.forEach((s, i) => record(s.sql, results[i + 1], wallMs));
    if (failed !== -1) throw hranaError(errors[failed]);
    return list.map((_, i) => toResultSet(results[i + 1]));
  };
  return new Proxy(fallback, {
    get(obj, prop) {
      if (prop === 'execute') return execute;
      if (prop === 'batch') return batch;
      const value = obj[prop];
      return typeof value === 'function' ? value.bind(obj) : value; // executeMultiple, transaction: no stats
    },
  });
}

// --- Output helpers ---

const failures = [];
const fmt = (ms) => `${(ms / 1000).toFixed(2)} s`;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const stepLine = (s) => `${fmt(s.wallMs).padStart(9)} wall  ${isFile ? '' : `${fmt(s.queryMs).padStart(9)} server  rows_read ${String(s.rowsRead).padStart(8)}  rows_written ${String(s.rowsWritten).padStart(7)}  `}${s.label}`;
async function step(label, fn) {
  const s = beginStep(label);
  try { return await fn(); } finally { endStep(s); console.log(`  ${stepLine(s)}`); }
}

console.log(`Target: ${target}${isFile ? ' (file: wall time only)' : ''}\n`);
const rawClient = createClient({ url, authToken: token || undefined });
const client = statsClient(rawClient);

// 1. The boot path. On a large table it must build nothing and finish quickly.
console.log('1. Boot schema pass');
await step('ensureSchema (the boot pass, through the stats client)', () => db.ensureSchemaWithRetry(client));
await step('module getDb() (second pass + readiness, wall only)', () => db.getDb());
const documents = Number((await client.execute('SELECT COUNT(doc_id) AS n FROM documents')).rows[0].n);
const names = async () => (await client.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'documents' ORDER BY name"))
  .rows.map((row) => String(row.name));
const afterBoot = await names();
console.log(`  documents: ${documents}; indexes after boot: ${afterBoot.join(', ')}`);
if (documents >= db.documentsInlineMaxRows()) {
  check(!afterBoot.some((name) => name.startsWith('idx_documents_cover')),
    'the boot pass built no covering index on a large table');
}
const statTable = (await client.execute("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'")).rows.length > 0;
check(statTable, 'sqlite_stat1 exists on the target (the migration writes its rows there)');

// Optional: the cost of an ungated cold build.
if (args['cold-build-probe']) {
  console.log('\n   Cold-build probe (throwaway index, table not warmed)');
  const cols = db.DOCUMENT_SERVING_INDEXES[0].columns.join(', ');
  await step('CREATE INDEX idx_rehearsal_cold_probe (cold)', () => client.execute(`CREATE INDEX idx_rehearsal_cold_probe ON documents(${cols})`));
  await step('DROP INDEX idx_rehearsal_cold_probe', () => client.execute('DROP INDEX IF EXISTS idx_rehearsal_cold_probe'));
  const probe = stats.steps.find((x) => x.label.startsWith('CREATE INDEX idx_rehearsal_cold_probe'));
  console.log(`   cold build held the write transaction for about ${fmt(probe.queryMs || probe.wallMs)} (an ungated build in the boot pass would have done this, four times)`);
}

// 2. The migration, as the scheduler runs it: repeated until complete.
console.log('\n2. Migration');
const scale = Number(args['retry-scale'] ?? 1);
let result = null;
const maxRounds = Number(args['max-rounds'] ?? 4);
// Each round is split into phases at the migration's own events, so the server cost
// of "prewarm + CREATE INDEX + stat row" is reported per index.
const labelFor = (round, event) => (event.step === 'build'
  ? `round ${round}: prewarm + build ${event.index} (attempt ${event.attempt})`
  : event.step === 'drop-legacy' ? `round ${round}: drop legacy indexes`
    : `round ${round}: affiliation backfill (${event.chunks} chunks)`);
for (let round = 1; round <= maxRounds; round += 1) {
  let phase = beginStep(`round ${round}: (in progress)`);
  result = await db.runDocumentsIndexMigration({
    client,
    onStep: (event) => {
      phase.label = labelFor(round, event);
      endStep(phase); console.log(`  ${stepLine(phase)}`);
      phase = beginStep(`round ${round}: (in progress)`);
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms * scale)),
  });
  phase.label = `round ${round}: status checks, deferrals and failed attempts`;
  endStep(phase); console.log(`  ${stepLine(phase)}`);
  console.log(`  round ${round}: indexes ${JSON.stringify(result.indexes)}; legacy dropped ${result.legacyDropped}; affiliations ${result.affiliations}`);
  if (result.complete) break;
  await new Promise((resolve) => setTimeout(resolve, Number(args['round-pause-ms'] ?? 5000)));
}
check(Boolean(result?.complete), 'the migration completed');

console.log('\n   Per-statement cost of the builds and drops (server figures)');
for (const s of stats.steps) {
  for (const d of s.detail) {
    console.log(`   ${fmt(d.queryMs).padStart(9)} server  ${fmt(d.wallMs).padStart(9)} wall  rows_read ${String(d.rowsRead).padStart(7)}  rows_written ${String(d.rowsWritten).padStart(6)}  ${d.sql}`);
  }
}
const builds = stats.steps.flatMap((s) => s.detail).filter((d) => /^CREATE INDEX IF NOT EXISTS idx_documents_cover/.test(d.sql));
for (const d of builds) {
  const held = isFile ? d.wallMs : d.queryMs;
  check(held < 5000, `build under the 5 s transaction limit: ${d.sql.match(/idx_documents_cover_\w+/)?.[0]}`, fmt(held));
}

// 3. Verification.
console.log('\n3. Verification');
const verify = beginStep('verification');
const present = await names();
const wanted = db.DOCUMENT_SERVING_INDEXES.map((index) => index.name);
check(wanted.every((name) => present.includes(name)), 'all four covering indexes exist', present.join(', '));
check(!present.some((name) => ['idx_documents_degree', 'idx_documents_degree_year', 'idx_documents_program', 'idx_documents_year', 'idx_rehearsal_cold_probe'].includes(name)),
  'the legacy indexes are gone');
const statRows = (await client.execute("SELECT idx, stat FROM sqlite_stat1 WHERE tbl = 'documents' ORDER BY idx")).rows;
for (const name of wanted) {
  const row = statRows.find((r) => r.idx === name);
  check(Boolean(row) && String(row.stat).split(' ').length === 10, `sqlite_stat1 row for ${name} (accepted by the target)`, row ? String(row.stat) : 'missing');
}

console.log('\n  Query plans and server cost of the statements the real readers run');
await db.initDocumentTermsReadiness();
await db.initAffiliationsReadiness();
const topValue = async (column) => (await client.execute(
  `SELECT ${column} AS v FROM documents WHERE ${column} IS NOT NULL GROUP BY ${column} ORDER BY COUNT(*) DESC LIMIT 1`,
)).rows[0]?.v;
const topAffiliation = (await client.execute(
  "SELECT value AS v FROM document_affiliations WHERE value <> '' GROUP BY value ORDER BY COUNT(*) DESC LIMIT 1",
)).rows[0]?.v || 'UBC';
const shapes = [
  ['none', {}],
  ['degree', { degree: await topValue('degree') }],
  ['program', { program: await topValue('program') }],
  ['affiliation', { affiliation: topAffiliation }],
];
// --shapes=none,degree limits the reader sweep (each shape executes every reader once).
const shapeFilter = args.shapes ? new Set(String(args.shapes).split(',')) : null;
const selectedShapes = shapeFilter ? shapes.filter(([name]) => shapeFilter.has(name)) : shapes;
const readers = {
  'Documents page': (filters) => db.queryCachedDocumentPage({ filters, limit: 50 }),
  'visualizations': (filters) => db.queryVisualizationDocuments({ filters }),
  'topic match counts': (filters) => db.getTopicMatchCounts({ filters }),
  'topic by year': (filters) => db.getTopicByYearCounts({ filters }),
  'analytics': (filters) => db.getDocumentServingAnalytics({ filters }),
  'citation documents': (filters) => db.queryCitationDocumentPage({ filters, limit: 50 }),
  'people page': (filters) => db.queryPeoplePage({ filters, limit: 50 }),
  'summary': () => db.getDocumentServingSummary({}),
  'cache stats': () => db.getDocumentCacheStats(null),
};
const moduleClient = await db.getDb();
const originalExecute = moduleClient.execute.bind(moduleClient);
const captured = [];
// The readers run ONCE, with their SELECTs on documents sent through the stats client, so
// each statement's server rows_read and time are measured on that single execution (the
// first rehearsal re-ran every statement to cost it, doubling the 25 M rows it read).
// Statements are captured whether the reader passes SQL text or {sql, args}.
const readerOnce = new Set(['summary', 'cache stats']);
for (const [shapeName, filters] of selectedShapes) {
  for (const [readerName, read] of Object.entries(readers)) {
    if (readerOnce.has(readerName) && shapeName !== 'none') continue; // filter-independent readers
    moduleClient.execute = async (stmt) => {
      const s = typeof stmt === 'string' ? { sql: stmt, args: [] } : { sql: stmt.sql, args: stmt.args || [] };
      if (!/^\s*(SELECT|WITH)\b/i.test(s.sql) || !/\bdocuments\b/.test(s.sql)) return originalExecute(stmt);
      if (isFile) { captured.push({ shapeName, readerName, stmt: s, rowsRead: 0, queryMs: 0 }); return originalExecute(stmt); }
      // Per-statement figures come from that statement's own response: readers such as
      // analytics run statements concurrently, so step-total deltas would overlap.
      const result = await client.execute(s);
      captured.push({ shapeName, readerName, stmt: s, rowsRead: result.serverStats.rowsRead, queryMs: result.serverStats.queryMs });
      return result;
    };
    try { await read(filters); } finally { moduleClient.execute = originalExecute; }
  }
}
const passes = Math.max(1, Number(args['plan-passes'] ?? 2));
let planProblems = 0;
for (let pass = 1; pass <= passes; pass += 1) {
  for (const { shapeName, readerName, stmt, rowsRead, queryMs } of captured) {
    // Each EXPLAIN is its own request (its own server stream), so a connection still
    // holding pre-build statistics shows up as a failure on some pass. EXPLAIN reads no rows.
    const plan = (await client.execute({ sql: `EXPLAIN QUERY PLAN ${stmt.sql}`, args: stmt.args })).rows.map((row) => String(row.detail));
    const accesses = plan.filter((detail) => /^(SCAN|SEARCH) (d|documents)\b/.test(detail));
    const exempt = /json_extract\(d\.metadata_json, '\$\.charCount'\)/.test(stmt.sql);
    let bad = exempt ? [] : accesses.filter((detail) => !/COVERING INDEX/.test(detail));
    if (/FROM page p\b/.test(stmt.sql)) bad = bad.filter((detail) => !/^SEARCH d USING INDEX \S+ \(doc_id=\?\)$/.test(detail));
    if (bad.length) planProblems += 1;
    if (pass === 1 || bad.length) {
      const cost = pass === 1 ? `rows_read ${String(rowsRead).padStart(7)}  ${fmt(queryMs).padStart(8)} server  ` : '';
      console.log(`  ${bad.length ? 'FAIL' : 'ok  '} p${pass} ${shapeName.padEnd(11)} ${readerName.padEnd(19)} ${cost}${accesses.join(' | ') || '(no documents access)'}`);
    }
  }
}
const readerRows = captured.reduce((sum, c) => sum + c.rowsRead, 0);
console.log(`  reader statements: ${captured.length}; rows_read for all of them: ${readerRows}`);
check(planProblems === 0, `every serving statement reaches documents through a covering index on all ${passes} passes (analytics charCount and the page row-fetch excepted)`);

if (!args['skip-recount']) {
  console.log('\n  Projection against a fresh recount (reads every metadata_json)');
  const recount = (await client.execute(`
    SELECT
      (SELECT COUNT(*) FROM (
         SELECT DISTINCT d.doc_id, trim(CAST(a.value AS TEXT)) AS value
         FROM documents d, json_each(CASE WHEN json_valid(d.metadata_json) THEN d.metadata_json END, '$.affiliation') a
         WHERE trim(CAST(a.value AS TEXT)) IS NOT NULL
         EXCEPT SELECT doc_id, value FROM document_affiliations)) AS missing,
      (SELECT COUNT(*) FROM (
         SELECT doc_id, value FROM document_affiliations
         EXCEPT
         SELECT DISTINCT d.doc_id, trim(CAST(a.value AS TEXT))
         FROM documents d, json_each(CASE WHEN json_valid(d.metadata_json) THEN d.metadata_json END, '$.affiliation') a)) AS extra,
      (SELECT COUNT(*) FROM document_affiliations) AS projected`)).rows[0];
  check(Number(recount.missing) === 0 && Number(recount.extra) === 0, 'document_affiliations equals the recount',
    `${recount.projected} rows, ${recount.missing} missing, ${recount.extra} extra`);
}
const readiness = await db.initAffiliationsReadiness(client);
check(readiness === true, 'affiliation readiness flag set');
endStep(verify);

console.log('\nSteps (server figures from /v2/pipeline)');
for (const s of stats.steps) console.log(`  ${stepLine(s)}`);
console.log(failures.length ? `\n${failures.length} check(s) FAILED:\n  - ${failures.join('\n  - ')}` : '\nAll checks passed.');
logger.info('Rehearsal finished', { target, failures: failures.length });
rawClient.close();
await db.closeDb();
process.exit(failures.length ? 1 : 0);
