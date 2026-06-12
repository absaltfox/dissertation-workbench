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

  let jobFinished = false;
  const finishJob = async (status, err, result = null) => {
    if (jobFinished) return;
    jobFinished = true;
    clearTimeout(timer);
    await updateAdminJob(jobId, {
      status,
      log: output,
      error: err,
      result,
      finishedAt: new Date().toISOString(),
    });
    if (status === 'completed') {
      clearMetricsCache?.();
    }
    runningAdminJobs.delete('bertopic');
  };

  child.on('error', async (error) => {
    await finishJob('failed', error?.message || String(error));
  });
  child.on('close', async (code) => {
    const status = code === 0 && !timedOut ? 'completed' : 'failed';
    const err = status === 'completed' ? null : timedOut ? 'BERTopic process timed out' : `BERTopic process exited with code ${code}`;
    const result = status === 'completed' ? await getTopicBuildStatus() : null;
    await finishJob(status, err, result);
  });
}

export function runImportRulesJob(jobId, { mode, scope, ruleIds, downloadFiles = true, clearMetricsCache }) {
  runningAdminJobs.add('import_rules_sync');
  let logOutput = `Starting import rules sync job (mode: ${mode}, scope: ${scope})\n`;

  const run = async () => {
    const { runDocumentSync } = await import('../sync.js');
    const { listImportRules } = await import('../db.js');
    const { getConfiguredApiKey } = await import('../secrets.js');
    const { importRuleToSyncOptions } = await import('../importRules.js');

    const allRules = await listImportRules();
    const selectedIds = Array.isArray(ruleIds)
      ? ruleIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    const rules = scope === 'all' ? allRules : allRules.filter((rule) => selectedIds.includes(rule.id));

    if (!rules.length) {
      throw new Error(scope === 'all' ? 'No import rules are saved.' : 'Select at least one import rule.');
    }

    logOutput += `Found ${rules.length} rule(s) to synchronize.\n`;
    await updateAdminJob(jobId, { log: logOutput });

    const apiKey = await getConfiguredApiKey();
    const perRule = [];
    const totals = { rulesStarted: 0, totalSeen: 0, totalSaved: 0, totalSkipped: 0 };

    for (const rule of rules) {
      logOutput += `\n[${new Date().toISOString()}] Syncing rule: "${rule.name}" (ID: ${rule.id})...\n`;
      await updateAdminJob(jobId, { log: logOutput });

      const options = importRuleToSyncOptions(rule, {
        mode,
        downloadFiles,
        apiKey,
      });

      const result = await runDocumentSync(options);
      totals.rulesStarted += 1;
      totals.totalSeen += Number(result.totalSeen || 0);
      totals.totalSaved += Number(result.totalSaved || 0);
      totals.totalSkipped += Number(result.totalSkipped || 0);

      logOutput += `Result: ${result.ok ? 'SUCCESS' : 'FAILED'} - seen: ${result.totalSeen || 0}, saved: ${result.totalSaved || 0}, skipped: ${result.totalSkipped || 0}\n`;
      if (result.error) {
        logOutput += `Error detail: ${result.error}\n`;
      }
      await updateAdminJob(jobId, { log: logOutput });

      perRule.push({
        ruleId: rule.id,
        ruleName: rule.name,
        syncKey: result.syncKey,
        ok: result.ok,
        totalSeen: result.totalSeen || 0,
        totalSaved: result.totalSaved || 0,
        totalSkipped: result.totalSkipped || 0,
        apiTotal: result.apiTotal ?? null,
        error: result.error || null,
      });
    }

    if (clearMetricsCache) {
      clearMetricsCache();
    }

    logOutput += `\n[${new Date().toISOString()}] All rules processed successfully.\n`;
    await updateAdminJob(jobId, {
      status: 'completed',
      log: logOutput,
      result: {
        ok: perRule.every((r) => r.ok),
        mode,
        scope,
        ...totals,
        rules: perRule,
      },
      finishedAt: new Date().toISOString(),
    });
  };

  run()
    .catch(async (error) => {
      logOutput += `\n[${new Date().toISOString()}] Job failed: ${error.message}\n`;
      await updateAdminJob(jobId, {
        status: 'failed',
        log: logOutput,
        error: error?.message || String(error),
        finishedAt: new Date().toISOString(),
      });
    })
    .finally(() => {
      runningAdminJobs.delete('import_rules_sync');
    });
}
