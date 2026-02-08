import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMetrics } from './metrics.js';
import { PORT, CACHE_TTL_MS } from './config.js';
import { ensureStorage, getDb, listUsers, listFileMetrics, getFileMetricsStats, deleteFileMetric, listRecentRuns, getAllSettings, setSetting, loadDocumentMetadata } from './db.js';
import { authenticate, requireAdmin, login, destroySession, setSessionCookie, clearSessionCookie, ensureDefaultAdmin, createPasswordHash } from './auth.js';
import { createUser, deleteUser, countUsers, findUserByUsername, checkCacheIntegrity, logCacheStats, saveCommitteeMembers, saveCitations, loadDocumentCitations } from './db.js';
import { validateMetricsParams, validateAdminUser, parseNumberParam, parseBooleanParam } from './validate.js';
import { deleteCachedPdf, analyzeDocumentFile, analyzePdfAtPath, parseCommittee, parseBibliography, normalizeCitation } from './pdf.js';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const metricsCache = new Map();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};

// --- Helpers ---

function sendJson(res, status, data) {
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
      if (!username || !password) {
        sendJson(res, 400, { error: 'Username and password required' });
        return;
      }
      const token = login(username, password);
      if (!token) {
        sendJson(res, 401, { error: 'Invalid credentials' });
        return;
      }
      setSessionCookie(res, token);
      sendJson(res, 200, { ok: true, username });
      return;
    }

    if (url.pathname === '/api/auth/logout' && method === 'POST') {
      const user = authenticate(req);
      if (user) destroySession(user.token);
      clearSessionCookie(res);
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
      sendJson(res, 200, { settings: getAllSettings() });
      return;
    }

    if (url.pathname === '/api/admin/settings' && method === 'PUT') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      for (const [key, value] of Object.entries(body)) {
        setSetting(key, String(value));
      }
      sendJson(res, 200, { ok: true, settings: getAllSettings() });
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
      const entries = listFileMetrics().filter((e) => e.pdf_path);
      let processed = 0;
      let withCommittee = 0;
      let totalCitations = 0;

      for (const entry of entries) {
        try {
          const analysis = await analyzePdfAtPath(entry.pdf_path);
          if (!analysis.fullText) continue;
          processed++;

          const committee = parseCommittee(analysis.fullText);
          if (committee.length) {
            saveCommitteeMembers(entry.doc_id, committee, 'pdf');
            withCommittee++;
          }

          const citations = parseBibliography(analysis.fullText);
          if (citations.length) {
            saveCitations(entry.doc_id, citations, normalizeCitation);
            totalCitations += citations.length;
          }
        } catch (err) {
          logger.warn('Reparse failed for doc', { docId: entry.doc_id, error: err.message });
        }
      }

      metricsCache.clear();
      sendJson(res, 200, { ok: true, processed, committees: withCommittee, citations: totalCitations });
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
      const citations = loadDocumentCitations(docId);
      sendJson(res, 200, { citations });
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
      const index = url.searchParams.get('index') || undefined;
      const query = url.searchParams.get('query') || undefined;
      const term = url.searchParams.get('term') || undefined;
      const source = url.searchParams.get('source') || undefined;
      const apiKey = url.searchParams.get('apiKey') || undefined;
      const downloadFiles = parseBooleanParam(url.searchParams.get('downloadFiles'), true);
      const recomputeFromCache = parseBooleanParam(url.searchParams.get('recomputeFromCache'), false);
      const refresh = url.searchParams.get('refresh') === '1';

      const cacheKey = JSON.stringify({
        maxRecords, pageSize, scanLimit, subjectLimit,
        index, query, term, source,
        hasApiKey: Boolean(apiKey),
        downloadFiles, recomputeFromCache
      });

      if (!refresh && !recomputeFromCache) {
        const cached = metricsCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
          sendJson(res, 200, cached.payload);
          return;
        }
      }

      const payload = await collectMetrics({
        maxRecords, pageSize, scanLimit, subjectLimit,
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
      message: error instanceof Error ? error.message : String(error)
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
}

start();
