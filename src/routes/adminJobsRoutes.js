import { Router } from 'express';
import {
  createAdminJob, getCatalogueLookupStats, getTopicBuildStatus,
  hasRunningAdminJob, listAdminJobs, listPendingLookups, listRecentSyncRuns
} from '../db.js';
import { extractSearchTerms } from '../catalogue.js';
import { getConceptPipelineStatus } from '../conceptsPipeline.js';
import { parseBooleanParam, parseNumberParam } from '../validate.js';
import { asyncHandler, getQueryValue } from '../middleware/http.js';
import { isAdminJobRunning, runBertopicJob, runCatalogueLookupJob } from '../services/adminJobs.js';

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
      const pending = await listPendingLookups(limit);
      res.status(200).json({
        ok: true,
        dryRun: true,
        total: pending.length,
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
    runCatalogueLookupJob(jobId, limit);
    res.status(202).json({ ok: true, started: true, jobId });
  }));

  router.post('/jobs/bertopic', asyncHandler(async (_req, res) => {
    const runningId = isAdminJobRunning('bertopic')
      ? (await hasRunningAdminJob('bertopic'))
      : await hasRunningAdminJob('bertopic');
    if (runningId) {
      res.status(202).json({ ok: true, alreadyRunning: true, jobId: runningId });
      return;
    }
    const jobId = await createAdminJob({
      type: 'bertopic',
      label: 'BERTopic Rebuild',
      params: { script: 'scripts/build-topics.py' },
    });
    runBertopicJob(jobId, { clearMetricsCache });
    res.status(202).json({ ok: true, started: true, jobId });
  }));

  return router;
}
