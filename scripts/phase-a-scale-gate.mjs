#!/usr/bin/env node
// Phase 3 (docs/phase-a-completion-plan.md) -- full-scale completion-gate
// measurement for issue #10: "per-document cost flat across a 5,000-document
// run." Drives ~5,000 synthetic documents through the real Phase A write
// path -- citation save/re-extraction (db.saveCitations /
// reextractDocumentCitations) and the enrichment drain / sync path
// (sync.runDocumentSync -> drainLocalEnrichmentQueue -> db.js's
// listDocumentsPendingEnrichment) -- and reports whether per-document cost
// (SQL statement count, wall-clock, heap) stays flat as the corpus grows.
//
// Unlike scripts/load-test-metadata-serving.mjs (4 discrete corpus sizes on
// the READ path), this samples EVERY document/batch on the WRITE path so a
// "spiky but average-flat" run can be told apart from a genuinely flat one,
// and it deliberately builds an adversarial "sparse pending tail" corpus for
// the enrichment segment (dense satisfied/noise rows ahead of each pending
// document), the shape most likely to expose non-flat cost through the
// `+d.sync_key` doc_id-ordered scan in listDocumentsPendingEnrichment.
//
// Run: node --expose-gc scripts/phase-a-scale-gate.mjs
// (works without --expose-gc too; heap sampling is just noisier without it)
//
// Tunables (env vars), all optional:
//   PHASE_A_GATE_DOCS            total synthetic documents per segment (default 5000)
//   PHASE_A_GATE_REFS_PER_DOC    citations per document (default 15 -- see
//                                README note below on why this is scaled
//                                down from the ~40 refs/doc order-of-magnitude
//                                the plan suggests)
//   PHASE_A_GATE_NOISE_PER_PENDING      other-sync-key filler rows per pending doc (default 3)
//   PHASE_A_GATE_SATISFIED_PER_PENDING  already-satisfied filler rows per pending doc (default 2)
//   PHASE_A_GATE_HEAP_SAMPLE_EVERY       docs between heap snapshots (default 100)

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const DOC_COUNT = Number(process.env.PHASE_A_GATE_DOCS || 5000);
const REFS_PER_DOC = Number(process.env.PHASE_A_GATE_REFS_PER_DOC || 15);
const NOISE_PER_PENDING = Number(process.env.PHASE_A_GATE_NOISE_PER_PENDING || 3);
const SATISFIED_PER_PENDING = Number(process.env.PHASE_A_GATE_SATISFIED_PER_PENDING || 2);
const HEAP_SAMPLE_EVERY = Number(process.env.PHASE_A_GATE_HEAP_SAMPLE_EVERY || 100);
// Falls back to relative deciles when DOC_COUNT is too small to fit the
// literal "docs 100-1000" / "docs 4000-5000" windows the plan names (e.g.
// when smoke-testing this script with a small PHASE_A_GATE_DOCS) so the
// verdict logic never divides by a zero-sample window.
const EARLY_WINDOW = DOC_COUNT >= 2000 ? [100, 1000] : [Math.floor(DOC_COUNT * 0.1), Math.floor(DOC_COUNT * 0.3)];
const LATE_WINDOW = DOC_COUNT >= 2000
  ? [Math.max(0, DOC_COUNT - 1000), DOC_COUNT]
  : [Math.floor(DOC_COUNT * 0.7), DOC_COUNT];
// Two different bounds for two different metrics, deliberately:
//
// SQL statement count is the PRIMARY gate. It counts real work items (see
// installStatementCounter above) issued against an in-process libsql/SQLite
// connection with no network, so run-to-run variance is near-zero -- the
// smoke run behind these constants showed a single-sample wobble of one
// statement (14 -> 15) across 300 documents/batches, nothing more. A tight
// factor is therefore both safe (won't flake on legitimate noise) and
// necessary (a loose factor is exactly the gap the independent review
// flagged: the previous 2x+slack bound would happily pass a 30-90% per-doc
// regression, since almost nothing short of an O(n) blowup doubles a
// statement count). 1.15x + a small absolute cushion (for tiny counts, e.g.
// enrichment's ~14 statements/batch, where +1 statement is a bigger relative
// jump than the same +1 would be against citations' ~56) is chosen to sit
// comfortably above the observed single-statement wobble while sitting
// comfortably below a 30% regression -- see docs/phase-a-gate-results.md for
// the injected-regression evidence this margin was checked against.
const FLAT_FACTOR_STATEMENTS = 1.15;
const FLAT_SLACK_STATEMENTS = 1; // absolute cushion on tiny statement counts

