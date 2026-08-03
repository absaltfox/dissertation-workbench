import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@libsql/client';
import { SQLITE_PATH, PDF_CACHE_DIR, FULL_TEXT_CACHE_DIR, TURSO_AUTH_TOKEN, TURSO_DATABASE_URL } from './config.js';
import { logger } from './logger.js';
import { dedupeSupervisorNames, normalizePersonName, stripMiddleInitials, supervisorNameKey } from './supervisors.js';
import { encryptMfaSecret, decryptMfaSecret } from './secretCrypto.js';
import { jaroWinkler } from './fuzzyMatch.js';
import { documentThemeTerms } from './nlp.js';
import { normalizeImportRule } from './importRules.js';

let db;
let schemaReady;

export function getDatabaseUrl() {
  return (TURSO_DATABASE_URL || `file:${SQLITE_PATH}`).trim();
}

export async function ensureStorage() {
  await fs.mkdir(PDF_CACHE_DIR, { recursive: true });
  await fs.mkdir(FULL_TEXT_CACHE_DIR, { recursive: true });
  await verifyWritableDirectory(PDF_CACHE_DIR);
  await verifyWritableDirectory(FULL_TEXT_CACHE_DIR);
  if (!TURSO_DATABASE_URL) {
    await fs.mkdir(path.dirname(SQLITE_PATH), { recursive: true });
    await verifyWritableDirectory(path.dirname(SQLITE_PATH));
  }
}

