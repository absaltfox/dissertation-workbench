import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessTextQuality } from '../scripts/committee-eval/lib/quality.mjs';

test('clean prose is not degraded', () => {
  const text = 'I thank my supervisor, Dr. Deirdre Kelly, for her guidance. '.repeat(60);
  const q = assessTextQuality(text);
  assert.equal(q.degraded, false);
});

test('very short text is degraded', () => {
  const q = assessTextQuality('too short');
  assert.equal(q.degraded, true);
  assert.equal(q.reason, 'short');
});

test('glyph-per-token OCR spray is degraded', () => {
  const text = ('a b c d e f g h i j k l m n o p q r s t u v w x y z ').repeat(30);
  const q = assessTextQuality(text);
  assert.equal(q.degraded, true);
  assert.equal(q.reason, 'fragmented');
});
