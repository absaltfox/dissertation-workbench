// Boots the real app for Playwright against a throwaway SQLite DB.
// Env is locked down BEFORE any src/ import, because src/config.js and
// src/env.js read process.env at module load.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isolatedServerEnv } from './server-env.mjs';

const dataDir = mkdtempSync(path.join(tmpdir(), 'oc-e2e-'));
// Replace the inherited env wholesale: only allowlisted host variables plus
// the settings below reach the app (see server-env.mjs).
const serverEnv = isolatedServerEnv(process.env, {
  SKIP_LOCAL_ENV: '1',                     // never load the developer's .env
  NODE_ENV: 'development',                 // non-production: no MFA/encryption-key requirements
  APP_DATA_DIR: dataDir,
  SQLITE_PATH: path.join(dataDir, 'metrics.sqlite'),
  PDF_CACHE_DIR: path.join(dataDir, 'pdf-cache'),
  FULL_TEXT_CACHE_DIR: path.join(dataDir, 'full-text-cache'),
  TURSO_DATABASE_URL: '',
  TURSO_AUTH_TOKEN: '',
  UBC_API_KEY: '',
  UBC_API_BASE_URL: 'http://127.0.0.1:9',  // discard port: any upstream call fails fast
  GROBID_URL: 'http://127.0.0.1:9',
  CATALOGUE_LOOKUP_ENABLED: '0',
  CATALOGUE_LOOKUP_ON_START: '0',
  DOCUMENT_SYNC_ENABLED: '0',
  DOCUMENT_SYNC_ON_START: '0',
  CITATION_SCAN_NIGHTLY_ENABLED: '0',
  CONCEPT_REBUILD_NIGHTLY_ENABLED: '0',    // a run spanning 2:00 must not start a worker
  PORT: process.env.E2E_PORT || '4173',
});
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, serverEnv);

const { seedFixtureCorpus } = await import('./seed.mjs');
await seedFixtureCorpus();

const { start } = await import('../src/server.js');
await start();

// start() installs its own SIGTERM/SIGINT handlers that exit the process;
// clean up the temp dir on the way out.
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }));
