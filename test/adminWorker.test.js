import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';

const execFileAsync = promisify(execFile);
let testDataDir;
let buildFlyWorkerMachinePayload;
let cancelInProcessAdminJob;
let cancelAdminWorkerJob;
let CatalogueLookupCancelledError;
let WorkerArtifactClient;
let runImportPdfAdminJob;
let startCitationScanContinuation;
let runThemeRecomputeAdminJob;
let runCatalogueLookupJob;
let runBertopicJob;
let runPendingCatalogueLookups;
let runYazClient;
let analyzeDocumentFile;
let extractAndSaveParsedData;
let _setDownloadSafetyOptionsForTests;
let appendAdminJobLog;
let claimAdminJob;
let clearAllCitations;
let closeDb;
let createAdminJob;
let ensureStorage;
let getAdminJob;
let hashAdminJobToken;
let heartbeatAdminJob;
let hasRunningAdminJob;
let updateAdminJob;
let finishAdminJob;
let finishClaimedAdminJob;
let getDb;
let loadDocumentCitations;
let loadDocumentMetadata;
let listTopicLabelReviews;
let loadCatalogueLookup;
let loadStoredFileMetric;
let listPendingLookups;
let listPendingCitationExtractions;
let listPendingCitationScans;
let countPendingCitationScans;
let countPendingLookups;
let publishPassingTopicLabels;
let saveDocumentMetadata;
let saveCitations;
let reextractDocumentCitations;
let saveCitationExtractionState;
let saveFileMetric;
let selectTopicLabelCandidate;
let updateTopicManualLabel;
let deleteTopicLabelOverride;
let validateAdminJobArtifactToken;
let updateClaimedAdminJobProgress;

