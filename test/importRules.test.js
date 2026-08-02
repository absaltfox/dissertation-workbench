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
