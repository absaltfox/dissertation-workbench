import test from 'node:test';
import assert from 'node:assert/strict';
import { jaroWinkler } from '../src/fuzzyMatch.js';

test('Jaro-Winkler exact match', () => {
  assert.equal(jaroWinkler('hello', 'hello'), 1.0);
  assert.equal(jaroWinkler('smith, j. (1998). educational leadership.', 'smith, j. (1998). educational leadership.'), 1.0);
});

test('Jaro-Winkler similar strings (above 0.90)', () => {
  const sim1 = jaroWinkler(
    'smith, j (1998) educational leadership',
    'smith, j. (1998). educational leadership.'
  );
  assert.ok(sim1 >= 0.90, `Expected >= 0.90, got ${sim1}`);

  const sim2 = jaroWinkler(
    'dewey, j. (1938). experience and education. macmillan.',
    'dewey, j (1938) experience and education macmillan'
  );
  assert.ok(sim2 >= 0.90, `Expected >= 0.90, got ${sim2}`);

  // Minor typo / OCR noise
  const sim3 = jaroWinkler(
    'freire, p. (1970). pedagogy of the oppressed.',
    'freire, p. (1970). pedagogy of the oppresed.'
  );
  assert.ok(sim3 >= 0.90, `Expected >= 0.90, got ${sim3}`);
});

test('Jaro-Winkler different strings (below 0.90)', () => {
  const sim1 = jaroWinkler(
    'smith, j. (1998). educational leadership.',
    'jones, a. (2002). teacher resilience.'
  );
  assert.ok(sim1 < 0.90, `Expected < 0.90, got ${sim1}`);

  const sim2 = jaroWinkler(
    'freire, p. (1970). pedagogy of the oppressed.',
    'dewey, j. (1938). experience and education.'
  );
  assert.ok(sim2 < 0.90, `Expected < 0.90, got ${sim2}`);
});

test('Jaro-Winkler empty or null inputs', () => {
  assert.equal(jaroWinkler('', 'hello'), 0.0);
  assert.equal(jaroWinkler('hello', null), 0.0);
  assert.equal(jaroWinkler(null, null), 0.0);
});
