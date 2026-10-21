// Runs the node:test suite against an isolated temporary data directory so
// tests never touch the developer's real ./data/metrics.sqlite (which iCloud
// may hold locked, and which test fixtures would otherwise pollute).
// Every test-file process additionally gets its OWN data dir (nested under
// this one) from the --import preload below, so concurrently running files
// never share a SQLite file. Test files that provision their own temp dirs in
// test.before() still win: they overwrite these variables before importing
// src modules.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dataDir = mkdtempSync(path.join(tmpdir(), 'oc-test-data-'));
const isolatePreload = fileURLToPath(new URL('./isolate-test-data-dir.mjs', import.meta.url));

// --expose-gc lets peak-heap scaling tests (Phase D #26/#27) force a
// collection between measurements for a much less noisy heapUsed delta.
// Tests that don't call global.gc() are unaffected.
const child = spawn(process.execPath, ['--expose-gc', '--import', isolatePreload, '--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    OC_TEST_DATA_ROOT: dataDir,
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
