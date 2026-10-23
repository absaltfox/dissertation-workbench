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

// --- #17 (H-02) Track 2: fetchPage's sort/search_after cursoring ---
//
// Unverified against the real endpoint (oc-index.library.ubc.ca is
// unreachable from this sandbox) — these tests only prove fetchPage builds
// the request correctly and that extractHits round-trips a sort cursor when
// the (mocked) response carries one. Whether the real endpoint honors either
// parameter still needs live confirmation; see docs/phase-b-completion-plan.md §1.

test('fetchPage sends from-based paging unchanged when no sort/searchAfter is given (regression safety)', async (t) => {
  const { fetchPage } = await import('../src/api.js');
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, status: 200, json: async () => ({ data: { hits: { hits: [] } } }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await fetchPage({ baseUrl: 'https://example.test', from: 40, pageSize: 20 });
  assert.match(requests[0], /[?&]from=40\b/);
  assert.doesNotMatch(requests[0], /[?&]sort=/);
  assert.doesNotMatch(requests[0], /[?&]search_after=/);
});

test('fetchPage adds a sort parameter when asked, and known gap: absence of sort is the current default', async (t) => {
  const { fetchPage } = await import('../src/api.js');
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, status: 200, json: async () => ({ data: { hits: { hits: [] } } }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await fetchPage({ baseUrl: 'https://example.test', from: 0, pageSize: 20, sort: 'id:asc' });
  assert.match(requests[0], /[?&]sort=id%3Aasc\b/);
  assert.match(requests[0], /[?&]from=0\b/, 'sort alone (no searchAfter) still uses from-based paging');
});

test('fetchPage uses search_after instead of from once a cursor is supplied', async (t) => {
  const { fetchPage } = await import('../src/api.js');
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, status: 200, json: async () => ({ data: { hits: { hits: [] } } }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await fetchPage({ baseUrl: 'https://example.test', from: 999, pageSize: 20, sort: 'id:asc', searchAfter: ['1.0451810'] });
  assert.match(requests[0], /[?&]search_after=/, 'expected a search_after param once a cursor is provided');
  assert.doesNotMatch(requests[0], /[?&]from=/, 'from must not be sent alongside search_after');
});

test('extractHits propagates a hit\'s sort cursor as __oc_sort when the response carries one', async () => {
  const { extractHits } = await import('../src/api.js');
  const withSort = extractHits({
    data: { hits: { hits: [{ _index: 'dsp.1', sort: ['1.0451810'], _source: { id: '1.0451810' } }] } },
  });
  assert.deepEqual(withSort[0].__oc_sort, ['1.0451810']);

  // Known gap this run must degrade gracefully on: a response with no `sort`
  // key at all (the vendor endpoint may not echo one back, or may not honor
  // the request) leaves __oc_sort unset, which is the exact signal sync.js's
  // capability probe uses to fall back to plain from-based paging.
  const withoutSort = extractHits({
    data: { hits: { hits: [{ _index: 'dsp.1', _source: { id: '1.0451810' } }] } },
  });
  assert.equal(withoutSort[0].__oc_sort, undefined);
});
