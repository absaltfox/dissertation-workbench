import { DEFAULT_INDEX, DEFAULT_QUERY, DEFAULT_SOURCE, DEFAULT_TERM } from './config.js';

export const IMPORT_RULE_FIELDS = [
  { key: 'degree', termField: 'degree.raw', label: 'Degree' },
  { key: 'program', termField: 'program.raw', label: 'Program' },
  { key: 'affiliation', termField: 'affiliation.raw', label: 'Affiliation' },
];

function clean(value) {
  return String(value ?? '').trim();
}

export function normalizeImportRule(input = {}) {
  return {
    id: clean(input.id),
    name: clean(input.name),
    degree: clean(input.degree),
    program: clean(input.program),
    affiliation: clean(input.affiliation),
    index: clean(input.index),
    query: clean(input.query),
    source: clean(input.source) || DEFAULT_SOURCE,
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
  return { rule, errors };
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
    index: rule.index,
    query: rule.query,
    term: buildImportRuleTerm(rule) || DEFAULT_TERM,
    source: rule.source || DEFAULT_SOURCE,
    ...overrides,
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
