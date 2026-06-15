import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let testDataDir;
let buildFlyWorkerMachinePayload;
let cancelAdminWorkerJob;
let WorkerArtifactClient;
let analyzeDocumentFile;
let appendAdminJobLog;
let claimAdminJob;
let closeDb;
let createAdminJob;
let ensureStorage;
let getAdminJob;
let hashAdminJobToken;
let heartbeatAdminJob;
let finishAdminJob;
let loadStoredFileMetric;
let validateAdminJobArtifactToken;

test.before(async () => {
  testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-worker-tests-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.APP_DATA_DIR = testDataDir;
  process.env.SQLITE_PATH = path.join(testDataDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(testDataDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(testDataDir, 'full-text-cache');
  process.env.NODE_ENV = 'test';

  ({ buildFlyWorkerMachinePayload, cancelAdminWorkerJob } = await import('../src/services/adminWorker.js'));
  ({ WorkerArtifactClient } = await import('../src/workerArtifacts.js'));
  ({ analyzeDocumentFile } = await import('../src/pdf.js'));
  ({
    appendAdminJobLog,
    claimAdminJob,
    closeDb,
    createAdminJob,
    ensureStorage,
    getAdminJob,
    hashAdminJobToken,
    heartbeatAdminJob,
    finishAdminJob,
    loadStoredFileMetric,
    validateAdminJobArtifactToken,
  } = await import('../src/db.js'));
});

test.after(async () => {
  await closeDb?.();
  if (testDataDir) await fs.rm(testDataDir, { recursive: true, force: true });
});

test('Fly worker machine payload is private, one-shot, and job-scoped', () => {
  const payload = buildFlyWorkerMachinePayload({
    image: 'registry.fly.io/dissertation-workbench:deployment-123',
    jobId: 42,
    token: 'secret-token',
    timeoutMs: 12345,
  });

  assert.equal(payload.skip_service_registration, true);
  assert.equal(payload.config.image, 'registry.fly.io/dissertation-workbench:deployment-123');
  assert.equal(payload.config.auto_destroy, true);
  assert.deepEqual(payload.config.restart, { policy: 'no' });
  assert.deepEqual(payload.config.init.exec, ['node', 'src/jobWorker.js']);
  assert.equal(payload.config.env.ADMIN_JOB_ID, '42');
  assert.equal(payload.config.env.ADMIN_JOB_ARTIFACT_TOKEN, 'secret-token');
  assert.equal(payload.config.env.ADMIN_WORKER_TIMEOUT_MS, '12345');
  assert.equal(payload.config.env.DOCUMENT_SYNC_ENABLED, '0');
  assert.equal(payload.config.metadata.role, 'admin-worker');
  assert.equal(payload.config.metadata.admin_job_id, '42');
  assert.equal(payload.config.services, undefined);
});

test('admin worker job lifecycle helpers claim once, heartbeat, log, and validate artifact token', async () => {
  await ensureStorage();
  const token = `token-${Date.now()}`;
  const jobId = await createAdminJob({
    type: 'cache_refresh_doc',
    label: 'Lifecycle Test',
    params: { docId: 'lifecycle-doc' },
    artifactTokenHash: hashAdminJobToken(token),
    timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    runnerType: 'local',
  });

  assert.equal(await validateAdminJobArtifactToken(jobId, 'wrong-token'), false);
  assert.equal(await validateAdminJobArtifactToken(jobId, token, { docId: 'wrong-doc' }), false);
  assert.equal(await validateAdminJobArtifactToken(jobId, token, { docId: 'lifecycle-doc' }), true);

  const claimed = await claimAdminJob(jobId, 'runner-1');
  assert.equal(claimed.id, jobId);
  assert.equal(claimed.runnerId, 'runner-1');
  assert.equal(claimed.runnerState, 'running');
  assert.ok(claimed.claimedAt);

  assert.equal(await claimAdminJob(jobId, 'runner-2'), null);

  await heartbeatAdminJob(jobId, 'still-running');
  await appendAdminJobLog(jobId, 'hello worker\n');
  const updated = await getAdminJob(jobId);
  assert.equal(updated.runnerState, 'still-running');
  assert.ok(updated.heartbeatAt);
  assert.match(updated.log, /hello worker/);

  await finishAdminJob(jobId, { status: 'completed', runnerState: 'completed' });
  assert.equal(await validateAdminJobArtifactToken(jobId, token, { docId: 'lifecycle-doc' }), false);
});

test('one-shot job worker claims unsupported jobs and marks them failed', async () => {
  await ensureStorage();
  const token = `worker-token-${Date.now()}`;
  const jobId = await createAdminJob({
    type: 'unsupported_worker_test',
    label: 'Unsupported Worker Test',
    params: {},
    artifactTokenHash: hashAdminJobToken(token),
    timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    runnerType: 'local',
  });

  await assert.rejects(
    () => execFileAsync(process.execPath, ['src/jobWorker.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SKIP_LOCAL_ENV: '1',
        APP_DATA_DIR: testDataDir,
        SQLITE_PATH: path.join(testDataDir, 'metrics.sqlite'),
        PDF_CACHE_DIR: path.join(testDataDir, 'pdf-cache'),
        FULL_TEXT_CACHE_DIR: path.join(testDataDir, 'full-text-cache'),
        ADMIN_JOB_ID: String(jobId),
        ADMIN_JOB_ARTIFACT_TOKEN: token,
        ADMIN_WORKER_TIMEOUT_MS: '30000',
      },
      timeout: 30_000,
    }),
    /Command failed/
  );

  const job = await getAdminJob(jobId);
  assert.equal(job.status, 'failed');
  assert.equal(job.runnerState, 'failed');
  assert.match(job.error, /Unsupported import\/PDF admin job type/);
  assert.match(job.log, /Worker claimed job/);
});

test('Fly worker cancel preserves running state when machine destroy fails', async () => {
  await ensureStorage();
  const token = `fly-cancel-token-${Date.now()}`;
  const jobId = await createAdminJob({
    type: 'cache_refresh_doc',
    label: 'Fly Cancel Failure',
    params: { docId: 'fly-cancel-doc' },
    artifactTokenHash: hashAdminJobToken(token),
    timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    runnerType: 'fly',
  });
  await claimAdminJob(jobId, 'fly-machine-1');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const result = await cancelAdminWorkerJob(jobId);
    assert.equal(result.ok, false);
    assert.match(result.error, /Fly worker destroy failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const job = await getAdminJob(jobId);
  assert.equal(job.status, 'running');
  assert.equal(job.runnerState, 'kill_failed');
  assert.equal(await validateAdminJobArtifactToken(jobId, token, { docId: 'fly-cancel-doc' }), true);
});

test('production auto mode fails closed without Fly API token', async () => {
  const script = `
    process.env.SKIP_LOCAL_ENV = '1';
    process.env.NODE_ENV = 'production';
    process.env.FLY_APP_NAME = 'dissertation-workbench';
    delete process.env.FLY_API_TOKEN;
    const { createAndStartAdminWorkerJob } = await import('./src/services/adminWorker.js');
    try {
      await createAndStartAdminWorkerJob({ type: 'document_sync', label: 'Should Fail', params: {} });
      process.exit(1);
    } catch (error) {
      if (!/FLY_API_TOKEN is required/.test(error.message)) {
        console.error(error.message);
        process.exit(2);
      }
    }
  `;
  await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SKIP_LOCAL_ENV: '1',
      NODE_ENV: 'production',
      FLY_APP_NAME: 'dissertation-workbench',
      FLY_API_TOKEN: '',
    },
    timeout: 30_000,
  });
});

