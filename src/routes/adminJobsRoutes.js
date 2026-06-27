import { Router } from 'express';
import {
  countPendingLookups, createAdminJob, getCatalogueLookupStats, getTopicBuildStatus,
  hasRunningAdminJob, listAdminJobs, listPendingLookups, listRecentSyncRuns
} from '../db.js';
import { extractSearchTerms } from '../catalogue.js';
import { getConceptPipelineStatus } from '../conceptsPipeline.js';
import { parseBooleanParam, parseNumberParam } from '../validate.js';
import { asyncHandler, getQueryValue } from '../middleware/http.js';
import { cancelInProcessAdminJob, isAdminJobRunning, runCatalogueLookupJob } from '../services/adminJobs.js';
import { cancelAdminWorkerJob, createAndStartAdminWorkerJob } from '../services/adminWorker.js';

/**
 * Creates admin job orchestration endpoints.
 *
 * Mounted behind admin auth and CSRF protection. Job-start endpoints return
 * `202` once a durable admin job exists; work then continues asynchronously and
 * progress is read back through `/api/admin/jobs`.
 */
export function createAdminJobsRouter({ loadSyncModule, clearMetricsCache }) {
  const router = Router();

  router.get('/jobs', asyncHandler(async (_req, res) => {
    const { getDocumentSyncStatus } = await loadSyncModule();
    const [jobs, syncRuns, catalogueStats, topicStatus, documentSyncStatus, conceptStatus] = await Promise.all([
      listAdminJobs(25),
      listRecentSyncRuns(25),
      getCatalogueLookupStats(),
      getTopicBuildStatus(),
      getDocumentSyncStatus(),
      getConceptPipelineStatus(),
    ]);
    res.status(200).json({
      jobs,
      syncRuns,
      catalogueStats,
      topicStatus,
      documentSyncStatus,
      conceptStatus,
    });
  }));

  router.post('/jobs/catalogue-lookup', asyncHandler(async (req, res) => {
    const limit = Math.min(parseNumberParam(req.body?.limit ?? getQueryValue(req, 'limit'), 100), 1000);
    const dryRun = parseBooleanParam(req.body?.dryRun ?? getQueryValue(req, 'dryRun'), false);

    if (dryRun) {
      const [pending, totalPending] = await Promise.all([
        listPendingLookups(limit),
        countPendingLookups(),
      ]);
      res.status(200).json({
        ok: true,
        dryRun: true,
        total: totalPending,
        previewTotal: pending.length,
        previews: pending.map((row) => ({
          citationId: row.id,
          citationText: row.citation_text,
          ...extractSearchTerms(row.citation_text),
        })),
      });
      return;
    }

    const runningId = isAdminJobRunning('catalogue_lookup')
      ? (await hasRunningAdminJob('catalogue_lookup'))
      : await hasRunningAdminJob('catalogue_lookup');
    if (runningId) {
      res.status(202).json({ ok: true, alreadyRunning: true, jobId: runningId });
      return;
    }
    const jobId = await createAdminJob({
      type: 'catalogue_lookup',
      label: 'Z39.50 Catalogue Lookups',
      params: { limit, pendingOnly: true },
    });
    // Run out-of-band so catalogue lookups do not hold the HTTP connection open.
    runCatalogueLookupJob(jobId, limit);
    res.status(202).json({ ok: true, started: true, jobId });
  }));

  router.post('/jobs/bertopic', asyncHandler(async (_req, res) => {
    const runningId = await hasRunningAdminJob('bertopic');
    if (runningId) {
      res.status(202).json({ ok: true, alreadyRunning: true, jobId: runningId });
      return;
    }
    const result = await createAndStartAdminWorkerJob({
      type: 'bertopic',
      label: 'BERTopic Rebuild',
      params: { script: 'scripts/build-topics.py' },
    });
    clearMetricsCache();
    res.status(202).json({ ok: true, started: true, jobId: result.jobId });
  }));

  router.post('/jobs/:id/cancel', asyncHandler(async (req, res) => {
    const jobId = Number(req.params.id || 0);
    if (!jobId) {
      res.status(400).json({ error: 'Invalid job id' });
      return;
    }
    const inProcessResult = await cancelInProcessAdminJob(jobId);
    if (inProcessResult.ok) {
      clearMetricsCache();
      res.status(200).json(inProcessResult);
      return;
    }
    const result = await cancelAdminWorkerJob(jobId);
    if (!result.ok) {
      res.status(result.error === 'Job not found' ? 404 : 409).json(result);
      return;
    }
    clearMetricsCache();
    res.status(200).json(result);
  }));

  return router;
}