async function verifyWritableDirectory(dir) {
  const filePath = path.join(dir, `.write-test-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(filePath, '');
    await fs.unlink(filePath);
  } catch (error) {
    throw new Error(`Storage directory is not writable: ${dir} (${error?.message || String(error)})`);
  }
}

export async function getDb() {
  if (!db) {
    db = createClient({
      url: getDatabaseUrl(),
      authToken: TURSO_AUTH_TOKEN,
    });
  }
  if (!schemaReady) {
    schemaReady = ensureSchema(db);
  }
  await schemaReady;
  return db;
}

export async function closeDb() {
  if (db) {
    await db.close();
    db = undefined;
    schemaReady = undefined;
  }
}


function changes(result) {
  return Number(result?.rowsAffected ?? result?.changes ?? 0);
}

async function execute(sql, args = []) {
  const client = await getDb();
  return client.execute({ sql, args });
}

async function run(sql, args = []) {
  const result = await execute(sql, args);
  return { changes: changes(result) };
}

async function get(sql, args = []) {
  const result = await execute(sql, args);
  return result.rows[0] || null;
}

async function all(sql, args = []) {
  const result = await execute(sql, args);
  return result.rows;
}

async function exec(sql) {
  const client = await getDb();
  await client.executeMultiple(sql);
}

async function tryExec(client, sql) {
  try {
    await client.executeMultiple(sql);
  } catch {
    // Migration already applied or unsupported in the current database.
  }
}

export async function addColumnIfMissing(client, table, column, definition) {
  const hasColumn = async () => {
    const result = await client.execute(`PRAGMA table_info(${table})`);
    return result.rows.some((row) => String(row.name) === column);
  };
  if (await hasColumn()) return;
  try {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    // Another web/worker process may have applied the same idempotent migration
    // after our schema read. Accept only that verified outcome; all other errors
    // remain startup failures.
    if (await hasColumn()) return;
    throw error;
  }
}

async function ensureSchema(client) {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS documents (
      doc_id TEXT PRIMARY KEY,
      metadata_json TEXT NOT NULL,
      sync_key TEXT,
      title TEXT,
      author TEXT,
      year INTEGER,
      degree TEXT,
      program TEXT,
      source_json TEXT,
      source_updated_at TEXT,
      synced_at TEXT,
      serving_projection_version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_metrics (
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
      content_source TEXT,
      content_checksum TEXT,
      content_source_url TEXT,
      content_retrieved_at TEXT,
      parser_version TEXT,
      metadata_request_count INTEGER DEFAULT 0,
      full_text_request_count INTEGER DEFAULT 0,
      original_pdf_request_count INTEGER DEFAULT 0,
      retrieved_bytes INTEGER DEFAULT 0,
      status TEXT,
      error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_people (
      doc_id TEXT NOT NULL,
      person_key TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      affiliation TEXT,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (doc_id, person_key, role, source)
    );

    CREATE TABLE IF NOT EXISTS serving_projection_state (
      projection_key TEXT PRIMARY KEY,
      projection_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metric_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_key TEXT NOT NULL,
      source_json TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_key TEXT NOT NULL,
      source_json TEXT NOT NULL,
      status TEXT NOT NULL,
      total_seen INTEGER NOT NULL DEFAULT 0,
      total_saved INTEGER NOT NULL DEFAULT 0,
      api_total INTEGER,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      params_json TEXT,
      result_json TEXT,
      log TEXT,
      error TEXT,
      runner_type TEXT,
      runner_id TEXT,
      runner_state TEXT,
      heartbeat_at TEXT,
      timeout_at TEXT,
      cancelled_at TEXT,
      artifact_token_hash TEXT,
      claimed_at TEXT,
      progress_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      first_name TEXT,
      last_name TEXT,
      email TEXT,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      mfa_secret TEXT,
      mfa_enabled INTEGER NOT NULL DEFAULT 0,
      mfa_enabled_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      FOREIGN KEY (username) REFERENCES users(username)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS import_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      degree TEXT,
      program TEXT,
      affiliation TEXT,
      requested_index TEXT,
      query TEXT,
      source TEXT,
      content_mode TEXT NOT NULL DEFAULT 'metadata_only',
      content_fallback TEXT NOT NULL DEFAULT 'fail_document',
      extract_citations INTEGER NOT NULL DEFAULT 0,
      extract_committee INTEGER NOT NULL DEFAULT 1,
      run_concepts INTEGER NOT NULL DEFAULT 1,
      max_content_bytes INTEGER NOT NULL DEFAULT 209715200,
      content_concurrency INTEGER NOT NULL DEFAULT 1,
      content_rate_limit INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS import_rule_request_limits (
      rule_id TEXT PRIMARY KEY,
      timestamps_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      FOREIGN KEY (rule_id) REFERENCES import_rules(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS enrichment_rollouts (
      rule_id TEXT PRIMARY KEY,
      rule_revision TEXT,
      status TEXT NOT NULL,
      current_phase TEXT,
      current_job_id INTEGER,
      sample_job_id INTEGER,
      control_job_id INTEGER,
      last_cohort_job_id INTEGER,
      evaluation_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS enrichment_rollout_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      job_id INTEGER NOT NULL,
      doc_id TEXT NOT NULL,
      content_mode TEXT NOT NULL,
      rule_revision TEXT,
      outcome_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(job_id, doc_id)
    );

    CREATE TABLE IF NOT EXISTS committee_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT,
      affiliation TEXT,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(doc_id, name, role)
    );

    CREATE TABLE IF NOT EXISTS citations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      citation_hash TEXT UNIQUE NOT NULL,
      citation_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_citations (
      doc_id TEXT NOT NULL,
      citation_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (doc_id, citation_id),
      FOREIGN KEY (citation_id) REFERENCES citations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_document_citations_doc_id ON document_citations(doc_id);
    CREATE INDEX IF NOT EXISTS idx_document_citations_citation_id ON document_citations(citation_id);
    CREATE INDEX IF NOT EXISTS idx_document_citations_citation_doc ON document_citations(citation_id, doc_id);

    CREATE TABLE IF NOT EXISTS catalogue_lookups (
      citation_id INTEGER PRIMARY KEY,
      hits INTEGER,
      query_author TEXT,
      query_title TEXT,
      looked_up_at TEXT NOT NULL,
      FOREIGN KEY (citation_id) REFERENCES citations(id)
    );

    CREATE TABLE IF NOT EXISTS topics (
      topic_id    INTEGER PRIMARY KEY,
      label       TEXT NOT NULL,
      top_terms   TEXT NOT NULL,
      doc_count   INTEGER NOT NULL,
      model_name  TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS topic_label_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      backend      TEXT NOT NULL,
      model_name   TEXT NOT NULL,
      status       TEXT NOT NULL,
      config_json  TEXT,
      error        TEXT,
      started_at   TEXT NOT NULL,
      finished_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS topic_label_candidates (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        INTEGER,
      topic_id      INTEGER NOT NULL,
      label         TEXT NOT NULL,
      source        TEXT NOT NULL,
      score         REAL NOT NULL DEFAULT 0,
      status        TEXT NOT NULL,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES topic_label_runs(id)
    );

    CREATE TABLE IF NOT EXISTS topic_label_overrides (
      topic_id     INTEGER PRIMARY KEY,
      label        TEXT NOT NULL,
      source       TEXT NOT NULL,
      candidate_id INTEGER,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_topic_label_candidates_topic ON topic_label_candidates(topic_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_topic_label_candidates_run ON topic_label_candidates(run_id);
    CREATE INDEX IF NOT EXISTS idx_topic_label_candidates_status ON topic_label_candidates(status);

    CREATE TABLE IF NOT EXISTS document_topics (
      doc_id      TEXT NOT NULL,
      topic_id    INTEGER NOT NULL,
      probability REAL,
      PRIMARY KEY (doc_id, topic_id)
    );

    CREATE TABLE IF NOT EXISTS document_topic_coords (
      doc_id  TEXT PRIMARY KEY,
      umap_x  REAL NOT NULL,
      umap_y  REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS topic_hierarchy_meta (
      id              INTEGER PRIMARY KEY DEFAULT 1,
      leaf_topic_ids  TEXT NOT NULL,
      linkage_json    TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_embeddings (
      doc_id      TEXT PRIMARY KEY,
      embedding   TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS concept_partitions (
      partition_key        TEXT PRIMARY KEY,
      scope_json           TEXT NOT NULL,
      priority             INTEGER NOT NULL DEFAULT 0,
      enabled              INTEGER NOT NULL DEFAULT 1,
      status               TEXT NOT NULL DEFAULT 'pending',
      source_document_count INTEGER NOT NULL DEFAULT 0,
      source_updated_at    TEXT,
      checkpoint_json      TEXT,
      artifact_version     INTEGER NOT NULL DEFAULT 0,
      last_started_at      TEXT,
      last_completed_at    TEXT,
      error                TEXT,
      updated_at           TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS concept_document_state (
      partition_key   TEXT NOT NULL,
      doc_id          TEXT NOT NULL,
      content_checksum TEXT NOT NULL,
      candidates_json TEXT NOT NULL,
      embedding_json  TEXT NOT NULL,
      model_name      TEXT NOT NULL,
      processed_at    TEXT NOT NULL,
      PRIMARY KEY (partition_key, doc_id)
    );

    CREATE TABLE IF NOT EXISTS concept_phrase_embeddings (
      model_name     TEXT NOT NULL,
      phrase         TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (model_name, phrase)
    );

    CREATE TABLE IF NOT EXISTS concept_partition_artifacts (
      partition_key TEXT NOT NULL,
      version       INTEGER NOT NULL,
      artifact_json TEXT NOT NULL,
      document_count INTEGER NOT NULL,
      created_at    TEXT NOT NULL,
      PRIMARY KEY (partition_key, version)
    );

    CREATE TABLE IF NOT EXISTS concept_partition_candidates (
      partition_key      TEXT NOT NULL,
      phrase             TEXT NOT NULL,
      document_frequency INTEGER NOT NULL,
      PRIMARY KEY (partition_key, phrase)
    );

    CREATE TABLE IF NOT EXISTS concept_publication_state (
      id                  INTEGER PRIMARY KEY,
      published_signature TEXT,
      published_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS citation_extraction_state (
      doc_id           TEXT PRIMARY KEY,
      content_checksum TEXT,
      parser_version   TEXT NOT NULL,
      status           TEXT NOT NULL,
      citation_count   INTEGER NOT NULL DEFAULT 0,
      error            TEXT,
      extracted_at     TEXT NOT NULL
    );
  `);

  await tryExec(client, 'ALTER TABLE catalogue_lookups ADD COLUMN bib_id TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN runner_type TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN runner_id TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN runner_state TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN heartbeat_at TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN timeout_at TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN cancelled_at TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN artifact_token_hash TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN claimed_at TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN progress_json TEXT');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN sync_key TEXT');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN title TEXT');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN author TEXT');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN year INTEGER');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN degree TEXT');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN program TEXT');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN source_json TEXT');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN source_updated_at TEXT');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN synced_at TEXT');
  await addColumnIfMissing(client, 'documents', 'serving_projection_version', 'INTEGER NOT NULL DEFAULT 0');
  await tryExec(client, 'ALTER TABLE users ADD COLUMN mfa_secret TEXT');
  await tryExec(client, 'ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0');
  await tryExec(client, 'ALTER TABLE users ADD COLUMN mfa_enabled_at TEXT');
  await tryExec(client, 'ALTER TABLE users ADD COLUMN first_name TEXT');
  await tryExec(client, 'ALTER TABLE users ADD COLUMN last_name TEXT');
  await tryExec(client, 'ALTER TABLE users ADD COLUMN email TEXT');
  await tryExec(client, 'ALTER TABLE citations ADD COLUMN author TEXT');
  await tryExec(client, 'ALTER TABLE citations ADD COLUMN title TEXT');
  await tryExec(client, 'ALTER TABLE citations ADD COLUMN year TEXT');
  await tryExec(client, 'ALTER TABLE citations ADD COLUMN source TEXT');
  await tryExec(client, 'ALTER TABLE file_metrics ADD COLUMN body_word_count INTEGER');
  await tryExec(client, 'ALTER TABLE file_metrics ADD COLUMN full_text_path TEXT');
  await tryExec(client, 'ALTER TABLE file_metrics ADD COLUMN full_text_bytes INTEGER');
  await tryExec(client, 'ALTER TABLE file_metrics ADD COLUMN full_text_source_url TEXT');
  await addColumnIfMissing(client, 'file_metrics', 'content_source', 'TEXT');
  await addColumnIfMissing(client, 'file_metrics', 'content_checksum', 'TEXT');
  await addColumnIfMissing(client, 'file_metrics', 'content_source_url', 'TEXT');
  await addColumnIfMissing(client, 'file_metrics', 'content_retrieved_at', 'TEXT');
  await addColumnIfMissing(client, 'file_metrics', 'parser_version', 'TEXT');
  await addColumnIfMissing(client, 'file_metrics', 'metadata_request_count', 'INTEGER DEFAULT 0');
  await addColumnIfMissing(client, 'file_metrics', 'full_text_request_count', 'INTEGER DEFAULT 0');
  await addColumnIfMissing(client, 'file_metrics', 'original_pdf_request_count', 'INTEGER DEFAULT 0');
  await addColumnIfMissing(client, 'file_metrics', 'retrieved_bytes', 'INTEGER DEFAULT 0');
  await addColumnIfMissing(client, 'import_rules', 'content_mode', "TEXT NOT NULL DEFAULT 'metadata_only'");
  await addColumnIfMissing(client, 'import_rules', 'content_fallback', "TEXT NOT NULL DEFAULT 'fail_document'");
  await addColumnIfMissing(client, 'import_rules', 'extract_citations', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing(client, 'import_rules', 'extract_committee', 'INTEGER NOT NULL DEFAULT 1');
  await addColumnIfMissing(client, 'import_rules', 'run_concepts', 'INTEGER NOT NULL DEFAULT 1');
  await addColumnIfMissing(client, 'import_rules', 'max_content_bytes', 'INTEGER NOT NULL DEFAULT 209715200');
  await addColumnIfMissing(client, 'import_rules', 'content_concurrency', 'INTEGER NOT NULL DEFAULT 1');
  await addColumnIfMissing(client, 'import_rules', 'content_rate_limit', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing(client, 'enrichment_rollouts', 'rule_revision', 'TEXT');
  await addColumnIfMissing(client, 'enrichment_rollout_evidence', 'rule_revision', 'TEXT');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_documents_sync_key ON documents(sync_key)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_documents_year ON documents(year)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_documents_degree ON documents(degree)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_documents_program ON documents(program)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_document_people_key ON document_people(person_key)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_document_people_role ON document_people(role)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_concept_partitions_priority ON concept_partitions(enabled, priority DESC, updated_at)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_concept_document_state_doc ON concept_document_state(doc_id)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_concept_partition_artifacts_latest ON concept_partition_artifacts(partition_key, version DESC)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_concept_partition_candidates_phrase ON concept_partition_candidates(phrase, partition_key)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_citation_extraction_status ON citation_extraction_state(status, extracted_at)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_import_rules_updated_at ON import_rules(updated_at)');
  await client.execute('CREATE INDEX IF NOT EXISTS idx_enrichment_evidence_rule_phase ON enrichment_rollout_evidence(rule_id, phase, job_id)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_username ON password_reset_tokens(username)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON password_reset_tokens(expires_at)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_document_citations_citation_id ON document_citations(citation_id)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_document_citations_citation_doc ON document_citations(citation_id, doc_id)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_catalogue_lookups_hits_query_title ON catalogue_lookups(hits, query_title)');

  const cleaned = await cleanupCommitteeArtifacts(client);
  if (cleaned > 0) logger.info(`Cleaned up ${cleaned} committee artefact rows`);
  await backfillDocumentPeopleProjection(client);
}

export async function cleanupCommitteeArtifacts(dbInstance = null) {
  const client = dbInstance || await getDb();
  const artifactNames = `
      'additional supervisory committee members:',
      'additional supervisory committee members',
      'examining committee members',
      'examining committee',
      'supervisory committee members',
      'supervisory committee',
      'committee members'
  `;
  const result = await client.execute(`
    DELETE FROM committee_members
    WHERE lower(name) IN (${artifactNames})
  `);
  await client.execute(`DELETE FROM document_people WHERE lower(name) IN (${artifactNames})`);
  return changes(result);
}

// --- Document functions ---

function documentColumns(doc, syncKey = null, source = null) {
  return {
    syncKey,
    title: doc.title || null,
    author: doc.author || null,
    year: doc.year ?? null,
    degree: doc.degree || null,
    program: doc.program || null,
    sourceJson: source ? JSON.stringify(source) : null,
    sourceUpdatedAt: source?.sourceUpdatedAt || source?.updatedAt || null,
  };
}

function withStoredThemes(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const themes = Array.isArray(doc.themes)
    ? doc.themes.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (themes.length) return doc;
  return {
    ...doc,
    themes: documentThemeTerms(doc, 12),
  };
}

function documentPersonKey(name) {
  const normalized = supervisorNameKey(name);
  return normalized ? stripMiddleInitials(normalized) : '';
}

function authoritativeCommitteeRow(rows, personKey) {
  return (rows || [])
    .filter((row) => documentPersonKey(row.name) === personKey)
    .sort((left, right) => {
      const sourceRank = Number(right.source === 'api') - Number(left.source === 'api');
      if (sourceRank) return sourceRank;
      const updatedRank = String(right.updated_at || '').localeCompare(String(left.updated_at || ''));
      return updatedRank || Number(right.id || 0) - Number(left.id || 0);
    })[0] || null;
}

function metadataPeopleStatements(doc, now = new Date().toISOString()) {
  const statements = [{
    sql: "DELETE FROM document_people WHERE doc_id = ? AND source = 'metadata'",
    args: [doc.id],
  }];
  const names = dedupeSupervisorNames(Array.isArray(doc.supervisors) ? doc.supervisors : []);
  for (const name of names) {
    const key = documentPersonKey(name);
    if (!key) continue;
    statements.push({
      sql: `
        INSERT INTO document_people (doc_id, person_key, name, role, affiliation, source, updated_at)
        VALUES (?, ?, ?, 'Supervisor', NULL, 'metadata', ?)
        ON CONFLICT(doc_id, person_key, role, source) DO UPDATE SET
          name = excluded.name,
          updated_at = excluded.updated_at
      `,
      args: [doc.id, key, name, now],
    });
  }
  return statements;
}

async function backfillDocumentPeopleProjection(client) {
  let total = 0;
  while (true) {
    const result = await client.execute(`
      SELECT doc_id, metadata_json
      FROM documents
      WHERE serving_projection_version < 1
      ORDER BY doc_id
      LIMIT 500
    `);
    if (!result.rows.length) break;
    const statements = [];
    const now = new Date().toISOString();
    for (const row of result.rows) {
      let doc = null;
      try { doc = JSON.parse(row.metadata_json); } catch { doc = { id: row.doc_id, supervisors: [] }; }
      doc.id ||= row.doc_id;
      statements.push(...metadataPeopleStatements(doc, now));
      statements.push({
        sql: 'UPDATE documents SET serving_projection_version = 1 WHERE doc_id = ?',
        args: [row.doc_id],
      });
    }
    await client.batch(statements, 'write');
    total += result.rows.length;
  }
  if (total) logger.info('Backfilled metadata-serving people projection', { documents: total });

  const state = await client.execute({
    sql: 'SELECT projection_value FROM serving_projection_state WHERE projection_key = ?',
    args: ['committee_people'],
  });
  const savedCommitteeState = String(state.rows[0]?.projection_value || '');
  if (savedCommitteeState === '1' || savedCommitteeState === 'complete') return;
  let cursor = savedCommitteeState.startsWith('cursor:')
    ? Math.max(0, Number(savedCommitteeState.slice('cursor:'.length)) || 0)
    : 0;
  let committeeRows = 0;
  while (true) {
    const transaction = await client.transaction('write');
    try {
      const result = await transaction.execute({
        sql: `
          SELECT id, doc_id, name, role, affiliation, source, updated_at
          FROM committee_members
          WHERE id > ?
          ORDER BY id
          LIMIT 500
        `,
        args: [cursor],
      });
      if (!result.rows.length) {
        await transaction.commit();
        break;
      }
      const statements = [];
      const relationships = new Map();
      for (const row of result.rows) {
        cursor = Number(row.id);
        const key = documentPersonKey(row.name);
        if (!key) continue;
        const role = row.role || 'Committee Member';
        relationships.set(`${row.doc_id}\u0000${key}\u0000${role}`, {
          docId: row.doc_id, personKey: key, role,
        });
      }
      for (const { docId, personKey, role } of relationships.values()) {
        const candidates = await transaction.execute({
          sql: `SELECT id, name, role, affiliation, source, updated_at
                FROM committee_members
                WHERE doc_id = ? AND COALESCE(role, 'Committee Member') = ?`,
          args: [docId, role],
        });
        const winner = authoritativeCommitteeRow(candidates.rows, personKey);
        statements.push({
          sql: `
            DELETE FROM document_people
            WHERE doc_id = ? AND person_key = ? AND role = ? AND source <> 'metadata'
          `,
          args: [docId, personKey, role],
        });
        if (winner) statements.push({
          sql: `
            INSERT INTO document_people (doc_id, person_key, name, role, affiliation, source, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          args: [
            docId, personKey, winner.name, winner.role || 'Committee Member',
            winner.affiliation || null, winner.source || 'committee', winner.updated_at,
          ],
        });
      }
      statements.push({
        sql: `
          INSERT INTO serving_projection_state (projection_key, projection_value, updated_at)
          VALUES ('committee_people', ?, ?)
          ON CONFLICT(projection_key) DO UPDATE SET
            projection_value = excluded.projection_value,
            updated_at = excluded.updated_at
        `,
        args: [`cursor:${cursor}`, new Date().toISOString()],
      });
      await transaction.batch(statements);
      await transaction.commit();
      committeeRows += result.rows.length;
    } catch (error) {
      await transaction.rollback().catch(() => {});
      throw error;
    } finally {
      transaction.close();
    }
  }
  await client.execute({
    sql: `
      INSERT INTO serving_projection_state (projection_key, projection_value, updated_at)
      VALUES ('committee_people', 'complete', ?)
      ON CONFLICT(projection_key) DO UPDATE SET
        projection_value = excluded.projection_value,
        updated_at = excluded.updated_at
    `,
    args: [new Date().toISOString()],
  });
  if (committeeRows) logger.info('Backfilled committee people projection', { rows: committeeRows });
}

export async function saveDocumentMetadata(doc, { syncKey = null, source = null } = {}) {
  doc = withStoredThemes(doc);
  const now = new Date().toISOString();
  const client = await getDb();
  await client.batch([
    saveDocumentStatement(doc, { syncKey, source }, now),
    ...metadataPeopleStatements(doc, now),
  ], 'write');
}

function saveDocumentStatement(doc, { syncKey = null, source = null } = {}, now = new Date().toISOString()) {
  doc = withStoredThemes(doc);
  const cols = documentColumns(doc, syncKey, source);
  return {
    sql: `
      INSERT INTO documents (
        doc_id, metadata_json, sync_key, title, author, year, degree, program,
        source_json, source_updated_at, synced_at, serving_projection_version, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(doc_id) DO UPDATE SET
        metadata_json = excluded.metadata_json,
        sync_key = COALESCE(excluded.sync_key, documents.sync_key),
        title = excluded.title,
        author = excluded.author,
        year = excluded.year,
        degree = excluded.degree,
        program = excluded.program,
        source_json = COALESCE(excluded.source_json, documents.source_json),
        source_updated_at = COALESCE(excluded.source_updated_at, documents.source_updated_at),
        synced_at = COALESCE(excluded.synced_at, documents.synced_at),
        serving_projection_version = excluded.serving_projection_version,
        updated_at = excluded.updated_at
    `,
    args: [
      doc.id, JSON.stringify(doc), cols.syncKey, cols.title, cols.author, cols.year,
      cols.degree, cols.program, cols.sourceJson, cols.sourceUpdatedAt,
      syncKey ? now : null, now
    ]
  };
}

export async function saveDocumentMetadataBatch(items) {
  const cleaned = (items || []).filter((item) => item?.doc?.id);
  if (!cleaned.length) return 0;
  const now = new Date().toISOString();
  const client = await getDb();
  await client.batch(
    cleaned.flatMap((item) => {
      const doc = withStoredThemes(item.doc);
      return [
        saveDocumentStatement(doc, {
          syncKey: item.syncKey || null,
          source: item.source || null,
        }, now),
        ...metadataPeopleStatements(doc, now),
      ];
    }),
    'write'
  );
  return cleaned.length;
}

export async function loadDocumentMetadata(docId) {
  const row = await get('SELECT metadata_json FROM documents WHERE doc_id = ?', [docId]);
  if (!row) return null;
  try { return JSON.parse(row.metadata_json); } catch { return null; }
}

export async function documentExists(docId) {
  if (!docId) return false;
  const row = await get('SELECT 1 AS found FROM documents WHERE doc_id = ? LIMIT 1', [docId]);
  return Boolean(row);
}

export async function listAllDocumentMetadata() {
  const rows = await all('SELECT doc_id, metadata_json FROM documents');
  return rows.map((row) => {
    try {
      return { docId: row.doc_id, metadata: JSON.parse(row.metadata_json) };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export async function recomputeStoredDocumentThemes({ limit = null, docIds = null, onProgress = null } = {}) {
  let rows;
  const requestedIds = Array.isArray(docIds) ? docIds.map((id) => String(id || '').trim()).filter(Boolean) : [];
  if (requestedIds.length) {
    rows = [];
    const chunkSize = 999;
    for (let i = 0; i < requestedIds.length; i += chunkSize) {
      const chunk = requestedIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      rows.push(...await all(`SELECT doc_id, metadata_json FROM documents WHERE doc_id IN (${placeholders}) ORDER BY doc_id`, chunk));
    }
  } else {
    rows = await all('SELECT doc_id, metadata_json FROM documents ORDER BY doc_id');
  }
  const max = limit == null ? rows.length : Math.min(Number(limit) || 0, rows.length);
  const client = await getDb();
  let processed = 0;
  let updated = 0;
  let failed = 0;
  for (const row of rows.slice(0, max)) {
    processed += 1;
    try {
      const doc = JSON.parse(row.metadata_json);
      const next = { ...doc, themes: documentThemeTerms(doc, 12) };
      await client.execute({
        sql: 'UPDATE documents SET metadata_json = ?, updated_at = ? WHERE doc_id = ?',
        args: [JSON.stringify(next), new Date().toISOString(), row.doc_id],
      });
      updated += 1;
    } catch {
      failed += 1;
    }
    if (onProgress && (processed === max || processed % 50 === 0)) {
      await onProgress({ processed, total: max, updated, failed });
    }
  }
  return { processed, total: max, updated, failed };
}

export async function listCachedDocuments({ syncKey, limit = null, offset = 0 } = {}) {
  const args = [];
  let sql = `
    SELECT d.doc_id, d.metadata_json,
           fm.download_url, fm.file_bytes, fm.word_count, fm.body_word_count,
           fm.page_count, fm.word_source, fm.page_source, fm.status, fm.error
    FROM documents d
    LEFT JOIN file_metrics fm ON fm.doc_id = d.doc_id
  `;
  if (syncKey) {
    sql += ' WHERE d.sync_key = ?';
    args.push(syncKey);
  }
  sql += ' ORDER BY d.year DESC, d.title';
  if (limit != null) {
    sql += ' LIMIT ? OFFSET ?';
    args.push(limit, offset);
  }
  const rows = await all(sql, args);
  return rows.map((row) => {
    try {
      const doc = JSON.parse(row.metadata_json);
      return applyStoredFileMetricToDocument(doc, row);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function affiliationFilterValues(raw) {
  const value = String(raw || '').trim().toLowerCase();
  const groups = [
    ['ubc', 'university of british columbia', 'the university of british columbia'],
    ['sfu', 'simon fraser university'],
    ['uvic', 'university of victoria'],
    ['tru', 'thompson rivers university'],
    ['rru', 'royal roads university'],
  ];
  return groups.find((group) => group.includes(value)) || [value];
}

function documentServingFilters({ syncKey = null, degree = '', program = '', affiliation = '', q = '' } = {}) {
  const clauses = [];
  const args = [];
  if (syncKey) {
    clauses.push('d.sync_key = ?');
    args.push(syncKey);
  }
  if (degree) {
    clauses.push('d.degree = ?');
    args.push(degree);
  }
  if (program) {
    clauses.push('d.program = ?');
    args.push(program);
  }
  if (affiliation) {
    const values = affiliationFilterValues(affiliation);
    clauses.push(`EXISTS (
      SELECT 1 FROM json_each(d.metadata_json, '$.affiliation') affiliation
      WHERE lower(trim(CAST(affiliation.value AS TEXT))) IN (${values.map(() => '?').join(', ')})
    )`);
    args.push(...values);
  }
  if (q) {
    const pattern = `%${String(q).toLowerCase()}%`;
    clauses.push(`(
      lower(COALESCE(d.title, '')) LIKE ? OR
      lower(COALESCE(d.author, '')) LIKE ? OR
      lower(COALESCE(d.degree, '')) LIKE ? OR
      lower(COALESCE(d.program, '')) LIKE ? OR
      CAST(d.year AS TEXT) LIKE ? OR
      EXISTS (
        SELECT 1 FROM json_each(d.metadata_json, '$.supervisors') supervisor
        WHERE lower(CAST(supervisor.value AS TEXT)) LIKE ?
      )
    )`);
    args.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }
  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    args,
  };
}

const DOCUMENT_PAGE_SORTS = {
  title: 'lower(COALESCE(d.title, \'\'))',
  author: 'lower(COALESCE(d.author, \'\'))',
  year: 'COALESCE(d.year, 0)',
  degree: 'lower(COALESCE(d.degree, \'\'))',
  pages: 'COALESCE(fm.page_count, 0)',
  wordCount: 'COALESCE(fm.word_count, 0)',
  citationCount: 'COALESCE(dc.citation_count, 0)',
};

/**
 * Database-backed document pagination. Filtering, sorting, citation counts,
 * and LIMIT/OFFSET all happen before metadata JSON reaches the web process.
 */
export async function queryCachedDocumentPage({
  syncKey = null, filters = {}, q = '', sortKey = '', sortDir = 'asc', limit = 50, offset = 0,
} = {}) {
  const queryFilters = documentServingFilters({ syncKey, ...filters, q });
  const countRow = await get(`SELECT COUNT(*) AS total FROM documents d ${queryFilters.where}`, queryFilters.args);
  const sortExpression = DOCUMENT_PAGE_SORTS[sortKey] || 'COALESCE(d.year, 0)';
  const direction = sortKey ? (sortDir === 'asc' ? 'ASC' : 'DESC') : 'DESC';
  const rows = await all(`
    SELECT d.doc_id, d.metadata_json,
           fm.download_url, fm.file_bytes, fm.word_count, fm.body_word_count,
           fm.page_count, fm.word_source, fm.page_source, fm.status, fm.error,
           COALESCE(dc.citation_count, 0) AS citation_count
    FROM documents d
    LEFT JOIN file_metrics fm ON fm.doc_id = d.doc_id
    LEFT JOIN (
      SELECT doc_id, COUNT(*) AS citation_count
      FROM document_citations
      GROUP BY doc_id
    ) dc ON dc.doc_id = d.doc_id
    ${queryFilters.where}
    ORDER BY ${sortExpression} ${direction}, lower(COALESCE(d.title, '')) ASC, d.doc_id ASC
    LIMIT ? OFFSET ?
  `, [...queryFilters.args, Math.max(1, Number(limit) || 50), Math.max(0, Number(offset) || 0)]);
  const documents = rows.map((row) => {
    try {
      const doc = applyStoredFileMetricToDocument(JSON.parse(row.metadata_json), row);
      doc.citationCount = Number(row.citation_count || 0);
      return doc;
    } catch {
      return null;
    }
  }).filter(Boolean);
  return { total: Number(countRow?.total || 0), documents };
}

/** A bounded document page restricted to documents with persisted topic assignments. */
export async function queryTopicDocumentPage({
  syncKey = null, filters = {}, limit = 5000, offset = 0,
} = {}) {
  const queryFilters = documentServingFilters({ syncKey, ...filters });
  const topicJoin = 'JOIN (SELECT DISTINCT doc_id FROM document_topics) dt ON dt.doc_id = d.doc_id';
  const countRow = await get(`
    SELECT COUNT(*) AS total
    FROM documents d
    ${topicJoin}
    ${queryFilters.where}
  `, queryFilters.args);
  const rows = await all(`
    SELECT d.doc_id, d.metadata_json,
           fm.download_url, fm.file_bytes, fm.word_count, fm.body_word_count,
           fm.page_count, fm.word_source, fm.page_source, fm.status, fm.error,
           COALESCE(dc.citation_count, 0) AS citation_count
    FROM documents d
    ${topicJoin}
    LEFT JOIN file_metrics fm ON fm.doc_id = d.doc_id
    LEFT JOIN (
      SELECT doc_id, COUNT(*) AS citation_count
      FROM document_citations
      GROUP BY doc_id
    ) dc ON dc.doc_id = d.doc_id
    ${queryFilters.where}
    ORDER BY COALESCE(d.year, 0) DESC, lower(COALESCE(d.title, '')) ASC, d.doc_id ASC
    LIMIT ? OFFSET ?
  `, [...queryFilters.args, Math.max(1, Number(limit) || 5000), Math.max(0, Number(offset) || 0)]);
  const documents = rows.map((row) => {
    try {
      const doc = applyStoredFileMetricToDocument(JSON.parse(row.metadata_json), row);
      doc.citationCount = Number(row.citation_count || 0);
      return doc;
    } catch {
      return null;
    }
  }).filter(Boolean);
  return { total: Number(countRow?.total || 0), documents };
}

/** Small, database-side bootstrap aggregates for metadata-scale landing pages. */
export async function getDocumentServingSummary({ syncKey = null } = {}) {
  const filters = documentServingFilters({ syncKey });
  const [summary, degrees, programs, affiliations, supervisors] = await Promise.all([
    get(`SELECT COUNT(*) AS documents FROM documents d ${filters.where}`, filters.args),
    all(`SELECT DISTINCT d.degree AS value FROM documents d ${filters.where ? `${filters.where} AND` : 'WHERE'} d.degree IS NOT NULL AND trim(d.degree) <> '' ORDER BY value`, filters.args),
    all(`SELECT DISTINCT d.program AS value FROM documents d ${filters.where ? `${filters.where} AND` : 'WHERE'} d.program IS NOT NULL AND trim(d.program) <> '' ORDER BY value`, filters.args),
    all(`
      SELECT DISTINCT trim(CAST(affiliation.value AS TEXT)) AS value
      FROM documents d, json_each(d.metadata_json, '$.affiliation') affiliation
      ${filters.where}
      ${filters.where ? 'AND' : 'WHERE'} trim(CAST(affiliation.value AS TEXT)) <> ''
      ORDER BY value
    `, filters.args),
    get(`
      SELECT COUNT(DISTINCT p.person_key) AS count
      FROM document_people p
      JOIN documents d ON d.doc_id = p.doc_id
      ${filters.where}
      ${filters.where ? 'AND' : 'WHERE'} p.source = 'metadata' AND p.role = 'Supervisor'
    `, filters.args),
  ]);
  return {
    documents: Number(summary?.documents || 0),
    supervisors: Number(supervisors?.count || 0),
    facets: {
      degree: degrees.map((row) => row.value).filter(Boolean),
      program: programs.map((row) => row.value).filter(Boolean),
      affiliation: affiliations.map((row) => row.value).filter(Boolean),
    },
  };
}

export async function queryCitationDocumentPage({
  syncKey = null, filters = {}, q = '', sortKey = 'citationCount', sortDir = 'desc', limit = 50, offset = 0,
} = {}) {
  const queryFilters = documentServingFilters({ syncKey, ...filters, q });
  const counts = await get(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN COALESCE(dc.citation_count, 0) > 0 THEN 1 ELSE 0 END) AS with_citations
    FROM documents d
    LEFT JOIN (SELECT doc_id, COUNT(*) AS citation_count FROM document_citations GROUP BY doc_id) dc
      ON dc.doc_id = d.doc_id
    ${queryFilters.where}
  `, queryFilters.args);
  const sortExpression = DOCUMENT_PAGE_SORTS[sortKey] || DOCUMENT_PAGE_SORTS.citationCount;
  const direction = sortDir === 'asc' ? 'ASC' : 'DESC';
  const rows = await all(`
    SELECT d.doc_id, d.title, d.author, d.year, COALESCE(dc.citation_count, 0) AS citation_count
    FROM documents d
    LEFT JOIN (SELECT doc_id, COUNT(*) AS citation_count FROM document_citations GROUP BY doc_id) dc
      ON dc.doc_id = d.doc_id
    LEFT JOIN file_metrics fm ON fm.doc_id = d.doc_id
    ${queryFilters.where}
    ORDER BY ${sortExpression} ${direction}, lower(COALESCE(d.title, '')) ASC, d.doc_id ASC
    LIMIT ? OFFSET ?
  `, [...queryFilters.args, Math.max(1, Number(limit) || 50), Math.max(0, Number(offset) || 0)]);
  return {
    total: Number(counts?.total || 0),
    withCitations: Number(counts?.with_citations || 0),
    documents: rows.map((row) => ({
      id: row.doc_id,
      title: row.title || '',
      author: row.author || '',
      year: row.year == null ? null : Number(row.year),
      citationCount: Number(row.citation_count || 0),
    })),
  };
}

function numericStats(row = {}) {
  return {
    count: Number(row.count || 0),
    min: row.min == null ? null : Number(row.min),
    max: row.max == null ? null : Number(row.max),
    mean: row.mean == null ? null : Math.round(Number(row.mean)),
    median: row.median == null ? null : Number(row.median),
  };
}

async function aggregateNumericSeries({ filters, valueSql, reliabilitySql }) {
  const qualifier = filters.where ? 'AND' : 'WHERE';
  const rows = await all(`
    WITH values_by_year AS (
      SELECT d.year AS year, ${valueSql} AS value
      FROM documents d
      LEFT JOIN file_metrics fm ON fm.doc_id = d.doc_id
      ${filters.where}
      ${qualifier} d.year IS NOT NULL AND ${reliabilitySql}
    ), ranked AS (
      SELECT year, value,
             ROW_NUMBER() OVER (PARTITION BY year ORDER BY value) AS row_num,
             COUNT(*) OVER (PARTITION BY year) AS partition_count
      FROM values_by_year
    )
    SELECT year, COUNT(*) AS count, MIN(value) AS min, MAX(value) AS max,
           AVG(value) AS mean,
           AVG(CASE
             WHEN row_num IN ((partition_count + 1) / 2, (partition_count + 2) / 2)
             THEN value
           END) AS median
    FROM ranked
    GROUP BY year
    ORDER BY year
  `, filters.args);
  return rows.map((row) => ({ year: Number(row.year), ...numericStats(row) }));
}

/**
 * Metadata-scale analytics computed as bounded SQL aggregates. This deliberately
 * returns no document collection; document rows have their own paginated API.
 */
export async function getDocumentServingAnalytics({ syncKey = null, filters: requestedFilters = {}, subjectLimit = 25 } = {}) {
  const filters = documentServingFilters({ syncKey, ...requestedFilters });
  const qualifier = filters.where ? 'AND' : 'WHERE';
  const activeWords = 'COALESCE(fm.body_word_count, fm.word_count)';
  const reliableWords = `${activeWords} >= 1000 AND COALESCE(fm.word_source, '') <> 'metadata_text'`;
  const reliablePages = `fm.page_count >= 10 AND COALESCE(fm.page_source, '') NOT IN ('estimated_from_metadata_words', 'estimated_from_full_text_words')`;

  const [overall, yearCounts, wordRows, pageRows, themes, concepts, methodologies] = await Promise.all([
    get(`
      SELECT COUNT(*) AS record_count,
             COUNT(CASE WHEN ${reliableWords} THEN 1 END) AS word_count,
             MIN(CASE WHEN ${reliableWords} THEN ${activeWords} END) AS word_min,
             MAX(CASE WHEN ${reliableWords} THEN ${activeWords} END) AS word_max,
             AVG(CASE WHEN ${reliableWords} THEN ${activeWords} END) AS word_mean,
             COUNT(CASE WHEN ${reliablePages} THEN 1 END) AS page_count,
             MIN(CASE WHEN ${reliablePages} THEN fm.page_count END) AS page_min,
             MAX(CASE WHEN ${reliablePages} THEN fm.page_count END) AS page_max,
             AVG(CASE WHEN ${reliablePages} THEN fm.page_count END) AS page_mean,
             COUNT(json_extract(d.metadata_json, '$.charCount')) AS char_count,
             MIN(CAST(json_extract(d.metadata_json, '$.charCount') AS INTEGER)) AS char_min,
             MAX(CAST(json_extract(d.metadata_json, '$.charCount') AS INTEGER)) AS char_max,
             AVG(CAST(json_extract(d.metadata_json, '$.charCount') AS INTEGER)) AS char_mean
      FROM documents d
      LEFT JOIN file_metrics fm ON fm.doc_id = d.doc_id
      ${filters.where}
    `, filters.args),
    all(`
      SELECT d.year AS year, COUNT(*) AS count
      FROM documents d
      ${filters.where}
      ${qualifier} d.year IS NOT NULL
      GROUP BY d.year
      ORDER BY d.year
    `, filters.args),
    aggregateNumericSeries({ filters, valueSql: activeWords, reliabilitySql: reliableWords }),
    aggregateNumericSeries({ filters, valueSql: 'fm.page_count', reliabilitySql: reliablePages }),
    all(`
      SELECT trim(CAST(term.value AS TEXT)) AS term, COUNT(DISTINCT d.doc_id) AS count
      FROM documents d, json_each(d.metadata_json, '$.themes') term
      ${filters.where}
      ${qualifier} trim(CAST(term.value AS TEXT)) <> ''
      GROUP BY term
      ORDER BY count DESC, term ASC
      LIMIT 70
    `, filters.args),
    all(`
      SELECT trim(CAST(term.value AS TEXT)) AS term, COUNT(DISTINCT d.doc_id) AS count
      FROM documents d, json_each(d.metadata_json, '$.conceptTerms') term
      ${filters.where}
      ${qualifier} trim(CAST(term.value AS TEXT)) <> ''
      GROUP BY term
      ORDER BY count DESC, term ASC
      LIMIT ?
    `, [...filters.args, Math.max(1, Math.min(100, Number(subjectLimit) || 25))]),
    all(`
      SELECT trim(CAST(term.value AS TEXT)) AS methodology, COUNT(DISTINCT d.doc_id) AS count
      FROM documents d, json_each(d.metadata_json, '$.methodologies') term
      ${filters.where}
      ${qualifier} trim(CAST(term.value AS TEXT)) <> ''
      GROUP BY methodology
      ORDER BY count DESC, methodology ASC
      LIMIT 100
    `, filters.args),
  ]);

  const wordStats = {
    count: Number(overall?.word_count || 0),
    min: overall?.word_min == null ? null : Number(overall.word_min),
    max: overall?.word_max == null ? null : Number(overall.word_max),
    mean: overall?.word_mean == null ? null : Math.round(Number(overall.word_mean)),
    median: null,
  };
  const pageStats = {
    count: Number(overall?.page_count || 0),
    min: overall?.page_min == null ? null : Number(overall.page_min),
    max: overall?.page_max == null ? null : Number(overall.page_max),
    mean: overall?.page_mean == null ? null : Math.round(Number(overall.page_mean)),
    median: null,
  };
  const charStats = {
    count: Number(overall?.char_count || 0),
    min: overall?.char_min == null ? null : Number(overall.char_min),
    max: overall?.char_max == null ? null : Number(overall.char_max),
    mean: overall?.char_mean == null ? null : Math.round(Number(overall.char_mean)),
    median: null,
  };
  const conceptRows = concepts.map((row) => ({
    concept: row.term,
    docCount: Number(row.count || 0),
    weightedDocEquivalent: Number(row.count || 0),
    weightedMean: null,
  }));
  const wordRowsByYear = new Map(wordRows.map((row) => [row.year, row]));
  const byYear = yearCounts.map((row) => {
    const year = Number(row.year);
    const wordRow = wordRowsByYear.get(year) || {};
    return {
      year,
      count: Number(row.count || 0),
      min: wordRow.min ?? null,
      max: wordRow.max ?? null,
      mean: wordRow.mean ?? null,
      median: wordRow.median ?? null,
    };
  });

  return {
    metrics: {
      recordCount: Number(overall?.record_count || 0),
      overallWordCount: wordStats,
      overallPageCount: pageStats,
      overallCharCount: charStats,
      byConcept: conceptRows,
      byYear,
      avgPagesByYear: pageRows,
      pageTrend: pageRows.map((row) => ({
        year: row.year, median: row.median, min: row.min, max: row.max, count: row.count,
      })),
    },
    wordCloud: themes.map((row) => ({ term: row.term, count: Number(row.count || 0) })),
    ngramCloud: concepts.map((row) => ({ term: row.term, count: Number(row.count || 0) })),
    methodologies: methodologies.map((row) => ({ methodology: row.methodology, count: Number(row.count || 0) })),
    supervisorNgramMatrix: { supervisors: [], ngrams: [], conceptIds: [], matrix: [] },
    termCooccurrence: [],
    conceptTimeline: [],
    methodologyConceptMatrix: { methodologies: [], concepts: [], conceptIds: [], matrix: [] },
    topicData: null,
    methodologyTopicMatrix: { methodologies: [], topics: [], matrix: [] },
    documents: [],
  };
}

const PEOPLE_PAGE_SORTS = {
  name: 'lower(name)',
  docCount: 'doc_count',
  roles: 'lower(roles)',
  years: 'year_min',
};

export async function queryPeoplePage({
  syncKey = null, filters: requestedFilters = {}, q = '', role = '',
  sortKey = 'docCount', sortDir = 'desc', limit = 50, offset = 0,
} = {}) {
  const filters = documentServingFilters({ syncKey, ...requestedFilters });
  const extra = [];
  const extraArgs = [];
  if (q) {
    const pattern = `%${String(q).toLowerCase()}%`;
    extra.push(`(
      lower(p.name) LIKE ? OR lower(p.role) LIKE ? OR lower(COALESCE(p.affiliation, '')) LIKE ?
    )`);
    extraArgs.push(pattern, pattern, pattern);
  }
  if (role) {
    extra.push('p.role = ?');
    extraArgs.push(role);
  }
  const matchWhereSql = extra.length ? `WHERE ${extra.join(' AND ')}` : '';
  const args = [...filters.args, ...extraArgs];
  const groupedSql = `
    WITH filtered_people AS (
      SELECT p.person_key, p.doc_id, p.name, p.role, p.affiliation, d.year
      FROM document_people p
      JOIN documents d ON d.doc_id = p.doc_id
      ${filters.where}
    ), matching_keys AS (
      SELECT DISTINCT p.person_key
      FROM filtered_people p
      ${matchWhereSql}
    )
    SELECT p.person_key,
           MAX(p.name) AS name,
           GROUP_CONCAT(DISTINCT p.role) AS roles,
           GROUP_CONCAT(DISTINCT NULLIF(p.affiliation, '')) AS affiliations,
           COUNT(DISTINCT p.doc_id) AS doc_count,
           MIN(p.year) AS year_min,
           MAX(p.year) AS year_max
    FROM filtered_people p
    JOIN matching_keys matched ON matched.person_key = p.person_key
    GROUP BY p.person_key
  `;
  const countRow = await get(`SELECT COUNT(*) AS total FROM (${groupedSql}) people`, args);
  const sortExpression = PEOPLE_PAGE_SORTS[sortKey] || PEOPLE_PAGE_SORTS.docCount;
  const direction = sortDir === 'asc' ? 'ASC' : 'DESC';
  const rows = await all(`
    SELECT * FROM (${groupedSql}) people
    ORDER BY ${sortExpression} ${direction}, lower(name) ${direction}, person_key ASC
    LIMIT ? OFFSET ?
  `, [...args, Math.max(1, Number(limit) || 50), Math.max(0, Number(offset) || 0)]);
  return {
    total: Number(countRow?.total || 0),
    people: rows.map((row) => {
      const yearMin = row.year_min == null ? null : Number(row.year_min);
      const yearMax = row.year_max == null ? null : Number(row.year_max);
      return {
        key: row.person_key,
        name: row.name,
        roles: String(row.roles || '').split(',').filter(Boolean),
        docCount: Number(row.doc_count || 0),
        affiliations: String(row.affiliations || '').split(',').filter(Boolean).sort(),
        yearRange: yearMin == null ? '\u2013' : `${yearMin}\u2013${yearMax}`,
        yearMin: yearMin ?? 9999,
      };
    }),
  };
}

/**
 * Returns corpus-complete person aggregates plus one bounded document page.
 * Relationship roles are aggregated per document so callers do not need to
 * load every document merely to reconstruct the person's summary.
 */
export async function queryPersonDetailPage({
  personKey, syncKey = null, filters: requestedFilters = {}, limit = 50, offset = 0,
} = {}) {
  const key = String(personKey || '').trim().toLowerCase();
  if (!key) return null;
  const filters = documentServingFilters({ syncKey, ...requestedFilters });
  const filterClause = filters.where ? `${filters.where} AND` : 'WHERE';
  const relationArgs = [...filters.args, key];
  const relationWhere = `${filterClause} p.person_key = ?`;
  const [summary, conceptRows, methodologyRows, coSupervisorRows, topicRows] = await Promise.all([
    get(`
      SELECT MAX(p.name) AS name,
             GROUP_CONCAT(DISTINCT p.role) AS roles,
             GROUP_CONCAT(DISTINCT NULLIF(p.affiliation, '')) AS affiliations,
             COUNT(DISTINCT p.doc_id) AS doc_count,
             MIN(d.year) AS year_min,
             MAX(d.year) AS year_max
      FROM document_people p
      JOIN documents d ON d.doc_id = p.doc_id
      ${relationWhere}
    `, relationArgs),
    all(`
      SELECT trim(CAST(term.value AS TEXT)) AS term, COUNT(DISTINCT p.doc_id) AS count
      FROM document_people p
      JOIN documents d ON d.doc_id = p.doc_id,
           json_each(d.metadata_json, '$.conceptTerms') term
      ${relationWhere} AND trim(CAST(term.value AS TEXT)) <> ''
      GROUP BY term
      ORDER BY count DESC, term ASC
      LIMIT 12
    `, relationArgs),
    all(`
      SELECT trim(CAST(term.value AS TEXT)) AS methodology, COUNT(DISTINCT p.doc_id) AS count
      FROM document_people p
      JOIN documents d ON d.doc_id = p.doc_id,
           json_each(d.metadata_json, '$.methodologies') term
      ${relationWhere} AND trim(CAST(term.value AS TEXT)) <> ''
      GROUP BY methodology
      ORDER BY count DESC, methodology ASC
      LIMIT 100
    `, relationArgs),
    all(`
      SELECT MAX(other.name) AS person_name
      FROM document_people p
      JOIN documents d ON d.doc_id = p.doc_id
      JOIN document_people other ON other.doc_id = p.doc_id
        AND other.person_key <> p.person_key
        AND other.source = 'metadata' AND other.role = 'Supervisor'
      ${relationWhere}
      GROUP BY other.person_key
      ORDER BY lower(MAX(other.name))
      LIMIT 100
    `, relationArgs),
    all(`
      SELECT dt.topic_id, COUNT(DISTINCT p.doc_id) AS count
      FROM document_people p
      JOIN documents d ON d.doc_id = p.doc_id
      JOIN document_topics dt ON dt.doc_id = p.doc_id
      ${relationWhere}
      GROUP BY dt.topic_id
      ORDER BY count DESC, dt.topic_id ASC
      LIMIT 100
    `, relationArgs),
  ]);
  if (!summary?.name || Number(summary.doc_count || 0) === 0) return null;

  const rows = await all(`
    WITH person_docs AS (
      SELECT p.doc_id, GROUP_CONCAT(DISTINCT p.role) AS person_roles
      FROM document_people p
      JOIN documents d ON d.doc_id = p.doc_id
      ${relationWhere}
      GROUP BY p.doc_id
    ), topic_assignment AS (
      SELECT dt.doc_id, dt.topic_id, dt.probability
      FROM document_topics dt
      WHERE dt.topic_id = (
        SELECT candidate.topic_id
        FROM document_topics candidate
        WHERE candidate.doc_id = dt.doc_id
        ORDER BY COALESCE(candidate.probability, -1) DESC, candidate.topic_id ASC
        LIMIT 1
      )
    )
    SELECT d.doc_id, d.metadata_json, pd.person_roles,
           fm.download_url, fm.file_bytes, fm.word_count, fm.body_word_count,
           fm.page_count, fm.word_source, fm.page_source, fm.status, fm.error,
           COALESCE(dc.citation_count, 0) AS citation_count,
           dt.topic_id, dt.probability
    FROM person_docs pd
    JOIN documents d ON d.doc_id = pd.doc_id
    LEFT JOIN file_metrics fm ON fm.doc_id = d.doc_id
    LEFT JOIN (SELECT doc_id, COUNT(*) AS citation_count FROM document_citations GROUP BY doc_id) dc
      ON dc.doc_id = d.doc_id
    LEFT JOIN topic_assignment dt ON dt.doc_id = d.doc_id
    ORDER BY COALESCE(d.year, 0) DESC, lower(COALESCE(d.title, '')) ASC, d.doc_id ASC
    LIMIT ? OFFSET ?
  `, [...relationArgs, Math.max(1, Number(limit) || 50), Math.max(0, Number(offset) || 0)]);
  const documents = rows.map((row) => {
    try {
      const doc = applyStoredFileMetricToDocument(JSON.parse(row.metadata_json), row);
      doc.citationCount = Number(row.citation_count || 0);
      doc.topicId = row.topic_id == null ? null : Number(row.topic_id);
      doc.topicProbability = row.probability == null ? null : Number(row.probability);
      doc.personRoles = String(row.person_roles || '').split(',').filter(Boolean);
      return doc;
    } catch {
      return null;
    }
  }).filter(Boolean);
  const yearMin = summary.year_min == null ? null : Number(summary.year_min);
  const yearMax = summary.year_max == null ? null : Number(summary.year_max);
  return {
    person: {
      key,
      name: summary.name,
      roles: String(summary.roles || '').split(',').filter(Boolean),
      docCount: Number(summary.doc_count || 0),
      affiliations: String(summary.affiliations || '').split(',').filter(Boolean).sort(),
      yearRange: yearMin == null ? '\u2013' : `${yearMin}\u2013${yearMax}`,
      yearMin: yearMin ?? 9999,
      topConcepts: conceptRows.map((row) => ({ term: row.term, count: Number(row.count || 0) })),
      methodologies: methodologyRows.map((row) => ({ methodology: row.methodology, count: Number(row.count || 0) })),
      coSupervisors: coSupervisorRows.map((row) => row.person_name).filter(Boolean),
      topicSummary: topicRows.map((row) => ({ topicId: Number(row.topic_id), count: Number(row.count || 0) })),
    },
    documents,
  };
}

export async function queryRelatedDocuments(doc, { syncKey = null, limit = 6 } = {}) {
  const terms = Array.from(new Set([
    ...(Array.isArray(doc?.themes) ? doc.themes : []),
    ...(Array.isArray(doc?.conceptTerms) ? doc.conceptTerms : []),
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))).slice(0, 24);
  if (!doc?.id || !terms.length) return [];
  const values = terms.map(() => '(?)').join(', ');
  const syncClause = syncKey ? 'AND d.sync_key = ?' : '';
  const rows = await all(`
    WITH target_terms(term) AS (VALUES ${values})
    SELECT d.doc_id, d.title, d.author, d.year, d.degree,
           COUNT(DISTINCT target_terms.term) AS overlap
    FROM documents d
    JOIN target_terms ON (
      EXISTS (
        SELECT 1 FROM json_each(d.metadata_json, '$.themes') theme
        WHERE lower(CAST(theme.value AS TEXT)) = target_terms.term
      ) OR EXISTS (
        SELECT 1 FROM json_each(d.metadata_json, '$.conceptTerms') concept
        WHERE lower(CAST(concept.value AS TEXT)) = target_terms.term
      )
    )
    WHERE d.doc_id <> ? ${syncClause}
    GROUP BY d.doc_id, d.title, d.author, d.year, d.degree
    ORDER BY overlap DESC, d.year DESC, d.title ASC
    LIMIT ?
  `, [...terms, doc.id, ...(syncKey ? [syncKey] : []), Math.max(1, Math.min(25, Number(limit) || 6))]);
  return rows.map((row) => ({
    id: row.doc_id,
    title: row.title || '',
    author: row.author || '',
    year: row.year == null ? null : Number(row.year),
    degree: row.degree || '',
    overlap: Number(row.overlap || 0),
  }));
}

export async function applyStoredFileMetricsToDocuments(documents = []) {
  const list = Array.isArray(documents) ? documents : [];
  const ids = Array.from(new Set(list.map((doc) => doc?.id).filter(Boolean)));
  if (!ids.length) return list;

  const metricsByDocId = new Map();
  const chunkSize = 999;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await all(`
      SELECT doc_id, download_url, file_bytes, word_count, body_word_count,
             page_count, word_source, page_source, status, error
      FROM file_metrics
      WHERE doc_id IN (${placeholders})
    `, chunk);
    for (const row of rows) metricsByDocId.set(row.doc_id, row);
  }

  for (const doc of list) {
    const row = metricsByDocId.get(doc?.id);
    if (row) applyStoredFileMetricToDocument(doc, row);
  }
  return list;
}

export async function applyCitationCountsToDocuments(documents = []) {
  const list = Array.isArray(documents) ? documents : [];
  const ids = Array.from(new Set(list.map((doc) => doc?.id).filter(Boolean)));
  if (!ids.length) return list;

  const countsByDocId = new Map();
  const chunkSize = 999;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await all(`
      SELECT doc_id, COUNT(*) AS citation_count
      FROM document_citations
      WHERE doc_id IN (${placeholders})
      GROUP BY doc_id
    `, chunk);
    for (const row of rows) countsByDocId.set(row.doc_id, Number(row.citation_count || 0));
  }

  for (const doc of list) {
    if (doc?.id) doc.citationCount = countsByDocId.get(doc.id) || 0;
  }
  return list;
}

const SUPERVISOR_COMMITTEE_ROLES = new Set(['Supervisor', 'Co-Supervisor']);

export async function applyCommitteeMembersToDocuments(documents = []) {
  const list = Array.isArray(documents) ? documents : [];
  const ids = Array.from(new Set(list.map((doc) => doc?.id).filter(Boolean)));
  if (!ids.length) return list;

  const membersByDocId = new Map(ids.map((id) => [id, []]));
  const chunkSize = 999;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await all(`
      SELECT doc_id, name, role, affiliation, source
      FROM committee_members
      WHERE doc_id IN (${placeholders})
      ORDER BY doc_id, id
    `, chunk);
    for (const row of rows) {
      if (!membersByDocId.has(row.doc_id)) membersByDocId.set(row.doc_id, []);
      membersByDocId.get(row.doc_id).push({
        name: row.name,
        role: row.role || 'Committee Member',
        affiliation: row.affiliation || null,
        source: row.source || null,
      });
    }
  }

  for (const doc of list) {
    if (doc?.id) {
      doc.committee = membersByDocId.get(doc.id) || [];
      const storedSupervisors = doc.committee
        .filter((member) => SUPERVISOR_COMMITTEE_ROLES.has(member.role))
        .map((member) => member.name);
      if (storedSupervisors.length) {
        const existingSupervisors = Array.isArray(doc.supervisors)
          ? doc.supervisors
          : (doc.supervisors ? [doc.supervisors] : []);
        doc.supervisors = dedupeSupervisorNames([...existingSupervisors, ...storedSupervisors]);
        if (!doc.supervisorsSource) {
          doc.supervisorsSource = doc.committee.some((member) =>
            SUPERVISOR_COMMITTEE_ROLES.has(member.role) && member.source === 'api'
          )
            ? 'api'
            : 'pdf_fallback';
        }
      }
    }
  }
  return list;
}

function applyStoredFileMetricToDocument(doc, row) {
  if (!doc || !row) return doc;
  if (row.page_count != null) {
    doc.pages = Number(row.page_count);
    doc.pagesSource = row.page_source || doc.pagesSource;
  }
  if (row.word_count != null) {
    doc.wordCount = Number(row.word_count);
    doc.wordCountSource = row.word_source || doc.wordCountSource;
  }
  if (row.body_word_count != null) {
    doc.bodyWordCount = Number(row.body_word_count);
  }
  if (row.file_bytes != null) {
    doc.fileBytes = Number(row.file_bytes);
  }
  if (row.download_url != null) {
    doc.downloadUrl = row.download_url;
  }
  if (row.status != null) {
    doc.downloadStatus = row.status;
  }
  if (row.error != null) {
    doc.downloadError = row.error;
  }
  return doc;
}

export async function getDocumentCacheStats(syncKey = null) {
  const row = syncKey
    ? await get(`
      SELECT COUNT(*) AS total, MAX(synced_at) AS last_synced_at
      FROM documents
      WHERE sync_key = ?
    `, [syncKey])
    : await get(`
      SELECT COUNT(*) AS total, MAX(synced_at) AS last_synced_at
      FROM documents
    `);
  return {
    total: Number(row?.total || 0),
    lastSyncedAt: row?.last_synced_at || null,
  };
}

export async function createSyncRun(syncKey, source) {
  const now = new Date().toISOString();
  const result = await execute(`
    INSERT INTO sync_runs (sync_key, source_json, status, started_at)
    VALUES (?, ?, 'running', ?)
  `, [syncKey, JSON.stringify(source), now]);
  return Number(result.lastInsertRowid || result.lastInsertRowId || 0);
}

export async function updateSyncRun(id, patch) {
  if (!id) return;
  const fields = [];
  const args = [];
  for (const [key, column] of Object.entries({
    status: 'status',
    totalSeen: 'total_seen',
    totalSaved: 'total_saved',
    apiTotal: 'api_total',
    error: 'error',
    finishedAt: 'finished_at',
  })) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      fields.push(`${column} = ?`);
      args.push(patch[key]);
    }
  }
  if (!fields.length) return;
  args.push(id);
  await run(`UPDATE sync_runs SET ${fields.join(', ')} WHERE id = ?`, args);
}

export async function getLatestSyncRun(syncKey = null) {
  const row = syncKey
    ? await get('SELECT * FROM sync_runs WHERE sync_key = ? ORDER BY started_at DESC LIMIT 1', [syncKey])
    : await get('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1');
  if (!row) return null;
  return {
    id: Number(row.id),
    syncKey: row.sync_key,
    source: (() => { try { return JSON.parse(row.source_json); } catch { return null; } })(),
    status: row.status,
    totalSeen: Number(row.total_seen || 0),
    totalSaved: Number(row.total_saved || 0),
    apiTotal: row.api_total == null ? null : Number(row.api_total),
    error: row.error || null,
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
  };
}

export async function listRecentSyncRuns(limit = 25) {
  const rows = await all(`
    SELECT * FROM sync_runs
    ORDER BY started_at DESC
    LIMIT ?
  `, [limit]);
  return rows.map((row) => ({
    id: Number(row.id),
    syncKey: row.sync_key,
    source: (() => { try { return JSON.parse(row.source_json); } catch { return null; } })(),
    status: row.status,
    totalSeen: Number(row.total_seen || 0),
    totalSaved: Number(row.total_saved || 0),
    apiTotal: row.api_total == null ? null : Number(row.api_total),
    error: row.error || null,
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
  }));
}

export function hashAdminJobToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function parseAdminJobRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    type: row.type,
    label: row.label,
    status: row.status,
    params: (() => { try { return row.params_json ? JSON.parse(row.params_json) : null; } catch { return null; } })(),
    result: (() => { try { return row.result_json ? JSON.parse(row.result_json) : null; } catch { return null; } })(),
    log: row.log || null,
    error: row.error || null,
    runnerType: row.runner_type || null,
    runnerId: row.runner_id || null,
    runnerState: row.runner_state || null,
    progress: (() => { try { return row.progress_json ? JSON.parse(row.progress_json) : null; } catch { return null; } })(),
    heartbeatAt: row.heartbeat_at || null,
    timeoutAt: row.timeout_at || null,
    cancelledAt: row.cancelled_at || null,
    claimedAt: row.claimed_at || null,
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
  };
}

