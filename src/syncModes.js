export const DOCUMENT_SYNC_MODES = new Set(['import_all', 'sync_differences', 'refresh_metadata', 'sync_missing_pdfs']);

export async function filterSyncItemsForMode(items, mode, existsFn) {
  if (mode === 'import_all') {
    return { items, skipped: 0 };
  }

  const kept = [];
  let skipped = 0;
  for (const item of items) {
    const exists = await existsFn(item.doc?.id);
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
