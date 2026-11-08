#!/usr/bin/env node
// Rehearses the documents covering-index migration (M-8) end to end against a
// database you can afford to change: a Turso BRANCH of prod, or a local copy.
//
//   turso db create documents-index-rehearsal --from-db <prod>      # the owner's step
//   TURSO_DATABASE_URL=libsql://<branch>.turso.io TURSO_AUTH_TOKEN=<branch token> \
//     node scripts/rehearse-documents-index.mjs --confirm-target=<branch>.turso.io
//
// For a local dry run: TURSO_DATABASE_URL=file:/path/to/copy.sqlite and
// --confirm-target=/path/to/copy.sqlite.
//
// It writes to the target (CREATE INDEX, sqlite_stat1 rows, DROP INDEX, the
// document_affiliations table and triggers), so it refuses to run unless
// --confirm-target names the host (or file path) you intend. It never reads a .env
// file. Steps: boot schema pass (must build nothing on a large table) -> the
// migration, repeated like the scheduler would until complete -> verification
// (indexes, sqlite_stat1 rows, query plans, projection == recount).
//
// Options:
//   --max-rounds=N      migration rounds before giving up (default 4)
//   --round-pause-ms=N  pause between rounds (default 5000)
//   --retry-scale=X     scale the 30 s / 2 min build backoffs (default 1; 0.01 for a dry run)
//   --skip-recount      skip the full json_each recount (reads every metadata_json)
//
// Timings are wall-clock. @libsql/client does not expose rows_read / rows_written, so
// those are reported as rowsAffected where the statement returns it; compare the
// branch's usage in the Turso dashboard before and after for billed rows.

process.env.SKIP_LOCAL_ENV = '1';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  return [key, value ?? true];
}));

const url = String(process.env.TURSO_DATABASE_URL || '').trim();
if (!url) {
  console.error('Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN) to the branch to rehearse against.');
  process.exit(2);
}
const target = url.startsWith('file:') ? url.slice('file:'.length) : new URL(url.replace(/^libsql:/, 'https:')).host;
if (args['confirm-target'] !== target) {
  console.error(`Refusing to write to ${target}. Re-run with --confirm-target=${target} if that is the branch.`);
  process.exit(2);
}

const { createClient } = await import('@libsql/client');
const { logger } = await import('../src/logger.js');
const db = await import('../src/db.js');

const timings = [];
const failures = [];
const fmt = (ms) => `${(ms / 1000).toFixed(2)} s`;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
async function timed(label, fn) {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - started;
    timings.push({ label, ms });
    console.log(`  ${fmt(ms).padStart(9)}  ${label}`);
  }
}

console.log(`Target: ${target}\n`);

// 1. The boot path. On a large table it must build nothing and finish quickly.
console.log('1. Boot schema pass (getDb)');
const client = await timed('ensureSchema + readiness checks', () => db.getDb());
const documents = Number((await client.execute('SELECT COUNT(doc_id) AS n FROM documents')).rows[0].n);
const names = async () => (await client.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'documents' ORDER BY name"))
  .rows.map((row) => String(row.name));
const afterBoot = await names();
console.log(`  documents: ${documents}; indexes after boot: ${afterBoot.join(', ')}`);
if (documents >= db.documentsInlineMaxRows()) {
  check(!afterBoot.some((name) => name.startsWith('idx_documents_cover')),
    'the boot pass built no covering index on a large table');
}

// 2. The migration, as the scheduler runs it: repeated until complete.
console.log('\n2. Migration');
const scale = Number(args['retry-scale'] ?? 1);
const steps = [];
let result = null;
const maxRounds = Number(args['max-rounds'] ?? 4);
for (let round = 1; round <= maxRounds; round += 1) {
  console.log(`  round ${round}`);
  const roundStarted = Date.now();
  result = await db.runDocumentsIndexMigration({
    client,
    onStep: (step) => { steps.push(step); console.log(`  ${fmt(step.ms).padStart(9)}  ${step.step} ${step.index || ''}${step.chunks ? ` (${step.chunks} chunks)` : ''}`); },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms * scale)),
  });
  timings.push({ label: `migration round ${round}`, ms: Date.now() - roundStarted });
  console.log(`  round ${round}: ${fmt(Date.now() - roundStarted)}; indexes ${JSON.stringify(result.indexes)}; legacy dropped ${result.legacyDropped}; affiliations ${result.affiliations}`);
  if (result.complete) break;
  await new Promise((resolve) => setTimeout(resolve, Number(args['round-pause-ms'] ?? 5000)));
}
check(Boolean(result?.complete), 'the migration completed');

