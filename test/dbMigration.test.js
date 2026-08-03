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

test('schema migration adds content policy and provenance fields conservatively', async () => {
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
      CREATE TABLE file_metrics (
        doc_id TEXT PRIMARY KEY,
        pdf_path TEXT,
        download_url TEXT,
        file_bytes INTEGER,
        word_count INTEGER,
        body_word_count INTEGER,
        full_text_path TEXT,
        full_text_bytes INTEGER,
        full_text_source_url TEXT,
        page_count INTEGER,
        word_source TEXT,
        page_source TEXT,
        status TEXT,
        error TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO file_metrics (doc_id, word_count, page_count, status, updated_at)
      VALUES ('legacy-doc', 1000, 4, 'downloaded', '2026-01-01T00:00:00.000Z');
      CREATE TABLE documents (
        doc_id TEXT PRIMARY KEY,
        metadata_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO documents (doc_id, metadata_json, updated_at)
      VALUES (
        'legacy-serving-doc',
        '{"id":"legacy-serving-doc","title":"Legacy serving document","supervisors":["Deirdre M. Kelly"]}',
        '2026-01-01T00:00:00.000Z'
      );
      CREATE TABLE committee_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT,
        affiliation TEXT,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(doc_id, name, role)
      );
      INSERT INTO committee_members (doc_id, name, role, affiliation, source, updated_at)
      VALUES
        ('legacy-committee-1', 'Already Projected Person', 'Committee Member', NULL, 'pdf', '2026-01-01T00:00:00.000Z'),
        ('legacy-committee-2', 'Priority M. Person', 'External Examiner', 'PDF University', 'pdf', '2026-01-01T00:00:00.000Z'),
        ('legacy-committee-2', 'Priority Person', 'External Examiner', 'API University', 'api', '2026-01-02T00:00:00.000Z'),
        ('legacy-committee-3', 'Newest Person', 'Committee Member', 'New Affiliation', 'pdf', '2026-01-03T00:00:00.000Z'),
        ('legacy-committee-3', 'Newest M. Person', 'Committee Member', 'Old Affiliation', 'pdf', '2026-01-01T00:00:00.000Z');
      CREATE TABLE serving_projection_state (
        projection_key TEXT PRIMARY KEY,
        projection_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO serving_projection_state (projection_key, projection_value, updated_at)
      VALUES ('committee_people', 'cursor:1', '2026-01-01T00:00:00.000Z');
    `);
  } finally {
    await client.close();
  }

  const dbModuleUrl = pathToFileURL(path.resolve('src/db.js')).href;
  const childSource = `
    const db = await import(${JSON.stringify(dbModuleUrl)});
    const rule = await db.getImportRule('legacy-rule');
    const metric = await db.loadStoredFileMetric('legacy-doc');
    const people = await db.queryPeoplePage({ limit: 10 });
    const client = await db.getDb();
    const projection = await client.execute("SELECT serving_projection_version FROM documents WHERE doc_id = 'legacy-serving-doc'");
    const committeeProjection = await client.execute("SELECT doc_id, person_key, affiliation, source FROM document_people WHERE source <> 'metadata' ORDER BY doc_id");
    const committeeState = await client.execute("SELECT projection_value FROM serving_projection_state WHERE projection_key = 'committee_people'");
    const rolloutTables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('enrichment_rollouts', 'enrichment_rollout_evidence') ORDER BY name");
    process.stdout.write(JSON.stringify({
      rule, metric, people,
      projectionVersion: projection.rows[0]?.serving_projection_version,
      committeeProjection: committeeProjection.rows,
      committeeState: committeeState.rows[0]?.projection_value,
      rolloutTables: rolloutTables.rows.map((row) => row.name),
    }));
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
    const migrated = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(migrated.rule.id, 'legacy-rule');
    assert.equal(migrated.rule.contentMode, 'metadata_only');
    assert.equal(migrated.metric.content_source, null);
    assert.equal(Number(migrated.metric.metadata_request_count), 0);
    assert.equal(Number(migrated.metric.original_pdf_request_count), 0);
    assert.equal(Number(migrated.projectionVersion), 1);
    assert.equal(migrated.people.total, 1);
    assert.equal(migrated.people.people[0].key, 'deirdre kelly');
    assert.deepEqual(migrated.committeeProjection, [
      {
        doc_id: 'legacy-committee-2',
        person_key: 'priority person',
        affiliation: 'API University',
        source: 'api',
      },
      {
        doc_id: 'legacy-committee-3',
        person_key: 'newest person',
        affiliation: 'New Affiliation',
        source: 'pdf',
      },
    ]);
    assert.equal(migrated.committeeState, 'complete');
    assert.deepEqual(migrated.rolloutTables, ['enrichment_rollout_evidence', 'enrichment_rollouts']);
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
