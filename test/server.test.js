import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { app } from '../src/server.js';
import { createSession, destroySession, getSessionCsrfToken } from '../src/auth.js';
import {
  closeDb, createAdminJob, finishAdminJob, hashAdminJobToken, saveCitations,
  saveCommitteeMembers, saveDocumentMetadata, saveFileMetric
} from '../src/db.js';

test.after(async () => {
  await closeDb();
});


test('GET /api/health returns an ok payload', async () => {
  const res = await request(app)
    .get('/api/health')
    .expect('content-type', /application\/json/)
    .expect(200);

  assert.equal(res.body.ok, true);
  assert.match(res.body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('GET / serves the static dashboard shell', async () => {
  const res = await request(app)
    .get('/')
    .expect('content-type', /text\/html/)
    .expect(200);

  assert.match(res.text, /<html/i);
});

test('GET /app.js serves the frontend bundle', async () => {
  const res = await request(app)
    .get('/app.js')
    .expect(200);

  assert.match(res.headers['content-type'], /(application|text)\/javascript/);
  assert.match(res.text, /fetch/);
});

test('unknown paths return the JSON 404 contract', async () => {
  const res = await request(app)
    .get('/does-not-exist')
    .expect('content-type', /application\/json/)
    .expect(404);

  assert.deepEqual(res.body, { error: 'Not found' });
});

test('unauthenticated session check returns 401', async () => {
  const res = await request(app)
    .get('/api/auth/session')
    .expect('content-type', /application\/json/)
    .expect(401);

  assert.deepEqual(res.body, { error: 'Not authenticated' });
});

test('admin routes reject unauthenticated requests', async () => {
  const res = await request(app)
    .get('/api/admin/users')
    .expect('content-type', /application\/json/)
    .expect(401);

  assert.deepEqual(res.body, { error: 'Authentication required' });
});

test('import rule routes reject unauthenticated requests', async () => {
  await request(app)
    .get('/api/admin/import-rules')
    .expect('content-type', /application\/json/)
    .expect(401);

  await request(app)
    .get('/api/admin/open-collections/facets')
    .expect('content-type', /application\/json/)
    .expect(401);

  await request(app)
    .post('/api/admin/import-rules/run')
    .send({ mode: 'import_all', scope: 'all' })
    .expect('content-type', /application\/json/)
    .expect(401);

  await request(app)
    .get('/api/admin/jobs')
    .expect('content-type', /application\/json/)
    .expect(401);

  await request(app)
    .post('/api/admin/jobs/catalogue-lookup')
    .send({ limit: 1, dryRun: true })
    .expect('content-type', /application\/json/)
    .expect(401);
});

test('authenticated mutations require a valid CSRF token', async () => {
  const token = createSession('admin');
  try {
    await request(app)
      .post('/api/admin/cache/refresh')
      .set('Cookie', `session=${token}`)
      .expect('content-type', /application\/json/)
      .expect(403);

    const csrfToken = getSessionCsrfToken(token);
    const res = await request(app)
      .post('/api/admin/cache/refresh')
      .set('Cookie', `session=${token}`)
      .set('x-csrf-token', csrfToken)
      .expect('content-type', /application\/json/)
      .expect(200);

    assert.deepEqual(res.body, { ok: true, message: 'In-memory cache cleared. Next query will re-fetch.' });
  } finally {
    destroySession(token);
  }
});

test('import rule run validates mode and scope', async () => {
  const token = createSession('admin');
  try {
    const csrfToken = getSessionCsrfToken(token);
    const invalidMode = await request(app)
      .post('/api/admin/import-rules/run')
      .set('Cookie', `session=${token}`)
      .set('x-csrf-token', csrfToken)
      .send({ mode: 'not_real', scope: 'selected', ruleIds: [] })
      .expect('content-type', /application\/json/)
      .expect(400);

    assert.equal(invalidMode.body.error, 'Invalid import run mode.');

    const invalidScope = await request(app)
      .post('/api/admin/import-rules/run')
      .set('Cookie', `session=${token}`)
      .set('x-csrf-token', csrfToken)
      .send({ mode: 'import_all', scope: 'nearby', ruleIds: [] })
      .expect('content-type', /application\/json/)
      .expect(400);

    assert.equal(invalidScope.body.error, 'Invalid import rule scope.');

    const missingPdfsMode = await request(app)
      .post('/api/admin/import-rules/run')
      .set('Cookie', `session=${token}`)
      .set('x-csrf-token', csrfToken)
      .send({ mode: 'sync_missing_pdfs', scope: 'selected', ruleIds: [] })
      .expect('content-type', /application\/json/)
      .expect(400);

    assert.equal(missingPdfsMode.body.error, 'Select at least one import rule.');
  } finally {
    destroySession(token);
  }
});

test('legacy import-rule sync endpoint uses durable document sync job state', async () => {
  const token = createSession('admin');
  const runningJobId = await createAdminJob({
    type: 'document_sync',
    label: 'Existing Document Sync',
    params: {},
    runnerType: 'local',
  });
  try {
    const csrfToken = getSessionCsrfToken(token);
    const res = await request(app)
      .post('/api/admin/import-rules/sync')
      .set('Cookie', `session=${token}`)
      .set('x-csrf-token', csrfToken)
      .send({
        name: 'Ad hoc sync route fixture',
        degree: 'Doctor of Education - EdD',
        mode: 'import_all',
        downloadFiles: false,
      })
      .expect('content-type', /application\/json/)
      .expect(202);

    assert.equal(res.body.ok, true);
    assert.equal(res.body.alreadyRunning, true);
    assert.equal(res.body.jobId, runningJobId);
  } finally {
    await finishAdminJob(runningJobId, { status: 'completed', runnerState: 'completed' });
    destroySession(token);
  }
});

test('metrics validates query parameters before collecting data', async () => {
  const res = await request(app)
    .get('/api/metrics?maxRecords=10000')
    .expect('content-type', /application\/json/)
    .expect(400);

  assert.equal(res.body.error, 'Validation failed');
  assert.deepEqual(res.body.errors, ['maxRecords must be between 1 and 9999.']);
});

test('authenticated metrics reads ignore file enrichment params without CSRF', async () => {
  const token = createSession('admin');
  try {
    const res = await request(app)
      .get('/api/metrics?maxRecords=9999&scanLimit=50000&downloadFiles=1&recomputeFromCache=1')
      .set('Cookie', `session=${token}`)
      .expect('content-type', /application\/json/);

    assert.notEqual(res.status, 403);
    assert.equal(res.body.source.readOnlyFileEnrichment, true);
    assert.equal(res.body.source.downloadFiles, false);
    assert.equal(res.body.source.recomputeFromCache, false);
    assert.deepEqual(res.body.source.ignoredFileEnrichmentParams, {
      downloadFiles: true,
      recomputeFromCache: true,
    });
  } finally {
    destroySession(token);
  }
});

test('metrics reads from stored app tables without Open Collections fetches', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const docId = `stored-metrics-${suffix}`;

  await saveDocumentMetadata({
    id: docId,
    title: 'Stored metrics route fixture',
    author: 'Fixture Author',
    year: 2999,
    degree: 'Doctor of Education - EdD',
    program: 'Testing',
    affiliation: [],
    pages: 1,
    pagesSource: 'estimated_from_metadata_words',
    wordCount: 250,
    wordCountSource: 'metadata_text',
    bodyWordCount: null,
    abstract: 'Stored route fixture abstract.',
    subjects: ['Testing'],
    themes: [],
    methodologies: [],
    conceptTerms: [],
    downloadStatus: 'not_attempted',
    downloadError: null,
  });
  await saveFileMetric(docId, {
    status: 'recomputed_from_cache',
    error: null,
    pdfPath: '/tmp/stored-metrics-route.pdf',
    downloadUrl: 'https://circle.library.ubc.ca/rest/bitstreams/789/retrieve',
    fileBytes: 1000,
    wordCount: 50000,
    bodyWordCount: 47000,
    pageCount: 180,
    wordSource: 'cached_pdf_text',
    pageSource: 'cached_pdf',
  });
  await saveCitations(docId, [
    'Fixture, A. (2020). Stored citation.',
  ], (text) => `stored-metrics-${suffix}-${text}`);
  await saveCommitteeMembers(docId, [
    { name: 'Sam Supervisor', role: 'Supervisor', affiliation: 'UBC' },
    { name: 'Una University', role: 'University Examiner', affiliation: 'UBC' },
    { name: 'Eli External', role: 'External Examiner', affiliation: 'External University' },
  ], 'pdf');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Open Collections fetch should not be called by /api/metrics');
  };
  try {
    const res = await request(app)
      .get('/api/metrics?index=ubctheses&term=route-test-no-sync-key&maxRecords=1&scanLimit=1')
      .expect('content-type', /application\/json/)
      .expect(200);

    assert.equal(res.body.source.servedFromCache, true);
    assert.equal(res.body.source.documentCache.exactSyncKeyMatch, false);
    assert.equal(res.body.documents.length, 1);
    assert.equal(res.body.documents[0].id, docId);
    assert.equal(res.body.documents[0].pages, 180);
    assert.equal(res.body.documents[0].wordCount, 50000);
    assert.equal(res.body.documents[0].bodyWordCount, 47000);
    assert.equal(res.body.documents[0].citationCount, 1);
    assert.deepEqual(res.body.documents[0].supervisors, ['Sam Supervisor']);
    assert.ok(res.body.documents[0].committee.some((member) => member.role === 'University Examiner'));
    assert.ok(res.body.documents[0].committee.some((member) => member.role === 'External Examiner'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('admin jobs endpoint exposes operational status and catalogue preview', async () => {
  const token = createSession('admin');
  try {
    const csrfToken = getSessionCsrfToken(token);
    const jobs = await request(app)
      .get('/api/admin/jobs')
      .set('Cookie', `session=${token}`)
      .expect('content-type', /application\/json/)
      .expect(200);

    assert.ok(Array.isArray(jobs.body.jobs));
    assert.ok(Array.isArray(jobs.body.syncRuns));
    assert.ok(jobs.body.catalogueStats);
    assert.equal(typeof jobs.body.catalogueStats.pending, 'number');
    assert.ok(jobs.body.topicStatus);

    const preview = await request(app)
      .post('/api/admin/jobs/catalogue-lookup')
      .set('Cookie', `session=${token}`)
      .set('x-csrf-token', csrfToken)
      .send({ limit: 1, dryRun: true })
      .expect('content-type', /application\/json/)
      .expect(200);

    assert.equal(preview.body.ok, true);
    assert.equal(preview.body.dryRun, true);
    assert.equal(typeof preview.body.total, 'number');
    assert.equal(typeof preview.body.previewTotal, 'number');
    assert.ok(Array.isArray(preview.body.previews));
  } finally {
    destroySession(token);
  }
});

test('internal worker artifact endpoints require token and stream cache files', async () => {
  const token = 'artifact-token-test';
  const jobId = await createAdminJob({
    type: 'cache_refresh_doc',
    label: 'Artifact Test',
    params: { docId: 'artifact-doc' },
    artifactTokenHash: hashAdminJobToken(token),
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-artifacts-test-'));
  const pdfPath = path.join(dir, 'cached.pdf');
  await fs.writeFile(pdfPath, Buffer.from('%PDF-1.4\n', 'utf8'));
  await saveFileMetric('artifact-doc', {
    status: 'cached',
    pdfPath,
    downloadUrl: 'https://example.test/doc.pdf',
    fileBytes: 9,
    wordCount: 10,
    pageCount: 1,
    wordSource: 'test',
    pageSource: 'test',
  });

  await request(app)
    .get(`/api/internal/jobs/${jobId}/artifacts/pdf/artifact-doc`)
    .expect('content-type', /application\/json/)
    .expect(401);

  await request(app)
    .get(`/api/internal/jobs/${jobId}/artifacts/pdf/not-the-job-doc`)
    .set('authorization', `Bearer ${token}`)
    .expect('content-type', /application\/json/)
    .expect(401);

  const download = await request(app)
    .get(`/api/internal/jobs/${jobId}/artifacts/pdf/artifact-doc`)
    .set('authorization', `Bearer ${token}`)
    .expect('content-type', /application\/pdf/)
    .expect(200);
  assert.equal(download.text || download.body.toString('utf8'), '%PDF-1.4\n');
  assert.equal(download.headers['x-artifact-path'], undefined);

  const upload = await request(app)
    .put(`/api/internal/jobs/${jobId}/artifacts/full-text/artifact-doc`)
    .set('authorization', `Bearer ${token}`)
    .set('content-type', 'text/plain')
    .set('x-source-url', 'https://example.test/full.txt')
    .send('A long enough full text body for artifact storage.')
    .expect('content-type', /application\/json/)
    .expect(200);
  assert.match(upload.body.fullTextPath, /full-text-cache/);
  assert.equal(upload.body.fullTextSourceUrl, 'https://example.test/full.txt');

  await finishAdminJob(jobId, { status: 'completed', runnerState: 'completed' });
  await request(app)
    .get(`/api/internal/jobs/${jobId}/artifacts/pdf/artifact-doc`)
    .set('authorization', `Bearer ${token}`)
    .expect('content-type', /application\/json/)
    .expect(401);

  await fs.rm(dir, { recursive: true, force: true });
});

test('admin cannot delete their own account', async () => {
  const token = createSession('admin');
  try {
    const csrfToken = getSessionCsrfToken(token);
    const res = await request(app)
      .delete('/api/admin/users/admin')
      .set('Cookie', `session=${token}`)
      .set('x-csrf-token', csrfToken)
      .expect('content-type', /application\/json/)
      .expect(400);

    assert.equal(res.body.error, 'Cannot delete your own admin account');
  } finally {
    destroySession(token);
  }
});
