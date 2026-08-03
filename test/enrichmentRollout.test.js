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
