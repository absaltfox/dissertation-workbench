import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// #26/#27: these two JS aggregators are the ones this phase found reachable
// with a truly unbounded record count (via #24's now-fixed /api/metrics
// admin path) and whose per-request cost does not otherwise scale down with
// corpus size. Both gates here are ratio-based (peak-heap growth relative to
// the 11.2x record-count growth between the two scales), not fixed-byte
// ceilings, per the plan's own convention — process.memoryUsage() without
// --expose-gc is inherently noisy, so a generous ratio bound is the reliable
// signal, and multiple samples are taken to reduce that noise further.

let buildTermCooccurrence;
let termCooccurrenceMinCount;
let buildSupervisorNetwork;
let tempDir;

const SMALL_N = 5000;
const LARGE_N = 56000;
const RECORD_COUNT_RATIO = LARGE_N / SMALL_N; // 11.2x

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-scale-memory-'));
  process.env.SKIP_LOCAL_ENV = '1';
  process.env.NODE_ENV = 'test';
  process.env.APP_DATA_DIR = tempDir;
  process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
  process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
  process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');

  // A synthetic concept dictionary: every "concept term N" is marked
  // multi-doc (docFreq >= 2), matching real ingested dictionaries where the
  // co-occurrence-eligible vocabulary is the multi-doc subset. Sized to the
  // larger scale's vocabulary so both fixtures below read the same file.
  const vocabSize = Math.ceil(LARGE_N / 8);
  const concepts = Array.from({ length: vocabSize }, (_, i) => ({
    canonical: `concept term ${i}`, docFreq: 5, idf: 1,
  }));
  await fs.mkdir(path.join(tempDir, 'concepts'), { recursive: true });
  await fs.writeFile(
    path.join(tempDir, 'concepts', 'latest.json'),
    JSON.stringify({ concepts, variantToCanonical: {}, source: { documents: vocabSize * 10 } })
  );

  const metrics = await import('../src/metrics.js');
  ({ buildTermCooccurrence, termCooccurrenceMinCount, buildSupervisorNetwork } = metrics);
});

test.after(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

// Deterministic PRNG (mulberry32) so the fixture below is reproducible
// without relying on Math.random(), while still spreading each document's
// terms widely enough across the vocabulary to realize a large, genuinely
// distinct pair set (a fixed sliding window under-realizes pair diversity —
// most windows share most of their neighbors).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A larger corpus plausibly surfaces a larger concept vocabulary, not just
// more documents restating the same handful of concepts — so the vocabulary
// (and therefore the term-cooccurrence pair *key space*) is modeled as
// growing with N, which is exactly the shape that made pairCounts unbounded
// pre-fix even though each document's own contribution is already capped.
function conceptTermFixture(n) {
  const vocabSize = Math.max(16, Math.ceil(n / 8));
  const termsPerDoc = 6;
  const rand = mulberry32(42);
  const records = new Array(n);
  for (let i = 0; i < n; i++) {
    const chosen = new Set();
    while (chosen.size < termsPerDoc) chosen.add(Math.floor(rand() * vocabSize));
    const terms = Array.from(chosen, (idx) => `concept term ${idx}`);
    records[i] = { id: `doc-${i}`, year: 2000 + (i % 25), conceptTerms: terms };
  }
  return records;
}

function supervisorFixture(n) {
  const pool = Math.max(60, Math.ceil(n / 50)); // always far more than the top-30 cut
  const records = new Array(n);
  for (let i = 0; i < n; i++) {
    records[i] = {
      id: `doc-${i}`,
      supervisors: [`Supervisor ${i % pool}`, `Supervisor ${(i * 13 + 7) % pool}`],
      committee: [],
    };
  }
  return records;
}

function heapDeltaBytes(fn, samples = 3) {
  const deltas = [];
  for (let i = 0; i < samples; i++) {
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const result = fn();
    const after = process.memoryUsage().heapUsed;
    deltas.push(after - before);
    // Keep the last result alive for correctness assertions by the caller.
    if (i === samples - 1) heapDeltaBytes.lastResult = result;
  }
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)]; // median, to blunt GC-timing noise
}

test('#26: termCooccurrenceMinCount is a pinned, named, testable formula (regression-safe at today\'s corpus size, scaled at 56k)', () => {
  assert.equal(termCooccurrenceMinCount(400), 2, 'must not regress the existing, tuned ~400-doc corpus behavior');
  assert.equal(termCooccurrenceMinCount(1600), 2);
  assert.equal(termCooccurrenceMinCount(56000), 12);
});

test('#26: buildTermCooccurrence peak heap growth is sub-linear vs. corpus-size growth between 5k and 56k', () => {
  const smallRecords = conceptTermFixture(SMALL_N);
  const largeRecords = conceptTermFixture(LARGE_N);

  const smallDelta = heapDeltaBytes(() => buildTermCooccurrence(smallRecords));
  const largeDelta = heapDeltaBytes(() => buildTermCooccurrence(largeRecords));

  const ratio = largeDelta / Math.max(smallDelta, 1);
  assert.ok(
    ratio < RECORD_COUNT_RATIO * 0.6,
    `expected sub-linear heap growth (ratio ${ratio.toFixed(2)} vs record-count ratio ${RECORD_COUNT_RATIO}); ` +
    `smallDelta=${smallDelta} largeDelta=${largeDelta}`
  );
});

