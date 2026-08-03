import {
  appendAdminJobLog, finishAdminJob, getDb, listFileMetrics, listImportRules,
  listPendingCitationExtractions, loadCommitteeMembers, loadDocumentMetadata,
  saveCitationExtractionState, updateAdminJobProgress
} from '../db.js';
import fs from 'node:fs/promises';
import {
  analyzeDocumentFile, analyzePdfAtPath, deleteCachedPdf, extractAndSaveParsedData
} from '../pdf.js';
import { getConfiguredApiKey } from '../secrets.js';
import {
  contentModeEnrichesDocuments, importRuleToSyncOptions, validateImportRule
} from '../importRules.js';
import { IMPORT_PDF_BATCH_SIZE } from '../config.js';

async function log(jobId, message) {
  await appendAdminJobLog(jobId, `[${new Date().toISOString()}] ${message}\n`);
}

function createProgressReporter(jobId) {
  const tasks = [];
  const taskIndex = new Map();

  return async function report(event = {}) {
    const key = event.phase || event.key || event.label || 'running';
    const label = event.label || event.currentTask || key;
    const status = event.status || 'running';
    const task = {
      key,
      label,
      status,
      detail: event.detail || null,
      counts: event.counts || null,
      updatedAt: new Date().toISOString(),
    };
    if (taskIndex.has(key)) {
      tasks[taskIndex.get(key)] = task;
    } else {
      taskIndex.set(key, tasks.length);
      tasks.push(task);
    }
    await updateAdminJobProgress(jobId, {
      phase: key,
      currentTask: status === 'completed' ? event.nextTask || label : label,
      tasks,
      counts: event.counts || null,
    });
  };
}

