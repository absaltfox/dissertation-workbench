import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backfillSourceJsonProvenance,
  closeDb,
  createSyncRun,
  ensureStorage,
  getDb,
  getLatestSyncRun,
  saveDocumentMetadata,
  saveDocumentMetadataBatch,
} from '../src/db.js';

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function readSourceJson(docId) {
  const client = await getDb();
  const result = await client.execute({
    sql: 'SELECT source_json FROM documents WHERE doc_id = ?',
    args: [docId],
  });
  return result.rows.length ? result.rows[0].source_json : undefined;
}

test.after(async () => {
  await closeDb();
});

test('#28: single-document ingestion strips full_text-shaped fields from source_json', async () => {
  await ensureStorage();
  const docId = uid('single-strip');
  const rawSource = {
    id: 'oc-raw-id-1',
    title: 'A raw upstream title that should never be persisted',
    updated_at: '2026-01-01T00:00:00Z',
    full_text: 'x'.repeat(5000),
    FullText: 'also should not survive',
    transcript: 'nor this',
    text: 'nor this either',
    ocr: 'nor this',
    body: 'nor this',
  };

  await saveDocumentMetadata({
    id: docId,
    title: 'Single-document strip fixture',
    author: 'Author',
    year: 2026,
  }, { source: rawSource });

  const raw = await readSourceJson(docId);
  assert.ok(raw, 'source_json should be persisted');
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed).sort(), ['id', 'sourceUpdatedAt']);
  assert.equal(parsed.id, 'oc-raw-id-1');
  assert.equal(parsed.sourceUpdatedAt, '2026-01-01T00:00:00Z');
  assert.equal(raw.includes('x'.repeat(20)), false, 'full_text payload must not ride into source_json');
  assert.equal(raw.includes('never be persisted'), false, 'unrelated raw fields must not ride into source_json');
});

test('#28: batch ingestion strips full_text-shaped fields from source_json', async () => {
  await ensureStorage();
  const docId = uid('batch-strip');
  const rawSource = {
    id: 'oc-raw-id-2',
    updatedAt: '2026-02-02T00:00:00Z',
    full_text: 'y'.repeat(5000),
    body: 'should also not survive',
  };

  await saveDocumentMetadataBatch([{
    doc: { id: docId, title: 'Batch strip fixture', author: 'Author', year: 2026 },
    source: rawSource,
  }]);

  const raw = await readSourceJson(docId);
  assert.ok(raw);
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed).sort(), ['id', 'sourceUpdatedAt']);
  assert.equal(parsed.id, 'oc-raw-id-2');
  assert.equal(parsed.sourceUpdatedAt, '2026-02-02T00:00:00Z');
  assert.equal(raw.includes('y'.repeat(20)), false);
  assert.equal(raw.includes('should also not survive'), false);
});

test('#28: source_json is null when no provenance source is supplied', async () => {
  await ensureStorage();
  const docId = uid('no-source');
  await saveDocumentMetadata({ id: docId, title: 'No-source fixture' });
  const raw = await readSourceJson(docId);
  assert.equal(raw, null);
});

test('#28: migration trims existing full-record source_json rows, including NULL and malformed rows, and is idempotent', async () => {
  await ensureStorage();
  const client = await getDb();
  const now = new Date().toISOString();

  const fullRecordId = uid('migrate-full');
  const nullId = uid('migrate-null');
  const malformedId = uid('migrate-malformed');
  const alreadyTrimmedId = uid('migrate-trimmed');

  // Simulate pre-fix rows written before this migration existed, bypassing
  // saveDocumentMetadata's (now-trimming) write path on purpose.
  await client.batch([
    {
      sql: `INSERT INTO documents (doc_id, metadata_json, source_json, synced_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        fullRecordId, JSON.stringify({ id: fullRecordId }),
        JSON.stringify({
          id: 'oc-legacy-1',
          title: 'Legacy full upstream record',
          updated_at: '2025-06-01T00:00:00Z',
          full_text: 'z'.repeat(5000),
          body: 'legacy body text',
        }),
        now, now,
      ],
    },
    {
      sql: `INSERT INTO documents (doc_id, metadata_json, source_json, synced_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [nullId, JSON.stringify({ id: nullId }), null, now, now],
    },
    {
      sql: `INSERT INTO documents (doc_id, metadata_json, source_json, synced_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [malformedId, JSON.stringify({ id: malformedId }), '{not valid json', now, now],
    },
    {
      sql: `INSERT INTO documents (doc_id, metadata_json, source_json, synced_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        alreadyTrimmedId, JSON.stringify({ id: alreadyTrimmedId }),
        JSON.stringify({ id: 'oc-already-trimmed', sourceUpdatedAt: '2025-01-01T00:00:00Z' }),
        now, now,
      ],
    },
  ], 'write');

  // Prove the pre-fix baseline actually carries the full_text payload before
  // the migration runs, so this test would have caught the bug.
  const beforeRaw = await readSourceJson(fullRecordId);
  assert.ok(beforeRaw.includes('z'.repeat(20)), 'baseline fixture must carry the unstripped payload');

  // Reset the one-time-completion marker: earlier ensureStorage() calls in
  // this process already ran the migration against a corpus with nothing to
  // trim and marked it complete. Clearing it here simulates the real-world
  // starting condition the migration is meant for — a database that has
  // never had it run — deterministically, regardless of test order.
  await client.execute({
    sql: "DELETE FROM serving_projection_state WHERE projection_key = 'source_json_trim'",
  });

  await backfillSourceJsonProvenance(client);

  const fullAfter = JSON.parse(await readSourceJson(fullRecordId));
  assert.deepEqual(Object.keys(fullAfter).sort(), ['id', 'sourceUpdatedAt']);
  assert.equal(fullAfter.id, 'oc-legacy-1');
  assert.equal(fullAfter.sourceUpdatedAt, '2025-06-01T00:00:00Z');
  const fullAfterRaw = await readSourceJson(fullRecordId);
  assert.equal(fullAfterRaw.includes('z'.repeat(20)), false);
  assert.equal(fullAfterRaw.includes('legacy body text'), false);

  assert.equal(await readSourceJson(nullId), null);
  assert.equal(await readSourceJson(malformedId), '{not valid json');

  const trimmedAfter = JSON.parse(await readSourceJson(alreadyTrimmedId));
  assert.deepEqual(trimmedAfter, { id: 'oc-already-trimmed', sourceUpdatedAt: '2025-01-01T00:00:00Z' });

  // Idempotency: re-running after completion is a no-op (0 rows touched) and
  // does not disturb any row, including the deliberately-malformed one.
  const secondRunCount = await backfillSourceJsonProvenance(client);
  assert.equal(secondRunCount, 0);
  assert.equal(await readSourceJson(malformedId), '{not valid json');
  assert.equal(await readSourceJson(nullId), null);
  assert.deepEqual(JSON.parse(await readSourceJson(fullRecordId)), fullAfter);
});

test('#28: the migration does not touch sync_runs.source_json (a different table)', async () => {
  await ensureStorage();
  const syncKey = uid('sync-run-key');
  const fullSyncSource = {
    maxRecords: 100,
    query: 'education',
    someUpstreamLookingField: 'full_text-shaped values here should be left alone: it is a request-options record, not upstream document data',
  };
  const runId = await createSyncRun(syncKey, fullSyncSource);

  await backfillSourceJsonProvenance(await getDb());

  const latest = await getLatestSyncRun(syncKey);
  assert.equal(latest.id, runId);
  assert.deepEqual(latest.source, fullSyncSource);
});
