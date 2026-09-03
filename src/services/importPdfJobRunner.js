import {
  appendAdminJobLog, finishAdminJob, finishClaimedAdminJob, getDb, listFileMetrics, listImportRules,
  listPendingCitationExtractions, listPendingCitationScans, loadCommitteeMembers,
  loadDocumentMetadata, loadStoredFileMetric, finishEnrichmentRolloutPhase, getEnrichmentRollout,
  listEffectiveCitationPoliciesForDocument, listEnrichmentRolloutEvidence,
  reserveImportRuleRequestSlot, saveCitationExtractionState, saveEnrichmentRolloutEvidence,
  requestAdminJobFollowup, saveWordCountComparisonParadata,
  startEnrichmentRolloutPhase, updateAdminJobProgress, updateClaimedAdminJobProgress
} from '../db.js';
import fs from 'node:fs/promises';
import {
  analyzeDocumentFile, analyzePdfAtPath, deleteCachedPdf, extractAndSaveParsedData
} from '../pdf.js';
import { getConfiguredApiKey } from '../secrets.js';
import {
  contentModeEnrichesDocuments, importRuleToSyncOptions, validateImportRule
} from '../importRules.js';
import {
  CITATION_PARSER_VERSION, CITATION_SCAN_MAX_DOCUMENTS, CITATION_SCAN_PAGE_SIZE, IMPORT_PDF_BATCH_SIZE
} from '../config.js';
import {
  ENRICHMENT_ROLLOUT_PHASES, evaluateEnrichmentRun
} from './enrichmentRollout.js';

async function log(jobId, message) {
  await appendAdminJobLog(jobId, `[${new Date().toISOString()}] ${message}\n`);
}

function createProgressReporter(job) {
  const jobId = job.id;
  const tasks = [];
  const taskIndex = new Map();

  return async function report(event = {}) {
    const key = event.phase || event.key || event.label || 'running';
    const label = event.label || event.currentTask || key;
    const status = event.status || 'running';
    const task = {
      key,
      label,
      status,
      detail: event.detail || null,
      counts: event.counts || null,
      updatedAt: new Date().toISOString(),
    };
    if (taskIndex.has(key)) {
      tasks[taskIndex.get(key)] = task;
    } else {
      taskIndex.set(key, tasks.length);
      tasks.push(task);
    }
    const progress = {
      phase: key,
      currentTask: status === 'completed' ? event.nextTask || label : label,
      tasks,
      counts: event.counts || null,
    };
    if (job.executionId) {
      await updateClaimedAdminJobProgress(jobId, job.executionId, progress);
    } else {
      await updateAdminJobProgress(jobId, progress);
    }
  };
}

function finishWorkerAdminJob(job, patch) {
  return job.executionId
    ? finishClaimedAdminJob(job.id, job.executionId, patch)
    : finishAdminJob(job.id, patch);
}

