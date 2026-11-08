import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FILTER_CASES, seedServingCorpus } from './fixtures/documentsServingCorpus.js';
import { referenceDocumentPage, referenceFilters, REFERENCE_PAGE_SORTS } from './fixtures/documentsServingReference.js';

// M-8: filtered `documents` reads. Every rewritten reader must return exactly the
// rows (and order) of the SQL it replaced; the reference SQL lives in
// fixtures/documentsServingReference.js. The readers are compared with the new
// objects (covering indexes, affiliation projection) both absent and present.

let db;
let client;
let tempDir;

// Records every statement the module-level client executes.
function captureStatements(target) {
  const seen = [];
  const original = target.execute.bind(target);
  target.execute = (stmt) => {
    seen.push(typeof stmt === 'string' ? stmt : stmt.sql);
    return original(stmt);
  };
  return { seen, restore: () => { target.execute = original; } };
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-docs-index-'));
  Object.assign(process.env, {
    SKIP_LOCAL_ENV: '1', NODE_ENV: 'test', APP_DATA_DIR: tempDir,
    SQLITE_PATH: path.join(tempDir, 'metrics.sqlite'),
    PDF_CACHE_DIR: path.join(tempDir, 'pdf'), FULL_TEXT_CACHE_DIR: path.join(tempDir, 'ft'),
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

const PAGE_FILTERS = [
  { name: 'none', filters: {}, q: '' },
  ...FILTER_CASES.filter((c) => ['degree MA', 'program', 'affiliation UBC', 'affiliation+degree'].includes(c.name)).map((c) => ({ ...c, q: '' })),
  { name: 'q', filters: {}, q: 'thesis 1' },
];

test('Documents page: ids-first rewrite returns the single-query rows, in order, for every sort', async () => {
  const limit = 30;
  for (const { name, filters, q } of PAGE_FILTERS) {
    for (const sortKey of ['', ...Object.keys(REFERENCE_PAGE_SORTS)]) {
      for (const sortDir of ['asc', 'desc']) {
        const total = (await referenceDocumentPage(client, { filters, q, sortKey, sortDir, limit, offset: 0 })).total;
        const last = Math.floor(Math.max(0, total - 1) / limit) * limit;
        for (const offset of new Set([0, 50, last])) {
          const label = `${name} sort=${sortKey || 'default'} ${sortDir} offset=${offset}`;
          const expected = await referenceDocumentPage(client, { filters, q, sortKey, sortDir, limit, offset });
          const actual = await db.queryCachedDocumentPage({ filters, q, sortKey, sortDir, limit, offset });
          assert.equal(actual.total, expected.total, `${label}: total`);
          assert.deepEqual(actual.documents.map((d) => d.id), expected.rows.map((r) => r.doc_id), `${label}: ids`);
        }
      }
    }
  }
});

test('Documents page: the sorter never carries metadata_json for the filtered rows', async () => {
  const capture = captureStatements(client);
  try {
    await db.queryCachedDocumentPage({ filters: { degree: 'Master of Arts - MA' }, sortKey: 'title', sortDir: 'asc', limit: 10, offset: 0 });
  } finally { capture.restore(); }
  const pageSql = capture.seen.find((sql) => /FROM page p/.test(sql));
  assert.ok(pageSql, `expected an ids-first page statement, saw: ${capture.seen.join(' | ')}`);
  const [idsPhase, rowsPhase] = pageSql.split(/\)\s*SELECT d\.doc_id, d\.metadata_json/);
  assert.ok(rowsPhase, 'phase two fetches metadata_json for the page rows');
  assert.doesNotMatch(idsPhase, /metadata_json/, 'phase one selects keys only');
});

test('Documents page: an unfiltered count uses COUNT(d.doc_id), a filtered count keeps COUNT(*)', async () => {
  const capture = captureStatements(client);
  try {
    await db.queryCachedDocumentPage({ limit: 5 });
    await db.queryCachedDocumentPage({ filters: { degree: 'Master of Arts - MA' }, limit: 5 });
  } finally { capture.restore(); }
  const counts = capture.seen.filter((sql) => /AS total FROM documents d/.test(sql));
  assert.equal(counts.length, 2);
  assert.match(counts[0], /COUNT\(d\.doc_id\) AS total/);
  assert.match(counts[1], /COUNT\(\*\) AS total/);
});

test('topic document page: ids-first rewrite returns the single-query rows, in order', async () => {
  for (const { name, filters } of FILTER_CASES.filter((c) => !c.name.startsWith('affiliation ') || c.name === 'affiliation UBC')) {
    const f = referenceFilters({ ...filters }, { analytical: true });
    for (const [limit, offset] of [[5000, 0], [20, 0], [20, 20], [20, 1000]]) {
      const count = await client.execute({
        sql: `SELECT COUNT(*) AS total FROM documents d JOIN (SELECT DISTINCT doc_id FROM document_topics) dt ON dt.doc_id = d.doc_id ${f.where}`,
        args: f.args,
      });
      const expected = await client.execute({
        sql: `SELECT d.doc_id FROM documents d JOIN (SELECT DISTINCT doc_id FROM document_topics) dt ON dt.doc_id = d.doc_id
              LEFT JOIN file_metrics fm ON fm.doc_id = d.doc_id ${f.where}
              ORDER BY COALESCE(d.year, 0) DESC, lower(COALESCE(d.title, '')) ASC, d.doc_id ASC LIMIT ? OFFSET ?`,
        args: [...f.args, limit, offset],
      });
      const actual = await db.queryTopicDocumentPage({ filters, limit, offset });
      assert.equal(actual.total, Number(count.rows[0].total), `${name}: total`);
      if (name === 'none') assert.ok(actual.total > 50, 'the fixture has topic-assigned documents');
      assert.deepEqual(actual.documents.map((d) => d.id), expected.rows.map((r) => r.doc_id), `${name} ${limit}/${offset}`);
    }
  }
});
