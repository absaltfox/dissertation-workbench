import { Router } from 'express';
import { buildMetricsPayloadFromRecords, collectMetricRecords, collectMetrics } from '../metrics.js';
import {
  ALLOW_PUBLIC_REFRESH, CACHE_TTL_MS, PUBLIC_MAX_RECORDS, PUBLIC_SCAN_LIMIT
} from '../config.js';
import {
  applyCitationCountsToDocuments, applyCommitteeMembersToDocuments,
  applyStoredFileMetricsToDocuments, getDocumentCacheStats, listCachedDocuments,
  loadDocumentMetadata, loadDocumentTopics, loadTopics
} from '../db.js';
import { authenticate } from '../auth.js';
import { getConfiguredApiKey } from '../secrets.js';
import { parseBooleanParam, parseNumberParam, validateMetricsParams } from '../validate.js';
import { asyncHandler, getQueryValue } from '../middleware/http.js';
import { hasValidCsrf } from '../middleware/adminAuth.js';

const WORKBENCH_SLICE_TTL_MS = CACHE_TTL_MS;

function readRawMetricsParams(req) {
  return {
    maxRecords: getQueryValue(req, 'maxRecords'),
    pageSize: getQueryValue(req, 'pageSize'),
    scanLimit: getQueryValue(req, 'scanLimit'),
    subjectLimit: getQueryValue(req, 'subjectLimit'),
    index: Object.prototype.hasOwnProperty.call(req.query, 'index') ? getQueryValue(req, 'index') : null,
    query: Object.prototype.hasOwnProperty.call(req.query, 'query') ? getQueryValue(req, 'query') : null,
    term: Object.prototype.hasOwnProperty.call(req.query, 'term') ? getQueryValue(req, 'term') : null,
    source: Object.prototype.hasOwnProperty.call(req.query, 'source') ? getQueryValue(req, 'source') : null,
  };
}

async function parseMetricsRequest(req, res) {
  const rawParams = readRawMetricsParams(req);
  const validation = validateMetricsParams(rawParams);
  if (!validation.valid) {
    res.status(400).json({ error: 'Validation failed', errors: validation.errors });
    return null;
  }

  const maxRecords = parseNumberParam(rawParams.maxRecords, 200);
  const pageSize = parseNumberParam(rawParams.pageSize, 20);
  const scanLimit = parseNumberParam(rawParams.scanLimit, Math.max(maxRecords * 10, 1000));
  const subjectLimit = parseNumberParam(rawParams.subjectLimit, 25);
  const index = rawParams.index !== null ? rawParams.index : undefined;
  const query = getQueryValue(req, 'query') || undefined;
  const term = getQueryValue(req, 'term') || undefined;
  const source = getQueryValue(req, 'source') || undefined;
  const apiKey = await getConfiguredApiKey() || undefined;
  const requestedDownloadFiles = parseBooleanParam(getQueryValue(req, 'downloadFiles'), false);
  const requestedRecomputeFromCache = parseBooleanParam(getQueryValue(req, 'recomputeFromCache'), false);
  const refresh = getQueryValue(req, 'refresh') === '1';
  const user = authenticate(req);
  const hasAdminCsrf = Boolean(user) && hasValidCsrf(req, user);
  if (user && !hasAdminCsrf && refresh) {
    res.status(403).json({ error: 'Invalid CSRF token' });
    return null;
  }
  if (!hasAdminCsrf && refresh && !ALLOW_PUBLIC_REFRESH) {
    res.status(403).json({ error: 'refresh is restricted to authenticated admin sessions.' });
    return null;
  }

  const isAdminRequest = hasAdminCsrf;
  return {
    maxRecords: isAdminRequest ? maxRecords : Math.min(maxRecords, PUBLIC_MAX_RECORDS),
    pageSize,
    scanLimit: isAdminRequest ? scanLimit : Math.min(scanLimit, PUBLIC_SCAN_LIMIT),
    subjectLimit,
    index,
    query,
    term,
    source,
    apiKey,
    downloadFiles: false,
    forceDownload: false,
    recomputeFromCache: false,
    refresh,
    isAdminRequest,
    requestedDownloadFiles,
    requestedRecomputeFromCache,
  };
}

