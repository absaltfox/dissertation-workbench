import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { BERTOPIC_PYTHON_COMMAND, BERTOPIC_TIMEOUT_MS, SQLITE_PATH } from '../config.js';
import { getTopicBuildStatus, updateAdminJob } from '../db.js';
import { runPendingCatalogueLookups } from '../catalogue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runningAdminJobs = new Set();

function tailLog(text, limit = 12000) {
  const value = String(text || '');
  return value.length > limit ? value.slice(value.length - limit) : value;
}

export function isAdminJobRunning(type) {
  return runningAdminJobs.has(type);
}

export function runCatalogueLookupJob(jobId, limit) {
  runningAdminJobs.add('catalogue_lookup');
  runPendingCatalogueLookups({ pageSize: limit })
    .then(async (stats) => {
      await updateAdminJob(jobId, {
        status: 'completed',
        result: stats,
        finishedAt: new Date().toISOString(),
      });
    })
    .catch(async (error) => {
      await updateAdminJob(jobId, {
        status: 'failed',
        error: error?.message || String(error),
        finishedAt: new Date().toISOString(),
      });
    })
    .finally(() => {
      runningAdminJobs.delete('catalogue_lookup');
    });
}

export function runBertopicJob(jobId, { clearMetricsCache } = {}) {
  runningAdminJobs.add('bertopic');
  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'build-topics.py');
  let timedOut = false;
  const child = spawn(BERTOPIC_PYTHON_COMMAND, [scriptPath], {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      NODE_ENV: process.env.NODE_ENV || '',
      SQLITE_PATH,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
      HF_HOME: process.env.HF_HOME || '',
      TRANSFORMERS_CACHE: process.env.TRANSFORMERS_CACHE || '',
      SENTENCE_TRANSFORMERS_HOME: process.env.SENTENCE_TRANSFORMERS_HOME || '',
    },
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 5_000).unref();
  }, BERTOPIC_TIMEOUT_MS);
  timer.unref();
  let output = '';
  child.stdout.on('data', (chunk) => {
    output = tailLog(output + chunk.toString());
  });
  child.stderr.on('data', (chunk) => {
    output = tailLog(output + chunk.toString());
  });
  child.on('error', async (error) => {
    clearTimeout(timer);
    await updateAdminJob(jobId, {
      status: 'failed',
      log: output,
      error: error?.message || String(error),
      finishedAt: new Date().toISOString(),
    });
    runningAdminJobs.delete('bertopic');
  });
  child.on('close', async (code) => {
    clearTimeout(timer);
    const status = code === 0 && !timedOut ? 'completed' : 'failed';
    await updateAdminJob(jobId, {
      status,
      log: output,
      error: status === 'completed' ? null : timedOut ? 'BERTopic process timed out' : `BERTopic process exited with code ${code}`,
      result: status === 'completed' ? await getTopicBuildStatus() : null,
      finishedAt: new Date().toISOString(),
    });
    clearMetricsCache?.();
    runningAdminJobs.delete('bertopic');
  });
}
