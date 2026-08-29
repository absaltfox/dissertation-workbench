import { DEFAULT_INDEX, DEFAULT_QUERY, DEFAULT_SOURCE, DEFAULT_TERM, MAX_DOWNLOAD_BYTES } from './config.js';

export const IMPORT_RULE_FIELDS = [
  { key: 'degree', termField: 'degree.raw', label: 'Degree' },
  { key: 'program', termField: 'program.raw', label: 'Program' },
  { key: 'affiliation', termField: 'affiliation.raw', label: 'Affiliation' },
];

export const IMPORT_CONTENT_MODES = Object.freeze([
  'metadata_only',
  'full_text_only',
  'pdf_stream',
  'pdf_cache',
]);
export const DEFAULT_IMPORT_CONTENT_MODE = 'metadata_only';
const IMPORT_CONTENT_MODE_SET = new Set(IMPORT_CONTENT_MODES);
export const IMPORT_CONTENT_FALLBACKS = Object.freeze(['metadata_only', 'full_text', 'fail_document']);
export const DEFAULT_IMPORT_CONTENT_FALLBACK = 'fail_document';
export const DEFAULT_IMPORT_CONTENT_CONCURRENCY = 1;
export const MAX_IMPORT_CONTENT_CONCURRENCY = 8;
export const MAX_IMPORT_CONTENT_RATE_LIMIT = 600;
const IMPORT_CONTENT_FALLBACK_SET = new Set(IMPORT_CONTENT_FALLBACKS);

export function isImportContentMode(value) {
  return IMPORT_CONTENT_MODE_SET.has(value);
}

function clean(value) {
  return String(value ?? '').trim();
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 1)) return Boolean(value);
  if (typeof value === 'string') {
    if (/^(1|true|yes|on)$/i.test(value)) return true;
    if (/^(0|false|no|off)$/i.test(value)) return false;
  }
  return null;
}

function integerValue(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

export function normalizeImportRule(input = {}) {
  const requestedContentMode = clean(input.contentMode ?? input.content_mode);
  const requestedFallback = clean(input.contentFallback ?? input.content_fallback);
  return {
    id: clean(input.id),
    name: clean(input.name),
    degree: clean(input.degree),
    program: clean(input.program),
    affiliation: clean(input.affiliation),
    index: clean(input.index),
    query: clean(input.query),
    source: clean(input.source) || DEFAULT_SOURCE,
    contentMode: requestedContentMode || DEFAULT_IMPORT_CONTENT_MODE,
    contentFallback: requestedFallback || DEFAULT_IMPORT_CONTENT_FALLBACK,
    extractCitations: booleanValue(input.extractCitations ?? input.extract_citations, false),
    extractCommittee: booleanValue(input.extractCommittee ?? input.extract_committee, true),
    runConcepts: booleanValue(input.runConcepts ?? input.run_concepts, true),
    maxContentBytes: integerValue(input.maxContentBytes ?? input.max_content_bytes, MAX_DOWNLOAD_BYTES),
    contentConcurrency: integerValue(
      input.contentConcurrency ?? input.content_concurrency,
      DEFAULT_IMPORT_CONTENT_CONCURRENCY
    ),
    contentRateLimit: integerValue(input.contentRateLimit ?? input.content_rate_limit, 0),
  };
}

export function validateImportRule(input = {}) {
  const rule = normalizeImportRule(input);
  const errors = [];
  if (!rule.name) errors.push('Rule name is required.');
  if (rule.name.length > 120) errors.push('Rule name must be at most 120 characters.');
  for (const field of IMPORT_RULE_FIELDS) {
    if (rule[field.key].length > 250) errors.push(`${field.label} must be at most 250 characters.`);
  }
  if (rule.index.length > 100) errors.push('Index must be at most 100 characters.');
  if (rule.query.length > 300) errors.push('Query must be at most 300 characters.');
  if (rule.source.length > 1000) errors.push('Source fields must be at most 1000 characters.');
  if (!isImportContentMode(rule.contentMode)) {
    errors.push(`Content mode must be one of: ${IMPORT_CONTENT_MODES.join(', ')}.`);
  }
  if (!IMPORT_CONTENT_FALLBACK_SET.has(rule.contentFallback)) {
    errors.push(`Content fallback must be one of: ${IMPORT_CONTENT_FALLBACKS.join(', ')}.`);
  }
  if (typeof rule.extractCitations !== 'boolean') errors.push('Extract citations must be a boolean.');
  if (typeof rule.extractCommittee !== 'boolean') errors.push('Extract committee must be a boolean.');
  if (typeof rule.runConcepts !== 'boolean') errors.push('Run concepts must be a boolean.');
  if (!Number.isInteger(rule.maxContentBytes) || rule.maxContentBytes < 1024 || rule.maxContentBytes > MAX_DOWNLOAD_BYTES) {
    errors.push(`Maximum content bytes must be between 1024 and ${MAX_DOWNLOAD_BYTES}.`);
  }
  if (!Number.isInteger(rule.contentConcurrency)
      || rule.contentConcurrency < 1
      || rule.contentConcurrency > MAX_IMPORT_CONTENT_CONCURRENCY) {
    errors.push(`Content concurrency must be between 1 and ${MAX_IMPORT_CONTENT_CONCURRENCY}.`);
  }
  if (!Number.isInteger(rule.contentRateLimit)
      || rule.contentRateLimit < 0
      || rule.contentRateLimit > MAX_IMPORT_CONTENT_RATE_LIMIT) {
    errors.push(`Content rate limit must be between 0 and ${MAX_IMPORT_CONTENT_RATE_LIMIT} requests per minute.`);
  }
  return { rule, errors };
}

export function contentModeRequestsOriginalPdf(contentMode) {
  return contentMode === 'pdf_stream' || contentMode === 'pdf_cache';
}

export function contentModeEnrichesDocuments(contentMode) {
  return isImportContentMode(contentMode) && contentMode !== 'metadata_only';
}

export function buildImportRuleTerm(input = {}) {
  const rule = normalizeImportRule(input);
  return IMPORT_RULE_FIELDS
    .map((field) => {
      const value = rule[field.key];
      return value ? `${field.termField},${value}` : null;
    })
    .filter(Boolean)
    .join(';');
}

export function importRuleToSyncOptions(input = {}, overrides = {}) {
  const rule = normalizeImportRule(input);
  return {
    importRuleId: rule.id,
    index: rule.index,
    query: rule.query,
    term: buildImportRuleTerm(rule) || DEFAULT_TERM,
    source: rule.source || DEFAULT_SOURCE,
    ...overrides,
    contentMode: rule.contentMode,
    contentFallback: rule.contentFallback,
    extractCitations: rule.extractCitations,
    extractCommittee: rule.extractCommittee,
    runConcepts: rule.runConcepts,
    maxContentBytes: rule.maxContentBytes,
    contentConcurrency: rule.contentConcurrency,
    contentRateLimit: rule.contentRateLimit,
  };
}

export function importRuleFromSettings(settings = {}) {
  return normalizeImportRule({
    name: settings.importRuleName || 'Current import rule',
    degree: settings.importDegree || '',
    program: settings.importProgram || '',
    affiliation: settings.importAffiliation || '',
    index: settings.index ?? DEFAULT_INDEX,
    query: settings.query ?? DEFAULT_QUERY,
    source: settings.source ?? DEFAULT_SOURCE,
  });
}
