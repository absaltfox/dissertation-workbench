import {
  appendAdminJobLog, claimAdminJob, closeDb, ensureStorage, getAdminJob,
  heartbeatAdminJob, updateAdminJob
} from './db.js';
import { ADMIN_WORKER_TIMEOUT_MS } from './config.js';
import { createWorkerArtifactClientFromEnv } from './workerArtifacts.js';
import { runImportPdfAdminJob } from './services/importPdfJobRunner.js';

const jobId = Number(process.env.ADMIN_JOB_ID || 0);
let finished = false;

async function finishFailure(error, status = 'failed') {
  if (!jobId || finished) return;
  finished = true;
  const message = error?.message || String(error);
  await appendAdminJobLog(jobId, `Worker ${status}: ${message}\n`);
  const now = new Date().toISOString();
  await updateAdminJob(jobId, {
    status,
    runnerState: status,
    error: message,
    finishedAt: now,
  });
}

async function main() {
  if (!jobId) throw new Error('ADMIN_JOB_ID is required');
  await ensureStorage();

  const claimed = await claimAdminJob(jobId, process.env.FLY_MACHINE_ID || String(process.pid));
  if (!claimed) {
    const existing = await getAdminJob(jobId);
    throw new Error(existing ? `Job ${jobId} could not be claimed (${existing.status})` : `Job ${jobId} not found`);
  }

  await appendAdminJobLog(jobId, `Worker claimed job ${jobId}.\n`);
  const heartbeat = setInterval(() => {
    heartbeatAdminJob(jobId).catch(() => {});
  }, 15_000);
  heartbeat.unref();

  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Admin worker timed out')), ADMIN_WORKER_TIMEOUT_MS);
    timer.unref();
  });

  const run = runImportPdfAdminJob(claimed, {
    artifactClient: createWorkerArtifactClientFromEnv(),
  });

  try {
    await Promise.race([run, timeout]);
    finished = true;
    await updateAdminJob(jobId, { runnerState: 'completed', heartbeatAt: new Date().toISOString() });
    await appendAdminJobLog(jobId, `Worker completed job ${jobId}.\n`);
  } catch (error) {
    const status = error?.message === 'Admin worker timed out' ? 'timed_out' : 'failed';
    await finishFailure(error, status);
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
  }
}

process.on('SIGTERM', () => {
  finishFailure(new Error('Worker received SIGTERM'), 'cancelled')
    .finally(() => process.exit(143));
});

process.on('SIGINT', () => {
  finishFailure(new Error('Worker received SIGINT'), 'cancelled')
    .finally(() => process.exit(130));
});

main()
  .catch(async (error) => {
    await finishFailure(error, 'failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => {});
  });
