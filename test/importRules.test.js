import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImportRuleTerm, contentModeEnrichesDocuments, contentModeRequestsOriginalPdf,
  importRuleToSyncOptions, validateImportRule
} from '../src/importRules.js';

test('buildImportRuleTerm handles one selected field', () => {
  assert.equal(
    buildImportRuleTerm({ degree: 'Doctor of Education - EdD' }),
    'degree.raw,Doctor of Education - EdD'
  );
});

test('buildImportRuleTerm joins selected fields with AND semantics', () => {
  assert.equal(
    buildImportRuleTerm({
      degree: 'Doctor of Education - EdD',
      program: 'Educational Leadership and Policy',
      affiliation: 'Faculty of Education',
    }),
    'degree.raw,Doctor of Education - EdD;program.raw,Educational Leadership and Policy;affiliation.raw,Faculty of Education'
  );
});

test('buildImportRuleTerm ignores blank fields', () => {
  assert.equal(
    buildImportRuleTerm({ degree: 'Doctor of Education - EdD', program: ' ', affiliation: '' }),
    'degree.raw,Doctor of Education - EdD'
  );
});

test('importRuleToSyncOptions preserves punctuation for existing API encoder', () => {
  const options = importRuleToSyncOptions({
    name: 'Comma value',
    degree: 'Doctor of Philosophy - PhD',
    program: 'Language, Literacy and Education',
  });
  assert.equal(options.term, 'degree.raw,Doctor of Philosophy - PhD;program.raw,Language, Literacy and Education');
});

test('validateImportRule requires a name', () => {
  const result = validateImportRule({ degree: 'Doctor of Education - EdD' });
  assert.deepEqual(result.errors, ['Rule name is required.']);
});

test('import rules default conservatively to metadata-only processing', () => {
  const result = validateImportRule({ name: 'Metadata rule' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.rule.contentMode, 'metadata_only');
  assert.equal(result.rule.contentFallback, 'fail_document');
  assert.equal(result.rule.extractCitations, false);
  assert.equal(result.rule.extractCommittee, true);
  assert.equal(result.rule.runConcepts, true);
  assert.equal(result.rule.contentConcurrency, 1);
  assert.equal(result.rule.contentRateLimit, 0);
});

test('import rules validate and snapshot all content controls', () => {
  const input = {
    name: 'Controlled rule',
    contentMode: 'pdf_stream',
    contentFallback: 'full_text',
    extractCitations: true,
    extractCommittee: false,
    runConcepts: false,
    maxContentBytes: 10_000_000,
    contentConcurrency: 4,
    contentRateLimit: 30,
  };
  const { rule, errors } = validateImportRule(input);
  assert.deepEqual(errors, []);
  assert.deepEqual(importRuleToSyncOptions(input), {
    importRuleId: '',
    index: '',
    query: '',
    term: 'degree.raw,Doctor of Education - EdD',
    source: rule.source,
    contentMode: 'pdf_stream',
    contentFallback: 'full_text',
    extractCitations: true,
    extractCommittee: false,
    runConcepts: false,
    maxContentBytes: 10_000_000,
    contentConcurrency: 4,
    contentRateLimit: 30,
  });
});

test('import rules reject out-of-bounds resource controls', () => {
  const { errors } = validateImportRule({
    name: 'Unsafe controls',
    contentFallback: 'surprise_pdf',
    maxContentBytes: 100,
    contentConcurrency: 9,
    contentRateLimit: 601,
  });
  assert.equal(errors.length, 4);
});

test('import rules reject ambiguous extraction toggles', () => {
  const { errors } = validateImportRule({
    name: 'Ambiguous toggles',
    extractCitations: 'sometimes',
    extractCommittee: 2,
    runConcepts: {},
  });
  assert.deepEqual(errors, [
    'Extract citations must be a boolean.',
    'Extract committee must be a boolean.',
    'Run concepts must be a boolean.',
  ]);
});

test('validateImportRule rejects unknown content modes', () => {
  const result = validateImportRule({ name: 'Unsafe rule', contentMode: 'download_everything' });
  assert.deepEqual(result.errors, [
    'Content mode must be one of: metadata_only, full_text_only, pdf_stream, pdf_cache.',
  ]);
});

test('importRuleToSyncOptions snapshots the rule content mode over legacy overrides', () => {
  const options = importRuleToSyncOptions({
    name: 'Text only',
    contentMode: 'full_text_only',
  }, { contentMode: 'pdf_cache' });
  assert.equal(options.contentMode, 'full_text_only');
});

test('only PDF content modes request original bitstreams', () => {
  assert.equal(contentModeRequestsOriginalPdf('metadata_only'), false);
  assert.equal(contentModeRequestsOriginalPdf('full_text_only'), false);
  assert.equal(contentModeRequestsOriginalPdf('pdf_stream'), true);
  assert.equal(contentModeRequestsOriginalPdf('pdf_cache'), true);
});

test('unknown content modes never opt into enrichment', () => {
  assert.equal(contentModeEnrichesDocuments('unknown_mode'), false);
});
