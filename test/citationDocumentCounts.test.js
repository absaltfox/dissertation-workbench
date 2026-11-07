import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Per-document citation counts on the Citations document list, the person page
// and the topic document page. The old statements LEFT JOINed a derived
// "GROUP BY doc_id" over every link in the corpus (about 295k rows on prod) just
// to label a page of at most 50 documents. Results must not change.

const SYNC_KEY = 'citation-doc-counts';
let tempDir;
let db;
let client;

const plain = (rows) => rows.map((r) => ({ ...r }));

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-cite-doc-counts-'));
  Object.assign(process.env, {
    SKIP_LOCAL_ENV: '1', NODE_ENV: 'test', APP_DATA_DIR: tempDir,
    SQLITE_PATH: path.join(tempDir, 'metrics.sqlite'),
    PDF_CACHE_DIR: path.join(tempDir, 'pdf'), FULL_TEXT_CACHE_DIR: path.join(tempDir, 'ft'),
  });
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  await db.ensureStorage();
  client = await db.getDb();

  const docs = Array.from({ length: 40 }, (_, i) => ({
    doc: {
      id: `cdc-${String(i).padStart(3, '0')}`,
      title: `Counted dissertation ${i % 7} ${i}`,
      author: `Author ${i}`,
      year: 2000 + (i % 10),
      degree: i % 3 === 0 ? 'PhD' : 'EdD',
      program: 'Education',
      supervisors: ['Shared Supervisor', `Own Supervisor ${i}`],
      abstract: `Abstract ${i}`,
    },
    syncKey: SYNC_KEY,
  }));
  await db.saveDocumentMetadataBatch(docs);
  const now = new Date().toISOString();
  const ids = [];
  for (let c = 0; c < 30; c += 1) {
    const res = await client.execute({
      sql: 'INSERT INTO citations (citation_hash, citation_text, created_at) VALUES (?, ?, ?)',
      args: [`cdc-h-${c}`, `Citation ${c}`, now],
    });
    ids.push(Number(res.lastInsertRowid));
  }
  // Every third document has no citations; counts vary between 1 and 29.
  for (let i = 0; i < 40; i += 1) {
    if (i % 3 === 1) continue;
    for (let c = 0; c < (i % 29) + 1; c += 1) {
      await client.execute({
        sql: 'INSERT INTO document_citations (doc_id, citation_id, updated_at) VALUES (?, ?, ?)',
        args: [`cdc-${String(i).padStart(3, '0')}`, ids[c], now],
      });
    }
  }
  // An embargoed document must stay outside the analytical counts.
  await client.execute("UPDATE documents SET access_status = 'embargoed' WHERE doc_id = 'cdc-005'");
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function capturePlans(fn) {
  const seen = [];
  const original = client.execute.bind(client);
  client.execute = (stmt, ...rest) => { if (typeof stmt === 'object') seen.push(stmt); return original(stmt, ...rest); };
  try {
    await fn();
  } finally {
    client.execute = original;
  }
  const details = [];
  for (const stmt of seen.filter((s) => /document_citations/.test(s.sql) && /^\s*(SELECT|WITH)/i.test(s.sql))) {
    const plan = (await client.execute({ sql: `EXPLAIN QUERY PLAN ${stmt.sql}`, args: stmt.args })).rows;
    details.push(...plan.map((r) => String(r.detail)));
  }
  return details;
}

const fullScan = (details) => details.filter((d) => /MATERIALIZE|^SCAN (dc|x|document_citations)\b/.test(d));

test('with_citations equals the count of filtered docs having at least one link', async () => {
  const cases = [
    { filters: {} },
    { filters: { degree: 'PhD' } },
    { filters: { degree: 'EdD' }, q: 'dissertation 3' },
  ];
  for (const { filters, q = '' } of cases) {
    const page = await db.queryCitationDocumentPage({ syncKey: SYNC_KEY, filters, q, limit: 1000 });
    const direct = page.documents;
    assert.equal(page.total, direct.length);
    assert.equal(page.withCitations, direct.filter((d) => d.citationCount > 0).length);
    for (const d of direct) {
      const n = Number((await client.execute({ sql: 'SELECT COUNT(*) n FROM document_citations WHERE doc_id = ?', args: [d.id] })).rows[0].n);
      assert.equal(d.citationCount, n, d.id);
    }
  }
  const unfiltered = await db.queryCitationDocumentPage({ syncKey: SYNC_KEY, limit: 1000 });
  assert.ok(!unfiltered.documents.some((d) => d.id === 'cdc-005'), 'embargoed document is excluded');
  assert.ok(unfiltered.withCitations > 0 && unfiltered.withCitations < unfiltered.total);
});