export async function createAdminJob({
  type, label, params = null, artifactTokenHash = null, timeoutAt = null, runnerType = null
}) {
  const now = new Date().toISOString();
  const result = await execute(`
    INSERT INTO admin_jobs (
      type, label, status, params_json, artifact_token_hash, timeout_at,
      runner_type, runner_state, started_at
    )
    VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)
  `, [
    type,
    label,
    params ? JSON.stringify(params) : null,
    artifactTokenHash,
    timeoutAt,
    runnerType,
    runnerType ? 'queued' : null,
    now
  ]);
  return Number(result.lastInsertRowid || result.lastInsertRowId || 0);
}

export async function updateAdminJob(id, patch = {}) {
  if (!id) return;
  const fields = [];
  const args = [];
  for (const [key, column] of Object.entries({
    status: 'status',
    result: 'result_json',
    log: 'log',
    error: 'error',
    runnerType: 'runner_type',
    runnerId: 'runner_id',
    runnerState: 'runner_state',
    heartbeatAt: 'heartbeat_at',
    timeoutAt: 'timeout_at',
    cancelledAt: 'cancelled_at',
    artifactTokenHash: 'artifact_token_hash',
    claimedAt: 'claimed_at',
    progress: 'progress_json',
    finishedAt: 'finished_at',
  })) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    fields.push(`${column} = ?`);
    const value = key === 'result' && patch[key] != null
      ? JSON.stringify(patch[key])
      : key === 'progress' && patch[key] != null
        ? JSON.stringify(patch[key])
      : patch[key];
    args.push(value);
  }
  if (!fields.length) return;
  args.push(id);
  await run(`UPDATE admin_jobs SET ${fields.join(', ')} WHERE id = ?`, args);
}

