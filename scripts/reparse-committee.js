#!/usr/bin/env node
// One-off script: re-parse committee data for specific docs from cached PDFs.
// Usage: node scripts/reparse-committee.js

import { loadDocumentMetadata, getDb } from '../src/db.js';
import { analyzeDocumentFile } from '../src/pdf.js';

const DOC_IDS = [
  '1.0401357',
  '1.0447312',
  '1.0450763',
  '1.0422496',
  '1.0371220',
  '1.0391920',
  '1.0445487',
];

for (const docId of DOC_IDS) {
  const doc = loadDocumentMetadata(docId);
  if (!doc) {
    console.log(`[SKIP] ${docId} — not found in DB`);
    continue;
  }
  doc.id = docId;
  try {
    // Delete all existing committee entries so stale bad names are removed
    getDb().prepare('DELETE FROM committee_members WHERE doc_id = ?').run(docId);
    await analyzeDocumentFile(doc, { recomputeFromCache: true });
    const committee = (doc.committee || []).map(m => `${m.name} (${m.role})`).join(', ');
    console.log(`[OK]   ${docId} — ${committee || 'no committee parsed'}`);
  } catch (err) {
    console.log(`[ERR]  ${docId} — ${err.message}`);
  }
}
