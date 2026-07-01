import { Router } from 'express';
import {
  getCitationForSummon, getTopCitedWorks, loadDocumentCitationsWithSharing,
  loadDocsByCitation
} from '../db.js';
import { parseNumberParam } from '../validate.js';
import { asyncHandler, getQueryValue } from '../middleware/http.js';

const SUMMON_CACHE_TTL_MS = 60 * 60 * 1000;
const SUMMON_RATE_WINDOW_MS = 60 * 1000;
const SUMMON_RATE_LIMIT = 20;
const SUMMON_RATE_MAX_IPS = 2000;
const SUMMON_CACHE_MAX_ENTRIES = 500;

const summonCache = new Map();
const summonInflight = new Map();
const summonAttemptsByIp = new Map();

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function getCachedSummonResult(key) {
  const entry = summonCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > SUMMON_CACHE_TTL_MS) {
    summonCache.delete(key);
    return null;
  }
  return entry.payload;
}

function setCachedSummonResult(key, payload) {
  summonCache.set(key, { timestamp: Date.now(), payload });
  while (summonCache.size > SUMMON_CACHE_MAX_ENTRIES) {
    const oldestKey = summonCache.keys().next().value;
    summonCache.delete(oldestKey);
  }
}

function allowSummonRequest(ip) {
  const now = Date.now();
  const attempts = summonAttemptsByIp.get(ip) || [];
  const recent = attempts.filter((ts) => now - ts <= SUMMON_RATE_WINDOW_MS);
  if (recent.length >= SUMMON_RATE_LIMIT) {
    summonAttemptsByIp.set(ip, recent);
    return false;
  }
  recent.push(now);
  summonAttemptsByIp.set(ip, recent);
  while (summonAttemptsByIp.size > SUMMON_RATE_MAX_IPS) {
    summonAttemptsByIp.delete(summonAttemptsByIp.keys().next().value);
  }
  return true;
}

async function fetchSummonResult(q) {
  const summonUrl = `https://ubc.summon.serialssolutions.com/api/search?pn=1&l=en&include.ft.matches=t&q=${encodeURIComponent(q)}`;
  const resp = await fetch(summonUrl, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`Summon ${resp.status}`);
  const data = await resp.json();
  const results = (data.documents || []).slice(0, 10).map((d) => ({
    title: String(d.title || '').replace(/<\/?mark>/g, ''),
    authors: (d.authors || []).map((a) => a.fullname || a.name || '').filter(Boolean).join(', '),
    contentType: d.content_type || '',
    year: d.publication_date || '',
    inHoldings: d.in_holdings === true,
    link: d.link || '',
    snippet: String(d.snippet || '').replace(/<\/?mark>/g, ''),
  }));
  const found = results.some((r) => r.inHoldings);
  const searchUrl = `https://ubc.summon.serialssolutions.com/#!/search?q=${encodeURIComponent(q)}`;
  return { found, results, searchUrl, illUrl: 'https://ill-docdel.library.ubc.ca/home' };
}

export function resetSummonLookupStateForTests() {
  summonCache.clear();
  summonInflight.clear();
  summonAttemptsByIp.clear();
}

export async function lookupSummonWithCache(q, {
  ip = 'unknown',
  fetchSummon = fetchSummonResult,
} = {}) {
  const cacheKey = q;
  const cached = getCachedSummonResult(cacheKey);
  if (cached) return { status: 200, payload: cached };

  if (!allowSummonRequest(ip)) {
    return {
      status: 429,
      payload: { error: 'Too many Summon lookup requests. Please try again later.' },
    };
  }

  try {
    if (!summonInflight.has(cacheKey)) {
      const lookup = fetchSummon(q)
        .then((payload) => {
          setCachedSummonResult(cacheKey, payload);
          return payload;
        })
        .finally(() => summonInflight.delete(cacheKey));
      summonInflight.set(cacheKey, lookup);
    }
    return { status: 200, payload: await summonInflight.get(cacheKey) };
  } catch {
    return { status: 502, payload: { error: 'Summon lookup failed' } };
  }
}

/**
 * Creates read-only browser endpoints for citation exploration.
 *
 * These routes do not require an admin session. They expose stored citation data
 * and rate-limit/cache bounded Summon holdings checks for selected citations.
 */
export function createPublicRouter() {
  const router = Router();

  router.get('/documents/:docId/citations', asyncHandler(async (req, res) => {
    const citations = await loadDocumentCitationsWithSharing(req.params.docId);
    res.status(200).json({ citations });
  }));

  router.get('/citations/top', asyncHandler(async (req, res) => {
    const limit = parseNumberParam(getQueryValue(req, 'limit'), 50);
    const works = await getTopCitedWorks(Math.min(limit, 200));
    res.status(200).json({ works });
  }));

  router.get('/citations/:citationId/documents', asyncHandler(async (req, res) => {
    const citationId = Number(req.params.citationId);
    if (!Number.isFinite(citationId) || citationId <= 0) {
      res.status(400).json({ error: 'Invalid citation ID' });
      return;
    }
    const documents = await loadDocsByCitation(citationId);
    res.status(200).json({ documents });
  }));

  router.get('/citations/:citationId/summon-check', asyncHandler(async (req, res) => {
    const citationId = Number(req.params.citationId);
    if (!Number.isFinite(citationId) || citationId <= 0) {
      res.status(400).json({ error: 'Invalid citation ID' });
      return;
    }
    const row = await getCitationForSummon(citationId);
    if (!row) {
      res.status(404).json({ error: 'Citation not found' });
      return;
    }

    // Prefer structured lookup terms from the catalogue parser; fall back to a
    // short raw citation query so malformed citations cannot produce huge URLs.
    const q = row.query_title
      ? `Title:(${row.query_title})${row.query_author ? ` AND Author:(${row.query_author})` : ''}`
      : String(row.citation_text || '').slice(0, 200);
    if (!q) {
      res.status(422).json({ error: 'Insufficient citation data' });
      return;
    }

    const result = await lookupSummonWithCache(q, { ip: clientIp(req) });
    res.status(result.status).json(result.payload);
  }));

  return router;
}
