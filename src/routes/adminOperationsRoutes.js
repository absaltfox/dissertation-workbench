import { Router } from 'express';
import {
  clearAllCitations, deleteFileMetric, getCatalogueLookupStats, getDb,
  getFileMetricsStats, listFileMetrics, listPendingLookups, listRecentRuns,
  loadCommitteeMembers, loadDocumentMetadata
} from '../db.js';
import { deleteCachedPdf, analyzeDocumentFile, analyzePdfAtPath, extractAndSaveParsedData } from '../pdf.js';
import { getConceptPipelineStatus, rebuildConceptDictionary } from '../conceptsPipeline.js';
import { extractSearchTerms, runPendingCatalogueLookups } from '../catalogue.js';
import { getConfiguredApiKey } from '../secrets.js';
import { parseBooleanParam, parseNumberParam } from '../validate.js';
import { asyncHandler, getQueryValue } from '../middleware/http.js';
import { logger } from '../logger.js';

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
    const { startDocumentSync } = await loadSyncModule();
    const result = await startDocumentSync(options);
    clearMetricsCache();
    res.status(202).json({ ok: true, ...result });
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
    // Force a fresh PDF pass for this document, then invalidate dashboard
    // metrics that may have used stale page/word/citation values.
    await deleteCachedPdf(docId);
    await analyzeDocumentFile(doc, { downloadFiles: true, forceDownload: true, recomputeFromCache: false });
    clearMetricsCache();
    res.status(200).json({
      ok: true,
      docId,
      status: doc.downloadStatus,
      pages: doc.pages,
      pagesSource: doc.pagesSource,
      wordCount: doc.wordCount,
      wordCountSource: doc.wordCountSource,
      fileBytes: doc.fileBytes,
      downloadUrl: doc.downloadUrl,
      downloadError: doc.downloadError
    });
  }));

  router.delete('/cache/:docId', asyncHandler(async (req, res) => {
    const docId = req.params.docId;
    await deleteCachedPdf(docId);
    await deleteFileMetric(docId);
    res.status(200).json({ ok: true });
  }));

  router.post('/reparse-all', asyncHandler(async (_req, res) => {
    // Reparse-all intentionally rebuilds citation state from cached PDFs; the
    // catalogue lookup pass below repopulates lookup status for new citations.
    await clearAllCitations();
    const entries = (await listFileMetrics()).filter((e) => e.pdf_path);
    let processed = 0;
    let withCommittee = 0;
    let totalCitations = 0;

    for (const entry of entries) {
      try {
        const analysis = await analyzePdfAtPath(entry.pdf_path);
        if (!analysis.fullText) continue;
        processed++;

        const doc = await loadDocumentMetadata(entry.doc_id) || { id: entry.doc_id, supervisors: [] };
        await extractAndSaveParsedData(doc, analysis.fullText);
        if (doc.committee?.length) withCommittee++;
        if (doc.citationCount) totalCitations += Number(doc.citationCount);
      } catch (err) {
        logger.warn('Reparse failed for doc', { docId: entry.doc_id, error: err.message });
      }
    }

    const lookupStats = await runPendingCatalogueLookups();

    clearMetricsCache();
    res.status(200).json({ ok: true, processed, committees: withCommittee, citations: totalCitations, catalogueLookups: lookupStats });
  }));

  router.post('/reparse-committee', asyncHandler(async (_req, res) => {
    const targetResult = await (await getDb()).execute({
      sql: `
      SELECT fm.doc_id, fm.pdf_path
      FROM file_metrics fm
      WHERE fm.pdf_path IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM committee_members cm WHERE cm.doc_id = fm.doc_id
      )
    `});
    const targets = targetResult.rows;

    let processed = 0, withCommittee = 0;
    for (const row of targets) {
      const doc = await loadDocumentMetadata(row.doc_id);
      if (!doc) continue;
      try {
        const analysis = await analyzePdfAtPath(row.pdf_path);
        if (analysis?.fullText) {
          const before = (await loadCommitteeMembers(row.doc_id)).length;
          await extractAndSaveParsedData(doc, analysis.fullText);
          const after = (await loadCommitteeMembers(row.doc_id)).length;
          if (after > before) withCommittee++;
        }
      } catch { /* skip individual failures */ }
      processed++;
    }

    clearMetricsCache();
    res.status(200).json({ ok: true, processed, withCommittee });
  }));

  router.get('/runs', asyncHandler(async (_req, res) => {
    const runs = await listRecentRuns(50);
    res.status(200).json({ runs });
  }));

  return router;
}
