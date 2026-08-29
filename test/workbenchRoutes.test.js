import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

let tempDir;
let app;
let closeDb;
let ensureStorage;
let saveDocumentMetadata;
let saveFileMetric;
let saveCitations;
let saveCommitteeMembers;
let createMetricsRouter;
let sourceCacheKey;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-workbench-routes-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.NODE_ENV = 'test';
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');

  ({ createMetricsRouter, sourceCacheKey } = await import('../src/routes/metricsRoutes.js'));
  ({
    closeDb,
    ensureStorage,
    saveDocumentMetadata,
    saveFileMetric,
    saveCitations,
    saveCommitteeMembers,
  } = await import('../src/db.js'));

  await ensureStorage();
  await seedWorkbenchDocs();
  app = express();
  app.use('/api', createMetricsRouter({
    metricsCache: new Map(),
    metricsInflight: new Map(),
    loadSyncModule: async () => ({ getSyncKeyForOptions: () => null }),
  }));
});

test.after(async () => {
  await closeDb?.();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(predicate(), true);
}

async function seedWorkbenchDocs() {
  await fs.mkdir(path.join(tempDir, 'concepts'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'concepts', 'latest.json'), JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    source: { documents: 4 },
    stats: { concepts: 4, aliases: 0 },
    concepts: [
      { canonical: 'staged loading', variants: [], docFreq: 2, idf: 2 },
      { canonical: 'responsive document exploration', variants: [], docFreq: 1, idf: 2 },
      { canonical: 'analytics filtering', variants: [], docFreq: 1, idf: 2 },
      { canonical: 'word count sensitive', variants: [], docFreq: 1, idf: 2 },
    ],
    variantToCanonical: {},
  }, null, 2));

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
      doi: '10.14288/1.0000001',
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
    {
      id: 'wb-doc-3',
      title: 'Performance Loading Three',
      author: 'C. Author',
      year: 2019,
      date: '2019',
      degree: 'Doctor of Philosophy - PhD',
      program: 'Curriculum Studies',
      affiliation: ['UBC'],
      supervisors: ['Alex Supervisor'],
      abstract: 'Performance loading work with staged loading and responsive document exploration.',
      subjects: ['Performance'],
      conceptTerms: [],
      methodologies: [],
    },
    {
      id: 'wb-doc-4',
      title: 'MEd Loading Four',
      author: 'D. Author',
      year: 2018,
      date: '2018',
      degree: 'Master of Education - MEd',
      program: 'Educational Studies',
      affiliation: ['UBC'],
      supervisors: ['Morgan Supervisor'],
      abstract: 'A masters thesis about word-count-sensitive analytics filtering.',
      subjects: ['Analytics'],
      conceptTerms: [],
      methodologies: ['Survey'],
      themes: ['analytics'],
    },
  ];

  for (const doc of docs) {
    await saveDocumentMetadata(doc, { syncKey: null });
    await saveFileMetric(doc.id, {
      status: 'cached',
      pdfPath: null,
      downloadUrl: '',
      fileBytes: 1000,
      wordCount: doc.id === 'wb-doc-1' ? 1200 : (doc.id === 'wb-doc-2' ? 1400 : (doc.id === 'wb-doc-3' ? 900 : 2400)),
      pageCount: doc.id === 'wb-doc-1' ? 40 : (doc.id === 'wb-doc-2' ? 45 : (doc.id === 'wb-doc-3' ? 35 : 60)),
      wordSource: 'test',
      pageSource: 'test',
    });
  }

  await saveCitations('wb-doc-1', [
    { text: 'Fixture, A. (2020). A useful citation.' },
  ], (text) => String(text).toLowerCase());

  await saveCommitteeMembers('wb-doc-4', [
    { name: 'Alex Supervisor', role: 'University Examiner', affiliation: 'UBC' },
  ], 'test');
}

