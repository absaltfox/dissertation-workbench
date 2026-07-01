import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupSummonWithCache,
  resetSummonLookupStateForTests,
} from '../src/routes/publicRoutes.js';

test.afterEach(() => {
  resetSummonLookupStateForTests();
});

test('Summon lookups reuse cached results for repeated queries', async () => {
  let calls = 0;
  const payload = {
    found: true,
    results: [{ title: 'Held Fixture', inHoldings: true }],
    searchUrl: 'https://example.test/search',
    illUrl: 'https://example.test/ill',
  };
  const fetchSummon = async () => {
    calls += 1;
    return payload;
  };

  const first = await lookupSummonWithCache('Title:(Held Fixture)', {
    ip: '192.0.2.10',
    fetchSummon,
  });
  const second = await lookupSummonWithCache('Title:(Held Fixture)', {
    ip: '192.0.2.10',
    fetchSummon,
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.payload, first.payload);
  assert.equal(calls, 1);
});

test('Summon lookups rate-limit repeated uncached requests by IP', async () => {
  let calls = 0;
  const fetchSummon = async (q) => {
    calls += 1;
    return { found: false, results: [], searchUrl: `https://example.test/${encodeURIComponent(q)}`, illUrl: '' };
  };

  for (let i = 0; i < 20; i += 1) {
    const result = await lookupSummonWithCache(`Title:(Fixture ${i})`, {
      ip: '192.0.2.20',
      fetchSummon,
    });
    assert.equal(result.status, 200);
  }

  const blocked = await lookupSummonWithCache('Title:(Fixture 21)', {
    ip: '192.0.2.20',
    fetchSummon,
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.payload.error, 'Too many Summon lookup requests. Please try again later.');
  assert.equal(calls, 20);
});
