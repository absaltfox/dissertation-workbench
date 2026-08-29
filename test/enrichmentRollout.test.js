import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEnrichmentRun } from '../src/services/enrichmentRollout.js';

function outcome(docId, overrides = {}) {
  return {
    docId,
    contentSource: 'extracted_full_text',
    wordSource: 'dspace_full_text',
    wordCount: 10_000,
    pageCount: 40,
    error: null,
    ...overrides,
  };
}

test('full-text sample passes only with derivative evidence and no original PDF requests', () => {
  const outcomes = Array.from({ length: 100 }, (_, index) => outcome(`sample-${index}`));
  const passing = evaluateEnrichmentRun({
    phase: 'sample',
    targetSize: 100,
    outcomes,
    requestCounts: { fullText: 100, originalPdf: 0, retrievedBytes: 1_000_000 },
    durationMs: 60_000,
  });
  assert.equal(passing.passed, true);
  assert.equal(passing.checks.derivativeOnly, true);

  const protectedFailure = evaluateEnrichmentRun({
    phase: 'sample',
    targetSize: 100,
    outcomes,
    requestCounts: { fullText: 100, originalPdf: 1 },
    durationMs: 60_000,
  });
  assert.equal(protectedFailure.passed, false);
  assert.equal(protectedFailure.checks.noOriginalPdfRequests, false);
});

test('PDF control compares the same documents against append-only derivative evidence', () => {
  const derivative = Array.from({ length: 10 }, (_, index) => outcome(`control-${index}`));
  const pdf = derivative.map((item) => outcome(item.docId, {
    contentSource: 'streamed_pdf',
    wordSource: 'pdf_text',
    wordCount: 9_500,
  }));
  const result = evaluateEnrichmentRun({
    phase: 'control',
    targetSize: 10,
    outcomes: pdf,
    controlOutcomes: derivative,
    requestCounts: { originalPdf: 10, retrievedBytes: 2_000_000 },
    durationMs: 60_000,
  });
  assert.equal(result.passed, true);
  assert.equal(result.comparison.pairedDocuments, 10);
  assert.ok(result.comparison.medianWordRelativeError < 0.1);
});

test('cohort gate blocks expansion on incomplete or operationally unsafe runs', () => {
  const result = evaluateEnrichmentRun({
    phase: 'cohort',
    targetSize: 5,
    outcomes: [outcome('only-one')],
    requestCounts: { retrievedBytes: 200 * 1024 * 1024 },
    durationMs: 60_000,
    heapGrowthBytes: 300 * 1024 * 1024,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.targetReached, false);
  assert.equal(result.checks.heapGrowth, false);
  assert.equal(result.checks.retrievedBytes, false);
});

test('cohort gate enforces the repository request-rate ceiling', () => {
  const outcomes = Array.from({ length: 5 }, (_, index) => outcome(`rate-${index}`));
  const result = evaluateEnrichmentRun({
    phase: 'cohort',
    targetSize: 5,
    outcomes,
    requestCounts: { metadata: 2000 },
    durationMs: 60_000,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.repositoryRequestRate, false);
  assert.equal(result.repositoryRequestsPerMinute, 2000);
});

// --- #23: infra_error-tagged outcomes (reserveImportRuleRequestSlot's last-resort
// RATE_LIMIT_STATE_CORRUPT throw) are excluded from the quality successRate ---

test('an infra_error-tagged outcome does not count against the quality success rate', () => {
  const good = Array.from({ length: 19 }, (_, index) => outcome(`good-${index}`));
  const infra = {
    docId: 'infra-1', error: 'Rate-limit state for import rule x is corrupt', outcomeKind: 'infra_error',
  };
  const withInfra = evaluateEnrichmentRun({
    phase: 'cohort',
    // targetSize matches the 19 real (quality) outcomes, not the 20 total —
    // targetReached is intentionally based on quality attempts too, so this
    // isolates the successRate assertion below from the unrelated
    // targetReached check.
    targetSize: 19,
    outcomes: [...good, infra],
    requestCounts: { fullText: 19 },
    durationMs: 60_000,
  });
  // 19/19 real documents succeeded; the one infra_error entry is excluded from
  // both the numerator and denominator, so successRate is 1, not 19/20.
  assert.equal(withInfra.attempted, 19);
  assert.equal(withInfra.completed, 19);
  assert.equal(withInfra.successRate, 1);
  assert.equal(withInfra.infraErrors, 1);
  assert.equal(withInfra.checks.successRate, true);
  assert.equal(withInfra.passed, true);
});

test('a mixed array of real parse failures still fails the success-rate check as before', () => {
  const good = Array.from({ length: 10 }, (_, index) => outcome(`good-${index}`));
  const bad = Array.from({ length: 10 }, (_, index) => ({
    docId: `bad-${index}`, error: 'unparseable PDF', wordCount: 0, pageCount: 0,
  }));
  const result = evaluateEnrichmentRun({
    phase: 'cohort',
    targetSize: 20,
    outcomes: [...good, ...bad],
    requestCounts: { fullText: 20 },
    durationMs: 60_000,
  });
  assert.equal(result.attempted, 20);
  assert.equal(result.completed, 10);
  assert.equal(result.infraErrors, 0);
  assert.equal(result.successRate, 0.5);
  assert.equal(result.checks.successRate, false);
  assert.equal(result.passed, false);
});

test('an exhausted final cohort can pass below the normal batch target', () => {
  const outcomes = [outcome('final-1'), outcome('final-2')];
  const result = evaluateEnrichmentRun({
    phase: 'cohort',
    targetSize: 100,
    outcomes,
    exhausted: true,
    requestCounts: { fullText: 2 },
    durationMs: 60_000,
  });
  assert.equal(result.passed, true);
  assert.equal(result.exhausted, true);
  assert.equal(result.checks.targetReached, true);
});