function readPdfBatchSize(params = {}) {
  const value = Number(params.pdfBatchSize || IMPORT_PDF_BATCH_SIZE || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function readDocIdList(value) {
  return Array.isArray(value)
    ? value.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
}

const DEFAULT_CITATION_MAX_CONTENT_BYTES = 200 * 1024 * 1024;

// Overlapping eligible rules compose conservatively: the smallest byte ceiling
// wins, and every positive per-rule request limit is reserved. A zero rate is
// the documented "no rule-specific limit" value and therefore adds no gate.
export function citationContentPolicy(policies = []) {
  const normalized = (Array.isArray(policies) ? policies : [])
    .map((policy) => ({
      ruleId: String(policy?.ruleId || '').trim(),
      maxContentBytes: Number(policy?.maxContentBytes),
      contentRateLimit: Number(policy?.contentRateLimit),
    }))
    .filter((policy) => policy.ruleId);
  const byteLimits = normalized
    .map((policy) => policy.maxContentBytes)
    .filter((value) => Number.isFinite(value) && value > 0);
  return {
    maxContentBytes: byteLimits.length
      ? Math.min(...byteLimits)
      : DEFAULT_CITATION_MAX_CONTENT_BYTES,
    rateLimits: normalized
      .filter((policy) => Number.isFinite(policy.contentRateLimit) && policy.contentRateLimit > 0)
      .map((policy) => ({
        ruleId: policy.ruleId,
        contentRateLimit: Math.floor(policy.contentRateLimit),
      }))
      .sort((left, right) => (
        left.contentRateLimit - right.contentRateLimit || left.ruleId.localeCompare(right.ruleId)
      )),
  };
}

export async function reserveCitationPolicyRequest(rateLimits, {
  reserveSlot = reserveImportRuleRequestSlot,
  now = () => Date.now(),
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  windowMs = 60_000,
} = {}) {
  for (const policy of Array.isArray(rateLimits) ? rateLimits : []) {
    for (;;) {
      const waitMs = await reserveSlot(policy.ruleId, policy.contentRateLimit, {
        nowMs: now(), windowMs,
      });
      if (!waitMs) break;
      await wait(waitMs);
    }
  }
}

// `createContinuationJob` is a test seam only: production always takes the
// default (a real admin worker job, which spawns a runner process), while tests
// inject a stub so driving many continuations stays a fast, in-process check of
// the params_json-stays-constant property (#16) without starting real workers.
export async function startContinuationJob(job, result, progress, { createContinuationJob = null } = {}) {
  const params = job.params || {};
  if (params.mode !== 'sync_missing_pdfs') return null;
  if (!params.autoContinuePdfBatches) return null;
  if (!result.ok || !result.pdfBatchLimitReached || Number(result.totalEnrichmentAttempted || 0) <= 0) return null;

  // Progress is carried as durable state, not as job parameters: one chain-start
  // timestamp plus one cursor per rule, so params_json stays the same size at batch
  // 1000 as at batch 1 instead of accumulating every attempted doc id (H-03).
  const nextParams = {
    ...params,
    rules: rulesForContinuation(params.rules, result.rules),
    continuationOf: params.continuationOf || job.id,
    previousJobId: job.id,
    enrichmentAttemptedBefore: result.enrichmentAttemptedBefore
      || params.enrichmentAttemptedBefore
      || new Date().toISOString(),
    enrichmentCursors: result.enrichmentCursors || {},
  };
  // A chain started before this change may still be carrying the old id list in its
  // params; drop it rather than copying it forward one more hop.
  delete nextParams.skipPdfDocIds;
  await progress?.({
    phase: 'continuation',
    label: 'Scheduling next PDF batch',
    status: 'running',
    counts: { saved: result.totalSaved || 0 },
  });

  try {
    const createJob = createContinuationJob || (async (payload) => {
      const { createAndStartAdminWorkerJob } = await import('./adminWorker.js');
      return createAndStartAdminWorkerJob(payload);
    });
    const next = await createJob({
      type: 'import_rules_sync',
      label: 'Import Rules Sync (PDF batch)',
      params: nextParams,
    });
    await log(job.id, `Scheduled next PDF batch as job ${next.jobId}.`);
    await progress?.({
      phase: 'continuation',
      label: 'Scheduled next PDF batch',
      status: 'completed',
      detail: `Job ${next.jobId}`,
    });
    return next;
  } catch (error) {
    const message = error?.message || String(error);
    await log(job.id, `Could not schedule next PDF batch: ${message}`);
    await progress?.({
      phase: 'continuation',
      label: 'Next PDF batch was not scheduled',
      status: 'failed',
      detail: message,
    });
    return { error: message };
  }
}

// Citation-scan sibling of `startContinuationJob`. Same durable-cursor property:
// the only progress carried into the next batch is one doc-id cursor, so
// params_json stays the same size at batch 1000 as at batch 1 (#16) instead of
// accumulating scanned ids. `createContinuationJob` is a test seam; production
// takes the default (a real admin worker job). Gated on `params.autoContinue`
// so the nightly scheduled run stays a single bounded page (the backlog drains
// across nights), while an operator batch can chain through the whole backlog.
export async function startCitationScanContinuation(job, result, progress, { createContinuationJob = null } = {}) {
  const params = job.params || {};
  if (!params.autoContinue) return null;
  if (!result.batchLimitReached) return null;
  // Failed documents are recorded and durably excluded from the next selection,
  // so a batch that made any progress can still safely drain the healthy backlog.
  if (Number(result.processed || 0) + Number(result.failed || 0) <= 0) return null;

  const nextParams = {
    ...params,
    afterDocId: result.cursor || '',
    continuationOf: params.continuationOf || job.id,
    previousJobId: job.id,
  };
  await progress?.({
    phase: 'continuation',
    label: 'Scheduling next citation scan batch',
    status: 'running',
    counts: { processed: result.processed || 0 },
  });

  try {
    const createJob = createContinuationJob || (async (payload) => {
      const { createAndStartAdminWorkerJob } = await import('./adminWorker.js');
      return createAndStartAdminWorkerJob(payload);
    });
    const next = await createJob({
      type: 'citation_scan',
      label: 'Citation Scan (continuation)',
      params: nextParams,
      // Atomically transfer the citation-scan singleton lease from this
      // still-running worker to its child. Manual/scheduled starts therefore
      // see the child as already running throughout the hand-off.
      singleInstance: true,
      replaceRunningJobId: job.id,
    });
    await log(job.id, `Scheduled next citation scan batch as job ${next.jobId}.`);
    await progress?.({
      phase: 'continuation',
      label: 'Scheduled next citation scan batch',
      status: 'completed',
      detail: `Job ${next.jobId}`,
    });
    return next;
  } catch (error) {
    const message = error?.message || String(error);
    await log(job.id, `Could not schedule next citation scan batch: ${message}`);
    await progress?.({
      phase: 'continuation',
      label: 'Next citation scan batch was not scheduled',
      status: 'failed',
      detail: message,
    });
    return { error: message };
  }
}

// Import and enrichment remain the source-of-truth job. Downstream processors
// are queued only after the final automatic content batch, and a failure to
// start either processor is reported without rewriting an otherwise successful
// metadata/content result as failed.
export async function queueEligibleImportProcessing(
  job,
  result,
  progress,
  { createProcessingJob = null, requestProcessingFollowup = requestAdminJobFollowup } = {}
) {
  const params = job.params || {};
  if (params.mode !== 'sync_missing_pdfs' || params.queueEligibleProcessing !== true) return null;
  if (!result.ok) return null;
  if (result.nextJobId) return null;
  if (params.autoContinuePdfBatches && result.pdfBatchLimitReached) return null;

  // `params.rules` is deliberately narrowed as content continuations finish.
  // The immutable policy snapshot remains complete so a rule whose content
  // finished in an earlier batch does not lose its downstream work.
  const rules = Array.isArray(params.downstreamPolicyRules)
    ? params.downstreamPolicyRules
    : Array.isArray(params.rules) ? params.rules : [];
  const citationRuleIds = rules
    .filter((rule) => rule?.extractCitations)
    .map((rule) => String(rule.id || '').trim())
    .filter(Boolean);
  const patternRankRuleIds = rules
    .filter((rule) => rule?.runConcepts !== false)
    .map((rule) => String(rule.id || '').trim())
    .filter(Boolean);
  if (!citationRuleIds.length && !patternRankRuleIds.length) return { jobs: [], errors: [] };

  const createJob = createProcessingJob || (async (payload) => {
    const { createAndStartAdminWorkerJob } = await import('./adminWorker.js');
    return createAndStartAdminWorkerJob(payload);
  });
  const jobs = [];
  const deferred = [];
  const errors = [];
  const queueOne = async (processor, payload) => {
    try {
      const queued = await createJob(payload);
      if (queued.alreadyRunning) {
        // Reconcile the complete effective eligibility set, rather than the
        // triggering rule subset: several imports may collide with one active
        // singleton, and pending-state selectors make the broad pass cheap.
        const { scope: _ignoredScope, ...citationParams } = payload.params || {};
        const followupParams = processor === 'citation'
          ? { ...citationParams, trigger: 'import_enrichment_reconciliation' }
          : { ...payload.params, trigger: 'import_enrichment_reconciliation' };
        await requestProcessingFollowup({
          type: payload.type,
          label: `${payload.label} (reconciliation)`,
          params: followupParams,
        });
        deferred.push({ processor, activeJobId: queued.jobId, reason: 'processor_already_running' });
        await log(job.id, `${processor} eligibility is durable; processing is deferred behind active job ${queued.jobId}.`).catch(() => {});
      } else {
        jobs.push({ processor, jobId: queued.jobId });
        await log(job.id, `${processor} processing queued as job ${queued.jobId}.`).catch(() => {});
      }
    } catch (error) {
      const message = error?.message || String(error);
      errors.push({ processor, error: message });
      await log(job.id, `Could not queue ${processor} processing: ${message}`).catch(() => {});
    }
  };

  if (progress) {
    await progress({
      phase: 'downstream_processing',
      label: 'Queueing eligible processing',
      status: 'running',
    }).catch(() => {});
  }
  if (citationRuleIds.length) {
    await queueOne('citation', {
      type: 'citation_scan',
      label: 'Citation Scan (import policy)',
      params: {
        trigger: 'import_enrichment',
        retryFailures: false,
        autoContinue: true,
        scope: { eligibilityRuleIds: citationRuleIds },
      },
      singleInstance: true,
    });
  }
  if (patternRankRuleIds.length) {
    await queueOne('PatternRank', {
      type: 'concept_rebuild',
      label: 'Incremental PatternRank (import policy)',
      params: { method: 'patternrank_incremental', trigger: 'import_enrichment' },
      singleInstance: true,
    });
  }
  if (progress) {
    await progress({
      phase: 'downstream_processing',
      label: 'Eligible processing queued',
      status: errors.length ? 'failed' : 'completed',
      counts: { queued: jobs.length, deferred: deferred.length, failed: errors.length },
    }).catch(() => {});
  }
  return { jobs, deferred, errors };
}

export function rulesForContinuation(rules, completedRuleResults) {
  if (!Array.isArray(rules)) return rules;
  const completedByRuleId = new Map(
    (Array.isArray(completedRuleResults) ? completedRuleResults : [])
      .map((result) => [String(result?.ruleId || ''), result])
      .filter(([ruleId]) => ruleId)
  );
  return rules.filter((rule) => {
    const result = completedByRuleId.get(String(rule?.id || ''));
    return !result || Boolean(result.pdfBatchLimitReached);
  });
}

async function analyzePdfEntry(entry, artifactClient, {
  keepPdfPath = false,
  progress = null,
  counts = null,
  label = 'Parsing cached PDF text',
} = {}) {
  const progressCounts = counts || null;
  if (artifactClient) {
    await progress?.({
      phase: 'pdf_parse',
      label: 'Fetching cached PDF for parsing',
      detail: entry.doc_id,
      status: 'running',
      counts: progressCounts,
    });
    const remote = await artifactClient.downloadPdfToTemp(entry.doc_id);
    if (!remote?.path) {
      await progress?.({
        phase: 'pdf_parse',
        label: 'Cached PDF unavailable for parsing',
        detail: entry.doc_id,
        status: 'failed',
        counts: progressCounts,
      });
      return null;
    }
    try {
      await progress?.({
        phase: 'pdf_parse',
        label,
        detail: entry.doc_id,
        status: 'running',
        counts: progressCounts,
      });
      const analysis = await analyzePdfAtPath(remote.path);
      await progress?.({
        phase: 'pdf_parse',
        label: 'Parsed cached PDF text',
        detail: entry.doc_id,
        status: 'completed',
        counts: {
          ...(progressCounts || {}),
          pages: analysis.pageCount || 0,
          words: analysis.wordCount || 0,
        },
      });
      if (keepPdfPath) {
        return { ...analysis, pdfPath: remote.path, cleanup: remote.cleanup };
      }
      await remote.cleanup?.();
      return analysis;
    } catch (error) {
      await progress?.({
        phase: 'pdf_parse',
        label: 'Cached PDF parsing failed',
        detail: entry.doc_id,
        status: 'failed',
        counts: progressCounts,
      });
      await remote.cleanup?.();
      throw error;
    }
  }
  await progress?.({
    phase: 'pdf_parse',
    label,
    detail: entry.doc_id,
    status: 'running',
    counts: progressCounts,
  });
  try {
    const analysis = await analyzePdfAtPath(entry.pdf_path);
    await progress?.({
      phase: 'pdf_parse',
      label: 'Parsed cached PDF text',
      detail: entry.doc_id,
      status: 'completed',
      counts: {
        ...(progressCounts || {}),
        pages: analysis.pageCount || 0,
        words: analysis.wordCount || 0,
      },
    });
    return keepPdfPath ? { ...analysis, pdfPath: entry.pdf_path } : analysis;
  } catch (error) {
    await progress?.({
      phase: 'pdf_parse',
      label: 'Cached PDF parsing failed',
      detail: entry.doc_id,
      status: 'failed',
      counts: progressCounts,
    });
    throw error;
  }
}

// Re-exported from config so existing importers of this symbol keep working; the
// single source of truth now lives in src/config.js.
export { CITATION_PARSER_VERSION };

async function loadCitationSource(entry, artifactClient, progress, counts = null) {
  if (entry.pdf_path) {
    const analysis = await analyzePdfEntry(entry, artifactClient, {
      keepPdfPath: true,
      progress,
      counts,
      label: 'Parsing cached PDF text for citations',
    });
    return analysis ? {
      fullText: analysis.fullText || '',
      pdfPath: analysis.pdfPath || null,
      cleanup: analysis.cleanup || null,
    } : null;
  }
  if (!entry.full_text_path) return null;
  if (artifactClient) {
    const artifact = await artifactClient.downloadFullText(entry.doc_id);
    return artifact?.fullText ? { fullText: artifact.fullText, pdfPath: null, cleanup: null } : null;
  }
  return {
    fullText: await fs.readFile(entry.full_text_path, 'utf8'),
    pdfPath: null,
    cleanup: null,
  };
}

export async function runImportPdfAdminJob(job, { artifactClient = null, clearMetricsCache = null } = {}) {
  const params = job.params || {};
  const progress = createProgressReporter(job);

  if (job.type === 'document_sync') {
    const { runDocumentSync } = await import('../sync.js');
    await log(job.id, 'Starting Open Collections document sync.');
    await progress({ phase: 'document_sync', label: 'Syncing Open Collections metadata', status: 'running' });
    const result = await runDocumentSync({
      ...(params.options || {}),
      apiKey: await getConfiguredApiKey(),
      artifactClient,
    });
    clearMetricsCache?.();
    await finishWorkerAdminJob(job, {
      status: result.ok ? 'completed' : 'failed',
      result,
      error: result.ok ? null : result.error || 'Document sync failed',
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Document sync finished: ${result.totalSaved || 0} saved, ${result.totalSkipped || 0} skipped.`);
    await progress({
      phase: 'document_sync',
      label: 'Open Collections metadata sync',
      status: 'completed',
      counts: { saved: result.totalSaved || 0, skipped: result.totalSkipped || 0 },
    });
    return result;
  }

  if (job.type === 'import_rules_sync') {
    const { runDocumentSync } = await import('../sync.js');
    const allRules = await listImportRules();
    const selectedIds = Array.isArray(params.ruleIds)
      ? params.ruleIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    const snapshottedRules = Array.isArray(params.rules)
      ? params.rules.map((input) => {
          const { rule, errors } = validateImportRule(input);
          if (errors.length) throw new Error(`Invalid snapshotted import rule: ${errors.join(' ')}`);
          return rule;
        })
      : [];
    const rules = snapshottedRules.length
      ? snapshottedRules
      : params.scope === 'all' ? allRules : allRules.filter((rule) => selectedIds.includes(rule.id));
    if (!rules.length) throw new Error(params.scope === 'all' ? 'No import rules are saved.' : 'Select at least one import rule.');
    for (const input of rules) {
      const { errors } = validateImportRule(input);
      if (errors.length) throw new Error(`Invalid import rule: ${errors.join(' ')}`);
    }

    const rollout = params.rollout || null;
    if (rollout) {
      if (!ENRICHMENT_ROLLOUT_PHASES.has(rollout.phase) || rules.length !== 1) {
        throw new Error('Progressive enrichment jobs require one rule and a valid rollout phase.');
      }
      await startEnrichmentRolloutPhase(rules[0].id, rollout.phase, job.id, rollout.ruleRevision);
    }

    await log(job.id, `Starting import rules sync (${params.mode}, ${params.scope}).`);
    const rolloutStartedAt = Date.now();
    await progress({ phase: 'import_rules', label: 'Running import rules', status: 'running' });
    const apiKey = await getConfiguredApiKey();
    const perRule = [];
    const pdfBatchSize = readPdfBatchSize(params);
    // Only this job's attempts. What earlier batches in the chain already took is
    // durable state in enrichment_attempts, so this set stays bounded by the batch
    // size instead of accumulating every doc id the chain has ever touched.
    const attemptedPdfIds = new Set();
    // One instant for the whole job (and, via continuation params, for the whole
    // batch chain): documents attempted at or after it are already this chain's work.
    const enrichmentAttemptedBefore = String(params.enrichmentAttemptedBefore || new Date().toISOString());
    const enrichmentCursors = {
      ...(params.enrichmentCursors && typeof params.enrichmentCursors === 'object' ? params.enrichmentCursors : {}),
    };
    const totals = {
      rulesStarted: 0,
      totalSeen: 0,
      totalSaved: 0,
      totalSkipped: 0,
      totalEnrichmentAttempted: 0,
      totalEnriched: 0,
      totalEnrichmentFailed: 0,
    };
    const enrichmentOutcomes = [];
    let heapGrowthBytes = 0;
    const requestCounts = { metadata: 0, fullText: 0, originalPdf: 0, retrievedBytes: 0 };
    let pdfBatchLimitReached = false;
    for (const rule of rules) {
      const enrichesDocuments = contentModeEnrichesDocuments(rule.contentMode);
      const remainingPdfBatchSize = params.mode === 'sync_missing_pdfs' && enrichesDocuments && pdfBatchSize
        ? Math.max(0, pdfBatchSize - totals.totalEnrichmentAttempted)
        : 0;
      if (params.mode === 'sync_missing_pdfs' && enrichesDocuments && pdfBatchSize && remainingPdfBatchSize <= 0) {
        pdfBatchLimitReached = true;
        break;
      }
      await log(job.id, `Syncing rule "${rule.name}" (${rule.id}).`);
      await progress({
        phase: 'import_rules',
        label: 'Running import rules',
        detail: `Syncing ${rule.name}`,
        status: 'running',
        counts: { processed: perRule.length, total: rules.length },
      });
      const result = await runDocumentSync({
        ...importRuleToSyncOptions(rule, {
          mode: params.mode,
          apiKey,
        }),
        artifactClient,
        onProgress: async (event = {}) => progress({
          ...event,
          detail: event.detail || `Syncing ${rule.name}`,
        }),
        pdfBatchSize: params.mode === 'sync_missing_pdfs' && enrichesDocuments ? remainingPdfBatchSize : 0,
        enrichmentDocIds: rollout?.phase === 'control' ? rollout.documentIds : [],
        enrichmentAttemptedBefore,
        enrichmentCursor: enrichmentCursors[rule.id] || '',
      });
      if (result.enrichmentCursor) enrichmentCursors[rule.id] = result.enrichmentCursor;
      totals.rulesStarted += 1;
      totals.totalSeen += Number(result.totalSeen || 0);
      totals.totalSaved += Number(result.totalSaved || 0);
      totals.totalSkipped += Number(result.totalSkipped || 0);
      requestCounts.metadata += Number(result.requestCounts?.metadata || 0);
      requestCounts.fullText += Number(result.requestCounts?.fullText || 0);
      requestCounts.originalPdf += Number(result.requestCounts?.originalPdf || 0);
      requestCounts.retrievedBytes += Number(result.requestCounts?.retrievedBytes || 0);
      totals.totalEnrichmentAttempted += Number(result.totalEnrichmentAttempted || 0);
      totals.totalEnriched += Number(result.totalEnriched || 0);
      totals.totalEnrichmentFailed += Number(result.totalEnrichmentFailed || 0);
      enrichmentOutcomes.push(...(Array.isArray(result.enrichmentOutcomes) ? result.enrichmentOutcomes : []));
      heapGrowthBytes = Math.max(heapGrowthBytes, Number(result.heapGrowthBytes || 0));
      for (const docId of readDocIdList(result.pdfAttemptedIds)) attemptedPdfIds.add(docId);
      if (result.pdfBatchLimitReached) pdfBatchLimitReached = true;
      perRule.push({
        ruleId: rule.id,
        ruleName: rule.name,
        contentMode: rule.contentMode,
        syncKey: result.syncKey,
        ok: result.ok,
        totalSeen: result.totalSeen || 0,
        totalSaved: result.totalSaved || 0,
        totalSkipped: result.totalSkipped || 0,
        apiTotal: result.apiTotal ?? null,
        pdfBatchLimitReached: Boolean(result.pdfBatchLimitReached),
        pdfAttempted: Array.isArray(result.pdfAttemptedIds) ? result.pdfAttemptedIds.length : 0,
        totalEnrichmentAttempted: Number(result.totalEnrichmentAttempted || 0),
        totalEnriched: Number(result.totalEnriched || 0),
        totalEnrichmentFailed: Number(result.totalEnrichmentFailed || 0),
        requestCounts: result.requestCounts || {
          metadata: 0, fullText: 0, originalPdf: 0, retrievedBytes: 0,
        },
        heapGrowthBytes: Number(result.heapGrowthBytes || 0),
        enrichmentExhausted: Boolean(result.enrichmentExhausted),
        eligibilityProjectionPublished: Boolean(result.eligibilityProjectionPublished),
        error: result.error || null,
      });
      await log(job.id, `Rule result: ${result.ok ? 'success' : 'failed'}; ${result.totalSaved || 0} saved.`);
      if (
        params.mode === 'sync_missing_pdfs'
        && enrichesDocuments
        && pdfBatchSize
        && totals.totalEnrichmentAttempted >= pdfBatchSize
      ) {
        if (!rollout || !result.enrichmentExhausted) pdfBatchLimitReached = true;
        break;
      }
    }
    const result = {
      ok: perRule.every((item) => item.ok),
      mode: params.mode,
      scope: params.scope,
      pdfBatchSize: params.mode === 'sync_missing_pdfs' ? pdfBatchSize : null,
      pdfBatchLimitReached,
      pdfAttemptedIds: Array.from(attemptedPdfIds),
      requestCounts,
      enrichmentAttemptedBefore,
      enrichmentCursors,
      ...totals,
      rules: perRule,
    };
    if (rollout) {
      const rule = rules[0];
      await saveEnrichmentRolloutEvidence({
        ruleId: rule.id,
        ruleRevision: rollout.ruleRevision,
        phase: rollout.phase,
        jobId: job.id,
        contentMode: rule.contentMode,
        outcomes: enrichmentOutcomes,
      });
      const rolloutState = await getEnrichmentRollout(rule.id);
      const controlEvidence = rollout.phase === 'control' && rolloutState?.sampleJobId
        ? await listEnrichmentRolloutEvidence({ ruleId: rule.id, jobId: rolloutState.sampleJobId })
        : [];
      const evaluation = evaluateEnrichmentRun({
        phase: rollout.phase,
        targetSize: rollout.targetSize,
        outcomes: enrichmentOutcomes,
        controlOutcomes: controlEvidence.map((entry) => entry.outcome).filter(Boolean),
        requestCounts,
        durationMs: Date.now() - rolloutStartedAt,
        heapGrowthBytes,
        exhausted: perRule.length === 1 && Boolean(perRule[0].enrichmentExhausted),
      });
      if (rollout.phase === 'control') {
        for (const comparison of evaluation.comparison?.documents || []) {
          await saveWordCountComparisonParadata(comparison.docId, {
            ...comparison,
            status: comparison.flagged ? 'flagged' : 'within_threshold',
            ruleId: rule.id,
            ruleRevision: rollout.ruleRevision,
            jobId: job.id,
            phase: rollout.phase,
          });
        }
      }
      if (rollout.phase === 'sample' && Number(requestCounts.originalPdf || 0) > 0) {
        await log(job.id, `ALERT: protected full-text sample made ${requestCounts.originalPdf} original PDF request(s); rollout blocked.`);
      }
      result.rollout = await finishEnrichmentRolloutPhase(rule.id, rollout.phase, job.id, evaluation);
      result.rolloutEvaluation = evaluation;
      if (!evaluation.passed) result.ok = false;
    }
    const continuation = await startContinuationJob(job, result, progress);
    if (continuation?.jobId) result.nextJobId = continuation.jobId;
    if (continuation?.error) result.continuationError = continuation.error;
    const downstreamProcessing = await queueEligibleImportProcessing(job, result, progress);
    if (downstreamProcessing) result.downstreamProcessing = downstreamProcessing;
    clearMetricsCache?.();
    await finishWorkerAdminJob(job, {
      status: result.ok ? 'completed' : 'failed',
      result,
      error: result.ok ? null : 'One or more import rules failed.',
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, 'Import rules sync finished.');
    await progress({
      phase: 'import_rules',
      label: 'Import rules sync',
      status: 'completed',
      counts: { processed: perRule.length, total: rules.length, saved: totals.totalSaved },
    });
    return result;
  }

  if (job.type === 'cache_refresh_doc') {
    const docId = params.docId;
    await progress({ phase: 'metadata', label: 'Loading document metadata', status: 'running', detail: docId });
    const doc = await loadDocumentMetadata(docId);
    if (!doc) throw new Error('Document not found in metadata store');
    await progress({ phase: 'metadata', label: 'Loaded document metadata', status: 'completed', detail: docId });
    await log(job.id, `Refreshing PDF/full-text analysis for ${docId}.`);
    if (!artifactClient) await deleteCachedPdf(docId);
    await analyzeDocumentFile(doc, {
      downloadFiles: true,
      forceDownload: true,
      recomputeFromCache: false,
      artifactClient,
      onProgress: progress,
      extractCitations: false,
    });
    const result = {
      ok: true,
      docId,
      status: doc.downloadStatus,
      pages: doc.pages,
      pagesSource: doc.pagesSource,
      wordCount: doc.wordCount,
      wordCountSource: doc.wordCountSource,
      fileBytes: doc.fileBytes,
      downloadUrl: doc.downloadUrl,
      downloadError: doc.downloadError || null,
    };
    clearMetricsCache?.();
    await finishWorkerAdminJob(job, {
      status: 'completed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Refresh finished for ${docId}.`);
    await progress({
      phase: 'complete',
      label: 'Refresh complete',
      status: 'completed',
      counts: { pages: doc.pages || 0, words: doc.wordCount || 0, citations: doc.citationCount || 0 },
    });
    return result;
  }

  if (job.type === 'cache_reanalyze_doc') {
    const docId = params.docId;
    await progress({ phase: 'metadata', label: 'Loading document metadata', status: 'running', detail: docId });
    const doc = await loadDocumentMetadata(docId);
    if (!doc) throw new Error('Document not found in metadata store');
    await progress({ phase: 'metadata', label: 'Loaded document metadata', status: 'completed', detail: docId });
    await log(job.id, `Reanalyzing cached PDF/full-text for ${docId}.`);
    await analyzeDocumentFile(doc, {
      downloadFiles: false,
      forceDownload: false,
      recomputeFromCache: true,
      artifactClient,
      onProgress: progress,
      extractCommittee: true,
      extractCitations: false,
    });
    const result = {
      ok: doc.downloadStatus !== 'cache_miss' && doc.downloadStatus !== 'cache_error',
      docId,
      status: doc.downloadStatus,
      pages: doc.pages,
      pagesSource: doc.pagesSource,
      wordCount: doc.wordCount,
      wordCountSource: doc.wordCountSource,
      fileBytes: doc.fileBytes,
      downloadUrl: doc.downloadUrl,
      downloadError: doc.downloadError || null,
    };
    clearMetricsCache?.();
    await finishWorkerAdminJob(job, {
      status: result.ok ? 'completed' : 'failed',
      result,
      error: result.ok ? null : result.downloadError || 'Cached PDF/full-text reanalysis failed.',
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Cached reanalysis finished for ${docId}: ${result.status || 'unknown'}.`);
    await progress({
      phase: 'complete',
      label: 'Cached reanalysis complete',
      status: 'completed',
      counts: { pages: doc.pages || 0, words: doc.wordCount || 0 },
    });
    return result;
  }

  if (job.type === 'cache_reextract_citations_doc') {
    const docId = params.docId;
    await progress({ phase: 'metadata', label: 'Loading document metadata', status: 'running', detail: docId });
    const doc = await loadDocumentMetadata(docId);
    if (!doc) throw new Error('Document not found in metadata store');
    await progress({ phase: 'metadata', label: 'Loaded document metadata', status: 'completed', detail: docId });
    await log(job.id, `Re-extracting cached PDF citations for ${docId}.`);
    const entry = (await listFileMetrics()).find((item) => item.doc_id === docId && item.pdf_path);
    if (!entry) throw new Error('No cached PDF available for citation extraction.');
    const analysis = await analyzePdfEntry(entry, artifactClient, {
      keepPdfPath: true,
      progress,
      label: 'Parsing cached PDF text for citations',
    });
    try {
      if (!analysis?.fullText) {
        const error = 'Cached PDF text extraction returned no text.';
        await saveCitationExtractionState(docId, {
          contentChecksum: entry.content_checksum || entry.updated_at || null,
          parserVersion: CITATION_PARSER_VERSION,
          status: 'failed',
          citationCount: 0,
          error,
        });
        const result = {
          ok: false,
          docId,
          citations: 0,
          error,
        };
        clearMetricsCache?.();
        await finishWorkerAdminJob(job, {
          status: 'failed',
          result,
          error,
          finishedAt: new Date().toISOString(),
        });
        await log(job.id, `Citation re-extraction skipped for ${docId}: ${error}`);
        await progress({
          phase: 'complete',
          label: 'Citation re-extraction skipped',
          status: 'failed',
          detail: error,
          counts: { citations: 0 },
        });
        return result;
      }
      await extractAndSaveParsedData(doc, analysis.fullText, analysis.pdfPath, {
        onProgress: progress,
        extractCommittee: false,
        extractCitations: true,
        strictCitationErrors: true,
      });
      await saveCitationExtractionState(docId, {
        contentChecksum: entry.content_checksum || entry.updated_at || null,
        parserVersion: CITATION_PARSER_VERSION,
        status: 'completed',
        citationCount: doc.citationCount || 0,
      });
    } catch (error) {
      await saveCitationExtractionState(docId, {
        contentChecksum: entry.content_checksum || entry.updated_at || null,
        parserVersion: CITATION_PARSER_VERSION,
        status: 'failed',
        citationCount: 0,
        error: error?.message || String(error),
      });
      throw error;
    } finally {
      await analysis?.cleanup?.();
    }
    const result = {
      ok: true,
      docId,
      citations: doc.citationCount || 0,
    };
    clearMetricsCache?.();
    await finishWorkerAdminJob(job, {
      status: 'completed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Citation re-extraction finished for ${docId}: ${result.citations} citations.`);
    await progress({
      phase: 'complete',
      label: 'Citation re-extraction complete',
      status: 'completed',
      counts: { citations: result.citations },
    });
    return result;
  }

  if (job.type === 'reparse_all') {
    await log(job.id, 'Starting cached PDF document reparse without citation extraction.');
    await progress({ phase: 'reparse_all', label: 'Reparsing cached PDF document data', status: 'running' });
    const entries = (await listFileMetrics()).filter((entry) => entry.pdf_path);
    let processed = 0;
    let withCommittee = 0;
    for (const entry of entries) {
      try {
        await progress({
          phase: 'reparse_all',
          label: 'Reparsing cached PDF document data',
          detail: entry.doc_id,
          status: 'running',
          counts: { processed, total: entries.length, withCommittee },
        });
        const analysis = await analyzePdfEntry(entry, artifactClient, {
          progress,
          counts: { processed, total: entries.length, withCommittee },
          label: 'Parsing cached PDF document data',
        });
        if (!analysis?.fullText) continue;
        processed += 1;
        const doc = await loadDocumentMetadata(entry.doc_id) || { id: entry.doc_id, supervisors: [] };
        await extractAndSaveParsedData(doc, analysis.fullText, null, {
          onProgress: progress,
          extractCommittee: true,
          extractCitations: false,
        });
        if (doc.committee?.length) withCommittee += 1;
      } catch (error) {
        await log(job.id, `Reparse failed for ${entry.doc_id}: ${error?.message || String(error)}`);
      }
    }
    const result = { ok: true, processed, committees: withCommittee, citations: 0 };
    clearMetricsCache?.();
    await finishWorkerAdminJob(job, {
      status: 'completed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Reparse finished: ${processed} processed.`);
    await progress({
      phase: 'reparse_all',
      label: 'Cached PDF document reparse',
      status: 'completed',
      counts: { processed, total: entries.length, withCommittee },
    });
    return result;
  }

  if (job.type === 'reparse_citations') {
    await log(job.id, 'Starting incremental citation extraction without catalogue resolution.');
    await progress({ phase: 'citation_extraction', label: 'Extracting pending citations', status: 'running' });
    const maxDocuments = Math.max(1, Math.min(5000, Number(params.maxDocuments) || 1000));
    const pageSize = Math.min(maxDocuments, Math.max(1, Math.min(250, Number(params.pageSize) || 50)));
    const scope = params.scope || {};
    let processed = 0;
    let totalCitations = 0;
    let failed = 0;
    let cursor = '';
    let reachedLimit = false;
    while (processed + failed < maxDocuments) {
      const entries = await listPendingCitationExtractions({
        limit: Math.min(pageSize, maxDocuments - processed - failed),
        afterDocId: cursor,
        syncKey: scope.syncKey || null,
        filters: scope.filters || scope,
        eligibilityRuleIds: scope.eligibilityRuleIds || [],
        parserVersion: CITATION_PARSER_VERSION,
      });
      if (!entries.length) break;
      for (const entry of entries) {
        cursor = entry.doc_id;
        let source = null;
        try {
          await progress({
            phase: 'citation_extraction',
            label: 'Extracting pending citations',
            detail: entry.doc_id,
            status: 'running',
            counts: { processed, failed, citations: totalCitations, cursor, maxDocuments },
          });
          source = await loadCitationSource(entry, artifactClient, progress, {
            processed, failed, citations: totalCitations, maxDocuments,
          });
          if (!source?.fullText) throw new Error('Cached content returned no text for citation extraction.');
          const doc = await loadDocumentMetadata(entry.doc_id) || { id: entry.doc_id, supervisors: [] };
          await extractAndSaveParsedData(doc, source.fullText, source.pdfPath, {
            onProgress: progress,
            extractCommittee: false,
            extractCitations: true,
            strictCitationErrors: true,
          });
          processed += 1;
          if (doc.citationCount) totalCitations += Number(doc.citationCount);
          await saveCitationExtractionState(entry.doc_id, {
            contentChecksum: entry.content_checksum,
            parserVersion: CITATION_PARSER_VERSION,
            status: 'completed',
            citationCount: doc.citationCount || 0,
          });
        } catch (error) {
          failed += 1;
          await saveCitationExtractionState(entry.doc_id, {
            contentChecksum: entry.content_checksum,
            parserVersion: CITATION_PARSER_VERSION,
            status: 'failed',
            citationCount: 0,
            error: error?.message || String(error),
          });
          await log(job.id, `Citation extraction failed for ${entry.doc_id}: ${error?.message || String(error)}`);
        } finally {
          await source?.cleanup?.();
        }
      }
      await progress({
        phase: 'citation_extraction',
        label: 'Extracting pending citations',
        status: 'running',
        detail: `Checkpointed through ${cursor}`,
        counts: { processed, failed, citations: totalCitations, cursor, maxDocuments },
      });
    }
    if (processed + failed >= maxDocuments) {
      const remaining = await listPendingCitationExtractions({
        limit: 1,
        afterDocId: cursor,
        syncKey: scope.syncKey || null,
        filters: scope.filters || scope,
        eligibilityRuleIds: scope.eligibilityRuleIds || [],
        parserVersion: CITATION_PARSER_VERSION,
      });
      reachedLimit = remaining.length > 0;
    }
    const result = {
      ok: failed === 0,
      processed,
      failed,
      citations: totalCitations,
      parserVersion: CITATION_PARSER_VERSION,
      cursor: cursor || null,
      batchLimitReached: reachedLimit,
      resolutionQueued: false,
    };
    clearMetricsCache?.();
    await finishWorkerAdminJob(job, {
      status: failed ? 'failed' : 'completed',
      result,
      error: failed ? `${failed} document(s) failed citation extraction.` : null,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Citation extraction finished: ${processed} processed, ${failed} failed. Catalogue resolution was not started.`);
    await progress({
      phase: 'citation_extraction',
      label: 'Citation extraction',
      status: failed ? 'failed' : 'completed',
      counts: { processed, failed, citations: totalCitations, cursor, batchLimitReached: reachedLimit },
    });
    return result;
  }

  if (job.type === 'citation_scan') {
    await log(job.id, 'Starting re-streaming citation scan (no caching).');
    await progress({ phase: 'citation_scan', label: 'Scanning documents for citations', status: 'running' });
    const maxDocuments = Math.max(1, Math.min(5000, Number(params.maxDocuments) || CITATION_SCAN_MAX_DOCUMENTS));
    const pageSize = Math.min(maxDocuments, Math.max(1, Math.min(250, Number(params.pageSize) || CITATION_SCAN_PAGE_SIZE)));
    const scope = params.scope || {};
    // Forced reprocess re-selects every streamable in-scope document (dropping the
    // scan-once gates) and implies retryFailures. The cursor still guarantees
    // forward progress within a run, and re-extraction replaces existing citations.
    const reprocess = Boolean(params.reprocess);
    const retryFailures = reprocess || Boolean(params.retryFailures);
    let processed = 0;
    let failed = 0;
    let totalCitations = 0;
    // Durable cursor carried across continuation batches (params_json stays O(1)).
    let cursor = String(params.afterDocId || '');
    let reachedLimit = false;
    while (processed + failed < maxDocuments) {
      const entries = await listPendingCitationScans({
        limit: Math.min(pageSize, maxDocuments - processed - failed),
        afterDocId: cursor,
        syncKey: scope.syncKey || null,
        filters: scope.filters || scope,
        eligibilityRuleIds: scope.eligibilityRuleIds || [],
        retryFailures,
        reprocess,
      });
      if (!entries.length) break;
      for (const entry of entries) {
        cursor = entry.doc_id;
        let scannedContentChecksum = entry.content_checksum;
        try {
          await progress({
            phase: 'citation_scan',
            label: 'Scanning documents for citations',
            detail: entry.doc_id,
            status: 'running',
            counts: { processed, failed, citations: totalCitations, cursor, maxDocuments },
          });
          const doc = await loadDocumentMetadata(entry.doc_id);
          if (!doc) throw new Error('Document metadata not found for citation scan.');
          const contentPolicy = citationContentPolicy(
            await listEffectiveCitationPoliciesForDocument(entry.doc_id)
          );
          // Re-stream the original PDF (rate-limited, temp file deleted after
          // parse, nothing cached), extract and dedup citations. No committee,
          // no catalogue resolution.
          await analyzeDocumentFile(doc, {
            contentMode: 'pdf_stream',
            downloadFiles: true,
            forceDownload: true,
            recomputeFromCache: false,
            extractCommittee: false,
            extractCitations: true,
            strictCitationErrors: true,
            artifactClient,
            maxContentBytes: contentPolicy.maxContentBytes,
            onContentRequest: async (event = {}) => {
              if (event.request) {
                await reserveCitationPolicyRequest(contentPolicy.rateLimits);
              }
            },
            onProgress: progress,
          });
          if (doc.downloadStatus !== 'streamed') {
            throw new Error(doc.downloadError || `Streaming failed (${doc.downloadStatus || 'unknown'}).`);
          }
          const streamedMetric = await loadStoredFileMetric(entry.doc_id);
          scannedContentChecksum = streamedMetric?.content_checksum || scannedContentChecksum;
          processed += 1;
          if (doc.citationCount) totalCitations += Number(doc.citationCount);
          await saveCitationExtractionState(entry.doc_id, {
            contentChecksum: scannedContentChecksum,
            parserVersion: CITATION_PARSER_VERSION,
            status: 'completed',
            citationCount: doc.citationCount || 0,
          });
        } catch (error) {
          failed += 1;
          // The stream may have succeeded before strict citation extraction
          // failed. Record the checksum of the bytes actually attempted rather
          // than the stale checksum selected before the re-download.
          const streamedMetric = await loadStoredFileMetric(entry.doc_id).catch(() => null);
          scannedContentChecksum = streamedMetric?.content_checksum || scannedContentChecksum;
          await saveCitationExtractionState(entry.doc_id, {
            contentChecksum: scannedContentChecksum,
            parserVersion: CITATION_PARSER_VERSION,
            status: 'failed',
            citationCount: 0,
            error: error?.message || String(error),
          });
          await log(job.id, `Citation scan failed for ${entry.doc_id}: ${error?.message || String(error)}`);
        }
      }
      await progress({
        phase: 'citation_scan',
        label: 'Scanning documents for citations',
        status: 'running',
        detail: `Checkpointed through ${cursor}`,
        counts: { processed, failed, citations: totalCitations, cursor, maxDocuments },
      });
    }
    if (processed + failed >= maxDocuments) {
      const remaining = await listPendingCitationScans({
        limit: 1,
        afterDocId: cursor,
        syncKey: scope.syncKey || null,
        filters: scope.filters || scope,
        eligibilityRuleIds: scope.eligibilityRuleIds || [],
        retryFailures,
        reprocess,
      });
      reachedLimit = remaining.length > 0;
    }
    const result = {
      ok: failed === 0,
      processed,
      failed,
      citations: totalCitations,
      parserVersion: CITATION_PARSER_VERSION,
      cursor: cursor || null,
      batchLimitReached: reachedLimit,
      retryFailures,
      reprocess,
      resolutionQueued: false,
    };
    const continuation = await startCitationScanContinuation(job, result, progress);
    if (continuation?.jobId) result.nextJobId = continuation.jobId;
    if (continuation?.error) result.continuationError = continuation.error;
    clearMetricsCache?.();
    await finishWorkerAdminJob(job, {
      status: failed ? 'failed' : 'completed',
      result,
      error: failed ? `${failed} document(s) failed citation scan.` : null,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Citation scan finished: ${processed} processed, ${failed} failed. Catalogue resolution was not started.`);
    await progress({
      phase: 'citation_scan',
      label: 'Citation scan',
      status: failed ? 'failed' : 'completed',
      counts: { processed, failed, citations: totalCitations, cursor, batchLimitReached: reachedLimit },
    });
    return result;
  }

  if (job.type === 'reparse_committee') {
    await log(job.id, 'Starting committee reparse.');
    await progress({ phase: 'reparse_committee', label: 'Reparsing missing committees', status: 'running' });
    const targetResult = await (await getDb()).execute({
      sql: `
      SELECT fm.doc_id, fm.pdf_path
      FROM file_metrics fm
      WHERE fm.pdf_path IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM committee_members cm WHERE cm.doc_id = fm.doc_id
      )
    `});
    const targets = targetResult.rows;
    let processed = 0;
    let withCommittee = 0;
    for (const row of targets) {
      const doc = await loadDocumentMetadata(row.doc_id);
      if (!doc) continue;
      try {
        await progress({
          phase: 'reparse_committee',
          label: 'Reparsing missing committees',
          detail: row.doc_id,
          status: 'running',
          counts: { processed, total: targets.length, withCommittee },
        });
        const analysis = await analyzePdfEntry(row, artifactClient, {
          progress,
          counts: { processed, total: targets.length, withCommittee },
          label: 'Parsing cached PDF text for committee data',
        });
        if (analysis?.fullText) {
          const before = (await loadCommitteeMembers(row.doc_id)).length;
          await extractAndSaveParsedData(doc, analysis.fullText, null, {
            onProgress: progress,
            extractCommittee: true,
            extractCitations: false,
          });
          const after = (await loadCommitteeMembers(row.doc_id)).length;
          if (after > before) withCommittee += 1;
        }
      } catch (error) {
        await log(job.id, `Committee reparse failed for ${row.doc_id}: ${error?.message || String(error)}`);
      }
      processed += 1;
    }
    const result = { ok: true, processed, withCommittee };
    clearMetricsCache?.();
    await finishWorkerAdminJob(job, {
      status: 'completed',
      result,
      finishedAt: new Date().toISOString(),
    });
    await log(job.id, `Committee reparse finished: ${processed} processed.`);
    await progress({
      phase: 'reparse_committee',
      label: 'Committee reparse',
      status: 'completed',
      counts: { processed, total: targets.length, withCommittee },
    });
    return result;
  }

  throw new Error(`Unsupported import/PDF admin job type: ${job.type}`);
}