// Wall-clock is a SECONDARY, informational signal only, kept at the original
// loose 2x+slack bound. Wall-clock in this sandbox is subject to real
// run-to-run CPU/scheduler jitter unrelated to the harness or the code under
// test (observed directly during this hardening pass and by the independent
// reviewer) -- a single GC pause or noisy-neighbor scheduling tick can move
// a wall-clock sample by 2-5x with zero change in actual SQL work done.
// Gating hard on wall-clock at statement-count tightness would make this
// gate flake on sandbox noise instead of signaling a real regression, so
// wall-clock is not used for the running-max/p99 spike check either --
// only mean/p95 window comparison, same as before this hardening pass.
const FLAT_FACTOR_WALL = 2;
const FLAT_SLACK_MS = 5; // ...plus this much slack on tiny wall-clock values

if (!global.gc) {
  process.stderr.write(
    'WARNING: run with `node --expose-gc` for lower-noise heap measurements. Continuing without it.\n'
  );
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-phase-a-gate-'));
process.env.SKIP_LOCAL_ENV = '1';
process.env.NODE_ENV = 'test';
process.env.APP_DATA_DIR = tempDir;
process.env.SQLITE_PATH = path.join(tempDir, 'metrics.sqlite');
process.env.PDF_CACHE_DIR = path.join(tempDir, 'pdf-cache');
process.env.FULL_TEXT_CACHE_DIR = path.join(tempDir, 'full-text-cache');
delete process.env.TURSO_DATABASE_URL;

const db = await import('../src/db.js');
const { normalizeCitation } = await import('../src/pdf.js');
const { logger } = await import('../src/logger.js');
const { runDocumentSync, getSyncKeyForOptions } = await import('../src/sync.js');

// The fuzzy matcher logs one line per fuzzy hit -- at 5,000 docs that is
// tens of thousands of synchronous console writes, which would dominate the
// wall-clock measurement with I/O noise unrelated to the write path itself.
// Silencing here (not in src/) mirrors how a production batch importer would
// configure logging for a bulk job.
const originalLoggerInfo = logger.info;
const originalLoggerWarn = logger.warn;
logger.info = () => {};
logger.warn = () => {};

await db.ensureStorage();
const client = await db.getDb();

// ---------------------------------------------------------------------------
// Shared instrumentation
// ---------------------------------------------------------------------------

// Wraps BOTH client.execute and client.batch exactly once; per-operation cost
// is read as a delta against this running counter, so no per-document
// rebinding overhead pollutes the timings being measured.
//
// `count` is the SQL-STATEMENT-count metric (the primary flatness signal --
// see FLAT_FACTOR_STATEMENTS below): a single client.execute() is 1
// statement, but a single client.batch(array) call bundles `array.length`
// statements into one round trip, and counting it as "1" the way an earlier
// draft of this harness did is exactly the "blind to intra-call cost" gap
// Phase 2 already had to fix once (a batch could grow from 5 statements to
// 500 across the run and this counter would report no change at all).
// `roundTrips` is kept alongside as a secondary, informational count of
// actual client.execute/client.batch calls -- useful for eyeballing network
// round-trip volume -- but it is NOT what the pass/fail verdict gates on.
function installStatementCounter(target) {
  const originalExecute = target.execute.bind(target);
  const originalBatch = target.batch.bind(target);
  const state = { count: 0, roundTrips: 0 };
  target.execute = async (...args) => {
    state.count += 1;
    state.roundTrips += 1;
    return originalExecute(...args);
  };
  target.batch = async (...args) => {
    const statements = args[0];
    const n = Array.isArray(statements) ? statements.length : 1;
    state.count += n;
    state.roundTrips += 1;
    return originalBatch(...args);
  };
  state.restore = () => {
    target.execute = originalExecute;
    target.batch = originalBatch;
  };
  return state;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarizeWindow(samples, key) {
  const values = samples.map((s) => s[key]).sort((a, b) => a - b);
  if (!values.length) return { mean: 0, p50: 0, p95: 0, p99: 0, max: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    mean: Math.round(mean * 100) / 100,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values[values.length - 1],
    n: values.length,
  };
}

function windowSlice(samples, [lo, hi]) {
  return samples.filter((s) => s.i >= lo && s.i < hi);
}

// `full` (optional) is the summarizeWindow() stats over the ENTIRE run
// (every document/batch, not just the early/late windows). When supplied,
// the verdict also asserts that the full-run running max and p99 stay
// within the same early-baseline bound as the windowed mean/p95 -- so a
// spike confined to the untested middle of the run (neither in the early
// nor late window) still fails the gate, per the review's explicit ask to
// wire runningMax into `pass` instead of computing it and discarding it.
function flatVerdict(early, late, slack, factor, full) {
  const bound = early.mean * factor + slack;
  const meanFlat = late.mean <= bound;
  const p95Bound = early.p95 * factor + slack;
  const p95Flat = late.p95 <= p95Bound;
  const verdict = {
    pass: meanFlat && p95Flat,
    meanFlat,
    p95Flat,
    bound: Math.round(bound * 100) / 100,
    p95Bound: Math.round(p95Bound * 100) / 100,
  };
  if (full) {
    const runningMaxFlat = full.max <= bound;
    const p99Flat = full.p99 <= bound;
    verdict.runningMax = full.max;
    verdict.p99 = full.p99;
    verdict.runningMaxFlat = runningMaxFlat;
    verdict.p99Flat = p99Flat;
    verdict.pass = verdict.pass && runningMaxFlat && p99Flat;
  }
  return verdict;
}

function heapReport(samples, label) {
  if (!samples.length) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const mid = samples[Math.floor(samples.length / 2)];
  const peak = samples.reduce((m, s) => Math.max(m, s.heapUsed), 0);
  const toMB = (b) => Math.round((b / 1024 / 1024) * 10) / 10;
  const firstHalfGrowthMB = toMB(mid.heapUsed - first.heapUsed);
  const secondHalfGrowthMB = toMB(last.heapUsed - mid.heapUsed);
  return {
    label,
    startMB: toMB(first.heapUsed),
    endMB: toMB(last.heapUsed),
    peakMB: toMB(peak),
    totalGrowthMB: toMB(last.heapUsed - first.heapUsed),
    firstHalfGrowthMB,
    secondHalfGrowthMB,
    // "flat-ish": second half of the run doesn't grow heap dramatically more
    // than the first half. A pathological-bucket corpus that blows up memory
    // would show secondHalfGrowth >> firstHalfGrowth.
    // Heap, like wall-clock, is a memory-allocator/GC-driven signal rather
    // than a direct statement count, so it keeps the loose factor too.
    accelerating: secondHalfGrowthMB > Math.max(2, firstHalfGrowthMB * FLAT_FACTOR_WALL + 5),
    samples: samples.length,
  };
}

// ---------------------------------------------------------------------------
// Segment 1: citation save / re-extraction write path
// ---------------------------------------------------------------------------
//
// Corpus rationale: citations are matched via a (match_prefix, match_year)
// bucketed fuzzy search (db.js ~3203-3230); the bucket-narrowing design
// (Phase 1 / #11) assumes realistic bibliographic diversity in the first 3
// characters of citation text. A synthetic generator that accidentally gives
// every citation the same 3-char prefix (verified while building this
// harness -- an early draft using "Author<n>, ..." for every citation drove
// per-doc cost from ~30ms to ~64ms over 1,500 docs purely from prefix
// collapse) is exactly the pathological-concentration case #11's design
// notes already call out as the one scenario that defeats bucket narrowing.
// This generator instead spreads citations over ~17,576 distinct 3-letter
// surname prefixes (26^3), which at 5,000 docs x 15 refs/doc keeps any single
// (prefix, year) bucket far below FUZZY_CANDIDATE_LIMIT (2000) -- the
// realistic case the plan's flat-cost claim is actually about.

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
function surnameFor(n) {
  const a = LETTERS[n % 26];
  const b = LETTERS[Math.floor(n / 26) % 26];
  const c = LETTERS[Math.floor(n / 676) % 26];
  return `${a}${b}${c}`.toUpperCase() + 'ford';
}

const COMMON_POOL_SIZE = 300;
const commonCitationPool = Array.from({ length: COMMON_POOL_SIZE }, (_, i) => {
  const year = 1950 + (i % 70);
  return {
    text: `${surnameFor(i)}, C. (${year}). Common seminal work number ${i}. City: University Press.`,
    year: String(year),
  };
});

let uniqueCitationCounter = 0;
function citationsFor(docIndex, refsPerDoc) {
  const out = [];
  for (let r = 0; r < refsPerDoc; r += 1) {
    // ~20% of references are drawn from a shared pool (a work cited by many
    // dissertations) -> exact-hash match, no fuzzy scan needed.
    // ~80% are brand-new, distinct-prefix citations -> miss the hash lookup
    // and exercise the real fuzzy-match SQL query, which is the cost this
    // segment is measuring.
    const roll = (docIndex * 97 + r * 31) % 10;
    if (roll < 2) {
      out.push(commonCitationPool[(docIndex + r) % COMMON_POOL_SIZE]);
    } else {
      const n = uniqueCitationCounter++;
      const year = 1955 + (n % 68);
      out.push({
        text: `${surnameFor(n)}, X. (${year}). Unique synthetic dissertation reference number ${n}. City: Press.`,
        year: String(year),
      });
    }
  }
  return out;
}

async function runCitationSegment() {
  const counter = installStatementCounter(client);
  const perDoc = [];
  const heapSamples = [];
  global.gc?.();
  heapSamples.push({ i: 0, heapUsed: process.memoryUsage().heapUsed });

  const segmentStart = performance.now();
  for (let i = 0; i < DOC_COUNT; i += 1) {
    const docId = `gate-cite-${String(i).padStart(6, '0')}`;
    const citations = citationsFor(i, REFS_PER_DOC);
    const before = counter.count;
    const t0 = performance.now();
    // The real write path: reextractDocumentCitations wraps saveCitations and
    // is what src/pdf.js's real import path calls (pdf.js:2134), using the
    // production normalizeCitation hash (not a test stub), matching the
    // Phase 1 plan's warning about hashFn choice silently short-circuiting
    // the fuzzy matcher.
    // eslint-disable-next-line no-await-in-loop
    await db.reextractDocumentCitations(docId, citations, normalizeCitation);
    const wallMs = performance.now() - t0;
    const statements = counter.count - before;
    perDoc.push({ i, statements, wallMs });

    if ((i + 1) % HEAP_SAMPLE_EVERY === 0 || i === DOC_COUNT - 1) {
      global.gc?.();
      heapSamples.push({ i: i + 1, heapUsed: process.memoryUsage().heapUsed });
    }
    if ((i + 1) % 500 === 0) {
      process.stderr.write(`  [citations] ${i + 1}/${DOC_COUNT} docs (${((performance.now() - segmentStart) / 1000).toFixed(1)}s elapsed)\n`);
    }
  }
  counter.restore();

  return { perDoc, heapSamples, totalMs: performance.now() - segmentStart };
}

// ---------------------------------------------------------------------------
// Segment 2: enrichment drain / sync path, sparse-pending-tail corpus
// ---------------------------------------------------------------------------
//
// Corpus rationale: listDocumentsPendingEnrichment deliberately writes
// `+d.sync_key = ?` (db.js ~2212-2228) so the planner cannot use
// idx_documents_sync_key and is forced onto the doc_id primary key instead --
// a cursor-seeked range scan. That is provably O(pageLimit) per page ONLY
// while the intervening rows between cursor and next match stay bounded; a
// corpus where a rule's own pending documents are a sparse minority behind a
// dense wall of already-satisfied and other-rules'-noise documents (exactly
// the shape a production corpus has after its first sync pass) is the
// adversarial case named in the plan. This corpus interleaves
// NOISE_PER_PENDING other-sync-key rows and SATISFIED_PER_PENDING
// already-enriched own-sync-key rows ahead of every single pending document,
// for the full 5,000-document run (not just a short probe), then drains one
// pending document per batch so every one of the 5,000 gets its own
// statement-count / wall-clock / heap sample.

async function buildEnrichmentCorpus(ourSyncKey, noiseSyncKey) {
  const items = [];
  const pendingIds = [];
  const satisfiedIds = [];
  let counter = 0;
  const nextId = () => `gate-enrich-${String(counter++).padStart(8, '0')}`;

  for (let p = 0; p < DOC_COUNT; p += 1) {
    for (let n = 0; n < NOISE_PER_PENDING; n += 1) {
      items.push({ doc: { id: nextId() }, syncKey: noiseSyncKey, source: null });
    }
    for (let s = 0; s < SATISFIED_PER_PENDING; s += 1) {
      const id = nextId();
      items.push({ doc: { id }, syncKey: ourSyncKey, source: null });
      satisfiedIds.push(id);
    }
    const pendingId = nextId();
    items.push({ doc: { id: pendingId }, syncKey: ourSyncKey, source: null });
    pendingIds.push(pendingId);
  }

  const CHUNK = 1000;
  for (let i = 0; i < items.length; i += CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    await db.saveDocumentMetadataBatch(items.slice(i, i + CHUNK));
  }
  for (const id of satisfiedIds) {
    // eslint-disable-next-line no-await-in-loop
    await db.saveFileMetric(id, {
      status: 'full_text', wordSource: 'dspace_full_text', wordCount: 500, pageCount: 5,
    });
  }
  return { pendingIds, totalRows: items.length };
}

const PENDING_ENRICHMENT_QUERY_RE = /FROM\s+documents\s+d\b[\s\S]*ORDER BY d\.doc_id/;

async function runEnrichmentSegment() {
  const ourOptions = {
    baseUrl: 'https://oc-index.test',
    requestedIndex: '',
    query: '',
    term: 'phase-a-scale-gate-rule',
    source: 'id,title,author',
  };
  const ourSyncKey = getSyncKeyForOptions(ourOptions);
  const noiseSyncKey = 'phase-a-scale-gate-noise';

  process.stderr.write(`  [enrichment] seeding sparse-pending-tail corpus (${DOC_COUNT} pending + filler)...\n`);
  const seedStart = performance.now();
  const { pendingIds, totalRows } = await buildEnrichmentCorpus(ourSyncKey, noiseSyncKey);
  process.stderr.write(`  [enrichment] seeded ${totalRows} total rows (${pendingIds.length} pending) in ${((performance.now() - seedStart) / 1000).toFixed(1)}s\n`);

  const counter = installStatementCounter(client);
  const perDoc = [];
  const heapSamples = [];
  global.gc?.();
  heapSamples.push({ i: 0, heapUsed: process.memoryUsage().heapUsed });

  let enrichmentAttemptedBefore;
  let enrichmentCursor = '';
  let capturedPlans = [];

  const explainWrap = (i) => {
    // Captures the pre-wrap execute so the EXPLAIN QUERY PLAN call issued
    // here goes straight through, instead of back into this same wrapper
    // (which would otherwise match its own "FROM documents d ... ORDER BY
    // d.doc_id" text inside the EXPLAIN statement and recurse forever).
    const passthroughExecute = client.execute.bind(client);
    client.execute = async (arg) => {
      const sql = typeof arg === 'string' ? arg : arg.sql;
      if (PENDING_ENRICHMENT_QUERY_RE.test(sql)) {
        const args = typeof arg === 'string' ? [] : (arg.args || []);
        const plan = await passthroughExecute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args });
        capturedPlans.push({ i, sql, details: plan.rows.map((row) => String(row.detail)) });
      }
      return passthroughExecute(arg);
    };
    return () => { client.execute = passthroughExecute; };
  };

  const segmentStart = performance.now();
  for (let i = 0; i < pendingIds.length; i += 1) {
    // Capture EXPLAIN QUERY PLAN for the very first and very last batch only
    // (statement count alone can't distinguish an indexed seek from a table
    // scan that happens to still be "one statement" -- the exact blind spot
    // #19/#29's review called out).
    const captureExplain = i === 0 || i === pendingIds.length - 1;
    const unwrapExplain = captureExplain ? await explainWrap(i) : null;

    const before = counter.count;
    const t0 = performance.now();
    // eslint-disable-next-line no-await-in-loop
    const result = await runDocumentSync({
      mode: 'sync_missing_pdfs',
      baseUrl: 'https://oc-index.test',
      term: 'phase-a-scale-gate-rule',
      source: 'id,title,author',
      pageSize: 1000,
      scanLimit: 100_000,
      syncMaxRecords: 100_000,
      downloadFiles: true,
      contentMode: 'full_text_only',
      pdfBatchSize: 1,
      enrichmentAttemptedBefore: enrichmentAttemptedBefore || undefined,
      enrichmentCursor,
    });
    const wallMs = performance.now() - t0;
    const statements = counter.count - before;
    unwrapExplain?.();

    enrichmentAttemptedBefore = result.enrichmentAttemptedBefore;
    enrichmentCursor = result.enrichmentCursor;
    perDoc.push({ i, statements, wallMs, attempted: result.totalEnrichmentAttempted });

    if ((i + 1) % HEAP_SAMPLE_EVERY === 0 || i === pendingIds.length - 1) {
      global.gc?.();
      heapSamples.push({ i: i + 1, heapUsed: process.memoryUsage().heapUsed });
    }
    if ((i + 1) % 500 === 0) {
      process.stderr.write(`  [enrichment] ${i + 1}/${pendingIds.length} pending docs drained (${((performance.now() - segmentStart) / 1000).toFixed(1)}s elapsed)\n`);
    }
  }
  counter.restore();

  const badFallback = capturedPlans.filter(({ details }) => (
    details.some((d) => d.includes('idx_documents_sync_key'))
    || details.some((d) => /TEMP B-TREE/.test(d))
  ));

  return {
    perDoc,
    heapSamples,
    totalMs: performance.now() - segmentStart,
    totalRows,
    pendingCount: pendingIds.length,
    capturedPlans,
    badFallback,
  };
}

