import {
  DEFAULT_BASE_URL, DEFAULT_INDEX, DEFAULT_QUERY, DEFAULT_SOURCE, DEFAULT_TERM,
  DOCUMENT_SYNC_MAX_RECORDS
} from './config.js';
import { fetchPage, extractHits, resolveIndexName } from './api.js';
import {
  createSyncRun, documentExists, getDocumentCacheStats, getLatestSyncRun,
  loadStoredFileMetric, saveDocumentMetadata, saveDocumentMetadataBatch, updateSyncRun
} from './db.js';
import {
  buildDocumentSyncKey, buildMetricsSourceOptions, ensureSourceFields, normalizeRecord
} from './metrics.js';
import { logger } from './logger.js';
import { analyzeDocumentFile } from './pdf.js';
import { DOCUMENT_SYNC_MODES, filterSyncItemsForMode as filterSyncItemsForModeWithExists } from './syncModes.js';
import {
  DEFAULT_IMPORT_CONTENT_MODE, contentModeEnrichesDocuments
} from './importRules.js';

const runningSyncs = new Map();
export { DOCUMENT_SYNC_MODES };

function publicSource(source) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    requestedIndex = DEFAULT_INDEX,
    query = DEFAULT_QUERY,
    term = DEFAULT_TERM,
    source: sourceFields = DEFAULT_SOURCE,
    pageSize = 100,
    maxRecords = 9999,
    syncMaxRecords = null,
    scanLimit = 50_000,
    downloadFiles = true,
  } = source;
  return {
    baseUrl,
    requestedIndex,
    query,
    term,
    source: ensureSourceFields(sourceFields),
    pageSize,
    maxRecords: Number(syncMaxRecords || scanLimit || maxRecords),
    scanLimit,
    downloadFiles: Boolean(downloadFiles),
  };
}

export function getSyncSourceFromOptions(options = {}) {
  const built = buildMetricsSourceOptions(options);
  return publicSource({ ...built, syncMaxRecords: options.syncMaxRecords });
}

export function getSyncKeyForOptions(options = {}) {
  return buildDocumentSyncKey(getSyncSourceFromOptions(options));
}

function sourceUpdatedAt(raw) {
  return raw?.updated_at || raw?.updatedAt || raw?.date_updated || raw?.dateModified || null;
}

export const filterSyncItemsForMode = (items, mode, existsFn = documentExists) =>
  filterSyncItemsForModeWithExists(items, mode, existsFn);

export function hasCachedEnrichmentMetric(stored, contentMode) {
  if (contentMode === 'pdf_cache') return Boolean(stored?.pdf_path);
  if (contentMode === 'pdf_stream') {
    return (
      stored?.content_source === 'streamed_pdf'
      && Boolean(stored?.content_checksum)
      && Number(stored.word_count) > 0
      && Number(stored.page_count) > 0
    );
  }
  if (contentMode === 'full_text_only') {
    return (
      stored?.word_source === 'dspace_full_text'
      && Number(stored.word_count) > 0
      && Number(stored.page_count) > 0
    );
  }
  return false;
}

function progressDocDetail(doc = {}) {
  return [doc.title, doc.id].filter(Boolean).join(' · ') || 'Untitled document';
}