function sourceCacheKey(params) {
  return JSON.stringify({
    maxRecords: params.maxRecords,
    pageSize: params.pageSize,
    scanLimit: params.scanLimit,
    subjectLimit: params.subjectLimit,
    index: params.index,
    query: params.query,
    term: params.term,
    source: params.source,
    hasApiKey: Boolean(params.apiKey),
    downloadFiles: params.downloadFiles,
    recomputeFromCache: params.recomputeFromCache,
    refresh: params.refresh,
    isAdminRequest: params.isAdminRequest,
  });
}

function activeFilters(req) {
  return {
    degree: String(getQueryValue(req, 'degree') || '').trim(),
    program: String(getQueryValue(req, 'program') || '').trim(),
    affiliation: String(getQueryValue(req, 'affiliation') || '').trim(),
  };
}

function normalizeAffiliationFilterValue(raw) {
  if (!raw) return '';
  let value = String(raw).trim();
  value = value.replace(/\bThe University of British Columbia\b/gi, 'UBC');
  value = value.replace(/\bUniversity of British Columbia\b/gi, 'UBC');
  value = value.replace(/\bSimon Fraser University\b/gi, 'SFU');
  value = value.replace(/\bUniversity of Victoria\b/gi, 'UVic');
  value = value.replace(/\bThompson Rivers University\b/gi, 'TRU');
  value = value.replace(/\bRoyal Roads University\b/gi, 'RRU');
  value = value.replace(/\s+/g, ' ').trim();
  return value;
}

function filterDocuments(documents, filters = {}) {
  return (documents || []).filter((doc) => {
    if (filters.degree && doc.degree !== filters.degree) return false;
    if (filters.program && doc.program !== filters.program) return false;
    if (filters.affiliation) {
      const affiliations = Array.isArray(doc.affiliation) ? doc.affiliation : [];
      const requestedAffiliation = normalizeAffiliationFilterValue(filters.affiliation);
      if (!affiliations.some((value) => {
        const raw = String(value || '').trim();
        return raw === filters.affiliation || normalizeAffiliationFilterValue(raw) === requestedAffiliation;
      })) return false;
    }
    return true;
  });
}

function facetValues(documents = []) {
  const toSorted = (values) => Array.from(new Set(values.filter(Boolean))).sort();
  return {
    degree: toSorted(documents.map((doc) => doc.degree)),
    program: toSorted(documents.map((doc) => doc.program)),
    affiliation: toSorted(documents.flatMap((doc) => Array.isArray(doc.affiliation) ? doc.affiliation : [])),
  };
}

function bootstrapDoc(doc) {
  return {
    id: doc.id,
    title: doc.title || '',
    author: doc.author || '',
    year: doc.year || null,
    degree: doc.degree || '',
    program: doc.program || '',
    affiliation: Array.isArray(doc.affiliation) ? doc.affiliation : [],
    supervisors: Array.isArray(doc.supervisors) ? doc.supervisors : [],
    pages: doc.pages ?? null,
    wordCount: doc.wordCount ?? null,
    citationCount: doc.citationCount || 0,
  };
}

function citationDoc(doc) {
  return {
    id: doc.id,
    title: doc.title || '',
    author: doc.author || '',
    year: doc.year || null,
    citationCount: doc.citationCount || 0,
  };
}

