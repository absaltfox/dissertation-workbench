import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  ADMIN_WORKER_GRACE_MS, ADMIN_WORKER_MODE, ADMIN_WORKER_TIMEOUT_MS,
  FLY_API_HOSTNAME, FLY_API_TOKEN, FLY_APP_NAME, FLY_MACHINE_ID,
  FLY_WORKER_CPUS, FLY_WORKER_CPU_KIND, FLY_WORKER_MEMORY_MB,
  FLY_WORKER_REGION, IS_PRODUCTION, WORKER_IMAGE
} from '../config.js';
import {
  appendAdminJobLog, createAdminJob, finishAdminJob, getAdminJob, hashAdminJobToken,
  updateAdminJob
} from '../db.js';

const localChildren = new Map();

function isoAfter(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function shouldUseFly() {
  if (ADMIN_WORKER_MODE === 'fly') return true;
  if (ADMIN_WORKER_MODE === 'local') return false;
  if (IS_PRODUCTION && FLY_APP_NAME) {
    if (!FLY_API_TOKEN) {
      throw new Error('FLY_API_TOKEN is required for production on-demand workers. Set ADMIN_WORKER_MODE=local only for an explicit local fallback.');
    }
    return true;
  }
  return false;
}

async function flyRequest(path, options = {}) {
  const res = await fetch(`${FLY_API_HOSTNAME}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${FLY_API_TOKEN}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Fly Machines API ${res.status}: ${body.slice(0, 240)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function workerStartPublicMessage(error) {
  const message = error?.message || String(error);
  if (message.includes('FLY_API_TOKEN is required')) {
    return 'Admin workers are configured for Fly, but FLY_API_TOKEN is not set.';
  }
  if (message.includes('Fly Machines API 401') || message.includes('Fly Machines API 403')) {
    return 'Fly rejected the configured FLY_API_TOKEN. Update the Fly secret with a token that can create and destroy Machines for this app.';
  }
  if (message.includes('Fly Machines API')) {
    return 'Fly could not start the admin worker. Check the app logs for the Machines API response.';
  }
  return 'The admin worker could not be started. Check the app logs for details.';
}

function adminWorkerStartError(error) {
  const wrapped = new Error(workerStartPublicMessage(error));
  wrapped.statusCode = 503;
  wrapped.publicMessage = wrapped.message;
  wrapped.cause = error;
  return wrapped;
}

async function resolveWorkerImage() {
  if (WORKER_IMAGE) return WORKER_IMAGE;
  if (!FLY_APP_NAME || !FLY_MACHINE_ID) {
    throw new Error('WORKER_IMAGE is required when current Fly machine image cannot be discovered.');
  }
  const machine = await flyRequest(`/v1/apps/${encodeURIComponent(FLY_APP_NAME)}/machines/${encodeURIComponent(FLY_MACHINE_ID)}`);
  const image = machine?.config?.image || machine?.image_ref?.registry || machine?.image_ref?.repository;
  if (!image) throw new Error('Unable to discover current Fly image; set WORKER_IMAGE.');
  return image;
}

export function buildFlyWorkerMachinePayload({ image, jobId, token, timeoutMs = ADMIN_WORKER_TIMEOUT_MS, jobType = null }) {
  const isBertopic = jobType === 'bertopic';
  const workerImage = isBertopic
    ? (process.env.BERTOPIC_WORKER_IMAGE || image)
    : image;
  const execCmd = isBertopic
    ? ['python3', 'scripts/build-topics.py']
    : ['node', 'src/jobWorker.js'];
  const memoryMb = isBertopic
    ? 2048 // BERTopic needs at least 2GB RAM
    : FLY_WORKER_MEMORY_MB;

  const env = {
    ADMIN_JOB_ID: String(jobId),
    ADMIN_JOB_ARTIFACT_TOKEN: token,
    ADMIN_WORKER_TIMEOUT_MS: String(timeoutMs),
    DOCUMENT_SYNC_ENABLED: '0',
    DOCUMENT_SYNC_ON_START: '0',
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL || '',
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN || '',
    SQLITE_PATH: process.env.SQLITE_PATH || '',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  };
  const config = {
    image: workerImage,
    auto_destroy: true,
    restart: { policy: 'no' },
    env,
    init: { exec: execCmd },
    guest: {
      cpu_kind: FLY_WORKER_CPU_KIND,
      cpus: FLY_WORKER_CPUS,
      memory_mb: memoryMb,
    },
    metadata: {
      role: 'admin-worker',
      admin_job_id: String(jobId),
    },
  };
  return {
    name: `admin-job-${jobId}`,
    region: FLY_WORKER_REGION || undefined,
    skip_service_registration: true,
    config,
  };
}

async function startFlyWorker(jobId, token) {
  const job = await getAdminJob(jobId);
  const image = await resolveWorkerImage();
  const payload = buildFlyWorkerMachinePayload({ image, jobId, token, jobType: job?.type });
  const machine = await flyRequest(`/v1/apps/${encodeURIComponent(FLY_APP_NAME)}/machines`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  await updateAdminJob(jobId, {
    runnerType: 'fly',
    runnerId: machine?.id || null,
    runnerState: machine?.state || 'created',
  });
  await appendAdminJobLog(jobId, `Started Fly worker machine ${machine?.id || '(unknown)'}.\n`);
  return machine;
}

function startLocalWorker(jobId, token) {
  const child = spawn(process.execPath, ['src/jobWorker.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ADMIN_JOB_ID: String(jobId),
      ADMIN_JOB_ARTIFACT_TOKEN: token,
      ADMIN_WORKER_TIMEOUT_MS: String(ADMIN_WORKER_TIMEOUT_MS),
      DOCUMENT_SYNC_ENABLED: '0',
      DOCUMENT_SYNC_ON_START: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(async () => {
    await appendAdminJobLog(jobId, 'Local worker timed out; terminating process.\n');
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), ADMIN_WORKER_GRACE_MS).unref();
  }, ADMIN_WORKER_TIMEOUT_MS);
  timer.unref();

  localChildren.set(jobId, { child, timer });
  updateAdminJob(jobId, {
    runnerType: 'local',
    runnerId: String(child.pid || ''),
    runnerState: 'running',
  }).catch(() => {});
  child.stdout.on('data', (chunk) => appendAdminJobLog(jobId, chunk.toString()).catch(() => {}));
  child.stderr.on('data', (chunk) => appendAdminJobLog(jobId, chunk.toString()).catch(() => {}));
  child.on('close', async (code, signal) => {
    clearTimeout(timer);
    localChildren.delete(jobId);
    await updateAdminJob(jobId, { runnerState: signal ? `exited:${signal}` : `exited:${code}` });
  });
  return child;
}

export async function createAndStartAdminWorkerJob({ type, label, params = null }) {
  const token = crypto.randomBytes(32).toString('hex');
  let runnerType;
  try {
    runnerType = shouldUseFly() ? 'fly' : 'local';
  } catch (error) {
    throw adminWorkerStartError(error);
  }
  const jobId = await createAdminJob({
    type,
    label,
    params,
    artifactTokenHash: hashAdminJobToken(token),
    timeoutAt: isoAfter(ADMIN_WORKER_TIMEOUT_MS),
    runnerType,
  });
  try {
    if (runnerType === 'fly') {
      await startFlyWorker(jobId, token);
    } else {
      startLocalWorker(jobId, token);
    }
  } catch (error) {
    await finishAdminJob(jobId, {
      status: 'failed',
      runnerState: 'failed_to_start',
      error: error?.message || String(error),
      finishedAt: new Date().toISOString(),
    });
    throw adminWorkerStartError(error);
  }
  return { jobId, runnerType };
}

export async function cancelAdminWorkerJob(jobId) {
  const job = await getAdminJob(jobId);
  if (!job) return { ok: false, error: 'Job not found' };
  if (job.status !== 'running') return { ok: false, error: 'Job is not running' };

  if (job.runnerType === 'fly' && job.runnerId) {
    try {
      await flyRequest(`/v1/apps/${encodeURIComponent(FLY_APP_NAME)}/machines/${encodeURIComponent(job.runnerId)}?force=true`, {
        method: 'DELETE',
      });
    } catch (error) {
      await appendAdminJobLog(jobId, `Fly worker destroy failed: ${error?.message || String(error)}\n`);
      await updateAdminJob(jobId, { runnerState: 'kill_failed' });
      return { ok: false, error: `Fly worker destroy failed: ${error?.message || String(error)}` };
    }
  }

  if (job.runnerType === 'local') {
    const entry = localChildren.get(Number(jobId));
    if (entry?.child) {
      entry.child.kill('SIGTERM');
      setTimeout(() => entry.child.kill('SIGKILL'), ADMIN_WORKER_GRACE_MS).unref();
      clearTimeout(entry.timer);
      localChildren.delete(Number(jobId));
    }
  }

  const now = new Date().toISOString();
  await finishAdminJob(jobId, {
    status: 'cancelled',
    runnerState: 'cancelled',
    cancelledAt: now,
    finishedAt: now,
  });
  await appendAdminJobLog(jobId, 'Job cancelled by administrator.\n');
  return { ok: true };
}
