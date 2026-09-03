import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@libsql/client';
import { SQLITE_PATH, PDF_CACHE_DIR, FULL_TEXT_CACHE_DIR, TURSO_AUTH_TOKEN, TURSO_DATABASE_URL } from './config.js';
import { logger } from './logger.js';
import { dedupeSupervisorNames, normalizePersonName, stripMiddleInitials, supervisorNameKey } from './supervisors.js';
import { encryptMfaSecret, decryptMfaSecret } from './secretCrypto.js';
import { jaroWinkler } from './fuzzyMatch.js';
import { documentThemeTerms, COOCCURRENCE_BLOCKLIST } from './nlp.js';
import { buildParentClusters, buildTopicsByYearFromCounts } from './topicHierarchy.js';
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
    // Separate local SQLite clients can arrive during a migration at the same
    // time (for example, concurrent worker processes). Schema migrations are
    // idempotent, so retry the complete startup pass on SQLITE_BUSY instead of
    // letting a transient schema-read lock prevent a singleton claimant from
    // reaching its durable lease.
    schemaReady = ensureSchemaWithRetry(db);
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

// --- #18/#23: transient-DB retry classification and backoff ---
//
// A libsql connection blip (a closed websocket, a dropped HTTP round trip) can
// surface at any statement. Retrying blindly is only safe for calls whose
// underlying writes are provably idempotent (see the seven wrapped functions
// below, `withDbRetry`'s own call sites) — this is deliberately NOT a blanket
// wrap of `execute`/`client.batch`, since a non-idempotent write retried after
// an ambiguous "did it commit" failure risks double-applying it.

// Jittered exponential backoff: base * factor^attempt, ±jitterRatio jitter,
// capped at capMs. `attempt` is 0-based (the delay *before* attempt N, N>=1).
export function computeBackoffDelayMs(attempt, {
  baseMs = 25, factor = 2, jitterRatio = 0.3, capMs = 5_000, random = Math.random,
} = {}) {
  const raw = Math.min(capMs, baseMs * (factor ** Math.max(0, attempt)));
  const jitter = raw * jitterRatio * (random() * 2 - 1); // +/- jitterRatio
  return Math.max(1, Math.round(raw + jitter));
}

const TRANSIENT_DB_CODES = new Set([
  'HRANA_WEBSOCKET_ERROR', 'HRANA_CLOSED_ERROR', 'HRANA_PROTO_ERROR',
  'SERVER_ERROR', 'INTERNAL_ERROR', 'UNKNOWN',
]);
const PERMANENT_DB_CODES = new Set(['PROTOCOL_VERSION_ERROR', 'TRANSACTION_CLOSED']);
const TRANSIENT_MESSAGE_PATTERN = /ECONNRESET|ETIMEDOUT|EPIPE|fetch failed|socket hang up|network/i;

// Classifies a caught error as 'transient' (worth retrying — a connection blip
// with no evidence the statement committed) or 'permanent' (a schema/syntax/
// data problem no retry can fix, or an error we cannot positively identify as
// transient — defaulting an unrecognized error to permanent is deliberate:
// masking a real bug as routine flakiness is worse than under-retrying).
export function classifyDbError(error) {
  const code = String(error?.code || '');
  if (TRANSIENT_DB_CODES.has(code) || /^SQLITE_BUSY|^SQLITE_LOCKED/.test(code)) return 'transient';
  if (PERMANENT_DB_CODES.has(code) || /^SQLITE_CONSTRAINT|^SQLITE_MISUSE|^SQLITE_ERROR/.test(code)) {
    return 'permanent';
  }
  if (error?.name === 'MisuseError') return 'permanent';
  if (!code) {
    const message = `${error?.message || ''} ${error?.cause?.message || ''}`;
    if (TRANSIENT_MESSAGE_PATTERN.test(message)) return 'transient';
  }
  return 'permanent';
}

const DB_RETRY_MAX_ATTEMPTS = Number(process.env.DB_RETRY_MAX_ATTEMPTS) || 4;

// Retries `fn` only on a `classifyDbError(error) === 'transient'` result, with
// jittered exponential backoff between attempts. A permanent error, or a
// transient one that survives every retry, is re-thrown unwrapped so the
// caller's own classification (e.g. sync.js's per-document vs. page-level
// boundary) still sees the original error shape.
export async function withDbRetry(fn, {
  label = 'db-operation', maxAttempts = DB_RETRY_MAX_ATTEMPTS, wait = defaultRetryWait,
  backoff = computeBackoffDelayMs,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt >= Math.max(1, maxAttempts) - 1;
      if (isLastAttempt || classifyDbError(error) !== 'transient') throw error;
      logger.warn('Retrying transient DB error', {
        label, attempt: attempt + 1, maxAttempts, error: error?.message || String(error),
      });
      // eslint-disable-next-line no-await-in-loop
      await wait(backoff(attempt));
    }
  }
  throw lastError;
}

function defaultRetryWait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function exec(sql) {
  const client = await getDb();
  await client.executeMultiple(sql);
}

// A few pre-IF-NOT-EXISTS migrations remain for databases that were created by
// older releases.  Those statements may legitimately report that the named
// schema object already exists.  Do not turn this into a general migration
// error sink: a lock needs to reach ensureSchemaWithRetry, and any other error
// (bad SQL, a missing table, an incompatible schema, etc.) must fail startup.
function isAlreadyAppliedLegacyDdlError(error) {
  const message = String(error?.message || '');
  return /duplicate column name|(?:index|table)\s+.+\s+already exists/i.test(message);
}

