import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSyncItemsForMode } from '../src/syncModes.js';

const items = [
  { doc: { id: 'cached-1' } },
  { doc: { id: 'new-1' } },
  { doc: { id: 'cached-2' } },
];

async function exists(id) {
  return id.startsWith('cached');
}

test('import_all keeps new and existing documents', async () => {
  const result = await filterSyncItemsForMode(items, 'import_all', exists);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.items.map((item) => item.doc.id), ['cached-1', 'new-1', 'cached-2']);
});

test('sync_differences keeps only globally missing documents', async () => {
  const result = await filterSyncItemsForMode(items, 'sync_differences', exists);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.items.map((item) => item.doc.id), ['new-1']);
});

test('refresh_metadata keeps only globally cached documents', async () => {
  const result = await filterSyncItemsForMode(items, 'refresh_metadata', exists);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.items.map((item) => item.doc.id), ['cached-1', 'cached-2']);
});

test('sync_missing_pdfs considers all matching documents before PDF filtering', async () => {
  const result = await filterSyncItemsForMode(items, 'sync_missing_pdfs', exists);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.items.map((item) => item.doc.id), ['cached-1', 'new-1', 'cached-2']);
});