async function runSync(syncKey, source, apiKey, runId, {
  mode = 'import_all',
  contentMode = DEFAULT_IMPORT_CONTENT_MODE,
  artifactClient = null,
  onProgress = null,
  pdfBatchSize = 0,
  skipPdfDocIds = [],
  enrichmentDocIds = [],
} = {}) {
  const startedAt = Date.now();
  let totalSeen = 0;
  let totalSaved = 0;
  let totalSkipped = 0;
  let totalEnrichmentAttempted = 0;
  let totalEnriched = 0;
  let totalEnrichmentFailed = 0;
  let apiTotal = null;
  let pdfBatchLimitReached = false;
  let upstreamExhausted = false;
  const pdfAttemptedIds = [];
  const enrichmentOutcomes = [];
  const startingHeapBytes = process.memoryUsage().heapUsed;
  let peakHeapBytes = startingHeapBytes;
  const requestCounts = {
    metadata: 0,
    fullText: 0,
    originalPdf: 0,
    retrievedBytes: 0,
  };
  const countContentRequest = (event = {}) => {
    if (event.request && event.source === 'metadata') requestCounts.metadata += 1;
    if (event.request && event.source === 'full_text') requestCounts.fullText += 1;
    if (event.request && event.source === 'original_pdf') requestCounts.originalPdf += 1;
    if (!event.request && Number.isFinite(Number(event.bytes))) {
      requestCounts.retrievedBytes += Math.max(0, Number(event.bytes));
    }
  };
  const skippedPdfIds = new Set(
    (Array.isArray(skipPdfDocIds) ? skipPdfDocIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  );
  const requiredEnrichmentIds = new Set(
    (Array.isArray(enrichmentDocIds) ? enrichmentDocIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  );
  const pdfBatchLimit = mode === 'sync_missing_pdfs'
    ? Math.max(0, Number(pdfBatchSize || 0))
    : 0;
  try {
    const index = source.requestedIndex
      ? await resolveIndexName(source.baseUrl, source.requestedIndex, apiKey)
      : null;

    for (let from = 0; from < source.scanLimit; from += source.pageSize) {
      await onProgress?.({
        phase: 'oc_scan',
        label: 'Scanning Open Collections records',
        detail: `Records ${from + 1}-${from + source.pageSize}`,
        status: 'running',
        counts: { processed: totalSeen, total: apiTotal ?? source.maxRecords },
      });
      requestCounts.metadata += 1;
      const payload = await fetchPage({
        baseUrl: source.baseUrl,
        index,
        apiKey,
        from,
        pageSize: source.pageSize,
        query: source.query,
        term: source.term,
        source: source.source,
      });
      const docs = extractHits(payload);
      if (apiTotal === null) apiTotal = payload?.data?.hits?.total ?? null;
      if (!docs.length) {
        upstreamExhausted = true;
        break;
      }

      const batch = docs.slice(0, Math.max(0, source.maxRecords - totalSeen)).map((raw) => {
        const normalized = normalizeRecord(raw);
        return {
          doc: normalized,
          syncKey,
          source: {
            ...raw,
            sourceUpdatedAt: sourceUpdatedAt(raw),
          },
        };
      });
      totalSeen += batch.length;
      const enrichmentRequested = mode === 'sync_missing_pdfs' && contentModeEnrichesDocuments(contentMode);
      const filtered = await filterSyncItemsForMode(batch, enrichmentRequested ? mode : 'import_all');
      totalSkipped += filtered.skipped;
      if (enrichmentRequested) {
        const missing = [];
        for (const item of filtered.items) {
          if (requiredEnrichmentIds.size && !requiredEnrichmentIds.has(String(item.doc.id))) {
            totalSkipped += 1;
            continue;
          }
          if (skippedPdfIds.has(String(item.doc.id))) {
            totalSkipped += 1;
            continue;
          }
          const stored = await loadStoredFileMetric(item.doc.id);
          if (!requiredEnrichmentIds.size && hasCachedEnrichmentMetric(stored, contentMode)) {
            totalSkipped += 1;
            continue;
          }
          if (pdfBatchLimit && totalEnrichmentAttempted + missing.length >= pdfBatchLimit) {
            pdfBatchLimitReached = true;
            break;
          }
          missing.push(item);
        }
        if (missing.length) {
          await onProgress?.({
            phase: 'pdf_batch',
            label: 'Analyzing missing PDFs',
            status: 'running',
            counts: {
              processed: totalEnrichmentAttempted,
              total: pdfBatchLimit || totalEnrichmentAttempted + missing.length,
            },
          });
        }
        let pdfIndex = 0;
        const attemptedBeforePage = totalEnrichmentAttempted;
        for (const item of missing) {
          pdfIndex += 1;
          const docCounts = {
            processed: attemptedBeforePage + pdfIndex,
            total: pdfBatchLimit || attemptedBeforePage + missing.length,
          };
          await onProgress?.({
            phase: 'pdf_document',
            label: 'Parsing PDF document data',
            detail: progressDocDetail(item.doc),
            status: 'running',
            counts: docCounts,
          });
          await saveDocumentMetadata(item.doc, { syncKey, source: item.source });
          pdfAttemptedIds.push(item.doc.id);
          totalEnrichmentAttempted += 1;
          try {
            await analyzeDocumentFile(item.doc, {
              contentMode,
              downloadFiles: contentMode === 'pdf_cache' || contentMode === 'pdf_stream',
              forceDownload: false,
              recomputeFromCache: false,
              artifactClient,
              extractCitations: false,
              onContentRequest: countContentRequest,
              onProgress: async (event = {}) => {
                peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
                return onProgress?.({
                  ...event,
                  detail: event.detail || progressDocDetail(item.doc),
                  counts: { ...docCounts, ...(event.counts || {}) },
                });
              },
            });
          } catch (error) {
            peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
            totalEnrichmentFailed += 1;
            enrichmentOutcomes.push({
              docId: item.doc.id,
              contentMode,
              error: error?.message || String(error),
            });
            throw error;
          }
          await saveDocumentMetadata(item.doc, { syncKey, source: item.source });
          const storedAfterAnalysis = await loadStoredFileMetric(item.doc.id);
          const policySatisfied = hasCachedEnrichmentMetric(storedAfterAnalysis, contentMode);
          if (policySatisfied) totalEnriched += 1;
          else totalEnrichmentFailed += 1;
          peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
          enrichmentOutcomes.push({
            docId: item.doc.id,
            contentMode,
            status: storedAfterAnalysis?.status || null,
            error: storedAfterAnalysis?.error || null,
            contentSource: storedAfterAnalysis?.content_source || null,
            wordSource: storedAfterAnalysis?.word_source || null,
            pageSource: storedAfterAnalysis?.page_source || null,
            wordCount: Number(storedAfterAnalysis?.word_count || 0),
            bodyWordCount: Number(storedAfterAnalysis?.body_word_count || 0),
            pageCount: Number(storedAfterAnalysis?.page_count || 0),
            parserVersion: storedAfterAnalysis?.parser_version || null,
            contentChecksum: storedAfterAnalysis?.content_checksum || null,
          });
          await onProgress?.({
            phase: 'pdf_document',
            label: policySatisfied ? 'Parsed document data' : 'Document enrichment did not satisfy policy',
            detail: progressDocDetail(item.doc),
            status: policySatisfied ? 'completed' : 'failed',
            counts: {
              ...docCounts,
              pages: item.doc.pages || 0,
              words: item.doc.wordCount || 0,
              enriched: totalEnriched,
              failed: totalEnrichmentFailed,
            },
          });
        }
        if (missing.length) {
          await onProgress?.({
            phase: 'pdf_batch',
            label: 'Missing PDF batch',
            status: 'completed',
            counts: {
              processed: attemptedBeforePage + missing.length,
              total: pdfBatchLimit || attemptedBeforePage + missing.length,
              enriched: totalEnriched,
              failed: totalEnrichmentFailed,
            },
          });
        }
        totalSaved += missing.length;
      } else {
        totalSaved += await saveDocumentMetadataBatch(filtered.items);
      }
      await updateSyncRun(runId, { totalSeen, totalSaved, apiTotal });

      if (apiTotal !== null && totalSeen >= apiTotal) {
        upstreamExhausted = true;
        break;
      }
      if (totalSeen >= source.maxRecords) break;
      if (pdfBatchLimitReached) break;
      if (requiredEnrichmentIds.size && pdfAttemptedIds.length >= requiredEnrichmentIds.size) break;
    }

    await updateSyncRun(runId, {
      status: 'completed',
      totalSeen,
      totalSaved,
      apiTotal,
      finishedAt: new Date().toISOString(),
    });
    logger.info('Open Collections sync completed', {
      syncKey,
      mode,
      totalSeen,
      totalSaved,
      totalSkipped,
      pdfBatchSize: pdfBatchLimit || null,
      pdfBatchLimitReached,
      enrichmentExhausted: mode === 'sync_missing_pdfs' && !pdfBatchLimitReached && upstreamExhausted,
      pdfAttempted: pdfAttemptedIds.length,
      totalEnrichmentAttempted,
      totalEnriched,
      totalEnrichmentFailed,
      heapGrowthBytes: Math.max(0, peakHeapBytes - startingHeapBytes),
      requestCounts,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    });
    return {
      ok: true,
      totalSeen,
      totalSaved,
      totalSkipped,
      apiTotal,
      pdfBatchLimitReached,
      enrichmentExhausted: mode === 'sync_missing_pdfs' && !pdfBatchLimitReached && upstreamExhausted,
      pdfAttemptedIds,
      totalEnrichmentAttempted,
      totalEnriched,
      totalEnrichmentFailed,
      enrichmentOutcomes,
      heapGrowthBytes: Math.max(0, peakHeapBytes - startingHeapBytes),
      requestCounts,
    };
  } catch (error) {
    await updateSyncRun(runId, {
      status: 'failed',
      totalSeen,
      totalSaved,
      apiTotal,
      error: error?.message || String(error),
      finishedAt: new Date().toISOString(),
    });
    logger.error('Open Collections sync failed', { syncKey, error: error?.message || String(error) });
    return {
      ok: false,
      totalSeen,
      totalSaved,
      totalSkipped,
      apiTotal,
      pdfBatchLimitReached,
      pdfAttemptedIds,
      totalEnrichmentAttempted,
      totalEnriched,
      totalEnrichmentFailed,
      enrichmentOutcomes,
      heapGrowthBytes: Math.max(0, peakHeapBytes - startingHeapBytes),
      requestCounts,
      error: error?.message || String(error),
    };
  } finally {
    runningSyncs.delete(syncKey);
  }
}

export async function startDocumentSync(options = {}) {
  const mode = DOCUMENT_SYNC_MODES.has(options.mode) ? options.mode : 'import_all';
  const built = buildMetricsSourceOptions(options);
  const source = publicSource({
    ...built,
    syncMaxRecords: options.syncMaxRecords || DOCUMENT_SYNC_MAX_RECORDS || undefined,
  });
  const syncKey = buildDocumentSyncKey(source);
  if (runningSyncs.has(syncKey)) {
    return { started: false, alreadyRunning: true, syncKey, status: await getDocumentSyncStatus(syncKey) };
  }
  const runId = await createSyncRun(syncKey, source);
  const task = runSync(syncKey, source, built.apiKey, runId, {
    mode,
    contentMode: options.contentMode || (options.downloadFiles === false ? 'full_text_only' : 'pdf_cache'),
    artifactClient: options.artifactClient || null,
    onProgress: options.onProgress || null,
    pdfBatchSize: options.pdfBatchSize || 0,
    skipPdfDocIds: options.skipPdfDocIds || [],
    enrichmentDocIds: options.enrichmentDocIds || [],
  });
  runningSyncs.set(syncKey, task);
  return { started: true, syncKey, runId, status: await getDocumentSyncStatus(syncKey) };
}

export async function runDocumentSync(options = {}) {
  const mode = DOCUMENT_SYNC_MODES.has(options.mode) ? options.mode : 'import_all';
  const built = buildMetricsSourceOptions(options);
  const source = publicSource({
    ...built,
    syncMaxRecords: options.syncMaxRecords || DOCUMENT_SYNC_MAX_RECORDS || undefined,
  });
  const syncKey = buildDocumentSyncKey(source);
  const runId = await createSyncRun(syncKey, source);
  const summary = await runSync(syncKey, source, built.apiKey, runId, {
    mode,
    contentMode: options.contentMode || (options.downloadFiles === false ? 'full_text_only' : 'pdf_cache'),
    artifactClient: options.artifactClient || null,
    onProgress: options.onProgress || null,
    pdfBatchSize: options.pdfBatchSize || 0,
    skipPdfDocIds: options.skipPdfDocIds || [],
    enrichmentDocIds: options.enrichmentDocIds || [],
  });
  return { syncKey, runId, mode, ...summary, status: await getDocumentSyncStatus(syncKey) };
}

export async function getDocumentSyncStatus(syncKey = null) {
  const latest = await getLatestSyncRun(syncKey);
  const stats = await getDocumentCacheStats(syncKey);
  const running = syncKey ? runningSyncs.has(syncKey) : runningSyncs.size > 0;
  return {
    running,
    latest,
    cache: stats,
  };
}