export async function tryExec(client, sql, {
  ignoreError = isAlreadyAppliedLegacyDdlError,
} = {}) {
  try {
    await client.executeMultiple(sql);
    return true;
  } catch (error) {
    // Never swallow a database lock: getDb wraps the complete schema pass in
    // a bounded retry, so this must propagate to that outer boundary.
    if (classifyDbError(error) === 'transient') throw error;
    if (ignoreError?.(error)) {
      return false;
    }
    throw error;
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
      word_count_comparison_json TEXT,
      status TEXT,
      error TEXT,
      updated_at TEXT NOT NULL
    );

    -- Durable enrichment progress (H-03). Kept out of file_metrics on purpose:
    -- a marker row in file_metrics would count towards the cache statistics and
    -- would suppress the 'not_found' failure record that saveFileMetric only
    -- writes when no metric row exists yet.
    CREATE TABLE IF NOT EXISTS enrichment_attempts (
      doc_id TEXT PRIMARY KEY,
      attempted_at TEXT NOT NULL
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
      local_queue_seen INTEGER NOT NULL DEFAULT 0,
      upstream_unique_seen INTEGER NOT NULL DEFAULT 0,
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
      execution_id TEXT,
      progress_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    -- A durable singleton lease for job types that must never overlap.  A
    -- separate row (rather than a process-local check) makes the decision
    -- safe when two HTTP replicas receive the same request at once.
    CREATE TABLE IF NOT EXISTS admin_job_singletons (
      type TEXT PRIMARY KEY,
      job_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Durable reconciliation requests for singleton processors. If eligible
    -- work appears after the active job has passed it, the web dispatcher
    -- starts one fresh pass after the singleton lease becomes available.
    CREATE TABLE IF NOT EXISTS admin_job_followups (
      type TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      params_json TEXT,
      request_token TEXT NOT NULL,
      requested_at TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS import_rule_eligibility_projections (
      rule_id TEXT PRIMARY KEY,
      current_token TEXT,
      completed_token TEXT,
      rule_revision TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (rule_id) REFERENCES import_rules(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS rule_document_processing_eligibility (
      rule_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      projection_token TEXT NOT NULL,
      projected_at TEXT NOT NULL,
      PRIMARY KEY (rule_id, doc_id, projection_token),
      FOREIGN KEY (rule_id) REFERENCES import_rules(id) ON DELETE CASCADE,
      FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS document_processing_state (
      doc_id TEXT NOT NULL,
      processor TEXT NOT NULL,
      status TEXT NOT NULL,
      content_checksum TEXT,
      processor_version TEXT,
      error TEXT,
      attempted_at TEXT NOT NULL,
      PRIMARY KEY (doc_id, processor),
      FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS processing_eligibility_activation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      activated_at TEXT NOT NULL
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
  // #17: These counters distinguish local enrichment retries from records
  // observed during the upstream OC scan.  Use the verified, idempotent helper
  // rather than tryExec so an actual migration failure cannot be mistaken for
  // an already-applied column on a concurrently starting replica.
  await addColumnIfMissing(client, 'sync_runs', 'local_queue_seen', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing(client, 'sync_runs', 'upstream_unique_seen', 'INTEGER NOT NULL DEFAULT 0');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN runner_type TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN runner_id TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN runner_state TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN heartbeat_at TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN timeout_at TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN cancelled_at TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN artifact_token_hash TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN claimed_at TEXT');
  await tryExec(client, 'ALTER TABLE admin_jobs ADD COLUMN execution_id TEXT');
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
  await addColumnIfMissing(client, 'file_metrics', 'word_count_comparison_json', 'TEXT');
  await addColumnIfMissing(client, 'import_rules', 'content_mode', "TEXT NOT NULL DEFAULT 'metadata_only'");
  await addColumnIfMissing(client, 'import_rules', 'content_fallback', "TEXT NOT NULL DEFAULT 'fail_document'");
  await addColumnIfMissing(client, 'import_rules', 'extract_citations', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing(client, 'import_rules', 'extract_committee', 'INTEGER NOT NULL DEFAULT 1');
  await addColumnIfMissing(client, 'import_rules', 'run_concepts', 'INTEGER NOT NULL DEFAULT 1');
  await addColumnIfMissing(client, 'import_rules', 'max_content_bytes', 'INTEGER NOT NULL DEFAULT 209715200');
  await addColumnIfMissing(client, 'import_rules', 'content_concurrency', 'INTEGER NOT NULL DEFAULT 1');
  await addColumnIfMissing(client, 'import_rules', 'content_rate_limit', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing(client, 'import_rule_eligibility_projections', 'rule_revision', 'TEXT');
  await addColumnIfMissing(client, 'enrichment_rollouts', 'rule_revision', 'TEXT');
  await addColumnIfMissing(client, 'enrichment_rollout_evidence', 'rule_revision', 'TEXT');
  // Citation match keys (M-06 / B-01). `year` is free text and the match year is a
  // regex extraction from it, so an index on the raw column cannot serve the fuzzy
  // candidate query. These columns persist exactly what citationMatchYear() and
  // citationTextPrefix() derive, so the buckets that used to be built in memory
  // become indexed range scans.
  await addColumnIfMissing(client, 'citations', 'match_year', 'INTEGER');
  await addColumnIfMissing(client, 'citations', 'match_prefix', 'TEXT');
  await addColumnIfMissing(client, 'citations', 'match_key_version', 'INTEGER NOT NULL DEFAULT 0');
  await tryExec(client, 'CREATE TABLE IF NOT EXISTS enrichment_attempts (doc_id TEXT PRIMARY KEY, attempted_at TEXT NOT NULL)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_documents_sync_key ON documents(sync_key)');
  // Deliberately NOT an index on documents(sync_key, doc_id). It would serve the
  // enrichment queue's ordered scan, but it also makes the filtered_people CTE in
  // queryPeoplePage look cheap enough to inline and re-evaluate once per matched
  // person: 5,100 documents took that query from 70 ms to 126 s. The queue drives
  // off the doc_id primary key instead - see listDocumentsPendingEnrichment.
  await tryExec(client, 'DROP INDEX IF EXISTS idx_documents_sync_key_doc_id');
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
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_rule_document_eligibility_doc ON rule_document_processing_eligibility(doc_id, rule_id, projection_token)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_import_rules_processing_policy ON import_rules(extract_citations, run_concepts, id)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_document_processing_state_queue ON document_processing_state(processor, status, doc_id)');
  await client.execute('CREATE INDEX IF NOT EXISTS idx_enrichment_evidence_rule_phase ON enrichment_rollout_evidence(rule_id, phase, job_id)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_username ON password_reset_tokens(username)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON password_reset_tokens(expires_at)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_document_citations_citation_id ON document_citations(citation_id)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_document_citations_citation_doc ON document_citations(citation_id, doc_id)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_catalogue_lookups_hits_query_title ON catalogue_lookups(hits, query_title)');
  // Fuzzy candidate buckets for saveCitations: the trailing `id` keeps each bucket
  // in insertion order so the capped read is an ordered index range scan.
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_citations_match_year ON citations(match_year, id)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_citations_match_prefix ON citations(match_prefix, match_year, id)');
  // Partial index over rows still awaiting match-key backfill. It carries the
  // columns the backfill reads so the probe is a covering scan, and it empties
  // itself as the backfill runs — once the corpus is done the probe reads nothing.
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_citations_match_pending ON citations(id, citation_text, year) WHERE match_key_version = 0');
  // checkCacheIntegrity reads only these two columns, so a partial covering index
  // turns its full table scan into an index scan over cached PDFs alone.
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_file_metrics_pdf_path ON file_metrics(doc_id, pdf_path) WHERE pdf_path IS NOT NULL');
  // Cover the citation scan's streamable-source probe by doc id and checksum.
  // The earlier content_source-only index stored the same constant in every row
  // and did not shrink as scans completed, so it added little value.
  await tryExec(client, 'DROP INDEX IF EXISTS idx_file_metrics_content_source');
  await tryExec(client, `
    CREATE INDEX IF NOT EXISTS idx_file_metrics_streamed_scan
    ON file_metrics(doc_id, content_checksum)
    WHERE content_source = 'streamed_pdf'
      AND content_checksum IS NOT NULL
      AND content_checksum <> ''
  `);
  // scope_where() in build-concepts.py filters every automatic partition by
  // degree plus a year range on each PatternRank run.
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_documents_degree_year ON documents(degree, year)');

  await backfillCitationMatchKeys(client);

  const cleaned = await cleanupCommitteeArtifacts(client);
  if (cleaned > 0) logger.info(`Cleaned up ${cleaned} committee artefact rows`);
  await backfillDocumentPeopleProjection(client);
  await backfillSourceJsonProvenance(client);
}

// Exported for migration tests and for callers that need to initialise a
// separately constructed client.  Keeping the retry around the complete,
// idempotent schema pass means a lock at any migration statement restarts from
// a known boundary and remains bounded by withDbRetry's maxAttempts.
export function ensureSchemaWithRetry(client, retryOptions = {}) {
  return withDbRetry(() => ensureSchema(client), {
    label: 'ensureSchema',
    // Worker processes can cold-start together and each runs the idempotent
    // migration pass. Give the winning process enough time to release its DDL
    // lock before treating another worker as unhealthy.
    maxAttempts: 10,
    ...retryOptions,
  });
}

const SOURCE_JSON_TRIM_STATE_KEY = 'source_json_trim';
const SOURCE_JSON_TRIM_BATCH = 500;

// #28 migration: rewrites every existing documents.source_json row (which may
// currently hold the full upstream OC record, including a full_text/
// transcript/text/ocr/body-shaped field) to the trimmed { id, sourceUpdatedAt }
// provenance stub produced by trimmedSourceProvenance(). One-time and
// idempotent: once serving_projection_state records 'source_json_trim' as
// 'complete', later calls (every server startup runs ensureSchema) are a
// single no-op read. Rows with NULL or malformed source_json are left
// untouched rather than throwing — there is nothing to trim. This is
// distinct from, and does not touch, sync_runs.source_json (a per-run
// request-options record on a different table, not per-document upstream
// data).
export async function backfillSourceJsonProvenance(dbInstance = null) {
  const client = dbInstance || await getDb();
  const state = await client.execute({
    sql: 'SELECT projection_value FROM serving_projection_state WHERE projection_key = ?',
    args: [SOURCE_JSON_TRIM_STATE_KEY],
  });
  if (String(state.rows[0]?.projection_value || '') === 'complete') return 0;

  let total = 0;
  let cursor = '';
  for (;;) {
    const result = await client.execute({
      sql: `
        SELECT doc_id, source_json
        FROM documents
        WHERE doc_id > ? AND source_json IS NOT NULL
        ORDER BY doc_id
        LIMIT ?
      `,
      args: [cursor, SOURCE_JSON_TRIM_BATCH],
    });
    if (!result.rows.length) break;
    const statements = [];
    for (const row of result.rows) {
      cursor = row.doc_id;
      let parsed = null;
      try { parsed = JSON.parse(row.source_json); } catch { parsed = null; }
      if (!parsed || typeof parsed !== 'object') continue; // malformed JSON: leave unchanged
      const trimmed = trimmedSourceProvenance(parsed);
      const nextJson = trimmed ? JSON.stringify(trimmed) : null;
      if (nextJson === row.source_json) continue; // already trimmed: no write needed
      statements.push({
        sql: 'UPDATE documents SET source_json = ? WHERE doc_id = ?',
        args: [nextJson, row.doc_id],
      });
    }
    if (statements.length) {
      await client.batch(statements, 'write');
      total += statements.length;
    }
  }

  await client.execute({
    sql: `
      INSERT INTO serving_projection_state (projection_key, projection_value, updated_at)
      VALUES (?, 'complete', ?)
      ON CONFLICT(projection_key) DO UPDATE SET
        projection_value = excluded.projection_value,
        updated_at = excluded.updated_at
    `,
    args: [SOURCE_JSON_TRIM_STATE_KEY, new Date().toISOString()],
  });
  if (total > 0) logger.info(`Trimmed source_json provenance for ${total} documents`);
  return total;
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

// #28: documents.source_json is a provenance stub, never a full-record cache.
// This is an allowlist, not a denylist: only `id`/`sourceUpdatedAt` are ever
// read off `source` here, so `full_text`/`FullText`/`transcript`/`text`/`ocr`/
// `body` (or any other upstream field) can never ride into source_json
// through this path, regardless of what shape a caller passes as `source`.
// This is a standing invariant enforced at the write path, not a one-time
// cleanup — do not widen this to a spread or a denylist-based filter without
// re-auditing every call site that constructs a `source` object.
function trimmedSourceProvenance(source) {
  if (!source || typeof source !== 'object') return null;
  const id = source.id ?? source._id ?? source.identifier ?? source.Identifier ?? null;
  const sourceUpdatedAt = source.sourceUpdatedAt ?? source.updatedAt ?? source.updated_at
    ?? source.date_updated ?? source.dateModified ?? null;
  if (id == null && sourceUpdatedAt == null) return null;
  return { id, sourceUpdatedAt };
}

function documentColumns(doc, syncKey = null, source = null) {
  const provenance = trimmedSourceProvenance(source);
  return {
    syncKey,
    title: doc.title || null,
    author: doc.author || null,
    year: doc.year ?? null,
    degree: doc.degree || null,
    program: doc.program || null,
    sourceJson: provenance ? JSON.stringify(provenance) : null,
    sourceUpdatedAt: provenance?.sourceUpdatedAt || null,
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

// Retry-safe (#18 Layer A): one atomic client.batch() — a DELETE-then-upsert of
// document_people rows plus the document upsert — so a full retry after an
// ambiguous failure always re-runs the same leading DELETE and re-converges to
// the same end state. Do not add a plain (non-upserting) INSERT to this
// function without re-auditing this guarantee.
export async function saveDocumentMetadata(doc, { syncKey = null, source = null } = {}) {
  return withDbRetry(async () => {
    doc = withStoredThemes(doc);
    const now = new Date().toISOString();
    const client = await getDb();
    await client.batch([
      saveDocumentStatement(doc, { syncKey, source }, now),
      ...metadataPeopleStatements(doc, now),
    ], 'write');
  }, { label: 'saveDocumentMetadata' });
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

const ID_CHUNK_SIZE = 999;

function normalizeDocIdList(docIds) {
  return Array.from(new Set(
    (Array.isArray(docIds) ? docIds : [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean)
  ));
}

// Batched form of documentExists (H-05). Every statement is a network round trip
// against Turso, so a page of sync records must cost one SELECT, not one per record.
export async function documentsExist(docIds = []) {
  const ids = normalizeDocIdList(docIds);
  const found = new Set();
  if (!ids.length) return found;
  for (let i = 0; i < ids.length; i += ID_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await all(`SELECT doc_id FROM documents WHERE doc_id IN (${placeholders})`, chunk);
    for (const row of rows) found.add(String(row.doc_id));
  }
  return found;
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
           fm.page_count, fm.word_source, fm.page_source, fm.status, fm.error,
           fm.word_count_comparison_json
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
           fm.word_count_comparison_json,
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
           fm.word_count_comparison_json,
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

// #15: SQL ports of five of the six panels that previously went silently
// empty above DETAILED_ANALYTICS_RECORD_LIMIT. Each mirrors a JS aggregator
// in metrics.js closely enough to be behaviorally equivalent on real
// ingested data (docConceptTerms() short-circuits to the stored
// `conceptTerms` array for every real document, so a direct
// json_each(d.metadata_json, '$.conceptTerms') read reproduces it) — proven
// per-panel by a JS-vs-SQL cross-check test on an identical fixture rather
// than assumed. `termCooccurrence` (pairwise combinatorics, the same
// unbounded-self-join shape #25/#26 already had to bound) is deliberately
// NOT ported here — it is served as a bounded real sample at the route layer
// (metricsRoutes.js), reusing buildTermCooccurrence from metrics.js, since
// db.js cannot import metrics.js without a circular dependency.

async function computeConceptTimelineSql(filters, qualifier, topN = 8) {
  const blocklistJson = JSON.stringify([...COOCCURRENCE_BLOCKLIST]);
  const topConcepts = await all(`
    SELECT trim(CAST(term.value AS TEXT)) AS concept, COUNT(DISTINCT d.doc_id) AS total_docs
    FROM documents d, json_each(d.metadata_json, '$.conceptTerms') term
    ${filters.where}
    ${qualifier} trim(CAST(term.value AS TEXT)) <> ''
      AND trim(CAST(term.value AS TEXT)) NOT IN (SELECT value FROM json_each(?))
    GROUP BY concept
    ORDER BY total_docs DESC, concept ASC
    LIMIT ?
  `, [...filters.args, blocklistJson, topN]);
  if (!topConcepts.length) return [];

  const conceptListJson = JSON.stringify(topConcepts.map((row) => row.concept));
  const yearRows = await all(`
    SELECT trim(CAST(term.value AS TEXT)) AS concept, d.year AS year, COUNT(DISTINCT d.doc_id) AS count
    FROM documents d, json_each(d.metadata_json, '$.conceptTerms') term
    ${filters.where}
    ${qualifier} d.year IS NOT NULL
      AND trim(CAST(term.value AS TEXT)) IN (SELECT value FROM json_each(?))
    GROUP BY concept, d.year
  `, [...filters.args, conceptListJson]);

  const yearsByConcept = new Map();
  for (const row of yearRows) {
    if (!yearsByConcept.has(row.concept)) yearsByConcept.set(row.concept, []);
    yearsByConcept.get(row.concept).push({ year: Number(row.year), count: Number(row.count || 0) });
  }
  return topConcepts.map((row) => ({
    concept: row.concept,
    totalDocs: Number(row.total_docs || 0),
    data: (yearsByConcept.get(row.concept) || []).sort((a, b) => a.year - b.year),
  }));
}

async function computeMethodologyConceptMatrixSql(filters, qualifier, topM = 10, topC = 10) {
  const topMethodologies = await all(`
    SELECT trim(CAST(m.value AS TEXT)) AS methodology, COUNT(*) AS count
    FROM documents d, json_each(d.metadata_json, '$.methodologies') m
    ${filters.where}
    ${qualifier} trim(CAST(m.value AS TEXT)) <> ''
    GROUP BY methodology
    ORDER BY count DESC, methodology ASC
    LIMIT ?
  `, [...filters.args, topM]);
  if (!topMethodologies.length) {
    return { methodologies: [], concepts: [], conceptIds: [], matrix: [] };
  }

  // Mirrors buildMethodologyConceptMatrix's own weighting exactly: a
  // document's concept counts are incremented once per methodology on that
  // document (the JS loop increments conceptCounts *inside* the methodology
  // loop), so a document with 2 methodologies weights its concepts' ranking
  // score by 2, not 1. This only affects which concepts land in the top-C
  // set, not the final cross-tab values below.
  const topConcepts = await all(`
    SELECT trim(CAST(term.value AS TEXT)) AS concept,
           SUM((SELECT COUNT(*) FROM json_each(d.metadata_json, '$.methodologies'))) AS weighted_count
    FROM documents d, json_each(d.metadata_json, '$.conceptTerms') term
    ${filters.where}
    ${qualifier} term.key < 10
      AND trim(CAST(term.value AS TEXT)) <> ''
      AND EXISTS (SELECT 1 FROM json_each(d.metadata_json, '$.methodologies'))
    GROUP BY concept
    ORDER BY weighted_count DESC, concept ASC
    LIMIT ?
  `, [...filters.args, topC]);
  if (!topConcepts.length) {
    return { methodologies: topMethodologies.map((r) => r.methodology), concepts: [], conceptIds: [], matrix: [] };
  }

  const methList = topMethodologies.map((r) => r.methodology);
  const conceptList = topConcepts.map((r) => r.concept);
  const cellRows = await all(`
    SELECT trim(CAST(m.value AS TEXT)) AS methodology,
           trim(CAST(term.value AS TEXT)) AS concept,
           COUNT(*) AS count
    FROM documents d,
         json_each(d.metadata_json, '$.methodologies') m,
         json_each(d.metadata_json, '$.conceptTerms') term
    ${filters.where}
    ${qualifier} term.key < 10
      AND trim(CAST(m.value AS TEXT)) IN (SELECT value FROM json_each(?))
      AND trim(CAST(term.value AS TEXT)) IN (SELECT value FROM json_each(?))
    GROUP BY methodology, concept
  `, [...filters.args, JSON.stringify(methList), JSON.stringify(conceptList)]);

  const methIndex = new Map(methList.map((name, i) => [name, i]));
  const conceptIndex = new Map(conceptList.map((name, i) => [name, i]));
  const matrix = methList.map(() => conceptList.map(() => 0));
  for (const row of cellRows) {
    const mi = methIndex.get(row.methodology);
    const ci = conceptIndex.get(row.concept);
    if (mi == null || ci == null) continue;
    matrix[mi][ci] = Number(row.count || 0);
  }

  return {
    methodologies: methList,
    concepts: conceptList,
    conceptIds: conceptList.map((label) => `c:${label.replace(/\s+/g, '_')}`),
    matrix,
  };
}

async function computeMethodologyTopicMatrixSql(filters, qualifier, topics) {
  const topMethodologies = await all(`
    SELECT trim(CAST(m.value AS TEXT)) AS methodology, COUNT(*) AS count
    FROM documents d, json_each(d.metadata_json, '$.methodologies') m
    ${filters.where}
    ${qualifier} trim(CAST(m.value AS TEXT)) <> ''
    GROUP BY methodology
    ORDER BY count DESC, methodology ASC
    LIMIT 10
  `, filters.args);
  const validTopics = topics.filter((t) => t.topicId !== -1).slice(0, 8);
  if (!topMethodologies.length || !validTopics.length) {
    return { methodologies: topMethodologies.map((r) => r.methodology), topics: validTopics.map((t) => ({ topicId: t.topicId, label: t.label })), matrix: [] };
  }

  const methList = topMethodologies.map((r) => r.methodology);
  const topicIdList = validTopics.map((t) => t.topicId);
  const cellRows = await all(`
    SELECT dt.topic_id AS topic_id, trim(CAST(m.value AS TEXT)) AS methodology, COUNT(DISTINCT d.doc_id) AS count
    FROM documents d
    JOIN document_topics dt ON dt.doc_id = d.doc_id
    , json_each(d.metadata_json, '$.methodologies') m
    ${filters.where}
    ${qualifier} dt.topic_id IN (SELECT value FROM json_each(?))
      AND trim(CAST(m.value AS TEXT)) IN (SELECT value FROM json_each(?))
    GROUP BY dt.topic_id, methodology
  `, [...filters.args, JSON.stringify(topicIdList), JSON.stringify(methList)]);

  const methIndex = new Map(methList.map((name, i) => [name, i]));
  const topicIndex = new Map(topicIdList.map((id, i) => [id, i]));
  const matrix = methList.map(() => topicIdList.map(() => 0));
  for (const row of cellRows) {
    const mi = methIndex.get(row.methodology);
    const ti = topicIndex.get(Number(row.topic_id));
    if (mi == null || ti == null) continue;
    matrix[mi][ti] = Number(row.count || 0);
  }

  return {
    methodologies: methList,
    topics: validTopics.map((t) => ({ topicId: t.topicId, label: t.label })),
    matrix,
  };
}

async function computeTopicDataByYearSql(filters, qualifier, topics, hierarchy) {
  const parentInfo = hierarchy ? buildParentClusters(hierarchy, topics) : null;
  const rows = await all(`
    SELECT dt.topic_id AS topic_id, d.year AS year, COUNT(*) AS count
    FROM documents d
    JOIN document_topics dt ON dt.doc_id = d.doc_id
    ${filters.where}
    ${qualifier} d.year IS NOT NULL
    GROUP BY dt.topic_id, d.year
  `, filters.args);
  const countRows = rows.map((row) => ({
    topicId: Number(row.topic_id), year: Number(row.year), count: Number(row.count || 0),
  }));
  return parentInfo
    ? buildTopicsByYearFromCounts(parentInfo.parentClusters, countRows, parentInfo.leafToParent)
    : buildTopicsByYearFromCounts(topics, countRows);
}

// #15 supervisorNgramMatrix filter decision (per the plan's review
// correction): role IN ('Supervisor', 'Co-Supervisor') regardless of
// `source`, DISTINCT person_key. The JS path's `rec.supervisors` (what
// buildSupervisorNgramMatrix in metrics.js actually counts) is populated by
// applyCommitteeMembersToDocuments, which merges committee-derived
// Supervisor/Co-Supervisor names into `rec.supervisors` alongside
// metadata-sourced ones — those committee rows land in document_people with
// source values other than 'metadata' ('api', 'pdf_fallback', 'committee').
// A `source = 'metadata'`-only filter would silently undercount. DISTINCT is
// required because the same person can have both a metadata row and a
// committee row for the same document (differing `source`), which would
// otherwise double-count that document for that person.
//
// Known simplification: a person's display name is taken as MIN(p.name)
// across their rows, which is a deterministic but arbitrary tiebreak when
// different sources spell the same person's name differently. The JS path's
// name string is whichever source added them to `rec.supervisors` first.
// This does not affect *who* is counted or their doc counts, only which
// spelling variant is displayed when sources disagree — disclosed here
// rather than silently assumed correct.
async function computeSupervisorNgramMatrixSql(filters, qualifier, topN = 12, topM = 10) {
  const supervisorFilters = filters.where
    ? `${filters.where} AND p.role IN ('Supervisor', 'Co-Supervisor')`
    : `WHERE p.role IN ('Supervisor', 'Co-Supervisor')`;
  const topSupervisors = await all(`
    SELECT p.person_key AS person_key, MIN(p.name) AS name, COUNT(DISTINCT p.doc_id) AS count
    FROM document_people p
    JOIN documents d ON d.doc_id = p.doc_id
    ${supervisorFilters}
    GROUP BY p.person_key
    ORDER BY count DESC, name ASC
    LIMIT ?
  `, [...filters.args, topN]);
  if (!topSupervisors.length) return { supervisors: [], ngrams: [], conceptIds: [], matrix: [] };

  const topNgrams = await all(`
    SELECT trim(CAST(term.value AS TEXT)) AS concept, COUNT(DISTINCT d.doc_id) AS count
    FROM documents d, json_each(d.metadata_json, '$.conceptTerms') term
    ${filters.where}
    ${qualifier} term.key < 10
      AND trim(CAST(term.value AS TEXT)) <> ''
      AND EXISTS (
        SELECT 1 FROM document_people p
        WHERE p.doc_id = d.doc_id AND p.role IN ('Supervisor', 'Co-Supervisor')
      )
    GROUP BY concept
    ORDER BY count DESC, concept ASC
    LIMIT ?
  `, [...filters.args, topM]);
  if (!topNgrams.length) {
    return {
      supervisors: topSupervisors.map((r) => r.name),
      ngrams: [], conceptIds: [], matrix: [],
    };
  }

  const supKeyList = topSupervisors.map((r) => r.person_key);
  const ngramList = topNgrams.map((r) => r.concept);
  const cellRows = await all(`
    SELECT p.person_key AS person_key, trim(CAST(term.value AS TEXT)) AS concept, COUNT(DISTINCT d.doc_id) AS count
    FROM documents d
    JOIN document_people p ON p.doc_id = d.doc_id AND p.role IN ('Supervisor', 'Co-Supervisor')
    , json_each(d.metadata_json, '$.conceptTerms') term
    ${filters.where}
    ${qualifier} term.key < 10
      AND p.person_key IN (SELECT value FROM json_each(?))
      AND trim(CAST(term.value AS TEXT)) IN (SELECT value FROM json_each(?))
    GROUP BY p.person_key, concept
  `, [...filters.args, JSON.stringify(supKeyList), JSON.stringify(ngramList)]);

  const supIndex = new Map(supKeyList.map((key, i) => [key, i]));
  const ngramIndex = new Map(ngramList.map((label, i) => [label, i]));
  const matrix = supKeyList.map(() => ngramList.map(() => 0));
  for (const row of cellRows) {
    const si = supIndex.get(row.person_key);
    const ni = ngramIndex.get(row.concept);
    if (si == null || ni == null) continue;
    matrix[si][ni] = Number(row.count || 0);
  }

  return {
    supervisors: topSupervisors.map((r) => r.name),
    ngrams: ngramList,
    conceptIds: ngramList.map((label) => `c:${label.replace(/\s+/g, '_')}`),
    matrix,
  };
}

/**
 * Metadata-scale analytics computed as bounded SQL aggregates. This deliberately
 * returns no document collection; document rows have their own paginated API.
 */
export async function getDocumentServingAnalytics({ syncKey = null, filters: requestedFilters = {}, subjectLimit = 25 } = {}) {
  const filters = documentServingFilters({ syncKey, ...requestedFilters });
  const qualifier = filters.where ? 'AND' : 'WHERE';
  const activeWords = 'COALESCE(fm.body_word_count, fm.word_count)';
  const reliableWords = `${activeWords} >= 1000 AND COALESCE(fm.word_source, '') NOT IN ('metadata_text', 'degraded_pdf_text')`;
  const reliablePages = `fm.page_count >= 10 AND COALESCE(fm.page_source, '') NOT IN ('estimated_from_metadata_words', 'estimated_from_full_text_words')`;

  const analyticsRows = await Promise.all([
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
    computeConceptTimelineSql(filters, qualifier),
    computeMethodologyConceptMatrixSql(filters, qualifier),
    hasTopics(),
  ]);
  const [
    overall, yearCounts, wordRows, pageRows, themes, concepts, methodologies,
    conceptTimeline, methodologyConceptMatrix, topicsExist,
  ] = analyticsRows;

  // supervisorNgramMatrix, methodologyTopicMatrix, and topicData all need
  // topics/hierarchy state that isn't known until hasTopics() resolves, so
  // they run in a second, smaller wave rather than the main Promise.all
  // above (which itself still runs everything independent of topic state
  // concurrently, per #24's original layout).
  const [supervisorNgramMatrix, methodologyTopicMatrixAndTopicData] = await Promise.all([
    computeSupervisorNgramMatrixSql(filters, qualifier),
    (async () => {
      if (!topicsExist) return { methodologyTopicMatrix: { methodologies: [], topics: [], matrix: [] }, topicData: null };
      const topics = await loadTopics();
      const [methodologyTopicMatrix, hierarchy] = await Promise.all([
        computeMethodologyTopicMatrixSql(filters, qualifier, topics),
        loadTopicHierarchy(),
      ]);
      const byYear = await computeTopicDataByYearSql(filters, qualifier, topics, hierarchy);
      return { methodologyTopicMatrix, topicData: { topics, byYear } };
    })(),
  ]);
  const { methodologyTopicMatrix, topicData } = methodologyTopicMatrixAndTopicData;

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
    // #15: five of six panels are now real SQL-backed aggregates, computed
    // above next to the other bounded aggregates in this function.
    // termCooccurrence has no SQL port (see the comment above this
    // function) — it stays null here; the caller (metricsRoutes.js) is
    // responsible for filling it with a bounded, disclosed-sample answer.
    supervisorNgramMatrix,
    termCooccurrence: null,
    conceptTimeline,
    methodologyConceptMatrix,
    topicData,
    methodologyTopicMatrix,
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
           fm.word_count_comparison_json,
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
             page_count, word_source, page_source, status, error,
             word_count_comparison_json
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
  if (row.word_count_comparison_json) {
    try {
      const comparison = JSON.parse(row.word_count_comparison_json);
      doc.paradata = { ...(doc.paradata || {}), wordCountComparison: comparison };
    } catch {
      // Invalid legacy paradata must not make the document itself unreadable.
    }
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

// Retry-safe (#18 Layer A): a single `UPDATE ... WHERE id = ?`, idempotent by
// primary key — re-applying the same patch after an ambiguous failure is safe.
export async function updateSyncRun(id, patch) {
  if (!id) return;
  const fields = [];
  const args = [];
  for (const [key, column] of Object.entries({
    status: 'status',
    totalSeen: 'total_seen',
    localQueueSeen: 'local_queue_seen',
    upstreamUniqueSeen: 'upstream_unique_seen',
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
  return withDbRetry(
    () => run(`UPDATE sync_runs SET ${fields.join(', ')} WHERE id = ?`, args),
    { label: 'updateSyncRun' }
  );
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
    localQueueSeen: Number(row.local_queue_seen || 0),
    upstreamUniqueSeen: Number(row.upstream_unique_seen || 0),
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
    localQueueSeen: Number(row.local_queue_seen || 0),
    upstreamUniqueSeen: Number(row.upstream_unique_seen || 0),
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
    executionId: row.execution_id || null,
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

export async function requestAdminJobFollowup({ type, label, params = null }) {
  const now = new Date().toISOString();
  const requestToken = crypto.randomUUID();
  await run(`
    INSERT INTO admin_job_followups (type, label, params_json, request_token, requested_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(type) DO UPDATE SET
      label = excluded.label,
      params_json = excluded.params_json,
      request_token = excluded.request_token,
      requested_at = excluded.requested_at
  `, [type, label, params ? JSON.stringify(params) : null, requestToken, now]);
  return { type, requestToken, requestedAt: now };
}

export async function listAdminJobFollowups() {
  const result = await execute(`
    SELECT type, label, params_json, request_token, requested_at
    FROM admin_job_followups
    ORDER BY requested_at, type
  `);
  return result.rows.map((row) => ({
    type: String(row.type),
    label: String(row.label),
    params: (() => { try { return row.params_json ? JSON.parse(row.params_json) : null; } catch { return null; } })(),
    requestToken: String(row.request_token),
    requestedAt: String(row.requested_at),
  }));
}

export async function completeAdminJobFollowup(type, requestToken) {
  const result = await run(
    'DELETE FROM admin_job_followups WHERE type = ? AND request_token = ?',
    [type, requestToken]
  );
  return result.changes > 0;
}

// Atomically creates a running job only when this type has no running owner.
// `admin_job_singletons` is deliberately a lease table instead of a partial
// unique index on admin_jobs: a citation continuation is queued before its
// current worker finishes, so the lease can be handed to the child without a
// window in which a scheduled/manual request starts a competing scan.
//
// `replaceRunningJobId` is used solely by that continuation hand-off. It may
// replace the lease only when the caller owns it; every other caller receives
// the current job id. This works across local SQLite and multi-replica libSQL.
export async function createAdminJobIfNotRunning({
  type, label, params = null, artifactTokenHash = null, timeoutAt = null, runnerType = null,
  replaceRunningJobId = null,
}) {
  // SQLite rejects a second simultaneous write transaction with SQLITE_BUSY;
  // retrying the entire acquire-or-observe operation is safe because the
  // singleton lease makes a committed first attempt observable as the same
  // job on every later attempt.
  return withDbRetry(() => createAdminJobIfNotRunningOnce({
    type, label, params, artifactTokenHash, timeoutAt, runnerType, replaceRunningJobId,
  }), {
    label: `createAdminJobIfNotRunning:${type}`,
    // A burst of independently starting workers may still be completing their
    // schema passes. The singleton operation is idempotent and safe to retry.
    maxAttempts: 10,
  });
}

async function createAdminJobIfNotRunningOnce({
  type, label, params = null, artifactTokenHash = null, timeoutAt = null, runnerType = null,
  replaceRunningJobId = null,
}) {
  const client = await getDb();
  const now = new Date().toISOString();
  const singleton = await client.execute({
    sql: 'SELECT job_id FROM admin_job_singletons WHERE type = ?', args: [type],
  });
  const leaseJobId = Number(singleton.rows[0]?.job_id || 0);
  let expectedLeaseJobId = -1;
  if (leaseJobId > 0) {
    const current = await client.execute({
      sql: `SELECT id, status, timeout_at, heartbeat_at, claimed_at, started_at
            FROM admin_jobs WHERE id = ?`, args: [leaseJobId],
    });
    const row = current.rows[0];
    const nowMs = Date.now();
    const timedOut = row?.status === 'running' && (
      (row.timeout_at && Date.parse(row.timeout_at) <= nowMs)
      || (!row.timeout_at && Date.parse(row.heartbeat_at || row.claimed_at || row.started_at) <= nowMs - STALE_HEARTBEAT_MS)
    );
    if (timedOut) {
      const staleCutoff = new Date(nowMs - STALE_HEARTBEAT_MS).toISOString();
      await client.execute({
        sql: `UPDATE admin_jobs
              SET status = 'timed_out', runner_state = 'timed_out',
                  error = COALESCE(error, 'Admin worker timed out or stopped heartbeating.'),
                  finished_at = ?, artifact_token_hash = NULL
              WHERE id = ? AND status = 'running'
                AND (timeout_at <= ? OR (timeout_at IS NULL AND COALESCE(heartbeat_at, claimed_at, started_at) <= ?))`,
        args: [now, leaseJobId, now, staleCutoff],
      });
    } else if (row?.status === 'running' && leaseJobId !== Number(replaceRunningJobId || 0)) {
      return { jobId: leaseJobId, created: false };
    }
    // A completed/timed-out owner may be replaced. A continuation uses the
    // same compare-and-swap path, but only if it still owns the current lease.
    expectedLeaseJobId = leaseJobId;
  } else {
    // Databases upgraded while a job was already running have no lease yet.
    // Observing that job is enough to preserve the no-overlap invariant; the
    // next creation after it finishes establishes the durable lease.
    const legacy = await client.execute({
      sql: `SELECT id FROM admin_jobs
            WHERE type = ? AND status = 'running'
            ORDER BY started_at DESC LIMIT 1`,
      args: [type],
    });
    const legacyJobId = Number(legacy.rows[0]?.id || 0);
    if (legacyJobId && legacyJobId !== Number(replaceRunningJobId || 0)) {
      return { jobId: legacyJobId, created: false };
    }
  }

  // `batch(..., 'write')` is an atomic transaction on both adapters, without
  // keeping SQLite SELECT cursors open through COMMIT. The temporary negative
  // lease is private to this batch: only its owner may insert a job, then the
  // final statement replaces it with that job id.
  const provisionalLeaseId = -((Date.now() % 1_000_000_000) * 10_000 + Math.floor(Math.random() * 10_000) + 1);
  const results = await client.batch([
    {
      sql: `INSERT INTO admin_job_singletons (type, job_id, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(type) DO UPDATE SET job_id = excluded.job_id, updated_at = excluded.updated_at
            WHERE admin_job_singletons.job_id = ?`,
      args: [type, provisionalLeaseId, now, expectedLeaseJobId],
    },
    {
      sql: `
        INSERT INTO admin_jobs (
          type, label, status, params_json, artifact_token_hash, timeout_at,
          runner_type, runner_state, started_at
        )
        SELECT ?, ?, 'running', ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM admin_job_singletons WHERE type = ? AND job_id = ?
        )
      `,
      args: [
        type,
        label,
        params ? JSON.stringify(params) : null,
        artifactTokenHash,
        timeoutAt,
        runnerType,
        runnerType ? 'queued' : null,
        now,
        type,
        provisionalLeaseId,
      ],
    },
    {
      sql: `UPDATE admin_job_singletons
            SET job_id = last_insert_rowid(), updated_at = ?
            WHERE type = ? AND job_id = ?`,
      args: [now, type, provisionalLeaseId],
    },
  ], 'write');
  if (changes(results[1]) > 0) {
    return { jobId: Number(results[1].lastInsertRowid || results[1].lastInsertRowId || 0), created: true };
  }
  const current = await client.execute({
    sql: 'SELECT job_id FROM admin_job_singletons WHERE type = ?', args: [type],
  });
  return { jobId: Number(current.rows[0]?.job_id || 0), created: false };
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
    executionId: 'execution_id',
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

export async function updateRunningAdminJob(id, patch = {}) {
  if (!id) return false;
  const fields = [];
  const args = [];
  for (const [key, column] of Object.entries({
    runnerType: 'runner_type', runnerId: 'runner_id', runnerState: 'runner_state',
    heartbeatAt: 'heartbeat_at', timeoutAt: 'timeout_at',
  })) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    fields.push(`${column} = ?`);
    args.push(patch[key]);
  }
  if (!fields.length) return false;
  args.push(id);
  const result = await run(`
    UPDATE admin_jobs SET ${fields.join(', ')}
    WHERE id = ? AND status = 'running' AND finished_at IS NULL
  `, args);
  return result.changes > 0;
}

export async function finishAdminJob(id, patch = {}) {
  await updateAdminJob(id, {
    ...patch,
    artifactTokenHash: null,
    executionId: null,
    finishedAt: patch.finishedAt || new Date().toISOString(),
  });
}

export async function finishRunningAdminJob(id, patch = {}) {
  if (!id) return false;
  const terminalPatch = {
    ...patch,
    artifactTokenHash: null,
    executionId: null,
    finishedAt: patch.finishedAt || new Date().toISOString(),
  };
  const fields = [];
  const args = [];
  for (const [key, column] of Object.entries({
    status: 'status', result: 'result_json', error: 'error', runnerState: 'runner_state',
    cancelledAt: 'cancelled_at', artifactTokenHash: 'artifact_token_hash',
    executionId: 'execution_id', finishedAt: 'finished_at',
  })) {
    if (!Object.prototype.hasOwnProperty.call(terminalPatch, key)) continue;
    fields.push(`${column} = ?`);
    args.push(key === 'result' && terminalPatch[key] != null
      ? JSON.stringify(terminalPatch[key])
      : terminalPatch[key]);
  }
  args.push(id);
  const result = await run(`
    UPDATE admin_jobs SET ${fields.join(', ')}
    WHERE id = ? AND status = 'running' AND finished_at IS NULL
  `, args);
  return result.changes > 0;
}

// Worker writes are fenced by the opaque execution id installed at claim time.
// Administrative writes intentionally continue to use updateAdminJob/finishAdminJob:
// cancellation and the stale-job reaper must be able to revoke a lease without
// knowing it. Once revoked (or once status leaves `running`), late worker writes
// can no longer change progress or publish a terminal result.
export async function updateClaimedAdminJob(id, executionId, patch = {}) {
  if (!id || !executionId) return false;
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
    cancelledAt: 'cancelled_at',
    artifactTokenHash: 'artifact_token_hash',
    executionId: 'execution_id',
    progress: 'progress_json',
    finishedAt: 'finished_at',
  })) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    fields.push(`${column} = ?`);
    const value = (key === 'result' || key === 'progress') && patch[key] != null
      ? JSON.stringify(patch[key])
      : patch[key];
    args.push(value);
  }
  if (!fields.length) return false;
  args.push(id, executionId);
  const result = await run(`
    UPDATE admin_jobs
    SET ${fields.join(', ')}
    WHERE id = ? AND execution_id = ? AND status = 'running' AND finished_at IS NULL
  `, args);
  return result.changes > 0;
}

export async function finishClaimedAdminJob(id, executionId, patch = {}) {
  return updateClaimedAdminJob(id, executionId, {
    ...patch,
    artifactTokenHash: null,
    executionId: null,
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

export async function claimAdminJob(id, runnerId = null, executionId = crypto.randomUUID()) {
  if (!executionId) return null;
  const now = new Date().toISOString();
  const result = await run(`
    UPDATE admin_jobs
    SET claimed_at = ?, execution_id = ?, runner_id = COALESCE(?, runner_id), runner_state = 'running', heartbeat_at = ?
    WHERE id = ? AND status = 'running' AND claimed_at IS NULL
  `, [now, executionId, runnerId, now, id]);
  return result.changes > 0 ? getAdminJob(id) : null;
}

export async function heartbeatAdminJob(id, runnerState = 'running') {
  const patch = {
    heartbeatAt: new Date().toISOString(),
  };
  if (runnerState != null) patch.runnerState = runnerState;
  await updateAdminJob(id, patch);
}

export async function heartbeatClaimedAdminJob(id, executionId, runnerState = 'running') {
  const patch = { heartbeatAt: new Date().toISOString() };
  if (runnerState != null) patch.runnerState = runnerState;
  return updateClaimedAdminJob(id, executionId, patch);
}

function adminJobProgressPatch(progress = {}) {
  return {
    progress: {
      ...progress,
      updatedAt: new Date().toISOString(),
    },
    heartbeatAt: new Date().toISOString(),
    runnerState: progress.currentTask || progress.phase || 'running',
  };
}

export async function updateAdminJobProgress(id, progress = {}) {
  await updateAdminJob(id, adminJobProgressPatch(progress));
}

export async function updateClaimedAdminJobProgress(id, executionId, progress = {}) {
  return updateClaimedAdminJob(id, executionId, {
    ...adminJobProgressPatch(progress),
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
        artifact_token_hash = NULL,
        execution_id = NULL
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

// Retry-safe (#18 Layer A): pure read.
export async function loadStoredFileMetric(docId) {
  return withDbRetry(() => get(`
    SELECT doc_id, pdf_path, download_url, file_bytes, word_count, body_word_count,
           full_text_path, full_text_bytes, full_text_source_url, page_count,
           word_source, page_source, content_source, content_checksum,
           content_source_url, content_retrieved_at, parser_version,
           metadata_request_count, full_text_request_count,
           original_pdf_request_count, retrieved_bytes, word_count_comparison_json,
           status, error, updated_at
    FROM file_metrics
    WHERE doc_id = ?
  `, [docId]), { label: 'loadStoredFileMetric' });
}

// Batched form of loadStoredFileMetric (H-05): one SELECT per page of sync
// records instead of one per record. Returns a Map keyed by doc_id.
// Retry-safe (#18 Layer A): pure reads, chunk by chunk.
export async function loadStoredFileMetrics(docIds = []) {
  const ids = normalizeDocIdList(docIds);
  const byDocId = new Map();
  if (!ids.length) return byDocId;
  for (let i = 0; i < ids.length; i += ID_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    // eslint-disable-next-line no-await-in-loop
    const rows = await withDbRetry(() => all(`
      SELECT doc_id, pdf_path, download_url, file_bytes, word_count, body_word_count,
             full_text_path, full_text_bytes, full_text_source_url, page_count,
             word_source, page_source, content_source, content_checksum,
             content_source_url, content_retrieved_at, parser_version,
             metadata_request_count, full_text_request_count,
             original_pdf_request_count, retrieved_bytes, word_count_comparison_json,
             status, error, updated_at
      FROM file_metrics
      WHERE doc_id IN (${placeholders})
    `, chunk), { label: 'loadStoredFileMetrics' });
    for (const row of rows) byDocId.set(String(row.doc_id), row);
  }
  return byDocId;
}

// Retry-safe (#18 Layer A): `INSERT ... ON CONFLICT DO UPDATE` upsert.
export async function saveFileMetric(docId, payload) {
  return withDbRetry(() => saveFileMetricOnce(docId, payload), { label: 'saveFileMetric' });
}

async function saveFileMetricOnce(docId, payload) {
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

export async function saveWordCountComparisonParadata(docId, comparison) {
  const now = new Date().toISOString();
  const payload = JSON.stringify({ ...comparison, comparedAt: comparison?.comparedAt || now });
  return withDbRetry(async () => {
    const result = await run(`
      UPDATE file_metrics
      SET word_count_comparison_json = ?, updated_at = ?
      WHERE doc_id = ?
    `, [payload, now, docId]);
    if (!result.changes) throw new Error(`Cannot save word-count comparison for missing file metric ${docId}`);
    return result;
  }, { label: 'saveWordCountComparisonParadata' });
}

export async function deleteFileMetric(docId) {
  await run('DELETE FROM file_metrics WHERE doc_id = ?', [docId]);
}

// --- Enrichment queue (H-03) ---

// SQL mirror of hasCachedEnrichmentMetric() in src/sync.js. The two must agree or
// the local enrichment queue and the in-process policy check will disagree about
// what is still outstanding, so test/enrichmentPolicyEquivalence.test.js asserts
// they return the same answer for every content mode over a matrix of stored rows.
// Branch order is deliberate: the full_text fallback wins over the mode rule
// whenever the stored word source is DSpace full text, exactly as the JS does.
export function enrichmentPolicySatisfiedSql(contentMode, contentFallback = null, alias = 'fm') {
  const counted = `COALESCE(${alias}.word_count, 0) > 0 AND COALESCE(${alias}.page_count, 0) > 0`;
  const pdfAttempted = `COALESCE(${alias}.original_pdf_request_count, 0) > 0`;
  const pdfPreferred = contentMode === 'pdf_cache' || contentMode === 'pdf_stream';
  const fullText = `${alias}.word_source = 'dspace_full_text' AND ${counted}`
    + (pdfPreferred ? ` AND ${pdfAttempted}` : '');
  let byMode = '0';
  if (contentMode === 'pdf_cache') {
    byMode = `${alias}.pdf_path IS NOT NULL AND ${alias}.pdf_path <> ''`;
  } else if (contentMode === 'pdf_stream') {
    byMode = `${alias}.content_source = 'streamed_pdf'`
      + ` AND ${alias}.content_checksum IS NOT NULL AND ${alias}.content_checksum <> ''`
      + ` AND ${counted}`;
  } else if (contentMode === 'full_text_only') {
    byMode = fullText;
  }
  const expression = contentFallback === 'full_text'
    ? `CASE WHEN ${alias}.word_source = 'dspace_full_text' THEN (${fullText}) ELSE (${byMode}) END`
    : `(${byMode})`;
  return `COALESCE(${expression}, 0)`;
}

// The enrichment work queue. Replaces re-scanning Open Collections from record 0
// on every batch: outstanding documents are found locally, in doc_id order from a
// cursor, so batch N costs the same as batch 1 no matter how much is already done.
//
// `+d.sync_key` is deliberate. It makes the sync-key term unusable as an index
// lookup, which forces the walk onto the doc_id primary key: the cursor becomes an
// ordered range scan and ORDER BY needs no sort. Left to itself the planner takes
// idx_documents_sync_key and then sorts the rule's whole corpus for every batch,
// which is precisely the per-batch cost this queue exists to remove.
export async function listDocumentsPendingEnrichment({
  syncKey = null,
  contentMode = null,
  contentFallback = null,
  attemptedBefore = null,
  afterDocId = '',
  limit = 50,
} = {}) {
  const args = [];
  const where = [];
  if (syncKey) {
    where.push('+d.sync_key = ?');
    args.push(syncKey);
  }
  const cursor = String(afterDocId || '');
  if (cursor) {
    where.push('d.doc_id > ?');
    args.push(cursor);
  }
  where.push(`${enrichmentPolicySatisfiedSql(contentMode, contentFallback, 'fm')} = 0`);
  if (attemptedBefore) {
    where.push('(ea.attempted_at IS NULL OR ea.attempted_at < ?)');
    args.push(String(attemptedBefore));
  }
  args.push(Math.max(1, Number(limit) || 1));
  const rows = await all(`
    SELECT d.doc_id, d.metadata_json
    FROM documents d
    LEFT JOIN file_metrics fm ON fm.doc_id = d.doc_id
    LEFT JOIN enrichment_attempts ea ON ea.doc_id = d.doc_id
    WHERE ${where.join(' AND ')}
    ORDER BY d.doc_id
    LIMIT ?
  `, args);
  return rows.map((row) => {
    let metadata = null;
    try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null; } catch { metadata = null; }
    return { docId: String(row.doc_id), metadata };
  });
}

// Retry-safe (#18 Layer A): each chunk is one client.batch() of upserts —
// a retry re-applies the same `attempted_at` stamp to the same doc_ids.
export async function markEnrichmentAttempts(docIds = [], attemptedAt = new Date().toISOString()) {
  const ids = normalizeDocIdList(docIds);
  if (!ids.length) return 0;
  const client = await getDb();
  const stamp = String(attemptedAt || new Date().toISOString());
  const chunkSize = 250;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    // eslint-disable-next-line no-await-in-loop
    await withDbRetry(() => client.batch(chunk.map((docId) => ({
      sql: `
        INSERT INTO enrichment_attempts (doc_id, attempted_at)
        VALUES (?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET attempted_at = excluded.attempted_at
      `,
      args: [docId, stamp],
    })), 'write'), { label: 'markEnrichmentAttempts' });
  }
  return ids.length;
}

// Retry-safe (#18 Layer A): pure reads, chunk by chunk.
export async function loadEnrichmentAttempts(docIds = []) {
  const ids = normalizeDocIdList(docIds);
  const byDocId = new Map();
  if (!ids.length) return byDocId;
  for (let i = 0; i < ids.length; i += ID_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    // eslint-disable-next-line no-await-in-loop
    const rows = await withDbRetry(() => all(
      `SELECT doc_id, attempted_at FROM enrichment_attempts WHERE doc_id IN (${placeholders})`,
      chunk
    ), { label: 'loadEnrichmentAttempts' });
    for (const row of rows) byDocId.set(String(row.doc_id), row.attempted_at || null);
  }
  return byDocId;
}

export async function listFileMetrics() {
  const rows = await all(`
    SELECT fm.doc_id, fm.pdf_path, fm.download_url, fm.file_bytes, fm.word_count,
           fm.body_word_count, fm.full_text_path, fm.full_text_bytes, fm.full_text_source_url, fm.page_count,
           fm.word_source, fm.page_source, fm.content_source, fm.content_checksum,
           fm.content_source_url, fm.content_retrieved_at, fm.parser_version,
           fm.metadata_request_count, fm.full_text_request_count,
           fm.original_pdf_request_count, fm.retrieved_bytes,
           fm.word_count_comparison_json,
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
           SUM(CASE WHEN word_source = 'degraded_pdf_text' THEN 1 ELSE 0 END) AS degraded_text,
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
    extractCommittee: rule.extractCommittee,
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
    { sql: 'DELETE FROM rule_document_processing_eligibility WHERE rule_id = ?', args: [id] },
    { sql: 'DELETE FROM import_rule_eligibility_projections WHERE rule_id = ?', args: [id] },
    { sql: 'DELETE FROM import_rule_request_limits WHERE rule_id = ?', args: [id] },
    { sql: 'DELETE FROM enrichment_rollout_evidence WHERE rule_id = ?', args: [id] },
    { sql: 'DELETE FROM enrichment_rollouts WHERE rule_id = ?', args: [id] },
    { sql: 'DELETE FROM import_rules WHERE id = ?', args: [id] },
  ], 'write');
  return true;
}

const ELIGIBILITY_PROCESSORS = new Set(['citation', 'patternrank']);
const PROCESSING_STATUSES = new Set(['pending', 'running', 'completed', 'failed']);

function eligibilityProcessor(value) {
  const processor = String(value || '').trim().toLowerCase();
  if (!ELIGIBILITY_PROCESSORS.has(processor)) {
    throw new Error(`Unsupported eligibility processor: ${value}`);
  }
  return processor;
}

// A projection is generation-based so a page-by-page import never needs to
// retain the complete rule corpus in memory. Rows written for current_token are
// staging rows; readers continue to use completed_token until finalize succeeds.
export async function beginImportRuleEligibilityProjection(ruleId, { token = crypto.randomUUID() } = {}) {
  const rule = await getImportRule(ruleId);
  if (!rule) throw new Error(`Import rule not found: ${ruleId}`);
  const ruleRevision = importRuleRevision(rule);
  const projectionToken = String(token || '').trim();
  if (!projectionToken) throw new Error('Eligibility projection token is required.');
  const now = new Date().toISOString();
  const client = await getDb();
  await client.batch([
    { sql: `
      INSERT INTO import_rule_eligibility_projections (
        rule_id, current_token, completed_token, rule_revision, status,
        started_at, completed_at, updated_at
      ) VALUES (?, ?, NULL, ?, 'running', ?, NULL, ?)
      ON CONFLICT(rule_id) DO UPDATE SET
        current_token = excluded.current_token,
        rule_revision = excluded.rule_revision,
        status = 'running',
        started_at = excluded.started_at,
        completed_at = NULL,
        updated_at = excluded.updated_at
    `, args: [ruleId, projectionToken, ruleRevision, now, now] },
    { sql: `
      DELETE FROM rule_document_processing_eligibility
      WHERE rule_id = ?
        AND projection_token <> ?
        AND projection_token <> COALESCE((
          SELECT completed_token FROM import_rule_eligibility_projections WHERE rule_id = ?
        ), '')
    `, args: [ruleId, projectionToken, ruleId] },
  ], 'write');
  return projectionToken;
}

export async function projectImportRuleEligibilityBatch(ruleId, projectionToken, docIds) {
  const ids = [...new Set((docIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return 0;
  const projection = await get(`
    SELECT current_token, status FROM import_rule_eligibility_projections WHERE rule_id = ?
  `, [ruleId]);
  if (projection?.status !== 'running' || projection.current_token !== projectionToken) {
    throw new Error(`Eligibility projection is not current for rule ${ruleId}.`);
  }
  const now = new Date().toISOString();
  const client = await getDb();
  const results = await client.batch(ids.map((docId) => ({ sql: `
    INSERT INTO rule_document_processing_eligibility (
      rule_id, doc_id, projection_token, projected_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(rule_id, doc_id, projection_token) DO UPDATE SET
      projected_at = excluded.projected_at
  `, args: [
    ruleId, docId, projectionToken, now,
  ] })), 'write');
  return results.reduce((total, result) => total + changes(result), 0);
}

export async function finalizeImportRuleEligibilityProjection(ruleId, projectionToken) {
  const now = new Date().toISOString();
  const client = await getDb();
  const transaction = await client.transaction('write');
  let staleRuleError = null;
  try {
    const stateResult = await transaction.execute({ sql: `
      SELECT p.current_token, p.status, p.rule_revision,
             r.id, r.name, r.degree, r.program, r.affiliation, r.requested_index,
             r.query, r.source, r.content_mode, r.content_fallback,
             r.extract_citations, r.extract_committee, r.run_concepts,
             r.max_content_bytes, r.content_concurrency, r.content_rate_limit,
             r.created_at, r.updated_at
      FROM import_rule_eligibility_projections p
      JOIN import_rules r ON r.id = p.rule_id
      WHERE p.rule_id = ?
    `, args: [ruleId] });
    const state = stateResult.rows[0];
    if (state?.status !== 'running' || state.current_token !== projectionToken) {
      await transaction.rollback();
      throw new Error(`Eligibility projection is not current for rule ${ruleId}.`);
    }
    const savedRuleRevision = importRuleRevision(importRuleFromRow(state));
    if (!state.rule_revision || state.rule_revision !== savedRuleRevision) {
      await transaction.execute({ sql: `
        DELETE FROM rule_document_processing_eligibility
        WHERE rule_id = ? AND projection_token = ?
      `, args: [ruleId, projectionToken] });
      await transaction.execute({ sql: `
        UPDATE import_rule_eligibility_projections
        SET current_token = NULL, status = 'aborted', updated_at = ?
        WHERE rule_id = ? AND current_token = ? AND status = 'running'
      `, args: [now, ruleId, projectionToken] });
      staleRuleError = new Error(`Eligibility projection rule scope changed for rule ${ruleId}.`);
    } else {
      const finalized = await transaction.execute({ sql: `
        UPDATE import_rule_eligibility_projections
        SET completed_token = ?, current_token = NULL, status = 'completed',
            completed_at = ?, updated_at = ?
        WHERE rule_id = ? AND current_token = ? AND rule_revision = ? AND status = 'running'
      `, args: [projectionToken, now, now, ruleId, projectionToken, savedRuleRevision] });
      if (changes(finalized) !== 1) {
        await transaction.rollback();
        throw new Error(`Eligibility projection is not current for rule ${ruleId}.`);
      }
      await transaction.execute({ sql: `
        INSERT INTO processing_eligibility_activation (id, activated_at)
        SELECT 1, ?
        WHERE NOT EXISTS (
          SELECT 1
          FROM import_rules r
          LEFT JOIN import_rule_eligibility_projections p ON p.rule_id = r.id
          WHERE p.completed_token IS NULL
        )
        ON CONFLICT(id) DO NOTHING
      `, args: [now] });
      await transaction.execute({ sql: `
        DELETE FROM rule_document_processing_eligibility
        WHERE rule_id = ? AND projection_token <> ?
          AND EXISTS (
            SELECT 1 FROM import_rule_eligibility_projections
            WHERE rule_id = ? AND completed_token = ? AND status = 'completed'
          )
      `, args: [ruleId, projectionToken, ruleId, projectionToken] });
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  } finally {
    transaction.close();
  }
  if (staleRuleError) throw staleRuleError;
  return true;
}

export async function abortImportRuleEligibilityProjection(ruleId, projectionToken) {
  const now = new Date().toISOString();
  const client = await getDb();
  const results = await client.batch([
    { sql: `
      DELETE FROM rule_document_processing_eligibility
      WHERE rule_id = ? AND projection_token = ?
        AND EXISTS (
          SELECT 1 FROM import_rule_eligibility_projections
          WHERE rule_id = ? AND current_token = ? AND status = 'running'
        )
    `, args: [ruleId, projectionToken, ruleId, projectionToken] },
    { sql: `
      UPDATE import_rule_eligibility_projections
      SET current_token = NULL, status = 'aborted', updated_at = ?
      WHERE rule_id = ? AND current_token = ? AND status = 'running'
    `, args: [now, ruleId, projectionToken] },
  ], 'write');
  return changes(results[1]) === 1;
}

export async function listEffectiveDocumentEligibility({ docIds = [] } = {}) {
  const ids = [...new Set((docIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  const where = ids.length ? `WHERE e.doc_id IN (${ids.map(() => '?').join(', ')})` : '';
  const rows = await all(`
    SELECT e.doc_id,
           MAX(r.extract_citations) AS citation_eligible,
           MAX(r.run_concepts) AS patternrank_eligible,
           COUNT(DISTINCT e.rule_id) AS matching_rule_count
    FROM rule_document_processing_eligibility e
    JOIN import_rule_eligibility_projections p
      ON p.rule_id = e.rule_id AND p.completed_token = e.projection_token
    JOIN import_rules r ON r.id = e.rule_id
    ${where}
    GROUP BY e.doc_id
    ORDER BY e.doc_id
  `, ids);
  return rows.map((row) => ({
    docId: row.doc_id,
    citationEligible: Boolean(row.citation_eligible),
    patternRankEligible: Boolean(row.patternrank_eligible),
    matchingRuleCount: Number(row.matching_rule_count || 0),
  }));
}

export async function saveDocumentProcessingState(docId, processorValue, {
  status, contentChecksum = null, processorVersion = null, error = null,
} = {}) {
  const processor = eligibilityProcessor(processorValue);
  if (!PROCESSING_STATUSES.has(status)) throw new Error(`Unsupported processing status: ${status}`);
  const now = new Date().toISOString();
  await run(`
    INSERT INTO document_processing_state (
      doc_id, processor, status, content_checksum, processor_version, error, attempted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_id, processor) DO UPDATE SET
      status = excluded.status,
      content_checksum = excluded.content_checksum,
      processor_version = excluded.processor_version,
      error = excluded.error,
      attempted_at = excluded.attempted_at
  `, [docId, processor, status, contentChecksum, processorVersion, error, now]);
}

export async function listEligibleDocumentsForProcessing({
  processor: processorValue, status = 'actionable', processorVersion = null,
  afterDocId = '', limit = 100,
} = {}) {
  const processor = eligibilityProcessor(processorValue);
  const requestedStatus = String(status || 'actionable').toLowerCase();
  const allowedStatuses = new Set(['all', 'actionable', 'pending', 'running', 'completed', 'stale', 'failed']);
  if (!allowedStatuses.has(requestedStatus)) throw new Error(`Unsupported eligibility status: ${status}`);
  const eligibilityColumn = processor === 'citation' ? 'extract_citations' : 'run_concepts';
  const statusPredicate = requestedStatus === 'all' ? '1 = 1'
    : requestedStatus === 'actionable' ? "queue_status IN ('pending', 'stale', 'failed')"
      : 'queue_status = ?';
  const statusArgs = ['all', 'actionable'].includes(requestedStatus) ? [] : [requestedStatus];
  return all(`
    WITH effective AS (
      SELECT DISTINCT e.doc_id
      FROM rule_document_processing_eligibility e
      JOIN import_rule_eligibility_projections p
        ON p.rule_id = e.rule_id AND p.completed_token = e.projection_token
      JOIN import_rules r ON r.id = e.rule_id
      WHERE r.${eligibilityColumn} = 1
    ), queued AS (
      SELECT d.doc_id, d.metadata_json, fm.pdf_path, fm.full_text_path,
             fm.content_source,
             COALESCE(fm.content_checksum, fm.updated_at, '') AS content_checksum,
             ps.status AS processing_status, ps.error, ps.attempted_at,
             CASE
               WHEN ps.doc_id IS NULL THEN 'pending'
               WHEN ps.status = 'failed' THEN 'failed'
               WHEN ps.status = 'completed' AND (
                 COALESCE(ps.content_checksum, '') <> COALESCE(fm.content_checksum, fm.updated_at, '')
                 OR (? IS NOT NULL AND COALESCE(ps.processor_version, '') <> ?)
               ) THEN 'stale'
               ELSE ps.status
             END AS queue_status
      FROM effective e
      JOIN documents d ON d.doc_id = e.doc_id
      LEFT JOIN file_metrics fm ON fm.doc_id = d.doc_id
      LEFT JOIN document_processing_state ps
        ON ps.doc_id = d.doc_id AND ps.processor = ?
      WHERE d.doc_id > ?
    )
    SELECT * FROM queued
    WHERE ${statusPredicate}
    ORDER BY doc_id
    LIMIT ?
  `, [
    processorVersion, processorVersion, processor, String(afterDocId || ''),
    ...statusArgs, Math.max(1, Math.min(1000, Number(limit) || 100)),
  ]);
}

// CAS backoff is intentionally smaller/faster-capped than Layer A's
// withDbRetry default — this loop can run up to `maxAttempts` times per call
// under real contention (many concurrent workers on one import rule), so a
// large base/cap here would multiply into unacceptable worst-case latency.
const CAS_BACKOFF_OPTIONS = { baseMs: 5, factor: 1.6, jitterRatio: 0.4, capMs: 200 };

// #23: never throws for ordinary contention. Jittered backoff is inserted
// between CAS attempts (spreading collisions in time instead of every
// contending worker retrying in lockstep), and exhausting the attempt budget
// returns a wait duration — reusing the same "next window boundary"
// computation the "window is full" branch below already does, since 20
// straight CAS collisions is operationally the same situation as a full
// window from the caller's point of view (createRequestRateLimiter's
// `reserveSlot` loop already knows how to wait on a returned waitMs and try
// again). The one case this cannot paper over — the persisted state being
// unparseable on every single attempt, never once recovering even after this
// function's own CAS tried to replace it — is genuine data corruption, not
// contention, and is the sole remaining throw path; it is tagged
// `RATE_LIMIT_STATE_CORRUPT` so evaluateEnrichmentRun can exclude it from the
// enrichment-quality success rate rather than counting infra noise as a bad
// PDF (see src/services/enrichmentRollout.js).
//
// Retry-safe (#18 Layer A, corrected): a transient error out of the SELECT or
// the CAS UPDATE/INSERT below (a dropped connection mid-round-trip, not
// ordinary CAS contention — contention never throws, see above) is retried by
// wrapping the WHOLE function body in `withDbRetry`, not just an individual
// statement. This is deliberate and was verified safe, not assumed: retrying
// the entire function re-reads `timestamps_json` from scratch and re-derives
// its decision from that fresh read, so a retried call can only ever (a) see
// its own prior attempt's write already applied (if the UPDATE actually
// committed despite the client-side error) and skip re-adding a slot because
// the window now looks fuller, or (b) at worst append `nowMs` a second time,
// which makes the limiter *more* conservative, never less — it can never
// double-grant a slot to two distinct real requests, because the calling
// content-request path only invokes this once per real request regardless of
// how many times it is retried internally. This function was previously
// listed as one of the seven Layer-A-wrapped functions (see the design notes
// above and docs/phase-b-completion-plan.md §2.1's audit table) but was not
// actually wrapped — a transient SELECT/UPDATE failure threw on the first
// attempt with zero retries. `reserveImportRuleRequestSlotOnce` below is the
// un-retried body; this exported function is the retry-wrapped entry point.
export async function reserveImportRuleRequestSlot(ruleId, limit, options = {}) {
  return withDbRetry(
    () => reserveImportRuleRequestSlotOnce(ruleId, limit, options),
    { label: 'reserveImportRuleRequestSlot' }
  );
}

async function reserveImportRuleRequestSlotOnce(ruleId, limit, {
  nowMs = Date.now(), windowMs = 60_000, wait = defaultRetryWait, maxAttempts = 20,
  backoff = computeBackoffDelayMs,
} = {}) {
  if (!ruleId || !Number.isFinite(Number(limit)) || Number(limit) <= 0) return 0;
  const boundedLimit = Math.max(1, Math.min(600, Math.floor(Number(limit))));
  let everParsed = false;
  let lastTimestamps = [];
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      // eslint-disable-next-line no-await-in-loop
      await wait(backoff(attempt - 1, CAS_BACKOFF_OPTIONS));
    }
    // eslint-disable-next-line no-await-in-loop
    const row = await get(
      'SELECT timestamps_json FROM import_rule_request_limits WHERE rule_id = ?',
      [ruleId]
    );
    let timestamps = [];
    try {
      const parsed = JSON.parse(row?.timestamps_json || '[]');
      if (Array.isArray(parsed)) { timestamps = parsed; everParsed = true; }
    } catch { /* replace malformed limiter state */ }
    timestamps = timestamps
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > nowMs - windowMs)
      .sort((left, right) => left - right);
    lastTimestamps = timestamps;
    if (timestamps.length >= boundedLimit) {
      return Math.max(1, timestamps[0] + windowMs - nowMs);
    }
    const nextJson = JSON.stringify([...timestamps, nowMs].slice(-600));
    let result;
    // eslint-disable-next-line no-await-in-loop
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
  if (!everParsed) {
    const err = new Error(
      `Rate-limit state for import rule ${ruleId} is corrupt: timestamps_json was not valid JSON after ${maxAttempts} attempts.`
    );
    err.code = 'RATE_LIMIT_STATE_CORRUPT';
    throw err;
  }
  return lastTimestamps.length
    ? Math.max(1, lastTimestamps[0] + windowMs - nowMs)
    : backoff(maxAttempts, CAS_BACKOFF_OPTIONS);
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

const FUZZY_CITATION_THRESHOLD = 0.94;
// Per-bucket cap on fuzzy candidates. The buckets grow with the corpus, so
// without a cap the per-document cost would still scale with total citations.
// Below the cap the candidate set is exactly the old in-memory bucket; at the
// cap the bucket is *unknown*, not empty, and findFuzzyMatch refuses to merge
// rather than guess from a truncated read. See the note above findFuzzyMatch.
//
// Design decision (Phase 1 / #11): keep the cap + (prefix, year) bucket
// narrowing + refuse-on-saturation rather than eliminating the cap. A "provably
// never truncates" alternative (no cap / exhaustive pagination) reintroduces the
// unbounded per-document cost this rewrite exists to remove. Refuse-on-saturation
// is a *safety* property, not just telemetry: by construction it can only turn a
// would-be merge into a new citation (a lost merge), never invent a merge or drop
// a veto the old algorithm would not also have dropped from the same complete
// candidate set. The prefix-narrowing trade-off and both saturation sub-cases are
// pinned by tests (test/citationMatchEquivalence.test.js,
// test/citationFuzzySaturation.test.js).
//
// The cap is a hardcoded 2000 in production; the env override exists only so a
// test can force saturation cheaply (seed a handful of rows against a limit of a
// few) instead of materialising 2000 real rows. Mirrors the
// CONCEPT_MAX_BUCKET_COMPARISONS precedent (scripts/build-concepts.py).
const FUZZY_CANDIDATE_LIMIT = Number(process.env.CITATION_FUZZY_CANDIDATE_LIMIT) || 2000;
const CITATION_MATCH_KEY_VERSION = 1;
const CITATION_BACKFILL_BATCH = 500;
const CITATION_CANDIDATE_COLUMNS = 'id, citation_hash, citation_text, match_year';

function citationMatchKeys(citationText, yearValue) {
  return {
    matchYear: citationMatchYear(yearValue),
    matchPrefix: citationTextPrefix(citationText),
  };
}

function prepareCitationForMatching(row) {
  return {
    id: Number(row.id),
    citation_hash: row.citation_hash,
    citation_text: row.citation_text,
    matchText: String(row.citation_text || '').toLowerCase(),
    matchYear: row.match_year == null ? null : Number(row.match_year),
  };
}

// One-time migration for citations written before match_year/match_prefix existed.
// Every statement is bounded to CITATION_BACKFILL_BATCH rows, and the probe is a
// covering read of idx_citations_match_pending, which empties itself as the
// backfill progresses — so on an already-migrated corpus this costs one scan of
// an empty index rather than a pass over the table.
export async function backfillCitationMatchKeys(dbInstance = null) {
  const client = dbInstance || await getDb();
  let total = 0;
  let previousFirstId = null;
  for (;;) {
    let result;
    try {
      result = await client.execute({
        sql: 'SELECT id, citation_text, year FROM citations WHERE match_key_version = 0 LIMIT ?',
        args: [CITATION_BACKFILL_BATCH],
      });
    } catch {
      // An older database without the match-key columns: nothing to backfill.
      return total;
    }
    if (!result.rows.length) break;
    const firstId = Number(result.rows[0].id);
    // Each batch takes its rows out of the pending set, so the next pass sees new
    // ones. Seeing the same row twice means the writes are not landing; stop
    // rather than spin.
    if (firstId === previousFirstId) {
      logger.warn('Citation match-key backfill made no progress; stopping', { citationId: firstId });
      break;
    }
    previousFirstId = firstId;
    const statements = result.rows.map((row) => {
      const keys = citationMatchKeys(row.citation_text, row.year);
      return {
        sql: 'UPDATE citations SET match_year = ?, match_prefix = ?, match_key_version = ? WHERE id = ?',
        args: [keys.matchYear, keys.matchPrefix, CITATION_MATCH_KEY_VERSION, Number(row.id)],
      };
    });
    await client.batch(statements, 'write');
    total += result.rows.length;
  }
  if (total > 0) logger.info(`Backfilled citation match keys for ${total} citations`);
  return total;
}

// Exact matching is a unique-index lookup, so the whole document's hashes are
// resolved in one round trip instead of materialising the citations table.
async function loadCitationIdsByHash(hashes) {
  const idByHash = new Map();
  const unique = Array.from(new Set(hashes.filter(Boolean)));
  const chunkSize = 999;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await all(`SELECT id, citation_hash FROM citations WHERE citation_hash IN (${placeholders})`, chunk);
    for (const row of rows) idByHash.set(String(row.citation_hash), Number(row.id));
  }
  return idByHash;
}

// Reads one or more capped candidate buckets in a single round trip and returns
// them keyed by bucket, each in ascending id order — the order the in-memory
// index produced, because it was filled by a rowid-ordered table scan.
//
// `saturated` names the buckets that came back exactly full. Those reads were
// cut off by the LIMIT, so rows past the cut were never compared and the bucket
// has to be treated as unknown rather than as the whole bucket. Callers must
// not silently take the best of a truncated read: that is how a cap turns into
// a merge the old matcher would never have made.
async function loadCandidateBuckets(arms) {
  const sql = arms.map((arm) => `SELECT * FROM (
      SELECT ${arm.bucket} AS bucket, ${CITATION_CANDIDATE_COLUMNS} FROM citations
      WHERE ${arm.where} ORDER BY ${arm.order || 'id'} LIMIT ${FUZZY_CANDIDATE_LIMIT}
    )`).join(' UNION ALL ');
  const rows = await all(sql, arms.flatMap((arm) => arm.args));
  const byBucket = new Map(arms.map((arm) => [arm.bucket, []]));
  for (const row of rows) byBucket.get(Number(row.bucket))?.push(prepareCitationForMatching(row));
  const saturated = new Set();
  for (const [bucket, candidates] of byBucket) {
    if (candidates.length >= FUZZY_CANDIDATE_LIMIT) saturated.add(bucket);
    candidates.sort((a, b) => a.id - b.id);
  }
  return { byBucket, saturated };
}

const characterCountScratch = new Int32Array(256);

function characterCounts(text) {
  const counts = new Int32Array(256);
  for (let i = 0; i < text.length; i += 1) counts[text.charCodeAt(i) & 0xff] += 1;
  return counts;
}

// Upper bound on jaroWinkler(incoming, candidate), used to skip candidates that
// provably cannot clear FUZZY_CITATION_THRESHOLD.
//
// Jaro's match count can never exceed the size of the character multiset the two
// strings share, and its transposition term is at most 1, so
// jaro <= (m/len1 + m/len2 + 1) / 3. Winkler adds at most 4 * 0.1 * (1 - jaro),
// so jaroWinkler <= 0.6 * jaro + 0.4. Skipping a candidate the bound puts below
// the threshold cannot change saveCitations' answer: such a candidate is below
// the threshold in truth as well, so it can neither be accepted nor be the
// highest-scoring candidate whenever any candidate clears the threshold.
function jaroWinklerUpperBound(counts, incomingLength, candidateText) {
  const remaining = characterCountScratch;
  remaining.set(counts);
  let matches = 0;
  for (let i = 0; i < candidateText.length; i += 1) {
    const code = candidateText.charCodeAt(i) & 0xff;
    if (remaining[code] > 0) {
      remaining[code] -= 1;
      matches += 1;
    }
  }
  if (!matches || !incomingLength || !candidateText.length) return 0;
  const jaro = ((matches / incomingLength) + (matches / candidateText.length) + 1) / 3;
  return (0.6 * jaro) + 0.4;
}

// Highest-scoring candidate in one bucket, keeping the first of any tie exactly
// as the old `sim > maxSim` loop did.
function bestInBucket(candidates, incoming, counts) {
  let best = null;
  let maxSim = 0;
  for (const candidate of candidates) {
    if (jaroWinklerUpperBound(counts, incoming.length, candidate.matchText) < FUZZY_CITATION_THRESHOLD) continue;
    const sim = jaroWinkler(incoming, candidate.matchText);
    if (sim > maxSim) {
      maxSim = sim;
      best = candidate;
    }
  }
  return { best, maxSim };
}

// SQL replacement for the old in-memory fuzzyMatchCandidates plus the scan that
// followed it. The buckets are the ones the in-memory index held — the ±1 year
// window and the 3-character prefix bucket — and the winner is still the first
// bucket, in the order y-1, y, y+1, undated-prefix, to attain the highest
// similarity, so the ±1 window still *blocks* a same-year merge when an adjacent
// year scores higher.
//
// Only the y and undated-prefix buckets can produce an accepted match: a
// candidate whose year is non-null and different always fails
// fuzzyYearsCompatible. So the adjacent-year buckets are read only once an
// acceptable candidate has cleared the threshold — when none does, the old code
// rejected regardless of what those buckets held.
//
// Deliberate difference 1: the old code fell back to comparing against every
// citation in the corpus when a bucket came back empty. That fallback is the
// unbounded path B-01 exists to remove, so an empty bucket now simply yields no
// fuzzy match.
//
// Deliberate difference 2: the dated arms are blocked on the incoming citation's
// 3-character prefix as well as on its year. The old matcher compared a dated
// incoming against *every* same-year and adjacent-year citation, which is a
// bucket that grows without bound as the corpus grows. Under a fixed cap that
// bucket can only be read partially, and a partially read *adjacent-year* bucket
// is actively dangerous: it drops the ±1 blocker and merges two distinct
// editions into one row. Prefix blocking is what makes each bucket inherently
// small — one year, one 3-character prefix — so the read is complete and the
// blocker is always there. Three things justify narrowing rather than
// truncating:
//   * Winkler's prefix bonus already favours same-prefix candidates. A candidate
//     agreeing on the first four characters gains up to 0.4 * (1 - jaro); one
//     that differs inside the first three gains at most 0.2 * (1 - jaro). To
//     outscore a same-prefix candidate that already clears 0.94 it needs a
//     materially higher raw Jaro, which for citation strings means the texts
//     diverge almost only at the very start.
//   * The undated half of the matcher was prefix-blocked in the old code too, so
//     this makes the dated half consistent with a gate the design already relied
//     on rather than inventing a new one.
//   * The alternative is unbounded reads or truncated ones. Truncation is what
//     produced the wrong merges; unbounded reads are the cost regression the
//     rewrite exists to remove.
// It applies symmetrically to the accepting and the vetoing arms, so the veto is
// never weakened relative to what can be accepted: within the prefix-blocked
// candidate set the decision is bit-for-bit the old one. A citation shorter than
// the prefix window has no prefix to block on and falls back to the plain year
// arms.
//
// Deliberate difference 3: a bucket that comes back saturated (see
// loadCandidateBuckets) refuses the merge instead of taking the best of what it
// read. Every merge this matcher makes is therefore one the old matcher would
// also have made from the same candidate set; the cap can cost a merge, but it
// can no longer invent one. Saturation is reported to the caller so it is
// visible rather than silent.
async function findFuzzyMatch(text, itemYear, telemetry = null) {
  const year = citationMatchYear(itemYear) ?? citationMatchYear(text);
  const prefix = citationTextPrefix(text);
  const incoming = text.toLowerCase();
  const counts = characterCounts(incoming);
  const refuse = () => {
    telemetry?.truncationBlockedMerge();
    return null;
  };

  if (year == null) {
    if (!prefix) return null;
    // ORDER BY match_year, id follows idx_citations_match_prefix, so the cap is an
    // ordered index range scan; loadCandidateBuckets restores the id ordering.
    const undated = await loadCandidateBuckets([
      { bucket: 0, where: 'match_prefix = ?', order: 'match_year, id', args: [prefix] },
    ]);
    if (undated.saturated.has(0)) telemetry?.truncatedBucket('undated-prefix', null, prefix);
    const { best, maxSim } = bestInBucket(undated.byBucket.get(0), incoming, counts);
    // An incoming citation with no year is compatible with every candidate.
    if (!best || maxSim < FUZZY_CITATION_THRESHOLD) return null;
    return undated.saturated.size ? refuse() : { row: best, similarity: maxSim };
  }

  const yearArm = (bucket, bucketYear) => (prefix
    ? { bucket, where: 'match_prefix = ? AND match_year = ?', args: [prefix, bucketYear] }
    : { bucket, where: 'match_year = ?', args: [bucketYear] });

  const acceptableArms = [yearArm(1, year)];
  if (prefix) {
    acceptableArms.push({ bucket: 3, where: 'match_prefix = ? AND match_year IS NULL', args: [prefix] });
  }
  const acceptable = await loadCandidateBuckets(acceptableArms);
  if (acceptable.saturated.has(1)) telemetry?.truncatedBucket('same-year', year, prefix);
  if (acceptable.saturated.has(3)) telemetry?.truncatedBucket('undated-prefix', null, prefix);
  const sameYear = bestInBucket(acceptable.byBucket.get(1), incoming, counts);
  const undated = prefix ? bestInBucket(acceptable.byBucket.get(3), incoming, counts) : { best: null, maxSim: 0 };
  if (Math.max(sameYear.maxSim, undated.maxSim) < FUZZY_CITATION_THRESHOLD) return null;
  // A truncated accepting arm may hide the candidate the old matcher would have
  // picked, so the merge target is not knowable: refuse rather than pick another.
  if (acceptable.saturated.size) return refuse();

  // Phase 2: an acceptable candidate cleared the threshold, so the ±1 adjacent
  // year buckets are now read to see whether a higher-scoring neighbour vetoes it.
  telemetry?.observe?.('phase2:adjacent', { year, prefix });
  const adjacent = await loadCandidateBuckets([yearArm(0, year - 1), yearArm(2, year + 1)]);
  if (adjacent.saturated.has(0)) telemetry?.truncatedBucket('year-before', year - 1, prefix);
  if (adjacent.saturated.has(2)) telemetry?.truncatedBucket('year-after', year + 1, prefix);
  // A truncated veto arm cannot prove no adjacent-year work outscores the
  // accepted candidate, which is exactly the case that conflates two editions.
  if (adjacent.saturated.size) return refuse();
  const before = bestInBucket(adjacent.byBucket.get(0), incoming, counts);
  const after = bestInBucket(adjacent.byBucket.get(2), incoming, counts);

  const overall = Math.max(before.maxSim, sameYear.maxSim, after.maxSim, undated.maxSim);
  if (before.maxSim === overall) { telemetry?.observe?.('veto:before', { year, prefix }); return null; }
  if (sameYear.maxSim === overall) { telemetry?.observe?.('merge:same-year', { year, prefix }); return { row: sameYear.best, similarity: overall }; }
  if (after.maxSim === overall) { telemetry?.observe?.('veto:after', { year, prefix }); return null; }
  return { row: undated.best, similarity: overall };
}

// Saturation reporter for one saveCitations call. Every saturated bucket read is
// counted; the warning is emitted once per bucket so a document whose year is
// oversubscribed logs a line, not a hundred.
// `observe` is a behaviour-neutral, test-only reach probe. In production no
// observer is passed, so it is a no-op; a test can pass one through
// saveCitations({ matchObserver }) to prove which decision branch a probe
// reached (phase 2 was entered, the ±1 veto fired, etc.) rather than only
// asserting the final row count. It exists because the operational counters
// (truncatedBuckets / truncationBlockedMerges) fire only on saturation and say
// nothing about the ordinary veto/merge path.
function citationMatchTelemetry(counts, observer = null) {
  const warned = new Set();
  return {
    observe(event, detail) {
      observer?.(event, detail);
    },
    truncatedBucket(bucket, year, prefix) {
      counts.truncatedBuckets += 1;
      const key = `${bucket}|${year ?? ''}|${prefix ?? ''}`;
      if (warned.has(key)) return;
      warned.add(key);
      logger.warn('Citation fuzzy-match bucket hit the candidate cap; rows beyond it were not compared', {
        bucket,
        year: year ?? null,
        prefix: prefix ?? null,
        limit: FUZZY_CANDIDATE_LIMIT,
      });
    },
    truncationBlockedMerge() {
      counts.truncationBlockedMerges += 1;
    },
  };
}

function citationFields(item) {
  const text = typeof item === 'string' ? item : item.text;
  return {
    text,
    author: (typeof item === 'string' ? null : item.author) || null,
    title: (typeof item === 'string' ? null : item.title) || null,
    year: (typeof item === 'string' ? null : item.year) || null,
    source: (typeof item === 'string' ? null : item.source) || null,
  };
}

// Inserts (or reuses) a citation row and returns its id, keeping the persisted
// match keys in step with whatever text/year the row ended up carrying.
async function upsertCitation(fields, hash, now) {
  const keys = citationMatchKeys(fields.text, fields.year);
  await run(`
    INSERT INTO citations (
      citation_hash, citation_text, author, title, year, source, created_at,
      match_year, match_prefix, match_key_version
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(citation_hash) DO UPDATE SET
      author = COALESCE(excluded.author, citations.author),
      title = COALESCE(excluded.title, citations.title),
      year = COALESCE(excluded.year, citations.year),
      source = COALESCE(excluded.source, citations.source)
  `, [
    hash, fields.text, fields.author, fields.title, fields.year, fields.source, now,
    keys.matchYear, keys.matchPrefix, CITATION_MATCH_KEY_VERSION,
  ]);
  const row = await get(`
    SELECT id, citation_text, year, match_year, match_prefix, match_key_version
    FROM citations WHERE citation_hash = ?
  `, [hash]);
  if (!row) return null;
  const stored = citationMatchKeys(row.citation_text, row.year);
  const storedYear = row.match_year == null ? null : Number(row.match_year);
  if (
    Number(row.match_key_version) !== CITATION_MATCH_KEY_VERSION
    || storedYear !== stored.matchYear
    || (row.match_prefix ?? null) !== stored.matchPrefix
  ) {
    await run(
      'UPDATE citations SET match_year = ?, match_prefix = ?, match_key_version = ? WHERE id = ?',
      [stored.matchYear, stored.matchPrefix, CITATION_MATCH_KEY_VERSION, Number(row.id)]
    );
  }
  return Number(row.id);
}

export async function saveCitations(docId, citations, hashFn, {
  onProgress = null, matchObserver = null, linkDocument = true,
} = {}) {
  const now = new Date().toISOString();

  const items = citations.map((item) => {
    const fields = citationFields(item);
    return { ...fields, hash: hashFn(fields.text) };
  });
  // Exact matches come from one indexed lookup over this document's hashes only.
  // Rows created inside the loop are added here, exactly as the old in-memory
  // hash map grew during the loop.
  const idByHash = await loadCitationIdsByHash(items.map((item) => item.hash));

  const linkedIds = [];
  const counts = {
    processed: 0,
    total: citations.length,
    exactMatches: 0,
    fuzzyMatches: 0,
    newCitations: 0,
    // Candidate buckets that came back at FUZZY_CANDIDATE_LIMIT, and merges
    // refused because of one. Both stay 0 on a corpus the cap never binds on, so
    // a non-zero value is the signal that matching is running on partial reads.
    truncatedBuckets: 0,
    truncationBlockedMerges: 0,
  };
  const telemetry = citationMatchTelemetry(counts, matchObserver);
  await onProgress?.({
    phase: 'citation_matching',
    label: 'Matching citations',
    status: 'running',
    counts,
  });

  for (const item of items) {
    let matchedId = idByHash.get(item.hash) ?? null;
    let matchedBy = matchedId ? 'exact' : null;

    if (!matchedId) {
      const fuzzy = await findFuzzyMatch(item.text, item.year, telemetry);
      if (fuzzy) {
        matchedId = fuzzy.row.id;
        matchedBy = 'fuzzy';
        logger.info('Fuzzy matched citation', {
          incoming: item.text.slice(0, 50),
          matched: fuzzy.row.citation_text.slice(0, 50),
          similarity: fuzzy.similarity
        });
      }
    }

    if (matchedId) {
      if (matchedBy === 'exact') counts.exactMatches += 1;
      if (matchedBy === 'fuzzy') counts.fuzzyMatches += 1;
      if (linkDocument) {
        await run(`
          INSERT INTO document_citations (doc_id, citation_id, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(doc_id, citation_id) DO UPDATE SET updated_at = excluded.updated_at
        `, [docId, matchedId, now]);
      }
      linkedIds.push(matchedId);
    } else {
      counts.newCitations += 1;
      const citationId = await upsertCitation(item, item.hash, now);
      if (citationId) {
        idByHash.set(item.hash, citationId);
        if (linkDocument) {
          await run(`
            INSERT INTO document_citations (doc_id, citation_id, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(doc_id, citation_id) DO UPDATE SET updated_at = excluded.updated_at
          `, [docId, citationId, now]);
        }
        linkedIds.push(citationId);
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

// Re-extraction stages/deduplicates the complete citation set without publishing
// document links, then swaps the link set in one transaction. If extraction or
// matching fails, the previous known-good link set remains visible; a failed
// attempt can never publish a partial bibliography.
export async function reextractDocumentCitations(docId, citations, hashFn, options = {}) {
  try {
    let linkedIds = [];
    if (citations.length) {
      linkedIds = await saveCitations(docId, citations, hashFn, {
        ...options,
        linkDocument: false,
      });
    }
    await replaceDocumentCitationLinks(docId, linkedIds);
    return linkedIds;
  } catch (error) {
    // A failed extraction is retryable even if an older implementation left
    // links behind. The scan gate explicitly admits failed rows when an
    // operator chooses retryFailures, while ordinary runs keep the last known
    // good bibliography untouched.
    try {
      const existing = await all('SELECT COUNT(*) AS total FROM document_citations WHERE doc_id = ?', [docId]);
      await saveCitationExtractionState(docId, {
        status: 'failed',
        citationCount: Number(existing[0]?.total || 0),
        error: error?.message || String(error),
      });
    } catch (stateError) {
      logger.error('Could not record failed citation extraction state', {
        docId,
        error: stateError?.message || String(stateError),
      });
    }
    throw error;
  }
}

export async function replaceDocumentCitationLinks(docId, keepCitationIds = []) {
  const keep = new Set(
    (keepCitationIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
  );
  const now = new Date().toISOString();
  const client = await getDb();
  // Both libSQL and the embedded file client implement `transaction('write')`.
  // Keeping the read, inserts, and deletes in that one transaction is stronger
  // than the former file-SQLite compensating loop: an interruption can now only
  // expose the old complete set or the new complete set, never a partial swap.
  const transaction = await client.transaction('write');
  let stale = [];
  try {
    const existingResult = await transaction.execute({
      sql: 'SELECT citation_id FROM document_citations WHERE doc_id = ?', args: [docId],
    });
    const existing = existingResult.rows;
    stale = existing
      .map((row) => Number(row.citation_id))
      .filter((id) => !keep.has(id));
    const statements = [];
    for (const citationId of keep) {
      statements.push({
        sql: `
          INSERT INTO document_citations (doc_id, citation_id, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(doc_id, citation_id) DO UPDATE SET updated_at = excluded.updated_at
        `,
        args: [docId, citationId, now],
      });
    }
    const chunkSize = 900;
    for (let i = 0; i < stale.length; i += chunkSize) {
      const chunk = stale.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      statements.push({
        sql: `DELETE FROM document_citations WHERE doc_id = ? AND citation_id IN (${placeholders})`,
        args: [docId, ...chunk],
      });
    }
    if (statements.length) {
      await transaction.batch(statements);
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  } finally {
    transaction.close();
  }
  await collectOrphanedCitations(stale);
}

// Scoped orphan collection (B-02). Only the citations this document just unlinked
// are considered, so re-extracting one document can never delete a citation — or
// the Z39.50 result attached to it — that belongs to another document, and cannot
// destroy a citation another process has inserted but not yet linked. This
// replaces the two global `NOT IN` anti-joins that used to run once per document.
export async function collectOrphanedCitations(citationIds = []) {
  const ids = Array.from(new Set(
    (citationIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
  ));
  if (!ids.length) return 0;
  let removed = 0;
  const chunkSize = 900;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    await run(`
      DELETE FROM catalogue_lookups
      WHERE citation_id IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM document_citations dc WHERE dc.citation_id = catalogue_lookups.citation_id
        )
    `, chunk);
    const result = await run(`
      DELETE FROM citations
      WHERE id IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM document_citations dc WHERE dc.citation_id = citations.id
        )
    `, chunk);
    removed += result.changes;
  }
  return removed;
}

// Corpus-wide reconciliation for citations orphaned outside the re-extraction path
// (interrupted jobs, direct link deletions). Deliberately exported for scheduled
// maintenance only — calling this per document is the B-02 defect. Keyset-paginated
// so every statement stays bounded regardless of corpus size.
export async function sweepOrphanedCitations({ batchSize = 500 } = {}) {
  const limit = Math.max(1, Math.min(5000, Number(batchSize) || 500));
  let cursor = 0;
  let removed = 0;
  for (;;) {
    const rows = await all(`
      SELECT c.id FROM citations c
      WHERE c.id > ?
        AND NOT EXISTS (SELECT 1 FROM document_citations dc WHERE dc.citation_id = c.id)
      ORDER BY c.id
      LIMIT ?
    `, [cursor, limit]);
    if (!rows.length) break;
    cursor = Number(rows[rows.length - 1].id);
    removed += await collectOrphanedCitations(rows.map((row) => Number(row.id)));
  }
  return removed;
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
  parserVersion = 'citation-v1', eligibilityRuleIds = [],
} = {}) {
  const filters = documentServingFilters({ syncKey, ...requestedFilters });
  const qualifier = filters.where ? 'AND' : 'WHERE';
  const eligibility = citationEligibilityGate({ eligibilityRuleIds });
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
      ${eligibility.sql}
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
    ...eligibility.args,
    String(parserVersion || 'citation-v1'),
    Math.max(1, Math.min(1000, Number(limit) || 100)),
  ]);
}

// Content retrieval for citation scans is governed by every currently enabled
// rule whose published membership includes the document. This deliberately
// uses the global effective union rather than only the rule ids that triggered
// an immediate scan: an overlapping rule must never have its tighter download
// or request-rate policy bypassed merely because another matching rule queued
// the work.
export async function listEffectiveCitationPoliciesForDocument(docId) {
  const rows = await all(`
    SELECT r.id AS rule_id,
           r.max_content_bytes,
           r.content_rate_limit
    FROM rule_document_processing_eligibility e
    JOIN import_rule_eligibility_projections p
      ON p.rule_id = e.rule_id
     AND p.completed_token = e.projection_token
    JOIN import_rules r ON r.id = e.rule_id
    WHERE e.doc_id = ?
      AND r.extract_citations = 1
    ORDER BY r.id
  `, [String(docId || '')]);
  return rows.map((row) => ({
    ruleId: String(row.rule_id),
    maxContentBytes: Number(row.max_content_bytes || 209715200),
    contentRateLimit: Number(row.content_rate_limit || 0),
  }));
}

// Once the first rule/document eligibility projection has been finalized,
// citation work is opt-in through the union of all matching rules whose current
// policy enables extraction. Before that migration boundary, the legacy corpus
// selectors remain available. A rule-scoped immediate run narrows the document
// set to memberships published by the requested rules, but the effective policy
// is still the global union, so an overlapping rule can keep a document eligible.
function citationEligibilityGate({ eligibilityRuleIds = [], documentAlias = 'd' } = {}) {
  const ruleIds = [...new Set((eligibilityRuleIds || [])
    .map((id) => String(id || '').trim()).filter(Boolean))];
  const eligibilityActivated = 'SELECT 1 FROM processing_eligibility_activation WHERE id = 1';
  const effectiveEligibility = `
    SELECT 1
    FROM rule_document_processing_eligibility effective_e
    JOIN import_rule_eligibility_projections effective_p
      ON effective_p.rule_id = effective_e.rule_id
     AND effective_p.completed_token = effective_e.projection_token
    JOIN import_rules effective_r ON effective_r.id = effective_e.rule_id
    WHERE effective_e.doc_id = ${documentAlias}.doc_id
      AND effective_r.extract_citations = 1
  `;
  if (!ruleIds.length) {
    return {
      sql: `AND (NOT EXISTS (${eligibilityActivated}) OR EXISTS (${effectiveEligibility}))`,
      args: [],
      legacyFallback: true,
    };
  }
  const placeholders = ruleIds.map(() => '?').join(', ');
  return {
    sql: `AND EXISTS (
      SELECT 1
      FROM rule_document_processing_eligibility scoped_e
      JOIN import_rule_eligibility_projections scoped_p
        ON scoped_p.rule_id = scoped_e.rule_id
       AND scoped_p.completed_token = scoped_e.projection_token
      WHERE scoped_e.doc_id = ${documentAlias}.doc_id
        AND scoped_e.rule_id IN (${placeholders})
    ) AND EXISTS (${effectiveEligibility})`,
    args: ruleIds,
    legacyFallback: false,
  };
}

// Selection gate shared by `listPendingCitationScans` and
// `countPendingCitationScans`, factored out so the two never drift. Returns just
// an SQL fragment (appended after the `content_source`/checksum requirement);
// every clause is a literal comparison against the 1:1 `ces` row, so the gate
// binds no args of its own.
//
// Scan-once, and parser-version-independent by design. A document that has a
// terminal citation record — any `document_citations` rows, or a `completed`
// state row, or a `failed` state row — is NOT reselected automatically, and a
// citation-parser/GROBID version bump changes nothing about selection. The only
// ways to reconsider a document are the explicit UI options: `retryFailures`
// drops the failed exclusion and overrides legacy partial links for a document
// explicitly recorded as failed, while `reprocess`
// drops every gate so all streamable in-scope documents are reselected — its
// re-extraction safely replaces existing citations (reextractDocumentCitations →
// replaceDocumentCitationLinks), so no manual clearing is needed. `reprocess`
// implies `retryFailures`. This keeps a parser upgrade from silently
// re-downloading the corpus; a deliberate `reprocess` run is the one path that
// re-scans already-scanned documents.
function citationScanGate({ retryFailures = false, reprocess = false }) {
  if (reprocess) return '';
  const clauses = ["AND COALESCE(ces.status, '') <> 'completed'"];
  if (retryFailures) {
    // A failed extraction may predate the atomic link-swap implementation and
    // have left partial links. An explicit retry must be able to repair it while
    // ordinary citation-bearing documents remain protected from re-scanning.
    clauses.push(`AND (
        COALESCE(ces.status, '') = 'failed'
        OR NOT EXISTS (SELECT 1 FROM document_citations dc WHERE dc.doc_id = d.doc_id)
      )`);
  } else {
    clauses.push("AND NOT EXISTS (SELECT 1 FROM document_citations dc WHERE dc.doc_id = d.doc_id)");
    clauses.push("AND COALESCE(ces.status, '') <> 'failed'");
  }
  return clauses.join('\n      ');
}

// Selection for the re-streaming citation scan job. The scan retrieves the PDF
// itself, so a published, eligible metadata-only document does not need an
// existing file_metrics row. Before eligibility projection is first activated,
// the legacy selector remains limited to documents previously recorded as a
// successful streamed PDF. Terminal scan-once gates apply in both cases unless
// `reprocess` deliberately reselects every eligible in-scope document.
export async function listPendingCitationScans({
  limit = 50, afterDocId = '', syncKey = null, filters: requestedFilters = {},
  retryFailures = false, reprocess = false, eligibilityRuleIds = [],
} = {}) {
  const filters = documentServingFilters({ syncKey, ...requestedFilters });
  const qualifier = filters.where ? 'AND' : 'WHERE';
  const gateSql = citationScanGate({ retryFailures, reprocess });
  const eligibility = citationEligibilityGate({ eligibilityRuleIds });
  const args = [
    ...filters.args,
    String(afterDocId || ''),
    ...eligibility.args,
    Math.max(1, Math.min(1000, Number(limit) || 50)),
  ];
  return all(`
    SELECT d.doc_id, d.metadata_json,
           COALESCE(fm.content_checksum, fm.updated_at, '') AS content_checksum,
           fm.content_source
    FROM documents d
    LEFT JOIN file_metrics fm ON fm.doc_id = d.doc_id
    LEFT JOIN citation_extraction_state ces ON ces.doc_id = d.doc_id
    ${filters.where}
    ${qualifier} d.doc_id > ?
      AND (
        (NOT EXISTS (
          SELECT 1 FROM processing_eligibility_activation WHERE id = 1
        ) AND fm.content_source = 'streamed_pdf' AND COALESCE(fm.content_checksum, '') <> '')
        OR EXISTS (
          SELECT 1
          FROM rule_document_processing_eligibility active_e
          JOIN import_rule_eligibility_projections active_p
            ON active_p.rule_id = active_e.rule_id
           AND active_p.completed_token = active_e.projection_token
          WHERE active_e.doc_id = d.doc_id
        )
      )
      ${eligibility.sql}
      ${gateSql}
    ORDER BY d.doc_id
    LIMIT ?
  `, args);
}

// Corpus-wide count of documents the citation scan would process, for the
// preview affordance and the schedule status card. Mirrors the selection above
// without the cursor or limit.
export async function countPendingCitationScans({
  syncKey = null, filters: requestedFilters = {},
  retryFailures = false, reprocess = false, eligibilityRuleIds = [],
} = {}) {
  const filters = documentServingFilters({ syncKey, ...requestedFilters });
  const qualifier = filters.where ? 'AND' : 'WHERE';
  const gateSql = citationScanGate({ retryFailures, reprocess });
  const eligibility = citationEligibilityGate({ eligibilityRuleIds });
  const row = await get(`
    SELECT COUNT(*) AS total
    FROM documents d
    LEFT JOIN file_metrics fm ON fm.doc_id = d.doc_id
    LEFT JOIN citation_extraction_state ces ON ces.doc_id = d.doc_id
    ${filters.where}
    ${qualifier} (
      (NOT EXISTS (
        SELECT 1 FROM processing_eligibility_activation WHERE id = 1
      ) AND fm.content_source = 'streamed_pdf' AND COALESCE(fm.content_checksum, '') <> '')
      OR EXISTS (
        SELECT 1
        FROM rule_document_processing_eligibility active_e
        JOIN import_rule_eligibility_projections active_p
          ON active_p.rule_id = active_e.rule_id
         AND active_p.completed_token = active_e.projection_token
        WHERE active_e.doc_id = d.doc_id
      )
    )
      ${eligibility.sql}
      ${gateSql}
  `, [...filters.args, ...eligibility.args]);
  return Number(row?.total || 0);
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
  const [row, pending] = await Promise.all([
    get(`
      SELECT
        (SELECT COUNT(*) FROM catalogue_lookups) AS total,
        (SELECT COUNT(*) FROM catalogue_lookups WHERE hits > 0) AS found,
        (SELECT COUNT(*) FROM catalogue_lookups WHERE hits = 0) AS not_found,
        (SELECT COUNT(*) FROM catalogue_lookups WHERE hits = -1) AS failed,
        (SELECT COUNT(*) FROM catalogue_lookups WHERE hits IS NULL) AS skipped
    `),
    // Reuse countPendingLookups()'s predicate (NOT a table-total subtraction) so the
    // dashboard number can never disagree with the pager/resolution-job's own count.
    // See #30 (M-09): the previous arithmetic here double-counted/under-counted once
    // citations and catalogue_lookups rows could be deleted independently of each other.
    countPendingLookups(),
  ]);
  return {
    total: Number(row?.total || 0),
    found: Number(row?.found || 0),
    not_found: Number(row?.not_found || 0),
    failed: Number(row?.failed || 0),
    skipped: Number(row?.skipped || 0),
    pending: Number(pending || 0),
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

// #25: dc1/dc2's self-join has no bound on its own — both arms already use
// covering indexes (dc1: idx_document_citations_citation_doc; dc2: the
// implicit index behind PRIMARY KEY(doc_id, citation_id)), verified by
// EXPLAIN QUERY PLAN, so this was never an indexing gap. The bottleneck is
// the *cardinality* the join is asked to process: with no document-set bound
// it processes every document that contains any of the top-50 citations
// corpus-wide, which grows with total corpus size regardless of how bounded
// the caller's own document sample already is. `docIds`, when supplied,
// scopes both top_citations and the self-join to that bounded set via a
// single JSON-array parameter (`WHERE doc_id IN (SELECT value FROM
// json_each(?))`) rather than a giant literal IN list, which risks
// exceeding libsql's parameter-count ceiling above a few hundred ids. Do not
// add a new index here — the existing ones already cover this query; the fix
// is bounding the input, not the lookup path.
export async function getCitationCooccurrence(limit = 100, docIds = null) {
  const hasBound = Array.isArray(docIds) && docIds.length > 0;
  const boundJson = hasBound ? JSON.stringify(docIds) : null;
  const topCitationsFilter = hasBound ? 'WHERE doc_id IN (SELECT value FROM json_each(?))' : '';
  const selfJoinFilter = hasBound ? 'AND dc1.doc_id IN (SELECT value FROM json_each(?))' : '';
  const args = [];
  if (hasBound) args.push(boundJson);
  if (hasBound) args.push(boundJson);
  args.push(limit);

  return all(`
    WITH top_citations AS (
      SELECT citation_id, COUNT(DISTINCT doc_id) AS cnt
      FROM document_citations
      ${topCitationsFilter}
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
    WHERE 1 = 1 ${selfJoinFilter}
    GROUP BY dc1.citation_id, dc2.citation_id
    HAVING shared >= 2
    ORDER BY shared DESC
    LIMIT ?
  `, args);
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
    degradedText: stats.degraded_text,
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
