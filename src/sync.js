import {
  DEFAULT_BASE_URL, DEFAULT_INDEX, DEFAULT_QUERY, DEFAULT_SOURCE, DEFAULT_TERM,
  DOCUMENT_SYNC_MAX_RECORDS
} from './config.js';
import { fetchPage, extractHits, resolveIndexName, OC_STABLE_SORT_FIELD } from './api.js';
import {
  createSyncRun, documentExists, documentsExist, getDocumentCacheStats, getLatestSyncRun,
  listDocumentsPendingEnrichment, loadEnrichmentAttempts, loadStoredFileMetric,
  loadStoredFileMetrics, markEnrichmentAttempts, reserveImportRuleRequestSlot,
  saveDocumentMetadata, saveDocumentMetadataBatch, saveFileMetric, updateSyncRun
} from './db.js';
import {
  buildDocumentSyncKey, buildMetricsSourceOptions, ensureSourceFields, normalizeRecord
} from './metrics.js';
import { logger } from './logger.js';
import { analyzeDocumentFile } from './pdf.js';
import { DOCUMENT_SYNC_MODES, filterSyncItemsForMode as filterSyncItemsForModeWithExists } from './syncModes.js';
import {
  DEFAULT_IMPORT_CONTENT_MODE, contentModeEnrichesDocuments
} from './importRules.js';

const runningSyncs = new Map();
export { DOCUMENT_SYNC_MODES };

function publicSource(source) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    requestedIndex = DEFAULT_INDEX,
    query = DEFAULT_QUERY,
    term = DEFAULT_TERM,
    source: sourceFields = DEFAULT_SOURCE,
    pageSize = 100,
    maxRecords = 9999,
    syncMaxRecords = null,
    // #17: raised well above the ~56k corpus size (was 50_000, which the
    // corpus had already outgrown). buildMetricsSourceOptions always supplies
    // a concrete scanLimit today, so this default rarely fires in practice —
    // it is raised anyway so a caller that constructs a source object
    // directly (bypassing buildMetricsSourceOptions) doesn't silently
    // truncate the scan below the corpus size.
    scanLimit = 200_000,
    downloadFiles = true,
  } = source;
  return {
    baseUrl,
    requestedIndex,
    query,
    term,
    source: ensureSourceFields(sourceFields),
    pageSize,
    maxRecords: Number(syncMaxRecords || scanLimit || maxRecords),
    scanLimit,
    downloadFiles: Boolean(downloadFiles),
  };
}

export function getSyncSourceFromOptions(options = {}) {
  const built = buildMetricsSourceOptions(options);
  return publicSource({ ...built, syncMaxRecords: options.syncMaxRecords });
}

export function getSyncKeyForOptions(options = {}) {
  return buildDocumentSyncKey(getSyncSourceFromOptions(options));
}

function sourceUpdatedAt(raw) {
  return raw?.updated_at || raw?.updatedAt || raw?.date_updated || raw?.dateModified || null;
}

// #28: identify the upstream record without carrying any of its content
// fields. Only ever read to build the trimmed provenance stub below — never
// spread the full `raw` object into anything that gets persisted.
function rawSourceId(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return raw._id ?? raw.id ?? raw.identifier ?? raw.Identifier ?? null;
}

// Without an injected existence check the batched form is used: one SELECT per
// page of records rather than one per record (H-05). Callers that inject their own
// existsFn — tests — keep the per-document seam.
export const filterSyncItemsForMode = (items, mode, existsFn = null) =>
  filterSyncItemsForModeWithExists(items, mode, existsFn || documentExists, {
    existsBatchFn: existsFn ? null : documentsExist,
  });

export function hasCachedEnrichmentMetric(stored, contentMode, contentFallback = null) {
  if (contentFallback === 'full_text' && stored?.word_source === 'dspace_full_text') {
    return Number(stored.word_count) > 0 && Number(stored.page_count) > 0;
  }
  if (contentMode === 'pdf_cache') return Boolean(stored?.pdf_path);
  if (contentMode === 'pdf_stream') {
    return (
      stored?.content_source === 'streamed_pdf'
      && Boolean(stored?.content_checksum)
      && Number(stored.word_count) > 0
      && Number(stored.page_count) > 0
    );
  }
  if (contentMode === 'full_text_only') {
    return (
      stored?.word_source === 'dspace_full_text'
      && Number(stored.word_count) > 0
      && Number(stored.page_count) > 0
    );
  }
  return false;
}

