export const DOCUMENT_SYNC_MODES = new Set(['import_all', 'sync_differences', 'refresh_metadata', 'sync_missing_pdfs']);

// `existsFn` is the per-document seam tests inject. `existsBatchFn` is the
// production form: it takes the whole page of ids and returns a Set of the ones
// that exist, so a page costs one SELECT instead of one per record (H-05).
export async function filterSyncItemsForMode(items, mode, existsFn, { existsBatchFn = null } = {}) {
  if (mode === 'import_all') {
    return { items, skipped: 0 };
  }

  const list = Array.isArray(items) ? items : [];
  let existingIds = null;
  if (existsBatchFn) {
    existingIds = await existsBatchFn(list.map((item) => item.doc?.id));
  }

  const kept = [];
  let skipped = 0;
  for (const item of list) {
    const docId = item.doc?.id;
    const exists = existingIds
      ? Boolean(docId) && existingIds.has(String(docId))
      : await existsFn(docId);
    if (mode === 'sync_differences' && exists) {
      skipped += 1;
      continue;
    }
    if (mode === 'refresh_metadata' && !exists) {
      skipped += 1;
      continue;
    }
    kept.push(item);
  }
  return { items: kept, skipped };
}
