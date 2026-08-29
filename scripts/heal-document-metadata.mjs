import { getDb, saveDocumentMetadata } from '../src/db.js';
import { normalizeRecord } from '../src/metrics.js';

// NOTE (#28): documents.source_json no longer stores the full upstream Open
// Collections record -- only a trimmed provenance stub ({ id, sourceUpdatedAt }).
// This script re-derives metadata from source_json, which is only possible for
// rows that still carry a full record. `deriveHealedDocument` refuses to heal
// from an insufficient (trimmed) source, so the script can never blank out good
// metadata_json. Post-#28 that means it is effectively a no-op on a migrated
// corpus; re-deriving metadata now requires a live re-fetch from Open
// Collections, not this cache-based path. Consider retiring this script.

const PLACEHOLDER_TITLE = '';
const PLACEHOLDER_AUTHOR = 'Unknown';

function hasRealValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') {
    const t = value.trim();
    return t !== '' && t !== PLACEHOLDER_AUTHOR && t !== '(Unspecified)';
  }
  if (Array.isArray(value)) {
    return value.some((v) => hasRealValue(v));
  }
  return true;
}

// Decide whether re-deriving from `source` would improve or degrade the row.
// Returns { doc } to save, or { skip, reason } to leave the row untouched.
// The core invariant: never replace a stored value that has real content with a
// normalized value that is empty/placeholder (the exact corruption a trimmed
// source_json would otherwise cause post-#28).
export function deriveHealedDocument({ source, stored }) {
  const normalizedDoc = normalizeRecord(source);

  // If normalization produced only placeholders for the core identity fields
  // while the stored row already has real ones, the source is insufficient
  // (e.g. a trimmed #28 provenance stub). Refuse -- healing would regress.
  const normalizedHasCore =
    hasRealValue(normalizedDoc.title) || hasRealValue(normalizedDoc.author) ||
    hasRealValue(normalizedDoc.abstract) || hasRealValue(normalizedDoc.subjects);
  const storedHasCore =
    hasRealValue(stored.title) || hasRealValue(stored.author) ||
    hasRealValue(stored.abstract) || hasRealValue(stored.subjects);

  if (!normalizedHasCore && storedHasCore) {
    return { skip: true, reason: 'insufficient-source' };
  }

  // Re-apply stored metrics and PDF fields
  if (stored.pages) {
    normalizedDoc.pages = stored.pages;
    normalizedDoc.pagesSource = stored.pagesSource || 'cached_pdf';
  }
  if (stored.wordCount) {
    normalizedDoc.wordCount = stored.wordCount;
    normalizedDoc.wordCountSource = stored.wordCountSource || 'cached_pdf_text';
  }
  if (stored.bodyWordCount) {
    normalizedDoc.bodyWordCount = stored.bodyWordCount;
  }
  if (stored.fileBytes) {
    normalizedDoc.fileBytes = stored.fileBytes;
  }
  if (stored.downloadStatus) {
    normalizedDoc.downloadStatus = stored.downloadStatus;
  }
  if (stored.downloadError) {
    normalizedDoc.downloadError = stored.downloadError;
  }
  if (stored.downloadUrl) {
    normalizedDoc.downloadUrl = stored.downloadUrl;
  }

  // Preserve committee and citation counts
  if (stored.committee) {
    normalizedDoc.committee = stored.committee;
  }
  if (stored.citationCount !== undefined) {
    normalizedDoc.citationCount = stored.citationCount;
  }

  // Preserve supervisors
  if (stored.supervisors && stored.supervisors.length) {
    normalizedDoc.supervisors = stored.supervisors;
    normalizedDoc.supervisorsSource = stored.supervisorsSource || 'pdf';
  }

  // Preserve BERTopic/UMAP coordinates
  if (stored.topicId !== undefined) {
    normalizedDoc.topicId = stored.topicId;
  }
  if (stored.topicProbability !== undefined) {
    normalizedDoc.topicProbability = stored.topicProbability;
  }
  if (stored.umapX !== undefined) {
    normalizedDoc.umapX = stored.umapX;
    normalizedDoc.umapY = stored.umapY;
  }

  return { doc: normalizedDoc };
}

async function main() {
  const db = await getDb();
  console.log('Fetching documents from DB...');
  const rows = (await db.execute(
    'SELECT doc_id, metadata_json, sync_key, source_json FROM documents WHERE source_json IS NOT NULL'
  )).rows;

  console.log(`Found ${rows.length} documents to consider.`);

  let healed = 0;
  let skipped = 0;
  for (const row of rows) {
    const docId = row.doc_id;
    try {
      const source = JSON.parse(row.source_json);
      const stored = JSON.parse(row.metadata_json);

      const result = deriveHealedDocument({ source, stored });
      if (result.skip) {
        skipped++;
        continue;
      }

      await saveDocumentMetadata(result.doc, { syncKey: row.sync_key, source });
      healed++;
    } catch (e) {
      console.error(`Failed to heal doc ${docId}:`, e);
    }
  }

  console.log(`Healed ${healed}/${rows.length} documents; skipped ${skipped} with insufficient source_json.`);
  if (healed === 0 && skipped > 0) {
    console.log(
      'No documents were healed: source_json carries only trimmed provenance (#28), ' +
      'so metadata cannot be re-derived from it. Re-derive from a live Open Collections re-fetch instead.'
    );
  }
  process.exit(0);
}

// Only run when invoked directly, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
