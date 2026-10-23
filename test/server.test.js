import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { app, msUntilNextDailyHour, startCitationScanJob } from '../src/server.js';
import { createSession, destroySession, getSessionCsrfToken } from '../src/auth.js';
import { getConceptPipelineStatus } from '../src/conceptsPipeline.js';
import { CITATION_SCAN_NIGHTLY_ENABLED } from '../src/config.js';
import {
  closeDb, createAdminJob, finishAdminJob, hashAdminJobToken, hasRunningAdminJob, saveCitations,
  countPendingCitationScans, saveCitationExtractionState,
  saveCommitteeMembers, saveDocumentMetadata, saveFileMetric, saveImportRule
} from '../src/db.js';
import { buildImportRulesRunParams } from '../src/routes/adminImportRoutes.js';
import { buildCommitteeReparseParams } from '../src/routes/adminOperationsRoutes.js';

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

test('committee reparse parameters preserve narrow scopes and reject unsafe widening', () => {
  const valid = buildCommitteeReparseParams({
    docIds: [' 1.0094455 ', '1.0094455'],
    ruleId: ' history-ma ',
    dryRun: 'false',
    maxDocuments: '25',
  });
  assert.deepEqual(valid, {
    valid: true,
    errors: [],
    params: {
      docIds: ['1.0094455'],
      ruleId: 'history-ma',
      dryRun: false,
      maxDocuments: 25,
    },
  });

  const stringScope = buildCommitteeReparseParams({ docIds: '1.0094455', dryRun: true });
  assert.equal(stringScope.valid, false);
  assert.ok(stringScope.errors.includes('docIds must be an array.'));

  const invalidControls = buildCommitteeReparseParams({ dryRun: 'sometimes', maxDocuments: 0 });
  assert.equal(invalidControls.valid, false);
  assert.ok(invalidControls.errors.includes('dryRun must be a boolean.'));
  assert.ok(invalidControls.errors.includes('maxDocuments must be an integer between 1 and 5000.'));
});

test('GET / serves the static dashboard shell', async () => {
  const res = await request(app)
    .get('/')
    .expect('content-type', /text\/html/)
    .expect(200);

  assert.match(res.text, /<html/i);
});

test('GET /app/main.js serves the frontend entry module', async () => {
  const res = await request(app)
    .get('/app/main.js')
    .expect(200);

  assert.match(res.headers['content-type'], /(application|text)\/javascript/);
  assert.match(res.text, /loadData/);
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

  // Public/unauthenticated reads must start no citation-scan work.
  await request(app)
    .post('/api/admin/jobs/citation-scan')
    .send({ dryRun: true })
    .expect('content-type', /application\/json/)
    .expect(401);
});

test('daily scheduler boundary math counts the milliseconds to the next local hour', () => {
  // Both fixtures are wall-clock local, so the arithmetic is timezone-independent.
  const beforeHour = new Date(2026, 0, 1, 1, 0, 0);
  assert.equal(msUntilNextDailyHour(3, beforeHour), 2 * 60 * 60 * 1000);
  const afterHour = new Date(2026, 0, 1, 4, 0, 0);
  assert.equal(msUntilNextDailyHour(3, afterHour), 23 * 60 * 60 * 1000);
  // Exactly at the hour rolls forward a full day rather than firing immediately.
  const atHour = new Date(2026, 0, 1, 3, 0, 0);
  assert.equal(msUntilNextDailyHour(3, atHour), 24 * 60 * 60 * 1000);
});

test('nightly citation scan is disabled by default', () => {
  assert.equal(CITATION_SCAN_NIGHTLY_ENABLED, false);
});

test('citation scan never overlaps an active run (route and scheduler share the guard)', async () => {
  const runningJobId = await createAdminJob({
    type: 'citation_scan', label: 'Existing Citation Scan', params: {}, runnerType: 'local',
  });
  const token = createSession('admin');
  try {
    // Scheduler-side guard: startCitationScanJob short-circuits without spawning.
    const scheduled = await startCitationScanJob('scheduled');
    assert.equal(scheduled.alreadyRunning, true);
    assert.equal(scheduled.jobId, runningJobId);

    // Route-side guard: 202 + the running job id, no new job.
    const res = await request(app)
      .post('/api/admin/jobs/citation-scan')
      .set('Cookie', `session=${token}`)
      .set('x-csrf-token', getSessionCsrfToken(token))
      .send({})
      .expect('content-type', /application\/json/)
      .expect(202);
    assert.equal(res.body.alreadyRunning, true);
    assert.equal(res.body.jobId, runningJobId);
  } finally {
    await finishAdminJob(runningJobId, { status: 'completed', runnerState: 'completed' });
    destroySession(token);
  }
});

