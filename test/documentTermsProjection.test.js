import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

let getDb, ensureStorage, closeDb, saveDocumentMetadataBatch, tempDir;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-terms-'));
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;
  ({ getDb, ensureStorage, closeDb, saveDocumentMetadataBatch } = await import('../src/db.js'));
  await ensureStorage();
  await getDb();
});
test.after(async () => { await closeDb(); await fs.rm(tempDir, { recursive: true, force: true }); });

test('metadata write projects theme/concept/methodology rows and sets version 2', async () => {
  await saveDocumentMetadataBatch([{ doc: {
    id: 'dt-1', title: 'T', author: 'A', year: 2020, degree: 'PhD', program: 'Education',
    themes: ['Indigenous Education', 'Language Policy'],
    conceptTerms: ['concept alpha', 'concept beta'],
    methodologies: ['Qualitative'],
  } }]);
  const db = await getDb();
  const rows = await db.execute("SELECT kind, term FROM document_terms WHERE doc_id='dt-1' ORDER BY kind, term");
  assert.deepEqual(rows.rows.map((r) => [r.kind, r.term]), [
    ['concept', 'concept alpha'], ['concept', 'concept beta'],
    ['methodology', 'Qualitative'],
    ['theme', 'Indigenous Education'], ['theme', 'Language Policy'],
  ]);
  const v = await db.execute("SELECT serving_projection_version v FROM documents WHERE doc_id='dt-1'");
  assert.equal(Number(v.rows[0].v), 2);
});

test('re-writing the same doc is idempotent (no duplicate rows)', async () => {
  const doc = { id: 'dt-2', title: 'T', themes: ['Alpha'], conceptTerms: [], methodologies: [] };
  await saveDocumentMetadataBatch([{ doc }]);
  await saveDocumentMetadataBatch([{ doc }]);
  const db = await getDb();
  const rows = await db.execute("SELECT COUNT(*) c FROM document_terms WHERE doc_id='dt-2'");
  assert.equal(Number(rows.rows[0].c), 1);
});

test('backfill projects legacy rows (version<2) and flips readiness', async () => {
  const db = await getDb();
  const { runDocumentTermsBackfillOnce, initDocumentTermsReadiness, isDocumentTermsReady } = await import('../src/db.js');
  // Simulate a legacy row: metadata present, terms not yet projected, version 1.
  await db.execute({
    sql: "INSERT INTO documents (doc_id, metadata_json, serving_projection_version, updated_at) VALUES (?, ?, 1, ?)",
    args: ['legacy-1', JSON.stringify({ id: 'legacy-1', themes: ['Legacy Theme'], conceptTerms: [], methodologies: [] }), new Date().toISOString()],
  });
  await initDocumentTermsReadiness();
  assert.equal(isDocumentTermsReady(), false); // legacy row pending
  await runDocumentTermsBackfillOnce();
  const rows = await db.execute("SELECT kind, term FROM document_terms WHERE doc_id='legacy-1'");
  assert.deepEqual(rows.rows.map((r) => [r.kind, r.term]), [['theme', 'Legacy Theme']]);
  const v = await db.execute("SELECT serving_projection_version v FROM documents WHERE doc_id='legacy-1'");
  assert.equal(Number(v.rows[0].v), 2);
  assert.equal(isDocumentTermsReady(), true);
});

test('backfill runs ANALYZE so the planner has fresh document_terms statistics', async () => {
  const db = await getDb();
  const { runDocumentTermsBackfillOnce, initDocumentTermsReadiness } = await import('../src/db.js');
  await db.execute({
    sql: "INSERT INTO documents (doc_id, metadata_json, serving_projection_version, updated_at) VALUES (?, ?, 1, ?)",
    args: ['legacy-analyze-1', JSON.stringify({ id: 'legacy-analyze-1', themes: ['Stats Theme'], conceptTerms: ['stats concept'], methodologies: [] }), new Date().toISOString()],
  });
  await initDocumentTermsReadiness();
  await runDocumentTermsBackfillOnce();
  const statTable = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'");
  assert.equal(statTable.rows.length, 1, 'ANALYZE should have created sqlite_stat1');
  const stats = await db.execute("SELECT COUNT(*) AS c FROM sqlite_stat1 WHERE tbl = 'document_terms'");
  assert.ok(Number(stats.rows[0].c) > 0, 'sqlite_stat1 should have an entry for document_terms after ANALYZE');
});