// ---------------------------------------------------------------------------
// Run both segments, build the report
// ---------------------------------------------------------------------------

let exitCode = 0;
try {
  process.stderr.write(`Phase A scale gate: ${DOC_COUNT} docs, ${REFS_PER_DOC} refs/doc (citations); ${DOC_COUNT} pending docs with ${NOISE_PER_PENDING} noise + ${SATISFIED_PER_PENDING} satisfied filler each (enrichment).\n`);

  const citations = await runCitationSegment();
  const enrichment = await runEnrichmentSegment();

  const report = { config: {
    docCount: DOC_COUNT,
    refsPerDoc: REFS_PER_DOC,
    noisePerPending: NOISE_PER_PENDING,
    satisfiedPerPending: SATISFIED_PER_PENDING,
    earlyWindow: EARLY_WINDOW,
    lateWindow: LATE_WINDOW,
    flatFactorStatements: FLAT_FACTOR_STATEMENTS,
    flatFactorWall: FLAT_FACTOR_WALL,
    exposedGc: Boolean(global.gc),
  }, segments: {} };

  for (const [name, seg] of [['citations', citations], ['enrichment', enrichment]]) {
    const early = windowSlice(seg.perDoc, EARLY_WINDOW);
    const late = windowSlice(seg.perDoc, LATE_WINDOW);
    const statementsEarly = summarizeWindow(early, 'statements');
    const statementsLate = summarizeWindow(late, 'statements');
    const statementsFull = summarizeWindow(seg.perDoc, 'statements');
    const wallEarly = summarizeWindow(early, 'wallMs');
    const wallLate = summarizeWindow(late, 'wallMs');
    // Statement count: PRIMARY gate, tight factor, and also checked against
    // the full-run running max / p99 (not just the early/late windows) so a
    // spike in the untested middle of the run fails the gate too.
    const statementsVerdict = flatVerdict(statementsEarly, statementsLate, FLAT_SLACK_STATEMENTS, FLAT_FACTOR_STATEMENTS, statementsFull);
    // Wall-clock: SECONDARY signal, loose factor, windowed mean/p95 only --
    // see the FLAT_FACTOR_WALL comment above for why it is not used to gate
    // on running max/p99 the way statement count is.
    const wallVerdict = flatVerdict(wallEarly, wallLate, FLAT_SLACK_MS, FLAT_FACTOR_WALL);
    const runningMaxWallMs = Math.round(Math.max(...seg.perDoc.map((s) => s.wallMs)) * 100) / 100;
    const heap = heapReport(seg.heapSamples, name);

    report.segments[name] = {
      totalDocsOrBatches: seg.perDoc.length,
      totalSegmentSeconds: Math.round((seg.totalMs / 1000) * 10) / 10,
      statements: { early: statementsEarly, late: statementsLate, full: statementsFull, verdict: statementsVerdict },
      wallMs: { early: wallEarly, late: wallLate, runningMax: runningMaxWallMs, verdict: wallVerdict },
      heap,
      pass: statementsVerdict.pass && wallVerdict.pass && heap && !heap.accelerating,
    };
    if (name === 'enrichment') {
      report.segments[name].totalRows = seg.totalRows;
      report.segments[name].pendingCount = seg.pendingCount;
      report.segments[name].explainPlans = seg.capturedPlans.map(({ i, details }) => ({ i, details }));
      report.segments[name].badPlanFallbacks = seg.badFallback.length;
      report.segments[name].pass = report.segments[name].pass && seg.badFallback.length === 0;
    }
  }

  report.overallPass = Object.values(report.segments).every((s) => s.pass);

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.overallPass) exitCode = 1;
} catch (error) {
  process.stderr.write(`Phase A scale gate FAILED to complete: ${error?.stack || error}\n`);
  exitCode = 1;
} finally {
  logger.info = originalLoggerInfo;
  logger.warn = originalLoggerWarn;
  await db.closeDb();
  await fs.rm(tempDir, { recursive: true, force: true });
}
process.exitCode = exitCode;
