import { Router } from 'express';
import { buildMetricsPayloadFromRecords, collectMetricRecords, collectMetrics, enrichDocumentSignals } from '../metrics.js';
import {
  ALLOW_PUBLIC_REFRESH, CACHE_TTL_MS, PUBLIC_MAX_RECORDS, PUBLIC_SCAN_LIMIT
} from '../config.js';
import {
  applyCitationCountsToDocuments, applyCommitteeMembersToDocuments,
  applyStoredFileMetricsToDocuments, getDocumentCacheStats, getDocumentServingAnalytics, getDocumentServingSummary,
  hasTopics, listCachedDocuments, loadDocumentMetadata, loadDocumentTopics, loadTopics,
  queryCachedDocumentPage, queryCitationDocumentPage, queryPeoplePage, queryPersonDetailPage,
  queryRelatedDocuments, queryTopicDocumentPage
} from '../db.js';
import { authenticate } from '../auth.js';
import { getConfiguredApiKey } from '../secrets.js';
import { parseBooleanParam, parseNumberParam, validateMetricsParams } from '../validate.js';
import { asyncHandler, getQueryValue } from '../middleware/http.js';
import { hasValidCsrf } from '../middleware/adminAuth.js';

const WORKBENCH_SLICE_TTL_MS = CACHE_TTL_MS;
const ANALYTICS_DOCUMENT_SAMPLE_LIMIT = 100;
const DETAILED_ANALYTICS_RECORD_LIMIT = 5000;
const VISUALIZATION_DOCUMENT_LIMIT = 5000;

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