export async function finishAdminJob(id, patch = {}) {
  await updateAdminJob(id, {
    ...patch,
    artifactTokenHash: null,
    finishedAt: patch.finishedAt || new Date().toISOString(),
  });
}

export async function appendAdminJobLog(id, line, limit = 12000) {
  if (!id) return;
  const text = String(line || '');
  if (!text) return;
  await run(`
    UPDATE admin_jobs
    SET log = CASE
      WHEN length(COALESCE(log, '') || ?) > ?
        THEN substr(COALESCE(log, '') || ?, length(COALESCE(log, '') || ?) - ? + 1)
      ELSE COALESCE(log, '') || ?
    END
    WHERE id = ?
  `, [text, limit, text, text, limit, text, id]);
}

export async function getAdminJob(id) {
  const row = await get('SELECT * FROM admin_jobs WHERE id = ?', [id]);
  return parseAdminJobRow(row);
}

export async function claimAdminJob(id, runnerId = null) {
  const now = new Date().toISOString();
  const result = await run(`
    UPDATE admin_jobs
    SET claimed_at = ?, runner_id = COALESCE(?, runner_id), runner_state = 'running', heartbeat_at = ?
    WHERE id = ? AND status = 'running' AND claimed_at IS NULL
  `, [now, runnerId, now, id]);
  return result.changes > 0 ? getAdminJob(id) : null;
}

