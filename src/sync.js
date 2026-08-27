import {
  DEFAULT_BASE_URL, DEFAULT_INDEX, DEFAULT_QUERY, DEFAULT_SOURCE, DEFAULT_TERM,
  DOCUMENT_SYNC_MAX_RECORDS
} from './config.js';
import { fetchPage, extractHits, resolveIndexName } from './api.js';
import {
  createSyncRun, documentExists, documentsExist, getDocumentCacheStats, getLatestSyncRun,
  listDocumentsPendingEnrichment, loadEnrichmentAttempts, loadStoredFileMetric,
  loadStoredFileMetrics, markEnrichmentAttempts, reserveImportRuleRequestSlot,
  saveDocumentMetadata, saveDocumentMetadataBatch, saveFileMetric, updateSyncRun
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

// Without an injected existence check the batched form is used: one SELECT per
// page of records rather than one per record (H-05). Callers that inject their own
// existsFn — tests — keep the per-document seam.
export const filterSyncItemsForMode = (items, mode, existsFn = null) =>
  filterSyncItemsForModeWithExists(items, mode, existsFn || documentExists, {
    existsBatchFn: existsFn ? null : documentsExist,
  });

export function hasCachedEnrichmentMetric(stored, contentMode, contentFallback = null) {
  if (contentFallback === 'full_text' && stored?.word_source === 'dspace_full_text') {
    return Number(stored.word_count) > 0 && Number(stored.page_count) > 0;
  }
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

export function createRequestRateLimiter(requestsPerMinute, {
  windowMs = 60_000,
  now = () => Date.now(),
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  loadTimestamps = async () => [],
  saveTimestamps = async () => {},
  reserveSlot = null,
} = {}) {
  const limit = Math.max(0, Number(requestsPerMinute) || 0);
  const timestamps = [];
  let tail = Promise.resolve();
  let loaded = false;
  return async function acquire() {
    if (!limit) return;
    let release;
    const previous = tail;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      if (reserveSlot) {
        while (true) {
          const waitMs = await reserveSlot(now());
          if (!waitMs) return;
          await wait(waitMs);
        }
      }
      if (!loaded) {
        timestamps.push(...await loadTimestamps());
        timestamps.sort((left, right) => left - right);
        loaded = true;
      }
      while (timestamps.length && timestamps[0] <= now() - windowMs) timestamps.shift();
      if (timestamps.length >= limit) {
        const waitMs = timestamps[0] + windowMs - now();
        if (waitMs > 0) await wait(waitMs);
        while (timestamps.length && timestamps[0] <= now() - windowMs) timestamps.shift();
      }
      timestamps.push(now());
      await saveTimestamps(timestamps);
    } finally {
      release();
    }
  };
}

export async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(items.length, Math.max(1, Number(concurrency) || 1)) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = { value: await callback(items[index], index) };
        } catch (error) {
          results[index] = { error };
        }
      }
    }
  );
  await Promise.all(workers);
  return results;
}