test('workbench bootstrap returns source metadata and facets without preloading rows', async () => {
  const res = await request(app)
    .get('/api/workbench/bootstrap?maxRecords=10')
    .expect('content-type', /application\/json/)
    .expect(200);

  assert.equal(res.body.documents.length, 0);
  assert.equal(res.body.summary.documents, 4);
  assert.deepEqual(
    res.body.facets.degree.sort(),
    ['Doctor of Education - EdD', 'Doctor of Philosophy - PhD', 'Master of Education - MEd'].sort()
  );
});

test('workbench document page returns projected rows on demand', async () => {
  const res = await request(app)
    .get('/api/workbench/documents?maxRecords=10&limit=1&offset=0')
    .expect('content-type', /application\/json/)
    .expect(200);

  assert.equal(res.body.documents.length, 1);
  assert.equal(res.body.source.total, 4);
  assert.equal(res.body.source.hasMore, true);
  const doc = res.body.documents[0];
  assert.equal(doc.title, 'Fast Loading Two');
  assert.equal(doc.wordCount, 1400);
  assert.equal(doc.citationCount, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(doc, 'abstract'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(doc, 'conceptTerms'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(doc, 'methodologies'), false);
});

test('expired workbench slices serve stale payloads while refreshing in background', async () => {
  const metricsCache = new Map();
  const metricsInflight = new Map();
  const staleApp = express();
  staleApp.use('/api', createMetricsRouter({
    metricsCache,
    metricsInflight,
    loadSyncModule: async () => ({ getSyncKeyForOptions: () => null }),
  }));
  const params = {
    maxRecords: 10,
    pageSize: 20,
    scanLimit: 1000,
    subjectLimit: 25,
    index: undefined,
    query: undefined,
    term: undefined,
    source: undefined,
    apiKey: undefined,
    downloadFiles: false,
    forceDownload: false,
    recomputeFromCache: false,
    isAdminRequest: false,
  };
  const key = `workbench:bootstrap:${sourceCacheKey(params)}`;
  metricsCache.set(key, {
    timestamp: 0,
    payload: {
      generatedAt: 'stale',
      source: {},
      summary: { documents: 999, supervisors: 0 },
      facets: { degree: [], program: [], affiliation: [] },
      documents: [],
    },
  });

  const res = await request(staleApp)
    .get('/api/workbench/bootstrap?maxRecords=10')
    .expect('content-type', /application\/json/)
    .expect(200);

  assert.equal(res.body.generatedAt, 'stale');
  assert.equal(res.body.summary.documents, 999);

  await waitFor(() => metricsCache.get(key)?.payload?.summary?.documents === 4);
  assert.equal(metricsCache.get(key).payload.generatedAt === 'stale', false);
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
  assert.equal(res.body.document.doi, '10.14288/1.0000001');
  assert.ok(Array.isArray(res.body.document.related));
  assert.ok(res.body.document.themes.length > 0);
  assert.ok(res.body.document.related.some((doc) => doc.id === 'wb-doc-3'));
});

test('workbench analytics and citation document slices are filter-aware', async () => {
  const analytics = await request(app)
    .get('/api/workbench/analytics?maxRecords=10&degree=Doctor%20of%20Education%20-%20EdD')
    .expect('content-type', /application\/json/)
    .expect(200);
  assert.equal(analytics.body.metrics.recordCount, 1);
  assert.equal(analytics.body.metrics.overallWordCount.mean, 1200);
  assert.deepEqual(analytics.body.documents.map((doc) => doc.id), ['wb-doc-1']);
  assert.ok(analytics.body.documents[0].themes.includes('performance'));
  assert.deepEqual(analytics.body.documents[0].conceptTerms, ['page load performance', 'staged loading']);

  const medAnalytics = await request(app)
    .get('/api/workbench/analytics?maxRecords=10&degree=Master%20of%20Education%20-%20MEd')
    .expect('content-type', /application\/json/)
    .expect(200);
  assert.equal(medAnalytics.body.metrics.recordCount, 1);
  assert.equal(medAnalytics.body.metrics.overallWordCount.mean, 2400);
  assert.deepEqual(medAnalytics.body.documents.map((doc) => doc.id), ['wb-doc-4']);
  assert.ok(medAnalytics.body.documents[0].conceptTerms.includes('analytics filtering'));
  assert.ok(medAnalytics.body.ngramCloud.some((entry) => entry.term === 'analytics filtering'));

  const phdAnalytics = await request(app)
    .get('/api/workbench/analytics?maxRecords=10&degree=Doctor%20of%20Philosophy%20-%20PhD')
    .expect('content-type', /application\/json/)
    .expect(200);
  const generatedPhdDoc = phdAnalytics.body.documents.find((doc) => doc.id === 'wb-doc-3');
  assert.ok(generatedPhdDoc.conceptTerms.includes('responsive document exploration'));
  assert.ok(phdAnalytics.body.ngramCloud.some((entry) => entry.term === 'responsive document exploration'));

  const citations = await request(app)
    .get('/api/workbench/citations/documents?maxRecords=10&degree=Doctor%20of%20Education%20-%20EdD&limit=1')
    .expect('content-type', /application\/json/)
    .expect(200);
  assert.deepEqual(citations.body.documents.map((doc) => doc.id), ['wb-doc-1']);
  assert.equal(citations.body.source.total, 1);
  assert.equal(citations.body.source.withCitations, 1);
  assert.equal(citations.body.source.hasMore, false);
  assert.deepEqual(Object.keys(citations.body.documents[0]).sort(), ['author', 'citationCount', 'id', 'title', 'year'].sort());
});

test('workbench people list is paged and person detail loads relationships on demand', async () => {
  const people = await request(app)
    .get('/api/workbench/people?maxRecords=10&limit=1&offset=0')
    .expect('content-type', /application\/json/)
    .expect(200);

  assert.equal(people.body.people.length, 1);
  assert.equal(people.body.source.total, 3);
  assert.equal(people.body.source.hasMore, true);
  assert.equal(people.body.people[0].name, 'Jane Supervisor');
  assert.equal(people.body.people[0].docCount, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(people.body.people[0], 'docs'), false);

  const detail = await request(app)
    .get('/api/workbench/people/jane%20supervisor?maxRecords=10')
    .expect('content-type', /application\/json/)
    .expect(200);

  assert.equal(detail.body.person.name, 'Jane Supervisor');
  assert.equal(detail.body.person.docCount, 2);
  assert.deepEqual(detail.body.person.docs.map((doc) => doc.id).sort(), ['wb-doc-1', 'wb-doc-2']);
  assert.ok(detail.body.person.topConcepts.some((concept) => concept.term === 'staged loading'));

  const roleDetail = await request(app)
    .get('/api/workbench/people/alex%20supervisor?maxRecords=10')
    .expect('content-type', /application\/json/)
    .expect(200);

  assert.equal(roleDetail.body.person.docCount, 2);
  assert.deepEqual(roleDetail.body.person.roles, ['Supervisor', 'University Examiner']);
  assert.deepEqual(
    roleDetail.body.person.roleGroups.map((group) => [group.role, group.docs.map((doc) => doc.id)]),
    [
      ['Supervisor', ['wb-doc-3']],
      ['University Examiner', ['wb-doc-4']],
    ]
  );
  assert.deepEqual(
    roleDetail.body.person.docs.map((doc) => [doc.id, doc.personRoles]).sort(),
    [
      ['wb-doc-3', ['Supervisor']],
      ['wb-doc-4', ['University Examiner']],
    ]
  );

  const roleFiltered = await request(app)
    .get('/api/workbench/people?maxRecords=10&q=alex&role=University%20Examiner')
    .expect('content-type', /application\/json/)
    .expect(200);
  assert.equal(roleFiltered.body.people.length, 1);
  assert.equal(roleFiltered.body.people[0].docCount, 2);
  assert.deepEqual(roleFiltered.body.people[0].roles.sort(), ['Supervisor', 'University Examiner']);

  const pagedDetail = await request(app)
    .get('/api/workbench/people/alex%20supervisor?maxRecords=10&limit=1&offset=0')
    .expect('content-type', /application\/json/)
    .expect(200);
  assert.equal(pagedDetail.body.source.total, 2);
  assert.equal(pagedDetail.body.source.hasMore, true);
  assert.equal(pagedDetail.body.person.docs.length, 1);
});
