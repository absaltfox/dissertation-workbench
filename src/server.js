import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { applyCompression, applySecurityHeaders } from './middleware/http.js';
import { requireAdmin, requireCsrf } from './middleware/adminAuth.js';
import { createAuthRouter } from './routes/authRoutes.js';
import { createAdminJobsRouter } from './routes/adminJobsRoutes.js';
import { createAdminImportRouter } from './routes/adminImportRoutes.js';
import { createAdminOperationsRouter } from './routes/adminOperationsRoutes.js';
import { createAdminTopicLabelsRouter } from './routes/adminTopicLabelsRoutes.js';
import { createAdminUsersRouter } from './routes/adminUsersRoutes.js';
import { createInternalWorkerRouter } from './routes/internalWorkerRoutes.js';
import {
  buildWorkbenchBootstrapPayload,
  createMetricsRouter,
  sourceCacheKey,
} from './routes/metricsRoutes.js';
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
app.use(applyCompression);
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
app.use('/api/admin', requireAdmin, createAdminTopicLabelsRouter({ clearMetricsCache }));
app.use('/api/admin', requireAdmin, createAdminJobsRouter({ loadSyncModule, clearMetricsCache }));
app.use('/api/internal', createInternalWorkerRouter());
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
  logger.error('Request error', {
    path: req.path,
    error: error.message,
    cause: error.cause ? (error.cause.message || String(error.cause)) : undefined,
    stack: error.stack
  });
  if (res.headersSent) return;
  const statusCode = Number(error?.statusCode || error?.status || 500);
  const safeStatus = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
  const publicMessage = error?.publicMessage || (EXPOSE_ERROR_DETAILS && error instanceof Error ? error.message : null);
  res.status(safeStatus).json({
    error: safeStatus === 503 ? 'Service unavailable' : 'Internal server error',
    message: publicMessage || 'Unexpected error'
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
    logger.info(`Dissertation Workbench running at http://localhost:${PORT}`);
  });

  // Warm the workbench bootstrap cache so the first browser load is served quickly.
  const _warmupApiKey = await getConfiguredApiKey();
  // The browser always sends maxRecords=9999 (UI default), which the server caps to
  // PUBLIC_MAX_RECORDS. The scan limit is derived from the uncapped value, then capped
  // to PUBLIC_SCAN_LIMIT. We replicate that math here so the warmup key matches the
  // first browser request exactly.
  // Other values must mirror the HTML input defaults in public/index.html:
  //   subjectLimit=20, downloadFiles=0, index='', term=DEFAULT_TERM, source=DEFAULT_SOURCE.
  const _warmupParams = {
    maxRecords: PUBLIC_MAX_RECORDS,
    pageSize: 20,
    scanLimit: PUBLIC_SCAN_LIMIT,
    subjectLimit: 20,
    index: '',
    query: undefined,
    term: DEFAULT_TERM,
    source: DEFAULT_SOURCE,
    apiKey: _warmupApiKey || undefined,
    downloadFiles: false,
    forceDownload: false,
    recomputeFromCache: false,
    refresh: false,
    isAdminRequest: false,
    requestedDownloadFiles: false,
    requestedRecomputeFromCache: false,
  };
  const _warmupBootstrapKey = `workbench:bootstrap:${sourceCacheKey(_warmupParams)}`;
  const _warmupPromise = Promise.resolve().then(() => (
    buildWorkbenchBootstrapPayload(_warmupParams, loadSyncModule)
  ));
  metricsInflight.set(_warmupBootstrapKey, _warmupPromise);
  _warmupPromise.then((payload) => {
    metricsCache.set(_warmupBootstrapKey, { timestamp: Date.now(), payload });
    logger.info('Workbench bootstrap cache warmed on startup', {
      documents: payload?.summary?.documents || 0,
    });
  }).catch((e) => {
    logger.warn('Startup workbench bootstrap cache warmup failed', { error: e.message });
  }).finally(() => {
    metricsInflight.delete(_warmupBootstrapKey);
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
