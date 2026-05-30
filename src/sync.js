import {
  DEFAULT_BASE_URL, DEFAULT_INDEX, DEFAULT_QUERY, DEFAULT_SOURCE, DEFAULT_TERM,
  DOCUMENT_SYNC_MAX_RECORDS
} from './config.js';
import { fetchPage, extractHits, resolveIndexName } from './api.js';
import {
  createSyncRun, getDocumentCacheStats, getLatestSyncRun, saveDocumentMetadataBatch,
  updateSyncRun
} from './db.js';
import {
  buildDocumentSyncKey, buildMetricsSourceOptions, ensureSourceFields, normalizeRecord
} from './metrics.js';
import { logger } from './logger.js';

const runningSyncs = new Map();

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

async function runSync(syncKey, source, apiKey, runId) {
  const startedAt = Date.now();
  let totalSeen = 0;
  let totalSaved = 0;
  let apiTotal = null;
  try {
    const index = source.requestedIndex
      ? await resolveIndexName(source.baseUrl, source.requestedIndex, apiKey)
      : null;

    for (let from = 0; from < source.scanLimit; from += source.pageSize) {
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
      totalSaved += await saveDocumentMetadataBatch(batch);
      await updateSyncRun(runId, { totalSeen, totalSaved, apiTotal });

      if (totalSeen >= source.maxRecords) break;
      if (apiTotal !== null && totalSeen >= Math.min(apiTotal, source.maxRecords)) break;
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
      totalSeen,
      totalSaved,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    });
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
  } finally {
    runningSyncs.delete(syncKey);
  }
}

export async function startDocumentSync(options = {}) {
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
  const task = runSync(syncKey, source, built.apiKey, runId);
  runningSyncs.set(syncKey, task);
  return { started: true, syncKey, runId, status: await getDocumentSyncStatus(syncKey) };
}

export async function runDocumentSync(options = {}) {
  const built = buildMetricsSourceOptions(options);
  const source = publicSource({
    ...built,
    syncMaxRecords: options.syncMaxRecords || DOCUMENT_SYNC_MAX_RECORDS || undefined,
  });
  const syncKey = buildDocumentSyncKey(source);
  const runId = await createSyncRun(syncKey, source);
  await runSync(syncKey, source, built.apiKey, runId);
  return { syncKey, runId, status: await getDocumentSyncStatus(syncKey) };
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
