/**
 * Re-extract citations from all cached PDFs using GROBID.
 *
 * Requires GROBID running on localhost:8070 (or GROBID_URL env var):
 *   docker run --rm --init --ulimit core=0 -p 8070:8070 grobid/grobid:0.8.2
 *
 * Reads cached PDFs from file_metrics, POSTs each to GROBID's
 * processReferences endpoint, parses TEI-XML, and replaces citations
 * in the database with structured fields. Run merge-duplicate-citations.mjs
 * afterward to consolidate any new dedup matches.
 *
 * Usage:
 *   node scripts/grobid-reparse.mjs [--dry-run]
 */

import fs from 'node:fs/promises';
import { ensureStorage, getDb, clearDocumentCitations, saveCitations, loadDocumentCitations } from '../src/db.js';
import { parseBibliographyWithGrobid, normalizeCitation } from '../src/pdf.js';
import { GROBID_URL } from '../src/config.js';
import { runPendingCatalogueLookups } from '../src/catalogue.js';

const dryRun = process.argv.includes('--dry-run');
const TIMEOUT_MS = 120_000; // 2 minutes per PDF

// Check GROBID availability
try {
  const res = await fetch(`${GROBID_URL}/api/isalive`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  console.log(`GROBID available at ${GROBID_URL}\n`);
} catch (err) {
  console.error(`GROBID not available at ${GROBID_URL}: ${err.message}`);
  console.error('Start GROBID with: docker run --rm --init --ulimit core=0 -p 8070:8070 grobid/grobid:0.8.2');
  process.exit(1);
}

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
let kept = 0;
let totalOld = 0;
let totalNew = 0;
let withStructured = 0;
const startTime = Date.now();

for (const row of rows) {
  const { doc_id, pdf_path } = row;

  try {
    await fs.access(pdf_path);
  } catch {
    console.log(`  [SKIP] doc ${doc_id}: PDF not found at ${pdf_path}`);
    failed++;
    continue;
  }

  try {
    const oldCitations = await loadDocumentCitations(doc_id);
    const oldCount = oldCitations.length;

    const citations = await parseBibliographyWithGrobid(pdf_path, { timeoutMs: TIMEOUT_MS });
    if (!citations) {
      console.log(`  [SKIP] doc ${doc_id}: GROBID failed or timed out`);
      failed++;
      continue;
    }

    const newCount = citations.length;
    const structured = citations.filter(c => c.title || c.author).length;
    const delta = newCount - oldCount;
    const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;

    // Regression protection: keep old citations if GROBID found none
    // but old had some (likely a scanned/image PDF GROBID can't handle)
    if (newCount === 0 && oldCount > 0) {
      console.log(`  [KEEP] doc ${doc_id}: GROBID found 0, keeping ${oldCount} existing citations`);
      kept++;
      continue;
    }

    console.log(`  doc ${doc_id}: ${oldCount} → ${newCount} citations (${deltaStr}), ${structured} structured`);

    if (!dryRun) {
      await clearDocumentCitations(doc_id);
      if (citations.length) {
        await saveCitations(doc_id, citations, normalizeCitation);
      }
    }

    totalOld += oldCount;
    totalNew += newCount;
    withStructured += structured;
    processed++;
  } catch (err) {
    console.error(`  [ERROR] doc ${doc_id}: ${err.message}`);
    failed++;
  }
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n--- Summary ---`);
console.log(`Processed: ${processed} / ${rows.length} (${elapsed}s)`);
console.log(`Failed/skipped: ${failed}`);
console.log(`Kept (regression protection): ${kept}`);
console.log(`Citations: ${totalOld} → ${totalNew} (${totalNew - totalOld >= 0 ? '+' : ''}${totalNew - totalOld})`);
console.log(`With structured fields: ${withStructured}`);
if (dryRun) {
  console.log(`\n(Dry run — no changes written. Remove --dry-run to apply.)`);
} else {
  console.log(`\nRunning Z39.50 catalogue lookups for new citations...`);
  try {
    const lookupStats = await runPendingCatalogueLookups();
    console.log(`Catalogue lookups: ${lookupStats.processed} processed, ${lookupStats.found} found, ${lookupStats.notFound} not found, ${lookupStats.skipped} skipped`);
  } catch (err) {
    console.error(`Catalogue lookup error: ${err.message}`);
    console.log('You can run lookups later via the server API: POST /api/catalogue/lookup');
  }
  console.log(`\nDone. Run 'node scripts/merge-duplicate-citations.mjs' to consolidate duplicates.`);
}