// 3. Verification.
console.log('\n3. Verification');
const present = await names();
const wanted = db.DOCUMENT_SERVING_INDEXES.map((index) => index.name);
check(wanted.every((name) => present.includes(name)), 'all four covering indexes exist', present.join(', '));
check(!present.some((name) => ['idx_documents_degree', 'idx_documents_degree_year', 'idx_documents_program', 'idx_documents_year'].includes(name)),
  'the legacy indexes are gone');
const stats = (await client.execute("SELECT idx, stat FROM sqlite_stat1 WHERE tbl = 'documents' ORDER BY idx")).rows;
for (const name of wanted) {
  const row = stats.find((stat) => stat.idx === name);
  check(Boolean(row), `sqlite_stat1 row for ${name}`, row ? String(row.stat) : 'missing');
}

console.log('\n  Query plans (EXPLAIN QUERY PLAN of the statements the real readers run)');
await db.initDocumentTermsReadiness();
const topValue = async (column) => (await client.execute(
  `SELECT ${column} AS v FROM documents WHERE ${column} IS NOT NULL GROUP BY ${column} ORDER BY COUNT(*) DESC LIMIT 1`,
)).rows[0]?.v;
const shapes = [
  ['none', {}],
  ['degree', { degree: await topValue('degree') }],
  ['program', { program: await topValue('program') }],
  ['affiliation', { affiliation: 'UBC' }],
];
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
// SQLite reads sqlite_stat1 when a connection loads the schema, so plans are checked on
// a connection opened after the build, as every other connection is. (The long-lived
// connection that ran the build keeps the statistics it loaded at open until restart.)
const planClient = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
const originalExecute = client.execute.bind(client);
let planProblems = 0;
for (const [shapeName, filters] of shapes) {
  for (const [readerName, read] of Object.entries(readers)) {
    const seen = [];
    client.execute = (stmt) => {
      if (typeof stmt !== 'string' && /^\s*(SELECT|WITH)\b/i.test(stmt.sql)) seen.push(stmt);
      return originalExecute(stmt);
    };
    const started = Date.now();
    try { await read(filters); } finally { client.execute = originalExecute; }
    const ms = Date.now() - started;
    for (const stmt of seen.filter((s) => /\bdocuments d?\b/.test(s.sql))) {
      const plan = (await planClient.execute({ sql: `EXPLAIN QUERY PLAN ${stmt.sql}`, args: stmt.args })).rows.map((row) => String(row.detail));
      let accesses = plan.filter((detail) => /^(SCAN|SEARCH) d\b/.test(detail));
      const exempt = /json_extract\(d\.metadata_json, '\$\.charCount'\)/.test(stmt.sql);
      let bad = exempt ? [] : accesses.filter((detail) => !/COVERING INDEX/.test(detail));
      if (/FROM page p\b/.test(stmt.sql)) bad = bad.filter((detail) => !/^SEARCH d USING INDEX \S+ \(doc_id=\?\)$/.test(detail));
      if (bad.length) planProblems += 1;
      console.log(`  ${bad.length ? 'FAIL' : 'ok  '} ${shapeName.padEnd(11)} ${readerName.padEnd(19)} ${String(ms).padStart(6)} ms  ${accesses.join(' | ') || '(no documents access)'}`);
    }
  }
}
planClient.close();
check(planProblems === 0, 'every serving statement reaches documents through a covering index (analytics charCount and the page row-fetch excepted)');

if (!args['skip-recount']) {
  console.log('\n  Projection against a fresh recount (reads every metadata_json)');
  const recount = await timed('recount', async () => (await client.execute(`
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
      (SELECT COUNT(*) FROM document_affiliations) AS projected`)).rows[0]);
  check(Number(recount.missing) === 0 && Number(recount.extra) === 0, 'document_affiliations equals the recount',
    `${recount.projected} rows, ${recount.missing} missing, ${recount.extra} extra`);
}
const readiness = await db.initAffiliationsReadiness(client);
check(readiness === true, 'affiliation readiness flag set');

console.log('\nTimings');
for (const { label, ms } of timings) console.log(`  ${fmt(ms).padStart(9)}  ${label}`);
console.log(failures.length ? `\n${failures.length} check(s) FAILED:\n  - ${failures.join('\n  - ')}` : '\nAll checks passed.');
logger.info('Rehearsal finished', { target, failures: failures.length });
await db.closeDb();
process.exit(failures.length ? 1 : 0);
