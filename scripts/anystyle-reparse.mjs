/**
 * Re-extract citations from all cached PDFs using AnyStyle ML parser.
 *
 * Reads cached PDFs from file_metrics, runs pdftotext + AnyStyle, and
 * replaces citations in the database. Run merge-duplicate-citations.mjs
 * afterward to consolidate any new dedup matches.
 *
 * Usage:
 *   node scripts/anystyle-reparse.mjs [--dry-run]
 */

import fs from 'node:fs/promises';
import { ensureStorage, getDb, clearDocumentCitations, saveCitations, loadDocumentCitations } from '../src/db.js';
import { analyzePdfAtPath, parseBibliographyWithAnyStyle, parseBibliography, normalizeCitation } from '../src/pdf.js';

const dryRun = process.argv.includes('--dry-run');

await ensureStorage();
const db = await getDb();

// Find all docs with a cached PDF
const rows = (await db.execute(`
  SELECT doc_id, pdf_path FROM file_metrics
  WHERE pdf_path IS NOT NULL AND pdf_path != ''
  ORDER BY doc_id
`)).rows;

console.log(`Found ${rows.length} cached PDFs to process${dryRun ? ' (DRY RUN)' : ''}\n`);

let processed = 0;
let failed = 0;
let totalOld = 0;
let totalNew = 0;

for (const row of rows) {
  const { doc_id, pdf_path } = row;

  try {
    // Check file exists
    await fs.access(pdf_path);
  } catch {
    console.log(`  [SKIP] doc ${doc_id}: PDF not found at ${pdf_path}`);
    failed++;
    continue;
  }

  try {
    // Extract full text from cached PDF
    const analysis = await analyzePdfAtPath(pdf_path);
    if (!analysis.fullText) {
      console.log(`  [SKIP] doc ${doc_id}: no text extracted`);
      failed++;
      continue;
    }

    // Get old citation count for comparison
    const oldCitations = await loadDocumentCitations(doc_id);
    const oldCount = oldCitations.length;

    // Extract with AnyStyle
    const newCitations = await parseBibliographyWithAnyStyle(analysis.fullText);
    const newCount = newCitations.length;

    const delta = newCount - oldCount;
    const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;
    console.log(`  doc ${doc_id}: ${oldCount} → ${newCount} citations (${deltaStr})`);

    if (!dryRun) {
      await clearDocumentCitations(doc_id);
      if (newCitations.length) {
        await saveCitations(doc_id, newCitations, normalizeCitation);
      }
    }

    totalOld += oldCount;
    totalNew += newCount;
    processed++;
  } catch (err) {
    console.error(`  [ERROR] doc ${doc_id}: ${err.message}`);
    failed++;
  }
}

console.log(`\n--- Summary ---`);
console.log(`Processed: ${processed} / ${rows.length}`);
console.log(`Failed/skipped: ${failed}`);
console.log(`Citations: ${totalOld} → ${totalNew} (${totalNew - totalOld >= 0 ? '+' : ''}${totalNew - totalOld})`);
if (dryRun) console.log(`\n(Dry run — no changes written. Remove --dry-run to apply.)`);
else console.log(`\nDone. Run 'node scripts/merge-duplicate-citations.mjs' to consolidate duplicates.`);
