import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { addColumnIfMissing } from '../src/db.js';

const execFileAsync = promisify(execFile);

test('schema migration adds content_mode to existing import_rules conservatively', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-content-mode-migration-'));
  const sqlitePath = path.join(tempDir, 'legacy.sqlite');
  const client = createClient({ url: `file:${sqlitePath}` });
  try {
    await client.executeMultiple(`
      CREATE TABLE import_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        degree TEXT,
        program TEXT,
        affiliation TEXT,
        requested_index TEXT,
        query TEXT,
        source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO import_rules (id, name, created_at, updated_at)
      VALUES ('legacy-rule', 'Legacy rule', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
  } finally {
    await client.close();
  }

  const dbModuleUrl = pathToFileURL(path.resolve('src/db.js')).href;
  const childSource = `
    const db = await import(${JSON.stringify(dbModuleUrl)});
    const rule = await db.getImportRule('legacy-rule');
    process.stdout.write(JSON.stringify(rule));
    await db.closeDb();
  `;
  try {
    const childOptions = {
      cwd: process.cwd(),
      env: {
        ...process.env,
        APP_DATA_DIR: path.join(tempDir, 'data'),
        SQLITE_PATH: sqlitePath,
        TURSO_DATABASE_URL: '',
        SKIP_LOCAL_ENV: '1',
      },
    };
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', childSource],
      childOptions
    );
    const migrated = JSON.parse(stdout);
    assert.equal(migrated.id, 'legacy-rule');
    assert.equal(migrated.contentMode, 'metadata_only');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('concurrent column migration accepts only a verified winner', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-content-mode-race-'));
  const sqlitePath = path.join(tempDir, 'race.sqlite');
  const setupClient = createClient({ url: `file:${sqlitePath}` });
  await setupClient.execute(`
    CREATE TABLE import_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
  await setupClient.close();

  const clientOne = createClient({ url: `file:${sqlitePath}` });
  const clientTwo = createClient({ url: `file:${sqlitePath}` });
  try {
    await Promise.all([
      addColumnIfMissing(clientOne, 'import_rules', 'content_mode', "TEXT NOT NULL DEFAULT 'metadata_only'"),
      addColumnIfMissing(clientTwo, 'import_rules', 'content_mode', "TEXT NOT NULL DEFAULT 'metadata_only'"),
    ]);
    const result = await clientOne.execute('PRAGMA table_info(import_rules)');
    assert.equal(result.rows.filter((row) => row.name === 'content_mode').length, 1);
  } finally {
    await clientOne.close();
    await clientTwo.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