export async function heartbeatAdminJob(id, runnerState = 'running') {
  const patch = {
    heartbeatAt: new Date().toISOString(),
  };
  if (runnerState != null) patch.runnerState = runnerState;
  await updateAdminJob(id, patch);
}

export async function updateAdminJobProgress(id, progress = {}) {
  await updateAdminJob(id, {
    progress: {
      ...progress,
      updatedAt: new Date().toISOString(),
    },
    heartbeatAt: new Date().toISOString(),
    runnerState: progress.currentTask || progress.phase || 'running',
  });
}

export async function validateAdminJobArtifactToken(id, token, { docId = null } = {}) {
  const row = await get(`
    SELECT status, params_json, artifact_token_hash, timeout_at, cancelled_at, finished_at
    FROM admin_jobs
    WHERE id = ?
  `, [id]);
  if (!row?.artifact_token_hash || !token) return false;
  if (row.status !== 'running' || row.finished_at || row.cancelled_at) return false;
  if (row.timeout_at && Date.parse(row.timeout_at) <= Date.now()) return false;

  if (docId) {
    let params = null;
    try { params = row.params_json ? JSON.parse(row.params_json) : null; } catch { params = null; }
    if (params?.docId && String(params.docId) !== String(docId)) return false;
  }

  const expected = Buffer.from(row.artifact_token_hash, 'hex');
  const actual = Buffer.from(hashAdminJobToken(token), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const STALE_HEARTBEAT_MS = 30 * 60 * 1000;

export async function reapStaleAdminJobs(type = null) {
  const now = new Date().toISOString();
  const staleCutoff = new Date(Date.now() - STALE_HEARTBEAT_MS).toISOString();
  const args = [now, now, staleCutoff];
  let sql = `
    UPDATE admin_jobs
    SET status = 'timed_out',
        runner_state = 'timed_out',
        error = COALESCE(error, 'Admin worker timed out or stopped heartbeating.'),
        finished_at = ?,
        artifact_token_hash = NULL
    WHERE status = 'running'
      AND (
        (timeout_at IS NOT NULL AND timeout_at <= ?)
        OR (timeout_at IS NULL AND COALESCE(heartbeat_at, claimed_at, started_at) <= ?)
      )
  `;
  if (type) {
    sql += ' AND type = ?';
    args.push(type);
  }
  const client = await getDb();
  const results = await client.batch([
    { sql, args },
    {
      sql: `
        UPDATE enrichment_rollouts
        SET status = 'blocked', current_phase = NULL, current_job_id = NULL,
            evaluation_json = json_object(
              'passed', 0,
              'phase', current_phase,
              'interrupted', 1,
              'error', 'Admin worker timed out or stopped heartbeating.'
            ),
            updated_at = ?
        WHERE current_job_id IN (
          SELECT id FROM admin_jobs
          WHERE status = 'timed_out' AND finished_at = ?
        )
      `,
      args: [now, now],
    },
  ], 'write');
  return changes(results[0]);
}

export async function hasRunningAdminJob(type) {
  await reapStaleAdminJobs(type);
  const row = await get('SELECT id FROM admin_jobs WHERE type = ? AND status = ? ORDER BY started_at DESC LIMIT 1', [type, 'running']);
  return row ? Number(row.id) : null;
}

export async function listAdminJobs(limit = 25) {
  await reapStaleAdminJobs();
  const rows = await all(`
    SELECT * FROM admin_jobs
    ORDER BY started_at DESC
    LIMIT ?
  `, [limit]);
  return rows.map(parseAdminJobRow);
}

// --- File metric functions ---

export async function loadStoredFileMetric(docId) {
  return get(`
    SELECT doc_id, pdf_path, download_url, file_bytes, word_count, body_word_count,
           full_text_path, full_text_bytes, full_text_source_url, page_count,
           word_source, page_source, content_source, content_checksum,
           content_source_url, content_retrieved_at, parser_version,
           metadata_request_count, full_text_request_count,
           original_pdf_request_count, retrieved_bytes, status, error, updated_at
    FROM file_metrics
    WHERE doc_id = ?
  `, [docId]);
}

export async function saveFileMetric(docId, payload) {
  const now = new Date().toISOString();
  await run(`
    INSERT INTO file_metrics (
      doc_id, pdf_path, download_url, file_bytes, word_count, body_word_count,
      full_text_path, full_text_bytes, full_text_source_url, page_count,
      word_source, page_source, content_source, content_checksum,
      content_source_url, content_retrieved_at, parser_version,
      metadata_request_count, full_text_request_count,
      original_pdf_request_count, retrieved_bytes, status, error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_id) DO UPDATE SET
      pdf_path = excluded.pdf_path,
      download_url = excluded.download_url,
      file_bytes = excluded.file_bytes,
      word_count = excluded.word_count,
      body_word_count = excluded.body_word_count,
      full_text_path = excluded.full_text_path,
      full_text_bytes = excluded.full_text_bytes,
      full_text_source_url = excluded.full_text_source_url,
      page_count = excluded.page_count,
      word_source = excluded.word_source,
      page_source = excluded.page_source,
      content_source = excluded.content_source,
      content_checksum = excluded.content_checksum,
      content_source_url = excluded.content_source_url,
      content_retrieved_at = excluded.content_retrieved_at,
      parser_version = excluded.parser_version,
      metadata_request_count = excluded.metadata_request_count,
      full_text_request_count = excluded.full_text_request_count,
      original_pdf_request_count = excluded.original_pdf_request_count,
      retrieved_bytes = excluded.retrieved_bytes,
      status = excluded.status,
      error = excluded.error,
      updated_at = excluded.updated_at
  `, [
    docId,
    payload.pdfPath || null,
    payload.downloadUrl || null,
    payload.fileBytes ?? null,
    payload.wordCount ?? null,
    payload.bodyWordCount ?? null,
    payload.fullTextPath || null,
    payload.fullTextBytes ?? null,
    payload.fullTextSourceUrl || null,
    payload.pageCount ?? null,
    payload.wordSource || null,
    payload.pageSource || null,
    payload.contentSource || null,
    payload.contentChecksum || null,
    payload.contentSourceUrl || null,
    payload.contentRetrievedAt || null,
    payload.parserVersion || null,
    payload.metadataRequestCount ?? null,
    payload.fullTextRequestCount ?? null,
    payload.originalPdfRequestCount ?? null,
    payload.retrievedBytes ?? null,
    payload.status || null,
    payload.error || null,
    now
  ]);
}

export async function deleteFileMetric(docId) {
  await run('DELETE FROM file_metrics WHERE doc_id = ?', [docId]);
}

export async function listFileMetrics() {
  const rows = await all(`
    SELECT fm.doc_id, fm.pdf_path, fm.download_url, fm.file_bytes, fm.word_count,
           fm.body_word_count, fm.full_text_path, fm.full_text_bytes, fm.full_text_source_url, fm.page_count,
           fm.word_source, fm.page_source, fm.content_source, fm.content_checksum,
           fm.content_source_url, fm.content_retrieved_at, fm.parser_version,
           fm.metadata_request_count, fm.full_text_request_count,
           fm.original_pdf_request_count, fm.retrieved_bytes,
           fm.status, fm.error, fm.updated_at,
           d.title, d.author, d.metadata_json
    FROM file_metrics fm
    LEFT JOIN documents d ON d.doc_id = fm.doc_id
    ORDER BY fm.updated_at DESC
  `);
  return rows.map((row) => {
    let metadata = null;
    try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null; } catch { metadata = null; }
    const supervisors = Array.isArray(metadata?.supervisors) ? metadata.supervisors : [];
    return {
      ...row,
      title: row.title || metadata?.title || '',
      author: row.author || metadata?.author || '',
      supervisors,
      metadata_json: undefined,
    };
  });
}

export async function getFileMetricsStats() {
  return get(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN file_bytes IS NOT NULL THEN file_bytes ELSE 0 END) AS total_bytes,
           SUM(CASE WHEN status = 'downloaded' OR status = 'redownloaded' OR status = 'cached' OR status = 'recomputed_from_cache' THEN 1 ELSE 0 END) AS with_pdf,
           SUM(CASE WHEN word_source = 'dspace_full_text' THEN 1 ELSE 0 END) AS with_full_text,
           SUM(CASE WHEN status = 'not_found' OR status = 'cache_miss' OR status = 'blocked' THEN 1 ELSE 0 END) AS failed,
           MIN(updated_at) AS oldest,
           MAX(updated_at) AS newest
    FROM file_metrics
  `);
}

// --- Run metrics functions ---

export async function saveRunMetrics(source, metrics) {
  const now = new Date().toISOString();
  const runKey = crypto.createHash('sha1').update(JSON.stringify(source)).digest('hex');
  await run(`
    INSERT INTO metric_runs (run_key, source_json, metrics_json, created_at)
    VALUES (?, ?, ?, ?)
  `, [runKey, JSON.stringify(source), JSON.stringify(metrics), now]);
  await run(`
    DELETE FROM metric_runs
    WHERE id NOT IN (SELECT id FROM metric_runs ORDER BY created_at DESC, id DESC LIMIT 100)
  `);
}

export async function listRecentRuns(limit = 50) {
  return all(`
    SELECT id, run_key, source_json, metrics_json, created_at
    FROM metric_runs
    ORDER BY created_at DESC
    LIMIT ?
  `, [limit]);
}

// --- User functions ---

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

export async function createUser(username, passwordHash, salt, profile = {}) {
  const now = new Date().toISOString();
  await run(`
    INSERT INTO users (username, first_name, last_name, email, password_hash, salt, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    username,
    profile.firstName || null,
    profile.lastName || null,
    profile.email || null,
    passwordHash,
    salt,
    now
  ]);
  logger.info('User created', { username });
}

export async function deleteUser(username) {
  const result = await run('DELETE FROM users WHERE username = ?', [username]);
  if (result.changes > 0) logger.info('User deleted', { username });
  return result.changes > 0;
}

export async function updateUserPassword(username, passwordHash, salt) {
  const result = await run(`
    UPDATE users
    SET password_hash = ?, salt = ?
    WHERE username = ?
  `, [passwordHash, salt, username]);
  if (result.changes > 0) {
    await run('UPDATE password_reset_tokens SET used_at = ? WHERE username = ? AND used_at IS NULL', [
      new Date().toISOString(),
      username
    ]);
  }
  if (result.changes > 0) logger.info('User password updated', { username });
  return result.changes > 0;
}

export async function findUserByUsername(username) {
  const user = await get(`
    SELECT id, username, first_name, last_name, email, password_hash, salt, mfa_secret, mfa_enabled, mfa_enabled_at, created_at
    FROM users
    WHERE username = ?
  `, [username]);
  if (user?.mfa_secret) user.mfa_secret = decryptMfaSecret(user.mfa_secret);
  return user;
}

export async function listUsers() {
  return all(`
    SELECT id, username, first_name, last_name, email, mfa_enabled, mfa_enabled_at, created_at
    FROM users
    ORDER BY created_at
  `);
}

export async function countUsers() {
  const row = await get('SELECT COUNT(*) AS cnt FROM users');
  return Number(row?.cnt || 0);
}

export async function setUserMfa(username, secret) {
  const now = new Date().toISOString();
  await run(`
    UPDATE users
    SET mfa_secret = ?, mfa_enabled = 1, mfa_enabled_at = ?
    WHERE username = ?
  `, [encryptMfaSecret(secret), now, username]);
}

export async function clearUserMfa(username) {
  const result = await run(`
    UPDATE users
    SET mfa_secret = NULL, mfa_enabled = 0, mfa_enabled_at = NULL
    WHERE username = ?
  `, [username]);
  if (result.changes > 0) logger.info('User MFA reset', { username });
  return result.changes > 0;
}

export async function createPasswordResetToken(username, { ttlMs = 24 * 60 * 60 * 1000 } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + ttlMs);
  await run('UPDATE password_reset_tokens SET used_at = ? WHERE username = ? AND used_at IS NULL', [
    now.toISOString(),
    username
  ]);
  await run(`
    INSERT INTO password_reset_tokens (token_hash, username, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `, [tokenHash(token), username, now.toISOString(), expires.toISOString()]);
  logger.info('Password reset token created', { username, expiresAt: expires.toISOString() });
  return { token, expiresAt: expires.toISOString() };
}

