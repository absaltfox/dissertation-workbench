import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMetrics } from './metrics.js';
import {
  PORT, CACHE_TTL_MS, LOGIN_WINDOW_MS, LOGIN_BLOCK_MS, LOGIN_MAX_ATTEMPTS_IP,
  LOGIN_MAX_ATTEMPTS_USER, LOGIN_FAILURE_DELAY_MS, PUBLIC_MAX_RECORDS, PUBLIC_SCAN_LIMIT,
  ALLOW_PUBLIC_DOWNLOADS, ALLOW_PUBLIC_REFRESH, ALLOW_PUBLIC_RECOMPUTE, EXPOSE_ERROR_DETAILS,
  DEFAULT_TERM, DEFAULT_SOURCE, TRUST_PROXY
} from './config.js';
import {
  ensureStorage, getDb, listUsers, listFileMetrics, getFileMetricsStats, deleteFileMetric,
  listRecentRuns, getAllSettings, setSetting, loadDocumentMetadata,
  createUser, deleteUser, countUsers, findUserByUsername, checkCacheIntegrity, logCacheStats,
  loadDocumentCitationsWithSharing, loadDocsByCitation, clearAllCitations, getCatalogueLookupStats,
  listPendingLookups, getTopCitedWorks, getCitationForSummon, loadCommitteeMembers,
  updateUserPassword, clearUserMfa, listCachedDocuments, getDocumentCacheStats
} from './db.js';
import {
  authenticate, login, destroySession, setSessionCookie, clearSessionCookie,
  ensureDefaultAdmin, createPasswordHash, confirmMfaSetup, getSessionCsrfToken
} from './auth.js';
import { validateMetricsParams, validateAdminUser, parseNumberParam, parseBooleanParam } from './validate.js';
import { deleteCachedPdf, analyzeDocumentFile, analyzePdfAtPath, extractAndSaveParsedData } from './pdf.js';
import { getConceptPipelineStatus, rebuildConceptDictionary, scheduleDailyConceptRebuild } from './conceptsPipeline.js';
import { extractSearchTerms, runPendingCatalogueLookups } from './catalogue.js';
import { logger } from './logger.js';
import { getConfiguredApiKey, setConfiguredApiKey } from './secrets.js';
import { getDocumentSyncStatus, getSyncKeyForOptions, startDocumentSync } from './sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const metricsCache = new Map();
const metricsInflight = new Map();
const failedLoginsByIp = new Map();
const failedLoginsByUser = new Map();
let stopDailyConceptScheduler = null;

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