function progressDocDetail(doc = {}) {
  return [doc.title, doc.id].filter(Boolean).join(' · ') || 'Untitled document';
}

export function createRequestRateLimiter(requestsPerMinute, {
  windowMs = 60_000,
  now = () => Date.now(),
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  loadTimestamps = async () => [],
  saveTimestamps = async () => {},
  reserveSlot = null,
} = {}) {
  const limit = Math.max(0, Number(requestsPerMinute) || 0);
  const timestamps = [];
  let tail = Promise.resolve();
  let loaded = false;
  return async function acquire() {
    if (!limit) return;
    let release;
    const previous = tail;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      if (reserveSlot) {
        while (true) {
          const waitMs = await reserveSlot(now());
          if (!waitMs) return;
          await wait(waitMs);
        }
      }
      if (!loaded) {
        timestamps.push(...await loadTimestamps());
        timestamps.sort((left, right) => left - right);
        loaded = true;
      }
      while (timestamps.length && timestamps[0] <= now() - windowMs) timestamps.shift();
      if (timestamps.length >= limit) {
        const waitMs = timestamps[0] + windowMs - now();
        if (waitMs > 0) await wait(waitMs);
        while (timestamps.length && timestamps[0] <= now() - windowMs) timestamps.shift();
      }
      timestamps.push(now());
      await saveTimestamps(timestamps);
    } finally {
      release();
    }
  };
}

export async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(items.length, Math.max(1, Number(concurrency) || 1)) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = { value: await callback(items[index], index) };
        } catch (error) {
          results[index] = { error };
        }
      }
    }
  );
  await Promise.all(workers);
  return results;
}

