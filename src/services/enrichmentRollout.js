export const ENRICHMENT_ROLLOUT_PHASES = new Set(['sample', 'control', 'cohort']);

export const ENRICHMENT_ROLLOUT_DEFAULTS = Object.freeze({
  sampleSize: 100,
  controlSize: 10,
  minimumSuccessRate: 0.95,
  minimumControlPairRate: 0.8,
  maximumMedianWordRelativeError: 0.15,
  maximumP90WordRelativeError: 0.35,
  maximumHeapGrowthBytes: 256 * 1024 * 1024,
  minimumDocumentsPerMinute: 1,
  maximumRetrievedBytesPerDocument: 100 * 1024 * 1024,
  maximumRepositoryRequestsPerMinute: 1_000,
});

function quantile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

function relativeDifference(left, right) {
  const denominator = Math.max(Number(left) || 0, Number(right) || 0);
  return denominator > 0 ? Math.abs(Number(left) - Number(right)) / denominator : null;
}

export function evaluateEnrichmentRun({
  phase,
  targetSize,
  outcomes = [],
  controlOutcomes = [],
  requestCounts = {},
  durationMs = 0,
  heapGrowthBytes = 0,
  exhausted = false,
  thresholds = ENRICHMENT_ROLLOUT_DEFAULTS,
} = {}) {
  if (!ENRICHMENT_ROLLOUT_PHASES.has(phase)) throw new Error(`Unknown enrichment rollout phase: ${phase}`);
  // #23: an outcome tagged 'infra_error' (currently only reserveImportRuleRequestSlot's
  // last-resort RATE_LIMIT_STATE_CORRUPT throw — ordinary limiter contention never
  // throws after the primary fix, so this path should be essentially unreachable in
  // practice) is infrastructure noise, not a document-quality signal. It is excluded
  // from both the numerator and denominator of the quality successRate so contention
  // cannot silently zero out the corpus's apparent quality, but it is still surfaced
  // operationally via `infraErrors` below.
  const qualityOutcomes = outcomes.filter((item) => item.outcomeKind !== 'infra_error');
  const infraErrors = outcomes.length - qualityOutcomes.length;
  const completed = qualityOutcomes.filter((item) => (
    Number(item.wordCount) > 0 && Number(item.pageCount) > 0 && !item.error
  ));
  const attempted = qualityOutcomes.length;
  const successRate = attempted ? completed.length / attempted : 0;
  const durationMinutes = Math.max(Number(durationMs) / 60_000, 1 / 60_000);
  const documentsPerMinute = attempted / durationMinutes;
  const retrievedBytesPerDocument = attempted
    ? Number(requestCounts.retrievedBytes || 0) / attempted
    : 0;
  const repositoryRequests = Number(requestCounts.metadata || 0)
    + Number(requestCounts.fullText || 0)
    + Number(requestCounts.originalPdf || 0);
  const repositoryRequestsPerMinute = repositoryRequests / durationMinutes;
  const checks = {
    targetReached: phase === 'cohort' && exhausted ? true : attempted >= Number(targetSize || 0),
    successRate: successRate >= thresholds.minimumSuccessRate,
    heapGrowth: Number(heapGrowthBytes || 0) <= thresholds.maximumHeapGrowthBytes,
    throughput: documentsPerMinute >= thresholds.minimumDocumentsPerMinute,
    retrievedBytes: retrievedBytesPerDocument <= thresholds.maximumRetrievedBytesPerDocument,
    repositoryRequestRate: repositoryRequestsPerMinute <= thresholds.maximumRepositoryRequestsPerMinute,
  };

  let comparison = null;
  if (phase === 'sample') {
    checks.noOriginalPdfRequests = Number(requestCounts.originalPdf || 0) === 0;
    checks.derivativeOnly = qualityOutcomes.every((item) => (
      item.contentSource === 'extracted_full_text' && item.wordSource === 'dspace_full_text'
    ));
  }
  if (phase === 'control') {
    const derivativeByDoc = new Map(controlOutcomes.map((item) => [String(item.docId), item]));
    const pairs = qualityOutcomes.map((pdf) => {
      const derivative = derivativeByDoc.get(String(pdf.docId));
      const wordRelativeError = derivative
        ? relativeDifference(pdf.wordCount, derivative.wordCount)
        : null;
      return derivative ? { docId: pdf.docId, wordRelativeError } : null;
    }).filter(Boolean);
    const errors = pairs.map((pair) => pair.wordRelativeError).filter(Number.isFinite).sort((a, b) => a - b);
    comparison = {
      pairedDocuments: pairs.length,
      pairRate: attempted ? pairs.length / attempted : 0,
      medianWordRelativeError: quantile(errors, 0.5),
      p90WordRelativeError: quantile(errors, 0.9),
    };
    checks.controlPairRate = comparison.pairRate >= thresholds.minimumControlPairRate;
    checks.medianWordRelativeError = comparison.medianWordRelativeError !== null
      && comparison.medianWordRelativeError <= thresholds.maximumMedianWordRelativeError;
    checks.p90WordRelativeError = comparison.p90WordRelativeError !== null
      && comparison.p90WordRelativeError <= thresholds.maximumP90WordRelativeError;
    checks.pdfSource = qualityOutcomes.every((item) => ['streamed_pdf', 'cached_pdf'].includes(item.contentSource));
  }

  return {
    passed: Object.values(checks).every(Boolean),
    phase,
    exhausted: Boolean(exhausted),
    targetSize: Number(targetSize || 0),
    attempted,
    completed: completed.length,
    failed: Math.max(0, attempted - completed.length),
    infraErrors,
    successRate,
    durationMs: Number(durationMs || 0),
    documentsPerMinute,
    heapGrowthBytes: Number(heapGrowthBytes || 0),
    requestCounts: {
      metadata: Number(requestCounts.metadata || 0),
      fullText: Number(requestCounts.fullText || 0),
      originalPdf: Number(requestCounts.originalPdf || 0),
      retrievedBytes: Number(requestCounts.retrievedBytes || 0),
    },
    retrievedBytesPerDocument,
    repositoryRequestsPerMinute,
    comparison,
    checks,
    thresholds,
  };
}
