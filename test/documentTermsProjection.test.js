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