test('citation scan preview counts pending documents and honors retryFailures without starting a job', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const degree = `Scan Route ${suffix}`;
  const pendingId = `route-scan-pending-${suffix}`;
  const failedId = `route-scan-failed-${suffix}`;
  for (const id of [pendingId, failedId]) {
    await saveDocumentMetadata({
      id, title: 'Route scan fixture', degree,
      originalRecordUrl: `https://circle.library.ubc.ca/rest/handle/2429/${id}`, supervisors: [],
    });
    await saveFileMetric(id, {
      status: 'streamed', contentSource: 'streamed_pdf', contentChecksum: 'route-scan-v1',
      wordCount: 100, pageCount: 3, wordSource: 'streamed_pdf_text', pageSource: 'streamed_pdf',
    });
  }
  // The production parser version is what the route counts against.
  await saveCitationExtractionState(failedId, {
    contentChecksum: 'route-scan-v1', parserVersion: 'citation-v2', status: 'failed', citationCount: 0, error: 'x',
  });

  const token = createSession('admin');
  try {
    const csrf = getSessionCsrfToken(token);
    const runningBefore = await hasRunningAdminJob('citation_scan');

    const normal = await request(app)
      .post('/api/admin/jobs/citation-scan')
      .set('Cookie', `session=${token}`).set('x-csrf-token', csrf)
      .send({ dryRun: true, degree })
      .expect(200);
    assert.equal(normal.body.dryRun, true);
    assert.equal(normal.body.total, 1); // only the un-failed streamable doc

    const retry = await request(app)
      .post('/api/admin/jobs/citation-scan')
      .set('Cookie', `session=${token}`).set('x-csrf-token', csrf)
      .send({ dryRun: true, retryFailures: true, degree })
      .expect(200);
    assert.equal(retry.body.total, 2); // failed doc re-opened

    // Forced reprocess drops every gate: both streamable docs are selected, and
    // the route echoes the flag so the operator sees it took effect.
    const forced = await request(app)
      .post('/api/admin/jobs/citation-scan')
      .set('Cookie', `session=${token}`).set('x-csrf-token', csrf)
      .send({ dryRun: true, reprocess: true, degree })
      .expect(200);
    assert.equal(forced.body.reprocess, true);
    assert.equal(forced.body.total, 2);
    assert.equal(
      await countPendingCitationScans({ filters: { degree }, parserVersion: 'citation-v2', reprocess: true }),
      2
    );

    // Cross-check the count helper directly.
    assert.equal(await countPendingCitationScans({ filters: { degree }, parserVersion: 'citation-v2' }), 1);
    // The preview started nothing.
    const runningAfter = await hasRunningAdminJob('citation_scan');
    assert.equal(runningAfter, runningBefore);
  } finally {
    destroySession(token);
  }
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

test('Import & Enrich runs the complete scope without rollout phases and requires PDF approval', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const rule = await saveImportRule({
    id: `complete-enrichment-${suffix}`,
    name: `Complete enrichment ${suffix}`,
    degree: 'Doctor of Philosophy',
    contentMode: 'pdf_stream',
  });
  const token = createSession('admin');
  try {
    const csrfToken = getSessionCsrfToken(token);
    const noApproval = await request(app)
      .post('/api/admin/import-rules/run')
      .set('Cookie', `session=${token}`)
      .set('x-csrf-token', csrfToken)
      .send({ mode: 'sync_missing_pdfs', scope: 'selected', ruleIds: [rule.id] })
      .expect(409);
    assert.match(noApproval.body.error, /explicit approval/i);

    const legacyBypass = await request(app)
      .post('/api/admin/import-rules/sync')
      .set('Cookie', `session=${token}`)
      .set('x-csrf-token', csrfToken)
      .send({ id: rule.id, mode: 'sync_missing_pdfs' })
      .expect(409);
    assert.match(legacyBypass.body.error, /import-rules run endpoint/i);

    const runningJobId = await createAdminJob({
      type: 'import_rules_sync', label: 'Existing import rules sync', params: {}, runnerType: 'local',
    });
    const accepted = await request(app)
      .post('/api/admin/import-rules/run')
      .set('Cookie', `session=${token}`)
      .set('x-csrf-token', csrfToken)
      .send({
        mode: 'sync_missing_pdfs',
        scope: 'selected',
        ruleIds: [rule.id],
        approveOriginalPdfRetrieval: true,
      })
      .expect(202);
    assert.equal(accepted.body.alreadyRunning, true);
    assert.equal(accepted.body.jobId, runningJobId);
    await finishAdminJob(runningJobId, { status: 'completed', runnerState: 'completed' });
  } finally {
    destroySession(token);
  }
});

