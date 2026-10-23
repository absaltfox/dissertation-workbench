import {
  appendAdminJobLog, claimAdminJob, closeDb, ensureStorage, finishClaimedAdminJob, getAdminJob,
  failEnrichmentRolloutForJob, heartbeatClaimedAdminJob,
} from './db.js';
import { ADMIN_WORKER_GRACE_MS, ADMIN_WORKER_TIMEOUT_MS } from './config.js';
import { createWorkerArtifactClientFromEnv } from './workerArtifacts.js';
import { runImportPdfAdminJob } from './services/importPdfJobRunner.js';
import { runThemeRecomputeAdminJob } from './services/themeJobRunner.js';
import { publishTerminalFailure, terminateChild } from './services/workerLifecycle.js';

const jobId = Number(process.env.ADMIN_JOB_ID || 0);
let executionId = process.env.ADMIN_JOB_EXECUTION_ID || null;
let hasLease = false;
let activeChild = null;
let terminalPublication = null;
let shutdown = null;

async function recordCleanupFailure(context, error) {
  const message = `${context}: ${error?.message || String(error)}`;
  console.error(message);
  if (!jobId) return;
  try {
    await appendAdminJobLog(jobId, `[worker cleanup warning] ${message}\n`);
  } catch (logError) {
    console.error(`Could not record cleanup warning: ${logError?.message || String(logError)}`);
  }
}

async function publishFailure(error, status = 'failed') {
  if (!jobId || !executionId || !hasLease) return false;
  if (terminalPublication) return terminalPublication;
  terminalPublication = publishTerminalFailure({
    finish: (patch) => finishClaimedAdminJob(jobId, executionId, patch),
    failRollout: (failure) => failEnrichmentRolloutForJob(jobId, failure),
    appendLog: (line) => appendAdminJobLog(jobId, line),
    onCleanupError: recordCleanupFailure,
  }, { error, status }).then(({ published }) => published);
  return terminalPublication;
}

async function stopActiveChild() {
  const child = activeChild;
  if (!child) return;
  await terminateChild(child, { graceMs: ADMIN_WORKER_GRACE_MS });
}

async function main() {
  if (!jobId) throw new Error('ADMIN_JOB_ID is required');
  await ensureStorage();

  const claimed = await claimAdminJob(
    jobId,
    process.env.FLY_MACHINE_ID || String(process.pid),
    executionId || undefined,
  );
  if (!claimed) {
    const existing = await getAdminJob(jobId);
    throw new Error(existing ? `Job ${jobId} could not be claimed (${existing.status})` : `Job ${jobId} not found`);
  }
  executionId = claimed.executionId;
  hasLease = true;

  await appendAdminJobLog(jobId, `Worker claimed job ${jobId}.\n`);
  const heartbeat = setInterval(() => {
    heartbeatClaimedAdminJob(jobId, executionId, null).catch(() => {});
  }, 15_000);
  heartbeat.unref();

  let timeoutTimer;
  const timeout = new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => {
      const error = new Error('Admin worker timed out');
      error.workerStatus = 'timed_out';
      error.exitCode = 124;
      reject(error);
    }, ADMIN_WORKER_TIMEOUT_MS);
    timeoutTimer.unref();
  });

  let run;
  if (claimed.type === 'bertopic' || claimed.type === 'topic_labels' || claimed.type === 'concept_rebuild') {
    const { spawn } = await import('node:child_process');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { BERTOPIC_PYTHON_COMMAND } = await import('./config.js');

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const scriptPath = path.join(__dirname, '..', 'scripts', 'build-topics.py');
    const conceptScriptPath = path.join(__dirname, '..', 'scripts', 'build-concepts.py');
    const args = claimed.type === 'concept_rebuild'
      ? [conceptScriptPath]
      : claimed.type === 'topic_labels'
      ? [scriptPath, '--labels-only', ...(claimed.params?.topicId != null ? ['--topic-id', String(claimed.params.topicId)] : [])]
      : [scriptPath];

    run = new Promise((resolve, reject) => {
      const child = spawn(BERTOPIC_PYTHON_COMMAND, args, {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          ADMIN_JOB_EXECUTION_ID: executionId,
        },
      });
      activeChild = child;
      child.stdout.on('data', (chunk) => appendAdminJobLog(jobId, chunk.toString()).catch(() => {}));
      child.stderr.on('data', (chunk) => appendAdminJobLog(jobId, chunk.toString()).catch(() => {}));
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (activeChild === child) activeChild = null;
        if (code === 0) resolve();
        else reject(new Error(signal
          ? `Local Python process exited from ${signal}`
          : `Local Python process exited with code ${code}`));
      });
    });
  } else if (claimed.type === 'theme_recompute') {
    run = runThemeRecomputeAdminJob(claimed);
  } else {
    run = runImportPdfAdminJob(claimed, {
      artifactClient: createWorkerArtifactClientFromEnv(),
    });
  }

  try {
    await Promise.race([run, timeout]);
    // Some runners publish their own rich result. This is a safe fallback for
    // runners (and Python versions) that only return success to the supervisor.
    const current = await getAdminJob(jobId);
    if (current?.status === 'running') {
      await finishClaimedAdminJob(jobId, executionId, {
        status: 'completed',
        runnerState: 'completed',
        error: null,
      });
    }
    await appendAdminJobLog(jobId, `Worker completed job ${jobId}.\n`);
  } catch (error) {
    await stopActiveChild();
    const status = error?.workerStatus || 'failed';
    await publishFailure(error, status);
    error.exitCode = error.exitCode || (status === 'timed_out' ? 124 : 1);
    throw error;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeoutTimer);
  }
}

async function handleSignal(signal, exitCode) {
  if (shutdown) return shutdown;
  shutdown = (async () => {
    try {
      await stopActiveChild();
    } catch (error) {
      await recordCleanupFailure(`Failed to terminate Python child after ${signal}`, error);
    }
    try {
      await publishFailure(new Error(`Worker received ${signal}`), 'cancelled');
    } catch (error) {
      console.error(`Failed to publish signal cancellation: ${error?.message || String(error)}`);
    }
    try {
      await closeDb();
    } catch (error) {
      console.error(`Failed to close worker database after ${signal}: ${error?.message || String(error)}`);
    }
    process.exit(exitCode);
  })();
  return shutdown;
}

process.on('SIGTERM', () => { void handleSignal('SIGTERM', 143); });
process.on('SIGINT', () => { void handleSignal('SIGINT', 130); });

main()
  .catch(async (error) => {
    try {
      await publishFailure(error, error?.workerStatus || 'failed');
    } catch (publicationError) {
      console.error(`Failed to publish worker terminal state: ${publicationError?.message || String(publicationError)}`);
    }
    process.exitCode = error?.exitCode || 1;
  })
  .finally(async () => {
    try {
      await closeDb();
    } catch (error) {
      await recordCleanupFailure('Failed to close worker database', error);
    }
  });
