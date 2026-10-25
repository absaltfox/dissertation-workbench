import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// #59: the visualizations payload is built from the slim SQL projection and
// computes only the slice's aggregates.

let tempDir;
let db;
let routes;
let metrics;

const SYNC_KEY = 'viz-payload-key';
const loadSyncModule = async () => ({ getSyncKeyForOptions: () => SYNC_KEY });
const N = 20;
const METHODS = ['case study', 'interview', 'survey'];
const PEOPLE = [['smith-j', 'J. Smith'], ['lee-k', 'K. Lee'], ['wu-q', 'Q. Wu'], ['ng-r', 'R. Ng']];
const pad = (i) => String(i).padStart(2, '0');

const fixtures = Array.from({ length: N }, (_, i) => {
  const n = i + 1;
  return {
    id: `1.00000${pad(n)}`,
    title: `Title ${pad(n)}`,
    author: `Author ${pad(n)}`,
    year: 2010 + (n % 4),
    degree: n % 2 ? 'MA' : 'PhD',
    program: 'Education',
    topicId: n % 3,
    supervisors: [PEOPLE[n % 4][1], PEOPLE[(n + 1) % 4][1]],
    conceptTerms: [`concept-${n % 5}`, `concept-${n % 7}`],
    methodologies: [METHODS[n % 3], ...(n % 4 === 0 ? [METHODS[(n + 1) % 3]] : [])],
  };
});

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-viz-payload-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;

  db = await import('../src/db.js');
  await db.ensureStorage();
  for (const f of fixtures) {
    await db.saveDocumentMetadata({
      id: f.id, title: f.title, author: f.author, authors: [f.author], supervisors: [],
      affiliation: ['UBC'], year: f.year, degree: f.degree, program: f.program,
      abstract: 'Abstract', subjects: ['education'], themes: [],
      methodologies: f.methodologies, conceptTerms: f.conceptTerms,
    }, { syncKey: SYNC_KEY });
  }
  // Restricted doc carrying terms in its input; must contribute nothing.
  await db.saveDocumentMetadata({
    id: '1.0000099', title: 'Secret', author: 'Hidden', authors: ['Hidden'], supervisors: [],
    affiliation: ['UBC'], year: 2012, degree: 'MA', program: 'Education', abstract: 'x',
    subjects: [], themes: [], methodologies: ['secret-method'], conceptTerms: ['secret-term'],
    accessStatus: 'embargoed',
  }, { syncKey: SYNC_KEY });

  const client = await db.getDb();
  const now = new Date().toISOString();
  const stmts = [];
  for (let t = 0; t < 3; t++) {
    stmts.push({
      sql: `INSERT INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at) VALUES (?, ?, '[]', 0, 'test', ?)`,
      args: [t, `${t}_a_b`, now],
    });
  }
  for (const f of fixtures) {
    stmts.push({ sql: 'INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, ?, 0.9)', args: [f.id, f.topicId] });
    stmts.push({ sql: 'INSERT INTO document_topic_coords (doc_id, umap_x, umap_y) VALUES (?, 1, 2)', args: [f.id] });
    for (const name of f.supervisors) {
      const key = PEOPLE.find((p) => p[1] === name)[0];
      stmts.push({
        sql: `INSERT INTO document_people (doc_id, person_key, name, role, source, updated_at) VALUES (?, ?, ?, 'Supervisor', 'pdf', ?)`,
        args: [f.id, key, name, now],
      });
    }
    for (const c of [1, 2 + (Number(f.id.slice(-2)) % 3)]) {
      stmts.push({
        sql: `INSERT OR IGNORE INTO citations (id, citation_hash, citation_text, created_at) VALUES (?, ?, ?, ?)`,
        args: [c, `h${c}`, `Citation ${c}`, now],
      });
      stmts.push({ sql: 'INSERT OR IGNORE INTO document_citations (doc_id, citation_id, updated_at) VALUES (?, ?, ?)', args: [f.id, c, now] });
    }
  }
  stmts.push({ sql: 'INSERT INTO document_topics (doc_id, topic_id, probability) VALUES (?, 0, 0.9)', args: ['1.0000099'] });
  await client.batch(stmts, 'write');

  routes = await import('../src/routes/metricsRoutes.js');
  metrics = await import('../src/metrics.js');
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

