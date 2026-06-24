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

function hasCachedEnrichmentMetric(stored) {
  return Boolean(stored?.pdf_path)
    || (
      stored?.word_source === 'dspace_full_text'
      && Number(stored.word_count) > 0
      && Number(stored.page_count) > 0
    );
}

function progressDocDetail(doc = {}) {
  return [doc.title, doc.id].filter(Boolean).join(' · ') || 'Untitled document';
}

async function runSync(syncKey, source, apiKey, runId, {
  mode = 'import_all',
  artifactClient = null,
  onProgress = null,
  pdfBatchSize = 0,
  skipPdfDocIds = [],
} = {}) {
  const startedAt = Date.now();
  let totalSeen = 0;
  let totalSaved = 0;
  let totalSkipped = 0;
  let apiTotal = null;
  let pdfBatchLimitReached = false;
  const pdfAttemptedIds = [];
  const skippedPdfIds = new Set(
    (Array.isArray(skipPdfDocIds) ? skipPdfDocIds : [])
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
      if (!docs.length) break;

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
      const filtered = await filterSyncItemsForMode(batch, mode);
      totalSkipped += filtered.skipped;
      if (mode === 'sync_missing_pdfs') {
        const missing = [];
        for (const item of filtered.items) {
          if (skippedPdfIds.has(String(item.doc.id))) {
            totalSkipped += 1;
            continue;
          }
          const stored = await loadStoredFileMetric(item.doc.id);
          if (hasCachedEnrichmentMetric(stored)) {
            totalSkipped += 1;
            continue;
          }
          if (pdfBatchLimit && totalSaved + missing.length >= pdfBatchLimit) {
            pdfBatchLimitReached = true;
            break;
          }
          missing.push(item);
        }
        if (pdfBatchLimit && totalSaved + missing.length >= pdfBatchLimit) {
          pdfBatchLimitReached = true;
        }
        if (missing.length) {
          await onProgress?.({
            phase: 'pdf_batch',
            label: 'Analyzing missing PDFs',
            status: 'running',
            counts: { processed: totalSaved, total: pdfBatchLimit || totalSaved + missing.length },
          });
        }
        let pdfIndex = 0;
        const savedBeforePage = totalSaved;
        for (const item of missing) {
          pdfIndex += 1;
          const docCounts = {
            processed: savedBeforePage + pdfIndex,
            total: pdfBatchLimit || savedBeforePage + missing.length,
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
          await analyzeDocumentFile(item.doc, {
            downloadFiles: source.downloadFiles,
            forceDownload: false,
            recomputeFromCache: false,
            artifactClient,
            onProgress: async (event = {}) => onProgress?.({
              ...event,
              detail: event.detail || progressDocDetail(item.doc),
              counts: { ...docCounts, ...(event.counts || {}) },
            }),
          });
          await saveDocumentMetadata(item.doc, { syncKey, source: item.source });
          await onProgress?.({
            phase: 'pdf_document',
            label: 'Parsed PDF document data',
            detail: progressDocDetail(item.doc),
            status: 'completed',
            counts: {
              ...docCounts,
              pages: item.doc.pages || 0,
              words: item.doc.wordCount || 0,
            },
          });
        }
        if (missing.length) {
          await onProgress?.({
            phase: 'pdf_batch',
            label: 'Missing PDF batch',
            status: 'completed',
            counts: {
              processed: savedBeforePage + missing.length,
              total: pdfBatchLimit || savedBeforePage + missing.length,
            },
          });
        }
        totalSaved += missing.length;
      } else {
        totalSaved += await saveDocumentMetadataBatch(filtered.items);
      }
      await updateSyncRun(runId, { totalSeen, totalSaved, apiTotal });

      if (totalSeen >= source.maxRecords) break;
      if (apiTotal !== null && totalSeen >= Math.min(apiTotal, source.maxRecords)) break;
      if (pdfBatchLimitReached) break;
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
      pdfAttempted: pdfAttemptedIds.length,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    });
    return { ok: true, totalSeen, totalSaved, totalSkipped, apiTotal, pdfBatchLimitReached, pdfAttemptedIds };
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
    artifactClient: options.artifactClient || null,
    onProgress: options.onProgress || null,
    pdfBatchSize: options.pdfBatchSize || 0,
    skipPdfDocIds: options.skipPdfDocIds || [],
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
    artifactClient: options.artifactClient || null,
    onProgress: options.onProgress || null,
    pdfBatchSize: options.pdfBatchSize || 0,
    skipPdfDocIds: options.skipPdfDocIds || [],
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