function detailDoc(doc, related = [], topic = null) {
  return {
    id: doc.id,
    title: doc.title || '',
    author: doc.author || '',
    authors: doc.authors || [],
    year: doc.year || null,
    date: doc.date || '',
    degree: doc.degree || '',
    program: doc.program || '',
    type: doc.type || '',
    affiliation: Array.isArray(doc.affiliation) ? doc.affiliation : [],
    supervisors: Array.isArray(doc.supervisors) ? doc.supervisors : [],
    committee: Array.isArray(doc.committee) ? doc.committee : [],
    abstract: doc.abstract || '',
    themes: Array.isArray(doc.themes) ? doc.themes : [],
    conceptTerms: Array.isArray(doc.conceptTerms) ? doc.conceptTerms : [],
    methodologies: Array.isArray(doc.methodologies) ? doc.methodologies : [],
    subjects: Array.isArray(doc.subjects) ? doc.subjects : [],
    pages: doc.pages ?? null,
    wordCount: doc.wordCount ?? null,
    citationCount: doc.citationCount || 0,
    uri: doc.uri || '',
    downloadCandidates: doc.downloadCandidates || [],
    downloadError: doc.downloadError || null,
    topicId: doc.topicId ?? null,
    topicProbability: doc.topicProbability ?? null,
    topic,
    related,
  };
}

function relatedDocumentsFor(doc, allDocs, limit = 6) {
  const terms = new Set([...(doc.themes || []), ...(doc.conceptTerms || [])].map((value) => String(value || '').toLowerCase()));
  if (!terms.size) return [];
  return (allDocs || [])
    .filter((candidate) => candidate.id !== doc.id)
    .map((candidate) => {
      const candidateTerms = [...(candidate.themes || []), ...(candidate.conceptTerms || [])]
        .map((value) => String(value || '').toLowerCase());
      const overlap = candidateTerms.filter((term) => terms.has(term)).length;
      return { candidate, overlap };
    })
    .filter((entry) => entry.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || (b.candidate.year || 0) - (a.candidate.year || 0))
    .slice(0, limit)
    .map(({ candidate, overlap }) => ({
      id: candidate.id,
      title: candidate.title || '',
      author: candidate.author || '',
      year: candidate.year || null,
      degree: candidate.degree || '',
      overlap,
    }));
}

function analyticsSlice(payload) {
  return {
    generatedAt: payload.generatedAt,
    source: payload.source,
    metrics: payload.metrics,
    wordCloud: payload.wordCloud,
    ngramCloud: payload.ngramCloud,
    methodologies: payload.methodologies,
    supervisorNgramMatrix: payload.supervisorNgramMatrix,
    termCooccurrence: payload.termCooccurrence,
    conceptTimeline: payload.conceptTimeline,
    methodologyConceptMatrix: payload.methodologyConceptMatrix,
    topicData: payload.topicData ? {
      topics: payload.topicData.topics,
      byYear: payload.topicData.byYear,
    } : null,
    methodologyTopicMatrix: payload.methodologyTopicMatrix,
  };
}

function visualizationSlice(payload) {
  return {
    generatedAt: payload.generatedAt,
    topicData: payload.topicData,
    supervisorNetwork: payload.supervisorNetwork,
    citationCooccurrence: payload.citationCooccurrence,
    methodologyTopicMatrix: payload.methodologyTopicMatrix,
    documents: (payload.documents || []).map((doc) => ({
      id: doc.id,
      title: doc.title || '',
      author: doc.author || '',
      year: doc.year || null,
      topicId: doc.topicId ?? null,
      topicProbability: doc.topicProbability ?? null,
      umapX: doc.umapX ?? null,
      umapY: doc.umapY ?? null,
      conceptTerms: doc.conceptTerms || [],
      methodologies: doc.methodologies || [],
    })),
  };
}

