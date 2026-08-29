// Phase 1 / #11 (1b): the fuzzy-candidate cap and the refuse-on-saturation path.
//
// FUZZY_CANDIDATE_LIMIT is a hardcoded 2000 in production. To force saturation
// without materialising 2000 rows, db.js reads
// `Number(process.env.CITATION_FUZZY_CANDIDATE_LIMIT) || 2000` at module load
// (mirroring the CONCEPT_MAX_BUCKET_COMPARISONS precedent). This file pins the
// override to 5 BEFORE importing db.js, so a bucket saturates at 6 rows, and
// exercises the three cases the design turns on:
//   (i)   saturated bucket whose truncated read still clears the threshold ->
//         refuse() fires, both truncatedBuckets and truncationBlockedMerges
//         increment, and no merge (and no *wrong* merge) is made.
//   (ii)  saturated bucket whose truncated read does NOT clear the threshold ->
//         the maxSim < threshold guard returns null *before* the saturation
//         check, so refuse() is not called and truncationBlockedMerges does not
//         increment, yet truncatedBuckets still increments. Net effect is still
//         safe (no merge). This pins the plan's safety claim in code.
//   (iii) a non-saturated corpus leaves both counters at 0.
//
// Consequence pinned by (i) vs (ii): truncationBlockedMerges UNDERCOUNTS
// truncation-influenced misses; truncatedBuckets (which fires unconditionally on
// saturation) is the complete operational signal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Must be set before src/db.js is imported (below), since the cap is read once at
// module load.
process.env.CITATION_FUZZY_CANDIDATE_LIMIT = '5';

let tempDir;
let db;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-cite-sat-'));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  delete process.env.TURSO_DATABASE_URL;
  db = await import('../src/db.js');
  await db.ensureStorage();
});

test.after(async () => {
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

// Distinct text -> distinct hash, so seeding never collapses rows via the
// exact-hash short-circuit; the six rows survive as six only if they also stay
// below the fuzzy threshold of one another, which the fixtures below ensure.
const uniqueHash = (text) => `sat|${text}`;

const totalCitations = async () => Number((await db.getCitationStats()).total_citations);

// Runs one probe through saveCitations and returns the final counts (surfaced via
// onProgress) plus the branch-reach events (via matchObserver).
async function probe(docId, item) {
  let counts = null;
  const events = [];
  await db.saveCitations(docId, [item], uniqueHash, {
    onProgress: (update) => { counts = update.counts; },
    matchObserver: (event) => events.push(event),
  });
  return { counts, events };
}

// Six mutually dissimilar rows that all share a 3-char prefix and a year, so they
// land in one (prefix, year) bucket without merging into each other.
function bucketRows(prefix, year, tag) {
  return [
    `${prefix} Wetland dynamics of the northern reach studied here (${year}). ${tag} One Press.`,
    `${prefix} Bedrock geology of the southern massif surveyed (${year}). ${tag} Two Press.`,
    `${prefix} Coastal erosion patterns across the wide delta (${year}). ${tag} Three Press.`,
    `${prefix} Dialectology of the remote mountain villages (${year}). ${tag} Four Press.`,
    `${prefix} Enzyme kinetics observed under thermal stress (${year}). ${tag} Five Press.`,
    `${prefix} Freshwater mollusc distributions in alpine lakes (${year}). ${tag} Six Press.`,
  ];
}

test('(i) a saturated bucket whose truncated read clears the threshold refuses the merge', async () => {
  // The near-duplicate of the probe is seeded first so it holds the lowest id and
  // is inside the truncated (first-5-by-id) read, i.e. the truncated read *does*
  // clear the threshold.
  const nearDup = 'aaa Reference to the canonical saturated bucket work (2015). Aardvark Press.';
  const probeText = 'aaa Reference to the canonical saturated bucket work (2015). Aardvark Press';
  const fillers = bucketRows('aaa', '2015', 'sat-i').slice(0, 5);

  const before = await totalCitations();
  await db.saveCitations('sat-i-nd', [{ text: nearDup, year: '2015' }], uniqueHash);
  for (let i = 0; i < fillers.length; i += 1) {
    await db.saveCitations(`sat-i-f${i}`, [{ text: fillers[i], year: '2015' }], uniqueHash);
  }
  assert.equal(await totalCitations(), before + 6, 'the six bucket rows did not stay six distinct rows');

  const beforeProbe = await totalCitations();
  const { counts } = await probe('sat-i-probe', { text: probeText, year: '2015' });

  assert.equal(counts.truncatedBuckets, 1, '(i) saturation should be reported');
  assert.equal(counts.truncationBlockedMerges, 1, '(i) a merge should have been refused');
  assert.equal(counts.fuzzyMatches, 0, '(i) the refused merge must not count as a fuzzy match');
  assert.equal(counts.newCitations, 1, '(i) the probe must land as a new citation, not merge');
  // The refused merge is a lost merge, never a wrong one: exactly one new row.
  assert.equal(await totalCitations(), beforeProbe + 1, '(i) refuse produced the wrong number of rows');
});

test('(ii) a saturated bucket whose truncated read misses the threshold does not call refuse', async () => {
  // No row in the bucket is within the threshold of the probe, so the maxSim
  // guard returns null before the saturation check is reached.
  const rows = bucketRows('bbb', '2016', 'sat-ii');
  const before = await totalCitations();
  for (let i = 0; i < rows.length; i += 1) {
    await db.saveCitations(`sat-ii-f${i}`, [{ text: rows[i], year: '2016' }], uniqueHash);
  }
  assert.equal(await totalCitations(), before + 6, 'the six bucket rows did not stay six distinct rows');

  const probeText = 'bbb Completely unrelated microbial genome assembly notes (2016). Nowhere Press.';
  const beforeProbe = await totalCitations();
  const { counts } = await probe('sat-ii-probe', { text: probeText, year: '2016' });

  // truncatedBuckets fires unconditionally on saturation...
  assert.equal(counts.truncatedBuckets, 1, '(ii) saturation should still be reported');
  // ...but refuse() is never reached, so truncationBlockedMerges stays 0 even
  // though an unread row past the cap could in principle have cleared threshold.
  assert.equal(counts.truncationBlockedMerges, 0, '(ii) refuse must not fire when the arm is below threshold');
  assert.equal(counts.newCitations, 1, '(ii) the probe still lands as a new citation');
  assert.equal(await totalCitations(), beforeProbe + 1, '(ii) net effect must still be a single new row');
});

test('(iii) a non-saturated corpus leaves both saturation counters at 0', async () => {
  const seed = 'ccc Glacial retreat chronology of the eastern range (2017). Alpha Press.';
  const probeText = 'ccc Glacial retreat chronology of the eastern range (2017). Alpha Press';
  await db.saveCitations('sat-iii-seed', [{ text: seed, year: '2017' }], uniqueHash);

  const beforeProbe = await totalCitations();
  const { counts, events } = await probe('sat-iii-probe', { text: probeText, year: '2017' });

  assert.equal(counts.truncatedBuckets, 0, '(iii) an unsaturated bucket must not report truncation');
  assert.equal(counts.truncationBlockedMerges, 0, '(iii) nothing should be refused');
  // Sanity: this corpus really did run the fuzzy path and merge, so the zeros
  // above are meaningful rather than a case that never reached the matcher.
  assert.equal(counts.fuzzyMatches, 1, '(iii) the probe should have fuzzy-merged');
  assert.equal(await totalCitations(), beforeProbe, '(iii) the probe merged, so no new row');
  assert.ok(events.includes('phase2:adjacent'), '(iii) the probe should have reached phase 2');
});