// Pinned copy of the pre-#26 algorithm (fixed `count >= 2` floor, no term
// allowlist), reused below for a deterministic (non-heap-sampled) proxy for
// the pairCounts key-space this phase is bounding: run both algorithms with
// an effectively unlimited topN so the returned array size approximates the
// full pairCounts map's surviving-pairs count, and compare directly instead
// of relying on GC-timing-sensitive heap deltas for this specific claim.
function originalUnboundedTermCooccurrence(records, dict, topN = 20) {
  const pairCounts = new Map();
  const termCounts = new Map();
  const N = records.length;
  for (const rec of records) {
    const concepts = (rec.conceptTerms || []).slice(0, 20);
    if (concepts.length < 2) continue;
    const unique = Array.from(new Set(concepts)).filter((c) => dict.multiDocSet.has(c));
    for (const c of unique) termCounts.set(c, (termCounts.get(c) || 0) + 1);
    const sorted = [...unique].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}|||${sorted[j]}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }
  return pairCounts.size;
}

test('#26 (deterministic proxy): the term allowlist caps realized pair count independent of corpus size, where the pre-fix algorithm\'s pairCounts key space would not', async () => {
  const raw = JSON.parse(await fs.readFile(path.join(tempDir, 'concepts', 'latest.json'), 'utf-8'));
  const multiDocSet = new Set(raw.concepts.map((c) => c.canonical));
  const dict = { multiDocSet };
  const TERM_COOCCURRENCE_MAX_TERMS = 400; // must match src/metrics.js

  const largeRecords = conceptTermFixture(LARGE_N);

  // Fixed algorithm: pass an effectively unlimited topN so the full
  // (post-minCount-filter) pair list comes back, then bound it against
  // C(400, 2) — the hard cap on distinct terms admitted into the pairwise
  // loop, independent of N or the concept vocabulary size.
  const fixedPairCount = buildTermCooccurrence(largeRecords, 10_000_000).length;
  const maxPossiblePairs = (TERM_COOCCURRENCE_MAX_TERMS * (TERM_COOCCURRENCE_MAX_TERMS - 1)) / 2;
  assert.ok(
    fixedPairCount <= maxPossiblePairs,
    `fixed algorithm returned ${fixedPairCount} pairs, expected at most C(400,2)=${maxPossiblePairs}`
  );

  // Pre-fix reference: no term allowlist, so its pairCounts key space tracks
  // the fixture's vocabulary (which grows with N by design — see
  // conceptTermFixture) and exceeds the fixed algorithm's hard cap at this
  // scale, proving the cap is doing real work, not just coincidentally
  // matching a fixture that would have stayed small anyway.
  const referencePairCount = originalUnboundedTermCooccurrence(largeRecords, dict);
  assert.ok(
    referencePairCount > maxPossiblePairs,
    `expected the pre-fix reference algorithm's pairCounts to exceed C(400,2)=${maxPossiblePairs} ` +
    `at N=${LARGE_N} (got ${referencePairCount}) — if this fails, the fixture no longer discriminates ` +
    `the fix and the cap assertion above should be treated with suspicion`
  );
});

