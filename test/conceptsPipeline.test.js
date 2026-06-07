import test from 'node:test';
import assert from 'node:assert/strict';
import { _testing } from '../src/conceptsPipeline.js';

const {
  stemForSim,
  phraseSimilarity,
  extractDocPhrases,
  computePhraseQuality,
  shouldKeepPhrase,
} = _testing;

test('stemForSim handles common plural patterns for similarity calculations', () => {
  assert.equal(stemForSim('policies'), 'policy');
  assert.equal(stemForSim('students'), 'student');
  assert.equal(stemForSim('studies'), 'study');
  assert.equal(stemForSim('class'), 'class');
  assert.equal(stemForSim('leadership'), 'leadership');
});

test('phraseSimilarity computes Jaccard index with morphological head bonuses', () => {
  // Identical tokens
  const simIdentical = phraseSimilarity(['educational', 'policy'], ['educational', 'policy']);
  // 1.0 Jaccard + 0.2 prefix bonus = 1.2
  assert.equal(simIdentical, 1.2);

  // Morphologically related heads (leader vs leadership) should trigger the head bonus (0.7)
  const simHeads = phraseSimilarity(['educational', 'leader'], ['educational', 'leadership']);
  assert.ok(simHeads >= 0.7);

  // Unrelated heads (practices vs practitioners - length >= 5 but neither prefix-matches the other)
  const simUnrelated = phraseSimilarity(['educational', 'practices'], ['educational', 'practitioners']);
  // Jaccard similarity is 1 / 3 = 0.3333333333333333, no prefix bonus, no head bonus
  assert.equal(simUnrelated, 1 / 3);
});

test('extractDocPhrases extracts bigrams and trigrams while filtering stop words', () => {
  const doc = {
    title: 'Indigenous Education Policy: A Critical Perspective',
    abstract: 'This study explores teacher professional development and counselling psychology.',
    subjects: ['Faculty of Education', 'Higher Education'],
  };

  const phrases = extractDocPhrases(doc);

  // 'education' is in STOP_WORDS, so any phrase with it is skipped.
  // 'teacher professional development' is canonicalized to 'professional learning' in DOMAIN_DICTIONARY
  assert.ok(phrases.has('professional learning'));
  assert.ok(phrases.has('counselling psychology'));

  // Asserting stop words or disallowed words/fragments are skipped
  // "education policy" contains stop word "education"
  assert.ok(!phrases.has('education policy'));
  // "this study explores" contains stop words "this", "study"
  assert.ok(!phrases.has('this study'));
});

test('computePhraseQuality computes score based on length and nested characteristics', () => {
  const entry = {
    phrase: 'counselling psychology',
    tokens: ['counselling', 'psychology'],
    docFreq: 10,
  };

  const nestedStats = new Map();
  // If it's never nested, nested containers is 0
  nestedStats.set('counselling psychology', { containers: 0, containerFreqSum: 0 });

  const score = computePhraseQuality(entry, nestedStats);
  // Length is 2, lengthWeight is log2(2) = 1.
  // cValue is 1 * (10 - 0) = 10.
  // No weak head penalty, strong head boost is 0.
  // Expect score to be around 10
  assert.ok(score > 8 && score <= 10);
});

test('shouldKeepPhrase filters low frequency and weak-headed phrases appropriately', () => {
  const entryHighFreq = {
    phrase: 'educational leadership',
    tokens: ['educational', 'leadership'],
    docFreq: 12,
  };
  // Frequency >= 10 should be kept
  assert.equal(shouldKeepPhrase(entryHighFreq, 0.2), true);

  const entryWeakHead = {
    phrase: 'education study',
    tokens: ['education', 'study'],
    docFreq: 2,
  };
  // Weak head 'study' at docFreq < 3 should be filtered out
  assert.equal(shouldKeepPhrase(entryWeakHead, 0.1), false);
});
