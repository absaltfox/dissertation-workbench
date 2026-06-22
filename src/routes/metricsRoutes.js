import { Router } from 'express';
import { collectMetrics } from '../metrics.js';
import {
  ALLOW_PUBLIC_REFRESH, CACHE_TTL_MS, PUBLIC_MAX_RECORDS, PUBLIC_SCAN_LIMIT
} from '../config.js';
import { getDocumentCacheStats, listCachedDocuments } from '../db.js';
import { authenticate } from '../auth.js';
import { getConfiguredApiKey } from '../secrets.js';
import { parseBooleanParam, parseNumberParam, validateMetricsParams } from '../validate.js';
import { asyncHandler, getQueryValue } from '../middleware/http.js';
import { hasValidCsrf } from '../middleware/adminAuth.js';

/**
 * Creates the public metrics router.
 *
 * Public requests are capped by configured guardrails. This route is read-only
 * for file enrichment: it may read cached PDF/full-text metrics, but it never
 * downloads PDFs, fetches cIRcle full text, or recomputes cached files. Admin
 * jobs and cache actions own those mutating enrichment paths.
 * `metricsInflight` deduplicates identical expensive collection requests.
 */
export function createMetricsRouter({ metricsCache, metricsInflight, loadSyncModule }) {
  const router = Router();

  router.get('/metrics', asyncHandler(async (req, res) => {
    const rawParams = {
      maxRecords: getQueryValue(req, 'maxRecords'),
      pageSize: getQueryValue(req, 'pageSize'),
      scanLimit: getQueryValue(req, 'scanLimit'),
      subjectLimit: getQueryValue(req, 'subjectLimit'),
      index: Object.prototype.hasOwnProperty.call(req.query, 'index') ? getQueryValue(req, 'index') : null,
      query: Object.prototype.hasOwnProperty.call(req.query, 'query') ? getQueryValue(req, 'query') : null,
      term: Object.prototype.hasOwnProperty.call(req.query, 'term') ? getQueryValue(req, 'term') : null,
      source: Object.prototype.hasOwnProperty.call(req.query, 'source') ? getQueryValue(req, 'source') : null,
    };

    const validation = validateMetricsParams(rawParams);
    if (!validation.valid) {
      res.status(400).json({ error: 'Validation failed', errors: validation.errors });
      return;
    }

    const maxRecords = parseNumberParam(rawParams.maxRecords, 200);
    const pageSize = parseNumberParam(rawParams.pageSize, 20);
    const scanLimit = parseNumberParam(rawParams.scanLimit, Math.max(maxRecords * 10, 1000));
    const subjectLimit = parseNumberParam(rawParams.subjectLimit, 25);
    const index = rawParams.index !== null ? rawParams.index : undefined;
    const query = getQueryValue(req, 'query') || undefined;
    const term = getQueryValue(req, 'term') || undefined;
    const source = getQueryValue(req, 'source') || undefined;
    const configuredApiKey = await getConfiguredApiKey();
    const apiKey = configuredApiKey || undefined;
    const requestedDownloadFiles = parseBooleanParam(getQueryValue(req, 'downloadFiles'), false);
    const requestedRecomputeFromCache = parseBooleanParam(getQueryValue(req, 'recomputeFromCache'), false);
    const downloadFiles = false;
    const recomputeFromCache = false;
    const refresh = getQueryValue(req, 'refresh') === '1';
    const user = authenticate(req);
    const hasAdminCsrf = Boolean(user) && hasValidCsrf(req, user);
    const needsAdminPrivileges = refresh;
    if (user && !hasAdminCsrf && needsAdminPrivileges) {
      res.status(403).json({ error: 'Invalid CSRF token' });
      return;
    }
    // Treat admin-only work as privileged only when both the session and CSRF
    // token are valid; a bare session cookie is not enough for expensive writes
    // or refresh-like behavior.
    const isAdminRequest = hasAdminCsrf;
    if (!isAdminRequest && refresh && !ALLOW_PUBLIC_REFRESH) {
      res.status(403).json({ error: 'refresh is restricted to authenticated admin sessions.' });
      return;
    }
    const effectiveMaxRecords = isAdminRequest ? maxRecords : Math.min(maxRecords, PUBLIC_MAX_RECORDS);
    const effectiveScanLimit = isAdminRequest ? scanLimit : Math.min(scanLimit, PUBLIC_SCAN_LIMIT);

    const cacheKey = JSON.stringify({
      maxRecords: effectiveMaxRecords, pageSize, scanLimit: effectiveScanLimit, subjectLimit,
      index, query, term, source,
      hasApiKey: Boolean(apiKey),
      downloadFiles, recomputeFromCache, refresh, isAdminRequest
    });

    if (!refresh && !recomputeFromCache) {
      const cached = metricsCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        res.status(200).json(cached.payload);
        return;
      }
    }

    if (metricsInflight.has(cacheKey)) {
      const payload = await metricsInflight.get(cacheKey);
      res.status(200).json(payload);
      return;
    }

    const computePayload = async () => {
      const sourceOptions = {
        maxRecords: effectiveMaxRecords, pageSize, scanLimit: effectiveScanLimit, subjectLimit,
        index, query, term, source, apiKey,
        downloadFiles,
        forceDownload: false,
        recomputeFromCache
      };
      const { getSyncKeyForOptions } = await loadSyncModule();
      const syncKey = getSyncKeyForOptions(sourceOptions);
      const cacheStats = await getDocumentCacheStats(syncKey);
      // Cached document metadata lets the dashboard avoid paging Open
      // Collections and re-running PDF enrichment during ordinary reads.
      const canUseDocumentCache = !refresh && !recomputeFromCache && cacheStats.total > 0;
      const cachedDocuments = canUseDocumentCache
        ? await listCachedDocuments({ syncKey, limit: effectiveMaxRecords })
        : null;
      const payload = await collectMetrics({
        ...sourceOptions,
        cachedDocuments,
        skipFileEnrichment: true,
        applyStoredFileMetrics: true,
      });
      if (cachedDocuments) {
        payload.source.documentCache = {
          syncKey,
          recordsAvailable: cacheStats.total,
          lastSyncedAt: cacheStats.lastSyncedAt,
        };
      }
      payload.source.readOnlyFileEnrichment = true;
      payload.source.ignoredFileEnrichmentParams = {
        downloadFiles: requestedDownloadFiles,
        recomputeFromCache: requestedRecomputeFromCache,
      };
      metricsCache.set(cacheKey, { timestamp: Date.now(), payload });
      return payload;
    };

    const promise = computePayload().finally(() => metricsInflight.delete(cacheKey));
    metricsInflight.set(cacheKey, promise);
    const payload = await promise;
    res.status(200).json(payload);
  }));

  return router;
}
