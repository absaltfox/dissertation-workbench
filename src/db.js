import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SQLITE_PATH, PDF_CACHE_DIR } from './config.js';
import { logger } from './logger.js';
import { normalizePersonName, supervisorNameKey } from './supervisors.js';

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

    CREATE INDEX IF NOT EXISTS idx_document_citations_doc_id ON document_citations(doc_id);

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

  // Migrations — add columns to existing tables
  try { db.exec('ALTER TABLE catalogue_lookups ADD COLUMN bib_id TEXT'); } catch {}
  try { db.exec('ALTER TABLE citations ADD COLUMN author TEXT'); } catch {}
  try { db.exec('ALTER TABLE citations ADD COLUMN title TEXT'); } catch {}
  try { db.exec('ALTER TABLE citations ADD COLUMN year TEXT'); } catch {}
  try { db.exec('ALTER TABLE citations ADD COLUMN source TEXT'); } catch {}

  const cleaned = cleanupCommitteeArtifacts(db);
  if (cleaned > 0) logger.info(`Cleaned up ${cleaned} committee artefact rows`);

  return db;
}

export function cleanupCommitteeArtifacts(dbInstance) {
  const d = dbInstance || getDb();
  return d.prepare(`
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
  `).run().changes;
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

export function listAllDocumentMetadata() {
  const rows = getDb().prepare('SELECT doc_id, metadata_json FROM documents').all();
  return rows.map((row) => {
    try {
      return { docId: row.doc_id, metadata: JSON.parse(row.metadata_json) };
    } catch {
      return null;
    }
  }).filter(Boolean);
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
  `);
  // Second dedup layer: normalised name-key + role. The caller may also dedup by exact name,
  // and the SQL UNIQUE(doc_id, name, role) constraint provides a final safety net.
  const seen = new Set();
  for (const member of members || []) {
    const role = member.role || null;
    const normalizedName = normalizePersonName(member.name);
    if (!normalizedName) continue;
    const key = `${String(role || '')}:::${supervisorNameKey(normalizedName) || normalizedName.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stmt.run(docId, normalizedName, role, member.affiliation || null, source, now);
  }
}

export function deleteCommitteeMembersByRoles(docId, roles, source = null) {
  const cleanedRoles = Array.from(new Set((roles || []).map((r) => String(r || '').trim()).filter(Boolean)));
  if (!cleanedRoles.length) return 0;
  const placeholders = cleanedRoles.map(() => '?').join(', ');
  const params = [docId, ...cleanedRoles];
  let sql = `DELETE FROM committee_members WHERE doc_id = ? AND role IN (${placeholders})`;
  if (source) {
    sql += ' AND source = ?';
    params.push(source);
  }
  const result = getDb().prepare(sql).run(...params);
  return result.changes || 0;
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

export function saveCitations(docId, citations, hashFn) {
  const now = new Date().toISOString();
  const upsertCitation = getDb().prepare(`
    INSERT INTO citations (citation_hash, citation_text, author, title, year, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(citation_hash) DO UPDATE SET
      author = COALESCE(excluded.author, citations.author),
      title = COALESCE(excluded.title, citations.title),
      year = COALESCE(excluded.year, citations.year),
      source = COALESCE(excluded.source, citations.source)
  `);
  const getCitationId = getDb().prepare(`
    SELECT id FROM citations WHERE citation_hash = ?
  `);
  const linkCitation = getDb().prepare(`
    INSERT INTO document_citations (doc_id, citation_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(doc_id, citation_id) DO UPDATE SET updated_at = excluded.updated_at
  `);

  for (const item of citations) {
    const text = typeof item === 'string' ? item : item.text;
    const hash = hashFn(text);
    upsertCitation.run(
      hash, text,
      (typeof item === 'string' ? null : item.author) || null,
      (typeof item === 'string' ? null : item.title) || null,
      (typeof item === 'string' ? null : item.year) || null,
      (typeof item === 'string' ? null : item.source) || null,
      now
    );
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

export function loadDocumentCitationsWithSharing(docId) {
  return getDb().prepare(`
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
  `).all(docId);
}

export function loadDocsByCitation(citationId) {
  return getDb().prepare(`
    SELECT d.doc_id as id, json_extract(d.metadata_json, '$.title') as title,
      json_extract(d.metadata_json, '$.author') as author
    FROM document_citations dc
    JOIN documents d ON d.doc_id = dc.doc_id
    WHERE dc.citation_id = ?
    ORDER BY title
  `).all(citationId);
}

export function clearDocumentCitations(docId) {
  getDb().prepare('DELETE FROM document_citations WHERE doc_id = ?').run(docId);
  // Remove orphaned citation rows (citations no longer linked to any document).
  // catalogue_lookups has a FK to citations.id so must be cleaned first.
  getDb().exec('DELETE FROM catalogue_lookups WHERE citation_id NOT IN (SELECT DISTINCT citation_id FROM document_citations)');
  getDb().exec('DELETE FROM citations WHERE id NOT IN (SELECT DISTINCT citation_id FROM document_citations)');
}

export function clearAllCitations() {
  getDb().exec('DELETE FROM catalogue_lookups');
  getDb().exec('DELETE FROM document_citations');
  getDb().exec('DELETE FROM citations');
}

export function getCitationStats() {
  const row = getDb().prepare(`
    SELECT
      (SELECT COUNT(*) FROM citations) AS total_citations,
      (SELECT COUNT(*) FROM document_citations) AS total_links
  `).get();
  return row;
}

// --- Catalogue lookup functions ---

export function saveCatalogueLookup(citationId, { hits, queryAuthor, queryTitle, bibId }) {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO catalogue_lookups (citation_id, hits, query_author, query_title, bib_id, looked_up_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(citation_id) DO UPDATE SET
      hits = excluded.hits,
      query_author = excluded.query_author,
      query_title = excluded.query_title,
      bib_id = excluded.bib_id,
      looked_up_at = excluded.looked_up_at
  `).run(citationId, hits ?? null, queryAuthor || null, queryTitle || null, bibId || null, now);
}

export function loadCatalogueLookup(citationId) {
  return getDb().prepare(`
    SELECT citation_id, hits, query_author, query_title, looked_up_at
    FROM catalogue_lookups
    WHERE citation_id = ?
  `).get(citationId);
}

export function getCitationForSummon(citationId) {
  return getDb().prepare(`
    SELECT c.citation_text, cl.query_title, cl.query_author
    FROM citations c
    LEFT JOIN catalogue_lookups cl ON cl.citation_id = c.id
    WHERE c.id = ?
  `).get(citationId);
}

export function getCatalogueLookupStats() {
  return getDb().prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN hits > 0 THEN 1 ELSE 0 END) AS found,
      SUM(CASE WHEN hits = 0 THEN 1 ELSE 0 END) AS not_found,
      SUM(CASE WHEN hits IS NULL THEN 1 ELSE 0 END) AS skipped
    FROM catalogue_lookups
  `).get();
}

export function listPendingLookups(limit = 100) {
  // Include two populations:
  // 1. Citations with no lookup row at all (truly new).
  // 2. Citations where a previous lookup ran but stored hits=NULL with a non-null
  //    query_title — these are Z39.50 network/timeout failures that should be retried.
  //    Citations stored with query_title=NULL were intentionally skipped (unparseable)
  //    and are not retried here; the improved extractor will handle them on first run.
  return getDb().prepare(`
    SELECT c.id, c.citation_text, c.author, c.title, c.year, c.source
    FROM citations c
    LEFT JOIN catalogue_lookups cl ON cl.citation_id = c.id
    WHERE cl.citation_id IS NULL
       OR (cl.hits IS NULL AND cl.query_title IS NOT NULL)
    LIMIT ?
  `).all(limit);
}

export function getCitationCooccurrence(limit = 100) {
  // First find the top most-shared citations (those appearing in most dissertations),
  // then find co-occurrence pairs among them. This keeps the graph focused on the
  // most influential works rather than all 8k+ pairs at the minimum threshold.
  return getDb().prepare(`
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
  `).all(limit);
}

export function getTopCitedWorks(limit = 50) {
  return getDb().prepare(`
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
  `).all(limit);
}

// --- Topic functions ---

export function hasTopics() {
  try {
    const row = getDb().prepare('SELECT 1 FROM topics LIMIT 1').get();
    return !!row;
  } catch {
    return false;
  }
}

export function loadTopics() {
  const rows = getDb().prepare('SELECT topic_id, label, top_terms, doc_count, model_name, created_at FROM topics ORDER BY doc_count DESC').all();
  return rows.map((row) => ({
    topicId: row.topic_id,
    label: row.label,
    topTerms: (() => { try { return JSON.parse(row.top_terms); } catch { return []; } })(),
    docCount: row.doc_count,
    modelName: row.model_name,
    createdAt: row.created_at,
  }));
}

export function loadDocumentTopics() {
  const rows = getDb().prepare('SELECT doc_id, topic_id, probability FROM document_topics').all();
  const map = new Map();
  for (const row of rows) {
    map.set(row.doc_id, { topicId: row.topic_id, probability: row.probability });
  }
  return map;
}

export function loadDocumentTopicCoords() {
  try {
    const rows = getDb().prepare('SELECT doc_id, umap_x, umap_y FROM document_topic_coords').all();
    const map = new Map();
    for (const row of rows) {
      map.set(row.doc_id, { x: row.umap_x, y: row.umap_y });
    }
    return map;
  } catch {
    return new Map();
  }
}

export function loadTopicHierarchy() {
  try {
    const row = getDb().prepare('SELECT leaf_topic_ids, linkage_json FROM topic_hierarchy_meta WHERE id = 1').get();
    if (!row) return null;
    return {
      leafTopicIds: JSON.parse(row.leaf_topic_ids),
      linkage: JSON.parse(row.linkage_json),
    };
  } catch { return null; }
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
