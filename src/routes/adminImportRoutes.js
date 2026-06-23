import { Router } from 'express';
import {
  deleteImportRule, getImportRule, listAllDocumentMetadata, listImportRules,
  saveImportRule, hasRunningAdminJob
} from '../db.js';
import { createAndStartAdminWorkerJob } from '../services/adminWorker.js';
import { DEFAULT_BASE_URL, DEFAULT_SOURCE, DEFAULT_TERM } from '../config.js';
import { fetchPage, extractHits, fetchSearchAggregations, resolveIndexName } from '../api.js';
import { normalizeRecord } from '../metrics.js';
import { getConfiguredApiKey } from '../secrets.js';
import { parseBooleanParam, parseNumberParam } from '../validate.js';
import { asyncHandler } from '../middleware/http.js';
import {
  IMPORT_RULE_FIELDS, buildImportRuleTerm, importRuleToSyncOptions,
  normalizeImportRule, validateImportRule
} from '../importRules.js';
import { logger } from '../logger.js';

function cleanImportRequest(input = {}) {
  return normalizeImportRule({
    id: input.id,
    name: input.name,
    degree: input.degree,
    program: input.program,
    affiliation: input.affiliation,
    index: input.index,
    query: input.query,
    source: input.source || DEFAULT_SOURCE,
  });
}

