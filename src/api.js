import { logger } from './logger.js';
import { toArray } from './nlp.js';

const resolvedIndexCache = new Map();

// --- Upstream UBC API rate limiter (serialized queue) ---
const apiCallTimestamps = [];
const ANON_RATE_LIMIT = 10;
const KEYED_RATE_LIMIT = 1000;
const RATE_WINDOW_MS = 60_000;
let apiQueueTail = Promise.resolve();

function acquireApiSlot(hasApiKey) {
  let release;
  const prev = apiQueueTail;
  apiQueueTail = new Promise((resolve) => { release = resolve; });

  return prev.then(async () => {
    const limit = hasApiKey ? KEYED_RATE_LIMIT : ANON_RATE_LIMIT;
    const now = Date.now();
    const cutoff = now - RATE_WINDOW_MS;
    while (apiCallTimestamps.length && apiCallTimestamps[0] < cutoff) {
      apiCallTimestamps.shift();
    }
    if (apiCallTimestamps.length >= limit) {
      const waitMs = (apiCallTimestamps[0] + RATE_WINDOW_MS) - Date.now();
      if (waitMs > 0) {
        logger.info(`Rate limit: waiting ${waitMs}ms before UBC API call`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    apiCallTimestamps.push(Date.now());
    return release;
  });
}

function extractUrlStrings(value) {
  const urls = [];
  for (const part of toArray(value)) {
    const txt = String(part).trim();
    if (/^https?:\/\//i.test(txt)) {
      urls.push(txt);
      continue;
    }
    const matches = txt.match(/https?:\/\/[^\s"'<>]+/gi);
    if (matches) urls.push(...matches);
  }
  return urls;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function collectCandidateUrls(doc, id, doi) {
  const candidates = [];

  // Build a collection-specific direct PDF URL using the Elasticsearch index name
  // (e.g. "dsp.831-2022-11-13" → collection 831, URL: /media/download/pdf/831/{id}/1)
  const indexMatch = String(doc?.__oc_index || '').match(/dsp\.(\d+)/);
  if (indexMatch && id) {
    const collNum = indexMatch[1];
    candidates.push(`https://open.library.ubc.ca/media/download/pdf/${collNum}/${id}/1`);
    candidates.push(`https://open.library.ubc.ca/media/download/pdf/${collNum}/${id}/2`);
    candidates.push(`https://open.library.ubc.ca/media/download/pdf/${collNum}/${id}/3`);
  }

  if (doi) {
    const suffix = doi.split('/').pop();
    if (suffix) {
      candidates.push(`https://open.library.ubc.ca/media/download/pdf/24/${suffix}`);
    }
  }

  for (const key of [
    'URI', 'uri', 'isShownAt', 'IsShownAt', 'hasView', 'HasView',
    'identifier', 'Identifier', 'digitalResourceOriginalRecord', 'doi', 'DOI'
  ]) {
    candidates.push(...extractUrlStrings(doc?.[key]));
  }

  if (id) {
    candidates.push(`https://open.library.ubc.ca/collections/ubctheses/items/${encodeURIComponent(id)}`);
  }

  return unique(candidates);
}

export async function fetchPage({ baseUrl, index, apiKey, from, pageSize, query, term, source }) {
  const headers = { accept: 'application/json' };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
    headers.authorization = `Bearer ${apiKey}`;
  }

  const apiRoot = new URL('/search/8.5', baseUrl).toString();
  const params = [
    `size=${encodeURIComponent(String(pageSize))}`,
    `from=${encodeURIComponent(String(from))}`
  ];
  if (index) params.unshift(`index=${encodeURIComponent(index)}`);

  if (query) params.push(`q=${encodeURIComponent(query)}`);
  if (term) {
    const encodedTerm = encodeURIComponent(term)
      .replace(/%2C/gi, ',')
      .replace(/%3B/gi, ';')
      .replace(/%20/gi, '+');
    params.push(`term=${encodedTerm}`);
  }

  if (source) {
    const encodedSource = encodeURIComponent(source)
      .replace(/%2C/gi, ',')
      .replace(/%20/gi, '+');
    params.push(`source=${encodedSource}`);
  }

  if (apiKey) params.push(`api_key=${encodeURIComponent(apiKey)}`);

  const searchUrl = `${apiRoot}?${params.join('&')}`;
  logger.info('API fetch', { url: searchUrl.replace(/api_key=[^&]+/, 'api_key=***') });

  const release = await acquireApiSlot(Boolean(apiKey));
  let response;
  try {
    response = await fetch(searchUrl, { headers });
  } finally {
    release();
  }

  if (!response.ok) {
    const body = (await response.text()).trim();
    let parsed;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      parsed = null;
    }
    const detail = parsed?.data?.error || parsed?.api_text || body || response.statusText || 'No body';
    const retryHint = response.status === 429
      ? ' Rate limited by UBC API (10 requests/minute per IP). Wait 60 seconds or use UBC_API_KEY.'
      : '';
    throw new Error(`search endpoint (${response.status}): ${String(detail).slice(0, 240)}${retryHint}`);
  }

  return response.json();
}

export function extractHits(payload) {
  const arrays = [
    payload?.data?.hits?.hits,
    payload?.data?.results,
    payload?.data?.items,
    payload?.data?.docs,
    payload?.hits?.hits,
    payload?.results,
    payload?.items,
    payload?.docs,
    payload?.data,
    Array.isArray(payload) ? payload : null
  ];

  const list = arrays.find((arr) => Array.isArray(arr)) || [];
  return list.map((hit) => {
    const source = hit?._source || hit?.doc || hit;
    // Inject the Elasticsearch index name so collectCandidateUrls can derive the collection number
    if (source && typeof source === 'object' && hit?._index && !source.__oc_index) {
      source.__oc_index = hit._index;
    }
    return source;
  }).filter(Boolean);
}

export async function resolveIndexName(baseUrl, requestedIndex, apiKey) {
  if (/^\d+$/.test(String(requestedIndex || '').trim())) return String(requestedIndex).trim();

  const cacheKey = `${baseUrl}|${requestedIndex}|${apiKey ? 'keyed' : 'anon'}`;
  if (resolvedIndexCache.has(cacheKey)) return resolvedIndexCache.get(cacheKey);

  const headers = { accept: 'application/json' };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
    headers.authorization = `Bearer ${apiKey}`;
  }

  const url = new URL('/collections', baseUrl);
  if (apiKey) url.searchParams.set('api_key', apiKey);

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return requestedIndex;
    const payload = await res.json();
    const list = payload?.data || payload?.collections || payload?.results || payload;
    if (!Array.isArray(list)) return requestedIndex;

    const target = list.find((entry) => {
      const id = String(entry?.id ?? entry?.name ?? entry?.collection ?? '').trim();
      return id.toLowerCase() === String(requestedIndex).toLowerCase();
    });

    const resolved = target ? String(target.id ?? target.name ?? requestedIndex) : requestedIndex;
    resolvedIndexCache.set(cacheKey, resolved);
    return resolved;
  } catch {
    return requestedIndex;
  }
}
