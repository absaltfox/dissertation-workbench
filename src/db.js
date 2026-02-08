import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SQLITE_PATH, PDF_CACHE_DIR } from './config.js';
import { logger } from './logger.js';

let db;

export async function ensureStorage() {
  await fs.mkdir(PDF_CACHE_DIR, { recursive: true });
  await fs.mkdir(path.dirname(SQLITE_PATH), { recursive: true });
}

export function getDb() {
  if (db) return db;
  db = new DatabaseSync(SQLITE_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      doc_id TEXT PRIMARY KEY,
      metadata_json TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
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
  `);
  return db;
}

// --- Document functions ---

export function saveDocumentMetadata(doc) {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO documents (doc_id, metadata_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(doc_id) DO UPDATE SET
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(doc.id, JSON.stringify(doc), now);
}

export function loadDocumentMetadata(docId) {
  const row = getDb().prepare('SELECT metadata_json FROM documents WHERE doc_id = ?').get(docId);
  if (!row) return null;
  try { return JSON.parse(row.metadata_json); } catch { return null; }
}

// --- File metric functions ---

export function loadStoredFileMetric(docId) {
  return getDb().prepare(`
    SELECT doc_id, pdf_path, download_url, file_bytes, word_count, page_count,
           word_source, page_source, status, error, updated_at
    FROM file_metrics
    WHERE doc_id = ?
  `).get(docId);
}

export function saveFileMetric(docId, payload) {
  const now = new Date().toISOString();
  getDb().prepare(`
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
  `).run(
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
  );
}

export function deleteFileMetric(docId) {
  getDb().prepare('DELETE FROM file_metrics WHERE doc_id = ?').run(docId);
}

export function listFileMetrics() {
  return getDb().prepare(`
    SELECT doc_id, pdf_path, download_url, file_bytes, word_count, page_count,
           word_source, page_source, status, error, updated_at
    FROM file_metrics
    ORDER BY updated_at DESC
  `).all();
}

export function getFileMetricsStats() {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN file_bytes IS NOT NULL THEN file_bytes ELSE 0 END) AS total_bytes,
           SUM(CASE WHEN status = 'downloaded' OR status = 'redownloaded' OR status = 'cached' OR status = 'recomputed_from_cache' THEN 1 ELSE 0 END) AS with_pdf,
           SUM(CASE WHEN status = 'not_found' OR status = 'cache_miss' THEN 1 ELSE 0 END) AS failed,
           MIN(updated_at) AS oldest,
           MAX(updated_at) AS newest
    FROM file_metrics
  `).get();
  return row;
}

// --- Run metrics functions ---

export function saveRunMetrics(source, metrics) {
  const now = new Date().toISOString();
  const runKey = crypto.createHash('sha1').update(JSON.stringify(source)).digest('hex');
  getDb().prepare(`
    INSERT INTO metric_runs (run_key, source_json, metrics_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(runKey, JSON.stringify(source), JSON.stringify(metrics), now);
}

export function listRecentRuns(limit = 50) {
  return getDb().prepare(`
    SELECT id, run_key, source_json, metrics_json, created_at
    FROM metric_runs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

// --- User functions ---

export function createUser(username, passwordHash, salt) {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO users (username, password_hash, salt, created_at)
    VALUES (?, ?, ?, ?)
  `).run(username, passwordHash, salt, now);
  logger.info('User created', { username });
}

export function deleteUser(username) {
  const result = getDb().prepare('DELETE FROM users WHERE username = ?').run(username);
  if (result.changes > 0) logger.info('User deleted', { username });
  return result.changes > 0;
}

export function findUserByUsername(username) {
  return getDb().prepare('SELECT id, username, password_hash, salt, created_at FROM users WHERE username = ?').get(username);
}

export function listUsers() {
  return getDb().prepare('SELECT id, username, created_at FROM users ORDER BY created_at').all();
}

export function countUsers() {
  const row = getDb().prepare('SELECT COUNT(*) AS cnt FROM users').get();
  return row.cnt;
}

// --- Settings functions ---

export function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value, now);
}

export function getAllSettings() {
  const rows = getDb().prepare('SELECT key, value, updated_at FROM settings ORDER BY key').all();
  const obj = {};
  for (const row of rows) obj[row.key] = row.value;
  return obj;
}

// --- Cache integrity ---

export async function checkCacheIntegrity() {
  const entries = getDb().prepare('SELECT doc_id, pdf_path FROM file_metrics WHERE pdf_path IS NOT NULL').all();
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

export function saveCommitteeMembers(docId, members, source) {
  const now = new Date().toISOString();
  const stmt = getDb().prepare(`
    INSERT INTO committee_members (doc_id, name, role, affiliation, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_id, name, role) DO UPDATE SET
      affiliation = excluded.affiliation,
      source = excluded.source,
      updated_at = excluded.updated_at
  `);
  for (const member of members) {
    stmt.run(docId, member.name, member.role || null, member.affiliation || null, source, now);
  }
}

export function loadCommitteeMembers(docId) {
  return getDb().prepare(`
    SELECT name, role, affiliation, source
    FROM committee_members
    WHERE doc_id = ?
    ORDER BY id
  `).all(docId);
}

// --- Citation functions ---

export function saveCitations(docId, citationTexts, hashFn) {
  const now = new Date().toISOString();
  const upsertCitation = getDb().prepare(`
    INSERT INTO citations (citation_hash, citation_text, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(citation_hash) DO NOTHING
  `);
  const getCitationId = getDb().prepare(`
    SELECT id FROM citations WHERE citation_hash = ?
  `);
  const linkCitation = getDb().prepare(`
    INSERT INTO document_citations (doc_id, citation_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(doc_id, citation_id) DO UPDATE SET updated_at = excluded.updated_at
  `);

  for (const text of citationTexts) {
    const hash = hashFn(text);
    upsertCitation.run(hash, text, now);
    const row = getCitationId.get(hash);
    if (row) {
      linkCitation.run(docId, row.id, now);
    }
  }
}

export function loadDocumentCitations(docId) {
  return getDb().prepare(`
    SELECT c.citation_text
    FROM document_citations dc
    JOIN citations c ON c.id = dc.citation_id
    WHERE dc.doc_id = ?
    ORDER BY c.id
  `).all(docId);
}

export function getCitationStats() {
  const row = getDb().prepare(`
    SELECT
      (SELECT COUNT(*) FROM citations) AS total_citations,
      (SELECT COUNT(*) FROM document_citations) AS total_links
  `).get();
  return row;
}

export async function logCacheStats() {
  const stats = getFileMetricsStats();
  logger.info('PDF cache stats', {
    totalEntries: stats.total,
    totalBytes: stats.total_bytes,
    withPdf: stats.with_pdf,
    failed: stats.failed,
    oldest: stats.oldest,
    newest: stats.newest,
  });
}
