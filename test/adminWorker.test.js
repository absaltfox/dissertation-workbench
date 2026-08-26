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
let cancelInProcessAdminJob;
let cancelAdminWorkerJob;
let CatalogueLookupCancelledError;
let WorkerArtifactClient;
let runImportPdfAdminJob;
let runThemeRecomputeAdminJob;
let runCatalogueLookupJob;
let runPendingCatalogueLookups;
let analyzeDocumentFile;
let extractAndSaveParsedData;
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
let getDb;
let loadDocumentCitations;
let loadDocumentMetadata;
let listTopicLabelReviews;
let loadCatalogueLookup;
let loadStoredFileMetric;
let listPendingLookups;
let listPendingCitationExtractions;
let countPendingLookups;
let publishPassingTopicLabels;
let saveDocumentMetadata;
let saveCitations;
let saveCitationExtractionState;
let saveFileMetric;
let selectTopicLabelCandidate;
let updateTopicManualLabel;
let deleteTopicLabelOverride;
let validateAdminJobArtifactToken;

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
  ({ cancelInProcessAdminJob, runCatalogueLookupJob } = await import('../src/services/adminJobs.js'));
  ({ CatalogueLookupCancelledError, runPendingCatalogueLookups } = await import('../src/catalogue.js'));
  ({ WorkerArtifactClient } = await import('../src/workerArtifacts.js'));
  ({ runImportPdfAdminJob } = await import('../src/services/importPdfJobRunner.js'));
  ({ runThemeRecomputeAdminJob } = await import('../src/services/themeJobRunner.js'));
  ({ analyzeDocumentFile, extractAndSaveParsedData } = await import('../src/pdf.js'));
  const { _setDownloadSafetyOptionsForTests } = await import('../src/pdf.js');
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
    getDb,
    loadDocumentCitations,
    loadDocumentMetadata,
    listTopicLabelReviews,
    loadCatalogueLookup,
    loadStoredFileMetric,
    listPendingLookups,
    listPendingCitationExtractions,
    countPendingLookups,
    publishPassingTopicLabels,
    saveDocumentMetadata,
    saveCitations,
    saveCitationExtractionState,
    saveFileMetric,
    selectTopicLabelCandidate,
    updateTopicManualLabel,
    deleteTopicLabelOverride,
    updateAdminJob,
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
  const setup = `
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE documents (doc_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL, degree TEXT, year INTEGER, updated_at TEXT NOT NULL)")
for year in (2024, 2025):
    doc = {"id": f"auto-{year}", "title": "Community Learning Leadership", "abstract": "Community learning leadership supports schools.", "subjects": ["community learning leadership"], "degree": "Auto Degree", "year": year}
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

  await execFileAsync('python3', ['-c', 'import sqlite3, sys; db=sqlite3.connect(sys.argv[1]); db.execute("DELETE FROM documents WHERE year = 2024"); db.commit()', sqlitePath]);
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
