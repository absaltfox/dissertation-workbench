// Runs the node:test suite against an isolated temporary data directory so
// tests never touch the developer's real ./data/metrics.sqlite (which iCloud
// may hold locked, and which test fixtures would otherwise pollute).
// Test files that provision their own temp dirs in test.before() still win:
// they overwrite these variables before importing src modules.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dataDir = mkdtempSync(path.join(tmpdir(), 'oc-test-data-'));

const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    APP_DATA_DIR: dataDir,
    SQLITE_PATH: path.join(dataDir, 'metrics.sqlite'),
    TURSO_DATABASE_URL: '',
    SKIP_LOCAL_ENV: '1',
    ALLOW_ORIGINAL_PDF_RETRIEVAL: '1',
  },
});

child.on('close', (code, signal) => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; the OS reclaims tmpdir eventually.
  }
  process.exit(signal ? 1 : (code ?? 1));
});