const total = (byYear) => byYear.reduce((n, t) => n + t.data.reduce((m, p) => m + p.count, 0), 0);

test('payload is built from the visualization projection', async () => {
  const payload = await routes.buildWorkbenchVisualizationsPayload({ subjectLimit: 25 }, {}, loadSyncModule);
  assert.equal(payload.source.aggregateSource, 'visualization-projection');
  assert.equal(payload.source.documentsAvailable, N);
  assert.equal(payload.source.documentsReturned, N);
  assert.equal(payload.source.documentsTruncated, false);
  assert.equal(payload.documents.length, N);
});

test('aggregates match the legacy builder on the same documents', async () => {
  const payload = await routes.buildWorkbenchVisualizationsPayload({ subjectLimit: 25 }, {}, loadSyncModule);
  // Projection order: year DESC, title ASC.
  const ordered = [...fixtures].sort((a, b) => b.year - a.year || a.title.localeCompare(b.title));
  const legacy = await metrics.buildMetricsPayloadFromRecords(
    ordered.map((f) => ({ ...f, abstract: 'Abstract', subjects: ['education'], themes: ['t'], accessStatus: 'available' })),
    {}, 25,
  );
  assert.deepEqual(payload.supervisorNetwork, legacy.supervisorNetwork);
  assert.deepEqual(payload.methodologyTopicMatrix, legacy.methodologyTopicMatrix);
  assert.deepEqual(payload.topicData.topics, legacy.topicData.topics);
  assert.ok(payload.supervisorNetwork.nodes.length > 0);
  assert.ok(payload.methodologyTopicMatrix.methodologies.length > 0);
  assert.ok(payload.citationCooccurrence.edges.length > 0);
});

test('filters narrow documents and every aggregate', async () => {
  const filters = { degree: 'MA' };
  const payload = await routes.buildWorkbenchVisualizationsPayload({ subjectLimit: 25 }, filters, loadSyncModule);
  const maIds = new Set(fixtures.filter((f) => f.degree === 'MA').map((f) => f.id));
  assert.equal(payload.documents.length, maIds.size);
  for (const d of payload.documents) assert.ok(maIds.has(d.id), `${d.id} is MA`);

  const expectedMeth = new Map();
  const expectedPeople = new Map();
  for (const f of fixtures.filter((x) => x.degree === 'MA')) {
    for (const m of f.methodologies) expectedMeth.set(m, (expectedMeth.get(m) || 0) + 1);
    for (const p of f.supervisors) expectedPeople.set(p, (expectedPeople.get(p) || 0) + 1);
  }
  const mtm = payload.methodologyTopicMatrix;
  const matrixTotal = mtm.matrix.flat().reduce((a, b) => a + b, 0);
  const expectedTotal = [...expectedMeth.values()].reduce((a, b) => a + b, 0);
  assert.equal(matrixTotal, expectedTotal);
  for (const node of payload.supervisorNetwork.nodes) assert.equal(node.docCount, expectedPeople.get(node.id));
  assert.equal(payload.supervisorNetwork.nodes.length, expectedPeople.size);
  assert.equal(total(payload.topicData.byYear), maIds.size);
});

test('restricted documents contribute no terms', async () => {
  const payload = await routes.buildWorkbenchVisualizationsPayload({ subjectLimit: 25 }, {}, loadSyncModule);
  const secret = payload.documents.find((d) => d.id === '1.0000099');
  if (secret) {
    assert.deepEqual(secret.conceptTerms, []);
    assert.deepEqual(secret.methodologies, []);
  }
  assert.ok(!payload.methodologyTopicMatrix.methodologies.includes('secret-method'));
  for (const d of payload.documents) assert.ok(!d.conceptTerms.includes('secret-term'));
});

test('documentLimit slices documents but reports the full total', async () => {
  const payload = await routes.buildWorkbenchVisualizationsPayload({ subjectLimit: 25 }, {}, loadSyncModule, { documentLimit: 5 });
  assert.equal(payload.documents.length, 5);
  assert.equal(payload.source.documentsAvailable, N);
  assert.equal(payload.source.documentsReturned, 5);
  assert.equal(payload.source.documentsTruncated, true);
  assert.equal(total(payload.topicData.byYear), N);
});
