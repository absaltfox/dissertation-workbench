import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// #59: slim SQL projection feeding the visualizations payload.

let tempDir;
let db;
let client;

const SYNC_KEY = 'viz-docs-key';
const KEYS = ['author', 'conceptTerms', 'id', 'methodologies', 'supervisors', 'title',
  'topicId', 'topicProbability', 'umapX', 'umapY', 'year'];

const sorted = (a) => [...a].sort();

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-viz-docs-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;

  db = await import('../src/db.js');
  await db.ensureStorage();
  const docs = [
    ['1.0000001', 2020, 'EdD', 'Education'],
    ['1.0000002', 2019, 'PhD', 'Physics'],
    ['1.0000003', 2018, 'EdD', 'Education'],
    ['1.0000004', 2017, 'EdD', 'Education'], // no topic
    ['1.0000005', 2016, 'EdD', 'Education'], // embargoed
  ];
  for (const [id, year, degree, program] of docs) {
    await db.saveDocumentMetadata({
      id, title: `Title ${id}`, author: `Author ${id}`, authors: [`Author ${id}`],
      supervisors: [], affiliation: ['UBC'], year, degree, program,
      abstract: 'Abstract', subjects: [], themes: [], methodologies: [], conceptTerms: [],
    }, { syncKey: SYNC_KEY });
  }
  client = await db.getDb();
  await client.execute({ sql: `UPDATE documents SET access_status = 'embargoed' WHERE doc_id = ?`, args: ['1.0000005'] });
  const now = new Date().toISOString();
  const stmts = [
    ['INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, ?, ?)', ['1.0000001', 3, 0.4]],
    ['INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, ?, ?)', ['1.0000001', 7, 0.9]],
    ['INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, ?, ?)', ['1.0000002', 1, 0.5]],
    ['INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, ?, ?)', ['1.0000003', 2, null]],
    ['INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, ?, ?)', ['1.0000005', 2, 0.8]],
    ['INSERT INTO document_topic_coords (doc_id, umap_x, umap_y) VALUES (?, ?, ?)', ['1.0000001', 1.5, -2.5]],
    ['INSERT INTO document_topic_coords (doc_id, umap_x, umap_y) VALUES (?, ?, ?)', ['1.0000002', 0.1, 0.2]],
    ['INSERT INTO document_terms (doc_id, kind, term) VALUES (?, ?, ?)', ['1.0000001', 'concept', 'learning']],
    ['INSERT INTO document_terms (doc_id, kind, term) VALUES (?, ?, ?)', ['1.0000001', 'concept', 'identity']],
    ['INSERT INTO document_terms (doc_id, kind, term) VALUES (?, ?, ?)', ['1.0000001', 'methodology', 'case study']],
  ];
  for (const [doc, key, name, role, source] of [
    ['1.0000001', 'smith-j', 'J. Smith', 'Supervisor', 'metadata'],
    ['1.0000001', 'smith-j', 'J. Smith', 'Supervisor', 'pdf'],
    ['1.0000001', 'lee-k', 'K. Lee', 'Committee Member', 'pdf'],
    ['1.0000001', 'wu-q', 'Q. Wu', 'Chair', 'pdf'],
  ]) {
    stmts.push([`INSERT INTO document_people (doc_id, person_key, name, role, source, updated_at) VALUES (?, ?, ?, ?, ?, '${now}')`,
      [doc, key, name, role, source]]);
  }
  await client.batch(stmts.map(([sql, args]) => ({ sql, args })), 'write');
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('returns one slim row per topic-assigned eligible document', async () => {
  const { total, documents } = await db.queryVisualizationDocuments({ syncKey: SYNC_KEY });
  assert.equal(total, 3);
  assert.equal(documents.length, 3);
  assert.deepEqual(documents.map((d) => d.id), ['1.0000001', '1.0000002', '1.0000003']);
  for (const d of documents) assert.deepEqual(Object.keys(d).sort(), KEYS);
  assert.equal(documents[0].title, 'Title 1.0000001');
  assert.equal(documents[0].author, 'Author 1.0000001');
  assert.equal(documents[0].year, 2020);
});

test('picks the highest-probability topic when a document has several', async () => {
  const { documents } = await db.queryVisualizationDocuments({ syncKey: SYNC_KEY });
  assert.equal(documents[0].topicId, 7);
  assert.equal(documents[0].topicProbability, 0.9);
  assert.equal(documents[2].topicProbability, null);
});

test('reads concept and methodology terms from document_terms', async () => {
  const { documents } = await db.queryVisualizationDocuments({ syncKey: SYNC_KEY });
  assert.deepEqual(sorted(documents[0].conceptTerms), ['identity', 'learning']);
  assert.deepEqual(documents[0].methodologies, ['case study']);
  assert.deepEqual(documents[1].conceptTerms, []);
  assert.deepEqual(documents[1].methodologies, []);
});

test('network people are distinct by person_key across sources', async () => {
  const { documents } = await db.queryVisualizationDocuments({ syncKey: SYNC_KEY });
  assert.deepEqual(sorted(documents[0].supervisors), ['J. Smith', 'K. Lee']);
  assert.deepEqual(documents[1].supervisors, []);
});

test('applies degree/program/affiliation filters and access rules', async () => {
  const phd = await db.queryVisualizationDocuments({ syncKey: SYNC_KEY, filters: { degree: 'PhD' } });
  assert.deepEqual(phd.documents.map((d) => d.id), ['1.0000002']);
  const prog = await db.queryVisualizationDocuments({ syncKey: SYNC_KEY, filters: { program: 'Education', affiliation: 'UBC' } });
  assert.deepEqual(prog.documents.map((d) => d.id), ['1.0000001', '1.0000003']);
  const all = await db.queryVisualizationDocuments({ syncKey: SYNC_KEY });
  assert.ok(!all.documents.some((d) => d.id === '1.0000005'), 'embargoed doc excluded');
});

test('missing coords yield null umapX/umapY', async () => {
  const { documents } = await db.queryVisualizationDocuments({ syncKey: SYNC_KEY });
  assert.equal(documents[0].umapX, 1.5);
  assert.equal(documents[0].umapY, -2.5);
  assert.equal(documents[2].umapX, null);
  assert.equal(documents[2].umapY, null);
});