function readPdfBatchSize(params = {}) {
  const value = Number(params.pdfBatchSize || IMPORT_PDF_BATCH_SIZE || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function readDocIdList(value) {
  return Array.isArray(value)
    ? value.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
}

async function startContinuationJob(job, result, progress) {
  const params = job.params || {};
  if (params.mode !== 'sync_missing_pdfs') return null;
  if (!params.autoContinuePdfBatches) return null;
  if (!result.ok || !result.pdfBatchLimitReached || Number(result.totalEnrichmentAttempted || 0) <= 0) return null;

  const nextParams = {
    ...params,
    rules: rulesForContinuation(params.rules, result.rules),
    continuationOf: params.continuationOf || job.id,
    previousJobId: job.id,
    skipPdfDocIds: result.pdfAttemptedIds || [],
  };
  await progress?.({
    phase: 'continuation',
    label: 'Scheduling next PDF batch',
    status: 'running',
    counts: { saved: result.totalSaved || 0 },
  });

  try {
    const { createAndStartAdminWorkerJob } = await import('./adminWorker.js');
    const next = await createAndStartAdminWorkerJob({
      type: 'import_rules_sync',
      label: 'Import Rules Sync (PDF batch)',
      params: nextParams,
    });
    await log(job.id, `Scheduled next PDF batch as job ${next.jobId}.`);
    await progress?.({
      phase: 'continuation',
      label: 'Scheduled next PDF batch',
      status: 'completed',
      detail: `Job ${next.jobId}`,
    });
    return next;
  } catch (error) {
    const message = error?.message || String(error);
    await log(job.id, `Could not schedule next PDF batch: ${message}`);
    await progress?.({
      phase: 'continuation',
      label: 'Next PDF batch was not scheduled',
      status: 'failed',
      detail: message,
    });
    return { error: message };
  }
}

export function rulesForContinuation(rules, completedRuleResults) {
  if (!Array.isArray(rules)) return rules;
  const completedByRuleId = new Map(
    (Array.isArray(completedRuleResults) ? completedRuleResults : [])
      .map((result) => [String(result?.ruleId || ''), result])
      .filter(([ruleId]) => ruleId)
  );
  return rules.filter((rule) => {
    const result = completedByRuleId.get(String(rule?.id || ''));
    return !result || Boolean(result.pdfBatchLimitReached);
  });
}

async function analyzePdfEntry(entry, artifactClient, {
  keepPdfPath = false,
  progress = null,
  counts = null,
  label = 'Parsing cached PDF text',
} = {}) {
  const progressCounts = counts || null;
  if (artifactClient) {
    await progress?.({
      phase: 'pdf_parse',
      label: 'Fetching cached PDF for parsing',
      detail: entry.doc_id,
      status: 'running',
      counts: progressCounts,
    });
    const remote = await artifactClient.downloadPdfToTemp(entry.doc_id);
    if (!remote?.path) {
      await progress?.({
        phase: 'pdf_parse',
        label: 'Cached PDF unavailable for parsing',
        detail: entry.doc_id,
        status: 'failed',
        counts: progressCounts,
      });
      return null;
    }
    try {
      await progress?.({
        phase: 'pdf_parse',
        label,
        detail: entry.doc_id,
        status: 'running',
        counts: progressCounts,
      });
      const analysis = await analyzePdfAtPath(remote.path);
      await progress?.({
        phase: 'pdf_parse',
        label: 'Parsed cached PDF text',
        detail: entry.doc_id,
        status: 'completed',
        counts: {
          ...(progressCounts || {}),
          pages: analysis.pageCount || 0,
          words: analysis.wordCount || 0,
        },
      });
      if (keepPdfPath) {
        return { ...analysis, pdfPath: remote.path, cleanup: remote.cleanup };
      }
      await remote.cleanup?.();
      return analysis;
    } catch (error) {
      await progress?.({
        phase: 'pdf_parse',
        label: 'Cached PDF parsing failed',
        detail: entry.doc_id,
        status: 'failed',
        counts: progressCounts,
      });
      await remote.cleanup?.();
      throw error;
    }
  }
  await progress?.({
    phase: 'pdf_parse',
    label,
    detail: entry.doc_id,
    status: 'running',
    counts: progressCounts,
  });
  try {
    const analysis = await analyzePdfAtPath(entry.pdf_path);
    await progress?.({
      phase: 'pdf_parse',
      label: 'Parsed cached PDF text',
      detail: entry.doc_id,
      status: 'completed',
      counts: {
        ...(progressCounts || {}),
        pages: analysis.pageCount || 0,
        words: analysis.wordCount || 0,
      },
    });
    return keepPdfPath ? { ...analysis, pdfPath: entry.pdf_path } : analysis;
  } catch (error) {
    await progress?.({
      phase: 'pdf_parse',
      label: 'Cached PDF parsing failed',
      detail: entry.doc_id,
      status: 'failed',
      counts: progressCounts,
    });
    throw error;
  }
}

const CITATION_PARSER_VERSION = 'citation-v2';

async function loadCitationSource(entry, artifactClient, progress, counts = null) {
  if (entry.pdf_path) {
    const analysis = await analyzePdfEntry(entry, artifactClient, {
      keepPdfPath: true,
      progress,
      counts,
      label: 'Parsing cached PDF text for citations',
    });
    return analysis ? {
      fullText: analysis.fullText || '',
      pdfPath: analysis.pdfPath || null,
      cleanup: analysis.cleanup || null,
    } : null;
  }
  if (!entry.full_text_path) return null;
  if (artifactClient) {
    const artifact = await artifactClient.downloadFullText(entry.doc_id);
    return artifact?.fullText ? { fullText: artifact.fullText, pdfPath: null, cleanup: null } : null;
  }
  return {
    fullText: await fs.readFile(entry.full_text_path, 'utf8'),
    pdfPath: null,
    cleanup: null,
  };
}

export async function runImportPdfAdminJob(job, { artifactClient = null, clearMetricsCache = null } = {}) {
  const params = job.params || {};
  const progress = createProgressReporter(job.id);

  if (job.type === 'document_sync') {
    const { runDocumentSync } = await import('../sync.js');
    await log(job.id, 'Starting Open Collections document sync.');
    await progress({ phase: 'document_sync', label: 'Syncing Open Collections metadata', status: 'running' });
    const result = await runDocumentSync({
      ...(params.options || {}),
      apiKey: await getConfiguredApiKey(),
      artifactClient,
    });
    clearMetricsCache?.();
    await finishAdminJob(job.id, {
      status: result.ok ? 'completed' : 'failed',
      result,
      error: result.ok ? null : result.error || 'Document sync failed',
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Document sync finished: ${result.totalSaved || 0} saved, ${result.totalSkipped || 0} skipped.`);
    await progress({
      phase: 'document_sync',
      label: 'Open Collections metadata sync',
      status: 'completed',
      counts: { saved: result.totalSaved || 0, skipped: result.totalSkipped || 0 },
    });
    return result;
  }

  if (job.type === 'import_rules_sync') {
    const { runDocumentSync } = await import('../sync.js');
    const allRules = await listImportRules();
    const selectedIds = Array.isArray(params.ruleIds)
      ? params.ruleIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    const snapshottedRules = Array.isArray(params.rules)
      ? params.rules.map((input) => {
          const { rule, errors } = validateImportRule(input);
          if (errors.length) throw new Error(`Invalid snapshotted import rule: ${errors.join(' ')}`);
          return rule;
        })
      : [];
    const rules = snapshottedRules.length
      ? snapshottedRules
      : params.scope === 'all' ? allRules : allRules.filter((rule) => selectedIds.includes(rule.id));
    if (!rules.length) throw new Error(params.scope === 'all' ? 'No import rules are saved.' : 'Select at least one import rule.');
    for (const input of rules) {
      const { errors } = validateImportRule(input);
      if (errors.length) throw new Error(`Invalid import rule: ${errors.join(' ')}`);
    }

    await log(job.id, `Starting import rules sync (${params.mode}, ${params.scope}).`);
    await progress({ phase: 'import_rules', label: 'Running import rules', status: 'running' });
    const apiKey = await getConfiguredApiKey();
    const perRule = [];
    const pdfBatchSize = readPdfBatchSize(params);
    const attemptedPdfIds = new Set(readDocIdList(params.skipPdfDocIds));
    const totals = {
      rulesStarted: 0,
      totalSeen: 0,
      totalSaved: 0,
      totalSkipped: 0,
      totalEnrichmentAttempted: 0,
      totalEnriched: 0,
      totalEnrichmentFailed: 0,
    };
    const requestCounts = { metadata: 0, fullText: 0, originalPdf: 0, retrievedBytes: 0 };
    let pdfBatchLimitReached = false;
    for (const rule of rules) {
      const enrichesDocuments = contentModeEnrichesDocuments(rule.contentMode);
      const remainingPdfBatchSize = params.mode === 'sync_missing_pdfs' && enrichesDocuments && pdfBatchSize
        ? Math.max(0, pdfBatchSize - totals.totalEnrichmentAttempted)
        : 0;
      if (params.mode === 'sync_missing_pdfs' && enrichesDocuments && pdfBatchSize && remainingPdfBatchSize <= 0) {
        pdfBatchLimitReached = true;
        break;
      }
      await log(job.id, `Syncing rule "${rule.name}" (${rule.id}).`);
      await progress({
        phase: 'import_rules',
        label: 'Running import rules',
        detail: `Syncing ${rule.name}`,
        status: 'running',
        counts: { processed: perRule.length, total: rules.length },
      });
      const result = await runDocumentSync({
        ...importRuleToSyncOptions(rule, {
          mode: params.mode,
          apiKey,
        }),
        artifactClient,
        onProgress: async (event = {}) => progress({
          ...event,
          detail: event.detail || `Syncing ${rule.name}`,
        }),
        pdfBatchSize: params.mode === 'sync_missing_pdfs' && enrichesDocuments ? remainingPdfBatchSize : 0,
        skipPdfDocIds: Array.from(attemptedPdfIds),
      });
      totals.rulesStarted += 1;
      totals.totalSeen += Number(result.totalSeen || 0);
      totals.totalSaved += Number(result.totalSaved || 0);
      totals.totalSkipped += Number(result.totalSkipped || 0);
      requestCounts.metadata += Number(result.requestCounts?.metadata || 0);
      requestCounts.fullText += Number(result.requestCounts?.fullText || 0);
      requestCounts.originalPdf += Number(result.requestCounts?.originalPdf || 0);
      requestCounts.retrievedBytes += Number(result.requestCounts?.retrievedBytes || 0);
      totals.totalEnrichmentAttempted += Number(result.totalEnrichmentAttempted || 0);
      totals.totalEnriched += Number(result.totalEnriched || 0);
      totals.totalEnrichmentFailed += Number(result.totalEnrichmentFailed || 0);
      for (const docId of readDocIdList(result.pdfAttemptedIds)) attemptedPdfIds.add(docId);
      if (result.pdfBatchLimitReached) pdfBatchLimitReached = true;
      perRule.push({
        ruleId: rule.id,
        ruleName: rule.name,
        contentMode: rule.contentMode,
        syncKey: result.syncKey,
        ok: result.ok,
        totalSeen: result.totalSeen || 0,
        totalSaved: result.totalSaved || 0,
        totalSkipped: result.totalSkipped || 0,
        apiTotal: result.apiTotal ?? null,
        pdfBatchLimitReached: Boolean(result.pdfBatchLimitReached),
        pdfAttempted: Array.isArray(result.pdfAttemptedIds) ? result.pdfAttemptedIds.length : 0,
        totalEnrichmentAttempted: Number(result.totalEnrichmentAttempted || 0),
        totalEnriched: Number(result.totalEnriched || 0),
        totalEnrichmentFailed: Number(result.totalEnrichmentFailed || 0),
        requestCounts: result.requestCounts || {
          metadata: 0, fullText: 0, originalPdf: 0, retrievedBytes: 0,
        },
        error: result.error || null,
      });
      await log(job.id, `Rule result: ${result.ok ? 'success' : 'failed'}; ${result.totalSaved || 0} saved.`);
      if (
        params.mode === 'sync_missing_pdfs'
        && enrichesDocuments
        && pdfBatchSize
        && totals.totalEnrichmentAttempted >= pdfBatchSize
      ) {
        pdfBatchLimitReached = true;
        break;
      }
    }
    const result = {
      ok: perRule.every((item) => item.ok),
      mode: params.mode,
      scope: params.scope,
      pdfBatchSize: params.mode === 'sync_missing_pdfs' ? pdfBatchSize : null,
      pdfBatchLimitReached,
      pdfAttemptedIds: Array.from(attemptedPdfIds),
      requestCounts,
      ...totals,
      rules: perRule,
    };
    const continuation = await startContinuationJob(job, result, progress);
    if (continuation?.jobId) result.nextJobId = continuation.jobId;
    if (continuation?.error) result.continuationError = continuation.error;
    clearMetricsCache?.();
    await finishAdminJob(job.id, {
      status: result.ok ? 'completed' : 'failed',
      result,
      error: result.ok ? null : 'One or more import rules failed.',
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, 'Import rules sync finished.');
    await progress({
      phase: 'import_rules',
      label: 'Import rules sync',
      status: 'completed',
      counts: { processed: perRule.length, total: rules.length, saved: totals.totalSaved },
    });
    return result;
  }

  if (job.type === 'cache_refresh_doc') {
    const docId = params.docId;
    await progress({ phase: 'metadata', label: 'Loading document metadata', status: 'running', detail: docId });
    const doc = await loadDocumentMetadata(docId);
    if (!doc) throw new Error('Document not found in metadata store');
    await progress({ phase: 'metadata', label: 'Loaded document metadata', status: 'completed', detail: docId });
    await log(job.id, `Refreshing PDF/full-text analysis for ${docId}.`);
    if (!artifactClient) await deleteCachedPdf(docId);
    await analyzeDocumentFile(doc, {
      downloadFiles: true,
      forceDownload: true,
      recomputeFromCache: false,
      artifactClient,
      onProgress: progress,
      extractCitations: false,
    });
    const result = {
      ok: true,
      docId,
      status: doc.downloadStatus,
      pages: doc.pages,
      pagesSource: doc.pagesSource,
      wordCount: doc.wordCount,
      wordCountSource: doc.wordCountSource,
      fileBytes: doc.fileBytes,
      downloadUrl: doc.downloadUrl,
      downloadError: doc.downloadError || null,
    };
    clearMetricsCache?.();
    await finishAdminJob(job.id, {
      status: 'completed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Refresh finished for ${docId}.`);
    await progress({
      phase: 'complete',
      label: 'Refresh complete',
      status: 'completed',
      counts: { pages: doc.pages || 0, words: doc.wordCount || 0, citations: doc.citationCount || 0 },
    });
    return result;
  }

  if (job.type === 'cache_reanalyze_doc') {
    const docId = params.docId;
    await progress({ phase: 'metadata', label: 'Loading document metadata', status: 'running', detail: docId });
    const doc = await loadDocumentMetadata(docId);
    if (!doc) throw new Error('Document not found in metadata store');
    await progress({ phase: 'metadata', label: 'Loaded document metadata', status: 'completed', detail: docId });
    await log(job.id, `Reanalyzing cached PDF/full-text for ${docId}.`);
    await analyzeDocumentFile(doc, {
      downloadFiles: false,
      forceDownload: false,
      recomputeFromCache: true,
      artifactClient,
      onProgress: progress,
      extractCommittee: true,
      extractCitations: false,
    });
    const result = {
      ok: doc.downloadStatus !== 'cache_miss' && doc.downloadStatus !== 'cache_error',
      docId,
      status: doc.downloadStatus,
      pages: doc.pages,
      pagesSource: doc.pagesSource,
      wordCount: doc.wordCount,
      wordCountSource: doc.wordCountSource,
      fileBytes: doc.fileBytes,
      downloadUrl: doc.downloadUrl,
      downloadError: doc.downloadError || null,
    };
    clearMetricsCache?.();
    await finishAdminJob(job.id, {
      status: result.ok ? 'completed' : 'failed',
      result,
      error: result.ok ? null : result.downloadError || 'Cached PDF/full-text reanalysis failed.',
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Cached reanalysis finished for ${docId}: ${result.status || 'unknown'}.`);
    await progress({
      phase: 'complete',
      label: 'Cached reanalysis complete',
      status: 'completed',
      counts: { pages: doc.pages || 0, words: doc.wordCount || 0 },
    });
    return result;
  }

  if (job.type === 'cache_reextract_citations_doc') {
    const docId = params.docId;
    await progress({ phase: 'metadata', label: 'Loading document metadata', status: 'running', detail: docId });
    const doc = await loadDocumentMetadata(docId);
    if (!doc) throw new Error('Document not found in metadata store');
    await progress({ phase: 'metadata', label: 'Loaded document metadata', status: 'completed', detail: docId });
    await log(job.id, `Re-extracting cached PDF citations for ${docId}.`);
    const entry = (await listFileMetrics()).find((item) => item.doc_id === docId && item.pdf_path);
    if (!entry) throw new Error('No cached PDF available for citation extraction.');
    const analysis = await analyzePdfEntry(entry, artifactClient, {
      keepPdfPath: true,
      progress,
      label: 'Parsing cached PDF text for citations',
    });
    try {
      if (!analysis?.fullText) {
        const error = 'Cached PDF text extraction returned no text.';
        await saveCitationExtractionState(docId, {
          contentChecksum: entry.content_checksum || entry.updated_at || null,
          parserVersion: CITATION_PARSER_VERSION,
          status: 'failed',
          citationCount: 0,
          error,
        });
        const result = {
          ok: false,
          docId,
          citations: 0,
          error,
        };
        clearMetricsCache?.();
        await finishAdminJob(job.id, {
          status: 'failed',
          result,
          error,
          finishedAt: new Date().toISOString(),
        });
        await log(job.id, `Citation re-extraction skipped for ${docId}: ${error}`);
        await progress({
          phase: 'complete',
          label: 'Citation re-extraction skipped',
          status: 'failed',
          detail: error,
          counts: { citations: 0 },
        });
        return result;
      }
      await extractAndSaveParsedData(doc, analysis.fullText, analysis.pdfPath, {
        onProgress: progress,
        extractCommittee: false,
        extractCitations: true,
        strictCitationErrors: true,
      });
      await saveCitationExtractionState(docId, {
        contentChecksum: entry.content_checksum || entry.updated_at || null,
        parserVersion: CITATION_PARSER_VERSION,
        status: 'completed',
        citationCount: doc.citationCount || 0,
      });
    } catch (error) {
      await saveCitationExtractionState(docId, {
        contentChecksum: entry.content_checksum || entry.updated_at || null,
        parserVersion: CITATION_PARSER_VERSION,
        status: 'failed',
        citationCount: 0,
        error: error?.message || String(error),
      });
      throw error;
    } finally {
      await analysis?.cleanup?.();
    }
    const result = {
      ok: true,
      docId,
      citations: doc.citationCount || 0,
    };
    clearMetricsCache?.();
    await finishAdminJob(job.id, {
      status: 'completed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Citation re-extraction finished for ${docId}: ${result.citations} citations.`);
    await progress({
      phase: 'complete',
      label: 'Citation re-extraction complete',
      status: 'completed',
      counts: { citations: result.citations },
    });
    return result;
  }

  if (job.type === 'reparse_all') {
    await log(job.id, 'Starting cached PDF document reparse without citation extraction.');
    await progress({ phase: 'reparse_all', label: 'Reparsing cached PDF document data', status: 'running' });
    const entries = (await listFileMetrics()).filter((entry) => entry.pdf_path);
    let processed = 0;
    let withCommittee = 0;
    for (const entry of entries) {
      try {
        await progress({
          phase: 'reparse_all',
          label: 'Reparsing cached PDF document data',
          detail: entry.doc_id,
          status: 'running',
          counts: { processed, total: entries.length, withCommittee },
        });
        const analysis = await analyzePdfEntry(entry, artifactClient, {
          progress,
          counts: { processed, total: entries.length, withCommittee },
          label: 'Parsing cached PDF document data',
        });
        if (!analysis?.fullText) continue;
        processed += 1;
        const doc = await loadDocumentMetadata(entry.doc_id) || { id: entry.doc_id, supervisors: [] };
        await extractAndSaveParsedData(doc, analysis.fullText, null, {
          onProgress: progress,
          extractCommittee: true,
          extractCitations: false,
        });
        if (doc.committee?.length) withCommittee += 1;
      } catch (error) {
        await log(job.id, `Reparse failed for ${entry.doc_id}: ${error?.message || String(error)}`);
      }
    }
    const result = { ok: true, processed, committees: withCommittee, citations: 0 };
    clearMetricsCache?.();
    await finishAdminJob(job.id, {
      status: 'completed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Reparse finished: ${processed} processed.`);
    await progress({
      phase: 'reparse_all',
      label: 'Cached PDF document reparse',
      status: 'completed',
      counts: { processed, total: entries.length, withCommittee },
    });
    return result;
  }

  if (job.type === 'reparse_citations') {
    await log(job.id, 'Starting incremental citation extraction without catalogue resolution.');
    await progress({ phase: 'citation_extraction', label: 'Extracting pending citations', status: 'running' });
    const maxDocuments = Math.max(1, Math.min(5000, Number(params.maxDocuments) || 1000));
    const pageSize = Math.min(maxDocuments, Math.max(1, Math.min(250, Number(params.pageSize) || 50)));
    const scope = params.scope || {};
    let processed = 0;
    let totalCitations = 0;
    let failed = 0;
    let cursor = '';
    let reachedLimit = false;
    while (processed + failed < maxDocuments) {
      const entries = await listPendingCitationExtractions({
        limit: Math.min(pageSize, maxDocuments - processed - failed),
        afterDocId: cursor,
        syncKey: scope.syncKey || null,
        filters: scope.filters || scope,
        parserVersion: CITATION_PARSER_VERSION,
      });
      if (!entries.length) break;
      for (const entry of entries) {
        cursor = entry.doc_id;
        let source = null;
        try {
          await progress({
            phase: 'citation_extraction',
            label: 'Extracting pending citations',
            detail: entry.doc_id,
            status: 'running',
            counts: { processed, failed, citations: totalCitations, cursor, maxDocuments },
          });
          source = await loadCitationSource(entry, artifactClient, progress, {
            processed, failed, citations: totalCitations, maxDocuments,
          });
          if (!source?.fullText) throw new Error('Cached content returned no text for citation extraction.');
          const doc = await loadDocumentMetadata(entry.doc_id) || { id: entry.doc_id, supervisors: [] };
          await extractAndSaveParsedData(doc, source.fullText, source.pdfPath, {
            onProgress: progress,
            extractCommittee: false,
            extractCitations: true,
            strictCitationErrors: true,
          });
          processed += 1;
          if (doc.citationCount) totalCitations += Number(doc.citationCount);
          await saveCitationExtractionState(entry.doc_id, {
            contentChecksum: entry.content_checksum,
            parserVersion: CITATION_PARSER_VERSION,
            status: 'completed',
            citationCount: doc.citationCount || 0,
          });
        } catch (error) {
          failed += 1;
          await saveCitationExtractionState(entry.doc_id, {
            contentChecksum: entry.content_checksum,
            parserVersion: CITATION_PARSER_VERSION,
            status: 'failed',
            citationCount: 0,
            error: error?.message || String(error),
          });
          await log(job.id, `Citation extraction failed for ${entry.doc_id}: ${error?.message || String(error)}`);
        } finally {
          await source?.cleanup?.();
        }
      }
      await progress({
        phase: 'citation_extraction',
        label: 'Extracting pending citations',
        status: 'running',
        detail: `Checkpointed through ${cursor}`,
        counts: { processed, failed, citations: totalCitations, cursor, maxDocuments },
      });
    }
    if (processed + failed >= maxDocuments) {
      const remaining = await listPendingCitationExtractions({
        limit: 1,
        afterDocId: cursor,
        syncKey: scope.syncKey || null,
        filters: scope.filters || scope,
        parserVersion: CITATION_PARSER_VERSION,
      });
      reachedLimit = remaining.length > 0;
    }
    const result = {
      ok: failed === 0,
      processed,
      failed,
      citations: totalCitations,
      parserVersion: CITATION_PARSER_VERSION,
      cursor: cursor || null,
      batchLimitReached: reachedLimit,
      resolutionQueued: false,
    };
    clearMetricsCache?.();
    await finishAdminJob(job.id, {
      status: failed ? 'failed' : 'completed',
      result,
      error: failed ? `${failed} document(s) failed citation extraction.` : null,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Citation extraction finished: ${processed} processed, ${failed} failed. Catalogue resolution was not started.`);
    await progress({
      phase: 'citation_extraction',
      label: 'Citation extraction',
      status: failed ? 'failed' : 'completed',
      counts: { processed, failed, citations: totalCitations, cursor, batchLimitReached: reachedLimit },
    });
    return result;
  }

  if (job.type === 'reparse_committee') {
    await log(job.id, 'Starting committee reparse.');
    await progress({ phase: 'reparse_committee', label: 'Reparsing missing committees', status: 'running' });
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
    let processed = 0;
    let withCommittee = 0;
    for (const row of targets) {
      const doc = await loadDocumentMetadata(row.doc_id);
      if (!doc) continue;
      try {
        await progress({
          phase: 'reparse_committee',
          label: 'Reparsing missing committees',
          detail: row.doc_id,
          status: 'running',
          counts: { processed, total: targets.length, withCommittee },
        });
        const analysis = await analyzePdfEntry(row, artifactClient, {
          progress,
          counts: { processed, total: targets.length, withCommittee },
          label: 'Parsing cached PDF text for committee data',
        });
        if (analysis?.fullText) {
          const before = (await loadCommitteeMembers(row.doc_id)).length;
          await extractAndSaveParsedData(doc, analysis.fullText, null, {
            onProgress: progress,
            extractCommittee: true,
            extractCitations: false,
          });
          const after = (await loadCommitteeMembers(row.doc_id)).length;
          if (after > before) withCommittee += 1;
        }
      } catch (error) {
        await log(job.id, `Committee reparse failed for ${row.doc_id}: ${error?.message || String(error)}`);
      }
      processed += 1;
    }
    const result = { ok: true, processed, withCommittee };
    clearMetricsCache?.();
    await finishAdminJob(job.id, {
      status: 'completed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Committee reparse finished: ${processed} processed.`);
    await progress({
      phase: 'reparse_committee',
      label: 'Committee reparse',
      status: 'completed',
      counts: { processed, total: targets.length, withCommittee },
    });
    return result;
  }

  throw new Error(`Unsupported import/PDF admin job type: ${job.type}`);
}
