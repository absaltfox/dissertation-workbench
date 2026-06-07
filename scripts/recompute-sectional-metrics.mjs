import { getDb, saveFileMetric, saveDocumentMetadata, listFileMetrics } from '../src/db.js';
import { analyzePdfAtPath, fileExists } from '../src/pdf.js';

async function main() {
  console.log('Retrieving file metrics from database...');
  const entries = await listFileMetrics();
  const cachedEntries = entries.filter(e => e.pdf_path);
  console.log(`Found ${entries.length} total entries, with ${cachedEntries.length} cached PDFs.`);

  let processed = 0;
  let successCount = 0;
  let failCount = 0;
  const CONCURRENCY = 10;
  
  // Create an array of tasks
  const tasks = [...cachedEntries];
  
  async function worker() {
    while (tasks.length > 0) {
      const entry = tasks.shift();
      if (!entry) break;
      
      const docId = entry.doc_id;
      try {
        if (!(await fileExists(entry.pdf_path))) {
          console.warn(`[WARN] File not found for docId ${docId}: ${entry.pdf_path}`);
          failCount++;
          continue;
        }
        
        const analysis = await analyzePdfAtPath(entry.pdf_path);
        
        let doc = null;
        if (entry.metadata_json) {
          try {
            doc = JSON.parse(entry.metadata_json);
          } catch (e) {
            // ignore
          }
        }
        if (!doc) {
          doc = { id: docId, supervisors: entry.supervisors || [] };
        }
        // Ensure ID is correct
        doc.id = docId;
        
        if (analysis.pageCount) {
          doc.pages = analysis.pageCount;
          doc.pagesSource = 'cached_pdf';
        }
        if (analysis.wordCount) {
          doc.wordCount = analysis.wordCount;
          doc.wordCountSource = 'cached_pdf_text';
        }
        if (analysis.bodyWordCount) {
          doc.bodyWordCount = analysis.bodyWordCount;
        }
        doc.fileBytes = analysis.fileBytes;
        doc.downloadStatus = 'recomputed_from_cache';
        doc.downloadError = null;
        doc.downloadUrl = entry.download_url || null;
        
        await saveDocumentMetadata(doc);
        await saveFileMetric(docId, {
          status: 'recomputed_from_cache',
          error: null,
          pdfPath: entry.pdf_path,
          downloadUrl: entry.download_url || null,
          fileBytes: analysis.fileBytes,
          wordCount: doc.wordCount,
          bodyWordCount: doc.bodyWordCount,
          pageCount: doc.pages,
          wordSource: doc.wordCountSource,
          pageSource: doc.pagesSource
        });
        
        successCount++;
      } catch (err) {
        console.error(`[ERROR] Failed to process docId ${docId}:`, err.message);
        failCount++;
      } finally {
        processed++;
        if (processed % 20 === 0 || processed === cachedEntries.length) {
          console.log(`Progress: ${processed}/${cachedEntries.length} processed (${successCount} succeeded, ${failCount} failed).`);
        }
      }
    }
  }

  console.log(`Starting recalculation with concurrency = ${CONCURRENCY}...`);
  const startTime = Date.now();
  
  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nFinished recalculation in ${duration} seconds.`);
  console.log(`Total: ${cachedEntries.length}, Succeeded: ${successCount}, Failed: ${failCount}`);
  
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error running script:', err);
  process.exit(1);
});