async function runSync(syncKey, source, apiKey, runId, {
  mode = 'import_all',
  importRuleId = '',
  contentMode = DEFAULT_IMPORT_CONTENT_MODE,
  contentFallback = null,
  extractCommittee = true,
  maxContentBytes = 200 * 1024 * 1024,
  contentConcurrency = 1,
  contentRateLimit = 0,
  artifactClient = null,
  onProgress = null,
  pdfBatchSize = 0,
  skipPdfDocIds = [],
  enrichmentDocIds = [],
  enrichmentAttemptedBefore = null,
  enrichmentCursor = '',
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
  const acquireRuleRequestSlot = createRequestRateLimiter(contentRateLimit, {
    reserveSlot: importRuleId
      ? (nowMs) => reserveImportRuleRequestSlot(importRuleId, contentRateLimit, { nowMs })
      : null,
  });
  const countContentRequest = async (event = {}) => {
    if (event.request) await acquireRuleRequestSlot();
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
  const enrichmentRequested = mode === 'sync_missing_pdfs' && contentModeEnrichesDocuments(contentMode);
  // Documents attempted at or after this instant are treated as already handled by
  // the current batch chain. A continuation job inherits the value the first job in
  // the chain used, so a chain never re-attempts its own work and the job parameters
  // stay one timestamp long instead of growing an id list (H-03).
  const attemptedBefore = String(enrichmentAttemptedBefore || new Date(startedAt).toISOString());
  let queueCursor = String(enrichmentCursor || '');

  const attemptedInChain = (stored, attemptedAt) => Boolean(
    !requiredEnrichmentIds.size && attemptedAt && String(attemptedAt) >= attemptedBefore && stored
  );

  async function runEnrichmentBatch(missing) {
    if (!missing.length) return;
    await onProgress?.({
      phase: 'pdf_batch',
      label: 'Analyzing missing PDFs',
      status: 'running',
      counts: {
        processed: totalEnrichmentAttempted,
        total: pdfBatchLimit || totalEnrichmentAttempted + missing.length,
      },
    });
    const attemptedBeforePage = totalEnrichmentAttempted;
    // Durable progress is recorded before any content request so a crashed batch
    // does not leave the chain re-reading the same documents forever.
    await markEnrichmentAttempts(missing.map((item) => item.doc.id), new Date().toISOString());
    const processingResults = await mapWithConcurrency(missing, contentConcurrency, async (item, index) => {
      const docCounts = {
        processed: attemptedBeforePage + index + 1,
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
          contentFallback,
          maxContentBytes,
          downloadFiles: contentMode === 'pdf_cache' || contentMode === 'pdf_stream',
          forceDownload: false,
          recomputeFromCache: false,
          artifactClient,
          extractCommittee,
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
        const storedFailure = await loadStoredFileMetric(item.doc.id);
        if (!storedFailure) {
          await saveFileMetric(item.doc.id, {
            status: 'not_found',
            error: error?.message || String(error),
          });
        }
        return;
      }
      await saveDocumentMetadata(item.doc, { syncKey, source: item.source });
      const storedAfterAnalysis = await loadStoredFileMetric(item.doc.id);
      const policySatisfied = hasCachedEnrichmentMetric(storedAfterAnalysis, contentMode, contentFallback);
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
    });
    const processingError = processingResults.find((result) => result?.error)?.error;
    if (processingError) throw processingError;
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

  // Drains the locally known outstanding documents for this sync key before going
  // anywhere near Open Collections. Returns true when the batch cap was reached, in
  // which case the upstream scan is skipped entirely — the whole point of H-03.
  async function drainLocalEnrichmentQueue(runId) {
    while (true) {
      if (pdfBatchLimit && totalEnrichmentAttempted >= pdfBatchLimit) {
        pdfBatchLimitReached = true;
        return true;
      }
      if (totalSeen >= source.maxRecords) return true;
      const pageLimit = Math.max(1, Math.min(
        source.pageSize,
        source.maxRecords - totalSeen,
        pdfBatchLimit ? pdfBatchLimit - totalEnrichmentAttempted : source.pageSize
      ));
      const candidates = await listDocumentsPendingEnrichment({
        syncKey,
        contentMode,
        contentFallback,
        attemptedBefore,
        afterDocId: queueCursor,
        limit: pageLimit,
      });
      if (!candidates.length) return false;
      queueCursor = candidates[candidates.length - 1].docId;
      totalSeen += candidates.length;
      const missing = candidates
        .filter((candidate) => !skippedPdfIds.has(candidate.docId))
        .map((candidate) => ({
          doc: candidate.metadata && candidate.metadata.id ? candidate.metadata : { id: candidate.docId },
          syncKey,
          source: null,
        }));
      totalSkipped += candidates.length - missing.length;
      await runEnrichmentBatch(missing);
      totalSaved += missing.length;
      await updateSyncRun(runId, { totalSeen, totalSaved, apiTotal });
      if (candidates.length < pageLimit) return false;
    }
  }

  async function finishSync() {
    await updateSyncRun(runId, {
      status: 'completed',
      totalSeen,
      totalSaved,
      apiTotal,
      finishedAt: new Date().toISOString(),
    });
    const enrichmentExhausted = mode === 'sync_missing_pdfs' && !pdfBatchLimitReached && upstreamExhausted;
    logger.info('Open Collections sync completed', {
      syncKey,
      mode,
      totalSeen,
      totalSaved,
      totalSkipped,
      pdfBatchSize: pdfBatchLimit || null,
      pdfBatchLimitReached,
      enrichmentExhausted,
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
      enrichmentExhausted,
      pdfAttemptedIds,
      totalEnrichmentAttempted,
      totalEnriched,
      totalEnrichmentFailed,
      enrichmentOutcomes,
      enrichmentAttemptedBefore: attemptedBefore,
      enrichmentCursor: queueCursor,
      heapGrowthBytes: Math.max(0, peakHeapBytes - startingHeapBytes),
      requestCounts,
    };
  }

  try {
    // The Phase 5 PDF control ships an explicit document allowlist and must keep
    // taking precedence over any database-driven selection, so it stays on the
    // upstream scan path untouched.
    if (enrichmentRequested && !requiredEnrichmentIds.size && await drainLocalEnrichmentQueue(runId)) {
      return await finishSync();
    }

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
      const filtered = await filterSyncItemsForMode(batch, enrichmentRequested ? mode : 'import_all');
      totalSkipped += filtered.skipped;
      if (enrichmentRequested) {
        // One batched read of the stored metrics and the attempt log for the whole
        // page replaces one loadStoredFileMetric round trip per record (H-05). The
        // control allowlist ignores both, so it does not pay for them at all.
        const pageIds = filtered.items.map((item) => String(item.doc.id));
        const storedByDocId = requiredEnrichmentIds.size
          ? new Map()
          : await loadStoredFileMetrics(pageIds);
        const attemptedByDocId = requiredEnrichmentIds.size
          ? new Map()
          : await loadEnrichmentAttempts(pageIds);
        const missing = [];
        for (const item of filtered.items) {
          const docId = String(item.doc.id);
          if (requiredEnrichmentIds.size && !requiredEnrichmentIds.has(docId)) {
            totalSkipped += 1;
            continue;
          }
          if (skippedPdfIds.has(docId)) {
            totalSkipped += 1;
            continue;
          }
          const stored = storedByDocId.get(docId) || null;
          if (!requiredEnrichmentIds.size && hasCachedEnrichmentMetric(stored, contentMode, contentFallback)) {
            totalSkipped += 1;
            continue;
          }
          if (attemptedInChain(stored, attemptedByDocId.get(docId))) {
            totalSkipped += 1;
            continue;
          }
          if (pdfBatchLimit && totalEnrichmentAttempted + missing.length >= pdfBatchLimit) {
            pdfBatchLimitReached = true;
            break;
          }
          missing.push(item);
        }
        await runEnrichmentBatch(missing);
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

    return await finishSync();
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
      enrichmentAttemptedBefore: attemptedBefore,
      enrichmentCursor: queueCursor,
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
    importRuleId: options.importRuleId,
    contentMode: options.contentMode || (options.downloadFiles === false ? 'full_text_only' : 'pdf_cache'),
    contentFallback: options.contentFallback,
    extractCommittee: options.extractCommittee !== false,
    maxContentBytes: options.maxContentBytes,
    contentConcurrency: options.contentConcurrency,
    contentRateLimit: options.contentRateLimit,
    artifactClient: options.artifactClient || null,
    onProgress: options.onProgress || null,
    pdfBatchSize: options.pdfBatchSize || 0,
    skipPdfDocIds: options.skipPdfDocIds || [],
    enrichmentDocIds: options.enrichmentDocIds || [],
    enrichmentAttemptedBefore: options.enrichmentAttemptedBefore || null,
    enrichmentCursor: options.enrichmentCursor || '',
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
    importRuleId: options.importRuleId,
    contentMode: options.contentMode || (options.downloadFiles === false ? 'full_text_only' : 'pdf_cache'),
    contentFallback: options.contentFallback,
    extractCommittee: options.extractCommittee !== false,
    maxContentBytes: options.maxContentBytes,
    contentConcurrency: options.contentConcurrency,
    contentRateLimit: options.contentRateLimit,
    artifactClient: options.artifactClient || null,
    onProgress: options.onProgress || null,
    pdfBatchSize: options.pdfBatchSize || 0,
    skipPdfDocIds: options.skipPdfDocIds || [],
    enrichmentDocIds: options.enrichmentDocIds || [],
    enrichmentAttemptedBefore: options.enrichmentAttemptedBefore || null,
    enrichmentCursor: options.enrichmentCursor || '',
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