async function runSync(syncKey, source, apiKey, runId, {
  mode = 'import_all',
  importRuleId = '',
  contentMode = DEFAULT_IMPORT_CONTENT_MODE,
  contentFallback = null,
  extractCommittee = true,
  maxContentBytes = 200 * 1024 * 1024,
  contentConcurrency = 1,
  contentRateLimit = 0,
  // #23 gate-harness seam: the limiter's window is fixed at 60s in
  // reserveImportRuleRequestSlot and was never overridable end-to-end. Real
  // contention-spike callers keep the 60_000 default; tests can shrink the
  // window to exercise the wait-and-retry path in well under a second of
  // real wall-clock time instead of waiting out real minutes.
  contentRateWindowMs = 60_000,
  artifactClient = null,
  onProgress = null,
  pdfBatchSize = 0,
  enrichmentDocIds = [],
  enrichmentAttemptedBefore = null,
  enrichmentCursor = '',
} = {}) {
  const startedAt = Date.now();
  let totalSeen = 0;
  // Local retry work is useful operational accounting, but it is not evidence
  // about the upstream corpus. Keep it independent from the OC page budget and
  // completion proof below.
  let localQueueSeen = 0;
  let upstreamUniqueSeen = 0;
  let upstreamScanStarted = false;
  let totalSaved = 0;
  let totalSkipped = 0;
  let totalEnrichmentAttempted = 0;
  let totalEnriched = 0;
  let totalEnrichmentFailed = 0;
  let apiTotal = null;
  let pdfBatchLimitReached = false;
  let upstreamExhausted = false;
  const pdfAttemptedIds = [];
  const enrichmentOutcomes = [];
  // #17: standing overlap/skip safety net for the OC scan (§2.3 Track 1).
  // Doc ids seen so far *within this one scan pass* — a page returning an id
  // already in this set means Open Collections' unstable ordering re-served a
  // record it already returned this pass (a tie-break shift), which is
  // exactly the silent-skip/duplicate failure mode #17 is about. Not
  // persisted beyond one run: at corpus scale (~56k ids as strings) this is a
  // few MB, trivial for a single scan's lifetime.
  const seenDocIdsThisPass = new Set();
  let duplicateDocIdsThisPass = 0;
  // #17 Track 2: whether the OC endpoint accepts/honors a stable sort. Starts
  // 'unknown' and is probed defensively on the first live page — if the
  // request itself is rejected, or accepted but hits never carry back a sort
  // cursor, this degrades gracefully rather than assuming vendor support that
  // has not been verified against the real endpoint (see docs/phase-b-completion-plan.md
  // §1 — oc-index.library.ubc.ca is unreachable from this environment).
  let sortCapability = 'unknown'; // 'unknown' | 'sorted' | 'unsupported'
  let searchAfterCapability = 'unknown'; // 'unknown' | 'supported' | 'unsupported'
  let searchAfterCursor = null;
  const startingHeapBytes = process.memoryUsage().heapUsed;
  let peakHeapBytes = startingHeapBytes;
  const requestCounts = {
    metadata: 0,
    fullText: 0,
    originalPdf: 0,
    retrievedBytes: 0,
  };
  const acquireRuleRequestSlot = createRequestRateLimiter(contentRateLimit, {
    reserveSlot: importRuleId
      ? (nowMs) => reserveImportRuleRequestSlot(importRuleId, contentRateLimit, {
        nowMs, windowMs: contentRateWindowMs,
      })
      : null,
  });
  const countContentRequest = async (event = {}) => {
    if (event.request) await acquireRuleRequestSlot();
    if (event.request && event.source === 'metadata') requestCounts.metadata += 1;
    if (event.request && event.source === 'full_text') requestCounts.fullText += 1;
    if (event.request && event.source === 'original_pdf') requestCounts.originalPdf += 1;
    if (!event.request && Number.isFinite(Number(event.bytes))) {
      requestCounts.retrievedBytes += Math.max(0, Number(event.bytes));
    }
  };
  const requiredEnrichmentIds = new Set(
    (Array.isArray(enrichmentDocIds) ? enrichmentDocIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  );
  const pdfBatchLimit = mode === 'sync_missing_pdfs'
    ? Math.max(0, Number(pdfBatchSize || 0))
    : 0;
  const enrichmentRequested = mode === 'sync_missing_pdfs' && contentModeEnrichesDocuments(contentMode);
  // Documents attempted at or after this instant are treated as already handled by
  // the current batch chain. A continuation job inherits the value the first job in
  // the chain used, so a chain never re-attempts its own work and the job parameters
  // stay one timestamp long instead of growing an id list (H-03).
  const attemptedBefore = String(enrichmentAttemptedBefore || new Date(startedAt).toISOString());
  let queueCursor = String(enrichmentCursor || '');

  // Same rule the enrichment queue applies in SQL, so the upstream scan and the
  // local queue agree on what this batch chain has already taken responsibility for.
  const attemptedInChain = (attemptedAt) => Boolean(
    !requiredEnrichmentIds.size && attemptedAt && String(attemptedAt) >= attemptedBefore
  );

  async function runEnrichmentBatch(missing) {
    if (!missing.length) return;
    await onProgress?.({
      phase: 'pdf_batch',
      label: 'Analyzing missing PDFs',
      status: 'running',
      counts: {
        processed: totalEnrichmentAttempted,
        total: pdfBatchLimit || totalEnrichmentAttempted + missing.length,
      },
    });
    const attemptedBeforePage = totalEnrichmentAttempted;
    // Durable progress is recorded before any content request so a crashed batch
    // does not leave the chain re-reading the same documents forever.
    await markEnrichmentAttempts(missing.map((item) => item.doc.id), new Date().toISOString());
    // #18 cosmetic fix: dispatch order (`index`) is not completion order once
    // contentConcurrency > 1 — a later-dispatched, faster document can finish
    // before an earlier one, making an index-derived "processed" count jump
    // backward/forward in the progress UI. This counter is incremented only at
    // actual completion (success or failure) of each document, immediately
    // before its final progress event, so it is race-free (mapWithConcurrency's
    // workers are cooperatively scheduled — no true parallelism between `await`
    // points) and reflects real completion order.
    let completedInPage = attemptedBeforePage;
    const processingResults = await mapWithConcurrency(missing, contentConcurrency, async (item, index) => {
      const docCounts = {
        processed: attemptedBeforePage + index + 1,
        total: pdfBatchLimit || attemptedBeforePage + missing.length,
      };
      await onProgress?.({
        phase: 'pdf_document',
        label: 'Parsing PDF document data',
        detail: progressDocDetail(item.doc),
        status: 'running',
        counts: docCounts,
      });
      // #18 (N-07): the WHOLE per-document body is one document-scoped unit —
      // the metadata writes that bracket analysis, not just analysis itself.
      // Any error reaching the catch below (a parse failure, or a DB error
      // that survived Layer A's retries in db.js — see classifyDbError/
      // withDbRetry) is recorded against this one document; this worker then
      // resolves normally rather than rejecting, so it can never escape
      // mapWithConcurrency and abort the rest of the page. What legitimately
      // still aborts the run is a page/batch-level call outside this loop
      // (markEnrichmentAttempts above, updateSyncRun in the caller) failing
      // after its own retries are exhausted — that is a run-scoped failure by
      // virtue of where it happened, not what kind of error it is.
      try {
        await saveDocumentMetadata(item.doc, { syncKey, source: item.source });
        pdfAttemptedIds.push(item.doc.id);
        totalEnrichmentAttempted += 1;
        await analyzeDocumentFile(item.doc, {
          contentMode,
          contentFallback,
          maxContentBytes,
          downloadFiles: contentMode === 'pdf_cache' || contentMode === 'pdf_stream',
          forceDownload: false,
          recomputeFromCache: false,
          artifactClient,
          extractCommittee,
          extractCitations: false,
          onContentRequest: countContentRequest,
          onProgress: async (event = {}) => {
            peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
            return onProgress?.({
              ...event,
              detail: event.detail || progressDocDetail(item.doc),
              counts: { ...docCounts, ...(event.counts || {}) },
            });
          },
        });
        await saveDocumentMetadata(item.doc, { syncKey, source: item.source });
        const storedAfterAnalysis = await loadStoredFileMetric(item.doc.id);
        const policySatisfied = hasCachedEnrichmentMetric(storedAfterAnalysis, contentMode, contentFallback);
        if (policySatisfied) totalEnriched += 1;
        else totalEnrichmentFailed += 1;
        peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
        enrichmentOutcomes.push({
          docId: item.doc.id,
          contentMode,
          status: storedAfterAnalysis?.status || null,
          error: storedAfterAnalysis?.error || null,
          contentSource: storedAfterAnalysis?.content_source || null,
          wordSource: storedAfterAnalysis?.word_source || null,
          pageSource: storedAfterAnalysis?.page_source || null,
          wordCount: Number(storedAfterAnalysis?.word_count || 0),
          bodyWordCount: Number(storedAfterAnalysis?.body_word_count || 0),
          pageCount: Number(storedAfterAnalysis?.page_count || 0),
          parserVersion: storedAfterAnalysis?.parser_version || null,
          contentChecksum: storedAfterAnalysis?.content_checksum || null,
        });
        completedInPage += 1;
        await onProgress?.({
          phase: 'pdf_document',
          label: policySatisfied ? 'Parsed document data' : 'Document enrichment did not satisfy policy',
          detail: progressDocDetail(item.doc),
          status: policySatisfied ? 'completed' : 'failed',
          counts: {
            ...docCounts,
            processed: completedInPage,
            pages: item.doc.pages || 0,
            words: item.doc.wordCount || 0,
            enriched: totalEnriched,
            failed: totalEnrichmentFailed,
          },
        });
      } catch (error) {
        peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
        totalEnrichmentFailed += 1;
        // Best-effort durable record of the failure, itself retried by Layer A
        // inside loadStoredFileMetric/saveFileMetric — but its own failure must
        // not escape this catch either; a document we could not even record as
        // failed is still resolved normally, just with `recorded: false`.
        let recorded = false;
        try {
          const storedFailure = await loadStoredFileMetric(item.doc.id);
          if (!storedFailure) {
            await saveFileMetric(item.doc.id, {
              status: 'not_found',
              error: error?.message || String(error),
            });
          }
          recorded = true;
        } catch (recordError) {
          logger.error('Could not durably record enrichment failure', {
            docId: item.doc.id,
            error: recordError?.message || String(recordError),
          });
        }
        // #23: a tagged RATE_LIMIT_STATE_CORRUPT throw (reserveImportRuleRequestSlot's
        // last resort — genuine limiter-state corruption, not ordinary contention,
        // which never throws) is infrastructure noise, not a document-quality
        // signal; evaluateEnrichmentRun excludes it from the success-rate
        // denominator via this outcomeKind rather than counting it as a bad PDF.
        enrichmentOutcomes.push({
          docId: item.doc.id,
          contentMode,
          error: error?.message || String(error),
          outcomeKind: error?.code === 'RATE_LIMIT_STATE_CORRUPT' ? 'infra_error' : 'document_error',
          recorded,
        });
        completedInPage += 1;
        await onProgress?.({
          phase: 'pdf_document',
          label: 'Document enrichment failed',
          detail: progressDocDetail(item.doc),
          status: 'failed',
          counts: {
            ...docCounts,
            processed: completedInPage,
            enriched: totalEnriched,
            failed: totalEnrichmentFailed,
          },
        });
        // Deliberately does not rethrow: this worker resolves normally, so
        // mapWithConcurrency's other in-flight documents are unaffected (#18).
      }
    });
    // Defense-in-depth only, kept deliberately rather than deleted: after the
    // fix above, no per-document error should ever reach here (every one is
    // caught and recorded document-scoped). If this ever fires, it is a
    // genuine unclassified bug, not routine DB flakiness, and should still
    // fail the run loudly rather than be silently swallowed.
    const processingError = processingResults.find((result) => result?.error)?.error;
    if (processingError) throw processingError;
    await onProgress?.({
      phase: 'pdf_batch',
      label: 'Missing PDF batch',
      status: 'completed',
      counts: {
        processed: attemptedBeforePage + missing.length,
        total: pdfBatchLimit || attemptedBeforePage + missing.length,
        enriched: totalEnriched,
        failed: totalEnrichmentFailed,
      },
    });
  }

  // Drains the locally known outstanding documents for this sync key before going
  // anywhere near Open Collections. Returns true when the batch cap was reached, in
  // which case the upstream scan is skipped entirely — the whole point of H-03.
  async function drainLocalEnrichmentQueue(runId) {
    while (true) {
      if (pdfBatchLimit && totalEnrichmentAttempted >= pdfBatchLimit) {
        pdfBatchLimitReached = true;
        return true;
      }
      const pageLimit = Math.max(1, Math.min(
        source.pageSize,
        pdfBatchLimit ? pdfBatchLimit - totalEnrichmentAttempted : source.pageSize
      ));
      const candidates = await listDocumentsPendingEnrichment({
        syncKey,
        contentMode,
        contentFallback,
        attemptedBefore,
        afterDocId: queueCursor,
        limit: pageLimit,
      });
      if (!candidates.length) return false;
      queueCursor = candidates[candidates.length - 1].docId;
      totalSeen += candidates.length;
      localQueueSeen += candidates.length;
      const missing = candidates.map((candidate) => ({
        doc: candidate.metadata && candidate.metadata.id ? candidate.metadata : { id: candidate.docId },
        syncKey,
        source: null,
      }));
      await runEnrichmentBatch(missing);
      totalSaved += missing.length;
      await updateSyncRun(runId, { totalSeen, totalSaved, apiTotal });
      if (candidates.length < pageLimit) return false;
    }
  }

  async function finishSync() {
    // Completion belongs solely to the upstream scan. A local retry batch can
    // fill a worker cap without ever reading OC, and its records must neither
    // spend the upstream budget nor make a corpus scan look complete. When OC
    // supplies a total, only the number of distinct upstream ids can prove it;
    // without a total, an empty page is enough only when no duplicate made
    // pagination ambiguous.
    const authoritativeExhaustion = apiTotal !== null && upstreamUniqueSeen === Number(apiTotal);
    const upstreamCompletionProven = upstreamScanStarted && (
      authoritativeExhaustion
      || (apiTotal === null && upstreamExhausted && duplicateDocIdsThisPass === 0)
    );
    const runStatus = upstreamCompletionProven ? 'completed' : 'incomplete';
    await updateSyncRun(runId, {
      status: runStatus,
      totalSeen,
      localQueueSeen,
      upstreamUniqueSeen,
      totalSaved,
      apiTotal,
      finishedAt: new Date().toISOString(),
    });
    const enrichmentExhausted = mode === 'sync_missing_pdfs' && !pdfBatchLimitReached && upstreamExhausted;
    logger.info('Open Collections sync completed', {
      syncKey,
      mode,
      status: runStatus,
      totalSeen,
      localQueueSeen,
      upstreamUniqueSeen,
      totalSaved,
      totalSkipped,
      pdfBatchSize: pdfBatchLimit || null,
      pdfBatchLimitReached,
      enrichmentExhausted,
      pdfAttempted: pdfAttemptedIds.length,
      totalEnrichmentAttempted,
      totalEnriched,
      totalEnrichmentFailed,
      heapGrowthBytes: Math.max(0, peakHeapBytes - startingHeapBytes),
      requestCounts,
      duplicateDocIdsThisPass,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    });
    return {
      ok: true,
      runStatus,
      totalSeen,
      totalSaved,
      totalSkipped,
      apiTotal,
      pdfBatchLimitReached,
      enrichmentExhausted,
      duplicateDocIdsThisPass,
      pdfAttemptedIds,
      totalEnrichmentAttempted,
      totalEnriched,
      totalEnrichmentFailed,
      enrichmentOutcomes,
      enrichmentAttemptedBefore: attemptedBefore,
      enrichmentCursor: queueCursor,
      heapGrowthBytes: Math.max(0, peakHeapBytes - startingHeapBytes),
      requestCounts,
    };
  }

  try {
    // H-03: enrichment takes its work from the local queue and returns here, without
    // resolving an index or fetching a single Open Collections page. The scan below
    // is reached only when there is nothing outstanding locally - a corpus that has
    // never had its metadata synced, or one the queue has drained - so that the scan
    // can still discover documents the database has not seen yet.
    //
    // The Phase 5 PDF control ships an explicit document allowlist and must keep
    // taking precedence over any database-driven selection, so it skips the queue
    // and stays on the upstream scan path untouched.
    if (enrichmentRequested && !requiredEnrichmentIds.size && await drainLocalEnrichmentQueue(runId)) {
      return await finishSync();
    }

    const index = source.requestedIndex
      ? await resolveIndexName(source.baseUrl, source.requestedIndex, apiKey)
      : null;

    for (let from = 0; from < source.scanLimit; from += source.pageSize) {
      upstreamScanStarted = true;
      await onProgress?.({
        phase: 'oc_scan',
        label: 'Scanning Open Collections records',
        detail: `Records ${from + 1}-${from + source.pageSize}`,
        status: 'running',
        counts: { processed: upstreamUniqueSeen, total: apiTotal ?? source.maxRecords },
      });
      requestCounts.metadata += 1;
      const pageRequest = {
        baseUrl: source.baseUrl,
        index,
        apiKey,
        from,
        pageSize: source.pageSize,
        query: source.query,
        term: source.term,
        source: source.source,
      };
      if (sortCapability !== 'unsupported') pageRequest.sort = OC_STABLE_SORT_FIELD;
      if (searchAfterCapability === 'supported' && searchAfterCursor != null) {
        pageRequest.searchAfter = searchAfterCursor;
      }
      let payload;
      try {
        payload = await fetchPage(pageRequest);
        if (sortCapability === 'unknown') sortCapability = 'sorted';
      } catch (error) {
        // #17 Track 2: defensive capability probe — only the very first page
        // (sortCapability still 'unknown') is allowed to reinterpret a
        // request failure as "this endpoint rejects sort/search_after"; once
        // capability is known, a fetch failure is a real error and must
        // propagate exactly as it always has.
        if (sortCapability === 'unknown' && pageRequest.sort) {
          logger.warn('OC endpoint rejected sort/search_after; falling back to unsorted paging for this run', {
            syncKey, error: error?.message || String(error),
          });
          sortCapability = 'unsupported';
          searchAfterCapability = 'unsupported';
          delete pageRequest.sort;
          delete pageRequest.searchAfter;
          payload = await fetchPage(pageRequest);
        } else {
          throw error;
        }
      }
      const docs = extractHits(payload);
      if (apiTotal === null) apiTotal = payload?.data?.hits?.total ?? null;
      if (!docs.length) {
        upstreamExhausted = true;
        break;
      }

      // #17 Track 1: overlap/skip detector, a standing safety net regardless
      // of whether Track 2's sort/search_after ends up usable — logs (does
      // not fail) when a page returns a doc id already seen this pass, the
      // exact silent-skip/duplicate symptom unstable deep pagination causes.
      const uniqueDocs = [];
      for (const raw of docs) {
        const rawId = String(rawSourceId(raw) || '').trim();
        if (!rawId) {
          // An unidentifiable record cannot contribute to a unique corpus
          // count. Treat it like an unstable page rather than allowing it to
          // make an API total look satisfied.
          duplicateDocIdsThisPass += 1;
          logger.warn('OC scan returned a record without a document id (unsafe paging)', { syncKey, from });
          continue;
        }
        if (seenDocIdsThisPass.has(rawId)) {
          duplicateDocIdsThisPass += 1;
          logger.warn('OC scan returned a doc id already seen this pass (possible unstable paging)', {
            syncKey, docId: rawId, from,
          });
        } else {
          seenDocIdsThisPass.add(rawId);
          uniqueDocs.push(raw);
        }
      }

      // #17 Track 2: only trust search_after once a hit has actually
      // round-tripped a sort cursor value — the endpoint may accept `sort`
      // syntactically without ever honoring or echoing it, which would make
      // search_after silently wrong rather than merely absent. Until/unless
      // confirmed, this stays on sorted `from` paging (still a real stability
      // improvement over no sort at all).
      if (sortCapability === 'sorted' && searchAfterCapability === 'unknown') {
        searchAfterCapability = docs[docs.length - 1]?.__oc_sort !== undefined ? 'supported' : 'unsupported';
      }
      if (searchAfterCapability === 'supported') {
        const lastSort = docs[docs.length - 1]?.__oc_sort;
        if (lastSort !== undefined) searchAfterCursor = lastSort;
      }

      const batch = uniqueDocs.slice(0, Math.max(0, source.maxRecords - upstreamUniqueSeen)).map((raw) => {
        const normalized = normalizeRecord(raw);
        return {
          doc: normalized,
          syncKey,
          // #28: never spread the full upstream OC record here. Only a
          // trimmed provenance stub is kept — documents.source_json is not a
          // full-record cache. The write path (db.js documentColumns) also
          // enforces this as a standing invariant, independent of what this
          // call site passes.
          source: {
            id: rawSourceId(raw),
            sourceUpdatedAt: sourceUpdatedAt(raw),
          },
        };
      });
      totalSeen += batch.length;
      upstreamUniqueSeen += batch.length;
      const filtered = await filterSyncItemsForMode(batch, enrichmentRequested ? mode : 'import_all');
      totalSkipped += filtered.skipped;
      if (enrichmentRequested) {
        // One batched read of the stored metrics and the attempt log for the whole
        // page replaces one loadStoredFileMetric round trip per record (H-05). The
        // control allowlist ignores both, so it does not pay for them at all.
        const pageIds = filtered.items.map((item) => String(item.doc.id));
        const storedByDocId = requiredEnrichmentIds.size
          ? new Map()
          : await loadStoredFileMetrics(pageIds);
        const attemptedByDocId = requiredEnrichmentIds.size
          ? new Map()
          : await loadEnrichmentAttempts(pageIds);
        const missing = [];
        for (const item of filtered.items) {
          const docId = String(item.doc.id);
          if (requiredEnrichmentIds.size && !requiredEnrichmentIds.has(docId)) {
            totalSkipped += 1;
            continue;
          }
          const stored = storedByDocId.get(docId) || null;
          if (!requiredEnrichmentIds.size && hasCachedEnrichmentMetric(stored, contentMode, contentFallback)) {
            totalSkipped += 1;
            continue;
          }
          if (attemptedInChain(attemptedByDocId.get(docId))) {
            totalSkipped += 1;
            continue;
          }
          if (pdfBatchLimit && totalEnrichmentAttempted + missing.length >= pdfBatchLimit) {
            pdfBatchLimitReached = true;
            break;
          }
          missing.push(item);
        }
        await runEnrichmentBatch(missing);
        totalSaved += missing.length;
      } else {
        totalSaved += await saveDocumentMetadataBatch(filtered.items);
      }
      await updateSyncRun(runId, { totalSeen, totalSaved, apiTotal });

      if (apiTotal !== null && upstreamUniqueSeen === Number(apiTotal)) {
        upstreamExhausted = true;
        break;
      }
      if (upstreamUniqueSeen >= source.maxRecords) break;
      if (pdfBatchLimitReached) break;
      if (requiredEnrichmentIds.size && pdfAttemptedIds.length >= requiredEnrichmentIds.size) break;
    }

    return await finishSync();
  } catch (error) {
    await updateSyncRun(runId, {
      status: 'failed',
      totalSeen,
      totalSaved,
      apiTotal,
      error: error?.message || String(error),
      finishedAt: new Date().toISOString(),
    });
    logger.error('Open Collections sync failed', { syncKey, error: error?.message || String(error) });
    return {
      ok: false,
      totalSeen,
      totalSaved,
      totalSkipped,
      apiTotal,
      pdfBatchLimitReached,
      pdfAttemptedIds,
      totalEnrichmentAttempted,
      totalEnriched,
      totalEnrichmentFailed,
      enrichmentOutcomes,
      enrichmentAttemptedBefore: attemptedBefore,
      enrichmentCursor: queueCursor,
      heapGrowthBytes: Math.max(0, peakHeapBytes - startingHeapBytes),
      requestCounts,
      error: error?.message || String(error),
    };
  } finally {
    runningSyncs.delete(syncKey);
  }
}

export async function startDocumentSync(options = {}) {
  const mode = DOCUMENT_SYNC_MODES.has(options.mode) ? options.mode : 'import_all';
  const built = buildMetricsSourceOptions(options);
  const source = publicSource({
    ...built,
    syncMaxRecords: options.syncMaxRecords || DOCUMENT_SYNC_MAX_RECORDS || undefined,
  });
  const syncKey = buildDocumentSyncKey(source);
  if (runningSyncs.has(syncKey)) {
    return { started: false, alreadyRunning: true, syncKey, status: await getDocumentSyncStatus(syncKey) };
  }
  const runId = await createSyncRun(syncKey, source);
  const task = runSync(syncKey, source, built.apiKey, runId, {
    mode,
    importRuleId: options.importRuleId,
    contentMode: options.contentMode || (options.downloadFiles === false ? 'full_text_only' : 'pdf_cache'),
    contentFallback: options.contentFallback,
    extractCommittee: options.extractCommittee !== false,
    maxContentBytes: options.maxContentBytes,
    contentConcurrency: options.contentConcurrency,
    contentRateLimit: options.contentRateLimit,
    contentRateWindowMs: options.contentRateWindowMs,
    artifactClient: options.artifactClient || null,
    onProgress: options.onProgress || null,
    pdfBatchSize: options.pdfBatchSize || 0,
    enrichmentDocIds: options.enrichmentDocIds || [],
    enrichmentAttemptedBefore: options.enrichmentAttemptedBefore || null,
    enrichmentCursor: options.enrichmentCursor || '',
  });
  runningSyncs.set(syncKey, task);
  return { started: true, syncKey, runId, status: await getDocumentSyncStatus(syncKey) };
}

export async function runDocumentSync(options = {}) {
  const mode = DOCUMENT_SYNC_MODES.has(options.mode) ? options.mode : 'import_all';
  const built = buildMetricsSourceOptions(options);
  const source = publicSource({
    ...built,
    syncMaxRecords: options.syncMaxRecords || DOCUMENT_SYNC_MAX_RECORDS || undefined,
  });
  const syncKey = buildDocumentSyncKey(source);
  const runId = await createSyncRun(syncKey, source);
  const summary = await runSync(syncKey, source, built.apiKey, runId, {
    mode,
    importRuleId: options.importRuleId,
    contentMode: options.contentMode || (options.downloadFiles === false ? 'full_text_only' : 'pdf_cache'),
    contentFallback: options.contentFallback,
    extractCommittee: options.extractCommittee !== false,
    maxContentBytes: options.maxContentBytes,
    contentConcurrency: options.contentConcurrency,
    contentRateLimit: options.contentRateLimit,
    contentRateWindowMs: options.contentRateWindowMs,
    artifactClient: options.artifactClient || null,
    onProgress: options.onProgress || null,
    pdfBatchSize: options.pdfBatchSize || 0,
    enrichmentDocIds: options.enrichmentDocIds || [],
    enrichmentAttemptedBefore: options.enrichmentAttemptedBefore || null,
    enrichmentCursor: options.enrichmentCursor || '',
  });
  return { syncKey, runId, mode, ...summary, status: await getDocumentSyncStatus(syncKey) };
}

export async function getDocumentSyncStatus(syncKey = null) {
  const latest = await getLatestSyncRun(syncKey);
  const stats = await getDocumentCacheStats(syncKey);
  const running = syncKey ? runningSyncs.has(syncKey) : runningSyncs.size > 0;
  return {
    running,
    latest,
    cache: stats,
  };
}
