import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMetrics } from './metrics.js';
import {
  PORT, PUBLIC_MAX_RECORDS, PUBLIC_SCAN_LIMIT, EXPOSE_ERROR_DETAILS,
  DEFAULT_TERM, DEFAULT_SOURCE, TRUST_PROXY, validateRuntimeSecrets
} from './config.js';
import {
  checkCacheIntegrity, ensureStorage, getDb, logCacheStats, closeDb
} from './db.js';
import { ensureDefaultAdmin } from './auth.js';
import { getConceptPipelineStatus, rebuildConceptDictionary, scheduleDailyConceptRebuild } from './conceptsPipeline.js';
import { logger } from './logger.js';
import { getConfiguredApiKey } from './secrets.js';
import { getTrustedClientIp } from './requestSecurity.js';
import { applySecurityHeaders } from './middleware/http.js';
import { requireAdmin, requireCsrf } from './middleware/adminAuth.js';
import { createAuthRouter } from './routes/authRoutes.js';
import { createAdminJobsRouter } from './routes/adminJobsRoutes.js';
import { createAdminImportRouter } from './routes/adminImportRoutes.js';
import { createAdminOperationsRouter } from './routes/adminOperationsRoutes.js';
import { createAdminUsersRouter } from './routes/adminUsersRoutes.js';
import { createMetricsRouter } from './routes/metricsRoutes.js';
import { createPublicRouter } from './routes/publicRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const metricsCache = new Map();
const metricsInflight = new Map();
let stopDailyConceptScheduler = null;

// Sync pulls in the metrics/PDF pipeline and is only needed for admin import
// workflows. Loading it lazily keeps normal API startup cheaper and avoids
// unnecessary side effects during lightweight route tests.
async function loadSyncModule() {
  return import('./sync.js');
}

// --- Request helpers ---

function getClientIp(req) {
  return getTrustedClientIp(req);
}

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

app.use('/api/auth', createAuthRouter({ getClientIp }));

const clearMetricsCache = () => metricsCache.clear();

app.use('/api/admin', requireAdmin, createAdminUsersRouter());
app.use('/api/admin', requireAdmin, createAdminImportRouter({ loadSyncModule, clearMetricsCache }));
app.use('/api/admin', requireAdmin, createAdminOperationsRouter({ loadSyncModule, clearMetricsCache }));
app.use('/api/admin', requireAdmin, createAdminJobsRouter({ loadSyncModule, clearMetricsCache }));
app.use('/api', createPublicRouter());
app.use('/api', createMetricsRouter({ metricsCache, metricsInflight, loadSyncModule }));

// --- Static files ---

app.use('/vendor/chart.js', express.static(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js')));
app.use('/vendor/d3.js', express.static(path.join(__dirname, '..', 'node_modules', 'd3', 'dist', 'd3.min.js')));

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
  validateRuntimeSecrets();
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

  // Graceful shutdown helper
  let isShuttingDown = false;
  async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Server shutting down due to ${signal}...`);
    
    if (stopDailyConceptScheduler) {
      stopDailyConceptScheduler();
      stopDailyConceptScheduler = null;
    }
    
    server.close(() => {
      logger.info('HTTP server closed.');
    });

    try {
      await closeDb();
      logger.info('Database connection closed.');
    } catch (e) {
      logger.error('Failed to close database during shutdown', { error: e.message });
    }
    
    process.exit(0);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('uncaughtException', async (error) => {
    logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
    try {
      await closeDb();
    } catch (_) {}
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error('Unhandled Rejection', { message, stack });
    try {
      await closeDb();
    } catch (_) {}
    process.exit(1);
  });

  return server;
}

const isNodeTest = Boolean(process.env.NODE_TEST_CONTEXT) || process.argv.some((arg) => /(?:^|\/)test\/.*\.test\.js$/.test(arg));

if (process.env.npm_lifecycle_event !== 'test' && !isNodeTest && process.argv[1] === fileURLToPath(import.meta.url)) {
  start();
}
