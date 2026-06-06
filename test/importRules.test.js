import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImportRuleTerm, importRuleToSyncOptions, validateImportRule } from '../src/importRules.js';

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
