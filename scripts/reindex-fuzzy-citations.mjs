/**
 * Retroactive migration: fuzzy-deduplicate all existing citations using
 * Jaro-Winkler string similarity (threshold >= 0.90) and merge duplicates.
 *
 * Safe to run multiple times — idempotent once duplicates are gone.
 *
 * Usage:
 *   node scripts/reindex-fuzzy-citations.mjs
 */

import { ensureStorage, getDb } from '../src/db.js';
import { jaroWinkler } from '../src/fuzzyMatch.js';

await ensureStorage();
const db = await getDb();

// ─── 1. Load all citations and annotate with document count ─────────────────
const allCitations = (await db.execute(
  'SELECT id, citation_hash, citation_text, author, title, year FROM citations ORDER BY id'
)).rows;

console.log(`Loaded ${allCitations.length} citations. Computing document frequencies…`);

const citationFreqs = new Map();
const freqRows = (await db.execute(
  'SELECT citation_id, COUNT(doc_id) as n FROM document_citations GROUP BY citation_id'
)).rows;

for (const row of freqRows) {
  citationFreqs.set(Number(row.citation_id), Number(row.n || 0));
}

// Map database records into JS objects
const citations = allCitations.map(row => {
  const text = row.citation_text || '';
  const lowText = text.toLowerCase();
  const yearVal = row.year || (() => {
    const m = text.match(/\b(1[89]\d{2}|20[0-2]\d)\b/);
    return m ? Number(m[0]) : null;
  })();
  return {
    id: Number(row.id),
    hash: row.citation_hash,
    text: text,
    lowText: lowText,
    year: yearVal ? Number(yearVal) : null,
    docCount: citationFreqs.get(Number(row.id)) || 0
  };
});

// Sort descending by document frequency, then ascending by ID
citations.sort((a, b) => b.docCount - a.docCount || a.id - b.id);

// ─── 2. Build fuzzy groups ──────────────────────────────────────────────────
console.log('Grouping citations using Jaro-Winkler similarity (threshold >= 0.90)…');

const canonicals = []; // list of canonical citation objects
const merges = new Map(); // childId -> canonicalId

// Index structures to narrow down candidate searches
const canonicalsByYear = new Map(); // year (Number) -> array of canonical citations
const canonicalsByPrefix = new Map(); // prefix (String) -> array of canonical citations
const canonicalsFallback = []; // citations with no year and no prefix

function addToIndex(can) {
  canonicals.push(can);
  if (can.year) {
    const yr = Number(can.year);
    if (!canonicalsByYear.has(yr)) {
      canonicalsByYear.set(yr, []);
    }
    canonicalsByYear.get(yr).push(can);
  } else {
    const prefix = can.lowText.trim().slice(0, 3);
    if (prefix.length === 3) {
      if (!canonicalsByPrefix.has(prefix)) {
        canonicalsByPrefix.set(prefix, []);
      }
      canonicalsByPrefix.get(prefix).push(can);
    } else {
      canonicalsFallback.push(can);
    }
  }
}

function getSearchPool(c) {
  if (c.year) {
    const yr = Number(c.year);
    const pool = [];
    const y1 = canonicalsByYear.get(yr - 1);
    if (y1) pool.push(...y1);
    const y2 = canonicalsByYear.get(yr);
    if (y2) pool.push(...y2);
    const y3 = canonicalsByYear.get(yr + 1);
    if (y3) pool.push(...y3);
    pool.push(...canonicalsFallback);
    return pool;
  } else {
    const prefix = c.lowText.trim().slice(0, 3);
    if (prefix.length === 3) {
      const pPool = canonicalsByPrefix.get(prefix) || [];
      return [...pPool, ...canonicalsFallback];
    } else {
      return canonicals; // Search everything if no year and no 3-char prefix
    }
  }
}

let lastLoggedPercent = -1;
const totalCount = citations.length;

for (let i = 0; i < totalCount; i++) {
  const c = citations[i];
  let matched = null;
  
  if (totalCount > 1000) {
    const percent = Math.floor((i / totalCount) * 100);
    if (percent !== lastLoggedPercent && percent % 10 === 0) {
      console.log(`  Progress: ${percent}% (${i}/${totalCount} processed)`);
      lastLoggedPercent = percent;
    }
  }

  const searchPool = getSearchPool(c);

  for (const can of searchPool) {
    const sim = jaroWinkler(c.lowText, can.lowText);
    if (sim >= 0.90) {
      matched = can;
      break;
    }
  }

  if (matched) {
    merges.set(c.id, matched.id);
  } else {
    addToIndex(c);
  }
}

console.log(`\nFuzzy clustering complete:`);
console.log(`  Initial citations:  ${citations.length}`);
console.log(`  Canonical citations: ${canonicals.length}`);
console.log(`  Duplicates to merge: ${merges.size}`);

if (merges.size === 0) {
  console.log('\nNo duplicate citations found. Everything is already deduplicated.');
  process.exit(0);
}

// ─── 3. Perform the database merge ──────────────────────────────────────────
console.log('\nStarting database merge within transaction…');

await db.execute('BEGIN');
try {
  let count = 0;
  for (const [dupId, canId] of merges.entries()) {
    const dup = citations.find(x => x.id === dupId);
    const can = citations.find(x => x.id === canId);
    if (!dup || !can) continue;

    console.log(`\nMerging id=${dup.id} → canonical id=${can.id} (${can.docCount} docs):`);
    console.log(`  KEEP: ${can.text.slice(0, 80)}`);
    console.log(`  DROP: ${dup.text.slice(0, 80)}`);

    // 1. Re-link document_citations
    await db.execute({
      sql: `
        INSERT OR IGNORE INTO document_citations (doc_id, citation_id, updated_at)
        SELECT doc_id, ?, updated_at FROM document_citations WHERE citation_id = ?
      `,
      args: [canId, dupId]
    });
    
    // Delete duplicate links
    await db.execute({
      sql: 'DELETE FROM document_citations WHERE citation_id = ?',
      args: [dupId]
    });

    // 2. Re-link catalogue_lookup if canonical lacks one
    const canonicalLookup = await db.execute({
      sql: 'SELECT citation_id FROM catalogue_lookups WHERE citation_id = ?',
      args: [canId]
    });
    const dupLookup = await db.execute({
      sql: 'SELECT citation_id FROM catalogue_lookups WHERE citation_id = ?',
      args: [dupId]
    });

    if (!canonicalLookup.rows.length && dupLookup.rows.length) {
      await db.execute({
        sql: 'UPDATE catalogue_lookups SET citation_id = ? WHERE citation_id = ?',
        args: [canId, dupId]
      });
    } else {
      await db.execute({
        sql: 'DELETE FROM catalogue_lookups WHERE citation_id = ?',
        args: [dupId]
      });
    }

    // 3. Remove the duplicate citation row
    await db.execute({
      sql: 'DELETE FROM citations WHERE id = ?',
      args: [dupId]
    });

    count++;
  }

  await db.execute('COMMIT');
  console.log(`\n✓ Transaction committed successfully!`);
  console.log(`✓ Merged ${count} duplicate citation rows.`);
} catch (err) {
  await db.execute('ROLLBACK');
  console.error('\n✕ Transaction failed and was rolled back:', err);
  process.exit(1);
}

// ─── 4. Summary ─────────────────────────────────────────────────────────────
const finalCount = (await db.execute('SELECT COUNT(*) as n FROM citations')).rows[0].n;
const finalLinks = (await db.execute('SELECT COUNT(*) as n FROM document_citations')).rows[0].n;
console.log(`\nFinal state: ${finalCount} citations, ${finalLinks} document-citation links.`);
