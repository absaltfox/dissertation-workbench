import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

let tempDir;
let app;
let closeDb;
let ensureStorage;
let saveDocumentMetadata;
let saveFileMetric;
let saveCitations;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-workbench-routes-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.NODE_ENV = 'test';
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');

  ({ app } = await import('../src/server.js'));
  ({
    closeDb,
    ensureStorage,
    saveDocumentMetadata,
    saveFileMetric,
    saveCitations,
  } = await import('../src/db.js'));

  await ensureStorage();
  await seedWorkbenchDocs();
});

test.after(async () => {
  await closeDb?.();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

async function seedWorkbenchDocs() {
  const docs = [
    {
      id: 'wb-doc-1',
      title: 'Fast Loading One',
      author: 'A. Author',
      year: 2020,
      date: '2020',
      degree: 'Doctor of Education - EdD',
      program: 'Educational Studies',
      affiliation: ['UBC'],
      supervisors: ['Jane Supervisor'],
      abstract: 'A detailed abstract that should not be present in bootstrap responses.',
      subjects: ['Performance'],
      conceptTerms: ['page load performance', 'staged loading'],
      methodologies: ['Case Study'],
      themes: ['performance'],
    },
    {
      id: 'wb-doc-2',
      title: 'Fast Loading Two',
      author: 'B. Author',
      year: 2021,
      date: '2021',
      degree: 'Doctor of Philosophy - PhD',
      program: 'Curriculum Studies',
      affiliation: ['UBC'],
      supervisors: ['Jane Supervisor'],
      abstract: 'A second detailed abstract.',
      subjects: ['Caching'],
      conceptTerms: ['cache warming', 'staged loading'],
      methodologies: ['Interview'],
      themes: ['performance'],
    },
  ];

  for (const doc of docs) {
    await saveDocumentMetadata(doc, { syncKey: null });
    await saveFileMetric(doc.id, {
      status: 'cached',
      pdfPath: null,
      downloadUrl: '',
      fileBytes: 1000,
      wordCount: doc.id === 'wb-doc-1' ? 1200 : 1400,
      pageCount: doc.id === 'wb-doc-1' ? 40 : 45,
      wordSource: 'test',
      pageSource: 'test',
    });
  }

  await saveCitations('wb-doc-1', [
    { text: 'Fixture, A. (2020). A useful citation.' },
  ], (text) => String(text).toLowerCase());
}

test('workbench bootstrap returns lean document rows only', async () => {
  const res = await request(app)
    .get('/api/workbench/bootstrap?maxRecords=10')
    .expect('content-type', /application\/json/)
    .expect(200);

  assert.equal(res.body.documents.length, 2);
  assert.deepEqual(res.body.facets.degree.sort(), ['Doctor of Education - EdD', 'Doctor of Philosophy - PhD'].sort());
  const doc = res.body.documents.find((item) => item.id === 'wb-doc-1');
  assert.equal(doc.title, 'Fast Loading One');
  assert.equal(doc.wordCount, 1200);
  assert.equal(doc.citationCount, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(doc, 'abstract'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(doc, 'conceptTerms'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(doc, 'methodologies'), false);
});

test('workbench document detail returns heavy modal fields on demand', async () => {
  const res = await request(app)
    .get('/api/workbench/documents/wb-doc-1?maxRecords=10')
    .expect('content-type', /application\/json/)
    .expect(200);

  assert.equal(res.body.document.id, 'wb-doc-1');
  assert.match(res.body.document.abstract, /detailed abstract/);
  assert.deepEqual(res.body.document.conceptTerms, ['page load performance', 'staged loading']);
  assert.equal(res.body.document.citationCount, 1);
  assert.ok(Array.isArray(res.body.document.related));
});

test('workbench analytics and citation document slices are filter-aware', async () => {
  const analytics = await request(app)
    .get('/api/workbench/analytics?maxRecords=10&degree=Doctor%20of%20Education%20-%20EdD')
    .expect('content-type', /application\/json/)
    .expect(200);
  assert.equal(analytics.body.metrics.recordCount, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(analytics.body, 'documents'), false);

  const citations = await request(app)
    .get('/api/workbench/citations/documents?maxRecords=10&degree=Doctor%20of%20Education%20-%20EdD')
    .expect('content-type', /application\/json/)
    .expect(200);
  assert.deepEqual(citations.body.documents.map((doc) => doc.id), ['wb-doc-1']);
  assert.deepEqual(Object.keys(citations.body.documents[0]).sort(), ['author', 'citationCount', 'id', 'title', 'year'].sort());
});
