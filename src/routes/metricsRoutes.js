import { Router } from 'express';
import { buildMetricsPayloadFromRecords, collectMetricRecords, collectMetrics, enrichDocumentSignals } from '../metrics.js';
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

export function sourceCacheKey(params) {
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

function documentSortValue(doc, key) {
  switch (key) {
    case 'title': return String(doc.title || '').toLowerCase();
    case 'author': return String(doc.author || '').toLowerCase();
    case 'year': return Number(doc.year || 0);
    case 'degree': return String(doc.degree || doc.type || '').toLowerCase();
    case 'pages': return Number(doc.pages || 0);
    case 'wordCount': return Number(doc.wordCount || 0);
    default: return '';
  }
}

function sortDocumentRows(documents = [], sortKey = '', sortDir = 'asc') {
  if (!sortKey) return documents;
  const dir = sortDir === 'desc' ? -1 : 1;
  return [...documents].sort((a, b) => {
    const av = documentSortValue(a, sortKey);
    const bv = documentSortValue(b, sortKey);
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function searchDocuments(documents = [], q = '') {
  if (!q) return documents;
  return documents.filter((doc) =>
    String(doc.title || '').toLowerCase().includes(q) ||
    String(doc.author || '').toLowerCase().includes(q) ||
    (doc.supervisors || []).some((name) => String(name || '').toLowerCase().includes(q)) ||
    String(doc.degree || '').toLowerCase().includes(q) ||
    String(doc.program || '').toLowerCase().includes(q) ||
    String(doc.year || '').includes(q)
  );
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

function citationDocSortValue(doc, key) {
  switch (key) {
    case 'title': return String(doc.title || '').toLowerCase();
    case 'author': return String(doc.author || '').toLowerCase();
    case 'year': return Number(doc.year || 0);
    case 'citationCount': return Number(doc.citationCount || 0);
    default: return '';
  }
}

function sortCitationDocs(documents = [], sortKey = 'citationCount', sortDir = 'desc') {
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...documents].sort((a, b) => {
    const av = citationDocSortValue(a, sortKey);
    const bv = citationDocSortValue(b, sortKey);
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir || String(a.title || '').localeCompare(String(b.title || ''));
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function isValidPersonName(name) {
  if (!name) return false;
  const n = String(name || '').trim();
  if (n.length < 3) return false;
  const words = n.split(/\s+/);
  if (words.length < 2) return false;
  if (/^(University|UBC|SFU|Columbia|of\s|&\s|Research$)/i.test(n)) return false;
  if (words.every((w) => w.replace(/\./g, '').length <= 2)) return false;
  return true;
}

function mergeAffiliationNames(affiliations = []) {
  return Array.from(new Set(affiliations.map((value) => String(value || '').trim()).filter(Boolean))).sort();
}

function buildTopicSummaryForDocs(docs = []) {
  const topicCounts = new Map();
  for (const doc of docs) {
    if (doc.topicId == null) continue;
    topicCounts.set(doc.topicId, (topicCounts.get(doc.topicId) || 0) + 1);
  }
  return Array.from(topicCounts.entries())
    .map(([topicId, count]) => ({ topicId, count }))
    .sort((a, b) => b.count - a.count);
}

function createPersonRowSeed(key, name) {
  return {
    key,
    name,
    roles: new Set(),
    docs: [],
    docRoles: new Map(),
    affiliations: new Set(),
    conceptMap: new Map(),
    methMap: new Map(),
    coSupervisors: new Set(),
  };
}

function docRoleKey(doc) {
  return doc.id || [doc.title, doc.author, doc.year].map((value) => String(value || '').trim()).join('|');
}

function addPersonDocument(person, doc, role) {
  const key = docRoleKey(doc);
  if (!key) return;
  let roleSet = person.docRoles.get(key);
  if (!roleSet) {
    roleSet = new Set();
    person.docRoles.set(key, roleSet);
    person.docs.push(doc);
    for (const concept of (doc.conceptTerms || [])) person.conceptMap.set(concept, (person.conceptMap.get(concept) || 0) + 1);
    for (const methodology of (doc.methodologies || [])) person.methMap.set(methodology, (person.methMap.get(methodology) || 0) + 1);
  }
  roleSet.add(role || 'Committee Member');
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

function buildRoleGroups(person) {
  const docByKey = new Map(person.docs.map((doc) => [docRoleKey(doc), doc]));
  return sortPersonRoles(person.roles).map((role) => ({
    role,
    docs: Array.from(person.docRoles.entries())
      .filter(([, roleSet]) => roleSet.has(role))
      .map(([key]) => docByKey.get(key))
      .filter(Boolean),
  })).filter((group) => group.docs.length);
}

function buildPersonRows(documents = []) {
  const people = new Map();

  for (const doc of documents) {
    for (const name of (doc.supervisors || [])) {
      if (!isValidPersonName(name)) continue;
      const key = String(name || '').toLowerCase().trim();
      if (!key) continue;
      let person = people.get(key);
      if (!person) {
        person = createPersonRowSeed(key, name);
        people.set(key, person);
      }
      person.roles.add('Supervisor');
      addPersonDocument(person, doc, 'Supervisor');
      for (const other of (doc.supervisors || [])) {
        const otherKey = String(other || '').toLowerCase().trim();
        if (otherKey && otherKey !== key) person.coSupervisors.add(other);
      }
    }

    for (const member of (doc.committee || [])) {
      const name = member.name;
      if (!isValidPersonName(name)) continue;
      const key = String(name || '').toLowerCase().trim();
      if (!key) continue;
      let person = people.get(key);
      if (!person) {
        person = createPersonRowSeed(key, name);
        people.set(key, person);
      }
      const role = member.role || 'Committee Member';
      person.roles.add(role);
      if (member.affiliation) person.affiliations.add(member.affiliation);
      addPersonDocument(person, doc, role);
    }
  }

  return Array.from(people.values()).map((person) => {
    const years = person.docs.map((doc) => doc.year).filter(Boolean).sort((a, b) => a - b);
    const topConcepts = Array.from(person.conceptMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([term, count]) => ({ term, count }));
    const methodologies = Array.from(person.methMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([methodology, count]) => ({ methodology, count }));
    return {
      key: person.key,
      name: person.name,
      roles: sortPersonRoles(person.roles),
      docCount: person.docs.length,
      docs: person.docs,
      docRoles: person.docRoles,
      roleGroups: buildRoleGroups(person),
      affiliations: mergeAffiliationNames(Array.from(person.affiliations)),
      yearRange: years.length ? `${years[0]}\u2013${years[years.length - 1]}` : '\u2013',
      yearMin: years[0] || 9999,
      topConcepts,
      methodologies,
      coSupervisors: Array.from(person.coSupervisors),
      topicSummary: buildTopicSummaryForDocs(person.docs),
    };
  });
}

function personListRow(person) {
  return {
    key: person.key,
    name: person.name,
    roles: person.roles,
    docCount: person.docCount,
    affiliations: person.affiliations,
    yearRange: person.yearRange,
    yearMin: person.yearMin,
  };
}

function personDetailRow(person) {
  const detailDocForPerson = (doc) => ({
    ...bootstrapDoc(doc),
    themes: doc.themes || [],
    conceptTerms: doc.conceptTerms || [],
    methodologies: doc.methodologies || [],
    topicId: doc.topicId ?? null,
    topicProbability: doc.topicProbability ?? null,
    personRoles: Array.from(person.docRoles?.get(docRoleKey(doc)) || []),
  });

  return {
    ...personListRow(person),
    topConcepts: person.topConcepts,
    methodologies: person.methodologies,
    coSupervisors: person.coSupervisors,
    topicSummary: person.topicSummary,
    docs: person.docs.map(detailDocForPerson),
    roleGroups: (person.roleGroups || []).map((group) => ({
      role: group.role,
      docs: group.docs.map(detailDocForPerson),
    })),
  };
}

function searchPeople(people = [], q = '') {
  if (!q) return people;
  return people.filter((person) =>
    String(person.name || '').toLowerCase().includes(q) ||
    (person.roles || []).some((role) => String(role || '').toLowerCase().includes(q)) ||
    (person.affiliations || []).some((affiliation) => String(affiliation || '').toLowerCase().includes(q))
  );
}

function personSortValue(person, key) {
  switch (key) {
    case 'name': return String(person.name || '').toLowerCase();
    case 'docCount': return Number(person.docCount || 0);
    case 'roles': return (person.roles || []).join(', ').toLowerCase();
    case 'years': return Number(person.yearMin || 9999);
    default: return '';
  }
}

function sortPeople(people = [], sortKey = 'docCount', sortDir = 'desc') {
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...people].sort((a, b) => {
    const av = personSortValue(a, sortKey);
    const bv = personSortValue(b, sortKey);
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv || String(a.name || '').localeCompare(String(b.name || ''))) * dir;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
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
    documents: (payload.documents || []).map(analyticsDoc),
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

async function cachedDocumentsForParams(params, loadSyncModule) {
  const documentCache = await documentCacheForParams(params, loadSyncModule);
  const documents = await listCachedDocuments({
    syncKey: documentCache.syncKey,
    limit: params.maxRecords,
  });
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
  const needsFullPass = Boolean(
    pageRequest.q ||
    pageRequest.sortKey ||
    filters.degree ||
    filters.program ||
    filters.affiliation
  );
  const documents = await listCachedDocuments({
    syncKey: documentCache.syncKey,
    limit: needsFullPass ? params.maxRecords : pageRequest.limit,
    offset: needsFullPass ? 0 : pageRequest.offset,
  });

  let rows = documents;
  if (needsFullPass) {
    rows = filterDocuments(rows, filters);
    rows = searchDocuments(rows, pageRequest.q);
    rows = sortDocumentRows(rows, pageRequest.sortKey, pageRequest.sortDir);
  }

  const total = needsFullPass
    ? rows.length
    : Math.min(params.maxRecords, documentCache.recordsAvailable || params.maxRecords);
  const pageRows = needsFullPass
    ? rows.slice(pageRequest.offset, pageRequest.offset + pageRequest.limit)
    : rows;

  await applyCitationCountsToDocuments(pageRows);
  await applyCommitteeMembersToDocuments(pageRows);

  return {
    generatedAt: new Date().toISOString(),
    source: {
      documentCache,
      offset: pageRequest.offset,
      limit: pageRequest.limit,
      total,
      hasMore: pageRequest.offset + pageRows.length < total,
    },
    documents: pageRows.map(bootstrapDoc),
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
  const { documents, documentCache } = await cachedDocumentsForParams(params, loadSyncModule);
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
      const { documents } = await cachedDocumentsForParams(params, loadSyncModule);
      enrichDocumentSignals(documents);
      const corpusDoc = documents.find((item) => item.id === doc.id);
      for (const field of ['themes', 'conceptTerms', 'methodologies']) {
        if (Array.isArray(corpusDoc?.[field]) && corpusDoc[field].length) {
          doc[field] = corpusDoc[field];
        }
      }
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
      const { records, sourceMeta, subjectLimit } = await metricRecordsForParams(params, loadSyncModule);
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
      const { records, sourceMeta, subjectLimit } = await metricRecordsForParams(params, loadSyncModule);
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
    const pageRequest = parsePagedRequest(req, 'docCount', 'desc');
    const key = `workbench:people:${sourceCacheKey(params)}:${JSON.stringify(filters)}:${JSON.stringify(pageRequest)}`;
    const payload = await cachedSlice(metricsCache, metricsInflight, key, params.refresh, async () => {
      const { records } = await metricRecordsForParams(params, loadSyncModule);
      const filtered = filterDocuments(records, filters);
      let people = buildPersonRows(filtered);
      if (pageRequest.role) people = people.filter((person) => person.roles.includes(pageRequest.role));
      people = searchPeople(people, pageRequest.q);
      people = sortPeople(people, pageRequest.sortKey, pageRequest.sortDir);
      const total = people.length;
      const pageRows = people.slice(pageRequest.offset, pageRequest.offset + pageRequest.limit);
      return {
        generatedAt: new Date().toISOString(),
        source: {
          total,
          offset: pageRequest.offset,
          limit: pageRequest.limit,
          hasMore: pageRequest.offset + pageRows.length < total,
        },
        people: pageRows.map(personListRow),
      };
    });
    res.status(200).json(payload);
  }));

  router.get('/workbench/people/:personKey', asyncHandler(async (req, res) => {
    const params = await parseMetricsRequest(req, res);
    if (!params) return;
    const filters = activeFilters(req);
    const personKey = String(req.params.personKey || '').toLowerCase().trim();
    const key = `workbench:people:detail:${sourceCacheKey(params)}:${JSON.stringify(filters)}:${personKey}`;
    const payload = await cachedSlice(metricsCache, metricsInflight, key, params.refresh, async () => {
      const { records } = await metricRecordsForParams(params, loadSyncModule);
      const filtered = filterDocuments(records, filters);
      const person = buildPersonRows(filtered).find((row) => row.key === personKey);
      return {
        generatedAt: new Date().toISOString(),
        person: person ? personDetailRow(person) : null,
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
      const { documents } = await cachedDocumentsForParams(params, loadSyncModule);
      await applyCitationCountsToDocuments(documents);
      await applyCommitteeMembersToDocuments(documents);
      let rows = filterDocuments(documents, filters);
      rows = searchDocuments(rows, pageRequest.q);
      rows = sortCitationDocs(rows, pageRequest.sortKey, pageRequest.sortDir || 'desc');
      const total = rows.length;
      const withCitations = rows.filter((doc) => (doc.citationCount || 0) > 0).length;
      const pageRows = rows.slice(pageRequest.offset, pageRequest.offset + pageRequest.limit);
      return {
        generatedAt: new Date().toISOString(),
        source: {
          total,
          withCitations,
          offset: pageRequest.offset,
          limit: pageRequest.limit,
          hasMore: pageRequest.offset + pageRows.length < total,
        },
        documents: pageRows.map(citationDoc),
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