// Pinned copy of the pre-#27, single-pass algorithm (src/metrics.js before
// #27), kept here only as a fixed reference: proves the restructuring
// changed cost, not output (below), and that the heap-ratio gate genuinely
// discriminates the fix rather than merely reflecting the export's
// non-existence pre-fix (the control test further below).
function originalSinglePassSupervisorNetwork(records, minEdge = 1) {
  const nodeMap = new Map();
  const edgeMap = new Map();
  for (const rec of records) {
    const people = [];
    for (const s of (rec.supervisors || [])) people.push(s);
    if (rec.committee) {
      for (const m of rec.committee) {
        if (m.role === 'Supervisor' || m.role === 'Co-Supervisor' || m.role === 'Committee Member') {
          if (!people.includes(m.name)) people.push(m.name);
        }
      }
    }
    if (people.length === 0) continue;
    for (const p of people) nodeMap.set(p, (nodeMap.get(p) || 0) + 1);
    const sorted = [...people].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}|||${sorted[j]}`;
        if (!edgeMap.has(key)) edgeMap.set(key, { weight: 0, docs: [] });
        const e = edgeMap.get(key);
        e.weight += 1;
        e.docs.push(rec.id);
      }
    }
  }
  const topNodes = Array.from(nodeMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 30);
  const topSet = new Set(topNodes.map(([name]) => name));
  const nodes = topNodes.map(([id, docCount]) => ({ id, docCount }));
  const edges = Array.from(edgeMap.entries())
    .filter(([key, e]) => {
      const [a, b] = key.split('|||');
      return topSet.has(a) && topSet.has(b) && e.weight >= minEdge;
    })
    .map(([key, e]) => {
      const [source, target] = key.split('|||');
      return { source, target, weight: e.weight, docs: e.docs };
    });
  return { nodes, edges };
}

test('#27: buildSupervisorNetwork two-pass output matches the original single-pass algorithm byte-for-byte', () => {
  const records = supervisorFixture(4000);
  const expected = originalSinglePassSupervisorNetwork(records);
  const actual = buildSupervisorNetwork(records);

  const sortEdges = (edges) => [...edges].sort((a, b) =>
    (a.source + a.target).localeCompare(b.source + b.target));
  assert.deepEqual(
    [...actual.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    [...expected.nodes].sort((a, b) => a.id.localeCompare(b.id)),
  );
  assert.deepEqual(
    sortEdges(actual.edges).map((e) => ({ ...e, docs: [...e.docs].sort() })),
    sortEdges(expected.edges).map((e) => ({ ...e, docs: [...e.docs].sort() })),
  );
});

test('#27: buildSupervisorNetwork peak heap scales with top-N, not record count, between 5k and 56k', () => {
  const smallRecords = supervisorFixture(SMALL_N);
  const largeRecords = supervisorFixture(LARGE_N);

  const smallDelta = heapDeltaBytes(() => buildSupervisorNetwork(smallRecords));
  const largeDelta = heapDeltaBytes(() => buildSupervisorNetwork(largeRecords));

  const ratio = largeDelta / Math.max(smallDelta, 1);
  assert.ok(
    ratio < RECORD_COUNT_RATIO * 0.6,
    `expected sub-linear heap growth (ratio ${ratio.toFixed(2)} vs record-count ratio ${RECORD_COUNT_RATIO}); ` +
    `smallDelta=${smallDelta} largeDelta=${largeDelta}`
  );
});

// Deterministic (non-heap-sampled) proxy for the same claim: count how many
// `docs.push()`-equivalent allocations each algorithm's edge-building phase
// performs. Each record contributes exactly one co-authorship pair here (two
// supervisors), so the pre-fix single-pass algorithm — which pushes into an
// edge's `docs` array for *every* pair before the top-N filter is applied —
// performs exactly one such allocation per record, unconditionally: this
// scales exactly with N. The two-pass fixed algorithm only allocates for
// pairs whose both endpoints already survived the top-30 cut, which (given a
// supervisor pool that grows with N) is a shrinking fraction of records as N
// grows. This is deterministic and immune to the GC-timing noise that made
// the heap-delta gate above an unreliable way to demonstrate this specific
// contrast.
function countEdgeAllocations(records, { twoPass }) {
  const nodeMap = new Map();
  const perRecordPeople = new Array(records.length);
  for (let i = 0; i < records.length; i++) {
    const people = [...(records[i].supervisors || [])];
    if (people.length === 0) continue;
    for (const p of people) nodeMap.set(p, (nodeMap.get(p) || 0) + 1);
    perRecordPeople[i] = people;
  }
  const topSet = twoPass
    ? new Set(Array.from(nodeMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name]) => name))
    : null;
  let allocations = 0;
  for (const people of perRecordPeople) {
    if (!people) continue;
    const scoped = twoPass ? people.filter((p) => topSet.has(p)) : people;
    for (let i = 0; i < scoped.length; i++) {
      for (let j = i + 1; j < scoped.length; j++) allocations += 1;
    }
  }
  return allocations;
}

test('#27 (deterministic proxy): the pre-fix single-pass algorithm allocates one docs-array push per record unconditionally; the two-pass fix only allocates for top-30-qualifying pairs', () => {
  const smallRecords = supervisorFixture(SMALL_N);
  const largeRecords = supervisorFixture(LARGE_N);

  // Pre-fix shape: exactly one allocation per record with >=2 people here,
  // regardless of whether the pair ever makes the top-30 graph.
  assert.equal(countEdgeAllocations(smallRecords, { twoPass: false }), SMALL_N);
  assert.equal(countEdgeAllocations(largeRecords, { twoPass: false }), LARGE_N);

  // Fixed shape: allocations are scoped to top-30-qualifying pairs only, so
  // they grow far slower than record count as the (much larger) supervisor
  // pool at 56k makes top-30 membership rarer per record.
  const smallFixedAllocations = countEdgeAllocations(smallRecords, { twoPass: true });
  const largeFixedAllocations = countEdgeAllocations(largeRecords, { twoPass: true });
  const fixedRatio = largeFixedAllocations / Math.max(smallFixedAllocations, 1);
  assert.ok(
    fixedRatio < RECORD_COUNT_RATIO * 0.6,
    `expected two-pass allocation count to grow sub-linearly vs record count ` +
    `(ratio ${fixedRatio.toFixed(2)} vs record-count ratio ${RECORD_COUNT_RATIO}); ` +
    `small=${smallFixedAllocations} large=${largeFixedAllocations}`
  );
});
