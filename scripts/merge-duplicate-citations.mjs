/**
 * One-time migration: re-hash all citations with the improved normalizeCitation
 * function and merge any groups that now share the same hash.
 *
 * Safe to run multiple times — idempotent once duplicates are gone.
 *
 * Usage:
 *   node scripts/merge-duplicate-citations.mjs
 */

import { ensureStorage, getDb } from '../src/db.js';
import { normalizeCitation } from '../src/pdf.js';

await ensureStorage();
const db = getDb();

// ─── 1. Compute new hash for every citation ─────────────────────────────────

const all = db.prepare(
  'SELECT id, citation_hash, citation_text FROM citations ORDER BY id'
).all();

console.log(`Loaded ${all.length} citations. Computing new hashes…`);

// Map: new_hash → [{ id, citation_text, doc_count }]
const groups = new Map();

for (const row of all) {
  const newHash = normalizeCitation(row.citation_text);
  if (!groups.has(newHash)) groups.set(newHash, []);
  groups.get(newHash).push({ id: row.id, citation_text: row.citation_text, oldHash: row.citation_hash });
}

// Annotate each entry with its document_citations count (to pick the canonical)
const getDocCount = db.prepare(
  'SELECT COUNT(*) as n FROM document_citations WHERE citation_id = ?'
);
for (const group of groups.values()) {
  for (const entry of group) {
    entry.doc_count = getDocCount.get(entry.id).n;
  }
}

// ─── 2. Find groups with duplicates ─────────────────────────────────────────

const dupGroups = [...groups.entries()].filter(([, g]) => g.length > 1);
const soloGroups = [...groups.entries()].filter(([, g]) => g.length === 1);

console.log(`\nDuplicate groups:   ${dupGroups.length}`);
console.log(`Solo (unique) rows: ${soloGroups.length}`);

const redundantCount = dupGroups.reduce((s, [, g]) => s + g.length - 1, 0);
console.log(`Redundant rows to merge: ${redundantCount}`);

if (dupGroups.length === 0 && soloGroups.every(([h, [g]]) => h === g.oldHash)) {
  console.log('\nNothing to do — all hashes already up to date.');
  process.exit(0);
}

// ─── 3. Merge duplicates ─────────────────────────────────────────────────────

const insertOrIgnoreLink = db.prepare(`
  INSERT OR IGNORE INTO document_citations (doc_id, citation_id, updated_at)
  SELECT doc_id, ?, updated_at FROM document_citations WHERE citation_id = ?
`);
const deleteLinks = db.prepare(
  'DELETE FROM document_citations WHERE citation_id = ?'
);
const hasLookup = db.prepare(
  'SELECT citation_id FROM catalogue_lookups WHERE citation_id = ?'
);
const moveLookup = db.prepare(
  'UPDATE catalogue_lookups SET citation_id = ? WHERE citation_id = ?'
);
const deleteLookup = db.prepare(
  'DELETE FROM catalogue_lookups WHERE citation_id = ?'
);
const deleteCitation = db.prepare('DELETE FROM citations WHERE id = ?');
const updateHash = db.prepare(
  'UPDATE citations SET citation_hash = ? WHERE id = ?'
);

let merged = 0;

db.prepare('BEGIN').run();
try {
  for (const [newHash, group] of dupGroups) {
    // Pick canonical = highest doc_count; tie-break on lowest id (oldest)
    group.sort((a, b) => b.doc_count - a.doc_count || a.id - b.id);
    const canonical = group[0];
    const nonCanonical = group.slice(1);

    console.log(`\nMerging ${group.length} variants → canonical id=${canonical.id} (${canonical.doc_count} docs):`);
    console.log(`  KEEP: ${canonical.citation_text.slice(0, 100)}`);

    for (const dup of nonCanonical) {
      console.log(`  DROP: ${dup.citation_text.slice(0, 100)} (${dup.doc_count} docs)`);

      // Re-link document_citations to canonical
      insertOrIgnoreLink.run(canonical.id, dup.id);
      deleteLinks.run(dup.id);

      // Re-link catalogue_lookup if canonical lacks one
      if (!hasLookup.get(canonical.id) && hasLookup.get(dup.id)) {
        moveLookup.run(canonical.id, dup.id);
      } else {
        deleteLookup.run(dup.id);
      }

      // Remove the duplicate citation row
      deleteCitation.run(dup.id);
      merged++;
    }

    // Update canonical's hash to new normalized value
    updateHash.run(newHash, canonical.id);
  }

  // ─── 4. Update hashes for solo rows that haven't changed hash ─────────────
  let hashUpdates = 0;
  for (const [newHash, [entry]] of soloGroups) {
    if (entry.oldHash !== newHash) {
      updateHash.run(newHash, entry.id);
      hashUpdates++;
    }
  }

  db.prepare('COMMIT').run();
  console.log(`\n✓ Merged ${merged} redundant citation rows.`);
  console.log(`✓ Updated hashes on ${hashUpdates} solo citations.`);
} catch (err) {
  db.prepare('ROLLBACK').run();
  console.error('Migration failed, rolled back:', err);
  process.exit(1);
}

// ─── 5. Final summary ────────────────────────────────────────────────────────

const finalCount = db.prepare('SELECT COUNT(*) as n FROM citations').get().n;
const finalLinks = db.prepare('SELECT COUNT(*) as n FROM document_citations').get().n;
console.log(`\nFinal state: ${finalCount} citations, ${finalLinks} document-citation links`);