export function sourceCacheKey(params) {
  return JSON.stringify({
    subjectLimit: params.subjectLimit,
    index: params.index,
    query: params.query,
    term: params.term,
    source: params.source,
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

function parseDocumentPageRequest(req) {
  const offset = Math.trunc(Math.max(0, parseNumberParam(getQueryValue(req, 'offset'), 0)));
  const requestedLimit = parseNumberParam(getQueryValue(req, 'limit'), 50);
  const limit = Math.trunc(Math.min(100, Math.max(1, requestedLimit)));
  const q = String(getQueryValue(req, 'q') || '').trim().toLowerCase();
  const sortKey = String(getQueryValue(req, 'sortKey') || '').trim();
  const sortDir = String(getQueryValue(req, 'sortDir') || '').trim() === 'desc' ? 'desc' : 'asc';
  return { offset, limit, q, sortKey, sortDir };
}

function parsePagedRequest(req, defaultSortKey = '', defaultSortDir = 'asc') {
  const page = parseDocumentPageRequest(req);
  const hasSortDir = String(getQueryValue(req, 'sortDir') || '').trim() !== '';
  return {
    ...page,
    sortKey: page.sortKey || defaultSortKey,
    sortDir: hasSortDir ? page.sortDir : defaultSortDir,
    role: String(getQueryValue(req, 'role') || '').trim(),
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

const PERSON_ROLE_ORDER = [
  'Supervisor',
  'Co-Supervisor',
  'Supervisory Committee Member',
  'Committee Member',
  'University Examiner',
  'External Examiner',
];

function sortPersonRoles(roles = []) {
  return [...roles].sort((a, b) => {
    const ai = PERSON_ROLE_ORDER.indexOf(a);
    const bi = PERSON_ROLE_ORDER.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return String(a).localeCompare(String(b));
  });
}

function personDetailPageRow(person, documents) {
  const docs = documents.map((doc) => ({
    ...bootstrapDoc(doc),
    themes: doc.themes || [],
    conceptTerms: doc.conceptTerms || [],
    methodologies: doc.methodologies || [],
    topicId: doc.topicId ?? null,
    topicProbability: doc.topicProbability ?? null,
    personRoles: sortPersonRoles(doc.personRoles || []),
  }));
  const roles = sortPersonRoles(person.roles || []);
  return {
    ...person,
    roles,
    docs,
    roleGroups: roles.map((role) => ({
      role,
      docs: docs.filter((doc) => doc.personRoles.includes(role)),
    })).filter((group) => group.docs.length),
  };
}

function analyticsDoc(doc) {
  return {
    ...bootstrapDoc(doc),
    themes: Array.isArray(doc.themes) ? doc.themes : [],
    conceptTerms: Array.isArray(doc.conceptTerms) ? doc.conceptTerms : [],
    methodologies: Array.isArray(doc.methodologies) ? doc.methodologies : [],
    topicId: doc.topicId ?? null,
    topicProbability: doc.topicProbability ?? null,
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
    doi: doc.doi || '',
    uri: doc.uri || '',
    downloadCandidates: doc.downloadCandidates || [],
    downloadError: doc.downloadError || null,
    topicId: doc.topicId ?? null,
    topicProbability: doc.topicProbability ?? null,
    topic,
    related,
  };
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
    documents: (payload.documents || []).map(analyticsDoc),
  };
}

function visualizationSlice(payload) {
  return {
    generatedAt: payload.generatedAt,
    source: payload.source,
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

async function cachedDocumentsForParams(params, loadSyncModule) {
  const documentCache = await documentCacheForParams(params, loadSyncModule);
  const documents = await listCachedDocuments({ syncKey: documentCache.syncKey });
  return { documents, documentCache };
}

async function documentCacheForParams(params, loadSyncModule) {
  const { getSyncKeyForOptions } = await loadSyncModule();
  const syncKey = getSyncKeyForOptions(params);
  const syncCacheStats = await getDocumentCacheStats(syncKey);
  const hasExactSyncCache = syncCacheStats.total > 0;
  const cacheStats = hasExactSyncCache ? syncCacheStats : await getDocumentCacheStats();
  return {
    syncKey: hasExactSyncCache ? syncKey : null,
    requestedSyncKey: syncKey,
    exactSyncKeyMatch: hasExactSyncCache,
    recordsAvailable: cacheStats.total,
    lastSyncedAt: cacheStats.lastSyncedAt,
  };
}

async function documentPageForParams(params, loadSyncModule, pageRequest, filters = {}) {
  const documentCache = await documentCacheForParams(params, loadSyncModule);
  const page = await queryCachedDocumentPage({
    syncKey: documentCache.syncKey,
    filters,
    q: pageRequest.q,
    sortKey: pageRequest.sortKey,
    sortDir: pageRequest.sortDir,
    limit: pageRequest.limit,
    offset: pageRequest.offset,
  });
  await applyCommitteeMembersToDocuments(page.documents);

  return {
    generatedAt: new Date().toISOString(),
    source: {
      documentCache,
      offset: pageRequest.offset,
      limit: pageRequest.limit,
      total: page.total,
      hasMore: pageRequest.offset + page.documents.length < page.total,
    },
    documents: page.documents.map(bootstrapDoc),
  };
}

async function metricRecordsForParams(params, loadSyncModule) {
  const { documents, documentCache } = await cachedDocumentsForParams(params, loadSyncModule);
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

export async function buildWorkbenchBootstrapPayload(params, loadSyncModule) {
  const documentCache = await documentCacheForParams(params, loadSyncModule);
  const aggregate = await getDocumentServingSummary({ syncKey: documentCache.syncKey });
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
      documents: aggregate.documents,
      supervisors: aggregate.supervisors,
    },
    facets: aggregate.facets,
    documents: [],
  };
}

function startBackgroundSliceRefresh(cache, inflight, key, compute) {
  if (inflight.has(key)) return;
  const promise = compute().then((payload) => {
    cache.set(key, { timestamp: Date.now(), payload });
    return payload;
  }).catch(() => null).finally(() => inflight.delete(key));
  inflight.set(key, promise);
}

async function cachedSlice(cache, inflight, key, refresh, compute) {
  const cached = cache.get(key);
  if (!refresh) {
    if (cached && Date.now() - cached.timestamp < WORKBENCH_SLICE_TTL_MS) return cached.payload;
    if (cached) {
      startBackgroundSliceRefresh(cache, inflight, key, compute);
      return cached.payload;
    }
  }
  if (inflight.has(key)) return inflight.get(key);
  const promise = compute().then((payload) => {
    cache.set(key, { timestamp: Date.now(), payload });
    return payload;
  }).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export async function warmWorkbenchLandingCache({ metricsCache, metricsInflight, loadSyncModule, params }) {
  const filters = {};
  const pageRequest = { offset: 0, limit: 50, q: '', sortKey: '', sortDir: 'asc' };
  const slices = [
    {
      key: `workbench:bootstrap:${sourceCacheKey(params)}`,
      compute: () => buildWorkbenchBootstrapPayload(params, loadSyncModule),
    },
    {
      key: `workbench:document-page:${sourceCacheKey(params)}:${JSON.stringify(filters)}:${JSON.stringify(pageRequest)}`,
      compute: () => documentPageForParams(params, loadSyncModule, pageRequest, filters),
    },
  ];

  const results = await Promise.all(slices.map(({ key, compute }) => {
    if (metricsInflight.has(key)) return metricsInflight.get(key);
    const promise = compute().then((payload) => {
      metricsCache.set(key, { timestamp: Date.now(), payload });
      return payload;
    }).finally(() => metricsInflight.delete(key));
    metricsInflight.set(key, promise);
    return promise;
  }));

  return {
    bootstrap: results[0],
    documentPage: results[1],
  };
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

  router.get('/workbench/bootstrap', asyncHandler(async (req, res) => {
    const params = await parseMetricsRequest(req, res);
    if (!params) return;
    const key = `workbench:bootstrap:${sourceCacheKey(params)}`;
    const payload = await cachedSlice(metricsCache, metricsInflight, key, params.refresh, async () => {
      return buildWorkbenchBootstrapPayload(params, loadSyncModule);
    });
    res.status(200).json(payload);
  }));

  router.get('/workbench/documents', asyncHandler(async (req, res) => {
    const params = await parseMetricsRequest(req, res);
    if (!params) return;
    const filters = activeFilters(req);
    const pageRequest = parseDocumentPageRequest(req);
    const key = `workbench:document-page:${sourceCacheKey(params)}:${JSON.stringify(filters)}:${JSON.stringify(pageRequest)}`;
    const payload = await cachedSlice(metricsCache, metricsInflight, key, params.refresh, async () => {
      return documentPageForParams(params, loadSyncModule, pageRequest, filters);
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
      enrichDocumentSignals([doc]);
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
      const documentCache = await documentCacheForParams(params, loadSyncModule);
      const related = await queryRelatedDocuments(doc, { syncKey: documentCache.syncKey });
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
      const documentCache = await documentCacheForParams(params, loadSyncModule);
      if (documentCache.recordsAvailable <= DETAILED_ANALYTICS_RECORD_LIMIT) {
        const { records, sourceMeta, subjectLimit } = await metricRecordsForParams(params, loadSyncModule);
        const filtered = filterDocuments(records, filters);
        const full = await buildMetricsPayloadFromRecords(filtered, { ...sourceMeta, filters }, subjectLimit, {
          persistRun: params.isAdminRequest && params.refresh,
        });
        return analyticsSlice(full);
      }
      const aggregate = await getDocumentServingAnalytics({
        syncKey: documentCache.syncKey,
        filters,
        subjectLimit: params.subjectLimit,
      });
      const documentSample = await queryCachedDocumentPage({
        syncKey: documentCache.syncKey,
        filters,
        limit: ANALYTICS_DOCUMENT_SAMPLE_LIMIT,
        offset: 0,
      });
      return {
        generatedAt: new Date().toISOString(),
        source: {
          documentCache,
          filters,
          aggregateSource: 'database',
          documentsAvailable: documentSample.total,
          documentsReturned: documentSample.documents.length,
          documentsTruncated: documentSample.total > documentSample.documents.length,
          detailedAnalyticsRecordLimit: DETAILED_ANALYTICS_RECORD_LIMIT,
          readOnlyFileEnrichment: true,
        },
        ...aggregate,
        documents: documentSample.documents.map(analyticsDoc),
      };
    });
    res.status(200).json(payload);
  }));

  router.get('/workbench/visualizations', asyncHandler(async (req, res) => {
    const params = await parseMetricsRequest(req, res);
    if (!params) return;
    const filters = activeFilters(req);
    const key = `workbench:visualizations:${sourceCacheKey(params)}:${JSON.stringify(filters)}`;
    const payload = await cachedSlice(metricsCache, metricsInflight, key, params.refresh, async () => {
      if (!await hasTopics()) {
        return {
          generatedAt: new Date().toISOString(),
          topicData: null,
          supervisorNetwork: { nodes: [], edges: [] },
          citationCooccurrence: { nodes: [], edges: [] },
          methodologyTopicMatrix: { methodologies: [], topics: [], matrix: [] },
          documents: [],
        };
      }
      const documentCache = await documentCacheForParams(params, loadSyncModule);
      const page = await queryTopicDocumentPage({
        syncKey: documentCache.syncKey,
        filters,
        limit: VISUALIZATION_DOCUMENT_LIMIT,
        offset: 0,
      });
      const sourceMeta = {
        documentCache,
        filters,
        aggregateSource: 'bounded-topic-document-page',
        documentsAvailable: page.total,
        documentsReturned: page.documents.length,
        documentsTruncated: page.total > page.documents.length,
        visualizationDocumentLimit: VISUALIZATION_DOCUMENT_LIMIT,
        readOnlyFileEnrichment: true,
      };
      const full = await buildMetricsPayloadFromRecords(page.documents, sourceMeta, params.subjectLimit, {
        persistRun: params.isAdminRequest && params.refresh,
      });
      return visualizationSlice(full);
    });
    res.status(200).json(payload);
  }));

  router.get('/workbench/people', asyncHandler(async (req, res) => {
    const params = await parseMetricsRequest(req, res);
    if (!params) return;
    const filters = activeFilters(req);
    const pageRequest = parsePagedRequest(req, 'docCount', 'desc');
    const key = `workbench:people:${sourceCacheKey(params)}:${JSON.stringify(filters)}:${JSON.stringify(pageRequest)}`;
    const payload = await cachedSlice(metricsCache, metricsInflight, key, params.refresh, async () => {
      const documentCache = await documentCacheForParams(params, loadSyncModule);
      const page = await queryPeoplePage({
        syncKey: documentCache.syncKey,
        filters,
        q: pageRequest.q,
        role: pageRequest.role,
        sortKey: pageRequest.sortKey,
        sortDir: pageRequest.sortDir,
        limit: pageRequest.limit,
        offset: pageRequest.offset,
      });
      return {
        generatedAt: new Date().toISOString(),
        source: {
          total: page.total,
          offset: pageRequest.offset,
          limit: pageRequest.limit,
          hasMore: pageRequest.offset + page.people.length < page.total,
        },
        people: page.people,
      };
    });
    res.status(200).json(payload);
  }));

  router.get('/workbench/people/:personKey', asyncHandler(async (req, res) => {
    const params = await parseMetricsRequest(req, res);
    if (!params) return;
    const filters = activeFilters(req);
    const personKey = String(req.params.personKey || '').toLowerCase().trim();
    const pageRequest = parsePagedRequest(req, 'year', 'desc');
    const key = `workbench:people:detail:${sourceCacheKey(params)}:${JSON.stringify(filters)}:${personKey}:${JSON.stringify(pageRequest)}`;
    const payload = await cachedSlice(metricsCache, metricsInflight, key, params.refresh, async () => {
      const documentCache = await documentCacheForParams(params, loadSyncModule);
      const page = await queryPersonDetailPage({
        personKey,
        syncKey: documentCache.syncKey,
        filters,
        limit: pageRequest.limit,
        offset: pageRequest.offset,
      });
      if (!page) return { person: null };
      enrichDocumentSignals(page.documents);
      return {
        generatedAt: new Date().toISOString(),
        source: {
          total: page.person.docCount,
          offset: pageRequest.offset,
          limit: pageRequest.limit,
          hasMore: pageRequest.offset + page.documents.length < page.person.docCount,
        },
        person: personDetailPageRow(page.person, page.documents),
      };
    });
    if (!payload.person) {
      res.status(404).json({ error: 'Person not found' });
      return;
    }
    res.status(200).json(payload);
  }));

  router.get('/workbench/citations/documents', asyncHandler(async (req, res) => {
    const params = await parseMetricsRequest(req, res);
    if (!params) return;
    const filters = activeFilters(req);
    const pageRequest = parsePagedRequest(req, 'citationCount', 'desc');
    const key = `workbench:citations:${sourceCacheKey(params)}:${JSON.stringify(filters)}:${JSON.stringify(pageRequest)}`;
    const payload = await cachedSlice(metricsCache, metricsInflight, key, params.refresh, async () => {
      const documentCache = await documentCacheForParams(params, loadSyncModule);
      const page = await queryCitationDocumentPage({
        syncKey: documentCache.syncKey,
        filters,
        q: pageRequest.q,
        sortKey: pageRequest.sortKey,
        sortDir: pageRequest.sortDir,
        limit: pageRequest.limit,
        offset: pageRequest.offset,
      });
      return {
        generatedAt: new Date().toISOString(),
        source: {
          total: page.total,
          withCitations: page.withCitations,
          offset: pageRequest.offset,
          limit: pageRequest.limit,
          hasMore: pageRequest.offset + page.documents.length < page.total,
        },
        documents: page.documents,
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
        offset: 0,
      });
      const payload = await collectMetrics({
        ...sourceOptions,
        cachedDocuments,
        skipFileEnrichment: true,
        applyStoredFileMetrics: true,
        applyCitationCounts: true,
        applyCommitteeMembers: true,
        persistRun: isAdminRequest && refresh,
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
