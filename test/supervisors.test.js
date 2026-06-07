import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeSupervisorNames, supervisorNameKey, namesCompatible } from '../src/supervisors.js';

test('supervisorNameKey keeps middle initials', () => {
  assert.equal(supervisorNameKey('Thomas J. Sork'), 'thomas j sork');
  assert.equal(supervisorNameKey('Thomas Sork'), 'thomas sork');
});

test('namesCompatible handles middle initials correctly', () => {
  // Same first/last, different middle initials -> incompatible (prevents false merger)
  assert.equal(namesCompatible('thomas j sork', 'thomas b sork'), false);
  
  // Same first/last, one has middle initial, other does not -> compatible (merges)
  assert.equal(namesCompatible('thomas j sork', 'thomas sork'), true);
  
  // Identical strings -> compatible
  assert.equal(namesCompatible('thomas j sork', 'thomas j sork'), true);
});

test('dedupeSupervisorNames merges compatible names and keeps most specific version', () => {
  const inputs = ['John Smith', 'John J. Smith', 'John B. Smith'];
  
  // John Smith and John J. Smith are compatible, and J. Smith is more specific -> keeps 'John J. Smith'
  // John B. Smith is incompatible with John J. Smith -> keeps both 'John J. Smith' and 'John B. Smith'
  const result = dedupeSupervisorNames(inputs);
  
  assert.equal(result.length, 2);
  assert.ok(result.includes('John J. Smith'));
  assert.ok(result.includes('John B. Smith'));
});

test('dedupeSupervisorNames respects canonical overrides', () => {
  const inputs = ['Deirdre M. Kelly', 'Tom Sork'];
  const result = dedupeSupervisorNames(inputs);
  
  assert.ok(result.includes('Deirdre Kelly'), 'Expected Deirdre M. Kelly to map to override Deirdre Kelly');
  assert.ok(result.includes('Tom Sork'));
});