function toList(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function addFacetCount(map, value) {
  const text = String(value || '').trim();
  if (!text) return;
  map.set(text, (map.get(text) || 0) + 1);
}

function facetBucketsFromMap(map) {
  return Array.from(map.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, 100);
}

async function localImportFacets() {
  const maps = { degree: new Map(), program: new Map(), affiliation: new Map() };
  for (const { metadata } of await listAllDocumentMetadata()) {
    for (const value of toList(metadata.degree)) addFacetCount(maps.degree, value);
    for (const value of toList(metadata.program)) addFacetCount(maps.program, value);
    for (const value of toList(metadata.affiliation)) addFacetCount(maps.affiliation, value);
  }
  return {
    degree: facetBucketsFromMap(maps.degree),
    program: facetBucketsFromMap(maps.program),
    affiliation: facetBucketsFromMap(maps.affiliation),
  };
}

function readAggregationBuckets(payload, key) {
  const aggregations = payload?.data?.aggregations || payload?.aggregations || {};
  const buckets = aggregations[key]?.buckets || aggregations[key]?.terms?.buckets || [];
  return buckets.map((bucket) => ({
    value: String(bucket.key ?? ''),
    count: Number(bucket.doc_count || 0),
  })).filter((bucket) => bucket.value);
}

/**
 * Creates admin endpoints for Open Collections import-rule management.
 *
 * Mounted behind `requireAdmin`; mutating requests also pass the global CSRF
 * middleware. Import and preview routes lazy-load sync code because it pulls in
 * the heavier PDF/metrics pipeline.
 */
export function createAdminImportRouter({ loadSyncModule, clearMetricsCache }) {
  const router = Router();

  router.get('/import-rules', asyncHandler(async (_req, res) => {
    res.status(200).json({ rules: await listImportRules() });
  }));

  router.post('/import-rules', asyncHandler(async (req, res) => {
    const { rule, errors } = validateImportRule(req.body || {});
    if (errors.length) {
      res.status(400).json({ error: 'Validation failed', errors });
      return;
    }
    res.status(201).json({ ok: true, rule: await saveImportRule(rule) });
  }));

  router.put('/import-rules/:id', asyncHandler(async (req, res) => {
    const { rule, errors } = validateImportRule({ ...(req.body || {}), id: req.params.id });
    if (errors.length) {
      res.status(400).json({ error: 'Validation failed', errors });
      return;
    }
    if (!(await getImportRule(req.params.id))) {
      res.status(404).json({ error: 'Import rule not found' });
      return;
    }
    res.status(200).json({ ok: true, rule: await saveImportRule(rule) });
  }));

  router.delete('/import-rules/:id', asyncHandler(async (req, res) => {
    if (!(await deleteImportRule(req.params.id))) {
      res.status(404).json({ error: 'Import rule not found' });
      return;
    }
    res.status(200).json({ ok: true });
  }));

  router.get('/open-collections/facets', asyncHandler(async (req, res) => {
    const apiKey = await getConfiguredApiKey();
    const rule = cleanImportRequest(req.query);
    const term = buildImportRuleTerm(rule);
    const aggregations = Object.fromEntries(IMPORT_RULE_FIELDS.map((field) => [
      field.key,
      { terms: { field: field.termField, size: 100, order: { _count: 'desc' } } },
    ]));

    try {
      const index = rule.index ? await resolveIndexName(DEFAULT_BASE_URL, rule.index, apiKey) : null;
      const payload = await fetchSearchAggregations({
        baseUrl: DEFAULT_BASE_URL,
        index,
        apiKey,
        query: rule.query,
        term,
        aggregations,
      });
      res.status(200).json({
        source: 'open-collections',
        facets: {
          degree: readAggregationBuckets(payload, 'degree'),
          program: readAggregationBuckets(payload, 'program'),
          affiliation: readAggregationBuckets(payload, 'affiliation'),
        },
      });
    } catch (error) {
      // Facets are a convenience for building import rules. When the upstream
      // API is unavailable, cached metadata is still useful and keeps Admin usable.
      logger.warn('Open Collections facet lookup failed; using local cache', { error: error?.message || String(error) });
      res.status(200).json({
        source: 'cache',
        warning: 'Live Open Collections facets unavailable; showing values from cached documents.',
        facets: await localImportFacets(),
      });
    }
  }));

  router.get('/import-rules/preview', asyncHandler(async (req, res) => {
    const apiKey = await getConfiguredApiKey();
    const rule = cleanImportRequest(req.query);
    const term = buildImportRuleTerm(rule) || DEFAULT_TERM;
    const pageSize = 5;
    const scanLimit = parseNumberParam(req.query.scanLimit, 50_000, 1, 50_000);
    const maxRecords = parseNumberParam(req.query.maxRecords, 9999, 1, 9999);
    const index = rule.index ? await resolveIndexName(DEFAULT_BASE_URL, rule.index, apiKey) : null;
    const payload = await fetchPage({
      baseUrl: DEFAULT_BASE_URL,
      index,
      apiKey,
      from: 0,
      pageSize,
      query: rule.query,
      term,
      source: rule.source || DEFAULT_SOURCE,
    });
    const rawTotal = payload?.data?.hits?.total ?? payload?.hits?.total ?? 0;
    const total = Number(typeof rawTotal === 'object' ? rawTotal.value : rawTotal) || 0;
    const samples = extractHits(payload).slice(0, pageSize).map((raw) => {
      const doc = normalizeRecord(raw);
      return {
        id: doc.id,
        title: doc.title,
        author: doc.author,
        year: doc.year,
        degree: doc.degree,
        program: doc.program,
      };
    });
    const warnings = [];
    if (total > scanLimit) warnings.push(`This rule matches ${total} records, more than the current scan limit of ${scanLimit}.`);
    if (total > maxRecords) warnings.push(`This rule matches ${total} records, more than the current max records setting of ${maxRecords}.`);
    res.status(200).json({ total, samples, warnings, term });
  }));

  router.post('/import-rules/sync', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const rule = body.id ? await getImportRule(body.id) : normalizeImportRule(body);
    if (!rule) {
      res.status(404).json({ error: 'Import rule not found' });
      return;
    }
    const mode = String(body.mode || 'import_all');
    const { DOCUMENT_SYNC_MODES } = await loadSyncModule();
    if (!DOCUMENT_SYNC_MODES.has(mode)) {
      res.status(400).json({ error: 'Invalid import run mode.' });
      return;
    }
    const options = importRuleToSyncOptions(rule, {
      mode,
      maxRecords: body.maxRecords,
      syncMaxRecords: body.syncMaxRecords ?? body.scanLimit,
      pageSize: body.pageSize,
      scanLimit: body.scanLimit,
      downloadFiles: parseBooleanParam(body.downloadFiles, true),
      apiKey: await getConfiguredApiKey(),
    });
    const runningId = await hasRunningAdminJob('document_sync');
    if (runningId) {
      res.status(202).json({ ok: true, alreadyRunning: true, jobId: runningId });
      return;
    }
    const result = await createAndStartAdminWorkerJob({
      type: 'document_sync',
      label: `Import Rule Sync: ${rule.name || 'Ad hoc rule'}`,
      params: { options },
    });
    clearMetricsCache();
    res.status(202).json({ ok: true, started: true, ...result });
  }));

  router.post('/import-rules/run', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const mode = String(body.mode || '');
    const scope = String(body.scope || 'selected');
    const { DOCUMENT_SYNC_MODES } = await loadSyncModule();
    if (!DOCUMENT_SYNC_MODES.has(mode)) {
      res.status(400).json({ error: 'Invalid import run mode.' });
      return;
    }
    if (!['selected', 'all'].includes(scope)) {
      res.status(400).json({ error: 'Invalid import rule scope.' });
      return;
    }

    const allRules = await listImportRules();
    const selectedIds = Array.isArray(body.ruleIds)
      ? body.ruleIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    const rules = scope === 'all' ? allRules : allRules.filter((rule) => selectedIds.includes(rule.id));
    if (!rules.length) {
      res.status(400).json({ error: scope === 'all' ? 'No import rules are saved.' : 'Select at least one import rule.' });
      return;
    }

    const runningId = await hasRunningAdminJob('import_rules_sync');
    if (runningId) {
      res.status(202).json({ ok: true, alreadyRunning: true, jobId: runningId });
      return;
    }

    const result = await createAndStartAdminWorkerJob({
      type: 'import_rules_sync',
      label: 'Import Rules Sync',
      params: { mode, scope, ruleIds: selectedIds, downloadFiles: parseBooleanParam(body.downloadFiles, true) },
    });

    clearMetricsCache();
    res.status(202).json({ ok: true, started: true, ...result });
  }));

  return router;
}