async function writeTextPdf(filePath, lines) {
  const escapedLines = lines.map((line) => String(line).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'));
  const textOps = escapedLines
    .map((line, index) => `${index === 0 ? '' : '0 -18 Td ' }(${line}) Tj`)
    .join('\n');
  const stream = `BT /F1 12 Tf 72 720 Td ${textOps} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  await fs.writeFile(filePath, body, 'binary');
}

// Build a real, parseable PDF in memory (via writeTextPdf) so a mocked cIRcle
// stream can return its bytes to the pdf_stream analysis path.
async function buildTextPdfBytes(lines) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-scan-pdf-'));
  const file = path.join(dir, 'fixture.pdf');
  try {
    await writeTextPdf(file, lines);
    return await fs.readFile(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// A global-fetch replacement that answers the cIRcle REST handle + bitstream
// retrieve for a given document with either PDF bytes (streaming success) or a
// non-PDF body (streaming failure).
function makeCircleStreamFetch(handles) {
  return async (input) => {
    const url = String(input);
    for (const handle of handles) {
      if (url.includes(handle.handlePart)) {
        return new Response(JSON.stringify({
          id: handle.recordId,
          bitstreams: [{ id: handle.bitstreamId, bundleName: 'ORIGINAL', mimeType: 'application/pdf', name: 'doc.pdf' }],
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes(`/rest/bitstreams/${handle.bitstreamId}/retrieve`)) {
        return new Response(handle.body, {
          headers: { 'content-type': handle.contentType || 'application/pdf' },
        });
      }
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(await predicate(), true);
}

test.before(async () => {
  testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-worker-tests-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.APP_DATA_DIR = testDataDir;
  process.env.SQLITE_PATH = path.join(testDataDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(testDataDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(testDataDir, 'full-text-cache');
  process.env.NODE_ENV = 'test';

  ({ buildFlyWorkerMachinePayload, cancelAdminWorkerJob } = await import('../src/services/adminWorker.js'));
  ({ cancelInProcessAdminJob, runBertopicJob, runCatalogueLookupJob } = await import('../src/services/adminJobs.js'));
  ({ CatalogueLookupCancelledError, runPendingCatalogueLookups, runYazClient } = await import('../src/catalogue.js'));
  ({ WorkerArtifactClient } = await import('../src/workerArtifacts.js'));
  ({ runImportPdfAdminJob, startCitationScanContinuation } = await import('../src/services/importPdfJobRunner.js'));
  ({ runThemeRecomputeAdminJob } = await import('../src/services/themeJobRunner.js'));
  ({ analyzeDocumentFile, extractAndSaveParsedData, _setDownloadSafetyOptionsForTests } = await import('../src/pdf.js'));
  _setDownloadSafetyOptionsForTests({ resolveHost: async () => [{ address: '142.103.96.1' }] });
  ({
    appendAdminJobLog,
    claimAdminJob,
    clearAllCitations,
    closeDb,
    createAdminJob,
    ensureStorage,
    getAdminJob,
    hashAdminJobToken,
    heartbeatAdminJob,
    hasRunningAdminJob,
    finishAdminJob,
    finishClaimedAdminJob,
    getDb,
    loadDocumentCitations,
    loadDocumentMetadata,
    listTopicLabelReviews,
    loadCatalogueLookup,
    loadStoredFileMetric,
    listPendingLookups,
    listPendingCitationExtractions,
    listPendingCitationScans,
    countPendingCitationScans,
    countPendingLookups,
    publishPassingTopicLabels,
    saveDocumentMetadata,
    saveCitations,
    reextractDocumentCitations,
    saveCitationExtractionState,
    saveFileMetric,
    selectTopicLabelCandidate,
    updateTopicManualLabel,
    deleteTopicLabelOverride,
    updateAdminJob,
    updateClaimedAdminJobProgress,
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
    executionId: 'worker-execution-42',
    timeoutMs: 12345,
  });

  assert.equal(payload.skip_service_registration, true);
  assert.equal(payload.config.image, 'registry.fly.io/dissertation-workbench:deployment-123');
  assert.equal(payload.config.auto_destroy, true);
  assert.deepEqual(payload.config.restart, { policy: 'no' });
  assert.deepEqual(payload.config.init.exec, ['node', 'src/jobWorker.js']);
  assert.equal(payload.config.env.ADMIN_JOB_ID, '42');
  assert.equal(payload.config.env.ADMIN_JOB_ARTIFACT_TOKEN, 'secret-token');
  assert.equal(payload.config.env.ADMIN_JOB_EXECUTION_ID, 'worker-execution-42');
  assert.equal(payload.config.env.ADMIN_WORKER_TIMEOUT_MS, '12345');
  assert.equal(payload.config.env.DOCUMENT_SYNC_ENABLED, '0');
  assert.equal(payload.config.metadata.role, 'admin-worker');
  assert.equal(payload.config.metadata.admin_job_id, '42');
  assert.equal(payload.config.services, undefined);
});

test('BERTopic Fly worker payload uses the Python worker image and labeling env', () => {
  const previousBertopicImage = process.env.BERTOPIC_WORKER_IMAGE;
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  process.env.BERTOPIC_WORKER_IMAGE = 'registry.fly.io/dissertation-workbench:worker-latest';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

  try {
    const payload = buildFlyWorkerMachinePayload({
      image: 'registry.fly.io/dissertation-workbench:deployment-123',
      jobId: 43,
      token: 'secret-token',
      timeoutMs: 12345,
      jobType: 'bertopic',
    });

    assert.equal(payload.config.image, 'registry.fly.io/dissertation-workbench:worker-latest');
    assert.deepEqual(payload.config.init.exec, ['python3', 'scripts/build-topics.py']);
    assert.equal(payload.config.env.ANTHROPIC_API_KEY, 'test-anthropic-key');
    assert.equal(payload.config.env.HF_HUB_OFFLINE, '1');
    assert.equal(payload.config.env.TRANSFORMERS_OFFLINE, '1');
    assert.equal(payload.config.guest.memory_mb >= 2048, true);
  } finally {
    if (previousBertopicImage === undefined) delete process.env.BERTOPIC_WORKER_IMAGE;
    else process.env.BERTOPIC_WORKER_IMAGE = previousBertopicImage;
    if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
  }
});

test('topic label Fly worker payload uses labeler image and labels-only command', () => {
  const previousLabelerImage = process.env.LABELER_WORKER_IMAGE;
  process.env.LABELER_WORKER_IMAGE = 'registry.fly.io/dissertation-workbench:labeler-latest';

  try {
    const payload = buildFlyWorkerMachinePayload({
      image: 'registry.fly.io/dissertation-workbench:deployment-123',
      jobId: 44,
      token: 'secret-token',
      timeoutMs: 12345,
      jobType: 'topic_labels',
    });

    assert.equal(payload.config.image, 'registry.fly.io/dissertation-workbench:labeler-latest');
    assert.deepEqual(payload.config.init.exec, ['python3', 'scripts/build-topics.py', '--labels-only']);
    assert.equal(payload.config.env.LOCAL_LABEL_BACKEND, 'llama_cpp');
    assert.equal(payload.config.env.LOCAL_LABEL_MODEL_PATH, '/app/models/qwen2.5-1.5b-instruct-q4.gguf');
    assert.equal(payload.config.guest.memory_mb >= 2048, true);
  } finally {
    if (previousLabelerImage === undefined) delete process.env.LABELER_WORKER_IMAGE;
    else process.env.LABELER_WORKER_IMAGE = previousLabelerImage;
  }
});

test('PatternRank concept rebuild Fly worker payload uses Python NLP worker', () => {
  const previousBertopicImage = process.env.BERTOPIC_WORKER_IMAGE;
  process.env.BERTOPIC_WORKER_IMAGE = 'registry.fly.io/dissertation-workbench:worker-latest';

  try {
    const payload = buildFlyWorkerMachinePayload({
      image: 'registry.fly.io/dissertation-workbench:deployment-123',
      jobId: 45,
      token: 'secret-token',
      timeoutMs: 12345,
      jobType: 'concept_rebuild',
    });

    assert.equal(payload.config.image, 'registry.fly.io/dissertation-workbench:worker-latest');
    assert.deepEqual(payload.config.init.exec, ['python3', 'scripts/build-concepts.py']);
    assert.equal(payload.config.env.ADMIN_JOB_ID, '45');
    assert.equal(payload.config.env.ADMIN_JOB_ARTIFACT_TOKEN, 'secret-token');
    assert.equal(payload.config.env.HF_HUB_OFFLINE, '1');
    assert.equal(payload.config.env.TRANSFORMERS_OFFLINE, '1');
    assert.equal(payload.config.guest.memory_mb >= 2048, true);
  } finally {
    if (previousBertopicImage === undefined) delete process.env.BERTOPIC_WORKER_IMAGE;
    else process.env.BERTOPIC_WORKER_IMAGE = previousBertopicImage;
  }
});

test('topic label candidates can be reviewed, selected, edited, unlocked, and bulk-published', async () => {
  await ensureStorage();
  const db = await getDb();
  const suffix = Date.now();
  await db.execute({
    sql: 'INSERT OR REPLACE INTO topics (topic_id, label, top_terms, doc_count, model_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    args: [7001, 'Old Label', JSON.stringify([['teacher', 0.9], ['identity', 0.8]]), 12, 'test-model', new Date().toISOString()],
  });
  await db.execute({
    sql: 'INSERT INTO topic_label_runs (backend, model_name, status, config_json, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)',
    args: ['test', 'test-model', 'completed', '{}', new Date().toISOString(), new Date().toISOString()],
  });
  const runId = Number((await db.execute('SELECT MAX(id) AS id FROM topic_label_runs')).rows[0].id);
  await db.execute({
    sql: `INSERT INTO topic_label_candidates
      (run_id, topic_id, label, source, score, status, warnings_json, evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [runId, 7001, `Teacher Identity Practice ${suffix}`, 'qwen', 95, 'pending', '[]', '{}', new Date().toISOString()],
  });
  const candidateId = Number((await db.execute('SELECT MAX(id) AS id FROM topic_label_candidates')).rows[0].id);

  let review = await listTopicLabelReviews();
  let topic = review.topics.find((item) => item.topicId === 7001);
  assert.equal(topic.label, 'Old Label');
  assert.equal(topic.candidates.length, 1);

  await selectTopicLabelCandidate(7001, candidateId);
  topic = (await listTopicLabelReviews()).topics.find((item) => item.topicId === 7001);
  assert.equal(topic.label, `Teacher Identity Practice ${suffix}`);
  assert.equal(topic.override.source, 'selected');

  await updateTopicManualLabel(7001, `Manual Topic Label ${suffix}`);
  topic = (await listTopicLabelReviews()).topics.find((item) => item.topicId === 7001);
  assert.equal(topic.label, `Manual Topic Label ${suffix}`);
  assert.equal(topic.override.source, 'manual');

  assert.equal(await deleteTopicLabelOverride(7001), true);
  review = await listTopicLabelReviews();
  topic = review.topics.find((item) => item.topicId === 7001);
  assert.equal(topic.override, null);

  await publishPassingTopicLabels();
  topic = (await listTopicLabelReviews()).topics.find((item) => item.topicId === 7001);
  assert.equal(topic.label, `Teacher Identity Practice ${suffix}`);
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

test('claimed job updates require the current execution lease and a running status', async () => {
  const jobId = await createAdminJob({
    type: 'lease_fence_test',
    label: 'Lease fence test',
    timeoutAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const claimed = await claimAdminJob(jobId, 'runner-a', 'execution-a');
  assert.equal(claimed.executionId, 'execution-a');

  assert.equal(await updateClaimedAdminJobProgress(jobId, 'execution-stale', {
    phase: 'stale', currentTask: 'Stale worker',
  }), false);
  assert.equal((await getAdminJob(jobId)).progress, null);

  assert.equal(await updateClaimedAdminJobProgress(jobId, 'execution-a', {
    phase: 'owned', currentTask: 'Current worker',
  }), true);
  assert.equal((await getAdminJob(jobId)).progress.phase, 'owned');

  const cancelledAt = new Date().toISOString();
  await finishAdminJob(jobId, {
    status: 'cancelled', runnerState: 'cancelled', cancelledAt, finishedAt: cancelledAt,
  });
  assert.equal(await finishClaimedAdminJob(jobId, 'execution-a', {
    status: 'completed', runnerState: 'completed', result: { late: true },
  }), false);
  assert.equal(await updateClaimedAdminJobProgress(jobId, 'execution-a', {
    phase: 'late_success', currentTask: 'Late success',
  }), false);
  const terminal = await getAdminJob(jobId);
  assert.equal(terminal.status, 'cancelled');
  assert.equal(terminal.result, null);
  assert.equal(terminal.progress.phase, 'owned');
  assert.equal(terminal.executionId, null);
});

test('stale-job reaper wins its CAS against a late worker completion', async () => {
  const jobId = await createAdminJob({
    type: 'reaper_lease_race_test',
    label: 'Reaper lease race',
    timeoutAt: new Date(Date.now() - 1_000).toISOString(),
  });
  await claimAdminJob(jobId, 'late-runner', 'late-execution');

  assert.equal(await hasRunningAdminJob('reaper_lease_race_test'), null);
  assert.equal(await finishClaimedAdminJob(jobId, 'late-execution', {
    status: 'completed', result: { shouldNotPublish: true }, runnerState: 'completed',
  }), false);
  const job = await getAdminJob(jobId);
  assert.equal(job.status, 'timed_out');
  assert.equal(job.result, null);
  assert.equal(job.executionId, null);
});

test('terminal failure publication survives cleanup failures and reports them separately', async () => {
  const { publishTerminalFailure } = await import('../src/services/workerLifecycle.js');
  const events = [];
  const result = await publishTerminalFailure({
    finish: async (patch) => {
      events.push(['finish', patch.status]);
      return true;
    },
    failRollout: async () => { throw new Error('rollout cleanup exploded'); },
    appendLog: async () => { throw new Error('terminal log exploded'); },
    onCleanupError: async (context, error) => events.push(['cleanup', context, error.message]),
  }, { error: new Error('worker exploded'), status: 'failed' });

  assert.deepEqual(events[0], ['finish', 'failed']);
  assert.equal(result.published, true);
  assert.equal(result.cleanupErrors.length, 2);
  assert.match(events[1][2], /rollout cleanup exploded/);
  assert.match(events[2][2], /terminal log exploded/);
});

test('worker child termination escalates from SIGTERM to SIGKILL after the grace bound', async () => {
  const { terminateChild } = await import('../src/services/workerLifecycle.js');
  class FakeChild extends EventEmitter {
    exitCode = null;
    signalCode = null;
    signals = [];
    kill(signal) {
      this.signals.push(signal);
      if (signal === 'SIGKILL') {
        this.signalCode = signal;
        queueMicrotask(() => this.emit('close', null, signal));
      }
      return true;
    }
  }
  const child = new FakeChild();
  await terminateChild(child, { graceMs: 5, forceWaitMs: 20 });
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('worker child termination does not signal a child that already exited', async () => {
  const { terminateChild } = await import('../src/services/workerLifecycle.js');
  const child = {
    exitCode: 0,
    signalCode: null,
    kill() {
      throw new Error('kill must not be called for an exited child');
    },
  };
  await terminateChild(child, { graceMs: 5, forceWaitMs: 5 });
});

test('legacy BERTopic runner completes and fails through its claimed execution lease', async () => {
  class FakeChild extends EventEmitter {
    exitCode = null;
    signalCode = null;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    kill() { return true; }
  }

  const successfulJobId = await createAdminJob({
    type: 'bertopic', label: 'Legacy BERTopic success', timeoutAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const successfulChild = new FakeChild();
  let childEnv;
  assert.equal(await runBertopicJob(successfulJobId, {
    spawnProcess: (_command, _args, options) => {
      childEnv = options.env;
      return successfulChild;
    },
    getStatus: async () => ({ topics: 12 }),
  }), successfulChild);
  const claimed = await getAdminJob(successfulJobId);
  assert.equal(childEnv.ADMIN_JOB_ID, String(successfulJobId));
  assert.equal(childEnv.ADMIN_JOB_EXECUTION_ID, claimed.executionId);
  successfulChild.emit('close', 0, null);
  await waitFor(async () => (await getAdminJob(successfulJobId)).status === 'completed');
  assert.deepEqual((await getAdminJob(successfulJobId)).result, { topics: 12 });

  const failedJobId = await createAdminJob({
    type: 'bertopic', label: 'Legacy BERTopic failure', timeoutAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const failedChild = new FakeChild();
  await runBertopicJob(failedJobId, { spawnProcess: () => failedChild });
  failedChild.emit('close', 2, null);
  await waitFor(async () => (await getAdminJob(failedJobId)).status === 'failed');
  assert.match((await getAdminJob(failedJobId)).error, /code 2/);

  const preclaimedJobId = await createAdminJob({
    type: 'bertopic', label: 'Legacy BERTopic preclaimed', timeoutAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await claimAdminJob(preclaimedJobId, 'calling-runner', 'caller-execution');
  const preclaimedChild = new FakeChild();
  await runBertopicJob(preclaimedJobId, {
    spawnProcess: () => preclaimedChild,
    executionId: 'caller-execution',
    getStatus: async () => ({ reusedLease: true }),
  });
  assert.equal((await getAdminJob(preclaimedJobId)).executionId, 'caller-execution');
  preclaimedChild.emit('close', 0, null);
  await waitFor(async () => (await getAdminJob(preclaimedJobId)).status === 'completed');
});

test('legacy BERTopic cancellation wins over a late successful child close', async () => {
  class FakeChild extends EventEmitter {
    exitCode = null;
    signalCode = null;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    kill() { return true; }
  }

  const jobId = await createAdminJob({
    type: 'bertopic', label: 'Legacy BERTopic cancellation race', timeoutAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const child = new FakeChild();
  let cacheClears = 0;
  await runBertopicJob(jobId, {
    spawnProcess: () => child,
    clearMetricsCache: () => { cacheClears += 1; },
    getStatus: async () => ({ shouldNotPublish: true }),
  });

  assert.equal((await cancelAdminWorkerJob(jobId)).ok, true);
  child.emit('close', 0, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const job = await getAdminJob(jobId);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.result, null);
  assert.equal(job.executionId, null);
  assert.equal(cacheClears, 0);
});

test('legacy BERTopic timeout terminates the child through the guarded escalation lifecycle', async () => {
  class FakeChild extends EventEmitter {
    exitCode = null;
    signalCode = null;
    signals = [];
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    kill(signal) {
      this.signals.push(signal);
      if (signal === 'SIGKILL') {
        this.signalCode = signal;
        queueMicrotask(() => this.emit('close', null, signal));
      }
      return true;
    }
  }
  const child = new FakeChild();
  const jobId = await createAdminJob({
    type: 'bertopic', label: 'Legacy BERTopic timeout race', timeoutAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await runBertopicJob(jobId, {
    spawnProcess: () => child,
    timeoutMs: 5,
    terminationGraceMs: 5,
    terminationForceWaitMs: 20,
  });

  await waitFor(async () => (await getAdminJob(jobId)).status === 'timed_out', 250);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  const job = await getAdminJob(jobId);
  assert.equal(job.executionId, null);
  assert.match(job.error, /timed out/i);
});

test('legacy BERTopic timeout wins over a late successful child close', async () => {
  class FakeChild extends EventEmitter {
    exitCode = null;
    signalCode = null;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    kill() { return true; }
  }

  const jobId = await createAdminJob({
    type: 'bertopic', label: 'Legacy BERTopic timeout close race', timeoutAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const child = new FakeChild();
  await runBertopicJob(jobId, {
    spawnProcess: () => child,
    timeoutMs: 5,
    // Keep the process alive until after the terminal timeout is committed.
    terminate: async () => {},
    getStatus: async () => ({ shouldNotPublish: true }),
  });

  await waitFor(async () => (await getAdminJob(jobId)).status === 'timed_out');
  child.emit('close', 0, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const job = await getAdminJob(jobId);
  assert.equal(job.status, 'timed_out');
  assert.equal(job.result, null);
  assert.equal(job.executionId, null);
});

test('cancelled YAZ lookup does not signal a child that has already exited', async () => {
  class FakeChild extends EventEmitter {
    exitCode = 0;
    signalCode = null;
    signals = [];
    stdout = new EventEmitter();
    stdin = { write() {}, end() {} };
    kill(signal) {
      this.signals.push(signal);
      return true;
    }
  }
  const child = new FakeChild();
  const controller = new AbortController();
  const result = runYazClient('quit\n', {
    signal: controller.signal,
    spawnProcess: () => child,
    terminationGraceMs: 5,
  });
  controller.abort();

  await assert.rejects(result, CatalogueLookupCancelledError);
  assert.deepEqual(child.signals, []);
});

test('timed-out YAZ lookup escalates when SIGTERM does not produce exit evidence', async () => {
  class FakeChild extends EventEmitter {
    exitCode = null;
    signalCode = null;
    signals = [];
    stdout = new EventEmitter();
    stdin = { write() {}, end() {} };
    kill(signal) {
      this.signals.push(signal);
      if (signal === 'SIGKILL') {
        this.signalCode = signal;
        queueMicrotask(() => this.emit('close', null, signal));
      }
      return true;
    }
  }
  const child = new FakeChild();
  await assert.rejects(
    runYazClient('quit\n', {
      timeoutMs: 5,
      spawnProcess: () => child,
      terminationGraceMs: 5,
      terminationForceWaitMs: 20,
    }),
    (error) => error?.code === 'YAZ_TIMEOUT',
  );
  await waitFor(() => child.signals.length === 2, 250);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('expired running admin jobs are timed out before they block new jobs', async () => {
  await ensureStorage();
  const token = `expired-worker-token-${Date.now()}`;
  const jobId = await createAdminJob({
    type: 'reparse_all',
    label: 'Expired Worker Test',
    params: {},
    artifactTokenHash: hashAdminJobToken(token),
    timeoutAt: new Date(Date.now() - 60_000).toISOString(),
    runnerType: 'fly',
  });

  assert.equal(await hasRunningAdminJob('reparse_all'), null);

  const job = await getAdminJob(jobId);
  assert.equal(job.status, 'timed_out');
  assert.equal(job.runnerState, 'timed_out');
  assert.match(job.error, /timed out|heartbeating/i);
  assert.equal(await validateAdminJobArtifactToken(jobId, token), false);
});

test('in-process catalogue lookup jobs can be cancelled cooperatively', async () => {
  await ensureStorage();
  const jobId = await createAdminJob({
    type: 'catalogue_lookup',
    label: 'Catalogue Cancel Test',
    params: { limit: 5, pendingOnly: true },
  });
  let abortSeen = false;
  let lookupStartedResolve;
  const lookupStarted = new Promise((resolve) => { lookupStartedResolve = resolve; });

  runCatalogueLookupJob(jobId, 5, {
    runLookup: ({ signal }) => new Promise((resolve, reject) => {
      lookupStartedResolve();
      signal.addEventListener('abort', () => {
        abortSeen = true;
        reject(new CatalogueLookupCancelledError());
      }, { once: true });
    }),
  });

  await lookupStarted;
  const result = await cancelInProcessAdminJob(jobId);

  assert.equal(result.ok, true);
  assert.equal(result.cancelled, true);
  assert.equal(abortSeen, true);

  const job = await getAdminJob(jobId);
  assert.equal(job.status, 'cancelled');
  assert.ok(job.cancelledAt);
  assert.ok(job.finishedAt);
  assert.match(job.log, /cancelled by administrator/i);
});

test('in-process cancellation cannot overwrite a completion that wins its terminal CAS race', async () => {
  await ensureStorage();
  const jobId = await createAdminJob({
    type: 'catalogue_lookup',
    label: 'Catalogue Completion Race Test',
    params: { limit: 5, pendingOnly: true },
  });
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  let releaseLookup;
  const lookupReleased = new Promise((resolve) => { releaseLookup = resolve; });

  runCatalogueLookupJob(jobId, 5, {
    runLookup: async () => {
      startedResolve();
      await lookupReleased;
      return { processed: 0, found: 0, notFound: 0, skipped: 0, failed: 0 };
    },
  });

  await started;
  let reads = 0;
  const result = await cancelInProcessAdminJob(jobId, {
    getJob: async (id) => {
      reads += 1;
      if (reads === 1) {
        const current = await getAdminJob(id);
        await finishClaimedAdminJob(id, current.executionId, {
          status: 'completed',
          runnerState: 'completed',
          result: { raced: true },
        });
        return { ...current, status: 'running', finishedAt: null };
      }
      return getAdminJob(id);
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /reached completed/i);
  const job = await getAdminJob(jobId);
  assert.equal(job.status, 'completed');
  assert.equal(job.runnerState, 'completed');
  assert.equal(job.cancelledAt, null);
  releaseLookup();
  const { isAdminJobRunning } = await import('../src/services/adminJobs.js');
  await waitFor(() => !isAdminJobRunning('catalogue_lookup'));
});

test('in-process catalogue lookup jobs publish heartbeat and progress', async () => {
  await ensureStorage();
  const jobId = await createAdminJob({
    type: 'catalogue_lookup',
    label: 'Catalogue Progress Test',
    params: { limit: 5, pendingOnly: true },
  });

  runCatalogueLookupJob(jobId, 5, {
    runLookup: async ({ onProgress }) => {
      await onProgress({
        phase: 'lookup',
        detail: 'Testing progress update',
        page: 1,
        pageProcessed: 3,
        pageTotal: 5,
        pageSize: 5,
        stats: { processed: 3, found: 1, notFound: 1, skipped: 0, failed: 1 },
      });
      return { processed: 5, found: 2, notFound: 2, skipped: 0, failed: 1 };
    },
  });

  await waitFor(async () => (await getAdminJob(jobId))?.status === 'completed');
  const job = await getAdminJob(jobId);
  assert.equal(job.runnerType, 'in_process');
  assert.match(job.runnerId, /^web:/);
  assert.equal(job.runnerState, 'completed');
  assert.ok(job.claimedAt);
  assert.ok(job.heartbeatAt);
  assert.equal(job.result.processed, 5);
  assert.equal(job.result.failed, 1);
  assert.equal(job.progress.phase, 'complete');
  assert.equal(job.progress.counts.found, 2);
  assert.equal(job.progress.counts.failed, 1);
  assert.match(job.log, /Catalogue lookup completed/i);
});

test('transient YAZ failures are not saved as completed catalogue lookups', async () => {
  await ensureStorage();
  await clearAllCitations();
  const docId = `catalogue-transient-${Date.now()}`;
  const citationText = 'Bakke, E. Wight. (1950). Bonds of organization.';
  await saveDocumentMetadata({
    id: docId,
    title: 'Catalogue Transient Fixture',
    author: 'Worker Tester',
    supervisors: [],
  });
  await saveCitations(docId, [{
    text: citationText,
    author: 'Bakke',
    title: 'Bonds of organization',
    year: '1950',
  }], () => `catalogue-transient-hash-${docId}`);

  const [pending] = await listPendingLookups(1);
  assert.ok(pending?.id);

  const stats = await runPendingCatalogueLookups({
    pageSize: 1,
    isYazAvailable: async () => true,
    lookupBatch: async () => [{
      found: null,
      hits: null,
      author: 'Bakke',
      title: 'Bonds of organization',
      error: 'yaz-client timed out',
      transient: true,
    }],
  });

  assert.deepEqual(stats, { processed: 1, found: 0, notFound: 0, skipped: 0, failed: 1 });
  assert.equal(await loadCatalogueLookup(pending.id), null);
});

test('citation extraction checkpoints are content-versioned and scope-aware', async () => {
  await ensureStorage();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const selectedId = `citation-scope-selected-${suffix}`;
  const excludedId = `citation-scope-excluded-${suffix}`;
  const degree = `Citation Scope ${suffix}`;
  await saveDocumentMetadata({
    id: selectedId,
    title: 'Selected Citation Extraction Fixture',
    author: 'Worker Tester',
    degree,
    supervisors: [],
  }, { syncKey: `citation-sync-${suffix}` });
  await saveDocumentMetadata({
    id: excludedId,
    title: 'Excluded Citation Extraction Fixture',
    author: 'Worker Tester',
    degree: `Other ${suffix}`,
    supervisors: [],
  });
  await saveFileMetric(selectedId, {
    status: 'full_text',
    fullTextPath: `/cached/${selectedId}.txt`,
    contentChecksum: 'citation-checksum-v1',
  });
  await saveFileMetric(excludedId, {
    status: 'full_text',
    fullTextPath: `/cached/${excludedId}.txt`,
    contentChecksum: 'excluded-checksum-v1',
  });

  let pending = await listPendingCitationExtractions({
    limit: 10,
    filters: { degree },
    parserVersion: 'citation-test-v1',
  });
  assert.deepEqual(pending.map((row) => row.doc_id), [selectedId]);

  await saveCitationExtractionState(selectedId, {
    contentChecksum: 'citation-checksum-v1',
    parserVersion: 'citation-test-v1',
    status: 'completed',
    citationCount: 3,
  });
  pending = await listPendingCitationExtractions({
    limit: 10,
    filters: { degree },
    parserVersion: 'citation-test-v1',
  });
  assert.equal(pending.length, 0);

  await saveFileMetric(selectedId, {
    status: 'full_text',
    fullTextPath: `/cached/${selectedId}.txt`,
    contentChecksum: 'citation-checksum-v2',
  });
  pending = await listPendingCitationExtractions({
    limit: 10,
    filters: { degree },
    parserVersion: 'citation-test-v1',
  });
  assert.deepEqual(pending.map((row) => row.doc_id), [selectedId]);

  await saveCitations(selectedId, [{
    text: `Selected citation ${suffix}`,
    author: 'Selected',
    title: `Selected scoped work ${suffix}`,
    year: '2024',
  }], (text) => `selected-${text}`);
  await saveCitations(excludedId, [{
    text: `Excluded citation ${suffix}`,
    author: 'Excluded',
    title: `Excluded scoped work ${suffix}`,
    year: '2023',
  }], (text) => `excluded-${text}`);
  const scopedLookups = await listPendingLookups({ limit: 10, filters: { degree } });
  assert.deepEqual(scopedLookups.map((row) => row.citation_text), [`Selected citation ${suffix}`]);
  assert.equal(await countPendingLookups({ filters: { degree } }), 1);
});

test('strict citation extraction propagates failures instead of creating a completed checkpoint', async () => {
  const docId = `strict-citation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await assert.rejects(
    extractAndSaveParsedData({ id: docId, supervisors: [] }, 'References\nA citation entry.', null, {
      extractCommittee: false,
      extractCitations: true,
      strictCitationErrors: true,
      onProgress: async (event) => {
        if (event.phase === 'citation_extraction' && event.status === 'completed') {
          throw new Error('simulated citation persistence failure');
        }
      },
    }),
    /simulated citation persistence failure/
  );
});

test('incremental PatternRank reuses checkpoints and rebuilds changed documents only', async () => {
  await ensureStorage();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const degree = `PatternRank Fixture ${suffix}`;
  const baseDocument = {
    author: 'Worker Tester',
    degree,
    year: 2025,
    abstract: 'Community learning leadership supports community learning leadership across schools.',
    subjects: ['community learning leadership'],
    supervisors: [],
  };
  await saveDocumentMetadata({ ...baseDocument, id: `patternrank-a-${suffix}`, title: 'Community Learning Leadership A' });
  await saveDocumentMetadata({ ...baseDocument, id: `patternrank-b-${suffix}`, title: 'Community Learning Leadership B' });

  async function runPatternRank() {
    const jobId = await createAdminJob({
      type: 'concept_rebuild',
      label: 'PatternRank Incremental Test',
      params: { scope: { degree }, method: 'patternrank_incremental' },
      runnerType: 'local',
    });
    await execFileAsync('python3', ['scripts/build-concepts.py'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        ADMIN_JOB_ID: String(jobId),
        NODE_ENV: 'test',
        CONCEPT_EMBEDDING_BACKEND: 'deterministic_test',
        CONCEPT_PATTERNRANK_MIN_SCORE: '-1',
      },
    });
    return getAdminJob(jobId);
  }

  const first = await runPatternRank();
  assert.equal(first.status, 'completed');
  assert.equal(first.result.documentsChanged, 2);
  assert.equal(first.result.documentsReused, 0);
  assert.equal(first.result.partitionVersion, 1);
  assert.match(first.result.partition, /^custom-/);

  const second = await runPatternRank();
  assert.equal(second.status, 'completed');
  assert.equal(second.result.noChanges, true);

  await (await getDb()).execute({
    sql: "UPDATE concept_partitions SET status = 'running' WHERE partition_key = ?",
    args: [first.result.partition],
  });
  const resumed = await runPatternRank();
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.result.documentsChanged, 0);
  assert.equal(resumed.result.documentsReused, 2);
  assert.equal(resumed.result.partitionVersion, 2);

  await saveDocumentMetadata({
    ...baseDocument,
    id: `patternrank-a-${suffix}`,
    title: 'Community Learning Leadership A Revised',
  });
  const third = await runPatternRank();
  assert.equal(third.status, 'completed');
  assert.equal(third.result.documentsChanged, 1);
  assert.equal(third.result.documentsReused, 1);
  assert.equal(third.result.partitionVersion, 3);
});

test('automatic PatternRank publishes only a complete generation and reconciles retired shards', async () => {
  const autoDir = await fs.mkdtemp(path.join(testDataDir, 'patternrank-auto-'));
  const sqlitePath = path.join(autoDir, 'metrics.sqlite');
  const latestPath = path.join(autoDir, 'concepts', 'latest.json');
  // Two different *degrees* (not two years of the same degree): the automatic
  // partition family groups by (degree, decade) by default (#21), so two years
  // of one degree now collapse into a single cohort and would publish after just
  // one run, defeating this test's whole point (multi-cohort gating/retirement).
  // Two degrees in the same decade keep two distinct cohorts under either grouping.
  const setup = `
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE documents (doc_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL, degree TEXT, year INTEGER, updated_at TEXT NOT NULL)")
for degree, year in (("Auto Degree Alpha", 2024), ("Auto Degree Beta", 2025)):
    doc = {"id": f"auto-{degree.split()[-1].lower()}", "title": "Community Learning Leadership", "abstract": "Community learning leadership supports schools.", "subjects": ["community learning leadership"], "degree": degree, "year": year}
    db.execute("INSERT INTO documents VALUES (?, ?, ?, ?, ?)", (doc["id"], json.dumps(doc), doc["degree"], year, "2026-01-01T00:00:00+00:00"))
db.commit()
`;
  await execFileAsync('python3', ['-c', setup, sqlitePath]);
  const env = {
    ...process.env,
    SQLITE_PATH: sqlitePath,
    APP_DATA_DIR: autoDir,
    TURSO_DATABASE_URL: '',
    ADMIN_JOB_ID: '',
    NODE_ENV: 'test',
    CONCEPT_EMBEDDING_BACKEND: 'deterministic_test',
    CONCEPT_PATTERNRANK_MIN_SCORE: '-1',
  };
  const run = () => execFileAsync('python3', ['scripts/build-concepts.py'], { cwd: path.resolve('.'), env });

  await run();
  await assert.rejects(fs.access(latestPath));
  await run();
  await assert.rejects(fs.access(latestPath));
  const conceptsPath = path.join(autoDir, 'concepts');
  await fs.writeFile(conceptsPath, 'block publication', 'utf8');
  let publicationFailed = false;
  for (let attempt = 0; attempt < 5 && !publicationFailed; attempt += 1) {
    try { await run(); } catch { publicationFailed = true; }
  }
  assert.equal(publicationFailed, true);
  await fs.unlink(conceptsPath);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await run();
    try { await fs.access(latestPath); break; } catch { /* next invalidated shard */ }
  }
  let artifact = JSON.parse(await fs.readFile(latestPath, 'utf8'));
  assert.equal(artifact.source.documents, 2);
  assert.equal(artifact.source.partitions.every((partition) => partition.key.startsWith('auto-')), true);
  assert.equal(artifact.concepts.some((concept) => concept.canonical === 'community learning leadership'), true);

  await fs.unlink(latestPath);
  await execFileAsync('python3', ['-c', 'import sqlite3, sys; db=sqlite3.connect(sys.argv[1]); db.execute("DELETE FROM concept_publication_state"); db.commit()', sqlitePath]);
  await run();
  artifact = JSON.parse(await fs.readFile(latestPath, 'utf8'));
  assert.equal(artifact.source.documents, 2);

  await execFileAsync('python3', ['-c', 'import sqlite3, sys; db=sqlite3.connect(sys.argv[1]); db.execute("DELETE FROM documents WHERE degree = ?", ("Auto Degree Alpha",)); db.commit()', sqlitePath]);
  await run();
  artifact = JSON.parse(await fs.readFile(latestPath, 'utf8'));
  assert.equal(artifact.source.documents, 1);
  assert.equal(artifact.concepts.some((concept) => concept.canonical === 'community learning leadership'), false);

  await execFileAsync('python3', ['-c', 'import sqlite3, sys; db=sqlite3.connect(sys.argv[1]); db.execute("DELETE FROM documents"); db.commit()', sqlitePath]);
  const invalidDataRoot = path.join(autoDir, 'invalid-data-root');
  await fs.writeFile(invalidDataRoot, 'not a directory', 'utf8');
  await assert.rejects(execFileAsync('python3', ['scripts/build-concepts.py'], {
    cwd: path.resolve('.'),
    env: { ...env, APP_DATA_DIR: invalidDataRoot },
  }));
  await run();
  artifact = JSON.parse(await fs.readFile(latestPath, 'utf8'));
  assert.equal(artifact.source.documents, 0);
});

// Regression cover for finding N-01: the partitioned rework shipped `variants: []`,
// `variantToCanonical: {}` and `aliases: 0` hardcoded, so plural forms, token
// reorderings and morphological head variants each became their own concept and
// fragmented every document-frequency count downstream.
test('PatternRank clusters phrase variants and publishes a populated alias map', async () => {
  const aliasDir = await fs.mkdtemp(path.join(testDataDir, 'patternrank-alias-'));
  const sqlitePath = path.join(aliasDir, 'metrics.sqlite');
  const latestPath = path.join(aliasDir, 'concepts', 'latest.json');
  const setup = `
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE documents (doc_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL, degree TEXT, year INTEGER, updated_at TEXT NOT NULL)")
for year in (2024, 2025):
    doc = {
        "id": f"alias-{year}",
        # "learning communities" / "learning community" differ only by plural (R1),
        # "educational leadership" / "educational leader" only by head form (R2).
        "title": "Learning Communities and Educational Leadership",
        "abstract": "Learning community practice supports educational leader growth.",
        "subjects": ["learning communities"],
        "degree": "Alias Degree",
        "year": year,
    }
    db.execute("INSERT INTO documents VALUES (?, ?, ?, ?, ?)", (doc["id"], json.dumps(doc), doc["degree"], year, "2026-01-01T00:00:00+00:00"))
db.commit()
`;
  await execFileAsync('python3', ['-c', setup, sqlitePath]);
  const env = {
    ...process.env,
    SQLITE_PATH: sqlitePath,
    APP_DATA_DIR: aliasDir,
    TURSO_DATABASE_URL: '',
    ADMIN_JOB_ID: '',
    NODE_ENV: 'test',
    CONCEPT_EMBEDDING_BACKEND: 'deterministic_test',
    CONCEPT_PATTERNRANK_MIN_SCORE: '-1',
  };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await execFileAsync('python3', ['scripts/build-concepts.py'], { cwd: path.resolve('.'), env });
    try { await fs.access(latestPath); break; } catch { /* generation still incomplete */ }
  }
  const artifact = JSON.parse(await fs.readFile(latestPath, 'utf8'));

  // The alias map is genuinely populated, not the hardcoded empty object.
  assert.ok(Object.keys(artifact.variantToCanonical).length > 0);
  assert.equal(artifact.stats.aliases, Object.keys(artifact.variantToCanonical).length);
  assert.ok(artifact.concepts.some((concept) => concept.variants.length > 0));

  // R1: plural form folds into the singular canonical.
  assert.equal(artifact.variantToCanonical['learning communities'], 'learning community');
  // R2: morphologically related head folds into the stronger head form.
  assert.equal(artifact.variantToCanonical['educational leader'], 'educational leadership');

  // The point of the fix: both shards' documents land on one concept instead of
  // being split across a singular and a plural entry with half the docFreq each.
  const community = artifact.concepts.find((concept) => concept.canonical === 'learning community');
  assert.ok(community);
  assert.equal(community.docFreq, 2);
  assert.ok(community.variants.includes('learning communities'));
  assert.equal(artifact.concepts.some((concept) => concept.canonical === 'learning communities'), false);

  // concepts[].variants, variantToCanonical and stats.aliases must agree exactly, and
  // no surviving canonical may also be a variant key — src/metrics.js resolves
  // variantMap before canonicalSet, so such a phrase would lose its own entry.
  const projected = {};
  for (const concept of artifact.concepts) {
    for (const variant of concept.variants) projected[variant] = concept.canonical;
  }
  assert.deepEqual(projected, artifact.variantToCanonical);
  const canonicals = new Set(artifact.concepts.map((concept) => concept.canonical));
  for (const [variant, canonical] of Object.entries(artifact.variantToCanonical)) {
    assert.ok(canonicals.has(canonical));
    assert.equal(canonicals.has(variant), false);
  }
});

test('PatternRank merge resolves cross-shard variant collisions deterministically', async () => {
  const mergeDir = await fs.mkdtemp(path.join(testDataDir, 'patternrank-merge-'));
  const harnessPath = path.join(mergeDir, 'merge_harness.py');
  await fs.writeFile(harnessPath, `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('build_concepts', sys.argv[1])
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)
client = bc.SqliteClientWrapper(sys.argv[2])
bc.ensure_incremental_schema(client)
for shard in json.loads(sys.argv[3]):
    documents = shard["artifact"]["stats"]["documents"]
    client.execute(
        "INSERT OR REPLACE INTO concept_partitions (partition_key, scope_json, priority, enabled,"
        " status, source_document_count, artifact_version, updated_at)"
        " VALUES (?, '{}', ?, 1, 'complete', ?, 1, '2026-01-01T00:00:00+00:00')",
        [shard["key"], shard["priority"], documents],
    )
    client.execute(
        "INSERT OR REPLACE INTO concept_partition_artifacts (partition_key, version, artifact_json,"
        " document_count, created_at) VALUES (?, 1, ?, ?, '2026-01-01T00:00:00+00:00')",
        [shard["key"], json.dumps(shard["artifact"]), documents],
    )
merged = bc.merge_partition_artifacts(client)
print(json.dumps({
    "concepts": [[c["canonical"], c["variants"], c["docFreq"]] for c in merged["concepts"]],
    "variantToCanonical": merged["variantToCanonical"],
    "aliases": merged["stats"]["aliases"],
}, sort_keys=True))
`, 'utf8');

  const shard = (key, canonical, variants, docFreq, score) => ({
    key,
    artifact: {
      stats: { documents: 10 },
      partition: { key },
      concepts: [{ canonical, variants, docFreq, patternRankScore: score }],
    },
  });
  // The collision: "student engagements" is a variant of "student engagement" in one
  // shard but a canonical in its own right in another, and "student engaging" is
  // claimed by two different canonicals in two more shards.
  const shards = [
    shard('p-alpha', 'student engagement', ['student engagements'], 6, 0.9),
    shard('p-beta', 'student engagements', ['student engaging'], 4, 0.7),
    shard('p-gamma', 'learner engagement', ['student engaging'], 3, 0.5),
  ];

  const runMerge = async (priorities) => {
    const dbPath = path.join(mergeDir, `merge-${priorities.join('-')}.sqlite`);
    const payload = shards.map((entry, index) => ({ ...entry, priority: priorities[index] }));
    const { stdout } = await execFileAsync(
      'python3',
      [harnessPath, path.resolve('scripts/build-concepts.py'), dbPath, JSON.stringify(payload)],
      { cwd: path.resolve('.') },
    );
    return JSON.parse(stdout);
  };

  // Every shard ordering must produce byte-identical output: the merge resolves each
  // connected component of (variant -> canonical) edges as a whole and elects the
  // winner by summed docFreq, then score, then phrase - never last-write-wins.
  const baseline = await runMerge([3, 2, 1]);
  for (const priorities of [[1, 2, 3], [2, 3, 1], [1, 1, 1], [3, 1, 2]]) {
    assert.deepEqual(await runMerge(priorities), baseline);
  }

  // The four colliding phrases collapse into a single concept whose docFreq is the
  // sum across the disjoint shards (6 + 4 + 3), not three fragmented entries.
  assert.deepEqual(baseline.concepts, [[
    'student engagement',
    ['learner engagement', 'student engagements', 'student engaging'],
    13,
  ]]);
  assert.deepEqual(baseline.variantToCanonical, {
    'learner engagement': 'student engagement',
    'student engagements': 'student engagement',
    'student engaging': 'student engagement',
  });
  assert.equal(baseline.aliases, 3);
});

// Shards are disjoint in documents, but a merged component routinely contains two
// phrases that both came from the SAME shard -- that is exactly what the merge
// does. Summing per-shard docFreq then counts a document that mentions both twice,
// docFreq climbs past the corpus size, and idf = log((N+1)/(df+1)) goes negative.
// src/metrics.js takes a negative idf verbatim, so score = count * idf + lengthBonus
// falls under the >= 1.2 assignment gate and the concept vanishes from every
// document.
test('PatternRank merge unions document sets across a component instead of summing counts', async () => {
  const mergeDir = await fs.mkdtemp(path.join(testDataDir, 'patternrank-docfreq-'));
  const harnessPath = path.join(mergeDir, 'docfreq_harness.py');
  await fs.writeFile(harnessPath, `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('build_concepts', sys.argv[1])
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)
client = bc.SqliteClientWrapper(sys.argv[2])
bc.ensure_incremental_schema(client)
for shard in json.loads(sys.argv[3]):
    documents = shard["artifact"]["stats"]["documents"]
    client.execute(
        "INSERT OR REPLACE INTO concept_partitions (partition_key, scope_json, priority, enabled,"
        " status, source_document_count, artifact_version, updated_at)"
        " VALUES (?, '{}', 1, 1, 'complete', ?, 1, '2026-01-01T00:00:00+00:00')",
        [shard["key"], documents],
    )
    client.execute(
        "INSERT OR REPLACE INTO concept_partition_artifacts (partition_key, version, artifact_json,"
        " document_count, created_at) VALUES (?, 1, ?, ?, '2026-01-01T00:00:00+00:00')",
        [shard["key"], json.dumps(shard["artifact"]), documents],
    )
merged = bc.merge_partition_artifacts(client)
print(json.dumps({
    "documents": merged["stats"]["documents"],
    "singleDocConcepts": merged["stats"]["singleDocConcepts"],
    "concepts": [[c["canonical"], c["docFreq"], round(c["idf"], 4)] for c in merged["concepts"]],
}, sort_keys=True))
`, 'utf8');

  const range = (start, end) => Array.from({ length: end - start }, (_, i) => start + i);
  // Three 10-document shards, 30 documents in all. "student leader(ship|s)" is one
  // concept split across shards; alpha and gamma each attest two of its phrases
  // from the same shard, which is where the double counting comes from. "solar
  // kiln"/"solar kilns" are two alpha canonicals joined only because they share the
  // variant "solar kilning" -- both live in alpha's document 9 and nowhere else, so
  // the merged concept covers exactly one document.
  const shards = [
    {
      key: 'p-alpha',
      artifact: {
        stats: { documents: 10 },
        partition: { key: 'p-alpha' },
        concepts: [
          { canonical: 'student leadership', variants: ['student leader'], docFreq: 10, docIndexes: range(0, 10), patternRankScore: 0.9 },
          { canonical: 'student leaders', variants: [], docFreq: 10, docIndexes: range(0, 10), patternRankScore: 0.8 },
          { canonical: 'solar kiln', variants: ['solar kilning'], docFreq: 1, docIndexes: [9], patternRankScore: 0.5 },
          { canonical: 'solar kilns', variants: ['solar kilning'], docFreq: 1, docIndexes: [9], patternRankScore: 0.4 },
        ],
      },
    },
    {
      key: 'p-beta',
      artifact: {
        stats: { documents: 10 },
        partition: { key: 'p-beta' },
        concepts: [
          { canonical: 'student leaders', variants: ['student leadership'], docFreq: 6, docIndexes: range(0, 6), patternRankScore: 0.7 },
        ],
      },
    },
    {
      key: 'p-gamma',
      artifact: {
        stats: { documents: 10 },
        partition: { key: 'p-gamma' },
        concepts: [
          { canonical: 'student leadership', variants: [], docFreq: 4, docIndexes: [0, 1, 2, 3], patternRankScore: 0.6 },
          { canonical: 'student leaders', variants: [], docFreq: 4, docIndexes: [3, 4, 5, 6], patternRankScore: 0.6 },
        ],
      },
    },
  ];

  const runMerge = async (payload, name) => {
    const { stdout } = await execFileAsync(
      'python3',
      [harnessPath, path.resolve('scripts/build-concepts.py'), path.join(mergeDir, `${name}.sqlite`), JSON.stringify(payload)],
      { cwd: path.resolve('.') },
    );
    return JSON.parse(stdout);
  };

  const indexed = await runMerge(shards, 'indexed');
  assert.equal(indexed.documents, 30);
  // Summing gave 14 + 20 = 34 for the student-leadership component (docFreq > 30)
  // and idf = log(31/35) = -0.1214. Unioning per shard gives 10 + 6 + 7 = 23.
  assert.deepEqual(indexed.concepts, [
    ['student leaders', 23, Number(Math.log(31 / 24).toFixed(4))],
    ['solar kiln', 1, Number(Math.log(31 / 2).toFixed(4))],
  ]);
  // Summing reported docFreq 2 for a concept that occupies a single document, so
  // this statistic missed it entirely.
  assert.equal(indexed.singleDocConcepts, 1);

  // Artifacts written before docIndexes existed still have to satisfy the
  // invariants. The merge falls back to an upper bound clamped to each shard's own
  // document count: 10 + 6 + min(4 + 4, 10) = 24 here, and 2 for the solar concept.
  const legacy = await runMerge(
    shards.map((shard) => ({
      ...shard,
      artifact: {
        ...shard.artifact,
        concepts: shard.artifact.concepts.map(({ docIndexes, ...rest }) => rest),
      },
    })),
    'legacy',
  );
  assert.deepEqual(legacy.concepts, [
    ['student leaders', 24, Number(Math.log(31 / 25).toFixed(4))],
    ['solar kiln', 2, Number(Math.log(31 / 3).toFixed(4))],
  ]);

  for (const merged of [indexed, legacy]) {
    for (const [canonical, docFreq, idf] of merged.concepts) {
      assert.ok(docFreq <= merged.documents, `${canonical} docFreq ${docFreq} > ${merged.documents}`);
      assert.ok(idf >= 0, `${canonical} idf ${idf} is negative`);
    }
  }
});

// MAX_BUCKET_COMPARISONS used to abandon head forms with no log, no counter and
// nothing in stats. Because the bucket is sorted, the casualties are always the
// lexicographically later heads, so the loss is structural and clustering drifts
// between incremental rebuilds. It still truncates - it is a safety valve - but it
// now says so.
test('variant clustering reports when the comparison budget truncates a bucket', async () => {
  const clusterDir = await fs.mkdtemp(path.join(testDataDir, 'patternrank-cluster-'));
  const harnessPath = path.join(clusterDir, 'cluster_harness.py');
  await fs.writeFile(harnessPath, `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('build_concepts', sys.argv[1])
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)

def run(phrases):
    clusters, telemetry = bc.cluster_phrases(set(phrases), {phrase: 3 for phrase in phrases})
    return {
        "scholarCluster": sorted(next(sorted(c) for c in clusters if "educational scholar" in c)),
        "telemetry": telemetry,
    }

# "educational scholar" / "educational scholarship" is an R2-only merge: the stems
# differ, so R1 cannot catch it. The noise is one long prefix run in the same
# modifier bucket that exhausts the budget before the scan reaches "scholar".
pair = ["educational scholar", "educational scholarship"]
noise = ["educational leader" + ("s" * i) for i in range(80)]
print(json.dumps({"clean": run(pair), "truncated": run(pair + noise)}, sort_keys=True))
`, 'utf8');

  const { stdout } = await execFileAsync(
    'python3',
    [harnessPath, path.resolve('scripts/build-concepts.py')],
    { cwd: path.resolve('.'), env: { ...process.env, CONCEPT_MAX_BUCKET_COMPARISONS: '1000' } },
  );
  const { clean, truncated } = JSON.parse(stdout);

  assert.deepEqual(clean.scholarCluster, ['educational scholar', 'educational scholarship']);
  assert.equal(clean.telemetry.truncatedBuckets, 0);
  assert.equal(clean.telemetry.truncatedHeads, 0);

  // Same pair, same rule, now silently unmerged -- except it is no longer silent.
  assert.deepEqual(truncated.scholarCluster, ['educational scholar']);
  assert.equal(truncated.telemetry.truncatedBuckets, 1);
  assert.ok(truncated.telemetry.truncatedHeads > 0);
  assert.equal(truncated.telemetry.comparisonBudget, 1000);
});

test('PatternRank refuses to publish an artifact whose alias map disagrees with stats', async () => {
  const guardDir = await fs.mkdtemp(path.join(testDataDir, 'patternrank-guard-'));
  const guardPath = path.join(guardDir, 'guard.py');
  await fs.writeFile(guardPath, `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('build_concepts', sys.argv[1])
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)

def expect_failure(artifact, label):
    try:
        bc.assert_alias_invariants(artifact, "test")
    except ValueError as error:
        print(label + ": " + str(error))
        return
    raise SystemExit("expected " + label + " to be rejected")

# The exact shape the regression shipped: real variants, empty map, aliases hardcoded 0.
expect_failure({
    "stats": {"aliases": 0},
    "concepts": [{"canonical": "learning community", "variants": ["learning communities"]}],
    "variantToCanonical": {},
}, "empty-map")
expect_failure({
    "stats": {"aliases": 5},
    "concepts": [{"canonical": "learning community", "variants": ["learning communities"]}],
    "variantToCanonical": {"learning communities": "learning community"},
}, "miscounted")
expect_failure({
    "stats": {"aliases": 1},
    "concepts": [
        {"canonical": "learning community", "variants": ["learning communities"]},
        {"canonical": "learning communities", "variants": []},
    ],
    "variantToCanonical": {"learning communities": "learning community"},
}, "canonical-also-variant")
bc.assert_alias_invariants({
    "stats": {"aliases": 1},
    "concepts": [{"canonical": "learning community", "variants": ["learning communities"]}],
    "variantToCanonical": {"learning communities": "learning community"},
}, "test")
print("consistent artifact accepted")
`, 'utf8');
  const { stdout } = await execFileAsync(
    'python3',
    [guardPath, path.resolve('scripts/build-concepts.py')],
    { cwd: path.resolve('.') },
  );
  // aliases=0 matches an empty map, so this shape is caught by the projection check.
  assert.match(stdout, /empty-map: .*does not match concepts\[\]\.variants \(1 projected vs 0 mapped\)/);
  assert.match(stdout, /miscounted: .*stats\.aliases=5 disagrees/);
  assert.match(stdout, /canonical-also-variant: .*both a canonical and a variant key/);
  assert.match(stdout, /consistent artifact accepted/);
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

test('theme recompute job refreshes durable document themes with progress', async () => {
  await ensureStorage();
  const docId = `theme-recompute-${Date.now()}`;
  await saveDocumentMetadata({
    id: docId,
    title: 'Digital Equity in Rural Learning Communities',
    author: 'Theme Runner',
    abstract: 'Digital access, rural learning, and online teaching shaped community education.',
    subjects: ['Educational technology', 'Rural education'],
    themes: ['stale-theme'],
  });
  const jobId = await createAdminJob({
    type: 'theme_recompute',
    label: 'Stored Theme Recompute Test',
    params: {},
    runnerType: 'local',
  });

  const result = await runThemeRecomputeAdminJob(await getAdminJob(jobId));
  const job = await getAdminJob(jobId);
  const stored = await loadDocumentMetadata(docId);

  assert.equal(result.ok, true);
  assert.equal(job.status, 'completed');
  assert.equal(job.runnerState, 'completed');
  assert.equal(job.progress?.phase, 'complete');
  assert.equal(job.progress?.counts?.updated >= 1, true);
  assert.equal(result.processed >= 1, true);
  assert.equal(Array.isArray(stored.themes), true);
  assert.equal(stored.themes.includes('stale-theme'), false);
  assert.ok(stored.themes.includes('digital') || stored.themes.includes('rural') || stored.themes.includes('learning'));
  assert.match(job.log, /Stored theme recompute finished/);
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

test('cache reanalysis job recomputes from cached PDF without downloading', async () => {
  await ensureStorage();
  const docId = `cached-reanalysis-${Date.now()}`;
  const durablePdfPath = `/web/pdf-cache/${docId}.pdf`;
  await saveDocumentMetadata({
    id: docId,
    title: 'Cached Reanalysis Fixture',
    author: 'Worker Tester',
    supervisors: [],
  });
  await saveFileMetric(docId, {
    status: 'cached',
    pdfPath: durablePdfPath,
    downloadUrl: 'https://example.test/cached.pdf',
    fileBytes: 43,
    wordCount: 1,
    pageCount: 1,
    wordSource: 'old',
    pageSource: 'old',
  });
  const jobId = await createAdminJob({
    type: 'cache_reanalyze_doc',
    label: 'Cached Reanalysis Test',
    params: { docId },
    runnerType: 'local',
  });
  const originalFetch = globalThis.fetch;
  let downloadedFromArtifact = false;
  globalThis.fetch = async () => {
    throw new Error('network should not be used for cached reanalysis');
  };

  try {
    const result = await runImportPdfAdminJob(await getAdminJob(jobId), {
      artifactClient: {
        downloadPdfToTemp: async (requestedDocId) => {
          assert.equal(requestedDocId, docId);
          downloadedFromArtifact = true;
          const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-cached-reanalysis-'));
          const pdfPath = path.join(dir, 'cached.pdf');
          await fs.writeFile(pdfPath, Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n'));
          return {
            path: pdfPath,
            cleanup: async () => fs.rm(dir, { recursive: true, force: true }),
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.docId, docId);
    assert.equal(result.status, 'recomputed_from_cache');
    assert.equal(downloadedFromArtifact, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const job = await getAdminJob(jobId);
  assert.equal(job.status, 'completed');
  assert.match(job.log, /Reanalyzing cached PDF\/full-text/);
  assert.equal(job.progress?.phase, 'complete');
  assert.ok(Array.isArray(job.progress?.tasks));
  const stored = await loadStoredFileMetric(docId);
  assert.equal(stored.status, 'recomputed_from_cache');
  assert.equal(stored.pdf_path, durablePdfPath);
});

test('cache reanalysis cleans up temporary artifact PDFs after parse errors', async () => {
  await ensureStorage();
  const docId = `cached-reanalysis-cleanup-${Date.now()}`;
  await saveDocumentMetadata({
    id: docId,
    title: 'Cached Reanalysis Cleanup Fixture',
    author: 'Worker Tester',
    supervisors: [],
  });
  await saveFileMetric(docId, {
    status: 'cached',
    pdfPath: `/web/pdf-cache/${docId}.pdf`,
    downloadUrl: 'https://example.test/cached.pdf',
    fileBytes: 43,
    wordCount: 1,
    pageCount: 1,
    wordSource: 'old',
    pageSource: 'old',
  });

  let cleanupCalled = false;
  await analyzeDocumentFile({
    id: docId,
    title: 'Cached Reanalysis Cleanup Fixture',
    supervisors: [],
  }, {
    downloadFiles: false,
    forceDownload: false,
    recomputeFromCache: true,
    artifactClient: {
      downloadPdfToTemp: async () => ({
        path: path.join(testDataDir, 'missing-artifact.pdf'),
        cleanup: async () => { cleanupCalled = true; },
      }),
    },
  });

  const stored = await loadStoredFileMetric(docId);
  assert.equal(cleanupCalled, true);
  assert.equal(stored.status, 'cache_error');
});

test('cached document reparse does not clear or extract citations', async () => {
  await ensureStorage();
  const docId = `reparse-no-citations-${Date.now()}`;
  const pdfPath = path.join(testDataDir, `${docId}.pdf`);
  await fs.writeFile(pdfPath, Buffer.from('%PDF-1.4\n%%EOF'));
  await saveDocumentMetadata({
    id: docId,
    title: 'Reparse Without Citations Fixture',
    author: 'Worker Tester',
    supervisors: [],
  });
  await saveFileMetric(docId, {
    status: 'cached',
    pdfPath,
    downloadUrl: 'https://example.test/no-citations.pdf',
    fileBytes: 14,
    wordCount: 10,
    pageCount: 1,
    wordSource: 'existing',
    pageSource: 'existing',
  });
  await saveCitations(docId, [
    { text: 'Existing, C. (2020). Citation should remain.' },
  ], (text) => String(text).toLowerCase());
  const jobId = await createAdminJob({
    type: 'reparse_all',
    label: 'Reparse Without Citations Test',
    params: {},
    runnerType: 'local',
  });

  const result = await runImportPdfAdminJob(await getAdminJob(jobId));
  const citations = await loadDocumentCitations(docId);
  const job = await getAdminJob(jobId);
  const pdfParseTask = job.progress?.tasks?.find((task) => task.key === 'pdf_parse');

  assert.equal(result.ok, true);
  assert.equal(result.citations, 0);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].citation_text, 'Existing, C. (2020). Citation should remain.');
  assert.ok(['completed', 'failed'].includes(pdfParseTask?.status));
  assert.equal(pdfParseTask?.counts?.total > 0, true);
  assert.ok(pdfParseTask?.detail);
});

test('citation re-extraction job leaves file metrics untouched', async () => {
  await ensureStorage();
  const docId = `citation-only-${Date.now()}`;
  const pdfPath = path.join(testDataDir, `${docId}.pdf`);
  await writeTextPdf(pdfPath, [
    'Introduction',
    'REFERENCES',
    'Smith, J. (2020). Teaching schools with care. Education Press.',
  ]);
  await saveDocumentMetadata({
    id: docId,
    title: 'Citation Only Fixture',
    author: 'Worker Tester',
    supervisors: [],
  });
  await saveFileMetric(docId, {
    status: 'cached',
    pdfPath,
    downloadUrl: 'https://example.test/citation-only.pdf',
    fileBytes: 12345,
    wordCount: 777,
    bodyWordCount: 700,
    pageCount: 88,
    wordSource: 'existing_words',
    pageSource: 'existing_pages',
  });
  const before = await loadStoredFileMetric(docId);
  const jobId = await createAdminJob({
    type: 'cache_reextract_citations_doc',
    label: 'Citation Only Test',
    params: { docId },
    runnerType: 'local',
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('GROBID disabled for citation-only test');
  };

  try {
    const result = await runImportPdfAdminJob(await getAdminJob(jobId));
    const after = await loadStoredFileMetric(docId);
    const citations = await loadDocumentCitations(docId);

    assert.equal(result.ok, true);
    assert.equal(after.status, before.status);
    assert.equal(after.pdf_path, before.pdf_path);
    assert.equal(after.download_url, before.download_url);
    assert.equal(after.file_bytes, before.file_bytes);
    assert.equal(after.word_count, before.word_count);
    assert.equal(after.body_word_count, before.body_word_count);
    assert.equal(after.page_count, before.page_count);
    assert.equal(after.word_source, before.word_source);
    assert.equal(after.page_source, before.page_source);
    assert.ok(citations.some((row) => row.citation_text.includes('Smith, J. (2020). Teaching schools with care')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('citation matching progress reports processed and fuzzy counts', async () => {
  const hashFn = (text) => String(text || '').toLowerCase();
  await saveCitations('citation-progress-seed', [
    { text: 'Smith, John. 2020. Educational Leadership in Canada.' },
  ], hashFn);

  const events = [];
  await saveCitations('citation-progress-doc', [
    { text: 'Smith, Jon. 2020. Educational Leadership in Canada.' },
    { text: 'Nguyen, A. 2021. Community Schools and Care.' },
  ], hashFn, {
    onProgress: async (event) => events.push(event),
  });

  const final = events.at(-1);
  assert.equal(final.phase, 'citation_matching');
  assert.equal(final.status, 'completed');
  assert.equal(final.counts.processed, 2);
  assert.equal(final.counts.total, 2);
  assert.equal(final.counts.fuzzyMatches, 1);
  assert.equal(final.counts.newCitations, 1);
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
      if (error.statusCode !== 503 || !/FLY_API_TOKEN is not set/.test(error.message)) {
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

test('fly worker payload forwards runtime credentials and throttles', () => {
  const keys = [
    'UBC_API_KEY', 'API_KEY_ENCRYPTION_KEY', 'PDF_DOWNLOAD_RATE_PER_MIN', 'NODE_ENV',
    'UBC_API_BASE_URL', 'GROBID_URL', 'GROBID_APP_NAME', 'GROBID_FLY_API_TOKEN', 'FLY_API_TOKEN',
  ];
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.UBC_API_KEY = 'test-oc-key';
  process.env.API_KEY_ENCRYPTION_KEY = 'test-enc-key';
  process.env.PDF_DOWNLOAD_RATE_PER_MIN = '4';
  process.env.NODE_ENV = 'production';
  process.env.UBC_API_BASE_URL = 'https://oc-index.test';
  process.env.GROBID_URL = 'http://grobid.test:8070';
  process.env.GROBID_APP_NAME = 'wb-grobid';
  process.env.GROBID_FLY_API_TOKEN = 'grobid-token';
  process.env.FLY_API_TOKEN = 'fly-token';
  try {
    const payload = buildFlyWorkerMachinePayload({ image: 'img', jobId: 42, token: 'tok' });
    assert.equal(payload.config.env.UBC_API_KEY, 'test-oc-key');
    assert.equal(payload.config.env.API_KEY_ENCRYPTION_KEY, 'test-enc-key');
    assert.equal(payload.config.env.PDF_DOWNLOAD_RATE_PER_MIN, '4');
    assert.equal(payload.config.env.NODE_ENV, 'production');
    assert.equal(payload.config.env.UBC_API_BASE_URL, 'https://oc-index.test');
    assert.equal(payload.config.env.GROBID_URL, 'http://grobid.test:8070');
    assert.equal(payload.config.env.GROBID_APP_NAME, 'wb-grobid');
    assert.equal(payload.config.env.GROBID_FLY_API_TOKEN, 'grobid-token');

    // Fallback branch: without GROBID_FLY_API_TOKEN, FLY_API_TOKEN is used.
    delete process.env.GROBID_FLY_API_TOKEN;
    const fallback = buildFlyWorkerMachinePayload({ image: 'img', jobId: 43, token: 'tok' });
    assert.equal(fallback.config.env.GROBID_FLY_API_TOKEN, 'fly-token');
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('running jobs with no timeout and stale heartbeats get reaped', async () => {
  const jobId = await createAdminJob({
    type: 'catalogue_lookup_reap_test',
    label: 'Stale lookup',
    params: null,
  });
  const stale = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  await updateAdminJob(jobId, { heartbeatAt: stale });

  const runningId = await hasRunningAdminJob('catalogue_lookup_reap_test');
  assert.equal(runningId, null);
  const job = await getAdminJob(jobId);
  assert.equal(job.status, 'timed_out');
});

test('appendAdminJobLog trims to the tail limit atomically', async () => {
  const jobId = await createAdminJob({ type: 'log_test', label: 'Log test', params: null });
  await appendAdminJobLog(jobId, 'first line\n');
  await appendAdminJobLog(jobId, 'x'.repeat(50), 40);
  const job = await getAdminJob(jobId);
  assert.equal(job.log.length, 40);
  assert.equal(job.log, 'x'.repeat(40));
});

// A 2-gram that many distinct 3-grams extend is a hub topic, not a sliding-window
// fragment of any one of them. Absorbing all of them replaces every specific
// concept with the generic parent, which is the opposite of a discovery aid.
test('variant clustering leaves hub extensions distinct and reports withholding them', async () => {
  const clusterDir = await fs.mkdtemp(path.join(testDataDir, 'patternrank-fanin-'));
  const harnessPath = path.join(clusterDir, 'fanin_harness.py');
  await fs.writeFile(harnessPath, `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('build_concepts', sys.argv[1])
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)

def run(phrases):
    clusters, telemetry = bc.cluster_phrases(set(phrases), {phrase: 5 for phrase in phrases})
    return {
        "hubCluster": sorted(next(sorted(c) for c in clusters if "student engagement" in c)),
        "telemetry": telemetry,
        "clusters": len(clusters),
    }

hub = "student engagement"
# Two extensions: plausibly fragments, so they fold in.
few = [hub, hub + " practice", hub + " practices"]
# Seven distinct research topics: the hub must not swallow them.
many = [hub] + [hub + " " + w for w in
                ["practice", "outcome", "theory", "barrier", "survey", "policy", "gap"]]
print(json.dumps({"few": run(few), "many": run(many)}, sort_keys=True))
`, 'utf8');

  const { stdout } = await execFileAsync(
    'python3',
    [harnessPath, path.resolve('scripts/build-concepts.py')],
    { cwd: path.resolve('.'), env: { ...process.env, CONCEPT_VARIANT_EXTENSION_MAX_FAN_IN: '2' } },
  );
  const { few, many } = JSON.parse(stdout);

  // Within the limit, the extension rule still does its job.
  assert.deepEqual(few.hubCluster, [
    'student engagement', 'student engagement practice', 'student engagement practices',
  ]);
  assert.equal(few.telemetry.extensionHubsSkipped, 0);
  assert.equal(few.telemetry.extensionEdgesSkipped, 0);

  // Over the limit, the hub keeps only itself and every extension survives as its
  // own concept -- all of them, not an alphabetically-chosen subset.
  assert.deepEqual(many.hubCluster, ['student engagement']);
  assert.equal(many.clusters, 8);
  assert.equal(many.telemetry.extensionHubsSkipped, 1);
  assert.equal(many.telemetry.extensionEdgesSkipped, 7);
  assert.equal(many.telemetry.extensionFanInLimit, 2);
});

// #35 half: a hub with two co-stemming surface forms ("student outcome" /
// "student outcomes") must not have its fan-in decision counted twice just
// because cluster_phrases's `extensions` dict is keyed by literal surface phrase.
// Regression cover: before the fix, this fixture reports Hubs=2/Edges=8 (each
// surface form independently decides "skip" and increments the shared counters);
// grouping by component root and merging each root's absorbed set as a set (not a
// concatenated list, which silently reintroduces the same double-count) gives the
// truthful Hubs=1/Edges=4.
test('variant clustering counts one fan-in decision per hub even with a co-stemming surface pair', async () => {
  const clusterDir = await fs.mkdtemp(path.join(testDataDir, 'patternrank-fanin-costem-'));
  const harnessPath = path.join(clusterDir, 'costem_fanin_harness.py');
  await fs.writeFile(harnessPath, `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('build_concepts', sys.argv[1])
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)

hub1 = "student outcome"
hub2 = "student outcomes"
extensions = [hub1 + " " + w for w in ("policy", "funding", "tracking", "equity")]
phrases = {hub1, hub2, *extensions}
clusters, telemetry = bc.cluster_phrases(phrases, {p: 5 for p in phrases})
print(json.dumps({
    "telemetry": telemetry,
    "hubCluster": sorted(next(c for c in clusters if hub1 in c)),
    "clusters": len(clusters),
}, sort_keys=True))
`, 'utf8');

  const { stdout } = await execFileAsync(
    'python3',
    [harnessPath, path.resolve('scripts/build-concepts.py')],
    { cwd: path.resolve('.'), env: { ...process.env, CONCEPT_VARIANT_EXTENSION_MAX_FAN_IN: '2' } },
  );
  const { telemetry, hubCluster, clusters } = JSON.parse(stdout);

  // The truthful count: one hub (however many surface forms it has), 4 withheld
  // extensions -- not the doubled Hubs=2/Edges=8 the surface-form keying produced.
  assert.equal(telemetry.extensionHubsSkipped, 1);
  assert.equal(telemetry.extensionEdgesSkipped, 4);
  // Both co-stemming surface forms stay together (R1 already merged them); none of
  // the 4 extensions folds in, since together they exceed the fan-in limit of 2.
  assert.deepEqual(hubCluster, ['student outcome', 'student outcomes']);
  assert.equal(clusters, 5);
});

// #31 half: fan-in must hold through merge_partition_artifacts, not just within one
// shard's own cluster_phrases pass. Three shards each independently keep 2
// extensions of the *same* hub -- each shard is legal on its own (2 <= the cap of
// 2), but the union across shards is 6, well past it. Regression cover: before the
// fix, merge unions every shard's variants unconditionally, so the merged hub ends
// up with all 6 extensions attached (7-member component) and reports zero
// withheld edges even though the fan-in limit was blown at merge time.
test('merge re-enforces extension fan-in across shards and reports it truthfully', async () => {
  const mergeDir = await fs.mkdtemp(path.join(testDataDir, 'patternrank-merge-fanin-'));
  const harnessPath = path.join(mergeDir, 'merge_fanin_harness.py');
  await fs.writeFile(harnessPath, `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('build_concepts', sys.argv[1])
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)
client = bc.SqliteClientWrapper(sys.argv[2])
bc.ensure_incremental_schema(client)
for shard in json.loads(sys.argv[3]):
    documents = shard["artifact"]["stats"]["documents"]
    client.execute(
        "INSERT OR REPLACE INTO concept_partitions (partition_key, scope_json, priority, enabled,"
        " status, source_document_count, artifact_version, updated_at)"
        " VALUES (?, '{}', 0, 1, 'complete', ?, 1, '2026-01-01T00:00:00+00:00')",
        [shard["key"], documents],
    )
    client.execute(
        "INSERT OR REPLACE INTO concept_partition_artifacts (partition_key, version, artifact_json,"
        " document_count, created_at) VALUES (?, 1, ?, ?, '2026-01-01T00:00:00+00:00')",
        [shard["key"], json.dumps(shard["artifact"]), documents],
    )
merged = bc.merge_partition_artifacts(client)
hub = "student outcome"
hub_concept = next(
    c for c in merged["concepts"] if c["canonical"] == hub or hub in c.get("variants", [])
)
print(json.dumps({
    "hubMembers": sorted([hub_concept["canonical"], *hub_concept["variants"]]),
    "totalConcepts": len(merged["concepts"]),
    "stats": merged["stats"],
    "canonicals": sorted(c["canonical"] for c in merged["concepts"]),
}, sort_keys=True))
`, 'utf8');

  const hub = 'student outcome';
  const shard = (key, extensions) => ({
    key,
    artifact: {
      stats: { documents: 5, clusterTruncatedBuckets: 0, clusterTruncatedHeads: 0, clusterExtensionHubsSkipped: 0, clusterExtensionEdgesSkipped: 0 },
      partition: { key },
      concepts: [{
        canonical: hub,
        variants: extensions,
        variantRules: Object.fromEntries(extensions.map((e) => [e, 'R3'])),
        variantDocFreq: Object.fromEntries(extensions.map((e) => [e, 3])),
        docFreq: 5,
        docIndexes: [0, 1, 2, 3, 4],
        patternRankScore: 0.6,
      }],
    },
  });
  const shards = [
    shard('p-outcome-1', [`${hub} policy`, `${hub} funding`]),
    shard('p-outcome-2', [`${hub} tracking`, `${hub} equity`]),
    shard('p-outcome-3', [`${hub} access`, `${hub} quality`]),
  ];
  const dbPath = path.join(mergeDir, 'merge-fanin.sqlite');
  const { stdout } = await execFileAsync(
    'python3',
    [harnessPath, path.resolve('scripts/build-concepts.py'), dbPath, JSON.stringify(shards)],
    { cwd: path.resolve('.'), env: { ...process.env, CONCEPT_VARIANT_EXTENSION_MAX_FAN_IN: '2' } },
  );
  const result = JSON.parse(stdout);

  // The hub's merged component must not exceed the fan-in limit + 1 (itself),
  // regardless of how many shards independently, legally, contributed to it.
  assert.ok(result.hubMembers.length <= 3, `hub component grew to ${result.hubMembers.length} members: ${result.hubMembers}`);
  assert.deepEqual(result.hubMembers, [hub]);
  // Every withheld extension survives as its own concept rather than vanishing.
  assert.equal(result.totalConcepts, 7);
  assert.deepEqual(result.canonicals, [
    hub, `${hub} access`, `${hub} equity`, `${hub} funding`, `${hub} policy`, `${hub} quality`, `${hub} tracking`,
  ]);
  // Truthful telemetry: zero shard withheld anything on its own (each stayed
  // within its own 2-extension cap), so every withheld edge counted here was
  // caught by merge's own cross-shard re-check, and the totals must say so.
  assert.equal(result.stats.mergeExtensionHubsSkipped, 1);
  assert.equal(result.stats.mergeExtensionEdgesSkipped, 6);
  assert.equal(result.stats.clusterExtensionHubsSkipped, 1);
  assert.equal(result.stats.clusterExtensionEdgesSkipped, 6);
});

// ---------------------------------------------------------------------------
// Phase C gates (#10 completion gate): countable cold start (#21, supported by
// #20), no-op rerun (#22, supported by #20), fan-in holds through merge
// (#31/#35, covered by the two tests immediately above this section).
// ---------------------------------------------------------------------------

// Gate A, statement-count half (#20): discover_partition's own statement count
// must not scale with cohort count once nothing is changing -- this is the
// mechanical fix Gate A's run-count bound depends on (fewer statements per
// cohort is what makes a much larger K tractable at all).
test('Gate A / #20: discover_partition statement count does not scale with cohort count on a steady-state pass', async () => {
  const dir = await fs.mkdtemp(path.join(testDataDir, 'gate-a-statement-count-'));
  const harnessPath = path.join(dir, 'statement_count_harness.py');
  await fs.writeFile(harnessPath, `
import importlib.util, json, sqlite3, sys
spec = importlib.util.spec_from_file_location('build_concepts', sys.argv[1])
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)

db_path = sys.argv[2]
k = int(sys.argv[3])

db = sqlite3.connect(db_path)
db.execute("CREATE TABLE documents (doc_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL, degree TEXT, year INTEGER, updated_at TEXT NOT NULL)")
for i in range(k):
    doc = {
        "id": f"doc-{i}", "title": f"Distinct Topic {i}",
        "abstract": f"Distinct topic {i} discussion of unrelated subject matter.",
        "subjects": [f"topic-{i}"],
    }
    db.execute(
        "INSERT INTO documents VALUES (?, ?, ?, ?, ?)",
        (doc["id"], json.dumps(doc), f"Degree {i}", 2020, "2026-01-01T00:00:00+00:00"),
    )
db.commit()
db.close()

client = bc.SqliteClientWrapper(db_path)
bc.ensure_incremental_schema(client)

counts = {"calls": 0}
def counting_execute(sql, params=None):
    counts["calls"] += 1
    cursor = client.conn.cursor()
    cursor.execute(sql, tuple(params or ()))
    client.conn.commit()
    class ResultSet:
        def __init__(self, cursor):
            self.rows = cursor.fetchall()
    return ResultSet(cursor)
client.execute = counting_execute

# Pass 1: nothing in concept_partitions yet (a from-scratch cold start).
counts["calls"] = 0
bc.discover_partition(client)
fresh_pass_statements = counts["calls"]

# Simulate every cohort's worker run having finished successfully, so pass 2
# starts from "last completed pass had no changes" -- the scenario #20's fix
# targets, and the one this test's assertions are about.
client.execute(
    "UPDATE concept_partitions SET status = 'complete', last_completed_at = updated_at, artifact_version = 1 WHERE enabled = 1"
)
bc.mark_global_published(client)

counts["calls"] = 0
selected = bc.discover_partition(client)
unchanged_pass_statements = counts["calls"]

print(json.dumps({
    "freshPassStatements": fresh_pass_statements,
    "unchangedPassStatements": unchanged_pass_statements,
    "selectedIsNone": selected is None,
}))
`, 'utf8');

  const measure = async (k) => {
    const dbPath = path.join(dir, `statements-${k}.sqlite`);
    const { stdout } = await execFileAsync(
      'python3',
      [harnessPath, path.resolve('scripts/build-concepts.py'), dbPath, String(k)],
      { cwd: path.resolve('.') },
    );
    return JSON.parse(stdout);
  };

  const small = await measure(5);
  const large = await measure(50);

  assert.equal(small.selectedIsNone, true);
  assert.equal(large.selectedIsNone, true);
  // The steady-state statement count must not grow with cohort count.
  assert.equal(small.unchangedPassStatements, large.unchangedPassStatements);
  assert.ok(
    small.unchangedPassStatements <= 6,
    `expected a small constant, got ${small.unchangedPassStatements}`,
  );
  // Both K=5 and K=50 fit inside one write batch (PARTITION_WRITE_BATCH_SIZE),
  // so even the from-scratch pass stays flat here -- a world apart from the
  // pre-fix 3-statements-per-cohort growth (15 vs 150 for these two K values).
  assert.equal(small.freshPassStatements, large.freshPassStatements);
});

// Gate A, run-count half (#21): phrase-disjoint cohorts publish in exactly K
// runs, and decade coarsening needs strictly fewer runs than exact-year
// grouping over the same corpus.
test('Gate A / #21: phrase-disjoint cohorts publish in exactly K runs, fewer under decade coarsening', async () => {
  const gateDir = await fs.mkdtemp(path.join(testDataDir, 'gate-a-disjoint-'));
  const buildDb = async (sqlitePath) => {
    const setup = `
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE documents (doc_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL, degree TEXT, year INTEGER, updated_at TEXT NOT NULL)")
degrees = {
    "Disjoint Physics": ("Quantum Entanglement Research", "Quantum entanglement research explores nonlocal correlation phenomena.", ["quantum entanglement research"]),
    "Disjoint History": ("Colonial Trade Networks", "Colonial trade networks reshaped regional maritime commerce routes.", ["colonial trade networks"]),
}
for degree, (title, abstract, subjects) in degrees.items():
    for year in (2021, 2022, 2023):
        doc_id = f"{degree.split()[-1].lower()}-{year}"
        doc = {"id": doc_id, "title": title, "abstract": abstract, "subjects": subjects, "degree": degree, "year": year}
        db.execute("INSERT INTO documents VALUES (?, ?, ?, ?, ?)", (doc_id, json.dumps(doc), degree, year, "2026-01-01T00:00:00+00:00"))
db.commit()
`;
    await execFileAsync('python3', ['-c', setup, sqlitePath]);
  };

  const countRunsUntilPublished = async (granularity) => {
    const dir = await fs.mkdtemp(path.join(gateDir, `${granularity}-`));
    const sqlitePath = path.join(dir, 'metrics.sqlite');
    const latestPath = path.join(dir, 'concepts', 'latest.json');
    await buildDb(sqlitePath);
    const env = {
      ...process.env,
      SQLITE_PATH: sqlitePath,
      APP_DATA_DIR: dir,
      TURSO_DATABASE_URL: '',
      ADMIN_JOB_ID: '',
      NODE_ENV: 'test',
      CONCEPT_EMBEDDING_BACKEND: 'deterministic_test',
      CONCEPT_PATTERNRANK_MIN_SCORE: '-1',
      CONCEPT_PARTITION_GRANULARITY: granularity,
    };
    let runs = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await execFileAsync('python3', ['scripts/build-concepts.py'], { cwd: path.resolve('.'), env });
      runs += 1;
      try { await fs.access(latestPath); break; } catch { /* first generation still incomplete */ }
    }
    await fs.access(latestPath); // fail loudly (not silently time out) if it never published
    return runs;
  };

  const decadeRuns = await countRunsUntilPublished('decade');
  const yearRuns = await countRunsUntilPublished('year');

  // Two phrase-disjoint degrees, each spanning one decade -> exactly 2 decade
  // cohorts with no shared vocabulary to ripple: the clean K == runs bound.
  assert.equal(decadeRuns, 2);
  // The same corpus under exact-year grouping splits into up to 6 cohorts (2
  // degrees x 3 years) -- strictly more runs to reach the same first generation.
  assert.ok(
    yearRuns > decadeRuns,
    `expected year-granularity runs (${yearRuns}) > decade-granularity runs (${decadeRuns})`,
  );
});

// Gate A, vocabulary-sharing half (#21): cohorts that share borderline
// vocabulary may need a bounded number of extra runs past K (the
// save_partition_candidates DF-crossing ripple), but that ripple must converge
// -- a subsequent, completely unchanged run must re-pend nothing.
test('Gate A / #21: vocabulary-sharing cohorts publish within K + a small ripple bound, and the ripple converges', async () => {
  const gateDir = await fs.mkdtemp(path.join(testDataDir, 'gate-a-vocab-share-'));
  const sqlitePath = path.join(gateDir, 'metrics.sqlite');
  const latestPath = path.join(gateDir, 'concepts', 'latest.json');
  const setup = `
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE documents (doc_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL, degree TEXT, year INTEGER, updated_at TEXT NOT NULL)")
for degree in ("Vocab Share Alpha", "Vocab Share Beta"):
    doc_id = degree.split()[-1].lower()
    doc = {"id": doc_id, "title": "Community Learning Leadership", "abstract": "Community learning leadership supports schools.", "subjects": ["community learning leadership"], "degree": degree, "year": 2021}
    db.execute("INSERT INTO documents VALUES (?, ?, ?, ?, ?)", (doc_id, json.dumps(doc), degree, 2021, "2026-01-01T00:00:00+00:00"))
db.commit()
`;
  await execFileAsync('python3', ['-c', setup, sqlitePath]);
  const env = {
    ...process.env,
    SQLITE_PATH: sqlitePath,
    APP_DATA_DIR: gateDir,
    TURSO_DATABASE_URL: '',
    ADMIN_JOB_ID: '',
    NODE_ENV: 'test',
    CONCEPT_EMBEDDING_BACKEND: 'deterministic_test',
    CONCEPT_PATTERNRANK_MIN_SCORE: '-1',
  };
  const run = () => execFileAsync('python3', ['scripts/build-concepts.py'], { cwd: path.resolve('.'), env });
  const fetchPartitionStates = async () => {
    const { stdout } = await execFileAsync('python3', ['-c',
      'import sqlite3, json, sys\n' +
      'db = sqlite3.connect(sys.argv[1])\n' +
      'db.row_factory = sqlite3.Row\n' +
      'rows = [dict(r) for r in db.execute("SELECT partition_key, status, content_fingerprint, updated_at FROM concept_partitions ORDER BY partition_key")]\n' +
      'print(json.dumps(rows, sort_keys=True))\n',
      sqlitePath]);
    return JSON.parse(stdout);
  };

  const K = 2;
  const RIPPLE_BOUND = 3; // documented small ripple allowance -- see #21 in docs/phase-c-completion-plan.md
  let runs = 0;
  for (let attempt = 0; attempt < K + RIPPLE_BOUND; attempt += 1) {
    await run();
    runs += 1;
    try { await fs.access(latestPath); break; } catch { /* first generation still incomplete */ }
  }
  await fs.access(latestPath);
  assert.ok(runs <= K + RIPPLE_BOUND, `expected <= ${K + RIPPLE_BOUND} runs, took ${runs}`);
  assert.ok(
    runs > K,
    'expected this shared-vocabulary fixture to need at least one extra run past K -- a fixture with zero ripple would not exercise the bound this gate checks',
  );

  // Ripple convergence: one further, completely unchanged run must not re-pend
  // anything. Comparing status, content_fingerprint AND updated_at makes this a
  // genuine no-op check (Gate B's own property), not just "still converged".
  const beforeExtra = await fetchPartitionStates();
  await run();
  const afterExtra = await fetchPartitionStates();
  assert.deepEqual(afterExtra, beforeExtra);
});

// Gate B (#22, supported by #20): a real enrichment pass (sync.js's
// runEnrichmentBatch double-calls saveDocumentMetadata per document) that
// changes no concept-relevant field must be a genuine no-op on the next concept
// rebuild -- not merely "no re-embedding", but no re-pend of the partition at
// all. A true-positive companion guards against a fix that is simply "never
// mark dirty".
test('Gate B / #22: an enrichment pass with no concept-relevant change is a genuine no-op rerun', async () => {
  await ensureStorage();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const degree = `Gate B Fixture ${suffix}`;
  const baseDoc = {
    author: 'Gate B Tester',
    degree,
    year: 2025,
    abstract: 'Indigenous language revitalization sustains community knowledge systems.',
    subjects: ['indigenous language revitalization'],
    supervisors: [],
  };
  const docA = { ...baseDoc, id: `gateb-a-${suffix}`, title: 'Indigenous Language Revitalization A' };
  const docB = { ...baseDoc, id: `gateb-b-${suffix}`, title: 'Indigenous Language Revitalization B' };
  await saveDocumentMetadata(docA);
  await saveDocumentMetadata(docB);

  const runPatternRank = async () => {
    const jobId = await createAdminJob({
      type: 'concept_rebuild',
      label: 'Gate B Test',
      params: { scope: { degree }, method: 'patternrank_incremental' },
      runnerType: 'local',
    });
    await execFileAsync('python3', ['scripts/build-concepts.py'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        ADMIN_JOB_ID: String(jobId),
        NODE_ENV: 'test',
        CONCEPT_EMBEDDING_BACKEND: 'deterministic_test',
        CONCEPT_PATTERNRANK_MIN_SCORE: '-1',
      },
    });
    return getAdminJob(jobId);
  };

  const first = await runPatternRank();
  assert.equal(first.status, 'completed');
  assert.equal(first.result.partitionVersion, 1);
  const partitionKey = first.result.partition;

  const db = await getDb();
  const fetchPartitionRow = async () => (await db.execute({
    sql: 'SELECT status, content_fingerprint, updated_at FROM concept_partitions WHERE partition_key = ?',
    args: [partitionKey],
  })).rows[0];
  const before = await fetchPartitionRow();
  assert.equal(before.status, 'complete');

  // Reproduce sync.js's runEnrichmentBatch double-call shape (src/sync.js:317,340):
  // saveDocumentMetadata called twice per document per enrichment pass, with
  // byte-identical title/abstract/subjects both times -- only updated_at moves.
  await saveDocumentMetadata(docA);
  await saveDocumentMetadata(docA);
  await saveDocumentMetadata(docB);
  await saveDocumentMetadata(docB);

  const second = await runPatternRank();
  assert.equal(second.status, 'completed');
  assert.equal(second.result.noChanges, true);

  const after = await fetchPartitionRow();
  assert.equal(after.status, 'complete');
  assert.equal(after.content_fingerprint, before.content_fingerprint);
  // Never re-pended, never re-written: #20's "no write for an unchanged cohort"
  // and #22's "no false-dirty from a timestamp-only change" holding together.
  assert.equal(after.updated_at, before.updated_at);

  // True-positive companion: a genuinely different title/abstract must still be
  // detected and reprocessed.
  await saveDocumentMetadata({
    ...docA,
    title: 'Indigenous Language Revitalization A Revised',
    abstract: 'Revised: elders document oral history archives and land-based curricula.',
  });
  const third = await runPatternRank();
  assert.equal(third.status, 'completed');
  assert.equal(third.result.documentsChanged, 1);
  assert.equal(third.result.partitionVersion, 2);
  const afterRevision = await fetchPartitionRow();
  assert.notEqual(afterRevision.content_fingerprint, before.content_fingerprint);
});

// Gate B support: the new concept_partitions.content_fingerprint column is
// added by a fresh ALTER-TABLE primitive (ensure_incremental_schema previously
// only ever did CREATE TABLE IF NOT EXISTS) -- must be idempotent against an
// already-migrated database.
test('#22: content_fingerprint column migration is idempotent', async () => {
  const dir = await fs.mkdtemp(path.join(testDataDir, 'gate-b-migration-'));
  const dbPath = path.join(dir, 'metrics.sqlite');
  const harnessPath = path.join(dir, 'migration_harness.py');
  await fs.writeFile(harnessPath, `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('build_concepts', sys.argv[1])
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)
client = bc.SqliteClientWrapper(sys.argv[2])
bc.ensure_incremental_schema(client)
bc.ensure_incremental_schema(client)
cols = [row[1] for row in client.conn.execute("PRAGMA table_info(concept_partitions)").fetchall()]
print(json.dumps({"columnCount": cols.count("content_fingerprint"), "hasColumn": "content_fingerprint" in cols}))
`, 'utf8');
  const { stdout } = await execFileAsync(
    'python3',
    [harnessPath, path.resolve('scripts/build-concepts.py'), dbPath],
    { cwd: path.resolve('.') },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.hasColumn, true);
  assert.equal(result.columnCount, 1);
});

// --- Citation scan (re-streaming) job ---

async function seedStreamableDoc(id, { degree = null, syncKey = null, checksum = 'scan-checksum-v1' } = {}) {
  await saveDocumentMetadata({
    id,
    title: `Citation Scan Fixture ${id}`,
    author: 'Scan Tester',
    degree: degree || undefined,
    originalRecordUrl: `https://circle.library.ubc.ca/rest/handle/2429/${id}`,
    supervisors: [],
  }, syncKey ? { syncKey } : {});
  await saveFileMetric(id, {
    status: 'streamed',
    contentSource: 'streamed_pdf',
    contentChecksum: checksum,
    wordCount: 500,
    pageCount: 10,
    wordSource: 'streamed_pdf_text',
    pageSource: 'streamed_pdf',
  });
}

test('citation scan selection includes streamable un-scanned docs and excludes completed, failed, and non-streamable ones', async () => {
  await ensureStorage();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const degree = `Scan Degree ${suffix}`;
  const pending = `scan-pending-${suffix}`;
  const completed = `scan-completed-${suffix}`;
  const zeroCiteCompleted = `scan-zerocite-${suffix}`;
  const failedDoc = `scan-failed-${suffix}`;
  const hasCitations = `scan-hascites-${suffix}`;
  const notStreamable = `scan-fulltext-${suffix}`;

  for (const id of [pending, completed, zeroCiteCompleted, failedDoc, hasCitations]) {
    await seedStreamableDoc(id, { degree });
  }
  // A full-text-only import is not a streamable PDF source.
  await saveDocumentMetadata({ id: notStreamable, title: 'Full text only', degree, supervisors: [] });
  await saveFileMetric(notStreamable, {
    status: 'full_text', fullTextPath: `/cached/${notStreamable}.txt`, contentChecksum: 'ft-v1',
  });

  // A real post-scan shape: the completed doc has BOTH a completed state row and
  // actual citation rows (this is what a successful scan leaves behind).
  await saveCitationExtractionState(completed, {
    contentChecksum: 'scan-checksum-v1', parserVersion: 'citation-v2', status: 'completed', citationCount: 4,
  });
  await saveCitations(completed, [{ text: `Done, D. (2019). Scanned. ${suffix}` }], (t) => `completed-${suffix}-${t}`);
  // A successful scan that found ZERO citations: a completed state row and NO
  // citation rows. Selection must exclude it on the completed-state gate alone
  // (there are no citation rows to fall back on), independent of parser version.
  await saveCitationExtractionState(zeroCiteCompleted, {
    contentChecksum: 'scan-checksum-v1', parserVersion: 'citation-v1', status: 'completed', citationCount: 0,
  });
  await saveCitationExtractionState(failedDoc, {
    contentChecksum: 'scan-checksum-v1', parserVersion: 'citation-v1', status: 'failed', citationCount: 0, error: 'boom',
  });
  // Simulate a legacy failed extraction that published some links before it
  // failed. The explicit retry control must still be able to repair it.
  await saveCitations(failedDoc, [{ text: `Partial, P. (2018). Failed scan. ${suffix}` }], (t) => `partial-${suffix}-${t}`);
  await saveCitations(hasCitations, [{ text: `Already, C. (2020). Extracted. ${suffix}` }], (t) => `hascites-${suffix}-${t}`);

  const ids = async (opts) => (await listPendingCitationScans({
    limit: 50, filters: { degree }, ...opts,
  })).map((row) => row.doc_id).sort();

  // Default run: only the pending doc qualifies. The zero-citation completed doc
  // is excluded by the completed-state gate, not by any citation rows, and stays
  // excluded regardless of the parser version its old row carries (scan-once is
  // version-independent — a parser bump never re-selects a scanned doc).
  assert.deepEqual(await ids(), [pending]);
  assert.equal(await countPendingCitationScans({ filters: { degree } }), 1);

  // retryFailures re-opens the previously failed doc only.
  assert.deepEqual(await ids({ retryFailures: true }), [failedDoc, pending].sort());

  // Forced reprocess drops every gate: all streamable in-scope docs are selected
  // (the non-streamable full-text doc is still excluded).
  assert.deepEqual(
    await ids({ reprocess: true }),
    [completed, zeroCiteCompleted, failedDoc, hasCitations, pending].sort()
  );
});

test('citation re-extraction publishes links atomically and preserves the last good set on failure', async () => {
  await ensureStorage();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const docId = `scan-atomic-${suffix}`;
  await saveDocumentMetadata({ id: docId, title: 'Atomic citation fixture', supervisors: [] });
  await saveCitations(docId, [{ text: `Known, G. (2017). Last good citation. ${suffix}` }], (text) => `old-${text}`);

  await assert.rejects(
    reextractDocumentCitations(docId, [
      { text: `New, A. (2024). First staged citation. ${suffix}` },
      { text: `New, B. (2024). Second staged citation. ${suffix}` },
    ], (text) => `new-${text}`, {
      onProgress: async (event) => {
        if (event.phase === 'citation_matching' && event.counts?.processed === 2) {
          throw new Error('simulated staged-citation failure');
        }
      },
    }),
    /simulated staged-citation failure/
  );

  const linked = await loadDocumentCitations(docId);
  assert.deepEqual(linked.map((row) => row.citation_text), [`Known, G. (2017). Last good citation. ${suffix}`]);
});

test('strict citation failure preserves successful stream status and the attempted checksum', async () => {
  await ensureStorage();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const docId = `scan-strict-${suffix}`;
  await seedStreamableDoc(docId, { checksum: 'pre-stream-checksum' });
  const pdfBytes = await buildTextPdfBytes([
    'Body text',
    'REFERENCES',
    'Doe, J. (2022). A strict citation fixture. Press.',
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeCircleStreamFetch([
    { handlePart: `/handle/2429/${docId}`, recordId: 91, bitstreamId: 9091, body: pdfBytes, contentType: 'application/pdf' },
  ]);
  _setDownloadSafetyOptionsForTests({ allowOriginalPdfRetrieval: true, resolveHost: async () => [{ address: '142.103.96.1' }] });

  try {
    const doc = await loadDocumentMetadata(docId);
    await assert.rejects(
      analyzeDocumentFile(doc, {
        contentMode: 'pdf_stream',
        downloadFiles: true,
        forceDownload: true,
        recomputeFromCache: false,
        extractCommittee: false,
        extractCitations: true,
        strictCitationErrors: true,
        onProgress: async (event) => {
          if (event.phase === 'citation_extraction' && event.status === 'completed') {
            throw new Error('simulated strict extraction failure');
          }
        },
      }),
      /simulated strict extraction failure/
    );
    const metric = await loadStoredFileMetric(docId);
    assert.equal(metric.status, 'streamed');
    assert.equal(metric.content_source, 'streamed_pdf');
    assert.notEqual(metric.content_checksum, 'pre-stream-checksum');
  } finally {
    globalThis.fetch = originalFetch;
    _setDownloadSafetyOptionsForTests({ resolveHost: async () => [{ address: '142.103.96.1' }] });
  }
});

test('citation scan streams per document: success writes citations + completed state and no catalogue lookup; a failure is counted without failing the batch', async () => {
  await ensureStorage();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const degree = `Scan Run ${suffix}`;
  // doc_id order drives processing: the failing doc sorts first so we prove the
  // batch continues to the succeeding doc after a per-document failure.
  const failId = `scan-a-fail-${suffix}`;
  const okId = `scan-b-ok-${suffix}`;
  await seedStreamableDoc(failId, { degree });
  await seedStreamableDoc(okId, { degree });

  const pdfBytes = await buildTextPdfBytes([
    'Introduction to the study',
    'REFERENCES',
    'Smith, J. (2020). Teaching schools with care. Education Press.',
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeCircleStreamFetch([
    { handlePart: `/handle/2429/${failId}`, recordId: 1, bitstreamId: 9001, body: '<html>not a pdf</html>', contentType: 'text/html' },
    { handlePart: `/handle/2429/${okId}`, recordId: 2, bitstreamId: 9002, body: pdfBytes, contentType: 'application/pdf' },
  ]);
  _setDownloadSafetyOptionsForTests({ allowOriginalPdfRetrieval: true, resolveHost: async () => [{ address: '142.103.96.1' }] });

  try {
    const jobId = await createAdminJob({
      type: 'citation_scan', label: 'Citation Scan Test',
      params: { scope: { filters: { degree } }, pageSize: 10, maxDocuments: 10 }, runnerType: 'local',
    });
    const result = await runImportPdfAdminJob(await getAdminJob(jobId));

    assert.equal(result.processed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.ok, false);
    assert.equal(result.resolutionQueued, false);

    // Success doc: citations written, completed state, no catalogue lookup, no cached bytes.
    const okCitations = await loadDocumentCitations(okId);
    assert.equal(okCitations.length > 0, true);
    const okMetric = await loadStoredFileMetric(okId);
    assert.equal(okMetric.content_source, 'streamed_pdf');
    assert.equal(okMetric.pdf_path, null);
    assert.equal(okMetric.full_text_path, null);
    const db = await getDb();
    const lookupRow = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM catalogue_lookups cl JOIN document_citations dc ON dc.citation_id = cl.citation_id WHERE dc.doc_id = ?',
      args: [okId],
    });
    assert.equal(Number(lookupRow.rows[0].n), 0);

    // Failure doc: failed state recorded, no citations.
    assert.equal((await loadDocumentCitations(failId)).length, 0);
    const failState = await db.execute({
      sql: 'SELECT status, content_checksum FROM citation_extraction_state WHERE doc_id = ?', args: [failId],
    });
    assert.equal(failState.rows[0].status, 'failed');

    const okState = await db.execute({
      sql: 'SELECT status, content_checksum FROM citation_extraction_state WHERE doc_id = ?', args: [okId],
    });
    assert.equal(okState.rows[0].status, 'completed');
    assert.equal(okState.rows[0].content_checksum, okMetric.content_checksum);

    const job = await getAdminJob(jobId);
    assert.equal(job.status, 'failed');
    assert.match(job.log, /Citation scan finished/);
  } finally {
    globalThis.fetch = originalFetch;
    _setDownloadSafetyOptionsForTests({ resolveHost: async () => [{ address: '142.103.96.1' }] });
  }
});

test('citation scan continuation drains a multi-batch backlog with O(1) params_json and honors caps', async () => {
  await ensureStorage();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const degree = `Scan Drain ${suffix}`;
  const total = 5;
  const docIds = [];
  const handles = [];
  const pdfBytes = await buildTextPdfBytes([
    'Body text',
    'REFERENCES',
    'Doe, A. (2019). A drained citation. Press.',
  ]);
  for (let i = 0; i < total; i += 1) {
    const id = `scan-drain-${suffix}-${String(i).padStart(2, '0')}`;
    docIds.push(id);
    await seedStreamableDoc(id, { degree });
    handles.push({ handlePart: `/handle/2429/${id}`, recordId: i + 1, bitstreamId: 8000 + i, body: pdfBytes, contentType: 'application/pdf' });
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeCircleStreamFetch(handles);
  _setDownloadSafetyOptionsForTests({ allowOriginalPdfRetrieval: true, resolveHost: async () => [{ address: '142.103.96.1' }] });

  try {
    // Drive the durable-cursor chain in-process. autoContinue is deliberately
    // NOT set on the runner's params (that would spawn a real worker); instead
    // the seam-produced continuation params are fed back as the next batch, which
    // is exactly what the worker chain does across runs.
    const seededParams = { scope: { filters: { degree } }, pageSize: 2, maxDocuments: 2 };
    let params = seededParams;
    const continuationKeySets = [];
    let scanned = 0;
    let batches = 0;
    let guard = 0;
    for (;;) {
      if (guard++ > 20) throw new Error('drain did not terminate');
      const jobId = await createAdminJob({ type: 'citation_scan', label: 'Drain', params, runnerType: 'local' });
      // eslint-disable-next-line no-await-in-loop
      const result = await runImportPdfAdminJob(await getAdminJob(jobId));
      batches += 1;
      scanned += result.processed;
      // The per-run cap is honored: never more than maxDocuments scanned per batch.
      assert.ok(result.processed + result.failed <= 2, 'batch exceeded the maxDocuments cap');
      if (!result.batchLimitReached) break;
      // Build the next batch exactly as the production continuation would, via the
      // seam. autoContinue is added only so the gate fires for this offline check;
      // the returned params carry only a fixed-width cursor forward (O(1)).
      let nextParams = null;
      // eslint-disable-next-line no-await-in-loop
      await startCitationScanContinuation({ id: jobId, params: { ...params, autoContinue: true } }, result, null, {
        createContinuationJob: async (payload) => { nextParams = payload.params; return { jobId: jobId + 1 }; },
      });
      assert.ok(nextParams, 'expected a continuation to be scheduled while backlog remained');
      assert.equal(Array.isArray(nextParams.scannedIds), false);
      continuationKeySets.push(Object.keys(nextParams).sort().join(','));
      // Drop autoContinue before running so the runner never spawns a real worker.
      const { autoContinue, ...runnerParams } = nextParams;
      params = runnerParams;
    }

    assert.equal(scanned, total, 'every backlog document was scanned across batches');
    assert.ok(batches >= 3, 'expected the capped backlog to span multiple batches');
    for (const id of docIds) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await loadDocumentCitations(id)).length > 0, true);
    }
    // Every continuation carries the same bounded set of params keys -- nothing accumulates.
    assert.ok(continuationKeySets.length >= 2, 'expected multiple capped continuations');
    assert.ok(continuationKeySets.every((keys) => keys === continuationKeySets[0]),
      `continuation params keys drifted: ${continuationKeySets.join(' | ')}`);
    assert.equal(await countPendingCitationScans({ filters: { degree }, parserVersion: 'citation-v2' }), 0);
  } finally {
    globalThis.fetch = originalFetch;
    _setDownloadSafetyOptionsForTests({ resolveHost: async () => [{ address: '142.103.96.1' }] });
  }
});
