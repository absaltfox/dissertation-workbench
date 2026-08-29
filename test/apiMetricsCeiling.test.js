import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

// #24: GET /api/metrics has no hard ceiling on the admin branch today
// (`effectiveMaxRecords = isAdminRequest ? maxRecords : Math.min(maxRecords,
// PUBLIC_MAX_RECORDS)`), so an authenticated admin request can hand every JS
// aggregator in collectMetrics()/buildMetricsPayloadFromRecords an unbounded
// record count and synchronously serialize the whole `documents` array.
//
// Note on scale: src/validate.js's validateMetricsParams() already rejects
// any maxRecords above 9999 with a 400 (a pre-existing, Phase-D-unrelated
// guard predating this audit, pinned by an existing test in
// test/server.test.js) — so the literal `maxRecords=56000` repro from the
// task brief 400s before reaching this route's own logic at all, for both
// admin and anonymous callers. The exposure this test proves is real within
// the 300-9999 range the input validator actually admits: an admin request
// for the validator's own maximum (9999) was, pre-fix, served in full
// (9999-scale JS aggregation, an uncapped `documents` array) with no
// admin-specific ceiling of its own. This test exercises that scenario.

let closeDb;
let saveDocumentMetadataBatch;
let createSession;
let getSessionCsrfToken;
let app;
let tempDir;

const TOTAL_DOCUMENTS = 6000;
const ADMIN_MAX_RECORDS_CEILING = 5000; // must match src/routes/metricsRoutes.js
const PUBLIC_MAX_RECORDS_TEST_DEFAULT = 2000; // config.js default outside production

function fixtureDoc(index) {
  return {
    id: `ceiling-${String(index).padStart(5, '0')}`,
    title: `Ceiling dissertation ${index}`,
    author: `Author ${index}`,
    year: 1980 + (index % 40),
    degree: index % 2 === 0 ? 'PhD' : 'EdD',
    program: `Program ${index % 8}`,
    affiliation: ['UBC'],
    supervisors: [`Supervisor ${index % 50}`],
    abstract: `Ceiling fixture ${index}`,
    subjects: ['education'],
    conceptTerms: [`concept-${index % 20}`],
    methodologies: [`method-${index % 5}`],
    charCount: 100 + index,
  };
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-metrics-ceiling-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.NODE_ENV = 'test';
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');
  delete process.env.PUBLIC_MAX_RECORDS;

  const db = await import('../src/db.js');
  ({ closeDb, saveDocumentMetadataBatch } = db);
  await db.ensureStorage();

  for (let start = 0; start < TOTAL_DOCUMENTS; start += 200) {
    const count = Math.min(200, TOTAL_DOCUMENTS - start);
    await saveDocumentMetadataBatch(Array.from({ length: count }, (_, offset) => ({
      doc: fixtureDoc(start + offset),
      syncKey: 'metrics-ceiling',
    })));
  }

  ({ createSession, getSessionCsrfToken } = await import('../src/auth.js'));
  const { createMetricsRouter } = await import('../src/routes/metricsRoutes.js');
  app = express();
  app.use('/api', createMetricsRouter({
    metricsCache: new Map(),
    metricsInflight: new Map(),
    loadSyncModule: async () => ({ getSyncKeyForOptions: () => 'metrics-ceiling' }),
  }));
});

test.after(async () => {
  await closeDb?.();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test('#24: an authenticated admin requesting the input validator\'s own maximum (maxRecords=9999) is still bounded to a hard server-side ceiling', async () => {
  const token = createSession('admin');
  const csrfToken = getSessionCsrfToken(token);
  const res = await request(app)
    .get('/api/metrics?maxRecords=9999')
    .set('Cookie', `session=${token}`)
    .set('x-csrf-token', csrfToken)
    .expect('content-type', /application\/json/)
    .expect(200);

  assert.equal(res.body.documents.length, ADMIN_MAX_RECORDS_CEILING);
  assert.ok(res.body.documents.length < TOTAL_DOCUMENTS, 'ceiling must bind below the full corpus');
  assert.ok(
    JSON.stringify(res.body).length < 20_000_000,
    'admin payload must stay well under a size that risks exceeding V8 string limits'
  );
});

test('#24: maxRecords=56000 (the literal scale target) already 400s at input validation, for both admin and anonymous callers, before this route\'s own logic runs', async () => {
  const token = createSession('admin');
  const csrfToken = getSessionCsrfToken(token);
  const adminRes = await request(app)
    .get('/api/metrics?maxRecords=56000')
    .set('Cookie', `session=${token}`)
    .set('x-csrf-token', csrfToken)
    .expect(400);
  assert.equal(adminRes.body.error, 'Validation failed');

  const anonRes = await request(app)
    .get('/api/metrics?maxRecords=56000')
    .expect(400);
  assert.equal(anonRes.body.error, 'Validation failed');
});

test('#24: anonymous requests remain bounded by the existing PUBLIC_MAX_RECORDS guardrail, unaffected by the new admin ceiling', async () => {
  const res = await request(app)
    .get('/api/metrics?maxRecords=9999')
    .expect('content-type', /application\/json/)
    .expect(200);

  assert.equal(res.body.documents.length, PUBLIC_MAX_RECORDS_TEST_DEFAULT);
});

test('#24: a large bounded admin request does not stall a concurrent lightweight request', async () => {
  const token = createSession('admin');
  const csrfToken = getSessionCsrfToken(token);

  const bigRequest = request(app)
    .get('/api/metrics?maxRecords=9999&refresh=1')
    .set('Cookie', `session=${token}`)
    .set('x-csrf-token', csrfToken);

  // Give the big request a tick to start before firing the small one, so the
  // small one's timing reflects whether the event loop is free, not simply
  // whether it won a race to go first.
  await new Promise((resolve) => setImmediate(resolve));

  const smallStart = Date.now();
  const smallRes = await request(app).get('/api/metrics?maxRecords=1');
  const smallElapsedMs = Date.now() - smallStart;

  await bigRequest;

  assert.equal(smallRes.status, 200);
  assert.ok(smallElapsedMs < 5000, `small concurrent request took ${smallElapsedMs}ms`);
});
