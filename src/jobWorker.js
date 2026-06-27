import {
  appendAdminJobLog, claimAdminJob, closeDb, ensureStorage, finishAdminJob, getAdminJob,
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
  await finishAdminJob(jobId, {
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
    heartbeatAdminJob(jobId, null).catch(() => {});
  }, 15_000);
  heartbeat.unref();

  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Admin worker timed out')), ADMIN_WORKER_TIMEOUT_MS);
    timer.unref();
  });

  let run;
  if (claimed.type === 'bertopic') {
    const { spawn } = await import('node:child_process');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { BERTOPIC_PYTHON_COMMAND } = await import('./config.js');

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const scriptPath = path.join(__dirname, '..', 'scripts', 'build-topics.py');

    run = new Promise((resolve, reject) => {
      const child = spawn(BERTOPIC_PYTHON_COMMAND, [scriptPath], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
        },
      });
      child.stdout.on('data', (chunk) => appendAdminJobLog(jobId, chunk.toString()).catch(() => {}));
      child.stderr.on('data', (chunk) => appendAdminJobLog(jobId, chunk.toString()).catch(() => {}));
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Local Python process exited with code ${code}`));
      });
    });
  } else {
    run = runImportPdfAdminJob(claimed, {
      artifactClient: createWorkerArtifactClientFromEnv(),
    });
  }

  try {
    await Promise.race([run, timeout]);
    finished = true;
    await updateAdminJob(jobId, { runnerState: 'completed', heartbeatAt: new Date().toISOString() });
    await appendAdminJobLog(jobId, `Worker completed job ${jobId}.\n`);
  } catch (error) {
    const status = error?.message === 'Admin worker timed out' ? 'timed_out' : 'failed';
    await finishFailure(error, status);
    await closeDb().catch(() => {});
    process.exit(status === 'timed_out' ? 124 : 1);
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
