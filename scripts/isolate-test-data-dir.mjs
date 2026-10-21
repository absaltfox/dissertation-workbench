// Preloaded (via --import) into every test-file process that
// scripts/run-tests.mjs launches. node --test runs each test file in its own
// child process, several at once, so a single runner-wide APP_DATA_DIR would
// make every file that relies on the inherited env share one SQLite file:
// concurrent writers then hit SQLITE_BUSY, and state one file writes (e.g. an
// import rule that activates processing-eligibility gating) changes what
// another file's queries return. Giving each test-file process its own data
// dir here makes isolation the default — a new test file is isolated without
// opting in. Files that provision their own temp dir in test.before() still
// win: they overwrite these variables before importing src modules.
//
// This must run before any src module is imported, because src/config.js
// resolves DATA_DIR / SQLITE_PATH / cache dirs once, at import time — and a
// test file's static `import ... from '../src/...'` is evaluated before its
// test.before() hook ever runs.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Opt-in flag set by scripts/run-tests.mjs (not Node's undocumented
// NODE_TEST_CONTEXT), so a Node internal rename cannot silently disable isolation.
if (process.env.OC_TEST_ISOLATE === '1') {
  // Nest under the runner's dir when there is one, so the runner's own
  // cleanup also reclaims the dir of a test process that was killed.
  const parent = process.env.OC_TEST_DATA_ROOT || tmpdir();
  const dataDir = mkdtempSync(path.join(parent, 'file-'));
  process.env.APP_DATA_DIR = dataDir;
  process.env.SQLITE_PATH = path.join(dataDir, 'metrics.sqlite');
  delete process.env.PDF_CACHE_DIR;
  delete process.env.FULL_TEXT_CACHE_DIR;

  process.on('exit', () => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Best-effort; the runner removes OC_TEST_DATA_ROOT afterwards anyway.
    }
  });
}
