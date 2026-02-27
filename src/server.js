import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMetrics } from './metrics.js';
import {
  PORT, CACHE_TTL_MS, LOGIN_WINDOW_MS, LOGIN_BLOCK_MS, LOGIN_MAX_ATTEMPTS_IP,
  LOGIN_MAX_ATTEMPTS_USER, LOGIN_FAILURE_DELAY_MS, PUBLIC_MAX_RECORDS, PUBLIC_SCAN_LIMIT,
  ALLOW_PUBLIC_DOWNLOADS, ALLOW_PUBLIC_REFRESH, ALLOW_PUBLIC_RECOMPUTE, EXPOSE_ERROR_DETAILS,
  DEFAULT_TERM, DEFAULT_SOURCE
} from './config.js';
import { ensureStorage, getDb, listUsers, listFileMetrics, getFileMetricsStats, deleteFileMetric, listRecentRuns, getAllSettings, getSetting, setSetting, loadDocumentMetadata } from './db.js';
import { authenticate, requireAdmin, login, destroySession, setSessionCookie, clearSessionCookie, ensureDefaultAdmin, createPasswordHash } from './auth.js';
import { createUser, deleteUser, countUsers, findUserByUsername, checkCacheIntegrity, logCacheStats, loadDocumentCitationsWithSharing, loadDocsByCitation, clearAllCitations, saveCatalogueLookup, getCatalogueLookupStats, listPendingLookups, getTopCitedWorks, getCitationForSummon } from './db.js';
import { validateMetricsParams, validateAdminUser, parseNumberParam, parseBooleanParam } from './validate.js';
import { deleteCachedPdf, analyzeDocumentFile, analyzePdfAtPath, extractAndSaveParsedData } from './pdf.js';
import { getConceptPipelineStatus, rebuildConceptDictionary, scheduleDailyConceptRebuild } from './conceptsPipeline.js';
import { lookupCitation, lookupCitationBatch, extractSearchTerms, checkYazAvailability, runPendingCatalogueLookups } from './catalogue.js';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const metricsCache = new Map();
const failedLoginsByIp = new Map();
const failedLoginsByUser = new Map();
let stopDailyConceptScheduler = null;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};

const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'geolocation=(), camera=(), microphone=()',
  'content-security-policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "connect-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:"
  ].join('; ')
};

// --- Helpers ---

function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(securityHeaders)) {
    res.setHeader(name, value);
  }
}

