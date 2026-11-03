import test from 'node:test';
import assert from 'node:assert/strict';
import { documentThemeTerms, buildWordCloud, subjectsText, UNSPECIFIED_SUBJECT } from '../src/nlp.js';

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

test('subjectsText drops the placeholder from arrays and strings', () => {
  assert.equal(UNSPECIFIED_SUBJECT, '(Unspecified)');
  assert.equal(subjectsText(['(Unspecified)']), '');
  assert.equal(subjectsText(['(Unspecified)', 'Forestry']), 'Forestry');
  assert.equal(subjectsText('(Unspecified)'), '');
  assert.equal(subjectsText('Forestry'), 'Forestry');
  assert.equal(subjectsText(['Soil', 'Forestry'], '/'), 'Soil/Forestry');
  assert.equal(subjectsText(undefined), '');
});

test('buildWordCloud never returns "unspecified" for a placeholder subject', () => {
  const cloud = buildWordCloud([
    { title: 'Salmon migration', abstract: 'Salmon migration in rivers', subjects: ['(Unspecified)'], program: '', degree: '' },
  ]);
  assert.ok(!cloud.some((t) => t.term === 'unspecified'));
  assert.ok(cloud.some((t) => t.term === 'salmon'));
});

test('buildWordCloud keeps real subject words next to the placeholder', () => {
  const cloud = buildWordCloud([
    { title: 'Salmon migration', abstract: 'Salmon migration in rivers', subjects: ['(Unspecified)', 'Forestry'], program: '', degree: '' },
  ]);
  assert.ok(!cloud.some((t) => t.term === 'unspecified'));
  assert.ok(cloud.some((t) => t.term === 'forestry'));
});

test('buildWordCloud accepts the string form of the placeholder', () => {
  const cloud = buildWordCloud([
    { title: 'Salmon migration', abstract: 'Salmon migration in rivers', subjects: '(Unspecified)', program: '', degree: '' },
  ]);
  assert.ok(!cloud.some((t) => t.term === 'unspecified'));
});
