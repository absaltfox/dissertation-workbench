import { Router } from 'express';
import {
  deleteFileMetric, getCatalogueLookupStats,
  getFileMetricsStats, listFileMetrics, listPendingLookups, listRecentRuns,
  loadDocumentMetadata, hasRunningAdminJob
} from '../db.js';
import { deleteCachedPdf } from '../pdf.js';
import { getConceptPipelineStatus, rebuildConceptDictionary } from '../conceptsPipeline.js';
import { extractSearchTerms, runPendingCatalogueLookups } from '../catalogue.js';
import { getConfiguredApiKey } from '../secrets.js';
import { parseBooleanParam, parseNumberParam } from '../validate.js';
import { asyncHandler, getQueryValue } from '../middleware/http.js';
import { createAndStartAdminWorkerJob } from '../services/adminWorker.js';

/**
 * Creates admin operational endpoints for sync, cache, catalogue, and reparsing.
 *
 * Mounted behind admin auth and CSRF protection. Most mutating operations clear
 * the in-memory metrics cache because file metrics, parsed citations, or source
 * document metadata may have changed.
 */
export function createAdminOperationsRouter({ loadSyncModule, clearMetricsCache }) {
  const router = Router();

  router.get('/documents/sync/status', asyncHandler(async (req, res) => {
    const hasSourceParams = ['index', 'query', 'term', 'source', 'maxRecords', 'pageSize', 'scanLimit']
      .some((key) => Object.prototype.hasOwnProperty.call(req.query, key));
    const { getDocumentSyncStatus, getSyncKeyForOptions } = await loadSyncModule();
    if (!hasSourceParams) {
      res.status(200).json({ status: await getDocumentSyncStatus() });
      return;
    }
    const options = {
      index: getQueryValue(req, 'index'),
      query: getQueryValue(req, 'query'),
      term: getQueryValue(req, 'term'),
      source: getQueryValue(req, 'source'),
      maxRecords: getQueryValue(req, 'maxRecords'),
      pageSize: getQueryValue(req, 'pageSize'),
      scanLimit: getQueryValue(req, 'scanLimit'),
      apiKey: await getConfiguredApiKey(),
    };
    res.status(200).json({ status: await getDocumentSyncStatus(getSyncKeyForOptions(options)) });
  }));

  router.post('/documents/sync', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const options = {
      index: body.index ?? getQueryValue(req, 'index'),
      query: body.query ?? getQueryValue(req, 'query'),
      term: body.term ?? getQueryValue(req, 'term'),
      source: body.source ?? getQueryValue(req, 'source'),
      maxRecords: body.maxRecords ?? getQueryValue(req, 'maxRecords'),
      syncMaxRecords: body.syncMaxRecords ?? body.scanLimit ?? getQueryValue(req, 'scanLimit'),
      pageSize: body.pageSize ?? getQueryValue(req, 'pageSize'),
      scanLimit: body.scanLimit ?? getQueryValue(req, 'scanLimit'),
      downloadFiles: parseBooleanParam(body.downloadFiles ?? getQueryValue(req, 'downloadFiles'), true),
      apiKey: await getConfiguredApiKey(),
    };
    const runningId = await hasRunningAdminJob('document_sync');
    if (runningId) {
      res.status(202).json({ ok: true, alreadyRunning: true, jobId: runningId });
      return;
    }
    const result = await createAndStartAdminWorkerJob({
      type: 'document_sync',
      label: 'Open Collections Metadata Sync',
      params: { options },
    });
    clearMetricsCache();
    const { getDocumentSyncStatus } = await loadSyncModule();
    res.status(202).json({ ok: true, started: true, ...result, status: await getDocumentSyncStatus() });
  }));

  router.get('/concepts/status', asyncHandler(async (_req, res) => {
    const status = await getConceptPipelineStatus();
    res.status(200).json({ status });
  }));

  router.post('/concepts/rebuild', asyncHandler(async (_req, res) => {
    const result = await rebuildConceptDictionary({ trigger: 'manual' });
    if (!result.ok) {
      res.status(409).json({ ok: false, error: result.error || 'Rebuild failed' });
      return;
    }
    res.status(200).json({ ok: true, stats: result.artifact?.stats || null });
  }));

  router.get('/catalogue-lookup/stats', asyncHandler(async (_req, res) => {
    const stats = await getCatalogueLookupStats();
    res.status(200).json({ stats });
  }));

  router.post('/catalogue-lookup', asyncHandler(async (req, res) => {
    const limit = parseNumberParam(getQueryValue(req, 'limit'), 100);
    const dryRun = parseBooleanParam(getQueryValue(req, 'dryRun'), false);

    if (dryRun) {
      const pending = await listPendingLookups(limit);
      if (!pending.length) {
        res.status(200).json({ ok: true, dryRun: true, total: 0, previews: [] });
        return;
      }
      const previews = pending.map((row) => ({
        citationId: row.id,
        citationText: row.citation_text,
        ...extractSearchTerms(row.citation_text),
      }));
      res.status(200).json({ ok: true, dryRun: true, total: previews.length, previews });
      return;
    }

    const stats = await runPendingCatalogueLookups({ pageSize: limit });
    res.status(200).json({ ok: true, ...stats });
  }));

  router.get('/cache', asyncHandler(async (_req, res) => {
    res.status(200).json({ entries: await listFileMetrics() });
  }));

  router.get('/cache/stats', asyncHandler(async (_req, res) => {
    res.status(200).json({ stats: await getFileMetricsStats() });
  }));

  router.post('/cache/refresh', (_req, res) => {
    clearMetricsCache();
    res.status(200).json({ ok: true, message: 'In-memory cache cleared. Next query will re-fetch.' });
  });

  router.post('/cache/:docId/refresh', asyncHandler(async (req, res) => {
    const docId = req.params.docId;
    const doc = await loadDocumentMetadata(docId);
    if (!doc) {
      res.status(404).json({ error: 'Document not found in metadata store' });
      return;
    }
    const result = await createAndStartAdminWorkerJob({
      type: 'cache_refresh_doc',
      label: `Refresh PDF Analysis: ${doc.title || docId}`,
      params: { docId },
    });
    clearMetricsCache();
    res.status(202).json({ ok: true, started: true, ...result });
  }));

  router.delete('/cache/:docId', asyncHandler(async (req, res) => {
    const docId = req.params.docId;
    await deleteCachedPdf(docId);
    await deleteFileMetric(docId);
    res.status(200).json({ ok: true });
  }));

  router.post('/reparse-all', asyncHandler(async (_req, res) => {
    const runningId = await hasRunningAdminJob('reparse_all');
    if (runningId) {
      res.status(202).json({ ok: true, alreadyRunning: true, jobId: runningId });
      return;
    }
    const result = await createAndStartAdminWorkerJob({
      type: 'reparse_all',
      label: 'Reparse All Cached PDFs',
      params: {},
    });
    clearMetricsCache();
    res.status(202).json({ ok: true, started: true, ...result });
  }));

  router.post('/reparse-committee', asyncHandler(async (_req, res) => {
    const runningId = await hasRunningAdminJob('reparse_committee');
    if (runningId) {
      res.status(202).json({ ok: true, alreadyRunning: true, jobId: runningId });
      return;
    }
    const result = await createAndStartAdminWorkerJob({
      type: 'reparse_committee',
      label: 'Reparse Missing Committees',
      params: {},
    });
    clearMetricsCache();
    res.status(202).json({ ok: true, started: true, ...result });
  }));

  router.get('/runs', asyncHandler(async (_req, res) => {
    const runs = await listRecentRuns(50);
    res.status(200).json({ runs });
  }));

  return router;
}
