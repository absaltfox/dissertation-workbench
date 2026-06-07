import {
  CATALOGUE_LOOKUP_ENABLED, CATALOGUE_LOOKUP_ON_START, CATALOGUE_LOOKUP_PAGE_SIZE,
  DEFAULT_API_KEY, DEFAULT_INDEX, DEFAULT_QUERY, DEFAULT_SOURCE, DEFAULT_TERM,
  DOCUMENT_SYNC_ENABLED, DOCUMENT_SYNC_INTERVAL_MS, DOCUMENT_SYNC_MAX_RECORDS,
  DOCUMENT_SYNC_ON_START, DOCUMENT_SYNC_ONCE, validateRuntimeSecrets
} from './config.js';
import { ensureStorage, getDb, closeDb } from './db.js';
import { runDocumentSync } from './sync.js';
import { runPendingCatalogueLookups } from './catalogue.js';
import { logger } from './logger.js';

let stopping = false;

function syncOptions() {
  return {
    index: process.env.DOCUMENT_SYNC_INDEX ?? DEFAULT_INDEX,
    query: process.env.DOCUMENT_SYNC_QUERY ?? DEFAULT_QUERY,
    term: process.env.DOCUMENT_SYNC_TERM ?? DEFAULT_TERM,
    source: process.env.DOCUMENT_SYNC_SOURCE ?? DEFAULT_SOURCE,
    pageSize: Number(process.env.DOCUMENT_SYNC_PAGE_SIZE || 100),
    scanLimit: Number(process.env.DOCUMENT_SYNC_SCAN_LIMIT || 50_000),
    syncMaxRecords: DOCUMENT_SYNC_MAX_RECORDS || Number(process.env.DOCUMENT_SYNC_SCAN_LIMIT || 50_000),
    apiKey: process.env.DOCUMENT_SYNC_API_KEY || DEFAULT_API_KEY,
  };
}

let delayResolve = null;
let delayTimer = null;

function delay(ms) {
  return new Promise((resolve) => {
    delayResolve = resolve;
    delayTimer = setTimeout(() => {
      delayResolve = null;
      delayTimer = null;
      resolve();
    }, ms);
  });
}

function interruptDelay() {
  if (delayTimer) {
    clearTimeout(delayTimer);
    delayTimer = null;
  }
  if (delayResolve) {
    delayResolve();
    delayResolve = null;
  }
}

async function runOnce({ initial = false } = {}) {
  if (DOCUMENT_SYNC_ENABLED && (!initial || DOCUMENT_SYNC_ON_START)) {
    const options = syncOptions();
    logger.info('Worker starting document sync', {
      index: options.index,
      term: options.term,
      pageSize: options.pageSize,
      scanLimit: options.scanLimit,
      syncMaxRecords: options.syncMaxRecords,
      hasApiKey: Boolean(options.apiKey),
    });
    const result = await runDocumentSync(options);
    logger.info('Worker completed document sync', {
      syncKey: result.syncKey,
      runId: result.runId,
      status: result.status?.latest?.status,
      totalSaved: result.status?.latest?.totalSaved,
    });
  }

  if (CATALOGUE_LOOKUP_ENABLED && (!initial || CATALOGUE_LOOKUP_ON_START)) {
    logger.info('Worker starting pending catalogue lookups', { pageSize: CATALOGUE_LOOKUP_PAGE_SIZE });
    const stats = await runPendingCatalogueLookups({ pageSize: CATALOGUE_LOOKUP_PAGE_SIZE });
    logger.info('Worker completed pending catalogue lookups', stats);
  }
}

async function main() {
  validateRuntimeSecrets();
  await ensureStorage();
  await getDb();

  process.on('SIGTERM', () => {
    stopping = true;
    logger.info('Worker received SIGTERM; stopping');
    interruptDelay();
  });
  process.on('SIGINT', () => {
    stopping = true;
    logger.info('Worker received SIGINT; stopping');
    interruptDelay();
  });

  process.on('uncaughtException', async (error) => {
    logger.error('Worker uncaught exception', { error: error.message, stack: error.stack });
    try {
      await closeDb();
    } catch (_) {}
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error('Worker unhandled rejection', { message, stack });
    try {
      await closeDb();
    } catch (_) {}
    process.exit(1);
  });

  if ((DOCUMENT_SYNC_ENABLED && DOCUMENT_SYNC_ON_START) || (CATALOGUE_LOOKUP_ENABLED && CATALOGUE_LOOKUP_ON_START)) {
    try {
      await runOnce({ initial: true });
    } catch (error) {
      logger.error('Initial worker cycle failed', { error: error?.message || String(error) });
    }
  }

  if (DOCUMENT_SYNC_ONCE) return;

  while (!stopping) {
    await delay(Math.max(60_000, DOCUMENT_SYNC_INTERVAL_MS));
    if (stopping) break;
    try {
      await runOnce();
    } catch (error) {
      logger.error('Scheduled worker cycle failed', { error: error?.message || String(error) });
    }
  }
}

main()
  .catch((error) => {
    logger.error('Worker crashed', { error: error?.message || String(error) });
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeDb();
      logger.info('Worker database connection closed.');
    } catch (e) {
      logger.error('Failed to close database on worker exit', { error: e.message });
    }
  });