function sendJson(res, status, data) {
  applySecurityHeaders(res);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function serveStatic(reqPath, res) {
  const safePath = reqPath === '/' ? '/index.html' : reqPath;
  const normalized = path.normalize(safePath).replace(/^\.\.(\/|\\|$)/, '');
  const filePath = path.join(publicDir, normalized);

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    applySecurityHeaders(res);
    res.writeHead(200, { 'content-type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

function readBody(req, maxBytes = 1024 * 64) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

function getPublicAdminSettings() {
  const settings = getAllSettings();
  const apiKey = getSetting('apiKey') || process.env.UBC_API_KEY;
  delete settings.apiKey;
  return {
    ...settings,
    apiKeyConfigured: Boolean(apiKey)
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pruneAttempts(entry, now) {
  entry.attempts = entry.attempts.filter((ts) => now - ts <= LOGIN_WINDOW_MS);
}

function getOrInitLimiter(map, key) {
  const existing = map.get(key);
  if (existing) return existing;
  const created = { attempts: [], blockedUntil: 0 };
  map.set(key, created);
  return created;
}

function isBlocked(map, key, now) {
  const entry = map.get(key);
  if (!entry) return false;
  if (entry.blockedUntil <= now) return false;
  return true;
}

function recordFailedLogin(map, key, limit, now) {
  const entry = getOrInitLimiter(map, key);
  pruneAttempts(entry, now);
  entry.attempts.push(now);
  if (entry.attempts.length >= limit) {
    entry.blockedUntil = now + LOGIN_BLOCK_MS;
    entry.attempts = [];
  }
}

function clearFailedLogins(map, key) {
  map.delete(key);
}

function cleanupLimiterMap(map, now) {
  for (const [key, entry] of map.entries()) {
    pruneAttempts(entry, now);
    if (!entry.attempts.length && entry.blockedUntil <= now) {
      map.delete(key);
    }
  }
}

setInterval(() => {
  const now = Date.now();
  cleanupLimiterMap(failedLoginsByIp, now);
  cleanupLimiterMap(failedLoginsByUser, now);
}, Math.max(60_000, Math.floor(LOGIN_WINDOW_MS / 2)));

// --- Server ---

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const method = req.method;
  const ip = getClientIp(req);

  logger.info(`${method} ${url.pathname}`, { ip });

  try {
    // --- Health ---
    if (url.pathname === '/api/health' && method === 'GET') {
      sendJson(res, 200, { ok: true, timestamp: new Date().toISOString() });
      return;
    }

    // --- Auth routes ---
    if (url.pathname === '/api/auth/login' && method === 'POST') {
      const body = await readBody(req);
      const { username, password } = body;
      const userKey = String(username || '').trim().toLowerCase();
      const now = Date.now();
      const blockedByIp = isBlocked(failedLoginsByIp, ip, now);
      const blockedByUser = userKey ? isBlocked(failedLoginsByUser, userKey, now) : false;
      if (blockedByIp || blockedByUser) {
        await sleep(LOGIN_FAILURE_DELAY_MS);
        sendJson(res, 429, { error: 'Too many login attempts. Please try again later.' });
        return;
      }
      if (!username || !password) {
        recordFailedLogin(failedLoginsByIp, ip, LOGIN_MAX_ATTEMPTS_IP, now);
        if (userKey) recordFailedLogin(failedLoginsByUser, userKey, LOGIN_MAX_ATTEMPTS_USER, now);
        await sleep(LOGIN_FAILURE_DELAY_MS);
        sendJson(res, 400, { error: 'Username and password required' });
        return;
      }
      const token = login(username, password);
      if (!token) {
        recordFailedLogin(failedLoginsByIp, ip, LOGIN_MAX_ATTEMPTS_IP, now);
        if (userKey) recordFailedLogin(failedLoginsByUser, userKey, LOGIN_MAX_ATTEMPTS_USER, now);
        await sleep(LOGIN_FAILURE_DELAY_MS);
        sendJson(res, 401, { error: 'Invalid credentials' });
        return;
      }
      clearFailedLogins(failedLoginsByIp, ip);
      if (userKey) clearFailedLogins(failedLoginsByUser, userKey);
      setSessionCookie(res, token, req);
      sendJson(res, 200, { ok: true, username });
      return;
    }

    if (url.pathname === '/api/auth/logout' && method === 'POST') {
      const user = authenticate(req);
      if (user) destroySession(user.token);
      clearSessionCookie(res, req);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/auth/session' && method === 'GET') {
      const user = authenticate(req);
      if (!user) {
        sendJson(res, 401, { error: 'Not authenticated' });
        return;
      }
      sendJson(res, 200, { ok: true, username: user.username });
      return;
    }

    // --- Admin routes ---
    if (url.pathname === '/api/admin/users' && method === 'GET') {
      if (!requireAdmin(req, res)) return;
      sendJson(res, 200, { users: listUsers() });
      return;
    }

    if (url.pathname === '/api/admin/users' && method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      const validation = validateAdminUser(body.username, body.password);
      if (!validation.valid) {
        sendJson(res, 400, { error: 'Validation failed', errors: validation.errors });
        return;
      }
      if (findUserByUsername(body.username)) {
        sendJson(res, 409, { error: 'Username already exists' });
        return;
      }
      const { hash, salt } = createPasswordHash(body.password);
      createUser(body.username, hash, salt);
      sendJson(res, 201, { ok: true, username: body.username });
      return;
    }

    if (url.pathname.startsWith('/api/admin/users/') && method === 'DELETE') {
      if (!requireAdmin(req, res)) return;
      const username = decodeURIComponent(url.pathname.split('/api/admin/users/')[1]);
      if (countUsers() <= 1) {
        sendJson(res, 400, { error: 'Cannot delete the last admin user' });
        return;
      }
      if (!deleteUser(username)) {
        sendJson(res, 404, { error: 'User not found' });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/admin/settings' && method === 'GET') {
      if (!requireAdmin(req, res)) return;
      sendJson(res, 200, { settings: getPublicAdminSettings() });
      return;
    }

    if (url.pathname === '/api/admin/concepts/status' && method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const status = await getConceptPipelineStatus();
      sendJson(res, 200, { status });
      return;
    }

    if (url.pathname === '/api/admin/concepts/rebuild' && method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const result = await rebuildConceptDictionary({ trigger: 'manual' });
      if (!result.ok) {
        sendJson(res, 409, { ok: false, error: result.error || 'Rebuild failed' });
        return;
      }
      sendJson(res, 200, { ok: true, stats: result.artifact?.stats || null });
      return;
    }

    if (url.pathname === '/api/admin/catalogue-lookup/stats' && method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const stats = getCatalogueLookupStats();
      sendJson(res, 200, { stats });
      return;
    }

    if (url.pathname === '/api/admin/catalogue-lookup' && method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const limit = parseNumberParam(url.searchParams.get('limit'), 100);
      const dryRun = parseBooleanParam(url.searchParams.get('dryRun'), false);

      if (dryRun) {
        const pending = listPendingLookups(limit);
        if (!pending.length) {
          sendJson(res, 200, { ok: true, dryRun: true, total: 0, previews: [] });
          return;
        }
        const previews = pending.map((row) => ({
          citationId: row.id,
          citationText: row.citation_text,
          ...extractSearchTerms(row.citation_text),
        }));
        sendJson(res, 200, { ok: true, dryRun: true, total: previews.length, previews });
        return;
      }

      const stats = await runPendingCatalogueLookups({ pageSize: limit });
      sendJson(res, 200, { ok: true, ...stats });
      return;
    }

    if (url.pathname === '/api/admin/settings' && method === 'PUT') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      for (const [key, value] of Object.entries(body)) {
        if (key === 'apiKey') continue;
        setSetting(key, String(value));
      }
      if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) {
        const nextApiKey = String(body.apiKey || '').trim();
        if (nextApiKey) {
          setSetting('apiKey', nextApiKey);
        }
      }
      sendJson(res, 200, { ok: true, settings: getPublicAdminSettings() });
      return;
    }

    if (url.pathname === '/api/admin/cache' && method === 'GET') {
      if (!requireAdmin(req, res)) return;
      sendJson(res, 200, { entries: listFileMetrics() });
      return;
    }

    if (url.pathname === '/api/admin/cache/stats' && method === 'GET') {
      if (!requireAdmin(req, res)) return;
      sendJson(res, 200, { stats: getFileMetricsStats() });
      return;
    }

    if (url.pathname === '/api/admin/cache/refresh' && method === 'POST') {
      if (!requireAdmin(req, res)) return;
      // Clear in-memory cache so next /api/metrics call re-fetches
      metricsCache.clear();
      sendJson(res, 200, { ok: true, message: 'In-memory cache cleared. Next query will re-fetch.' });
      return;
    }

    if (url.pathname.startsWith('/api/admin/cache/') && url.pathname.endsWith('/refresh') && method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const docId = decodeURIComponent(url.pathname.slice('/api/admin/cache/'.length, -'/refresh'.length));
      const doc = loadDocumentMetadata(docId);
      if (!doc) {
        sendJson(res, 404, { error: 'Document not found in metadata store' });
        return;
      }
      await deleteCachedPdf(docId);
      await analyzeDocumentFile(doc, { downloadFiles: true, forceDownload: true, recomputeFromCache: false });
      metricsCache.clear();
      sendJson(res, 200, {
        ok: true, docId,
        status: doc.downloadStatus,
        pages: doc.pages,
        pagesSource: doc.pagesSource,
        wordCount: doc.wordCount,
        wordCountSource: doc.wordCountSource,
        fileBytes: doc.fileBytes,
        downloadUrl: doc.downloadUrl,
        downloadError: doc.downloadError
      });
      return;
    }

    if (url.pathname.startsWith('/api/admin/cache/') && method === 'DELETE') {
      if (!requireAdmin(req, res)) return;
      const docId = decodeURIComponent(url.pathname.split('/api/admin/cache/')[1]);
      await deleteCachedPdf(docId);
      deleteFileMetric(docId);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/admin/reparse-all' && method === 'POST') {
      if (!requireAdmin(req, res)) return;
      clearAllCitations();
      const entries = listFileMetrics().filter((e) => e.pdf_path);
      let processed = 0;
      let withCommittee = 0;
      let totalCitations = 0;

      for (const entry of entries) {
        try {
          const analysis = await analyzePdfAtPath(entry.pdf_path);
          if (!analysis.fullText) continue;
          processed++;

          const doc = loadDocumentMetadata(entry.doc_id) || { id: entry.doc_id, supervisors: [] };
          extractAndSaveParsedData(doc, analysis.fullText);
          if (doc.committee?.length) withCommittee++;
          if (doc.citationCount) totalCitations += Number(doc.citationCount);
        } catch (err) {
          logger.warn('Reparse failed for doc', { docId: entry.doc_id, error: err.message });
        }
      }

      // Automatically look up any new citations in the UBC Library catalogue
      const lookupStats = await runPendingCatalogueLookups();

      metricsCache.clear();
      sendJson(res, 200, { ok: true, processed, committees: withCommittee, citations: totalCitations, catalogueLookups: lookupStats });
      return;
    }

    if (url.pathname === '/api/admin/runs' && method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const runs = listRecentRuns(50);
      sendJson(res, 200, { runs });
      return;
    }

    // --- Document citations (public) ---
    if (url.pathname.startsWith('/api/documents/') && url.pathname.endsWith('/citations') && method === 'GET') {
      const docId = decodeURIComponent(url.pathname.slice('/api/documents/'.length, -'/citations'.length));
      const citations = loadDocumentCitationsWithSharing(docId);
      sendJson(res, 200, { citations });
      return;
    }

    // --- Top cited works (public) ---
    if (url.pathname === '/api/citations/top' && method === 'GET') {
      const limit = parseNumberParam(url.searchParams.get('limit'), 50);
      const works = getTopCitedWorks(Math.min(limit, 200));
      sendJson(res, 200, { works });
      return;
    }

    // --- Citation → documents lookup (public) ---
    if (url.pathname.startsWith('/api/citations/') && url.pathname.endsWith('/documents') && method === 'GET') {
      const citationId = Number(url.pathname.slice('/api/citations/'.length, -'/documents'.length));
      if (!Number.isFinite(citationId) || citationId <= 0) {
        sendJson(res, 400, { error: 'Invalid citation ID' });
        return;
      }
      const documents = loadDocsByCitation(citationId);
      sendJson(res, 200, { documents });
      return;
    }

    // --- Summon availability check ---
    if (url.pathname.startsWith('/api/citations/') && url.pathname.endsWith('/summon-check') && method === 'GET') {
      const citationId = Number(url.pathname.slice('/api/citations/'.length, -'/summon-check'.length));
      if (!Number.isFinite(citationId) || citationId <= 0) {
        sendJson(res, 400, { error: 'Invalid citation ID' });
        return;
      }
      const row = getCitationForSummon(citationId);
      if (!row) { sendJson(res, 404, { error: 'Citation not found' }); return; }

      let q = row.query_title
        ? `Title:(${row.query_title})${row.query_author ? ` AND Author:(${row.query_author})` : ''}`
        : String(row.citation_text || '').slice(0, 200);
      if (!q) { sendJson(res, 422, { error: 'Insufficient citation data' }); return; }

      try {
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
        sendJson(res, 200, { found, results, searchUrl, illUrl: 'https://ill-docdel.library.ubc.ca/home' });
      } catch {
        sendJson(res, 502, { error: 'Summon lookup failed' });
      }
      return;
    }

    // --- Public metrics ---
    if (url.pathname === '/api/metrics' && method === 'GET') {
      const rawParams = {
        maxRecords: url.searchParams.get('maxRecords'),
        pageSize: url.searchParams.get('pageSize'),
        scanLimit: url.searchParams.get('scanLimit'),
        subjectLimit: url.searchParams.get('subjectLimit'),
        index: url.searchParams.get('index'),
        query: url.searchParams.get('query'),
        term: url.searchParams.get('term'),
        source: url.searchParams.get('source'),
      };

      const validation = validateMetricsParams(rawParams);
      if (!validation.valid) {
        sendJson(res, 400, { error: 'Validation failed', errors: validation.errors });
        return;
      }

      const maxRecords = parseNumberParam(rawParams.maxRecords, 200);
      const pageSize = parseNumberParam(rawParams.pageSize, 20);
      const scanLimit = parseNumberParam(rawParams.scanLimit, Math.max(maxRecords * 10, 1000));
      const subjectLimit = parseNumberParam(rawParams.subjectLimit, 25);
      const index = rawParams.index !== null ? rawParams.index : undefined;
      const query = url.searchParams.get('query') || undefined;
      const term = url.searchParams.get('term') || undefined;
      const source = url.searchParams.get('source') || undefined;
      const configuredApiKey = getSetting('apiKey') || process.env.UBC_API_KEY;
      const apiKey = configuredApiKey || undefined;
      const downloadFiles = parseBooleanParam(url.searchParams.get('downloadFiles'), true);
      const recomputeFromCache = parseBooleanParam(url.searchParams.get('recomputeFromCache'), false);
      const refresh = url.searchParams.get('refresh') === '1';
      const user = authenticate(req);
      const isAdminRequest = Boolean(user);
      if (!isAdminRequest && downloadFiles && !ALLOW_PUBLIC_DOWNLOADS) {
        sendJson(res, 403, { error: 'downloadFiles is restricted to authenticated admin sessions.' });
        return;
      }
      if (!isAdminRequest && refresh && !ALLOW_PUBLIC_REFRESH) {
        sendJson(res, 403, { error: 'refresh is restricted to authenticated admin sessions.' });
        return;
      }
      if (!isAdminRequest && recomputeFromCache && !ALLOW_PUBLIC_RECOMPUTE) {
        sendJson(res, 403, { error: 'recomputeFromCache is restricted to authenticated admin sessions.' });
        return;
      }
      const effectiveMaxRecords = isAdminRequest ? maxRecords : Math.min(maxRecords, PUBLIC_MAX_RECORDS);
      const effectiveScanLimit = isAdminRequest ? scanLimit : Math.min(scanLimit, PUBLIC_SCAN_LIMIT);

      const cacheKey = JSON.stringify({
        maxRecords: effectiveMaxRecords, pageSize, scanLimit: effectiveScanLimit, subjectLimit,
        index, query, term, source,
        hasApiKey: Boolean(apiKey),
        downloadFiles, recomputeFromCache, refresh, isAdminRequest
      });

      if (!refresh && !recomputeFromCache) {
        const cached = metricsCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
          sendJson(res, 200, cached.payload);
          return;
        }
      }

      const payload = await collectMetrics({
        maxRecords: effectiveMaxRecords, pageSize, scanLimit: effectiveScanLimit, subjectLimit,
        index, query, term, source, apiKey,
        downloadFiles,
        forceDownload: refresh,
        recomputeFromCache
      });
      metricsCache.set(cacheKey, { timestamp: Date.now(), payload });
      sendJson(res, 200, payload);
      return;
    }

    // --- Static files ---
    await serveStatic(url.pathname, res);

  } catch (error) {
    logger.error('Request error', { path: url.pathname, error: error.message });
    sendJson(res, 500, {
      error: 'Internal server error',
      message: EXPOSE_ERROR_DETAILS && error instanceof Error ? error.message : 'Unexpected error'
    });
  }
});

// --- Startup ---

async function start() {
  await ensureStorage();
  getDb();
  ensureDefaultAdmin();

  try {
    await logCacheStats();
    await checkCacheIntegrity();
  } catch (e) {
    logger.warn('Cache check on startup failed', { error: e.message });
  }

  server.listen(PORT, () => {
    logger.info(`UBC Dissertation Intelligence Workbench running at http://localhost:${PORT}`);
  });

  // Warm the in-memory metrics cache so the first browser load is served instantly.
  // Key is constructed to match exactly what the request handler produces for a default
  // non-admin request (no query params): index/query/term/source all undefined → omitted by JSON.stringify.
  const _warmupApiKey = getSetting('apiKey') || process.env.UBC_API_KEY;
  // The browser always sends maxRecords=9999 (UI default), which the server caps to
  // PUBLIC_MAX_RECORDS. The scan limit is derived from the uncapped value, then capped
  // to PUBLIC_SCAN_LIMIT. We replicate that math here so the warmup key matches the
  // first browser request exactly and the cache is used without a cold re-fetch.
  // Other values must mirror the HTML input defaults in public/index.html:
  //   subjectLimit=20, downloadFiles=0, index='', term=DEFAULT_TERM, source=DEFAULT_SOURCE.
  const _warmupMaxRecords = PUBLIC_MAX_RECORDS;
  const _warmupScanLimit = PUBLIC_SCAN_LIMIT;
  const _warmupSubjectLimit = 20; // mirrors s-subjectLimit input default
  collectMetrics({
    maxRecords: _warmupMaxRecords,
    pageSize: 20,
    scanLimit: _warmupScanLimit,
    subjectLimit: _warmupSubjectLimit,
    apiKey: _warmupApiKey || undefined,
    term: DEFAULT_TERM,
    source: DEFAULT_SOURCE,
    downloadFiles: false,
    forceDownload: false,
    recomputeFromCache: false,
  }).then((payload) => {
    // Key must match what a default anonymous browser request produces so the
    // first page load is served from cache without a round-trip to the UBC API.
    const warmupKey = JSON.stringify({
      maxRecords: _warmupMaxRecords, pageSize: 20, scanLimit: _warmupScanLimit,
      subjectLimit: _warmupSubjectLimit,
      index: '',             // browser sends index='' (empty input) which is not || undefined'd
      term: DEFAULT_TERM,    // browser sends this from s-term input
      source: DEFAULT_SOURCE, // browser sends this from s-source input
      hasApiKey: Boolean(_warmupApiKey),
      downloadFiles: false, recomputeFromCache: false, refresh: false, isAdminRequest: false,
    });
    metricsCache.set(warmupKey, { timestamp: Date.now(), payload });
    logger.info('Metrics cache warmed on startup');
    // Run catalogue lookups in the background after the cache is ready so
    // they never block the first page load.
    runPendingCatalogueLookups().catch((e) => {
      logger.warn('Background catalogue lookups failed', { error: e.message });
    });
  }).catch((e) => {
    logger.warn('Startup metrics cache warmup failed', { error: e.message });
  });

  stopDailyConceptScheduler = scheduleDailyConceptRebuild();
  logger.info('Scheduled daily concept rebuild job', { hourLocal: 2 });
  const conceptStatus = await getConceptPipelineStatus();
  if (!conceptStatus?.lastSuccessAt) {
    rebuildConceptDictionary({ trigger: 'startup' }).catch((error) => {
      logger.error('Startup concept rebuild failed', { error: error?.message || String(error) });
    });
  }
}

start();