async function cachedSlice(cache, inflight, key, refresh, compute) {
  if (!refresh) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < WORKBENCH_SLICE_TTL_MS) return cached.payload;
  }
  if (inflight.has(key)) return inflight.get(key);
  const promise = compute().then((payload) => {
    cache.set(key, { timestamp: Date.now(), payload });
    return payload;
  }).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

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

  async function cachedDocumentsForParams(params) {
    const { getSyncKeyForOptions } = await loadSyncModule();
    const syncKey = getSyncKeyForOptions(params);
    const syncCacheStats = await getDocumentCacheStats(syncKey);
    const hasExactSyncCache = syncCacheStats.total > 0;
    const cacheStats = hasExactSyncCache ? syncCacheStats : await getDocumentCacheStats();
    const documents = await listCachedDocuments({
      syncKey: hasExactSyncCache ? syncKey : null,
      limit: params.maxRecords,
    });
    return {
      documents,
      documentCache: {
        syncKey: hasExactSyncCache ? syncKey : null,
        requestedSyncKey: syncKey,
        exactSyncKeyMatch: hasExactSyncCache,
        recordsAvailable: cacheStats.total,
        lastSyncedAt: cacheStats.lastSyncedAt,
      },
    };
  }

  async function metricRecordsForParams(params) {
    const { documents, documentCache } = await cachedDocumentsForParams(params);
    const result = await collectMetricRecords({
      ...params,
      cachedDocuments: documents,
      skipFileEnrichment: true,
      applyStoredFileMetrics: true,
      applyCitationCounts: true,
      applyCommitteeMembers: true,
    });
    result.sourceMeta.documentCache = documentCache;
    result.sourceMeta.readOnlyFileEnrichment = true;
    result.sourceMeta.ignoredFileEnrichmentParams = {
      downloadFiles: params.requestedDownloadFiles,
      recomputeFromCache: params.requestedRecomputeFromCache,
    };
    return result;
  }

  router.get('/workbench/bootstrap', asyncHandler(async (req, res) => {
    const params = await parseMetricsRequest(req, res);
    if (!params) return;
    const key = `workbench:bootstrap:${sourceCacheKey(params)}`;
    const payload = await cachedSlice(metricsCache, metricsInflight, key, params.refresh, async () => {
      const { documents, documentCache } = await cachedDocumentsForParams(params);
      await applyCitationCountsToDocuments(documents);
      await applyCommitteeMembersToDocuments(documents);
      const rows = documents.map(bootstrapDoc);
      return {
        generatedAt: new Date().toISOString(),
        source: {
          maxRecords: params.maxRecords,
          pageSize: params.pageSize,
          scanLimit: params.scanLimit,
          requestedIndex: params.index || '',
          query: params.query || '',
          term: params.term || '',
          source: params.source || '',
          documentCache,
          readOnlyFileEnrichment: true,
          ignoredFileEnrichmentParams: {
            downloadFiles: params.requestedDownloadFiles,
            recomputeFromCache: params.requestedRecomputeFromCache,
          },
        },
        summary: {
          documents: rows.length,
          supervisors: new Set(rows.flatMap((doc) => doc.supervisors || []).map((name) => String(name || '').toLowerCase()).filter(Boolean)).size,
        },
        facets: facetValues(rows),
        documents: rows,
      };
    });
    res.status(200).json(payload);
  }));

  router.get('/workbench/documents/:docId', asyncHandler(async (req, res) => {
    const params = await parseMetricsRequest(req, res);
    if (!params) return;
    const docId = req.params.docId;
    const key = `workbench:document:${docId}:${sourceCacheKey(params)}`;
    const payload = await cachedSlice(metricsCache, metricsInflight, key, params.refresh, async () => {
      const doc = await loadDocumentMetadata(docId);
      if (!doc) return null;
      await applyStoredFileMetricsToDocuments([doc]);
      await applyCitationCountsToDocuments([doc]);
      await applyCommitteeMembersToDocuments([doc]);
      const topicMap = await loadDocumentTopics([doc.id]);
      const topic = topicMap.get(doc.id);
      if (topic) {
        doc.topicId = topic.topicId;
        doc.topicProbability = topic.probability;
      }
      const topics = await loadTopics().catch(() => []);
      const topicInfo = doc.topicId == null
        ? null
        : topics.find((item) => item.topicId === doc.topicId) || null;
      const { documents } = await cachedDocumentsForParams(params);
      await applyCitationCountsToDocuments(documents);
      await applyCommitteeMembersToDocuments(documents);
      const related = relatedDocumentsFor(doc, documents);
      return { document: detailDoc(doc, related, topicInfo) };
    });
    if (!payload) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    res.status(200).json(payload);
  }));

  router.get('/workbench/analytics', asyncHandler(async (req, res) => {
    const params = await parseMetricsRequest(req, res);
    if (!params) return;
    const filters = activeFilters(req);
    const key = `workbench:analytics:${sourceCacheKey(params)}:${JSON.stringify(filters)}`;
    const payload = await cachedSlice(metricsCache, metricsInflight, key, params.refresh, async () => {
      const { records, sourceMeta, subjectLimit } = await metricRecordsForParams(params);
      const filtered = filterDocuments(records, filters);
      const full = await buildMetricsPayloadFromRecords(filtered, { ...sourceMeta, filters }, subjectLimit);
      return analyticsSlice(full);
    });
    res.status(200).json(payload);
  }));

  router.get('/workbench/visualizations', asyncHandler(async (req, res) => {
    const params = await parseMetricsRequest(req, res);
    if (!params) return;
    const filters = activeFilters(req);
    const key = `workbench:visualizations:${sourceCacheKey(params)}:${JSON.stringify(filters)}`;
    const payload = await cachedSlice(metricsCache, metricsInflight, key, params.refresh, async () => {
      const { records, sourceMeta, subjectLimit } = await metricRecordsForParams(params);
      const filtered = filterDocuments(records, filters);
      const full = await buildMetricsPayloadFromRecords(filtered, { ...sourceMeta, filters }, subjectLimit);
      return visualizationSlice(full);
    });
    res.status(200).json(payload);
  }));

  router.get('/workbench/people', asyncHandler(async (req, res) => {
    const params = await parseMetricsRequest(req, res);
    if (!params) return;
    const filters = activeFilters(req);
    const key = `workbench:people:${sourceCacheKey(params)}:${JSON.stringify(filters)}`;
    const payload = await cachedSlice(metricsCache, metricsInflight, key, params.refresh, async () => {
      const { records } = await metricRecordsForParams(params);
      const filtered = filterDocuments(records, filters);
      return {
        generatedAt: new Date().toISOString(),
        documents: filtered.map((doc) => ({
          ...bootstrapDoc(doc),
          role: 'Supervisor',
          conceptTerms: doc.conceptTerms || [],
          methodologies: doc.methodologies || [],
          topicId: doc.topicId ?? null,
        })),
      };
    });
    res.status(200).json(payload);
  }));

  router.get('/workbench/citations/documents', asyncHandler(async (req, res) => {
    const params = await parseMetricsRequest(req, res);
    if (!params) return;
    const filters = activeFilters(req);
    const key = `workbench:citations:${sourceCacheKey(params)}:${JSON.stringify(filters)}`;
    const payload = await cachedSlice(metricsCache, metricsInflight, key, params.refresh, async () => {
      const { documents } = await cachedDocumentsForParams(params);
      await applyCitationCountsToDocuments(documents);
      await applyCommitteeMembersToDocuments(documents);
      return {
        generatedAt: new Date().toISOString(),
        documents: filterDocuments(documents, filters).map(citationDoc),
      };
    });
    res.status(200).json(payload);
  }));

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
      const syncCacheStats = await getDocumentCacheStats(syncKey);
      const hasExactSyncCache = syncCacheStats.total > 0;
      const cacheStats = hasExactSyncCache ? syncCacheStats : await getDocumentCacheStats();
      const cachedDocuments = await listCachedDocuments({
        syncKey: hasExactSyncCache ? syncKey : null,
        limit: effectiveMaxRecords,
      });
      const payload = await collectMetrics({
        ...sourceOptions,
        cachedDocuments,
        skipFileEnrichment: true,
        applyStoredFileMetrics: true,
        applyCitationCounts: true,
        applyCommitteeMembers: true,
      });
      payload.source.documentCache = {
        syncKey: hasExactSyncCache ? syncKey : null,
        requestedSyncKey: syncKey,
        exactSyncKeyMatch: hasExactSyncCache,
        recordsAvailable: cacheStats.total,
        lastSyncedAt: cacheStats.lastSyncedAt,
      };
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
