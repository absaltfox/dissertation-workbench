import test from 'node:test';
import assert from 'node:assert/strict';
import { documentsPlanViolations, DOCUMENTS_COVERING_SCAN_SQL } from '../scripts/lib/documents-plan-check.mjs';

// The rehearsal's plan classifier. Rehearsal 2 (Turso branch, 2026-11-09) planned the
// unfiltered guard `(d.doc_id >= '' OR d.doc_id IS NULL)` as a MULTI-INDEX OR: the range
// arm through idx_documents_cover_doc, and the IS NULL arm as an equality probe of the
// primary-key index. That arm matches no row (prod: 0 NULL doc_ids; the probe reads 0
// rows), so it never reads the table and must not count as a violation. Any other
// non-covering documents access still must.

const GUARDED = `SELECT COUNT(*) AS documents FROM documents d WHERE (COALESCE(d.access_status, 'unknown') NOT IN ('embargoed', 'verification_due')) AND ${DOCUMENTS_COVERING_SCAN_SQL}`;
const BRANCH_PLAN = [
  'MULTI-INDEX OR',
  'INDEX 1',
  'SEARCH d USING COVERING INDEX idx_documents_cover_doc (doc_id>?)',
  'INDEX 2',
  'SEARCH d USING INDEX sqlite_autoindex_documents_1 (doc_id=?)',
];

test('the plan check uses the same guard text as src/db.js', async () => {
  process.env.SKIP_LOCAL_ENV = '1';
  const db = await import('../src/db.js');
  assert.equal(DOCUMENTS_COVERING_SCAN_SQL, db.DOCUMENTS_COVERING_SCAN_SQL);
});

test("the guard's IS NULL arm on the primary-key index is not a table read", () => {
  assert.deepEqual(documentsPlanViolations(GUARDED, BRANCH_PLAN), []);
});

test('a primary-key probe is still a violation without the guard, or without its covering range arm', () => {
  const probe = 'SEARCH d USING INDEX sqlite_autoindex_documents_1 (doc_id=?)';
  assert.deepEqual(documentsPlanViolations('SELECT d.title FROM document_topics t JOIN documents d ON d.doc_id = t.doc_id', [probe]), [probe]);
  assert.deepEqual(documentsPlanViolations(GUARDED, ['MULTI-INDEX OR', 'INDEX 1', 'SEARCH d USING INDEX idx_documents_cover_doc (doc_id>?)', 'INDEX 2', probe]),
    ['SEARCH d USING INDEX idx_documents_cover_doc (doc_id>?)', probe]);
  // Two primary-key probes: only one can be the IS NULL arm.
  assert.deepEqual(documentsPlanViolations(GUARDED, [...BRANCH_PLAN, probe]), [probe]);
});

test('full table scans and the charCount / page row-fetch exemptions are unchanged', () => {
  assert.deepEqual(documentsPlanViolations('SELECT COUNT(*) FROM documents d', ['SCAN d']), ['SCAN d']);
  assert.deepEqual(documentsPlanViolations('SELECT COUNT(*) FROM documents', ['SCAN documents']), ['SCAN documents']);
  assert.deepEqual(documentsPlanViolations("SELECT COUNT(json_extract(d.metadata_json, '$.charCount')) FROM documents d", ['SCAN d']), []);
  assert.deepEqual(documentsPlanViolations('WITH page AS (SELECT 1) SELECT d.metadata_json FROM page p JOIN documents d ON d.doc_id = p.doc_id',
    ['SCAN p', 'SEARCH d USING INDEX sqlite_autoindex_documents_1 (doc_id=?)']), []);
});
