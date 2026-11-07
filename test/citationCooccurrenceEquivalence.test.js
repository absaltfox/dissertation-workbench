import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// getCitationCooccurrence rewrite. The old self-join drove 50 x |bound| probes
// and fetched citations rows before the top-50 filter. The new form reads the
// bound's links once and self-joins only the top-50 citations' links. The edges
// must be identical to the old SQL wherever the old SQL was well defined (no tie
// at the top-50 cut-off), and equal to a brute-force JavaScript reference
// everywhere. Two approved changes are pinned separately: a deterministic
// tie-break, and an empty doc-id filter yielding an empty network.

const ORIGINAL_SQL = (bound) => `
    WITH top_citations AS (
      SELECT citation_id, COUNT(DISTINCT doc_id) AS cnt
      FROM document_citations
      ${bound ? 'WHERE doc_id IN (SELECT value FROM json_each(?))' : ''}
      GROUP BY citation_id
      HAVING cnt >= 2
      ORDER BY cnt DESC
      LIMIT 50
    )
    SELECT
      c1.id AS id1, substr(c1.citation_text, 1, 80) AS text1, tc1.cnt AS freq1,
      c2.id AS id2, substr(c2.citation_text, 1, 80) AS text2, tc2.cnt AS freq2,
      COUNT(DISTINCT dc1.doc_id) AS shared
    FROM document_citations dc1
    JOIN document_citations dc2
      ON dc1.doc_id = dc2.doc_id AND dc1.citation_id < dc2.citation_id
    JOIN citations c1 ON c1.id = dc1.citation_id
    JOIN citations c2 ON c2.id = dc2.citation_id
    JOIN top_citations tc1 ON tc1.citation_id = c1.id
    JOIN top_citations tc2 ON tc2.citation_id = c2.id
    WHERE 1 = 1 ${bound ? 'AND dc1.doc_id IN (SELECT value FROM json_each(?))' : ''}
    GROUP BY dc1.citation_id, dc2.citation_id
    HAVING shared >= 2
    ORDER BY shared DESC
    LIMIT ?`;

let tempDir;
let db;
let client;

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

async function reset() {
  await client.execute('DELETE FROM document_citations');
  await client.execute('DELETE FROM citations');
}

async function insertCitations(n) {
  const now = new Date().toISOString();
  const ids = [];
  for (let i = 1; i <= n; i += 1) {
    const text = `Citation ${i} ${'long title '.repeat(i % 12)}`;
    const res = await client.execute({
      sql: 'INSERT INTO citations (citation_hash, citation_text, created_at) VALUES (?, ?, ?)',
      args: [`h-${i}`, text, now],
    });
    ids.push(Number(res.lastInsertRowid));
  }
  return ids;
}

async function insertLinks(links) {
  const now = new Date().toISOString();
  for (let i = 0; i < links.length; i += 400) {
    const chunk = links.slice(i, i + 400);
    await client.execute({
      sql: `INSERT INTO document_citations (doc_id, citation_id, updated_at) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`,
      args: chunk.flatMap(([d, c]) => [d, c, now]),
    });
  }
}

// Brute-force reference with the new deterministic rules.
async function reference(limit, bound) {
  const rows = (await client.execute('SELECT doc_id, citation_id FROM document_citations')).rows;
  const texts = new Map((await client.execute('SELECT id, citation_text FROM citations')).rows
    .map((r) => [Number(r.id), String(r.citation_text).slice(0, 80)]));
  const boundSet = bound ? new Set(bound) : null;
  const byDoc = new Map();
  const cnt = new Map();
  for (const r of rows) {
    if (boundSet && !boundSet.has(r.doc_id)) continue;
    const c = Number(r.citation_id);
    cnt.set(c, (cnt.get(c) || 0) + 1);
    if (!byDoc.has(r.doc_id)) byDoc.set(r.doc_id, []);
    byDoc.get(r.doc_id).push(c);
  }
  const top = [...cnt.entries()].filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 50);
  const topCnt = new Map(top);
  const shared = new Map();
  for (const cites of byDoc.values()) {
    const t = cites.filter((c) => topCnt.has(c)).sort((a, b) => a - b);
    for (let i = 0; i < t.length; i += 1) {
      for (let j = i + 1; j < t.length; j += 1) {
        const key = `${t[i]}|${t[j]}`;
        shared.set(key, (shared.get(key) || 0) + 1);
      }
    }
  }
  return [...shared.entries()].filter(([, n]) => n >= 2).map(([key, n]) => {
    const [a, b] = key.split('|').map(Number);
    return { id1: a, text1: texts.get(a), freq1: topCnt.get(a), id2: b, text2: texts.get(b), freq2: topCnt.get(b), shared: n };
  }).sort((x, y) => y.shared - x.shared || x.id1 - y.id1 || x.id2 - y.id2).slice(0, limit);
}