function applySecurityHeaders(_req, res, next) {
  for (const [name, value] of Object.entries(securityHeaders)) {
    res.setHeader(name, value);
  }
  next();
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

async function getPublicAdminSettings() {
  const settings = await getAllSettings();
  const apiKey = await getConfiguredApiKey();
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

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hasValidCsrf(req, user) {
  return Boolean(user?.csrfToken) && safeEqual(req.get('x-csrf-token'), user.csrfToken);
}

function cleanupLimiterMap(map, now) {
  for (const [key, entry] of map.entries()) {
    pruneAttempts(entry, now);
    if (!entry.attempts.length && entry.blockedUntil <= now) {
      map.delete(key);
    }
  }
}

function requireAdmin(req, res, next) {
  const user = authenticate(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  req.user = user;
  next();
}

function requireCsrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    next();
    return;
  }
  if (req.path === '/api/auth/login' || req.path === '/api/auth/mfa/setup/confirm') {
    next();
    return;
  }
  const user = authenticate(req);
  if (!user) {
    next();
    return;
  }
  if (!hasValidCsrf(req, user)) {
    res.status(403).json({ error: 'Invalid CSRF token' });
    return;
  }
  next();
}

function getQueryValue(req, key) {
  const value = req.query[key];
  return Array.isArray(value) ? value[0] : value;
}

setInterval(() => {
  const now = Date.now();
  cleanupLimiterMap(failedLoginsByIp, now);
  cleanupLimiterMap(failedLoginsByUser, now);
}, Math.max(60_000, Math.floor(LOGIN_WINDOW_MS / 2))).unref();

// --- App ---

export const app = express();

app.set('trust proxy', TRUST_PROXY);
app.use(applySecurityHeaders);
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`, { ip: getClientIp(req) });
  next();
});
app.use(express.json({ limit: '64kb' }));
app.use(requireCsrf);

// --- Health ---

app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true, timestamp: new Date().toISOString() });
});

// --- Auth routes ---

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { username, password, mfaCode } = body;
  const ip = getClientIp(req);
  const userKey = String(username || '').trim().toLowerCase();
  const now = Date.now();
  const blockedByIp = isBlocked(failedLoginsByIp, ip, now);
  const blockedByUser = userKey ? isBlocked(failedLoginsByUser, userKey, now) : false;
  if (blockedByIp || blockedByUser) {
    await sleep(LOGIN_FAILURE_DELAY_MS);
    res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    return;
  }
  if (!username || !password) {
    recordFailedLogin(failedLoginsByIp, ip, LOGIN_MAX_ATTEMPTS_IP, now);
    if (userKey) recordFailedLogin(failedLoginsByUser, userKey, LOGIN_MAX_ATTEMPTS_USER, now);
    await sleep(LOGIN_FAILURE_DELAY_MS);
    res.status(400).json({ error: 'Username and password required' });
    return;
  }
  const result = await login(username, password, { mfaCode });
  if (!result.ok) {
    if (result.mfaRequired && !mfaCode) {
      res.status(200).json({
        ok: false,
        mfaRequired: true,
      });
      return;
    }
    if (result.mfaRequired) {
      recordFailedLogin(failedLoginsByIp, ip, LOGIN_MAX_ATTEMPTS_IP, now);
      if (userKey) recordFailedLogin(failedLoginsByUser, userKey, LOGIN_MAX_ATTEMPTS_USER, now);
      await sleep(LOGIN_FAILURE_DELAY_MS);
      res.status(401).json({ error: 'Invalid MFA code', mfaRequired: true });
      return;
    }
    if (result.mfaSetupRequired) {
      res.status(200).json({
        ok: false,
        mfaSetupRequired: true,
        setupToken: result.token,
        secret: result.secret,
        otpauthUrl: result.otpauthUrl,
      });
      return;
    }
    recordFailedLogin(failedLoginsByIp, ip, LOGIN_MAX_ATTEMPTS_IP, now);
    if (userKey) recordFailedLogin(failedLoginsByUser, userKey, LOGIN_MAX_ATTEMPTS_USER, now);
    await sleep(LOGIN_FAILURE_DELAY_MS);
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  clearFailedLogins(failedLoginsByIp, ip);
  if (userKey) clearFailedLogins(failedLoginsByUser, userKey);
  setSessionCookie(res, result.token, req);
  res.status(200).json({
    ok: true,
    username: result.username,
    mfaEnabled: result.mfaEnabled,
    csrfToken: getSessionCsrfToken(result.token)
  });
}));

app.post('/api/auth/mfa/setup/confirm', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const token = String(body.setupToken || '');
  const code = String(body.code || '');
  const ip = getClientIp(req);
  const now = Date.now();
  if (isBlocked(failedLoginsByIp, ip, now)) {
    await sleep(LOGIN_FAILURE_DELAY_MS);
    res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    return;
  }
  const sessionToken = await confirmMfaSetup(token, code);
  if (!sessionToken) {
    recordFailedLogin(failedLoginsByIp, ip, LOGIN_MAX_ATTEMPTS_IP, now);
    await sleep(LOGIN_FAILURE_DELAY_MS);
    res.status(400).json({ error: 'Invalid or expired MFA setup code' });
    return;
  }
  clearFailedLogins(failedLoginsByIp, ip);
  setSessionCookie(res, sessionToken, req);
  res.status(200).json({ ok: true, csrfToken: getSessionCsrfToken(sessionToken) });
}));

app.post('/api/auth/logout', (req, res) => {
  const user = authenticate(req);
  if (user) destroySession(user.token);
  clearSessionCookie(res, req);
  res.status(200).json({ ok: true });
});

app.get('/api/auth/session', (req, res) => {
  const user = authenticate(req);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  res.status(200).json({ ok: true, username: user.username, csrfToken: user.csrfToken });
});

// --- Admin routes ---

app.get('/api/admin/users', requireAdmin, asyncHandler(async (_req, res) => {
  res.status(200).json({ users: await listUsers() });
}));

app.post('/api/admin/users', requireAdmin, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const validation = validateAdminUser(body.username, body.password);
  if (!validation.valid) {
    res.status(400).json({ error: 'Validation failed', errors: validation.errors });
    return;
  }
  if (await findUserByUsername(body.username)) {
    res.status(409).json({ error: 'Username already exists' });
    return;
  }
  const { hash, salt } = createPasswordHash(body.password);
  await createUser(body.username, hash, salt);
  res.status(201).json({ ok: true, username: body.username });
}));

app.delete('/api/admin/users/:username', requireAdmin, asyncHandler(async (req, res) => {
  const username = req.params.username;
  if ((await countUsers()) <= 1) {
    res.status(400).json({ error: 'Cannot delete the last admin user' });
    return;
  }
  if (!(await deleteUser(username))) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.status(200).json({ ok: true });
}));

app.put('/api/admin/users/:username/password', requireAdmin, asyncHandler(async (req, res) => {
  const username = req.params.username;
  const password = String(req.body?.password || '');
  const validation = validateAdminUser(username, password);
  if (!validation.valid) {
    res.status(400).json({ error: 'Validation failed', errors: validation.errors });
    return;
  }
  if (!(await findUserByUsername(username))) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const { hash, salt } = createPasswordHash(password);
  await updateUserPassword(username, hash, salt);
  res.status(200).json({ ok: true });
}));

app.delete('/api/admin/users/:username/mfa', requireAdmin, asyncHandler(async (req, res) => {
  const username = req.params.username;
  if (!(await clearUserMfa(username))) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.status(200).json({ ok: true });
}));

app.get('/api/admin/settings', requireAdmin, asyncHandler(async (_req, res) => {
  res.status(200).json({ settings: await getPublicAdminSettings() });
}));

app.put('/api/admin/settings', requireAdmin, asyncHandler(async (req, res) => {
  const body = req.body || {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'apiKey') continue;
    await setSetting(key, String(value));
  }
  if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) {
    const nextApiKey = String(body.apiKey || '').trim();
    if (nextApiKey) {
      await setConfiguredApiKey(nextApiKey);
    }
  }
  res.status(200).json({ ok: true, settings: await getPublicAdminSettings() });
}));

app.get('/api/admin/documents/sync/status', requireAdmin, asyncHandler(async (req, res) => {
  const options = {
    index: getQueryValue(req, 'index'),
    query: getQueryValue(req, 'query'),
    term: getQueryValue(req, 'term'),
    source: getQueryValue(req, 'source'),
    maxRecords: getQueryValue(req, 'maxRecords'),
    pageSize: getQueryValue(req, 'pageSize'),
    scanLimit: getQueryValue(req, 'scanLimit'),
    apiKey: await getConfiguredApiKey(),
  };
  res.status(200).json({ status: await getDocumentSyncStatus(getSyncKeyForOptions(options)) });
}));

app.post('/api/admin/documents/sync', requireAdmin, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const options = {
    index: body.index ?? getQueryValue(req, 'index'),
    query: body.query ?? getQueryValue(req, 'query'),
    term: body.term ?? getQueryValue(req, 'term'),
    source: body.source ?? getQueryValue(req, 'source'),
    maxRecords: body.maxRecords ?? getQueryValue(req, 'maxRecords'),
    syncMaxRecords: body.syncMaxRecords ?? body.scanLimit ?? getQueryValue(req, 'scanLimit'),
    pageSize: body.pageSize ?? getQueryValue(req, 'pageSize'),
    scanLimit: body.scanLimit ?? getQueryValue(req, 'scanLimit'),
    apiKey: await getConfiguredApiKey(),
  };
  const result = await startDocumentSync(options);
  metricsCache.clear();
  res.status(result.alreadyRunning ? 202 : 202).json({ ok: true, ...result });
}));

app.get('/api/admin/concepts/status', requireAdmin, asyncHandler(async (_req, res) => {
  const status = await getConceptPipelineStatus();
  res.status(200).json({ status });
}));

app.post('/api/admin/concepts/rebuild', requireAdmin, asyncHandler(async (_req, res) => {
  const result = await rebuildConceptDictionary({ trigger: 'manual' });
  if (!result.ok) {
    res.status(409).json({ ok: false, error: result.error || 'Rebuild failed' });
    return;
  }
  res.status(200).json({ ok: true, stats: result.artifact?.stats || null });
}));

app.get('/api/admin/catalogue-lookup/stats', requireAdmin, asyncHandler(async (_req, res) => {
  const stats = await getCatalogueLookupStats();
  res.status(200).json({ stats });
}));

app.post('/api/admin/catalogue-lookup', requireAdmin, asyncHandler(async (req, res) => {
  const limit = parseNumberParam(getQueryValue(req, 'limit'), 100);
  const dryRun = parseBooleanParam(getQueryValue(req, 'dryRun'), false);

  if (dryRun) {
    const pending = await listPendingLookups(limit);
    if (!pending.length) {
      res.status(200).json({ ok: true, dryRun: true, total: 0, previews: [] });
      return;
    }
    const previews = pending.map((row) => ({
      citationId: row.id,
      citationText: row.citation_text,
      ...extractSearchTerms(row.citation_text),
    }));
    res.status(200).json({ ok: true, dryRun: true, total: previews.length, previews });
    return;
  }

  const stats = await runPendingCatalogueLookups({ pageSize: limit });
  res.status(200).json({ ok: true, ...stats });
}));

app.get('/api/admin/cache', requireAdmin, asyncHandler(async (_req, res) => {
  res.status(200).json({ entries: await listFileMetrics() });
}));

app.get('/api/admin/cache/stats', requireAdmin, asyncHandler(async (_req, res) => {
  res.status(200).json({ stats: await getFileMetricsStats() });
}));

app.post('/api/admin/cache/refresh', requireAdmin, (_req, res) => {
  metricsCache.clear();
  res.status(200).json({ ok: true, message: 'In-memory cache cleared. Next query will re-fetch.' });
});

app.post('/api/admin/cache/:docId/refresh', requireAdmin, asyncHandler(async (req, res) => {
  const docId = req.params.docId;
  const doc = await loadDocumentMetadata(docId);
  if (!doc) {
    res.status(404).json({ error: 'Document not found in metadata store' });
    return;
  }
  await deleteCachedPdf(docId);
  await analyzeDocumentFile(doc, { downloadFiles: true, forceDownload: true, recomputeFromCache: false });
  metricsCache.clear();
  res.status(200).json({
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
}));

app.delete('/api/admin/cache/:docId', requireAdmin, asyncHandler(async (req, res) => {
  const docId = req.params.docId;
  await deleteCachedPdf(docId);
  await deleteFileMetric(docId);
  res.status(200).json({ ok: true });
}));

app.post('/api/admin/reparse-all', requireAdmin, asyncHandler(async (_req, res) => {
  await clearAllCitations();
  const entries = (await listFileMetrics()).filter((e) => e.pdf_path);
  let processed = 0;
  let withCommittee = 0;
  let totalCitations = 0;

  for (const entry of entries) {
    try {
      const analysis = await analyzePdfAtPath(entry.pdf_path);
      if (!analysis.fullText) continue;
      processed++;

      const doc = await loadDocumentMetadata(entry.doc_id) || { id: entry.doc_id, supervisors: [] };
      await extractAndSaveParsedData(doc, analysis.fullText);
      if (doc.committee?.length) withCommittee++;
      if (doc.citationCount) totalCitations += Number(doc.citationCount);
    } catch (err) {
      logger.warn('Reparse failed for doc', { docId: entry.doc_id, error: err.message });
    }
  }

  const lookupStats = await runPendingCatalogueLookups();

  metricsCache.clear();
  res.status(200).json({ ok: true, processed, committees: withCommittee, citations: totalCitations, catalogueLookups: lookupStats });
}));

app.post('/api/admin/reparse-committee', requireAdmin, asyncHandler(async (_req, res) => {
  const targetResult = await (await getDb()).execute({
    sql: `
    SELECT fm.doc_id, fm.pdf_path
    FROM file_metrics fm
    WHERE fm.pdf_path IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM committee_members cm WHERE cm.doc_id = fm.doc_id
    )
  `});
  const targets = targetResult.rows;

  let processed = 0, withCommittee = 0;
  for (const row of targets) {
    const doc = await loadDocumentMetadata(row.doc_id);
    if (!doc) continue;
    try {
      const analysis = await analyzePdfAtPath(row.pdf_path);
      if (analysis?.fullText) {
        const before = (await loadCommitteeMembers(row.doc_id)).length;
        await extractAndSaveParsedData(doc, analysis.fullText);
        const after = (await loadCommitteeMembers(row.doc_id)).length;
        if (after > before) withCommittee++;
      }
    } catch { /* skip individual failures */ }
    processed++;
  }

  metricsCache.clear();
  res.status(200).json({ ok: true, processed, withCommittee });
}));

app.get('/api/admin/runs', requireAdmin, asyncHandler(async (_req, res) => {
  const runs = await listRecentRuns(50);
  res.status(200).json({ runs });
}));

// --- Public routes ---

app.get('/api/documents/:docId/citations', asyncHandler(async (req, res) => {
  const citations = await loadDocumentCitationsWithSharing(req.params.docId);
  res.status(200).json({ citations });
}));

app.get('/api/citations/top', asyncHandler(async (req, res) => {
  const limit = parseNumberParam(getQueryValue(req, 'limit'), 50);
  const works = await getTopCitedWorks(Math.min(limit, 200));
  res.status(200).json({ works });
}));

app.get('/api/citations/:citationId/documents', asyncHandler(async (req, res) => {
  const citationId = Number(req.params.citationId);
  if (!Number.isFinite(citationId) || citationId <= 0) {
    res.status(400).json({ error: 'Invalid citation ID' });
    return;
  }
  const documents = await loadDocsByCitation(citationId);
  res.status(200).json({ documents });
}));

app.get('/api/citations/:citationId/summon-check', asyncHandler(async (req, res) => {
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

  const q = row.query_title
    ? `Title:(${row.query_title})${row.query_author ? ` AND Author:(${row.query_author})` : ''}`
    : String(row.citation_text || '').slice(0, 200);
  if (!q) {
    res.status(422).json({ error: 'Insufficient citation data' });
    return;
  }

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
    res.status(200).json({ found, results, searchUrl, illUrl: 'https://ill-docdel.library.ubc.ca/home' });
  } catch {
    res.status(502).json({ error: 'Summon lookup failed' });
  }
}));

app.get('/api/metrics', asyncHandler(async (req, res) => {
  const rawParams = {
    maxRecords: getQueryValue(req, 'maxRecords'),
    pageSize: getQueryValue(req, 'pageSize'),
    scanLimit: getQueryValue(req, 'scanLimit'),
    subjectLimit: getQueryValue(req, 'subjectLimit'),
    index: Object.prototype.hasOwnProperty.call(req.query, 'index') ? getQueryValue(req, 'index') : null,
    query: Object.prototype.hasOwnProperty.call(req.query, 'query') ? getQueryValue(req, 'query') : null,
    term: Object.prototype.hasOwnProperty.call(req.query, 'term') ? getQueryValue(req, 'term') : null,
    source: Object.prototype.hasOwnProperty.call(req.query, 'source') ? getQueryValue(req, 'source') : null,
  };

  const validation = validateMetricsParams(rawParams);
  if (!validation.valid) {
    res.status(400).json({ error: 'Validation failed', errors: validation.errors });
    return;
  }

  const maxRecords = parseNumberParam(rawParams.maxRecords, 200);
  const pageSize = parseNumberParam(rawParams.pageSize, 20);
  const scanLimit = parseNumberParam(rawParams.scanLimit, Math.max(maxRecords * 10, 1000));
  const subjectLimit = parseNumberParam(rawParams.subjectLimit, 25);
  const index = rawParams.index !== null ? rawParams.index : undefined;
  const query = getQueryValue(req, 'query') || undefined;
  const term = getQueryValue(req, 'term') || undefined;
  const source = getQueryValue(req, 'source') || undefined;
  const configuredApiKey = await getConfiguredApiKey();
  const apiKey = configuredApiKey || undefined;
  const downloadFiles = parseBooleanParam(getQueryValue(req, 'downloadFiles'), true);
  const recomputeFromCache = parseBooleanParam(getQueryValue(req, 'recomputeFromCache'), false);
  const refresh = getQueryValue(req, 'refresh') === '1';
  const user = authenticate(req);
  const isAdminRequest = Boolean(user);
  if (isAdminRequest && !hasValidCsrf(req, user)) {
    res.status(403).json({ error: 'Invalid CSRF token' });
    return;
  }
  if (!isAdminRequest && downloadFiles && !ALLOW_PUBLIC_DOWNLOADS) {
    res.status(403).json({ error: 'downloadFiles is restricted to authenticated admin sessions.' });
    return;
  }
  if (!isAdminRequest && refresh && !ALLOW_PUBLIC_REFRESH) {
    res.status(403).json({ error: 'refresh is restricted to authenticated admin sessions.' });
    return;
  }
  if (!isAdminRequest && recomputeFromCache && !ALLOW_PUBLIC_RECOMPUTE) {
    res.status(403).json({ error: 'recomputeFromCache is restricted to authenticated admin sessions.' });
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
      res.status(200).json(cached.payload);
      return;
    }
  }

  if (metricsInflight.has(cacheKey)) {
    const payload = await metricsInflight.get(cacheKey);
    res.status(200).json(payload);
    return;
  }

  const computePayload = async () => {
    const sourceOptions = {
      maxRecords: effectiveMaxRecords, pageSize, scanLimit: effectiveScanLimit, subjectLimit,
      index, query, term, source, apiKey,
      downloadFiles,
      forceDownload: refresh,
      recomputeFromCache
    };
    const syncKey = getSyncKeyForOptions(sourceOptions);
    const cacheStats = await getDocumentCacheStats(syncKey);
    const canUseDocumentCache = !refresh && !recomputeFromCache && cacheStats.total > 0;
    const cachedDocuments = canUseDocumentCache
      ? await listCachedDocuments({ syncKey, limit: effectiveMaxRecords })
      : null;
    const payload = await collectMetrics({
      ...sourceOptions,
      cachedDocuments,
      skipFileEnrichment: Boolean(cachedDocuments),
    });
    if (cachedDocuments) {
      payload.source.documentCache = {
        syncKey,
        recordsAvailable: cacheStats.total,
        lastSyncedAt: cacheStats.lastSyncedAt,
      };
    }
    metricsCache.set(cacheKey, { timestamp: Date.now(), payload });
    return payload;
  };

  const promise = computePayload().finally(() => metricsInflight.delete(cacheKey));
  metricsInflight.set(cacheKey, promise);
  const payload = await promise;
  res.status(200).json(payload);
}));

// --- Static files ---

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});
app.use(express.static(publicDir, { index: false }));

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((error, req, res, _next) => {
  logger.error('Request error', { path: req.path, error: error.message });
  if (res.headersSent) return;
  res.status(500).json({
    error: 'Internal server error',
    message: EXPOSE_ERROR_DETAILS && error instanceof Error ? error.message : 'Unexpected error'
  });
});

// --- Startup ---

export async function start() {
  await ensureStorage();
  await getDb();
  await ensureDefaultAdmin();

  try {
    await logCacheStats();
    await checkCacheIntegrity();
  } catch (e) {
    logger.warn('Cache check on startup failed', { error: e.message });
  }

  const server = app.listen(PORT, () => {
    logger.info(`UBC Dissertation Intelligence Workbench running at http://localhost:${PORT}`);
  });

  // Warm the in-memory metrics cache so the first browser load is served instantly.
  // Key is constructed to match exactly what the request handler produces for a default
  // non-admin request (no query params): index/query/term/source all undefined -> omitted by JSON.stringify.
  const _warmupApiKey = await getConfiguredApiKey();
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
      index: '',              // browser sends index='' (empty input) which is not || undefined'd
      term: DEFAULT_TERM,     // browser sends this from s-term input
      source: DEFAULT_SOURCE, // browser sends this from s-source input
      hasApiKey: Boolean(_warmupApiKey),
      downloadFiles: false, recomputeFromCache: false, refresh: false, isAdminRequest: false,
    });
    metricsCache.set(warmupKey, { timestamp: Date.now(), payload });
    logger.info('Metrics cache warmed on startup');
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

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start();
}