test('the citations document list does not aggregate every link for count and non-count sorts', async () => {
  const details = await capturePlans(() => db.queryCitationDocumentPage({
    syncKey: SYNC_KEY, sortKey: 'title', sortDir: 'asc', limit: 5,
  }));
  assert.ok(details.length > 0);
  assert.deepEqual(fullScan(details), [], `statement scans all links: ${details.join(' | ')}`);
  // Sorting by title must label the same counts as sorting by citationCount.
  const byTitle = await db.queryCitationDocumentPage({ syncKey: SYNC_KEY, sortKey: 'title', limit: 1000 });
  const byCount = await db.queryCitationDocumentPage({ syncKey: SYNC_KEY, sortKey: 'citationCount', limit: 1000 });
  const counts = (page) => new Map(page.documents.map((d) => [d.id, d.citationCount]));
  assert.deepEqual(counts(byTitle), counts(byCount));
  assert.equal(byTitle.withCitations, byCount.withCitations);
  assert.deepEqual(byCount.documents.map((d) => d.citationCount),
    [...byCount.documents.map((d) => d.citationCount)].sort((a, b) => b - a));
});

test('person detail citationCount equals a direct count and avoids the all-links aggregate', async () => {
  let page;
  const details = await capturePlans(async () => {
    page = await db.queryPersonDetailPage({ personKey: 'shared supervisor', syncKey: SYNC_KEY, limit: 50 });
  });
  assert.ok(page.documents.length > 0);
  for (const d of page.documents) {
    const n = Number((await client.execute({ sql: 'SELECT COUNT(*) n FROM document_citations WHERE doc_id = ?', args: [d.id] })).rows[0].n);
    assert.equal(d.citationCount, n, d.id);
  }
  assert.deepEqual(fullScan(details), [], `person page aggregates all links: ${details.join(' | ')}`);
});

test('topic document page citationCount equals a direct count and avoids the all-links aggregate', async () => {
  const now = new Date().toISOString();
  await client.execute({ sql: "INSERT INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at) VALUES (1, 'T', '[]', 40, 'test', ?)", args: [now] });
  for (let i = 0; i < 40; i += 1) {
    await client.execute({ sql: 'INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, 1, 0.9)', args: [`cdc-${String(i).padStart(3, '0')}`] });
  }
  let page;
  const details = await capturePlans(async () => {
    page = await db.queryTopicDocumentPage({ syncKey: SYNC_KEY, limit: 100 });
  });
  assert.ok(page.documents.length > 0);
  for (const d of page.documents) {
    const n = Number((await client.execute({ sql: 'SELECT COUNT(*) n FROM document_citations WHERE doc_id = ?', args: [d.id] })).rows[0].n);
    assert.equal(d.citationCount, n, d.id);
  }
  assert.deepEqual(fullScan(details), [], `topic page aggregates all links: ${details.join(' | ')}`);
});

test('countDocumentCitations equals the number of linked citations without reading their text', async () => {
  const hash = (t) => `cnt-${t.toLowerCase().trim()}`;
  // Two near-identical items merge into one citation; the link count is distinct citations.
  await db.reextractDocumentCitations('cdc-count', [
    'Smith, J. (2001). Alpha theory of things. City: Press.',
    'Smith, J. (2001). Alpha theory of things. City: Press',
    'Jones, K. (1999). Beta. City: Press.',
  ], hash);
  const loaded = await db.loadDocumentCitations('cdc-count');
  assert.equal(await db.countDocumentCitations('cdc-count'), loaded.length);
  assert.equal(await db.countDocumentCitations('cdc-missing'), 0);

  const seen = [];
  const original = client.execute.bind(client);
  client.execute = (stmt, ...rest) => { seen.push(typeof stmt === 'string' ? stmt : stmt.sql); return original(stmt, ...rest); };
  try {
    await db.countDocumentCitations('cdc-count');
  } finally {
    client.execute = original;
  }
  assert.ok(!seen.some((sql) => /citation_text/.test(sql)));
});

test('applyCitationCountsToDocuments labels any number of documents in one statement', async () => {
  const docs = Array.from({ length: 2500 }, (_, i) => ({ id: i < 40 ? `cdc-${String(i).padStart(3, '0')}` : `nodoc-${i}` }));
  docs.push({ id: docs[3].id }); // duplicate ids stay labelled
  const statements = [];
  const original = client.execute.bind(client);
  client.execute = (stmt, ...rest) => { statements.push(stmt); return original(stmt, ...rest); };
  try {
    await db.applyCitationCountsToDocuments(docs);
  } finally {
    client.execute = original;
  }
  assert.equal(statements.length, 1, 'one round trip regardless of the id count');
  for (const d of docs.slice(0, 40)) {
    const n = Number((await client.execute({ sql: 'SELECT COUNT(*) n FROM document_citations WHERE doc_id = ?', args: [d.id] })).rows[0].n);
    assert.equal(d.citationCount, n, d.id);
  }
  assert.equal(docs[100].citationCount, 0);
  assert.equal(docs.at(-1).citationCount, docs[3].citationCount);
  const plan = (await client.execute({ sql: `EXPLAIN QUERY PLAN ${statements[0].sql}`, args: statements[0].args })).rows.map((r) => String(r.detail));
  assert.ok(!plan.some((d) => /^SCAN document_citations/.test(d)), plan.join(' | '));
});