test('Import & Enrich job params drain all bounded batches before downstream processing', () => {
  const rules = [{
    id: 'complete-rule', name: 'Complete rule', contentMode: 'pdf_stream',
    extractCitations: true, runConcepts: true,
  }];
  const params = buildImportRulesRunParams({
    mode: 'sync_missing_pdfs',
    scope: 'selected',
    selectedIds: ['complete-rule'],
    rules,
    pageSize: 75,
    scanLimit: 125_000,
  });
  assert.equal(params.pdfBatchSize, 50);
  assert.equal(params.autoContinuePdfBatches, true);
  assert.equal(params.queueEligibleProcessing, true);
  assert.deepEqual(params.syncOptions, {
    pageSize: 75,
    scanLimit: 125_000,
    syncMaxRecords: 125_000,
  });
  assert.equal('rollout' in params, false);
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

test('legacy import-rule sync endpoint rejects invalid content policies', async () => {
  const token = createSession('admin');
  try {
    const res = await request(app)
      .post('/api/admin/import-rules/sync')
      .set('Cookie', `session=${token}`)
      .set('x-csrf-token', getSessionCsrfToken(token))
      .send({
        name: 'Invalid content policy',
        degree: 'Doctor of Education - EdD',
        contentMode: 'unknown_mode',
        mode: 'import_all',
      })
      .expect('content-type', /application\/json/)
      .expect(400);

    assert.equal(res.body.error, 'Validation failed');
    assert.match(res.body.errors.join(' '), /Content mode must be one of/);
  } finally {
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
    // Full corpus is now returned; maxRecords no longer truncates cached reads.
    assert.ok(res.body.documents.length >= 1);
    const storedDoc = res.body.documents.find((d) => d.id === docId);
    assert.ok(storedDoc, 'stored fixture document should be present in full corpus');
    assert.equal(storedDoc.pages, 180);
    assert.equal(storedDoc.wordCount, 50000);
    assert.equal(storedDoc.bodyWordCount, 47000);
    assert.equal(storedDoc.citationCount, 1);
    assert.deepEqual(storedDoc.supervisors, ['Sam Supervisor']);
    assert.ok(storedDoc.committee.some((member) => member.role === 'University Examiner'));
    assert.ok(storedDoc.committee.some((member) => member.role === 'External Examiner'));
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

test('internal worker endpoint accepts concept dictionary artifacts for running jobs', async () => {
  const token = 'concept-artifact-token-test';
  const jobId = await createAdminJob({
    type: 'concept_rebuild',
    label: 'Concept Artifact Test',
    params: { method: 'patternrank' },
    artifactTokenHash: hashAdminJobToken(token),
  });
  const concepts = Array.from({ length: 750 }, (_, index) => ({
    canonical: `educational technology concept ${index} ${'x'.repeat(40)}`,
    variants: [],
    docFreq: 1,
    idf: 0,
    patternRankScore: 0.9,
  }));
  const artifact = {
    version: 2,
    generatedAt: new Date().toISOString(),
    source: { documents: 1, method: 'patternrank', model: 'test-model' },
    stats: { concepts: concepts.length, aliases: 0 },
    concepts,
    variantToCanonical: {},
  };
  assert.ok(Buffer.byteLength(JSON.stringify(artifact)) > 64 * 1024);

  await request(app)
    .put(`/api/internal/jobs/${jobId}/artifacts/concepts/latest`)
    .send(artifact)
    .set('content-type', 'application/json')
    .expect('content-type', /application\/json/)
    .expect(401);

  const upload = await request(app)
    .put(`/api/internal/jobs/${jobId}/artifacts/concepts/latest`)
    .set('authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send(artifact)
    .expect('content-type', /application\/json/)
    .expect(200);

  assert.equal(upload.body.ok, true);
  assert.equal(upload.body.stats.concepts, concepts.length);
  const status = await getConceptPipelineStatus();
  assert.equal(status.stats.concepts, concepts.length);
  assert.match(status.message, /PatternRank concept rebuild completed/);

  await finishAdminJob(jobId, { status: 'completed', runnerState: 'completed' });
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