const plain = (rows) => rows.map((r) => ({ ...r }));
const byEdge = (rows) => plain(rows).sort((a, b) => a.id1 - b.id1 || a.id2 - b.id2);

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-cooc-equiv-'));
  Object.assign(process.env, {
    SKIP_LOCAL_ENV: '1', NODE_ENV: 'test', APP_DATA_DIR: tempDir,
    SQLITE_PATH: path.join(tempDir, 'metrics.sqlite'),
    PDF_CACHE_DIR: path.join(tempDir, 'pdf'), FULL_TEXT_CACHE_DIR: path.join(tempDir, 'ft'),
  });
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  await db.ensureStorage();
  client = await db.getDb();
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

// Citation k (1..70) is linked from exactly k+1 of 120 documents, so in-corpus
// counts are all distinct and the top-50 cut-off never ties. A few documents are
// heavy-tailed (many extra singleton citations).
async function seedDistinctCounts() {
  await reset();
  const ids = await insertCitations(70);
  const rand = prng(7);
  const docs = Array.from({ length: 120 }, (_, i) => `doc-${String(i).padStart(3, '0')}`);
  const links = [];
  ids.forEach((id, k) => {
    const picked = [...docs].sort(() => rand() - 0.5).slice(0, k + 2);
    for (const d of picked) links.push([d, id]);
  });
  const singles = await insertCitations(0);
  assert.equal(singles.length, 0);
  await insertLinks(links);
  // Heavy-tailed docs: 150 unique extra citations each linked once.
  const now = new Date().toISOString();
  for (let i = 0; i < 150; i += 1) {
    const res = await client.execute({
      sql: 'INSERT INTO citations (citation_hash, citation_text, created_at) VALUES (?, ?, ?)',
      args: [`single-${i}`, `Single ${i}`, now],
    });
    await insertLinks([[docs[i % 3], Number(res.lastInsertRowid)]]);
  }
  return docs;
}

test('co-occurrence equals the old SQL when the top-50 cut-off has no ties (unbounded and bounded)', async () => {
  const docs = await seedDistinctCounts();
  const bound = docs.filter((_, i) => i % 3 !== 0);
  for (const ids of [null, bound]) {
    const old = (await client.execute({
      sql: ORIGINAL_SQL(!!ids),
      args: ids ? [JSON.stringify(ids), JSON.stringify(ids), 100000] : [100000],
    })).rows;
    const fresh = await db.getCitationCooccurrence(100000, ids);
    assert.ok(old.length > 100, 'fixture must exercise a rich network');
    assert.deepEqual(byEdge(fresh), byEdge(old));
  }
});

test('co-occurrence equals the brute-force reference, including LIMIT order', async () => {
  const docs = await seedDistinctCounts();
  const bound = docs.slice(10, 90);
  for (const [ids, limit] of [[null, 100], [bound, 100], [bound, 17], [null, 1]]) {
    assert.deepEqual(plain(await db.getCitationCooccurrence(limit, ids)), await reference(limit, ids));
  }
});

test('top-50 tie-break is citation_id ascending and stable across runs', async () => {
  await reset();
  const ids = await insertCitations(80); // every citation shared by the same 2 docs: 80-way tie at cnt 2
  await insertLinks(ids.flatMap((id) => [['tie-a', id], ['tie-b', id]]));
  const first = await db.getCitationCooccurrence(100000, ['tie-a', 'tie-b']);
  const second = await db.getCitationCooccurrence(100000, ['tie-a', 'tie-b']);
  assert.deepEqual(plain(first), plain(second));
  const nodeIds = new Set(first.flatMap((r) => [r.id1, r.id2]));
  assert.deepEqual([...nodeIds].sort((a, b) => a - b), ids.slice(0, 50));
  assert.deepEqual(plain(first), await reference(100000, ['tie-a', 'tie-b']));
});

test('empty docIds returns an empty network without touching the corpus', async () => {
  const original = client.execute.bind(client);
  let calls = 0;
  client.execute = (...args) => { calls += 1; return original(...args); };
  try {
    assert.deepEqual(await db.getCitationCooccurrence(100, []), []);
  } finally {
    client.execute = original;
  }
  assert.equal(calls, 0);
  const metrics = await import('../src/metrics.js');
  assert.deepEqual(await metrics.buildCitationCooccurrenceNetwork([]), { nodes: [], edges: [] });
});

test('null docIds still means the whole corpus', async () => {
  await seedDistinctCounts();
  assert.ok((await db.getCitationCooccurrence(100, null)).length > 0);
});
