import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@libsql/client';
import { SQLITE_PATH, PDF_CACHE_DIR } from './config.js';
import { logger } from './logger.js';
import { normalizePersonName, supervisorNameKey } from './supervisors.js';
import { encryptMfaSecret, decryptMfaSecret } from './secretCrypto.js';

let db;
let schemaReady;

export function getDatabaseUrl() {
  return (process.env.TURSO_DATABASE_URL || `file:${SQLITE_PATH}`).trim();
}

export async function ensureStorage() {
  await fs.mkdir(PDF_CACHE_DIR, { recursive: true });
  if (!process.env.TURSO_DATABASE_URL) {
    await fs.mkdir(path.dirname(SQLITE_PATH), { recursive: true });
  }
}

export async function getDb() {
  if (!db) {
    db = createClient({
      url: getDatabaseUrl(),
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  if (!schemaReady) {
    schemaReady = ensureSchema(db);
  }
  await schemaReady;
  return db;
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
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_metrics (
      doc_id TEXT PRIMARY KEY,
      pdf_path TEXT,
      download_url TEXT,
      file_bytes INTEGER,
      word_count INTEGER,
      page_count INTEGER,
      word_source TEXT,
      page_source TEXT,
      status TEXT,
      error TEXT,
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

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      mfa_secret TEXT,
      mfa_enabled INTEGER NOT NULL DEFAULT 0,
      mfa_enabled_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL
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
  `);

  await tryExec(client, 'ALTER TABLE catalogue_lookups ADD COLUMN bib_id TEXT');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN sync_key TEXT');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN title TEXT');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN author TEXT');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN year INTEGER');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN degree TEXT');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN program TEXT');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN source_json TEXT');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN source_updated_at TEXT');
  await tryExec(client, 'ALTER TABLE documents ADD COLUMN synced_at TEXT');
  await tryExec(client, 'ALTER TABLE users ADD COLUMN mfa_secret TEXT');
  await tryExec(client, 'ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0');
  await tryExec(client, 'ALTER TABLE users ADD COLUMN mfa_enabled_at TEXT');
  await tryExec(client, 'ALTER TABLE citations ADD COLUMN author TEXT');
  await tryExec(client, 'ALTER TABLE citations ADD COLUMN title TEXT');
  await tryExec(client, 'ALTER TABLE citations ADD COLUMN year TEXT');
  await tryExec(client, 'ALTER TABLE citations ADD COLUMN source TEXT');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_documents_sync_key ON documents(sync_key)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_documents_year ON documents(year)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_documents_degree ON documents(degree)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_documents_program ON documents(program)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_document_citations_citation_id ON document_citations(citation_id)');
  await tryExec(client, 'CREATE INDEX IF NOT EXISTS idx_document_citations_citation_doc ON document_citations(citation_id, doc_id)');

  const cleaned = await cleanupCommitteeArtifacts(client);
  if (cleaned > 0) logger.info(`Cleaned up ${cleaned} committee artefact rows`);
}

export async function cleanupCommitteeArtifacts(dbInstance = null) {
  const client = dbInstance || await getDb();
  const result = await client.execute(`
    DELETE FROM committee_members
    WHERE lower(name) IN (
      'additional supervisory committee members:',
      'additional supervisory committee members',
      'examining committee members',
      'examining committee',
      'supervisory committee members',
      'supervisory committee',
      'committee members'
    )
  `);
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

export async function saveDocumentMetadata(doc, { syncKey = null, source = null } = {}) {
  const now = new Date().toISOString();
  const cols = documentColumns(doc, syncKey, source);
  await run(`
    INSERT INTO documents (
      doc_id, metadata_json, sync_key, title, author, year, degree, program,
      source_json, source_updated_at, synced_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      updated_at = excluded.updated_at
  `, [
    doc.id, JSON.stringify(doc), cols.syncKey, cols.title, cols.author, cols.year,
    cols.degree, cols.program, cols.sourceJson, cols.sourceUpdatedAt,
    syncKey ? now : null, now
  ]);
}

function saveDocumentStatement(doc, { syncKey = null, source = null } = {}, now = new Date().toISOString()) {
  const cols = documentColumns(doc, syncKey, source);
  return {
    sql: `
      INSERT INTO documents (
        doc_id, metadata_json, sync_key, title, author, year, degree, program,
        source_json, source_updated_at, synced_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    cleaned.map((item) => saveDocumentStatement(item.doc, {
      syncKey: item.syncKey || null,
      source: item.source || null,
    }, now)),
    'write'
  );
  return cleaned.length;
}

export async function loadDocumentMetadata(docId) {
  const row = await get('SELECT metadata_json FROM documents WHERE doc_id = ?', [docId]);
  if (!row) return null;
  try { return JSON.parse(row.metadata_json); } catch { return null; }
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

export async function listCachedDocuments({ syncKey, limit = 1000 } = {}) {
  const args = [];
  let sql = 'SELECT doc_id, metadata_json FROM documents';
  if (syncKey) {
    sql += ' WHERE sync_key = ?';
    args.push(syncKey);
  }
  sql += ' ORDER BY year DESC, title LIMIT ?';
  args.push(limit);
  const rows = await all(sql, args);
  return rows.map((row) => {
    try { return JSON.parse(row.metadata_json); } catch { return null; }
  }).filter(Boolean);
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

// --- File metric functions ---

export async function loadStoredFileMetric(docId) {
  return get(`
    SELECT doc_id, pdf_path, download_url, file_bytes, word_count, page_count,
           word_source, page_source, status, error, updated_at
    FROM file_metrics
    WHERE doc_id = ?
  `, [docId]);
}

export async function saveFileMetric(docId, payload) {
  const now = new Date().toISOString();
  await run(`
    INSERT INTO file_metrics (
      doc_id, pdf_path, download_url, file_bytes, word_count, page_count,
      word_source, page_source, status, error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_id) DO UPDATE SET
      pdf_path = excluded.pdf_path,
      download_url = excluded.download_url,
      file_bytes = excluded.file_bytes,
      word_count = excluded.word_count,
      page_count = excluded.page_count,
      word_source = excluded.word_source,
      page_source = excluded.page_source,
      status = excluded.status,
      error = excluded.error,
      updated_at = excluded.updated_at
  `, [
    docId,
    payload.pdfPath || null,
    payload.downloadUrl || null,
    payload.fileBytes ?? null,
    payload.wordCount ?? null,
    payload.pageCount ?? null,
    payload.wordSource || null,
    payload.pageSource || null,
    payload.status || null,
    payload.error || null,
    now
  ]);
}

export async function deleteFileMetric(docId) {
  await run('DELETE FROM file_metrics WHERE doc_id = ?', [docId]);
}

export async function listFileMetrics() {
  return all(`
    SELECT doc_id, pdf_path, download_url, file_bytes, word_count, page_count,
           word_source, page_source, status, error, updated_at
    FROM file_metrics
    ORDER BY updated_at DESC
  `);
}

export async function getFileMetricsStats() {
  return get(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN file_bytes IS NOT NULL THEN file_bytes ELSE 0 END) AS total_bytes,
           SUM(CASE WHEN status = 'downloaded' OR status = 'redownloaded' OR status = 'cached' OR status = 'recomputed_from_cache' THEN 1 ELSE 0 END) AS with_pdf,
           SUM(CASE WHEN status = 'not_found' OR status = 'cache_miss' THEN 1 ELSE 0 END) AS failed,
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

export async function createUser(username, passwordHash, salt) {
  const now = new Date().toISOString();
  await run(`
    INSERT INTO users (username, password_hash, salt, created_at)
    VALUES (?, ?, ?, ?)
  `, [username, passwordHash, salt, now]);
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
  if (result.changes > 0) logger.info('User password updated', { username });
  return result.changes > 0;
}

export async function findUserByUsername(username) {
  const user = await get(`
    SELECT id, username, password_hash, salt, mfa_secret, mfa_enabled, mfa_enabled_at, created_at
    FROM users
    WHERE username = ?
  `, [username]);
  if (user?.mfa_secret) user.mfa_secret = decryptMfaSecret(user.mfa_secret);
  return user;
}

export async function listUsers() {
  return all('SELECT id, username, mfa_enabled, mfa_enabled_at, created_at FROM users ORDER BY created_at');
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
  for (const member of members || []) {
    const role = member.role || null;
    const normalizedName = normalizePersonName(member.name);
    if (!normalizedName) continue;
    const key = `${String(role || '')}:::${supervisorNameKey(normalizedName) || normalizedName.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await run(`
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
    `, [docId, normalizedName, role, member.affiliation || null, source, now]);
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
  const result = await run(sql, params);
  return result.changes || 0;
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

export async function saveCitations(docId, citations, hashFn) {
  const now = new Date().toISOString();
  for (const item of citations) {
    const text = typeof item === 'string' ? item : item.text;
    const hash = hashFn(text);
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
    const row = await get('SELECT id FROM citations WHERE citation_hash = ?', [hash]);
    if (row) {
      await run(`
        INSERT INTO document_citations (doc_id, citation_id, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(doc_id, citation_id) DO UPDATE SET updated_at = excluded.updated_at
      `, [docId, row.id, now]);
    }
  }
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

export async function clearDocumentCitations(docId) {
  await run('DELETE FROM document_citations WHERE doc_id = ?', [docId]);
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
  return get(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN hits > 0 THEN 1 ELSE 0 END) AS found,
      SUM(CASE WHEN hits = 0 THEN 1 ELSE 0 END) AS not_found,
      SUM(CASE WHEN hits IS NULL THEN 1 ELSE 0 END) AS skipped
    FROM catalogue_lookups
  `);
}

export async function listPendingLookups(limit = 100) {
  return all(`
    SELECT c.id, c.citation_text, c.author, c.title, c.year, c.source
    FROM citations c
    LEFT JOIN catalogue_lookups cl ON cl.citation_id = c.id
    WHERE cl.citation_id IS NULL
       OR (cl.hits IS NULL AND cl.query_title IS NOT NULL)
    LIMIT ?
  `, [limit]);
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

export async function loadDocumentTopics() {
  const rows = await all('SELECT doc_id, topic_id, probability FROM document_topics');
  const map = new Map();
  for (const row of rows) {
    map.set(row.doc_id, { topicId: Number(row.topic_id), probability: row.probability != null ? Number(row.probability) : null });
  }
  return map;
}

export async function loadDocumentTopicCoords() {
  try {
    const rows = await all('SELECT doc_id, umap_x, umap_y FROM document_topic_coords');
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
