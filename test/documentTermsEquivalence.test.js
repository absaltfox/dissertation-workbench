import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs/promises';

let db, ensureStorage, getDb, closeDb, saveDocumentMetadataBatch,
    queryRelatedDocuments, __setDocumentTermsReadyForTesting, tempDir;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-equiv-'));
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;
  ({ ensureStorage, getDb, closeDb, saveDocumentMetadataBatch,
     queryRelatedDocuments, __setDocumentTermsReadyForTesting } = await import('../src/db.js'));
  await ensureStorage(); db = await getDb();
  const docs = Array.from({ length: 40 }, (_, i) => ({ doc: {
    id: `rel-${i}`, title: `Doc ${i}`, author: `A${i}`, year: 2000 + (i % 10), degree: 'PhD',
    themes: [`theme ${i % 5}`, `theme ${(i + 1) % 5}`],
    conceptTerms: [`concept ${i % 4}`], methodologies: [],
  } }));
  await saveDocumentMetadataBatch(docs);
});
test.after(async () => { await closeDb(); await fs.rm(tempDir, { recursive: true, force: true }); });

test('related-docs: projection path equals json_each path', async () => {
  const target = { id: 'rel-0', themes: ['theme 0', 'theme 1'], conceptTerms: ['concept 0'] };
  __setDocumentTermsReadyForTesting(false);
  const legacy = await queryRelatedDocuments(target, { limit: 6 });
  __setDocumentTermsReadyForTesting(true);
  const projected = await queryRelatedDocuments(target, { limit: 6 });
  assert.deepEqual(projected, legacy);
});
