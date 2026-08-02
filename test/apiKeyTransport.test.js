import test from 'node:test';
import assert from 'node:assert/strict';

// The live OC API only recognizes the key as an api_key query parameter —
// header-only transport is silently rate-limited as anonymous (verified
// against the live API 2026-07-15: keyed header burst 429'd at 10/min,
// query-param burst did not). The key must ride in BOTH the URL and the
// headers; local logging masks the query param.
test('search and collection requests carry the API key as a query param and headers', async (t) => {
  const { fetchPage, fetchSearchAggregations, resolveIndexName } = await import('../src/api.js');
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), headers: options.headers || {} });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { hits: { hits: [] } }, collections: [] }),
      text: async () => '',
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const apiKey = 'secret-key-123';
  await fetchPage({ baseUrl: 'https://example.test', index: 'idx', apiKey, from: 0, pageSize: 1 });
  await fetchSearchAggregations({ baseUrl: 'https://example.test', index: 'idx', apiKey, aggregations: {} });
  await resolveIndexName('https://example.test', '', apiKey);

  assert.equal(requests.length, 3);
  for (const req of requests) {
    assert.match(req.url, /[?&]api_key=secret-key-123/, `expected api_key query param in ${req.url}`);
    assert.equal(req.headers['x-api-key'], apiKey);
  }
});
