import test from 'node:test';
import assert from 'node:assert/strict';
import { documentThemeTerms } from '../src/nlp.js';

test('documentThemeTerms never returns "unspecified" for a placeholder subject', () => {
  const terms = documentThemeTerms({
    title: 'Salmon migration',
    abstract: 'Salmon migration in coastal rivers',
    subjects: ['(Unspecified)'],
  });
  assert.ok(!terms.includes('unspecified'));
  assert.ok(terms.includes('salmon'));
});

test('documentThemeTerms keeps real subject words', () => {
  const terms = documentThemeTerms({ title: 'Stand dynamics', abstract: '', subjects: ['Forestry'] });
  assert.ok(terms.includes('forestry'));
});
