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

// saveCitations skips a fuzzy candidate when this bound puts it below the merge
// threshold (src/db.js, jaroWinklerUpperBound). The skip is only safe while the
// bound never reads lower than the score jaroWinkler actually returns, so the
// property is asserted here directly, over the string shapes citations take.
function jaroWinklerUpperBound(a, b) {
  const counts = new Int32Array(256);
  for (let i = 0; i < a.length; i += 1) counts[a.charCodeAt(i) & 0xff] += 1;
  let matches = 0;
  for (let i = 0; i < b.length; i += 1) {
    const code = b.charCodeAt(i) & 0xff;
    if (counts[code] > 0) {
      counts[code] -= 1;
      matches += 1;
    }
  }
  if (!matches || !a.length || !b.length) return 0;
  const jaro = ((matches / a.length) + (matches / b.length) + 1) / 3;
  return (0.6 * jaro) + 0.4;
}

test('the fuzzy candidate pre-filter never scores below jaroWinkler', () => {
  const surnames = ['Smith', 'Sørensen', 'Ekwueme', 'Ishikawa', 'Delacroix', 'Xu', 'Papadopoulos'];
  const works = ['experience and education', 'pedagogy of the oppressed', 'mind in society',
    'the structure of scientific revolutions', 'seeing like a state', 'distinction'];
  const presses = ['Macmillan', 'Continuum', 'Harvard University Press', 'UCP', 'Yale University Press'];

  const strings = [''];
  for (let i = 0; i < surnames.length; i += 1) {
    for (let j = 0; j < works.length; j += 1) {
      const year = 1930 + ((i * 7 + j * 13) % 90);
      const base = `${surnames[i]}, ${'ABCD'[j % 4]}. (${year}). ${works[j]}. ${presses[(i + j) % presses.length]}.`;
      strings.push(base.toLowerCase());
      strings.push(base.toLowerCase().replace(/\./g, ''));
      strings.push(`${base.toLowerCase()} reprinted edition`);
      strings.push(base.toLowerCase().slice(0, 12));
    }
  }

  let checked = 0;
  let binding = 0;
  for (const a of strings) {
    for (const b of strings) {
      const bound = jaroWinklerUpperBound(a, b);
      const actual = jaroWinkler(a, b);
      assert.ok(
        actual <= bound + 1e-12,
        `bound ${bound} is below the real similarity ${actual} for ${JSON.stringify([a, b])}`
      );
      checked += 1;
      if (bound < 0.94) binding += 1;
    }
  }
  assert.ok(checked > 10000, 'not enough pairs checked to be meaningful');
  // The bound has to actually reject candidates, or the pre-filter buys nothing.
  assert.ok(binding / checked > 0.5, `pre-filter only rejected ${binding} of ${checked} pairs`);
});