export async function findPasswordResetToken(token) {
  const row = await get(`
    SELECT token_hash, username, created_at, expires_at, used_at
    FROM password_reset_tokens
    WHERE token_hash = ?
  `, [tokenHash(token)]);
  if (!row || row.used_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return {
    tokenHash: row.token_hash,
    username: row.username,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function consumePasswordResetToken(token) {
  const result = await run(`
    UPDATE password_reset_tokens
    SET used_at = ?
    WHERE token_hash = ? AND used_at IS NULL
  `, [new Date().toISOString(), tokenHash(token)]);
  return result.changes > 0;
}

// --- Settings functions ---

export async function getSetting(key) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

export async function setSetting(key, value) {
  const now = new Date().toISOString();
  await run(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `, [key, value, now]);
}

export async function getAllSettings() {
  const rows = await all('SELECT key, value, updated_at FROM settings ORDER BY key');
  const obj = {};
  for (const row of rows) obj[row.key] = row.value;
  return obj;
}

// --- Import rule functions ---

function importRuleFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    degree: row.degree || '',
    program: row.program || '',
    affiliation: row.affiliation || '',
    index: row.requested_index || '',
    query: row.query || '',
    source: row.source || '',
    contentMode: row.content_mode || 'metadata_only',
    contentFallback: row.content_fallback || 'fail_document',
    extractCitations: Boolean(row.extract_citations),
    extractCommittee: row.extract_committee == null ? true : Boolean(row.extract_committee),
    runConcepts: row.run_concepts == null ? true : Boolean(row.run_concepts),
    maxContentBytes: Number(row.max_content_bytes || 209715200),
    contentConcurrency: Number(row.content_concurrency || 1),
    contentRateLimit: Number(row.content_rate_limit || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function importRuleRevision(input) {
  const rule = normalizeImportRule(input);
  const canonical = JSON.stringify({
    degree: rule.degree,
    program: rule.program,
    affiliation: rule.affiliation,
    index: rule.index,
    query: rule.query,
    source: rule.source,
    contentMode: rule.contentMode,
    contentFallback: rule.contentFallback,
    extractCitations: rule.extractCitations,
    extractCommittee: rule.extractCommittee,
    runConcepts: rule.runConcepts,
    maxContentBytes: rule.maxContentBytes,
    contentConcurrency: rule.contentConcurrency,
    contentRateLimit: rule.contentRateLimit,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export async function listImportRules() {
  const rows = await all(`
    SELECT id, name, degree, program, affiliation, requested_index, query, source, content_mode,
           content_fallback, extract_citations, extract_committee, run_concepts,
           max_content_bytes, content_concurrency, content_rate_limit, created_at, updated_at
    FROM import_rules
    ORDER BY updated_at DESC, name
  `);
  return rows.map(importRuleFromRow);
}

export async function getImportRule(id) {
  const row = await get(`
    SELECT id, name, degree, program, affiliation, requested_index, query, source, content_mode,
           content_fallback, extract_citations, extract_committee, run_concepts,
           max_content_bytes, content_concurrency, content_rate_limit, created_at, updated_at
    FROM import_rules
    WHERE id = ?
  `, [id]);
  return importRuleFromRow(row);
}

export async function saveImportRule(rule) {
  const now = new Date().toISOString();
  const id = rule.id || crypto.randomUUID();
  const existing = await getImportRule(id);
  const createdAt = existing?.createdAt || now;
  const normalized = normalizeImportRule({ ...rule, id });
  const statements = [{ sql: `
    INSERT INTO import_rules (
      id, name, degree, program, affiliation, requested_index, query, source, content_mode,
      content_fallback, extract_citations, extract_committee, run_concepts,
      max_content_bytes, content_concurrency, content_rate_limit, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      degree = excluded.degree,
      program = excluded.program,
      affiliation = excluded.affiliation,
      requested_index = excluded.requested_index,
      query = excluded.query,
      source = excluded.source,
      content_mode = excluded.content_mode,
      content_fallback = excluded.content_fallback,
      extract_citations = excluded.extract_citations,
      extract_committee = excluded.extract_committee,
      run_concepts = excluded.run_concepts,
      max_content_bytes = excluded.max_content_bytes,
      content_concurrency = excluded.content_concurrency,
      content_rate_limit = excluded.content_rate_limit,
      updated_at = excluded.updated_at
  `, args: [
    id,
    normalized.name,
    normalized.degree || null,
    normalized.program || null,
    normalized.affiliation || null,
    normalized.index || null,
    normalized.query || null,
    normalized.source || null,
    normalized.contentMode,
    normalized.contentFallback,
    normalized.extractCitations ? 1 : 0,
    normalized.extractCommittee ? 1 : 0,
    normalized.runConcepts ? 1 : 0,
    normalized.maxContentBytes,
    normalized.contentConcurrency,
    normalized.contentRateLimit,
    createdAt,
    now,
  ] }];
  if (existing && importRuleRevision(existing) !== importRuleRevision(normalized)) {
    statements.push({ sql: `
      UPDATE enrichment_rollouts
      SET status = 'invalidated', current_phase = NULL, current_job_id = NULL,
          rule_revision = ?, evaluation_json = ?, updated_at = ?
      WHERE rule_id = ?
    `, args: [
      importRuleRevision(normalized),
      JSON.stringify({ passed: false, reason: 'import_rule_changed' }),
      now,
      id,
    ] });
  }
  const client = await getDb();
  await client.batch(statements, 'write');
  return getImportRule(id);
}

export async function deleteImportRule(id) {
  const existing = await getImportRule(id);
  if (!existing) return false;
  const client = await getDb();
  await client.batch([
    { sql: 'DELETE FROM import_rule_request_limits WHERE rule_id = ?', args: [id] },
    { sql: 'DELETE FROM enrichment_rollout_evidence WHERE rule_id = ?', args: [id] },
    { sql: 'DELETE FROM enrichment_rollouts WHERE rule_id = ?', args: [id] },
    { sql: 'DELETE FROM import_rules WHERE id = ?', args: [id] },
  ], 'write');
  return true;
}

export async function reserveImportRuleRequestSlot(ruleId, limit, {
  nowMs = Date.now(), windowMs = 60_000,
} = {}) {
  if (!ruleId || !Number.isFinite(Number(limit)) || Number(limit) <= 0) return 0;
  const boundedLimit = Math.max(1, Math.min(600, Math.floor(Number(limit))));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const row = await get(
      'SELECT timestamps_json FROM import_rule_request_limits WHERE rule_id = ?',
      [ruleId]
    );
    let timestamps = [];
    try {
      const parsed = JSON.parse(row?.timestamps_json || '[]');
      if (Array.isArray(parsed)) timestamps = parsed;
    } catch { /* replace malformed limiter state */ }
    timestamps = timestamps
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > nowMs - windowMs)
      .sort((left, right) => left - right);
    if (timestamps.length >= boundedLimit) {
      return Math.max(1, timestamps[0] + windowMs - nowMs);
    }
    const nextJson = JSON.stringify([...timestamps, nowMs].slice(-600));
    let result;
    if (row) {
      result = await run(`
        UPDATE import_rule_request_limits
        SET timestamps_json = ?, updated_at = ?
        WHERE rule_id = ? AND timestamps_json = ?
      `, [nextJson, new Date(nowMs).toISOString(), ruleId, row.timestamps_json]);
    } else {
      result = await run(`
        INSERT OR IGNORE INTO import_rule_request_limits (rule_id, timestamps_json, updated_at)
        VALUES (?, ?, ?)
      `, [ruleId, nextJson, new Date(nowMs).toISOString()]);
    }
    if (result.changes === 1) return 0;
  }
  throw new Error(`Could not reserve content-request quota for import rule ${ruleId}.`);
}

function enrichmentRolloutFromRow(row) {
  if (!row) return null;
  let evaluation = null;
  try { evaluation = row.evaluation_json ? JSON.parse(row.evaluation_json) : null; } catch { evaluation = null; }
  return {
    ruleId: row.rule_id,
    ruleRevision: row.rule_revision || null,
    status: row.status,
    currentPhase: row.current_phase || null,
    currentJobId: row.current_job_id == null ? null : Number(row.current_job_id),
    sampleJobId: row.sample_job_id == null ? null : Number(row.sample_job_id),
    controlJobId: row.control_job_id == null ? null : Number(row.control_job_id),
    lastCohortJobId: row.last_cohort_job_id == null ? null : Number(row.last_cohort_job_id),
    evaluation,
    updatedAt: row.updated_at,
  };
}

export async function getEnrichmentRollout(ruleId) {
  return enrichmentRolloutFromRow(await get(`
    SELECT rule_id, rule_revision, status, current_phase, current_job_id, sample_job_id,
           control_job_id, last_cohort_job_id, evaluation_json, updated_at
    FROM enrichment_rollouts
    WHERE rule_id = ?
  `, [ruleId]));
}

export async function startEnrichmentRolloutPhase(ruleId, phase, jobId, ruleRevision) {
  const currentRule = await getImportRule(ruleId);
  if (!currentRule || importRuleRevision(currentRule) !== ruleRevision) {
    throw new Error(`Import rule ${ruleId} changed after this rollout job was created.`);
  }
  const existing = await getEnrichmentRollout(ruleId);
  const allowed = (
    (phase === 'sample' && (!existing || existing.status === 'invalidated' || (existing.status === 'blocked' && existing.evaluation?.phase === 'sample')))
    || (phase === 'control' && (existing?.status === 'awaiting_control' || (existing?.status === 'blocked' && existing.evaluation?.phase === 'control')))
    || (phase === 'cohort' && (existing?.status === 'ready_for_cohort' || (existing?.status === 'blocked' && existing.evaluation?.phase === 'cohort')))
  );
  if (!allowed) {
    throw new Error(`The ${phase} phase is not allowed while rollout ${ruleId} is ${existing?.status || 'not started'}.`);
  }
  if (existing?.ruleRevision && existing.ruleRevision !== ruleRevision) {
    throw new Error(`Import rule ${ruleId} changed after its rollout evidence was recorded.`);
  }
  const now = new Date().toISOString();
  await run(`
    INSERT INTO enrichment_rollouts (
      rule_id, rule_revision, status, current_phase, current_job_id, updated_at
    ) VALUES (?, ?, 'running', ?, ?, ?)
    ON CONFLICT(rule_id) DO UPDATE SET
      status = 'running',
      rule_revision = excluded.rule_revision,
      current_phase = excluded.current_phase,
      current_job_id = excluded.current_job_id,
      updated_at = excluded.updated_at
  `, [ruleId, ruleRevision, phase, jobId, now]);
  return getEnrichmentRollout(ruleId);
}

export async function saveEnrichmentRolloutEvidence({ ruleId, ruleRevision, phase, jobId, contentMode, outcomes = [] }) {
  const now = new Date().toISOString();
  for (const outcome of outcomes) {
    await run(`
      INSERT INTO enrichment_rollout_evidence (
        rule_id, rule_revision, phase, job_id, doc_id, content_mode, outcome_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id, doc_id) DO UPDATE SET
        outcome_json = excluded.outcome_json,
        content_mode = excluded.content_mode,
        rule_revision = excluded.rule_revision
    `, [ruleId, ruleRevision, phase, jobId, String(outcome.docId), contentMode, JSON.stringify(outcome), now]);
  }
}

export async function listEnrichmentRolloutEvidence({ ruleId, phase = null, jobId = null } = {}) {
  const clauses = ['rule_id = ?'];
  const args = [ruleId];
  if (phase) { clauses.push('phase = ?'); args.push(phase); }
  if (jobId != null) { clauses.push('job_id = ?'); args.push(jobId); }
  const rows = await all(`
    SELECT rule_id, rule_revision, phase, job_id, doc_id, content_mode, outcome_json, created_at
    FROM enrichment_rollout_evidence
    WHERE ${clauses.join(' AND ')}
    ORDER BY id
  `, args);
  return rows.map((row) => {
    let outcome = null;
    try { outcome = JSON.parse(row.outcome_json); } catch { outcome = null; }
    return {
      ruleId: row.rule_id,
      ruleRevision: row.rule_revision || null,
      phase: row.phase,
      jobId: Number(row.job_id),
      docId: row.doc_id,
      contentMode: row.content_mode,
      outcome,
      createdAt: row.created_at,
    };
  });
}

export async function finishEnrichmentRolloutPhase(ruleId, phase, jobId, evaluation) {
  const status = evaluation?.passed
    ? phase === 'sample'
      ? 'awaiting_control'
      : phase === 'cohort' && evaluation.exhausted ? 'completed' : 'ready_for_cohort'
    : 'blocked';
  const jobColumn = phase === 'sample'
    ? 'sample_job_id'
    : phase === 'control' ? 'control_job_id' : 'last_cohort_job_id';
  const now = new Date().toISOString();
  await run(`
    UPDATE enrichment_rollouts
    SET status = ?, current_phase = NULL, current_job_id = NULL,
        ${jobColumn} = ?, evaluation_json = ?, updated_at = ?
    WHERE rule_id = ? AND current_job_id = ?
  `, [status, jobId, JSON.stringify(evaluation), now, ruleId, jobId]);
  return getEnrichmentRollout(ruleId);
}

export async function failEnrichmentRolloutForJob(jobId, error) {
  const row = await get(`
    SELECT rule_id, current_phase
    FROM enrichment_rollouts
    WHERE current_job_id = ? AND status = 'running'
  `, [jobId]);
  if (!row) return null;
  const evaluation = {
    passed: false,
    phase: row.current_phase,
    interrupted: true,
    error: error?.message || String(error || 'Worker interrupted'),
  };
  const now = new Date().toISOString();
  await run(`
    UPDATE enrichment_rollouts
    SET status = 'blocked', current_phase = NULL, current_job_id = NULL,
        evaluation_json = ?, updated_at = ?
    WHERE rule_id = ? AND current_job_id = ?
  `, [JSON.stringify(evaluation), now, row.rule_id, jobId]);
  return getEnrichmentRollout(row.rule_id);
}

// --- Cache integrity ---

export async function checkCacheIntegrity() {
  const entries = await all('SELECT doc_id, pdf_path FROM file_metrics WHERE pdf_path IS NOT NULL');
  let missing = 0;
  for (const entry of entries) {
    try {
      await fs.access(entry.pdf_path);
    } catch {
      missing += 1;
      logger.warn('Cache integrity: PDF file missing on disk', { docId: entry.doc_id, path: entry.pdf_path });
    }
  }
  if (missing > 0) {
    logger.warn(`Cache integrity check: ${missing} of ${entries.length} cached PDFs missing from disk`);
  } else {
    logger.info(`Cache integrity check: all ${entries.length} cached PDFs present on disk`);
  }
}

// --- Committee functions ---

export async function saveCommitteeMembers(docId, members, source) {
  const now = new Date().toISOString();
  const seen = new Set();
  const cleaned = [];
  for (const member of members || []) {
    const role = member.role || 'Committee Member';
    const normalizedName = normalizePersonName(member.name);
    if (!normalizedName) continue;
    const key = `${String(role || '')}:::${supervisorNameKey(normalizedName) || normalizedName.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const personKey = documentPersonKey(normalizedName);
    cleaned.push({ member, role, normalizedName, personKey });
  }
  if (!cleaned.length) return;

  const client = await getDb();
  const transaction = await client.transaction('write');
  try {
    for (const { member, role, normalizedName, personKey } of cleaned) {
      await transaction.execute({
        sql: `
        INSERT INTO committee_members (doc_id, name, role, affiliation, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_id, name, role) DO UPDATE SET
          affiliation = CASE
            WHEN committee_members.source = 'api' AND excluded.source <> 'api'
              THEN committee_members.affiliation
            ELSE excluded.affiliation
          END,
          source = CASE
            WHEN committee_members.source = 'api' AND excluded.source <> 'api'
              THEN committee_members.source
            ELSE excluded.source
          END,
          updated_at = CASE
            WHEN committee_members.source = 'api' AND excluded.source <> 'api'
              THEN committee_members.updated_at
            ELSE excluded.updated_at
          END
        `,
        args: [docId, normalizedName, role, member.affiliation || null, source || 'committee', now],
      });
      if (!personKey) continue;
      const candidates = await transaction.execute({
        sql: `SELECT id, name, role, affiliation, source, updated_at
              FROM committee_members WHERE doc_id = ? AND role = ?`,
        args: [docId, role],
      });
      const winner = authoritativeCommitteeRow(candidates.rows, personKey);
      await transaction.execute({
        sql: `DELETE FROM document_people
              WHERE doc_id = ? AND person_key = ? AND role = ? AND source <> 'metadata'`,
        args: [docId, personKey, role],
      });
      if (winner) {
        await transaction.execute({
          sql: `INSERT INTO document_people
                (doc_id, person_key, name, role, affiliation, source, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            docId, personKey, winner.name, winner.role || 'Committee Member',
            winner.affiliation || null, winner.source || 'committee', winner.updated_at || now,
          ],
        });
      }
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  } finally {
    transaction.close();
  }
}

export async function deleteCommitteeMembersByRoles(docId, roles, source = null) {
  const cleanedRoles = Array.from(new Set((roles || []).map((r) => String(r || '').trim()).filter(Boolean)));
  if (!cleanedRoles.length) return 0;
  const placeholders = cleanedRoles.map(() => '?').join(', ');
  const params = [docId, ...cleanedRoles];
  let sql = `DELETE FROM committee_members WHERE doc_id = ? AND role IN (${placeholders})`;
  if (source) {
    sql += ' AND source = ?';
    params.push(source);
  }
  const client = await getDb();
  const transaction = await client.transaction('write');
  try {
    const before = await transaction.execute({
      sql: `SELECT name, role FROM committee_members WHERE doc_id = ? AND role IN (${placeholders})`,
      args: [docId, ...cleanedRoles],
    });
    const affected = new Map();
    for (const row of before.rows) {
      const personKey = documentPersonKey(row.name);
      if (personKey) affected.set(`${personKey}\u0000${row.role}`, { personKey, role: row.role });
    }
    const result = await transaction.execute({ sql, args: params });
    for (const { personKey, role } of affected.values()) {
      const remaining = await transaction.execute({
        sql: `SELECT id, name, role, affiliation, source, updated_at
              FROM committee_members WHERE doc_id = ? AND role = ?`,
        args: [docId, role],
      });
      const winner = authoritativeCommitteeRow(remaining.rows, personKey);
      await transaction.execute({
        sql: `DELETE FROM document_people
              WHERE doc_id = ? AND person_key = ? AND role = ? AND source <> 'metadata'`,
        args: [docId, personKey, role],
      });
      if (winner) {
        await transaction.execute({
          sql: `INSERT INTO document_people
                (doc_id, person_key, name, role, affiliation, source, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            docId, personKey, winner.name, winner.role || 'Committee Member',
            winner.affiliation || null, winner.source || 'committee', winner.updated_at || new Date().toISOString(),
          ],
        });
      }
    }
    await transaction.commit();
    return changes(result);
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  } finally {
    transaction.close();
  }
}

export async function loadCommitteeMembers(docId) {
  return all(`
    SELECT name, role, affiliation, source
    FROM committee_members
    WHERE doc_id = ?
    ORDER BY id
  `, [docId]);
}

// --- Citation functions ---

function citationMatchYear(value) {
  const text = String(value || '').trim();
  const match = text.match(/\b(1[89]\d{2}|20[0-2]\d)\b/);
  return match ? Number(match[0]) : null;
}

function citationTextPrefix(value) {
  const prefix = String(value || '').trim().toLowerCase().slice(0, 3);
  return prefix.length === 3 ? prefix : null;
}

function prepareCitationForMatching(row) {
  return {
    ...row,
    matchText: String(row.citation_text || '').toLowerCase(),
    matchYear: citationMatchYear(row.year),
    matchPrefix: citationTextPrefix(row.citation_text),
  };
}

function pushBucket(map, key, row) {
  if (key == null) return;
  const existing = map.get(key);
  if (existing) {
    existing.push(row);
  } else {
    map.set(key, [row]);
  }
}

function buildCitationMatchIndex(rows) {
  const index = {
    all: rows,
    byHash: new Map(rows.map((row) => [row.citation_hash, row])),
    byYear: new Map(),
    withoutYear: [],
    byPrefix: new Map(),
  };
  for (const row of rows) {
    if (row.matchYear == null) {
      index.withoutYear.push(row);
    } else {
      pushBucket(index.byYear, row.matchYear, row);
    }
    pushBucket(index.byPrefix, row.matchPrefix, row);
  }
  return index;
}

function addCitationToMatchIndex(index, row) {
  index.all.push(row);
  index.byHash.set(row.citation_hash, row);
  if (row.matchYear == null) {
    index.withoutYear.push(row);
  } else {
    pushBucket(index.byYear, row.matchYear, row);
  }
  pushBucket(index.byPrefix, row.matchPrefix, row);
}

function fuzzyMatchCandidates(index, text, itemYear) {
  const year = citationMatchYear(itemYear) ?? citationMatchYear(text);
  const prefix = citationTextPrefix(text);
  if (year != null) {
    const candidates = [];
    for (let candidateYear = year - 1; candidateYear <= year + 1; candidateYear += 1) {
      candidates.push(...(index.byYear.get(candidateYear) || []));
    }
    if (prefix) {
      candidates.push(...(index.byPrefix.get(prefix) || []).filter((row) => row.matchYear == null));
    }
    return candidates.length ? candidates : index.all;
  }

  if (!prefix) return index.all;
  const candidates = index.byPrefix.get(prefix) || [];
  return candidates.length ? candidates : index.all;
}

const FUZZY_CITATION_THRESHOLD = 0.94;

function fuzzyYearsCompatible(a, b) {
  return a == null || b == null || a === b;
}

export async function saveCitations(docId, citations, hashFn, { onProgress = null } = {}) {
  const now = new Date().toISOString();
  
  // Fetch once, then bucket in memory so fuzzy matching avoids scanning every citation.
  const existingCitations = (await all('SELECT id, citation_hash, citation_text, author, title, year FROM citations'))
    .map(prepareCitationForMatching);
  const matchIndex = buildCitationMatchIndex(existingCitations);
  const linkedIds = [];
  const counts = {
    processed: 0,
    total: citations.length,
    exactMatches: 0,
    fuzzyMatches: 0,
    newCitations: 0,
  };
  await onProgress?.({
    phase: 'citation_matching',
    label: 'Matching citations',
    status: 'running',
    counts,
  });

  for (const item of citations) {
    const text = typeof item === 'string' ? item : item.text;
    const hash = hashFn(text);
    
    let matchedId = null;
    let matchedHash = hash;
    let matchedBy = null;

    // 1. Exact match check
    if (matchIndex.byHash.has(hash)) {
      matchedId = matchIndex.byHash.get(hash).id;
      matchedHash = hash;
      matchedBy = 'exact';
    } else {
      // 2. Fuzzy match check
      const candidates = fuzzyMatchCandidates(
        matchIndex,
        text,
        typeof item === 'string' ? null : item.year
      );

      let bestMatch = null;
      let maxSim = 0;

      const incomingMatchText = text.toLowerCase();
      for (const candidate of candidates) {
        const sim = jaroWinkler(incomingMatchText, candidate.matchText);
        if (sim > maxSim) {
          maxSim = sim;
          bestMatch = candidate;
        }
      }

      const incomingYear = citationMatchYear(typeof item === 'string' ? null : item.year)
        ?? citationMatchYear(text);
      if (
        bestMatch
        && maxSim >= FUZZY_CITATION_THRESHOLD
        && fuzzyYearsCompatible(incomingYear, bestMatch.matchYear)
      ) {
        matchedId = bestMatch.id;
        matchedHash = bestMatch.citation_hash;
        matchedBy = 'fuzzy';
        logger.info('Fuzzy matched citation', {
          incoming: text.slice(0, 50),
          matched: bestMatch.citation_text.slice(0, 50),
          similarity: maxSim
        });
      }
    }

    if (matchedId) {
      if (matchedBy === 'exact') counts.exactMatches += 1;
      if (matchedBy === 'fuzzy') counts.fuzzyMatches += 1;
      await run(`
        INSERT INTO document_citations (doc_id, citation_id, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(doc_id, citation_id) DO UPDATE SET updated_at = excluded.updated_at
      `, [docId, matchedId, now]);
      linkedIds.push(matchedId);
    } else {
      counts.newCitations += 1;
      await run(`
        INSERT INTO citations (citation_hash, citation_text, author, title, year, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(citation_hash) DO UPDATE SET
          author = COALESCE(excluded.author, citations.author),
          title = COALESCE(excluded.title, citations.title),
          year = COALESCE(excluded.year, citations.year),
          source = COALESCE(excluded.source, citations.source)
      `, [
        hash, text,
        (typeof item === 'string' ? null : item.author) || null,
        (typeof item === 'string' ? null : item.title) || null,
        (typeof item === 'string' ? null : item.year) || null,
        (typeof item === 'string' ? null : item.source) || null,
        now
      ]);
      const row = await get('SELECT id, citation_hash, citation_text, author, title, year FROM citations WHERE citation_hash = ?', [hash]);
      if (row) {
        addCitationToMatchIndex(matchIndex, prepareCitationForMatching(row));
        await run(`
          INSERT INTO document_citations (doc_id, citation_id, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(doc_id, citation_id) DO UPDATE SET updated_at = excluded.updated_at
        `, [docId, row.id, now]);
        linkedIds.push(row.id);
      }
    }
    counts.processed += 1;
    if (counts.processed === counts.total || counts.processed % 10 === 0) {
      await onProgress?.({
        phase: 'citation_matching',
        label: 'Matching citations',
        status: counts.processed === counts.total ? 'completed' : 'running',
        counts: { ...counts },
      });
    }
  }
  return linkedIds;
}

export async function loadDocumentCitations(docId) {
  return all(`
    SELECT c.citation_text
    FROM document_citations dc
    JOIN citations c ON c.id = dc.citation_id
    WHERE dc.doc_id = ?
    ORDER BY c.id
  `, [docId]);
}

export async function loadDocumentCitationsWithSharing(docId) {
  return all(`
    WITH doc_cites AS (
      SELECT citation_id FROM document_citations WHERE doc_id = ?
    ),
    sharing AS (
      SELECT dc.citation_id, COUNT(DISTINCT dc.doc_id) AS total_docs
      FROM document_citations dc
      WHERE dc.citation_id IN (SELECT citation_id FROM doc_cites)
      GROUP BY dc.citation_id
    )
    SELECT c.id, c.citation_hash, c.citation_text,
      s.total_docs,
      cl.hits AS catalogue_hits,
      cl.query_author AS catalogue_query_author,
      cl.query_title AS catalogue_query_title,
      cl.bib_id AS catalogue_bib_id,
      cl.looked_up_at AS catalogue_looked_up_at
    FROM doc_cites dc
    JOIN citations c ON c.id = dc.citation_id
    JOIN sharing s ON s.citation_id = dc.citation_id
    LEFT JOIN catalogue_lookups cl ON cl.citation_id = dc.citation_id
    ORDER BY s.total_docs DESC, c.citation_text
  `, [docId]);
}

export async function loadDocsByCitation(citationId) {
  return all(`
    SELECT d.doc_id as id, json_extract(d.metadata_json, '$.title') as title,
      json_extract(d.metadata_json, '$.author') as author
    FROM document_citations dc
    JOIN documents d ON d.doc_id = dc.doc_id
    WHERE dc.citation_id = ?
    ORDER BY title
  `, [citationId]);
}

// Re-extraction entry point: saves the new citation set, then prunes only the
// links that no longer match, so catalogue lookups on surviving citations are
// preserved. Replaces the old clearDocumentCitations + saveCitations pattern,
// which destroyed catalogue lookups for citations that survived the reparse.
export async function reextractDocumentCitations(docId, citations, hashFn, options = {}) {
  let linkedIds = [];
  if (citations.length) {
    linkedIds = await saveCitations(docId, citations, hashFn, options);
  }
  await replaceDocumentCitationLinks(docId, linkedIds);
  return linkedIds;
}

export async function replaceDocumentCitationLinks(docId, keepCitationIds = []) {
  const keep = new Set(
    (keepCitationIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
  );
  const existing = await all('SELECT citation_id FROM document_citations WHERE doc_id = ?', [docId]);
  const stale = existing
    .map((row) => Number(row.citation_id))
    .filter((id) => !keep.has(id));
  const chunkSize = 900;
  for (let i = 0; i < stale.length; i += chunkSize) {
    const chunk = stale.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    await run(`DELETE FROM document_citations WHERE doc_id = ? AND citation_id IN (${placeholders})`, [docId, ...chunk]);
  }
  await exec('DELETE FROM catalogue_lookups WHERE citation_id NOT IN (SELECT DISTINCT citation_id FROM document_citations)');
  await exec('DELETE FROM citations WHERE id NOT IN (SELECT DISTINCT citation_id FROM document_citations)');
}

export async function clearAllCitations() {
  await exec('DELETE FROM catalogue_lookups');
  await exec('DELETE FROM document_citations');
  await exec('DELETE FROM citations');
}

export async function getCitationStats() {
  return get(`
    SELECT
      (SELECT COUNT(*) FROM citations) AS total_citations,
      (SELECT COUNT(*) FROM document_citations) AS total_links
  `);
}

export async function listPendingCitationExtractions({
  limit = 100, afterDocId = '', syncKey = null, filters: requestedFilters = {},
  parserVersion = 'citation-v1',
} = {}) {
  const filters = documentServingFilters({ syncKey, ...requestedFilters });
  const qualifier = filters.where ? 'AND' : 'WHERE';
  return all(`
    SELECT d.doc_id, d.metadata_json,
           fm.pdf_path, fm.full_text_path,
           COALESCE(fm.content_checksum, fm.updated_at, '') AS content_checksum,
           fm.content_source, fm.parser_version
    FROM documents d
    JOIN file_metrics fm ON fm.doc_id = d.doc_id
    LEFT JOIN citation_extraction_state ces ON ces.doc_id = d.doc_id
    ${filters.where}
    ${qualifier} d.doc_id > ?
      AND (fm.pdf_path IS NOT NULL OR fm.full_text_path IS NOT NULL)
      AND (
        ces.doc_id IS NULL
        OR ces.status <> 'completed'
        OR ces.parser_version <> ?
        OR COALESCE(ces.content_checksum, '') <> COALESCE(fm.content_checksum, fm.updated_at, '')
      )
    ORDER BY d.doc_id
    LIMIT ?
  `, [
    ...filters.args,
    String(afterDocId || ''),
    String(parserVersion || 'citation-v1'),
    Math.max(1, Math.min(1000, Number(limit) || 100)),
  ]);
}

export async function saveCitationExtractionState(docId, {
  contentChecksum = null, parserVersion = 'citation-v1', status = 'completed',
  citationCount = 0, error = null,
} = {}) {
  const now = new Date().toISOString();
  await run(`
    INSERT INTO citation_extraction_state (
      doc_id, content_checksum, parser_version, status, citation_count, error, extracted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_id) DO UPDATE SET
      content_checksum = excluded.content_checksum,
      parser_version = excluded.parser_version,
      status = excluded.status,
      citation_count = excluded.citation_count,
      error = excluded.error,
      extracted_at = excluded.extracted_at
  `, [
    docId, contentChecksum || null, parserVersion || 'citation-v1', status,
    Math.max(0, Number(citationCount) || 0), error || null, now,
  ]);
}

// --- Catalogue lookup functions ---

export async function saveCatalogueLookup(citationId, { hits, queryAuthor, queryTitle, bibId }) {
  const now = new Date().toISOString();
  await run(`
    INSERT INTO catalogue_lookups (citation_id, hits, query_author, query_title, bib_id, looked_up_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(citation_id) DO UPDATE SET
      hits = excluded.hits,
      query_author = excluded.query_author,
      query_title = excluded.query_title,
      bib_id = excluded.bib_id,
      looked_up_at = excluded.looked_up_at
  `, [citationId, hits ?? null, queryAuthor || null, queryTitle || null, bibId || null, now]);
}

export async function loadCatalogueLookup(citationId) {
  return get(`
    SELECT citation_id, hits, query_author, query_title, looked_up_at
    FROM catalogue_lookups
    WHERE citation_id = ?
  `, [citationId]);
}

export async function getCitationForSummon(citationId) {
  return get(`
    SELECT c.citation_text, cl.query_title, cl.query_author
    FROM citations c
    LEFT JOIN catalogue_lookups cl ON cl.citation_id = c.id
    WHERE c.id = ?
  `, [citationId]);
}

export async function getCatalogueLookupStats() {
  const row = await get(`
    SELECT
      (SELECT COUNT(*) FROM catalogue_lookups) AS total,
      (SELECT COUNT(*) FROM catalogue_lookups WHERE hits > 0) AS found,
      (SELECT COUNT(*) FROM catalogue_lookups WHERE hits = 0) AS not_found,
      (SELECT COUNT(*) FROM catalogue_lookups WHERE hits = -1) AS failed,
      (SELECT COUNT(*) FROM catalogue_lookups WHERE hits IS NULL) AS skipped,
      (
        (SELECT COUNT(*) FROM citations)
        - (SELECT COUNT(*) FROM catalogue_lookups)
        + (
          SELECT COUNT(*)
          FROM catalogue_lookups
          WHERE hits IS NULL
            AND query_title IS NOT NULL
        )
      ) AS pending
  `);
  return {
    total: Number(row?.total || 0),
    found: Number(row?.found || 0),
    not_found: Number(row?.not_found || 0),
    failed: Number(row?.failed || 0),
    skipped: Number(row?.skipped || 0),
    pending: Number(row?.pending || 0),
  };
}

export async function getTopicBuildStatus() {
  const topicRow = await get('SELECT COUNT(*) AS total, MAX(created_at) AS created_at FROM topics');
  const docRow = await get('SELECT COUNT(DISTINCT doc_id) AS total FROM document_topics');
  const coordRow = await get('SELECT COUNT(*) AS total FROM document_topic_coords');
  const hierarchyRow = await get('SELECT created_at FROM topic_hierarchy_meta WHERE id = 1');
  return {
    topics: Number(topicRow?.total || 0),
    createdAt: topicRow?.created_at || null,
    assignedDocuments: Number(docRow?.total || 0),
    coordinates: Number(coordRow?.total || 0),
    hierarchyCreatedAt: hierarchyRow?.created_at || null,
  };
}

function pendingLookupOptions(limitOrOptions = 100) {
  if (limitOrOptions && typeof limitOrOptions === 'object') {
    return {
      limit: Math.max(1, Math.min(1000, Number(limitOrOptions.limit) || 100)),
      syncKey: limitOrOptions.syncKey || null,
      filters: limitOrOptions.filters || {},
    };
  }
  return { limit: Math.max(1, Math.min(1000, Number(limitOrOptions) || 100)), syncKey: null, filters: {} };
}

function pendingLookupScope({ syncKey = null, filters: requestedFilters = {} } = {}) {
  const filters = documentServingFilters({ syncKey, ...requestedFilters });
  if (!filters.where) return { sql: '', args: [] };
  return {
    sql: `AND EXISTS (
      SELECT 1
      FROM document_citations scoped_dc
      JOIN documents d ON d.doc_id = scoped_dc.doc_id
      WHERE scoped_dc.citation_id = c.id
        AND ${filters.where.replace(/^WHERE\s+/, '')}
    )`,
    args: filters.args,
  };
}

export async function listPendingLookups(limitOrOptions = 100) {
  const options = pendingLookupOptions(limitOrOptions);
  const scope = pendingLookupScope(options);
  return all(`
    SELECT c.id, c.citation_text, c.author, c.title, c.year, c.source
    FROM (
      SELECT c.id, c.citation_text, c.author, c.title, c.year, c.source
      FROM catalogue_lookups cl
      JOIN citations c ON c.id = cl.citation_id
      WHERE cl.hits IS NULL
        AND cl.query_title IS NOT NULL
      UNION ALL
      SELECT c.id, c.citation_text, c.author, c.title, c.year, c.source
      FROM citations c
      WHERE NOT EXISTS (
        SELECT 1 FROM catalogue_lookups cl WHERE cl.citation_id = c.id
      )
    ) c
    WHERE 1 = 1 ${scope.sql}
    ORDER BY (
      SELECT COUNT(*) FROM document_citations priority_dc WHERE priority_dc.citation_id = c.id
    ) DESC, c.id ASC
    LIMIT ?
  `, [...scope.args, options.limit]);
}

export async function countPendingLookups(options = {}) {
  const scope = pendingLookupScope(pendingLookupOptions({ ...options, limit: 1 }));
  const row = await get(`
    SELECT COUNT(*) AS total
    FROM citations c
    WHERE (
      NOT EXISTS (SELECT 1 FROM catalogue_lookups cl WHERE cl.citation_id = c.id)
      OR EXISTS (
        SELECT 1 FROM catalogue_lookups cl
        WHERE cl.citation_id = c.id AND cl.hits IS NULL AND cl.query_title IS NOT NULL
      )
    )
    ${scope.sql}
  `, scope.args);
  return Number(row?.total || 0);
}

export async function getCitationCooccurrence(limit = 100) {
  return all(`
    WITH top_citations AS (
      SELECT citation_id, COUNT(DISTINCT doc_id) AS cnt
      FROM document_citations
      GROUP BY citation_id
      HAVING cnt >= 2
      ORDER BY cnt DESC
      LIMIT 50
    )
    SELECT
      c1.id AS id1, substr(c1.citation_text, 1, 80) AS text1, tc1.cnt AS freq1,
      c2.id AS id2, substr(c2.citation_text, 1, 80) AS text2, tc2.cnt AS freq2,
      COUNT(DISTINCT dc1.doc_id) AS shared
    FROM document_citations dc1
    JOIN document_citations dc2
      ON dc1.doc_id = dc2.doc_id AND dc1.citation_id < dc2.citation_id
    JOIN citations c1 ON c1.id = dc1.citation_id
    JOIN citations c2 ON c2.id = dc2.citation_id
    JOIN top_citations tc1 ON tc1.citation_id = c1.id
    JOIN top_citations tc2 ON tc2.citation_id = c2.id
    GROUP BY dc1.citation_id, dc2.citation_id
    HAVING shared >= 2
    ORDER BY shared DESC
    LIMIT ?
  `, [limit]);
}

export async function getTopCitedWorks(limit = 50) {
  return all(`
    SELECT c.id, c.citation_text,
      COUNT(DISTINCT dc.doc_id) AS doc_count,
      cl.hits AS catalogue_hits,
      cl.bib_id AS catalogue_bib_id
    FROM citations c
    JOIN document_citations dc ON dc.citation_id = c.id
    LEFT JOIN catalogue_lookups cl ON cl.citation_id = c.id
    GROUP BY c.id
    HAVING doc_count > 1
    ORDER BY doc_count DESC, c.citation_text
    LIMIT ?
  `, [limit]);
}

// --- Topic functions ---

export async function hasTopics() {
  try {
    const row = await get('SELECT 1 FROM topics LIMIT 1');
    return !!row;
  } catch {
    return false;
  }
}

export async function loadTopics() {
  const rows = await all('SELECT topic_id, label, top_terms, doc_count, model_name, created_at FROM topics ORDER BY doc_count DESC');
  return rows.map((row) => ({
    topicId: Number(row.topic_id),
    label: row.label,
    topTerms: (() => { try { return JSON.parse(row.top_terms); } catch { return []; } })(),
    docCount: Number(row.doc_count),
    modelName: row.model_name,
    createdAt: row.created_at,
  }));
}

export async function loadDocumentTopics(docIds) {
  let rows;
  if (Array.isArray(docIds) && docIds.length > 0) {
    const chunkSize = 999;
    rows = [];
    for (let i = 0; i < docIds.length; i += chunkSize) {
      const chunk = docIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const chunkRows = await all(`
        SELECT doc_id, topic_id, probability
        FROM document_topics
        WHERE doc_id IN (${placeholders})
      `, chunk);
      rows.push(...chunkRows);
    }
  } else {
    rows = await all('SELECT doc_id, topic_id, probability FROM document_topics');
  }
  const map = new Map();
  for (const row of rows) {
    map.set(row.doc_id, { topicId: Number(row.topic_id), probability: row.probability != null ? Number(row.probability) : null });
  }
  return map;
}

function parseJsonValue(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function mapTopicLabelCandidate(row) {
  return {
    id: Number(row.id),
    runId: row.run_id != null ? Number(row.run_id) : null,
    topicId: Number(row.topic_id),
    label: row.label,
    source: row.source,
    score: Number(row.score || 0),
    status: row.status,
    warnings: parseJsonValue(row.warnings_json, []),
    evidence: parseJsonValue(row.evidence_json, {}),
    createdAt: row.created_at,
  };
}

export async function createTopicLabelRun({ backend, modelName, status = 'running', config = null }) {
  const now = new Date().toISOString();
  const result = await execute(`
    INSERT INTO topic_label_runs (backend, model_name, status, config_json, started_at)
    VALUES (?, ?, ?, ?, ?)
  `, [backend || 'unknown', modelName || 'unknown', status, config ? JSON.stringify(config) : null, now]);
  return Number(result.lastInsertRowid || result.lastInsertId || 0);
}

export async function finishTopicLabelRun(runId, { status = 'completed', error = null } = {}) {
  await run(`
    UPDATE topic_label_runs
    SET status = ?, error = ?, finished_at = ?
    WHERE id = ?
  `, [status, error, new Date().toISOString(), Number(runId)]);
}

export async function listTopicLabelReviews() {
  const [topics, candidates, overrides, docRows, runs] = await Promise.all([
    all('SELECT topic_id, label, top_terms, doc_count, model_name, created_at FROM topics ORDER BY doc_count DESC'),
    all(`
      SELECT id, run_id, topic_id, label, source, score, status, warnings_json, evidence_json, created_at
      FROM topic_label_candidates
      ORDER BY topic_id, score DESC, created_at DESC
    `),
    all('SELECT topic_id, label, source, candidate_id, created_at, updated_at FROM topic_label_overrides'),
    all(`
      SELECT dt.topic_id, d.metadata_json
      FROM document_topics dt
      JOIN documents d ON d.doc_id = dt.doc_id
      ORDER BY dt.topic_id, dt.probability DESC
    `),
    all('SELECT id, backend, model_name, status, config_json, error, started_at, finished_at FROM topic_label_runs ORDER BY id DESC LIMIT 5'),
  ]);

  const candidatesByTopic = new Map();
  for (const row of candidates) {
    const candidate = mapTopicLabelCandidate(row);
    if (!candidatesByTopic.has(candidate.topicId)) candidatesByTopic.set(candidate.topicId, []);
    candidatesByTopic.get(candidate.topicId).push(candidate);
  }

  const overrideByTopic = new Map(overrides.map((row) => [Number(row.topic_id), {
    topicId: Number(row.topic_id),
    label: row.label,
    source: row.source,
    candidateId: row.candidate_id != null ? Number(row.candidate_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }]));

  const titlesByTopic = new Map();
  for (const row of docRows) {
    const topicId = Number(row.topic_id);
    const list = titlesByTopic.get(topicId) || [];
    if (list.length >= 5) continue;
    const metadata = parseJsonValue(row.metadata_json, {});
    const title = String(metadata?.title || '').trim();
    if (!title || list.includes(title)) continue;
    list.push(title);
    titlesByTopic.set(topicId, list);
  }

  const reviewTopics = topics.map((row) => {
    const topicId = Number(row.topic_id);
    const topicCandidates = candidatesByTopic.get(topicId) || [];
    const override = overrideByTopic.get(topicId) || null;
    const selected = topicCandidates.find((candidate) => ['selected', 'auto_selected'].includes(candidate.status)) || null;
    const warnings = Array.from(new Set(topicCandidates.flatMap((candidate) => candidate.warnings || [])));
    const pendingReview = topicId !== -1 && !override && (
      !selected || topicCandidates.some((candidate) => candidate.status === 'pending' && (candidate.warnings || []).length)
    );
    return {
      topicId,
      label: row.label,
      topTerms: parseJsonValue(row.top_terms, []),
      docCount: Number(row.doc_count),
      modelName: row.model_name,
      createdAt: row.created_at,
      candidates: topicCandidates,
      override,
      selectedCandidateId: selected?.id || null,
      representativeTitles: titlesByTopic.get(topicId) || [],
      warnings,
      pendingReview,
    };
  });

  return {
    topics: reviewTopics,
    runs: runs.map((row) => ({
      id: Number(row.id),
      backend: row.backend,
      modelName: row.model_name,
      status: row.status,
      config: parseJsonValue(row.config_json, null),
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    })),
    summary: {
      total: reviewTopics.length,
      pendingReview: reviewTopics.filter((topic) => topic.pendingReview).length,
      overrides: reviewTopics.filter((topic) => topic.override).length,
      duplicateLabels: (() => {
        const counts = new Map();
        for (const topic of reviewTopics) counts.set(topic.label, (counts.get(topic.label) || 0) + 1);
        return Array.from(counts.entries()).filter(([, count]) => count > 1).map(([label, count]) => ({ label, count }));
      })(),
    },
  };
}

export async function selectTopicLabelCandidate(topicId, candidateId) {
  const candidate = await get(`
    SELECT id, topic_id, label
    FROM topic_label_candidates
    WHERE id = ? AND topic_id = ?
  `, [Number(candidateId), Number(topicId)]);
  if (!candidate) return null;
  const now = new Date().toISOString();
  await run('UPDATE topic_label_candidates SET status = ? WHERE topic_id = ? AND status != ?', ['rejected', Number(topicId), 'rejected']);
  await run('UPDATE topic_label_candidates SET status = ? WHERE id = ?', ['selected', Number(candidateId)]);
  await run('UPDATE topics SET label = ? WHERE topic_id = ?', [candidate.label, Number(topicId)]);
  await run(`
    INSERT INTO topic_label_overrides (topic_id, label, source, candidate_id, created_at, updated_at)
    VALUES (?, ?, 'selected', ?, ?, ?)
    ON CONFLICT(topic_id) DO UPDATE SET
      label = excluded.label,
      source = excluded.source,
      candidate_id = excluded.candidate_id,
      updated_at = excluded.updated_at
  `, [Number(topicId), candidate.label, Number(candidateId), now, now]);
  return { topicId: Number(topicId), label: candidate.label, candidateId: Number(candidateId) };
}

export async function updateTopicManualLabel(topicId, label) {
  const normalized = String(label || '').trim();
  if (!normalized) return null;
  const existing = await get('SELECT topic_id FROM topics WHERE topic_id = ?', [Number(topicId)]);
  if (!existing) return null;
  const now = new Date().toISOString();
  await run('UPDATE topics SET label = ? WHERE topic_id = ?', [normalized, Number(topicId)]);
  await run(`
    INSERT INTO topic_label_overrides (topic_id, label, source, candidate_id, created_at, updated_at)
    VALUES (?, ?, 'manual', NULL, ?, ?)
    ON CONFLICT(topic_id) DO UPDATE SET
      label = excluded.label,
      source = excluded.source,
      candidate_id = NULL,
      updated_at = excluded.updated_at
  `, [Number(topicId), normalized, now, now]);
  return { topicId: Number(topicId), label: normalized };
}

export async function deleteTopicLabelOverride(topicId) {
  const result = await run('DELETE FROM topic_label_overrides WHERE topic_id = ?', [Number(topicId)]);
  return result.changes > 0;
}

export async function publishPassingTopicLabels() {
  const rows = await all(`
    SELECT c.id, c.topic_id, c.label, c.score, c.warnings_json
    FROM topic_label_candidates c
    LEFT JOIN topic_label_overrides o ON o.topic_id = c.topic_id
    WHERE o.topic_id IS NULL
      AND c.status IN ('pending', 'selected', 'auto_selected')
    ORDER BY c.topic_id, c.score DESC, c.created_at DESC
  `);
  const bestByTopic = new Map();
  for (const row of rows) {
    const topicId = Number(row.topic_id);
    if (bestByTopic.has(topicId)) continue;
    const warnings = parseJsonValue(row.warnings_json, []);
    if (Number(row.score || 0) < 80 || warnings.length) continue;
    bestByTopic.set(topicId, row);
  }

  for (const [topicId, row] of bestByTopic.entries()) {
    await run('UPDATE topic_label_candidates SET status = ? WHERE topic_id = ? AND status != ?', ['rejected', topicId, 'rejected']);
    await run('UPDATE topic_label_candidates SET status = ? WHERE id = ?', ['auto_selected', Number(row.id)]);
    await run('UPDATE topics SET label = ? WHERE topic_id = ?', [row.label, topicId]);
  }

  return { published: bestByTopic.size };
}

export async function loadDocumentTopicCoords(docIds) {
  try {
    let rows;
    if (Array.isArray(docIds) && docIds.length > 0) {
      const chunkSize = 999;
      rows = [];
      for (let i = 0; i < docIds.length; i += chunkSize) {
        const chunk = docIds.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(', ');
        const chunkRows = await all(`
          SELECT doc_id, umap_x, umap_y
          FROM document_topic_coords
          WHERE doc_id IN (${placeholders})
        `, chunk);
        rows.push(...chunkRows);
      }
    } else {
      rows = await all('SELECT doc_id, umap_x, umap_y FROM document_topic_coords');
    }
    const map = new Map();
    for (const row of rows) {
      map.set(row.doc_id, { x: Number(row.umap_x), y: Number(row.umap_y) });
    }
    return map;
  } catch {
    return new Map();
  }
}

export async function loadTopicHierarchy() {
  try {
    const row = await get('SELECT leaf_topic_ids, linkage_json FROM topic_hierarchy_meta WHERE id = 1');
    if (!row) return null;
    return {
      leafTopicIds: JSON.parse(row.leaf_topic_ids),
      linkage: JSON.parse(row.linkage_json),
    };
  } catch { return null; }
}

export async function logCacheStats() {
  const stats = await getFileMetricsStats();
  logger.info('PDF cache stats', {
    totalEntries: stats.total,
    totalBytes: stats.total_bytes,
    withPdf: stats.with_pdf,
    failed: stats.failed,
    oldest: stats.oldest,
    newest: stats.newest,
  });
}

export async function loadStoredEmbeddings(docIds) {
  let rows;
  if (Array.isArray(docIds) && docIds.length > 0) {
    const chunkSize = 999;
    rows = [];
    for (let i = 0; i < docIds.length; i += chunkSize) {
      const chunk = docIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const chunkRows = await all(`
        SELECT doc_id, embedding
        FROM document_embeddings
        WHERE doc_id IN (${placeholders})
      `, chunk);
      rows.push(...chunkRows);
    }
  } else {
    rows = await all('SELECT doc_id, embedding FROM document_embeddings');
  }
  const map = new Map();
  for (const row of rows) {
    map.set(row.doc_id, JSON.parse(row.embedding));
  }
  return map;
}

export async function saveStoredEmbeddings(embeddingsList) {
  const now = new Date().toISOString();
  for (const item of embeddingsList) {
    await run(`
      INSERT OR REPLACE INTO document_embeddings (doc_id, embedding, created_at)
      VALUES (?, ?, ?)
    `, [item.docId, JSON.stringify(item.embedding), now]);
  }
}