test('worker artifact client downloads cached PDFs to temp files and uploads artifacts', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const req = {
      method: options.method || 'GET',
      path: parsed.pathname,
      auth: options.headers?.authorization,
      headers: options.headers || {},
      body: options.body,
    };
    requests.push(req);
    if (req.auth !== 'Bearer client-token') {
      return new Response(JSON.stringify({ error: 'nope' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    if (req.method === 'GET' && req.path === '/api/internal/jobs/7/artifacts/pdf/doc-1') {
      return new Response(Buffer.from('%PDF test'), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }
    if (req.method === 'GET' && req.path === '/api/internal/jobs/7/artifacts/full-text/doc-1') {
      return new Response('full text body', {
        status: 200,
        headers: { 'content-type': 'text/plain', 'x-artifact-path': '/web/cache/doc-1.txt' },
      });
    }
    if (req.method === 'PUT' && req.path === '/api/internal/jobs/7/artifacts/pdf/doc-1') {
      assert.equal(Buffer.from(req.body).toString('utf8'), '%PDF upload');
      assert.equal(req.headers['x-download-url'], 'https://example.test/doc.pdf');
      return new Response(JSON.stringify({ pdfPath: '/web/cache/uploaded.pdf', fileBytes: 11 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (req.method === 'PUT' && req.path === '/api/internal/jobs/7/artifacts/full-text/doc-1') {
      assert.equal(String(req.body), 'uploaded text');
      assert.equal(req.headers['x-source-url'], 'https://example.test/doc.txt');
      return new Response(JSON.stringify({ fullTextPath: '/web/cache/uploaded.txt', fullTextBytes: 13 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('', { status: 404 });
  };

  try {
    const client = new WorkerArtifactClient({
      baseUrl: 'http://worker-artifacts.test',
      jobId: 7,
      token: 'client-token',
    });

    const pdf = await client.downloadPdfToTemp('doc-1');
    assert.equal(await fs.readFile(pdf.path, 'utf8'), '%PDF test');
    assert.equal(pdf.pdfPath, null);
    await pdf.cleanup();

    const fullText = await client.downloadFullText('doc-1');
    assert.equal(fullText.fullText, 'full text body');
    assert.equal(fullText.fullTextPath, '/web/cache/doc-1.txt');

    assert.deepEqual(
      await client.uploadPdf('doc-1', Buffer.from('%PDF upload'), 'https://example.test/doc.pdf'),
      { pdfPath: '/web/cache/uploaded.pdf', fileBytes: 11 }
    );
    assert.deepEqual(
      await client.uploadFullText('doc-1', 'uploaded text', 'https://example.test/doc.txt'),
      { fullTextPath: '/web/cache/uploaded.txt', fullTextBytes: 13 }
    );

    assert.equal(requests.length, 4);
    assert.ok(requests.every((req) => req.auth === 'Bearer client-token'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('PDF analysis with artifact client saves web-owned durable PDF path', async () => {
  await ensureStorage();
  const originalFetch = globalThis.fetch;
  const docId = `artifact-pdf-${Date.now()}`;
  const durablePath = `/web/pdf-cache/${docId}.pdf`;
  const uploaded = [];

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/rest/handle/')) {
      return new Response(JSON.stringify({
        bitstreams: [{
          id: 123,
          name: 'fixture.pdf',
          mimeType: 'application/pdf',
          bundleName: 'ORIGINAL',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (href.includes('/rest/bitstreams/123/retrieve')) {
      return new Response(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n'), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  try {
    await analyzeDocumentFile({
      id: docId,
      title: 'Artifact PDF Fixture',
      author: 'Worker Tester',
      originalRecordUrl: 'https://circle.library.ubc.ca/rest/handle/2429/fixture',
    }, {
      downloadFiles: true,
      forceDownload: true,
      recomputeFromCache: false,
      artifactClient: {
        uploadPdf: async (uploadedDocId, bytes, downloadUrl) => {
          uploaded.push({ uploadedDocId, bytes: Buffer.from(bytes), downloadUrl });
          return { pdfPath: durablePath, fileBytes: bytes.length };
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].uploadedDocId, docId);
  assert.match(uploaded[0].downloadUrl, /\/rest\/bitstreams\/123\/retrieve/);

  const stored = await loadStoredFileMetric(docId);
  assert.equal(stored.pdf_path, durablePath);
  assert.equal(stored.status, 'redownloaded');
  assert.equal(Number(stored.page_count), 1);
  assert.equal(stored.page_source, 'downloaded_pdf');
  assert.equal(stored.pdf_path.includes('oc-pdf-'), false);
});
