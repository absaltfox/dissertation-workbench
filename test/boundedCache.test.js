import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedCache } from '../src/boundedCache.js';

test('evicts the least recently used entry beyond maxEntries', () => {
  const cache = createBoundedCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // bump recency of a
  cache.set('c', 3); // evicts b
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.size, 2);
});

test('clear empties the cache', () => {
  const cache = createBoundedCache(2);
  cache.set('a', 1);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get('a'), undefined);
});
