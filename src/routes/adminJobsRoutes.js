import { Router } from 'express';
import {
  countPendingCitationScans, countPendingLookups, createAdminJob, getCatalogueLookupStats,
  getTopicBuildStatus, hasRunningAdminJob, listAdminJobs, listPendingLookups, listRecentSyncRuns
} from '../db.js';
import {
  ADMIN_WORKER_TIMEOUT_MS, CITATION_SCAN_MAX_DOCUMENTS,
  CITATION_SCAN_NIGHTLY_ENABLED, CITATION_SCAN_NIGHTLY_HOUR_LOCAL, CITATION_SCAN_PAGE_SIZE
} from '../config.js';
import { extractSearchTerms } from '../catalogue.js';
import { getConceptPipelineStatus } from '../conceptsPipeline.js';
import { parseBooleanParam, parseNumberParam } from '../validate.js';
import { asyncHandler, getQueryValue } from '../middleware/http.js';
import { cancelInProcessAdminJob, runCatalogueLookupJob } from '../services/adminJobs.js';
import { cancelAdminWorkerJob, createAndStartAdminWorkerJob } from '../services/adminWorker.js';

// Next local occurrence of `hourLocal`:00 as an ISO string (mirrors the daily
// scheduler math in server.js) for the read-only schedule status card.
function nextDailyRunIso(hourLocal) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hourLocal, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/**
 * Creates admin job orchestration endpoints.
 *
 * Mounted behind admin auth and CSRF protection. Job-start endpoints return
 * `202` once a durable admin job exists; work then continues asynchronously and
 * progress is read back through `/api/admin/jobs`.
 */
export function createAdminJobsRouter({ loadSyncModule, clearMetricsCache }) {
  const router = Router();

  const citationScope = (body = {}) => ({
    syncKey: String(body.syncKey || '').trim().slice(0, 2000) || null,
    filters: {
      degree: String(body.degree || '').trim().slice(0, 250),
      program: String(body.program || '').trim().slice(0, 250),
      affiliation: String(body.affiliation || '').trim().slice(0, 250),
    },
  });

  router.get('/jobs', asyncHandler(async (_req, res) => {
    const { getDocumentSyncStatus } = await loadSyncModule();
    const [jobs, syncRuns, catalogueStats, topicStatus, documentSyncStatus, conceptStatus, citationScanPending] = await Promise.all([
      listAdminJobs(25),
      listRecentSyncRuns(25),
      getCatalogueLookupStats(),
      getTopicBuildStatus(),
      getDocumentSyncStatus(),
      getConceptPipelineStatus(),
      countPendingCitationScans({}),
    ]);
    // Read-only schedule state for the Citation Scan status card, mirroring how
    // conceptStatus feeds the concept card. lastRun comes from the most recent
    // citation_scan admin job in the fetched window.
    const lastCitationScan = jobs.find((job) => job.type === 'citation_scan') || null;
    const citationScanStatus = {
      enabled: CITATION_SCAN_NIGHTLY_ENABLED,
      hourLocal: CITATION_SCAN_NIGHTLY_HOUR_LOCAL,
      lastRun: lastCitationScan
        ? { status: lastCitationScan.status, startedAt: lastCitationScan.startedAt, finishedAt: lastCitationScan.finishedAt }
        : null,
      nextRun: CITATION_SCAN_NIGHTLY_ENABLED ? nextDailyRunIso(CITATION_SCAN_NIGHTLY_HOUR_LOCAL) : null,
      pendingCount: citationScanPending,
    };
    res.status(200).json({
      jobs,
      syncRuns,
      catalogueStats,
      topicStatus,
      documentSyncStatus,
      conceptStatus,
      citationScanStatus,
    });
  }));

  router.post('/jobs/catalogue-lookup', asyncHandler(async (req, res) => {
    const limit = Math.min(parseNumberParam(req.body?.limit ?? getQueryValue(req, 'limit'), 100), 1000);
    const dryRun = parseBooleanParam(req.body?.dryRun ?? getQueryValue(req, 'dryRun'), false);
    const scope = citationScope(req.body || {});

    if (dryRun) {
      const [pending, totalPending] = await Promise.all([
        listPendingLookups({ limit, ...scope }),
        countPendingLookups(scope),
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

    const runningId = await hasRunningAdminJob('catalogue_lookup');
    if (runningId) {
      res.status(202).json({ ok: true, alreadyRunning: true, jobId: runningId });
      return;
    }
    const jobId = await createAdminJob({
      type: 'catalogue_lookup',
      label: 'Z39.50 Catalogue Lookups',
      params: { limit, pendingOnly: true, scope },
      timeoutAt: new Date(Date.now() + ADMIN_WORKER_TIMEOUT_MS).toISOString(),
    });
    // Run out-of-band so catalogue lookups do not hold the HTTP connection open.
    runCatalogueLookupJob(jobId, limit, { scope });
    res.status(202).json({ ok: true, started: true, jobId });
  }));

  router.post('/jobs/citation-scan', asyncHandler(async (req, res) => {
    const body = req.body || {};
    // Forced reprocess re-scans already-scanned documents (implies retryFailures);
    // autoContinue chains batches so one on-demand run drains the whole backlog.
    // The nightly scheduled fire sets neither.
    const reprocess = parseBooleanParam(body.reprocess, false);
    const retryFailures = reprocess || parseBooleanParam(body.retryFailures, false);
    const autoContinue = parseBooleanParam(body.autoContinue, false);
    const scope = citationScope(body);

    // Preview affordance: count the documents that currently qualify. Starts no
    // work — like the catalogue-lookup dry run.
    const dryRun = parseBooleanParam(body.dryRun ?? getQueryValue(req, 'dryRun'), false);
    if (dryRun) {
      const total = await countPendingCitationScans({
        syncKey: scope.syncKey,
        filters: scope.filters,
        retryFailures,
        reprocess,
      });
      res.status(200).json({ ok: true, dryRun: true, total, retryFailures, reprocess });
      return;
    }

    const runningId = await hasRunningAdminJob('citation_scan');
    if (runningId) {
      res.status(202).json({ ok: true, alreadyRunning: true, jobId: runningId });
      return;
    }
    const result = await createAndStartAdminWorkerJob({
      type: 'citation_scan',
      label: 'Citation Scan',
      params: {
        trigger: 'manual',
        pageSize: Math.max(1, Math.min(250, Number(body.pageSize) || CITATION_SCAN_PAGE_SIZE)),
        maxDocuments: Math.max(1, Math.min(5000, Number(body.maxDocuments) || CITATION_SCAN_MAX_DOCUMENTS)),
        retryFailures,
        reprocess,
        autoContinue,
        scope,
      },
    });
    clearMetricsCache();
    res.status(202).json({ ok: true, started: true, ...result });
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
