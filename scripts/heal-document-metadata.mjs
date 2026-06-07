import { getDb, saveDocumentMetadata } from '../src/db.js';
import { normalizeRecord } from '../src/metrics.js';

async function main() {
  const db = await getDb();
  console.log('Fetching documents from DB...');
  const rows = (await db.execute(
    'SELECT doc_id, metadata_json, sync_key, source_json FROM documents WHERE source_json IS NOT NULL'
  )).rows;
  
  console.log(`Found ${rows.length} documents to heal.`);
  
  let healed = 0;
  for (const row of rows) {
    const docId = row.doc_id;
    try {
      const source = JSON.parse(row.source_json);
      const stored = JSON.parse(row.metadata_json);
      
      // Normalize using the source API metadata
      const normalizedDoc = normalizeRecord(source);
      
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
      
      // Save healed metadata back
      await saveDocumentMetadata(normalizedDoc, { syncKey: row.sync_key, source });
      healed++;
    } catch (e) {
      console.error(`Failed to heal doc ${docId}:`, e);
    }
  }
  
  console.log(`Successfully healed ${healed}/${rows.length} documents.`);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
